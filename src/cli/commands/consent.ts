import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { runIdFromTimestamp, runDir, writeTrackingEvaluation, ScenarioId, type LocationSpec } from '../../record/index.js';
import { buildKnowledgeBase, registrableDomain, type KnowledgeEntryInput, type PartyCategory } from '../../registry/index.js';
import { tracking } from '../../rules/index.js';
import { buildConsentReportModel, renderConsentHtml, renderConsentMarkdown, diffConsentModels, renderChangeListMarkdown, reportRenderInfo, CHANGE_LIST_FILE } from '../../report/index.js';
import { readWorkspaceFile, readConsentRunDir, findPreviousConsentRun, type PreviousRun } from '../previous-run.js';
import type { WorkspaceSnapshot } from '../../site-workspace.js';
import { readRunRemediation } from '../remediation-input.js';
import { runConsentScan, collectConsentScan, analyzeConsentScan, type ConsentScanResult } from '../../pipeline.js';
import { COLLECTION_KIND, COLLECTION_SCHEMA_VERSION, mergeCollections, mergeEvidence, readCollectionHandoff, writeCollectionHandoff, type ConsentCollectionHandoff } from '../../consent-collection.js';
import { loadLocalCopy } from '../../local-copy.js';
import { KbStore, defaultKbDir, ingestEvaluation } from '../../research/index.js';
import { assembleAndWrite } from '../write-run.js';
import type { LoadedConfig } from '../config-load.js';
import { packageVersion } from '../pkg.js';
import { buildOwnerReport, OWNER_REPORT_FILE, type OwnerReportInput } from '../../report/owner-report.js';

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
                           Repeat runs carry run: 2..N; location carries runs.
                           With --events the owner report (owner-report.json, beside
                           the HTML report) is rewritten after every visit, from the
                           visits finished so far, and a \`live\` event points to it
  --collect-only           multi-region worker: run the browser half only. Writes the
                           evidence and collection.json (RAW timelines — transient,
                           delete after merging) into the run dir; no findings, no
                           report, no research queue. Prints the run dir.
  --merge <dir>[,<dir>…]   multi-region primary: no browser. Merge the run dirs that
                           hold a collection.json (from --collect-only runs of this
                           site, same complykit version), run the rules over every
                           location at once and write one normal run. Needs --url;
                           not combined with --collect-only, --locations, --proxy,
                           --scenarios, --quick, --runs, --concurrency, --local-copy.
                           The input dirs are left untouched.
  --failed id=reason       with --merge (repeatable): location \`id\` never arrived;
                           the report lists it as not tested with this reason
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
      'collect-only': { type: 'boolean' },
      merge: { type: 'string' },
      failed: { type: 'string', multiple: true },
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
  // --merge (multi-region primary): no browser, so the visit-shaping flags make no sense with it.
  const mergeArg = values.merge;
  const merging = mergeArg !== undefined;
  const collectOnly = values['collect-only'] === true;
  if (merging) {
    const refused: Array<[string, unknown]> = [['--collect-only', collectOnly || undefined], ['--locations', values.locations], ['--proxy', values.proxy?.length ? true : undefined], ['--scenarios', values.scenarios], ['--quick', values.quick], ['--runs', values.runs], ['--concurrency', values.concurrency], ['--local-copy', values['local-copy']]];
    const bad = refused.find(([, v]) => v !== undefined && v !== false);
    if (bad) {
      process.stderr.write(`--merge cannot be combined with ${bad[0]} (a merge runs no browser)\n`);
      return 2;
    }
    if (!values.url) {
      process.stderr.write('--merge needs --url (the site the collections are of)\n');
      return 2;
    }
  } else if (values.failed?.length) {
    process.stderr.write('--failed only applies with --merge\n');
    return 2;
  }
  const mergeDirs = merging ? mergeArg.split(',').map((d) => d.trim()).filter(Boolean).map((d) => path.resolve(cwd, d)) : [];
  if (merging && !mergeDirs.length) {
    process.stderr.write('--merge needs at least one run dir\n');
    return 2;
  }
  const failed: Array<{ id: string; reason: string }> = [];
  for (const f of values.failed ?? []) {
    const i = f.indexOf('=');
    if (i <= 0 || i === f.length - 1) {
      process.stderr.write(`--failed expects locationId=reason, got: ${f}\n`);
      return 2;
    }
    failed.push({ id: f.slice(0, i), reason: f.slice(i + 1) });
  }
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
    locations = merging
      ? [] // the merged collections say which locations there are
      : ids?.length
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
  if (merging) process.stdout.write(`  merging ${mergeDirs.length} collection(s): ${mergeDirs.join(', ')}\n`);
  else process.stdout.write(`  locations: ${locations.map((l) => `${l.id}${l.proxy ? ' [proxy]' : ''}`).join(', ')}${values.quick ? ' · quick' : ''}${runs && runs > 1 ? ` · ${runs} runs (repeats throttled)` : ''}\n`);
  if (localCopy) process.stdout.write(`  LOCAL COPY: ${localCopy.file} — documents from ${localCopy.origin} are rewritten in this browser; nothing is installed on the site\n`);

  const eventsFile = values.events ? path.resolve(cwd, values.events) : undefined;
  const event = (e: Record<string, unknown>): void => {
    if (eventsFile) fs.appendFileSync(eventsFile, JSON.stringify({ at: new Date().toISOString(), ...e }) + '\n');
  };
  if (!merging) event({ type: 'start', runId: String(runId), url: targetUrl, locations: locations.map((l) => l.id) });

  // The owner report, live (plans/simple-report.md): with --events, rewritten
  // after every visit from the analysis of the visits finished so far, beside
  // where the HTML report will go. Never stops the scan.
  const out = values.out ? path.resolve(cwd, values.out) : path.join(runDir(runId, cwd), 'consent-report.html');
  const ownerFile = path.join(path.dirname(out), OWNER_REPORT_FILE);
  const scanStartedAt = new Date().toISOString();
  const live: Pick<OwnerReportInput, 'plan' | 'done' | 'current' | 'locations' | 'pagesVisited'> & { plan: NonNullable<OwnerReportInput['plan']>; done: NonNullable<OwnerReportInput['done']>; locations: NonNullable<OwnerReportInput['locations']> } = { plan: [], done: [], locations: [] };
  let lastPartial: Parameters<NonNullable<Parameters<typeof runConsentScan>[0]['onPartial']>>[0] | undefined;
  let liveSite = (() => {
    const u = new URL(targetUrl);
    return { url: u.toString(), host: u.hostname, registrableDomain: u.hostname };
  })();
  const writeOwner = (input: Omit<OwnerReportInput, 'runId' | 'site' | 'startedAt'>): void => {
    fs.mkdirSync(path.dirname(ownerFile), { recursive: true });
    const report = buildOwnerReport({ ...input, runId: String(runId), site: liveSite, startedAt: scanStartedAt });
    const tmp = `${ownerFile}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(report, null, 2));
    fs.renameSync(tmp, ownerFile);
    event({ type: 'live', file: ownerFile, stage: report.stage, visitsDone: report.scan.visitsDone, visitsTotal: report.scan.visitsTotal });
  };
  const writeLive = (): void => {
    if (!eventsFile || collectOnly) return; // a worker leaves no owner report
    try {
      const model = lastPartial ? buildConsentReportModel(lastPartial.evaluation, lastPartial.findings) : undefined;
      const pages = new Set((lastPartial?.timelines ?? []).flatMap((tl) => tl.snapshot.pages.map((p) => p.url)));
      writeOwner({ model, stage: 'live', ...live, pagesVisited: pages.size });
    } catch (err) {
      process.stderr.write(`owner report (live) not written: ${err instanceof Error ? err.message : String(err)}\n`);
    }
  };
  const onScanEvent = (e: import('../../collect/browser/evaluation/index.js').EvaluationEvent): void => {
    event(e as unknown as Record<string, unknown>);
    if (e.type === 'location') {
      const label = locations.find((l) => l.id === e.location)?.label;
      live.locations.push({ id: e.location, ...(label ? { label } : {}), verdict: e.verdict, ...(e.observed ? { observed: e.observed } : {}), ...(e.note ? { note: e.note } : {}) });
      for (const scenario of e.scenarios) live.plan.push({ location: e.location, scenario, runs: e.runs ?? 1 });
      writeLive();
    } else if (e.type === 'scenario-start') {
      live.current = { location: e.location, scenario: e.scenario, ...(e.run ? { run: e.run } : {}) };
      writeLive();
    } else if (e.type === 'scenario-done') {
      live.done.push({ location: e.location, scenario: e.scenario, ...(e.run ? { run: e.run } : {}) });
      live.current = undefined;
    }
  };

  const scanOptions = {
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
    onEvent: onScanEvent,
  };
  let res: ConsentScanResult;
  // The pages visited, for the final owner report: the live partials' (a normal scan) or the merged timelines'.
  let pagesVisitedFrom = (): number => new Set((lastPartial?.timelines ?? []).flatMap((tl) => tl.snapshot.pages.map((p) => p.url))).size;
  if (merging) {
    // Multi-region primary: no browser. The workers' collections, merged, analyzed with this machine's KB.
    try {
      const handoffs = mergeDirs.map((d) => {
        try {
          return readCollectionHandoff(d);
        } catch (err) {
          throw new Error(`--merge ${d}: ${err instanceof Error ? err.message : String(err)}`);
        }
      });
      const want = registrableDomain(new URL(targetUrl).hostname);
      handoffs.forEach((h, i) => {
        if (h.collection.site.registrableDomain !== want) throw new Error(`--merge ${mergeDirs[i]}: collection is of ${h.collection.site.registrableDomain}, not ${want} (--url)`);
      });
      const merged = mergeCollections(handoffs);
      for (const f of failed) merged.notTested.push({ scope: 'location', id: f.id, location: f.id, reason: f.reason });
      mergeEvidence(mergeDirs, runDir(runId, cwd));
      locations = merged.locations.map((l) => l.spec);
      event({ type: 'start', runId: String(runId), url: targetUrl, locations: locations.map((l) => l.id) });
      for (const l of merged.locations) {
        const observed = [l.verification.observed.country, l.verification.observed.region].filter(Boolean).join('-') || undefined;
        live.locations.push({ id: l.spec.id, ...(l.spec.label ? { label: l.spec.label } : {}), verdict: l.verification.verdict, ...(observed ? { observed } : {}), ...(l.verification.note ? { note: l.verification.note } : {}) });
      }
      pagesVisitedFrom = () => new Set(merged.timelines.flatMap((tl) => tl.snapshot.pages.map((p) => p.url))).size;
      res = analyzeConsentScan(merged, { ...scanOptions, locations });
    } catch (err) {
      process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
      return 2;
    }
  } else if (collectOnly) {
    // Multi-region worker: the browser half only. The primary runs the rules.
    try {
      const { artifacts: _artifacts, ...collection } = await collectConsentScan(scanOptions);
      const handoff: ConsentCollectionHandoff = { kind: COLLECTION_KIND, schemaVersion: COLLECTION_SCHEMA_VERSION, packageVersion: pkg, property: property.id, targetUrl, runId: String(runId), collection };
      const dir = runDir(runId, cwd);
      writeCollectionHandoff(dir, handoff);
      event({ type: 'collected', runId: String(runId), runDir: dir, locations: collection.locations.map((l) => l.spec.id) });
      process.stdout.write(`run ${String(runId)}: collected ${collection.locations.length} location(s) · ${dir}\n`);
      return 0;
    } catch (err) {
      event({ type: 'error', message: err instanceof Error ? err.message : String(err) });
      throw err;
    }
  } else {
    try {
      res = await runConsentScan({
        ...scanOptions,
        onPartial: eventsFile
          ? (partial) => {
              lastPartial = partial;
              liveSite = partial.evaluation.site;
              writeLive();
            }
          : undefined,
      });
    } catch (err) {
      event({ type: 'error', message: err instanceof Error ? err.message : String(err) });
      throw err;
    }
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
  // Links in the report are run-relative; a report written elsewhere inlines screenshots but links won't resolve.
  // The classifications this report applied (the workspace read before the scan), so a served report can offer an update (R2).
  fs.writeFileSync(out, renderConsentHtml(model, { runDir: dir, render: reportRenderInfo(String(run.id), workspace) }));
  fs.writeFileSync(out.replace(/\.html?$/i, '') + '.json', JSON.stringify(model, null, 2));
  // The owner's change list, beside the report (the report links it by this name).
  const changeList = path.join(path.dirname(out), CHANGE_LIST_FILE);
  fs.writeFileSync(changeList, renderChangeListMarkdown(model));
  // The owner report, final: the same model, every visit done.
  liveSite = res.evaluation.site;
  try {
    writeOwner({ model, stage: 'final', locations: live.locations, finishedAt: res.evaluation.finishedAt, pagesVisited: pagesVisitedFrom() || undefined });
  } catch (err) {
    process.stderr.write(`owner report not written: ${err instanceof Error ? err.message : String(err)}\n`);
  }

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
