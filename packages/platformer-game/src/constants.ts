/**
 * `@thirdlight/platformer-game` constants — `docs/contracts/gameplay.md`
 * §4.2 (the swept-capsule constants), §8.2 (finite limits and defaults) and
 * the runtime.md §12.1 inventory (the module IDs).
 *
 * These were **contract constants** (accepted `project-model.md` §21.6).
 * Phase 15.3: the respawn delay is now the game block's `respawnDelay`
 * (seconds; `respawnDelaySteps` below is its 120 Hz default, 0.25 s); the
 * rest are engine limits and tolerances (listed in `docs/deployment.md`).
 */
import type { GameZoneRole } from '@thirdlight/runtime';

/** The gameplay-phase run/zone module ID (runtime.md §12.1 inventory). */
export const PLATFORMER_GAME_MODULE_ID = 'thirdlight.platformer-game:session';

/** The camera-phase module ID (packet 51 implements the module itself). */
export const PLATFORMER_GAME_CAMERA_MODULE_ID = 'thirdlight.platformer-game:camera';

// Phase 14.0: the capsule is the player's own (`GameContent.player.capsule`,
// from its `controller` component) — no capsule constant lives here.
/**
 * `gameplay.md` §4.2/§8.2: the overlap tolerance (m). `d < R − EPS` is an
 * overlap; `|d − R| ≤ EPS` is the tangency bucket and is **not** an overlap.
 */
export const ZONE_OVERLAP_EPS = 1e-9;

/** The three gameplay-zone roles (project-model §23.3.1). */
export const GAME_ZONE_ROLES: readonly GameZoneRole[] = ['hazard', 'checkpoint', 'goal'];

/**
 * `gameplay.md` §8.2 finite limits. `RUN_LIMITS` is the read-only record the
 * fixtures and packets 49–51 share.
 */
export const RUN_LIMITS = Object.freeze({
  /** Bounded respawn delay in executed fixed steps (0.25 s at 120 Hz) — phase 15.3: the default of `content.game.respawnDelay`. */
  respawnDelaySteps: 30,
  /** Retained `GameView` events; further events are evicted from the front. */
  maxGameEvents: 32,
  /** At most one pending run command per kind (idempotent; conflict rejected). */
  pendingRunCommands: 1,
  /** `gameplay.md` §4.1/item 39 §23.10: at most 64 zones per scene. */
  zonesPerScene: 64,
  zoneOverlapEps: ZONE_OVERLAP_EPS,
} as const);
