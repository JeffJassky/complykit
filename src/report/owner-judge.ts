// plans/report-truth.md Part 2 D1. The owner report's judgement is one pure function: what the scan observed in a cell
// (fixed, shipped as `facts`) × the tool's category (the site's answer, else the knowledge base's). The server and the
// browser both run it, so they cannot disagree. Browser-safe: value imports ONLY from ./cookie-purpose.js.
import { categoryLabel, compareCookieBehavior, cookieCategories } from './cookie-purpose.js';
import type { OwnerCell, OwnerCellState, OwnerReport, OwnerToolRow } from './owner-types.js';

/** Categories that mean "no consent needed" (inline: report/ may not import rules/). Not 'consent': a consent tool is never refused (as refuseNecessaryTrackers). */
const NOT_REQUIRED = new Set(['necessary', 'cdn', 'captcha', 'payments']);

const COUNT_KEY: Record<OwnerCellState, keyof OwnerReport['matrix']['counts']> = {
  ok: 'ok',
  mismatch: 'mismatch',
  'needs-decision': 'needsDecision',
  pending: 'pending',
  'not-checked': 'notChecked',
  'not-applicable': 'notApplicable',
  blocked: 'blocked',
};

/** A cell re-judged for a category set; a cell without facts (a column not done) is returned as it was. */
function judgeCell(cell: OwnerCell, categories: string[]): OwnerCell {
  if (!cell.facts) return cell;
  const v = compareCookieBehavior(cell.facts, { categories });
  const state: OwnerCellState =
    cell.skip === 'not-applicable' ? 'not-applicable' : cell.skip === 'blocked' ? 'blocked' : v.status === 'match' || v.status === 'allowed' ? 'ok' : v.status === 'mismatch' ? 'mismatch' : v.status === 'review' ? 'needs-decision' : 'not-checked';
  // Repeat visits: the verdict says in how many runs it was active (as the matrix writes it).
  const note = cell.runs && cell.runs.total > 1 ? ` Active in ${cell.runs.active} of ${cell.runs.total} runs.` : '';
  return { ...cell, state, expected: v.expected, reason: v.reason + note };
}

/**
 * The owner report judged with the site's answers (`classKey → category set`). Pure: never mutates `report`, and judging
 * a report that already carries these answers changes nothing. Tools without an answer stay on `judge.base`.
 */
export function judgeOwnerReport(report: OwnerReport, answers: Record<string, string[]>): OwnerReport {
  const applied: Record<string, string[]> = {};
  const tools = report.matrix.tools.map((t): OwnerToolRow => {
    const a = answers[t.classKey];
    const bare: OwnerToolRow = { ...t };
    delete bare.answer;
    let categories: string[];
    let purpose: string;
    let answer: OwnerToolRow['answer'];
    const cats = a?.filter((c) => c && c !== 'unknown');
    if (cats?.length) {
      applied[t.classKey] = cats;
      // Refused only when EVERY category the owner chose is "no consent needed" (as purposeScopeOf): necessary + advertising is judged as given.
      if (cats.every((c) => NOT_REQUIRED.has(c)) && t.judge.trackerReason) {
        // A tracker is never necessary: it keeps the knowledge base's purpose, or — unknown — the strictest, advertising.
        const base = t.judge.base;
        categories = base.length ? base : ['advertising'];
        purpose = base.length ? categoryLabel(base) : 'Needs consent (behaves like a tracker)';
        answer = { categories: cats, applied: false, reason: t.judge.trackerReason };
      } else {
        categories = cats;
        purpose = categoryLabel(cats);
        answer = { categories: cats, applied: true };
      }
    } else {
      categories = t.judge.base;
      purpose = categoryLabel(categories);
    }
    return {
      ...bare,
      purpose,
      categories,
      classified: categories.length > 0,
      cells: t.cells.map((c) => judgeCell(c, categories)),
      cookies: t.cookies.map((k) => {
        const cats = cookieCategories(categories, k.judge);
        return { ...k, purpose: cats.length ? categoryLabel(cats) : `Depends on what ${t.label} is for`, classified: cats.length > 0, cells: k.cells.map((c) => judgeCell(c, cats)) };
      }),
      ...(answer ? { answer } : {}),
    };
  });

  const counts = { ok: 0, mismatch: 0, needsDecision: 0, pending: 0, notChecked: 0, notApplicable: 0, blocked: 0 };
  for (const t of tools) for (const c of [...t.cells, ...t.cookies.flatMap((k) => k.cells)]) counts[COUNT_KEY[c.state]]++;

  return {
    ...report,
    matrix: { ...report.matrix, tools, counts },
    decisions: tools.filter((t) => !t.classified).map((t) => ({ partyId: t.partyId, label: t.label, domain: t.domain, classKey: t.classKey })),
    answers: applied,
  };
}
