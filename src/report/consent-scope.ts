import type { ConsentReportModel } from '../../types/index.js';
import { escapeHtml as esc } from './human.js';

// B3: every green number states what it is a claim about, and the report says
// what a browser scan cannot establish (plans/client-consent-design.md §4).
// Shared by the HTML and Markdown renderers so both carry the same wording.

export interface ScanScope {
  /** Cookie/tool checks whose result is "working as expected". */
  working: number;
  /** Pages the journey visited (most any one visit reached); undefined when not recorded. */
  pages?: number;
  locations: number;
  /** Visits per scenario, the lowest across tested scenarios (the claim is "at least this many"). */
  runs: number;
}

export function scanScope(m: ConsentReportModel): ScanScope {
  const working = (m.behaviorMatrix?.rows ?? []).flatMap((r) => r.cells).filter((c) => c.status === 'match' || c.status === 'allowed').length;
  const pageCounts = (m.behaviorObservations ?? []).map((o) => o.pages).filter((n): n is number => typeof n === 'number');
  const tested = m.locations.filter((l) => l.verdict === 'verified' && m.scenarios.some((s) => m.grid[l.id]?.[s]?.status === 'tested'));
  const runCounts = tested.flatMap((l) => m.scenarios.map((s) => m.grid[l.id]?.[s]).filter((c) => c?.status === 'tested').map((c) => c?.runs ?? 1));
  return { working, pages: pageCounts.length ? Math.max(...pageCounts) : undefined, locations: tested.length, runs: runCounts.length ? Math.min(...runCounts) : 1 };
}

/** "324 checks working as expected on 14 pages, 1 location, logged out, 1 run each" */
export function scopeLine(m: ConsentReportModel): string {
  const s = scanScope(m);
  const n = (k: number, one: string) => `${k} ${one}${k === 1 ? '' : 's'}`;
  const pages = s.pages === undefined ? 'an unrecorded number of pages' : n(s.pages, 'page');
  return `${n(s.working, 'check')} working as expected on ${pages}, ${n(s.locations, 'location')}, logged out, ${n(s.runs, 'run')} each`;
}

export const BLIND_SPOTS: Array<{ label: string; text: string }> = [
  { label: 'Pages not visited', text: 'Only the pages the scan visited are covered. A pixel on checkout, search results or a logged-in area is not seen unless the journey reached it.' },
  { label: 'Server-side', text: 'Data a site’s server sends to vendors directly never passes through the browser. It is possible and cannot be verified here; ask the owner for the server-side checklist.' },
  { label: 'Vendor-side', text: 'Whether a vendor kept the data, matched it to a person or sold it is out of scope for any scanner.' },
  { label: 'Other browsers', text: 'Evidence comes from Chromium on desktop. Safari and Firefox handle cookies and tracking protection differently.' },
  { label: 'Timing and repeat visits', text: 'A tracker that only fires when the consent tool loads slowly can be missed. A single run cannot rule out a race.' },
  { label: 'Caching, A/B tests and personalization', text: 'Different visitors can get different tags. One scan sees one variant for one logged-out visitor in one location.' },
  { label: 'Consent calls that do not work', text: 'A consent API call can be made while the vendor still sends data. Observed behavior is the evidence; implementation is only the explanation.' },
  { label: 'Data already sent', text: 'Withdrawing consent stops future sends. It does not recall anything already sent.' },
];

/** Local-copy mode (D11): the one sentence that must come before any number in the report. */
export function localCopyLine(m: ConsentReportModel): string | undefined {
  const lc = m.localCopy;
  if (!lc) return undefined;
  const never = lc.replacements.filter((r) => !r.applied).map((r) => r.label);
  const res = lc.resources.map((r) => `${r.url}: ${r.status}${r.note ? ` (${r.note})` : ''}`);
  return (
    `LOCAL COPY — not the live site. The scanner rewrote the documents of ${lc.origin} inside its own browser (${lc.file}): ` +
    `${lc.documents.rewritten} document(s) rewritten${lc.documents.unreadable ? `, ${lc.documents.unreadable} served as-is (unreadable)` : ''}` +
    `${lc.head ? ', the consent snippet inserted first in <head>' : ''}` +
    `${lc.replacements.length ? `, ${lc.replacements.filter((r) => r.applied).length} of ${lc.replacements.length} replacement(s) applied` : ''}` +
    `${never.length ? ` (never matched: ${never.join(', ')})` : ''}` +
    `${lc.served.length ? `; served locally: ${lc.served.map((s) => `${s.path} ×${s.requests}`).join(', ')}` : ''}` +
    `${res.length ? `; resources: ${res.join('; ')}` : ''}` +
    `${lc.errors.length ? `; failures: ${lc.errors.join(' | ')}` : ''}. ` +
    'Everything below describes that rewritten copy. Nothing was installed on the site; the live site was not changed and is not what was tested.'
  );
}

// With a checklist in the report the blind spots stay fully visible (never
// collapsed: they are what the green numbers do not claim) but in a tighter
// layout — two columns on wide screens, smaller type — so the checklist below
// is not pushed far down the page.
export const SCOPE_CSS = `#scan-scope[data-compact] #blind-spots h3{font-size:15px;margin:10px 0 4px}#scan-scope[data-compact] #blind-spots ul{columns:2 24em;column-gap:28px;margin:4px 0 0;padding-left:18px;font-size:14px;line-height:1.45}#scan-scope[data-compact] #blind-spots li{break-inside:avoid;margin:0 0 6px}`;

export function renderScopeHtml(m: ConsentReportModel): string {
  const lc = localCopyLine(m);
  const compact = Boolean(m.remediation?.tasks.length);
  return `${lc ? `<section id="local-copy" class="human-callout" role="note"><p><strong>${esc(lc)}</strong></p></section>\n` : ''}<section id="scan-scope" class="human-callout" aria-labelledby="scan-scope-title"${compact ? ' data-compact' : ''}><h2 id="scan-scope-title" class="human-section-title">What these results cover</h2>
<p><strong>${esc(scopeLine(m))}.</strong> Scanned ${esc(m.startedAt.slice(0, 16).replace('T', ' '))} UTC. These results describe those pages, at that time, from those locations; they say nothing about other pages, other times, or a logged-in visitor.</p>
<div id="blind-spots"><h3>What a scan cannot tell you</h3><ul>${BLIND_SPOTS.map((b) => `<li><strong>${esc(b.label)}.</strong> ${esc(b.text)}</li>`).join('')}</ul></div></section>`;
}

export function renderScopeMarkdown(m: ConsentReportModel): string[] {
  const lc = localCopyLine(m);
  return [...(lc ? [`> **${lc}**`, ''] : []), `**${scopeLine(m)}.** Scanned ${m.startedAt.slice(0, 16).replace('T', ' ')} UTC.`, '', '### What a scan cannot tell you', '', ...BLIND_SPOTS.map((b) => `- **${b.label}.** ${b.text}`), ''];
}
