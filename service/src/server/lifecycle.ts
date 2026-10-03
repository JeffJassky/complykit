// Housekeeping that isn't request handling: restart recovery, the retention
// sweep, and the idle-shutdown rule.

import fsp from 'node:fs/promises';
import type { JobDetail } from '../shared/api.js';
import type { JobStore } from './store.js';

/**
 * After a (re)start: jobs that were running died with the old process, so
 * they fail; jobs still queued never started, so they go back in the queue.
 * Returns the queued ids, oldest first.
 */
export function recoverJobs(store: JobStore, jobs: JobDetail[]): string[] {
  const requeue: JobDetail[] = [];
  for (const job of jobs) {
    if (job.status === 'running') {
      job.status = 'failed';
      job.error = 'interrupted by a restart';
      job.finishedAt = new Date().toISOString();
      job.progress.current = undefined;
      job.metrics.scenarios = job.metrics.scenarios.map((s) => (s.status === 'running' ? { ...s, status: 'not-tested', reason: 'interrupted' } : s));
      job.result = { ...job.result, downloadUrl: `/api/jobs/${job.id}/download` };
      store.update(job);
    } else if (job.status === 'queued') {
      requeue.push(job);
    }
  }
  return requeue.sort((a, b) => a.createdAt.localeCompare(b.createdAt)).map((j) => j.id);
}

/** Delete finished jobs created more than `retentionDays` ago. Also removes
 *  orphan dirs (no readable job.json) by mtime. Returns how many went. */
export async function sweepRetention(store: JobStore, retentionDays: number, now = Date.now()): Promise<number> {
  const cutoff = now - retentionDays * 86_400_000;
  let removed = 0;
  for (const job of store.list()) {
    if (job.status === 'queued' || job.status === 'running') continue;
    if (Date.parse(job.createdAt) < cutoff) {
      await store.remove(job.id);
      removed++;
    }
  }
  let names: string[] = [];
  try {
    names = await fsp.readdir(store.jobsDir);
  } catch {
    /* no jobs dir yet */
  }
  for (const name of names) {
    if (store.get(name)) continue;
    const dir = store.jobDir(name);
    try {
      const st = await fsp.stat(dir);
      if (st.isDirectory() && st.mtimeMs < cutoff) {
        await fsp.rm(dir, { recursive: true, force: true });
        removed++;
      }
    } catch {
      /* raced with something else */
    }
  }
  if (removed) console.log(`[retention] removed ${removed} job(s) older than ${retentionDays} days`);
  return removed;
}

/**
 * The idle rule: shut down only when enabled, nothing is queued or running,
 * and no real request (health checks and SSE pings don't count) arrived in
 * the last N minutes. An open browser tab alone doesn't keep the machine up.
 */
export function idleReason(opts: { idleMinutes: number; busy: boolean; lastActivity: number; now?: number }): string | null {
  if (opts.idleMinutes <= 0 || opts.busy) return null;
  const idleMs = (opts.now ?? Date.now()) - opts.lastActivity;
  if (idleMs < opts.idleMinutes * 60_000) return null;
  return `idle for ${Math.floor(idleMs / 60_000)} min (no jobs, no requests; IDLE_SHUTDOWN_MINUTES=${opts.idleMinutes})`;
}
