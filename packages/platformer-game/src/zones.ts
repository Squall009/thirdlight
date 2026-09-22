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
import type { GameZoneRole, Vec2 } from '@thirdlight/runtime';
import { CAPSULE_HALF_HEIGHT, CAPSULE_RADIUS, ZONE_OVERLAP_EPS } from './constants';

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
 * `from`/`to` are capsule **centres**; `zone` is the frozen
 * `GameZoneSpec`-shaped geometry (`center` + half-extents). The `d²`
 * comparison against `(R − EPS)²` is the hot path; `d` and the components are
 * reported for the fixtures and diagnostics.
 */
export function zoneOverlap(from: Vec2, to: Vec2, zone: ZoneGeometry): ZoneTest {
  // The swept centre-line set is exactly the rectangle
  // [rx0, rx1] × [ry0, ry1] (§4.2 derivation), extended by the capsule's
  // centre-line half height in Y.
  const rx0 = Math.min(from.x, to.x);
  const rx1 = Math.max(from.x, to.x);
  const ry0 = Math.min(from.y, to.y) - CAPSULE_HALF_HEIGHT;
  const ry1 = Math.max(from.y, to.y) + CAPSULE_HALF_HEIGHT;
  const zx0 = zone.center.x - zone.half.x;
  const zx1 = zone.center.x + zone.half.x;
  const zy0 = zone.center.y - zone.half.y;
  const zy1 = zone.center.y + zone.half.y;
  const dx = Math.max(0, rx0 - zx1, zx0 - rx1);
  const dy = Math.max(0, ry0 - zy1, zy0 - ry1);
  const d2 = dx * dx + dy * dy;
  const limit = CAPSULE_RADIUS - ZONE_OVERLAP_EPS;
  const overlap = d2 < limit * limit;
  const tangent = !overlap && d2 <= (CAPSULE_RADIUS + ZONE_OVERLAP_EPS) * (CAPSULE_RADIUS + ZONE_OVERLAP_EPS);
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
  /** The last completed motion segment's capsule centres. */
  readonly from: Vec2;
  readonly to: Vec2;
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
  const zones = [...input.zones].sort(byEntityId);
  const tests = zones.map((zone) => ({ zone, hit: zoneOverlap(input.from, input.to, zone) }));
  const overlapping = (role: GameZoneRole): (typeof tests)[number][] =>
    tests.filter((t) => t.zone.role === role && t.hit.overlap);

  const hazards = overlapping('hazard');
  if (hazards.length > 0) {
    return { kind: 'death', cause: 'hazard', zoneId: hazards[0]!.zone.entityId };
  }
  if (input.to.y < input.killY) {
    return { kind: 'death', cause: 'fall' };
  }
  const checkpoint = overlapping('checkpoint')[0];
  if (input.run.checkpointId === null && checkpoint !== undefined) {
    return { kind: 'checkpoint', zoneId: checkpoint.zone.entityId };
  }
  const goal = overlapping('goal')[0];
  if (goal !== undefined) {
    return { kind: 'goal', zoneId: goal.zone.entityId };
  }
  return { kind: 'none' };
}
