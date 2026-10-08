import fs from 'node:fs';
import path from 'node:path';
import type { Browser, BrowserContext, Page } from 'playwright';
import {
  putEvidence,
  redactTimeline,
  detectConsentTool,
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
  detectBlock,
  consentFrameVisible,
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
import { browse, dwell, flush, navigate, scrollSteps, type ResolvedJourney, type SearchStep } from './journey.js';
import { contextOptionsFor } from './location.js';
import { GPC_SOURCE } from './shim.js';
import { redactHarFile } from './har.js';
import { collectPlatformSignals } from './platform.js';
import { watchMarkup } from './markup.js';
import { readFirstLayer, readSecondLayer, readAfterChoice } from './banner-design.js';
import { readComplykit, complykitRunning, complykitWithdraw } from './complykit.js';
import { installLocalCopy, type LocalCopy } from './local-copy.js';
import { StepTimer, step, topSteps, pathOf, formatSeconds } from './steps.js';
import { BANNER_DESIGN_LABEL, BANNER_SECOND_LAYER_LABEL, BANNER_AFTER_CHOICE_LABEL } from '../../../record/index.js';

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
  /** Which visit of this scenario this is: 1 = normal, 2+ = repeat under throttling (A7). Default 1. */
  run?: number;
  /** Slow-3G network + CPU slowdown on every page (a timing-race pass). */
  throttle?: boolean;
  /** Local-copy mode: the site's documents are rewritten in this context (local-copy.ts). */
  localCopy?: LocalCopy;
  trace?: (line: string) => void;
}

/** The throttled pass: Slow 3G (Lighthouse's numbers) and a 4x CPU slowdown. Applies to page requests; dedicated-worker and service-worker traffic runs unthrottled. */
export const THROTTLE = { latencyMs: 400, downloadBps: 51200, uploadBps: 51200, cpuRate: 4 } as const;

export interface ScenarioOutput {
  timeline: Timeline;
  status: 'tested' | 'not-tested' | 'not-applicable';
  reason?: string;
  screenshots: string[];
  siteReported: Array<{ source: string; value: string }>;
}

class BlockedError extends Error {}

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

const GPC_SCENARIOS: ScenarioId[] = ['gpc', 'opt-out-all'];

class Visit {
  page!: Page;
  readonly screenshots: string[] = [];
  readonly siteReported = new Map<string, { source: string; value: string }>();
  bannerShown = false;
  cmp?: string;
  blocked?: string;
  throttleFailed?: string;
  private defaultToolRead = false;
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
    return step('new-page', () => this.openPage());
  }

  private async openPage(): Promise<Page> {
    this.page = await this.context.newPage();
    this.page.setDefaultTimeout(this.input.throttle ? 45000 : 15000);
    if (this.input.throttle) await this.throttlePage(this.page);
    await this.cap.watchPage(this.page, true);
    return this.page;
  }

  /** CDP network + CPU throttling for this page (Chromium only; the run is recorded as not throttled otherwise). */
  private async throttlePage(page: Page): Promise<void> {
    try {
      const cdp = await this.context.newCDPSession(page);
      await cdp.send('Network.enable');
      await cdp.send('Network.emulateNetworkConditions', {
        offline: false,
        latency: THROTTLE.latencyMs,
        downloadThroughput: THROTTLE.downloadBps,
        uploadThroughput: THROTTLE.uploadBps,
      });
      await cdp.send('Emulation.setCPUThrottlingRate', { rate: THROTTLE.cpuRate });
    } catch (err) {
      this.throttleFailed = `throttling could not be applied (${err instanceof Error ? err.message.slice(0, 100) : 'failed'})`;
    }
  }

  async shot(label: string): Promise<void> {
    await step('shot', () => this.takeShot(label), label);
  }

  private async takeShot(label: string): Promise<void> {
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

  /** Banner design readouts (F6); what they could not measure becomes not-tested notes. */
  readonly designNotes: string[] = [];
  async design(kind: 'first' | 'second' | 'after', opts: { open?: boolean; choice?: 'accept' | 'reject' } = {}): Promise<void> {
    const read: Promise<{ label: string; data: { unmeasured: string[] } }> =
      kind === 'first'
        ? readFirstLayer(this.page, this.cmp && this.cmp !== 'heuristic' ? this.cmp : undefined).then((data) => ({ label: BANNER_DESIGN_LABEL, data }))
        : kind === 'second'
          ? readSecondLayer(this.page, opts.open === true).then((data) => ({ label: BANNER_SECOND_LAYER_LABEL, data }))
          : readAfterChoice(this.page, opts.choice ?? 'accept').then((data) => ({ label: BANNER_AFTER_CHOICE_LABEL, data }));
    const r = await step(`design-${kind}`, () => withTimeout(read.catch(() => null), 15000, null));
    if (!r) {
      this.designNotes.push(`banner design: ${kind === 'first' ? 'first layer' : kind === 'second' ? 'settings layer' : 'after-choice'} readout timed out — not tested`);
      return;
    }
    this.ev({ type: 'consent-readout', label: r.label, data: r.data as unknown as Record<string, unknown> });
    this.designNotes.push(...r.data.unmeasured);
  }

  async readout(label: string): Promise<Record<string, unknown>> {
    const data = await step('readout', () => readConsentState(this.page), label);
    this.ev({ type: 'consent-readout', label, data });
    for (const r of siteReportedRegion(data)) this.siteReported.set(r.source, r);
    return data;
  }

  /** First landing only: the fresh profile's stored consent state, before any interaction, decoded to name the tool and its default. */
  private async readDefaultConsentTool(): Promise<void> {
    if (this.defaultToolRead) return;
    this.defaultToolRead = true;
    try {
      const cookies = (await this.context.cookies()).map((c) => ({ name: c.name, value: c.value }));
      const storage = await this.page
        .evaluate(() => Array.from({ length: localStorage.length }, (_, i) => localStorage.key(i) ?? '').map((key) => ({ key, value: (localStorage.getItem(key) ?? '').slice(0, 4096) })))
        .catch(() => [] as Array<{ key: string; value: string }>);
      const tool = detectConsentTool({ cookies, storage, bannerVendor: this.bannerShown ? (this.cmp === 'heuristic' ? 'unidentified banner' : this.cmp) : undefined });
      this.ev({ type: 'consent-readout', label: 'default-consent-tool', data: tool as unknown as Record<string, unknown> });
    } catch {
      /* unreadable: the record simply has no consentTool */
    }
  }

  /** First landing only: complykit's own tool, if installed — global, config element, cookie, state, diagnostics (D10). */
  private complykitRead = false;
  private async readComplykitTool(): Promise<void> {
    if (this.complykitRead) return;
    this.complykitRead = true;
    const snap = await readComplykit(this.page);
    if (snap?.present) this.ev({ type: 'consent-readout', label: 'complykit-tool', data: snap as unknown as Record<string, unknown> });
  }

  /** Land on a URL and watch for the banner while dwelling. */
  async land(url: string, opts: { dwellMs?: number; expectBanner?: boolean } = {}): Promise<void> {
    await step('land', () => this.landUntimed(url, opts), pathOf(url));
  }

  private async landUntimed(url: string, opts: { dwellMs?: number; expectBanner?: boolean }): Promise<void> {
    const since = Date.now();
    await navigate(this.page, this.cap, url, this.input.journey);
    this.blocked = await step('detect-block', () => detectBlock(this.page));
    if (this.blocked) {
      this.ev({ type: 'note', text: `bot protection: ${this.blocked}` });
      throw new BlockedError(this.blocked);
    }
    const dwellMs = opts.dwellMs ?? this.input.journey.dwellMs;
    const wait = Math.min(this.input.bannerWaitMs, Math.max(dwellMs, 1500));
    const popup = this.driver.available ? await step('banner-wait', () => this.driver.waitForPopup(wait, since)) : null;
    // autoconsent can report a popup that no visitor sees (a consent tool loaded
    // in a mode with nothing on screen) — require something visible.
    // …and give it a moment: some tools report the popup before it is painted
    // (Termly draws ~1–3s later).
    const visibleNow = async (): Promise<boolean> => (await bannerVisible(this.page)) || (await consentFrameVisible(this.page));
    const seen = !popup
      ? false
      : await step('banner-visible', async () => {
          let visible = await visibleNow();
          for (let until = Date.now() + 5000; !visible && Date.now() < until; ) {
            await this.page.waitForTimeout(500);
            visible = await visibleNow();
          }
          return visible;
        });
    if (popup && !seen) this.ev({ type: 'note', text: `consent tool detected (${popup.cmp}) but no banner is visible` });
    if (popup && seen) {
      this.bannerShown = true;
      this.cmp = popup.cmp;
      this.cap.push({ type: 'banner', t: popup.at - this.cap.startEpoch, state: opts.expectBanner === false ? 'reappeared' : 'shown', cmp: popup.cmp, via: 'autoconsent', pageIndex: this.cap.pageIndex() });
    } else {
      // A known tool's exact selectors name it (complykit, OneTrust, …); only a
      // text match is 'heuristic'.
      const found = await step('find-banner', () => findBanner(this.page));
      if (found) {
        this.bannerShown = true;
        this.cmp = this.cmp ?? (found.via.startsWith('selector:') ? found.via.slice('selector:'.length) : 'heuristic');
        this.ev({ type: 'banner', state: opts.expectBanner === false ? 'reappeared' : 'shown', cmp: this.cmp, via: found.via.startsWith('selector:') ? 'selector' : 'heuristic' });
      } else if (opts.expectBanner !== false) {
        this.ev({ type: 'banner', state: 'not-found' });
      }
    }
    const elapsed = Date.now() - since;
    await dwell(this.page, this.cap, Math.max(0, dwellMs - elapsed));
    await this.readout('after-load');
    await step('default-tool', () => this.readDefaultConsentTool());
    await step('complykit-tool', () => this.readComplykitTool());
    if (this.bannerShown) await this.shot('banner');
    // Banner design (F6): read once per location, in the scenario that never
    // touches the banner — the readouts are measurements only, no clicks.
    if (this.input.scenario === 'do-nothing' && opts.expectBanner !== false) {
      await this.design('first');
      if (this.bannerShown) await this.design('second', { open: false });
    }
  }

  /** Poll the stored consent state until it stops contradicting `choice` (some
   *  platforms persist the choice through a network round-trip). */
  private settledReadout(choice: 'accept' | 'reject', budgetMs = 5000): Promise<{ data: Record<string, unknown>; confirmed: boolean | undefined; contradicts: boolean | undefined }> {
    return step('settle', () => this.settle(choice, budgetMs));
  }

  private async settle(choice: 'accept' | 'reject', budgetMs: number): Promise<{ data: Record<string, unknown>; confirmed: boolean | undefined; contradicts: boolean | undefined }> {
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
  choose(choice: 'accept' | 'reject'): Promise<ChoiceEvent> {
    return step('choose', () => this.chooseUntimed(choice), choice);
  }

  private async chooseUntimed(choice: 'accept' | 'reject'): Promise<ChoiceEvent> {
    // Timed at the click: anything the choice itself triggers lands after it.
    const tClick = this.cap.now();
    let ok = false;
    let method = 'none';
    let clicks: number | undefined;
    const notes: string[] = [];
    let readout: { data: Record<string, unknown>; confirmed: boolean | undefined; contradicts: boolean | undefined } | undefined;
    // 1. A known consent tool's own buttons (exact selectors) — the most precise click.
    const known = await step('find-banner', () => findBanner(this.page));
    const knownBtn = known?.via.startsWith('selector:') ? (choice === 'accept' ? known.accept : known.reject) : undefined;
    if (known && knownBtn && (await this.page.click(knownBtn, { timeout: 5000 }).then(() => true).catch(() => false))) {
      method = known.via;
      clicks = 1;
      readout = await this.settledReadout(choice);
      ok = Visit.accepted(readout);
      if (!ok) notes.push(`${method} clicked but the stored consent state did not change`);
    }
    // complykit's own tool is driven by its exact hooks only (D10): when it is on
    // the page and its button did not take, no autoconsent rule or text match
    // stands in for it — the choice is recorded as not taken.
    const ours = !ok && (known?.via === 'selector:complykit' || (await complykitRunning(this.page)));
    if (ours) {
      notes.push('complykit’s tool is on the page: driven by its exact hooks only, no fallback');
      if (method === 'none') method = `complykit:${choice} button not clickable`;
    }
    // 2. autoconsent's rule for the detected tool.
    if (!ok && !ours && this.driver.available && this.driver.detectedCmp(this.page)) {
      const res = await step('autoconsent', () => this.driver.act(this.page, choice === 'accept' ? 'optIn' : 'optOut'));
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
    if (!ok && !ours) {
      const h = await step('heuristic', () => heuristicChoice(this.page, choice));
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
    if (ok) await this.design('after', { choice });
    const event: ChoiceEvent = { type: 'choice', t: tClick, choice, ok, method, clicks, note: notes.join('; ') || undefined, pageIndex: this.cap.pageIndex() };
    this.cap.push(event);
    await this.shot(`after-${choice}`);
    return event;
  }

  elapsed(): number {
    return Date.now() - this.openedAt;
  }
}

function typeMarkers(v: Visit, markers: Markers): Promise<string[]> {
  return step('type-markers', () => typeMarkersUntimed(v, markers));
}

async function typeMarkersUntimed(v: Visit, markers: Markers): Promise<string[]> {
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
  const trace = (s: string): void => input.trace?.(`${input.spec.id}/${input.scenario}: ${s}`);
  // Per-step timing (steps.ts): always summarized on the snapshot; each step traced under COMPLYKIT_DEBUG.
  const timer = new StepTimer({ trace: process.env.COMPLYKIT_DEBUG ? trace : undefined });
  return timer.run(() => runTimedScenario(input, timer, trace));
}

async function runTimedScenario(input: ScenarioInput, timer: StepTimer, trace: (s: string) => void): Promise<ScenarioOutput> {
  const { browser, spec, scenario, journey } = input;
  const gpc = GPC_SCENARIOS.includes(scenario);
  const run = input.run ?? 1;
  fs.mkdirSync(input.evidenceDir, { recursive: true });
  const harPath = path.join(input.evidenceDir, 'visit.har');
  const startedAt = new Date().toISOString();

  const { context, cap, markupWatch, driver } = await step('setup', async () => {
    const context = await browser.newContext({
      ...contextOptionsFor(spec, browser.version()),
      viewport: { width: 1280, height: 800 },
      deviceScaleFactor: 1,
      serviceWorkers: 'allow',
      ...(gpc ? { extraHTTPHeaders: { 'Sec-GPC': '1' } } : {}),
      ...(input.har ? { recordHar: { path: harPath, content: input.raw ? 'embed' : 'omit', mode: 'full' as const } } : {}),
    });
    // Local copy first: the rewritten documents are what every watcher below sees.
    if (input.localCopy) await installLocalCopy(context, input.localCopy);
    const cap = await startCapture(context);
    const markupWatch = watchMarkup(context);
    const driver = new AutoconsentDriver();
    if (gpc) await context.addInitScript(GPC_SOURCE);
    await driver.install(context);
    return { context, cap, markupWatch, driver };
  });
  const v = new Visit(input, context, cap, driver);
  const notTested: string[] = [];
  // The journey searches the site once per scenario, with the same text marker the markers scenario types.
  const search: SearchStep = { term: input.markers.text, note: (r) => notTested.push(r) };
  let status: ScenarioOutput['status'] = 'tested';
  let reason: string | undefined;
  const landing = input.targetUrl;

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
        // A "signal honored" notice can be transient — read it on arrival too.
        const onArrival = scenario === 'gpc' ? await step('confirmation', () => findConfirmation(v.page)) : undefined;
        await browse(v.page, cap, journey, landing, search);
        if (scenario === 'gpc') {
          // §7025(c)(6): is the processed signal displayed? Check the page, then the opt-out link's target.
          const onPage = onArrival ?? (await step('confirmation', () => findConfirmation(v.page)));
          const walk = onPage ? null : await step('opt-out-link', () => walkOptOutLink(v.page, false));
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
        // The link alone: no banner choice, no signal. Use it, then browse, so the
        // column shows what still runs after a visitor opts out this way.
        await v.land(landing);
        const tLink = cap.now();
        const walk = await step('opt-out-link', () => walkOptOutLink(v.page, true));
        v.ev({ type: 'opt-out-walk', ...walk });
        v.ev({ type: 'choice', choice: 'opt-out-link', ok: walk.performed === true, method: walk.performed ? 'link+control' : walk.found ? 'link' : 'none', note: walk.requiredFields.length ? `requires ${walk.requiredFields.join(', ')} — not submitted` : undefined }, tLink);
        await v.shot('opt-out-link');
        if (walk.performed) {
          await navigate(v.page, cap, landing, journey);
          await dwell(v.page, cap, journey.pageDwellMs);
          await browse(v.page, cap, journey, landing, search);
          await flush(v.page, cap, landing, journey);
        }
        break;
      }
      case 'opt-out-all': {
        await v.land(landing);
        if (v.bannerShown) {
          const ev = await v.choose('reject');
          if (!ev.ok) notTested.push(`banner reject failed (${ev.method}) — opted out by signal and link only`);
        }
        const tLink = cap.now();
        const walk = await step('opt-out-link', () => walkOptOutLink(v.page, true));
        v.ev({ type: 'opt-out-walk', ...walk });
        v.ev({ type: 'choice', choice: 'opt-out-link', ok: walk.performed === true, method: walk.performed ? 'link+control' : walk.found ? 'link' : 'none', note: walk.requiredFields.length ? `requires ${walk.requiredFields.join(', ')} — not submitted` : undefined }, tLink);
        await v.shot('after-opt-out');
        await navigate(v.page, cap, landing, journey);
        await dwell(v.page, cap, journey.pageDwellMs);
        await browse(v.page, cap, journey, landing, search);
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
          const d = await step('dismiss', () => dismissBanner(v.page));
          v.ev({ type: 'choice', choice: 'dismiss', ok: d.ok, method: d.method }, t0);
          await v.shot('after-dismiss');
          if (!d.ok) {
            // A banner with no close control is a design fact, not a test failure.
            status = d.noClose ? 'not-applicable' : 'not-tested';
            reason = d.noClose ? 'the banner offers no way to close it without choosing' : 'could not close the banner without choosing';
            break;
          }
          await v.readout('after-choice');
          await browse(v.page, cap, journey, landing, search);
          await flush(v.page, cap, landing, journey);
          break;
        }
        if (scenario === 'partial') {
          // The settings layer's default toggles (F6), opened here because partial opens it anyway.
          await v.design('second', { open: true });
          const t0 = cap.now();
          const p = await step('partial', () => partialConsent(v.page));
          v.ev({ type: 'choice', choice: 'partial', ok: p.ok, method: p.method, note: 'analytics only' }, t0);
          await v.shot('after-partial');
          if (!p.ok) {
            status = 'not-tested';
            reason = 'could not grant a single category (no recognizable analytics-only control)';
            break;
          }
          await v.readout('after-choice');
          await browse(v.page, cap, journey, landing, search);
          await flush(v.page, cap, landing, journey);
          break;
        }
        if (scenario === 'accept') {
          if (!choiceGate(await v.choose('accept'))) break;
          await browse(v.page, cap, journey, landing, search);
          await flush(v.page, cap, landing, journey);
          break;
        }
        if (scenario === 'withdraw') {
          if (!choiceGate(await v.choose('accept'))) break;
          await browse(v.page, cap, { ...journey, maxPages: 1 }, landing, search);
          await navigate(v.page, cap, landing, journey);
          await dwell(v.page, cap, Math.min(3000, journey.pageDwellMs));
          let ok = false;
          let method: string;
          let tWithdraw = cap.now();
          let re: { ok: boolean; method: string };
          const ours = await complykitRunning(v.page);
          if (ours) {
            // Our own tool (D10): the Privacy choices control, then its settings' Reject all — exact hooks.
            const w = await step('withdraw', () => complykitWithdraw(v.page));
            re = w.reopened;
            ok = w.ok;
            method = w.method;
          } else {
            re = await step('reopen', () => reopenSettings(v.page));
            method = `reopen:${re.method}`;
          }
          // Our tool: its exact hooks or its API only — never autoconsent or text matching (D10).
          if (re.ok && !ok && !ours) {
            await v.page.waitForTimeout(1200);
            tWithdraw = cap.now();
            const viaDriver = driver.available ? await step('autoconsent', () => driver.act(v.page, 'optOut', 12000)) : null;
            if (viaDriver?.result) {
              ok = true;
              method += `+autoconsent:${viaDriver.cmp}`;
            } else {
              ok = await step('settings-reject', () => rejectInOpenSettings(v.page));
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
          // Journey parity (D10 follow-up): the search already ran while consent was granted, so it runs again here —
          // a vendor that fires only on a search proves nothing by staying quiet in a withdrawn visit that never searched.
          const searchAgain: SearchStep = { term: input.markers.text, note: (r) => void (notTested.includes(r) || notTested.push(r)) };
          await browse(v.page, cap, { ...journey, maxPages: 1 }, landing, searchAgain);
          await flush(v.page, cap, landing, journey);
          break;
        }
        // reject + return-visit
        if (!choiceGate(await v.choose('reject'))) break;
        v.ev({ type: 'action', action: 'reload', url: landing });
        await navigate(v.page, cap, landing, journey);
        await dwell(v.page, cap, journey.pageDwellMs);
        if (scenario === 'reject') {
          await browse(v.page, cap, journey, landing, search);
          await flush(v.page, cap, landing, journey);
          break;
        }
        // return-visit: leave, come back in a new tab of the same profile.
        await browse(v.page, cap, { ...journey, maxPages: 1 }, landing, search);
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
      const open = timer.summary().filter((st) => st.open);
      if (open.length) trace(`still running at the budget: ${open.map((st) => `${st.step} ${formatSeconds(st.ms)}`).join(', ')}`);
    }
  } catch (err) {
    status = 'not-tested';
    reason =
      err instanceof BlockedError
        ? `bot protection blocked the visit (${err.message}) — a recorded coverage gap, not evidence about the site`
        : `scenario crashed: ${err instanceof Error ? err.message.slice(0, 160) : String(err)}`;
    trace(reason);
  }

  if (process.env.COMPLYKIT_DEBUG) trace('stage: stop');
  const { platformSignals, result, markup } = await step('teardown', async () => {
    const pages = context.pages();
    const platformSignals = await step('platform-signals', () => collectPlatformSignals(pages));
    const result = await step('capture-stop', () => cap.stop(pages));
    // After the evidence snapshot: any re-fetch's cookies stay out of it.
    const markup = await step('markup', () => markupWatch.finish(cap.pages()));
    return { platformSignals, result, markup };
  });
  if (process.env.COMPLYKIT_DEBUG) trace('stage: close');
  const durationMs = Date.now() - cap.startEpoch;
  // Ad-heavy pages keep long-poll and streaming requests open, and closing the
  // context (which finalizes the HAR) waits on them — ten minutes, on one news
  // site. Stop new traffic, close the pages, and bound the close.
  // (After durationMs: the close is in the step summary, not the visit's duration.)
  const closed = await step('close', async () => {
    await step('route-abort', () => withTimeout(context.route('**/*', (r) => r.abort().catch(() => {})), 2000, undefined));
    await step('page-close', async () => {
      for (const p of context.pages()) await withTimeout(p.close({ runBeforeUnload: false }), 5000, undefined);
    });
    return step('context-close', () => withTimeout(context.close().then(() => true), 60000, false));
  });
  if (!closed) notTested.push('HAR export may be incomplete: the browser context did not close within 60s');
  if (process.env.COMPLYKIT_DEBUG) trace('stage: closed');
  if (input.har && !input.raw) redactHarFile(harPath);
  notTested.push(...result.notes, ...v.designNotes);
  for (const f of result.frames) {
    if (f.sandboxed) notTested.push(`storage inside sandboxed frame ${f.url.slice(0, 80)} (opaque origin, unreadable)`);
  }
  if (result.frames.some((f) => !f.url.startsWith(new URL(landing).origin))) {
    notTested.push('page-exit sends from cross-origin frames (recovered only for same-origin navigations)');
  }

  const steps = timer.summary();
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
      run: input.run ? run : undefined,
      throttled: input.throttle ? !v.throttleFailed : undefined,
      browser: { name: 'chromium', version: browser.version() },
      pages: cap.pages(),
      cookies: result.cookies,
      storage: result.storage,
      frames: result.frames,
      platformSignals,
      markup,
      dns: [],
      markers: scenario === 'markers' ? input.markers : undefined,
      notTested: [...new Set([...notTested, ...(v.throttleFailed ? [v.throttleFailed] : [])])],
      steps,
      evidence: {
        har: input.har && fs.existsSync(harPath) ? path.join(input.evidenceRel, 'visit.har') : undefined,
        timeline: path.join(input.evidenceRel, 'timeline.json'),
      },
    },
  };
  const top = topSteps(steps, 3);
  trace(`${status}${reason ? ` (${reason})` : ''} — ${result.events.filter((e) => e.type === 'request').length} requests, ${result.cookies.length} cookies, ${Math.round(durationMs / 1000)}s${top ? ` (${top})` : ''}`);
  return { timeline, status, reason, screenshots: v.screenshots, siteReported: [...v.siteReported.values()] };
}

/** Write the timeline evidence file (redacted unless raw). */
export function writeTimelineEvidence(dir: string, timeline: Timeline, raw: boolean): void {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'timeline.json'), JSON.stringify(raw ? timeline : redactTimeline(timeline), null, 1));
}
