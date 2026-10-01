/**
 * Signals, trigger events and script messages in a game mode that holds
 * physics, through the production composition, in the page, in the
 * simulation worker and from a recorded input.
 *
 * A director script sends a message to a listener and emits a signal every
 * step; the listener counts what arrives (a message carries its send step,
 * so a late one shows). A mode "board" holds physics (the controller,
 * bodies, movers and triggers stand still). With a character, the listener
 * sits on a trigger around it: the trigger's enter switches to the board, so
 * the enter event is the last thing the triggers did before the hold — it
 * must be seen once, not every held step. Without physics (the 2D plane, no
 * controller) the listener switches at a fixed step.
 *
 * Also a 2D plain scene with no scripts at all (the step without simulation
 * modules): a timeline's signal starts another timeline, with physics held
 * and without.
 *
 * In every case the page, the worker and a replay of the recorded input give
 * identical step digests (the counters are in them).
 */
import { describe, expect, it } from 'vitest';

import { physics3DConfigOf } from '@thirdlight/runtime';

import { behaviorModule, startHarness, type Mode } from '../m22-worker/harness';

type Any = any;
const DT = 1 / 120;
const T = (position: number[]) => ({ position, rotation: [0, 0, 0, 1], scale: [1, 1, 1] });
const SETTINGS_2D = { run_speed: 5, jump_velocity: 8, gravity_y: -20, max_fall_speed: -20, max_slope_climb_deg: 45, min_slope_slide_deg: 30 };
const SETTINGS_3D = { gravity_y: -19.62, run_speed: 4, jump_velocity: 7, max_fall_speed: -30, max_slope_climb_deg: 45, min_slope_slide_deg: 30, physics_dimension: 3 };
const MODULES_3D = ['thirdlight.character3d:controller', 'thirdlight.input:keyboard-gamepad', 'thirdlight.physics-rapier:3d'];
const MODES = { modes: [{ modeId: 'play', name: 'Play' }, { modeId: 'board', name: 'Board', physics: 'hold' }], actionMaps: {} };
const STEPS = 300;

const DIRECTOR = `
export default {
  step(state, ctx) {
    if (ctx.phase !== 'intent') return;
    ctx.messages.send('ping', ctx.stepIndex, 'listener-0001');
    ctx.signals.emit('tick');
  },
};
`;

/** Counts what arrives; switches to the held mode on the trigger's enter (or at step 40 without a trigger). */
const LISTENER = (switchAt: number | null) => `
export default {
  step(state, ctx) {
    if (ctx.phase !== 'intent') return;
    const g = ctx.game;
    const s = ctx.stepIndex;
    g.add('steps', 1);
    if (ctx.modes.is('board')) g.add('held_steps', 1);
    for (const m of ctx.messages.received('ping')) {
      g.add('pings', 1);
      if (s - m.value !== 1) g.add('late', 1);
    }
    if (ctx.signals.on('tick')) g.add('ticks', 1);
    for (const e of ctx.events ?? []) {
      if (e.type !== 'enter') continue;
      g.add('enters', 1);
      ctx.modes.switch('board');
    }
    if (s === ${switchAt ?? -1}) ctx.modes.switch('board');
  },
};
`;

type Variant = '3d' | '2d-physics' | '2d-plain';

function scene(variant: Variant): { snapshot: Any; physics: Any; settings: Any; modules?: string[] } {
  const three = variant === '3d';
  const entities: Any[] = [
    { id: 'cam-main', components: { transform: T([0, 4, 12]), camera: { type: 'perspective', fovY: 50, near: 0.1, far: 200 } } },
    { id: 'director-0001', components: { transform: T([0, -5, 0]), behavior: { behaviorId: 'director', values: {} } } },
  ];
  if (variant === '2d-plain') {
    entities.push({ id: 'listener-0001', components: { transform: T([2, -5, 0]), behavior: { behaviorId: 'listener', values: {} } } });
  } else {
    entities.push(
      { id: 'player-0001', components: { transform: T([0, 0.91, 0]), controller: {} } },
      { id: 'floor-0001', components: { transform: T([0, -0.5, 0]), box: { size: [40, 1, 40], material: { color: '#888888' } }, collider: { shape: three ? { type: 'box', hx: 20, hy: 0.5, hz: 20 } : { type: 'box', hx: 20, hy: 0.5 } } } },
      // The listener's trigger around the character: entered on the first steps.
      { id: 'listener-0001', components: { transform: T([0, 0.91, 0]), trigger: { signal: 'entered', size: three ? [2, 2, 2] : [2, 2] }, behavior: { behaviorId: 'listener', values: {} } } },
    );
  }
  const snapshot = {
    snapshotId: `held-${variant}@r1`,
    projectId: `held-${variant}`,
    revision: 1,
    scene: { schemaVersion: 4, sceneId: 'scene-main', revision: 1, entities },
    modes: MODES,
  };
  if (three) return { snapshot, physics: physics3DConfigOf(entities, SETTINGS_3D), settings: SETTINGS_3D, modules: MODULES_3D };
  if (variant === '2d-plain') return { snapshot, physics: null, settings: SETTINGS_2D };
  return {
    snapshot,
    settings: SETTINGS_2D,
    physics: {
      character: { x: 0, y: 0.91 },
      statics: [{ entityId: 'floor-0001', shape: { type: 'box', hx: 20, hy: 0.5 }, position: { x: 0, y: -0.5 }, rotationZ: 0 }],
      solver: { hz: 120, gravityY: SETTINGS_2D.gravity_y },
      controller: { offsetSkin: 0.01, groundSnap: 0.1, maxSlopeClimbRad: Math.PI / 4, minSlopeSlideRad: Math.PI / 6, autostep: false },
    },
  };
}

/** A recorded neutral input (the live runs sample the same frames). */
const recording = (three: boolean): Any[] => Array.from({ length: STEPS + 50 }, (_, s) => ({ stepIndex: s, moveX: 0, ...(three ? { moveY: 0 } : {}), jump: 'none' }));

const PATTERN = [1, 2, 1, 0, 3, 1, 1, 2, 0, 1];

interface Outcome {
  digests: string[];
  counters: Record<string, number>;
  mode: string | null;
  hidden: string[];
  m2: boolean;
}

async function drive(mode: Mode, cfg: Any, steps: number): Promise<Outcome> {
  const h = await startHarness(mode, cfg);
  try {
    let now = 10;
    await h.tick(now);
    let i = 0;
    while (h.digests.length < steps) {
      now += PATTERN[i++ % PATTERN.length]! * DT;
      await h.tick(now);
    }
    // A frame without a step brings the last state over.
    await h.tick(now);
    const rt: Any = h.rt;
    const obs = h.host.observe();
    const d = rt.getDiagnostics();
    const errors = d.ok ? d.diagnostics.errors : [];
    if (errors.length > 0) throw new Error(`runtime errors: ${JSON.stringify(errors).slice(0, 1500)}`);
    return {
      digests: h.digests.slice(0, steps),
      counters: { ...(rt.gameCounters?.()?.counters ?? {}) },
      mode: obs.ok ? (obs.observation.mode?.current ?? null) : null,
      hidden: [...(rt.hiddenEntities?.() ?? [])].sort(),
      m2: d.ok && d.diagnostics.inputSamples !== undefined,
    };
  } finally {
    await h.dispose();
  }
}

/** The page (live input), the worker (the recording) and the page again (the recording): one outcome, three runs. */
async function threeRuns(cfg: (replay: boolean) => Any, steps: number): Promise<Outcome> {
  const page = await drive('single', cfg(false), steps);
  const worker = await drive('worker', cfg(true), steps);
  const replay = await drive('single', cfg(true), steps);
  expect(worker.counters).toEqual(page.counters);
  expect(replay.counters).toEqual(page.counters);
  expect(worker.mode).toBe(page.mode);
  expect(worker.digests).toEqual(page.digests);
  expect(replay.digests).toEqual(page.digests);
  return page;
}

describe('a game mode that holds physics still delivers signals, trigger events and script messages', () => {
  for (const variant of ['3d', '2d-physics', '2d-plain'] as const) {
    it(`${variant}: every message and signal arrives one step later, the trigger's enter is seen once; page, worker and replay agree`, async () => {
      const { snapshot, physics, settings, modules } = scene(variant);
      const listener = LISTENER(variant === '2d-plain' ? 40 : null);
      const cfg = (replay: boolean): Any => ({
        snapshot,
        settings,
        physics,
        ...(modules !== undefined ? { modules } : {}),
        behaviors: [behaviorModule('director', DIRECTOR), behaviorModule('listener', listener)],
        ...(replay ? { replay: recording(variant === '3d') } : {}),
        digestSteps: true,
      });
      const out = await threeRuns(cfg, STEPS);
      expect(out.mode).toBe('board');
      const c = out.counters;
      // Most of the run is held.
      expect(c['held_steps']).toBeGreaterThan(STEPS - 60);
      // Every step but the first saw the previous step's message and signal, none late.
      expect(c['pings']).toBe(c['steps']! - 1);
      expect(c['ticks']).toBe(c['steps']! - 1);
      expect(c['late'] ?? 0).toBe(0);
      if (variant !== '2d-plain') expect(c['enters']).toBe(1);
    }, 240_000);
  }

  it('a 2D plain scene without scripts: a timeline\'s signal starts another timeline, physics held or not; page, worker and replay agree', async () => {
    const entities: Any[] = [
      { id: 'cam-main', components: { transform: T([0, 4, 12]), camera: { type: 'perspective', fovY: 50, near: 0.1, far: 200 } } },
      { id: 'door-0001', visible: false, components: { transform: T([0, 0.5, 0]), box: { size: [1, 1, 1], material: { color: '#88aacc' } } } },
    ];
    const timelines = [
      { timelineId: 'cue', name: 'Cue', duration: 0.2, playOnStart: true, tracks: [{ trackId: 'go', type: 'signal', keys: [{ time: 0.1, name: 'open' }] }] },
      { timelineId: 'reveal', name: 'Reveal', duration: 0.2, playOnSignal: 'open', slots: [{ name: 'door', entity: 'door-0001' }], tracks: [{ trackId: 'show', type: 'activation', target: 'door', keys: [{ time: 0, active: true }] }] },
    ];
    for (const held of [false, true]) {
      const modes = held ? { modes: [{ modeId: 'board', name: 'Board', physics: 'hold' }], actionMaps: {} } : undefined;
      const snapshot = { snapshotId: 'plain@r1', projectId: 'plain', revision: 1, scene: { schemaVersion: 4, sceneId: 'scene-main', revision: 1, entities }, timelines, ...(modes !== undefined ? { modes } : {}) };
      const cfg = (replay: boolean): Any => ({ snapshot, settings: {}, physics: null, behaviors: [], ...(replay ? { replay: recording(false) } : {}), digestSteps: true });
      const out = await threeRuns(cfg, 120);
      // The plain step (no simulation modules).
      expect(out.m2).toBe(false);
      expect(out.hidden, `held ${held}`).toEqual([]);
    }
  }, 240_000);
});
