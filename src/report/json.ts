import type { Finding, Run } from '../record/index.js';
import { runDir } from '../record/index.js';
import { getRequirement, getInstrument } from '../registry/index.js';
import { SEVERITY_ORDER, aggregate, buildModel, orderFindings } from './model.js';
import type { CoverageMatrix } from './coverage.js';

// The machine-readable sibling of the HTML report: the SAME aggregated defect
// model, emitted with verbose keys so a script (or an LLM writing one) can
// find/filter/group without parsing HTML or the raw sightings stream. One
// defect per entry, sightings rolled up — mirrors what the HTML report shows.
//
// This is a report artifact, not storage: fingerprints/dispositions/SARIF stay
// on the granular findings. Text evidence is inline (`snippets`,
// `computedStyle`); image evidence is referenced by path — `evidence[].path`
// is relative to the top-level `evidenceDir`, with the crop `region` so a
// consumer can cut the exact pixels the finding is about.

export interface JsonReportOptions {
  coverage?: CoverageMatrix[];
  cwd?: string; // resolves evidenceDir the same way the HTML report does
}

// Image/artifact references from the representative sighting. dom-snippet /
// file / computed-style evidence is NOT repeated here — it is already inline
// on the defect as `snippets` and `computedStyle`.
type EvidenceRef =
  | {
      type: 'screenshot';
      path: string; // full-page capture, relative to evidenceDir
      region?: { x: number; y: number; width: number; height: number }; // element box within it
      samples?: Array<{ x: number; y: number }>; // pixels the measurement read
      swatches?: Array<{ label: string; color: string; ratio?: number }>;
      overlayPath?: string; // glyph-mask overlay PNG, same dimensions as the crop
    }
  | { type: 'agent-verdict'; cropPath: string; model: string; verdict: string; reason: string }
  | { type: 'cookie'; name: string; domain: string; phase: string; classification?: string };

function evidenceRefs(f: Finding): EvidenceRef[] {
  const out: EvidenceRef[] = [];
  for (const e of f.evidence) {
    if (e.kind === 'screenshot') {
      out.push({
        type: 'screenshot',
        path: e.path,
        ...(e.region ? { region: e.region } : {}),
        ...(e.samples?.length ? { samples: e.samples } : {}),
        ...(e.swatches?.length ? { swatches: e.swatches } : {}),
        ...(e.overlayPath ? { overlayPath: e.overlayPath } : {}),
      });
    } else if (e.kind === 'verdict') {
      out.push({ type: 'agent-verdict', cropPath: e.cropPath, model: e.model, verdict: e.verdict, reason: e.reason });
    } else if (e.kind === 'cookie') {
      out.push({
        type: 'cookie',
        name: e.name,
        domain: e.domain,
        phase: e.phase,
        ...(e.classification ? { classification: e.classification } : {}),
      });
    }
  }
  return out;
}

export function renderJsonReport(run: Run, findings: Finding[], opts: JsonReportOptions = {}): string {
  const groups = aggregate(orderFindings(findings));
  const model = buildModel(groups);

  const requirements: Record<string, { title: string; law: string; text: string }> = {};
  const counts: Record<string, number> = {};
  for (const s of SEVERITY_ORDER) counts[s] = 0;
  for (const m of model) {
    counts[m.sev] = (counts[m.sev] ?? 0) + 1;
    if (!requirements[m.req]) {
      const req = getRequirement(m.req);
      const instrument = req ? getInstrument(String(req.instrument)) : undefined;
      requirements[m.req] = { title: req?.title ?? m.req, law: instrument?.name ?? '', text: req?.text ?? '' };
    }
  }

  const defects = model.map((m, idx) => {
    const evidence = evidenceRefs(groups[idx].rep);
    return {
      id: m.i,
      severity: m.sev,
      confidence: m.conf,
      ruleId: m.rule,
      requirementId: m.req,
      requirementTitle: m.reqTitle,
      law: m.law,
      detectedBy: m.prod,
      message: m.msg,
      ...(m.url ? { url: m.url } : {}),
      ...(m.file ? { file: m.file } : {}),
      ...(m.css ? { cssPath: m.css } : {}),
      ...(m.name ? { element: m.name } : {}),
      ...(m.snips.length ? { snippets: m.snips } : {}),
      ...(m.style ? { computedStyle: m.style } : {}),
      ...(evidence.length ? { evidence } : {}),
      sightings: m.n,
      routes: m.routes.length ? m.routes : m.url ? [m.url] : [],
      ...(m.cells.length ? { cells: m.cells } : {}),
    };
  });

  const doc = {
    schemaVersion: 1,
    run: {
      id: String(run.id),
      property: run.property,
      startedAt: run.startedAt,
      ...(run.gitSha ? { gitSha: run.gitSha } : {}),
      versions: run.versions,
      accessLevels: run.accessLevels,
      // Present when the scan ran with targeting flags: this run holds ONLY
      // the targeted slice — do not diff its totals against a full run.
      ...(run.partial ? { partial: run.partial } : {}),
    },
    // Where evidence[].path / cropPath resolve from.
    evidenceDir: runDir(run.id, opts.cwd),
    // What "defect" means here, for a reader with no other context.
    aggregation:
      'One entry per defect: identical sightings (same rule+confidence+file+element markup) across routes and viewport/scheme cells are rolled up; `sightings`, `routes`, and `cells` carry the spread. `evidence` comes from the richest sighting; its screenshot `path` is relative to `evidenceDir` and `region` is the element box within that capture.',
    counts: { ...counts, defects: model.length, sightings: model.reduce((a, m) => a + m.n, 0) },
    requirements,
    defects,
    ...(opts.coverage?.length ? { coverage: opts.coverage } : {}),
    gaps: run.gaps,
  };
  return JSON.stringify(doc, null, 2) + '\n';
}
