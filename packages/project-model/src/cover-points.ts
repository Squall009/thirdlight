/**
 * Ground cover on surfaces the GPU cannot read for itself (a block layer's
 * tops, its floors under ceilings): a cover rule's point set over one chunk,
 * baked when the chunk changes and thinned by distance on the GPU.
 *
 * The bake lays the rule's candidate grid over the chunk at the rule's full
 * density (the stored scatter's grid and hashes: on a surface with one
 * ground a point stands where the stored bake would put a copy), and keeps a
 * candidate on every floor of its column whose ground meets the rule's
 * conditions, its `spacing` held between points of any floor. Each point
 * keeps what the vertex stage cannot work out again: where it stands, the
 * ground's normal, its turn and size, and its threshold — the share of
 * copies kept below which it is drawn (a hash of its candidate cell, so an
 * edit keeps every other point's threshold and nothing pops).
 *
 * A point is {@link COVER_POINT_FLOATS} floats, each a whole number below
 * 2^24 or a height, so the array is the GPU's texture as it is (no
 * conversion on the page):
 * - its place across the chunk, 12 bits a side ({@link COVER_POINT_STEPS}
 *   steps of the chunk's width and depth);
 * - its height in the source's frame (m);
 * - its threshold, turn and size, a byte each (shares of 256);
 * - its normal, octahedral, a byte a component.
 *
 * Points are sorted by threshold, so a draw that keeps at most a share of
 * them reads a prefix ({@link coverPointsBelow}).
 *
 * Pure.
 */
import { brushHash, copyRotation, type Quat } from './instance-brush';
import { SCATTER_MIN_NORMAL_Y, scatterRuleSeed, type ScatterRect, type ScatterRule, type ScatterSurface } from './scatter';
import { ruleConditionsAt, ruleRangeAt } from './surface-rules';

/** Floats a point takes. */
export const COVER_POINT_FLOATS = 4;
/** Steps a point's place takes across a chunk's side (12 bits). */
export const COVER_POINT_STEPS = 4096;
/** Hash lanes a lower floor's candidate adds per floor (the top floor reads the stored scatter's own lanes). */
const FLOOR_LANES = 16;
/** Hash lanes of a candidate: jitter x and z, scale, turn, kept by the conditions, priority (as the stored scatter's), threshold. */
const LANE = Object.freeze({ jx: 0, jz: 1, scale: 2, yaw: 3, keep: 4, priority: 5, threshold: 6 });

/** A rule's points over one chunk. */
export interface CoverPointSet {
  /** The chunk's corner in the source's frame (m) and its width and depth. */
  readonly x0: number;
  readonly z0: number;
  readonly w: number;
  readonly d: number;
  /** The lowest and highest point (the source's frame, m; 0 when empty). */
  readonly low: number;
  readonly high: number;
  readonly count: number;
  /** {@link COVER_POINT_FLOATS} floats a point, sorted by threshold. */
  readonly data: Float32Array;
}

/** One point read back (the CPU reference of the vertex stage's decoding). */
export interface CoverPoint {
  /** Its place in the source's frame (m), the ground's height less nothing (the rule's sink is the draw's). */
  x: number;
  y: number;
  z: number;
  normal: [number, number, number];
  /** Drawn while the share kept is above this. */
  threshold: number;
  /** Its turn about up (a share of the rule's `yaw`) and size (a share of its scale range). */
  yaw: number;
  scale: number;
}

/** A byte share's value: the middle of its step. */
const share = (b: number): number => (b + 0.5) / 256;
const byte = (v: number): number => Math.min(255, Math.max(0, Math.floor(v * 256)));

/** Octahedral bytes of a unit normal. */
function octOf(nx: number, ny: number, nz: number): [number, number] {
  const s = Math.abs(nx) + Math.abs(ny) + Math.abs(nz) || 1;
  let u = nx / s;
  let v = nz / s;
  if (ny < 0) [u, v] = [(1 - Math.abs(v)) * Math.sign(u || 1), (1 - Math.abs(u)) * Math.sign(v || 1)];
  return [Math.round((u * 0.5 + 0.5) * 255), Math.round((v * 0.5 + 0.5) * 255)];
}

/** The unit normal of octahedral bytes. */
export function coverPointNormal(bu: number, bv: number): [number, number, number] {
  let x = (bu / 255) * 2 - 1;
  let z = (bv / 255) * 2 - 1;
  const y = 1 - Math.abs(x) - Math.abs(z);
  if (y < 0) [x, z] = [(1 - Math.abs(z)) * Math.sign(x || 1), (1 - Math.abs(x)) * Math.sign(z || 1)];
  const len = Math.hypot(x, y, z) || 1;
  return [x / len, y / len, z / len];
}

interface Candidate {
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly nx: number;
  readonly ny: number;
  readonly nz: number;
  readonly floor: number;
  readonly ix: number;
  readonly iz: number;
}

/**
 * Rule `rule`'s points over the chunk whose world XZ box is `rect`, read
 * from `surface` (every floor it gives), in the frame of a source at world
 * `origin`.
 */
export function bakeCoverPoints(rule: ScatterRule, surface: ScatterSurface, rect: ScatterRect, origin: readonly number[]): CoverPointSet {
  const size = 1 / Math.sqrt(rule.density);
  const seed = scatterRuleSeed(rule);
  const spacing = Math.max(0, rule.spacing ?? 0);
  const blocks = rule.blocks !== undefined ? new Set(rule.blocks) : null;
  const point = (ix: number, iz: number): [number, number] => [(ix + brushHash(seed, ix, iz, LANE.jx)) * size, (iz + brushHash(seed, ix, iz, LANE.jz)) * size];
  const lane = (c: Candidate, l: number): number => brushHash(seed, c.ix, c.iz, l + c.floor * FLOOR_LANES);
  // The candidates the conditions keep, by cell, over the chunk and the spacing round it.
  const kept = new Map<string, Candidate[]>();
  const x0 = Math.floor((rect[0] - spacing) / size);
  const z0 = Math.floor((rect[1] - spacing) / size);
  const x1 = Math.floor((rect[2] + spacing) / size);
  const z1 = Math.floor((rect[3] + spacing) / size);
  for (let iz = z0; iz <= z1; iz++) {
    for (let ix = x0; ix <= x1; ix++) {
      const [x, z] = point(ix, iz);
      if ((rule.exclude !== undefined && surface.excluded?.(x, z, rule.exclude) === true) || surface.cleared?.(x, z, rule.id) === true) continue;
      const list: Candidate[] = [];
      let g = surface.at(x, z);
      for (let floor = 0; g !== null; floor++) {
        const y = g.y;
        if (g.ny > SCATTER_MIN_NORMAL_Y) {
          let f = ruleConditionsAt(rule, g, blocks, (r) => g!.cavity(r));
          for (const c of rule.layers ?? []) if (f > 0) f *= ruleRangeAt(c, g.layer(c.layer));
          const cand: Candidate = { x, y, z, nx: g.nx, ny: g.ny, nz: g.nz, floor, ix, iz };
          if (f > 0 && lane(cand, LANE.keep) < f) list.push(cand);
        }
        g = surface.under?.(x, z, y) ?? null;
        // Each floor lies under the one before (a surface answering otherwise ends the column).
        if (g !== null && g.y >= y) break;
      }
      if (list.length > 0) kept.set(`${ix},${iz}`, list);
    }
  }
  // Spacing: a candidate gives way to one within it (any floor) with the higher priority, as the stored scatter decides.
  const reach = Math.ceil(spacing / size);
  const gap = spacing * spacing;
  const gives = (c: Candidate): boolean => {
    if (spacing <= 0) return false;
    const mine = lane(c, LANE.priority);
    for (let dz = -reach; dz <= reach; dz++) {
      for (let dx = -reach; dx <= reach; dx++) {
        for (const o of kept.get(`${c.ix + dx},${c.iz + dz}`) ?? []) {
          if (o === c || (o.x - c.x) ** 2 + (o.y - c.y) ** 2 + (o.z - c.z) ** 2 >= gap) continue;
          const theirs = lane(o, LANE.priority);
          if (theirs > mine || (theirs === mine && (o.iz < c.iz || (o.iz === c.iz && (o.ix < c.ix || (o.ix === c.ix && o.floor < c.floor)))))) return true;
        }
      }
    }
    return false;
  };
  const ox = origin[0] ?? 0;
  const oy = origin[1] ?? 0;
  const oz = origin[2] ?? 0;
  const w = rect[2] - rect[0];
  const d = rect[3] - rect[1];
  const rows: { t: number; f: [number, number, number, number] }[] = [];
  let low = Infinity;
  let high = -Infinity;
  for (const list of kept.values()) {
    for (const c of list) {
      if (c.x < rect[0] || c.x >= rect[2] || c.z < rect[1] || c.z >= rect[3] || gives(c)) continue;
      const qx = Math.min(COVER_POINT_STEPS - 1, Math.round(((c.x - rect[0]) / w) * (COVER_POINT_STEPS - 1)));
      const qz = Math.min(COVER_POINT_STEPS - 1, Math.round(((c.z - rect[1]) / d) * (COVER_POINT_STEPS - 1)));
      const y = c.y - oy;
      const t = byte(lane(c, LANE.threshold));
      const [bu, bv] = octOf(c.nx, c.ny, c.nz);
      rows.push({ t, f: [qx + qz * COVER_POINT_STEPS, y, t + byte(lane(c, LANE.yaw)) * 256 + byte(lane(c, LANE.scale)) * 65536, bu + bv * 256] });
      low = Math.min(low, y);
      high = Math.max(high, y);
    }
  }
  rows.sort((a, b) => a.t - b.t || a.f[0] - b.f[0] || a.f[1] - b.f[1]);
  const data = new Float32Array(rows.length * COVER_POINT_FLOATS);
  rows.forEach((r, i) => data.set(r.f, i * COVER_POINT_FLOATS));
  return { x0: rect[0] - ox, z0: rect[1] - oz, w, d, low: rows.length > 0 ? low : 0, high: rows.length > 0 ? high : 0, count: rows.length, data };
}

/** Point `i` of a set (as the vertex stage reads it). */
export function coverPointAt(set: CoverPointSet, i: number): CoverPoint {
  const o = i * COVER_POINT_FLOATS;
  const xz = set.data[o]!;
  const qx = xz % COVER_POINT_STEPS;
  const qz = Math.floor(xz / COVER_POINT_STEPS);
  const bytes = set.data[o + 2]!;
  const n = set.data[o + 3]!;
  return {
    x: set.x0 + (qx / (COVER_POINT_STEPS - 1)) * set.w,
    y: set.data[o + 1]!,
    z: set.z0 + (qz / (COVER_POINT_STEPS - 1)) * set.d,
    normal: coverPointNormal(n % 256, Math.floor(n / 256)),
    threshold: share(bytes % 256),
    yaw: share(Math.floor(bytes / 256) % 256),
    scale: share(Math.floor(bytes / 65536)),
  };
}

/** The points of a set drawn while at most `kept` of them are (those whose threshold is below it): a prefix, the set being sorted. */
export function coverPointsBelow(set: CoverPointSet, kept: number): number {
  let lo = 0;
  let hi = set.count;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (share(set.data[mid * COVER_POINT_FLOATS + 2]! % 256) < kept) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** A point's copy as the vertex stage places it: its rotation for a rule's `align` and `yaw`, and its size in a rule's scale range. */
export function coverPointCopy(p: CoverPoint, rule: Pick<ScatterRule, 'align' | 'yaw' | 'scale'>): { rotation: Quat; scale: number } {
  const sc = rule.scale ?? [1, 1];
  return { rotation: copyRotation(p.normal[0], p.normal[1], p.normal[2], rule.align ?? 0, p.yaw * (rule.yaw ?? 360)), scale: sc[0] + p.scale * (sc[1] - sc[0]) };
}
