// The attribution shim — installed with addInitScript into EVERY frame before
// any page script runs (plans/consent-design.md §2.4 capture fixes). It changes
// no behavior: every wrapper calls straight through to the original. It reports
// four things the browser's own network events can't:
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
//   4. Consent / tag API CALLS (gtag, dataLayer.push, fbq, ttq, clarity,
//      uetq.push, __tcfapi, __gpp, Shopify.customerPrivacy.*) — what the page
//      told each vendor and when, relative to the banner and the choice
//      (plans/client-consent-design.md §3). Hooked through accessors so globals
//      defined later, and stubs swapped for the real library, are still seen.
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

  // --- consent / tag API calls (plans/client-consent-design.md §3) ---
  // Every vendor global is hooked with an accessor BEFORE the page defines it,
  // so a stub assigned later, and the real library that replaces the stub, are
  // both wrapped as they arrive. Functions are wrapped in a Proxy: properties
  // read and written on the global (fbq.queue, fbq.callMethod, clarity.q,
  // __gpp.queue) reach the vendor's own function untouched, and calls go
  // straight through with the original 'this'. Methods on objects (dataLayer.push,
  // uetq.push, ttq.grantConsent, Shopify.customerPrivacy.*) get an instance
  // accessor, so a vendor assigning its own implementation is wrapped too and
  // that assignment is the "library ready" moment. Arguments are reduced to
  // their shape here, in the page: raw values never reach the recorder.
  // Limits: a global FUNCTION DECLARATION (function gtag(){…}) replaces the
  // accessor — gtag calls are still seen through dataLayer.push(arguments);
  // a renamed dataLayer / ttq global, and calls made before this frame's
  // document started, are not seen. Known side effect: a hooked name is an own
  // property of window from the start, so ('Shopify' in window) is true on a
  // page that never defines it (the value reads undefined; typeof checks and
  // the vendors' own (x = x || stub) snippets are unaffected).
  try {
    let budget = 400;
    const perCall = {};
    const busy = {};
    const PROXIES = new WeakSet();
    const PROXY_OF = new WeakMap();
    const HOOKED = new WeakSet();
    const TOKEN = /^[A-Za-z_][\w.:-]{0,63}$/;
    const CONSENT_STR = /^(granted|denied|true|false|yes|no|accepted|declined|rejected|opt[_-]?in|opt[_-]?out|[01])$/i;
    const REGION = /^[A-Z]{2}(-[A-Z0-9]{1,3})?$/;
    const isArgs = (v) => Object.prototype.toString.call(v) === '[object Arguments]';
    const shape = (v, depth, key) => {
      if (v === null) return null;
      const ty = typeof v;
      if (ty === 'boolean') return v;
      if (ty === 'string') {
        if (CONSENT_STR.test(v)) return v;
        if (key === 'event' && TOKEN.test(v)) return v;
        if (key === 'region' && REGION.test(v)) return v;
        return '<string>';
      }
      if (ty === 'number') return key === 'wait_for_update' ? v : '<number>';
      if (ty !== 'object') return '<' + ty + '>';
      if (depth >= 3) return Array.isArray(v) || isArgs(v) ? '<array>' : '<object>';
      if (Array.isArray(v) || isArgs(v)) {
        const a = [];
        for (let i = 0; i < Math.min(v.length, 20); i++) a.push(shape(v[i], depth + 1, key));
        return a;
      }
      if ((typeof Node === 'function' && v instanceof Node) || v === window) return '<object>';
      const o = {};
      let n = 0;
      for (const k in v) {
        if (!Object.prototype.hasOwnProperty.call(v, k)) continue;
        if (++n > 30) break;
        try { o[k] = shape(v[k], depth + 1, k); } catch (e) { o[k] = '<unreadable>'; }
      }
      return o;
    };
    const argsShape = (list) => {
      const a = [];
      for (let i = 0; i < Math.min(list.length, 10); i++) {
        const x = list[i];
        a.push(i < 2 && typeof x === 'string' && TOKEN.test(x) ? x : shape(x, 0, undefined));
      }
      return a;
    };
    // Calls made BY THE SCANNER (page.evaluate readouts, an 'api:' choice) are
    // not the page's behavior: skipped when the frame right under the wrapper is
    // a Playwright evaluation. The page's own reaction inside such a call (a CMP
    // calling gtag from its __tcfapi handler) is still recorded.
    const fromDriver = () => {
      const st = (new Error().stack || '').split('\n');
      for (let i = 0; i < st.length - 1; i++) if (st[i].indexOf('__ckApply') >= 0) return /UtilityScript|eval at evaluate/.test(st[i + 1]);
      return false;
    };
    const rec = (api, call, args, readyKind) => {
      try {
        if (!readyKind && fromDriver()) return;
        const a0 = args && args.length && typeof args[0] === 'string' ? args[0] : '';
        // Consent commands are never dropped; chatty calls are capped per document.
        if (!(readyKind || /consent/i.test(a0) || /consent/i.test(call))) {
          const k = api + '|' + call;
          perCall[k] = (perCall[k] || 0) + 1;
          if (perCall[k] > 100 || budget <= 0) return;
          budget--;
        }
        out({ kind: 'consent-api', api, call, apiKind: readyKind ? 'ready' : 'call', args: readyKind ? [] : argsShape(args || []), chain: chain() });
      } catch (e) {}
    };
    const ready = {};
    const markReady = (api, call) => { if (!ready[api]) { ready[api] = true; rec(api, call, null, true); } };
    // describe(args) -> [callName, argsList] lets dataLayer.push(arguments) read as a gtag call.
    const wrapFn = (api, call, fn, opts) => {
      if (typeof fn !== 'function' || PROXIES.has(fn)) return fn;
      // One wrapper per (function, api+call): Array.prototype.push backs both dataLayer and uetq.
      const slot = api + '|' + call;
      let byKey = PROXY_OF.get(fn);
      if (!byKey) { byKey = {}; PROXY_OF.set(fn, byKey); }
      if (byKey[slot]) return byKey[slot];
      const describe = opts && opts.describe;
      const onSet = opts && opts.onSet;
      let p;
      // Named: fromDriver() finds this frame in the stack.
      const __ckApply = function __ckApply(target, self, args) {
        if (busy[api]) return Reflect.apply(target, self, args);
        busy[api] = true;
        try {
          try { if (describe) { const d = describe(args); rec(api, d[0], d[1]); } else rec(api, call, args); } catch (e) {}
          return Reflect.apply(target, self, args);
        } finally { busy[api] = false; }
      };
      const handler = { apply: __ckApply };
      // A self-reference (fbq's stub does n.push = n) reads back as the wrapper,
      // so fbq.push === fbq still holds and calls through it are seen.
      handler.get = (target, k) => {
        const v = Reflect.get(target, k);
        if (v !== target) return v;
        const d = Object.getOwnPropertyDescriptor(target, k);
        return d && !d.configurable && !d.writable ? v : p;
      };
      if (onSet) handler.set = (target, k, v) => {
        try { onSet(k, v); } catch (e) {}
        return Reflect.set(target, k, v);
      };
      p = new Proxy(fn, handler);
      PROXIES.add(p);
      byKey[slot] = p;
      return p;
    };
    // An accessor on obj[name]: wrap(value, previous) runs on every new value.
    const hookProp = (obj, name, wrap) => {
      try {
        if (!obj || (typeof obj !== 'object' && typeof obj !== 'function')) return;
        const d = Object.getOwnPropertyDescriptor(obj, name);
        let raw, cur;
        if (d) {
          if (d.get || d.set) return; // someone's accessor (or ours already)
          if (!d.configurable) {
            if (d.writable) { try { obj[name] = wrap(d.value, undefined); } catch (e) {} }
            return;
          }
          raw = d.value;
        } else {
          raw = obj[name]; // inherited (Array.prototype.push) or absent
        }
        cur = raw === undefined ? undefined : wrap(raw, undefined);
        const proto = Object.getPrototypeOf(obj);
        Object.defineProperty(obj, name, {
          configurable: true,
          enumerable: d ? d.enumerable : !(proto && name in proto),
          get() { return cur; },
          set(v) {
            if (v === cur || v === raw) return;
            const prev = raw;
            raw = v;
            cur = v === undefined ? v : wrap(v, prev);
          },
        });
      } catch (e) {}
    };
    const hookMethod = (obj, name, api, call, opts) => hookProp(obj, name, (fn, prev) => {
      if (prev !== undefined && opts && opts.readyOnReplace) markReady(api, call);
      return wrapFn(api, call, fn, opts);
    });
    const onceHooked = (o) => { if (!o || (typeof o !== 'object' && typeof o !== 'function') || HOOKED.has(o)) return false; HOOKED.add(o); return true; };

    // Google: gtag() and dataLayer.push(). gtag pushes its 'arguments' object.
    const gDescribe = (args) => (args.length === 1 && isArgs(args[0]) ? ['gtag', Array.from(args[0])] : ['dataLayer.push', Array.from(args)]);
    hookProp(window, 'dataLayer', (v) => {
      if (onceHooked(v) && typeof v.push === 'function') {
        if (Array.isArray(v)) for (let i = 0; i < Math.min(v.length, 50); i++) { const d = gDescribe([v[i]]); rec('google', d[0], d[1]); }
        hookMethod(v, 'push', 'google', 'dataLayer.push', { describe: gDescribe, readyOnReplace: true });
      }
      return v;
    });
    hookProp(window, 'gtag', (v, prev) => wrapFn('google', 'gtag', v));

    // Meta: fbq stub (and _fbq alias); fbevents.js setting fbq.callMethod = ready.
    const fbOpts = { onSet: (k) => { if (k === 'callMethod') markReady('meta', 'fbq'); } };
    hookProp(window, 'fbq', (v, prev) => { if (prev !== undefined) markReady('meta', 'fbq'); return wrapFn('meta', 'fbq', v, fbOpts); });
    hookProp(window, '_fbq', (v) => wrapFn('meta', 'fbq', v, fbOpts));

    // TikTok: ttq is a queue array with methods attached; consent methods wrapped.
    hookProp(window, 'ttq', (v, prev) => {
      if (prev !== undefined) markReady('tiktok', 'ttq');
      if (onceHooked(v)) for (const m of ['grantConsent', 'revokeConsent', 'holdConsent']) hookMethod(v, m, 'tiktok', 'ttq.' + m);
      return v;
    });

    // Microsoft Clarity: clarity('consentv2', {...}) / clarity('consent', bool).
    hookProp(window, 'clarity', (v, prev) => { if (prev !== undefined) markReady('clarity', 'clarity'); return wrapFn('clarity', 'clarity', v); });

    // Microsoft UET: uetq.push('consent', 'default'|'update', {...}); bat.js replaces uetq.
    hookProp(window, 'uetq', (v, prev) => {
      if (prev !== undefined) markReady('microsoft-uet', 'uetq');
      if (onceHooked(v)) hookMethod(v, 'push', 'microsoft-uet', 'uetq.push');
      return v;
    });

    // IAB TCF / GPP: the CMP's stub, then the CMP itself.
    hookProp(window, '__tcfapi', (v, prev) => { if (prev !== undefined) markReady('tcf', '__tcfapi'); return wrapFn('tcf', '__tcfapi', v); });
    hookProp(window, '__gpp', (v, prev) => { if (prev !== undefined) markReady('gpp', '__gpp'); return wrapFn('gpp', '__gpp', v); });

    // Shopify Customer Privacy API (loaded by the platform; no stub).
    const SHOPIFY = ['setTrackingConsent', 'getTrackingConsent', 'currentVisitorConsent', 'userCanBeTracked', 'analyticsProcessingAllowed', 'marketingAllowed', 'preferencesProcessingAllowed', 'saleOfDataAllowed', 'shouldShowBanner'];
    hookProp(window, 'Shopify', (v) => {
      if (onceHooked(v)) hookProp(v, 'customerPrivacy', (cp) => {
        markReady('shopify', 'Shopify.customerPrivacy');
        if (onceHooked(cp)) for (const m of SHOPIFY) hookMethod(cp, m, 'shopify', 'Shopify.customerPrivacy.' + m);
        return cp;
      });
      return v;
    });
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
  kind: 'beacon' | 'fetch' | 'xhr' | 'insert' | 'img-src' | 'cookie' | 'storage' | 'consent-api';
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
  // kind 'consent-api' (see ConsentApiEvent in record/tracking.ts):
  api?: 'google' | 'meta' | 'tiktok' | 'clarity' | 'microsoft-uet' | 'tcf' | 'gpp' | 'shopify';
  call?: string;
  apiKind?: 'call' | 'ready';
  args?: unknown[];
  exiting?: boolean;
  flushed?: boolean;
}
