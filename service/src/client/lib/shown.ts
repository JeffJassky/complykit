import type { JobReportResponse, OwnerReport } from '../../shared/api';
// The browser runs the SAME judgement as the server (plans/report-truth.md D): core's owner-judge.ts imports only
// cookie-purpose.ts, so the bundle must not pull in src/registry (checked in the build, see ReportPage.test.tsx).
import { judgeOwnerReport } from '../../../../src/report/owner-judge';
import type { OwnerReport as CoreOwnerReport } from '../../../../src/report/owner-types';

export { categoryLabel } from '../../../../src/report/cookie-purpose';

/** Answers the owner has given on this page that the served report may not hold yet: classKey → category. */
export type PendingAnswers = Record<string, string>;

/** Reports saved before the judge fields existed cannot be re-judged; they are shown as served. */
const judgeable = (r: OwnerReport): boolean => r.matrix.tools.every((t) => !!t.judge);

/** One report judged with its own answers plus the pending ones. Pure; the input is never mutated. */
export function judgedReport(report: OwnerReport, pending: PendingAnswers | undefined): OwnerReport {
  if (!pending || Object.keys(pending).length === 0 || !judgeable(report)) return report;
  // The service mirror differs from core in one place: `OwnerToolRow.activity` is optional here (reports made before it
  // existed), required in core. The judge only spreads it through, so the cast is safe.
  return judgeOwnerReport(report as unknown as CoreOwnerReport, { ...report.answers, ...pending }) as unknown as OwnerReport;
}

/**
 * The response the page renders from: `shown = judgeOwnerReport(report, {...report.answers, ...pending})` for the
 * final report and for each law's live report. With nothing pending the served report is already judged (judging is
 * idempotent), so it is returned as is.
 */
export function shownData(data: JobReportResponse, pending: PendingAnswers | undefined): JobReportResponse {
  if (!pending || Object.keys(pending).length === 0) return data;
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
  return Object.fromEntries(Object.entries(pending).filter(([k, v]) => served[k] !== v));
}
