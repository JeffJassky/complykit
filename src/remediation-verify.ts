import {
  RemediationTask,
  RemediationVerifySpec,
  type LocationSpec,
  type SpotCheckObservation,
  type VerifyOutcome,
} from './record/index.js';
import type { KnowledgeBase } from './registry/index.js';
import { runVerify } from './rules/remediation/verify.js';
import { detectBotChallenge, type BotChallenge } from './rules/remediation/challenge.js';
import type { VerifyBrowser, VerifyBrowserOptions } from './collect/browser/evaluation/verify-change.js';

// Verify ONE remediation task (plans/remediation-flow.md §5 + §7, ticket R4):
// fetch what its verify spec needs — the page's served HTML, the published
// container, or a one-page reject-then-accept browser visit — and run the
// pure checker on it. `complykit verify-change` is this function; the service
// spawns that command and stores the outcome under `task:change:<id>`.
//
// Budgets: a static check gets 20 s, a spot check 60 s. Running out, a missing
// browser, an unreachable page: all cannot-verify with the reason, never a pass.

export const STATIC_BUDGET_MS = 20_000;
export const SPOT_CHECK_BUDGET_MS = 60_000;

export interface VerifyChangeOptions {
  kb?: KnowledgeBase;
  /** The site's registrable domain (default: from the page URL). */
  site?: string;
  launchArgs?: string[];
  location?: LocationSpec;
  staticBudgetMs?: number;
  spotCheckBudgetMs?: number;
  /** Spot-check waits (tests shorten them). */
  bannerWaitMs?: number;
  settleMs?: number;
  /** Clock for `at` (tests). */
  now?: () => Date;
  /** A browser to use instead of launching one (tests). */
  browser?: VerifyBrowser;
  trace?: (line: string) => void;
}

/** What `complykit verify-change --json` prints: the outcome, when, and for a spot check what was observed. */
export interface VerifyChangeOutput extends VerifyOutcome {
  at: string;
  check: RemediationVerifySpec['check'];
  /** The task id, when the input was a task. */
  id?: string;
  /** What was fetched (URL and HTTP status), or why it could not be. */
  fetched?: { url: string; status?: number; via?: string; error?: string };
  observation?: SpotCheckObservation;
}

/** A task (its `verify`) or a bare verify spec → the spec, or an error message. */
export function verifySpecOf(input: unknown): { spec: RemediationVerifySpec; id?: string } | { error: string } {
  const obj = typeof input === 'object' && input !== null ? (input as Record<string, unknown>) : undefined;
  if (!obj) return { error: 'expected a remediation task (or its verify spec) as a JSON object' };
  if ('verify' in obj) {
    const t = RemediationTask.safeParse(obj);
    if (t.success) return { spec: t.data.verify, id: t.data.id };
    const s = RemediationVerifySpec.safeParse(obj.verify);
    if (s.success) return { spec: s.data, ...(typeof obj.id === 'string' ? { id: obj.id } : {}) };
    return { error: `not a usable verify spec: ${s.error.issues.slice(0, 3).map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ')}` };
  }
  const s = RemediationVerifySpec.safeParse(obj);
  if (s.success) return { spec: s.data };
  return { error: `not a remediation task or verify spec: ${s.error.issues.slice(0, 3).map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ')}` };
}

/** The container file to fetch for a gtm-tag-consent spec. */
export function containerUrlOf(spec: Extract<RemediationVerifySpec, { check: 'gtm-tag-consent' }>): string {
  return spec.containerUrl ?? `https://www.googletagmanager.com/gtm.js?id=${encodeURIComponent(spec.containerId)}`;
}

const cannot = (message: string, evidence: string[] = []): VerifyOutcome => ({ result: 'cannot-verify', message, evidence });

export const BOT_CHALLENGE_MESSAGE = 'the site served a bot challenge instead of the page';
const challenged = (c: BotChallenge, url: string, status?: number): VerifyOutcome =>
  cannot(BOT_CHALLENGE_MESSAGE, [`${c.vendor}: ${c.marker}`, `${url}${status !== undefined ? ` (HTTP ${status})` : ''}`]);

class BudgetExceeded extends Error {}

function within<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new BudgetExceeded(`ran out of time after ${Math.round(ms / 1000)} s`)), ms);
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e: unknown) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

export async function verifyChange(spec: RemediationVerifySpec, opts: VerifyChangeOptions = {}): Promise<VerifyChangeOutput> {
  const at = (opts.now ?? (() => new Date()))().toISOString();
  const vopts = { kb: opts.kb, site: opts.site };
  const done = (o: VerifyOutcome, extra: Partial<VerifyChangeOutput> = {}): VerifyChangeOutput => ({ result: o.result, message: o.message, evidence: o.evidence ?? [], at, check: spec.check, ...extra });

  if (spec.method === 'manual') return done(runVerify(spec, {}, vopts));

  const budget = spec.method === 'browser' ? (opts.spotCheckBudgetMs ?? SPOT_CHECK_BUDGET_MS) : (opts.staticBudgetMs ?? STATIC_BUDGET_MS);
  let browser = opts.browser;
  const own = !browser;
  const work = async (): Promise<VerifyChangeOutput> => {
    if (!browser) {
      const { openVerifyBrowser } = await import('./collect/browser/evaluation/verify-change.js');
      const bo: VerifyBrowserOptions = { launchArgs: opts.launchArgs, location: opts.location };
      browser = await openVerifyBrowser(bo);
      opts.trace?.(`browser: ${process.env.COMPLYKIT_BROWSER_CHANNEL ?? 'chromium'} ${browser.version}`);
    }
    if (spec.check === 'spot-check') {
      opts.trace?.(`spot check: ${spec.page} (reject, then accept)`);
      const run = await browser.spotCheck(spec.page, { bannerWaitMs: opts.bannerWaitMs, settleMs: opts.settleMs, challenge: (html, headers, status) => detectBotChallenge(html, headers, status) });
      const { notes, challenge, ...observation } = run;
      if (challenge) return done(challenged(challenge as BotChallenge, spec.page), { observation });
      const out = runVerify(spec, { observation }, vopts);
      return done({ ...out, evidence: [...out.evidence, ...notes] }, { observation });
    }
    if (spec.check === 'gtm-tag-consent') {
      const url = containerUrlOf(spec);
      opts.trace?.(`fetching container ${url}`);
      const got = await browser.fetchContainer(url);
      if (!got.ok) return done(cannot(`the container ${url} could not be fetched (${got.error}): nothing is established about its tags`), { fetched: { url, status: got.status, error: got.error } });
      const out = runVerify(spec, { containerJs: got.text }, vopts);
      return done({ ...out, evidence: [`fetched ${url} (HTTP ${got.status})`, ...out.evidence] }, { fetched: { url, status: got.status, via: got.via } });
    }
    const page = spec.page;
    opts.trace?.(`fetching ${page}`);
    const got = await browser.fetchHtml(page);
    // A challenge answered instead of the page is checked BEFORE anything else: its markup is not the site's.
    const challenge = got.text !== undefined || got.headers ? detectBotChallenge(got.text ?? '', got.headers ?? {}, got.status) : undefined;
    if (challenge) return done(challenged(challenge, got.url, got.status), { fetched: { url: got.url, status: got.status, ...(got.ok ? { via: got.via } : { error: got.error }) } });
    if (!got.ok) return done(cannot(`${page} could not be fetched (${got.error}): nothing is established about its markup`), { fetched: { url: got.url, status: got.status, error: got.error } });
    const out = runVerify(spec, { html: got.text }, vopts);
    return done({ ...out, evidence: [`served HTML of ${got.url} (HTTP ${got.status})`, ...out.evidence] }, { fetched: { url: got.url, status: got.status, via: got.via } });
  };
  const running = work();
  let late = false;
  try {
    return await within(running, budget);
  } catch (err) {
    const why = err instanceof Error ? err.message.split('\n')[0].slice(0, 200) : String(err);
    if (err instanceof BudgetExceeded) {
      // The work is still running: close the browser when it settles (a launch in flight included).
      late = true;
      if (own) void running.catch(() => undefined).finally(() => browser?.close());
      return done(cannot(`${spec.method === 'browser' ? 'the spot check' : 'the fetch'} ${why}: nothing is established`));
    }
    if (/Cannot find (package|module) 'playwright'|Executable doesn't exist|browserType\.launch/i.test(why)) return done(cannot(`no browser to verify with (${why}). Install Playwright's Chromium, or set COMPLYKIT_BROWSER_CHANNEL=chrome to use an installed Chrome`));
    return done(cannot(`the check could not run: ${why}`));
  } finally {
    if (own && browser && !late) await browser.close();
  }
}
