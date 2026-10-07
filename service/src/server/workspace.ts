// Site workspaces: DATA_DIR/sites/<registrable-domain>/workspace.json — the
// classifications, task status and notes a team records for one site, the
// latest generated tool config, and pointers to runs (design §10).
//
// Merge rule: every entry is its own key with a timestamp. Different keys
// merge; the same key keeps the latest `at` (a tie goes to the incoming write,
// so resending an edit is harmless). A cleared value is stored as `null` with
// its time, so an older write arriving late can't bring it back.
//
// Writes follow the KB store's pattern (complykit src/research/store.ts): a
// lock directory per site (mkdir is atomic; a lock older than STALE_MS is from
// a crashed process and is broken), then temp file + rename, so a reader sees
// the file before or after a write, never half of one. On top of that, writes
// to one site run one at a time in this process (a promise chain), so the
// lock is only ever contended by another process, and waiting on it is async —
// the KB store's Atomics.wait would stall every request.
//
// A workspace that can't be read is a 500, never an empty workspace: writing
// over it would lose a team's work.

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import type {
  SiteSummary,
  SiteWorkspace,
  SiteWorkspacePatch,
  SiteWorkspacePatchResponse,
  WorkspaceConfig,
  WorkspaceEntry,
  WorkspaceRun,
} from '../shared/api.js';
import { siteDomain } from './domains.js';

/** A workspace failure with the HTTP status the route should answer with. */
export class WorkspaceError extends Error {
  constructor(
    readonly status: number,
    message: string,
    /** Extra fields for the JSON error body (e.g. rerender's `configStored`). */
    readonly extra?: Record<string, unknown>,
  ) {
    super(message);
  }
}

export const WORKSPACE_FILE = 'workspace.json';
export const MAX_ENTRIES = 5000;
export const MAX_RUNS = 200;
const MAX_KEY = 300;
const MAX_BY = 80;
const MAX_ENTRY_BYTES = 16 * 1024;
// The config value carries the config, snippet, change list AND the remediation checklist (tasks with their markup).
const MAX_CONFIG_BYTES = 1024 * 1024;
const MAX_META_BYTES = 8 * 1024;
/** A client clock this far ahead is clamped to ours, so one fast clock can't
 *  freeze a key for everyone else. */
const MAX_SKEW_MS = 5 * 60_000;
const STALE_MS = 30_000;
const WAIT_MS = 15_000;

const RUN_ID_RE = /^[A-Za-z0-9][\w.:-]{0,120}$/;
const RESERVED_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

export function emptyWorkspace(domain: string): SiteWorkspace {
  return { version: 1, domain, entries: {}, runs: [] };
}

// --- Validation ---------------------------------------------------------------------

function bad(message: string): never {
  throw new WorkspaceError(400, message);
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function jsonBytes(v: unknown): number {
  return Buffer.byteLength(JSON.stringify(v) ?? '');
}

function by(v: unknown, field: string, fallback?: string): string | undefined {
  if (v === undefined || v === null) return fallback;
  if (typeof v !== 'string') bad(`\`${field}\` must be a string`);
  const t = v.trim();
  if (t.length > MAX_BY) bad(`\`${field}\` is longer than ${MAX_BY} characters`);
  return t || fallback;
}

/** ISO time → normalized ISO, default now, clamped to now + skew → now. */
function at(v: unknown, field: string, now: number): string {
  if (v === undefined || v === null) return new Date(now).toISOString();
  const ms = typeof v === 'string' ? Date.parse(v) : NaN;
  if (!Number.isFinite(ms)) bad(`\`${field}\` must be an ISO date-time`);
  return new Date(ms > now + MAX_SKEW_MS ? now : ms).toISOString();
}

function entryKey(k: string): string {
  if (!k.length || k.length > MAX_KEY || /[\u0000-\u001f\u007f]/.test(k) || RESERVED_KEYS.has(k)) bad(`not a usable entry key: ${JSON.stringify(k.slice(0, 60))}`);
  return k;
}

function value(v: unknown, field: string, maxBytes: number): unknown {
  if (v === undefined) bad(`\`${field}.value\` is required (null clears it)`);
  if (jsonBytes(v) > maxBytes) bad(`\`${field}.value\` is larger than ${Math.round(maxBytes / 1024)} KB`);
  return v;
}

/** The PATCH body, validated and normalized: every item has its `at`. */
export interface NormalizedPatch {
  entries: Array<[string, WorkspaceEntry]>;
  config?: WorkspaceConfig;
  runs: WorkspaceRun[];
}

export function normalizePatch(body: unknown, now = Date.now()): NormalizedPatch {
  if (!isPlainObject(body)) bad('the body must be a JSON object');
  const p = body as SiteWorkspacePatch;
  const defaultBy = by(p.by, 'by');
  const out: NormalizedPatch = { entries: [], runs: [] };

  if (p.entries !== undefined) {
    if (!isPlainObject(p.entries)) bad('`entries` must be an object keyed by entry key');
    for (const [k, raw] of Object.entries(p.entries)) {
      const key = entryKey(k);
      if (!isPlainObject(raw)) bad(`\`entries[${JSON.stringify(key)}]\` must be { value, at?, by? }`);
      const e: WorkspaceEntry = { value: value(raw.value, `entries[${JSON.stringify(key)}]`, MAX_ENTRY_BYTES), at: at(raw.at, `entries[${JSON.stringify(key)}].at`, now) };
      const who = by(raw.by, `entries[${JSON.stringify(key)}].by`, defaultBy);
      if (who) e.by = who;
      out.entries.push([key, e]);
    }
    if (out.entries.length > MAX_ENTRIES) bad(`more than ${MAX_ENTRIES} entries in one request`);
  }

  if (p.config !== undefined) {
    if (!isPlainObject(p.config)) bad('`config` must be { value, at?, by?, runId? }');
    const c: WorkspaceConfig = { value: value(p.config.value, 'config', MAX_CONFIG_BYTES), at: at(p.config.at, 'config.at', now) };
    const who = by(p.config.by, 'config.by', defaultBy);
    if (who) c.by = who;
    if (p.config.runId !== undefined) {
      if (typeof p.config.runId !== 'string' || !RUN_ID_RE.test(p.config.runId)) bad('`config.runId` is not a run id');
      c.runId = p.config.runId;
    }
    out.config = c;
  }

  if (p.runs !== undefined) {
    if (!Array.isArray(p.runs) || p.runs.length > MAX_RUNS) bad(`\`runs\` must be an array of at most ${MAX_RUNS}`);
    for (const raw of p.runs as unknown[]) {
      if (!isPlainObject(raw)) bad('each run must be { id, at?, jobId?, url?, meta? }');
      if (typeof raw.id !== 'string' || !RUN_ID_RE.test(raw.id)) bad('`runs[].id` is not a run id');
      const r: WorkspaceRun = { id: raw.id, at: at(raw.at, 'runs[].at', now) };
      if (raw.jobId !== undefined) {
        if (typeof raw.jobId !== 'string' || !RUN_ID_RE.test(raw.jobId)) bad('`runs[].jobId` is not a job id');
        r.jobId = raw.jobId;
      }
      if (raw.url !== undefined) {
        if (typeof raw.url !== 'string' || raw.url.length > 2048 || !/^https?:\/\//i.test(raw.url)) bad('`runs[].url` must be an http(s) URL');
        r.url = raw.url;
      }
      if (raw.meta !== undefined) {
        if (!isPlainObject(raw.meta) || jsonBytes(raw.meta) > MAX_META_BYTES) bad(`\`runs[].meta\` must be an object under ${MAX_META_BYTES / 1024} KB`);
        r.meta = raw.meta;
      }
      out.runs.push(r);
    }
  }

  if (!out.entries.length && !out.config && !out.runs.length) bad('nothing to change: send `entries`, `config` or `runs`');
  return out;
}

// --- Merge (pure) ---------------------------------------------------------------------

const newer = (incoming: string, stored: string | undefined): boolean => stored === undefined || Date.parse(incoming) >= Date.parse(stored);

/** Apply a normalized patch to a workspace. Returns a new workspace, what lost,
 *  and whether anything changed (nothing to write when every item was stale). */
export function mergeWorkspace(current: SiteWorkspace, patch: NormalizedPatch, now = Date.now()): SiteWorkspacePatchResponse & { changed: boolean } {
  const ws: SiteWorkspace = structuredClone(current);
  // Null prototype: a key is only ever data.
  ws.entries = Object.assign(Object.create(null) as Record<string, WorkspaceEntry>, ws.entries);
  const stale: SiteWorkspacePatchResponse['stale'] = { entries: [], config: false, runs: [] };
  let changed = false;

  for (const [key, e] of patch.entries) {
    if (newer(e.at, ws.entries[key]?.at)) {
      ws.entries[key] = e;
      changed = true;
    } else stale.entries.push(key);
  }
  if (Object.keys(ws.entries).length > MAX_ENTRIES) throw new WorkspaceError(413, `a workspace holds at most ${MAX_ENTRIES} entries`);

  if (patch.config) {
    if (newer(patch.config.at, ws.config?.at)) {
      ws.config = patch.config;
      changed = true;
    } else stale.config = true;
  }

  if (patch.runs.length) {
    const byId = new Map(ws.runs.map((r) => [r.id, r]));
    for (const r of patch.runs) {
      if (newer(r.at, byId.get(r.id)?.at)) {
        byId.set(r.id, r);
        changed = true;
      } else stale.runs.push(r.id);
    }
    ws.runs = [...byId.values()].sort((a, b) => Date.parse(a.at) - Date.parse(b.at) || a.id.localeCompare(b.id)).slice(-MAX_RUNS);
  }

  if (changed) {
    const stamp = new Date(now).toISOString();
    ws.createdAt ??= stamp;
    ws.updatedAt = stamp;
  }
  // Back to a plain object for JSON (and for callers comparing with toEqual).
  ws.entries = { ...ws.entries };
  return { workspace: ws, stale, changed };
}

// --- Store ---------------------------------------------------------------------------

export class WorkspaceStore {
  private readonly chains = new Map<string, Promise<unknown>>();

  /** `progress`: the checklist count for a site row (injected: the remediation module imports this one). */
  constructor(
    readonly root: string,
    private readonly progress?: (ws: SiteWorkspace) => SiteSummary['checklist'],
  ) {}

  /** Registrable domain for :domain, or a 400. */
  domain(raw: unknown): string {
    const d = siteDomain(raw);
    if (!d) throw new WorkspaceError(400, 'not a site domain');
    return d;
  }

  /** The site's directory, guaranteed to be a direct child of root. */
  siteDir(domain: string): string {
    const root = path.resolve(this.root);
    const dir = path.resolve(root, domain);
    if (path.dirname(dir) !== root || siteDomain(domain) !== domain) throw new WorkspaceError(400, 'not a site domain');
    return dir;
  }

  async get(rawDomain: unknown): Promise<SiteWorkspace> {
    const domain = this.domain(rawDomain);
    return (await this.read(domain)) ?? emptyWorkspace(domain);
  }

  async patch(rawDomain: unknown, body: unknown, now?: () => number): Promise<SiteWorkspacePatchResponse> {
    const domain = this.domain(rawDomain);
    const normalized = normalizePatch(body, now?.() ?? Date.now());
    return this.serialize(domain, () =>
      this.withLock(domain, async () => {
        const current = (await this.read(domain)) ?? emptyWorkspace(domain);
        const { changed, ...result } = mergeWorkspace(current, normalized, now?.() ?? Date.now());
        if (changed) await this.write(domain, result.workspace);
        return result;
      }),
    );
  }

  /** Every site with a workspace, most recently updated first. */
  async list(): Promise<SiteSummary[]> {
    let names: string[];
    try {
      names = await fsp.readdir(this.root);
    } catch {
      return [];
    }
    const out: SiteSummary[] = [];
    for (const name of names) {
      if (siteDomain(name) !== name) continue;
      let ws: SiteWorkspace | undefined;
      try {
        ws = await this.read(name);
      } catch (err) {
        console.warn(`[workspace] skipping ${name}: ${(err as Error).message}`);
        continue;
      }
      if (!ws) continue;
      const s: SiteSummary = {
        domain: ws.domain,
        entries: Object.values(ws.entries).filter((e) => e.value !== null).length,
        runs: ws.runs.length,
      };
      if (ws.updatedAt) s.updatedAt = ws.updatedAt;
      const last = ws.runs.at(-1);
      if (last) s.lastRunAt = last.at;
      if (ws.config) s.configAt = ws.config.at;
      const progress = this.progress?.(ws);
      if (progress) s.checklist = progress;
      out.push(s);
    }
    return out.sort((a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? '') || a.domain.localeCompare(b.domain));
  }

  /** Wait for in-flight writes (server shutdown). */
  async flush(): Promise<void> {
    while (this.chains.size) await Promise.allSettled([...this.chains.values()]);
  }

  // --- internals ------------------------------------------------------------------

  /** undefined = no workspace yet; throws (500) when the file exists but is unreadable. */
  private async read(domain: string): Promise<SiteWorkspace | undefined> {
    const file = path.join(this.siteDir(domain), WORKSPACE_FILE);
    let raw: string;
    try {
      raw = await fsp.readFile(file, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw new WorkspaceError(500, `cannot read the workspace for ${domain}: ${(err as Error).message}`);
    }
    let ws: unknown;
    try {
      ws = JSON.parse(raw);
    } catch {
      ws = undefined;
    }
    if (!isPlainObject(ws) || ws.version !== 1 || ws.domain !== domain || !isPlainObject(ws.entries) || !Array.isArray(ws.runs)) {
      // Refuse rather than start over: a write here would replace the team's work.
      console.error(`[workspace] unreadable: ${file}`);
      throw new WorkspaceError(500, `the workspace for ${domain} is unreadable; it was left untouched (fix or move ${domain}/${WORKSPACE_FILE} on the data volume)`);
    }
    return ws as unknown as SiteWorkspace;
  }

  private async write(domain: string, ws: SiteWorkspace): Promise<void> {
    const dir = this.siteDir(domain);
    const file = path.join(dir, WORKSPACE_FILE);
    const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
    await fsp.mkdir(dir, { recursive: true });
    await fsp.writeFile(tmp, JSON.stringify(ws, null, 2) + '\n');
    await fsp.rename(tmp, file);
  }

  /** One write at a time per site in this process. */
  private serialize<T>(domain: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.chains.get(domain) ?? Promise.resolve();
    const run = prev.then(fn, fn);
    const tail = run.then(
      () => undefined,
      () => undefined,
    );
    this.chains.set(domain, tail);
    void tail.then(() => {
      if (this.chains.get(domain) === tail) this.chains.delete(domain);
    });
    return run;
  }

  /** The KB store's cross-process lock, waiting asynchronously. */
  private async withLock<T>(domain: string, fn: () => Promise<T>): Promise<T> {
    const dir = this.siteDir(domain);
    await fsp.mkdir(dir, { recursive: true });
    const lock = path.join(dir, '.lock');
    const deadline = Date.now() + WAIT_MS;
    for (;;) {
      try {
        await fsp.mkdir(lock);
        break;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
        try {
          if (Date.now() - fs.statSync(lock).mtimeMs > STALE_MS) fs.rmSync(lock, { recursive: true, force: true });
        } catch {
          /* released meanwhile */
        }
        if (Date.now() > deadline) throw new WorkspaceError(503, `the workspace for ${domain} is locked by another process; try again`);
        await new Promise((r) => setTimeout(r, 25));
      }
    }
    try {
      return await fn();
    } finally {
      await fsp.rm(lock, { recursive: true, force: true });
    }
  }
}
