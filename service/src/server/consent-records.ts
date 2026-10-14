// Optional consent-record endpoint (client-consent design §6, §10): a place to
// prove consent for clients who don't host their own. The client package posts
// one record per consent decision; we append it to
// DATA_DIR/sites/<registrable-domain>/consent-records.jsonl and nothing else.
//
// Privacy is the point of the shape. A record holds the random consent id the
// client generated, the decision, and the versions that produced it. No IP, no
// user agent, no cookies, no referrer, no page URL: the body is validated
// against an allow-list and an unknown field is a 400, so a client can't send
// identifiers by accident. The only per-visitor thing the server looks at is
// the IP for rate limiting, held in memory for a minute and never written.
//
// Persistence is behind ConsentRecordRecords (storage/types.ts): a JSONL file
// per site with the fs backend, one document per record with the cloud backend.
// The size cap, de-duplication by id and pruning live there.

import { siteDomain } from './domains.js';
import type { ConsentRecordRecords } from './storage/types.js';
import { WorkspaceError } from './workspace.js';

export const CONSENT_FILE = 'consent-records.jsonl';
/** Body limit for the POST route, in bytes. A real record is ~300. */
export const MAX_BODY_BYTES = 4 * 1024;
const MAX_CATEGORIES = 32;
/** One site's file stops growing here (≈ 700k records); posts then get a 507. */
export const MAX_FILE_BYTES = 256 * 1024 * 1024;
/** A client clock this far ahead is refused; this far behind is accepted (a tab left open). */
const MAX_SKEW_MS = 5 * 60_000;

/** What the client sends. */
const BODY_FIELDS = new Set(['id', 'at', 'categories', 'configHash', 'toolVersion', 'regime', 'gpc', 'domain']);

/** What we store, one per line. `receivedAt` is ours (retention runs on it, since `at` is the client's clock). */
export interface ConsentRecord {
  id: string;
  at: string;
  receivedAt: string;
  categories: Record<string, boolean>;
  configHash: string;
  toolVersion: string;
  regime: string;
  gpc?: boolean;
}

// Patterns start with a letter or digit so no exported cell can begin with
// = + - @ (spreadsheet formula injection).
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{15,63}$/;
const CATEGORY_RE = /^[a-z][a-z0-9_-]{0,31}$/;
const HASH_RE = /^[A-Za-z0-9][A-Za-z0-9:_.-]{3,127}$/;
const VERSION_RE = /^[A-Za-z0-9][A-Za-z0-9.+_-]{0,31}$/;
const REGIME_RE = /^[a-z][a-z0-9_-]{0,31}$/;
const RESERVED = new Set(['__proto__', 'constructor', 'prototype']);

function bad(message: string, status = 400): never {
  throw new WorkspaceError(status, message);
}

const isPlainObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** The registrable domain an Origin header names, or undefined ('null', a path, a non-http scheme, an IP). */
export function originDomain(origin: string | undefined): string | undefined {
  if (!origin) return undefined;
  let u: URL;
  try {
    u = new URL(origin);
  } catch {
    return undefined;
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return undefined;
  if (u.origin !== origin) return undefined; // an Origin is scheme://host[:port], nothing more
  if (/^[\d.]+$/.test(u.hostname)) return undefined; // an IP is no one's site
  return siteDomain(u.hostname);
}

/** The body, validated and normalized. Throws a 400 (403 for a `domain` that disagrees with the Origin). */
export function normalizeRecord(body: unknown, domain: string, now = Date.now()): ConsentRecord {
  if (!isPlainObject(body)) bad('the body must be a JSON object');
  for (const k of Object.keys(body)) if (!BODY_FIELDS.has(k)) bad(`unknown field \`${k.slice(0, 40)}\`: a consent record holds only id, at, categories, configHash, toolVersion, regime and gpc`);

  if (body.domain !== undefined && siteDomain(body.domain) !== domain) bad('`domain` does not match the request Origin', 403);

  if (typeof body.id !== 'string' || !ID_RE.test(body.id)) bad('`id` must be a random id of 16-64 characters (letters, digits, - and _)');

  const ms = typeof body.at === 'string' ? Date.parse(body.at) : NaN;
  if (!Number.isFinite(ms)) bad('`at` must be an ISO date-time');
  if (ms > now + MAX_SKEW_MS) bad('`at` is in the future');

  if (!isPlainObject(body.categories)) bad('`categories` must be an object of category id to true/false');
  const entries = Object.entries(body.categories);
  if (!entries.length || entries.length > MAX_CATEGORIES) bad(`\`categories\` must hold 1-${MAX_CATEGORIES} categories`);
  const categories: Record<string, boolean> = {};
  for (const [k, v] of entries) {
    if (!CATEGORY_RE.test(k) || RESERVED.has(k)) bad(`not a usable category id: ${JSON.stringify(k.slice(0, 40))}`);
    if (typeof v !== 'boolean') bad(`\`categories.${k}\` must be true or false`);
    categories[k] = v;
  }

  if (typeof body.configHash !== 'string' || !HASH_RE.test(body.configHash)) bad('`configHash` is not a config hash');
  if (typeof body.toolVersion !== 'string' || !VERSION_RE.test(body.toolVersion)) bad('`toolVersion` is not a version');
  if (typeof body.regime !== 'string' || !REGIME_RE.test(body.regime)) bad('`regime` is not a regime id');
  if (body.gpc !== undefined && typeof body.gpc !== 'boolean') bad('`gpc` must be true or false');

  const rec: ConsentRecord = {
    id: body.id,
    at: new Date(ms).toISOString(),
    receivedAt: new Date(now).toISOString(),
    categories,
    configHash: body.configHash,
    toolVersion: body.toolVersion,
    regime: body.regime,
  };
  if (body.gpc !== undefined) rec.gpc = body.gpc;
  return rec;
}

// --- Rate limit -----------------------------------------------------------------

/** Fixed-window counter keyed by a string. In memory only; nothing about a key is kept past its window. */
export class RateLimiter {
  private readonly hits = new Map<string, { start: number; n: number }>();

  constructor(
    private readonly limit: number,
    private readonly windowMs = 60_000,
  ) {}

  /** Count one hit; the seconds to wait when over the limit, else 0. */
  hit(key: string, now = Date.now()): number {
    if (this.hits.size > 10_000) for (const [k, v] of this.hits) if (now - v.start >= this.windowMs) this.hits.delete(k);
    const h = this.hits.get(key);
    if (!h || now - h.start >= this.windowMs) {
      this.hits.set(key, { start: now, n: 1 });
      return 0;
    }
    h.n++;
    return h.n > this.limit ? Math.max(1, Math.ceil((h.start + this.windowMs - now) / 1000)) : 0;
  }
}

// --- Store ----------------------------------------------------------------------

export type ExportFormat = 'csv' | 'jsonl';

export class ConsentRecordStore {
  private readonly pending = new Set<Promise<unknown>>();

  constructor(
    private readonly records: ConsentRecordRecords,
    /** Records older than this (by receivedAt) are pruned. */
    readonly retentionDays: number,
  ) {}

  private track<T>(p: Promise<T>): Promise<T> {
    const q = p.catch(() => undefined);
    this.pending.add(q);
    void q.then(() => this.pending.delete(q));
    return p;
  }

  append(domain: string, record: ConsentRecord): Promise<void> {
    return this.track(this.records.append(domain, record));
  }

  /** Does any record exist for this site? (404 vs an empty export.) */
  exists(domain: string): Promise<boolean> {
    return this.records.exists(domain);
  }

  /** The export, as chunks to write to the response. */
  async *export(domain: string, format: ExportFormat): AsyncGenerator<string> {
    if (format === 'jsonl') {
      for await (const r of this.records.records(domain)) yield JSON.stringify(r) + '\n';
      return;
    }
    // CSV: a column per category, so the first pass finds the union.
    const cats = new Set<string>();
    for await (const r of this.records.records(domain)) for (const k of Object.keys(r.categories ?? {})) cats.add(k);
    const catCols = [...cats].sort();
    yield csvRow(['id', 'at', 'receivedAt', 'regime', 'gpc', 'configHash', 'toolVersion', ...catCols.map((c) => `category:${c}`)]);
    for await (const r of this.records.records(domain)) {
      yield csvRow([r.id, r.at, r.receivedAt, r.regime, r.gpc === undefined ? '' : String(r.gpc), r.configHash, r.toolVersion, ...catCols.map((c) => (r.categories?.[c] === undefined ? '' : String(r.categories[c])))]);
    }
  }

  /** Drop records received before the retention cutoff, in every site. Returns how many went.
   *  A record that can't be read is kept: pruning never destroys what it can't read. */
  prune(now = Date.now()): Promise<number> {
    return this.track(this.records.prune(now - this.retentionDays * 86_400_000));
  }

  /** Wait for in-flight writes (server shutdown). */
  async flush(): Promise<void> {
    while (this.pending.size) await Promise.allSettled([...this.pending]);
  }
}

function csvCell(v: string): string {
  return /[",\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}
function csvRow(cells: string[]): string {
  return cells.map(csvCell).join(',') + '\r\n';
}
