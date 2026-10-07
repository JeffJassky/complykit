import { createHash } from 'node:crypto';
import { z } from 'zod';
import { CompatibilityChangeKind, type MarkupFinding } from './tracking.js';

// The guided remediation flow (plans/remediation-flow.md): one task per change
// the generator lists, plus the install task, each with a stable id, plain
// steps and a verify spec a checker can run against ONE fetched page or
// container (never a full scan).
//
// Stable ids. A change is identified by WHAT it changes, never by WHERE it was
// seen: line numbers move when the owner edits the page, and a page URL can
// gain a query string. So the id is `<kind>:<12 hex>` where the hex is a
// sha-256 prefix over a canonical signature:
//
//   rewrite-tag / remove-leak   the element signature — tag kind, context
//                               (document / <noscript>), host + path of its
//                               URL, the tag ids in it, or for an inline body
//                               the vendor-signature text that matched and the
//                               ids in the body. The party is NOT in it: a
//                               knowledge-base update that recognizes a second
//                               vendor in the same tag must not move the task.
//   gate-gtm-tag                container id + tag id (the number the GTM UI
//                               shows); container + party when no tag id
//   set-consent-default         'google' (one shared item) or api + party
//   use-platform-api            the platform (one shared item) or the party
//   configure-tag-manager       manager + party
//   call-consent-api            party + api
//   change-dns                  the first-party alias host
//   behavior-mismatch, accepted-exposure, needs-a-look, remove-existing-tool
//                               the party
//   classify                    the party (the decision is about the tool)
//   install                     constant: 'install' (the config hash lives in
//                               its verify spec; a regenerated config is the
//                               same task with a new hash to verify)
//
// Workspace key: `task:change:<id>` → RemediationTaskValue.

export const REMEDIATION_TASK_KEY_PREFIX = 'task:change:';
export const INSTALL_TASK_ID = 'install';

// 'confirm-in-browser': one consolidated spot check per party whose folded
// behavior / consent-API items no static task covers (buildRemediationTasks).
// 'classify': a decision, not a change to the site — what an unrecognized tool
// is for. Done when the site workspace holds a classification for it
// (`classKey`); never stored under task:change:<id>.
export const RemediationTaskKind = z.enum(['classify', 'install', 'remove-existing-tool', ...CompatibilityChangeKind.options, 'confirm-in-browser']);
export type RemediationTaskKind = z.infer<typeof RemediationTaskKind>;

/** What identifies one element in served HTML, independent of its line. */
export const ElementSignature = z.object({
  kind: z.enum(['script', 'img', 'iframe', 'link']),
  context: z.enum(['document', 'noscript']),
  /** Lower-case host and pathname of src / href / data-src (external elements). */
  host: z.string().optional(),
  path: z.string().optional(),
  /** Tag / container ids in the URL (gtag/js?id=G-…) or in the inline body (GTM-…, G-…, AW-…). */
  ids: z.array(z.string()).default([]),
  /** Inline (or data: URL) script: the vendor-signature text the knowledge base matched (≤ 80 chars, never the body). */
  inline: z.object({ match: z.string() }).optional(),
  /** The code was a data: URL (a performance plugin's form of an inline snippet). */
  dataUrl: z.boolean().optional(),
});
export type ElementSignature = z.infer<typeof ElementSignature>;

export const RemediationVerifyMethod = z.enum(['static', 'browser', 'manual']);
export type RemediationVerifyMethod = z.infer<typeof RemediationVerifyMethod>;

// One spec per check. `method` says what runs it: 'static' = fetch one page (or
// one container file) and run the pure checker; 'browser' = one page, one
// vendor, reject then accept, judged by judgeSpotCheck; 'manual' = nothing can
// be checked from outside, the owner records it.
export const RemediationVerifySpec = z.discriminatedUnion('check', [
  z.object({
    check: z.literal('install'),
    method: z.literal('static'),
    page: z.string(),
    /** sha-256 of the latest generated config: the deployed one must equal it. */
    configHash: z.string(),
    scriptSrc: z.string(),
    elementId: z.string(),
  }),
  z.object({ check: z.literal('rewrite-tag'), method: z.literal('static'), page: z.string(), element: ElementSignature, category: z.string() }),
  z.object({ check: z.literal('remove-leak'), method: z.literal('static'), page: z.string(), element: ElementSignature }),
  z.object({
    check: z.literal('gtm-tag-consent'),
    method: z.literal('static'),
    containerId: z.string(),
    /** The container file to fetch (gtm.js?id=…). */
    containerUrl: z.string().optional(),
    tagId: z.number().int(),
    consentTypes: z.array(z.string()),
  }),
  z.object({ check: z.literal('consent-default'), method: z.literal('static'), page: z.string(), consentTypes: z.array(z.string()) }),
  z.object({
    check: z.literal('remove-existing-tool'),
    method: z.literal('static'),
    page: z.string(),
    partyId: z.string().optional(),
    /** Hosts the tool loads from (an outside consent tool). */
    hosts: z.array(z.string()).default([]),
    /** Regex source over asset URLs (a platform plugin served from the site's own domain). */
    pathPattern: z.string().optional(),
    label: z.string(),
  }),
  z.object({
    check: z.literal('spot-check'),
    method: z.literal('browser'),
    page: z.string(),
    partyId: z.string(),
    /** Hosts the vendor was seen on: a request to any of them in the reject phase fails the check. */
    hosts: z.array(z.string()),
    scenario: z.literal('reject-then-accept'),
  }),
  z.object({ check: z.literal('manual'), method: z.literal('manual'), reason: z.string() }),
]);
export type RemediationVerifySpec = z.infer<typeof RemediationVerifySpec>;

export const VerifyResult = z.enum(['pass', 'fail', 'cannot-verify']);
export type VerifyResult = z.infer<typeof VerifyResult>;

/** What a checker returns. `evidence`: the lines / URLs / hashes the result rests on, for the owner. */
export const VerifyOutcome = z.object({ result: VerifyResult, message: z.string(), evidence: z.array(z.string()).default([]) });
export type VerifyOutcome = z.infer<typeof VerifyOutcome>;

export const RemediationStatus = z.enum(['todo', 'done-unverified', 'verified', 'failed', 'cannot-verify']);
export type RemediationStatus = z.infer<typeof RemediationStatus>;

export const RemediationLastVerify = VerifyOutcome.extend({ at: z.string() });
export type RemediationLastVerify = z.infer<typeof RemediationLastVerify>;

/** The workspace entry value under `task:change:<id>`. */
export const RemediationTaskValue = z.object({
  status: RemediationStatus,
  note: z.string().optional(),
  lastVerify: RemediationLastVerify.optional(),
});
export type RemediationTaskValue = z.infer<typeof RemediationTaskValue>;

export const RemediationTask = z.object({
  id: z.string(),
  kind: RemediationTaskKind,
  /** The change-list group it came from ('install' for the install task). */
  group: z.string(),
  title: z.string(),
  /** One line: what to do. */
  summary: z.string(),
  /** The party the change is for (first of partyIds), when it is party-scoped. */
  party: z.string().optional(),
  tools: z.array(z.string()),
  partyIds: z.array(z.string()),
  /** Plain-language steps, in order (surface-neutral; see stepVariants). */
  steps: z.array(z.string()),
  /** Steps whose wording depends on where the checklist is shown: `service` (the complykit service: its buttons) or `offline` (a report file / the CLI: its commands and folders). Each replaces steps[step] on that surface; steps[step] stays the neutral text for anything else. */
  stepVariants: z.array(z.object({ step: z.number().int().nonnegative(), service: z.string(), offline: z.string() })).optional(),
  snippet: z.object({ before: z.string().optional(), after: z.string().optional() }).optional(),
  /** Pages the change applies to (the page it was seen on, then the others with the same tag). */
  pages: z.array(z.string()),
  verify: RemediationVerifySpec,
  status: RemediationStatus,
  lastVerify: RemediationLastVerify.optional(),
  /** A context-purpose tool (chat, embeds, fonts…): applies only where it is not strictly needed. */
  optional: z.boolean(),
  /** Every tool on it is unclassified: applies only if it tracks visitors (see waitingOn for the decision it waits on). */
  classifyFirst: z.boolean().optional(),
  /** A 'classify' task: the workspace key (`class:<id>`, the report's data-class-key with the prefix) whose classification decides it. */
  classKey: z.string().optional(),
  /** The 'classify' tasks this change waits on: it applies only once they are decided (and only if the tool tracks visitors). */
  waitingOn: z.array(z.string()).optional(),
  notes: z.array(z.string()).default([]),
  guide: z.object({ label: z.string(), href: z.string() }).optional(),
  /** Change-list items folded into this task (a behavior mismatch, a consent-API call, an exposure the change removes): their ids, so a status stored under one of them is still found (resolveRemediationTaskValue). */
  aliases: z.array(z.string()).optional(),
  /** One plain line per folded item: "This also fixes: …". */
  alsoFixes: z.array(z.string()).optional(),
  /** Position in the checklist (install is 0). */
  order: z.number().int(),
});
export type RemediationTask = z.infer<typeof RemediationTask>;

/** What a browser spot check observed on one page: reject phase, then accept phase. */
export const SpotCheckObservation = z.object({
  page: z.string(),
  /** complykit's tool was present on the page (its global or config element). */
  toolPresent: z.boolean().optional(),
  phases: z.array(
    z.object({
      scenario: z.enum(['reject', 'accept']),
      /** The choice was made (the banner was found and the button clicked / the API called). */
      choiceMade: z.boolean(),
      requests: z.array(z.object({ url: z.string() })),
      stores: z.array(z.object({ kind: z.string(), name: z.string(), host: z.string().optional() })).default([]),
    }),
  ),
});
export type SpotCheckObservation = z.infer<typeof SpotCheckObservation>;

// --- ids ---------------------------------------------------------------------------

// Case-insensitive: a query string may carry the id in either case; the signature keeps it upper-case.
const ID_IN_URL_RE = /\b(GTM-[A-Z0-9]{4,10}|GT-[A-Z0-9]{6,12}|G-(?=[A-Z0-9]*\d)[A-Z0-9]{6,12}|AW-\d{6,12}|DC-\d{5,12}|UA-\d{4,10}-\d{1,4})\b/gi;

function hostPath(url: string | undefined): { host?: string; path?: string; ids: string[] } {
  if (!url) return { ids: [] };
  try {
    const u = new URL(url);
    const ids = [...new Set([...u.search.matchAll(ID_IN_URL_RE)].map((m) => m[1].toUpperCase()))].sort();
    return { host: u.hostname.toLowerCase(), path: u.pathname.replace(/\/+$/, '') || '/', ids };
  } catch {
    return { ids: [] };
  }
}

/** The signature of a markup finding's element (the vendor-signature-bearing part only). */
export function elementSignatureOf(f: Pick<MarkupFinding, 'kind' | 'context' | 'url' | 'inline' | 'match' | 'ids' | 'dataUrl' | 'matchedBy'>): ElementSignature {
  const base = { kind: f.kind, context: f.context };
  if (!f.inline && f.url) {
    const { host, path, ids } = hostPath(f.url);
    return { ...base, ...(host ? { host } : {}), ...(path ? { path } : {}), ids };
  }
  const match = f.match.replace(/…$/, '');
  return {
    ...base,
    ids: [...new Set((f.ids ?? []).map((x) => x.toUpperCase()))].sort(),
    inline: { match },
    ...(f.dataUrl ? { dataUrl: true } : {}),
  };
}

export interface ChangeIdInput {
  kind: RemediationTaskKind;
  partyId?: string;
  signature?: ElementSignature;
  url?: string;
  containerId?: string;
  tagId?: number;
  api?: string;
  platform?: string;
  manager?: string;
  host?: string;
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (typeof value === 'object' && value !== null) {
    const o = value as Record<string, unknown>;
    return `{${Object.keys(o)
      .sort()
      .filter((k) => o[k] !== undefined)
      .map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

/** The canonical signature object an id hashes (exported for tests and the plan). */
export function changeSignature(c: ChangeIdInput): Record<string, unknown> {
  switch (c.kind) {
    case 'install':
      return { kind: c.kind };
    case 'rewrite-tag':
    case 'remove-leak':
      return c.signature ? { kind: c.kind, element: c.signature } : { kind: c.kind, partyId: c.partyId, url: c.url ? hostPath(c.url) : undefined };
    case 'gate-gtm-tag':
      return c.tagId !== undefined ? { kind: c.kind, containerId: c.containerId, tagId: c.tagId } : { kind: c.kind, containerId: c.containerId, partyId: c.partyId };
    case 'set-consent-default':
      return c.api && c.api !== 'google' ? { kind: c.kind, api: c.api, partyId: c.partyId } : { kind: c.kind, api: 'google' };
    case 'use-platform-api':
      return c.platform ? { kind: c.kind, platform: c.platform } : { kind: c.kind, partyId: c.partyId };
    case 'configure-tag-manager':
      return { kind: c.kind, manager: c.manager ?? '', partyId: c.partyId };
    case 'call-consent-api':
      return { kind: c.kind, partyId: c.partyId, api: c.api ?? '' };
    case 'change-dns':
      return { kind: c.kind, host: (c.host ?? c.partyId ?? '').toLowerCase() };
    default:
      return { kind: c.kind, partyId: c.partyId };
  }
}

/** `<kind>:<12 hex>` — see the header. 'install' for the install task. */
export function changeId(c: ChangeIdInput): string {
  if (c.kind === 'install') return INSTALL_TASK_ID;
  const hex = createHash('sha256').update(canonical(changeSignature(c)), 'utf8').digest('hex').slice(0, 12);
  return `${c.kind}:${hex}`;
}

/** The workspace key of a remediation task. */
export function remediationTaskKey(id: string): string {
  return REMEDIATION_TASK_KEY_PREFIX + id;
}

/** Read a workspace entry value as a task value; undefined when it is not one (or carries no status). */
export function readRemediationTaskValue(value: unknown): RemediationTaskValue | undefined {
  // The report workbench's own vocabulary (open / in-progress / done) is read
  // too: 'done' marked there is done-unverified here, never verified.
  const LEGACY: Record<string, RemediationStatus> = { open: 'todo', 'in-progress': 'todo', done: 'done-unverified' };
  const v = typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
  const mapped = v && typeof v.status === 'string' && LEGACY[v.status] ? { ...v, status: LEGACY[v.status] } : value;
  const r = RemediationTaskValue.safeParse(mapped);
  return r.success ? r.data : undefined;
}

/**
 * A task's workspace value: its own `task:change:<id>` entry, else the first
 * entry stored under one of its aliases (an item folded into it — the status
 * an owner set before the fold is not lost). A folded item's check was a
 * browser spot check: carried onto a task whose own check is different, a
 * `verified` reads as `done-unverified` (the owner did the work; this task's
 * own check has not run), never as a pass.
 */
export function resolveRemediationTaskValue(task: { id: string; aliases?: string[]; verify: { check: string }; classKey?: string }, entries: Record<string, { value: unknown } | undefined>): RemediationTaskValue | undefined {
  // A decision: its status is whether the workspace holds the classification — nothing else.
  if (task.classKey) return { status: classificationDecided(entries[task.classKey]?.value) ? 'verified' : 'todo' };
  const own = entries[remediationTaskKey(task.id)];
  if (own) return readRemediationTaskValue(own.value) ?? { status: 'todo' };
  for (const a of task.aliases ?? []) {
    const v = readRemediationTaskValue(entries[remediationTaskKey(a)]?.value);
    if (!v) continue;
    return v.status === 'verified' && task.verify.check !== 'spot-check' ? { ...v, status: 'done-unverified' } : v;
  }
  return undefined;
}

/**
 * A classification value that decides a 'classify' task: a purpose the person
 * chose (not a pre-filled suggestion: `categoryChosen: false`), other than
 * "Other" — the purposes the scan can apply (site-workspace.ts
 * classificationCategories). Accepts the workbench's { category,
 * additionalCategories } and a plain { categories }. The service and the
 * report script carry the same rule.
 */
export function classificationDecided(value: unknown): boolean {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  if (v.categoryChosen === false) return false;
  const all = [v.category, ...(Array.isArray(v.additionalCategories) ? v.additionalCategories : []), ...(Array.isArray(v.categories) ? v.categories : [])];
  return all.some((c) => typeof c === 'string' && c !== '' && c !== 'other' && c !== 'unknown');
}

/** Done for the checklist's purposes: verified, or marked done by the owner (verification pending or impossible). */
export function isRemediationDone(status: RemediationStatus): boolean {
  return status === 'verified' || status === 'done-unverified';
}
