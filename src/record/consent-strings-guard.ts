// Guardrails for the consent tool's string overrides (ticket F2).
//
// Pure and dependency-free (type-only imports), next to the config guard, so
// every side that holds a config can call it: the zod schema (generation time,
// errors refuse the config), the scanner / report (warnings become notes) and
// any build-time check. The client does NOT call it: it trusts the generator
// (the hash says whether the config was edited since) and stays small.
//
// The tool's defaults (client/src/ui/strings.ts) satisfy every rule here; what
// is checked is what an owner's overrides would make the visitor read. An
// override can never DROP a string outright — the tool falls back to its
// default for a key the config does not set — so "dropping" a required string
// means replacing it with words that no longer say the required thing.
//
// Lookup the client uses, per regime r and key k:
//   strings[lang].byRegime[r][k] → strings[lang][k] → the tool's default.
// So a base-table override is checked against EVERY regime it is not itself
// overridden in.
//
// Sources (plans/research-consent-law.md, docs/guide/banner-copy.md):
//   - CCPA Regs §7013(c) / §7015(b): the "Do Not Sell or Share My Personal
//     Information" link, or the alternative "Your Privacy Choices" link with
//     the opt-out icon (research §1.1).
//   - CCPA Regs §7004 dark patterns: asymmetry, silence/closing is not consent,
//     false urgency, confirmshaming (research §1.2).
//   - EDPB Cookie Banner Taskforce report 2023 / ICO 2026 guidance: reject on
//     the same layer as accept, not relabelled as a settings link; no
//     "legitimate interest" for trackers; no cookie walls; pre-ticked boxes
//     invalid (Planet49) (research §3.1, §3.3).
//   - Connecticut AG: "By continuing to browse…" is not consent (research §1.5).
//   - FTC §5: "we don't sell" while pixels transmit is deception (research §1.5).
//
// The wording rules are English; other languages are reported as unverified
// (a warning that needs a human), never as passing.

import type { ConsentStringKey, ConsentStringTable, Regime } from './consent-config-guard.js';

export type ConsentStringIssueSeverity = 'error' | 'warning';

export type ConsentStringRule =
  | 'blank'
  | 'opt-in-reject'
  | 'reject-as-settings'
  | 'opt-out-signal-wording'
  | 'privacy-choices-wording'
  | 'ambiguous-accept'
  | 'implied-consent'
  | 'pre-ticked'
  | 'legitimate-interest'
  | 'false-urgency'
  | 'confirmshaming'
  | 'cookie-wall'
  | 'no-sale-claim'
  | 'filler'
  | 'unverified-language';

export interface ConsentStringIssue {
  severity: ConsentStringIssueSeverity;
  rule: ConsentStringRule;
  /** Path inside the config: ['strings', lang, key] or ['strings', lang, 'byRegime', regime, key]. */
  path: (string | number)[];
  lang: string;
  key: ConsentStringKey;
  /** Regimes in which the visitor would read this override. */
  regimes: Regime[];
  message: string;
}

const REGIME_LIST: readonly Regime[] = ['opt-in', 'opt-out-signal', 'opt-out'];

/** The statutory label (CCPA §1798.135(a)(1), Regs §7013(c)). "Info" is not accepted: say it in full. */
export const DO_NOT_SELL_OR_SHARE = 'Do Not Sell or Share My Personal Information';
const DNSS = /\bdo not sell or share my personal information\b/i;
/** The alternative opt-out link title, Regs §7015(b). */
const YOUR_PRIVACY_CHOICES = /\byour (california )?privacy choices\b/i;

const REJECT_LIKE = /\b(reject|decline|refuse|deny|disagree|opt[ -]?out|do not (accept|allow|consent|sell)|don'?t (accept|allow|consent)|(only|strictly) (necessary|essential)|(necessary|essential)( cookies)? only)\b/i;
const SETTINGS_LIKE = /\b(settings|preferences|options|manage|customi[sz]e|more info(rmation)?|learn more|details|purposes|configure|choices)\b/i;
const AMBIGUOUS_ACCEPT = /^\s*(ok(ay)?|got it|continue|close|x|dismiss|i understand|understood|fine|sounds good)\s*[.!]?\s*$/i;

/** Wording rules that apply to every key, in every regime unless `only` says otherwise. */
const PATTERNS: Array<{ rule: ConsentStringRule; re: RegExp; severity: ConsentStringIssueSeverity; only?: Regime; message: string }> = [
  {
    rule: 'implied-consent',
    re: /\b(by (continuing|using|browsing|staying|scrolling|clicking anywhere)|continu(e|ing) to (browse|use)|if you (continue|keep browsing|stay))\b/i,
    severity: 'error',
    message: 'implies consent from browsing or inaction; silence and navigating on are not consent (CCPA Regs §7004(a)(3); Connecticut AG; CNIL)',
  },
  {
    rule: 'pre-ticked',
    re: /\b(pre-?(ticked|checked|selected|enabled)|(enabled|on|selected|checked|ticked|active) by default|already (enabled|turned on|selected|active))\b/i,
    severity: 'error',
    only: 'opt-in',
    message: 'describes optional categories as on before a choice; under opt-in nothing but necessary is on and pre-ticked boxes are invalid (Planet49 C-673/17; ICO 2026)',
  },
  {
    rule: 'legitimate-interest',
    re: /\blegitimate interests?\b/i,
    severity: 'error',
    message: '"legitimate interest" can never justify trackers (EDPB Cookie Banner Taskforce ¶24; ICO 2026)',
  },
  {
    rule: 'false-urgency',
    re: /\b(hurry|act now|limited time|expires? (in|soon)|only \d+ (seconds?|minutes?) left|countdown)\b/i,
    severity: 'error',
    message: 'false urgency is a dark pattern (CCPA Regs §7004(a)(3)(E))',
  },
  {
    rule: 'confirmshaming',
    re: /\b(no,? i (don'?t|do not) (want|like|care)|i (don'?t|do not) (care|want) (about|a better)|i prefer (a )?(worse|less relevant|broken))\b/i,
    severity: 'error',
    message: 'guilt or shame wording on the refusal is a dark pattern (CCPA Regs §7004(a)(2), (a)(4))',
  },
  {
    rule: 'cookie-wall',
    re: /\b((must|need to|have to|required to) accept|accept (all )?(cookies )?to (continue|use|access|enter|view))\b/i,
    severity: 'error',
    message: 'conditions access on accepting; cookie walls are generally invalid consent (EDPB Cookie Banner Taskforce; research §3.1)',
  },
  {
    rule: 'no-sale-claim',
    re: /\bwe (do not|don'?t|never) (sell|share)\b/i,
    severity: 'warning',
    message: '"we do not sell/share" is deceptive when pixels transmit to ad platforms (FTC §5; CCPA §1798.140(ah)); keep it only if counsel confirms it',
  },
  {
    rule: 'filler',
    re: /\b(we (value|care about|respect|take) your privacy|your privacy (matters|is important))\b/i,
    severity: 'warning',
    message: 'filler that does not state a purpose; say what is used for what (EDPB / ICO: clear, specific purpose)',
  },
];

const isEnglish = (lang: string): boolean => lang === 'en' || lang.startsWith('en-');

/** Keys whose wording carries legal weight: overridden in another language, a human has to check them. */
const PROTECTED_KEYS: readonly ConsentStringKey[] = [
  'banner.reject',
  'banner.accept',
  'settings.rejectAll',
  'settings.acceptAll',
  'privacyChoices.link',
  'optOut.link',
  'withdraw.recall',
];

/**
 * Check a config's `strings` overrides. Errors make the config unusable (the
 * zod schema refuses it); warnings are for the report / the owner to review.
 * Non-objects are ignored (the schema reports the shape).
 */
export function validateConsentStrings(strings: unknown): ConsentStringIssue[] {
  const out: ConsentStringIssue[] = [];
  if (typeof strings !== 'object' || strings === null) return out;
  for (const [lang, raw] of Object.entries(strings as Record<string, unknown>)) {
    if (typeof raw !== 'object' || raw === null) continue;
    const table = raw as ConsentStringTable;
    const byRegime = (typeof table.byRegime === 'object' && table.byRegime) || {};
    // Every (key, value, where) an override sets, with the regimes it reaches.
    const seen: Array<{ key: ConsentStringKey; value: string; path: (string | number)[]; regimes: Regime[] }> = [];
    for (const [k, v] of Object.entries(table)) {
      if (k === 'byRegime' || typeof v !== 'string') continue;
      const key = k as ConsentStringKey;
      const regimes = REGIME_LIST.filter((r) => typeof byRegime[r]?.[key] !== 'string');
      seen.push({ key, value: v, path: ['strings', lang, key], regimes });
    }
    for (const r of REGIME_LIST) {
      const t = byRegime[r];
      if (typeof t !== 'object' || t === null) continue;
      for (const [k, v] of Object.entries(t)) {
        if (typeof v === 'string') seen.push({ key: k as ConsentStringKey, value: v, path: ['strings', lang, 'byRegime', r, k], regimes: [r] });
      }
    }
    for (const s of seen) {
      const add = (severity: ConsentStringIssueSeverity, rule: ConsentStringRule, regimes: Regime[], message: string): void => {
        out.push({ severity, rule, path: s.path, lang, key: s.key, regimes, message });
      };
      if (!s.value.trim()) {
        add('error', 'blank', s.regimes, `"${s.key}" is blank; it would blank a control or a required notice`);
        continue;
      }
      if (s.regimes.length === 0) continue; // shadowed in every regime: nobody reads it
      if (!isEnglish(lang)) {
        if (PROTECTED_KEYS.includes(s.key)) add('warning', 'unverified-language', s.regimes, `"${s.key}" in "${lang}" carries legal weight and cannot be checked automatically; needs review by someone who reads ${lang}`);
        continue;
      }
      checkEnglish(s.key, s.value, s.regimes, add);
    }
  }
  return out;
}

function checkEnglish(
  key: ConsentStringKey,
  value: string,
  regimes: Regime[],
  add: (severity: ConsentStringIssueSeverity, rule: ConsentStringRule, regimes: Regime[], message: string) => void,
): void {
  const optIn = regimes.filter((r) => r === 'opt-in');
  const signal = regimes.filter((r) => r === 'opt-out-signal');
  const isReject = key === 'banner.reject' || key === 'settings.rejectAll';
  const isAccept = key === 'banner.accept' || key === 'settings.acceptAll';

  if (isReject) {
    // A reject that reads like a door to more settings is the pattern regulators
    // name first (EDPB CBTF ¶¶8, 14; CPPA Regs §7004(a)(2)(C)).
    if (SETTINGS_LIKE.test(value) && !REJECT_LIKE.test(value)) {
      add('error', 'reject-as-settings', regimes, `"${key}" ("${value}") reads as a settings link, not a refusal; reject must be a one-step choice on the same layer as accept (EDPB CBTF ¶¶8, 14; CCPA Regs §7004(a)(2)(C))`);
    } else if (optIn.length && !REJECT_LIKE.test(value)) {
      add('error', 'opt-in-reject', optIn, `"${key}" ("${value}") does not say reject; under opt-in a reject option as clear as accept is required (EDPB CBTF; ICO 2026; CNIL)`);
    }
  }
  // Under opt-out-signal the settings layer is where "Your Privacy Choices" lands, so
  // its refusal carries the statutory wording (Sling TV: the link led only to cookie
  // preferences). The banner's reject may say "Reject all".
  if ((key === 'settings.rejectAll' || key === 'optOut.link') && signal.length && !DNSS.test(value)) {
    add('error', 'opt-out-signal-wording', signal, `"${key}" ("${value}") must keep the wording "${DO_NOT_SELL_OR_SHARE}" under opt-out-signal (CCPA §1798.135(a)(1); Regs §7013(c))`);
  }
  if (key === 'privacyChoices.link' && signal.length && !YOUR_PRIVACY_CHOICES.test(value) && !DNSS.test(value)) {
    add('error', 'privacy-choices-wording', signal, `"privacyChoices.link" ("${value}") must be "Your Privacy Choices" / "Your California Privacy Choices" (with the opt-out icon) or "${DO_NOT_SELL_OR_SHARE}" under opt-out-signal (CCPA Regs §7013(c), §7015(b))`);
  }
  if (isAccept && AMBIGUOUS_ACCEPT.test(value)) {
    if (optIn.length) add('error', 'ambiguous-accept', optIn, `"${key}" ("${value}") does not say what is agreed to; closing or acknowledging is not consent (CCPA Regs §7004(a)(3)(D); ICO 2026: clear affirmative action)`);
    const rest = regimes.filter((r) => r !== 'opt-in');
    if (rest.length) add('warning', 'ambiguous-accept', rest, `"${key}" ("${value}") does not say what is agreed to; prefer "Accept all"`);
  }
  for (const p of PATTERNS) {
    const where = p.only ? regimes.filter((r) => r === p.only) : regimes;
    if (where.length && p.re.test(value)) add(p.severity, p.rule, where, `"${key}": ${p.message}`);
  }
}
