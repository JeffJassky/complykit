// The first layer (ticket D9): the cookie illustration, a title, one paragraph,
// and the three choices — Accept all, Reject all, Manage choices. Accept and
// Reject are real buttons of the same element, class (`ck-btn`), size and type,
// adjacent on the same layer, so refusing is exactly as easy as accepting
// (research-consent-law.md: same layer, same level; CPPA §7004(a)(2)). Accept
// is filled by default and Reject outlined (config.appearance.accept): the
// equal-prominence rule (src/rules/consent/banner-design.ts) passes that shape
// because Reject keeps a visible border at the same size; a bare text link
// would not. Manage is the only control that may be demoted to a link
// (appearance.manage, default 'link'): it is not the refusal.
// There is no close button: closing is not a choice.
//
// Layouts (config.layout):
//   bar / box — a non-modal landmark (`role="region"`, aria-labelledby /
//               aria-describedby). Focus is never moved or trapped; the region
//               is the first thing in <body>, so Tab reaches it first.
//   modal     — a native <dialog> opened with showModal(): the page behind is
//               inert, focus moves to the dialog and stays inside it. Escape
//               does NOT dismiss it (a choice is still owed); if the browser
//               closes it anyway (repeat-Escape anti-abuse), it reopens.

import type { ConsentAppearance, ConsentLayout } from '../config.js';
import { button, focusIf, h, wrapTab } from './dom.js';
import { t } from './strings.js';
import { gpcNote, policyLink } from './copy.js';

export interface BannerActions {
  accept(): void;
  reject(): void;
  manage(opener: HTMLElement): void;
}

export interface Banner {
  el: HTMLElement;
  show(): void;
  /** Hide; when focus was inside, it goes to `next` (the Privacy choices control) or back where it came from. */
  hide(next?: HTMLElement): void;
  visible(): boolean;
  /** Re-render the words if shown (the regime or GPC changed while visible; F2). */
  refresh(): void;
}

// The cookie line art (decorative, aria-hidden). Steam strokes take --ck-icon,
// the cookie --ck-fg. [tag, attributes] in a 92×104 box.
const NS = 'http://www.w3.org/2000/svg';
const STEAM = ['M30 34c-4-5-4-9 0-14 4-5 4-9 0-14', 'M46 36c-4-6-4-11 0-17 4-6 4-11 0-17', 'M62 34c-4-5-4-9 0-14 4-5 4-9 0-14'];
// cx cy rx ry rotation
const CHIPS = '36 62 4 3 -20|54 60 3.6 2.7 25|30 78 3.4 2.6 10|46 88 4 3 -30|60 78 3.2 2.4 40|44 72 2.8 2.1 -10';

function svg(tag: string, attrs: Record<string, string>, ...kids: Element[]): SVGElement {
  const e = document.createElementNS(NS, tag);
  for (const k in attrs) e.setAttribute(k, attrs[k]);
  e.append(...kids);
  return e;
}

function cookieArt(): SVGElement {
  return svg(
    'svg',
    { class: 'ck-art', viewBox: '0 0 92 104', fill: 'none', 'stroke-width': '2.4', 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true', focusable: 'false' },
    svg('g', { class: 'ck-art-steam' }, ...STEAM.map((d) => svg('path', { d }))),
    svg(
      'g',
      { class: 'ck-art-cookie' },
      svg('path', { d: 'M64.67 94.19A29 29 0 1 1 74.81 75.37 11 11 0 0 0 64.67 94.19Z' }),
      ...CHIPS.split('|').map((c) => {
        const [cx, cy, rx, ry, r] = c.split(' ');
        return svg('ellipse', { cx, cy, rx, ry, transform: `rotate(${r} ${cx} ${cy})` });
      }),
    ),
  );
}

export function createBanner(layout: ConsentLayout, act: BannerActions, look: ConsentAppearance = {}): Banner {
  const modal = layout === 'modal';
  const manageLink = look.manage !== 'button';
  const el = h(modal ? 'dialog' : 'div', {
    class: 'ck-banner',
    'data-ck-layout': modal ? 'modal' : layout === 'box' ? 'box' : 'bar',
    'data-ck-position': look.position === 'right' ? 'right' : 'left',
    'data-ck-manage': manageLink ? 'link' : 'button',
    role: modal ? undefined : 'region',
    'aria-labelledby': 'complykit-banner-title',
    'aria-describedby': 'complykit-banner-body',
    tabindex: modal ? '-1' : undefined,
    hidden: !modal,
  });
  let shown = false;
  let returnTo: Element | null = null;

  if (el instanceof HTMLDialogElement) {
    el.addEventListener('cancel', (e) => e.preventDefault());
    wrapTab(el);
    el.addEventListener('close', () => {
      if (shown && !el.open) el.showModal();
    });
  }

  const render = (): void => {
    const manage = button('manage', t('banner.manage'), act.manage);
    el.replaceChildren(
      ...(look.icon === 'none' ? [] : [cookieArt()]),
      h(
        'div',
        { class: 'ck-content' },
        h('h2', { id: 'complykit-banner-title', class: 'ck-title' }, t('banner.title')),
        h('p', { id: 'complykit-banner-body', class: 'ck-body' }, t('banner.body')),
        gpcNote(),
        h('div', { class: 'ck-actions' }, button('accept', t('banner.accept'), act.accept), button('reject', t('banner.reject'), act.reject), manageLink ? null : manage),
        manageLink ? h('p', { class: 'ck-sub' }, manage) : null,
        // After the choices, so they are the first stops (F2).
        policyLink(),
      ),
    );
  };

  return {
    el,
    visible: () => shown,
    refresh() {
      if (!shown) return;
      // Keep focus on the same control across the re-render.
      const f = el.contains(document.activeElement) ? document.activeElement?.getAttribute('data-ck-action') : null;
      render();
      if (f) (el.querySelector(`[data-ck-action="${f}"]`) as HTMLElement | null)?.focus();
    },
    show() {
      if (shown) return;
      shown = true;
      render();
      if (el instanceof HTMLDialogElement) {
        returnTo = document.activeElement;
        if (!el.open) el.showModal();
        el.focus();
      } else {
        el.hidden = false;
      }
    },
    hide(next) {
      if (!shown) return;
      shown = false;
      const hadFocus = el.contains(document.activeElement);
      if (el instanceof HTMLDialogElement) el.close();
      else el.hidden = true;
      if (hadFocus || modal) focusIf(next) || focusIf(returnTo);
    },
  };
}
