import fs from 'node:fs';
import path from 'node:path';
import type { Evidence } from '../record/index.js';
import { KIND_LABEL, SCENARIO_LABEL, type ConsentReportModel, type FindingKind } from './consent-model.js';

// The consent evaluation report as ONE self-contained HTML file (inline CSS +
// a few lines of JS, screenshots as data URIs, no fetches) — it opens from
// disk and attaches to an email. Evidence files (HAR, timeline) are linked by
// run-relative path, so the report works when written into the run directory.
// Vocabulary: findings, evidence, not tested — never a conformance verdict
// (asserted in test/consent-report.test.ts; not at runtime, because site
// content quoted in evidence is outside our control).

function esc(s: unknown): string {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

import { HUMAN_CSS, workBrief, safeHref } from './human.js';
import { VISITOR_ACTION, KIND_HUMAN, KIND_NOTE, details, groupConsentActions, actionTitle, groupObservation, implementationHint, occurrences, toolInventory, cookieInventory, consentLimitations, purposeNeedsReview, type ActionGroup } from './consent-view.js';

function inlineImage(runDir: string | undefined, rel: string): string | null {
  if (!runDir) return null;
  try {
    const buf = fs.readFileSync(path.join(runDir, rel));
    if (buf.length > 600_000) return null;
    const type = /\.jpe?g$/i.test(rel) ? 'image/jpeg' : 'image/png';
    return `data:${type};base64,${buf.toString('base64')}`;
  } catch {
    return null;
  }
}

function cell(c: ConsentReportModel['grid'][string][keyof ConsentReportModel['grid'][string]] | undefined): string {
  if (!c) return '<td class="na">—</td>';
  if (c.status === 'not-run') return '<td class="na" title="not in this location’s scenario set">·</td>';
  if (c.status === 'not-tested') return `<td class="nt" title="${esc(c.reason)}">not tested</td>`;
  if (c.status === 'not-applicable') return `<td class="na" title="${esc(c.reason)}">no banner</td>`;
  const parts: string[] = [];
  const add = (k: FindingKind, cls: string): void => {
    if (c.counts[k]) parts.push(`<span class="pill ${cls}" title="${esc(KIND_LABEL[k])}">${c.counts[k]}</span>`);
  };
  add('violation', 'v');
  add('needs-review', 'r');
  add('exposure', 'x');
  add('practice', 'p');
  const meta = [c.banner, c.choice].filter(Boolean).join(' · ');
  return `<td class="t"${meta ? ` title="${esc(meta)}"` : ''}>${parts.join('') || '<span class="none">no finding observed</span>'}</td>`;
}

function evidenceBlock(ev: Evidence[], runDir: string | undefined): string {
  const out: string[] = [];
  const shots = ev.filter((e): e is Extract<Evidence, { kind: 'screenshot' }> => e.kind === 'screenshot');
  for (const s of shots) {
    const uri = inlineImage(runDir, s.path);
    out.push(uri ? `<figure><img src="${uri}" alt="${esc(s.pageState)}"><figcaption>${esc(s.pageState)}</figcaption></figure>` : `<p class="mono">screenshot: ${esc(s.path)}</p>`);
  }
  const reqs = ev.filter((e): e is Extract<Evidence, { kind: 'network-request' }> => e.kind === 'network-request');
  if (reqs.length) {
    out.push(
      `<details><summary>Requests (${reqs.length} shown)</summary>${reqs
        .map((r) => `<div class="req"><code>${esc(r.url)}</code>${r.initiatorChain.length ? `<div class="chain">caused by ${r.initiatorChain.map((u) => `<code>${esc(u)}</code>`).join(' ← ')}</div>` : ''}</div>`)
        .join('')}</details>`,
    );
  }
  const logs = ev.filter((e): e is Extract<Evidence, { kind: 'interaction-log' }> => e.kind === 'interaction-log');
  const files = new Set<string>();
  for (const l of logs) {
    const head = l.steps[0] as { evidence?: { har?: string; timeline?: string } } | undefined;
    if (head?.evidence?.har) files.add(head.evidence.har);
    if (head?.evidence?.timeline) files.add(head.evidence.timeline);
  }
  if (files.size) out.push(`<p class="files">Evidence: ${[...files].map((f) => `<a href="${esc(safeHref(f))}">${esc(f.split('/').slice(-3).join('/'))}</a>`).join(' · ')}</p>`);
  return out.join('');
}

function actionCard(g: ActionGroup, m: ConsentReportModel, runDir: string | undefined): string {
  const os = occurrences(g);
  const contexts = [...new Set(os.map((o) => `${m.locations.find((l) => l.id === o.location)?.label ?? o.location}: ${VISITOR_ACTION[o.scenario] ?? o.scenario}`))];
  for (const f of g.findings) {
    const d = details(f);
    if (d.location) contexts.push(`${m.locations.find((l) => l.id === d.location)?.label ?? d.location}${d.scenario ? `: ${VISITOR_ACTION[d.scenario] ?? d.scenario}` : ''}`);
  }
  const hint = implementationHint(g);
  const notes = [...new Set(g.findings.flatMap((f) => details(f).notes ?? []))];
  const raw = [...new Map(g.findings.map((f) => [JSON.stringify(f), f])).values()];
  return `<article class="human-card" id="${g.id}" data-action-kind="${g.kind}">
<span class="human-status">${esc(KIND_HUMAN[g.kind])}</span>
<h3>${esc(actionTitle(g))}</h3>
<p><strong>What happened:</strong> ${esc(groupObservation(g))}</p>
${os.some((o) => o.markers.length) ? '<p class="human-muted">Some data-sharing observations used sample values supplied by the scanner to test the flow. They do not establish that real customer data was shared.</p>' : ''}
<p class="human-muted">${esc(KIND_NOTE[g.kind])}</p>
${contexts.length ? `<p><strong>Where / when:</strong> ${[...new Set(contexts)].map(esc).join('; ')}.</p>` : ''}
${workBrief(g.profile)}
${hint ? `<p class="human-callout"><strong>Where to start:</strong> ${esc(hint)}</p>` : ''}
${notes.length ? `<details class="human-details"><summary>Important context (${notes.length})</summary><div><ul>${notes.map((n) => `<li>${esc(n)}</li>`).join('')}</ul></div></details>` : ''}
<details class="human-details"><summary>Technical evidence and legal references (${g.findings.length} finding${g.findings.length === 1 ? '' : 's'})</summary><div>
<p>This action groups repeated observations of the same behavior and tool. Each original finding and its location-specific legal reference is retained below.</p>
${raw.map((f) => `<section><h4>${esc(f.requirementTitle)}</h4><p>${f.sourceUrl ? `<a href="${esc(safeHref(f.sourceUrl))}">${esc(f.citation)}</a>` : esc(f.citation)} · ${esc(f.scope)} · <code>${esc(f.ruleId)}</code> · ${esc(f.severity)}</p><p>${esc(f.message)}</p>${details(f).fix ? `<p><strong>Implementation detail:</strong> ${esc(details(f).fix)}</p>` : ''}${evidenceBlock(f.evidence, runDir)}<details class="human-details"><summary>Original finding record</summary><div><pre>${esc(JSON.stringify(f, null, 2))}</pre></div></details></section>`).join('')}
</div></details></article>`;
}

export interface ConsentHtmlOptions {
  /** The run directory: screenshots are inlined from here; links are relative to it. */
  runDir?: string;
}

export function renderConsentHtml(m: ConsentReportModel, opts: ConsentHtmlOptions = {}): string {
  const groups = groupConsentActions(m);
  const counts = (kind: ActionGroup['kind']): number => groups.filter((g) => g.kind === kind).length;
  const classify = m.inventory.filter((p) => purposeNeedsReview(p, m)).length;
  const head = `<tr><th>Location</th>${m.scenarios.map((s) => `<th>${esc(VISITOR_ACTION[s] ?? SCENARIO_LABEL[s])}</th>`).join('')}</tr>`;
  const body = m.locations.map((l) => `<tr><th>${esc(l.label)}<br><span class="human-muted">${esc(l.verdict)} · ${esc(l.observed)}</span></th>${m.scenarios.map((s) => cell(m.grid[l.id]?.[s])).join('')}</tr>`).join('');
  const tested = m.locations.flatMap((l) => Object.entries(m.grid[l.id] ?? {}).filter(([, c]) => c?.status === 'tested').map(([scenario, c]) => ({ location: l, scenario, cell: c! })));
  const quiet = tested.filter(({ cell: c }) => Object.values(c.counts).every((n) => n === 0));
  const failedChoices = tested.filter(({ cell: c }) => c.choice?.includes('(failed)'));
  const nt = consentLimitations(m);
  const unverified = m.locations.filter((l) => l.verdict !== 'verified');
  const evidence = m.evidenceIndex.map((e) => `<tr><td>${esc(m.locations.find((l) => l.id === e.location)?.label ?? e.location)}</td><td>${esc(VISITOR_ACTION[e.scenario] ?? e.scenario)}</td><td>${e.har ? `<a href="${esc(safeHref(e.har))}">Network log (HAR)</a>` : 'Not available'}</td><td>${e.timeline ? `<a href="${esc(safeHref(e.timeline))}">Browser timeline</a>` : 'Not available'}</td><td>${e.screenshots.map((s) => `<a href="${esc(safeHref(s))}">Screenshot</a>`).join('<br>') || 'None'}</td></tr>`).join('');
  const first = groups.slice(0, 3);
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Website privacy report — ${esc(m.site.host)}</title><style>
:root{--bg:#f6f7f9;--fg:#1b1e24;--card:#fff;--line:#dde1e7;--muted:#5f6875;--dim:#5f6875;--accent:#2456d6;--mono:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;--v:#b42318;--r:#b54708;--x:#6941c6;--p:#175cd3}
@media(prefers-color-scheme:dark){:root{--bg:#131519;--fg:#e7e9ec;--card:#1b1e24;--line:#2b3038;--muted:#a5aebb;--dim:#a5aebb;--accent:#82aaff;--v:#f97066;--r:#fdb022;--x:#b692f6;--p:#84adff}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.6 system-ui,-apple-system,Segoe UI,sans-serif}main{max-width:1080px;margin:0 auto;padding:30px 22px 70px}h1{font-size:34px;line-height:1.2;letter-spacing:-.02em;margin:8px 0}h4{font-size:16px}code,.mono{font:12px/1.6 var(--mono)}a{color:var(--accent)}.dim{color:var(--dim)}.eyebrow{font-size:12px;letter-spacing:.1em;text-transform:uppercase;color:var(--muted)}select,button{font:inherit;padding:7px;border:1px solid var(--line);border-radius:6px;background:var(--card);color:var(--fg)}[hidden]{display:none!important}.pill{display:inline-block;padding:2px 6px;margin:2px;border:1px solid var(--line);border-radius:4px;font-size:12px}.pill.v{color:var(--v)}.pill.r{color:var(--r)}.pill.x{color:var(--x)}.pill.p{color:var(--p)}.grid{min-width:1200px}.grid td{min-width:120px}figure img{max-width:100%;max-height:420px;object-fit:contain}figure{margin:14px 0}.req code{overflow-wrap:anywhere}section{margin:20px 0}.na,.nt{color:var(--muted)}
${HUMAN_CSS}
</style></head><body><main>
<header id="overview"><div class="eyebrow">ComplyKit · Website privacy report</div><h1>${esc(m.site.host)}</h1><p class="human-muted">${esc(m.site.url)} · Scanned ${esc(m.startedAt.slice(0, 16).replace('T', ' '))} UTC</p>
<p class="human-intro">${groups.length ? `We found ${groups.length} action item${groups.length === 1 ? '' : 's'} involving cookies, tracking or visitor privacy.` : 'The checks that ran produced no action items.'} ${classify ? `${classify} outside tool${classify === 1 ? ' also needs' : 's also need'} a purpose or classification review.` : 'Review the tool inventory and scan coverage to understand what was observed.'} ${tested.length ? `The report includes ${tested.length} tested visitor-action/location combination${tested.length === 1 ? '' : 's'}.` : 'No completed visitor-action tests were recorded.'}</p>
<div class="human-stats"><div class="human-stat"><strong>${counts('violation')}</strong><span>Problems observed</span></div><div class="human-stat"><strong>${counts('needs-review') + counts('practice')}</strong><span>Actions needing confirmation or research</span></div><div class="human-stat"><strong>${counts('exposure')}</strong><span>Actions for legal review</span></div><div class="human-stat"><strong>${classify}</strong><span>Tools needing purpose verification</span></div></div>
<p class="human-muted">Action counts group repeated findings. Tool counts are a separate inventory and can overlap with actions.</p>
${m.notTested.length || unverified.length || failedChoices.length ? `<p class="human-callout"><strong>Some results are incomplete.</strong> ${m.notTested.length} recorded limitation(s), ${unverified.length} unverified location(s), and ${failedChoices.length} unsuccessful choice attempt(s). <a href="#coverage">See what could not be checked.</a></p>` : ''}
<nav class="human-nav" aria-label="Report sections"><a href="#overview">Overview</a><a href="#actions">Action plan</a><a href="#storage">Cookies &amp; storage</a><a href="#tools">Tracking tools</a><a href="#visitor-tests">Visitor experience</a><a href="#coverage">Scan coverage</a></nav>
</header>
<section aria-labelledby="start-title"><h2 id="start-title" class="human-section-title">Start here</h2>
${first.length ? `<ol class="human-next">${first.map((g) => `<li><a href="#${g.id}">${esc(actionTitle(g))}</a><br><span class="human-muted">${esc(g.profile.owner)} · ${esc(KIND_HUMAN[g.kind])}</span></li>`).join('')}</ol>` : `<p>${classify ? 'Begin by verifying the purposes of the tools below.' : 'Review the completed tests and arrange manual checks for any missing coverage.'}</p>`}
<p class="human-muted">Suggested order: observed problems first, then confirmation and research, then legal-review items. Your team can adjust the order based on context.</p></section>
<section id="actions"><h2 class="human-section-title">Your action plan</h2><p>Each item explains what happened, why it matters and how to check a fix. Open the technical evidence when your developer or adviser needs more detail.</p>
<label>Show actions <select id="action-filter"><option value="all">All actions</option>${Object.entries(KIND_HUMAN).map(([k, label]) => `<option value="${k}">${esc(label)}</option>`).join('')}</select></label>
<button type="button" id="copy-actions">Copy shown action briefs</button><span id="copy-status" role="status" aria-live="polite"></span>
<div id="action-list">${groups.map((g) => actionCard(g, m, opts.runDir)).join('') || '<p class="human-empty">No findings were produced by the checks that ran. This is not an overall assurance about the site.</p>'}</div><p id="action-filter-empty" class="human-empty" hidden>No actions match this view.</p></section>
<section id="storage"><h2 class="human-section-title">Cookies and browser storage</h2><p>Cookies are small pieces of information saved in a visitor’s browser. Other browser storage can remember information too. Check the purpose of each item and whether the visitor’s choices control its use.</p>${cookieInventory(m, groups)}</section>
<section id="tools"><h2 class="human-section-title">Tracking tools and outside services</h2><p>These are the outside services observed during the scan. Some provide ordinary site features; others measure visits or advertising. A recognized vendor name does not establish that its use on your site is appropriate.</p>
<label>Show tools <select id="tool-filter"><option value="all">All tools</option><option value="problem">Problems observed</option><option value="classify">Purpose needs verification</option><option value="review">Other review items</option><option value="none">No finding linked</option></select></label>${toolInventory(m, groups)}<p id="tool-filter-empty" class="human-empty" hidden>No tools match this view.</p>
${m.researchQueue.length ? `<details class="human-details"><summary>Additional research requests (${m.researchQueue.length})</summary><div><ul>${m.researchQueue.map((q) => `<li><code>${esc(q.domain)}</code>: ${esc(q.reason)}. Confirm its owner, purpose and actual use.</li>`).join('')}</ul></div></details>` : ''}</section>
<section id="visitor-tests"><h2 class="human-section-title">What visitors experience</h2><p>We tested different visitor choices. These summaries describe the findings recorded for each choice; they do not certify that the choice worked correctly.</p>
${m.scenarios.map((s) => {
  const cells = m.locations.map((l) => ({ l, c: m.grid[l.id]?.[s] }));
  const ran = cells.filter(({ c }) => c?.status === 'tested');
  const issues = ran.filter(({ c }) => Object.values(c!.counts).some((n) => n > 0));
  const related = groups.filter((g) => occurrences(g).some((o) => o.scenario === s) || g.findings.some((f) => details(f).scenario === s));
  return `<details class="human-details"><summary>${esc(VISITOR_ACTION[s] ?? s)} — ${ran.length ? issues.length ? 'findings recorded' : 'no findings recorded' : 'not tested'}</summary><div><ul>${cells.map(({ l, c }) => `<li><strong>${esc(l.label)}:</strong> ${c?.status === 'tested' ? `Test ran. ${Object.entries(c.counts).filter(([, n]) => n > 0).map(([k, n]) => `${n} ${KIND_HUMAN[k as keyof typeof KIND_HUMAN].toLowerCase()} finding(s)`).join(', ') || 'No findings recorded.'}${c.choice?.includes('(failed)') ? ' The attempted visitor choice did not succeed; this does not show behavior after a successful choice.' : ''}` : `Not tested${c?.reason ? `: ${esc(c.reason)}` : ' in this location'}.`}</li>`).join('')}</ul>${related.map((g) => `<p><a href="#${g.id}">${esc(actionTitle(g))}</a></p>`).join('')}</div></details>`;
}).join('')}
<details class="human-details"><summary>Tests with no findings recorded (${quiet.length})</summary><div><p>These checks produced no findings. They are not verified passes, and a failed choice or missing check can still limit the result.</p><ul>${quiet.map(({ location, scenario, cell: c }) => `<li>${esc(location.label)}: ${esc(VISITOR_ACTION[scenario] ?? scenario)}${c.choice?.includes('(failed)') ? ' — choice attempt failed' : ''}.</li>`).join('') || '<li>No such tests were recorded.</li>'}</ul></div></details></section>
<section id="coverage"><h2 class="human-section-title">What we checked and what is missing</h2><p>This report covers the recorded locations, pages and visitor actions only. A result from one location may not describe how your site behaves elsewhere.</p>
<ul>${m.locations.map((l) => `<li><strong>${esc(l.label)}:</strong> ${l.verdict === 'verified' ? `location verified (${esc(l.observed)})` : `location could not be verified as requested (${esc(l.observed)}); do not use it as evidence for the intended location`}.${l.note ? ` ${esc(l.note)}` : ''}</li>`).join('')}</ul>
<h3>Not tested</h3>${nt ? `<ul>${nt}</ul>` : '<p>No additional limitations were recorded. This does not establish complete coverage of the site.</p>'}
${failedChoices.length ? `<h3>Choices that did not succeed</h3><ul>${failedChoices.map(({ location, scenario }) => `<li>${esc(location.label)}: ${esc(VISITOR_ACTION[scenario] ?? scenario)}. Retest with a working control or manual interaction.</li>`).join('')}</ul>` : ''}
<details class="human-details"><summary>Detailed test matrix and original finding counts</summary><div><p>Counts are original findings, not grouped actions. The same finding may occur in several cells. Exposure items are for legal review, not violations.</p><div class="human-table-wrap"><table class="human-table grid"><thead>${head}</thead><tbody>${body}</tbody></table></div></div></details>
<details class="human-details"><summary>Scan metadata and evidence files</summary><div><p>Run <code>${esc(m.runId)}</code> · package ${esc(m.versions.package)} · knowledge base ${esc(m.versions.kb)} · registry ${esc(m.versions.registry)}${m.versions.autoconsent ? ` · autoconsent ${esc(m.versions.autoconsent)}` : ''}.</p><p>${m.redacted ? 'Cookie values, authentication headers and request bodies were redacted.' : 'Raw evidence can contain cookies, tokens and visitor information. Handle it carefully.'} Evidence links require the accompanying run files.</p><div class="human-table-wrap"><table class="human-table"><thead><tr><th>Location</th><th>Visitor action</th><th>Network evidence</th><th>Timeline</th><th>Screenshots</th></tr></thead><tbody>${evidence}</tbody></table></div></div></details></section>
<footer class="human-callout"><strong>About this report</strong><p>This is an automated review of observed website behavior, not legal advice or a legal conclusion. It does not assert conformance or guarantee that every issue was found. Requirements can depend on location, your organization and how a tool is used. Classifications may need confirmation, and some checks require a person. Review the evidence with your team and seek qualified advice for legal decisions.</p></footer>
</main><script>
(function(){
function filter(selectId, selector, attr, emptyId){var select=document.getElementById(selectId);if(!select)return;select.addEventListener('change',function(){var shown=0;document.querySelectorAll(selector).forEach(function(el){el.hidden=select.value!=='all'&&!el.getAttribute(attr).split(' ').includes(select.value);if(!el.hidden)shown++;});document.getElementById(emptyId).hidden=shown!==0;});}
filter('action-filter','[data-action-kind]','data-action-kind','action-filter-empty');
filter('tool-filter','[data-tool-state]','data-tool-state','tool-filter-empty');
filter('cookie-filter','[data-cookie-state]','data-cookie-state','cookie-filter-empty');
document.getElementById('copy-actions').addEventListener('click',async function(){
var cards=Array.from(document.querySelectorAll('[data-action-kind]')).filter(function(el){return !el.hidden;});
var text=cards.map(function(el){return [el.querySelector('.human-status').innerText,el.querySelector('h3').innerText].concat(Array.from(el.querySelectorAll(':scope > p')).map(function(p){return p.innerText;}),[el.querySelector('.work-brief').innerText]).join('\\n');}).join('\\n\\n---\\n\\n');
var status=document.getElementById('copy-status');if(!cards.length){status.textContent=' No actions shown to copy.';return;}
try{if(navigator.clipboard&&navigator.clipboard.writeText){await navigator.clipboard.writeText(text);}else{var ta=document.createElement('textarea');ta.value=text;document.body.appendChild(ta);ta.select();var ok=document.execCommand('copy');ta.remove();if(!ok)throw Error('clipboard blocked');}status.textContent=' Copied '+cards.length+' action brief(s).';}catch(e){status.textContent=' Copy unavailable. Select the action text to copy it manually.';}
});
function reveal(){var id=location.hash.slice(1);var el=document.getElementById(id);if(!el)return;if(el.hasAttribute('data-action-kind')&&el.hidden){document.getElementById('action-filter').value='all';document.querySelectorAll('[data-action-kind]').forEach(function(x){x.hidden=false;});document.getElementById('action-filter-empty').hidden=true;}el.scrollIntoView();}
window.addEventListener('hashchange',reveal);document.querySelectorAll('a[href^="#action-"]').forEach(function(a){a.addEventListener('click',function(){setTimeout(reveal,0);});});reveal();
})();
</script></body></html>`;
}
