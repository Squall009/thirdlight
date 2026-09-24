/**
 * Packet 32 — controller unit tests (pure, no library, no I/O).
 *
 * These exercise the algorithm of `platformer.md` §7 A–K and the
 * classification of `physics.md` §8 with a deterministic in-memory
 * `PhysicsStepClient`: single jump, variable height on release, the
 * integer-step coyote/jump-buffer windows (including the off-by-one edges),
 * repeated/air jumps, head contact, maximum fall speed, grounding from
 * support normals, steep-slope refusal and the C32-1 slide policy.
 *
 * The step-indexed traces of the accepted contract fixture are replayed in
 * `tests/m2-controller/contract-traces.test.ts` (repo level, where reading
 * fixtures is allowed); this file uses no external data.
 */
import { describe, expect, it } from 'vitest';
import type { ActionFrame, CharacterMoveResult, GameplaySettings, PhysicsStepClient } from '@thirdlight/runtime';
import { CONTROLLER_CONSTANTS, PLATFORMER_MODULE_ID } from './constants';
import {
  approach,
  controllerStep,
  createControllerState,
  isGrounded,
  slideDirection,
} from './controller';

const DT = 1 / 120;
const SETTINGS: Readonly<GameplaySettings> = Object.freeze({
  gravity_y: -19.62,
  run_speed: 4,
  jump_velocity: 7,
  max_fall_speed: -30,
  max_slope_climb_deg: 45,
  min_slope_slide_deg: 30,
});
const COS_MAX = Math.cos((45 * Math.PI) / 180);
const COS_MIN = Math.cos((30 * Math.PI) / 180);
const TAN_MIN = Math.tan((30 * Math.PI) / 180);

function frame(moveX: number, jump: ActionFrame['jump'] = 'none', stepIndex = 12): ActionFrame {
  return { stepIndex, moveX, jump };
}

interface ResultOverrides {
  applied?: { x: number; y: number };
  position?: { x: number; y: number };
  grounded?: boolean;
  supportNormal?: { x: number; y: number };
  contacts?: Partial<CharacterMoveResult['contacts']>;
  snapped?: boolean;
}

let seq = 0;
function result(requested: { x: number; y: number }, overrides: ResultOverrides = {}): CharacterMoveResult {
  seq += 1;
  const position = overrides.position ?? { x: seq * 0.01, y: 0.91 };
  return {
    requested,
    applied: overrides.applied ?? { x: requested.x, y: requested.y },
    position,
    grounded: overrides.grounded ?? true,
    supportNormal: overrides.supportNormal ?? { x: 0, y: 1 },
    contacts: {
      ground: overrides.grounded ?? true,
      wall: false,
      head: false,
      steepSlope: false,
      ...overrides.contacts,
    },
    snapped: overrides.snapped ?? false,
  };
}

type State = ReturnType<typeof createControllerState>;

function harness() {
  const staged: { entityId: string; delta: { x: number; y: number } }[] = [];
  const client: PhysicsStepClient = {
    stageCharacterMove: (entityId, delta) => {
      staged.push({ entityId, delta: { x: delta.x, y: delta.y } });
    },
    characterResult: () => undefined,
  };
  /** Seed the previous completed result (as the runtime's transform phase does). */
  const seed = (state: State, overrides: ResultOverrides = {}): CharacterMoveResult => {
    const r = result({ x: 0, y: 0 }, overrides);
    state.prevResult = r;
    return r;
  };
  return {
    client,
    staged,
    seed,
    /**
     * Run one controller step with `state.prevResult` already seeded, then
     * commit the port result exactly as the runtime does (physics phase
     * commits the position; the transform phase records `prevResult`).
     */
    step(state: State, f: ActionFrame, overrides: ResultOverrides = {}): CharacterMoveResult {
      controllerStep(state, 'char-0001', f, SETTINGS, DT, COS_MAX, COS_MIN, TAN_MIN, client);
      const requested = staged[staged.length - 1]?.delta ?? { x: 0, y: 0 };
      const r = result(requested, overrides);
      state.prevResult = r;
      state.charX = r.position.x;
      state.charY = r.position.y;
      return r;
    },
  };
}

describe('contract constants (dependencies.md §3 platformer row)', () => {
  it('exposes the module id and the platformer.md §12 constants', () => {
    expect(PLATFORMER_MODULE_ID).toBe('thirdlight.platformer:controller');
    expect(CONTROLLER_CONSTANTS).toEqual({
      offsetSkin: 0.01,
      groundSnap: 0.1,
      autostep: false,
      moveAccel: 40,
      moveDecel: 60,
      coyoteSteps: 6,
      jumpBufferSteps: 8,
      jumpReleaseFactor: 0.5,
      settlePreRollSteps: 12,
    });
  });

  it('starts at the authored transform with the platformer.md §4 state', () => {
    expect(createControllerState(1.5, 0.91)).toEqual({
      vx: 0,
      vy: 0,
      airborne: false,
      coyote: 6,
      buffer: 0,
      jumpStarted: false,
      prevResult: undefined,
      charX: 1.5,
      charY: 0.91,
      slideSteps: 0,
    });
  });

  it('approach() never overshoots and arrives exactly (§7.2 1e-9 snap)', () => {
    expect(approach(0, 4, 40 * DT, 60 * DT)).toBeCloseTo(1 / 3, 12);
    expect(approach(3.9, 4, 40 * DT, 60 * DT)).toBe(4);
    expect(approach(4.1, 4, 40 * DT, 60 * DT)).toBe(4);
    expect(approach(4, 4.0000000001, 40 * DT, 60 * DT)).toBe(4.0000000001);
  });
});

describe('grounding from support normals (physics.md §8)', () => {
  it('is grounded only with a support normal at or above the climb angle', () => {
    expect(isGrounded(result({ x: 0, y: 0 }, { supportNormal: { x: 0, y: 1 } }), COS_MAX)).toBe(true);
    expect(isGrounded(result({ x: 0, y: 0 }, { supportNormal: { x: -0.5, y: COS_MAX } }), COS_MAX)).toBe(true);
    // 45.1°: below cos(45°) ⇒ steepSlope, treated as not grounded (§8 item 4).
    expect(isGrounded(result({ x: 0, y: 0 }, { supportNormal: { x: -0.7075, y: 0.70587157 } }), COS_MAX)).toBe(false);
    expect(isGrounded(undefined, COS_MAX)).toBe(false);
    expect(isGrounded(result({ x: 0, y: 0 }, { grounded: false }), COS_MAX)).toBe(false);
  });

  it('keeps applying gravity on a steepSlope ground even though the port flagged it grounded', () => {
    const state = createControllerState(0, 2);
    const h = harness();
    // Settle onto a 45.1° face: the port's raw grounded is true but the
    // controller classifies it as not grounded.
    h.seed(state, { supportNormal: { x: -0.7075, y: 0.70587157 } });
    h.step(state, frame(0), { supportNormal: { x: -0.7075, y: 0.70587157 } });
    // groundedPrev false ⇒ gravity integrated this step, not zeroed.
    expect(state.vy).toBeCloseTo(SETTINGS.gravity_y * DT, 12);
  });
});

describe('jump (platformer.md §7 A–G)', () => {
  it('starts one jump on the press edge and integrates gravity the same step', () => {
    const state = createControllerState(0, 0.91);
    const h = harness();
    h.seed(state, {});
    h.step(state, frame(0, 'pressed'));
    expect(state.vy).toBeCloseTo(7 + SETTINGS.gravity_y * DT, 12);
    expect(state.airborne).toBe(true);
    expect(state.buffer).toBe(0);
    expect(state.coyote).toBe(0);
    expect(h.staged).toEqual([{ entityId: 'char-0001', delta: { x: 0, y: state.vy * DT } }]);
  });

  it('never air-jumps: the maximum vy is the press-step jump velocity', () => {
    const state = createControllerState(0, 0.91);
    const h = harness();
    h.seed(state, {});
    h.step(state, frame(0, 'pressed'));
    const maxVy = state.vy;
    for (let i = 0; i < 6; i += 1) {
      h.step(state, frame(0), { grounded: false });
      expect(state.vy).toBeLessThanOrEqual(maxVy);
    }
    const before = state.vy;
    h.step(state, frame(0, 'pressed'), { grounded: false });
    // The press only integrates gravity — no second jump.
    expect(state.vy).toBeCloseTo(before + SETTINGS.gravity_y * DT, 12);
    expect(state.airborne).toBe(true);
  });

  it('halves the ascending velocity once on release (variable height)', () => {
    const state = createControllerState(0, 0.91);
    const h = harness();
    h.seed(state, {});
    h.step(state, frame(0, 'pressed'));
    const maxVy = state.vy;
    h.step(state, frame(0, 'none'), { grounded: false });
    const vyBeforeRelease = state.vy;
    h.step(state, frame(0, 'released'), { grounded: false });
    // §7 order: D integrates gravity first, then F halves the ascending vy.
    expect(state.vy).toBeCloseTo((vyBeforeRelease + SETTINGS.gravity_y * DT) * 0.5, 12);
    expect(state.vy).toBeLessThan(maxVy);
    // A second release never halves again; it only integrates gravity.
    const vyAfterRelease = state.vy;
    h.step(state, frame(0, 'released'), { grounded: false });
    expect(state.vy).toBeCloseTo(vyAfterRelease + SETTINGS.gravity_y * DT, 12);
    const vyAfterSecond = state.vy;
    h.step(state, frame(0, 'none'), { grounded: false });
    expect(state.vy).toBeCloseTo(vyAfterSecond + SETTINGS.gravity_y * DT, 12);
  });

  it('clamps a head contact to vy = 0 (no ceiling hover)', () => {
    const state = createControllerState(0, 0.91);
    const h = harness();
    h.seed(state, {});
    h.step(state, frame(0, 'pressed'));
    // Step E reads the PREVIOUS step's head contact (§7 E), so the frame
    // after the contact step is the one clamped.
    h.step(state, frame(0, 'held'), { grounded: false, contacts: { head: true } });
    expect(state.vy).toBeGreaterThan(0);
    h.step(state, frame(0, 'held'), { grounded: false, contacts: { head: true } });
    expect(state.vy).toBe(0);
  });

  it('clamps the fall to max_fall_speed', () => {
    const state = createControllerState(0, 20);
    const h = harness();
    h.seed(state, { grounded: false });
    for (let i = 0; i < 400; i += 1) h.step(state, frame(0), { grounded: false });
    expect(state.vy).toBe(SETTINGS.max_fall_speed);
  });
});

describe('coyote and buffer windows (platformer.md §7.1)', () => {
  /**
   * The last step whose **result** is grounded is step 0. A press at step k
   * uses `groundedPrev = result(k−1).grounded`.
   */
  function coyoteCase(pressAt: number): boolean {
    const state = createControllerState(0, 0.91);
    const h = harness();
    h.seed(state, {});
    let jumped = false;
    for (let i = 0; i < 20; i += 1) {
      const before = state.vy;
      const f = i === pressAt ? frame(0, 'pressed', 12 + i) : frame(0, 'none', 12 + i);
      h.step(state, f, { grounded: i === 0 });
      if (state.vy > before + 1) jumped = true;
    }
    return jumped;
  }

  it('allows the jump at the last coyote step and refuses one step later (fixture boundary)', () => {
    // The last grounded result is step 0. The fixture's normative model
    // (`jump-coyote-last-step`: m = 14, last step = 21) permits the press at
    // m + 7 and refuses m + 8; platformer.md §7.1's "(m .. m+5)" prose is one
    // short of the replayed fixture (recorded as contract-change request
    // C32-3 in the evidence manifest).
    expect(coyoteCase(7)).toBe(true);
    expect(coyoteCase(8)).toBe(false);
  });

  it('fires a buffered press on the landing step 7 steps after the press', () => {
    const state = createControllerState(0, 2);
    state.coyote = 0; // the fixture's trace start state
    const h = harness();
    h.seed(state, { grounded: false });
    h.step(state, frame(0, 'pressed'), { grounded: false });
    expect(state.buffer).toBe(7);
    for (let i = 1; i <= 5; i += 1) h.step(state, frame(0), { grounded: false });
    expect(state.buffer).toBe(2);
    // Step 6 lands (its result is grounded); step 7 sees groundedPrev and fires.
    h.step(state, frame(0), { grounded: true });
    expect(state.buffer).toBe(1);
    const before = state.vy;
    h.step(state, frame(0), { grounded: true });
    expect(state.vy).toBeGreaterThan(before);
    expect(state.vy).toBeCloseTo(7 + SETTINGS.gravity_y * DT, 12);
  });

  it('expires a buffered press after the 8-step window', () => {
    const state = createControllerState(0, 2);
    state.coyote = 0; // the fixture's trace start state
    const h = harness();
    h.seed(state, { grounded: false });
    h.step(state, frame(0, 'pressed'), { grounded: false });
    for (let i = 1; i <= 7; i += 1) h.step(state, frame(0), { grounded: false });
    expect(state.buffer).toBe(0);
    h.step(state, frame(0), { grounded: true });
    h.step(state, frame(0), { grounded: true });
    // No jump: a grounded step rests at vy = 0 (never jump_velocity).
    expect(state.vy).toBe(0);
    expect(state.airborne).toBe(false);
  });
});

describe('horizontal movement and staging (§7 H–I)', () => {
  it('reaches run_speed in exactly 12 steps and stops in exactly 8', () => {
    const state = createControllerState(0, 0.91);
    const h = harness();
    h.seed(state, {});
    for (let i = 0; i < 12; i += 1) h.step(state, frame(1));
    expect(state.vx).toBeCloseTo(4, 12);
    for (let i = 0; i < 8; i += 1) h.step(state, frame(0));
    expect(state.vx).toBe(0);
  });

  it('stages exactly one plain { x, y } delta per step (no Z, no third key)', () => {
    const state = createControllerState(0, 0.91);
    const h = harness();
    h.seed(state, {});
    h.step(state, frame(1));
    expect(h.staged).toHaveLength(1);
    expect(Object.keys(h.staged[0]!.delta).sort()).toEqual(['x', 'y']);
  });

  it('keeps the horizontal intent into a wall (the port owns the clamp)', () => {
    const state = createControllerState(9, 0.91);
    const h = harness();
    h.seed(state, {});
    for (let i = 0; i < 12; i += 1) h.step(state, frame(1));
    const before = state.vx;
    h.step(state, frame(1), {
      applied: { x: 0, y: 0 },
      position: { x: 9.19, y: 0.91 },
      contacts: { wall: true },
    });
    expect(state.vx).toBeCloseTo(before, 12);
    expect(state.vy).toBe(0);
  });

  it('never raises a grounded character on its own (no autostep / stair climbing)', () => {
    const state = createControllerState(0, 0.91);
    const h = harness();
    h.seed(state, {});
    for (let i = 0; i < 30; i += 1) h.step(state, frame(1));
    // Every staged delta is horizontal while grounded and not jumping.
    expect(h.staged.every((s) => s.delta.y === 0)).toBe(true);
  });
});

describe('slide policy (C32-1, physics.md §7/§8 min_slope_slide_deg)', () => {
  it('classifies a slide-steep support normal', () => {
    const steep = result({ x: 0, y: 0 }, { supportNormal: { x: -0.5, y: COS_MIN } });
    expect(slideDirection(steep, COS_MIN, TAN_MIN)).toBe(-1);
    const steepRight = result({ x: 0, y: 0 }, { supportNormal: { x: 0.5, y: 0.866 } });
    expect(slideDirection(steepRight, COS_MIN, TAN_MIN)).toBe(1);
    const flat = result({ x: 0, y: 0 }, { supportNormal: { x: 0, y: 1 } });
    expect(slideDirection(flat, COS_MIN, TAN_MIN)).toBe(0);
    // 44.9° is below cos(30°) ⇒ slide-steep even though it is climbable.
    const climbable = result({ x: 0, y: 0 }, { supportNormal: { x: -0.7071, y: 0.7083 } });
    expect(slideDirection(climbable, COS_MIN, TAN_MIN)).toBe(-1);
    // Not grounded ⇒ never a slide.
    expect(slideDirection(result({ x: 0, y: 0 }, { grounded: false }), COS_MIN, TAN_MIN)).toBe(0);
  });

  it('classifies a bounded downward ground-contact correction as a descending support', () => {
    const descending = result({ x: 0.0333, y: 0 }, {
      applied: { x: 0.0333, y: -0.03 }, // 42° descending correction
      snapped: true,
      supportNormal: { x: 0, y: 1 },
    });
    expect(slideDirection(descending, COS_MIN, TAN_MIN)).toBe(1);
    // A flat-support snap correction (floating-point noise only) is NOT a
    // descending surface — the ratio guard keeps a resting character still.
    const noise = result({ x: 0.0333, y: 0 }, {
      applied: { x: 0.0333, y: -1e-7 },
      snapped: true,
      supportNormal: { x: 0, y: 1 },
    });
    expect(slideDirection(noise, COS_MIN, TAN_MIN)).toBe(0);
    // A shallow (below min-slope) descending correction is not a slide either.
    const shallow = result({ x: 0.0333, y: 0 }, {
      applied: { x: 0.0333, y: -0.005 },
      snapped: true,
      supportNormal: { x: 0, y: 1 },
    });
    expect(slideDirection(shallow, COS_MIN, TAN_MIN)).toBe(0);
    // An upward correction (landing on a higher surface) is not a slide.
    const ascending = result({ x: 0.0333, y: 0 }, {
      applied: { x: 0.0333, y: 0.0192 },
      snapped: true,
      supportNormal: { x: 0, y: 1 },
    });
    expect(slideDirection(ascending, COS_MIN, TAN_MIN)).toBe(0);
  });

  it('drives an idle character downhill but never overrides commanded movement', () => {
    const idle = createControllerState(7.7, 1.29);
    const commanded = createControllerState(7.7, 1.29);
    const h1 = harness();
    const h2 = harness();
    h1.seed(idle, { supportNormal: { x: -0.5, y: 0.866 } });
    h2.seed(commanded, { supportNormal: { x: -0.5, y: 0.866 } });
    controllerStep(idle, 'char-0001', frame(0), SETTINGS, DT, COS_MAX, COS_MIN, TAN_MIN, h1.client);
    // downhill = −x for a face whose normal has x < 0.
    expect(idle.vx).toBeCloseTo(-60 * DT, 12); // decel: 0 → −run_speed
    expect(idle.slideSteps).toBe(1);
    controllerStep(commanded, 'char-0001', frame(1), SETTINGS, DT, COS_MAX, COS_MIN, TAN_MIN, h2.client);
    expect(commanded.slideSteps).toBe(0);
    expect(commanded.vx).toBeCloseTo(40 * DT, 12); // the commanded +x target
  });

  it('does not slide on flat ground', () => {
    const state = createControllerState(0, 0.91);
    const h = harness();
    h.seed(state, { supportNormal: { x: 0, y: 1 } });
    controllerStep(state, 'char-0001', frame(0), SETTINGS, DT, COS_MAX, COS_MIN, TAN_MIN, h.client);
    expect(state.vx).toBe(0);
    expect(state.slideSteps).toBe(0);
  });
});
