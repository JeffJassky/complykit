import { describe, it, expect } from 'vitest';
import { generateConsentConfig } from '../src/consent-generator.js';
import { buildRemediationTasks, installTask, remediationTotals, renderHeadSnippet, removeExistingToolTasks } from '../src/remediation.js';
import { CONSENT_CONFIG_ELEMENT_ID, RemediationTask as RemediationTaskSchema, remediationTaskKey, type RemediationTask, type TrackingEvaluation } from '../src/record/index.js';
import { classificationKey, type WorkspaceSnapshot } from '../src/site-workspace.js';
import { containsBannedVocabulary } from '../src/report/index.js';
import { compatibilityEvaluation, PAGE } from './fixtures/compatibility-report.js';

// The guided checklist (plans/remediation-flow.md §3): built from the
// generator output over the B2 fixture (one tool per verdict, generic hosts).

const NOW = '2026-10-06T12:00:00.000Z';
const gen = (ev: TrackingEvaluation = compatibilityEvaluation(), workspace?: WorkspaceSnapshot) => generateConsentConfig(ev, { complykitVersion: '0.0.0-test', now: NOW, workspace });
const byKind = (tasks: RemediationTask[], kind: RemediationTask['kind']): RemediationTask[] => tasks.filter((t) => t.kind === kind);

describe('buildRemediationTasks', () => {
  const r = gen();
  const tasks = r.tasks;

  it('the generator output carries the tasks, and they equal a standalone build; every task validates against the schema', () => {
    const again = buildRemediationTasks(r, compatibilityEvaluation());
    expect(again).toEqual(tasks);
    for (const t of tasks) expect(RemediationTaskSchema.safeParse(t).success).toBe(true);
    expect(new Set(tasks.map((t) => t.id)).size).toBe(tasks.length);
    expect(tasks.map((t) => t.order)).toEqual(tasks.map((_, i) => i));
  });

  it('install is first, verified by the latest config hash, blocking and above GTM; its snippet is Part 1 of snippet.html', () => {
    const t = tasks[0];
    expect(t.id).toBe('install');
    expect(t.kind).toBe('install');
    expect(t.status).toBe('todo');
    expect(t.verify).toEqual({ check: 'install', method: 'static', page: PAGE, configHash: r.config.hash, scriptSrc: r.scriptSrc, elementId: CONSENT_CONFIG_ELEMENT_ID });
    expect(t.snippet?.after).toBe(renderHeadSnippet(r.config, r.scriptSrc));
    expect(r.snippet).toContain(t.snippet!.after);
    expect(t.steps.join(' ')).toMatch(/first in <head>/);
    expect(t.steps.join(' ')).toMatch(/no async, no defer/);
    expect(t.steps.join(' ')).toMatch(/above the Google Tag Manager snippet/);
    expect(t.steps.join(' ')).toMatch(/Not a third-party CDN/);
  });

  it('every change item is a task or folded into one (its id kept as an alias); pages and ids carried over', () => {
    const items = [...r.compatibility.groups.flatMap((g) => g.items), ...r.compatibility.otherChanges];
    const known = new Set(tasks.flatMap((t) => [t.id, ...(t.aliases ?? [])]));
    for (const it of items) expect(known, it.id).toContain(it.id);
    // Folded: the behavior mismatch, the consent-API calls (the tool has adapters), the exposure the leak removes.
    expect(byKind(tasks, 'behavior-mismatch')).toHaveLength(0);
    expect(byKind(tasks, 'call-consent-api')).toHaveLength(0);
    expect(byKind(tasks, 'accepted-exposure')).toHaveLength(0);
    const rewrite = byKind(tasks, 'rewrite-tag').find((t) => t.partyIds.includes('google.analytics'))!;
    expect(rewrite.pages).toEqual([PAGE, `${PAGE}cart`]);
    expect(rewrite.steps[0]).toContain('1 other page');
    expect(rewrite.group).toBe('rewrite');
    for (const t of tasks) expect(remediationTaskKey(t.id)).toBe(`task:change:${t.id}`);
  });

  it('folds: the mismatch into every task that fixes the tool, the consent-API calls into install, the exposure into the leak — each with a “this also fixes” line; no browser confirm when a static check covers the tool', () => {
    const mismatch = r.compatibility.groups.find((g) => g.id === 'mismatch')!.items[0];
    const meta = tasks.filter((t) => t.aliases?.includes(mismatch.id));
    expect(meta.map((t) => t.kind).sort()).toEqual(['remove-leak', 'rewrite-tag']);
    for (const t of meta) expect(t.alsoFixes).toContain('Meta Pixel running before the visitor chooses (seen in the scan).');
    const calls = r.compatibility.groups.find((g) => g.id === 'consent-api')!.items.map((i) => i.id);
    expect(tasks[0].aliases).toEqual(calls);
    expect(tasks[0].alsoFixes!.join(' ')).toMatch(/Telling Google Analytics 4 the visitor’s choice/);
    const exposure = r.compatibility.groups.find((g) => g.id === 'exposures')!.items[0].id;
    expect(byKind(tasks, 'remove-leak')[0].aliases).toContain(exposure);
    expect(byKind(tasks, 'confirm-in-browser')).toHaveLength(0);
  });

  it('order: install, tags, leaks, GTM, platform, consent defaults, then the rest; titles short and imperative', () => {
    expect(tasks.map((t) => t.kind)).toEqual(['install', 'rewrite-tag', 'rewrite-tag', 'remove-leak', 'gate-gtm-tag', 'use-platform-api', 'set-consent-default', 'needs-a-look']);
    // Tags by page in document order: line 12 (Google Analytics) before line 38 (Meta Pixel).
    expect(byKind(tasks, 'rewrite-tag').map((t) => t.title)).toEqual(['Hold the Google Analytics 4 tag until consent', 'Hold the Meta Pixel tag until consent']);
    expect(byKind(tasks, 'remove-leak')[0].title).toBe('Delete the Meta Pixel no-JavaScript fallback');
    expect(byKind(tasks, 'gate-gtm-tag')[0].title).toBe('Require consent for the TikTok Pixel tag in Google Tag Manager');
    for (const t of tasks) {
      expect(t.title).not.toMatch(/rewrite-tag|remove-leak|gate-gtm|behavior-mismatch|call-consent-api|:\d+\b/);
      expect(t.title.length).toBeLessThan(80);
    }
  });

  it('verify methods per kind: static for markup and container changes, browser for platform / API / behavior, manual where nothing can be read', () => {
    const rewrite = byKind(tasks, 'rewrite-tag').find((t) => t.partyIds.includes('google.analytics'))!;
    expect(rewrite.verify).toEqual({ check: 'rewrite-tag', method: 'static', page: PAGE, element: { kind: 'script', context: 'document', host: 'www.googletagmanager.com', path: '/gtag/js', ids: ['G-XXXX01'] }, category: 'analytics' });
    expect(rewrite.snippet?.before).toContain('<script async src=');
    expect(rewrite.snippet?.after).toContain('type="text/plain" data-category="analytics" data-src=');

    const leak = byKind(tasks, 'remove-leak')[0];
    expect(leak.verify).toEqual({ check: 'remove-leak', method: 'static', page: PAGE, element: { kind: 'img', context: 'noscript', host: 'www.facebook.com', path: '/tr', ids: [] } });

    const gtm = byKind(tasks, 'gate-gtm-tag')[0];
    expect(gtm.verify).toEqual({ check: 'gtm-tag-consent', method: 'static', containerId: 'GTM-XXXX01', containerUrl: 'https://www.googletagmanager.com/gtm.js?id=GTM-XXXX01', tagId: 7, consentTypes: gtm.verify.check === 'gtm-tag-consent' ? gtm.verify.consentTypes : [] });
    expect(gtm.verify.check === 'gtm-tag-consent' && gtm.verify.consentTypes.length).toBeGreaterThan(0);
    expect(gtm.steps.join(' ')).toContain('Require additional consent for tag to fire');

    const platform = byKind(tasks, 'use-platform-api')[0];
    expect(platform.verify).toEqual({ check: 'spot-check', method: 'browser', page: PAGE, partyId: 'google.ads.ccm', hosts: ['google.test'], scenario: 'reject-then-accept' });
    expect(platform.title).toContain('Shopify');

    const look = byKind(tasks, 'needs-a-look')[0];
    expect(look.verify.method).toBe('manual');
    for (const t of byKind(tasks, 'set-consent-default')) expect(t.verify.check).toBe('consent-default');
  });

  it('every step is plain language: numbered by position, no empty step, no banned vocabulary, no page:line in a title that the verify spec does not also carry by signature', () => {
    for (const t of tasks) {
      expect(t.steps.length).toBeGreaterThan(0);
      for (const s of t.steps) expect(s.trim().length).toBeGreaterThan(10);
      expect(containsBannedVocabulary(`${t.title} ${t.summary} ${t.steps.join(' ')} ${t.notes.join(' ')}`)).toBe(false);
      expect(t.title).not.toMatch(/compliant/i);
    }
  });

  it('status and the last verify result come from the workspace under task:change:<id>; the workbench’s done is done-unverified', () => {
    const rewriteId = byKind(tasks, 'rewrite-tag')[0].id;
    const gtmId = byKind(tasks, 'gate-gtm-tag')[0].id;
    const ws: WorkspaceSnapshot = {
      domain: 'example-shop.test',
      entries: {
        [remediationTaskKey('install')]: { value: { status: 'verified', lastVerify: { at: NOW, result: 'pass', message: 'config present and current', evidence: ['config hash abc'] } }, at: NOW, by: 'Ann' },
        [remediationTaskKey(rewriteId)]: { value: { status: 'failed', lastVerify: { at: NOW, result: 'fail', message: 'still executes', evidence: ['line 12'] } }, at: NOW },
        [remediationTaskKey(gtmId)]: { value: { status: 'done', note: 'published', answers: {} }, at: NOW },
      },
      runs: [],
    };
    const t = buildRemediationTasks(r, compatibilityEvaluation(), { workspace: ws });
    expect(t[0].status).toBe('verified');
    expect(t[0].lastVerify?.message).toBe('config present and current');
    expect(t.find((x) => x.id === rewriteId)?.status).toBe('failed');
    expect(t.find((x) => x.id === gtmId)?.status).toBe('done-unverified');
    expect(t.filter((x) => ![rewriteId, gtmId, 'install'].includes(x.id)).every((x) => x.status === 'todo')).toBe(true);
    const totals = remediationTotals(t);
    expect(totals).toMatchObject({ total: t.length, verified: 1, failed: 1, doneUnverified: 1, cannotVerify: 0 });
    expect(totals.todo).toBe(t.length - 3);
    // The generator stamps the same statuses when given the workspace.
    expect(gen(compatibilityEvaluation(), ws).tasks.map((x) => x.status)).toEqual(t.map((x) => x.status));
  });

  it('ids survive a regeneration: same scan later → same ids; a classification of one tool leaves the other tasks’ ids (and so their statuses) alone', () => {
    const later = generateConsentConfig(compatibilityEvaluation(), { complykitVersion: '0.0.0-test', now: '2026-10-08T09:00:00.000Z' });
    expect(later.tasks.map((t) => t.id)).toEqual(tasks.map((t) => t.id));
    expect(later.config.hash).not.toBe(r.config.hash); // the config moved (generatedFrom.at) …
    expect(later.tasks[0].id).toBe('install'); // … the install task's id is constant; its verify spec carries the new hash
    // Classify the unknown-vendor tool: its own tasks may change; every other task keeps its id.
    const ev = compatibilityEvaluation();
    const p = ev.inventory.find((x) => x.partyId === 'cloudflare')!;
    const ws: WorkspaceSnapshot = { domain: 'example-shop.test', entries: { [`class:${classificationKey({ kind: 'tool', partyId: p.partyId, domain: p.domain, recognized: p.recognized })}`]: { value: { category: 'analytics', categoryChosen: true }, at: NOW } }, runs: [] };
    const after = gen(ev, ws).tasks;
    const untouched = (ts: RemediationTask[]) => ts.filter((t) => !t.partyIds.includes('cloudflare')).map((t) => t.id);
    expect(untouched(after)).toEqual(untouched(tasks));
  });

  it('a stored config.value without the compatibility section is enough: the report is rebuilt from the evaluation', () => {
    const t = buildRemediationTasks({ config: r.config, notes: r.notes, snippet: r.snippet }, compatibilityEvaluation());
    expect(t.map((x) => x.id)).toEqual(tasks.map((x) => x.id));
    expect(t[0].verify.check === 'install' && t[0].verify.scriptSrc).toBe(r.scriptSrc);
  });

  it('context-purpose tools come last, marked optional', () => {
    const ev = compatibilityEvaluation();
    ev.inventory.push({
      ...ev.inventory[1],
      partyId: 'unknown:chat.test',
      label: 'chat.test',
      domain: 'chat.test',
      hosts: ['chat.test'],
      recognized: true,
      categories: ['chat'],
      implementation: { class: 'direct-script', evidence: [{ class: 'direct-script', kind: 'source', observed: true, note: 'a <script> in the page', url: 'https://chat.test/w.js', page: PAGE, line: 70 }], alsoSeen: [] },
    });
    ev.markup!.findings.push({ partyId: 'unknown:chat.test', label: 'chat.test', recognized: true, verdict: 'gateable', trigger: 'page-load', kind: 'script', context: 'document', page: PAGE, line: 70, url: 'https://chat.test/w.js', inline: false, attributes: { src: 'https://chat.test/w.js' }, matchedBy: 'host', match: 'chat.test', locations: ['de'], alsoOn: [], occurrences: 1 });
    const t = gen(ev).tasks;
    const optional = t.filter((x) => x.optional);
    expect(optional.length).toBeGreaterThan(0);
    expect(optional.every((x) => x.group === 'other')).toBe(true);
    expect(t.indexOf(optional[0])).toBeGreaterThan(t.findIndex((x) => x.kind === 'needs-a-look'));
    expect(remediationTotals(t).required).toBe(t.length - optional.length);
  });
});

describe('remove the existing consent tool', () => {
  it('an outside consent tool (a party with the consent category) gets a static task over its hosts, placed right after install', () => {
    const ev = compatibilityEvaluation();
    ev.inventory.push({ ...ev.inventory[1], partyId: 'unknown:cmp.test', label: 'cmp.test', domain: 'cmp.test', hosts: ['cdn.cmp.test', 'cmp.test'], recognized: true, categories: ['consent'], implementation: { class: 'direct-script', evidence: [], alsoSeen: [] } });
    const r = gen(ev);
    expect(r.notes.some((n) => n.code === 'existing-consent-tool' && n.partyIds?.includes('unknown:cmp.test'))).toBe(true);
    const t = r.tasks[1];
    expect(t.kind).toBe('remove-existing-tool');
    expect(t.id).toMatch(/^remove-existing-tool:[0-9a-f]{12}$/);
    expect(t.verify).toEqual({ check: 'remove-existing-tool', method: 'static', page: PAGE, partyId: 'unknown:cmp.test', hosts: ['cdn.cmp.test', 'cmp.test'], label: 'cmp.test' });
    expect(t.steps.join(' ')).toMatch(/never without a banner/);
  });

  it('a platform consent plugin gets a task verified by its asset-path fingerprint', () => {
    const ev = compatibilityEvaluation();
    ev.platform = { name: 'wordpress', evidence: ['wp-content'], consentPlugin: 'complianz' };
    const tasks = removeExistingToolTasks(ev, [{ code: 'existing-consent-tool', message: 'plugin seen' }], PAGE);
    expect(tasks).toHaveLength(1);
    expect(tasks[0].title).toContain('complianz');
    expect(tasks[0].verify.check).toBe('remove-existing-tool');
    expect(tasks[0].verify.check === 'remove-existing-tool' && tasks[0].verify.pathPattern).toMatch(/complianz/);
    expect(tasks[0].steps[0]).toContain('Wordpress');
  });

  it('the generator flags a WordPress plugin and the task appears in its output', () => {
    const ev = compatibilityEvaluation();
    ev.platform = { name: 'wordpress', evidence: ['wp-content'], consentPlugin: 'cookieyes' };
    const r = gen(ev);
    expect(r.tasks[1].kind).toBe('remove-existing-tool');
    expect(r.tasks[1].tools).toEqual(['cookieyes']);
  });

  it('installTask alone: the folder is derived from the script src', () => {
    const r = gen();
    const t = installTask(r.config, 'https://www.example-shop.test/assets/ck/complykit-consent.js', PAGE);
    expect(t.steps[0]).toContain('https://www.example-shop.test/assets/ck/');
    // One task, two surfaces: the first step names the service's button or the CLI's folder, never both.
    const v = t.stepVariants!.find((x) => x.step === 0)!;
    expect(v.service).toContain('Download install bundle (.zip)');
    expect(v.service).not.toContain('consent-config');
    expect(v.offline).toContain('complykit consent-config <run-dir>');
    expect(v.offline).not.toContain('Download install bundle');
    for (const text of [t.steps[0], v.service, v.offline]) expect(text).toContain('https://www.example-shop.test/assets/ck/');
    expect(t.steps[0]).not.toMatch(/Download install bundle|consent-config/);
    expect(t.snippet?.after).toContain('src="https://www.example-shop.test/assets/ck/complykit-consent.js"');
  });
});

describe('folding, the browser confirm and titles (hand-made change lists over the B2 fixture)', () => {
  const r = gen();
  const ev = compatibilityEvaluation();
  const group = (id: string) => r.compatibility.groups.find((g) => g.id === id)!;
  const mismatch = group('mismatch').items[0]; // Meta Pixel, ran where it should be off
  const build = (groups: Array<{ id: string; items: typeof mismatch[] }>, config = r.config, workspace?: WorkspaceSnapshot) =>
    buildRemediationTasks({ config, notes: [], compatibility: { ...r.compatibility, groups: groups.map((g) => ({ ...group(g.id), items: g.items })), otherChanges: [] } }, ev, { workspace });

  it('a mismatch no other task fixes is never folded away: it stays first after install, with its own browser check', () => {
    const t = build([{ id: 'mismatch', items: [mismatch] }, { id: 'rewrite', items: group('rewrite').items.filter((i) => !i.partyIds.includes('meta.pixel')) }]);
    expect(t[1].id).toBe(mismatch.id);
    expect(t[1].title).toBe('Find out why Meta Pixel runs before consent');
    expect(t[1].verify).toMatchObject({ check: 'spot-check', partyId: 'meta.pixel', hosts: ['meta.test'] });
    expect(t.some((x) => x.alsoFixes?.length)).toBe(false);
  });

  it('a mismatch only a manual task addresses is folded into it, and one “Confirm in the browser” task near the end keeps the spot check', () => {
    const look = { ...group('needs-a-look').items[0], id: 'needs-a-look:aaaaaaaaaaaa', partyIds: ['meta.pixel'], tools: ['Meta Pixel'], classifyFirst: undefined };
    const t = build([{ id: 'mismatch', items: [mismatch] }, { id: 'needs-a-look', items: [look] }]);
    expect(t.map((x) => x.kind)).toEqual(['install', 'needs-a-look', 'confirm-in-browser']);
    expect(t[1].aliases).toEqual([mismatch.id]);
    const confirm = t[2];
    expect(confirm.title).toBe('Confirm in the browser: Meta Pixel waits for consent');
    expect(confirm.id).toMatch(/^confirm-in-browser:[0-9a-f]{12}$/);
    expect(confirm.aliases).toEqual([mismatch.id]);
    expect(confirm.verify).toMatchObject({ check: 'spot-check', method: 'browser', partyId: 'meta.pixel' });
    expect(RemediationTaskSchema.safeParse(confirm).success).toBe(true);
  });

  it('a platform task that spot-checks the same tool covers it: no extra confirm', () => {
    const platform = { ...group('platform').items[0], id: 'use-platform-api:bbbbbbbbbbbb', partyIds: ['meta.pixel'], tools: ['Meta Pixel'] };
    const t = build([{ id: 'mismatch', items: [mismatch] }, { id: 'platform', items: [platform] }]);
    expect(t.map((x) => x.kind)).toEqual(['install', 'use-platform-api']);
    expect(t[1].aliases).toEqual([mismatch.id]);
  });

  it('a consent-API call stays its own task when the config has no adapter for the vendor', () => {
    const calls = group('consent-api').items;
    const config = { ...r.config, vendors: r.config.vendors.map((v) => (v.id === 'google.analytics' ? { ...v, adapter: undefined, control: 'none' as const } : v)) };
    const t = build([{ id: 'consent-api', items: calls }], config);
    expect(t.map((x) => x.kind)).toEqual(['install', 'call-consent-api']);
    expect(t[1].partyIds).toEqual(['google.analytics']);
    expect(t[1].title).toBe('Pass the visitor’s choice to Google Analytics 4');
    expect(t[0].aliases).toEqual(calls.filter((c) => !c.partyIds.includes('google.analytics')).map((c) => c.id));
  });

  it('a status stored under a folded id is found through the aliases: own entry first; a carried pass is “marked done” on a static task, kept on the browser confirm', () => {
    const look = { ...group('needs-a-look').items[0], id: 'needs-a-look:aaaaaaaaaaaa', partyIds: ['meta.pixel'], tools: ['Meta Pixel'], classifyFirst: undefined };
    const rewrite = group('rewrite').items.find((i) => i.partyIds.includes('meta.pixel'))!;
    const lv = { at: NOW, result: 'pass' as const, message: 'held after reject', evidence: [] };
    const ws: WorkspaceSnapshot = { domain: 'example-shop.test', entries: { [remediationTaskKey(mismatch.id)]: { value: { status: 'verified', lastVerify: lv }, at: NOW } }, runs: [] };
    const withRewrite = build([{ id: 'mismatch', items: [mismatch] }, { id: 'rewrite', items: [rewrite] }], r.config, ws);
    const rw = withRewrite.find((x) => x.id === rewrite.id)!;
    expect(rw.status).toBe('done-unverified');
    expect(rw.lastVerify?.message).toBe('held after reject');
    const withLook = build([{ id: 'mismatch', items: [mismatch] }, { id: 'needs-a-look', items: [look] }], r.config, ws);
    expect(withLook.find((x) => x.kind === 'confirm-in-browser')!.status).toBe('verified');
    const own: WorkspaceSnapshot = { ...ws, entries: { ...ws.entries, [remediationTaskKey(rewrite.id)]: { value: { status: 'failed' }, at: NOW } } };
    expect(build([{ id: 'mismatch', items: [mismatch] }, { id: 'rewrite', items: [rewrite] }], r.config, own).find((x) => x.id === rewrite.id)!.status).toBe('failed');
  });

  it('the Consent Mode default: nothing to paste when the tool sets it (gtm section or adapter), the paste steps otherwise; the same verify either way', () => {
    const items = group('consent-default').items;
    const covered = build([{ id: 'consent-default', items }])[1];
    expect(covered.summary).toBe('Nothing to paste — the complykit tool sets this; verify after installing.');
    expect(covered.steps[0]).toMatch(/^Nothing to paste — the complykit tool sets this/);
    expect(covered.steps.join(' ')).not.toMatch(/\bpaste the snippet\b/i);
    expect(covered.snippet).toBeUndefined();
    const bare = { ...r.config, gtm: undefined, vendors: r.config.vendors.map((v) => (v.adapter === 'google-consent-mode' ? { ...v, adapter: undefined, control: 'none' as const } : v)) };
    const paste = build([{ id: 'consent-default', items }], bare)[1];
    expect(paste.steps[0]).toMatch(/^Paste the snippet below in <head>, above the Google Tag Manager/);
    expect(paste.snippet?.after).toContain("gtag('consent', 'default'");
    expect(paste.verify).toEqual(covered.verify);
  });

  it('tags are grouped by page in document order; the same title twice says where', () => {
    const meta = group('rewrite').items.find((i) => i.partyIds.includes('meta.pixel'))!;
    const sig = meta.signature!;
    const cart = { ...meta, id: 'rewrite-tag:cccccccccccc', page: `${PAGE}cart`, line: 5, signature: { ...sig, path: '/other.js' } };
    const early = { ...meta, id: 'rewrite-tag:dddddddddddd', line: 3, signature: { ...sig, path: '/early.js' } };
    const t = build([{ id: 'rewrite', items: [cart, meta, early] }]);
    expect(t.slice(1).map((x) => x.title)).toEqual([
      'Hold the Meta Pixel tag until consent (on the home page, line 3)',
      'Hold the Meta Pixel tag until consent (on the home page, line 38)',
      'Hold the Meta Pixel tag until consent (on /cart)',
    ]);
  });
});
