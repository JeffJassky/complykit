import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { DO_NOT_SELL_OR_SHARE, validateConsentStrings, type ConsentStringIssue } from '../src/record/consent-strings-guard.js';
import { parseConsentToolConfig, withConsentConfigHash } from '../src/record/consent-config.js';

// F2: required-string guardrails and misleading-copy flags over config.strings.

const EXAMPLE = path.join(__dirname, 'fixtures', 'consent-config', 'example.json');
const errors = (s: unknown): ConsentStringIssue[] => validateConsentStrings(s).filter((i) => i.severity === 'error');
const warnings = (s: unknown): ConsentStringIssue[] => validateConsentStrings(s).filter((i) => i.severity === 'warning');
const rules = (xs: ConsentStringIssue[]): string[] => xs.map((i) => i.rule);

describe('validateConsentStrings: clean input', () => {
  it('no strings, empty tables and non-objects are fine', () => {
    expect(validateConsentStrings(undefined)).toEqual([]);
    expect(validateConsentStrings({})).toEqual([]);
    expect(validateConsentStrings({ en: {} })).toEqual([]);
    expect(validateConsentStrings('x')).toEqual([]);
  });

  it('the example config and ordinary overrides pass', () => {
    const c = JSON.parse(fs.readFileSync(EXAMPLE, 'utf8'));
    expect(validateConsentStrings(c.strings)).toEqual([]);
    expect(
      validateConsentStrings({
        en: {
          'banner.title': 'Cookies at Example Shop',
          'banner.reject': 'Reject all',
          'banner.accept': 'Accept all',
          'settings.rejectAll': 'Necessary only',
          byRegime: { 'opt-out-signal': { 'settings.rejectAll': DO_NOT_SELL_OR_SHARE, 'privacyChoices.link': 'Your California Privacy Choices' } },
        },
      }),
    ).toEqual([]);
  });
});

describe('required strings', () => {
  it('opt-in must keep a reject label', () => {
    const e = errors({ en: { 'banner.reject': 'No' } });
    expect(rules(e)).toEqual(['opt-in-reject']);
    expect(e[0].regimes).toEqual(['opt-in']);
    expect(e[0].path).toEqual(['strings', 'en', 'banner.reject']);
  });

  it('accepts the common reject wordings', () => {
    for (const v of ['Reject all', 'Decline', 'Refuse all', 'Only necessary', 'Necessary cookies only', 'Essential only', 'Deny', 'Opt out', "Don't allow"]) {
      expect(errors({ en: { 'banner.reject': v } }), v).toEqual([]);
    }
  });

  it('a reject relabelled as settings is refused in every regime', () => {
    const e = errors({ en: { 'banner.reject': 'Settings', 'settings.rejectAll': 'More options' } });
    expect(rules(e)).toEqual(['reject-as-settings', 'reject-as-settings', 'opt-out-signal-wording']);
    expect(e[0].regimes).toEqual(['opt-in', 'opt-out-signal', 'opt-out']);
  });

  it('opt-out-signal must keep "Do Not Sell or Share" on the settings opt-out and optOut.link', () => {
    expect(rules(errors({ en: { byRegime: { 'opt-out-signal': { 'optOut.link': 'Do Not Sell My Personal Information' } } } }))).toEqual(['opt-out-signal-wording']);
    expect(rules(errors({ en: { byRegime: { 'opt-out-signal': { 'settings.rejectAll': 'Reject all' } } } }))).toEqual(['opt-out-signal-wording']);
    // A base-table override reaches opt-out-signal unless that regime overrides it.
    const base = errors({ en: { 'settings.rejectAll': 'Reject all' } });
    expect(rules(base)).toEqual(['opt-out-signal-wording']);
    expect(base[0].regimes).toEqual(['opt-out-signal']);
    expect(errors({ en: { 'settings.rejectAll': 'Reject all', byRegime: { 'opt-out-signal': { 'settings.rejectAll': DO_NOT_SELL_OR_SHARE } } } })).toEqual([]);
    // The banner's own reject may say "Reject all" under opt-out-signal.
    expect(errors({ en: { byRegime: { 'opt-out-signal': { 'banner.reject': 'Reject all' } } } })).toEqual([]);
  });

  it('opt-out-signal Privacy choices link: "Your Privacy Choices" or the statutory label', () => {
    expect(rules(errors({ en: { 'privacyChoices.link': 'Cookie settings' } }))).toEqual(['privacy-choices-wording']);
    expect(errors({ en: { 'privacyChoices.link': 'Your Privacy Choices' } })).toEqual([]);
    expect(errors({ en: { 'privacyChoices.link': DO_NOT_SELL_OR_SHARE } })).toEqual([]);
    // Elsewhere "Cookie settings" is allowed.
    expect(errors({ en: { 'privacyChoices.link': 'Cookie settings', byRegime: { 'opt-out-signal': { 'privacyChoices.link': 'Your Privacy Choices' } } } })).toEqual([]);
  });

  it('blank (whitespace-only) strings are refused, withdraw.recall included', () => {
    const e = errors({ en: { 'withdraw.recall': '   ' } });
    expect(rules(e)).toEqual(['blank']);
  });
});

describe('misleading copy', () => {
  const one = (key: string, value: string) => rules(errors({ en: { [key]: value } }));
  it('implied consent ("by continuing to browse")', () => {
    expect(one('banner.body', 'By continuing to browse you agree to our cookies.')).toContain('implied-consent');
  });
  it('pre-ticked language is refused under opt-in only', () => {
    const e = errors({ en: { 'settings.body': 'Analytics is enabled by default.' } });
    expect(rules(e)).toEqual(['pre-ticked']);
    expect(e[0].regimes).toEqual(['opt-in']);
    expect(errors({ en: { byRegime: { 'opt-out': { 'settings.body': 'Analytics is enabled by default.' } } } })).toEqual([]);
  });
  it('legitimate interest, false urgency, confirmshaming, cookie walls', () => {
    expect(one('settings.body', 'Some partners rely on legitimate interest.')).toContain('legitimate-interest');
    expect(one('banner.body', 'Hurry, this offer expires in 10 seconds')).toContain('false-urgency');
    expect(one('banner.reject', "No, I don't want a better experience")).toContain('confirmshaming');
    expect(one('banner.body', 'You must accept cookies to continue.')).toContain('cookie-wall');
  });
  it('an accept that only acknowledges is refused under opt-in, a warning elsewhere', () => {
    const all = validateConsentStrings({ en: { 'banner.accept': 'OK' } });
    expect(all.map((i) => `${i.severity}:${i.rule}:${i.regimes.join('+')}`)).toEqual(['error:ambiguous-accept:opt-in', 'warning:ambiguous-accept:opt-out-signal+opt-out']);
  });
  it('filler and "we do not sell" are warnings, not refusals', () => {
    const s = { en: { 'banner.title': 'We value your privacy', 'banner.body': 'We do not sell your data. We use cookies for analytics.' } };
    expect(errors(s)).toEqual([]);
    expect(rules(warnings(s)).sort()).toEqual(['filler', 'no-sale-claim']);
  });
});

describe('other languages', () => {
  it('legally loaded keys are unverified (warning), never passed; patterns are not applied', () => {
    const all = validateConsentStrings({ de: { 'banner.reject': 'Einstellungen', 'banner.title': 'Datenschutz' } });
    expect(all.map((i) => `${i.severity}:${i.rule}:${i.key}`)).toEqual(['warning:unverified-language:banner.reject']);
  });
  it('en-GB counts as English', () => {
    expect(rules(errors({ 'en-GB': { 'banner.reject': 'Settings' } }))).toEqual(['reject-as-settings']);
  });
});

describe('the schema refuses errors at generation time', () => {
  const base = () => {
    const c = JSON.parse(fs.readFileSync(EXAMPLE, 'utf8'));
    delete c.hash;
    return c;
  };
  it('withConsentConfigHash throws on a refused override; warnings pass', () => {
    expect(() => withConsentConfigHash({ ...base(), strings: { en: { 'banner.reject': 'Settings' } } })).toThrow(/reject-as-settings/);
    expect(() => withConsentConfigHash({ ...base(), strings: { en: { 'banner.title': 'We value your privacy' } } })).not.toThrow();
  });
  it('parseConsentToolConfig reports the path', () => {
    const c = withConsentConfigHash(base());
    const r = parseConsentToolConfig({ ...c, strings: { en: { byRegime: { 'opt-out-signal': { 'optOut.link': 'Do Not Sell' } } } } });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.issues.some((i) => i.path.includes('byRegime') && /Do Not Sell or Share/.test(i.message))).toBe(true);
  });
});

describe("the tool's own defaults (client/src/ui/strings.ts) pass every rule", () => {
  it('per regime, as if an owner had pasted them as overrides', async () => {
    const { DEFAULTS } = await import('../client/src/ui/strings.js');
    for (const [lang, d] of Object.entries(DEFAULTS)) {
      const byRegime: Record<string, Record<string, string>> = {};
      for (const r of ['opt-in', 'opt-out-signal', 'opt-out'] as const) byRegime[r] = { ...d.base, ...(d.byRegime[r] ?? {}) };
      expect(validateConsentStrings({ [lang]: { byRegime } }), lang).toEqual([]);
    }
  });
});
