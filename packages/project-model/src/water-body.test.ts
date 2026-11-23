/**
 * The `waterBody` component through the whole scene validator: every field
 * kept by the canonical form (the reach given its default), refusals named
 * by their pointer, the object kept at the scene's root, out of prefabs and
 * scripts, and the bodies read back with their seeds.
 */
import { describe, expect, it } from 'vitest';
import { PREFAB_EXCLUDED_COMPONENTS } from './content-prefabs';
import { DESCRIPTORS } from './descriptors';
import { validateSceneV4 } from './scene-v3';
import { sceneWaterBodies, WATER_BODY_REACH_DEFAULT_M, type WaterBodyComponent } from './water-body';

const T = { position: [4, 6, -2], rotation: [0, 0, 0, 1], scale: [1, 1, 1] };
const CAMERA = { id: 'cam-main', components: { transform: { position: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] }, virtualCamera: { rig: 'fixed' } } };
const WORLD = { id: 'world-000001', components: { transform: { position: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] }, voxelWorld: { world: 'town' } } };
const scene = (entities: unknown[]) => ({ schemaVersion: 4, sceneId: 'scene-main', revision: 1, entities: [CAMERA, WORLD, ...entities] });
const FULL: WaterBodyComponent = { world: 'town', level: 12.5, material: 40, reach: 120 };
const lake = (c: unknown, extra: Record<string, unknown> = {}) => ({ id: 'lake-000001', components: { transform: T, waterBody: c }, ...extra });

function errorsOf(entities: unknown[]): Array<{ code: string; path: string }> {
  const r = validateSceneV4(scene(entities));
  return r.ok ? [] : (r.errors as unknown as Array<{ code: string; path: string }>);
}

describe('waterBody', () => {
  it('keeps every field through the scene validator, in canonical order; the reach defaults to 256 m', () => {
    const r = validateSceneV4(scene([lake(Object.fromEntries(Object.entries(FULL).reverse()))]));
    if (!r.ok) throw new Error(JSON.stringify(r.errors));
    const kept = (r.normalized.entities[2]!.components as { waterBody?: unknown }).waterBody;
    expect(kept).toEqual(FULL);
    expect(Object.keys(kept as object)).toEqual(['world', 'level', 'material', 'reach']);
    const { reach: _r, ...noReach } = FULL;
    const d = validateSceneV4(scene([lake(noReach)]));
    if (!d.ok) throw new Error(JSON.stringify(d.errors));
    expect((d.normalized.entities[2]!.components as { waterBody: WaterBodyComponent }).waterBody.reach).toBe(WATER_BODY_REACH_DEFAULT_M);
  });

  it('refuses bad fields by their pointer, and a body under a parent', () => {
    const at = (c: unknown) => errorsOf([lake(c)]).map((e) => e.path);
    const p = '/entities/2/components/waterBody';
    expect(at({ ...FULL, world: 'Bad World' })).toContain(`${p}/world`);
    expect(at({ ...FULL, level: Number.NaN })).toContain(`${p}/level`);
    expect(at({ ...FULL, material: 0 })).toContain(`${p}/material`);
    expect(at({ ...FULL, reach: 0 })).toContain(`${p}/reach`);
    expect(at({ ...FULL, flow: 2 })).toContain(`${p}/flow`);
    const { material: _m, ...noMaterial } = FULL;
    expect(errorsOf([lake(noMaterial)])[0]!.code).toBe('field_missing');
    const parented = errorsOf([{ id: 'group-000001', components: { transform: T } }, lake(FULL, { parentId: 'group-000001' })]);
    expect(parented.map((e) => e.path)).toContain('/entities/3/parentId');
  });

  it('stays out of prefabs and scripts (authoring data), with a level handle in the Scene view', () => {
    expect(PREFAB_EXCLUDED_COMPONENTS).toContain('waterBody');
    const c = DESCRIPTORS.components.find((x) => x.name === 'waterBody')!;
    expect(c.value.type === 'object' && c.value.fields.some((f) => 'scriptReadable' in f)).toBe(false);
    expect(c.handles).toEqual([{ kind: 'height', label: 'Level', bind: { height: 'level' }, space: 'local', scene: true }]);
  });

  it('reads the bodies of the scenes with their seeds, a scene given twice once', () => {
    const sc = scene([lake(FULL), { id: 'pond-000001', components: { waterBody: { world: 'town', level: 3, material: 41 } } }]);
    const bodies = sceneWaterBodies([sc, sc]);
    expect(bodies.map((b) => [b.entityId, b.seed, b.body.reach])).toEqual([
      ['lake-000001', [4, 6, -2], 120],
      ['pond-000001', null, WATER_BODY_REACH_DEFAULT_M],
    ]);
  });
});
