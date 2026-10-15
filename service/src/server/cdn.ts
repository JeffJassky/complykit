// Purging the CDN (Cloudflare) in front of the hosted script. A purge failure is
// logged and swallowed: it must never fail a workspace write (plans/hosted-script.md B2).

export interface CdnPurger {
  /** Purge these exact URLs. Never throws. */
  purgeUrls(urls: string[]): Promise<void>;
  /** Purge everything the zone caches. Never throws. */
  purgeAll(): Promise<void>;
}

/** No CDN configured: nothing to purge. */
export const noopPurger: CdnPurger = {
  async purgeUrls() {},
  async purgeAll() {},
};

/** Cloudflare accepts at most 30 files per purge call. */
const MAX_FILES = 30;
const RETRY_DELAY_MS = 250;

export interface CloudflarePurgerOptions {
  zoneId: string;
  /** API token with Zone → Cache Purge. */
  token: string;
  fetch?: typeof fetch;
  log?: (message: string) => void;
  retryDelayMs?: number;
}

export function cloudflarePurger(opts: CloudflarePurgerOptions): CdnPurger {
  const doFetch = opts.fetch ?? fetch;
  const log = opts.log ?? ((m: string) => console.warn(m));
  const url = `https://api.cloudflare.com/client/v4/zones/${encodeURIComponent(opts.zoneId)}/purge_cache`;
  const delay = opts.retryDelayMs ?? RETRY_DELAY_MS;

  /** One POST, retried once. */
  async function post(body: unknown): Promise<void> {
    let last = '';
    for (let attempt = 0; attempt < 2; attempt++) {
      if (attempt) await new Promise((r) => setTimeout(r, delay));
      try {
        const res = await doFetch(url, {
          method: 'POST',
          headers: { Authorization: `Bearer ${opts.token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        if (res.ok) return;
        last = `HTTP ${res.status}`;
      } catch (err) {
        last = (err as Error).message;
      }
    }
    log(`[cdn] purge failed (${last})`);
  }

  return {
    async purgeUrls(urls) {
      for (let i = 0; i < urls.length; i += MAX_FILES) await post({ files: urls.slice(i, i + MAX_FILES) });
    },
    async purgeAll() {
      await post({ purge_everything: true });
    },
  };
}
