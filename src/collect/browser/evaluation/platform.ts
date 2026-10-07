import type { Page } from 'playwright';
import type { PlatformSignals } from '../../../record/index.js';
import { withTimeout } from './capture.js';

// Platform fingerprint signals — collection only. Whether these add up to
// "Shopify" or "WordPress + Complianz" is decided by the pure classifier in
// registry/platform.ts (the collector may not import it: collect → record only).
// We read NAMES of probed globals and asset URLs without query strings, never values.

/** Dotted globals worth probing. Keep in step with registry/platform.ts. */
const PROBES = [
  'Shopify',
  'Shopify.customerPrivacy',
  'wixBiSession',
  'wixPerformanceMeasurements',
  'wixEmbedsAPI',
  'Static.SQUARESPACE_CONTEXT',
  'SQUARESPACE_ROLLUPS',
  'wp',
  'wpApiSettings',
  'wp_has_consent',
  'wp_consent_type',
  'complianz',
  'cmplz_banner',
  'ckySettings',
  'getCkyConsent',
  'CookieYes',
  'cnArgs',
  'BorlabsCookie',
  'moove_frontend_gdpr_scripts',
];

const READ = `(() => {
  const probes = ${JSON.stringify(PROBES)};
  const has = (path) => {
    let o = window;
    for (const k of path.split('.')) {
      try { if (o == null || !(k in Object(o))) return false; o = o[k]; } catch { return false; }
    }
    return o !== undefined;
  };
  const strip = (u) => { try { const x = new URL(u, location.href); return x.origin + x.pathname; } catch { return ''; } };
  const urls = [];
  for (const el of document.querySelectorAll('script[src], link[href]')) {
    const u = strip(el.getAttribute('src') || el.getAttribute('href') || '');
    if (u && !urls.includes(u)) urls.push(u);
    if (urls.length >= 400) break;
  }
  let templateVersion;
  try { templateVersion = String(window.Static.SQUARESPACE_CONTEXT.templateVersion || '') || undefined; } catch {}
  const gen = document.querySelector('meta[name="generator"]');
  return {
    globals: probes.filter(has),
    generator: gen ? (gen.getAttribute('content') || '').slice(0, 80) || undefined : undefined,
    assetUrls: urls,
    templateVersion,
  };
})()`;

/** Union of the signals across the given pages; undefined when no page could be read. */
export async function collectPlatformSignals(pages: Page[]): Promise<PlatformSignals | undefined> {
  let out: PlatformSignals | undefined;
  for (const page of pages) {
    if (page.isClosed()) continue;
    const s = await withTimeout(page.evaluate(READ).catch(() => undefined) as Promise<PlatformSignals | undefined>, 3000, undefined);
    if (!s) continue;
    if (!out) {
      out = { globals: [], assetUrls: [] };
    }
    for (const g of s.globals) if (!out.globals.includes(g)) out.globals.push(g);
    for (const u of s.assetUrls) if (!out.assetUrls.includes(u) && out.assetUrls.length < 600) out.assetUrls.push(u);
    out.generator ??= s.generator;
    out.templateVersion ??= s.templateVersion;
  }
  return out;
}
