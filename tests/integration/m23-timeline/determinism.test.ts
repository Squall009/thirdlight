/**
 * Phase 23.17: timelines are simulation state across the worker boundary.
 *
 * A neutral scene (the scene camera, three virtual cameras — two fixed and a
 * rail on a camera path —, a box) and a director script: at step 30 it plays
 * a six-shot timeline binding its actor slot (camera cuts and blends, a rail
 * ride, a transform move, a music change, a signal at a marker the script
 * counts, a fade and a letterbox, a wait-for-input key); at step 800 it plays
 * the same timeline again, which the recorded input skips mid-way. The
 * recording presses `confirm` at step 300 (the wait) and `skip` at step 900.
 *
 * Two page runs and one simulation-worker run give identical step digests
 * (the timeline state included); the host observes the same cameras, fade and
 * letterbox; the skip ends in the end state (camera released, the box at its
 * last key, the last music, the signal fired again).
 */
import { describe, expect, it } from 'vitest';

import { FakeNode, behaviorModule, startHarness, type Mode } from '../m22-worker/harness';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;
const HZ = 120;
const DT = 1 / HZ;
const T = (position: number[]) => ({ position, rotation: [0, 0, 0, 1], scale: [1, 1, 1] });

const DIRECTOR = `
export default {
  instantiate() { return { h: 0, h2: 0 }; },
  step(state, ctx) {
    if (ctx.phase !== 'intent') return;
    const s = ctx.stepIndex;
    const tl = ctx.timeline;
    if (s === 30) state.h = tl.play('shots', { actor: 'actor-0001' });
    if (s === 800) state.h2 = tl.play('shots');
    if (ctx.signals.on('gate')) ctx.game.add('gate', 1);
    if (tl.marker('gate')) ctx.game.add('marks', 1);
    for (const e of tl.events()) if (e.kind === 'ended') ctx.game.add(e.reason, 1);
    if (state.h > 0 && tl.state(state.h) === 'waiting') ctx.game.add('waited', 1);
  },
};
`;

export const SHOTS = {
  timelineId: 'shots',
  name: 'Shots',
  duration: 4,
  slots: [{ name: 'actor', entity: 'actor-0001' }, { name: 'wide', entity: 'cam-a' }, { name: 'close', entity: 'cam-b' }, { name: 'rail', entity: 'cam-rail' }],
  markers: [{ name: 'gate', time: 1.5 }],
  skipAction: 'skip',
  tracks: [
    { trackId: 'cams', type: 'camera', endBlend: 'eased', endBlendTime: 0.3, keys: [{ time: 0, camera: 'wide' }, { time: 0.5, camera: 'close', blend: 'eased', blendTime: 0.3 }, { time: 1, camera: 'rail', progress: [0, 1] }, { time: 2.5, camera: 'wide', blend: 'linear', blendTime: 0.4 }] },
    { trackId: 'move', type: 'transform', target: 'actor', keys: [{ time: 0, position: [0, 0.5, 0] }, { time: 2, position: [3, 0.5, 0], easing: 'easeInOut' }] },
    { trackId: 'music', type: 'audio', keys: [{ time: 0, kind: 'music', asset: 'calm-music', fade: 0.5 }, { time: 2.2, kind: 'music', asset: 'tense-music', fade: 1 }] },
    { trackId: 'sig', type: 'signal', keys: [{ time: 1.5, name: 'gate' }] },
    { trackId: 'hold', type: 'wait', keys: [{ time: 1, action: 'confirm' }] },
    { trackId: 'fade', type: 'fade', keys: [{ time: 0, value: 1 }, { time: 0.5, value: 0 }, { time: 3.5, value: 0 }, { time: 4, value: 1 }] },
    { trackId: 'bars', type: 'letterbox', keys: [{ time: 0, value: 0.1 }] },
  ],
};

function snapshot(): Any {
  const entities: Any[] = [
    { id: 'cam-main', components: { transform: T([0, 4, 12]), camera: { type: 'perspective', fovY: 50, near: 0.1, far: 200 } } },
    { id: 'actor-0001', components: { transform: T([-2, 0.5, 0]), box: { size: [1, 1, 1], material: { color: '#88aacc' } } } },
    { id: 'cam-a', components: { transform: T([0, 3, 10]), virtualCamera: { rig: 'fixed', enabled: false, target: 'actor-0001' } } },
    { id: 'cam-b', components: { transform: T([2, 1.5, 3]), virtualCamera: { rig: 'fixed', enabled: false, target: 'actor-0001', fovY: 35 } } },
    { id: 'cam-rail', components: { transform: T([0, 0, 0]), virtualCamera: { rig: 'rail', enabled: false, path: 'path-0001', target: 'actor-0001' } } },
    { id: 'path-0001', components: { transform: T([-6, 2, 6]), cameraPath: { points: [[0, 0, 0], [6, 1, -2], [12, 0, 0]] } } },
    { id: 'director-0001', components: { transform: T([0, -5, 0]), behavior: { behaviorId: 'director', values: {} } } },
  ];
  return { snapshotId: 'tl@r1', projectId: 'tl', revision: 1, scene: { schemaVersion: 4, sceneId: 'scene-main', revision: 1, entities }, game: null, timelines: [SHOTS] };
}

function recording(): Any[] {
  const frames: Any[] = [];
  for (let s = 0; s < 1400; s += 1) {
    const actions: Record<string, Any> = {};
    if (s === 300) actions['confirm'] = { v: 1, p: 'pressed' };
    if (s === 301) actions['confirm'] = { v: 0, p: 'released' };
    if (s === 900) actions['skip'] = { v: 1, p: 'pressed' };
    if (s === 901) actions['skip'] = { v: 0, p: 'released' };
    frames.push({ stepIndex: s, moveX: 0, jump: 'none', actions });
  }
  return frames;
}

const PATTERN = [1, 2, 1, 0, 3, 1, 1, 2, 0, 1];

async function run(mode: Mode): Promise<{ digests: string[]; obs: Map<number, Any>; fade: Map<number, string>; music: string[]; dispose: () => Promise<void> }> {
  const container = new FakeNode();
  const h = await startHarness(mode, { snapshot: snapshot(), settings: {}, physics: null, behaviors: [behaviorModule('director', DIRECTOR)], replay: recording(), digestSteps: true, host: { buildId: 'b', container } });
  let now = 10;
  await h.tick(now);
  const obs = new Map<number, Any>();
  const fade = new Map<number, string>();
  let i = 0;
  while (h.digests.length < 1200) {
    now += PATTERN[i++ % PATTERN.length]! * DT;
    await h.tick(now);
    const o = h.host.observeScene!();
    if (!o.ok) continue;
    const st = h.rt.getInterpolatedState();
    const actor = st.ok ? st.state.transforms.find((t: Any) => t.id === 'actor-0001') : undefined;
    obs.set(o.observation.stepIndex, { camera: o.observation.camera ?? null, timeline: o.observation.timeline ?? null, actor: actor?.position ?? null, counters: h.rt.gameCounters?.()?.counters ?? null });
    const node = container.children.find((c: Any) => c.attrs['data-tl-fade'] !== undefined);
    fade.set(o.observation.stepIndex, node?.attrs['data-tl-fade'] ?? '');
  }
  const music = h.audioCommands.filter((c: Any) => c.op === 'music').map((c: Any) => `${c.assetId}@${c.fade}`);
  return { digests: [...h.digests], obs, fade, music, dispose: () => h.dispose() };
}

function firstDiff(a: string[], b: string[]): number {
  const n = Math.min(a.length, b.length);
  return a.slice(0, n).findIndex((d, k) => d !== b[k]);
}

describe('phase 23.17: timelines in page and worker', () => {
  it('identical step digests; cameras, fade, letterbox, wait-for-input and skip end states agree', async () => {
    const a = await run('single');
    const b = await run('single');
    const w = await run('worker');
    try {
      expect(firstDiff(a.digests, b.digests), 'first differing step (two page runs)').toBe(-1);
      expect(firstDiff(a.digests, w.digests), 'first differing step (page vs worker)').toBe(-1);
      const near = (m: Map<number, Any>, step: number): Any => {
        for (let s = step; s < step + 6; s += 1) if (m.has(s)) return m.get(s);
        throw new Error(`nothing observed near step ${step}`);
      };
      let compared = 0;
      for (const [step, o] of a.obs) {
        const x = w.obs.get(step);
        if (x === undefined) continue;
        expect(x.camera?.live ?? null, `live camera at ${step}`).toBe(o.camera?.live ?? null);
        expect(x.timeline?.screen, `screen at ${step}`).toEqual(o.timeline?.screen);
        expect(w.fade.get(step), `drawn fade at ${step}`).toBe(a.fade.get(step));
        compared += 1;
      }
      expect(compared).toBeGreaterThan(300);
      // The first play: black at its start fading in, the wide camera, bars.
      const start = near(a.obs, 32);
      expect(start.camera.live).toBe('cam-a');
      expect(start.timeline.screen.letterbox).toBeCloseTo(0.1, 9);
      expect(start.timeline.screen.opacity).toBeGreaterThan(0.9);
      expect(near(a.fade, 32)).not.toBe('');
      // The eased cut to the close camera at 0.5 s (step 30 + 60).
      const close = near(a.obs, 100);
      expect(close.camera.live).toBe('cam-b');
      expect(close.camera.blend).toMatchObject({ style: 'eased' });
      // Waiting for confirm at 1 s (step 150) until step 300: the rail camera, time held.
      const waiting = near(a.obs, 250);
      expect(waiting.timeline.playing[0]).toMatchObject({ timeline: 'shots', state: 'waiting', wait: 'confirm' });
      expect(waiting.timeline.playing[0].time).toBeCloseTo(1, 9);
      expect(waiting.camera.live).toBe('cam-rail');
      // After confirm: the box eased to x 3 by 2 s, the marker's signal counted once, then the end releases the camera.
      const moved = near(a.obs, 470);
      expect(moved.actor[0]).toBeCloseTo(3, 6);
      expect(moved.counters.gate).toBe(1);
      expect(moved.counters.marks).toBe(1);
      const ended = near(a.obs, 700);
      expect(ended.counters.finished).toBe(1);
      expect(ended.timeline.playing).toEqual([]);
      expect(ended.camera.live).toBeNull();
      // The second play, skipped at step 900 (before its wait): end states at once.
      const skipped = near(a.obs, 905);
      expect(skipped.counters.skipped).toBe(1);
      expect(skipped.counters.gate, 'the signal fires on skip').toBe(2);
      expect(skipped.counters.marks, 'markers after the skip point are not reported').toBe(1);
      expect(skipped.actor[0]).toBeCloseTo(3, 9);
      expect(skipped.camera.live).toBeNull();
      expect(skipped.timeline.screen.opacity).toBe(0);
      expect(skipped.timeline.screen.letterbox).toBe(0);
      for (const r of [a, w]) expect(near(r.obs, 1150).counters).toEqual(near(a.obs, 1150).counters);
      // The music: each play's calm track, its change to the tense one — the skip applied the last music key.
      expect(a.music).toEqual(['calm-music@0.5', 'tense-music@1', 'calm-music@0.5', 'tense-music@1']);
      expect(w.music).toEqual(a.music);
    } finally {
      await a.dispose();
      await b.dispose();
      await w.dispose();
    }
  }, 240_000);
});
