/**
 * The live probes: bounced light at points of regular grids, kept up to date
 * from the surface cache (the probe pass, `surface-probe-pass.ts`, and its
 * CPU twin, `surface-probe-cpu.ts`, compute them; this holds where they
 * are, which wait for light, and what the probe lighting draws).
 *
 * - **Where.** A grid per room of generated architecture, inset from its
 *   walls (project-model `placeProbeGrids`), listed first; elsewhere bricks
 *   dense near geometry and sparse in open space (`probe-bricks.ts`, from
 *   what the static scene marks: `probe-geometry.ts`), found through a
 *   sparse map (`buildBrickMap`). A probe belongs to its room (a room
 *   grid's probes to its room; a brick's to the room it stands in, or
 *   none). A brick's probe standing in a room is never lit (its room's grid
 *   holds that light): it would carry the room's light through the wall to
 *   the outside's points next to it. A brick's probe inside geometry is
 *   moved out or dropped (never lit, no weight); a room grid's is dropped.
 * - **Light.** Each update casts `PROBE_SH_RAYS` rays (a spherical
 *   Fibonacci set, turned at random each time) and `PROBE_AXIS_RAYS` along
 *   the axes. A ray that hits a static surface reads its cache texel's
 *   direct light and the probes' own light there (their last update), as a
 *   surface of albedo `BOUNCE_ALBEDO` reflects it; one that hits nothing
 *   sees the sky. Probes read probes, so bounces build up over updates. A
 *   probe in a room casts its rays only to the room's walls unless they
 *   leave by an open portal (`surface-rooms.ts`).
 * - **Walls.** For bricks (interiors of blocks or imported models), what
 *   the axis rays see gives each probe its walls in each brick holding it
 *   (`edgeWalls`), which the probe lighting keeps samples on their side of.
 * - **Stale.** The cache's marks (`SurfaceRelight.onStale`) make the probes
 *   in their box stale; it stays stale for `PROBE_MIN_UPDATES` to
 *   `PROBE_MAX_UPDATES` updates, until one changes its light by less than
 *   `PROBE_SETTLE_SHARE`, and through any update while the cache's direct
 *   light is not settled. Stale probes are updated nearest the eye first.
 *
 * A probe's record (`PROBE_FLOATS`): its first-order spherical harmonics
 * (four RGB coefficients, as the probe lighting reads them: band 0, then
 * y, z, x), its share of rays meeting back faces, its update count and
 * whether it was moved out of geometry, then what its axis rays saw (+x −x
 * +y −y +z −z; 0: nothing).
 *
 * Pure (no three.js, no device).
 */
import { PROBE_VALIDITY_THRESHOLD, ROOM_PROBE_INSET, placeProbeGrids, type ProbeGridBox } from '@thirdlight/runtime';

import { EMPTY_BRICK_MAP, PROBE_BRICK_SIDE, PROBE_PLACED_DROPPED, PROBE_PLACED_MOVED, PLACE_STEP_ITEMS, brickMapAt, buildBrickMap, isSteps, levelSpacing, placeProbeBricksSteps, runSteps, type BrickMap, type PlacedBricks, type ProbeMarks, type ProbeSolid, type Steps } from './probe-bricks';
import { PROBE_WEIGHT_FILLED, PROBE_WEIGHT_MOVED, PROBE_WEIGHT_VALID } from './probe-weights';
import { NO_ROOM, roomHoldsCpu, type SurfaceRooms } from './surface-rooms';

/** Rays an update casts for a probe's light, and along the axes for its walls. */
export const PROBE_SH_RAYS = 64;
export const PROBE_AXIS_RAYS = 6;
export const PROBE_RAYS = PROBE_SH_RAYS + PROBE_AXIS_RAYS;
/**
 * The albedo bounced light is reflected with (the cache holds light, not
 * its surfaces' colours): a typical surface's, so a closed room's light
 * builds up to about 1 / (1 − 0.3) of its direct light, not double it.
 */
export const BOUNCE_ALBEDO = 0.3;
/** How far a probe ray runs (spacings of its own level) before it is taken to see the sky. */
export const PROBE_RAY_SPACINGS = 8;
/** How far (m) a hit's point is moved off its surface before the probes are read there: past a room's probe inset, so a wall's room side reads its room. */
export const PROBE_HIT_LIFT = ROOM_PROBE_INSET + 0.05;
/** The least weight an update's light gets against the probe's last (the first updates take more: 1 / their count). */
export const PROBE_BLEND_MIN = 0.25;
/**
 * A probe is settled once an update changes its light by less than this
 * share, or after `PROBE_MAX_UPDATES` updates since it was marked: its
 * turned rays are a noisy estimate (a small bright patch seen by a few of
 * them moves it by tens of per cent an update), which the blend averages
 * out, so noise must not keep it stale. Marks reach every probe a change
 * can relight (a light's reach, a changed box and bounce reach round it),
 * so bounces build up among the marked probes without spreading further.
 */
export const PROBE_SETTLE_SHARE = 0.05;
/** Updates a probe takes at least, and at most, after it was marked (its rays turn each time). */
export const PROBE_MIN_UPDATES = 4;
export const PROBE_MAX_UPDATES = 8;
/** Floats of a probe's record. */
export const PROBE_FLOATS = 24;
/** Words of a grid's record in the pass's words: min, max (f32), probes per axis, its first lattice word, room, level. */
export const GRID_WORDS = 12;
/** Words of the brick map's header in the pass's words: origin, the coarsest side (f32), cells per axis, where its cells and entries start. */
export const BRICK_MAP_WORDS = 9;
/** A brick map entry's word for no brick. */
export const NO_BRICK_WORD = 0xffffffff;
/** The probe update's share of the live light's GPU time a frame (`surfaceLightMs`): medium's 1.5 ms gives the probes 0.5 ms. */
export const PROBE_BUDGET_SHARE = 1 / 3;
/**
 * Probes an update takes before any cost is measured, and at least and at
 * most. An update's GPU time is mostly its tracer's latency (its longest
 * rays, through models' distance fields), not how many rays it casts: on
 * the Iris Xe 64 and 256 of the village's probes cost about alike (1.6 and
 * 2.0 ms at full clock), so an update never takes fewer than 256.
 */
export const PROBE_START_COUNT = 256;
export const PROBE_MIN_COUNT = 256;
export const PROBE_MAX_COUNT = 4096;
/** Frames over which a waiting probe's distance halves when stale probes are ordered. */
const PROBE_AGING_FRAMES = 30;

/**
 * How far (m) a probe's rays start off its lattice point: lattice points
 * fall on block and grid boundaries, where a ray starting exactly on a face
 * would take either cell by a rounding.
 */
const PROBE_ORIGIN_NUDGE = [0.0013, 0.0017, 0.0011];

/** Updates one ordering of the stale probes feeds (`LiveProbes.plan`). */
const PLAN_AHEAD = 8;

/** A waiting probe's squared distance factor after `frames` frames: its distance halves every `PROBE_AGING_FRAMES` (looked up, not raised). */
const AGING = Float32Array.from({ length: PROBE_AGING_FRAMES * 20 + 1 }, (_, f) => 0.25 ** (f / PROBE_AGING_FRAMES));
function agingOf(frames: number): number {
  return AGING[Math.min(AGING.length - 1, Math.max(0, frames))]!;
}

/** Index of the validity (back-face share), the update count and the moved flag in a probe's record. */
export const PROBE_VALIDITY_AT = 12;
export const PROBE_UPDATES_AT = 13;
export const PROBE_MOVED_AT = 14;
export const PROBE_AXES_AT = 16;

/** SH basis constants (band 0, band 1) and three's irradiance factors for them. */
export const SH_Y0 = 0.282095;
export const SH_Y1 = 0.488603;
export const SH_E0 = 0.886227;
export const SH_E1 = 1.023328;

export interface LiveProbeGrid extends ProbeGridBox {
  /** Stable while its box and probes stay. */
  readonly key: string;
  /** Where its probes' indices start in `LiveProbes.lattice` (x fastest, then y, then z). */
  readonly at: number;
  /** The room its probes are in (`NO_ROOM`: not a room's grid). */
  readonly room: number;
  /** Its brick's level (`probe-bricks.ts`), or -1: a room's grid. */
  readonly level: number;
}

/** The static scene's marks and solid test (`probe-geometry.ts`). */
export interface ProbeGeometry {
  readonly marks: ProbeMarks;
  readonly solid: ProbeSolid;
}

/** What the probes are placed from outside rooms. */
export interface ProbePlacement {
  /** Nothing is placed again while this (and the rooms) stay. */
  readonly key: string;
  /** Asked only when the key changed (made at once, or in steps). */
  readonly geometry: () => ProbeGeometry | Steps<ProbeGeometry>;
}

/** What a lookup of the probes reads (`LiveProbes` holds it). */
export interface ProbeLookup {
  readonly grids: readonly LiveProbeGrid[];
  /** Grids of rooms (the first ones). */
  readonly roomGrids: number;
  readonly lattice: Uint32Array;
  readonly map: BrickMap;
  readonly state: Float32Array;
}

/** A probe's irradiance at normal `n` from its record's coefficients (the probe lighting's sum). */
export function shIrradiance(rec: ArrayLike<number>, at: number, n: readonly number[], out: number[] = [0, 0, 0]): number[] {
  for (let c = 0; c < 3; c += 1) {
    out[c] = SH_E0 * rec[at + c]! + SH_E1 * (rec[at + 3 + c]! * n[1]! + rec[at + 6 + c]! * n[2]! + rec[at + 9 + c]! * n[0]!);
  }
  return out;
}

/** A probe's weight in the interpolation: none before its first update (or never lit), little when it sees back faces, half when it was moved out of geometry. */
export function liveProbeWeight(rec: ArrayLike<number>, at: number): number {
  if (rec[at + PROBE_UPDATES_AT]! < 1) return 0;
  if (rec[at + PROBE_VALIDITY_AT]! > PROBE_VALIDITY_THRESHOLD) return PROBE_WEIGHT_FILLED;
  return rec[at + PROBE_MOVED_AT]! > 0 ? PROBE_WEIGHT_MOVED : PROBE_WEIGHT_VALID;
}

/**
 * Each probe's walls from what the probes see straight along the axes
 * (`along`: 6 distances a probe, +x −x +y −y +z −z, 0 where nothing is hit):
 * the edge from a probe to the next one along an axis is cut when each of
 * the two sees a surface before the other; the cut is where its two
 * surfaces' middle is, as a share of the edge (0…1). `out`: 6 floats a probe,
 * per axis the cut flag (1 or 0) and the share.
 */
export function edgeWalls(grid: ProbeGridBox, along: Float32Array, out: Float32Array): void {
  const n = grid.resolution as readonly number[];
  const [nx, ny] = n as [number, number, number];
  const step = [0, 1, 2].map((a) => (grid.max[a]! - grid.min[a]!) / (n[a]! - 1));
  const offset = [1, nx, nx * ny];
  out.fill(0);
  for (let i = 0; i < along.length / 6; i++) {
    const at = [i % nx, Math.floor(i / nx) % ny, Math.floor(i / (nx * ny))];
    for (let a = 0; a < 3; a++) {
      if (at[a]! >= n[a]! - 1) continue;
      const s = step[a]!;
      const fromLo = along[i * 6 + a * 2]!;
      const fromHi = along[(i + offset[a]!) * 6 + a * 2 + 1]!;
      if (!(fromLo > 0 && fromLo < s && fromHi > 0 && fromHi < s)) continue;
      out[i * 6 + a * 2] = 1;
      out[i * 6 + a * 2 + 1] = (fromLo / s + (1 - fromHi / s)) / 2;
    }
  }
}

/** Where probe `ix, iy, iz` of a grid stands (its lattice point). */
function latticePoint(g: ProbeGridBox, ix: number, iy: number, iz: number, out: number[]): void {
  const at = [ix, iy, iz];
  for (let a = 0; a < 3; a += 1) {
    const n = g.resolution[a]!;
    out[a] = n > 1 ? g.min[a]! + ((g.max[a]! - g.min[a]!) * at[a]!) / (n - 1) : g.min[a]!;
  }
}

/**
 * The grid the probes are read from at `q` (-1: none): the first room's
 * grid within `PROBE_HIT_LIFT` of it (a room's grid stands that far inside
 * its walls; outside its box only for a point in its room, `rooms` the
 * packed rooms), else the finest brick there (`brickMapAt`, held at the
 * map's edge within the lift).
 */
export function probeGridAt(p: ProbeLookup, q: readonly number[], rooms: Uint32Array | null = null): number {
  const m = PROBE_HIT_LIFT;
  for (let k = 0; k < p.roomGrids; k += 1) {
    const b = p.grids[k]!;
    if (!(q[0]! >= b.min[0] - m && q[0]! <= b.max[0] + m && q[1]! >= b.min[1] - m && q[1]! <= b.max[1] + m && q[2]! >= b.min[2] - m && q[2]! <= b.max[2] + m)) continue;
    const inside = q[0]! >= b.min[0] && q[0]! <= b.max[0] && q[1]! >= b.min[1] && q[1]! <= b.max[1] && q[2]! >= b.min[2] && q[2]! <= b.max[2];
    if (inside || (rooms !== null && roomHoldsCpu(rooms, b.room, q))) return k;
  }
  return brickMapAt(p.map, q, m);
}

/**
 * The irradiance (rgb) the probes give a point `q` facing `n`: from the grid
 * `probeGridAt` finds, the point held inside it, trilinear between its
 * probes by their weights (0: no grid there, or none of its probes lit).
 */
export function probesIrradianceAt(p: ProbeLookup, q: readonly number[], n: readonly number[], out: number[] = [0, 0, 0], rooms: Uint32Array | null = null): number[] {
  out[0] = out[1] = out[2] = 0;
  const gi = probeGridAt(p, q, rooms);
  if (gi < 0) return out;
  const g = p.grids[gi]!;
  const state = p.state;
  const r = g.resolution;
  const sh = LOOKUP_SH.fill(0);
  const i0 = LOOKUP_I0;
  const t = LOOKUP_T;
  for (let a = 0; a < 3; a += 1) {
    const c = Math.min(g.max[a]!, Math.max(g.min[a]!, q[a]!));
    const f = r[a]! > 1 ? ((c - g.min[a]!) / (g.max[a]! - g.min[a]!)) * (r[a]! - 1) : 0;
    i0[a] = Math.min(Math.max(0, Math.floor(f)), Math.max(0, r[a]! - 2));
    t[a] = r[a]! > 1 ? Math.min(1, Math.max(0, f - i0[a]!)) : 0;
  }
  let wsum = 0;
  for (let k = 0; k < 8; k += 1) {
    const ix = Math.min(r[0]! - 1, i0[0]! + (k & 1));
    const iy = Math.min(r[1]! - 1, i0[1]! + ((k >> 1) & 1));
    const iz = Math.min(r[2]! - 1, i0[2]! + ((k >> 2) & 1));
    const tri = (k & 1 ? t[0]! : 1 - t[0]!) * ((k >> 1) & 1 ? t[1]! : 1 - t[1]!) * ((k >> 2) & 1 ? t[2]! : 1 - t[2]!);
    const at = p.lattice[g.at + ix + iy * r[0]! + iz * r[0]! * r[1]!]! * PROBE_FLOATS;
    const w = tri * liveProbeWeight(state, at);
    if (w <= 0) continue;
    for (let j = 0; j < 12; j += 1) sh[j]! += state[at + j]! * w;
    wsum += w;
  }
  if (wsum <= 0) return out;
  for (let j = 0; j < 12; j += 1) sh[j]! /= wsum;
  shIrradiance(sh, 0, n, out);
  for (let k = 0; k < 3; k += 1) out[k] = Math.max(0, out[k]!);
  return out;
}

/** Scratch for `probesIrradianceAt` (it runs per traced ray in the CPU twin and per texel in the cache view). */
const LOOKUP_SH = new Float64Array(12);
const LOOKUP_I0 = [0, 0, 0];
const LOOKUP_T = [0, 0, 0];

/** Put the `k` smallest of `keys[0..n)` (with their `order`) first, in no particular order (quickselect). */
export function selectSmallest(keys: Float32Array, order: Uint32Array, n: number, k: number): void {
  let lo = 0;
  let hi = n - 1;
  const swap = (a: number, b: number): void => {
    const kk = keys[a]!;
    keys[a] = keys[b]!;
    keys[b] = kk;
    const o = order[a]!;
    order[a] = order[b]!;
    order[b] = o;
  };
  while (lo < hi && k > lo && k <= hi) {
    const pivot = keys[(lo + hi) >> 1]!;
    let i = lo;
    let j = hi;
    while (i <= j) {
      while (keys[i]! < pivot) i += 1;
      while (keys[j]! > pivot) j -= 1;
      if (i <= j) {
        swap(i, j);
        i += 1;
        j -= 1;
      }
    }
    if (k <= j) hi = j;
    else if (k >= i) lo = i;
    else return;
  }
}

export interface LiveProbeDiagnostics {
  readonly grids: number;
  /** Bricks of each level (finest first). */
  readonly bricks: readonly number[];
  readonly probes: number;
  /** Probes lit (not dropped inside geometry, nor a brick's probe standing in a room), and of those moved out of geometry. */
  readonly lit: number;
  readonly moved: number;
  readonly stale: number;
  readonly settled: boolean;
  /** Probes an update takes now, and the last update's GPU time (ms; null: none measured). */
  readonly perUpdate: number;
  readonly msUsed: number | null;
  /** The last change's time until settled (ms) and updates (null: none yet). */
  readonly lastSettleMs: number | null;
  readonly updates: number;
  /** The last placement's main-thread time (ms). */
  readonly placeMs: number;
  /** The most main-thread time (ms) one frame gave the last placement, where a host makes it a share a frame. */
  readonly placeFrameMs?: number;
}

/** The words of a layout the passes read (grids, lattice, brick map), and where the lattice and the map start in them. */
export interface ProbeLayoutWords {
  readonly words: Uint32Array;
  readonly latticeAt: number;
  readonly mapAt: number;
}

/** The probe lighting's tile key of a live grid (what a bake saves its tile under). */
export function liveProbeTileKey(g: Pick<LiveProbeGrid, 'key'>): string {
  return `live:${g.key}`;
}

/**
 * A saved grid's probes as a bake left them (`LiveProbes.seed`): its box and
 * resolution, and per point its record's light (twelve values, as
 * `PROBE_FLOATS` holds them), whether it was lit, filled from neighbours, and
 * its walls (per axis the cut flag and the cut's share of the edge).
 */
export interface SavedProbeGrid {
  readonly min: readonly number[];
  readonly max: readonly number[];
  readonly resolution: readonly number[];
  /** Point `l`'s light into `light` (12) and walls into `walls` (6); null: never lit. */
  read(l: number, light: Float32Array, walls: Float32Array): { filled: boolean } | null;
}

export class LiveProbes implements ProbeLookup {
  grids: LiveProbeGrid[] = [];
  roomGrids = 0;
  /** Per grid point (from each grid's `at`), its probe. */
  lattice = new Uint32Array(0);
  map: BrickMap = EMPTY_BRICK_MAP;
  /** Probe records (`PROBE_FLOATS` each): what the pass wrote, read back. */
  state = new Float32Array(0);
  /** Where each probe's rays start, and how far they run (m). */
  positions = new Float32Array(0);
  reach = new Float32Array(0);
  rooms = new Uint32Array(0);
  /** Bumped when the probes were placed again (the pass uploads them and the probes start over). */
  layout = 0;
  /** Per probe, the grids holding it and where (pairs of grid and point index, from `holdersAt[i]` to `holdersAt[i + 1]`). */
  holdersAt = new Uint32Array(1);
  holders = new Uint32Array(0);
  /** Per probe, what names its place across placements (a room grid's point, or a brick probe's lattice key). */
  private keys: (string | number)[] = [];
  private stale = new Uint8Array(0);
  /** Probes never lit: a brick's standing in a room, or dropped inside geometry. */
  private excluded = new Uint8Array(0);
  private since = new Int32Array(0);
  private marked = new Int32Array(0);
  private staleCount = 0;
  private frame = 0;
  private placedFor = '';
  private perUpdate = PROBE_START_COUNT;
  private msPerProbe: number | null = null;
  private msUsed: number | null = null;
  private settling: number | null = null;
  private lastSettleMs: number | null = null;
  private updates = 0;
  private placeMs = 0;
  /** The placement's bricks per level and its lit and moved probes. */
  private counts = { bricks: [0, 0, 0] as readonly number[], lit: 0, moved: 0 };
  private words: ProbeLayoutWords | null = null;
  /** Scratch for `plan`: the stale probes' keys and indices. */
  private order = { keys: new Float32Array(0), order: new Uint32Array(0) };
  /** The nearest stale probes of the last ordering (`plan` picks among them for a few updates): keys, indices, how many, plans since, and where the eye was. */
  private queue = { keys: new Float32Array(0), order: new Uint32Array(0), length: 0, plans: 0, eye: [Infinity, Infinity, Infinity] };
  /** Probes whose records changed since `takeChangedProbes`. */
  private changed = new Set<number>();

  constructor(readonly spacing: number, private budgetMs: number) {}

  setBudget(ms: number): void {
    this.budgetMs = ms;
  }

  /**
   * Place the probes: the rooms' grids, and bricks from `placement` (null:
   * none outside rooms); nothing changes while its key and the rooms stay.
   * A probe at a place it held before keeps its light and its stale state.
   * True when they were placed again.
   */
  place(placement: ProbePlacement | null, rooms: SurfaceRooms | null): boolean {
    return runSteps(this.placeSteps(placement, rooms));
  }

  /**
   * `place` in steps: the probes stay as they are (and go on updating)
   * until the last step puts the new ones in at once, carrying the light the
   * kept ones hold by then.
   */
  *placeSteps(placement: ProbePlacement | null, rooms: SurfaceRooms | null): Steps<boolean> {
    const roomBoxes = rooms === null ? [] : rooms.rooms.graph.rooms.map((r) => ({ min: [r.box[0] + ROOM_PROBE_INSET, r.floor + ROOM_PROBE_INSET, r.box[1] + ROOM_PROBE_INSET], max: [r.box[2] - ROOM_PROBE_INSET, r.top - ROOM_PROBE_INSET, r.box[3] - ROOM_PROBE_INSET] }));
    const key = JSON.stringify([placement?.key ?? null, roomBoxes]);
    if (key === this.placedFor) return false;
    let busy = 0;
    let t0 = performance.now();
    // Main-thread time spent (between steps only: the time a caller waits between them is not the placement's).
    const step = function* (): Steps<void> {
      busy += performance.now() - t0;
      yield;
      t0 = performance.now();
    };
    const roomTiles = roomBoxes.map((box, i) => ({ i, ok: box.max.every((v, a) => v > box.min[a]!) }));
    const boxes = placeProbeGrids(null, this.spacing, [], roomBoxes.filter((_, i) => roomTiles[i]!.ok));
    // A room's tiles come first, in its order: the grids of room i are those over its inset box.
    const owners = roomTiles.filter((r) => r.ok).map((r) => r.i);
    const made = placement?.geometry() ?? null;
    let geometry: ProbeGeometry | null = null;
    if (made !== null && isSteps(made)) {
      for (let r = made.next(); ; r = made.next()) {
        if (r.done === true) {
          geometry = r.value;
          break;
        }
        yield* step();
      }
    } else geometry = made;
    let placed: PlacedBricks | null = null;
    if (geometry !== null) {
      const g = geometry;
      const work = (function* (): Steps<PlacedBricks> {
        return yield* placeProbeBricksSteps(yield* g.marks.finishSteps(), g.solid);
      })();
      for (let r = work.next(); ; r = work.next()) {
        if (r.done === true) {
          placed = r.value;
          break;
        }
        yield* step();
      }
    }
    const grids: LiveProbeGrid[] = [];
    let points = 0;
    for (const box of boxes) {
      const ownerIdx = owners.findIndex((i) => {
        const rb = roomBoxes[i]!;
        return box.min.every((v, a) => v >= rb.min[a]! - 1e-6) && box.max.every((v, a) => v <= rb.max[a]! + 1e-6);
      });
      const room = ownerIdx >= 0 ? owners[ownerIdx]! : NO_ROOM;
      grids.push({ ...box, key: `${box.min.join(',')}|${box.max.join(',')}|${box.resolution.join(',')}|${room}`, at: points, room, level: -1 });
      points += box.resolution[0] * box.resolution[1] * box.resolution[2];
    }
    const roomProbes = points;
    const n3 = PROBE_BRICK_SIDE ** 3;
    for (const b of placed?.bricks ?? []) {
      const max = [b.min[0] + b.side, b.min[1] + b.side, b.min[2] + b.side] as [number, number, number];
      grids.push({ min: [...b.min], max, resolution: [PROBE_BRICK_SIDE, PROBE_BRICK_SIDE, PROBE_BRICK_SIDE], key: `b${b.level}:${b.at.join(',')}`, at: points, room: NO_ROOM, level: b.level });
      points += n3;
    }
    const count = roomProbes + (placed?.keys.length ?? 0);
    const lattice = new Uint32Array(points);
    for (let i = 0; i < roomProbes; i += 1) lattice[i] = i;
    if (placed !== null) for (let i = 0; i < placed.ids.length; i += 1) lattice[roomProbes + i] = roomProbes + placed.ids[i]!;
    const oldIndex = new Map(this.keys.map((k, i) => [k, i]));
    yield* step();
    const next = {
      positions: new Float32Array(count * 3),
      reach: new Float32Array(count),
      rooms: new Uint32Array(count),
      keys: new Array<string | number>(count),
      excluded: new Uint8Array(count),
      moved: new Uint8Array(count),
      /** Per probe, the old probe it was (-1: none), whose light and stale state it takes when the placement is put in. */
      was: new Int32Array(count).fill(-1),
    };
    const setProbe = (i: number, key: string | number, origin: ArrayLike<number>, point: ArrayLike<number>, room: number, level: number, excluded: boolean, moved: boolean): void => {
      next.keys[i] = key;
      for (let a = 0; a < 3; a += 1) next.positions[i * 3 + a] = origin[a]! + PROBE_ORIGIN_NUDGE[a]!;
      next.reach[i] = PROBE_RAY_SPACINGS * levelSpacing(this.spacing, level);
      next.rooms[i] = room !== NO_ROOM ? room : (rooms?.roomAt([point[0]!, point[1]!, point[2]!]) ?? NO_ROOM);
      // A brick's probe moved out of geometry into a room counts as standing in it.
      const movedIn = room === NO_ROOM && moved && rooms !== null && rooms.roomAt([origin[0]!, origin[1]!, origin[2]!]) !== NO_ROOM;
      if (excluded || movedIn || (room === NO_ROOM && next.rooms[i] !== NO_ROOM)) {
        next.excluded[i] = 1;
        return;
      }
      next.was[i] = oldIndex.get(key) ?? -1;
      next.moved[i] = moved ? 1 : 0;
    };
    const p = [0, 0, 0];
    for (const g of grids.slice(0, boxes.length)) {
      const [nx, ny, nz] = g.resolution;
      for (let iz = 0; iz < nz; iz += 1) for (let iy = 0; iy < ny; iy += 1) for (let ix = 0; ix < nx; ix += 1) {
        latticePoint(g, ix, iy, iz, p);
        const l = ix + iy * nx + iz * nx * ny;
        // A room's probe inside geometry (a slab through its wall, a pillar) is dropped as a brick's is: its rays start
        // in the solid, and what they hit faces out of the room, where the probes read there are the outside's.
        setProbe(g.at + l, `${g.key}#${l}`, p, p, g.room, 0, geometry?.solid.solid(p) === true, false);
      }
    }
    if (placed !== null) {
      for (let k = 0; k < placed.keys.length; k += 1) {
        if (k % PLACE_STEP_ITEMS === PLACE_STEP_ITEMS - 1) yield* step();
        const pt = placed.points.subarray(k * 3, k * 3 + 3);
        const st = placed.states[k]!;
        setProbe(roomProbes + k, placed.keys[k]!, placed.origins.subarray(k * 3, k * 3 + 3), pt, NO_ROOM, placed.levels[k]!, st === PROBE_PLACED_DROPPED, st === PROBE_PLACED_MOVED);
      }
    }
    yield* step();
    // Who holds each probe (a brick's face probes are its neighbours' too): their tiles take its changes.
    const holdersAt = new Uint32Array(count + 1);
    for (let k = 0; k < points; k += 1) holdersAt[lattice[k]! + 1]! += 1;
    for (let i = 0; i < count; i += 1) holdersAt[i + 1]! += holdersAt[i]!;
    const holders = new Uint32Array(points * 2);
    const fill = holdersAt.slice(0, count);
    grids.forEach((g, gi) => {
      const n = g.resolution[0] * g.resolution[1] * g.resolution[2];
      for (let l = 0; l < n; l += 1) {
        const at = fill[lattice[g.at + l]!]!++;
        holders[at * 2] = gi;
        holders[at * 2 + 1] = l;
      }
    });
    yield* step();
    const map = buildBrickMap(grids.slice(boxes.length).map((g, i) => ({ min: g.min, side: g.max[0] - g.min[0], id: boxes.length + i })));
    yield* step();
    // Put in at once: the kept probes take their light and stale state as they are now.
    const old = { state: this.state, stale: this.stale, since: this.since, marked: this.marked, changed: this.changed, count: this.count };
    /** Old probe → new, for those placed where they were. */
    const carried = new Map<number, number>();
    this.placedFor = key;
    this.grids = grids;
    this.roomGrids = boxes.length;
    this.lattice = lattice;
    this.map = map;
    this.state = new Float32Array(count * PROBE_FLOATS);
    this.positions = next.positions;
    this.reach = next.reach;
    this.rooms = next.rooms;
    this.keys = next.keys;
    this.stale = new Uint8Array(count);
    this.excluded = next.excluded;
    this.since = new Int32Array(count);
    this.marked = new Int32Array(count);
    this.staleCount = 0;
    this.words = null;
    let lit = 0;
    let moved = 0;
    for (let i = 0; i < count; i += 1) {
      if (next.excluded[i] === 1) continue;
      lit += 1;
      const was = next.was[i]!;
      if (was >= 0 && was < old.count) {
        carried.set(was, i);
        this.state.set(old.state.subarray(was * PROBE_FLOATS, (was + 1) * PROBE_FLOATS), i * PROBE_FLOATS);
        this.since[i] = old.since[was]!;
        this.marked[i] = old.marked[was]!;
        if (old.stale[was] === 1) {
          this.stale[i] = 1;
          this.staleCount += 1;
        }
      } else this.markProbe(i);
      this.state[i * PROBE_FLOATS + PROBE_MOVED_AT] = next.moved[i]!;
      moved += next.moved[i]!;
    }
    this.holdersAt = holdersAt;
    this.holders = holders;
    const bricks = [0, 0, 0];
    for (const g of grids) if (g.level >= 0) bricks[g.level]! += 1;
    this.counts = { bricks, lit, moved };
    this.layout += 1;
    // Changes not yet taken go on under the probes' new indices: tiles kept across the placement take them too.
    this.changed = new Set();
    for (const o of old.changed) {
      const i = carried.get(o);
      if (i !== undefined) this.changed.add(i);
    }
    this.queue.plans = PLAN_AHEAD;
    this.placeMs = busy + performance.now() - t0;
    return true;
  }

  get count(): number {
    return this.rooms.length;
  }

  private markProbe(i: number): void {
    if (this.excluded[i] === 1) return;
    if (this.stale[i] === 0) {
      this.stale[i] = 1;
      this.staleCount += 1;
      this.settling ??= -1;
    }
    this.since[i] = this.frame;
    this.marked[i] = 0;
  }

  /**
   * Probes placed and not yet updated take the light a bake saved for them
   * (`saved`: a grid's saved probes by its tile key, null where none match
   * its box and resolution): their light, the walls between them as cuts
   * along their axes (what the axis rays would have seen), settled. The
   * light of a probe already updated live is its own. Returns how many took
   * the saved light.
   */
  seed(saved: (key: string) => SavedProbeGrid | null): number {
    const fresh = new Uint8Array(this.count);
    for (let i = 0; i < this.count; i += 1) fresh[i] = this.excluded[i] === 0 && this.state[i * PROBE_FLOATS + PROBE_UPDATES_AT]! < 1 ? 1 : 0;
    const light = new Float32Array(12);
    const walls = new Float32Array(6);
    let n = 0;
    for (const g of this.grids) {
      const t = saved(liveProbeTileKey(g));
      if (t === null || [0, 1, 2].some((k) => t.resolution[k] !== g.resolution[k] || Math.abs(t.min[k]! - g.min[k]!) > 1e-4 || Math.abs(t.max[k]! - g.max[k]!) > 1e-4)) continue;
      const [nx, ny, nz] = g.resolution;
      const offset = [1, nx, nx * ny];
      for (let l = 0; l < nx * ny * nz; l += 1) {
        const i = this.lattice[g.at + l]!;
        if (fresh[i] === 0) continue;
        const got = t.read(l, light, walls);
        if (got === null) continue;
        const at = i * PROBE_FLOATS;
        if (this.state[at + PROBE_UPDATES_AT]! < 1) {
          this.state.set(light, at);
          this.state[at + PROBE_VALIDITY_AT] = got.filled ? 1 : 0;
          // As if updated often: a later update blends in at the least share.
          this.state[at + PROBE_UPDATES_AT] = PROBE_MIN_UPDATES;
          if (this.stale[i] === 1) {
            this.stale[i] = 0;
            this.staleCount -= 1;
          }
          this.changed.add(i);
          n += 1;
        }
        if (g.room !== NO_ROOM) continue;
        // A cut at share s of the edge to the next point: this probe saw a surface s along it, the next one 1 − s back.
        const p = [l % nx, Math.floor(l / nx) % ny, Math.floor(l / (nx * ny))];
        for (let a = 0; a < 3; a += 1) {
          if (!(walls[a * 2]! > 0.5) || p[a]! >= g.resolution[a]! - 1) continue;
          const next = this.lattice[g.at + l + offset[a]!]!;
          if (fresh[next] === 0) continue;
          const step = (g.max[a]! - g.min[a]!) / (g.resolution[a]! - 1);
          const share = Math.min(0.999, Math.max(0.001, walls[a * 2 + 1]!));
          this.state[at + PROBE_AXES_AT + a * 2] = share * step;
          this.state[next * PROBE_FLOATS + PROBE_AXES_AT + a * 2 + 1] = (1 - share) * step;
        }
      }
    }
    return n;
  }

  /**
   * Every probe starts over, stale: its next update's light replaces what it
   * held rather than being blended into it (at the least share a probe
   * updated often keeps most of its past, so light it saw before a change
   * lingers for many updates). The records go to the GPU again.
   */
  restart(): void {
    for (let i = 0; i < this.count; i += 1) {
      if (this.excluded[i] === 1) continue;
      const at = i * PROBE_FLOATS;
      this.state.fill(0, at, at + PROBE_UPDATES_AT + 1);
      this.markProbe(i);
      this.changed.add(i);
    }
    this.queue.plans = PLAN_AHEAD;
    this.layout += 1;
  }

  /** The probes in a box are stale (null: all of them). */
  markBox(min: readonly number[] | null, max: readonly number[] | null): void {
    // Newly marked probes may be nearer than the kept ordering's: order again.
    this.queue.plans = PLAN_AHEAD;
    const P = this.positions;
    for (let i = 0; i < this.count; i += 1) {
      if (min !== null && max !== null && (P[i * 3]! < min[0]! || P[i * 3]! > max[0]! || P[i * 3 + 1]! < min[1]! || P[i * 3 + 1]! > max[1]! || P[i * 3 + 2]! < min[2]! || P[i * 3 + 2]! > max[2]!)) continue;
      this.markProbe(i);
    }
  }

  get isSettled(): boolean {
    return this.staleCount === 0;
  }

  /**
   * This update's probes: stale ones nearest `eye` first (a waiting one's
   * distance halves every `PROBE_AGING_FRAMES`), as many as the budget
   * holds. Ordering every stale probe (tens of thousands in an open scene)
   * costs more main-thread time than the update it feeds, so one ordering
   * keeps the nearest `PLAN_AHEAD` updates' worth, and the next updates pick
   * among them while the eye stays within a probe spacing.
   */
  plan(eye: readonly number[], now: number): Uint32Array {
    this.frame += 1;
    if (this.settling === -1) this.settling = now;
    if (this.staleCount === 0 || this.budgetMs <= 0) return new Uint32Array(0);
    const q = this.queue;
    const near = Math.max(Math.abs(eye[0]! - q.eye[0]!), Math.abs(eye[1]! - q.eye[1]!), Math.abs(eye[2]! - q.eye[2]!)) <= this.spacing;
    if (q.plans < PLAN_AHEAD && near) {
      const out = this.takeQueued(this.perUpdate);
      if (out.length > 0) return out;
    }
    if (this.order.keys.length < this.staleCount) this.order = { keys: new Float32Array(this.count), order: new Uint32Array(this.count) };
    const { keys, order } = this.order;
    const P = this.positions;
    const [ex, ey, ez] = [eye[0]!, eye[1]!, eye[2]!];
    let n = 0;
    // Squared distances, aged by the square of the halving (the order is the same; tens of thousands may wait).
    for (let i = 0; i < this.count; i += 1) {
      if (this.stale[i] === 0) continue;
      const dx = P[i * 3]! - ex;
      const dy = P[i * 3 + 1]! - ey;
      const dz = P[i * 3 + 2]! - ez;
      keys[n] = (dx * dx + dy * dy + dz * dz) * agingOf(this.frame - this.since[i]!);
      order[n] = i;
      n += 1;
    }
    // The nearest few updates' worth (a selection, not a sort).
    const keep = Math.min(n, this.perUpdate * PLAN_AHEAD);
    selectSmallest(keys, order, n, keep);
    if (q.keys.length < keep) {
      q.keys = new Float32Array(keep);
      q.order = new Uint32Array(keep);
    }
    q.keys.set(keys.subarray(0, keep));
    q.order.set(order.subarray(0, keep));
    q.length = keep;
    q.plans = 0;
    q.eye = [ex, ey, ez];
    return this.takeQueued(this.perUpdate);
  }

  /** The nearest `take` of the kept ordering's probes still stale (as `plan` would pick among them; empty once none is). */
  private takeQueued(take: number): Uint32Array {
    const q = this.queue;
    q.plans += 1;
    let n = 0;
    for (let i = 0; i < q.length; i += 1) {
      if (this.stale[q.order[i]!] === 0) continue;
      q.keys[n] = q.keys[i]!;
      q.order[n] = q.order[i]!;
      n += 1;
    }
    q.length = n;
    const k = Math.min(take, n);
    if (k <= 0) return new Uint32Array(0);
    selectSmallest(q.keys, q.order, n, k);
    return q.order.slice(0, k);
  }

  /**
   * An update's results (`values`: the probes' new records, in `probes`
   * order): kept, and the probes whose light still moves stay stale with
   * their neighbours. `settledDirect`: the cache's direct light is settled
   * (until then every updated probe stays stale).
   */
  accept(probes: Uint32Array, values: Float32Array, settledDirect: boolean, now: number): void {
    this.updates += 1;
    const e0 = [0, 0, 0];
    const e1 = [0, 0, 0];
    const up = [0, 1, 0];
    for (let k = 0; k < probes.length; k += 1) {
      const i = probes[k]!;
      if (i >= this.count || this.excluded[i] === 1) continue;
      const at = i * PROBE_FLOATS;
      shIrradiance(this.state, at, up, e0);
      const had = this.state[at + PROBE_UPDATES_AT]!;
      this.state.set(values.subarray(k * PROBE_FLOATS, (k + 1) * PROBE_FLOATS), at);
      shIrradiance(this.state, at, up, e1);
      const before = e0[0]! + e0[1]! + e0[2]!;
      const after = e1[0]! + e1[1]! + e1[2]!;
      const share = Math.abs(after - before) / Math.max(after, before, 1e-6);
      this.changed.add(i);
      this.marked[i]! += 1;
      const done = (share <= PROBE_SETTLE_SHARE && this.marked[i]! >= PROBE_MIN_UPDATES) || this.marked[i]! >= PROBE_MAX_UPDATES;
      if (had >= 1 && done && settledDirect) {
        if (this.stale[i] === 1) {
          this.stale[i] = 0;
          this.staleCount -= 1;
        }
        continue;
      }
      if (this.stale[i] === 0) {
        this.stale[i] = 1;
        this.staleCount += 1;
      }
    }
    if (this.staleCount === 0 && this.settling !== null) {
      this.lastSettleMs = now - (this.settling < 0 ? now : this.settling);
      this.settling = null;
    }
  }

  /** The GPU time (ms) an update of `count` probes took: later updates take as many as the budget holds, at least `PROBE_MIN_COUNT`. */
  report(ms: number, count: number): void {
    if (!(count > 0) || !(ms >= 0)) return;
    this.msUsed = ms;
    const per = ms / count;
    this.msPerProbe = this.msPerProbe === null ? per : this.msPerProbe + (per - this.msPerProbe) * 0.25;
    this.perUpdate = Math.min(PROBE_MAX_COUNT, Math.max(PROBE_MIN_COUNT, Math.floor(this.budgetMs / Math.max(this.msPerProbe, 1e-9) / 64) * 64));
  }

  /** The probes whose records changed since the last call (their tiles take them again). */
  takeChangedProbes(): number[] {
    const out = [...this.changed];
    this.changed.clear();
    return out;
  }

  /** Probe `i`'s weight in the probe lighting (`liveProbeWeight`). */
  probeWeight(i: number): number {
    return liveProbeWeight(this.state, i * PROBE_FLOATS);
  }

  /** Whether probe `i` is lit at all (not dropped inside geometry, nor a brick's probe standing in a room). */
  probeLit(i: number): boolean {
    return this.excluded[i] === 0;
  }

  /** Whether probe `i` was moved out of geometry. */
  probeMoved(i: number): boolean {
    return this.state[i * PROBE_FLOATS + PROBE_MOVED_AT]! > 0;
  }

  /**
   * The walls of point `l` of grid `gi` (`out`: per axis the cut flag and
   * the cut's share of the edge to the next point along it), as `edgeWalls`
   * gives them from what its and that point's probes' axis rays saw; none in
   * a room's grid (a room's probes see only their room).
   */
  probeWalls(gi: number, l: number, out: number[]): number[] {
    out.fill(0);
    const g = this.grids[gi]!;
    if (g.room !== NO_ROOM) return out;
    const n = g.resolution;
    const at = [l % n[0], Math.floor(l / n[0]) % n[1], Math.floor(l / (n[0] * n[1]))];
    const offset = [1, n[0], n[0] * n[1]];
    const i = this.lattice[g.at + l]!;
    for (let a = 0; a < 3; a += 1) {
      if (at[a]! >= n[a]! - 1) continue;
      const step = (g.max[a]! - g.min[a]!) / (n[a]! - 1);
      const next = this.lattice[g.at + l + offset[a]!]!;
      const fromLo = this.state[i * PROBE_FLOATS + PROBE_AXES_AT + a * 2]!;
      const fromHi = this.state[next * PROBE_FLOATS + PROBE_AXES_AT + a * 2 + 1]!;
      if (!(fromLo > 0 && fromLo < step && fromHi > 0 && fromHi < step)) continue;
      out[a * 2] = 1;
      out[a * 2 + 1] = (fromLo / step + (1 - fromHi / step)) / 2;
    }
    return out;
  }

  /** The grids' table, the lattice and the brick map as the passes read them (made once a layout). */
  layoutWords(): ProbeLayoutWords {
    if (this.words !== null) return this.words;
    const map = this.map;
    const latticeAt = this.grids.length * GRID_WORDS;
    const mapAt = latticeAt + this.lattice.length;
    const cellsAt = mapAt + BRICK_MAP_WORDS;
    const entriesAt = cellsAt + map.cells.length;
    const u = new Uint32Array(entriesAt + map.entries.length);
    const f = new Float32Array(u.buffer);
    this.grids.forEach((g, k) => {
      const at = k * GRID_WORDS;
      f.set(g.min, at);
      f.set(g.max, at + 3);
      u.set(g.resolution, at + 6);
      u[at + 9] = latticeAt + g.at;
      u[at + 10] = g.room;
      u[at + 11] = g.level;
    });
    u.set(this.lattice, latticeAt);
    f.set(map.origin, mapAt);
    f[mapAt + 3] = map.top;
    u.set(map.dims, mapAt + 4);
    u[mapAt + 7] = cellsAt;
    u[mapAt + 8] = entriesAt;
    u.set(map.cells, cellsAt);
    for (let k = 0; k < map.entries.length; k += 1) u[entriesAt + k] = map.entries[k]! < 0 ? NO_BRICK_WORD : map.entries[k]!;
    this.words = { words: u, latticeAt, mapAt };
    return this.words;
  }

  diagnostics(): LiveProbeDiagnostics {
    const { bricks, lit, moved } = this.counts;
    return { grids: this.grids.length, bricks, probes: this.count, lit, moved, stale: this.staleCount, settled: this.staleCount === 0, perUpdate: this.perUpdate, msUsed: this.msUsed, lastSettleMs: this.lastSettleMs, updates: this.updates, placeMs: this.placeMs };
  }
}
