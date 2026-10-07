/**
 * Which probe tiles are resident: the ones nearest the camera, as many as
 * the probe memory budget holds. A world of any size streams its probes the
 * way it streams its scenes — the tiles around the camera are loaded and on
 * the GPU, the far ones are not and their surfaces get the flat ambient
 * light (fading over one probe spacing past the last resident tile). Never
 * by scene or record order: a later scene's tiles are as near as they are.
 *
 * Resident tiles count a little nearer than they are (`hysteresis`), so a
 * camera standing at the edge of the resident set does not load and drop the
 * same tiles over and over.
 */

/** GPU memory the resident probe tiles may take (bytes): the packed texture, as placed (each tile's column width and the deepest tile's depth). */
export const PROBE_RESIDENT_BYTES = 128 * 1024 * 1024;
/**
 * How far past the budget the texture may grow: tiles placed in columns as
 * wide as the widest tile leave gaps, and growing doubles; the pick counts
 * each tile at its column's width, so this is room for the gaps.
 */
export const PROBE_ATLAS_SLACK = 1.25;

export interface ProbeResidencyTile {
  readonly key: string;
  readonly min: readonly number[];
  readonly max: readonly number[];
  /** What the tile takes in the packed texture (bytes). */
  readonly bytes: number;
}

export interface ProbeResidency {
  /** The tiles to hold (keys). */
  readonly wanted: Set<string>;
  /** Tiles left out because the budget is full (the farthest). */
  readonly beyond: number;
}

/** Distance from a point to a box (0 inside). */
function boxDistance(t: ProbeResidencyTile, p: readonly number[]): number {
  let s = 0;
  for (let a = 0; a < 3; a++) {
    const d = Math.max(t.min[a]! - p[a]!, 0, p[a]! - t.max[a]!);
    s += d * d;
  }
  return Math.sqrt(s);
}

/**
 * The nearest tiles to `camera` whose bytes add up to at most `budget`
 * (`tiles` in table order: equal distances keep it). Stops at the first
 * tile that does not fit, so every resident tile is nearer than every left
 * out one (`hysteresis` aside).
 */
export function pickResidentProbeTiles(tiles: readonly ProbeResidencyTile[], camera: readonly number[], budget: number, resident: ReadonlySet<string>, hysteresis: number): ProbeResidency {
  let total = 0;
  for (const t of tiles) total += t.bytes;
  if (total <= budget) return { wanted: new Set(tiles.map((t) => t.key)), beyond: 0 };
  const order = tiles.map((t, i) => ({ t, i, d: boxDistance(t, camera) - (resident.has(t.key) ? hysteresis : 0) }));
  order.sort((a, b) => a.d - b.d || a.i - b.i);
  const wanted = new Set<string>();
  let used = 0;
  for (const { t } of order) {
    if (used + t.bytes > budget) break;
    used += t.bytes;
    wanted.add(t.key);
  }
  return { wanted, beyond: tiles.length - wanted.size };
}
