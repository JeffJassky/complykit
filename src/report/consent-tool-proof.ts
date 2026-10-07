import type { ConsentToolProof, ConsentToolProofFindingCode, VendorControlResult } from '../record/index.js';
import { escapeHtml as esc } from './human.js';

// The proof section (ticket D10): "complykit consent tool detected — version,
// config date, N vendors controlled, M not (list), K not observed". One view
// model for the HTML report, the Markdown digest and the JSON model. Wording:
// never "compliant"; a count of 'controlled' is a count of vendors held in a
// denied state AND seen running in a granted one in THIS scan — the qualifiers
// travel with it. 'not observed' is never folded into either side.

export const RESULT_LABEL: Record<VendorControlResult, string> = {
  controlled: 'Controlled — held when denied, ran when granted',
  'not-controlled': 'NOT controlled — ran where the config denies it',
  'not-observed': 'Not observed — nothing proved either way',
};

export const PROOF_FINDING_TITLE: Record<ConsentToolProofFindingCode, string> = {
  'config-missing': 'No config element',
  'config-refused': 'Config refused by the tool',
  'config-invalid': 'Config does not validate',
  'config-edited': 'Config edited by hand since generation',
  'config-behind': 'Deployed config is behind',
  'config-other-site': 'Config generated for another site',
  'tool-after-gtm': 'Tool loaded after Google Tag Manager',
  'ui-not-loaded': 'Banner file did not load',
  'gate-rule-unrewritten': 'Gated script never rewritten',
  'necessary-tracker': 'Tracker listed as necessary',
  'regime-mismatch': 'Tool decided a weaker regime than the location’s rules',
  'vendor-not-controlled': 'Vendors not controlled',
  'tool-not-running': 'Tool not running',
  'gpc-not-honored': 'Global Privacy Control not recorded by the tool',
  'vendor-not-in-config': 'Trackers the config does not list ran',
  'gated-document-write': 'Gated script calls document.write',
};

const RED = new Set<ConsentToolProofFindingCode>(['config-refused', 'config-missing', 'tool-not-running', 'vendor-not-controlled', 'gate-rule-unrewritten', 'config-other-site', 'tool-after-gtm', 'ui-not-loaded', 'necessary-tracker', 'regime-mismatch', 'gpc-not-honored', 'vendor-not-in-config']);

export interface ProofVendorRow {
  id: string;
  label: string;
  category: string;
  control: string;
  controlLabel: string;
  result: VendorControlResult;
  resultLabel: string;
  reason: string;
  seen: boolean;
  observations: Array<{ where: string; regime: string; expected: string; observed: string; note: string }>;
}

export interface ConsentToolProofReport {
  detected: boolean;
  /** The one line: tool, version, config date, counts. */
  headline: string;
  tone: 'red' | 'amber' | 'grey';
  version?: string;
  /** What is deployed, in one line (status, version, date, run, hash match, workspace). */
  configLine: string;
  configStatus: ConsentToolProof['config']['status'];
  totals: ConsentToolProof['totals'];
  notControlled: string[];
  vendors: ProofVendorRow[];
  findings: Array<{ code: ConsentToolProofFindingCode; title: string; message: string; tone: 'red' | 'amber' }>;
  /** How the scan drove the tool (exact selectors / API), per scenario. */
  driven: string[];
  notTested: string[];
  /** Scenarios where the tool was seen, with whether it was running and showed its banner. */
  seenIn: string[];
  section: ConsentToolProof;
}

const CONTROL_LABEL: Record<string, string> = {
  gate: 'script gate',
  api: 'consent API (held only where its tag is gated)',
  platform: 'platform bridge',
  none: 'none (listed as outside reach)',
};

const when = (iso?: string): string => (iso ? iso.slice(0, 10) : 'undated');

export function buildConsentToolProofReport(p: ConsentToolProof | undefined): ConsentToolProofReport | undefined {
  if (!p) return undefined;
  if (!p.detected) {
    return {
      detected: false,
      headline: 'complykit’s consent tool was not detected on the site (no ComplyKit global, config element or complykit_consent cookie on any landing).',
      tone: 'grey',
      configLine: '',
      configStatus: 'missing',
      totals: p.totals,
      notControlled: [],
      vendors: [],
      findings: [],
      driven: [],
      notTested: [],
      seenIn: [],
      section: p,
    };
  }
  const c = p.config;
  const statusWord: Record<ConsentToolProof['config']['status'], string> = {
    ok: 'accepted',
    refused: 'REFUSED by the tool',
    invalid: 'runs, but does not validate against the schema',
    'not-json': 'REFUSED (not JSON)',
    missing: 'MISSING',
  };
  const configLine = [
    `config ${statusWord[c.status]}`,
    c.version ? `schema ${c.version}${c.versionStatus && c.versionStatus !== 'current' ? ` (${c.versionStatus})` : ''}` : '',
    c.generatedFrom?.at ? `generated ${when(c.generatedFrom.at)}${c.generatedFrom.runId ? ` from run ${c.generatedFrom.runId}` : ''}` : '',
    c.generatedFrom?.site ? `for ${c.generatedFrom.site}` : '',
    c.hashMatches === false ? 'edited since generation' : c.hashMatches === true ? 'unedited' : '',
    c.workspace ? (c.workspace.same ? (c.workspace.sameContent ? `the workspace’s latest in content (regenerated ${when(c.workspace.at)} with no change)` : 'the workspace’s latest') : `not the workspace’s latest (${when(c.workspace.at)})`) : '',
  ]
    .filter(Boolean)
    .join(' · ');
  const notControlled = p.vendors.filter((v) => v.result === 'not-controlled').map((v) => v.label);
  const t = p.totals;
  const unlisted = p.findings.find((f) => f.code === 'vendor-not-in-config');
  const unlistedN = Array.isArray(unlisted?.details?.parties) ? unlisted.details.parties.length : 0;
  // The counts carry what they are a claim about (design §4, B3's scope line).
  const n = (k: number, one: string): string => `${k} ${one}${k === 1 ? '' : 's'}`;
  const scope = p.scope ? ` In this scan only: ${p.scope.pages === undefined ? 'an unrecorded number of pages' : n(p.scope.pages, 'page')}, ${n(p.scope.locations, 'location')}, logged out, ${n(p.scope.runs, 'run')} each.` : ' No visit could be compared.';
  // A weaker regime than the location's law: the controlled count was measured against the tool's own setting (vendors that
  // ran where the LAW expects them denied are already not-controlled); the qualifier travels with the count.
  const weaker = p.findings.filter((f) => f.code === 'regime-mismatch' && typeof f.details?.decided === 'string');
  const measured = weaker.length && t.controlled ? ` (measured against the tool’s weaker ${[...new Set(weaker.map((f) => `“${String(f.details!.decided)}”`))].join(' / ')} setting, not the ${[...new Set(weaker.map((f) => `“${String(f.details!.law)}” rules of ${String(f.details!.location)}`))].join(', ')})` : '';
  const headline = `complykit consent tool detected — version ${p.version ?? 'unknown'}, config ${c.generatedFrom?.at ? `generated ${when(c.generatedFrom.at)}` : statusWord[c.status]}: ${t.controlled} vendor${t.controlled === 1 ? '' : 's'} controlled${measured}, ${t.notControlled} not${notControlled.length ? ` (${notControlled.join(', ')})` : ''}, ${t.notObserved} not observed${unlistedN ? `; ${n(unlistedN, 'tracker')} not in the config ran while denied` : ''}.${scope}`;
  const findings = p.findings.map((f) => ({ code: f.code, title: PROOF_FINDING_TITLE[f.code], message: f.message, tone: RED.has(f.code) ? ('red' as const) : ('amber' as const) }));
  const tone: ConsentToolProofReport['tone'] = findings.some((f) => f.tone === 'red') ? 'red' : findings.length ? 'amber' : 'grey';
  const vendors: ProofVendorRow[] = p.vendors.map((v) => ({
    id: v.id,
    label: v.label,
    category: v.category,
    control: v.control,
    controlLabel: CONTROL_LABEL[v.control] ?? v.control,
    result: v.result,
    resultLabel: RESULT_LABEL[v.result],
    reason: v.reason,
    seen: v.seen,
    observations: v.observations.map((o) => ({
      where: `${o.location} · ${o.scenario}${o.run && o.run > 1 ? ` (run ${o.run})` : ''}`,
      regime: o.regime,
      expected: o.expectedGranted ? 'may run (granted)' : 'must not run (denied)',
      observed: o.observed,
      note: o.note ?? '',
    })),
  }));
  const ORDER: Record<VendorControlResult, number> = { 'not-controlled': 0, 'not-observed': 1, controlled: 2 };
  vendors.sort((a, b) => ORDER[a.result] - ORDER[b.result] || a.label.localeCompare(b.label));
  return {
    detected: true,
    headline,
    tone,
    ...(p.version ? { version: p.version } : {}),
    configLine,
    configStatus: c.status,
    totals: t,
    notControlled,
    vendors,
    findings,
    driven: p.driven.map((d) => `${d.location} · ${d.scenario}: ${d.choice} via ${d.method}${d.ok ? '' : ' (did not take)'}`),
    notTested: p.notTested,
    seenIn: p.seenIn.map((s) => `${s.location} · ${s.scenario}: ${s.running ? 'running' : 'NOT running'}${s.bannerShown ? ', banner shown' : ''}`),
    section: p,
  };
}

// --- HTML ------------------------------------------------------------------------

// The vendor column keeps whole words: a minimum width, words never split; only a
// hostname used as the name (an unrecognized vendor) may break, and only where it must.
const HOSTNAME_RE = /^(?=.*\.)[a-z0-9.-]+$/i;
const vendorName = (label: string): string => (HOSTNAME_RE.test(label) ? `<span class="ck-proof-host">${esc(label)}</span>` : esc(label));

export const PROOF_CSS = `.ck-proof-table th[scope=row]{min-width:12em;overflow-wrap:break-word;word-break:normal}.ck-proof-table .ck-proof-host{overflow-wrap:anywhere}.ck-proof-table td:nth-child(3){min-width:7em}.ck-proof .ck-headline{font-size:18px;margin:8px 0}.ck-proof [data-result=not-controlled] .ck-result{color:var(--v,#b42318);font-weight:600}.ck-proof [data-result=not-observed] .ck-result{color:var(--muted)}.ck-proof .ck-finding{border-left:3px solid var(--line);padding:4px 10px;margin:8px 0}.ck-proof .ck-finding[data-tone=red]{border-color:var(--v,#b42318)}.ck-proof .ck-finding[data-tone=amber]{border-color:var(--r,#b54708)}`;

export function renderConsentToolProofHtml(r: ConsentToolProofReport | undefined): string {
  if (!r) return '';
  if (!r.detected) {
    return `<section id="consent-tool-proof" class="ck-proof" data-detected="false"><h2 class="human-section-title">Your complykit consent tool</h2><p class="human-muted">${esc(r.headline)} Install it from the generated config and rescan: the rescan then compares the deployed config with what actually ran.</p></section>`;
  }
  const rows = r.vendors
    .map(
      (v) =>
        `<tr data-proof-vendor="${esc(v.id)}" data-result="${v.result}"><th scope="row">${vendorName(v.label)}<br><span class="human-muted">${esc(v.category)}</span></th><td>${esc(v.controlLabel)}</td><td class="ck-result">${esc(v.resultLabel)}</td><td>${esc(v.reason)}${
          v.observations.length
            ? `<details class="human-details"><summary>Visits compared (${v.observations.length})</summary><div><ul>${v.observations.map((o) => `<li>${esc(o.where)} · ${esc(o.regime)} rules · expected: ${esc(o.expected)} · observed: <strong>${esc(o.observed)}</strong> — ${esc(o.note)}</li>`).join('')}</ul></div></details>`
            : ''
        }</td></tr>`,
    )
    .join('');
  const findings = r.findings.map((f) => `<div class="ck-finding" data-proof-finding="${esc(f.code)}" data-tone="${f.tone}"><strong>${esc(f.title)}:</strong> ${esc(f.message)}</div>`).join('');
  return `<section id="consent-tool-proof" class="ck-proof" data-detected="true" data-tone="${r.tone}" data-not-controlled="${r.totals.notControlled}" data-config-status="${esc(r.configStatus)}">
<h2 class="human-section-title">Your complykit consent tool: what it controls</h2>
<p class="ck-headline"><strong>${esc(r.headline)}</strong></p>
<p class="human-muted">${esc(r.configLine)}</p>
<p class="human-muted">“Controlled” means: in this scan, held back in every visit where the config denies its category AND seen running in a visit where it grants it. It covers the pages, locations and visitor actions tested here, logged out, in one browser — nothing more.</p>
${findings ? `<h3>What needs attention (${r.findings.length})</h3>${findings}` : '<p>No install or config problem was recorded in what was tested.</p>'}
<div class="human-table-wrap"><table class="human-table ck-proof-table"><caption>One row per vendor in the deployed config. Vendors that ran where the config denies them come first.</caption><thead><tr><th>Vendor</th><th>Control in config</th><th>Result</th><th>Why</th></tr></thead><tbody>${rows || '<tr><td colspan="4">The deployed config lists no vendors, or could not be read.</td></tr>'}</tbody></table></div>
${r.driven.length ? `<details class="human-details"><summary>How the scan drove the tool (${r.driven.length})</summary><div><ul>${r.driven.map((d) => `<li>${esc(d)}</li>`).join('')}</ul></div></details>` : ''}
${r.seenIn.length ? `<details class="human-details"><summary>Where the tool was seen (${r.seenIn.length})</summary><div><ul>${r.seenIn.map((d) => `<li>${esc(d)}</li>`).join('')}</ul></div></details>` : ''}
${r.notTested.length ? `<details class="human-details"><summary>Not covered by this proof (${r.notTested.length})</summary><div><ul>${r.notTested.map((d) => `<li>${esc(d)}</li>`).join('')}</ul></div></details>` : ''}
</section>`;
}

// --- Markdown ----------------------------------------------------------------------

const mdCell = (s: string): string => s.replace(/\|/g, '\\|').replace(/\n/g, ' ');

export function renderConsentToolProofMarkdown(r: ConsentToolProofReport | undefined): string[] {
  if (!r) return [];
  const lines: string[] = ['## complykit consent tool', ''];
  if (!r.detected) return [...lines, r.headline, ''];
  lines.push(`**${r.headline}**`, '', r.configLine, '');
  for (const f of r.findings) lines.push(`- **${f.title}:** ${f.message}`);
  if (r.findings.length) lines.push('');
  if (r.vendors.length) {
    lines.push('| Vendor | Category | Control in config | Result | Why |', '|---|---|---|---|---|');
    for (const v of r.vendors) lines.push(`| ${mdCell(v.label)} | ${mdCell(v.category)} | ${mdCell(v.controlLabel)} | ${mdCell(v.resultLabel)} | ${mdCell(v.reason)} |`);
    lines.push('');
  }
  if (r.driven.length) lines.push('Driven by exact selectors / API:', ...r.driven.map((d) => `- ${d}`), '');
  if (r.notTested.length) lines.push('Not covered by this proof:', ...r.notTested.map((d) => `- ${d}`), '');
  return lines;
}
