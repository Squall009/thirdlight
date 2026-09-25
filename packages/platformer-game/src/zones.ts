/**
 * The pure gameplay-zone service — `docs/contracts/gameplay.md` §4.
 *
 * A **predicate**, never a movement solver (§4.6): it produces, alters,
 * clamps and vetoes no motion, writes no transform, steps no port, reads no
 * physics world, holds no dynamic body/broadphase/ray/sensor, runs no
 * iteration loop and is never a collision response. It is one closed-form
 * distance over the runtime-provided committed motion segment plus at most 64
 * frozen axis-aligned rectangles, invoked once per executed step.
 *
 * Imports `@thirdlight/runtime` **types only** (dependencies.md §4.1).
 */
import type { GameZoneRole, PlayerCapsule, Vec2 } from '@thirdlight/runtime';
import { ZONE_OVERLAP_EPS } from './constants';

/** The closed-form classification of one segment against one zone. */
export interface ZoneTest {
  /** Axis-aligned rectangle distance components (§4.2 `dx`/`dy`). */
  readonly dx: number;
  readonly dy: number;
  /** `hypot(dx, dy)` — the rectangle-to-rectangle distance. */
  readonly d: number;
  /** `d < R − EPS`. */
  readonly overlap: boolean;
  /** `|d − R| ≤ EPS` — the tangency bucket (⇒ never an overlap). */
  readonly tangent: boolean;
  readonly classification: 'overlap' | 'tangent' | 'separate';
}

/**
 * The swept upright-capsule vs axis-aligned XY rectangle predicate
 * (`gameplay.md` §4.2, normative closed form).
 *
 * `from`/`to` are the player's positions (entity origins); the capsule
 * (phase 14.0: the player's own) is centred at each plus `capsule.offset`.
 * `zone` is the frozen `GameZoneSpec`-shaped geometry (`center` +
 * half-extents). The `d²` comparison against `(R − EPS)²` is the hot path;
 * `d` and the components are reported for the fixtures and diagnostics.
 */
/** `zoneOverlap(...).overlap` without the report object (the same arithmetic). */
function sweptOverlap(from: Vec2, to: Vec2, zone: ZoneGeometry, capsule: PlayerCapsule): boolean {
  const fx = from.x + capsule.offset.x;
  const tx = to.x + capsule.offset.x;
  const fy = from.y + capsule.offset.y;
  const ty = to.y + capsule.offset.y;
  const rx0 = Math.min(fx, tx);
  const rx1 = Math.max(fx, tx);
  const ry0 = Math.min(fy, ty) - capsule.halfHeight;
  const ry1 = Math.max(fy, ty) + capsule.halfHeight;
  const zx0 = zone.center.x - zone.half.x;
  const zx1 = zone.center.x + zone.half.x;
  const zy0 = zone.center.y - zone.half.y;
  const zy1 = zone.center.y + zone.half.y;
  const dx = Math.max(0, rx0 - zx1, zx0 - rx1);
  const dy = Math.max(0, ry0 - zy1, zy0 - ry1);
  const d2 = dx * dx + dy * dy;
  const limit = capsule.radius - ZONE_OVERLAP_EPS;
  return d2 < limit * limit;
}

export function zoneOverlap(from: Vec2, to: Vec2, zone: ZoneGeometry, capsule: PlayerCapsule): ZoneTest {
  // The swept centre-line set is exactly the rectangle
  // [rx0, rx1] × [ry0, ry1] (§4.2 derivation), extended by the capsule's
  // centre-line half height in Y.
  const fx = from.x + capsule.offset.x;
  const tx = to.x + capsule.offset.x;
  const fy = from.y + capsule.offset.y;
  const ty = to.y + capsule.offset.y;
  const rx0 = Math.min(fx, tx);
  const rx1 = Math.max(fx, tx);
  const ry0 = Math.min(fy, ty) - capsule.halfHeight;
  const ry1 = Math.max(fy, ty) + capsule.halfHeight;
  const zx0 = zone.center.x - zone.half.x;
  const zx1 = zone.center.x + zone.half.x;
  const zy0 = zone.center.y - zone.half.y;
  const zy1 = zone.center.y + zone.half.y;
  const dx = Math.max(0, rx0 - zx1, zx0 - rx1);
  const dy = Math.max(0, ry0 - zy1, zy0 - ry1);
  const d2 = dx * dx + dy * dy;
  const limit = capsule.radius - ZONE_OVERLAP_EPS;
  const overlap = d2 < limit * limit;
  const tangent = !overlap && d2 <= (capsule.radius + ZONE_OVERLAP_EPS) * (capsule.radius + ZONE_OVERLAP_EPS);
  const d = Math.sqrt(d2);
  return {
    dx,
    dy,
    d,
    overlap,
    tangent,
    classification: overlap ? 'overlap' : tangent ? 'tangent' : 'separate',
  };
}

/** The frozen zone geometry the predicate consumes (`gameplay.md` §4.1). */
export interface ZoneGeometry {
  readonly center: Vec2;
  /** Half-extents (`size / 2`, §4.1) — not the authored full extents. */
  readonly half: Vec2;
}

/** A zone rectangle plus the identity/role the decision needs. */
export interface GameZoneRect extends ZoneGeometry {
  readonly entityId: string;
  readonly role: GameZoneRole;
}

/**
 * One per-step gameplay decision (`gameplay.md` §4.3), discriminated so the
 * consumer never needs a cast.
 */
export type ZoneDecision =
  | { readonly kind: 'none' }
  | { readonly kind: 'death'; readonly cause: 'hazard'; readonly zoneId: string }
  | { readonly kind: 'death'; readonly cause: 'fall' }
  | { readonly kind: 'checkpoint'; readonly zoneId: string }
  | { readonly kind: 'goal'; readonly zoneId: string };

export interface StepZonesInput {
  /** The committed run data the decision reads (read-only). */
  readonly run: { readonly checkpointId: string | null };
  /** The frozen zones; the caller passes `GameContent.zones` (ascending id). */
  readonly zones: readonly GameZoneRect[];
  /** `content.game.killY` — the strict fall threshold. */
  readonly killY: number;
  /** The last completed motion segment (the player's positions). */
  readonly from: Vec2;
  readonly to: Vec2;
  /** Phase 14.0: the player's capsule (`GameContent.player.capsule`). */
  readonly capsule: PlayerCapsule;
}

function byEntityId(a: GameZoneRect, b: GameZoneRect): number {
  return a.entityId < b.entityId ? -1 : a.entityId > b.entityId ? 1 : 0;
}

/**
 * The exhaustive same-step decision (`gameplay.md` §4.3, first match wins):
 *
 * 1. death by hazard (lowest `entityId` among overlapping hazards);
 * 2. death by fall (`to.y < killY`, strict, no epsilon);
 * 3. checkpoint — only while `checkpointId === null` (single activation);
 * 4. goal — the lowest `entityId` that overlaps;
 * 5. otherwise nothing.
 *
 * Ties within a role are broken by ascending `entityId` codepoint order
 * regardless of the caller's array order, so the result never depends on
 * document order.
 */
export function stepZones(input: StepZonesInput): ZoneDecision {
  return decideZones(input.run.checkpointId, input.zones, input.killY, input.from, input.to, input.capsule);
}

const NO_DECISION: ZoneDecision = Object.freeze({ kind: 'none' });

/** The zones in ascending `entityId` order (the caller's array itself when it already is). */
function sortedById(zones: readonly GameZoneRect[]): readonly GameZoneRect[] {
  for (let i = 1; i < zones.length; i += 1) if (byEntityId(zones[i - 1]!, zones[i]!) > 0) return [...zones].sort(byEntityId);
  return zones;
}

/**
 * `stepZones` over plain arguments (phase 21.2: one pass, no per-zone test
 * objects; the same predicate as `zoneOverlap`, the same first-match order).
 */
export function decideZones(
  checkpointId: string | null,
  zonesIn: readonly GameZoneRect[],
  killY: number,
  from: Vec2,
  to: Vec2,
  capsule: PlayerCapsule,
): ZoneDecision {
  const zones = sortedById(zonesIn);
  let hazard: GameZoneRect | null = null;
  let checkpoint: GameZoneRect | null = null;
  let goal: GameZoneRect | null = null;
  for (let i = 0; i < zones.length; i += 1) {
    const zone = zones[i]!;
    const role = zone.role;
    if (role === 'hazard') {
      if (hazard === null && sweptOverlap(from, to, zone, capsule)) hazard = zone;
    } else if (role === 'checkpoint') {
      if (checkpoint === null && sweptOverlap(from, to, zone, capsule)) checkpoint = zone;
    } else if (role === 'goal') {
      if (goal === null && sweptOverlap(from, to, zone, capsule)) goal = zone;
    }
  }
  if (hazard !== null) {
    return { kind: 'death', cause: 'hazard', zoneId: hazard.entityId };
  }
  if (to.y < killY) {
    return { kind: 'death', cause: 'fall' };
  }
  if (checkpointId === null && checkpoint !== null) {
    return { kind: 'checkpoint', zoneId: checkpoint.entityId };
  }
  if (goal !== null) {
    return { kind: 'goal', zoneId: goal.entityId };
  }
  return NO_DECISION;
}
