// One user of a region's worker at a time. A worker runs one job, and the
// fleet's release stops the Machine, so everything that acquires a region
// (collections, merges, single-location scans, accessibility, Verify) takes
// this lock first and releases the worker before unlocking.

export class RegionLocks {
  private readonly tails = new Map<string, Promise<void>>();
  private readonly holders = new Map<string, number>();

  /** Waits for the region to be free (or the signal to abort); returns the unlock function. `onWait` runs when the region is already in use. */
  async lock(region: string, signal: AbortSignal, onWait: () => void = () => {}): Promise<() => void> {
    const prev = this.tails.get(region) ?? Promise.resolve();
    const contended = (this.holders.get(region) ?? 0) > 0;
    this.holders.set(region, (this.holders.get(region) ?? 0) + 1);
    let open!: () => void;
    const gate = new Promise<void>((r) => (open = r));
    // The next waiter queues behind this one even if this one gives up early.
    this.tails.set(region, prev.then(() => gate));
    let unlocked = false;
    const unlock = () => {
      if (unlocked) return;
      unlocked = true;
      open();
      const n = (this.holders.get(region) ?? 1) - 1;
      if (n <= 0) {
        this.holders.delete(region);
        this.tails.delete(region);
      } else this.holders.set(region, n);
    };
    if (contended) onWait();
    await new Promise<void>((resolve) => {
      if (signal.aborted) return resolve();
      const done = () => {
        signal.removeEventListener('abort', done);
        resolve();
      };
      signal.addEventListener('abort', done, { once: true });
      void prev.then(done);
    });
    if (signal.aborted) {
      unlock();
      throw new Error('cancelled');
    }
    return unlock;
  }
}
