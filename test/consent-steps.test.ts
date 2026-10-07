import { describe, it, expect } from 'vitest';
import { StepTimer, step, topSteps, formatSeconds } from '../src/collect/browser/evaluation/steps.js';
import { TimelineSnapshot } from '../src/record/tracking.js';

// A fake clock: each step advances it explicitly, so the numbers are exact.
function clock(): { now: () => number; advance: (ms: number) => Promise<void> } {
  let t = 0;
  return { now: () => t, advance: async (ms) => void (t += ms) };
}

describe('visit step timing', () => {
  it('keys nested steps by path and aggregates repeats (count, total, max)', async () => {
    const c = clock();
    const lines: string[] = [];
    const timer = new StepTimer({ now: c.now, trace: (l) => lines.push(l) });
    await timer.run(async () => {
      await step('land', async () => {
        await step('navigate', () => c.advance(4000), '/');
        await step('dwell', () => c.advance(10000));
      }, '/');
      await step('browse', async () => {
        for (const [i, ms] of [12000, 30000, 8000].entries()) {
          await step('page', () => step('navigate', () => c.advance(ms)), `${i + 1} /p${i + 1}`);
        }
      });
      await step('flush', () => c.advance(3000));
    });
    const s = timer.summary();
    expect(s[0]).toEqual({ step: 'browse', count: 1, ms: 50000, maxMs: 50000 });
    expect(s.find((x) => x.step === 'browse.page')).toEqual({ step: 'browse.page', count: 3, ms: 50000, maxMs: 30000 });
    expect(s.find((x) => x.step === 'browse.page.navigate')?.count).toBe(3);
    expect(s.find((x) => x.step === 'land.navigate')?.ms).toBe(4000);
    expect(topSteps(s)).toBe('browse 50s, land 14s, flush 3.0s');
    expect(lines).toContain('step browse.page 2 /p2 30s');
    expect(lines).toContain('step land / 14s');
    // Every row fits the snapshot schema.
    expect(TimelineSnapshot.shape.steps.parse(s)).toEqual(s);
  });

  it('reports a step still running (the scenario hit its budget) as open, with its time so far', async () => {
    const c = clock();
    const timer = new StepTimer({ now: c.now });
    let release!: () => void;
    const hang = new Promise<void>((r) => (release = r));
    const body = timer.run(() => step('browse', () => step('page', () => hang)));
    await c.advance(180000);
    await Promise.resolve();
    const s = timer.summary();
    expect(s.find((x) => x.step === 'browse')).toEqual({ step: 'browse', count: 1, ms: 180000, maxMs: 180000, open: true });
    expect(topSteps(s)).toBe('browse 180s+');
    release();
    await body;
    expect(timer.summary().every((x) => !x.open)).toBe(true);
  });

  it('records a step that throws, and is a no-op outside a timed visit', async () => {
    const c = clock();
    const timer = new StepTimer({ now: c.now });
    await expect(timer.run(() => step('land', async () => { await c.advance(2000); throw new Error('blocked'); }))).rejects.toThrow('blocked');
    expect(timer.summary()).toEqual([{ step: 'land', count: 1, ms: 2000, maxMs: 2000 }]);
    expect(await step('x', async () => 7)).toBe(7);
    expect(formatSeconds(262400)).toBe('262s');
    expect(formatSeconds(1450)).toBe('1.4s');
  });
});
