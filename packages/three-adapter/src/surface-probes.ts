/**
 * The live probes: bounced light at points of regular grids, kept up to date
 * from the surface cache (the probe pass, `surface-probe-pass.ts`, and its
 * CPU twin, `surface-probe-cpu.ts`, compute them; this holds where they
 * are, which wait for light, and what the probe lighting draws).
 *
 * - **Where.** The same places a probe bake puts them (project-model
 *   `placeProbeGrids`): a grid per room of generated architecture, inset
 *   from its walls, listed first, then grids over the static scene's bounds
 *   (snapped out to `PROBE_BOUNDS_SNAP`, so a scene streaming in does not
 *   move them). A probe belongs to its room (a room grid's probes to its
 *   room; the others to the room they stand in, or none). A probe of the
 *   outside's grids standing in a room is never lit (its room's grid holds
 *   that light): it would carry the room's light through the wall to the
 *   outside's points next to it.
 * - **Light.** Each update casts `PROBE_SH_RAYS` rays (a spherical
 *   Fibonacci set, turned at random each time) and `PROBE_AXIS_RAYS` along
 *   the axes. A ray that hits a static surface reads its cache texel's
 *   direct light and the probes' own light there (their last update), as a
 *   surface of albedo `BOUNCE_ALBEDO` reflects it; one that hits nothing
 *   sees the sky. Probes read probes, so bounces build up over updates. A
 *   probe in a room casts its rays only to the room's walls unless they
 *   leave by an open portal (`surface-rooms.ts`).
 * - **Walls.** For grids not in rooms (interiors of blocks or imported
 *   models), what the axis rays see gives each probe its walls
 *   (`edgeWalls`), which the probe lighting keeps samples on their side of.
 * - **Stale.** The cache's marks (`SurfaceRelight.onStale`) make the probes
 *   in their box stale; it stays stale for `PROBE_MIN_UPDATES` to
 *   `PROBE_MAX_UPDATES` updates, until one changes its light by less than
 *   `PROBE_SETTLE_SHARE`, and through any update while the cache's direct
 *   light is not settled. Stale probes are updated nearest the eye first.
 *
 * A probe's record (`PROBE_FLOATS`): its first-order spherical harmonics
 * (four RGB coefficients, as the probe lighting reads them: band 0, then
 * y, z, x), its share of rays meeting back faces and its update count,
 * then what its axis rays saw (+x −x +y −y +z −z; 0: nothing).
 *
 * Pure (no three.js, no device).
 */
import { PROBE_FILLED, PROBE_VALID, PROBE_VALIDITY_THRESHOLD, ROOM_PROBE_INSET, placeProbeGrids, type ProbeGridBox } from '@thirdlight/runtime';

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
/** How far a probe ray runs (probe spacings) before it is taken to see the sky. */
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
export const PROBE_MAX_UPDATES = 16;
/** Floats of a probe's record. */
export const PROBE_FLOATS = 24;
/** Words of a grid's record in the pass's words: min, max (f32), probes per axis, first probe, room. */
export const GRID_WORDS = 12;
/** The static scene's bounds are snapped out to this (m) before probes are placed over them. */
export const PROBE_BOUNDS_SNAP = 16;
/** The probe update's share of the live light's GPU time a frame (`surfaceLightMs`): medium's 1.5 ms gives the probes 0.5 ms. */
export const PROBE_BUDGET_SHARE = 1 / 3;
/** Probes an update takes before any cost is measured. */
export const PROBE_START_COUNT = 256;
/** Frames over which a waiting probe's distance halves when stale probes are ordered. */
const PROBE_AGING_FRAMES = 30;

/**
 * How far (m) a probe's rays start off its lattice point: lattice points
 * fall on block and grid boundaries, where a ray starting exactly on a face
 * would take either cell by a rounding.
 */
const PROBE_ORIGIN_NUDGE = [0.0013, 0.0017, 0.0011];

/** Index of the validity (back-face share) and the update count in a probe's record. */
export const PROBE_VALIDITY_AT = 12;
export const PROBE_UPDATES_AT = 13;
export const PROBE_AXES_AT = 16;

/** SH basis constants (band 0, band 1) and three's irradiance factors for them. */
export const SH_Y0 = 0.282095;
export const SH_Y1 = 0.488603;
export const SH_E0 = 0.886227;
export const SH_E1 = 1.023328;

export interface LiveProbeGrid extends ProbeGridBox {
  /** Stable while its box and probes stay (`min`, `max`, `resolution`). */
  readonly key: string;
  readonly first: number;
  /** The room its probes are in (`NO_ROOM`: not a room's grid). */
  readonly room: number;
}

/** A probe's irradiance at normal `n` from its record's coefficients (the probe lighting's sum). */
export function shIrradiance(rec: ArrayLike<number>, at: number, n: readonly number[], out: number[] = [0, 0, 0]): number[] {
  for (let c = 0; c < 3; c += 1) {
    out[c] = SH_E0 * rec[at + c]! + SH_E1 * (rec[at + 3 + c]! * n[1]! + rec[at + 6 + c]! * n[2]! + rec[at + 9 + c]! * n[0]!);
  }
  return out;
}

/** A probe's weight in the interpolation: none before its first update, little when it sits inside geometry. */
export function liveProbeWeight(rec: ArrayLike<number>, at: number): number {
  if (rec[at + PROBE_UPDATES_AT]! < 1) return 0;
  return rec[at + PROBE_VALIDITY_AT]! > PROBE_VALIDITY_THRESHOLD ? 1 / 64 : 1;
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

/** Where probe `i` of a grid stands (its lattice point). */
function latticePoint(g: ProbeGridBox, ix: number, iy: number, iz: number, out: number[]): void {
  const at = [ix, iy, iz];
  for (let a = 0; a < 3; a += 1) {
    const n = g.resolution[a]!;
    out[a] = n > 1 ? g.min[a]! + ((g.max[a]! - g.min[a]!) * at[a]!) / (n - 1) : g.min[a]!;
  }
}

/**
 * The irradiance (rgb) the probes give a point `q` facing `n`: the first
 * grid within `PROBE_HIT_LIFT` of it (a room's grid stands that far inside
 * its walls; outside its box only for a point in its room, `rooms` the
 * packed rooms), the point held inside it, trilinear between its probes by
 * their weights (0: no grid near, or none of its probes was updated).
 */
export function probesIrradianceAt(grids: readonly LiveProbeGrid[], state: Float32Array, q: readonly number[], n: readonly number[], out: number[] = [0, 0, 0], rooms: Uint32Array | null = null): number[] {
  out[0] = out[1] = out[2] = 0;
  const m = PROBE_HIT_LIFT;
  const g = grids.find((b) => {
    if (!(q[0]! >= b.min[0] - m && q[0]! <= b.max[0] + m && q[1]! >= b.min[1] - m && q[1]! <= b.max[1] + m && q[2]! >= b.min[2] - m && q[2]! <= b.max[2] + m)) return false;
    const inside = q[0]! >= b.min[0] && q[0]! <= b.max[0] && q[1]! >= b.min[1] && q[1]! <= b.max[1] && q[2]! >= b.min[2] && q[2]! <= b.max[2];
    return inside || b.room === NO_ROOM || (rooms !== null && roomHoldsCpu(rooms, b.room, q));
  });
  if (g === undefined) return out;
  const p = [0, 1, 2].map((a) => Math.min(g.max[a]!, Math.max(g.min[a]!, q[a]!)));
  const r = g.resolution;
  const f = [0, 1, 2].map((a) => (r[a]! > 1 ? ((p[a]! - g.min[a]!) / (g.max[a]! - g.min[a]!)) * (r[a]! - 1) : 0));
  const i0 = f.map((v, a) => Math.min(Math.max(0, Math.floor(v)), Math.max(0, r[a]! - 2)));
  const t = f.map((v, a) => (r[a]! > 1 ? Math.min(1, Math.max(0, v - i0[a]!)) : 0));
  const sh = new Array<number>(12).fill(0);
  let wsum = 0;
  for (let c = 0; c < 8; c += 1) {
    const ix = Math.min(r[0]! - 1, i0[0]! + (c & 1));
    const iy = Math.min(r[1]! - 1, i0[1]! + ((c >> 1) & 1));
    const iz = Math.min(r[2]! - 1, i0[2]! + ((c >> 2) & 1));
    const tri = (c & 1 ? t[0]! : 1 - t[0]!) * ((c >> 1) & 1 ? t[1]! : 1 - t[1]!) * ((c >> 2) & 1 ? t[2]! : 1 - t[2]!);
    const at = (g.first + ix + iy * r[0]! + iz * r[0]! * r[1]!) * PROBE_FLOATS;
    const w = tri * liveProbeWeight(state, at);
    if (w <= 0) continue;
    for (let k = 0; k < 12; k += 1) sh[k]! += state[at + k]! * w;
    wsum += w;
  }
  if (wsum <= 0) return out;
  for (let k = 0; k < 12; k += 1) sh[k]! /= wsum;
  shIrradiance(sh, 0, n, out);
  for (let c = 0; c < 3; c += 1) out[c] = Math.max(0, out[c]!);
  return out;
}

export interface LiveProbeDiagnostics {
  readonly grids: number;
  readonly probes: number;
  readonly stale: number;
  readonly settled: boolean;
  /** Probes an update takes now, and the last update's GPU time (ms; null: none measured). */
  readonly perUpdate: number;
  readonly msUsed: number | null;
  /** The last change's time until settled (ms) and updates (null: none yet). */
  readonly lastSettleMs: number | null;
  readonly updates: number;
}

export class LiveProbes {
  grids: LiveProbeGrid[] = [];
  /** Probe records (`PROBE_FLOATS` each): what the pass wrote, read back. */
  state = new Float32Array(0);
  positions = new Float32Array(0);
  rooms = new Uint32Array(0);
  /** Bumped when the grids were placed again (the pass uploads them and the probes start over). */
  layout = 0;
  private stale = new Uint8Array(0);
  /** Probes of the outside's grids standing in a room: never lit. */
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
  /** Grids whose probes changed since `takeChanged`. */
  private changed = new Set<number>();

  constructor(readonly spacing: number, private budgetMs: number) {}

  setBudget(ms: number): void {
    this.budgetMs = ms;
  }

  /**
   * Place the grids for the static scene's bounds (null: none) and the
   * rooms; nothing changes while the snapped bounds and the rooms stay.
   * True when they were placed again.
   */
  place(bounds: { min: readonly number[]; max: readonly number[] } | null, rooms: SurfaceRooms | null): boolean {
    const snap = (v: number, up: boolean): number => (up ? Math.ceil(v / PROBE_BOUNDS_SNAP) : Math.floor(v / PROBE_BOUNDS_SNAP)) * PROBE_BOUNDS_SNAP;
    const b = bounds === null ? null : { min: bounds.min.map((v, a) => (a === 1 ? Math.floor(v) : snap(v, false))), max: bounds.max.map((v, a) => (a === 1 ? Math.ceil(v) : snap(v, true))) };
    const roomBoxes = rooms === null ? [] : rooms.rooms.graph.rooms.map((r) => ({ min: [r.box[0] + ROOM_PROBE_INSET, r.floor + ROOM_PROBE_INSET, r.box[1] + ROOM_PROBE_INSET], max: [r.box[2] - ROOM_PROBE_INSET, r.top - ROOM_PROBE_INSET, r.box[3] - ROOM_PROBE_INSET] }));
    const key = JSON.stringify([b, roomBoxes]);
    if (key === this.placedFor) return false;
    this.placedFor = key;
    const roomTiles = roomBoxes.map((box, i) => ({ i, ok: box.max.every((v, a) => v > box.min[a]!) }));
    const boxes = placeProbeGrids(b, this.spacing, [], roomBoxes.filter((_, i) => roomTiles[i]!.ok));
    // A room's tiles come first, in its order: the grids of room i are those over its inset box.
    const owners = roomTiles.filter((r) => r.ok).map((r) => r.i);
    const old = new Map(this.grids.map((g) => [g.key, g]));
    const oldState = this.state;
    let first = 0;
    const grids: LiveProbeGrid[] = [];
    for (const box of boxes) {
      const ownerIdx = owners.findIndex((i) => {
        const rb = roomBoxes[i]!;
        return box.min.every((v, a) => v >= rb.min[a]! - 1e-6) && box.max.every((v, a) => v <= rb.max[a]! + 1e-6);
      });
      const room = ownerIdx >= 0 ? owners[ownerIdx]! : NO_ROOM;
      grids.push({ ...box, key: `${box.min.join(',')}|${box.max.join(',')}|${box.resolution.join(',')}|${room}`, first, room });
      first += box.resolution[0] * box.resolution[1] * box.resolution[2];
    }
    this.grids = grids;
    this.state = new Float32Array(first * PROBE_FLOATS);
    this.positions = new Float32Array(first * 3);
    this.rooms = new Uint32Array(first);
    this.stale = new Uint8Array(first);
    this.excluded = new Uint8Array(first);
    this.since = new Int32Array(first);
    this.marked = new Int32Array(first);
    this.staleCount = 0;
    const p = [0, 0, 0];
    for (const g of grids) {
      const [nx, ny, nz] = g.resolution;
      const was = old.get(g.key);
      if (was !== undefined) this.state.set(oldState.subarray(was.first * PROBE_FLOATS, (was.first + nx * ny * nz) * PROBE_FLOATS), g.first * PROBE_FLOATS);
      for (let iz = 0; iz < nz; iz += 1) for (let iy = 0; iy < ny; iy += 1) for (let ix = 0; ix < nx; ix += 1) {
        const i = g.first + ix + iy * nx + iz * nx * ny;
        latticePoint(g, ix, iy, iz, p);
        this.positions.set([p[0]! + PROBE_ORIGIN_NUDGE[0]!, p[1]! + PROBE_ORIGIN_NUDGE[1]!, p[2]! + PROBE_ORIGIN_NUDGE[2]!], i * 3);
        this.rooms[i] = g.room !== NO_ROOM ? g.room : (rooms?.roomAt(p) ?? NO_ROOM);
        if (g.room === NO_ROOM && this.rooms[i] !== NO_ROOM) {
          this.excluded[i] = 1;
          this.state.fill(0, i * PROBE_FLOATS, (i + 1) * PROBE_FLOATS);
          continue;
        }
        this.markProbe(i);
      }
    }
    this.layout += 1;
    this.changed = new Set(grids.map((_, k) => k));
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

  /** The probes in a box are stale (null: all of them). */
  markBox(min: readonly number[] | null, max: readonly number[] | null): void {
    const P = this.positions;
    for (let i = 0; i < this.count; i += 1) {
      if (min !== null && max !== null && (P[i * 3]! < min[0]! || P[i * 3]! > max[0]! || P[i * 3 + 1]! < min[1]! || P[i * 3 + 1]! > max[1]! || P[i * 3 + 2]! < min[2]! || P[i * 3 + 2]! > max[2]!)) continue;
      this.markProbe(i);
    }
  }

  get isSettled(): boolean {
    return this.staleCount === 0;
  }

  /** This update's probes: stale ones nearest `eye` first (a waiting one's distance halves every `PROBE_AGING_FRAMES`), as many as the budget holds. */
  plan(eye: readonly number[], now: number): Uint32Array {
    this.frame += 1;
    if (this.settling === -1) this.settling = now;
    if (this.staleCount === 0 || this.budgetMs <= 0) return new Uint32Array(0);
    const list: { i: number; k: number }[] = [];
    const P = this.positions;
    for (let i = 0; i < this.count; i += 1) {
      if (this.stale[i] === 0) continue;
      const d = Math.hypot(P[i * 3]! - eye[0]!, P[i * 3 + 1]! - eye[1]!, P[i * 3 + 2]! - eye[2]!);
      list.push({ i, k: d / 2 ** ((this.frame - this.since[i]!) / PROBE_AGING_FRAMES) });
    }
    list.sort((a, b) => a.k - b.k || a.i - b.i);
    return Uint32Array.from(list.slice(0, this.perUpdate).map((e) => e.i));
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
      const g = this.gridOf(i);
      this.changed.add(g);
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

  private gridOf(i: number): number {
    let lo = 0;
    let hi = this.grids.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (this.grids[mid]!.first <= i) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  }

  /** The GPU time (ms) an update of `count` probes took: later updates take as many as the budget holds. */
  report(ms: number, count: number): void {
    if (!(count > 0) || !(ms >= 0)) return;
    this.msUsed = ms;
    const per = ms / count;
    this.msPerProbe = this.msPerProbe === null ? per : this.msPerProbe + (per - this.msPerProbe) * 0.25;
    this.perUpdate = Math.min(4096, Math.max(64, Math.floor(this.budgetMs / Math.max(this.msPerProbe, 1e-9) / 64) * 64));
  }

  /** The grids whose probes changed since the last call (their tiles are drawn again). */
  takeChanged(): number[] {
    const out = [...this.changed].sort((a, b) => a - b);
    this.changed.clear();
    return out;
  }

  /** A grid's probes as the probe lighting draws them: 27 SH floats a probe (only the first band's 12 set), validity and walls. */
  tileOf(gi: number): { grid: LiveProbeGrid; sh: Float32Array; validity: Float32Array; walls: Float32Array } {
    const g = this.grids[gi]!;
    const n = g.resolution[0] * g.resolution[1] * g.resolution[2];
    const sh = new Float32Array(n * 27);
    const validity = new Float32Array(n);
    const along = new Float32Array(n * 6);
    for (let k = 0; k < n; k += 1) {
      const at = (g.first + k) * PROBE_FLOATS;
      sh.set(this.state.subarray(at, at + 12), k * 27);
      validity[k] = this.state[at + PROBE_UPDATES_AT]! < 1 || this.state[at + PROBE_VALIDITY_AT]! > PROBE_VALIDITY_THRESHOLD ? PROBE_FILLED : PROBE_VALID;
      along.set(this.state.subarray(at + PROBE_AXES_AT, at + PROBE_AXES_AT + 6), k * 6);
    }
    const walls = new Float32Array(n * 6);
    // A room's probes see only their room: no walls inside it.
    if (g.room === NO_ROOM) edgeWalls(g, along, walls);
    return { grid: g, sh, validity, walls };
  }

  /** The grids' table as the pass reads it (`GRID_WORDS` each). */
  gridWords(): Uint32Array {
    const u = new Uint32Array(this.grids.length * GRID_WORDS);
    const f = new Float32Array(u.buffer);
    this.grids.forEach((g, k) => {
      const at = k * GRID_WORDS;
      f.set(g.min, at);
      f.set(g.max, at + 3);
      u.set(g.resolution, at + 6);
      u[at + 9] = g.first;
      u[at + 10] = g.room;
    });
    return u;
  }

  diagnostics(): LiveProbeDiagnostics {
    return { grids: this.grids.length, probes: this.count, stale: this.staleCount, settled: this.staleCount === 0, perUpdate: this.perUpdate, msUsed: this.msUsed, lastSettleMs: this.lastSettleMs, updates: this.updates };
  }
}
