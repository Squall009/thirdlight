/**
 * Phase 15.3: the controller's acceleration, deceleration, coyote time, jump
 * buffer and jump-release factor are the player's `controller` data; the
 * windows are seconds converted to whole steps at the module's step rate. A
 * controller without them gets exactly the packet-32 values (the replays).
 */
import { describe, expect, it } from 'vitest';
import type { ActionFrame, CharacterMoveResult, GameplaySettings, PhysicsStepClient } from '@thirdlight/runtime';

import { CONTROLLER_CONSTANTS } from './constants';
import { DEFAULT_STEP_TUNING, controllerStep, controllerStepTuning, createControllerState } from './controller';

const SETTINGS: Readonly<GameplaySettings> = Object.freeze({ gravity_y: -20, run_speed: 4, jump_velocity: 8, max_fall_speed: -30, max_slope_climb_deg: 45, min_slope_slide_deg: 30 });
const COS_MAX = Math.cos(Math.PI / 4);
const COS_MIN = Math.cos(Math.PI / 6);
const TAN_MIN = Math.tan(Math.PI / 6);

const ground = (grounded: boolean): CharacterMoveResult => ({
  requested: { x: 0, y: 0 },
  applied: { x: 0, y: 0 },
  position: { x: 0, y: 0.91 },
  grounded,
  supportNormal: { x: 0, y: 1 },
  contacts: { ground: grounded, wall: false, head: false, steepSlope: false },
  snapped: false,
});

function run(tuningSource: unknown, hz: number, frames: { moveX: number; jump: ActionFrame['jump']; grounded: boolean }[]): { vx: number; vy: number; dy: number }[] {
  const tuning = controllerStepTuning(tuningSource, hz);
  const state = createControllerState(0, 0.91, tuning.coyoteSteps);
  const out: { vx: number; vy: number; dy: number }[] = [];
  let staged = { x: 0, y: 0 };
  const client: PhysicsStepClient = { stageCharacterMove: (_id, d) => (staged = { x: d.x, y: d.y }), characterResult: () => undefined };
  frames.forEach((f, i) => {
    state.prevResult = ground(f.grounded);
    controllerStep(state, 'char', { stepIndex: i, moveX: f.moveX, jump: f.jump }, SETTINGS, 1 / hz, COS_MAX, COS_MIN, TAN_MIN, client, undefined, tuning);
    out.push({ vx: state.vx, vy: state.vy, dy: staged.y });
  });
  return out;
}

describe('controller tuning as data (phase 15.3)', () => {
  it('an empty controller is exactly the packet-32 constants at 120 Hz', () => {
    expect(controllerStepTuning({}, 120)).toEqual(DEFAULT_STEP_TUNING);
    expect(controllerStepTuning(undefined, 120)).toEqual({
      moveAccel: CONTROLLER_CONSTANTS.moveAccel,
      moveDecel: CONTROLLER_CONSTANTS.moveDecel,
      coyoteSteps: CONTROLLER_CONSTANTS.coyoteSteps,
      jumpBufferSteps: CONTROLLER_CONSTANTS.jumpBufferSteps,
      jumpReleaseFactor: CONTROLLER_CONSTANTS.jumpReleaseFactor,
    });
    // spelled out, the defaults give the same numbers
    expect(controllerStepTuning({ acceleration: 40, deceleration: 60, coyoteTime: 0.05, jumpBuffer: 8 / 120, jumpRelease: 0.5 }, 120)).toEqual(DEFAULT_STEP_TUNING);
  });

  it('windows are seconds: the same time at 60 and 240 Hz', () => {
    expect(controllerStepTuning({}, 60)).toMatchObject({ coyoteSteps: 3, jumpBufferSteps: 4 });
    expect(controllerStepTuning({}, 240)).toMatchObject({ coyoteSteps: 12, jumpBufferSteps: 16 });
    expect(controllerStepTuning({ coyoteTime: 0.2, jumpBuffer: 0 }, 120)).toMatchObject({ coyoteSteps: 24, jumpBufferSteps: 0 });
  });

  it('acceleration and deceleration shape the run', () => {
    const accel = (c: unknown) => run(c, 120, Array.from({ length: 3 }, () => ({ moveX: 1, jump: 'none' as const, grounded: true }))).map((s) => s.vx);
    expect(accel({})[0]).toBeCloseTo(40 / 120, 12);
    expect(accel({ acceleration: 120 })[0]).toBeCloseTo(1, 12);
    const stop = (c: unknown) => run(c, 120, [...Array.from({ length: 60 }, () => ({ moveX: 1, jump: 'none' as const, grounded: true })), { moveX: 0, jump: 'none' as const, grounded: true }]).at(-1)!.vx;
    expect(stop({})).toBeCloseTo(4 - 60 / 120, 12);
    expect(stop({ deceleration: 240 })).toBeCloseTo(2, 12);
  });

  it('coyote time: a jump after walking off an edge starts only inside the window', () => {
    const offEdge = (c: unknown, airSteps: number) => {
      const frames = [
        { moveX: 0, jump: 'none' as const, grounded: true },
        ...Array.from({ length: airSteps }, () => ({ moveX: 0, jump: 'none' as const, grounded: false })),
        { moveX: 0, jump: 'pressed' as const, grounded: false },
      ];
      return run(c, 120, frames).at(-1)!.vy;
    };
    expect(offEdge({}, 4)).toBeGreaterThan(7); // within 6 steps
    expect(offEdge({}, 8)).toBeLessThan(0); // too late: falling
    expect(offEdge({ coyoteTime: 0.2 }, 8)).toBeGreaterThan(7); // 24 steps
    expect(offEdge({ coyoteTime: 0 }, 1)).toBeLessThan(0);
  });

  it('the jump-release factor cuts the rising speed on an early release', () => {
    const release = (c: unknown) =>
      run(c, 120, [
        { moveX: 0, jump: 'pressed', grounded: true },
        { moveX: 0, jump: 'held', grounded: false },
        { moveX: 0, jump: 'released', grounded: false },
      ]);
    const d = release({});
    const f = release({ jumpRelease: 1 });
    const q = release({ jumpRelease: 0.25 });
    // before the release all three rise alike
    expect(f[1]!.vy).toBe(d[1]!.vy);
    const beforeRelease = d[1]!.vy - 20 / 120;
    expect(d[2]!.vy).toBeCloseTo(beforeRelease * 0.5, 12);
    expect(f[2]!.vy).toBeCloseTo(beforeRelease, 12);
    expect(q[2]!.vy).toBeCloseTo(beforeRelease * 0.25, 12);
  });

  it('the jump buffer remembers a press before landing for its length', () => {
    const buffered = (c: unknown, early: number) => {
      const frames = [
        { moveX: 0, jump: 'pressed' as const, grounded: false },
        ...Array.from({ length: early }, () => ({ moveX: 0, jump: 'held' as const, grounded: false })),
        { moveX: 0, jump: 'held' as const, grounded: true },
      ];
      // no coyote: the first frame is airborne with an empty window
      return run({ coyoteTime: 0, ...(c as object) }, 120, frames).at(-1)!.vy;
    };
    expect(buffered({}, 5)).toBeGreaterThan(7);
    expect(buffered({}, 9)).toBeLessThanOrEqual(0);
    expect(buffered({ jumpBuffer: 0.2 }, 9)).toBeGreaterThan(7);
  });
});
