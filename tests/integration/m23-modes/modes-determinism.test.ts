/**
 * Phase 23.10: game modes are simulation state across the worker boundary
 * and in replays. A neutral 3D scene (physics_dimension 3, the 3D character
 * module) with two modes — "explore" (gameplay + ui maps, a follow camera,
 * a HUD, the "field" group ticking) and "tactical" (a project "tactical" map
 * + ui, a top camera, a board document, the "board" group, physics held,
 * half speed). A director script switches to tactical at step 200; a
 * recorded UI mode action switches back at step 420; the script respawns the
 * player at a player spawn at step 520 and restarts the run at step 640.
 *
 * Run twice in the page and once in the simulation worker from the same
 * recorded input: every step's digest (the mode included) is identical; the
 * host observes the same mode, shown documents and live camera; the input
 * held during tactical does not move the character (its map is off); the
 * field group's script does not run in tactical; the respawn and the restart
 * put the character where they should, and the restart starts over in the
 * start mode.
 */
import { describe, expect, it } from 'vitest';

import { physics3DConfigOf } from '@thirdlight/runtime';

import { FakeNode, behaviorModule, startHarness, type Mode } from '../m22-worker/harness';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;
const HZ = 120;
const DT = 1 / HZ;
const T = (position: number[]) => ({ position, rotation: [0, 0, 0, 1], scale: [1, 1, 1] });
const SETTINGS = { gravity_y: -19.62, run_speed: 4, jump_velocity: 7, max_fall_speed: -30, max_slope_climb_deg: 45, min_slope_slide_deg: 30, physics_dimension: 3 };
const MODULES_3D = ['thirdlight.character3d:controller', 'thirdlight.input:keyboard-gamepad', 'thirdlight.physics-rapier:3d'];

const MODES = [
  { modeId: 'explore', name: 'Explore', inputMaps: ['gameplay', 'ui'], camera: 'cam-follow', ui: ['hud'], groups: ['field'] },
  { modeId: 'tactical', name: 'Tactical', inputMaps: ['tactical', 'ui'], camera: 'cam-top', ui: ['board'], groups: ['board'], pause: false, timeScale: 0.5, physics: 'hold', enter: { blend: 'eased', blendTime: 0.5 } },
];
const ACTION_MAPS = { move: 'gameplay', jump: 'gameplay', run: 'gameplay', select: 'tactical', pause: 'ui', submit: 'ui', cancel: 'ui', navigate: 'ui' };

const DIRECTOR = `
export default {
  step(state, ctx) {
    if (ctx.phase !== 'intent') return;
    const s = ctx.stepIndex;
    for (const e of ctx.modes.events()) ctx.ui.set('log.' + e.kind, e.mode + '@' + s);
    if (s === 200) ctx.modes.switch('tactical');
    if (s === 520) ctx.lifecycle.respawn('spawn-0001');
    if (s === 640) ctx.lifecycle.restart();
    if (ctx.input.held('select')) ctx.ui.set('selects', (ctx.ui.get('selects') || 0) + 1);
  },
};
`;
// A field script (ticks in explore) and a board script (ticks in tactical): each counts its own steps.
const COUNTER = (key: string) => `
export default {
  instantiate() { return { n: 0 }; },
  step(state, ctx) {
    if (ctx.phase !== 'intent') return;
    state.n += 1;
    ctx.ui.set('${key}', state.n);
  },
};
`;

function scene(): { snapshot: Any; physics: Any } {
  const entities: Any[] = [
    { id: 'cam-main', components: { transform: T([0, 6, 14]), camera: { type: 'perspective', fovY: 50, near: 0.1, far: 200 } } },
    { id: 'player-0001', components: { transform: T([0, 0.91, 0]), controller: {} } },
    { id: 'floor-0001', components: { transform: T([0, -0.5, 0]), box: { size: [60, 1, 60], material: { color: '#888888' } }, collider: { shape: { type: 'box', hx: 30, hy: 0.5, hz: 30 } } } },
    { id: 'spawn-0001', components: { transform: T([-4, 0.91, 2]), playerSpawn: {} } },
    { id: 'cam-follow', components: { transform: T([0, 2, 6]), virtualCamera: { rig: 'follow', target: 'player-0001', targetOffset: [0, 0.8, 0], distance: 6, pitch: 20 } } },
    { id: 'cam-top', components: { transform: T([0, 0, 0]), virtualCamera: { rig: 'topDown', target: 'player-0001', distance: 18, priority: -10 } } },
    { id: 'director-0001', components: { transform: T([0, -5, 0]), behavior: { behaviorId: 'director', values: {} } } },
    { id: 'field-0001', components: { transform: T([2, -5, 0]), behavior: { behaviorId: 'field', values: {} }, behaviorGroup: { group: 'field' } } },
    { id: 'board-0001', components: { transform: T([4, -5, 0]), behavior: { behaviorId: 'board', values: {} }, behaviorGroup: { group: 'board' } } },
  ];
  return {
    snapshot: {
      snapshotId: 'modes3d@r1',
      projectId: 'modes3d',
      revision: 1,
      scene: { schemaVersion: 4, sceneId: 'scene-main', revision: 1, entities },
      game: null,
      uiDocuments: [{ uiDocumentId: 'hud', layer: 0, modal: false }, { uiDocumentId: 'board', layer: 0, modal: false }],
      modes: { modes: MODES, actionMaps: ACTION_MAPS },
    },
    physics: physics3DConfigOf(entities, SETTINGS),
  };
}

const DOCS = [
  { uiDocumentId: 'hud', name: 'HUD', root: { type: 'text', id: 'field', text: 'Field {field}' } },
  { uiDocumentId: 'board', name: 'Board', actionMap: 'ui', root: { type: 'button', id: 'back', text: 'Back', onClick: { do: 'mode', mode: 'explore' } } },
];

/** Move right in explore (steps 20-150) and again while tactical (250-350: masked); select while tactical; the UI mode action at 420. */
function recording(): Any[] {
  const frames: Any[] = [];
  for (let s = 0; s < 1000; s += 1) {
    const f: Any = { stepIndex: s, moveX: 0, moveY: 0, jump: 'none', actions: {} };
    if ((s >= 20 && s < 150) || (s >= 250 && s < 350) || (s >= 560 && s < 600)) {
      f.moveX = 1;
      f.actions = { move: { v: 1, x: 1, y: 0, p: 'held' } };
    }
    if (s >= 260 && s < 270) f.actions = { ...f.actions, select: { v: 1, p: 'held' } };
    if (s === 420) f.ui = [{ kind: 'mode', doc: 'board', widget: 'back', name: '', value: 'explore' }];
    frames.push(f);
  }
  return frames;
}

const PATTERN = [1, 2, 1, 0, 3, 1, 1, 2, 0, 1];

interface Seen {
  mode: string;
  shown: string;
  live: string;
  x: number;
  z: number;
  values: Any;
}

async function run(mode: Mode): Promise<{ digests: string[]; seen: Map<number, Seen>; dispose: () => Promise<void> }> {
  const { snapshot, physics } = scene();
  const h = await startHarness(mode, {
    snapshot,
    settings: SETTINGS,
    physics,
    modules: MODULES_3D,
    behaviors: [behaviorModule('director', DIRECTOR), behaviorModule('field', COUNTER('field')), behaviorModule('board', COUNTER('board'))],
    replay: recording(),
    digestSteps: true,
    host: { buildId: 'b', container: new FakeNode(), ui: { documents: DOCS } },
  });
  const seen = new Map<number, Seen>();
  let now = 10;
  await h.tick(now);
  let i = 0;
  while (h.digests.length < 820) {
    now += PATTERN[i++ % PATTERN.length]! * DT;
    await h.tick(now);
    const obs = h.host.observeScene!();
    if (obs.ok && obs.observation.mode !== undefined && obs.observation.player !== undefined) {
      const o = obs.observation;
      seen.set(o.stepIndex, { mode: o.mode!.current, shown: o.ui?.shown.join(',') ?? '', live: o.camera?.live ?? '', x: o.player!.x, z: o.player!.z, values: structuredClone(h.rt.uiView().model) });
    }
  }
  return { digests: [...h.digests], seen, dispose: () => h.dispose() };
}

function firstDiff(a: string[], b: string[]): number {
  const n = Math.min(a.length, b.length);
  return a.slice(0, n).findIndex((d, k) => d !== b[k]);
}

describe('phase 23.10: game modes in page and worker, and in replays', () => {
  it('identical step digests across mode switches; one transition changes map, camera, UI and groups; respawn and restart', async () => {
    const a = await run('single');
    const b = await run('single');
    const w = await run('worker');
    try {
      expect(firstDiff(a.digests, b.digests), 'first differing step (two page runs)').toBe(-1);
      expect(firstDiff(a.digests, w.digests), 'first differing step (page vs worker)').toBe(-1);
      let compared = 0;
      for (const [step, s] of a.seen) {
        const ws = w.seen.get(step);
        if (ws === undefined) continue;
        expect(ws, `observation at step ${step}`).toEqual(s);
        compared += 1;
      }
      expect(compared).toBeGreaterThan(150);
      const near = (step: number): Seen => {
        for (let k = step; k < step + 6; k += 1) if (a.seen.has(k)) return a.seen.get(k)!;
        throw new Error(`nothing observed near step ${step}`);
      };
      // Explore: the follow camera, the HUD, the field group counting, the character moved right.
      const e = near(190);
      expect([e.mode, e.shown, e.live]).toEqual(['explore', 'hud', 'cam-follow']);
      expect(e.x).toBeGreaterThan(1);
      expect(e.values.field).toBeGreaterThan(150);
      expect(e.values.board).toBeUndefined();
      // Tactical from step 201 (the script's switch at 200 applied at the next boundary): top camera, board, board group.
      const t = near(240);
      expect([t.mode, t.shown, t.live]).toEqual(['tactical', 'board', 'cam-top']);
      expect(t.values.log).toEqual({ enter: 'tactical@201', exit: 'explore@201' });
      // The move held from 250 to 350 did not move the character (the gameplay map is off, physics held) …
      const t2 = near(340);
      expect(t2.x).toBe(t.x);
      expect(t2.z).toBe(t.z);
      // … the tactical map's select did count, the field group stood still, the board group ran.
      expect(t2.values.selects).toBe(10);
      expect(t2.values.field).toBe(t.values.field);
      expect(t2.values.board).toBeGreaterThan(t.values.board ?? 0);
      // The recorded UI mode action at 420 switched back before that step's scripts.
      const back = near(430);
      expect([back.mode, back.shown, back.live]).toEqual(['explore', 'hud', 'cam-follow']);
      expect(back.values.log).toEqual({ enter: 'explore@420', exit: 'tactical@420' });
      // The respawn at 520 put the character on the spawn (-4, 2).
      const r = near(525);
      expect(r.x).toBeCloseTo(-4, 3);
      expect(r.z).toBeCloseTo(2, 3);
      // The restart asked for at 640 applied at 641: the start mode, the authored position, the counters from 0.
      const s = near(645);
      expect(s.mode).toBe('explore');
      expect(s.x).toBeCloseTo(0, 3);
      expect(s.z).toBeCloseTo(0, 3);
      expect(s.values.log).toEqual({ enter: 'explore@641' });
      expect(s.values.field).toBeLessThan(10);
    } finally {
      await a.dispose();
      await b.dispose();
      await w.dispose();
    }
  }, 240_000);

  it('the start mode option applies in page and worker alike', async () => {
    const { snapshot, physics } = scene();
    for (const mode of ['single', 'worker'] as const) {
      const h = await startHarness(mode, { snapshot, settings: SETTINGS, physics, modules: MODULES_3D, behaviors: [behaviorModule('director', DIRECTOR), behaviorModule('field', COUNTER('field')), behaviorModule('board', COUNTER('board'))], startMode: 'tactical', host: { buildId: 'b', container: new FakeNode() } });
      try {
        let now = 10;
        await h.tick(now);
        for (let k = 0; k < 20; k += 1) await h.tick((now += DT));
        const obs = h.host.observeScene!();
        expect(obs.ok && obs.observation.mode?.current, mode).toBe('tactical');
        expect(h.host.startOutcome).toEqual({ ok: true, applied: ['mode tactical'] });
      } finally {
        await h.dispose();
      }
    }
  }, 120_000);
});
