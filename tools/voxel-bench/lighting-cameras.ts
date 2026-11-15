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
/** Checks beside the five, taken only when named (`--only`): a far lamp from two places, two cameras moved 1 m. */
export const LIGHT_CHECK_NAMES = ['far-lamp-a', 'far-lamp-b', 'far-view-1m', 'street-noon-1m', 'street-noon-2m', 'room-window-2m'] as const;
export type LightShotName = (typeof LIGHT_SHOT_NAMES)[number] | (typeof LIGHT_CHECK_NAMES)[number];

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
const moved = (c: LightingCamera, name: 'far-view-1m' | 'street-noon-1m' | 'street-noon-2m' | 'room-window-2m', command: string, by = 1): LightingCamera => ({ ...c, name, command, eye: [c.eye[0] + by, c.eye[1], c.eye[2]] });
/** The checks' cameras (LIGHT_CHECK_NAMES): the far lamp from two places 60 m apart, far view and street moved 1 m, street and room moved 2 m (a camera-following store's step). */
export const LIGHT_CHECK_CAMERAS: readonly LightingCamera[] = Object.freeze([
  farLampCamera('far-lamp-a', 'shot6', 30),
  farLampCamera('far-lamp-b', 'shot7', -30),
  moved(LIGHTING_CAMERAS[4]!, 'far-view-1m', 'shot8'),
  moved(LIGHTING_CAMERAS[0]!, 'street-noon-1m', 'shot9'),
  moved(LIGHTING_CAMERAS[0]!, 'street-noon-2m', 'shot10', 2),
  moved(LIGHTING_CAMERAS[1]!, 'room-window-2m', 'shot11', 2),
]);

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
export function lightShotsSource(cameras: readonly LightingCamera[] = [...LIGHTING_CAMERAS, ...LIGHT_CHECK_CAMERAS]): string {
  return `
const SHOTS = ${JSON.stringify(cameras.map((c) => ({ command: c.command, eye: c.eye, yaw: c.yaw, pitch: c.pitch, preset: c.preset })))};
const DIGS = ${JSON.stringify(EDIT_DIGS)};
const LAMP = ${JSON.stringify(BENCH_LAMPS[2]!.position)};
const LAMP_WALL = ${JSON.stringify(LAMP_WALL)};
const quat = (yaw: number, pitch: number) => { const cy = Math.cos(yaw / 2), sy = Math.sin(yaw / 2), cp = Math.cos(-pitch / 2), sp = Math.sin(-pitch / 2); return [cy * sp, sy * cp, -sy * sp, cy * cp]; };
export default {
  prepare() { return {}; },
  instantiate() { return { at: 0, wallDug: -1, wasEnclosed: 0 }; },
  step(s: any, ctx: any) {
    if (ctx.phase === 'intent') {
      SHOTS.forEach((shot: any, i: number) => { for (const _ of ctx.debug.command(shot.command)) { s.at = i; ctx.environment?.set(shot.preset); } });
      // The open region at the camera's eye, each step (gauges: a counter set to the value).
      const v = ctx.voxels;
      const put = (n: string, x: number) => ctx.game.add(n, x - ctx.game.counter(n));
      const eye = SHOTS[s.at].eye;
      const r = v?.regionAt(eye[0], eye[1], eye[2]) ?? null;
      put('region_known', r === null ? 0 : 1); put('region_enclosed', r?.enclosed ? 1 : 0); put('region_volume', r === null ? 0 : Math.round(r.volume));
      put('region_sky', r?.sky ? 1 : 0); put('region_portals', r?.portals ?? 0); put('region_id', r?.id ?? 0);
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
  /** `--gpu-stale`: a second GPU measurement at each camera while the surface cache has work (every texel and probe kept stale). */
  readonly gpuStale: boolean;
  /** `--cache-edits`: the surface cache's edit → light times (a window dug at the room camera; a wall built and dug between a lamp and the fronts at night). */
  readonly cacheEdits: boolean;
  /** `--arrival-shots`: pictures 2 s and 10 s after each camera's move, before anything settles (what a player sees meanwhile). */
  readonly arrivalShots: boolean;
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
  for (const n of only) if (![...LIGHT_SHOT_NAMES, ...LIGHT_CHECK_NAMES].includes(n as LightShotName)) throw new Error(`--only: names among ${[...LIGHT_SHOT_NAMES, ...LIGHT_CHECK_NAMES].join(', ')}, not ${n}`);
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
    gpuStale: argv.includes('--gpu-stale'),
    cacheEdits: argv.includes('--cache-edits'),
    arrivalShots: argv.includes('--arrival-shots'),
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

/** One animation frame of the cache's edit watch: its time (page ms), texels written so far, units stale, chunks waiting for charts, probes settled (1) and stale. */
export type CacheWatchFrame = [number, number, number, number, number, number];

/**
 * Edit → light in the surface cache, from the frames watched from the edit command (page time `t0`): when the
 * change reached the cache (its chunk waiting for charts, or units marked stale), the first frame after that whose
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
