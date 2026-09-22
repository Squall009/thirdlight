/**
 * The pure raw-snapshot → `ActionFrame` mapping (input.md §4/§9; runtime.md
 * §12.5.2/§12.5.3).
 *
 * Pure and deterministic: identical `(snapshot, options)` inputs always
 * produce an identical frame. No DOM, no clock, no randomness, no module
 * state. The only stateful part of the binding (the press latch and the
 * previous jump-down bit) is passed *in* by the caller and returned as a
 * `next` state so both the browser owner and the replayable step source can
 * thread it identically.
 *
 * Semantics, in order (input.md §4.3, no summation anywhere):
 *  1. keyboard digital: exactly one of left/right held ⇒ `-1`/`+1`; both or
 *     neither ⇒ no keyboard contribution;
 *  2. else D-pad: exactly one of buttons 14/15 ⇒ `-1`/`+1`; both ⇒ none;
 *  3. else the rescaled stick value of the standard-mapped active pad;
 *  4. else `0`.
 * A pad whose `mapping` is not `'standard'` contributes nothing at all
 * (input.md §4.1). Jump is the logical OR of the mapped controls across the
 * active sources; its phase chain is computed once, on that OR.
 */
import type { ActionFrame, JumpPhase } from '@thirdlight/runtime';
import { GAMEPAD_DEAD_ZONE, type RawInputSnapshot } from './types';

/** The nested gamepad shape, addressed from the public snapshot type. */
type GamepadSnapshot = NonNullable<RawInputSnapshot['gamepad']>;

/** The per-source sampling state threaded across samples (input.md §3.2/§5.3). */
export interface StepState {
  /** Jump control down as of the previous produced frame (`prevDown`). */
  down: boolean;
  /**
   * `true` after a suspension / hot disconnect until the jump control has
   * been observed up once: a physically down control then yields `held`,
   * never `pressed` (fresh activation, input.md §5.3/§5.4).
   */
  awaitingRelease: boolean;
}

/** Sampling options for one step (the caller owns `StepState`). */
export interface MapRawOptions {
  /** The executed fixed-step index the frame is labelled with. */
  stepIndex: number;
  /** Previous `StepState.down`; defaults to `false`. */
  previousJumpDown?: boolean;
  /** Previous `StepState.awaitingRelease`; defaults to `false`. */
  jumpAwaitingRelease?: boolean;
}

/**
 * The standard-mapped gamepad contribution, or `null` (absent or
 * non-standard mapping — ignored, input.md §4.1).
 */
function standardGamepad(raw: RawInputSnapshot): GamepadSnapshot | null {
  const gp = raw.gamepad;
  if (!gp || gp.mapping !== 'standard') return null;
  return gp;
}

/** Radial dead zone with linear rescaling to `[-1, 1]` (input.md §4.2). */
export function rescaleStick(axis0: number): number {
  if (!Number.isFinite(axis0)) return 0;
  const a = Math.abs(axis0);
  if (a <= GAMEPAD_DEAD_ZONE) return 0;
  const scaled = Math.min((a - GAMEPAD_DEAD_ZONE) / (1 - GAMEPAD_DEAD_ZONE), 1);
  return Math.sign(axis0) * scaled;
}

/**
 * `round(v·1e4)/1e4` after clamping to `[-1, 1]`, with negative zero
 * normalized to `0` (input.md §3.3). The rounding direction matches the
 * runtime's frame validator (`@thirdlight/runtime` `quantizeMove`, which uses
 * `Math.round`) so every frame this package emits passes `validateActionFrame`
 * unchanged.
 */
export function quantizeMove(v: number): number {
  const clamped = Math.max(-1, Math.min(1, v));
  const q = Math.round(clamped * 1e4) / 1e4;
  return q === 0 ? 0 : q;
}

/** Exactly one of two opposing controls held (input.md §4.3 cancel rule). */
function opposing(left: boolean, right: boolean): -1 | 0 | 1 {
  if (left && !right) return -1;
  if (right && !left) return 1;
  return 0;
}

function jumpDownOf(raw: RawInputSnapshot, gp: GamepadSnapshot | null): boolean {
  return raw.keyboardJump === true || (gp !== null && gp.button0 === true);
}

/**
 * One mapping step: the produced frame plus the next sampling state. Shared
 * by `mapRawInput` (pure one-shot) and the replayable step source.
 */
export function mapRawStep(
  snapshot: RawInputSnapshot,
  options: MapRawOptions,
): { frame: ActionFrame; next: StepState } {
  const gp = standardGamepad(snapshot);
  const keyboardDigital = opposing(snapshot.keyboardLeft === true, snapshot.keyboardRight === true);
  const dpadDigital = gp === null ? 0 : opposing(gp.button14 === true, gp.button15 === true);
  const digital = keyboardDigital !== 0 ? keyboardDigital : dpadDigital;
  const stick = gp === null ? 0 : rescaleStick(gp.axis0);
  const moveX = quantizeMove(digital !== 0 ? digital : stick);

  const downNow = jumpDownOf(snapshot, gp);
  const awaitingRelease = options.jumpAwaitingRelease === true;
  const prevDown = options.previousJumpDown === true;

  let jump: JumpPhase;
  let next: StepState;
  if (awaitingRelease) {
    // Fresh activation (input.md §5.3/§5.4): a down control is `held`, never
    // `pressed`; normal sampling resumes only after the control is up once.
    jump = downNow ? 'held' : 'none';
    next = { down: downNow, awaitingRelease: downNow };
  } else {
    const down = downNow || snapshot.jumpLatch === true;
    if (down && !prevDown) jump = 'pressed';
    else if (down && prevDown) jump = 'held';
    else if (!down && prevDown) jump = 'released';
    else jump = 'none';
    next = { down, awaitingRelease: false };
  }

  return { frame: { stepIndex: options.stepIndex, moveX, jump }, next };
}

/**
 * The pure mapping entry point (dependencies.md §3 `input` row): one
 * `ActionFrame` for one raw snapshot. `options` carries the executed step
 * index and the caller's previous sampling state; the caller clears the
 * snapshot's press latch and stores the returned state after the call.
 */
export function mapRawInput(snapshot: RawInputSnapshot, options: MapRawOptions): ActionFrame {
  return mapRawStep(snapshot, options).frame;
}
