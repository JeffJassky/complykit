// Records in MongoDB: jobs, site workspaces (with an optimistic-write `rev`),
// and consent records (one document per record, in append order).

import crypto from 'node:crypto';
import { MongoClient, type Collection, type Db } from 'mongodb';
import type { JobDetail, SiteWorkspace } from '../../shared/api.js';
import { MAX_FILE_BYTES, type ConsentRecord } from '../consent-records.js';
import { siteDomain } from '../domains.js';
import { WorkspaceError } from '../workspace.js';
import type { ConsentRecordRecords, JobRecords, StoredWorkspace, WorkspaceRecords } from './types.js';

type JobDoc = { _id: string } & Record<string, unknown>;
interface WorkspaceDoc {
  _id: string;
  ws: unknown;
  rev: string;
}
interface ConsentDoc {
  domain: string;
  seq: number;
  record: ConsentRecord;
  bytes: number;
  /** receivedAt as epoch millis; null when it doesn't parse (such a record is never pruned). */
  receivedAtMs: number | null;
}
interface TotalsDoc {
  _id: string;
  bytes: number;
  seq: number;
}

const isPlainObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isDuplicate = (err: unknown): boolean => (err as { code?: number })?.code === 11000;

function dom(domain: string): string {
  if (siteDomain(domain) !== domain) throw new WorkspaceError(400, 'not a site domain');
  return domain;
}

export interface MongoRecords {
  jobs: JobRecords;
  workspaces: WorkspaceRecords;
  consentRecords: ConsentRecordRecords;
  close(): Promise<void>;
  dropDatabase(): Promise<void>;
  corruptWorkspaceForTest(domain: string): Promise<void>;
}

export async function mongoRecords(opts: { url: string; db: string; consentMaxBytes?: number; ca?: string }): Promise<MongoRecords> {
  const client = new MongoClient(opts.url, { ignoreUndefined: true, ...(opts.ca ? { ca: opts.ca } : {}) }); // ignoreUndefined: a cleared field stays absent, as with the fs backend (not stored as null)
  await client.connect();
  const db: Db = client.db(opts.db);
  const jobsC: Collection<JobDoc> = db.collection('jobs');
  const wsC: Collection<WorkspaceDoc> = db.collection('workspaces');
  const recC: Collection<ConsentDoc> = db.collection('consentRecords');
  const totalsC: Collection<TotalsDoc> = db.collection('consentTotals');
  const maxBytes = opts.consentMaxBytes ?? MAX_FILE_BYTES;

  await recC.createIndex({ domain: 1, seq: 1 }, { unique: true });
  await recC.createIndex({ receivedAtMs: 1 });

  const jobs: JobRecords = {
    async loadAll() {
      const out: JobDetail[] = [];
      for await (const doc of jobsC.find()) {
        try {
          const { _id, ...rest } = doc;
          out.push({ ...rest, id: _id } as unknown as JobDetail);
        } catch (err) {
          console.warn(`[store] skipping ${String(doc._id)}: ${(err as Error).message}`);
        }
      }
      return out;
    },
    async put(job) {
      const { id, ...rest } = job;
      await jobsC.replaceOne({ _id: id }, rest as Record<string, unknown>, { upsert: true });
    },
    async remove(id) {
      await jobsC.deleteOne({ _id: id });
    },
  };

  const workspaces: WorkspaceRecords = {
    async read(domain): Promise<StoredWorkspace | undefined> {
      dom(domain);
      const doc = await wsC.findOne({ _id: domain });
      if (!doc) return undefined;
      const ws = doc.ws;
      if (!isPlainObject(ws) || ws.version !== 1 || ws.domain !== domain || !isPlainObject(ws.entries) || !Array.isArray(ws.runs) || typeof doc.rev !== 'string') {
        // Refuse rather than start over: a write here would replace the team's work.
        console.error(`[workspace] unreadable: ${domain}`);
        throw new WorkspaceError(500, `the workspace for ${domain} is unreadable; it was left untouched (fix or remove its document in the workspaces collection)`);
      }
      return { ws: ws as unknown as SiteWorkspace, rev: doc.rev };
    },
    async write(domain, ws, expectedRev) {
      dom(domain);
      const rev = crypto.randomUUID();
      if (expectedRev === undefined) {
        try {
          await wsC.insertOne({ _id: domain, ws, rev });
          return rev;
        } catch (err) {
          if (isDuplicate(err)) return null;
          throw err;
        }
      }
      const r = await wsC.replaceOne({ _id: domain, rev: expectedRev }, { ws, rev });
      return r.matchedCount === 1 ? rev : null;
    },
    async domains() {
      return (await wsC.find({}, { projection: { _id: 1 } }).toArray()).map((d) => d._id);
    },
  };

  const consentRecords: ConsentRecordRecords = {
    async append(domain, record) {
      dom(domain);
      const bytes = Buffer.byteLength(JSON.stringify(record) + '\n');
      const limit = () => new WorkspaceError(507, 'this site has reached its consent-record storage limit; export and prune before posting more');
      // Reserve room and a sequence number in one atomic step: the filter fails once the site is at its limit.
      const reserve = () => totalsC.findOneAndUpdate({ _id: domain, bytes: { $lt: maxBytes } }, { $inc: { bytes, seq: 1 } }, { upsert: true, returnDocument: 'after' });
      let totals: TotalsDoc | null;
      try {
        totals = await reserve();
      } catch (err) {
        if (!isDuplicate(err)) throw err;
        // Either the site is full (the upsert collided with its totals doc) or two first writes raced; try once more.
        try {
          totals = await reserve();
        } catch (err2) {
          if (isDuplicate(err2)) throw limit();
          throw err2;
        }
      }
      if (!totals) throw limit();
      const t = Date.parse(record.receivedAt);
      try {
        await recC.insertOne({ domain, seq: totals.seq, record, bytes, receivedAtMs: Number.isFinite(t) ? t : null });
      } catch (err) {
        await totalsC.updateOne({ _id: domain }, { $inc: { bytes: -bytes } }).catch(() => undefined);
        throw err;
      }
    },
    async exists(domain) {
      dom(domain);
      return (await recC.findOne({ domain }, { projection: { _id: 1 } })) !== null;
    },
    async *records(domain) {
      dom(domain);
      const seen = new Set<string>();
      for await (const doc of recC.find({ domain }).sort({ seq: 1 })) {
        const r = doc.record;
        if (!isPlainObject(r) || typeof r.id !== 'string' || seen.has(r.id)) continue;
        seen.add(r.id);
        yield r;
      }
    },
    async prune(cutoffMs) {
      // $lt on a number never matches null (unparsable), so those records stay.
      const filter = { receivedAtMs: { $lt: cutoffMs } };
      const perSite = await recC.aggregate<{ _id: string; bytes: number }>([{ $match: filter }, { $group: { _id: '$domain', bytes: { $sum: '$bytes' } } }]).toArray();
      let removed = 0;
      for (const site of perSite) {
        const docs = await recC.find({ domain: site._id, ...filter }, { projection: { _id: 1, bytes: 1 } }).toArray();
        if (!docs.length) continue;
        const r = await recC.deleteMany({ _id: { $in: docs.map((d) => d._id) } });
        removed += r.deletedCount;
        // Recompute rather than decrement: a failure between the delete and the update can't leave the total over-counted.
        const [left] = await recC.aggregate<{ bytes: number }>([{ $match: { domain: site._id } }, { $group: { _id: null, bytes: { $sum: '$bytes' } } }]).toArray();
        await totalsC.updateOne({ _id: site._id }, { $set: { bytes: left?.bytes ?? 0 } });
      }
      return removed;
    },
  };

  return {
    jobs,
    workspaces,
    consentRecords,
    close: () => client.close(),
    dropDatabase: async () => void (await db.dropDatabase()),
    corruptWorkspaceForTest: async (domain) => void (await wsC.replaceOne({ _id: domain }, { ws: 'garbage', rev: 'x' }, { upsert: true })),
  };
}
