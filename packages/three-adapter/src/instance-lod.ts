/**
 * Levels of detail of an instance set's chunks (the CPU instance sets that
 * remain: generated architecture's and splines' pieces).
 *
 * A chunk draws one level for all its copies, picked at its centre for the
 * copies' mean size (with the project's bias and hysteresis, against the
 * model's switch distances scaled by size). Copies drawn each at their own
 * level and thinned by distance are the GPU renderer's (`copies-gpu.ts`):
 * nothing here walks a chunk's copies per frame.
 *
 * Picks are made once per view and chunk (all of the chunk's draws share
 * them) and only when the chunk's place or the tuning changed, or the eye
 * moved more than {@link REPICK_MOVE_FRACTION} of its distance to the
 * chunk's nearest copy since the last pick: a camera turning or drifting a
 * little leaves them as they are. A chunk wholly nearer than its first
 * switch, or wholly past its cull distance, is decided at once.
 */
import { LOD_REFERENCE_FOV_DEG } from '@thirdlight/project-model';

import type { LodTuning } from './lod-switch';
import { maxScaleOf, type CullView } from './view-cull';
import type { InstanceFilter } from './attribute-instancing';
import type { PreparedPickStats } from './instance-prepare';

/** tan of half the reference field of view: a sphere of radius r covers size s of the screen at r / (TAN · s). */
export const TAN_HALF_REFERENCE = Math.tan((LOD_REFERENCE_FOV_DEG * Math.PI) / 360);

/**
 * The eye moving less than this fraction of its distance to a chunk's nearest
 * copy since the chunk's last pick keeps the picks: every switch distance it
 * could cross is off by at most this fraction (well inside the project's
 * hysteresis at its default).
 */
export const REPICK_MOVE_FRACTION = 0.01;

/** One LOD group of the copies' model: where each level takes over (level 0 at 0), and whether the last level is the cull. */
export interface CopyLodGroup {
  readonly distances: readonly number[];
  readonly culls: boolean;
}

/** A chunk's copies as the picker reads them: each copy's origin in the chunk node's space (xyz) and its largest scale. */
export interface ChunkCopies {
  readonly origins: Float32Array;
  readonly scales: Float32Array;
  readonly count: number;
}

/** What a chunk's picks hold now. */
export interface ChunkLodCounts {
  /** Copies drawn at each level of the first LOD group (all at index 0 without one). */
  readonly byLevel: number[];
  /** Copies past their cull size. */
  readonly culled: number;
}

/** The picks of one chunk: its level in every LOD group of the model. */
export class ChunkLodPicker {
  /** Per LOD group, the chunk's level (-1: none picked yet: then level 0). */
  private readonly levels: Int16Array;
  private readonly world = new Float64Array(16).fill(Number.NaN);
  /** The eye and zoom the picks were last made at, and how far the eye may move before they are made again (squared). */
  private readonly pickedEye = new Float64Array(3).fill(Number.NaN);
  private pickedZoom = Number.NaN;
  private moveSq = 0;
  /** Every slot, ascending (a draw at the chunk's level draws all of them). */
  private readonly all: Uint32Array;
  private readonly none = new Uint32Array(0);
  private stamp = -1;
  private view: CullView | null = null;
  private revision = -1;
  /** Bumped whenever a pick changed (the draws put their copies in order again). */
  private version = 0;
  /** The largest distance of a copy from the chunk's origin, and the copies' smallest, largest and summed scale. */
  private reach: number;
  private minScale: number;
  private maxScale: number;
  private scaleSum: number;

  constructor(
    private readonly copies: ChunkCopies,
    private readonly groups: readonly CopyLodGroup[],
    private readonly tuning: LodTuning,
    /** The copies' reach and sizes, worked out ahead (`instance-prepare.ts`); absent: worked out here. */
    stats?: PreparedPickStats,
  ) {
    this.levels = new Int16Array(groups.length).fill(-1);
    this.all = Uint32Array.from({ length: copies.count }, (_, i) => i);
    this.scaleSum = 0;
    for (let i = 0; i < copies.count; i += 1) this.scaleSum += copies.scales[i]!;
    if (stats !== undefined) {
      this.reach = stats.reach;
      this.minScale = stats.minScale;
      this.maxScale = stats.maxScale;
    } else {
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
    }
  }

  /** The level the chunk draws in LOD group `group` (0 before the first pick). */
  private levelOf(group: number): number {
    return Math.max(0, this.levels[group] ?? 0);
  }

  /** Whether the chunk's copies are past the cull level of a group (nothing drawn). */
  private culled(): boolean {
    for (let g = 0; g < this.groups.length; g += 1) if (this.groups[g]!.culls && this.levelOf(g) === this.groups[g]!.distances.length - 1) return true;
    return false;
  }

  /** The draw of LOD group `group` at `level` (group -1: a mesh outside every group) as an instance filter. */
  filter(group: number, level: number): InstanceFilter {
    const drawn = (): boolean => (group < 0 ? !this.culled() : this.levelOf(group) === level);
    return {
      prepare: (view, world, sameWorld) => this.prepare(view, world, sameWorld),
      includes: () => drawn(),
      slots: () => (drawn() ? this.all : this.none),
      slotCount: () => (drawn() ? this.copies.count : 0),
      full: group < 0 || level === 0,
    };
  }

  /** Copy `copy` moved to `x y z` (the chunk node's space) at largest scale `scale`: the picks are made again. */
  moveCopy(copy: number, x: number, y: number, z: number, scale: number): void {
    if (copy < 0 || copy >= this.copies.count) return;
    const o = this.copies.origins;
    o[copy * 3] = x;
    o[copy * 3 + 1] = y;
    o[copy * 3 + 2] = z;
    this.scaleSum += scale - this.copies.scales[copy]!;
    this.copies.scales[copy] = scale;
    this.reach = Math.max(this.reach, Math.hypot(x, y, z));
    this.minScale = Math.min(this.minScale, scale);
    this.maxScale = Math.max(this.maxScale, scale);
    this.pickedZoom = Number.NaN;
    this.stamp = -1;
  }

  /** What the picks hold now. */
  stats(): ChunkLodCounts {
    const g0 = this.groups[0];
    const byLevel = new Array<number>(g0 !== undefined ? g0.distances.length : 1).fill(0);
    if (this.culled()) return { byLevel, culled: this.copies.count };
    byLevel[g0 !== undefined ? this.levelOf(0) : 0] = this.copies.count;
    return { byLevel, culled: 0 };
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

  /** Pick the chunk's level in every group; true when one changed. */
  private pick(view: CullView, w: ArrayLike<number>): boolean {
    const groups = this.groups;
    const tuning = this.tuning;
    const ws = maxScaleOf(w);
    const toDistance = 1 / (view.zoom * tuning.bias);
    const hys = tuning.hysteresis;
    const cd = Math.hypot(view.eye[0]! - w[12]!, view.eye[1]! - w[13]!, view.eye[2]! - w[14]!);
    const nearWorld = Math.max(0, cd - this.reach * ws);
    const near = nearWorld * toDistance;
    this.moveSq = (nearWorld * REPICK_MOVE_FRACTION) ** 2;
    const far = (cd + this.reach * ws) * toDistance;
    const sLo = this.minScale * ws;
    const sHi = this.maxScale * ws;
    // Wholly near: level 0; wholly past the cull distance of every group: the cull level.
    let allNear = true;
    for (const g of groups) if (g.distances.length > 1 && far >= g.distances[1]! * sLo * (1 - hys)) allNear = false;
    let allCulled = groups.length > 0;
    for (const g of groups) if (!g.culls || near < g.distances[g.distances.length - 1]! * sHi) allCulled = false;
    const dc = cd * toDistance;
    const sc = (this.copies.count > 0 ? this.scaleSum / this.copies.count : 1) * ws;
    let changed = false;
    for (let gi = 0; gi < groups.length; gi += 1) {
      const dist = groups[gi]!.distances;
      const current = this.levels[gi]!;
      let l: number;
      if (allNear) l = 0;
      else if (allCulled) l = dist.length - 1;
      else {
        // The rule of `pickLodLevel` at the chunk's centre for the copies' mean size.
        l = 1;
        for (; l < dist.length; l += 1) if (dc < dist[l]! * sc * (current === l ? 1 - hys : 1)) break;
        l -= 1;
      }
      if (l === current) continue;
      if (current >= 0) tuning.copySwitches += this.copies.count;
      if (current >= 0 || l !== 0) changed = true;
      this.levels[gi] = l;
    }
    return changed;
  }
}
