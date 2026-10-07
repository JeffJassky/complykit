import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect } from 'vitest';
import { generateConsentConfig } from '../src/consent-generator.js';
import { renderHeadSnippet } from '../src/remediation.js';
import { verifyInstall, verifyRewriteTag, verifyRemoveLeak, verifyGtmTagConsent, verifyConsentDefault, verifyRemoveExistingTool, judgeSpotCheck, runVerify, elementMatches } from '../src/rules/remediation/verify.js';
import { rewriteContainerConsent } from '../src/rules/tracking/gtm.js';
import { parseMarkup, withConsentConfigHash, type ElementSignature, type SpotCheckObservation } from '../src/record/index.js';
import { compatibilityEvaluation, PAGE } from './fixtures/compatibility-report.js';

// Pure verify checkers (plans/remediation-flow.md §5). Generic HTML built
// inline: no client material. Every checker fails closed — the cases below
// pin what each one can prove and what it must refuse to.

const r = generateConsentConfig(compatibilityEvaluation(), { complykitVersion: '0.0.0-test', now: '2026-10-06T12:00:00.000Z' });
const SRC = r.scriptSrc;
const HEAD = renderHeadSnippet(r.config, SRC);
const GTM_SNIPPET = `<script>(function(w,d,s,l,i){w[l]=w[l]||[];w[l].push({'gtm.start':new Date().getTime(),event:'gtm.js'});var f=d.getElementsByTagName(s)[0],j=d.createElement(s);j.async=true;j.src='https://www.googletagmanager.com/gtm.js?id='+i;f.parentNode.insertBefore(j,f);})(window,document,'script','dataLayer','GTM-XXXX01');</script>`;
const GTAG = '<script async src="https://www.googletagmanager.com/gtag/js?id=G-XXXX01"></script>';
const page = (head: string[], body: string[] = []): string => `<!doctype html>\n<html><head>\n<meta charset="utf-8">\n${head.join('\n')}\n<title>x</title>\n</head><body>\n${body.join('\n')}\n</body></html>`;

const GA_SIG: ElementSignature = { kind: 'script', context: 'document', host: 'www.googletagmanager.com', path: '/gtag/js', ids: ['G-XXXX01'] };
const FB_SIG: ElementSignature = { kind: 'img', context: 'noscript', host: 'www.facebook.com', path: '/tr', ids: [] };
const INLINE_SIG: ElementSignature = { kind: 'script', context: 'document', ids: [], inline: { match: "fbq('init'" } };
const FBQ = `<script>!function(f,b,e,v,n,t,s){n=f.fbq=function(){};t=b.createElement(e);t.src='https://connect.facebook.net/en_US/fbevents.js';s=b.getElementsByTagName(e)[0];s.parentNode.insertBefore(t,s)}(window,document,'script');fbq('init','000000');fbq('track','PageView');</script>`;

describe('elementMatches', () => {
  it('matches an external tag by host + path + ids at any line, and an inline one by the matched text', () => {
    const els = parseMarkup(page(['<script></script>', '<script></script>', GTAG, FBQ]), PAGE);
    expect(els.filter((el) => elementMatches(el, GA_SIG)).map((el) => el.line)).toEqual([6]);
    expect(els.filter((el) => elementMatches(el, INLINE_SIG)).map((el) => el.line)).toEqual([7]);
    expect(els.filter((el) => elementMatches(el, { ...GA_SIG, ids: ['G-OTHER99'] }))).toEqual([]);
    expect(els.filter((el) => elementMatches(el, { ...GA_SIG, context: 'noscript' }))).toEqual([]);
  });
});

describe('verifyInstall', () => {
  const expected = { page: PAGE, configHash: r.config.hash, scriptSrc: SRC };

  it('passes: config element first, current hash, blocking core script, then GTM', () => {
    const out = verifyInstall(page([HEAD, GTM_SNIPPET, GTAG]), expected);
    expect(out.result).toBe('pass');
    expect(out.evidence).toEqual([`config hash ${r.config.hash.slice(0, 12)} = latest`, 'core script at line 5, blocking']);
  });

  it('fails: no config element; two config elements; config after the core script', () => {
    expect(verifyInstall(page([`<script src="${SRC}"></script>`]), expected)).toMatchObject({ result: 'fail', message: expect.stringContaining('no <script id="complykit-config">') });
    expect(verifyInstall(page([HEAD, HEAD]), expected).message).toMatch(/2 config elements/);
    const [cfg, core] = HEAD.split('\n');
    expect(verifyInstall(page([core, cfg]), expected).message).toMatch(/config element .* comes after the core script/);
  });

  it('fails: the deployed config is not the latest (another hash) or was edited (hash does not verify)', () => {
    expect(verifyInstall(page([HEAD, GTAG]), { ...expected, configHash: 'f'.repeat(64) })).toMatchObject({ result: 'fail', message: expect.stringContaining('not the latest generated'), evidence: [`deployed ${r.config.hash.slice(0, 12)}, latest ffffffffffff`] });
    const edited = HEAD.replace('"lifetimeDays":365', '"lifetimeDays":30');
    expect(edited).not.toBe(HEAD);
    expect(verifyInstall(page([edited]), expected).message).toMatch(/edited after generation/);
    expect(verifyInstall(page([HEAD.replace('application/json', 'text/template')]), expected).message).toMatch(/type is "text\/template"/);
    expect(verifyInstall(page([HEAD.replace('{"', '{{"')]), expected).message).toMatch(/not valid JSON/);
  });

  it('fails: the core script is missing, async, defer, a module, or delayed by a performance plugin', () => {
    const cfg = HEAD.split('\n')[0];
    expect(verifyInstall(page([cfg]), expected).message).toMatch(/no <script src="…complykit-consent\.js">/);
    expect(verifyInstall(page([cfg, `<script async src="${SRC}"></script>`]), expected).message).toMatch(/is async/);
    expect(verifyInstall(page([cfg, `<script defer src="${SRC}"></script>`]), expected).message).toMatch(/is defer/);
    expect(verifyInstall(page([cfg, `<script type="module" src="${SRC}"></script>`]), expected).message).toMatch(/is a module/);
    expect(verifyInstall(page([cfg, `<script type="rocketlazyloadscript" data-rocket-src="${SRC}"></script>`]), expected).message).toMatch(/WP Rocket .* delays the core script/);
    expect(verifyInstall(page([cfg, `<script type="text/plain" src="${SRC}"></script>`]), expected).message).toMatch(/does not execute/);
  });

  it('fails when a tag-manager or vendor script runs before the tool; a plain first-party script before it is fine', () => {
    expect(verifyInstall(page([GTM_SNIPPET, HEAD]), expected)).toMatchObject({ result: 'fail', message: expect.stringMatching(/Google Tag Manager \/ gtag\.js \(inline\) \(line 4\) loads before the consent tool/) });
    expect(verifyInstall(page([GTAG, HEAD]), expected).message).toMatch(/Google Tag Manager \/ gtag\.js \(line 4\)/);
    expect(verifyInstall(page([FBQ, HEAD]), expected).message).toMatch(/Meta Pixel \(line 4\) loads before/);
    expect(verifyInstall(page(['<script src="/theme.js"></script>', HEAD, GTAG]), expected).result).toBe('pass');
  });

  it('cannot verify an empty or non-HTML body', () => {
    expect(verifyInstall('', expected).result).toBe('cannot-verify');
    expect(verifyInstall('{"error":"blocked"}', expected).result).toBe('cannot-verify');
  });
});

describe('verifyRewriteTag', () => {
  const spec = { page: PAGE, element: GA_SIG, category: 'analytics' };
  const held = '<script type="text/plain" data-category="analytics" data-src="https://www.googletagmanager.com/gtag/js?id=G-XXXX01" async></script>';

  it('passes once the executable tag is gone and the held twin with the same signature is there', () => {
    const out = verifyRewriteTag(page([HEAD, held]), spec);
    expect(out).toMatchObject({ result: 'pass', evidence: ['line 6'] });
    expect(out.message).toContain('data-category="analytics"');
  });

  it('fails while the original still executes — alone, or next to the rewritten copy (loads twice)', () => {
    expect(verifyRewriteTag(page([GTAG]), spec)).toMatchObject({ result: 'fail', message: expect.stringContaining('still executes'), evidence: ['line 4'] });
    expect(verifyRewriteTag(page([held, GTAG]), spec).message).toMatch(/rewritten copy is there too/);
  });

  it('fails on the wrong category, a missing category, another tool’s hold convention, and a performance plugin’s delay', () => {
    expect(verifyRewriteTag(page([held.replace('analytics', 'advertising')]), spec).message).toMatch(/data-category="advertising", expected "analytics"/);
    expect(verifyRewriteTag(page([held.replace(' data-category="analytics"', '')]), spec).message).toMatch(/no data-category/);
    expect(verifyRewriteTag(page([held.replace('text/plain', 'text/x-consent')]), spec).message).toMatch(/another convention/);
    expect(verifyRewriteTag(page(['<script type="rocketlazyloadscript" data-rocket-src="https://www.googletagmanager.com/gtag/js?id=G-XXXX01"></script>']), spec).message).toMatch(/WP Rocket .* not consent gating/);
  });

  it('cannot verify when no tag with the signature is on the page (removed or moved)', () => {
    expect(verifyRewriteTag(page([HEAD]), spec)).toMatchObject({ result: 'cannot-verify', message: expect.stringContaining('If you removed it on purpose') });
  });

  it('an inline snippet: held in place with the code unchanged passes; held but calling document.write fails', () => {
    const inlineSpec = { page: PAGE, element: INLINE_SIG, category: 'advertising' };
    expect(verifyRewriteTag(page([FBQ]), inlineSpec).result).toBe('fail');
    expect(verifyRewriteTag(page([FBQ.replace('<script>', '<script type="text/plain" data-category="advertising">')]), inlineSpec).result).toBe('pass');
    const writes = FBQ.replace('<script>', '<script type="text/plain" data-category="advertising">').replace('fbq(\'track\'', 'document.write("x");fbq(\'track\'');
    expect(verifyRewriteTag(page([writes]), inlineSpec).message).toMatch(/document\.write/);
  });
});

describe('verifyRemoveLeak', () => {
  const spec = { page: PAGE, element: FB_SIG };
  const NOSCRIPT = '<noscript><img height="1" width="1" src="https://www.facebook.com/tr?id=000000&ev=PageView&noscript=1"></noscript>';

  it('fails while the element is still fetched; passes when it is gone or switched to a held data-src form', () => {
    expect(verifyRemoveLeak(page([], [NOSCRIPT]), spec)).toMatchObject({ result: 'fail', message: expect.stringContaining('line 7 (in <noscript>)') });
    expect(verifyRemoveLeak(page([HEAD], []), spec).result).toBe('pass');
    expect(verifyRemoveLeak(page([], ['<noscript><img data-category="advertising" data-src="https://www.facebook.com/tr?id=000000"></noscript>']), spec)).toMatchObject({ result: 'pass', message: expect.stringContaining('held data-src form') });
  });

  it('an iframe leak in the document', () => {
    const sig: ElementSignature = { kind: 'iframe', context: 'document', host: 'embed.vendor.test', path: '/widget', ids: [] };
    expect(verifyRemoveLeak(page([], ['<iframe src="https://embed.vendor.test/widget?x=1"></iframe>']), { page: PAGE, element: sig }).result).toBe('fail');
    expect(verifyRemoveLeak(page([], ['<iframe data-category="functional" data-src="https://embed.vendor.test/widget"></iframe>']), { page: PAGE, element: sig }).result).toBe('pass');
  });
});

describe('verifyGtmTagConsent', () => {
  const source = fs.readFileSync(path.join(__dirname, 'fixtures/gtm/GTM-XXXX01.js'), 'utf8');
  const spec = { containerId: 'GTM-XXXX01', tagId: 4, consentTypes: ['analytics_storage'] };

  it('fails on the served container without the requirement; passes once the tag carries it (simulated with the local-copy rewrite)', () => {
    expect(verifyGtmTagConsent(source, spec)).toMatchObject({ result: 'fail', message: expect.stringContaining('no consent requirement') });
    const published = rewriteContainerConsent(source, { tags: { '4': ['analytics_storage'] } });
    expect(published.rewritten).toEqual([4]);
    expect(verifyGtmTagConsent(published.source!, spec)).toMatchObject({ result: 'pass', evidence: ['consent: analytics_storage'] });
    expect(verifyGtmTagConsent(published.source!, { ...spec, consentTypes: ['analytics_storage', 'ad_storage'] })).toMatchObject({ result: 'fail', message: expect.stringContaining('but not ad_storage') });
  });

  it('cannot verify an unreadable container or a tag id the served version does not have', () => {
    expect(verifyGtmTagConsent('<!doctype html><html></html>', spec).result).toBe('cannot-verify');
    expect(verifyGtmTagConsent(source, { ...spec, tagId: 99999 })).toMatchObject({ result: 'cannot-verify', message: expect.stringContaining('not in the served version') });
  });
});

describe('verifyConsentDefault', () => {
  const spec = { page: PAGE, consentTypes: ['ad_storage', 'analytics_storage'] };
  const DEFAULT = "<script>window.dataLayer=window.dataLayer||[];function gtag(){dataLayer.push(arguments);}gtag('consent','default',{ad_storage:'denied',analytics_storage:'denied'});</script>";

  it('passes when the installed tool (config.gtm) runs before the first Google script', () => {
    expect(r.config.gtm).toBeDefined();
    const out = verifyConsentDefault(page([HEAD, GTM_SNIPPET]), spec);
    expect(out.result).toBe('pass');
    expect(out.message).toContain('config.gtm lists GTM-XXXX01');
  });

  it('passes on an explicit denied default before the tag; fails when it misses a type, comes after the tag, or is absent', () => {
    expect(verifyConsentDefault(page([DEFAULT, GTAG]), spec).result).toBe('pass');
    expect(verifyConsentDefault(page([DEFAULT.replace("analytics_storage:'denied'", "analytics_storage:'granted'"), GTAG]), spec).message).toMatch(/does not deny analytics_storage/);
    expect(verifyConsentDefault(page([GTAG, DEFAULT]), spec).message).toMatch(/AFTER the first Google script/);
    expect(verifyConsentDefault(page([GTAG]), spec)).toMatchObject({ result: 'fail', message: expect.stringContaining('no denied Consent Mode default') });
  });

  it('a config without a gtm section installed first fails unless its google-consent-mode adapter covers every expected signal', () => {
    const noGtm = withConsentConfigHash({ ...r.config, gtm: undefined, hash: undefined } as never);
    expect(noGtm.gtm).toBeUndefined();
    const out = verifyConsentDefault(page([renderHeadSnippet(noGtm, SRC), GTAG]), spec);
    expect(out.result).toBe('fail');
    expect(out.message).toMatch(noGtm.vendors.some((v) => v.adapter === 'google-consent-mode') ? /but not ad_storage/ : /no gtm section and no vendor on the google-consent-mode adapter/);
    const bare = withConsentConfigHash({ ...r.config, gtm: undefined, hash: undefined, vendors: [], gate: [] } as never);
    expect(verifyConsentDefault(page([renderHeadSnippet(bare, SRC), GTAG]), spec).message).toMatch(/no gtm section and no vendor on the google-consent-mode adapter/);
  });

  it('gtag.js pasted directly (no gtm section): the tool’s google-consent-mode adapter sets the default; a held Google tag still counts as the tag', () => {
    const noGtm = (vendors: typeof r.config.vendors) => withConsentConfigHash({ ...r.config, gtm: undefined, hash: undefined, vendors } as never);
    const ga = { id: 'google.analytics', label: 'Google Analytics 4', category: 'analytics', control: 'api' as const, adapter: 'google-consent-mode', stores: [] };
    const one = { page: PAGE, consentTypes: ['analytics_storage'] };
    const out = verifyConsentDefault(page([renderHeadSnippet(noGtm([ga]), SRC), GTAG]), one);
    expect(out).toMatchObject({ result: 'pass', message: expect.stringContaining('google-consent-mode adapter covers analytics_storage') });
    // The rewrite task's held form: the default still has to come first, and does.
    const held = GTAG.replace(/<script([^>]*) src=/, '<script type="text/plain" data-category="analytics"$1 data-src=');
    expect(held).toContain('data-src=');
    expect(verifyConsentDefault(page([renderHeadSnippet(noGtm([ga]), SRC), held]), one).result).toBe('pass');
    expect(verifyConsentDefault(page([held]), one)).toMatchObject({ result: 'fail', message: expect.stringContaining('no denied Consent Mode default') });
    // An ads signal the adapter's vendors do not cover: fail, naming it.
    expect(verifyConsentDefault(page([renderHeadSnippet(noGtm([ga]), SRC), GTAG]), spec)).toMatchObject({ result: 'fail', message: expect.stringContaining('but not ad_storage') });
  });

  it('cannot verify a page with no Google script', () => {
    expect(verifyConsentDefault(page([HEAD]), spec).result).toBe('cannot-verify');
  });
});

describe('verifyRemoveExistingTool', () => {
  it('an outside tool by host (and by knowledge-base match); a platform plugin by asset path', () => {
    const spec = { page: PAGE, partyId: 'unknown:cmp.test', hosts: ['cmp.test'], label: 'cmp.test' };
    expect(verifyRemoveExistingTool(page(['<script src="https://cdn.cmp.test/banner.js"></script>']), spec)).toMatchObject({ result: 'fail', evidence: ['line 4: https://cdn.cmp.test/banner.js'] });
    expect(verifyRemoveExistingTool(page([`<script>var s=document.createElement('script');s.src='https://cdn.cmp.test/banner.js';document.head.appendChild(s)</script>`]), spec).result).toBe('fail');
    expect(verifyRemoveExistingTool(page([HEAD, GTAG]), spec).result).toBe('pass');
    const plugin = { page: PAGE, pathPattern: '\\/wp-content\\/plugins\\/complianz[^/]*\\/', label: 'complianz' };
    expect(verifyRemoveExistingTool(page(['<script src="https://www.example-shop.test/wp-content/plugins/complianz-gdpr/assets/js/cookiebanner.min.js"></script>']), plugin).result).toBe('fail');
    expect(verifyRemoveExistingTool(page(['<script src="https://www.example-shop.test/wp-content/plugins/other/x.js"></script>']), plugin).result).toBe('pass');
    expect(verifyRemoveExistingTool(page([]), { ...plugin, pathPattern: '(' }).result).toBe('cannot-verify');
  });
});

describe('judgeSpotCheck', () => {
  const spec = { page: PAGE, partyId: 'meta.pixel', hosts: ['facebook.com', 'facebook.net'] };
  const phase = (scenario: 'reject' | 'accept', urls: string[], choiceMade = true): SpotCheckObservation['phases'][number] => ({ scenario, choiceMade, requests: urls.map((url) => ({ url })), stores: [] });

  it('passes only when nothing reached the vendor after the reject AND something did after the accept', () => {
    const out = judgeSpotCheck(spec, { page: PAGE, toolPresent: true, phases: [phase('reject', ['https://www.example-shop.test/a.js']), phase('accept', ['https://connect.facebook.net/en_US/fbevents.js', 'https://www.facebook.com/tr?id=1'])] });
    expect(out).toMatchObject({ result: 'pass', evidence: ['https://connect.facebook.net/en_US/fbevents.js', 'https://www.facebook.com/tr?id=1'] });
  });

  it('fails on any request to the vendor’s hosts after the reject (subdomains included)', () => {
    const out = judgeSpotCheck(spec, { page: PAGE, phases: [phase('reject', ['https://connect.facebook.net/en_US/fbevents.js']), phase('accept', ['https://www.facebook.com/tr'])] });
    expect(out).toMatchObject({ result: 'fail', evidence: ['https://connect.facebook.net/en_US/fbevents.js'] });
  });

  it('cannot verify: tool absent, reject not made, accept missing, or the vendor gone from the page', () => {
    expect(judgeSpotCheck(spec, { page: PAGE, toolPresent: false, phases: [] }).message).toMatch(/not on the page/);
    expect(judgeSpotCheck(spec, { page: PAGE, phases: [phase('reject', [], false)] }).result).toBe('cannot-verify');
    expect(judgeSpotCheck(spec, { page: PAGE, phases: [phase('reject', [])] }).message).toMatch(/accept visit was not made/);
    expect(judgeSpotCheck(spec, { page: PAGE, phases: [phase('reject', []), phase('accept', ['https://www.example-shop.test/'])] }).message).toMatch(/not on this page any more/);
  });
});

describe('runVerify', () => {
  it('dispatches by check and refuses what it was not given', () => {
    const install = r.tasks.find((t) => t.kind === 'install')!.verify;
    expect(runVerify(install, { html: page([HEAD, GTAG]) }).result).toBe('pass');
    expect(runVerify(install, {}).result).toBe('cannot-verify');
    const gtm = r.tasks.find((t) => t.verify.check === 'gtm-tag-consent')!.verify;
    expect(runVerify(gtm, { html: '<html></html>' }).message).toMatch(/container was not fetched/);
    const spot = r.tasks.find((t) => t.verify.check === 'spot-check')!.verify;
    expect(runVerify(spot, { html: '<html></html>' }).message).toMatch(/browser spot check is needed/);
    const manual = r.tasks.find((t) => t.verify.check === 'manual')!.verify;
    expect(runVerify(manual, { html: '<html></html>' })).toMatchObject({ result: 'cannot-verify', message: expect.stringContaining('cannot be checked from outside') });
  });
});
