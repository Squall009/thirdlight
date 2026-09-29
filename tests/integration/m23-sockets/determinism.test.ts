/**
 * Sockets are simulation state. A neutral model (the socket
 * fixture: a node `arm` sliding 1 m/s along +X under an animator, a child
 * node `hand`) carries an authored socket (a gem on `hand`, offset up
 * 0.25 m); a director script attaches a second object to `arm` by
 * `ctx.sockets.attach`, halves the model's playback speed
 * (`ctx.animator(id).setSpeed(0.5)`), reads a node pose, detaches the gem
 * keeping its world pose and the rider snapping back. Run twice in the page
 * and once in the simulation worker from the same input, every step's digest
 * is identical, the host's socket observations agree frame by frame, and the
 * attached objects move at the clip's rate — half of it after the speed
 * change — in a 2D-plane scene and in a 3D scene alike.
 */
import { describe, expect, it } from 'vitest';

import { readModelRig } from '@thirdlight/project-model';
import { physics3DConfigOf } from '@thirdlight/runtime';

import { socketGlb } from '../../e2e/socket-glb';
import { FakeNode, behaviorModule, startHarness, type Harness, type Mode } from '../m22-worker/harness';

type Any = any;
const HZ = 120;
const DT = 1 / HZ;
const T = (position: number[], rotation: number[] = [0, 0, 0, 1]) => ({ position, rotation, scale: [1, 1, 1] });

const DIRECTOR = `
export default {
  instantiate() { return { pose: null }; },
  step(state, ctx) {
    const s = ctx.stepIndex;
    if (s === 60) ctx.sockets.attach('rider-0001', 'table-0001', 'arm', [0, 0.1, 0]);
    if (s === 240) ctx.animator('table-0001').setSpeed(0.5);
    if (s === 300) state.pose = ctx.sockets.nodePose('table-0001', 'hand');
    if (s === 420) ctx.sockets.detach('gem-0001');
    if (s === 450) ctx.sockets.detach('rider-0001', false);
    if (s === 470 && ctx.sockets.attachedTo('gem-0001') === null && ctx.animator('table-0001').speed() === 0.5) ctx.save.set('checked', true);
  },
};
`;

const RIG = (() => {
  const r = readModelRig(socketGlb(), 'model-socket');
  if (!r.ok) throw new Error(r.message);
  return r.rig;
})();

const CONTROLLER = {
  controllerId: 'ctl-slide',
  name: 'Slide',
  parameters: [],
  states: [{ id: 'st-slide', name: 'Slide', motion: { kind: 'clip', clip: { assetId: 'model-socket', clip: 'slide', duration: 4 } }, speed: 1, loop: true }],
  transitions: [],
  entry: 'st-slide',
  events: [],
};

function snapshot(extra: Any[], id: string): Any {
  const entities: Any[] = [
    { id: 'cam-main', components: { transform: T([0, 3, 12]), camera: { type: 'perspective', fovY: 50, near: 0.1, far: 200 } } },
    { id: 'table-0001', components: { transform: T([-2, 0, 0]), model: { asset: { assetId: 'model-socket' } }, animator: { controller: 'ctl-slide' } } },
    { id: 'gem-0001', components: { transform: T([5, 5, 5]), box: { size: [0.2, 0.2, 0.2], material: { color: '#3366ff' } }, socketAttach: { target: 'table-0001', node: 'hand', position: [0, 0.25, 0] } } },
    { id: 'rider-0001', components: { transform: T([-4, 1, 0]), box: { size: [0.3, 0.3, 0.3], material: { color: '#33aa55' } } } },
    { id: 'director-0001', components: { transform: T([0, -5, 0]), behavior: { behaviorId: 'director', values: {} } } },
    ...extra,
  ];
  return { snapshotId: `${id}@r1`, projectId: id, revision: 1, scene: { schemaVersion: 4, sceneId: 'scene-main', revision: 1, entities }, animators: [CONTROLLER], rigs: { 'model-socket': RIG } };
}

const PATTERN = [1, 2, 1, 0, 3, 1, 1, 2, 0, 1];

async function run(mode: Mode, snap: Any, physics: Any, settings: Any, steps: number): Promise<{ h: Harness; digests: string[]; obs: Map<number, Any> }> {
  const h = await startHarness(mode, { snapshot: snap, settings, physics, behaviors: [behaviorModule('director', DIRECTOR)], replay: Array.from({ length: steps + 40 }, (_, s) => ({ stepIndex: s, moveX: 0, jump: 'none' })), digestSteps: true, storage: true, host: { buildId: 'b', container: new FakeNode() } });
  let now = 10;
  await h.tick(now);
  const obs = new Map<number, Any>();
  let i = 0;
  while (h.digests.length < steps) {
    const n = PATTERN[i++ % PATTERN.length]!;
    now += n * DT + DT * 0.1 * ((i % 3) - 1);
    await h.tick(now);
    const o = h.host.observe();
    if (o.ok) obs.set(o.observation.stepIndex, { alpha: (h.rt.getInterpolatedState() as Any).state?.alpha ?? 0, sockets: o.observation.sockets ?? [] });
  }
  return { h, digests: [...h.digests], obs };
}

function firstDiff(a: string[], b: string[]): number {
  const n = Math.min(a.length, b.length);
  return a.slice(0, n).findIndex((d, k) => d !== b[k]);
}

/** The clip time of the slide after `step` completed steps (speed 1 until step 240, then 0.5). */
function clipTime(step: number): number {
  const t = step <= 240 ? step / HZ : 240 / HZ + (step - 240) / (2 * HZ);
  return t % 4;
}

async function check(snap: Any, physics: Any, settings: Any): Promise<void> {
  const a = await run('single', snap, physics, settings, 500);
  const b = await run('single', snap, physics, settings, 500);
  const w = await run('worker', snap, physics, settings, 500);
  try {
    expect(firstDiff(a.digests, b.digests), 'first differing step (two page runs)').toBe(-1);
    expect(firstDiff(a.digests, w.digests), 'first differing step (page vs worker)').toBe(-1);
    let compared = 0;
    for (const [step, o] of a.obs) {
      if (!w.obs.has(step)) continue;
      expect(w.obs.get(step).sockets, `sockets at step ${step}`).toEqual(o.sockets);
      compared += 1;
    }
    expect(compared).toBeGreaterThan(100);
    const gemAt = (step: number): number[] | null => {
      for (let s = step; s < step + 4; s += 1) {
        const o = a.obs.get(s);
        const g = o?.sockets.find((x: Any) => x.entityId === 'gem-0001');
        if (g !== undefined && o.alpha === 0) return [s, ...g.position];
        if (g !== undefined) return [s - 1 + o.alpha, ...g.position];
      }
      return null;
    };
    // The gem sits on `hand` + 0.25 up: table [-2, 0, 0] + [t, 0.5, 0.5] + [0, 0.25, 0], t the clip time.
    for (const step of [20, 120, 200, 300, 400]) {
      const g = gemAt(step)!;
      expect(g, `gem near step ${step}`).not.toBeNull();
      expect(g[1]!).toBeCloseTo(-2 + clipTime(g[0]!), 3);
      expect(g[2]!).toBeCloseTo(0.75, 9);
      expect(g[3]!).toBeCloseTo(0.5, 9);
    }
    // The clip rate: 1 m/s before the speed change, 0.5 m/s after (measured on the gem's world x).
    const early = [gemAt(40)!, gemAt(160)!];
    const late = [gemAt(260)!, gemAt(380)!];
    const rate = (p: number[][]): number => ((p[1]![1]! - p[0]![1]!) / (p[1]![0]! - p[0]![0]!)) * HZ;
    expect(rate(early)).toBeCloseTo(1, 3);
    expect(rate(late)).toBeCloseTo(0.5, 3);
    // The rider rode on `arm` (+0.1 up) from step 60 until its snap-back detach at 450.
    const riderAt = (step: number): number[] | undefined => a.obs.get(step)?.sockets.find((x: Any) => x.entityId === 'rider-0001')?.position;
    const riding = [...a.obs.entries()].filter(([s, o]) => s > 70 && s < 440 && o.sockets.some((x: Any) => x.entityId === 'rider-0001'));
    expect(riding.length).toBeGreaterThan(50);
    for (const [, o] of riding) expect(o.sockets.find((x: Any) => x.entityId === 'rider-0001').position[1]).toBeCloseTo(0.6, 9);
    expect(riderAt(40)).toBeUndefined();
    // After the detaches nothing is on a socket; the gem stayed where it was let go, the rider went back to its own place.
    const last = [...a.obs.entries()].filter(([s]) => s > 455);
    expect(last.length).toBeGreaterThan(5);
    for (const [, o] of last) expect(o.sockets).toEqual([]);
    const pos = (id: string): number[] => {
      const p = [0, 0, 0];
      a.h.rt.readInterpolated(id, p, [0, 0, 0, 1], [1, 1, 1]);
      return p;
    };
    const gemEnd = pos('gem-0001');
    expect(gemEnd[0]).toBeCloseTo(-2 + clipTime(420), 6);
    expect(gemEnd[1]).toBeCloseTo(0.75, 9);
    expect(pos('rider-0001')).toEqual([-4, 1, 0]);
    // The script read the hand's world pose and saw its checks hold (a save value, identical in the worker).
    expect(await a.h.storage()).toMatchObject({ checked: true });
    expect(await w.h.storage()).toMatchObject({ checked: true });
  } finally {
    await a.h.dispose();
    await b.h.dispose();
    await w.h.dispose();
  }
}

describe('phase 23.11: sockets are resolved in the simulation (two runs, page and worker)', () => {
  it('2D plane: an authored socket follows the animated node, a scripted one rides and snaps back, speed halves the rate', async () => {
    await check(snapshot([], 'sock2d'), null, { gravity_y: -20, run_speed: 5, jump_velocity: 8, max_fall_speed: -20, max_slope_climb_deg: 45, min_slope_slide_deg: 30 });
  }, 180_000);

  it('3D: the same with a 3D physics world stepping beside it', async () => {
    const settings = { gravity_y: -19.62, run_speed: 4, jump_velocity: 7, max_fall_speed: -30, max_slope_climb_deg: 45, min_slope_slide_deg: 30, physics_dimension: 3 };
    const extra = [
      { id: 'player-0001', components: { transform: T([6, 0.91, 0]), controller: {} } },
      { id: 'floor-0001', components: { transform: T([0, -0.5, 0]), box: { size: [30, 1, 30], material: { color: '#888888' } }, collider: { shape: { type: 'box', hx: 15, hy: 0.5, hz: 15 } } } },
    ];
    const snap = snapshot(extra, 'sock3d');
    await check(snap, physics3DConfigOf(snap.scene.entities, settings), settings);
  }, 180_000);
});
