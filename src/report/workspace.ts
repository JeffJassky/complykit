import { COOKIE_PURPOSES, COOKIE_PURPOSE_LABELS, COOKIE_PURPOSE_DESCRIPTIONS, cookiePurposes } from './cookie-purpose.js';
import { PartyCategory } from '../registry/kb/schema.js';
import { actionQuestions, questionFields } from './questions.js';
import { createHash } from 'node:crypto';
import { escapeHtml as esc } from './human.js';

export const CATEGORIES = [...PartyCategory.options, 'performance', 'security', 'other'] as const;
export function workspaceId(type: string, identity: unknown): string {
  return `${type}-${createHash('sha256').update(JSON.stringify(identity)).digest('hex').slice(0, 32)}`;
}
export function tone(status: string): string { return /problem|violation/i.test(status) ? 'red' : /no finding|no cookie-specific/i.test(status) ? 'neutral' : 'amber'; }

export function actionControls(rule = '', requirement = '', compact = false): string {
  const research = `<p>Save research as you go. Blank answers remain open even if you mark the task done.</p>${questionFields(actionQuestions(rule, requirement))}<label>Research sources / links <textarea data-review-answer="sources" data-question-label="Which sources support your answers?" rows="2" maxlength="4000" placeholder="Vendor documentation, configuration, test evidence, or reviewer and date"></textarea></label><p data-review-summary role="status"></p><label>Notes / how you checked it <textarea data-work-note rows="2" maxlength="4000" placeholder="What changed, who checked it, or what is still needed"></textarea></label>`;
  return `<div class="work-controls" data-work-controls hidden><label>Task progress <select data-work-status aria-label="Task progress"><option value="open">To do</option><option value="in-progress">In progress</option><option value="done">Done — marked by me</option></select></label>${compact ? `<details class="human-details work-question-details"><summary>Record research, decisions and verification</summary><div>${research}</div></details>` : `<h4>Answer this action’s questions</h4>${research}`}<p class="work-feedback" data-work-feedback></p></div>`;
}
export function classificationControls(key: string, label: string, defaults: {owner?:string;category?:string;categories?:string[]} = {}): string {
  const purposes = cookiePurposes(defaults.categories ?? (defaults.category ? [defaults.category] : []));
  const primary = [...COOKIE_PURPOSES].reverse().find(c => c !== 'other' && c !== 'necessary' && purposes.includes(c)) ?? purposes[0] ?? '';
  return `<details class="classification-controls" data-work-controls hidden><summary>Research and classify ${esc(label)}</summary><div><p>Choose what this item actually does on your site. Answers save as you go.</p><form data-class-form="${esc(key)}"><label>Cookie / tool purpose <select name="category"><option value="">Choose a category…</option>${COOKIE_PURPOSES.map(c => `<option value="${c}"${primary === c ? ' selected' : ''}>${COOKIE_PURPOSE_LABELS[c]}</option>`).join('')}</select></label><button type="button" data-class-apply>Use this classification</button>
<p class="human-muted" data-purpose-description>${esc(COOKIE_PURPOSE_DESCRIPTIONS[primary] ?? "Choose a main purpose. Add other purposes below if needed.")}</p>
<details class="human-details"><summary>Additional purposes, if this item does more than one thing</summary><fieldset class="purpose-options"><legend>Also used for</legend>${COOKIE_PURPOSES.map(c => `<label><input type="checkbox" name="additionalCategories" value="${c}"${purposes.includes(c) && c !== primary ? ' checked' : ''}> ${COOKIE_PURPOSE_LABELS[c]}</label>`).join('')}</fieldset><p class="human-muted">Choose every actual use. Necessary does not override analytics, performance, advertisement or another optional use.</p></details>
<p data-category-impact role="status">Choosing a purpose recalculates this item’s grid checks against the saved observations. It does not change the website or retest it.</p>
<details class="human-details" data-class-research><summary>What this item is (facts complykit cannot see)</summary><div><p>Check your tag manager, the vendor’s data/cookie documentation and the person who installed it. Record sources, reviewer and date. Vendor documentation alone may not describe its use on this site. complykit decides what each purpose requires; your answers describe the item, they do not set its rules.</p><label>What is it used for on this site? <textarea name="purpose" rows="2" maxlength="2000" placeholder="For example: measures visits to our product pages"></textarea></label><label>Who owns or provides it? <input name="owner" value="${esc(defaults.owner ?? '')}" maxlength="1000" placeholder="Vendor / organization and internal owner if known"></label><label>What information does it collect, read, store or send? <textarea name="information" rows="2" maxlength="2000" placeholder="List the information and recipients; explicitly say none if verified"></textarea></label><label>Research evidence / source and reviewer <input name="source" maxlength="1000" placeholder="Vendor documentation, site owner, or reviewer"></label><button type="submit">Save research answers</button> <button type="button" data-class-clear>Clear my answer</button></div></details></form><p data-class-answer class="work-feedback"></p></div></details>`;
}

/** The workbench panel: counts, backups, sharing. The consent report titles it "Saved progress" — its to-do list is #remediation. */
export function workspacePanel(title = 'Your checklist'): string {
  return `<section id="report-workspace" class="workspace-panel" data-work-controls hidden><h2 class="human-section-title">${esc(title)}</h2><p>Answer the open classification questions and track fixes here. Your answers and task progress are separate from the original scan evidence.</p><div class="human-stats"><div class="human-stat" data-tone="red"><strong id="work-fix-count">0</strong><span>Still needs fixing</span></div><div class="human-stat" data-tone="amber"><strong id="work-review-count">0</strong><span>Still needs review</span></div><div class="human-stat" data-tone="amber"><strong id="work-class-count">0</strong><span>Tool / storage reviews incomplete</span></div><div class="human-stat" data-tone="green"><strong id="work-done-count">0</strong><span>Tasks marked done</span></div></div><p><strong id="work-question-count">0</strong> action questions still need answers.</p><p><strong id="work-class-done-count">0</strong> tool / storage review(s) complete. Task counts and classification questions are separate and can overlap.</p><label>Show tasks <select id="work-filter"><option value="all">All tasks</option><option value="remaining">Remaining tasks</option><option value="in-progress">In progress</option><option value="done">Marked done</option></select></label><button type="button" id="work-export">Download progress backup</button> <button type="button" id="work-snapshot" hidden>Export for sharing</button> <span id="work-snapshot-status" role="status"></span> <label class="work-import">Restore progress <input id="work-import" type="file" accept="application/json,.json"></label> <button type="button" id="work-reset">Reset this report’s progress</button><div id="work-identity" hidden><p id="work-name-status"></p><div id="work-name-form" hidden><label>Your name, stamped on the changes you make here (optional) <input id="work-name" maxlength="80" autocomplete="name"></label><button type="button" id="work-name-save">Use this name</button> <button type="button" id="work-name-skip">Skip</button></div></div><p id="work-storage-status" role="status" aria-live="polite"></p><p class="human-muted" id="work-storage-note">Saved locally in this browser for this report. Each scan has its own checklist. Moving the file or using another browser may require restoring a backup. Marking a task done means your team completed it; rerun the scan to verify the website’s behavior.</p></section>`;
}

export function workspaceScript(type: string, property: string, runId: string, fingerprints: string[]): string {
  const key = `complykit:report-workspace:v1:${workspaceId('report', [type, property, runId, [...fingerprints].sort()])}`;
  const config = JSON.stringify({ key, categories: CATEGORIES, purposes: COOKIE_PURPOSES, purposeLabels:COOKIE_PURPOSE_LABELS, purposeDescriptions:COOKIE_PURPOSE_DESCRIPTIONS, purposeAliases:Object.fromEntries(CATEGORIES.map(c=>[c,cookiePurposes([c])[0]])) }).replace(/</g, '\\u003c');
  return `<script type="application/json" id="workspace-config">${config}</script><script>${WORKSPACE_JS}</script>`;
}

export const WORKSPACE_CSS = `
:root{--work-red:#a52218;--work-red-bg:#fff0ed;--work-amber:#805100;--work-amber-bg:#fff7db;--work-green:#14663b;--work-green-bg:#ecf9f0;--work-neutral:#526071;--work-neutral-bg:#eef1f5}
@media(prefers-color-scheme:dark){:root{--work-red:#ffa99d;--work-red-bg:#3c201f;--work-amber:#f4ce70;--work-amber-bg:#352c16;--work-green:#8de3ac;--work-green-bg:#183526;--work-neutral:#bec9d9;--work-neutral-bg:#242d39}}
.human-status[data-tone],.work-feedback[data-tone],.classification-badge[data-tone]{color:var(--work-neutral);background:var(--work-neutral-bg);border-color:var(--work-neutral)}
[data-tone=red]{--tone:var(--work-red);--tone-bg:var(--work-red-bg)}[data-tone=amber]{--tone:var(--work-amber);--tone-bg:var(--work-amber-bg)}[data-tone=green]{--tone:var(--work-green);--tone-bg:var(--work-green-bg)}[data-tone=neutral]{--tone:var(--work-neutral);--tone-bg:var(--work-neutral-bg)}
.human-status[data-tone],.classification-badge[data-tone],.work-feedback[data-tone]{color:var(--tone);background:var(--tone-bg);border-color:var(--tone)}
.human-stat[data-tone]{border-top:4px solid var(--tone);background:var(--tone-bg)}.human-stat[data-tone] strong{color:var(--tone)}
.human-card[data-scan-tone]{border-left:5px solid var(--tone)}.human-card[data-work-state=done]{border-left-color:var(--work-green)}.human-card[data-work-state=in-progress]{border-left-color:var(--work-amber)}
.workspace-panel{margin:28px 0;padding:18px;border:1px solid var(--line);border-radius:12px;background:var(--card)}.workspace-panel .human-section-title{margin-top:0!important}
.work-controls{padding:14px;margin:18px 0;border:1px solid var(--line);border-radius:8px;background:var(--bg)}.work-controls label,.classification-controls label{display:block;margin:10px 0;font-weight:600;font-size:14px}.work-controls textarea,.classification-controls textarea,.classification-controls input,.classification-controls select,.work-controls select{display:block;margin-top:5px;width:100%;max-width:650px;box-sizing:border-box;padding:9px;font:14px/1.5 system-ui,sans-serif;color:var(--fg);background:var(--card);border:1px solid var(--line);border-radius:6px}
.classification-controls{padding:12px;border:1px solid var(--line);border-radius:8px;margin-top:12px}.classification-controls summary{cursor:pointer;font-weight:600}.purpose-options{border:0;padding:8px 0}.purpose-options label{display:inline-flex;align-items:center;gap:7px;margin-right:18px;font-weight:400}.purpose-options input[type=checkbox]{display:inline;width:auto;margin:0}.classification-controls button,.workspace-panel button{padding:8px;margin:6px 0;font:14px system-ui,sans-serif;color:var(--fg);background:var(--card);border:1px solid var(--line);border-radius:6px}.classification-badge,.work-feedback[data-tone]{display:inline-block;padding:5px 9px;border:1px solid;border-radius:6px;font-size:13px}.work-import{display:block;margin-top:12px}.ck-snapshot-banner{padding:10px 16px;font:600 14px/1.5 system-ui,sans-serif;text-align:center;color:var(--work-amber);background:var(--work-amber-bg);border-bottom:2px solid var(--work-amber)}.ck-snapshot-banner a{color:inherit;word-break:break-all}#work-identity input{display:block;margin-top:5px;width:100%;max-width:360px;box-sizing:border-box;padding:9px;font:14px/1.5 system-ui,sans-serif;color:var(--fg);background:var(--card);border:1px solid var(--line);border-radius:6px}#work-identity label{display:block;margin:10px 0;font-weight:600;font-size:14px}.work-import input{max-width:100%}.status-legend{display:flex;flex-wrap:wrap;gap:8px;margin:16px 0}.work-controls[hidden],[data-work-controls][hidden]{display:none!important}
@media print{.workspace-panel button,.workspace-panel input,.workspace-panel select,.work-controls,.classification-controls form{display:none!important}}
`;

const WORKSPACE_JS = String.raw`(function(){
  var config=JSON.parse(document.getElementById('workspace-config').textContent);
  var actions=Array.from(document.querySelectorAll('[data-action-key]'));
  var entries=Array.from(document.querySelectorAll('[data-class-key]'));
  var actionKeys=new Set(actions.map(function(el){return el.dataset.actionKey;}));
  var classKeys=new Set(entries.map(function(el){return el.dataset.classKey;}));
  var state={version:1,reportKey:config.key,actions:{},classifications:{},remediation:{}};
  var storageMessage='';
  // Guided-checklist tasks (src/report/consent-remediation.ts) live beside the actions under their own
  // workspace prefix: task:change:<id> → { status, note?, lastVerify? } (src/record/remediation.ts).
  var REM='task:change:';
  function remKeys(){return Array.from(document.querySelectorAll('[data-remediation-id]')).map(function(el){return REM+el.dataset.remediationId;});}
  function cleanRemediation(v){
    if(!v||typeof v!=='object')return undefined;var st=v.status==='done'?'done-unverified':v.status==='open'||v.status==='in-progress'?'todo':v.status;
    if(['todo','done-unverified','verified','failed','cannot-verify'].indexOf(st)<0)return undefined;var out={status:st};
    if(typeof v.note==='string'&&v.note.length<=4000)out.note=v.note;
    var lv=v.lastVerify;if(lv&&typeof lv==='object'&&['pass','fail','cannot-verify'].indexOf(lv.result)>=0&&typeof lv.message==='string'&&typeof lv.at==='string')out.lastVerify={at:lv.at.slice(0,40),result:lv.result,message:lv.message.slice(0,4000),evidence:Array.isArray(lv.evidence)?lv.evidence.filter(function(x){return typeof x==='string';}).slice(0,50).map(function(x){return x.slice(0,2000);}):[]};
    return out;
  }
  // Where answers live. With a <script id="ck-service"> block (injected only by
  // the complykit service) they go to the site's shared workspace; otherwise
  // localStorage keeps them for this report in this browser.
  var service=null;try{var sc=document.getElementById('ck-service');if(sc){service=JSON.parse(sc.textContent);if(!service||typeof service.domain!=='string'||typeof service.workspace!=='string')service=null;}}catch(e){service=null;}
  function validRecord(raw){
    if(!raw||raw.version!==1||raw.reportKey!==config.key||!raw.actions||typeof raw.actions!=='object'||!raw.classifications||typeof raw.classifications!=='object')throw Error('This backup is not for this report or has an invalid format.');
    var clean={version:1,reportKey:config.key,actions:{},classifications:{},remediation:{}};
    if(raw.remediation&&typeof raw.remediation==='object')Object.keys(raw.remediation).forEach(function(id){var v=/^[a-z][a-z-]*(:[0-9a-f]{6,64})?$/.test(id)?cleanRemediation(raw.remediation[id]):undefined;if(v)clean.remediation[id]=v;});
    Object.keys(raw.actions).forEach(function(key){var a=raw.actions[key];if(actionKeys.has(key)&&a&&['open','in-progress','done'].includes(a.status)&&typeof a.note==='string'&&a.note.length<=4000){var answers={};Object.keys(a.answers||{}).forEach(function(id){if(/^[a-z]+$/.test(id)&&typeof a.answers[id]==='string'&&a.answers[id].length<=4000)answers[id]=a.answers[id];});clean.actions[key]={status:a.status,note:a.note,answers:answers};if(typeof a.comparisonKey==='string'&&a.comparisonKey.length<=2000)clean.actions[key].comparisonKey=a.comparisonKey;}});
    Object.keys(raw.classifications).forEach(function(key){var c=raw.classifications[key];if(!classKeys.has(key)||!c||typeof c!=='object')return;var out={};['category','purpose','owner','information','source'].forEach(function(id){if(typeof c[id]==='string'&&c[id].length<=2000)out[id]=c[id];else out[id]='';});out.category=config.purposes.includes(config.purposeAliases[out.category])?config.purposeAliases[out.category]:'';out.categoryChosen=typeof c.categoryChosen==='boolean'?c.categoryChosen:!!out.category;out.additionalCategories=Array.isArray(c.additionalCategories)?Array.from(new Set(c.additionalCategories.map(function(v){return config.purposeAliases[v];}).filter(function(v){return config.purposes.includes(v)&&v!==out.category;}))):[];clean.classifications[key]=out;});
    return clean;
  }
  // An export (see exportSnapshot) carries <script id="ck-snapshot">; offline it is the base the local edits layer on.
  var snapshot=null;if(!service)try{var sn=document.getElementById('ck-snapshot');if(sn){var snap=JSON.parse(sn.textContent);if(snap&&typeof snap.at==='string'&&snap.entries&&typeof snap.entries==='object')snapshot=snap;}}catch(e){snapshot=null;}
  function snapshotDate(){return snapshot?snapshot.at.slice(0,10):'';}
  function emptyState(){
    var s={version:1,reportKey:config.key,actions:{},classifications:{},remediation:{}};
    if(snapshot){var raw={version:1,reportKey:config.key,actions:{},classifications:{},remediation:{}};Object.keys(snapshot.entries).forEach(function(ek){var e=snapshot.entries[ek];if(!e||e.value===null||e.value===undefined)return;var key=ek.slice(ek.indexOf(':')+1);if(ek.indexOf(REM)===0)raw.remediation[ek.slice(REM.length)]=e.value;else if(ek.indexOf('task:')===0)raw.actions[key]=e.value;else raw.classifications[key]=e.value;});try{s=validRecord(raw);}catch(x){}}
    return s;
  }
  function plural(n,one,many){return n+' '+(n===1?one:many);}
  function browserOnly(n,tasks){return 'Saved in this browser only — '+plural(n,'classification is','classifications are')+' not shared; export them'+(tasks?'. '+plural(tasks,'task update is','task updates are')+' not shared either.':'');}
  var local={
    message:'',
    load:function(){state=emptyState();if(snapshot)local.message='Starting from the snapshot of '+snapshotDate()+'. ';try{var stored=localStorage.getItem(config.key);if(stored){var st=validRecord(JSON.parse(stored));Object.assign(state.actions,st.actions);Object.assign(state.classifications,st.classifications);Object.assign(state.remediation,st.remediation);local.message+='Restored your saved progress for this report. ';}}catch(e){local.message='';storageMessage='Saved progress could not be loaded. You can still use this checklist and restore a backup.';}},
    save:function(){try{localStorage.setItem(config.key,JSON.stringify(state));storageMessage='';}catch(e){storageMessage='This browser cannot save progress here. Changes remain in this session; download a backup before leaving.';}},
    status:function(){return storageMessage||local.message+browserOnly(Object.keys(state.classifications).length,0);}
  };
  // The shared workspace (service/src/shared/api.ts SiteWorkspace): one entry per
  // task (task:<action key>) and classification (class:<class key>), latest
  // change wins per key. Each save sends only the keys that differ from what the
  // workspace last said; unsent changes are also kept in localStorage so a
  // reload or an unreachable service doesn't lose them.
  var shared=service&&(function(){
    var entryKeys=Array.from(actionKeys).map(function(k){return 'task:'+k;}).concat(Array.from(classKeys).map(function(k){return 'class:'+k;}));
    var pendingKey='complykit:workspace-pending:v1:'+service.domain;
    var nameKey='complykit:workspace-name:v1';
    var baseline={},stamps={},classAt={},pending={},loaded=false,inflight=false,again=false,timer=null,error='';
    try{var saved=JSON.parse(localStorage.getItem(pendingKey)||'{}');Object.keys(saved).forEach(function(k){var e=saved[k];if(e&&typeof e.at==='string'&&'value' in e)pending[k]={value:e.value,at:e.at};});}catch(e){}
    function allKeys(){return entryKeys.concat(remKeys().filter(function(k){return entryKeys.indexOf(k)<0;}));}
    function current(ek){if(ek.indexOf(REM)===0){var r=state.remediation[ek.slice(REM.length)];return r===undefined?null:r;}var key=ek.slice(ek.indexOf(':')+1);var v=ek.indexOf('task:')===0?state.actions[key]:state.classifications[key];return v===undefined?null:v;}
    function persist(){try{if(Object.keys(pending).length)localStorage.setItem(pendingKey,JSON.stringify(pending));else localStorage.removeItem(pendingKey);}catch(e){}}
    function name(){try{var n=JSON.parse(localStorage.getItem(nameKey)||'null');return n&&typeof n.name==='string'?n:null;}catch(e){return null;}}
    function request(method,body,keepalive){return fetch(service.workspace,{method:method,credentials:'same-origin',cache:'no-store',keepalive:!!keepalive,headers:body?{'content-type':'application/json'}:{},body:body?JSON.stringify(body):undefined}).then(function(r){return r.json().catch(function(){return {};}).then(function(b){if(!r.ok)throw Error(b&&b.error||'HTTP '+r.status);return b;});});}
    // Take the workspace's values for every key of this report that has no unsent change here.
    function apply(ws){
      if(!ws||!ws.entries||typeof ws.entries!=='object')return;
      var raw={version:1,reportKey:config.key,actions:{},classifications:{}};
      entryKeys.forEach(function(ek){var e=ws.entries[ek];if(!e||e.value===null||e.value===undefined)return;var key=ek.slice(ek.indexOf(':')+1);if(ek.indexOf('task:')===0)raw.actions[key]=e.value;else raw.classifications[key]=e.value;});
      var clean=validRecord(raw);
      // The stamp of each of this report's classifications in the workspace (R2: the report records the ones it was rendered with).
      entryKeys.forEach(function(ek){if(ek.indexOf('class:')!==0)return;var e=ws.entries[ek];if(e&&e.value!==null&&e.value!==undefined)classAt[ek.slice(6)]=typeof e.at==='string'?e.at:'';else delete classAt[ek.slice(6)];});
      entryKeys.forEach(function(ek){if(ek in pending)return;var key=ek.slice(ek.indexOf(':')+1),task=ek.indexOf('task:')===0,store=task?state.actions:state.classifications,value=(task?clean.actions:clean.classifications)[key];
        if(value===undefined){if(key in store){delete store[key];if(!task)entries.forEach(function(el){if(el.dataset.classKey===key)el.querySelector('form').reset();});}}else store[key]=value;
        baseline[ek]=JSON.stringify(value===undefined?null:value);if(ws.entries[ek]&&ws.entries[ek].at)stamps[ek]=ws.entries[ek].at;});
      // Checklist tasks: every task:change:* entry (the section can be re-rendered with other tasks).
      Object.keys(ws.entries).filter(function(ek){return ek.indexOf(REM)===0;}).concat(remKeys()).forEach(function(ek){if(ek in pending)return;var e=ws.entries[ek],id=ek.slice(REM.length),value=e&&e.value!==null&&e.value!==undefined?cleanRemediation(e.value):undefined;
        if(value===undefined)delete state.remediation[id];else state.remediation[id]=value;baseline[ek]=JSON.stringify(value===undefined?null:value);if(e&&e.at)stamps[ek]=e.at;});
      if(ws.config!==undefined)window.dispatchEvent(new CustomEvent('complykit-workspace-config',{detail:ws.config||null}));
    }
    function collect(){var at=new Date().toISOString();allKeys().forEach(function(ek){var v=current(ek),json=JSON.stringify(v);var known=ek in pending?JSON.stringify(pending[ek].value):(baseline[ek]||'null');if(json!==known)pending[ek]={value:v,at:at};});persist();}
    function flush(keepalive){
      clearTimeout(timer);
      var keys=Object.keys(pending);if(!keys.length)return;
      if(inflight&&!keepalive){again=true;return;}
      var sent={},body={entries:{}},n=name();if(n&&n.name)body.by=n.name;
      keys.forEach(function(k){sent[k]=pending[k];body.entries[k]=pending[k];});
      if(keepalive){request('PATCH',body,true).catch(function(){});return;}
      inflight=true;
      request('PATCH',body).then(function(res){
        keys.forEach(function(k){if(pending[k]===sent[k])delete pending[k];});persist();
        error='';loaded=true;apply(res.workspace);
      },function(err){error=err.message||'unreachable';}).then(function(){inflight=false;update();if(again){again=false;flush();}});
    }
    function refresh(){
      if(inflight)return;
      if(Object.keys(pending).length&&loaded){flush();return;}
      request('GET').then(function(ws){if(inflight)return;error='';loaded=true;apply(ws);update();if(Object.keys(pending).length)flush();},function(err){error=err.message||'unreachable';update();});
    }
    function identity(){
      var box=document.getElementById('work-identity'),n=name(),form=document.getElementById('work-name-form'),status=document.getElementById('work-name-status');
      box.hidden=false;
      if(!n||form.dataset.editing==='true'){form.hidden=false;status.textContent=n?'':'Add your name so teammates can see who changed what. It is saved in this browser and asked once; it is a label, not a sign-in.';if(n&&document.activeElement!==document.getElementById('work-name'))document.getElementById('work-name').value=n.name;return;}
      form.hidden=true;status.textContent='';
      status.append(n.name?'Your changes are stamped “'+n.name+'”. ':'Your changes are not stamped with a name. ');
      var b=document.createElement('button');b.type='button';b.textContent=n.name?'Change name':'Add a name';b.addEventListener('click',function(){form.dataset.editing='true';identity();document.getElementById('work-name').focus();});status.append(b);
    }
    function setName(value){try{localStorage.setItem(nameKey,JSON.stringify({name:String(value).trim().slice(0,80)}));}catch(e){}document.getElementById('work-name-form').dataset.editing='false';identity();}
    document.getElementById('work-name-save').addEventListener('click',function(){setName(document.getElementById('work-name').value);});
    document.getElementById('work-name').addEventListener('keydown',function(e){if(e.key==='Enter'){e.preventDefault();setName(e.target.value);}});
    document.getElementById('work-name-skip').addEventListener('click',function(){setName('');});
    return {
      load:function(){
        identity();
        document.getElementById('work-storage-note').textContent='Shared with everyone who opens a report for '+service.domain+' on this service; the latest change to each answer wins. Download a backup to keep a copy. Marking a task done means your team completed it; rerun the scan to verify the website’s behavior.';
        refresh();
        window.addEventListener('focus',refresh);
        document.addEventListener('visibilitychange',function(){if(document.visibilityState==='visible')refresh();else flush(true);});
        window.addEventListener('pagehide',function(){flush(true);});
        setInterval(function(){if(document.visibilityState!=='hidden')refresh();},30000);
      },
      save:function(){collect();clearTimeout(timer);timer=setTimeout(flush,400);},
      // A value the service already stored (a Verify result): take it as the baseline, don't send it back.
      accept:function(ek,value){if(!(ek in pending))baseline[ek]=JSON.stringify(value===undefined?null:value);},
      refresh:function(){refresh();},
      // class key → the workspace's at-stamp for it (unsent changes read as 'pending'); null until the workspace has loaded.
      classificationStamps:function(){if(!loaded)return null;var out=Object.assign({},classAt);Object.keys(pending).forEach(function(ek){if(ek.indexOf('class:')===0)out[ek.slice(6)]='pending';});return out;},
      pendingCount:function(){return Object.keys(pending).length+(inflight?1:0);},
      // The workspace entries of this report as the page shows them now, for an export.
      snapshotEntries:function(){var out={};allKeys().forEach(function(ek){var v=current(ek);if(v!==null)out[ek]={value:v,at:(ek in pending?pending[ek].at:stamps[ek])||new Date().toISOString()};});return out;},
      status:function(){
        var keys=Object.keys(pending).filter(function(k){return entryKeys.indexOf(k)>=0||k.indexOf(REM)===0;});
        if(error){var classes=keys.filter(function(k){return k.indexOf('class:')===0;}).length;return 'The shared workspace for '+service.domain+' could not be reached ('+error+'). '+browserOnly(classes,keys.length-classes);}
        if(!loaded)return 'Loading the shared workspace for '+service.domain+'…';
        if(keys.length||inflight)return 'Saving to the shared workspace for '+service.domain+'…';
        return 'Saved to the shared workspace for '+service.domain;
      }
    };
  })();
  var adapter=shared||local;
  if(!shared)local.load();
  function save(){adapter.save();}
  function task(key){var a=state.actions[key]||{status:'open',note:'',answers:{}};var el=document.querySelector('[data-action-key="'+key+'"]');if(a.status==='done'&&el&&el.dataset.comparisonKey&&a.comparisonKey!==el.dataset.comparisonKey&&!(el.dataset.comparisonKey==='library'&&!a.comparisonKey))return Object.assign({},a,{status:'open'});return a;}
  function shouldShow(key){var filter=document.getElementById('work-filter').value;var status=task(key).status;return filter==='all'||(filter==='remaining'&&status!=='done')||filter===status;}
  window.ComplyKitWorkspace={shouldShow:shouldShow,task:task,classification:function(key){return state.classifications[key];},classificationStamps:function(){return shared?shared.classificationStamps():null;},pendingCount:function(){return shared?shared.pendingCount():0;},
    // The guided checklist (consent-remediation.ts): status per task id; remote = already stored by the service.
    remediation:function(id){return state.remediation[id];},
    setRemediation:function(id,value,remote){var v=cleanRemediation(value);if(!v)return;state.remediation[id]=v;if(remote&&shared)shared.accept(REM+id,v);save();update();},
    refresh:function(){if(shared)shared.refresh();},
    shared:!!shared};
  function update(){
    if(window.ComplyKitMatrix)window.ComplyKitMatrix.recalculate();
    var questions=0,fixing=0,review=0,done=0,unanswered=new Set(),answered=new Set();
    actions.forEach(function(el){var a=task(el.dataset.actionKey);el.dataset.workState=a.status;
      el.querySelector('[data-work-status]').value=a.status;
      var missing=[];el.querySelectorAll('[data-review-answer]').forEach(function(field){var value=(a.answers||{})[field.dataset.reviewAnswer]||'';if(document.activeElement!==field)field.value=value;if(!value.trim()){missing.push(field.dataset.questionLabel);if(el.dataset.actionActive!=='false')questions++;}});
      el.querySelector('[data-review-summary]').textContent=missing.length?missing.length+' unanswered: '+missing.join(' · '):'All action questions answered by you. Check the evidence before closing the task.';
      var note=el.querySelector('[data-work-note]');if(document.activeElement!==note)note.value=a.note;
      var feedback=el.querySelector('[data-work-feedback]');feedback.textContent=a.status==='done'?'Marked done by you — the original scan finding still needs a recheck.':a.status==='in-progress'?'In progress — still counted as unfinished.':'To do';feedback.dataset.tone=a.status==='done'?'green':a.status==='in-progress'?'amber':el.dataset.scanTone;
      if(el.dataset.actionActive!=='false'){if(a.status==='done')done++;else if(el.dataset.scanTone==='red')fixing++;else review++;}
      if(!el.hasAttribute('data-matrix-managed'))el.hidden=!shouldShow(el.dataset.actionKey);
    });
    entries.forEach(function(el){var key=el.dataset.classKey;var c=state.classifications[key];var needed=el.dataset.classRequired==='true';var form=el.querySelector('[data-class-form]');
      var fields=['category','purpose','owner','information','source'];var missing=fields.filter(function(id){return !c||!c[id]||!c[id].trim();});if(c&&c.categoryChosen===false&&c.category&&!missing.includes('category'))missing.unshift('category');var complete=!!c&&!missing.length;
      if(complete)answered.add(key);else if(needed||c)unanswered.add(key);
      if(c)fields.forEach(function(id){if(document.activeElement!==form.elements[id])form.elements[id].value=c[id]||'';});
      var description=form.querySelector('[data-purpose-description]');if(description)description.textContent=config.purposeDescriptions[form.elements.category.value]||'Choose a main purpose. Add other purposes below if needed.';
      form.querySelectorAll('[name=additionalCategories]').forEach(function(field){if(c&&document.activeElement!==field)field.checked=(c.additionalCategories||[]).includes(field.value);});
      el.dataset.classResolved=complete?'true':'false';
      var badge=el.querySelector('[data-class-badge]');if(badge){badge.textContent=complete?'Reviewed by you: '+config.purposeLabels[c.category]:c?'Research in progress — '+missing.length+' answers needed':needed?'Research needed':'Known category — optional site review';badge.dataset.tone=complete?'green':needed||c?'amber':'neutral';}
      var names={category:'purpose category',purpose:'actual purpose',owner:'owner',information:'information used',source:'research evidence / reviewer'};
      var answer=el.querySelector('[data-class-answer]');answer.textContent=complete?'All research questions answered by you. The grid compares the saved observations with the purpose you chose.':!needed&&!c?'The library supplies a suggested category. Site-specific research is optional.':'Still to answer: '+missing.map(function(id){return names[id];}).join(', ');answer.dataset.tone=complete?'green':!needed&&!c?'neutral':'amber';
      if(el.hasAttribute('data-tool-state')){var vals=el.dataset.originalToolState.split(' ').filter(function(v){return v!=='classify';});if((needed||c)&&!complete)vals.push('classify');el.dataset.toolState=vals.join(' ');}
      if(el.hasAttribute('data-cookie-state')){var vals=el.dataset.originalCookieState.split(' ').filter(function(v){return v!=='classify';});if((needed||c)&&!complete)vals.push('classify');el.dataset.cookieState=vals.join(' ');}
    });
    document.getElementById('work-question-count').textContent=questions;
    document.getElementById('work-fix-count').textContent=fixing;
    document.getElementById('work-review-count').textContent=review;
    document.getElementById('work-class-count').textContent=unanswered.size;
    document.getElementById('work-done-count').textContent=done;
    document.getElementById('work-class-done-count').textContent=answered.size;
    document.getElementById('work-storage-status').textContent=adapter.status();
    window.dispatchEvent(new CustomEvent('complykit-workflow-changed'));
  }
  document.querySelectorAll('[data-work-controls]').forEach(function(el){el.hidden=false;});
  document.addEventListener('change',function(e){if(e.target.matches('[data-work-status]')){var el=e.target.closest('[data-action-key]');var a=task(el.dataset.actionKey);state.actions[el.dataset.actionKey]={status:e.target.value,note:a.note,answers:a.answers||{},comparisonKey:el.dataset.comparisonKey};save();update();}});
  document.addEventListener('input',function(e){if(e.target.matches('[data-work-note]')){var el=e.target.closest('[data-action-key]');var a=task(el.dataset.actionKey);state.actions[el.dataset.actionKey]={status:a.status,note:e.target.value,answers:a.answers||{},comparisonKey:a.comparisonKey};save();document.getElementById('work-storage-status').textContent=adapter.status();}});
  function capture(form,confirmPurpose){var previous=state.classifications[form.dataset.classForm];var c={categoryChosen:!!confirmPurpose||!!previous&&previous.categoryChosen!==false};['category','purpose','owner','information','source'].forEach(function(id){c[id]=form.elements[id].value;});c.additionalCategories=Array.from(form.querySelectorAll('[name=additionalCategories]:checked')).map(function(field){return field.value;}).filter(function(v){return v!==c.category;});state.classifications[form.dataset.classForm]=c;save();update();}
  document.addEventListener('input',function(e){if(e.target.matches('[data-review-answer]')){var el=e.target.closest('[data-action-key]');var a=task(el.dataset.actionKey);var answers=Object.assign({},a.answers||{});answers[e.target.dataset.reviewAnswer]=e.target.value;state.actions[el.dataset.actionKey]={status:a.status,note:a.note,answers:answers,comparisonKey:a.comparisonKey};save();update();}var form=e.target.closest('[data-class-form]');if(form)capture(form,e.target.name==='category'||e.target.name==='additionalCategories');});
  document.addEventListener('change',function(e){var form=e.target.closest('[data-class-form]');if(form)capture(form,e.target.name==='category'||e.target.name==='additionalCategories');});
  document.addEventListener('submit',function(e){if(e.target.matches('[data-class-form]')){e.preventDefault();capture(e.target,true);}});
  document.addEventListener('click',function(e){if(e.target.matches('[data-class-apply]'))capture(e.target.closest('form'),true);if(e.target.matches('[data-class-clear]')){var form=e.target.closest('form');if(snapshot&&snapshot.entries['class:'+form.dataset.classForm])state.classifications[form.dataset.classForm]={category:'',categoryChosen:false,additionalCategories:[],purpose:'',owner:'',information:'',source:''};else delete state.classifications[form.dataset.classForm];entries.filter(function(el){return el.dataset.classKey===form.dataset.classForm;}).forEach(function(el){el.querySelector('form').reset();});save();update();}});
  document.getElementById('work-filter').addEventListener('change',update);
  document.getElementById('work-export').addEventListener('click',function(){var url=URL.createObjectURL(new Blob([JSON.stringify(state,null,2)],{type:'application/json'}));var a=document.createElement('a');a.href=url;a.download='complykit-report-progress.json';a.click();setTimeout(function(){URL.revokeObjectURL(url);},1000);});
  // "Export for sharing": the page as served (minus the service block) plus a dated snapshot and a banner linking back to the live page.
  function exportSnapshot(){
    var btn=document.getElementById('work-snapshot'),msg=document.getElementById('work-snapshot-status');
    function esc(t){return String(t).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');}
    var live=location.origin+location.pathname;
    btn.disabled=true;msg.textContent='Preparing the export…';
    fetch(location.pathname,{credentials:'same-origin',cache:'no-store'}).then(function(r){if(!r.ok)throw Error('HTTP '+r.status);return r.text();}).then(function(html){
      var at=new Date().toISOString();
      var data=JSON.stringify({version:1,at:at,domain:service.domain,liveUrl:live,entries:shared.snapshotEntries()}).replace(/</g,'\\u003c');
      html=html.replace(/<script type="application\/json" id="ck-service">[^<]*<\/script>/,'');
      var marker='<script type="application/json" id="workspace-config">';
      var i=html.indexOf(marker);if(i<0)throw Error('This page has no workspace to export.');
      html=html.slice(0,i)+'<script type="application/json" id="ck-snapshot">'+data+'<\/script>'+html.slice(i);
      var banner='<div id="ck-snapshot-banner" class="ck-snapshot-banner" role="note">Snapshot from '+esc(at.slice(0,10))+' — live version: <a href="'+esc(live)+'">'+esc(live)+'</a></div>';
      var body=html.match(/<body[^>]*>/i);html=body?html.replace(body[0],body[0]+banner):banner+html;
      var url=URL.createObjectURL(new Blob([html],{type:'text/html'}));var a=document.createElement('a');a.href=url;a.download='complykit-report-'+at.slice(0,10)+'.html';a.click();setTimeout(function(){URL.revokeObjectURL(url);},1000);
      msg.textContent='Exported a snapshot from '+at.slice(0,10)+'.';
    }).catch(function(err){msg.textContent='Could not export: '+(err.message||'unknown error');}).then(function(){btn.disabled=false;});
  }
  if(shared){var sb=document.getElementById('work-snapshot');sb.hidden=false;sb.addEventListener('click',exportSnapshot);}
  document.getElementById('work-import').addEventListener('change',async function(e){var file=e.target.files[0];if(!file)return;try{if(file.size>2000000)throw Error('The backup is too large.');var incoming=validRecord(JSON.parse(await file.text()));state=incoming;entries.forEach(function(el){el.querySelector('form').reset();});save();update();}catch(err){document.getElementById('work-storage-status').textContent=err.message||'Could not restore this backup.';}e.target.value='';});
  document.getElementById('work-reset').addEventListener('click',function(){if(!window.confirm('Reset only this report’s answers, notes and task progress?'))return;state=emptyState();entries.forEach(function(el){el.querySelector('form').reset();});save();update();});
  window.addEventListener('storage',function(e){if(shared||e.key!==config.key)return;try{state=emptyState();if(e.newValue){var st=validRecord(JSON.parse(e.newValue));Object.assign(state.actions,st.actions);Object.assign(state.classifications,st.classifications);Object.assign(state.remediation,st.remediation);}entries.forEach(function(el){el.querySelector('form').reset();});update();}catch(err){document.getElementById('work-storage-status').textContent='Another tab saved unreadable progress. Your current checklist has been kept.';}});
  update();
  if(shared)shared.load();
})();`;
