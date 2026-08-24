import type { Finding, Severity } from '../record/index.js';
import { getRequirement, getInstrument } from '../registry/index.js';

// The report-layer defect model, shared by the HTML report and the JSON
// sidecar. Aggregation lives HERE (report-layer only — stored findings stay
// granular for fingerprints/dispositions/SARIF): identical sightings collapse
// onto one defect. The defect key is rule + source file + the element's own
// markup (dom snippet, else cssPath, else name) — an identical snippet in the
// same file IS the same element. The message is deliberately NOT in the key:
// measured ratios wobble across viewports and would defeat the merge. What
// varies across sightings (routes, viewport×scheme cells, instance count) is
// carried as aggregate fields; evidence comes from the richest sighting.

export const SEVERITY_ORDER: Severity[] = ['critical', 'serious', 'moderate', 'minor'];
export const severityRank = (s: Severity): number => {
  const i = SEVERITY_ORDER.indexOf(s);
  return i === -1 ? SEVERITY_ORDER.length : i;
};

// Display labels for computed-style keys — also maps keys stored by older
// scans onto the current vocabulary, so a relabel never requires a rescan.
const STYLE_LABELS: Record<string, string> = {
  'color-var': 'matching color vars',
  'background-var': 'matching bg color vars',
  'gradient-vars': 'gradient vars (authored)',
};
export function relabelStyle(props: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(props)) out[STYLE_LABELS[k] ?? k] = v;
  return out;
}

// One compact record per DEFECT. In the HTML report this is embedded as JSON
// and drives grouping/filtering/copy; the JSON sidecar re-emits it with
// verbose keys for scripting.
export interface FindingModel {
  i: number;
  sev: Severity;
  conf: string;
  rule: string;
  req: string;
  reqTitle: string;
  law: string; // instrument name ("WCAG 2.2", "GDPR", …)
  prod: string; // "engine:axe-core" | "rule" | "agent:model"
  msg: string;
  route?: string; // primary (first-seen) route
  url?: string;
  vp?: string;
  scheme?: string;
  file?: string; // "path:line"
  css?: string;
  name?: string; // accessible/text name of the element
  snips: string[]; // code/dom snippets (text)
  style?: Record<string, string>;
  // aggregate fields
  n: number; // total sightings collapsed into this defect
  routes: string[]; // every distinct route/page it was seen on
  cells: string[]; // every distinct "viewport/scheme" it was seen in
}

export function producerLabel(f: Finding): string {
  const p = f.producer;
  if (p.type === 'engine') return `engine:${p.name}`;
  if (p.type === 'agent') return `agent:${p.model}`;
  return 'rule';
}

/** The defect key: which sightings are the SAME defect. See module comment. */
export function defectKey(f: Finding): string {
  const s = f.subject;
  const snip = f.evidence.find((e) => e.kind === 'dom-snippet');
  const filek = f.evidence.find((e) => e.kind === 'file');
  const elem =
    (snip && snip.kind === 'dom-snippet' ? snip.html : '') ||
    (filek && filek.kind === 'file' ? `${filek.path}:${filek.line}` : '') ||
    s.locator?.cssPath ||
    s.locator?.name ||
    '';
  return [String(f.ruleId), f.confidence, s.file?.path ?? '', elem].join(' ');
}

/** Richer evidence wins the representative slot (its card is what renders). */
export function evidenceScore(f: Finding): number {
  let n = 0;
  for (const e of f.evidence) {
    if (e.kind === 'screenshot') n += 4;
    if (e.kind === 'computed-style') n += 2;
    if (e.kind === 'dom-snippet' || e.kind === 'file') n += 1;
  }
  return n;
}

export interface DefectGroup {
  rep: Finding;
  n: number;
  routes: string[];
  cells: string[];
}

export function aggregate(findings: Finding[]): DefectGroup[] {
  const groups = new Map<string, DefectGroup & { routeSet: Set<string>; cellSet: Set<string> }>();
  const order: string[] = [];
  for (const f of findings) {
    const key = defectKey(f);
    const s = f.subject;
    const route = s.routePattern ?? s.instanceUrl ?? '';
    const cell = s.viewport ? `${s.viewport}${s.colorScheme ? `/${s.colorScheme}` : ''}` : '';
    let g = groups.get(key);
    if (!g) {
      g = { rep: f, n: 0, routes: [], cells: [], routeSet: new Set(), cellSet: new Set() };
      groups.set(key, g);
      order.push(key);
    }
    g.n++;
    if (route && !g.routeSet.has(route)) {
      g.routeSet.add(route);
      g.routes.push(route);
    }
    if (cell && !g.cellSet.has(cell)) {
      g.cellSet.add(cell);
      g.cells.push(cell);
    }
    if (evidenceScore(f) > evidenceScore(g.rep)) g.rep = f;
  }
  return order.map((k) => groups.get(k)!);
}

export function buildModel(groups: DefectGroup[]): FindingModel[] {
  return groups.map((g, i) => {
    const f = g.rep;
    const s = f.subject;
    const req = getRequirement(String(f.requirementId));
    const instrument = req ? getInstrument(String(req.instrument)) : undefined;
    const snips: string[] = [];
    let style: Record<string, string> | undefined;
    for (const e of f.evidence) {
      if (e.kind === 'file') snips.push(`${e.path}:${e.line}\n${e.snippet}`);
      else if (e.kind === 'dom-snippet') snips.push(e.html);
      else if (e.kind === 'computed-style') style = relabelStyle(e.properties);
    }
    return {
      i,
      sev: f.severity,
      conf: f.confidence,
      rule: String(f.ruleId),
      req: String(f.requirementId),
      reqTitle: req?.title ?? String(f.requirementId),
      law: instrument?.name ?? (req ? String(req.instrument) : 'unknown'),
      prod: producerLabel(f),
      msg: f.message,
      route: s.routePattern,
      url: s.instanceUrl,
      vp: s.viewport,
      scheme: s.colorScheme,
      file: s.file ? `${s.file.path}${s.file.line != null ? `:${s.file.line}` : ''}` : undefined,
      css: s.locator?.cssPath,
      name: s.locator?.name,
      snips,
      style,
      n: g.n,
      routes: g.routes,
      cells: g.cells,
    };
  });
}

/** Severity-major, then rule — the stable order both report surfaces share. */
export function orderFindings(findings: Finding[]): Finding[] {
  return [...findings].sort(
    (a, b) => severityRank(a.severity) - severityRank(b.severity) || String(a.ruleId).localeCompare(String(b.ruleId)),
  );
}
