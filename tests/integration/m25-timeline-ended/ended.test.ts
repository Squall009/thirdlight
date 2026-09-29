/**
 * Phase 25.5: scripts see a timeline's `ended` event — on the main thread
 * and in the simulation worker.
 *
 * A neutral scene and three scripts:
 * - a director (ungrouped, intent phase) plays timelines, polls
 *   `ctx.timeline.ended(h)`, `state(h)` and `events()`, and counts what it saw;
 * - a late reader (transform phase) counts the same events a phase later;
 * - a field script in a behavior group that only ticks in the "explore"
 *   mode, while a timeline's mode track holds the "cinematic" mode and hands
 *   back "explore" at its end.
 * Plays: one started by the script (finished), one on start (`playOnStart`),
 * one on a signal (`playOnSignal`), one stopped, one skipped, and the
 * cinematic with a mode track. Every `ended` is seen exactly once by every
 * script that ticks in the step after it, in page and worker alike.
 */
import { describe, expect, it } from 'vitest';

import { physics3DConfigOf } from '@thirdlight/runtime';

import { FakeNode, MODES, behaviorModule, startHarness, type Mode } from '../m22-worker/harness';
import { MODULES_3D } from '../m23-3d/character-kit';

type Any = any;
const HZ = 120;
const DT = 1 / HZ;
const T = (position: number[]) => ({ position, rotation: [0, 0, 0, 1], scale: [1, 1, 1] });

const DIRECTOR = `
export default {
  instantiate() { return { h: 0, hs: 0, hk: 0, hc: 0, stateSeen: 0 }; },
  step(state, ctx) {
    if (ctx.phase !== 'intent') return;
    const s = ctx.stepIndex;
    const tl = ctx.timeline;
    if (s === 10) state.h = tl.play('short');
    if (s === 100) ctx.signals.emit('go');
    if (s === 300) state.hs = tl.play('short');
    if (s === 310) tl.stop(state.hs);
    if (s === 400) state.hk = tl.play('short');
    if (s === 410) tl.skip(state.hk);
    if (s === 500) state.hc = tl.play('cine');
    if (ctx.modes.current() === 'cinematic') ctx.game.add('d_cineSteps', 1);
    ctx.game.add('d_steps', 1);
    if (state.h > 0 && tl.ended(state.h)) ctx.game.add('d_endedFn', 1);
    if (state.h > 0 && tl.state(state.h) === 'ended' && state.stateSeen === 0) { state.stateSeen = 1; ctx.game.add('d_state', 1); }
    if (state.hs > 0 && tl.ended(state.hs)) ctx.game.add('d_stopFn', 1);
    if (state.hk > 0 && tl.ended(state.hk)) ctx.game.add('d_skipFn', 1);
    if (state.hc > 0 && tl.ended(state.hc)) ctx.game.add('d_cineFn', 1);
    for (const e of tl.events()) if (e.kind === 'ended') ctx.game.add('d_' + e.timeline + '_' + e.reason, 1);
  },
};
`;
const LATE = `
export default {
  step(state, ctx) {
    if (ctx.phase !== 'transform') return;
    for (const e of ctx.timeline.events()) if (e.kind === 'ended') ctx.game.add('l_' + e.timeline + '_' + e.reason, 1);
  },
};
`;
const FIELD = `
export default {
  step(state, ctx) {
    if (ctx.phase !== 'intent') return;
    ctx.game.add('f_steps', 1);
    for (const e of ctx.timeline.events()) if (e.kind === 'ended') ctx.game.add('f_' + e.timeline + '_' + e.reason, 1);
  },
};
`;

const SHORT = { timelineId: 'short', name: 'Short', duration: 0.5, tracks: [{ trackId: 'move', type: 'transform', target: 'actor', keys: [{ time: 0, position: [0, 0.5, 0] }, { time: 0.5, position: [1, 0.5, 0] }] }], slots: [{ name: 'actor', entity: 'actor-0001' }] };
const AUTO = { timelineId: 'auto', name: 'Auto', duration: 0.25, playOnStart: true, tracks: [] };
const ONSIG = { timelineId: 'onsig', name: 'On signal', duration: 0.25, playOnSignal: 'go', tracks: [] };
const CINE = { timelineId: 'cine', name: 'Cinematic', duration: 1, tracks: [{ trackId: 'mode', type: 'mode', keys: [{ time: 0, mode: 'cinematic' }, { time: 1, mode: 'explore' }] }] };

const GAME_MODES = [
  { modeId: 'explore', name: 'Explore', inputMaps: ['gameplay', 'ui'], groups: ['field'] },
  { modeId: 'cinematic', name: 'Cinematic', inputMaps: ['ui'], groups: [] },
];

type Dim = 0 | 2 | 3;

function entities(dim: Dim): Any[] {
  const list: Any[] = [
    { id: 'cam-main', components: { transform: T([0, 4, 12]), camera: { type: 'perspective', fovY: 50, near: 0.1, far: 200 } } },
    { id: 'actor-0001', components: { transform: T([-2, 0.5, 0]), box: { size: [1, 1, 1], material: { color: '#88aacc' } } } },
    { id: 'director-0001', components: { transform: T([0, -5, 0]), behavior: { behaviorId: 'director', values: {} } } },
    { id: 'late-0001', components: { transform: T([1, -5, 0]), behavior: { behaviorId: 'late', values: {} } } },
    { id: 'field-0001', components: { transform: T([2, -5, 0]), behavior: { behaviorId: 'field', values: {} }, behaviorGroup: { group: 'field' } } },
  ];
  if (dim !== 0) {
    list.push({ id: 'player-0001', components: { transform: T([0, 0.91, 0]), controller: {} } });
    list.push({ id: 'floor-0001', components: { transform: T([0, -0.5, 0]), box: { size: [40, 1, 4], material: { color: '#888888' } }, collider: { shape: dim === 3 ? { type: 'box', hx: 20, hy: 0.5, hz: 2 } : { type: 'box', hx: 20, hy: 0.5 } } } });
  }
  return list;
}

function snapshot(dim: Dim): Any {
  return {
    snapshotId: `ended${dim}@r1`,
    projectId: `ended${dim}`,
    revision: 1,
    scene: { schemaVersion: 4, sceneId: 'scene-main', revision: 1, entities: entities(dim) },
    timelines: [SHORT, AUTO, ONSIG, CINE],
    modes: { modes: GAME_MODES, actionMaps: {} },
  };
}

const SETTINGS_2D = { run_speed: 4, jump_velocity: 8, gravity_y: -20, max_fall_speed: -20, max_slope_climb_deg: 45, min_slope_slide_deg: 30 };
const SETTINGS_3D = { gravity_y: -19.62, run_speed: 4, jump_velocity: 7, max_fall_speed: -30, max_slope_climb_deg: 45, min_slope_slide_deg: 30, physics_dimension: 3 };

function physicsOf(dim: Dim): { settings: Any; physics: Any; modules?: string[] } {
  if (dim === 0) return { settings: {}, physics: null };
  const list = entities(dim);
  if (dim === 3) return { settings: SETTINGS_3D, physics: physics3DConfigOf(list, SETTINGS_3D), modules: MODULES_3D };
  const statics = list
    .filter((e) => e.components.collider)
    .map((e) => ({ entityId: e.id, shape: e.components.collider.shape, position: { x: e.components.transform.position[0], y: e.components.transform.position[1] }, rotationZ: 0 }));
  return {
    settings: SETTINGS_2D,
    physics: { character: { x: 0, y: 0.91 }, statics, solver: { hz: 120, gravityY: SETTINGS_2D.gravity_y }, controller: { offsetSkin: 0.01, groundSnap: 0.1, maxSlopeClimbRad: Math.PI / 4, minSlopeSlideRad: Math.PI / 6, autostep: false } },
  };
}

const PATTERN = [1, 2, 1, 0, 3, 1, 1, 2, 0, 1];

async function run(mode: Mode, dim: Dim): Promise<{ counters: Record<string, number>; logs: string[] }> {
  const h = await startHarness(mode, {
    snapshot: snapshot(dim),
    ...physicsOf(dim),
    behaviors: [behaviorModule('director', DIRECTOR), ((m) => ({ row: { ...m.row, ownedTransforms: ['@self'] }, url: m.url }))(behaviorModule('late', LATE)), behaviorModule('field', FIELD)],
    replay: Array.from({ length: 800 }, (_, s) => ({ stepIndex: s, moveX: 0, jump: 'none', actions: {} })),
    digestSteps: true,
    host: { buildId: 'b', container: new FakeNode() },
  });
  try {
    let now = 10;
    await h.tick(now);
    let i = 0;
    while (h.digests.length < 700) {
      now += PATTERN[i++ % PATTERN.length]! * DT;
      await h.tick(now);
    }
    const counters = { ...(h.rt.gameCounters?.()?.counters ?? {}) } as Record<string, number>;
    const logs = ((h.rt.getDiagnostics?.()?.behaviorLogs ?? []) as Any[]).map((l: Any) => `${l.level}:${l.message}`);
    return { counters, logs };
  } finally {
    await h.dispose();
  }
}

describe('phase 25.5: scripts see a timeline ended event', () => {
  for (const dim of [0, 2, 3] as const) for (const mode of MODES) {
    it(`every ended is seen once, in the step after it (${dim === 0 ? 'no physics' : `${dim}D`}, ${mode})`, async () => {
      const { counters, logs } = await run(mode, dim);
      const expected: Record<string, number> = {
        'd_endedFn': 1,
        'd_state': 1,
        'd_stopFn': 1,
        'd_skipFn': 1,
        'd_cineFn': 1,
        'd_short_finished': 1,
        'd_short_stopped': 1,
        'd_short_skipped': 1,
        'd_auto_finished': 1,
        'd_onsig_finished': 1,
        'd_cine_finished': 1,
        'l_short_finished': 1,
        'l_short_stopped': 1,
        'l_short_skipped': 1,
        'l_auto_finished': 1,
        'l_onsig_finished': 1,
        'l_cine_finished': 1,
        // The field group ticks in explore only: the cinematic's end hands explore back, and the field sees the end.
        'f_short_finished': 1,
        'f_short_stopped': 1,
        'f_short_skipped': 1,
        'f_auto_finished': 1,
        'f_onsig_finished': 1,
        'f_cine_finished': 1,
      };
      expect(counters, `logs: ${logs.join(' | ')}`).toMatchObject(expected);
      // The cinematic held its mode for its second (120 steps), and the field group did not tick then.
      expect(counters['d_cineSteps']).toBe(120);
      expect(counters['f_steps']).toBe(counters['d_steps']! - 120);
    }, 120_000);
  }
});
