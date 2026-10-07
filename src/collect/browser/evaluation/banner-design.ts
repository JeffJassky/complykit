import type { Page } from 'playwright';
import {
  BannerFirstLayer,
  BannerSecondLayer,
  BannerAfterChoice,
  controlTextContrast,
  looksEnglish,
  WITHDRAWAL_LINK_TEXT,
  type BannerSource,
} from '../../../record/index.js';
import { findBanner, consentFrameVisible } from './banner.js';

// Banner design readouts (ticket F6). Read-only measurements of the consent
// banner, for the pure rules in rules/consent/banner-design.ts:
//
//   readFirstLayer   — on landing, nothing clicked: the accept/reject/manage
//                      controls' boxes, colors, type, DOM order and whether
//                      each is visible without scrolling; the banner's text and
//                      links; page usability behind it (covered / inert /
//                      scroll-locked — the cookie-wall measurement); page-wide
//                      opt-out link wording.
//   readSecondLayer  — the default checked state of the category toggles, read
//                      from the DOM when the tool renders its settings hidden,
//                      else after opening them (only where the scenario is
//                      about to open them anyway).
//   readAfterChoice  — right after a choice: banner gone? page usable? a visible
//                      control that reopens the settings (withdrawal)?
//
// Our own tool is read by its documented hooks (client/src/ui/index.ts header:
// #complykit-ui, .ck-banner, .ck-btn[data-ck-action], .ck-settings,
// .ck-category[data-ck-category][data-ck-locked], .ck-choices,
// [data-complykit-open]); every other banner through banner.ts's findBanner
// (known consent-tool selectors, then the strict heuristic), named with
// autoconsent's CMP when it detected one. Anything not measurable is listed in
// `unmeasured` and becomes a not-tested note — never a pass.

type Roles = Partial<Record<'accept' | 'reject' | 'manage' | 'close', string>>;

// Widgets consent tools float on the page after a choice (the persistent
// "reopen" control the EDPB taskforce expects, CBTF ¶¶31–35).
const KNOWN_WIDGETS = [
  '#ot-sdk-btn-floating',
  '.ot-floating-button',
  '#CookiebotWidget',
  '.cky-btn-revisit-wrapper',
  '.cmplz-manage-consent',
  '.osano-cm-window__widget',
  '.termly-display-preferences',
  '#usercentrics-cmp-ui [data-testid="uc-privacy-button"]',
  '[data-testid="uc-privacy-button"]',
  '.cc-revoke',
  '#didomi-host .didomi-notice-preferences-button',
];

// Reopen APIs (names only — not called here; banner.ts reopenSettings calls them).
const REOPEN_APIS: Array<[string, string[]]> = [
  ['ComplyKit.open', ['ComplyKit', 'open']],
  ['OneTrust.ToggleInfoDisplay', ['OneTrust', 'ToggleInfoDisplay']],
  ['Cookiebot.renew', ['Cookiebot', 'renew']],
  ['UC_UI.showSecondLayer', ['UC_UI', 'showSecondLayer']],
  ['Didomi.preferences.show', ['Didomi', 'preferences', 'show']],
  ['revisitCkyConsent', ['revisitCkyConsent']],
  ['klaro.show', ['klaro', 'show']],
  ['CookieConsent.showPreferences', ['CookieConsent', 'showPreferences']],
  ['Osano.cm.showDrawer', ['Osano', 'cm', 'showDrawer']],
];

const OPT_OUT_WORDS = /do not sell|do not share|privacy choices|opt[- ]?out|sale of (my )?personal|limit the use of my|sell or share/i;
const CONSENT_CONTEXT = /cookie|consent|tracking|privacy|personal (data|information)|gdpr|similar technolog|preferences|datenschutz|confidentialit/i;

/**
 * The one in-page probe. Serialized into the page by Playwright, so it is
 * self-contained: no closures over module scope. `mode` picks what to read.
 */
interface ProbeArgs {
  mode: 'first' | 'after';
  roles: Roles;
  rootSel?: string;
  widgets: string[];
  apis: Array<[string, string[]]>;
  withdrawal: string;
  optOut: string;
}

/* eslint-disable @typescript-eslint/no-explicit-any */
function probe(args: ProbeArgs): any {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
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
    return out;
  };
  const up = (e: Element): Element | null => e.parentElement ?? ((e.getRootNode() as ShadowRoot).host ?? null);
  const contains = (a: Element, b: Element | null): boolean => {
    for (let e: Element | null = b; e; e = up(e)) if (e === a) return true;
    return false;
  };
  const rendered = (el: Element): boolean => {
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    return r.width > 1 && r.height > 1 && cs.visibility !== 'hidden' && cs.display !== 'none' && Number(cs.opacity) > 0.05;
  };
  const alphaOf = (c: string): number => {
    const t = c.trim().toLowerCase();
    if (t === 'transparent') return 0;
    const m = /[,/]\s*([\d.]+)(%?)\s*\)$/.exec(t);
    if (!m || /^rgb\(\s*[\d.]+\s*,\s*[\d.]+\s*,\s*[\d.]+\s*\)$/.test(t)) return 1;
    return m[2] ? Number(m[1]) / 100 : Number(m[1]);
  };
  const backgrounds = (el: Element): { stack: string[]; image: boolean } => {
    const stack: string[] = [];
    for (let e: Element | null = el; e; e = up(e)) {
      const cs = getComputedStyle(e);
      if (cs.backgroundImage && cs.backgroundImage !== 'none') return { stack, image: true };
      stack.push(cs.backgroundColor);
      if (alphaOf(cs.backgroundColor) >= 0.999) break;
    }
    return { stack, image: false };
  };
  const labelOf = (el: Element): string =>
    (((el as HTMLElement).innerText || el.textContent || '') || (el as HTMLInputElement).value || el.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim().slice(0, 120);
  const hitAt = (x: number, y: number, near: Element): Element | null => {
    const root = near.getRootNode() as Document | ShadowRoot;
    const fromRoot = typeof (root as Document).elementFromPoint === 'function' ? (root as Document).elementFromPoint(x, y) : null;
    return fromRoot ?? document.elementFromPoint(x, y);
  };

  // Page usability behind whatever is on top (cookie wall).
  const blocking = (root: Element | null): any => {
    const html = getComputedStyle(document.documentElement);
    const body = document.body ? getComputedStyle(document.body) : html;
    const locked = (cs: CSSStyleDeclaration): boolean => cs.overflowY === 'hidden' || cs.overflowY === 'clip' || cs.overflow === 'hidden';
    const scrollLocked = locked(html) || locked(body) || body.position === 'fixed';
    const se = document.scrollingElement ?? document.documentElement;
    const scrollable = Math.max(se.scrollHeight, document.body?.scrollHeight ?? 0) > vh + 4;
    const modal = root ? (() => {
      try {
        return root.matches(':modal');
      } catch {
        return false;
      }
    })() : false;
    const main = document.querySelector('main, [role="main"]');
    const inertMain = Boolean(main && main.closest('[inert], [aria-hidden="true"]'));
    const siblings = Array.from(document.body?.children ?? []).filter((c) => !['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'LINK'].includes(c.tagName) && !(root && contains(c, root)) && rendered(c));
    const inertSiblings = siblings.length > 0 && siblings.every((c) => c.hasAttribute('inert') || c.getAttribute('aria-hidden') === 'true');
    const rb = root?.getBoundingClientRect();
    let samples = 0;
    let hits = 0;
    const veil = (e: Element | null): boolean => {
      for (let a: Element | null = e; a; a = up(a)) {
        const cs = getComputedStyle(a);
        if (cs.position === 'fixed' || cs.position === 'sticky') {
          const r = a.getBoundingClientRect();
          return r.width * r.height >= 0.8 * vw * vh;
        }
      }
      return false;
    };
    for (let i = 0; i < 6; i++) {
      for (let j = 0; j < 6; j++) {
        const x = Math.round(((i + 0.5) / 6) * vw);
        const y = Math.round(((j + 0.5) / 6) * vh);
        if (rb && x >= rb.left && x <= rb.right && y >= rb.top && y <= rb.bottom) continue;
        samples++;
        const hit = document.elementFromPoint(x, y);
        if ((root && contains(root, hit)) || veil(hit)) hits++;
      }
    }
    return { covered: samples ? hits / samples : 1, inert: modal || inertMain || inertSiblings, scrollLocked, scrollable };
  };

  if (args.mode === 'after') {
    const root = args.rootSel ? deepAll(args.rootSel).find(rendered) ?? null : null;
    const controls: any[] = [];
    const ck = [...deepAll('#complykit-ui .ck-choices'), ...deepAll('[data-complykit-open]')].filter(rendered);
    for (const el of ck) controls.push({ text: labelOf(el), via: 'complykit', inFooter: Boolean(el.closest('footer, [role="contentinfo"]')) });
    for (const sel of args.widgets) {
      const el = deepAll(sel).find(rendered);
      if (el) controls.push({ text: labelOf(el) || el.getAttribute('title') || sel, via: 'known-widget', inFooter: false });
    }
    const re = new RegExp(args.withdrawal, 'i');
    for (const el of deepAll('a, button, [role="button"]')) {
      const text = labelOf(el);
      const aria = el.getAttribute('aria-label') ?? '';
      if (!(re.test(text) || re.test(aria)) || text.length > 80 || !rendered(el)) continue;
      if (controls.some((c) => c.text === text)) continue;
      controls.push({ text: text || aria, via: 'link', inFooter: Boolean(el.closest('footer, [role="contentinfo"]')) });
      if (controls.length > 12) break;
    }
    const w = window as any;
    let api: string | undefined;
    for (const [name, path] of args.apis) {
      let o: any = w;
      for (const k of path) o = o == null ? undefined : o[k];
      if (typeof o === 'function') {
        api = name;
        break;
      }
    }
    return { bannerVisible: Boolean(root), blocking: blocking(root), controls, api };
  }

  // --- first layer ---
  const els: Record<string, Element | undefined> = {};
  for (const [role, sel] of Object.entries(args.roles)) {
    if (!sel) continue;
    const el = deepAll(sel).find(rendered) ?? deepAll(sel)[0];
    if (el) els[role] = el;
  }
  let root: Element | null = args.rootSel ? deepAll(args.rootSel).find(rendered) ?? null : null;
  if (!root) {
    const list = Object.values(els).filter((e): e is Element => Boolean(e));
    if (list.length) {
      const chain = (e: Element): Element[] => {
        const out: Element[] = [];
        for (let a: Element | null = e; a; a = up(a)) out.push(a);
        return out;
      };
      const first = chain(list[0]);
      let lca: Element = first.find((a) => list.every((e) => contains(a, e))) ?? list[0];
      // Climb to the banner container: the nearest positioned / dialog ancestor.
      let pick: Element | null = null;
      let n = 0;
      for (let a: Element | null = lca; a && a !== document.body && n < 10; a = up(a), n++) {
        const cs = getComputedStyle(a);
        const role = a.getAttribute('role') ?? '';
        if (a.tagName === 'DIALOG' || ['dialog', 'alertdialog', 'region'].includes(role) || cs.position === 'fixed' || cs.position === 'sticky') {
          pick = a;
          break;
        }
      }
      if (!pick && list.includes(lca) && up(lca)) lca = up(lca)!;
      root = pick ?? lca;
    }
  }
  if (!root) return { found: false };
  const order = Object.entries(els)
    .filter((x): x is [string, Element] => Boolean(x[1]))
    .sort((a, b) => (a[1].compareDocumentPosition(b[1]) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1))
    .map(([role]) => role);
  const controls = Object.entries(els)
    .filter((x): x is [string, Element] => Boolean(x[1]))
    .map(([role, el]) => {
      const r = el.getBoundingClientRect();
      const cs = getComputedStyle(el);
      const bg = backgrounds(el);
      const sides = ['Top', 'Right', 'Bottom', 'Left'] as const;
      const bordered = sides.some((s) => parseFloat((cs as any)[`border${s}Width`]) > 0 && (cs as any)[`border${s}Style`] !== 'none' && alphaOf((cs as any)[`border${s}Color`]) > 0.1);
      const cx = r.left + r.width / 2;
      const cy = r.top + r.height / 2;
      const inViewport = r.width > 0 && r.top >= -1 && r.left >= -1 && r.bottom <= vh + 1 && r.right <= vw + 1;
      const hit = inViewport ? hitAt(cx, cy, el) : null;
      const weight = /^\d+$/.test(cs.fontWeight) ? Number(cs.fontWeight) : cs.fontWeight === 'bold' ? 700 : 400;
      return {
        role,
        tag: el.tagName.toLowerCase(),
        text: labelOf(el),
        box: { x: r.x, y: r.y, width: r.width, height: r.height },
        fontSizePx: parseFloat(cs.fontSize) || 0,
        fontWeight: weight,
        color: cs.color,
        backgrounds: bg.stack,
        backgroundImage: bg.image,
        bordered,
        inViewport,
        reachable: Boolean(hit && (hit === el || contains(el, hit))),
        domIndex: order.indexOf(role),
      };
    });
  const rb = root.getBoundingClientRect();
  const rootBg = backgrounds(root);
  const text = (((root as HTMLElement).innerText || (root.shadowRoot?.textContent ?? '') || root.textContent || '') as string).replace(/\s+/g, ' ').trim().slice(0, 3000);
  const links = deepAll('a[href]', root)
    .map((a) => ({ text: labelOf(a), href: (a as HTMLAnchorElement).href || undefined }))
    .filter((l) => l.text)
    .slice(0, 20);
  const optRe = new RegExp(args.optOut, 'i');
  const optOutLinks = deepAll('a, button, [role="button"]')
    .filter((el) => {
      const t = labelOf(el);
      return t && t.length <= 100 && optRe.test(t) && rendered(el);
    })
    .slice(0, 10)
    .map((el) => ({ text: labelOf(el), href: (el as HTMLAnchorElement).href || undefined, inFooter: Boolean(el.closest('footer, [role="contentinfo"]')) }));
  let modal = false;
  try {
    modal = root.matches(':modal');
  } catch {
    modal = false;
  }
  return {
    found: true,
    bannerBox: { x: rb.x, y: rb.y, width: rb.width, height: rb.height },
    bannerBackgrounds: rootBg.image ? [] : rootBg.stack,
    bannerBackgroundImage: rootBg.image,
    modal,
    controls,
    text,
    links,
    blocking: blocking(root),
    optOutLinks,
  };
}
/* eslint-enable @typescript-eslint/no-explicit-any */

async function complykitPresent(page: Page): Promise<{ present: boolean; bannerShown: boolean }> {
  return page
    .evaluate(() => {
      const present = Boolean(document.getElementById('complykit-config') || document.getElementById('complykit-ui'));
      const b = document.querySelector('#complykit-ui .ck-banner');
      const r = b?.getBoundingClientRect();
      const shown = Boolean(b && r && r.width > 1 && r.height > 1 && !(b as HTMLElement).hidden && getComputedStyle(b).display !== 'none');
      return { present, bannerShown: shown };
    })
    .catch(() => ({ present: false, bannerShown: false }));
}

const CK_ROLES: Roles = {
  accept: '#complykit-ui .ck-banner .ck-btn[data-ck-action="accept"]',
  reject: '#complykit-ui .ck-banner .ck-btn[data-ck-action="reject"]',
  manage: '#complykit-ui .ck-banner .ck-btn[data-ck-action="manage"]',
  close: '#complykit-ui .ck-banner .ck-btn[data-ck-action="close"]',
};

/** The first layer, read without clicking anything. `cmp` = autoconsent's name for the tool, when it detected one. */
export async function readFirstLayer(page: Page, cmp?: string): Promise<BannerFirstLayer> {
  const unmeasured: string[] = [];
  const ck = await complykitPresent(page);
  let source: BannerSource | undefined;
  let roles: Roles = {};
  let rootSel: string | undefined;
  let name = cmp;
  if (ck.bannerShown) {
    source = 'complykit';
    roles = CK_ROLES;
    rootSel = '#complykit-ui .ck-banner';
    name = 'complykit';
  } else {
    const found = await findBanner(page);
    if (found) {
      source = found.via.startsWith('selector:') ? 'known-selector' : 'heuristic';
      if (found.via.startsWith('selector:')) name = found.via.slice('selector:'.length);
      roles = { accept: found.accept, reject: found.reject, manage: found.manage, close: found.close };
    }
  }
  let raw: Record<string, unknown> = { found: false };
  try {
    raw = (await page.evaluate(probe, { mode: 'first', roles, rootSel, widgets: KNOWN_WIDGETS, apis: REOPEN_APIS, withdrawal: WITHDRAWAL_LINK_TEXT.source, optOut: OPT_OUT_WORDS.source } satisfies ProbeArgs)) as Record<string, unknown>;
  } catch (err) {
    unmeasured.push(`banner design: the page could not be measured (${err instanceof Error ? err.message.slice(0, 80) : 'error'})`);
  }
  if (!source && raw.found !== true) {
    // A banner that autoconsent saw, or that lives in a consent-tool frame, but we can't read.
    if (cmp || (await consentFrameVisible(page))) {
      unmeasured.push(`banner design: the consent banner${cmp ? ` (${cmp})` : ''} could not be read in the page (cross-origin frame or closed shadow root) — equal prominence, required wording and cookie wall not tested`);
    }
    raw = { ...raw, found: false, controls: [], links: [] };
  }
  if (raw.bannerBackgroundImage) unmeasured.push('banner design: the banner has a background image — control emphasis against it not measured');
  const parsed = BannerFirstLayer.safeParse({ ...raw, source: raw.found ? source : undefined, cmp: name, complykit: ck.present, unmeasured });
  if (!parsed.success) {
    return BannerFirstLayer.parse({ found: false, complykit: ck.present, unmeasured: [...unmeasured, `banner design: readout did not validate (${parsed.error.issues[0]?.message ?? 'invalid'})`] });
  }
  const r = parsed.data;
  if (r.found) {
    for (const role of ['accept', 'reject'] as const) {
      const c = r.controls.find((x) => x.role === role);
      if (c && controlTextContrast(c) === undefined) r.unmeasured.push(`banner design: text contrast of the ${role} control not measurable (background image or unparseable color)`);
    }
    if (r.text && !looksEnglish(r.text)) r.unmeasured.push('banner design: banner text is not English — required wording not tested (the wording checks are English)');
    if (r.source === 'heuristic' && !r.controls.some((c) => c.role === 'reject')) {
      r.unmeasured.push('banner design: banner found by the heuristic and no reject control matched its wording — a reject with unusual wording would be missed');
    }
  }
  return r;
}

/** Toggles of the settings layer. With `open`, opens the settings when nothing is in the DOM (ComplyKit.open, else the banner's manage control). */
export async function readSecondLayer(page: Page, open: boolean): Promise<BannerSecondLayer> {
  const read = async (): Promise<{ toggles: unknown[]; source?: string }> =>
    page
      .evaluate(
        ({ ctx }) => {
          const ctxRe = new RegExp(ctx, 'i');
          const deepAll = (sel: string): Element[] => {
            const out: Element[] = [];
            const visit = (r: Document | ShadowRoot): void => {
              out.push(...Array.from(r.querySelectorAll(sel)));
              for (const el of Array.from(r.querySelectorAll('*'))) if (el.shadowRoot) visit(el.shadowRoot);
            };
            visit(document);
            return out;
          };
          const up = (e: Element): Element | null => e.parentElement ?? ((e.getRootNode() as ShadowRoot).host ?? null);
          const ck = document.querySelector('#complykit-ui .ck-settings');
          if (ck) {
            const toggles = Array.from(ck.querySelectorAll('.ck-category')).map((cat) => {
              const box = cat.querySelector<HTMLInputElement>('.ck-toggle');
              return {
                label: (cat.querySelector('.ck-category-label')?.textContent ?? cat.getAttribute('data-ck-category') ?? '').trim().slice(0, 120),
                checked: Boolean(box?.checked),
                disabled: Boolean(box?.disabled) || cat.hasAttribute('data-ck-locked'),
                kind: 'checkbox',
                category: cat.getAttribute('data-ck-category') ?? undefined,
              };
            });
            if (toggles.length) return { toggles, source: 'complykit' };
          }
          const out: unknown[] = [];
          for (const b of deepAll('input[type="checkbox"], [role="switch"]')) {
            // Inside a consent container: some ancestor within 12 levels speaks about cookies/consent.
            let inConsent = false;
            let n = 0;
            for (let a: Element | null = up(b); a && a !== document.body && n < 12; a = up(a), n++) {
              const id = `${a.id} ${typeof a.className === 'string' ? a.className : ''}`;
              if (/cookie|consent|onetrust|optanon|cybot|didomi|usercentrics|cky|cmplz|osano|privacy|truste|qc-cmp/i.test(id)) {
                inConsent = true;
                break;
              }
            }
            if (!inConsent) continue;
            const el = b as HTMLElement;
            const input = el instanceof HTMLInputElement ? el : null;
            const labelFor = el.id ? document.querySelector(`label[for="${CSS.escape(el.id)}"]`)?.textContent ?? '' : '';
            const label = `${el.getAttribute('aria-label') ?? ''} ${labelFor} ${el.closest('label')?.textContent ?? ''} ${labelFor || el.closest('label') ? '' : el.parentElement?.textContent ?? ''}`.replace(/\s+/g, ' ').trim().slice(0, 120);
            if (!label && !ctxRe.test(input?.name ?? '')) continue;
            const isSwitch = el.getAttribute('role') === 'switch' && !input;
            out.push({
              label: label || input?.name || el.id,
              checked: isSwitch || !input ? el.getAttribute('aria-checked') === 'true' : input.checked,
              disabled: Boolean(input?.disabled) || el.getAttribute('aria-disabled') === 'true',
              kind: isSwitch ? 'switch' : 'checkbox',
            });
            if (out.length >= 60) break;
          }
          return { toggles: out };
        },
        { ctx: CONSENT_CONTEXT.source },
      )
      .catch(() => ({ toggles: [] as unknown[] }));
  let r = await read();
  let via: 'dom' | 'opened' | 'not-found' = r.toggles.length ? 'dom' : 'not-found';
  const unmeasured: string[] = [];
  if (!r.toggles.length && open) {
    const opened = await page
      .evaluate(() => {
        const w = window as unknown as { ComplyKit?: { open?: () => void } };
        if (typeof w.ComplyKit?.open === 'function') {
          w.ComplyKit.open();
          return true;
        }
        return false;
      })
      .catch(() => false);
    if (!opened) {
      const b = await findBanner(page);
      if (b?.manage) await page.click(b.manage, { timeout: 4000 }).catch(() => {});
    }
    await page.waitForTimeout(900);
    r = await read();
    via = r.toggles.length ? 'opened' : 'not-found';
  }
  if (via === 'not-found') unmeasured.push('banner design: no category toggles found in the settings layer — pre-ticked boxes not tested');
  const parsed = BannerSecondLayer.safeParse({ source: r.source, via, toggles: r.toggles, unmeasured });
  return parsed.success ? parsed.data : BannerSecondLayer.parse({ via: 'not-found', unmeasured: ['banner design: settings-layer readout did not validate — pre-ticked boxes not tested'] });
}

/** After a choice: banner gone, page usable, a visible way back into the settings. */
export async function readAfterChoice(page: Page, choice: 'accept' | 'reject'): Promise<BannerAfterChoice> {
  const unmeasured: string[] = [];
  const ck = await complykitPresent(page);
  let rootSel: string | undefined;
  if (ck.bannerShown) rootSel = '#complykit-ui .ck-banner';
  else {
    const b = await findBanner(page);
    // findBanner tags controls, not the container; the accept control stands in for "still showing".
    if (b) rootSel = b.accept ?? b.reject ?? b.manage;
  }
  let raw: Record<string, unknown> = {};
  try {
    raw = (await page.evaluate(probe, { mode: 'after', roles: {}, rootSel, widgets: KNOWN_WIDGETS, apis: REOPEN_APIS, withdrawal: WITHDRAWAL_LINK_TEXT.source, optOut: OPT_OUT_WORDS.source } satisfies ProbeArgs)) as Record<string, unknown>;
  } catch (err) {
    unmeasured.push(`banner design: page after the ${choice} could not be measured (${err instanceof Error ? err.message.slice(0, 80) : 'error'}) — withdrawal control not tested`);
  }
  const parsed = BannerAfterChoice.safeParse({ choice, bannerVisible: Boolean(raw.bannerVisible), blocking: raw.blocking, controls: raw.controls ?? [], api: raw.api, unmeasured });
  return parsed.success ? parsed.data : BannerAfterChoice.parse({ choice, bannerVisible: false, unmeasured: [...unmeasured, 'banner design: after-choice readout did not validate — withdrawal control not tested'] });
}
