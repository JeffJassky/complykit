// The attribution shim — installed with addInitScript into EVERY frame before
// any page script runs (plans/consent-design.md §2.4 capture fixes). It changes
// no behavior: every wrapper calls straight through to the original. It reports
// three things the browser's own network events can't:
//
//   1. WHO caused a request. CDP gives a call stack for script-initiated fetches,
//      but `new Image().src = pixel` and script insertions are often attributed
//      to the document ("parser"). The shim records the JS stack at the moment a
//      script/img/iframe is inserted or an image src is set, so a pixel can be
//      traced to the tag manager or app that injected it.
//   2. WHO wrote a cookie or storage key from script (document.cookie setter,
//      Storage.setItem) — HttpOnly cookies come from Set-Cookie headers instead.
//   3. Page-EXIT beacons. A sendBeacon / keepalive fetch / pixel fired during
//      pagehide reaches the server but never surfaces as a Playwright or CDP
//      request event (spiked 2026-10-02: the server received it, both observers
//      missed it). The shim writes exit-time sends to sessionStorage and the NEXT
//      same-origin document flushes them — which is why every journey ends with
//      one more same-origin navigation.
//
// Records go out through `window.__ckRecord` (a Playwright binding). Limits
// recorded honestly by the collector: workers don't run init scripts (their
// requests are still seen at the network level); cross-origin frames flush
// exit beacons only if they navigate again themselves.

export const SHIM_BINDING = '__ckRecord';

export const SHIM_SOURCE = String.raw`(() => {
  if (window.__ckShimInstalled) return;
  Object.defineProperty(window, '__ckShimInstalled', { value: true });
  const KEY = '__ck_exit';
  const send = (rec) => { try { window.${SHIM_BINDING}(rec); } catch (e) {} };
  const abs = (u) => { try { return new URL(String(u), location.href).href; } catch (e) { return String(u); } };
  const STACK_URL = /((?:https?|blob|chrome-extension):\/\/[^\s)]+?):\d+:\d+/;
  const chain = () => {
    const out = [];
    const s = (new Error().stack || '').split('\n');
    for (let i = 1; i < s.length; i++) {
      const m = s[i].match(STACK_URL);
      if (m && out.indexOf(m[1]) < 0) out.push(m[1]);
    }
    return out;
  };
  let exiting = false;
  const markExit = () => { exiting = true; };
  addEventListener('beforeunload', markExit, true);
  addEventListener('pagehide', markExit, true);
  const out = (rec) => {
    rec.t = Date.now();
    rec.frame = location.href;
    rec.top = window === window.top;
    if (exiting) {
      rec.exiting = true;
      try {
        const a = JSON.parse(sessionStorage.getItem(KEY) || '[]');
        a.push(rec);
        sessionStorage.setItem(KEY, JSON.stringify(a.slice(-200)));
      } catch (e) {}
    }
    send(rec);
  };
  // Flush what the previous same-origin document sent while it was closing.
  try {
    const prev = sessionStorage.getItem(KEY);
    if (prev) { sessionStorage.removeItem(KEY); for (const r of JSON.parse(prev)) send(Object.assign(r, { flushed: true })); }
  } catch (e) {}

  // --- network calls made from script ---
  try {
    const ob = navigator.sendBeacon && navigator.sendBeacon.bind(navigator);
    if (ob) navigator.sendBeacon = function (u, b) {
      let body;
      try { body = typeof b === 'string' ? b.slice(0, 4096) : (b instanceof URLSearchParams ? String(b).slice(0, 4096) : undefined); } catch (e) {}
      out({ kind: 'beacon', url: abs(u), body, chain: chain() });
      return ob(u, b);
    };
  } catch (e) {}
  try {
    const of = window.fetch;
    if (of) window.fetch = function (input, init) {
      try {
        const u = input && typeof input === 'object' && 'url' in input ? input.url : input;
        const keepalive = !!(init && init.keepalive);
        if (exiting || keepalive) {
          let body;
          try { body = init && typeof init.body === 'string' ? init.body.slice(0, 4096) : undefined; } catch (e) {}
          out({ kind: 'fetch', url: abs(u), keepalive, body, chain: chain() });
        } else {
          out({ kind: 'fetch', url: abs(u), chain: chain() });
        }
      } catch (e) {}
      return of.apply(this, arguments);
    };
  } catch (e) {}
  try {
    const oo = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function (m, u) {
      try { out({ kind: 'xhr', url: abs(u), chain: chain() }); } catch (e) {}
      return oo.apply(this, arguments);
    };
  } catch (e) {}

  // --- elements that load things ---
  const WATCH = { SCRIPT: 'src', IMG: 'src', IFRAME: 'src', LINK: 'href', AUDIO: 'src', VIDEO: 'src', SOURCE: 'src', EMBED: 'src', OBJECT: 'data' };
  const noteInsert = (node) => {
    try {
      if (!node || node.nodeType !== 1) return;
      const attr = WATCH[node.tagName];
      if (!attr) return;
      const src = node.getAttribute(attr);
      if (!src) return;
      out({ kind: 'insert', tag: node.tagName.toLowerCase(), url: abs(src), type: node.getAttribute('type') || undefined, rel: node.getAttribute('rel') || undefined, chain: chain() });
    } catch (e) {}
  };
  const wrapInsert = (proto, name, pick) => {
    try {
      const o = proto[name];
      if (typeof o !== 'function') return;
      proto[name] = function () {
        try { for (const n of pick(arguments)) noteInsert(n); } catch (e) {}
        return o.apply(this, arguments);
      };
    } catch (e) {}
  };
  wrapInsert(Node.prototype, 'appendChild', (a) => [a[0]]);
  wrapInsert(Node.prototype, 'insertBefore', (a) => [a[0]]);
  wrapInsert(Node.prototype, 'replaceChild', (a) => [a[0]]);
  wrapInsert(Element.prototype, 'append', (a) => Array.from(a));
  wrapInsert(Element.prototype, 'prepend', (a) => Array.from(a));
  wrapInsert(Element.prototype, 'before', (a) => Array.from(a));
  wrapInsert(Element.prototype, 'after', (a) => Array.from(a));
  wrapInsert(Element.prototype, 'replaceWith', (a) => Array.from(a));
  wrapInsert(Element.prototype, 'insertAdjacentElement', (a) => [a[1]]);
  // new Image().src = pixel — never inserted, still fetched.
  try {
    const d = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, 'src');
    if (d && d.set) Object.defineProperty(HTMLImageElement.prototype, 'src', {
      configurable: true, enumerable: d.enumerable, get: d.get,
      set: function (v) { try { out({ kind: 'img-src', url: abs(v), chain: chain() }); } catch (e) {} return d.set.call(this, v); },
    });
  } catch (e) {}

  // --- script-written device state ---
  try {
    const d = Object.getOwnPropertyDescriptor(Document.prototype, 'cookie');
    if (d && d.set) Object.defineProperty(Document.prototype, 'cookie', {
      configurable: true, enumerable: d.enumerable, get: d.get,
      set: function (v) { try { out({ kind: 'cookie', raw: String(v).slice(0, 4096), chain: chain() }); } catch (e) {} return d.set.call(this, v); },
    });
  } catch (e) {}
  try {
    const os = Storage.prototype.setItem;
    Storage.prototype.setItem = function (k, v) {
      try {
        if (String(k) !== KEY) {
          const area = this === window.localStorage ? 'local' : 'session';
          out({ kind: 'storage', area, key: String(k), value: String(v).slice(0, 4096), chain: chain() });
        }
      } catch (e) {}
      return os.apply(this, arguments);
    };
  } catch (e) {}
})();`;

/** Makes the browser announce Global Privacy Control to page scripts (the
 *  Sec-GPC request header is set on the context separately). Workers don't run
 *  init scripts, so `navigator.globalPrivacyControl` inside a worker stays
 *  undefined — a known fidelity limit, recorded as not tested. */
export const GPC_SOURCE = `(() => {
  try { Object.defineProperty(Navigator.prototype, 'globalPrivacyControl', { configurable: true, enumerable: true, get: () => true }); } catch (e) {}
})();`;

/** A record as the shim sends it. */
export interface ShimRecord {
  kind: 'beacon' | 'fetch' | 'xhr' | 'insert' | 'img-src' | 'cookie' | 'storage';
  t: number; // epoch ms (page clock = machine clock)
  frame: string; // location.href of the frame
  top: boolean;
  url?: string;
  tag?: string;
  type?: string;
  rel?: string;
  body?: string;
  keepalive?: boolean;
  raw?: string;
  area?: 'local' | 'session';
  key?: string;
  value?: string;
  chain: string[];
  exiting?: boolean;
  flushed?: boolean;
}
