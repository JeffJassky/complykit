import { describe, it, expect } from 'vitest';
import { TrackingEvaluation, Timeline } from '../src/record/index.js';
import { DEFAULT_KB, lookupEntry } from '../src/registry/index.js';
import { tracking } from '../src/rules/index.js';
import { buildConsentReportModel } from '../src/report/consent-model.js';
import { buildBehaviorMatrix } from '../src/report/consent-matrix.js';
import { diffConsentModels, diffIsEmpty, renderSinceHtml, renderSinceMarkdown, carriedTasks } from '../src/report/consent-diff.js';
import { renderConsentHtml } from '../src/report/consent-html.js';
import { workspaceId } from '../src/report/workspace.js';
import { applyWorkspace, classificationCategories, classificationKey, doneTasks, parseWorkspaceSnapshot, resolveSiteClassifications, siteKnowledgeBase, workspaceSubjects } from '../src/site-workspace.js';

// C3: the site workspace applied to a scan (KB overrides from classifications,
// done tasks carried), and the run-to-run diff. Fixtures only.

const site = { url: 'https://shop.example/', host: 'shop.example', registrableDomain: 'shop.example' };
const verification = { verdict: 'verified', expected: { country: 'DE' }, observed: { country: 'DE' }, sources: [], jurisdictions: ['eu'], checkedAt: 'now' };
const spec = { id: 'de', label: 'Germany', country: 'DE' };

/** A browse visit: an unknown widget (px.widget.test) and Meta's pixel each set a cookie before any choice. */
const timeline = Timeline.parse({
  location: spec,
  verification,
  snapshot: { site, scenario: 'browse', locationId: 'de', startedAt: '2026-10-05T00:00:00Z', durationMs: 10000, gpc: false, browser: { name: 'chromium' }, pages: [], cookies: [], storage: [], frames: [] },
  events: [
    { type: 'banner', t: 0, state: 'shown', pageIndex: 0 },
    { type: 'request', t: 50, id: 'q1', url: 'https://px.widget.test/p?id=abc', method: 'GET', resourceType: 'image', origin: 'page', pageUrl: site.url, initiator: { type: 'script', chain: ['https://px.widget.test/w.js'] }, frameUrl: site.url, pageIndex: 0 },
    { type: 'cookie-write', t: 100, name: '_uw', value: 'redacted-value', chain: ['https://px.widget.test/w.js'], frameUrl: site.url, pageIndex: 0 },
    { type: 'cookie-write', t: 120, name: '_fbp', value: 'redacted-value', chain: ['https://connect.facebook.net/pixel.js'], frameUrl: site.url, pageIndex: 0 },
  ],
});

const toolKey = 'class:' + workspaceId('tool', ['unknown:widget.test', 'widget.test']);
const cookieKey = 'class:' + workspaceId('storage', ['unknown:widget.test', 'widget.test', 'cookie', '_uw']);

describe('site workspace → scan', () => {
  it('keys subjects exactly like the report workbench (class: + data-class-key)', () => {
    const subjects = workspaceSubjects([timeline], DEFAULT_KB);
    expect(subjects.map(classificationKey)).toEqual(expect.arrayContaining([toolKey, cookieKey]));
    expect(subjects.find((s) => s.kind === 'tool' && s.partyId === 'unknown:widget.test')).toMatchObject({ recognized: false });
  });

  it('reads the workbench value shape; suggestions, cleared values and "other" are not applied', () => {
    expect(classificationCategories({ category: 'analytics', additionalCategories: ['advertising'], categoryChosen: true })).toEqual(['analytics', 'advertising']);
    expect(classificationCategories({ category: 'performance' })).toEqual(['error-monitoring']);
    expect(classificationCategories({ categories: ['chat'] })).toEqual(['chat']);
    expect(classificationCategories({ category: 'analytics', categoryChosen: false })).toBeUndefined();
    expect(classificationCategories({ category: 'other' })).toBeUndefined();
    expect(classificationCategories(null)).toBeUndefined();
  });

  it('applies a tool classification as a KB override: the unknown party keeps its id and is recognized with the team’s categories', () => {
    const ws = parseWorkspaceSnapshot({ entries: { [toolKey]: { value: { category: 'advertising' }, at: '2026-10-05T12:00:00Z', by: 'Dana' } } });
    const { kb, record } = applyWorkspace([timeline], DEFAULT_KB, ws, '2026-10-06T00:00:00Z');
    expect(record.classifications).toEqual([{ key: toolKey, kind: 'tool', partyId: 'unknown:widget.test', domain: 'widget.test', categories: ['advertising'], at: '2026-10-05T12:00:00Z', by: 'Dana' }]);
    expect(kb.version).toBe(`${DEFAULT_KB.version}+site.1`);
    // Last: never shadows a shared entry.
    expect(kb.entries.at(-1)?.id).toBe('unknown:widget.test');
    expect(lookupEntry(DEFAULT_KB, 'px.widget.test')).toBeUndefined();
    const a = tracking.analyzeTimeline(timeline, kb);
    const widget = a.parties.get('unknown:widget.test')!;
    expect(widget).toMatchObject({ recognized: true, categories: ['advertising'] });
    // Same identity → same workspace keys on the next run.
    expect(workspaceSubjects([timeline], kb).map(classificationKey)).toEqual(expect.arrayContaining([toolKey, cookieKey]));
  });

  it('overrides a recognized vendor’s categories for this run only', () => {
    const subjects = workspaceSubjects([timeline], DEFAULT_KB);
    const meta = subjects.find((s) => s.kind === 'tool' && s.partyId === 'meta.pixel');
    expect(meta).toBeDefined();
    const key = classificationKey(meta!);
    const classes = resolveSiteClassifications(subjects, { entries: { [key]: { value: { category: 'functional' } }, 'class:not-observed': { value: { category: 'analytics' } } } });
    const kb = siteKnowledgeBase(DEFAULT_KB, classes);
    expect(kb.entries.find((e) => e.id === 'meta.pixel')?.categories).toEqual(['functional']);
    expect(DEFAULT_KB.entries.find((e) => e.id === 'meta.pixel')?.categories).not.toEqual(['functional']);
  });

  it('collects done tasks (task: keys with status done)', () => {
    expect(doneTasks({ entries: { 'task:a': { value: { status: 'done' }, by: 'Dana' }, 'task:b': { value: { status: 'in-progress' } }, 'task:c': { value: null }, 'class:x': { value: { status: 'done' } } } })).toEqual([{ key: 'a', by: 'Dana' }]);
  });

  it('rejects a file that is not a workspace', () => {
    expect(() => parseWorkspaceSnapshot({ runs: [] })).toThrow(/entries/);
    expect(() => parseWorkspaceSnapshot({ entries: { k: 'x' } })).toThrow(/value/);
  });
});

// --- diff -----------------------------------------------------------------------

function evaluation(runId: string, startedAt: string, extra: Partial<TrackingEvaluation> = {}): TrackingEvaluation {
  const tl = { ...timeline, snapshot: { ...timeline.snapshot, startedAt } };
  const ev = tracking.buildTrackingEvaluation({
    runId,
    property: 'shop',
    site,
    versions: { kb: '0', registry: '0', package: '0' },
    startedAt,
    finishedAt: startedAt,
    locations: [{ spec, verification, scenarios: [{ scenario: 'browse', status: 'tested', evidence: { screenshots: [] } }] }] as never,
    timelines: [tl],
    notTested: [],
    redacted: true,
  });
  return TrackingEvaluation.parse({ ...ev, ...extra });
}

describe('run-to-run diff', () => {
  const base = buildConsentReportModel(evaluation('r1', '2026-10-01T09:00:00Z'), []);

  it('is empty for the same run', () => {
    expect(diffIsEmpty(diffConsentModels(base, base))).toBe(true);
  });

  it('lists a classified cookie and the checks it flipped', () => {
    const ev = evaluation('r2', '2026-10-06T09:00:00Z');
    ev.siteWorkspace = { appliedAt: 'now', classifications: [{ key: cookieKey, kind: 'storage', partyId: 'unknown:widget.test', domain: 'widget.test', storageKind: 'cookie', name: '_uw', categories: ['advertising'] }], doneTasks: [] };
    const head = buildConsentReportModel(ev, []);
    const row = head.behaviorMatrix!.rows.find((r) => r.kind === 'storage' && r.label === '_uw')!;
    expect(row).toMatchObject({ categories: ['advertising'], categorySource: 'your team’s site classification' });
    const d = diffConsentModels(base, head);
    expect(d.classified).toEqual([expect.objectContaining({ row: '_uw', from: [], to: ['advertising'] })]);
    expect(d.cells.some((c) => c.row === '_uw' && c.from === 'review' && c.to === 'mismatch')).toBe(true);
    expect(d.parties.added).toEqual([]);
    expect(renderSinceMarkdown(d)).toMatch(/^## Since 2026-10-01 09:00 UTC/);
    expect(renderSinceMarkdown(d)).toContain('_uw: unclassified → advertising');
  });

  it('lists parties added, removed and recategorized, and verdict changes', () => {
    const headEv = evaluation('r2', '2026-10-06T09:00:00Z');
    headEv.inventory = headEv.inventory.filter((p) => p.partyId !== 'meta.pixel').map((p) => (p.partyId === 'unknown:widget.test' ? { ...p, recognized: true, categories: ['advertising'] } : p));
    headEv.inventory.push({ ...headEv.inventory[0], partyId: 'unknown:new.test', label: 'new.test', domain: 'new.test' });
    headEv.locations = headEv.locations.map((l) => ({ ...l, verification: { ...l.verification, verdict: 'mismatch' } }));
    const d = diffConsentModels(base, buildConsentReportModel(headEv, []));
    expect(d.parties.added.map((p) => p.partyId)).toEqual(['unknown:new.test']);
    expect(d.parties.removed.map((p) => p.partyId)).toEqual(['meta.pixel']);
    expect(d.parties.recategorized).toEqual([expect.objectContaining({ partyId: 'unknown:widget.test', from: ['unknown'], categories: ['advertising'] })]);
    expect(d.verdicts).toEqual(expect.arrayContaining([{ location: 'de', label: 'Germany', from: 'verified', to: 'mismatch' }]));
    const html = renderSinceHtml(d);
    expect(html).toContain('Since 2026-10-01 09:00 UTC');
    expect(html).toContain('not proof it was removed');
    expect(html).not.toMatch(/\bcompliant\b/i);
  });

  it('renders "Since" and carried-forward done tasks in the consent report', () => {
    const ev = evaluation('r2', '2026-10-06T09:00:00Z');
    const pre = buildConsentReportModel(ev, []);
    const html0 = renderConsentHtml(pre);
    const key = /data-action-key="([^"]+)"/.exec(html0)![1];
    ev.siteWorkspace = { appliedAt: 'now', classifications: [], doneTasks: [{ key, by: 'Dana', at: '2026-10-04T00:00:00Z' }, { key: 'action-gone', by: 'Dana' }] };
    const head = buildConsentReportModel(ev, []);
    head.since = diffConsentModels(base, head);
    const html = renderConsentHtml(head);
    expect(html).toContain('id="since-last-run"');
    expect(html).toContain('Tasks your team marked done');
    expect(html).toMatch(/Still flagged by this scan \(1\)/);
    expect(html).toMatch(/No longer in this report \(1\)/);
    expect(carriedTasks(head.siteWorkspace!.doneTasks, html0).find((t) => t.key === key)?.title).toBeTruthy();
  });

  it('a matrix built without a workspace is unchanged', () => {
    expect(buildBehaviorMatrix(base).rows.find((r) => r.label === '_uw')?.categorySource).toBe('not classified (unidentified tool)');
  });
});

