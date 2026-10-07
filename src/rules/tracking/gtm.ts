import type { ContainerCapture, TagContainer, ContainerTag, TagConsentStatus } from '../../record/index.js';
import { DEFAULT_KB, entriesForText, hostsInText, hostOf, lookupEntry, matchVendorSignatures, type KnowledgeBase, type KnowledgeEntry } from '../../registry/index.js';

// Google Tag Manager container parser (plans/client-consent-design.md §3 #3,
// §5 item 1; ticket A2). `gtm.js?id=GTM-…` and `gtag/js?id=G-…` are public
// files that embed the container's runtime data as a JSON literal:
//
//   var data = { "resource": { "version", "macros", "tags", "predicates",
//                "rules" }, "runtime": [...], "permissions": {...},
//                "sandboxed_scripts": [...], ... };
//
//   tags[i]        — one tag: `function` is the template id (`__gaawe` = GA4
//                    event, `__html` = Custom HTML, `__cvt_<id>` = a sandboxed
//                    gallery/custom template), `vtp_*` are its parameters,
//                    `tag_id` is the number the GTM UI shows, and `consent` —
//                    present only when the owner set "require additional
//                    consent" — is `["list", "ad_storage", …]`.
//   predicates[j]  — `{function: "_eq"|"_cn"|"_re"|…, arg0, arg1}`; args are
//                    literals or `["macro", k]` references.
//   rules[r]       — `[["if", j…], ["unless", j…], ["add", i…], ["block", i…]]`:
//                    when every `if` predicate holds and no `unless` does, the
//                    `add` tags fire and the `block` tags are held. One UI
//                    trigger folds into one rule; a tag with several triggers
//                    appears in several rules.
//   macros[k]      — variables (`__e` = event name, `__u` = page URL parts,
//                    `__v` = a dataLayer key, …).
//   permissions    — per sandboxed template: which hosts it may inject scripts
//                    from or send pixels to, which consent types it may read.
//
// The format is undocumented and minified; everything here is read from the
// data literal, never from the runtime code that follows it. Pure: no network,
// no browser. Fail closed — a container that cannot be read is reported as
// `unreadable` with no tags, never as "nothing fires without consent".

// --- Template tables ----------------------------------------------------------

interface TemplateInfo {
  label: string;
  kind: ContainerTag['kind'];
  /** KB entry id, or a function of the tag's identifiers (Google tags vary by id prefix). */
  party?: string | 'by-id';
  /** Consent types a built-in Consent Mode check reads (Google templates only). */
  builtIn?: string[];
}

// Built-in consent checks per Google's Consent Mode documentation: Google Ads
// templates read ad_storage / ad_user_data / ad_personalization, Analytics
// reads analytics_storage, Floodlight and the Conversion Linker read
// ad_storage. The Google tag carries all four. A built-in check never holds a
// tag back; it changes what the tag sends.
const ADS = ['ad_storage', 'ad_user_data', 'ad_personalization'];
const GOOGLE_ALL = ['ad_storage', 'analytics_storage', 'ad_user_data', 'ad_personalization'];

const TEMPLATES: Record<string, TemplateInfo> = {
  // Google
  __googtag: { label: 'Google tag', kind: 'tag', party: 'by-id', builtIn: GOOGLE_ALL },
  __gaawe: { label: 'GA4 event', kind: 'tag', party: 'google.analytics', builtIn: ['analytics_storage'] },
  __gaawc: { label: 'GA4 configuration', kind: 'tag', party: 'google.analytics', builtIn: ['analytics_storage'] },
  __ua: { label: 'Universal Analytics', kind: 'tag', party: 'google.analytics', builtIn: ['analytics_storage'] },
  __awct: { label: 'Google Ads conversion tracking', kind: 'tag', party: 'google.ads.ccm', builtIn: ADS },
  __sp: { label: 'Google Ads remarketing', kind: 'tag', party: 'google.ads.ccm', builtIn: ADS },
  __gclidw: { label: 'Conversion linker', kind: 'tag', party: 'google.ads.ccm', builtIn: ['ad_storage'] },
  __flc: { label: 'Floodlight counter', kind: 'tag', party: 'google.ads.doubleclick', builtIn: ['ad_storage'] },
  __fls: { label: 'Floodlight sales', kind: 'tag', party: 'google.ads.doubleclick', builtIn: ['ad_storage'] },
  __opt: { label: 'Google Optimize', kind: 'tag', party: 'google.analytics' },
  // The Google tag's own parts inside gtag.js: destinations send; config registers.
  __dest_ga: { label: 'GA4 destination', kind: 'tag', party: 'by-id', builtIn: GOOGLE_ALL },
  __dest_aw: { label: 'Google Ads destination', kind: 'tag', party: 'by-id', builtIn: GOOGLE_ALL },
  __dest_dc: { label: 'Floodlight destination', kind: 'tag', party: 'by-id', builtIn: GOOGLE_ALL },
  __dest_gtm: { label: 'Tag Manager destination', kind: 'tag', party: 'by-id', builtIn: GOOGLE_ALL },
  __zone: { label: 'Zone (loads another container)', kind: 'tag', party: 'google.tag-manager' },
  // Custom
  __html: { label: 'Custom HTML', kind: 'tag' },
  __img: { label: 'Custom image', kind: 'tag' },
  // Third-party templates built into GTM
  __baut: { label: 'Microsoft Advertising UET', kind: 'tag', party: 'microsoft.uet' },
  __bzi: { label: 'LinkedIn Insight', kind: 'tag', party: 'linkedin.insight' },
  __hjtc: { label: 'Hotjar', kind: 'tag', party: 'hotjar' },
  __pntr: { label: 'Pinterest tag', kind: 'tag', party: 'pinterest.tag' },
  __crto: { label: 'Criteo OneTag', kind: 'tag', party: 'criteo' },
  __twitter_website_tag: { label: 'X (Twitter) pixel', kind: 'tag', party: 'x.pixel' },
  __qpx: { label: 'Quora pixel', kind: 'tag' },
  __cegg: { label: 'Crazy Egg', kind: 'tag' },
  __adroll: { label: 'AdRoll', kind: 'tag' },
  // Listeners GTM installs to drive triggers — they send nothing themselves.
  __cl: { label: 'Click listener', kind: 'helper' },
  __lcl: { label: 'Link click listener', kind: 'helper' },
  __fsl: { label: 'Form submit listener', kind: 'helper' },
  __evl: { label: 'Element visibility listener', kind: 'helper' },
  __tl: { label: 'Timer', kind: 'helper' },
  __jel: { label: 'JavaScript error listener', kind: 'helper' },
  __hl: { label: 'History listener', kind: 'helper' },
  __sdl: { label: 'Scroll depth listener', kind: 'helper' },
  __ytl: { label: 'YouTube video listener', kind: 'helper' },
  __tg: { label: 'Trigger group', kind: 'helper' },
  __paused: { label: 'Paused tag', kind: 'helper' },
};

// gtag.js destination settings (the Google tag's own configuration, exported as
// tags with `__ogt_*` / `__ccd_*` ids). Named where the setting matters to a
// privacy reader; the rest are humanised from the id.
const SETTING_LABELS: Record<string, string> = {
  __ogt_auto_events: 'Enhanced measurement',
  __ogt_1p_data_v2: 'User-provided data collection (automatic)',
  __ogt_1p_data: 'User-provided data collection',
  __ogt_google_signals: 'Google signals',
  __ogt_cross_domain: 'Cross-domain measurement',
  __ogt_ip_redaction: 'IP redaction',
  __ogt_conversion_linker: 'Conversion linker',
  __ogt_referral_exclusion: 'Referral exclusion',
  __ogt_session_timeout: 'Session timeout',
  __ogt_dma: 'Digital Markets Act consent signals',
  __ccd_auto_redact: 'Redact email in URLs',
  __ccd_conversion_marking: 'Key events',
  __ccd_ga_regscope: 'Regional data redaction',
  __ccd_em_download: 'Enhanced measurement: file downloads',
  __ccd_em_form: 'Enhanced measurement: form interactions',
  __ccd_em_outbound_click: 'Enhanced measurement: outbound clicks',
  __ccd_em_page_view: 'Enhanced measurement: page views',
  __ccd_em_scroll: 'Enhanced measurement: scrolls',
  __ccd_em_site_search: 'Enhanced measurement: site search',
  __ccd_em_video: 'Enhanced measurement: video engagement',
  __ccd_cross_domain: 'Cross-domain measurement',
  __ccd_ga_ads_link: 'Google Ads link',
  __set_product_settings: 'Product settings',
  __gct: 'Google tag configuration',
  __rep: 'Destination registration',
};
const SETTING_TEMPLATES = new Set(['__set_product_settings', '__gct', '__rep']);

const EVENT_LABELS: Record<string, string> = {
  'gtm.init_consent': 'Consent Initialization',
  'gtm.init': 'Initialization',
  'gtm.js': 'Page View',
  'gtm.dom': 'DOM Ready',
  'gtm.load': 'Window Loaded',
  'gtm.click': 'Click',
  'gtm.linkClick': 'Link Click',
  'gtm.formSubmit': 'Form Submission',
  'gtm.scrollDepth': 'Scroll Depth',
  'gtm.timer': 'Timer',
  'gtm.historyChange': 'History Change',
  'gtm.elementVisibility': 'Element Visibility',
  'gtm.video': 'YouTube Video',
  'gtm.jsError': 'JavaScript Error',
  'gtm.triggerGroup': 'Trigger Group',
};
const PAGE_LOAD_EVENTS = new Set(['gtm.init_consent', 'gtm.init', 'gtm.js', 'gtm.dom', 'gtm.load']);

const PREDICATE_OPS: Record<string, string> = {
  _eq: 'equals',
  _cn: 'contains',
  _sw: 'starts with',
  _ew: 'ends with',
  _re: 'matches regex',
  _gt: 'is greater than',
  _ge: 'is at least',
  _lt: 'is less than',
  _le: 'is at most',
  _css: 'matches CSS selector',
  _lc: 'list contains',
};

// Parameter keys that carry the account / property / pixel id a tag is configured for.
const ID_KEYS = [
  'vtp_tagId',
  'vtp_measurementId',
  'vtp_measurementIdOverride',
  'vtp_trackingId',
  'vtp_conversionId',
  'vtp_pixelId',
  'vtp_projectId',
  'vtp_advertiserId',
  'vtp_partnerId',
  'vtp_uetTagId',
  'vtp_instanceDestinationId',
  'vtp_hotjarId',
  'vtp_siteId',
  'vtp_accountId',
  'vtp_childContainer',
  'vtp_destinationId',
  'vtp_containerId',
];
const NOT_ID_KEYS = new Set(['vtp_uniqueTriggerId', 'vtp_enableUserId']);

// --- Extraction ------------------------------------------------------------------

export interface ContainerData {
  resource: {
    version?: unknown;
    macros: unknown[];
    tags: unknown[];
    predicates: unknown[];
    rules: unknown[];
  };
  runtime?: unknown[];
  permissions?: Record<string, Record<string, unknown>>;
  sandboxed_scripts?: string[];
}

const MAX_SOURCE_BYTES = 8 * 1024 * 1024;

/**
 * Where the `var data = {…}` literal sits in a gtm.js / gtag.js body. Brace
 * matching honours string literals (Custom HTML bodies are full of braces).
 * Returns a reason instead of a span for anything that is not a container.
 */
export function locateContainerData(source: string): { start: number; end: number; reason?: undefined } | { reason: string; start?: undefined; end?: undefined } {
  if (typeof source !== 'string' || !source.trim()) return { reason: 'empty response' };
  if (source.length > MAX_SOURCE_BYTES) return { reason: `response too large to parse (${source.length} bytes)` };
  const m = /\bvar\s+data\s*=\s*\{/.exec(source);
  if (!m) {
    const looksHtml = /^\s*<(!doctype|html)/i.test(source);
    return { reason: looksHtml ? 'response was an HTML page, not a container (blocked or redirected?)' : 'no container data literal found' };
  }
  const start = m.index + m[0].length - 1;
  let depth = 0;
  let inStr = false;
  let esc = false;
  let end = -1;
  for (let k = start; k < source.length; k++) {
    const c = source[k];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === '{' || c === '[') depth++;
    else if (c === '}' || c === ']') {
      depth--;
      if (depth === 0) {
        end = k + 1;
        break;
      }
    }
  }
  if (end < 0) return { reason: 'container data literal is unterminated' };
  return { start, end };
}

/** Pull the container data out of a gtm.js / gtag.js body; a reason instead of data for anything that is not one. */
export function extractContainerData(source: string): { data?: ContainerData; reason?: string } {
  const at = locateContainerData(source);
  if (at.reason !== undefined) return { reason: at.reason };
  let parsed: unknown;
  try {
    parsed = JSON.parse(source.slice(at.start, at.end));
  } catch (err) {
    return { reason: `container data is not JSON: ${err instanceof Error ? err.message.slice(0, 80) : 'parse error'}` };
  }
  if (!isRecord(parsed) || !isRecord(parsed.resource)) return { reason: 'container data has no resource block' };
  const r = parsed.resource;
  for (const key of ['tags', 'predicates', 'rules'] as const) {
    if (!Array.isArray(r[key])) return { reason: `resource.${key} is missing or not a list` };
  }
  return {
    data: {
      resource: {
        version: r.version,
        macros: Array.isArray(r.macros) ? r.macros : [],
        tags: r.tags as unknown[],
        predicates: r.predicates as unknown[],
        rules: r.rules as unknown[],
      },
      runtime: Array.isArray(parsed.runtime) ? parsed.runtime : undefined,
      permissions: isRecord(parsed.permissions) ? (parsed.permissions as Record<string, Record<string, unknown>>) : undefined,
      sandboxed_scripts: Array.isArray(parsed.sandboxed_scripts) ? parsed.sandboxed_scripts.filter((s): s is string => typeof s === 'string') : undefined,
    },
  };
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

// --- Rewriting (local-copy mode) -----------------------------------------------------

export interface ContainerConsentRewrite {
  /** Consent types to require per tag, by the `tag_id` the GTM UI shows. */
  tags?: Record<string, string[]>;
  /** Consent types to require on every tag of a template (`__gaawe`, `__googtag`, …). */
  templates?: Record<string, string[]>;
}

export interface ContainerConsentRewriteResult {
  /** The container with the requirements added; undefined when nothing could be changed safely. */
  source?: string;
  /** Tags whose consent list now carries the requirement (ids the UI shows). */
  rewritten: number[];
  /** Tags that already required everything asked. */
  unchanged: number[];
  /** Requested tag ids not in the container. */
  missing: string[];
  /** Tags skipped because their consent setting is in a form this parser cannot read (left as served). */
  skipped: number[];
  /** Why no rewrite was made (not a container, no JSON round trip, nothing asked). */
  reason?: string;
}

const CONSENT_TYPE = /^[a-z][a-z0-9_]{2,40}$/;

/**
 * Simulate the owner's GTM-side change — "Require additional consent for tag to
 * fire" — on a fetched container, the way the published container would then
 * encode it: `"consent": ["list", <types…>]` on the tag entry. For the scanner's
 * local-copy mode only (no container is ever published from here). Fails closed:
 * the data literal must parse as JSON and parse again after the edit with the
 * same tag count, or the source comes back unchanged with a reason.
 */
export function rewriteContainerConsent(source: string, spec: ContainerConsentRewrite): ContainerConsentRewriteResult {
  const none: ContainerConsentRewriteResult = { rewritten: [], unchanged: [], missing: [], skipped: [] };
  const byTag = new Map<string, string[]>();
  for (const [id, types] of Object.entries(spec.tags ?? {})) byTag.set(String(id), types);
  const byTemplate = new Map<string, string[]>(Object.entries(spec.templates ?? {}));
  const bad = [...byTag.values(), ...byTemplate.values()].flat().filter((t) => !CONSENT_TYPE.test(t));
  if (bad.length) return { ...none, reason: `not a consent type: ${[...new Set(bad)].join(', ')}` };
  if (!byTag.size && !byTemplate.size) return { ...none, reason: 'nothing to require' };
  const at = locateContainerData(source);
  if (at.reason !== undefined) return { ...none, reason: at.reason };
  let parsed: unknown;
  try {
    parsed = JSON.parse(source.slice(at.start, at.end));
  } catch {
    return { ...none, reason: 'container data is not JSON' };
  }
  if (!isRecord(parsed) || !isRecord(parsed.resource) || !Array.isArray(parsed.resource.tags)) return { ...none, reason: 'container data has no tag list' };
  const tags = parsed.resource.tags;
  const seen = new Set<string>();
  const out: ContainerConsentRewriteResult = { rewritten: [], unchanged: [], missing: [], skipped: [] };
  for (const raw of tags) {
    if (!isRecord(raw) || typeof raw.function !== 'string') continue;
    const tagId = typeof raw.tag_id === 'number' ? raw.tag_id : undefined;
    const want = [...(tagId !== undefined ? byTag.get(String(tagId)) ?? [] : []), ...(byTemplate.get(raw.function) ?? [])];
    if (tagId !== undefined) seen.add(String(tagId));
    if (!want.length || tagId === undefined) continue;
    let have: string[] = [];
    if ('consent' in raw) {
      const c = raw.consent;
      if (Array.isArray(c) && c[0] === 'list' && c.slice(1).every((x) => typeof x === 'string')) have = c.slice(1) as string[];
      else {
        out.skipped.push(tagId);
        continue;
      }
    }
    const merged = [...new Set([...have, ...want])];
    if (merged.length === have.length) {
      out.unchanged.push(tagId);
      continue;
    }
    raw.consent = ['list', ...merged];
    out.rewritten.push(tagId);
  }
  out.missing = [...byTag.keys()].filter((id) => !seen.has(id));
  if (!out.rewritten.length) return { ...out, reason: out.skipped.length ? 'every requested tag has an unreadable consent setting' : 'no tag needed a change' };
  const next = source.slice(0, at.start) + JSON.stringify(parsed) + source.slice(at.end);
  // The edited container must still read as the same container.
  const check = extractContainerData(next);
  if (!check.data || check.data.resource.tags.length !== tags.length) return { ...none, missing: out.missing, reason: `the edited container does not read back (${check.reason ?? 'tag count changed'})` };
  return { ...out, source: next };
}

// --- Value resolution ----------------------------------------------------------------

type Macro = Record<string, unknown>;

/** Human name of variable k, the way the GTM UI would label it. */
function macroLabel(macros: unknown[], k: number): string {
  const m = macros[k];
  if (!isRecord(m)) return `variable ${k}`;
  const fn = typeof m.function === 'string' ? m.function : '';
  const name = typeof m.vtp_name === 'string' ? m.vtp_name : undefined;
  switch (fn) {
    case '__e':
      return 'event';
    case '__u': {
      const c = typeof m.vtp_component === 'string' ? m.vtp_component.toLowerCase() : 'url';
      if (c === 'query' && typeof m.vtp_queryKey === 'string') return `query param ${m.vtp_queryKey}`;
      return c === 'host' ? 'page hostname' : `page ${c}`;
    }
    case '__f':
      return 'referrer';
    case '__v': {
      if (!name) return 'dataLayer variable';
      // GTM's built-in click/form variables carry gtm.* keys; label them as the UI does.
      const builtIn = /^gtm\.element(Url|Target|Classes|Id|Text)?$/.exec(name);
      if (builtIn) return `click ${(builtIn[1] ?? 'element').toLowerCase()}`;
      return `dataLayer.${name}`;
    }
    case '__aev': {
      const t = typeof m.vtp_varType === 'string' ? m.vtp_varType.toLowerCase() : 'element';
      return t === 'attribute' && typeof m.vtp_attribute === 'string' ? `clicked element attribute ${m.vtp_attribute}` : `clicked element ${t}`;
    }
    case '__k':
      return name ? `cookie ${name}` : 'cookie';
    case '__j':
      return name ? `js ${name}` : 'JavaScript variable';
    case '__c':
      return typeof m.vtp_value === 'string' ? `"${m.vtp_value}"` : typeof m.vtp_value === 'number' || typeof m.vtp_value === 'boolean' ? String(m.vtp_value) : 'constant';
    case '__actids':
      return 'active destination ids';
    case '__jsm':
      return 'custom JavaScript variable';
    case '__smm':
      return 'lookup table';
    case '__remm':
      return 'regex table';
    case '__d':
      return 'DOM element';
    case '__cid':
      return 'container id';
    case '__ctv':
      return 'container version';
    case '__dbg':
      return 'debug mode';
    case '__r':
      return 'random number';
    case '__hid':
      return 'HTML id';
    case '__uv':
      return 'undefined';
    case '__gas':
      return 'GA settings';
    case '__gtes':
      return 'event settings';
    case '__gtcs':
      return 'config settings';
    case '__awec':
      return 'user-provided data';
    case '__analytics_storage':
      return typeof m.vtp_dataField === 'string' ? `GA ${m.vtp_dataField}` : 'GA storage';
    default:
      if (fn.startsWith('__cvt_')) return 'custom variable template';
      return fn ? fn.replace(/^__/, '') : `variable ${k}`;
  }
}

/** Resolve a parameter expression to a plain value; macro refs render as {{name}}. */
function resolve(macros: unknown[], v: unknown, depth = 0): unknown {
  if (depth > 6) return undefined;
  if (!Array.isArray(v)) return v;
  const [op, ...rest] = v;
  switch (op) {
    case 'macro': {
      if (typeof rest[0] !== 'number') return '{{variable}}';
      // A constant variable resolves to its value (the UI shows the value too).
      const m = macros[rest[0]];
      if (isRecord(m) && m.function === '__c' && (typeof m.vtp_value === 'string' || typeof m.vtp_value === 'number' || typeof m.vtp_value === 'boolean')) return m.vtp_value;
      return `{{${macroLabel(macros, rest[0])}}}`;
    }
    case 'list':
      return rest.map((x) => resolve(macros, x, depth + 1));
    case 'map': {
      const out: Record<string, unknown> = {};
      for (let i = 0; i + 1 < rest.length; i += 2) out[String(resolve(macros, rest[i], depth + 1))] = resolve(macros, rest[i + 1], depth + 1);
      return out;
    }
    case 'escape':
      return resolve(macros, rest[0], depth + 1);
    case 'template':
      return rest.map((x) => String(resolve(macros, x, depth + 1) ?? '')).join('');
    default:
      return undefined;
  }
}

function asString(v: unknown): string | undefined {
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  return undefined;
}

function eventLabel(ev: string): string {
  const l = EVENT_LABELS[ev];
  return l ? `${l} (${ev})` : ev;
}

// --- Predicates and rules --------------------------------------------------------------------

interface Condition {
  text: string;
  event?: string; // when the predicate pins the event name with _eq
}

const TRIGGER_ID_RE = /\(\^\$\|\(\(\^\|,\)(\d+)_(\d+)\(\$\|,\)\)\)/;

function describePredicate(macros: unknown[], predicates: unknown[], j: number): Condition {
  const p = predicates[j];
  if (!isRecord(p)) return { text: `predicate ${j} (unreadable)` };
  const fn = typeof p.function === 'string' ? p.function : '?';
  const negate = p.negate === true;
  const left = resolve(macros, p.arg0);
  const right = resolve(macros, p.arg1);
  const leftText = typeof left === 'string' && left.startsWith('{{') ? left.slice(2, -2) : JSON.stringify(left);
  const rightRaw = asString(right) ?? JSON.stringify(right);
  const isEvent = leftText === 'event';
  // The hidden trigger-id predicate: `gtm.triggers` matches `(^$|((^|,)<container>_<n>($|,)))`.
  if (fn === '_re' && leftText === 'dataLayer.gtm.triggers' && typeof right === 'string') {
    const m = TRIGGER_ID_RE.exec(right);
    if (m) return { text: `${negate ? 'not ' : ''}trigger #${m[2]} fired` };
  }
  if (isEvent && fn === '_eq' && typeof right === 'string') {
    return { text: `event ${negate ? 'is not' : 'is'} ${eventLabel(right)}`, event: negate ? undefined : right };
  }
  const op = PREDICATE_OPS[fn] ?? fn;
  const rightText = typeof right === 'string' && right.startsWith('{{') ? right.slice(2, -2) : rightRaw;
  const text = `${leftText} ${negate ? `does not ${op.replace(/^is /, '')}` : op} ${rightText}`;
  return { text: text.length > 160 ? `${text.slice(0, 157)}…` : text };
}

interface RuleView {
  text: string;
  events: string[]; // events pinned by `if` predicates ('*' when none)
  add: number[];
  block: number[];
  ok: boolean;
}

function describeRule(macros: unknown[], predicates: unknown[], rule: unknown, warnings: string[], r: number): RuleView {
  const view: RuleView = { text: '', events: [], add: [], block: [], ok: true };
  if (!Array.isArray(rule)) {
    warnings.push(`rule ${r} is not a list`);
    return { ...view, text: `rule ${r} (unreadable)`, ok: false };
  }
  const ifs: Condition[] = [];
  const unless: Condition[] = [];
  for (const part of rule) {
    if (!Array.isArray(part) || typeof part[0] !== 'string') {
      warnings.push(`rule ${r} has an unreadable clause`);
      view.ok = false;
      continue;
    }
    const [op, ...idx] = part as [string, ...unknown[]];
    const ints = idx.filter((x): x is number => typeof x === 'number' && Number.isInteger(x));
    if (ints.length !== idx.length) {
      warnings.push(`rule ${r}: ${op} clause has a non-integer reference`);
      view.ok = false;
    }
    switch (op) {
      case 'if':
        for (const j of ints) {
          if (j < 0 || j >= predicates.length) {
            warnings.push(`rule ${r}: predicate ${j} out of range`);
            view.ok = false;
            continue;
          }
          ifs.push(describePredicate(macros, predicates, j));
        }
        break;
      case 'unless':
        for (const j of ints) {
          if (j < 0 || j >= predicates.length) {
            warnings.push(`rule ${r}: predicate ${j} out of range`);
            view.ok = false;
            continue;
          }
          unless.push(describePredicate(macros, predicates, j));
        }
        break;
      case 'add':
        view.add.push(...ints);
        break;
      case 'block':
        view.block.push(...ints);
        break;
      default:
        warnings.push(`rule ${r}: unknown clause "${op}"`);
        view.ok = false;
    }
  }
  const parts = ifs.map((c) => c.text);
  if (unless.length) parts.push(`not (${unless.map((c) => c.text).join(' or ')})`);
  view.text = parts.length ? parts.join(' and ') : 'always';
  const pinned = ifs.map((c) => c.event).filter((e): e is string => Boolean(e));
  view.events = pinned.length ? [...new Set(pinned)] : ['*'];
  return view;
}

// --- Template code inspection (sandboxed templates) ----------------------------------------------

interface TemplateCode {
  text: string; // the runtime entry, serialised
  readsConsent: boolean;
  setsDefaults: boolean;
  updatesConsent: boolean;
}

function templateCode(data: ContainerData): Map<string, TemplateCode> {
  const out = new Map<string, TemplateCode>();
  for (const entry of data.runtime ?? []) {
    if (!Array.isArray(entry) || typeof entry[1] !== 'string') continue;
    const name = entry[1];
    let text = '';
    try {
      text = JSON.stringify(entry);
    } catch {
      continue;
    }
    out.set(name, {
      text,
      readsConsent: /\["require","(isConsentGranted|addConsentListener)"\]/.test(text),
      setsDefaults: /\["require","setDefaultConsentState"\]/.test(text),
      updatesConsent: /\["require","updateConsentState"\]/.test(text),
    });
  }
  return out;
}

/** Hosts a sandboxed template is permitted to load from / send to. */
function permittedHosts(perm: Record<string, unknown> | undefined): string[] {
  if (!perm) return [];
  const out = new Set<string>();
  for (const key of ['inject_script', 'send_pixel', 'inject_hidden_iframe', 'get_cookies']) {
    const p = perm[key];
    if (!isRecord(p) || !Array.isArray(p.urls)) continue;
    for (const u of p.urls) {
      if (typeof u !== 'string') continue;
      const h = hostOf(u.replace(/\*/g, 'x'));
      if (h) out.add(h.replace(/^x\./, ''));
    }
  }
  return [...out];
}

function consentPermission(perm: Record<string, unknown> | undefined): string[] {
  const p = perm?.access_consent;
  if (!isRecord(p) || !Array.isArray(p.consentTypes)) return [];
  return p.consentTypes.map((c) => (isRecord(c) && typeof c.consentType === 'string' ? c.consentType : undefined)).filter((x): x is string => Boolean(x));
}

// --- Party mapping ---------------------------------------------------------------------------

function partyForGoogleId(id: string | undefined): string | undefined {
  if (!id || id.startsWith('{{')) return undefined;
  if (/^(G|UA)-/.test(id)) return 'google.analytics';
  if (/^AW-/.test(id)) return 'google.ads.ccm';
  if (/^DC-/.test(id)) return 'google.ads.doubleclick';
  if (/^GT(M)?-/.test(id)) return 'google.tag-manager';
  return undefined;
}

function entryById(kb: KnowledgeBase, id: string | undefined): KnowledgeEntry | undefined {
  return id ? kb.entries.find((e) => e.id === id) : undefined;
}

function firstEntryForHosts(kb: KnowledgeBase, hosts: string[]): KnowledgeEntry | undefined {
  for (const h of hosts) {
    const e = lookupEntry(kb, h);
    if (e) return e;
  }
  return undefined;
}

function humanise(fn: string): string {
  return fn
    .replace(/^__(ogt|ccd)_/, '')
    .replace(/^__/, '')
    .replace(/_/g, ' ')
    .replace(/\bv2\b/, '')
    .trim();
}

// --- The parser -----------------------------------------------------------------------------

export interface ParseContainerOptions {
  kb?: KnowledgeBase;
}

/**
 * Parse one fetched container into the record shape. A capture whose fetch
 * failed, or whose body is not a container this parser understands, comes back
 * with no tags and a reason — never with a consent claim.
 */
export function parseGtmContainer(capture: ContainerCapture, opts: ParseContainerOptions = {}): TagContainer {
  const kb = opts.kb ?? DEFAULT_KB;
  const base = {
    id: capture.id,
    kind: capture.kind,
    url: capture.url,
    fetchedAt: capture.fetchedAt,
    locationId: capture.locationId,
    seenOn: capture.seenOn ?? [],
    evidencePath: capture.evidencePath,
  };
  if (capture.status !== 'ok' || typeof capture.source !== 'string') {
    return { ...base, status: 'not-fetched', reason: capture.error ?? `fetch failed${capture.httpStatus ? ` (HTTP ${capture.httpStatus})` : ''}`, tags: [], unmappedTemplates: [], warnings: [] };
  }
  const { data, reason } = extractContainerData(capture.source);
  if (!data) return { ...base, status: 'unreadable', reason, tags: [], unmappedTemplates: [], warnings: [] };

  const warnings: string[] = [];
  const { macros, tags, predicates, rules } = data.resource;
  const code = templateCode(data);
  const sandboxed = new Set(data.sandboxed_scripts ?? []);

  // Rules first: which rules add / block each tag.
  const views = rules.map((rule, r) => describeRule(macros, predicates, rule, warnings, r));
  const addsFor = new Map<number, RuleView[]>();
  const blocksFor = new Map<number, RuleView[]>();
  views.forEach((v) => {
    for (const i of v.add) {
      if (i < 0 || i >= tags.length) {
        warnings.push(`a rule adds tag ${i}, which does not exist`);
        continue;
      }
      addsFor.set(i, [...(addsFor.get(i) ?? []), v]);
    }
    for (const i of v.block) {
      if (i < 0 || i >= tags.length) {
        warnings.push(`a rule blocks tag ${i}, which does not exist`);
        continue;
      }
      blocksFor.set(i, [...(blocksFor.get(i) ?? []), v]);
    }
  });

  const out: ContainerTag[] = [];
  const unmapped = new Set<string>();
  const defaultsSetBy: string[] = [];
  const updatedBy: string[] = [];
  let initTrigger = false;

  tags.forEach((raw, index) => {
    if (!isRecord(raw) || typeof raw.function !== 'string') {
      warnings.push(`tag ${index} is unreadable`);
      out.push(unreadableTag(index));
      return;
    }
    const fn = raw.function;
    const custom = fn.startsWith('__cvt_') || sandboxed.has(fn);
    const isSetting = capture.kind === 'gtag' && (fn.startsWith('__ogt_') || fn.startsWith('__ccd_') || SETTING_TEMPLATES.has(fn));
    const info: TemplateInfo | undefined = TEMPLATES[fn];
    const kind: ContainerTag['kind'] = isSetting ? 'setting' : info?.kind ?? 'tag';
    const templateLabel = isSetting ? SETTING_LABELS[fn] ?? humanise(fn) : info?.label ?? (custom ? 'Custom template' : humanise(fn));
    const tagId = typeof raw.tag_id === 'number' ? raw.tag_id : -1;

    // Parameters: identifiers and scalar settings.
    const identifiers: string[] = [];
    for (const key of ID_KEYS) {
      const v = asString(resolve(macros, raw[key]));
      if (v && !identifiers.includes(v)) identifiers.push(v);
    }
    for (const [key, v] of Object.entries(raw)) {
      if (ID_KEYS.includes(key) || NOT_ID_KEYS.has(key) || !/^vtp_[a-zA-Z]*Id$/.test(key)) continue;
      const s = resolve(macros, v);
      if (typeof s === 'string' && s && !identifiers.includes(s)) identifiers.push(s);
    }
    let settings: ContainerTag['settings'];
    if (kind === 'setting') {
      settings = {};
      for (const [key, v] of Object.entries(raw)) {
        if (!key.startsWith('vtp_') || key === 'vtp_instanceDestinationId') continue;
        if (typeof v === 'string') settings[key.slice(4)] = v.length > 120 ? `${v.slice(0, 117)}…` : v;
        else if (typeof v === 'number' || typeof v === 'boolean') settings[key.slice(4)] = v;
        if (Object.keys(settings).length >= 12) break;
      }
    }

    // What it loads / where it sends, and the party.
    const loads: string[] = [];
    let entry: KnowledgeEntry | undefined;
    let mappedBy: ContainerTag['mappedBy'];
    const perm = data.permissions?.[fn];
    if (kind !== 'helper') {
      if (info?.party === 'by-id' || isSetting) {
        const id = identifiers.find((x) => partyForGoogleId(x)) ?? (isSetting ? capture.id : undefined);
        entry = entryById(kb, partyForGoogleId(id));
        mappedBy = entry ? 'parameter' : undefined;
      } else if (info?.party) {
        entry = entryById(kb, info.party);
        mappedBy = entry ? 'template' : undefined;
      }
      if (fn === '__html') {
        const body = asString(resolve(macros, raw.vtp_html)) ?? '';
        loads.push(...hostsInText(body));
        if (!entry) {
          const bySignature = new Set(matchVendorSignatures(body));
          entry = entriesForText(kb, body)[0];
          mappedBy = entry ? (bySignature.has(entry.id) ? 'signature' : 'host') : undefined;
        }
      } else if (fn === '__img') {
        const url = asString(resolve(macros, raw.vtp_url)) ?? '';
        const h = hostOf(url);
        if (h) loads.push(h);
        if (!entry && h) {
          entry = lookupEntry(kb, h);
          mappedBy = entry ? 'host' : undefined;
        }
      } else if (custom) {
        loads.push(...permittedHosts(perm));
        if (!entry) {
          entry = firstEntryForHosts(kb, loads);
          mappedBy = entry ? 'permission' : undefined;
        }
        if (!entry) {
          const c = code.get(fn);
          const found = c ? entriesForText(kb, c.text) : [];
          entry = found[0];
          mappedBy = entry ? 'signature' : undefined;
        }
      }
    }
    if (kind === 'tag' && !entry) unmapped.add(fn === '__html' || fn === '__img' ? `${fn} (tag ${tagId})` : fn);

    // Triggers.
    const adds = addsFor.get(index) ?? [];
    const blocks = blocksFor.get(index) ?? [];
    const triggers = adds.map((v) => v.text);
    const events = [...new Set(adds.flatMap((v) => v.events))];
    // A rule that pins no event ('*': a regex / negated event match, or none) is
    // evaluated on every dataLayer event, page-load events included.
    const firesOnPageLoad = events.some((e) => e === '*' || PAGE_LOAD_EVENTS.has(e));
    if (events.includes('gtm.init_consent')) initTrigger = true;
    if (adds.some((v) => !v.ok)) warnings.push(`tag ${tagId}: a firing rule could not be fully read`);

    // Consent.
    const additional: string[] = [];
    let consentUnresolved = false;
    if ('consent' in raw) {
      const c = raw.consent;
      if (Array.isArray(c) && c[0] === 'list' && c.slice(1).every((x) => typeof x === 'string')) additional.push(...(c.slice(1) as string[]));
      else consentUnresolved = true;
    }
    const builtIn = info?.builtIn ?? [];
    const c = code.get(fn);
    const readsConsent = Boolean(c?.readsConsent) || consentPermission(perm).length > 0;
    if (c?.setsDefaults) defaultsSetBy.push(`${templateLabel} (tag ${tagId})`);
    if (c?.updatesConsent) updatedBy.push(`${templateLabel} (tag ${tagId})`);

    let status: TagConsentStatus;
    let note: string | undefined;
    if (additional.length) {
      status = 'required';
      // GTM treats a consent type nobody set as granted: the requirement only
      // holds the tag back where a 'denied' default runs before it fires. The
      // container cannot show that; the page's own consent calls can.
      note = `held until ${additional.join(' + ')} granted — only effective where a Consent Mode default of denied is set before the tag fires (an unset type counts as granted)`;
    } else if (consentUnresolved) {
      status = 'unknown';
      note = 'consent setting present but not in a form this parser can read';
    } else if (builtIn.length) {
      status = 'built-in';
      note = `fires regardless of consent; where Consent Mode is set up its built-in check changes what it sends (cookieless pings while ${builtIn.join(', ')} denied), otherwise it sends normally`;
    } else if (fn === '__paused') {
      status = 'none';
      note = 'paused in GTM: does not fire in this version';
    } else if (kind === 'helper') {
      status = 'none';
      note = 'listener installed by GTM; sends nothing itself';
    } else if (kind === 'setting') {
      status = 'none';
      note = 'a setting of the Google tag, governed by the tag’s own consent checks';
    } else if (custom && readsConsent) {
      status = 'template-checks';
      note = 'template code reads consent state; whether it holds back is up to that code (not verified here)';
    } else if (custom || fn === '__html' || fn === '__img' || info) {
      status = 'none';
      note = 'no consent requirement: fires whenever its trigger does';
    } else {
      status = 'unknown';
      note = `template ${fn} is not known to this parser`;
    }

    const seq = sequence(raw);
    out.push({
      tagId,
      index,
      template: fn,
      templateLabel,
      kind,
      custom,
      paused: fn === '__paused',
      partyId: entry?.id,
      partyLabel: entry?.vendor,
      mappedBy,
      identifiers,
      loads,
      triggers,
      exceptions: blocks.map((v) => v.text),
      events,
      firesOnPageLoad,
      consent: { status, additional, builtIn, note },
      sequencing: seq,
      settings,
    });
  });

  const counts = {
    tags: out.filter((t) => t.kind === 'tag').length,
    helpers: out.filter((t) => t.kind === 'helper').length,
    settings: out.filter((t) => t.kind === 'setting').length,
    required: out.filter((t) => t.kind === 'tag' && t.consent.status === 'required').length,
    builtIn: out.filter((t) => t.kind === 'tag' && t.consent.status === 'built-in').length,
    templateChecks: out.filter((t) => t.kind === 'tag' && t.consent.status === 'template-checks').length,
    none: out.filter((t) => t.kind === 'tag' && t.consent.status === 'none').length,
    unknown: out.filter((t) => t.kind === 'tag' && t.consent.status === 'unknown').length,
    unmapped: out.filter((t) => t.kind === 'tag' && !t.partyId).length,
  };

  return {
    ...base,
    status: 'parsed',
    version: asString(data.resource.version),
    tags: out,
    counts,
    unmappedTemplates: [...unmapped],
    consentMode: { initTrigger, defaultsSetBy, updatedBy },
    warnings: [...new Set(warnings)].slice(0, 20),
  };
}

function sequence(raw: Record<string, unknown>): ContainerTag['sequencing'] {
  const refs = (v: unknown): number[] => {
    if (!Array.isArray(v) || v[0] !== 'list') return [];
    return v.slice(1).map((x) => (Array.isArray(x) && x[0] === 'tag' && typeof x[1] === 'number' ? x[1] : -1)).filter((n) => n >= 0);
  };
  const setup = refs(raw.setup_tags);
  const teardown = refs(raw.teardown_tags);
  return setup.length || teardown.length ? { setup, teardown } : undefined;
}

function unreadableTag(index: number): ContainerTag {
  return {
    tagId: -1,
    index,
    template: '?',
    templateLabel: 'Unreadable tag',
    kind: 'tag',
    custom: false,
    paused: false,
    identifiers: [],
    loads: [],
    triggers: [],
    exceptions: [],
    events: [],
    firesOnPageLoad: false,
    consent: { status: 'unknown', additional: [], builtIn: [], note: 'tag entry could not be read' },
  };
}

/** Parse every capture; a parser crash on one container is that container's reason, never the run's. */
export function parseContainers(captures: ContainerCapture[], opts: ParseContainerOptions = {}): TagContainer[] {
  return captures.map((c) => {
    try {
      return parseGtmContainer(c, opts);
    } catch (err) {
      return {
        id: c.id,
        kind: c.kind,
        url: c.url,
        fetchedAt: c.fetchedAt,
        locationId: c.locationId,
        seenOn: c.seenOn ?? [],
        evidencePath: c.evidencePath,
        status: 'unreadable',
        reason: `parser error: ${err instanceof Error ? err.message.slice(0, 120) : 'unknown'}`,
        tags: [],
        unmappedTemplates: [],
        warnings: [],
      };
    }
  });
}
