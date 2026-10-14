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
//                 categories are deleted. Never deleted: the consent cookie, and
//                 any name a vendor of a necessary or a still-granted category
//                 also claims (protection wins over a broad pattern).
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
// What cleanup does, and cannot reach (design §2.3 — cleanup, not control):
//   - A cookie is deleted by re-setting it with the same name, Domain, Path (and,
//     for a partitioned/CHIPS cookie, the Partitioned attribute). document.cookie
//     shows only names, so the synchronous baseline tries every plausible pair:
//     host-only and each parent domain down to two labels (the registrable domain
//     is not knowable client-side without the public suffix list; a public suffix
//     such as "co.uk" is refused by the browser, harmlessly), × Path "/" and each
//     prefix of the current path (with and without the trailing slash), × on
//     https the Secure and Secure+Partitioned variants.
//   - Where the async Cookie Store API exists (Chromium; not Firefox/Safari at
//     the time of writing) cookieStore.getAll() also reports each cookie's real
//     Domain / Path / partitioned flag, and the cookie is deleted precisely with
//     them. That is additive: the brute force always runs first and stays the
//     baseline. The reload waits for these deletions, bounded (SETTLE_MS).
//     (getAll() only reports cookies sent to the current URL, so a Path the page
//     is not under is invisible; and delete() appends "/" to a path, so a cookie
//     whose Path has no trailing slash is only reachable by the brute force.)
//   - Afterwards document.cookie and storage are re-read; matching items still
//     present are listed in `ComplyKit.diagnostics.withdrawal.leftover` (and one
//     console.warn). Only what the page can see is listed: HttpOnly cookies are
//     invisible to document.cookie and to cookieStore, so a surviving HttpOnly
//     cookie is never reported there.
//   Not reachable at all: HttpOnly cookies and third-party cookies (another
//   site's jar) — only the vendor or the server can remove those; a cookie on a
//   Domain / Path none of the variants cover (when cookieStore is absent); data a
//   vendor keeps elsewhere (IndexedDB, its servers).

import { isNecessaryCategory, type ConsentToolConfig } from './config.js';
import { diagnostics } from './diagnostics.js';
import { COOKIE_NAME, STORAGE_KEY, type ConsentStore } from './store.js';

/** On the tool's <script>: "withdraw" (default) | "revoke" | "none". */
export const RELOAD_ATTR = 'data-complykit-reload';

// Read while the tool's own <script> executes (null later).
const ownScript = typeof document !== 'undefined' ? (document.currentScript as HTMLScriptElement | null) : null;

const hits = (v: ConsentToolConfig['vendors'][number], kind: string, name: string): boolean =>
  v.stores.some((s) => {
    try {
      return s.kind === kind && new RegExp(s.name).test(name);
    } catch {
      return false; // a bad pattern matches nothing
    }
  });

/**
 * Does `name` match a `kind` store pattern of a vendor in `categories`, and is it not protected? Protected: our own
 * key, and any name a vendor of a necessary category or of a category the visitor currently GRANTED (`granted`)
 * also claims — protection wins, so a denied vendor's broad pattern never deletes another vendor's cookie.
 */
const matches = (config: ConsentToolConfig, categories: string[], granted: string[], kind: string, name: string): boolean =>
  name !== COOKIE_NAME &&
  config.vendors.some((v) => categories.includes(v.category) && hits(v, kind, name)) &&
  !config.vendors.some((v) => (isNecessaryCategory(v.category) || granted.includes(v.category)) && !categories.includes(v.category) && hits(v, kind, name));

/** Upper bound on waiting for the async cookieStore deletions (and so on the reload). */
const SETTLE_MS = 500;

/** The `name=; Max-Age=0` strings that expire `name` under every Domain / Path / attribute variant (pure; tested). */
export function deletionStrings(hostname: string, pathname: string, https: boolean, name: string): string[] {
  const labels = hostname.split('.');
  const paths = ['/'];
  let p = '';
  for (const seg of pathname.split('/')) if (seg) paths.push((p += `/${seg}`), `${p}/`);
  const out: string[] = [];
  for (let i = 0; i < labels.length; i++) {
    // i = 0 is the host-only cookie (no Domain); then each parent with >= 2 labels.
    const d = i ? `; Domain=${labels.slice(i - 1).join('.')}` : '';
    for (const path of paths) {
      const base = `${name}=; Max-Age=0; Path=${path}${d}`;
      // A partitioned cookie is only deleted by a write that is itself Partitioned (+ Secure).
      out.push(...(https ? [`${base}; Secure`, `${base}; Secure; SameSite=None; Partitioned`] : [base]));
    }
  }
  return out;
}

const expireCookie = (name: string): void => {
  for (const c of deletionStrings(location.hostname, location.pathname, location.protocol === 'https:', name)) document.cookie = c;
};

/** Names in document.cookie that match (deduped). */
const cookieNames = (config: ConsentToolConfig, categories: string[], granted: string[]): string[] => {
  const names = new Set<string>();
  for (const part of document.cookie.split(';')) {
    const name = part.split('=')[0].trim();
    if (name && matches(config, categories, granted, 'cookie', name)) names.add(name);
  }
  return [...names];
};

/** Matching storage keys as [kind, key]. */
const storageKeys = (config: ConsentToolConfig, categories: string[], granted: string[]): [string, string][] => {
  const out: [string, string][] = [];
  for (const kind of ['local', 'session']) {
    try {
      const st = kind === 'local' ? localStorage : sessionStorage;
      for (const k of Object.keys(st)) if (k !== STORAGE_KEY && matches(config, categories, granted, kind, k)) out.push([kind, k]);
    } catch {
      /* storage blocked: nothing reachable */
    }
  }
  return out;
};

/** Everything matching that is visible to the page now, as `cookie:NAME` / `local:KEY` / `session:KEY`. */
const present = (config: ConsentToolConfig, categories: string[], granted: string[]): string[] => [
  ...cookieNames(config, categories, granted).map((n) => `cookie:${n}`),
  ...storageKeys(config, categories, granted).map(([kind, k]) => `${kind}:${k}`),
];

/** Delete matching cookies precisely with the Domain / Path / partitioned flag the Cookie Store API reports. Never throws. */
async function cookieStoreDelete(config: ConsentToolConfig, categories: string[], granted: string[]): Promise<void> {
  try {
    const cs = (window as any).cookieStore;
    if (!cs?.getAll) return;
    const all: any[] = await cs.getAll();
    await Promise.all(
      all
        .filter((c) => c && matches(config, categories, granted, 'cookie', c.name))
        .map(async (c) => {
          try {
            const o: Record<string, unknown> = { name: c.name };
            if (c.domain) o.domain = c.domain;
            if (c.path) o.path = c.path;
            if (c.partitioned) o.partitioned = true;
            await cs.delete(o);
          } catch {
            /* the brute force already ran; leftover reports what survived */
          }
        }),
    );
  } catch {
    /* no / blocked Cookie Store API */
  }
}

export interface WithdrawalReport {
  at: number;
  categories: string[];
  /** `cookie:NAME` / `local:KEY` / `session:KEY` that matched and are gone. */
  cleared: string[];
  /** ... that matched and are still present (HttpOnly cookies are invisible, so never listed). */
  leftover: string[];
}

/**
 * Delete the reachable stores of `categories`: cookies + local/session storage keys matching their vendors' `stores` patterns.
 * The synchronous deletions all happen before the first await; the promise settles (never rejects, bounded) once the
 * cookieStore deletions did, with what was cleared and what survived.
 */
export async function clearStores(config: ConsentToolConfig, categories: string[], granted: string[] = []): Promise<WithdrawalReport> {
  const before = present(config, categories, granted);
  for (const n of cookieNames(config, categories, granted)) expireCookie(n);
  for (const [kind, k] of storageKeys(config, categories, granted)) {
    try {
      (kind === 'local' ? localStorage : sessionStorage).removeItem(k);
    } catch {
      /* blocked */
    }
  }
  await Promise.race([cookieStoreDelete(config, categories, granted), new Promise((r) => setTimeout(r, SETTLE_MS))]);
  const leftover = present(config, categories, granted);
  return { at: Date.now(), categories, cleared: before.filter((k) => !leftover.includes(k)), leftover };
}

/**
 * Follow the store: revoke, clean up and reload as described above.
 * `adapters` returns the running vendor adapters (D5), re-synced before cleanup.
 */
export function installWithdrawal(config: ConsentToolConfig, store: ConsentStore, adapters?: () => { sync(): void } | undefined): void {
  const attr = ownScript?.getAttribute(RELOAD_ATTR);
  const policy = attr === 'revoke' || attr === 'none' ? attr : 'withdraw';
  // Cleanup in flight (bounded, never rejects): a reload waits for it so it cannot race the cookieStore deletions.
  let cleanup: Promise<unknown> = Promise.resolve();
  const reload = () => void cleanup.then(() => setTimeout(() => location.reload()));
  const run = (cats: string[], granted: string[], key: 'withdrawal' | 'withdrawalSweep') =>
    clearStores(config, cats, granted).then(
      (r) => {
        diagnostics[key] = r;
        if (r.leftover.length && typeof console !== 'undefined') console.warn(`[complykit] ${key === 'withdrawal' ? 'withdrawal' : 'sweep'} left ${r.leftover.join(', ')}`);
      },
      () => {},
    );
  const grantedOf = (s: { categories: Record<string, boolean> }) => Object.keys(s.categories).filter((id) => s.categories[id]);
  let last = store.state();
  let revoked: string[] = [];
  store.subscribe((s) => {
    revoked = Object.keys(last.categories).filter((id) => last.categories[id] && !s.categories[id]);
    last = s;
    if (!revoked.length) return;
    adapters?.()?.sync();
    cleanup = run(revoked, grantedOf(s), 'withdrawal');
    // Only a visitor's own choice reloads (not a regime / GPC update before one).
    if (policy === 'revoke' && s.status === 'chosen') reload();
  });
  // Sweep on load: a stored visitor choice keeps its denied categories clean on every page, catching cookies
  // a past withdrawal could not reach or that a script re-set. Only a stored choice ('chosen'; it is final at
  // startup — the regime only moves an unset state) and only non-necessary categories.
  const denied = Object.keys(last.categories).filter((id) => !last.categories[id] && !isNecessaryCategory(id));
  // Once, when the page has loaded (inline scripts have run), so a cookie they set is caught too.
  if (last.status === 'chosen' && denied.length) {
    const sweep = () => void run(denied, grantedOf(last), 'withdrawalSweep');
    if (document.readyState === 'complete') sweep();
    else addEventListener('load', sweep, { once: true });
  }
  store.on('withdraw', () => {
    if (policy === 'withdraw' && revoked.length) reload();
  });
}
