import {
  CONSENT_CONFIG_ELEMENT_ID,
  INSTALL_TASK_ID,
  changeId,
  resolveRemediationTaskValue,
  type ConsentToolConfig,
  type MarkupFinding,
  type RemediationTask,
  type RemediationVerifySpec,
  type TrackingEvaluation,
} from './record/index.js';
import { consentPluginPathPattern, DEFAULT_KB, type KnowledgeBase } from './registry/index.js';
import { buildConsentReportModel, DOCS_BASE, GTM_GUIDE, platformGuide, shortPage, type ChangeItem, type CompatibilityReport } from './report/index.js';
import { reconcileRecord } from './consent-compatibility.js';
import { toolConsentDefault } from './rules/remediation/verify.js';
import { classificationKey, type WorkspaceSnapshot } from './site-workspace.js';

// The guided remediation checklist (plans/remediation-flow.md §3): the
// generator's change list turned into tasks a non-developer can follow and a
// Verify button can check one at a time. Pure over the generator output, the
// evaluation and (optionally) the site workspace, which carries each task's
// status under `task:change:<id>`.
//
// One list: the decisions (what an unrecognized tool is for — 'classify') and
// the changes, in the order an owner does them. See "Folding and order" below —
// decisions first (each one decides whether the changes waiting on it apply,
// and what the generated config — so the install snippet — says), then the
// install (everything else depends on the tool being first in <head>), the old
// banner out, then the tags, leaks, GTM, platform and defaults; a behavior
// mismatch or vendor call that another task already fixes is folded into that
// task, not listed again. A change whose tools are all unclassified names the
// decision it waits on (`waitingOn`) instead of a "classify first" of its own.
//
// Verify method per kind (what a single fetch can and cannot prove):
//   static   install, rewrite-tag, remove-leak, set-consent-default (Google),
//            gate-gtm-tag (the published container), remove-existing-tool
//   browser  behavior-mismatch, use-platform-api, call-consent-api,
//            configure-tag-manager, set-consent-default for a vendor API,
//            confirm-in-browser — markup says nothing about these; one page,
//            reject then accept
//   manual   change-dns, accepted-exposure, needs-a-look, and any item whose
//            element the scan could not locate
//   (none)   classify — a decision, not a change: done when the site workspace
//            holds a purpose for the tool (resolveRemediationTaskValue)

/** The config in the generated head snippet, escaped so no "<" survives (neither "</script" nor "<!--" can appear). */
export function scriptJson(value: unknown): string {
  return JSON.stringify(value).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
}

const attrEsc = (v: string): string => v.replace(/&/g, '&amp;').replace(/"/g, '&quot;');

/** Part 1 of the snippet: the two elements that go first in <head>. */
export function renderHeadSnippet(config: ConsentToolConfig, scriptSrc: string): string {
  return `<script type="application/json" id="${CONSENT_CONFIG_ELEMENT_ID}">${scriptJson(config)}</script>\n<script src="${attrEsc(scriptSrc)}"></script>`;
}

/** A generator note as the task builder reads it (GeneratorNote is a superset). */
export interface RemediationSourceNote {
  code: string;
  message: string;
  partyIds?: string[];
}

/** What buildRemediationTasks reads from the generator output (GeneratedConsentConfig qualifies, and so does a stored workspace `config.value`). Structural on purpose: this module must not import the generator (the generator imports it). */
export interface RemediationSource {
  config: ConsentToolConfig;
  notes?: RemediationSourceNote[];
  compatibility?: CompatibilityReport;
  scriptSrc?: string;
  snippet?: string;
}

export interface BuildRemediationTasksOptions {
  /** The site workspace: task status under task:change:<id>. */
  workspace?: WorkspaceSnapshot;
  kb?: KnowledgeBase;
}

const INSTALL_GUIDE = `${DOCS_BASE}consent-tool`;
const CONFIG_GUIDE = `${DOCS_BASE}config`;
const VENDOR_GUIDE = `${DOCS_BASE}vendor-control`;

function scriptSrcOf(g: RemediationSource): string {
  if (g.scriptSrc) return g.scriptSrc;
  const m = g.snippet ? /<script src="([^"]+)"><\/script>/.exec(g.snippet) : null;
  return m ? m[1].replace(/&quot;/g, '"').replace(/&amp;/g, '&') : '/complykit/v1/complykit-consent.js';
}

const folderOf = (src: string): string => src.replace(/[^/]*$/, '') || '/';

function reportOf(g: RemediationSource, ev: TrackingEvaluation, kb: KnowledgeBase, workspace?: WorkspaceSnapshot): CompatibilityReport {
  if (g.compatibility) return g.compatibility;
  const copy: TrackingEvaluation = structuredClone(ev);
  reconcileRecord(copy, { kb, workspace });
  const model = buildConsentReportModel(copy, []);
  if (!model.compatibility) throw new Error('unreachable: the report model has no compatibility section');
  return model.compatibility;
}

const list = (xs: string[]): string => xs.join(', ');

function hostsOf(ev: TrackingEvaluation, partyIds: string[]): string[] {
  const out = new Set<string>();
  for (const id of partyIds) for (const h of ev.inventory.find((p) => p.partyId === id)?.hosts ?? []) out.add(h.toLowerCase());
  return [...out].sort();
}

function findingAt(ev: TrackingEvaluation, it: ChangeItem): MarkupFinding | undefined {
  if (!it.page) return undefined;
  const fs = ev.markup?.findings ?? [];
  return fs.find((f) => it.partyIds.includes(f.partyId) && f.page === it.page && f.line === it.line) ?? fs.find((f) => f.page === it.page && f.line === it.line);
}

function pagesOf(ev: TrackingEvaluation, it: ChangeItem): string[] {
  const f = findingAt(ev, it);
  const out = [...(it.page ? [it.page] : []), ...(f?.alsoOn ?? [])];
  return out.length ? [...new Set(out)] : [ev.site.url];
}

const manual = (reason: string): RemediationVerifySpec => ({ check: 'manual', method: 'manual', reason });

function spotCheck(ev: TrackingEvaluation, it: ChangeItem, page: string): RemediationVerifySpec {
  const hosts = hostsOf(ev, it.partyIds);
  if (!hosts.length) return manual(`no host was recorded for ${list(it.tools)}, so a spot check has nothing to watch for; a rescan decides it`);
  return { check: 'spot-check', method: 'browser', page, partyId: it.partyIds[0], hosts, scenario: 'reject-then-accept' };
}

const cap = (s: string): string => (s ? s[0].toUpperCase() + s.slice(1) : s);

/** A page as an owner reads it: "the home page", else its path. */
const pageLabel = (p: string): string => {
  const s = shortPage(p);
  return s === '/' ? 'the home page' : s;
};

const PUBLISH_VERIFY_PAGE = 'Publish the change, then press Verify: it loads the page and checks the change is there.';
const spotCheckStep = (tools: string, page: string): string =>
  `Press Verify: it opens ${pageLabel(page)} twice in a browser — once refusing, once accepting. It passes when nothing reaches ${tools} after refusing and something does after accepting.`;

interface Shaped {
  title: string;
  summary: string;
  steps: string[];
  verify: RemediationVerifySpec;
  /** Drop the item's markup (a snippet that is not needed: the tool sets it). */
  noSnippet?: boolean;
}

function shape(ev: TrackingEvaluation, it: ChangeItem, pages: string[], config: ConsentToolConfig): Shaped {
  const page = pages[0];
  const tools = list(it.tools);
  const cat = it.category ?? 'advertising';
  const more = pages.length > 1 ? ` (it is also on ${pages.length - 1} other page${pages.length === 2 ? '' : 's'} — usually one shared template)` : '';
  const where = it.line ? ` (line ${it.line} of the page’s HTML)` : '';
  switch (it.kind) {
    case 'behavior-mismatch':
      // Only reached when no other task fixes this tool (otherwise it is folded into those tasks).
      return {
        title: `Find out why ${tools} runs before consent`,
        summary: 'The scan saw it send data or store something where it should wait for the visitor’s choice, and nothing else on this list fixes it yet.',
        steps: [
          `Find what loads ${tools}: the theme, a plugin, an app, or a tag manager.`,
          'Make it wait for consent there (the install guide shows how for each), and publish.',
          spotCheckStep(tools, page),
        ],
        verify: spotCheck(ev, it, page),
      };
    case 'rewrite-tag':
      return {
        // "Google Tag Manager / gtag.js tag" reads twice: say script when the name already says tag.
        title: `Hold the ${tools} ${/\btag\b|gtag/i.test(tools) ? 'script' : 'tag'} until consent`,
        summary: `Change this tag so the browser skips it; the consent tool runs it once the visitor agrees to “${cat}”.`,
        steps: [
          `Open the template that outputs ${pageLabel(page)}${more} and find this tag${where}. It looks like “What it looks like now” below.`,
          `Replace it with the markup below. Only this changes: type="text/plain" and data-category="${cat}" are added${it.url ? ', and src becomes data-src' : ''}.`,
          'Delete the original tag. If both stay, the tag runs twice once the visitor agrees.',
          PUBLISH_VERIFY_PAGE,
        ],
        verify: it.signature ? { check: 'rewrite-tag', method: 'static', page, element: it.signature, category: cat } : manual('the tag was not located in the inspected HTML, so there is no element signature to look for; a rescan decides it'),
      };
    case 'remove-leak': {
      const noscript = /noscript/i.test(it.element ?? '') || it.signature?.context === 'noscript';
      const iframe = /iframe/i.test(it.element ?? '') || it.signature?.kind === 'iframe';
      return {
        title: noscript ? `Delete the ${tools} no-JavaScript fallback` : iframe ? `Remove or hold the ${tools}${/\bembed$/i.test(tools) ? '' : ' embed'}` : `Remove the ${tools} ${(it.element ?? 'element').replace(/[<>]/g, '')}`,
        summary: 'The browser loads this before any script runs, so no consent tool can hold it back.',
        steps: [
          `Open the template that outputs ${pageLabel(page)}${more} and find this element${where}${it.url ? `: ${it.url}` : ''}.`,
          noscript ? 'Delete it. It only runs for visitors with JavaScript turned off — exactly when no consent tool can ask them.' : 'Delete it.',
          ...(iframe ? ['To keep the embed for visitors who agree, write it as <iframe data-category="functional" data-src="…"> with no src: the consent tool fills in src after consent.'] : []),
          PUBLISH_VERIFY_PAGE,
        ],
        verify: it.signature ? { check: 'remove-leak', method: 'static', page, element: it.signature } : manual('the element was not located in the inspected HTML; a rescan decides it'),
      };
    }
    case 'gate-gtm-tag': {
      const types = it.consentTypes ?? [];
      const container = ev.containers?.find((c) => c.id === it.containerId);
      return {
        title: `Require consent for the ${tools} tag in Google Tag Manager`,
        summary: `In Google Tag Manager, set this tag to need ${list(types)}, then publish the container.`,
        steps: [
          `Open container ${it.containerId ?? ''} in Google Tag Manager, go to Tags, and open tag ${it.tagId ?? '(see the notes)'}${it.tagNote ? ` — now: ${it.tagNote}` : ''}.`,
          `Advanced Settings → Consent Settings → “Require additional consent for tag to fire” → add ${list(types)}.`,
          'Submit and publish the container.',
          'Press Verify: it loads the published container and reads the tag’s consent setting.',
        ],
        verify:
          it.tagId !== undefined && it.containerId
            ? { check: 'gtm-tag-consent', method: 'static', containerId: it.containerId, ...(container?.url ? { containerUrl: container.url } : {}), tagId: it.tagId, consentTypes: types }
            : manual('no tag id was identified in the container; find the tag that loads it in GTM, then rescan'),
      };
    }
    case 'set-consent-default': {
      const types = it.consentTypes ?? [];
      const google = types.length > 0 && !it.api;
      if (google) {
        const verify: RemediationVerifySpec = { check: 'consent-default', method: 'static', page, consentTypes: types };
        if (toolConsentDefault(config, types)) {
          return {
            title: 'Start Google’s consent signals as “denied”',
            summary: 'Nothing to paste — the complykit tool sets this; verify after installing.',
            steps: [
              `Nothing to paste — the complykit tool sets this: when it starts, before any Google tag, it sets ${list(types)} to “denied”.`,
              'Verify after installing: once the install task is published, press Verify. It loads the page and checks the default is set before the first Google tag.',
            ],
            verify,
            noSnippet: true,
          };
        }
        return {
          title: 'Start Google’s consent signals as “denied”',
          summary: 'Google treats a consent signal that was never set as “granted”. Paste the snippet below so every signal starts as “denied”.',
          steps: [
            `Paste the snippet below in <head>, above the Google Tag Manager / gtag.js snippet (it sets ${list(types)} to “denied”).`,
            'Publish, then press Verify: it loads the page and checks the default is set before the first Google tag.',
          ],
          verify,
        };
      }
      return {
        title: `Start ${tools} as “denied” until consent`,
        summary: it.note,
        steps: ['Nothing to paste once the install task is done: the complykit tool sets this vendor’s consent default when it starts.', spotCheckStep(tools, page)],
        verify: spotCheck(ev, it, page),
      };
    }
    case 'configure-tag-manager':
      return {
        title: `Require consent for ${tools} in ${it.manager ?? 'your tag manager'}`,
        summary: 'This scan cannot read that tag manager. Inside it, set each tag that loads the tool to wait for consent.',
        steps: [
          `In ${it.manager ?? 'the tag manager'}, find every tag that loads ${tools}.`,
          'Set each one to fire only after the visitor’s consent (the tag manager’s own consent setting), and publish.',
          spotCheckStep(tools, page),
        ],
        verify: spotCheck(ev, it, page),
      };
    case 'use-platform-api':
      return {
        title: `Turn on ${cap(it.platform ?? 'your platform')}’s consent setting for ${tools}`,
        summary: 'The platform adds these tools itself; the complykit tool passes the visitor’s choice on to the platform.',
        steps: [
          `Do the install task first (its config is set up for ${cap(it.platform ?? 'the platform')}).`,
          `In ${cap(it.platform ?? 'the platform')}, turn on its consent / privacy setting${it.api ? ` (${it.api})` : ''} as the guide shows, and publish.`,
          `${spotCheckStep(tools, page)} Data the platform sends from its own servers can’t be seen from a browser.`,
        ],
        verify: spotCheck(ev, it, page),
      };
    case 'call-consent-api':
      // Only reached when the config has no adapter for this vendor (otherwise it is folded into the install task).
      return {
        title: `Pass the visitor’s choice to ${tools}`,
        summary: `Alongside holding it back, ${tools} should be told the choice through its own consent call${it.api ? ` (${it.api})` : ''}.`,
        steps: [`A developer adds the call ${tools} documents for this, run whenever the visitor chooses (the notes say which call).`, spotCheckStep(tools, page)],
        verify: spotCheck(ev, it, page),
      };
    case 'change-dns':
      return {
        title: `Repoint the DNS alias ${it.host ?? ''}`.trim(),
        summary: `A subdomain of your site points at ${tools}${it.target ? ` (${it.target})` : ''}, so its cookies count as your own and no consent tool can remove them.`,
        steps: ['Remove or repoint the DNS record, or stop using the integration behind it.', 'Mark it done; a rescan shows whether the cookies are gone.'],
        verify: manual('DNS records and the cookies set through them cannot be read from one page fetch; a rescan decides it'),
      };
    case 'accepted-exposure':
      return {
        title: `Remove ${tools}`,
        summary: 'Nothing on the page can hold it back until the visitor accepts, so it has to go — or be replaced by an integration that can wait for consent.',
        steps: ['Make the other changes listed for it, where there are any.', 'If they do not hold it back: remove the integration, or replace it with one your consent tool can block.', 'Mark the task done; a rescan shows whether it is gone.'],
        verify: manual('the integration loads from outside the page; a rescan decides it'),
      };
    case 'needs-a-look':
      return {
        title: `Find what loads ${tools}`,
        summary: 'The scan could not tell how it gets onto the page, so it cannot say what to change yet.',
        steps: [it.hint ?? 'A developer finds the code that loads it (the theme, a plugin, an app, a tag manager).', 'Rescan: the next checklist names the exact change.'],
        verify: manual('the loader is not identified; a rescan after it is found lists the real change'),
      };
  }
}

function withStatus(task: Omit<RemediationTask, 'status' | 'lastVerify'>, ws: WorkspaceSnapshot | undefined): RemediationTask {
  const v = ws ? resolveRemediationTaskValue(task, ws.entries) : undefined;
  return { ...task, status: v?.status ?? 'todo', ...(v?.lastVerify ? { lastVerify: v.lastVerify } : {}) };
}

/** The install task: snippet first in <head>, blocking, above GTM; the two files self-hosted; verified against the latest config hash. */
export function installTask(config: ConsentToolConfig, scriptSrc: string, page: string): Omit<RemediationTask, 'status' | 'lastVerify'> {
  const folder = folderOf(scriptSrc);
  const upload = `Upload complykit-consent.js and complykit-consent-ui.js to one folder on your own site, ${folder} (the snippet loads ${scriptSrc}; it finds the second file next to it).`;
  const notCdn = 'Not a third-party CDN: that would send a request before consent.';
  return {
    id: INSTALL_TASK_ID,
    kind: 'install',
    group: 'install',
    title: 'Install the complykit consent tool',
    summary: 'Two files on your own site, plus the generated settings pasted first in <head>, above every other script.',
    tools: [],
    partyIds: [],
    steps: [
      `${upload} Both are in the install bundle. ${notCdn}`,
      'Paste the two lines below first in <head>, right after <meta charset>: above the Google Tag Manager snippet and above every other script.',
      'Keep the script blocking: no async, no defer, no type="module". If a speed plugin delays or combines JavaScript, exclude these two lines from it.',
      'Publish, then press Verify: it loads the page and checks the settings are the latest generated ones and the tool runs before any tag.',
    ],
    // One task, two surfaces: the service has the bundle button; a report file / the CLI has the folder the command writes.
    stepVariants: [
      {
        step: 0,
        service: `${upload} Get both with the Download install bundle (.zip) button below: the zip holds them under that same path, so upload its folder to your web root as it is. ${notCdn}`,
        offline: `${upload} Get both from the files “complykit consent-config <run-dir>” writes to <run-dir>/consent-config/ (under that same path), and upload that folder to your web root as it is. ${notCdn}`,
      },
    ],
    snippet: { after: renderHeadSnippet(config, scriptSrc) },
    pages: [page],
    verify: { check: 'install', method: 'static', page, configHash: config.hash, scriptSrc, elementId: CONSENT_CONFIG_ELEMENT_ID },
    optional: false,
    notes: ['Every other task assumes the tool is installed and first: holding tags, the Google Tag Manager bridge, the vendor signals and the platform bridges all live in it.'],
    guide: { label: 'Installing the consent tool', href: INSTALL_GUIDE },
    order: 0,
  };
}

/** Tasks for the generator's "existing consent tool" flags: an outside tool (a party) or a platform plugin. */
export function removeExistingToolTasks(ev: TrackingEvaluation, notes: RemediationSourceNote[], page: string): Array<Omit<RemediationTask, 'status' | 'lastVerify' | 'order'>> {
  const out: Array<Omit<RemediationTask, 'status' | 'lastVerify' | 'order'>> = [];
  for (const n of notes) {
    if (n.code !== 'existing-consent-tool') continue;
    if (n.partyIds?.length) {
      for (const id of n.partyIds) {
        const p = ev.inventory.find((x) => x.partyId === id);
        const label = p?.label ?? id;
        out.push({
          id: changeId({ kind: 'remove-existing-tool', partyId: id }),
          kind: 'remove-existing-tool',
          group: 'install',
          title: `Remove your old consent banner (${label})`,
          summary: 'Two banners means two different records of what the visitor chose. Take the old one out when the new tool goes in.',
          party: id,
          tools: [label],
          partyIds: [id],
          steps: [`Remove ${label} from the site: its script, plugin or app, and its settings.`, 'Do it in the same release as the install task, so the site is never without a banner and never has two.', 'Publish, then press Verify: it loads the page and checks nothing of the old banner loads.'],
          pages: [page],
          verify: { check: 'remove-existing-tool', method: 'static', page, partyId: id, hosts: (p?.hosts ?? []).map((h) => h.toLowerCase()), label },
          optional: false,
          notes: [n.message],
        });
      }
    } else {
      const plugin = ev.platform?.consentPlugin;
      if (!plugin) continue;
      const pattern = consentPluginPathPattern(plugin);
      out.push({
        id: changeId({ kind: 'remove-existing-tool', partyId: `plugin:${plugin}` }),
        kind: 'remove-existing-tool',
        group: 'install',
        title: `Turn off your old consent plugin (${plugin})`,
        summary: 'Two banners means two different records of what the visitor chose. Turn the old one off when the new tool goes in.',
        party: `plugin:${plugin}`,
        tools: [plugin],
        partyIds: [],
        steps: [`Deactivate the ${plugin} plugin${ev.platform?.name ? ` in ${cap(ev.platform.name)}` : ''}.`, 'Do it in the same release as the install task, so the site is never without a banner and never has two.', 'Publish, then press Verify: it loads the page and checks nothing of the plugin loads.'],
        pages: [page],
        verify: pattern ? { check: 'remove-existing-tool', method: 'static', page, hosts: [], pathPattern: pattern, label: plugin } : manual(`the ${plugin} plugin has no file-path fingerprint this build knows; a rescan decides it`),
        optional: false,
        notes: [n.message],
      });
    }
  }
  return out;
}

// --- Folding and order ---------------------------------------------------------------
//
// The change list explains; the checklist is what an owner does. Three kinds
// of change-list item are not separate work when another task already fixes
// the same tool, so they are folded into that task (its "This also fixes"
// line, its id kept in `aliases` so a status stored under it is still found):
//
//   behavior-mismatch    → every task that fixes the tool (rewrite, leak, GTM
//                          tag, tag manager, platform, vendor default, DNS,
//                          find-what-loads). With none, it stays — first.
//   call-consent-api     → the install task, when the config lists an adapter
//                          for the vendor (the tool makes the call). Without
//                          one, it stays.
//   accepted-exposure    → the leak / DNS task that removes the exposure.
//                          Without one, it stays (the owner's decision).
//
// A folded item was checked in a browser. Where none of the fixing tasks
// checks the tool itself (a static check, or a spot check of that tool), one
// "Confirm in the browser" task per tool keeps that check, near the end.
//
// Order: decisions (classify) → install → remove the old banner → (a mismatch nothing fixes) → tags
// to hold (by page, in document order) → leaks → GTM / tag manager →
// platform → consent defaults → vendor calls → DNS → find what loads →
// decisions → confirm in the browser → optional items (same order).

const RANK: Record<RemediationTask['kind'], number> = {
  classify: -1,
  install: 0,
  'remove-existing-tool': 1,
  'behavior-mismatch': 2,
  'rewrite-tag': 3,
  'remove-leak': 4,
  'gate-gtm-tag': 5,
  'configure-tag-manager': 5,
  'use-platform-api': 6,
  'set-consent-default': 7,
  'call-consent-api': 8,
  'change-dns': 9,
  'needs-a-look': 10,
  'accepted-exposure': 11,
  'confirm-in-browser': 12,
};

/** Kinds that fix a tool observed running where it should be off. */
const FIXES_BEHAVIOR = new Set<RemediationTask['kind']>(['rewrite-tag', 'remove-leak', 'gate-gtm-tag', 'configure-tag-manager', 'use-platform-api', 'set-consent-default', 'change-dns', 'needs-a-look']);
/** Kinds that remove an exposure no consent tool can hold. */
const REMOVES_EXPOSURE = new Set<RemediationTask['kind']>(['remove-leak', 'change-dns']);

type Draft = Omit<RemediationTask, 'status' | 'lastVerify' | 'order'> & { aliases: string[]; alsoFixes: string[] };
interface Slot {
  task: Draft;
  /** Report order (ties). */
  seq: number;
  line?: number;
  /** The vendor consent API the item names (call-consent-api). */
  api?: string;
  folded?: boolean;
}

/** Fixers of one party for a folded item: required ones for a required item. A Google-wide consent default does not hold a tool back. */
function fixersOf(slots: Slot[], partyId: string, kinds: Set<RemediationTask['kind']>, optional: boolean): Slot[] {
  return slots.filter((s) => !s.folded && kinds.has(s.task.kind) && s.task.partyIds.includes(partyId) && (optional || !s.task.optional) && !(s.task.kind === 'set-consent-default' && s.task.verify.check === 'consent-default'));
}

/** A fixing task checks the tool itself: a static check of its markup / container, or a spot check of that very tool. */
const checksTool = (t: Draft, partyId: string): boolean => t.verify.method === 'static' || (t.verify.check === 'spot-check' && t.verify.partyId === partyId);

function addFix(t: Draft, id: string, line: string): void {
  if (!t.aliases.includes(id)) t.aliases.push(id);
  if (!t.alsoFixes.includes(line)) t.alsoFixes.push(line);
}

/** Same title twice: say where (page, line) or which GTM tag. */
function disambiguate(slots: Slot[]): void {
  const byTitle = new Map<string, Slot[]>();
  for (const s of slots) byTitle.set(s.task.title, [...(byTitle.get(s.task.title) ?? []), s]);
  for (const group of byTitle.values()) {
    if (group.length < 2) continue;
    const pages = new Set(group.map((s) => s.task.pages[0]));
    for (const s of group) {
      const t = s.task;
      const parts: string[] = [];
      if (t.verify.check === 'gtm-tag-consent') parts.push(`tag ${t.verify.tagId}`);
      else {
        if (pages.size > 1 && t.pages[0]) parts.push(`on ${pageLabel(t.pages[0])}`);
        if (s.line && group.filter((g) => g.task.pages[0] === t.pages[0]).length > 1) parts.push(`line ${s.line}`);
      }
      if (parts.length) t.title = `${t.title} (${parts.join(', ')})`;
    }
  }
}

/**
 * The tools a person must classify: unrecognized ones whose purpose the change
 * list could not decide (purpose 'unclassified'), and those the site workspace
 * already classified that the knowledge base does not (so the decision stays
 * on the list, done, after the report is re-rendered with it).
 */
function classifySubjects(report: CompatibilityReport, ev: TrackingEvaluation, kb: KnowledgeBase): Array<{ partyId: string; label: string; domain: string }> {
  const out = new Map<string, { partyId: string; label: string; domain: string }>();
  const known = (id: string): boolean => (kb.entries.find((e) => e.id === id)?.categories ?? []).some((c) => String(c) !== 'unknown');
  const add = (partyId: string, label?: string): void => {
    const p = ev.inventory.find((x) => x.partyId === partyId);
    if (!p || out.has(partyId)) return;
    out.set(partyId, { partyId, label: label ?? p.label, domain: p.domain });
  };
  for (const r of report.rows) if (r.purpose === 'unclassified') add(r.partyId, r.label);
  for (const c of ev.siteWorkspace?.classifications ?? []) if (c.kind === 'tool' && !known(c.partyId)) add(c.partyId);
  return [...out.values()];
}

function classifyTask(s: { partyId: string; label: string; domain: string }, blocked: number): Draft {
  return {
    id: changeId({ kind: 'classify', partyId: s.partyId }),
    kind: 'classify',
    group: 'classify',
    title: `Decide: what is ${s.label}?`,
    summary: `The scan does not recognize it, so it cannot tell whether it needs consent.${blocked ? ` ${blocked === 1 ? 'One change below waits' : `${blocked} changes below wait`} on this answer.` : ''}`,
    party: s.partyId,
    tools: [s.label],
    partyIds: [s.partyId],
    steps: [
      `Find out what ${s.label} does on your site (it loads from ${s.domain}): ask whoever added it, or look it up.`,
      'Open it in the report’s grid, choose its main purpose — Necessary, Functional, Analytics, Performance or Advertisement — and press “Use this classification”. “Other” does not decide it.',
      'Press “Update report with my classifications”: the changes waiting on this answer are recomputed — kept if it tracks visitors, dropped if it does not.',
    ],
    pages: [],
    verify: manual('a decision recorded in the report, not a change to the site: it is done once the site’s workspace holds a purpose for it'),
    optional: false,
    classKey: classificationKey({ kind: 'tool', partyId: s.partyId, domain: s.domain, recognized: false }),
    notes: [],
    aliases: [],
    alsoFixes: [],
  };
}

/**
 * The to-do list: the decisions (classify), install, remove the old banner,
 * then one task per change that is separate work, in the order an owner does
 * them (see "Folding and order" above); optional items last. Status and the
 * last verify result come from the workspace when given (a folded item's
 * stored status is found through the task's aliases; a decision's status is
 * whether the workspace holds its classification).
 */
export function buildRemediationTasks(generated: RemediationSource, evaluation: TrackingEvaluation, opts: BuildRemediationTasksOptions = {}): RemediationTask[] {
  const kb = opts.kb ?? DEFAULT_KB;
  const report = reportOf(generated, evaluation, kb, opts.workspace);
  const page = evaluation.site.url;
  const scriptSrc = scriptSrcOf(generated);
  const config = generated.config;
  const draft = (t: Omit<RemediationTask, 'status' | 'lastVerify' | 'order'>): Draft => ({ ...t, aliases: [], alsoFixes: [] });

  const slots: Slot[] = [];
  // The to-do list is the fixes for what the scan observed. With no change item at all — every
  // tool held where the rules expect it off, in every visit the grid compared — there is nothing
  // to install the complykit tool for, and nothing to remove the site's own banner for: the
  // decisions (classify) are the whole list. The generated config and snippet still exist for
  // an owner who wants them; they are not a task.
  const hasChanges = report.groups.some((g) => g.items.length > 0) || report.otherChanges.length > 0;
  if (hasChanges) {
    const { order: _o, ...install } = installTask(config, scriptSrc, page);
    slots.push({ task: draft(install), seq: 0 });
    for (const t of removeExistingToolTasks(evaluation, generated.notes ?? [], page)) slots.push({ task: draft(t), seq: slots.length });
  }

  const seen = new Set<string>(slots.map((s) => s.task.id));
  const add = (it: ChangeItem, group: string, optional: boolean): void => {
    if (seen.has(it.id)) return; // the same change listed under two tools (merge keys differ, ids agree)
    seen.add(it.id);
    const pages = pagesOf(evaluation, it);
    const s = shape(evaluation, it, pages, config);
    const guide = it.guide ?? (it.kind === 'gate-gtm-tag' || (it.kind === 'set-consent-default' && !it.api) ? { label: 'Setting up Google Tag Manager', href: GTM_GUIDE } : it.kind === 'rewrite-tag' ? { label: 'Consent tool config: categories', href: CONFIG_GUIDE } : it.kind === 'use-platform-api' ? (platformGuide(it.platform) ? { label: `Installing on ${cap(it.platform!)}`, href: platformGuide(it.platform)! } : undefined) : it.kind === 'call-consent-api' ? { label: 'Vendor consent APIs', href: VENDOR_GUIDE } : undefined);
    const notes = [...(it.notes ?? []), ...(it.categoryNote ? [`data-category “${it.category}”: ${it.categoryNote}.`] : []), ...(it.hint && it.kind !== 'needs-a-look' ? [it.hint] : [])];
    const snippet = !s.noSnippet && (it.before || it.after) ? { snippet: { ...(it.before ? { before: it.before } : {}), ...(it.after ? { after: it.after } : {}) } } : {};
    slots.push({
      task: draft({
        id: it.id,
        kind: it.kind,
        group,
        title: s.title,
        summary: s.summary,
        ...(it.partyIds[0] ? { party: it.partyIds[0] } : {}),
        tools: [...it.tools],
        partyIds: [...it.partyIds],
        steps: s.steps,
        ...snippet,
        pages,
        verify: s.verify,
        optional,
        ...(it.classifyFirst ? { classifyFirst: true } : {}),
        notes,
        ...(guide ? { guide } : {}),
      }),
      seq: slots.length,
      ...(it.line ? { line: it.line } : {}),
      ...(it.api ? { api: it.api } : {}),
    });
  };
  for (const g of report.groups) for (const it of g.items) add(it, g.id, false);
  for (const it of report.otherChanges) add(it, 'other', true);

  // --- fold --------------------------------------------------------------------------
  const installSlot = slots.find((s) => s.task.kind === 'install');
  const confirm = new Map<string, { from: Draft; ids: string[] }>();
  for (const s of slots) {
    const t = s.task;
    const party = t.partyIds[0];
    if (!party || t.partyIds.length !== 1) continue;
    const tools = list(t.tools);
    if (t.kind === 'behavior-mismatch') {
      const fixers = fixersOf(slots, party, FIXES_BEHAVIOR, t.optional);
      if (!fixers.length) continue;
      for (const f of fixers) addFix(f.task, t.id, `${tools} running before the visitor chooses (seen in the scan).`);
      s.folded = true;
      if (!fixers.some((f) => checksTool(f.task, party)) && t.verify.check === 'spot-check') confirm.set(party, { from: t, ids: [...(confirm.get(party)?.ids ?? []), t.id] });
    } else if (t.kind === 'call-consent-api') {
      if (!installSlot || !config.vendors.some((v) => v.id === party && v.adapter)) continue;
      addFix(installSlot.task, t.id, `Telling ${tools} the visitor’s choice${s.api ? ` (${s.api})` : ''} — the tool makes this call for you.`);
      s.folded = true;
    } else if (t.kind === 'accepted-exposure') {
      const fixers = fixersOf(slots, party, REMOVES_EXPOSURE, t.optional);
      if (!fixers.length) continue;
      for (const f of fixers) addFix(f.task, t.id, `${tools} loading where no consent tool can hold it — no decision needed once this is done.`);
      s.folded = true;
    }
  }
  const kept = slots.filter((s) => !s.folded);
  // --- decisions -----------------------------------------------------------------------
  // One per tool to classify; a change whose tools are all unclassified waits on them.
  const subjects = classifySubjects(report, evaluation, kb);
  const decisionOf = new Map(subjects.map((x) => [x.partyId, changeId({ kind: 'classify', partyId: x.partyId })]));
  for (const s of kept) {
    if (!s.task.classifyFirst) continue;
    const ids = s.task.partyIds.map((id) => decisionOf.get(id)).filter((x): x is string => !!x);
    if (ids.length) s.task.waitingOn = [...new Set(ids)];
  }
  const decisions = subjects.map((x, i): Slot => {
    const id = decisionOf.get(x.partyId)!;
    return { task: classifyTask(x, kept.filter((k) => k.task.waitingOn?.includes(id)).length), seq: -subjects.length + i };
  });
  kept.push(...decisions);
  for (const [party, c] of confirm) {
    const tools = list(c.from.tools);
    const spec = c.from.verify;
    if (spec.check !== 'spot-check') continue;
    kept.push({
      task: {
        id: changeId({ kind: 'confirm-in-browser', partyId: party }),
        kind: 'confirm-in-browser',
        group: 'confirm',
        title: `Confirm in the browser: ${tools} waits for consent`,
        summary: 'The changes above for this tool can’t be checked from the page’s HTML, so check it in a browser once they are published.',
        party,
        tools: [...c.from.tools],
        partyIds: [party],
        steps: [`Do the tasks above that name ${tools}, and publish them.`, spotCheckStep(tools, spec.page)],
        pages: [spec.page],
        verify: spec,
        optional: c.from.optional,
        notes: [],
        aliases: [...c.ids],
        alsoFixes: [],
      },
      seq: slots.length + kept.length,
    });
  }

  // --- order -------------------------------------------------------------------------
  // Pages in the order they first appear (the scanned page first), tags by line within a page.
  const pageOrder = new Map<string, number>([[page, 0]]);
  for (const s of kept) for (const p of s.task.pages.slice(0, 1)) if (!pageOrder.has(p)) pageOrder.set(p, pageOrder.size);
  const byPage = (k: RemediationTask['kind']): boolean => k === 'rewrite-tag' || k === 'remove-leak';
  kept.sort((a, b) => {
    const ta = a.task;
    const tb = b.task;
    if (ta.optional !== tb.optional) return ta.optional ? 1 : -1;
    if (RANK[ta.kind] !== RANK[tb.kind]) return RANK[ta.kind] - RANK[tb.kind];
    if (byPage(ta.kind)) {
      const pa = pageOrder.get(ta.pages[0]) ?? 0;
      const pb = pageOrder.get(tb.pages[0]) ?? 0;
      if (pa !== pb) return pa - pb;
      if ((a.line ?? Infinity) !== (b.line ?? Infinity)) return (a.line ?? Infinity) - (b.line ?? Infinity);
    }
    if (ta.verify.check === 'gtm-tag-consent' && tb.verify.check === 'gtm-tag-consent' && ta.verify.containerId === tb.verify.containerId) return ta.verify.tagId - tb.verify.tagId;
    return a.seq - b.seq;
  });
  disambiguate(kept);

  return kept.map((s, i) => {
    const { aliases, alsoFixes, ...rest } = s.task;
    return withStatus({ ...rest, ...(aliases.length ? { aliases } : {}), ...(alsoFixes.length ? { alsoFixes } : {}), order: i }, opts.workspace);
  });
}

/** Totals for the checklist header. Verified counts only `verified`; done-unverified is listed apart, never folded in. */
export function remediationTotals(tasks: RemediationTask[]): { total: number; verified: number; doneUnverified: number; failed: number; cannotVerify: number; todo: number; required: number } {
  const count = (s: RemediationTask['status']): number => tasks.filter((t) => t.status === s).length;
  return { total: tasks.length, verified: count('verified'), doneUnverified: count('done-unverified'), failed: count('failed'), cannotVerify: count('cannot-verify'), todo: count('todo'), required: tasks.filter((t) => !t.optional).length };
}
