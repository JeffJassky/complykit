// The banner's words (tickets D9, F2). Every visible string goes through
// `t(key)`, the one lookup:
//   config.strings[lang].byRegime[regime][key]
//   → config.strings[lang][key]
//   → DEFAULTS[lang].byRegime[regime][key] → DEFAULTS[lang].base[key]
//   → the English default.
// `lang` is the first of navigator.languages the config (or the defaults) has
// a table for (exact tag, then its primary subtag), else 'en'. A second
// language is a second entry in DEFAULTS (and/or a config table); nothing else
// changes.
//
// The default copy and its rationale: docs/guide/banner-copy.md (pending agency
// review). Overrides are checked at generation time by
// src/record/consent-strings-guard.ts (required strings, misleading patterns);
// the tool trusts the generator and does not re-check them here (size).
//
// `{purposes}` in a string is replaced by the config's non-necessary category
// labels ("analytics and advertising"), so the banner names the purposes a site
// actually has — a site without advertising tools never says "advertising".

import type { ConsentStringKey, ConsentStringTable, Regime } from '../config.js';
import { host } from './host.js';

type Table = Partial<Record<ConsentStringKey, string>>;
interface LangDefaults {
  base: Record<ConsentStringKey, string>;
  byRegime: Partial<Record<Regime, Table>>;
}

const DNSS = 'Do Not Sell or Share My Personal Information';
const YPC = 'Your Privacy Choices';

// Base = opt-in (EU/EEA, UK) — also the fallback for an unknown location.
const EN_BASE: Record<ConsentStringKey, string> = {
  'banner.title': 'Cookies on this site',
  'banner.body':
    'We would like to use optional cookies and similar technologies for {purposes}. Some are set by the third parties listed under "Manage choices". They stay off unless you accept. Necessary cookies keep the site working and are always on. You can change your choice at any time from "Privacy choices".',
  'banner.accept': 'Accept all',
  'banner.reject': 'Reject all',
  'banner.manage': 'Manage choices',
  'settings.title': 'Privacy settings',
  'settings.body': 'Choose which optional categories to allow. Each stays off until you switch it on. Necessary technologies are always on because the site cannot work without them.',
  'settings.acceptAll': 'Accept all',
  'settings.rejectAll': 'Reject all',
  'settings.save': 'Save choices',
  'settings.close': 'Close',
  'withdraw.link': 'Withdraw consent',
  'withdraw.confirm': 'Your consent has been withdrawn.',
  'withdraw.note': 'You can withdraw your consent here at any time.',
  'withdraw.recall': 'Withdrawing stops further collection; data already sent cannot be recalled.',
  'privacyChoices.link': 'Privacy choices',
  'optOut.link': DNSS,
  'optOut.confirmed': 'Opt-out request honored.',
  // The California AG's recommended alt text for the opt-out icon.
  'optOut.iconAlt': 'California Consumer Privacy Act (CCPA) Opt-Out Icon',
  'gpc.honored': 'Your browser sent a Global Privacy Control signal. We have treated it as your request to opt out of the sale and sharing of your personal information.',
  'privacyPolicy.link': 'Privacy policy',
};

// US states with an opt-out preference signal law (California, Colorado,
// Connecticut, …): the opt-out is "Do Not Sell or Share", the link is "Your
// Privacy Choices" with the CPPA icon (Regs §7013(c), §7015(b)).
const EN_OPT_OUT_SIGNAL: Table = {
  'banner.title': YPC,
  'banner.body':
    'We and third parties use cookies and similar technologies for {purposes}. Under California and other US state privacy laws, some of this can be a "sale" or "sharing" of your personal information. You can opt out now, or at any time from "Your Privacy Choices".',
  'banner.reject': DNSS,
  'settings.title': YPC,
  'settings.body': 'Optional categories are on unless you opt out. Switch off any you do not want, or opt out of all of them. A Global Privacy Control signal from your browser is honored as an opt-out. Necessary technologies stay on because the site cannot work without them.',
  'settings.rejectAll': DNSS,
  'withdraw.confirm': 'Opt-out request honored.',
  'withdraw.note': 'You can opt out at any time.',
  'privacyChoices.link': YPC,
};

// US states without a signal law: opt-out of targeted advertising and sale.
const EN_OPT_OUT: Table = {
  'banner.title': YPC,
  'banner.body':
    'We and third parties use cookies and similar technologies for {purposes}. Depending on where you live, you may have the right to opt out of targeted advertising and the sale of your personal information. You can opt out now, or at any time from "Your Privacy Choices".',
  'settings.title': YPC,
  'settings.body': 'Optional categories are on unless you opt out. Switch off any you do not want, or reject all of them. A Global Privacy Control signal from your browser is honored as an opt-out. Necessary technologies stay on because the site cannot work without them.',
  'withdraw.confirm': 'Opt-out request honored.',
  'withdraw.note': 'You can opt out at any time.',
  'privacyChoices.link': YPC,
};

/** Built-in tables, by language. English only for now (design §10). */
export const DEFAULTS: Record<string, LangDefaults> = {
  en: { base: EN_BASE, byRegime: { 'opt-out-signal': EN_OPT_OUT_SIGNAL, 'opt-out': EN_OPT_OUT } },
};

function pick<T>(tables: Record<string, T> | undefined): T | undefined {
  if (!tables) return undefined;
  const nav = typeof navigator !== 'undefined' ? navigator : undefined;
  const langs = nav ? (nav.languages?.length ? nav.languages : [nav.language]) : [];
  for (const l of langs) {
    if (!l) continue;
    if (tables[l]) return tables[l];
    const primary = l.split('-')[0];
    if (tables[primary]) return tables[primary];
  }
  return tables.en;
}

/** The regime the UI is showing: the store's (a choice's own, or the current one). */
export const regime = (): Regime | undefined => host().getStore()?.state().regime;

const lower = (s: string): string => (/^[A-Z][a-z]/.test(s) ? s[0].toLowerCase() + s.slice(1) : s);

/** "analytics and advertising" from the config's non-necessary categories. */
function purposes(): string {
  const labels = (host().getConfig()?.categories ?? []).filter((c) => c.id !== 'necessary').map((c) => lower(c.label || c.id));
  if (!labels.length) return 'optional features';
  return labels.length === 1 ? labels[0] : `${labels.slice(0, -1).join(', ')} and ${labels[labels.length - 1]}`;
}

/** The visible string for a key, under the current config, language and regime. */
export function t(key: ConsentStringKey): string {
  const r = regime();
  const tb: ConsentStringTable | undefined = pick(host().getConfig()?.strings);
  const d = pick(DEFAULTS) ?? DEFAULTS.en;
  const v = String((r && tb?.byRegime?.[r]?.[key]) || tb?.[key] || (r && d.byRegime[r]?.[key]) || d.base[key] || EN_BASE[key]);
  return v.includes('{purposes}') ? v.split('{purposes}').join(purposes()) : v;
}
