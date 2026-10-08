// Site workspace → scan (plans/client-consent-design.md §10, ticket C3).
//
// A site workspace is the service's per-site file (service/src/server/workspace.ts;
// the CLI reads the same JSON with --workspace). Its entries are keyed the way
// the report workbench keys its controls:
//
//   class:<workspaceId('tool', [partyId, domain])>                         a tool's classification
//   class:<workspaceId('storage', [partyId, domain, storageKind, name])>   one cookie / storage key
//   task:<data-action-key>                                                 a task; done = value.status 'done'
//   decision:limited-pings                                                 'allow' | 'hold' — site-wide, see siteDecisions
//
// The keys are hashes, so a classification can't be read back into a party on
// its own. Instead the scan computes the keys of everything it observed (a
// first pass over the timelines with the shared knowledge base) and looks those
// up. What matches becomes, for this run only:
//
//   - a recognized tool: a category override of its KB entry;
//   - an unrecognized tool: a site entry with the SAME id ('unknown:<domain>'),
//     placed after every shared entry, so the party keeps its identity (and its
//     workspace keys) and is now recognized with the team's categories;
//   - a cookie / storage key: recorded on the evaluation (`siteWorkspace`) and
//     applied by the report's behavior matrix — a KB entry has one category list
//     per vendor, so a per-cookie classification can't live there.
//
// Nothing here ever reaches the shared KB or its research queue: the CLI feeds
// the queue with the shared KB, so a site's own classification never "resolves"
// a domain for every other site.

import { LIMITED_PINGS_KEY, workspaceId } from './report/workspace.js';
import { tracking } from './rules/index.js';
import { KnowledgeEntry, PartyCategory, type KnowledgeBase } from './registry/kb/index.js';
import type { Timeline, TrackingEvaluation } from './record/index.js';

export const CLASS_PREFIX = 'class:';
export const TASK_PREFIX = 'task:';
/** Consent-denied pings (Google Consent Mode "advanced", Meta LDU) where they need a decision: the
 *  EU/UK, and wiretap states before a choice or after a refusal. One answer for the site, not per cell. */
export { LIMITED_PINGS_KEY };

export interface WorkspaceEntrySnapshot {
  value: unknown;
  at?: string;
  by?: string;
}

/** The parts of a site workspace a scan reads (the service's SiteWorkspace is a superset). */
export interface WorkspaceSnapshot {
  domain?: string;
  entries: Record<string, WorkspaceEntrySnapshot>;
  runs?: Array<{ id: string; at: string; jobId?: string; url?: string; meta?: Record<string, unknown> }>;
  /** The latest generated tool config (service: `config.value.config`, D8); the rescan compares the deployed one with it (D10). */
  config?: { value: unknown; at?: string; by?: string; runId?: string };
}

export type WorkspaceSubject =
  | { kind: 'tool'; partyId: string; domain: string; recognized: boolean }
  | { kind: 'storage'; partyId: string; domain: string; storageKind: string; name: string };

export type SiteWorkspaceRecord = NonNullable<TrackingEvaluation['siteWorkspace']>;
export type SiteClassification = SiteWorkspaceRecord['classifications'][number];

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Validate a workspace file (the service's GET /api/sites/:domain/workspace body). Throws on a bad shape. */
export function parseWorkspaceSnapshot(raw: unknown): WorkspaceSnapshot {
  if (!isObj(raw) || !isObj(raw.entries)) throw new Error('not a site workspace: expected an object with `entries`');
  const entries: Record<string, WorkspaceEntrySnapshot> = Object.create(null);
  for (const [k, e] of Object.entries(raw.entries)) {
    if (!isObj(e) || !('value' in e)) throw new Error(`workspace entry ${JSON.stringify(k.slice(0, 60))} must be { value, at?, by? }`);
    entries[k] = { value: e.value, ...(typeof e.at === 'string' ? { at: e.at } : {}), ...(typeof e.by === 'string' ? { by: e.by } : {}) };
  }
  const runs = Array.isArray(raw.runs) ? (raw.runs as unknown[]).filter((r): r is NonNullable<WorkspaceSnapshot['runs']>[number] => isObj(r) && typeof r.id === 'string' && typeof r.at === 'string') : [];
  // The generated config, kept as the service stores it (value = { config, snippet, changeList, notes }).
  const config: WorkspaceSnapshot['config'] | undefined =
    isObj(raw.config) && 'value' in raw.config
      ? {
          value: raw.config.value,
          ...(typeof raw.config.at === 'string' ? { at: raw.config.at } : {}),
          ...(typeof raw.config.by === 'string' ? { by: raw.config.by } : {}),
          ...(typeof raw.config.runId === 'string' ? { runId: raw.config.runId } : {}),
        }
      : undefined;
  return { ...(typeof raw.domain === 'string' ? { domain: raw.domain } : {}), entries: { ...entries }, runs, ...(config ? { config } : {}) };
}

/** The workspace key of a subject — the report's `data-class-key`, with the class: prefix. */
export function classificationKey(s: WorkspaceSubject): string {
  return CLASS_PREFIX + (s.kind === 'tool' ? workspaceId('tool', [s.partyId, s.domain]) : workspaceId('storage', [s.partyId, s.domain, s.storageKind, s.name]));
}

// The workbench stores a purpose (cookie-purpose.ts: necessary, functional,
// analytics, performance, advertising, other); a KB entry holds PartyCategory.
// 'performance' is the purpose cookiePurposes() gives error monitoring, so it
// round-trips. 'other' has no category: it is not applied (the item stays as
// the scan found it, and the report still asks).
const PURPOSE_TO_CATEGORY: Record<string, PartyCategory> = { performance: 'error-monitoring', advertisement: 'advertising' };

function toCategory(v: unknown): PartyCategory | undefined {
  if (typeof v !== 'string' || !v) return undefined;
  const c = PURPOSE_TO_CATEGORY[v] ?? v;
  return PartyCategory.safeParse(c).success ? (c as PartyCategory) : undefined;
}

/**
 * The categories a classification value chose, or undefined when it chose none
 * usable: cleared (null), a category not confirmed by the person
 * (`categoryChosen: false` — a pre-filled suggestion), or only 'other'.
 * Accepts the workbench's { category, additionalCategories } and a plain { categories }.
 */
export function classificationCategories(value: unknown): PartyCategory[] | undefined {
  if (!isObj(value) || value.categoryChosen === false) return undefined;
  const raw = [value.category, ...(Array.isArray(value.additionalCategories) ? value.additionalCategories : []), ...(Array.isArray(value.categories) ? value.categories : [])];
  const out = [...new Set(raw.map(toCategory).filter((c): c is PartyCategory => Boolean(c)))];
  return out.length ? out : undefined;
}

/** Everything a scan saw that the workbench can classify: each party, and each of its storage keys. */
export function workspaceSubjects(timelines: Timeline[], kb: KnowledgeBase): WorkspaceSubject[] {
  const out = new Map<string, WorkspaceSubject>();
  for (const tl of timelines) {
    const a = tracking.analyzeTimeline(tl, kb);
    for (const p of a.parties.values()) {
      const tool: WorkspaceSubject = { kind: 'tool', partyId: p.partyId, domain: p.domain, recognized: p.recognized };
      out.set(JSON.stringify(['tool', p.partyId]), tool);
      for (const s of p.stores) out.set(JSON.stringify(['storage', p.partyId, s.kind, s.name]), { kind: 'storage', partyId: p.partyId, domain: p.domain, storageKind: s.kind, name: s.name });
    }
  }
  return [...out.values()];
}

/** The workspace classifications that apply to this run's subjects. */
export function resolveSiteClassifications(subjects: WorkspaceSubject[], ws: WorkspaceSnapshot): SiteClassification[] {
  const out: SiteClassification[] = [];
  for (const s of subjects) {
    const key = classificationKey(s);
    const e = ws.entries[key];
    if (!e) continue;
    const categories = classificationCategories(e.value);
    if (!categories) continue;
    out.push({
      key,
      kind: s.kind,
      partyId: s.partyId,
      domain: s.domain,
      ...(s.kind === 'storage' ? { storageKind: s.storageKind, name: s.name } : {}),
      categories,
      ...(e.at ? { at: e.at } : {}),
      ...(e.by ? { by: e.by } : {}),
    });
  }
  return out;
}

/** Tasks the team marked done (value.status === 'done'), keys without the prefix. */
export function doneTasks(ws: WorkspaceSnapshot): SiteWorkspaceRecord['doneTasks'] {
  const out: SiteWorkspaceRecord['doneTasks'] = [];
  for (const [k, e] of Object.entries(ws.entries)) {
    if (!k.startsWith(TASK_PREFIX) || !isObj(e.value) || e.value.status !== 'done') continue;
    out.push({ key: k.slice(TASK_PREFIX.length), ...(e.at ? { at: e.at } : {}), ...(e.by ? { by: e.by } : {}) });
  }
  return out.sort((a, b) => a.key.localeCompare(b.key));
}

/** The site-wide decisions the workspace holds, as the record's `decisions` field (spread: absent when none). */
export function siteDecisions(ws: WorkspaceSnapshot): { decisions?: NonNullable<SiteWorkspaceRecord['decisions']> } {
  const e = ws.entries[LIMITED_PINGS_KEY];
  if (e?.value !== 'allow' && e?.value !== 'hold') return {};
  return { decisions: { limitedPings: { choice: e.value, ...(e.at ? { at: e.at } : {}), ...(e.by ? { by: e.by } : {}) } } };
}

/**
 * The run's knowledge base: the shared one with the site's tool classifications
 * applied. Storage classifications don't change the KB (see the header).
 */
export function siteKnowledgeBase(base: KnowledgeBase, classifications: SiteClassification[]): KnowledgeBase {
  const tools = classifications.filter((c) => c.kind === 'tool');
  if (!tools.length) return base;
  const byId = new Map(tools.map((c) => [c.partyId, c]));
  const entries = base.entries.map((e) => {
    const c = byId.get(e.id);
    if (!c) return e;
    byId.delete(e.id);
    return { ...e, categories: c.categories as PartyCategory[], notes: [e.notes, `site workspace classification${c.by ? ` by ${c.by}` : ''}`].filter(Boolean).join(' ') };
  });
  // Unrecognized parties: a site entry under the party's own id, LAST, so it
  // never shadows a shared entry (a path-specific one on the same host).
  const site: KnowledgeEntry[] = [];
  for (const c of byId.values()) {
    if (!c.partyId.startsWith('unknown:')) continue; // an entry id no longer in the KB: nothing to override
    site.push(
      KnowledgeEntry.parse({
        id: c.partyId,
        vendor: c.domain,
        match: { hosts: [c.domain] },
        categories: c.categories,
        notes: 'Classified for this site in its workspace; not a shared knowledge-base entry.',
        provenance: { proposedBy: 'site-workspace', proposedAt: c.at ?? new Date(0).toISOString(), confirmedBy: `site-workspace${c.by ? `:${c.by}` : ''}`, ...(c.at ? { confirmedAt: c.at } : {}) },
      }),
    );
  }
  return { version: `${base.version}+site.${tools.length}`, entries: [...entries, ...site] };
}

/** Pipeline helper: the run's KB and the record to stamp on its evaluation. */
export function applyWorkspace(timelines: Timeline[], base: KnowledgeBase, ws: WorkspaceSnapshot, at = new Date().toISOString()): { kb: KnowledgeBase; record: SiteWorkspaceRecord } {
  const classifications = resolveSiteClassifications(workspaceSubjects(timelines, base), ws);
  return {
    kb: siteKnowledgeBase(base, classifications),
    record: { ...(ws.domain ? { domain: ws.domain } : {}), appliedAt: at, classifications, doneTasks: doneTasks(ws), ...siteDecisions(ws) },
  };
}
