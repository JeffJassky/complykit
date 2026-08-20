import type { Page, BrowserContext, Browser } from 'playwright';
import type { Artifact, Subject, CoverageGap } from '../../record/index.js';
import { openEvidenceContext, type ViewportSize } from './session.js';
import { settle } from './settle.js';
import { startCapture } from './cdp-capture.js';

// GDPR consent evidence (browser-analysis-design channel D) + the CMP-selector
// spike. Three-way capture over a PRISTINE evidence profile, fresh context per
// path (no consent leakage). Known-vendor selectors first, then heuristics.

interface CmpVendor {
  name: string;
  banner: string;
  accept: string;
  reject?: string;
  manage?: string; // opening this then rejecting = 2 clicks to reject (buried)
}

// The spike result: the CMP selector table. Covers the common EU vendors; the
// heuristic path catches the long tail. Recorded in plans/spikes.md.
const CMP_VENDORS: CmpVendor[] = [
  { name: 'OneTrust', banner: '#onetrust-banner-sdk', accept: '#onetrust-accept-btn-handler', reject: '#onetrust-reject-all-handler', manage: '#onetrust-pc-btn-handler' },
  { name: 'Cookiebot', banner: '#CybotCookiebotDialog', accept: '#CybotCookiebotDialogBodyLevelButtonLevelOptinAllowAll,#CybotCookiebotDialogBodyButtonAccept', reject: '#CybotCookiebotDialogBodyButtonDecline' },
  { name: 'Didomi', banner: '#didomi-notice', accept: '#didomi-notice-agree-button', reject: '#didomi-notice-disagree-button' },
  { name: 'Usercentrics', banner: '[data-testid="uc-default-banner"],#usercentrics-root', accept: '[data-testid="uc-accept-all-button"]', reject: '[data-testid="uc-deny-all-button"]' },
  { name: 'TrustArc', banner: '#truste-consent-track', accept: '#truste-consent-button', reject: '#truste-consent-required-button' },
  { name: 'Osano/CookieConsent', banner: '.cc-window', accept: '.cc-allow', reject: '.cc-deny' },
  { name: 'Complianz', banner: '.cmplz-cookiebanner', accept: '.cmplz-accept', reject: '.cmplz-deny' },
  { name: 'Quantcast', banner: '.qc-cmp2-summary-buttons', accept: '.qc-cmp2-summary-buttons button[mode="primary"]' },
];

const ACCEPT_TEXT = /\b(accept|allow all|agree|got it|i agree|allow cookies|ok)\b/i;
const REJECT_TEXT = /\b(reject|decline|deny|refuse|necessary only|essential only)\b/i;
const MANAGE_TEXT = /\b(manage|settings|preferences|customi[sz]e|options)\b/i;

export interface ButtonMetric {
  role: 'accept' | 'reject' | 'manage';
  area: number;
  fontSizePx: number;
  background: string;
  visible: boolean;
}

export interface CmpDetection {
  vendor: string | null;
  bannerFound: boolean;
  acceptSelector?: string;
  rejectSelector?: string;
  manageSelector?: string;
  clicksToAccept: number;
  clicksToReject: number | null; // null = no reject path found (buried/absent)
  buttonMetrics: ButtonMetric[];
}

async function metricFor(page: Page, selector: string, role: ButtonMetric['role']): Promise<ButtonMetric | null> {
  try {
    const m = await page.evaluate(
      ({ sel }) => {
        const el = document.querySelector(sel);
        if (!el) return null;
        const rect = el.getBoundingClientRect();
        const cs = getComputedStyle(el);
        return { area: rect.width * rect.height, fontSizePx: parseFloat(cs.fontSize) || 0, background: cs.backgroundColor, visible: rect.width > 0 && rect.height > 0 && cs.visibility !== 'hidden' };
      },
      { sel: selector },
    );
    return m ? { role, ...m } : null;
  } catch {
    return null;
  }
}

async function firstByText(page: Page, pattern: RegExp): Promise<string | undefined> {
  // Return a selector-ish handle by tagging the matching element.
  try {
    const found = await page.evaluate(
      ({ src }) => {
        const re = new RegExp(src, 'i');
        const controls = Array.from(document.querySelectorAll('button, a[role="button"], a, input[type="button"], [role="button"]'));
        for (const el of controls) {
          const text = (el.textContent ?? '').trim();
          if (text && re.test(text)) {
            el.setAttribute('data-complykit-consent', String(Math.random()).slice(2));
            return `[data-complykit-consent="${el.getAttribute('data-complykit-consent')}"]`;
          }
        }
        return null;
      },
      { src: pattern.source },
    );
    return found ?? undefined;
  } catch {
    return undefined;
  }
}

export async function detectCmp(page: Page): Promise<CmpDetection> {
  const buttonMetrics: ButtonMetric[] = [];

  // 1. Known vendors.
  for (const v of CMP_VENDORS) {
    const bannerVisible = await page.evaluate((sel) => {
      const el = document.querySelector(sel);
      if (!el) return false;
      const rect = el.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    }, v.banner).catch(() => false);
    if (!bannerVisible) continue;

    const acceptSel = (await page.$(v.accept)) ? v.accept : undefined;
    const rejectSel = v.reject && (await page.$(v.reject)) ? v.reject : undefined;
    const manageSel = v.manage && (await page.$(v.manage)) ? v.manage : undefined;
    for (const [sel, role] of [[acceptSel, 'accept'], [rejectSel, 'reject'], [manageSel, 'manage']] as const) {
      if (sel) {
        const m = await metricFor(page, sel, role);
        if (m) buttonMetrics.push(m);
      }
    }
    return {
      vendor: v.name,
      bannerFound: true,
      acceptSelector: acceptSel,
      rejectSelector: rejectSel,
      manageSelector: manageSel,
      clicksToAccept: acceptSel ? 1 : 0,
      clicksToReject: rejectSel ? 1 : manageSel ? 2 : null,
      buttonMetrics,
    };
  }

  // 2. Heuristic: text-matched buttons.
  const acceptSel = await firstByText(page, ACCEPT_TEXT);
  const rejectSel = await firstByText(page, REJECT_TEXT);
  const manageSel = rejectSel ? undefined : await firstByText(page, MANAGE_TEXT);
  const bannerFound = Boolean(acceptSel);
  for (const [sel, role] of [[acceptSel, 'accept'], [rejectSel, 'reject'], [manageSel, 'manage']] as const) {
    if (sel) {
      const m = await metricFor(page, sel, role);
      if (m) buttonMetrics.push(m);
    }
  }
  return {
    vendor: bannerFound ? 'heuristic' : null,
    bannerFound,
    acceptSelector: acceptSel,
    rejectSelector: rejectSel,
    manageSelector: manageSel,
    clicksToAccept: acceptSel ? 1 : 0,
    clicksToReject: rejectSel ? 1 : manageSel ? 2 : null,
    buttonMetrics,
  };
}

type Phase = 'pre-consent' | 'post-reject' | 'post-accept';

async function capturePhase(
  context: BrowserContext,
  url: string,
  subject: Subject,
  phase: Phase,
  capturedAt: string,
  action?: (page: Page) => Promise<void>,
): Promise<Artifact[]> {
  const page = await context.newPage();
  page.setDefaultTimeout(20000);
  const capture = await startCapture(page);
  await page.goto(url, { waitUntil: 'commit', timeout: 20000 });
  await settle(page);
  if (action) {
    await action(page);
    await settle(page);
  }
  const { cookies, storage } = await capture.stop();
  const phaseSubject = { ...subject, state: phase };
  return [
    { kind: 'cookie-capture', subject: phaseSubject, capturedAt, phase, cookies: cookies as unknown as Record<string, unknown>[], storage: storage as unknown as Record<string, unknown>[] },
    { kind: 'network-log', subject: phaseSubject, capturedAt, phase, requests: capture.requests as unknown as Record<string, unknown>[] },
  ];
}

export interface ConsentEvidence {
  artifacts: Artifact[];
  gaps: CoverageGap[];
  cmp: CmpDetection | null;
}

/** Three-way consent evidence for one property (entry URL). */
export async function captureConsent(
  browser: Browser,
  url: string,
  subject: Subject,
  viewport: ViewportSize,
  capturedAt: string,
): Promise<ConsentEvidence> {
  const artifacts: Artifact[] = [];
  const gaps: CoverageGap[] = [];
  let cmp: CmpDetection | null = null;

  // Pre-consent baseline — nothing clicked.
  try {
    const ctx = await openEvidenceContext(browser, viewport);
    try {
      const page = await ctx.newPage();
      const capture = await startCapture(page);
      await page.goto(url, { waitUntil: 'commit', timeout: 20000 });
      await settle(page);
      cmp = await detectCmp(page);
      const { cookies, storage } = await capture.stop();
      const pre = { ...subject, state: 'pre-consent' as const };
      artifacts.push(
        { kind: 'cookie-capture', subject: pre, capturedAt, phase: 'pre-consent', cookies: cookies as unknown as Record<string, unknown>[], storage: storage as unknown as Record<string, unknown>[] },
        { kind: 'network-log', subject: pre, capturedAt, phase: 'pre-consent', requests: capture.requests as unknown as Record<string, unknown>[] },
      );
    } finally {
      await ctx.close();
    }
  } catch (err) {
    gaps.push({ reason: 'crash', subject, note: `pre-consent capture: ${err instanceof Error ? err.message.slice(0, 80) : 'error'}` });
  }

  // Reject path (fresh context).
  if (cmp?.rejectSelector || cmp?.manageSelector) {
    try {
      const ctx = await openEvidenceContext(browser, viewport);
      try {
        const arts = await capturePhase(ctx, url, subject, 'post-reject', capturedAt, async (page) => {
          if (cmp!.manageSelector && !cmp!.rejectSelector) await page.click(cmp!.manageSelector, { timeout: 5000 }).catch(() => {});
          const rej = await detectCmp(page);
          if (rej.rejectSelector) await page.click(rej.rejectSelector, { timeout: 5000 }).catch(() => {});
        });
        artifacts.push(...arts);
      } finally {
        await ctx.close();
      }
    } catch {
      gaps.push({ reason: 'crash', subject, note: 'post-reject capture failed' });
    }
  }

  // Accept path (fresh context).
  if (cmp?.acceptSelector) {
    try {
      const ctx = await openEvidenceContext(browser, viewport);
      try {
        const arts = await capturePhase(ctx, url, subject, 'post-accept', capturedAt, async (page) => {
          await page.click(cmp!.acceptSelector!, { timeout: 5000 }).catch(() => {});
        });
        artifacts.push(...arts);
      } finally {
        await ctx.close();
      }
    } catch {
      gaps.push({ reason: 'crash', subject, note: 'post-accept capture failed' });
    }
  }

  // The consent-flow artifact carries the dark-pattern metrics.
  artifacts.push({
    kind: 'consent-flow',
    subject,
    capturedAt,
    cmp: cmp?.vendor ?? undefined,
    clicksToAccept: cmp?.clicksToAccept ?? 0,
    clicksToReject: cmp?.clicksToReject ?? null,
    buttonMetrics: (cmp?.buttonMetrics ?? []) as unknown as Record<string, unknown>[],
  });

  return { artifacts, gaps, cmp };
}
