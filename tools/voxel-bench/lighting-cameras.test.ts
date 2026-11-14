/**
 * The lighting cameras and their content, without a browser: the five names and their order are fixed; each
 * camera stands where its picture has something to show in the generated town (read from town.ts's own cells,
 * the town far-world.ts puts at the 8 km world's centre); the cave's camera stands inside the dug tube looking
 * out; the looks pass the project model's preset check; the bench's options parse and refuse bad values; and a
 * shot that shows no voxels (the same picture with the voxels hidden, e.g. a camera looking at the sky) is
 * refused.
 */
import { describe, expect, it } from 'vitest';
import { validateEnvironmentPresets, type ModelErrorV2 } from '@thirdlight/project-model';
import { chunkGrid, createDenseChunk, localIndex, VOXEL_ROLE } from '@thirdlight/voxel';
import { townWorld } from './town';
import {
  BENCH_LAMPS,
  CAVE,
  caveStroke,
  changedShare,
  LIGHT_PRESET_IDS,
  LIGHT_SHOT_NAMES,
  LIGHTING_CAMERAS,
  LIGHTING_PRESETS,
  lightShotsSource,
  parseLightShotsArgs,
  ROOM_HOUSE,
  shotProblems,
  type Picture,
} from './lighting-cameras';

/** The far world's town cells: its 512-cell town shifted so its middle is the origin. */
const TOWN_SHIFT = 256;
const grid = chunkGrid(32);
const town = townWorld({ footprint: 512 }).grids[0]!;
const chunks = new Map<string, ReturnType<typeof createDenseChunk>>();
/** The town's voxel at world metres (x, y, z): its role, or -1 for air. */
function roleAt(x: number, y: number, z: number): number {
  const cx = Math.floor(x * 2) + TOWN_SHIFT, cy = Math.floor(y * 2), cz = Math.floor(z * 2) + TOWN_SHIFT;
  const k = `${cx >> 5},${cy >> 5},${cz >> 5}`;
  let d = chunks.get(k);
  if (d === undefined) {
    d = createDenseChunk(grid);
    town.fill(grid, cx >> 5, cy >> 5, cz >> 5, d);
    chunks.set(k, d);
  }
  const i = localIndex(grid, cx & 31, cy & 31, cz & 31);
  return d.material[i] === 0 ? -1 : d.role[i]!;
}
const camera = (name: string) => LIGHTING_CAMERAS.find((c) => c.name === name)!;
/** The ground heading a camera looks along. */
const heading = (yaw: number): [number, number] => [-Math.sin(yaw), -Math.cos(yaw)];

describe('the lighting cameras', () => {
  it('are the five fixed names in order, each with its own command and a known look', () => {
    expect(LIGHTING_CAMERAS.map((c) => c.name)).toEqual([...LIGHT_SHOT_NAMES]);
    expect(new Set(LIGHTING_CAMERAS.map((c) => c.command)).size).toBe(5);
    for (const c of LIGHTING_CAMERAS) {
      expect(LIGHT_PRESET_IDS).toContain(c.preset);
      expect([...c.eye, c.yaw, c.pitch].every(Number.isFinite)).toBe(true);
    }
    expect(LIGHTING_CAMERAS.filter((c) => c.preset === 'bench-night').map((c) => c.name)).toEqual(['night-lamps']);
    // Every command is in the camera's behaviour.
    const src = lightShotsSource();
    for (const c of LIGHTING_CAMERAS) expect(src).toContain(`"command":"${c.command}"`);
  });

  it('stand in the air of the town where their pictures have something to show', () => {
    for (const name of ['street-noon', 'night-lamps', 'room-window']) {
      const c = camera(name);
      expect(roleAt(...c.eye), `${name}'s eye`).toBe(-1);
    }
    // The streets: ground under the eye, house walls (with openings) on the +z side within 6 m, along the view.
    for (const name of ['street-noon', 'night-lamps']) {
      const c = camera(name);
      expect(roleAt(c.eye[0], -0.25, c.eye[2]), `${name}: ground`).toBe(VOXEL_ROLE.terrain);
      const [dx, dz] = heading(c.yaw);
      let fronts = 0;
      for (let m = 4; m <= 60; m += 0.5) for (let side = 0; side <= 6; side += 0.5) {
        const r = roleAt(c.eye[0] + dx * m, 1.25, c.eye[2] + dz * m + side);
        if (r === VOXEL_ROLE.opening) fronts++;
      }
      expect(fronts, `${name}: windows and doors beside the street`).toBeGreaterThan(10);
    }
    // The room: inside the house's walls, under its first floor, the window wall ahead with openings in it.
    const room = camera('room-window');
    for (let k = 0; k < 3; k++) expect(room.eye[k]).toBeGreaterThan(ROOM_HOUSE.min[k]!);
    for (let k = 0; k < 3; k++) expect(room.eye[k]).toBeLessThan(ROOM_HOUSE.max[k]!);
    expect(roleAt(room.eye[0], ROOM_HOUSE.max[1] + 0.25, room.eye[2]), 'a floor over the room').toBe(VOXEL_ROLE.floor);
    let openings = 0;
    for (let z = ROOM_HOUSE.min[2]; z < ROOM_HOUSE.max[2]; z += 0.5) for (let y = 0.5; y < 3; y += 0.5) if (roleAt(ROOM_HOUSE.min[0] + 0.25, y, z) === VOXEL_ROLE.opening) openings++;
    expect(openings, 'windows in the west wall').toBeGreaterThanOrEqual(8);
    expect(heading(room.yaw)[0]).toBeLessThan(-0.9);
    // The lamps hang in the street's air.
    for (const l of BENCH_LAMPS) expect(roleAt(...l.position), l.name).toBe(-1);
  });

  it('put the cave camera inside the dug tube, looking out of its mouth', () => {
    const c = camera('cave');
    const s = caveStroke();
    expect(s.points.length / 3).toBe((CAVE.toM - CAVE.fromM) / CAVE.stepM + 1);
    // Distance from the axis (metres) under the tube's radius, deep inside (past 15 m from the foot), facing the mouth.
    const along = (c.eye[0] - CAVE.foot[0]) * CAVE.into[0] + (c.eye[2] - CAVE.foot[2]) * CAVE.into[1];
    const off = Math.hypot(c.eye[0] - (CAVE.foot[0] + CAVE.into[0] * along), c.eye[1] - CAVE.axisY, c.eye[2] - (CAVE.foot[2] + CAVE.into[1] * along));
    expect(along).toBeGreaterThan(15);
    expect(along).toBeLessThan(CAVE.toM);
    expect(off).toBeLessThan(CAVE.diameter / 2 - 1);
    const [dx, dz] = heading(c.yaw);
    expect(dx * CAVE.into[0] + dz * CAVE.into[1]).toBeLessThan(-0.99);
    // The stroke's dabs in cells, the tube's diameter in cells.
    expect(s.size).toEqual([CAVE.diameter * 2, CAVE.diameter * 2, CAVE.diameter * 2]);
    expect(s.points.every(Number.isInteger)).toBe(true);
  });

  it('have looks the project model accepts', () => {
    const errors: ModelErrorV2[] = [];
    validateEnvironmentPresets(LIGHTING_PRESETS, '/environment/presets', errors);
    expect(errors).toEqual([]);
    expect(LIGHTING_PRESETS.map((p) => p.presetId)).toEqual([...LIGHT_PRESET_IDS]);
  });
});

describe('the light-shots options', () => {
  it('default to the low tier, every camera, 1280 × 720 on staging', () => {
    const o = parseLightShotsArgs([]);
    expect([o.quality, o.project, o.world, o.origin, o.query, o.viewport.width, o.viewport.height]).toEqual(['low', 'voxel-slice', 'far', 'http://127.0.0.1:4180', '', 1280, 720]);
    expect(o.only).toEqual([...LIGHT_SHOT_NAMES]);
  });
  it('pass a query through and pick cameras by name', () => {
    const o = parseLightShotsArgs(['--quality', 'medium', '--query', '&voxelShadows=static', '--only', 'cave,far-view', '--out', 'x', '--edits', '0']);
    expect([o.quality, o.query, o.only, o.out, o.edits]).toEqual(['medium', '&voxelShadows=static', ['cave', 'far-view'], 'x', 0]);
  });
  it('refuse bad values, naming the option', () => {
    expect(() => parseLightShotsArgs(['--quality', 'ultra'])).toThrow(/--quality/);
    expect(() => parseLightShotsArgs(['--only', 'cellar'])).toThrow(/--only/);
    expect(() => parseLightShotsArgs(['--query', 'voxelShadows=static'])).toThrow(/--query/);
    expect(() => parseLightShotsArgs(['--hold', '-1'])).toThrow(/--hold/);
    expect(() => parseLightShotsArgs(['--out'])).toThrow(/--out/);
  });
});

describe('a shot is refused', () => {
  const picture = (w: number, h: number, at: (x: number, y: number) => [number, number, number, number]): Picture => ({ width: w, height: h, pixel: at });
  const sky = picture(64, 36, () => [120, 160, 220, 255]);
  const ground = picture(64, 36, (_x, y) => (y > 18 ? [90, 80, 60, 255] : [120, 160, 220, 255]));
  it('when hiding the voxels changes nothing (a camera looking at the sky)', () => {
    const share = changedShare(sky, sky);
    expect(share).toBe(0);
    expect(shotProblems({ settled: true, chunks: 400, l0: 300, farBricks: 900, voxelShare: share, near: true }).join()).toMatch(/no voxel surface/);
  });
  it('when it never settled or drew no voxels, and not when voxels fill part of the frame', () => {
    const share = changedShare(ground, sky);
    expect(share).toBeCloseTo(17 / 36, 3);
    expect(shotProblems({ settled: true, chunks: 400, l0: 300, farBricks: 900, voxelShare: share, near: true })).toEqual([]);
    expect(shotProblems({ settled: false, chunks: 400, l0: 300, farBricks: 900, voxelShare: share, near: true })).toEqual(['streaming never settled']);
    expect(shotProblems({ settled: true, chunks: 0, l0: 0, farBricks: 0, voxelShare: share, near: false })).toEqual(['no voxel draws']);
    expect(shotProblems({ settled: true, chunks: 50, l0: 0, farBricks: 900, voxelShare: share, near: true })).toEqual(['no level-0 chunk drawn']);
  });
});
