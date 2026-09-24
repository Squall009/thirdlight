/**
 * Packet 32 — public-surface and module-boundary assertions for
 * `@thirdlight/platformer` (dependencies.md §3 `platformer` row and §4.1
 * `platformer → runtime (types)` edge).
 *
 * The package must expose exactly the three contracted names, its spec must
 * declare the contract's phases/owner/exclusion metadata, and the module must
 * stage only through the injected `PhysicsStepClient` (never a concrete
 * library, never a transform write of its own). The negative boundary probe
 * for the forbidden edges is run separately against
 * `tools/check-boundaries.mjs` (packet-32 evidence manifest).
 */
import { describe, expect, it } from 'vitest';
import type { CharacterMoveResult, PhysicsStepClient, RuntimeSnapshot, StepContext } from '@thirdlight/runtime';

import * as platformer from './index';
import { CONTROLLER_CONSTANTS, PLATFORMER_MODULE_ID } from './index';
import { platformerSpec } from './index';

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

describe('public exports (dependencies.md §3 platformer row)', () => {
  it('exports exactly the contracted names', () => {
    expect(Object.keys(platformer).sort()).toEqual([
      'CONTROLLER_CONSTANTS',
      'PLATFORMER_MODULE_ID',
      'platformerSpec',
    ]);
    expect(PLATFORMER_MODULE_ID).toBe('thirdlight.platformer:controller');
    expect(CONTROLLER_CONSTANTS.jumpBufferSteps).toBe(8);
    expect(platformerSpec.id).toBe(PLATFORMER_MODULE_ID);
  });

  it('declares the platformer.md §2 module metadata', () => {
    expect(platformerSpec.phases).toEqual(['controller', 'transform']);
    expect(platformerSpec.excludes).toEqual(['thirdlight.demo:box-motion']);
    expect(platformerSpec.requiresPhysicsPort).toBe(true);
    expect(typeof platformerSpec.create).toBe('function');
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
      action: { stepIndex: 12, moveX, jump: 'none' },
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
    const module = platformerSpec.create(
      snapshotWith([
        { id: 'cam-0001', components: { ...TRANSFORM, camera: { type: 'perspective', fovY: 60, near: 0.1, far: 100 } } },
        { id: 'char-0001', components: { ...TRANSFORM, controller: {} } },
      ]),
      { fixedStepHz: 120, settings, sceneVersion: 4 },
    ) as { transformOwners: readonly string[]; step: (p: string, c: StepContext) => void };
    expect(module.transformOwners).toEqual(['char-0001']);
  });

  it('refuses an ambiguous controller target (defensive; the runtime validates first)', () => {
    expect(() =>
      platformerSpec.create(
        snapshotWith([
          { id: 'cam-0001', components: { ...TRANSFORM, camera: { type: 'perspective', fovY: 60, near: 0.1, far: 100 } } },
          { id: 'char-0001', components: { ...TRANSFORM } },
        ]),
        { fixedStepHz: 120, settings, sceneVersion: 4 },
      ),
    ).toThrow(/exactly one components\.controller/);
  });

  it('stages one move in the controller phase and records the result in the transform phase', () => {
    const staged: { id: string; delta: { x: number; y: number } }[] = [];
    let last: CharacterMoveResult | undefined;
    const physics: PhysicsStepClient = {
      stageCharacterMove: (id, delta) => staged.push({ id, delta: { x: delta.x, y: delta.y } }),
      characterResult: () => last,
    };
    const module = platformerSpec.create(
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

  it('uses a committed control intent as the §14.5 effective input', () => {
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
      const module = platformerSpec.create(
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
