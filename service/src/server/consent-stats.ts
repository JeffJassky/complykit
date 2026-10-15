// Banner analytics: POST /e (plans/hosted-script.md "Event beacon", "Counters").
//
// Counters only. A beacon body becomes a handful of integer increments keyed by
// (domain, UTC day, config hash); the body itself, the IP, the user agent, the
// referrer and the URL are never kept. This module sees only the parsed body,
// the Origin's registrable domain and (when TRUST_CF_GEO) two Cloudflare header
// values, and returns increments. Rate limiting by IP lives in app.ts, in memory.

import type { ConfigSnapshot, ConsentStatsConfig, ConsentStatsResponse } from '../shared/api.js';
import type { ConfigSnapshotRecords, ConsentStatsDoc, ConsentStatsRecords } from './storage/types.js';

/** Largest accepted body, in bytes. */
export const MAX_BEACON_BYTES = 4096;
const MAX_EVENTS = 20;
const MAX_MS = 86_400_000;

const HASH_RE = /^[0-9a-f]{64}$/;
const CATEGORY_ID_RE = /^[a-z][a-z0-9_-]{0,31}$/;
const COUNTRY_RE = /^[A-Z]{2}$/;
const REGION_RE = /^[A-Z0-9]{1,3}$/;
const REGIMES = new Set(['opt-in', 'opt-out-signal', 'opt-out']);
const ACTIONS = new Set(['accept', 'reject', 'custom']);
const DECIDE_VIA = new Set(['banner', 'settings', 'cmp']);
const OPEN_VIA = new Set(['banner', 'choices', 'api']);

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Time-to-decide bucket for a millisecond count (already clamped). */
export function bucketMs(ms: number): string {
  if (ms < 2000) return 'lt2s';
  if (ms < 5000) return '2-5s';
  if (ms < 10_000) return '5-10s';
  if (ms < 30_000) return '10-30s';
  if (ms < 60_000) return '30-60s';
  if (ms < 300_000) return '1-5m';
  return 'gt5m';
}

/** The geo part of a counter key: `XX`, `CC` or `CC-RR`. Only from Cloudflare's headers, only when trusted (P6). */
export function geoOf(trust: boolean, country: string | undefined, region: string | undefined): string {
  if (!trust || !country || !COUNTRY_RE.test(country) || country === 'XX') return 'XX';
  return region && REGION_RE.test(region) ? `${country}-${region}` : country;
}

/** The ids of a snapshot config's categories a visitor can toggle (everything except `necessary`). */
export function optionalCategoryIds(config: Record<string, unknown>): Set<string> {
  const out = new Set<string>();
  const cats = config.categories;
  if (Array.isArray(cats)) {
    for (const c of cats) if (isObj(c) && typeof c.id === 'string' && c.id !== 'necessary' && CATEGORY_ID_RE.test(c.id)) out.add(c.id);
  }
  return out;
}

const flag = (v: unknown): boolean | undefined => (v === 0 || v === false ? false : v === 1 || v === true ? true : undefined);

/**
 * A parsed body turned into increments, or undefined when nothing in it counts.
 * Events that fail validation are dropped one by one; only the first 20 are read;
 * at most one `load` and one `shown` count. `body.h` and the Origin are checked by the caller.
 */
export function countBeacon(body: Record<string, unknown>, categories: Set<string>, geo: string): Record<string, number> | undefined {
  if (body.v !== 1 || typeof body.r !== 'string' || !REGIMES.has(body.r) || !Array.isArray(body.ev)) return undefined;
  const n: Record<string, number> = {};
  const inc = (k: string): void => void (n[k] = (n[k] ?? 0) + 1);
  let loaded = false;
  let shown = false;
  for (const e of body.ev.slice(0, MAX_EVENTS)) {
    if (!isObj(e)) continue;
    switch (e.t) {
      case 'load': {
        const d = flag(e.d);
        const gpc = flag(e.gpc);
        if (loaded || d === undefined || gpc === undefined) break;
        loaded = true;
        inc('load');
        if (d) inc('load:decided');
        if (gpc) inc('load:gpc');
        inc(`regime:${body.r}`);
        inc(`geo:${geo}:load`);
        break;
      }
      case 'shown':
        if (shown) break;
        shown = true;
        inc('shown');
        inc(`geo:${geo}:shown`);
        break;
      case 'open':
        if (typeof e.via !== 'string' || !OPEN_VIA.has(e.via)) break;
        inc(`open:${e.via}`);
        break;
      case 'decide': {
        if (typeof e.a !== 'string' || !ACTIONS.has(e.a) || typeof e.via !== 'string' || !DECIDE_VIA.has(e.via)) break;
        let ms: number | undefined;
        if (e.ms !== undefined) {
          if (typeof e.ms !== 'number' || !Number.isFinite(e.ms)) break;
          ms = Math.min(MAX_MS, Math.max(0, Math.floor(e.ms)));
        }
        const cats: Array<[string, boolean]> = [];
        if (e.a === 'custom') {
          if (!isObj(e.cats)) break;
          const entries = Object.entries(e.cats);
          if (!entries.length || entries.length > categories.size || entries.some(([k, v]) => !categories.has(k) || typeof v !== 'boolean')) break;
          for (const [k, v] of entries) cats.push([k, v as boolean]);
        }
        inc(`decide:${e.a}:${e.via}`);
        if (ms !== undefined) inc(`ttd:${e.a}:${bucketMs(ms)}`);
        for (const [k, v] of cats) inc(`cat:${k}:${v ? 'on' : 'off'}`);
        inc(`geo:${geo}:decide:${e.a}`);
        break;
      }
      default:
        break;
    }
  }
  return Object.keys(n).length ? n : undefined;
}

// --- Snapshot lookup ------------------------------------------------------------

export interface KnownConfig {
  domain: string;
  categories: Set<string>;
}

const NEGATIVE_TTL_MS = 60_000;
const NEGATIVE_MAX = 1000;

// --- Aggregator -----------------------------------------------------------------

export interface ConsentStatsOptions {
  flushMs: number;
  trustCfGeo: boolean;
  log?: (message: string) => void;
}

/**
 * Receives validated beacons, keeps increments in memory, writes them to storage
 * every `flushMs` and on `flush()` (shutdown). Nothing but counters is ever held.
 */
export class ConsentStats {
  private pending = new Map<string, ConsentStatsDoc>();
  private readonly known = new Map<string, KnownConfig>();
  private readonly unknown = new Map<string, number>();
  private chain: Promise<void> = Promise.resolve();
  private timer?: NodeJS.Timeout;
  private readonly log: (message: string) => void;

  constructor(
    private readonly snapshots: ConfigSnapshotRecords,
    private readonly stats: ConsentStatsRecords,
    private readonly opts: ConsentStatsOptions,
  ) {
    this.log = opts.log ?? ((m) => console.warn(m));
    this.timer = setInterval(() => void this.flush(), opts.flushMs);
    this.timer.unref();
  }

  /** The served config with this hash (cached in memory), or undefined. */
  async lookup(hash: string, now = Date.now()): Promise<KnownConfig | undefined> {
    if (!HASH_RE.test(hash)) return undefined;
    const hit = this.known.get(hash);
    if (hit) return hit;
    const miss = this.unknown.get(hash);
    if (miss !== undefined && now - miss < NEGATIVE_TTL_MS) return undefined;
    let snap: ConfigSnapshot | undefined;
    try {
      snap = await this.snapshots.get(hash);
    } catch (err) {
      this.log(`[consent-stats] snapshot lookup failed: ${(err as Error).message}`);
      return undefined;
    }
    if (!snap) {
      if (this.unknown.size >= NEGATIVE_MAX) this.unknown.clear();
      this.unknown.set(hash, now);
      return undefined;
    }
    const k: KnownConfig = { domain: snap.domain, categories: optionalCategoryIds(snap.config) };
    this.known.set(hash, k);
    return k;
  }

  /**
   * Count one beacon. `body` is the parsed JSON; `originDomain` the Origin's registrable domain.
   * `admit(domain)` is asked once the body is known to belong to that site (the per-site
   * rate limit); false = over budget, nothing counted. Returns 'limited' in that case.
   */
  async ingest(body: unknown, originDomain: string | undefined, geoHeaders: { country?: string; region?: string }, admit: (domain: string) => boolean = () => true): Promise<'counted' | 'dropped' | 'limited'> {
    if (!originDomain || !isObj(body) || typeof body.h !== 'string') return 'dropped';
    const cfg = await this.lookup(body.h);
    if (!cfg || cfg.domain !== originDomain) return 'dropped';
    if (!admit(cfg.domain)) return 'limited';
    const n = countBeacon(body, cfg.categories, geoOf(this.opts.trustCfGeo, geoHeaders.country, geoHeaders.region));
    if (!n) return 'dropped';
    this.add({ domain: cfg.domain, day: new Date().toISOString().slice(0, 10), hash: body.h, n });
    return 'counted';
  }

  private add(doc: ConsentStatsDoc): void {
    const key = `${doc.domain}|${doc.day}|${doc.hash}`;
    const cur = this.pending.get(key);
    if (!cur) {
      this.pending.set(key, { ...doc, n: { ...doc.n } });
      return;
    }
    for (const [k, v] of Object.entries(doc.n)) cur.n[k] = (cur.n[k] ?? 0) + v;
  }

  /** Write what is pending. Concurrent calls queue; a failed write is merged back and retried next time. */
  flush(): Promise<void> {
    const run = this.chain.then(async () => {
      if (!this.pending.size) return;
      const docs = [...this.pending.values()];
      this.pending = new Map();
      try {
        await this.stats.add(docs);
      } catch (err) {
        this.log(`[consent-stats] could not write counters (kept for the next flush): ${(err as Error).message}`);
        for (const d of docs) this.add(d);
      }
    });
    this.chain = run.catch(() => undefined);
    return run;
  }

  /** Stop the timer and write what is left. */
  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    await this.flush();
  }
}

// --- Stats API ------------------------------------------------------------------

const DAY_MS = 86_400_000;
const dayOf = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

/** The per-config-version counters of a site over the last `days` UTC days (today included), newest firstServed first. */
export async function readStats(domain: string, days: number, deps: { stats: ConsentStatsRecords; snapshots: ConfigSnapshotRecords }, now = Date.now()): Promise<ConsentStatsResponse> {
  const to = dayOf(now);
  const from = dayOf(now - (days - 1) * DAY_MS);
  const docs = await deps.stats.read(domain, from, to);
  const byHash = new Map<string, ConsentStatsConfig>();
  for (const d of docs) {
    let c = byHash.get(d.hash);
    if (!c) byHash.set(d.hash, (c = { hash: d.hash, totals: {}, days: [] }));
    c.days.push({ day: d.day, n: d.n });
    for (const [k, v] of Object.entries(d.n)) c.totals[k] = (c.totals[k] ?? 0) + v;
  }
  const configs = [...byHash.values()];
  for (const c of configs) {
    c.days.sort((a, b) => a.day.localeCompare(b.day));
    const snap = await deps.snapshots.get(c.hash);
    if (snap) c.firstServed = snap.firstServed;
  }
  configs.sort((a, b) => (b.firstServed ?? '').localeCompare(a.firstServed ?? ''));
  return { domain, from, to, configs };
}
