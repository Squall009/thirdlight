/**
 * The `camera`-phase follow-camera module — `docs/contracts/gameplay.md` §7
 * and runtime.md §12.1 (the `thirdlight.platformer-game:camera` inventory
 * row; packet 51).
 *
 * The module is the **single camera owner** (gameplay.md §3.4/§7.6): it is
 * the only module that may write the camera entity's `position.x/y`, and only
 * in the `camera` phase (step) or the R6 reset barrier (snap). It holds no
 * clock, no accumulator, no loop and no world: every executed step it reads
 * the committed `curr` XY of the controller entity and the camera entity,
 * the frozen `cameraFollow` projection captured at `create`, and the runtime's
 * viewport record, then applies the exact §7.2 pipeline (dead zone →
 * smoothing → per-axis cap → authored bounds → frustum clamp) once, with a
 * pure fixed-step coefficient (no dt, no exponential time constant).
 *
 * Phase 15.3: the view distance and the speed cap are the camera's data —
 * `cameraFollow.distance` (absent: the camera's authored distance from the
 * player, so a camera placed 12 m out keeps the old `CAMERA_Z` framing) and
 * `cameraFollow.maxSpeed` (absent: 480 m/s, the old 4 m per step at 120 Hz).
 * `CAMERA_Z`/`CAMERA_MAX_STEP` stay as those defaults for direct callers of
 * `followCamera`; `DEFAULT_ASPECT` is the aspect until the host reports the
 * viewport. The §7.1 values (gameplay.md lines 756–758); the
 * `platformer-game → runtime` edge is **types-only** (dependencies.md §4.1),
 * so this package owns its own copies of them (the runtime exports the same
 * values on its own export row, gameplay.md §15 / runtime.md §15 — one
 * change point per package, re-synced if the contract changes, the same
 * pattern as the `three-adapter` GLTF allowlist note). `CAMERA_SNAP_EPS`
 * (the no-write threshold) is defined here, in the module that consumes it.
 *
 * It imports `@thirdlight/runtime` **types only** (dependencies.md §4.1):
 * no concrete physics, no input, no DOM, no three.js, no Node built-ins and
 * no I/O.
 */
import type {
  BehaviorLogLevel,
  ModuleConfig,
  ModuleResetContext,
  RuntimeSnapshot,
  SimulationModuleSpec,
  SimulationPhaseModule,
  StepContext,
} from '@thirdlight/runtime';
import { PLATFORMER_GAME_CAMERA_MODULE_ID } from './constants';

/** `gameplay.md` §7.1: the view depth (m) of the frustum clamp when a caller
 * gives none (phase 15.3: the module passes the camera's own distance). */
export const CAMERA_Z = 12;

/** `gameplay.md` §7.1: per-axis per-step displacement cap (m, safety bound),
 * active while smoothing (0 < k < 1) — phase 15.3: the default, at 120 Hz,
 * of `cameraFollow.maxSpeed` (480 m/s). */
export const CAMERA_MAX_STEP = 4;

/** Phase 15.3: the default `cameraFollow.maxSpeed` (m/s): `CAMERA_MAX_STEP` at 120 Hz. */
export const CAMERA_MAX_SPEED = 480;

/** `gameplay.md` §7.1: the viewport aspect used until `setViewport` is
 * called. */
export const DEFAULT_ASPECT = 16 / 9;

/** `gameplay.md` §7.1: below this (both axes) a step writes nothing (the
 * no-oscillation rule — no jitter). */
export const CAMERA_SNAP_EPS = 1e-9;

/** The four §7.1 contract constants the camera math and the fixtures share. */
export const CAMERA_CONSTANTS = Object.freeze({
  /** Fixed view depth (m); the authored `position.z` is never written. */
  cameraZ: CAMERA_Z,
  /** Per-axis per-step displacement cap (m), active while smoothing (0 < k < 1). */
  cameraMaxStep: CAMERA_MAX_STEP,
  /** Below this (both axes) a step writes nothing (the no-oscillation rule). */
  cameraSnapEps: CAMERA_SNAP_EPS,
  /** The viewport aspect used until `setViewport` is called. */
  defaultAspect: DEFAULT_ASPECT,
} as const);

/** One finite bound pair (authored bounds or the level). */
export interface CameraBounds2 {
  readonly minX: number;
  readonly maxX: number;
  readonly minY: number;
  readonly maxY: number;
}

/** The §7.2 pipeline inputs (all values are committed/frozen). */
export interface CameraFollowInput {
  /** `C` — the camera entity's committed `curr` XY (the last committed pose). */
  readonly camera: { readonly x: number; readonly y: number };
  /** `P` — the controller entity's committed `curr` XY (the capsule centre). */
  readonly player: { readonly x: number; readonly y: number };
  /** `dz` — the `cameraFollow.deadZone` half-extents. */
  readonly deadZone: { readonly x: number; readonly y: number };
  /** `k` — the `cameraFollow.smoothing` coefficient (0 ≤ k ≤ 1). */
  readonly smoothing: number;
  /** The authored `cameraFollow.bounds`. */
  readonly bounds: CameraBounds2;
  /** `content.game.level`. */
  readonly level: CameraBounds2;
  /** The scene camera component's `fovY` (degrees, vertical). */
  readonly fovY: number;
  /** The viewport aspect `width / height`. */
  readonly aspect: number;
  /** `true` at the R6 reset barrier (§7.4): `k` forced to 1, cap skipped. */
  readonly snap?: boolean;
  /** Phase 15.3: the view distance for the frustum clamp (absent: `CAMERA_Z`). */
  readonly distance?: number;
  /** Phase 15.3: the per-axis per-step cap (absent: `CAMERA_MAX_STEP`). */
  readonly maxStep?: number;
}

/** The §7.2 pipeline outputs (the full order of operations, exposed per stage). */
export interface CameraFollowResult {
  /** `T` — the dead-zone target. */
  readonly target: { readonly x: number; readonly y: number };
  /** `S` — the smoothed position (exact target when `snap`/`k = 0`). */
  readonly smoothed: { readonly x: number; readonly y: number };
  /** `S'` — after the per-axis `CAMERA_MAX_STEP` cap (skipped when `snap`/`k = 0`). */
  readonly capped: { readonly x: number; readonly y: number };
  /** `A` — after the authored-bounds clamp. */
  readonly bounded: { readonly x: number; readonly y: number };
  /** `C'` — after the frustum clamp; the position written when `moved`. */
  readonly position: { readonly x: number; readonly y: number };
  /** `|C' − C| > CAMERA_SNAP_EPS` on either axis; `false` ⇒ the step writes nothing. */
  readonly moved: boolean;
  /** `halfH = CAMERA_Z · tan(fovY·π/360)`. */
  readonly halfH: number;
  /** `halfW = halfH · aspect`. */
  readonly halfW: number;
}

function overflow(v: number, h: number): number {
  return v > h ? v - h : v < -h ? v + h : 0;
}

function clampN(v: number, min: number, max: number): number {
  return v < min ? min : v > max ? max : v;
}

/** §7.3: the level is smaller than the frustum on this axis ⇒ centre it. */
function clampFrustum(v: number, min: number, max: number, half: number): number {
  return max - min >= 2 * half ? clampN(v, min + half, max - half) : (min + max) / 2;
}

/**
 * The pure §7.2 follow pipeline (normative order: dead zone → smoothing →
 * cap → authored bounds → frustum clamp). `snap` (the §7.4 reset pipeline)
 * forces `k` to 1 and skips the cap; `k = 0` is also an exact hard target
 * that bypasses the cap. Bit-stable: when `|C' − C| ≤ CAMERA_SNAP_EPS` on
 * both axes `moved` is `false` and `position` is `C` itself (the caller
 * writes nothing).
 */
export function followCamera(input: CameraFollowInput): CameraFollowResult {
  const { camera: C, player: P, deadZone: dz, smoothing: k, bounds, level, fovY, aspect } = input;
  const halfH = (input.distance ?? CAMERA_Z) * Math.tan((fovY * Math.PI) / 180 / 2);
  const cap = input.maxStep ?? CAMERA_MAX_STEP;
  const halfW = halfH * aspect;
  const Tx = C.x + overflow(P.x - C.x, dz.x);
  const Ty = C.y + overflow(P.y - C.y, dz.y);
  // `k = 0` (the documented "hard snap") and the reset snap are exact
  // targets and bypass the cap (§7.2); the cap applies only while
  // smoothing is active (0 < k < 1).
  const hard = input.snap === true || k === 0;
  const Sx = hard ? Tx : C.x + k * (Tx - C.x);
  const Sy = hard ? Ty : C.y + k * (Ty - C.y);
  const sx = hard ? Sx : C.x + clampN(Sx - C.x, -cap, cap);
  const sy = hard ? Sy : C.y + clampN(Sy - C.y, -cap, cap);
  const ax = clampN(sx, bounds.minX, bounds.maxX);
  const ay = clampN(sy, bounds.minY, bounds.maxY);
  const px = clampFrustum(ax, level.minX, level.maxX, halfW);
  const py = clampFrustum(ay, level.minY, level.maxY, halfH);
  const moved = Math.abs(px - C.x) > CAMERA_SNAP_EPS || Math.abs(py - C.y) > CAMERA_SNAP_EPS;
  return {
    target: Object.freeze({ x: Tx, y: Ty }),
    smoothed: Object.freeze({ x: Sx, y: Sy }),
    capped: Object.freeze({ x: sx, y: sy }),
    bounded: Object.freeze({ x: ax, y: ay }),
    position: Object.freeze(moved ? { x: px, y: py } : { x: C.x, y: C.y }),
    moved,
    halfH,
    halfW,
  };
}

/**
 * The frozen `cameraFollow` component fields (project-model §23.3.3),
 * projected once at `create` from the snapshot the runtime deep-freezes.
 */
interface CameraFollowComponent {
  deadZone: { x: number; y: number };
  smoothing: number;
  bounds: CameraBounds2;
  /** Phase 15.3 (v4): metres in front of the player plane (absent: as placed). */
  distance?: number;
  /** Phase 15.3 (v4): the per-axis speed cap, m/s (absent: 480). */
  maxSpeed?: number;
}

function requireFinite(label: string, value: unknown): asserts value is number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`${PLATFORMER_GAME_CAMERA_MODULE_ID}: ${label} must be a finite number (got ${JSON.stringify(value)})`);
  }
}

function requireBounds(label: string, b: unknown): asserts b is CameraBounds2 {
  const o = b as CameraBounds2;
  requireFinite(`${label}.minX`, o?.minX);
  requireFinite(`${label}.maxX`, o?.maxX);
  requireFinite(`${label}.minY`, o?.minY);
  requireFinite(`${label}.maxY`, o?.maxY);
  if (o.minX > o.maxX || o.minY > o.maxY) {
    throw new Error(`${PLATFORMER_GAME_CAMERA_MODULE_ID}: ${label} must be ordered (min ≤ max)`);
  }
}

/**
 * Build the camera module instance. The runtime validates the §3.4
 * composition (schemaVersion 3, a non-null `content.game`, exactly one
 * camera-phase module owning exactly the scene camera entity, a
 * `cameraFollow` component) before `create`; the checks here are the
 * defensive path for a direct caller, so the module can never run without
 * the frozen inputs it needs.
 */
export function createGameCameraModule(
  snapshot: RuntimeSnapshot,
  cfg: ModuleConfig,
): SimulationPhaseModule {
  if (cfg.sceneVersion !== 3 && cfg.sceneVersion !== 4) {
    throw new Error(`${PLATFORMER_GAME_CAMERA_MODULE_ID} requires a schemaVersion 3 snapshot scene`);
  }
  if (cfg.game === undefined || cfg.game === null) {
    throw new Error(`${PLATFORMER_GAME_CAMERA_MODULE_ID} requires a non-null content.game block`);
  }
  const cameraId = cfg.game.cameraId;
  const playerId = cfg.game.playerId;
  // v3 carries level bounds; v4 has none, so the camera is limited only by
  // its own cameraFollow bounds (when authored).
  const level: CameraBounds2 =
    cfg.game.level !== undefined
      ? { ...cfg.game.level }
      : { minX: Number.NEGATIVE_INFINITY, maxX: Number.POSITIVE_INFINITY, minY: Number.NEGATIVE_INFINITY, maxY: Number.POSITIVE_INFINITY };
  if (cfg.game.level !== undefined) requireBounds('content.game.level', level);

  const camEntity = snapshot.scene.entities.find((e) => e.id === cameraId);
  if (camEntity === undefined) {
    throw new Error(`${PLATFORMER_GAME_CAMERA_MODULE_ID}: the scene has no entity "${cameraId}" (content.game.cameraId)`);
  }
  const components = camEntity.components as {
    transform?: { position?: readonly number[] };
    camera?: { fovY?: unknown };
    cameraFollow?: CameraFollowComponent;
  };
  requireFinite('camera.fovY', components.camera?.fovY);
  const fovY: number = components.camera.fovY;
  if (fovY <= 0) {
    throw new Error(`${PLATFORMER_GAME_CAMERA_MODULE_ID}: camera.fovY must be positive (got ${fovY})`);
  }
  if (components.cameraFollow === undefined) {
    throw new Error(`${PLATFORMER_GAME_CAMERA_MODULE_ID}: the scene camera entity carries no cameraFollow component`);
  }
  const follow = components.cameraFollow;
  requireFinite('cameraFollow.deadZone.x', follow.deadZone?.x);
  requireFinite('cameraFollow.deadZone.y', follow.deadZone?.y);
  requireFinite('cameraFollow.smoothing', follow.smoothing);
  // v4: cameraFollow.bounds are optional (without them the camera follows anywhere).
  if (follow.bounds !== undefined) requireBounds('cameraFollow.bounds', follow.bounds);
  const deadZone = { x: follow.deadZone.x, y: follow.deadZone.y };
  const smoothing = follow.smoothing;
  const bounds: CameraBounds2 = follow.bounds !== undefined ? { ...follow.bounds } : { minX: Number.NEGATIVE_INFINITY, maxX: Number.POSITIVE_INFINITY, minY: Number.NEGATIVE_INFINITY, maxY: Number.POSITIVE_INFINITY };
  // Phase 15.3: the view distance — authored (`distance`: the module keeps the
  // camera that far in front of the player plane), else where the camera is
  // placed (its z minus the player's; the old constant 12 for a camera at 12).
  const playerZ = (snapshot.scene.entities.find((e) => e.id === playerId)?.components as { transform?: { position?: readonly number[] } } | undefined)?.transform?.position?.[2] ?? 0;
  const authoredZ = components.transform?.position?.[2];
  const hasDistance = typeof follow.distance === 'number' && Number.isFinite(follow.distance) && follow.distance > 0;
  const placed = typeof authoredZ === 'number' && Number.isFinite(authoredZ) ? authoredZ - playerZ : CAMERA_Z;
  const distance = hasDistance ? (follow.distance as number) : placed > 0 ? placed : CAMERA_Z;
  const writeZ = hasDistance ? playerZ + distance : null;
  // Phase 15.3: the speed cap per step at this step rate (480 m/s: 4 m at 120 Hz).
  const maxSpeed = typeof follow.maxSpeed === 'number' && Number.isFinite(follow.maxSpeed) && follow.maxSpeed > 0 ? follow.maxSpeed : CAMERA_MAX_SPEED;
  const maxStep = maxSpeed / cfg.fixedStepHz;

  /** The bounded diagnostics sink (runtime.md §14.8.1); presentation-only. */
  const diagnostics: ((level: BehaviorLogLevel, message: string) => void) | undefined = cfg.behaviorLog;

  /**
   * The defensive non-finite viewport guard (gameplay.md §7.5): a
   * non-finite viewport must not write a transform — the step is a
   * no-op with one bounded diagnostic entry, never a fail-stop.
   * Unreachable through the runtime's own `setViewport` (which validates
   * before storing): the pipeline consumes the aspect, which the runtime
   * keeps finite and positive at every moment (the initial record is
   * `{ width: 0, height: 0, aspect: DEFAULT_ASPECT }` — the "until
   * `setViewport`" state, §7.1 — and is therefore NOT invalid).
   */
  const viewportInvalid = (v: { width: number; height: number; aspect: number }): boolean => {
    const bad =
      !Number.isFinite(v.width) ||
      !Number.isFinite(v.height) ||
      !Number.isFinite(v.aspect) ||
      v.aspect <= 0;
    if (bad) {
      diagnostics?.(
        'warn',
        `camera_viewport_invalid: width=${v.width} height=${v.height} aspect=${v.aspect}; the camera keeps its last committed pose`,
      );
    }
    return bad;
  };

  const apply = (state: { curr: Map<string, { position: [number, number, number] }> }, aspect: number, player: { x: number; y: number }, snap: boolean): void => {
    const cam = state.curr.get(cameraId);
    if (cam === undefined) {
      throw new Error(`${PLATFORMER_GAME_CAMERA_MODULE_ID}: the camera entity "${cameraId}" is missing from curr`);
    }
    const r = followCamera({
      camera: { x: cam.position[0], y: cam.position[1] },
      player,
      deadZone,
      smoothing,
      bounds,
      level,
      fovY,
      aspect,
      snap,
      distance,
      maxStep,
    });
    if (r.moved) {
      // The only writes the camera module ever performs (§7.1/§3.4):
      // `position.x/y` of the camera entity, and (phase 15.3) `position.z`
      // when `cameraFollow.distance` is authored; without it the z stays the
      // authored depth. Rotation and scale are never written.
      cam.position[0] = r.position.x;
      cam.position[1] = r.position.y;
    }
    if (writeZ !== null && cam.position[2] !== writeZ) cam.position[2] = writeZ;
  };

  return {
    // The runtime validates that this is exactly `[cameraId]` at
    // instantiate (§3.4); declared once, at create.
    transformOwners: [cameraId],
    step(phase, ctx: StepContext): void {
      if (phase !== 'camera') return;
      const port = ctx.gameplay;
      if (port === undefined) {
        throw new Error(`${PLATFORMER_GAME_CAMERA_MODULE_ID} requires the M3 GameSessionPort`);
      }
      const viewport = port.viewport();
      if (viewportInvalid(viewport)) return; // §7.5 defensive no-op
      const playerT = ctx.state.curr.get(playerId);
      if (playerT === undefined) {
        throw new Error(`${PLATFORMER_GAME_CAMERA_MODULE_ID}: the player entity "${playerId}" is missing from curr`);
      }
      apply(ctx.state, viewport.aspect, { x: playerT.position[0], y: playerT.position[1] }, false);
    },
    /**
     * The R6 reset barrier (gameplay.md §5.1/§7.4): the §7.2 pipeline with
     * the smoothing coefficient forced to 1 (exact dead-zone target at the
     * reset player centre, cap skipped), then the authored bounds and the
     * frustum clamp. The runtime's R7 promotion makes `prev == curr`
     * afterwards — the camera never streaks across the map.
     */
    reset(ctx: ModuleResetContext): void {
      if (viewportInvalid(ctx.viewport)) return; // §7.5 defensive no-op
      apply(ctx.state, ctx.viewport.aspect, { x: ctx.playerCenter.x, y: ctx.playerCenter.y }, true);
    },
    dispose(): void {
      /* stateless: nothing to release */
    },
  };
}

/**
 * The registered camera module spec (runtime.md §12.1 inventory):
 * phases `["camera"]`, single transform owner = the scene camera entity
 * (resolved from the frozen `content.game` at `create`).
 */
export const platformerGameCameraSpec: SimulationModuleSpec = {
  id: PLATFORMER_GAME_CAMERA_MODULE_ID,
  phases: ['camera'],
  create: createGameCameraModule,
};