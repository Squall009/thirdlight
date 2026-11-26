/**
 * The lighting cameras and their content, without a browser: the five names and their order are fixed; each
 * camera stands where its picture has something to show in the generated town (read from town.ts's own cells,
 * the town far-world.ts puts at the 8 km world's centre); the cave's camera stands inside the dug tube looking
 * out; the looks pass the project model's preset check; the bench's options parse and refuse bad values; and a
 * shot that shows no voxels (the same picture with the voxels hidden, e.g. a camera looking at the sky) is
 * refused.
 */
import { DAY_PRESET_IDS } from './day-cycle';
import { describe, expect, it } from 'vitest';
import { transformSync } from 'esbuild';
import { DebugCommands, MAX_DEBUG_COMMANDS } from '../../packages/runtime/src/debug-commands';
import { dayBehaviour } from './day-cycle';
import { L_ROOM_COMMAND, roomsBehaviour } from './bench-rooms';
import { manyLampsBehaviour, manyLampsScene } from './many-lamps';
import { validateEnvironmentPresets, type ModelErrorV2 } from '@thirdlight/project-model';
import { chunkGrid, createDenseChunk, localIndex, VOXEL_ROLE } from '@thirdlight/voxel';
import { townWorld } from './town';
import {
  BENCH_EXTRA_LAMP_LIGHT,
  BENCH_LAMPS,
  BENCH_LIGHT_TYPES,
  benchExtraLamps,
  CAVE,
  caveStroke,
  changedShare,
  cacheEditTiming,
  editShadowTiming,
  LAMP_WALL,
  EDIT_DIGS,
  GLOW_COMMANDS,
  LAMP_WALL_COMMANDS,
  SHOT_COMMAND,
  shotCall,
  LIGHT_CHECK_CAMERAS,
  LIGHT_PRESET_IDS,
  LIGHT_SHOT_NAMES,
  LIGHTING_CAMERAS,
  MANY_LAMP_CAMERAS,
  LIGHTING_PRESETS,
  lightShotsSource,
  parseLightShotsArgs,
  REF_CAMERAS,
  REF_HOUSE,
  ROOM_HOUSE,
  shotProblems,
  type Picture,
} from './lighting-cameras';

/** The far world's town cells: its 512-cell town shifted so its middle is the origin. */
const TOWN_SHIFT = 256;
const grid = chunkGrid(32);
const town = townWorld({ footprint: 512 }).grids[0]!;
const chunks = new Map<string, ReturnType<typeof createDenseChunk>>();
/** The town's voxel at world metres (x, y, z): its material and role (material 0: air). */
function cellAt(x: number, y: number, z: number): { material: number; role: number } {
  const cx = Math.floor(x * 2) + TOWN_SHIFT, cy = Math.floor(y * 2), cz = Math.floor(z * 2) + TOWN_SHIFT;
  const k = `${cx >> 5},${cy >> 5},${cz >> 5}`;
  let d = chunks.get(k);
  if (d === undefined) {
    d = createDenseChunk(grid);
    town.fill(grid, cx >> 5, cy >> 5, cz >> 5, d);
    chunks.set(k, d);
  }
  const i = localIndex(grid, cx & 31, cy & 31, cz & 31);
  return { material: d.material[i]!, role: d.role[i]! };
}
/** The town's voxel's role at world metres, or -1 for air. */
function roleAt(x: number, y: number, z: number): number {
  const c = cellAt(x, y, z);
  return c.material === 0 ? -1 : c.role;
}
/** Whether the straight line from `a` to `b` (metres) runs through air only, every 5 cm. */
function clearLine(a: readonly number[], b: readonly number[]): boolean {
  const n = Math.ceil(Math.hypot(b[0]! - a[0]!, b[1]! - a[1]!, b[2]! - a[2]!) / 0.05);
  for (let k = 0; k <= n; k++) if (roleAt(a[0]! + ((b[0]! - a[0]!) * k) / n, a[1]! + ((b[1]! - a[1]!) * k) / n, a[2]! + ((b[2]! - a[2]!) * k) / n) !== -1) return false;
  return true;
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

  it('declare their commands within a game\'s limit with every extra a run adds, so the commands after the cameras\' exist: one shot command, the camera its argument', () => {
    // The fullest script a run publishes: every camera, the many-lamps scene, the day and the rooms.
    const cameras = [...LIGHTING_CAMERAS, ...LIGHT_CHECK_CAMERAS, ...MANY_LAMP_CAMERAS];
    expect(cameras.length, 'a command a camera alone would leave no room for the rest').toBeGreaterThan(MAX_DEBUG_COMMANDS - 8);
    const src = lightShotsSource(cameras, [manyLampsBehaviour(manyLampsScene(128)), dayBehaviour(), roomsBehaviour('subject', cameras)]);
    const js = transformSync(src, { loader: 'ts', format: 'cjs' }).code;
    const module = { exports: {} as { default?: { instantiate(): Record<string, unknown>; step(s: unknown, ctx: unknown): void } } };
    new Function('module', 'exports', js)(module, module.exports);
    const behaviour = module.exports.default!;
    // The game's own registry of debug commands: a declaration past its limit throws, as it does in a game.
    const dropped: string[] = [];
    const commands = new DebugCommands({ emitSignal: () => undefined, dropped: (problem) => void dropped.push(problem) });
    const counters = new Map<string, number>();
    const looks: string[] = [];
    const ctx = {
      phase: 'intent',
      stepIndex: 0,
      debug: { command: (name: string, options?: never) => commands.declare(name, options, true) },
      game: { add: (n: string, x: number) => void counters.set(n, (counters.get(n) ?? 0) + x), counter: (n: string) => counters.get(n) ?? 0 },
      environment: { set: (id: string) => void looks.push(id), blend: () => undefined },
      camera: { setSeeThrough: () => true },
      entity: () => undefined,
      world: { find: () => undefined },
      voxels: undefined,
    };
    const s = behaviour.instantiate();
    expect(() => behaviour.step(s, ctx)).not.toThrow();
    const declared = commands.state().registered.map((c) => c.name);
    expect(declared.length).toBeLessThanOrEqual(MAX_DEBUG_COMMANDS);
    // The commands the benches send after their shots: each is declared, so a call is taken.
    for (const name of ['region_dig', L_ROOM_COMMAND, LAMP_WALL_COMMANDS.build, LAMP_WALL_COMMANDS.dig, GLOW_COMMANDS.night, ...EDIT_DIGS.map((d) => d.command)]) {
      expect(declared, name).toContain(name);
      expect(commands.enqueue({ name, args: {} })).toEqual({ ok: true });
    }
    // A camera is the shot command's argument: its call moves the camera there and puts its look on.
    const far = cameras.find((c) => c.name === 'town-250m')!;
    const [name, args] = shotCall(far);
    expect(name).toBe(SHOT_COMMAND);
    commands.take(64);
    expect(commands.enqueue({ name, args })).toEqual({ ok: true });
    commands.deliver({ stepIndex: 1, commands: commands.take(4) } as never);
    behaviour.step(s, { ...ctx, stepIndex: 1 });
    expect(s['at']).toBe(cameras.indexOf(far));
    expect(looks).toEqual([far.preset]);
    // A camera's own name is no command any more, and a shot without a known camera moves nothing.
    expect(commands.enqueue({ name: far.command, args: {} }).ok).toBe(false);
    commands.enqueue({ name, args: { at: 'nowhere' } });
    commands.deliver({ stepIndex: 2, commands: commands.take(4) } as never);
    behaviour.step(s, { ...ctx, stepIndex: 2 });
    expect(s['at']).toBe(cameras.indexOf(far));
    expect(counters.get('shot_unknown')).toBe(1);
    expect(dropped).toEqual([]);
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

  it('put the reference cameras where they see one brick house at 30, 60, 100 and 150 m: its gable, its ground contact, its front', () => {
    expect(REF_CAMERAS.map((c) => c.name)).toEqual(['ref-30m', 'ref-60m', 'ref-100m', 'ref-150m']);
    const all = [...LIGHTING_CAMERAS, ...LIGHT_CHECK_CAMERAS, ...MANY_LAMP_CAMERAS];
    expect(new Set(all.map((c) => c.command)).size).toBe(all.length);
    for (const c of REF_CAMERAS) expect(all).toContain(c);
    const [x0, , z0] = REF_HOUSE.min;
    const [x1, , z1] = REF_HOUSE.max;
    const mid = [(x0 + x1) / 2, (z0 + z1) / 2];
    // The house: brick walls on its west gable and its front (role wall, material brick: world-kit's MAT.brick 15).
    expect(cellAt(x0 + 0.25, 2.25, -1.75)).toEqual({ material: 15, role: VOXEL_ROLE.wall });
    expect(cellAt(x0 + 1.25, 2.25, z0 + 0.25)).toEqual({ material: 15, role: VOXEL_ROLE.wall });
    REF_CAMERAS.forEach((c, k) => {
      expect(Math.hypot(c.eye[0] - mid[0]!, c.eye[2] - mid[1]!), c.name).toBeCloseTo([30, 60, 100, 150][k]!, 6);
      expect(roleAt(...c.eye), `${c.name}'s eye`).toBe(-1);
      // Looking at the house: its middle straight ahead.
      const [dx, dz] = heading(c.yaw);
      expect(dx * (mid[0]! - c.eye[0]) + dz * (mid[1]! - c.eye[2])).toBeCloseTo(Math.hypot(c.eye[0] - mid[0]!, c.eye[2] - mid[1]!), 6);
      // Clear lines to the west gable's foot and its top, and to the front's foot, from just outside the walls.
      for (const z of [-2.5, -0.5, 1.5]) expect(clearLine(c.eye, [x0 - 0.1, 0.75, z]), `${c.name}: the gable's foot at z ${z}`).toBe(true);
      expect(clearLine(c.eye, [x0 - 0.1, 8.25, 0]), `${c.name}: the gable's top`).toBe(true);
      for (const x of [57, 60.5, 64]) expect(clearLine(c.eye, [x, 0.75, z0 - 0.1]), `${c.name}: the front's foot at x ${x}`).toBe(true);
    });
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
    // The noon and night looks, then the moving sun's day (day-cycle.ts).
    expect(LIGHTING_PRESETS.map((p) => p.presetId)).toEqual([...LIGHT_PRESET_IDS, ...DAY_PRESET_IDS]);
  });
});

describe('the light-shots options', () => {
  it('default to the low tier, every camera, 1280 × 720 on staging', () => {
    const o = parseLightShotsArgs([]);
    expect([o.quality, o.project, o.world, o.origin, o.query, o.viewport.width, o.viewport.height]).toEqual(['low', 'voxel-slice', 'far', 'http://127.0.0.1:4180', '', 1280, 720]);
    expect(o.only).toEqual([...LIGHT_SHOT_NAMES]);
  });
  it('pass a query through and pick cameras by name', () => {
    const o = parseLightShotsArgs(['--quality', 'medium', '--query', '&voxelShadows=off', '--only', 'cave,far-view', '--out', 'x', '--edits', '0']);
    expect([o.quality, o.query, o.only, o.out, o.edits, o.gpu]).toEqual(['medium', '&voxelShadows=off', ['cave', 'far-view'], 'x', 0, false]);
    expect([parseLightShotsArgs(['--gpu']).gpu, parseLightShotsArgs(['--gpu', '--gpu-repeats', '7']).gpuRepeats]).toEqual([true, 7]);
    expect(() => parseLightShotsArgs(['--gpu-repeats', '1'])).toThrow(/--gpu-repeats/);
    expect([parseLightShotsArgs([]).extraLamps, parseLightShotsArgs(['--extra-lamps', '128']).extraLamps]).toEqual([0, 128]);
    expect(() => parseLightShotsArgs(['--extra-lamps', '-1'])).toThrow(/--extra-lamps/);
    expect([parseLightShotsArgs([]).lightTypes, parseLightShotsArgs(['--light-types']).lightTypes]).toEqual([false, true]);
  });
  it('place the light types in the night camera\'s view: a spot aimed down at a front, a panel turned to face the street', () => {
    const eye = LIGHTING_CAMERAS.find((c) => c.name === 'night-lamps')!.eye;
    const [spot, panel] = BENCH_LIGHT_TYPES;
    expect([spot!.light['type'], panel!.light['type'], panel!.light['shape']]).toEqual(['spot', 'area', 'rect']);
    // In front of the camera (it looks along −x), within the light volume's window.
    for (const l of BENCH_LIGHT_TYPES) expect(eye[0] - l.position[0]).toBeGreaterThan(0);
    for (const l of BENCH_LIGHT_TYPES) expect(Math.hypot(l.position[0] - eye[0], l.position[2] - eye[2])).toBeLessThan(44);
    // The spot's axis is a unit way down and toward the fronts at z −24; the panel's turn takes its local −y to +z.
    const d = spot!.light['direction'] as number[];
    expect(Math.hypot(...d)).toBeCloseTo(1, 3);
    expect([d[1]! < -0.5, d[2]! > 0]).toEqual([true, true]);
    const [x, y, z, w] = panel!.rotation!;
    // q (0, −1, 0) q⁻¹ for a unit quaternion: its −y column.
    const face = [-(2 * (x * y - z * w)), -(1 - 2 * (x * x + z * z)), -(2 * (y * z + x * w))];
    expect(face.map((v) => Number(v.toFixed(6)) + 0)).toEqual([0, 0, 1]);
  });
  it('scatter the extra lamps over the night camera\'s window, the same places every run, apart, without shadows', () => {
    const eye = LIGHTING_CAMERAS.find((c) => c.name === 'night-lamps')!.eye;
    const a = benchExtraLamps(128);
    expect(a).toEqual(benchExtraLamps(128));
    expect(benchExtraLamps(32)).toEqual(a.slice(0, 32));
    expect(new Set(a.map((l) => l.name)).size).toBe(128);
    for (const l of a) {
      expect(Math.abs(l.position[0] - eye[0])).toBeLessThanOrEqual(44);
      expect(Math.abs(l.position[2] - eye[2])).toBeLessThanOrEqual(44);
      expect(l.position[1]).toBeGreaterThanOrEqual(1.5);
      expect(l.position[1]).toBeLessThanOrEqual(4.5);
    }
    // Spread over the window: no two closer than 1 m, every quarter of it holding some.
    let least = Infinity;
    for (let i = 0; i < a.length; i++) for (let j = i + 1; j < a.length; j++) least = Math.min(least, Math.hypot(a[i]!.position[0] - a[j]!.position[0], a[i]!.position[2] - a[j]!.position[2]));
    expect(least).toBeGreaterThan(1);
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) expect(a.filter((l) => Math.sign(l.position[0] - eye[0]) === sx && Math.sign(l.position[2] - eye[2]) === sz).length).toBeGreaterThan(16);
    expect(BENCH_EXTRA_LAMP_LIGHT.castShadow).toBe(false);
  });
  it('refuse bad values, naming the option', () => {
    expect(() => parseLightShotsArgs(['--quality', 'ultra'])).toThrow(/--quality/);
    expect(() => parseLightShotsArgs(['--only', 'cellar'])).toThrow(/--only/);
    expect(() => parseLightShotsArgs(['--query', 'voxelShadows=off'])).toThrow(/--query/);
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

  it("time an edit's shadow from the frame its mesh is drawn to the first frame the static map is drawn again", () => {
    // 30 Hz frames; the edit's mesh shows at frame 3 (its record: 40 ms from the edit), the static map at frame 3 too.
    const frames = (meshAt: number, mapAt: number | null): [number, number, number | null][] => Array.from({ length: 10 }, (_, i) => [i * 33.3, i >= meshAt ? 1 : 0, mapAt === null ? 7 : i >= mapAt ? 8 : 7]);
    expect(editShadowTiming(frames(3, 3), 40)).toEqual({ shadowMs: 40, shadowFrames: 0 });
    // Drawn one frame later: one frame's time more.
    const later = editShadowTiming(frames(3, 4), 40);
    expect(later.shadowFrames).toBe(1);
    expect(later.shadowMs).toBeCloseTo(73.3, 6);
    // Never drawn again (no shadow change seen), or no cached map: no reading.
    expect(editShadowTiming(frames(3, null), 40)).toEqual({ shadowMs: null, shadowFrames: null });
    expect(editShadowTiming([], 40)).toEqual({ shadowMs: null, shadowFrames: null });
  });

  it("time a cache edit from the command to its chunk waiting, its first texels written, texels and probes settled", () => {
    // Frames 30 Hz from the command at 0: the chunk waits for charts at frame 2, units stale from 3, texels written from 4, settled at 8, probes at 10.
    const f = (i: number): [number, number, number, number, number, number] => [i * 33.3, i >= 4 ? 1000 + i : 1000, i >= 3 && i < 8 ? 50 : 0, i >= 2 && i < 3 ? 1 : 0, i >= 10 ? 1 : 0, i >= 3 && i < 10 ? 20 : 0];
    const frames = Array.from({ length: 14 }, (_, i) => f(i));
    const t = cacheEditTiming(frames, 0);
    expect(t.reachedMs).toBeCloseTo(66.6, 6);
    expect(t.firstLightMs).toBeCloseTo(133.2, 6);
    expect(t.texelsSettledMs).toBeCloseTo(266.4, 6);
    expect(t.settledMs).toBeCloseTo(333, 6);
    expect(t.texelsWritten).toBe(8);
    // Nothing reached the cache: no reading.
    expect(cacheEditTiming(frames.map((x) => [x[0], 1000, 0, 0, 1, 0] as [number, number, number, number, number, number]), 0)).toEqual({ reachedMs: null, firstLightMs: null, texelsSettledMs: null, settledMs: null, texelsWritten: 0 });
  });

  it('build the lamp wall between the third lamp and the house fronts behind it', () => {
    const lamp = BENCH_LAMPS[2]!.position;
    expect(lamp[2]).toBeLessThan(LAMP_WALL.min[2]);
    expect(LAMP_WALL.max[2]).toBeLessThan(-24);
    expect(LAMP_WALL.min[0]).toBeLessThan(lamp[0]);
    expect(LAMP_WALL.max[0]).toBeGreaterThan(lamp[0]);
    expect(LAMP_WALL.max[1]).toBeGreaterThan(lamp[1]);
  });
});
