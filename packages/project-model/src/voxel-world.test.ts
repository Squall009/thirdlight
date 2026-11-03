/**
 * The `voxelWorld` component and a model's `affectsLighting` flag: refusals,
 * the canonical form through the whole scene validator (every field kept,
 * nothing added), and the defaults taken from the voxel format.
 */
import { describe, expect, it } from 'vitest';
import { DEFAULT_COLLISION_RING, DEFAULT_LEVEL_RINGS, DEFAULT_SAVED_FIELDS, DEFAULT_SECTION_EDGE, DEFAULT_STREAM_RING, PLANE_BIT, VOXEL_SIZE_M } from '@thirdlight/voxel';

import type { ModelErrorV2 } from './errors';
import { validatePrefabDefinitions } from './content';
import { serializeCanonical } from './normalize';
import { validateSceneV4 } from './scene-v3';
import { canonicalVoxelWorld, resolveVoxelWorld, validateVoxelWorldComponent, VOXEL_WORLD_DEFAULTS, type VoxelWorldComponent } from './voxel-world';

const T = { position: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] };
const CAMERA = { id: 'cam-main', components: { transform: T, virtualCamera: { rig: 'fixed' } } };
const scene = (entities: unknown[]) => ({ schemaVersion: 4, sceneId: 'scene-main', revision: 1, entities: [CAMERA, ...entities] });

const FULL: VoxelWorldComponent = {
  world: 'town_1',
  ring: { loadRadius: 120, unloadRadius: 150, loadHeight: 60, unloadHeight: 80 },
  collision: { radius: 40, height: 20 },
  levels: { level0: 50, level1: 100 },
  sectionEdge: 32,
  savedFields: ['material', 'shape', 'wetness'],
};

function errorsOf(v: unknown): string[] {
  const errors: ModelErrorV2[] = [];
  validateVoxelWorldComponent(v, '', errors);
  return errors.map((e) => `${e.code} ${e.path}`);
}

function canonicalScene(entities: unknown[]): Record<string, unknown> {
  const r = validateSceneV4(scene(entities));
  if (!r.ok) throw new Error(JSON.stringify(r.errors));
  const s = serializeCanonical(r.normalized);
  if (!s.ok) throw new Error('not serializable');
  return JSON.parse(new TextDecoder().decode(s.bytes)) as Record<string, unknown>;
}
const componentsOf = (doc: Record<string, unknown>, id: string): Record<string, unknown> =>
  ((doc['entities'] as { id: string; components: Record<string, unknown> }[]).find((e) => e.id === id)!).components;

describe('the voxelWorld component', () => {
  it('needs a world name; every other field is optional and range-checked', () => {
    expect(errorsOf({ world: 'w' })).toEqual([]);
    expect(errorsOf(FULL)).toEqual([]);
    expect(errorsOf({})).toEqual(['field_missing /world']);
    expect(errorsOf('town')).toEqual(['field_type ']);
    expect(errorsOf({ world: 'Town' })).toEqual(['field_value /world']);
    expect(errorsOf({ world: 'a'.repeat(65) })).toEqual(['field_value /world']);
    expect(errorsOf({ world: 'w', ring: { loadRadius: 0, unloadRadius: Infinity, near: 3 }, collision: { radius: -1, height: '24' }, levels: { level0: 0, level1: '9', level2: 300 }, sectionEdge: 12, savedFields: ['material', 'colour', 'material'], climate: 1 })).toEqual([
      'field_unexpected /climate',
      'field_unexpected /ring/near',
      'field_value /ring/loadRadius',
      'field_value /ring/unloadRadius',
      'field_value /collision/radius',
      'field_value /collision/height',
      'field_unexpected /levels/level2',
      'field_value /levels/level0',
      'field_value /levels/level1',
      'field_value /sectionEdge',
      'field_value /savedFields/1',
      'field_value /savedFields/2',
    ]);
    expect(errorsOf({ world: 'w', ring: 5, collision: [], levels: 64, savedFields: 'material' })).toEqual(['field_type /ring', 'field_type /collision', 'field_type /levels', 'field_type /savedFields']);
  });

  it('keeps every field through the scene validator and the canonical bytes, in order, adding nothing', () => {
    const shuffled = { savedFields: ['wetness', 'material', 'shape'], sectionEdge: 32, levels: { level1: 100, level0: 50 }, collision: { height: 20, radius: 40 }, ring: { unloadHeight: 80, loadHeight: 60, unloadRadius: 150, loadRadius: 120 }, world: 'town_1' };
    const doc = canonicalScene([{ id: 'world-000001', components: { transform: T, voxelWorld: shuffled } }]);
    const vw = componentsOf(doc, 'world-000001')['voxelWorld'];
    expect(JSON.stringify(vw)).toBe(JSON.stringify(FULL));
    expect(JSON.stringify(canonicalVoxelWorld(shuffled as VoxelWorldComponent))).toBe(JSON.stringify(FULL));
    // A second pass is the same bytes.
    expect(JSON.stringify(canonicalScene((doc['entities'] as { id: string }[]).filter((e) => e.id !== CAMERA.id)))).toBe(JSON.stringify(doc));
    // A bare world stays bare: the defaults are the engine's, not written into the project.
    const bare = canonicalScene([{ id: 'world-000001', components: { transform: T, voxelWorld: { world: 'w', ring: {}, levels: {}, savedFields: [] } } }]);
    expect(componentsOf(bare, 'world-000001')['voxelWorld']).toEqual({ world: 'w', ring: {}, levels: {}, savedFields: [] });
    // One level distance set keeps only that one.
    const one = canonicalScene([{ id: 'world-000001', components: { transform: T, voxelWorld: { world: 'w', levels: { level1: 90 } } } }]);
    expect(componentsOf(one, 'world-000001')['voxelWorld']).toEqual({ world: 'w', levels: { level1: 90 } });
  });

  it('is refused in a scene with a bad value, and in a prefab', () => {
    const r = validateSceneV4(scene([{ id: 'world-000001', components: { transform: T, voxelWorld: { world: 'w', sectionEdge: 64 } } }]));
    expect(r.ok ? [] : r.errors.map((e) => `${e.code} ${e.path}`)).toEqual(['field_value /entities/1/components/voxelWorld/sectionEdge']);
    const errors: ModelErrorV2[] = [];
    validatePrefabDefinitions([{ prefabId: 'pre-a', displayName: 'P', createdRevision: 1, entityCount: 1, depth: 1, version: 4, entities: [{ localId: 'root', components: { transform: T, voxelWorld: { world: 'w' } } }] }], '/prefabs', errors);
    expect(errors.map((e) => e.code)).toContain('prefab_component_forbidden');
  });

  it("resolves to the voxel format's defaults, in metres", () => {
    const r = resolveVoxelWorld({ world: 'w' });
    expect(r.ring).toEqual({
      loadRadius: DEFAULT_STREAM_RING.loadRadius * VOXEL_SIZE_M,
      unloadRadius: DEFAULT_STREAM_RING.unloadRadius * VOXEL_SIZE_M,
      loadHeight: DEFAULT_STREAM_RING.loadHeight * VOXEL_SIZE_M,
      unloadHeight: DEFAULT_STREAM_RING.unloadHeight * VOXEL_SIZE_M,
    });
    expect(r.collision).toEqual({ radius: DEFAULT_COLLISION_RING.radius * VOXEL_SIZE_M, height: DEFAULT_COLLISION_RING.height * VOXEL_SIZE_M });
    // The plan's numbers: collision 48 m across, 24 m up and down; 16³ sections; wetness not saved.
    expect(r.collision).toEqual({ radius: 48, height: 24 });
    // The plan's level distances: full detail to 64 m, level 1 to 128 m (level 2 past it).
    expect(r.levels).toEqual({ level0: DEFAULT_LEVEL_RINGS.radii[0]! * VOXEL_SIZE_M, level1: DEFAULT_LEVEL_RINGS.radii[1]! * VOXEL_SIZE_M });
    expect(r.levels).toEqual({ level0: 64, level1: 128 });
    expect(r.sectionEdge).toBe(DEFAULT_SECTION_EDGE);
    expect(r.sectionEdge).toBe(16);
    expect(r.savedFields).toBe(DEFAULT_SAVED_FIELDS);
    expect(r.savedFields & PLANE_BIT.wetness).toBe(0);
    expect(VOXEL_WORLD_DEFAULTS.savedFields).toEqual(['material', 'role', 'shape']);
    // Its own settings win; an unload left out keeps the default gap past its load, one inside it is the load.
    const own = resolveVoxelWorld({ world: 'w', ring: { loadRadius: 300, loadHeight: 50, unloadHeight: 10 }, collision: { height: 8 }, sectionEdge: 8, savedFields: ['wetness'] });
    const gap = (DEFAULT_STREAM_RING.unloadRadius - DEFAULT_STREAM_RING.loadRadius) * VOXEL_SIZE_M;
    expect(own.ring).toEqual({ loadRadius: 300, unloadRadius: 300 + gap, loadHeight: 50, unloadHeight: 50 });
    expect(own.collision).toEqual({ radius: 48, height: 8 });
    // A level-1 distance inside level 0 is taken as it; one left out is the default.
    expect(resolveVoxelWorld({ world: 'w', levels: { level0: 70, level1: 20 } }).levels).toEqual({ level0: 70, level1: 70 });
    expect(resolveVoxelWorld({ world: 'w', levels: { level0: 30 } }).levels).toEqual({ level0: 30, level1: 128 });
    expect(own.sectionEdge).toBe(8);
    expect(own.savedFields).toBe(PLANE_BIT.wetness);
    expect(resolveVoxelWorld({ world: 'w', savedFields: [] }).savedFields).toBe(0);
  });
});

describe("a model's affectsLighting flag", () => {
  const model = (extra: Record<string, unknown>) => [{ id: 'prop-000001', components: { transform: T, model: { asset: { assetId: 'model-a' }, ...extra } } }];

  it('is kept as set and absent when unset', () => {
    expect(componentsOf(canonicalScene(model({ affectsLighting: true })), 'prop-000001')['model']).toEqual({ asset: { assetId: 'model-a' }, affectsLighting: true });
    expect(componentsOf(canonicalScene(model({ affectsLighting: false })), 'prop-000001')['model']).toEqual({ asset: { assetId: 'model-a' }, affectsLighting: false });
    expect(componentsOf(canonicalScene(model({})), 'prop-000001')['model']).toEqual({ asset: { assetId: 'model-a' } });
  });

  it('is refused unless a boolean', () => {
    const r = validateSceneV4(scene(model({ affectsLighting: 1 })));
    expect(r.ok ? [] : r.errors.map((e) => `${e.code} ${e.path}`)).toEqual(['field_type /entities/1/components/model/affectsLighting']);
  });
});
