/**
 * The light volume's arithmetic on the CPU, for checks (not drawn): a model
 * of what the update computes, and a reference to hold it against.
 *
 * - **The update's model** ({@link volumeRayRadiance}, {@link VolumeUpdateModel}):
 *   a cell face's estimate as the WGSL update makes it (cosine-weighted rays
 *   from the cell's centre by the occupancy walk's light stop, the sky past
 *   the reach, a hit's bounce = its colour × (the sun and the lamps behind
 *   their walks + the volume's own light in the open cell before the hit) / π),
 *   blended into the face with the brick's weight and filtered among its
 *   neighbours as the pass writes it. A box of cells updated in turn shows what
 *   the volume converges to (bounces build over updates).
 * - **The reference** ({@link volumeReferenceFace}): the light arriving at a
 *   cell face by path tracing over the same voxels, sky, sun, lamps and
 *   colours, with as many bounces and as long a reach as asked (each bounce one
 *   cosine-weighted ray, the hit's direct light behind its walk). It never reads
 *   the volume, so it is what the volume would hold with no loss.
 *
 * Words of the lamp table, the sky's coefficients and the sun's words are the
 * GPU pass's own (`VolumeGpu`), so a page can run both on what it draws.
 */
import { CPU_SCALAR_OPS, mulberry32 } from '@thirdlight/shared';
import { OCCUPANCY, walkRay, walkVoxels, type WalkBlockView, type WalkSource } from '@thirdlight/voxel';

import { CLUSTER_RECT, CLUSTER_SPOT, CLUSTER_TWO_SIDED } from './cluster-build';
import { SH_Y0, SH_Y1 } from './surface-probes';
import { areaLightSteps, spotConeSteps } from './voxel-light-volume-terms';
import { VOLUME_FACES, VOLUME_LAMP_FLOATS, volumeBlendWeight, volumeCellHolds, volumeFilterShare } from './voxel-light-volume-layout';

type V3 = [number, number, number];
const O = CPU_SCALAR_OPS;

/** What the volume's light is made from: the voxels its rays walk, the sky, the sun, the lamps and the colours bounced. */
export interface VolumeLightWorld {
  readonly src: WalkSource;
  /** The sky's radiance as first-order SH, the pass's 12 words (rgb of the constant, then y, z, x). */
  readonly sky: ArrayLike<number>;
  /** Toward the sun (xyz), on (> 0.5), its colour × intensity (rgb): the pass's 7 words. */
  readonly sun: ArrayLike<number>;
  /** The lamp table (`VOLUME_LAMP_FLOATS` words a lamp) and its lamps. */
  readonly lamps: ArrayLike<number>;
  readonly lampCount: number;
  /** The colour (linear) bounced by the solid cell across face `face` (0 … 5) of open cell `air`. */
  albedo(air: readonly number[], face: number): readonly number[];
  /** The radiance (linear) the surface across face `face` of open cell `air` gives off (absent: nothing glows). */
  glow?(air: readonly number[], face: number): readonly number[];
  /** Far nodes walked where no level knows a place (the reference); the GPU's walk stops at the mips. */
  readonly far?: boolean;
}

/** Metres the reference's walks go: past it a ray counts as the sky (nothing the town holds is this far). */
export const VOLUME_REFERENCE_REACH_M = 4096;
/** Metres off a hit the next walk starts (the update's). */
const HIT_LIFT_M = 0.01;

/** The sky's radiance toward `d` (unit): the update's `sky_radiance`. */
export function volumeSkyRadiance(sky: ArrayLike<number>, d: readonly number[]): V3 {
  const out: V3 = [0, 0, 0];
  for (let k = 0; k < 3; k++) out[k] = Math.max(0, sky[k]! * SH_Y0 + (sky[3 + k]! * d[1]! + sky[6 + k]! * d[2]! + sky[9 + k]! * d[0]!) * SH_Y1);
  return out;
}

interface Hit {
  readonly t: number;
  /** The open cell in front of the face hit, the face's outward normal and the face's index in the open cell's six. */
  readonly air: V3;
  readonly n: V3;
  readonly face: number;
}

/** A walk from `p` along `d` (unit) up to `maxT` m: the face it stops at, or null (it reached the sky). */
function walkHit(w: VolumeLightWorld, p: readonly number[], d: readonly number[], maxT: number): Hit | null | 'lost' {
  const r = walkRay(p, d);
  if (r === null) return null;
  const res = walkVoxels(w.src, r, maxT, { stop: 'light', far: w.far === true });
  if (res.hit === null) return res.end === 'steps' ? 'lost' : null;
  const h = res.hit;
  // A ray that starts inside a stopping cell: no face (the update's `axis < 0`).
  if (h.normal[0] === 0 && h.normal[1] === 0 && h.normal[2] === 0) return 'lost';
  const n: V3 = [h.normal[0], h.normal[1], h.normal[2]];
  const axis = n[0] !== 0 ? 0 : n[1] !== 0 ? 1 : 2;
  return { t: h.t, air: [h.cell[0] + n[0], h.cell[1] + n[1], h.cell[2] + n[2]], n, face: axis * 2 + (n[axis]! < 0 ? 1 : 0) };
}

/** Whether nothing stops light from `p` along `d` within `maxT` m. */
function clear(w: VolumeLightWorld, p: readonly number[], d: readonly number[], maxT: number): boolean {
  const r = walkRay(p, d);
  if (r === null) return true;
  return walkVoxels(w.src, r, maxT, { stop: 'light', far: w.far === true }).hit === null;
}

/**
 * The sun's and the lamps' light on a surface at `p` facing `n` (unit), each behind its walk: the update's
 * `direct_light` over every lamp of the table (the update's lists hold the same lamps, those reaching the brick).
 * `xi` picks an area light's point; `sunReach` how far the walk toward the sun looks.
 */
export function volumeDirectLight(w: VolumeLightWorld, p: readonly number[], n: readonly number[], xi: readonly [number, number], sunReach: number): V3 {
  const e: V3 = [0, 0, 0];
  const q = [p[0]! + n[0]! * HIT_LIFT_M, p[1]! + n[1]! * HIT_LIFT_M, p[2]! + n[2]! * HIT_LIFT_M];
  const s = w.sun;
  const ns = n[0]! * s[0]! + n[1]! * s[1]! + n[2]! * s[2]!;
  if (s[3]! > 0.5 && ns > 0 && clear(w, q, [s[0]!, s[1]!, s[2]!], sunReach)) for (let k = 0; k < 3; k++) e[k] = e[k]! + s[4 + k]! * ns;
  const L = w.lamps;
  for (let i = 0; i < w.lampCount; i++) {
    const o = i * VOLUME_LAMP_FLOATS;
    const to = [L[o]! - p[0]!, L[o + 1]! - p[1]!, L[o + 2]! - p[2]!];
    const d = Math.hypot(to[0]!, to[1]!, to[2]!);
    const reach = L[o + 3]!;
    if (d >= reach) continue;
    const field = L[o + 11]!;
    let way: number[];
    let len: number;
    let lit: number;
    if ((field & 3) >= CLUSTER_RECT) {
      const u: V3 = [L[o + 12]!, L[o + 13]!, L[o + 14]!];
      const v: V3 = [L[o + 16]!, L[o + 17]!, L[o + 18]!];
      const f = areaLightSteps(O, p as V3, n as V3, [L[o]!, L[o + 1]!, L[o + 2]!], u, v, (field & CLUSTER_TWO_SIDED) !== 0 ? 1 : 0, reach);
      if (f <= 0) continue;
      const at = [0, 1, 2].map((a) => L[o + a]! + u[a]! * (2 * xi[0] - 1) + v[a]! * (2 * xi[1] - 1) - q[a]!);
      const ds = Math.hypot(at[0]!, at[1]!, at[2]!);
      way = at.map((x) => x / Math.max(ds, 1e-3));
      len = ds > 1e-3 ? Math.max(ds - 0.3, 0) : 0;
      lit = Math.PI * f;
    } else {
      if (d < 1e-3) continue;
      const l = to.map((x) => x / d);
      const nl = n[0]! * l[0]! + n[1]! * l[1]! + n[2]! * l[2]!;
      if (nl <= 0) continue;
      const r = d / reach;
      const win = Math.min(Math.max(1 - r * r * r * r, 0), 1);
      let fall = (win * win) / Math.max(d ** L[o + 7]!, 0.01);
      if ((field & 3) === CLUSTER_SPOT) {
        fall *= spotConeSteps(O, -(l[0]! * L[o + 8]! + l[1]! * L[o + 9]! + l[2]! * L[o + 10]!), L[o + 15]!, L[o + 19]!);
        if (fall <= 0) continue;
      }
      way = l;
      len = Math.max(d - 0.3, 0);
      lit = fall * nl;
    }
    if (!clear(w, q, way, len)) continue;
    for (let k = 0; k < 3; k++) e[k] = e[k]! + L[o + 4 + k]! * lit;
  }
  return e;
}

/** A direction over the hemisphere round face `face`'s axis and sign, cosine-weighted, from (u, v) in [0, 1)² (the update's). */
export function volumeFaceDirection(face: number, u: number, v: number): V3 {
  const axis = face >> 1;
  const sgn = (face & 1) === 1 ? -1 : 1;
  const r = Math.sqrt(u);
  const th = 2 * Math.PI * v;
  const d: V3 = [0, 0, 0];
  d[axis] = sgn * Math.sqrt(Math.max(1 - u, 0));
  d[(axis + 1) % 3] = r * Math.cos(th);
  d[(axis + 2) % 3] = r * Math.sin(th);
  return d;
}

/** A cosine-weighted direction round unit normal `n` (an axis normal: a face's). */
function cosineRound(n: readonly number[], u: number, v: number): V3 {
  const axis = n[0] !== 0 ? 0 : n[1] !== 0 ? 1 : 2;
  return volumeFaceDirection(axis * 2 + (n[axis]! < 0 ? 1 : 0), u, v);
}

/** The volume's own light a model of it holds at face `face` of open cell `air` (0 where none is held). */
export type VolumeHeldLight = (air: readonly number[], face: number) => readonly number[] | null;

/** Where a ray of the update's model ended: the sky (past the reach or out of the world), a face, or lost (out of steps, inside). */
export type VolumeRayEnd = 'sky' | 'hit' | 'lost';

/**
 * The radiance a ray of the update sees (its WGSL `ray_radiance`): the sky past `reach`, else what the face it meets
 * gives off and its bounce: its glow + its colour × (direct light + the volume's own light there) / π.
 */
export function volumeRayRadiance(w: VolumeLightWorld, p: readonly number[], d: readonly number[], reach: number, held: VolumeHeldLight, xi: readonly [number, number], sunReach: number, ends?: Record<VolumeRayEnd, number>): V3 {
  const h = walkHit(w, p, d, reach);
  if (h === null) {
    if (ends !== undefined) ends.sky++;
    return volumeSkyRadiance(w.sky, d);
  }
  if (h === 'lost') {
    if (ends !== undefined) ends.lost++;
    return [0, 0, 0];
  }
  if (ends !== undefined) ends.hit++;
  const hp = [p[0]! + d[0]! * h.t, p[1]! + d[1]! * h.t, p[2]! + d[2]! * h.t];
  const e = volumeDirectLight(w, hp, h.n, xi, sunReach);
  const v = held(h.air, h.face);
  const a = w.albedo(h.air, h.face);
  const g = w.glow?.(h.air, h.face) ?? null;
  return [0, 1, 2].map((k) => (g?.[k] ?? 0) + (a[k]! * (e[k]! + (v?.[k] ?? 0))) / Math.PI) as V3;
}

/** What the reference counts as it traces (rays, where they ended, hits lit by the sun). */
export interface VolumeReferenceCounts {
  rays: number;
  sky: number;
  lost: number;
  hits: number;
  /** First hits farther than the update's reach (the update sees the sky there). */
  past: number;
  sunLit: number;
}

/** The reference's choices: rays a face, bounces past the first hit, the walks' reach, the sun walk's, and a seed. */
export interface VolumeReferenceOptions {
  readonly rays: number;
  readonly bounces: number;
  readonly reach?: number;
  readonly sunReach?: number;
  /** Metres past which a first hit counts as "past the update's reach" in the counts (the update's reach). */
  readonly updateReach?: number;
  readonly seed?: number;
}

/**
 * The radiance a path from `p` along `d` brings (path tracing): the sky where nothing stops it within the reach, else
 * what the face gives off + its colour × (its direct light + π × the radiance one cosine-weighted ray from it brings,
 * while bounces are left) / π.
 */
function tracePath(w: VolumeLightWorld, p: readonly number[], d: readonly number[], bounces: number, o: Required<VolumeReferenceOptions>, rnd: () => number, counts: VolumeReferenceCounts | null): V3 {
  const h = walkHit(w, p, d, o.reach);
  if (h === null) {
    if (counts !== null) counts.sky++;
    return volumeSkyRadiance(w.sky, d);
  }
  if (h === 'lost') {
    if (counts !== null) counts.lost++;
    return [0, 0, 0];
  }
  if (counts !== null) {
    counts.hits++;
    if (h.t > o.updateReach) counts.past++;
  }
  const hp = [p[0]! + d[0]! * h.t, p[1]! + d[1]! * h.t, p[2]! + d[2]! * h.t];
  const e = volumeDirectLight(w, hp, h.n, [rnd(), rnd()], o.sunReach);
  if (counts !== null && w.sun[3]! > 0.5) {
    const ns = h.n[0] * w.sun[0]! + h.n[1] * w.sun[1]! + h.n[2] * w.sun[2]!;
    const q = hp.map((x, a) => x + h.n[a]! * HIT_LIFT_M);
    if (ns > 0 && clear(w, q, [w.sun[0]!, w.sun[1]!, w.sun[2]!], o.sunReach)) counts.sunLit++;
  }
  if (bounces > 0) {
    const q = hp.map((x, a) => x + h.n[a]! * HIT_LIFT_M);
    const li = tracePath(w, q, cosineRound(h.n, rnd(), rnd()), bounces - 1, o, rnd, null);
    for (let k = 0; k < 3; k++) e[k] = e[k]! + Math.PI * li[k]!;
  }
  const a = w.albedo(h.air, h.face);
  const g = w.glow?.(h.air, h.face) ?? null;
  return [0, 1, 2].map((k) => (g?.[k] ?? 0) + (a[k]! * e[k]!) / Math.PI) as V3;
}

/**
 * The light arriving at face `face` of level-0 cell `cell` (irradiance, rgb): π × the mean radiance of `rays`
 * cosine-weighted paths from the cell's centre, each with `bounces` bounces past its first hit.
 */
export function volumeReferenceFace(w: VolumeLightWorld, cell: readonly number[], face: number, opts: VolumeReferenceOptions, counts?: VolumeReferenceCounts): V3 {
  const o: Required<VolumeReferenceOptions> = { reach: VOLUME_REFERENCE_REACH_M, sunReach: VOLUME_REFERENCE_REACH_M, updateReach: Infinity, seed: 1, ...opts };
  const rnd = mulberry32((o.seed * 0x9e3779b1 + cell[0]! * 73856093 + cell[1]! * 19349663 + cell[2]! * 83492791 + face * 2654435761) >>> 0);
  const p = [(cell[0]! + 0.5) * 0.5, (cell[1]! + 0.5) * 0.5, (cell[2]! + 0.5) * 0.5];
  const sum: V3 = [0, 0, 0];
  for (let r = 0; r < o.rays; r++) {
    const c = tracePath(w, p, volumeFaceDirection(face, rnd(), rnd()), o.bounces, o, rnd, counts ?? null);
    for (let k = 0; k < 3; k++) sum[k] = sum[k]! + c[k]!;
  }
  if (counts !== undefined) counts.rays += o.rays;
  return sum.map((x) => (Math.PI * x) / Math.max(o.rays, 1)) as V3;
}

// ---------------------------------------------------------------------------------------------------------------
// The update over a box of cells

/** The four cells beside a cell along the surface of face `face` (the filter's neighbours: the two axes across the face's). */
export function volumeFilterNeighbours(c: readonly number[], face: number): V3[] {
  const axis = face >> 1;
  const out: V3[] = [];
  for (const t of [(axis + 1) % 3, (axis + 2) % 3]) for (const s of [1, -1]) {
    const n: V3 = [c[0]!, c[1]!, c[2]!];
    n[t] = n[t]! + s;
    out.push(n);
  }
  return out;
}

/**
 * The update's write of one face (channel by channel): its estimate blended into its old light, then filtered with its
 * same-face neighbours' light as held (both are means of the same age, so a field that is the same everywhere stays
 * as it is: the filter moves no energy while bounces build).
 */
export function volumeWriteFace(est: readonly number[], old: readonly number[] | null, neighbours: readonly (readonly number[])[], updates: number, blendOf: (u: number) => number = volumeBlendWeight): V3 {
  const a = volumeFilterShare(updates);
  const blend = blendOf(updates);
  const out: V3 = [0, 0, 0];
  for (let k = 0; k < 3; k++) {
    let s = 0;
    for (const n of neighbours) s += n[k]!;
    // A first update (weight 1) replaces what was held: the filter then sets it against its own estimate.
    const was = old === null || blend >= 1 ? est[k]! : old[k]!;
    const v = was + (est[k]! - was) * blend;
    // The neighbours' light against the face's own as held (the same age), so a field that is the same everywhere stays.
    out[k] = Math.max(0, v + (a * (s - neighbours.length * was)) / (1 + a * neighbours.length));
  }
  return out;
}

const key = (x: number, y: number, z: number): string => `${x},${y},${z}`;

/**
 * The update's model over every level-0 cell holding light in a box (one brick's weight for all of them): each
 * {@link step} updates every cell's six faces once from what the cells held before the step (a dispatch whose
 * neighbours' light is last frame's), with the update's rays (`rays` a face), reach, filter and blend.
 */
export class VolumeUpdateModel {
  readonly cells = new Map<string, { c: V3; faces: (V3 | null)[] }>();
  updates = 0;

  constructor(
    private readonly w: VolumeLightWorld,
    lo: readonly number[],
    hi: readonly number[],
    private readonly opts: { rays: number; reach: number; sunReach: number; filter: boolean; seed?: number; blendOf?: (u: number) => number },
  ) {
    for (let x = lo[0]!; x < hi[0]!; x++) for (let y = lo[1]!; y < hi[1]!; y++) for (let z = lo[2]!; z < hi[2]!; z++) if (volumeCellHolds(w.src, x, y, z)) this.cells.set(key(x, y, z), { c: [x, y, z], faces: Array.from({ length: VOLUME_FACES }, () => null) });
  }

  /** A face's light held (null: not a cell holding light, or not lit yet). */
  held: VolumeHeldLight = (c, f) => this.cells.get(key(c[0]!, c[1]!, c[2]!))?.faces[f] ?? null;

  /** One update of every cell. */
  step(): void {
    const next = new Map<string, (V3 | null)[]>();
    const { rays, reach, sunReach, filter } = this.opts;
    for (const [k, cell] of this.cells) {
      const faces: (V3 | null)[] = [];
      const p = cell.c.map((v) => (v + 0.5) * 0.5);
      for (let f = 0; f < VOLUME_FACES; f++) {
        const sum: V3 = [0, 0, 0];
        const rnd = mulberry32(((this.opts.seed ?? 0) * 104729 + this.updates * 7919 + cell.c[0] * 73856093 + cell.c[1] * 19349663 + cell.c[2] * 83492791 + f * 2654435761) >>> 0);
        for (let r = 0; r < rays; r++) {
          const c = volumeRayRadiance(this.w, p, volumeFaceDirection(f, rnd(), rnd()), reach, this.held, [rnd(), rnd()], sunReach);
          for (let ch = 0; ch < 3; ch++) sum[ch] = sum[ch]! + c[ch]!;
        }
        const est = sum.map((x) => (Math.PI * x) / rays);
        const nb = filter ? volumeFilterNeighbours(cell.c, f).map((n) => this.held(n, f)).filter((v): v is V3 => v !== null) : [];
        faces.push(volumeWriteFace(est, cell.faces[f] ?? null, nb, this.updates, this.opts.blendOf));
      }
      next.set(k, faces);
    }
    for (const [k, faces] of next) this.cells.get(k)!.faces = faces;
    this.updates++;
  }
}

/** A level-0 walk source of 32³ blocks over a cell predicate (light and solid alike), known in blocks `[lo, hi)`. */
export function volumePredicateSource(solid: (x: number, y: number, z: number) => boolean, lo: readonly number[], hi: readonly number[]): WalkSource {
  const cache = new Map<string, WalkBlockView>();
  return {
    maxLevel: 0,
    blockShift: () => 5,
    block: (_level, bx, by, bz) => {
      if (bx < lo[0]! || by < lo[1]! || bz < lo[2]! || bx >= hi[0]! || by >= hi[1]! || bz >= hi[2]!) return null;
      const k = key(bx, by, bz);
      const had = cache.get(k);
      if (had !== undefined) return had;
      const cells = new Uint8Array(32 ** 3);
      let n = 0;
      for (let x = 0; x < 32; x++) for (let z = 0; z < 32; z++) for (let y = 0; y < 32; y++) {
        const s = solid(bx * 32 + x, by * 32 + y, bz * 32 + z);
        cells[(x * 32 + z) * 32 + y] = s ? 1 : 0;
        if (s) n++;
      }
      const bricks = new Uint8Array(512);
      for (let i = 0; i < 512; i++) {
        const [x0, y0, z0] = [Math.floor(i / 64), i % 8, Math.floor(i / 8) % 8];
        let m = 0;
        for (let x = 0; x < 4; x++) for (let z = 0; z < 4; z++) for (let y = 0; y < 4; y++) m += cells[((x0 * 4 + x) * 32 + z0 * 4 + z) * 32 + y0 * 4 + y]!;
        bricks[i] = m === 0 ? OCCUPANCY.empty : OCCUPANCY.mixed;
      }
      const v: WalkBlockView = { flag: n === 0 ? OCCUPANCY.empty : n === 32 ** 3 ? OCCUPANCY.solid : OCCUPANCY.mixed, brick: (i) => bricks[i]!, cell: (i) => cells[i] === 1 };
      cache.set(k, v);
      return v;
    },
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Cells of a room to check

/** A cell face to check: what it is, the level-0 cell and the face looking into the room. */
export interface VolumeCheckCell {
  readonly name: string;
  readonly cell: V3;
  readonly face: number;
}

/**
 * The cells of the room round `eye` (metres) a check reads: the floor under the eye and on a grid round it (the
 * floor's up face), the four walls along the axes and the ceiling (their faces into the room), each the open cell in
 * front of what a walk from the eye meets within `within` metres; floor points whose way up meets nothing within it
 * (outside the room) are left out.
 */
export function volumeRoomCells(src: WalkSource, eye: readonly number[], within = 12, step = 1.5, span = 3): VolumeCheckCell[] {
  const w: VolumeLightWorld = { src, sky: [], sun: [], lamps: [], lampCount: 0, albedo: () => [0, 0, 0] };
  const out: VolumeCheckCell[] = [];
  const at = (name: string, p: readonly number[], d: readonly number[]): void => {
    const h = walkHit(w, p, d, within);
    if (h !== null && h !== 'lost') out.push({ name, cell: h.air, face: h.face });
  };
  at('floor under the eye', eye, [0, -1, 0]);
  at('ceiling', eye, [0, 1, 0]);
  for (const [name, d] of [['wall +x', [1, 0, 0]], ['wall -x', [-1, 0, 0]], ['wall +z', [0, 0, 1]], ['wall -z', [0, 0, -1]]] as const) at(name, eye, d);
  const seen = new Set(out.map((c) => c.cell.join(',')));
  for (let dx = -span; dx <= span + 1e-9; dx += step) for (let dz = -span; dz <= span + 1e-9; dz += step) {
    if (Math.abs(dx) < 1e-9 && Math.abs(dz) < 1e-9) continue;
    const p = [eye[0]! + dx, eye[1]!, eye[2]! + dz];
    const up = walkHit(w, p, [0, 1, 0], within);
    if (up === null || up === 'lost' || up.t <= 0) continue;
    const h = walkHit(w, p, [0, -1, 0], within);
    if (h === null || h === 'lost' || seen.has(h.air.join(','))) continue;
    seen.add(h.air.join(','));
    out.push({ name: `floor ${dx},${dz}`, cell: h.air, face: h.face });
  }
  return out;
}
