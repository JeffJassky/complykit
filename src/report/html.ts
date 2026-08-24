import fs from 'node:fs';
import path from 'node:path';
import { PNG } from 'pngjs';
import { runDir, type Finding, type Run, type Severity, type Box } from '../record/index.js';
import { getRequirement, getInstrument } from '../registry/index.js';
import type { CoverageMatrix } from './coverage.js';
import { SEVERITY_ORDER, aggregate, buildModel, orderFindings, relabelStyle } from './model.js';

// The deliverable UI (build-plan §8): ONE self-contained static HTML file per
// run — inline CSS/JS, evidence images as data URIs, no fetches. It must open
// from disk and attach to an email. Not a React SPA (the React rule governs
// host-embedded UI, which this package does not have).
//
// The report is a power tool, not a brochure: findings are rendered flat with a
// client-side model (group-by, facet filters, display toggles, copy-visible) so
// a reviewer can slice by file / rule / law and hand the visible set to an
// agent as markdown. All state lives in the page; nothing fetches.
//
// Design system (self-contained ⇒ system fonts only; personality carried by
// scale/weight/case, not typefaces):
//   - Two type voices encode provenance: sans for narration (messages, titles),
//     mono for anything an instrument produced (ids, paths, ratios, counts).
//   - Severity is the only strong colour: a rail on each card's left edge, a
//     proportional spectrum bar in the header (click a segment to filter), and
//     a composition mini-bar on each collapsed group row.
//   - Field labels are small-caps; machine strings are humanized at display
//     time only (the model keeps raw values for grouping/faceting/copy).
//
// Vocabulary: chrome states findings / evidence / coverage, never "compliant".
//
// The defect model (aggregation, keys, representative choice) lives in
// model.ts, shared with the JSON sidecar.

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

/** Read a PNG from the run's evidence dir, optionally crop a region, return a
 *  bounded data URI (or null). Keeps the file self-contained without inlining
 *  whole full-page captures. */
interface InlinedImage {
  uri: string;
  // Crop geometry in ORIGINAL screenshot coords, so an overlay can map absolute
  // sample points (x - cropX, y - cropY) and size a viewBox.
  cropX: number;
  cropY: number;
  width: number;
  height: number;
}

const CROP_PAD = 24;

function inlineImage(runDirPath: string, rel: string, region?: Box): InlinedImage | null {
  const abs = path.join(runDirPath, rel);
  if (!fs.existsSync(abs)) return null;
  try {
    let buf = fs.readFileSync(abs);
    let cropX = 0;
    let cropY = 0;
    let width = 0;
    let height = 0;
    if (region) {
      const src = PNG.sync.read(buf);
      const x0 = Math.max(0, Math.floor(region.x - CROP_PAD));
      const y0 = Math.max(0, Math.floor(region.y - CROP_PAD));
      const x1 = Math.min(src.width, Math.ceil(region.x + region.width + CROP_PAD));
      const y1 = Math.min(src.height, Math.ceil(region.y + region.height + CROP_PAD));
      const w = Math.max(1, x1 - x0);
      const h = Math.max(1, y1 - y0);
      cropX = x0; cropY = y0; width = w; height = h;
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
    } else {
      const src = PNG.sync.read(buf);
      width = src.width; height = src.height;
    }
    if (buf.length > 400_000) return null; // skip oversized inlines
    return { uri: `data:image/png;base64,${buf.toString('base64')}`, cropX, cropY, width, height };
  } catch {
    return null;
  }
}

// Only allow CSS colour literals we produced (rgb/rgba/hex) into inline styles.
function safeColor(c: string): string {
  return /^(#[0-9a-fA-F]{3,8}|rgba?\([\d.,\s%]+\))$/.test(c.trim()) ? c.trim() : 'transparent';
}

type ScreenshotSamples = Array<{ x: number; y: number }> | undefined;
type ScreenshotSwatches = Array<{ label: string; color: string; ratio?: number }> | undefined;

// The crop, overlaid with a marker on each sampled background pixel, plus the
// colour swatches behind the verdict — so "1.04–8.58" becomes something you can
// see rather than trust. The SVG shares the crop's pixel coordinate system via
// viewBox, so markers land on the exact pixels regardless of display scaling.
function contrastFigure(img: InlinedImage, samples: ScreenshotSamples, swatches: ScreenshotSwatches): string {
  const r = Math.max(1.5, img.width / 90);
  const dots = (samples ?? [])
    .map((s) => {
      const cx = s.x - img.cropX;
      const cy = s.y - img.cropY;
      if (cx < 0 || cy < 0 || cx > img.width || cy > img.height) return '';
      return `<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="#00e5ff" stroke-width="${r * 0.6}" paint-order="stroke"/><circle cx="${cx}" cy="${cy}" r="${r * 0.35}" fill="#00e5ff"/>`;
    })
    .join('');
  const overlay = dots
    ? `<svg class="ov" viewBox="0 0 ${img.width} ${img.height}" preserveAspectRatio="none" aria-hidden="true">${dots}</svg>`
    : '';
  const chips = (swatches ?? [])
    .map(
      (s) =>
        `<span class="swatch"><i style="background:${safeColor(s.color)}"></i>${esc(s.label)}${s.ratio != null ? ` <b>${s.ratio}:1</b>` : ''}</span>`,
    )
    .join('');
  return `<figure class="cfig">
  <div class="shot" style="max-width:${Math.min(280, img.width)}px">
    <img src="${img.uri}" alt="sampled region">${overlay}
  </div>
  ${chips ? `<div class="swatches">${chips}</div>` : ''}
</figure>`;
}

// Each evidence block renders as a labelled exhibit (small-caps caption above)
// wrapped in a part class (p-shot / p-code / p-style / p-misc) so display
// toggles can hide whole categories with one root class.
function exhibit(cls: string, label: string, inner: string): string {
  return `<div class="exh ${cls}"><div class="exl">${label}</div>${inner}</div>`;
}

function evidenceHtml(f: Finding, runDirPath: string): string {
  const parts: string[] = [];
  for (const e of f.evidence) {
    if (e.kind === 'verdict') {
      const img = inlineImage(runDirPath, e.cropPath);
      if (img) parts.push(exhibit('p-shot', 'review', `<figure class="cfig"><img src="${img.uri}" alt="judged crop"><figcaption>Claude (${esc(e.model)}): ${esc(e.verdict)} — ${esc(e.reason)}</figcaption></figure>`));
    } else if (e.kind === 'screenshot' && e.region) {
      // A hair-thin crop shows nothing — either the element box was degenerate
      // (hidden/zero-height) or it sat outside the capture and the crop clamped
      // to a sliver. Judge the OUTPUT image, so off-canvas boxes are caught too.
      // Render-layer guard: already-stored runs benefit without a rescan.
      if (e.region.width < 8 || e.region.height < 8) continue;
      const img = inlineImage(runDirPath, e.path, e.region);
      if (img && img.width >= 12 && img.height >= 12)
        parts.push(exhibit('p-shot', 'screenshot', contrastFigure(img, e.samples, e.swatches)));
    } else if (e.kind === 'computed-style') {
      // Render each property as a row; when the value is a colour literal, prefix
      // a swatch so there is always a colour to look at — even for findings whose
      // pixel measurement failed (no crop) or whose text is invisible.
      const rows = Object.entries(relabelStyle(e.properties))
        .map(([k, v]) => {
          const isColor = /^(#[0-9a-fA-F]{3,8}|rgba?\([\d.,\s%]+\))$/.test(v.trim());
          const chip = isColor ? `<i class="sw" style="background:${safeColor(v)}"></i>` : '';
          return `<div class="crow">${chip}<span class="ck">${esc(k)}</span>: <span class="cv">${esc(v)}</span></div>`;
        })
        .join('');
      parts.push(exhibit('p-style', 'computed style', `<div class="cstyle">${rows}</div>`));
    } else if (e.kind === 'dom-snippet') {
      parts.push(exhibit('p-code', 'markup', `<pre class="ev">${esc(e.html)}</pre>`));
    } else if (e.kind === 'file') {
      parts.push(exhibit('p-code', 'source', `<pre class="ev">${esc(e.path)}:${e.line}\n${esc(e.snippet)}</pre>`));
    } else if (e.kind === 'cookie') {
      parts.push(exhibit('p-misc', 'cookie', `<pre class="ev">cookie ${esc(e.name)} @ ${esc(e.domain)} [${esc(e.phase)}]${e.classification ? ` — ${esc(e.classification)}` : ''}</pre>`));
    }
  }
  return parts.join('');
}

export interface HtmlOptions {
  cwd?: string;
  coverage?: CoverageMatrix[];
}

// Human-facing rendering of the raw producer string — the model keeps the raw
// value (grouping keys must stay stable); only pixels change.
function prodShort(prod: string): string {
  if (prod === 'rule') return 'complykit';
  return prod.replace(/^engine:/, '').replace(/^agent:/, '');
}

export function renderHtmlReport(run: Run, findings: Finding[], opts: HtmlOptions = {}): string {
  const runDirPath = runDir(run.id, opts.cwd);

  // Stable order: severity-major, then rule — then collapse identical sightings
  // into defects (the model index IS the card id).
  const groupsAgg = aggregate(orderFindings(findings));
  const ordered = groupsAgg.map((g) => g.rep);
  const model = buildModel(groupsAgg);

  // Requirement metadata for group headers (title + legal text + instrument).
  const reqMeta: Record<string, { title: string; text: string; law: string }> = {};
  for (const f of ordered) {
    const id = String(f.requirementId);
    if (reqMeta[id]) continue;
    const req = getRequirement(id);
    const instrument = req ? getInstrument(String(req.instrument)) : undefined;
    reqMeta[id] = { title: req?.title ?? id, text: req?.text ?? '', law: instrument?.name ?? '' };
  }

  const counts = { critical: 0, serious: 0, moderate: 0, minor: 0 } as Record<Severity, number>;
  for (const f of ordered) counts[f.severity]++;

  // Flat cards. Every detail wears a part class so display toggles work, and
  // the card wears data-i so the JS can regroup by moving nodes.
  const cards = ordered
    .map((f, i) => {
      const m = model[i];
      const ev = evidenceHtml(f, runDirPath);
      const hasSnippet = f.evidence.some((e) => e.kind === 'file' || e.kind === 'dom-snippet');
      // Long engine prose (axe "Fix any of the following: …") clamps to two
      // lines; click expands. The full text always survives in copy.
      const long = m.msg.length > 220;
      const locBits: string[] = [];
      if (m.name && !hasSnippet) locBits.push(`<span class="loc-name">${esc(m.name)}</span>`);
      if (m.css) locBits.push(`<code class="loc-path">${esc(m.css)}</code>`);
      const metaBits: string[] = [];
      metaBits.push(`<div class="mf p-rule"><dt>rule</dt><dd><code>${esc(m.rule)}</code></dd></div>`);
      metaBits.push(`<div class="mf p-req"><dt>requirement</dt><dd><code>${esc(m.req)}</code><span class="law">${esc(m.law)}</span></dd></div>`);
      const page = m.routes.length ? m.routes[0] : m.url;
      if (page)
        metaBits.push(
          `<div class="mf p-page"><dt>page</dt><dd><code>${esc(page)}</code>${m.routes.length > 1 ? `<span class="law">+${m.routes.length - 1} more</span>` : ''}</dd></div>`,
        );
      if (m.cells.length) metaBits.push(`<div class="mf p-page"><dt>seen</dt><dd><code>${esc(m.cells.join(' · '))}</code></dd></div>`);
      if (m.file) metaBits.push(`<div class="mf p-file"><dt>file</dt><dd><code>${esc(m.file)}</code></dd></div>`);
      // The roll-up: identical sightings collapsed onto this card. Routes expand.
      const agg =
        m.n > 1 || m.routes.length > 1
          ? `<details class="agg p-agg"><summary>seen ×${m.n} on ${m.routes.length || 1} page${(m.routes.length || 1) === 1 ? '' : 's'}</summary><ul>${m.routes.map((r) => `<li>${esc(r)}</li>`).join('')}</ul></details>`
          : '';
      return `<article class="finding sv-${m.sev}" data-i="${i}">
  <div class="fhead">
    <span class="sev p-sev">${m.sev}</span>
    <span class="conf c-${esc(m.conf)} p-conf">${esc(m.conf.replace(/-/g, ' '))}</span>
    <span class="prod p-prod" title="${esc(m.prod)}">${esc(prodShort(m.prod))}</span>
  </div>
  <p class="fmsg${long ? ' clamp' : ''}">${esc(m.msg)}</p>
  <dl class="fmeta">${metaBits.join('')}</dl>
  ${locBits.length ? `<div class="floc p-sel"><span class="fl">element</span>${locBits.join('')}</div>` : ''}
  ${agg}
  ${ev ? `<div class="fev">${ev}</div>` : ''}
</article>`;
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

  // Header spectrum: proportional severity bar + clickable count chips. The
  // chips ARE the severity filter (kept in sync with the facet dropdown).
  const spectrumHtml = ordered.length
    ? `<div class="spectrum" id="spectrum">
  <div class="specbar" aria-hidden="true">${SEVERITY_ORDER.map((s) => (counts[s] ? `<i class="sg-${s}" data-sev="${s}" style="flex:${counts[s]}"></i>` : '')).join('')}</div>
  <div class="speckey">${SEVERITY_ORDER.map((s) => `<button type="button" class="spec-chip" data-sev="${s}" title="Toggle ${s} findings"><i class="sg-${s}"></i>${s}<b>${counts[s]}</b></button>`).join('')}</div>
</div>`
    : '';

  // JSON payloads for the client script. `<` escaped so `</script>` in a snippet
  // can never terminate the block.
  const modelJson = JSON.stringify(model).replace(/</g, '\\u003c');
  const reqJson = JSON.stringify(reqMeta).replace(/</g, '\\u003c');

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>complykit — ${esc(run.property)}</title>
<style>
:root{
  --sans:system-ui,-apple-system,"Segoe UI",sans-serif;
  --mono:ui-monospace,"SF Mono",SFMono-Regular,Menlo,Consolas,monospace;
  --bg:#f6f7f9;--card:#ffffff;--fg:#1b1e24;--muted:#5f6875;--line:#dde1e7;--line2:#eceef2;
  --critical:#b0123c;--serious:#b34a09;--moderate:#8a6200;--minor:#5a6472;--accent:#2456d6;
}
@media(prefers-color-scheme:dark){:root{
  --bg:#131519;--card:#1b1e24;--fg:#e7e9ec;--muted:#98a1ad;--line:#2b3038;--line2:#232830;
  --critical:#ff6488;--serious:#ff8a4d;--moderate:#dfa71e;--minor:#93a0b0;--accent:#82aaff;
}}
*{box-sizing:border-box}
body{margin:0;font:14px/1.55 var(--sans);color:var(--fg);background:var(--bg);-webkit-font-smoothing:antialiased}
.wrap{max-width:1080px;margin:0 auto;padding:30px 22px 90px}
:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
code{font-family:var(--mono)}
button{font-family:var(--sans)}

/* ---- header ---- */
.eyebrow{font:600 10.5px var(--sans);text-transform:uppercase;letter-spacing:.16em;color:var(--muted)}
h1{font-size:26px;font-weight:650;letter-spacing:-.012em;margin:3px 0 6px}
.runline{margin:0 0 4px;font:12px var(--mono);color:var(--muted)}
.note{margin:0 0 22px;font-size:12px;color:var(--muted);max-width:76ch}
.partialnote{margin:0 0 14px;font:600 12px var(--sans);color:var(--moderate)}
.note strong{font-weight:600}

/* ---- severity spectrum (signature) ---- */
.spectrum{margin:0 0 20px}
.specbar{display:flex;gap:2px;height:10px;border-radius:5px;overflow:hidden}
.specbar i{display:block;min-width:8px;border-radius:2px;transition:opacity .15s ease}
.specbar i.off{opacity:.18}
.sg-critical{background:var(--critical)}.sg-serious{background:var(--serious)}.sg-moderate{background:var(--moderate)}.sg-minor{background:var(--minor)}
.speckey{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-top:9px}
.spec-chip{display:inline-flex;align-items:center;gap:6px;border:1px solid var(--line);background:var(--card);color:var(--fg);border-radius:999px;padding:3px 11px 3px 8px;font-size:12px;cursor:pointer;transition:opacity .15s ease,border-color .15s ease}
.spec-chip i{width:9px;height:9px;border-radius:3px;flex:none}
.spec-chip b{font:600 12px var(--mono)}
.spec-chip:hover{border-color:var(--accent)}
.spec-chip.off{opacity:.38}

/* ---- coverage panel ---- */
.panel{border:1px solid var(--line);border-radius:10px;margin-bottom:18px;background:var(--card)}
.panel>summary{cursor:pointer;user-select:none;list-style:none;padding:10px 16px;font:600 11px var(--sans);text-transform:uppercase;letter-spacing:.09em;color:var(--muted)}
.panel>summary::-webkit-details-marker{display:none}
.panel>summary::before{content:'▸';display:inline-block;margin-right:8px;font-size:10px;transition:transform .12s ease}
.panel[open]>summary::before{transform:rotate(90deg)}
.panel .pbody{padding:2px 18px 14px;font-size:13px}
.panel .pbody h2{font:600 11px var(--sans);text-transform:uppercase;letter-spacing:.09em;color:var(--muted);margin:12px 0 6px}
.panel ul{margin:6px 0;padding-left:18px}

/* ---- control bar ---- */
.bar{position:sticky;top:10px;z-index:10;border:1px solid var(--line);border-radius:12px;padding:9px 12px;margin-bottom:14px;display:flex;gap:8px;flex-wrap:wrap;align-items:center;background:var(--bg);box-shadow:0 2px 10px rgba(0,0,0,.05)}
.bar label{font-size:12px;color:var(--muted);display:inline-flex;align-items:center;gap:6px}
.bar select,.bar input[type=search]{border:1px solid var(--line);background:var(--card);color:var(--fg);border-radius:8px;padding:4px 8px;font-size:12.5px;font-family:var(--sans)}
.bar input[type=search]{min-width:170px}
.bar .count{font:11.5px var(--mono);color:var(--muted);margin-left:auto}
#facets{display:flex;gap:8px;flex-wrap:wrap;align-items:center}
.bar button{border:1px solid var(--line);background:var(--card);color:var(--fg);padding:4px 10px;border-radius:8px;cursor:pointer;font-size:12.5px}
.bar button:hover{border-color:var(--accent)}
#clearBtn{color:var(--accent);border-color:transparent;background:transparent}
details.dd{position:relative}
details.dd>summary{list-style:none;cursor:pointer;border:1px solid var(--line);background:var(--card);border-radius:8px;padding:4px 10px;font-size:12.5px;user-select:none;white-space:nowrap}
details.dd>summary::-webkit-details-marker{display:none}
details.dd[data-active="1"]>summary{border-color:var(--accent);color:var(--accent)}
details.dd>.menu{position:absolute;top:calc(100% + 4px);left:0;z-index:20;background:var(--card);border:1px solid var(--line);border-radius:10px;box-shadow:0 8px 28px rgba(0,0,0,.16);padding:8px;min-width:230px;max-width:430px;max-height:330px;overflow:auto}
.menu .mrow{display:flex;align-items:center;gap:7px;font-size:12.5px;padding:3px 5px;border-radius:6px;cursor:pointer;white-space:nowrap}
.menu .mrow:hover{background:var(--line2)}
.menu .mrow .n{margin-left:auto;color:var(--muted);font:11px var(--mono)}
.menu .mrow code{font-size:11.5px;overflow:hidden;text-overflow:ellipsis;max-width:300px}
.menu .mtools{display:flex;gap:6px;margin-bottom:6px;border-bottom:1px solid var(--line2);padding-bottom:6px}
.menu .mtools button{font-size:11px;padding:2px 8px;border:1px solid var(--line);background:var(--card);color:var(--fg);border-radius:6px;cursor:pointer}

/* ---- groups ---- */
.grp{margin:16px 0 6px}
.grp>summary{display:flex;align-items:center;gap:10px;padding:8px 6px;border-bottom:1px solid var(--line);cursor:pointer;user-select:none;list-style:none;border-radius:8px 8px 0 0}
.grp>summary::-webkit-details-marker{display:none}
.grp>summary:hover{background:color-mix(in srgb,var(--fg) 4%,transparent)}
.grp>summary::before{content:'▸';font-size:11px;color:var(--muted);transition:transform .12s ease;flex:none}
.grp[open]>summary::before{transform:rotate(90deg)}
.gtitle{display:flex;align-items:center;gap:8px;min-width:0;font-size:13.5px;font-weight:600;margin-right:auto}
.gtitle code{font:600 12.5px var(--mono)}
.gtitle .gsub{font-weight:500;color:var(--muted)}
.gdot{width:10px;height:10px;border-radius:3px;flex:none}
.gspec{display:flex;gap:1px;height:6px;width:72px;border-radius:3px;overflow:hidden;flex:none}
.gspec i{display:block;min-width:3px}
.gcount{font:11.5px var(--mono);color:var(--muted);flex:none}
.gcopy{border:1px solid var(--line);background:var(--card);color:var(--muted);border-radius:6px;font-size:11px;padding:2px 9px;cursor:pointer;flex:none}
.gcopy:hover{border-color:var(--accent);color:var(--accent)}
blockquote{margin:10px 0 4px;padding:8px 14px;border-left:3px solid var(--line);color:var(--muted);font-size:12.5px;max-width:78ch}
blockquote cite{display:block;margin-top:5px;font-style:normal;font:11px var(--mono)}

/* ---- finding card ---- */
/* content-visibility: offscreen cards (there can be hundreds, with inline
   images) skip layout+paint entirely — scrolling stays smooth at any size. */
.finding{background:var(--card);border:1px solid var(--line);border-left-width:3px;border-radius:10px;padding:12px 16px;margin:10px 0;content-visibility:auto;contain-intrinsic-size:auto 200px}
.sv-critical{border-left-color:var(--critical)}.sv-serious{border-left-color:var(--serious)}.sv-moderate{border-left-color:var(--moderate)}.sv-minor{border-left-color:var(--minor)}
.fhead{display:flex;gap:10px;align-items:center}
.sev{font:700 10.5px var(--sans);text-transform:uppercase;letter-spacing:.09em}
.sv-critical .sev{color:var(--critical)}.sv-serious .sev{color:var(--serious)}.sv-moderate .sev{color:var(--moderate)}.sv-minor .sev{color:var(--minor)}
.conf{font-size:11px;border-radius:999px;padding:1.5px 9px}
.c-violation{background:color-mix(in srgb,var(--fg) 9%,transparent)}
.c-needs-review{border:1px dashed var(--line);color:var(--muted)}
.prod{margin-left:auto;font:11px var(--mono);color:var(--muted)}
.fmsg{margin:7px 0 9px;font-size:14px;line-height:1.5;max-width:82ch}
.fmsg.clamp{display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;cursor:pointer}
.fmsg.clamp.open{display:block;overflow:visible}
.fmeta{display:flex;flex-wrap:wrap;gap:3px 20px;margin:0}
.mf{display:flex;align-items:baseline;gap:7px;min-width:0}
.mf dt,.fl{font:600 9.5px var(--sans);text-transform:uppercase;letter-spacing:.08em;color:var(--muted);flex:none}
.mf dd{margin:0;font:11.5px var(--mono);overflow-wrap:anywhere}
.mf .law{font:11px var(--sans);color:var(--muted);margin-left:6px}
.floc{display:flex;align-items:baseline;gap:7px;margin-top:5px;min-width:0}
.loc-name{font-size:12px;font-weight:600}
.loc-path{font:11px var(--mono);color:var(--muted);overflow-wrap:anywhere}
.agg{font-size:12px;color:var(--muted);margin-top:6px}
.agg>summary{cursor:pointer;user-select:none;list-style:none;display:inline-block;border:1px solid var(--line);border-radius:999px;padding:1px 10px;font-size:11px}
.agg>summary::-webkit-details-marker{display:none}
.agg>summary:hover{border-color:var(--accent);color:var(--accent)}
.agg ul{margin:6px 0 0;padding-left:18px;columns:2;font:11.5px var(--mono)}

/* ---- evidence exhibits ---- */
.fev{margin-top:11px;padding-top:10px;border-top:1px solid var(--line2);display:flex;gap:18px;flex-wrap:wrap;align-items:flex-start}
.exh{min-width:0}
.exl{font:600 9.5px var(--sans);text-transform:uppercase;letter-spacing:.08em;color:var(--muted);margin-bottom:5px}
.fev img{max-width:280px;max-height:200px;border:1px solid var(--line2);border-radius:8px}
.cfig{margin:0}
.shot{position:relative;display:inline-block;line-height:0}
.shot img{display:block;width:100%;height:auto}
/* Bare crop by default; the sampled-pixel markers reveal when hovering anywhere
   on the finding card, so the image is never obscured unless you ask to see what
   was measured. */
.shot .ov{position:absolute;inset:0;width:100%;height:100%;pointer-events:none;opacity:0;transition:opacity .12s ease}
.finding:hover .ov{opacity:1}
.swatches{display:flex;gap:10px;flex-wrap:wrap;margin-top:6px;line-height:1.4}
.swatch{display:inline-flex;align-items:center;gap:5px;font-size:11px;color:var(--muted)}
.swatch i{width:14px;height:14px;border-radius:3px;border:1px solid var(--line);display:inline-block}
.swatch b{color:var(--fg);font:600 11px var(--mono)}
figure{margin:0}figcaption{font-size:12px;color:var(--muted);max-width:280px}
pre.ev{margin:0;background:color-mix(in srgb,var(--fg) 4%,transparent);border:1px solid var(--line2);border-radius:8px;padding:8px 11px;font:11.5px/1.55 var(--mono);overflow:auto;max-width:560px;max-height:180px}
.cstyle{background:color-mix(in srgb,var(--fg) 4%,transparent);border:1px solid var(--line2);border-radius:8px;padding:8px 11px;font:11.5px/1.65 var(--mono);min-width:180px;max-width:560px;overflow-x:auto}
.cstyle .crow{display:flex;align-items:center;gap:6px;white-space:nowrap}
.cstyle .sw{width:12px;height:12px;border-radius:3px;border:1px solid var(--line);flex:none}
.cstyle .ck{color:var(--muted)}.cstyle .cv{color:var(--fg)}
.muted{color:var(--muted)}.gaps{margin:0;padding-left:18px;color:var(--muted);font-size:13px}
.toast{position:fixed;bottom:18px;left:50%;transform:translateX(-50%);background:var(--fg);color:var(--bg);font-size:13px;padding:8px 16px;border-radius:10px;opacity:0;transition:opacity .2s;pointer-events:none;z-index:50}
.toast.on{opacity:.94}
@media (prefers-reduced-motion:reduce){*{transition:none!important}}

/* display toggles: root classes hide part classes */
${['sev', 'conf', 'prod', 'rule', 'req', 'page', 'file', 'sel', 'code', 'style', 'shot', 'misc', 'agg']
  .map((p) => `body.hide-${p} .p-${p}{display:none!important}`)
  .join('\n')}
</style></head><body><div class="wrap">
<header>
<div class="eyebrow">complykit evidence report</div>
<h1>${esc(run.property)}</h1>
<p class="runline">${esc(String(run.id))}${run.gitSha ? ` · ${esc(run.gitSha.slice(0, 8))}` : ''} · complykit ${esc(run.versions.package)} · registry ${esc(run.versions.registry)}</p>
${run.partial ? `<p class="partialnote">Targeted (partial) run — ${esc(Object.entries(run.partial).map(([k, v]) => `${k}=${v}`).join(' · '))}. Totals cover only the targeted slice; not comparable to a full run.</p>` : ''}
<p class="note">States <strong>findings, evidence, and coverage</strong> — not a legal conclusion, and does not assert conformance. Each finding cites a specific requirement; review the evidence before acting.</p>
</header>

${spectrumHtml}

<details class="panel"><summary>Coverage &amp; gaps</summary><div class="pbody">
  <p>Access levels exercised: ${run.accessLevels.length ? esc(run.accessLevels.join(', ')) : 'none recorded'}</p>
  ${coverageHtml ? `<ul>${coverageHtml}</ul>` : ''}
  <h2>Gaps</h2>${gapsHtml}
</div></details>

<div class="bar" id="bar">
  <label>Group <select id="groupBy">
    <option value="req">requirement</option>
    <option value="law">law</option>
    <option value="sev">severity</option>
    <option value="rule">violation type</option>
    <option value="prod">detected by</option>
    <option value="file">file</option>
    <option value="route">page</option>
    <option value="none">none</option>
  </select></label>
  <span id="facets"></span>
  <input type="search" id="q" placeholder="filter text…">
  <details class="dd" id="showDd"><summary>Display ▾</summary><div class="menu" id="showMenu"></div></details>
  <button id="copyBtn" title="Copy visible findings as markdown">Copy visible</button>
  <button id="clearBtn" hidden>Clear filters</button>
  <span class="count" id="count"></span>
</div>

<div id="groups">
${ordered.length ? cards : '<p class="muted">No findings were produced by the checks that ran. See coverage above for what was and was not exercised.</p>'}
</div>
<div class="toast" id="toast"></div>

<script type="application/json" id="fdata">${modelJson}</script>
<script type="application/json" id="rdata">${reqJson}</script>
<script>
(function(){
  var M = JSON.parse(document.getElementById('fdata').textContent);
  var REQ = JSON.parse(document.getElementById('rdata').textContent);
  var cards = {};
  document.querySelectorAll('.finding').forEach(function(el){ cards[el.dataset.i] = el; });
  var groupsEl = document.getElementById('groups');
  var SEV_RANK = {critical:0, serious:1, moderate:2, minor:3};
  var SEVS = ['critical','serious','moderate','minor'];

  // facet accessors — also the group-by accessors
  var GET = {
    sev: function(f){ return f.sev; },
    conf: function(f){ return f.conf; },
    law: function(f){ return f.law; },
    req: function(f){ return f.req; },
    rule: function(f){ return f.rule; },
    prod: function(f){ return f.prod; },
    file: function(f){ return f.file ? f.file.replace(/:\\d+$/,'') : '(no file)'; },
    route: function(f){ return f.routes[0] || f.url || '(no page)'; },
    none: function(){ return 'All findings'; }
  };

  // Raw model values → human labels, at display time only (keys stay raw).
  function disp(key, v){
    v = String(v);
    if (key === 'prod') return v === 'rule' ? 'complykit' : v.replace(/^engine:/,'').replace(/^agent:/,'');
    if (key === 'conf') return v.replace(/-/g,' ');
    return v;
  }

  // ---- facet filters (checkbox dropdowns) ----
  var FACETS = [
    {key:'sev', label:'Severity'},
    {key:'conf', label:'Confidence'},
    {key:'law', label:'Law'},
    {key:'prod', label:'Detected by'},
    {key:'rule', label:'Type'},
    {key:'file', label:'File'},
    {key:'route', label:'Page'}
  ];
  var off = {}; // off[key] = Set of deselected values
  FACETS.forEach(function(fa){ off[fa.key] = new Set(); });

  // A defect seen on many routes counts toward EVERY route's facet value.
  function routeVals(f){ return f.routes.length ? f.routes : [f.url || '(no page)']; }
  function facetValues(key){
    var seen = new Map();
    M.forEach(function(f){
      var vs = key === 'route' ? routeVals(f) : [GET[key](f)];
      vs.forEach(function(v){ seen.set(v, (seen.get(v)||0)+1); });
    });
    var vals = Array.from(seen.entries());
    if (key === 'sev') vals.sort(function(a,b){ return (SEV_RANK[a[0]]||9)-(SEV_RANK[b[0]]||9); });
    else vals.sort(function(a,b){ return b[1]-a[1] || String(a[0]).localeCompare(String(b[0])); });
    return vals;
  }

  var facetsHost = document.getElementById('facets');
  FACETS.forEach(function(fa){
    var vals = facetValues(fa.key);
    if (vals.length < 2 && fa.key !== 'sev' && fa.key !== 'conf') return; // pointless dropdown
    var dd = document.createElement('details');
    dd.className = 'dd'; dd.dataset.key = fa.key;
    var rows = vals.map(function(v){
      return '<label class="mrow"><input type="checkbox" checked data-v="'+encodeURIComponent(v[0])+'"><code>'+escHtml(disp(fa.key, v[0]))+'</code><span class="n">'+v[1]+'</span></label>';
    }).join('');
    dd.innerHTML = '<summary>'+fa.label+' ▾</summary><div class="menu">' +
      '<div class="mtools"><button data-act="all">all</button><button data-act="none">none</button><button data-act="inv">invert</button></div>' +
      rows + '</div>';
    facetsHost.appendChild(dd);
    dd.addEventListener('change', function(e){
      var cb = e.target;
      if (cb.tagName !== 'INPUT') return;
      var v = decodeURIComponent(cb.dataset.v);
      if (cb.checked) off[fa.key].delete(v); else off[fa.key].add(v);
      sync(dd, fa.key); apply();
    });
    dd.querySelector('.mtools').addEventListener('click', function(e){
      var act = e.target.dataset.act; if (!act) return;
      dd.querySelectorAll('input[type=checkbox]').forEach(function(cb){
        var v = decodeURIComponent(cb.dataset.v);
        if (act === 'all') { cb.checked = true; off[fa.key].delete(v); }
        else if (act === 'none') { cb.checked = false; off[fa.key].add(v); }
        else { cb.checked = !cb.checked; if (cb.checked) off[fa.key].delete(v); else off[fa.key].add(v); }
      });
      sync(dd, fa.key); apply();
    });
  });
  function sync(dd, key){ dd.dataset.active = off[key].size ? '1' : '0'; }

  // ---- severity spectrum: header chips/bar mirror the sev facet ----
  var spectrum = document.getElementById('spectrum');
  function syncSevUI(){
    if (spectrum) spectrum.querySelectorAll('[data-sev]').forEach(function(el){
      el.classList.toggle('off', off.sev.has(el.dataset.sev));
    });
    var dd = document.querySelector('details.dd[data-key="sev"]');
    if (dd) {
      dd.querySelectorAll('input[type=checkbox]').forEach(function(cb){
        cb.checked = !off.sev.has(decodeURIComponent(cb.dataset.v));
      });
      dd.dataset.active = off.sev.size ? '1' : '0';
    }
  }
  if (spectrum) spectrum.addEventListener('click', function(e){
    var seg = e.target.closest('[data-sev]');
    if (!seg) return;
    var s = seg.dataset.sev;
    if (off.sev.has(s)) off.sev.delete(s); else off.sev.add(s);
    apply();
  });

  // close open dropdowns on outside click; expand clamped messages on click
  document.addEventListener('click', function(e){
    document.querySelectorAll('details.dd[open]').forEach(function(dd){
      if (!dd.contains(e.target)) dd.removeAttribute('open');
    });
    var msg = e.target.closest ? e.target.closest('.fmsg.clamp') : null;
    if (msg) msg.classList.toggle('open');
  });

  // ---- search ----
  var q = '';
  document.getElementById('q').addEventListener('input', function(e){
    q = e.target.value.toLowerCase(); apply();
  });
  function matchesSearch(f){
    if (!q) return true;
    var hay = [f.msg, f.rule, f.req, f.law, f.file, f.routes.join(' '), f.url, f.css, f.name, f.prod].join(' ').toLowerCase();
    return hay.indexOf(q) !== -1;
  }

  // ---- visibility ----
  function visible(f){
    for (var k in off) {
      if (!off[k].size) continue;
      if (k === 'route') {
        // multi-route defect: hidden only when EVERY page it appears on is off
        if (routeVals(f).every(function(r){ return off[k].has(r); })) return false;
      } else if (off[k].has(GET[k](f))) return false;
    }
    return matchesSearch(f);
  }
  function visibleSet(){ return M.filter(visible); }
  function anyFilter(){
    if (q) return true;
    for (var k in off) if (off[k].size) return true;
    return false;
  }

  // ---- clear all filters ----
  var clearBtn = document.getElementById('clearBtn');
  clearBtn.addEventListener('click', function(){
    for (var k in off) off[k].clear();
    q = ''; document.getElementById('q').value = '';
    document.querySelectorAll('#facets details.dd').forEach(function(dd){
      dd.dataset.active = '0';
      dd.querySelectorAll('input[type=checkbox]').forEach(function(cb){ cb.checked = true; });
    });
    apply();
  });

  // ---- display toggles ----
  var PARTS = [
    {c:'sev', label:'Severity'},
    {c:'conf', label:'Confidence'},
    {c:'prod', label:'Detected by'},
    {c:'rule', label:'Rule id'},
    {c:'req', label:'Requirement'},
    {c:'page', label:'Page / viewport'},
    {c:'file', label:'File:line'},
    {c:'sel', label:'Selector / element'},
    {c:'code', label:'Code block'},
    {c:'style', label:'Computed style'},
    {c:'shot', label:'Screenshot'},
    {c:'misc', label:'Other evidence'},
    {c:'agg', label:'Sightings roll-up'}
  ];
  var hidden = new Set();
  var showMenu = document.getElementById('showMenu');
  showMenu.innerHTML = '<div class="mtools"><button data-act="all">all</button><button data-act="none">none</button></div>' +
    PARTS.map(function(p){
      return '<label class="mrow"><input type="checkbox" checked data-c="'+p.c+'"><span>'+p.label+'</span></label>';
    }).join('');
  showMenu.addEventListener('change', function(e){
    var cb = e.target; if (cb.tagName !== 'INPUT') return;
    setPart(cb.dataset.c, cb.checked);
  });
  showMenu.querySelector('.mtools').addEventListener('click', function(e){
    var act = e.target.dataset.act; if (!act) return;
    showMenu.querySelectorAll('input[type=checkbox]').forEach(function(cb){
      cb.checked = act === 'all'; setPart(cb.dataset.c, cb.checked);
    });
  });
  function setPart(c, on){
    if (on) hidden.delete(c); else hidden.add(c);
    document.body.classList.toggle('hide-'+c, !on);
    document.getElementById('showDd').dataset.active = hidden.size ? '1' : '0';
  }

  // ---- grouping + render ----
  var groupBy = 'req';
  document.getElementById('groupBy').addEventListener('change', function(e){
    groupBy = e.target.value; apply();
  });

  function apply(){
    syncSevUI();
    var vis = visibleSet();
    // bucket in model order (already severity-major)
    var buckets = new Map();
    vis.forEach(function(f){
      var k = GET[groupBy](f);
      if (!buckets.has(k)) buckets.set(k, []);
      buckets.get(k).push(f);
    });
    // order groups by their most severe member, then size
    var keys = Array.from(buckets.keys());
    keys.sort(function(a,b){
      var ra = Math.min.apply(null, buckets.get(a).map(function(f){ return SEV_RANK[f.sev]; }));
      var rb = Math.min.apply(null, buckets.get(b).map(function(f){ return SEV_RANK[f.sev]; }));
      return ra - rb || buckets.get(b).length - buckets.get(a).length || String(a).localeCompare(String(b));
    });
    groupsEl.textContent = '';
    keys.forEach(function(k){
      var fs = buckets.get(k);
      // Collapsed by default when a real grouping is active — the group list IS
      // the overview; open a group to drill in. "none" stays expanded.
      var sec = document.createElement('details');
      sec.className = 'grp';
      if (groupBy === 'none') sec.open = true;
      var h = document.createElement('summary');
      var title = disp(groupBy, k);
      var titleHtml;
      if (groupBy === 'req' && REQ[k]) {
        title = k + ' — ' + REQ[k].title;
        titleHtml = '<code>'+escHtml(k)+'</code><span class="gsub">'+escHtml(REQ[k].title)+'</span>';
      } else if (groupBy === 'sev') {
        titleHtml = '<i class="gdot sg-'+escHtml(k)+'"></i><span>'+escHtml(title)+'</span>';
      } else if (groupBy === 'rule' || groupBy === 'file' || groupBy === 'route') {
        titleHtml = '<code>'+escHtml(title)+'</code>';
      } else {
        titleHtml = '<span>'+escHtml(title)+'</span>';
      }
      // Severity composition of the group — legible while collapsed.
      var comp = {};
      fs.forEach(function(f){ comp[f.sev] = (comp[f.sev]||0)+1; });
      var spec = SEVS.map(function(s){
        return comp[s] ? '<i class="sg-'+s+'" style="flex:'+comp[s]+'" title="'+comp[s]+' '+s+'"></i>' : '';
      }).join('');
      var sight = fs.reduce(function(a,f){ return a + f.n; }, 0);
      h.innerHTML = '<span class="gtitle">'+titleHtml+'</span>' +
        '<span class="gspec" aria-hidden="true">'+spec+'</span>' +
        '<span class="gcount">'+fs.length+(sight>fs.length?' · '+sight+' sightings':'')+'</span>' +
        '<button class="gcopy" title="Copy this group as markdown">copy</button>';
      h.querySelector('.gcopy').addEventListener('click', function(e){
        e.preventDefault(); e.stopPropagation(); // copy must not toggle the group
        copyFindings(fs, String(title));
      });
      sec.appendChild(h);
      if (groupBy === 'req' && REQ[k] && REQ[k].text) {
        var bq = document.createElement('blockquote');
        bq.textContent = REQ[k].text;
        if (REQ[k].law) { var c = document.createElement('cite'); c.textContent = REQ[k].law; bq.appendChild(c); }
        sec.appendChild(bq);
      }
      fs.forEach(function(f){ sec.appendChild(cards[f.i]); });
      groupsEl.appendChild(sec);
    });
    if (!keys.length) {
      var p = document.createElement('p'); p.className = 'muted';
      p.textContent = 'No findings match the current filters.';
      groupsEl.appendChild(p);
    }
    var sightings = vis.reduce(function(a,f){ return a + f.n; }, 0);
    document.getElementById('count').textContent =
      (vis.length === M.length ? M.length + ' defects' : vis.length + ' of ' + M.length + ' defects') +
      ' · ' + sightings + ' sightings';
    clearBtn.hidden = !anyFilter();
  }

  // ---- copy visible as markdown (honours display toggles) ----
  function findingMd(f){
    var lines = [];
    var head = [];
    if (!hidden.has('sev')) head.push('['+f.sev+']');
    if (!hidden.has('rule')) head.push(f.rule);
    lines.push('### ' + (head.length ? head.join(' ') : 'finding'));
    if (!hidden.has('req')) lines.push('- Requirement: ' + f.req + ' — ' + f.reqTitle + ' (' + f.law + ')');
    if (!hidden.has('conf')) lines.push('- Confidence: ' + f.conf);
    if (!hidden.has('prod')) lines.push('- Detected by: ' + f.prod);
    if (!hidden.has('page')) {
      if (f.routes.length) lines.push('- Pages (' + f.routes.length + '): ' + f.routes.join(', '));
      else if (f.url) lines.push('- Page: ' + f.url);
      if (f.cells.length) lines.push('- Seen in: ' + f.cells.join(', '));
      if (f.n > 1) lines.push('- Sightings: ' + f.n);
    }
    if (!hidden.has('file') && f.file) lines.push('- File: ' + f.file);
    if (!hidden.has('sel')) {
      if (f.css) lines.push('- Selector: ' + f.css);
      if (f.name) lines.push('- Element: ' + f.name);
    }
    lines.push('');
    lines.push(f.msg);
    if (!hidden.has('code') && f.snips.length) {
      f.snips.forEach(function(s){ lines.push('', '\`\`\`', s, '\`\`\`'); });
    }
    if (!hidden.has('style') && f.style) {
      lines.push('', 'Computed style:');
      for (var k in f.style) lines.push('- ' + k + ': ' + f.style[k]);
    }
    return lines.join('\\n');
  }
  function copyFindings(fs, label){
    var text = fs.map(findingMd).join('\\n\\n---\\n\\n');
    var doCopy = navigator.clipboard && navigator.clipboard.writeText
      ? navigator.clipboard.writeText(text)
      : new Promise(function(res){
          var ta = document.createElement('textarea');
          ta.value = text; document.body.appendChild(ta); ta.select();
          document.execCommand('copy'); ta.remove(); res();
        });
    doCopy.then(function(){
      toast('Copied ' + fs.length + ' finding(s)' + (label ? ' — ' + label : ''));
    }, function(){ toast('Copy failed — clipboard blocked'); });
  }
  document.getElementById('copyBtn').addEventListener('click', function(){
    copyFindings(visibleSet(), '');
  });

  var toastTimer;
  function toast(msg){
    var t = document.getElementById('toast');
    t.textContent = msg; t.classList.add('on');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function(){ t.classList.remove('on'); }, 2200);
  }

  function escHtml(s){
    return s.replace(/[&<>"]/g, function(c){ return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]; });
  }

  apply();
})();
</script>
</div></body></html>`;
}
