import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { KbSync } from '../src/server/kb-sync.js';
import { FsBlobs } from '../src/server/storage/fs-blobs.js';
import type { Blobs } from '../src/server/storage/types.js';
import { tempDir } from './helpers.js';

const write = (dir: string, rel: string, body: string) => {
  fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
  fs.writeFileSync(path.join(dir, rel), body);
};

describe('KbSync', () => {
  it('retries a failed save with backoff and keeps the change', async () => {
    const blobDir = tempDir();
    const real = new FsBlobs(blobDir);
    let fails = 2;
    const blobs: Blobs = Object.create(real) as Blobs;
    blobs.upload = async (...a) => {
      if (fails-- > 0) throw new Error('spaces blip');
      return real.upload(...a);
    };
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const kb = tempDir();
    write(kb, 'queue.json', '[1]');
    const sync = new KbSync({ kind: 'cloud', blobs }, kb, [1, 1, 1]);
    await sync.save();
    expect((await real.get('kb/queue.json'))?.toString()).toBe('[1]');
  });

  it('never deletes a blob this process did not see (a newer instance wrote it); deletes what it deleted itself', async () => {
    const blobs = new FsBlobs(tempDir());
    await blobs.put('kb/old.json', 'old');
    const kb = tempDir();
    const sync = new KbSync({ kind: 'cloud', blobs }, kb);
    await sync.restore();
    expect(fs.existsSync(path.join(kb, 'old.json'))).toBe(true);
    // A newer instance writes another file after our restore.
    await blobs.put('kb/newer.json', 'newer');
    write(kb, 'mine.json', 'mine');
    await sync.save();
    expect(await blobs.get('kb/newer.json')).not.toBeNull();
    expect(await blobs.get('kb/mine.json')).not.toBeNull();
    // We delete old.json: that one goes.
    fs.rmSync(path.join(kb, 'old.json'));
    await sync.save();
    expect(await blobs.get('kb/old.json')).toBeNull();
    expect(await blobs.get('kb/newer.json')).not.toBeNull();
  });

  it('stop() logs when the last save is still unsaved', async () => {
    const real = new FsBlobs(tempDir());
    const blobs: Blobs = Object.create(real) as Blobs;
    blobs.upload = async () => {
      throw new Error('down');
    };
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const kb = tempDir();
    write(kb, 'queue.json', '[]');
    const sync = new KbSync({ kind: 'cloud', blobs }, kb, [1]);
    void sync.save();
    await sync.stop();
    expect(err.mock.calls.some((c) => String(c[0]).includes('not saved'))).toBe(true);
  });
});
