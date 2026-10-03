import fs from 'node:fs';
import path from 'node:path';
import type { Browser, BrowserContext, Page } from 'playwright';
import {
  putEvidence,
  redactTimeline,
  type RunId,
  type LocationSpec,
  type LocationVerification,
  type ScenarioId,
  type Timeline,
  type TimelineEvent,
  type ChoiceEvent,
} from '../../../record/index.js';
import { startCapture, withTimeout, type CaptureHandle } from './capture.js';
import { AutoconsentDriver } from './autoconsent.js';
import {
  readConsentState,
  readoutContradicts,
  readoutConfirms,
  consentModeMismatch,
  findBanner,
  heuristicChoice,
  bannerVisible,
  dismissBanner,
  partialConsent,
  reopenSettings,
  rejectInOpenSettings,
  walkOptOutLink,
  findConfirmation,
  siteReportedRegion,
} from './banner.js';
import { browse, dwell, flush, navigate, scrollSteps, type ResolvedJourney } from './journey.js';
import { contextOptionsFor } from './location.js';
import { GPC_SOURCE } from './shim.js';
import { redactHarFile } from './har.js';

// One scenario = one fresh browser context (a brand-new profile — nothing
// carries over), one journey, one timeline (plans/consent-design.md §2.3).

export interface Markers {
  email: string;
  text: string;
  clickIds: Record<string, string>;
}

export interface ScenarioInput {
  browser: Browser;
  spec: LocationSpec;
  verification: LocationVerification;
  scenario: ScenarioId;
  targetUrl: string;
  site: { url: string; host: string; registrableDomain: string };
  journey: ResolvedJourney;
  runId: RunId;
  cwd?: string;
  /** Absolute dir for this location × scenario's evidence files. */
  evidenceDir: string;
  /** Run-relative form of evidenceDir (for references in records). */
  evidenceRel: string;
  har: boolean;
  raw: boolean;
  markers: Markers;
  bannerWaitMs: number;
  /** Hard budget for the scenario's actions (default 5 min); then it stops and records what it has. */
  scenarioTimeoutMs?: number;
  trace?: (line: string) => void;
}

export interface ScenarioOutput {
  timeline: Timeline;
  status: 'tested' | 'not-tested' | 'not-applicable';
  reason?: string;
  screenshots: string[];
  siteReported: Array<{ source: string; value: string }>;
}

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

const GPC_SCENARIOS: ScenarioId[] = ['gpc', 'opt-out-all'];

class Visit {
  page!: Page;
  readonly screenshots: string[] = [];
  readonly siteReported = new Map<string, { source: string; value: string }>();
  bannerShown = false;
  cmp?: string;
  private readonly openedAt = Date.now();

  constructor(
    readonly input: ScenarioInput,
    readonly context: BrowserContext,
    readonly cap: CaptureHandle,
    readonly driver: AutoconsentDriver,
  ) {}

  /** Record an event; `at` overrides the time (a choice is timed at the click, not after it settles). */
  ev(e: DistributiveOmit<TimelineEvent, 't' | 'pageIndex'>, at?: number): void {
    this.cap.push({ t: at ?? this.cap.now(), pageIndex: this.cap.pageIndex(), ...e } as TimelineEvent);
  }

  async newPage(): Promise<Page> {
    this.page = await this.context.newPage();
    this.page.setDefaultTimeout(15000);
    await this.cap.watchPage(this.page, true);
    return this.page;
  }

  async shot(label: string): Promise<void> {
    try {
      // JPEG: a viewport capture is ~100 KB instead of ~1 MB, so reports can inline it.
      const buf = await this.page.screenshot({ type: 'jpeg', quality: 70 });
      const p = putEvidence(this.input.runId, buf, 'jpg', this.input.cwd);
      this.screenshots.push(p);
      this.ev({ type: 'screenshot', label, path: p });
    } catch {
      /* page gone */
    }
  }

  async readout(label: string): Promise<Record<string, unknown>> {
    const data = await readConsentState(this.page);
    this.ev({ type: 'consent-readout', label, data });
    for (const r of siteReportedRegion(data)) this.siteReported.set(r.source, r);
    return data;
  }

  /** Land on a URL and watch for the banner while dwelling. */
  async land(url: string, opts: { dwellMs?: number; expectBanner?: boolean } = {}): Promise<void> {
    const since = Date.now();
    await navigate(this.page, this.cap, url, this.input.journey);
    const dwellMs = opts.dwellMs ?? this.input.journey.dwellMs;
    const wait = Math.min(this.input.bannerWaitMs, Math.max(dwellMs, 1500));
    const popup = this.driver.available ? await this.driver.waitForPopup(wait, since) : null;
    if (popup) {
      this.bannerShown = true;
      this.cmp = popup.cmp;
      this.cap.push({ type: 'banner', t: popup.at - this.cap.startEpoch, state: opts.expectBanner === false ? 'reappeared' : 'shown', cmp: popup.cmp, via: 'autoconsent', pageIndex: this.cap.pageIndex() });
    } else if (await bannerVisible(this.page)) {
      this.bannerShown = true;
      this.cmp = this.cmp ?? 'heuristic';
      this.ev({ type: 'banner', state: opts.expectBanner === false ? 'reappeared' : 'shown', cmp: this.cmp, via: 'heuristic' });
    } else if (opts.expectBanner !== false) {
      this.ev({ type: 'banner', state: 'not-found' });
    }
    const elapsed = Date.now() - since;
    await dwell(this.page, this.cap, Math.max(0, dwellMs - elapsed));
    await this.readout('after-load');
    if (this.bannerShown) await this.shot('banner');
  }

  /** Poll the stored consent state until it stops contradicting `choice` (some
   *  platforms persist the choice through a network round-trip). */
  private async settledReadout(choice: 'accept' | 'reject', budgetMs = 5000): Promise<{ data: Record<string, unknown>; confirmed: boolean | undefined; contradicts: boolean | undefined }> {
    const until = Date.now() + budgetMs;
    for (;;) {
      const data = await readConsentState(this.page);
      const confirmed = readoutConfirms(choice, data);
      const contradicts = readoutContradicts(choice, data);
      if (confirmed === true || (confirmed === undefined && !contradicts) || Date.now() >= until) return { data, confirmed, contradicts };
      await this.page.waitForTimeout(500);
    }
  }

  /** ok = the stored state confirms the choice, or nothing is readable and nothing contradicts it. */
  private static accepted(r: { confirmed: boolean | undefined; contradicts: boolean | undefined }): boolean {
    return r.confirmed === true || (r.confirmed === undefined && !r.contradicts);
  }

  /** Accept or reject through autoconsent, else the heuristic; confirm by readout. */
  async choose(choice: 'accept' | 'reject'): Promise<ChoiceEvent> {
    // Timed at the click: anything the choice itself triggers lands after it.
    const tClick = this.cap.now();
    let ok = false;
    let method = 'none';
    let clicks: number | undefined;
    const notes: string[] = [];
    let readout: { data: Record<string, unknown>; confirmed: boolean | undefined; contradicts: boolean | undefined } | undefined;
    // 1. A known consent tool's own buttons (exact selectors) — the most precise click.
    const known = await findBanner(this.page);
    const knownBtn = known?.via.startsWith('selector:') ? (choice === 'accept' ? known.accept : known.reject) : undefined;
    if (known && knownBtn && (await this.page.click(knownBtn, { timeout: 5000 }).then(() => true).catch(() => false))) {
      method = known.via;
      clicks = 1;
      readout = await this.settledReadout(choice);
      ok = Visit.accepted(readout);
      if (!ok) notes.push(`${method} clicked but the stored consent state did not change`);
    }
    // 2. autoconsent's rule for the detected tool.
    if (!ok && this.driver.available && this.driver.detectedCmp(this.page)) {
      const res = await this.driver.act(this.page, choice === 'accept' ? 'optIn' : 'optOut');
      method = `autoconsent:${res?.cmp ?? this.driver.detectedCmp(this.page)}`;
      clicks = res?.clicks;
      if (res?.result) {
        readout = await this.settledReadout(choice);
        ok = Visit.accepted(readout);
        // autoconsent's self-test only matters when the stored state can't confirm the choice itself.
        if (ok && readout.confirmed !== true && choice === 'reject' && (await this.driver.selfTest(this.page)) === false) {
          ok = false;
          notes.push('autoconsent self-test: the stored choice does not reflect the opt-out');
        }
        if (!ok) notes.push(`${method} clicked but the stored consent state did not change`);
      }
    }
    if (!ok) {
      const h = await heuristicChoice(this.page, choice);
      if (h.clicked) {
        method = h.method;
        clicks = h.clicks;
        readout = await this.settledReadout(choice);
        ok = Visit.accepted(readout);
        if (!ok) notes.push('the stored consent state does not reflect the click');
      } else if (method === 'none') {
        method = h.method;
      }
    }
    if (ok && readout && readout.confirmed === undefined) notes.push('clicked; no readable consent state to confirm it was stored');
    const mismatch = ok && readout ? consentModeMismatch(choice, readout.data) : undefined;
    if (mismatch) notes.push(mismatch);
    await this.readout('after-choice');
    const event: ChoiceEvent = { type: 'choice', t: tClick, choice, ok, method, clicks, note: notes.join('; ') || undefined, pageIndex: this.cap.pageIndex() };
    this.cap.push(event);
    await this.shot(`after-${choice}`);
    return event;
  }

  elapsed(): number {
    return Date.now() - this.openedAt;
  }
}

async function typeMarkers(v: Visit, markers: Markers): Promise<string[]> {
  const notes: string[] = [];
  const typed = await v.page
    .evaluate(() => {
      const visible = (el: Element): boolean => {
        const b = (el as HTMLElement).getBoundingClientRect();
        const cs = getComputedStyle(el as HTMLElement);
        return b.width > 0 && b.height > 0 && cs.visibility !== 'hidden' && cs.display !== 'none';
      };
      const inputs = Array.from(document.querySelectorAll<HTMLInputElement>('input')).filter(visible);
      const email = inputs.find((i) => i.type === 'email' || /e-?mail/i.test(`${i.name} ${i.id} ${i.placeholder} ${i.getAttribute('aria-label') ?? ''}`));
      const search = inputs.find((i) => i.type === 'search' || /^(q|s|query|search|keyword)s?$/i.test(i.name) || /search/i.test(`${i.id} ${i.placeholder} ${i.getAttribute('aria-label') ?? ''}`) || Boolean(i.closest('[role="search"], form[action*="search"]')));
      if (email) email.setAttribute('data-complykit-marker', 'email');
      if (search && search !== email) search.setAttribute('data-complykit-marker', 'search');
      return { email: Boolean(email), search: Boolean(search && search !== email) };
    })
    .catch(() => ({ email: false, search: false }));
  for (const [kind, value] of [['search', markers.text], ['email', markers.email]] as const) {
    if (!typed[kind]) {
      notes.push(`no visible ${kind} field to type the marker into`);
      continue;
    }
    const sel = `[data-complykit-marker="${kind}"]`;
    await v.page.click(sel, { timeout: 3000 }).catch(() => {});
    v.ev({ type: 'action', action: 'type', detail: `${kind} marker (not submitted)` });
    await v.page.type(sel, value, { delay: 40 }).catch(() => {});
    // Blur without submitting — some scripts send on blur/change.
    await v.page.keyboard.press('Tab').catch(() => {});
    await v.page.waitForTimeout(1500);
  }
  return notes;
}

export async function runScenario(input: ScenarioInput): Promise<ScenarioOutput> {
  const { browser, spec, scenario, journey } = input;
  const gpc = GPC_SCENARIOS.includes(scenario);
  fs.mkdirSync(input.evidenceDir, { recursive: true });
  const harPath = path.join(input.evidenceDir, 'visit.har');
  const startedAt = new Date().toISOString();

  const context = await browser.newContext({
    ...contextOptionsFor(spec),
    viewport: { width: 1280, height: 800 },
    deviceScaleFactor: 1,
    serviceWorkers: 'allow',
    ...(gpc ? { extraHTTPHeaders: { 'Sec-GPC': '1' } } : {}),
    ...(input.har ? { recordHar: { path: harPath, content: input.raw ? 'embed' : 'omit', mode: 'full' as const } } : {}),
  });
  const cap = await startCapture(context);
  const driver = new AutoconsentDriver();
  if (gpc) await context.addInitScript(GPC_SOURCE);
  await driver.install(context);
  const v = new Visit(input, context, cap, driver);
  const notTested: string[] = [];
  let status: ScenarioOutput['status'] = 'tested';
  let reason: string | undefined;
  const landing = input.targetUrl;
  const trace = (s: string): void => input.trace?.(`${spec.id}/${scenario}: ${s}`);

  if (!driver.available) notTested.push('banner driver (@duckduckgo/autoconsent) not installed — heuristic banner detection only');
  if (gpc) notTested.push('navigator.globalPrivacyControl inside workers (init scripts do not run in workers; the Sec-GPC header is still sent)');

  const choiceGate = (ev: ChoiceEvent | null): boolean => {
    if (ev && !ev.ok) {
      status = 'not-tested';
      reason = `could not make the "${ev.choice}" choice (${ev.method}${ev.note ? `; ${ev.note}` : ''})`;
      return false;
    }
    return true;
  };

  const body = async (): Promise<void> => {
    await v.newPage();
    switch (scenario) {
      case 'do-nothing': {
        await v.land(landing);
        break;
      }
      case 'browse':
      case 'gpc': {
        await v.land(landing);
        await browse(v.page, cap, journey, landing);
        if (scenario === 'gpc') {
          // §7025(c)(6): is the processed signal displayed? Check the page, then the opt-out link's target.
          const onPage = await findConfirmation(v.page);
          const walk = onPage ? null : await walkOptOutLink(v.page, false);
          v.ev({ type: 'consent-readout', label: 'gpc-acknowledgement', data: { found: Boolean(onPage ?? walk?.confirmation), text: onPage ?? walk?.confirmation, via: onPage ? 'page' : walk?.found ? 'opt-out-link' : 'none' } });
          if (walk?.found) await navigate(v.page, cap, landing, journey);
        }
        await flush(v.page, cap, landing, journey);
        break;
      }
      case 'markers': {
        const u = new URL(landing);
        for (const [k, val] of Object.entries(input.markers.clickIds)) u.searchParams.set(k, val);
        await v.land(u.toString());
        notTested.push(...(await typeMarkers(v, input.markers)));
        await dwell(v.page, cap, Math.min(4000, journey.pageDwellMs));
        await browse(v.page, cap, { ...journey, maxPages: 1 }, landing);
        await flush(v.page, cap, landing, journey);
        break;
      }
      case 'opt-out-link': {
        await v.land(landing);
        const walk = await walkOptOutLink(v.page, false);
        v.ev({ type: 'opt-out-walk', ...walk });
        await v.shot('opt-out-link');
        break;
      }
      case 'opt-out-all': {
        await v.land(landing);
        if (v.bannerShown) {
          const ev = await v.choose('reject');
          if (!ev.ok) notTested.push(`banner reject failed (${ev.method}) — opted out by signal and link only`);
        }
        const tLink = cap.now();
        const walk = await walkOptOutLink(v.page, true);
        v.ev({ type: 'opt-out-walk', ...walk });
        v.ev({ type: 'choice', choice: 'opt-out-link', ok: walk.performed === true, method: walk.performed ? 'link+control' : walk.found ? 'link' : 'none', note: walk.requiredFields.length ? `requires ${walk.requiredFields.join(', ')} — not submitted` : undefined }, tLink);
        await v.shot('after-opt-out');
        await navigate(v.page, cap, landing, journey);
        await dwell(v.page, cap, journey.pageDwellMs);
        await browse(v.page, cap, journey, landing);
        await flush(v.page, cap, landing, journey);
        break;
      }
      case 'dismiss':
      case 'reject':
      case 'accept':
      case 'partial':
      case 'withdraw':
      case 'return-visit': {
        await v.land(landing);
        if (!v.bannerShown) {
          status = 'not-applicable';
          reason = 'no consent banner detected (if the site shows one, the driver did not recognize it)';
          break;
        }
        if (scenario === 'dismiss') {
          const t0 = cap.now();
          const d = await dismissBanner(v.page);
          v.ev({ type: 'choice', choice: 'dismiss', ok: d.ok, method: d.method }, t0);
          await v.shot('after-dismiss');
          if (!d.ok) {
            // A banner with no close control is a design fact, not a test failure.
            status = d.noClose ? 'not-applicable' : 'not-tested';
            reason = d.noClose ? 'the banner offers no way to close it without choosing' : 'could not close the banner without choosing';
            break;
          }
          await v.readout('after-choice');
          await browse(v.page, cap, journey, landing);
          await flush(v.page, cap, landing, journey);
          break;
        }
        if (scenario === 'partial') {
          const t0 = cap.now();
          const p = await partialConsent(v.page);
          v.ev({ type: 'choice', choice: 'partial', ok: p.ok, method: p.method, note: 'analytics only' }, t0);
          await v.shot('after-partial');
          if (!p.ok) {
            status = 'not-tested';
            reason = 'could not grant a single category (no recognizable analytics-only control)';
            break;
          }
          await v.readout('after-choice');
          await browse(v.page, cap, journey, landing);
          await flush(v.page, cap, landing, journey);
          break;
        }
        if (scenario === 'accept') {
          if (!choiceGate(await v.choose('accept'))) break;
          await browse(v.page, cap, journey, landing);
          await flush(v.page, cap, landing, journey);
          break;
        }
        if (scenario === 'withdraw') {
          if (!choiceGate(await v.choose('accept'))) break;
          await browse(v.page, cap, { ...journey, maxPages: 1 }, landing);
          await navigate(v.page, cap, landing, journey);
          await dwell(v.page, cap, Math.min(3000, journey.pageDwellMs));
          const re = await reopenSettings(v.page);
          let ok = false;
          let method = `reopen:${re.method}`;
          let tWithdraw = cap.now();
          if (re.ok) {
            await v.page.waitForTimeout(1200);
            tWithdraw = cap.now();
            const viaDriver = driver.available ? await driver.act(v.page, 'optOut', 12000) : null;
            if (viaDriver?.result) {
              ok = true;
              method += `+autoconsent:${viaDriver.cmp}`;
            } else {
              ok = await rejectInOpenSettings(v.page);
              method += ok ? '+settings-reject' : '';
            }
          }
          await v.page.waitForTimeout(1200);
          const data = await v.readout('after-choice');
          const conf = readoutConfirms('reject', data);
          if (ok && (conf === false || (conf === undefined && readoutContradicts('reject', data)))) ok = false;
          v.ev({ type: 'choice', choice: 'withdraw', ok, method, note: re.ok ? undefined : 'no way to reopen the consent settings was found' }, tWithdraw);
          await v.shot('after-withdraw');
          if (!re.ok) {
            // Not a failed test: "no withdrawal entry point" is itself the evidence.
            break;
          }
          if (!ok) {
            status = 'not-tested';
            reason = 'reopened settings but could not withdraw';
            break;
          }
          v.ev({ type: 'action', action: 'reload', url: landing });
          await navigate(v.page, cap, landing, journey);
          await dwell(v.page, cap, journey.pageDwellMs);
          await browse(v.page, cap, { ...journey, maxPages: 1 }, landing);
          await flush(v.page, cap, landing, journey);
          break;
        }
        // reject + return-visit
        if (!choiceGate(await v.choose('reject'))) break;
        v.ev({ type: 'action', action: 'reload', url: landing });
        await navigate(v.page, cap, landing, journey);
        await dwell(v.page, cap, journey.pageDwellMs);
        if (scenario === 'reject') {
          await browse(v.page, cap, journey, landing);
          await flush(v.page, cap, landing, journey);
          break;
        }
        // return-visit: leave, come back in a new tab of the same profile.
        await browse(v.page, cap, { ...journey, maxPages: 1 }, landing);
        await v.page.close().catch(() => {});
        v.ev({ type: 'note', text: 'return visit: new tab, same browser profile' });
        await v.newPage();
        v.bannerShown = false;
        await v.land(landing, { expectBanner: false });
        await scrollSteps(v.page, cap, journey.scrollSteps);
        await flush(v.page, cap, landing, journey);
        break;
      }
    }
  };
  try {
    const budget = input.scenarioTimeoutMs ?? 300000;
    const timedOut = await new Promise<boolean>((resolve, reject) => {
      const timer = setTimeout(() => resolve(true), budget);
      body().then(
        () => {
          clearTimeout(timer);
          resolve(false);
        },
        (e) => {
          clearTimeout(timer);
          reject(e);
        },
      );
    });
    if (timedOut) {
      status = 'not-tested';
      reason = `scenario exceeded its ${Math.round(budget / 1000)}s budget; evidence up to that point is kept`;
      trace(reason);
    }
  } catch (err) {
    status = 'not-tested';
    reason = `scenario crashed: ${err instanceof Error ? err.message.slice(0, 160) : String(err)}`;
    trace(reason);
  }

  if (process.env.COMPLYKIT_DEBUG) trace('stage: stop');
  const pages = context.pages();
  const result = await cap.stop(pages);
  if (process.env.COMPLYKIT_DEBUG) trace('stage: close');
  const durationMs = Date.now() - cap.startEpoch;
  // Ad-heavy pages keep long-poll and streaming requests open, and closing the
  // context (which finalizes the HAR) waits on them — ten minutes, on one news
  // site. Stop new traffic, close the pages, and bound the close.
  await withTimeout(context.route('**/*', (r) => r.abort().catch(() => {})), 2000, undefined);
  for (const p of context.pages()) await withTimeout(p.close({ runBeforeUnload: false }), 5000, undefined);
  const closed = await withTimeout(context.close().then(() => true), 60000, false);
  if (!closed) notTested.push('HAR export may be incomplete: the browser context did not close within 60s');
  if (process.env.COMPLYKIT_DEBUG) trace('stage: closed');
  if (input.har && !input.raw) redactHarFile(harPath);
  notTested.push(...result.notes);
  for (const f of result.frames) {
    if (f.sandboxed) notTested.push(`storage inside sandboxed frame ${f.url.slice(0, 80)} (opaque origin, unreadable)`);
  }
  if (result.frames.some((f) => !f.url.startsWith(new URL(landing).origin))) {
    notTested.push('page-exit sends from cross-origin frames (recovered only for same-origin navigations)');
  }

  const timeline: Timeline = {
    location: spec,
    verification: { ...input.verification, siteReported: [...v.siteReported.values()] },
    events: result.events,
    snapshot: {
      site: input.site,
      scenario,
      locationId: spec.id,
      startedAt,
      durationMs,
      gpc,
      browser: { name: 'chromium', version: browser.version() },
      pages: cap.pages(),
      cookies: result.cookies,
      storage: result.storage,
      frames: result.frames,
      dns: [],
      markers: scenario === 'markers' ? input.markers : undefined,
      notTested: [...new Set(notTested)],
      evidence: {
        har: input.har && fs.existsSync(harPath) ? path.join(input.evidenceRel, 'visit.har') : undefined,
        timeline: path.join(input.evidenceRel, 'timeline.json'),
      },
    },
  };
  trace(`${status}${reason ? ` (${reason})` : ''} — ${result.events.filter((e) => e.type === 'request').length} requests, ${result.cookies.length} cookies, ${Math.round(durationMs / 1000)}s`);
  return { timeline, status, reason, screenshots: v.screenshots, siteReported: [...v.siteReported.values()] };
}

/** Write the timeline evidence file (redacted unless raw). */
export function writeTimelineEvidence(dir: string, timeline: Timeline, raw: boolean): void {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'timeline.json'), JSON.stringify(raw ? timeline : redactTimeline(timeline), null, 1));
}
