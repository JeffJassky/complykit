// Bot-challenge pages (R4 follow-up). A Verify fetches ONE page; when a bot
// manager answers with its challenge instead of the site's page, the checkers
// would judge the challenge's markup — a missing config element "fails", a
// removed tag "passes". So the fetch path asks this first and stops with
// cannot-verify. Pure: the top document's HTML and its response headers in.
//
// Markers are the challenge / block page's own, not the vendor's presence: a
// site behind Cloudflare carries /cdn-cgi/challenge-platform/scripts/jsd/ on
// every normal page, and DataDome / Sucuri / Imperva set their headers on
// every response. Those alone never count.

export interface BotChallenge {
  vendor: string;
  /** What matched, for the owner (header or the matched text, ≤ 80 chars). */
  marker: string;
}

type Headers = Record<string, string | string[] | undefined>;

interface Marker {
  vendor: string;
  re: RegExp;
}

const BODY_MARKERS: Marker[] = [
  { vendor: 'Cloudflare', re: /<title>\s*Just a moment\.\.\.\s*<\/title>/i },
  { vendor: 'Cloudflare', re: /\b_?cf_chl_opt\b/ },
  { vendor: 'Cloudflare', re: /\/cdn-cgi\/challenge-platform\/(?!scripts\/jsd\/)[^"'\s]*/ },
  { vendor: 'Cloudflare', re: /<title>\s*Attention Required! \| Cloudflare\s*<\/title>/i },
  { vendor: 'Akamai', re: /\/_sec\/cp_challenge\/[^"'\s]*/ },
  { vendor: 'Akamai', re: /\bsec-if-cpt-container\b/ },
  { vendor: 'PerimeterX (HUMAN)', re: /\bpx-captcha\b|_pxCaptcha|captcha\.px-cdn\.net/ },
  { vendor: 'DataDome', re: /(?:geo\.)?captcha-delivery\.com/ },
  { vendor: 'Sucuri', re: /sucuri_cloudproxy_js|Sucuri WebSite Firewall - (?:Access Denied|CloudProxy)/i },
  { vendor: 'Imperva (Incapsula)', re: /_Incapsula_Resource|Incapsula incident ID/ },
];

function header(h: Headers, name: string): string | undefined {
  for (const [k, v] of Object.entries(h)) if (k.toLowerCase() === name) return Array.isArray(v) ? v.join(', ') : v;
  return undefined;
}

const clip = (s: string): string => (s.length > 80 ? `${s.slice(0, 80)}…` : s);

/** The bot challenge this response is, or undefined when it looks like the site's own page. */
export function detectBotChallenge(html: string, headers: Headers = {}, status?: number): BotChallenge | undefined {
  const mitigated = header(headers, 'cf-mitigated');
  if (mitigated && /challenge/i.test(mitigated)) return { vendor: 'Cloudflare', marker: `cf-mitigated: ${mitigated}` };
  // DataDome answers its challenge with 403 and x-datadome; the header alone is on every response.
  const dd = header(headers, 'x-datadome');
  if (dd && status === 403) return { vendor: 'DataDome', marker: `x-datadome: ${dd} (HTTP 403)` };
  const text = typeof html === 'string' ? html : '';
  for (const m of BODY_MARKERS) {
    const hit = m.re.exec(text);
    if (hit) return { vendor: m.vendor, marker: clip(hit[0]) };
  }
  return undefined;
}
