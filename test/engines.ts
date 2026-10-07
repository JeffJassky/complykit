import fs from 'node:fs';
import type { Browser } from 'playwright';

// F5: the checks on our own banner run in Chromium, Firefox and WebKit. Each
// engine's suite skips when that browser is not installed (visible in the test
// output) — except the engines named in COMPLYKIT_ENGINES (CI sets
// "chromium,firefox,webkit"): those are required, so a missing install fails
// instead of quietly skipping.

export const ENGINE_NAMES = ['chromium', 'firefox', 'webkit'] as const;
export type EngineName = (typeof ENGINE_NAMES)[number];

const required = new Set((process.env.COMPLYKIT_ENGINES ?? '').split(',').map((s) => s.trim()).filter(Boolean));

/** Per engine: run its suite? (installed, or required by COMPLYKIT_ENGINES). */
export async function engineAvailability(): Promise<Record<EngineName, boolean>> {
  const out = { chromium: false, firefox: false, webkit: false };
  try {
    const pw = await import('playwright');
    for (const name of ENGINE_NAMES) out[name] = required.has(name) || fs.existsSync(pw[name].executablePath());
  } catch {
    for (const name of ENGINE_NAMES) out[name] = required.has(name);
  }
  return out;
}

export async function launchEngine(name: EngineName): Promise<Browser> {
  const pw = await import('playwright');
  return pw[name].launch();
}
