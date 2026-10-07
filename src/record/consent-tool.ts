import { z } from 'zod';

// The consent tool a site installed, and what its stored state grants on a fresh
// profile BEFORE any interaction (client-consent epic, ticket A4).
//
// Pure: a table of known cookie / localStorage keys with one decoder each. The
// browser collector reads the fresh profile's cookies and localStorage and
// hands them here; nothing in this file touches a page. A finding rule that
// says "this default grants something without a choice" is B1's, not this file's.
//
// Honesty rules:
//   - A key that is present but cannot be decoded names the vendor and sets
//     `decoded: false`. It never guesses grants.
//   - No stored state at all is NOT "nothing granted": the tool's own config
//     decides, and a cookie we cannot see proves nothing. `decoded: false`.
//   - Categories are normalized to necessary | preferences | analytics |
//     marketing, plus vendor-specific extras (social, sale-of-data, per-service).

export const ConsentToolRecord = z.object({
  // Vendor name, or null = no consent tool detected.
  vendor: z.string().nullable(),
  // category -> granted by the stored default. Empty unless `decoded`.
  defaultGrants: z.record(z.boolean()),
  // True when a stored state was found and decoded into defaultGrants.
  decoded: z.boolean(),
  // Whether the stored state records a visitor choice (true), is a tool-set
  // default (false), or the tool does not say (undefined).
  choiceRecorded: z.boolean().optional(),
  // Where this came from: 'cookie:<name>', 'localStorage:<key>',
  // 'banner:<detector>' (named by the banner, nothing decodable), 'none'.
  source: z.string(),
  note: z.string().optional(),
});
export type ConsentToolRecord = z.infer<typeof ConsentToolRecord>;

export interface StoredConsentInput {
  cookies: Array<{ name: string; value: string }>;
  /** localStorage entries of the landing origin. */
  storage: Array<{ key: string; value: string }>;
  /** The vendor the banner detector named, if any (fallback when nothing decodes). */
  bannerVendor?: string;
}

interface Decoded {
  grants: Record<string, boolean>;
  choiceRecorded?: boolean;
  note?: string;
}

interface ConsentToolSpec {
  vendor: string;
  kind: 'cookie' | 'localStorage';
  key: string | RegExp;
  /** Returns undefined when present but not decodable. `all` is every cookie by name (for tools that spread state over several). */
  decode(raw: string, all: Map<string, string>): Decoded | undefined;
}

// --- helpers -------------------------------------------------------------------

function unescapeValue(raw: string): string {
  let v = raw;
  for (let i = 0; i < 2 && /%[0-9a-f]{2}/i.test(v); i++) {
    try {
      v = decodeURIComponent(v);
    } catch {
      break;
    }
  }
  return v;
}

function parseJson(raw: string): unknown {
  try {
    return JSON.parse(unescapeValue(raw));
  } catch {
    return undefined;
  }
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** 'yes'/'true'/'1'/'allow'/'accept'/'granted' -> true; 'no'/'false'/'0'/'deny'/... -> false; else undefined. */
function truth(v: unknown): boolean | undefined {
  if (typeof v === 'boolean') return v;
  if (typeof v === 'number') return v === 1 ? true : v === 0 ? false : undefined;
  if (typeof v !== 'string') return undefined;
  const s = v.trim().toLowerCase();
  if (['yes', 'true', '1', 'allow', 'accept', 'accepted', 'granted'].includes(s)) return true;
  if (['no', 'false', '0', 'deny', 'denied', 'decline', 'reject', 'rejected'].includes(s)) return false;
  return undefined;
}

function parsePairs(raw: string, pairSep: string, kvSep: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of unescapeValue(raw).split(pairSep)) {
    const i = part.indexOf(kvSep);
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + kvSep.length).trim();
  }
  return out;
}

// --- decoders ------------------------------------------------------------------

// OneTrust: OptanonConsent = urlencoded k=v&k=v; groups=C0001:1,C0002:0,...
const ONETRUST_GROUPS: Record<string, string> = {
  C0001: 'necessary',
  C0002: 'analytics', // performance
  C0003: 'preferences', // functional
  C0004: 'marketing', // targeting / advertising
  C0005: 'social',
};
function decodeOneTrust(raw: string, all: Map<string, string>): Decoded | undefined {
  const kv = parsePairs(raw, '&', '=');
  if (!kv.groups) return undefined;
  const grants: Record<string, boolean> = {};
  for (const g of kv.groups.split(',')) {
    const [id, v] = g.split(':');
    const on = truth(v);
    if (id && on !== undefined) grants[ONETRUST_GROUPS[id] ?? id] = on;
  }
  if (!Object.keys(grants).length) return undefined;
  const interactions = Number(kv.interactionCount);
  const choiceRecorded = all.has('OptanonAlertBoxClosed') || (Number.isFinite(interactions) && interactions > 0);
  return { grants, choiceRecorded };
}

// Cookiebot: CookieConsent = {stamp:'..',necessary:true,preferences:false,statistics:false,marketing:false,method:'implied',...}
// "-1" = the visitor's region needs no consent: the tool treats everything as allowed.
function decodeCookiebot(raw: string): Decoded | undefined {
  const v = unescapeValue(raw).trim();
  if (v === '-1') {
    return { grants: { necessary: true, preferences: true, analytics: true, marketing: true }, choiceRecorded: false, note: 'Cookiebot "-1": region needs no consent, everything is allowed' };
  }
  const field = (k: string): string | undefined => new RegExp(`(?:^|[{,])\\s*['"]?${k}['"]?\\s*:\\s*['"]?([^,'"}]*)`).exec(v)?.[1]?.trim();
  const necessary = truth(field('necessary'));
  const preferences = truth(field('preferences'));
  const statistics = truth(field('statistics'));
  const marketing = truth(field('marketing'));
  if (statistics === undefined && marketing === undefined) return undefined;
  const grants: Record<string, boolean> = {};
  if (necessary !== undefined) grants.necessary = necessary;
  if (preferences !== undefined) grants.preferences = preferences;
  if (statistics !== undefined) grants.analytics = statistics;
  if (marketing !== undefined) grants.marketing = marketing;
  const method = field('method');
  return { grants, choiceRecorded: method ? method !== 'implied' : undefined };
}

// CookieYes: cookieyes-consent = consentid:..,consent:no,action:,necessary:yes,functional:no,analytics:no,performance:no,advertisement:no,other:no
const COOKIEYES_MAP: Record<string, string> = { necessary: 'necessary', functional: 'preferences', analytics: 'analytics', performance: 'performance', advertisement: 'marketing', other: 'other' };
function decodeCookieYes(raw: string): Decoded | undefined {
  const kv = parsePairs(raw, ',', ':');
  const grants: Record<string, boolean> = {};
  for (const [k, name] of Object.entries(COOKIEYES_MAP)) {
    const on = truth(kv[k]);
    if (on !== undefined) grants[name] = on;
  }
  if (!Object.keys(grants).filter((k) => k !== 'necessary').length) return undefined;
  return { grants, choiceRecorded: kv.action ? true : undefined };
}

// CookieYes v1 (legacy): one cookie per category, cookielawinfo-checkbox-<cat> = yes|no
function decodeCookieYesLegacy(_raw: string, all: Map<string, string>): Decoded | undefined {
  const grants: Record<string, boolean> = {};
  for (const [name, value] of all) {
    const m = /^cookielawinfo-checkbox-(.+)$/.exec(name);
    const on = m ? truth(value) : undefined;
    if (m && on !== undefined) grants[m[1] === 'advertisement' ? 'marketing' : m[1] === 'functional' ? 'preferences' : m[1]] = on;
  }
  if (!Object.keys(grants).length) return undefined;
  return { grants, choiceRecorded: truth(all.get('viewed_cookie_policy')) };
}

// Complianz: cmplz_functional / _preferences / _statistics / _marketing = allow|deny, cmplz_consent_status = allow|deny|dismiss
function decodeComplianz(_raw: string, all: Map<string, string>): Decoded | undefined {
  const grants: Record<string, boolean> = {};
  const cats: Record<string, string> = { cmplz_functional: 'necessary', cmplz_preferences: 'preferences', cmplz_statistics: 'analytics', cmplz_marketing: 'marketing' };
  for (const [cookie, name] of Object.entries(cats)) {
    const on = truth(all.get(cookie));
    if (on !== undefined) grants[name] = on;
  }
  const status = all.get('cmplz_consent_status');
  if (!Object.keys(grants).length) {
    const s = truth(status);
    if (s === undefined) return undefined; // 'dismiss' or absent: no per-category state to decode
    return { grants: { analytics: s, marketing: s, preferences: s }, choiceRecorded: all.has('cmplz_banner-status'), note: `cmplz_consent_status=${status}` };
  }
  return { grants, choiceRecorded: status === 'allow' || status === 'deny' ? true : undefined };
}

// Klaro: cookie or localStorage "klaro" = {"service-name":true,...} (urlencoded in the cookie).
// Klaro stores nothing until a choice; service defaults live in its config.
function decodeKlaro(raw: string): Decoded | undefined {
  const j = parseJson(raw);
  if (!isObj(j)) return undefined;
  const grants: Record<string, boolean> = {};
  for (const [k, v] of Object.entries(j)) if (typeof v === 'boolean') grants[k] = v;
  return Object.keys(grants).length ? { grants, choiceRecorded: true, note: 'per-service, Klaro names no categories' } : undefined;
}

// Osano: osano_consentmanager = {"ANALYTICS":"ACCEPT","MARKETING":"DENY","PERSONALIZATION":..,"ESSENTIAL":..,"OPT_OUT":..}
// (top level or under "consent"). The stored blob has been seen in other shapes; anything else is "present, not decoded".
const OSANO_MAP: Record<string, string> = { ESSENTIAL: 'necessary', ANALYTICS: 'analytics', MARKETING: 'marketing', PERSONALIZATION: 'preferences', STORAGE: 'preferences' };
function decodeOsano(raw: string): Decoded | undefined {
  const j = parseJson(raw);
  if (!isObj(j)) return undefined;
  const src = isObj(j.consent) ? j.consent : j;
  const grants: Record<string, boolean> = {};
  for (const [k, name] of Object.entries(OSANO_MAP)) {
    const on = truth(src[k]);
    if (on !== undefined) grants[name] = on;
  }
  return Object.keys(grants).length ? { grants, choiceRecorded: true } : undefined;
}

// Osano's open-source cookieconsent v3: cookieconsent_status = allow | deny | dismiss
function decodeCookieconsentStatus(raw: string): Decoded | undefined {
  const on = truth(raw);
  if (on === undefined) return undefined; // 'dismiss': closed without choosing; no category state
  return { grants: { analytics: on, marketing: on, preferences: on }, choiceRecorded: true, note: 'cookieconsent_status is all-or-nothing' };
}

// Termly: keys identify the tool (consentUUID, TERMLY_API_CACHE) but the
// per-category state is not documented as a stable cookie format, so we decode
// nothing from them. Vendor named, grants unknown. (Revisit on a real capture.)
function decodeUndocumented(): Decoded | undefined {
  return undefined;
}

// Shopify customer privacy: _tracking_consent (and _cmp_a) = urlencoded JSON.
//   v2.1: {"purposes":{"a":true,"p":true,"m":true,"t":true},"display_banner":false,"sale_of_data_region":false,...}
//   v2.0: {"con":{"CMP":{"a":"","m":"","p":"","s":""}},"region":"USCA",...}   "1" yes, "0" no, "" not chosen
function decodeShopify(raw: string): Decoded | undefined {
  const j = parseJson(raw);
  if (!isObj(j)) return undefined;
  const grants: Record<string, boolean> = {};
  const set = (k: string, name: string, v: unknown): void => {
    const on = truth(v === '' ? undefined : v);
    if (on !== undefined) grants[name] = on;
  };
  if (isObj(j.purposes)) {
    set('a', 'analytics', j.purposes.a);
    set('p', 'preferences', j.purposes.p);
    set('m', 'marketing', j.purposes.m);
    set('t', 'sale-of-data', j.purposes.t);
  } else if (isObj(j.con) && isObj(j.con.CMP)) {
    set('a', 'analytics', j.con.CMP.a);
    set('p', 'preferences', j.con.CMP.p);
    set('m', 'marketing', j.con.CMP.m);
    set('s', 'sale-of-data', j.con.CMP.s);
  } else return undefined;
  if (!Object.keys(grants).length) return undefined;
  const banner = typeof j.display_banner === 'boolean' ? j.display_banner : undefined;
  return { grants, choiceRecorded: isObj(j.purposes) ? undefined : true, note: banner === false ? 'region shows no banner; Shopify stores its regional default' : undefined };
}

// complykit's own consent cookie (client/src/store.ts, format 1), urlencoded JSON:
//   {"v":1,"id":"<random>","at":"<ISO>","configHash":"…","regime":"opt-in","gpc":false,
//    "categories":{"necessary":true,"analytics":false,…}}
// The client writes it ONLY on a visitor's choice (never for defaults), so a
// decodable value always means a recorded choice. Another `v` is not guessed at.
function decodeComplykit(raw: string): Decoded | undefined {
  const j = parseJson(raw);
  if (!isObj(j) || j.v !== 1 || !isObj(j.categories)) return undefined;
  const grants: Record<string, boolean> = {};
  for (const [k, v] of Object.entries(j.categories)) if (typeof v === 'boolean') grants[k] = v;
  if (!Object.keys(grants).length) return undefined;
  const regime = typeof j.regime === 'string' ? j.regime : undefined;
  const at = typeof j.at === 'string' ? j.at : undefined;
  const note = regime || at ? `choice recorded${at ? ` ${at}` : ''}${regime ? ` under ${regime}` : ''}${j.gpc === true ? ' with GPC' : ''}` : undefined;
  return { grants, choiceRecorded: true, note };
}

// --- the table -----------------------------------------------------------------

export const CONSENT_TOOLS: ConsentToolSpec[] = [
  { vendor: 'OneTrust', kind: 'cookie', key: 'OptanonConsent', decode: decodeOneTrust },
  { vendor: 'Cookiebot', kind: 'cookie', key: 'CookieConsent', decode: (r) => decodeCookiebot(r) },
  { vendor: 'CookieYes', kind: 'cookie', key: 'cookieyes-consent', decode: (r) => decodeCookieYes(r) },
  { vendor: 'CookieYes', kind: 'cookie', key: /^cookielawinfo-checkbox-/, decode: decodeCookieYesLegacy },
  { vendor: 'Complianz', kind: 'cookie', key: /^cmplz_(consent_status|functional|preferences|statistics|marketing)$/, decode: decodeComplianz },
  { vendor: 'Klaro', kind: 'cookie', key: 'klaro', decode: (r) => decodeKlaro(r) },
  { vendor: 'Klaro', kind: 'localStorage', key: 'klaro', decode: (r) => decodeKlaro(r) },
  { vendor: 'Osano', kind: 'localStorage', key: 'osano_consentmanager', decode: (r) => decodeOsano(r) },
  { vendor: 'Osano', kind: 'cookie', key: 'osano_consentmanager', decode: (r) => decodeOsano(r) },
  { vendor: 'Osano', kind: 'cookie', key: 'cookieconsent_status', decode: (r) => decodeCookieconsentStatus(r) },
  { vendor: 'Termly', kind: 'cookie', key: 'consentUUID', decode: decodeUndocumented },
  { vendor: 'Termly', kind: 'localStorage', key: 'TERMLY_API_CACHE', decode: decodeUndocumented },
  { vendor: 'Shopify customer privacy', kind: 'cookie', key: '_tracking_consent', decode: (r) => decodeShopify(r) },
  { vendor: 'Shopify customer privacy', kind: 'cookie', key: '_cmp_a', decode: (r) => decodeShopify(r) },
  { vendor: 'complykit', kind: 'cookie', key: 'complykit_consent', decode: (r) => decodeComplykit(r) },
];

function matches(key: string | RegExp, name: string): boolean {
  return typeof key === 'string' ? key === name : key.test(name);
}

/**
 * Name the consent tool from a fresh profile's stored state and decode what it
 * grants by default. First table entry that DECODES wins; if some entry matched
 * a key but nothing decoded, the vendor is still named (decoded: false). With no
 * stored state, falls back to the vendor the banner detector named.
 */
export function detectConsentTool(input: StoredConsentInput): ConsentToolRecord {
  const cookies = new Map(input.cookies.map((c) => [c.name, c.value]));
  const storage = new Map(input.storage.map((s) => [s.key, s.value]));
  let named: { vendor: string; source: string } | undefined;
  for (const spec of CONSENT_TOOLS) {
    const names = spec.kind === 'cookie' ? [...cookies.keys()] : [...storage.keys()];
    const hit = names.find((n) => matches(spec.key, n));
    if (hit === undefined) continue;
    const source = `${spec.kind}:${hit}`;
    named ??= { vendor: spec.vendor, source };
    const raw = (spec.kind === 'cookie' ? cookies : storage).get(hit) ?? '';
    const d = spec.decode(raw, cookies);
    if (d) return { vendor: spec.vendor, defaultGrants: d.grants, decoded: true, choiceRecorded: d.choiceRecorded, source, note: d.note };
  }
  if (named) return { vendor: named.vendor, defaultGrants: {}, decoded: false, source: named.source, note: 'consent tool storage present but its state could not be decoded' };
  if (input.bannerVendor) {
    return {
      vendor: input.bannerVendor,
      defaultGrants: {},
      decoded: false,
      source: 'banner:detected',
      note: 'named by the banner; nothing stored on the fresh profile, so the default state is not observed',
    };
  }
  return { vendor: null, defaultGrants: {}, decoded: false, source: 'none', note: 'no consent tool detected (no banner, no known stored state)' };
}
