import { describe, it, expect } from 'vitest';
import { reconcileCompatibility, matrixBehaviorCells } from '../src/consent-compatibility.js';
import { buildConsentReportModel, renderConsentHtml, renderConsentMarkdown, renderChangeListMarkdown, containsBannedVocabulary, rewriteSnippet, buildCompatibilityReport } from '../src/report/index.js';
import { evaluateCompatibility } from '../src/rules/tracking/index.js';
import { compatibilityEvaluation, PAGE } from './fixtures/compatibility-report.js';

// B2: the compatibility section, the owner's change list and the "outside your
// consent tool's reach" line. Fixture only (test/fixtures/compatibility-report.ts).

function model() {
  const e = compatibilityEvaluation();
  e.compatibility = reconcileCompatibility(e);
  return buildConsentReportModel(e, []);
}

/** "gated" only where B1 proved it ("not gated" is a statement of fact, not a claim). */
const UNPROVEN_GATED = /(?<!not )\bgated\b/i;

describe('compatibility report model (JSON)', () => {
  const m = model();
  const r = m.compatibility!;

  it('one row per tool that needs a decision; necessary/CDN tools only in the not-counted line', () => {
    expect(r.rows.map((x) => x.partyId).sort()).toEqual(['google.ads.ccm', 'google.analytics', 'meta.pixel', 'tiktok.pixel', 'unknown:tracker.test']);
    expect(r.notRequired.map((x) => x.partyId)).toEqual(['cloudflare']);
    expect(JSON.stringify(r.groups)).not.toContain('cloudflare');
  });

  it('the reach line counts uncontrollable, unknown and unproven tag-manager tools — exactly', () => {
    expect(r.reach.line).toBe("3 tools are loaded outside your consent tool's reach: Meta Pixel, tracker.test, TikTok Pixel.");
    expect(r.reach.tools.map((t) => t.verdict)).toEqual(['uncontrollable', 'unknown', 'tag-manager']);
    // gateable and platform are not counted
    expect(r.reach.tools.some((t) => t.partyId === 'google.analytics' || t.partyId === 'google.ads.ccm')).toBe(false);
    expect(r.scope).toMatch(/1 page with its HTML inspected, 1 verified location \(Germany\), logged out/);
  });

  it('behavior mismatch first: in the rows and as the first change group', () => {
    expect(r.rows[0]).toMatchObject({ partyId: 'meta.pixel', behavior: 'mismatch' });
    expect(r.rows[0].behaviorNote).toMatch(/Germany · After rejection/);
    expect(r.groups[0].id).toBe('mismatch');
    expect(r.groups.map((g) => g.id)).toEqual(['mismatch', 'rewrite', 'gtm', 'consent-default', 'platform', 'consent-api', 'leaks', 'exposures', 'needs-a-look']);
  });

  it('"nothing observed where it should be off" only from cells that expected it off; never "verified"', () => {
    const ga = r.rows.find((x) => x.partyId === 'google.analytics')!;
    expect(ga.behavior).toBe('no-mismatch-observed');
    expect(ga.behaviorNote).toMatch(/where it should be off, in 1 compared visit \(Germany · After rejection\)/);
    expect(JSON.stringify(r)).not.toMatch(/verified (it|that|the tool)/i);
  });

  it('rewrite items carry page:line and a before/after consistent with the client gate', () => {
    const rw = r.groups.find((g) => g.id === 'rewrite')!.items;
    const ga = rw.find((i) => i.partyIds.includes('google.analytics'))!;
    expect(ga).toMatchObject({ page: PAGE, line: 12, category: 'analytics' });
    expect(ga.before).toBe('<script async src="https://www.googletagmanager.com/gtag/js?id=G-XXXX01"></script>');
    expect(ga.after).toBe('<script type="text/plain" data-category="analytics" data-src="https://www.googletagmanager.com/gtag/js?id=G-XXXX01" async></script>');
    const inline = rw.find((i) => i.partyIds.includes('meta.pixel'))!;
    expect(inline.after).toMatch(/^<script type="text\/plain" data-category="advertising">/);
  });

  it('GTM items name the container, the tag id and the consent setting; link the setup guide', () => {
    const g = r.groups.find((x) => x.id === 'gtm')!.items[0];
    expect(g).toMatchObject({ containerId: 'GTM-XXXX01', tagId: 7, consentTypes: ['ad_storage', 'ad_user_data', 'ad_personalization'] });
    expect(g.guide!.href).toBe('https://jeffjassky.github.io/complykit/guide/gtm-setup');
    expect(g.tagNote).toMatch(/no consent requirement/);
  });

  it('platform rows carry the server-side caveat and link the platform guide', () => {
    const p = r.rows.find((x) => x.partyId === 'google.ads.ccm')!;
    expect(p.verdict).toBe('platform');
    expect(p.caveats?.join(' ')).toMatch(/server-side/);
    expect(r.groups.find((x) => x.id === 'platform')!.items[0].guide!.href).toBe('https://jeffjassky.github.io/complykit/guide/platform-shopify');
  });

  it('unclassified tools say what they wait on: the decision, named', () => {
    const u = r.rows.find((x) => x.partyId === 'unknown:tracker.test')!;
    expect(u.purpose).toBe('unclassified');
    expect(u.whatToChange).toMatch(/^Waiting on your decision: what is tracker\.test\? Then, if it tracks visitors: /);
    expect(r.groups.find((x) => x.id === 'needs-a-look')!.items[0].classifyFirst).toBe(true);
  });

  it('the consent tool default finding is surfaced; not observed is never "nothing granted"', () => {
    expect(r.consentTool.status).toBe('not-observed');
    expect(r.consentTool.headline).toMatch(/not established/);
  });

  it('the matrix wins: a mismatch it shows is presented even when the record’s own verdict has none', () => {
    const e = compatibilityEvaluation();
    e.compatibility = evaluateCompatibility({ ...e, behaviorObservations: undefined }); // B1 without behavior
    expect(e.compatibility.parties.find((p) => p.partyId === 'meta.pixel')!.behaviorMismatch).toBe(false);
    const mm = buildConsentReportModel(e, []).compatibility!;
    expect(mm.rows[0]).toMatchObject({ partyId: 'meta.pixel', behavior: 'mismatch' });
    expect(mm.groups[0].id).toBe('mismatch');
  });

  it('the reconciled verdict agrees with the report matrix', () => {
    const e = compatibilityEvaluation();
    const cells = matrixBehaviorCells(e);
    expect(cells.find((c) => c.partyId === 'meta.pixel' && c.scenario === 'reject')!.status).toBe('mismatch');
    expect(reconcileCompatibility(e).parties.find((p) => p.partyId === 'meta.pixel')!.behaviorMismatch).toBe(true);
  });

  it('a record without verdicts renders a plain "not evaluated", never a pass', () => {
    const e = compatibilityEvaluation();
    const mm = buildConsentReportModel(e, []);
    expect(mm.compatibility).toBeUndefined();
    expect(renderChangeListMarkdown(mm)).toMatch(/no compatibility verdicts/);
    expect(renderConsentHtml(mm)).toMatch(/no compatibility verdicts/);
  });

  it('zero tools outside reach still carries the scope', () => {
    const e = compatibilityEvaluation();
    e.compatibility = { ...reconcileCompatibility(e), parties: [] };
    const z = buildCompatibilityReport(e.compatibility, { inventory: e.inventory, markup: e.markup, locations: [{ id: 'de', label: 'Germany', verdict: 'verified' }] });
    expect(z.reach.line).toBe("0 tools are loaded outside your consent tool's reach.");
    expect(z.scope).toMatch(/Pages not visited can load other tools/);
  });
});

describe('rendered wording', () => {
  const m = model();
  const outputs = { html: renderConsentHtml(m), md: renderConsentMarkdown(m), changes: renderChangeListMarkdown(m) };

  it('never "compliant", never an unproven "gated"', () => {
    for (const [name, text] of Object.entries(outputs)) {
      expect(containsBannedVocabulary(text), name).toBe(false);
      const section = name === 'html' ? text.slice(text.indexOf('id="compatibility"'), text.indexOf('id="rule-actions"')) : text;
      expect(UNPROVEN_GATED.test(section.replace(/<details class="human-details"><summary>Why[\s\S]*?<\/details>/g, '')), name).toBe(false);
    }
  });

  it('the HTML section links the downloadable change list', () => {
    expect(outputs.html).toContain('href="change-list.md" download');
    expect(renderConsentHtml(m, { changeList: false })).not.toContain('change-list.md" download');
  });

  it('the change list markdown (snapshot)', () => {
    expect(outputs.changes).toMatchSnapshot();
  });
});

describe('rewriteSnippet', () => {
  it('keeps attributes, drops src/type, escapes quotes', () => {
    expect(rewriteSnippet({ attributes: { type: 'text/javascript', id: 'a"b', src: '//x.test/a.js', defer: '' }, inline: false, match: '' }, undefined, 'analytics')).toEqual({
      before: '<script type="text/javascript" id="a&quot;b" src="//x.test/a.js" defer></script>',
      after: '<script type="text/plain" data-category="analytics" data-src="//x.test/a.js" id="a&quot;b" defer></script>',
    });
  });
});
