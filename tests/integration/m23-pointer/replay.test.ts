/**
 * Pointer samples are part of the recorded input, so a replay
 * reproduces what a script did with them — in the page and in the
 * simulation worker alike. A neutral 3D scene without a player (a world
 * without a character: colliders answer queries), three boxes in front of
 * the scene camera, a lamp above each; a script lights the lamp of the box
 * under the pointer (`ctx.physics.pickAtPointer` filtered by a collision
 * layer, hover edges kept in its own state), hides the box it is clicked on
 * (`ctx.input.pointerPressed`), checks a tag-filtered ray and a sphere
 * overlap every step, and asks for a locked cursor. Two page runs and one
 * worker run from the same recording: identical step digests, the same
 * hidden objects at every observed step, and the expected outcome.
 */
import { describe, expect, it } from 'vitest';

import { physics3DConfigOf } from '@thirdlight/runtime';

import { behaviorModule, startHarness, type Harness, type Mode } from '../m22-worker/harness';

type Any = any;
const HZ = 120;
const DT = 1 / HZ;
const T = (position: number[]) => ({ position, rotation: [0, 0, 0, 1], scale: [1, 1, 1] });
const SETTINGS = { gravity_y: -19.62, run_speed: 4, jump_velocity: 7, max_fall_speed: -30, max_slope_climb_deg: 45, min_slope_slide_deg: 30, physics_dimension: 3 };

const PICKER = `
export default {
  instantiate() { return { hover: null, rays: 0, near: 0 }; },
  step(state, ctx) {
    if (ctx.phase !== 'intent') return;
    if (ctx.stepIndex === 0) for (const id of ['lamp-a', 'lamp-b', 'lamp-c']) ctx.game.setVisible(id, false);
    const hit = ctx.physics.pickAtPointer(undefined, { layers: ['pickable'] });
    const id = hit === null ? null : hit.entityId;
    if (id !== state.hover) {
      if (state.hover !== null) ctx.game.setVisible('lamp-' + state.hover.slice(4), false);
      if (id !== null) ctx.game.setVisible('lamp-' + id.slice(4), true);
      state.hover = id;
    }
    if (id !== null && ctx.input.pointerPressed('left')) ctx.game.setVisible(id, false);
    if (ctx.physics.raycast3d([0, 0, 10], [0, 0, -1], 50, { tags: ['wall'] }) !== null) state.rays += 1;
    state.near = ctx.physics.overlapSphere([0, 0, 0], 0.4).length;
    if (ctx.stepIndex === 50) ctx.input.setCursor('locked');
  },
};
`;

function scene(): { snapshot: Any; physics: Any } {
  const box = (id: string, x: number, tags = 0) => ({ id, ...(tags !== 0 ? { tags } : {}), components: { transform: T([x, 0, 0]), box: { size: [1, 1, 1], material: { color: '#8899aa' } }, collider: { shape: { type: 'box', hx: 0.5, hy: 0.5, hz: 0.5 }, layers: ['pickable'] } } });
  const lamp = (id: string, x: number) => ({ id, components: { transform: T([x, 1, 0]), box: { size: [0.2, 0.2, 0.2], material: { color: '#ffee88' } } } });
  const entities: Any[] = [
    { id: 'cam-main', components: { transform: T([0, 0, 10]), camera: { type: 'perspective', fovY: 50, near: 0.1, far: 200 } } },
    box('box-a', -2),
    box('box-b', 0),
    box('box-c', 2),
    lamp('lamp-a', -2),
    lamp('lamp-b', 0),
    lamp('lamp-c', 2),
    // A wall far behind, in the default layer and tagged: the tag-filtered ray reaches it through the boxes.
    { id: 'wall-0001', tags: 1, components: { transform: T([0, 0, -10]), collider: { shape: { type: 'box', hx: 20, hy: 20, hz: 0.5 } } } },
    { id: 'picker-0001', components: { transform: T([0, -50, 0]), behavior: { behaviorId: 'picker', values: {} } } },
  ];
  return {
    snapshot: { snapshotId: 'ptr3d@r1', projectId: 'ptr3d', revision: 1, scene: { schemaVersion: 4, sceneId: 'scene-main', revision: 1, entities }, tags: [{ bit: 0, name: 'wall' }] },
    physics: physics3DConfigOf(entities, SETTINGS, { layers: ['pickable'] }),
  };
}

// Where each box's centre is on screen (16:9, 50° vertical field of view, 10 m away).
const sx = (x: number): number => (x / 10 / (Math.tan((25 * Math.PI) / 180) * (16 / 9)) + 1) / 2;
const q4 = (v: number): number => Math.round(v * 1e4) / 1e4;

/** The recording: hover b, move to c, click c, move to a, leave the view, come back over b; sparse frames (the pointer holds between them). */
function recording(): Any[] {
  return [
    { stepIndex: 20, moveX: 0, jump: 'none', pointer: { x: 0.5, y: 0.5 } },
    { stepIndex: 40, moveX: 0, jump: 'none', pointer: { x: q4(sx(2)), y: 0.5, dx: q4(sx(2) - 0.5) } },
    { stepIndex: 60, moveX: 0, jump: 'none', pointer: { x: q4(sx(2)), y: 0.5, buttons: 1 } },
    { stepIndex: 61, moveX: 0, jump: 'none', pointer: { x: q4(sx(2)), y: 0.5 } },
    { stepIndex: 80, moveX: 0, jump: 'none', pointer: { x: q4(sx(-2)), y: 0.5 } },
    { stepIndex: 100, moveX: 0, jump: 'none', pointer: { x: q4(sx(-2)), y: 0.5, over: false } },
    { stepIndex: 120, moveX: 0, jump: 'none', pointer: { x: 0.5, y: 0.52 } },
  ];
}

const PATTERN = [1, 2, 1, 0, 3, 1, 1, 2, 0, 1];

async function run(mode: Mode, steps: number): Promise<{ h: Harness; digests: string[]; hidden: Map<number, string>; cursor: unknown }> {
  const { snapshot, physics } = scene();
  const h = await startHarness(mode, { snapshot, settings: SETTINGS, physics, behaviors: [behaviorModule('picker', PICKER)], replay: recording(), digestSteps: true, host: { buildId: 'b' } });
  let now = 10;
  await h.tick(now);
  const hidden = new Map<number, string>();
  let i = 0;
  while (h.digests.length < steps) {
    now += PATTERN[i++ % PATTERN.length]! * DT;
    await h.tick(now);
    const o = h.host.observe();
    if (o.ok) hidden.set(o.observation.stepIndex, (o.observation.hidden ?? []).join(','));
  }
  return { h, digests: [...h.digests], hidden, cursor: h.rt.cursorRequest?.() ?? null };
}

const firstDiff = (a: string[], b: string[]): number => a.slice(0, Math.min(a.length, b.length)).findIndex((d, k) => d !== b[k]);

describe('phase 23.3: pointer replays (page and worker)', () => {
  it('hover, click and leave from a recording: identical digests and the same hidden objects in page and worker', async () => {
    const a = await run('single', 160);
    const b = await run('single', 160);
    const w = await run('worker', 160);
    try {
      expect(firstDiff(a.digests, b.digests), 'two page runs').toBe(-1);
      expect(firstDiff(a.digests, w.digests), 'page vs worker').toBe(-1);
      let compared = 0;
      for (const [step, set] of a.hidden) {
        if (!w.hidden.has(step)) continue;
        expect(w.hidden.get(step), `hidden at ${step}`).toBe(set);
        compared += 1;
      }
      expect(compared).toBeGreaterThan(30);
      const near = (step: number): string => {
        for (let s = step; s < step + 5; s += 1) if (a.hidden.has(s)) return a.hidden.get(s)!;
        throw new Error(`no observation near ${step}`);
      };
      // Before the pointer: every lamp off. Over b: its lamp on. Over c: c's. Clicked: box c hidden.
      expect(near(10)).toBe('lamp-a,lamp-b,lamp-c');
      expect(near(30)).toBe('lamp-a,lamp-c');
      expect(near(50)).toBe('lamp-a,lamp-b');
      expect(near(70)).toBe('box-c,lamp-a,lamp-b');
      // Over a (box c stays hidden); off the view: no lamp; back over b.
      expect(near(90)).toBe('box-c,lamp-b,lamp-c');
      expect(near(110)).toBe('box-c,lamp-a,lamp-b,lamp-c');
      expect(near(130)).toBe('box-c,lamp-a,lamp-c');
      // The script asked for a locked cursor (simulation state, read by the host in both modes).
      expect(a.cursor).toBe('locked');
      expect(w.cursor).toBe('locked');
    } finally {
      await a.h.dispose();
      await b.h.dispose();
      await w.h.dispose();
    }
  }, 180_000);
});
