/**
 * The declared-dependency module resolver (D17): modules come from the game
 * block, the referenced content and what behaviors require; anything this
 * engine does not provide is unresolved.
 */
import { describe, expect, it } from 'vitest';

import { ENGINE_MODULE_IDS, resolveRequiredModules } from './modules';
import { requiredModuleIds } from './manifest';

const entity = (components: Record<string, unknown>): Record<string, unknown> => ({ id: 'e', components });

describe('resolveRequiredModules', () => {
  it('a plain scene needs no modules', () => {
    expect(resolveRequiredModules({ scene: { entities: [entity({ transform: {} }), entity({ box: {} })] }, game: null })).toEqual({ ok: true, moduleIds: [] });
  });

  it('a controller entity pulls the controller and, transitively, physics + input', () => {
    const r = resolveRequiredModules({ scene: { entities: [entity({ controller: {}, collider: {} })] }, game: null });
    expect(r).toEqual({ ok: true, moduleIds: ['thirdlight.input:keyboard-gamepad', 'thirdlight.physics-rapier:2d', 'thirdlight.platformer:controller'] });
  });

  it('a collider alone is inert data (no physics module without a controller)', () => {
    expect(resolveRequiredModules({ scene: { entities: [entity({ collider: {} })] }, game: null })).toEqual({ ok: true, moduleIds: [] });
  });

  it('a game block pulls the game session + camera, which need the controller', () => {
    const r = resolveRequiredModules({ scene: { entities: [entity({ controller: {} }), entity({ model: {} })] }, game: { title: 'x' } });
    expect(r).toEqual({
      ok: true,
      moduleIds: [
        'thirdlight.input:keyboard-gamepad',
        'thirdlight.physics-rapier:2d',
        'thirdlight.platformer-game:camera',
        'thirdlight.platformer-game:session',
        'thirdlight.platformer:controller',
        'thirdlight.three-adapter:gltf-loader',
      ],
    });
  });

  it("a behavior's required package maps to modules; an unknown package is unresolved", () => {
    const ok = resolveRequiredModules({ scene: { entities: [] }, game: null, behaviors: [{ behaviorId: 'b1', requiredModules: ['@thirdlight/runtime', '@thirdlight/physics-rapier'] }] });
    expect(ok).toEqual({ ok: true, moduleIds: ['thirdlight.physics-rapier:2d'] });
    const bad = resolveRequiredModules({ scene: { entities: [] }, game: null, behaviors: [{ behaviorId: 'b1', requiredModules: ['@thirdlight/runtime', '@acme/particles'] }] });
    expect(bad.ok).toBe(false);
    if (!bad.ok) {
      expect(bad.unresolved).toEqual([{ id: '@acme/particles', requiredBy: 'behavior:b1' }]);
      expect(bad.message).toContain('@acme/particles (required by behavior:b1)');
    }
  });

  it('declared module ids must exist on this engine', () => {
    const bad = resolveRequiredModules({ scene: { entities: [] }, game: null, declared: ['thirdlight.platformer:controller', 'thirdlight.terrain:heightmap'] });
    expect(bad).toMatchObject({ ok: false, unresolved: [{ id: 'thirdlight.terrain:heightmap', requiredBy: 'declared' }] });
  });

  it('every registry id resolves to itself', () => {
    const r = resolveRequiredModules({ scene: { entities: [] }, game: null, declared: ENGINE_MODULE_IDS });
    expect(r).toEqual({ ok: true, moduleIds: [...ENGINE_MODULE_IDS] });
  });

  it('phase 23.0: a 3D project\'s controller needs the 3D backend; a game block stays on the 2D plane', () => {
    const scene = { entities: [entity({ controller: {} })] };
    expect(resolveRequiredModules({ scene, game: null, physicsDimension: 3 })).toEqual({ ok: true, moduleIds: ['thirdlight.physics-rapier:3d'] });
    expect(resolveRequiredModules({ scene, game: null, physicsDimension: 2 })).toEqual(resolveRequiredModules({ scene, game: null }));
    expect(resolveRequiredModules({ scene, game: null, behaviors: [{ behaviorId: 'b', requiredModules: ['@thirdlight/physics-rapier'] }], physicsDimension: 3 })).toEqual({ ok: true, moduleIds: ['thirdlight.physics-rapier:3d'] });
    const game = resolveRequiredModules({ scene, game: { configVersion: 2 }, physicsDimension: 3 });
    expect(game).toMatchObject({ ok: false, unresolved: [{ id: 'thirdlight.platformer-game:session', requiredBy: 'game' }] });
  });

  it('the M2 heuristic entry is the resolver over the scene', () => {
    expect(requiredModuleIds({ entities: [entity({ controller: {} })] }, true, false)).toEqual([
      'thirdlight.demo:box-motion',
      'thirdlight.input:keyboard-gamepad',
      'thirdlight.physics-rapier:2d',
      'thirdlight.platformer:controller',
    ]);
  });
});
