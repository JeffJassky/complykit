import type { ScenarioId } from '../record/index.js';
import type { RemediationTask } from '../record/index.js';
import type { BehaviorMatrix, BehaviorMatrixCell } from '../../types/index.js';
import type { ConsentReportModel } from './consent-model.js';
import { buildBehaviorMatrix, categoryLabel } from './consent-matrix.js';
import { workspaceId } from './workspace.js';
import { compareCookieBehavior } from './cookie-purpose.js';
import { hostedOn } from '../registry/index.js';

// The owner report (plans/simple-report.md): the one page a site owner reads.
// Four parts, in order — scan status, consent banner, the matrix, the to-do
// list — as one JSON model the service serves at GET /api/jobs/:id/report and
// the web UI renders. Built from the SAME report model as the full HTML report
// (buildConsentReportModel → buildBehaviorMatrix), so the two never disagree.
//
// It is built twice over: live, after every finished visit, from the analysis
// of the visits finished so far (the CLI rewrites the file each time — columns
// still to visit are `pending`, rows appear as visits discover tools), and
// final, when the run is written (and again on every re-render with the site's
// classifications). The service overlays the to-do list from the site workspace.
//
// Cell states, in the owner's words:
//   pending          not checked yet (the visit is still to come, or running)
//   ok               behaved as expected for its purpose under the location's rules
//   mismatch         active where it should be off (not a legal verdict)
//   needs-decision   we need you: what the tool is for, or a use that depends on the site
//   not-checked      the visit could not complete — one note for the whole column

export const OWNER_REPORT_FILE = 'owner-report.json';

export type OwnerCellState = 'pending' | 'ok' | 'mismatch' | 'needs-decision' | 'not-checked';

export interface OwnerCell {
  state: OwnerCellState;
  /** What the rules expect here ("Off after the visitor refused"). */
  expected?: string;
  /** What the scan saw ("2 data request(s) observed …"). */
  observed?: string;
  /** Why the state (a mismatch, a gap, what to decide). */
  reason?: string;
  /** Repeat visits: active in `active` of `total`. */
  runs?: { total: number; active: number };
}

export interface OwnerColumn {
  /** `<location>:<scenario>` — the full report's matrix column id. */
  id: string;
  location: string;
  scenario: string;
  /** Plain name of the visitor action ("After rejection"). */
  label: string;
  /** Set only when the scan covers more than one location. */
  locationLabel?: string;
  /** pending = still to visit; running = being visited now; done; not-checked = the visit could not complete (see note). */
  state: 'pending' | 'running' | 'done' | 'not-checked';
  /** Why the whole column is not checked — said once, not per cell. */
  note?: string;
}

export interface OwnerCookieRow {
  id: string;
  name: string;
  /** cookie | local | session */
  kind: string;
  purpose: string;
  classified: boolean;
  cells: OwnerCell[];
}

export interface OwnerToolRow {
  /** `tool:<partyId>` */
  id: string;
  partyId: string;
  label: string;
  domain: string;
  /** Plain purpose ("Advertising") or "Unclassified". */
  purpose: string;
  categories: string[];
  classified: boolean;
  /** Known to the tool library (or classified by your team). */
  recognized: boolean;
  /** The site-workspace key a classification of this tool is saved under (class:<id>), as the full report writes it. */
  classKey: string;
  cells: OwnerCell[];
  cookies: OwnerCookieRow[];
  /** What the scan saw the tool do: requests only, or storing cookies / storage too. */
  activity: OwnerToolActivity;
}

export interface OwnerToolActivity {
  /** Requests to the tool across the finished visits, and how many visits saw it. */
  requests: number;
  visits: number;
  /** Cookies and browser-storage keys it set (the rows under the tool). */
  cookies: number;
  storage: number;
  /** Example addresses it loaded: host + path, query keys only (values are data, never shown). */
  samples: string[];
  /** The scripts that loaded it, nearest first. */
  loadedBy: string[];
  /** On a shared cloud or hosting platform: who hosts it, the tenant's name, and whether that name matches the site's. */
  hostedOn?: { provider: string; name: string; matchesSite: boolean };
}

export interface OwnerReport {
  version: 1;
  /** live: built from the visits finished so far; final: the finished run (re-rendered with the site's classifications). */
  stage: 'live' | 'final';
  runId: string;
  generatedAt: string;
  site: { url: string; host: string; domain: string };
  scan: {
    startedAt: string;
    finishedAt?: string;
    visitsDone: number;
    visitsTotal: number;
    /** Distinct pages the visits loaded so far. */
    pagesVisited: number;
    /** The visit running now, in plain words ("After rejection"). */
    current?: string;
    location?: { id: string; label: string; observed?: string; verified: boolean; note?: string };
  };
  banner: {
    /** pending = no visit has finished yet. */
    state: 'pending' | 'detected' | 'none';
    /** Display name of the banner's provider (CMP), when recognized. */
    provider?: string;
    visitsWithBanner: number;
    visitsChecked: number;
    /** Consent tools the scan saw loading (e.g. OneTrust), banner or not. */
    consentTools?: string[];
  };
  matrix: {
    columns: OwnerColumn[];
    tools: OwnerToolRow[];
    counts: Record<'ok' | 'mismatch' | 'needsDecision' | 'pending' | 'notChecked', number>;
  };
  /** Tools whose purpose is not known yet: the first to-do items, before the checklist exists. */
  decisions: Array<{ partyId: string; label: string; domain: string; classKey: string }>;
  /** The checklist this run's report carries (the generated config's tasks), when there is one. The service replaces it with the site workspace's, with live status. */
  todo?: { tasks: RemediationTask[]; configAt?: string; runId?: string };
}

type InventoryItem = ConsentReportModel['inventory'][number];

function activityOf(p: InventoryItem, cookies: OwnerCookieRow[], siteDomain: string): OwnerToolActivity {
  const on = hostedOn(p.domain);
  // 'storyfolder.com' → 'storyfolder': a tenant named like the site is probably the site's own.
  const brand = siteDomain.split('.')[0] ?? '';
  return {
    requests: (p.seenIn ?? []).reduce((n, x) => n + x.requests, 0),
    visits: (p.seenIn ?? []).length,
    cookies: cookies.filter((k) => k.kind === 'cookie').length,
    storage: cookies.filter((k) => k.kind !== 'cookie').length,
    samples: p.samples ?? [],
    loadedBy: p.loadedBy ?? [],
    ...(on ? { hostedOn: { ...on, matchesSite: brand.length >= 4 && on.name.includes(brand) } } : {}),
  };
}

/** One planned column: a scenario at a location, visited `runs` times. */
export interface OwnerPlanItem {
  location: string;
  scenario: string;
  runs?: number;
}

export interface OwnerReportInput {
  /** The report model over the visits finished so far (absent before the first visit finishes). */
  model?: ConsentReportModel;
  stage: 'live' | 'final';
  runId: string;
  site: { url: string; host: string; registrableDomain: string };
  startedAt: string;
  finishedAt?: string;
  /** The visits planned, in visit order. Absent = every scenario of the model, all done (a re-render). */
  plan?: OwnerPlanItem[];
  /** Finished visits (repeats carry run 2..N). */
  done?: Array<{ location: string; scenario: string; run?: number }>;
  /** The visit running now. */
  current?: { location: string; scenario: string; run?: number };
  pagesVisited?: number;
  /** Locations announced before any of their visits finished (their plan, verdict). */
  locations?: Array<{ id: string; label?: string; verdict: string; observed?: string; note?: string }>;
  generatedAt?: string;
}

/** Plain column names (the full report's matrix headings). */
export const OWNER_SCENARIO_LABEL: Record<string, string> = {
  'do-nothing': 'Before a choice',
  browse: 'Browse without choosing',
  dismiss: 'Banner closed without choosing',
  reject: 'After rejection',
  accept: 'After acceptance',
  partial: 'After accepting analytics only',
  withdraw: 'After withdrawal',
  'return-visit': 'Returning after rejection',
  gpc: 'Privacy signal (GPC)',
  'opt-out-all': 'After opting out every way',
  'opt-out-link': 'After the opt-out link',
  markers: 'Sample information test',
};

const CMP_NAME: Record<string, string> = {
  onetrust: 'OneTrust',
  cookiebot: 'Cookiebot',
  shopify: 'Shopify',
  usercentrics: 'Usercentrics',
  complianz: 'Complianz',
  didomi: 'Didomi',
  trustarc: 'TrustArc',
  quantcast: 'Quantcast Choice',
  sourcepoint: 'Sourcepoint',
  iubenda: 'iubenda',
  termly: 'Termly',
  osano: 'Osano',
  cookieyes: 'CookieYes',
  complykit: 'complykit',
  klaro: 'Klaro',
  axeptio: 'Axeptio',
  borlabs: 'Borlabs Cookie',
  'cookie-script': 'Cookie Script',
  wix: 'Wix',
  squarespace: 'Squarespace',
};

/** A consent banner provider's display name, from the scanner's CMP id ("onetrust", "Cookiebot", "shopify-…"). */
export function bannerProviderName(cmp: string | undefined): string | undefined {
  if (!cmp || cmp === 'banner' || cmp === 'no banner') return undefined;
  const key = cmp.toLowerCase().replace(/[^a-z0-9-]/g, '');
  for (const [id, name] of Object.entries(CMP_NAME)) if (key === id || key.startsWith(id + '-') || key.startsWith(id)) return name;
  return cmp.charAt(0).toUpperCase() + cmp.slice(1);
}

const isChoice = (s: string): boolean => ['reject', 'accept', 'partial', 'withdraw', 'dismiss', 'opt-out-all', 'opt-out-link', 'return-visit'].includes(s);

function cellOf(c: BehaviorMatrixCell | undefined): OwnerCell {
  if (!c) return { state: 'not-checked', reason: 'Nothing was recorded for this visit.' };
  const state: OwnerCellState =
    c.status === 'match' || c.status === 'allowed' ? 'ok' : c.status === 'mismatch' ? 'mismatch' : c.status === 'review' ? 'needs-decision' : 'not-checked';
  return { state, expected: c.expected, observed: c.observed, reason: c.reason, ...(c.runs ? { runs: c.runs } : {}) };
}

const visitKey = (v: { location: string; scenario: string; run?: number }): string => `${v.location}|${v.scenario}|${v.run && v.run > 1 ? v.run : 1}`;

/**
 * The owner report from the report model of the visits finished so far (live)
 * or of the whole run (final). Pure.
 */
export function buildOwnerReport(input: OwnerReportInput): OwnerReport {
  const m = input.model;
  const bm: BehaviorMatrix | undefined = m ? (m.behaviorMatrix ?? buildBehaviorMatrix(m)) : undefined;

  // Locations: the model's (verified or not), else the ones announced so far.
  const locations = m
    ? m.locations.map((l) => ({ id: l.id, label: l.label, verified: l.verdict === 'verified', observed: l.observed, note: l.note }))
    : (input.locations ?? []).map((l) => ({ id: l.id, label: l.label ?? l.id, verified: l.verdict === 'verified', observed: l.observed, note: l.note }));
  for (const l of input.locations ?? []) {
    if (!locations.some((x) => x.id === l.id)) locations.push({ id: l.id, label: l.label ?? l.id, verified: l.verdict === 'verified', observed: l.observed, note: l.note });
  }
  const multi = locations.length > 1;

  // The plan: given (live), else every scenario of every verified location (final, re-render).
  const plan: OwnerPlanItem[] =
    input.plan ??
    (m ? m.locations.filter((l) => l.verdict === 'verified').flatMap((l) => m.scenarios.filter((s) => m.grid[l.id]?.[s] && m.grid[l.id]![s]!.status !== 'not-run').map((s) => ({ location: l.id, scenario: s as string }))) : []);
  const done = new Set((input.done ?? []).map(visitKey));
  // Final (the run is written, or re-rendered): everything planned is finished.
  const allDone = input.stage === 'final' || !input.plan;

  const columns: OwnerColumn[] = [];
  const seen = new Set<string>();
  for (const p of plan) {
    const id = `${p.location}:${p.scenario}`;
    if (seen.has(id)) continue;
    seen.add(id);
    const runs = Math.max(1, p.runs ?? 1);
    const finished = allDone || Array.from({ length: runs }, (_, i) => visitKey({ location: p.location, scenario: p.scenario, run: i + 1 })).every((k) => done.has(k));
    const label = OWNER_SCENARIO_LABEL[p.scenario] ?? p.scenario;
    const locationLabel = multi ? locations.find((l) => l.id === p.location)?.label ?? p.location : undefined;
    const base = { id, location: p.location, scenario: p.scenario, label, ...(locationLabel ? { locationLabel } : {}) };
    if (!finished) {
      const running = input.current && input.current.location === p.location && input.current.scenario === p.scenario;
      columns.push({ ...base, state: running ? 'running' : 'pending' });
      continue;
    }
    const col = bm?.columns.find((c) => c.id === id);
    if (col?.unavailable) {
      columns.push({ ...base, state: 'not-checked', note: col.unavailable.reason });
    } else if (col) {
      columns.push({ ...base, state: 'done' });
    } else {
      // The visit finished but nothing in it could be compared: no banner to act on, or it did not complete.
      const grid = m?.grid[p.location]?.[p.scenario as ScenarioId];
      const note =
        grid?.status === 'not-applicable'
          ? isChoice(p.scenario)
            ? 'There was no consent banner, so this choice couldn’t be made.'
            : 'This visit did not apply to the site.'
          : grid?.reason
            ? `This visit could not be completed: ${grid.reason}.`
            : 'This visit could not be completed.';
      columns.push({ ...base, state: 'not-checked', note });
    }
  }

  // One column order for live and final alike: by location, then the report's scenario order.
  const SCENARIOS = Object.keys(OWNER_SCENARIO_LABEL);
  const locIndex = (id: string): number => {
    const i = locations.findIndex((l) => l.id === id);
    return i < 0 ? locations.length : i;
  };
  const scIndex = (s: string): number => {
    const i = SCENARIOS.indexOf(s);
    return i < 0 ? SCENARIOS.length : i;
  };
  columns.sort((a, b) => locIndex(a.location) - locIndex(b.location) || scIndex(a.scenario) - scIndex(b.scenario));

  const cellsFor = (row: BehaviorMatrix['rows'][number] | undefined): OwnerCell[] =>
    columns.map((col) => {
      if (col.state === 'pending' || col.state === 'running') return { state: 'pending' };
      if (col.state === 'not-checked') return { state: 'not-checked', reason: col.note };
      const i = bm ? bm.columns.findIndex((c) => c.id === col.id) : -1;
      return cellOf(i >= 0 ? row?.cells[i] : undefined);
    });

  const tools: OwnerToolRow[] = [];
  for (const p of m?.inventory ?? []) {
    const toolRow = bm?.rows.find((r) => r.kind === 'tool' && r.partyId === p.partyId);
    const categories = (toolRow?.categories ?? p.categories).filter((c) => c && c !== 'unknown');
    const purpose = categoryLabel(categories);
    const cookies: OwnerCookieRow[] = (bm?.rows ?? [])
      .filter((r) => r.kind === 'storage' && r.partyId === p.partyId)
      .map((r) => {
        let cats = r.categories.filter((c) => c && c !== 'unknown');
        let row = r;
        // A cookie of a tool your team classified takes the tool's purpose (the full
        // report's rule for a recognized tool), judged on the same facts.
        if (!cats.length && categories.length) {
          cats = categories;
          row = { ...r, cells: r.cells.map((c) => (c.comparisonFacts && c.status === 'review' ? { ...c, ...compareCookieBehavior(c.comparisonFacts as Parameters<typeof compareCookieBehavior>[0], { categories }) } : c)) };
        }
        return { id: r.id, name: r.label, kind: r.storageKind ?? 'cookie', purpose: categoryLabel(cats), classified: cats.length > 0, cells: cellsFor(row) };
      })
      .sort((a, b) => a.name.localeCompare(b.name));
    tools.push({
      id: 'tool:' + p.partyId,
      partyId: p.partyId,
      label: p.label,
      domain: p.domain,
      purpose,
      categories,
      classified: categories.length > 0,
      recognized: p.recognized,
      classKey: 'class:' + workspaceId('tool', [p.partyId, p.domain]),
      cells: cellsFor(toolRow),
      cookies,
      activity: activityOf(p, cookies, input.site.registrableDomain),
    });
  }

  const counts = { ok: 0, mismatch: 0, needsDecision: 0, pending: 0, notChecked: 0 };
  const KEY: Record<OwnerCellState, keyof typeof counts> = { ok: 'ok', mismatch: 'mismatch', 'needs-decision': 'needsDecision', pending: 'pending', 'not-checked': 'notChecked' };
  for (const t of tools) for (const c of [...t.cells, ...t.cookies.flatMap((k) => k.cells)]) counts[KEY[c.state]]++;

  // The banner: seen in any finished visit, and by whom.
  const visits = m ? m.locations.flatMap((l) => Object.values(m.grid[l.id] ?? {}).filter((c) => c && c.status !== 'not-run' && c.banner !== undefined)) : [];
  const withBanner = visits.filter((c) => c!.banner && c!.banner !== 'no banner');
  const provider = withBanner.map((c) => bannerProviderName(c!.banner)).find(Boolean);
  const banner: OwnerReport['banner'] = {
    state: withBanner.length ? 'detected' : visits.length ? 'none' : 'pending',
    ...(provider ? { provider } : {}),
    visitsWithBanner: withBanner.length,
    visitsChecked: visits.length,
  };
  const consentTools = (m?.inventory ?? []).filter((p) => p.categories.includes('consent')).map((p) => p.label);
  if (consentTools.length) banner.consentTools = consentTools;

  const visitsTotal = plan.reduce((n, p) => n + Math.max(1, p.runs ?? 1), 0);
  const visitsDone = allDone ? visitsTotal : Math.min(visitsTotal, done.size);
  const cur = input.current;
  const location = locations[0];

  return {
    version: 1,
    stage: input.stage,
    runId: input.runId,
    generatedAt: input.generatedAt ?? new Date().toISOString(),
    site: { url: input.site.url, host: input.site.host, domain: input.site.registrableDomain },
    scan: {
      startedAt: input.startedAt,
      ...(input.finishedAt ? { finishedAt: input.finishedAt } : {}),
      visitsDone,
      visitsTotal,
      pagesVisited: input.pagesVisited ?? Math.max(0, ...(m?.behaviorObservations ?? []).map((o) => o.pages ?? 0)),
      ...(cur ? { current: `${OWNER_SCENARIO_LABEL[cur.scenario] ?? cur.scenario}${cur.run && cur.run > 1 ? ' (slow connection)' : ''}${multi ? ` · ${locations.find((l) => l.id === cur.location)?.label ?? cur.location}` : ''}` } : {}),
      ...(location ? { location: { id: location.id, label: location.label, verified: location.verified, ...(location.observed ? { observed: location.observed } : {}), ...(location.note ? { note: location.note } : {}) } } : {}),
    },
    banner,
    matrix: { columns, tools, counts },
    decisions: tools.filter((t) => !t.classified).map((t) => ({ partyId: t.partyId, label: t.label, domain: t.domain, classKey: t.classKey })),
    ...(m?.remediation?.tasks.length ? { todo: { tasks: m.remediation.tasks, ...(m.remediation.configAt ? { configAt: m.remediation.configAt } : {}), ...(m.remediation.runId ? { runId: m.remediation.runId } : {}) } } : {}),
  };
}
