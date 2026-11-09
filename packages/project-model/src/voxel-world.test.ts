/**
 * The `voxelWorld` component and a model's `affectsLighting` flag: refusals,
 * the canonical form through the whole scene validator (every field kept,
 * nothing added), and the defaults taken from the voxel format.
 */
import { describe, expect, it } from 'vitest';
import { DEFAULT_COLLISION_RING, DEFAULT_LEVEL_RINGS, DEFAULT_RELIEF_RADIUS_CELLS, DEFAULT_SAVED_FIELDS, DEFAULT_SECTION_EDGE, DEFAULT_STREAM_RING, PLANE_BIT, VOXEL_SIZE_M } from '@thirdlight/voxel';

import type { ModelErrorV2 } from './errors';
import { validatePrefabDefinitions } from './content';
import { serializeCanonical } from './normalize';
import { validateSceneV4 } from './scene-v3';
import { DEFAULT_QUALITY_LEVELS, levelVoxels, type QualityLevelConfig } from './quality-levels';
import { validateQualityLevels } from './materials';
import { canonicalVoxelWorld, resolveVoxelWorld, validateVoxelWorldComponent, VOXEL_WORLD_DEFAULTS, type VoxelWorldComponent } from './voxel-world';
import { STREAMING_RADIUS_LIMITS } from './world-streaming';
import { RELIEF_RING_SCALES, VOXEL_RING_SCALES, VOXEL_STREAM_BUDGET_BYTES } from '@thirdlight/voxel';

const T = { position: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] };
const CAMERA = { id: 'cam-main', components: { transform: T, virtualCamera: { rig: 'fixed' } } };
const scene = (entities: unknown[]) => ({ schemaVersion: 4, sceneId: 'scene-main', revision: 1, entities: [CAMERA, ...entities] });

const FULL: VoxelWorldComponent = {
  world: 'town_1',
  ring: { loadRadius: 120, unloadRadius: 150, loadHeight: 60, unloadHeight: 80 },
  collision: { radius: 40, height: 20 },
  levels: { level0: 50, level1: 100 },
  quality: {
    high: { scale: 3 },
    low: { scale: 0.5, ring: { loadRadius: 40, unloadRadius: 50, loadHeight: 20, unloadHeight: 30 }, collision: { radius: 12, height: 6 }, levels: { level0: 20, level1: 30 } },
  },
  sectionEdge: 32,
  savedFields: ['material', 'shape', 'wetness'],
  decalLayers: 5,
  blendMetres: 0.125,
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
    expect(errorsOf({ world: 'w', ring: { loadRadius: 0, unloadRadius: Infinity, near: 3 }, collision: { radius: -1, height: '24' }, levels: { level0: 0, level1: '9', level2: 300 }, sectionEdge: 12, savedFields: ['material', 'colour', 'material'], decalLayers: 256, blendMetres: 0.75, climate: 1 })).toEqual([
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
      'field_value /decalLayers',
      'field_value /blendMetres',
    ]);
    // A blend is 0 (hard cell lines) to one cell.
    expect(errorsOf({ world: 'w', blendMetres: 0 })).toEqual([]);
    expect(errorsOf({ world: 'w', blendMetres: -0.1 })).toEqual(['field_value /blendMetres']);
    // A world in no decal layer takes no decal; a fraction is no mask.
    expect(errorsOf({ world: 'w', decalLayers: 0 })).toEqual([]);
    expect(errorsOf({ world: 'w', decalLayers: 1.5 })).toEqual(['field_value /decalLayers']);
    expect(errorsOf({ world: 'w', ring: 5, collision: [], levels: 64, savedFields: 'material' })).toEqual(['field_type /ring', 'field_type /collision', 'field_type /levels', 'field_type /savedFields']);
    // Per quality level: a level id, a scale in range, the same distance groups and ranges.
    expect(errorsOf({ world: 'w', quality: { Low: {}, medium: { scale: 5, ring: { loadRadius: -1 }, far: 1 }, high: 2 } })).toEqual([
      'field_value /quality/Low',
      'field_unexpected /quality/medium/far',
      'field_value /quality/medium/scale',
      'field_value /quality/medium/ring/loadRadius',
      'field_type /quality/high',
    ]);
    expect(errorsOf({ world: 'w', quality: [] })).toEqual(['field_type /quality']);
  });

  it('keeps every field through the scene validator and the canonical bytes, in order, adding nothing', () => {
    const shuffled = {
      blendMetres: 0.125,
      decalLayers: 5,
      savedFields: ['wetness', 'material', 'shape'],
      sectionEdge: 32,
      quality: { low: { levels: { level1: 30, level0: 20 }, collision: { height: 6, radius: 12 }, ring: { unloadHeight: 30, loadHeight: 20, unloadRadius: 50, loadRadius: 40 }, scale: 0.5 }, high: { scale: 3 } },
      levels: { level1: 100, level0: 50 },
      collision: { height: 20, radius: 40 },
      ring: { unloadHeight: 80, loadHeight: 60, unloadRadius: 150, loadRadius: 120 },
      world: 'town_1',
    };
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
    expect(r.levels).toEqual({ level0: DEFAULT_LEVEL_RINGS.radii[0]! * VOXEL_SIZE_M, level1: DEFAULT_LEVEL_RINGS.radii[1]! * VOXEL_SIZE_M, relief: DEFAULT_RELIEF_RADIUS_CELLS * VOXEL_SIZE_M });
    // Relief displaces to 16 m (the relief verdict's medium ring), its steps the quality level's: none without one.
    expect(r.levels).toEqual({ level0: 64, level1: 128, relief: 16 });
    expect(r.reliefSteps).toBe(0);
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
    expect(resolveVoxelWorld({ world: 'w', levels: { level0: 70, level1: 20 } }).levels).toEqual({ level0: 70, level1: 70, relief: 16 });
    expect(resolveVoxelWorld({ world: 'w', levels: { level0: 30 } }).levels).toEqual({ level0: 30, level1: 128, relief: 16 });
    // Relief never reaches past level 0; 0 is none, at every level.
    expect(resolveVoxelWorld({ world: 'w', levels: { level0: 10, relief: 40 } }).levels.relief).toBe(10);
    expect(resolveVoxelWorld({ world: 'w', levels: { relief: 0 } }, DEFAULT_QUALITY_LEVELS[2]!).levels.relief).toBe(0);
    expect(errorsOf({ world: 'w', levels: { relief: 0 } })).toEqual([]);
    expect(errorsOf({ world: 'w', levels: { relief: 0.5 } })).toEqual(['field_value /levels/relief']);
    expect(own.sectionEdge).toBe(8);
    expect(own.savedFields).toBe(PLANE_BIT.wetness);
    expect(resolveVoxelWorld({ world: 'w', savedFields: [] }).savedFields).toBe(0);
    // No quality level known: the scene's own distances, no budget of its own.
    expect([r.quality, r.budgetBytes]).toEqual([null, null]);
  });

  it("scales every distance by the quality level (the scene's scale for the level, else the level's, else its tier's), a scene's own distance at a level replacing the scaled one, and takes the tier's stream budget", () => {
    const [low, medium, high] = DEFAULT_QUALITY_LEVELS as QualityLevelConfig[];
    // Medium keeps the scene's distances (the defaults are the integrated GPU's); the tiers' own numbers are pinned below.
    expect(levelVoxels(medium!)).toEqual({ ringScale: 1, reliefScale: 1, budgetBytes: VOXEL_STREAM_BUDGET_BYTES.medium, texelDensity: 512, relief: 0, farField: 'mesh', farError: 4 });
    expect(levelVoxels(high!)).toEqual({ ringScale: Math.SQRT2, reliefScale: 1.5, budgetBytes: VOXEL_STREAM_BUDGET_BYTES.high, texelDensity: 1024, relief: 0, farField: 'mesh', farError: 3 });
    // A level's own ring scale moves relief by its factor against the tier's ring scale, relief's own tier scale kept.
    expect(levelVoxels({ ...high!, voxelRings: 2 * Math.SQRT2 }).reliefScale).toBeCloseTo(3, 12);
    expect(levelVoxels({ lighting: 'medium', voxelRings: 0.5 }).reliefScale).toBe(0.5);
    // Relief steps by tier: none on any (relief displacement is off until a level asks), a level's own beating its tier's.
    expect([low, medium, high].map((l) => resolveVoxelWorld({ world: 'w' }, l!).reliefSteps)).toEqual([0, 0, 0]);
    expect(resolveVoxelWorld({ world: 'w' }, { ...high!, voxelRelief: 4 }).reliefSteps).toBe(4);
    expect(resolveVoxelWorld({ world: 'w' }, { id: 'x', lighting: 'low', voxelRelief: 8 }).reliefSteps).toBe(8);
    // The far field: meshes on every tier, coarser on low; a level's own mode and detail beat its tier's; no level known draws medium's.
    expect([low, medium, high].map((l) => resolveVoxelWorld({ world: 'w' }, l!).far)).toEqual([{ mode: 'mesh', errorPixels: 8 }, { mode: 'mesh', errorPixels: 4 }, { mode: 'mesh', errorPixels: 3 }]);
    expect(resolveVoxelWorld({ world: 'w' }, { id: 'x', lighting: 'high', voxelFarField: 'off', voxelFarError: 8 }).far).toEqual({ mode: 'off', errorPixels: 8 });
    expect(resolveVoxelWorld({ world: 'w' }).far).toEqual({ mode: 'mesh', errorPixels: 4 });
    const base = resolveVoxelWorld({ world: 'w' });
    // The relief distance scales by its tier's own (`kRelief`, absent: as every distance).
    const scaled = (k: number, kRelief = k) => ({
      ring: Object.fromEntries(Object.entries(base.ring).map(([f, v]) => [f, v * k])),
      collision: Object.fromEntries(Object.entries(base.collision).map(([f, v]) => [f, v * k])),
      levels: Object.fromEntries(Object.entries(base.levels).map(([f, v]) => [f, v * (f === 'relief' ? kRelief : k)])),
    });
    const at = (c: VoxelWorldComponent, l: QualityLevelConfig) => {
      const r = resolveVoxelWorld(c, l);
      return { ring: r.ring, collision: r.collision, levels: r.levels };
    };
    // The engine's levels: low √½, medium as the defaults, high √2 times every distance; the budget is the tier's.
    expect(at({ world: 'w' }, low!)).toEqual(scaled(Math.SQRT1_2));
    expect(at({ world: 'w' }, medium!)).toEqual(scaled(1));
    expect(at({ world: 'w' }, high!)).toEqual(scaled(Math.SQRT2, 1.5));
    // Relief: medium 16 m, high 24 m (the rings the relief verdict chose).
    expect([medium, high].map((l) => resolveVoxelWorld({ world: 'w' }, l!).levels.relief)).toEqual([16, 24]);
    expect([resolveVoxelWorld({ world: 'w' }, high!).quality, resolveVoxelWorld({ world: 'w' }, high!).budgetBytes]).toEqual(['high', VOXEL_STREAM_BUDGET_BYTES.high]);
    // A level's own voxel ring scale beats its tier's (relief moved by its factor against the tier's ring scale, keeping
    // relief's own tier scale); the scene's scale for the level beats both.
    const tiny: QualityLevelConfig = { id: 'tiny', lighting: 'high', voxelRings: 0.5 };
    expect(at({ world: 'w' }, tiny)).toEqual(scaled(0.5, (0.5 / VOXEL_RING_SCALES.high) * RELIEF_RING_SCALES.high));
    expect(resolveVoxelWorld({ world: 'w' }, tiny).budgetBytes).toBe(VOXEL_STREAM_BUDGET_BYTES.high);
    expect(at({ world: 'w', quality: { tiny: { scale: 3 } } }, tiny)).toEqual(scaled(3));
    // The scene's own distances are what is scaled.
    const big: QualityLevelConfig = { id: 'big', lighting: 'high', voxelRings: 2 };
    expect(at({ world: 'w', ring: { loadRadius: 100 }, levels: { level0: 60 } }, big).ring.loadRadius).toBe(200);
    expect(at({ world: 'w', ring: { loadRadius: 100 }, levels: { level0: 60 } }, big).levels.level0).toBe(120);
    // A scaled distance stays within an authored one's limits (1 … 100,000 m).
    const far = at({ world: 'w', ring: { loadRadius: 80_000, unloadRadius: 90_000 } }, big).ring;
    expect([far.loadRadius, far.unloadRadius]).toEqual([STREAMING_RADIUS_LIMITS.max, STREAMING_RADIUS_LIMITS.max]);
    const quarter: QualityLevelConfig = { id: 'quarter', lighting: 'low', voxelRings: 0.25 };
    expect(at({ world: 'w', collision: { radius: 2 } }, quarter).collision.radius).toBe(STREAMING_RADIUS_LIMITS.min);
    // A distance the scene sets for the level replaces the scaled one; the others stay scaled; the invariants hold.
    const over = at({ world: 'w', quality: { big: { ring: { loadRadius: 500, unloadRadius: 10 }, levels: { level1: 1 } } } }, big);
    expect(over.ring).toEqual({ ...scaled(2).ring, loadRadius: 500, unloadRadius: 500 });
    expect(over.levels).toEqual({ level0: scaled(2).levels['level0'], level1: scaled(2).levels['level0'], relief: scaled(2, (2 / VOXEL_RING_SCALES.high) * RELIEF_RING_SCALES.high).levels['relief'] });
    expect(over.collision).toEqual(scaled(2).collision);
    // Another level of the scene is not touched by the entry.
    expect(at({ world: 'w', quality: { high: { scale: 4 } } }, medium!)).toEqual(scaled(1));
    // A quality level's voxel ring scale is range-checked like its other fields.
    const errs: ModelErrorV2[] = [];
    validateQualityLevels([{ id: 'a', voxelRings: 0.1 }, { id: 'b', voxelRings: 1.5, voxelRelief: 4 }, { id: 'c', voxelRelief: 3 }, { id: 'd', voxelFarField: 'hybrid' as never, voxelFarError: 0.1 }], '/q', errs);
    expect(errs.map((e) => `${e.code} ${e.path}`)).toEqual(['field_value /q/0/voxelRings', 'field_value /q/2/voxelRelief', 'field_value /q/3/voxelFarField', 'field_value /q/3/voxelFarError']);
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
