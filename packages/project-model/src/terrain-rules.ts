/**
 * Baking a terrain's material rules (`surface-rules.ts`) into its tiles'
 * baked weights — the map the renderer mixes the hand paint over.
 *
 * Each sample is a surface point: its world position, its slope from the
 * heights around it (central differences, one-sided where the grid ends)
 * and, when a rule reads it, its cavity (the mean of the four samples the
 * rule's radius away, less its own height; those past the terrain's edge
 * are left out). What a sample reads depends only on the terrain's samples,
 * never on which tile asks, so an edge sample two tiles share is baked to
 * the same bytes in both.
 *
 * A bake covers a rectangle of samples: an edit re-bakes only the samples
 * whose surroundings it changed (`terrainBakeRect`), which gives the same
 * bytes as baking everything again.
 *
 * Pure and deterministic.
 */
import type { TerrainSamples } from './terrain-edit';
import { TERRAIN_SAMPLE_LAYERS, TERRAIN_WEIGHT_BYTES, type TerrainTile } from './terrain-tile';
import { SurfaceRuleSet, type SurfacePoint } from './surface-rules';

/** A rectangle of global sample indices [x0, z0, x1, z1], inclusive. */
export type TerrainSampleRect = [number, number, number, number];

/** Samples beyond a changed one whose bake may read it: the rules' farthest reach, and one for the slope. */
export function terrainBakeMargin(set: SurfaceRuleSet, spacing: number): number {
  return Math.ceil(set.reach / spacing) + 1;
}

/**
 * The samples whose heights differ between `before` and `after` (tiles by
 * "x,z"; a tile only in `after` changed everywhere), grown by `margin`:
 * what an edit must bake again. Null: no height changed.
 */
export function terrainBakeRect(before: ReadonlyMap<string, TerrainTile>, after: ReadonlyMap<string, TerrainTile>, cells: number, margin: number): TerrainSampleRect | null {
  let r: TerrainSampleRect | null = null;
  const grow = (x: number, z: number): void => {
    r = r === null ? [x, z, x, z] : [Math.min(r[0], x), Math.min(r[1], z), Math.max(r[2], x), Math.max(r[3], z)];
  };
  const s = cells + 1;
  for (const [key, t] of after) {
    const [tx, tz] = key.split(',').map(Number) as [number, number];
    const old = before.get(key);
    if (old === undefined) {
      grow(tx * cells, tz * cells);
      grow(tx * cells + cells, tz * cells + cells);
      continue;
    }
    if (old.heights === t.heights) continue;
    for (let j = 0; j < s; j++) {
      const row = j * s;
      for (let i = 0; i < s; i++) if (old.heights[row + i] !== t.heights[row + i]) grow(tx * cells + i, tz * cells + j);
    }
  }
  const out = r as TerrainSampleRect | null;
  return out === null ? null : [out[0] - margin, out[1] - margin, out[2] + margin, out[3] + margin];
}

/** A tile's baked weights as they are when it has none: all layer 0. */
function defaultWeights(n: number): Uint8Array {
  const w = new Uint8Array(n * TERRAIN_WEIGHT_BYTES);
  for (let i = 0; i < n; i++) w[i * TERRAIN_WEIGHT_BYTES + TERRAIN_SAMPLE_LAYERS] = 255;
  return w;
}

/**
 * Bake the rules over `rect` (null: every sample) of the terrain's tiles.
 * `origin` is the terrain object's position (world = origin + local).
 * Writes only the tiles whose bytes change. Returns the samples changed.
 */
export function bakeTerrainRules(s: TerrainSamples, set: SurfaceRuleSet, origin: readonly number[], rect: TerrainSampleRect | null): number {
  const n = s.n;
  const S = n + 1;
  const sp = s.spacing;
  const reachSamples = set.readsCavity ? Math.max(1, Math.ceil(set.reach / sp)) : 1;
  const m = reachSamples;
  const P = S + 2 * m;
  const padded = new Float64Array(P * P);
  const layers: number[] = [];
  const weights: number[] = [];
  const scratch = new Uint8Array(TERRAIN_WEIGHT_BYTES);
  let changed = 0;
  const keys = [...s.all().keys()];
  for (const key of keys) {
    const [tx, tz] = key.split(',').map(Number) as [number, number];
    const gx0 = tx * n;
    const gz0 = tz * n;
    const x0 = rect === null ? 0 : Math.max(0, rect[0] - gx0);
    const z0 = rect === null ? 0 : Math.max(0, rect[1] - gz0);
    const x1 = rect === null ? n : Math.min(n, rect[2] - gx0);
    const z1 = rect === null ? n : Math.min(n, rect[3] - gz0);
    if (x0 > x1 || z0 > z1) continue;
    const tile = s.tile(tx, tz)!;
    // Heights (metres above the object) around the tile; NaN where the terrain has no sample.
    for (let j = 0; j < P; j++) {
      for (let i = 0; i < P; i++) {
        const li = i - m;
        const lj = j - m;
        const step = li >= 0 && li <= n && lj >= 0 && lj <= n ? tile.heights[lj * S + li]! : s.step(gx0 + li, gz0 + lj);
        padded[j * P + i] = step === null ? Number.NaN : s.heightOf(step);
      }
    }
    const point = new SamplePoint(padded, P, sp);
    let written: TerrainTile | null = null;
    for (let pz = z0; pz <= z1; pz++) {
      for (let px = x0; px <= x1; px++) {
        const c = (pz + m) * P + px + m;
        const h = padded[c]!;
        const l = padded[c - 1]!;
        const r = padded[c + 1]!;
        const d = padded[c - P]!;
        const u = padded[c + P]!;
        point.c = c;
        point.h = h;
        const gx = !Number.isNaN(l) && !Number.isNaN(r) ? (r - l) / (2 * sp) : !Number.isNaN(r) ? (r - h) / sp : !Number.isNaN(l) ? (h - l) / sp : 0;
        const gz = !Number.isNaN(d) && !Number.isNaN(u) ? (u - d) / (2 * sp) : !Number.isNaN(u) ? (u - h) / sp : !Number.isNaN(d) ? (h - d) / sp : 0;
        point.x = origin[0]! + (gx0 + px) * sp;
        point.y = origin[1]! + h;
        point.z = origin[2]! + (gz0 + pz) * sp;
        point.slope = (Math.atan(Math.sqrt(gx * gx + gz * gz)) * 180) / Math.PI;
        // The layers come strongest first; past the fourth they go to the strongest (the tile's canonical form).
        const count = set.evaluate(point, layers, weights);
        scratch.fill(0);
        let extra = 0;
        for (let k = TERRAIN_SAMPLE_LAYERS; k < count; k++) extra += weights[k]!;
        for (let k = 0; k < TERRAIN_SAMPLE_LAYERS && k < count; k++) {
          scratch[k] = layers[k]!;
          scratch[TERRAIN_SAMPLE_LAYERS + k] = weights[k]! + (k === 0 ? extra : 0);
        }
        const i = pz * S + px;
        const o = i * TERRAIN_WEIGHT_BYTES;
        const cur = (written ?? tile).weights;
        let same = true;
        for (let k = 0; k < TERRAIN_WEIGHT_BYTES && same; k++) same = (cur !== null ? cur[o + k]! : k === TERRAIN_SAMPLE_LAYERS ? 255 : 0) === scratch[k];
        if (same) continue;
        if (written === null) {
          written = s.writable(tx, tz)!;
          written.weights ??= defaultWeights(S * S);
        }
        written.weights!.set(scratch, o);
        changed += 1;
      }
    }
  }
  return changed;
}

/** A sample as the rules read it: its place in the padded heights, and the cavity measured from them. */
class SamplePoint implements SurfacePoint {
  x = 0;
  y = 0;
  z = 0;
  slope = 0;
  readonly wall = false;
  /** Its index in the padded heights, and its height. */
  c = 0;
  h = 0;

  constructor(
    private readonly padded: Float64Array,
    private readonly stride: number,
    private readonly spacing: number,
  ) {}

  cavity(radius: number): number {
    const k = Math.max(1, Math.round(radius / this.spacing));
    const a = this.padded;
    let sum = 0;
    let count = 0;
    for (let q = 0; q < 4; q++) {
      const v = a[this.c + (q < 2 ? (q === 0 ? -k : k) : (q === 2 ? -k : k) * this.stride)]!;
      if (Number.isNaN(v)) continue;
      sum += v;
      count += 1;
    }
    return count === 0 ? 0 : sum / count - this.h;
  }
}
