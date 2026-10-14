import { compareCookieBehavior, cookiePurposes } from '../src/report/cookie-purpose.js';
import { requiresConsent } from '../src/registry/cookies.js';
import { describe, it, expect } from 'vitest';
import { buildBehaviorMatrix } from '../src/report/consent-matrix.js';
import { buildConsentReportModel } from '../src/report/consent-model.js';
import { TrackingEvaluation, Timeline } from '../src/record/index.js';
import { summarizeBehavior } from '../src/rules/tracking/summary.js';
import { isCookieDeletion, analyzeTimeline } from '../src/rules/tracking/analyze.js';
import { purposeNeedsReview } from '../src/report/consent-view.js';

const inventory={partyId:'meta.pixel',label:'Meta Pixel',domain:'facebook.com',hosts:['facebook.com'],recognized:true,kbStatus:'proposed',categories:['advertising'],behavesLikeTracker:true,trackerSignals:[],sends:[],stores:[{name:'_fbp',kind:'cookie',lifetimeDays:90},{name:'unknown_cookie',kind:'cookie',lifetimeDays:1}],sources:['injected'],loadedBy:[],seenIn:[]};
const evaluation=TrackingEvaluation.parse({runId:'r',property:'shop',site:{url:'https://shop.example/',host:'shop.example',registrableDomain:'shop.example'},startedAt:'now',finishedAt:'later',versions:{kb:'0',registry:'0',package:'0'},locations:[{spec:{id:'de',label:'Germany',country:'DE',proxied:false},verification:{verdict:'verified',expected:{country:'DE'},observed:{country:'DE'},sources:[],jurisdictions:['eu'],checkedAt:'now'},scenarios:[{scenario:'do-nothing',status:'tested'},{scenario:'reject',status:'tested',choice:{kind:'reject',ok:true,method:'test'}}]}],inventory:[inventory],notTested:[],researchQueue:[],redacted:true,behaviorObservations:[{location:'de',scenario:'do-nothing',durationMs:10000,knownPartyIds:['meta.pixel'],parties:[{partyId:'meta.pixel',dataRequests:1,requestPhases:['before-choice'],dataRequestPhases:{'before-choice':1},limitedRequestsByPhase:{},stores:[{name:'_fbp',kind:'cookie',writePhase:'before-choice',writePhases:['before-choice'],presentAtEnd:true,attribution:'observed'}]}]},{location:'de',scenario:'reject',durationMs:10000,knownPartyIds:['meta.pixel'],parties:[{partyId:'meta.pixel',dataRequests:1,requestPhases:['before-choice'],dataRequestPhases:{'before-choice':1},limitedRequestsByPhase:{},stores:[{name:'_fbp',kind:'cookie',writePhase:'before-choice',writePhases:['before-choice'],presentAtEnd:false,attribution:'observed'}]}]}]});
const model=buildConsentReportModel(evaluation,[]);
const status=(m= model,kind='storage',name='_fbp',scenario='do-nothing')=>buildBehaviorMatrix(m).rows.find(r=>r.kind===kind&&r.label===name)!.cells.find(c=>c.columnId==='de:'+scenario)!;

describe('consent behavior matrix',()=>{
 it('keeps known seed categories separate from actual research needs',()=>{
  expect(purposeNeedsReview(model.inventory[0],model)).toBe(false);
  expect(purposeNeedsReview({...model.inventory[0],recognized:false},model)).toBe(true);
  expect(purposeNeedsReview(model.inventory[0],{...model,researchQueue:[{partyId:'meta.pixel',domain:'facebook.com',kind:'drift',reason:'Unexpected storage'}]})).toBe(true);
 });
 it('compares actual cookie observations without spreading tool violations to every cookie',()=>{
  expect(status().status).toBe('mismatch');
  expect(status(model,'storage','unknown_cookie').status).toBe('match'); // inherits Meta Pixel's advertising category; not active before a choice
  expect(status(model,'storage','_fbp','reject').status).toBe('match');
  expect(status(model,'tool','Meta Pixel','reject').status).toBe('match'); // earlier requests do not count as post-reject activity
 });
 it('does not infer passes from missing evidence, failed choices, or unverified locations',()=>{
  expect(status({...model,behaviorObservations:undefined}).status).toBe('unknown');
  expect(buildBehaviorMatrix(model).columns.some(c=>c.scenario==='accept')).toBe(false); // an action that never ran gets no column, never a pass
  expect(status({...model,grid:{de:{reject:{status:'tested',choice:'reject (failed)',counts:{violation:0,'needs-review':0,exposure:0,practice:0}}}}},'storage','_fbp','reject').status).toBe('not-tested');
  expect(status({...model,locations:[{...model.locations[0],verdict:'mismatch'}]}).status).toBe('unknown');
  expect(status({...model,notTested:[{scope:'frame',id:'frame',reason:'blocked'}]},'storage','_fbp','reject').status).toBe('unknown');
  expect(status({...model,notTested:[{scope:'flow',id:'do-nothing',reason:'unreadable frame in this visit'}]},'storage','_fbp','reject').status).toBe('match');
  // A coverage note that cannot hide requests or cookies does not turn an expected absence into "not checked".
  expect(status({...model,notTested:[{scope:'flow',id:'reject',reason:'navigator.globalPrivacyControl inside workers (init scripts do not run in workers; the Sec-GPC header is still sent)'}]},'storage','_fbp','reject').status).toBe('match');
  expect(status({...model,notTested:[{scope:'flow',id:'reject',reason:'unreadable frame in this visit'}]},'storage','_fbp','reject').status).toBe('unknown');
  expect(status({...model,notTested:[{scope:'flow',id:'reject',location:'de',reason:'no visible email field to type the marker into'}]},'storage','_fbp','reject').status).toBe('match'); // a marker not typed hides nothing
  // A visitor action that could not run anywhere (a banner with no close control, no per-category toggle)
  // is a gap for its own column only — it says nothing about what the other visits captured.
  expect(status({...model,notTested:[{scope:'scenario',id:'dismiss',location:'de',reason:'the banner offers no way to close it without choosing'}]},'storage','_fbp','reject').status).toBe('match');
  expect(status({...model,notTested:[{scope:'flow',id:'partial',location:'de',reason:'could not grant a single category (no recognizable analytics-only control)'}]},'tool','Meta Pixel','reject').status).toBe('match');
 });
 it('wiretap states: consent-denied pings before a choice or after a refusal are a problem, as in the EU/UK (complykit decides, 2026-10-09); after an opt-out they are the expected restricted mode',()=>{
  const f=(scenario:string,wiretap=true)=>compareCookieBehavior({scenario,regime:'opt-out-signal',regimeLabel:'California',wiretap,hasActivity:true,limitedOnly:true,captureGap:false},{categories:['advertising']});
  expect(f('do-nothing').status).toBe('mismatch');
  expect(f('do-nothing').reason).toMatch(/wiretap/i);
  expect(f('do-nothing').reason).toMatch(/Consent Mode "basic"/);
  expect(f('reject').status).toBe('mismatch');
  expect(f('gpc').status).toBe('match');
  expect(f('opt-out-link').status).toBe('match');
  expect(f('do-nothing',false).status).toBe('match'); // no wiretap posture: may run before a choice
 });
 it('a failed opt-out link is one column-level gap that says why, not a "needs a look" per cookie',()=>{
  const loc=evaluation.locations[0];
  const optOut=(extra:object)=>buildConsentReportModel(TrackingEvaluation.parse({...evaluation,locations:[{...loc,scenarios:[...loc.scenarios,{scenario:'opt-out-link',status:'tested',choice:{kind:'opt-out-link',ok:false,method:'link — requires email — not submitted'},...extra}]}]}),[]);
  const withWalk=optOut({optOutWalk:{found:true,linkText:'Your Privacy Choices',requiredFields:['email'],performed:false}});
  expect(withWalk.grid.de!['opt-out-link']!.choiceGap).toBe('The opt-out was not completed: “Your Privacy Choices” leads to a page that asks for email, and the scan does not submit personal data.');
  const matrix=buildBehaviorMatrix(withWalk);
  const col=matrix.columns.find(c=>c.id==='de:opt-out-link')!;
  expect(col.unavailable?.reason).toContain('asks for email');
  expect(matrix.columns.find(c=>c.id==='de:reject')!.unavailable).toBeUndefined();
  const cells=matrix.rows.map(r=>r.cells[matrix.columns.indexOf(col)]);
  expect(cells.every(c=>c.status==='not-tested'&&c.reason.includes('asks for email')&&c.reason.includes('whole “After the opt-out link” column'))).toBe(true);
  // Older records carry only the note on the choice method.
  expect(optOut({}).grid.de!['opt-out-link']!.choiceGap).toContain('asks for email');
  expect(optOut({optOutWalk:{found:false,requiredFields:[]}}).grid.de!['opt-out-link']!.choiceGap).toBe('No opt-out link was found, so the opt-out could not be made.');
  expect(optOut({choice:{kind:'opt-out-link',ok:false,method:'link'},optOutWalk:{found:true,linkText:'Do Not Sell',requiredFields:[],performed:false}}).grid.de!['opt-out-link']!.choiceGap).toContain('no opt-out button or switch');
 });
 it('preserves repeated storage writes in both pre-choice and post-reject phases',()=>{
  const timeline=Timeline.parse({location:evaluation.locations[0].spec,verification:evaluation.locations[0].verification,snapshot:{site:evaluation.site,scenario:'reject',locationId:'de',startedAt:'2026-10-05T00:00:00Z',durationMs:10000,gpc:false,browser:{name:'chromium'},pages:[],cookies:[],storage:[],frames:[]},events:[{type:'banner',t:0,state:'shown',pageIndex:0},{type:'cookie-write',t:100,name:'_fbp',value:'redacted',chain:['https://connect.facebook.net/pixel.js'],frameUrl:evaluation.site.url,pageIndex:0},{type:'choice',t:200,choice:'reject',ok:true,method:'test',pageIndex:0},{type:'cookie-write',t:300,name:'_fbp',value:'redacted',chain:['https://connect.facebook.net/pixel.js'],frameUrl:evaluation.site.url,pageIndex:0}]});
  const observations=summarizeBehavior([timeline]);
  expect(observations[0].parties[0].stores[0].writePhases).toEqual(['before-choice','after-reject']);
  expect(status({...model,behaviorObservations:observations},'storage','_fbp','reject').status).toBe('mismatch');
 });
 it('a write within 1 s of a withdrawal, on its page, is the choice taking effect (grace) — not a write after withdrawal; later writes count',()=>{
  const w=(t:number)=>({type:'cookie-write',t,name:'_fbp',value:'redacted',chain:['https://connect.facebook.net/pixel.js'],frameUrl:evaluation.site.url,pageIndex:0});
  const timeline=Timeline.parse({location:evaluation.locations[0].spec,verification:evaluation.locations[0].verification,snapshot:{site:evaluation.site,scenario:'withdraw',locationId:'de',startedAt:'2026-10-05T00:00:00Z',durationMs:10000,gpc:false,browser:{name:'chromium'},pages:[],cookies:[],storage:[],frames:[]},events:[{type:'banner',t:0,state:'shown',pageIndex:0},{type:'choice',t:100,choice:'accept',ok:true,method:'test',pageIndex:0},w(150),{type:'choice',t:1000,choice:'withdraw',ok:true,method:'test',pageIndex:0},w(1022)]});
  expect(summarizeBehavior([timeline])[0].parties[0].stores[0].writePhases).toEqual(['after-accept','withdraw-grace']);
  const later=Timeline.parse({...timeline,events:[...timeline.events,w(2500)]});
  expect(summarizeBehavior([later])[0].parties[0].stores[0].writePhases).toEqual(['after-accept','withdraw-grace','after-withdraw']);
 });
 it('a cookie left in the jar on another company’s domain is not the site’s activity; writing one during the visit still is',()=>{
  const inv={...inventory,stores:[...inventory.stores,{name:'fr',kind:'cookie',lifetimeDays:90}]};
  const cookie=(name:string,domain:string)=>({name,value:'x',domain,path:'/',expires:-1,httpOnly:false,secure:true});
  const tl=(cookies:object[],events:object[]=[])=>Timeline.parse({location:evaluation.locations[0].spec,verification:evaluation.locations[0].verification,snapshot:{site:evaluation.site,scenario:'reject',locationId:'de',startedAt:'2026-10-05T00:00:00Z',durationMs:10000,gpc:false,browser:{name:'chromium'},pages:[],cookies,storage:[],frames:[]},events:[{type:'banner',t:0,state:'shown',pageIndex:0},{type:'request',t:50,id:'r1',url:'https://www.facebook.com/tr/?ev=PageView',method:'GET',resourceType:'image',origin:'page',pageUrl:evaluation.site.url,pageIndex:0,initiator:{type:'other',chain:[]}},{type:'choice',t:200,choice:'reject',ok:true,method:'test',pageIndex:0},...events]});
  const m=(t:ReturnType<typeof tl>)=>{const obs=summarizeBehavior([t]);return {...buildConsentReportModel({...evaluation,inventory:[inv]} as unknown as typeof evaluation,[]),behaviorObservations:obs};};
  const third=summarizeBehavior([tl([cookie('fr','.facebook.com')])])[0].parties.find(p=>p.partyId==='meta.pixel')!.stores.find(s=>s.name==='fr')!;
  expect(third).toMatchObject({presentAtEnd:true,thirdParty:true});
  expect(status(m(tl([cookie('fr','.facebook.com')])),'storage','fr','reject').status).toBe('match');
  // The site's own cookie left behind is still the site's.
  expect(status(m(tl([cookie('_fbp','.shop.example')])),'storage','_fbp','reject').status).toBe('mismatch');
 });
 it('each cookie sits under one tool: the one its name belongs to, not the tag loader that wrote it (storyfolder.com, 2026-10-08)',()=>{
  const gtag='https://www.googletagmanager.com/gtag/js?id=G-TEST';
  const t=Timeline.parse({location:evaluation.locations[0].spec,verification:evaluation.locations[0].verification,snapshot:{site:evaluation.site,scenario:'accept',locationId:'de',startedAt:'2026-10-05T00:00:00Z',durationMs:10000,gpc:false,browser:{name:'chromium'},pages:[],cookies:[{name:'GCL_AW_P',value:'x',domain:'.googleadservices.com',path:'/',expires:-1,httpOnly:false,secure:true}],storage:[],frames:[]},events:[
   {type:'request',t:10,id:'g',url:gtag,method:'GET',resourceType:'script',origin:'page',pageUrl:evaluation.site.url,pageIndex:0,initiator:{type:'parser',chain:[]}},
   {type:'request',t:20,id:'a',url:'https://www.googleadservices.com/pagead/conversion/1/?x=1',method:'GET',resourceType:'image',origin:'page',pageUrl:evaluation.site.url,pageIndex:0,initiator:{type:'script',chain:[gtag]}},
   {type:'cookie-write',t:30,name:'_ga',value:'redacted',chain:[gtag],frameUrl:evaluation.site.url,pageIndex:0},
   {type:'cookie-write',t:31,name:'_gcl_au',value:'redacted',chain:[gtag],frameUrl:evaluation.site.url,pageIndex:0},
   {type:'storage-write',t:32,area:'local',key:'_gcl_ls',value:'redacted',chain:[gtag],frameUrl:evaluation.site.url,pageIndex:0},
  ]});
  const owners=new Map<string,string[]>();
  for(const [id,f] of analyzeTimeline(t).parties)for(const st of f.stores)owners.set(st.name,[...(owners.get(st.name)??[]),id]);
  expect(owners.get('_ga')).toEqual(['google.analytics']);
  expect(owners.get('_gcl_au')).toEqual(['google.ads.doubleclick']);
  expect(owners.get('_gcl_ls')).toEqual(['google.ads.doubleclick']);
  expect(owners.get('GCL_AW_P')).toHaveLength(1);
 });
 it('a cookie deletion after the choice (consent-tool cleanup, a vendor dropping its id) is not a write (E4)',()=>{
  const ev=(t:number,attributes?:string)=>({type:'cookie-write',t,name:'_fbp',value:attributes?'':'redacted',...(attributes?{attributes}:{}),chain:['https://connect.facebook.net/pixel.js'],frameUrl:evaluation.site.url,pageIndex:0});
  const timeline=Timeline.parse({location:evaluation.locations[0].spec,verification:evaluation.locations[0].verification,snapshot:{site:evaluation.site,scenario:'reject',locationId:'de',startedAt:'2026-10-05T00:00:00Z',durationMs:10000,gpc:false,browser:{name:'chromium'},pages:[],cookies:[],storage:[],frames:[]},events:[{type:'banner',t:0,state:'shown',pageIndex:0},ev(100),{type:'choice',t:200,choice:'reject',ok:true,method:'test',pageIndex:0},ev(300,'Max-Age=0; Path=/; Secure'),ev(310,'expires=Mon, 05 Oct 2026 00:00:00 GMT; path=/'),ev(320,'expires=Thu, 01 Jan 1970 00:00:00 GMT')]});
  const observations=summarizeBehavior([timeline]);
  expect(observations[0].parties[0].stores[0].writePhases).toEqual(['before-choice']);
  expect(status({...model,behaviorObservations:observations},'storage','_fbp','reject').status).toBe('match');
 });
 it('isCookieDeletion: max-age wins, else the expiry against the write time',()=>{
  const now=Date.parse('2026-10-05T12:00:00Z')/1000;
  expect(isCookieDeletion('Max-Age=0; Path=/',now)).toBe(true);
  expect(isCookieDeletion('path=/; max-age=-1',now)).toBe(true);
  expect(isCookieDeletion('max-age=3600; expires=Thu, 01 Jan 1970 00:00:00 GMT',now)).toBe(false);
  expect(isCookieDeletion('expires=Mon, 05 Oct 2026 12:00:00 GMT;path=/',now)).toBe(true);
  expect(isCookieDeletion('expires=Tue, 05 Jan 2027 14:02:23 GMT;path=/',now)).toBe(false);
  expect(isCookieDeletion(undefined,now)).toBe(false);
 });
});


describe('purpose choices and saved behavior comparisons', () => {
 const active={scenario:'do-nothing',hasActivity:true,limitedOnly:false,captureGap:false};
 it('keeps technical tags while presenting the six human purpose choices',()=>{
  expect(cookiePurposes(['session-recording','analytics','error-monitoring','chat'])).toEqual(['analytics','performance','functional']);
  expect(cookiePurposes(['necessary','advertising'])).toEqual(['necessary','advertising']);
  expect(requiresConsent('performance')).toBe(true);
 });
 it('classifies observed optional use as a mismatch and observed absence as a match',()=>{
  for(const category of ['analytics','performance','advertising','functional']){
   expect(compareCookieBehavior(active,{categories:[category],userChosen:true}).status).toBe('mismatch');
   expect(compareCookieBehavior({...active,hasActivity:false},{categories:[category],userChosen:true}).status).toBe('match');
  }
 });
 it('never lets a necessary label supersede a secondary optional purpose',()=>{
  expect(compareCookieBehavior(active,{categories:['necessary'],userChosen:true}).status).toBe('match');
  for(const optional of ['analytics','performance','advertising','functional'])expect(compareCookieBehavior(active,{categories:['necessary',optional],userChosen:true}).status).toBe('mismatch');
  expect(compareCookieBehavior(active,{categories:['necessary','other'],userChosen:true}).status).toBe('mismatch'); // "other" needs consent: complykit decides, never the site
 });
 it('a recorded control never changes the verdict: what a tool does is a fact; what that requires is complykit\'s call (2026-10-09)',()=>{
  for(const categories of [['necessary'],['analytics'],['other'],['advertising']])for(const control of ['consent','none','other'])for(const scenario of ['do-nothing','gpc','accept'])
   expect(compareCookieBehavior({...active,scenario},{categories,control,userChosen:true}).status,`${categories} ${control} ${scenario}`).toBe(compareCookieBehavior({...active,scenario},{categories,userChosen:true}).status);
  expect(compareCookieBehavior(active,{categories:['analytics'],control:'none',userChosen:true}).status).toBe('mismatch');
 });
 it('retains incomplete evidence and restricted traffic even after a classification',()=>{
  for(const category of ['necessary','analytics'])expect(compareCookieBehavior({...active,unavailable:{status:'not-tested',reason:'Choice failed'}},{categories:[category],userChosen:true}).status).toBe('not-tested');
  expect(compareCookieBehavior({...active,hasActivity:false,captureGap:true},{categories:['performance'],userChosen:true}).status).toBe('unknown');
  expect(compareCookieBehavior({...active,limitedOnly:true},{categories:['analytics'],userChosen:true}).status).toBe('mismatch');
 });
});
