// The grace a revoking choice gets (#52, #57): requests the vendor had queued, flushed on the choice's page
// as it is told. ONE definition for the behavior grid (summarizeBehavior) and the violation rules
// (tracking.withdrawal, tracking.prior-consent), so the two never disagree about the same request.
import type { Timeline } from '../../record/index.js';
import { REJECT_GRACE_PHASE, WITHDRAW_GRACE_MS, WITHDRAW_GRACE_PHASE, type PartyRequest, type TimelineAnalysis } from './analyze.js';

/** The page a revoking choice was made on and when leaving it ends the grace (see inChoiceGrace). */
interface ChoiceWindow {
  t: number;
  pageIndex: number;
  /** The phase the choice starts ('after-withdraw' / 'after-reject'). */
  phase: string;
  /** When the page started going away: the tool's own reload request, or else the scanner's reload / navigation. */
  exitT?: number;
  /** When the next page committed: the first event on a later page (choice events excluded — they are stamped late). */
  commitT?: number;
  /** Page-exit sends after exitT count as grace (withdraw only; a reject's grace is the bounded window alone). */
  exitSends: boolean;
}

/**
 * Locate the page a choice was made on and its exit. The choice event's `t`
 * is the step's start, but its pageIndex is stamped after the step ended
 * (after the tool's own reload, when it reloads): the choice page is the page
 * of the last other event at or before `t` (#52).
 */
export function choiceWindow(tl: Timeline, c: { t: number; pageIndex: number }, phase: string, exitSends: boolean): ChoiceWindow {
  let pageIndex = c.pageIndex;
  for (const e of tl.events) {
    if (!('t' in e) || e.type === 'choice' || typeof e.pageIndex !== 'number') continue;
    if (e.t > c.t) break;
    pageIndex = e.pageIndex;
  }
  const after = tl.events.filter((e) => 't' in e && e.t >= c.t && e.type !== 'choice' && typeof e.pageIndex === 'number');
  const reload = after.find((e) => e.type === 'request' && e.resourceType === 'document' && e.origin === 'page' && e.initiator?.type === 'script' && e.pageIndex === pageIndex);
  const scannerExit = after.find((e) => e.type === 'action' && (e.action === 'reload' || e.action === 'navigate') && e.pageIndex === pageIndex);
  const exit = reload ?? scannerExit;
  const commit = after.find((e) => (e.pageIndex as number) > pageIndex);
  return { t: c.t, pageIndex, phase, exitSends, ...(exit ? { exitT: exit.t } : {}), ...(commit ? { commitT: commit.t } : {}) };
}

/**
 * Is this request part of a revoking choice's grace (#52, #57)? Sent on the
 * page the choice was made on, before the next page committed, and either
 *  - within WITHDRAW_GRACE_MS of the choice step's start (data the vendor had
 *    queued, flushed as it is told), or
 *  - withdraw only: a page-exit send (sendBeacon / keepalive at pagehide)
 *    after the reload started — the page going away, not new activity.
 * Everything else counts, however long the reload takes. No commit observed:
 * the page-exit allowance ends WITHDRAW_GRACE_MS after the exit started (fail
 * closed). Data requests and loads alike; storage writes never get grace.
 */
export function inChoiceGrace(r: Pick<PartyRequest, 't' | 'pageIndex' | 'phase' | 'origin'>, w: ChoiceWindow | undefined): boolean {
  if (!w || r.phase !== w.phase || r.pageIndex !== w.pageIndex || r.t < w.t) return false;
  if (w.commitT !== undefined && r.t >= w.commitT) return false;
  if (r.t - w.t <= WITHDRAW_GRACE_MS) return true;
  return w.exitSends && r.origin === 'exit-beacon' && w.exitT !== undefined && r.t >= w.exitT && (w.commitT !== undefined || r.t < w.exitT + WITHDRAW_GRACE_MS);
}

/**
 * Per party: which grace (if any) a request falls in — WITHDRAW_GRACE_PHASE, REJECT_GRACE_PHASE, or undefined.
 * Withdraw: every vendor. #57: a reject that revokes a granted state (an opt-out regime's default, or a
 * returning visitor's change of mind) is a withdrawal for a vendor that was already active: the same bounded
 * grace, for that vendor only. A vendor held until the choice (nothing granted) has nothing to flush.
 */
export function choiceGrace(tl: Timeline, a: Pick<TimelineAnalysis, 'choices'>): (p: { requests: PartyRequest[] }) => (r: PartyRequest) => string | undefined {
  const w = a.choices.find((c) => c.choice === 'withdraw' && c.ok);
  const withdraw = w ? choiceWindow(tl, w, 'after-withdraw', true) : undefined;
  const rj = a.choices.find((c) => c.choice === 'reject' && c.ok);
  const reject = rj ? choiceWindow(tl, rj, 'after-reject', false) : undefined;
  return (p) => {
    // Active = it sent data before the choice (a script that only loaded has nothing queued to flush).
    const activeBefore = reject !== undefined && p.requests.some((r) => r.dataBearing && r.t < reject.t);
    return (r) => (inChoiceGrace(r, withdraw) ? WITHDRAW_GRACE_PHASE : activeBefore && inChoiceGrace(r, reject) ? REJECT_GRACE_PHASE : undefined);
  };
}
