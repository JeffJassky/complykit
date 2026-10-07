import { createHash } from 'node:crypto';
import { z } from 'zod';

// Static markup inspection (plans/client-consent-design.md §3 #1–#2, §5 item 2).
//
// The RAW HTML a page was served with — not the rendered DOM — says how each
// tracker got onto the page, and that decides whether a consent tool can hold
// it back:
//
//   - an executable <script> (src or inline) can be gated: the owner rewrites
//     it to type="text/plain" and the consent tool re-enables it on consent;
//   - an <img>, <iframe>, preload/prefetch/stylesheet <link>, or anything in a
//     <noscript>, is fetched by the browser itself. No script runs first, so no
//     consent tool can stop it — a markup leak.
//
// This module is the pure half: a small HTML tokenizer that knows exactly the
// parsing rules that matter here (comments are inert, <script>/<style>/
// <textarea>/<title> are raw text, <noscript> is raw text in a scripting
// browser, <template> content is inert, <base href> moves relative URLs) and
// emits one fact per element of interest with its 1-based line. It knows no
// vendors: matching against the knowledge base happens in rules/tracking.
// Collectors run it on the bytes they fetched; tests run it on fixtures.

/** Inline bodies kept per element (in memory; redaction drops them). Hosts and
 *  container ids are extracted from the WHOLE body first, so truncation never
 *  hides a loader URL. */
export const MARKUP_BODY_LIMIT = 16384;
const ATTR_VALUE_LIMIT = 512;
/** Encoded characters of a data: URL script decoded at most (a larger one is decoded up to here). */
export const DATA_URL_DECODE_LIMIT = 1_048_576;

export const MarkupElementKind = z.enum(['script', 'img', 'iframe', 'link']);
export type MarkupElementKind = z.infer<typeof MarkupElementKind>;

// What the browser does with the element on a normal (scripting) page load:
//   executes — a script that runs                     → gateable by rewriting
//   fetches  — the browser requests the URL itself     → leak
//   connects — dns-prefetch / preconnect: a connection, no HTTP request
//   held     — present but switched off (type="text/plain", data-src only):
//              the pattern consent tools use
//   inert    — never loads (JSON data blocks, <template> content, nomodule)
export const MarkupLoads = z.enum(['executes', 'fetches', 'connects', 'held', 'inert']);
export type MarkupLoads = z.infer<typeof MarkupLoads>;

// A script whose code is a data: URL (`<script src="data:text/javascript;base64,…">`):
// WordPress "delay / defer JavaScript" optimizers wrap inline vendor snippets
// this way. The decoded code is inspected exactly like an inline body; the URL
// itself never enters the record (the attribute keeps only "data:<type>,…").
export const MarkupDataUrl = z.object({
  attribute: z.string(), // the attribute that carries it: 'src', 'data-src', 'data-rocket-src'
  mediaType: z.string(), // 'text/javascript' ('' when the URL names none)
  encoding: z.enum(['base64', 'percent']),
  encodedLength: z.number().int(),
  // Longer than DATA_URL_DECODE_LIMIT: only its start was decoded and inspected.
  truncated: z.boolean().optional(),
});
export type MarkupDataUrl = z.infer<typeof MarkupDataUrl>;

export const MarkupElement = z.object({
  kind: MarkupElementKind,
  line: z.number().int(), // 1-based line of the start tag in the served HTML
  // 'noscript' = inside <noscript>: loads only for visitors with JavaScript
  // off — and then no consent tool can run either.
  context: z.enum(['document', 'noscript', 'template']),
  loads: MarkupLoads,
  url: z.string().optional(), // src / href / data-src, resolved against the page (and <base>)
  // Selected attributes (type, async, defer, rel, as, id, class, loading,
  // consent-tool data-* markers, …); values truncated.
  attributes: z.record(z.string()).default({}),
  // Inline script only:
  body: z.string().optional(), // truncated to MARKUP_BODY_LIMIT
  bodyLength: z.number().int().optional(),
  bodyDigest: z.string().optional(),
  hosts: z.array(z.string()).default([]), // hosts of loader URLs in the body (see scanInlineBody)
  ids: z.array(z.string()).default([]), // tag/container ids in the body (GTM-…, G-…, AW-…, UA-…)
  // The body calls document.write / writeln (read from the WHOLE body, so it
  // survives truncation and redaction): such a snippet cannot be gated — a
  // released copy runs after parsing, where the write is ignored or wipes the page.
  documentWrite: z.boolean().optional(),
  // The script's code came from a data: URL (decoded into body / hosts / ids).
  dataUrl: MarkupDataUrl.optional(),
  // A performance plugin re-typed the script to run it later (WP Rocket's
  // type="rocketlazyloadscript", LiteSpeed's type="litespeed/javascript",
  // Perfmatters' type="pmdelayedscript", Cloudflare Rocket Loader's
  // "<hash>-text/javascript"). Its loader runs it for every visitor — on the
  // first interaction or after load — so it counts as executing: that delay is
  // not consent gating.
  optimizer: z.string().optional(),
});
export type MarkupElement = z.infer<typeof MarkupElement>;

/** One visited page's served HTML, inspected (or why it could not be). */
export const MarkupPage = z.object({
  url: z.string(),
  pageIndex: z.number().int(),
  status: z.enum(['inspected', 'not-inspected']),
  // 'navigation' = the very response the browser rendered; 'refetch' = fetched
  // again through the same browser context after the visit (same proxy,
  // cookies, headers) because the navigation body was not readable.
  via: z.enum(['navigation', 'refetch']).optional(),
  reason: z.string().optional(), // why not inspected
  bytes: z.number().int().optional(),
  digest: z.string().optional(),
  lines: z.number().int().optional(),
  elements: z.array(MarkupElement).default([]),
});
export type MarkupPage = z.infer<typeof MarkupPage>;

// --- Tokenizer ----------------------------------------------------------------------

const RAW_TEXT = new Set(['script', 'style', 'textarea', 'title', 'xmp', 'noscript', 'noembed', 'noframes', 'iframe', 'plaintext']);

// Script types a browser executes (HTML "JavaScript MIME type essence match" + module).
const JS_TYPES = new Set([
  '',
  'module',
  'text/javascript',
  'application/javascript',
  'application/ecmascript',
  'application/x-ecmascript',
  'application/x-javascript',
  'text/ecmascript',
  'text/javascript1.0',
  'text/javascript1.1',
  'text/javascript1.2',
  'text/javascript1.3',
  'text/javascript1.4',
  'text/javascript1.5',
  'text/jscript',
  'text/livescript',
  'text/x-ecmascript',
  'text/x-javascript',
]);
// Non-JS types that a loader library still executes (Partytown runs these in a worker).
const LOADER_TYPES = new Set(['text/partytown']);
// The "switched off until consent" convention used by consent tools.
const HELD_TYPES = new Set(['text/plain', 'text/x-consent', 'text/blocked']);
// Script types a performance plugin's own loader executes later (see MarkupElement.optimizer).
const OPTIMIZER_TYPES: Array<{ type: RegExp; name: string }> = [
  { type: /^rocketlazyloadscript$/, name: 'WP Rocket (Delay JavaScript execution)' },
  { type: /^(?:litespeed\/javascript|text\/litespeed)$/, name: 'LiteSpeed Cache (delayed / deferred JS)' },
  { type: /^pmdelayedscript$/, name: 'Perfmatters (Delay JavaScript)' },
  { type: /^[0-9a-f]{16,}-text\/javascript$/, name: 'Cloudflare Rocket Loader' },
];

/** The performance plugin that re-typed this script to run it itself, if any. */
function optimizerOf(attrs: Map<string, string>): string | undefined {
  const type = (attrs.get('type') ?? '').trim().toLowerCase();
  const hit = OPTIMIZER_TYPES.find((o) => o.type.test(type));
  if (hit) return hit.name;
  // WP Rocket moves an external script's src to data-rocket-src.
  if (attrs.has('data-rocket-src') && !attrs.has('src') && !HELD_TYPES.has(type)) return OPTIMIZER_TYPES[0].name;
  return undefined;
}

const LINK_FETCH = new Set(['preload', 'prefetch', 'modulepreload', 'stylesheet']);
const LINK_CONNECT = new Set(['dns-prefetch', 'preconnect']);

const KEEP_ATTRS = new Set([
  'type', 'async', 'defer', 'nomodule', 'rel', 'as', 'id', 'class', 'loading', 'crossorigin', 'referrerpolicy',
  'sandbox', 'width', 'height', 'fetchpriority', 'nonce-present', 'src', 'href', 'data-src', 'data-href',
]);

interface RawTag {
  name: string;
  attrs: Map<string, string>;
  start: number; // offset of '<'
  end: number; // offset after '>'
  selfClosing: boolean;
}

/** Decode the entities that show up in attribute values (URLs mostly). */
function decodeEntities(s: string): string {
  if (!s.includes('&')) return s;
  return s.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos|#39);?/gi, (m, e: string) => {
    const k = e.toLowerCase();
    if (k === 'amp') return '&';
    if (k === 'lt') return '<';
    if (k === 'gt') return '>';
    if (k === 'quot') return '"';
    if (k === 'apos' || k === '#39') return "'";
    const code = k.startsWith('#x') ? parseInt(k.slice(2), 16) : parseInt(k.slice(1), 10);
    return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : m;
  });
}

/** Parse a start tag beginning at html[i] === '<'. Undefined if not a tag. */
function readTag(html: string, i: number): RawTag | undefined {
  let j = i + 1;
  const nameStart = j;
  while (j < html.length && /[A-Za-z0-9:-]/.test(html[j])) j++;
  if (j === nameStart || !/[A-Za-z]/.test(html[nameStart])) return undefined;
  const name = html.slice(nameStart, j).toLowerCase();
  const attrs = new Map<string, string>();
  let selfClosing = false;
  while (j < html.length) {
    while (j < html.length && /\s/.test(html[j])) j++;
    const c = html[j];
    if (c === undefined) break;
    if (c === '>') return { name, attrs, start: i, end: j + 1, selfClosing };
    if (c === '/') {
      selfClosing = true;
      j++;
      continue;
    }
    const aStart = j;
    while (j < html.length && !/[\s=>]/.test(html[j]) && !(html[j] === '/' && html[j + 1] === '>')) j++;
    const aName = html.slice(aStart, j).toLowerCase();
    if (!aName) {
      j++;
      continue;
    }
    while (j < html.length && /\s/.test(html[j])) j++;
    let value = '';
    if (html[j] === '=') {
      j++;
      while (j < html.length && /\s/.test(html[j])) j++;
      const q = html[j];
      if (q === '"' || q === "'") {
        const close = html.indexOf(q, j + 1);
        const stop = close < 0 ? html.length : close;
        value = html.slice(j + 1, stop);
        j = stop + 1;
      } else {
        const vStart = j;
        while (j < html.length && !/[\s>]/.test(html[j])) j++;
        value = html.slice(vStart, j);
      }
    }
    if (!attrs.has(aName)) attrs.set(aName, decodeEntities(value)); // first wins, as in HTML
    selfClosing = false;
  }
  return { name, attrs, start: i, end: html.length, selfClosing };
}

/** Offset just past the matching `</name` end tag's '>', and where its content ends. */
function rawTextEnd(html: string, from: number, name: string): { contentEnd: number; after: number } {
  const re = new RegExp(`</${name}(?=[\\s/>])`, 'gi');
  re.lastIndex = from;
  const m = re.exec(html);
  if (!m) return { contentEnd: html.length, after: html.length };
  const gt = html.indexOf('>', m.index);
  return { contentEnd: m.index, after: gt < 0 ? html.length : gt + 1 };
}

function lineIndex(html: string): number[] {
  const starts = [0];
  for (let i = 0; i < html.length; i++) if (html.charCodeAt(i) === 10) starts.push(i + 1);
  return starts;
}

function lineAt(starts: number[], offset: number): number {
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid] <= offset) lo = mid;
    else hi = mid - 1;
  }
  return lo + 1;
}

function resolve(raw: string | undefined, base: string): string | undefined {
  const v = raw?.trim();
  if (!v || v.startsWith('data:') || v.startsWith('javascript:') || v.startsWith('blob:') || v === 'about:blank' || v.startsWith('#')) return undefined;
  try {
    const u = new URL(v, base);
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.toString() : undefined;
  } catch {
    return undefined;
  }
}

function hostOfUrl(u: string | undefined): string {
  if (!u) return '';
  try {
    return new URL(u).hostname.toLowerCase();
  } catch {
    return '';
  }
}

/** "data:<type>[;base64],…" — a data: URL's header without its payload. */
export function dataUrlStub(v: string): string {
  const comma = v.indexOf(',');
  const head = (comma < 0 ? v : v.slice(0, comma)).trim();
  return `${head.length > 80 ? head.slice(0, 80) : head},…`;
}

function pickAttrs(attrs: Map<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, raw] of attrs) {
    // A data: URL's payload is the script itself (or an image): never recorded.
    const v = /^\s*data:/i.test(raw) ? dataUrlStub(raw) : raw;
    if (k === 'nonce') {
      out['nonce-present'] = 'true'; // the value is a per-response secret
      continue;
    }
    if (k === 'integrity') continue;
    // Consent tools mark held tags with data-* attributes (data-cookieconsent,
    // data-category, data-cookiecategory, data-consent, data-usercentrics, …).
    if (KEEP_ATTRS.has(k) || k.startsWith('data-')) out[k] = v.length > ATTR_VALUE_LIMIT ? `${v.slice(0, ATTR_VALUE_LIMIT)}…` : v;
  }
  return out;
}

// URL literals in script text, including JSON-escaped slashes (https:\/\/…).
const BODY_URL_RE = /(?:https?:)?\\?\/\\?\/([a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*\.[a-z]{2,})((?:\\?\/[^\s"'`<>\\]*)*)(["'`]?)(\s*\+)?/gi;
// Google tag / container ids. G- needs a digit so prose ("G-Shock") does not match.
const BODY_ID_RE = /\b(GTM-[A-Z0-9]{4,10}|GT-[A-Z0-9]{6,12}|G-(?=[A-Z0-9]*\d)[A-Z0-9]{6,12}|AW-\d{6,12}|DC-\d{5,12}|UA-\d{4,10}-\d{1,4})\b/g;

/**
 * Hosts of LOADER-looking URLs in an inline body, and tag ids (pure; exported
 * for tests). A URL counts as a loader when its path ends in .js, or when the
 * string literal is concatenated onward ("https://www.clarity.ms/tag/"+id) —
 * the shape of every vendor install snippet. Plain links (a theme's
 * "https://www.facebook.com/brand" social URL) do not count: naming a host is
 * not loading from it.
 */
export function scanInlineBody(body: string): { hosts: string[]; ids: string[] } {
  const hosts = new Set<string>();
  const ids = new Set<string>();
  for (const m of body.matchAll(BODY_URL_RE)) {
    const pathname = (m[2] ?? '').replace(/\\\//g, '/').split(/[?#]/)[0];
    const concatenated = Boolean(m[3]) && Boolean(m[4]);
    if (/\.js$/i.test(pathname) || concatenated) hosts.add(m[1].toLowerCase());
  }
  for (const m of body.matchAll(BODY_ID_RE)) ids.add(m[1]);
  return { hosts: [...hosts].slice(0, 50), ids: [...ids].slice(0, 50) };
}

/** A call to document.write / document.writeln in inline script text. */
const DOCUMENT_WRITE_RE = /\bdocument\s*\.\s*write(?:ln)?\s*\(/;

/** Percent-decode to UTF-8; a stray '%' stays as it is. */
function percentDecode(s: string): string {
  if (!s.includes('%')) return s;
  const parts: Buffer[] = [];
  let last = 0;
  for (const m of s.matchAll(/%([0-9a-f]{2})/gi)) {
    parts.push(Buffer.from(s.slice(last, m.index), 'utf8'), Buffer.from([parseInt(m[1], 16)]));
    last = m.index! + 3;
  }
  parts.push(Buffer.from(s.slice(last), 'utf8'));
  return Buffer.concat(parts).toString('utf8');
}

/**
 * Decode a data: URL (pure; exported for tests): base64 (`;base64`) or
 * percent-encoded, as a browser does for a script src — percent-decoding first,
 * then forgiving base64 (whitespace ignored). At most DATA_URL_DECODE_LIMIT
 * encoded characters are decoded. Undefined when it is not a data: URL.
 */
export function decodeDataUrl(raw: string): { mediaType: string; encoding: 'base64' | 'percent'; body: string; encodedLength: number; truncated: boolean } | undefined {
  const v = raw.trim();
  const m = /^data:([^,]*),/i.exec(v);
  if (!m) return undefined;
  const params = m[1].split(';').map((x) => x.trim().toLowerCase());
  const base64 = params.slice(1).includes('base64');
  let data = v.slice(m[0].length);
  const encodedLength = data.length;
  const truncated = encodedLength > DATA_URL_DECODE_LIMIT;
  if (truncated) data = data.slice(0, DATA_URL_DECODE_LIMIT);
  let body: string;
  if (base64) {
    let clean = percentDecode(data).replace(/[\s]/g, '').replace(/=+$/, '');
    if (!/^[A-Za-z0-9+/]*$/.test(clean)) clean = clean.replace(/[^A-Za-z0-9+/]/g, '');
    clean = clean.slice(0, clean.length - (clean.length % 4 === 1 ? 1 : 0));
    body = Buffer.from(clean, 'base64').toString('utf8');
  } else body = percentDecode(data);
  return { mediaType: params[0] ?? '', encoding: base64 ? 'base64' : 'percent', body, encodedLength, truncated };
}

function digestOf(s: string): string {
  return `sha256:${createHash('sha256').update(s, 'utf8').digest('hex').slice(0, 12)}`;
}

function scriptLoads(attrs: Map<string, string>, context: MarkupElement['context']): MarkupLoads {
  if (context === 'template') return 'inert';
  const type = (attrs.get('type') ?? '').trim().toLowerCase().split(';')[0].trim();
  if (JS_TYPES.has(type) || LOADER_TYPES.has(type)) return attrs.has('nomodule') && type !== 'module' ? 'inert' : 'executes';
  if (HELD_TYPES.has(type)) return 'held';
  // Anything else (application/json, ld+json, importmap, speculationrules,
  // text/template, vendor types) is data, not code.
  return 'inert';
}

/**
 * Every <script>, cross-host <img>, <iframe>, and fetching/connecting <link>
 * in served HTML, with line numbers. Same-host images and links are skipped —
 * a first-party image is not a third party's pixel (first-party proxy hosts
 * are a different host, so they are kept). Scripts are always kept: inline
 * ones are how most pixels are installed.
 */
export function parseMarkup(html: string, pageUrl: string): MarkupElement[] {
  const starts = lineIndex(html);
  const out: MarkupElement[] = [];
  let base = pageUrl;
  const pageHost = hostOfUrl(pageUrl);
  const push = (el: MarkupElement): void => {
    out.push(el);
  };
  walk(html, 0, html.length, 'document');
  return out;

  function walk(src: string, from: number, to: number, context: MarkupElement['context']): void {
    let i = from;
    let templateDepth = 0;
    while (i < to) {
      const lt = src.indexOf('<', i);
      if (lt < 0 || lt >= to) break;
      // Comments (including conditional comments) are inert.
      if (src.startsWith('<!--', lt)) {
        const close = src.indexOf('-->', lt + 4);
        i = close < 0 ? to : close + 3;
        continue;
      }
      if (src[lt + 1] === '!' || src[lt + 1] === '?') {
        const gt = src.indexOf('>', lt);
        i = gt < 0 ? to : gt + 1;
        continue;
      }
      if (src[lt + 1] === '/') {
        const m = /^<\/([A-Za-z0-9-]+)/.exec(src.slice(lt, lt + 40));
        if (m && m[1].toLowerCase() === 'template' && templateDepth > 0) templateDepth--;
        const gt = src.indexOf('>', lt);
        i = gt < 0 ? to : gt + 1;
        continue;
      }
      const tag = readTag(src, lt);
      if (!tag) {
        i = lt + 1;
        continue;
      }
      i = Math.min(tag.end, to);
      const ctx: MarkupElement['context'] = templateDepth > 0 ? 'template' : context;
      const line = lineAt(starts, tag.start);
      switch (tag.name) {
        case 'template':
          if (!tag.selfClosing) templateDepth++;
          break;
        case 'base': {
          const href = tag.attrs.get('href');
          if (href && ctx === 'document' && base === pageUrl) {
            try {
              base = new URL(href, pageUrl).toString();
            } catch {
              /* keep page URL */
            }
          }
          break;
        }
        case 'script': {
          // '<script … />' is not self-closing in HTML: content runs to </script>.
          const { contentEnd, after } = rawTextEnd(src, tag.end, 'script');
          const raw = src.slice(tag.end, contentEnd);
          const optimizer = optimizerOf(tag.attrs);
          // Where the code comes from: src; a performance plugin's own attribute
          // (data-rocket-src); or data-src (a held / lazy tag) when there is no src.
          const srcKey = tag.attrs.has('src') ? 'src' : optimizer && tag.attrs.has('data-rocket-src') ? 'data-rocket-src' : tag.attrs.has('data-src') ? 'data-src' : undefined;
          const srcValue = srcKey ? tag.attrs.get(srcKey) : undefined;
          const data = srcValue !== undefined && /^\s*data:/i.test(srcValue) ? decodeDataUrl(srcValue) : undefined;
          const url = srcKey ? resolve(srcValue, base) : undefined;
          // A src-less tag that names its code in data-src waits for a loader: held
          // (unless an optimizer's loader runs it anyway — then it executes).
          const loads: MarkupLoads = ctx === 'template' ? 'inert' : optimizer ? 'executes' : srcKey === 'data-src' && (url || data) ? 'held' : scriptLoads(tag.attrs, ctx);
          const el: MarkupElement = { kind: 'script', line, context: ctx, loads, url, attributes: pickAttrs(tag.attrs), hosts: [], ids: [] };
          if (optimizer) el.optimizer = optimizer;
          // Code to read: the decoded data: URL, or the inline body when there is no src.
          const code = data ? data.body.trim() : !tag.attrs.has('src') && raw.trim() ? raw.trim() : undefined;
          if (data && srcKey) {
            el.dataUrl = { attribute: srcKey, mediaType: data.mediaType, encoding: data.encoding, encodedLength: data.encodedLength, ...(data.truncated ? { truncated: true } : {}) };
          }
          if (code) {
            const scan = scanInlineBody(code);
            el.body = code.length > MARKUP_BODY_LIMIT ? code.slice(0, MARKUP_BODY_LIMIT) : code;
            el.bodyLength = code.length;
            el.bodyDigest = digestOf(code);
            el.hosts = scan.hosts;
            el.ids = scan.ids;
            if (DOCUMENT_WRITE_RE.test(code)) el.documentWrite = true;
          }
          push(el);
          i = Math.min(after, to);
          break;
        }
        case 'noscript': {
          // A scripting browser treats noscript content as raw text; what is in
          // it loads only when JavaScript is off. Parse it as a fragment.
          const { contentEnd, after } = rawTextEnd(src, tag.end, 'noscript');
          walk(src, tag.end, contentEnd, ctx === 'template' ? 'template' : 'noscript');
          i = Math.min(after, to);
          break;
        }
        case 'img': {
          const direct = resolve(tag.attrs.get('src'), base);
          const lazy = direct ? undefined : resolve(tag.attrs.get('data-src'), base);
          const url = direct ?? lazy;
          if (!url || hostOfUrl(url) === pageHost) break;
          push({ kind: 'img', line, context: ctx, loads: ctx === 'template' ? 'inert' : direct ? 'fetches' : 'held', url, attributes: pickAttrs(tag.attrs), hosts: [], ids: [] });
          break;
        }
        case 'iframe': {
          const direct = resolve(tag.attrs.get('src'), base);
          const lazy = direct ? undefined : resolve(tag.attrs.get('data-src'), base);
          const url = direct ?? lazy;
          if (url) push({ kind: 'iframe', line, context: ctx, loads: ctx === 'template' ? 'inert' : direct ? 'fetches' : 'held', url, attributes: pickAttrs(tag.attrs), hosts: [], ids: [] });
          // iframe content is raw text (fallback) — skip to its end tag.
          if (!tag.selfClosing) i = Math.min(rawTextEnd(src, tag.end, 'iframe').after, to);
          break;
        }
        case 'link': {
          const rels = (tag.attrs.get('rel') ?? '').toLowerCase().split(/\s+/).filter(Boolean);
          const fetches = rels.some((r) => LINK_FETCH.has(r));
          const connects = rels.some((r) => LINK_CONNECT.has(r));
          if (!fetches && !connects) break;
          const url = resolve(tag.attrs.get('href'), base) ?? (connects ? resolveHostOnly(tag.attrs.get('href')) : undefined);
          if (!url || hostOfUrl(url) === pageHost) break;
          push({ kind: 'link', line, context: ctx, loads: ctx === 'template' ? 'inert' : fetches ? 'fetches' : 'connects', url, attributes: pickAttrs(tag.attrs), hosts: [], ids: [] });
          break;
        }
        default:
          if (RAW_TEXT.has(tag.name) && !tag.selfClosing) i = Math.min(rawTextEnd(src, tag.end, tag.name).after, to);
      }
    }
  }
}

/** dns-prefetch hrefs are often bare '//host' or 'host'. */
function resolveHostOnly(raw: string | undefined): string | undefined {
  const v = raw?.trim();
  if (!v) return undefined;
  const host = v.replace(/^(https?:)?\/\//i, '').split(/[/?#]/)[0];
  return /^[a-z0-9.-]+\.[a-z]{2,}$/i.test(host) ? `https://${host.toLowerCase()}/` : undefined;
}

/** Inspect one served page: elements + size/digest/line count. */
export function inspectMarkup(html: string, url: string, pageIndex: number, via: 'navigation' | 'refetch'): MarkupPage {
  return {
    url,
    pageIndex,
    status: 'inspected',
    via,
    bytes: Buffer.byteLength(html, 'utf8'),
    digest: digestOf(html),
    lines: lineIndex(html).length,
    elements: parseMarkup(html, url),
  };
}

/** Drop inline bodies (they can hold the site's own tokens); keep digest, length, hosts, ids. */
export function redactMarkupPages(pages: MarkupPage[]): MarkupPage[] {
  return pages.map((p) => ({ ...p, elements: p.elements.map(({ body: _body, ...e }) => e) }));
}
