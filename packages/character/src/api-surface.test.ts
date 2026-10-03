/**
 * Public-surface and module-boundary assertions for
 * `@thirdlight/character` (the `character` row of dependencies.md and its
 * `character → runtime (types)` edge).
 *
 * The package must expose exactly the three contracted names, its spec must
 * declare the contract's phases/owner/exclusion metadata, and the module must
 * stage only through the injected `PhysicsStepClient` (never a concrete
 * library, never a transform write of its own). The negative boundary probe
 * for the forbidden edges is run separately against
 * `tools/check-boundaries.mjs`.
 */
import { describe, expect, it } from 'vitest';
import type { CharacterMoveResult, PhysicsStepClient, RuntimeSnapshot, StepContext } from '@thirdlight/runtime';

import * as character from './index';
import { CONTROLLER_CONSTANTS, CHARACTER_MODULE_ID } from './index';
import { characterControllerSpec } from './index';

function snapshotWith(entities: unknown[]): RuntimeSnapshot {
  return {
    snapshotId: 'demo-0001@r4',
    projectId: 'demo-0001',
    revision: 4,
    scene: { schemaVersion: 4, sceneId: 'scene-main', revision: 4, entities },
  } as unknown as RuntimeSnapshot;
}

const TRANSFORM = {
  transform: { position: [1, 0.91, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] },
};

describe('public exports', () => {
  it('exports exactly the contracted names', () => {
    expect(Object.keys(character).sort()).toEqual([
      'CHARACTER_MODULE_ID',
      'CONTROLLER_CONSTANTS',
      'characterControllerSpec',
    ]);
    expect(CHARACTER_MODULE_ID).toBe('thirdlight.character:controller');
    expect(CONTROLLER_CONSTANTS.jumpBufferSteps).toBe(8);
    expect(characterControllerSpec.id).toBe(CHARACTER_MODULE_ID);
  });

  it('declares the controller contract module metadata', () => {
    expect(characterControllerSpec.phases).toEqual(['controller', 'transform']);
    expect(characterControllerSpec.excludes).toEqual(['thirdlight.demo:box-motion']);
    expect(characterControllerSpec.requiresPhysicsPort).toBe(true);
    expect(typeof characterControllerSpec.create).toBe('function');
  });
});

describe('module behaviour through the contracted StepContext only', () => {
  const settings = Object.freeze({
    gravity_y: -19.62,
    run_speed: 4,
    jump_velocity: 7,
    max_fall_speed: -30,
    max_slope_climb_deg: 45,
    min_slope_slide_deg: 30,
  });

  function makeContext(
    physics: PhysicsStepClient,
    phase: 'controller' | 'transform',
    moveX: number,
    intents: { move?: number | null; jump?: string | null } = {},
  ): StepContext {
    return {
      stepIndex: 12,
      phase,
      action: { stepIndex: 12, actions: { move: { v: moveX, p: 'none' } } },
      settings,
      physics,
      state: {},
      intents: {
        stepIndex: 12,
        move: intents.move ?? null,
        jump: intents.jump ?? null,
        moveWriter: intents.move != null ? 'thirdlight.test:behavior' : null,
        jumpWriter: intents.jump != null ? 'thirdlight.test:behavior' : null,
        transformWrites: [],
      },
    } as unknown as StepContext;
  }

  it('owns exactly the single controller entity declared at create', () => {
    const module = characterControllerSpec.create(
      snapshotWith([
        { id: 'cam-0001', components: { ...TRANSFORM, camera: { type: 'perspective', fovY: 60, near: 0.1, far: 100 } } },
        { id: 'char-0001', components: { ...TRANSFORM, controller: {} } },
      ]),
      { fixedStepHz: 120, settings, sceneVersion: 4 },
    ) as { transformOwners: readonly string[]; step: (p: string, c: StepContext) => void };
    expect(module.transformOwners).toEqual(['char-0001']);
  });

  it('refuses a snapshot without a controller target (defensive; the runtime validates first)', () => {
    expect(() =>
      characterControllerSpec.create(
        snapshotWith([
          { id: 'cam-0001', components: { ...TRANSFORM, camera: { type: 'perspective', fovY: 60, near: 0.1, far: 100 } } },
          { id: 'char-0001', components: { ...TRANSFORM } },
        ]),
        { fixedStepHz: 120, settings, sceneVersion: 4 },
      ),
    ).toThrow(/requires a components\.controller entity \(found 0\)/);
  });

  it('drives every player controller with its own actions and intents, and resets the one placed', () => {
    const staged: { id: string; x: number }[] = [];
    const physics: PhysicsStepClient = { stageCharacterMove: (id, delta) => staged.push({ id, x: delta.x }), characterResult: () => undefined };
    const module = characterControllerSpec.create(
      snapshotWith([
        { id: 'char-0001', components: { ...TRANSFORM, controller: {} } },
        { id: 'char-0002', components: { ...TRANSFORM, controller: { moveAction: 'move_p2', jumpAction: 'jump_p2' } } },
      ]),
      { fixedStepHz: 120, settings, sceneVersion: 4 },
    ) as { transformOwners: readonly string[]; step: (p: 'controller' | 'transform', c: StepContext) => void; reset: (c: unknown) => void };
    expect(module.transformOwners).toEqual(['char-0001', 'char-0002']);
    const curr = new Map([['char-0001', TRANSFORM.transform], ['char-0002', TRANSFORM.transform]]);
    const ctx = (actions: Record<string, { v: number; p: string }>, controllers?: Record<string, unknown>): StepContext =>
      ({ ...(makeContext(physics, 'controller', 0) as object), state: { curr }, action: { stepIndex: 12, actions }, intents: { ...(makeContext(physics, 'controller', 0) as { intents: object }).intents, ...(controllers !== undefined ? { controllers } : {}) } }) as unknown as StepContext;
    // Each reads its own move action: the first walks right, the second left.
    module.step('controller', ctx({ move: { v: 1, p: 'none' }, move_p2: { v: -1, p: 'none' } }));
    expect(staged.map((m) => m.id)).toEqual(['char-0001', 'char-0002']);
    expect(staged[0]!.x).toBeGreaterThan(0);
    expect(staged[1]!.x).toBeLessThan(0);
    // A script's intent naming the second controller drives only it.
    module.step('controller', ctx({ move: { v: 1, p: 'none' } }, { 'char-0002': { move: 1, jump: null } }));
    expect(staged[2]).toMatchObject({ id: 'char-0001' });
    expect(staged[2]!.x).toBeGreaterThan(0);
    expect(staged[3]!.x).toBeGreaterThan(staged[1]!.x);
    // A placement of the second resets only its velocity; the first keeps going.
    module.reset({ reason: 'transfer', stepIndex: 13, playerCenter: { x: 5, y: 1 }, characterId: 'char-0002', state: { curr } });
    module.step('controller', ctx({ move: { v: 1, p: 'none' } }));
    expect(staged[4]!.x).toBeGreaterThan(staged[2]!.x);
    expect(staged[5]!.x).toBe(0);
  });

  it('stages one move in the controller phase and records the result in the transform phase', () => {
    const staged: { id: string; delta: { x: number; y: number } }[] = [];
    let last: CharacterMoveResult | undefined;
    const physics: PhysicsStepClient = {
      stageCharacterMove: (id, delta) => staged.push({ id, delta: { x: delta.x, y: delta.y } }),
      characterResult: () => last,
    };
    const module = characterControllerSpec.create(
      snapshotWith([
        { id: 'cam-0001', components: { ...TRANSFORM, camera: { type: 'perspective', fovY: 60, near: 0.1, far: 100 } } },
        { id: 'char-0001', components: { ...TRANSFORM, controller: {} } },
      ]),
      { fixedStepHz: 120, settings, sceneVersion: 4 },
    ) as { step: (p: 'controller' | 'transform', c: StepContext) => void };

    last = {
      requested: { x: 0, y: 0 },
      applied: { x: 0, y: 0 },
      position: { x: 1, y: 0.9099987 },
      grounded: true,
      supportNormal: { x: 0, y: 1 },
      contacts: { ground: true, wall: false, head: false, steepSlope: false },
      snapped: false,
    };
    // First controller step: no previous result yet, so gravity applies
    // (exactly the settle pre-roll's first step).
    module.step('controller', makeContext(physics, 'controller', 1));
    expect(staged).toHaveLength(1);
    expect(staged[0]!.id).toBe('char-0001');
    expect(staged[0]!.delta.x).toBeCloseTo((40 / 120) / 120, 12);
    expect(staged[0]!.delta.y).toBeCloseTo((settings.gravity_y / 120) / 120, 12);
    expect(Object.keys(staged[0]!.delta).sort()).toEqual(['x', 'y']);
    // The transform phase only records the port result; the next controller
    // phase then sees it as `prevResult` (grounded ⇒ rest vertically).
    module.step('transform', makeContext(physics, 'transform', 1));
    module.step('controller', makeContext(physics, 'controller', 1));
    expect(staged[1]!.delta.y).toBe(0);
  });

  it('reads the move and jump actions its controller names (moveAction / jumpAction), not fixed channels', () => {
    const staged: { x: number }[] = [];
    const physics: PhysicsStepClient = { stageCharacterMove: (_id, delta) => staged.push({ x: delta.x }), characterResult: () => undefined };
    const module = characterControllerSpec.create(
      snapshotWith([
        { id: 'cam-0001', components: { ...TRANSFORM, camera: { type: 'perspective', fovY: 60, near: 0.1, far: 100 } } },
        { id: 'char-0001', components: { ...TRANSFORM, controller: { moveAction: 'walk', jumpAction: 'hop' } } },
      ]),
      { fixedStepHz: 120, settings, sceneVersion: 4 },
    ) as { step: (p: 'controller' | 'transform', c: StepContext) => void };
    const ctx = (actions: Record<string, { v: number; p: string }>): StepContext => ({ ...(makeContext(physics, 'controller', 0) as object), action: { stepIndex: 12, actions } }) as unknown as StepContext;
    // The default names do nothing for this character…
    module.step('controller', ctx({ move: { v: 1, p: 'none' } }));
    expect(staged[0]!.x).toBe(0);
    // …its own move action walks it.
    module.step('controller', ctx({ walk: { v: 1, p: 'none' } }));
    expect(staged[1]!.x).toBeGreaterThan(0);
  });

  it('uses a committed control intent as the effective input', () => {
    const createModule = (): {
      staged: { id: string; delta: { x: number; y: number } }[];
      step: (p: 'controller' | 'transform', c: StepContext) => void;
      ctx: (moveX: number, intents?: { move?: number | null; jump?: string | null }) => StepContext;
    } => {
      const staged: { id: string; delta: { x: number; y: number } }[] = [];
      const physics: PhysicsStepClient = {
        stageCharacterMove: (id, delta) => staged.push({ id, delta: { x: delta.x, y: delta.y } }),
        characterResult: () => undefined,
      };
      const module = characterControllerSpec.create(
        snapshotWith([
          { id: 'cam-0001', components: { ...TRANSFORM, camera: { type: 'perspective', fovY: 60, near: 0.1, far: 100 } } },
          { id: 'char-0001', components: { ...TRANSFORM, controller: {} } },
        ]),
        { fixedStepHz: 120, settings, sceneVersion: 4 },
      ) as { step: (p: 'controller' | 'transform', c: StepContext) => void };
      return {
        staged,
        step: (p, c) => module.step(p, c),
        ctx: (moveX, intents) => makeContext(physics, 'controller', moveX, intents),
      };
    };

    // Sampled `moveX` is +1, but the committed `control_move` intent is −1: the
    // intent replaces that channel for the controller phase only (`ctx.action`
    // itself stays the sampled frame).
    const withIntent = createModule();
    withIntent.step('controller', withIntent.ctx(1, { move: -1 }));
    expect(withIntent.staged).toHaveLength(1);
    expect(withIntent.staged[0]!.delta.x).toBeLessThan(0);

    // With no committed intent the sampled frame is used unchanged.
    const withoutIntent = createModule();
    withoutIntent.step('controller', withoutIntent.ctx(1));
    expect(withoutIntent.staged[0]!.delta.x).toBeGreaterThan(0);
  });
});
