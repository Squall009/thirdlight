/**
 * World coordinates for a 10 km world, and the floating origin that keeps
 * rendering and physics precise anywhere in it.
 *
 * - **Authoritative positions are exact.** Voxels are integer cells (±32,768
 *   on x and z, ±8,192 on y; coords.ts); a free position is metres as a
 *   JavaScript number (a 64-bit float: about 2 nm resolution at 16 km).
 *   Neither ever loses precision with distance.
 * - **32-bit consumers work near an origin.** The GPU and the physics
 *   engine hold 32-bit floats, whose step at 10 km is about 1 mm, which
 *   shows as jitter in vertices, shadows and contacts. They hold positions
 *   relative to a render origin instead, computed in 64 bits and only then
 *   rounded, so what they see is always small.
 * - **Re-basing.** When the focus (camera or player) is more than the
 *   re-base distance from the origin on any axis, the origin moves to the
 *   focus, snapped to a whole chunk so chunk-local data (meshes, colliders)
 *   keeps exact integer offsets. Listeners get the shift and move their
 *   32-bit copies by it, before the next frame uses them.
 */
import { VOXEL_SIZE_M } from './coords';

/**
 * Default re-base distance (metres, per axis): about 1 km of travel. Within
 * it a 32-bit position relative to the origin has a step of at most
 * 2⁻¹³ m (0.12 mm) up to 1,024 m, so its rounding error is at most 0.06 mm.
 */
export const DEFAULT_REBASE_DISTANCE_M = 1000;

/** Cells the origin snaps to (one 32-cell chunk edge, 16 m): chunk-local offsets stay whole. */
export const ORIGIN_SNAP_CELLS = 32;

/** An origin move: the new origin and the shift every 32-bit position must take (new local = old local − shift). */
export interface RebaseEvent {
  /** The previous and the new origin, in cells. */
  readonly from: { readonly x: number; readonly y: number; readonly z: number };
  readonly to: { readonly x: number; readonly y: number; readonly z: number };
  /** to − from in metres (exact: a whole number of cells, at most a few km). */
  readonly shiftM: { readonly x: number; readonly y: number; readonly z: number };
}

export interface FloatingOriginOptions {
  /** Re-base when the focus is farther than this from the origin on any axis (metres). */
  readonly rebaseDistanceM?: number;
  /** The first origin, in cells (default 0, 0, 0; snapped). */
  readonly origin?: { readonly x: number; readonly y: number; readonly z: number };
}

function snap(cell: number): number {
  return Math.round(cell / ORIGIN_SNAP_CELLS) * ORIGIN_SNAP_CELLS;
}

export class FloatingOrigin {
  readonly rebaseDistanceM: number;
  private ox: number;
  private oy: number;
  private oz: number;
  private readonly listeners: Array<(e: RebaseEvent) => void> = [];
  /** Re-bases so far. */
  rebases = 0;

  constructor(opts: FloatingOriginOptions = {}) {
    this.rebaseDistanceM = opts.rebaseDistanceM ?? DEFAULT_REBASE_DISTANCE_M;
    if (!(this.rebaseDistanceM > 0) || !Number.isFinite(this.rebaseDistanceM)) throw new RangeError('the re-base distance must be positive');
    this.ox = snap(opts.origin?.x ?? 0);
    this.oy = snap(opts.origin?.y ?? 0);
    this.oz = snap(opts.origin?.z ?? 0);
  }

  /** The origin in cells (whole, a multiple of {@link ORIGIN_SNAP_CELLS}). */
  get origin(): { x: number; y: number; z: number } {
    return { x: this.ox, y: this.oy, z: this.oz };
  }

  /**
   * Listens for re-bases. Listeners run in registration order, inside
   * {@link FloatingOrigin.update}, before it returns: render and physics
   * shift their 32-bit positions there (subtract `shiftM`), so no frame ever
   * mixes the two origins.
   */
  onRebase(listener: (e: RebaseEvent) => void): void {
    this.listeners.push(listener);
  }

  /**
   * Checks the focus (world metres, 64-bit) and re-bases when it is past
   * the re-base distance on any axis; returns the event, or null.
   */
  update(fx: number, fy: number, fz: number): RebaseEvent | null {
    const d = this.rebaseDistanceM;
    const s = VOXEL_SIZE_M;
    if (Math.abs(fx - this.ox * s) <= d && Math.abs(fy - this.oy * s) <= d && Math.abs(fz - this.oz * s) <= d) return null;
    const from = { x: this.ox, y: this.oy, z: this.oz };
    this.ox = snap(fx / s);
    this.oy = snap(fy / s);
    this.oz = snap(fz / s);
    const to = { x: this.ox, y: this.oy, z: this.oz };
    const e: RebaseEvent = { from, to, shiftM: { x: (to.x - from.x) * s, y: (to.y - from.y) * s, z: (to.z - from.z) * s } };
    this.rebases++;
    for (const l of this.listeners) l(e);
    return e;
  }

  /** A world position (metres, 64-bit) relative to the origin, rounded to 32 bits into `out` at `at`. */
  toLocal(x: number, y: number, z: number, out: Float32Array, at = 0): Float32Array {
    const s = VOXEL_SIZE_M;
    out[at] = x - this.ox * s;
    out[at + 1] = y - this.oy * s;
    out[at + 2] = z - this.oz * s;
    return out;
  }

  /** A cell's minimum corner relative to the origin, in metres (exact for any cell in the world). */
  cellToLocal(cx: number, cy: number, cz: number, out: Float32Array, at = 0): Float32Array {
    const s = VOXEL_SIZE_M;
    out[at] = (cx - this.ox) * s;
    out[at + 1] = (cy - this.oy) * s;
    out[at + 2] = (cz - this.oz) * s;
    return out;
  }

  /** A position relative to the origin (metres) back to world metres (64-bit). */
  toWorld(lx: number, ly: number, lz: number): { x: number; y: number; z: number } {
    const s = VOXEL_SIZE_M;
    return { x: lx + this.ox * s, y: ly + this.oy * s, z: lz + this.oz * s };
  }
}
