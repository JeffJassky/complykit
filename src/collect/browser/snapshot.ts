import type { Page } from 'playwright';
import type { Artifact, Subject, CoverageGap } from '../../record/index.js';

// CDP DOMSnapshot: the whole rendered tree + chosen computed styles + layout
// rects in ONE call (the perf backbone). Also where we detect the two structural
// coverage gaps — cross-origin iframes (DOM uninspectable) and closed shadow
// roots — and run the closed-shadow pierce SPIKE (browser-analysis-design #8:
// CDP snapshot has debugger-level access, so it may pierce closed shadow the JS
// API cannot). The spike result is recorded in plans/, not assumed.

export interface SnapshotResult {
  artifact: Artifact;
  gaps: CoverageGap[];
  spike: { closedShadowHosts: number; snapshotDocuments: number; piercedClosedShadow: boolean };
}

export async function captureSnapshot(page: Page, subject: Subject, capturedAt: string): Promise<SnapshotResult> {
  const gaps: CoverageGap[] = [];

  // Cross-origin iframes: screenshot yes, DOM no. Recorded as an explicit gap.
  for (const frame of page.frames()) {
    if (frame === page.mainFrame()) continue;
    try {
      const frameUrl = frame.url();
      if (frameUrl && new URL(frameUrl).origin !== new URL(page.url()).origin) {
        gaps.push({ reason: 'cross-origin-iframe', subject, note: new URL(frameUrl).origin });
      }
    } catch {
      /* about:blank etc. */
    }
  }

  // Count closed shadow hosts we can see via the JS API's failure to pierce:
  // an element with a shadow but null shadowRoot is a closed root.
  const closedShadowHosts = (await page.evaluate(() => {
    let count = 0;
    const all = Array.from(document.querySelectorAll('*'));
    for (const el of all) {
      // A custom element with no open shadowRoot but a shadow-ish name is a weak
      // signal; the reliable tell is attachShadow({mode:'closed'}) which leaves
      // shadowRoot null. We can only count elements that *look* like hosts.
      const anyEl = el as unknown as { shadowRoot: ShadowRoot | null };
      if (anyEl.shadowRoot === null && el.tagName.includes('-')) count++;
    }
    return count;
  })) as number;

  let snapshotDocuments = 0;
  let piercedClosedShadow = false;
  try {
    const cdp = await page.context().newCDPSession(page);
    const snap = (await cdp.send('DOMSnapshot.captureSnapshot', { computedStyles: ['color', 'background-color'] })) as {
      documents?: unknown[];
    };
    snapshotDocuments = snap.documents?.length ?? 0;
    // If the CDP snapshot yields more documents than the JS-visible frame count,
    // it reached into shadow/iframe trees the API could not — evidence of pierce.
    piercedClosedShadow = closedShadowHosts > 0 && snapshotDocuments > page.frames().length;
    await cdp.detach();
  } catch {
    // CDP unavailable (non-Chromium) — snapshot skipped, no gap (axe still ran).
  }

  if (closedShadowHosts > 0 && !piercedClosedShadow) {
    gaps.push({ reason: 'closed-shadow-root', subject, note: `${closedShadowHosts} closed shadow host(s)` });
  }

  const artifact: Artifact = {
    kind: 'dom-snapshot',
    subject,
    capturedAt,
    nodes: [{ closedShadowHosts, snapshotDocuments }],
  };
  return { artifact, gaps, spike: { closedShadowHosts, snapshotDocuments, piercedClosedShadow } };
}
