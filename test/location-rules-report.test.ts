import { describe, it, expect } from 'vitest';
import { TrackingEvaluation } from '../src/record/index.js';
import { buildConsentReportModel, renderConsentHtml, renderConsentMarkdown, containsBannedVocabulary } from '../src/report/index.js';

// PR C contract (plans/location-rules-plan.md): the consent report states, per
// location, where the browser was and which model of rules the scan compared it
// against, with a disclosure ("popover") that explains the model and cites the
// law. The model part is green in the contract commit; the renderers are PR C.

const evaluation = TrackingEvaluation.parse({
  runId: 'r-loc',
  property: 'shop',
  site: { url: 'https://shop.example/', host: 'shop.example', registrableDomain: 'shop.example' },
  versions: { kb: '0.1.0', registry: '0.2.0', package: '0.0.0' },
  startedAt: '2026-10-08T10:00:00Z',
  finishedAt: '2026-10-08T10:20:00Z',
  locations: [
    { spec: { id: 'de', label: 'Germany', country: 'DE', proxied: true }, verification: { verdict: 'verified', expected: { country: 'DE' }, observed: { country: 'DE' }, sources: [], jurisdictions: ['eu', 'eu-de'], checkedAt: 'x' }, scenarios: [{ scenario: 'do-nothing', status: 'tested' }] },
    { spec: { id: 'us-ca', label: 'California, US', country: 'US', region: 'CA', proxied: true }, verification: { verdict: 'verified', expected: { country: 'US', region: 'CA' }, observed: { country: 'US', region: 'CA' }, sources: [], jurisdictions: ['us', 'us-ca'], checkedAt: 'x' }, scenarios: [{ scenario: 'do-nothing', status: 'tested' }] },
    { spec: { id: 'us-tx', label: 'Texas, US', country: 'US', region: 'TX', proxied: true }, verification: { verdict: 'verified', expected: { country: 'US', region: 'TX' }, observed: { country: 'US', region: 'TX' }, sources: [], jurisdictions: ['us', 'us-tx'], checkedAt: 'x' }, scenarios: [{ scenario: 'do-nothing', status: 'tested' }] },
    { spec: { id: 'us-fl', label: 'Florida, US', country: 'US', region: 'FL', proxied: true }, verification: { verdict: 'verified', expected: { country: 'US', region: 'FL' }, observed: { country: 'US', region: 'FL' }, sources: [], jurisdictions: ['us', 'us-fl'], checkedAt: 'x' }, scenarios: [{ scenario: 'do-nothing', status: 'tested' }] },
    { spec: { id: 'br', label: 'Brazil', country: 'BR', proxied: true }, verification: { verdict: 'verified', expected: { country: 'BR' }, observed: { country: 'BR' }, sources: [], jurisdictions: ['br'], checkedAt: 'x' }, scenarios: [{ scenario: 'do-nothing', status: 'tested' }] },
    { spec: { id: 'fr', label: 'France', country: 'FR', proxied: true }, verification: { verdict: 'mismatch', expected: { country: 'FR' }, observed: { country: 'BE' }, sources: [], jurisdictions: [], checkedAt: 'x', note: 'exit is in BE' }, scenarios: [] },
  ],
  inventory: [],
  notTested: [{ scope: 'location', id: 'fr', reason: 'location mismatch' }],
  researchQueue: [],
  redacted: true,
});

const model = buildConsentReportModel(evaluation, []);
const loc = (id: string) => model.locations.find((l) => l.id === id)!;

describe('the model carries the rules per location', () => {
  it('derives rules from the verified codes and the scan date', () => {
    expect(loc('de').rules.label).toBe('Opt-in (EU/EEA)');
    expect(loc('us-ca').rules.regime).toBe('opt-out-signal');
    expect(loc('us-tx').rules.laws.map((l) => l.requirementId)).toContain('us-states.opt-out-method');
    expect(loc('us-fl').rules.regime).toBe('opt-out');
    expect(loc('br').rules.regime).toBe('unknown');
    expect(loc('fr').rules.verified).toBe(false);
    expect(loc('fr').rules.laws).toEqual([]);
  });

  it('survives a JSON round trip (the JSON renderer is the model)', () => {
    const back = JSON.parse(JSON.stringify(model));
    expect(back.locations[0].rules.laws[0].urls[0]).toMatch(/^https:\/\//);
  });
});

describe('HTML (PR C)', () => {
  const html = renderConsentHtml(model);
  const section = (): string => {
    const m = /<section id="locations-rules">([\s\S]*?)<\/section>/.exec(html);
    expect(m, 'section#locations-rules').toBeTruthy();
    return m![1];
  };
  const article = (id: string): string => {
    const m = new RegExp(`<article class="ck-loc" data-location="${id}">([\\s\\S]*?)</article>`).exec(section());
    expect(m, `article for ${id}`).toBeTruthy();
    return m![1];
  };

  it('has the section before the behavior matrix, with the heading', () => {
    expect(html.indexOf('id="locations-rules"')).toBeGreaterThan(0);
    expect(html.indexOf('id="locations-rules"')).toBeLessThan(html.indexOf('class="behavior-matrix"'));
    expect(section()).toMatch(/Where we tested and which rules applied/);
  });

  it('one article per location with the observed place and the model label as a disclosure button', () => {
    for (const l of model.locations) {
      const a = article(l.id);
      expect(a).toContain(l.label);
      expect(a).toContain(l.observed);
      expect(a).toMatch(new RegExp(`<button type="button" class="ck-rules-btn" aria-expanded="false" aria-controls="rules-pop-${l.id}">`));
      expect(a).toContain(`id="rules-pop-${l.id}"`);
      expect(a).toContain('data-open="false"');
      expect(a).toContain(l.rules.label.replace(/’/g, '&#39;').replace(/'/g, '&#39;'));
    }
  });

  it('the popover holds the summary, the must-haves, the laws with links, the state act and the notes', () => {
    const de = article('de');
    expect(de).toMatch(/<p class="ck-rules-summary">/);
    expect(de).toMatch(/<ul class="ck-rules-must">/);
    expect(de).toMatch(/as easy as accepting/);
    expect(de).toMatch(/<ol class="ck-rules-laws">/);
    expect(de).toMatch(/<a href="https:\/\/eur-lex\.europa\.eu[^"]*"[^>]*>ePrivacy Directive Art\. 5\(3\)<\/a>/);
    expect(de).toMatch(/since 2011-05-25/);

    const ca = article('us-ca');
    expect(ca).toMatch(/Opt-out, privacy signal honored \(California\)/);
    expect(ca).toMatch(/<p class="ck-rules-state">[^<]*California Consumer Privacy Act/);
    expect(ca).toMatch(/11 CCR §7025/);

    const tx = article('us-tx');
    expect(tx).toMatch(/Texas Data Privacy and Security Act/);
    expect(tx).not.toMatch(/Do Not Sell or Share/);

    const fl = article('us-fl');
    expect(fl).toMatch(/no state privacy law in force/);
    expect(fl).toMatch(/Fla\. ch\. 934/);

    const br = article('br');
    expect(br).toMatch(/No rules encoded \(Brazil\)/);
    expect(br).toMatch(/<p class="ck-rules-note">[^<]*fails closed to opt-in/);

    const fr = article('fr');
    expect(fr).toMatch(/Not verified/);
    expect(fr).not.toMatch(/<ol class="ck-rules-laws">/);
  });

  it('escapes and only links safe hrefs', () => {
    const bad = buildConsentReportModel(
      TrackingEvaluation.parse({ ...evaluation, locations: [{ ...evaluation.locations[0], spec: { ...evaluation.locations[0].spec, label: 'Ger<script>alert(1)</script>many' } }] }),
      [],
    );
    const out = renderConsentHtml(bad);
    expect(out).not.toContain('<script>alert(1)');
    expect(out).toContain('Ger&lt;script&gt;');
    expect(out).not.toMatch(/href="javascript:/i);
  });

  it('never emits verdict vocabulary', () => {
    expect(containsBannedVocabulary(html)).toBe(false);
  });
});

describe('Markdown (PR C)', () => {
  const md = renderConsentMarkdown(model);
  const locations = md.slice(md.indexOf('## Locations'), md.indexOf('## Summary'));

  it('each location lists its rules, laws and notes as sub-bullets', () => {
    expect(locations).toMatch(/\*\*Germany\*\*[\s\S]*?\n {2}- Rules: Opt-in \(EU\/EEA\) — /);
    expect(locations).toMatch(/\n {2}- Law: ePrivacy Directive Art\. 5\(3\) — [^\n]*\(https:\/\/eur-lex\.europa\.eu[^)]*\)/);
    expect(locations).toMatch(/\*\*Texas, US\*\*[\s\S]*?- Rules: Opt-out, privacy signal honored \(Texas\)/);
    expect(locations).toMatch(/\*\*Brazil\*\*[\s\S]*?- Note: [^\n]*fails closed to opt-in/);
    expect(locations).toMatch(/\*\*France\*\*[\s\S]*?- Rules: Not verified — no rules compared/);
    expect(containsBannedVocabulary(md)).toBe(false);
  });
});
