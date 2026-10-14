import { describe, it, expect } from 'vitest';
import { siteAssetMirrors } from '../src/rules/tracking/analyze.js';

// A CDN that serves the site's own WordPress files is the site, not a third party
// (blackstaramps.com, 2026-10-10: its consent plugin's script on an nxedge.io edge was
// listed as an unknown advertiser to gate). Proof is strict; anything less stays unknown.

const own = 'https://shop.example/wp-content/themes/shoptheme/css/fonts/a.woff2';
const cdn = (p: string) => `https://edge-1.cdn.test${p}`;

describe('siteAssetMirrors', () => {
  it('a host serving only WordPress paths, including the theme the site itself serves, is the site’s mirror', () => {
    const urls = [own, cdn('/wp-content/themes/shoptheme/js/app.js'), cdn('/wp-content/plugins/webtoffee-cookie-consent/lite/frontend/js/script.min.js?ver=3.5.5'), cdn('/wp-includes/js/jquery.js'), cdn('/wp-content/uploads/2024/01/x.jpg')];
    expect([...siteAssetMirrors(urls, 'shop.example')]).toEqual(['edge-1.cdn.test']);
  });

  it('stays unknown: another site’s theme, plugin or upload paths only, any non-WordPress path, or no own theme to compare', () => {
    expect(siteAssetMirrors([own, cdn('/wp-content/themes/othertheme/app.js')], 'shop.example').size).toBe(0);
    expect(siteAssetMirrors([own, cdn('/wp-content/plugins/woocommerce/a.js'), cdn('/wp-content/uploads/a.jpg')], 'shop.example').size).toBe(0);
    expect(siteAssetMirrors([own, cdn('/wp-content/themes/shoptheme/app.js'), cdn('/collect?id=1')], 'shop.example').size).toBe(0);
    expect(siteAssetMirrors([cdn('/wp-content/themes/shoptheme/app.js')], 'shop.example').size).toBe(0);
  });

  it('the site’s own subdomains are never listed (they are first party already)', () => {
    expect(siteAssetMirrors([own, 'https://static.shop.example/wp-content/themes/shoptheme/a.js'], 'shop.example').size).toBe(0);
  });
});
