// The fs backend: today's DATA_DIR layout (jobs/<id>/job.json,
// sites/<domain>/workspace.json, sites/<domain>/consent-records.jsonl), so
// existing data keeps working. Mirrors store.ts, workspace.ts and
// consent-records.ts file handling.

import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import type { ConfigSnapshot, JobDetail, SiteWorkspace } from '../../shared/api.js';
import { CONSENT_FILE, MAX_FILE_BYTES, type ConsentRecord } from '../consent-records.js';
import { siteDomain } from '../domains.js';
import { isJobId } from '../store.js';
import { WORKSPACE_FILE, WorkspaceError } from '../workspace.js';
import { FsBlobs } from './fs-blobs.js';
import type { ConfigSnapshotRecords, ConsentRecordRecords, JobRecords, StoredWorkspace, Storage, WorkspaceRecords } from './types.js';

const STALE_MS = 30_000;
const WAIT_MS = 15_000;

const isPlainObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** One-at-a-time queue per key, in this process. */
class Chains {
  private readonly chains = new Map<string, Promise<unknown>>();
  run<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.chains.get(key) ?? Promise.resolve();
    const run = prev.then(fn, fn);
    const tail = run.then(
      () => undefined,
      () => undefined,
    );
    this.chains.set(key, tail);
    void tail.then(() => {
      if (this.chains.get(key) === tail) this.chains.delete(key);
    });
    return run;
  }
}

async function atomicWrite(file: string, data: string): Promise<void> {
  const tmp = `${file}.${process.pid}.${Date.now()}.${crypto.randomBytes(3).toString('hex')}.tmp`;
  await fsp.mkdir(path.dirname(file), { recursive: true });
  try {
    await fsp.writeFile(tmp, data);
    await fsp.rename(tmp, file);
  } catch (err) {
    await fsp.rm(tmp, { force: true });
    throw err;
  }
}

class FsJobs implements JobRecords {
  private readonly jobsDir: string;
  constructor(dataDir: string) {
    this.jobsDir = path.join(dataDir, 'jobs');
  }

  async loadAll(): Promise<JobDetail[]> {
    let names: string[];
    try {
      names = await fsp.readdir(this.jobsDir);
    } catch {
      return [];
    }
    const out: JobDetail[] = [];
    for (const name of names) {
      if (!isJobId(name)) continue;
      try {
        const job = JSON.parse(await fsp.readFile(path.join(this.jobsDir, name, 'job.json'), 'utf8')) as JobDetail;
        if (job.id !== name) continue;
        out.push(job);
      } catch (err) {
        console.warn(`[store] skipping ${name}: ${(err as Error).message}`);
      }
    }
    return out;
  }

  async put(job: JobDetail): Promise<void> {
    if (!isJobId(job.id)) throw new Error(`not a job id: ${JSON.stringify(String(job.id).slice(0, 40))}`);
    await atomicWrite(path.join(this.jobsDir, job.id, 'job.json'), JSON.stringify(job, null, 2));
  }

  async remove(id: string): Promise<void> {
    if (!isJobId(id)) return;
    await fsp.rm(path.join(this.jobsDir, id, 'job.json'), { force: true });
  }
}

function siteDirOf(sitesRoot: string, domain: string): string {
  const root = path.resolve(sitesRoot);
  const dir = path.resolve(root, domain);
  if (path.dirname(dir) !== root || siteDomain(domain) !== domain) throw new WorkspaceError(400, 'not a site domain');
  return dir;
}

class FsWorkspaces implements WorkspaceRecords {
  private readonly chains = new Chains();
  constructor(private readonly sitesRoot: string) {}

  async read(domain: string): Promise<StoredWorkspace | undefined> {
    const file = path.join(siteDirOf(this.sitesRoot, domain), WORKSPACE_FILE);
    let raw: Buffer;
    try {
      raw = await fsp.readFile(file);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw new WorkspaceError(500, `cannot read the workspace for ${domain}: ${(err as Error).message}`);
    }
    let ws: unknown;
    try {
      ws = JSON.parse(raw.toString('utf8'));
    } catch {
      ws = undefined;
    }
    if (!isPlainObject(ws) || ws.version !== 1 || ws.domain !== domain || !isPlainObject(ws.entries) || !Array.isArray(ws.runs)) {
      // Refuse rather than start over: a write here would replace the team's work.
      console.error(`[workspace] unreadable: ${file}`);
      throw new WorkspaceError(500, `the workspace for ${domain} is unreadable; it was left untouched (fix or move ${domain}/${WORKSPACE_FILE} on the data volume)`);
    }
    return { ws: ws as unknown as SiteWorkspace, rev: crypto.createHash('sha256').update(raw).digest('hex') };
  }

  async write(domain: string, ws: SiteWorkspace, expectedRev: string | undefined): Promise<string | null> {
    const dir = siteDirOf(this.sitesRoot, domain);
    return await this.chains.run(domain, () =>
      this.withLock(dir, domain, async () => {
        const current = await this.readRev(dir);
        if (current !== expectedRev) return null;
        const data = JSON.stringify(ws, null, 2) + '\n';
        await atomicWrite(path.join(dir, WORKSPACE_FILE), data);
        return crypto.createHash('sha256').update(data).digest('hex');
      }),
    );
  }

  /** Rev of the file as it is now (undefined when absent), without validating it. */
  private async readRev(dir: string): Promise<string | undefined> {
    try {
      return crypto
        .createHash('sha256')
        .update(await fsp.readFile(path.join(dir, WORKSPACE_FILE)))
        .digest('hex');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw new WorkspaceError(500, `cannot read the workspace: ${(err as Error).message}`);
    }
  }

  async domains(): Promise<string[]> {
    let names: string[];
    try {
      names = await fsp.readdir(this.sitesRoot);
    } catch {
      return [];
    }
    const out: string[] = [];
    for (const name of names) {
      if (siteDomain(name) !== name) continue;
      try {
        if ((await fsp.stat(path.join(this.sitesRoot, name, WORKSPACE_FILE))).isFile()) out.push(name);
      } catch {
        /* no workspace */
      }
    }
    return out;
  }

  /** The KB store's cross-process lock directory, waiting asynchronously. */
  private async withLock<T>(dir: string, domain: string, fn: () => Promise<T>): Promise<T> {
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

class FsConsentRecords implements ConsentRecordRecords {
  private readonly chains = new Chains();
  constructor(
    private readonly sitesRoot: string,
    private readonly maxFileBytes: number,
  ) {}

  private file(domain: string): string {
    return path.join(siteDirOf(this.sitesRoot, domain), CONSENT_FILE);
  }

  async append(domain: string, record: ConsentRecord): Promise<void> {
    const file = this.file(domain);
    await this.chains.run(domain, async () => {
      try {
        if ((await fsp.stat(file)).size >= this.maxFileBytes) throw new WorkspaceError(507, 'this site has reached its consent-record storage limit; export and prune before posting more');
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
      }
      await fsp.mkdir(path.dirname(file), { recursive: true });
      await fsp.appendFile(file, JSON.stringify(record) + '\n');
    });
  }

  async exists(domain: string): Promise<boolean> {
    try {
      await fsp.access(this.file(domain));
      return true;
    } catch (err) {
      if (err instanceof WorkspaceError) throw err;
      return false;
    }
  }

  async *records(domain: string): AsyncIterable<ConsentRecord> {
    const file = this.file(domain);
    if (!(await this.exists(domain))) return;
    const seen = new Set<string>();
    const rl = readline.createInterface({ input: createReadStream(file, 'utf8'), crlfDelay: Infinity });
    for await (const line of rl) {
      if (!line.trim()) continue;
      let r: ConsentRecord;
      try {
        r = JSON.parse(line) as ConsentRecord;
      } catch {
        continue; // a torn line (crash mid-append) is skipped, not fatal
      }
      if (!isPlainObject(r) || typeof r.id !== 'string' || seen.has(r.id)) continue;
      seen.add(r.id);
      yield r;
    }
  }

  async prune(cutoffMs: number): Promise<number> {
    let names: string[];
    try {
      names = await fsp.readdir(this.sitesRoot);
    } catch {
      return 0;
    }
    let removed = 0;
    for (const name of names) {
      if (siteDomain(name) !== name) continue;
      try {
        removed += await this.pruneSite(name, cutoffMs);
      } catch (err) {
        console.warn(`[consent-records] prune ${name}: ${(err as Error).message}`);
      }
    }
    return removed;
  }

  private pruneSite(domain: string, cutoff: number): Promise<number> {
    const file = this.file(domain);
    return this.chains.run(domain, async () => {
      let raw: string;
      try {
        raw = await fsp.readFile(file, 'utf8');
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') return 0;
        throw err;
      }
      const lines = raw.split('\n').filter((l) => l.trim());
      // A line that can't be parsed is kept: pruning never destroys what it can't read.
      const keep = lines.filter((l) => {
        try {
          const t = Date.parse((JSON.parse(l) as { receivedAt?: string }).receivedAt ?? '');
          return !(Number.isFinite(t) && t < cutoff);
        } catch {
          return true;
        }
      });
      const removed = lines.length - keep.length;
      if (!removed) return 0;
      await atomicWrite(file, keep.length ? keep.join('\n') + '\n' : '');
      return removed;
    });
  }
}

const HASH_RE = /^[0-9a-f]{64}$/;

/** DATA_DIR/config-snapshots/<hash>.json, written once. */
class FsConfigSnapshots implements ConfigSnapshotRecords {
  private readonly chains = new Chains();
  constructor(private readonly dir: string) {}

  async put(snapshot: ConfigSnapshot): Promise<void> {
    if (!HASH_RE.test(snapshot.hash)) throw new Error('not a config hash');
    const file = path.join(this.dir, `${snapshot.hash}.json`);
    await this.chains.run(snapshot.hash, async () => {
      try {
        await fsp.access(file);
        return;
      } catch {
        /* not there yet */
      }
      await atomicWrite(file, JSON.stringify(snapshot) + '\n');
    });
  }

  async get(hash: string): Promise<ConfigSnapshot | undefined> {
    if (!HASH_RE.test(hash)) return undefined;
    try {
      const v = JSON.parse(await fsp.readFile(path.join(this.dir, `${hash}.json`), 'utf8')) as unknown;
      return isPlainObject(v) && v.hash === hash ? (v as unknown as ConfigSnapshot) : undefined;
    } catch {
      return undefined;
    }
  }
}

export function fsStorage(dataDir: string, opts: { consentMaxBytes?: number } = {}): Storage {
  const sites = path.join(dataDir, 'sites');
  return {
    kind: 'fs',
    blobs: new FsBlobs(dataDir),
    jobs: new FsJobs(dataDir),
    workspaces: new FsWorkspaces(sites),
    consentRecords: new FsConsentRecords(sites, opts.consentMaxBytes ?? MAX_FILE_BYTES),
    configSnapshots: new FsConfigSnapshots(path.join(dataDir, 'config-snapshots')),
    close: async () => undefined,
  };
}
