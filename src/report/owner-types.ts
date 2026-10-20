// The owner report's shape (plans/simple-report.md; judgement fields: plans/report-truth.md Part 2 D1). Its own file so the
// browser-safe judge (owner-judge.ts) and the builder (owner-report.ts) share the types without importing each other.
// Mirrored verbatim in service/src/shared/api.ts. Types only.
import type { RemediationTask } from '../record/index.js';
import type { ComparisonFacts } from './cookie-purpose.js';

export type OwnerCellState = 'pending' | 'ok' | 'mismatch' | 'needs-decision' | 'not-checked' | 'not-applicable' | 'blocked';

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
  /** What the scan observed here (the matrix cell's comparison facts): with a category, all a verdict needs (owner-judge.ts). Absent on cells of a column that is not done. */
  facts?: ComparisonFacts;
  /** The matrix cell's skip, when the scan could not check it or nothing applied. */
  skip?: 'not-applicable' | 'blocked';
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
  /** pending = still to visit; running = being visited now; done; not-checked = the scan could not complete the visit; not-applicable = nothing to test; blocked = the site stopped the visitor, a problem (see note). */
  state: 'pending' | 'running' | 'done' | 'not-checked' | 'not-applicable' | 'blocked';
  /** Why the whole column is skipped — said once, not per cell. */
  note?: string;
}

export interface OwnerCookieRow {
  id: string;
  name: string;
  /** cookie | local | session */
  kind: string;
  purpose: string;
  classified: boolean;
  /** The categories this cookie's own purpose comes from: its known name, and a site classification of it ([] when none). */
  judge: { name: string[]; site: string[] };
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
  /** The tool before any site answer: the base knowledge base's categories for it (`[]` when unknown), and why it counts as a tracker (decided from the base knowledge base, never the site's). */
  judge: { base: string[]; trackerReason?: string };
  cells: OwnerCell[];
  cookies: OwnerCookieRow[];
  /** What the scan saw the tool do: requests only, or storing cookies / storage too. */
  activity: OwnerToolActivity;
  /** What complykit did with the answer your team gave for this tool (absent when none was given). */
  answer?: { categories: string[]; applied: boolean; reason?: string };
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

/** One location of the scan: its verdict, its visits, and the banner its visits saw. */
export interface OwnerLocationSummary {
  id: string;
  label: string;
  verified: boolean;
  observed?: string;
  note?: string;
  visitsDone: number;
  visitsTotal: number;
  banner: { state: 'pending' | 'detected' | 'none'; provider?: string; visitsWithBanner: number; visitsChecked: number };
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
    /**
     * Set on a finished scan when no visit reached the site (blocked, down, refused).
     * The report then carries no tools, decisions or to-do list: there is nothing to
     * judge, and the page says so once instead of per column.
     */
    unreachable?: { reason: string };
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
    /** The consent tool is installed but its script crashed before drawing a banner (record cause 'tool-broken'): the scan's reason, error included. */
    broken?: { reason: string };
  };
  matrix: {
    columns: OwnerColumn[];
    tools: OwnerToolRow[];
    /** Per cell. notChecked = the scan could not; notApplicable = nothing to test; blocked = the site stopped the visitor (a problem). */
    counts: Record<'ok' | 'mismatch' | 'needsDecision' | 'pending' | 'notChecked' | 'notApplicable' | 'blocked', number>;
  };
  /** Tools whose purpose is not known yet: the first to-do items, before the checklist exists. */
  decisions: Array<{ partyId: string; label: string; domain: string; classKey: string }>;
  /** The checklist this run's report carries (the generated config's tasks), when there is one. The service replaces it with the site workspace's, with live status. */
  todo?: { tasks: RemediationTask[]; configAt?: string; runId?: string };
  /** Every location of the scan, in plan order. Absent on reports written before it existed. */
  locations?: OwnerLocationSummary[];
  /** The answers (classKey → category set) this report is judged with: the site's classifications of its tools, all their categories. */
  answers: Record<string, string[]>;
}
