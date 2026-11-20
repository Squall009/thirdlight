import { describe, expect, it } from 'vitest';
import type { EntityV3 } from '@thirdlight/project-model';
import { PROP_SAMPLES_PER_AXIS, VOXEL_SIZE_M, type PropShape } from '@thirdlight/voxel';
import { voxelPortalInfo, voxelRegionInfo } from './voxel-api';
import { RuntimeVoxels } from './voxel-worlds';
import type { WorldTransform } from './world-transform';

describe('lit props stamped as they move', () => {
  it('a prop is stamped again once it has moved by a sample of the stamp, not every step it moves a little', () => {
    const pose: { position: [number, number, number]; rotation: [number, number, number, number] } = { position: [0, 1, 0], rotation: [0, 0, 0, 1] };
    let shapes = 0;
    const box: PropShape = { inside: () => true, min: [-1, -0.5, -0.5], max: [1, 0.5, 0.5], position: [0, 0, 0], yaw: [1, 0], scale: 1 };
    const rv = new RuntimeVoxels(null, undefined, {
      camera: () => null,
      positionOf: () => [0, 0, 0],
      characters: () => [],
      worldTransform: (): WorldTransform => ({ position: [...pose.position], rotation: [...pose.rotation], scale: [1, 1, 1] }),
      propShape: () => (shapes++, box),
      warn: () => undefined,
    });
    rv.add([
      { id: 'world', components: { voxelWorld: { world: 'w' } } },
      { id: 'cart', components: { model: { asset: { assetId: 'm' }, affectsLighting: true } } },
    ] as unknown as EntityV3[]);
    const sample = VOXEL_SIZE_M / PROP_SAMPLES_PER_AXIS;
    rv.beginStep();
    expect(shapes).toBe(1);
    // A cart at 1 m/s and 120 steps a second: 8 mm a step.
    for (let i = 0; i < 120; i++) {
      pose.position[0] += 1 / 120;
      rv.beginStep();
    }
    expect(shapes - 1).toBeGreaterThanOrEqual(Math.floor(1 / sample) - 1);
    expect(shapes - 1).toBeLessThanOrEqual(Math.ceil(1 / sample) + 1);
    // A turn moves its ends (1.1 m out): 0.05 rad moves them 5.6 cm (below a sample), 0.15 rad 17 cm (past it).
    // A move of a whole sample stamps it where it is now; the turns below are measured from there.
    pose.position[0] += 2 * sample;
    rv.beginStep();
    const turned = shapes;
    const yaw = (a: number): [number, number, number, number] => [0, Math.sin(a / 2), 0, Math.cos(a / 2)];
    pose.rotation = yaw(0.05);
    rv.beginStep();
    expect(shapes).toBe(turned);
    pose.rotation = yaw(0.15);
    rv.beginStep();
    expect(shapes).toBe(turned + 1);
    // Standing still: never again.
    for (let i = 0; i < 30; i++) rv.beginStep();
    expect(shapes).toBe(turned + 1);
    rv.dispose();
  });
});

describe('a region as scripts read it', () => {
  const base = { id: 7, portal: false, cells: 480, sky: false, complete: true, enclosed: true, portals: 2, min: [28, 5, 26] as const, max: [35, 10, 35] as const, faces: 376 };

  it('a 4 × 3 × 5 m room: kind room, its box in metres, 60 m³, 94 m², a mean free path of 4V/S = 2.55 m', () => {
    const r = voxelRegionInfo(base, false);
    expect(r.kind).toBe('room');
    expect(r.bounds).toEqual({ min: [14, 2.5, 13], max: [18, 5.5, 18] });
    expect(r.volume).toBeCloseTo(60, 9);
    expect(r.surface).toBeCloseTo(94, 9);
    expect(r.meanFreePath).toBeCloseTo(240 / 94, 9);
    expect([r.enclosed, r.sky, r.seesSky, r.portals]).toEqual([true, false, false, 2]);
  });

  it('the outdoors, a portal and a region still loading are told apart', () => {
    expect(voxelRegionInfo({ ...base, enclosed: false, sky: true }, true).kind).toBe('outdoors');
    expect(voxelRegionInfo({ ...base, enclosed: false, complete: false }, false).kind).toBe('unknown');
    expect(voxelRegionInfo({ ...base, portal: true, enclosed: false }, false).kind).toBe('portal');
    expect(voxelRegionInfo({ ...base, faces: 0 }, false).meanFreePath).toBe(0);
    expect(voxelPortalInfo({ id: 3, min: [24, 5, 20], max: [25, 8, 20], cells: 8, regions: [1, 7] })).toEqual({ id: 3, bounds: { min: [12, 2.5, 10], max: [13, 4.5, 10.5] }, volume: 1, regions: [1, 7] });
  });
});
