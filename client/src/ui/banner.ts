// The first layer (ticket D9): title, one paragraph, and three real buttons —
// Reject all, Accept all, Manage choices — adjacent, in that order, the same
// element and the same class (`ck-btn`), so reject is exactly as prominent as
// accept (research-consent-law.md: same layer, same level; CPPA §7004(a)(2)).
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

import type { ConsentLayout } from '../config.js';
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

export function createBanner(layout: ConsentLayout, act: BannerActions): Banner {
  const modal = layout === 'modal';
  const el = h(modal ? 'dialog' : 'div', {
    class: 'ck-banner',
    'data-ck-layout': modal ? 'modal' : layout === 'box' ? 'box' : 'bar',
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
    el.replaceChildren(
      h('h2', { id: 'complykit-banner-title', class: 'ck-title' }, t('banner.title')),
      h('p', { id: 'complykit-banner-body', class: 'ck-body' }, t('banner.body')),
      gpcNote(),
      h(
        'div',
        { class: 'ck-actions' },
        button('reject', t('banner.reject'), act.reject),
        button('accept', t('banner.accept'), act.accept),
        button('manage', t('banner.manage'), act.manage),
      ),
      // After the actions, so reject stays the first stop (F2).
      policyLink(),
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
