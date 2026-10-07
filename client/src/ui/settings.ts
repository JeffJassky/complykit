// The second layer (ticket D9): a native modal <dialog> listing the categories
// the config carries (a site with no advertising tools shows no advertising
// toggle), each with its description and the vendors observed in it
// (config.vendors labels), a checkbox per category — `necessary` checked and
// locked on — and Reject all / Accept all / Save choices, plus Close.
//
// Checkboxes start from the current effective grants: under opt-in, before a
// choice, everything but necessary is unchecked (no pre-ticked boxes). Under an
// opt-out regime they show what is actually running (on, unless GPC is set).
//
// Escape (or Close) dismisses the layer WITHOUT making a choice; focus returns
// to whatever opened it.

import type { ConsentToolConfig } from '../config.js';
import { isNecessaryCategory } from '../config.js';
import { button, focusIf, h, wrapTab } from './dom.js';
import { t } from './strings.js';
import { gpcNote, policyLink, withdrawNote } from './copy.js';

export interface SettingsActions {
  acceptAll(): void;
  rejectAll(): void;
  save(choice: Record<string, boolean>): void;
}

export interface Settings {
  el: HTMLDialogElement;
  open(grants: Record<string, boolean>, opener: Element | null): void;
  close(): void;
  isOpen(): boolean;
}

const safeId = (id: string): string => id.replace(/[^A-Za-z0-9_-]/g, '_');

export function createSettings(config: ConsentToolConfig, act: SettingsActions, fallbackFocus: () => HTMLElement | undefined): Settings {
  const el = h('dialog', { class: 'ck-settings', 'aria-labelledby': 'complykit-settings-title', 'aria-describedby': 'complykit-settings-body', tabindex: '-1' });
  let opener: Element | null = null;
  const boxes: Record<string, HTMLInputElement> = {};

  wrapTab(el);
  // Native close (Escape, Close button, or after a choice): give focus back.
  el.addEventListener('close', () => {
    focusIf(opener) || focusIf(fallbackFocus());
  });

  const row = (cat: ConsentToolConfig['categories'][number], on: boolean): HTMLElement => {
    const id = `complykit-cat-${safeId(cat.id)}`;
    const locked = isNecessaryCategory(cat.id);
    const vendors = (config.vendors ?? []).filter((v) => v.category === cat.id);
    const described = [cat.description ? `${id}-desc` : '', vendors.length ? `${id}-vendors` : ''].filter(Boolean).join(' ');
    const box = h('input', { type: 'checkbox', id, class: 'ck-toggle', 'data-ck-category': cat.id, 'aria-describedby': described || undefined, disabled: locked });
    box.checked = locked || on;
    boxes[cat.id] = box;
    return h(
      'div',
      { class: 'ck-category', 'data-ck-category': cat.id, 'data-ck-locked': locked ? 'true' : undefined },
      box,
      h('label', { for: id, class: 'ck-category-label' }, cat.label || cat.id),
      cat.description ? h('p', { id: `${id}-desc`, class: 'ck-category-desc' }, cat.description) : null,
      vendors.length ? h('ul', { id: `${id}-vendors`, class: 'ck-vendors' }, ...vendors.map((v) => h('li', { class: 'ck-vendor', 'data-ck-vendor': v.id }, v.label || v.id))) : null,
    );
  };

  const choice = (): Record<string, boolean> => {
    const out: Record<string, boolean> = {};
    for (const id in boxes) out[id] = boxes[id].checked;
    return out;
  };

  const render = (grants: Record<string, boolean>): void => {
    for (const k in boxes) delete boxes[k];
    el.replaceChildren(
      h('h2', { id: 'complykit-settings-title', class: 'ck-title' }, t('settings.title')),
      h('p', { id: 'complykit-settings-body', class: 'ck-body' }, t('settings.body')),
      gpcNote(),
      withdrawNote(),
      h('div', { class: 'ck-categories' }, ...config.categories.map((c) => row(c, grants[c.id] === true))),
      h(
        'div',
        { class: 'ck-actions' },
        button('reject', t('settings.rejectAll'), act.rejectAll),
        button('accept', t('settings.acceptAll'), act.acceptAll),
        button('save', t('settings.save'), () => act.save(choice())),
        button('close', t('settings.close'), () => el.close()),
      ),
      policyLink(),
    );
  };

  return {
    el,
    isOpen: () => el.open,
    open(grants, from) {
      if (el.open) return;
      opener = from;
      render(grants);
      el.showModal();
      el.focus();
    },
    close() {
      if (el.open) el.close();
    },
  };
}
