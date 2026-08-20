import type { Box } from '../record/index.js';
import type { Tile } from './tiler.js';

// Mode-2 Set-of-Marks sweep (vision-analysis-design). The tiler delivers legible
// tiles; the SoM sidecar solves localization — the model cites numbered marks,
// we resolve mark № → fingerprint. Sweep output is LEADS, each confirmed by a
// mode-1 crop adjudication before it becomes a finding (a precision gate, so
// discovery can be noisy). The model call is injected (`sweeper`) — this module
// never touches the SDK.

export interface MarkElement {
  fingerprint: string;
  role: string;
  name?: string;
  bbox: Box; // page-absolute
}

export interface TileSidecar {
  tileIndex: number;
  marks: Array<{ mark: number } & MarkElement>;
}

/** Build the per-tile sidecar: which page elements fall inside each tile, with a
 *  stable mark number, so the model can cite marks instead of coordinates. */
export function buildSidecars(tiles: Tile[], elements: MarkElement[]): TileSidecar[] {
  return tiles.map((tile) => {
    const marks: Array<{ mark: number } & MarkElement> = [];
    let mark = 1;
    for (const el of elements) {
      const cx = el.bbox.x + el.bbox.width / 2;
      const cy = el.bbox.y + el.bbox.height / 2;
      if (cx >= tile.x && cx < tile.x + tile.width && cy >= tile.y && cy < tile.y + tile.height) {
        marks.push({ mark: mark++, ...el });
      }
    }
    return { tileIndex: tile.index, marks };
  });
}

export interface SweepLead {
  fingerprint: string;
  mark: number;
  tileIndex: number;
  suspicion: string;
  pass: string;
}

/** One themed pass over a tile: the model returns leads citing mark numbers. */
export type Sweeper = (input: {
  tile: Tile;
  sidecar: TileSidecar;
  pass: string;
}) => Promise<Array<{ mark: number; suspicion: string }>>;

// The two themed passes (never a rule-dump): perception, then affordance/order.
export const SWEEP_PASSES = ['perception', 'affordance-order'] as const;

/**
 * Run the themed passes over every tile and resolve mark numbers back to
 * fingerprints. Leads are the output — the caller funnels each into a mode-1
 * adjudication for confirmation. Deduped by (fingerprint, pass).
 */
export async function sweep(
  tiles: Tile[],
  sidecars: TileSidecar[],
  sweeper: Sweeper,
  passes: readonly string[] = SWEEP_PASSES,
): Promise<SweepLead[]> {
  const byTile = new Map(sidecars.map((s) => [s.tileIndex, s]));
  const leads: SweepLead[] = [];
  const seen = new Set<string>();
  for (const tile of tiles) {
    const sidecar = byTile.get(tile.index);
    if (!sidecar || sidecar.marks.length === 0) continue;
    for (const pass of passes) {
      const raw = await sweeper({ tile, sidecar, pass });
      for (const r of raw) {
        const el = sidecar.marks.find((m) => m.mark === r.mark);
        if (!el) continue; // model cited a mark that isn't in this tile — drop it
        const key = `${el.fingerprint}:${pass}`;
        if (seen.has(key)) continue;
        seen.add(key);
        leads.push({ fingerprint: el.fingerprint, mark: r.mark, tileIndex: tile.index, suspicion: r.suspicion, pass });
      }
    }
  }
  return leads;
}
