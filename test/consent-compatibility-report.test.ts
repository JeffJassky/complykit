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
    expect(r.reach.line).toBe("3 tools are loaded outside your consent tool's reach: Meta Pixel, TikTok Pixel, tracker.test.");
    expect(r.reach.tools.map((t) => t.verdict)).toEqual(['uncontrollable', 'tag-manager', 'unknown']);
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

  it('every tool with a change was observed running where it should be off: the list is fixes, nothing else', () => {
    const listed = new Set([...r.groups.flatMap((g) => g.items), ...r.otherChanges].flatMap((i) => i.partyIds));
    for (const id of listed) {
      const row = r.rows.find((x) => x.partyId === id)!;
      expect(row.behavior === 'mismatch' || row.behavior === 'not-established', `${id}: ${row.behavior}`).toBe(true);
    }
    expect(JSON.stringify(r)).not.toMatch(/verified (it|that|the tool)/i);
  });

  describe('held everywhere the grid compared: nothing to fix (behavior is the ground truth both ways)', () => {
    // Google Analytics quiet in every visit: off before a choice and after rejection, on only where it may run.
    const held = () => {
      const e = compatibilityEvaluation({ held: ['google.analytics'] });
      e.compatibility = reconcileCompatibility(e);
      return buildConsentReportModel(e, []).compatibility!;
    };
    const h = held();
    const ga = h.rows.find((x) => x.partyId === 'google.analytics')!;

    it('"nothing observed where it should be off" only from cells that expected it off; every visit compared; never "verified"', () => {
      expect(ga.behavior).toBe('no-mismatch-observed');
      expect(ga.heldEverywhere).toBe(true);
      expect(ga.behaviorNote).toMatch(/in every compared visit \(2: Germany · Before a choice, Germany · After rejection\); no visit unchecked/);
      expect(JSON.stringify(h)).not.toMatch(/verified (it|that|the tool)/i);
    });

    it('its implementation changes are not listed, it is not counted as outside reach, and the row says so — the verdict stays as the explanation', () => {
      expect(ga.changes).toEqual([]);
      expect(ga.whatToChange).toBe('Nothing to change: off where the rules expect it off, in every visit the grid compared');
      expect(ga.outsideReach).toBe(false);
      expect(ga.verdict).toBe('gateable');
      expect(ga.reasons[0]).toMatchObject({ source: 'behavior' });
      expect(ga.reasons[0].note).toMatch(/no change listed; the notes below describe how it loads, not something to fix/);
      const items = [...h.groups.flatMap((g) => g.items), ...h.otherChanges];
      expect(items.some((i) => i.partyIds.includes('google.analytics'))).toBe(false);
      expect(h.groups.find((g) => g.id === 'rewrite')!.items.map((i) => i.tools)).toEqual([['Meta Pixel']]);
      // The reach line lost nothing: a gateable tool was never counted.
      expect(h.reach.line).toBe(r.reach.line);
      // The fixture's broken-site version lists it: same tool, a visit where it ran before a choice.
      expect(r.rows.find((x) => x.partyId === 'google.analytics')).toMatchObject({ behavior: 'mismatch', heldEverywhere: false });
      expect(r.groups.find((g) => g.id === 'rewrite')!.items.some((i) => i.partyIds.includes('google.analytics'))).toBe(true);
    });

    it('a tag-manager tool held everywhere: no GTM tag to gate, no Google default to set, not counted', () => {
      const e = compatibilityEvaluation({ held: ['tiktok.pixel'] });
      e.compatibility = reconcileCompatibility(e);
      const t = buildConsentReportModel(e, []).compatibility!;
      const row = t.rows.find((x) => x.partyId === 'tiktok.pixel')!;
      expect(row).toMatchObject({ heldEverywhere: true, outsideReach: false, changes: [] });
      expect(t.groups.map((g) => g.id)).not.toContain('gtm');
      expect(t.groups.map((g) => g.id)).not.toContain('consent-default');
      expect(t.reach.line).toBe("2 tools are loaded outside your consent tool's reach: Meta Pixel, tracker.test.");
    });

    it('a markup leak keeps its change even when the tool was held everywhere: the scan runs with JavaScript on, the <noscript> pixel fires without it', () => {
      const e = compatibilityEvaluation({ held: ['meta.pixel'] });
      e.compatibility = reconcileCompatibility(e);
      const t = buildConsentReportModel(e, []).compatibility!;
      const meta = t.rows.find((x) => x.partyId === 'meta.pixel')!;
      expect(meta.heldEverywhere).toBe(true);
      expect(meta.changes.map((c) => c.kind)).toEqual(['remove-leak']);
      expect(meta.outsideReach).toBe(true);
      expect(meta.reasons[0].note).toMatch(/only its markup leak is listed/);
      expect(t.groups.find((g) => g.id === 'rewrite')?.items.some((i) => i.partyIds.includes('meta.pixel')) ?? false).toBe(false);
      expect(t.groups.find((g) => g.id === 'leaks')!.items.map((i) => i.tools)).toEqual([['Meta Pixel']]);
      expect(t.groups.find((g) => g.id === 'exposures')!.items.map((i) => i.tools)).toEqual([['Meta Pixel']]);
      expect(t.groups.find((g) => g.id === 'mismatch')!.items.some((i) => i.partyIds.includes('meta.pixel'))).toBe(false);
    });

    it('fail closed: a visit the grid could not compare keeps the changes (nothing was proven about it)', () => {
      const e = compatibilityEvaluation({ held: ['google.analytics'] });
      // The do-nothing visit's per-item observations are missing: its cell is "unknown", not compared.
      e.behaviorObservations![0].durationMs = 0;
      e.compatibility = reconcileCompatibility(e);
      const t = buildConsentReportModel(e, []).compatibility!;
      const row = t.rows.find((x) => x.partyId === 'google.analytics')!;
      expect(row.behavior).toBe('no-mismatch-observed');
      expect(row.heldEverywhere).toBe(false);
      expect(row.behaviorNote).toMatch(/in 1 compared visit \(Germany · After rejection\).*1 visit not compared/);
      expect(row.changes.map((c) => c.kind)).toContain('rewrite-tag');
      expect(t.groups.find((g) => g.id === 'rewrite')!.items.some((i) => i.partyIds.includes('google.analytics'))).toBe(true);
    });

    it('a visitor action never run at a location is not an unchecked visit there (the owner grid has no such column); one that ran and failed is', () => {
      // A second location where only the do-nothing visit ran: the matrix still has reject and accept columns for it.
      const second = (reject?: { status: 'not-tested'; reason: string; cause: 'choice-failed' }) => {
        const e = compatibilityEvaluation({ held: ['google.analytics'] });
        const de = e.locations[0];
        e.locations.push({
          ...de,
          spec: { ...de.spec, id: 'uk', label: 'United Kingdom', country: 'GB' },
          verification: { ...de.verification, expected: { country: 'GB' }, observed: { country: 'GB' }, jurisdictions: ['uk'] },
          scenarios: [{ scenario: 'do-nothing', status: 'tested', evidence: { screenshots: [] } }, ...(reject ? [{ scenario: 'reject' as const, ...reject, evidence: { screenshots: [] } }] : [])],
        });
        e.behaviorObservations!.push({ ...e.behaviorObservations![0], location: 'uk' });
        e.compatibility = reconcileCompatibility(e);
        return buildConsentReportModel(e, []).compatibility!.rows.find((x) => x.partyId === 'google.analytics')!;
      };
      const neverRun = second();
      expect(neverRun.heldEverywhere).toBe(true);
      expect(neverRun.behaviorNote).toMatch(/every compared visit \(3: /);
      const failed = second({ status: 'not-tested', reason: 'the reject control could not be clicked', cause: 'choice-failed' });
      expect(failed.heldEverywhere).toBe(false);
      expect(failed.behaviorNote).toMatch(/1 visit not compared/);
      expect(failed.changes.map((c) => c.kind)).toContain('rewrite-tag');
    });

    it('a tag manager is judged by what it loads: nothing to fix once every consent-needing tool was held everywhere; its changes stay while any was not', () => {
      const withGtag = (held: string[], dropUnclassified = false) => {
        const e = compatibilityEvaluation({ held });
        if (dropUnclassified) e.inventory = e.inventory.filter((p) => p.partyId !== 'unknown:tracker.test');
        e.inventory.push({
          ...e.inventory[1],
          partyId: 'google.tag-manager',
          label: 'Google Tag Manager / gtag.js',
          domain: 'googletagmanager.com',
          hosts: ['www.googletagmanager.com'],
          recognized: true,
          categories: ['tag-manager'],
          implementation: { class: 'direct-script', evidence: [{ class: 'direct-script', kind: 'source', observed: true, note: 'a <script> in the page', page: PAGE, line: 12 }], alsoSeen: [] },
        });
        for (const o of e.behaviorObservations!) o.knownPartyIds.push('google.tag-manager');
        e.compatibility = reconcileCompatibility(e);
        return buildConsentReportModel(e, []).compatibility!;
      };
      // Everything it could load held: the loader has nothing to fix either, and is not counted.
      const all = withGtag(['meta.pixel', 'google.analytics', 'tiktok.pixel', 'google.ads.ccm'], true);
      const gtm = all.rows.find((x) => x.partyId === 'google.tag-manager')!;
      expect(gtm.behavior).toBe('only-may-run');
      expect(gtm).toMatchObject({ heldEverywhere: true, outsideReach: false, changes: [] });
      expect(gtm.whatToChange).toBe('Nothing to change: every tool it could load was off where the rules expect it off, in every visit the grid compared');
      expect(gtm.reasons[0].note).toMatch(/^A tag manager is judged by what it loads/);
      // An unclassified tool cannot be compared (fail closed): with tracker.test still undecided the loader keeps its changes,
      // and so it does while any tool it could load ran where it should be off.
      for (const some of [withGtag(['meta.pixel', 'google.analytics', 'tiktok.pixel', 'google.ads.ccm']), withGtag(['meta.pixel', 'tiktok.pixel', 'google.ads.ccm'], true)]) {
        const g2 = some.rows.find((x) => x.partyId === 'google.tag-manager')!;
        expect(g2.behavior).toBe('only-may-run');
        expect(g2.heldEverywhere).toBe(false);
        expect(g2.changes.length).toBeGreaterThan(0);
      }
    });

    it('a column skipped as not applicable is not an unchecked visit', () => {
      const e = compatibilityEvaluation({ held: ['google.analytics'] });
      e.locations[0].scenarios.push({ scenario: 'dismiss', status: 'not-applicable', reason: 'the banner has no close control', cause: 'no-close', evidence: { screenshots: [] } });
      e.compatibility = reconcileCompatibility(e);
      const t = buildConsentReportModel(e, []).compatibility!;
      expect(t.rows.find((x) => x.partyId === 'google.analytics')!.heldEverywhere).toBe(true);
    });
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
