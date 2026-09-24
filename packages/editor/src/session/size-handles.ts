/**
 * Phase 14.0: Scene-view size handles — the pure geometry.
 *
 * Every component with a 2D size on the game plane gets two handles while its
 * entity is selected: one on the top edge (drags the height) and one on the
 * right side (drags the width, or a capsule's radius). The player's capsule
 * keeps its feet where they are while its top moves (the height and the
 * offset change together); an enemy's box stands on its feet the same way;
 * every other box (trigger, switch, pickup, game zone, box collider, fog
 * volume) stays centred on its entity. A drag previews locally and commits
 * one `setComponent` on release (one undo step), like the mover waypoint
 * handles of phase 9.12.
 *
 * Pure: no DOM, no three.js.
 */
import { CAPSULE_LIMITS, controllerCapsuleOf } from '@thirdlight/runtime';

import type { ProjectedEntity } from './projection';

/**
 * The size snapping step (m): the dragged size lands on a multiple of it
 * while snapping is on (Shift or the snap toggle turn it off). 5 cm is fine
 * enough for a character's or a trigger's size in any genre and still gives
 * round numbers.
 */
export const SNAP_SIZE_M = 0.05;

export type SizeHandle = 'top' | 'side';
export type SizeComponent = 'controller' | 'gameZone' | 'trigger' | 'switch' | 'pickup' | 'enemy' | 'collider' | 'fogVolume';

export interface SizeShape {
  entityId: string;
  component: SizeComponent;
  kind: 'capsule' | 'box';
  /** The shape's centre on the game plane (world). */
  center: { x: number; y: number };
  /** Half extents; a capsule's are (radius, height / 2). */
  half: { x: number; y: number };
  /** Rotation about Z (a box collider only). */
  angle: number;
  /** Which edge a top drag keeps in place: the bottom (capsule, enemy) or the centre (the rest). */
  anchor: 'bottom' | 'center';
  /** The entity position (a capsule's offset is measured from it). */
  origin: { x: number; y: number };
  /** A fog volume's depth (kept as it is). */
  depth?: number;
}

const N = (v: number | undefined): number => v ?? 0;
const round3 = (v: number): number => Math.round(v * 1000) / 1000;

/** The shapes of one entity that have size handles. */
export function sizeShapesOf(e: ProjectedEntity): SizeShape[] {
  const x = N(e.position[0]);
  const y = N(e.position[1]);
  const origin = { x, y };
  const out: SizeShape[] = [];
  const box = (component: SizeComponent, size: readonly number[] | undefined, anchor: 'bottom' | 'center' = 'center'): void => {
    if (size === undefined || size.length < 2) return;
    const hx = N(size[0]) / 2;
    const hy = N(size[1]) / 2;
    out.push({ entityId: e.id, component, kind: 'box', center: { x, y: anchor === 'bottom' ? y + hy : y }, half: { x: hx, y: hy }, angle: 0, anchor, origin });
  };
  if (e.controller === true) {
    const c = controllerCapsuleOf(e.capsule === undefined ? {} : { capsule: e.capsule });
    out.push({ entityId: e.id, component: 'controller', kind: 'capsule', center: { x: x + c.offset[0], y: y + c.offset[1] }, half: { x: c.radius, y: c.height / 2 }, angle: 0, anchor: 'bottom', origin });
  }
  if (e.gameZone !== undefined) box('gameZone', e.gameZone.size);
  const b = e.blocks ?? {};
  for (const k of ['trigger', 'switch', 'pickup'] as const) box(k, (b[k] as { size?: number[] } | undefined)?.size);
  box('enemy', (b.enemy as { size?: number[] } | undefined)?.size, 'bottom');
  const shape = (e.collider as { shape?: { type?: string; hx?: number; hy?: number } } | undefined)?.shape;
  if (shape?.type === 'box' && typeof shape.hx === 'number' && typeof shape.hy === 'number') {
    out.push({ entityId: e.id, component: 'collider', kind: 'box', center: { x, y }, half: { x: shape.hx, y: shape.hy }, angle: 2 * Math.atan2(N(e.rotation[2]), N(e.rotation[3])), anchor: 'center', origin });
  }
  if (e.fogVolume !== undefined) {
    box('fogVolume', e.fogVolume.size);
    out[out.length - 1]!.depth = e.fogVolume.size[2];
  }
  return out;
}

/** Rotate a local offset by the shape's angle. */
function toWorld(s: SizeShape, lx: number, ly: number): { x: number; y: number } {
  const c = Math.cos(s.angle);
  const n = Math.sin(s.angle);
  return { x: s.center.x + lx * c - ly * n, y: s.center.y + lx * n + ly * c };
}

/** Where a handle sits (world, game plane): the middle of the top edge, the middle of the right side. */
export function handlePoint(s: SizeShape, handle: SizeHandle): { x: number; y: number } {
  return handle === 'top' ? toWorld(s, 0, s.half.y) : toWorld(s, s.half.x, 0);
}

/** The shape's outline (world, closed), for drawing and the drag preview. */
export function outlinePoints(s: SizeShape, segments = 12): { x: number; y: number }[] {
  if (s.kind === 'box') {
    const { x: hx, y: hy } = s.half;
    return [[-hx, -hy], [hx, -hy], [hx, hy], [-hx, hy], [-hx, -hy]].map(([a, b]) => toWorld(s, a!, b!));
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

/** The size range of each component (m, full sizes; a capsule's radius and height). */
const RANGE: Record<Exclude<SizeComponent, 'controller'>, { min: number; max: number }> = {
  gameZone: { min: 0.05, max: 1e6 },
  trigger: { min: 0.05, max: 500 },
  switch: { min: 0.05, max: 100 },
  pickup: { min: 0.05, max: 20 },
  enemy: { min: 0.1, max: 20 },
  // A box collider's half extent is at most 64 m (project-model §10.7).
  collider: { min: 0.01, max: 128 },
  fogVolume: { min: 0.05, max: 1000 },
};

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));
const snapTo = (v: number, snap: boolean): number => (snap ? Math.round(v / SNAP_SIZE_M) * SNAP_SIZE_M : v);

/**
 * The shape after dragging `handle` to the game-plane point `hit`. Sizes snap
 * to `SNAP_SIZE_M` when `snap` is on and stay inside the component's range.
 */
export function resizeShape(s: SizeShape, handle: SizeHandle, hit: { x: number; y: number }, snap: boolean): SizeShape {
  // The pointer in the shape's own frame (rotation undone), relative to its centre.
  const c = Math.cos(-s.angle);
  const n = Math.sin(-s.angle);
  const dx = hit.x - s.center.x;
  const dy = hit.y - s.center.y;
  const lx = dx * c - dy * n;
  const ly = dx * n + dy * c;
  if (s.kind === 'capsule') {
    const L = CAPSULE_LIMITS;
    if (handle === 'side') {
      const radius = clamp(snapTo(Math.abs(lx), snap), L.minRadius, Math.min(L.maxRadius, s.half.y));
      return { ...s, half: { x: round3(radius), y: s.half.y } };
    }
    const bottom = s.center.y - s.half.y;
    const height = round3(clamp(snapTo(hit.y - bottom, snap), Math.max(L.minHeight, 2 * s.half.x), L.maxHeight));
    return { ...s, center: { x: s.center.x, y: bottom + height / 2 }, half: { x: s.half.x, y: height / 2 } };
  }
  const range = RANGE[s.component as Exclude<SizeComponent, 'controller'>];
  if (handle === 'side') {
    const w = round3(clamp(snapTo(2 * Math.abs(lx), snap), range.min, range.max));
    return { ...s, half: { x: w / 2, y: s.half.y } };
  }
  if (s.anchor === 'bottom') {
    const bottom = s.center.y - s.half.y;
    const h = round3(clamp(snapTo(hit.y - bottom, snap), range.min, range.max));
    return { ...s, center: { x: s.center.x, y: bottom + h / 2 }, half: { x: s.half.x, y: h / 2 } };
  }
  const h = round3(clamp(snapTo(2 * Math.abs(ly), snap), range.min, range.max));
  return { ...s, half: { x: s.half.x, y: h / 2 } };
}

/** The `setComponent` value that stores a (resized) shape. */
export function sizeEdit(s: SizeShape): { component: SizeComponent; value: Record<string, unknown> } {
  if (s.kind === 'capsule') {
    const offset: [number, number] = [round3(s.center.x - s.origin.x), round3(s.center.y - s.origin.y)];
    return { component: 'controller', value: { capsule: { radius: round3(s.half.x), height: round3(2 * s.half.y), ...(offset[0] !== 0 || offset[1] !== 0 ? { offset } : {}) } } };
  }
  const w = round3(2 * s.half.x);
  const h = round3(2 * s.half.y);
  if (s.component === 'collider') return { component: 'collider', value: { shape: { type: 'box', hx: round3(s.half.x), hy: round3(s.half.y) } } };
  if (s.component === 'fogVolume') return { component: 'fogVolume', value: { size: [w, h, s.depth ?? 1] } };
  return { component: s.component, value: { size: [w, h] } };
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
export function capsuleDistance(s: SizeShape, p: { x: number; y: number }): number {
  const seg = Math.max(0, s.half.y - s.half.x);
  const cy = clamp(p.y, s.center.y - seg, s.center.y + seg);
  return Math.hypot(p.x - s.center.x, p.y - cy) - s.half.x;
}
