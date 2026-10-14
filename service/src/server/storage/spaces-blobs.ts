// Blobs in a DigitalOcean Spaces (S3-compatible) bucket. The bucket is private:
// nothing here sets an ACL, and reports are served through the host.

import fsp from 'node:fs/promises';
import { createReadStream, createWriteStream } from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import {
  DeleteObjectCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';
import { walkLocal } from './fs-blobs.js';
import { assertKey, type BlobInfo, type Blobs, type CloudStorageConfig } from './types.js';

const CONCURRENCY = 8;
/** Bodies up to this size go up in one PutObject; larger or streamed ones use multipart. */
const SINGLE_PUT_MAX = 8 * 1024 * 1024;

const TYPES: Record<string, string> = {
  html: 'text/html; charset=utf-8',
  json: 'application/json',
  har: 'application/json',
  js: 'text/javascript; charset=utf-8',
  css: 'text/css; charset=utf-8',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  svg: 'image/svg+xml',
  txt: 'text/plain; charset=utf-8',
  md: 'text/markdown; charset=utf-8',
  zip: 'application/zip',
  ndjson: 'application/x-ndjson',
  jsonl: 'application/x-ndjson',
};

export function contentTypeFor(key: string): string {
  return TYPES[key.slice(key.lastIndexOf('.') + 1).toLowerCase()] ?? 'application/octet-stream';
}

const isMissing = (err: unknown): boolean => {
  const e = err as { name?: string; $metadata?: { httpStatusCode?: number } };
  return e?.name === 'NotFound' || e?.name === 'NoSuchKey' || e?.$metadata?.httpStatusCode === 404;
};

/** Run `fn` over `items`, at most `limit` at once; the first failure rejects. */
async function pool<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const worker = async () => {
    while (next < items.length) await fn(items[next++]!);
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

export class SpacesBlobs implements Blobs {
  readonly kind = 'spaces' as const;
  private readonly s3: S3Client;
  private readonly bucket: string;

  constructor(cfg: CloudStorageConfig['spaces']) {
    this.bucket = cfg.bucket;
    this.s3 = new S3Client({
      endpoint: cfg.endpoint,
      region: cfg.region,
      forcePathStyle: false,
      credentials: { accessKeyId: cfg.accessKeyId, secretAccessKey: cfg.secretAccessKey },
    });
  }

  async head(key: string): Promise<BlobInfo | null> {
    assertKey(key);
    try {
      const r = await this.s3.send(new HeadObjectCommand({ Bucket: this.bucket, Key: key }));
      return { key, size: r.ContentLength ?? 0, etag: r.ETag ?? '', modified: (r.LastModified ?? new Date(0)).toISOString() };
    } catch (err) {
      if (isMissing(err)) return null;
      throw err;
    }
  }

  async read(key: string): Promise<Readable | null> {
    assertKey(key);
    try {
      const r = await this.s3.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
      return r.Body as Readable;
    } catch (err) {
      if (isMissing(err)) return null;
      throw err;
    }
  }

  async get(key: string): Promise<Buffer | null> {
    const body = await this.read(key);
    if (!body) return null;
    const chunks: Buffer[] = [];
    for await (const c of body) chunks.push(Buffer.from(c as Buffer));
    return Buffer.concat(chunks);
  }

  async put(key: string, body: Buffer | string | Readable, opts: { contentType?: string } = {}): Promise<void> {
    assertKey(key);
    const ContentType = opts.contentType ?? contentTypeFor(key);
    if (typeof body === 'string' || Buffer.isBuffer(body)) {
      await this.s3.send(new PutObjectCommand({ Bucket: this.bucket, Key: key, Body: body, ContentType }));
      return;
    }
    await new Upload({ client: this.s3, params: { Bucket: this.bucket, Key: key, Body: body, ContentType }, queueSize: 4, partSize: 8 * 1024 * 1024 }).done();
  }

  async *list(prefix: string): AsyncIterable<BlobInfo> {
    assertKey(prefix, { prefix: true });
    const out: BlobInfo[] = [];
    let token: string | undefined;
    do {
      const r = await this.s3.send(new ListObjectsV2Command({ Bucket: this.bucket, Prefix: prefix, ContinuationToken: token }));
      for (const o of r.Contents ?? []) {
        if (o.Key) out.push({ key: o.Key, size: o.Size ?? 0, etag: o.ETag ?? '', modified: (o.LastModified ?? new Date(0)).toISOString() });
      }
      token = r.IsTruncated ? r.NextContinuationToken : undefined;
    } while (token);
    out.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
    yield* out;
  }

  async delete(key: string): Promise<void> {
    assertKey(key);
    await this.s3.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
  }

  async deletePrefix(prefix: string): Promise<number> {
    assertKey(prefix, { prefix: true });
    const keys: string[] = [];
    for await (const o of this.list(prefix)) keys.push(o.key);
    for (let i = 0; i < keys.length; i += 1000) {
      const batch = keys.slice(i, i + 1000);
      const r = await this.s3.send(new DeleteObjectsCommand({ Bucket: this.bucket, Delete: { Objects: batch.map((Key) => ({ Key })), Quiet: true } }));
      if (r.Errors?.length) throw new Error(`could not delete ${r.Errors.length} objects under ${prefix}: ${r.Errors[0]?.Message ?? r.Errors[0]?.Code}`);
    }
    return keys.length;
  }

  async download(prefix: string, localDir: string, filter?: (rel: string) => boolean): Promise<number> {
    assertKey(prefix, { prefix: true });
    const items: BlobInfo[] = [];
    for await (const o of this.list(prefix)) {
      assertKey(o.key); // a listed key becomes a local path below: never trust the bucket's idea of a safe name
      if (!filter || filter(o.key.slice(prefix.length))) items.push(o);
    }
    await pool(items, CONCURRENCY, async (o) => {
      const dest = path.join(localDir, ...o.key.slice(prefix.length).split('/'));
      await fsp.mkdir(path.dirname(dest), { recursive: true });
      const body = await this.read(o.key);
      if (!body) throw new Error(`object vanished during download: ${o.key}`);
      await pipeline(body, createWriteStream(dest));
    });
    return items.length;
  }

  async upload(localDir: string, prefix: string, filter?: (rel: string) => boolean): Promise<number> {
    assertKey(prefix, { prefix: true });
    const rels = (await walkLocal(localDir)).filter((rel) => !filter || filter(rel));
    await pool(rels, CONCURRENCY, async (rel) => {
      const file = path.join(localDir, ...rel.split('/'));
      const size = (await fsp.stat(file)).size;
      const key = prefix + rel;
      assertKey(key);
      if (size <= SINGLE_PUT_MAX) await this.put(key, await fsp.readFile(file));
      else await this.put(key, createReadStream(file));
    });
    return rels.length;
  }
}
