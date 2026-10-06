/**
 * Levels of detail and density per copy of an instance set.
 *
 * By default a chunk draws one level for all its copies, picked at its
 * centre for the copies' mean size (with the project's bias and hysteresis,
 * against the model's switch distances scaled by size). A set with
 * `lodPerCopy` has every copy pick its own level by its own distance and
 * size instead: a 32 m chunk then no longer switches all its grass at once,
 * but a chunk straddling a switch point draws once per level it holds —
 * on Skyforge's farm (many small sets of copies of varied size) that was 23
 * more draws and +0.35 ms of main thread a frame on WebGL 2, so it is the
 * set's choice. Either way copies thin out where they are small on screen
 * (the set's density falloff). The chunk keeps one draw per mesh and level;
 * each draw leaves out the copies that are not at its level
 * (`InstanceFilter`), so a pick costs no draw call.
 *
 * Picks are made once per view and chunk (all of the chunk's draws share
 * them) and only when the chunk's place or the tuning changed, or the eye
 * moved more than {@link REPICK_MOVE_FRACTION} of its distance to the
 * chunk's nearest copy since the last pick: picks depend on distance only, so
 * a camera turning or drifting a little leaves them as they are (each frame
 * the camera moved used to loop over every copy of every chunk). A chunk
 * wholly nearer than its first switch and its density falloff, or wholly
 * past its cull distance, is decided at once without a loop over its copies.
 * Each draw reads the list of the copies at its level (made once per change
 * of the picks), so culling and ordering a draw costs its own copies, not the
 * chunk's.
 */
import { LOD_REFERENCE_FOV_DEG, type InstanceDensity } from '@thirdlight/runtime';

import type { LodTuning } from './lod-switch';
import { maxScaleOf, type CullView } from './view-cull';
import type { InstanceFilter } from './attribute-instancing';

/** tan of half the reference field of view: a sphere of radius r covers size s of the screen at r / (TAN · s). */
const TAN_HALF_REFERENCE = Math.tan((LOD_REFERENCE_FOV_DEG * Math.PI) / 360);

/** Not picked yet (before the first view). */
const UNPICKED = 255;

/**
 * The eye moving less than this fraction of its distance to a chunk's nearest
 * copy since the chunk's last pick keeps the picks: every switch distance and
 * density step it could cross is off by at most this fraction (well inside
 * the project's hysteresis at its default).
 */
export const REPICK_MOVE_FRACTION = 0.01;

/** One LOD group of the copies' model: where each level takes over (level 0 at 0), and whether the last level is the cull. */
export interface CopyLodGroup {
  readonly distances: readonly number[];
  readonly culls: boolean;
}

/** A chunk's copies as the picker reads them. */
export interface ChunkCopies {
  /** Each copy's origin in the chunk node's space (xyz). */
  readonly origins: Float32Array;
  /** Each copy's largest scale. */
  readonly scales: Float32Array;
  /** Each copy's place in the thinning order, in [0, 1) (stable: from its index in the set). */
  readonly ranks: Float32Array;
  readonly count: number;
}

/** What a chunk's picks hold now. */
export interface ChunkLodCounts {
  /** Copies drawn at each level of the first LOD group (all at index 0 without one). */
  readonly byLevel: number[];
  /** Copies past their cull size. */
  readonly culled: number;
  /** Copies left out by the density falloff. */
  readonly thinned: number;
}

/** A copy's place in the thinning order: a hash of its index, so neighbours thin evenly and the order never changes. */
export function copyRank(index: number): number {
  let h = Math.imul(index ^ 0x9e3779b9, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

/** The share of copies drawn at `distance` for a copy whose falloff runs from `from` to `to` (distances; `min` past it). */
export function densityAt(distance: number, from: number, to: number, min: number): number {
  if (distance <= from) return 1;
  if (distance >= to || to <= from) return min;
  return 1 - ((1 - min) * (distance - from)) / (to - from);
}

/**
 * The picks of one chunk: each copy's level in every LOD group of the model
 * and whether the density falloff keeps it.
 */
export class ChunkLodPicker {
  /** Per LOD group, each copy's level ({@link UNPICKED} before the first view: then level 0). */
  private readonly levels: Uint8Array[];
  private readonly kept: Uint8Array;
  private readonly world = new Float64Array(16).fill(Number.NaN);
  /** The eye and zoom the picks were last made at, and how far the eye may move before they are made again (squared). */
  private readonly pickedEye = new Float64Array(3).fill(Number.NaN);
  private pickedZoom = Number.NaN;
  private moveSq = 0;
  /** Per LOD group and level, the slots drawn there (ascending) and how many; the last entry: the meshes outside every group. */
  private readonly lists: Uint32Array[][];
  private readonly listCounts: Int32Array[];
  private stamp = -1;
  private view: CullView | null = null;
  private revision = -1;
  /** Bumped whenever a pick changed (the draws put their copies in order again). */
  private version = 0;
  /** The largest distance of a copy from the chunk's origin, and the copies' smallest and largest scale. */
  private reach: number;
  private minScale: number;
  private maxScale: number;
  /** The copies' mean scale (a chunk's level is picked for it), and per LOD group the level the chunk picked (-1: none yet). */
  private meanScale: number;
  private readonly chunkLevels: Int16Array;
  private counts: ChunkLodCounts;

  constructor(
    private readonly copies: ChunkCopies,
    private readonly groups: readonly CopyLodGroup[],
    /** The model's bounding radius (LOD0) for the density falloff's screen sizes; null: no falloff. */
    private readonly density: { readonly radius: number; readonly falloff: InstanceDensity } | null,
    private readonly tuning: LodTuning,
    /** Each copy picks its own level; else the chunk's level for all of them. */
    private readonly perCopy = false,
  ) {
    this.levels = groups.map(() => new Uint8Array(copies.count).fill(UNPICKED));
    this.kept = new Uint8Array(copies.count).fill(1);
    let reach = 0;
    let lo = Number.POSITIVE_INFINITY;
    let hi = 0;
    for (let i = 0; i < copies.count; i += 1) {
      const o = copies.origins;
      reach = Math.max(reach, Math.hypot(o[i * 3]!, o[i * 3 + 1]!, o[i * 3 + 2]!));
      lo = Math.min(lo, copies.scales[i]!);
      hi = Math.max(hi, copies.scales[i]!);
    }
    this.reach = reach;
    this.minScale = Number.isFinite(lo) ? lo : 1;
    this.maxScale = hi;
    this.meanScale = this.scaleMean();
    this.chunkLevels = new Int16Array(groups.length).fill(-1);
    this.counts = { byLevel: [], culled: 0, thinned: 0 };
    this.lists = [...groups.map((g) => g.distances.map(() => new Uint32Array(copies.count))), [new Uint32Array(copies.count)]];
    this.listCounts = [...groups.map((g) => new Int32Array(g.distances.length)), new Int32Array(1)];
    this.count();
  }

  /** The draw of LOD group `group` at `level` (group -1: a mesh outside every group) as an instance filter. */
  filter(group: number, level: number): InstanceFilter {
    const list = group < 0 ? this.groups.length : group;
    const at = group < 0 ? 0 : level;
    return {
      prepare: (view, world, sameWorld) => this.prepare(view, world, sameWorld),
      includes: (slot) => this.includes(group, level, slot),
      slots: () => this.lists[list]![at]!,
      slotCount: () => this.listCounts[list]![at]!,
      full: group < 0 || level === 0,
    };
  }

  /** Whether copy `copy` is drawn by the draw of `group` at `level`. */
  includes(group: number, level: number, copy: number): boolean {
    if (this.kept[copy] !== 1) return false;
    if (group < 0) {
      // A mesh outside the LOD groups is drawn while the copy is not culled by any of them.
      for (let g = 0; g < this.groups.length; g += 1) if (this.groups[g]!.culls && this.levels[g]![copy] === this.groups[g]!.distances.length - 1) return false;
      return true;
    }
    const l = this.levels[group]![copy]!;
    return (l === UNPICKED ? 0 : l) === level;
  }

  /** Copy `copy` moved to `x y z` (the chunk node's space) at largest scale `scale`: its picks are made again. */
  moveCopy(copy: number, x: number, y: number, z: number, scale: number): void {
    if (copy < 0 || copy >= this.copies.count) return;
    const o = this.copies.origins;
    o[copy * 3] = x;
    o[copy * 3 + 1] = y;
    o[copy * 3 + 2] = z;
    this.copies.scales[copy] = scale;
    this.reach = Math.max(this.reach, Math.hypot(x, y, z));
    this.minScale = Math.min(this.minScale, scale);
    this.maxScale = Math.max(this.maxScale, scale);
    this.meanScale = this.scaleMean();
    this.pickedZoom = Number.NaN;
    this.stamp = -1;
  }

  private scaleMean(): number {
    let sum = 0;
    for (let i = 0; i < this.copies.count; i += 1) sum += this.copies.scales[i]!;
    return this.copies.count > 0 ? sum / this.copies.count : 1;
  }

  /** What the picks hold now. */
  stats(): ChunkLodCounts {
    return this.counts;
  }

  /**
   * Pick for `view` with the chunk's world matrix `w` (once per view; the
   * chunk's draws call it each). `sameWorld`: the caller's world matrix is the
   * one it passed last time (the chunk's draws share it: no need to compare).
   */
  prepare(view: CullView, w: ArrayLike<number>, sameWorld = false): number {
    const revision = this.tuning.revision;
    if (view === this.view && view.stamp === this.stamp && revision === this.revision && sameWorld) return this.version;
    let worldSame = true;
    const world = this.world;
    for (let k = 0; k < 16; k += 1) {
      if (world[k] !== w[k]) {
        worldSame = false;
        break;
      }
    }
    if (view === this.view && view.stamp === this.stamp && revision === this.revision && worldSame) return this.version;
    this.view = view;
    this.stamp = view.stamp;
    // Picks hang on the eye's distance only: a view that turned, or moved within the margin, keeps them.
    if (worldSame && revision === this.revision && view.zoom === this.pickedZoom) {
      const dx = view.eye[0]! - this.pickedEye[0]!;
      const dy = view.eye[1]! - this.pickedEye[1]!;
      const dz = view.eye[2]! - this.pickedEye[2]!;
      if (dx * dx + dy * dy + dz * dz <= this.moveSq) return this.version;
    }
    this.revision = revision;
    if (!worldSame) for (let k = 0; k < 16; k += 1) world[k] = w[k]!;
    this.pickedEye.set(view.eye);
    this.pickedZoom = view.zoom;
    if (this.pick(view, w)) this.version += 1;
    return this.version;
  }

  /** Make every pick; true when one changed. */
  private pick(view: CullView, w: ArrayLike<number>): boolean {
    const { origins, scales, ranks, count } = this.copies;
    const groups = this.groups;
    const tuning = this.tuning;
    const ws = maxScaleOf(w);
    const toDistance = 1 / (view.zoom * tuning.bias);
    const ex = view.eye[0]!;
    const ey = view.eye[1]!;
    const ez = view.eye[2]!;
    const hys = tuning.hysteresis;
    // The chunk's distance range (its origin ± the farthest copy), in the units the switch distances are in.
    const cd = Math.hypot(ex - w[12]!, ey - w[13]!, ez - w[14]!);
    const nearWorld = Math.max(0, cd - this.reach * ws);
    const near = nearWorld * toDistance;
    this.moveSq = (nearWorld * REPICK_MOVE_FRACTION) ** 2;
    const far = (cd + this.reach * ws) * toDistance;
    const sLo = this.minScale * ws;
    const sHi = this.maxScale * ws;
    const dens = this.density;
    const fromFactor = dens !== null ? dens.radius / (TAN_HALF_REFERENCE * dens.falloff.start) : 0;
    const toFactor = dens !== null ? dens.radius / (TAN_HALF_REFERENCE * dens.falloff.end) : 0;
    const thins = dens !== null && dens.falloff.min < 1;

    // Wholly near: every copy at level 0 (whatever it showed) and none thinned.
    let allNear = !thins || far <= fromFactor * sLo;
    for (const g of groups) if (g.distances.length > 1 && far >= g.distances[1]! * sLo * (1 - hys)) allNear = false;
    // Wholly past the cull distance of every group (a copy at the cull shows nothing, whatever its other picks).
    let allCulled = groups.length > 0;
    for (const g of groups) if (!g.culls || near < g.distances[g.distances.length - 1]! * sHi) allCulled = false;
    if (allNear || allCulled) {
      let changed = false;
      for (let gi = 0; gi < groups.length; gi += 1) {
        const target = allNear ? 0 : groups[gi]!.distances.length - 1;
        this.chunkLevels[gi] = target;
        const lv = this.levels[gi]!;
        for (let i = 0; i < count; i += 1) {
          if (lv[i] === target) continue;
          if (lv[i] !== UNPICKED) tuning.copySwitches += 1;
          lv[i] = target;
          changed = true;
        }
      }
      if (allNear) for (let i = 0; i < count; i += 1) if (this.kept[i] !== 1) {
        this.kept[i] = 1;
        changed = true;
      }
      if (changed) this.count();
      return changed;
    }

    let changed = false;
    if (!this.perCopy) {
      // One level for the chunk: the rule below at its centre, for the copies' mean size.
      const dc = cd * toDistance;
      const sc = this.meanScale * ws;
      for (let gi = 0; gi < groups.length; gi += 1) {
        const dist = groups[gi]!.distances;
        const current = this.chunkLevels[gi]!;
        let l = 1;
        for (; l < dist.length; l += 1) if (dc < dist[l]! * sc * (current === l ? 1 - hys : 1)) break;
        l -= 1;
        this.chunkLevels[gi] = l;
        const lv = this.levels[gi]!;
        for (let i = 0; i < count; i += 1) {
          if (lv[i] === l) continue;
          if (lv[i] !== UNPICKED) tuning.copySwitches += 1;
          if (lv[i] !== UNPICKED || l !== 0) changed = true;
          lv[i] = l;
        }
      }
      if (dens === null) {
        if (changed) this.count();
        return changed;
      }
    }
    const w0 = w[0]!, w1 = w[1]!, w2 = w[2]!, w4 = w[4]!, w5 = w[5]!, w6 = w[6]!, w8 = w[8]!, w9 = w[9]!, w10 = w[10]!;
    for (let i = 0; i < count; i += 1) {
      const ox = origins[i * 3]!;
      const oy = origins[i * 3 + 1]!;
      const oz = origins[i * 3 + 2]!;
      const dx = ex - (w0 * ox + w4 * oy + w8 * oz + w[12]!);
      const dy = ey - (w1 * ox + w5 * oy + w9 * oz + w[13]!);
      const dz = ez - (w2 * ox + w6 * oy + w10 * oz + w[14]!);
      const d = Math.sqrt(dx * dx + dy * dy + dz * dz) * toDistance;
      const s = scales[i]! * ws;
      for (let gi = 0; gi < groups.length && this.perCopy; gi += 1) {
        const dist = groups[gi]!.distances;
        const lv = this.levels[gi]!;
        const current = lv[i]!;
        // The rule of `pickLodLevel` (no per-level margin here: the models' levels carry none).
        let l = 1;
        for (; l < dist.length; l += 1) {
          const at = dist[l]! * s * (current === l ? 1 - hys : 1);
          if (d < at) break;
        }
        l -= 1;
        if (l !== current) {
          if (current !== UNPICKED) tuning.copySwitches += 1;
          if (current !== UNPICKED || l !== 0) changed = true;
          lv[i] = l;
        }
      }
      if (dens !== null) {
        const keep = thins && ranks[i]! >= densityAt(d, fromFactor * s, toFactor * s, dens.falloff.min) ? 0 : 1;
        if (this.kept[i] !== keep) {
          this.kept[i] = keep;
          changed = true;
        }
      }
    }
    if (changed) this.count();
    return changed;
  }

  private count(): void {
    const groups = this.groups;
    const lists = this.lists;
    const listCounts = this.listCounts;
    for (const c of listCounts) c.fill(0);
    const outside = lists[groups.length]![0]!;
    let outsideCount = 0;
    for (let i = 0; i < this.copies.count; i += 1) {
      if (this.kept[i] !== 1) continue;
      let cut = false;
      for (let g = 0; g < groups.length; g += 1) {
        const raw = this.levels[g]![i]!;
        const l = raw === UNPICKED ? 0 : raw;
        if (groups[g]!.culls && l === groups[g]!.distances.length - 1) cut = true;
        const counts = listCounts[g]!;
        lists[g]![l]![counts[l]!] = i;
        counts[l] = counts[l]! + 1;
      }
      if (!cut) outside[outsideCount++] = i;
    }
    listCounts[groups.length]![0] = outsideCount;
    const g0 = this.groups[0];
    const byLevel = new Array<number>(g0 !== undefined ? g0.distances.length : 1).fill(0);
    let culled = 0;
    let thinned = 0;
    for (let i = 0; i < this.copies.count; i += 1) {
      if (this.kept[i] !== 1) {
        thinned += 1;
        continue;
      }
      let cut = false;
      for (let g = 0; g < this.groups.length; g += 1) if (this.groups[g]!.culls && this.levels[g]![i] === this.groups[g]!.distances.length - 1) cut = true;
      if (cut) {
        culled += 1;
        continue;
      }
      const l = g0 !== undefined ? this.levels[0]![i]! : 0;
      byLevel[l === UNPICKED ? 0 : l] = (byLevel[l === UNPICKED ? 0 : l] ?? 0) + 1;
    }
    this.counts = { byLevel, culled, thinned };
  }
}
