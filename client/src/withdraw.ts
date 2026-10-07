// The withdrawal flow (ticket F3; design §2 mechanisms 2 and 3, §6). Withdrawing
// is as easy as consenting, and honest about what it can do: a running script
// cannot be unloaded, so the tool records the withdrawal, tells the vendors
// that have a consent API, deletes what the page can reach, reloads, and keeps
// the scripts gated from that load on. Data already sent is not recalled — the
// copy says so (string key `withdraw.recall`).
//
// Trigger: `store.withdraw()` (ComplyKit.withdraw(), or Reject all in the
// settings layer after a grant). The store writes the deny-all choice, sends
// the record, then emits 'change' and 'withdraw' — in that order, synchronously.
// On the 'change' of any grant → deny (withdrawal, or a partial save that turns
// a category off), in this order:
//
//   1. gate     — nothing to do: it releases only on grant, and the stored
//                 choice keeps everything gated from the next load (D4).
//   2. GTM      — the bridge pushes its Consent Mode update (D6; its subscriber
//                 is registered before this module's).
//   3. adapters — revoke (D5). They follow the store themselves; sync() is
//                 called again here so the revoke has happened before step 4
//                 whatever the subscription order (idempotent).
//   4. cleanup  — cookies and localStorage / sessionStorage keys matching the
//                 `config.vendors[].stores` name regexes of the revoked
//                 categories are deleted. The consent cookie itself never is.
//   5. reload   — on 'withdraw', after the other listeners ran (next task, so
//                 the record beacon is queued first).
//
// Reload policy — `data-complykit-reload` on the tool's <script> tag:
//   "withdraw" (default)  reload after a withdrawal that revoked something
//   "revoke"              also after a visitor's partial change that turns a
//                         category off (stricter: a released script of that
//                         category stops running now, not on the next page)
//   "none"                never; the gate still holds from the next load
// A withdrawal that revokes nothing (nothing was granted) does not reload.
// Under "withdraw", a choice made in another tab cleans up here but does not
// reload this tab.
//
// What cleanup cannot reach (design §2.3 — cleanup, not control):
//   - HttpOnly cookies (invisible to document.cookie) and third-party cookies
//     (another site's jar) — only the vendor or the server can remove those;
//   - partitioned (CHIPS) cookies, and a cookie whose Domain or Path is not
//     one of the variants tried. A cookie is deleted by re-setting it with the
//     same name, Domain and Path, and the page cannot read a cookie's Domain or
//     Path, so every plausible pair is tried: host-only and each parent domain
//     down to two labels (the registrable domain is not knowable client-side
//     without the public suffix list; a public suffix such as "co.uk" is
//     refused by the browser, harmlessly), × Path "/" and each prefix of the
//     current path (with and without the trailing slash);
//   - data a vendor keeps elsewhere (IndexedDB, its servers).

import type { ConsentToolConfig } from './config.js';
import { COOKIE_NAME, STORAGE_KEY, type ConsentStore } from './store.js';

/** On the tool's <script>: "withdraw" (default) | "revoke" | "none". */
export const RELOAD_ATTR = 'data-complykit-reload';

// Read while the tool's own <script> executes (null later).
const ownScript = typeof document !== 'undefined' ? (document.currentScript as HTMLScriptElement | null) : null;

/** Does `name` match a `kind` store pattern of a vendor in `categories`? Our own key never does. */
const matches = (config: ConsentToolConfig, categories: string[], kind: string, name: string): boolean =>
  name !== COOKIE_NAME &&
  config.vendors.some(
    (v) =>
      categories.includes(v.category) &&
      v.stores.some((s) => {
        try {
          return s.kind === kind && new RegExp(s.name).test(name);
        } catch {
          return false; // a bad pattern deletes nothing
        }
      }),
  );

/** Expire one cookie name under every Domain / Path pair it may have been set with. */
function expireCookie(name: string): void {
  const labels = location.hostname.split('.');
  const paths = ['/'];
  let p = '';
  for (const seg of location.pathname.split('/')) if (seg) paths.push((p += `/${seg}`), `${p}/`);
  for (let i = 0; i < labels.length; i++) {
    // i = 0 is the host-only cookie (no Domain); then each parent with >= 2 labels.
    const d = i ? `; Domain=${labels.slice(i - 1).join('.')}` : '';
    for (const path of paths) document.cookie = `${name}=; Max-Age=0; Path=${path}${d}${location.protocol === 'https:' ? '; Secure' : ''}`;
  }
}

/** Delete the reachable stores of `categories`: cookies + local/session storage keys matching their vendors' `stores` patterns. */
export function clearStores(config: ConsentToolConfig, categories: string[]): void {
  for (const part of document.cookie.split(';')) {
    const name = part.split('=')[0].trim();
    if (matches(config, categories, 'cookie', name)) expireCookie(name);
  }
  for (const kind of ['local', 'session']) {
    try {
      const st = kind === 'local' ? localStorage : sessionStorage;
      for (const k of Object.keys(st)) if (k !== STORAGE_KEY && matches(config, categories, kind, k)) st.removeItem(k);
    } catch {
      /* storage blocked: nothing reachable */
    }
  }
}

/**
 * Follow the store: revoke, clean up and reload as described above.
 * `adapters` returns the running vendor adapters (D5), re-synced before cleanup.
 */
export function installWithdrawal(config: ConsentToolConfig, store: ConsentStore, adapters?: () => { sync(): void } | undefined): void {
  const attr = ownScript?.getAttribute(RELOAD_ATTR);
  const policy = attr === 'revoke' || attr === 'none' ? attr : 'withdraw';
  const reload = () => setTimeout(() => location.reload());
  let last = store.state();
  let revoked: string[] = [];
  store.subscribe((s) => {
    revoked = Object.keys(last.categories).filter((id) => last.categories[id] && !s.categories[id]);
    last = s;
    if (!revoked.length) return;
    adapters?.()?.sync();
    clearStores(config, revoked);
    // Only a visitor's own choice reloads (not a regime / GPC update before one).
    if (policy === 'revoke' && s.status === 'chosen') reload();
  });
  store.on('withdraw', () => {
    if (policy === 'withdraw' && revoked.length) reload();
  });
}
