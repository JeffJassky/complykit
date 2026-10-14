// Page blocking (config.blockPage): while a choice is owed, the page behind the
// banner cannot be used — any layout. Three parts, all undone on release:
//
//   backdrop  a full-viewport .ck-backdrop under the banner (bar / box only;
//             the modal layout's <dialog> has its own ::backdrop)
//   inert     every <body> child except our root gets `inert` (no clicks, no
//             focus, hidden from assistive tech); children added later — a chat
//             widget injected after load — are made inert too. Elements the
//             site had already made inert are left alone and stay inert.
//   scroll    overflow:hidden on <html> and <body>, with the scrollbar gutter
//             kept when there was a scrollbar, so the page does not shift.
//
// Blocking starts when the UI file mounts, never earlier: the core does not
// hide the page while the UI file loads (decided — a failed load must not
// leave a blank page). It applies in every regime where the banner shows.
//
// Blocking is not a cookie wall: the first layer always offers Reject next to
// Accept, and any choice releases the page (consent.no-cookie-wall).

import { h } from './dom.js';

export interface PageBlock {
  el: HTMLElement;
  set(on: boolean): void;
}

export function createBlock(root: HTMLElement, backdrop: boolean): PageBlock {
  const el = h('div', { class: 'ck-backdrop', 'aria-hidden': 'true', hidden: true });
  let on = false;
  let made: Element[] = [];
  let saved: string[] = [];
  let observer: MutationObserver | undefined;

  const inert = (n: Node): void => {
    if (!(n instanceof HTMLElement) || n === root || n.hasAttribute('inert')) return;
    if (n.tagName === 'SCRIPT' || n.tagName === 'STYLE') return;
    n.setAttribute('inert', '');
    made.push(n);
  };

  return {
    el,
    set(want) {
      if (want === on) return;
      on = want;
      const html = document.documentElement;
      const body = document.body;
      if (on) {
        const bar = window.innerWidth > html.clientWidth;
        saved = [html.style.overflow, body.style.overflow, html.style.getPropertyValue('scrollbar-gutter')];
        if (bar) html.style.setProperty('scrollbar-gutter', 'stable');
        html.style.overflow = 'hidden';
        body.style.overflow = 'hidden';
        Array.from(body.children).forEach(inert);
        observer = new MutationObserver((ms) => ms.forEach((m) => m.addedNodes.forEach(inert)));
        observer.observe(body, { childList: true });
        el.hidden = !backdrop;
      } else {
        observer?.disconnect();
        for (const n of made) n.removeAttribute('inert');
        made = [];
        html.style.overflow = saved[0];
        body.style.overflow = saved[1];
        if (saved[2]) html.style.setProperty('scrollbar-gutter', saved[2]);
        else html.style.removeProperty('scrollbar-gutter');
        el.hidden = true;
      }
    },
  };
}
