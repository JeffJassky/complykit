import fs from 'node:fs';
import path from 'node:path';
import { parse } from 'yaml';
import type { Finding } from '../record/index.js';

// comply.dispositions.yaml — the human-reviewed triage ledger. Storage stays
// granular (every finding is recorded with its fingerprint); dispositions act
// at the REPORT layer only. A `false-positive` disposition removes the finding
// from rendered reports — the one status where showing it again every run is
// pure noise. Every other status stays visible: `fixed` that still detects is
// a regression, `accepted-risk`/`wont-fix` are standing decisions a report
// must keep saying out loud.

export interface Disposition {
  fingerprint: string;
  status: 'open' | 'fixed' | 'accepted-risk' | 'false-positive' | 'wont-fix';
  by?: string;
  at?: string;
  why?: string;
}

export function loadDispositions(cwd?: string): Disposition[] {
  const p = path.join(cwd ?? process.cwd(), 'comply.dispositions.yaml');
  if (!fs.existsSync(p)) return [];
  try {
    const doc = parse(fs.readFileSync(p, 'utf8')) as { dispositions?: unknown } | null;
    const list = Array.isArray(doc?.dispositions) ? doc.dispositions : [];
    return list.filter(
      (d): d is Disposition =>
        !!d && typeof (d as Disposition).fingerprint === 'string' && typeof (d as Disposition).status === 'string',
    );
  } catch {
    return []; // an unparsable ledger must not take the report down
  }
}

export interface DispositionFilter {
  findings: Finding[];
  excluded: number; // false-positives removed from the render
}

export function applyDispositions(findings: Finding[], dispositions: Disposition[]): DispositionFilter {
  const fp = new Set(dispositions.filter((d) => d.status === 'false-positive').map((d) => d.fingerprint));
  if (!fp.size) return { findings, excluded: 0 };
  const kept = findings.filter((f) => !fp.has(f.fingerprint));
  return { findings: kept, excluded: findings.length - kept.length };
}
