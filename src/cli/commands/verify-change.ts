import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { buildKnowledgeBase, type KnowledgeEntryInput } from '../../registry/index.js';
import { KbStore, defaultKbDir } from '../../research/index.js';
import { verifyChange, verifySpecOf, type VerifyChangeOutput } from '../../remediation-verify.js';

export const VERIFY_CHANGE_HELP = `complykit verify-change — verify ONE remediation task (plans/remediation-flow.md §5)

Fetches what the task's verify spec needs and runs its checker:
  static checks   the page's served HTML (or the published GTM container),
                  through a real browser context — seconds, no scan
  spot-check      one page, reject then accept through complykit's own tool,
                  every request recorded (needs the tool installed)
  manual          nothing to fetch: always cannot-verify

  --task <file|->          the task JSON (a RemediationTask, or its verify spec); - reads stdin
  --workspace <file>       or: the site's workspace JSON, with --id: the task is
  --id <task id>           taken from its stored config (config.value.tasks)
  --site <domain>          the site's registrable domain (default: from the page URL)
  --kb-dir <path>          knowledge-base store whose confirmed entries are used
  --json                   print { result, message, evidence, at, check, id?, fetched?, observation? }

Exit 0 when a result was produced (pass, fail or cannot-verify); 2 on bad input.
A pass proves the served markup carries the change (or, for a spot check, one
page and one visit) — not behavior across the site. The rescan is that proof.
Browser: Playwright's Chromium, or COMPLYKIT_BROWSER_CHANNEL=chrome; COMPLYKIT_BROWSER_ARGS
adds Chromium flags (e.g. --host-resolver-rules=… for a local test site).`;

function readJson(file: string): unknown {
  const raw = file === '-' ? fs.readFileSync(0, 'utf8') : fs.readFileSync(path.resolve(file), 'utf8');
  return JSON.parse(raw);
}

export async function cmdVerifyChange(argv: string[]): Promise<number> {
  let values: { task?: string; workspace?: string; id?: string; site?: string; 'kb-dir'?: string; json?: boolean; help?: boolean };
  try {
    ({ values } = parseArgs({
      args: argv,
      options: {
        task: { type: 'string' },
        workspace: { type: 'string' },
        id: { type: 'string' },
        site: { type: 'string' },
        'kb-dir': { type: 'string' },
        json: { type: 'boolean' },
        help: { type: 'boolean' },
      },
    }));
  } catch (err) {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    return 2;
  }
  if (values.help) {
    process.stdout.write(VERIFY_CHANGE_HELP + '\n');
    return 0;
  }
  let input: unknown;
  try {
    if (values.task) {
      input = readJson(values.task);
    } else if (values.workspace && values.id) {
      const ws = readJson(values.workspace) as { config?: { value?: { tasks?: unknown } } };
      const tasks = ws?.config?.value?.tasks;
      const found = Array.isArray(tasks) ? tasks.find((t) => typeof t === 'object' && t !== null && (t as { id?: unknown }).id === values.id) : undefined;
      if (!found) {
        process.stderr.write(`no task ${values.id} in the workspace's stored config (generate the config first)\n`);
        return 2;
      }
      input = found;
    } else {
      process.stderr.write('usage: complykit verify-change --task <task.json|-> [--json]  |  --workspace <file> --id <task id> (see --help)\n');
      return 2;
    }
  } catch (err) {
    process.stderr.write(`could not read the task: ${err instanceof Error ? err.message : String(err)}\n`);
    return 2;
  }
  const parsed = verifySpecOf(input);
  if ('error' in parsed) {
    process.stderr.write(`${parsed.error}\n`);
    return 2;
  }

  // Same knowledge base as the scan: the seed plus the store's confirmed entries.
  const kbStore = new KbStore(values['kb-dir'] ? path.resolve(values['kb-dir']) : defaultKbDir());
  let stored: KnowledgeEntryInput[] = [];
  try {
    stored = kbStore.confirmedEntries();
  } catch (err) {
    process.stderr.write(`knowledge-base store ${kbStore.dir}: ${err instanceof Error ? err.message : String(err)} — using the seed entries only\n`);
  }
  const kb = buildKnowledgeBase({ extra: stored });

  const out: VerifyChangeOutput = await verifyChange(parsed.spec, {
    kb,
    site: values.site,
    launchArgs: process.env.COMPLYKIT_BROWSER_ARGS ? process.env.COMPLYKIT_BROWSER_ARGS.split(/\s+(?=--)/) : undefined,
    trace: values.json ? undefined : (l) => process.stderr.write(`${l}\n`),
  });
  if (parsed.id) out.id = parsed.id;
  if (values.json) {
    process.stdout.write(JSON.stringify(out) + '\n');
    return 0;
  }
  const label = out.result === 'pass' ? 'PASS' : out.result === 'fail' ? 'FAIL' : 'CANNOT VERIFY';
  process.stdout.write(`${label}${parsed.id ? ` ${parsed.id}` : ''} (${out.check}): ${out.message}\n`);
  for (const e of out.evidence) process.stdout.write(`  - ${e}\n`);
  return 0;
}
