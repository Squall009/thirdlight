/**
 * Phase 14.0: the player's collision capsule in the Scene view — the pure
 * geometry of its outline (drawn with the collider outlines, clickable) and
 * "Fit to model".
 *
 * Phase 15.2: dragging sizes moved to the descriptor-driven handle system
 * (`handles.ts`), which covers the capsule, every area, the colliders and
 * the rest; this file keeps what the outline and "Fit to model" need.
 *
 * Pure: no DOM, no three.js.
 */
import { CAPSULE_LIMITS, controllerCapsuleOf } from '@thirdlight/runtime';

import type { ProjectedEntity } from './projection';

export { SNAP_SIZE_M } from './handles';

export interface SizeShape {
  entityId: string;
  kind: 'capsule' | 'circle';
  /** The shape's centre on the game plane (world). */
  center: { x: number; y: number };
  /** Half extents; a capsule's are (radius, height / 2), a circle's (radius, radius). */
  half: { x: number; y: number };
}

const N = (v: number | undefined): number => v ?? 0;
const round3 = (v: number): number => Math.round(v * 1000) / 1000;
const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

/** A player's capsule on the game plane (its own, or the default one); null without a controller. */
export function capsuleShapeOf(e: ProjectedEntity): SizeShape | null {
  if (e.controller !== true) return null;
  const c = controllerCapsuleOf(e.capsule === undefined ? {} : { capsule: e.capsule });
  return { entityId: e.id, kind: 'capsule', center: { x: N(e.position[0]) + c.offset[0], y: N(e.position[1]) + c.offset[1] }, half: { x: c.radius, y: c.height / 2 } };
}

/** The shape's outline (world, closed), for drawing. */
export function outlinePoints(s: Pick<SizeShape, 'kind' | 'center' | 'half'>, segments = 12): { x: number; y: number }[] {
  if (s.kind === 'circle') {
    const n = Math.max(8, segments * 2);
    const pts = Array.from({ length: n }, (_, i) => ({ x: s.center.x + s.half.x * Math.cos((i / n) * 2 * Math.PI), y: s.center.y + s.half.x * Math.sin((i / n) * 2 * Math.PI) }));
    pts.push({ ...pts[0]! });
    return pts;
  }
  // A capsule: two half circles joined by the straight sides.
  const r = s.half.x;
  const seg = Math.max(0, s.half.y - r);
  const pts: { x: number; y: number }[] = [];
  for (let i = 0; i <= segments; i++) {
    const a = (i / segments) * Math.PI;
    pts.push({ x: s.center.x + r * Math.cos(a), y: s.center.y + seg + r * Math.sin(a) });
  }
  for (let i = 0; i <= segments; i++) {
    const a = Math.PI + (i / segments) * Math.PI;
    pts.push({ x: s.center.x + r * Math.cos(a), y: s.center.y - seg + r * Math.sin(a) });
  }
  pts.push({ ...pts[0]! });
  return pts;
}

/**
 * "Fit to model": the capsule for a model's bounding box (relative to the
 * entity origin; the entity is upright and unscaled, as every physics body
 * is): as tall as the model with its feet at the model's lowest point, the
 * radius half the smaller of width and depth, clamped to the capsule ranges.
 */
export function fitCapsule(bounds: { min: readonly number[]; max: readonly number[] }): { radius: number; height: number; offset: [number, number] } | null {
  const size = [0, 1, 2].map((i) => N(bounds.max[i]) - N(bounds.min[i]));
  if (!size.every((v) => Number.isFinite(v) && v > 0)) return null;
  const L = CAPSULE_LIMITS;
  const height = round3(clamp(size[1]!, L.minHeight, L.maxHeight));
  const radius = round3(clamp(Math.min(size[0]!, size[2]!) / 2, L.minRadius, Math.min(L.maxRadius, height / 2)));
  const bottom = N(bounds.min[1]);
  return { radius, height, offset: [round3((N(bounds.min[0]) + N(bounds.max[0])) / 2), round3(bottom + height / 2)] };
}

/** The distance from a game-plane point to a capsule's outline (negative inside). */
export function capsuleDistance(s: Pick<SizeShape, 'center' | 'half'>, p: { x: number; y: number }): number {
  const seg = Math.max(0, s.half.y - s.half.x);
  const cy = clamp(p.y, s.center.y - seg, s.center.y + seg);
  return Math.hypot(p.x - s.center.x, p.y - cy) - s.half.x;
}
