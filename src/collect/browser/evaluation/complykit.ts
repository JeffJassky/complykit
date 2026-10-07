import type { Page } from 'playwright';
import { ComplykitToolSnapshot } from '../../../record/index.js';

// complykit's OWN consent tool on a page (ticket D10): read what it exposes,
// and drive it by its exact, documented hooks — never by text heuristics.
// Hooks are the stable ones from client/src/ui/index.ts's header:
//
//   #complykit-ui .ck-banner .ck-btn[data-ck-action=accept|reject|manage]
//   #complykit-ui .ck-settings[open] .ck-btn[data-ck-action=accept|reject|save|close]
//   #complykit-ui .ck-settings .ck-toggle[data-ck-category=<id>]
//   #complykit-ui .ck-choices          the persistent Privacy choices control
//   [data-complykit-open]              a site element that opens the settings
//   window.ComplyKit { version, get(), on(), open(), withdraw(), diagnostics }
//   <script type="application/json" id="complykit-config">
//
// Real clicks are preferred for the UI path (what a visitor does); the API is
// the fallback and the method string says which was used. Readouts are
// facts only; the rule (rules/tracking/consent-tool-proof.ts) decides.

export const CK = {
  root: '#complykit-ui',
  banner: '#complykit-ui .ck-banner',
  accept: '#complykit-ui .ck-banner .ck-btn[data-ck-action="accept"]',
  reject: '#complykit-ui .ck-banner .ck-btn[data-ck-action="reject"]',
  manage: '#complykit-ui .ck-banner .ck-btn[data-ck-action="manage"]',
  settings: '#complykit-ui .ck-settings',
  settingsOpen: '#complykit-ui .ck-settings[open]',
  settingsReject: '#complykit-ui .ck-settings[open] .ck-btn[data-ck-action="reject"]',
  settingsSave: '#complykit-ui .ck-settings[open] .ck-btn[data-ck-action="save"]',
  toggle: '#complykit-ui .ck-settings[open] .ck-toggle',
  choices: '#complykit-ui .ck-choices',
  open: '[data-complykit-open]',
  config: 'script#complykit-config[type="application/json"]',
} as const;

const CONFIG_TEXT_LIMIT = 65536;

/** What the page exposes about the tool, before any interaction. undefined when the page could not be read. */
export async function readComplykit(page: Page): Promise<ComplykitToolSnapshot | undefined> {
  try {
    const raw = await page.evaluate(
      ({ sel, limit }) => {
        /* eslint-disable @typescript-eslint/no-explicit-any */
        const w = window as unknown as Record<string, any>;
        const ck = w.ComplyKit;
        const el = document.querySelector(sel.config);
        const clone = (v: unknown): unknown => {
          try {
            return JSON.parse(JSON.stringify(v));
          } catch {
            return undefined;
          }
        };
        let state: Record<string, unknown> | undefined;
        let running = false;
        try {
          const s = typeof ck?.get === 'function' ? ck.get() : null;
          if (s && typeof s === 'object') {
            running = true;
            // Visitor id and timestamp dropped: the record is about the tool, not the visitor.
            state = { status: s.status, regime: s.regime, gpc: Boolean(s.gpc), categories: clone(s.categories) ?? {}, ...(typeof s.configHash === 'string' ? { configHash: s.configHash } : {}) };
          }
        } catch {
          /* a throwing get() is "not running" */
        }
        const visible = (e: Element | null): boolean => {
          if (!e) return false;
          const r = (e as HTMLElement).getBoundingClientRect();
          const cs = getComputedStyle(e as HTMLElement);
          return r.width > 1 && r.height > 1 && !(e as HTMLElement).hidden && cs.display !== 'none' && cs.visibility !== 'hidden';
        };
        const held = Array.from(document.querySelectorAll<HTMLScriptElement>('script[type="text/plain"]')).filter((s) => (s.hasAttribute('data-category') || s.hasAttribute('data-ck-category')) && !s.hasAttribute('data-ck-released'));
        const heldCategories = [...new Set(held.map((s) => s.getAttribute('data-category') ?? s.getAttribute('data-ck-category') ?? ''))].filter(Boolean);
        return {
          global: Boolean(ck),
          version: typeof ck?.version === 'string' ? ck.version : undefined,
          configElement: Boolean(el),
          configJson: el?.textContent ? el.textContent.slice(0, limit) : undefined,
          cookiePresent: /(?:^|;\s*)complykit_consent=/.test(document.cookie),
          running,
          state,
          diagnostics: ck?.diagnostics ? clone(ck.diagnostics) : undefined,
          gate: { released: document.querySelectorAll('[data-ck-released]').length, held: held.length, heldCategories },
          bannerShown: visible(document.querySelector(sel.banner)),
          reopenControl: visible(document.querySelector(sel.choices)) || Boolean(document.querySelector(sel.open)),
        };
        /* eslint-enable @typescript-eslint/no-explicit-any */
      },
      { sel: CK, limit: CONFIG_TEXT_LIMIT },
    );
    const present = raw.global || raw.configElement || raw.cookiePresent;
    const parsed = ComplykitToolSnapshot.safeParse({ ...raw, present });
    if (parsed.success) return parsed.data;
    // Diagnostics the schema does not know must not lose the detection itself.
    const again = ComplykitToolSnapshot.safeParse({ ...raw, present, diagnostics: undefined });
    return again.success ? again.data : undefined;
  } catch {
    return undefined;
  }
}

/** Is the tool running on this page (store started)? */
export async function complykitRunning(page: Page): Promise<boolean> {
  return page
    .evaluate(() => {
      const ck = (window as unknown as { ComplyKit?: { get?: () => unknown } }).ComplyKit;
      try {
        return typeof ck?.get === 'function' && ck.get() !== null;
      } catch {
        return false;
      }
    })
    .catch(() => false);
}

const click = async (page: Page, sel: string, timeout = 5000): Promise<boolean> => page.click(sel, { timeout }).then(() => true).catch(() => false);

/**
 * Reopen the settings layer after a choice: the Privacy choices control (a real
 * click), else a site element marked data-complykit-open, else ComplyKit.open().
 */
export async function complykitReopen(page: Page): Promise<{ ok: boolean; method: string }> {
  if (await click(page, CK.choices, 3000)) {
    if (await page.waitForSelector(CK.settingsOpen, { timeout: 4000 }).then(() => true).catch(() => false)) return { ok: true, method: 'complykit:click(.ck-choices)' };
  }
  if (await click(page, CK.open, 3000)) {
    if (await page.waitForSelector(CK.settingsOpen, { timeout: 4000 }).then(() => true).catch(() => false)) return { ok: true, method: 'complykit:click([data-complykit-open])' };
  }
  const viaApi = await page
    .evaluate(() => {
      const ck = (window as unknown as { ComplyKit?: { open?: () => void } }).ComplyKit;
      if (typeof ck?.open !== 'function') return false;
      ck.open();
      return true;
    })
    .catch(() => false);
  if (viaApi && (await page.waitForSelector(CK.settingsOpen, { timeout: 4000 }).then(() => true).catch(() => false))) return { ok: true, method: 'complykit:api(open)' };
  return { ok: false, method: viaApi ? 'complykit:api(open) — settings did not open' : 'complykit:no-entry-point' };
}

/** Withdraw: reopen the settings layer, click its Reject all (the withdrawal). */
export async function complykitWithdraw(page: Page): Promise<{ reopened: { ok: boolean; method: string }; ok: boolean; method: string }> {
  const reopened = await complykitReopen(page);
  if (!reopened.ok) return { reopened, ok: false, method: `reopen:${reopened.method}` };
  await page.waitForTimeout(300);
  if (await click(page, CK.settingsReject)) return { reopened, ok: true, method: `reopen:${reopened.method}+complykit:click(settings reject)` };
  // The UI path failed on a real page: the API is the documented fallback, and the record says so.
  const viaApi = await page
    .evaluate(() => {
      const ck = (window as unknown as { ComplyKit?: { withdraw?: () => unknown } }).ComplyKit;
      if (typeof ck?.withdraw !== 'function') return false;
      ck.withdraw();
      return true;
    })
    .catch(() => false);
  return { reopened, ok: viaApi, method: `reopen:${reopened.method}+${viaApi ? 'complykit:api(withdraw)' : 'complykit:settings reject not clickable'}` };
}

/**
 * Partial consent: analytics only. Opens the settings from the banner's Manage
 * (unless already open), sets every unlocked toggle to exactly
 * (category === 'analytics'), saves. Fails when there is no analytics toggle.
 */
export async function complykitPartial(page: Page): Promise<{ ok: boolean; method: string }> {
  const open = await page.$(CK.settingsOpen).catch(() => null);
  if (!open) {
    if (!(await click(page, CK.manage))) return { ok: false, method: 'complykit:manage not clickable' };
    if (!(await page.waitForSelector(CK.settingsOpen, { timeout: 4000 }).then(() => true).catch(() => false))) return { ok: false, method: 'complykit:settings did not open' };
  }
  const set = await page
    .evaluate((sel) => {
      const boxes = Array.from(document.querySelectorAll<HTMLInputElement>(sel.toggle));
      let analytics = false;
      for (const b of boxes) {
        if (b.disabled) continue;
        const want = b.getAttribute('data-ck-category') === 'analytics';
        if (want) analytics = true;
        if (b.checked !== want) b.click();
      }
      return analytics;
    }, CK)
    .catch(() => false);
  if (!set) return { ok: false, method: 'complykit:no analytics toggle' };
  if (!(await click(page, CK.settingsSave))) return { ok: false, method: 'complykit:save not clickable' };
  return { ok: true, method: 'complykit:click(settings analytics-only + save)' };
}
