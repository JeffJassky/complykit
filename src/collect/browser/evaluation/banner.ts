import type { Page } from 'playwright';
import { detectCmp } from '../consent.js';

// Everything banner-shaped that autoconsent doesn't do: the heuristic fallback,
// dismiss (close without choosing), partial consent, reopening settings to
// withdraw, the opt-out link walk, and the consent-state readouts that confirm
// a click actually changed the stored choice (plans/consent-design.md §2.3).
// Pure page-level helpers; the scenario runner records the events.

// --- Consent readouts ---------------------------------------------------------

/** What every party on the page currently believes the consent state is. */
export async function readConsentState(page: Page): Promise<Record<string, unknown>> {
  const read = readConsentStateUnbounded(page);
  return Promise.race([read, new Promise<Record<string, unknown>>((r) => setTimeout(() => r({}), 4000))]);
}

async function readConsentStateUnbounded(page: Page): Promise<Record<string, unknown>> {
  try {
    return (await page.evaluate(() => {
      const w = window as unknown as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
      const out: Record<string, unknown> = {};
      const safe = (k: string, f: () => unknown): void => {
        try {
          const v = f();
          if (v !== undefined && v !== null) out[k] = JSON.parse(JSON.stringify(v));
        } catch {
          /* absent */
        }
      };
      safe('gpc', () => (navigator as unknown as { globalPrivacyControl?: boolean }).globalPrivacyControl);
      safe('googleConsent', () => {
        const e = w.google_tag_data?.ics?.entries;
        if (!e) return undefined;
        const o: Record<string, unknown> = {};
        for (const k of Object.keys(e)) o[k] = { default: e[k]?.default, update: e[k]?.update };
        return o;
      });
      safe('dataLayerConsent', () => {
        const dl = w.dataLayer;
        if (!Array.isArray(dl)) return undefined;
        const c = dl.filter((x: unknown) => x && typeof x === 'object' && (x as Record<string, unknown>)[0] === 'consent');
        return c.length ? c.slice(-6).map((x: Record<string, unknown>) => [x[1], x[2]]) : undefined;
      });
      safe('tcf', () => {
        let r: unknown;
        if (typeof w.__tcfapi === 'function') w.__tcfapi('ping', 2, (p: unknown) => (r = p));
        return r;
      });
      safe('gpp', () => {
        if (typeof w.__gpp !== 'function') return undefined;
        const p = w.__gpp('ping');
        return p ? { gppString: p.gppString, applicableSections: p.applicableSections, signalStatus: p.signalStatus } : undefined;
      });
      safe('usp', () => {
        let r: unknown;
        if (typeof w.__uspapi === 'function') w.__uspapi('getUSPData', 1, (d: { uspString?: string }) => (r = d?.uspString));
        return r;
      });
      safe('oneTrustActiveGroups', () => (w.OnetrustActiveGroups !== undefined ? String(w.OnetrustActiveGroups) : undefined));
      safe('oneTrustGeo', () => w.OneTrust?.getGeolocationData?.());
      safe('cookiebot', () => (w.Cookiebot?.consent ? { ...w.Cookiebot.consent } : undefined));
      safe('cookiebotCountry', () => w.Cookiebot?.userCountry);
      safe('shopify', () => {
        const cp = w.Shopify?.customerPrivacy;
        if (!cp) return undefined;
        const call = (f: string): unknown => {
          try {
            return typeof cp[f] === 'function' ? cp[f]() : undefined;
          } catch {
            return undefined;
          }
        };
        return {
          currentVisitorConsent: call('currentVisitorConsent'),
          region: call('getRegion'),
          shouldShowBanner: call('shouldShowBanner'),
          saleOfDataAllowed: call('saleOfDataAllowed'),
          marketingAllowed: call('marketingAllowed'),
          analyticsProcessingAllowed: call('analyticsProcessingAllowed'),
        };
      });
      safe('usercentrics', () => w.UC_UI?.getServicesBaseInfo?.()?.map((s: { name: string; consent?: { status?: boolean } }) => [s.name, s.consent?.status]));
      safe('didomi', () => {
        const s = w.Didomi?.getCurrentUserStatus?.();
        return s ? { purposes: s.purposes, vendors: undefined } : undefined;
      });
      safe('cookieconsent', () => w.CookieConsent?.getUserPreferences?.());
      safe('klaro', () => w.klaro?.getManager?.()?.consents);
      return out;
    })) as Record<string, unknown>;
  } catch {
    return {};
  }
}

/** Region the site/consent tool believes the visitor is in, when it says. */
export function siteReportedRegion(readout: Record<string, unknown>): Array<{ source: string; value: string }> {
  const out: Array<{ source: string; value: string }> = [];
  const geo = readout.oneTrustGeo as { country?: string; state?: string } | undefined;
  if (geo?.country) out.push({ source: 'OneTrust.getGeolocationData', value: [geo.country, geo.state].filter(Boolean).join('-') });
  if (typeof readout.cookiebotCountry === 'string' && readout.cookiebotCountry) out.push({ source: 'Cookiebot.userCountry', value: readout.cookiebotCountry });
  const shop = readout.shopify as { region?: string } | undefined;
  if (typeof shop?.region === 'string' && shop.region) out.push({ source: 'Shopify.customerPrivacy.getRegion', value: shop.region });
  return out;
}

/** Does the stored state contradict the choice just made? undefined = nothing readable. */
export function readoutContradicts(choice: 'accept' | 'reject', readout: Record<string, unknown>): boolean | undefined {
  const verdicts: boolean[] = [];
  const g = readout.googleConsent as Record<string, { update?: string; default?: string }> | undefined;
  if (g?.ad_storage) {
    const v = g.ad_storage.update ?? g.ad_storage.default;
    if (v) verdicts.push(choice === 'reject' ? v === 'granted' : v === 'denied');
  }
  if (typeof readout.oneTrustActiveGroups === 'string') {
    const groups = readout.oneTrustActiveGroups.split(',').filter(Boolean);
    const marketing = groups.includes('C0004');
    verdicts.push(choice === 'reject' ? marketing : !marketing);
  }
  const cb = readout.cookiebot as { marketing?: boolean } | undefined;
  if (cb && typeof cb.marketing === 'boolean') verdicts.push(choice === 'reject' ? cb.marketing : !cb.marketing);
  const shop = (readout.shopify as { marketingAllowed?: boolean } | undefined)?.marketingAllowed;
  if (typeof shop === 'boolean') verdicts.push(choice === 'reject' ? shop : !shop);
  if (!verdicts.length) return undefined;
  return verdicts.some(Boolean);
}

// --- Heuristic choice (fallback when autoconsent finds no CMP) -----------------

export interface HeuristicResult {
  found: boolean;
  clicked: boolean;
  clicks: number;
  method: string;
}

export async function heuristicChoice(page: Page, choice: 'accept' | 'reject'): Promise<HeuristicResult> {
  const cmp = await detectCmp(page);
  if (!cmp.bannerFound) return { found: false, clicked: false, clicks: 0, method: 'heuristic' };
  const method = cmp.vendor && cmp.vendor !== 'heuristic' ? `selector:${cmp.vendor}` : 'heuristic';
  try {
    if (choice === 'accept') {
      if (!cmp.acceptSelector) return { found: true, clicked: false, clicks: 0, method };
      await page.click(cmp.acceptSelector, { timeout: 5000 });
      return { found: true, clicked: true, clicks: 1, method };
    }
    if (cmp.rejectSelector) {
      await page.click(cmp.rejectSelector, { timeout: 5000 });
      return { found: true, clicked: true, clicks: 1, method };
    }
    if (cmp.manageSelector) {
      await page.click(cmp.manageSelector, { timeout: 5000 });
      await page.waitForTimeout(800);
      const ok = await rejectInOpenSettings(page);
      return { found: true, clicked: ok, clicks: ok ? 2 : 1, method: `${method}+settings` };
    }
  } catch {
    /* click failed */
  }
  return { found: true, clicked: false, clicks: 0, method };
}

/** Is a consent banner visible right now (known selectors or heuristic text)? */
export async function bannerVisible(page: Page): Promise<boolean> {
  try {
    const cmp = await detectCmp(page);
    return cmp.bannerFound;
  } catch {
    return false;
  }
}

// --- Dismiss --------------------------------------------------------------------

const CLOSE_SELECTORS = [
  '#onetrust-close-btn-container button',
  '.onetrust-close-btn-handler',
  '#CybotCookiebotDialogBodyButtonClose',
  '.cc-dismiss',
  '.cmplz-close',
  '[data-testid="uc-close-button"]',
  '.didomi-popup-close',
];

/** Close the banner without choosing: a close control, else Escape, else a click outside. */
export async function dismissBanner(page: Page): Promise<{ ok: boolean; method: string }> {
  for (const sel of CLOSE_SELECTORS) {
    const el = await page.$(sel).catch(() => null);
    if (el && (await el.isVisible().catch(() => false))) {
      await el.click({ timeout: 3000 }).catch(() => {});
      return { ok: true, method: `close:${sel}` };
    }
  }
  const generic = await page
    .evaluate(() => {
      const near = (el: Element): boolean => {
        let n: Element | null = el;
        for (let i = 0; i < 8 && n; i++, n = n.parentElement) {
          if (/cookie|consent|privacy|gdpr|tracking/i.test(`${n.id} ${n.className} ${n.getAttribute('aria-label') ?? ''}`)) return true;
        }
        return false;
      };
      const cands = Array.from(document.querySelectorAll('button, [role="button"], a'));
      for (const el of cands) {
        const label = `${el.getAttribute('aria-label') ?? ''} ${el.getAttribute('title') ?? ''} ${(el.textContent ?? '').trim()}`;
        const r = (el as HTMLElement).getBoundingClientRect();
        if (r.width === 0 || r.height === 0) continue;
        if (/^\s*(×|✕|✖|x)\s*$/i.test((el.textContent ?? '').trim()) || /\b(close|dismiss)\b/i.test(label)) {
          if (near(el)) {
            el.setAttribute('data-complykit-dismiss', '1');
            return true;
          }
        }
      }
      return false;
    })
    .catch(() => false);
  if (generic) {
    await page.click('[data-complykit-dismiss="1"]', { timeout: 3000 }).catch(() => {});
    return { ok: true, method: 'close:heuristic' };
  }
  await page.keyboard.press('Escape').catch(() => {});
  await page.waitForTimeout(500);
  if (!(await bannerVisible(page))) return { ok: true, method: 'escape' };
  const vp = page.viewportSize();
  await page.mouse.click(Math.max(5, (vp?.width ?? 1280) - 10), 10).catch(() => {});
  await page.waitForTimeout(500);
  return { ok: !(await bannerVisible(page)), method: 'outside-click' };
}

// --- Partial consent (one category: analytics) ------------------------------------

const ANALYTICS_LABEL = /analytic|statistic|performance|measurement|mesure|statistik/i;
const SAVE_LABEL = /save|confirm|allow selection|accept selected|submit|apply|speichern|enregistrer/i;

export async function partialConsent(page: Page): Promise<{ ok: boolean; method: string }> {
  // OneTrust: open preferences, toggle Performance (C0002), confirm.
  if (await page.$('#onetrust-pc-btn-handler').catch(() => null)) {
    await page.click('#onetrust-pc-btn-handler', { timeout: 4000 }).catch(() => {});
    await page.waitForTimeout(800);
    const toggled = await page
      .evaluate(() => {
        const box = document.querySelector<HTMLInputElement>('#ot-group-id-C0002, input[name="ot-group-id-C0002"]');
        if (!box) return false;
        if (!box.checked) box.click();
        for (const id of ['C0003', 'C0004', 'C0005']) {
          const b = document.querySelector<HTMLInputElement>(`#ot-group-id-${id}`);
          if (b?.checked) b.click();
        }
        return true;
      })
      .catch(() => false);
    if (toggled) {
      await page.click('.save-preference-btn-handler', { timeout: 4000 }).catch(() => {});
      return { ok: true, method: 'onetrust:C0002' };
    }
  }
  // Cookiebot: statistics on, marketing/preferences off, allow selection.
  if (await page.$('#CybotCookiebotDialogBodyLevelButtonStatistics').catch(() => null)) {
    const ok = await page
      .evaluate(() => {
        const set = (id: string, on: boolean): void => {
          const b = document.getElementById(id) as HTMLInputElement | null;
          if (b && b.checked !== on) b.click();
        };
        set('CybotCookiebotDialogBodyLevelButtonStatistics', true);
        set('CybotCookiebotDialogBodyLevelButtonMarketing', false);
        set('CybotCookiebotDialogBodyLevelButtonPreferences', false);
        const btn = document.getElementById('CybotCookiebotDialogBodyLevelButtonLevelOptinAllowallSelection');
        if (btn) (btn as HTMLElement).click();
        return Boolean(btn);
      })
      .catch(() => false);
    if (ok) return { ok: true, method: 'cookiebot:statistics' };
  }
  // Generic: open settings if needed, check the analytics switch only, save.
  const cmp = await detectCmp(page).catch(() => null);
  if (cmp?.manageSelector) {
    await page.click(cmp.manageSelector, { timeout: 4000 }).catch(() => {});
    await page.waitForTimeout(800);
  }
  const done = await page
    .evaluate(
      ({ a, s }) => {
        const analytics = new RegExp(a, 'i');
        const save = new RegExp(s, 'i');
        const boxes = Array.from(document.querySelectorAll<HTMLElement>('input[type="checkbox"], [role="switch"]'));
        let hit = false;
        for (const b of boxes) {
          const label = `${b.getAttribute('aria-label') ?? ''} ${b.closest('label')?.textContent ?? ''} ${b.id ? document.querySelector(`label[for="${b.id}"]`)?.textContent ?? '' : ''} ${b.parentElement?.textContent ?? ''}`;
          const disabled = (b as HTMLInputElement).disabled || b.getAttribute('aria-disabled') === 'true';
          if (disabled) continue;
          const checked = b instanceof HTMLInputElement ? b.checked : b.getAttribute('aria-checked') === 'true';
          const want = analytics.test(label);
          if (want) hit = true;
          if (checked !== want) (b as HTMLElement).click();
        }
        if (!hit) return false;
        const buttons = Array.from(document.querySelectorAll('button, [role="button"], input[type="submit"]'));
        const btn = buttons.find((el) => save.test((el.textContent ?? (el as HTMLInputElement).value ?? '').trim()));
        if (!btn) return false;
        (btn as HTMLElement).click();
        return true;
      },
      { a: ANALYTICS_LABEL.source, s: SAVE_LABEL.source },
    )
    .catch(() => false);
  return done ? { ok: true, method: 'heuristic:analytics-only' } : { ok: false, method: 'none' };
}

// --- Withdraw: reopen settings, reject, save ---------------------------------------

const SETTINGS_LINK = /cookie (settings|preferences|policy settings)|privacy (settings|preferences)|manage (cookies|consent|preferences)|consent (settings|preferences)|your privacy choices|cookie-einstellungen|paramètres des cookies/i;

/** Reopen the consent tool after a choice: its JS API first, then a visible link. */
export async function reopenSettings(page: Page): Promise<{ ok: boolean; method: string }> {
  const viaApi = await page
    .evaluate(() => {
      const w = window as unknown as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
      // Each entry: [label, the function if present, its receiver, args].
      const fn = (o: unknown, k: string): ((...a: unknown[]) => unknown) | undefined => {
        const v = o && (typeof o === 'object' || typeof o === 'function') ? (o as Record<string, unknown>)[k] : undefined;
        return typeof v === 'function' ? (v as (...a: unknown[]) => unknown) : undefined;
      };
      const tries: Array<[string, unknown, string, unknown[]]> = [
        ['OneTrust.ToggleInfoDisplay', w.OneTrust, 'ToggleInfoDisplay', []],
        ['Cookiebot.renew', w.Cookiebot, 'renew', []],
        ['UC_UI.showSecondLayer', w.UC_UI, 'showSecondLayer', []],
        ['Didomi.preferences.show', w.Didomi?.preferences, 'show', []],
        ['klaro.show', w.klaro, 'show', []],
        ['CookieConsent.showPreferences', w.CookieConsent, 'showPreferences', []],
        ['Osano.cm.showDrawer', w.Osano?.cm, 'showDrawer', ['osano-cm-dom-info-dialog-open']],
        ['__tcfapi.displayConsentUi', w, '__tcfapi', ['displayConsentUi', 2, () => {}]],
      ];
      for (const [name, recv, key, args] of tries) {
        const f = fn(recv, key);
        if (!f) continue;
        try {
          f.apply(recv, args);
          return name;
        } catch {
          /* next */
        }
      }
      return null;
    })
    .catch(() => null);
  if (viaApi) return { ok: true, method: `api:${viaApi}` };
  const clicked = await page
    .evaluate((src) => {
      const re = new RegExp(src, 'i');
      const els = Array.from(document.querySelectorAll('a, button, [role="button"]'));
      const el = els.find((e) => re.test((e.textContent ?? '').trim()) || re.test(e.getAttribute('aria-label') ?? ''));
      if (!el) return false;
      el.setAttribute('data-complykit-settings', '1');
      return true;
    }, SETTINGS_LINK.source)
    .catch(() => false);
  if (clicked) {
    await page.click('[data-complykit-settings="1"]', { timeout: 4000 }).catch(() => {});
    return { ok: true, method: 'link' };
  }
  return { ok: false, method: 'none' };
}

const REJECT_ALL = /reject all|decline all|deny all|refuse all|necessary only|only necessary|essential only|reject|decline|alle ablehnen|tout refuser/i;

/** In an open settings panel: reject-all if offered, else switch everything off and save. */
export async function rejectInOpenSettings(page: Page): Promise<boolean> {
  return page
    .evaluate(
      ({ r, s }) => {
        const reject = new RegExp(r, 'i');
        const save = new RegExp(s, 'i');
        const visible = (el: Element): boolean => {
          const b = (el as HTMLElement).getBoundingClientRect();
          return b.width > 0 && b.height > 0;
        };
        const buttons = Array.from(document.querySelectorAll('button, [role="button"], a, input[type="button"], input[type="submit"]')).filter(visible);
        const rej = buttons.find((el) => reject.test((el.textContent ?? (el as HTMLInputElement).value ?? '').trim()));
        if (rej) {
          (rej as HTMLElement).click();
          return true;
        }
        let toggled = false;
        for (const b of Array.from(document.querySelectorAll<HTMLElement>('input[type="checkbox"], [role="switch"]')).filter(visible)) {
          if ((b as HTMLInputElement).disabled || b.getAttribute('aria-disabled') === 'true') continue;
          const checked = b instanceof HTMLInputElement ? b.checked : b.getAttribute('aria-checked') === 'true';
          if (checked) {
            (b as HTMLElement).click();
            toggled = true;
          }
        }
        const saveBtn = buttons.find((el) => save.test((el.textContent ?? (el as HTMLInputElement).value ?? '').trim()));
        if (saveBtn) {
          (saveBtn as HTMLElement).click();
          return true;
        }
        return toggled;
      },
      { r: REJECT_ALL.source, s: SAVE_LABEL.source },
    )
    .catch(() => false);
}

// --- Opt-out link walk (CCPA "Do Not Sell or Share" / "Your Privacy Choices") ----

const OPT_OUT_LINK = /do not (sell|share)|your privacy choices|privacy choices|opt[- ]?out|limit the use of my|sale of (my )?personal/i;
const CONFIRMATION = /opt[- ]?out (request )?(has been )?(honou?red|processed|received|confirmed|applied|recorded)|you (have|'ve) (been )?opted out|opted[- ]out of (the )?(sale|sharing)|(global privacy control|gpc)( signal)? (detected|honou?red|recogni[sz]ed|applied)|your (choices?|preferences?) (has|have) been (saved|updated)/i;
const OPT_OUT_ACTION = /opt[- ]?out|do not (sell|share)|turn off|disable (sale|sharing)|confirm my choices|save (my )?(choices|preferences|settings)|submit/i;
const PERSONAL_FIELD = /email|e-mail|name|phone|address|zip|postal|account|order/i;

export interface OptOutWalk {
  found: boolean;
  linkText?: string;
  href?: string;
  hasIcon?: boolean;
  steps?: number;
  requiredFields: string[];
  confirmation?: string;
  landedUrl?: string;
  performed?: boolean;
}

/** Text on the page that confirms an opt-out / GPC was honored, if any. */
export async function findConfirmation(page: Page): Promise<string | undefined> {
  return page
    .evaluate((src) => {
      const re = new RegExp(src, 'i');
      const text = document.body?.innerText ?? '';
      const m = text.match(re);
      return m ? text.slice(Math.max(0, (m.index ?? 0) - 40), (m.index ?? 0) + m[0].length + 40).replace(/\s+/g, ' ').trim() : undefined;
    }, CONFIRMATION.source)
    .catch(() => undefined);
}

/**
 * Find the opt-out link and walk it: count steps and required personal fields,
 * read any confirmation. With `perform`, click a plain opt-out control (button
 * or toggle) — never submit a form that asks for personal information.
 */
export async function walkOptOutLink(page: Page, perform: boolean): Promise<OptOutWalk> {
  const link = await page
    .evaluate((src) => {
      const re = new RegExp(src, 'i');
      const els = Array.from(document.querySelectorAll('a, button, [role="button"]'));
      // Prefer the footer (where the law expects it), then anywhere.
      els.sort((a, b) => Number(Boolean(b.closest('footer'))) - Number(Boolean(a.closest('footer'))));
      for (const el of els) {
        const text = (el.textContent ?? '').replace(/\s+/g, ' ').trim();
        if (!text || text.length > 80 || !re.test(text)) continue;
        const r = (el as HTMLElement).getBoundingClientRect();
        if (r.width === 0 && r.height === 0) continue;
        const icon = Boolean(el.querySelector('svg, img')) || ['svg', 'img'].includes((el.previousElementSibling?.tagName ?? '').toLowerCase()) || ['svg', 'img'].includes((el.nextElementSibling?.tagName ?? '').toLowerCase());
        el.setAttribute('data-complykit-optout', '1');
        return { text, href: (el as HTMLAnchorElement).href || undefined, icon };
      }
      return null;
    }, OPT_OUT_LINK.source)
    .catch(() => null);
  if (!link) return { found: false, requiredFields: [] };

  const startUrl = page.url();
  let steps = 1;
  await Promise.all([
    page.waitForLoadState('domcontentloaded', { timeout: 10000 }).catch(() => {}),
    page.click('[data-complykit-optout="1"]', { timeout: 5000 }).catch(() => {}),
  ]);
  await page.waitForTimeout(1500);

  const inspect = await page
    .evaluate(
      ({ action, personal }) => {
        const act = new RegExp(action, 'i');
        const pf = new RegExp(personal, 'i');
        const visible = (el: Element): boolean => {
          const b = (el as HTMLElement).getBoundingClientRect();
          return b.width > 0 && b.height > 0;
        };
        const required = Array.from(document.querySelectorAll<HTMLInputElement>('input, select, textarea'))
          .filter(visible)
          .filter((i) => i.required || i.getAttribute('aria-required') === 'true')
          .map((i) => i.name || i.id || i.type)
          .filter((n) => pf.test(n));
        const controls = Array.from(document.querySelectorAll('button, [role="button"], [role="switch"], input[type="checkbox"]')).filter(visible);
        const ctl = controls.find((el) => act.test(`${el.textContent ?? ''} ${el.getAttribute('aria-label') ?? ''}`));
        if (ctl) ctl.setAttribute('data-complykit-optout-action', '1');
        return { required, hasAction: Boolean(ctl) };
      },
      { action: OPT_OUT_ACTION.source, personal: PERSONAL_FIELD.source },
    )
    .catch(() => ({ required: [] as string[], hasAction: false }));

  let performed = false;
  if (perform && inspect.hasAction && inspect.required.length === 0) {
    await page.click('[data-complykit-optout-action="1"]', { timeout: 4000 }).catch(() => {});
    steps++;
    performed = true;
    await page.waitForTimeout(1500);
  } else if (inspect.hasAction) {
    steps++; // the step a visitor would still have to take
  }
  const confirmation = await findConfirmation(page);
  const landedUrl = page.url() !== startUrl ? page.url() : undefined;
  return {
    found: true,
    linkText: link.text,
    href: link.href,
    hasIcon: link.icon,
    steps,
    requiredFields: inspect.required,
    confirmation,
    landedUrl,
    performed,
  };
}
