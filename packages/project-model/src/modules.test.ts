/**
 * The declared-dependency module resolver: modules come from the
 * referenced content (components and content blocks), what behaviors require
 * and explicit declarations; anything this engine does not
 * provide is unresolved.
 */
import { describe, expect, it } from 'vitest';

import { COMPONENT_MODULES, CONTENT_BLOCK_MODULES, ENGINE_MODULES, ENGINE_MODULE_IDS, resolveRequiredModules } from './modules';
import { requiredModuleIds } from './manifest';

const entity = (components: Record<string, unknown>): Record<string, unknown> => ({ id: 'e', components });
const CONTROLLER_SET = ['thirdlight.character3d:controller', 'thirdlight.input:keyboard-gamepad', 'thirdlight.physics-rapier:3d'];

describe('resolveRequiredModules', () => {
  it('a plain scene needs no modules', () => {
    expect(resolveRequiredModules({ scene: { entities: [entity({ transform: {} }), entity({ box: {} })] } })).toEqual({ ok: true, moduleIds: [] });
  });

  it('a controller entity pulls the controller and, transitively, physics + input', () => {
    expect(resolveRequiredModules({ scene: { entities: [entity({ controller: {}, collider: {} })] } })).toEqual({ ok: true, moduleIds: CONTROLLER_SET });
  });

  it('a collider or a block layer alone needs the backend (rays and picks without a player)', () => {
    expect(resolveRequiredModules({ scene: { entities: [entity({ collider: { shape: { type: 'box', hx: 1, hy: 1, hz: 1 } } })] } })).toEqual({ ok: true, moduleIds: ['thirdlight.physics-rapier:3d'] });
    expect(resolveRequiredModules({ scene: { entities: [entity({ blockLayer: {} })] } })).toEqual({ ok: true, moduleIds: ['thirdlight.physics-rapier:3d'] });
  });

  it('a controller and a model pull the controller and the glTF loader (no game block, no session or camera module)', () => {
    const r = resolveRequiredModules({ scene: { entities: [entity({ controller: {} }), entity({ model: {} })] } });
    expect(r).toEqual({ ok: true, moduleIds: [...CONTROLLER_SET, 'thirdlight.three-adapter:gltf-loader'] });
  });

  it('modules come only from references — no component, no module; no module package is a behavior dependency', () => {
    // A camera, lights, boxes and a spawn (the starter's shape) reference nothing.
    expect(resolveRequiredModules({ scene: { entities: [entity({ camera: {} }), entity({ light: {} }), entity({ box: {} }), entity({ playerSpawn: {} })] } })).toEqual({ ok: true, moduleIds: [] });
    // Each reference is table data: component → module, content block → modules.
    expect(COMPONENT_MODULES['controller']).toBe('thirdlight.character3d:controller');
    expect(CONTENT_BLOCK_MODULES).toEqual({});
    // The removed character package is no dependency a script may name.
    const pkg = resolveRequiredModules({ scene: { entities: [] }, behaviors: [{ behaviorId: 'b1', requiredModules: ['@thirdlight/character'] }] });
    expect(pkg).toMatchObject({ ok: false, unresolved: [{ id: '@thirdlight/character', requiredBy: 'behavior:b1' }] });
    // The table lists modules after those they need; every module is a runtime built-in or a port.
    const order = ENGINE_MODULES.map((m) => m.id);
    for (const m of ENGINE_MODULES) for (const dep of m.requires) expect(order.indexOf(dep)).toBeLessThan(order.indexOf(m.id));
    expect(ENGINE_MODULES.filter((m) => m.spec !== undefined)).toEqual([]);
  });

  it("a behavior's required package maps to modules; an unknown package is unresolved", () => {
    const ok = resolveRequiredModules({ scene: { entities: [] }, behaviors: [{ behaviorId: 'b1', requiredModules: ['@thirdlight/runtime', '@thirdlight/physics-rapier'] }] });
    expect(ok).toEqual({ ok: true, moduleIds: ['thirdlight.physics-rapier:3d'] });
    const bad = resolveRequiredModules({ scene: { entities: [] }, behaviors: [{ behaviorId: 'b1', requiredModules: ['@thirdlight/runtime', '@acme/particles'] }] });
    expect(bad.ok).toBe(false);
    if (!bad.ok) {
      expect(bad.unresolved).toEqual([{ id: '@acme/particles', requiredBy: 'behavior:b1' }]);
      expect(bad.message).toContain('@acme/particles (required by behavior:b1)');
    }
  });

  it('declared module ids must exist on this engine (the removed 2D modules are unknown)', () => {
    const bad = resolveRequiredModules({ scene: { entities: [] }, declared: ['thirdlight.character3d:controller', 'thirdlight.physics-rapier:2d', 'thirdlight.character:controller'] });
    expect(bad).toMatchObject({ ok: false, unresolved: [{ id: 'thirdlight.physics-rapier:2d', requiredBy: 'declared' }, { id: 'thirdlight.character:controller', requiredBy: 'declared' }] });
  });

  it('every registry id resolves to itself', () => {
    const r = resolveRequiredModules({ scene: { entities: [] }, declared: ENGINE_MODULE_IDS });
    expect(r).toEqual({ ok: true, moduleIds: [...ENGINE_MODULE_IDS] });
  });

  it('the M2 heuristic entry is the resolver over the scene', () => {
    expect(requiredModuleIds({ entities: [entity({ controller: {} })] }, true, false)).toEqual([...CONTROLLER_SET.slice(0, 1), 'thirdlight.demo:box-motion', ...CONTROLLER_SET.slice(1)]);
  });
});
