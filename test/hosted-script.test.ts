import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect } from 'vitest';
import { generateConsentConfig } from '../src/consent-generator.js';
import { buildRemediationTasks, renderHeadSnippet } from '../src/remediation.js';
import { verifyInstall, verifyConsentDefault, runVerify } from '../src/rules/remediation/verify.js';
import { HOSTED_CONFIG_PREFIX, hostedScriptPath, parseHostedScript, CONSENT_CONFIG_ELEMENT_ID, RemediationVerifySpec, type RemediationTask } from '../src/record/index.js';
import { compatibilityEvaluation, PAGE } from './fixtures/compatibility-report.js';

// Contract tests for the hosted consent script (plans/hosted-script.md, T1a).
// The service serves one file per site at /s/<domain>.js whose line 2 is
// `window.ComplyKitConfig=<json>;`. The generator, with `hostedScriptUrl`, writes
// a one-line snippet and a hosted install task; Verify checks the page AND the
// fetched hosted script. Self-hosting (no hostedScriptUrl) is unchanged.

const NOW = '2026-10-06T12:00:00.000Z';
const URL_ = 'https://ck.example-host.test/s/example-shop.test.js';
const ONE_LINE = `<script src="${URL_}" referrerpolicy="no-referrer"></script>`;
const ev = compatibilityEvaluation();
const self = generateConsentConfig(ev, { complykitVersion: '0.0.0-test', now: NOW });
const hosted = generateConsentConfig(ev, { complykitVersion: '0.0.0-test', now: NOW, hostedScriptUrl: URL_ });
const hostedBody = (config: unknown = hosted.config) => `/*! complykit 0.0.0-test | example-shop.test | config abcdef012345 */\n${HOSTED_CONFIG_PREFIX}${JSON.stringify(config)};\n!function(){window.ComplyKit={}}();\n`;
const SERVED = { status: 200, text: hostedBody() };

const GTM_SNIPPET = `<script>(function(w,d,s,l,i){w[l]=w[l]||[];w[l].push({'gtm.start':new Date().getTime(),event:'gtm.js'});var f=d.getElementsByTagName(s)[0],j=d.createElement(s);j.async=true;j.src='https://www.googletagmanager.com/gtm.js?id='+i;f.parentNode.insertBefore(j,f);})(window,document,'script','dataLayer','GTM-XXXX01');</script>`;
const GTAG = '<script async src="https://www.googletagmanager.com/gtag/js?id=G-XXXX01"></script>';
const page = (head: string[]): string => `<!doctype html>\n<html><head>\n<meta charset="utf-8">\n${head.join('\n')}\n<title>x</title>\n</head><body>\n</body></html>`;

describe('hosted script format helpers', () => {
  it('path is /s/<domain>.js', () => {
    expect(hostedScriptPath('example-shop.test')).toBe('/s/example-shop.test.js');
  });

  it('parseHostedScript reads line 2 only, and only the exact config line', () => {
    expect(parseHostedScript(hostedBody({ a: 1 }))).toEqual({ a: 1 });
    expect(parseHostedScript(`${HOSTED_CONFIG_PREFIX}{"a":1};\n`)).toBeUndefined(); // line 1
    expect(parseHostedScript(`/* x */\n${HOSTED_CONFIG_PREFIX}{"a":1}\n`)).toBeUndefined(); // no ;
    expect(parseHostedScript(`/* x */\n${HOSTED_CONFIG_PREFIX}{a:1};\n`)).toBeUndefined(); // not JSON
    expect(parseHostedScript(`/* x */\nwindow.Other={"a":1};\n`)).toBeUndefined();
    expect(parseHostedScript('')).toBeUndefined();
  });
});

describe('generator with hostedScriptUrl', () => {
  it('Part 1 of the snippet is the one line: no inline config, no self-hosted path', () => {
    expect(hosted.snippet).toContain(ONE_LINE);
    expect(hosted.snippet).not.toContain(`id="${CONSENT_CONFIG_ELEMENT_ID}"`);
    expect(hosted.snippet).not.toMatch(/complykit-consent\.js/);
    expect(hosted.snippet).not.toMatch(/PLACEHOLDER/);
  });

  it('reports the hosted URL and a hosted note instead of the script-path placeholder note', () => {
    expect(hosted.hostedScriptUrl).toBe(URL_);
    const codes = hosted.notes.map((n) => n.code);
    expect(codes).toContain('hosted');
    expect(codes).not.toContain('script-path');
  });

  it('the config is still generated, parses and keeps its hash (the host serves it)', () => {
    expect(hosted.config.hash).toMatch(/^[0-9a-f]{64}$/);
    // Same scan, same options otherwise: the config itself does not depend on hosting.
    expect({ ...hosted.config, hash: undefined, generatedFrom: undefined }).toEqual({ ...self.config, hash: undefined, generatedFrom: undefined });
  });

  it('self-hosting is unchanged without the option', () => {
    expect(self.snippet).toContain(`id="${CONSENT_CONFIG_ELEMENT_ID}"`);
    expect(self.hostedScriptUrl).toBeUndefined();
  });
});

describe('the hosted install task', () => {
  const tasks = buildRemediationTasks(hosted, ev);
  const install = tasks.find((t) => t.kind === 'install') as RemediationTask;

  it('verifies in hosted mode against the hosted URL', () => {
    expect(install.verify).toEqual({ check: 'install', method: 'static', mode: 'hosted', page: PAGE, scriptSrc: URL_ });
    expect(RemediationVerifySpec.parse(install.verify)).toEqual(install.verify);
  });

  it('the paste is the one line; the steps say first in <head>, blocking, remove old lines — never upload files or a zip', () => {
    expect(install.snippet?.after).toBe(ONE_LINE);
    const steps = [...install.steps, ...(install.stepVariants ?? []).flatMap((v) => [v.service, v.offline])].join('\n');
    expect(steps).toMatch(/first/i);
    expect(steps).toMatch(/<head>/);
    expect(steps).toMatch(/async|defer|block/i);
    expect(steps).toMatch(/complykit-config|old|earlier/i);
    expect(steps).not.toMatch(/upload|\.zip|install bundle|third-party CDN/i);
  });

  it('consent-default tasks carry the hosted URL', () => {
    for (const t of tasks.filter((x) => x.verify?.check === 'consent-default')) expect(t.verify).toMatchObject({ scriptSrc: URL_ });
  });

  it('self mode keeps its spec (with mode self)', () => {
    const s = buildRemediationTasks(self, ev).find((t) => t.kind === 'install')!;
    expect(s.verify).toMatchObject({ check: 'install', mode: 'self', configHash: self.config.hash, elementId: CONSENT_CONFIG_ELEMENT_ID });
  });

  it('a stored spec without mode parses as self', () => {
    expect(RemediationVerifySpec.parse({ check: 'install', method: 'static', page: PAGE, configHash: 'x', scriptSrc: '/a.js', elementId: 'complykit-config' })).toMatchObject({ mode: 'self' });
  });
});

describe('verifyInstall, hosted mode', () => {
  const spec = { page: PAGE, mode: 'hosted' as const, scriptSrc: URL_ };

  it('passes: the one line first, blocking, before GTM; the hosted script serves a readable config', () => {
    const out = verifyInstall(page([ONE_LINE, GTM_SNIPPET, GTAG]), spec, {}, SERVED);
    expect(out.result).toBe('pass');
  });

  it('matches on origin + path: a query string on the tag is fine', () => {
    expect(verifyInstall(page([ONE_LINE.replace('.js"', '.js?v=2"'), GTAG]), spec, {}, SERVED).result).toBe('pass');
  });

  it('a tag whose src carries a username and password does not count: browsers refuse to load it', () => {
    const withUserinfo = ONE_LINE.replace('https://', 'https://user:pass@');
    expect(verifyInstall(page([withUserinfo, GTAG]), spec, {}, SERVED).result).toBe('fail');
  });

  it('fails when the tag is missing, or points at another site’s file', () => {
    expect(verifyInstall(page([GTAG]), spec, {}, SERVED)).toMatchObject({ result: 'fail', message: expect.stringContaining(URL_) });
    expect(verifyInstall(page([ONE_LINE.replace('example-shop.test.js', 'other.test.js')]), spec, {}, SERVED).result).toBe('fail');
  });

  it('fails when it does not block', () => {
    for (const attr of ['async', 'defer', 'type="module"']) {
      expect(verifyInstall(page([ONE_LINE.replace('<script ', `<script ${attr} `)]), spec, {}, SERVED), attr).toMatchObject({ result: 'fail', message: expect.stringMatching(/block/) });
    }
  });

  it('fails when a tag loads before it', () => {
    expect(verifyInstall(page([GTAG, ONE_LINE]), spec, {}, SERVED)).toMatchObject({ result: 'fail', message: expect.stringMatching(/before/) });
  });

  it('fails when the old self-hosted install is still there too (two copies)', () => {
    const old = renderHeadSnippet(self.config, self.scriptSrc);
    expect(verifyInstall(page([ONE_LINE, old]), spec, {}, SERVED)).toMatchObject({ result: 'fail', message: expect.stringMatching(/two copies/) });
    expect(verifyInstall(page([ONE_LINE, '<script src="/assets/complykit-consent.js"></script>']), spec, {}, SERVED)).toMatchObject({ result: 'fail', message: expect.stringMatching(/two copies/) });
  });

  it('fails when the hosted script does not serve a config; unknown when it was not fetched', () => {
    const html = page([ONE_LINE]);
    expect(verifyInstall(html, spec, {}, { status: 404, text: '/* complykit: no consent config */' })).toMatchObject({ result: 'fail', message: expect.stringMatching(/hosted script/i) });
    expect(verifyInstall(html, spec, {}, { status: 200, text: 'console.log(1)' })).toMatchObject({ result: 'fail', message: expect.stringMatching(/hosted script/i) });
    expect(verifyInstall(html, spec, {}).result).toBe('cannot-verify');
  });

  it('a missing referrerpolicy still passes, with a line saying to add it', () => {
    const out = verifyInstall(page([`<script src="${URL_}"></script>`]), spec, {}, SERVED);
    expect(out.result).toBe('pass');
    expect(out.evidence.join('\n')).toMatch(/referrerpolicy/);
  });

  it('runVerify passes the fetched hosted script through', () => {
    const s = { check: 'install', method: 'static', mode: 'hosted', page: PAGE, scriptSrc: URL_ } as const;
    expect(runVerify(s, { html: page([ONE_LINE]), hostedScript: SERVED }).result).toBe('pass');
    expect(runVerify(s, { html: page([ONE_LINE]) }).result).toBe('cannot-verify');
  });

  it('a self-mode spec without a config hash fails (regenerate)', () => {
    expect(verifyInstall(page([renderHeadSnippet(self.config, self.scriptSrc)]), { page: PAGE, scriptSrc: self.scriptSrc })).toMatchObject({ result: 'fail', message: expect.stringMatching(/config hash/) });
  });
});

describe('verifyConsentDefault, hosted mode', () => {
  const spec = { page: PAGE, consentTypes: ['ad_storage', 'analytics_storage'], scriptSrc: URL_ };

  it('the hosted core counts as the installed tool; its config (read from the hosted script) supplies config.gtm', () => {
    expect(hosted.config.gtm).toBeDefined();
    const out = verifyConsentDefault(page([ONE_LINE, GTM_SNIPPET]), spec, SERVED);
    expect(out.result).toBe('pass');
    expect(out.message).toContain('config.gtm lists GTM-XXXX01');
  });

  it('fails when the hosted core comes after Google, or the hosted script has no config', () => {
    expect(verifyConsentDefault(page([GTM_SNIPPET, ONE_LINE]), spec, SERVED).result).toBe('fail');
    expect(verifyConsentDefault(page([ONE_LINE, GTM_SNIPPET]), spec, { status: 404 }).result).not.toBe('pass');
  });

  it('runVerify passes it through', () => {
    const s = { check: 'consent-default', method: 'static', ...spec } as const;
    expect(runVerify(s, { html: page([ONE_LINE, GTM_SNIPPET]), hostedScript: SERVED }).result).toBe('pass');
  });
});

describe('the static report has no install bundle', () => {
  it('no zip link and no install.zip URL in the remediation section source', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'report', 'consent-remediation.ts'), 'utf8');
    expect(src).not.toMatch(/install\.zip|\.zip\b/);
  });
});

describe('add-on mode in the generated install (plans/hosted-script.md "Add-on mode")', () => {
  const withTool = (partyId: string) => {
    const e = compatibilityEvaluation();
    e.inventory.push({ ...e.inventory[1], partyId, label: partyId, domain: 'cmp.test', hosts: ['cdn.cmp.test'], recognized: true, categories: ['consent'], implementation: { class: 'direct-script', evidence: [], alsoSeen: [] } });
    return e;
  };

  it('detectedCmp names the scan’s existing banner', () => {
    const cases: Record<string, string> = { 'consent.onetrust': 'onetrust', 'consent.cookiebot': 'cookiebot', 'consent.usercentrics': 'usercentrics', 'consent.didomi': 'didomi', 'consent.trustarc': 'trustarc' };
    for (const [party, cmp] of Object.entries(cases)) {
      expect(generateConsentConfig(withTool(party), { complykitVersion: '0.0.0-test', now: NOW, hostedScriptUrl: URL_ }).detectedCmp, party).toBe(cmp);
    }
    const shop = compatibilityEvaluation();
    shop.platform = { name: 'shopify', consentPlugin: 'shopify-customer-privacy', evidence: ['window.Shopify'] };
    expect(generateConsentConfig(shop, { complykitVersion: '0.0.0-test', now: NOW }).detectedCmp).toBe('shopify');
    expect(generateConsentConfig(withTool('unknown:cmp.test'), { complykitVersion: '0.0.0-test', now: NOW }).detectedCmp).toBeUndefined();
    expect(hosted.detectedCmp).toBeUndefined();
  });

  it('the hosted install task carries the add-on steps as companionSteps', () => {
    const install = buildRemediationTasks(hosted, ev).find((t) => t.kind === 'install')!;
    const steps = (install.companionSteps ?? []).join('\n');
    expect(steps).toMatch(/keep/i);
    expect(steps).toMatch(/async/i);
    expect(steps).not.toMatch(/upload|\.zip/i);
  });

  it('Verify: a companion config need not be first or blocking — present, one copy, serving', () => {
    const companion = { ...hosted.config, mode: 'companion', companion: { cmp: 'onetrust' } };
    const served = { status: 200, text: hostedBody(companion) };
    const spec = { page: PAGE, mode: 'hosted' as const, scriptSrc: URL_ };
    expect(verifyInstall(page([GTAG, ONE_LINE.replace('<script ', '<script async ')]), spec, {}, served).result).toBe('pass');
    expect(verifyInstall(page([GTAG]), spec, {}, served).result).toBe('fail');
  });
});
