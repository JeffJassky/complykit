import type { Page } from 'playwright';

// Structural page fingerprint — the "is this the same layout?" signal that URL
// patterns alone can't give. Two topic-detail pages (or chatgpt/gemini/perplexity
// platform pages) render the SAME DOM skeleton with different data; a dashboard
// and a settings page do not. So we hash the skeleton — tag names + a11y roles,
// with text, ids, hrefs, and data-* stripped — and treat pages with equal hashes
// as instances of one layout to be sampled, not scanned exhaustively.
//
// Robustness choices:
//  - repeated sibling subtrees collapse to `tag*` so a 3-row list and a 50-row
//    list of the same layout fingerprint identically (list length is data, not
//    structure);
//  - depth- and node-capped so a pathological DOM can't blow up the hash;
//  - roles kept (they change the a11y-relevant structure), classes dropped
//    (utility-class churn is noise).

const SKELETON = `() => {
  const MAX_NODES = 600, MAX_DEPTH = 14;
  let count = 0;
  const skel = (el, depth) => {
    if (count >= MAX_NODES || depth > MAX_DEPTH) return '';
    count++;
    const tag = el.tagName.toLowerCase();
    const role = el.getAttribute && el.getAttribute('role');
    const self = role ? tag + '[' + role + ']' : tag;
    const kids = [];
    for (const c of el.children) {
      const s = skel(c, depth + 1);
      if (s) kids.push(s);
    }
    // Collapse runs of identical sibling skeletons: list length is data.
    const collapsed = [];
    for (let i = 0; i < kids.length; i++) {
      if (i > 0 && kids[i] === kids[i - 1]) {
        const last = collapsed[collapsed.length - 1];
        if (!last.endsWith('*')) collapsed[collapsed.length - 1] = last + '*';
        continue;
      }
      collapsed.push(kids[i]);
    }
    return collapsed.length ? self + '(' + collapsed.join(',') + ')' : self;
  };
  return document.body ? skel(document.body, 0) : '';
}`;

// djb2 → 16 hex chars. Fast, dependency-free, plenty for a dedup key (this is a
// bucketing signal, not a security digest).
function hash16(s: string): string {
  let h = 5381n;
  for (let i = 0; i < s.length; i++) h = ((h * 33n) ^ BigInt(s.charCodeAt(i))) & 0xffffffffffffffffn;
  return h.toString(16).padStart(16, '0');
}

/** Compute the structural fingerprint of the page currently loaded in `page`. */
export async function structuralFingerprint(page: Page): Promise<string> {
  try {
    // SKELETON is a string holding an arrow expression. page.evaluate treats a
    // string as an EXPRESSION to eval — so it must be wrapped and INVOKED here,
    // `(<arrow>)()`, or evaluate just returns the (unserializable) function and
    // every page fingerprints as 'unknown'.
    const skeleton = (await page.evaluate(`(${SKELETON})()`)) as string;
    return skeleton ? hash16(skeleton) : 'empty';
  } catch {
    return 'unknown'; // page navigated/closed mid-eval — caller treats as its own bucket
  }
}
