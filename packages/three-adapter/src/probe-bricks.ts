/**
 * Where the live probes stand outside rooms: bricks of probes, dense near
 * geometry and sparse in open space (as Unity's adaptive probe volumes
 * place them).
 *
 * - **Bricks.** A brick is `PROBE_BRICK_SIDE`³ probes on a cube of
 *   `PROBE_LEVEL_RATIO` probe spacings a side. Level 0 has the probes'
 *   spacing; each level up is `PROBE_LEVEL_RATIO` times coarser, so a brick
 *   of level L + 1 holds exactly 3³ bricks of level L and its probes stand
 *   on their lattice. Bricks sit on one world lattice per level, so a
 *   scene streaming in never moves them, and neighbouring bricks share the
 *   probes of their common faces (one probe, one record).
 * - **Marks.** The geometry says where it is and how fine it wants the
 *   probes there (`ProbeMarks`): a mark makes every brick it touches, of its
 *   level and every coarser one, exist. A brick exists only where some mark
 *   touches it, so open sky far from everything has none; a coarse brick
 *   stays as the fallback round its finer children (the lookup takes the
 *   finest brick holding a point).
 * - **Flat surfaces.** A brick of level 0 is only wanted where surfaces
 *   meet (a wall on a floor, a step, a ceiling over a floor, a prop); flat
 *   ground (one plane, or the two sides of a slab) takes level 1, whose
 *   light varies slowly along it.
 * - **Validity.** A probe inside geometry (`solid`) is moved to a free
 *   point within half its spacing, up or across (its rays start there; it keeps
 *   its place in the lattice: Unity's virtual offset), else dropped (no
 *   rays, no weight); a brick whose probes are all dropped goes.
 *
 * `buildBrickMap` is the sparse lookup the shaders read: a grid of the
 * coarsest bricks' cells, each with a dense table at the finest level
 * present in it, naming the finest brick at each place.
 *
 * Pure (no three.js, no device).
 */

/** Probes along a brick's edge. */
export const PROBE_BRICK_SIDE = 4;
/** Spacings a brick spans, and how much coarser each level is than the one below (equal: a level's probes stand on the finer lattice). */
export const PROBE_LEVEL_RATIO = PROBE_BRICK_SIDE - 1;
/** Levels of bricks: the probe spacing times 1, 3 and 9. */
export const PROBE_BRICK_LEVELS = 3;
/** How far in front of a flat surface (a share of the finest spacing) bricks count as touched: a floor lying on a brick's face makes the brick above it. */
export const PROBE_MARK_MARGIN = 0.5;
/** Where a probe inside geometry is searched for a free point: these shares of its spacing, along the directions to its lattice neighbours level with or above it. */
const PROBE_OFFSET_SHARES = [0.25, 0.5];
/** A brick map's empty entry. */
export const NO_BRICK = -1;

/** The probe spacing of a level (m). */
export function levelSpacing(spacing: number, level: number): number {
  return spacing * PROBE_LEVEL_RATIO ** level;
}

/** A brick's side at a level (m). */
export function brickSide(spacing: number, level: number): number {
  return levelSpacing(spacing, level) * PROBE_LEVEL_RATIO;
}

const KEY_XZ = 2 ** 20;
const KEY_Y = 2 ** 10;
/** A place on a lattice (whole numbers, |x| and |z| under 2²⁰, |y| under 2¹⁰: 2,000 km and 2 km of the finest lattice) as one number. */
export function latticeKey(x: number, y: number, z: number): number {
  return ((x + KEY_XZ) * 2 * KEY_XZ + (z + KEY_XZ)) * 2 * KEY_Y + (y + KEY_Y);
}
const keyOf = latticeKey;
function coordsOf(key: number): [number, number, number] {
  const y = (key % (2 * KEY_Y)) - KEY_Y;
  const r = Math.floor(key / (2 * KEY_Y));
  return [Math.floor(r / (2 * KEY_XZ)) - KEY_XZ, y, (r % (2 * KEY_XZ)) - KEY_XZ];
}

/**
 * What the geometry asks of the bricks. `mark` is for any surface (its box
 * and the finest level it wants); `plane` for flat pieces (blocks' faces),
 * whose level comes from whether planes meet in each brick (`finish`).
 */
export class ProbeMarks {
  /** Per level, the bricks (`latticeKey`s of their places on its lattice) that must exist. */
  readonly need: Set<number>[] = Array.from({ length: PROBE_BRICK_LEVELS }, () => new Set<number>());
  /** Per brick of level 0 touched by planes: those planes, or null once two of them meet (`planesMeet`). */
  private readonly planes = new Map<number, Plane[] | null>();
  private readonly margin: number;

  constructor(readonly spacing: number) {
    this.margin = PROBE_MARK_MARGIN * spacing;
  }

  /** The bricks of `level` a box overlaps (one touching a brick's face from outside does not), as lattice ranges per axis. */
  private range(min: readonly number[], max: readonly number[], level: number): [number, number][] {
    const s = brickSide(this.spacing, level);
    return [0, 1, 2].map((a) => {
      const lo = Math.floor(min[a]! / s);
      return [lo, Math.max(lo, Math.ceil(max[a]! / s) - 1)] as [number, number];
    });
  }

  /** The bricks a box touches must exist at `level`, and so must the coarser bricks holding them. */
  mark(min: readonly number[], max: readonly number[], level: number): void {
    const l = Math.max(0, Math.min(PROBE_BRICK_LEVELS - 1, level));
    const [x, y, z] = this.range(min, max, l) as [[number, number], [number, number], [number, number]];
    this.add(l, x[0], x[1], y[0], y[1], z[0], z[1]);
  }

  /** The bricks of `level` in column (bx, bz) from height `lo` to `hi` (grown by the margin up and down only). */
  column(level: number, bx: number, bz: number, lo: number, hi: number): void {
    const s = brickSide(this.spacing, level);
    this.add(level, bx, bx, Math.floor((lo - this.margin) / s), Math.ceil((hi + this.margin) / s) - 1, bz, bz);
  }

  /** Bricks x0..x1 × y0..y1 × z0..z1 of level `l` and their parents up to the coarsest level. */
  private add(l: number, x0: number, x1: number, y0: number, y1: number, z0: number, z1: number): void {
    for (let level = l; level < PROBE_BRICK_LEVELS; level += 1) {
      const need = this.need[level]!;
      for (let z = z0; z <= z1; z += 1) for (let y = y0; y <= y1; y += 1) for (let x = x0; x <= x1; x += 1) need.add(keyOf(x, y, z));
      const up = (v: number): number => Math.floor(v / PROBE_LEVEL_RATIO);
      [x0, x1, y0, y1, z0, z1] = [up(x0), up(x1), up(y0), up(y1), up(z0), up(z1)];
    }
  }

  /**
   * A flat piece of surface on the plane across `axis` at `at`, facing
   * `facing` (1: +axis, -1: −axis) along it.
   */
  plane(min: readonly number[], max: readonly number[], axis: number, facing: number, at: number): void {
    // The bricks on its front side only (where its light goes): the ground's underside and a slab's far side stay out.
    const s = brickSide(this.spacing, 0);
    const [[x0, x1], [y0, y1], [z0, z1]] = [0, 1, 2].map((a) => {
      const lo = a === axis ? Math.min(at, at + facing * this.margin) : min[a]!;
      const hi = a === axis ? Math.max(at, at + facing * this.margin) : max[a]!;
      return [Math.floor(lo / s), Math.max(Math.floor(lo / s), Math.ceil(hi / s) - 1)];
    }) as [[number, number], [number, number], [number, number]];
    const mine: Plane = { axis, facing, at };
    for (let z = z0; z <= z1; z += 1) {
      for (let y = y0; y <= y1; y += 1) {
        for (let x = x0; x <= x1; x += 1) {
          const k = keyOf(x, y, z);
          const had = this.planes.get(k);
          if (had === undefined) this.planes.set(k, [mine]);
          else if (had !== null && !had.some((q) => q.axis === axis && q.facing === facing && Math.abs(q.at - at) < PLANE_SAME)) {
            if (had.some((q) => planesMeet(q, mine))) this.planes.set(k, null);
            else had.push(mine);
          }
        }
      }
    }
  }

  /** The planes' bricks into the marks: level 0 where surfaces meet, else level 1. */
  finish(): this {
    for (const [k, planes] of this.planes) {
      const [x, y, z] = coordsOf(k);
      const l = planes === null ? 0 : 1;
      // The level-1 brick holding a level-0 brick: its coordinates divided by the ratio.
      const up = (v: number): number => (l === 0 ? v : Math.floor(v / PROBE_LEVEL_RATIO));
      this.add(l, up(x), up(x), up(y), up(y), up(z), up(z));
    }
    this.planes.clear();
    return this;
  }
}

/** A flat surface's plane (`ProbeMarks.plane`). */
interface Plane {
  readonly axis: number;
  readonly facing: number;
  readonly at: number;
}

/** Planes closer than this (m) are one. */
const PLANE_SAME = 1e-3;

/**
 * Whether two planes in one brick make light vary across it: planes across
 * different axes (a wall on a floor), two facing the same way at different
 * places (a step), or two facing each other (a floor and a ceiling). Two
 * facing away from each other are the two sides of one slab or wall: the
 * space between them is solid, and each side is flat ground.
 */
function planesMeet(a: Plane, b: Plane): boolean {
  if (a.axis !== b.axis) return true;
  if (a.facing === b.facing) return Math.abs(a.at - b.at) >= PLANE_SAME;
  const up = a.facing > 0 ? a : b;
  const down = a.facing > 0 ? b : a;
  return up.at < down.at;
}

/** A placed brick: its level, its place on its level's lattice and its world box. */
export interface ProbeBrick {
  readonly level: number;
  readonly at: readonly [number, number, number];
  readonly min: readonly [number, number, number];
  readonly side: number;
}

/** A probe's state after placement. */
export const PROBE_PLACED_VALID = 0;
export const PROBE_PLACED_MOVED = 1;
export const PROBE_PLACED_DROPPED = 2;

export interface PlacedBricks {
  readonly bricks: readonly ProbeBrick[];
  /** Per brick, its probes' indices (x fastest, then y, then z; `PROBE_BRICK_SIDE`³ each). */
  readonly ids: Uint32Array;
  /** Per probe: its key (`latticeKey` of its place on the finest lattice), lattice point (m), where its rays start, its finest level and its state. */
  readonly keys: readonly number[];
  readonly points: Float32Array;
  readonly origins: Float32Array;
  readonly levels: Uint8Array;
  readonly states: Uint8Array;
}

const OFFSET_DIRS: readonly (readonly number[])[] = (() => {
  const out: number[][] = [];
  // Up or across, never down: a probe in a floor serves the space above it, and moved down it would sit under
  // the ground (or beneath the floor) and light what stands on it with what it sees there.
  for (let z = -1; z <= 1; z += 1) for (let y = 0; y <= 1; y += 1) for (let x = -1; x <= 1; x += 1) if (x !== 0 || y !== 0 || z !== 0) out.push([x, y, z].map((v) => v / Math.hypot(x, y, z)));
  // The axes first (up before across), then the edges' and the corners' diagonals.
  const nonZero = (d: readonly number[]): number => d.filter((v) => v !== 0).length;
  return out.sort((a, b) => nonZero(a) - nonZero(b) || b[1]! - a[1]!);
})();

/**
 * The bricks the marks ask for, their probes, and each probe's validity
 * (`solid`: whether a point is inside geometry).
 */
export function placeProbeBricks(marks: ProbeMarks, solid: (p: readonly number[]) => boolean): PlacedBricks {
  const spacing = marks.spacing;
  const n = PROBE_BRICK_SIDE;
  const keys: number[] = [];
  const index = new Map<number, number>();
  const points: number[] = [];
  const levels: number[] = [];
  const candidates: { brick: ProbeBrick; ids: Uint32Array }[] = [];
  for (let level = PROBE_BRICK_LEVELS - 1; level >= 0; level -= 1) {
    const side = brickSide(spacing, level);
    const step = PROBE_LEVEL_RATIO ** level;
    for (const k of [...marks.need[level]!].sort((a, b) => a - b)) {
      const at = coordsOf(k);
      const ids = new Uint32Array(n ** 3);
      let j = 0;
      for (let iz = 0; iz < n; iz += 1) {
        for (let iy = 0; iy < n; iy += 1) {
          for (let ix = 0; ix < n; ix += 1) {
            // On the finest lattice (whole numbers of the finest spacing): shared by every brick holding the point.
            const lx = (at[0] * PROBE_LEVEL_RATIO + ix) * step;
            const ly = (at[1] * PROBE_LEVEL_RATIO + iy) * step;
            const lz = (at[2] * PROBE_LEVEL_RATIO + iz) * step;
            const pk = keyOf(lx, ly, lz);
            let i = index.get(pk);
            if (i === undefined) {
              i = keys.length;
              index.set(pk, i);
              keys.push(pk);
              points.push(lx * spacing, ly * spacing, lz * spacing);
              levels.push(level);
            } else if (level < levels[i]!) levels[i] = level;
            ids[j++] = i;
          }
        }
      }
      candidates.push({ brick: { level, at, min: [at[0] * side, at[1] * side, at[2] * side], side }, ids });
    }
  }
  const states = new Uint8Array(keys.length);
  const origins = Float32Array.from(points);
  const p = [0, 0, 0];
  const o = [0, 0, 0];
  for (let i = 0; i < keys.length; i += 1) {
    o[0] = points[i * 3]!;
    o[1] = points[i * 3 + 1]!;
    o[2] = points[i * 3 + 2]!;
    if (!solid(o)) continue;
    const s = levelSpacing(spacing, levels[i]!);
    let found = false;
    for (const d of OFFSET_DIRS) {
      for (const share of PROBE_OFFSET_SHARES) {
        for (let a = 0; a < 3; a += 1) p[a] = o[a]! + d[a]! * share * s;
        if (solid(p)) continue;
        origins.set(p, i * 3);
        found = true;
        break;
      }
      if (found) break;
    }
    states[i] = found ? PROBE_PLACED_MOVED : PROBE_PLACED_DROPPED;
  }
  const kept = candidates.filter((c) => c.ids.some((i) => states[i] !== PROBE_PLACED_DROPPED));
  const ids = new Uint32Array(kept.length * n ** 3);
  kept.forEach((c, b) => ids.set(c.ids, b * n ** 3));
  return { bricks: kept.map((c) => c.brick), ids, keys, points: Float32Array.from(points), origins, levels: Uint8Array.from(levels), states };
}

/**
 * The sparse lookup of bricks: `dims` cells of the coarsest bricks' side
 * (`top`) from `origin`; per cell (`cells`: two numbers) its first entry and
 * its table's side `n` (0: no brick there), and `n`³ entries (x fastest)
 * naming the finest brick at each place (`NO_BRICK`: none).
 */
export interface BrickMap {
  readonly origin: readonly [number, number, number];
  readonly top: number;
  readonly dims: readonly [number, number, number];
  readonly cells: Int32Array;
  readonly entries: Int32Array;
}

export const EMPTY_BRICK_MAP: BrickMap = { origin: [0, 0, 0], top: 1, dims: [0, 0, 0], cells: new Int32Array(0), entries: new Int32Array(0) };

/** The map of cubes (`min`, `side`: a brick of some level, `id` what the map names it by). Cubes neither overlap nor cross a coarsest cell. */
export function buildBrickMap(cubes: readonly { readonly min: readonly number[]; readonly side: number; readonly id: number }[]): BrickMap {
  if (cubes.length === 0) return EMPTY_BRICK_MAP;
  const top = Math.max(...cubes.map((c) => c.side));
  const cellOf = (c: { min: readonly number[]; side: number }): number[] => [0, 1, 2].map((a) => Math.floor((c.min[a]! + c.side / 2) / top));
  const lo = [Infinity, Infinity, Infinity];
  const hi = [-Infinity, -Infinity, -Infinity];
  for (const c of cubes) {
    const cc = cellOf(c);
    for (let a = 0; a < 3; a += 1) {
      lo[a] = Math.min(lo[a]!, cc[a]!);
      hi[a] = Math.max(hi[a]!, cc[a]!);
    }
  }
  const dims = [0, 1, 2].map((a) => hi[a]! - lo[a]! + 1) as [number, number, number];
  const cellIndex = (cc: readonly number[]): number => cc[0]! - lo[0]! + dims[0] * (cc[1]! - lo[1]! + dims[1] * (cc[2]! - lo[2]!));
  const finest = new Float64Array(dims[0] * dims[1] * dims[2]).fill(Infinity);
  for (const c of cubes) {
    const ci = cellIndex(cellOf(c));
    finest[ci] = Math.min(finest[ci]!, c.side);
  }
  const cells = new Int32Array(finest.length * 2);
  let at = 0;
  for (let ci = 0; ci < finest.length; ci += 1) {
    if (!Number.isFinite(finest[ci]!)) continue;
    const side = Math.round(top / finest[ci]!);
    cells[ci * 2] = at;
    cells[ci * 2 + 1] = side;
    at += side ** 3;
  }
  const entries = new Int32Array(at).fill(NO_BRICK);
  // Coarse first: a finer cube writes over the coarse one round it.
  const spans = (c: (typeof cubes)[number], f: (entry: number) => void): void => {
    const cc = cellOf(c);
    const ci = cellIndex(cc);
    const side = cells[ci * 2 + 1]!;
    const sub = top / side;
    const from = [0, 1, 2].map((a) => Math.round((c.min[a]! - cc[a]! * top) / sub));
    const span = Math.round(c.side / sub);
    for (let z = 0; z < span; z += 1) for (let y = 0; y < span; y += 1) for (let x = 0; x < span; x += 1) f(cells[ci * 2]! + from[0]! + x + side * (from[1]! + y + side * (from[2]! + z)));
  };
  for (const c of [...cubes].sort((a, b) => b.side - a.side)) spans(c, (e) => (entries[e] = c.id));
  return { origin: [lo[0]! * top, lo[1]! * top, lo[2]! * top], top, dims, cells, entries };
}

/**
 * The finest brick at `p` (`NO_BRICK`: none). A point outside the map by at
 * most `reach` is held at its edge (the shaders do the same).
 */
export function brickMapAt(map: BrickMap, p: readonly number[], reach = 0): number {
  if (map.dims[0] === 0) return NO_BRICK;
  const q = [0, 0, 0];
  for (let a = 0; a < 3; a += 1) {
    const lo = map.origin[a]!;
    const hi = lo + map.dims[a]! * map.top;
    if (p[a]! < lo - reach || p[a]! > hi + reach) return NO_BRICK;
    q[a] = Math.min(hi - 1e-4, Math.max(lo, p[a]!));
  }
  const cf = [0, 1, 2].map((a) => Math.min(map.dims[a]! - 1, Math.floor((q[a]! - map.origin[a]!) / map.top)));
  const ci = cf[0]! + map.dims[0] * (cf[1]! + map.dims[1] * cf[2]!);
  const side = map.cells[ci * 2 + 1]!;
  if (side === 0) return NO_BRICK;
  const s = [0, 1, 2].map((a) => Math.min(side - 1, Math.max(0, Math.floor(((q[a]! - map.origin[a]! - cf[a]! * map.top) * side) / map.top))));
  return map.entries[map.cells[ci * 2]! + s[0]! + side * (s[1]! + side * s[2]!)]!;
}
