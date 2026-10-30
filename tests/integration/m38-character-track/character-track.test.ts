/**
 * Cutscenes move player characters — the timeline's character track and
 * `ctx.character`'s place / walkTo / turn / setEnabled, through the
 * production composition (the real game host, the character controllers and
 * Rapier), in 3D, on the main thread and in the simulation worker,
 * with a recorded input that pushes the other way.
 *
 * A script plays a cutscene: its character track places the character at a
 * mark facing one way, has its controller walk it to a second mark and turn
 * there, switches it off and on; meanwhile the player's input (held left, a
 * jump press) does not move it, and does again once the cutscene ends. The
 * cutscene played again and skipped lands the character on the last mark at
 * once. A script's own walk arrives and turns; one into a wall is blocked;
 * a transform track's rotation key turns the controller for good. Every
 * step's digest agrees in page and worker.
 */
import { describe, expect, it } from 'vitest';

import { physics3DConfigOf } from '@thirdlight/runtime';

import { behaviorModule, startHarness, type Mode } from '../m22-worker/harness';
import { MODULES_3D, SETTINGS, STAND_Y } from '../3d/character-kit';

type Any = any;
const DT = 1 / 120;
const T = (position: number[], rotation: number[] = [0, 0, 0, 1]) => ({ position, rotation, scale: [1, 1, 1] });
const yawQ = (deg: number) => [0, Math.sin((deg * Math.PI) / 360), 0, Math.cos((deg * Math.PI) / 360)];

/**
 * Plays the cutscene at steps 30 and 700, walks the character itself at 900
 * (to a mark, then facing 0) and at 1150 (into the wall), plays the turn at
 * 1420; every 5 steps logs where the player is, which way it faces, whether
 * its controller is on and both walks' states.
 */
const DIRECTOR = `
export default {
  instantiate() { return { w: 0, b: 0 }; },
  step(s, ctx) {
    if (ctx.phase !== 'intent') return;
    const n = ctx.stepIndex;
    if (n === 30 || n === 700) ctx.timeline.play('cutscene');
    if (n === 900) s.w = ctx.character.walkTo([0, 0, -2], { facing: 0 });
    if (n === 1150) s.b = ctx.character.walkTo([0, 0, -8]);
    if (n === 1420) ctx.timeline.play('turn');
    if (n % 5 !== 0) return;
    const r = (v) => Math.round(v * 1e4) / 1e4;
    const p = ctx.world.transform('player-0001').position;
    const q = ctx.world.transform('player-0001').rotation;
    const facing = r((2 * Math.atan2(q[1], q[3]) * 180) / Math.PI);
    const on = ctx.physics.characterState()?.enabled ?? null;
    const key = 'log' + Math.floor(n / 100);
    const log = ctx.save.get(key) ?? [];
    log.push([n, r(p[0]), r(p[1]), r(p[2]), facing, on, s.w ? ctx.character.walkState(s.w) : null, s.b ? ctx.character.walkState(s.b) : null]);
    ctx.save.set(key, log);
  },
};
`;

/** Place at the first mark facing +X, walk to the second and face −Z there, off for a moment, on again. */
function cutscene(): Any {
  const y = STAND_Y;
  return {
    timelineId: 'cutscene',
    name: 'Walk in',
    duration: 4,
    slots: [{ name: 'hero', entity: 'player-0001' }],
    skipAction: 'skip',
    tracks: [
      {
        trackId: 'hero-moves',
        type: 'character',
        target: 'hero',
        keys: [
          { time: 0, mode: 'place', position: [-2, y, 0], facing: 90 },
          { time: 0.5, mode: 'walk', position: [2, y, 1], facing: 180 },
          { time: 3.2, enabled: false },
          { time: 3.6, enabled: true },
        ],
      },
    ],
  };
}

/** A transform key's rotation on the character (yaw −90°). */
const TURN = { timelineId: 'turn', name: 'Turn', duration: 0.5, slots: [{ name: 'hero', entity: 'player-0001' }], tracks: [{ trackId: 'spin', type: 'transform', target: 'hero', keys: [{ time: 0, rotation: yawQ(-90) }] }] };

function level(): Any[] {
  const box = (id: string, c: number[], h: number[]): Any => ({ id, components: { transform: T(c), collider: { shape: { type: 'box', hx: h[0], hy: h[1], hz: h[2] } } } });
  return [
    { id: 'player-0001', components: { transform: T([0, STAND_Y, 0]), controller: {} } },
    box('floor-0001', [0, -0.5, 0], [30, 0.5, 30]),
    box('wall-0001', [0, 1.5, -4.5], [3, 1.5, 0.5]),
    { id: 'director-0001', components: { transform: T([0, -5, 0]), behavior: { behaviorId: 'director', values: {} } } },
  ];
}

/** The input pushes left until step 690 (and presses jump at 200); `skip` is pressed at step 720. */
function recording(n: number): Any[] {
  return Array.from({ length: n + 100 }, (_, s) => {
    const actions: Record<string, Any> = {};
    if (s === 720) actions['skip'] = { v: 1, p: 'pressed' };
    if (s === 721) actions['skip'] = { v: 0, p: 'released' };
    return { stepIndex: s, moveX: s < 690 ? -1 : 0, moveY: 0, jump: s === 200 ? 'pressed' : 'none', actions };
  });
}

async function run(mode: Mode, steps: number): Promise<{ log: Any[]; digests: string[]; errors: Any[]; logs: string[] }> {
  const entities = level();
  const h = await startHarness(mode, {
    snapshot: { snapshotId: 'ct@r1', projectId: 'ct', revision: 1, scene: { schemaVersion: 4, sceneId: 'scene-main', revision: 1, entities }, scenes: [{ sceneId: 'scene-main', start: true, entityIds: entities.map((e) => e.id) }], timelines: [cutscene(), TURN] },
    storage: true,
    settings: SETTINGS,
    physics: physics3DConfigOf(entities, SETTINGS),
    replay: recording(steps),
    digestSteps: true,
    modules: MODULES_3D,
    behaviors: [behaviorModule('director', DIRECTOR)],
  });
  try {
    let now = 10;
    while (h.digests.length < steps) {
      now += DT;
      await h.tick(now);
    }
    const d = (h.rt as Any).getDiagnostics();
    const values = await h.storage();
    const log = Array.from({ length: Math.ceil(steps / 100) + 1 }, (_, i) => (values[`log${i}`] ?? []) as Any[]).flat();
    const all: Any[] = d.ok ? d.diagnostics.errors : [d];
    return { log, digests: h.digests.slice(0, steps), errors: all.filter((e) => e.code !== 'behavior_log'), logs: all.filter((e) => e.code === 'behavior_log').map((e) => String(e.message)) };
  } finally {
    await h.dispose();
  }
}

/** A logged row: [step, x, y, z, facing, enabled, script walk, blocked walk]. */
const rowOf = (log: Any[], s: number): Any[] => {
  const r = log.find((x: Any[]) => x[0] === s);
  expect(r, `step ${s}`).toBeDefined();
  return r;
};
/** Degrees apart, the short way. */
const turnGap = (a: number, b: number): number => Math.abs(((((a - b) % 360) + 540) % 360) - 180);

describe('a cutscene moves the character', () => {
  it('places, walks (input held), turns, parks and lets go; a skip lands it; a script walk arrives, one into a wall is blocked; a rotation key turns the controller; page and worker agree', async () => {
    const steps = 1480;
    const a = await run('single', steps);
    expect(a.errors).toEqual([]);
    const at = (s: number) => rowOf(a.log, s);
    // The input walked it left before the cutscene.
    expect(at(25)[1]).toBeLessThan(-0.1);
    // Placed at the first mark facing +X; the held input does not move it before the walk.
    expect(at(35)[1]).toBeCloseTo(-2, 2);
    expect(at(35)[3]).toBeCloseTo(0, 2);
    expect(turnGap(at(35)[4], 90)).toBeLessThan(0.5);
    expect(at(85)[1]).toBeCloseTo(-2, 2);
    // It walks toward the mark against the input, the jump press does nothing, and it arrives facing −Z.
    expect(at(150)[1]).toBeGreaterThan(-1.5);
    const air = a.log.filter((r) => r[0] >= 190 && r[0] <= 280);
    expect(Math.max(...air.map((r) => r[2]))).toBeLessThan(STAND_Y + 0.02);
    expect(Math.hypot(at(410)[1] - 2, at(410)[3] - 1)).toBeLessThan(0.1);
    expect(turnGap(at(410)[4], 180)).toBeLessThan(0.5);
    // Switched off at 3.2 s, on again at 3.6 s.
    expect(at(430)[5]).toBe(false);
    expect(at(470)[5]).toBe(true);
    expect(Math.hypot(at(505)[1] - 2, at(505)[3] - 1)).toBeLessThan(0.1);
    // After the end the input moves it again.
    expect(at(600)[1]).toBeLessThan(at(505)[1] - 0.5);
    // Played again and skipped at step 720: on the last mark at once, facing its way.
    expect(at(710)[1]).toBeCloseTo(-2, 2);
    expect(Math.hypot(at(725)[1] - 2, at(725)[3] - 1)).toBeLessThan(0.05);
    expect(turnGap(at(725)[4], 180)).toBeLessThan(0.5);
    // A script's walk arrives and turns to face +Z.
    expect(at(1145)[6]).toBe('arrived');
    expect(Math.hypot(at(1145)[1], at(1145)[3] + 2)).toBeLessThan(0.1);
    expect(turnGap(at(1145)[4], 0)).toBeLessThan(0.5);
    // One into the wall (its face at z −4) gets stuck there and is blocked.
    expect(at(1415)[7]).toBe('blocked');
    expect(at(1415)[3]).toBeGreaterThan(-3.75);
    expect(a.logs.some((m) => m.includes('blocked'))).toBe(true);
    // A transform key's rotation turns the controller, and it stays turned.
    expect(turnGap(at(1435)[4], -90)).toBeLessThan(0.5);
    expect(turnGap(at(1475)[4], -90)).toBeLessThan(0.5);
    const w = await run('worker', steps);
    expect(w.errors).toEqual([]);
    expect(w.digests).toEqual(a.digests);
  }, 180_000);
});
