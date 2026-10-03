import fs from 'node:fs';
import path from 'node:path';
import type { Evidence } from '../record/index.js';
import { KIND_LABEL, SCENARIO_LABEL, type ConsentReportModel, type ReportFinding, type FindingKind } from './consent-model.js';

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

const FIELD_WORD: Record<string, string> = {
  'page-address': 'page address',
  'page-title': 'page title',
  'browser-id': 'stored browser ID',
  'click-id': 'ad-click ID',
  'form-input': 'typed form text',
  'search-term': 'typed search text',
  'hashed-email': 'hashed email',
  'event-name': 'event name',
  identifier: 'identifier-like value',
};

const PHASE_WORD: Record<string, string> = {
  'no-banner': 'no banner, nothing clicked',
  'before-banner': 'before the banner appeared',
  'before-choice': 'banner showing, no choice',
  'after-accept': 'after accept',
  'after-reject': 'after reject',
  'after-dismiss': 'after dismiss',
  'after-partial': 'after analytics-only',
  'after-withdraw': 'after withdrawal',
  'after-opt-out-link': 'after the opt-out link',
};

const SIGNAL_WORD: Record<string, string> = {
  'stores-long-lived-id': 'stores a long-lived ID',
  'sends-stored-id': 'sends a stored ID',
  'sends-page-address': 'sends the page address',
  'repeats-id-across-pages': 'same ID on every page',
  'receives-first-party-cookie': 'receives the site’s own cookie',
  'receives-typed-input': 'receives typed input',
  'receives-click-id': 'receives ad-click IDs',
  'sends-on-page-exit': 'sends as the page closes',
};

/** "gstatic.com/…/merchantwidget.js" with the full URL on hover. */
function shortUrl(u: string): string {
  try {
    const url = new URL(u);
    const parts = url.pathname.split('/').filter(Boolean);
    const tail = parts.length > 1 ? `/…/${parts[parts.length - 1]}` : url.pathname;
    return `<code title="${esc(u)}">${esc(url.host + tail)}</code>`;
  } catch {
    return `<code>${esc(u)}</code>`;
  }
}

const SOURCE_WORD: Record<string, string> = {
  markup: 'in the site’s HTML',
  'markup-leak': 'HTML tag that leaks past script gating',
  injected: 'injected by another script',
  platform: 'platform sandbox / worker',
  'first-party-proxy': 'first-party subdomain pointing at a vendor',
  unknown: 'unclear',
};

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
  const shots = ev.filter((e): e is Extract<Evidence, { kind: 'screenshot' }> => e.kind === 'screenshot').slice(0, 1);
  for (const s of shots) {
    const uri = inlineImage(runDir, s.path);
    out.push(uri ? `<figure><img src="${uri}" alt="${esc(s.pageState)}"><figcaption>${esc(s.pageState)}</figcaption></figure>` : `<p class="mono">screenshot: ${esc(s.path)}</p>`);
  }
  const reqs = ev.filter((e): e is Extract<Evidence, { kind: 'network-request' }> => e.kind === 'network-request').slice(0, 3);
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
  if (files.size) out.push(`<p class="files">Evidence: ${[...files].map((f) => `<a href="${esc(f)}">${esc(f.split('/').slice(-3).join('/'))}</a>`).join(' · ')}</p>`);
  return out.join('');
}

function findingCard(f: ReportFinding, runDir: string | undefined): string {
  const d = f.details as {
    party?: { label: string; owner?: string; domain: string; recognized: boolean; kbStatus: string; categories: string[] };
    source?: string;
    loadedBy?: string[];
    fix?: string;
    notes?: string[];
    occurrences?: Array<{ location: string; scenario: string; phases: string[]; firstMs: number; sinceBannerMs?: number; requests: number; sent: string[]; stored: string[]; decoded: string[]; markers: string[]; idsFrom?: string[] }>;
  };
  const rows: string[] = [];
  for (const o of d.occurrences ?? []) {
    rows.push(`<tr><td>${esc(o.location)}</td><td>${esc(SCENARIO_LABEL[o.scenario as keyof typeof SCENARIO_LABEL] ?? o.scenario)}</td>
<td>${o.phases.map((p) => esc(PHASE_WORD[p] ?? p)).join('<br>')}</td>
<td class="mono">${(o.firstMs / 1000).toFixed(1)}s${o.sinceBannerMs !== undefined ? `<br><span class="dim">${o.sinceBannerMs >= 0 ? '+' : ''}${(o.sinceBannerMs / 1000).toFixed(1)}s vs banner</span>` : ''}</td>
<td>${o.sent.map((k) => esc(FIELD_WORD[k] ?? k)).join(', ') || '—'}${o.idsFrom?.length ? `<br><span class="dim">ID from ${esc(o.idsFrom.join(', '))}</span>` : ''}${o.markers.length ? `<br><span class="warn">markers: ${esc(o.markers.join(', '))}</span>` : ''}</td>
<td>${o.stored.map(esc).join('<br>') || '—'}</td>
<td>${o.decoded.map(esc).join('<br>') || '—'}</td><td class="mono">${o.requests}</td></tr>`);
  }
  const party = d.party
    ? `<div class="party"><b>${esc(d.party.label)}</b>${d.party.owner ? ` · ${esc(d.party.owner)}` : ''} · <span class="mono">${esc(d.party.domain)}</span> · ${esc(d.party.categories.join(', '))} · <span class="kb kb-${esc(d.party.kbStatus)}">${d.party.kbStatus === 'unrecognized' ? 'not in knowledge base' : d.party.kbStatus === 'proposed' ? 'knowledge base: unconfirmed seed entry' : 'knowledge base: confirmed'}</span></div>`
    : '';
  const came = d.source ? `<p><span class="lbl">Came from</span> ${esc(SOURCE_WORD[d.source] ?? d.source)}${d.loadedBy?.length ? ` — ${d.loadedBy.slice(0, 3).map(shortUrl).join(' ← ')}` : ''}</p>` : '';
  return `<article class="finding k-${f.kind}" data-reg="${f.regulatorRank}" data-pl="${f.plaintiffRank}" data-kind="${f.kind}">
<header><span class="badge b-${f.kind}">${esc(KIND_LABEL[f.kind])}</span> <span class="scope">${esc(f.scope)}</span> <span class="rule mono">${esc(f.ruleId)}</span></header>
<h3>${esc(f.message)}</h3>
${party}
${rows.length ? `<table class="occ"><thead><tr><th>Location</th><th>Scenario</th><th>When</th><th>At</th><th>Sent</th><th>Stored</th><th>Vendor was told</th><th>Req.</th></tr></thead><tbody>${rows.join('')}</tbody></table>` : ''}
${came}
<p><span class="lbl">Rule</span> ${esc(f.requirementTitle)} — ${f.sourceUrl ? `<a href="${esc(f.sourceUrl)}">${esc(f.citation)}</a>` : esc(f.citation)}</p>
${d.fix ? `<p><span class="lbl">Fix</span> ${esc(d.fix)}</p>` : ''}
${(d.notes ?? []).length ? `<ul class="notes">${d.notes!.map((n) => `<li>${esc(n)}</li>`).join('')}</ul>` : ''}
${evidenceBlock(f.evidence, runDir)}
</article>`;
}

export interface ConsentHtmlOptions {
  /** The run directory: screenshots are inlined from here; links are relative to it. */
  runDir?: string;
}

export function renderConsentHtml(m: ConsentReportModel, opts: ConsentHtmlOptions = {}): string {
  const head = `<tr><th>Location</th>${m.scenarios.map((s) => `<th>${esc(SCENARIO_LABEL[s])}</th>`).join('')}</tr>`;
  const body = m.locations
    .map((l) => `<tr><th class="loc"><b>${esc(l.label)}</b> <span class="mono dim">${esc(l.id)}</span><br><span class="ver v-${esc(l.verdict)}">${esc(l.verdict)}</span> <span class="dim">${esc(l.observed)}${l.proxied ? ' via proxy' : ''}</span></th>${m.scenarios.map((s) => cell(m.grid[l.id]?.[s])).join('')}</tr>`)
    .join('');
  const inv = m.inventory
    .map(
      (p) => `<tr class="${p.behavesLikeTracker ? 'trk' : ''}"><td><b>${esc(p.label)}</b><br><span class="mono dim">${esc(p.hosts.slice(0, 3).join(', '))}</span></td>
<td>${p.recognized ? esc(p.kbStatus === 'confirmed' ? 'confirmed' : 'seed (unconfirmed)') : '<span class="warn">unrecognized</span>'}</td>
<td>${esc(p.categories.join(', '))}</td><td>${p.behavesLikeTracker ? '<span class="warn">yes</span>' : 'no'}${p.trackerSignals.length ? `<br><span class="dim">${p.trackerSignals.map((x) => esc(SIGNAL_WORD[x] ?? x)).join('<br>')}</span>` : ''}</td>
<td>${p.sends.map((k) => esc(FIELD_WORD[k] ?? k)).join(', ') || '—'}</td>
<td>${p.stores.map((s) => `${esc(s.kind)} ${esc(s.name)}${s.lifetimeDays === null ? ' ∞' : s.lifetimeDays ? ` ${s.lifetimeDays}d` : ''}`).join('<br>') || '—'}</td>
<td>${p.sources.map((s) => esc(SOURCE_WORD[s] ?? s)).join(', ')}${p.loadedBy.length ? `<br>${shortUrl(p.loadedBy[0])}` : ''}</td>
<td>${[...new Set(p.seenIn.map((x) => x.location))].map(esc).join(', ')}<br><span class="dim">${[...new Set(p.seenIn.map((x) => x.scenario))].length} scenario(s)</span></td></tr>`,
    )
    .join('');
  const nt = m.notTested.map((n) => `<li><span class="mono">${esc(n.scope)}${n.location ? ` · ${esc(n.location)}` : ''} · ${esc(n.id)}</span> — ${esc(n.reason)}</li>`).join('');
  const rq = m.researchQueue.map((q) => `<li><span class="mono">${esc(q.domain)}</span> — ${esc(q.reason)}</li>`).join('');
  const evidence = m.evidenceIndex
    .map((e) => `<tr><td>${esc(e.location)}</td><td>${esc(SCENARIO_LABEL[e.scenario])}</td><td>${e.har ? `<a href="${esc(e.har)}">HAR</a>` : '—'}</td><td>${e.timeline ? `<a href="${esc(e.timeline)}">timeline</a>` : '—'}</td><td>${e.screenshots.length}</td></tr>`)
    .join('');
  const locations = m.locations
    .map((l) => `<li><b>${esc(l.label)}</b> (${esc(l.id)}): <span class="ver v-${esc(l.verdict)}">${esc(l.verdict)}</span> — exit in ${esc(l.observed)}${l.jurisdictions.length ? `, rules for ${esc(l.jurisdictions.join(' + '))}` : ''}${l.note ? ` <span class="dim">(${esc(l.note)})</span>` : ''}${l.siteReported.length ? `<br><span class="dim">site reported: ${l.siteReported.map((s) => `${esc(s.source)} = ${esc(s.value)}`).join('; ')}</span>` : ''}</li>`)
    .join('');
  const t = m.totals;
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Consent & tracking — ${esc(m.site.host)}</title>
<style>
:root{--bg:#fbfaf8;--fg:#1b1b1b;--dim:#6b6b6b;--line:#e3e0da;--card:#fff;--v:#b42318;--r:#b54708;--x:#6941c6;--p:#175cd3;--ok:#067647;--mono:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
@media (prefers-color-scheme:dark){:root{--bg:#141414;--fg:#ececec;--dim:#9a9a9a;--line:#2c2c2c;--card:#1c1c1c;--v:#f97066;--r:#fdb022;--x:#b692f6;--p:#84adff;--ok:#47cd89}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.5 system-ui,-apple-system,Segoe UI,Roboto,sans-serif}
main{max-width:1180px;margin:0 auto;padding:24px 16px 64px}h1{font-size:26px;margin:0 0 4px}h2{font-size:18px;margin:36px 0 10px;text-transform:uppercase;letter-spacing:.06em}
h3{font-size:16px;margin:6px 0 8px;font-weight:600}.dim{color:var(--dim)}.mono,code{font-family:var(--mono);font-size:12.5px}code{word-break:break-all}
.totals span{display:inline-block;margin-right:14px}.pill{display:inline-block;min-width:22px;padding:0 6px;margin:1px;border-radius:10px;color:#fff;font:600 12px/20px var(--mono);text-align:center}
.pill.v,.b-violation{background:var(--v)}.pill.r,.b-needs-review{background:var(--r)}.pill.x,.b-exposure{background:var(--x)}.pill.p,.b-practice{background:var(--p)}
.wrap{overflow-x:auto}table{border-collapse:collapse;width:100%}th,td{border-bottom:1px solid var(--line);padding:6px 8px;text-align:left;vertical-align:top}
.grid td,.grid th{text-align:center}.grid th.loc{text-align:left;white-space:nowrap}.grid td.na{color:var(--dim)}.grid td.nt{color:var(--dim);font-style:italic}.none{color:var(--ok);font-size:12px}
.ver{font:600 11px var(--mono);text-transform:uppercase}.v-verified{color:var(--ok)}.v-mismatch,.v-unknown{color:var(--v)}
.finding{background:var(--card);border:1px solid var(--line);border-left:4px solid var(--line);border-radius:6px;padding:12px 14px;margin:12px 0}
.k-violation{border-left-color:var(--v)}.k-needs-review{border-left-color:var(--r)}.k-exposure{border-left-color:var(--x)}.k-practice{border-left-color:var(--p)}
.badge{color:#fff;border-radius:4px;padding:1px 7px;font:600 11px var(--mono);text-transform:uppercase}.scope{font:600 12px var(--mono)}.rule{color:var(--dim);float:right}
.occ{font-size:13px;margin:6px 0}.occ th{font-size:11px;text-transform:uppercase;color:var(--dim)}.lbl{font:600 11px var(--mono);text-transform:uppercase;color:var(--dim);margin-right:6px}
.notes{margin:6px 0;padding-left:18px;color:var(--dim);font-size:13.5px}.warn{color:var(--r)}.kb{font-size:12px}.kb-unrecognized{color:var(--r)}.kb-proposed{color:var(--dim)}
figure{margin:8px 0}figure img{max-width:360px;border:1px solid var(--line)}figcaption{font-size:12px;color:var(--dim)}.req{margin:4px 0}.chain{font-size:12px;color:var(--dim)}
.inv td{font-size:13px}.inv td:first-child{min-width:190px}.inv tr.trk td:first-child{border-left:3px solid var(--r)}.files{font-size:13px}.sort button{font:inherit;padding:3px 10px;margin-right:6px;border:1px solid var(--line);background:var(--card);color:var(--fg);border-radius:4px;cursor:pointer}.sort button[aria-pressed=true]{border-color:var(--fg)}
.callout{border:1px solid var(--line);background:var(--card);padding:10px 14px;border-radius:6px;font-size:14px}
</style></head><body><main>
<h1>Consent &amp; tracking evaluation</h1>
<p class="dim"><b>${esc(m.site.url)}</b> · run <span class="mono">${esc(m.runId)}</span> · ${esc(m.startedAt.slice(0, 16).replace('T', ' '))} UTC · knowledge base ${esc(m.versions.kb)} · registry ${esc(m.versions.registry)}${m.versions.autoconsent ? ` · autoconsent ${esc(m.versions.autoconsent)}` : ''}${m.redacted ? ' · evidence redacted' : ' · <b>raw evidence</b>'}</p>
<p class="totals"><span><span class="pill v">${t.violation}</span> violations</span><span><span class="pill r">${t['needs-review']}</span> need review</span><span><span class="pill x">${t.exposure}</span> exposure</span><span><span class="pill p">${t.practice}</span> need research</span></p>
<p class="callout">This report states what a real browser observed, from each verified location, in each scenario. “No finding observed” covers only the locations, scenarios and pages actually tested — it is never a clean bill of health. Exposure items are litigation theories for counsel, not violations. Everything that could not be tested is listed below.</p>
<h2>Locations</h2><ul>${locations}</ul>
<h2>Summary</h2><div class="wrap"><table class="grid"><thead>${head}</thead><tbody>${body}</tbody></table></div>
<p class="dim">Each cell counts findings that occurred in that location × scenario (a finding can occur in several). Hover a cell for the banner and the choice made.</p>
<h2>Findings</h2>
<p class="sort">Sort: <button data-sort="reg" aria-pressed="true">as regulators test</button><button data-sort="pl" aria-pressed="false">as plaintiffs build cases</button></p>
<div id="findings">${m.findings.map((f) => findingCard(f, opts.runDir)).join('') || '<p>No findings observed in what was tested.</p>'}</div>
<h2>Inventory</h2><p class="dim">Every outside party seen, recognized or not — the tracker inventory regulators have ordered companies to keep.</p>
<div class="wrap"><table class="inv"><thead><tr><th>Party</th><th>Knowledge base</th><th>Category</th><th>Behaves like a tracker</th><th>Sent</th><th>Stored</th><th>Came from</th><th>Seen</th></tr></thead><tbody>${inv}</tbody></table></div>
<h2>Research queue</h2>${rq ? `<ul>${rq}</ul>` : '<p class="dim">Every party was recognized.</p>'}
<h2>Not tested</h2><ul>${nt}</ul>
<h2>Evidence</h2><p class="dim">Per location × scenario. ${m.redacted ? 'Cookie values, auth headers and request bodies are redacted; re-run with raw evidence to keep them.' : 'Raw: these files contain cookies and tokens.'}</p>
<div class="wrap"><table><thead><tr><th>Location</th><th>Scenario</th><th>HAR</th><th>Timeline</th><th>Screenshots</th></tr></thead><tbody>${evidence}</tbody></table></div>
</main>
<script>
(function(){var box=document.getElementById('findings');var btns=document.querySelectorAll('.sort button');
btns.forEach(function(b){b.addEventListener('click',function(){var key=b.getAttribute('data-sort');btns.forEach(function(x){x.setAttribute('aria-pressed',String(x===b));});
var cards=Array.prototype.slice.call(box.querySelectorAll('.finding'));cards.sort(function(a,c){return Number(a.getAttribute('data-'+key))-Number(c.getAttribute('data-'+key));});cards.forEach(function(c){box.appendChild(c);});});});})();
</script></body></html>`;
  return html;
}
