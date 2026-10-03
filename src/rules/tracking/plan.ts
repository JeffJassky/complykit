import type { LocationSpec, ScenarioId, LocationVerification, GeoSourceResult } from '../../record/index.js';
import { ALL_REQUIREMENTS, jurisdictionsFor, normalizeRegion } from '../../registry/index.js';

// Evaluation planning (plans/consent-design.md §2.2–2.3): which scenarios a
// verified location gets, location presets, and the location-verification
// verdict. Pure.

const EU_UK: ScenarioId[] = ['do-nothing', 'browse', 'dismiss', 'reject', 'accept', 'partial', 'withdraw', 'return-visit', 'markers'];
const US_PRIVACY_STATE: ScenarioId[] = ['do-nothing', 'browse', 'reject', 'gpc', 'opt-out-all', 'opt-out-link', 'markers'];
// 'reject' everywhere a banner might appear: a rejection that leaks is evidence in
// wiretap suits too (it costs one landing when there is no banner).
const US_OTHER: ScenarioId[] = ['do-nothing', 'browse', 'reject', 'gpc', 'markers'];
const ELSEWHERE: ScenarioId[] = ['do-nothing', 'browse', 'reject', 'accept'];

/** US states whose law requires honoring opt-out signals — derived from the registry, not hand-listed. */
export function optOutSignalStates(): Set<string> {
  const out = new Set<string>();
  for (const r of ALL_REQUIREMENTS) {
    const inst = String(r.instrument);
    if (inst !== 'ccpa' && inst !== 'us-state-privacy') continue;
    for (const j of r.jurisdictions ?? []) if (j.code.startsWith('us-')) out.add(j.code);
  }
  return out;
}

/**
 * Default scenario set for a verified location. EU/UK run the banner scenarios
 * plus withdraw, partial and markers; US privacy-law states add the do-not-sell
 * signal, "opt out every way" and the link walk; other US states run do
 * nothing, browse, reject, the signal and markers (reject, signal and markers
 * because of wiretap-law exposure).
 */
export function defaultScenarios(jurisdictions: readonly string[]): ScenarioId[] {
  if (jurisdictions.includes('eu') || jurisdictions.includes('uk')) return [...EU_UK];
  if (jurisdictions.includes('us')) {
    const states = optOutSignalStates();
    return jurisdictions.some((j) => states.has(j)) ? [...US_PRIVACY_STATE] : [...US_OTHER];
  }
  return [...ELSEWHERE];
}

/** The quick set for a first look (`--quick`): fewer scenarios, same rules. */
export function quickScenarios(jurisdictions: readonly string[]): ScenarioId[] {
  if (jurisdictions.includes('eu') || jurisdictions.includes('uk')) return ['do-nothing', 'reject', 'accept'];
  if (jurisdictions.includes('us')) return ['do-nothing', 'reject', 'gpc', 'markers'];
  return ['do-nothing', 'reject'];
}

const COUNTRY_NAMES: Record<string, string> = {
  DE: 'Germany', FR: 'France', NL: 'Netherlands', IE: 'Ireland', ES: 'Spain', IT: 'Italy', SE: 'Sweden', BE: 'Belgium',
  AT: 'Austria', DK: 'Denmark', FI: 'Finland', PL: 'Poland', PT: 'Portugal', NO: 'Norway', GB: 'United Kingdom', US: 'United States',
  CA: 'Canada', AU: 'Australia', CH: 'Switzerland',
};
const US_NAMES: Record<string, string> = {
  CA: 'California', CO: 'Colorado', CT: 'Connecticut', TX: 'Texas', FL: 'Florida', PA: 'Pennsylvania', NY: 'New York',
  WA: 'Washington', OR: 'Oregon', VA: 'Virginia', NJ: 'New Jersey', MD: 'Maryland', MN: 'Minnesota', MT: 'Montana',
  NE: 'Nebraska', NH: 'New Hampshire', DE: 'Delaware', IL: 'Illinois', GA: 'Georgia', OH: 'Ohio', MA: 'Massachusetts',
};

/**
 * A location from its id: 'local', a country ('de', 'uk'/'gb'), or a US state
 * ('us-ca'). The proxy comes from config (or `--proxy id=server`); without one a
 * non-local location verifies only if this machine really is there.
 */
export function locationPreset(id: string): LocationSpec {
  const key = id.trim().toLowerCase();
  if (key === 'local') return { id: 'local', label: 'This machine' };
  const us = /^us-([a-z]{2})$/.exec(key);
  if (us) {
    const st = us[1].toUpperCase();
    return { id: key, label: `${US_NAMES[st] ?? st}, US`, country: 'US', region: st };
  }
  const cc = key === 'uk' ? 'GB' : key.toUpperCase();
  if (!/^[A-Z]{2}$/.test(cc)) throw new Error(`unknown location "${id}" — use local, a country code (de, uk) or a US state (us-ca)`);
  return { id: key, label: COUNTRY_NAMES[cc] ?? cc, country: cc };
}

/**
 * Location verdict from the geo sources (plans/consent-design.md §2.2):
 * verified — two sources answered, agree with each other and with what was
 * expected; mismatch — a source places the exit elsewhere; unknown — a lookup
 * failed or the sources disagree. A region both sources can't confirm leaves a
 * verified location at country level (state geolocation is reliable only for
 * exits well inside a state).
 */
export function decideVerification(spec: LocationSpec, sources: GeoSourceResult[], checkedAt = new Date().toISOString()): LocationVerification {
  const expected = { country: spec.country?.toUpperCase(), region: spec.region?.toUpperCase() };
  const ok = sources.filter((s) => !s.error && s.country);
  const base = { expected, sources, siteReported: [], checkedAt };
  if (ok.length < 2) {
    return { ...base, verdict: 'unknown', observed: { ip: ok[0]?.ip, country: ok[0]?.country }, jurisdictions: [], note: `${ok.length} of ${sources.length} geolocation source(s) answered; two are required` };
  }
  const countries = new Set(ok.map((s) => s.country!.toUpperCase()));
  const ips = new Set(ok.map((s) => s.ip).filter(Boolean));
  if (countries.size > 1) {
    return { ...base, verdict: 'unknown', observed: { ip: ok[0].ip }, jurisdictions: [], note: `sources disagree on country: ${[...countries].join(' vs ')}` };
  }
  const country = [...countries][0];
  const regions = ok.map((s) => normalizeRegion(country, s.region));
  const agreedRegion = regions.every((r) => r && r === regions[0]) ? regions[0] : undefined;
  const observed = { ip: ok[0].ip, country, region: agreedRegion, city: ok[0].city };
  const ipNote = ips.size > 1 ? `sources saw different exit IPs (${[...ips].join(', ')}) — exit may rotate` : undefined;

  if (expected.country && expected.country !== country) {
    return { ...base, verdict: 'mismatch', observed, jurisdictions: [], note: `expected ${expected.country}, exit is in ${country}` };
  }
  if (expected.region) {
    const disagree = regions.filter((r) => r && r !== expected.region);
    if (disagree.length) {
      return { ...base, verdict: 'mismatch', observed, jurisdictions: [], note: `expected region ${expected.region}, source(s) report ${disagree.join(', ')}` };
    }
    if (!agreedRegion) {
      // Country verified; the state is not — findings only at country level.
      return { ...base, verdict: 'verified', observed, regionUnverified: true, jurisdictions: jurisdictionsFor({ country }), note: [`region ${expected.region} not confirmed by both sources`, ipNote].filter(Boolean).join('; ') };
    }
  }
  return { ...base, verdict: 'verified', observed, jurisdictions: jurisdictionsFor({ country, region: agreedRegion }), note: ipNote };
}

