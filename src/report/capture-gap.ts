import { registrableDomain } from '../registry/index.js';

/**
 * Which coverage notes could be hiding a tool's activity (plans/report-truth.md B).
 *
 * A note is a capture gap only if it says the scan may have missed requests or cookies on the
 * pages it visited. Notes about journeys not taken, choices that did not take, or banner design say
 * nothing about whether a tool loaded; they must not turn an expected absence into "couldn't test".
 * Unknown text stays a gap (conservative).
 */
export interface CoverageNote {
  scope: string;
  id: string;
  location?: string;
  reason: string;
}

/** The party a note is asked about, for frame-scoped notes. */
export interface NotePartyScope {
  domain: string;
  hosts: readonly string[];
}

/** Ids of notes that are about the program, not the visit. */
const NOT_ABOUT_THE_VISIT = new Set(['server-to-server', 'vendor-processing', 'contracts', 'consent-records', 'unvisited']);

/** Reasons that say nothing about whether a tool loaded on the pages visited. */
const NOT_A_CAPTURE_GAP: readonly RegExp[] = [
  /globalPrivacyControl inside workers/, // GPC in workers: the Sec-GPC header is still sent
  /^banner design:/,
  /^no visible (?:search|email) field/,
  // Beacons from inside a frame on unload; the frame's other traffic is captured.
  /^page-exit sends from cross-origin frames/,
  // A journey step not taken is an unvisited page, like `unvisited`.
  /^site search:/,
  // Whether a choice took is the grid's `choice`/`choiceGap`, not capture.
  /clicked but the stored consent state did not change/,
  /^clicked; no readable consent state/,
  /^the stored consent state does not reflect/,
  /^autoconsent self-test:/,
  /^complykit[’']s tool is on the page:/,
  /^banner driver \(@duckduckgo\/autoconsent\) not installed/,
  /^banner reject failed \(.*\) — opted out by signal and link only/,
];

/** `storage inside sandboxed frame <url> …` — hides only that frame's site's storage. */
const SANDBOXED_FRAME = /^storage inside sandboxed frame (\S+)/;

/**
 * True if the note could hide activity. With `party`, a sandboxed-frame note counts only for a
 * party sharing the frame URL's registrable domain; without a party it is conservatively a gap.
 */
export function hidesActivity(note: CoverageNote, party?: NotePartyScope): boolean {
  if (NOT_ABOUT_THE_VISIT.has(note.id)) return false;
  if (NOT_A_CAPTURE_GAP.some((re) => re.test(note.reason))) return false;
  const frame = SANDBOXED_FRAME.exec(note.reason);
  if (frame && party) {
    let host = '';
    try {
      host = new URL(frame[1]).hostname;
    } catch {
      return true;
    }
    const site = registrableDomain(host);
    return [party.domain, ...party.hosts].some((h) => !!h && registrableDomain(h) === site);
  }
  return true;
}
