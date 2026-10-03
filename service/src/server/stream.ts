// GET /api/stream — server-sent events. Every job change is pushed as a
// `job` event (throttled per job), deletions as `removed`, plus a `ping`
// every 20s so proxies keep the connection open.

import type { Request, Response } from 'express';
import type { StreamEvent } from '../shared/api.js';
import { toSummary, type JobStore } from './store.js';

const THROTTLE_MS = 250; // ≤ 4 events/s per job
const PING_MS = 20_000;

export class StreamHub {
  private readonly clients = new Set<Response>();
  private readonly lastSent = new Map<string, number>();
  private readonly pending = new Map<string, NodeJS.Timeout>();
  private readonly ping: NodeJS.Timeout;

  constructor(private readonly store: JobStore) {
    store.on('change', (job) => this.schedule(job.id));
    store.on('removed', (id) => {
      clearTimeout(this.pending.get(id));
      this.pending.delete(id);
      this.lastSent.delete(id);
      this.broadcast({ event: 'removed', data: { id } });
    });
    this.ping = setInterval(() => this.broadcast({ event: 'ping', data: {} }), PING_MS);
    this.ping.unref();
  }

  get size(): number {
    return this.clients.size;
  }

  handle = (req: Request, res: Response): void => {
    res.status(200);
    res.set({
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.flushHeaders();
    // Tell EventSource how long to wait before reconnecting.
    res.write('retry: 3000\n\n');
    this.clients.add(res);
    req.on('close', () => this.clients.delete(res));
  };

  /** End every open stream (shutdown) so server.close() can complete. */
  closeAll(): void {
    clearInterval(this.ping);
    for (const t of this.pending.values()) clearTimeout(t);
    this.pending.clear();
    for (const res of this.clients) res.end();
    this.clients.clear();
  }

  /** Leading + trailing throttle: the first change goes out immediately, a
   *  burst collapses into one trailing event carrying the latest state. */
  private schedule(id: string): void {
    if (this.pending.has(id)) return;
    const wait = (this.lastSent.get(id) ?? 0) + THROTTLE_MS - Date.now();
    if (wait <= 0) return this.sendJob(id);
    this.pending.set(
      id,
      setTimeout(() => {
        this.pending.delete(id);
        this.sendJob(id);
      }, wait),
    );
  }

  private sendJob(id: string): void {
    const job = this.store.get(id);
    if (!job) return;
    this.lastSent.set(id, Date.now());
    this.broadcast({ event: 'job', data: toSummary(job) });
  }

  private broadcast(ev: StreamEvent): void {
    if (!this.clients.size) return;
    const frame = `event: ${ev.event}\ndata: ${JSON.stringify(ev.data)}\n\n`;
    for (const res of this.clients) res.write(frame);
  }
}
