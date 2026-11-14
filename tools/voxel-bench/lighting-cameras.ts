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

/** The pictures' names, fixed (a later item compares files of the same name). */
export const LIGHT_SHOT_NAMES = ['street-noon', 'room-window', 'cave', 'night-lamps', 'far-view'] as const;
export type LightShotName = (typeof LIGHT_SHOT_NAMES)[number];

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

/** The house the room camera stands in: lot (6, 6), two storeys, x −5…5 m, z −4…6 m, windows in its west wall at 1–2 m. */
export const ROOM_HOUSE = Object.freeze({ min: Object.freeze([-5, 0.5, -4] as const), max: Object.freeze([5, 3, 6] as const) });

export const LIGHTING_CAMERAS: readonly LightingCamera[] = Object.freeze([
  { name: 'street-noon', command: 'shot1', eye: [-40, 1.7, STREET_Z], yaw: yawOf(1, 0), pitch: 0.05, preset: 'bench-noon', near: true, shows: 'the street between two house rows at noon: house fronts with doors and windows, fences, ground, sky' },
  { name: 'room-window', command: 'shot2', eye: [3, 1.8, 1], yaw: yawOf(-1, 0.15), pitch: 0.05, preset: 'bench-noon', near: true, shows: 'inside the centre house (ground floor), looking at its west wall with three windows (the sun side), the stairs and the room round it' },
  { name: 'cave', command: 'shot3', eye: [CAVE.foot[0] + CAVE.into[0] * 22, CAVE.axisY - 0.5, CAVE.foot[2] + CAVE.into[1] * 22], yaw: yawOf(-CAVE.into[0], -CAVE.into[1]), pitch: 0.02, preset: 'bench-noon', near: true, shows: 'deep in the dug cave looking out: the tube walls and the bright mouth' },
  { name: 'night-lamps', command: 'shot4', eye: [44, 1.7, STREET_Z], yaw: yawOf(-1, 0), pitch: 0.05, preset: 'bench-night', near: true, shows: 'the same street at night, five warm lamps lighting the house fronts, fences and ground' },
  { name: 'far-view', command: 'shot5', eye: [140, 40, 10], yaw: yawOf(-1, 0.05), pitch: 0.1, preset: 'bench-noon', near: false, shows: 'from over the town’s east edge across the town to the western massif' },
] satisfies LightingCamera[]);

/** Runtime edits for the edit-to-screen time: a 1 m ball dug in the street in front of the street camera, each its own command. */
export const EDIT_DIGS: ReadonlyArray<{ readonly command: string; readonly center: readonly [number, number, number] }> = Object.freeze(
  [0, 1, 2].map((i) => Object.freeze({ command: `dig${i + 1}`, center: Object.freeze([-30 + 3 * i, 0, STREET_Z] as const) })),
);
export const EDIT_DIG_RADIUS_M = 1;

/** A clear physical sky (no clouds: they drift, so two runs' skies would differ). */
const CLEAR_SKY = Object.freeze({ mode: 'procedural', environmentIntensity: 0.1, cloudCoverage: 0 });

/** The two looks: noon (the scene's sun high from the south-west, lamps off) and night (no sun, dim blue ambient, lamps on). */
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
]);

/**
 * The camera's behaviour: each shot's command puts the camera at its pose and its look on at once, every step
 * after holds it there; each dig command digs its ball through `ctx.voxels` (a runtime edit: never written to
 * the world's files).
 */
export function lightShotsSource(cameras: readonly LightingCamera[] = LIGHTING_CAMERAS): string {
  return `
const SHOTS = ${JSON.stringify(cameras.map((c) => ({ command: c.command, eye: c.eye, yaw: c.yaw, pitch: c.pitch, preset: c.preset })))};
const DIGS = ${JSON.stringify(EDIT_DIGS)};
const quat = (yaw: number, pitch: number) => { const cy = Math.cos(yaw / 2), sy = Math.sin(yaw / 2), cp = Math.cos(-pitch / 2), sp = Math.sin(-pitch / 2); return [cy * sp, sy * cp, -sy * sp, cy * cp]; };
export default {
  prepare() { return {}; },
  instantiate() { return { at: 0 }; },
  step(s: any, ctx: any) {
    if (ctx.phase === 'intent') {
      SHOTS.forEach((shot: any, i: number) => { for (const _ of ctx.debug.command(shot.command)) { s.at = i; ctx.environment?.set(shot.preset); } });
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
  for (const n of only) if (!(LIGHT_SHOT_NAMES as readonly string[]).includes(n)) throw new Error(`--only: names among ${LIGHT_SHOT_NAMES.join(', ')}, not ${n}`);
  const query = arg('query') ?? '';
  if (query !== '' && !query.startsWith('&')) throw new Error(`--query: more of the page's query, starting with & (e.g. &voxelShadows=static), not ${query}`);
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

/** What makes a shot not count: never settled, no voxel draws counted, or nothing in it changes when the voxels are hidden. */
export function shotProblems(s: { settled: boolean; chunks: number; l0: number; farBricks: number; voxelShare: number; near: boolean }): string[] {
  const out: string[] = [];
  if (!s.settled) out.push('streaming never settled');
  if (s.chunks + s.farBricks === 0) out.push('no voxel draws');
  if (s.near && s.l0 === 0) out.push('no level-0 chunk drawn');
  if (!(s.voxelShare >= VOXEL_SHARE_MIN)) out.push(`no voxel surface in the frame (${(s.voxelShare * 100).toFixed(1)} % changed with the voxels hidden)`);
  return out;
}
