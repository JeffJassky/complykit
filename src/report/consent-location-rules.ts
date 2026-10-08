import { escapeHtml as esc, safeHref } from './human.js';
import type { ConsentReportModel } from './consent-model.js';

// "Where we tested and which rules applied": per location, the place the browser
// was measured in and the model of rules the scan compared it against, with a
// hover / focus / click popover that explains the model and cites the laws.
// All facts come from `locations[].rules` (src/registry/describe.ts); this file
// only lays them out. Vocabulary: "rules", "model", "compared against".

type Rules = ConsentReportModel['locations'][number]['rules'];
type Law = Rules['laws'][number];

function link(url: string | undefined, text: string): string {
  return url ? `<a href="${esc(safeHref(url))}" rel="noopener" target="_blank">${esc(text)}</a>` : esc(text);
}

function lawItem(l: Law): string {
  const exposure = l.kind === 'exposure' ? ' <span class="ck-rules-muted">(litigation exposure, not an obligation)</span>' : '';
  return `<li>${link(l.urls[0], l.citation)} — ${esc(l.title)} <span class="ck-rules-muted">· since ${esc(l.since)}</span>${exposure}</li>`;
}

function stateLine(s: NonNullable<Rules['stateAct']>): string {
  const when = s.inForce ? `in force since ${s.from}` : `applies from ${s.from}`;
  const gpc = s.gpcFrom ? `, privacy signal since ${s.gpcFrom}` : '';
  return `<p class="ck-rules-state">${esc(s.name)} (${link(s.urls[0], s.citation)}) — ${esc(when + gpc)}</p>`;
}

function popover(id: string, label: string, r: Rules): string {
  const must = r.mustHave.length ? `<ul class="ck-rules-must">${r.mustHave.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>` : '';
  const laws = r.laws.length ? `<ol class="ck-rules-laws">${r.laws.map(lawItem).join('')}</ol>` : '';
  const state = r.stateAct ? stateLine(r.stateAct) : '';
  const notes = r.notes.map((n) => `<p class="ck-rules-note">${esc(n)}</p>`).join('');
  return `<div class="ck-rules-pop" id="rules-pop-${esc(id)}" data-open="false" role="region" aria-label="${esc(`Rules for ${label}`)}"><p class="ck-rules-summary">${esc(r.summary)}</p>${must}${laws}${state}${notes}</div>`;
}

export function renderLocationRulesHtml(m: ConsentReportModel): string {
  if (!m.locations.length) return '';
  const items = m.locations.map((l) => {
    const place = l.verdict === 'verified' ? `Verified in ${esc(l.observed)}` : `Observed ${esc(l.observed)}, <strong>not verified</strong>`;
    return `<article class="ck-loc" data-location="${esc(l.id)}"><strong class="ck-loc-name">${esc(l.label)}</strong> <span class="ck-rules-muted">${place}</span> <span class="ck-rules-muted">· compared against</span> <span class="ck-loc-rules"><button type="button" class="ck-rules-btn" aria-expanded="false" aria-controls="rules-pop-${esc(l.id)}">${esc(l.rules.label)}</button>${popover(l.id, l.label, l.rules)}</span></article>`;
  });
  return `<section id="locations-rules"><h2 class="human-section-title">Where we tested and which rules applied</h2><p class="human-muted">The scan compares each location with that location's rules. Hover or select the rules to see what they require and the laws behind them.</p>${items.join('')}</section>`;
}

export const LOCATION_RULES_CSS = `
#locations-rules .ck-loc{padding:12px 14px;margin:8px 0;border:1px solid var(--line);border-radius:10px;background:var(--card)}
.ck-rules-muted{color:var(--muted)}
.ck-loc-rules{position:relative;display:inline-block;max-width:100%}
.ck-rules-btn{font-size:14px;font-weight:600;padding:3px 10px;border:1px solid var(--accent);border-radius:20px;color:var(--accent);background:var(--card);max-width:100%;text-align:left}
.ck-rules-pop{display:none;position:absolute;z-index:20;left:0;top:calc(100% + 6px);width:min(520px,80vw);padding:14px 16px;border:1px solid var(--line);border-radius:10px;background:var(--card);color:var(--fg);box-shadow:0 8px 24px rgba(0,0,0,.18);font-size:14px;line-height:1.5;font-weight:400}
.ck-loc-rules:hover .ck-rules-pop,.ck-loc-rules:focus-within .ck-rules-pop,.ck-rules-pop[data-open="true"]{display:block}
.ck-rules-pop::before{content:'';position:absolute;left:0;right:0;top:-8px;height:8px}
.ck-rules-pop p{margin:6px 0}.ck-rules-pop ul,.ck-rules-pop ol{margin:6px 0;padding-left:20px}.ck-rules-pop li{margin:4px 0}
.ck-rules-state{padding-top:6px;border-top:1px solid var(--line)}.ck-rules-note{color:var(--muted)}
@media(max-width:600px){.ck-loc-rules{display:block;margin-top:6px}.ck-rules-pop{position:static;width:auto;max-width:100%;margin-top:6px;box-shadow:none}}
@media print{.ck-rules-pop{display:block!important;position:static;width:auto;box-shadow:none}}
`;

export const LOCATION_RULES_JS = `(function(){
var wraps=document.querySelectorAll('.ck-loc-rules');
function set(w,open){var b=w.querySelector('.ck-rules-btn'),p=w.querySelector('.ck-rules-pop');if(!b||!p)return;p.setAttribute('data-open',open?'true':'false');b.setAttribute('aria-expanded',open?'true':'false');}
function closeAll(){for(var i=0;i<wraps.length;i++)set(wraps[i],false);}
for(var i=0;i<wraps.length;i++){(function(w){var b=w.querySelector('.ck-rules-btn');if(!b)return;b.addEventListener('click',function(){set(w,b.getAttribute('aria-expanded')!=='true');});})(wraps[i]);}
document.addEventListener('keydown',function(e){if(e.key!=='Escape')return;closeAll();var a=document.activeElement;if(a&&a.closest&&a.closest('.ck-loc-rules')&&a.blur)a.blur();});
document.addEventListener('click',function(e){if(!e.target.closest||!e.target.closest('.ck-loc-rules'))closeAll();});
})();`;
