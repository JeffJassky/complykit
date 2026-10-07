// The script gate (ticket D4): mechanism 1 of plans/client-consent-design.md §2.
//
// The owner rewrites a tracker's tag to `<script type="text/plain"
// data-category="analytics" data-src="…">`. The browser never executes or even
// fetches a script whose type is not a JavaScript MIME type, so the tag is
// inert until this module RELEASES it: a brand-new `<script>` with the same
// attributes is inserted right after the original, which stays in the DOM as a
// marker (`data-ck-released`). Flipping `type` on the existing element does
// not run it: a type change never triggers the browser's "prepare the script
// element" steps. (A text/plain script is not "already started", so a LATER
// `src` or child-text change on it would prepare and run it — which is why
// the gate never touches the original at all beyond the marker attribute.)
// A fresh element is the mechanism; test/gate.test.ts documents both facts.
//
// Release semantics, in one place:
//   - A script is OURS when its `type` is exactly text/plain and it names a
//     category (`data-category`, alias `data-ck-category`) or matches a
//     `config.gate[]` rule (`src` regex over data-src/src, or `selector`).
//     Anything else (templates, JSON blobs) is never touched.
//   - It is RELEASED only when its category is listed in `config.categories`
//     (or is `necessary`) AND the store says granted. An unlisted category is
//     never released, whatever the store says: fail closed.
//   - Never twice: a WeakSet plus the `data-ck-released` marker (so a second
//     gate instance on the same document also refuses). The fresh element is
//     not text/plain, so the observer ignores it.
//   - Order: within a category, released scripts execute in document order.
//     Non-async external scripts (and module scripts) hold the chain until
//     their load/error event; inline classic scripts run synchronously on
//     insertion. `async` scripts are inserted without waiting. `defer` ones
//     are not released before DOMContentLoaded (native defer semantics). A
//     queued script detached before its turn is un-claimed, not run. Categories do
//     not wait on each other (each has its own chain; twins are never put on
//     the browser's document-wide in-order list).
//   - Withdrawal un-runs nothing (a running script cannot be unloaded). The
//     gate simply stops releasing: a script in a withdrawn category added
//     later stays held, and on the next page load everything in that category
//     is held from the start. That is the honest contract (§2.1).
//   - `<iframe>`/`<img>` with data-category + data-src and no src: on grant,
//     src is set from data-src. Same never-twice and fail-closed rules; no
//     ordering (there is none to preserve).
import type { ConsentToolConfig, GateRule } from './config.js';
import { isNecessaryCategory } from './config.js';

/** What the gate needs from the consent store (ticket D3 implements it). */
export interface GateStore {
  isGranted(categoryId: string): boolean;
  /** Called after any change of consent state. Returns the unsubscribe. */
  subscribe(fn: () => void): () => void;
}

export interface ScriptGateOptions {
  config: Pick<ConsentToolConfig, 'categories' | 'gate'>;
  store: GateStore;
  root?: Document;
}

export interface ScriptGate {
  /** Re-examine every held element; release what is granted now. Idempotent. */
  sweep(): void;
  /** Disconnect the observer and the store subscription. Released scripts stay released. */
  stop(): void;
}

export const RELEASED_ATTR = 'data-ck-released';
const GATED_TYPE = 'text/plain';
// Attributes that must not be copied verbatim: handled explicitly or marker-only.
const SKIP_ATTRS = new Set(['type', 'src', 'data-src', 'data-type', 'async', 'defer', 'nonce', RELEASED_ATTR]);

export function createScriptGate(opts: ScriptGateOptions): ScriptGate {
  const { config, store } = opts;
  const root = opts.root ?? document;
  const claimed = new WeakSet<Element>();
  const chains = new Map<string, { busy: boolean; queue: HTMLScriptElement[] }>();
  const rules: Array<{ rule: GateRule; src?: RegExp }> = [];
  for (const rule of config.gate ?? []) {
    try {
      rules.push({ rule, src: rule.src ? new RegExp(rule.src) : undefined });
    } catch {
      /* a malformed regex gates nothing; the generator validated it, so this is a hand edit */
    }
  }

  const listed = (id: string): boolean =>
    isNecessaryCategory(id) || config.categories.some((c) => c.id === id);
  const granted = (id: string): boolean => listed(id) && store.isGranted(id) === true;

  /** The category a gated element belongs to, or undefined when it is not ours. */
  function categoryOf(el: Element): string | undefined {
    const own = el.getAttribute('data-category') ?? el.getAttribute('data-ck-category');
    if (own != null) return own.trim() || undefined;
    if (!(el instanceof HTMLScriptElement)) return undefined;
    const src = el.getAttribute('data-src') ?? el.getAttribute('src') ?? '';
    for (const { rule, src: re } of rules) {
      if (re && src && re.test(src)) return rule.category;
      if (rule.selector) {
        try {
          if (el.matches(rule.selector)) return rule.category;
        } catch {
          /* invalid selector: matches nothing */
        }
      }
    }
    return undefined;
  }

  function isHeldScript(el: Element): el is HTMLScriptElement {
    return (
      el instanceof HTMLScriptElement &&
      (el.getAttribute('type') ?? '').trim().toLowerCase() === GATED_TYPE &&
      !el.hasAttribute(RELEASED_ATTR) &&
      !claimed.has(el)
    );
  }

  function isHeldEmbed(el: Element): el is HTMLIFrameElement | HTMLImageElement {
    return (
      (el instanceof HTMLIFrameElement || el instanceof HTMLImageElement) &&
      el.hasAttribute('data-src') &&
      !el.getAttribute('src') &&
      !el.hasAttribute(RELEASED_ATTR) &&
      !claimed.has(el)
    );
  }

  /** Build the executable twin of a held script. Not yet inserted. */
  function twin(orig: HTMLScriptElement): HTMLScriptElement {
    const fresh = root.createElement('script');
    for (const { name, value } of Array.from(orig.attributes)) {
      if (!SKIP_ATTRS.has(name)) fresh.setAttribute(name, value);
    }
    if ((orig.getAttribute('data-type') ?? '').trim().toLowerCase() === 'module') fresh.type = 'module';
    const src = orig.getAttribute('data-src') ?? orig.getAttribute('src');
    if (src != null) fresh.setAttribute('src', src);
    else fresh.textContent = orig.textContent;
    // The id moves to the twin: vendor loaders look themselves up by id
    // (document.getElementById(...).src for their account id) and must find
    // the working copy, not the inert marker that stays first in the DOM.
    if (orig.hasAttribute('id')) orig.removeAttribute('id');
    // The twin is left "force-async" (the default for a created script): the
    // chain in pump() is what keeps same-category order. Setting `async=false`
    // instead would put the twin on the browser's single document-wide
    // in-order list and make one category's slow script block another's.
    // `defer` is meaningless on an inserted script (consider() holds a deferred
    // one until parsing ends); kept for the record.
    if (orig.hasAttribute('async')) fresh.setAttribute('async', '');
    if (orig.hasAttribute('defer')) fresh.setAttribute('defer', '');
    // Under a header-delivered CSP the browser hides the nonce content
    // attribute (getAttribute returns ''); the IDL property keeps the value.
    const nonce = orig.nonce || orig.getAttribute('nonce') || '';
    if (nonce) {
      fresh.setAttribute('nonce', nonce);
      fresh.nonce = nonce;
    }
    return fresh;
  }

  function pump(category: string): void {
    const chain = chains.get(category);
    if (!chain) return;
    while (!chain.busy && chain.queue.length) {
      const orig = chain.queue.shift()!;
      if (!orig.isConnected) {
        // Detached before its turn (an SPA swapped the subtree out). A twin put
        // into a detached subtree is never prepared: no load, no error, and the
        // chain would stall for good. Un-claim it instead, so it is released
        // if it comes back (the observer sees it re-added).
        claimed.delete(orig);
        orig.removeAttribute(RELEASED_ATTR);
        continue;
      }
      try {
        const fresh = twin(orig);
        // A classic `nomodule` script is skipped by the browser without any
        // load/error event: waiting on it would stall the chain.
        const waits =
          !orig.hasAttribute('async') && (fresh.type === 'module' || (fresh.hasAttribute('src') && !fresh.noModule));
        if (waits) {
          chain.busy = true;
          const done = () => {
            chain.busy = false;
            pump(category);
          };
          fresh.addEventListener('load', done, { once: true });
          fresh.addEventListener('error', done, { once: true });
        }
        // Insertion is the execution point for inline scripts and the fetch
        // start for external ones. Listeners are attached before it.
        orig.parentNode!.insertBefore(fresh, orig.nextSibling);
      } catch {
        // e.g. Trusted Types refusing a script body: this one cannot run; the
        // rest of the chain (and the sweep that called us) must go on.
        chain.busy = false;
      }
    }
  }

  function consider(el: Element): void {
    if (isHeldScript(el)) {
      const category = categoryOf(el);
      if (category === undefined || !granted(category)) return;
      // Native `defer` runs after parsing; an inserted twin would run as soon
      // as it loads, against a half-parsed DOM. The DOMContentLoaded sweep
      // releases it (in document order, after the category's sync scripts).
      if (el.hasAttribute('defer') && root.readyState === 'loading') return;
      // Claimed = released, as far as anyone else is concerned: the marker goes
      // on now, not at insertion, so a script waiting in a chain is never
      // picked up a second time (by a later sweep or another gate instance).
      claimed.add(el);
      el.setAttribute(RELEASED_ATTR, '');
      let chain = chains.get(category);
      if (!chain) chains.set(category, (chain = { busy: false, queue: [] }));
      chain.queue.push(el);
      pump(category);
    } else if (isHeldEmbed(el)) {
      const category = categoryOf(el);
      if (category === undefined || !granted(category)) return;
      claimed.add(el);
      el.setAttribute(RELEASED_ATTR, '');
      el.setAttribute('src', el.getAttribute('data-src')!);
    }
  }

  function sweep(): void {
    // Document order matters: querySelectorAll returns it.
    for (const el of Array.from(root.querySelectorAll('script, iframe[data-src], img[data-src]'))) consider(el);
  }

  const observer = new MutationObserver((records) => {
    for (const rec of records) {
      for (const node of Array.from(rec.addedNodes)) {
        if (!(node instanceof Element)) continue;
        consider(node);
        if (node.childElementCount) {
          for (const el of Array.from(node.querySelectorAll('script, iframe[data-src], img[data-src]'))) consider(el);
        }
      }
    }
  });

  observer.observe(root.documentElement ?? root, { childList: true, subtree: true });
  const unsubscribe = store.subscribe(sweep);
  // Parser-inserted scripts reach the observer; the sweeps are belt and braces.
  if (root.readyState === 'loading') root.addEventListener('DOMContentLoaded', sweep, { once: true });
  sweep();

  return {
    sweep,
    stop() {
      observer.disconnect();
      unsubscribe();
    },
  };
}
