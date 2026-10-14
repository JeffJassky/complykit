import fs from 'node:fs';
import path from 'node:path';
import { timelineArtifact } from './record/index.js';
import type { ConsentEvaluationCollection } from './collect/browser/evaluation/index.js';

// The collect/merge handoff for multi-region scans (plans/multi-region-contract.md §1b):
// a worker in another region collects its location and leaves collection.json in its
// run dir; the primary merges the handoffs and runs the rules over all of them at once.
// No playwright here — the primary merges without a browser.

export const COLLECTION_FILE = 'collection.json';
export const COLLECTION_KIND = 'complykit-consent-collection';
export const COLLECTION_SCHEMA_VERSION = 1;

/** What a collect-only run leaves in its run dir, for a merge. Contains RAW timelines
 *  (unredacted request bodies, cookie values): the rules need them. It is transient:
 *  never copied into a merged run dir, deleted by whoever gathered it. */
export interface ConsentCollectionHandoff {
  kind: typeof COLLECTION_KIND;
  schemaVersion: typeof COLLECTION_SCHEMA_VERSION;
  packageVersion: string;
  property: string;
  targetUrl: string;
  runId: string;
  collection: Omit<ConsentEvaluationCollection, 'artifacts'>;
}

export function writeCollectionHandoff(runDir: string, handoff: ConsentCollectionHandoff): string {
  fs.mkdirSync(runDir, { recursive: true });
  const file = path.join(runDir, COLLECTION_FILE);
  fs.writeFileSync(file, JSON.stringify(handoff));
  return file;
}

export function readCollectionHandoff(runDir: string): ConsentCollectionHandoff {
  const file = path.join(runDir, COLLECTION_FILE);
  if (!fs.existsSync(file)) throw new Error(`no ${COLLECTION_FILE} in ${runDir}`);
  const raw: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw) || (raw as { kind?: unknown }).kind !== COLLECTION_KIND) {
    throw new Error(`${file} is not a complykit consent collection`);
  }
  const v = (raw as { schemaVersion?: unknown }).schemaVersion;
  if (v !== COLLECTION_SCHEMA_VERSION) {
    throw new Error(`${file}: unsupported schema version ${String(v)} (this build reads ${COLLECTION_SCHEMA_VERSION})`);
  }
  return raw as ConsentCollectionHandoff;
}

/** Several single- or multi-location collections of one site → the collection one scan of all
 *  those locations would have produced. Pure; refuses what cannot be one report. */
export function mergeCollections(handoffs: readonly ConsentCollectionHandoff[]): ConsentEvaluationCollection {
  if (!handoffs.length) throw new Error('nothing to merge');
  const first = handoffs[0];
  const seen = new Set<string>();
  for (const h of handoffs) {
    if (h.packageVersion !== first.packageVersion) {
      throw new Error(`version skew: collections were made by complykit ${first.packageVersion} and ${h.packageVersion}`);
    }
    if (h.collection.site.registrableDomain !== first.collection.site.registrableDomain) {
      throw new Error(`different sites: ${first.collection.site.registrableDomain} and ${h.collection.site.registrableDomain}`);
    }
    if (h.property !== first.property) throw new Error(`different properties: ${first.property} and ${h.property}`);
    for (const l of h.collection.locations) {
      if (seen.has(l.spec.id)) throw new Error(`location collected twice: ${l.spec.id}`);
      seen.add(l.spec.id);
    }
  }

  const notTested = new Map<string, ConsentEvaluationCollection['notTested'][number]>();
  const containers = new Map<string, ConsentEvaluationCollection['containers'][number]>();
  for (const { collection: c } of handoffs) {
    for (const n of c.notTested) {
      const key = JSON.stringify([n.scope, n.id, n.location ?? '']);
      if (!notTested.has(key)) notTested.set(key, n);
    }
    for (const ct of c.containers) if (!containers.has(ct.id)) containers.set(ct.id, ct);
  }
  const startedAt = handoffs.map((h) => h.collection.startedAt).reduce((a, b) => (b < a ? b : a));
  const finishedAt = handoffs.map((h) => h.collection.finishedAt).reduce((a, b) => (b > a ? b : a));
  const autoconsentVersion = handoffs.find((h) => h.collection.autoconsentVersion)?.collection.autoconsentVersion;
  const timelines = handoffs.flatMap((h) => h.collection.timelines);
  const site = first.collection.site;
  return {
    artifacts: timelines.map((tl) => timelineArtifact(tl, first.property, site.url, finishedAt)),
    timelines,
    locations: handoffs.flatMap((h) => h.collection.locations),
    notTested: [...notTested.values()],
    site,
    ...(autoconsentVersion ? { autoconsentVersion } : {}),
    containers: [...containers.values()],
    startedAt,
    finishedAt,
  };
}

/** Copy each source's evidence/ tree into the destination run dir. First source wins on a
 *  path collision (same rule as containers). Nothing else is copied; sources are untouched. */
export function mergeEvidence(sourceRunDirs: readonly string[], destRunDir: string): { copied: number; skipped: number } {
  let copied = 0;
  let skipped = 0;
  const walk = (srcRoot: string, rel: string): void => {
    for (const entry of fs.readdirSync(path.join(srcRoot, rel), { withFileTypes: true })) {
      const r = path.join(rel, entry.name);
      if (entry.isDirectory()) walk(srcRoot, r);
      else if (entry.isFile()) {
        const dest = path.join(destRunDir, r);
        if (fs.existsSync(dest)) {
          skipped++;
          continue;
        }
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.copyFileSync(path.join(srcRoot, r), dest);
        copied++;
      }
    }
  };
  for (const src of sourceRunDirs) if (fs.existsSync(path.join(src, 'evidence'))) walk(src, 'evidence');
  return { copied, skipped };
}
