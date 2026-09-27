/**
 * Phase 23.4: the camera framework is simulation state — a neutral 3D scene
 * (physics_dimension 3) with a follow camera on the player (pulled in by a
 * wall behind it), an orbit-a-point camera turned in snapped steps by a
 * recorded input action, and a rail camera on a camera path, directed by a
 * script (`ctx.camera`: activate with an eased 1 s blend, the rail, a shake,
 * deactivate at the rail's end). Run twice in the page and once in the
 * simulation worker (the game-host worker core) from the same recorded input,
 * every step's digest — the resolved camera included — is identical; the
 * camera the renderer gets (the host's observation) agrees frame by frame.
 * A 2D platformer game keeps its cameraFollow view until a virtual camera is
 * activated and blends back to it afterwards, the same in page and worker.
 */
import { describe, expect, it } from 'vitest';

import { physics3DConfigOf } from '@thirdlight/runtime';

import { FakeNode, behaviorModule, startHarness, type Harness, type Mode } from '../m22-worker/harness';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;
const HZ = 120;
const DT = 1 / HZ;
const T = (position: number[], rotation: number[] = [0, 0, 0, 1]) => ({ position, rotation, scale: [1, 1, 1] });
const SETTINGS_3D = { gravity_y: -19.62, run_speed: 4, jump_velocity: 7, max_fall_speed: -30, max_slope_climb_deg: 45, min_slope_slide_deg: 30, physics_dimension: 3 };

/** The director: an eased orbit at step 60, a snapped turn by script, the rail at 400, a shake, and back when the rail ends. */
const DIRECTOR = `
export default {
  instantiate() { return { ended: false, ray: null }; },
  step(state, ctx) {
    const cam = ctx.camera;
    const s = ctx.stepIndex;
    if (s === 60) cam.activate('cam-orbit', { blend: 'eased', time: 1 });
    if (s === 330) cam.turn('cam-orbit', -1);
    if (s === 400) cam.activate('cam-rail');
    if (s === 420) cam.shake(0.3, 0.5);
    if (s === 440) cam.set('cam-rail', { railSpeed: 12 });
    const rail = cam.get('cam-rail');
    if (!state.ended && cam.live() === 'cam-rail' && !cam.blending() && rail !== null && rail.progress >= 1) {
      state.ended = true;
      cam.deactivate('cam-rail', { blend: 'linear', time: 0.5 });
      cam.deactivate('cam-orbit', { blend: 'linear', time: 0.5 });
    }
  },
};
`;

function scene3d(): { snapshot: Any; physics: Any } {
  const entities: Any[] = [
    { id: 'cam-main', components: { transform: T([0, 6, 16]), camera: { type: 'perspective', fovY: 50, near: 0.1, far: 200 } } },
    { id: 'player-0001', components: { transform: T([0, 0.91, 0]), controller: {} } },
    { id: 'floor-0001', components: { transform: T([0, -0.5, 0]), box: { size: [30, 1, 30], material: { color: '#888888' } }, collider: { shape: { type: 'box', hx: 15, hy: 0.5, hz: 15 } } } },
    // A wall behind the player (between it and the follow camera).
    { id: 'wall-0001', components: { transform: T([0, 2, 3]), box: { size: [6, 4, 0.4], material: { color: '#aa6644' } }, collider: { shape: { type: 'box', hx: 3, hy: 2, hz: 0.2 } } } },
    { id: 'cam-follow', components: { transform: T([0, 2, 6]), virtualCamera: { rig: 'follow', target: 'player-0001', targetOffset: [0, 0.8, 0], distance: 6, pitch: 15, yawAction: 'look', collisionRadius: 0.2 } } },
    { id: 'cam-orbit', components: { transform: T([0, 0, 0]), virtualCamera: { rig: 'orbitPoint', enabled: false, point: [0, 0, 0], distance: 14, pitch: 50, yawStep: 90, turnTime: 0.25, turnLeftAction: 'turnLeft', fovY: 40 } } },
    { id: 'cam-rail', components: { transform: T([0, 0, 0]), virtualCamera: { rig: 'rail', enabled: false, path: 'track-0001', target: 'player-0001', railSpeed: 6, blend: 'cut', letterbox: 0.12 } } },
    { id: 'track-0001', components: { transform: T([-8, 3, -6]), cameraPath: { points: [[0, 0, 0], [8, 1, -2], [16, 0, 0]] } } },
    { id: 'director-0001', components: { transform: T([0, -5, 0]), behavior: { behaviorId: 'director', values: {} } } },
  ];
  return {
    snapshot: { snapshotId: 'cam3d@r1', projectId: 'cam3d', revision: 1, scene: { schemaVersion: 4, sceneId: 'scene-main', revision: 1, entities }, game: null },
    physics: physics3DConfigOf(entities, SETTINGS_3D),
  };
}

/** The recorded input: look right for 40 steps, then two turn-left presses on the orbit camera. */
function recording(): Any[] {
  const frames: Any[] = [];
  for (let s = 0; s < 1200; s += 1) {
    const actions: Record<string, Any> = {};
    if (s >= 10 && s < 50) actions['look'] = { v: 0.5, x: 0.5, y: 0, p: 'held' };
    if (s === 200 || s === 260) actions['turnLeft'] = { v: 1, p: 'pressed' };
    if (s === 201 || s === 261) actions['turnLeft'] = { v: 0, p: 'released' };
    frames.push({ stepIndex: s, moveX: 0, jump: 'none', actions });
  }
  return frames;
}

const PATTERN = [1, 2, 1, 0, 3, 1, 1, 2, 0, 1];

async function run(mode: Mode, snapshot: Any, physics: Any, settings: Any, steps: number, game: boolean): Promise<{ h: Harness; digests: string[]; views: Map<number, Any>; bars: Map<number, string> }> {
  const container = new FakeNode();
  const h = await startHarness(mode, { snapshot, settings, physics, behaviors: [behaviorModule('director', DIRECTOR)], replay: recording(), digestSteps: true, host: { buildId: 'b', container } });
  let now = 10;
  await h.tick(now);
  if (game) {
    const started = h.host.control('start');
    if (!started.ok) throw new Error(JSON.stringify(started.error));
  }
  const views = new Map<number, Any>();
  const bars = new Map<number, string>();
  let i = 0;
  while (h.digests.length < steps) {
    const n = PATTERN[i++ % PATTERN.length]!;
    now += n * DT + DT * 0.1 * ((i % 3) - 1);
    await h.tick(now);
    const obs = game ? h.host.observe() : h.host.observeScene!();
    if (obs.ok) {
      views.set(obs.observation.stepIndex, obs.observation.camera ?? null);
      // The letterbox bars the host draws (their style), after this frame.
      const top = container.children.find((c: Any) => c.attrs['data-tl-letterbox'] === 'top');
      bars.set(obs.observation.stepIndex, top?.style?.cssText ?? '');
    }
  }
  return { h, digests: [...h.digests], views, bars };
}

function firstDiff(a: string[], b: string[]): number {
  const n = Math.min(a.length, b.length);
  return a.slice(0, n).findIndex((d, k) => d !== b[k]);
}

describe('phase 23.4: the camera is resolved in the simulation (two runs, page and worker)', () => {
  it('3D: follow → eased orbit → snapped turns → rail → back, identical step digests and camera frames', async () => {
    const { snapshot, physics } = scene3d();
    const a = await run('single', snapshot, physics, SETTINGS_3D, 900, false);
    const b = await run('single', snapshot, physics, SETTINGS_3D, 900, false);
    const w = await run('worker', snapshot, physics, SETTINGS_3D, 900, false);
    try {
      expect(firstDiff(a.digests, b.digests), 'first differing step (two page runs)').toBe(-1);
      expect(firstDiff(a.digests, w.digests), 'first differing step (page vs worker)').toBe(-1);
      // The host's camera frames agree at every step both observed.
      let compared = 0;
      for (const [step, view] of a.views) {
        if (!w.views.has(step)) continue;
        expect(w.views.get(step), `camera at step ${step}`).toEqual(view);
        compared += 1;
      }
      expect(compared).toBeGreaterThan(200);
      const at = (step: number): Any => {
        for (let s = step; s < step + 4; s += 1) if (a.views.has(s)) return a.views.get(s);
        throw new Error(`no view near step ${step}`);
      };
      // Follow: live from the start, turned by the look input, pulled in front of the wall (z 2.8).
      const early = at(14);
      expect(early.live).toBe('cam-follow');
      expect(early.position[2]).toBeLessThan(2.81);
      // The eased blend to the orbit camera: under way at about half time, done after 1 s.
      const mid = at(121);
      expect(mid.live).toBe('cam-orbit');
      expect(mid.blend).toMatchObject({ from: 'cam-follow', style: 'eased' });
      expect(mid.blend.progress).toBeGreaterThan(0.4);
      expect(mid.blend.progress).toBeLessThan(0.6);
      const orbit = at(190);
      expect(orbit.blend).toBeNull();
      expect(orbit.fovY).toBeCloseTo(40, 9);
      // Two snapped quarter turns on input (and one back by script): a quarter turn left overall.
      const turned = at(380);
      const off = [turned.position[0], turned.position[2]];
      expect(Math.hypot(off[0], off[1])).toBeCloseTo(14 * Math.cos((50 * Math.PI) / 180), 6);
      expect(off[0]).toBeCloseTo(14 * Math.cos((50 * Math.PI) / 180), 6); // yaw 90: on +X
      // The rail cut in with its letterbox, then the view blended back to the scene camera at its end.
      const rail = at(430);
      expect(rail.live).toBe('cam-rail');
      expect(rail.letterbox).toBeCloseTo(0.12, 12);
      // The host draws the letterbox over the view: two bars, each 12% of the height (in page and worker).
      const barAt = (step: number): string => { for (let k = step; k < step + 4; k += 1) if (a.bars.has(k)) return a.bars.get(k)!; return ''; };
      expect(barAt(14)).toBe('');
      expect(barAt(430)).toContain('height:12%');
      expect(barAt(430)).toContain('top:0');
      expect(barAt(880)).toContain('display:none');
      for (const [step, style] of w.bars) if (a.bars.has(step)) expect(style, `bars at ${step}`).toBe(a.bars.get(step));
      expect(rail.shake).toBeGreaterThan(0);
      const end = at(880);
      expect(end.live).toBe('cam-follow');
      expect(end.blend).toBeNull();
      expect(end.letterbox).toBe(0);
    } finally {
      await a.h.dispose();
      await b.h.dispose();
      await w.h.dispose();
    }
  }, 180_000);

  it('2D: the cameraFollow view until a virtual camera goes live, blended back to it after, alike in page and worker', async () => {
    const entities: Any[] = [
      { id: 'cam-main', components: { transform: T([0, 4, 12]), camera: { type: 'perspective', fovY: 45, near: 0.1, far: 200 }, cameraFollow: { deadZone: { x: 0.5, y: 0.5 }, smoothing: 0.2 } } },
      { id: 'player-0001', components: { transform: T([0, 0.91, 0]), controller: {} } },
      { id: 'spawn-0001', components: { transform: T([0, 0.91, 0]), playerSpawn: {} } },
      { id: 'floor-0001', components: { transform: T([0, -0.5, 0]), box: { size: [40, 1, 2], material: { color: '#888888' } }, collider: { shape: { type: 'box', hx: 20, hy: 0.5 } } } },
      { id: 'cam-orbit', components: { transform: T([0, 0, 0]), virtualCamera: { rig: 'orbitPoint', enabled: false, target: 'player-0001', distance: 10, pitch: 30, yaw: 20, turnLeftAction: 'turnLeft' } } },
      { id: 'cam-rail', components: { transform: T([0, 0, 0]), virtualCamera: { rig: 'rail', enabled: false, path: 'track-0001', railSpeed: 10, blend: 'linear', blendTime: 0.25 } } },
      { id: 'track-0001', components: { transform: T([-4, 3, 10]), cameraPath: { points: [[0, 0, 0], [8, 0, 0]], smooth: false } } },
      { id: 'director-0001', components: { transform: T([0, -5, 0]), behavior: { behaviorId: 'director', values: {} } } },
    ];
    const settings = { run_speed: 5, jump_velocity: 8, gravity_y: -20, max_fall_speed: -20, max_slope_climb_deg: 45, min_slope_slide_deg: 30 };
    const snapshot = {
      snapshotId: 'cam2d@r1',
      projectId: 'cam2d',
      revision: 1,
      scene: { schemaVersion: 4, sceneId: 'scene-main', revision: 1, entities },
      game: { configVersion: 2, title: 'Cameras', objective: 'o', instructions: 'i', playerId: 'player-0001', cameraId: 'cam-main', spawnId: 'spawn-0001', cues: { start: null, jump: null, checkpoint: null, death: null, goal: null } },
    };
    const physics = {
      character: { x: 0, y: 0.91 },
      statics: [{ entityId: 'floor-0001', shape: { type: 'box', hx: 20, hy: 0.5 }, position: { x: 0, y: -0.5 }, rotationZ: 0 }],
      solver: { hz: HZ, gravityY: settings.gravity_y },
      controller: { offsetSkin: 0.01, groundSnap: 0.1, maxSlopeClimbRad: Math.PI / 4, minSlopeSlideRad: Math.PI / 6, autostep: false },
    };
    const a = await run('single', snapshot, physics, settings, 900, true);
    const w = await run('worker', snapshot, physics, settings, 900, true);
    try {
      expect(firstDiff(a.digests, w.digests), 'first differing step (page vs worker)').toBe(-1);
      const views = [...a.views.entries()].sort((x, y) => x[0] - y[0]);
      const before = views.find(([s]) => s > 20 && s < 55)![1];
      // No virtual camera live yet: the view is the scene camera's (its follow pose).
      expect(before.live).toBeNull();
      const mainAt = a.h.rt.getInterpolatedState().state.transforms.find((t: Any) => t.id === 'cam-main');
      expect(mainAt).toBeDefined();
      const orbit = views.find(([s]) => s > 200 && s < 230)![1];
      expect(orbit.live).toBe('cam-orbit');
      const rail = views.find(([s]) => s > 470 && s < 490)![1];
      expect(rail.live).toBe('cam-rail');
      // The rail ended: both virtual cameras off, the view blended back to the follow camera's pose.
      const last = views[views.length - 1]![1];
      expect(last.live).toBeNull();
      expect(last.blend).toBeNull();
      expect(last.position[0]).toBeCloseTo(mainAt.position[0], 6);
      expect(last.position[1]).toBeCloseTo(mainAt.position[1], 6);
      expect(last.position[2]).toBeCloseTo(mainAt.position[2], 6);
    } finally {
      await a.h.dispose();
      await w.h.dispose();
    }
  }, 180_000);
});
