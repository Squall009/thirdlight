/**
 * Script audio is simulation state. A neutral 3D scene (scene
 * mode, physics_dimension 3) with a script that starts a positional loop on
 * a moving entity, plays a one-shot, changes the loop's pitch, fades and
 * stops it, sets music, plays a stinger (the music ducks under it) and
 * releases the music — and answers every finished event (seen the step
 * after) with another sound. Run twice in the page and once in the
 * simulation worker (the game-host worker core) from the same recorded
 * input: the step digests (the audio intent log included) and the command
 * stream the host's audio engine receives are identical, and the finished
 * events arrive on the steps the clip lengths and fades predict.
 */
import { describe, expect, it } from 'vitest';

import { physics3DConfigOf } from '@thirdlight/runtime';

import { behaviorModule, startHarness, type Harness, type Mode } from '../m22-worker/harness';

type Any = any;
const HZ = 120;
const DT = 1 / HZ;
const T = (position: number[]) => ({ position, rotation: [0, 0, 0, 1], scale: [1, 1, 1] });
const SETTINGS_3D = { gravity_y: -19.62, run_speed: 4, jump_velocity: 7, max_fall_speed: -30, max_slope_climb_deg: 45, min_slope_slide_deg: 30, physics_dimension: 3 };

const SOUNDS = `
export default {
  instantiate() { return { last: -1, loop: 0, bark: 0, sting: 0, ends: [] }; },
  step(state, ctx) {
    const s = ctx.stepIndex;
    if (state.last === s) return;
    state.last = s;
    const a = ctx.audio;
    for (const e of a.events()) {
      state.ends.push([s, e.handle, e.reason]);
      a.play('asset-done', { volume: 0.5 });
    }
    if (s === 20) state.loop = a.play('asset-hum', { loop: true, volume: 0.8, entityId: 'cart-0001', position: [0, 1, 0], distanceModel: 'inverse', refDistance: 2 });
    if (s === 30) state.bark = a.play('asset-bark');
    if (s === 80) a.setPitch(state.loop, 1.5);
    if (s === 120) a.fade(state.loop, 0.2, 0.5);
    if (s === 200) a.stop(state.loop, 0.25);
    if (s === 250) { a.music('asset-theme', 0.5); state.sting = a.stinger('asset-sting', { duck: 0.25 }); }
    if (s === 400) a.releaseMusic(1);
  },
};
`;

function scene(): { snapshot: Any; physics: Any } {
  const entities: Any[] = [
    { id: 'cam-main', components: { transform: T([0, 4, 12]), camera: { type: 'perspective', fovY: 50, near: 0.1, far: 200 } } },
    { id: 'player-0001', components: { transform: T([0, 0.91, 0]), controller: {} } },
    { id: 'floor-0001', components: { transform: T([0, -0.5, 0]), box: { size: [30, 1, 30], material: { color: '#888888' } }, collider: { shape: { type: 'box', hx: 15, hy: 0.5, hz: 15 } } } },
    { id: 'cart-0001', components: { transform: T([4, 0.5, 0]), box: { size: [1, 1, 1], material: { color: '#aa6644' } }, collider: { shape: { type: 'box', hx: 0.5, hy: 0.5, hz: 0.5 } }, mover: { waypoints: [[-8, 0, 0]], speed: 2, mode: 'pingpong' } } },
    { id: 'sounds-0001', components: { transform: T([0, -5, 0]), behavior: { behaviorId: 'sounds', values: {} } } },
  ];
  return {
    snapshot: {
      snapshotId: 'audio3d@r1',
      projectId: 'audio3d',
      revision: 1,
      scene: { schemaVersion: 4, sceneId: 'scene-main', revision: 1, entities },
      // The recorded lengths: the bark 250 ms (30 steps), the stinger 1 s (120 steps).
      audioDurations: { 'asset-hum': 400, 'asset-bark': 250, 'asset-sting': 1000, 'asset-done': 100 },
    },
    physics: physics3DConfigOf(entities, SETTINGS_3D),
  };
}

function recording(): Any[] {
  const frames: Any[] = [];
  for (let s = 0; s < 700; s += 1) frames.push({ stepIndex: s, moveX: s > 100 && s < 160 ? 0.5 : 0, jump: 'none' });
  return frames;
}

const PATTERN = [1, 2, 1, 0, 3, 1, 1, 2, 0, 1];

async function run(mode: Mode): Promise<{ h: Harness; digests: string[]; commands: Any[] }> {
  const { snapshot, physics } = scene();
  const h = await startHarness(mode, { snapshot, settings: SETTINGS_3D, physics, behaviors: [behaviorModule('sounds', SOUNDS)], replay: recording(), digestSteps: true });
  let now = 10;
  await h.tick(now);
  let i = 0;
  while (h.digests.length < 600) {
    const n = PATTERN[i++ % PATTERN.length]!;
    now += n * DT + DT * 0.1 * ((i % 3) - 1);
    await h.tick(now);
  }
  return { h, digests: [...h.digests], commands: h.audioCommands.filter((c: Any) => c.stepIndex < 590).map((c: Any) => JSON.parse(JSON.stringify(c))) };
}

function firstDiff(a: string[], b: string[]): number {
  const n = Math.min(a.length, b.length);
  return a.slice(0, n).findIndex((d, k) => d !== b[k]);
}

describe('script audio is simulation state (two page runs and the worker)', () => {
  it('identical step digests and command streams; finished events on the predicted steps', async () => {
    const a = await run('single');
    const b = await run('single');
    const w = await run('worker');
    try {
      expect(firstDiff(a.digests, b.digests), 'first differing step (two page runs)').toBe(-1);
      expect(firstDiff(a.digests, w.digests), 'first differing step (page vs worker)').toBe(-1);
      expect(b.commands).toEqual(a.commands);
      expect(w.commands).toEqual(a.commands);
      const ops = a.commands.map((c: Any) => `${c.stepIndex}:${c.op}${c.op === 'play' ? `:${c.assetId}` : ''}`);
      // Handles in play order; the loop is positional on the cart; the stinger ducks the music and the duck ends with it.
      const loop = a.commands.find((c: Any) => c.op === 'play' && c.assetId === 'asset-hum');
      expect(loop).toMatchObject({ handle: 1, loop: true, volume: 0.8, entityId: 'cart-0001', position: [0, 1, 0], spatial: { distanceModel: 'inverse', refDistance: 2, maxDistance: 30, rolloff: 1 } });
      expect(a.commands.find((c: Any) => c.op === 'set')).toMatchObject({ stepIndex: 80, handle: 1, pitch: 1.5 });
      expect(a.commands.find((c: Any) => c.op === 'fade')).toMatchObject({ stepIndex: 120, handle: 1, to: 0.2, seconds: 0.5 });
      expect(a.commands.find((c: Any) => c.op === 'stop')).toMatchObject({ stepIndex: 200, handle: 1, fade: 0.25 });
      // The bark (30 steps from step 30) ends at the end of step 59: seen in step 60, answered with a sound.
      expect(ops).toContain('60:play:asset-done');
      // The stopped loop: the 0.25 s fade (30 steps) from step 200 ends at the end of 229, seen in 230.
      expect(ops).toContain('230:play:asset-done');
      expect(a.commands.filter((c: Any) => c.op === 'music')).toEqual([
        { op: 'music', stepIndex: 250, assetId: 'asset-theme', fade: 0.5 },
        { op: 'music', stepIndex: 400, assetId: null, fade: 1, release: true },
      ]);
      expect(a.commands.filter((c: Any) => c.op === 'duck').map((c: Any) => [c.stepIndex, c.level])).toEqual([[250, 0.25], [369, 1]]);
      // The stinger (120 steps from step 250) ends at the end of 369, seen in 370.
      expect(ops).toContain('370:play:asset-done');
    } finally {
      await a.h.dispose();
      await b.h.dispose();
      await w.h.dispose();
    }
  }, 180_000);
});
