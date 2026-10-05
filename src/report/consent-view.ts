import type { PartyInventoryItem } from '../record/index.js';
import type { ConsentReportModel, ReportFinding } from './consent-model.js';
import { escapeHtml as esc, explain, type Explanation } from './human.js';

export const VISITOR_ACTION: Record<string, string> = {
  'do-nothing': 'Before a visitor makes a choice', browse: 'When a visitor ignores the banner and browses',
  dismiss: 'After closing the banner', reject: 'After rejecting optional cookies', accept: 'After accepting cookies',
  partial: 'After choosing only some cookie categories', withdraw: 'After withdrawing permission',
  'return-visit': 'When a visitor comes back', gpc: 'With the browser’s privacy opt-out signal enabled',
  'opt-out-all': 'After trying every available opt-out method', 'opt-out-link': 'When using the privacy-choice link',
  markers: 'When testing whether sample visitor information is shared',
};
export const DATA_LABEL: Record<string, string> = {
  'page-address': 'the address of the page visited', 'page-title': 'the page title', 'browser-id': 'an identifier stored in the browser',
  'click-id': 'an advertising click identifier', 'form-input': 'text entered into a form', 'search-term': 'search text',
  'hashed-email': 'a hashed email identifier (a fingerprint of an email address)', 'event-name': 'the name of a visitor action', identifier: 'a value that looks like an identifier',
};
export const KIND_HUMAN = { violation: 'Problem observed', 'needs-review': 'Needs confirmation', exposure: 'Legal review', practice: 'Needs investigation' };
export const KIND_NOTE = {
  violation: 'The check recorded behavior it flags as a violation of the cited requirement. Confirm the context before making changes.',
  'needs-review': 'The observation needs confirmation before deciding whether it is a problem.',
  exposure: 'Potential legal exposure, not a detected violation. A legal adviser needs to assess the context.',
  practice: 'This needs research or classification. An unfamiliar tool is not automatically a violation.',
};
export interface Occurrence {
  location: string; scenario: string; phases: string[]; firstMs: number; requests: number;
  sent: string[]; stored: string[]; decoded: string[]; markers: string[];
}
export interface ConsentDetails {
  party?: { id?: string; label?: string; domain?: string; categories?: string[] };
  pattern?: string; source?: string; loadedBy?: string[]; fix?: string; notes?: string[];
  location?: string; scenario?: string; occurrences?: Occurrence[];
}
export function details(f: ReportFinding): ConsentDetails {
  return (f.details ?? {}) as ConsentDetails;
}
export interface ActionGroup { id: string; findings: ReportFinding[]; profile: Explanation; party?: string; kind: ReportFinding['kind']; }

/** Only merge work with the same tool, behavior, fix location and certainty.
 * Jurisdiction citations remain attached to every original finding. */
export function groupConsentActions(m: ConsentReportModel): ActionGroup[] {
  const groups = new Map<string, ActionGroup>();
  for (const f of m.findings) {
    const d = details(f);
    const identity = d.party?.id ?? d.party?.domain ?? f.party;
    const key = JSON.stringify([identity ?? f.fingerprint, f.ruleId, d.pattern, f.kind, d.source, [...(d.loadedBy ?? [])].sort(), d.fix]);
    let g = groups.get(key);
    if (!g) {
      const profile = explain(f.ruleId, f.requirementId);
      if (d.pattern === 'no-entry-point') profile.title = 'Visitors cannot reopen their privacy settings';
      g = { id: '', findings: [], profile, party: d.party?.label ?? f.party, kind: f.kind };
      groups.set(key, g);
    }
    g.findings.push(f);
  }
  const ranks = { violation: 0, 'needs-review': 1, practice: 2, exposure: 3 };
  const severity = { critical: 0, serious: 1, moderate: 2, minor: 3 };
  return [...groups.values()].sort((a, b) => ranks[a.kind] - ranks[b.kind] ||
    Math.min(...a.findings.map((f) => severity[f.severity as keyof typeof severity] ?? 4)) - Math.min(...b.findings.map((f) => severity[f.severity as keyof typeof severity] ?? 4)))
    .map((g, i) => ({ ...g, id: `action-${i + 1}` }));
}
export function occurrences(g: ActionGroup): Occurrence[] {
  const seen = new Map<string, Occurrence>();
  for (const f of g.findings) for (const o of details(f).occurrences ?? []) seen.set(JSON.stringify(o), o);
  return [...seen.values()];
}
export function actionTitle(g: ActionGroup): string {
  return `${g.party ? `${g.party}: ` : ''}${g.profile.title}`;
}
export function groupObservation(g: ActionGroup): string {
  const os = occurrences(g);
  const sent = [...new Set(os.flatMap((o) => o.sent))].map((k) => DATA_LABEL[k] ?? k);
  const stored = [...new Set(os.flatMap((o) => o.stored))];
  if (sent.length || stored.length) return `${g.party ?? 'The outside service'}${sent.length ? ` received ${sent.join(', ')}` : ''}${sent.length && stored.length ? ' and' : ''}${stored.length ? ` stored ${stored.join(', ')}` : ''}.`;
  // No structured data-transfer observations: retain the producer's observation.
  return g.findings[0].message;
}
export function implementationHint(g: ActionGroup): string {
  const source = details(g.findings[0]).source;
  if (source === 'injected') return 'Start with the tag manager, app or plugin that loads this tool. Review its consent settings or firing rules.';
  if (source === 'markup' || source === 'markup-leak') return 'Ask your developer to review the tool’s placement in the page. Images and embedded content can also load information before a choice.';
  if (source === 'platform') return 'Start with the platform’s customer privacy settings and the app or pixel configuration.';
  if (source === 'first-party-proxy') return 'Ask your developer to review the service reached through your own domain and how consent is passed to it.';
  return '';
}
export function relatedActions(p: PartyInventoryItem, groups: ActionGroup[]): ActionGroup[] {
  return groups.filter((g) => g.findings.some((f) => {
    const d = details(f);
    return d.party?.id === p.partyId || d.party?.domain === p.domain;
  }));
}
export function purposeNeedsReview(p: PartyInventoryItem, m: ConsentReportModel): boolean {
  return !p.recognized || p.kbStatus !== 'confirmed' || !p.categories.length || p.categories.includes('unknown') || m.researchQueue.some((q) => q.partyId === p.partyId);
}
const PURPOSE: Record<string, string> = {
  analytics: 'Measuring visits and site use', advertising: 'Advertising and campaign measurement', necessary: 'Supporting an essential site function',
  essential: 'Supporting an essential site function', functional: 'Providing a site feature', functionality: 'Providing a site feature',
  chat: 'Providing chat', fonts: 'Displaying fonts', security: 'Security or fraud prevention', social: 'Social media features',
  unknown: 'Purpose not yet identified',
};
export function purpose(p: PartyInventoryItem): string {
  return p.categories.map((c) => PURPOSE[c] ?? c).join(', ') || 'Purpose not yet identified';
}
export function toolStatus(p: PartyInventoryItem, groups: ActionGroup[], m: ConsentReportModel): string {
  const linked = relatedActions(p, groups);
  const states = [...new Set(linked.map((g) => KIND_HUMAN[g.kind]))];
  if (purposeNeedsReview(p, m)) states.push('Purpose needs verification');
  return states.join(' · ') || 'No finding linked to this tool';
}
export function toolInventory(m: ConsentReportModel, groups: ActionGroup[]): string {
  return m.inventory.map((p, i) => {
    const linked = relatedActions(p, groups);
    const review = purposeNeedsReview(p, m);
    const state = [linked.some((g) => g.kind === 'violation') ? 'problem' : '', review ? 'classify' : '', linked.some((g) => g.kind !== 'violation') ? 'review' : '', !linked.length ? 'none' : ''].filter(Boolean).join(' ');
    return `<article class="human-card tool-card" id="tool-${i + 1}" data-tool-state="${state}">
      <span class="human-status">${esc(toolStatus(p, groups, m))}</span><h3>${esc(p.label)}</h3>
      <p>${esc(purpose(p))}${review ? ' — this description needs confirmation.' : '.'}</p>
      <p><strong>Information observed:</strong> ${p.sends.length ? esc(p.sends.map((k) => DATA_LABEL[k] ?? k).join(', ')) : 'No recognized information fields recorded. This does not mean no information was sent.'}</p>
      <p><strong>Cookies and other browser storage:</strong> ${p.stores.length ? p.stores.map((s) => `<code>${esc(s.name)}</code> (${s.kind === 'cookie' ? 'cookie' : 'other browser storage'})`).join(', ') : 'None recorded for this tool.'}</p>
      <p><strong>Next step:</strong> ${review ? 'Confirm the owner, purpose and category with the vendor or site owner. Check whether your privacy notice and consent settings describe this use.' : linked.length ? 'Review the linked actions below.' : 'Keep this tool in your inventory. No issue was linked by these checks; other uses and locations may still need review.'}</p>
      ${linked.length ? `<p>${linked.map((g) => `<a class="human-link" href="#${g.id}">${esc(actionTitle(g))}</a>`).join('<br>')}</p>` : ''}
      <details class="human-details"><summary>Technical details and observed visitor actions</summary><div>
      <p>Associated domain: <code>${esc(p.domain)}</code>. ${p.owner ? `Owner: ${esc(p.owner)}.` : 'Owner not identified.'} Recognition: ${esc(p.kbStatus)}.</p>
      <p>Hosts: ${p.hosts.map((h) => `<code>${esc(h)}</code>`).join(', ')}</p>
      <p>Tracking indicators: ${esc(p.trackerSignals.join(', ') || 'None recorded')}.</p>
      <p>Loaded by: ${p.loadedBy.map((u) => `<code>${esc(u)}</code>`).join('<br>') || 'Not identified'}</p>
      ${p.consentApi ? `<p>Consent integration: <code>${esc(p.consentApi)}</code></p>` : ''}
      <ul>${p.seenIn.map((s) => `<li>${esc(m.locations.find((l) => l.id === s.location)?.label ?? s.location)}: ${esc(VISITOR_ACTION[s.scenario] ?? s.scenario)} — ${esc(s.phases.join(', '))}; ${s.requests} request(s).</li>`).join('')}</ul>
      <pre>${esc(JSON.stringify(p, null, 2))}</pre></div></details></article>`;
  }).join('') || '<p class="human-empty">No outside tools were recorded. Check scan coverage before interpreting this result.</p>';
}
export function cookieInventory(m: ConsentReportModel, groups: ActionGroup[]): string {
  const rows = m.inventory.flatMap((p) => {
    // Cookie names are tool-associated observations, not proof of a cookie's
    // own purpose, exact domain or a violation of its own.
    const stores = new Map(p.stores.map((s) => [JSON.stringify([s.name, s.kind, s.lifetimeDays]), s]));
    return [...stores.values()].map((s) => {
      const linked = relatedActions(p, groups);
      const exactProblems = linked.filter((g) => s.kind === 'cookie' && g.kind === 'violation' && g.findings.some((f) => f.evidence.some((e) => e.kind === 'cookie' && e.name === s.name && (e.domain.replace(/^\./, '') === p.domain || p.hosts.includes(e.domain.replace(/^\./, ''))))));
      const status = exactProblems.length ? 'Cookie problem observed' : purposeNeedsReview(p, m) ? 'Needs classification or verification' : 'No cookie-specific problem recorded';
      const state = [exactProblems.length ? 'problem' : 'none', purposeNeedsReview(p, m) ? 'classify' : ''].filter(Boolean).join(' ');
      return `<tr data-cookie-state="${state}"><td><code>${esc(s.name)}</code><br>${s.kind === 'cookie' ? 'Cookie' : 'Other browser storage'}</td><td>${esc(p.label)}</td><td>${esc(purpose(p))}<br><span class="human-muted">Tool category; verify this item’s purpose</span></td><td>${s.lifetimeDays === null ? 'No expiry recorded' : s.lifetimeDays === 0 ? 'Current browser session' : `${s.lifetimeDays} day(s)`}</td><td>${esc(status)}${linked.length ? `<br>${linked.map((g) => `<a class="human-link" href="#${g.id}">${esc(KIND_HUMAN[g.kind])} for this tool</a>`).join('<br>')}` : ''}</td></tr>`;
    });
  });
  return rows.length ? `<label>Show storage items <select id="cookie-filter"><option value="all">All items</option><option value="classify">Needs classification or verification</option><option value="problem">Cookie problem observed</option><option value="none">No cookie-specific problem recorded</option></select></label><div class="human-table-wrap"><table class="human-table"><caption>Tool-level tracking findings do not automatically make every cookie from that tool a violation.</caption><thead><tr><th>Name and type</th><th>Associated tool</th><th>Purpose to verify</th><th>How long it stays</th><th>What needs attention</th></tr></thead><tbody>${rows.join('')}</tbody></table></div><p id="cookie-filter-empty" class="human-empty" hidden>No storage items match this view.</p>` : '<p class="human-empty">No cookies or other browser storage were recorded in the tool inventory. Tracking can still happen without cookies.</p>';
}

export function consentLimitations(m: ConsentReportModel): string {
  const groups = new Map<string, ConsentReportModel['notTested']>();
  for (const n of m.notTested) {
    const key = JSON.stringify([n.scope, n.id, n.reason]);
    const items = groups.get(key) ?? [];
    items.push(n);
    groups.set(key, items);
  }
  const scopeTitle = { location: 'A requested visitor location', scenario: 'A visitor choice', frame: 'An embedded part of the page', flow: 'A visitor flow or data exchange', signal: 'A browser privacy signal', page: 'A page' };
  return [...groups.values()].map((items) => {
    const n = items[0];
    const title = n.scope === 'location' ? m.locations.find((l) => l.id === n.id)?.label ?? scopeTitle.location : n.scope === 'scenario' ? VISITOR_ACTION[n.id] ?? scopeTitle.scenario : scopeTitle[n.scope];
    const reason = /no (consent )?banner/i.test(n.reason) ? 'No recognized cookie banner was found, so its choices could not be tested.' : n.scope === 'frame' ? 'The scanner could not inspect all activity inside this embedded content.' : n.scope === 'location' ? 'The requested location could not be verified or tested.' : 'This part of the visitor experience was outside the completed checks.';
    const locations = [...new Set(items.flatMap((item) => item.location ? [m.locations.find((l) => l.id === item.location)?.label ?? item.location] : []))];
    return `<li><strong>${esc(title)}:</strong> ${esc(reason)}${locations.length ? ` Affected location(s): ${locations.map(esc).join(', ')}.` : ''}<details class="human-details"><summary>Original limitation details${items.length > 1 ? ` (${items.length} observations)` : ''}</summary><div><pre>${esc(JSON.stringify(items, null, 2))}</pre></div></details></li>`;
  }).join('');
}
