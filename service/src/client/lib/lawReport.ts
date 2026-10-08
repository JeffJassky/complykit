import type { JobReportResponse, OwnerCell, OwnerReport } from '../../shared/api';
import { LAWS, type LawId } from '../../shared/laws';

// One law's view of an owner report (plans/per-law-report-contract.md, C2). Pure; the
// input is never mutated.

type Counts = OwnerReport['matrix']['counts'];

const COUNT_KEY: Record<OwnerCell['state'], keyof Counts> = {
  ok: 'ok',
  mismatch: 'mismatch',
  'needs-decision': 'needsDecision',
  pending: 'pending',
  'not-checked': 'notChecked',
};

/** That location's view of a multi-location owner report: its columns, its cells, its banner. */
export function reportForLocation(report: OwnerReport, locationId: string): OwnerReport {
  const keep: number[] = [];
  report.matrix.columns.forEach((c, i) => {
    if (c.location === locationId) keep.push(i);
  });
  const pick = (cells: OwnerCell[]): OwnerCell[] => keep.map((i) => cells[i]).filter((c): c is OwnerCell => c !== undefined);
  const final = report.stage === 'final';

  const tools = report.matrix.tools
    .map((t) => ({ ...t, cells: pick(t.cells), cookies: t.cookies.map((c) => ({ ...c, cells: pick(c.cells) })) }))
    .filter((t) => !(final && t.cells.every((c) => c.state === 'pending')));

  const counts: Counts = { ok: 0, mismatch: 0, needsDecision: 0, pending: 0, notChecked: 0 };
  for (const t of tools) {
    for (const c of t.cells) counts[COUNT_KEY[c.state]] += 1;
    for (const k of t.cookies) for (const c of k.cells) counts[COUNT_KEY[c.state]] += 1;
  }

  const loc = report.locations?.find((l) => l.id === locationId);
  const scan = { ...report.scan };
  if (loc) {
    scan.location = { id: loc.id, label: loc.label, verified: loc.verified, ...(loc.observed !== undefined ? { observed: loc.observed } : {}), ...(loc.note !== undefined ? { note: loc.note } : {}) };
    scan.visitsDone = loc.visitsDone;
    scan.visitsTotal = loc.visitsTotal;
  }

  return {
    ...report,
    scan,
    banner: loc ? loc.banner : report.banner,
    matrix: { ...report.matrix, // One location per tab: the per-column location label would only repeat the tab's name.
    columns: keep.map((i) => {
      const { locationLabel: _l, ...c } = report.matrix.columns[i];
      return c;
    }), tools, counts },
  };
}

/** The report to show in a law's tab: its live report while running, else the final report cut to its location; null when nothing is known yet. */
export function tabReport(data: JobReportResponse, law: LawId): OwnerReport | null {
  const live = data.laws?.find((l) => l.id === law)?.report;
  if (live) return live;
  if (!data.report) return null;
  const def = LAWS.find((l) => l.id === law);
  return def ? reportForLocation(data.report, def.locationId) : null;
}
