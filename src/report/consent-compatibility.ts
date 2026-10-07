import type {
  CompatibilityChange,
  CompatibilityChangeKind,
  CompatibilityReason,
  CompatibilitySection,
  CompatibilityVerdict,
  ConsentToolDefaultFinding,
  ElementSignature,
  ImplementationClass,
  MarkupFinding,
  PartyCompatibility,
  TrackingEvaluation,
} from '../record/index.js';
import { changeId, elementSignatureOf, type ChangeIdInput } from '../record/index.js';
import { escapeHtml as esc, safeHref } from './human.js';
import { cookiePurposes } from './cookie-purpose.js';
import type { BehaviorMatrix } from '../../types/index.js';

// The compatibility section and the owner's change list (ticket B2; plans/
// client-consent-design.md §1, §4, §5). Input: the record's compatibility
// section (B1, re-decided against the report matrix by src/consent-
// compatibility.ts). Output: a JSON view (on the consent report model), an
// HTML section, a Markdown section, and the standalone change-list.md a
// developer can act on without reading anything else.
//
// Wording, enforced by tests:
//   - never "compliant"; never "gated" for a tool the evidence did not prove
//     held back (B1 proves it for a GTM tag only: a 'required' consent setting
//     AND an observed denied Consent Mode default). A gateable tool is one the
//     consent tool CAN hold back once its tag is rewritten — not one it does.
//   - behavior outranks implementation (§9.1): a tool observed running where
//     it should be off is listed first, in the table and in the change list.
//   - every count carries what the scan covered (pages, locations, logged out).
//
// Purpose comes from B1's `purpose` scope (the matrix's groups): 'not-required'
// tools (necessary / CDN / captcha / payments / the consent tool) get no row
// and no change, only a collapsed "not counted" line; 'context' tools (chat,
// embeds, fonts…) keep their changes in a separate, uncounted group;
// 'unclassified' tools are listed with "classify first".
//
// The "outside your consent tool's reach" line (§1) counts a tool when BOTH:
//   1. its purpose needs consent (B1 'needs-consent', or a tag manager — it
//      loads others) or is not classified yet (fail closed); AND
//   2. its verdict leaves it out of the consent tool's hands:
//        uncontrollable — a markup leak, a CNAME cookie, server-side forwarding;
//        unknown        — the loader was not identified;
//        tag-manager    — unless every container tag that loads it was proven
//                         held back (no gate-gtm-tag / set-consent-default /
//                         configure-tag-manager change left, and no behavior
//                         mismatch). Another tag manager is never proven.
// Not counted: gateable (in reach once the tag is rewritten) and platform
// (controlled through the platform's consent API, which the tool's platform
// bridge writes; the row carries B1's caveat that it does not reach
// server-side forwarding).
//
// The behavior column comes from the report matrix (it wins over the record's
// flags): a cell that expected the tool OFF and saw nothing is "nothing
// observed where it should be off"; cells that only expected "may run" say so
// — never presented as verified.

export const DOCS_BASE = 'https://jeffjassky.github.io/complykit/guide/';
export const GTM_GUIDE = `${DOCS_BASE}gtm-setup`;
const PLATFORM_GUIDES: Record<string, string> = { shopify: 'platform-shopify', wix: 'platform-wix', wordpress: 'platform-wordpress' };
export function platformGuide(name: string | undefined): string | undefined {
  return name && PLATFORM_GUIDES[name] ? DOCS_BASE + PLATFORM_GUIDES[name] : undefined;
}
const VENDOR_GUIDE = `${DOCS_BASE}vendor-control`;
const CONFIG_GUIDE = `${DOCS_BASE}config`;

/** The file the CLI writes beside the HTML report. */
export const CHANGE_LIST_FILE = 'change-list.md';

export const VERDICT_LABEL: Record<CompatibilityVerdict, string> = {
  gateable: 'Yes, once its tag is rewritten',
  'tag-manager': 'Only through the tag manager',
  platform: 'Only through the platform’s consent setting',
  uncontrollable: 'No — no consent tool can control it',
  unknown: 'Unknown — its loader was not identified',
};

export const IMPLEMENTATION_LABEL: Record<ImplementationClass, string> = {
  'direct-script': 'Script tag in the page HTML',
  'markup-leak': 'Image, iframe or <noscript> element in the HTML',
  gtm: 'Google Tag Manager',
  'other-tag-manager': 'Another tag manager',
  platform: 'Injected by the platform',
  cname: 'First-party subdomain (DNS alias)',
  'server-side-suspected': 'Server-side forwarding (suspected)',
  unknown: 'Not traced',
};

const CONSENT_PURPOSE = new Set(['analytics', 'performance', 'advertising', 'advertisement', 'session-recording', 'identity-resolution', 'fingerprinting', 'marketing-email', 'tag-manager']);

/** Does this tool's purpose need a consent decision? 'context' = normally not (fonts, CDN, captcha, chat…). */
export type PurposeNeed = 'consent' | 'unclassified' | 'context';
/**
 * From B1's purpose scope when the record has it (the matrix's groups), else
 * from the categories. A tag manager counts as needing consent: it loads others.
 */
export function purposeNeed(categories: readonly string[], scope?: PartyCompatibility['purpose']): PurposeNeed {
  if (categories.includes('tag-manager')) return 'consent';
  if (scope) return scope === 'needs-consent' ? 'consent' : scope === 'unclassified' ? 'unclassified' : 'context';
  if (!categories.length || categories.includes('unknown') || categories.includes('other')) return 'unclassified';
  return categories.some((c) => CONSENT_PURPOSE.has(c)) ? 'consent' : 'context';
}

/** The data-category for a rewritten tag: the strictest purpose the tool has (a category id of the consent tool config). */
export function gateCategory(categories: readonly string[]): { id: string; note?: string } {
  if (purposeNeed(categories) === 'unclassified') return { id: 'advertising', note: 'not classified yet: held under the strictest category until your team classifies it' };
  const purposes = cookiePurposes([...categories]);
  for (const id of ['advertising', 'analytics', 'performance', 'functional']) if (purposes.includes(id)) return { id };
  return { id: 'advertising', note: 'no consent category matches its purpose: held under the strictest category' };
}

// mismatch             — ran where it should be off (the matrix wins over B1's cells)
// no-mismatch-observed — compared in at least one visit where it should be OFF, nothing seen
// only-may-run         — compared only where it may run anyway: says nothing about holding it back
// not-established      — no visit could be compared
export type BehaviorState = 'mismatch' | 'no-mismatch-observed' | 'only-may-run' | 'not-established';

export interface CompatibilityRow {
  partyId: string;
  label: string;
  categories: string[];
  purpose: PurposeNeed;
  verdict: CompatibilityVerdict;
  verdictLabel: string;
  implementation: ImplementationClass;
  implementationLabel: string;
  /** Where it loads from, in one line: the container id, the script URL, the element at page:line. */
  loader: string;
  behavior: BehaviorState;
  behaviorNote: string;
  /** Counted in the "outside your consent tool's reach" line. */
  outsideReach: boolean;
  reachReason?: string;
  /** B1's purpose scope, when the record has it. */
  purposeScope?: NonNullable<PartyCompatibility['purpose']>;
  /** Tag-manager tools whose every container tag was proven held back by its consent setting. */
  provenHeld: boolean;
  /** What the verdict does not cover (a platform setting reaches only what it injects in the browser). */
  caveats?: string[];
  /** What to change, in one line (the change list has the detail). */
  whatToChange: string;
  changes: CompatibilityChange[];
  reasons: CompatibilityReason[];
}

export interface ChangeItem {
  /** Stable id (record/remediation.ts changeId): what the change touches, never where it was seen. Workspace key `task:change:<id>`. */
  id: string;
  kind: CompatibilityChangeKind;
  /** rewrite-tag / remove-leak: the element the id was computed from (what verifyRewriteTag / verifyRemoveLeak look for). */
  signature?: ElementSignature;
  tools: string[];
  partyIds: string[];
  note: string;
  page?: string;
  line?: number;
  element?: string;
  url?: string;
  containerId?: string;
  tagId?: number;
  /** For a GTM tag: the template label and why its current setting does not hold it. */
  tagNote?: string;
  consentTypes?: string[];
  api?: string;
  platform?: string;
  manager?: string;
  host?: string;
  target?: string;
  /** rewrite-tag: the consent-tool category id for data-category. */
  category?: string;
  categoryNote?: string;
  /** Ready-to-paste snippets (rewrite-tag; set-consent-default for Google). */
  before?: string;
  after?: string;
  /** A pointer the developer can follow (a located tag for an unlocated tool). */
  hint?: string;
  /** Why the change is needed / what to watch for (a data: URL tag, a performance plugin's delay, a destination GTM loads from the page). */
  notes?: string[];
  /** Every tool on this item is unclassified: the change applies only if it tracks visitors. */
  classifyFirst?: boolean;
  guide?: { label: string; href: string };
}

export interface ChangeGroup {
  id: 'mismatch' | 'rewrite' | 'gtm' | 'consent-default' | 'tag-manager' | 'platform' | 'consent-api' | 'leaks' | 'dns' | 'exposures' | 'needs-a-look';
  title: string;
  intro: string;
  items: ChangeItem[];
  guide?: { label: string; href: string };
}

export interface CompatibilityReport {
  /** What the scan covered, stated with every count. */
  scope: string;
  reach: {
    count: number;
    /** Exactly: "N tools are loaded outside your consent tool's reach: …" */
    line: string;
    tools: Array<{ partyId: string; label: string; verdict: CompatibilityVerdict; reason: string }>;
    definition: string;
  };
  consentTool: ConsentToolDefaultFinding & { headline: string; tone: 'red' | 'amber' | 'grey' };
  rows: CompatibilityRow[];
  /** The change list for tools that need a consent decision (or are unclassified). Behavior mismatches first. */
  groups: ChangeGroup[];
  /** Changes for context-purpose tools (chat, embeds, fonts…): they apply only where the tool is not strictly needed. Not counted. */
  otherChanges: ChangeItem[];
  /** Tools whose purpose needs no consent (necessary, CDN, captcha, payments, the consent tool): no row, no change, not counted. */
  notRequired: Array<{ partyId: string; label: string; categories: string[]; verdict: CompatibilityVerdict }>;
  inputs: CompatibilitySection['inputs'];
  /** Inputs the verdicts did not have, in plain words (each one weakens verdicts, never strengthens them). */
  missingInputs: string[];
}

// --- Building the view ---------------------------------------------------------

export interface CompatibilityContext {
  inventory: TrackingEvaluation['inventory'];
  markup?: TrackingEvaluation['markup'];
  locations: Array<{ id: string; label: string; verdict: string }>;
  /** Most visits per scenario (1, or 2 with the throttled pass). */
  runs?: number;
  /** The report's behavior matrix: its tool rows decide the behavior column (and win over the record's flags). */
  matrix?: BehaviorMatrix;
}

const attrEsc = (v: string): string => v.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
const attrs = (pairs: Array<[string, string]>): string => pairs.map(([k, v]) => (v === '' ? ` ${k}` : ` ${k}="${attrEsc(v)}"`)).join('');

/** Attributes a performance plugin adds to a script it delays: dropped from the rewritten tag. */
const OPTIMIZER_ATTR = /^data-(rocket|litespeed|perfmatters|pm)-/;

type RewriteFinding = Pick<MarkupFinding, 'attributes' | 'inline' | 'url' | 'match'> & Partial<Pick<MarkupFinding, 'dataUrl' | 'optimizer'>>;

/**
 * Before / after for one tag rewrite, consistent with the client gate
 * (client/src/gate.ts copies data-src to src on a fresh element — a data: URL
 * included). A data: URL tag keeps its URL, moved to data-src (the record holds
 * only its "data:<type>,…" stub, so "…" stands for the existing value); a tag a
 * performance plugin delays loses the plugin's own type and attributes.
 */
export function rewriteSnippet(f: RewriteFinding | undefined, url: string | undefined, category: string): { before: string; after: string } {
  const a: Array<[string, string]> = Object.entries(f?.attributes ?? (url ? { src: url } : {}));
  const has = (k: string): boolean => a.some(([x]) => x === k);
  const srcKey = f?.dataUrl?.attribute ?? (has('src') ? 'src' : f?.optimizer && has('data-rocket-src') ? 'data-rocket-src' : f?.optimizer && has('data-src') ? 'data-src' : 'src');
  const src = a.find(([k]) => k === srcKey)?.[1] ?? (f?.inline ? undefined : url);
  const keep = a.filter(([k]) => k !== 'src' && k !== 'type' && k !== srcKey && !(f?.optimizer && OPTIMIZER_ATTR.test(k)));
  if ((f?.inline && !f.dataUrl) || !src) {
    const code = `…your existing code${f?.match ? ` (contains “${f.match}”)` : ''}…`;
    return {
      before: `<script${attrs(a)}>${code}</script>`,
      after: `<script${attrs([['type', 'text/plain'], ['data-category', category], ...keep])}>${code.replace('your existing code', 'the same code, unchanged')}</script>`,
    };
  }
  return {
    before: `<script${attrs(a)}></script>`,
    after: `<script${attrs([['type', 'text/plain'], ['data-category', category], ['data-src', src], ...keep])}></script>`,
  };
}

/** What the developer must know about a rewrite beyond its snippets (pure; exported for the generator's tests). */
export function rewriteNotes(f: Partial<Pick<MarkupFinding, 'dataUrl' | 'optimizer'>> | undefined, category: string): string[] {
  const out: string[] = [];
  if (f?.dataUrl) {
    out.push(
      `Its code is a ${f.dataUrl.encoding === 'base64' ? 'base64' : 'percent-encoded'} data: URL in ${f.dataUrl.attribute} (data:${f.dataUrl.mediaType || ''}…): in the snippet, “…” stands for the existing value — move it unchanged to data-src. A performance plugin’s “delay / defer inline JavaScript” option usually writes this form from an inline snippet: make the change in the source snippet (type="text/plain" data-category="${category}") or exclude it from that option, then check the served HTML — the tag must arrive held.`,
    );
  }
  if (f?.optimizer) {
    out.push(
      `${f.optimizer} delays this script and runs it itself for every visitor (on the first interaction, or after load): that delay is not consent gating. Exclude it from the plugin’s delay list and make the change in the source tag (theme or plugin setting), then check the served HTML: it must arrive as type="text/plain" data-category="${category}".`,
    );
  }
  return out;
}

/** The Google tag id a gtag.js loader URL names (gtag/js?id=G-…), uppercased. Same pattern as rules/tracking/implementation.ts googleTagIdOf. */
const gtagIdOf = (u: string | undefined): string | undefined => (u ? /\/gtag\/js\?(?:[^#]*&)?id=((?:G|AW|GT|DC)-[A-Z0-9]+)/i.exec(u)?.[1]?.toUpperCase() : undefined);

function consentDefaultSnippet(types: string[]): string {
  return [
    '<script>',
    '  window.dataLayer = window.dataLayer || [];',
    '  function gtag(){dataLayer.push(arguments);}',
    `  gtag('consent', 'default', { ${types.map((t) => `${t}: 'denied'`).join(', ')} });`,
    '</script>',
    '<!-- the Google Tag Manager / gtag.js snippet goes AFTER this -->',
  ].join('\n');
}

const pageLine = (page: string | undefined, line: number | undefined): string => (page ? `${shortPage(page)}${line ? `:${line}` : ''}` : '');
export function shortPage(page: string): string {
  try {
    const u = new URL(page);
    return `${u.pathname}${u.search}` || '/';
  } catch {
    return page;
  }
}

function loaderOf(p: TrackingEvaluation['inventory'][number] | undefined, c: PartyCompatibility): string {
  const ev = p?.implementation?.evidence ?? [];
  const first = ev.find((e) => e.class === c.implementation) ?? ev[0];
  switch (c.implementation) {
    case 'gtm': {
      const ids = [...new Set(ev.map((e) => e.containerId ?? /[?&]id=(GTM-[A-Z0-9]+)/i.exec(e.url ?? '')?.[1]).filter((x): x is string => !!x))];
      return ids.length ? ids.join(', ') : first?.url ?? 'a GTM container';
    }
    case 'cname':
      return first?.host ? `${first.host} → ${first.target ?? '?'}` : first?.note ?? '';
    case 'markup-leak':
    case 'direct-script': {
      const where = first?.page ? pageLine(first.page, first.line) : '';
      return [first?.url, where && `at ${where}`].filter(Boolean).join(' ') || first?.note || p?.loadedBy[0] || '';
    }
    default:
      return first?.url ?? p?.loadedBy[0] ?? first?.note ?? 'not traced';
  }
}

const KIND_SHORT: Record<CompatibilityChangeKind, (n: number) => string> = {
  'behavior-mismatch': () => 'it ran where it should be off: fix, then rescan',
  'rewrite-tag': (n) => `rewrite ${n} tag${n === 1 ? '' : 's'} to type="text/plain"`,
  'remove-leak': (n) => `remove ${n} element${n === 1 ? '' : 's'} from the HTML`,
  'gate-gtm-tag': (n) => `require consent on ${n} GTM tag${n === 1 ? '' : 's'}`,
  'set-consent-default': () => 'set a denied consent default before it loads',
  'configure-tag-manager': () => 'require consent inside its tag manager',
  'use-platform-api': () => 'use the platform’s consent setting',
  'call-consent-api': () => 'call its consent API alongside the block',
  'change-dns': () => 'repoint the DNS alias, or accept the exposure in writing',
  'accepted-exposure': () => 'accept the exposure in writing, or remove the integration',
  'needs-a-look': () => 'needs a look: the loader was not found',
};
const KIND_ORDER: CompatibilityChangeKind[] = ['behavior-mismatch', 'remove-leak', 'rewrite-tag', 'gate-gtm-tag', 'set-consent-default', 'configure-tag-manager', 'use-platform-api', 'call-consent-api', 'change-dns', 'accepted-exposure', 'needs-a-look'];

function summarizeChanges(changes: CompatibilityChange[], provenHeld: boolean): string {
  if (provenHeld && !changes.some((c) => c.kind !== 'call-consent-api')) return 'Nothing in the container: keep its consent setting and the denied default (both observed)';
  const counts = new Map<CompatibilityChangeKind, number>();
  for (const c of changes) counts.set(c.kind, (counts.get(c.kind) ?? 0) + 1);
  const parts = KIND_ORDER.filter((k) => counts.has(k)).map((k) => KIND_SHORT[k](counts.get(k)!));
  const s = parts.join('; ');
  return s ? s[0].toUpperCase() + s.slice(1) : 'No change listed';
}

const MISMATCH_RE = /^([^:]+:[^:#]+)(?:#\d+)?: /;

function behaviorOf(c: PartyCompatibility, labelOf: (id: string) => string, matrix: BehaviorMatrix | undefined): { state: BehaviorState; note: string } {
  const row = matrix?.rows.find((r) => r.kind === 'tool' && r.partyId === c.partyId);
  const cells = row ? row.cells.map((cell, i) => ({ cell, col: matrix!.columns[i] })) : [];
  const name = (x: (typeof cells)[number]): string => `${labelOf(x.col.location)} · ${x.col.label}`;
  const mism = cells.filter((x) => x.cell.status === 'mismatch');
  if (mism.length) return { state: 'mismatch', note: `Ran where it should be off (${mism.map(name).join(', ')})` };
  if (c.behaviorMismatch) {
    const where = [...new Set(c.reasons.filter((r) => r.source === 'behavior').map((r) => MISMATCH_RE.exec(r.note)?.[1]).filter((x): x is string => !!x))].map((x) => {
      const [loc, sc] = x.split(':');
      return `${labelOf(loc)} · ${sc}`;
    });
    return { state: 'mismatch', note: `Ran where it should be off${where.length ? ` (${where.join(', ')})` : ''}` };
  }
  if (row) {
    // A 'match' cell either expected it OFF (and saw nothing) or expected "may run" (anything goes).
    const off = cells.filter((x) => x.cell.status === 'match' && /^off\b/i.test(x.cell.expected));
    const mayRun = cells.filter((x) => (x.cell.status === 'match' || x.cell.status === 'allowed') && !/^off\b/i.test(x.cell.expected));
    if (off.length) return { state: 'no-mismatch-observed', note: `Nothing observed where it should be off, in ${off.length} compared visit${off.length === 1 ? '' : 's'} (${off.map(name).join(', ')}) — captured activity only, not a guarantee` };
    if (mayRun.length) return { state: 'only-may-run', note: `Compared only where it may run anyway (${mayRun.map(name).join(', ')}); never tested where it should be off` };
    return { state: 'not-established', note: 'Not established: no tested visit could be compared' };
  }
  if (c.behaviorChecked) return { state: 'only-may-run', note: 'Some visits were compared, but whether any expected it off is not recorded here — see the behavior grid' };
  return { state: 'not-established', note: 'Not established: no tested visit could be compared' };
}

function reachOf(c: PartyCompatibility, purpose: PurposeNeed, provenHeld: boolean): string | undefined {
  if (purpose === 'context') return undefined;
  switch (c.verdict) {
    case 'uncontrollable':
      return c.implementation === 'cname'
        ? 'its cookies are first-party through a DNS alias'
        : c.implementation === 'server-side-suspected'
          ? 'server-side forwarding is possible and cannot be seen from the browser'
          : 'an element in the HTML the browser fetches before any script runs';
    case 'unknown':
      return c.changes.some((x) => x.kind === 'needs-a-look' && x.page)
        ? 'traced to a script in the HTML, but whether that is its only path is not established'
        : c.implementation === 'direct-script'
          ? 'traced to a script whose tag was not located in the inspected HTML'
          : c.implementation === 'platform'
            ? 'injected by a platform or app that was not identified'
            : 'its loader was not identified';
    case 'tag-manager':
      if (provenHeld) return undefined;
      if (c.changes.some((x) => x.destinationId)) return "loaded by Google Tag Manager from a gtag('config') command in the page, with no container tag to gate — held only once that command is held (see the change list)";
      return c.changes.some((x) => x.kind === 'configure-tag-manager') ? 'loaded by a tag manager whose settings this scan cannot read' : 'loaded by a tag manager without a proven consent setting';
    default:
      return undefined;
  }
}

function scopeLine(ctx: CompatibilityContext): string {
  const pages = ctx.markup?.pages.filter((p) => p.status === 'inspected').length ?? 0;
  const verified = ctx.locations.filter((l) => l.verdict === 'verified');
  const runs = ctx.runs ?? 1;
  return `On what this scan saw: ${pages ? `${pages} page${pages === 1 ? ' with its' : 's with their'} HTML inspected` : 'no page HTML inspected'}, ${verified.length} verified location${verified.length === 1 ? '' : 's'}${verified.length ? ` (${verified.map((l) => l.label).join(', ')})` : ''}, logged out, desktop Chromium, ${runs} run${runs === 1 ? '' : 's'} per visitor action. Pages not visited can load other tools.`;
}

function consentToolView(f: ConsentToolDefaultFinding): CompatibilityReport['consentTool'] {
  const who = f.vendor ? `Your consent tool (${f.vendor})` : 'Your consent tool';
  if (f.status === 'grants-by-default')
    return { ...f, tone: 'red', headline: `${who} grants ${f.grants.join(', ')} by default on a fresh visit, before the visitor chooses. Tags it controls in those categories run as if the visitor agreed. Set those categories to off by default for opt-in locations.` };
  if (f.status === 'no-grants-decoded') return { ...f, tone: 'grey', headline: `${who}’s stored default was read and grants nothing beyond necessary — on the visits where it was read.` };
  return { ...f, tone: 'amber', headline: f.vendor ? `${who}’s stored default could not be read: what it allows by default is not established.` : 'No consent tool’s stored default was read: what runs by default is not established.' };
}

function missingInputsOf(inputs: CompatibilitySection['inputs']): string[] {
  const out: string[] = [];
  if (!inputs.markup) out.push('the served HTML was not inspected: no tag could be located for a rewrite');
  if (!inputs.containers) out.push('tag-manager containers were not fetched: which tags load a tool is unknown');
  if (!inputs.consentApi) out.push('consent-API calls (gtag consent, fbq consent …) were not recorded: no consent default is known to exist');
  if (!inputs.consentTool) out.push('the consent tool’s stored default was not read');
  if (!inputs.behavior) out.push('behavior could not be compared anywhere: verdicts explain how tools load, not whether they were held back');
  return out;
}

const mismatchNote = (row: CompatibilityRow): string => `${row.behaviorNote}. Whatever the implementation says, the current setup does not hold ${row.label} back. Make the changes listed for it below, then rescan — behavior is the ground truth.`;

const normUrl = (u: string): string => u.replace(/^(https?:)?\/\//, '').replace(/[?#].*$/, '');
const urlsOf = (p: TrackingEvaluation['inventory'][number]): string[] => [...(p.implementation?.evidence.map((e) => e.url).filter((u): u is string => !!u) ?? []), ...p.loadedBy].map(normUrl);

/** Tools traced to a script URL (what a tag-manager / loader tag brings in). */
function loadedThrough(url: string, inventory: TrackingEvaluation['inventory'], self: string): TrackingEvaluation['inventory'] {
  const u = normUrl(url);
  return inventory.filter((p) => p.partyId !== self && urlsOf(p).includes(u));
}

/** Where a located tag explains an unlocated tool: its traced loader URL matches a script in the HTML. */
function locateHint(p: TrackingEvaluation['inventory'][number] | undefined, findings: MarkupFinding[], self: string): string | undefined {
  if (!p) return undefined;
  const urls = urlsOf(p);
  const hit = findings.find((f) => f.verdict === 'gateable' && f.partyId !== self && f.url && urls.includes(normUrl(f.url)));
  if (!hit) return undefined;
  return `The script it was traced to is in your HTML at ${pageLine(hit.page, hit.line)} (listed under ${hit.label} in “Tags to rewrite”); rewriting that tag holds back what it loads.`;
}

export function buildCompatibilityReport(section: CompatibilitySection, ctx: CompatibilityContext): CompatibilityReport {
  const byId = new Map(ctx.inventory.map((p) => [p.partyId, p]));
  const labelOf = (id: string): string => ctx.locations.find((l) => l.id === id)?.label ?? id;
  const findings = ctx.markup?.findings ?? [];

  const notRequired = section.parties.filter((c) => c.purpose === 'not-required').map((c) => ({ partyId: c.partyId, label: c.label, categories: byId.get(c.partyId)?.categories ?? [], verdict: c.verdict }));
  const rows: CompatibilityRow[] = section.parties.filter((c) => c.purpose !== 'not-required').map((c) => {
    const p = byId.get(c.partyId);
    const categories = p?.categories ?? [];
    const purpose = purposeNeed(categories, c.purpose);
    const b = behaviorOf(c, labelOf, ctx.matrix);
    const provenHeld = c.verdict === 'tag-manager' && b.state !== 'mismatch' && !c.changes.some((x) => x.kind === 'gate-gtm-tag' || x.kind === 'set-consent-default' || x.kind === 'configure-tag-manager');
    const reachReason = c.purpose === 'not-required' ? undefined : reachOf(c, purpose, provenHeld);
    // Caveats B1 attaches to a platform verdict (server-side forwarding, a plugin that may not read consent).
    const caveats = c.reasons.filter((r) => r.source === 'platform' && /server-side|may not read consent/.test(r.note)).map((r) => r.note);
    const summary = !c.changes.length && c.purpose === 'not-required' ? 'No change: its purpose needs no consent' : summarizeChanges(c.changes, provenHeld);
    return {
      partyId: c.partyId,
      label: c.label,
      categories,
      purpose,
      ...(c.purpose ? { purposeScope: c.purpose } : {}),
      verdict: c.verdict,
      verdictLabel: provenHeld
        ? 'Yes — held back by the tag manager’s consent setting (proven in this scan)'
        : c.verdict === 'tag-manager' && c.changes.some((x) => x.destinationId)
          ? 'Only by holding the gtag(\'config\') snippet the tag manager reads (no container tag carries it)'
          : VERDICT_LABEL[c.verdict],
      implementation: c.implementation,
      implementationLabel: IMPLEMENTATION_LABEL[c.implementation],
      loader: loaderOf(p, c),
      behavior: b.state,
      behaviorNote: b.note,
      outsideReach: reachReason !== undefined,
      ...(reachReason ? { reachReason } : {}),
      provenHeld,
      ...(caveats.length ? { caveats } : {}),
      whatToChange: purpose === 'unclassified' && c.changes.length ? `Waiting on your decision: what is ${c.label}? Then, if it tracks visitors: ${summary[0].toLowerCase()}${summary.slice(1)}` : summary,
      changes: c.changes,
      reasons: c.reasons,
    };
  });
  const VERDICT_ORDER: Record<CompatibilityVerdict, number> = { uncontrollable: 0, unknown: 1, 'tag-manager': 2, platform: 3, gateable: 4 };
  const PURPOSE_ORDER: Record<PurposeNeed, number> = { consent: 0, unclassified: 0, context: 1 };
  rows.sort(
    (a, b) =>
      Number(b.behavior === 'mismatch') - Number(a.behavior === 'mismatch') ||
      PURPOSE_ORDER[a.purpose] - PURPOSE_ORDER[b.purpose] ||
      Number(b.outsideReach) - Number(a.outsideReach) ||
      VERDICT_ORDER[a.verdict] - VERDICT_ORDER[b.verdict] ||
      a.label.localeCompare(b.label),
  );

  const counted = rows.filter((r) => r.outsideReach);
  const n = counted.length;
  const line = `${n} tool${n === 1 ? ' is' : 's are'} loaded outside your consent tool's reach${n ? `: ${counted.map((r) => r.label).join(', ')}` : ''}.`;

  // --- the change list ---
  const groups = new Map<ChangeGroup['id'], Map<string, ChangeItem>>();
  const other = new Map<string, ChangeItem>();
  // `ident`: what the stable id hashes (record/remediation.ts changeId) — the
  // element, the container tag, the api, the platform, or the party. The merge
  // key stays the report's own (page|line…); the id is what the workspace and
  // the verify step use.
  const add = (gid: ChangeGroup['id'], key: string, row: CompatibilityRow, ident: ChangeIdInput, make: () => Omit<ChangeItem, 'id'>, merge?: (it: ChangeItem) => void): void => {
    const target = row.purpose === 'context' ? other : (groups.get(gid) ?? groups.set(gid, new Map()).get(gid)!);
    const k = `${gid}|${key}`;
    const it = target.get(k);
    if (it) {
      if (!it.partyIds.includes(row.partyId)) {
        it.partyIds.push(row.partyId);
        it.tools.push(row.label);
        if (row.purpose !== 'unclassified') delete it.classifyFirst;
      }
      merge?.(it);
    } else {
      const made: ChangeItem = { id: changeId(ident), ...(ident.signature ? { signature: ident.signature } : {}), ...make() };
      if (row.purpose === 'unclassified') made.classifyFirst = true;
      target.set(k, made);
    }
  };
  // The leak element at page:line for a party (remove-leak items carry no finding of their own).
  const leakAt = (partyId: string, page: string | undefined, line: number | undefined): MarkupFinding | undefined =>
    page === undefined ? undefined : (findings.find((x) => x.verdict === 'leak' && x.partyId === partyId && x.page === page && x.line === line) ?? findings.find((x) => x.verdict === 'leak' && x.page === page && x.line === line));
  // Google tag destinations GTM loads from a gtag('config') command in the page
  // (B1 marks them): a gtag.js loader rewrite for the same id must say that
  // holding the loader alone is not enough.
  const viaDataLayer = new Map<string, string | undefined>();
  for (const row of rows) {
    for (const c of row.changes) {
      if (!c.destinationId) continue;
      const id = c.destinationId.toUpperCase();
      const at = c.kind === 'rewrite-tag' && c.page ? pageLine(c.page, c.line) : undefined;
      if (!viaDataLayer.get(id)) viaDataLayer.set(id, at);
    }
  }

  // The matrix wins: a tool it shows running where it should be off is listed
  // first even when the record's own cells did not see it.
  for (const row of rows) {
    if (row.behavior === 'mismatch' && !row.changes.some((c) => c.kind === 'behavior-mismatch')) {
      add('mismatch', row.partyId, row, { kind: 'behavior-mismatch', partyId: row.partyId }, () => ({ kind: 'behavior-mismatch', tools: [row.label], partyIds: [row.partyId], note: mismatchNote(row) }));
    }
  }
  for (const row of rows) {
    const p = byId.get(row.partyId);
    for (const c of row.changes) {
      // Fresh arrays per item: merging another tool into one item must not touch the others.
      const fields = {
        tools: [row.label],
        partyIds: [row.partyId],
        kind: c.kind,
        note: c.note,
        ...(c.page ? { page: c.page } : {}),
        ...(c.line !== undefined ? { line: c.line } : {}),
        ...(c.element ? { element: c.element } : {}),
        ...(c.url ? { url: c.url } : {}),
        ...(c.why && c.kind !== 'rewrite-tag' ? { notes: [c.why] } : {}),
      };
      switch (c.kind) {
        case 'behavior-mismatch':
          add('mismatch', row.partyId, row, { kind: c.kind, partyId: row.partyId }, () => ({ ...fields, note: mismatchNote(row) }));
          break;
        case 'rewrite-tag': {
          // This party's finding at that line, else any tag there (a config snippet B1 matched under another party).
          const atLine = (x: MarkupFinding): boolean => x.verdict === 'gateable' && x.page === c.page && x.line === c.line;
          const f = findings.find((x) => x.partyId === row.partyId && atLine(x)) ?? findings.find(atLine);
          const loaded = row.categories.includes('tag-manager') && f?.url ? loadedThrough(f.url, ctx.inventory, row.partyId) : [];
          const cat = loaded.length ? { ...gateCategory(loaded.flatMap((x) => x.categories)), note: `it loads ${loaded.map((x) => x.label).join(', ')}: held under the strictest of their categories` } : gateCategory(row.categories);
          const snip = rewriteSnippet(f, c.url, cat.id);
          const notes = [...(c.why ? [c.why] : []), ...rewriteNotes(f, cat.id)];
          const gid = gtagIdOf(f?.url ?? c.url);
          if (gid && viaDataLayer.has(gid)) {
            const at = viaDataLayer.get(gid);
            notes.push(`Holding this loader is not enough while a Google Tag Manager container is on the page: GTM loads ${gid} itself from the gtag('config', '${gid}') command — gate that snippet too${at ? ` (${at}, listed in this group)` : ' (see “Needs a look”)'}.`);
          }
          add(
            'rewrite',
            `${c.page}|${c.line}`,
            row,
            f ? { kind: c.kind, signature: elementSignatureOf(f) } : { kind: c.kind, partyId: row.partyId, url: c.url },
            () => ({ ...fields, category: cat.id, ...(cat.note ? { categoryNote: cat.note } : {}), ...snip, ...(notes.length ? { notes } : {}), ...(f?.alsoOn.length ? { hint: `The same tag is also on ${f.alsoOn.length} other page${f.alsoOn.length === 1 ? '' : 's'}: ${f.alsoOn.slice(0, 3).map(shortPage).join(', ')}${f.alsoOn.length > 3 ? ', …' : ''} — usually one theme template.` } : {}) }),
            (it) => {
              const merged = [...new Set([...(it.notes ?? []), ...notes])];
              if (merged.length) it.notes = merged;
            },
          );
          break;
        }
        case 'gate-gtm-tag': {
          const tagNote = c.containerId && c.tagId !== undefined ? row.reasons.find((r) => r.source === 'container' && r.note.startsWith(`${c.containerId} tag ${c.tagId} `))?.note.slice(`${c.containerId} tag ${c.tagId} `.length) : undefined;
          add('gtm', c.tagId !== undefined ? `${c.containerId}|${c.tagId}` : `${c.containerId}|${row.partyId}`, row, { kind: c.kind, containerId: c.containerId, tagId: c.tagId, partyId: row.partyId }, () => ({
            ...fields,
            ...(c.containerId ? { containerId: c.containerId } : {}),
            ...(c.tagId !== undefined ? { tagId: c.tagId } : {}),
            ...(tagNote ? { tagNote } : {}),
            consentTypes: c.consentTypes ?? [],
            guide: { label: 'Setting up Google Tag Manager', href: GTM_GUIDE },
          }));
          break;
        }
        case 'set-consent-default':
          if (c.consentTypes?.length && !c.api) {
            const why = c.note.split(' — ').slice(1).join(' — ');
            const note = (types: string[]): string => `Before the Google Tag Manager or gtag.js snippet, set ${types.join(', ')} to denied${why ? ` (${why})` : ''}.`;
            add('consent-default', 'google', row, { kind: c.kind, api: 'google' }, () => ({ ...fields, note: note(c.consentTypes!), consentTypes: [...c.consentTypes!], after: consentDefaultSnippet(c.consentTypes!), guide: { label: 'Setting up Google Tag Manager', href: GTM_GUIDE } }), (it) => {
              it.consentTypes = [...new Set([...(it.consentTypes ?? []), ...c.consentTypes!])];
              it.note = note(it.consentTypes);
              it.after = consentDefaultSnippet(it.consentTypes);
            });
          } else add('consent-default', `${c.api ?? ''}|${row.partyId}`, row, { kind: c.kind, api: c.api ?? '', partyId: row.partyId }, () => ({ ...fields, ...(c.api ? { api: c.api } : {}), guide: { label: 'Vendor consent APIs', href: VENDOR_GUIDE } }));
          break;
        case 'configure-tag-manager':
          add('tag-manager', `${c.manager ?? ''}|${row.partyId}`, row, { kind: c.kind, manager: c.manager, partyId: row.partyId }, () => ({ ...fields, ...(c.manager ? { manager: c.manager } : {}) }));
          break;
        case 'use-platform-api': {
          const href = platformGuide(c.platform);
          add('platform', c.platform ?? row.partyId, row, { kind: c.kind, platform: c.platform, partyId: row.partyId }, () => ({ ...fields, ...(c.platform ? { platform: c.platform } : {}), ...(c.api ? { api: c.api } : {}), ...(href ? { guide: { label: `Installing on ${c.platform![0].toUpperCase()}${c.platform!.slice(1)}`, href } } : {}) }));
          break;
        }
        case 'call-consent-api':
          add('consent-api', `${row.partyId}|${c.note}`, row, { kind: c.kind, partyId: row.partyId, api: c.api }, () => ({ ...fields, ...(c.api ? { api: c.api } : {}), guide: { label: 'Vendor consent APIs', href: VENDOR_GUIDE } }));
          break;
        case 'remove-leak': {
          const f = leakAt(row.partyId, c.page, c.line);
          add('leaks', c.page ? `${c.page}|${c.line}|${c.url ?? ''}` : `${row.partyId}|${c.url ?? c.note}`, row, f ? { kind: c.kind, signature: elementSignatureOf(f) } : { kind: c.kind, partyId: row.partyId, url: c.url }, () => ({ ...fields }));
          break;
        }
        case 'change-dns':
          add('dns', c.host ?? row.partyId, row, { kind: c.kind, host: c.host, partyId: row.partyId }, () => ({ ...fields, ...(c.host ? { host: c.host } : {}), ...(c.target ? { target: c.target } : {}) }));
          break;
        case 'accepted-exposure':
          add('exposures', row.partyId, row, { kind: c.kind, partyId: row.partyId }, () => ({ ...fields }));
          break;
        case 'needs-a-look': {
          const hint = c.page ? undefined : locateHint(p, findings, row.partyId);
          add('needs-a-look', row.partyId, row, { kind: c.kind, partyId: row.partyId }, () => ({ ...fields, ...(hint ? { hint } : {}) }));
          break;
        }
      }
    }
  }
  // Every uncontrollable tool needs the owner's written decision, whatever else it needs.
  for (const row of rows) {
    if (row.verdict !== 'uncontrollable' || row.purpose === 'context' || row.changes.some((c) => c.kind === 'accepted-exposure')) continue;
    add('exposures', row.partyId, row, { kind: 'accepted-exposure', partyId: row.partyId }, () => ({ kind: 'accepted-exposure', tools: [row.label], partyIds: [row.partyId], note: `${row.label}: no consent tool controls it (${row.reachReason}). Make the changes above — or, where they are not made, remove the integration or record in writing that the exposure is accepted.` }));
  }

  const META: Record<ChangeGroup['id'], { title: string; intro: string; guide?: { label: string; href: string } }> = {
    mismatch: { title: 'Fix first: tools observed running where they should be off', intro: 'Behavior is the ground truth. These tools sent data or stored something where the location’s rules expect them off, whatever the implementation says. Make the changes listed for them below, then rescan.' },
    rewrite: { title: 'Tags to rewrite', intro: 'Each tag is a <script> in your HTML. Change it as shown: the browser does not run a type="text/plain" script, and the consent tool inserts a working copy once the visitor agrees to its category. The data-category must be a category id in your consent tool config.', guide: { label: 'Consent tool config: categories', href: CONFIG_GUIDE } },
    gtm: { title: 'GTM tags to gate', intro: 'In Google Tag Manager open each tag, then Advanced Settings → Consent Settings → “Require additional consent for tag to fire”, and add the listed consent types. Publish the container. A requirement only holds a tag when a denied default is set first (next group).', guide: { label: 'Setting up Google Tag Manager', href: GTM_GUIDE } },
    'consent-default': { title: 'Consent defaults to set before tags load', intro: 'Google treats a consent type that was never set as granted. A denied default must run before the container or tag loads. The complykit consent tool sets it for you when installed above the container snippet; otherwise add the snippet below.' },
    'tag-manager': { title: 'Other tag managers', intro: 'This scan cannot read these containers. In the tag manager, require consent on each tag that loads the tool.' },
    platform: { title: 'Platform settings', intro: 'The platform injects these tools itself, so a rewrite of your HTML does not reach them. Turn on the platform’s consent setting; the consent tool’s platform bridge passes the visitor’s choice to it. The setting covers only what the platform injects into the browser: events the platform or a vendor’s app forwards server-side (server pixels, conversions APIs) are not covered and cannot be verified from the browser.' },
    'consent-api': { title: 'Vendor consent calls (alongside the block, never instead)', intro: 'These vendors also take a consent signal. The consent tool’s adapters make these calls; a hand-made setup must make them too.', guide: { label: 'Vendor consent APIs', href: VENDOR_GUIDE } },
    leaks: { title: 'Leaks to remove', intro: 'The browser fetches these elements itself, before any script runs (and <noscript> content fires exactly for visitors without JavaScript, when no consent tool can run). No consent tool can hold them back: remove them from the HTML.' },
    dns: { title: 'DNS aliases', intro: 'A first-party subdomain points at the vendor, so its cookies are first-party and no consent tool can remove them.' },
    exposures: { title: 'Accepted exposures', intro: 'Nothing on the page controls these. Remove the integration, or record in writing that the exposure is accepted — a decision for the owner, not a developer task.' },
    'needs-a-look': { title: 'Needs a look', intro: 'The scan could not establish how these tools get onto the page, so it cannot say what to change. A developer has to find the code that loads them.' },
  };
  const ORDER: ChangeGroup['id'][] = ['mismatch', 'rewrite', 'gtm', 'consent-default', 'tag-manager', 'platform', 'consent-api', 'leaks', 'dns', 'exposures', 'needs-a-look'];
  const outGroups: ChangeGroup[] = ORDER.filter((id) => groups.get(id)?.size).map((id) => ({ id, ...META[id], items: [...groups.get(id)!.values()] }));

  return {
    scope: scopeLine(ctx),
    reach: {
      count: n,
      line,
      tools: counted.map((r) => ({ partyId: r.partyId, label: r.label, verdict: r.verdict, reason: r.reachReason! })),
      definition:
        'Counted: tools whose purpose needs a consent decision (analytics, performance, advertising, session recording, identity resolution, fingerprinting, marketing email, tag managers) or is not classified yet, and that are loaded by an element in the HTML, a DNS alias or a server, by a loader the scan could not identify, or by a tag manager without a proven consent setting. Not counted: tools in a <script> tag you can rewrite, tools the platform injects (its consent setting reaches them), and tools whose purpose needs no consent or depends on the feature (necessary, CDN, captcha, payments, the consent tool; chat, embeds, fonts).',
    },
    consentTool: consentToolView(section.consentTool),
    rows,
    groups: outGroups,
    otherChanges: [...other.values()],
    notRequired,
    inputs: section.inputs,
    missingInputs: missingInputsOf(section.inputs),
  };
}

// --- HTML ------------------------------------------------------------------------

const CONTEXT_NOTE = 'Under opt-in rules these need consent unless strictly needed for a feature the visitor asked for. The changes apply where they are not. Not counted in the line above.';
const NOT_REQUIRED_NOTE = 'Their purpose needs no consent, so nothing is listed for them; how they load is recorded in the evidence. Not counted in the line above.';

export const COMPATIBILITY_CSS = `.ck-compat .ck-reach{font-size:18px;margin:8px 0}.ck-compat pre{white-space:pre;overflow-x:auto;max-width:100%;background:var(--bg);border:1px solid var(--line);border-radius:6px;padding:8px;font:12px/1.5 var(--mono,ui-monospace,monospace)}.ck-compat .ck-item{border-top:1px solid var(--line);padding:10px 0}.ck-compat .ck-item h5{margin:0 0 4px;font-size:14px}.ck-compat [data-behavior=mismatch] .ck-behavior{color:var(--v,#b42318);font-weight:600}.ck-compat .ck-snippets{display:grid;gap:6px}.ck-compat .ck-snippets p{margin:4px 0 0}`;

const link = (g: { label: string; href: string } | undefined): string => (g ? `<a href="${esc(safeHref(g.href))}">${esc(g.label)}</a>` : '');

function itemTitle(it: ChangeItem): string {
  switch (it.kind) {
    case 'rewrite-tag':
    case 'remove-leak':
      return `${it.page ? `${pageLine(it.page, it.line)} · ` : ''}${it.tools.join(', ')}${it.element ? ` · ${it.element}` : ''}`;
    case 'gate-gtm-tag':
      return `${it.containerId ?? 'GTM container'}${it.tagId !== undefined ? ` · tag ${it.tagId}` : ' · tag not identified'} · ${it.tools.join(', ')}`;
    case 'use-platform-api':
      return `${it.platform ? it.platform[0].toUpperCase() + it.platform.slice(1) : 'Platform'} · ${it.tools.join(', ')}`;
    case 'change-dns':
      return `${it.host ?? ''}${it.target ? ` → ${it.target}` : ''} · ${it.tools.join(', ')}`;
    default:
      return it.tools.join(', ');
  }
}

function itemHtml(it: ChangeItem): string {
  const parts: string[] = [`<div class="ck-item" id="change-${esc(it.id)}" data-change-id="${esc(it.id)}" data-change-kind="${esc(it.kind)}"><h5>${esc(itemTitle(it))}</h5>`];
  if (it.classifyFirst) parts.push(`<p><strong>Waiting on:</strong> deciding what ${esc(it.tools.join(', '))} ${it.tools.length === 1 ? 'is' : 'are'} (the first items of your to-do list) — this applies only if it tracks visitors.</p>`);
  if (it.kind === 'gate-gtm-tag') {
    parts.push(`<p><strong>Consent setting to choose:</strong> Require additional consent for tag to fire → <code>${esc((it.consentTypes ?? []).join(', '))}</code></p>`);
    parts.push(`<p class="human-muted">${esc(it.tagNote ? `Now: ${it.tagNote}.` : it.note)}</p>`);
  } else if (it.kind !== 'rewrite-tag') parts.push(`<p>${esc(it.note)}</p>`);
  if (it.url && it.kind !== 'rewrite-tag') parts.push(`<p class="human-muted">URL: <code>${esc(it.url)}</code></p>`);
  if (it.before || it.after) {
    parts.push('<div class="ck-snippets">');
    if (it.before) parts.push(`<p>Before:</p><pre><code>${esc(it.before)}</code></pre>`);
    if (it.after) parts.push(`<p>${it.before ? 'After:' : 'Add:'}</p><pre><code>${esc(it.after)}</code></pre>`);
    parts.push('</div>');
  }
  if (it.categoryNote) parts.push(`<p class="human-muted">data-category “${esc(it.category)}”: ${esc(it.categoryNote)}.</p>`);
  for (const n of it.notes ?? []) parts.push(`<p class="human-callout" data-change-note>${esc(n)}</p>`);
  if (it.hint) parts.push(`<p class="human-callout">${esc(it.hint)}</p>`);
  if (it.guide) parts.push(`<p>Guide: ${link(it.guide)}</p>`);
  parts.push('</div>');
  return parts.join('');
}

export function renderCompatibilityHtml(r: CompatibilityReport | undefined, opts: { changeListHref?: string } = {}): string {
  if (!r) return `<section id="compatibility" class="ck-compat"><h2 class="human-section-title">Can your consent tool control each tool?</h2><p>This run has no compatibility verdicts (recorded by an older build). Re-render it with this version, or rescan.</p></section>`;
  const ct = r.consentTool;
  const rows = r.rows
    .map(
      (row) => `<tr data-compat-row="${esc(row.partyId)}" data-verdict="${esc(row.verdict)}" data-behavior="${row.behavior}" data-outside-reach="${row.outsideReach}" data-purpose="${row.purpose}"><th scope="row">${esc(row.label)}<br><span class="human-muted">${esc(row.categories.join(', ') || 'not classified')}</span></th><td class="ck-behavior">${esc(row.behaviorNote)}</td><td>${esc(row.verdictLabel)}${row.caveats?.length ? row.caveats.map((c) => `<br><span class="human-muted">${esc(c)}</span>`).join('') : ''}</td><td>${esc(row.implementationLabel)}</td><td><code>${esc(row.loader)}</code></td><td>${esc(row.whatToChange)}${row.reasons.length ? `<details class="human-details"><summary>Why (${row.reasons.length})</summary><div><ul>${row.reasons.map((x) => `<li>${esc(x.note)}${x.ref ? ` <code>${esc(x.ref)}</code>` : ''}</li>`).join('')}</ul></div></details>` : ''}</td></tr>`,
    )
    .join('');
  const groups = r.groups
    .map((g) => `<section class="ck-change-group" data-change-group="${g.id}"><h4>${esc(g.title)} (${g.items.length})</h4><p>${esc(g.intro)}${g.guide ? ` ${link(g.guide)}.` : ''}</p>${g.items.map(itemHtml).join('')}</section>`)
    .join('');
  const other = r.otherChanges.length
    ? `<details class="human-details" data-change-group="other"><summary>Chat, embeds, fonts and other feature tools (${r.otherChanges.length} item${r.otherChanges.length === 1 ? '' : 's'}, not counted)</summary><div><p>${esc(CONTEXT_NOTE)}</p>${r.otherChanges.map(itemHtml).join('')}</div></details>`
    : '';
  const notRequired = r.notRequired.length
    ? `<details class="human-details" data-not-required><summary>Not counted: necessary / CDN / captcha / payments / consent tool (${r.notRequired.length})</summary><div><p>${esc(NOT_REQUIRED_NOTE)}</p><p>${r.notRequired.map((t) => `${esc(t.label)} <span class="human-muted">(${esc(t.categories.join(', '))})</span>`).join(' · ')}</p></div></details>`
    : '';
  return `<section id="compatibility" class="ck-compat" data-reach-count="${r.reach.count}">
<h2 class="human-section-title">Can your consent tool control each tool?</h2>
<p class="ck-reach"><strong>${esc(r.reach.line)}</strong></p>
<p class="human-muted">${esc(r.scope)}</p>
<details class="human-details"><summary>Which tools count</summary><div><p>${esc(r.reach.definition)}</p>${r.reach.tools.length ? `<ul>${r.reach.tools.map((t) => `<li>${esc(t.label)}: ${esc(t.reason)}</li>`).join('')}</ul>` : ''}</div></details>
<p class="human-callout" data-consent-default="${ct.status}" data-tone="${ct.tone}"><strong>Consent tool default:</strong> ${esc(ct.headline)}</p>
${r.missingInputs.length ? `<p class="human-muted"><strong>Missing evidence:</strong> ${esc(r.missingInputs.join('; '))}.</p>` : ''}
${opts.changeListHref ? `<p><a class="human-link" href="${esc(safeHref(opts.changeListHref))}" download>Download the change list (${esc(CHANGE_LIST_FILE)})</a> — the same list as below, for the developer.</p>` : ''}
<div class="human-table-wrap"><table class="human-table ck-compat-table"><caption>One row per tool. Tools observed running where they should be off come first.</caption><thead><tr><th>Tool</th><th>Behavior</th><th>Can the consent tool control it?</th><th>How it loads</th><th>Loader</th><th>What to change</th></tr></thead><tbody>${rows || '<tr><td colspan="6">No outside tools were recorded.</td></tr>'}</tbody></table></div>
<h3 id="change-list">Change list</h3>
${groups || '<p>No change was listed for tools that need a consent decision. This covers only what the scan saw.</p>'}
${other}
${notRequired}
</section>`;
}

// --- Markdown ------------------------------------------------------------------------

const mdCell = (s: string): string => s.replace(/\|/g, '\\|').replace(/\n/g, ' ');

/** The compatibility section inside the consent Markdown digest. */
export function renderCompatibilityMarkdown(r: CompatibilityReport | undefined): string[] {
  const lines: string[] = ['## Consent tool compatibility', ''];
  if (!r) return [...lines, 'Not evaluated in this run (older build).', ''];
  lines.push(`**${r.reach.line}**`, '', r.scope, '', `Consent tool default: ${r.consentTool.headline}`, '');
  if (r.rows.length) {
    lines.push('| Tool | Behavior | Can the consent tool control it? | How it loads | What to change |', '|---|---|---|---|---|');
    for (const row of r.rows) lines.push(`| ${mdCell(row.label)} | ${mdCell(row.behaviorNote)} | ${mdCell(row.verdictLabel + (row.caveats?.length ? ` (${row.caveats.join('; ')})` : ''))} | ${mdCell(row.implementationLabel)} | ${mdCell(row.whatToChange)} |`);
    lines.push('');
  }
  lines.push(`Full change list: \`${CHANGE_LIST_FILE}\` beside the report.`, '');
  return lines;
}

function itemMarkdown(it: ChangeItem): string[] {
  // The anchor is the stable change id: a link into this file survives the owner's edits (the title's page:line does not).
  const out: string[] = [`<a id="change-${it.id}"></a>`, '', `### ${itemTitle(it)}`, '', `- Change id: \`${it.id}\``];
  if (it.classifyFirst) out.push(`- **Waiting on:** deciding what ${it.tools.join(', ')} ${it.tools.length === 1 ? 'is' : 'are'} (classify it in the report) — this applies only if it tracks visitors.`);
  if (it.kind === 'gate-gtm-tag') {
    out.push(`- Consent setting to choose: **Require additional consent for tag to fire** → \`${(it.consentTypes ?? []).join(', ')}\``);
    out.push(`- ${it.tagNote ? `Now: ${it.tagNote}.` : it.note}`);
  } else if (it.kind !== 'rewrite-tag') out.push(`- ${it.note}`);
  if (it.kind === 'rewrite-tag' && it.page) out.push(`- File: the template that renders \`${it.page}\`, line ${it.line} of the served HTML`);
  if (it.url && it.kind !== 'rewrite-tag') out.push(`- URL: \`${it.url}\``);
  if (it.categoryNote) out.push(`- data-category "${it.category}": ${it.categoryNote}`);
  for (const n of it.notes ?? []) out.push(`- ${n}`);
  if (it.hint) out.push(`- ${it.hint}`);
  if (it.guide) out.push(`- Guide: [${it.guide.label}](${it.guide.href})`);
  out.push('');
  if (it.before) out.push('Before:', '', '```html', it.before, '```', '');
  if (it.after) out.push(it.before ? 'After:' : 'Add:', '', '```html', it.after, '```', '');
  return out;
}

/** The standalone change list (change-list.md) — everything a developer needs, nothing else. */
export function renderChangeListMarkdown(m: { site: { host: string; url: string }; runId: string; startedAt: string; compatibility?: CompatibilityReport }): string {
  const r = m.compatibility;
  const lines: string[] = [`# Change list — ${m.site.host}`, '', `From complykit run \`${m.runId}\` of ${m.site.url}, scanned ${m.startedAt.slice(0, 16).replace('T', ' ')} UTC.`, ''];
  if (!r) {
    lines.push('This run has no compatibility verdicts (recorded by an older build). Re-render it with this version, or rescan.');
    return lines.join('\n') + '\n';
  }
  lines.push(`> ${r.reach.line}`, '', r.scope, '');
  for (const t of r.reach.tools) lines.push(`- ${t.label}: ${t.reason}`);
  if (r.reach.tools.length) lines.push('');
  lines.push(`**Consent tool default:** ${r.consentTool.headline}`, '');
  if (r.missingInputs.length) lines.push(`**Missing evidence** (each weakens the list, none strengthens it): ${r.missingInputs.join('; ')}.`, '');
  if (!r.groups.length) lines.push('No change was listed for tools that need a consent decision. This covers only what the scan saw.', '');
  r.groups.forEach((g, i) => {
    lines.push(`## ${i + 1}. ${g.title} (${g.items.length})`, '', g.intro + (g.guide ? ` Guide: [${g.guide.label}](${g.guide.href}).` : ''), '');
    for (const it of g.items) lines.push(...itemMarkdown(it));
  });
  if (r.otherChanges.length) {
    lines.push(`## Chat, embeds, fonts and other feature tools (${r.otherChanges.length}, not counted)`, '', CONTEXT_NOTE, '');
    for (const it of r.otherChanges) lines.push(`- ${itemTitle(it)}: ${it.note}`);
    lines.push('');
  }
  if (r.notRequired.length) lines.push(`Not counted: necessary / CDN / captcha / payments / consent tool — ${r.notRequired.map((t) => t.label).join(', ')}. ${NOT_REQUIRED_NOTE}`, '');
  lines.push(
    '## What this list cannot tell you',
    '',
    '- Pages the scan did not visit, logged-in areas, other regions, devices and A/B variants can load other tools.',
    '- Server-side forwarding is invisible from the browser; what a vendor does with data it received is out of scope.',
    '- A change is confirmed only by a rescan: behavior is the ground truth, this list is the explanation.',
    '',
  );
  return lines.join('\n');
}
