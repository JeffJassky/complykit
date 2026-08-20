import type { Page, CDPSession } from 'playwright';

// CDP evidence capture (browser-analysis-design channel 2). Below-JS access: all
// cookies including HttpOnly, and every network request with its INITIATOR
// (who injected what — GTM -> tracker attribution). Attach BEFORE navigation so
// the load itself is recorded.

export interface RequestRecord {
  url: string;
  resourceType?: string;
  initiatorType?: string;
  initiatorUrl?: string;
}

export interface CookieRecord {
  name: string;
  domain: string;
  secure: boolean;
  httpOnly: boolean;
  sameSite?: string;
  session: boolean;
}

export interface StorageRecord {
  kind: 'local' | 'session';
  key: string;
}

export interface CaptureHandle {
  requests: RequestRecord[];
  stop: () => Promise<{ cookies: CookieRecord[]; storage: StorageRecord[] }>;
}

interface CdpCookie {
  name: string;
  domain: string;
  secure: boolean;
  httpOnly: boolean;
  sameSite?: string;
  session: boolean;
}

/** Start recording network requests via CDP; call the returned stop() after the
 *  page has settled to snapshot cookies + storage. */
export async function startCapture(page: Page): Promise<CaptureHandle> {
  const requests: RequestRecord[] = [];
  let cdp: CDPSession | undefined;
  try {
    cdp = await page.context().newCDPSession(page);
    await cdp.send('Network.enable');
    cdp.on('Network.requestWillBeSent', (evt: {
      request: { url: string };
      type?: string;
      initiator?: { type?: string; url?: string; stack?: { callFrames?: Array<{ url?: string }> } };
    }) => {
      const initiatorUrl = evt.initiator?.url ?? evt.initiator?.stack?.callFrames?.[0]?.url;
      requests.push({
        url: evt.request.url,
        resourceType: evt.type,
        initiatorType: evt.initiator?.type,
        initiatorUrl,
      });
    });
  } catch {
    // Non-Chromium — fall back to Playwright request events (no initiator chain).
    page.on('request', (req) => requests.push({ url: req.url(), resourceType: req.resourceType() }));
  }

  const stop = async (): Promise<{ cookies: CookieRecord[]; storage: StorageRecord[] }> => {
    let cookies: CookieRecord[] = [];
    try {
      if (cdp) {
        const res = (await cdp.send('Network.getAllCookies')) as { cookies: CdpCookie[] };
        cookies = res.cookies.map((c) => ({
          name: c.name,
          domain: c.domain,
          secure: c.secure,
          httpOnly: c.httpOnly,
          sameSite: c.sameSite,
          session: c.session,
        }));
      } else {
        const ck = await page.context().cookies();
        cookies = ck.map((c) => ({ name: c.name, domain: c.domain, secure: c.secure, httpOnly: c.httpOnly, sameSite: c.sameSite, session: c.expires === -1 }));
      }
    } catch {
      /* cookies unavailable */
    }
    let storage: StorageRecord[] = [];
    try {
      storage = (await page.evaluate(() => {
        const out: Array<{ kind: 'local' | 'session'; key: string }> = [];
        for (let i = 0; i < localStorage.length; i++) out.push({ kind: 'local', key: localStorage.key(i) ?? '' });
        for (let i = 0; i < sessionStorage.length; i++) out.push({ kind: 'session', key: sessionStorage.key(i) ?? '' });
        return out;
      })) as StorageRecord[];
    } catch {
      /* storage unavailable */
    }
    if (cdp) {
      try {
        await cdp.detach();
      } catch {
        /* already detached */
      }
    }
    return { cookies, storage };
  };

  return { requests, stop };
}
