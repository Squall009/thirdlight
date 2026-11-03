/**
 * What material the surface shader shows at a level of the chunk tree,
 * measured against level 0 at the same places: the ground of a window is
 * derived at levels 0 … N (mip nodes through the chunk derive), a vertical
 * ray from above at every sample column finds each level's surface, and
 * the material there is picked the way the surface shader picks it
 * (three-adapter voxel-surface.ts): the eight cell centres round the point
 * moved into the surface along the interpolated normal, each weighted per
 * axis by the blend ramp, air left out, the heaviest material shown. The
 * shader reads the node's grid, which holds the level's cells; here they are
 * read from the level's cells directly (the same values, no node border to
 * clamp to).
 */
import { deriveMipNode, MipTree, POSITION_STEPS_PER_CELL, SHADER_READ_DEPTH_CELLS, SURFACE_VERTEX_BYTES, VOXEL_SIZE_M, voxel, type AssemblyRuleSet, type MipLevelView, type PaletteStore } from '@thirdlight/voxel';

/** How deep into the surface the shader reads its cells (metres, at every level). */
const SHADER_DEPTH_M = SHADER_READ_DEPTH_CELLS * VOXEL_SIZE_M;

/** A window of the world in level-0 cells: x and z [x0, x1), y [y0, y1). */
export interface MaterialWindow {
  readonly x0: number;
  readonly x1: number;
  readonly z0: number;
  readonly z1: number;
  readonly y0: number;
  readonly y1: number;
}

/** A level's ground triangles in level-0 cells, with corner normals, bucketed by column. */
interface LevelGround {
  readonly level: number;
  readonly pos: Float64Array;
  readonly nrm: Float32Array;
  readonly buckets: Map<number, number[]>;
}

const BUCKET = 4;
const bucketKey = (bx: number, bz: number): number => (bx + 32768) * 65536 + (bz + 32768);

function levelGround(tree: MipTree, level: number, rules: AssemblyRuleSet, w: MaterialWindow): LevelGround {
  const e = tree.grid.edge;
  const span = e << level;
  const scale = 1 << level;
  const steps = POSITION_STEPS_PER_CELL;
  const pos: number[] = [];
  const nrm: number[] = [];
  const range = (lo: number, hi: number): [number, number] => [Math.floor(lo / span) - 1, Math.floor((hi - 1) / span)];
  const [x0, x1] = range(w.x0, w.x1);
  const [y0, y1] = range(w.y0, w.y1);
  const [z0, z1] = range(w.z0, w.z1);
  for (let nx = x0; nx <= x1; nx++) for (let ny = y0; ny <= y1; ny++) for (let nz = z0; nz <= z1; nz++) {
    const buf = deriveMipNode(tree, { level, nx, ny, nz }, rules).ground;
    const view = new DataView(buf.vertices.buffer, buf.vertices.byteOffset, buf.vertices.byteLength);
    for (const i of buf.indices) {
      const o = i * SURFACE_VERTEX_BYTES;
      pos.push((((nx * e - 1) * steps + view.getUint16(o, true)) * scale) / steps, (((ny * e - 1) * steps + view.getUint16(o + 2, true)) * scale) / steps, (((nz * e - 1) * steps + view.getUint16(o + 4, true)) * scale) / steps);
      const a = view.getInt8(o + 8), b = view.getInt8(o + 9), c = view.getInt8(o + 10);
      const len = Math.hypot(a, b, c) || 1;
      nrm.push(a / len, b / len, c / len);
    }
  }
  const buckets = new Map<number, number[]>();
  for (let t = 0; t < pos.length / 9; t++) {
    const xs = [pos[9 * t]!, pos[9 * t + 3]!, pos[9 * t + 6]!];
    const zs = [pos[9 * t + 2]!, pos[9 * t + 5]!, pos[9 * t + 8]!];
    for (let bx = Math.floor(Math.min(...xs) / BUCKET); bx <= Math.floor(Math.max(...xs) / BUCKET); bx++)
      for (let bz = Math.floor(Math.min(...zs) / BUCKET); bz <= Math.floor(Math.max(...zs) / BUCKET); bz++) {
        const k = bucketKey(bx, bz);
        let l = buckets.get(k);
        if (l === undefined) buckets.set(k, (l = []));
        l.push(t);
      }
  }
  return { level, pos: Float64Array.from(pos), nrm: Float32Array.from(nrm), buckets };
}

/** The highest hit of a vertical ray at (x, z) on a level's ground: point (level-0 cells) and interpolated unit normal. */
function hitDown(g: LevelGround, x: number, z: number): { p: [number, number, number]; n: [number, number, number] } | null {
  const list = g.buckets.get(bucketKey(Math.floor(x / BUCKET), Math.floor(z / BUCKET)));
  if (list === undefined) return null;
  const P = g.pos;
  let best = -Infinity;
  let out: { p: [number, number, number]; n: [number, number, number] } | null = null;
  for (const t of list) {
    const o = 9 * t;
    const ax = P[o]!, az = P[o + 2]!, bx = P[o + 3]!, bz = P[o + 5]!, cx = P[o + 6]!, cz = P[o + 8]!;
    const det = (bz - cz) * (ax - cx) + (cx - bx) * (az - cz);
    if (Math.abs(det) < 1e-12) continue;
    const u = ((bz - cz) * (x - cx) + (cx - bx) * (z - cz)) / det;
    const v = ((cz - az) * (x - cx) + (ax - cx) * (z - cz)) / det;
    const s = 1 - u - v;
    if (u < 0 || v < 0 || s < 0) continue;
    const y = u * P[o + 1]! + v * P[o + 4]! + s * P[o + 7]!;
    if (y <= best) continue;
    best = y;
    const N = g.nrm;
    const nx = u * N[o]! + v * N[o + 3]! + s * N[o + 6]!;
    const ny = u * N[o + 1]! + v * N[o + 4]! + s * N[o + 7]!;
    const nz = u * N[o + 2]! + v * N[o + 5]! + s * N[o + 8]!;
    const len = Math.hypot(nx, ny, nz) || 1;
    out = { p: [x, y, z], n: [nx / len, ny / len, nz / len] };
  }
  return out;
}

/**
 * The material the surface shader shows at point `p` (level-0 cells) with
 * unit normal `n` on a level's ground: its cells read `depthM` metres into
 * the surface (default the shader's; `'quarter-cell'` a quarter of the
 * level's cell, how the shader read before), blended over `blendM` metres
 * (0 when every cell round it is air).
 */
export function shaderMaterialAt(view: MipLevelView, p: readonly number[], n: readonly number[], blendM: number, depthM: number | 'quarter-cell' = SHADER_DEPTH_M): number {
  const cellM = VOXEL_SIZE_M * 2 ** view.level;
  const scale = 2 ** view.level;
  const depth = depthM === 'quarter-cell' ? 0.25 : depthM / cellM;
  const blendCells = Math.min(1, Math.max(1e-3, blendM / cellM));
  const v = voxel();
  const t: number[] = [];
  const c0: number[] = [];
  const w1: number[] = [];
  for (let a = 0; a < 3; a++) {
    t[a] = p[a]! / scale - n[a]! * depth - 0.5;
    c0[a] = Math.floor(t[a]!);
    w1[a] = Math.min(1, Math.max(0, (t[a]! - c0[a]! - 0.5) / blendCells + 0.5));
  }
  const weight = new Map<number, number>();
  for (let k = 0; k < 8; k++) {
    const d = [k & 1, (k >> 1) & 1, (k >> 2) & 1];
    const m = view.voxelAt(c0[0]! + d[0]!, c0[1]! + d[1]!, c0[2]! + d[2]!, v).material;
    if (m === 0) continue;
    let w = 1;
    for (let a = 0; a < 3; a++) w *= d[a] ? w1[a]! : 1 - w1[a]!;
    weight.set(m, (weight.get(m) ?? 0) + w);
  }
  let best = 0;
  let bw = 0;
  for (const [m, w] of weight) if (w > bw) [best, bw] = [m, w];
  return best;
}

export interface LevelMaterialResult {
  readonly level: number;
  /** Columns where both level 0 and this level have ground. */
  readonly samples: number;
  /** Columns whose shown material differs from level 0's there. */
  readonly mismatches: number;
  readonly share: number;
  /** Mismatches by "level-0 material → this level's material". */
  readonly pairs: Readonly<Record<string, number>>;
}

/** Every level's ground over a window, derived once and measured with {@link levelMaterialMismatch}. */
export interface LevelSurfaces {
  readonly window: MaterialWindow;
  readonly grounds: readonly LevelGround[];
  readonly views: readonly MipLevelView[];
}

/** Derives the ground of levels 0 … `levels` over `w` (nodes reaching one past each side). */
export function levelSurfaces(store: PaletteStore, rules: AssemblyRuleSet, w: MaterialWindow, levels: number): LevelSurfaces {
  const tree = new MipTree(store);
  const grounds = Array.from({ length: levels + 1 }, (_, l) => levelGround(tree, l, rules, w));
  return { window: w, grounds, views: grounds.map((g) => tree.level(g.level)) };
}

/**
 * Per level above 0: the share of sample columns (every `step` cells,
 * inside the window less `margin` cells) where the material shown differs
 * from level 0's.
 */
export function levelMaterialMismatch(s: LevelSurfaces, opts: { margin: number; step?: number; blendM: number; depthM?: number | 'quarter-cell' }): LevelMaterialResult[] {
  const w = s.window;
  const { grounds, views } = s;
  const step = opts.step ?? 1;
  const out: LevelMaterialResult[] = [];
  const base: Array<number | null> = [];
  for (let x = w.x0 + opts.margin; x < w.x1 - opts.margin; x += step) for (let z = w.z0 + opts.margin; z < w.z1 - opts.margin; z += step) {
    const h = hitDown(grounds[0]!, x + 0.37, z + 0.61);
    base.push(h === null ? null : shaderMaterialAt(views[0]!, h.p, h.n, opts.blendM, opts.depthM));
  }
  for (let l = 1; l < grounds.length; l++) {
    let samples = 0;
    let mismatches = 0;
    const pairs: Record<string, number> = {};
    let i = 0;
    for (let x = w.x0 + opts.margin; x < w.x1 - opts.margin; x += step) for (let z = w.z0 + opts.margin; z < w.z1 - opts.margin; z += step, i++) {
      const m0 = base[i];
      if (m0 === null || m0 === undefined) continue;
      const h = hitDown(grounds[l]!, x + 0.37, z + 0.61);
      if (h === null) continue;
      samples++;
      const m = shaderMaterialAt(views[l]!, h.p, h.n, opts.blendM, opts.depthM);
      if (m !== m0) {
        mismatches++;
        const key = `${m0}→${m}`;
        pairs[key] = (pairs[key] ?? 0) + 1;
      }
    }
    out.push({ level: l, samples, mismatches, share: samples === 0 ? 0 : mismatches / samples, pairs });
  }
  return out;
}
