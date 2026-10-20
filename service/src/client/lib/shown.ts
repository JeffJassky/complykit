import type { JobReportResponse, OwnerReport } from '../../shared/api';
// The browser runs the SAME judgement as the server (plans/report-truth.md D): core's owner-judge.ts imports only
// cookie-purpose.ts, so the bundle must not pull in src/registry. That is enforced by the core test
// test/owner-judge.test.ts "browser-safe" (import lines of owner-judge.ts and cookie-purpose.ts), not by a ReportPage test.
import { judgeOwnerReport } from '../../../../src/report/owner-judge';
import type { OwnerReport as CoreOwnerReport } from '../../../../src/report/owner-types';

export { categoryLabel } from '../../../../src/report/cookie-purpose';

/** Answers the owner has given on this page that the served report may not hold yet: classKey → category set. */
export type PendingAnswers = Record<string, string[]>;

/** Reports saved before the judge fields existed cannot be re-judged; they are shown as served. */
export const judgeable = (r: OwnerReport): boolean => r.matrix.tools.every((t) => !!t.judge);
/** One tool row of such a report (the mirror types `judge` as always present; a saved legacy report has none). */
export const toolJudgeable = (t: OwnerReport['matrix']['tools'][number]): boolean => !!t.judge;

/** Same set of categories, any order. */
export function sameCategories(a: readonly string[], b: readonly string[]): boolean {
  const sa = new Set(a);
  const sb = new Set(b);
  return sa.size === sb.size && [...sa].every((c) => sb.has(c));
}

/** One report judged with its own answers plus the pending ones — always, so the page shows the judge's verdicts and never a
 *  server-written cell the judge would not produce. Pure; the input is never mutated. */
export function judgedReport(report: OwnerReport, pending: PendingAnswers | undefined): OwnerReport {
  if (!judgeable(report)) return report;
  // The service mirror differs from core in one place: `OwnerToolRow.activity` is optional here (reports made before it
  // existed), required in core. The judge only spreads it through, so the cast is safe.
  return judgeOwnerReport(report as unknown as CoreOwnerReport, { ...report.answers, ...pending }) as unknown as OwnerReport;
}

/**
 * The response the page renders from: `shown = judgeOwnerReport(report, {...report.answers, ...pending})` for the
 * final report and for each law's live report (judging is idempotent: a served report already judged with the same
 * answers comes out identical).
 */
export function shownData(data: JobReportResponse, pending: PendingAnswers | undefined): JobReportResponse {
  return {
    ...data,
    report: data.report ? judgedReport(data.report, pending) : data.report,
    ...(data.laws ? { laws: data.laws.map((l) => (l.report ? { ...l, report: judgedReport(l.report, pending) } : l)) } : {}),
  };
}

/**
 * The pending answers still owed: one goes once a report that holds THIS answer has arrived AND no report is still
 * being made (a report served mid-update may hold an older answer for the tool, or an old one a "Change" replaces).
 */
export function answersAfter(pending: PendingAnswers, data: JobReportResponse): PendingAnswers {
  if (!data.report || data.updating) return pending;
  const served = data.report.answers ?? {};
  return Object.fromEntries(Object.entries(pending).filter(([k, v]) => !(served[k] && sameCategories(served[k], v))));
}
