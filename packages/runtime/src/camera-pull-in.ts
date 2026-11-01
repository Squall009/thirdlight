/**
 * A follow camera's pull-in: how far from its target it sits when colliders
 * stand in the way. Pure and counted in whole fixed steps, so a replay, the
 * simulation worker and a second run move it alike.
 *
 * Each step the brain casts a sphere of the camera's radius from the target
 * out to the distance the rig wants; where it first meets a collider is the
 * clear distance. Then:
 * - closer than the camera is: while only the sphere grazes an edge (the
 *   camera still sees its target), it moves in at a speed that crosses its
 *   whole distance in the in time; when a collider hides the target, or the
 *   move would start in or pass into one, it goes straight to the clear
 *   distance instead, as a cut (the frames drawn between the two steps do
 *   not slide through the wall). So it never sits behind or inside a wall,
 *   and its near plane is never in one;
 * - farther than the camera is after it was pulled in: it holds for the hold
 *   time (a doorway or a pillar passing by does not pump it), then eases out
 *   to the clear distance over the out time;
 * - a camera that was not pulled in follows the rig's distance at once (a
 *   player's zoom is not eased).
 * Going live (or a fresh run) starts at the clear distance.
 */
import { VIRTUAL_CAMERA_DEFAULTS as VCD } from '@thirdlight/project-model';

import type { CameraWorld } from './camera-brain';
import { clampNum, easeInOut, type V3 } from './camera-rig';

export type PullInPhase = 'rest' | 'in' | 'hold' | 'out';

/** A camera's pull-in between steps (`newPullIn` to start over). */
export interface PullInState {
  /** The distance it sits at (null: none yet; the next step starts at the clear distance). */
  dist: number | null;
  phase: PullInPhase;
  /** Steps into the hold or the ease out. */
  steps: number;
  /** Where the ease out started. */
  outFrom: number;
  /** The last step jumped past a collider: the view cuts instead of interpolating across it. */
  cut: boolean;
}

/** A camera's times in seconds (0: at once). */
export interface PullInTimes {
  readonly inTime: number;
  readonly holdTime: number;
  readonly outTime: number;
}

/** Distances closer than this are the same (no hold or ease for rounding). */
const EPS = 1e-6;

export function newPullIn(): PullInState {
  return { dist: null, phase: 'rest', steps: 0, outFrom: 0, cut: false };
}

/** Start over (going live, a new run). */
export function resetPullIn(st: PullInState): void {
  st.dist = null;
  st.phase = 'rest';
  st.steps = 0;
  st.outFrom = 0;
  st.cut = false;
}

/**
 * One fixed step: the distance the camera sits at. `wanted` is the rig's
 * distance, `clear` how far the sphere went before it met a collider
 * (`wanted` or more: nothing in the way), `blocked(from, to)` whether the
 * target is hidden from distance `from`, or the sphere there overlaps a
 * collider or meets one moving to `to` (asked only while it moves in).
 */
export function stepPullIn(st: PullInState, wanted: number, clear: number, blocked: (from: number, to: number) => boolean, times: PullInTimes, hz: number): number {
  const allowed = clampNum(Math.min(wanted, clear), 0, Math.max(0, wanted));
  const d = st.dist;
  st.cut = false;
  if (d === null) {
    st.dist = allowed;
    st.phase = allowed < wanted - EPS ? 'in' : 'rest';
    st.steps = 0;
    return allowed;
  }
  let next: number;
  if (allowed < d - EPS) {
    // Something came between: in, fast, and never left behind or inside it.
    const candidate = times.inTime > 0 ? Math.max(allowed, d - Math.max(1, wanted) / times.inTime / hz) : allowed;
    if (blocked(d, candidate)) {
      next = allowed;
      st.cut = true;
    } else next = candidate;
    st.phase = 'in';
    st.steps = 0;
  } else if (allowed > d + EPS) {
    if (st.phase === 'rest') {
      // Not pulled in: the rig's own distance (a zoom) at once.
      next = allowed;
    } else {
      if (st.phase === 'in') {
        st.phase = 'hold';
        st.steps = 0;
      }
      if (st.phase === 'hold') {
        st.steps += 1;
        if (st.steps >= Math.round(Math.max(0, times.holdTime) * hz)) {
          st.phase = 'out';
          st.steps = 0;
          st.outFrom = d;
        }
      }
      if (st.phase === 'out') {
        st.steps += 1;
        const total = Math.round(Math.max(0, times.outTime) * hz);
        const t = total > 0 ? clampNum(st.steps / total, 0, 1) : 1;
        // Eased toward where it may go now (the way out may narrow or widen meanwhile), never past it.
        next = Math.min(allowed, st.outFrom + (allowed - st.outFrom) * easeInOut(t));
        if (t >= 1) next = allowed;
      } else next = d;
    }
  } else next = allowed;
  if (Math.abs(next - allowed) <= EPS && allowed >= wanted - EPS) {
    st.phase = 'rest';
    st.steps = 0;
  }
  st.dist = next;
  return next;
}

/** Metres short of the clear distance a move in may end without counting as meeting what the cast stopped at. */
const PULL_TOUCH = 1e-3;

const num = (v: unknown, fallback: number): number => (typeof v === 'number' && Number.isFinite(v) ? v : fallback);

/**
 * A follow camera's distance this step with colliders in the way: the sphere
 * of its radius cast out from the pivot `pv` along the unit `off` (a ray, less
 * the radius, where the world casts no sphere), then `st` stepped. Without a
 * physics world it sits at `dist`. `st.cut` says the step jumped past a
 * collider.
 */
export function pullInDistance(
  st: PullInState,
  d: { readonly collisionRadius?: number; readonly pullInTime?: number; readonly pullHoldTime?: number; readonly pullOutTime?: number },
  world: CameraWorld,
  pv: readonly number[],
  off: readonly number[],
  dist: number,
  hz: number,
): number {
  const radius = num(d.collisionRadius, VCD.collisionRadius);
  const origin: V3 = [pv[0]!, pv[1]!, pv[2]!];
  const dir: V3 = [off[0]!, off[1]!, off[2]!];
  const back: V3 = [-dir[0], -dir[1], -dir[2]];
  const sphere = world.castSphere !== undefined && radius > 0;
  let clear = Infinity;
  if (sphere) {
    const hit = world.castSphere!(origin, dir, radius, dist);
    if (hit !== null && Number.isFinite(hit.distance)) clear = hit.distance;
  } else if (world.raycast !== undefined) {
    const hit = world.raycast(origin, dir, dist + radius);
    if (hit !== null && Number.isFinite(hit.distance)) clear = hit.distance - radius;
  } else return dist;
  const at = (k: number): V3 => [origin[0] + dir[0] * k, origin[1] + dir[1] * k, origin[2] + dir[2] * k];
  // Its target hidden behind a collider, starting in one, or meeting one on the way in (a touch at the very end
  // is where the cast stopped): straight to the clear distance. Only a sphere grazing past an edge eases in.
  const blocked = (from: number, to: number): boolean => {
    if (world.raycast?.(origin, dir, from) != null) return true;
    if (radius > 0 && world.sphereOverlaps?.(at(from), radius) === true) return true;
    const span = from - to - PULL_TOUCH;
    if (!(span > 0)) return false;
    if (sphere) return world.castSphere!(at(from), back, radius, span) !== null;
    return world.raycast?.(at(from), back, span) != null;
  };
  return stepPullIn(st, dist, clear, blocked, { inTime: num(d.pullInTime, VCD.pullInTime), holdTime: num(d.pullHoldTime, VCD.pullHoldTime), outTime: num(d.pullOutTime, VCD.pullOutTime) }, hz);
}
