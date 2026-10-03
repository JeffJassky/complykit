import type { Field } from './fields.js';

// What each vendor was told (plans/consent-design.md §2.6 step 3). "Respecting
// the choice" looks different per vendor, and a raw request is never a finding
// by itself — Google tags still send cookieless pings with every consent type
// denied — so each request's own consent parameters are decoded and the decoded
// state is what rules compare with the law.

export type Signal = 'granted' | 'denied' | 'not-set' | 'unknown';

export interface DecodedConsent {
  decoder: string;
  adStorage?: Signal;
  analyticsStorage?: Signal;
  adUserData?: Signal;
  adPersonalization?: Signal;
  /** Vendor's restricted / limited-data mode is on (Google rdp/npa, Meta LDU, TikTok LDU). */
  restricted?: boolean;
  /** IAB strings present in the request. */
  iab?: { gdpr?: string; tcString?: boolean; usPrivacy?: string; gpp?: boolean; gppSid?: string };
  /** Human-readable facts, e.g. 'gcs=G100 (ad_storage denied, analytics_storage denied)'. */
  notes: string[];
}

const get = (fields: Field[], ...keys: string[]): string | undefined => {
  for (const k of keys) {
    const f = fields.find((x) => x.key === k);
    if (f) return f.value;
  }
  return undefined;
};

// Google Consent Mode `gcd` letters (per-signal state as default/update).
const GCD: Record<string, Signal> = {
  l: 'not-set',
  p: 'denied', // denied by default, no update
  q: 'denied', // denied by default and by update
  m: 'denied', // denied by update, no default
  u: 'denied', // granted by default, denied by update
  t: 'granted', // granted by default, no update
  r: 'granted', // denied by default, granted by update
  n: 'granted', // granted by update, no default
  v: 'granted', // granted by default and by update
};

function decodeGoogle(fields: Field[]): DecodedConsent {
  const d: DecodedConsent = { decoder: 'google', notes: [] };
  const gcs = get(fields, 'gcs');
  if (gcs && /^G1[01]{2}$/.test(gcs)) {
    d.adStorage = gcs[2] === '1' ? 'granted' : 'denied';
    d.analyticsStorage = gcs[3] === '1' ? 'granted' : 'denied';
    d.notes.push(`gcs=${gcs} (ad_storage ${d.adStorage}, analytics_storage ${d.analyticsStorage})`);
  }
  const gcd = get(fields, 'gcd');
  if (gcd && gcd.length >= 9) {
    const at = (i: number): Signal => GCD[gcd[i]] ?? 'unknown';
    d.adStorage = d.adStorage ?? at(2);
    d.analyticsStorage = d.analyticsStorage ?? at(4);
    d.adUserData = at(6);
    d.adPersonalization = at(8);
    d.notes.push(`gcd=${gcd} (ad_user_data ${d.adUserData}, ad_personalization ${d.adPersonalization})`);
  }
  const npa = get(fields, 'npa');
  const rdp = get(fields, 'rdp', 'restricted_data_processing');
  if (npa === '1' || rdp === '1') {
    d.restricted = true;
    d.notes.push([npa === '1' ? 'npa=1 (non-personalized ads)' : '', rdp === '1' ? 'rdp=1 (restricted data processing)' : ''].filter(Boolean).join(', '));
  }
  const dma = get(fields, 'dma');
  if (dma) d.notes.push(`dma=${dma}`);
  return d;
}

function decodeMeta(fields: Field[]): DecodedConsent {
  const d: DecodedConsent = { decoder: 'meta', notes: [] };
  const dpo = get(fields, 'dpo', 'data_processing_options');
  if (dpo && /ldu/i.test(dpo)) {
    d.restricted = true;
    d.notes.push(`dpo=${dpo} (Limited Data Use)`);
  }
  const consent = get(fields, 'cs_est', 'consent');
  if (consent) d.notes.push(`consent field ${consent}`);
  return d;
}

function decodeTikTok(fields: Field[]): DecodedConsent {
  const d: DecodedConsent = { decoder: 'tiktok', notes: [] };
  const ldu = fields.find((f) => /limited_data_use$/i.test(f.key));
  if (ldu && /^(true|1)$/i.test(ldu.value)) {
    d.restricted = true;
    d.notes.push('limited_data_use=true');
  }
  return d;
}

function decodeMicrosoft(fields: Field[]): DecodedConsent {
  const d: DecodedConsent = { decoder: 'microsoft', notes: [] };
  const asc = get(fields, 'asc');
  if (asc) {
    d.adStorage = asc === 'G' ? 'granted' : asc === 'D' ? 'denied' : 'unknown';
    d.notes.push(`asc=${asc} (ad_storage ${d.adStorage})`);
  }
  return d;
}

/** IAB strings anywhere: TCF (gdpr/gdpr_consent), USP (us_privacy), GPP (gpp/gpp_sid). */
function decodeIab(fields: Field[], d: DecodedConsent): void {
  const gdpr = get(fields, 'gdpr');
  const tc = get(fields, 'gdpr_consent', 'gdpr_pd', 'consent_string');
  const usp = get(fields, 'us_privacy', 'usp');
  const gpp = get(fields, 'gpp');
  const gppSid = get(fields, 'gpp_sid');
  if (gdpr === undefined && tc === undefined && usp === undefined && gpp === undefined && gppSid === undefined) return;
  d.iab = { gdpr, tcString: tc !== undefined && tc.length > 10, usPrivacy: usp, gpp: gpp !== undefined && gpp.length > 4, gppSid };
  if (usp && /^1.Y/i.test(usp)) {
    d.restricted = true;
    d.notes.push(`us_privacy=${usp} (opted out of sale)`);
  } else if (usp) d.notes.push(`us_privacy=${usp}`);
  if (gdpr !== undefined) d.notes.push(`gdpr=${gdpr}${d.iab.tcString ? ' with TC string' : ' without TC string'}`);
  if (gpp !== undefined || gppSid !== undefined) d.notes.push(`GPP ${gppSid ? `sid=${gppSid}` : 'string present'}`);
}

export function decodeConsent(decoder: string | undefined, fields: Field[]): DecodedConsent | undefined {
  let d: DecodedConsent;
  switch (decoder) {
    case 'google':
      d = decodeGoogle(fields);
      break;
    case 'meta':
      d = decodeMeta(fields);
      break;
    case 'tiktok':
      d = decodeTikTok(fields);
      break;
    case 'microsoft':
      d = decodeMicrosoft(fields);
      break;
    default:
      d = { decoder: decoder ?? 'none', notes: [] };
  }
  decodeIab(fields, d);
  const informative = d.notes.length || d.restricted !== undefined || d.adStorage || d.analyticsStorage;
  return informative ? d : undefined;
}

/** All storage consent denied — a Consent Mode "advanced" cookieless ping. */
export function allDenied(d: DecodedConsent | undefined): boolean {
  if (!d) return false;
  const vals = [d.adStorage, d.analyticsStorage].filter(Boolean);
  return vals.length > 0 && vals.every((v) => v === 'denied');
}

/** Ads signals denied (ad_storage + ad_user_data), or a restricted mode on. */
export function adsRestricted(d: DecodedConsent | undefined): boolean {
  if (!d) return false;
  if (d.restricted) return true;
  return d.adStorage === 'denied' && (d.adUserData === undefined || d.adUserData === 'denied');
}
