/**
 * Authored hidden objects and signals from tools, through the production
 * composition, on the main thread and in the simulation worker.
 *
 * A neutral scene with four objects placed hidden (`visible: false`): a box
 * on a mover (hidden objects still simulate: it moves), one a timeline's
 * activation key shows (the timeline plays on the signal `open`), one
 * `ctx.game.setVisible` shows and one `ctx.entity().set('object',
 * {visible: true})` shows. The recorded input carries the engine's `signal`
 * debug command at step 40 (what `tl_game_control {signal}` and the console's
 * `signal open` queue), so a replay reproduces it. At step 200 a script
 * restarts the run: every authored-hidden object starts hidden again.
 *
 * Page and worker runs give identical step digests and the same hidden sets.
 */
import { describe, expect, it } from 'vitest';

import { behaviorModule, startHarness, type Mode } from '../m22-worker/harness';

type Any = any;
const DT = 1 / 120;
const T = (position: number[]) => ({ position, rotation: [0, 0, 0, 1], scale: [1, 1, 1] });
const BOX = { size: [1, 1, 1], material: { color: '#88aacc' } };
const HIDDEN = ['door-0001', 'ghost-0001', 'lamp-0001', 'sign-0001'];

const DIRECTOR = `
export default {
  instantiate() { return {}; },
  step(state, ctx) {
    if (ctx.phase !== 'intent') return;
    const s = ctx.stepIndex;
    const g = ctx.game;
    const mark = (name, ok) => { if (ok) g.add(name, 1); };
    const vis = (id) => ctx.entity(id).get('object').visible;
    if (s === 5) mark('start_hidden', ${JSON.stringify(HIDDEN)}.every((id) => vis(id) === false));
    if (s === 5) g.add('ghost_x0', Math.round(ctx.entity('ghost-0001').get('transform').position[0] * 1000));
    if (s === 30) g.add('ghost_x1', Math.round(ctx.entity('ghost-0001').get('transform').position[0] * 1000));
    if (ctx.signals.on('open')) { g.add('open_seen', 1); g.add('open_step', s); }
    if (s === 60) ctx.game.setVisible('lamp-0001', true);
    if (s === 70) mark('set_ok', ctx.entity('sign-0001').set('object', { visible: true }).ok);
    if (s === 90) mark('shown', vis('door-0001') && vis('lamp-0001') && vis('sign-0001') && !vis('ghost-0001'));
    if (s === 200) ctx.lifecycle.restart();
  },
};
`;

const REVEAL = {
  timelineId: 'reveal',
  name: 'Reveal',
  duration: 0.5,
  playOnSignal: 'open',
  slots: [{ name: 'door', entity: 'door-0001' }],
  tracks: [{ trackId: 'show', type: 'activation', target: 'door', keys: [{ time: 0, active: true }] }],
};

function snapshot(): Any {
  const entities: Any[] = [
    { id: 'cam-main', components: { transform: T([0, 4, 12]), camera: { type: 'perspective', fovY: 50, near: 0.1, far: 200 } } },
    { id: 'ghost-0001', visible: false, components: { transform: T([0, 0.5, 0]), box: BOX, mover: { waypoints: [[4, 0, 0]], speed: 2, mode: 'pingpong' } } },
    { id: 'door-0001', visible: false, components: { transform: T([-2, 0.5, 0]), box: BOX } },
    { id: 'lamp-0001', visible: false, components: { transform: T([2, 0.5, 0]), box: BOX } },
    { id: 'sign-0001', visible: false, components: { transform: T([4, 0.5, 0]), box: BOX } },
    { id: 'plain-0001', components: { transform: T([6, 0.5, 0]), box: BOX } },
    { id: 'director-0001', components: { transform: T([0, -5, 0]), behavior: { behaviorId: 'director', values: {} } } },
  ];
  return {
    snapshotId: 'hidden@r1',
    projectId: 'hidden',
    revision: 1,
    scene: { schemaVersion: 4, sceneId: 'scene-main', revision: 1, entities },
    scenes: [{ sceneId: 'scene-main', start: true, entityIds: entities.map((e) => e.id) }],
    timelines: [REVEAL],
  };
}

function recording(): Any[] {
  return Array.from({ length: 400 }, (_, s) => ({ stepIndex: s, moveX: 0, jump: 'none', actions: {}, ...(s === 40 ? { commands: [{ name: 'signal', args: { name: 'open' } }] } : {}) }));
}

const PATTERN = [1, 2, 1, 0, 3, 1, 1, 2, 0, 1];

interface Outcome {
  digests: string[];
  counters: Record<string, number>;
  hiddenBefore: string[];
  hiddenAfter: string[];
  applied: Any[];
  errors: Any[];
}

async function run(mode: Mode): Promise<Outcome> {
  const h = await startHarness(mode, { snapshot: snapshot(), settings: {}, physics: null, behaviors: [behaviorModule('director', DIRECTOR)], replay: recording(), digestSteps: true });
  try {
    let now = 10;
    await h.tick(now);
    let i = 0;
    const until = async (steps: number): Promise<void> => {
      while (h.digests.length < steps) {
        now += PATTERN[i++ % PATTERN.length]! * DT;
        try {
          await h.tick(now);
        } catch (e) {
          const d = (h.rt as Any).getDiagnostics();
          throw new Error(`${String(e)} at step ${h.digests.length}: ${JSON.stringify(d.ok ? d.diagnostics.errors.slice(-3) : d).slice(0, 2500)}`);
        }
      }
      // A frame without a step brings the last state over.
      await h.tick(now);
    };
    const rt: Any = h.rt;
    await until(150);
    const counters = { ...(rt.gameCounters?.()?.counters ?? {}) };
    const hiddenBefore = [...(rt.hiddenEntities?.() ?? [])].sort();
    await until(260);
    const hiddenAfter = [...(rt.hiddenEntities?.() ?? [])].sort();
    const d = rt.getDiagnostics();
    return { digests: h.digests.slice(0, 260), counters, hiddenBefore, hiddenAfter, applied: [...(rt.debugCommandState?.().applied ?? [])], errors: d.ok ? d.diagnostics.errors : [] };
  } finally {
    await h.dispose();
  }
}

describe('authored hidden objects and tool signals in page and worker', () => {
  it('start hidden, still simulate, are shown by a timeline key, setVisible and entity().set; a recorded signal plays; a restart hides them again', async () => {
    const single = await run('single');
    expect(single.counters, JSON.stringify(single.errors).slice(0, 1500)).toMatchObject({ start_hidden: 1, open_seen: 1, open_step: 40, set_ok: 1, shown: 1 });
    // The hidden box moved along its mover.
    expect(single.counters['ghost_x1']! - (single.counters['ghost_x0'] ?? 0)).toBeGreaterThan(0);
    expect(single.hiddenBefore).toEqual(['ghost-0001']);
    expect(single.hiddenAfter).toEqual(HIDDEN);
    expect(single.applied).toEqual([{ stepIndex: 40, name: 'signal', args: { name: 'open' } }]);

    const worker = await run('worker');
    expect(worker.counters).toEqual(single.counters);
    expect(worker.hiddenBefore).toEqual(single.hiddenBefore);
    expect(worker.hiddenAfter).toEqual(single.hiddenAfter);
    expect(worker.digests).toEqual(single.digests);

    const again = await run('single');
    expect(again.digests).toEqual(single.digests);
  }, 240_000);
});
