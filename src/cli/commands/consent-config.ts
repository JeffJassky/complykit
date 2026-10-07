import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { buildKnowledgeBase, type KnowledgeEntryInput } from '../../registry/index.js';
import { CHANGE_LIST_FILE } from '../../report/index.js';
import type { RegimeSource } from '../../record/index.js';
import { generateConsentConfig, CONFIG_FILE, SNIPPET_FILE, GENERATOR_NOTES_FILE } from '../../consent-generator.js';
import { KbStore, defaultKbDir } from '../../research/index.js';
import { readConsentRunDir, readWorkspaceFile } from '../previous-run.js';
import { packageVersion } from '../pkg.js';
import { REMEDIATION_TASKS_FILE, type RemediationTasksFile } from '../remediation-input.js';

export const CONSENT_CONFIG_HELP = `complykit consent-config <run-dir> — the consent tool's config from a consent run

Reads the run's tracking.json (and the site workspace), decides each tool's
category and control the way the report does, and writes:

  complykit-config.json    the config (validated against the schema, hashed)
  snippet.html             what to paste in <head>, then each tag to rewrite
  change-list.md           the owner's change list (same as the report's)
  complykit/v1/            complykit-consent.js and complykit-consent-ui.js, copied from the
                           built client (the folder to upload; skipped with a note if the
                           client is not built)
  generator-notes.md       what was refused, what to check before deploying
  remediation-tasks.json   the checklist ("Make these changes"); complykit report
                           --format consent-html on the run shows it

  --workspace <file>       the site's workspace JSON (GET /api/sites/<domain>/workspace):
                           its classifications override the scan's categories
  --client-dist <dir>      the built client (default COMPLYKIT_CLIENT_DIST, else the
                           client/dist next to this package)
  --out <dir>              where to write (default: <run-dir>/consent-config)
  --kb-dir <path>          knowledge-base store whose confirmed entries are used
                           (default COMPLYKIT_KB_DIR or ~/.complykit/kb)
  --script-src <path>      where the snippet loads the tool from (default
                           /complykit/v1/complykit-consent.js, a placeholder)
  --record-endpoint <path> include a consent-record endpoint (omitted by default)
  --privacy-policy <url>   https URL linked from the banner
  --regime-source <s>      meta | platform | fixed:<opt-in|opt-out-signal|opt-out> |
                           header:<header>:<same-origin path>  (default: platform on
                           Shopify, else meta)
  --json                   print { config, snippet, changeList, notes, tasks, scriptSrc, files } as JSON
                           (tasks: the guided remediation checklist, plans/remediation-flow.md)`;

/** The two files the snippet loads, named as they are in the built client. */
export const CLIENT_FILES = ['complykit-consent.js', 'complykit-consent-ui.js'] as const;

/** Where the built client might be, best first. */
function clientDistCandidates(flag: string | undefined): string[] {
  if (flag) return [path.resolve(flag)];
  const here = path.dirname(fileURLToPath(import.meta.url));
  return [process.env.COMPLYKIT_CLIENT_DIST, path.resolve(here, '..', 'client', 'dist'), path.resolve(here, '..', '..', '..', 'client', 'dist')].filter((x): x is string => Boolean(x)).map((x) => path.resolve(x));
}

/** The folder of the snippet's script src as a relative path under the out dir ('/complykit/v1/x.js' → 'complykit/v1'). */
function folderUnder(scriptSrc: string): string {
  let p = scriptSrc;
  try {
    p = new URL(scriptSrc, 'https://x.invalid').pathname;
  } catch {
    /* use as given */
  }
  const parts = p.split('/').slice(0, -1).filter((x) => x && x !== '.' && x !== '..');
  return parts.length ? parts.join('/') : '.';
}

/** Copy the client files next to the config. Returns the written paths, or why not. */
export function copyClientFiles(out: string, scriptSrc: string, clientDist: string | undefined): { written: string[]; note?: string } {
  const tried = clientDistCandidates(clientDist);
  const dir = tried.find((d) => CLIENT_FILES.every((f) => fs.existsSync(path.join(d, f))));
  if (!dir) return { written: [], note: `client files not found (looked in ${tried.join(', ')}); build the client or pass --client-dist <dir>, then copy ${CLIENT_FILES.join(' and ')} next to each other on your site` };
  const dest = path.join(out, folderUnder(scriptSrc));
  fs.mkdirSync(dest, { recursive: true });
  const written: string[] = [];
  for (const f of CLIENT_FILES) {
    // The snippet loads whatever name its src ends in; the core finds the UI file next to it.
    const name = f === 'complykit-consent.js' ? path.posix.basename(scriptSrc.split(/[?#]/)[0]) || f : f;
    fs.copyFileSync(path.join(dir, f), path.join(dest, name));
    written.push(path.join(dest, name));
  }
  return { written };
}

function parseRegimeSource(s: string): RegimeSource | undefined {
  if (s === 'meta') return { kind: 'meta', name: 'complykit-region' };
  if (s === 'platform') return { kind: 'platform' };
  const fixed = /^fixed:(opt-in|opt-out-signal|opt-out)$/.exec(s);
  if (fixed) return { kind: 'fixed', regime: fixed[1] as 'opt-in' | 'opt-out-signal' | 'opt-out' };
  const header = /^header:([^:]+):(\/.*)$/.exec(s);
  if (header) return { kind: 'header', header: header[1], endpoint: header[2] };
  return undefined;
}

export async function cmdConsentConfig(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    options: {
      workspace: { type: 'string' },
      out: { type: 'string' },
      'kb-dir': { type: 'string' },
      'client-dist': { type: 'string' },
      'script-src': { type: 'string' },
      'record-endpoint': { type: 'string' },
      'privacy-policy': { type: 'string' },
      'regime-source': { type: 'string' },
      json: { type: 'boolean' },
      help: { type: 'boolean' },
    },
    allowPositionals: true,
  });
  if (values.help) {
    process.stdout.write(CONSENT_CONFIG_HELP + '\n');
    return 0;
  }
  if (positionals.length !== 1) {
    process.stderr.write('usage: complykit consent-config <run-dir> [--workspace file] [--out dir] (see --help)\n');
    return 2;
  }
  const dir = path.resolve(positionals[0]);
  let run: ReturnType<typeof readConsentRunDir>;
  try {
    run = readConsentRunDir(dir);
  } catch (err) {
    process.stderr.write(`${dir}: ${err instanceof Error ? err.message : String(err)}\n`);
    return 2;
  }
  if (!run) {
    process.stderr.write(`${dir}: no consent evaluation (tracking.json) there. Run \`complykit consent\` first.\n`);
    return 2;
  }
  let workspace: ReturnType<typeof readWorkspaceFile> | undefined;
  if (values.workspace) {
    try {
      workspace = readWorkspaceFile(path.resolve(values.workspace));
    } catch (err) {
      process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
      return 2;
    }
  }
  let regimeSource: RegimeSource | undefined;
  if (values['regime-source']) {
    regimeSource = parseRegimeSource(values['regime-source']);
    if (!regimeSource) {
      process.stderr.write(`--regime-source: expected meta | platform | fixed:<regime> | header:<header>:<path>, got: ${values['regime-source']}\n`);
      return 2;
    }
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

  let result: ReturnType<typeof generateConsentConfig>;
  try {
    result = generateConsentConfig(run.evaluation, {
      kb,
      workspace,
      findings: run.findings,
      complykitVersion: packageVersion(),
      scriptSrc: values['script-src'],
      recordEndpoint: values['record-endpoint'],
      privacyPolicyUrl: values['privacy-policy'],
      regimeSource,
    });
  } catch (err) {
    // A config that fails its own schema is a bad input (e.g. --privacy-policy not https), not a crash.
    process.stderr.write(`could not generate a config: ${err instanceof Error ? err.message : String(err)}\n`);
    return 2;
  }

  const out = path.resolve(values.out ?? path.join(dir, 'consent-config'));
  fs.mkdirSync(out, { recursive: true });
  const files = {
    config: path.join(out, CONFIG_FILE),
    snippet: path.join(out, SNIPPET_FILE),
    changeList: path.join(out, CHANGE_LIST_FILE),
    notes: path.join(out, GENERATOR_NOTES_FILE),
  };
  fs.writeFileSync(files.config, result.json);
  fs.writeFileSync(files.snippet, result.snippet);
  fs.writeFileSync(files.changeList, result.changeList);
  fs.writeFileSync(files.notes, result.notesMarkdown);
  // The checklist, for `complykit report --format consent-html` on this run (R3).
  const tasksFile = path.join(out, REMEDIATION_TASKS_FILE);
  fs.writeFileSync(tasksFile, JSON.stringify({ version: 1, at: result.config.generatedFrom.at, runId: result.config.generatedFrom.runId, tasks: result.tasks } satisfies RemediationTasksFile, null, 2) + '\n');

  const client = copyClientFiles(out, result.scriptSrc, values['client-dist']);

  if (values.json) {
    process.stdout.write(JSON.stringify({ clientFiles: client.written, ...(client.note ? { clientNote: client.note } : {}), runId: result.config.generatedFrom.runId, site: result.config.generatedFrom.site, config: result.config, snippet: result.snippet, changeList: result.changeList, notes: result.notes, tasks: result.tasks, scriptSrc: result.scriptSrc, files }) + '\n');
    return 0;
  }
  const c = result.config;
  process.stdout.write(`consent config for ${c.generatedFrom.site} (run ${c.generatedFrom.runId})\n`);
  process.stdout.write(`  categories: ${c.categories.map((x) => x.id).join(', ')}\n`);
  process.stdout.write(`  vendors: ${c.vendors.length} · gate rules: ${c.gate.length}${c.gtm ? ` · GTM ${c.gtm.containers.join(', ')}: ${c.gtm.tags.length} tag(s)` : ''} · platform: ${c.platform}\n`);
  for (const n of result.notes.filter((x) => x.level !== 'info')) process.stdout.write(`  ${n.level === 'refused' ? 'REFUSED' : 'check'}: ${n.message}\n`);
  for (const f of [...Object.values(files), tasksFile, ...client.written]) process.stdout.write(`wrote ${f}\n`);
  if (client.note) process.stdout.write(`note: ${client.note}\n`);
  return 0;
}
