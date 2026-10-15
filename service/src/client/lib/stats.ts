import type { ConsentStatsConfig } from '../../shared/api';

// Banner stats: counter keys in, a few plain numbers out (plans/hosted-script.md "Counters").

const ACTIONS = ['accept', 'reject', 'custom'] as const;
export type StatsAction = (typeof ACTIONS)[number];
/** Time-to-decide buckets in order, with how they read. */
export const TTD_BUCKETS: Array<[string, string]> = [
  ['lt2s', 'under 2 s'],
  ['2-5s', '2–5 s'],
  ['5-10s', '5–10 s'],
  ['10-30s', '10–30 s'],
  ['30-60s', '30–60 s'],
  ['1-5m', '1–5 min'],
  ['gt5m', 'over 5 min'],
];

export interface StatsSummary {
  loads: number;
  shown: number;
  /** All decisions, any way they were made. */
  decisions: number;
  /** Each action's whole-number share of the decisions (0 when there are none). */
  percent: Record<StatsAction, number>;
  /** The time-to-decide bucket most visitors fell in, as a label; undefined without timed decisions. */
  commonTtd?: string;
  /** Up to five regions by page loads; `XX` is shown as "Unknown". */
  regions: Array<{ region: string; label: string; loads: number }>;
}

const sum = (totals: Record<string, number>, prefix: string): number => Object.entries(totals).reduce((a, [k, v]) => (k.startsWith(prefix) ? a + v : a), 0);

export function summarizeStats(config: ConsentStatsConfig): StatsSummary {
  const t = config.totals;
  const byAction = Object.fromEntries(ACTIONS.map((a) => [a, sum(t, `decide:${a}:`)])) as Record<StatsAction, number>;
  const decisions = ACTIONS.reduce((a, k) => a + byAction[k], 0);
  const percent = Object.fromEntries(ACTIONS.map((a) => [a, decisions ? Math.round((byAction[a] / decisions) * 100) : 0])) as Record<StatsAction, number>;

  let commonTtd: string | undefined;
  let best = 0;
  for (const [bucket, label] of TTD_BUCKETS) {
    const n = ACTIONS.reduce((a, act) => a + (t[`ttd:${act}:${bucket}`] ?? 0), 0);
    if (n > best) {
      best = n;
      commonTtd = label;
    }
  }

  const regions = Object.entries(t)
    .flatMap(([k, v]) => {
      const m = /^geo:([A-Z0-9-]+):load$/.exec(k);
      return m ? [{ region: m[1], label: m[1] === 'XX' ? 'Unknown' : m[1], loads: v }] : [];
    })
    .sort((a, b) => b.loads - a.loads || a.region.localeCompare(b.region))
    .slice(0, 5);

  return { loads: t.load ?? 0, shown: t.shown ?? 0, decisions, percent, commonTtd, regions };
}

/** A version with any visitor activity at all. */
export const hasActivity = (s: StatsSummary): boolean => s.loads > 0 || s.shown > 0 || s.decisions > 0;
