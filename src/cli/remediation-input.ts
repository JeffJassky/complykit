import fs from 'node:fs';
import path from 'node:path';
import { parseRemediationTasks, remediationFromWorkspace, type RemediationSection, type RemediationWorkspaceLike } from '../report/index.js';

// Where the report's "Your to-do list" checklist comes from (R3,
// plans/remediation-flow.md §6): the site workspace's latest generated config
// (`config.value.tasks`, the service / --workspace) wins; otherwise the run's
// own generated output (`complykit consent-config <run-dir>` writes
// consent-config/remediation-tasks.json). Neither → the report shows the
// "generate the config" prompt.

/** Written by `complykit consent-config` beside complykit-config.json. */
export const REMEDIATION_TASKS_FILE = 'remediation-tasks.json';

/** The JSON in remediation-tasks.json. */
export interface RemediationTasksFile {
  version: 1;
  at: string;
  runId: string;
  tasks: unknown[];
}

export function readRunRemediation(runDir: string, workspace?: RemediationWorkspaceLike): RemediationSection | undefined {
  const fromWorkspace = remediationFromWorkspace(workspace);
  if (fromWorkspace) return fromWorkspace;
  const file = path.join(runDir, 'consent-config', REMEDIATION_TASKS_FILE);
  let raw: Partial<RemediationTasksFile>;
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<RemediationTasksFile>;
  } catch {
    return undefined;
  }
  const tasks = parseRemediationTasks(raw?.tasks);
  if (!tasks.length) return undefined;
  return { tasks, source: 'run', ...(typeof raw.at === 'string' ? { configAt: raw.at } : {}), ...(typeof raw.runId === 'string' ? { runId: raw.runId } : {}) };
}
