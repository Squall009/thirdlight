/**
 * The five fixed cameras every lighting measurement takes its pictures from, on the town inside the 8 km test
 * world (staging's `voxel-slice` project, world `far`; far-world.ts puts the dense town of town.ts at the
 * world's centre, its middle at the origin), and the test content they need that the generated world does not
 * hold: a cave dug into the nearest steep hillside (one `editVoxels` stroke) and street lamps (point lights in
 * the scene). The pictures are compared across items, so everything that moves a picture is fixed here: the
 * pose, the look (an environment preset set at once, a clear sky so drifting clouds do not differ), and the
 * bench pins the render scale (light-shots-cli.ts). The run's own options are parsed here too, so a test can
 * check them without a browser.
 *
 * Engine-owned test data for measuring, not a product feature.
 */

import { dayPresets } from './day-cycle';

/** The pictures' names, fixed (a later item compares files of the same name). */
export const LIGHT_SHOT_NAMES = ['street-noon', 'room-window', 'cave', 'night-lamps', 'far-view'] as const;
/** Checks beside the five, taken only when named (`--only`): a far lamp from two places, two cameras moved 1 m, the lit props' two readings (bench-props.ts). */
export const LIGHT_CHECK_NAMES = ['far-lamp-a', 'far-lamp-b', 'far-view-1m', 'street-noon-1m', 'street-noon-2m', 'room-window-2m', 'props-cart', 'props-table', 'house-60m', 'house-above', 'lroom-above', 'town-100m', 'town-150m', 'town-250m', 'town-600m', 'town-2km', 'ref-30m', 'ref-60m', 'ref-100m', 'ref-150m', 'fog-bank', 'fog-inside'] as const;
/** The many-lamps scene's cameras (`--lamps N`, many-lamps.ts): a street with many lamps at night, a lamp-lit room, a high view over the lit town. */
export const MANY_LAMP_SHOT_NAMES = ['lamps-street', 'lamps-room', 'lamps-high'] as const;
export type LightShotName = (typeof LIGHT_SHOT_NAMES)[number] | (typeof LIGHT_CHECK_NAMES)[number] | (typeof MANY_LAMP_SHOT_NAMES)[number];

/** The looks the cameras use: environment presets the bench writes into the project. */
export const LIGHT_PRESET_IDS = ['bench-noon', 'bench-night'] as const;
export type LightPresetId = (typeof LIGHT_PRESET_IDS)[number];

export interface LightingCamera {
  readonly name: LightShotName;
  /** The debug command that puts the camera there (and sets its look). */
  readonly command: string;
  /** The eye (metres, world). */
  readonly eye: readonly [number, number, number];
  /** Where it looks along the ground: yaw (rad, 0 looks along −z, as the flight's cameras) and pitch (rad, down). */
  readonly yaw: number;
  readonly pitch: number;
  readonly preset: LightPresetId;
  /** Whether the near field (level-0 chunks) must be in the picture: false only for the far view. */
  readonly near: boolean;
  /** What the picture should show (for whoever looks at it). */
  readonly shows: string;
}

/** Yaw of a camera looking along the ground heading (dx, dz). */
export function yawOf(dx: number, dz: number): number {
  return Math.atan2(-dx, -dz);
}

/**
 * The cave: dug into the hillside about 700 m north-west of the town where the ground rises at about 45° (found
 * from the far cache's 2 m ground: 118.7 m at the foot, 148 m 12 m up the slope, 160 m at 24 m). A horizontal
 * tube 6 m across, from 4 m outside the foot to 26 m into the hill along {@link CAVE.into}; at its far end the
 * rock over it is about 20 m thick.
 */
export const CAVE = Object.freeze({
  /** The hillside's foot on the cave's axis (metres). */
  foot: Object.freeze([-406, 118.7, 558] as const),
  /** Into the hill along the ground (unit). */
  into: Object.freeze([-Math.SQRT1_2, Math.SQRT1_2] as const),
  /** The axis's height (metres) and the tube's diameter (metres). */
  axisY: 121.5,
  diameter: 6,
  /** From (negative: outside) and to (metres along `into` from the foot), a dab every `stepM`. */
  fromM: -4,
  toM: 26,
  stepM: 2,
});

/** The cave as one `editVoxels` dig stroke (cells): spheres along its axis. */
export function caveStroke(): { v: 2; grid: 0; kind: 'brush'; shape: 'sphere'; size: [number, number, number]; points: number[]; mode: 'dig'; smooth: false } {
  const points: number[] = [];
  for (let m = CAVE.fromM; m <= CAVE.toM; m += CAVE.stepM) {
    points.push(Math.round((CAVE.foot[0] + CAVE.into[0] * m) * 2), Math.round(CAVE.axisY * 2), Math.round((CAVE.foot[2] + CAVE.into[1] * m) * 2));
  }
  const d = CAVE.diameter * 2;
  return { v: 2, grid: 0, kind: 'brush', shape: 'sphere', size: [d, d, d], points, mode: 'dig', smooth: false };
}

/**
 * The fog bank: a hollow dug into the town's one empty lot beside the room camera's house (lot (5, 6): x −28 … −8 m,
 * z −8 … 12 m, flat grass with no house, fence or pond) by three overlapping balls 12 m across, their middles a metre
 * or more over the ground (a bowl about 13 m wide and 5 m deep with an uneven rim), filled with the bench's mist by
 * one `flood` stroke from its floor to half a metre under the lot's ground, thinning over the top 1.5 m. Bench data:
 * placed for the fog cameras and taken out after (bench-fog.ts).
 */
export const FOG_HOLLOW = Object.freeze({
  /** The balls' middles (metres) and their diameter (metres). */
  dabs: Object.freeze([[-20.5, 1, 1.5], [-16, 1, 3.5], [-18.5, 1.5, -1.5]] as const),
  diameter: 12,
  /** Where the flood starts (metres: an open cell near the floor), its level (metres), reach (metres) and fade (metres). */
  seed: Object.freeze([-18.5, -2.5, 1] as const),
  level: -0.5,
  reach: 10,
  fade: 1.5,
});

/**
 * The town's streets used here: the gap between the house rows of lots j = 4 and j = 5 (town.ts: 20 m lots,
 * houses 8 cells into a lot), from z −31.5 m (the backs of row 4) to −24 m (the fronts of row 5, their doors
 * facing it), fences 1 m tall at the lots' edges.
 */
const STREET_Z = -28;

/** The street lamps (point lights, warm, 3 m up beside the house fronts and the fences), the night camera's view. */
export const BENCH_LAMPS: ReadonlyArray<{ readonly name: string; readonly position: readonly [number, number, number] }> = Object.freeze(
  [32, 20, 8, -4, -16].map((x, i) => Object.freeze({ name: `Bench lamp ${i + 1}`, position: Object.freeze([x, 3, i % 2 === 0 ? -25.5 : -30] as const) })),
);
/** The lamps' light (the night preset sets their intensity; noon turns them off). */
export const BENCH_LAMP_LIGHT = Object.freeze({ type: 'point', color: '#ffc27a', intensity: 1, range: 14, decay: 2, castShadow: true });
export const BENCH_LAMP_NIGHT_CD = 60;

/** Metres round the night camera's eye (across and along) the bench's extra lamps are scattered over: the light volume's 0.5 m window (±48 m) less a margin. */
const EXTRA_LAMP_SPREAD_M = 44;

/**
 * `--extra-lamps N`: N more point lamps (bench data, placed before Play and taken out after, as the street lamps are),
 * scattered over the night camera's window by a fixed sequence (the same places every run), 1.5–4.5 m up, the street
 * lamps' light without a shadow (their atlas tiles are not what a lamp count measures). For the light volume's cost
 * with many lamps; the night preset lights them with the street lamps.
 */
export function benchExtraLamps(n: number): ReadonlyArray<{ readonly name: string; readonly position: readonly [number, number, number] }> {
  const eye = LIGHTING_CAMERAS.find((c) => c.name === 'night-lamps')!.eye;
  const out: Array<{ name: string; position: readonly [number, number, number] }> = [];
  for (let i = 0; i < n; i++) {
    // The plastic sequence (an even scatter without a grid's rows): each lamp's x, z and height from its index.
    const u = (0.5 + i * 0.819172513) % 1;
    const v = (0.5 + i * 0.671043607) % 1;
    const w = (0.5 + i * 0.549700478) % 1;
    out.push({ name: `Bench extra lamp ${i + 1}`, position: [eye[0] + (2 * u - 1) * EXTRA_LAMP_SPREAD_M, 1.5 + 3 * w, eye[2] + (2 * v - 1) * EXTRA_LAMP_SPREAD_M] });
  }
  return out;
}
export const BENCH_EXTRA_LAMP_LIGHT = Object.freeze({ ...BENCH_LAMP_LIGHT, castShadow: false });

/**
 * `--light-types`: one spot and one rect area light in the night camera's view (bench data, placed before Play and
 * taken out after, as the street lamps are; no shadow maps: the light volume walks its own shadows): a cool spot 5 m up
 * and 2.5 m out from the house front left of the street at x 20, aimed down at it (30°, a soft edge of 0.3), and a warm
 * 2 × 1 m panel 3 m up against the back of the house right of the street at x 38, facing the street (turned −90° about
 * x: an area light faces its local −y). A look sets point lights only, so they shine at noon too.
 */
export const BENCH_LIGHT_TYPES: ReadonlyArray<{ readonly name: string; readonly position: readonly [number, number, number]; readonly rotation?: readonly [number, number, number, number]; readonly light: Readonly<Record<string, unknown>> }> = Object.freeze([
  { name: 'Bench spot', position: [20, 5, -26.5], light: { type: 'spot', color: '#bfe0ff', intensity: 150, range: 12, decay: 2, angle: 30, penumbra: 0.3, direction: [0, -0.8137, 0.5812], castShadow: false } },
  { name: 'Bench panel', position: [38, 3, -31.3], rotation: [-Math.SQRT1_2, 0, 0, Math.SQRT1_2], light: { type: 'area', shape: 'rect', width: 2, height: 1, color: '#ffd9a8', intensity: 150, range: 10, castShadow: false } },
] as const);

/**
 * `--glow`: two glowing materials (bench data, made before Play and deleted after): an orange lava, an instance of the
 * town's rock (its texture set, glowing, strength 4), and a cyan crystal (strength 1.5, so its texture shows), an instance of its plaster, each with a voxel id the
 * world does not use. Painted at run time by the camera's behaviour ({@link GLOW_COMMANDS}: `ctx.voxels`, never
 * written to the world's files): at the night camera a lava strip 6 × 0.5 m in the ground 1–7 m ahead, a crystal block on the
 * fence's top rail right of the street and a 2 × 2 m crystal panel on the house front right of it; in the room
 * camera's room a lava strip along the floor at the foot of its window wall.
 */
export const BENCH_GLOW_MATERIALS = Object.freeze([
  Object.freeze({ materialId: 'bench-lava', name: 'Bench lava', shader: 'standard', instanceOf: 'voxel-rock', params: { color: '#ffffff', emissive: '#ff5a14', emissiveIntensity: 4 }, textures: {}, voxel: { id: 4001, use: 'terrain' } }),
  Object.freeze({ materialId: 'bench-crystal', name: 'Bench crystal', shader: 'standard', instanceOf: 'voxel-plaster', params: { color: '#ffffff', emissive: '#3fe0ff', emissiveIntensity: 1.5 }, textures: {}, voxel: { id: 4002, use: 'construction' } }),
]);
/**
 * `--glow`'s masked lava (bench data, made before Play and removed after): the lava's glow on the town's rock whose ORM
 * map carries a crack mask in its alpha (`crackGlowMask`, about 27 % of the tile's glow), an ORM texture the bench
 * writes from the rock's own (its RGB as stored) into {@link BENCH_GLOW_MASK_FOLDER} and imports as any texture. Painted
 * beside each lava strip ({@link GLOW_COMMANDS}), so one picture shows the cracks against the whole glow.
 */
export const BENCH_GLOW_MASK_FOLDER = 'assets/bench-glow-mask';
export const BENCH_GLOW_MASK_FILE = 'bench-lava-cracks-orm.png';
export function benchMaskedLava(ormAssetId: string): { readonly materialId: string; readonly voxel: { readonly id: number; readonly use: string; readonly surfaces: { readonly wall: { readonly orm: string } } } } & Readonly<Record<string, unknown>> {
  const lava = BENCH_GLOW_MATERIALS[0]!;
  return { materialId: 'bench-lava-cracked', name: 'Bench lava (cracks)', shader: 'standard', instanceOf: lava.instanceOf, params: { ...lava.params }, textures: {}, voxel: { id: 4003, use: 'terrain', surfaces: { wall: { orm: ormAssetId } } } };
}
/** Added to the night strip's ground height in cm as the behaviour counts it (a counter of 0 reads as never set). */
export const GLOW_GROUND_CM_OFFSET = 100_000;
/** The masked lava's voxel id (the behaviour paints it when the world has it). */
const LAVA_MASKED_ID = 4003;

/** Where the glow scene's cells are read for their blotch (`cellBlotch` ±4 m round it): by the fence's block and the night strip, by the room's strip. */
export const GLOW_PROBES: Readonly<Record<string, readonly [number, number, number]>> = Object.freeze({ 'night-lamps': [40, 1, -29.5], 'room-window': [-3.5, 1.5, 1] });
/** The behaviour's glow commands: everything painted; the night strip painted back to the ground's own and painted again. */
export const GLOW_COMMANDS = Object.freeze({ night: 'glow_night', room: 'glow_room', stripOff: 'glow_strip_off', stripOn: 'glow_strip_on' });

/** The house the room camera stands in: lot (6, 6), two storeys, x −5…5 m, z −4…6 m, windows in its west wall at 1–2 m. */
export const ROOM_HOUSE = Object.freeze({ min: Object.freeze([-5, 0.5, -4] as const), max: Object.freeze([5, 3, 6] as const) });

export const LIGHTING_CAMERAS: readonly LightingCamera[] = Object.freeze([
  { name: 'street-noon', command: 'shot1', eye: [-40, 1.7, STREET_Z], yaw: yawOf(1, 0), pitch: 0.05, preset: 'bench-noon', near: true, shows: 'the street between two house rows at noon: house fronts with doors and windows, fences, ground, sky' },
  { name: 'room-window', command: 'shot2', eye: [3, 1.8, 1], yaw: yawOf(-1, 0.15), pitch: 0.05, preset: 'bench-noon', near: true, shows: 'inside the centre house (ground floor), looking at its west wall with three windows (the sun side), the stairs and the room round it' },
  { name: 'cave', command: 'shot3', eye: [CAVE.foot[0] + CAVE.into[0] * 22, CAVE.axisY - 0.5, CAVE.foot[2] + CAVE.into[1] * 22], yaw: yawOf(-CAVE.into[0], -CAVE.into[1]), pitch: 0.02, preset: 'bench-noon', near: true, shows: 'deep in the dug cave looking out: the tube walls and the bright mouth' },
  { name: 'night-lamps', command: 'shot4', eye: [44, 1.7, STREET_Z], yaw: yawOf(-1, 0), pitch: 0.05, preset: 'bench-night', near: true, shows: 'the same street at night, five warm lamps lighting the house fronts, fences and ground' },
  { name: 'far-view', command: 'shot5', eye: [140, 40, 10], yaw: yawOf(-1, 0.05), pitch: 0.1, preset: 'bench-noon', near: false, shows: 'from over the town’s east edge across the town to the western massif' },
] satisfies LightingCamera[]);

/**
 * The far lamp: a lamp 2 m out from the cave's hillside at its foot (a rock face the far field draws from 230 m),
 * brighter and wider than the street's so its patch shows from there; only placed when a far-lamp camera is named.
 */
export const FAR_CHECK_LAMP = Object.freeze({ name: 'Bench far lamp', position: Object.freeze([CAVE.foot[0] - CAVE.into[0] * 2, CAVE.foot[1] + 2, CAVE.foot[2] - CAVE.into[1] * 2] as const) });
export const FAR_CHECK_LAMP_LIGHT = Object.freeze({ ...BENCH_LAMP_LIGHT, range: 20, intensity: 1 });
/** A camera `out` metres out from the far lamp along the valley (away from the hill), `side` metres across, 20 m over it, looking at it. */
function farLampCamera(name: 'far-lamp-a' | 'far-lamp-b', command: string, side: number): LightingCamera {
  const [lx, ly, lz] = FAR_CHECK_LAMP.position;
  const out = 230;
  const eye: [number, number, number] = [lx - CAVE.into[0] * out + CAVE.into[1] * side, ly + 20, lz - CAVE.into[1] * out - CAVE.into[0] * side];
  const d = Math.hypot(lx - eye[0], lz - eye[2]);
  return { name, command, eye, yaw: yawOf(lx - eye[0], lz - eye[2]), pitch: Math.atan2(eye[1] - ly, d), preset: 'bench-night', near: false, shows: 'at night, a lamp 2 m before the cave hillside, drawn by the far field from 230 m' };
}
/**
 * The reference cameras: one brick house of the town (lot (9, 6): two storeys, x 55–66 m, z −4–4 m, its west gable
 * lit by the noon sun) and its neighbours from the south-west along one bearing at 30, 60, 100 and 150 m, each eye as
 * low as the town lets it see over the houses between to that house's west gable, its ground contact and its brick
 * front (found by a sight-line search over town.ts's houses; the test marches the town's cells), looking at its first
 * storey. Taken on the town as generated: nothing is dug for them.
 */
export const REF_HOUSE = Object.freeze({ min: Object.freeze([55, 0, -4] as const), max: Object.freeze([66, 10.5, 4] as const) });
/** The bearing from the house's middle to the eyes (rad, x toward z: south-west), and the height the cameras look at. */
const REF_BEARING = (-145 * Math.PI) / 180;
const REF_LOOK_Y = 3;
function refCamera(name: 'ref-30m' | 'ref-60m' | 'ref-100m' | 'ref-150m', command: string, d: number, up: number): LightingCamera {
  const mx = (REF_HOUSE.min[0] + REF_HOUSE.max[0]) / 2;
  const mz = (REF_HOUSE.min[2] + REF_HOUSE.max[2]) / 2;
  const eye: [number, number, number] = [mx + d * Math.cos(REF_BEARING), up, mz + d * Math.sin(REF_BEARING)];
  return { name, command, eye, yaw: yawOf(mx - eye[0], mz - eye[2]), pitch: Math.atan2(up - REF_LOOK_Y, d), preset: 'bench-noon', near: true, shows: `at noon, the brick house of lot (9, 6) and its neighbours from ${d} m south-west and ${up} m up: its west gable, its ground contact, its front` };
}
export const REF_CAMERAS: readonly LightingCamera[] = Object.freeze([refCamera('ref-30m', 'shot25', 30, 1.7), refCamera('ref-60m', 'shot26', 60, 8), refCamera('ref-100m', 'shot27', 100, 16), refCamera('ref-150m', 'shot28', 150, 30)]);
const moved = (c: LightingCamera, name: 'far-view-1m' | 'street-noon-1m' | 'street-noon-2m' | 'room-window-2m', command: string, by = 1): LightingCamera => ({ ...c, name, command, eye: [c.eye[0] + by, c.eye[1], c.eye[2]] });
/** The checks' cameras (LIGHT_CHECK_NAMES): the far lamp from two places 60 m apart, far view and street moved 1 m, street and room moved 2 m (a camera-following store's step), the reference cameras. */
export const LIGHT_CHECK_CAMERAS: readonly LightingCamera[] = Object.freeze([
  farLampCamera('far-lamp-a', 'shot6', 30),
  farLampCamera('far-lamp-b', 'shot7', -30),
  moved(LIGHTING_CAMERAS[4]!, 'far-view-1m', 'shot8'),
  moved(LIGHTING_CAMERAS[0]!, 'street-noon-1m', 'shot9'),
  moved(LIGHTING_CAMERAS[0]!, 'street-noon-2m', 'shot10', 2),
  moved(LIGHTING_CAMERAS[1]!, 'room-window-2m', 'shot11', 2),
  // The lit props' readings (bench-props.ts PROP_READINGS): the cart east of the third street lamp at night, from across
  // the street, and the table by the room camera's window wall at noon, from the room's middle.
  { name: 'props-cart', command: 'shot15', eye: [18, 3.2, -27.2], yaw: yawOf(-5.5, 1.7), pitch: 0.5, preset: 'bench-night', near: true, shows: 'at night, the bench cart beside the third street lamp and the ground east of it in its shade' },
  // Rooms: a house's fronts 60 m away from 40 m up across the street (the light indoors seen through windows past the
  // volume's finer windows); the room camera's house from 18 m over its south side, and the L-shaped room the rooms
  // bench builds (bench-rooms.ts) from 14 m over it, at noon: see-through and cut-away round the bench subject.
  { name: 'house-60m', command: 'shot17', eye: [0, 40, -80], yaw: yawOf(0, 1), pitch: Math.atan2(35, 56), preset: 'bench-noon', near: true, shows: 'at noon, from 40 m up across the street the fronts of the row past it, about 60 m away, and their windows' },
  { name: 'house-above', command: 'shot18', eye: [0, 18, 10], yaw: yawOf(0, -1), pitch: Math.atan2(18, 9), preset: 'bench-noon', near: true, shows: 'at noon, the room camera’s house from 18 m over its south side: its roof, or with cut-away its ground floor round the bench subject' },
  { name: 'lroom-above', command: 'shot19', eye: [37, 38, 0], yaw: yawOf(0, -1), pitch: Math.atan2(13, 11), preset: 'bench-noon', near: true, shows: 'at noon, the floating L-shaped room and the brick-roofed hut in its notch from 14 m over them' },
  // The town's middle from the east at a distance and a fifth of it up again (about 19° down), at noon: what draws a
  // house there (100 m and 150 m: the mesh rings; past them the far field's bricks).
  ...([['town-100m', 'shot20', 100], ['town-150m', 'shot21', 150], ['town-250m', 'shot22', 250], ['town-600m', 'shot23', 600], ['town-2km', 'shot24', 2000]] as const).map(([name, command, d]): LightingCamera => ({ name, command, eye: [d, 4 + d * 0.35, 0], yaw: yawOf(-1, 0), pitch: Math.atan2(d * 0.35, d), preset: 'bench-noon', near: d <= 150, shows: `at noon, the town's middle from ${d} m east and ${Math.round(d * 0.35)} m up: its houses as the ${d <= 150 ? 'mesh rings' : 'far field'} draw them` })),
  ...REF_CAMERAS,
  // The fog bank (FOG_HOLLOW) at noon: from 17 m south-east of the hollow and 6 m up, looking down into it; and from
  // inside it, 1.7 m over its floor and 2.8 m under the fog's top, looking east and up (about 29°) at its rim and the sky:
  // toward the top of the picture a view ray leaves the bank sooner, so the mist thins upward.
  { name: 'fog-bank', command: 'shot29', eye: [-6.5, 6, 14], yaw: yawOf(-12, -13), pitch: Math.atan2(6.5, Math.hypot(12, 13)), preset: 'bench-noon', near: true, shows: 'at noon, a hollow in an empty lot filled with mist to just under its rim, from 17 m off and 6 m up: the bank\'s surface, where it meets the hollow\'s sides, the grass and houses round it' },
  { name: 'fog-inside', command: 'shot30', eye: [-18.5, -3.3, 1], yaw: yawOf(1, 0.2), pitch: -0.5, preset: 'bench-noon', near: true, shows: 'at noon, from inside the same bank, 1.7 m over the hollow\'s floor, looking up at its rim: the houses beyond and the sky through the mist, thinner toward the top of the picture' },
  { name: 'props-table', command: 'shot16', eye: [0.5, 1.9, 3.5], yaw: yawOf(-3.9, -2.7), pitch: 0.3, preset: 'bench-noon', near: true, shows: 'at noon, the bench table under the room camera’s window wall and the floor under it' },
]);

/**
 * The many-lamps scene's cameras, at night: along the street in front of the room camera's house (its lamps on the
 * fronts' side 2.25 m in from the lot line at z −8, on the backs' side 1.25 m out), inside that house's ground floor
 * looking at its west wall with its room lamp 3 m ahead, and from 45 m up south-east of the town's middle down over it.
 */
export const MANY_LAMP_CAMERAS: readonly LightingCamera[] = Object.freeze([
  { name: 'lamps-street', command: 'shot12', eye: [-36, 1.7, -6.5], yaw: yawOf(1, 0), pitch: 0.05, preset: 'bench-night', near: true, shows: 'a street at night lit by many lamps: street lamps both sides, spots under the eaves, panels over the doors, fence lines, glowing strips' },
  { name: 'lamps-room', command: 'shot13', eye: [3, 1.8, 1], yaw: yawOf(-1, 0.15), pitch: 0.05, preset: 'bench-night', near: true, shows: 'the room camera’s room at night, lit by its room lamp (3 m ahead, 2.25 m up) and what comes in through its windows' },
  { name: 'lamps-high', command: 'shot14', eye: [70, 45, 50], yaw: yawOf(-70, -56), pitch: Math.atan2(45, Math.hypot(70, 56)), preset: 'bench-night', near: true, shows: 'from 45 m up over the town at night: the lamps of many streets and houses' },
] satisfies LightingCamera[]);

/** Runtime edits for the edit-to-screen time: a 1 m ball dug in the street in front of the street camera, each its own command. */
export const EDIT_DIGS: ReadonlyArray<{ readonly command: string; readonly center: readonly [number, number, number] }> = Object.freeze(
  [0, 1, 2].map((i) => Object.freeze({ command: `dig${i + 1}`, center: Object.freeze([-30 + 3 * i, 0, STREET_Z] as const) })),
);
export const EDIT_DIG_RADIUS_M = 1;

/**
 * A wall the cache's edit timing builds at night between the third street lamp ({@link BENCH_LAMPS}, 3 m up at
 * x 8, z −25.5) and the house fronts of row 5 behind it (their faces at z −24): 4 m wide, 5 m tall and a cell
 * thick, 0.5 m in front of the fronts, so the fronts' lamp-lit patch round x 8 goes dark; dug again after.
 */
export const LAMP_WALL = Object.freeze({ min: Object.freeze([6, 0, -25] as const), max: Object.freeze([10, 5, -24.5] as const) });
/** The debug commands that build and dig the lamp wall, and the camera it is timed from. */
export const LAMP_WALL_COMMANDS = Object.freeze({ build: 'lamp_wall', dig: 'lamp_unwall', camera: 'night-lamps' as LightShotName });

/** A clear physical sky (no clouds: they drift, so two runs' skies would differ). */
const CLEAR_SKY = Object.freeze({ mode: 'procedural', environmentIntensity: 0.1, cloudCoverage: 0 });

/**
 * The looks: noon (the scene's sun high from the south-west, lamps off) and night (no sun, dim blue ambient, lamps on),
 * and the moving sun's day (day-cycle.ts: noon's look with the key light along a day's arc).
 */
export const LIGHTING_PRESETS = Object.freeze([
  {
    presetId: 'bench-noon',
    name: 'Bench noon',
    sky: CLEAR_SKY,
    lights: [
      { type: 'directional', color: '#ffffff', intensity: 1.2, direction: [0.4, -1, -0.3] },
      { type: 'ambient', color: '#8090a8', intensity: 0.6 },
      { type: 'point', intensity: 0 },
    ],
  },
  {
    presetId: 'bench-night',
    name: 'Bench night',
    sky: CLEAR_SKY,
    lights: [
      // The sun under the horizon (the physical sky follows the key light) and off.
      { type: 'directional', color: '#8899ff', intensity: 0, direction: [0.4, 0.3, -0.3] },
      { type: 'ambient', color: '#405070', intensity: 0.08 },
      { type: 'point', intensity: BENCH_LAMP_NIGHT_CD },
    ],
  },
  ...dayPresets(CLEAR_SKY),
]);

/** The debug command that moves the bench camera: its `at` argument is a camera's `command` name. */
export const SHOT_COMMAND = 'shot';

/** The call that puts the bench camera at `cam` (a `PlayGame.debug` call's name and arguments). */
export const shotCall = (cam: { readonly command: string }): readonly [string, { readonly at: string }] => [SHOT_COMMAND, { at: cam.command }];

/**
 * The camera's behaviour: the shot command puts the camera at its pose and its look on at once, every step
 * after holds it there; each dig command digs its ball through `ctx.voxels` (a runtime edit: never written to
 * the world's files).
 */
export function lightShotsSource(cameras: readonly LightingCamera[] = [...LIGHTING_CAMERAS, ...LIGHT_CHECK_CAMERAS, ...MANY_LAMP_CAMERAS], extras: ReadonlyArray<{ head: string; intent: string }> = [], glowMask = true): string {
  return `
${extras.map((e) => e.head).join('\n')}
const SHOTS = ${JSON.stringify(cameras.map((c) => ({ command: c.command, eye: c.eye, yaw: c.yaw, pitch: c.pitch, preset: c.preset })))};
const DIGS = ${JSON.stringify(EDIT_DIGS)};
const LAMP = ${JSON.stringify(BENCH_LAMPS[2]!.position)};
const LAMP_WALL = ${JSON.stringify(LAMP_WALL)};
const LAVA = ${BENCH_GLOW_MATERIALS[0]!.voxel.id};
const CRYSTAL = ${BENCH_GLOW_MATERIALS[1]!.voxel.id};
const LAVA_MASKED = ${glowMask ? LAVA_MASKED_ID : 0};
const GROUND_CM_OFFSET = ${GLOW_GROUND_CM_OFFSET};
const quat = (yaw: number, pitch: number) => { const cy = Math.cos(yaw / 2), sy = Math.sin(yaw / 2), cp = Math.cos(-pitch / 2), sp = Math.sin(-pitch / 2); return [cy * sp, sy * cp, -sy * sp, cy * cp]; };
export default {
  prepare() { return {}; },
  instantiate() { return { at: 0, wallDug: -1, wasEnclosed: 0, strip: null, stripWas: 0 }; },
  step(s: any, ctx: any) {
    if (ctx.phase === 'intent') {
      // One command for every camera, the camera its argument: a command a camera would pass the game's limit of
      // declared commands, and the commands declared after them (the digs, the walls) would not exist.
      for (const call of ctx.debug.command('${SHOT_COMMAND}', { args: [{ name: 'at', type: 'string' }] })) {
        const i = SHOTS.findIndex((shot: any) => shot.command === call.at);
        if (i >= 0) { s.at = i; ctx.environment?.set(SHOTS[i].preset); }
        else ctx.game.add('shot_unknown', 1);
      }
      // The open region at the camera's eye, each step (gauges: a counter set to the value).
      const v = ctx.voxels;
      const put = (n: string, x: number) => ctx.game.add(n, x - ctx.game.counter(n));
      const eye = SHOTS[s.at].eye;
      const r = v?.regionAt(eye[0], eye[1], eye[2]) ?? null;
      put('region_known', r === null ? 0 : 1); put('region_enclosed', r?.enclosed ? 1 : 0); put('region_volume', r === null ? 0 : Math.round(r.volume));
      put('region_sky', r?.sky ? 1 : 0); put('region_portals', r?.portals ?? 0); put('region_id', r?.id ?? 0);
      ${extras.map((e) => e.intent).join('\n')}
      // A hole dug through the wall the camera looks at (found by a ray): the steps until the eye's region changes.
      for (const _ of ctx.debug.command('region_dig')) {
        const yaw = SHOTS[s.at].yaw;
        const hit = v?.raycast(eye, [-Math.sin(yaw), 0, -Math.cos(yaw)], 30) ?? null;
        const d = hit === null ? undefined : v.dig({ center: hit.at, radius: 1 });
        s.wallDug = d !== undefined && d.ok ? ctx.stepIndex : -1;
        s.wasEnclosed = r?.enclosed ? 1 : 0;
        ctx.game.add(s.wallDug >= 0 ? 'region_dug' : 'region_dig_refused', 1);
      }
      if (s.wallDug >= 0 && (r === null || (r.enclosed ? 1 : 0) !== s.wasEnclosed)) { put('region_edit_steps', ctx.stepIndex - s.wallDug); s.wallDug = -1; }
      // The lamp wall: built of the house front's own voxel (a ray from the lamp toward it), else the ground's under the lamp.
      for (const _ of ctx.debug.command('${LAMP_WALL_COMMANDS.build}')) {
        const rec = v?.raycast(LAMP, [0, 0, 1], 8)?.voxel ?? v?.raycast(LAMP, [0, -1, 0], 8)?.voxel ?? null;
        const ok = rec !== null && v.set(LAMP_WALL, { material: rec.material, role: rec.role }).ok;
        ctx.game.add(ok ? 'lamp_walls' : rec === null ? 'lamp_wall_nohit' : 'lamp_wall_refused', 1);
      }
      for (const _ of ctx.debug.command('${LAMP_WALL_COMMANDS.dig}')) ctx.game.add(v?.dig(LAMP_WALL).ok ? 'lamp_unwalls' : 'lamp_wall_refused', 1);
      // The glow scene (--glow): found by rays, painted with the bench's glowing materials; each part counted.
      for (const _ of ctx.debug.command('${GLOW_COMMANDS.night}')) {
        const g = v?.raycast([40, 6, -28.25], [0, -1, 0], 12) ?? null;
        if (g !== null && g.voxel !== null) {
          const gy = g.point[1];
          s.strip = { min: [37, gy - 0.5, -28.5], max: [43, gy, -28] };
          s.stripWas = g.voxel.material;
          if (v.paint(s.strip, { material: LAVA }).ok) ctx.game.add('glow_strip', 1);
          // The masked lava beside it, 0.5 m to the street's left (a world without that material refuses it: not counted).
          if (LAVA_MASKED > 0 && v.paint({ min: [37, gy - 0.5, -27.5], max: [43, gy, -27] }, { material: LAVA_MASKED }).ok) ctx.game.add('glow_masked_strip', 1);
          ctx.game.add('glow_ground_cm', GROUND_CM_OFFSET + Math.round(gy * 100));
          for (const z of [-28.75, -29.25, -29.75, -30.25, -30.75, -31.25]) {
            const h = v.raycast([40.25, gy + 3, z], [0, -1, 0], 6);
            if (h === null || h.voxel === null || h.point[1] < gy + 0.6) continue;
            if (v.set({ at: [h.at[0], h.at[1] + 0.5, h.at[2]] }, { material: CRYSTAL, role: h.voxel.role }).ok) ctx.game.add('glow_block', 1);
            break;
          }
          for (const x of [36, 30, 24]) {
            const p = v.raycast([x, gy + 2, -28], [0, 0, -1], 10);
            if (p === null || p.voxel === null || p.normal[2] !== 1) continue;
            if (v.paint({ min: [x - 1, gy + 1, p.at[2] - 0.25], max: [x + 1, gy + 3, p.at[2] + 0.25] }, { material: CRYSTAL }).ok) ctx.game.add('glow_panel', 1);
            break;
          }
        }
        ctx.game.add('glow_night', 1);
      }
      for (const _ of ctx.debug.command('${GLOW_COMMANDS.room}')) {
        const room = SHOTS[1].eye;
        const floor = v?.raycast(room, [0, -1, 0], 4) ?? null;
        // The wall at the floor's height (the eye's height looks out of a window).
        const wall = floor === null ? null : v.raycast([room[0], floor.point[1] + 0.25, room[2]], [-1, 0, 0], 12);
        if (wall !== null && floor !== null && v.paint({ min: [wall.at[0] + 0.25, floor.point[1] - 0.5, room[2] - 3], max: [wall.at[0] + 0.75, floor.point[1], room[2] + 3] }, { material: LAVA }).ok) ctx.game.add('glow_room_strip', 1);
        // The masked lava 1 m into the room from it, along it.
        if (LAVA_MASKED > 0 && wall !== null && floor !== null && v.paint({ min: [wall.at[0] + 1.25, floor.point[1] - 0.5, room[2] - 3], max: [wall.at[0] + 1.75, floor.point[1], room[2] + 3] }, { material: LAVA_MASKED }).ok) ctx.game.add('glow_room_masked_strip', 1);
        ctx.game.add('glow_room', 1);
      }
      for (const _ of ctx.debug.command('${GLOW_COMMANDS.stripOff}')) ctx.game.add(s.strip !== null && v.paint(s.strip, { material: s.stripWas }).ok ? 'glow_strip_offs' : 'glow_refused', 1);
      for (const _ of ctx.debug.command('${GLOW_COMMANDS.stripOn}')) ctx.game.add(s.strip !== null && v.paint(s.strip, { material: LAVA }).ok ? 'glow_strip_ons' : 'glow_refused', 1);
      for (const d of DIGS) for (const _ of ctx.debug.command(d.command)) {
        const r = ctx.voxels?.dig({ center: d.center, radius: ${EDIT_DIG_RADIUS_M} });
        ctx.game.add('light_digs', 1);
        if (r === undefined || !r.ok) ctx.game.add('light_dig_refused', 1);
      }
      return;
    }
    if (ctx.phase !== 'transform') return;
    const shot = SHOTS[s.at];
    ctx.emit({ kind: 'transform', entityId: ctx.entityId, position: { x: shot.eye[0], y: shot.eye[1], z: shot.eye[2] }, quaternion: quat(shot.yaw, shot.pitch) });
  },
  dispose() {},
};
`;
}

export interface LightShotsOptions {
  readonly origin: string;
  readonly tokenFile: string | null;
  readonly project: string;
  readonly world: string;
  readonly quality: 'low' | 'medium' | 'high';
  readonly out: string | null;
  /** More of the editor page's query (Play is passed its flags): how a later item picks a lighting arrangement. */
  readonly query: string;
  readonly only: readonly LightShotName[];
  /** Seconds the counts must hold still, and the most a camera waits for that. */
  readonly holdS: number;
  readonly timeoutS: number;
  /** Runtime digs timed to the screen after the shots (0: none). */
  readonly edits: number;
  /** `--gpu`: the page's GPU measurement at each camera (ms per pass category), with its interleaved repeats. */
  readonly gpu: boolean;
  readonly gpuRepeats: number;
  /** `--gpu-only LIST`: only these categories (default every one present). */
  readonly gpuOnly: readonly string[] | null;
  /** `--gpu-at LIST`: the GPU measurement at these cameras only (null: at every camera shot). */
  readonly gpuAt: readonly string[] | null;
  /** `--gpu-stale`: a second GPU measurement at each camera while the light volume has work (every brick kept stale). */
  readonly gpuStale: boolean;
  /** `--cache-edits`: the lighting store's edit → light times (a window dug at the room camera; a wall built and dug between a lamp and the fronts at night). */
  readonly cacheEdits: boolean;
  /** `--arrival-shots`: pictures 2 s and 10 s after each camera's move, before anything settles (what a player sees meanwhile). */
  readonly arrivalShots: boolean;
  /** `--light-out`: the light volume's light taken out of the scene's lights before the GPU measurement (what its node costs the lit programs). */
  readonly lightOut: boolean;
  /** The store set on the page after it loads, with the texture-unit guard's record kept in each shot; null: none. */
  readonly textureUnits: 'off' | 'volume' | null;
  /** `--extra-lamps N`: N more point lamps over the night camera's window ({@link benchExtraLamps}; 0: none). */
  readonly extraLamps: number;
  /** `--light-types`: the spot and the area light of {@link BENCH_LIGHT_TYPES} placed too. */
  readonly lightTypes: boolean;
  /** `--glow`: the glowing materials of {@link BENCH_GLOW_MATERIALS} made and painted ({@link GLOW_COMMANDS}) once Play runs. */
  readonly glow: boolean;
  /** With `--glow`: the masked lava ({@link benchMaskedLava}) too (`--no-glow-mask`: not made nor painted, the glow scene as before it). */
  readonly glowMask: boolean;
  readonly freshCells: boolean;
  /** `--arrival-at LIST`: with `--arrival-shots`, the seconds after each move its pictures are taken at (default 2, 10). */
  readonly arrivalAt: readonly number[];
  /** `--auto-exposure`: the camera adapts its exposure (as a game runs it) instead of the look's fixed exposure. */
  readonly autoExposure: boolean;
  /** `--reference FILE`: at each camera, the light volume's room cells against the CPU reference's variants in FILE (JSON `{ variants }`); null: none. */
  readonly reference: string | null;
  /** `--day slow|fast`: after the shots, the sun moving (day-cycle.ts) at the cameras of `dayAt`, for `dayForS`, with `dayReference`'s variants; null: none. */
  readonly day: 'slow' | 'fast' | null;
  readonly dayAt: readonly LightShotName[];
  readonly dayForS: number;
  readonly dayReference: string | null;
  /** `--refine-wait S`: at the first camera, after it settles, up to S s for the light volume to have refined every brick (Play start → fully refined); 0: none. */
  readonly refineWaitS: number;
  readonly viewport: { readonly width: number; readonly height: number };
}

/** The bench's options from its arguments (throws on a bad one, naming it). */
export function parseLightShotsArgs(argv: readonly string[]): LightShotsOptions {
  const arg = (name: string): string | null => {
    const i = argv.indexOf(`--${name}`);
    if (i < 0) return null;
    const v = argv[i + 1];
    if (v === undefined || v.startsWith('--')) throw new Error(`--${name} needs a value`);
    return v;
  };
  const num = (name: string, fallback: number, min: number, max: number): number => {
    const v = arg(name);
    if (v === null) return fallback;
    const n = Number(v);
    if (!Number.isFinite(n) || n < min || n > max) throw new Error(`--${name}: a number in [${min}, ${max}], not ${v}`);
    return n;
  };
  const quality = arg('quality') ?? 'low';
  if (quality !== 'low' && quality !== 'medium' && quality !== 'high') throw new Error(`--quality: low, medium or high, not ${quality}`);
  const only = (arg('only') ?? LIGHT_SHOT_NAMES.join(',')).split(',').filter((s) => s !== '');
  const names: readonly string[] = [...LIGHT_SHOT_NAMES, ...LIGHT_CHECK_NAMES, ...MANY_LAMP_SHOT_NAMES];
  for (const n of only) if (!names.includes(n)) throw new Error(`--only: names among ${names.join(', ')}, not ${n}`);
  const day = arg('day');
  if (day !== null && day !== 'slow' && day !== 'fast') throw new Error(`--day: slow or fast, not ${day}`);
  const dayAt = (arg('day-at') ?? 'street-noon').split(',').filter((x) => x !== '');
  for (const n of dayAt) if (!names.includes(n)) throw new Error(`--day-at: names among ${names.join(', ')}, not ${n}`);
  const query = arg('query') ?? '';
  if (query !== '' && !query.startsWith('&')) throw new Error(`--query: more of the page's query, starting with & (e.g. &voxelShadows=off), not ${query}`);
  const vp = arg('viewport') ?? '1280x720';
  const m = /^(\d+)x(\d+)$/.exec(vp);
  if (m === null) throw new Error(`--viewport: WxH, not ${vp}`);
  return {
    origin: arg('origin') ?? 'http://127.0.0.1:4180',
    tokenFile: arg('token-file'),
    project: arg('project') ?? 'voxel-slice',
    world: arg('world') ?? 'far',
    quality,
    out: arg('out'),
    query,
    only: only as LightShotName[],
    holdS: num('hold', 3, 0.5, 30),
    timeoutS: num('timeout', 180, 10, 900),
    edits: num('edits', EDIT_DIGS.length, 0, EDIT_DIGS.length),
    gpu: argv.includes('--gpu'),
    gpuRepeats: num('gpu-repeats', 5, 3, 15),
    gpuOnly: arg('gpu-only')?.split(',').filter((x) => x !== '') ?? null,
    gpuAt: arg('gpu-at')?.split(',').filter((x) => x !== '') ?? null,
    gpuStale: argv.includes('--gpu-stale'),
    cacheEdits: argv.includes('--cache-edits'),
    arrivalShots: argv.includes('--arrival-shots'),
    lightOut: argv.includes('--light-out'),
    textureUnits: ((v) => {
      if (v === null) return null;
      if (!['off', 'volume'].includes(v)) throw new Error(`--texture-units: off or volume, not ${v}`);
      return v as LightShotsOptions['textureUnits'];
    })(arg('texture-units')),
    extraLamps: num('extra-lamps', 0, 0, 4096),
    lightTypes: argv.includes('--light-types'),
    glow: argv.includes('--glow'),
    glowMask: !argv.includes('--no-glow-mask'),
    freshCells: argv.includes('--fresh-cells'),
    arrivalAt: (arg('arrival-at') ?? '2,10').split(',').map((x) => {
      const n = Number(x);
      if (!Number.isFinite(n) || n <= 0 || n > 600) throw new Error(`--arrival-at: seconds in (0, 600], not ${x}`);
      return n;
    }),
    autoExposure: argv.includes('--auto-exposure'),
    reference: arg('reference'),
    day,
    dayAt: dayAt as LightShotName[],
    dayForS: num('day-for', 90, 10, 600),
    dayReference: arg('day-reference'),
    refineWaitS: num('refine-wait', 0, 0, 600),
    viewport: { width: Number(m[1]), height: Number(m[2]) },
  };
}

/** Pixels that differ by more than this (of 255, in any channel) count as changed. */
export const CHANGED_PIXEL_DELTA = 16;
/** The share of the picture that must change when the voxel draws are hidden for it to count as showing voxels. */
export const VOXEL_SHARE_MIN = 0.05;

/** A decoded picture (tests/e2e/png.ts's `Image`). */
export interface Picture {
  readonly width: number;
  readonly height: number;
  pixel(x: number, y: number): readonly [number, number, number, number] | [number, number, number, number];
}

/** The share of pixels of two pictures of one size that differ by more than {@link CHANGED_PIXEL_DELTA} in any colour channel. */
export function changedShare(a: Picture, b: Picture): number {
  if (a.width !== b.width || a.height !== b.height || a.width * a.height === 0) throw new Error('changedShare: pictures of different sizes');
  let n = 0;
  for (let y = 0; y < a.height; y++) for (let x = 0; x < a.width; x++) {
    const p = a.pixel(x, y), q = b.pixel(x, y);
    if (Math.abs(p[0] - q[0]) > CHANGED_PIXEL_DELTA || Math.abs(p[1] - q[1]) > CHANGED_PIXEL_DELTA || Math.abs(p[2] - q[2]) > CHANGED_PIXEL_DELTA) n++;
  }
  return n / (a.width * a.height);
}

/** A light volume cell as the page reads it back, with its place (level-0 cell). */
export interface BenchVolumeCell {
  readonly cell: readonly number[];
  readonly faces: readonly (readonly number[] | null)[];
}

const cellLum = (c: readonly number[]): number => 0.2126 * c[0]! + 0.7152 * c[1]! + 0.0722 * c[2]!;

/**
 * How blotchy the volume's light is: over every face of every cell holding light, and each of its four neighbours along
 * that face's surface holding light on the same face, the difference of their brightness over their mean (pairs whose
 * mean is under `floor` left out: black and near black say nothing); the mean of those, and how many pairs.
 */
export function cellBlotch(cells: readonly BenchVolumeCell[], floor = 1e-3): { mean: number; pairs: number } {
  const at = new Map<string, BenchVolumeCell>();
  for (const c of cells) at.set(c.cell.join(','), c);
  let sum = 0;
  let pairs = 0;
  for (const c of cells) for (let f = 0; f < 6; f++) {
    const a = c.faces[f];
    if (a === null || a === undefined) continue;
    const axis = f >> 1;
    // Each pair once: the neighbour a step up the two axes across the face's.
    for (const t of [(axis + 1) % 3, (axis + 2) % 3]) {
      const n = [...c.cell];
      n[t]! += 1;
      const b = at.get(n.join(','))?.faces[f];
      if (b === null || b === undefined) continue;
      const la = cellLum(a);
      const lb = cellLum(b);
      const m = (la + lb) / 2;
      if (m < floor) continue;
      sum += Math.abs(la - lb) / m;
      pairs++;
    }
  }
  return { mean: pairs === 0 ? 0 : sum / pairs, pairs };
}

/** A box filter of a luminance image (radius `r` px, clamped at the edges), by running sums. */
function boxBlur(l: Float32Array, w: number, h: number, r: number): Float32Array {
  const tmp = new Float32Array(w * h);
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    let s = 0;
    for (let x = -r; x <= r; x++) s += l[y * w + Math.min(w - 1, Math.max(0, x))]!;
    for (let x = 0; x < w; x++) {
      tmp[y * w + x] = s / (2 * r + 1);
      s += l[y * w + Math.min(w - 1, x + r + 1)]! - l[y * w + Math.max(0, x - r)]!;
    }
  }
  for (let x = 0; x < w; x++) {
    let s = 0;
    for (let y = -r; y <= r; y++) s += tmp[Math.min(h - 1, Math.max(0, y)) * w + x]!;
    for (let y = 0; y < h; y++) {
      out[y * w + x] = s / (2 * r + 1);
      s += tmp[Math.min(h - 1, y + r + 1) * w + x]! - tmp[Math.max(0, y - r) * w + x]!;
    }
  }
  return out;
}

/**
 * How blotchy a picture's flat parts are: its luminance a little blurred (3 px, the texture's grain out) less its
 * low-frequency gradient (a 48 px blur), over pixels where the little-blurred picture has no edge (a step of under 3 of
 * 255 across 6 px each way) and is not black: the standard deviation of that over the gradient's mean, and the share
 * of the picture it covers. Blotches of a cell to a metre at the cameras are 10–100 px across.
 */
export function pictureBlotch(img: Picture): { relStd: number; flatShare: number } {
  const w = img.width;
  const h = img.height;
  const l = new Float32Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const p = img.pixel(x, y);
    l[y * w + x] = 0.2126 * p[0] + 0.7152 * p[1] + 0.0722 * p[2];
  }
  const mid = boxBlur(l, w, h, 3);
  const low = boxBlur(l, w, h, 48);
  let s = 0;
  let s2 = 0;
  let m = 0;
  let n = 0;
  for (let y = 6; y < h - 6; y++) for (let x = 6; x < w - 6; x++) {
    const i = y * w + x;
    const edge = Math.abs(mid[i + 6]! - mid[i - 6]!) + Math.abs(mid[i + 6 * w]! - mid[i - 6 * w]!);
    if (edge >= 3 || low[i]! < 2) continue;
    const d = mid[i]! - low[i]!;
    s += d;
    s2 += d * d;
    m += low[i]!;
    n++;
  }
  if (n === 0) return { relStd: 0, flatShare: 0 };
  const mean = s / n;
  return { relStd: Math.sqrt(Math.max(0, s2 / n - mean * mean)) / (m / n), flatShare: n / (w * h) };
}

/** What makes a shot not count: never settled, no voxel draws counted, or nothing in it changes when the voxels are hidden. */
export function shotProblems(s: { settled: boolean; chunks: number; l0: number; farBricks: number; voxelShare: number; near: boolean }): string[] {
  const out: string[] = [];
  if (!s.settled) out.push('streaming never settled');
  if (s.chunks + s.farBricks === 0) out.push('no voxel draws');
  if (s.near && s.l0 === 0) out.push('no level-0 chunk drawn');
  if (!(s.voxelShare >= VOXEL_SHARE_MIN)) out.push(`no voxel surface in the frame (${(s.voxelShare * 100).toFixed(1)} % changed with the voxels hidden)`);
  return out;
}

/** One animation frame of the store's edit watch (its `progress()`): its time (page ms), texels (the volume: cell faces) written so far, units (bricks) stale, blocks waiting, settled (1) and probes stale. */
export type CacheWatchFrame = [number, number, number, number, number, number];

/**
 * Edit → light in the lighting store, from the frames watched from the edit command (page time `t0`): when the
 * change reached the store (blocks waiting, or units marked stale), the first frame after that whose
 * texels were written (the changed light drawn), and when texels and then probes settled again (nothing stale or
 * waiting). Null where it did not happen in the watch.
 */
export function cacheEditTiming(frames: readonly CacheWatchFrame[], t0: number): { reachedMs: number | null; firstLightMs: number | null; texelsSettledMs: number | null; settledMs: number | null; texelsWritten: number } {
  const none = { reachedMs: null, firstLightMs: null, texelsSettledMs: null, settledMs: null, texelsWritten: 0 };
  const r = frames.findIndex((f) => f[0] >= t0 && (f[3] > 0 || f[2] > 0));
  if (r < 0) return none;
  const written0 = frames[r]![1];
  const l2 = frames.findIndex((f, i) => i > r && f[1] > written0);
  const ts = frames.findIndex((f, i) => i > Math.max(r, l2) && f[2] === 0 && f[3] === 0);
  const ps = ts < 0 ? -1 : frames.findIndex((f, i) => i >= ts && f[2] === 0 && f[3] === 0 && f[4] === 1 && f[5] === 0);
  const ms = (i: number): number | null => (i < 0 ? null : Number((frames[i]![0] - t0).toFixed(1)));
  return { reachedMs: ms(r), firstLightMs: ms(l2), texelsSettledMs: ms(ts), settledMs: ms(ps), texelsWritten: (ts < 0 ? frames[frames.length - 1]![1] : frames[ts]![1]) - written0 };
}

/** One animation frame of the edit watch: its time (page ms), the edits drawn so far, the static map's draws so far. */
export type WatchFrame = [number, number, number | null];

/**
 * Edit → light, from the frames watched round one dig: the frame its mesh was first drawn in (the edit record's
 * count rose; its `visibleMs` is the edit → that frame) and the first frame after the dig whose static shadow map
 * was drawn again. The shadow's ms is the mesh's plus the time between the two frames (0 when the same frame; the
 * two counts are read once a frame, after whatever callbacks ran before the watch's, so ±1 frame).
 */
export function editShadowTiming(frames: readonly WatchFrame[], visibleMs: number): { shadowMs: number | null; shadowFrames: number | null } {
  if (frames.length === 0) return { shadowMs: null, shadowFrames: null };
  const [, edits0, draws0] = frames[0]!;
  const fv = frames.findIndex((f) => f[1] > edits0);
  const fs = frames.findIndex((f) => f[2] !== null && draws0 !== null && f[2] > draws0);
  if (fv < 0 || fs < 0) return { shadowMs: null, shadowFrames: null };
  return { shadowMs: visibleMs + (frames[fs]![0] - frames[fv]![0]), shadowFrames: fs - fv };
}
