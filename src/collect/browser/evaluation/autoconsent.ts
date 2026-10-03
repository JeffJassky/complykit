import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import type { BrowserContext, Frame, Page } from 'playwright';

// Banner driving through @duckduckgo/autoconsent (MPL-2.0; rules for hundreds
// of consent tools). Its Playwright bundle runs in every frame and talks to us
// through `window.autoconsentSendMessage`; we answer through
// `window.autoconsentReceiveMessage`. We never let it act on its own
// (autoAction: null) — the scenario decides when to opt in or out — and its
// cosmetic "hide the banner" rules and prehiding are OFF: hiding a banner is not
// rejecting it (plans/consent-design.md §2.3).

const require = createRequire(import.meta.url);

interface Loaded {
  script: string;
  rules: unknown;
  version: string;
}
let loaded: Loaded | null | undefined;

function load(): Loaded | null {
  if (loaded !== undefined) return loaded;
  try {
    const entry = require.resolve('@duckduckgo/autoconsent');
    const dist = path.dirname(entry);
    const script = fs.readFileSync(path.join(dist, 'autoconsent.playwright.js'), 'utf8');
    const rules = JSON.parse(fs.readFileSync(require.resolve('@duckduckgo/autoconsent/rules/compact-rules.json'), 'utf8'));
    let version = 'unknown';
    try {
      version = (JSON.parse(fs.readFileSync(path.join(dist, '..', 'package.json'), 'utf8')) as { version: string }).version;
    } catch {
      /* keep unknown */
    }
    loaded = { script, rules, version };
  } catch {
    loaded = null;
  }
  return loaded;
}

export function autoconsentVersion(): string | undefined {
  return load()?.version;
}

const CONFIG = {
  enabled: true,
  autoAction: null,
  disabledCmps: [] as string[],
  enablePrehide: false,
  enableCosmeticRules: false,
  enableGeneratedRules: true,
  detectRetries: 20,
  isMainWorld: true,
  prehideTimeout: 2000,
  enableHeuristicDetection: false,
  enablePopupMutationObserver: true,
  visualTest: false,
  logs: { lifecycle: false, rulesteps: false, detectionsteps: false, evals: false, errors: false, messages: false, waits: false },
  performanceLoggingEnabled: false,
  heuristicPopupSearchTimeout: 100,
  heuristicMode: 'off',
};

type Msg = { type: string; cmp?: string; result?: boolean; url?: string; id?: string; code?: string; isCosmetic?: boolean; totalClicks?: number };

export interface AutoconsentEvent {
  type: 'cmpDetected' | 'popupFound' | 'optOutResult' | 'optInResult' | 'selfTestResult' | 'autoconsentDone' | 'autoconsentError';
  cmp?: string;
  result?: boolean;
  frameUrl: string;
  at: number; // epoch ms
  clicks?: number;
}

/** One driver per browser context (scenario). */
export class AutoconsentDriver {
  readonly available: boolean;
  readonly events: AutoconsentEvent[] = [];
  private frames = new Map<Frame, { cmp?: string; popup?: boolean }>();
  private waiters: Array<{ match: (e: AutoconsentEvent) => boolean; resolve: (e: AutoconsentEvent | null) => void }> = [];

  constructor() {
    this.available = load() !== null;
  }

  async install(context: BrowserContext): Promise<void> {
    const l = load();
    if (!l) return;
    await context.exposeBinding('autoconsentSendMessage', async (source, msg: Msg) => {
      const frame = source.frame;
      if (!msg || typeof msg !== 'object') return;
      if (msg.type === 'init') {
        await frame
          .evaluate((m) => (window as unknown as { autoconsentReceiveMessage?: (x: unknown) => void }).autoconsentReceiveMessage?.(m), {
            type: 'initResp',
            config: CONFIG,
            rules: { autoconsent: [], compact: l.rules },
          })
          .catch(() => {});
        return;
      }
      if (msg.type === 'eval' && msg.id) {
        let result: unknown = false;
        try {
          result = await frame.evaluate(msg.code ?? 'false');
        } catch {
          result = false;
        }
        await frame
          .evaluate((m) => (window as unknown as { autoconsentReceiveMessage?: (x: unknown) => void }).autoconsentReceiveMessage?.(m), { type: 'evalResp', id: msg.id, result })
          .catch(() => {});
        return;
      }
      const known = ['cmpDetected', 'popupFound', 'optOutResult', 'optInResult', 'selfTestResult', 'autoconsentDone', 'autoconsentError'];
      if (!known.includes(msg.type)) return;
      const state = this.frames.get(frame) ?? {};
      if (msg.type === 'cmpDetected') state.cmp = msg.cmp;
      if (msg.type === 'popupFound') {
        state.cmp = msg.cmp;
        state.popup = true;
      }
      this.frames.set(frame, state);
      const e: AutoconsentEvent = { type: msg.type as AutoconsentEvent['type'], cmp: msg.cmp, result: msg.result, frameUrl: frame.url(), at: Date.now(), clicks: msg.totalClicks };
      this.events.push(e);
      for (const w of [...this.waiters]) {
        if (w.match(e)) {
          this.waiters.splice(this.waiters.indexOf(w), 1);
          w.resolve(e);
        }
      }
    });
    await context.addInitScript(l.script);
  }

  private wait(match: (e: AutoconsentEvent) => boolean, timeoutMs: number, since = 0): Promise<AutoconsentEvent | null> {
    const prior = this.events.find((e) => e.at >= since && match(e));
    if (prior) return Promise.resolve(prior);
    return new Promise((resolve) => {
      const w = { match, resolve };
      this.waiters.push(w);
      setTimeout(() => {
        const i = this.waiters.indexOf(w);
        if (i >= 0) {
          this.waiters.splice(i, 1);
          resolve(null);
        }
      }, timeoutMs);
    });
  }

  /** Wait for a popup in any frame of this context, found at or after `since`. */
  waitForPopup(timeoutMs: number, since: number): Promise<AutoconsentEvent | null> {
    return this.wait((e) => e.type === 'popupFound', timeoutMs, since);
  }

  /** The frame on `page` where a popup (else a CMP) was found. */
  private targetFrame(page: Page): Frame | undefined {
    let best: Frame | undefined;
    for (const f of page.frames()) {
      const s = this.frames.get(f);
      if (s?.popup) return f;
      if (s?.cmp && !best) best = f;
    }
    return best;
  }

  detectedCmp(page: Page): string | undefined {
    const f = this.targetFrame(page);
    return f ? this.frames.get(f)?.cmp : undefined;
  }

  /** Ask autoconsent to opt out / in on this page. Resolves with the result event (null on timeout or no CMP). */
  async act(page: Page, action: 'optOut' | 'optIn', timeoutMs = 20000): Promise<AutoconsentEvent | null> {
    const frame = this.targetFrame(page);
    if (!frame) return null;
    const since = Date.now();
    await frame
      .evaluate((m) => (window as unknown as { autoconsentReceiveMessage?: (x: unknown) => Promise<void> }).autoconsentReceiveMessage?.(m), { type: action })
      .catch(() => {});
    const want = action === 'optOut' ? 'optOutResult' : 'optInResult';
    return this.wait((e) => e.type === want, timeoutMs, since);
  }

  /** autoconsent's own check that the stored choice reflects the opt-out (only some rules have one). */
  async selfTest(page: Page, timeoutMs = 8000): Promise<boolean | undefined> {
    const frame = this.targetFrame(page);
    if (!frame) return undefined;
    const since = Date.now();
    await frame
      .evaluate((m) => (window as unknown as { autoconsentReceiveMessage?: (x: unknown) => Promise<void> }).autoconsentReceiveMessage?.(m), { type: 'selfTest' })
      .catch(() => {});
    const e = await this.wait((x) => x.type === 'selfTestResult', timeoutMs, since);
    return e ? Boolean(e.result) : undefined;
  }
}
