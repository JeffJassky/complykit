import type { BrowserContext, Response } from 'playwright';
import { inspectMarkup, type MarkupPage } from '../../../record/index.js';

// Static markup inspection, collection half (plans/client-consent-design.md §5
// item 2). The served HTML of every page the journey visits — the bytes the
// browser parsed, not the rendered DOM — read through the scenario's own
// browser context, so it went through the same proxy, location, cookies and
// headers as the visit. Parsing is pure (record/markup.ts); matching against
// the knowledge base happens in rules/tracking/markup.ts.
//
// Source of the bytes, in order:
//   1. the top-level navigation response itself (no extra request);
//   2. if that body could not be read (a navigation interrupted by the next
//      one, an evicted body), a re-fetch through context.request AFTER the
//      visit's evidence snapshot, so its cookies never mix into the scenario.
// A page neither gave is recorded 'not-inspected' with the reason — never
// silently treated as "no markup trackers".

const READ_TIMEOUT_MS = 10000;
const REFETCH_TIMEOUT_MS = 15000;
const MAX_HTML_BYTES = 8 * 1024 * 1024;

export interface MarkupWatcher {
  /** Pages visited, inspected; refetches pages whose navigation body was unreadable. */
  finish(visited: Array<{ url: string }>): Promise<MarkupPage[]>;
}

/** Resolve with `fallback` if `p` hasn't settled in `ms` (kept local: this
 *  module stays independent of the capture/shim code). */
function withTimeout<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
  return new Promise<T>((resolve) => {
    const timer = setTimeout(() => resolve(fallback), ms);
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      () => {
        clearTimeout(timer);
        resolve(fallback);
      },
    );
  });
}

function stripHash(u: string): string {
  const i = u.indexOf('#');
  return i < 0 ? u : u.slice(0, i);
}

function isHtml(contentType: string | undefined): boolean {
  return !contentType || /html|xml/i.test(contentType);
}

export function watchMarkup(context: BrowserContext): MarkupWatcher {
  // url (no hash) → served HTML, or why it could not be read.
  const bodies = new Map<string, { html?: string; error?: string }>();
  const reads: Promise<void>[] = [];

  const onResponse = (res: Response): void => {
    let isTop = false;
    try {
      const req = res.request();
      if (req.resourceType() !== 'document' || !req.isNavigationRequest()) return;
      const frame = req.frame();
      isTop = frame === frame.page().mainFrame();
    } catch {
      return; // service-worker / detached frame
    }
    if (!isTop) return;
    const status = res.status();
    if (status >= 300 && status < 400) return; // a redirect: the target arrives as its own response
    const url = stripHash(res.url());
    if (bodies.get(url)?.html !== undefined) return; // first served copy wins
    reads.push(
      (async () => {
        const type = (await res.allHeaders().catch(() => ({}) as Record<string, string>))['content-type'];
        if (!isHtml(type)) {
          bodies.set(url, { error: `not HTML (${type})` });
          return;
        }
        const buf = await withTimeout(res.body().then((b) => b as Buffer | undefined), READ_TIMEOUT_MS, undefined).catch(() => undefined);
        if (!buf) {
          if (!bodies.get(url)?.html) bodies.set(url, { error: 'navigation response body unreadable' });
          return;
        }
        if (buf.length > MAX_HTML_BYTES) {
          bodies.set(url, { error: `HTML larger than ${MAX_HTML_BYTES} bytes` });
          return;
        }
        bodies.set(url, { html: buf.toString('utf8') });
      })(),
    );
  };
  context.on('response', onResponse);

  return {
    async finish(visited) {
      await withTimeout(Promise.allSettled(reads), READ_TIMEOUT_MS + 2000, []);
      context.off('response', onResponse);
      const out: MarkupPage[] = [];
      const seen = new Set<string>();
      for (const [pageIndex, p] of visited.entries()) {
        const url = stripHash(p.url);
        if (seen.has(url) || !/^https?:/i.test(url)) continue;
        seen.add(url);
        let got = bodies.get(url);
        let via: 'navigation' | 'refetch' = 'navigation';
        if (got?.html === undefined) {
          const first = got?.error;
          via = 'refetch';
          got = await withTimeout<{ html?: string; error?: string }>(
            context.request
              .get(url, { timeout: REFETCH_TIMEOUT_MS, failOnStatusCode: false })
              .then(async (r): Promise<{ html?: string; error?: string }> => {
                if (!isHtml(r.headers()['content-type'])) return { error: `not HTML (${r.headers()['content-type']})` };
                const buf = await r.body();
                return buf.length > MAX_HTML_BYTES ? { error: `HTML larger than ${MAX_HTML_BYTES} bytes` } : { html: buf.toString('utf8') };
              })
              .catch((e: unknown) => ({ error: `re-fetch failed: ${e instanceof Error ? e.message.split('\n')[0].slice(0, 120) : String(e)}` })),
            REFETCH_TIMEOUT_MS + 2000,
            { error: 're-fetch timed out' },
          );
          if (got.html === undefined && first) got = { error: `${first}; ${got.error}` };
        }
        if (got.html === undefined) {
          out.push({ url, pageIndex, status: 'not-inspected', reason: got.error ?? 'no response', elements: [] });
          continue;
        }
        try {
          out.push(inspectMarkup(got.html, url, pageIndex, via));
        } catch (e) {
          out.push({ url, pageIndex, status: 'not-inspected', reason: `parse failed: ${e instanceof Error ? e.message.slice(0, 120) : String(e)}`, elements: [] });
        }
      }
      return out;
    },
  };
}
