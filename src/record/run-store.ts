import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { Run, Finding, SCHEMA_VERSION } from './schema.js';
import type { RunId } from './ids.js';
import { asRunId } from './ids.js';

// Files are the data layer (build-plan §7). A run is a directory:
//
//   .comply/runs/<run-id>/
//     run.json          run metadata + coverage
//     findings.jsonl     one Finding per line, append-only
//     evidence/          content-addressed: <sha256-16>.<ext>
//
// JSONL so diff/report stream and a partial (crashed) run stays readable.
// Evidence is content-addressed so repeated crops dedupe and refs stay stable.

export const COMPLY_DIR = '.comply';

export function runsRoot(cwd = process.cwd()): string {
  return path.join(cwd, COMPLY_DIR, 'runs');
}

export function runDir(runId: RunId, cwd = process.cwd()): string {
  return path.join(runsRoot(cwd), runId);
}

/** A filesystem-safe run id from a timestamp: colons break Windows paths. */
export function runIdFromTimestamp(iso: string): RunId {
  return asRunId(iso.replace(/:/g, '-'));
}

function ensureDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
}

/** Guard against reading a record written by a newer, breaking schema. */
function assertReadableVersion(kind: string, version: unknown, file: string): void {
  const major = typeof version === 'number' ? version : 0;
  if (major > SCHEMA_VERSION) {
    throw new Error(
      `${file}: ${kind} schemaVersion ${major} is newer than this build understands ` +
        `(${SCHEMA_VERSION}). Upgrade complykit rather than guessing at the shape.`,
    );
  }
}

// --- Run --------------------------------------------------------------------

export function writeRun(run: Run, cwd = process.cwd()): string {
  const dir = runDir(run.id, cwd);
  ensureDir(dir);
  ensureDir(path.join(dir, 'evidence'));
  fs.writeFileSync(path.join(dir, 'run.json'), JSON.stringify(Run.parse(run), null, 2));
  // touch findings.jsonl so a run with zero findings is still a readable run.
  const findingsPath = path.join(dir, 'findings.jsonl');
  if (!fs.existsSync(findingsPath)) fs.writeFileSync(findingsPath, '');
  return dir;
}

export function readRun(runId: RunId, cwd = process.cwd()): Run {
  const file = path.join(runDir(runId, cwd), 'run.json');
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  assertReadableVersion('run', raw.schemaVersion, file);
  return Run.parse(raw);
}

export function loadRun(runId: RunId, cwd = process.cwd()): { run: Run; findings: Finding[] } {
  return { run: readRun(runId, cwd), findings: readFindings(runId, cwd) };
}

export function listRuns(property?: string, cwd = process.cwd()): Run[] {
  const root = runsRoot(cwd);
  if (!fs.existsSync(root)) return [];
  const runs: Run[] = [];
  for (const name of fs.readdirSync(root)) {
    const runJson = path.join(root, name, 'run.json');
    if (!fs.existsSync(runJson)) continue;
    try {
      const run = readRun(asRunId(name), cwd);
      if (!property || run.property === property) runs.push(run);
    } catch {
      // A half-written run.json is skipped, not fatal to `list`.
    }
  }
  // Newest first — run ids are timestamp-derived and sort lexically.
  return runs.sort((a, b) => (a.id < b.id ? 1 : -1));
}

// --- Findings ---------------------------------------------------------------

export function appendFinding(runId: RunId, finding: Finding, cwd = process.cwd()): void {
  const dir = runDir(runId, cwd);
  ensureDir(dir);
  fs.appendFileSync(path.join(dir, 'findings.jsonl'), JSON.stringify(Finding.parse(finding)) + '\n');
}

export function readFindings(runId: RunId, cwd = process.cwd()): Finding[] {
  const file = path.join(runDir(runId, cwd), 'findings.jsonl');
  if (!fs.existsSync(file)) return [];
  const out: Finding[] = [];
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const raw = JSON.parse(trimmed);
    assertReadableVersion('finding', raw.schemaVersion, file);
    out.push(Finding.parse(raw));
  }
  return out;
}

// --- Evidence (content-addressed) ------------------------------------------

/**
 * Store a payload under `evidence/<sha256-16>.<ext>` and return the run-relative
 * path. Identical payloads collapse to one file, so an evidence ref is stable
 * across runs and repeated crops cost one write.
 */
export function putEvidence(
  runId: RunId,
  payload: Buffer | string,
  ext: string,
  cwd = process.cwd(),
): string {
  const buf = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const hash = createHash('sha256').update(buf).digest('hex').slice(0, 16);
  const cleanExt = ext.replace(/^\./, '');
  const rel = path.join('evidence', `${hash}.${cleanExt}`);
  const abs = path.join(runDir(runId, cwd), rel);
  ensureDir(path.dirname(abs));
  if (!fs.existsSync(abs)) fs.writeFileSync(abs, buf);
  return rel;
}
