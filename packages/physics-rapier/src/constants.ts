/**
 * Contract constants shared by the adapter and its tests (physics.md §6/§7/§8,
 * project-model §10.7/§21.6, decision 0002 §1.2). These are **contract
 * constants, not settings**: changing one changes replay semantics and the
 * frozen packet-14 course evidence, so they are not parameters of
 * `createPhysicsPort` (which only carries the resolved gameplay settings:
 * gravity, and the two slope angles).
 */

/** The approved physics pin (dependencies.md §7; decision 0002 §1.2 item 1). */
export const RAPIER_PIN = '0.20.0' as const;

/** The value of `PhysicsPort.implementation` for this adapter. */
export const PHYSICS_IMPLEMENTATION = 'rapier2d-compat@0.20.0' as const;

/** Fixed solver timestep (runtime.md §5: 120 Hz). */
export const FIXED_HZ = 120 as const;

/** Character capsule: radius 0.3 m, half-height 0.6 m (total height 1.8 m). */
export const CAPSULE_RADIUS = 0.3 as const;
export const CAPSULE_HALF_HEIGHT = 0.6 as const;

/** Character controller gap kept between the capsule and the world. */
export const CONTROLLER_OFFSET_SKIN = 0.01 as const;

/** `enableSnapToGround(distance)` — the maximum ground snap applied per step. */
export const GROUND_SNAP_DISTANCE = 0.1 as const;

/**
 * The capsule's total half-height along Y (gameplay.md §5.2 clearance probe):
 * the cylinder half-height plus the end-sphere radius. The capsule centre's
 * lowest point is `center.y − (CAPSULE_HALF_HEIGHT + CAPSULE_RADIUS)`.
 */
export const CAPSULE_TOTAL_HALF = CAPSULE_HALF_HEIGHT + CAPSULE_RADIUS;

/**
 * The clearance probe's penetration epsilon (gameplay.md §5.2): a
 * `contactShape` distance more negative than this is a real overlap (a
 * touch at distance ≈ 0 is not a block). 1e-6 matches the ground-normal
 * tolerance used elsewhere.
 */
export const CLEARANCE_PENETRATION_EPS = 1e-6 as const;

/**
 * The clearance probe's maximum downward support-search distance (gameplay.md
 * §5.2 `no_support`): a static collider at or within this distance below the
 * capsule's lowest point counts as support. Far larger than the authored
 * spawn gap (the fixture spawn sits 0.01 m above the resting centre) so a
 * normal spawn always resolves as supported, while a spawn over a pit
 * (no collider below) resolves as `no_support`.
 */
export const CLEARANCE_SUPPORT_PROBE = 1000 as const;

/** The ray origin epsilon above the capsule's lowest point (avoids a surface-coincident origin). */
export const CLEARANCE_RAY_EPS = 1e-4 as const;

/** Ground-contact classification tolerance (physics.md §7, §8). */
export const GROUND_NORMAL_TOLERANCE = 1e-6 as const;

/** Autostep is a contract constant: disabled (no automatic stair climbing). */
export const AUTOSTEP_DISABLED = false as const;

/** Collider shape limits (project-model §10.7/§21.3). */
export const MAX_SHAPE_VALUE = 1e6 as const;
export const MAX_POLYGON_VERTICES = 8 as const;
export const MIN_POLYGON_AREA = 1e-6 as const;
export const CONVEX_TOLERANCE = 1e-9 as const;
export const MAX_COLLIDER_HALF_EXTENT = 64 as const;

/** The project-model near-unit tolerance for the `x`/`y` quaternion parts. */
export const OFF_AXIS_TOLERANCE = 1e-6 as const;

/** Unit scale: the only scale a physics-bearing entity may carry. */
export const UNIT_SCALE: readonly [number, number, number] = [1, 1, 1];
