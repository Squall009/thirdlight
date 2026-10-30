/**
 * Platformer reference cases: small side-view levels shaped like a 2D
 * platformer's (a floor, ramps, stairs, a wall, a ladder, a one-way shelf,
 * moving platforms) with a scripted input each, and the recorder that runs a
 * case through the production game host and keeps every step's character
 * position, velocity, grounding and state.
 *
 * The removed 2D platformer controller's runs of these cases are kept as the
 * reference traces (`fixtures/phase41/platformer-traces`, frozen data): the platformer
 * arcade movement profile of the 3D controller is measured against them, so the
 * levels are authored once in their 2D form and the 3D run gets the same
 * entities (2D boxes and polygons take their 3D form on the 3D backend).
 * Tuning is Sprout-shaped (its run and jump speeds, gravity, capsule and
 * windows), never its content.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { physics3DConfigOf } from '@thirdlight/runtime';

import { startHarness } from '../m22-worker/harness';
import { MODULES_3D } from '../3d/character-kit';

type Any = any;

export const HZ = 120;
const DT = 1 / HZ;
const HERE = dirname(fileURLToPath(import.meta.url));
export const TRACE_DIR = join(HERE, '..', '..', '..', 'fixtures', 'phase41', 'platformer-traces');

/** A side-scroller's project settings (Sprout-shaped numbers). */
export const SETTINGS = Object.freeze({ gravity_y: -19.62, run_speed: 6.75, jump_velocity: 9.9, max_fall_speed: -24, max_slope_climb_deg: 45, min_slope_slide_deg: 30 });
/** The player's controller data every case starts from: a small capsule and a platformer's windows. */
export const BASE_CONTROLLER = Object.freeze({ capsule: { radius: 0.182, height: 1.013, offset: [0, 0] }, coyoteTime: 0.08, jumpBuffer: 0.1, jumpRelease: 0.5 });
/** The capsule's centre standing on y = 0 (half its height plus the skin). */
export const STAND_Y = 1.013 / 2 + 0.01;

export type Frame = { moveX?: number; moveY?: number; jump?: 'pressed' | 'held' | 'released'; down?: boolean };

export interface PlatformerCase {
  readonly id: string;
  /** What the case measures (kept in the fixture). */
  readonly about: string;
  readonly start: [number, number];
  /** The level, authored in its 2D form (boxes without a depth, polygons, 2D climb volumes, movers). */
  readonly level: readonly Any[];
  /** Fields on top of BASE_CONTROLLER. */
  readonly controller?: Record<string, unknown>;
  readonly steps: number;
  readonly script: (s: number) => Frame;
}

const T = (x: number, y: number) => ({ position: [x, y, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] });
const box = (id: string, x: number, y: number, hx: number, hy: number, extra: Record<string, unknown> = {}): Any => ({ id, components: { transform: T(x, y), collider: { shape: { type: 'box', hx, hy }, ...extra } } });
const poly = (id: string, x: number, y: number, vertices: [number, number][]): Any => ({ id, components: { transform: T(x, y), collider: { shape: { type: 'polygon', vertices } } } });
const FLOOR = box('floor-0001', 0, -0.5, 40, 0.5);
/** The 25° ramp's top (4 m long). */
const RAMP_TOP = 4 * Math.tan((25 * Math.PI) / 180);

/** A jump pressed at `at` and held for `hold` steps (then released). */
function jumpAt(s: number, at: number, hold: number): Frame['jump'] | undefined {
  if (s === at) return 'pressed';
  if (s > at && s < at + hold) return 'held';
  if (s === at + hold) return 'released';
  return undefined;
}

const slopeDeg = (deg: number, run: number): [number, number][] => [[0, 0], [run, 0], [run, run * Math.tan((deg * Math.PI) / 180)]];

export const CASES: readonly PlatformerCase[] = [
  {
    id: 'jump-apex',
    about: 'a full jump (held to the top) and a short hop (released after 6 steps) from rest on flat ground: apex height and air time',
    start: [0, STAND_Y],
    level: [FLOOR],
    steps: 300,
    script: (s) => ({ jump: jumpAt(s, 20, 110) ?? jumpAt(s, 180, 6) }),
  },
  {
    id: 'run',
    about: 'run right from rest, let go (deceleration), run left, turn right while running: run speed, acceleration and deceleration',
    start: [0, STAND_Y],
    level: [FLOOR],
    steps: 300,
    script: (s) => ({ moveX: s < 10 ? 0 : s < 100 ? 1 : s < 140 ? 0 : s < 220 ? -1 : s < 260 ? 1 : 0 }),
  },
  {
    id: 'slopes',
    about: 'walk up a 25° ramp, stop on it, walk on over a flat top into a 55° ramp it cannot climb',
    start: [-2, STAND_Y],
    level: [FLOOR, poly('ramp-0001', 0, 0, slopeDeg(25, 4)), box('top-0001', 6, RAMP_TOP / 2, 2, RAMP_TOP / 2), poly('steep-0001', 8, RAMP_TOP, slopeDeg(55, 1.5))],
    steps: 420,
    script: (s) => ({ moveX: s >= 10 && s < 90 ? 0.6 : s >= 130 && s < 330 ? 1 : 0 }),
  },
  {
    id: 'slope-slide',
    about: 'placed on a 40° slope (steeper than the 30° slide angle, below the 45° climb limit) with no input: it slides down',
    start: [-8.5, 3],
    level: [FLOOR, poly('mid-0001', -10, 0, [[0, 0], [4, 0], [0, 4 * Math.tan((40 * Math.PI) / 180)]])],
    steps: 240,
    script: () => ({}),
  },
  {
    id: 'stairs',
    about: 'autostep on (0.25 m): walk up a stair of 0.2 m risers and 0.5 m treads and down the far side',
    start: [-1, STAND_Y],
    controller: { autostep: true, autostepHeight: 0.25 },
    // A stepped pyramid: each 0.2 m layer starts 0.5 m further in from both sides (the top is 0.5 m wide).
    level: [FLOOR, ...[0, 1, 2, 3].map((i) => box(`stair-000${i + 1}`, 2.75, 0.1 * (i + 1), 1.75 - 0.5 * i, 0.1 * (i + 1)))],
    steps: 300,
    script: (s) => ({ moveX: s >= 10 && s < 250 ? 0.5 : 0 }),
  },
  {
    id: 'walls',
    about: 'wall slide and wall jump on: jump into a tall wall and hold into it (the slide caps the fall), wall-jump off, land; then the same without them',
    start: [1.5, STAND_Y],
    controller: { wallSlide: true, wallJump: true, wallSlideSpeed: 2 },
    level: [FLOOR, box('wall-0001', 4, 6, 1, 6)],
    steps: 300,
    script: (s) => ({ moveX: s >= 5 && s < 150 ? 1 : 0, jump: jumpAt(s, 10, 40) ?? jumpAt(s, 110, 30) }),
  },
  {
    id: 'climb',
    about: 'walk into a ladder (a 1 m × 6 m climb volume), climb up, jump off, take hold again in the fall, climb down to the floor',
    start: [0, STAND_Y],
    level: [FLOOR, { id: 'ladder-0001', components: { transform: T(2, 3), climbVolume: { size: [1, 6] } } }],
    steps: 520,
    script: (s) => ({
      moveX: s >= 5 && s < 76 ? 0.5 : 0,
      moveY: (s >= 80 && s < 190) || (s >= 225 && s < 240) ? 1 : s >= 270 && s < 500 ? -1 : 0,
      jump: jumpAt(s, 190, 20),
    }),
  },
  {
    id: 'one-way',
    about: 'a one-way shelf: jump up through it, land on it, drop through with down + jump, walk off its end from a second jump',
    start: [-1.5, STAND_Y],
    level: [FLOOR, box('shelf-0001', 1, 1.6, 2.5, 0.1, { oneWay: true })],
    steps: 420,
    script: (s) => ({ moveX: s >= 280 && s < 400 ? 1 : 0, jump: jumpAt(s, 20, 60) ?? jumpAt(s, 160, 4) ?? jumpAt(s, 230, 60), down: s >= 155 && s < 165 }),
  },
  {
    id: 'movers',
    about: 'a lift (up 2 m, a wait, back down) carries the standing character up and down; a hop on the rising lift lands back on it; then it walks off',
    start: [0, 0.2 + STAND_Y],
    level: [FLOOR, { id: 'lift-0001', components: { transform: T(0, 0.1), collider: { shape: { type: 'box', hx: 1, hy: 0.1 } }, mover: { waypoints: [[0, 2, 0]], speed: 1, mode: 'pingpong', wait: 0.25 } } }],
    steps: 600,
    script: (s) => ({ moveX: s >= 540 && s < 580 ? 1 : 0, jump: jumpAt(s, 150, 6) }),
  },
  {
    id: 'side-platform',
    about: 'standing on a platform moving sideways (4 m back and forth at 1 m/s): it is carried, jumps straight up from it twice and lands on it',
    start: [0, 1.1 + STAND_Y],
    level: [FLOOR, { id: 'side-0001', components: { transform: T(0, 1), collider: { shape: { type: 'box', hx: 1.5, hy: 0.1 } }, mover: { waypoints: [[4, 0, 0]], speed: 1, mode: 'pingpong', wait: 0.25 } } }],
    steps: 600,
    script: (s) => ({ jump: jumpAt(s, 120, 20) ?? jumpAt(s, 420, 20) }),
  },
  {
    id: 'coyote-buffer',
    about: 'run off a ledge and press jump 6 steps after leaving it (inside the coyote window); press jump 8 steps before landing (inside the buffer): it jumps on touching down',
    start: [-3, 1 + STAND_Y],
    level: [FLOOR, box('ledge-0001', -3, 0.5, 2, 0.5)],
    steps: 360,
    script: (s) => ({ moveX: s >= 10 && s < 120 ? 0.5 : 0, jump: jumpAt(s, 101, 30) ?? jumpAt(s, 202, 30) }),
  },
];

/** One recorded step: the character's centre, its controller velocity (the staged move, m/s), grounding and state. */
export type TraceRow = [x: number, y: number, vx: number, vy: number, grounded: 0 | 1, state: 'g' | 'a' | 'w' | 'c'];

export interface TraceFile {
  readonly id: string;
  readonly about: string;
  readonly hz: number;
  readonly settings: typeof SETTINGS;
  readonly controller: Record<string, unknown>;
  readonly start: [number, number];
  readonly level: readonly Any[];
  readonly input: readonly Frame[];
  readonly columns: readonly string[];
  readonly rows: readonly TraceRow[];
}

const round = (v: number): number => Math.round(v * 1e6) / 1e6;

/** The case's recorded input (one frame per step from the first gameplay step). */
export function inputOf(c: PlatformerCase): Frame[] {
  return Array.from({ length: c.steps + 20 }, (_, s) => c.script(s));
}

/** The settle pre-roll's steps (0.1 s at 120 Hz): they consume the recording's first frames. */
const SETTLE_STEPS = 12;

/**
 * The case's replay. `downMoves`: down is also the move input's y, as a
 * side view's stick or keys give it; a character free in 3D reads that y as
 * a walk in depth, so there down is the `navigate` action only.
 */
function replayOf(c: PlatformerCase, downMoves: boolean): Any[] {
  const idle: Frame[] = Array.from({ length: SETTLE_STEPS }, () => ({}));
  return [...idle, ...inputOf(c)].map((f, s) => ({
    stepIndex: s,
    moveX: f.moveX ?? 0,
    moveY: f.down === true && downMoves ? -1 : (f.moveY ?? 0),
    jump: f.jump ?? 'none',
    actions: f.down === true ? { navigate: { v: 1, x: 0, y: -1, p: 'held' } } : {},
  }));
}

/**
 * A case's entities. A climb volume is 1 m deep; with `axis` 'x' the
 * level stands on the plane x = 0 instead of z = 0: the 2D x runs along −Z
 * (each collider's plane says so, which turns its outline), so the same
 * level and moves give the same in-plane trace.
 */
export function entitiesOf(c: PlatformerCase, extraController: Record<string, unknown> = {}, axis: 'z' | 'x' = 'z'): Any[] {
  const onX = axis === 'x';
  const at = (p: readonly number[]): number[] => (onX ? [0, p[1]!, -p[0]!] : [...p]);
  const place = (e: Any): Any => {
    const k = { ...e.components, transform: { ...e.components.transform, position: at(e.components.transform.position) } };
    if (k.climbVolume !== undefined) k.climbVolume = { size: onX ? [1, k.climbVolume.size[1], k.climbVolume.size[0]] : [...k.climbVolume.size, 1] };
    if (onX && k.collider !== undefined) k.collider = { ...k.collider, plane: { axis: 'x', origin: 0 } };
    if (onX && k.mover !== undefined) k.mover = { ...k.mover, waypoints: k.mover.waypoints.map(at) };
    return { ...e, components: k };
  };
  return [
    { id: 'cam-main', components: { transform: { position: onX ? [14, 2, 0] : [0, 2, 14], rotation: [0, 0, 0, 1], scale: [1, 1, 1] }, camera: { type: 'perspective', fovY: 50, near: 0.1, far: 200 } } },
    place({ id: 'player-0001', components: { transform: T(c.start[0], c.start[1]), controller: { ...BASE_CONTROLLER, ...(c.controller ?? {}), ...extraController } } }),
    ...c.level.map(place),
  ];
}

/**
 * Run a case through the production game host (page composition) and record
 * every executed step after the settle pre-roll, its player carrying
 * `extraController` (a movement profile, a plane).
 */
export async function recordCase(c: PlatformerCase, extraController: Record<string, unknown> = {}, axis: 'z' | 'x' = 'z'): Promise<{ rows: TraceRow[]; depth: number[]; errors: Any[] }> {
  return recordRun(c, entitiesOf(c, extraController, axis), { axis, onPlane: extraController['plane'] !== undefined });
}

/**
 * Run a case's input over given entities (a level as an upgraded project
 * holds it, say) and record it as `recordCase` does. `playerId`: the player
 * (absent: `player-0001`); `onPlane`: down is a plane-locked character's
 * (its move's y) rather than a free one's.
 */
export async function recordRun(c: PlatformerCase, entities: readonly Any[], opts: { axis?: 'z' | 'x'; onPlane: boolean; playerId?: string }): Promise<{ rows: TraceRow[]; depth: number[]; errors: Any[] }> {
  const axis = opts.axis ?? 'z';
  const playerId = opts.playerId ?? 'player-0001';
  // The in-plane x (+X, or −Z on the plane x = 0) and the depth across the plane.
  const along = (v: { x: number; z?: number }): number => (axis === 'x' ? -(v.z ?? 0) : v.x);
  const across = (v: { x: number; z?: number }): number => (axis === 'x' ? v.x : (v.z ?? 0));
  const settings = { ...SETTINGS };
  const physics = physics3DConfigOf(entities as Any[], settings);
  const h = await startHarness('single', {
    snapshot: { snapshotId: `${c.id}@r1`, projectId: c.id, revision: 1, scene: { schemaVersion: 4, sceneId: 'scene-main', revision: 1, entities }, scenes: [{ sceneId: 'scene-main', start: true, entityIds: entities.map((e) => e.id) }] },
    settings,
    physics,
    replay: replayOf(c, opts.onPlane),
    modules: MODULES_3D,
  });
  const rt = h.rt as Any;
  const rows: TraceRow[] = [];
  const depth: number[] = [];
  const ladder = c.level.find((e: Any) => e.components.climbVolume !== undefined);
  const climbSpeed = typeof c.controller?.['climbSpeed'] === 'number' ? (c.controller['climbSpeed'] as number) : 2;
  const input = inputOf(c);
  rt.setStepWatcher?.(() => {
    const r = rt.controllers.result(playerId);
    if (r === undefined) return false;
    const vx = along(r.requested) / DT;
    const vy = r.requested.y / DT;
    const at = rows.length;
    const f = input[at] ?? {};
    // A climbing step moves at the climb speed along the ladder's axes, with no gravity in it.
    const inLadder = ladder !== undefined && Math.abs(along(r.position) - ladder.components.transform.position[0]) <= ladder.components.climbVolume.size[0] / 2 && Math.abs(r.position.y - ladder.components.transform.position[1]) <= ladder.components.climbVolume.size[1] / 2;
    const climbVel = (v: number): boolean => [0, climbSpeed, -climbSpeed].some((k) => Math.abs(v - k) < 1e-9);
    const prevClimb = rows[at - 1]?.[5] === 'c';
    const climbing = inLadder && climbVel(vx) && climbVel(vy) && (prevClimb || Math.abs(f.moveY ?? 0) >= 0.5) && f.jump !== 'pressed';
    const state: TraceRow[5] = climbing ? 'c' : r.grounded ? 'g' : r.contacts.wall ? 'w' : 'a';
    rows.push([round(along(r.position)), round(r.position.y), round(vx), round(vy), r.grounded ? 1 : 0, state]);
    depth.push(across(r.position));
    return false;
  });
  try {
    let now = 10;
    // (The watcher sees gameplay steps only: the settle pre-roll is not recorded.)
    while (rows.length < c.steps) {
      now += DT;
      await h.tick(now);
    }
    const d = rt.getDiagnostics();
    return { rows: rows.slice(0, c.steps), depth: depth.slice(0, c.steps), errors: d.ok ? d.diagnostics.errors : [d] };
  } finally {
    await h.dispose();
  }
}

export function readTrace(id: string): TraceFile {
  return JSON.parse(readFileSync(join(TRACE_DIR, `${id}.json`), 'utf8')) as TraceFile;
}

/** The tolerances, stated once (positions in m, timings in steps of 1/120 s). */
export const PARITY = Object.freeze({
  /** The position at a key event. */
  eventPosition: 0.01,
  /** How many steps a key event may move (measured: none moves). */
  eventSteps: 1,
  /** Every step against the 2D path one step either side (the 2D port's own flat-ground bumps reach 1.1 cm). */
  path: 0.015,
  /** The controller's staged velocity (its rules), at every step. */
  velocity: 1e-6,
  /** A measured height or rest position (jump apex, lift top, ladder top, a stop on a slope). */
  measure: 0.01,
  /** Where the character comes to rest after a stair walk: each riser's ride over the edge lands within about 1 cm of the 2D's (the ride amplifies the last millimetre), and the slide off the last edge starts a step apart. */
  stairRest: 0.05,
});

/** The distance from `p` to the 2D path through steps i−1 … i+1. */
export function pathGap(p: TraceRow, r: readonly TraceRow[], i: number): number {
  let best = Infinity;
  for (let j = Math.max(0, i - 1); j < Math.min(r.length - 1, i + 1); j += 1) {
    const a = r[j]!;
    const b = r[j + 1]!;
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const l = dx * dx + dy * dy;
    const t = l === 0 ? 0 : Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l));
    best = Math.min(best, Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy));
  }
  return best;
}
