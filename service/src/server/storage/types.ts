// Storage contract (plans/do-hosting.md). Two backends behind one shape:
//
//   fs    — today's layout under DATA_DIR (jobs/<id>/job.json, sites/<domain>/…).
//           The default, and what every existing test runs on.
//   cloud — files in a Spaces (S3) bucket, records in MongoDB. Same keys.
//
// Blob keys mirror paths relative to DATA_DIR: `jobs/<jobId>/consent/.comply/runs/<runId>/…`,
// `jobs/<jobId>/accessibility/…`, `kb/…`. A key never starts with '/', never has
// an empty, '.' or '..' segment, a backslash, or a control character (assertKey).
//
// Records are the small, mutable things: job records, site workspaces, consent
// records. Nothing in this module knows about HTTP; errors that a route should
// answer with a status are WorkspaceError (workspace.ts).

import type { Readable } from 'node:stream';
import type { JobDetail, SiteWorkspace } from '../../shared/api.js';
import type { ConsentRecord } from '../consent-records.js';

// --- Blobs ------------------------------------------------------------------------

export interface BlobInfo {
  key: string;
  size: number;
  /** Opaque; changes whenever the content does. */
  etag: string;
  /** ISO time of the last write. */
  modified: string;
}

export interface Blobs {
  readonly kind: 'fs' | 'spaces';
  /** null when absent. */
  head(key: string): Promise<BlobInfo | null>;
  /** The whole object, or null when absent. */
  get(key: string): Promise<Buffer | null>;
  /** A stream of the object, or null when absent. */
  read(key: string): Promise<Readable | null>;
  /** Create or replace. A reader sees the old object or the new one, never part of one. */
  put(key: string, body: Buffer | string | Readable, opts?: { contentType?: string }): Promise<void>;
  /** Every object under `prefix` (which ends with '/'), sorted by key. Empty when none. */
  list(prefix: string): AsyncIterable<BlobInfo>;
  /** Absent is fine. */
  delete(key: string): Promise<void>;
  /** Delete everything under `prefix` (ends with '/'). Returns how many went. */
  deletePrefix(prefix: string): Promise<number>;
  /** Copy every object under `prefix` to `localDir/<key minus prefix>`, creating directories. `filter` sees the key minus prefix. Returns how many were written. */
  download(prefix: string, localDir: string, filter?: (rel: string) => boolean): Promise<number>;
  /** Put every file under `localDir` at `prefix + <relative path with '/'>`. `filter` sees the relative path. Returns how many were put. */
  upload(localDir: string, prefix: string, filter?: (rel: string) => boolean): Promise<number>;
}

const MAX_KEY = 1024;

/** Throws (a plain Error) for a key that could escape its prefix or isn't portable. Prefixes are keys ending in '/'. */
export function assertKey(key: string, opts: { prefix?: boolean } = {}): void {
  const k = opts.prefix ? key.replace(/\/$/, '') : key;
  if (opts.prefix && !key.endsWith('/')) throw new Error(`not a blob prefix (must end with '/'): ${JSON.stringify(key.slice(0, 80))}`);
  const bad =
    !k.length ||
    key.length > MAX_KEY ||
    k.startsWith('/') ||
    k.includes('\\') ||
    // eslint-disable-next-line no-control-regex
    /[\u0000-\u001f\u007f]/.test(k) ||
    k.split('/').some((s) => s === '' || s === '.' || s === '..');
  if (bad) throw new Error(`not a usable blob key: ${JSON.stringify(key.slice(0, 80))}`);
}

// --- Records ----------------------------------------------------------------------

export interface JobRecords {
  /** Every stored job. A record that can't be read is skipped and logged, never fatal. */
  loadAll(): Promise<JobDetail[]>;
  /** Create or replace the job's record (whole document). */
  put(job: JobDetail): Promise<void>;
  /** Absent is fine. Removes only the record (files are Blobs' business). */
  remove(id: string): Promise<void>;
}

export interface StoredWorkspace {
  ws: SiteWorkspace;
  /** Opaque revision; pass it back to `write` to replace exactly this version. */
  rev: string;
}

export interface WorkspaceRecords {
  /** undefined = no workspace yet. Throws WorkspaceError(500) when one exists but is unreadable (never pretend it's empty). */
  read(domain: string): Promise<StoredWorkspace | undefined>;
  /**
   * Replace the workspace only if it is still at `expectedRev` (undefined = only if none exists).
   * Returns the new rev, or null when someone else wrote first (the caller re-reads, re-merges, retries).
   */
  write(domain: string, ws: SiteWorkspace, expectedRev: string | undefined): Promise<string | null>;
  /** Every domain with a workspace, any order. */
  domains(): Promise<string[]>;
}

export interface ConsentRecordRecords {
  /** Append one record. Throws WorkspaceError(507) once the site holds `maxBytes` of records (JSON size). */
  append(domain: string, record: ConsentRecord): Promise<void>;
  exists(domain: string): Promise<boolean>;
  /** The site's records in append order, the first copy of each id only. */
  records(domain: string): AsyncIterable<ConsentRecord>;
  /** Drop records with receivedAt before `cutoffMs`, in every site. A record without a parsable receivedAt is kept. Returns how many went. */
  prune(cutoffMs: number): Promise<number>;
}

export interface Storage {
  readonly kind: 'fs' | 'cloud';
  blobs: Blobs;
  jobs: JobRecords;
  workspaces: WorkspaceRecords;
  consentRecords: ConsentRecordRecords;
  /** Close connections (shutdown, tests). */
  close(): Promise<void>;
}

/** DATA_BACKEND=cloud settings (config.ts reads them from the environment). */
export interface CloudStorageConfig {
  mongoUrl: string;
  /** PEM text of the CA that signed the Mongo server certificate (DigitalOcean's managed Mongo uses its own CA). Unset = the system roots. */
  mongoCa?: string;
  /** Default 'complykit'. */
  mongoDb: string;
  spaces: {
    /** https://nyc3.digitaloceanspaces.com */
    endpoint: string;
    /** The SDK wants one; Spaces ignores it. Default 'us-east-1'. */
    region: string;
    bucket: string;
    accessKeyId: string;
    secretAccessKey: string;
  };
}
