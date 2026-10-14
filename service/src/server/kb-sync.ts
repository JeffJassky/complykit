// The knowledge base lives in a directory (complykit's KbStore, config.kbDir) that
// the CLI reads and writes. With the cloud backend that directory is scratch: it
// is restored from blobs (`kb/…`) when the host starts and uploaded after every
// change. With the fs backend the KB directory is already the durable copy
// (DATA_DIR/kb, or wherever COMPLYKIT_KB_DIR points) and none of this runs.

import { walkLocal } from './storage/fs-blobs.js';
import type { Blobs, Storage } from './storage/types.js';

const PREFIX = 'kb/';
/** Lock directories and temp files are not part of the store. */
const skip = (rel: string): boolean => rel.endsWith('.tmp') || rel.split('/').some((s) => s === '.lock' || s.startsWith('.lock'));

export class KbSync {
  private readonly blobs: Blobs;
  private readonly off: boolean;
  private running?: Promise<void>;
  private dirty = false;

  constructor(
    storage: Pick<Storage, 'kind' | 'blobs'>,
    private readonly kbDir: string,
  ) {
    this.blobs = storage.blobs;
    this.off = storage.kind === 'fs';
  }

  /** Download `kb/` into the KB directory (when blobs have it). Returns how many files. */
  async restore(): Promise<number> {
    if (this.off) return 0;
    return this.blobs.download(PREFIX, this.kbDir, (rel) => !skip(rel));
  }

  /** Upload the KB directory to `kb/` and drop blobs the directory no longer has. Calls overlap safely: one upload at a time, and a call made during one gets another pass. */
  save(): Promise<void> {
    if (this.off) return Promise.resolve();
    this.dirty = true;
    if (this.running) return this.running;
    const run = (async () => {
      for (;;) {
        this.dirty = false;
        try {
          await this.sync();
        } catch (err) {
          console.error(`[kb] could not save the knowledge base to storage: ${(err as Error).message}`);
        }
        if (!this.dirty) {
          this.running = undefined;
          return;
        }
      }
    })();
    this.running = run;
    return run;
  }

  async settled(): Promise<void> {
    while (this.running) await this.running;
  }

  private async sync(): Promise<void> {
    const found = await walkLocal(this.kbDir).catch(() => null);
    if (!found) return; // no directory: nothing to save, and nothing to delete from the stored copy
    const local = new Set(found.filter((r) => !skip(r)));
    await this.blobs.upload(this.kbDir, PREFIX, (rel) => local.has(rel));
    for await (const b of this.blobs.list(PREFIX)) {
      if (!local.has(b.key.slice(PREFIX.length))) await this.blobs.delete(b.key);
    }
  }
}
