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
// Styling and theming (F1). config.theme {bg,fg,accent,border,radius} becomes
// --ck-* custom properties on the root; with no bg/fg the layers use the system
// colors Canvas / CanvasText and follow prefers-color-scheme (color-scheme:
// light dark). Giving bg or fg pins color-scheme to light, so give both. All
// defaults sit in :where() (zero specificity) so any site or theme rule wins.
// Layouts come from config.layout: bar (default), box, modal. Stable hooks:
//
//   #complykit-ui.ck-root              container, first child of <body>
//   .ck-banner[data-ck-layout=bar|box|modal]
//                                      first layer (div[role=region] or <dialog>)
//   .ck-settings                       second layer (<dialog>)
//   .ck-title, .ck-body                heading and paragraph in either layer
//   .ck-actions                        button row
//   .ck-btn[data-ck-action=reject|accept|manage|save|close]
//                                      every button; reject and accept share
//                                      one class on purpose (equal weight)
//   .ck-categories > .ck-category[data-ck-category=<id>][data-ck-locked]
//   .ck-toggle (checkbox), .ck-category-label, .ck-category-desc
//   .ck-vendors > .ck-vendor[data-ck-vendor=<id>]
//   .ck-choices[data-ck-position=bottom-left|bottom-right]
//                                      the persistent Privacy choices button
//   .ck-sr                             visually hidden live status
//   .ck-note[data-ck-note=gpc|withdraw] GPC-honored / withdrawal notes (F2)
//   .ck-links > a.ck-link[data-ck-action=privacy-policy]
//                                      privacy-policy link, after the actions (F2)
//   .ck-choices > svg.ck-icon          CPPA opt-out icon, opt-out-signal only (F2)
//   CSS custom properties read by the defaults: --ck-bg, --ck-fg, --ck-accent
//   (focus rings, toggles, top edge; never on one button only), --ck-border,
//   --ck-radius.

import type { ConsentState } from '../store.js';
import { createBanner } from './banner.js';
import { createSettings } from './settings.js';
import { h } from './dom.js';
import { t } from './strings.js';
import { choicesContent } from './copy.js';
import { CHOICES_ATTR, OPEN_ATTR, host, setHost, type UiHost } from './host.js';

// Zero specificity throughout (:where): a site rule of any weight wins. Accept
// and Reject (and every other .ck-btn) get the same rule, so their size, border,
// colors and type are identical by construction; accent is never put on a
// button, only on focus rings, toggles and the layer's top edge.
const BTN = ':where(.ck-btn)';
const CSS = [
  ':where(.ck-root){font:inherit;color-scheme:light dark}',
  ':where(.ck-root[data-ck-themed]){color-scheme:light}',
  ':where(.ck-root *){box-sizing:border-box}',
  ':where(.ck-root [hidden]){display:none}',
  // layers: shared look, then placement per layout
  ':where(.ck-banner,.ck-settings){font:inherit;background:var(--ck-bg,Canvas);color:var(--ck-fg,CanvasText);border:1px solid var(--ck-border,GrayText);border-top:3px solid var(--ck-accent,var(--ck-border,GrayText));border-radius:var(--ck-radius,.375rem);padding:1rem;line-height:1.45;max-height:90vh;overflow:auto}',
  ':where(.ck-banner:not(dialog)){position:fixed;z-index:2147483000;left:0;right:0;bottom:0;border-radius:0;border-width:3px 0 0;border-top-color:var(--ck-accent,var(--ck-border,GrayText))}',
  ':where(.ck-banner[data-ck-layout=box]:not(dialog)){left:auto;right:1rem;bottom:1rem;width:min(28rem,calc(100vw - 2rem));border:1px solid var(--ck-border,GrayText);border-top:3px solid var(--ck-accent,var(--ck-border,GrayText));border-radius:var(--ck-radius,.375rem);box-shadow:0 .25rem 1.5rem rgba(0,0,0,.25)}',
  ':where(dialog.ck-banner,.ck-settings){width:min(34rem,calc(100vw - 2rem));box-shadow:0 .5rem 2rem rgba(0,0,0,.35)}',
  ':where(.ck-banner,.ck-settings)::backdrop{background:rgba(0,0,0,.5)}',
  ':where(.ck-banner[data-ck-layout=bar]:not(dialog)) :where(.ck-title,.ck-body,.ck-note,.ck-actions,.ck-links){max-width:60rem;margin-inline:auto}',
  ':where(.ck-title){font:inherit;font-size:1.125em;font-weight:700;margin:0 0 .5rem}',
  ':where(.ck-body){margin:0 0 1rem}',
  // F2 pieces: GPC / withdrawal notes, the privacy-policy link (layer colors,
  // underlined: it never borrows the UA's link blue, which fails on a dark
  // theme), the CPPA icon sitting on the text line
  ':where(.ck-note){margin:0 0 1rem;padding-left:.5rem;border-left:3px solid var(--ck-accent,var(--ck-border,GrayText));font-size:.875em}',
  ':where(.ck-links){margin:.75rem 0 0;font-size:.875em}',
  ':where(.ck-link){color:inherit;text-decoration:underline}',
  ':where(.ck-icon){vertical-align:middle}',
  ':where(.ck-actions){display:grid;gap:.5rem;grid-template-columns:repeat(auto-fit,minmax(8rem,1fr))}',
  // buttons: one rule for all of them
  BTN + '{font:inherit;line-height:1.2;min-height:2.5rem;padding:.5rem 1rem;color:var(--ck-fg,CanvasText);background:var(--ck-bg,Canvas);border:1px solid var(--ck-fg,CanvasText);border-radius:var(--ck-radius,.375rem);cursor:pointer;text-align:center}',
  ':where(.ck-choices){position:fixed;z-index:2147483000;bottom:1rem;left:1rem;min-height:0;padding:.375rem .75rem;font-size:.875em}',
  ':where(.ck-choices[data-ck-position=bottom-right]){left:auto;right:1rem}',
  // settings categories
  ':where(.ck-categories){margin:0 0 1rem}',
  ':where(.ck-category){display:grid;grid-template-columns:auto 1fr;column-gap:.75rem;align-items:center;padding:.75rem 0;border-top:1px solid var(--ck-border,GrayText)}',
  ':where(.ck-toggle){width:1.25rem;height:1.25rem;margin:0;accent-color:var(--ck-accent,auto)}',
  ':where(.ck-category-label){font-weight:600}',
  ':where(.ck-category-desc,.ck-vendors){grid-column:2;margin:.25rem 0 0;font-size:.875em}',
  ':where(.ck-vendors){padding:0;list-style:none;display:flex;flex-wrap:wrap;gap:.25rem .75rem;opacity:.85}',
  // focus
  ':where(.ck-root :focus-visible){outline:2px solid var(--ck-accent,currentColor);outline-offset:2px}',
  ':where(.ck-root [tabindex="-1"]:focus-visible){outline:none}',
  '@media (prefers-reduced-motion:no-preference){' + BTN + '{transition:background-color .15s,border-color .15s}}',
  '@media (prefers-reduced-motion:reduce){:where(.ck-root,.ck-root *){transition:none;animation:none}}',
  ':where(.ck-sr){position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}',
].join('');

// Theme tokens go into the same zero-specificity layer as the defaults, so the
// site's own CSS still wins. Values are config text: only plain CSS value
// characters pass (no url(), braces, semicolons, comments); anything else is
// dropped and the system-color default applies.
const THEME_KEYS = ['bg', 'fg', 'accent', 'border', 'radius'] as const;
const SAFE_VALUE = /^[\w\s#%.,()+/-]{1,64}$/;
export function themeCss(theme: object | undefined): { css: string; colored: boolean } {
  let css = '';
  let colored = false;
  for (const k of THEME_KEYS) {
    const v = (theme as Record<string, unknown> | undefined)?.[k];
    if (typeof v !== 'string' || !SAFE_VALUE.test(v) || /url|image|expression|var\(/i.test(v)) continue;
    css += `--ck-${k}:${v.trim()};`;
    if (k === 'bg' || k === 'fg') colored = true;
  }
  return { css: css ? `:where(.ck-root){${css}}` : '', colored };
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
  const choose = (kind: 'accept' | 'reject' | 'save', choice?: Record<string, boolean>): void => {
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
  };

  const banner = createBanner(config.layout, {
    accept: () => choose('accept'),
    reject: () => choose('reject'),
    manage: requestOpen,
  });
  const settings = createSettings(
    config,
    { acceptAll: () => choose('accept'), rejectAll: () => choose('reject'), save: (c) => choose('save', c) },
    () => choicesEl() ?? (banner.visible() ? (banner.el.querySelector('[data-ck-action=manage]') as HTMLElement) : undefined),
  );

  const openSettings = (): void => {
    const s = getStore();
    if (s) settings.open(s.state().categories, H.opener ?? document.activeElement);
    H.opener = null;
  };

  let shownWords = '';
  const sync = (): void => {
    const s = getStore();
    if (!s) return;
    const need = s.needsChoice();
    // The words depend on the regime (and GPC): re-render if either moved (F2).
    const st = s.state();
    const words = `${st.regime}|${st.gpc}`;
    if (words !== shownWords) {
      shownWords = words;
      choices.replaceChildren(...choicesContent());
      banner.refresh();
    }
    choices.hidden = need || position === 'none';
    if (need) banner.show();
    else banner.hide(choicesEl());
  };

  const themed = themeCss(config.theme);
  const style = h('style', {}, CSS + themed.css);
  if (ownScript?.nonce) style.nonce = ownScript.nonce;
  document.head.appendChild(style);

  const root = h('div', { id: 'complykit-ui', class: 'ck-root', 'data-ck-themed': themed.colored }, banner.el, choices, settings.el, status);
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
