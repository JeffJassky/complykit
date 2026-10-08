import { DEFAULT_LAWS, LAWS, isLawId, type LawId } from '../../shared/laws';
import type { JobSummary, OwnerReport } from '../../shared/api';

// The law checkboxes' logic (plans/multi-region-scans.md "The law checkboxes"):
// the remembered selection, the order sent to the server, why a scan can't be
// submitted yet, and the per-law progress rows. Pure, so it is testable without a DOM.

export const LAWS_STORAGE_KEY = 'complykit.laws';

/** The last selection (localStorage), or every law. Never throws; unknown ids are dropped. */
export function readStoredLaws(): LawId[] {
  try {
    const raw = window.localStorage.getItem(LAWS_STORAGE_KEY);
    if (raw) {
      const parsed: unknown = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        const ids = orderLaws(parsed.filter(isLawId));
        if (ids.length) return ids;
      }
    }
  } catch {
    // storage blocked or the value is junk: use the default
  }
  return [...DEFAULT_LAWS];
}

export function writeStoredLaws(ids: readonly LawId[]): void {
  try {
    window.localStorage.setItem(LAWS_STORAGE_KEY, JSON.stringify(ids));
  } catch {
    // remembering is a convenience
  }
}

/** The ids in catalog order, once each. */
export function orderLaws(ids: readonly LawId[]): LawId[] {
  return LAWS.filter((l) => ids.includes(l.id)).map((l) => l.id);
}

/** Add or remove one law, keeping catalog order. */
export function toggleLaw(ids: readonly LawId[], id: LawId, on: boolean): LawId[] {
  return orderLaws(on ? [...ids, id] : ids.filter((x) => x !== id));
}

export const lawLabel = (id: LawId): string => LAWS.find((l) => l.id === id)?.label ?? id;

/** Why a scan can't start yet, or null. Only a consent scan needs laws and the authorization. */
export function scanBlockedReason(s: { consent: boolean; accessibility: boolean; laws: readonly LawId[]; authorized: boolean }): string | null {
  if (!s.consent && !s.accessibility) return 'Choose at least one check.';
  if (!s.consent) return null;
  if (!s.laws.length) return 'Choose at least one law to scan under.';
  if (!s.authorized) return 'Confirm you are authorized to scan this site.';
  return null;
}

export interface ScanFormState {
  url: string;
  consent: boolean;
  accessibility: boolean;
  quick: boolean;
  slowRepeat: boolean;
  laws: readonly LawId[];
  authorized: boolean;
}

export interface ScanRequest {
  url: string;
  consent: boolean;
  accessibility: boolean;
  quick: boolean;
  slowRepeat: boolean;
  /** Consent on only: in catalog order. */
  laws?: LawId[];
  /** Consent on only: always true when present. */
  authorized?: true;
}

export function scanRequestOf(s: ScanFormState): ScanRequest {
  return {
    url: s.url,
    consent: s.consent,
    accessibility: s.accessibility,
    quick: s.quick,
    slowRepeat: s.consent && !s.quick && s.slowRepeat,
    ...(s.consent ? { laws: orderLaws(s.laws), authorized: true as const } : {}),
  };
}

export interface LawRow {
  id: LawId;
  label: string;
  state: 'waiting' | 'scanning' | 'done';
  text: string;
}

/** One row per law the job scans under, with live state from the owner report's matrix columns (one per location and scenario). Missing data reads as waiting. */
export function lawRows(job: Pick<JobSummary, 'laws'>, report: OwnerReport | null | undefined): LawRow[] {
  const laws = job.laws ?? [];
  const columns = report?.matrix?.columns ?? [];
  return laws.filter(isLawId).map((id) => {
    const law = LAWS.find((l) => l.id === id)!;
    const cols = columns.filter((c) => c.location === law.locationId);
    const finished = cols.filter((c) => c.state === 'done' || c.state === 'not-checked').length;
    if (!cols.length) return { id, label: law.label, state: 'waiting', text: 'Waiting' };
    if (finished === cols.length) return { id, label: law.label, state: 'done', text: 'Done' };
    if (cols.some((c) => c.state === 'running') || finished > 0) return { id, label: law.label, state: 'scanning', text: `Scanning (${finished} of ${cols.length})` };
    return { id, label: law.label, state: 'waiting', text: 'Waiting' };
  });
}
