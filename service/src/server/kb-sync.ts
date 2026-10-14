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
  /** The last save failed (after every retry, or while retries are pending): the stored copy is behind the directory. */
  private unsaved = false;
  /**
   * Files the directory held at the last restore or successful sync. A blob is deleted only when its file is in
   * here and no longer in the directory, i.e. THIS process deleted it. A blob this process never saw (a newer
   * instance wrote it during a zero-downtime deploy overlap) is never deleted.
   */
  private known = new Set<string>();

  constructor(
    storage: Pick<Storage, 'kind' | 'blobs'>,
    private readonly kbDir: string,
    /** Waits between attempts at a failed save (5 attempts over ~30 s by default). */
    private readonly retryMs: number[] = [2000, 4000, 8000, 16000],
  ) {
    this.blobs = storage.blobs;
    this.off = storage.kind === 'fs';
  }

  /** Download `kb/` into the KB directory (when blobs have it). Returns how many files. */
  async restore(): Promise<number> {
    if (this.off) return 0;
    const n = await this.blobs.download(PREFIX, this.kbDir, (rel) => !skip(rel));
    const found = await walkLocal(this.kbDir).catch(() => []);
    this.known = new Set(found.filter((r) => !skip(r)));
    return n;
  }

  /** Upload the KB directory to `kb/` (and drop the blobs of files this process deleted). Calls overlap safely: one upload at a time, and a call made during one gets another pass. A failed pass is retried with backoff. */
  save(): Promise<void> {
    if (this.off) return Promise.resolve();
    this.dirty = true;
    if (this.running) return this.running;
    const run = (async () => {
      let failures = 0;
      for (;;) {
        this.dirty = false;
        try {
          await this.sync();
          this.unsaved = false;
          failures = 0;
        } catch (err) {
          this.unsaved = true;
          failures++;
          if (failures <= this.retryMs.length) {
            console.warn(`[kb] could not save the knowledge base (attempt ${failures}, retrying): ${(err as Error).message}`);
            this.dirty = true; // a confirm must not be lost to a blip: this disk does not survive a restart
            await new Promise((r) => setTimeout(r, this.retryMs[failures - 1]));
          } else {
            console.error(`[kb] could not save the knowledge base to storage after ${failures} attempts: ${(err as Error).message}`);
            failures = 0; // the next change starts afresh
          }
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

  /** Resolves when no save is pending. Logs if the last save still failed. */
  async settled(): Promise<void> {
    while (this.running) await this.running;
    if (this.unsaved) console.error('[kb] the knowledge base has changes that are not saved to storage');
  }

  /** Shutdown: wait for the pending save; says so if something is still unsaved. */
  stop(): Promise<void> {
    return this.settled();
  }

  private async sync(): Promise<void> {
    const found = await walkLocal(this.kbDir).catch(() => null);
    if (!found) return; // no directory: nothing to save, and nothing to delete from the stored copy
    const local = new Set(found.filter((r) => !skip(r)));
    await this.blobs.upload(this.kbDir, PREFIX, (rel) => local.has(rel));
    for (const rel of this.known) {
      if (!local.has(rel)) await this.blobs.delete(PREFIX + rel);
    }
    this.known = local;
  }
}
