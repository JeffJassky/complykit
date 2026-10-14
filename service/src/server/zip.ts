// GET /api/jobs/:id/download — the job directory as a zip, with the CLI's
// timestamped run folders flattened into readable names:
//
//   complykit-<host>-<date>/
//     job.json
//     consent/consent-report.html, evidence/…, tracking.json, events.ndjson …
//     accessibility/report.html, report.json, run/…
//
// Flattening keeps the consent report's run-relative `evidence/…` links valid.

import fsp from 'node:fs/promises';
import path from 'node:path';
import { ZipArchive } from 'archiver';
import type { Response } from 'express';
import type { JobDetail } from '../shared/api.js';

export async function walk(dir: string, rel = ''): Promise<string[]> {
  const out: string[] = [];
  let entries;
  try {
    entries = await fsp.readdir(path.join(dir, rel), { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...(await walk(dir, r)));
    else if (e.isFile()) out.push(r);
  }
  return out;
}

/** Map a job-dir-relative path to its name in the zip, or null to skip it. */
export function zipName(rel: string, runCounts: Record<string, number>): string | null {
  if (rel.endsWith('.tmp')) return null;
  const m = /^(consent|accessibility)\/\.comply\/(.*)$/.exec(rel);
  if (!m) return rel;
  const [, check, inner] = m;
  const run = /^runs\/([^/]+)\/(.+)$/.exec(inner);
  if (!run) return null; // .comply/cache etc. — regenerable, not evidence
  const [, runId, file] = run;
  const base = check === 'consent' ? 'consent' : 'accessibility/run';
  // One run per check is the norm; if there were more, keep them apart.
  return (runCounts[check] ?? 0) > 1 ? `${base}/${runId}/${file}` : `${base}/${file}`;
}

export function zipFilename(job: JobDetail): string {
  const host = job.host.replace(/[^a-z0-9.-]+/gi, '-');
  return `complykit-${host}-${job.createdAt.slice(0, 10)}`;
}

export async function sendJobZip(res: Response, job: JobDetail, jobDir: string): Promise<void> {
  const files = await walk(jobDir);
  const runCounts: Record<string, number> = {};
  for (const check of ['consent', 'accessibility']) {
    const runs = new Set(files.map((f) => new RegExp(`^${check}/\\.comply/runs/([^/]+)/`).exec(f)?.[1]).filter(Boolean));
    runCounts[check] = runs.size;
  }
  const root = zipFilename(job);
  res.status(200);
  res.set('Content-Type', 'application/zip');
  res.attachment(`${root}.zip`);

  const zip = new ZipArchive({ zlib: { level: 6 } });
  zip.on('warning', (err: Error) => console.warn(`[zip] ${job.id}: ${err.message}`));
  zip.on('error', (err: Error) => {
    console.error(`[zip] ${job.id}: ${err.message}`);
    res.destroy(err);
  });
  res.on('close', () => {
    if (!res.writableFinished) zip.abort();
  });
  zip.pipe(res);
  for (const rel of files.sort()) {
    const name = zipName(rel, runCounts);
    if (name) zip.file(path.join(jobDir, rel), { name: `${root}/${name}` });
  }
  await zip.finalize();
}
