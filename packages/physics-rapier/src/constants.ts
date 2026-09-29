/**
 * Constants shared by the adapter and its tests (physics.md,
 * project-model, decision 0002). The step rate,
 * skin, ground snap and autostep became data (the project's `fixed_step_hz`,
 * the player's `controller` tuning) handed to `createPhysicsPort`; the values
 * here are their defaults — the ones the frozen traces were made with, so a
 * project that sets none replays exactly. The rest are engine limits and
 * numeric tolerances.
 */
import { CONVEX_TOL, MAX_COLLIDER_EXTENT, MAX_LEN, MAX_POLYGON_VERTICES as MODEL_MAX_POLYGON_VERTICES, MIN_POLYGON_AREA as MODEL_MIN_POLYGON_AREA } from '@thirdlight/project-model/limits';

/** The approved physics pin. */
export const RAPIER_PIN = '0.20.0' as const;

/** The value of `PhysicsPort.implementation` for this adapter. */
export const PHYSICS_IMPLEMENTATION = 'rapier2d-compat@0.20.0' as const;

/** Fixed solver timestep (120 Hz): the default of the project's `fixed_step_hz`. */
export const FIXED_HZ = 120 as const;
/** The step rates a project may choose (`fixed_step_hz`). */
export const FIXED_HZ_CHOICES: readonly number[] = [60, 120, 240];

/**
 * The character capsule is the player's data (`controller.capsule`,
 * handed over as `character.radius`/`halfHeight`/`offset` in the init config).
 * These are only the fallback when a caller passes no capsule — the
 * project-model default (radius 0.3 m, centre-line half-height 0.6 m: 1.8 m
 * tall, an adult human).
 */
export const DEFAULT_CAPSULE_RADIUS = 0.3 as const;
export const DEFAULT_CAPSULE_HALF_HEIGHT = 0.6 as const;

/** Character controller gap kept between the capsule and the world (the default of `controller.skin`). */
export const CONTROLLER_OFFSET_SKIN = 0.01 as const;

/** `enableSnapToGround(distance)` — the maximum ground snap applied per step (the default of `controller.groundSnap`). */
export const GROUND_SNAP_DISTANCE = 0.1 as const;

/**
 * The clearance probe's penetration epsilon: a
 * `contactShape` distance more negative than this is a real overlap (a
 * touch at distance ≈ 0 is not a block). 1e-6 matches the ground-normal
 * tolerance used elsewhere.
 */
export const CLEARANCE_PENETRATION_EPS = 1e-6 as const;

/**
 * The clearance probe's maximum downward support-search distance (gameplay.md
 * `no_support`): a static collider at or within this distance below the
 * capsule's lowest point counts as support. Far larger than the authored
 * spawn gap (the fixture spawn sits 0.01 m above the resting centre) so a
 * normal spawn always resolves as supported, while a spawn over a pit
 * (no collider below) resolves as `no_support`.
 */
export const CLEARANCE_SUPPORT_PROBE = 1000 as const;

/** The ray origin epsilon above the capsule's lowest point (avoids a surface-coincident origin). */
export const CLEARANCE_RAY_EPS = 1e-4 as const;

/**
 * How far below a one-way platform's top the feet
 * may be and still land on it (a step's fall plus the controller's skin); the
 * sweep and the spawn clearance probe use the same rule.
 */
export const ONE_WAY_LANDING_TOLERANCE = 0.06 as const;

/** Ground-contact classification tolerance. */
export const GROUND_NORMAL_TOLERANCE = 1e-6 as const;

/** Autostep is off by default (`controller.autostep` turns it on). */
export const AUTOSTEP_DISABLED = false as const;

/** Collider shape limits (project-model's collider vocabulary). */
export const MAX_SHAPE_VALUE = MAX_LEN;
export const MAX_POLYGON_VERTICES = MODEL_MAX_POLYGON_VERTICES;
export const MIN_POLYGON_AREA = MODEL_MIN_POLYGON_AREA;
export const CONVEX_TOLERANCE = CONVEX_TOL;
export const MAX_COLLIDER_HALF_EXTENT = MAX_COLLIDER_EXTENT;

/** The project-model near-unit tolerance for the `x`/`y` quaternion parts. */
export const OFF_AXIS_TOLERANCE = 1e-6 as const;

/** Unit scale: the only scale a physics-bearing entity may carry. */
export const UNIT_SCALE: readonly [number, number, number] = [1, 1, 1];

/**
 * Internal edges: the ground-contact search reaches the skin and
 * the snap distance plus this slack; a contact normal counts as ground-like
 * when its up component exceeds `GROUND_UP_EPS`; a point is on another
 * collider's boundary within `INTERNAL_EDGE_TOUCH_EPS` (f32 collider
 * coordinates); the normal-cone probe pushes the point out by
 * `INTERNAL_EDGE_PROBE` and calls the normal outside the cone when the
 * projection back lands farther than `INTERNAL_EDGE_CONE_EPS` from it.
 */
export const INTERNAL_EDGE_PREDICTION_SLACK = 0.05 as const;
export const GROUND_UP_EPS = 1e-3 as const;
export const INTERNAL_EDGE_TOUCH_EPS = 1e-4 as const;
export const INTERNAL_EDGE_PROBE = 1 as const;
export const INTERNAL_EDGE_CONE_EPS = 1e-3 as const;
/** A contact normal whose up part is within this (about 3°) is a vertical wall (a polygon near a seam reports 0.003). */
export const WALL_NORMAL_EPS = 0.05 as const;
