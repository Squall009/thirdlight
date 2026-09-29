/**
 * The character controller module — `docs/contracts/runtime.md` §12
 * (promoted from the controller contract §2–§9; packet 32).
 *
 * Pure fixed-step logic over the injected input/physics **ports**: the module
 * holds no reference to the concrete port, the DOM, the clock, the workspace
 * or any storage. It reads `StepContext` and stages exactly one character
 * move per `controller` phase; the runtime commits the port result to the
 * character's `position.x`/`position.y` in the physics phase before any
 * `transform` module runs (`runtime.md` §12.1.1 item 5), so this module never
 * writes a transform at all.
 *
 * Step algorithm: the controller contract §7 (normative exact order A–K) plus the
 * grounding classification of `physics.md` §8 items 1–4. Every window is an
 * integer-step counter; phase 15.3: the acceleration, deceleration, windows
 * and jump-release factor are the player's `controller` data (absent: the
 * packet-32 values, so recorded replays are unchanged).
 *
 * Gate I repair R-I-2 (`runtime.md` §14.5, C34-3): the controller phase's input
 * is the **effective input** `{ stepIndex, moveX: ctx.intents.move ?? the move
 * action's x (else v), jump: ctx.intents.jump ?? the jump action's phase }`.
 * Phase 24.8: the move and jump actions are the controller's `moveAction` /
 * `jumpAction` (default `move`, `jump`); the action frame (version 2) has no
 * fixed channels. With an empty `IntentSet` a version 1 recording (its
 * channels upgraded to those actions) gives the same input, so the 178 pinned
 * packet-17 trace rows are unchanged; a committed `control_move`/
 * `control_jump` intent replaces only that value for this phase.
 *
 * The step-indexed state (`vx`, `vy`, `airborne`, `coyote`, `buffer`,
 * `prevResult`) is private to the module instance and survives `stop()` /
 * `start()`; only `dispose()` (or a fresh instance after fail-stop) resets it.
 */
import type {
  ActionFrame,
  ClimbVolumeView,
  JumpPhase,
  CharacterMoveResult,
  GameplaySettings,
  ModuleConfig,
  ModuleResetContext,
  PhysicsStepClient,
  RuntimeSnapshot,
  SimulationModuleSpec,
  SimulationPhaseModule,
} from '@thirdlight/runtime';
import { CONTROLLER_CONSTANTS, CONTROLLER_DEFAULT_SECONDS, CHARACTER_MODULE_ID } from './constants';

/**
 * Phase 15.3: the per-step tuning the algorithm reads — the player's
 * `controller` data at the module's step rate (windows in whole steps).
 */
export interface ControllerStepTuning {
  readonly moveAccel: number;
  readonly moveDecel: number;
  readonly coyoteSteps: number;
  readonly jumpBufferSteps: number;
  readonly jumpReleaseFactor: number;
}

/** The defaults (exactly the packet-32 constants: 120 Hz windows). */
export const DEFAULT_STEP_TUNING: ControllerStepTuning = Object.freeze({
  moveAccel: CONTROLLER_CONSTANTS.moveAccel,
  moveDecel: CONTROLLER_CONSTANTS.moveDecel,
  coyoteSteps: CONTROLLER_CONSTANTS.coyoteSteps,
  jumpBufferSteps: CONTROLLER_CONSTANTS.jumpBufferSteps,
  jumpReleaseFactor: CONTROLLER_CONSTANTS.jumpReleaseFactor,
});

/**
 * Phase 15.3: the step tuning a `controller` component describes at
 * `fixedStepHz` (each absent field at its default; a window in seconds
 * becomes the nearest whole number of steps — 0.05 s is 6 steps at 120 Hz,
 * 3 at 60 Hz). The project model validated the ranges; a non-finite value
 * (a direct caller) falls back to the default.
 */
export function controllerStepTuning(controller: unknown, fixedStepHz: number): ControllerStepTuning {
  const c = (typeof controller === 'object' && controller !== null ? controller : {}) as Record<string, unknown>;
  const num = (k: string, d: number): number => {
    const v = c[k];
    return typeof v === 'number' && Number.isFinite(v) ? v : d;
  };
  return Object.freeze({
    moveAccel: num('acceleration', CONTROLLER_CONSTANTS.moveAccel),
    moveDecel: num('deceleration', CONTROLLER_CONSTANTS.moveDecel),
    coyoteSteps: Math.max(0, Math.round(num('coyoteTime', CONTROLLER_DEFAULT_SECONDS.coyoteTime) * fixedStepHz)),
    jumpBufferSteps: Math.max(0, Math.round(num('jumpBuffer', CONTROLLER_DEFAULT_SECONDS.jumpBuffer) * fixedStepHz)),
    jumpReleaseFactor: num('jumpRelease', CONTROLLER_CONSTANTS.jumpReleaseFactor),
  });
}

/**
 * Phase 25.13: climbing and walls — the controller's climb speed, climb
 * action, wall slide and wall jump (the project model's
 * DEFAULT_CONTROLLER_MOVEMENT states the same defaults with their reasons:
 * this package reads the runtime's types only). `wallJumpAway`/`wallJumpUp`
 * null: the run speed and the jump velocity.
 */
export interface ControllerMovementTuning {
  readonly climbSpeed: number;
  readonly climbAction: string | null;
  readonly wallSlide: boolean;
  readonly wallSlideSpeed: number;
  readonly wallJump: boolean;
  readonly wallJumpAway: number | null;
  readonly wallJumpUp: number | null;
}

export const DEFAULT_MOVEMENT_TUNING: ControllerMovementTuning = Object.freeze({
  climbSpeed: 2,
  climbAction: null,
  wallSlide: false,
  wallSlideSpeed: 2,
  wallJump: false,
  wallJumpAway: null,
  wallJumpUp: null,
});

/**
 * Phase 25.13: how far up or down the climb input must be pushed to take
 * hold of a climb volume (more than half: a stick's resting drift or a mostly
 * sideways push does not grab; a key or a full push does).
 */
export const CLIMB_GRAB_INPUT = 0.5;

/** Phase 25.13: the climb and wall tuning a `controller` component describes (each absent field at its default). */
export function controllerMovementTuning(controller: unknown): ControllerMovementTuning {
  const c = (typeof controller === 'object' && controller !== null ? controller : {}) as Record<string, unknown>;
  const d = DEFAULT_MOVEMENT_TUNING;
  const num = (k: string): number | null => (typeof c[k] === 'number' && Number.isFinite(c[k]) ? (c[k] as number) : null);
  const bool = (k: string, f: boolean): boolean => (typeof c[k] === 'boolean' ? (c[k] as boolean) : f);
  return Object.freeze({
    climbSpeed: num('climbSpeed') ?? d.climbSpeed,
    climbAction: typeof c['climbAction'] === 'string' ? (c['climbAction'] as string) : null,
    wallSlide: bool('wallSlide', d.wallSlide),
    wallSlideSpeed: num('wallSlideSpeed') ?? d.wallSlideSpeed,
    wallJump: bool('wallJump', d.wallJump),
    wallJumpAway: num('wallJumpAway'),
    wallJumpUp: num('wallJumpUp'),
  });
}

/** Phase 25.13: what the controller step needs beyond the packet-32 input: the climb input, the volume it is in, the tuning. */
export interface ControllerMovementInput {
  /** The climb input: up (+1) to down (−1). */
  readonly climbY: number;
  /** The climb volume the character is in now (null: none). */
  readonly climb: ClimbVolumeView | null;
  readonly tuning: ControllerMovementTuning;
}

/**
 * Ground-contact classification tolerance (`physics.md` §7/§8: compares
 * `supportNormal.y` with `cos(max_slope_climb_deg)` within `1e-6`).
 */
export const GROUND_NORMAL_TOLERANCE = 1e-6;

/**
 * The controller's private per-step state (the controller contract §4). Created at
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
  /** Phase 25.13: the climb volume it holds on to (null: not climbing). */
  climbing: string | null;
  /** Phase 25.13: the side of the wall it last touched in the air (−1 left, 1 right) and the steps that touch still counts for a wall jump. */
  wallSide: -1 | 0 | 1;
  wallCoyote: number;
  /** Phase 25.13: rising from a wall jump — the input does not steer until the top of the jump. */
  wallJumped: boolean;
}

/** the controller contract §7 `approach(v, target, up, down)` — never overshoots. */
export function approach(v: number, target: number, up: number, down: number): number {
  if (Math.abs(target - v) <= 1e-9) return target;
  if (v < target) return Math.min(target, v + up);
  if (v > target) return Math.max(target, v - down);
  return v;
}

/** Create the state at the authored character transform (the controller contract §4); the coyote window starts full. */
export function createControllerState(charX: number, charY: number, coyoteSteps: number = CONTROLLER_CONSTANTS.coyoteSteps): ControllerState {
  return {
    vx: 0,
    vy: 0,
    airborne: false,
    coyote: coyoteSteps,
    buffer: 0,
    jumpStarted: false,
    prevResult: undefined,
    charX,
    charY,
    slideSteps: 0,
    climbing: null,
    wallSide: 0,
    wallCoyote: 0,
    wallJumped: false,
  };
}

/** Phase 25.13: the side of a wall the last step pushed into in the air (0: none). */
function wallContactSide(p: CharacterMoveResult | undefined, grounded: boolean): -1 | 0 | 1 {
  if (p === undefined || grounded || p.contacts.wall !== true) return 0;
  if (!(Math.abs(p.requested.x) - Math.abs(p.applied.x) > 1e-7)) return 0;
  return p.requested.x > 0 ? 1 : -1;
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
 * the controller contract §7's A–K algorithm contains no sliding rule, while
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
 * One executed controller step (the controller contract §7, exact order). Reads the
 * previous result from `state.prevResult` and stages exactly one character
 * move; the caller (the runtime) commits the port result afterwards.
 *
 * `dt` is `1 / fixedStepHz` captured at `create()` (the accepted `StepContext`
 * does not carry the step rate; the controller contract §7 defines `dt` as that
 * value). `cosMaxSlopeClimb`/`cosMinSlopeSlide` are the resolved settings'
 * angles in radians-precomputed cosine form.
 */
/**
 * Phase 24.8: the input actions a `controller` component names (`moveAction`,
 * `jumpAction`; absent: `move` and `jump`, project-model's
 * CONTROLLER_ACTION_DEFAULTS — the model validated the names).
 */
export function controllerActionNames(controller: unknown): { move: string; jump: string } {
  const c = (typeof controller === 'object' && controller !== null ? controller : {}) as Record<string, unknown>;
  return {
    move: typeof c['moveAction'] === 'string' ? c['moveAction'] : 'move',
    jump: typeof c['jumpAction'] === 'string' ? c['jumpAction'] : 'jump',
  };
}

/** The horizontal move of an action (a 2D axis' x, else its value; 0 when absent). */
function moveOf(frame: ActionFrame, name: string): number {
  const a = frame.actions?.[name];
  return a === undefined ? 0 : (a.x ?? a.v);
}

/**
 * Phase 25.13: the climb input — the climb action's value (or its y, a 2D
 * axis) when the controller names one, else the move action's y; a script's
 * `control_move` intent gives its y instead.
 */
function climbInput(ctx: { readonly action: ActionFrame; readonly intents: { readonly move: number | null; readonly moveY?: number | null } }, move: string, climbAction: string | null): number {
  if (ctx.intents.move !== null && climbAction === null) return ctx.intents.moveY ?? 0;
  const a = ctx.action.actions?.[climbAction ?? move];
  if (a === undefined) return 0;
  return climbAction !== null ? (a.y ?? a.v) : (a.y ?? 0);
}

/** The button phase of an action ('none' when absent). */
function phaseOf(frame: ActionFrame, name: string): JumpPhase {
  return frame.actions?.[name]?.p ?? 'none';
}

/**
 * Phase 24.8: the controller's own input for one step — the horizontal move
 * (−1..1) and the jump phase (the motor contract the packet-17 traces pin).
 */
export interface ControllerInput {
  readonly stepIndex: number;
  readonly moveX: number;
  readonly jump: JumpPhase;
}

export function controllerStep(
  state: ControllerState,
  charId: string,
  frame: ControllerInput,
  settings: Readonly<GameplaySettings>,
  dt: number,
  cosMaxSlopeClimb: number,
  cosMinSlopeSlide: number,
  tanMinSlopeSlide: number,
  physics: PhysicsStepClient,
  tuning: ControllerStepTuning = DEFAULT_STEP_TUNING,
  impulse?: { readonly x: number; readonly y: number },
  movement?: ControllerMovementInput,
): void {
  const p = state.prevResult;
  const groundedPrev = isGrounded(p, cosMaxSlopeClimb);
  const mv = movement?.tuning ?? DEFAULT_MOVEMENT_TUNING;

  // Phase 25.13: climbing. Inside a climb volume, up/down (and sideways) move it along (and across)
  // the volume at the climb speed without gravity; a jump press leaves with a jump, and so does
  // moving out of the volume (it keeps its speed and falls). Without climb volumes nothing changes.
  const climb = movement?.climb ?? null;
  let leapt = false;
  if (state.climbing !== null) {
    if (climb === null) state.climbing = null;
    else if (frame.jump === 'pressed') {
      state.climbing = null;
      state.vy = settings.jump_velocity;
      state.airborne = true;
      state.buffer = 0;
      state.coyote = 0;
      leapt = true;
    } else {
      climbStep(state, charId, frame.moveX, movement!.climbY, climb, mv.climbSpeed, dt, physics);
      return;
    }
  } else if (climb !== null && Math.abs(movement!.climbY) >= CLIMB_GRAB_INPUT && !(state.airborne && state.vy > 0)) {
    // Take hold (not while still rising from a jump: a jump off a climb volume leaves it).
    state.climbing = climb.id;
    state.airborne = false;
    climbStep(state, charId, frame.moveX, movement!.climbY, climb, mv.climbSpeed, dt, physics);
    return;
  }
  // Phase 25.13: the wall it touches in the air (wall slide and wall jump only; a touch counts for the coyote window).
  let wallNow: -1 | 0 | 1 = 0;
  if (mv.wallSlide || mv.wallJump) {
    wallNow = wallContactSide(p, groundedPrev);
    if (wallNow !== 0) {
      state.wallSide = wallNow;
      state.wallCoyote = tuning.coyoteSteps + 1;
    } else if (groundedPrev) state.wallCoyote = 0;
    else state.wallCoyote = Math.max(0, state.wallCoyote - 1);
  }

  if (leapt) state.jumpStarted = true;
  else {
    // A. jump press edge refreshes the buffer window.
    if (frame.jump === 'pressed') state.buffer = tuning.jumpBufferSteps;
    // B. a grounded step refreshes the coyote window.
    if (groundedPrev) state.coyote = tuning.coyoteSteps;
    // C. one jump start per press: grounded or inside coyote, never airborne.
    if (state.buffer > 0 && (groundedPrev || state.coyote > 0) && !state.airborne) {
      state.vy = settings.jump_velocity;
      state.airborne = true;
      state.buffer = 0;
      state.coyote = 0;
      state.jumpStarted = true;
    } else if (mv.wallJump && state.buffer > 0 && !groundedPrev && state.wallCoyote > 0 && state.wallSide !== 0) {
      // Phase 25.13: a wall jump — off the wall it touches (or just touched), away from it and up.
      state.vx = -state.wallSide * (mv.wallJumpAway ?? settings.run_speed);
      state.vy = mv.wallJumpUp ?? settings.jump_velocity;
      state.airborne = true;
      state.buffer = 0;
      state.coyote = 0;
      state.wallCoyote = 0;
      state.wallJumped = true;
      state.jumpStarted = true;
    } else {
      state.jumpStarted = false;
    }
  }
  // Phase 24.4f: scripts' impulses add to the velocity (up lifts it into an airborne arc; the
  // horizontal approach below brings x back to what the input asks at its acceleration).
  if (impulse !== undefined) {
    state.vx += impulse.x;
    if (impulse.y !== 0) {
      state.vy = (state.airborne || !groundedPrev ? state.vy : 0) + impulse.y;
      if (impulse.y > 0) {
        state.airborne = true;
        state.buffer = 0;
        state.coyote = 0;
      }
    }
  }
  // D. grounded (and not airborne) ⇒ rest vertically; else integrate gravity.
  if (groundedPrev && !state.airborne) state.vy = 0;
  else state.vy = Math.max(state.vy + settings.gravity_y * dt, settings.max_fall_speed);
  // Phase 25.13: a wall slide — falling in the air while pushing into the wall it touches: no faster than the slide speed.
  if (mv.wallSlide && wallNow !== 0 && Math.sign(frame.moveX) === wallNow && state.vy < -mv.wallSlideSpeed) state.vy = -mv.wallSlideSpeed;
  // E. head contact clamps upward velocity (no ceiling hover).
  if (p !== undefined && p.contacts.head === true && state.vy > 0) state.vy = 0;
  // F. variable height: a release while ascending halves vy exactly once.
  if (frame.jump === 'released' && state.airborne) {
    if (state.vy > 0) state.vy = state.vy * tuning.jumpReleaseFactor;
    state.airborne = false;
  }
  // G. landing classification (a grounded step with non-positive vy).
  if (state.airborne && groundedPrev && state.vy <= 0) state.airborne = false;
  // Phase 25.13: a wall jump keeps its push away from the wall until the top of the jump (or a landing).
  if (state.wallJumped && (state.vy <= 0 || groundedPrev && !state.jumpStarted)) state.wallJumped = false;
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
  if (!state.wallJumped) state.vx = approach(
    state.vx,
    target,
    tuning.moveAccel * dt,
    tuning.moveDecel * dt,
  );
  // I. stage the requested delta (the only mutation this module performs).
  physics.stageCharacterMove(charId, { x: state.vx * dt, y: state.vy * dt });
  // J. coyote bookkeeping (integer steps; one decrement per airborne step).
  if (!groundedPrev) state.coyote = Math.max(0, state.coyote - 1);
  // K. buffer bookkeeping (a consumed press is not decremented).
  if (!state.jumpStarted) state.buffer = Math.max(0, state.buffer - 1);
}

/**
 * Phase 25.13: one climbing step — along the volume's up axis by the climb
 * input and across it by the move input, at the climb speed, no gravity.
 */
function climbStep(state: ControllerState, charId: string, moveX: number, climbY: number, v: ClimbVolumeView, speed: number, dt: number, physics: PhysicsStepClient): void {
  const along = Math.max(-1, Math.min(1, climbY));
  const across = Math.max(-1, Math.min(1, moveX));
  state.vx = (v.up[0] * along + v.across[0] * across) * speed;
  state.vy = (v.up[1] * along + v.across[1] * across) * speed;
  state.buffer = 0;
  state.coyote = 0;
  state.jumpStarted = false;
  state.wallCoyote = 0;
  physics.stageCharacterMove(charId, { x: state.vx * dt, y: state.vy * dt });
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
      `thirdlight.character:controller requires exactly one components.controller entity (found ${ids.length})`,
    );
  }
  return ids[0] as string;
}

/** Build a controller module instance (the controller contract §4/§12). */
export function createControllerModule(
  snapshot: RuntimeSnapshot,
  cfg: ModuleConfig,
): SimulationPhaseModule {
  const charId = findControllerEntity(snapshot);
  const entity = snapshot.scene.entities.find((e) => e.id === charId);
  const transform = entity?.components.transform;
  if (!transform) {
    throw new Error(`thirdlight.character:controller entity "${charId}" has no transform component`);
  }
  if (cfg.fixedStepHz <= 0 || !Number.isFinite(cfg.fixedStepHz)) {
    throw new Error('thirdlight.character:controller requires a positive fixedStepHz');
  }
  const dt = 1 / cfg.fixedStepHz;
  const cosMaxSlopeClimb = Math.cos((cfg.settings.max_slope_climb_deg * Math.PI) / 180);
  const cosMinSlopeSlide = Math.cos((cfg.settings.min_slope_slide_deg * Math.PI) / 180);
  const tanMinSlopeSlide = Math.tan((cfg.settings.min_slope_slide_deg * Math.PI) / 180);
  // Phase 15.3: the player's tuning (its controller data, else the defaults).
  const tuning = controllerStepTuning((entity?.components as { controller?: unknown } | undefined)?.controller, cfg.fixedStepHz);
  const state = createControllerState(transform.position[0], transform.position[1], tuning.coyoteSteps);
  // Phase 24.8: the input actions it reads.
  const names = controllerActionNames((entity?.components as { controller?: unknown } | undefined)?.controller);
  // Phase 25.13: climbing and walls.
  const movementTuning = controllerMovementTuning((entity?.components as { controller?: unknown } | undefined)?.controller);

  return {
    transformOwners: [charId],
    /**
     * The reset hook (the character was placed: a restart, an arrival, a
     * respawn): zero every window and velocity the step-indexed state can
     * carry, so nothing an earlier step left behind (a buffered or held jump,
     * the coyote window, the last result's grounding/support normal) survives
     * the placement. The next physics phase re-derives grounding from the
     * placed capsule. `slideSteps` is a bounded diagnostic counter, not a
     * window, so it is preserved.
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
      state.climbing = null;
      state.wallSide = 0;
      state.wallCoyote = 0;
      state.wallJumped = false;
    },
    step(phase, ctx): void {
      if (phase === 'controller') {
        // runtime.md §14.5 effective input: a committed intent for a channel
        // replaces the sampled channel for this phase only (`ctx.action`
        // itself stays the sampled frame).
        const effective: ControllerInput = {
          stepIndex: ctx.action.stepIndex,
          moveX: ctx.intents.move ?? moveOf(ctx.action, names.move),
          jump: ctx.intents.jump ?? phaseOf(ctx.action, names.jump),
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
          tuning,
          ctx.intents.impulse,
          {
            climbY: climbInput(ctx, names.move, movementTuning.climbAction),
            climb: ctx.climb?.volume() ?? null,
            tuning: movementTuning,
          },
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
 * The registered controller module spec (the controller contract §2 inventory):
 * phases `["controller", "transform"]`, the single `components.controller`
 * entity as its transform owner, mutually exclusive with the M1 demo module
 * and requiring the injected physics port.
 */
export const characterControllerSpec: SimulationModuleSpec = {
  id: CHARACTER_MODULE_ID,
  phases: ['controller', 'transform'],
  excludes: ['thirdlight.demo:box-motion'],
  requiresPhysicsPort: true,
  create: createControllerModule,
};
