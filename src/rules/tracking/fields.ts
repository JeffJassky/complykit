import { createHash } from 'node:crypto';

// What a request carried (plans/consent-design.md §2.6): URL parameters and
// body, parsed into named fields, each value classified by what it IS — the
// page address, the page title, an ID the browser stores, a marker the scan
// typed, a hashed email. Classification is by value, not by parameter name, so
// it works for vendors nobody has documented.

export type FieldKind =
  | 'page-address'
  | 'page-title'
  | 'browser-id'
  | 'click-id'
  | 'form-input'
  | 'search-term'
  | 'hashed-email'
  | 'event-name'
  | 'identifier';

export interface Field {
  key: string;
  value: string;
  where: 'query' | 'body' | 'path';
}

export interface MarkerSet {
  email: string;
  text: string;
  clickIds: Record<string, string>;
}

export interface FieldContext {
  pageUrl: string;
  pageTitle?: string;
  /** Values stored on the device (cookie, storage, script-written) → their name. */
  deviceValues: Map<string, string>;
  markers?: MarkerSet;
}

const MAX_FIELDS = 400;

function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s.replace(/\+/g, ' '));
  } catch {
    return s;
  }
}

function flatten(prefix: string, v: unknown, out: Field[], depth: number): void {
  if (out.length >= MAX_FIELDS) return;
  if (v === null || v === undefined) return;
  if (typeof v === 'object' && depth < 5) {
    if (Array.isArray(v)) v.forEach((x, i) => flatten(`${prefix}[${i}]`, x, out, depth + 1));
    else for (const [k, x] of Object.entries(v as Record<string, unknown>)) flatten(prefix ? `${prefix}.${k}` : k, x, out, depth + 1);
    return;
  }
  out.push({ key: prefix, value: String(v), where: 'body' });
}

/** Query parameters + body fields (urlencoded, JSON, JSON lines). */
export function parseFields(url: string, body?: string): Field[] {
  const out: Field[] = [];
  try {
    const u = new URL(url);
    for (const [k, v] of u.searchParams) if (out.length < MAX_FIELDS) out.push({ key: k, value: v, where: 'query' });
    // Some trackers put payloads in path segments.
    for (const seg of u.pathname.split('/')) if (seg.length >= 16) out.push({ key: '(path)', value: safeDecode(seg), where: 'path' });
  } catch {
    /* not a URL */
  }
  if (body) {
    const trimmed = body.trim();
    let parsed = false;
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
      try {
        flatten('', JSON.parse(trimmed), out, 0);
        parsed = true;
      } catch {
        // JSON lines / concatenated batches
        for (const line of trimmed.split('\n')) {
          try {
            flatten('', JSON.parse(line), out, 0);
            parsed = true;
          } catch {
            /* skip */
          }
        }
      }
    }
    if (!parsed && /^[^\s=&]+=[^&]*(&[^\s=&]+=[^&]*)*$/.test(trimmed.split('\n')[0] ?? '')) {
      for (const line of trimmed.split('\n')) {
        for (const pair of line.split('&')) {
          const i = pair.indexOf('=');
          if (i > 0 && out.length < MAX_FIELDS) out.push({ key: safeDecode(pair.slice(0, i)), value: safeDecode(pair.slice(i + 1)), where: 'body' });
        }
      }
      parsed = true;
    }
    if (!parsed && trimmed) out.push({ key: '(body)', value: trimmed.slice(0, 4096), where: 'body' });
  }
  return out;
}

// --- Markers -----------------------------------------------------------------------

export interface MarkerHit {
  marker: 'email' | 'search-text' | 'click-id';
  form: 'plain' | 'url-encoded' | 'base64' | 'sha256' | 'md5' | 'sha1';
  name?: string; // click-id param
}

const hex = (alg: string, s: string): string => createHash(alg).update(s, 'utf8').digest('hex');

interface Needle {
  needle: string;
  hit: MarkerHit;
}

const needleCache = new WeakMap<MarkerSet, Needle[]>();

/** Every form a marker could leave the browser in: plain, encoded, base64, hashed
 *  (including the normalized-email hash ad platforms use for "advanced matching"). */
export function markerNeedles(m: MarkerSet): Needle[] {
  const cached = needleCache.get(m);
  if (cached) return cached;
  const out: Needle[] = [];
  const add = (needle: string, hit: MarkerHit): void => {
    if (needle && !out.some((n) => n.needle === needle)) out.push({ needle, hit });
  };
  const email = m.email.trim().toLowerCase();
  for (const [marker, value] of [['email', email], ['search-text', m.text]] as const) {
    add(value, { marker, form: 'plain' });
    add(encodeURIComponent(value), { marker, form: 'url-encoded' });
    add(Buffer.from(value, 'utf8').toString('base64').replace(/=+$/, ''), { marker, form: 'base64' });
  }
  for (const alg of ['sha256', 'md5', 'sha1'] as const) add(hex(alg, email), { marker: 'email', form: alg });
  for (const [name, value] of Object.entries(m.clickIds)) {
    if (name.startsWith('utm_')) continue;
    add(value, { marker: 'click-id', form: 'plain', name });
  }
  needleCache.set(m, out);
  return out;
}

/** Markers found in a request's URL, body or a websocket payload. */
export function findMarkers(haystacks: Array<string | undefined>, m: MarkerSet | undefined): MarkerHit[] {
  if (!m) return [];
  const hay = haystacks.filter((h): h is string => Boolean(h));
  if (!hay.length) return [];
  const lower = hay.map((h) => h.toLowerCase());
  const decoded = hay.map((h) => safeDecode(safeDecode(h)).toLowerCase());
  const hits: MarkerHit[] = [];
  for (const n of markerNeedles(m)) {
    const needle = n.needle.toLowerCase();
    if (lower.some((h) => h.includes(needle)) || decoded.some((h) => h.includes(needle))) hits.push(n.hit);
  }
  return hits;
}

// --- Classification -----------------------------------------------------------------

const EVENT_KEYS = new Set(['ev', 'en', 'event', 'e', 'event_name', 'eventname', 'e_n', 'evt', 'action', 'ea', 't']);
const ID_LIKE = /^(?=.*\d)(?=.*[a-z])[a-z0-9._:-]{16,}$/i;

function stripScheme(u: string): string {
  return u.replace(/^https?:\/\//i, '').replace(/[#?].*$/, '').replace(/\/$/, '');
}

/** Classify every field of a request; returns the kinds and the device keys an ID matched. */
export function classifyFields(fields: Field[], ctx: FieldContext): { kinds: Set<FieldKind>; ids: Array<{ value: string; storedAs: string }>; markers: MarkerHit[] } {
  const kinds = new Set<FieldKind>();
  const ids: Array<{ value: string; storedAs: string }> = [];
  const page = stripScheme(ctx.pageUrl);
  const title = ctx.pageTitle?.trim();
  for (const f of fields) {
    const raw = f.value;
    if (!raw) continue;
    const v = safeDecode(raw);
    if (page.length > 4 && v.length >= page.length - 1 && stripScheme(v).startsWith(page.split('?')[0])) kinds.add('page-address');
    else if (page.length > 4 && v.includes(page)) kinds.add('page-address');
    if (title && title.length >= 3 && v.trim() === title) kinds.add('page-title');
    if (EVENT_KEYS.has(f.key.toLowerCase()) && v.length <= 40 && /^[a-z_ -]+$/i.test(v)) kinds.add('event-name');
    if (v.length >= 8) {
      for (const [stored, name] of ctx.deviceValues) {
        if (stored.length < 8) continue;
        if (stored === v || (v.length >= 10 && stored.includes(v)) || (stored.length >= 10 && v.includes(stored))) {
          kinds.add('browser-id');
          if (ids.length < 20 && !ids.some((x) => x.value === v)) ids.push({ value: v, storedAs: name });
          break;
        }
      }
    }
    const markerPrefix = ctx.markers && v.length >= 6 && (ctx.markers.email.toLowerCase().startsWith(v.toLowerCase()) || ctx.markers.text.startsWith(v));
    // Path segments are file names and hashes far more often than IDs — only a
    // value the browser actually stores (browser-id above) counts there.
    if (f.where !== 'path' && !kinds.has('browser-id') && !markerPrefix && ID_LIKE.test(v) && !/^https?:/i.test(v)) kinds.add('identifier');
  }
  const markers = ctx.markers ? findMarkers(fields.map((f) => f.value), ctx.markers) : [];
  for (const m of markers) {
    if (m.marker === 'click-id') kinds.add('click-id');
    else if (m.form === 'sha256' || m.form === 'md5' || m.form === 'sha1') kinds.add('hashed-email');
    else if (m.marker === 'search-text') kinds.add('search-term');
    else kinds.add('form-input');
  }
  return { kinds, ids, markers };
}

/** Plain-language names for field kinds (report + messages). */
export const FIELD_LABEL: Record<FieldKind, string> = {
  'page-address': 'the page address',
  'page-title': 'the page title',
  'browser-id': 'an ID stored in the browser',
  'click-id': 'the ad-click ID from the URL',
  'form-input': 'text typed into a form (never submitted)',
  'search-term': 'the search text typed (never submitted)',
  'hashed-email': 'a hash of the typed email',
  'event-name': 'an event name',
  identifier: 'an identifier-like value',
};
