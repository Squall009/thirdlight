/**
 * The declared-dependency module resolver (D17): modules come from the
 * referenced content (components and content blocks), what behaviors require
 * and explicit declarations (phase 24.3); anything this engine does not
 * provide is unresolved.
 */
import { describe, expect, it } from 'vitest';

import { COMPONENT_MODULES, CONTENT_BLOCK_MODULES, ENGINE_MODULES, ENGINE_MODULE_IDS, resolveRequiredModules } from './modules';
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

  it('a controller and a model pull the controller and the glTF loader (phase 24.7: no game block, no session or camera module)', () => {
    const r = resolveRequiredModules({ scene: { entities: [entity({ controller: {} }), entity({ model: {} })] }, game: null });
    expect(r).toEqual({
      ok: true,
      moduleIds: [
        'thirdlight.input:keyboard-gamepad',
        'thirdlight.physics-rapier:2d',
        'thirdlight.platformer:controller',
        'thirdlight.three-adapter:gltf-loader',
      ],
    });
    expect(ENGINE_MODULE_IDS.some((id) => id.startsWith('thirdlight.platformer-game:'))).toBe(false);
  });

  it('phase 24.3: modules come only from references — no component, no module; the platformer packages are no behavior dependency', () => {
    // A camera, lights, boxes and a spawn (the starter's shape) reference nothing.
    expect(resolveRequiredModules({ scene: { entities: [entity({ camera: {} }), entity({ light: {} }), entity({ box: {} }), entity({ playerSpawn: {} })] }, game: null })).toEqual({ ok: true, moduleIds: [] });
    // Each reference is table data: component → module, content block → modules.
    expect(COMPONENT_MODULES['controller']).toEqual({ plane2d: 'thirdlight.platformer:controller', world3d: 'thirdlight.character3d:controller' });
    expect(CONTENT_BLOCK_MODULES).toEqual({});
    // A script may not pull the platformer in by package (it is not pinned).
    const pkg = resolveRequiredModules({ scene: { entities: [] }, game: null, behaviors: [{ behaviorId: 'b1', requiredModules: ['@thirdlight/platformer'] }] });
    expect(pkg).toMatchObject({ ok: false, unresolved: [{ id: '@thirdlight/platformer', requiredBy: 'behavior:b1' }] });
    // Module specs outside the runtime name their export; the table lists modules after those they need.
    const order = ENGINE_MODULES.map((m) => m.id);
    for (const m of ENGINE_MODULES) for (const dep of m.requires) expect(order.indexOf(dep)).toBeLessThan(order.indexOf(m.id));
    expect(ENGINE_MODULES.filter((m) => m.spec !== undefined).map((m) => m.spec)).toEqual(['platformerSpec']);
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

  it('phase 23.0/23.2: a 3D project\'s controller needs the 3D character controller and backend', () => {
    const scene = { entities: [entity({ controller: {} })] };
    // Phase 23.2: the 3D character controller module (with the 3D backend and input it needs).
    expect(resolveRequiredModules({ scene, game: null, physicsDimension: 3 })).toEqual({ ok: true, moduleIds: ['thirdlight.character3d:controller', 'thirdlight.input:keyboard-gamepad', 'thirdlight.physics-rapier:3d'] });
    expect(resolveRequiredModules({ scene, game: null, physicsDimension: 2 })).toEqual(resolveRequiredModules({ scene, game: null }));
    expect(resolveRequiredModules({ scene, game: null, behaviors: [{ behaviorId: 'b', requiredModules: ['@thirdlight/physics-rapier'] }], physicsDimension: 3 })).toEqual({ ok: true, moduleIds: ['thirdlight.character3d:controller', 'thirdlight.input:keyboard-gamepad', 'thirdlight.physics-rapier:3d'] });
    // Phase 23.3: a collider alone needs it in 3D (rays and picks without a player); not on the 2D plane.
    const colliders = { entities: [entity({ collider: { shape: { type: 'box', hx: 1, hy: 1, hz: 1 } } })] };
    expect(resolveRequiredModules({ scene: colliders, game: null, physicsDimension: 3 })).toEqual({ ok: true, moduleIds: ['thirdlight.physics-rapier:3d'] });
    expect(resolveRequiredModules({ scene: colliders, game: null })).toEqual({ ok: true, moduleIds: [] });
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
