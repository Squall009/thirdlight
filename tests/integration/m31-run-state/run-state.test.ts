/**
 * Every run of a play starts as the first one did, whatever per-run state the
 * game used: a play of three runs (the first, then two restarts as a
 * play-test makes them, through the real game host) of a game whose script
 * starts a conversation with a voiced line, plays timelines (one on start,
 * one early, one late) and asks for an older handle's state before it
 * exists again, plays a sound, counts with timers, draws random numbers,
 * adds to a counter, writes the UI model and reads the save play time.
 *
 * Compared per run step: what the script saw (its log) and the runtime's
 * own per-run states (conversation, timelines, audio, saves, UI model,
 * counters). Each restarted run equals the first.
 *
 * And in a streamed 3D world (a long block floor whose chunks stream round
 * the player), a run that ended far from the start restarts with the
 * collision ring round the start, as the first run had it, page and worker.
 */
import { describe, expect, it } from 'vitest';
import { BlockGrid, applyBlockEdits, dialogueForRuntime, type DialogueDocument } from '@thirdlight/project-model';
import { physics3DConfigOf } from '@thirdlight/runtime';

import { FakeNode, behaviorModule, startHarness, type Mode } from '../m22-worker/harness';
import { MODULES_3D } from '../m23-3d/character-kit';

type Any = any;
const DT = 1 / 120;
const STEPS = 240;
const T = (position: number[]) => ({ position, rotation: [0, 0, 0, 1], scale: [1, 1, 1] });

const TALK: DialogueDocument = {
  dialogueId: 'talk',
  name: 'Talk',
  graph: {
    nodes: [
      { id: 'start', type: 'start', position: [0, 0] },
      { id: 'hello', type: 'line', position: [0, 100], data: { speaker: 'host', text: 'Welcome.', voice: 'vo-hello' } },
      { id: 'bye', type: 'line', position: [0, 200], data: { speaker: 'host', text: 'Bye.' } },
    ],
    edges: [
      { id: 'e0', from: { node: 'start', port: 'next' }, to: { node: 'hello', port: 'in' } },
      { id: 'e1', from: { node: 'hello', port: 'next' }, to: { node: 'bye', port: 'in' } },
    ],
  },
} as Any;

const SHORT = { timelineId: 'short', name: 'Short', duration: 0.25, tracks: [{ trackId: 'move', type: 'transform', target: 'actor', keys: [{ time: 0, position: [0, 0.5, 0] }, { time: 0.25, position: [1, 0.5, 0] }] }], slots: [{ name: 'actor', entity: 'actor-0001' }] };
const AUTO = { timelineId: 'auto', name: 'Auto', duration: 0.1, playOnStart: true, tracks: [] };

/** Logs what it sees every 6 of its steps (a restart starts the script over, so its count starts at 0). */
const DIRECTOR = `
export default {
  instantiate() { return { n: 0, run: -1, conv: 0, early: 0, late: 0, sound: 0, ticks: 0 }; },
  step(s, ctx) {
    if (ctx.phase !== 'intent') return;
    if (s.n === 0) { s.run = ctx.save.get('runs') ?? 0; ctx.save.set('runs', s.run + 1); }
    const n = s.n++;
    if (n === 5) s.conv = ctx.dialogue.start('talk');
    if (n === 7) ctx.dialogue.set('met', true);
    if (n === 10) s.early = ctx.timeline.play('short');
    if (n === 12) s.sound = ctx.audio.play('sfx-a');
    if (n === 150) s.late = ctx.timeline.play('short');
    if (n === 0) ctx.timers.every('tick', 0.05);
    if (ctx.timers.fired('tick')) s.ticks += 1;
    if (n % 20 === 0) ctx.game.add('score', 1);
    const roll = ctx.random.int(0, 1000000);
    ctx.ui.set('probe', { n, roll, ticks: s.ticks });
    if (n % 6 !== 0 || n > 230) return;
    const key = 'run' + s.run + '.' + Math.floor(n / 60);
    const log = ctx.save.get(key) ?? [];
    log.push([n, s.conv, ctx.dialogue.isRunning(), ctx.dialogue.get('met'), s.early, s.late, ctx.timeline.state(3), ctx.timeline.state(s.early), s.sound, s.ticks, roll, ctx.game.counter('score'), ctx.saves.playSeconds()]);
    ctx.save.set(key, log);
  },
};
`;

function snapshot(): Any {
  const entities = [
    { id: 'cam-main', components: { transform: T([0, 4, 12]), camera: { type: 'perspective', fovY: 45, near: 0.1, far: 100 } } },
    { id: 'actor-0001', components: { transform: T([-2, 0.5, 0]), box: { size: [1, 1, 1], material: { color: '#88aacc' } } } },
    { id: 'director-0001', components: { transform: T([0, -5, 0]), behavior: { behaviorId: 'director', values: {} } } },
  ];
  return {
    snapshotId: 'runs@r1',
    projectId: 'runs',
    revision: 1,
    scene: { schemaVersion: 4, sceneId: 'scene-main', revision: 1, entities },
    scenes: [{ sceneId: 'scene-main', start: true, entityIds: entities.map((e) => e.id) }],
    timelines: [SHORT, AUTO],
    audioDurations: { 'vo-hello': 600, 'sfx-a': 300 },
    dialogue: dialogueForRuntime({ dialogues: [TALK], speakers: [{ speakerId: 'host', name: 'Host' }], dialogueSettings: { textSpeed: 60, autoDelay: 0.25 } } as Any),
  };
}

describe('every run of a play starts as the first', () => {
  it('conversations, timelines, sounds, timers, random numbers, counters, the UI and the save play time repeat in each restarted run', async () => {
    const h = await startHarness('single', { snapshot: snapshot(), settings: {}, physics: null, storage: true, behaviors: [behaviorModule('director', DIRECTOR)], host: { buildId: 'b', container: new FakeNode() } });
    const rt = h.rt as Any;
    // The runtime's per-run states at each run step, per run.
    const states: Map<number, string>[] = [new Map(), new Map(), new Map()];
    let run = 0;
    rt.setStepWatcher(() => {
      const d = rt.getDiagnostics();
      const step = (d.ok ? d.diagnostics.stepIndex : 0) - rt.runStart().step;
      const ui = rt.uiView();
      states[run]!.set(step, JSON.stringify([rt.dialogueState(), rt.timelineState(), rt.audioState?.() ?? null, rt.savesState?.() ?? null, ui.model, ui.shown, rt.gameCounters?.() ?? null]));
      return false;
    });
    try {
      let now = 10;
      for (run = 0; run < 3; run += 1) {
        for (let i = 0; i < STEPS; i += 1) {
          now += DT;
          await h.tick(now);
        }
        if (run < 2) expect(h.host.control('replay').ok).toBe(true);
        // The restart applies at the next step boundary: one more frame belongs to the run that asked.
        if (run < 2) {
          now += DT;
          await h.tick(now);
        }
      }
      const d = rt.getDiagnostics();
      expect(d.ok ? d.diagnostics.errors.filter((e: Any) => e.code !== 'behavior_log') : [d]).toEqual([]);
      const values = await h.storage();
      const logs = [0, 1, 2].map((r) => [0, 1, 2, 3].flatMap((k) => (values[`run${r}.${k}`] ?? []) as Any[]));
      expect(logs[0]!.length).toBe(39);
      // The first run did use all of it: a conversation (number 1, a dialogue variable set), a timeline handle after the
      // start one, the late one, a sound, timers, counters, play time.
      const last = logs[0]!.at(-1)!;
      expect(last.slice(0, 2)).toEqual([228, 1]);
      expect(last[3]).toBe(true);
      expect([last[4], last[5], last[8]]).toEqual([2, 3, 2]); // the voice took sound handle 1
      expect(last[9]).toBeGreaterThan(30);
      expect(last[12]).toBeGreaterThan(1.8);
      // Before the late play, handle 3 is no timeline in any run.
      expect(logs[0]!.find((r: Any[]) => r[0] === 144)![6]).toBeNull();
      expect(logs[1], 'run 2 as seen by the script').toEqual(logs[0]);
      expect(logs[2], 'run 3 as seen by the script').toEqual(logs[0]);
      // The runtime's own per-run states at every run step the three runs share.
      for (const r of [1, 2]) {
        const differ = [...states[0]!.keys()].filter((step) => step < STEPS - 2 && states[r]!.get(step) !== states[0]!.get(step));
        expect(differ.slice(0, 1).map((step) => [step, states[0]!.get(step), states[r]!.get(step)]), `run ${r + 1}: first differing run step`).toEqual([]);
      }
    } finally {
      await h.dispose();
    }
  }, 120_000);
});

/** Walks the player right for 6 s, then stands; logs its exact position every 10 of its steps (one key per run). */
const WALKER = `
export default {
  instantiate() { return { n: 0, run: -1 }; },
  step(s, ctx) {
    if (ctx.phase !== 'intent') return;
    if (s.n === 0) { s.run = ctx.save.get('runs') ?? 0; ctx.save.set('runs', s.run + 1); }
    const n = s.n++;
    if (n >= 10 && n < 730) ctx.emit({ kind: 'control_move', value: 1 });
    if (n % 20 !== 0 || n > 800) return;
    const key = 'walk' + s.run;
    const log = ctx.save.get(key) ?? [];
    const t = ctx.world.transform('player-0001');
    log.push([n, ...t.position]);
    ctx.save.set(key, log);
  },
};
`;

/** A streamed block floor 160 m long (one-metre cells, 16 m chunks) whose collision ring reaches 4 m round the player. */
function streamedFloor(): { entity: Any; data: Any; types: Any[] } {
  const layer = { cellSize: [1, 0.5, 1], bounds: { min: [0, 0, 0], max: [160, 2, 16] }, streaming: { render: 4, collision: 4, hysteresis: 2 } };
  const types = [{ blockId: 'stone', name: 'Stone', variants: [{ color: '#888888' }], shape: 'full' }];
  const g = new BlockGrid(layer as Any);
  applyBlockEdits(g, [{ kind: 'fill', box: [0, 0, 0, 160, 2, 16], cell: { block: 'stone' } }], { types: new Map(types.map((t) => [t.blockId, t as Any])), stamps: new Map() });
  return { entity: { id: 'floor-0001', components: { transform: T([-1, -1, -8]), blockLayer: layer } }, data: g.toData('floor-0001', null, g.takeDirty().chunks)!, types };
}

async function streamedRuns(mode: Mode): Promise<{ logs: Any[][]; resident: number[][]; startColliders: number[]; errors: Any[] }> {
  const floor = streamedFloor();
  const startColliders: number[] = [];
  const settings = { gravity_y: -20, run_speed: 4, jump_velocity: 8, max_fall_speed: -20, max_slope_climb_deg: 45, min_slope_slide_deg: 30, physics_dimension: 3 };
  const entities: Any[] = [
    { id: 'player-0001', components: { transform: T([1, 0.91, 0]), controller: {} } },
    floor.entity,
    { id: 'walker-0001', components: { transform: T([0, -5, 0]), behavior: { behaviorId: 'walker', values: {} } } },
  ];
  const h = await startHarness(mode, {
    snapshot: { snapshotId: 'stream-runs@r1', projectId: 'stream-runs', revision: 1, scene: { schemaVersion: 4, sceneId: 'scene-main', revision: 1, entities, blocks: [floor.data] }, scenes: [{ sceneId: 'scene-main', start: true, entityIds: entities.map((e) => e.id) }], blockTypes: floor.types },
    storage: true,
    settings,
    physics: physics3DConfigOf(entities, settings),
    modules: MODULES_3D,
    behaviors: [behaviorModule('walker', WALKER)],
    // The colliders the world holds right after each run's rebuild (the world the run starts on).
    wrapPhysics: (port: Any) =>
      new Proxy(port, {
        get: (target, key) =>
          key === 'restartWorld'
            ? (...args: Any[]) => {
                target.restartWorld(...args);
                startColliders.push(target.diagnostics().worldColliderCount);
              }
            : typeof target[key] === 'function' ? target[key].bind(target) : target[key],
      }),
  });
  const rt = h.rt as Any;
  const resident: number[][] = [[], [], []];
  try {
    let now = 10;
    // The first frame anchors the clock: from then on each frame is one step.
    await h.tick(now);
    for (let r = 0; r < 3; r += 1) {
      for (let i = 0; i < 820; i += 1) {
        now += DT;
        await h.tick(now);
        // The collision ring's chunks after each of a run's first steps (the main thread's runtime reports them).
        const d = rt.getDiagnostics();
        if (mode !== 'single' || !d.ok) continue;
        const start = rt.runStart();
        const runStep = d.diagnostics.stepIndex - start.step;
        if (runStep < 30) resident[start.run]![runStep] = d.diagnostics.worldStream?.collision.resident ?? -1;
      }
      if (r < 2) expect(h.host.control('replay').ok).toBe(true);
    }
    const d = rt.getDiagnostics();
    const values = await h.storage();
    return { logs: [0, 1, 2].map((r) => (values[`walk${r}`] ?? []) as Any[]), resident, startColliders, errors: d.ok ? d.diagnostics.errors.filter((e: Any) => e.code !== 'behavior_log') : [d] };
  } finally {
    await h.dispose();
  }
}

describe('a streamed world restarts with the rings of its start', () => {
  it('a run that ended far away restarts with the collision ring round the start, and repeats the first run; page and worker', async () => {
    for (const mode of ['single', 'worker'] as const) {
      const { logs, resident, startColliders, errors } = await streamedRuns(mode);
      expect(errors).toEqual([]);
      expect(logs[0]!.length).toBe(41);
      // The player walked along the floor into the next chunks (out of the start's ring) and stayed on it.
      const end = logs[0]!.at(-1)!;
      expect(end[1]).toBeGreaterThan(12);
      expect(end[2]).toBeGreaterThan(0.85);
      expect(logs[1], `${mode} run 2`).toEqual(logs[0]);
      expect(logs[2], `${mode} run 3`).toEqual(logs[0]);
      if (mode === 'single') {
        // The ring at the start of every run is the first run's, step by step (the first frame ran the first run's
        // first steps at once: compared from the first one sampled).
        const from = resident[0]!.findIndex((n) => n !== undefined);
        expect(from).toBeGreaterThan(0);
        expect(from).toBeLessThan(20);
        expect(resident[1]!.slice(from)).toEqual(resident[0]!.slice(from));
        expect(resident[2]!.slice(from)).toEqual(resident[0]!.slice(from));
        // Each run starts on a world holding what the first run's held (the capsule: the floor's chunks come with
        // the ring after the first step), not the last run's ring round where it ended.
        expect(startColliders).toEqual([1, 1, 1]);
      }
    }
  }, 180_000);
});
