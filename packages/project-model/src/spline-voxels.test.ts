/**
 * A spline's `voxels` section through the whole scene validator: every
 * field kept by the canonical form, refusals named by their pointer, a
 * spline that writes voxels kept at the scene's root and out of prefabs,
 * hidden from scripts; the world it writes into read from its scene; the
 * writer's definition from its curve (samples, widths, a river's depth, the
 * bodies a river meets).
 */
import { describe, expect, it } from 'vitest';
import { validatePrefabDefinitions } from './content-prefabs';
import { DESCRIPTORS } from './descriptors';
import { validateSceneV4 } from './scene-v3';
import { SPLINE_RIVER_DEPTH_DEFAULT, type SplineVoxelSettings } from './spline';
import { sceneVoxelSplines, splineVoxelDefinition, splineVoxelWorld, SPLINE_VOXEL_STEP } from './spline-voxels';
import type { SceneWaterBody } from './water-body';

const T = { position: [4, 1, -2], rotation: [0, 0, 0, 1], scale: [1, 1, 1] };
const CAMERA = { id: 'cam-main', components: { transform: { position: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] }, virtualCamera: { rig: 'fixed' } } };
const WORLD = { id: 'world-000001', components: { transform: { position: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] }, voxelWorld: { world: 'town' } } };
const scene = (entities: unknown[]) => ({ schemaVersion: 4, sceneId: 'scene-main', revision: 1, entities: [CAMERA, WORLD, ...entities] });
const FULL: SplineVoxelSettings = { kind: 'road', material: 20, bed: { material: 21, depth: 1 }, shoulder: { width: 2, slope: 0.5 }, clear: 3 };
const POINTS = [{ at: [0, 0, 0] }, { at: [20, 0, 0], width: 8 }, { at: [40, 2, 10] }];
const road = (voxels: unknown, extra: Record<string, unknown> = {}) => ({ id: 'road-000001', components: { transform: T, spline: { points: POINTS, width: 6, voxels } }, ...extra });

function errorsOf(entities: unknown[]): Array<{ code: string; path: string }> {
  const r = validateSceneV4(scene(entities));
  return r.ok ? [] : (r.errors as unknown as Array<{ code: string; path: string }>);
}

describe('spline voxels', () => {
  it('keeps every field through the scene validator, in canonical order', () => {
    const shuffled = { clear: 3, shoulder: { slope: 0.5, width: 2 }, bed: { depth: 1, material: 21 }, material: 20, kind: 'road' };
    const r = validateSceneV4(scene([road(shuffled)]));
    if (!r.ok) throw new Error(JSON.stringify(r.errors));
    const kept = (r.normalized.entities[2]!.components as { spline: { voxels: unknown } }).spline.voxels;
    expect(kept).toEqual(FULL);
    expect(JSON.stringify(kept)).toBe(JSON.stringify(FULL));
    const river = validateSceneV4(scene([road({ kind: 'river', material: 5 })]));
    expect(river.ok).toBe(true);
  });

  it('refuses bad fields by their pointer, a spline that writes voxels under a parent, and one in a prefab', () => {
    const p = '/entities/2/components/spline/voxels';
    const at = (v: unknown) => errorsOf([road(v)]).map((e) => e.path);
    expect(at({ kind: 'canal', material: 3 })).toEqual([`${p}/kind`]);
    expect(at({ kind: 'road' })).toEqual([`${p}/material`]);
    expect(at({ kind: 'road', material: 5000 })).toEqual([`${p}/material`]);
    expect(at({ kind: 'road', material: 3, bed: { material: 3, depth: 0 } })).toEqual([`${p}/bed/depth`]);
    expect(at({ kind: 'road', material: 3, shoulder: { width: 2, slope: -1 } })).toEqual([`${p}/shoulder/slope`]);
    expect(at({ kind: 'road', material: 3, clear: -1 })).toEqual([`${p}/clear`]);
    expect(at({ kind: 'road', material: 3, lanes: 2 })).toEqual([`${p}/lanes`]);
    const parented = errorsOf([{ id: 'grp-000001', components: { transform: T } }, road(FULL, { parentId: 'grp-000001' })]);
    expect(parented.map((e) => e.code)).toContain('component_conflict');
    // A spline without voxels may still sit under a parent.
    expect(errorsOf([{ id: 'grp-000001', components: { transform: T } }, { id: 'road-000001', parentId: 'grp-000001', components: { transform: T, spline: { points: POINTS } } }])).toEqual([]);
    const errs: Array<{ code: string; path: string }> = [];
    const def = { prefabId: 'pre-a', displayName: 'P', createdRevision: 1, entityCount: 1, depth: 1, entities: [{ localId: 'root', components: { transform: T, spline: { points: POINTS, voxels: FULL } } }] };
    validatePrefabDefinitions([def], '', errs as never, 4);
    expect(errs.map((e) => e.path)).toContain('/0/entities/0/components/spline/voxels');
  });

  it('is hidden from scripts: authoring data, left out of exports', () => {
    const spline = DESCRIPTORS.components.find((c) => c.name === 'spline')!;
    const fields = (spline.value as unknown as { fields: Array<{ key: string; scriptReadable?: true }> }).fields;
    expect(fields.find((f) => f.key === 'voxels')!.scriptReadable).toBeUndefined();
    expect(fields.find((f) => f.key === 'points')!.scriptReadable).toBe(true);
  });

  it("writes into its scene's one voxel world, and has none in a scene of none or of two", () => {
    const [s] = sceneVoxelSplines([scene([road(FULL)])]);
    expect(splineVoxelWorld(s!)).toEqual({ world: 'town' });
    const [none] = sceneVoxelSplines([{ sceneId: 'b', entities: [road(FULL)] }]);
    expect('why' in splineVoxelWorld(none!)).toBe(true);
    const [two] = sceneVoxelSplines([{ sceneId: 'c', entities: [WORLD, { id: 'world-000002', components: { voxelWorld: { world: 'moor' } } }, road(FULL)] }]);
    expect(splineVoxelWorld(two!)).toEqual({ why: expect.stringContaining('2 voxel worlds (moor, town)') });
    // A spline without a voxels section is not one of them.
    expect(sceneVoxelSplines([scene([{ id: 'r', components: { transform: T, spline: { points: POINTS } } }])])).toEqual([]);
  });

  it('gives the writer its curve where it stands, every quarter metre with the widths, a river its depth and the bodies it meets', () => {
    const [s] = sceneVoxelSplines([scene([road(FULL)])]);
    const d = splineVoxelDefinition(s!, [])!;
    expect(d).toMatchObject({ kind: 'road', material: 20, bed: { material: 21, depth: 1 }, depth: 0, shoulder: { width: 2, slope: 0.5 }, clear: 3, closed: false, bodies: [] });
    const n = d.samples.length / 4;
    expect(d.samples.slice(0, 4)).toEqual([4, 1, -2, 6]);
    expect(d.samples.slice(-4)).toEqual([44, 3, 8, 6]);
    // About a quarter metre apart along the curve, the width 8 m at the middle point.
    for (let i = 1; i < n; i++) expect(Math.hypot(d.samples[i * 4]! - d.samples[i * 4 - 4]!, d.samples[i * 4 + 1]! - d.samples[i * 4 - 3]!, d.samples[i * 4 + 2]! - d.samples[i * 4 - 2]!)).toBeLessThan(SPLINE_VOXEL_STEP * 1.05);
    expect(Math.max(...Array.from({ length: n }, (_, i) => d.samples[i * 4 + 3]!))).toBeCloseTo(8, 1);
    const [r] = sceneVoxelSplines([scene([road({ kind: 'river', material: 5 })])]);
    const lake = (level: number, x: number): SceneWaterBody => ({ sceneId: 'scene-main', entityId: `lake-${x}`, body: { world: 'town', level, material: 6, reach: 10 }, seed: [x, 0, 0] });
    const rd = splineVoxelDefinition(r!, [lake(0.5, 50), lake(-5, 40), lake(0.5, 200)])!;
    expect(rd.depth).toBe(SPLINE_RIVER_DEPTH_DEFAULT);
    // The first: in reach of the course's end and over its floor; the second under the floor; the third out of reach.
    expect(rd.bodies).toEqual([{ level: 0.5, material: 6, seed: [50, 0], reach: 10 }]);
    expect(splineVoxelDefinition({ ...r!, position: null }, [])).toBeNull();
  });
});
