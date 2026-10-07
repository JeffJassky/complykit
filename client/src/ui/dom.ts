// A tiny element builder for the banner (ticket D9). Attributes with an
// undefined / false value are left off; `true` sets an empty attribute.

type Attrs = Record<string, string | boolean | undefined>;

export function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Attrs = {}, ...kids: Array<Node | string | null | undefined>): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const k in attrs) {
    const v = attrs[k];
    if (v !== undefined && v !== false) el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of kids) if (c != null) el.append(c);
  return el;
}

/** A real <button type="button"> carrying the action hook `data-ck-action`. */
export function button(action: string, label: string, onClick: (el: HTMLButtonElement) => void): HTMLButtonElement {
  const b = h('button', { type: 'button', class: 'ck-btn', 'data-ck-action': action }, label);
  b.addEventListener('click', () => onClick(b));
  return b;
}

/** Focus an element if it is still in the document and shown; false otherwise. */
export function focusIf(el: Element | null | undefined): boolean {
  if (!(el instanceof HTMLElement) || !el.isConnected || el === document.body) return false;
  if (el.closest('[hidden]')) return false;
  el.focus();
  return document.activeElement === el;
}

/**
 * Keep Tab inside a modal dialog: wrap from the last control to the first and
 * back (WAI-ARIA APG dialog pattern). showModal() alone leaves this to the
 * engine — Chromium cycles inside the document, Firefox lets Tab leave for the
 * browser UI — so the dialog does it itself, the same everywhere (F5).
 */
export function wrapTab(d: HTMLElement): void {
  d.addEventListener('keydown', (e) => {
    if (e.key !== 'Tab') return;
    const f = Array.from(d.querySelectorAll<HTMLElement>('button,a[href],input:not([disabled])')).filter((x) => !x.closest('[hidden]'));
    const a = document.activeElement;
    if (f.length && (e.shiftKey ? a === f[0] || a === d : a === f[f.length - 1])) {
      e.preventDefault();
      f[e.shiftKey ? f.length - 1 : 0].focus();
    }
  });
}
