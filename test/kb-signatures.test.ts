import { describe, it, expect } from 'vitest';
import { inspectMarkup } from '../src/record/index.js';
import { matchMarkupElement } from '../src/rules/tracking/index.js';
import { DEFAULT_KB, entriesForText, inlineRegExp, matchVendorSignatures } from '../src/registry/index.js';

// One source of install signatures: KB entries' `match.inline`. The markup
// inspector (A1) and the GTM container parser (A2) both read it, so a snippet
// must resolve to the same entry through either. No network.

const site = { registrableDomain: 'example-shop.test' };
const ids = new Set(DEFAULT_KB.entries.map((e) => e.id));

// Generic install snippets (public shapes, no site data), keyed by KB entry id.
const SNIPPETS: Record<string, string> = {
  'meta.pixel': "!function(f,b,e,v,n,t,s){}(window,document,'script','https://connect.facebook.net/en_US/fbevents.js');fbq('init','1');",
  'tiktok.pixel': 'ttq.load("ABC");ttq.page();',
  'microsoft.uet': '(function(w,d,t,r,u){})(window,document,"script","//bat.bing.com/bat.js","uetq");',
  'microsoft.clarity': '(function(c,l,a,r,i,t,y){})(window, document, "clarity", "script", "abc");',
  'linkedin.insight': '_linkedin_partner_id = "1"; window._linkedin_data_partner_ids = [];',
  'pinterest.tag': "pintrk('load', '1'); pintrk('page');",
  'snap.pixel': "snaptr('init', 'abc'); snaptr('track', 'PAGE_VIEW');",
  'reddit.pixel': "rdt('init','t2_abc');",
  'x.pixel': "twq('config','abc');",
  hotjar: 'window._hjSettings={hjid:1,hjsv:6};',
  fullstory: "window['_fs_org'] = 'ABC';",
  mouseflow: 'window._mfq = window._mfq || [];',
  klaviyo: "var _learnq = _learnq || []; _learnq.push(['account', 'abc']);",
  hubspot: 'var _hsq = window._hsq = window._hsq || [];',
  intercom: 'window.intercomSettings = {app_id: "abc"};',
  sentry: "Sentry.init({ dsn: 'https://abc@o1.ingest.sentry.io/1' });",
  'consent.onetrust': 'function OptanonWrapper() {}',
  'google.analytics': "gtag('config', 'G-ABC123');",
  'google.ads.ccm': "gtag('config', 'AW-123456');",
};

function a1(snippet: string): string[] {
  const html = `<html><body><script>${snippet}</script></body></html>`;
  const el = inspectMarkup(html, 'https://www.example-shop.test/', 0, 'navigation').elements.filter((e) => !e.url);
  return el.flatMap((e) => matchMarkupElement(e, DEFAULT_KB, site).map((m) => m.partyId));
}

describe('KB inline signatures', () => {
  it('every match.inline pattern compiles', () => {
    for (const e of DEFAULT_KB.entries) for (const src of e.match.inline ?? []) expect(inlineRegExp(src), `${e.id}: ${src}`).not.toBeNull();
  });

  it('every snippet fixture names an entry that exists, and that entry matches it', () => {
    for (const [id, snippet] of Object.entries(SNIPPETS)) {
      expect(ids.has(id), `${id} is not a KB entry`).toBe(true);
      expect(matchVendorSignatures(snippet), id).toContain(id);
    }
  });

  it('the markup inspector (A1) and the GTM parser (A2) resolve a snippet to the same entry', () => {
    for (const [id, snippet] of Object.entries(SNIPPETS)) {
      const viaA2 = entriesForText(DEFAULT_KB, snippet)[0]?.id;
      const viaA1 = a1(snippet);
      expect(viaA1, `${id}: A1 found nothing`).toContain(viaA2);
      expect(viaA2, id).toBe(id);
    }
  });

  it('a vendor snippet is named before the Google ids it also carries', () => {
    expect(entriesForText(DEFAULT_KB, `gtag('config','G-ABC123');${SNIPPETS['meta.pixel']}`)[0].id).toBe('meta.pixel');
  });
});
