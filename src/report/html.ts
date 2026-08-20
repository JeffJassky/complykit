import fs from 'node:fs';
import path from 'node:path';
import { PNG } from 'pngjs';
import { runDir, type Finding, type Run, type Severity, type Box } from '../record/index.js';
import { getRequirement, getInstrument } from '../registry/index.js';
import type { CoverageMatrix } from './coverage.js';

// The deliverable UI (build-plan §8): ONE self-contained static HTML file per
// run — inline CSS/JS, evidence images as data URIs, no fetches. It must open
// from disk and attach to an email. Not a React SPA (the React rule governs
// host-embedded UI, which this package does not have).
//
// Vocabulary: chrome states findings / evidence / coverage, never "compliant".

const SEVERITY_ORDER: Severity[] = ['critical', 'serious', 'moderate', 'minor'];
const severityRank = (s: Severity): number => {
  const i = SEVERITY_ORDER.indexOf(s);
  return i === -1 ? SEVERITY_ORDER.length : i;
};

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

/** Read a PNG from the run's evidence dir, optionally crop a region, return a
 *  bounded data URI (or null). Keeps the file self-contained without inlining
 *  whole full-page captures. */
function inlineImage(runDirPath: string, rel: string, region?: Box): string | null {
  const abs = path.join(runDirPath, rel);
  if (!fs.existsSync(abs)) return null;
  try {
    let buf = fs.readFileSync(abs);
    if (region) {
      const src = PNG.sync.read(buf);
      const pad = 24;
      const x0 = Math.max(0, Math.floor(region.x - pad));
      const y0 = Math.max(0, Math.floor(region.y - pad));
      const x1 = Math.min(src.width, Math.ceil(region.x + region.width + pad));
      const y1 = Math.min(src.height, Math.ceil(region.y + region.height + pad));
      const w = Math.max(1, x1 - x0);
      const h = Math.max(1, y1 - y0);
      const dst = new PNG({ width: w, height: h });
      for (let y = 0; y < h; y++)
        for (let x = 0; x < w; x++) {
          const s = ((src.width * (y0 + y)) + (x0 + x)) << 2;
          const d = ((w * y) + x) << 2;
          dst.data[d] = src.data[s];
          dst.data[d + 1] = src.data[s + 1];
          dst.data[d + 2] = src.data[s + 2];
          dst.data[d + 3] = src.data[s + 3];
        }
      buf = PNG.sync.write(dst);
    }
    if (buf.length > 400_000) return null; // skip oversized inlines
    return `data:image/png;base64,${buf.toString('base64')}`;
  } catch {
    return null;
  }
}

function subjectLabel(f: Finding): string {
  const s = f.subject;
  if (s.routePattern) return s.routePattern + (s.viewport ? ` · ${s.viewport}` : '') + (s.colorScheme ? `/${s.colorScheme}` : '');
  if (s.file) return `${s.file.path}${s.file.line ? `:${s.file.line}` : ''}`;
  return 'property-wide';
}

function evidenceHtml(f: Finding, runDirPath: string): string {
  const parts: string[] = [];
  for (const e of f.evidence) {
    if (e.kind === 'verdict') {
      const uri = inlineImage(runDirPath, e.cropPath);
      if (uri) parts.push(`<figure><img src="${uri}" alt="judged crop"><figcaption>Claude (${esc(e.model)}): ${esc(e.verdict)} — ${esc(e.reason)}</figcaption></figure>`);
    } else if (e.kind === 'screenshot' && e.region) {
      const uri = inlineImage(runDirPath, e.path, e.region);
      if (uri) parts.push(`<figure><img src="${uri}" alt="region"></figure>`);
    } else if (e.kind === 'computed-style') {
      parts.push(`<pre class="ev">${esc(Object.entries(e.properties).map(([k, v]) => `${k}: ${v}`).join('\n'))}</pre>`);
    } else if (e.kind === 'dom-snippet') {
      parts.push(`<pre class="ev">${esc(e.html)}</pre>`);
    } else if (e.kind === 'file') {
      parts.push(`<pre class="ev">${esc(e.path)}:${e.line}\n${esc(e.snippet)}</pre>`);
    } else if (e.kind === 'cookie') {
      parts.push(`<pre class="ev">cookie ${esc(e.name)} @ ${esc(e.domain)} [${esc(e.phase)}]${e.classification ? ` — ${esc(e.classification)}` : ''}</pre>`);
    }
  }
  return parts.join('');
}

export interface HtmlOptions {
  cwd?: string;
  coverage?: CoverageMatrix[];
}

export function renderHtmlReport(run: Run, findings: Finding[], opts: HtmlOptions = {}): string {
  const runDirPath = runDir(run.id, opts.cwd);

  const byReq = new Map<string, Finding[]>();
  for (const f of findings) {
    const k = String(f.requirementId);
    const g = byReq.get(k);
    if (g) g.push(f);
    else byReq.set(k, [f]);
  }
  const groups = [...byReq.entries()].sort((a, b) => {
    const wa = Math.min(...a[1].map((f) => severityRank(f.severity)));
    const wb = Math.min(...b[1].map((f) => severityRank(f.severity)));
    return wa - wb;
  });

  const counts = { critical: 0, serious: 0, moderate: 0, minor: 0 } as Record<Severity, number>;
  for (const f of findings) counts[f.severity]++;

  const findingCards = groups
    .map(([reqId, group]) => {
      const req = getRequirement(reqId);
      const instrument = req ? getInstrument(String(req.instrument)) : undefined;
      const cards = group
        .sort((a, b) => severityRank(a.severity) - severityRank(b.severity))
        .map((f) => {
          const ev = evidenceHtml(f, runDirPath);
          return `<article class="finding" data-sev="${f.severity}" data-conf="${f.confidence}" data-producer="${f.producer.type}">
  <div class="fhead"><span class="badge b-${f.severity}">${f.severity}</span>
  <span class="conf">${f.confidence}</span><span class="prod">${esc(f.producer.type)}</span></div>
  <p class="fmsg">${esc(f.message)}</p>
  <div class="fmeta"><code>${esc(String(f.ruleId))}</code> · ${esc(subjectLabel(f))}</div>
  ${ev ? `<div class="fev">${ev}</div>` : ''}
</article>`;
        })
        .join('\n');
      return `<section class="req">
  <h3>${esc(reqId)} — ${esc(req?.title ?? reqId)}</h3>
  ${req ? `<blockquote>${esc(req.text)}<cite>${esc(instrument?.name ?? String(req.instrument))}</cite></blockquote>` : ''}
  ${cards}
</section>`;
    })
    .join('\n');

  const coverageHtml = (opts.coverage ?? [])
    .map(
      (m) => `<li><strong>${esc(m.ruleset)}</strong>: ${m.total} in scope — ${m.autoChecked} auto, ${m.llmAssisted} llm-assisted, <strong>${m.manualOnly} manual-only</strong></li>`,
    )
    .join('');

  const gapsHtml = run.gaps.length
    ? `<ul class="gaps">${run.gaps.map((g) => `<li>${esc(g.reason)}${g.note ? ` — ${esc(g.note)}` : ''}</li>`).join('')}</ul>`
    : '<p class="muted">No coverage gaps recorded.</p>';

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>complykit — ${esc(run.property)}</title>
<style>
:root{--bg:#fff;--fg:#1a1a1a;--muted:#666;--line:#e2e2e2;--card:#fafafa;--critical:#b00020;--serious:#c1440e;--moderate:#a06800;--minor:#4a5568;--accent:#2563eb}
@media(prefers-color-scheme:dark){:root{--bg:#16181d;--fg:#e6e6e6;--muted:#9aa0aa;--line:#2b2f38;--card:#1d2027;--accent:#6ea8fe}}
*{box-sizing:border-box}body{margin:0;font:15px/1.55 system-ui,sans-serif;color:var(--fg);background:var(--bg)}
.wrap{max-width:960px;margin:0 auto;padding:28px 20px 80px}
h1{font-size:24px;margin:0 0 4px}.sub{color:var(--muted);margin:0 0 20px}
.disclaimer{background:var(--card);border:1px solid var(--line);border-radius:8px;padding:12px 16px;font-size:13px;color:var(--muted);margin-bottom:22px}
.panel{border:1px solid var(--line);border-radius:8px;padding:14px 18px;margin-bottom:22px;background:var(--card)}
.panel h2{font-size:14px;text-transform:uppercase;letter-spacing:.04em;color:var(--muted);margin:0 0 10px}
.tally{display:flex;gap:10px;flex-wrap:wrap;margin-bottom:18px}
.tally span{padding:4px 10px;border-radius:20px;font-size:13px;border:1px solid var(--line)}
.badge{display:inline-block;padding:2px 8px;border-radius:4px;color:#fff;font-size:12px;font-weight:600;text-transform:uppercase}
.b-critical{background:var(--critical)}.b-serious{background:var(--serious)}.b-moderate{background:var(--moderate)}.b-minor{background:var(--minor)}
.filters{display:flex;gap:8px;flex-wrap:wrap;margin-bottom:18px}
.filters button{border:1px solid var(--line);background:var(--bg);color:var(--fg);padding:4px 10px;border-radius:6px;cursor:pointer;font-size:13px}
.filters button.off{opacity:.4}
.req{margin:26px 0}.req h3{font-size:16px;border-bottom:1px solid var(--line);padding-bottom:6px}
blockquote{margin:8px 0 14px;padding:8px 14px;border-left:3px solid var(--accent);color:var(--muted);font-size:13px}
blockquote cite{display:block;margin-top:6px;font-style:normal;font-size:12px}
.finding{border:1px solid var(--line);border-radius:8px;padding:12px 14px;margin:10px 0;background:var(--card)}
.fhead{display:flex;gap:10px;align-items:center;margin-bottom:6px}
.conf,.prod{font-size:12px;color:var(--muted)}
.fmsg{margin:6px 0}.fmeta{font-size:12px;color:var(--muted)}
.fev{margin-top:10px;display:flex;gap:12px;flex-wrap:wrap;align-items:flex-start}
.fev img{max-width:280px;max-height:200px;border:1px solid var(--line);border-radius:4px}
figure{margin:0}figcaption{font-size:12px;color:var(--muted);max-width:280px}
pre.ev{background:var(--bg);border:1px solid var(--line);border-radius:4px;padding:8px;font-size:12px;overflow:auto;max-width:100%;max-height:180px}
.muted{color:var(--muted)}.gaps{margin:0;padding-left:18px;color:var(--muted);font-size:13px}
code{font-size:12px}
</style></head><body><div class="wrap">
<h1>Findings — ${esc(run.property)}</h1>
<p class="sub">Run ${esc(String(run.id))}${run.gitSha ? ` · ${esc(run.gitSha.slice(0, 8))}` : ''} · complykit ${esc(run.versions.package)} · registry ${esc(run.versions.registry)}</p>
<div class="disclaimer">This report states <strong>findings, evidence, and coverage</strong>. It is not a legal conclusion and does not assert conformance. Each finding cites a specific requirement; review the evidence before acting.</div>

<div class="tally">
  <span><span class="badge b-critical">critical</span> ${counts.critical}</span>
  <span><span class="badge b-serious">serious</span> ${counts.serious}</span>
  <span><span class="badge b-moderate">moderate</span> ${counts.moderate}</span>
  <span><span class="badge b-minor">minor</span> ${counts.minor}</span>
</div>

<div class="panel"><h2>Coverage</h2>
  <p>Access levels exercised: ${run.accessLevels.length ? esc(run.accessLevels.join(', ')) : 'none recorded'}</p>
  ${coverageHtml ? `<ul>${coverageHtml}</ul>` : ''}
  <h2 style="margin-top:12px">Gaps</h2>${gapsHtml}
</div>

<div class="filters">
  <strong style="align-self:center;font-size:13px">Filter:</strong>
  <button data-f="sev" data-v="critical">critical</button>
  <button data-f="sev" data-v="serious">serious</button>
  <button data-f="sev" data-v="moderate">moderate</button>
  <button data-f="sev" data-v="minor">minor</button>
  <button data-f="conf" data-v="violation">violation</button>
  <button data-f="conf" data-v="needs-review">needs-review</button>
</div>

${findings.length ? findingCards : '<p class="muted">No findings were produced by the checks that ran. See coverage above for what was and was not exercised.</p>'}

<script>
(function(){
  var off={sev:{},conf:{}};
  function apply(){
    document.querySelectorAll('.finding').forEach(function(el){
      var hideSev=off.sev[el.dataset.sev], hideConf=off.conf[el.dataset.conf];
      el.style.display=(hideSev||hideConf)?'none':'';
    });
    document.querySelectorAll('.req').forEach(function(s){
      var any=[].some.call(s.querySelectorAll('.finding'),function(f){return f.style.display!=='none'});
      s.style.display=any?'':'none';
    });
  }
  document.querySelectorAll('.filters button').forEach(function(b){
    b.addEventListener('click',function(){
      var f=b.dataset.f,v=b.dataset.v; off[f][v]=!off[f][v];
      b.classList.toggle('off',!!off[f][v]); apply();
    });
  });
})();
</script>
</div></body></html>`;
}
