import {
  LocationVerification,
  BannerFirstLayer,
  BannerSecondLayer,
  BannerAfterChoice,
  BANNER_DESIGN_LABEL,
  BANNER_SECOND_LAYER_LABEL,
  BANNER_AFTER_CHOICE_LABEL,
  controlTextContrast,
  controlEmphasis,
  looksEnglish,
  DO_NOT_SELL_OR_SHARE,
  type Artifact,
  type RawFinding,
  type Evidence,
  type BannerControl,
} from '../../record/index.js';
import type { Rule, EvalContext } from '../types.js';
import { asRuleId, asRequirementId, getRequirement, requirementScopeFor, type RequirementId } from '../../registry/index.js';

// Consent-banner design rules (ticket F6): the dark-pattern findings of
// plans/research-consent-law.md applied to any banner, ours included. Pure
// functions over the banner readouts the consent evaluation records in each
// timeline (record/banner-design.ts; collected in do-nothing, partial and
// after every choice).
//
//   consent.equal-prominence  accept/reject equal weight: same layer, size,
//                             type, surface, contrast, visible without scrolling
//                             (EDPB 03/2022; CBTF ¶¶8, 14, 18; CNIL; ICO 2026;
//                             CCPA Regs §7004(a)(2)(C)–(D))
//   consent.no-pre-ticked     optional categories off by default (Planet49
//                             C-673/17; GDPR Recital 32; CBTF; ICO 2026)
//   consent.no-cookie-wall    page usable when refusing (EDPB 05/2020 ¶¶39–41;
//                             CBTF; ICO 2026) — opt-in locations only
//   consent.required-strings  what the first layer must say (ePrivacy 5(3) / PECR
//                             reg 6 "clear and comprehensive information"; GDPR
//                             Art 7(3) informed of withdrawal before consenting;
//                             CCPA Regs §7013(c)/§7015(b) statutory link labels)
//   consent.withdrawal-control a visible way back into the settings after a
//                             choice (GDPR Art 7(3); CBTF ¶¶31–35)
//
// Applicability is the cited requirement's `jurisdictions` matched against the
// VERIFIED location (EU/UK = opt-in regime; us-ca for §7004 and the opt-out
// link) — the same scoping the tracking rules use. Fail closed: a value the
// browser could not measure produces no finding here and a not-tested note in
// the collector; it is never read as a pass. Fingerprint convention as in
// rules/tracking: site-wide locus '*', jurisdiction in locator.landmark,
// pattern in locator.name.

interface BannerView {
  artifact: Artifact & { kind: 'consent-timeline' };
  location: string;
  place: string;
  scenario: string;
  jurisdictions: string[];
  date: string;
  siteUrl: string;
  first?: BannerFirstLayer;
  second?: BannerSecondLayer;
  after: BannerAfterChoice[];
  bannerShot?: string;
  withdrawNoEntry: boolean;
}

function readoutsOf(events: unknown[], label: string): unknown[] {
  return events
    .filter((e): e is { type: string; label: string; data: unknown } => typeof e === 'object' && e !== null && (e as { type?: unknown }).type === 'consent-readout' && (e as { label?: unknown }).label === label)
    .map((e) => e.data);
}

/** One view per verified location, merging that location's scenarios (first readout wins; an opened settings layer beats a DOM read). */
export function bannerViews(artifacts: Artifact[]): BannerView[] {
  const byLocation = new Map<string, BannerView>();
  for (const a of artifacts) {
    if (a.kind !== 'consent-timeline') continue;
    const v = LocationVerification.safeParse(a.verification);
    if (!v.success || v.data.verdict !== 'verified') continue;
    const loc = a.location as { id?: string; label?: string };
    const id = typeof loc.id === 'string' ? loc.id : 'unknown';
    const snap = a.snapshot as { startedAt?: string; site?: { url?: string } };
    let view = byLocation.get(id);
    if (!view) {
      const o = v.data.observed;
      view = {
        artifact: a,
        location: id,
        place: id === 'local' ? `this machine (${[o.country, o.region].filter(Boolean).join('-') || 'unverified'})` : loc.label && loc.label.toLowerCase() !== id ? `${loc.label} (${id})` : id,
        scenario: a.scenario,
        jurisdictions: v.data.jurisdictions,
        date: (snap.startedAt ?? a.capturedAt).slice(0, 10),
        siteUrl: snap.site?.url ?? a.subject.instanceUrl ?? '',
        after: [],
        withdrawNoEntry: false,
      };
      byLocation.set(id, view);
    }
    const events = a.events as unknown[];
    if (!view.first) {
      const f = readoutsOf(events, BANNER_DESIGN_LABEL).map((d) => BannerFirstLayer.safeParse(d)).find((r) => r.success);
      if (f?.success) {
        view.first = f.data;
        view.artifact = a;
        view.scenario = a.scenario;
        const shot = events.find((e) => (e as { type?: string; label?: string }).type === 'screenshot' && (e as { label?: string }).label === 'banner') as { path?: string } | undefined;
        view.bannerShot = shot?.path;
      }
    }
    for (const d of readoutsOf(events, BANNER_SECOND_LAYER_LABEL)) {
      const s = BannerSecondLayer.safeParse(d);
      if (!s.success || !s.data.toggles.length) continue;
      if (!view.second || (view.second.via === 'dom' && s.data.via === 'opened')) view.second = s.data;
    }
    for (const d of readoutsOf(events, BANNER_AFTER_CHOICE_LABEL)) {
      const s = BannerAfterChoice.safeParse(d);
      if (s.success) view.after.push(s.data);
    }
    if (a.scenario === 'withdraw') {
      const noEntry = events.some((e) => {
        const x = e as { type?: string; choice?: string; note?: string };
        return x.type === 'choice' && x.choice === 'withdraw' && /no way to reopen/i.test(x.note ?? '');
      });
      view.withdrawNoEntry = view.withdrawNoEntry || noEntry;
    }
  }
  return [...byLocation.values()];
}

/** The first requirement (in order) that reaches this location, with its scope code. */
function scopeFor(view: BannerView, ids: readonly string[]): { requirementId: string; scope: string } | undefined {
  for (const id of ids) {
    const req = getRequirement(id);
    const scope = req ? requirementScopeFor(req, view.jurisdictions, view.date) : undefined;
    if (scope) return { requirementId: id, scope };
  }
  return undefined;
}

function finding(
  ruleId: string,
  view: BannerView,
  hit: { requirementId: string; scope: string },
  pattern: string,
  confidence: 'violation' | 'needs-review',
  message: string,
  details: Record<string, unknown>,
  role = 'consent-banner',
): RawFinding {
  const evidence: Evidence[] = [
    {
      kind: 'interaction-log',
      steps: [{ location: view.location, scenario: view.scenario, pattern, ...details }],
    },
  ];
  if (view.bannerShot) evidence.push({ kind: 'screenshot', path: view.bannerShot, region: view.first?.bannerBox, pageState: `${view.location}/${view.scenario}: banner` });
  return {
    ruleId: asRuleId(ruleId),
    requirementId: asRequirementId(hit.requirementId),
    subject: { property: '', routePattern: '*', instanceUrl: view.siteUrl, locator: { role, name: pattern, landmark: hit.scope, ordinal: 0 } },
    confidence,
    message,
    details: { scope: hit.scope, pattern, location: view.location, scenario: view.scenario, source: view.first?.source, cmp: view.first?.cmp, ...details },
    evidence,
  };
}

const withProperty = (f: RawFinding, ctx: EvalContext): RawFinding => ({ ...f, subject: { ...f.subject, property: ctx.property } });
const round = (n: number, d = 2): number => Math.round(n * 10 ** d) / 10 ** d;
const area = (c: BannerControl): number => c.box.width * c.box.height;
const shown = (c: BannerControl | undefined): c is BannerControl => Boolean(c && c.box.width > 1 && c.box.height > 1);
/** Exact selectors (our tool, a known consent tool) can assert absence; the heuristic cannot. */
const exact = (f: BannerFirstLayer): boolean => f.source === 'complykit' || f.source === 'known-selector';

// --- 1. Equal prominence ------------------------------------------------------------

// Thresholds. Deliberately loose — a finding means "a person should look", and
// each one cites the measured numbers. Area ≥ 2× or font ≥ 1.3× or weight
// ≥ +300 is a size asymmetry; a surface ≥ 2.5:1 against the banner next to one
// < 1.3:1 (no fill, no border) is the "colored button vs text link" pattern the
// taskforce and §7004(a)(2)(D) describe; reject text below 4.5:1 (WCAG 1.4.3,
// used as the "readable" yardstick for CBTF ¶18) while accept clears it.
export const PROMINENCE = { areaRatio: 2, fontRatio: 1.3, weightDelta: 300, strongSurface: 2.5, noSurface: 1.3, readable: 4.5 } as const;

const PROMINENCE_ID = 'consent.equal-prominence';
const PROMINENCE_REQS = ['gdpr.art4.11', 'uk-gdpr.art4.11', 'ccpa.regs.7004'] as const;

export const equalProminence: Rule<readonly ['consent-timeline']> = {
  id: asRuleId(PROMINENCE_ID),
  requirements: PROMINENCE_REQS.map((r) => asRequirementId(r)) as [RequirementId, ...RequirementId[]],
  layer: 'browser',
  confidence: 'violation',
  detects: 'presence',
  evidence: ['interaction-log'],
  remediation:
    'Put “Reject all” on the first layer next to “Accept all”, as the same kind of element with the same size, font, fill and contrast — and both visible without scrolling. Order is free; weight is not.',
  falsePositives:
    'Measured from computed styles at one viewport (1280×800). A banner found by the heuristic may have a reject control with unusual wording that was not matched; images or gradients behind a button make its contrast unmeasurable (reported as not tested, not as a pass).',
  consumes: ['consent-timeline'] as const,
  evaluate(input: { 'consent-timeline': Artifact[] }, ctx: EvalContext): RawFinding[] {
    const out: RawFinding[] = [];
    for (const view of bannerViews(input['consent-timeline'])) {
      const f = view.first;
      if (!f?.found) continue;
      const hit = scopeFor(view, PROMINENCE_REQS);
      if (!hit) continue;
      const optIn = hit.requirementId !== 'ccpa.regs.7004';
      const accept = f.controls.find((c) => c.role === 'accept');
      const reject = f.controls.find((c) => c.role === 'reject');
      const manage = f.controls.find((c) => c.role === 'manage');
      const add = (pattern: string, confidence: 'violation' | 'needs-review', message: string, details: Record<string, unknown>): void => {
        out.push(withProperty(finding(PROMINENCE_ID, view, hit, pattern, confidence, message, details), ctx));
      };
      if (!shown(accept)) continue; // nothing is being asked on this layer (or accept was not identified)
      if (!shown(reject)) {
        // Opt-in: refusing must be possible on the same layer as accepting.
        // California: only the (a)(2)(C) shape — Accept All next to a "more
        // information / preferences" control and nothing else.
        if (optIn) {
          add(
            'no-reject-first-layer',
            exact(f) ? 'violation' : 'needs-review',
            `The banner's first layer offers “${accept.text}” but no reject${manage ? ` — refusing goes through “${manage.text}”` : ''}, from ${view.place}. Refusing must be as easy as accepting, on the same layer.`,
            { accept: accept.text, manage: manage?.text },
          );
        } else if (shown(manage)) {
          add('accept-and-more-info-only', 'needs-review', `The banner pairs “${accept.text}” with only “${manage.text}” — not a symmetrical choice under CCPA Regs §7004(a)(2)(C), from ${view.place}.`, { accept: accept.text, manage: manage.text });
        }
        continue;
      }
      const sizes = {
        accept: { area: round(area(accept), 0), fontSizePx: accept.fontSizePx, fontWeight: accept.fontWeight, tag: accept.tag },
        reject: { area: round(area(reject), 0), fontSizePx: reject.fontSizePx, fontWeight: reject.fontWeight, tag: reject.tag },
      };
      // Size and type.
      const areaRatio = area(reject) > 0 ? area(accept) / area(reject) : Infinity;
      const fontRatio = reject.fontSizePx > 0 ? accept.fontSizePx / reject.fontSizePx : 1;
      const weightDelta = accept.fontWeight - reject.fontWeight;
      const sizeReasons: string[] = [];
      if (areaRatio >= PROMINENCE.areaRatio) sizeReasons.push(`accept is ${round(areaRatio, 1)}× the area of reject`);
      if (fontRatio >= PROMINENCE.fontRatio) sizeReasons.push(`accept text is ${round(fontRatio, 1)}× larger`);
      if (weightDelta >= PROMINENCE.weightDelta) sizeReasons.push(`accept is bold (${accept.fontWeight}) and reject is not (${reject.fontWeight})`);
      if (sizeReasons.length) {
        add('size', 'needs-review', `“${accept.text}” is more prominent than “${reject.text}”: ${sizeReasons.join('; ')}, from ${view.place}.`, { ...sizes, areaRatio: round(areaRatio), fontRatio: round(fontRatio), weightDelta });
      }
      // Surface: a filled button next to a bare link.
      const accEm = controlEmphasis(accept, f.bannerBackgrounds);
      const rejEm = controlEmphasis(reject, f.bannerBackgrounds);
      if (accEm !== undefined && rejEm !== undefined && accEm >= PROMINENCE.strongSurface && rejEm < PROMINENCE.noSurface && !reject.bordered) {
        const link = reject.tag === 'a' && accept.tag !== 'a';
        add(
          'emphasis',
          'needs-review',
          `“${accept.text}” is a filled button standing out from the banner (${round(accEm, 1)}:1) while “${reject.text}” has no fill or border${link ? ' and is a text link' : ''} (${round(rejEm, 1)}:1), from ${view.place}.`,
          { ...sizes, acceptSurface: round(accEm), rejectSurface: round(rejEm), rejectBordered: reject.bordered, acceptBordered: accept.bordered },
        );
      }
      // Readability of reject.
      const accTx = controlTextContrast(accept);
      const rejTx = controlTextContrast(reject);
      if (rejTx !== undefined && rejTx < PROMINENCE.readable && (accTx === undefined || accTx >= PROMINENCE.readable || rejTx < 3)) {
        add('reject-low-contrast', 'needs-review', `“${reject.text}” text contrast is ${round(rejTx, 1)}:1${accTx !== undefined ? ` (accept: ${round(accTx, 1)}:1)` : ''} — refusing is harder to read than accepting, from ${view.place}.`, { rejectContrast: round(rejTx), acceptContrast: accTx === undefined ? null : round(accTx), rejectColor: reject.color });
      }
      // Visible without scrolling.
      if (accept.inViewport && accept.reachable && !(reject.inViewport && reject.reachable)) {
        add(
          'reject-needs-scroll',
          'needs-review',
          `“${accept.text}” is visible on arrival but “${reject.text}” is ${reject.inViewport ? 'covered or clipped inside the banner' : 'outside the viewport'} — the visitor must scroll to refuse, from ${view.place}.`,
          { order: f.controls.slice().sort((a, b) => a.domIndex - b.domIndex).map((c) => c.role), rejectBox: reject.box, acceptBox: accept.box },
        );
      }
    }
    return out;
  },
};

// --- 2. No pre-ticked optional categories --------------------------------------------

const NECESSARY_LABEL = /strictly|necessary|essential|required|always active|nécessaire|notwendig|erforderlich|imprescindible|necessari/i;
const PURPOSE_LABEL = /analytic|statistic|marketing|advertis|targeting|personali[sz]|performance|social|tracking|measurement|audience|profil/i;
const LEGIT_INTEREST = /legitimate interest|berechtigtes interesse|intérêt légitime/i;
const PRETICK_ID = 'consent.no-pre-ticked';
const PRETICK_REQS = ['gdpr.art4.11', 'uk-gdpr.art4.11'] as const;

export const noPreTicked: Rule<readonly ['consent-timeline']> = {
  id: asRuleId(PRETICK_ID),
  requirements: PRETICK_REQS.map((r) => asRequirementId(r)) as [RequirementId, ...RequirementId[]],
  layer: 'browser',
  confidence: 'violation',
  detects: 'presence',
  evidence: ['interaction-log'],
  remediation: 'Render every optional category (and any “legitimate interest” toggle for trackers) switched off until the visitor turns it on. Only strictly necessary storage may be on by default, shown as locked.',
  falsePositives:
    'Toggles are matched inside consent-tool containers by id/class; a toggle whose label cannot be read is reported as needs-review. A tool that pre-ticks in its settings but stores “denied” until saved still shows the visitor a pre-ticked box — that is the finding.',
  consumes: ['consent-timeline'] as const,
  evaluate(input: { 'consent-timeline': Artifact[] }, ctx: EvalContext): RawFinding[] {
    const out: RawFinding[] = [];
    for (const view of bannerViews(input['consent-timeline'])) {
      const s = view.second;
      if (!s) continue;
      const hit = scopeFor(view, PRETICK_REQS);
      if (!hit) continue;
      const ticked = s.toggles.filter((t) => t.checked && !t.disabled && !NECESSARY_LABEL.test(t.label) && !(t.category && t.category === 'necessary'));
      if (!ticked.length) continue;
      const clear = ticked.filter((t) => PURPOSE_LABEL.test(t.label) || LEGIT_INTEREST.test(t.label) || (s.source === 'complykit' && t.category));
      const li = ticked.filter((t) => LEGIT_INTEREST.test(t.label));
      const labels = ticked.slice(0, 8).map((t) => t.label);
      out.push(
        withProperty(
          finding(
            PRETICK_ID,
            view,
            hit,
            'pre-ticked',
            clear.length ? 'violation' : 'needs-review',
            `The settings layer shows ${ticked.length} optional toggle(s) already switched on before any choice${li.length ? `, including ${li.length} “legitimate interest” toggle(s)` : ''}: ${labels.map((l) => `“${l}”`).join(', ')}, from ${view.place}. A pre-ticked box is not consent.`,
            { toggles: ticked.slice(0, 20), via: s.via, settingsSource: s.source },
            'consent-settings',
          ),
          ctx,
        ),
      );
    }
    return out;
  },
};

// --- 3. No cookie wall (opt-in) -----------------------------------------------------

const WALL_WORDING = /\b((must|need to|have to|required to) accept|accept (all )?(cookies )?(to|in order to) (continue|use|access|enter|view|read)|without accepting[^.]{0,40}(cannot|can't|not able|unable)|accept or (pay|subscribe))\b/i;
const WALL_ID = 'consent.no-cookie-wall';
const WALL_REQS = ['gdpr.art4.11', 'uk-gdpr.art4.11'] as const;

const blocked = (b: { covered: number | null; inert: boolean; scrollLocked: boolean; scrollable: boolean } | undefined): string[] => {
  if (!b) return [];
  const why: string[] = [];
  if (b.inert) why.push('the page behind it is inert');
  if (b.covered !== null && b.covered >= 0.8) why.push(`${Math.round(b.covered * 100)}% of the page is covered`);
  if (b.scrollLocked && b.scrollable) why.push('scrolling is locked');
  return why;
};

export const noCookieWall: Rule<readonly ['consent-timeline']> = {
  id: asRuleId(WALL_ID),
  requirements: WALL_REQS.map((r) => asRequirementId(r)) as [RequirementId, ...RequirementId[]],
  layer: 'browser',
  confidence: 'violation',
  detects: 'presence',
  evidence: ['interaction-log'],
  remediation: 'Let visitors refuse and still use the site. A modal banner is acceptable only with a reject as easy as accept, and the page must be usable after refusing.',
  falsePositives:
    'A modal banner that offers an equal reject is not reported — blocking until a choice is made is not a cookie wall by itself. Scroll locks set for other reasons (an open menu) can be misread; scroll lock alone is needs-review.',
  consumes: ['consent-timeline'] as const,
  evaluate(input: { 'consent-timeline': Artifact[] }, ctx: EvalContext): RawFinding[] {
    const out: RawFinding[] = [];
    for (const view of bannerViews(input['consent-timeline'])) {
      const hit = scopeFor(view, WALL_REQS);
      if (!hit) continue;
      const f = view.first;
      const add = (pattern: string, confidence: 'violation' | 'needs-review', message: string, details: Record<string, unknown>): void => {
        out.push(withProperty(finding(WALL_ID, view, hit, pattern, confidence, message, details), ctx));
      };
      // After refusing, the page is still unusable: the wall itself.
      const afterReject = view.after.find((a) => a.choice === 'reject');
      const stillBlocked = blocked(afterReject?.blocking);
      if (afterReject && stillBlocked.length) {
        const strong = afterReject.blocking!.inert || (afterReject.blocking!.covered ?? 0) >= 0.8;
        add('blocked-after-reject', strong ? 'violation' : 'needs-review', `After rejecting, the page is still unusable — ${stillBlocked.join(', ')}, from ${view.place}.`, { blocking: afterReject.blocking, bannerStillVisible: afterReject.bannerVisible });
        continue;
      }
      if (!f?.found) continue;
      const accept = f.controls.find((c) => c.role === 'accept');
      const reject = f.controls.find((c) => c.role === 'reject');
      const why = blocked(f.blocking);
      if (why.length && shown(accept) && !shown(reject)) {
        add('blocking-without-reject', 'needs-review', `The banner blocks the page (${why.join(', ')}) and its first layer offers “${accept.text}” but no reject — only accepting unblocks it, from ${view.place}.`, { blocking: f.blocking, modal: f.modal });
        continue;
      }
      if (looksEnglish(f.text) && WALL_WORDING.test(f.text)) {
        const m = WALL_WORDING.exec(f.text);
        add('wall-wording', 'needs-review', `The banner tells visitors they must accept to use the site (“${m?.[0]}”), from ${view.place}.`, { excerpt: m?.[0] });
      }
    }
    return out;
  },
};

// --- 4. Required strings per regime ---------------------------------------------------

// What the first layer must say, per regime (English patterns; tolerant).
// TODO(F2): share this list with src/record/consent-strings-guard.ts, which
// checks the same duties on a config's string overrides at generation time.
export const REQUIRED_WORDING = {
  'opt-in': [
    { id: 'storage', requirement: 'eprivacy', what: 'that cookies or similar technologies are stored/read', re: /cookie|similar technolog|tracking technolog|local storage|pixel|tracker|device (storage|identifier)|store (and|or) (access|read)/i },
    { id: 'purposes', requirement: 'eprivacy', what: 'what they are used for (analytics, advertising, …)', re: /analytic|statistic|advertis|marketing|personali[sz]|measur|performance|targeting|social media|audience|profil|insight/i },
    { id: 'withdrawal', requirement: 'art7.3', what: 'that consent can be withdrawn / changed at any time', re: /withdraw|revoke|change (your )?(mind|choice|consent|settings|preferences)|at any time|any time|anytime/i },
  ],
} as const;

const STATUTORY_LINK = new RegExp(`\\b${DO_NOT_SELL_OR_SHARE.replace(/ /g, '\\s+')}\\b|\\byour\\s+(california\\s+)?privacy\\s+choices\\b`, 'i');
const STRINGS_ID = 'consent.required-strings';
const STRINGS_REQS = ['eprivacy.art5.3', 'pecr.reg6', 'gdpr.art7.3', 'uk-gdpr.art7.3', 'ccpa.opt-out-link'] as const;

export const requiredStrings: Rule<readonly ['consent-timeline']> = {
  id: asRuleId(STRINGS_ID),
  requirements: STRINGS_REQS.map((r) => asRequirementId(r)) as [RequirementId, ...RequirementId[]],
  layer: 'browser',
  confidence: 'needs-review',
  detects: 'presence',
  evidence: ['interaction-log'],
  remediation:
    'Opt-in (EU/UK): say on the first layer that cookies/similar technologies are used, for which purposes, where to read more, and that consent can be withdrawn at any time. California: label the opt-out link exactly “Do Not Sell or Share My Personal Information”, or “Your Privacy Choices” with the opt-out icon.',
  falsePositives: 'English patterns only (other languages are reported as not tested). Wording is matched tolerantly; a banner that conveys a point in unusual words is flagged for a person to read.',
  consumes: ['consent-timeline'] as const,
  evaluate(input: { 'consent-timeline': Artifact[] }, ctx: EvalContext): RawFinding[] {
    const out: RawFinding[] = [];
    for (const view of bannerViews(input['consent-timeline'])) {
      const f = view.first;
      if (!f) continue;
      const info = scopeFor(view, ['eprivacy.art5.3', 'pecr.reg6']);
      const withdraw = scopeFor(view, ['gdpr.art7.3', 'uk-gdpr.art7.3']);
      if (f.found && info && looksEnglish(f.text)) {
        const missing = REQUIRED_WORDING['opt-in'].filter((w) => !w.re.test(f.text));
        for (const w of missing) {
          const hit = w.requirement === 'art7.3' ? withdraw : info;
          if (!hit) continue;
          out.push(withProperty(finding(STRINGS_ID, view, hit, `missing-${w.id}`, 'needs-review', `The banner's first layer does not say ${w.what}, from ${view.place}.`, { excerpt: f.text.slice(0, 300) }), ctx));
        }
        const furtherInfo = f.links.length > 0 || f.controls.some((c) => c.role === 'manage');
        if (!furtherInfo) {
          out.push(withProperty(finding(STRINGS_ID, view, info, 'missing-further-information', 'needs-review', `The banner's first layer has no link or control to more information (privacy/cookie policy, settings, third parties), from ${view.place}.`, { excerpt: f.text.slice(0, 300) }), ctx));
        }
      }
      // California: the opt-out link's label must be the statutory wording.
      const ca = scopeFor(view, ['ccpa.opt-out-link']);
      if (ca && f.optOutLinks.length && !f.optOutLinks.some((l) => STATUTORY_LINK.test(l.text))) {
        out.push(
          withProperty(
            finding(STRINGS_ID, view, ca, 'non-statutory-opt-out-label', 'needs-review', `The opt-out link reads ${f.optOutLinks.slice(0, 3).map((l) => `“${l.text}”`).join(', ')} — not “${DO_NOT_SELL_OR_SHARE}” or “Your Privacy Choices” (11 CCR §7013(c), §7015(b)), from ${view.place}.`, { links: f.optOutLinks.slice(0, 5) }, 'opt-out-link'),
            ctx,
          ),
        );
      }
    }
    return out;
  },
};

// --- 5. Withdrawal control present after a choice -------------------------------------

const WITHDRAWAL_ID = 'consent.withdrawal-control';
const WITHDRAWAL_REQS = ['gdpr.art7.3', 'uk-gdpr.art7.3'] as const;

export const withdrawalControl: Rule<readonly ['consent-timeline']> = {
  id: asRuleId(WITHDRAWAL_ID),
  requirements: WITHDRAWAL_REQS.map((r) => asRequirementId(r)) as [RequirementId, ...RequirementId[]],
  layer: 'browser',
  confidence: 'needs-review',
  detects: 'presence',
  evidence: ['interaction-log'],
  remediation: 'After a choice, keep a visible way back into the consent settings on every page: a floating “Privacy choices” button or a footer link (“Cookie settings”), or mark your own link with data-complykit-open.',
  falsePositives:
    'Looks for our tool’s Privacy choices button and [data-complykit-open], the common consent tools’ floating widgets, and settings-link wording anywhere on the page; a link with unusual wording or inside a collapsed menu is missed.',
  consumes: ['consent-timeline'] as const,
  evaluate(input: { 'consent-timeline': Artifact[] }, ctx: EvalContext): RawFinding[] {
    const out: RawFinding[] = [];
    for (const view of bannerViews(input['consent-timeline'])) {
      if (!view.after.length) continue;
      const hit = scopeFor(view, WITHDRAWAL_REQS);
      if (!hit) continue;
      if (view.after.some((a) => a.controls.length > 0)) continue;
      const api = view.after.find((a) => a.api)?.api;
      // No entry point at all, and the withdraw scenario already said so: tracking.withdrawal reports it.
      if (!api && view.withdrawNoEntry) continue;
      const choices = [...new Set(view.after.map((a) => a.choice))].join(' and ');
      out.push(
        withProperty(
          finding(
            WITHDRAWAL_ID,
            view,
            hit,
            api ? 'api-only' : 'no-control',
            'needs-review',
            api
              ? `After ${choices === 'accept' ? 'accepting' : choices === 'reject' ? 'rejecting' : 'choosing'}, no visible link or button reopens the consent settings — the consent tool has an API (${api}) but nothing on the page calls it for the visitor, from ${view.place}.`
              : `After ${choices === 'accept' ? 'accepting' : choices === 'reject' ? 'rejecting' : 'choosing'}, no visible link or button reopens the consent settings, from ${view.place}. Withdrawing must be as easy as consenting.`,
            { choices, api },
            'consent-withdrawal',
          ),
          ctx,
        ),
      );
    }
    return out;
  },
};
