/**
 * The `voxelStructure` component through the whole scene validator: every
 * field of a full definition kept by the canonical form (an opening's prop
 * too), field refusals named by their pointer, the object's transform
 * refused when it tilts or scales, the scene rule (a grid to one
 * structure), and the placements read from it.
 */
import { describe, expect, it } from 'vitest';
import { BUILDING_GENERATOR_VERSION } from '@thirdlight/voxel';
import { serializeCanonical } from './normalize';
import { validateSceneV4 } from './scene-v3';
import { PREFAB_EXCLUDED_COMPONENTS } from './content-prefabs';
import { structurePlacements, type VoxelStructureComponent } from './voxel-structure';

const T = { position: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] };
const CAMERA = { id: 'cam-main', components: { transform: T, virtualCamera: { rig: 'fixed' } } };
const WORLD = { id: 'world-000001', components: { transform: T, voxelWorld: { world: 'town' } } };
const scene = (entities: unknown[]) => ({ schemaVersion: 4, sceneId: 'scene-main', revision: 1, entities: [CAMERA, WORLD, ...entities] });

/** A house with every field a definition has, an L of two polygons, a door with a prop, a window and a stair. */
const FULL: VoxelStructureComponent = {
  world: 'town',
  grid: 7,
  footprint: [
    { id: 'main', points: [[0, 0], [16, 0], [16, 12], [0, 12]] },
    { id: 'wing', points: [[16, 0], [24, 0], [24, 8], [16, 8]] },
  ],
  storeys: 2,
  storeyHeight: 6,
  foundationDepth: 2,
  roof: { shape: 'hip', overhang: 1, axis: 'z' },
  materials: { wall: 3, floor: 4, roof: 5, foundation: 6, stair: 7 },
  openings: [
    { id: 'door', polygon: 'main', edge: 0, storey: 0, at: 4, width: 2, height: 4, sill: 0, prop: 'door-oak' },
    { id: 'win', polygon: 'main', edge: 1, storey: 1, at: 3, width: 2, height: 2, sill: 2 },
  ],
  stairs: [{ id: 's1', polygon: 'main', from: 0, at: [2, 6], facing: '+x' }],
  generator: BUILDING_GENERATOR_VERSION,
};

const house = (c: unknown, t: unknown = T, extra: Record<string, unknown> = {}) => ({ id: 'house-000001', components: { transform: t, voxelStructure: c }, ...extra });

function errorsOf(entities: unknown[]): Array<{ code: string; path: string; message: string }> {
  const r = validateSceneV4(scene(entities));
  return r.ok ? [] : (r.errors as unknown as Array<{ code: string; path: string; message: string }>);
}

describe('voxelStructure', () => {
  it('keeps every field of a full definition through the scene validator, in canonical order, nothing added', () => {
    const r = validateSceneV4(scene([house(FULL)]));
    if (!r.ok) throw new Error(JSON.stringify(r.errors));
    const kept = (r.normalized.entities[2]!.components as { voxelStructure?: unknown }).voxelStructure;
    expect(kept).toEqual(FULL);
    expect(Object.keys(kept as object)).toEqual(['world', 'grid', 'footprint', 'storeys', 'storeyHeight', 'foundationDepth', 'roof', 'materials', 'openings', 'stairs', 'generator']);
    // Fields in another order canonicalise to the same bytes.
    const shuffled = Object.fromEntries(Object.entries(FULL).reverse());
    const again = validateSceneV4(scene([house(shuffled)]));
    if (!again.ok) throw new Error(JSON.stringify(again.errors));
    const bytes = (x: unknown): string => { const b = serializeCanonical(x); if (!b.ok) throw new Error('not serializable'); return new TextDecoder().decode(b.bytes); };
    expect(bytes(again.normalized)).toBe(bytes(r.normalized));
    expect((again.normalized.entities[2]!.components as { voxelStructure: VoxelStructureComponent }).voxelStructure.openings[0]!.prop).toBe('door-oak');
  });

  it('refuses bad fields by their pointer', () => {
    const at = (c: unknown) => errorsOf([house(c)]).map((e) => e.path);
    expect(at({ ...FULL, grid: 0 })).toContain('/entities/2/components/voxelStructure/grid');
    expect(at({ ...FULL, world: 'Bad World' })).toContain('/entities/2/components/voxelStructure/world');
    expect(at({ ...FULL, storeys: 0 })).toContain('/entities/2/components/voxelStructure/storeys');
    expect(at({ ...FULL, roof: { ...FULL.roof, shape: 'dome' } })).toContain('/entities/2/components/voxelStructure/roof/shape');
    expect(at({ ...FULL, materials: { ...FULL.materials, wall: 0 } })).toContain('/entities/2/components/voxelStructure/materials/wall');
    expect(at({ ...FULL, colour: 'red' })).toContain('/entities/2/components/voxelStructure/colour');
    const { grid: _g, ...noGrid } = FULL;
    expect(errorsOf([house(noGrid)])[0]!.code).toBe('field_missing');
  });

  it('refuses a tilt, a scale and a parent object; takes a turn about the vertical axis', () => {
    const tilt = Math.sin(0.1);
    const tilted = errorsOf([house(FULL, { ...T, rotation: [tilt, 0, 0, Math.cos(0.1)] })]);
    expect(tilted.map((e) => e.path)).toContain('/entities/2/components/transform/rotation');
    expect(tilted[0]!.message).toMatch(/vertical axis only/);
    expect(errorsOf([house(FULL, { ...T, scale: [2, 1, 1] })]).map((e) => e.path)).toContain('/entities/2/components/transform/scale');
    const yaw = Math.PI / 6;
    expect(errorsOf([house(FULL, { ...T, rotation: [0, Math.sin(yaw / 2), 0, Math.cos(yaw / 2)] })])).toEqual([]);
    const parent = { id: 'prop-000001', components: { transform: T } };
    expect(errorsOf([parent, house(FULL, T, { parentId: 'prop-000001' })]).map((e) => e.path)).toContain('/entities/3/parentId');
    const folder = { id: 'folder-000001', components: { folder: {} } };
    expect(errorsOf([folder, house(FULL, T, { parentId: 'folder-000001' })])).toEqual([]);
  });

  it('owns its grid', () => {
    const second = { ...house(FULL), id: 'house-000002' };
    expect(errorsOf([house(FULL), second]).map((e) => e.path)).toContain('/entities/3/components/voxelStructure/grid');
    expect(errorsOf([house(FULL), { ...second, components: { ...second.components, voxelStructure: { ...FULL, grid: 8 } } }])).toEqual([]);
    expect(PREFAB_EXCLUDED_COMPONENTS).toContain('voxelStructure');
  });

  it('places each grid at its object: position and yaw', () => {
    const yaw = Math.PI / 4;
    const r = validateSceneV4(scene([house(FULL, { ...T, position: [10, 2, -4], rotation: [0, Math.sin(yaw / 2), 0, Math.cos(yaw / 2)] })]));
    if (!r.ok) throw new Error(JSON.stringify(r.errors));
    const places = structurePlacements([r.normalized]);
    expect(places.get('town')).toHaveLength(1);
    const p = places.get('town')![0]!;
    expect(p.gridId).toBe(7);
    expect(p.position).toEqual([10, 2, -4]);
    expect(p.yawRad).toBeCloseTo(yaw, 12);
  });
});
