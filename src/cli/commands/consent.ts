import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { runIdFromTimestamp, runDir, writeTrackingEvaluation, ScenarioId, type LocationSpec } from '../../record/index.js';
import { buildKnowledgeBase, type KnowledgeEntryInput, type PartyCategory } from '../../registry/index.js';
import { tracking } from '../../rules/index.js';
import { buildConsentReportModel, renderConsentHtml, renderConsentMarkdown } from '../../report/index.js';
import { runConsentScan } from '../../pipeline.js';
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
  --out <file>             HTML report path (default: <run>/consent-report.html)
  --quiet                  no per-scenario narration

Every location's exit is verified in two geolocation sources before any finding
is attributed to it; anything unverified is reported as not tested.`;

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
      out: { type: 'string' },
      quiet: { type: 'boolean' },
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

  // Knowledge base: seed + local confirmed entries + per-site overrides.
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
  const knowledgeBase = buildKnowledgeBase({
    extra,
    overrides: cc.knowledgeBase?.overrides?.map((o) => ({ ...o, categories: o.categories as PartyCategory[] | undefined })),
  });

  const now = new Date().toISOString();
  const runId = runIdFromTimestamp(now);
  const trace = values.quiet ? undefined : (line: string) => process.stdout.write(`    ${line}\n`);
  process.stdout.write(`consent evaluation: ${targetUrl} (config: ${source})\n`);
  process.stdout.write(`  locations: ${locations.map((l) => `${l.id}${l.proxy ? ' [proxy]' : ''}`).join(', ')}${values.quick ? ' · quick' : ''}\n`);

  const res = await runConsentScan({
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
    trace,
  });

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
  const out = values.out ? path.resolve(cwd, values.out) : path.join(dir, 'consent-report.html');
  // Links in the report are run-relative; a report written elsewhere inlines screenshots but links won't resolve.
  fs.writeFileSync(out, renderConsentHtml(model, { runDir: dir }));
  fs.writeFileSync(out.replace(/\.html?$/i, '') + '.json', JSON.stringify(model, null, 2));

  process.stdout.write('\n' + renderConsentMarkdown(model, { maxFindings: 15 }));
  process.stdout.write(`\nrun ${String(run.id)}: ${written} finding(s) · report ${out}\n`);
  return 0;
}
