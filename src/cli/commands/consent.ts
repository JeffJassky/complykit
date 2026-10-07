import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { runIdFromTimestamp, runDir, writeTrackingEvaluation, ScenarioId, type LocationSpec } from '../../record/index.js';
import { buildKnowledgeBase, type KnowledgeEntryInput, type PartyCategory } from '../../registry/index.js';
import { tracking } from '../../rules/index.js';
import { buildConsentReportModel, renderConsentHtml, renderConsentMarkdown, diffConsentModels, renderChangeListMarkdown, reportRenderInfo, CHANGE_LIST_FILE } from '../../report/index.js';
import { readWorkspaceFile, readConsentRunDir, findPreviousConsentRun, type PreviousRun } from '../previous-run.js';
import type { WorkspaceSnapshot } from '../../site-workspace.js';
import { readRunRemediation } from '../remediation-input.js';
import { runConsentScan } from '../../pipeline.js';
import { loadLocalCopy } from '../../local-copy.js';
import { KbStore, defaultKbDir, ingestEvaluation } from '../../research/index.js';
import { assembleAndWrite } from '../write-run.js';
import type { LoadedConfig } from '../config-load.js';
import { packageVersion } from '../pkg.js';

type LoadConfig = (opts: { url?: string; config?: string }, cwd?: string) => Promise<LoadedConfig>;

export const CONSENT_HELP = `complykit consent — consent & tracking evaluation by visitor location

Visits the site in a real browser from each location, in each consent scenario,
records everything the browser does, and applies that location's rules.

  --url <url>              site to evaluate (zero-config: this machine's location)
  --config <file>          config file (property.consent: locations, scenarios, journey)
  --property <id>          property from the config
  --locations a,b          location ids: local, a country (de, uk), a US state (us-ca),
                           or ids defined in the config
  --proxy id=server        route a location through a proxy (repeatable), e.g.
                           --proxy de=socks5://127.0.0.1:1081
  --authorized             confirm you have the site owner's authorization (required
                           when any location uses a proxy)
  --scenarios a,b          override every location's scenario set
  --quick                  shorter visits and a reduced scenario set (first look)
  --raw-evidence           keep cookie values, auth headers and bodies in evidence
  --no-har                 skip HAR export
  --concurrency N          scenarios in parallel per location (default 1)
  --runs N                 visits per scenario (default 1). Each run after the first
                           repeats the scenario under Slow-3G network and 4x CPU
                           throttling, to catch trackers that only fire when the
                           consent tool loads slowly. A tool active in any run counts
                           as active; the report says "active in 1 of 2 runs".
  --out <file>             HTML report path (default: <run>/consent-report.html)
  --quiet                  no per-scenario narration
  --kb-dir <path>          knowledge-base store (default COMPLYKIT_KB_DIR or
                           ~/.complykit/kb): its confirmed entries are used, and
                           unrecognized parties are queued there for research
  --no-kb-queue            don't add this run to the research queue
  --workspace <file>       the site's workspace JSON (the service's GET
                           /api/sites/<domain>/workspace): its classifications apply
                           to this run, done tasks carry into the report
  --previous <run dir>     run to compare with for "Since <date>" (default: the
                           newest earlier consent run of this site in .comply/runs)
  --events <file>          append progress as JSON lines (start, location,
                           scenario-start, scenario-done, done, error) — for UIs.
                           Repeat runs carry run: 2..N; location carries runs
  --local-copy <file>      TEST MODE: apply a change set to the site inside this
                           browser only (snippet first in <head>, tag rewrites,
                           local files at the tool's path, simulated tag-manager
                           settings) and scan that copy. Nothing is installed on
                           the site; the report says the run was a local copy.
                           Spec format: docs/guide/consent.md#local-copy-mode

Every location's exit is verified in two geolocation sources before any finding
is attributed to it; anything unverified is reported as not tested.
Browser: Playwright's Chromium, or COMPLYKIT_BROWSER_CHANNEL=chrome; COMPLYKIT_BROWSER_ARGS
adds Chromium flags (e.g. --host-resolver-rules=… for a local test site).`;

export async function cmdConsent(argv: string[], loadConfig: LoadConfig): Promise<number> {
  const { values } = parseArgs({
    args: argv,
    options: {
      url: { type: 'string' },
      config: { type: 'string' },
      property: { type: 'string' },
      cwd: { type: 'string' },
      locations: { type: 'string' },
      proxy: { type: 'string', multiple: true },
      authorized: { type: 'boolean' },
      scenarios: { type: 'string' },
      quick: { type: 'boolean' },
      'raw-evidence': { type: 'boolean' },
      'no-har': { type: 'boolean' },
      concurrency: { type: 'string' },
      runs: { type: 'string' },
      out: { type: 'string' },
      quiet: { type: 'boolean' },
      events: { type: 'string' },
      'kb-dir': { type: 'string' },
      'no-kb-queue': { type: 'boolean' },
      workspace: { type: 'string' },
      previous: { type: 'string' },
      'local-copy': { type: 'string' },
      help: { type: 'boolean' },
    },
    allowPositionals: false,
  });
  if (values.help) {
    process.stdout.write(CONSENT_HELP + '\n');
    return 0;
  }
  const cwd = values.cwd ?? process.cwd();
  const pkg = packageVersion();
  const { config, source } = await loadConfig({ url: values.url, config: values.config }, cwd);
  const property = values.property ? config.properties.find((p) => p.id === values.property) : config.properties[0];
  if (!property) {
    process.stderr.write(`property not found: ${values.property}\n`);
    return 2;
  }
  const targetUrl = property.targets.public?.url ?? values.url;
  if (!targetUrl) {
    process.stderr.write('no public URL to evaluate — pass --url or set targets.public.url.\n');
    return 2;
  }
  const cc = property.consent ?? {};
  let runs: number | undefined;
  if (values.runs !== undefined) {
    runs = Number(values.runs);
    if (!Number.isInteger(runs) || runs < 1 || runs > 5) {
      process.stderr.write(`--runs expects a whole number from 1 to 5, got: ${values.runs}\n`);
      return 2;
    }
  }

  let workspace: WorkspaceSnapshot | undefined;
  if (values.workspace) {
    try {
      workspace = readWorkspaceFile(path.resolve(cwd, values.workspace));
    } catch (err) {
      process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
      return 2;
    }
  }
  let localCopy: ReturnType<typeof loadLocalCopy> | undefined;
  if (values['local-copy']) {
    try {
      localCopy = loadLocalCopy(values['local-copy'], targetUrl, cwd);
    } catch (err) {
      process.stderr.write(`--local-copy: ${err instanceof Error ? err.message : String(err)}\n`);
      return 2;
    }
  }
  let explicitPrevious: PreviousRun | undefined;
  if (values.previous) {
    const dir = path.resolve(cwd, values.previous);
    try {
      explicitPrevious = readConsentRunDir(dir);
    } catch (err) {
      process.stderr.write(`--previous ${dir}: ${err instanceof Error ? err.message : String(err)}\n`);
      return 2;
    }
    if (!explicitPrevious) {
      process.stderr.write(`--previous ${dir}: no consent evaluation (tracking.json) there\n`);
      return 2;
    }
  }

  // Locations: --locations ids (config entry if defined, else a preset), else config, else local.
  let locations: LocationSpec[];
  try {
    const ids = values.locations?.split(',').map((s) => s.trim()).filter(Boolean);
    locations = ids?.length
      ? ids.map((id) => cc.locations?.find((l) => l.id === id) ?? tracking.locationPreset(id))
      : cc.locations?.length
        ? cc.locations
        : [tracking.locationPreset('local')];
  } catch (err) {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    return 2;
  }
  for (const p of values.proxy ?? []) {
    const i = p.indexOf('=');
    if (i <= 0) {
      process.stderr.write(`--proxy expects id=server, got: ${p}\n`);
      return 2;
    }
    const id = p.slice(0, i);
    const loc = locations.find((l) => l.id === id);
    if (!loc) {
      process.stderr.write(`--proxy ${id}: no such location in this run (${locations.map((l) => l.id).join(', ')})\n`);
      return 2;
    }
    loc.proxy = { server: p.slice(i + 1) };
  }
  if (locations.some((l) => l.proxy) && !values.authorized) {
    process.stderr.write(
      'one or more locations route through a proxy. Scanning through proxies needs the site owner’s authorization\n' +
        '(in writing for residential proxies — plans/consent-design.md §2.2). Re-run with --authorized once you have it.\n',
    );
    return 2;
  }

  let scenarios: ScenarioId[] | undefined;
  if (values.scenarios) {
    const parsed = values.scenarios.split(',').map((s) => s.trim()).filter(Boolean);
    const bad = parsed.filter((s) => !ScenarioId.safeParse(s).success);
    if (bad.length) {
      process.stderr.write(`unknown scenario(s): ${bad.join(', ')} (${ScenarioId.options.join(', ')})\n`);
      return 2;
    }
    scenarios = parsed as ScenarioId[];
  } else if (cc.scenarios?.length) {
    scenarios = cc.scenarios;
  }

  // Knowledge base: seed + the store's confirmed entries + the config's entries
  // file + per-site overrides. The config file wins over the store (it is more
  // specific), the store over the seed.
  const kbStore = new KbStore(values['kb-dir'] ? path.resolve(cwd, values['kb-dir']) : defaultKbDir());
  let stored: KnowledgeEntryInput[] = [];
  try {
    stored = kbStore.confirmedEntries();
  } catch (err) {
    process.stderr.write(`knowledge-base store ${kbStore.dir}: ${err instanceof Error ? err.message : String(err)}\n`);
    return 2;
  }
  let extra: KnowledgeEntryInput[] = [];
  if (cc.knowledgeBase?.entries) {
    const file = path.resolve(cwd, cc.knowledgeBase.entries);
    try {
      extra = JSON.parse(fs.readFileSync(file, 'utf8')) as KnowledgeEntryInput[];
    } catch (err) {
      process.stderr.write(`could not read knowledge-base entries ${file}: ${err instanceof Error ? err.message : String(err)}\n`);
      return 2;
    }
  }
  const extraIds = new Set(extra.map((e) => e.id));
  const knowledgeBase = buildKnowledgeBase({
    extra: [...extra, ...stored.filter((e) => !extraIds.has(e.id))],
    overrides: cc.knowledgeBase?.overrides?.map((o) => ({ ...o, categories: o.categories as PartyCategory[] | undefined })),
  });

  const now = new Date().toISOString();
  const runId = runIdFromTimestamp(now);
  const trace = values.quiet ? undefined : (line: string) => process.stdout.write(`    ${line}\n`);
  process.stdout.write(`consent evaluation: ${targetUrl} (config: ${source})\n`);
  process.stdout.write(`  locations: ${locations.map((l) => `${l.id}${l.proxy ? ' [proxy]' : ''}`).join(', ')}${values.quick ? ' · quick' : ''}${runs && runs > 1 ? ` · ${runs} runs (repeats throttled)` : ''}\n`);
  if (localCopy) process.stdout.write(`  LOCAL COPY: ${localCopy.file} — documents from ${localCopy.origin} are rewritten in this browser; nothing is installed on the site\n`);

  const eventsFile = values.events ? path.resolve(cwd, values.events) : undefined;
  const event = (e: Record<string, unknown>): void => {
    if (eventsFile) fs.appendFileSync(eventsFile, JSON.stringify({ at: new Date().toISOString(), ...e }) + '\n');
  };
  event({ type: 'start', runId: String(runId), url: targetUrl, locations: locations.map((l) => l.id) });

  let res: Awaited<ReturnType<typeof runConsentScan>>;
  try {
    res = await runConsentScan({
    runId,
    property: property.id,
    targetUrl,
    cwd,
    tags: property.tags,
    packageVersion: pkg,
    locations,
    scenarios,
    quick: values.quick,
    journey: cc.journey,
    knowledgeBase,
    rawEvidence: values['raw-evidence'] ?? cc.rawEvidence,
    har: !values['no-har'],
    concurrency: values.concurrency ? Number(values.concurrency) : undefined,
    runs,
    workspace,
    localCopy,
    // Extra Chromium flags (e.g. --host-resolver-rules for a fixture site), as verify-change takes them.
    launchArgs: process.env.COMPLYKIT_BROWSER_ARGS ? process.env.COMPLYKIT_BROWSER_ARGS.split(/\s+(?=--)/) : undefined,
    trace,
    onEvent: (e) => event(e as unknown as Record<string, unknown>),
  });
  } catch (err) {
    event({ type: 'error', message: err instanceof Error ? err.message : String(err) });
    throw err;
  }

  const { run, written } = assembleAndWrite({
    runId,
    property: property.id,
    now,
    packageVersion: pkg,
    findings: res.findings,
    engines: res.evaluation.versions.autoconsent ? { autoconsent: res.evaluation.versions.autoconsent } : {},
    accessLevels: ['public'],
    matrix: res.matrix,
    rulesExecuted: res.rulesExecuted,
    cwd,
  });
  const dir = runDir(run.id, cwd);
  writeTrackingEvaluation(dir, res.evaluation);
  const model = buildConsentReportModel(res.evaluation, res.findings);
  // R3: a rescan with a workspace shows the checklist from its latest config.
  const remediation = readRunRemediation(dir, workspace);
  if (remediation) model.remediation = remediation;
  // "Since <date>": the previous run of this site, rebuilt with this build's
  // report model so both sides are compared the same way.
  let previous = explicitPrevious;
  if (!previous) {
    try {
      previous = findPreviousConsentRun({ cwd, current: String(run.id), site: res.evaluation.site.registrableDomain, before: res.evaluation.startedAt });
    } catch (err) {
      process.stderr.write(`could not look for a previous run: ${err instanceof Error ? err.message : String(err)}\n`);
    }
  }
  if (previous) model.since = diffConsentModels(buildConsentReportModel(previous.evaluation, previous.findings), model);
  const out = values.out ? path.resolve(cwd, values.out) : path.join(dir, 'consent-report.html');
  // Links in the report are run-relative; a report written elsewhere inlines screenshots but links won't resolve.
  // The classifications this report applied (the workspace read before the scan), so a served report can offer an update (R2).
  fs.writeFileSync(out, renderConsentHtml(model, { runDir: dir, render: reportRenderInfo(String(run.id), workspace) }));
  fs.writeFileSync(out.replace(/\.html?$/i, '') + '.json', JSON.stringify(model, null, 2));
  // The owner's change list, beside the report (the report links it by this name).
  const changeList = path.join(path.dirname(out), CHANGE_LIST_FILE);
  fs.writeFileSync(changeList, renderChangeListMarkdown(model));

  let queued: { added: number; resolved: number } | undefined;
  if (!values['no-kb-queue']) {
    try {
      const r = ingestEvaluation(kbStore, res.evaluation, knowledgeBase);
      queued = { added: r.added.length, resolved: r.resolved.length };
    } catch (err) {
      process.stderr.write(`could not update the research queue in ${kbStore.dir}: ${err instanceof Error ? err.message : String(err)}\n`);
    }
  }

  event({
    type: 'done',
    runId: String(run.id),
    runDir: dir,
    report: out,
    changeList,
    findings: written,
    totals: model.totals,
    parties: res.evaluation.inventory.length,
    unrecognized: res.evaluation.researchQueue.length,
    ...(model.since ? { previousRunId: model.since.base.runId } : {}),
    ...(res.evaluation.siteWorkspace ? { workspace: { classifications: res.evaluation.siteWorkspace.classifications.length, doneTasks: res.evaluation.siteWorkspace.doneTasks.length } } : {}),
  });
  process.stdout.write('\n' + renderConsentMarkdown(model, { maxFindings: 15 }));
  if (localCopy) {
    const r = localCopy.stats;
    const never = [...r.replacements].filter(([, n]) => !n).map(([l]) => l);
    process.stdout.write(`\nlocal copy: ${r.documents.rewritten} document(s) rewritten${r.documents.unreadable ? `, ${r.documents.unreadable} unreadable (served as-is)` : ''}; served ${[...r.served].map(([p, n]) => `${p} ×${n}`).join(', ') || 'nothing'}${never.length ? `; NEVER MATCHED: ${never.join(', ')}` : ''}\n`);
    for (const [url, x] of r.resources) process.stdout.write(`local copy: ${url} — ${x.status}${x.note ? ` (${x.note})` : ''}\n`);
  }
  process.stdout.write(`\nrun ${String(run.id)}: ${written} finding(s) · report ${out}\n`);
  if (queued && (queued.added || queued.resolved)) {
    process.stdout.write(`research queue: ${queued.added} new part${queued.added === 1 ? 'y' : 'ies'}${queued.resolved ? `, ${queued.resolved} now recognized` : ''} — complykit kb queue\n`);
  }
  return 0;
}
