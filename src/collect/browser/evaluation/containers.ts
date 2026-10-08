import fs from 'node:fs';
import path from 'node:path';
import type { Browser } from 'playwright';
import type { ContainerCapture, LocationSpec, Timeline } from '../../../record/index.js';
import { contextOptionsFor } from './location.js';

// Tag-manager container capture (plans/client-consent-design.md §3 #3; ticket
// A2). Every `gtm.js?id=GTM-…` / `gtag/js?id=G-…` a scenario loaded is fetched
// again THROUGH THE SAME LOCATION'S CONTEXT (proxy, locale) — Google serves
// region-specific container variants — and saved to evidence. Parsing is the
// pure parser's job (rules/tracking/gtm.ts); this file only discovers and fetches.

const LOADER_PATH = /\/(gtm\.js|gtag\/js|gtag\/destination)$/;
const CONTAINER_ID = /^(GTM|GT|G|AW|DC|UA|MC)-[A-Z0-9]{4,20}$/i;
const MAX_SEEN_ON = 5;

export interface DiscoveredContainer {
  id: string;
  kind: ContainerCapture['kind'];
  url: string;
  locationId: string;
  seenOn: string[];
}

/** Container loaders seen in the timelines' requests, one per id (first location wins). */
export function discoverContainers(timelines: Timeline[]): DiscoveredContainer[] {
  const byId = new Map<string, DiscoveredContainer>();
  for (const tl of timelines) {
    for (const e of tl.events) {
      if (e.type !== 'request') continue;
      let u: URL;
      try {
        u = new URL(e.url);
      } catch {
        continue;
      }
      if (!LOADER_PATH.test(u.pathname)) continue;
      const id = u.searchParams.get('id')?.trim().toUpperCase();
      if (!id || !CONTAINER_ID.test(id)) continue;
      const kind: ContainerCapture['kind'] = u.pathname.endsWith('/gtm.js') ? 'gtm' : 'gtag';
      // Drop `l=` (dataLayer name) and cache-busters: the id is the resource.
      const url = `${u.origin}${u.pathname}?id=${encodeURIComponent(id)}`;
      let d = byId.get(id);
      if (!d) {
        d = { id, kind, url, locationId: tl.location.id, seenOn: [] };
        byId.set(id, d);
      }
      if (d.seenOn.length < MAX_SEEN_ON && !d.seenOn.includes(e.pageUrl)) d.seenOn.push(e.pageUrl);
    }
  }
  return [...byId.values()];
}

export interface FetchContainersOptions {
  /** Absolute directory the container files are written to. */
  evidenceDir: string;
  /** The same directory, run-relative (what the record points at). */
  evidenceRel: string;
  timeoutMs?: number; // default 20000
  max?: number; // default 12 containers per run
  /** Local-copy mode: rewrite a fetched body the way the scenarios' browser saw it (the saved evidence is the rewritten one). */
  transform?: (url: string, source: string) => string;
}

/**
 * Fetch each discovered container through its location's browser context. A
 * failed fetch is a capture with status 'error' — the parser reports it as
 * 'could not be read', never as a container with no tags.
 */
export async function fetchContainers(
  browser: Browser,
  specs: Map<string, LocationSpec>,
  discovered: DiscoveredContainer[],
  opts: FetchContainersOptions,
): Promise<ContainerCapture[]> {
  const out: ContainerCapture[] = [];
  const timeout = opts.timeoutMs ?? 20000;
  const todo = discovered.slice(0, opts.max ?? 12);
  const byLocation = new Map<string, DiscoveredContainer[]>();
  for (const d of todo) byLocation.set(d.locationId, [...(byLocation.get(d.locationId) ?? []), d]);
  for (const [locationId, items] of byLocation) {
    const spec = specs.get(locationId) ?? { id: locationId };
    let context: Awaited<ReturnType<Browser['newContext']>> | undefined;
    try {
      context = await browser.newContext(contextOptionsFor(spec, browser.version()));
    } catch (err) {
      for (const d of items) out.push({ ...d, fetchedAt: new Date().toISOString(), status: 'error', error: `could not open a context: ${msg(err)}` });
      continue;
    }
    try {
      for (const d of items) {
        const fetchedAt = new Date().toISOString();
        try {
          const res = await context.request.get(d.url, { timeout, headers: { accept: '*/*' }, maxRedirects: 3 });
          const httpStatus = res.status();
          const fetched = await res.text();
          const source = opts.transform && res.ok() ? opts.transform(d.url, fetched) : fetched;
          if (!res.ok()) {
            out.push({ ...d, fetchedAt, status: 'error', httpStatus, bytes: source.length, error: `HTTP ${httpStatus}` });
            continue;
          }
          fs.mkdirSync(opts.evidenceDir, { recursive: true });
          const file = `${d.id}.js`;
          fs.writeFileSync(path.join(opts.evidenceDir, file), source);
          out.push({ ...d, fetchedAt, status: 'ok', httpStatus, bytes: source.length, evidencePath: path.posix.join(opts.evidenceRel.split(path.sep).join('/'), file), source });
        } catch (err) {
          out.push({ ...d, fetchedAt, status: 'error', error: msg(err) });
        }
      }
    } finally {
      await context.close().catch(() => {});
    }
  }
  return out;
}

function msg(err: unknown): string {
  return err instanceof Error ? err.message.slice(0, 160) : 'failed';
}
