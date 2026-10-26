/**
 * v4: point, spot and hemisphere lights and the light mode; the local-light
 * modes (per pixel or none) and the upgrade of stored per-vertex settings.
 */
import { describe, expect, it } from 'vitest';

import { MAX_LOCAL_LIGHTS, upgradeVertexLocalLights, validateLocalLightMode } from './local-lights';
import { AREA_LIGHT_SIZE_MAX } from './area-lights';
import { PROJECT_SCHEMA_VERSION } from './project-schema';
import { validateSceneV4 } from './scene-v3';

const T = { position: [0, 2, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] };
const scene = (lights: Record<string, unknown>[]) => ({
  schemaVersion: 4,
  sceneId: 'scene-a',
  revision: 1,
  entities: lights.map((light, i) => ({ id: `light-${String(i + 1).padStart(4, '0')}`, components: { transform: T, light } })),
});
const ok = (lights: Record<string, unknown>[]) => {
  const r = validateSceneV4(scene(lights));
  return r.ok ? r : (expect.fail(JSON.stringify(r.errors)) as never);
};

describe('local lights (v4)', () => {
  it('accepts point, spot and hemisphere lights and keeps their fields', () => {
    const r = ok([
      { type: 'point', color: '#FFAA00', intensity: 40, range: 8, decay: 2, castShadow: true, mode: 'mixed' },
      { type: 'spot', color: '#ffffff', intensity: 200, range: 12, angle: 25, penumbra: 0.3, direction: [0, -1, 0] },
      { type: 'hemisphere', color: '#bcd7ff', groundColor: '#5A4A38', intensity: 0.8 },
      { type: 'directional', color: '#ffffff', intensity: 1, direction: [0, -1, 0], mode: 'baked' },
    ]);
    const lights = r.normalized.entities.map((e) => (e.components as unknown as { light: Record<string, unknown> }).light);
    expect(lights[0]).toEqual({ type: 'point', color: '#ffaa00', intensity: 40, castShadow: true, range: 8, decay: 2, mode: 'mixed' });
    expect(lights[1]).toMatchObject({ type: 'spot', angle: 25, penumbra: 0.3, direction: [0, -1, 0] });
    expect(lights[2]).toEqual({ type: 'hemisphere', color: '#bcd7ff', intensity: 0.8, groundColor: '#5a4a38' });
    expect(lights[3]).toMatchObject({ type: 'directional', mode: 'baked' });
  });

  it('refuses wrong fields, ranges, a spot without direction and too many lights', () => {
    expect(validateSceneV4(scene([{ type: 'point', color: '#ffffff', intensity: 5, angle: 30 }])).ok).toBe(false);
    expect(validateSceneV4(scene([{ type: 'point', color: '#ffffff', intensity: 5000 }])).ok).toBe(false);
    expect(validateSceneV4(scene([{ type: 'spot', color: '#ffffff', intensity: 5 }])).ok).toBe(false);
    expect(validateSceneV4(scene([{ type: 'spot', color: '#ffffff', intensity: 5, angle: 95, direction: [0, -1, 0] }])).ok).toBe(false);
    expect(validateSceneV4(scene([{ type: 'point', color: '#ffffff', intensity: 5, mode: 'sometimes' }])).ok).toBe(false);
    expect(validateSceneV4(scene(Array.from({ length: 17 }, () => ({ type: 'point', color: '#ffffff', intensity: 5 })))).ok).toBe(false);
    expect(validateSceneV4(scene([{ type: 'hemisphere', color: '#ffffff', intensity: 1 }, { type: 'hemisphere', color: '#ffffff', intensity: 1 }])).ok).toBe(false);
    // A light has no importance any more (the load drops a stored one: upgradeVertexLocalLights).
    expect(validateSceneV4(scene([{ type: 'point', color: '#ffffff', intensity: 5, importance: 'pixel' }])).ok).toBe(false);
  });
});

describe('area lights', () => {
  it('fills an area light\'s shape, size, sides and shadows and keeps what is set', () => {
    const r = ok([
      { type: 'area', color: '#FFF4E0', intensity: 40 },
      { type: 'area', color: '#ffffff', intensity: 20, shape: 'line', width: 3, twoSided: true, castShadow: false, range: 6, mode: 'baked', lightMask: 2, shadowCasterMask: 1 },
    ]);
    const lights = r.normalized.entities.map((e) => (e.components as unknown as { light: Record<string, unknown> }).light);
    expect(lights[0]).toEqual({ type: 'area', color: '#fff4e0', intensity: 40, shape: 'rect', width: 1, height: 0.5, twoSided: false, castShadow: true });
    expect(lights[1]).toEqual({ type: 'area', color: '#ffffff', intensity: 20, shape: 'line', width: 3, twoSided: true, castShadow: false, range: 6, mode: 'baked', lightMask: 2, shadowCasterMask: 1 });
    // The canonical form validates again unchanged.
    const again = validateSceneV4(r.normalized);
    expect(again.ok && again.normalized).toEqual(r.normalized);
    // A new kind of light, not a new format: projects stay on the same schema.
    expect(PROJECT_SCHEMA_VERSION).toBe(8);
  });

  it('refuses a bad shape, a size out of (0, max], a line with a height and fields of other lights', () => {
    const area = (f: Record<string, unknown>) => validateSceneV4(scene([{ type: 'area', color: '#ffffff', intensity: 10, ...f }]));
    const paths = (f: Record<string, unknown>) => { const r = area(f); return r.ok ? [] : r.errors.map((e) => e.path); };
    expect(paths({ shape: 'disc' })).toEqual(['/entities/0/components/light/shape']);
    expect(paths({ width: 0 })).toEqual(['/entities/0/components/light/width']);
    expect(paths({ width: AREA_LIGHT_SIZE_MAX + 1 })).toEqual(['/entities/0/components/light/width']);
    expect(paths({ height: -1 })).toEqual(['/entities/0/components/light/height']);
    expect(paths({ shape: 'line', height: 1 })).toEqual(['/entities/0/components/light/height']);
    expect(paths({ twoSided: 'yes' })).toEqual(['/entities/0/components/light/twoSided']);
    expect(area({ width: AREA_LIGHT_SIZE_MAX }).ok).toBe(true);
    expect(area({ direction: [0, -1, 0] }).ok).toBe(false);
    expect(area({ decay: 2 }).ok).toBe(false);
    expect(area({ intensity: 5000 }).ok).toBe(false);
  });

  it('counts only realtime and mixed point and spot lights against the per-scene budget', () => {
    const point = (mode?: string) => ({ type: 'point', color: '#ffffff', intensity: 5, ...(mode !== undefined ? { mode } : {}) });
    const area = { type: 'area', color: '#ffffff', intensity: 5 };
    const drawn = [...Array.from({ length: MAX_LOCAL_LIGHTS - 1 }, () => point()), point('mixed')];
    const statics = [...Array.from({ length: 10 }, () => point('baked')), ...Array.from({ length: 10 }, () => area)];
    expect(validateSceneV4(scene([...drawn, ...statics])).ok).toBe(true);
    const over = validateSceneV4(scene([...drawn, ...statics, point()]));
    expect(over.ok ? [] : over.errors.map((e) => e.code)).toEqual(['limits_exceeded']);
  });
});

describe('local-light modes and the per-vertex upgrade', () => {
  it('takes pixel and none; vertex is no mode', () => {
    const errors: unknown[] = [];
    validateLocalLightMode('pixel', '/a', errors as never);
    validateLocalLightMode('none', '/b', errors as never);
    expect(errors).toEqual([]);
    validateLocalLightMode('vertex', '/c', errors as never);
    expect(errors).toHaveLength(1);
  });

  it('turns every stored per-vertex setting to per pixel, drops importances, counts only what was per vertex, and leaves the rest as given', () => {
    const graph = (data: Record<string, unknown>, type = 'output.pbr') => ({ nodes: [{ id: 'n1', type, position: [0, 0], data }], edges: [] });
    const content = {
      prefabs: [{ prefabId: 'p', entities: [{ id: 'e', components: { box: { localLights: 'vertex' } } }] }],
      materials: [
        { materialId: 'm1', params: { localLights: 'vertex', color: '#ffffff' } },
        { materialId: 'm2', params: {}, graph: graph({ localLights: 'vertex' }) },
        { materialId: 'm3', params: { localLights: 'none' } },
      ],
      graphs: [{ graphId: 'g', kind: 'material', name: 'G', graph: graph({ localLights: 'vertex' }) }],
      effects: [{ effectId: 'fx', systems: [{ graph: graph({ importance: 'vertex', lightMask: 2 }, 'output.light') }, { graph: graph({ importance: 'pixel' }, 'output.light') }] }],
    };
    const sceneDoc = scene([{ type: 'point', color: '#ffffff', intensity: 5, importance: 'vertex' }, { type: 'spot', color: '#ffffff', intensity: 5, direction: [0, -1, 0], importance: 'auto' }]);
    (sceneDoc.entities[0]!.components as Record<string, unknown>)['model'] = { asset: { assetId: 'a' }, localLights: 'vertex' };
    const u = upgradeVertexLocalLights(content, [sceneDoc]);
    expect(u.changed).toBe(true);
    // prefab box, 2 materials, 1 graph document, 1 effect light, 1 scene light, 1 scene model.
    expect(u.upgraded).toBe(7);
    const c = u.content as typeof content;
    expect(c.prefabs[0]!.entities[0]!.components.box.localLights).toBe('pixel');
    expect(c.materials.map((m) => m.params.localLights ?? m.graph?.nodes[0]!.data.localLights)).toEqual(['pixel', 'pixel', 'none']);
    expect(c.materials[0]!.params.color).toBe('#ffffff');
    expect(c.materials[2]).toBe(content.materials[2]);
    expect(c.graphs[0]!.graph.nodes[0]!.data.localLights).toBe('pixel');
    expect(c.effects[0]!.systems.map((sys) => sys.graph.nodes[0]!.data)).toEqual([{ lightMask: 2 }, {}]);
    const sc = u.scenes[0] as typeof sceneDoc;
    expect(sc.entities.map((e) => (e.components as Record<string, Record<string, unknown>>)['light'])).not.toContainEqual(expect.objectContaining({ importance: expect.anything() }));
    expect((sc.entities[0]!.components as Record<string, Record<string, unknown>>)['model']!['localLights']).toBe('pixel');
    // The upgraded scene validates; the given documents are not changed.
    expect(validateSceneV4(sc).ok).toBe(true);
    expect(content.materials[0]!.params.localLights).toBe('vertex');
    // Nothing to change: the same documents back.
    const plain = { materials: [{ materialId: 'm', params: { localLights: 'pixel' } }] };
    const none = upgradeVertexLocalLights(plain, [scene([{ type: 'point', color: '#ffffff', intensity: 5 }])]);
    expect(none.changed).toBe(false);
    expect(none.content).toBe(plain);
  });
});
