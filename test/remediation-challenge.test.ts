import { describe, it, expect } from 'vitest';
import { detectBotChallenge } from '../src/rules/remediation/challenge.js';

// Bot-challenge detection for Verify (R4 follow-up): a challenge page answered
// instead of the site's page must never reach a checker. Generic, synthetic
// markup per vendor; the vendors' everyday markers (present on normal pages
// behind them) must NOT count.

const page = (head: string, body = ''): string => `<!doctype html><html><head>${head}</head><body>${body}</body></html>`;

describe('detectBotChallenge', () => {
  it('Cloudflare: the cf-mitigated header, the interstitial title, the challenge options, the challenge platform path', () => {
    expect(detectBotChallenge(page('<title>x</title>'), { 'CF-Mitigated': 'challenge' }, 403)).toEqual({ vendor: 'Cloudflare', marker: 'cf-mitigated: challenge' });
    expect(detectBotChallenge(page('<title>Just a moment...</title>'))).toMatchObject({ vendor: 'Cloudflare', marker: '<title>Just a moment...</title>' });
    expect(detectBotChallenge(page('<title>x</title>', '<script>window._cf_chl_opt={cvId:"3"};</script>'))).toMatchObject({ vendor: 'Cloudflare', marker: '_cf_chl_opt' });
    expect(detectBotChallenge(page('<title>x</title>', '<script src="/cdn-cgi/challenge-platform/h/b/orchestrate/chl_page/v1?ray=0"></script>'))).toMatchObject({ vendor: 'Cloudflare', marker: expect.stringMatching(/^\/cdn-cgi\/challenge-platform\/h\/b\/orchestrate/) });
    expect(detectBotChallenge(page('<title>Attention Required! | Cloudflare</title>'))).toMatchObject({ vendor: 'Cloudflare' });
  });

  it('Akamai, PerimeterX, DataDome, Sucuri, Imperva block / challenge pages', () => {
    expect(detectBotChallenge(page('<title>x</title>', '<div id="sec-if-cpt-container"></div><script src="/_sec/cp_challenge/sec-4-4.js"></script>'))).toMatchObject({ vendor: 'Akamai' });
    expect(detectBotChallenge(page('<title>Access to this page has been denied</title>', '<div id="px-captcha"></div>'))).toMatchObject({ vendor: 'PerimeterX (HUMAN)', marker: 'px-captcha' });
    expect(detectBotChallenge(page('<title>x</title>', "<script>var dd={'host':'geo.captcha-delivery.com'}</script>"))).toMatchObject({ vendor: 'DataDome', marker: 'geo.captcha-delivery.com' });
    expect(detectBotChallenge(page('<title>x</title>'), { 'x-datadome': 'protected' }, 403)).toMatchObject({ vendor: 'DataDome' });
    expect(detectBotChallenge(page('<title>Sucuri WebSite Firewall - Access Denied</title>'))).toMatchObject({ vendor: 'Sucuri' });
    expect(detectBotChallenge(page('<title>x</title>', '<script>var s="sucuri_cloudproxy_js=";</script>'))).toMatchObject({ vendor: 'Sucuri' });
    expect(detectBotChallenge(page('<title>x</title>', '<iframe src="/_Incapsula_Resource?CWUDNSAI=1"></iframe>'))).toMatchObject({ vendor: 'Imperva (Incapsula)' });
  });

  it('a normal page behind those vendors is not a challenge', () => {
    // Cloudflare's JS detections script is on every page of a protected site.
    const normal = page('<title>Shop</title><script src="/cdn-cgi/challenge-platform/scripts/jsd/main.js"></script>', '<h1>Welcome</h1>');
    expect(detectBotChallenge(normal, { 'cf-ray': '0-IAD', server: 'cloudflare' }, 200)).toBeUndefined();
    // DataDome / Sucuri / Imperva headers on a normal 200.
    expect(detectBotChallenge(page('<title>Shop</title>'), { 'x-datadome': 'protected', 'x-sucuri-id': '1', 'x-iinfo': '1' }, 200)).toBeUndefined();
    expect(detectBotChallenge(page('<title>Just a moment of your time</title>'))).toBeUndefined();
    expect(detectBotChallenge('')).toBeUndefined();
  });

  it('a long marker is clipped for the evidence', () => {
    const long = `/cdn-cgi/challenge-platform/h/b/${'a'.repeat(200)}`;
    expect(detectBotChallenge(page('<title>x</title>', `<script src="${long}"></script>`))!.marker).toHaveLength(81);
  });
});
