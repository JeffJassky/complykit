import type { Finding, PartyInventoryItem, TrackingEvaluation } from './record/index.js';
import {
  CONSENT_CONFIG_VERSION,
  NECESSARY_CATEGORY,
  type ConsentPlatform,
  type ConsentToolConfig,
  type ConsentVendor,
  type GateRule,
  type GtmConfig,
  type RegimeSource,
  type VendorControl,
  type ConsentLayout,
  type ConsentTheme,
} from './record/consent-config-guard.js';
import { parseConsentToolConfig, withConsentConfigHash, type ConsentToolConfigInput } from './record/consent-config.js';
import { CONSENT_CATEGORIES, DEFAULT_KB, type KnowledgeBase, type KnowledgeEntry } from './registry/index.js';
import { purposeScopeOf } from './rules/tracking/compatibility.js';
import {
  buildConsentReportModel,
  renderChangeListMarkdown,
  gateCategory,
  shortPage,
  type ChangeItem,
  type CompatibilityReport,
} from './report/index.js';
import { cookiePurposes } from './report/cookie-purpose.js';
import { reconcileRecord } from './consent-compatibility.js';
import { doneTasks, resolveSiteClassifications, siteDecisions, type WorkspaceSnapshot, type WorkspaceSubject } from './site-workspace.js';
import { buildRemediationTasks, renderHeadSnippet, scriptJson } from './remediation.js';
import type { RemediationTask } from './record/index.js';

// The guided remediation flow (plans/remediation-flow.md) reads the output:
// `compatibility` (the change items with their stable ids), `scriptSrc` and
// `tasks` (built here so the service's stored config.value carries them).
export { scriptJson };

// The config generator (client-consent epic, ticket D8; plans/client-consent-
// design.md §6 "Config generator", §10 "Configuration is inline"): one scan
// (plus the site workspace) → the consent tool's config, the snippet to paste,
// and the owner's change list.
//
// Pure over the record. It re-decides compatibility the way the report does
// (src/consent-compatibility.ts, after the workspace is applied) and builds the
// change list from that same report model, so the config, the snippet's tag
// rewrites and change-list.md say the same thing: a rewritten tag's
// data-category is the vendor's category, by construction (both come from
// gateCategory()).
//
// Rules (each one tested in test/consent-generator.test.ts):
//   - Categories present only: the categories of the tools seen (and of the GTM
//     tags that must carry a requirement), plus `necessary` (the schema needs it).
//     Category ids are the consent tool's: necessary, functional, analytics,
//     performance, advertising — the ids the change list's rewrites use.
//   - A known tracker is NEVER put in `necessary`. "Known tracker" = its
//     knowledge-base entry names a consent category (analytics, advertising,
//     session recording, …), or it is not in the knowledge base and behaves like
//     a tracker. A workspace classification that says otherwise is refused
//     (before compatibility is decided, so the change list agrees), and the
//     config is checked again before it is returned (defense in depth).
//   - Unclassified tools go to the strictest category (advertising), with a note.
//   - Tag managers are not vendors (they load the others; GTM is reached through
//     `gtm`); an existing consent tool is not a vendor (it is being replaced).
//   - control: 'platform' for a platform verdict (when the platform is known);
//     'none' for a DNS alias, suspected server-side forwarding, or no route;
//     'api' when the vendor has an adapter (additive to gating, never instead);
//     'gate' for a gateable tag or a tag-manager tag — but only when the change
//     list rewrites one of its tags or gtm.tags lists one (a vendor reached only
//     by a stylesheet / font request has nothing to gate: 'none', with a note to
//     self-host). A vendor whose loader was not identified is 'none' unless it
//     has an adapter — and the note says so.
//   - regimeSource: Shopify → 'platform' (customerPrivacy.getRegion); otherwise
//     <meta name="complykit-region">, which the server must write (a note says
//     so; without it every visitor is treated as opt-in — fail closed).
//   - theme and strings empty (the tool's defaults, per regime), layout 'bar',
//     choices remembered 365 days, no consent-record endpoint unless asked.
//   - The output parses against the D2 schema and its hash verifies, or the
//     generator throws.

/** Where the generated snippet loads the tool from. A placeholder: self-hosted, the owner adjusts the path. */
export const DEFAULT_SCRIPT_SRC = '/complykit/v1/complykit-consent.js';
export const CONFIG_FILE = 'complykit-config.json';
export const SNIPPET_FILE = 'snippet.html';
export const GENERATOR_NOTES_FILE = 'generator-notes.md';

/** Category ids the generator emits, in display order. */
export const GENERATED_CATEGORY_ORDER = [NECESSARY_CATEGORY, 'functional', 'analytics', 'performance', 'advertising'] as const;

const CATEGORY_TEXT: Record<string, { label: string; description: string }> = {
  necessary: { label: 'Necessary', description: 'Needed for the site to work. Always on.' },
  functional: { label: 'Functional', description: 'Optional features such as chat, reviews, embedded media and fonts.' },
  analytics: { label: 'Analytics', description: 'Measures visits and how people use the site.' },
  performance: { label: 'Performance', description: 'Measures speed, reliability and errors.' },
  advertising: { label: 'Advertising', description: 'Ads, audiences, targeting and campaign measurement.' },
};

// Granted before a choice, per regime. Under opt-in nothing but necessary (the
// schema enforces it). Under the two US regimes every category "may run before a
// choice" — the same expectation the report's behavior matrix applies
// (src/report/cookie-purpose.ts) — and the tool denies them all when the browser
// sends Global Privacy Control (the store, D3), or when the visitor opts out.
const DEFAULTS: Record<string, ConsentToolConfig['categories'][number]['defaultByRegime']> = {
  necessary: { 'opt-in': true, 'opt-out-signal': true, 'opt-out': true },
};
const NON_NECESSARY_DEFAULT = { 'opt-in': false, 'opt-out-signal': true, 'opt-out': true };

/** KB entry id → the client adapter that speaks its consent API (client/src/adapters). */
export const ADAPTER_FOR_KB: Readonly<Record<string, string>> = {
  'google.analytics': 'google-consent-mode',
  'google.ads.ccm': 'google-consent-mode',
  'google.ads.doubleclick': 'google-consent-mode',
  'meta.pixel': 'meta',
  'tiktok.pixel': 'tiktok',
  'microsoft.uet': 'microsoft-uet',
  'microsoft.clarity': 'microsoft-clarity',
  'pinterest.tag': 'pinterest',
};

const PLATFORMS: readonly ConsentPlatform[] = ['shopify', 'wix', 'squarespace', 'wordpress'];

export type GeneratorNoteCode =
  | 'refused-necessary' // a known tracker classified necessary: refused
  | 'necessary-behaves-like-tracker' // a necessary-purpose tool that behaved like a tracker: kept, flagged
  | 'unclassified-strictest' // not classified: held under advertising
  | 'no-matching-category' // classified, but no consent category fits: held under advertising
  | 'tag-manager-not-vendor'
  | 'existing-consent-tool'
  | 'not-controlled' // control 'none'
  | 'loader-not-identified' // unknown verdict
  | 'unmapped-gtm-tags'
  | 'container-not-read'
  | 'gtag-destinations'
  | 'gtm-loader-gated'
  | 'document-write'
  | 'duplicate-id'
  | 'inline-rewrite'
  | 'regime-source'
  | 'script-path'
  | 'platform-unsupported'
  | 'dormant-tags' // tags in the HTML for tools that never ran
  | 'gtag-config-via-gtm' // a Google tag destination GTM loads from a gtag('config') command in the page
  | 'data-url-tag' // a tag whose code is a data: URL (a performance plugin's form)
  | 'optimizer-delay'; // a tag a performance plugin delays: not consent gating

export interface GeneratorNote {
  code: GeneratorNoteCode;
  /** 'refused': the generator overrode an input; 'flag': the owner must act or check; 'info': how the config was decided. */
  level: 'refused' | 'flag' | 'info';
  message: string;
  partyIds?: string[];
}

/** One gated-tag rewrite in the snippet (from the change list's "Tags to rewrite"). */
export interface SnippetRewrite {
  /** The change-list item's stable id (task:change:<id>). */
  id: string;
  tools: string[];
  partyIds: string[];
  category: string;
  page?: string;
  line?: number;
  before?: string;
  after?: string;
  /** True for an inline script: the owner edits the tag in place (its code is not in the scan). */
  inline: boolean;
  /** A context-purpose tool (chat, embeds, fonts…): applies only where it is not strictly needed. */
  optional: boolean;
  flags: string[];
}

export interface GenerateConsentConfigOptions {
  /** Knowledge base for control facts, adapters and cookie patterns (default: the seed). */
  kb?: KnowledgeBase;
  /** The site workspace: its classifications override the scan's categories. */
  workspace?: WorkspaceSnapshot;
  /** The run's findings (only the report model's other sections use them). */
  findings?: Finding[];
  /** complykit version stamped in generatedFrom. */
  complykitVersion: string;
  /** generatedFrom.at (default: now). */
  now?: string;
  scriptSrc?: string;
  /** Opt-in consent-record endpoint (omitted by default). */
  recordEndpoint?: string;
  privacyPolicyUrl?: string;
  regimeSource?: RegimeSource;
  layout?: ConsentLayout;
  theme?: ConsentTheme;
  lifetimeDays?: number;
}

export interface GeneratedConsentConfig {
  config: ConsentToolConfig;
  /** complykit-config.json, as written. */
  json: string;
  /** snippet.html: the head snippet (inline config + script) and the tag rewrites. */
  snippet: string;
  /** change-list.md (B2's renderer, over the same report model). */
  changeList: string;
  rewrites: SnippetRewrite[];
  notes: GeneratorNote[];
  /** generator-notes.md: the notes, for the owner. */
  notesMarkdown: string;
  /** Where the snippet loads the tool from (opts.scriptSrc or DEFAULT_SCRIPT_SRC). */
  scriptSrc: string;
  /** The report's compatibility section this config was built from: the change items carry their stable ids. */
  compatibility: CompatibilityReport;
  /** The guided checklist (plans/remediation-flow.md): install first, then one task per change item. Status 'todo' unless the workspace says otherwise. */
  tasks: RemediationTask[];
}

// --- workspace and the necessary guard ---------------------------------------------

/**
 * Apply a site workspace to a saved record, after the fact: the scan-time
 * workspace's tool classifications are undone (back to the knowledge base), then
 * this workspace's are applied to the inventory, and its storage classifications
 * are recorded for the behavior matrix — what `applyWorkspace` does at scan time,
 * from the inventory instead of the timelines. Mutates `ev`.
 */
export function applyWorkspaceToRecord(ev: TrackingEvaluation, ws: WorkspaceSnapshot, kb: KnowledgeBase, at: string): void {
  const byId = new Map(ev.inventory.map((p) => [p.partyId, p]));
  for (const c of ev.siteWorkspace?.classifications ?? []) {
    if (c.kind !== 'tool') continue;
    const p = byId.get(c.partyId);
    if (!p) continue;
    const e = kb.entries.find((x) => x.id === c.partyId);
    if (e) p.categories = [...e.categories];
    else if (c.partyId.startsWith('unknown:')) p.categories = ['unknown'];
  }
  const subjects: WorkspaceSubject[] = ev.inventory.flatMap((p): WorkspaceSubject[] => [
    { kind: 'tool', partyId: p.partyId, domain: p.domain, recognized: p.recognized },
    ...p.stores.map((s): WorkspaceSubject => ({ kind: 'storage', partyId: p.partyId, domain: p.domain, storageKind: s.kind, name: s.name })),
  ]);
  const classifications = resolveSiteClassifications(subjects, ws);
  for (const c of classifications) {
    if (c.kind !== 'tool') continue;
    const p = byId.get(c.partyId);
    if (p) p.categories = [...c.categories];
  }
  ev.siteWorkspace = { ...(ws.domain ? { domain: ws.domain } : {}), appliedAt: at, classifications, doneTasks: doneTasks(ws), ...siteDecisions(ws) };
}

/** Why this party is a known tracker, or undefined. Decided from the knowledge base and behavior — never from a site classification. */
export function knownTrackerReason(p: Pick<PartyInventoryItem, 'partyId' | 'behavesLikeTracker' | 'trackerSignals'>, kb: KnowledgeBase): string | undefined {
  const e = kb.entries.find((x) => x.id === p.partyId);
  const consent = (e?.categories ?? []).filter((c) => CONSENT_CATEGORIES.has(c));
  if (consent.length) return `its knowledge-base entry classifies it as ${consent.join(', ')}`;
  if (!e && p.behavesLikeTracker) return `it is not in the knowledge base and behaved like a tracker (${p.trackerSignals.join(', ') || 'tracker signals'})`;
  return undefined;
}

/**
 * Refuse 'necessary-only' categories for a known tracker (a workspace
 * classification, a site override, a stale KB): its categories go back to the
 * knowledge base's (or 'unknown' — the strictest category — when it has no
 * entry). Runs before compatibility is decided, so the change list treats it
 * as needing consent too. Mutates `ev`; returns the refusals.
 */
export function refuseNecessaryTrackers(ev: TrackingEvaluation, kb: KnowledgeBase): GeneratorNote[] {
  const notes: GeneratorNote[] = [];
  for (const p of ev.inventory) {
    if (purposeScopeOf(p.categories) !== 'not-required' || p.categories.includes('consent')) continue;
    const why = knownTrackerReason(p, kb);
    if (!why) continue;
    const e = kb.entries.find((x) => x.id === p.partyId);
    const was = p.categories.join(', ');
    p.categories = e ? [...e.categories] : ['unknown'];
    notes.push({
      code: 'refused-necessary',
      level: 'refused',
      partyIds: [p.partyId],
      message: `${p.label} was classified ${was}, which would load it before any choice. Refused: ${why}. It is treated as ${p.categories.join(', ')} instead — a tracker is never necessary.`,
    });
  }
  return notes;
}

// --- the generator --------------------------------------------------------------------

const escapeRegExp = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Regex source for a gated script's src: scheme-optional, path-anchored, query ignored. */
export function srcRule(url: string): string | undefined {
  const m = /^(?:https?:)?\/\/([^/?#]+)([^?#]*)/i.exec(url);
  if (!m) return undefined;
  return `^(?:https?:)?//${escapeRegExp(m[1].toLowerCase())}${escapeRegExp(m[2])}`;
}

/** Category for a context-purpose tool (chat, embeds, fonts, reviews, error monitoring). */
function contextCategory(categories: readonly string[]): string {
  const purposes = cookiePurposes([...categories]);
  for (const id of ['advertising', 'analytics', 'performance', 'functional']) if (purposes.includes(id)) return id;
  return 'functional';
}

function platformOf(ev: TrackingEvaluation): ConsentPlatform {
  const name = ev.platform?.name;
  return name && (PLATFORMS as readonly string[]).includes(name) ? (name as ConsentPlatform) : 'none';
}

function storesOf(p: PartyInventoryItem, e: KnowledgeEntry | undefined, protectedName: (kind: string, name: string) => boolean): ConsentVendor['stores'] {
  if (e?.stores.length) return e.stores.map((s) => ({ name: s.name, kind: s.kind }));
  // No KB patterns: the names this scan saw, exact. Never a name a necessary
  // tool (or the team) claims — withdrawal deletes these.
  const out: ConsentVendor['stores'] = [];
  for (const s of p.stores) {
    const kind = s.kind === 'local' || s.kind === 'session' ? s.kind : 'cookie';
    if (protectedName(kind, s.name)) continue;
    const name = `^${escapeRegExp(s.name)}$`;
    if (!out.some((x) => x.name === name && x.kind === kind)) out.push({ name, kind });
  }
  return out;
}

const GTM_ID = /^GTM-[A-Z0-9]+$/;

/** Generate the consent tool config, snippet and change list from one consent run. */
export function generateConsentConfig(evaluation: TrackingEvaluation, opts: GenerateConsentConfigOptions): GeneratedConsentConfig {
  const kb = opts.kb ?? DEFAULT_KB;
  const at = opts.now ?? new Date().toISOString();
  const ev: TrackingEvaluation = structuredClone(evaluation);
  const notes: GeneratorNote[] = [];

  if (opts.workspace) applyWorkspaceToRecord(ev, opts.workspace, kb, at);
  notes.push(...refuseNecessaryTrackers(ev, kb));
  // The same reconcile as the report (incl. the deployed tool's denied-state
  // misfires, D10), so the checklist carries every item the report's change list shows.
  const compatibility = reconcileRecord(ev, { kb, workspace: opts.workspace });
  const model = buildConsentReportModel(ev, opts.findings ?? []);
  const report = model.compatibility;
  if (!report) throw new Error('unreachable: the report model has no compatibility section');
  const changeList = renderChangeListMarkdown(model);

  const platform = platformOf(ev);
  const compat = new Map(compatibility.parties.map((c) => [c.partyId, c]));
  const entryOf = (id: string): KnowledgeEntry | undefined => kb.entries.find((e) => e.id === id);

  // Names the withdrawal flow must never delete: what necessary tools set, and
  // what the team classified as necessary.
  const necessaryPatterns: Array<{ kind: string; re: RegExp }> = [];
  const necessaryNames = new Set<string>();
  for (const p of ev.inventory) {
    if (purposeScopeOf(p.categories) !== 'not-required') continue;
    for (const s of entryOf(p.partyId)?.stores ?? []) {
      try {
        necessaryPatterns.push({ kind: s.kind, re: new RegExp(s.name) });
      } catch {
        /* a bad KB pattern protects nothing */
      }
    }
    for (const s of p.stores) necessaryNames.add(`${s.kind}|${s.name}`);
  }
  for (const c of ev.siteWorkspace?.classifications ?? []) {
    if (c.kind === 'storage' && c.name && c.categories.length && c.categories.every((x) => x === 'necessary')) necessaryNames.add(`${c.storageKind}|${c.name}`);
  }
  const protectedName = (kind: string, name: string): boolean => necessaryNames.has(`${kind}|${name}`) || necessaryPatterns.some((x) => x.kind === kind && x.re.test(name));

  // A consent plugin fingerprinted on the platform (a WordPress plugin served from
  // the site's own domain is no outside party, so the inventory check below never
  // sees it). Shopify's Customer Privacy API is the platform's signal, not a tool to remove.
  const plugin = ev.platform?.consentPlugin;
  if (plugin && plugin !== 'shopify-customer-privacy' && !ev.inventory.some((p) => p.categories.includes('consent'))) {
    notes.push({ code: 'existing-consent-tool', level: 'flag', message: `The site runs a consent plugin (${plugin}, ${ev.platform!.name}). Deactivate it when installing this one: two banners, and two sources of truth for what the visitor chose. While it is active it also holds tags itself, so tools it held during the scan may be missing from this config — scan with an accept visit before generating.` });
  }

  // A vendor whose only loader is a stylesheet / @font-face (Google Fonts): the
  // script gate cannot hold it; self-hosting removes the request (#49).
  const STYLE_ONLY_NOTE = 'loaded by a stylesheet / font request, which the consent tool’s script gate cannot hold: self-host the fonts (or the stylesheet) to remove the request';
  const styleOnly = (p: { partyId: string; categories: string[] }): boolean => {
    const fs = (ev.markup?.findings ?? []).filter((f) => f.partyId === p.partyId && f.verdict !== 'hint');
    return p.categories.includes('fonts') || (fs.length > 0 && fs.every((f) => f.kind === 'link'));
  };

  // --- vendors ---
  const vendors: ConsentVendor[] = [];
  const managers: string[] = [];
  for (const p of ev.inventory) {
    const c = compat.get(p.partyId);
    if (p.categories.includes('tag-manager')) {
      managers.push(p.label);
      continue;
    }
    if (p.categories.includes('consent')) {
      notes.push({ code: 'existing-consent-tool', level: 'flag', partyIds: [p.partyId], message: `${p.label} (an existing consent tool) was seen on the site. Remove it when installing this one: two banners, and two sources of truth for what the visitor chose.` });
      continue;
    }
    const scope = c?.purpose ?? purposeScopeOf(p.categories);
    const e = entryOf(p.partyId);
    const vnotes: string[] = [];
    let category: string;
    if (scope === 'not-required') {
      category = NECESSARY_CATEGORY;
      if (p.behavesLikeTracker) {
        notes.push({
          code: 'necessary-behaves-like-tracker',
          level: 'flag',
          partyIds: [p.partyId],
          message: `${p.label} is listed as necessary (${p.categories.join(', ')}, per its knowledge-base entry) but behaved like a tracker in this scan (${p.trackerSignals.join(', ')}). Necessary tools are never held back: confirm its use is strictly necessary, or classify it in the workspace and regenerate.`,
        });
      }
    } else if (scope === 'context') {
      category = contextCategory(p.categories);
    } else {
      const g = gateCategory(p.categories);
      category = g.id;
      if (g.note) {
        const unclassified = scope === 'unclassified';
        notes.push({
          code: unclassified ? 'unclassified-strictest' : 'no-matching-category',
          level: 'flag',
          partyIds: [p.partyId],
          message: unclassified
            ? `${p.label} is not classified yet: held under the strictest category (advertising). Classify it in the site workspace and regenerate.`
            : `${p.label} (${p.categories.join(', ')}): no consent category matches its purpose, so it is held under the strictest category (advertising).`,
        });
        vnotes.push(unclassified ? 'not classified: strictest category' : 'no category matches its purpose: strictest category');
      }
    }

    let control: VendorControl;
    let adapter: string | undefined;
    const verdict = c?.verdict ?? 'unknown';
    const impl = c?.implementation ?? p.implementation?.class ?? 'unknown';
    // Google tag destinations GTM loads from a gtag('config') command in the page (B1, issue #48).
    const viaConfig = [...new Set((c?.changes ?? []).map((x) => x.destinationId).filter((x): x is string => !!x))];
    if (viaConfig.length && category !== NECESSARY_CATEGORY) {
      const located = (c?.changes ?? []).filter((x) => x.destinationId && x.kind === 'rewrite-tag' && x.page);
      notes.push({
        code: 'gtag-config-via-gtm',
        level: 'flag',
        partyIds: [p.partyId],
        message: `${p.label} (${viaConfig.join(', ')}): Google Tag Manager loads it itself because the page pushes gtag('config', …) into the dataLayer — no container tag carries it, so nothing in gtm.tags holds it. ${located.length ? `Rewrite the config snippet (${located.map((x) => `${shortPage(x.page!)}${x.line ? `:${x.line}` : ''}`).join(', ')}) as the snippet shows` : 'Find the gtag(\'config\') call (not located in the inspected HTML; see “Needs a look”) and hold it'}; holding the gtag.js loader alone does not stop it. Or move the config into GTM as a Google tag with a consent requirement.`,
      });
    }
    if (category === NECESSARY_CATEGORY) {
      control = 'none';
      vnotes.push('necessary: not held back');
    } else if (verdict === 'platform') {
      if (platform !== 'none') {
        control = 'platform';
        vnotes.push(`injected by the platform: reached through its consent API (${platform} bridge)`);
      } else {
        control = 'none';
        vnotes.push('injected by a platform this build has no bridge for');
        notes.push({ code: 'platform-unsupported', level: 'flag', partyIds: [p.partyId], message: `${p.label} is injected by a platform (${ev.platform?.name ?? 'not identified'}) the consent tool has no bridge for: it is not controlled.` });
      }
    } else if (impl === 'cname' || impl === 'server-side-suspected') {
      control = 'none';
      vnotes.push(impl === 'cname' ? 'first-party DNS alias: outside any consent tool’s reach' : 'server-side forwarding suspected: outside any consent tool’s reach');
    } else if (ADAPTER_FOR_KB[p.partyId]) {
      control = 'api';
      adapter = ADAPTER_FOR_KB[p.partyId];
      if (verdict === 'gateable') vnotes.push('gated once its tag is rewritten, and told through its consent API');
      else if (verdict === 'tag-manager') vnotes.push(viaConfig.length ? 'held once its gtag(\'config\') snippet is rewritten (GTM loads it from that command; no container tag to gate), and told through its consent API' : 'held by the tag manager’s consent settings (gtm.tags), and told through its consent API');
      else vnotes.push(`told through its consent API, but nothing holds its load until the change list’s items for it are done (${verdict === 'unknown' ? 'loader not identified' : 'markup leak'})`);
    } else if (verdict === 'gateable') {
      control = 'gate';
      vnotes.push('gated once its tag is rewritten (see the snippet)');
    } else if (verdict === 'tag-manager') {
      control = 'gate';
      vnotes.push(viaConfig.length ? 'held once its gtag(\'config\') snippet is rewritten (GTM loads it from that command; no container tag to gate)' : 'held by the tag manager’s consent settings (gtm.tags)');
    } else {
      control = 'none';
      vnotes.push(styleOnly(p) ? STYLE_ONLY_NOTE : verdict === 'unknown' ? 'loader not identified: not controlled' : 'markup leak: not controlled until removed');
    }
    if (control === 'none' && category !== NECESSARY_CATEGORY) {
      notes.push(
        verdict === 'unknown'
          ? { code: 'loader-not-identified', level: 'flag', partyIds: [p.partyId], message: `${p.label}: how it gets onto the page was not established, so the config cannot hold it back. See “Needs a look” in the change list.` }
          : { code: 'not-controlled', level: 'flag', partyIds: [p.partyId], message: `${p.label}: listed under ${category} but not controlled (${vnotes[vnotes.length - 1]}). See the change list.` },
      );
    } else if (control === 'api' && verdict === 'unknown') {
      notes.push({ code: 'loader-not-identified', level: 'flag', partyIds: [p.partyId], message: `${p.label}: its loader was not identified. The tool tells it the choice through its consent API once it loads, but nothing holds its load. See “Needs a look” in the change list.` });
    }
    vendors.push({
      id: p.partyId,
      label: p.label,
      category,
      control,
      ...(adapter ? { adapter } : {}),
      stores: category === NECESSARY_CATEGORY ? [] : storesOf(p, e, protectedName),
      ...(vnotes.length ? { note: vnotes.join('; ') } : {}),
    });
  }
  if (managers.length) {
    notes.push({ code: 'tag-manager-not-vendor', level: 'info', message: `${managers.join(', ')}: not listed as a vendor — a tag manager loads the others. Google Tag Manager is reached through the config's gtm section; the tags it fires are listed there.` });
  }

  // Defense in depth: whatever happened above, no known tracker leaves as necessary.
  for (const v of vendors) {
    if (v.category !== NECESSARY_CATEGORY) continue;
    const p = ev.inventory.find((x) => x.partyId === v.id)!;
    const why = knownTrackerReason(p, kb);
    if (why) throw new Error(`refusing to generate: ${v.label} would be necessary, but ${why}`);
  }
  const vendorIds = new Set(vendors.map((v) => v.id));
  const used = new Set<string>(vendors.map((v) => v.category));

  // --- rewrites and gate rules (from the change list's own items) ---
  const findings = ev.markup?.findings ?? [];
  const rewrites: SnippetRewrite[] = [];
  const gate: GateRule[] = [];
  const rewriteItems: Array<{ item: ChangeItem; optional: boolean }> = [
    ...(report.groups.find((g) => g.id === 'rewrite')?.items ?? []).map((item) => ({ item, optional: false })),
    ...report.otherChanges.filter((i) => i.kind === 'rewrite-tag').map((item) => ({ item, optional: true })),
  ];
  for (const { item, optional } of rewriteItems) {
    const category = item.category ?? 'advertising';
    used.add(category);
    const atLine = (x: (typeof findings)[number]): boolean => x.verdict === 'gateable' && x.page === item.page && x.line === item.line;
    const f = findings.find((x) => item.partyIds.includes(x.partyId) && atLine(x)) ?? findings.find(atLine);
    // A data: URL tag has a src, but no URL a gate rule could match (and its payload is not in the record).
    const isData = Boolean(f?.dataUrl);
    const src = isData ? undefined : (f?.attributes.src ?? (f?.inline ? undefined : item.url));
    const inline = !src && !isData;
    const flags: string[] = [...(item.notes ?? [])];
    if (isData) notes.push({ code: 'data-url-tag', level: 'flag', partyIds: item.partyIds, message: `${item.tools.join(', ')} (${shortPage(item.page ?? '')}${item.line ? `:${item.line}` : ''}): the tag's code is a data: URL, usually written by a performance plugin from an inline snippet. Make the change in the source (or exclude it from the plugin's inline-JavaScript option) and check the served HTML after.` });
    if (f?.optimizer) notes.push({ code: 'optimizer-delay', level: 'flag', partyIds: item.partyIds, message: `${item.tools.join(', ')} (${shortPage(item.page ?? '')}${item.line ? `:${item.line}` : ''}): ${f.optimizer} delays this tag and runs it for every visitor — not consent gating. Exclude it from the plugin's delay list and rewrite the source tag.` });
    if (f?.attributes.id) {
      flags.push(
        `It has id="${f.attributes.id}". On release the consent tool moves the id to the working copy it inserts (the held original keeps no id), so code that looks the tag up by id — the vendor's loader reading its own src, or yours — finds the working copy. Before the visitor agrees, getElementById() returns the held original (no src, type text/plain): code that runs earlier must not depend on it.`,
      );
      notes.push({ code: 'duplicate-id', level: 'flag', partyIds: item.partyIds, message: `${item.tools.join(', ')} (${shortPage(item.page ?? '')}${item.line ? `:${item.line}` : ''}): the tag has id="${f.attributes.id}" — the id moves to the working copy on release; see the snippet's note.` });
    }
    const sync = !inline && f && !f.optimizer && !('async' in f.attributes) && !('defer' in f.attributes) && f.attributes.type !== 'module';
    // The served HTML's own body (A1: read from the whole inline body, kept through redaction), or the matched text.
    const writes = f?.documentWrite === true || /document\.write/.test(f?.match ?? '');
    if (writes || sync) {
      flags.push(
        writes
          ? 'Its code calls document.write. A released script runs after the page is parsed, where document.write is ignored or replaces the whole page: this tag cannot be gated as written. Ask the vendor for an async snippet, or leave it out and record the decision.'
          : 'It loads synchronously (no async/defer). A released copy runs asynchronously; if its code uses document.write (some older ad and widget tags do), that write is ignored and the tag silently does nothing. Check the vendor’s snippet, and test after the change.',
      );
      notes.push({ code: 'document-write', level: 'flag', partyIds: item.partyIds, message: `${item.tools.join(', ')}: ${writes ? 'calls document.write — not gateable asynchronously' : 'a synchronous script: if it uses document.write it will not work once gated (test it)'}.` });
    }
    if (inline) {
      notes.push({ code: 'inline-rewrite', level: 'info', partyIds: item.partyIds, message: `${item.tools.join(', ')}: an inline script — edit the existing tag in place (add type="text/plain" data-category="${category}"); the scan does not carry its code.` });
    }
    if (item.partyIds.some((id) => ev.inventory.find((p) => p.partyId === id)?.categories.includes('tag-manager'))) {
      const why = item.categoryNote ?? 'the strictest category of what it loads';
      notes.push(
        /\/gtm\.js\b/.test(src ?? '') || ((inline || isData) && /GTM-[A-Z0-9]+|gtm\.js/.test(`${f?.match ?? ''} ${(f?.ids ?? []).join(' ')}`))
          ? {
              code: 'gtm-loader-gated',
              level: 'flag',
              partyIds: item.partyIds,
              message: `The change list rewrites the Google Tag Manager loader (${shortPage(item.page ?? '')}${item.line ? `:${item.line}` : ''}) under “${category}” (${why}): every tag in the container then waits for that category. With the gtm section's per-tag consent settings in place the loader can stay ungated instead — the tool sets the Consent Mode defaults before it loads. Choose one; do not leave both half-done.`,
            }
          : {
              code: 'gtm-loader-gated',
              level: 'info',
              partyIds: item.partyIds,
              message: `The change list rewrites a ${src && !isData ? 'gtag.js loader' : 'tag-manager snippet'} (${shortPage(item.page ?? '')}${item.line ? `:${item.line}` : ''}) under “${category}” (${why}): the Google tags it loads run only after that category is granted — stricter than Consent Mode alone, which still sends cookieless pings.`,
            },
      );
    }
    rewrites.push({ id: item.id, tools: item.tools, partyIds: item.partyIds, category, ...(item.page ? { page: item.page } : {}), ...(item.line !== undefined ? { line: item.line } : {}), ...(item.before ? { before: item.before } : {}), ...(item.after ? { after: item.after } : {}), inline, optional, flags });
    if (src) {
      const rule = srcRule(src);
      const vendor = item.partyIds.find((id) => vendorIds.has(id));
      if (rule && !gate.some((g) => g.src === rule && g.category === category)) gate.push({ category, src: rule, ...(vendor ? { vendor } : {}) });
    }
  }

  // Tags in the served HTML for tools the scan never saw running: not in the
  // inventory, so not in the change list or the config. Listed, never dropped.
  const inInventory = new Set(ev.inventory.map((p) => p.partyId));
  const dormant = new Map<string, string[]>();
  for (const f of findings) {
    if (inInventory.has(f.partyId) || f.verdict === 'hint' || f.verdict === 'held') continue;
    const list = dormant.get(f.label) ?? [];
    list.push(`${shortPage(f.page)}:${f.line} ${f.verdict === 'leak' ? `<${f.kind}>${f.context === 'noscript' ? ' in <noscript>' : ''}` : f.inline ? 'inline <script>' : '<script>'}`);
    dormant.set(f.label, list);
  }
  if (dormant.size) {
    notes.push({
      code: 'dormant-tags',
      level: 'flag',
      message: `Tags in the HTML for tools that did not run during the scan: ${[...dormant].map(([label, at]) => `${label} (${at.slice(0, 3).join(', ')}${at.length > 3 ? ', …' : ''})`).join('; ')}. They are not in the config or the change list. If they can run for other visitors or pages, rewrite (or remove) them and regenerate.`,
    });
  }

  // --- GTM ---
  const containers = ev.containers ?? [];
  const gtmIds = new Set<string>();
  for (const c of containers) if (c.kind === 'gtm' && GTM_ID.test(c.id)) gtmIds.add(c.id);
  for (const p of ev.inventory) {
    for (const e of p.implementation?.evidence ?? []) {
      const id = e.containerId ?? /[?&]id=(GTM-[A-Z0-9]+)/i.exec(e.url ?? '')?.[1];
      if (id && GTM_ID.test(id)) gtmIds.add(id);
    }
  }
  for (const c of containers) {
    if (c.status !== 'parsed' && (c.kind === 'gtm' || GTM_ID.test(c.id))) {
      notes.push({ code: 'container-not-read', level: 'flag', message: `Container ${c.id} could not be read (${c.status}${c.reason ? `: ${c.reason}` : ''}): which of its tags need a consent requirement is unknown, so none of them is listed. Fix the fetch and regenerate.` });
    }
  }
  const gtag = containers.filter((c) => c.kind === 'gtag').map((c) => c.id);
  if (gtag.length) {
    notes.push({ code: 'gtag-destinations', level: 'info', message: `Google tag (gtag.js) destinations ${gtag.join(', ')}: not GTM containers. Google's tags read Consent Mode, which the tool sets (the google-consent-mode adapter${gtmIds.size ? ' and the GTM bridge' : ''}).` });
  }
  let gtm: GtmConfig | undefined;
  if (gtmIds.size) {
    const tags: GtmConfig['tags'] = [];
    const seen = new Set<string>();
    const vendorOf = new Map(vendors.map((v) => [v.id, v]));
    const categoryForParty = (partyId: string | undefined): string => {
      if (partyId && vendorOf.has(partyId)) return vendorOf.get(partyId)!.category;
      const e = partyId ? entryOf(partyId) : undefined;
      if (!e) return 'advertising';
      const scope = purposeScopeOf(e.categories);
      return scope === 'context' ? contextCategory(e.categories) : gateCategory(e.categories).id;
    };
    const addTag = (containerId: string, t: { tagId: number; templateLabel: string; partyId?: string }): void => {
      const key = `${containerId}|${t.tagId}`;
      if (seen.has(key)) return;
      const category = categoryForParty(t.partyId);
      if (category === NECESSARY_CATEGORY) return;
      seen.add(key);
      used.add(category);
      tags.push({ name: `${containerId} tag ${t.tagId} (${t.templateLabel})`, category, ...(t.partyId && vendorIds.has(t.partyId) ? { vendor: t.partyId } : {}) });
    };
    const parsed = containers.filter((c) => c.status === 'parsed' && gtmIds.has(c.id));
    // The change list's GTM items: each tag it names; a party-level item names every tag of that party.
    for (const item of report.groups.find((g) => g.id === 'gtm')?.items ?? []) {
      if (item.containerId && !gtmIds.has(item.containerId)) continue;
      for (const c of parsed) {
        if (item.containerId && c.id !== item.containerId) continue;
        for (const t of c.tags) {
          if (t.kind !== 'tag' || t.paused) continue;
          if (item.tagId !== undefined ? t.tagId === item.tagId : t.partyId !== undefined && item.partyIds.includes(t.partyId)) addTag(c.id, t);
        }
      }
    }
    for (const item of report.otherChanges.filter((i) => i.kind === 'gate-gtm-tag')) {
      for (const c of parsed) {
        if (item.containerId && c.id !== item.containerId) continue;
        for (const t of c.tags) if (t.kind === 'tag' && !t.paused && (item.tagId !== undefined ? t.tagId === item.tagId : t.partyId !== undefined && item.partyIds.includes(t.partyId))) addTag(c.id, t);
      }
    }
    // Tags no table could map to a vendor: fail closed — they must carry a requirement too.
    const unmapped: string[] = [];
    for (const c of parsed) {
      for (const t of c.tags) {
        if (t.kind !== 'tag' || t.paused || t.partyId || t.consent.status === 'required') continue;
        unmapped.push(`${c.id} tag ${t.tagId}`);
        addTag(c.id, t);
      }
    }
    if (unmapped.length) {
      notes.push({ code: 'unmapped-gtm-tags', level: 'flag', message: `${unmapped.length} GTM tag${unmapped.length === 1 ? '' : 's'} could not be matched to a vendor (${unmapped.slice(0, 6).join(', ')}${unmapped.length > 6 ? ', …' : ''}): listed under advertising, the strictest category. Open each in GTM; if it is necessary (e.g. a consent or site-function tag), remove it from gtm.tags.` });
    }
    const consentMode: GtmConfig['consentMode'] = { security_storage: NECESSARY_CATEGORY };
    if (used.has('advertising')) Object.assign(consentMode, { ad_storage: 'advertising', ad_user_data: 'advertising', ad_personalization: 'advertising' });
    if (used.has('analytics')) consentMode.analytics_storage = 'analytics';
    if (used.has('functional')) Object.assign(consentMode, { functionality_storage: 'functional', personalization_storage: 'functional' });
    gtm = { containers: [...gtmIds].sort(), dataLayer: 'dataLayer', consentMode, tags };
  }

  // --- 'gate' must name something that holds it (#49) ---
  // A vendor is 'gate' only if the change list rewrites one of its tags (the
  // snippet's gate rule or an inline rewrite), the gtm section lists one of its
  // tags, or (loaded through a tag manager) the tag-manager loader itself is
  // rewritten. A vendor reached only through a stylesheet / @font-face (Google
  // Fonts) or a tag no table maps to it has none of these: it is 'none', and
  // the note says what removes the request.
  const managerLoaderGated = rewrites.some((r) => r.partyIds.some((id) => ev.inventory.find((p) => p.partyId === id)?.categories.includes('tag-manager')));
  for (const v of vendors) {
    if (v.control !== 'gate') continue;
    const verdict = compat.get(v.id)?.verdict;
    const held = rewrites.some((r) => r.partyIds.includes(v.id)) || (gtm?.tags.some((t) => t.vendor === v.id) ?? false) || (verdict === 'tag-manager' && managerLoaderGated);
    if (held) continue;
    const p = ev.inventory.find((x) => x.partyId === v.id)!;
    const why = styleOnly(p)
      ? STYLE_ONLY_NOTE
      : 'no tag the change list rewrites and no GTM tag maps to it, so nothing in the config holds it: remove it, or find its loader and regenerate';
    v.control = 'none';
    v.note = why;
    notes.push({ code: 'not-controlled', level: 'flag', partyIds: [v.id], message: `${v.label}: listed under ${v.category} but not controlled (${why}).` });
  }

  // --- the rest ---
  const categories = GENERATED_CATEGORY_ORDER.filter((id) => id === NECESSARY_CATEGORY || used.has(id)).map((id) => ({
    id,
    ...CATEGORY_TEXT[id],
    defaultByRegime: { ...(DEFAULTS[id] ?? NON_NECESSARY_DEFAULT) },
  }));
  const ORDER = new Map<string, number>(GENERATED_CATEGORY_ORDER.map((id, i) => [id, i]));
  vendors.sort((a, b) => (ORDER.get(a.category) ?? 99) - (ORDER.get(b.category) ?? 99) || a.label.localeCompare(b.label) || a.id.localeCompare(b.id));

  let regimeSource: RegimeSource;
  if (opts.regimeSource) regimeSource = opts.regimeSource;
  else if (platform === 'shopify') {
    regimeSource = { kind: 'platform' };
    notes.push({ code: 'regime-source', level: 'info', message: 'Visitor location: from Shopify (customerPrivacy.getRegion()). Where Shopify does not report a region, the visitor is treated as opt-in.' });
  } else {
    regimeSource = { kind: 'meta', name: 'complykit-region' };
    notes.push({
      code: 'regime-source',
      level: 'flag',
      message: 'Visitor location: the config reads <meta name="complykit-region" content="CC-RR">, which your server or CDN must write into every page (recipes: /guide/location). Until it does, every visitor is treated as opt-in — the strictest posture — which is safe but asks US visitors for consent too.',
    });
  }
  const scriptSrc = opts.scriptSrc ?? DEFAULT_SCRIPT_SRC;
  if (!opts.scriptSrc) {
    notes.push({ code: 'script-path', level: 'info', message: `The snippet loads the tool from ${scriptSrc} — a placeholder. Self-host complykit-consent.js and complykit-consent-ui.js in one folder and adjust the path; a third-party CDN URL means a request before consent.` });
  }

  const input: Omit<ConsentToolConfigInput, 'hash'> = {
    version: CONSENT_CONFIG_VERSION,
    generatedFrom: { runId: ev.runId, at, site: ev.site.registrableDomain.toLowerCase(), complykit: opts.complykitVersion, kb: ev.versions.kb },
    regimeSource,
    categories,
    vendors,
    gate,
    ...(gtm ? { gtm } : {}),
    platform,
    theme: opts.theme ?? {},
    strings: {},
    consent: { lifetimeDays: opts.lifetimeDays ?? 365 },
    ...(opts.privacyPolicyUrl ? { privacyPolicyUrl: opts.privacyPolicyUrl } : {}),
    ...(opts.recordEndpoint ? { record: { endpoint: opts.recordEndpoint } } : {}),
    layout: opts.layout ?? 'bar',
  };
  const config = withConsentConfigHash(input);
  const json = JSON.stringify(config, null, 2) + '\n';
  // What the tool will read must parse and verify — or nothing is emitted.
  const check = parseConsentToolConfig(JSON.parse(json));
  if (!check.ok) throw new Error(`generated config does not validate: ${check.issues.map((i) => `${i.path}: ${i.message}`).join('; ')}`);
  if (!check.hashMatches) throw new Error('generated config hash does not verify');

  const order: Record<GeneratorNote['level'], number> = { refused: 0, flag: 1, info: 2 };
  notes.sort((a, b) => order[a.level] - order[b.level]);
  const snippet = renderSnippet(config, rewrites, { scriptSrc, explicitSrc: Boolean(opts.scriptSrc) });
  const tasks = buildRemediationTasks({ config, notes, compatibility: report, scriptSrc }, ev, { workspace: opts.workspace, kb });
  return { config, json, snippet, changeList, rewrites, notes, notesMarkdown: renderGeneratorNotes(config, notes, report), scriptSrc, compatibility: report, tasks };
}

// --- rendering ------------------------------------------------------------------------

/** Text safe inside an HTML comment. */
const commentSafe = (s: string): string => s.replace(/--/g, '- -');
const indent = (s: string, pad: string): string => s.split('\n').map((l) => pad + l).join('\n');

export function renderSnippet(config: ConsentToolConfig, rewrites: SnippetRewrite[], opts: { scriptSrc: string; explicitSrc?: boolean }): string {
  const out: string[] = [];
  out.push(
    `<!-- complykit consent tool — generated ${config.generatedFrom.at} for ${config.generatedFrom.site} from run ${config.generatedFrom.runId} (complykit ${config.generatedFrom.complykit}).`,
    '     Part 1: paste once, as high in <head> as possible — above the Google Tag Manager snippet and above every tag in Part 2.',
    opts.explicitSrc
      ? `     The tool loads from ${commentSafe(opts.scriptSrc)}; complykit-consent-ui.js must sit in the same folder.`
      : `     ${commentSafe(opts.scriptSrc)} is a PLACEHOLDER: self-host complykit-consent.js and complykit-consent-ui.js in one folder and change the path.`,
    '     Editing the config by hand invalidates its hash; the rescan reports it. Regenerate instead. -->',
    renderHeadSnippet(config, opts.scriptSrc),
  );
  const required = rewrites.filter((r) => !r.optional);
  const optional = rewrites.filter((r) => r.optional);
  const block = (list: SnippetRewrite[], start: number): void => {
    list.forEach((r, i) => {
      const where = r.page ? `${shortPage(r.page)}${r.line ? `:${r.line}` : ''}` : 'location not recorded';
      out.push('', `<!-- ${start + i}. ${commentSafe(r.tools.join(', '))} — ${commentSafe(where)} — category "${r.category}"`);
      if (r.before) out.push('     Now:', indent(commentSafe(r.before), '       '));
      for (const f of r.flags) out.push(`     NOTE: ${commentSafe(f)}`);
      if (r.inline) {
        out.push(`     Edit that inline <script> in place: add type="text/plain" data-category="${r.category}" and keep its code unchanged:`);
        if (r.after) out.push(indent(commentSafe(r.after), '       '));
        out.push('-->');
      } else {
        out.push('     Becomes: -->', r.after ?? '');
      }
    });
  };
  if (rewrites.length) {
    out.push(
      '',
      '<!-- Part 2: tag rewrites. Do NOT paste this part as a block: replace each tag where it is now (the "Now" markup) with the "Becomes" markup.',
      '     A type="text/plain" script is not run by the browser; the tool inserts a working copy once the visitor agrees to its category.',
      '     Leaving the original in place AND adding the rewrite loads the tag twice after consent. -->',
    );
    block(required, 1);
    if (optional.length) {
      out.push('', '<!-- Optional rewrites: chat, embeds, fonts and similar tools. Under opt-in rules they need consent unless strictly needed for a feature the visitor uses. -->');
      block(optional, required.length + 1);
    }
  } else {
    out.push('', '<!-- Part 2: no tag in the inspected HTML needs a rewrite. The change list says what else to change. -->');
  }
  return out.join('\n') + '\n';
}

export function renderGeneratorNotes(config: ConsentToolConfig, notes: GeneratorNote[], report?: CompatibilityReport): string {
  const out: string[] = [];
  out.push(`# Consent tool config — ${config.generatedFrom.site}`, '');
  out.push(`Generated ${config.generatedFrom.at} from run ${config.generatedFrom.runId} (complykit ${config.generatedFrom.complykit}, knowledge base ${config.generatedFrom.kb ?? 'not recorded'}).`, '');
  if (report) out.push(report.scope, '');
  out.push('## What the config contains', '');
  for (const c of config.categories) {
    const vs = config.vendors.filter((v) => v.category === c.id);
    out.push(`- **${c.label}** (\`${c.id}\`): ${vs.length ? vs.map((v) => `${v.label} [${v.control}${v.adapter ? `: ${v.adapter}` : ''}]`).join(', ') : 'no vendor (used by GTM tags or rewrites)'}`);
  }
  out.push(`- Gate rules: ${config.gate.length}`);
  out.push(config.gtm ? `- GTM: ${config.gtm.containers.join(', ')} — ${config.gtm.tags.length} tag${config.gtm.tags.length === 1 ? '' : 's'} that must carry a consent requirement` : '- GTM: no container seen');
  out.push(`- Platform bridge: ${config.platform}`, `- Visitor location: ${config.regimeSource.kind}`, '');
  const section = (level: GeneratorNote['level'], title: string): void => {
    const list = notes.filter((n) => n.level === level);
    if (!list.length) return;
    out.push(`## ${title}`, '');
    for (const n of list) out.push(`- ${n.message}`);
    out.push('');
  };
  section('refused', 'Refused');
  section('flag', 'Check before deploying');
  section('info', 'How it was decided');
  out.push('This config describes what the scan saw — not a verdict on the site. The rescan after deployment is what shows whether tools are held back.');
  return out.join('\n') + '\n';
}
