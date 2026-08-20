import fs from 'node:fs';
import path from 'node:path';
import { COMPLY_DIR, type Verdict } from '../record/index.js';

// Verdict cache across runs (vision-analysis-design economics #2). Key = crop
// content hash + rule id + rubric version + model id. An unchanged region reuses
// its verdict for ZERO tokens, so a scheduled re-run costs proportional to UI
// churn, not site size. Lives in .comply/cache/ — safe to commit or blow away.

export function verdictCacheDir(cwd = process.cwd()): string {
  return path.join(cwd, COMPLY_DIR, 'cache', 'verdicts');
}

function keyFile(cropHash: string, ruleId: string, rubricVersion: string, model: string, cwd: string): string {
  const safe = (s: string): string => s.replace(/[^A-Za-z0-9._-]/g, '_');
  return path.join(verdictCacheDir(cwd), `${safe(cropHash)}-${safe(ruleId)}-${safe(rubricVersion)}-${safe(model)}.json`);
}

export function readVerdict(
  cropHash: string,
  ruleId: string,
  rubricVersion: string,
  model: string,
  cwd = process.cwd(),
): Verdict | undefined {
  const file = keyFile(cropHash, ruleId, rubricVersion, model, cwd);
  if (!fs.existsSync(file)) return undefined;
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as Verdict;
  } catch {
    return undefined;
  }
}

export function writeVerdict(
  cropHash: string,
  ruleId: string,
  rubricVersion: string,
  model: string,
  verdict: Verdict,
  cwd = process.cwd(),
): void {
  const file = keyFile(cropHash, ruleId, rubricVersion, model, cwd);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(verdict, null, 2));
}
