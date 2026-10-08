import type { ScenarioId } from '../../record/index.js';

// The legal guide (plans/legal-guide-contract.md): complykit's testing policy
// and every place's rules as one deduplicated document, built from the
// registry alone, so the guide page and the scanner cannot disagree. Pure.
// service/src/shared/legal-guide.json is this function's output for a date;
// test/legal-guide.test.ts keeps the two in step.

/** What each scan visit does and why it exists — the guide's "how we test". Every ScenarioId has one. */
export const GUIDE_SCENARIOS: ReadonlyArray<{ id: ScenarioId; label: string; what: string; why: string }> = [
  {
    id: 'do-nothing',
    label: 'Before a choice',
    what: 'Loads the home page in a fresh browser and waits, never touching the banner.',
    why: 'What runs before the visitor has decided anything — the core question in opt-in places and in wiretap suits.',
  },
  {
    id: 'browse',
    label: 'Browse without choosing',
    what: 'Visits several pages and searches the site, ignoring the banner.',
    why: 'Some tools wait for a second page, a scroll or a search before they fire; a single landing misses them.',
  },
  {
    id: 'dismiss',
    label: 'Banner closed without choosing',
    what: 'Closes the banner with its X or by clicking away, then browses.',
    why: 'Closing a banner is not consent. Tools that treat it as a yes are a common finding in the EU and UK.',
  },
  {
    id: 'reject',
    label: 'After rejection',
    what: 'Rejects everything on the banner, reloads, and browses.',
    why: 'A rejection must stop the tools. A rejection that leaks is a violation in opt-in places and evidence in wiretap suits everywhere.',
  },
  {
    id: 'accept',
    label: 'After acceptance',
    what: 'Accepts everything on the banner and browses.',
    why: 'Shows which tools the banner was holding back, so they are known and listed even where they correctly waited.',
  },
  {
    id: 'partial',
    label: 'After accepting analytics only',
    what: 'Turns on analytics alone in the banner’s settings and browses.',
    why: 'Consent must be specific: accepting analytics must not switch on advertising.',
  },
  {
    id: 'withdraw',
    label: 'After withdrawal',
    what: 'Accepts, browses, reopens the site’s privacy settings and rejects everything, then reloads and browses.',
    why: 'Withdrawing must be as easy as consenting, and must actually stop the tools and remove what they stored.',
  },
  {
    id: 'return-visit',
    label: 'Returning after rejection',
    what: 'Rejects, then comes back later in the same browser.',
    why: 'A refusal must be remembered: tools must not run on the next visit, and the visitor should not be pestered again at once.',
  },
  {
    id: 'gpc',
    label: 'Privacy signal (GPC)',
    what: 'Visits with the browser sending Global Privacy Control from the first request, never touching the banner.',
    why: 'Several US states require honoring the signal as an opt-out with no click. California fined companies that ignored it.',
  },
  {
    id: 'opt-out-all',
    label: 'After opting out every way',
    what: 'Sends GPC, rejects on the banner and uses the site’s opt-out link, then counts what still runs.',
    why: 'The way California investigators test: opt out every way at once, then look for anything still sending data.',
  },
  {
    id: 'opt-out-link',
    label: 'After the opt-out link',
    what: 'Finds the “Do Not Sell or Share” link, uses it as a visitor would, and browses. Never submits personal information.',
    why: 'The link must exist where the law says, and must work without an account or extra information.',
  },
  {
    id: 'markers',
    label: 'Sample information test',
    what: 'Arrives with made-up ad-click IDs in the address and types a made-up email and search into the page, without submitting.',
    why: 'Shows whether what a visitor types or arrives with reaches a third party — the “contents” wiretap suits are built on.',
  },
];
