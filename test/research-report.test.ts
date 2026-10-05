import { describe, it, expect } from 'vitest';
import Ajv2020 from 'ajv/dist/2020.js';
import { consentResearch, researchAction, researchWorkflow } from '../src/report/research.js';
import { buildConsentReportModel } from '../src/report/consent-model.js';
import { TrackingEvaluation } from '../src/record/index.js';
const evaluation = TrackingEvaluation.parse({runId:'research-run',property:'shop',site:{url:'https://shop.example',host:'shop.example',registrableDomain:'shop.example'},startedAt:'now',finishedAt:'later',versions:{kb:'0',registry:'0',package:'0'},locations:[],inventory:[{partyId:'analytics',label:'Analytics vendor',domain:'analytics.example',hosts:['analytics.example'],recognized:false,kbStatus:'unrecognized',categories:[],behavesLikeTracker:true,trackerSignals:[],sends:['page-address'],stores:[{name:'visitor',kind:'cookie',lifetimeDays:30}],sources:['injected'],loadedBy:[],seenIn:[]}],researchQueue:[{partyId:'missing',domain:'missing.example',reason:'unrecognized'}],notTested:[],redacted:true});
const model = buildConsentReportModel(evaluation, []);
const workflow = model.researchWorkflow!;
const validate = (w = workflow) => {
  const ajv = new Ajv2020.default({strict:false});
  ajv.addFormat('date-time', value => !Number.isNaN(Date.parse(value)));
  return ajv.compile(w.answerSchema);
};
const question = workflow.items[0].questions[0];
const response = () => ({schemaVersion:1,reportId:workflow.reportId,answers:[{itemId:workflow.items[0].id,questionId:question.id,status:'answered',needsHumanReview:false,claims:[{text:'Provider identified from primary documentation',basis:'documented',confidence:'medium',sourceIds:['vendor']}],sources:[{id:'vendor',reference:'https://analytics.example/privacy',kind:'url',accessedAt:'2026-10-05T10:00:00Z'}],checks:[{method:'Inspected vendor privacy documentation',checkedAt:'2026-10-05T10:00:00Z',result:'Provider named; site-specific configuration unavailable',limitations:['No configuration access']}],unknowns:['Actual site purpose still needs confirmation']}]});

describe('agent research workflow', () => {
  it('covers tools, storage, and queue-only domains with resolvable evidence pointers without altering observations', () => {
    expect(workflow.items.map(i=>i.target.kind)).toEqual(['tool','storage','tool']);
    const source = JSON.stringify(evaluation);
    for (const item of workflow.items) for (const pointer of [item.target.pointer,...item.evidencePointers]) {
      const resolved = pointer.split('/').slice(1).reduce((v:any,k)=>v[k.replace(/~1/g,'/').replace(/~0/g,'~')], model);
      expect(resolved).toBeDefined();
    }
    expect(workflow.items[0].questions.map(q=>q.id)).toContain('recipients');
    expect(workflow.items[0].questions.find(q=>q.id==='internalOwner')?.responsibility).toBe('human');
    expect(workflow.items[0].questions.find(q=>q.id==='control')?.responsibility).toBe('agent-with-human-review');
    expect(JSON.stringify(evaluation)).toBe(source);
    expect(consentResearch(model).reportId).toBe(workflow.reportId);
  });
  it('validates cited answers and rejects unsupported question IDs, cross-report answers and unsupported completed claims', () => {
    const check=validate();
    expect(check(response())).toBe(true);
    const wrong=response();wrong.reportId='other';expect(check(wrong)).toBe(false);
    const unknown=response();unknown.answers[0].questionId='invented';expect(check(unknown)).toBe(false);
    const bare=response();bare.answers[0].claims=[];expect(check(bare)).toBe(false);
    const unsourced=response();unsourced.answers[0].claims[0].sourceIds=[];expect(check(unsourced)).toBe(false);
    const unresolved=response();unresolved.answers[0].status='unknown';unresolved.answers[0].claims=[];unresolved.answers[0].sources=[];expect(check(unresolved)).toBe(true);
  });
  it('requires human review for control proposals and disallows agents answering internal ownership', () => {
    const check=validate();const proposal=response();proposal.answers[0].questionId='control';expect(check(proposal)).toBe(false);proposal.answers[0].needsHumanReview=true;expect(check(proposal)).toBe(true);
    proposal.answers[0].questionId='internalOwner';expect(check(proposal)).toBe(false);proposal.answers[0].status='needs-human';expect(check(proposal)).toBe(true);
  });
  it('keeps empty and repeated-item schemas valid and tailors action questions', () => {
    const empty=researchWorkflow('general','shop','run',[]);expect(validate(empty)({schemaVersion:1,reportId:empty.reportId,answers:[]})).toBe(true);expect(validate(empty)({...response(),reportId:empty.reportId})).toBe(false);
    const action=researchAction({kind:'defect',pointer:'/defects/0',label:'Contrast'},'axe-core:color-contrast','wcag22.1.4.3',['/defects/0'],'fingerprint');
    expect(action.questions.find(q=>q.id==='implementation')?.prompt).toContain('contrast');
    expect(action.questions.find(q=>q.id==='assignee')?.responsibility).toBe('human');
    expect(researchWorkflow('general','shop','run',[action,action]).items).toHaveLength(1);
  });
});
