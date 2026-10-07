import type { Page } from 'playwright';
import { CK, complykitPartial, complykitRunning } from './complykit.js';

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
      // complykit's own tool (D10): its state, minus the visitor id and timestamp.
      safe('complykit', () => {
        const s = typeof w.ComplyKit?.get === 'function' ? w.ComplyKit.get() : null;
        return s ? { status: s.status, regime: s.regime, gpc: Boolean(s.gpc), categories: s.categories } : undefined;
      });
      safe('googleConsent', () => {
        // gtag keeps these as booleans internally; normalize to Consent Mode's words.
        const e = w.google_tag_data?.ics?.entries;
        if (!e) return undefined;
        const word = (v: unknown): string | undefined => (v === true || v === 'granted' ? 'granted' : v === false || v === 'denied' ? 'denied' : undefined);
        const o: Record<string, unknown> = {};
        for (const k of Object.keys(e)) o[k] = { default: word(e[k]?.default), update: word(e[k]?.update) };
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
      safe('oneTrustClosed', () => (w.OnetrustActiveGroups !== undefined ? /(?:^|; )OptanonAlertBoxClosed=/.test(document.cookie) : undefined));
      safe('trustarc', () => {
        const m = /(?:^|; )notice_preferences=([^;]*)/.exec(document.cookie);
        return m ? { preferences: decodeURIComponent(m[1]) } : undefined;
      });
      safe('osano', () => w.Osano?.cm?.getConsent?.());
      safe('wix', () => {
        const p = w.consentPolicyManager?.getCurrentConsentPolicy?.();
        return p ? { defaultPolicy: p.defaultPolicy, policy: p.policy } : undefined;
      });
      safe('tcfData', () => {
        let r: unknown;
        if (typeof w.__tcfapi === 'function')
          w.__tcfapi('getTCData', 2, (d: { eventStatus?: string; purpose?: { consents?: Record<string, boolean> } }, ok: boolean) => {
            if (ok && d) r = { eventStatus: d.eventStatus, purpose1: d.purpose?.consents?.['1'], purpose4: d.purpose?.consents?.['4'] };
          });
        return r;
      });
      safe('cookieyes', () => {
        const c = w.getCkyConsent?.();
        return c ? { categories: c.categories, isUserActionCompleted: c.isUserActionCompleted } : undefined;
      });
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

/**
 * Does the stored state positively CONFIRM the choice? true = confirmed, false =
 * readable and not (yet) reflecting it, undefined = nothing readable. Shopify's
 * `marketingAllowed` is false both before any choice and after a reject, so it
 * reads `currentVisitorConsent.marketing` ('' = no choice stored) instead.
 */
export function readoutConfirms(choice: 'accept' | 'reject', readout: Record<string, unknown>): boolean | undefined {
  // The consent tool's own record decides; Google Consent Mode is consulted
  // only when no consent tool is readable (it is often wired up separately,
  // and a mismatch is reported by consentModeMismatch, not treated as a failed click).
  const tool: boolean[] = [];
  // complykit: a choice exists only when status is 'chosen'; accept = some
  // non-necessary category granted, reject = none.
  const ck = readout.complykit as { status?: string; categories?: Record<string, boolean> } | undefined;
  if (ck?.categories && typeof ck.status === 'string') {
    const optional = Object.entries(ck.categories).filter(([id]) => id !== 'necessary');
    tool.push(ck.status === 'chosen' && (choice === 'accept' ? optional.some(([, on]) => on) : optional.every(([, on]) => !on)));
  }
  const shop = (readout.shopify as { currentVisitorConsent?: { marketing?: string } } | undefined)?.currentVisitorConsent;
  if (shop && typeof shop.marketing === 'string') tool.push(choice === 'accept' ? shop.marketing === 'yes' : shop.marketing === 'no');
  if (typeof readout.oneTrustActiveGroups === 'string') {
    // Group ids vary by site; C0002–C0005 are OneTrust's defaults, and a choice
    // is only stored once OptanonAlertBoxClosed is set.
    const groups = readout.oneTrustActiveGroups.split(',').filter(Boolean);
    const optional = groups.filter((g) => g !== 'C0001');
    const closed = readout.oneTrustClosed === true;
    tool.push(closed && (choice === 'accept' ? optional.length > 0 : !optional.some((g) => /^C000[2-5]$/.test(g))));
  }
  const ta = readout.trustarc as { preferences?: string } | undefined;
  if (ta?.preferences) tool.push(choice === 'accept' ? !/^0\b|^0:/.test(ta.preferences) : /^0\b|^0:/.test(ta.preferences));
  const os = readout.osano as Record<string, string> | undefined;
  // Osano in US (opt-out) mode records a rejection as OPT_OUT=ACCEPT, leaving MARKETING as it was.
  if (os && typeof os.MARKETING === 'string') tool.push(choice === 'accept' ? os.MARKETING === 'ACCEPT' && os.OPT_OUT !== 'ACCEPT' : os.MARKETING === 'DENY' || os.OPT_OUT === 'ACCEPT');
  const wx = readout.wix as { defaultPolicy?: boolean; policy?: { advertising?: boolean } } | undefined;
  if (wx && wx.defaultPolicy === false && typeof wx.policy?.advertising === 'boolean') tool.push(choice === 'accept' ? wx.policy.advertising : !wx.policy.advertising);
  const tcf = readout.tcfData as { eventStatus?: string; purpose1?: boolean } | undefined;
  if (tcf && tcf.eventStatus === 'useractioncomplete' && typeof tcf.purpose1 === 'boolean') tool.push(choice === 'accept' ? tcf.purpose1 : !tcf.purpose1);
  const cb = readout.cookiebot as { marketing?: boolean; hasResponse?: boolean } | undefined;
  if (cb && cb.hasResponse) tool.push(choice === 'accept' ? cb.marketing === true : cb.marketing === false);
  const cky = readout.cookieyes as { categories?: Record<string, boolean>; isUserActionCompleted?: boolean } | undefined;
  if (cky?.categories && typeof cky.categories.advertisement === 'boolean') {
    tool.push(Boolean(cky.isUserActionCompleted) && (choice === 'accept' ? cky.categories.advertisement : !cky.categories.advertisement));
  }
  if (tool.length) return tool.every(Boolean);
  const g = readout.googleConsent as Record<string, { update?: string }> | undefined;
  if (g?.ad_storage?.update) return choice === 'accept' ? g.ad_storage.update === 'granted' : g.ad_storage.update === 'denied';
  return undefined;
}

/** The consent tool recorded the choice but Google Consent Mode says otherwise. */
export function consentModeMismatch(choice: 'accept' | 'reject', readout: Record<string, unknown>): string | undefined {
  const g = readout.googleConsent as Record<string, { update?: string; default?: string }> | undefined;
  const v = g?.ad_storage ? (g.ad_storage.update ?? g.ad_storage.default) : undefined;
  if (!v) return undefined;
  const want = choice === 'accept' ? 'granted' : 'denied';
  return v !== want ? `Google Consent Mode ad_storage is "${v}" after ${choice === 'accept' ? 'accepting' : 'rejecting'} — the consent tool and Google tags disagree` : undefined;
}

/** Does the stored state contradict the choice just made? undefined = nothing readable. */
export function readoutContradicts(choice: 'accept' | 'reject', readout: Record<string, unknown>): boolean | undefined {
  const c = readoutConfirms(choice, readout);
  return c === undefined ? undefined : !c;
}

// --- Banner detection (fallback when autoconsent finds no CMP) ---------------------
//
// Strict on purpose. A loose "any button saying OK/Accept" match turned an
// ordinary storefront with no banner into "banner showing, no choice" for every
// request (field run 2026-10-03). A banner here is a VISIBLE, on-screen element
// whose own text is about cookies/consent/privacy and which contains a choice
// control. Known consent-tool selectors are tried first.

const KNOWN_BANNERS: Array<{ name: string; banner: string; accept?: string; reject?: string; manage?: string; close?: string }> = [
  // Our own tool first (D10): exact hooks from client/src/ui/index.ts; it has no close control by design.
  { name: 'complykit', banner: CK.banner, accept: '.ck-btn[data-ck-action="accept"]', reject: '.ck-btn[data-ck-action="reject"]', manage: '.ck-btn[data-ck-action="manage"]' },
  { name: 'OneTrust', banner: '#onetrust-banner-sdk', accept: '#onetrust-accept-btn-handler', reject: '#onetrust-reject-all-handler', manage: '#onetrust-pc-btn-handler', close: '.onetrust-close-btn-handler' },
  { name: 'Cookiebot', banner: '#CybotCookiebotDialog', accept: '#CybotCookiebotDialogBodyLevelButtonLevelOptinAllowAll,#CybotCookiebotDialogBodyButtonAccept', reject: '#CybotCookiebotDialogBodyButtonDecline', manage: '#CybotCookiebotDialogBodyButtonDetails' },
  { name: 'Didomi', banner: '#didomi-notice', accept: '#didomi-notice-agree-button', reject: '#didomi-notice-disagree-button', manage: '#didomi-notice-learn-more-button', close: '.didomi-popup-close' },
  { name: 'Usercentrics', banner: '[data-testid="uc-default-banner"], #uc-center-container, #usercentrics-cmp-ui', accept: '[data-testid="uc-accept-all-button"], #accept', reject: '[data-testid="uc-deny-all-button"], #deny', manage: '[data-testid="uc-more-button"], #more' },
  { name: 'CookieYes', banner: '.cky-consent-container', accept: '.cky-btn-accept', reject: '.cky-btn-reject', manage: '.cky-btn-customize', close: '.cky-banner-btn-close' },
  { name: 'Complianz', banner: '.cmplz-cookiebanner', accept: '.cmplz-accept', reject: '.cmplz-deny', manage: '.cmplz-view-preferences', close: '.cmplz-close' },
  { name: 'Osano', banner: '.osano-cm-dialog', accept: '.osano-cm-accept-all', reject: '.osano-cm-denyAll', manage: '.osano-cm-manage', close: '.osano-cm-dialog__close' },
  { name: 'Shopify', banner: '#shopify-pc__banner', accept: '#shopify-pc__banner__btn-accept', reject: '#shopify-pc__banner__btn-decline', manage: '#shopify-pc__banner__btn-manage-prefs' },
];

export interface FoundBanner {
  via: string; // 'selector:<name>' | 'heuristic'
  accept?: string;
  reject?: string;
  manage?: string;
  close?: string;
}

/** Find a visible consent banner and tag its controls with data-complykit-* attributes. */
export async function findBanner(page: Page): Promise<FoundBanner | null> {
  try {
    return (await page.evaluate((known) => {
      // Consent tools increasingly render inside (open) shadow roots
      // (Usercentrics, Termly) — every lookup walks them.
      const deepAll = (sel: string, root: Document | ShadowRoot | Element = document): Element[] => {
        const out: Element[] = [];
        const visit = (r: Document | ShadowRoot | Element): void => {
          try {
            out.push(...Array.from(r.querySelectorAll(sel)));
          } catch {
            return;
          }
          for (const el of Array.from(r.querySelectorAll('*'))) if (el.shadowRoot) visit(el.shadowRoot);
        };
        visit(root);
        if (root instanceof Element && root.shadowRoot) visit(root.shadowRoot);
        return out;
      };
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      const onScreen = (el: Element): boolean => {
        const r = (el as HTMLElement).getBoundingClientRect();
        const cs = getComputedStyle(el as HTMLElement);
        return r.width > 4 && r.height > 4 && r.bottom > 0 && r.right > 0 && r.top < vh && r.left < vw && cs.visibility !== 'hidden' && cs.display !== 'none' && Number(cs.opacity) > 0.05;
      };
      const tag = (el: Element | null | undefined, role: string): string | undefined => {
        if (!el) return undefined;
        el.setAttribute('data-complykit-banner', role);
        return `[data-complykit-banner="${role}"]`;
      };
      for (const old of deepAll('[data-complykit-banner]')) old.removeAttribute('data-complykit-banner');
      const visibleIn = (root: Element, sel?: string): Element | undefined => {
        if (!sel) return undefined;
        return deepAll(sel, root).find(onScreen) ?? deepAll(sel).find(onScreen);
      };
      for (const k of known) {
        const b = deepAll(k.banner).find(onScreen);
        if (!b) continue;
        return { via: `selector:${k.name}`, accept: tag(visibleIn(b, k.accept), 'accept'), reject: tag(visibleIn(b, k.reject), 'reject'), manage: tag(visibleIn(b, k.manage), 'manage'), close: tag(visibleIn(b, k.close), 'close') };
      }
      const CONTEXT = /cookie|consent|tracking technolog|privacy (policy|settings|preferences|choices)|personal (data|information)|gdpr|we use (cookies|technologies)|similar technologies/i;
      const ACCEPT = /^(accept( all| cookies| and close| & close)?|allow( all| cookies)?|agree( and close)?|i agree|i accept|got it|ok(ay)?|yes,? i agree|accept & continue|continue)$/i;
      const REJECT = /^(reject( all| cookies)?|decline( all| cookies)?|deny( all)?|refuse( all)?|disagree|necessary (cookies )?only|only necessary|essential (cookies )?only|use necessary cookies only|do not accept|no,? thanks)$/i;
      const MANAGE = /^(manage( preferences| cookies| settings| choices| options)?|cookie settings|settings|preferences|customi[sz]e|more options|options|let me choose|show purposes)$/i;
      const labelOf = (el: Element): string => ((el.textContent ?? '') || (el as HTMLInputElement).value || el.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim();
      const controls = deepAll('button, [role="button"], a, input[type="button"], input[type="submit"]').filter(onScreen);
      // Each candidate control: climb to the nearest ancestor whose own text is
      // consent-shaped and short enough to be a banner, not the page.
      for (const c of controls) {
        const label = labelOf(c);
        if (!label || label.length > 40 || !(ACCEPT.test(label) || REJECT.test(label))) continue;
        const ancestors: Element[] = [];
        // Climb out of a shadow root through its host, so a banner inside one still has a container.
        const up = (e: Element): Element | null => e.parentElement ?? ((e.getRootNode() as ShadowRoot).host ?? null);
        for (let a = up(c); a && a !== document.body && ancestors.length < 8; a = up(a)) ancestors.push(a);
        for (const n of ancestors) {
          const text = ((n as HTMLElement).innerText || (n.shadowRoot ? (n.shadowRoot as unknown as { textContent: string }).textContent : '') || '').toString();
          if (text.length > 2500) break;
          if (!CONTEXT.test(text)) continue;
          const inside = deepAll('button, [role="button"], a, input[type="button"], input[type="submit"]', n).filter(onScreen);
          const find = (re: RegExp): Element | undefined => inside.find((x) => re.test(labelOf(x)));
          const close = inside.find((x) => /^\s*(×|✕|✖|x)\s*$/i.test(x.textContent ?? '') || /\b(close|dismiss)\b/i.test(x.getAttribute('aria-label') ?? ''));
          return { via: 'heuristic', accept: tag(find(ACCEPT), 'accept'), reject: tag(find(REJECT), 'reject'), manage: tag(find(MANAGE), 'manage'), close: tag(close, 'close') };
        }
      }
      return null;
    }, KNOWN_BANNERS)) as FoundBanner | null;
  } catch {
    return null;
  }
}

export interface HeuristicResult {
  found: boolean;
  clicked: boolean;
  clicks: number;
  method: string;
}

export async function heuristicChoice(page: Page, choice: 'accept' | 'reject'): Promise<HeuristicResult> {
  const b = await findBanner(page);
  if (!b) return { found: false, clicked: false, clicks: 0, method: 'heuristic' };
  const method = b.via;
  const click = async (sel: string): Promise<boolean> => page.click(sel, { timeout: 5000 }).then(() => true).catch(() => false);
  if (choice === 'accept') {
    if (b.accept && (await click(b.accept))) return { found: true, clicked: true, clicks: 1, method };
    return { found: true, clicked: false, clicks: 0, method };
  }
  if (b.reject && (await click(b.reject))) return { found: true, clicked: true, clicks: 1, method };
  if (b.manage && (await click(b.manage))) {
    await page.waitForTimeout(900);
    const ok = await rejectInOpenSettings(page);
    return { found: true, clicked: ok, clicks: ok ? 2 : 1, method: `${method}+settings` };
  }
  return { found: true, clicked: false, clicks: 0, method };
}

/** Is a consent banner visible right now (known selectors or strict heuristic)? */
export async function bannerVisible(page: Page): Promise<boolean> {
  return (await findBanner(page)) !== null;
}

// --- Dismiss --------------------------------------------------------------------

/** Close the banner without choosing: its close control, else Escape. A banner
 *  with no way to close it without choosing is reported as such (`noClose`). */
export async function dismissBanner(page: Page): Promise<{ ok: boolean; method: string; noClose?: boolean }> {
  const b = await findBanner(page);
  if (b?.close) {
    await page.click(b.close, { timeout: 3000 }).catch(() => {});
    await page.waitForTimeout(600);
    if (!(await bannerVisible(page))) return { ok: true, method: `close:${b.via}` };
  }
  await page.keyboard.press('Escape').catch(() => {});
  await page.waitForTimeout(600);
  if (!(await bannerVisible(page))) return { ok: true, method: 'escape' };
  return { ok: false, method: b?.close ? 'close-did-not-close' : 'none', noClose: !b?.close };
}

// --- Partial consent (one category: analytics) ------------------------------------

const ANALYTICS_LABEL = /analytic|statistic|performance|measurement|mesure|statistik/i;
const SAVE_LABEL = /save|confirm|allow selection|accept selected|submit|apply|speichern|enregistrer/i;

export async function partialConsent(page: Page): Promise<{ ok: boolean; method: string }> {
  // complykit (D10): exact toggles and buttons, no text matching — also when its
  // banner is not showing (the tool is running): never fall through to heuristics.
  if ((await page.$(CK.banner).catch(() => null)) || (await complykitRunning(page))) return complykitPartial(page);
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
  const b = await findBanner(page);
  if (b?.manage) {
    await page.click(b.manage, { timeout: 4000 }).catch(() => {});
    await page.waitForTimeout(900);
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

// Not "Your Privacy Choices" / "Do Not Sell": those are the US opt-out link, not cookie settings.
const SETTINGS_LINK = /cookie (settings|preferences|policy settings)|privacy (settings|preferences)|manage (cookies|consent|preferences)|consent (settings|preferences)|cookie-einstellungen|paramètres des cookies/i;

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
        ['privacyBanner.showPreferences', w.privacyBanner, 'showPreferences', []],
        ['revisitCkyConsent', w, 'revisitCkyConsent', []],
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
        // Styled toggles hide the real checkbox (opacity 0, 1px) behind its
        // label (Osano, many themes) — act on whichever part is visible.
        const target = (b: HTMLElement): HTMLElement | null => {
          if (visible(b)) return b;
          const label = (b.id && document.querySelector<HTMLElement>(`label[for="${CSS.escape(b.id)}"]`)) || b.closest('label');
          if (label && visible(label)) return label as HTMLElement;
          const parent = b.parentElement;
          return parent && visible(parent) ? parent : null;
        };
        for (const b of Array.from(document.querySelectorAll<HTMLElement>('input[type="checkbox"], [role="switch"]'))) {
          if ((b as HTMLInputElement).disabled || b.getAttribute('aria-disabled') === 'true') continue;
          const checked = b instanceof HTMLInputElement ? b.checked : b.getAttribute('aria-checked') === 'true';
          const t = target(b);
          if (checked && t) {
            t.click();
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
// Field wordings seen: "Opt-Out Request Honored", "GPC request honored.", "The GPC signal is honored".
const CONFIRMATION = /opt[- ]?out (request )?(has been |is )?(honou?red|processed|received|confirmed|applied|recorded)|you (have|'ve) (been )?opted out|opted[- ]out of (the )?(sale|sharing)|(global privacy control|gpc)[^.\n]{0,30}?(detected|honou?red|recogni[sz]ed|respected|applied)|your (choices?|preferences?) (has|have) been (saved|updated)/i;
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

// --- Bot protection ------------------------------------------------------------------

const CHALLENGE = /just a moment|attention required|access denied|pardon our interruption|are you a robot|verify you are (a )?human|checking your browser|request unsuccessful|incapsula|perimeterx|press (and|&) hold|unusual traffic|blocked|captcha|hang tight|you are (now )?in (a |the )?(virtual )?(queue|line)|waiting room/i;

/** A bot-protection page instead of the site (HTTP ≥ 403 on the document, or a
 *  challenge page). Evidence from a challenge page is not evidence about the site. */
export async function detectBlock(page: Page): Promise<string | undefined> {
  try {
    const r = (await page.evaluate(() => {
      const nav = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming & { responseStatus?: number };
      const text = (document.body?.innerText ?? '').slice(0, 1500);
      return { status: nav?.responseStatus ?? 0, title: document.title, text, links: document.querySelectorAll('a[href]').length };
    })) as { status: number; title: string; text: string; links: number };
    if (r.status === 403 || r.status === 429 || r.status === 503) return `HTTP ${r.status}${r.title ? ` — “${r.title.slice(0, 60)}”` : ''}`;
    // A challenge page is short and link-poor; a real page that merely says
    // "blocked" somewhere in its copy has navigation.
    if ((CHALLENGE.test(r.title) || (CHALLENGE.test(r.text) && r.text.length < 800)) && r.links < 15) return `challenge page — “${(r.title || r.text).slice(0, 60)}”`;
    return undefined;
  } catch {
    return undefined;
  }
}

/** A visible iframe served by a consent tool (TrustArc, Sourcepoint, …) — banners
 *  findBanner can't see because they live in another document. */
export async function consentFrameVisible(page: Page): Promise<boolean> {
  return page
    .evaluate(() =>
      Array.from(document.querySelectorAll('iframe')).some((f) => {
        const src = f.src || '';
        if (!/trustarc|truste|consent|privacy-mgmt|sp_message|sourcepoint|cmp|cookie/i.test(src + ' ' + f.id + ' ' + f.title)) return false;
        const r = f.getBoundingClientRect();
        const cs = getComputedStyle(f);
        return r.width > 50 && r.height > 50 && r.bottom > 0 && r.top < window.innerHeight && cs.visibility !== 'hidden' && cs.display !== 'none';
      }),
    )
    .catch(() => false);
}
