/**
 * `@thirdlight/platformer-game` — public surface (dependencies.md §3 row:
 * `platformerGameSessionSpec`, `zoneOverlap`, `stepZones`,
 * `PLATFORMER_GAME_MODULE_ID`, `RUN_LIMITS` — packet 49;
 * `platformerGameCameraSpec`, `followCamera`, `CAMERA_CONSTANTS` — packet 51).
 *
 * Packet 49 (`docs/contracts/gameplay.md`): the pure, stateless
 * `gameplay`-phase session/zone module for the M3 run. Packet 51: the
 * `camera`-phase follow module (gameplay.md §7) — pure fixed-step
 * follow/dead-zone/bounds math, the single camera owner and the reset snap.
 *
 * The package imports `@thirdlight/runtime` **types + contract constants
 * only** — no concrete physics, no input, no DOM, no three.js, no Node
 * built-ins and no I/O — so it runs unchanged in the play-preview and
 * export bundles and in the Node test harness.
 */
export {
  CAPSULE_HALF_HEIGHT,
  CAPSULE_RADIUS,
  GAME_ZONE_ROLES,
  PLATFORMER_GAME_CAMERA_MODULE_ID,
  PLATFORMER_GAME_MODULE_ID,
  RUN_LIMITS,
  ZONE_OVERLAP_EPS,
} from './constants';
export { stepZones, zoneOverlap, type GameZoneRect, type StepZonesInput, type ZoneDecision, type ZoneGeometry, type ZoneTest } from './zones';
export { createGameSessionModule, platformerGameSessionSpec } from './session';
export {
  CAMERA_CONSTANTS,
  CAMERA_SNAP_EPS,
  createGameCameraModule,
  followCamera,
  platformerGameCameraSpec,
  type CameraBounds2,
  type CameraFollowInput,
  type CameraFollowResult,
} from './camera';