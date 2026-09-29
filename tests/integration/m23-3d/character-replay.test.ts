/**
 * The 3D character controller replays deterministically — a
 * recorded input run over a neutral course (a riser, a ledge with the ledge
 * climb on, a wall, a jump, walking and running in several directions) gives
 * identical step digests over two page runs and in the simulation worker,
 * and ends where the page run ends.
 *
 * Scripts drive the character: `character_move` (a world direction),
 * `character_place` (teleport), `character_enable` (off: it stays put, input
 * ignored), `control_move` with its second axis, and read
 * `ctx.physics.characterState` — the same in the page and the worker.
 */
import { describe, expect, it } from 'vitest';

import type { ActionFrame } from '@thirdlight/runtime';

import { behaviorModule } from '../m22-worker/harness';
import { block, runScene, sceneOf, STAND_Y, T, type Any } from './character-kit';

function course(): { snapshot: Any; physics: Any } {
  return sceneOf({ ledgeClimb: true }, [0, STAND_Y, 0], [
    block('step-1', [3, 0.15, 0], [1, 0.15, 3]),
    block('ledge-1', [5, 0.65, 0], [1, 0.65, 3]),
    block('wall-1', [0, 1.5, -4.25], [4, 1.5, 0.25]),
  ], 'c3r');
}

/** The recorded run: right onto the riser and up the ledge, back, forward into the wall, a jump, a run. */
function recording(): ActionFrame[] {
  const out: ActionFrame[] = [];
  for (let i = 0; i < 900; i += 1) {
    let moveX = 0;
    let moveY = 0;
    let jump: ActionFrame['jump'] = 'none';
    let actions: ActionFrame['actions'];
    if (i < 360) moveX = 1;
    else if (i < 480) moveX = -0.5;
    else if (i < 640) [moveX, moveY] = [-0.3, 0.9];
    else if (i < 700) moveY = -1;
    if (i === 520) jump = 'pressed';
    else if (i > 520 && i < 540) jump = 'held';
    else if (i === 540) jump = 'released';
    if (i >= 700 && i < 820) {
      moveX = -1;
      actions = { run: { v: 1, p: i === 700 ? 'pressed' : 'held' } };
    }
    out.push({ stepIndex: i, moveX, moveY, jump, ...(actions !== undefined ? { actions } : {}) });
  }
  return out;
}

describe('a recorded 3D character run replays identically (page and worker)', () => {
  it('two page runs and the worker produce the same step digests and end in the same place', async () => {
    const STEPS = 960;
    const a = await runScene('single', course(), recording(), STEPS);
    const b = await runScene('single', course(), recording(), STEPS);
    const w = await runScene('worker', course(), recording(), STEPS);
    try {
      expect(a.errors).toEqual([]);
      expect(w.errors).toEqual([]);
      const n = Math.min(a.digests.length, b.digests.length, w.digests.length);
      expect(n).toBeGreaterThanOrEqual(STEPS);
      const diff = (x: string[]) => a.digests.slice(0, n).findIndex((d, k) => d !== x[k]);
      expect(diff(b.digests), 'first differing step (two page runs)').toBe(-1);
      expect(diff(w.digests), 'first differing step (page vs worker)').toBe(-1);
      // It climbed the riser and the ledge (its highest point: on the ledge, 1.3 m up).
      expect(Math.max(...a.path.map((p) => p[1]!))).toBeGreaterThan(1.3 + STAND_Y - 0.02);
      expect(w.player).toEqual(a.player);
    } finally {
      await a.h.dispose();
      await b.h.dispose();
      await w.h.dispose();
    }
  }, 180_000);
});

const DIRECTOR = `
export default {
  instantiate() { return {}; },
  step(state, ctx) {
    if (ctx.phase !== 'intent') return;
    const s = ctx.stepIndex;
    if (s >= 20 && s < 80) ctx.emit({ kind: 'character_move', x: 0, z: 1 });
    if (s === 100) ctx.emit({ kind: 'character_place', position: [-3, 3, 0] });
    if (s === 200) ctx.emit({ kind: 'character_enable', enabled: false });
    if (s >= 200 && s < 260) ctx.emit({ kind: 'control_move', value: 1, y: 0 });
    if (s === 260) ctx.emit({ kind: 'character_enable', enabled: true });
    if (s >= 270 && s < 330) ctx.emit({ kind: 'control_move', value: 0, y: 1 });
    if (s === 90 || s === 190 || s === 250 || s === 320) {
      const st = ctx.physics.characterState('player-0001');
      ctx.log('info', JSON.stringify({ s, p: [st.position.x, st.position.y, st.position.z], v: [st.velocity.x, st.velocity.y, st.velocity.z], g: st.grounded, e: st.enabled, f: st.facing }));
    }
  },
};
`;

function directed(): { snapshot: Any; physics: Any } {
  return sceneOf({}, [0, STAND_Y, 0], [{ id: 'director-1', components: { transform: T([0, 0, 5]), behavior: { behaviorId: 'director', values: {} } } }], 'c3s');
}

function logsOf(errors: Any[]): Any[] {
  return errors.filter((e) => e.code === 'behavior_log').map((e) => JSON.parse(e.message));
}

describe('scripts drive the 3D character (page and worker)', () => {
  it('character_move walks it, character_place teleports it, character_enable freezes it, control_move takes a y; characterState reads it', async () => {
    const director = behaviorModule('director', DIRECTOR);
    const behaviors = [director];
    const a = await runScene('single', directed(), [], 360, { behaviors });
    const w = await runScene('worker', directed(), [], 360, { behaviors });
    try {
      const logs = logsOf(a.errors);
      expect(logs.map((l) => l.s)).toEqual([90, 190, 250, 320]);
      const [walked, placed, frozen, forward] = logs;
      // 60 steps along +z at the walk speed (2 m/s, 0.05 s to reach it): about 1 m, facing +z.
      expect(walked.p[2]).toBeGreaterThan(0.9);
      expect(Math.abs(walked.p[0])).toBeLessThan(1e-3);
      expect(walked.f).toBeCloseTo(0, 6);
      // Teleported to (−3, 3, 0), fell and rests on the floor.
      expect(placed.p[0]).toBeCloseTo(-3, 3);
      expect(placed.p[2]).toBeCloseTo(0, 3);
      expect(placed.p[1]).toBeLessThan(STAND_Y + 0.02);
      expect(placed.g).toBe(true);
      // Switched off: the move intent does nothing.
      expect(frozen.e).toBe(false);
      expect(frozen.p[0]).toBeCloseTo(-3, 3);
      expect(frozen.v).toEqual([0, 0, 0]);
      // On again: control_move's y (forward) walks it along −z at the world-axes default.
      expect(forward.e).toBe(true);
      expect(forward.p[2]).toBeLessThan(-0.7);
      expect(forward.p[0]).toBeCloseTo(-3, 2);
      expect(forward.v[2]).toBeLessThan(-1.9);
      // The worker agrees.
      expect(logsOf(w.errors)).toEqual(logs);
      expect(w.player).toEqual(a.player);
    } finally {
      await a.h.dispose();
      await w.h.dispose();
    }
  }, 120_000);
});
