import fs from 'node:fs';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { Browser } from 'playwright';
import { renderHtmlReport } from '../src/report/html.js';
import { renderConsentHtml } from '../src/report/consent-html.js';
import { buildConsentReportModel } from '../src/report/consent-model.js';
import { reconcileCompatibility } from '../src/consent-compatibility.js';
import { generateConsentConfig } from '../src/consent-generator.js';
import { compatibilityEvaluation } from './fixtures/compatibility-report.js';
import { asRunId, asRuleId, asRequirementId, fingerprint, TrackingEvaluation, type Finding, type Run } from '../src/record/index.js';

let available = false;
try {
  const { chromium } = await import('playwright');
  available = fs.existsSync(chromium.executablePath());
} catch { /* Same optional browser convention as the collector tests. */ }
// Without the Playwright Chromium build, an installed browser named by
// COMPLYKIT_BROWSER_CHANNEL (chrome / msedge) runs these too.
const channelFallback = available ? {} : { channel: process.env.COMPLYKIT_BROWSER_CHANNEL };
const suite = available || process.env.COMPLYKIT_BROWSER_CHANNEL ? describe : describe.skip;

const run: Run = { schemaVersion: 1, id: asRunId('report-browser'), property: 'Example site', startedAt: '2026-10-05T10:00:00Z', versions: { package: '0', registry: '0', engines: {} }, accessLevels: ['public'], matrix: [], gaps: [], rulesExecuted: [] };
const subject = { property: 'Example site', routePattern: '/', locator: { role: 'text', name: '.hero > p:nth-child(2)', cssPath: '.hero > p:nth-child(2)', ordinal: 0 } };
const finding: Finding = { schemaVersion: 1, runId: run.id, ruleId: asRuleId('axe-core:color-contrast'), requirementId: asRequirementId('wcag22.1.4.3'), subject, confidence: 'violation', severity: 'serious', message: 'Contrast ratio is 2.8:1.', evidence: [{ kind: 'computed-style', properties: { ratio: '2.8', required: '4.5' } }], fingerprint: fingerprint({ detects: 'presence', ruleId: asRuleId('axe-core:color-contrast'), subject }), producer: { type: 'engine', name: 'axe-core', version: '4' } };

const evaluation = TrackingEvaluation.parse({ runId: 'r', property: 'Example site', site: { url: 'https://example.com/', host: 'example.com', registrableDomain: 'example.com' }, startedAt: '2026-10-05T10:00:00Z', finishedAt: '2026-10-05T10:01:00Z', versions: { kb: '0', registry: '0', package: '0' }, redacted: true,
  locations: [{ spec: { id: 'de', label: 'Germany', country: 'DE', proxied: false }, verification: { verdict: 'verified', expected: { country: 'DE' }, observed: { country: 'DE' }, sources: [], jurisdictions: ['eu'], checkedAt: 'now' }, scenarios: [{ scenario: 'reject', status: 'tested', choice: { kind: 'reject', ok: false, method: 'test' } }] }],
  inventory: [{ partyId: 'x', label: 'Example analytics', domain: 'analytics.example', hosts: ['analytics.example'], recognized: true, kbStatus: 'proposed', categories: ['analytics'], behavesLikeTracker: true, trackerSignals: [], sends: ['page-address'], stores: [{ name: '_visitor', kind: 'cookie', lifetimeDays: 30 }], sources: ['injected'], loadedBy: [], seenIn: [] }], notTested: [{ scope: 'frame', id: 'embedded-widget', reason: 'Storage in https://example.com/a/very/long/unbroken/frame-url?with=long_parameters_cannot_be_measured' }], researchQueue: [{partyId:'x',domain:'analytics.example',reason:'Observed behavior needs research',kind:'drift'}] });
const consentFinding: Finding = { ...finding, ruleId: asRuleId('tracking.prior-consent'), requirementId: asRequirementId('eprivacy.art5.3'), details: { party: { id: 'x', label: 'Example analytics', domain: 'analytics.example' }, occurrences: [{ location: 'de', scenario: 'reject', phases: ['before-choice'], firstMs: 20, requests: 1, sent: ['page-address'], stored: [], decoded: [], markers: [] }] } };

suite('human reports in a browser', () => {
  let browser: Browser;
  beforeAll(async () => { const { chromium } = await import('playwright'); browser = await chromium.launch({ headless: true, ...channelFallback }); });
  afterAll(async () => { await browser?.close(); });

  it('shows the work brief, hides technical details, and works on a narrow screen', async () => {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.setContent(renderHtmlReport(run, [finding]));
    expect(errors).toEqual([]);
    expect(await page.locator('#groups .grp[open]').count()).toBe(1);
    expect(await page.locator('summary button').count()).toBe(0);
    expect(await page.locator('.work-brief').isVisible()).toBe(true);
    expect(await page.locator('.finding .fmeta').isVisible()).toBe(false);
    expect((await page.locator('.finding > p').allTextContents()).join(' ')).not.toContain('.hero > p:nth-child');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.locator('.finding > .human-details > summary').click();
    expect(await page.locator('.finding .fmeta').isVisible()).toBe(true);
    expect(errors).toEqual([]);
    await page.close();
  });

  it('filters actions, restores linked actions, and copies a readable brief with real newlines', async () => {
    const page = await browser.newPage();
    await page.setContent(renderHtmlReport(run, [finding]));
    await page.locator('#actions > details > summary').click();
    await page.locator('#q').fill('nothing-matches');
    expect(await page.locator('#groups .finding').count()).toBe(0);
    await page.locator('.human-next a').click();
    await expect.poll(() => page.locator('#groups .finding').count()).toBe(1);
    expect(await page.locator('#q').inputValue()).toBe('');
    await page.evaluate(() => Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async (text: string) => { document.body.dataset.copied = text; } } }));
    await page.locator('#copyBtn').click();
    const copied = await page.evaluate(() => document.body.dataset.copied!);
    expect(copied).toContain('What to do:');
    expect(copied).toContain('How to check the fix:');
    expect(copied.split('\n').length).toBeGreaterThan(5);
    expect(copied).not.toContain('\\n');
    await page.close();
  });

  it('uses compact symbols and one selected detail panel without duplicating the inventories', async () => {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    const errors: string[] = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.setContent(renderConsentHtml(buildConsentReportModel(evaluation, [consentFinding])));
    expect(await page.locator('#matrix-detail-library').isVisible()).toBe(false);
    expect(await page.locator('[data-action-key]:visible').count()).toBe(0);
    expect(await page.locator('.matrix-cell').count()).toBe(0);
    expect(await page.locator('.matrix-result').allTextContents()).toEqual(['–', '–']); // the failed reject is one column gap: not checked, not "needs a look"
    expect(await page.locator('#matrix-question-count').textContent()).toBe('0');
    expect(await page.locator('#matrix-gaps').textContent()).toContain('could not confirm rejecting');
    await page.selectOption('#matrix-filter', 'attention'); // the column gap alone does not make a row unresolved
    expect(await page.locator('[data-matrix-row]:visible').count()).toBe(0);
    await page.selectOption('#matrix-filter', 'all');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.selectOption('#matrix-filter', 'storage');
    expect(await page.locator('[data-matrix-kind=tool]:visible').count()).toBe(0);
    await page.selectOption('#matrix-filter', 'all');
    const rowsBefore = await page.locator('[data-matrix-row]').count();
    await page.selectOption('#matrix-group', 'category');
    const groups = await page.locator('[data-matrix-group]').evaluateAll(els => els.map(el => (el as HTMLElement).dataset.matrixGroup));
    const categories = await page.locator('[data-matrix-category]').evaluateAll(els => [...new Set(els.map(el => el.firstChild!.textContent))]);
    expect([...groups].sort()).toEqual([...categories].sort()); // one group per category shown in the column
    if (groups.includes('Unclassified')) expect(groups[0]).toBe('Unclassified'); // what needs a classification comes first
    expect(await page.locator('[data-matrix-row]').count()).toBe(rowsBefore);
    await page.selectOption('#matrix-group', 'tool');
    expect(await page.locator('[data-matrix-group]').count()).toBeGreaterThan(0);
    await page.selectOption('#matrix-group', 'none');
    expect(await page.locator('[data-matrix-group]').count()).toBe(0);
    await page.locator('[data-matrix-kind=tool] .matrix-result').nth(0).click(); // only actions that ran get a column
    expect(await page.locator('#matrix-detail-title').textContent()).toBe('Example analytics');
    expect(await page.locator('#matrix-detail-status').textContent()).toBe('Not checked — this visitor choice was not completed');
    expect(await page.locator('#matrix-detail-reason').textContent()).toContain('could not confirm rejecting');
    expect(await page.locator('#matrix-primary [data-action-key]:visible').count()).toBe(1);
    expect(await page.locator('#matrix-related').isVisible()).toBe(true);
    expect(await page.locator('#matrix-related').getAttribute('open')).toBe(null);
    await page.locator('[data-matrix-kind=storage] .matrix-result').first().click();
    expect(await page.locator('#matrix-detail-title').textContent()).toBe('_visitor');
    expect(await page.locator('#tool-1').isVisible()).toBe(false);
    expect(await page.locator('#matrix-classification [name=category]').isVisible()).toBe(true);
    expect(await page.locator('#matrix-classification [data-class-apply]').isVisible()).toBe(true);
    expect(await page.locator('#matrix-primary [data-action-key]:visible').count()).toBe(1);
    await page.locator('#rule-actions > summary').click();
    await page.locator('[data-select-action="action-1"]').click();
    expect(await page.locator('#matrix-primary #action-1').isVisible()).toBe(true);
    expect(await page.locator('#matrix-primary [data-action-key]').count()).toBe(1);
    expect(errors).toEqual([]);
    await page.close();
  });
});

suite('report checklist persistence', () => {
  let browser: Browser;
  beforeAll(async () => { const { chromium } = await import('playwright'); browser = await chromium.launch({ headless: true, ...channelFallback }); });
  afterAll(async () => { await browser?.close(); });

  it('updates counts, restores notes, isolates scans, and supports remaining-task filters', async () => {
    const context = await browser.newContext();
    await context.route('https://reports.example/**', route => route.fulfill({ contentType: 'text/html', body: renderHtmlReport({ ...run, id: asRunId(route.request().url().endsWith('/two') ? 'other-scan' : String(run.id)) }, [finding]) }));
    const page = await context.newPage();
    await page.goto('https://reports.example/one');
    expect(await page.locator('#work-fix-count').textContent()).toBe('1');
    await page.locator('[data-work-note]').fill('Checked by marketing <img src=x onerror=alert(1)>');
    const question = page.locator('[data-review-answer=implementation]');
    const initial = Number(await page.locator('#work-question-count').textContent());
    await question.fill('Changed foreground to #111; measured contrast 7:1');
    expect(Number(await page.locator('#work-question-count').textContent())).toBe(initial - 1);
    await page.selectOption('[data-work-status]', 'done');
    expect(Number(await page.locator('#work-question-count').textContent())).toBe(initial - 1);
    expect(await page.locator('#work-fix-count').textContent()).toBe('0');
    expect(await page.locator('#work-done-count').textContent()).toBe('1');
    expect(await page.locator('.finding > .human-status').textContent()).toContain('Problem observed');
    await page.reload();
    expect(await page.locator('[data-work-status]').inputValue()).toBe('done');
    expect(await page.locator('[data-work-note]').inputValue()).toContain('<img src=x');
    expect(await page.locator('[data-review-answer=implementation]').inputValue()).toContain('measured contrast');
    await page.selectOption('#work-filter', 'remaining');
    expect(await page.locator('#groups .finding').count()).toBe(0);
    await page.selectOption('#work-filter', 'done');
    expect(await page.locator('#groups .finding').count()).toBe(1);
    await page.goto('https://reports.example/two');
    expect(await page.locator('[data-work-status]').inputValue()).toBe('open');
    await page.goto('https://reports.example/one');
    expect(await page.locator('[data-work-status]').inputValue()).toBe('done');
    await context.close();
  });

  it('keeps grid totals aligned, saves selected fixes, and never upgrades missing checks', async () => {
    // x is an identified analytics tool: it and its cookie _visitor are checked
    // automatically. y is unidentified: it and its cookie _mystery need a
    // person's classification. The withdrawal didn't go through, so its column
    // is "not tested" for every row.
    const mystery = { partyId: 'unknown:mystery.example', label: 'mystery.example', domain: 'mystery.example', hosts: ['mystery.example'], recognized: false, kbStatus: 'unrecognized', categories: ['unknown'], behavesLikeTracker: false, trackerSignals: [], sends: [], stores: [{ name: '_mystery', kind: 'cookie', lifetimeDays: 30 }], sources: ['injected'], loadedBy: [], seenIn: [] };
    const e = TrackingEvaluation.parse({...evaluation, notTested:[], researchQueue:[], inventory:[...evaluation.inventory, mystery], locations:[{...evaluation.locations[0], scenarios:[{scenario:'do-nothing',status:'tested'},{scenario:'reject',status:'tested',choice:{kind:'reject',ok:true,method:'test'}},{scenario:'withdraw',status:'tested',choice:{kind:'withdraw',ok:false,method:'test'}}]}], behaviorObservations:[
      {location:'de',scenario:'do-nothing',durationMs:10000,knownPartyIds:['x'],parties:[{partyId:'x',dataRequests:1,requestPhases:['before-choice'],dataRequestPhases:{'before-choice':1},limitedRequestsByPhase:{},stores:[{name:'_visitor',kind:'cookie',writePhases:['before-choice'],presentAtEnd:true,attribution:'observed'}]},
        {partyId:'unknown:mystery.example',dataRequests:1,requestPhases:['before-choice'],dataRequestPhases:{'before-choice':1},limitedRequestsByPhase:{},stores:[{name:'_mystery',kind:'cookie',writePhases:['before-choice'],presentAtEnd:true,attribution:'observed'}]}]},
      {location:'de',scenario:'reject',durationMs:10000,knownPartyIds:['x'],parties:[]},
      {location:'de',scenario:'withdraw',durationMs:10000,knownPartyIds:['x'],parties:[]}
    ]});
    const model=buildConsentReportModel(e, []), original=JSON.stringify(model);
    const context=await browser.newContext();
    await context.route('https://reports.example/**',route=>route.fulfill({contentType:'text/html',body:renderConsentHtml({...model,runId:route.request().url().endsWith('/two')?'other':model.runId})}));
    const page=await context.newPage();const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));
    await page.goto('https://reports.example/one');
    const totals=async()=>Promise.all(['mismatch','question','match','done'].map(id=>page.locator('#matrix-'+id+'-count').textContent()));
    // The identified tool and its cookie are checked automatically: on before a choice (mismatch), off after rejection (match).
    // The failed withdrawal is one column-level gap: its 4 cells are "not checked", not counted as needing a look.
    expect(await totals()).toEqual(['2','4','2','0']);
    expect(await page.locator('#matrix-gaps li').count()).toBe(1);
    expect(await page.locator('#matrix-gaps').textContent()).toContain('After withdrawal');
    expect(await page.locator('th[data-column-state=not-completed]').count()).toBe(1);
    expect(await page.locator('th[data-column-state=not-completed] .matrix-col-gap').textContent()).toBe('Not completed');
    expect(await page.locator('.matrix-result[data-result=not-tested]').allTextContents()).toEqual(['–','–','–','–']);
    expect(await page.locator('.matrix-result[data-result=mismatch]').count()).toBe(2);
    expect(await page.locator('.matrix-result[data-result=match]').count()).toBe(2);
    expect(await page.locator('#actions').count()).toBe(0);
    expect(await page.locator('#storage').count()).toBe(0);
    await page.locator('[data-matrix-kind=tool] .matrix-result[data-result=mismatch]').click();
    await page.locator('#matrix-primary .work-question-details > summary').click();
    await page.locator('#matrix-primary [data-work-note]').fill('Consent gate updated; retest booked.');
    await page.locator('#matrix-primary [data-work-status]').selectOption('done');
    expect(await totals()).toEqual(['1','4','2','1']);
    expect(await page.locator('#matrix-detail-status').textContent()).toContain('Marked done');
    expect(await page.locator('#matrix-detail-reason').textContent()).toContain('Original scan result: Behavior mismatch');
    expect(await page.locator('.matrix-result[data-result=not-tested]').count()).toBe(4);
    await page.reload();
    expect(await totals()).toEqual(['1','4','2','1']);
    await page.locator('.matrix-result[data-result=done]').click();
    expect(await page.locator('#matrix-primary [data-work-note]').inputValue()).toContain('Consent gate updated');
    // A purpose answer resolves research questions, not missing evidence or unrelated checks.
    await page.locator('[data-matrix-kind=storage] .matrix-result[data-result=review]').first().click();
    const form=page.locator('#matrix-classification [data-class-form]');
    await form.locator('[data-class-research] > summary').click();
    for(const [name,value] of Object.entries({purpose:'Measures visits',owner:'Vendor / marketing',information:'Visitor identifier',source:'Vendor docs and privacy reviewer'}))await form.locator('[name='+name+']').fill(value);
    await form.locator('[name=category]').selectOption('analytics');
    expect(await page.locator('[data-matrix-kind=storage]').filter({hasText:'_visitor'}).locator('.matrix-category').textContent()).toContain('Analytics'); // inherited from its tool
    expect(await page.locator('[data-matrix-kind=storage]').filter({hasText:'_mystery'}).locator('.matrix-category').textContent()).toContain('your classification');
    expect(await totals()).toEqual(['2','2','3','1']);
    expect(await page.locator('#matrix-classification [name=category]').isVisible()).toBe(true);
    expect(await page.locator('#matrix-classification [data-class-apply]').isVisible()).toBe(true);
    expect(await form.locator('[name=category] option').allTextContents()).toEqual(['Choose a category…','Necessary','Functional','Analytics','Performance','Advertisement','Other']);
    await page.locator('#matrix-primary [data-work-status]').selectOption('done');
    expect(await totals()).toEqual(['1','2','3','2']);
    await form.locator('[name=category]').selectOption('performance');
    expect(await totals()).toEqual(['2','2','3','1']); // a changed classification reopens completed work
    await form.locator('[data-class-apply]').click();
    expect(await page.locator('#matrix-classification [data-category-impact]').textContent()).toContain('your purpose choice');
    await form.locator('[name=category]').selectOption('necessary');
    expect(await totals()).toEqual(['1','2','4','1']); // necessary may always run: working as expected
    await form.locator('summary').filter({hasText:'Additional purposes'}).click();
    await form.locator('[name=additionalCategories][value=advertising]').check();
    expect(await totals()).toEqual(['2','2','3','1']); // necessary does not override advertising
    await page.reload();
    expect(await totals()).toEqual(['2','2','3','1']);
    await page.locator('[data-matrix-kind=storage]').filter({hasText:'_mystery'}).locator('.matrix-result[data-result=mismatch]').click();
    expect(await page.locator('#matrix-classification [name=category]').inputValue()).toBe('necessary');
    expect(await page.locator('#matrix-classification [name=additionalCategories][value=advertising]').isChecked()).toBe(true);
    expect(await page.locator('.matrix-result[data-result=not-tested]').count()).toBe(4);
    await page.locator('.matrix-result[data-result=not-tested]').first().click();
    await page.locator('#matrix-primary [data-work-status]').selectOption('done');
    expect(await page.locator('#matrix-detail-status').textContent()).toBe('Not checked — this visitor choice was not completed');
    expect(await page.locator('#matrix-detail-status').getAttribute('data-tone')).toBe('neutral');
    expect(await page.locator('#matrix-detail-reason').textContent()).toContain('whole “After withdrawal” column');
    expect(await page.locator('.matrix-result[data-result=not-tested]').count()).toBe(4);
    await page.goto('https://reports.example/two');expect(await totals()).toEqual(['2','4','2','0']);
    expect(JSON.stringify(model)).toBe(original);expect(errors).toEqual([]);await context.close();
  });

  it('saves classifications independently, preserves problems, and restores backups only to their report', async () => {
    const model = buildConsentReportModel(evaluation, [consentFinding]);
    const before = JSON.stringify(model);
    const context = await browser.newContext();
    await context.route('https://reports.example/**', route => route.fulfill({ contentType: 'text/html', body: renderConsentHtml(model) }));
    const page = await context.newPage();
    await page.goto('https://reports.example/consent');
    expect(await page.locator('#work-class-count').textContent()).toBe('2');
    const tool = page.locator('#tool-1');
    await page.locator('[data-matrix-kind=tool] .matrix-result').first().click();
    await tool.locator('[name=category]').selectOption('analytics');
    await tool.locator('[data-class-research] > summary').click();
    await tool.locator('[name=purpose]').fill('Measures product-page visits');
    expect(await page.locator('#work-class-count').textContent()).toBe('2');
    await page.reload();
    await page.locator('[data-matrix-kind=tool] .matrix-result').first().click();
    expect(await tool.locator('[name=purpose]').inputValue()).toBe('Measures product-page visits');
    expect(await tool.locator('[data-class-answer]').textContent()).toContain('owner');
    await tool.locator('[data-class-research] > summary').click();
    await tool.locator('[name=owner]').fill('Example vendor / marketing team');
    await tool.locator('[name=information]').fill('Page URL and anonymous visit identifier');
    await tool.locator('[name=source]').fill('Vendor docs reviewed by marketing, 2026-10-05');
    await tool.locator('button[type=submit]').click();
    expect(await page.locator('#work-class-count').textContent()).toBe('1');
    expect(await tool.locator('[data-class-badge]').getAttribute('data-tone')).toBe('green');
    expect(await tool.locator('[data-class-badge]').getAttribute('data-tone')).toBe('green');
    await page.reload();
    await page.locator('[data-matrix-kind=tool] .matrix-result').first().click();
    expect(await tool.locator('[data-class-badge]').textContent()).toContain('Reviewed by you');
    const saved = await page.evaluate(() => { const config = JSON.parse(document.getElementById('workspace-config')!.textContent!); return localStorage.getItem(config.key)!; });
    page.on('dialog', dialog => dialog.accept());
    await page.locator('#checklist-panel > summary').click();
    await page.locator('#work-reset').click();
    expect(await page.locator('#work-class-count').textContent()).toBe('2');
    await page.locator('#work-import').setInputFiles({ name: 'wrong.json', mimeType: 'application/json', buffer: Buffer.from(saved.replace(/"reportKey":"[^"]+"/, '"reportKey":"wrong-report"')) });
    await expect.poll(() => page.locator('#work-storage-status').textContent()).toContain('not for this report');
    expect(await page.locator('#work-class-count').textContent()).toBe('2');
    await page.locator('#work-import').setInputFiles({ name: 'progress.json', mimeType: 'application/json', buffer: Buffer.from(saved) });
    await expect.poll(() => page.locator('#work-class-count').textContent()).toBe('1');
    const downloadPromise = page.waitForEvent('download');
    await page.locator('#work-export').click();
    const download = await downloadPromise;
    const backup = JSON.parse(fs.readFileSync((await download.path())!, 'utf8'));
    expect(backup.classifications).toEqual(JSON.parse(saved).classifications);
    expect(Object.keys(backup).sort()).toEqual(['actions', 'classifications', 'remediation', 'reportKey', 'version']);
    expect(JSON.stringify(model)).toBe(before);
    await context.close();
  });

  it('preserves older classification answers as incomplete research and accepts independent cookie answers', async () => {
    const context = await browser.newContext();
    await context.route('https://reports.example/**', route => route.fulfill({ contentType: 'text/html', body: renderConsentHtml(buildConsentReportModel(evaluation, [consentFinding])) }));
    const page = await context.newPage();
    await page.goto('https://reports.example/legacy');
    await page.evaluate(() => {
      const key = JSON.parse(document.getElementById('workspace-config')!.textContent!).key;
      const id = document.getElementById('tool-1')!.dataset.classKey!;
      localStorage.setItem(key, JSON.stringify({ version: 1, reportKey: key, actions: {}, classifications: { [id]: { category: 'analytics', purpose: 'Counts visits', source: 'Existing vendor notes' } } }));
    });
    await page.reload();
    expect(await page.locator('#work-class-count').textContent()).toBe('2');
    const tool = page.locator('#tool-1');
    await page.locator('[data-matrix-kind=tool] .matrix-result').first().click();
    expect(await tool.locator('[name=purpose]').inputValue()).toBe('Counts visits');
    expect(await tool.locator('[data-class-answer]').textContent()).toBe('Still to answer: owner, information used');
    const cookie = page.locator('[data-cookie-state]');
    await page.locator('[data-matrix-kind=storage] .matrix-result').first().click();
    await cookie.locator('[data-class-research] > summary').click();
    for (const [name, value] of Object.entries({purpose:'Remembers an anonymous visitor',owner:'Example vendor',information:'Random visitor ID',source:'Vendor cookie guide and site owner'})) await cookie.locator('[name='+name+']').fill(value);
    await cookie.locator('[name=category]').selectOption('analytics');
    expect(await page.locator('#work-class-count').textContent()).toBe('1');
    expect(await cookie.locator('[data-class-badge]').getAttribute('data-tone')).toBe('green');
    expect(await tool.locator('[data-class-badge]').getAttribute('data-tone')).toBe('amber');
    await cookie.locator('[data-class-clear]').click();
    expect(await page.locator('#work-class-count').textContent()).toBe('2');
    await context.close();
  });

  it('keeps the checklist usable when browser storage is blocked', async () => {
    const context = await browser.newContext();
    await context.addInitScript(() => { Object.defineProperty(Storage.prototype, 'setItem', { value: () => { throw new Error('Blocked'); } }); });
    await context.route('https://reports.example/**', route => route.fulfill({ contentType: 'text/html', body: renderHtmlReport(run, [finding]) }));
    const page = await context.newPage();
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto('https://reports.example/blocked');
    await page.selectOption('[data-work-status]', 'done');
    expect(await page.locator('#work-done-count').textContent()).toBe('1');
    expect(await page.locator('#work-storage-status').textContent()).toContain('download a backup');
    expect(errors).toEqual([]);
    await context.close();
  });
  it('renders the compatibility section: reach line, mismatch first, change list, readable on a phone', async () => {
    const e = compatibilityEvaluation();
    e.compatibility = reconcileCompatibility(e);
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    const errors: string[] = [];
    page.on('pageerror', (err) => errors.push(err.message));
    await page.setContent(renderConsentHtml(buildConsentReportModel(e, [])));
    const section = page.locator('#compatibility');
    await section.scrollIntoViewIfNeeded();
    expect(await section.isVisible()).toBe(true);
    expect(await section.locator('.ck-reach').textContent()).toBe("3 tools are loaded outside your consent tool's reach: Meta Pixel, TikTok Pixel, tracker.test.");
    expect(await section.locator('[data-compat-row]').count()).toBe(5);
    expect(await section.locator('[data-compat-row]').first().getAttribute('data-behavior')).toBe('mismatch');
    expect(await section.locator('[data-change-group]').first().getAttribute('data-change-group')).toBe('mismatch');
    expect((await section.locator('[data-change-group=rewrite] pre').allTextContents()).join(' ')).toContain('<script type="text/plain" data-category="analytics" data-src=');
    expect(await section.locator('[data-change-group=gtm] .ck-item').count()).toBe(1);
    expect(await section.locator('a[href="change-list.md"][download]').count()).toBe(1);
    expect(await section.locator('[data-not-required] summary').textContent()).toContain('Not counted');
    expect(await page.locator('nav a[href="#compatibility"]').count()).toBe(1);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    expect(errors).toEqual([]);
    await page.close();
  });
});

// R3: the guided checklist ("Your to-do list"). Runs on the Playwright
// Chromium build when present, else on an installed browser named by
// COMPLYKIT_BROWSER_CHANNEL (chrome / msedge).
const remChannel = process.env.COMPLYKIT_BROWSER_CHANNEL;
const remSuite = available || remChannel ? describe : describe.skip;
remSuite('the guided checklist in a browser', () => {
  let browser: Browser;
  const NOW = '2026-10-06T12:00:00.000Z';
  const tasks = generateConsentConfig(compatibilityEvaluation(), { complykitVersion: '0.0.0-test', now: NOW }).tasks;
  const required = tasks.filter((t) => !t.optional).length;
  const installTask = tasks.find((t) => t.kind === 'install')!;
  function reportHtml(service?: { domain: string; workspace: string; jobId: string }): string {
    const e = compatibilityEvaluation();
    e.compatibility = reconcileCompatibility(e);
    const m = buildConsentReportModel(e, []);
    m.remediation = { tasks, source: 'run', configAt: NOW, runId: 'run-1' };
    const html = renderConsentHtml(m);
    if (!service) return html;
    const marker = '<script type="application/json" id="workspace-config">';
    return html.replace(marker, `<script type="application/json" id="ck-service">${JSON.stringify({ version: 1, ...service })}</script>${marker}`);
  }
  beforeAll(async () => { const { chromium } = await import('playwright'); browser = await chromium.launch({ headless: true, ...(available ? {} : { channel: remChannel }) }); });
  afterAll(async () => { await browser?.close(); });

  it('offline: renders install first, copies the snippet, hides Verify, and keeps "made this change" across a reload', async () => {
    const context = await browser.newContext();
    await context.route('https://reports.example/**', (route) => route.fulfill({ contentType: 'text/html', body: reportHtml() }));
    const page = await context.newPage();
    const errors: string[] = [];
    page.on('pageerror', (err) => errors.push(err.message));
    await page.goto('https://reports.example/checklist');
    const section = page.locator('#remediation');
    expect(await section.locator('h2').textContent()).toBe('Your to-do list');
    const cards = section.locator('[data-remediation-id]');
    expect(await cards.first().getAttribute('data-task-kind')).toBe('classify'); // the decisions, then install
    expect(await cards.nth(1).getAttribute('data-remediation-id')).toBe('install');
    expect(await section.locator('[data-rem-progress-text]').textContent()).toBe(`0 of ${required} done`);
    expect(await section.locator('[data-rem-verify]:visible').count()).toBe(0);
    expect(await section.locator('[data-rem-offline]').isVisible()).toBe(true);
    expect(await section.locator('[data-rem-zip]').isVisible()).toBe(false);
    // The install step names the CLI's folder here, never the service's button.
    const step1 = section.locator('[data-remediation-id="install"] .ck-task-steps li').first();
    expect(await step1.innerText()).toContain('complykit consent-config <run-dir>');
    expect(await step1.innerText()).not.toContain('Download install bundle');
    // Copy the install snippet.
    await page.evaluate(() => Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async (text: string) => { document.body.dataset.copied = text; } } }));
    const install = section.locator('[data-remediation-id="install"]');
    await install.locator('[data-rem-copy]').click();
    await expect.poll(() => page.evaluate(() => document.body.dataset.copied ?? '')).toBe(installTask.snippet!.after);
    expect(await install.locator('[data-rem-copy-status]').textContent()).toBe('Copied');
    // Keyboard: focus the "made this change" button and press Enter.
    await install.locator('[data-rem-done]').focus();
    await page.keyboard.press('Enter');
    expect(await install.locator('[data-rem-pill]').textContent()).toBe('Marked done');
    expect(await install.getAttribute('data-status')).toBe('done-unverified');
    expect(await section.locator('[data-rem-progress-text]').textContent()).toBe(`0 of ${required} done`);
    expect(await section.locator('[data-rem-progress-more]').textContent()).toContain('1 more marked done, not verified yet');
    // Change-list items link to their task.
    expect(await page.locator('#compatibility .ck-change-task').count()).toBeGreaterThan(0);
    await page.reload();
    expect(await page.locator('#remediation [data-remediation-id="install"] [data-rem-pill]').textContent()).toBe('Marked done');
    expect(await page.locator('#remediation [data-remediation-id="install"] [data-rem-done]').getAttribute('aria-pressed')).toBe('true');
    expect(errors).toEqual([]);
    await context.close();
  });

  it('service: Verify calls the endpoint, renders the result and evidence, and stores status in the shared workspace', async () => {
    const context = await browser.newContext();
    const service = { domain: 'example-shop.test', workspace: '/api/sites/example-shop.test/workspace', jobId: 'job-1' };
    const patches: Array<Record<string, { value: unknown }>> = [];
    const verifyCalls: string[] = [];
    const entries: Record<string, { value: unknown; at: string }> = {};
    await context.route('https://reports.example/**', async (route) => {
      const url = new URL(route.request().url());
      if (url.pathname === service.workspace) {
        if (route.request().method() === 'PATCH') {
          const body = JSON.parse(route.request().postData() ?? '{}') as { entries: Record<string, { value: unknown; at: string }> };
          patches.push(body.entries);
          Object.assign(entries, body.entries);
        }
        return route.fulfill({ contentType: 'application/json', body: JSON.stringify(route.request().method() === 'PATCH' ? { workspace: { version: 1, domain: service.domain, entries, runs: [] }, stale: { entries: [], config: false, runs: [] } } : { version: 1, domain: service.domain, entries, runs: [] }) });
      }
      const m = /^\/api\/sites\/example-shop\.test\/remediation\/([^/]+)\/verify$/.exec(url.pathname);
      if (m && route.request().method() === 'POST') {
        const id = decodeURIComponent(m[1]);
        verifyCalls.push(id);
        const lastVerify = { at: '2026-10-07T09:00:00.000Z', result: 'pass', message: 'The served HTML carries the change: the config is the latest generated one and the tool runs first.', evidence: ['https://www.example-shop.test/ line 4: <script src="/complykit/v1/complykit-consent.js">'] };
        entries[`task:change:${id}`] = { value: { status: 'verified', lastVerify }, at: lastVerify.at };
        return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ task: { ...tasks.find((t) => t.id === id), status: 'verified', lastVerify } }) });
      }
      return route.fulfill({ contentType: 'text/html', body: reportHtml(service) });
    });
    const page = await context.newPage();
    const errors: string[] = [];
    page.on('pageerror', (err) => errors.push(err.message));
    await page.goto('https://reports.example/reports/job-1/consent/consent-report.html');
    const section = page.locator('#remediation');
    const install = section.locator('[data-remediation-id="install"]');
    expect(await section.locator('[data-rem-offline]').isVisible()).toBe(false);
    expect(await install.locator('[data-rem-zip]').getAttribute('href')).toBe('/api/sites/example-shop.test/install.zip');
    // On the service the install step names the bundle button, never the CLI's folder.
    const step1 = await install.locator('.ck-task-steps li').first().innerText();
    expect(step1).toContain('Download install bundle (.zip)');
    expect(step1).not.toContain('consent-config');
    // Manual tasks never get a Verify button.
    const manual = tasks.find((t) => t.verify.method === 'manual' && t.kind !== 'classify')!;
    expect(await section.locator(`[data-remediation-id="${manual.id}"] [data-rem-verify]`).count()).toBe(0);
    await install.locator('[data-rem-verify]').click();
    await expect.poll(() => install.locator('[data-rem-pill]').textContent()).toBe('Verified ✓');
    expect(verifyCalls).toEqual(['install']);
    expect(await install.locator('[data-rem-result]').textContent()).toContain('The served HTML carries the change');
    expect(await install.locator('[data-rem-result] .ck-task-evidence li').count()).toBe(1);
    expect(await install.locator('[data-rem-done]').isVisible()).toBe(false);
    expect(await section.locator('[data-rem-progress-text]').textContent()).toBe(`1 of ${required} done`);
    // Mark another one done: it goes to the shared workspace under task:change:<id>.
    const next = section.locator('[data-remediation-id]').nth(2); // after the decision and install
    const nextId = (await next.getAttribute('data-remediation-id'))!;
    await next.locator('[data-rem-done]').click();
    await expect.poll(() => patches.some((p) => (p[`task:change:${nextId}`]?.value as { status?: string } | undefined)?.status === 'done-unverified')).toBe(true);
    // The verified value came from the service and was not sent back.
    expect(patches.some((p) => 'task:change:install' in p)).toBe(false);
    // A failing endpoint says so and changes nothing.
    await context.route('**/remediation/**', (route) => route.fulfill({ status: 502, contentType: 'application/json', body: JSON.stringify({ error: 'could not fetch the page' }) }));
    const third = section.locator('[data-remediation-id]').nth(3);
    await third.locator('[data-rem-verify]').click();
    await expect.poll(() => third.locator('[data-rem-result]').textContent()).toContain('Could not run the check: could not fetch the page');
    expect(await third.locator('[data-rem-pill]').textContent()).toBe('To do');
    await page.reload();
    await expect.poll(() => page.locator('#remediation [data-remediation-id="install"] [data-rem-pill]').textContent()).toBe('Verified ✓');
    await expect.poll(() => page.locator(`#remediation [data-remediation-id="${nextId}"] [data-rem-pill]`).textContent()).toBe('Marked done');
    expect(errors).toEqual([]);
    await context.close();
  });
});
