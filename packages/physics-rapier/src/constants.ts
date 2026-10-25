/**
 * Constants of the adapter: the approved pin, engine limits and numeric
 * tolerances. The step rate and the controller tuning are data (the
 * project's `fixed_step_hz`, the player's `controller`) handed to the port.
 */
import { MAX_LEN } from '@thirdlight/project-model/limits';

/** The approved physics pin. */
export const RAPIER_PIN = '0.20.0' as const;

/** The rates the solver may step at (`fixed_step_hz`; project-model's). */
export { FIXED_STEP_HZ_CHOICES as FIXED_HZ_CHOICES } from '@thirdlight/project-model/limits';

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

/** The longest drop through one-way platforms one request asks for (steps: a second at 120 Hz). */
export const MAX_DROP_THROUGH_STEPS = 120 as const;

/** Ground-contact classification tolerance. */
export const GROUND_NORMAL_TOLERANCE = 1e-6 as const;

/**
 * The 3D footprint probe's ball, as a share of the capsule's radius: a
 * little narrower than the capsule, so what it touches at its side (a wall)
 * is never taken for its ground while a rim under its edge still is.
 */
export const FOOTPRINT_BALL = 0.9 as const;

/** The largest collider dimension (project-model's collider vocabulary). */
export const MAX_SHAPE_VALUE = MAX_LEN;
