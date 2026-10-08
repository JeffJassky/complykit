import type { RawFinding, Artifact, Evidence } from '../../record/index.js';
import type { Rule, EvalContext } from '../types.js';
import {
  asRuleId,
  asRequirementId,
  getRequirement,
  requirementScopeFor,
  entryStatus,
  usStateAct,
  CONSENT_CATEGORIES,
  CONTEXT_CATEGORIES,
  SALE_SHARE_CATEGORIES,
  WIRETAP_CATEGORIES,
  DEFAULT_KB,
  type PartyCategory,
  type RuleId,
  type RequirementId,
} from '../../registry/index.js';
import {
  analyzeArtifacts,
  partyCategories,
  UNCONSENTED,
  PRE_INTERACTION,
  PHASE_LABEL,
  type TimelineAnalysis,
  type PartyFacts,
  type PartyRequest,
  type Phase,
} from './analyze.js';
import { allDenied, adsRestricted } from './decoders.js';
import { FIELD_LABEL, type FieldKind } from './fields.js';

// The location rules (plans/consent-design.md §2.6 step 5). One rule per legal
// family; one finding per party per jurisdiction, with every location ×
// scenario where it happened listed as an occurrence (fingerprint convention,
// §8: jurisdiction in locator.landmark, party id in locator.name, site-wide
// locus `routePattern: '*'`). Findings only come from VERIFIED locations.
//
//   violation    — evidence against an obligation;
//   needs-review — evidence a person must judge;
//   exposure     — the cited requirement has kind 'exposure' (wiretap theories);
//                  those rules are capped at needs-review and the report labels
//                  them for counsel.

/** Categories that are never tracking by themselves. */
const NOT_TRACKING: ReadonlySet<PartyCategory> = new Set<PartyCategory>(['necessary', 'cdn', 'consent', 'payments', 'captcha', 'tag-manager']);

export interface Occurrence {
  location: string;
  scenario: string;
  phases: Phase[];
  firstMs: number;
  sinceBannerMs?: number;
  requests: number;
  sent: FieldKind[];
  stored: string[];
  decoded: string[];
  markers: string[];
  sampleUrl?: string;
  /** Where the IDs it received live on the device ("cookie _ga", "local uid"). */
  idsFrom: string[];
  idsCarriedOver?: number;
}

export interface TrackingDetails {
  party: { id: string; label: string; owner?: string; domain: string; hosts: string[]; recognized: boolean; kbStatus: 'confirmed' | 'proposed' | 'unrecognized'; categories: string[] };
  scope: string;
  pattern: string;
  theory?: string;
  source: PartySource;
  loadedBy: string[];
  fix: string;
  trackerSignals: string[];
  occurrences: Occurrence[];
  notes: string[];
}
type PartySource = PartyFacts['source'];

const kbStatus = (f: PartyFacts): TrackingDetails['party']['kbStatus'] => (f.entry ? entryStatus(f.entry) : 'unrecognized');

function fixFor(f: PartyFacts): string {
  const by = f.loadedBy[0];
  switch (f.source) {
    case 'markup':
      return 'It is written in the site’s own HTML. Mark the tag up so the consent tool holds it back (type="text/plain" with a data-category), or move it into the consent tool.';
    case 'markup-leak':
      return 'An <img>, <iframe>, preload hint or <noscript> tag in the page HTML loads it before any script can intervene — gating scripts cannot hold it back. Remove it from the markup and load it through the consent tool.';
    case 'injected':
      return `It is injected at runtime${by ? ` by ${by}` : ''} (a tag manager, app or plugin). Gate it where it is injected (the tag manager trigger or the app’s consent setting), or hold it back at runtime (guard).`;
    case 'platform':
      return 'It runs inside a platform sandbox, worker or service worker that page scripts cannot reach. Fix it in the platform’s pixel and consent settings.';
    case 'first-party-proxy':
      return `It is served from ${f.cnameOf ?? 'a first-party subdomain'}, whose DNS points at ${f.domain} — the consent tool must treat that subdomain as the vendor.`;
    default:
      return 'Where it was loaded from is unclear — see the initiator chain in the evidence.';
  }
}

function joinList(items: string[]): string {
  if (items.length <= 1) return items[0] ?? '';
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

function sentPhrase(kinds: FieldKind[]): string {
  const order: FieldKind[] = ['form-input', 'search-term', 'hashed-email', 'page-address', 'page-title', 'browser-id', 'click-id', 'event-name', 'identifier'];
  const k = order.filter((x) => kinds.includes(x)).slice(0, 4);
  return k.length ? joinList(k.map((x) => FIELD_LABEL[x])) : 'a request';
}

function occurrence(a: TimelineAnalysis, f: PartyFacts, reqs: PartyRequest[], storedPhases?: ReadonlySet<Phase>): Occurrence {
  const sorted = [...reqs].sort((x, y) => x.t - y.t);
  const first = sorted[0];
  const kinds = new Set<FieldKind>();
  for (const r of sorted) for (const k of r.kinds) kinds.add(k);
  const decoded = new Set<string>();
  for (const r of sorted) for (const n of r.decoded?.notes ?? []) decoded.add(n);
  const markers = new Set<string>();
  for (const r of sorted) for (const m of r.markers) markers.add(m.marker === 'click-id' ? `click ID ${m.name ?? ''}`.trim() : `${m.marker} (${m.form})`);
  const stored = f.stores
    .filter((s) => !storedPhases || !s.phase || storedPhases.has(s.phase))
    .map((s) => `${s.kind} ${s.name}${s.lifetimeDays === null ? ' (no expiry)' : s.lifetimeDays ? ` (${s.lifetimeDays} days)` : ' (session)'}`);
  return {
    location: a.locationId,
    scenario: a.scenario,
    phases: [...new Set(sorted.map((r) => r.phase))],
    firstMs: first ? Math.round(first.t) : 0,
    sinceBannerMs: first && a.bannerShownT !== undefined ? Math.round(first.t - a.bannerShownT) : undefined,
    requests: sorted.length,
    sent: [...kinds],
    stored: [...new Set(stored)],
    decoded: [...decoded].slice(0, 6),
    markers: [...markers],
    sampleUrl: first?.url.slice(0, 600),
    idsFrom: [...new Set(sorted.flatMap((r) => r.ids.map((i) => i.storedAs)))].slice(0, 6),
  };
}

function evidence(a: TimelineAnalysis, f: PartyFacts, reqs: PartyRequest[]): Evidence[] {
  const ev: Evidence[] = [];
  const phaseOf = (p: Phase): 'pre-consent' | 'post-reject' | 'post-accept' | undefined =>
    PRE_INTERACTION.has(p) ? 'pre-consent' : p === 'after-reject' || p === 'after-dismiss' || p === 'after-withdraw' || p === 'after-opt-out-link' ? 'post-reject' : p === 'after-accept' || p === 'after-partial' ? 'post-accept' : undefined;
  for (const r of [...reqs].sort((x, y) => x.t - y.t).slice(0, 3)) {
    ev.push({ kind: 'network-request', url: r.url.slice(0, 2000), initiatorChain: r.chain.slice(0, 8), phase: phaseOf(r.phase), resourceType: r.resourceType });
  }
  for (const s of f.stores.filter((x) => x.kind === 'cookie').slice(0, 2)) {
    const snap = a.timeline.snapshot.cookies.find((c) => c.name === s.name);
    ev.push({
      kind: 'cookie',
      name: s.name,
      domain: snap?.domain ?? f.domain,
      phase: s.phase ? phaseOf(s.phase) ?? 'pre-consent' : 'pre-consent',
      flags: { secure: snap?.secure ?? false, httpOnly: snap?.httpOnly ?? false, sameSite: snap?.sameSite },
      classification: partyCategories(f).join(',') || 'unknown',
    });
  }
  const shot = a.screenshots.find((s) => s.label === 'banner') ?? a.screenshots[0];
  if (shot) ev.push({ kind: 'screenshot', path: shot.path, pageState: `${a.locationId}/${a.scenario}: ${shot.label}` });
  const ids = new Set(reqs.map((r) => r.id));
  const steps = a.timeline.events
    .filter((e) => e.type === 'action' || e.type === 'banner' || e.type === 'choice' || (e.type === 'request' && ids.has(e.id)))
    .slice(0, 40)
    .map((e) => {
      switch (e.type) {
        case 'request':
          return { t: Math.round(e.t), request: e.url.slice(0, 160), from: e.origin };
        case 'action':
          return { t: Math.round(e.t), action: e.action, detail: e.detail ?? e.url };
        case 'banner':
          return { t: Math.round(e.t), banner: e.state, cmp: e.cmp };
        case 'choice':
          return { t: Math.round(e.t), choice: e.choice, ok: e.ok, method: e.method };
        default:
          return { t: Math.round(e.t) };
      }
    });
  ev.push({ kind: 'interaction-log', steps: [{ location: a.locationId, scenario: a.scenario, evidence: a.timeline.snapshot.evidence }, ...steps] });
  return ev;
}

interface Acc {
  f: PartyFacts;
  scope: string;
  requirementId: string;
  violation: boolean;
  occurrences: Occurrence[];
  evidence: Evidence[];
  notes: Set<string>;
  phases: Set<Phase>;
  locations: Set<string>; // display names: "Germany (de)"
  sent: Set<FieldKind>;
  theory?: string;
  instanceUrl: string;
}

function accumulate(map: Map<string, Acc>, key: string, init: () => Omit<Acc, 'occurrences' | 'evidence' | 'notes' | 'phases' | 'locations' | 'sent'>, a: TimelineAnalysis, reqs: PartyRequest[], violation: boolean, notes: string[], storedPhases?: ReadonlySet<Phase>): void {
  let acc = map.get(key);
  if (!acc) {
    acc = { ...init(), occurrences: [], evidence: [], notes: new Set(), phases: new Set(), locations: new Set(), sent: new Set() };
    map.set(key, acc);
  }
  acc.violation = acc.violation || violation;
  const occ = occurrence(a, acc.f, reqs, storedPhases);
  acc.occurrences.push(occ);
  if (acc.evidence.length < 12) acc.evidence.push(...evidence(a, acc.f, reqs));
  for (const n of notes) acc.notes.add(n);
  for (const p of occ.phases) acc.phases.add(p);
  for (const k of occ.sent) acc.sent.add(k);
  acc.locations.add(placeName(a));
}

/** "Germany (de)" — the location's label with its id, for messages. */
function placeName(a: TimelineAnalysis): string {
  if (a.locationId === 'local') {
    const o = a.timeline.verification.observed;
    return `this machine (${[o.country, o.region].filter(Boolean).join('-') || 'unverified'})`;
  }
  const label = a.timeline.location.label;
  return label && label.toLowerCase() !== a.locationId ? `${label} (${a.locationId})` : a.locationId;
}

function scopeOf(requirementId: string, a: TimelineAnalysis): string | undefined {
  const req = getRequirement(requirementId);
  return req ? requirementScopeFor(req, a.jurisdictions, a.date) : undefined;
}

function finish(rule: { id: RuleId }, acc: Acc, ctx: EvalContext, message: string, pattern: string): RawFinding {
  const f = acc.f;
  const details: TrackingDetails = {
    party: { id: f.partyId, label: f.label, owner: f.owner, domain: f.domain, hosts: [...f.hosts], recognized: f.recognized, kbStatus: kbStatus(f), categories: f.categories },
    scope: acc.scope,
    pattern,
    theory: acc.theory,
    source: f.source,
    loadedBy: f.loadedBy,
    fix: fixFor(f),
    trackerSignals: f.trackerSignals,
    occurrences: acc.occurrences,
    notes: [...acc.notes],
  };
  return {
    ruleId: rule.id,
    requirementId: asRequirementId(acc.requirementId),
    subject: {
      property: ctx.property,
      routePattern: '*',
      instanceUrl: acc.instanceUrl,
      locator: { role: 'tracking-party', name: f.partyId, landmark: acc.scope, ordinal: 0 },
    },
    confidence: acc.violation ? 'violation' : 'needs-review',
    message,
    details,
    evidence: acc.evidence,
  };
}

function loadedPhrase(f: PartyFacts): string {
  if (f.source === 'markup' || f.source === 'markup-leak') return 'written in the page’s own HTML, ';
  if (f.source === 'platform') return 'run inside a platform sandbox or worker, ';
  if (f.source === 'first-party-proxy') return `served from ${f.cnameOf ?? 'a first-party subdomain'}, `;
  return f.loadedBy[0] ? `loaded by ${f.loadedBy[0]}, ` : '';
}

function partyLabel(f: PartyFacts): string {
  const cats = partyCategories(f);
  if (!f.recognized) return `Unrecognized ${f.domain}${f.behavesLikeTracker ? ' (behaves like a tracker)' : ''}`;
  return `${f.label}${cats.length ? ` (${cats.join(', ')})` : ''}`;
}

function phasePhrase(phases: Set<Phase>): string {
  const order: Phase[] = ['no-banner', 'before-banner', 'before-choice', 'after-dismiss', 'after-reject', 'after-withdraw', 'after-opt-out-link', 'after-partial'];
  return joinList(order.filter((p) => phases.has(p)).map((p) => PHASE_LABEL[p]));
}

function isTrackingParty(f: PartyFacts): 'tracking' | 'context' | 'unknown' | 'none' {
  const cats = partyCategories(f);
  if (!f.recognized) return f.behavesLikeTracker || f.stores.length ? 'unknown' : 'none';
  if (cats.some((c) => CONSENT_CATEGORIES.has(c))) return 'tracking';
  if (cats.some((c) => CONTEXT_CATEGORIES.has(c) || c === 'embed')) return 'context';
  if (cats.every((c) => NOT_TRACKING.has(c))) return 'none';
  return 'context';
}

/** True if this timeline never consented (no successful accept/partial). */
function neverConsented(a: TimelineAnalysis): boolean {
  return !a.choices.some((c) => c.ok && (c.choice === 'accept' || c.choice === 'partial'));
}

// --- 1. EU / UK: consent before storage or access ------------------------------

const PRIOR_ID = asRuleId('tracking.prior-consent');
export const priorConsent: Rule<readonly ['consent-timeline']> = {
  id: PRIOR_ID,
  requirements: [asRequirementId('eprivacy.art5.3'), asRequirementId('pecr.reg6')],
  layer: 'browser',
  confidence: 'violation',
  detects: 'presence',
  evidence: ['network-request', 'interaction-log'],
  remediation:
    'Hold back every non-essential script, pixel and embed until the visitor consents, and make reject and dismiss leave them off. The finding says where each one came from (markup, injected, platform) — that decides where to fix it.',
  falsePositives:
    'A recognized vendor’s category comes from the knowledge base (seed entries are unconfirmed); an unrecognized party is reported by behavior and needs research. Google Consent Mode “advanced” pings with every signal denied, UK first-party statistics (DUAA exception) and chat/embeds/fonts are reported as needs-review, not violations.',
  consumes: ['consent-timeline'] as const,
  evaluate(input: { 'consent-timeline': Artifact[] }, ctx: EvalContext): RawFinding[] {
    const kb = ctx.knowledgeBase ?? DEFAULT_KB;
    const acc = new Map<string, Acc>();
    for (const a of analyzeArtifacts(input['consent-timeline'], kb)) {
      if (!a.verified) continue;
      const eu = scopeOf('eprivacy.art5.3', a);
      const uk = eu ? undefined : scopeOf('pecr.reg6', a);
      const scope = eu ?? uk;
      if (!scope) continue;
      const requirementId = eu ? 'eprivacy.art5.3' : 'pecr.reg6';
      const consented = !neverConsented(a);
      for (const f of a.parties.values()) {
        const kind = isTrackingParty(f);
        if (kind === 'none') continue;
        const cats = partyCategories(f);
        const analyticsOnly = cats.length > 0 && cats.every((c) => c === 'analytics');
        const counts = (p: Phase): boolean => UNCONSENTED.has(p) || (p === 'after-partial' && !cats.includes('analytics') && f.recognized);
        const reqs = f.requests.filter((r) => counts(r.phase) && r.dataBearing);
        const storedUnconsented = f.stores.filter((s) => (s.phase ? counts(s.phase) : !consented));
        if (!reqs.length && !storedUnconsented.length) continue;
        const notes: string[] = [];
        let violation = kind === 'tracking';
        if (violation && reqs.length && reqs.every((r) => allDenied(r.decoded)) && !storedUnconsented.length) {
          violation = false;
          notes.push('Every request carried Google Consent Mode signals set to denied and nothing was stored — Consent Mode “advanced” cookieless pings. They still send the page address and IP; treating them as needing consent in the EU is an inference from EDPB Guidelines 2/2023, untested in court.');
        }
        if (violation && uk && analyticsOnly) {
          violation = false;
          notes.push('UK: analytics may fall under the PECR Schedule A1 statistical-purposes exception (provider as processor, clear information, simple free way to object). Confirm before treating as a violation.');
        }
        if (kind === 'context') notes.push(`Category (${cats.join(', ')}) needs consent only in some uses — e.g. a chat widget the visitor opens, a click-to-load embed.`);
        if (!f.recognized) notes.push('Not in the knowledge base — queued for research.');
        if (f.source === 'markup-leak') notes.push('Loaded by a tag in the page HTML that script gating cannot hold back.');
        const key = `${f.partyId}|${scope}`;
        accumulate(acc, key, () => ({ f, scope, requirementId, violation, instanceUrl: a.site.url }), a, reqs, violation, notes, new Set([...UNCONSENTED]));
      }
    }
    return [...acc.values()].map((x) =>
      finish(
        priorConsent,
        x,
        ctx,
        `${partyLabel(x.f)} received ${sentPhrase([...x.sent])} ${phasePhrase(x.phases) || 'without consent'}, from ${joinList([...x.locations])}.`,
        x.f.source === 'markup-leak' ? 'markup-leak' : 'prior-consent',
      ),
    );
  },
};

// --- 2. EU / UK: withdrawal ------------------------------------------------------

const WITHDRAW_ID = asRuleId('tracking.withdrawal');
export const withdrawal: Rule<readonly ['consent-timeline']> = {
  id: WITHDRAW_ID,
  requirements: [asRequirementId('gdpr.art7.3'), asRequirementId('uk-gdpr.art7.3')],
  layer: 'browser',
  confidence: 'violation',
  detects: 'presence',
  evidence: ['interaction-log'],
  remediation:
    'Give visitors a persistent way to reopen consent settings (a footer link or floating button), and on withdrawal stop every tracker immediately, signal the vendors (Consent Mode update, fbq consent revoke …) and delete the cookies you can.',
  falsePositives:
    'The scan looks for the common consent-tool APIs and settings-link wording; a site with an unusual withdrawal entry point is reported as needs-review, not violation.',
  consumes: ['consent-timeline'] as const,
  evaluate(input: { 'consent-timeline': Artifact[] }, ctx: EvalContext): RawFinding[] {
    const kb = ctx.knowledgeBase ?? DEFAULT_KB;
    const out: RawFinding[] = [];
    const acc = new Map<string, Acc>();
    for (const a of analyzeArtifacts(input['consent-timeline'], kb)) {
      if (!a.verified || a.scenario !== 'withdraw' || !a.withdrawal) continue;
      const eu = scopeOf('gdpr.art7.3', a);
      const uk = eu ? undefined : scopeOf('uk-gdpr.art7.3', a);
      const scope = eu ?? uk;
      if (!scope) continue;
      const requirementId = eu ? 'gdpr.art7.3' : 'uk-gdpr.art7.3';
      if (!a.withdrawal.entryPoint) {
        out.push({
          ruleId: WITHDRAW_ID,
          requirementId: asRequirementId(requirementId),
          subject: { property: ctx.property, routePattern: '*', instanceUrl: a.site.url, locator: { role: 'consent-withdrawal', name: 'no-entry-point', landmark: scope, ordinal: 0 } },
          confidence: 'needs-review',
          message: `After accepting, no way to reopen the consent settings was found (no consent-tool API, no “cookie settings” link) — withdrawing looks harder than consenting, from ${placeName(a)}.`,
          details: { scope, pattern: 'no-entry-point', location: a.locationId, scenario: a.scenario, method: a.withdrawal.method },
          evidence: [{ kind: 'interaction-log', steps: a.timeline.events.filter((e) => e.type === 'choice' || e.type === 'banner').map((e) => ({ ...e })) }],
        });
        continue;
      }
      if (!a.withdrawal.ok) continue;
      const tw = a.withdrawal.t;
      for (const f of a.parties.values()) {
        const kind = isTrackingParty(f);
        if (kind === 'none' || kind === 'context') continue;
        const after = f.requests.filter((r) => r.phase === 'after-withdraw' && r.dataBearing);
        if (!after.length) continue;
        const before = new Set(f.requests.filter((r) => r.t < tw).flatMap((r) => r.ids.map((i) => i.value)));
        const carried = new Set(after.flatMap((r) => r.ids.map((i) => i.value)).filter((v) => before.has(v)));
        const notes: string[] = [];
        let violation = kind === 'tracking';
        if (after.every((r) => allDenied(r.decoded))) {
          violation = false;
          notes.push('Requests after withdrawal carried Consent Mode signals set to denied (cookieless pings).');
        }
        if (carried.size) notes.push(`${carried.size} ID value(s) sent before withdrawal were still sent after it — the old identity carried on.`);
        const key = `${f.partyId}|${scope}`;
        accumulate(acc, key, () => ({ f, scope, requirementId, violation, instanceUrl: a.site.url }), a, after, violation, notes, new Set<Phase>(['after-withdraw']));
        const last = acc.get(key)!.occurrences[acc.get(key)!.occurrences.length - 1];
        last.idsCarriedOver = carried.size;
      }
    }
    for (const x of acc.values()) {
      out.push(finish(withdrawal, x, ctx, `${partyLabel(x.f)} kept receiving ${sentPhrase([...x.sent])} after consent was withdrawn, from ${joinList([...x.locations])}.`, 'after-withdrawal'));
    }
    return out;
  },
};

// --- 3. US: opt-out preference signals (GPC) -------------------------------------

const SIGNAL_ID = asRuleId('tracking.opt-out-signal');
export const optOutSignal: Rule<readonly ['consent-timeline']> = {
  id: SIGNAL_ID,
  requirements: [asRequirementId('ccpa.regs.7025'), asRequirementId('us-states.opt-out-signal')],
  layer: 'browser',
  confidence: 'violation',
  detects: 'presence',
  evidence: ['network-request', 'interaction-log'],
  remediation:
    'Read Sec-GPC / navigator.globalPrivacyControl before any advertising tag loads; when it is on, hold sale/share pixels back (or put them in their restricted modes — Google rdp, Meta Limited Data Use) on the very first page, with no popup.',
  falsePositives:
    'Whether a disclosure is a “sale” or “sharing” depends on the vendor contract, which a browser cannot see; restricted-mode traffic and unrecognized parties are needs-review. Without the hand-set `ccpa-covered` / `us-state-privacy-covered` tag, findings stay needs-review because the law’s thresholds are not observable.',
  consumes: ['consent-timeline'] as const,
  evaluate(input: { 'consent-timeline': Artifact[] }, ctx: EvalContext): RawFinding[] {
    const kb = ctx.knowledgeBase ?? DEFAULT_KB;
    const tags = ctx.tags ?? [];
    const acc = new Map<string, Acc>();
    for (const a of analyzeArtifacts(input['consent-timeline'], kb)) {
      if (!a.verified || !a.gpc) continue;
      const ca = scopeOf('ccpa.regs.7025', a);
      const st = ca ? undefined : scopeOf('us-states.opt-out-signal', a);
      const scope = ca ?? st;
      if (!scope) continue;
      const requirementId = ca ? 'ccpa.regs.7025' : 'us-states.opt-out-signal';
      const covered = tags.includes(ca ? 'ccpa-covered' : 'us-state-privacy-covered');
      for (const f of a.parties.values()) {
        const cats = partyCategories(f);
        const saleShare = cats.some((c) => SALE_SHARE_CATEGORIES.has(c));
        if (!saleShare && !(!f.recognized && f.behavesLikeTracker)) continue;
        const reqs = f.requests.filter((r) => r.dataBearing && r.kinds.some((k) => k === 'browser-id' || k === 'page-address' || k === 'hashed-email' || k === 'click-id' || k === 'identifier'));
        if (!reqs.length) continue;
        const notes: string[] = [];
        let violation = f.recognized && saleShare && covered;
        if (reqs.every((r) => adsRestricted(r.decoded))) {
          violation = false;
          notes.push('Every request carried a restricted-processing or denied-ads signal — the vendor was told; whether that satisfies the opt-out depends on its terms.');
        }
        if (f.recognized && saleShare && !covered) notes.push(`Thresholds unconfirmed: set the \`${ca ? 'ccpa-covered' : 'us-state-privacy-covered'}\` tag once counsel confirms the business is covered, and this becomes a violation.`);
        if (a.scenario === 'opt-out-all') notes.push('Seen even after opting out three ways at once (signal, banner reject, the site’s opt-out link) — the method regulators used against Healthline.');
        const key = `${f.partyId}|${scope}`;
        accumulate(acc, key, () => ({ f, scope, requirementId, violation, instanceUrl: a.site.url }), a, reqs, violation, notes);
      }
    }
    return [...acc.values()].map((x) =>
      finish(optOutSignal, x, ctx, `${partyLabel(x.f)} received ${sentPhrase([...x.sent])} while the browser was sending Global Privacy Control, from ${joinList([...x.locations])}.`, 'ignored-opt-out-signal'),
    );
  },
};

// --- 4. California: show that the signal was processed ---------------------------

const DISPLAY_ID = asRuleId('tracking.opt-out-display');
export const optOutDisplay: Rule<readonly ['consent-timeline']> = {
  id: DISPLAY_ID,
  requirements: [asRequirementId('ccpa.regs.7025c6')],
  layer: 'browser',
  confidence: 'needs-review',
  detects: 'presence',
  evidence: ['interaction-log'],
  remediation: 'When GPC is detected, display that it was honored — e.g. “Opt-Out Request Honored” in the privacy-choices link or panel (required since 2026-01-01).',
  falsePositives: 'The scan reads the landing page and the opt-out link’s target; a confirmation shown elsewhere (account page, modal opened by an icon) is missed.',
  consumes: ['consent-timeline'] as const,
  evaluate(input: { 'consent-timeline': Artifact[] }, ctx: EvalContext): RawFinding[] {
    const kb = ctx.knowledgeBase ?? DEFAULT_KB;
    const analyses = analyzeArtifacts(input['consent-timeline'], kb);
    const out: RawFinding[] = [];
    for (const a of analyses) {
      if (!a.verified || a.scenario !== 'gpc' || !a.gpcAck || a.gpcAck.found) continue;
      const scope = scopeOf('ccpa.regs.7025c6', a);
      if (!scope) continue;
      const sells = analyses.some((b) => b.locationId === a.locationId && [...b.parties.values()].some((f) => partyCategories(f).some((c) => SALE_SHARE_CATEGORIES.has(c))));
      if (!sells) continue;
      out.push({
        ruleId: DISPLAY_ID,
        requirementId: asRequirementId('ccpa.regs.7025c6'),
        subject: { property: ctx.property, routePattern: '*', instanceUrl: a.site.url, locator: { role: 'opt-out-acknowledgement', name: 'gpc', landmark: scope, ordinal: 0 } },
        confidence: 'needs-review',
        message: `With Global Privacy Control on, the site showed no “opt-out honored” confirmation on the page or behind its opt-out link, from ${placeName(a)}.`,
        details: { scope, pattern: 'no-gpc-acknowledgement', location: a.locationId, scenario: a.scenario, via: a.gpcAck.via },
        evidence: [{ kind: 'interaction-log', steps: [{ gpcAcknowledgement: a.gpcAck, location: a.locationId }] }],
      });
    }
    return out;
  },
};

// --- 5. The opt-out link (California, and every state with a privacy act in force) ----------------------------------------------

const LINK_ID = asRuleId('tracking.opt-out-link');
export const optOutLink: Rule<readonly ['consent-timeline']> = {
  id: LINK_ID,
  requirements: [asRequirementId('ccpa.opt-out-link'), asRequirementId('us-states.opt-out-method')],
  layer: 'browser',
  confidence: 'needs-review',
  detects: 'presence',
  evidence: ['interaction-log'],
  remediation:
    'Put a clear opt-out link in the header or footer — in California “Do Not Sell or Share My Personal Information” (or “Your Privacy Choices” with the opt-out icon); in other states with a privacy act, a link that plainly offers opting out of targeted advertising and sale. Let it opt out without asking for an email or account; don’t rely on a cookie banner alone.',
  falsePositives: 'Link and icon detection read visible text and adjacent images/SVGs; a link inside a collapsed menu or an icon drawn in CSS can be missed. The icon is checked only in California (11 CCR §7015(b)); other states prescribe no wording or icon.',
  consumes: ['consent-timeline'] as const,
  evaluate(input: { 'consent-timeline': Artifact[] }, ctx: EvalContext): RawFinding[] {
    const kb = ctx.knowledgeBase ?? DEFAULT_KB;
    const analyses = analyzeArtifacts(input['consent-timeline'], kb);
    const out: RawFinding[] = [];
    const seen = new Set<string>();
    for (const a of analyses) {
      if (!a.verified || !a.walk) continue;
      const ca = scopeOf('ccpa.opt-out-link', a);
      const st = ca ? undefined : scopeOf('us-states.opt-out-method', a);
      const scope = ca ?? st;
      if (!scope) continue;
      const reqId = ca ? 'ccpa.opt-out-link' : 'us-states.opt-out-method';
      const actName = st ? (usStateAct(scope.slice(3))?.name ?? 'the state privacy law') : '';
      const w = a.walk;
      const mk = (name: string, message: string): void => {
        if (seen.has(`${name}|${scope}`)) return;
        seen.add(`${name}|${scope}`);
        out.push({
          ruleId: LINK_ID,
          requirementId: asRequirementId(reqId),
          subject: { property: ctx.property, routePattern: '*', instanceUrl: a.site.url, locator: { role: 'opt-out-link', name, landmark: scope, ordinal: 0 } },
          confidence: 'needs-review',
          message,
          details: { scope, pattern: name, location: a.locationId, scenario: a.scenario, walk: w },
          evidence: [{ kind: 'interaction-log', steps: [{ ...w }] }],
        });
      };
      if (!w.found) {
        const sells = analyses.some((b) => b.locationId === a.locationId && [...b.parties.values()].some((f) => partyCategories(f).some((c) => SALE_SHARE_CATEGORIES.has(c))));
        if (sells) mk('missing-link', st ? `No clear opt-out link for targeted advertising or sale was found, although advertising parties receive visitor data, from ${placeName(a)} (${actName}).` : `No “Do Not Sell or Share” / “Your Privacy Choices” link was found, although advertising parties receive visitor data, from ${placeName(a)}.`);
        continue;
      }
      if (!st && /your privacy choices/i.test(w.linkText ?? '') && !w.hasIcon) mk('missing-icon', `The “${w.linkText}” link has no opt-out icon next to it; that wording requires the icon (11 CCR §7015(b)).`);
      if (w.requiredFields.length) mk('requires-personal-info', st ? `Opting out through “${w.linkText}” asks for ${w.requiredFields.join(', ')} — extra information for an opt-out is friction, from ${placeName(a)} (${actName}).` : `Opting out through “${w.linkText}” asks for ${w.requiredFields.join(', ')} — extra information for an opt-out is friction the regulations forbid (§7026(c)).`);
      if ((w.steps ?? 0) > 2) mk('too-many-steps', st ? `Opting out through “${w.linkText}” takes ${w.steps} steps, from ${placeName(a)} (${actName}).` : `Opting out through “${w.linkText}” takes ${w.steps} steps.`);
    }
    return out;
  },
};

// --- 6. Wiretap exposure (CA, FL, PA) ---------------------------------------------

const WIRETAP_ID = asRuleId('tracking.wiretap-exposure');
const WIRETAP_REQS = ['cipa.631', 'cipa.638.51', 'fsca.934.03', 'wesca.5703'] as const;
export const wiretapExposure: Rule<readonly ['consent-timeline']> = {
  id: WIRETAP_ID,
  requirements: WIRETAP_REQS.map((r) => asRequirementId(r)) as [RequirementId, ...RequirementId[]],
  layer: 'browser',
  confidence: 'needs-review',
  detects: 'presence',
  evidence: ['network-request', 'interaction-log'],
  remediation:
    'For visitors in all-party-consent states, load session recording, chat and identity-resolution scripts — and ad pixels that receive page addresses — only after an opt-in the visitor saw first. Mask form fields in session recorders.',
  falsePositives:
    'Exposure, not a violation: it is the evidence plaintiffs’ firms use (third-party data before any interaction, from the state, with the contents of what was sent). Whether a claim succeeds depends on courts that are split; §638.51 is volatile (SB 690).',
  consumes: ['consent-timeline'] as const,
  evaluate(input: { 'consent-timeline': Artifact[] }, ctx: EvalContext): RawFinding[] {
    const kb = ctx.knowledgeBase ?? DEFAULT_KB;
    const acc = new Map<string, Acc>();
    const RELEVANT: ReadonlySet<Phase> = new Set<Phase>([...PRE_INTERACTION, 'after-reject', 'after-dismiss', 'after-opt-out-link']);
    for (const a of analyzeArtifacts(input['consent-timeline'], kb)) {
      if (!a.verified) continue;
      const scopes = WIRETAP_REQS.map((r) => ({ r, scope: scopeOf(r, a) })).filter((x) => x.scope);
      if (!scopes.length) continue;
      const scope = scopes[0].scope!;
      for (const f of a.parties.values()) {
        const cats = partyCategories(f);
        const relevantParty = cats.some((c) => WIRETAP_CATEGORIES.has(c)) || (!f.recognized && f.behavesLikeTracker);
        if (!relevantParty) continue;
        const reqs = f.requests.filter((r) => RELEVANT.has(r.phase) && r.dataBearing);
        if (!reqs.length) continue;
        const contents = reqs.some((r) => r.markers.some((m) => m.marker !== 'click-id') || r.kinds.includes('page-title') || r.kinds.includes('search-term')) || cats.includes('session-recording') || cats.includes('chat');
        const addressing = reqs.some((r) => r.kinds.includes('page-address') && (r.kinds.includes('browser-id') || r.kinds.includes('identifier')));
        if (!contents && !addressing) continue;
        let requirementId: string;
        let theory: string;
        if (scope === 'us-ca') {
          requirementId = contents ? 'cipa.631' : 'cipa.638.51';
          theory = contents ? 'California wiretap theory (Penal Code §631 — contents)' : 'California pen-register theory (Penal Code §638.51 — addressing data; volatile, SB 690)';
        } else if (scope === 'us-fl') {
          requirementId = 'fsca.934.03';
          theory = 'Florida wiretap theory (Fla. Stat. §934.03)';
        } else {
          requirementId = 'wesca.5703';
          theory = 'Pennsylvania wiretap theory (18 Pa. C.S. §5703)';
        }
        const notes: string[] = [];
        if (reqs.some((r) => r.phase === 'after-reject')) notes.push('Some of it was sent after the visitor rejected — a California federal court has treated a rejection that leaks as evidence for the plaintiff (S.D. Cal. 2026-08-12).');
        if (reqs.some((r) => r.markers.some((m) => m.marker !== 'click-id'))) notes.push('What the scan typed into a form (and never submitted) reached this party.');
        const key = `${f.partyId}|${scope}`;
        const existing = acc.get(key);
        if (existing && existing.requirementId === 'cipa.638.51' && requirementId === 'cipa.631') {
          existing.requirementId = 'cipa.631';
          existing.theory = theory;
        }
        accumulate(acc, key, () => ({ f, scope, requirementId, violation: false, theory, instanceUrl: a.site.url }), a, reqs, false, notes);
      }
    }
    return [...acc.values()].map((x) =>
      finish(wiretapExposure, x, ctx, `Exposure — ${x.theory}: ${partyLabel(x.f)} received ${sentPhrase([...x.sent])} ${phasePhrase(x.phases)}, from ${joinList([...x.locations])}.`, 'wiretap-exposure'),
    );
  },
};

// --- 7. Unrecognized parties that behave like trackers (all locations) ------------

const UNKNOWN_ID = asRuleId('tracking.unrecognized-party');
export const unrecognizedParty: Rule<readonly ['consent-timeline']> = {
  id: UNKNOWN_ID,
  requirements: [asRequirementId('practice.tracker-inventory')],
  layer: 'browser',
  confidence: 'needs-review',
  detects: 'presence',
  evidence: ['network-request', 'interaction-log'],
  remediation: 'Identify who runs this domain and what it does (the research queue), then add it to the knowledge base with a category so it can be disclosed, contracted and gated.',
  falsePositives: 'Behavior-based: a first-party service on another domain (a CDN for your own API) can match the pattern. The research step settles it.',
  consumes: ['consent-timeline'] as const,
  evaluate(input: { 'consent-timeline': Artifact[] }, ctx: EvalContext): RawFinding[] {
    const kb = ctx.knowledgeBase ?? DEFAULT_KB;
    const acc = new Map<string, Acc>();
    for (const a of analyzeArtifacts(input['consent-timeline'], kb)) {
      if (!a.verified) continue;
      for (const f of a.parties.values()) {
        if (f.recognized || !f.behavesLikeTracker) continue;
        const reqs = f.requests.filter((r) => r.dataBearing);
        accumulate(acc, f.partyId, () => ({ f, scope: 'any', requirementId: 'practice.tracker-inventory', violation: false, instanceUrl: a.site.url }), a, reqs, false, ['Not in the knowledge base — queued for research.']);
      }
    }
    return [...acc.values()].map((x) => {
      const o = x.occurrences[0];
      const stored = [...new Set(x.occurrences.flatMap((y) => y.stored))];
      return finish(
        unrecognizedParty,
        x,
        ctx,
        `Unrecognized: ${x.f.domain} behaves like a tracker — ${loadedPhrase(x.f)}it ${stored.length ? `stored ${joinList(stored.slice(0, 2))} and ` : ''}sent ${sentPhrase([...x.sent])}${o?.firstMs !== undefined ? `, first ${(o.firstMs / 1000).toFixed(1)}s after the visit began` : ''}.`,
        'unrecognized-tracker',
      );
    });
  },
};

export const TRACKING_RULES = [priorConsent, withdrawal, optOutSignal, optOutDisplay, optOutLink, wiretapExposure, unrecognizedParty];
