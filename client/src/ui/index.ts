// The banner and settings layer (ticket D9): functional, accessible, unstyled.
// Lives in the UI file (complykit-consent-ui.js), which the core loads (see
// src/ui-loader.ts) and which mounts on the core's host (`ComplyKit._ui`) —
// it never imports the store or the API itself. A refused config starts no
// store, so the UI file is never requested and gated scripts stay inert. The banner shows while `store.needsChoice()`; the settings layer opens
// from the banner's Manage button, from `ComplyKit.open()` (store 'open'), and
// from any element the site marks `data-complykit-open`. Once a choice exists,
// a persistent "Privacy choices" button re-opens the settings layer, where
// Reject all is the withdrawal (store.withdraw(): 'withdraw' event, record).
//
// Placement of the Privacy choices button: `data-complykit-choices` on the
// tool's own <script> tag — "bottom-left" (default), "bottom-right", or "none".
// When the attribute is absent and the page already has a
// `[data-complykit-open]` element, the site's own link is the control and ours
// is not rendered.
//
// Page blocking: config.blockPage (default false), any layout. While a choice
// is owed the page behind is inert, scrolling is locked and bar / box get a
// .ck-backdrop; the choice releases all of it (see ./block.ts).
//
// Styling and theming (F1). The default look is the floating card from the
// banner mockup (plans/banner-design.md): white card, cookie art on the left,
// bold title, muted body, a filled Accept and a same-size outlined Reject, and
// Manage as an underlined link beneath them; on narrow screens the art sits on
// top and the buttons stack full width, Accept first.
// config.theme becomes --ck-* custom properties on the root, after the
// defaults (bg #fff, fg #111, muted #3a3a38, border #e2e2df, accent #111,
// accentText #fff, icon = fg, radius 16px; headingFont unset = the page font).
// config.appearance switches the art (icon), Accept's fill (accept), Manage as
// link or button (manage) and the box corner (position). All rules sit in
// :where() (zero specificity) so any site or theme rule wins.
// Layouts come from config.layout: box (default; the card, bottom-left), bar
// (full-width strip), modal. Stable hooks:
//
//   #complykit-ui.ck-root[data-ck-accept=filled|outline]
//                                      container, first child of <body>
//   .ck-banner[data-ck-layout=bar|box|modal][data-ck-position=left|right]
//            [data-ck-manage=link|button]
//                                      first layer (div[role=region] or <dialog>)
//   .ck-banner > svg.ck-art (> g.ck-art-steam, g.ck-art-cookie)
//                                      cookie illustration (aria-hidden)
//   .ck-banner > .ck-content           title, body, notes, actions, links
//   .ck-settings                       second layer (<dialog>)
//   .ck-title, .ck-body                heading and paragraph in either layer
//   .ck-actions                        button row
//   .ck-sub                            the line holding Manage when it is a link
//   .ck-btn[data-ck-action=accept|reject|manage|save|close]
//                                      every button; reject and accept share
//                                      one class on purpose (same size and type)
//   .ck-categories > .ck-category[data-ck-category=<id>][data-ck-locked]
//   .ck-toggle (checkbox), .ck-category-label, .ck-category-desc
//   .ck-vendors > .ck-vendor[data-ck-vendor=<id>]
//   .ck-choices[data-ck-position=bottom-left|bottom-right]
//                                      the persistent Privacy choices button (same
//                                      attribute name as the banner's, other values)
//   .ck-backdrop                       full-viewport veil (blockPage, bar / box)
//   .ck-sr                             visually hidden live status
//   .ck-note[data-ck-note=gpc|withdraw] GPC-honored / withdrawal notes (F2)
//   .ck-links > a.ck-link[data-ck-action=privacy-policy]
//                                      privacy-policy link, after the actions (F2)
//   .ck-choices > svg.ck-icon          CPPA opt-out icon, opt-out-signal only (F2)
//   CSS custom properties: --ck-bg, --ck-fg, --ck-muted, --ck-border,
//   --ck-accent (Accept fill, toggles), --ck-accent-text, --ck-icon (steam),
//   --ck-radius (card; buttons take 9/16 of it), --ck-heading-font.

import type { ConsentState } from '../store.js';
import { createBanner } from './banner.js';
import { createSettings } from './settings.js';
import { h } from './dom.js';
import { createBlock } from './block.js';
import { t } from './strings.js';
import { choicesContent } from './copy.js';
import { CHOICES_ATTR, OPEN_ATTR, host, setHost, type UiHost } from './host.js';

// Zero specificity throughout (:where): a site rule of any weight wins. Accept
// and Reject (and every other .ck-btn) get the same box rule, so their size,
// border width, radius and type are identical by construction; the only
// difference is Accept's fill (appearance.accept 'filled', the default) — Reject
// keeps a full-contrast border, which the equal-prominence rule requires.
const BTN = ':where(.ck-btn)';
const ACCEPT = ':where(.ck-root:not([data-ck-accept=outline])) :where(.ck-btn[data-ck-action=accept])';
const LINK = ':where(.ck-banner[data-ck-manage=link]) :where([data-ck-action=manage])';
const LAYER = ':where(.ck-banner,.ck-settings)';
const BOX = ':where(.ck-banner[data-ck-layout=box]:not(dialog))';
const CSS = [
  ':where(.ck-root){font:inherit;color-scheme:light;--ck-bg:#fff;--ck-fg:#111;--ck-muted:#3a3a38;--ck-border:#e2e2df;--ck-accent:#111;--ck-accent-text:#fff;--ck-icon:var(--ck-fg);--ck-radius:16px}',
  ':where(.ck-root *){box-sizing:border-box}',
  // layers: shared look, then placement per layout
  LAYER + '{font:inherit;font-size:16px;background:var(--ck-bg);color:var(--ck-fg);border:1px solid var(--ck-border);border-radius:var(--ck-radius);padding:30px 34px 30px 30px;line-height:1.5;max-height:90vh;overflow:auto;box-shadow:0 14px 40px rgba(0,0,0,.14)}',
  ':where(.ck-banner:not(dialog),dialog.ck-banner[open]){display:flex;gap:26px;align-items:flex-start}',
  ':where(.ck-root [hidden]){display:none}',
  ':where(.ck-banner:not(dialog)){position:fixed;z-index:2147483000;left:0;right:0;bottom:0;border-radius:0;border-width:1px 0 0;justify-content:center;padding-inline:max(30px,calc(50% - 440px))}',
  BOX + '{left:40px;right:auto;bottom:40px;width:min(880px,calc(100vw - 80px));border-width:1px;border-radius:var(--ck-radius);padding-inline:30px 34px;justify-content:flex-start}',
  ':where(.ck-banner[data-ck-layout=box][data-ck-position=right]:not(dialog)){left:auto;right:40px}',
  ':where(dialog.ck-banner){width:min(880px,calc(100vw - 32px))}',
  ':where(.ck-settings){width:min(36rem,calc(100vw - 32px))}',
  LAYER + '::backdrop,:where(.ck-backdrop){background:rgba(0,0,0,.5)}',
  ':where(.ck-backdrop){position:fixed;inset:0;z-index:2147482999}',
  // the cookie art: steam in --ck-icon, the cookie in the text color
  ':where(.ck-art){flex:0 0 auto;width:112px;height:126px;margin-top:-10px;stroke:var(--ck-fg)}',
  ':where(.ck-art-steam){stroke:var(--ck-icon)}',
  ':where(.ck-content){flex:1;min-width:0;max-width:760px}',
  // no --ck-heading-font: the declaration is dropped and the title keeps the inherited page font
  ':where(.ck-title){font:inherit;font-size:24px;font-weight:700;line-height:1.15;font-family:var(--ck-heading-font);letter-spacing:-.01em;margin:0 0 8px}',
  ':where(.ck-body){margin:0 0 22px;color:var(--ck-muted);font-size:15.5px;max-width:640px}',
  ':where(.ck-settings) :where(.ck-body){margin-bottom:16px}',
  // F2 pieces: GPC / withdrawal notes, the privacy-policy link (layer colors,
  // underlined: it never borrows the UA's link blue), the CPPA icon on the text line
  ':where(.ck-note){margin:0 0 16px;padding-left:10px;border-left:3px solid var(--ck-border);color:var(--ck-muted);font-size:14px}',
  ':where(.ck-links){margin:12px 0 0;font-size:14px}',
  ':where(.ck-link){color:inherit;text-decoration:underline;text-underline-offset:4px}',
  ':where(.ck-icon){vertical-align:middle}',
  ':where(.ck-actions){display:flex;flex-wrap:wrap;align-items:center;gap:14px}',
  // buttons: one box rule for all of them, then Accept's fill and Manage as a link
  BTN + '{font:inherit;font-size:15px;font-weight:600;line-height:1.2;min-height:46px;padding:8px 24px;color:var(--ck-fg);background:transparent;border:1.5px solid var(--ck-fg);border-radius:calc(var(--ck-radius) * .5625);cursor:pointer;text-align:center}',
  ACCEPT + '{background:var(--ck-accent);color:var(--ck-accent-text);border-color:var(--ck-accent)}',
  ':where(.ck-sub){margin:14px 0 0}',
  LINK + '{min-height:0;padding:0;border:0;border-radius:0;background:none;font-size:14px;text-decoration:underline;text-underline-offset:4px}',
  ':where(.ck-choices){position:fixed;z-index:2147483000;bottom:16px;left:16px;min-height:0;padding:6px 14px;font-size:14px;font-weight:500;background:var(--ck-bg);border:1px solid var(--ck-border);box-shadow:0 4px 14px rgba(0,0,0,.12)}',
  ':where(.ck-choices[data-ck-position=bottom-right]){left:auto;right:16px}',
  // settings categories
  ':where(.ck-categories){margin:0 0 20px}',
  ':where(.ck-category){display:grid;grid-template-columns:auto 1fr;column-gap:12px;align-items:center;padding:12px 0;border-top:1px solid var(--ck-border)}',
  ':where(.ck-toggle){width:20px;height:20px;margin:0;accent-color:var(--ck-accent)}',
  ':where(.ck-category-label){font-weight:600}',
  ':where(.ck-category-desc,.ck-vendors){grid-column:2;margin:4px 0 0;font-size:14px;color:var(--ck-muted)}',
  ':where(.ck-vendors){padding:0;list-style:none;display:flex;flex-wrap:wrap;gap:4px 12px}',
  // focus
  ':where(.ck-root :focus-visible){outline:2px solid var(--ck-fg);outline-offset:3px}',
  ':where(.ck-root [tabindex="-1"]:focus-visible){outline:none}',
  // narrow screens: card full width with a 16px gutter, art on top, buttons stacked full width (Accept first), Manage centred
  '@media (max-width:720px){' +
    BOX + '{left:16px;right:16px;bottom:16px;width:auto}' +
    ':where(.ck-banner:not(dialog),dialog.ck-banner[open]){flex-direction:column;gap:6px;padding:20px}' +
    ':where(.ck-settings){padding:20px}' +
    ':where(.ck-art){width:60px;height:68px;margin-top:0}' +
    ':where(.ck-content){width:100%}' +
    ':where(.ck-title){font-size:21px}' +
    ':where(.ck-body){font-size:15px;margin-bottom:18px}' +
    ':where(.ck-actions){flex-direction:column;align-items:stretch;gap:10px}' +
    BTN + '{min-height:48px}' +
    ':where(.ck-sub,.ck-links){margin-top:4px;text-align:center}' +
    LINK + '{min-height:44px;width:100%}' +
  '}',
  // short screens (a small phone, a landscape phone): no art, tighter spacing, so Reject stays on screen
  '@media (max-height:600px){:where(.ck-banner) :where(.ck-art){display:none}:where(.ck-body){margin-bottom:12px}:where(.ck-banner:not(dialog),dialog.ck-banner[open]){padding-block:16px}}',
  '@media (prefers-reduced-motion:no-preference){' + BTN + '{transition:background-color .15s,border-color .15s}}',
  '@media (prefers-reduced-motion:reduce){:where(.ck-root,.ck-root *){transition:none;animation:none}}',
  ':where(.ck-sr){position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}',
].join('');

// Theme tokens go into the same zero-specificity layer as the defaults, after
// them, so they replace the defaults and the site's own CSS still wins. Values
// are config text: only plain CSS value characters pass (no url(), braces,
// semicolons, comments); anything else is dropped and the default applies.
const THEME_KEYS = { bg: 'bg', fg: 'fg', accent: 'accent', border: 'border', radius: 'radius', muted: 'muted', accentText: 'accent-text', icon: 'icon', headingFont: 'heading-font' } as const;
// headingFont may quote family names ("Helvetica Neue"), balanced only: an open
// quote would swallow the rest of the rule.
const SAFE_VALUE = /^[\w\s#%.,()+/-]{1,64}$/;
const SAFE_FONT = /^[\w\s,'"-]{1,160}$/;
const balanced = (v: string): boolean => v.split('"').length % 2 === 1 && v.split("'").length % 2 === 1;
export function themeCss(theme: object | undefined): string {
  let css = '';
  for (const k in THEME_KEYS) {
    const v = (theme as Record<string, unknown> | undefined)?.[k];
    if (typeof v !== 'string' || !(k === 'headingFont' ? SAFE_FONT.test(v) && balanced(v) : SAFE_VALUE.test(v)) || /url|image|expression|var\(/i.test(v)) continue;
    css += `--ck-${THEME_KEYS[k as keyof typeof THEME_KEYS]}:${v.trim()};`;
  }
  return css ? `:where(.ck-root){${css}}` : '';
}

let mounted = false;

const granted = (s: ConsentState): boolean => Object.keys(s.categories).some((id) => id !== 'necessary' && s.categories[id]);

export function mountUi(h: UiHost): void {
  if (mounted || typeof document === 'undefined') return;
  mounted = true;
  setHost(h);
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', build);
  else build();
}

function build(): void {
  const H = host();
  const { getStore, on } = H;
  const ownScript = H.script;
  const config = H.getConfig();
  if (!config || !document.body) return;
  const attr = ownScript?.getAttribute(CHOICES_ATTR);
  const position = attr === 'none' || attr === 'bottom-right' || attr === 'bottom-left' ? attr : document.querySelector(`[${OPEN_ATTR}]`) ? 'none' : 'bottom-left';

  const status = h('div', { class: 'ck-sr', role: 'status' });
  const choices = h('button', { type: 'button', class: 'ck-btn ck-choices', 'data-ck-action': 'privacy-choices', 'data-ck-position': position, hidden: true });
  // Who asked for the settings layer (host.opener): focus goes back there when
  // it closes (document.activeElement is not reliable — Safari does not focus
  // clicked buttons). `data-complykit-open` clicks are caught by the core.
  const requestOpen = (from: Element): void => H.requestOpen(from);
  choices.addEventListener('click', () => requestOpen(choices));
  const choicesEl = (): HTMLElement | undefined => (choices.hidden ? undefined : choices);

  // Every choice goes through here. Reject after a choice that granted
  // something is a withdrawal (design §6: as easy as giving consent).
  const choose = (kind: 'accept' | 'reject' | 'save', via: 'banner' | 'settings', choice?: Record<string, boolean>): void => {
    const s = getStore();
    if (!s) return;
    settings.close();
    status.textContent = '';
    const before = s.state();
    if (kind === 'accept') s.acceptAll();
    else if (kind === 'save') s.set(choice ?? {});
    else if (before.status === 'chosen' && granted(before)) {
      s.withdraw();
      status.textContent = t('withdraw.confirm');
    } else {
      s.rejectAll();
      // Opt-out regimes: confirm the opt-out was processed (CCPA Regs §7026(g)).
      if (s.state().regime !== 'opt-in') status.textContent = t('optOut.confirmed');
    }
    H.report?.({ t: 'decide', action: kind, via, categories: s.state().categories });
  };

  const look = config.appearance ?? {};
  const banner = createBanner(
    config.layout,
    {
      accept: () => choose('accept', 'banner'),
      reject: () => choose('reject', 'banner'),
      manage: requestOpen,
    },
    look,
  );
  const settings = createSettings(
    config,
    { acceptAll: () => choose('accept', 'settings'), rejectAll: () => choose('reject', 'settings'), save: (c) => choose('save', 'settings', c) },
    () => choicesEl() ?? (banner.visible() ? (banner.el.querySelector('[data-ck-action=manage]') as HTMLElement) : undefined),
  );

  const openSettings = (): void => {
    const s = getStore();
    const from = H.opener;
    if (s) {
      if (!settings.isOpen()) H.report?.({ t: 'open', via: from && banner.el.contains(from) ? 'banner' : from === choices ? 'choices' : 'api' });
      settings.open(s.state().categories, from ?? document.activeElement);
    }
    H.opener = null;
  };

  // A location lookup still outstanding would flash the strict wording at a visitor it does not govern: hold the banner until it settles (the core bounds it by HEADER_TIMEOUT_MS).
  let locating = H.locationPending?.();
  void locating?.then(() => {
    locating = undefined;
    sync();
  });
  let shownWords = '';
  const sync = (): void => {
    const s = getStore();
    if (!s) return;
    const need = s.needsChoice();
    // The words depend on the regime, whether GPC counts, and whether the visitor's location holds something back
    // (it can change within one regime, say California to Texas): re-render if any moved (F2).
    const st = s.state();
    const words = `${st.regime}|${st.gpcHonored}|${st.location?.country}-${st.location?.region}`;
    if (words !== shownWords) {
      shownWords = words;
      choices.replaceChildren(...choicesContent());
      banner.refresh();
    }
    choices.hidden = need || position === 'none';
    if (need && !locating) {
      banner.show();
      H.report?.({ t: 'shown' }); // the beacon keeps the first
    }
    else banner.hide(choicesEl());
    block?.set(need);
  };

  const style = h('style', {}, CSS + themeCss(config.theme));
  if (ownScript?.nonce) style.nonce = ownScript.nonce;
  document.head.appendChild(style);

  const root = h('div', { id: 'complykit-ui', class: 'ck-root', 'data-ck-accept': look.accept === 'outline' ? 'outline' : 'filled' }, banner.el, choices, settings.el, status);
  const block = config.blockPage === true ? createBlock(root, config.layout !== 'modal') : undefined;
  if (block) root.prepend(block.el);
  document.body.prepend(root);

  on('change', sync);
  on('open', openSettings);
  H.mounted = true;
  sync();
  if (H.pendingOpen) {
    H.pendingOpen = false;
    openSettings();
  }
}
