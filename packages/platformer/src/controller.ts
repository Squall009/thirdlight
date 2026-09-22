/**
 * The platformer controller module — `docs/contracts/runtime.md` §12
 * (promoted from `platformer.md` §2–§9; packet 32).
 *
 * Pure fixed-step logic over the injected input/physics **ports**: the module
 * holds no reference to the concrete port, the DOM, the clock, the workspace
 * or any storage. It reads `StepContext` and stages exactly one character
 * move per `controller` phase; the runtime commits the port result to the
 * character's `position.x`/`position.y` in the physics phase before any
 * `transform` module runs (`runtime.md` §12.1.1 item 5), so this module never
 * writes a transform at all.
 *
 * Step algorithm: `platformer.md` §7 (normative exact order A–K) plus the
 * grounding classification of `physics.md` §8 items 1–4. Every window,
 * threshold and constant is an integer-step counter or a contract constant.
 *
 * Gate I repair R-I-2 (`runtime.md` §14.5, C34-3): the controller phase's input
 * is the **effective frame** `{ stepIndex, moveX: ctx.intents.move ??
 * ctx.action.moveX, jump: ctx.intents.jump ?? ctx.action.jump }`. With an empty
 * `IntentSet` this is bit-identical to the sampled `ctx.action`, so the 178
 * pinned packet-17 trace rows are unchanged; a committed `control_move`/
 * `control_jump` intent replaces only that channel for this phase.
 *
 * The step-indexed state (`vx`, `vy`, `airborne`, `coyote`, `buffer`,
 * `prevResult`) is private to the module instance and survives `stop()` /
 * `start()`; only `dispose()` (or a fresh instance after fail-stop) resets it.
 */
import type {
  ActionFrame,
  CharacterMoveResult,
  GameplaySettings,
  ModuleConfig,
  ModuleResetContext,
  PhysicsStepClient,
  RuntimeSnapshot,
  SimulationModuleSpec,
  SimulationPhaseModule,
} from '@thirdlight/runtime';
import { CONTROLLER_CONSTANTS, PLATFORMER_MODULE_ID } from './constants';

/**
 * Ground-contact classification tolerance (`physics.md` §7/§8: compares
 * `supportNormal.y` with `cos(max_slope_climb_deg)` within `1e-6`).
 */
export const GROUND_NORMAL_TOLERANCE = 1e-6;

/**
 * The controller's private per-step state (`platformer.md` §4). Created at
 * `create()` from the authored transform; `coyote` starts at the full window
 * and `buffer` at 0 (the settle pre-roll then runs the normal phases).
 */
export interface ControllerState {
  /** Horizontal velocity (m/s), approached toward the per-step target. */
  vx: number;
  /** Vertical velocity (m/s). */
  vy: number;
  /** `true` between a jump start and its landing/release classification. */
  airborne: boolean;
  /** Remaining coyote steps (integer counter, never wall time). */
  coyote: number;
  /** Remaining jump-buffer steps (integer counter). */
  buffer: number;
  /** Set by the step that started the current jump (buffer bookkeeping). */
  jumpStarted: boolean;
  /** The last **completed** step's port result (`undefined` before step 0). */
  prevResult: CharacterMoveResult | undefined;
  /** The authoritative character centre after the last completed step. */
  charX: number;
  charY: number;
  /** Bounded diagnostic counter: steps the slide policy drove the character. */
  slideSteps: number;
}

/** `platformer.md` §7 `approach(v, target, up, down)` — never overshoots. */
export function approach(v: number, target: number, up: number, down: number): number {
  if (Math.abs(target - v) <= 1e-9) return target;
  if (v < target) return Math.min(target, v + up);
  if (v > target) return Math.max(target, v - down);
  return v;
}

/** Create the state at the authored character transform (`platformer.md` §4). */
export function createControllerState(charX: number, charY: number): ControllerState {
  return {
    vx: 0,
    vy: 0,
    airborne: false,
    coyote: CONTROLLER_CONSTANTS.coyoteSteps,
    buffer: 0,
    jumpStarted: false,
    prevResult: undefined,
    charX,
    charY,
    slideSteps: 0,
  };
}

/**
 * The controller's grounded classification (`physics.md` §8 items 1–4): the
 * port's `grounded` flag **and** a support normal at or above the maximum
 * climb angle. A normal-flagged ground below the climb limit is `steepSlope`
 * and is treated as not grounded (so gravity applies and no jump starts).
 */
export function isGrounded(
  result: CharacterMoveResult | undefined,
  cosMaxSlopeClimb: number,
): boolean {
  return (
    result !== undefined &&
    result.grounded === true &&
    result.supportNormal.y >= cosMaxSlopeClimb - GROUND_NORMAL_TOLERANCE
  );
}

/**
 * Packet-32 slide policy (contract-change request C32-1; see the evidence
 * manifest).
 *
 * `platformer.md` §7's A–K algorithm contains no sliding rule, while
 * `physics.md` §7/§8 declare `min_slope_slide_deg` (30°) as "the minimum
 * slope angle at which the character slides down the slope, if it is not
 * moving", and packet 31 recorded (C31-4) that the real 0.20.0 adapter does
 * **not** slide a resting character on its own. This is the smallest rule
 * that realises the declared threshold through the accepted port surface:
 *
 * - the support is *slide-steep* when the completed step reported the
 *   `steepSlope`-style geometry — either a support normal at or below
 *   `cos(min_slope_slide_deg)` (the contract's classification) or a bounded
 *   **downward ground-contact correction whose slope is at least the minimum
 *   slide angle** (`snapped`, `applied.y < requested.y`, and
 *   `requested.y − applied.y ≥ |applied.x| · tan(min_slope_slide_deg) − 1e-6`).
 *   The slope-ratio condition matters: a flat-support snap correction carries
 *   only floating-point noise, so without it the policy would drive a resting
 *   character on flat ground; a genuine descending surface produces exactly
 *   `tan(angle)` per unit of horizontal movement;
 * - while slide-steep and commanded to **no** movement (`moveX === 0`, the
 *   contract's "if it is not moving"), the horizontal velocity target becomes
 *   the downhill direction at `run_speed`, approached with the existing
 *   acceleration; the port's ground snap converts the horizontal request into
 *   along-surface motion.
 *
 * Derived from collision results only — never from a floor constant — and it
 * cannot fire on flat ground for more than the single step whose correction
 * it observed. The downhill direction comes from the support normal when the
 * adapter reports it, else from the direction of the applied correction.
 */
export function slideDirection(
  result: CharacterMoveResult | undefined,
  cosMinSlopeSlide: number,
  tanMinSlopeSlide: number,
): -1 | 0 | 1 {
  if (result === undefined || result.grounded !== true) return 0;
  const steepNormal = result.supportNormal.y < cosMinSlopeSlide + GROUND_NORMAL_TOLERANCE;
  const drop = result.requested.y - result.applied.y;
  const descending =
    result.snapped === true &&
    drop > 1e-6 &&
    Math.abs(result.applied.x) > 1e-9 &&
    drop >= Math.abs(result.applied.x) * tanMinSlopeSlide - GROUND_NORMAL_TOLERANCE;
  if (!steepNormal && !descending) return 0;
  if (result.supportNormal.x > 0) return 1;
  if (result.supportNormal.x < 0) return -1;
  if (result.applied.x > 0) return 1;
  if (result.applied.x < 0) return -1;
  return 0;
}

/**
 * One executed controller step (`platformer.md` §7, exact order). Reads the
 * previous result from `state.prevResult` and stages exactly one character
 * move; the caller (the runtime) commits the port result afterwards.
 *
 * `dt` is `1 / fixedStepHz` captured at `create()` (the accepted `StepContext`
 * does not carry the step rate; `platformer.md` §7 defines `dt` as that
 * value). `cosMaxSlopeClimb`/`cosMinSlopeSlide` are the resolved settings'
 * angles in radians-precomputed cosine form.
 */
export function controllerStep(
  state: ControllerState,
  charId: string,
  frame: ActionFrame,
  settings: Readonly<GameplaySettings>,
  dt: number,
  cosMaxSlopeClimb: number,
  cosMinSlopeSlide: number,
  tanMinSlopeSlide: number,
  physics: PhysicsStepClient,
): void {
  const p = state.prevResult;
  const groundedPrev = isGrounded(p, cosMaxSlopeClimb);

  // A. jump press edge refreshes the buffer window.
  if (frame.jump === 'pressed') state.buffer = CONTROLLER_CONSTANTS.jumpBufferSteps;
  // B. a grounded step refreshes the coyote window.
  if (groundedPrev) state.coyote = CONTROLLER_CONSTANTS.coyoteSteps;
  // C. one jump start per press: grounded or inside coyote, never airborne.
  if (state.buffer > 0 && (groundedPrev || state.coyote > 0) && !state.airborne) {
    state.vy = settings.jump_velocity;
    state.airborne = true;
    state.buffer = 0;
    state.coyote = 0;
    state.jumpStarted = true;
  } else {
    state.jumpStarted = false;
  }
  // D. grounded (and not airborne) ⇒ rest vertically; else integrate gravity.
  if (groundedPrev && !state.airborne) state.vy = 0;
  else state.vy = Math.max(state.vy + settings.gravity_y * dt, settings.max_fall_speed);
  // E. head contact clamps upward velocity (no ceiling hover).
  if (p !== undefined && p.contacts.head === true && state.vy > 0) state.vy = 0;
  // F. variable height: a release while ascending halves vy exactly once.
  if (frame.jump === 'released' && state.airborne) {
    if (state.vy > 0) state.vy = state.vy * CONTROLLER_CONSTANTS.jumpReleaseFactor;
    state.airborne = false;
  }
  // G. landing classification (a grounded step with non-positive vy).
  if (state.airborne && groundedPrev && state.vy <= 0) state.airborne = false;
  // H. horizontal approach (no smoothing, exact arrival at the target).
  const commanded = frame.moveX * settings.run_speed;
  let target = commanded;
  if (groundedPrev && !state.airborne && frame.moveX === 0) {
    const slide = slideDirection(p, cosMinSlopeSlide, tanMinSlopeSlide);
    if (slide !== 0) {
      target = slide * settings.run_speed;
      state.slideSteps += 1;
    }
  }
  state.vx = approach(
    state.vx,
    target,
    CONTROLLER_CONSTANTS.moveAccel * dt,
    CONTROLLER_CONSTANTS.moveDecel * dt,
  );
  // I. stage the requested delta (the only mutation this module performs).
  physics.stageCharacterMove(charId, { x: state.vx * dt, y: state.vy * dt });
  // J. coyote bookkeeping (integer steps; one decrement per airborne step).
  if (!groundedPrev) state.coyote = Math.max(0, state.coyote - 1);
  // K. buffer bookkeeping (a consumed press is not decremented).
  if (!state.jumpStarted) state.buffer = Math.max(0, state.buffer - 1);
}

/** The single `components.controller` entity id of a v2 snapshot. */
export function findControllerEntity(snapshot: RuntimeSnapshot): string {
  const ids = snapshot.scene.entities
    .filter((entity) => (entity.components as { controller?: unknown }).controller !== undefined)
    .map((entity) => entity.id);
  if (ids.length !== 1) {
    // The runtime validates `controller_target` before `create`; this is the
    // defensive path so a direct caller cannot build an ambiguous controller.
    throw new Error(
      `thirdlight.platformer:controller requires exactly one components.controller entity (found ${ids.length})`,
    );
  }
  return ids[0] as string;
}

/** Build a controller module instance (`platformer.md` §4/§12). */
export function createControllerModule(
  snapshot: RuntimeSnapshot,
  cfg: ModuleConfig,
): SimulationPhaseModule {
  const charId = findControllerEntity(snapshot);
  const entity = snapshot.scene.entities.find((e) => e.id === charId);
  const transform = entity?.components.transform;
  if (!transform) {
    throw new Error(`thirdlight.platformer:controller entity "${charId}" has no transform component`);
  }
  if (cfg.fixedStepHz <= 0 || !Number.isFinite(cfg.fixedStepHz)) {
    throw new Error('thirdlight.platformer:controller requires a positive fixedStepHz');
  }
  const dt = 1 / cfg.fixedStepHz;
  const cosMaxSlopeClimb = Math.cos((cfg.settings.max_slope_climb_deg * Math.PI) / 180);
  const cosMinSlopeSlide = Math.cos((cfg.settings.min_slope_slide_deg * Math.PI) / 180);
  const tanMinSlopeSlide = Math.tan((cfg.settings.min_slope_slide_deg * Math.PI) / 180);
  const state = createControllerState(transform.position[0], transform.position[1]);

  return {
    transformOwners: [charId],
    /**
     * M3 reset-barrier hook (gameplay.md §5.1 R6 / §5.3 coherence table):
     * zero every window and velocity the step-indexed state can carry, so
     * nothing a pre-death step left behind (a buffered or held jump, the
     * coyote window, the last result's grounding/support normal) survives the
     * respawn. The next physics phase re-derives grounding from the placed
     * capsule. `slideSteps` is a bounded diagnostic counter, not a window, so
     * it is preserved (the coherence table lists no action for it).
     */
    reset(ctx: ModuleResetContext): void {
      state.vx = 0;
      state.vy = 0;
      state.airborne = false; // the jump-release (variable-height) flag
      state.coyote = 0;
      state.buffer = 0;
      state.jumpStarted = false;
      state.prevResult = undefined; // clears grounding/groundedPrev/support normal
      state.charX = ctx.playerCenter.x;
      state.charY = ctx.playerCenter.y;
    },
    step(phase, ctx): void {
      if (phase === 'controller') {
        // runtime.md §14.5 effective input: a committed intent for a channel
        // replaces the sampled channel for this phase only (`ctx.action`
        // itself stays the sampled frame).
        const effective: ActionFrame = {
          stepIndex: ctx.action.stepIndex,
          moveX: ctx.intents.move ?? ctx.action.moveX,
          jump: ctx.intents.jump ?? ctx.action.jump,
        };
        controllerStep(
          state,
          charId,
          effective,
          ctx.settings,
          dt,
          cosMaxSlopeClimb,
          cosMinSlopeSlide,
          tanMinSlopeSlide,
          ctx.physics,
        );
        return;
      }
      // transform phase: the runtime has already committed the port result
      // (`runtime.md` §12.1.1 item 5); record it as the next step's
      // `prevResult`. The module writes no transform of its own.
      const result = ctx.physics.characterResult(charId);
      if (result !== undefined) {
        state.prevResult = result;
        state.charX = result.position.x;
        state.charY = result.position.y;
      }
    },
    dispose(): void {
      /* no resources: pure counters and plain data */
    },
  };
}

/**
 * The registered controller module spec (`platformer.md` §2 inventory):
 * phases `["controller", "transform"]`, the single `components.controller`
 * entity as its transform owner, mutually exclusive with the M1 demo module
 * and requiring the injected physics port.
 */
export const platformerSpec: SimulationModuleSpec = {
  id: PLATFORMER_MODULE_ID,
  phases: ['controller', 'transform'],
  excludes: ['thirdlight.demo:box-motion'],
  requiresPhysicsPort: true,
  create: createControllerModule,
};
