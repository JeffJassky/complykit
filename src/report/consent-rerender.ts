import { escapeHtml as esc } from './human.js';

// R2 (plans/remediation-flow.md §9): recompute the report in place. The scan is
// saved; what a classification changes is how the saved observations are read
// (the compatibility section, the change list, the checklist, the matrix
// purposes). `complykit report --workspace <file>` re-renders the report from
// the saved run with the site workspace applied; on the service, one click
// (POST /api/jobs/:id/rerender) does that and reloads the page.
//
// The report records which classifications it was rendered with: the `at`
// stamp of every class: entry with a value in the workspace it was given.
// The page compares those stamps with the workspace's current ones (string
// equality — never clock arithmetic: entry times come from browsers' clocks)
// and offers the update when one of its own entries differs.

/** Embedded as <script type="application/json" id="ck-render">. */
export interface ReportRenderInfo {
  version: 1;
  /** When this HTML was rendered (ISO). */
  at: string;
  runId: string;
  /** True when a site workspace was applied to this rendering. */
  workspace: boolean;
  /** class: entry key (without the prefix) → its `at` stamp ('' when the entry has none), for every entry with a value. */
  classifications: Record<string, string>;
}

/** The parts of a site workspace the stamps are read from. */
export interface RenderWorkspaceEntries {
  entries: Record<string, { value?: unknown; at?: string }>;
}

const CLASS_PREFIX = 'class:';

export function reportRenderInfo(runId: string, ws: RenderWorkspaceEntries | undefined, at = new Date().toISOString()): ReportRenderInfo {
  const classifications: Record<string, string> = {};
  for (const [k, e] of Object.entries(ws?.entries ?? {})) {
    if (!k.startsWith(CLASS_PREFIX) || e?.value === null || e?.value === undefined) continue;
    classifications[k.slice(CLASS_PREFIX.length)] = typeof e.at === 'string' ? e.at : '';
  }
  return { version: 1, at, runId, workspace: Boolean(ws), classifications };
}

export const RERENDER_CSS = `.ck-rerender{margin:18px 0;padding:12px 16px;border:1px solid var(--line);border-radius:10px;background:var(--card)}.ck-rerender[hidden]{display:none!important}.ck-rerender p{margin:6px 0}.ck-rerender button{padding:8px 12px;margin:6px 8px 6px 0;font:600 14px system-ui,sans-serif;color:var(--fg);background:var(--card);border:1px solid var(--line);border-radius:6px;cursor:pointer}.ck-rerender button:disabled{opacity:.6;cursor:default}.ck-rerender pre{white-space:pre-wrap;word-break:break-all;background:var(--bg);border:1px solid var(--line);border-radius:6px;padding:8px;font:12px/1.5 var(--mono,ui-monospace,monospace)}.ck-rerender[data-state=changed]{position:sticky;top:0;z-index:5;border:2px solid var(--work-amber,#805100);background:var(--work-amber-bg,#fff7db)}.ck-rerender[data-state=changed] #ck-rerender-button{color:#fff;background:var(--accent);border-color:var(--accent)}
@media print{.ck-rerender{display:none!important}}`;

/** The panel (hidden until the script decides the mode) and the info block. Rendered once, above the grid. */
export function renderRerenderPanel(info: ReportRenderInfo | undefined, runId = info?.runId ?? '<run id>'): string {
  const json = info ? JSON.stringify(info).replace(/</g, '\\u003c') : '';
  const block = info ? `<script type="application/json" id="ck-render">${json}</script>` : '';
  return `${block}<section id="ck-rerender" class="ck-rerender" data-state="idle" hidden aria-live="polite">
<div data-rerender-service hidden><p id="ck-rerender-status">This report reflects the classifications saved when it was rendered.</p><button type="button" id="ck-rerender-button">Update report with my classifications</button><span id="ck-rerender-message" role="status"></span><p class="human-muted">Re-reads the saved scan with the site’s current classifications: the compatibility section, the change list and the checklist are recomputed. Nothing is rescanned; the website’s behavior is what the scan recorded.</p></div>
<div data-rerender-offline hidden><p><strong>Update this report with your classifications.</strong> Classifications made in this file stay in this browser. To recompute the compatibility section and change list from them, download them as a workspace file and re-render the report where the scan is saved:</p><button type="button" id="ck-rerender-download">Download classifications as a workspace file</button><pre>complykit report --run ${esc(runId)} --format consent-html --workspace complykit-workspace.json --out consent-report.html</pre><p class="human-muted">Run it in the folder that holds <code>.comply/runs</code> (or pass <code>--cwd</code>). Nothing is rescanned.</p></div>
</section>`;
}

// Keep the reader's place across the reload after a re-render ("Update report",
// "Show the new checklist", Generate). A raw scrollY is not enough: the page
// smooth-scrolls (human.ts), the browser's own restoration competes with ours,
// and the re-rendered page is a different length above the reader (a checklist
// appears, a notice goes). So the save records an anchor — the element with an
// id under the top of the viewport, or the one the action names (#remediation
// for the checklist's buttons) — and its offset; the restore puts that anchor
// back at that offset instantly, with the browser's restoration off, and again
// while the page settles (load, the workbench's first render, size changes)
// until the reader scrolls, clicks or types, or 4 s pass.
export const KEEP_SCROLL_JS = String.raw`(function(){
  var KEY='complykit:rerender-scroll:v1:'+location.pathname,STOP=['wheel','touchstart','keydown','mousedown'];
  function usable(el){if(el.closest('.ck-rerender'))return false;var p=getComputedStyle(el).position;return p!=='sticky'&&p!=='fixed';}
  function anchorAt(){
    var best=null,bestTop=-Infinity,below=null,belowTop=Infinity;
    document.querySelectorAll('main [id]').forEach(function(el){
      var r=el.getBoundingClientRect();if(!r.height)return;
      if(r.top<=1&&r.bottom>0){if(r.top>bestTop&&usable(el)){best=el;bestTop=r.top;}}
      else if(r.top>1&&r.top<belowTop&&usable(el)){below=el;belowTop=r.top;}
    });
    var el=best||below;return el?{id:el.id,offset:el.getBoundingClientRect().top}:null;
  }
  function save(at,anchorId){
    var a=null,el=anchorId&&document.getElementById(anchorId);
    if(el&&el.getBoundingClientRect().height)a={id:anchorId,offset:Math.max(0,Math.min(el.getBoundingClientRect().top,innerHeight-120))};
    if(!a)a=anchorAt();
    try{sessionStorage.setItem(KEY,JSON.stringify({y:window.scrollY,at:at||'',anchor:a}));}catch(e){}
    try{history.scrollRestoration='manual';}catch(e){}
  }
  var saved=null;try{saved=JSON.parse(sessionStorage.getItem(KEY)||'null');sessionStorage.removeItem(KEY);}catch(e){saved=null;}
  if(saved){
    var stopped=false;
    var target=function(){var a=saved.anchor,el=a&&a.id&&document.getElementById(a.id);if(el&&el.getBoundingClientRect().height)return el.getBoundingClientRect().top+window.scrollY-(a.offset||0);return saved.y||0;};
    var apply=function(){if(stopped)return;var y=Math.max(0,Math.round(target()));if(Math.abs(window.scrollY-y)>1)window.scrollTo({top:y,left:window.scrollX,behavior:'instant'});};
    var end=function(){if(stopped)return;stopped=true;STOP.forEach(function(n){removeEventListener(n,end,true);});try{history.scrollRestoration='auto';}catch(e){}};
    STOP.forEach(function(n){addEventListener(n,end,true);});
    apply();requestAnimationFrame(apply);addEventListener('load',function(){apply();requestAnimationFrame(apply);});
    addEventListener('complykit-workflow-changed',function(){requestAnimationFrame(apply);});
    if(window.ResizeObserver){var ro=new ResizeObserver(apply);ro.observe(document.body);setTimeout(function(){ro.disconnect();},4000);}
    setTimeout(end,4000);
  }
  window.ComplyKitScroll={save:save,restored:saved};
})();`;

export const RERENDER_JS = String.raw`(function(){
  var panel=document.getElementById('ck-rerender');if(!panel)return;
  var info=null;try{var ib=document.getElementById('ck-render');if(ib)info=JSON.parse(ib.textContent);}catch(e){info=null;}
  var service=null;try{var sc=document.getElementById('ck-service');if(sc){service=JSON.parse(sc.textContent);if(!service||typeof service.jobId!=='string')service=null;}}catch(e){service=null;}
  var keys=Array.from(new Set(Array.from(document.querySelectorAll('[data-class-key]')).map(function(el){return el.dataset.classKey;})));
  panel.hidden=false;
  if(!service){
    panel.querySelector('[data-rerender-offline]').hidden=false;
    document.getElementById('ck-rerender-download').addEventListener('click',function(){
      var ws=window.ComplyKitWorkspace,entries={},at=new Date().toISOString();
      keys.forEach(function(k){var c=ws&&ws.classification(k);if(c)entries['class:'+k]={value:c,at:at};});
      var url=URL.createObjectURL(new Blob([JSON.stringify({entries:entries},null,2)],{type:'application/json'}));var a=document.createElement('a');a.href=url;a.download='complykit-workspace.json';a.click();setTimeout(function(){URL.revokeObjectURL(url);},1000);
    });
    return;
  }
  panel.querySelector('[data-rerender-service]').hidden=false;
  var button=document.getElementById('ck-rerender-button'),status=document.getElementById('ck-rerender-status'),message=document.getElementById('ck-rerender-message');
  var busy=false;
  // After an update the page reloads where it was (KEEP_SCROLL_JS puts it back).
  var saved=window.ComplyKitScroll&&window.ComplyKitScroll.restored;if(saved&&saved.at)message.textContent='Report updated at '+String(saved.at).slice(11,16)+' UTC.';
  function rendered(){return info?' (rendered '+info.at.slice(0,16).replace('T',' ')+' UTC)':'';}
  // Which of this report's classifications differ from the ones it was rendered with; null while the workspace is loading.
  function changed(){
    var ws=window.ComplyKitWorkspace;if(!ws||!ws.classificationStamps)return null;
    var now=ws.classificationStamps();if(!now)return null;
    if(!info)return -1;
    return keys.filter(function(k){var a=now[k],b=info.classifications[k];return (a===undefined?null:a)!==(b===undefined?null:b);}).length;
  }
  function refresh(){
    if(busy)return;
    var n=changed();
    if(n===null){panel.dataset.state='idle';status.textContent='Checking the shared workspace…';return;}
    if(n===-1){panel.dataset.state='unknown';status.textContent='This report does not record which classifications it was rendered with. Update it to apply the site’s current classifications.';return;}
    panel.dataset.state=n?'changed':'current';
    status.textContent=n?(n===1?'1 classification has':n+' classifications have')+' changed since this report was rendered'+rendered()+'. The compatibility section, change list and checklist still show the earlier answers.':'This report reflects the current classifications'+rendered()+'.';
  }
  function wait(){var ws=window.ComplyKitWorkspace;return new Promise(function(resolve,reject){var t=0;(function poll(){if(!ws||!ws.pendingCount||!ws.pendingCount())return resolve();if((t+=200)>15000)return reject(Error('your latest changes are not saved to the shared workspace yet'));setTimeout(poll,200);})();});}
  button.addEventListener('click',function(){
    if(busy)return;busy=true;button.disabled=true;panel.dataset.state='working';message.textContent='';status.textContent='Saving your changes…';
    wait().then(function(){
      status.textContent='Re-rendering the report from the saved scan…';
      return fetch('/api/jobs/'+encodeURIComponent(service.jobId)+'/rerender',{method:'POST',credentials:'same-origin',cache:'no-store',headers:{'content-type':'application/json'},body:'{}'}).then(function(r){return r.json().catch(function(){return {};}).then(function(b){if(!r.ok||!b.ok)throw Error(b&&b.error||'HTTP '+r.status);return b;});});
    }).then(function(b){
      if(window.ComplyKitScroll)window.ComplyKitScroll.save(b.at);
      location.reload();
    },function(err){busy=false;button.disabled=false;message.textContent='Could not update the report: '+(err.message||'unknown error');refresh();});
  });
  window.addEventListener('complykit-workflow-changed',refresh);
  refresh();
})();`;
