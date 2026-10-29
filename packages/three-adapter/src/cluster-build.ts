/**
 * Clustered light lists, built on the CPU: which local lights can reach each
 * cell ("froxel") of a fixed grid over the camera's view, for every renderer
 * alike (`cluster-pack.ts` lays the result out in the data textures the
 * light loop reads).
 *
 * - **The grid** has a fixed number of cells, not a fixed pixel size:
 *   {@link CLUSTER_TILES_X} tiles across, as many rows as keep the tiles
 *   about square (16 × round(16 / aspect)), and {@link CLUSTER_SLICES}
 *   exponential depth slices. A pixel finds its tile from where it is on the
 *   screen as a share of the render size, so the render scale, dynamic
 *   resolution and TAAU change nothing and nothing resizes. The slices run
 *   from `max(near, CLUSTER_SLICE_NEAR)` to the farthest packed light's
 *   reach (no farther than the camera's far): nearer pixels use slice 0,
 *   farther ones get no local light.
 * - **One build a frame**, pure, its typed arrays kept between frames: (1) lights
 *   switched off or in a room no portal shows (the caller's `visible`) and
 *   lights whose bounds miss the view are not packed; (2) the rest are
 *   ranked by brightness × size on screen, the nearest first whatever its
 *   brightness; (3) each light's bounds give a range of slices and, per
 *   slice, of tiles, and every cell in it gets an exact test (sphere against
 *   the cell's box for a point; that and the cone against the cell's sphere
 *   for a spot; the emitting box against the cell's box for an area light);
 *   (4) the count pass here, the prefix sum and the index writes in
 *   `cluster-pack.ts`.
 * - **A memory budget, not a count.** A frame's headers and lists fit in
 *   `maxWords` (`cluster-pack.ts`'s `CLUSTER_INDEX_WORDS`): each cell's
 *   header and the count word a long list may need come off it first.
 *   Lights are listed best rank first, so when a frame does not fit, the
 *   lowest-ranked lights are left out of the cells that did not fit
 *   (`overflow` counts them). No cell has a cap of its own.
 *
 * Every test is conservative: a cell any point of a light's volume reaches
 * lists the light (the vitest suite checks this against brute force); a few
 * cells it does not reach may list it too, which costs the light loop one
 * range test there.
 *
 * Projections are three's (perspective or orthographic, off-axis allowed):
 * view x depends on the clip x row only, y on the clip y row, w on z.
 */
import { LIGHT_LAYERS_ALL } from '@thirdlight/runtime';

import { LINE_HIGHLIGHT_METRES } from './surface-highlights';

/** Tiles across the screen; the rows follow the aspect. */
export const CLUSTER_TILES_X = 16;
/** Exponential depth slices. */
export const CLUSTER_SLICES = 24;
/** The view depth (m) the first slice ends at no nearer than (a nearer camera near plane would spend slices on centimetres). */
export const CLUSTER_SLICE_NEAR = 0.25;

/** A record's kind (the low two bits of its kind field). */
export const CLUSTER_POINT = 0;
export const CLUSTER_SPOT = 1;
export const CLUSTER_RECT = 2;
export const CLUSTER_LINE = 3;
/** The kind field's bit for an area light emitting on both sides. */
export const CLUSTER_TWO_SIDED = 4;

export type ClusterLightKind = 'point' | 'spot' | 'rect' | 'line';

/** One light as the caller describes it (world space). */
export interface ClusterLightValue {
  kind: ClusterLightKind;
  position: ArrayLike<number>;
  /** Metres the light reaches (from its centre; an area light: from its emitting surface). */
  reach: number;
  /** Linear colour × intensity. */
  color: ArrayLike<number>;
  decay?: number;
  /** A spot's unit axis (the way it shines); an area light's unit facing. */
  direction?: ArrayLike<number>;
  /** A spot's cone: cos of its outer and inner half-angles. */
  cosOuter?: number;
  cosInner?: number;
  /** An area light's half sides (a line: `u` only). */
  u?: ArrayLike<number>;
  v?: ArrayLike<number>;
  twoSided?: boolean;
  /** The light layers it lights (default every layer). */
  mask?: number;
  /** Its shadow record's first texel in the light records and its cookie's tile (-1: none). */
  shadow?: number;
  cookie?: number;
  /** False: off, or in a room no portal shows (not packed). */
  visible?: boolean;
}

/**
 * The lights a build reads, as arrays (filled each frame with `clear` and
 * `add`, or written in place). Area lights are stored with `u × v` along
 * their facing; a line's `v` is the thin strip across it.
 */
export class ClusterLights {
  count = 0;
  position = new Float64Array(0);
  reach = new Float32Array(0);
  color = new Float32Array(0);
  kind = new Uint8Array(0);
  decay = new Float32Array(0);
  /** A spot's axis; an area light's facing. */
  direction = new Float32Array(0);
  u = new Float32Array(0);
  v = new Float32Array(0);
  /** cos outer, cos inner. */
  cone = new Float32Array(0);
  mask = new Uint32Array(0);
  shadow = new Int32Array(0);
  cookie = new Int32Array(0);
  visible = new Uint8Array(0);

  clear(): void {
    this.count = 0;
  }

  /** Append a light; its slot. */
  add(l: ClusterLightValue): number {
    const i = this.count;
    if (i >= this.kind.length) this.grow(Math.max(16, this.kind.length * 2));
    this.count += 1;
    const k = l.kind === 'point' ? CLUSTER_POINT : l.kind === 'spot' ? CLUSTER_SPOT : l.kind === 'rect' ? CLUSTER_RECT : CLUSTER_LINE;
    this.kind[i] = k | (k >= CLUSTER_RECT && l.twoSided === true ? CLUSTER_TWO_SIDED : 0);
    for (let a = 0; a < 3; a += 1) {
      this.position[i * 3 + a] = l.position[a] ?? 0;
      this.color[i * 3 + a] = l.color[a] ?? 0;
      this.direction[i * 3 + a] = l.direction?.[a] ?? (a === 1 ? -1 : 0);
      this.u[i * 3 + a] = l.u?.[a] ?? 0;
      this.v[i * 3 + a] = l.v?.[a] ?? 0;
    }
    this.reach[i] = Math.max(0, l.reach);
    this.decay[i] = l.decay ?? 2;
    this.cone[i * 2] = l.cosOuter ?? -1;
    this.cone[i * 2 + 1] = l.cosInner ?? -1;
    this.mask[i] = l.mask ?? LIGHT_LAYERS_ALL;
    this.shadow[i] = l.shadow ?? -1;
    this.cookie[i] = l.cookie ?? -1;
    this.visible[i] = l.visible === false ? 0 : 1;
    if (k >= CLUSTER_RECT) this.orientArea(i, k === CLUSTER_LINE);
    return i;
  }

  /** `u × v` along the facing; a line's `v` the strip across it in the plane its facing is the normal of. */
  private orientArea(i: number, line: boolean): void {
    const d = this.direction;
    const u = this.u;
    const v = this.v;
    const o = i * 3;
    const fx = d[o]!;
    const fy = d[o + 1]!;
    const fz = d[o + 2]!;
    if (line || Math.hypot(v[o]!, v[o + 1]!, v[o + 2]!) < 1e-6) {
      let cx = fy * u[o + 2]! - fz * u[o + 1]!;
      let cy = fz * u[o]! - fx * u[o + 2]!;
      let cz = fx * u[o + 1]! - fy * u[o]!;
      const lc = Math.hypot(cx, cy, cz) || 1;
      const h = LINE_HIGHLIGHT_METRES / 2 / lc;
      cx *= h;
      cy *= h;
      cz *= h;
      v[o] = cx;
      v[o + 1] = cy;
      v[o + 2] = cz;
    }
    const nx = u[o + 1]! * v[o + 2]! - u[o + 2]! * v[o + 1]!;
    const ny = u[o + 2]! * v[o]! - u[o]! * v[o + 2]!;
    const nz = u[o]! * v[o + 1]! - u[o + 1]! * v[o]!;
    if (nx * fx + ny * fy + nz * fz < 0) for (let a = 0; a < 3; a += 1) v[o + a] = -v[o + a]!;
  }

  private grow(n: number): void {
    const f64 = (a: Float64Array, w: number): Float64Array<ArrayBuffer> => {
      const next = new Float64Array(n * w);
      next.set(a);
      return next;
    };
    const f32 = (a: Float32Array, w: number): Float32Array<ArrayBuffer> => {
      const next = new Float32Array(n * w);
      next.set(a);
      return next;
    };
    const u8 = (a: Uint8Array): Uint8Array<ArrayBuffer> => {
      const next = new Uint8Array(n);
      next.set(a);
      return next;
    };
    const i32 = (a: Int32Array): Int32Array<ArrayBuffer> => {
      const next = new Int32Array(n);
      next.set(a);
      return next;
    };
    this.position = f64(this.position, 3);
    this.reach = f32(this.reach, 1);
    this.color = f32(this.color, 3);
    this.kind = u8(this.kind);
    this.decay = f32(this.decay, 1);
    this.direction = f32(this.direction, 3);
    this.u = f32(this.u, 3);
    this.v = f32(this.v, 3);
    this.cone = f32(this.cone, 2);
    const mask = new Uint32Array(n);
    mask.set(this.mask);
    this.mask = mask;
    this.shadow = i32(this.shadow);
    this.cookie = i32(this.cookie);
    this.visible = u8(this.visible);
  }
}

/** The camera a grid is built for: three's `matrixWorldInverse` and `projectionMatrix` elements (column-major). */
export interface ClusterCamera {
  view: ArrayLike<number>;
  projection: ArrayLike<number>;
  near: number;
  far: number;
}

/** This frame's grid, as the shader reads it. */
export interface ClusterGrid {
  tilesX: number;
  tilesY: number;
  slices: number;
  /** tilesX × tilesY × slices; also where the index lists start in the cluster texture. */
  clusters: number;
  /** The slices' depth range (m): slice 0 ends at `sliceNear`'s next plane, the last at `sliceFar`. */
  sliceNear: number;
  sliceFar: number;
  /** slice = floor(log2(viewDepth) × scale + bias). */
  scale: number;
  bias: number;
}

/** The rows of tiles for an aspect (width / height). */
export function clusterTilesY(aspect: number): number {
  return Math.max(1, Math.round(CLUSTER_TILES_X / (aspect > 0 && Number.isFinite(aspect) ? aspect : 1)));
}

/** The cell index of a cell's tile and slice. */
export function clusterIndex(grid: ClusterGrid, tileX: number, tileY: number, slice: number): number {
  return tileX + grid.tilesX * (tileY + grid.tilesY * slice);
}

/** The slice a view depth (m, positive) falls in: 0 for anything nearer, -1 past the last. */
export function clusterSliceOf(grid: ClusterGrid, depth: number): number {
  const s = Math.floor(Math.log2(Math.max(depth, 1e-30)) * grid.scale + grid.bias);
  return s < 0 ? 0 : s >= grid.slices ? -1 : s;
}

/** Relative padding of every cell's box: float rounding at a plane must not lose a pixel. */
const CELL_PAD = 1e-4;
/** A light's luminance weights (linear Rec. 709). */
const LUM_R = 0.2126;
const LUM_G = 0.7152;
const LUM_B = 0.0722;

/** The result of one build (views into the builder's arrays, valid until the next build). */
export interface ClusterBuild {
  grid: ClusterGrid;
  /** The view matrix the records are written in (the camera's). */
  view: ArrayLike<number>;
  /** Lights handed in that were visible, and those packed (in view). */
  lights: number;
  packed: number;
  /** Packed slot → input slot, best rank first (a slot is the light's index in the lists). */
  order: Uint32Array;
  /** Cells listed this frame (entries), by packed slot: slot s owns entries [entryEnd[s-1], entryEnd[s]). */
  entries: number;
  entryCluster: Uint32Array;
  entryEnd: Uint32Array;
  /** Lights per cell. */
  counts: Uint32Array;
  /** Lights left out of at least one cell they reach (the index budget was full). */
  overflow: number;
}

/** Per light, the view-space data the cell tests use. */
interface Prepared {
  /** Centre (view), reach. */
  cx: Float64Array;
  /** AABB (view): minx, miny, minz, maxx, maxy, maxz. */
  box: Float64Array;
  rank: Float64Array;
  /** View-space axis (spot) or u, v, facing (area): 9 a light. */
  axes: Float64Array;
}

/**
 * Builds the lists. Holds its scratch between frames (no array grows once
 * the light count and the listed cells stop growing).
 */
export class ClusterBuilder {
  private prep: Prepared = { cx: new Float64Array(0), box: new Float64Array(0), rank: new Float64Array(0), axes: new Float64Array(0) };
  private order = new Uint32Array(0);
  private keys = new Float64Array(0);
  private entryCluster = new Uint32Array(1024);
  private entryEnd = new Uint32Array(0);
  private counts = new Uint32Array(0);
  /** Per depth plane (slices + 1): its depth, and the view x of every tile edge and y of every row edge there. */
  private planes = new Float64Array(CLUSTER_SLICES + 1);
  private edgeX = new Float64Array(0);
  private edgeY = new Float64Array(0);
  /** Per slice: its cells' padded view z range; per slice and tile column (row): the padded x (y) range. */
  private readonly cellZ = new Float64Array(CLUSTER_SLICES * 2);
  private cellX = new Float64Array(0);
  private cellY = new Float64Array(0);
  private readonly cell = new Float64Array(6);
  private readonly ndc = new Float64Array(4);

  build(lights: ClusterLights, camera: ClusterCamera, maxWords: number): ClusterBuild {
    const n = lights.count;
    this.ensureLights(n);
    const P = camera.projection;
    const V = camera.view;
    const tilesX = CLUSTER_TILES_X;
    const tilesY = clusterTilesY(Math.abs(P[5]! / P[0]!));
    const clusters = tilesX * tilesY * CLUSTER_SLICES;
    if (this.counts.length < clusters) this.counts = new Uint32Array(clusters);
    const counts = this.counts.subarray(0, clusters);
    counts.fill(0);
    const near = camera.near;
    const far = camera.far;
    const { cx, box, rank, axes } = this.prep;
    const order = this.order;
    // Prepare: view-space bounds, cull, rank.
    let visibleN = 0;
    let packed = 0;
    let farthest = 0;
    let nearest = -1;
    let nearestD = Infinity;
    const ex = V[12]!;
    const ey = V[13]!;
    const ez = V[14]!;
    for (let i = 0; i < n; i += 1) {
      if (lights.visible[i] === 0) continue;
      visibleN += 1;
      const r = lights.reach[i]!;
      if (!(r > 0)) continue;
      const wx = lights.position[i * 3]!;
      const wy = lights.position[i * 3 + 1]!;
      const wz = lights.position[i * 3 + 2]!;
      const x = V[0]! * wx + V[4]! * wy + V[8]! * wz + ex;
      const y = V[1]! * wx + V[5]! * wy + V[9]! * wz + ey;
      const z = V[2]! * wx + V[6]! * wy + V[10]! * wz + ez;
      cx[i * 4] = x;
      cx[i * 4 + 1] = y;
      cx[i * 4 + 2] = z;
      cx[i * 4 + 3] = r;
      lightBox(lights, i, V, x, y, z, r, axes, box);
      const b = i * 6;
      // Depth range in front of the camera; nothing of it between near and far: culled.
      const dmin = -box[b + 5]!;
      const dmax = -box[b + 2]!;
      if (dmax < near || dmin > far) continue;
      if (!projectRect(P, box, b, near, far, this.ndc)) continue;
      const d = Math.sqrt(x * x + y * y + z * z);
      const c = lights.color;
      const lum = LUM_R * c[i * 3]! + LUM_G * c[i * 3 + 1]! + LUM_B * c[i * 3 + 2]!;
      rank[i] = Math.max(lum, 1e-9) * (r / Math.max(d, 1));
      if (d < nearestD) {
        nearestD = d;
        nearest = i;
      }
      if (dmax > farthest) farthest = dmax;
      order[packed] = i;
      packed += 1;
    }
    if (nearest >= 0) rank[nearest] = Infinity;
    const ordered = order.subarray(0, packed);
    sortByRank(ordered, rank, this.keys);
    // The grid for this frame's lights.
    const sliceNear = Math.max(near, CLUSTER_SLICE_NEAR);
    const sliceFar = Math.max(Math.min(far, farthest), sliceNear * 2);
    const scale = CLUSTER_SLICES / Math.log2(sliceFar / sliceNear);
    const bias = -Math.log2(sliceNear) * scale;
    const grid: ClusterGrid = { tilesX, tilesY, slices: CLUSTER_SLICES, clusters, sliceNear, sliceFar, scale, bias };
    this.setPlanes(P, grid, near);
    // Count pass: every packed light's cells, best rank first, until the budget is spent.
    const budget = Math.max(0, maxWords - 2 * clusters);
    let entries = 0;
    let overflow = 0;
    const entryEnd = this.entryEnd;
    for (let s = 0; s < packed; s += 1) {
      const i = ordered[s]!;
      if (entries >= budget) {
        overflow += 1;
        entryEnd[s] = entries;
        continue;
      }
      entries = this.listLight(lights, i, grid, entries, budget, counts);
      if (entries < 0) {
        // The budget ran out inside this light: it keeps the cells listed so far.
        entries = -entries - 1;
        overflow += 1;
      }
      entryEnd[s] = entries;
    }
    return {
      grid,
      view: V,
      lights: visibleN,
      packed,
      order: ordered,
      entries,
      entryCluster: this.entryCluster,
      entryEnd: entryEnd.subarray(0, packed),
      counts,
      overflow,
    };
  }

  /** Test one light against the cells its bounds cover; the new entry count (budget hit: -(count) - 1). */
  private listLight(lights: ClusterLights, i: number, grid: ClusterGrid, entries: number, budget: number, counts: Uint32Array): number {
    const { cx, box, axes } = this.prep;
    const kind = lights.kind[i]! & 3;
    const b = i * 6;
    const x = cx[i * 4]!;
    const y = cx[i * 4 + 1]!;
    const z = cx[i * 4 + 2]!;
    const r = cx[i * 4 + 3]!;
    const a = i * 9;
    const cosO = lights.cone[i * 2]!;
    const sinO = Math.sqrt(Math.max(0, 1 - cosO * cosO));
    const round = kind === CLUSTER_POINT || kind === CLUSTER_SPOT;
    const twoSided = (lights.kind[i]! & CLUSTER_TWO_SIDED) !== 0;
    const cellX = this.cellX;
    const cellY = this.cellY;
    let entryCluster = this.entryCluster;
    const tx = grid.tilesX;
    const ty = grid.tilesY;
    const s0 = clusterSliceOf(grid, -box[b + 5]!);
    let s1 = clusterSliceOf(grid, -box[b + 2]!);
    if (s1 < 0) s1 = grid.slices - 1;
    if (s0 < 0) return entries;
    const cell = this.cell;
    const planes = this.planes;
    for (let k = s0; k <= s1; k += 1) {
      const dn = planes[k]!;
      const df = planes[k + 1]!;
      // Tiles the light's box covers within this slice.
      const zf = Math.max(box[b + 2]!, -df);
      const zn = Math.min(box[b + 5]!, -dn);
      if (zf > zn) continue;
      // A point or spot's cut through this slice is no wider than the sphere's there.
      let bx0 = box[b]!;
      let by0 = box[b + 1]!;
      let bx1 = box[b + 3]!;
      let by1 = box[b + 4]!;
      let rr = r;
      if (round) {
        const dz = z > zn ? z - zn : z < zf ? zf - z : 0;
        rr = Math.sqrt(Math.max(0, r * r - dz * dz));
        bx0 = Math.max(bx0, x - rr);
        by0 = Math.max(by0, y - rr);
        bx1 = Math.min(bx1, x + rr);
        by1 = Math.min(by1, y + rr);
      }
      if (!this.sliceRect(bx0, by0, bx1, by1, zf, zn)) continue;
      const i0 = Math.max(0, Math.floor(((this.ndc[0]! + 1) / 2) * tx));
      const i1 = Math.min(tx - 1, Math.floor(((this.ndc[2]! + 1) / 2) * tx));
      const j0 = Math.max(0, Math.floor(((this.ndc[1]! + 1) / 2) * ty));
      const j1 = Math.min(ty - 1, Math.floor(((this.ndc[3]! + 1) / 2) * ty));
      cell[2] = this.cellZ[k * 2]!;
      cell[5] = this.cellZ[k * 2 + 1]!;
      const zb0 = cell[2]!;
      const zb1 = cell[5]!;
      const dzc = z < zb0 ? zb0 - z : z > zb1 ? z - zb1 : 0;
      const ex = k * tx;
      const ey = k * ty;
      for (let j = j0; j <= j1; j += 1) {
        const y0 = cellY[(ey + j) * 2]!;
        const y1 = cellY[(ey + j) * 2 + 1]!;
        // A row the slice's cut of the sphere misses lists nothing.
        if (round && (y0 > y + rr || y1 < y - rr)) continue;
        const dyc = y < y0 ? y0 - y : y > y1 ? y - y1 : 0;
        const ryz = r * r - dzc * dzc - dyc * dyc;
        cell[1] = y0;
        cell[4] = y1;
        for (let t = i0; t <= i1; t += 1) {
          const x0 = cellX[(ex + t) * 2]!;
          const x1 = cellX[(ex + t) * 2 + 1]!;
          let hit: boolean;
          if (kind === CLUSTER_POINT) {
            // sphereHitsBox, its y and z terms taken out of the row's loop.
            const dxc = x < x0 ? x0 - x : x > x1 ? x - x1 : 0;
            hit = dxc * dxc <= ryz;
          } else {
            cell[0] = x0;
            cell[3] = x1;
            hit = kind === CLUSTER_SPOT ? spotHitsBox(x, y, z, r, axes[a]!, axes[a + 1]!, axes[a + 2]!, cosO, sinO, cell) : areaHitsBox(x, y, z, r, axes, a, twoSided, cell);
          }
          if (!hit) continue;
          if (entries >= budget) return -entries - 1;
          if (entries >= entryCluster.length) entryCluster = this.growEntries(Math.min(budget, entryCluster.length * 2));
          const c = t + tx * (j + ty * k);
          entryCluster[entries] = c;
          counts[c] = counts[c]! + 1;
          entries += 1;
        }
      }
    }
    return entries;
  }

  /** NDC rect of the view box [bx0, bx1] × [by0, by1] × [zf, zn]; false when it misses the screen. */
  private sliceRect(bx0: number, by0: number, bx1: number, by1: number, zf: number, zn: number): boolean {
    const ndc = this.ndc;
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    for (let c = 0; c < 2; c += 1) {
      const zz = c === 0 ? zf : zn;
      const w = this.pw11 * zz + this.pw15;
      const ox = this.p8 * zz + this.p12;
      const oy = this.p9 * zz + this.p13;
      for (let cxI = 0; cxI < 2; cxI += 1) {
        const px = (this.p0 * (cxI === 0 ? bx0 : bx1) + ox) / w;
        if (px < x0) x0 = px;
        if (px > x1) x1 = px;
      }
      for (let cyI = 0; cyI < 2; cyI += 1) {
        const py = (this.p5 * (cyI === 0 ? by0 : by1) + oy) / w;
        if (py < y0) y0 = py;
        if (py > y1) y1 = py;
      }
    }
    ndc[0] = x0;
    ndc[1] = y0;
    ndc[2] = x1;
    ndc[3] = y1;
    return x1 >= -1 && x0 <= 1 && y1 >= -1 && y0 <= 1;
  }

  private p0 = 1;
  private p5 = 1;
  private p8 = 0;
  private p9 = 0;
  private p12 = 0;
  private p13 = 0;
  private pw11 = -1;
  private pw15 = 0;

  /** Depth planes and the view-space tile edges on them. */
  private setPlanes(P: ArrayLike<number>, grid: ClusterGrid, near: number): void {
    this.p0 = P[0]!;
    this.p5 = P[5]!;
    this.p8 = P[8]!;
    this.p9 = P[9]!;
    this.p12 = P[12]!;
    this.p13 = P[13]!;
    this.pw11 = P[11]!;
    this.pw15 = P[15]!;
    const tx = grid.tilesX;
    const ty = grid.tilesY;
    const S = grid.slices;
    const planes = this.planes;
    planes[0] = Math.min(near, grid.sliceNear);
    for (let k = 1; k <= S; k += 1) planes[k] = 2 ** ((k - grid.bias) / grid.scale);
    planes[S] = grid.sliceFar;
    if (this.edgeX.length < (S + 1) * (tx + 1)) this.edgeX = new Float64Array((S + 1) * (tx + 1));
    if (this.edgeY.length < (S + 1) * (ty + 1)) this.edgeY = new Float64Array((S + 1) * (ty + 1));
    if (this.cellX.length < S * tx * 2) this.cellX = new Float64Array(S * tx * 2);
    if (this.cellY.length < S * ty * 2) this.cellY = new Float64Array(S * ty * 2);
    const ex = this.edgeX;
    const ey = this.edgeY;
    for (let k = 0; k <= S; k += 1) {
      const z = -planes[k]!;
      const w = P[11]! * z + P[15]!;
      for (let t = 0; t <= tx; t += 1) ex[k * (tx + 1) + t] = ((-1 + (2 * t) / tx) * w - P[8]! * z - P[12]!) / P[0]!;
      for (let j = 0; j <= ty; j += 1) ey[k * (ty + 1) + j] = ((-1 + (2 * j) / ty) * w - P[9]! * z - P[13]!) / P[5]!;
    }
    // Each cell's view-space box: its tile's edges on the slice's two planes, padded.
    for (let k = 0; k < S; k += 1) {
      const pad = CELL_PAD * planes[k + 1]! + 1e-6;
      this.cellZ[k * 2] = -planes[k + 1]! - pad;
      this.cellZ[k * 2 + 1] = -planes[k]! + pad;
      const e0 = k * (tx + 1);
      const e1 = (k + 1) * (tx + 1);
      for (let t = 0; t < tx; t += 1) {
        this.cellX[(k * tx + t) * 2] = Math.min(ex[e0 + t]!, ex[e1 + t]!) - pad;
        this.cellX[(k * tx + t) * 2 + 1] = Math.max(ex[e0 + t + 1]!, ex[e1 + t + 1]!) + pad;
      }
      const f0 = k * (ty + 1);
      const f1 = (k + 1) * (ty + 1);
      for (let j = 0; j < ty; j += 1) {
        this.cellY[(k * ty + j) * 2] = Math.min(ey[f0 + j]!, ey[f1 + j]!) - pad;
        this.cellY[(k * ty + j) * 2 + 1] = Math.max(ey[f0 + j + 1]!, ey[f1 + j + 1]!) + pad;
      }
    }
  }

  private ensureLights(n: number): void {
    if (this.order.length >= n) return;
    const m = Math.max(16, n, this.order.length * 2);
    this.prep = { cx: new Float64Array(m * 4), box: new Float64Array(m * 6), rank: new Float64Array(m), axes: new Float64Array(m * 9) };
    this.order = new Uint32Array(m);
    this.keys = new Float64Array(m);
    this.entryEnd = new Uint32Array(m);
  }

  private growEntries(n: number): Uint32Array<ArrayBuffer> {
    const next = new Uint32Array(Math.max(n, this.entryCluster.length + 1));
    next.set(this.entryCluster);
    this.entryCluster = next;
    return next;
  }
}

/** Slots a sort key spells out exactly (below them, the rank's log in 2^-18 steps over ±512: 52 bits in all). */
const KEY_SLOTS = 2 ** 24;
const KEY_STEPS = 2 ** 18;
const KEY_LOG_RANGE = 512;

/**
 * `order` (light slots) best rank first, ties by slot. Ranks become one
 * number with the slot (a plain numeric sort is several times faster than
 * one with a comparator, and the order is a frame's main CPU cost after the
 * cell tests); past the slots a key spells out, the comparator.
 */
function sortByRank(order: Uint32Array, rank: Float64Array, keys: Float64Array): void {
  const n = order.length;
  let maxSlot = 0;
  for (let s = 0; s < n; s += 1) maxSlot = Math.max(maxSlot, order[s]!);
  if (maxSlot >= KEY_SLOTS) {
    order.sort((a, b) => rank[b]! - rank[a]! || a - b);
    return;
  }
  const k = keys.subarray(0, n);
  for (let s = 0; s < n; s += 1) {
    const i = order[s]!;
    const lr = Math.max(-KEY_LOG_RANGE, Math.min(KEY_LOG_RANGE, Math.log2(rank[i]!)));
    k[s] = Math.round((KEY_LOG_RANGE - lr) * KEY_STEPS) * KEY_SLOTS + i;
  }
  k.sort();
  for (let s = 0; s < n; s += 1) order[s] = k[s]! % KEY_SLOTS;
}

/**
 * A light's view-space box (written at `box[i × 6]`) and the view-space
 * axes its cell test uses (`axes[i × 9]`: a spot's axis; an area light's
 * u, v and unit facing).
 */
function lightBox(lights: ClusterLights, i: number, V: ArrayLike<number>, x: number, y: number, z: number, r: number, axes: Float64Array, box: Float64Array): void {
  const kind = lights.kind[i]! & 3;
  const b = i * 6;
  const a = i * 9;
  if (kind === CLUSTER_POINT) {
    box[b] = x - r;
    box[b + 1] = y - r;
    box[b + 2] = z - r;
    box[b + 3] = x + r;
    box[b + 4] = y + r;
    box[b + 5] = z + r;
    return;
  }
  if (kind === CLUSTER_SPOT) {
    rotate(V, lights.direction, i, axes, a);
    const l = Math.sqrt(axes[a]! * axes[a]! + axes[a + 1]! * axes[a + 1]! + axes[a + 2]! * axes[a + 2]!) || 1;
    axes[a] = axes[a]! / l;
    axes[a + 1] = axes[a + 1]! / l;
    axes[a + 2] = axes[a + 2]! / l;
    // The spherical sector's extent along ±x, ±y, ±z: r × cos(max(0, angle to the axis − half-angle)), never behind the apex.
    const cosT = Math.max(-1, Math.min(1, lights.cone[i * 2]!));
    const sinT = Math.sqrt(1 - cosT * cosT);
    for (let e = 0; e < 3; e += 1) {
      const ca = axes[a + e]!;
      const c = e === 0 ? x : e === 1 ? y : z;
      box[b + 3 + e] = c + r * sectorReach(ca, cosT, sinT);
      box[b + e] = c - r * sectorReach(-ca, cosT, sinT);
    }
    return;
  }
  rotate(V, lights.u, i, axes, a);
  rotate(V, lights.v, i, axes, a + 3);
  const ux = axes[a]!;
  const uy = axes[a + 1]!;
  const uz = axes[a + 2]!;
  const vx = axes[a + 3]!;
  const vy = axes[a + 4]!;
  const vz = axes[a + 5]!;
  let nx = uy * vz - uz * vy;
  let ny = uz * vx - ux * vz;
  let nz = ux * vy - uy * vx;
  const ln = Math.hypot(nx, ny, nz) || 1;
  nx /= ln;
  ny /= ln;
  nz /= ln;
  axes[a + 6] = nx;
  axes[a + 7] = ny;
  axes[a + 8] = nz;
  const lu = Math.hypot(ux, uy, uz) || 1;
  const lv = Math.hypot(vx, vy, vz) || 1;
  const two = (lights.kind[i]! & CLUSTER_TWO_SIDED) !== 0;
  // The emitting box: the rect grown by the reach on its sides, and from it to the reach along its facing (both ways when two-sided).
  const hu = 1 + r / lu;
  const hv = 1 + r / lv;
  const hn = two ? r : r / 2;
  const ox = two ? 0 : nx * hn;
  const oy = two ? 0 : ny * hn;
  const oz = two ? 0 : nz * hn;
  const ex = Math.abs(ux * hu) + Math.abs(vx * hv) + Math.abs(nx * hn);
  const ey = Math.abs(uy * hu) + Math.abs(vy * hv) + Math.abs(ny * hn);
  const ez = Math.abs(uz * hu) + Math.abs(vz * hv) + Math.abs(nz * hn);
  box[b] = x + ox - ex;
  box[b + 1] = y + oy - ey;
  box[b + 2] = z + oz - ez;
  box[b + 3] = x + ox + ex;
  box[b + 4] = y + oy + ey;
  box[b + 5] = z + oz + ez;
}

/** `src[i]` (a world direction) turned into view space at `out[at]`. */
function rotate(V: ArrayLike<number>, src: Float32Array, i: number, out: Float64Array, at: number): void {
  const sx = src[i * 3]!;
  const sy = src[i * 3 + 1]!;
  const sz = src[i * 3 + 2]!;
  out[at] = V[0]! * sx + V[4]! * sy + V[8]! * sz;
  out[at + 1] = V[1]! * sx + V[5]! * sy + V[9]! * sz;
  out[at + 2] = V[2]! * sx + V[6]! * sy + V[10]! * sz;
}

/** How far (share of the reach) a sector of half-angle θ extends along a direction at cos α to its axis. */
function sectorReach(cosA: number, cosT: number, sinT: number): number {
  if (cosA >= cosT) return 1;
  const sinA = Math.sqrt(Math.max(0, 1 - cosA * cosA));
  return Math.max(0, cosA * cosT + sinA * sinT);
}

/** The NDC rect of box `b` clipped to [−far, −near] in view z; false when it misses the screen. */
function projectRect(P: ArrayLike<number>, box: Float64Array, b: number, near: number, far: number, out: Float64Array): boolean {
  const zf = Math.max(box[b + 2]!, -far);
  const zn = Math.min(box[b + 5]!, -near);
  if (zf > zn) return false;
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (let c = 0; c < 2; c += 1) {
    const z = c === 0 ? zf : zn;
    const w = P[11]! * z + P[15]!;
    for (let e = 0; e < 2; e += 1) {
      const px = (P[0]! * box[b + e * 3]! + P[8]! * z + P[12]!) / w;
      const py = (P[5]! * box[b + 1 + e * 3]! + P[9]! * z + P[13]!) / w;
      if (px < x0) x0 = px;
      if (px > x1) x1 = px;
      if (py < y0) y0 = py;
      if (py > y1) y1 = py;
    }
  }
  out[0] = x0;
  out[1] = y0;
  out[2] = x1;
  out[3] = y1;
  return x1 >= -1 && x0 <= 1 && y1 >= -1 && y0 <= 1;
}

/** Whether a sphere touches an axis-aligned box (minx, miny, minz, maxx, maxy, maxz). */
export function sphereHitsBox(x: number, y: number, z: number, r: number, box: ArrayLike<number>): boolean {
  const dx = x < box[0]! ? box[0]! - x : x > box[3]! ? x - box[3]! : 0;
  const dy = y < box[1]! ? box[1]! - y : y > box[4]! ? y - box[4]! : 0;
  const dz = z < box[2]! ? box[2]! - z : z > box[5]! ? z - box[5]! : 0;
  return dx * dx + dy * dy + dz * dz <= r * r;
}

/**
 * Whether a spot's volume (within `r` of its apex and `acos(cosOuter)` of its
 * unit axis; `sinOuter` its sine) may touch the box: the sphere against the box, then the cone
 * against the box's bounding sphere (a sphere wholly outside the cone, past
 * its reach or behind its apex misses).
 */
export function spotHitsBox(x: number, y: number, z: number, r: number, ax: number, ay: number, az: number, cosOuter: number, sinOuter: number, box: ArrayLike<number>): boolean {
  if (!sphereHitsBox(x, y, z, r, box)) return false;
  if (cosOuter <= 0) return true;
  const hx = (box[3]! - box[0]!) / 2;
  const hy = (box[4]! - box[1]!) / 2;
  const hz = (box[5]! - box[2]!) / 2;
  const rad = Math.sqrt(hx * hx + hy * hy + hz * hz);
  const vx = box[0]! + hx - x;
  const vy = box[1]! + hy - y;
  const vz = box[2]! + hz - z;
  const lenSq = vx * vx + vy * vy + vz * vz;
  const along = vx * ax + vy * ay + vz * az;
  if (along > rad + r || along < -rad) return false;
  const toSide = cosOuter * Math.sqrt(Math.max(0, lenSq - along * along)) - along * sinOuter;
  return toSide <= rad;
}

/**
 * Whether an area light's volume (within `r` of its rect, on its facing
 * side unless two-sided) may touch the box: the rect's bounding sphere
 * grown by the reach against the box, then the emitting box (separating
 * axes: the box's three and the emitting box's three). `axes[a…]` holds the
 * view-space half sides u, v and the unit facing.
 */
export function areaHitsBox(x: number, y: number, z: number, r: number, axes: ArrayLike<number>, a: number, twoSided: boolean, box: ArrayLike<number>): boolean {
  const ux = axes[a]!;
  const uy = axes[a + 1]!;
  const uz = axes[a + 2]!;
  const vx = axes[a + 3]!;
  const vy = axes[a + 4]!;
  const vz = axes[a + 5]!;
  const nx = axes[a + 6]!;
  const ny = axes[a + 7]!;
  const nz = axes[a + 8]!;
  const lu = Math.sqrt(ux * ux + uy * uy + uz * uz);
  const lv = Math.sqrt(vx * vx + vy * vy + vz * vz);
  if (!sphereHitsBox(x, y, z, Math.sqrt(lu * lu + lv * lv) + r, box)) return false;
  const hn = twoSided ? r : r / 2;
  const ox = x + (twoSided ? 0 : nx * hn);
  const oy = y + (twoSided ? 0 : ny * hn);
  const oz = z + (twoSided ? 0 : nz * hn);
  const hu = lu + r;
  const hv = lv + r;
  const iu = 1 / (lu || 1);
  const iv = 1 / (lv || 1);
  const bx = (box[3]! - box[0]!) / 2;
  const by = (box[4]! - box[1]!) / 2;
  const bz = (box[5]! - box[2]!) / 2;
  const dx = box[0]! + bx - ox;
  const dy = box[1]! + by - oy;
  const dz = box[2]! + bz - oz;
  const Ux = ux * iu;
  const Uy = uy * iu;
  const Uz = uz * iu;
  const Vx = vx * iv;
  const Vy = vy * iv;
  const Vz = vz * iv;
  // The box's axes: the emitting box's extent along x, y, z.
  if (Math.abs(dx) > bx + hu * Math.abs(Ux) + hv * Math.abs(Vx) + hn * Math.abs(nx)) return false;
  if (Math.abs(dy) > by + hu * Math.abs(Uy) + hv * Math.abs(Vy) + hn * Math.abs(ny)) return false;
  if (Math.abs(dz) > bz + hu * Math.abs(Uz) + hv * Math.abs(Vz) + hn * Math.abs(nz)) return false;
  // The emitting box's axes: the cell's extent along u, v, facing.
  if (Math.abs(dx * Ux + dy * Uy + dz * Uz) > hu + bx * Math.abs(Ux) + by * Math.abs(Uy) + bz * Math.abs(Uz)) return false;
  if (Math.abs(dx * Vx + dy * Vy + dz * Vz) > hv + bx * Math.abs(Vx) + by * Math.abs(Vy) + bz * Math.abs(Vz)) return false;
  if (Math.abs(dx * nx + dy * ny + dz * nz) > hn + bx * Math.abs(nx) + by * Math.abs(ny) + bz * Math.abs(nz)) return false;
  return true;
}
