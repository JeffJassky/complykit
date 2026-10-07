import {
  CONSENT_CONFIG_ELEMENT_ID,
  parseConsentToolConfig,
  parseMarkup,
  type ElementSignature,
  type MarkupElement,
  type RemediationVerifySpec,
  type SpotCheckObservation,
  type VerifyOutcome,
} from '../../record/index.js';
import { DEFAULT_KB, registrableDomain, hostOf, type KnowledgeBase } from '../../registry/index.js';
import { matchMarkupElement } from '../tracking/markup.js';
import { extractContainerData } from '../tracking/gtm.js';

// Spot-check verifiers for the guided remediation flow (plans/remediation-flow.md
// §5). Pure: the input is ONE fetched page's HTML, ONE fetched container file,
// or ONE browser observation; nothing here fetches or runs a browser. Every
// checker fails closed:
//
//   pass           the served markup / container / observation shows the change
//   fail           it shows the change was not made, or not made right
//   cannot-verify  the input does not let the question be decided (the element
//                  is gone, the page has no Google tag, the container version
//                  renumbered the tag, the accept visit was not made…) — never
//                  folded into pass
//
// What a static check proves: that the HTML the owner serves carries the
// change. It does NOT prove behavior — a held tag can still be released by
// another script, a CDN can serve another variant, a GTM container can be
// republished. Behavior is the rescan's (D10) job; these checks exist so the
// owner finds out in seconds that an edit did not land, not in a 10-minute scan.

export interface VerifyOptions {
  kb?: KnowledgeBase;
  /** The site's registrable domain (default: from the page URL). */
  site?: string;
}

const ok = (message: string, evidence: string[] = []): VerifyOutcome => ({ result: 'pass', message, evidence });
const fail = (message: string, evidence: string[] = []): VerifyOutcome => ({ result: 'fail', message, evidence });
const unknown = (message: string, evidence: string[] = []): VerifyOutcome => ({ result: 'cannot-verify', message, evidence });

const GOOGLE_TAG_HOST = /(^|\.)googletagmanager\.com$/i;
const GOOGLE_ID_RE = /^(GTM|GT|G|AW|DC|UA)-/;
const SHORT = 120;
const short = (s: string): string => (s.length > SHORT ? `${s.slice(0, SHORT)}…` : s);

function urlParts(url: string | undefined): { host?: string; path?: string; ids: string[] } {
  if (!url) return { ids: [] };
  try {
    const u = new URL(url);
    const ids = [...new Set([...u.search.matchAll(/\b((?:GTM|GT|G|AW|DC|UA)-[A-Z0-9-]{4,16})\b/gi)].map((m) => m[1].toUpperCase()))];
    return { host: u.hostname.toLowerCase(), path: u.pathname.replace(/\/+$/, '') || '/', ids };
  } catch {
    return { ids: [] };
  }
}

function notHtml(html: string): VerifyOutcome | undefined {
  if (typeof html !== 'string' || !html.trim()) return unknown('the page body was empty: nothing to check');
  if (!html.includes('<')) return unknown('the page body is not HTML: nothing to check');
  return undefined;
}

/** Does this parsed element carry the signature? Line-independent (exported for tests). */
export function elementMatches(el: MarkupElement, sig: ElementSignature): boolean {
  if (el.kind !== sig.kind || el.context === 'template') return false;
  const ctx = el.context === 'noscript' ? 'noscript' : 'document';
  if (ctx !== sig.context) return false;
  if (sig.inline) {
    if (el.body === undefined) return false;
    if (sig.inline.match && !el.body.includes(sig.inline.match)) return false;
    const ids = new Set(el.ids.map((x) => x.toUpperCase()));
    return sig.ids.every((id) => ids.has(id.toUpperCase()));
  }
  const u = urlParts(el.url);
  if (!u.host || u.host !== sig.host) return false;
  if (sig.path !== undefined && u.path !== sig.path) return false;
  const ids = new Set(u.ids);
  return sig.ids.every((id) => ids.has(id.toUpperCase()));
}

const where = (el: MarkupElement): string => `line ${el.line}${el.context === 'noscript' ? ' (in <noscript>)' : ''}`;

/** The vendor-signature tags on the page (knowledge-base matched, or Google's tag hosts / ids). */
function isTagScript(el: MarkupElement, kb: KnowledgeBase, site: string): string | undefined {
  if (el.kind !== 'script' || el.loads !== 'executes') return undefined;
  const u = urlParts(el.url);
  if (u.host && GOOGLE_TAG_HOST.test(u.host)) return 'Google Tag Manager / gtag.js';
  if (el.hosts.some((h) => GOOGLE_TAG_HOST.test(h)) || el.ids.some((id) => GOOGLE_ID_RE.test(id))) return 'Google Tag Manager / gtag.js (inline)';
  const m = matchMarkupElement(el, kb, { registrableDomain: site });
  return m.length ? m.map((x) => x.label).join(', ') : undefined;
}

function siteOf(page: string, opts: VerifyOptions): string {
  return opts.site ?? registrableDomain(hostOf(page));
}

// --- install ---------------------------------------------------------------------------

/** The config element's raw text (regex over the raw HTML: the tokenizer caps inline bodies). */
function configElementText(html: string): { count: number; type?: string; text?: string } {
  let count = 0;
  let found: { type?: string; text?: string } | undefined;
  for (const m of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi)) {
    const attrs = m[1];
    const id = /\bid\s*=\s*["']?([^"'\s>]+)/i.exec(attrs)?.[1];
    if (id !== CONSENT_CONFIG_ELEMENT_ID) continue;
    count++;
    if (!found) found = { type: /\btype\s*=\s*["']?([^"'\s>]+)/i.exec(attrs)?.[1]?.toLowerCase(), text: m[2] };
  }
  return { count, ...found };
}

export interface InstallExpectation {
  page: string;
  configHash: string;
  scriptSrc: string;
  elementId?: string;
}

/**
 * The install task: the config element is present, parses, hashes to the
 * latest generated config; the core script is present, blocking, and runs
 * before any tag-manager / vendor script.
 */
export function verifyInstall(html: string, expected: InstallExpectation, opts: VerifyOptions = {}): VerifyOutcome {
  const bad = notHtml(html);
  if (bad) return bad;
  const kb = opts.kb ?? DEFAULT_KB;
  const site = siteOf(expected.page, opts);
  const evidence: string[] = [];

  const cfg = configElementText(html);
  if (cfg.count === 0) return fail(`no <script id="${CONSENT_CONFIG_ELEMENT_ID}"> element on this page: Part 1 of the snippet is not in the served HTML (or a cache serves the old page)`);
  if (cfg.count > 1) return fail(`${cfg.count} config elements on this page: keep exactly one (the latest)`);
  if (cfg.type !== 'application/json') return fail(`the config element's type is ${cfg.type ? `"${cfg.type}"` : 'missing'}; it must be application/json or the tool does not read it`);
  let raw: unknown;
  try {
    raw = JSON.parse(cfg.text ?? '');
  } catch {
    return fail('the config element is not valid JSON: paste the snippet unchanged');
  }
  const parsed = parseConsentToolConfig(raw);
  if (!parsed.ok) return fail(`the deployed config is refused (${parsed.reason}): ${parsed.issues.map((i) => `${i.path}: ${i.message}`).slice(0, 4).join('; ')}`);
  if (!parsed.hashMatches) return fail('the deployed config was edited after generation (its hash does not verify): regenerate and paste it unchanged', [`deployed hash ${parsed.config.hash.slice(0, 12)}`]);
  if (parsed.config.hash !== expected.configHash) {
    return fail('the deployed config is not the latest generated one: paste the newest snippet', [`deployed ${parsed.config.hash.slice(0, 12)}, latest ${expected.configHash.slice(0, 12)}`]);
  }
  evidence.push(`config hash ${parsed.config.hash.slice(0, 12)} = latest`);

  const elements = parseMarkup(html, expected.page);
  const want = urlParts(expected.scriptSrc.startsWith('/') ? new URL(expected.scriptSrc, expected.page).toString() : expected.scriptSrc);
  const cores = elements.filter((el) => {
    if (el.kind !== 'script' || !el.url) return false;
    const u = urlParts(el.url);
    return u.path === want.path || /\/complykit-consent\.js$/i.test(u.path ?? '');
  });
  if (!cores.length) return fail(`no <script src="…complykit-consent.js"> on this page (expected ${expected.scriptSrc})`);
  const core = cores[0];
  if (core.context !== 'document') return fail(`the core script is inside <${core.context}> (${where(core)}): it never runs there`);
  if (core.loads !== 'executes') return fail(`the core script at ${where(core)} does not execute (type="${core.attributes.type ?? ''}"${core.optimizer ? `, delayed by ${core.optimizer}` : ''})`);
  if (core.optimizer) return fail(`${core.optimizer} delays the core script (${where(core)}): exclude it — a delayed tool holds nothing`);
  const a = core.attributes;
  if ('async' in a || 'defer' in a || (a.type ?? '').toLowerCase() === 'module') return fail(`the core script at ${where(core)} is ${'async' in a ? 'async' : 'defer' in a ? 'defer' : 'a module'}: it must block (no async, defer or type="module")`);
  evidence.push(`core script at ${where(core)}, blocking`);

  const coreIdx = elements.indexOf(core);
  const configEl = elements.find((el) => el.kind === 'script' && el.attributes.id === CONSENT_CONFIG_ELEMENT_ID);
  if (configEl && elements.indexOf(configEl) > coreIdx) return fail(`the config element (${where(configEl)}) comes after the core script (${where(core)}): the config must come first`);
  for (const el of elements.slice(0, coreIdx)) {
    const label = isTagScript(el, kb, site);
    if (label) return fail(`${label} (${where(el)}) loads before the consent tool (${where(core)}): move the snippet above it`, evidence);
  }
  return ok('config present and current; core script blocking and first', evidence);
}

// --- rewrite / remove ------------------------------------------------------------------

/** The original executable tag is gone and a type="text/plain" data-category twin with the same signature is there. */
export function verifyRewriteTag(html: string, spec: { page: string; element: ElementSignature; category: string }): VerifyOutcome {
  const bad = notHtml(html);
  if (bad) return bad;
  const matches = parseMarkup(html, spec.page).filter((el) => elementMatches(el, spec.element));
  const executing = matches.filter((el) => el.loads === 'executes');
  if (executing.length) {
    const el = executing[0];
    return fail(
      el.optimizer
        ? `the tag at ${where(el)} still runs: ${el.optimizer} delays it for every visitor, which is not consent gating — exclude it from the plugin and rewrite the source tag`
        : `the tag at ${where(el)} still executes (type="${el.attributes.type ?? ''}")${matches.length > executing.length ? '; the rewritten copy is there too — remove the original, or it loads twice after consent' : ''}`,
      executing.map((e) => `line ${e.line}`),
    );
  }
  const held = matches.filter((el) => el.loads === 'held');
  if (!held.length) {
    return matches.length
      ? fail(`the tag is on this page (${where(matches[0])}) but neither executes nor is held (type="${matches[0].attributes.type ?? ''}"): not the snippet's form`)
      : unknown('no tag with this signature is on this page: removed, moved to another page, or its code changed. If you removed it on purpose, mark the task done.');
  }
  for (const el of held) {
    const type = (el.attributes.type ?? '').trim().toLowerCase();
    const cat = el.attributes['data-category'] ?? el.attributes['data-ck-category'];
    if (type !== 'text/plain') return fail(`the tag at ${where(el)} is held by another convention (type="${el.attributes.type}"): complykit releases only type="text/plain" tags`, [`line ${el.line}`]);
    if (cat === undefined) return fail(`the tag at ${where(el)} is type="text/plain" but has no data-category: add data-category="${spec.category}"`, [`line ${el.line}`]);
    if (cat !== spec.category) return fail(`the tag at ${where(el)} has data-category="${cat}", expected "${spec.category}" (the vendor's category in the config)`, [`line ${el.line}`]);
    if (el.documentWrite) return fail(`the tag at ${where(el)} is held, but its code calls document.write: released late, that write is ignored or wipes the page — it cannot be gated as written`, [`line ${el.line}`]);
  }
  return ok(`held as type="text/plain" data-category="${spec.category}" (${held.map(where).join(', ')}); the original executable tag is gone`, held.map((e) => `line ${e.line}`));
}

/** No element with the signature is fetched by the browser any more (gone, or switched to a held data-src form). */
export function verifyRemoveLeak(html: string, spec: { page: string; element: ElementSignature }): VerifyOutcome {
  const bad = notHtml(html);
  if (bad) return bad;
  const matches = parseMarkup(html, spec.page).filter((el) => elementMatches(el, spec.element));
  const live = matches.filter((el) => el.loads === 'fetches' || el.loads === 'connects' || el.loads === 'executes');
  if (live.length) return fail(`still in the HTML at ${live.map(where).join(', ')}: the browser fetches it before any script runs`, live.map((e) => `line ${e.line}`));
  const held = matches.filter((el) => el.loads === 'held');
  if (held.length) return ok(`no longer fetched: switched to a held data-src form (${held.map(where).join(', ')}) — released only on consent`, held.map((e) => `line ${e.line}`));
  return ok('no element with this signature is in the served HTML of this page');
}

// --- GTM ---------------------------------------------------------------------------------

/** The container tag carries "require additional consent" for every expected type. */
export function verifyGtmTagConsent(containerJs: string, spec: { containerId: string; tagId: number; consentTypes: string[] }): VerifyOutcome {
  const { data, reason } = extractContainerData(containerJs);
  if (!data) return unknown(`the container could not be read (${reason ?? 'unknown'}): nothing is established about its tags`);
  const tags = data.resource.tags.filter((t): t is Record<string, unknown> => typeof t === 'object' && t !== null);
  const tag = tags.find((t) => t.tag_id === spec.tagId);
  if (!tag) return unknown(`tag ${spec.tagId} is not in the served version of ${spec.containerId} (${tags.length} tag entries): removed, or renumbered by a republish — rescan to re-map it`);
  if (tag.function === '__paused') return unknown(`tag ${spec.tagId} is paused in the served container: it does not fire, but the requirement is not set. Mark done if pausing was the decision.`);
  if (!('consent' in tag)) return fail(`tag ${spec.tagId} has no consent requirement in the served container: set "Require additional consent for tag to fire" → ${spec.consentTypes.join(', ')} and publish`);
  const c = tag.consent;
  if (!Array.isArray(c) || c[0] !== 'list') return unknown(`tag ${spec.tagId} has a consent setting in a form this parser cannot read`);
  const have = c.slice(1).filter((x): x is string => typeof x === 'string');
  const missing = spec.consentTypes.filter((t) => !have.includes(t));
  if (missing.length) return fail(`tag ${spec.tagId} requires ${have.join(', ') || 'nothing'} but not ${missing.join(', ')}`, [`consent: ${have.join(', ')}`]);
  return ok(`tag ${spec.tagId} requires ${have.join(', ')} in the served container${typeof data.resource.version === 'string' || typeof data.resource.version === 'number' ? ` (version ${String(data.resource.version)})` : ''}`, [`consent: ${have.join(', ')}`]);
}

// --- consent default ---------------------------------------------------------------------

const DEFAULT_CALL_RE = /gtag\s*\(\s*['"]consent['"]\s*,\s*['"]default['"]/;

/** A denied Consent Mode default runs before the first Google tag / GTM script: set by the installed tool (config.gtm) or by an inline snippet. */
/**
 * Consent Mode signals the tool's `google-consent-mode` adapter defaults to
 * denied when the config has no gtm section (gtag.js pasted directly): it owns
 * Consent Mode then and pushes gtag('consent','default', …) as the tool starts.
 * Mirrors GOOGLE_VENDOR_SIGNALS in client/src/adapters/google.ts.
 */
const ADAPTER_SIGNALS: Readonly<Record<string, readonly string[]>> = {
  'google.analytics': ['analytics_storage'],
  'google.ads.ccm': ['ad_storage', 'ad_user_data', 'ad_personalization'],
  'google.ads.doubleclick': ['ad_storage', 'ad_user_data', 'ad_personalization'],
};

/**
 * How the installed tool sets Google's Consent Mode default from this config:
 * 'gtm' (a gtm section: every signal denied before the container), 'adapter'
 * (no gtm section; the google-consent-mode adapter covers every expected
 * signal), or undefined (the tool does not cover them all: a pasted default is
 * needed). The same rule verifyConsentDefault applies to the deployed config.
 */
export function toolConsentDefault(config: { gtm?: unknown; vendors: ReadonlyArray<{ id: string; adapter?: string }> }, consentTypes: readonly string[]): 'gtm' | 'adapter' | undefined {
  if (config.gtm) return 'gtm';
  const covered = new Set(config.vendors.filter((v) => v.adapter === 'google-consent-mode').flatMap((v) => ADAPTER_SIGNALS[v.id] ?? []));
  return covered.size && consentTypes.every((t) => covered.has(t)) ? 'adapter' : undefined;
}

export function verifyConsentDefault(html: string, spec: { page: string; consentTypes: string[] }): VerifyOutcome {
  const bad = notHtml(html);
  if (bad) return bad;
  const elements = parseMarkup(html, spec.page);
  // A Google tag held for the tool (the rewrite task's type="text/plain" data-src form)
  // still counts: it runs once the tool releases it, so the default must come first.
  const isGoogle = (el: MarkupElement): boolean => {
    if (el.kind !== 'script' || (el.loads !== 'executes' && el.loads !== 'held')) return false;
    const u = urlParts(el.url);
    if (u.host && GOOGLE_TAG_HOST.test(u.host)) return true;
    return el.hosts.some((h) => GOOGLE_TAG_HOST.test(h)) || el.ids.some((id) => GOOGLE_ID_RE.test(id));
  };
  const firstIdx = elements.findIndex(isGoogle);
  if (firstIdx < 0) return unknown('no Google Tag Manager or gtag.js script on this page: there is no tag to set a default for here (try the page the container loads on)');
  const first = elements[firstIdx];
  const before = elements.slice(0, firstIdx);
  const configEl = before.find((el) => el.kind === 'script' && el.attributes.id === CONSENT_CONFIG_ELEMENT_ID);
  const core = before.find((el) => el.kind === 'script' && el.loads === 'executes' && /\/complykit-consent\.js$/i.test(urlParts(el.url).path ?? ''));
  if (configEl && core) {
    const cfg = configElementText(html);
    try {
      const parsed = parseConsentToolConfig(JSON.parse(cfg.text ?? ''));
      if (parsed.ok && parsed.config.gtm) return ok(`the consent tool (${where(core)}) sets the Consent Mode defaults before ${where(first)}: config.gtm lists ${parsed.config.gtm.containers.join(', ')}; unmapped signals stay denied`, [`core at line ${core.line}`, `first Google script at line ${first.line}`]);
      if (parsed.ok) {
        // No gtm section: the google-consent-mode adapter sets the default for its vendors' signals.
        const adapted = parsed.config.vendors.filter((v) => v.adapter === 'google-consent-mode');
        const covered = new Set(adapted.flatMap((v) => ADAPTER_SIGNALS[v.id] ?? []));
        const missing = spec.consentTypes.filter((t) => !covered.has(t));
        if (covered.size && !missing.length) return ok(`the consent tool (${where(core)}) sets the Consent Mode default (denied) before ${where(first)}: its google-consent-mode adapter covers ${spec.consentTypes.join(', ')} (${adapted.map((v) => v.id).join(', ')})`, [`core at line ${core.line}`, `first Google script at line ${first.line}`]);
        if (covered.size) return fail(`the consent tool's google-consent-mode adapter defaults ${[...covered].join(', ')} but not ${missing.join(', ')}: regenerate the config from a scan that sees the Google tag for it`);
        return fail(`the consent tool is installed before ${where(first)} but its config has no gtm section and no vendor on the google-consent-mode adapter, so it sets no Consent Mode default: regenerate with the container in the scan`);
      }
    } catch {
      /* fall through to the inline check */
    }
  }
  const denied = (body: string, type: string): boolean => new RegExp(`['"]?${type}['"]?\\s*:\\s*['"]denied['"]`).test(body);
  const inline = elements.filter((el) => el.kind === 'script' && el.loads === 'executes' && el.body !== undefined && DEFAULT_CALL_RE.test(el.body));
  const early = inline.filter((el) => elements.indexOf(el) < firstIdx);
  if (early.length) {
    const missing = spec.consentTypes.filter((t) => !early.some((el) => denied(el.body!, t)));
    if (!missing.length) return ok(`a gtag('consent','default') with ${spec.consentTypes.join(', ')} denied runs at ${where(early[0])}, before ${where(first)}`, [`line ${early[0].line}`]);
    return fail(`the default at ${where(early[0])} does not deny ${missing.join(', ')}`, [`line ${early[0].line}`]);
  }
  if (inline.length) return fail(`a consent default is set at ${where(inline[0])}, AFTER the first Google script (${where(first)}): Google treats a type set late as granted meanwhile`, [`line ${inline[0].line}`]);
  return fail(`no denied Consent Mode default before the first Google script (${where(first)}): install the consent tool above it, or add the default snippet`);
}

// --- existing consent tool -----------------------------------------------------------------

export interface RemoveExistingToolExpectation {
  page: string;
  partyId?: string;
  hosts?: string[];
  pathPattern?: string;
  label: string;
}

/** Nothing of the previous consent tool is loaded by this page any more. */
export function verifyRemoveExistingTool(html: string, spec: RemoveExistingToolExpectation, opts: VerifyOptions = {}): VerifyOutcome {
  const bad = notHtml(html);
  if (bad) return bad;
  const kb = opts.kb ?? DEFAULT_KB;
  const site = siteOf(spec.page, opts);
  const hosts = (spec.hosts ?? []).map((h) => h.toLowerCase());
  const hostHit = (h: string | undefined): boolean => !!h && hosts.some((x) => h === x || h.endsWith(`.${x}`));
  let pattern: RegExp | undefined;
  if (spec.pathPattern) {
    try {
      pattern = new RegExp(spec.pathPattern, 'i');
    } catch {
      return unknown(`the plugin path pattern is not a valid expression: ${spec.pathPattern}`);
    }
  }
  const hits: MarkupElement[] = [];
  for (const el of parseMarkup(html, spec.page)) {
    if (el.loads === 'inert') continue;
    const u = urlParts(el.url);
    if (hostHit(u.host) || (pattern && el.url && pattern.test(el.url)) || el.hosts.some(hostHit)) {
      hits.push(el);
      continue;
    }
    if (spec.partyId && matchMarkupElement(el, kb, { registrableDomain: site }).some((m) => m.partyId === spec.partyId)) hits.push(el);
  }
  if (hits.length) return fail(`${spec.label} is still loaded by this page (${hits.slice(0, 4).map(where).join(', ')}${hits.length > 4 ? ', …' : ''}): two consent tools means two banners and two sources of truth`, hits.map((e) => `line ${e.line}: ${short(e.url ?? 'inline script')}`));
  return ok(`nothing of ${spec.label} is loaded by this page's served HTML`);
}

// --- browser spot check: the judge -----------------------------------------------------------

export interface SpotCheckSpec {
  page: string;
  partyId: string;
  hosts: string[];
}

/**
 * Judge one page's reject-then-accept observation for one vendor. Pass only when
 * NOTHING went to the vendor's hosts after the reject AND something did after
 * the accept (so the vendor is still on the page and the tool is what holds it).
 */
export function judgeSpotCheck(spec: SpotCheckSpec, obs: SpotCheckObservation): VerifyOutcome {
  const hosts = spec.hosts.map((h) => h.toLowerCase());
  const hit = (url: string): boolean => {
    const h = hostOf(url).toLowerCase();
    return hosts.some((x) => h === x || h.endsWith(`.${x}`));
  };
  if (obs.toolPresent === false) return unknown('complykit’s consent tool was not on the page: install it first (the platform bridge and the adapters are what pass the choice on)');
  const reject = obs.phases.find((p) => p.scenario === 'reject');
  if (!reject) return unknown('no reject phase was observed');
  if (!reject.choiceMade) return unknown('the reject choice could not be made on this page (no banner found, or the control did not respond): nothing is established');
  const after = reject.requests.filter((r) => hit(r.url));
  if (after.length) return fail(`${after.length} request${after.length === 1 ? '' : 's'} to ${spec.hosts.join(', ')} after the reject: the change does not hold it`, after.slice(0, 5).map((r) => short(r.url)));
  const accept = obs.phases.find((p) => p.scenario === 'accept');
  if (!accept || !accept.choiceMade) return unknown('nothing went to the vendor after the reject, but the accept visit was not made: holding nothing proves nothing — the vendor may simply be gone from this page');
  const granted = accept.requests.filter((r) => hit(r.url));
  if (!granted.length) return unknown('nothing went to the vendor after the reject OR after the accept: it is not on this page any more (or loads only elsewhere), so the check cannot tell whether the change holds it');
  return ok(`held after the reject (0 requests to ${spec.hosts.join(', ')}), ran after the accept (${granted.length} request${granted.length === 1 ? '' : 's'}) — on this page, this visit`, granted.slice(0, 3).map((r) => short(r.url)));
}

// --- dispatcher -----------------------------------------------------------------------------

export interface StaticVerifyInput {
  /** The served HTML of spec.page (static checks). */
  html?: string;
  /** The served container file (gtm-tag-consent). */
  containerJs?: string;
  /** A browser observation (spot-check), when R4 has run one. */
  observation?: SpotCheckObservation;
}

/** Run the checker a spec names over what was fetched. Browser specs need an observation; manual ones are never decided here. */
export function runVerify(spec: RemediationVerifySpec, input: StaticVerifyInput, opts: VerifyOptions = {}): VerifyOutcome {
  switch (spec.check) {
    case 'install':
      return input.html === undefined ? unknown('the page was not fetched') : verifyInstall(input.html, spec, opts);
    case 'rewrite-tag':
      return input.html === undefined ? unknown('the page was not fetched') : verifyRewriteTag(input.html, spec);
    case 'remove-leak':
      return input.html === undefined ? unknown('the page was not fetched') : verifyRemoveLeak(input.html, spec);
    case 'consent-default':
      return input.html === undefined ? unknown('the page was not fetched') : verifyConsentDefault(input.html, spec);
    case 'remove-existing-tool':
      return input.html === undefined ? unknown('the page was not fetched') : verifyRemoveExistingTool(input.html, spec, opts);
    case 'gtm-tag-consent':
      return input.containerJs === undefined ? unknown('the container was not fetched') : verifyGtmTagConsent(input.containerJs, spec);
    case 'spot-check':
      return input.observation ? judgeSpotCheck(spec, input.observation) : unknown('a browser spot check is needed: reject, then accept, on one page');
    case 'manual':
      return unknown(`cannot be checked from outside: ${spec.reason}`);
  }
}
