import { describe, it, expect } from 'vitest';
import { changeId, changeSignature, elementSignatureOf, remediationTaskKey, readRemediationTaskValue, isRemediationDone, INSTALL_TASK_ID, TrackingEvaluation, type MarkupFinding } from '../src/record/index.js';
import { buildConsentReportModel, renderChangeListMarkdown, renderCompatibilityHtml, type ChangeItem } from '../src/report/index.js';
import { reconcileCompatibility } from '../src/consent-compatibility.js';
import { compatibilityEvaluation, PAGE } from './fixtures/compatibility-report.js';

// Stable change ids (plans/remediation-flow.md §2): what a change touches,
// never where it was seen. The golden hashes below were computed outside this
// code (sha-256 over the sorted-key JSON of changeSignature()); a change to
// the scheme moves every workspace task key, so it fails here first.

const finding = (over: Partial<MarkupFinding>): MarkupFinding => ({
  partyId: 'google.analytics',
  label: 'Google Analytics 4',
  recognized: true,
  verdict: 'gateable',
  kind: 'script',
  context: 'document',
  page: PAGE,
  line: 12,
  inline: false,
  attributes: {},
  matchedBy: 'host',
  match: 'www.googletagmanager.com',
  locations: ['de'],
  alsoOn: [],
  occurrences: 1,
  ...over,
});

describe('element signatures', () => {
  it('an external tag: host + path + tag ids in the query; scheme, query order and other params do not matter', () => {
    const a = elementSignatureOf(finding({ url: 'https://www.googletagmanager.com/gtag/js?id=G-XXXX01' }));
    const b = elementSignatureOf(finding({ url: 'http://www.googletagmanager.com/gtag/js/?l=dataLayer&id=g-xxxx01' }));
    expect(a).toEqual({ kind: 'script', context: 'document', host: 'www.googletagmanager.com', path: '/gtag/js', ids: ['G-XXXX01'] });
    expect(b).toEqual(a);
  });

  it('an inline snippet: the matched vendor text and the body ids, never the body', () => {
    const s = elementSignatureOf(finding({ inline: true, match: "fbq('init'", ids: ['aw-123456', 'G-ABCDE12'] }));
    expect(s).toEqual({ kind: 'script', context: 'document', ids: ['AW-123456', 'G-ABCDE12'], inline: { match: "fbq('init'" } });
  });

  it('a data: URL tag is an inline signature with the flag; the truncation ellipsis of a long match is dropped', () => {
    const s = elementSignatureOf(finding({ inline: false, url: undefined, dataUrl: { attribute: 'src', mediaType: 'text/javascript', encoding: 'base64' }, match: 'clarity("set"…', matchedBy: 'inline-pattern' }));
    expect(s).toEqual({ kind: 'script', context: 'document', ids: [], inline: { match: 'clarity("set"' }, dataUrl: true });
  });

  it('a <noscript> leak keeps its context', () => {
    expect(elementSignatureOf(finding({ kind: 'img', context: 'noscript', url: 'https://www.facebook.com/tr?id=000000&ev=PageView&noscript=1' }))).toEqual({ kind: 'img', context: 'noscript', host: 'www.facebook.com', path: '/tr', ids: [] });
  });
});

describe('changeId', () => {
  const ext = elementSignatureOf(finding({ url: 'https://www.googletagmanager.com/gtag/js?id=G-XXXX01' }));

  it('golden: the scheme is <kind>:<12 hex of the canonical signature>', () => {
    expect(changeId({ kind: 'rewrite-tag', signature: ext })).toBe('rewrite-tag:863bf2b9c0d7');
    expect(changeId({ kind: 'rewrite-tag', signature: { kind: 'script', context: 'document', ids: [], inline: { match: "fbq('init'" } } })).toBe('rewrite-tag:84162593eac5');
    expect(changeId({ kind: 'gate-gtm-tag', containerId: 'GTM-XXXX01', tagId: 7, partyId: 'tiktok.pixel' })).toBe('gate-gtm-tag:5eaf0ccbb7eb');
    expect(changeId({ kind: 'needs-a-look', partyId: 'unknown:tracker.test' })).toBe('needs-a-look:6c0f3aab7bb9');
    expect(changeId({ kind: 'install' })).toBe(INSTALL_TASK_ID);
  });

  it('is independent of the line, the page and the party for element-scoped changes', () => {
    const moved = elementSignatureOf(finding({ url: 'https://www.googletagmanager.com/gtag/js?id=G-XXXX01', line: 90, page: `${PAGE}cart`, partyId: 'google.ads.ccm' }));
    expect(changeId({ kind: 'rewrite-tag', signature: moved })).toBe(changeId({ kind: 'rewrite-tag', signature: ext }));
    expect(changeSignature({ kind: 'rewrite-tag', signature: ext })).not.toHaveProperty('partyId');
  });

  it('differs by kind, by tag id, by element, and falls back to party + URL when no element was located', () => {
    expect(changeId({ kind: 'remove-leak', signature: ext })).not.toBe(changeId({ kind: 'rewrite-tag', signature: ext }));
    expect(changeId({ kind: 'gate-gtm-tag', containerId: 'GTM-XXXX01', tagId: 8 })).not.toBe(changeId({ kind: 'gate-gtm-tag', containerId: 'GTM-XXXX01', tagId: 7 }));
    expect(changeId({ kind: 'rewrite-tag', partyId: 'x', url: 'https://a.test/x.js?v=1' })).toBe(changeId({ kind: 'rewrite-tag', partyId: 'x', url: 'https://a.test/x.js?v=2' }));
    expect(changeId({ kind: 'rewrite-tag', partyId: 'x', url: 'https://a.test/x.js' })).not.toBe(changeId({ kind: 'rewrite-tag', partyId: 'y', url: 'https://a.test/x.js' }));
  });

  it('party-scoped kinds: platform and the Google consent default are shared items; the api, the manager and the DNS host scope the rest', () => {
    expect(changeId({ kind: 'use-platform-api', platform: 'shopify', partyId: 'a' })).toBe(changeId({ kind: 'use-platform-api', platform: 'shopify', partyId: 'b' }));
    expect(changeId({ kind: 'set-consent-default', api: 'google', partyId: 'a' })).toBe(changeId({ kind: 'set-consent-default', partyId: 'b' }));
    expect(changeId({ kind: 'set-consent-default', api: 'fbq', partyId: 'a' })).not.toBe(changeId({ kind: 'set-consent-default', api: 'fbq', partyId: 'b' }));
    expect(changeId({ kind: 'change-dns', host: 'Stats.Example-Shop.test' })).toBe(changeId({ kind: 'change-dns', host: 'stats.example-shop.test' }));
    expect(changeId({ kind: 'call-consent-api', partyId: 'a', api: 'x' })).not.toBe(changeId({ kind: 'call-consent-api', partyId: 'a', api: 'y' }));
  });

  it('the workspace key is task:change:<id>', () => {
    expect(remediationTaskKey('rewrite-tag:863bf2b9c0d7')).toBe('task:change:rewrite-tag:863bf2b9c0d7');
  });
});

describe('task values in the workspace', () => {
  it('reads the remediation vocabulary and maps the report workbench’s (done → done-unverified, never verified)', () => {
    expect(readRemediationTaskValue({ status: 'verified', lastVerify: { at: '2026-10-07T00:00:00Z', result: 'pass', message: 'ok', evidence: [] } })?.status).toBe('verified');
    expect(readRemediationTaskValue({ status: 'done', note: '', answers: {} })?.status).toBe('done-unverified');
    expect(readRemediationTaskValue({ status: 'open' })?.status).toBe('todo');
    expect(readRemediationTaskValue({ status: 'in-progress' })?.status).toBe('todo');
    expect(readRemediationTaskValue({ status: 'nonsense' })).toBeUndefined();
    expect(readRemediationTaskValue(null)).toBeUndefined();
  });
  it('done = verified or done-unverified; failed and cannot-verify are not done', () => {
    expect(isRemediationDone('verified')).toBe(true);
    expect(isRemediationDone('done-unverified')).toBe(true);
    expect(isRemediationDone('failed')).toBe(false);
    expect(isRemediationDone('cannot-verify')).toBe(false);
    expect(isRemediationDone('todo')).toBe(false);
  });
});

describe('the change list carries the ids (B2)', () => {
  const model = (ev: TrackingEvaluation) => {
    ev.compatibility = reconcileCompatibility(ev);
    return buildConsentReportModel(ev, []);
  };
  const items = (m: ReturnType<typeof model>): ChangeItem[] => [...(m.compatibility?.groups.flatMap((g) => g.items) ?? []), ...(m.compatibility?.otherChanges ?? [])];

  it('every item has an id; rewrite and leak items carry the element signature', () => {
    const all = items(model(compatibilityEvaluation()));
    expect(all.length).toBeGreaterThan(3);
    for (const it of all) expect(it.id).toMatch(new RegExp(`^${it.kind}:[0-9a-f]{12}$`));
    const rewrite = all.find((it) => it.kind === 'rewrite-tag' && it.partyIds.includes('google.analytics'))!;
    expect(rewrite.signature).toEqual({ kind: 'script', context: 'document', host: 'www.googletagmanager.com', path: '/gtag/js', ids: ['G-XXXX01'] });
    expect(rewrite.id).toBe('rewrite-tag:863bf2b9c0d7');
    const leak = all.find((it) => it.kind === 'remove-leak')!;
    expect(leak.signature).toEqual({ kind: 'img', context: 'noscript', host: 'www.facebook.com', path: '/tr', ids: [] });
    const gtm = all.find((it) => it.kind === 'gate-gtm-tag')!;
    expect(gtm.id).toBe('gate-gtm-tag:5eaf0ccbb7eb');
    expect(new Set(all.map((it) => it.id)).size).toBe(all.length);
  });

  it('the ids survive the owner’s edits: the same tags at other lines on a second scan give the same ids', () => {
    const before = items(model(compatibilityEvaluation())).map((it) => it.id).sort();
    const ev = compatibilityEvaluation();
    for (const f of ev.markup!.findings) f.line += 37;
    for (const p of ev.inventory) for (const e of p.implementation?.evidence ?? []) if (e.line) e.line += 37;
    const after = items(model(ev)).map((it) => it.id).sort();
    expect(after).toEqual(before);
  });

  it('the markdown change list anchors each item by id; the HTML item carries data-change-id', () => {
    const m = model(compatibilityEvaluation());
    const md = renderChangeListMarkdown(m);
    const html = renderCompatibilityHtml(m.compatibility);
    for (const it of items(m)) {
      if (m.compatibility!.groups.some((g) => g.items.includes(it))) {
        expect(md).toContain(`<a id="change-${it.id}"></a>`);
        expect(md).toContain(`- Change id: \`${it.id}\``);
      }
      expect(html).toContain(`data-change-id="${it.id}"`);
      expect(html).toContain(`id="change-${it.id}"`);
    }
  });
});
