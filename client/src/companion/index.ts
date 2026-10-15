// Add-on mode (ticket T6; plans/hosted-script.md "Add-on mode"): follow the site's own banner.
// Runs in complykit-consent-companion.js, started on the host the core exposes. For config.companion.cmp it
// finds the source adapter, waits for the banner (its change events at once, a poll every 250 ms for up to
// 10 s), maps what it reports as granted through `companion.map ?? DEFAULT_MAPS[cmp]` and hands that to
// host.sync (store.set; a grant -> deny runs the core's withdrawal cleanup). The first answer also sweeps
// the stores of the categories the banner reports denied. `manual` has no source: the site calls
// ComplyKit.sync(). diagnostics.companion = { cmp, state } says 'waiting' | 'ready' | 'not-found'.
import { isNecessaryCategory } from '../config.js';
import { DEFAULT_MAPS } from './maps.js';
import type { CompanionHost } from './host.js';
import { consentMode } from './sources/consent-mode.js';
import { cookiebot } from './sources/cookiebot.js';
import { didomi } from './sources/didomi.js';
import { onetrust } from './sources/onetrust.js';
import { shopify } from './sources/shopify.js';
import { tcf } from './sources/tcf.js';
import { trustarc } from './sources/trustarc.js';
import { usercentrics } from './sources/usercentrics.js';
import { wordpress } from './sources/wordpress.js';
import type { Source } from './sources/types.js';

export const SOURCES: Record<string, Source> = { onetrust, cookiebot, usercentrics, didomi, trustarc, shopify, wordpress, tcf, 'consent-mode': consentMode };

const POLL_MS = 250;
const GIVE_UP_MS = 10_000;

export function startCompanion(host: CompanionHost): void {
  const config = host.getConfig();
  const cmp = config?.companion?.cmp;
  if (!config || !cmp || config.mode !== 'companion') return;
  const map = config.companion!.map ?? DEFAULT_MAPS[cmp] ?? {};
  const ids = new Set(config.categories.map((c) => c.id));
  const state = (s: 'waiting' | 'ready' | 'not-found'): void => void (host.diagnostics.companion = { cmp, state: s });
  const source = SOURCES[cmp];
  if (!source) return state('ready'); // manual: ComplyKit.sync()
  state('waiting');
  let last: string | undefined;
  let ready = false;
  const push = (granted: string[]): void => {
    ready = true;
    state('ready');
    const mapped: Record<string, boolean> = {};
    for (const [id, cats] of Object.entries(map)) for (const c of cats) if (ids.has(c) && !isNecessaryCategory(c)) mapped[c] = mapped[c] || granted.includes(id);
    const key = JSON.stringify(mapped);
    if (key === last) return;
    const first = last === undefined;
    last = key;
    host.sync(mapped);
    if (!first) return;
    // Sweep on load: what the banner already denies is cleaned (cookies from before the add-on, or another device's choice).
    const denied = Object.keys(mapped).filter((c) => !mapped[c]);
    if (denied.length) void host.clear(denied, Object.keys(mapped).filter((c) => mapped[c])).then((r) => void (host.diagnostics.withdrawalSweep = r), () => {});
  };
  const poll = source(push);
  const t0 = Date.now();
  const tick = (): void => {
    if (ready) return;
    void Promise.resolve()
      .then(() => poll && poll())
      .then((g) => g && push(g), () => {});
    if (Date.now() - t0 >= GIVE_UP_MS) state('not-found');
    else setTimeout(tick, POLL_MS);
  };
  tick();
}
