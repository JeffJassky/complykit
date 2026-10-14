// Blobs on a local directory: keys are paths relative to `root`. This is
// today's DATA_DIR layout, so existing data keeps working under the fs backend.

import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { assertKey, type BlobInfo, type Blobs } from './types.js';

const TMP_MARK = '.ckblob-';
const isTmp = (name: string) => name.includes(TMP_MARK) && name.endsWith('.tmp');

export class FsBlobs implements Blobs {
  readonly kind = 'fs' as const;
  private readonly root: string;

  constructor(root: string) {
    this.root = path.resolve(root);
  }

  /** The absolute path for a key (or prefix), verified to stay inside root. */
  private resolve(key: string, prefix = false): string {
    assertKey(key, { prefix });
    const abs = path.resolve(this.root, ...key.replace(/\/$/, '').split('/'));
    if (abs !== this.root && !abs.startsWith(this.root + path.sep)) throw new Error(`not a usable blob key: ${JSON.stringify(key.slice(0, 80))}`);
    return abs;
  }

  private info(key: string, st: fs.Stats): BlobInfo {
    return { key, size: st.size, etag: `${st.size}-${Math.round(st.mtimeMs * 1000)}-${Math.round(st.ctimeMs * 1000)}`, modified: st.mtime.toISOString() };
  }

  async head(key: string): Promise<BlobInfo | null> {
    const file = this.resolve(key);
    try {
      const st = await fsp.stat(file);
      return st.isFile() ? this.info(key, st) : null;
    } catch (err) {
      if (isAbsent(err)) return null;
      throw err;
    }
  }

  async get(key: string): Promise<Buffer | null> {
    const file = this.resolve(key);
    try {
      return await fsp.readFile(file);
    } catch (err) {
      if (isAbsent(err)) return null;
      throw err;
    }
  }

  async read(key: string): Promise<Readable | null> {
    const file = this.resolve(key);
    try {
      const fh = await fsp.open(file, 'r');
      if (!(await fh.stat()).isFile()) {
        await fh.close();
        return null;
      }
      return fh.createReadStream();
    } catch (err) {
      if (isAbsent(err)) return null;
      throw err;
    }
  }

  async put(key: string, body: Buffer | string | Readable): Promise<void> {
    const file = this.resolve(key);
    await fsp.mkdir(path.dirname(file), { recursive: true });
    const tmp = path.join(path.dirname(file), `${TMP_MARK}${process.pid}-${crypto.randomBytes(4).toString('hex')}.tmp`);
    try {
      if (body instanceof Readable) await pipeline(body, fs.createWriteStream(tmp));
      else await fsp.writeFile(tmp, body);
      await fsp.rename(tmp, file);
    } catch (err) {
      await fsp.rm(tmp, { force: true });
      throw err;
    }
  }

  async *list(prefix: string): AsyncIterable<BlobInfo> {
    const dir = this.resolve(prefix, true);
    const out: BlobInfo[] = [];
    await this.walk(dir, prefix, out);
    out.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
    yield* out;
  }

  private async walk(dir: string, keyPrefix: string, out: BlobInfo[]): Promise<void> {
    let entries: fs.Dirent[];
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch (err) {
      if (isAbsent(err)) return;
      throw err;
    }
    for (const e of entries) {
      if (isTmp(e.name)) continue;
      const key = keyPrefix + e.name;
      if (e.isDirectory()) await this.walk(path.join(dir, e.name), key + '/', out);
      else if (e.isFile()) out.push(this.info(key, await fsp.stat(path.join(dir, e.name))));
    }
  }

  async delete(key: string): Promise<void> {
    await fsp.rm(this.resolve(key), { force: true });
  }

  async deletePrefix(prefix: string): Promise<number> {
    const dir = this.resolve(prefix, true);
    let n = 0;
    for await (const _ of this.list(prefix)) n++;
    await fsp.rm(dir, { recursive: true, force: true });
    return n;
  }

  async download(prefix: string, localDir: string, filter?: (rel: string) => boolean): Promise<number> {
    this.resolve(prefix, true);
    let n = 0;
    for await (const info of this.list(prefix)) {
      const rel = info.key.slice(prefix.length);
      if (filter && !filter(rel)) continue;
      const dest = path.join(localDir, ...rel.split('/'));
      await fsp.mkdir(path.dirname(dest), { recursive: true });
      await fsp.copyFile(this.resolve(info.key), dest);
      n++;
    }
    return n;
  }

  async upload(localDir: string, prefix: string, filter?: (rel: string) => boolean): Promise<number> {
    assertKey(prefix, { prefix: true });
    let n = 0;
    for (const rel of await walkLocal(localDir)) {
      if (filter && !filter(rel)) continue;
      const file = this.resolve(prefix + rel);
      await fsp.mkdir(path.dirname(file), { recursive: true });
      const tmp = path.join(path.dirname(file), `${TMP_MARK}${process.pid}-${crypto.randomBytes(4).toString('hex')}.tmp`);
      try {
        await fsp.copyFile(path.join(localDir, ...rel.split('/')), tmp);
        await fsp.rename(tmp, file);
      } catch (err) {
        await fsp.rm(tmp, { force: true });
        throw err;
      }
      n++;
    }
    return n;
  }
}

function isAbsent(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException).code;
  return code === 'ENOENT' || code === 'ENOTDIR';
}

/** Every file under `dir` as '/'-separated relative paths, sorted. */
export async function walkLocal(dir: string, rel = ''): Promise<string[]> {
  const out: string[] = [];
  for (const e of await fsp.readdir(path.join(dir, rel), { withFileTypes: true })) {
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...(await walkLocal(dir, r)));
    else if (e.isFile()) out.push(r);
  }
  return out.sort();
}
