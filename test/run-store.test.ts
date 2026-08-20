import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  writeRun,
  readRun,
  putEvidence,
  runIdFromTimestamp,
  runDir,
  asRunId,
  REGISTRY_VERSION,
  type Run,
} from '../src/index.js';

let cwd: string;
beforeEach(() => {
  cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'complykit-'));
});
afterEach(() => {
  fs.rmSync(cwd, { recursive: true, force: true });
});

function run(id = runIdFromTimestamp('2026-08-19T10:00:00.000Z')): Run {
  return {
    schemaVersion: 1,
    id: asRunId(id),
    property: 'shop',
    startedAt: '2026-08-19T00:00:00.000Z',
    versions: { package: '0.0.0', registry: REGISTRY_VERSION, engines: {} },
    accessLevels: [],
    matrix: [],
    gaps: [],
    rulesExecuted: [],
  };
}

describe('run store', () => {
  it('a colon-free run id keeps the run directory portable', () => {
    const id = runIdFromTimestamp('2026-08-19T10:00:00.000Z');
    expect(String(id)).not.toContain(':');
  });

  it('refuses to read a run written by a newer schema major', () => {
    const r = run();
    writeRun(r, cwd);
    const file = path.join(runDir(r.id, cwd), 'run.json');
    const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
    doc.schemaVersion = 999;
    fs.writeFileSync(file, JSON.stringify(doc));
    expect(() => readRun(r.id, cwd)).toThrow(/newer than this build understands/);
  });

  it('content-addresses evidence so an identical payload is stored once', () => {
    const r = run();
    writeRun(r, cwd);
    const a = putEvidence(r.id, 'the same bytes', 'txt', cwd);
    const b = putEvidence(r.id, 'the same bytes', 'txt', cwd);
    expect(a).toBe(b); // same content -> same ref
    const evidenceDir = path.join(runDir(r.id, cwd), 'evidence');
    expect(fs.readdirSync(evidenceDir)).toHaveLength(1);

    const c = putEvidence(r.id, 'different bytes', 'txt', cwd);
    expect(c).not.toBe(a);
    expect(fs.readdirSync(evidenceDir)).toHaveLength(2);
  });

  it('an empty run is still a readable run (findings.jsonl exists)', () => {
    const r = run();
    writeRun(r, cwd);
    expect(fs.existsSync(path.join(runDir(r.id, cwd), 'findings.jsonl'))).toBe(true);
    expect(readRun(r.id, cwd).property).toBe('shop');
  });
});
