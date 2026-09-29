/**
 * Behavior callbacks through the production composition, on the
 * main thread and in the simulation worker, on the 2D plane and in 3D.
 *
 * A neutral level: the character walks right through a trigger and into a
 * hitbox; an animated model passes a clip event; a UI event arrives on the
 * input frame; a director sends messages, switches a lamp (with a child) off
 * and on through `ctx.entity(id).set('object', { active })`, spawns and
 * destroys a prefab copy, loads and unloads a scene and restarts the run.
 *
 * - `life` (on the lamp, its child, the prefab root and an object of the
 *   second scene) logs onEnable/onDisable/onDestroy and its first step after
 *   each enable: enable comes before the step in the same step, a switched-off
 *   parent disables its child too, a destroyed or unloaded object hears
 *   onDisable then onDestroy (its object already gone), a restart sends
 *   onEnable again and no onDestroy for the copies it clears.
 * - `logger` owns the trigger, the hitbox and the model through its object
 *   properties and logs every event callback and the matching `ctx.events`
 *   entries: the callbacks run before the step and see the same events (the
 *   lists stay).
 * The logs agree in page and worker, and every step's digest is identical in
 * both modes and in a second run (replays stay identical).
 */
import { describe, expect, it } from 'vitest';

import { readModelRig, type GraphData } from '@thirdlight/project-model';
import { physics3DConfigOf } from '@thirdlight/runtime';

import { compileBehaviorGraph, createBehaviorCompiler } from '../../../packages/behavior-build/src/index';

import { socketGlb } from '../../e2e/socket-glb';
import { FakeNode, behaviorModule, startHarness, type Mode } from '../m22-worker/harness';
import { MODULES_3D } from '../m23-3d/character-kit';

type Any = any;
const DT = 1 / 120;
const T = (position: number[]) => ({ position, rotation: [0, 0, 0, 1], scale: [1, 1, 1] });

const LOG = (key: string) => `const log = (ctx, what) => { const l = ctx.save.get('${key}') ?? []; l.push(ctx.stepIndex + ':' + what); ctx.save.set('${key}', l); };`;

const LIFE = `
${LOG('life')}
export default {
  instantiate() { return { stepped: true }; },
  onEnable(s, ctx) { s.stepped = false; log(ctx, 'enable:' + ctx.entityId); },
  onDisable(s, ctx) { log(ctx, 'disable:' + ctx.entityId); },
  onDestroy(s, ctx) { log(ctx, 'destroy:' + ctx.entityId + (ctx.entity(ctx.entityId) === null ? '' : ':still-there')); },
  step(s, ctx) {
    if (ctx.phase === 'intent' && !s.stepped) { s.stepped = true; log(ctx, 'step:' + ctx.entityId); }
  },
};
`;

const LOGGER = `
${LOG('ev')}
export default {
  onTriggerEnter(s, e, ctx) { log(ctx, 'enter:' + e.trigger); },
  onTriggerExit(s, e, ctx) { log(ctx, 'exit:' + e.trigger); },
  onContact(s, e, ctx) { log(ctx, e.type + ':' + e.entity + ':' + e.other); },
  onMessage(s, m, ctx) { log(ctx, 'msg:' + m.name + ':' + m.value + ':' + m.from); },
  onUiEvent(s, e, ctx) { log(ctx, 'ui:' + e.kind + ':' + e.name + ':' + e.value); },
  onAnimatorEvent(s, e, ctx) { log(ctx, 'anim:' + e.name + ':' + e.entityId); },
  step(s, ctx) {
    if (ctx.phase !== 'intent') return;
    for (const e of ctx.events ?? []) {
      if (e.clip !== undefined) log(ctx, 'list:anim');
      else if (e.type === 'enter' || e.type === 'exit' || e.type === 'contact' || e.type === 'separate') log(ctx, 'list:' + e.type);
    }
  },
};
`;
const LOGGER_DECLARATION = {
  properties: [
    { key: 'zone', label: 'Zone', type: 'entityRef', default: null },
    { key: 'thorn', label: 'Thorn', type: 'entityRef', default: null },
    { key: 'table', label: 'Table', type: 'entityRef', default: null },
  ],
};

const DIRECTOR = `
export default {
  instantiate() { return { crate: null }; },
  step(s, ctx) {
    if (ctx.phase !== 'intent') return;
    const n = ctx.stepIndex;
    if (n === 10) {
      ctx.messages.send('ping', 7);
      ctx.messages.send('poke', 'hi', 'logger-0001');
      ctx.messages.send('other', 1, 'lamp-0001');
    }
    if (n === 100) ctx.entity('lamp-0001').set('object', { active: false });
    if (n === 150) ctx.entity('lamp-0001').set('object', { active: true });
    if (n === 200) s.crate = ctx.spawn('crate', { position: [-8, 2] });
    if (n === 260) ctx.destroy(s.crate);
    if (n === 300) ctx.scenes.load('scene-two');
    if (n === 400) ctx.scenes.unload('scene-two');
    if (n === 600) ctx.spawn('crate', { position: [-9, 2] });
    if (n === 500) ctx.entity('thorn-0001').set('object', { active: false });
    if (n === 550) ctx.entity('thorn-0001').set('object', { active: true });
    if (n === 700) ctx.lifecycle.restart();
  },
};
`;

/** A visual script on the thorn: its callback event nodes count into the run's counters (the UI event adds its value). */
const VS_GRAPH: GraphData = {
  nodes: [
    { id: 'en', type: 'event.enable', position: [0, 0] },
    { id: 'di', type: 'event.disable', position: [0, 100] },
    { id: 'co', type: 'event.contact', position: [0, 200], data: { when: 'contact' } },
    { id: 'ui', type: 'event.ui', position: [0, 300], data: { name: 'go', type: 'number' } },
    { id: 'a1', type: 'api.game.add', position: [300, 0], data: { name: 'vs_enable', amount: 1 } },
    { id: 'a2', type: 'api.game.add', position: [300, 100], data: { name: 'vs_disable', amount: 1 } },
    { id: 'a3', type: 'api.game.add', position: [300, 200], data: { name: 'vs_contact', amount: 1 } },
    { id: 'a4', type: 'api.game.add', position: [300, 300], data: { name: 'vs_ui', amount: 0 } },
  ],
  edges: [
    { id: 'e1', from: { node: 'en', port: 'then' }, to: { node: 'a1', port: 'in' } },
    { id: 'e2', from: { node: 'di', port: 'then' }, to: { node: 'a2', port: 'in' } },
    { id: 'e3', from: { node: 'co', port: 'then' }, to: { node: 'a3', port: 'in' } },
    { id: 'e4', from: { node: 'ui', port: 'then' }, to: { node: 'a4', port: 'in' } },
    { id: 'e5', from: { node: 'ui', port: 'value' }, to: { node: 'a4', port: 'amount' } },
  ],
};
let vsSource: Promise<string> | null = null;
function visualScript(): Promise<string> {
  vsSource ??= compileBehaviorGraph(createBehaviorCompiler(), { behaviorId: 'vs', graph: VS_GRAPH, limits: { timeoutMs: 30_000 } }).then((r) => {
    if (!r.ok) throw new Error(JSON.stringify(r.failure));
    return new TextDecoder().decode(r.result.outputBytes);
  });
  return vsSource;
}

const RIG = (() => {
  const r = readModelRig(socketGlb(), 'model-socket');
  if (!r.ok) throw new Error(r.message);
  return r.rig;
})();
// The fixture's clip (4 s, looping) passes "beat" at 0.5 s.
const CONTROLLER = {
  controllerId: 'ctl-slide',
  name: 'Slide',
  parameters: [],
  states: [{ id: 'st-slide', name: 'Slide', motion: { kind: 'clip', clip: { assetId: 'model-socket', clip: 'slide', duration: 4 } }, speed: 1, loop: true }],
  transitions: [],
  entry: 'st-slide',
  events: [{ assetId: 'model-socket', clip: 'slide', time: 0.5, name: 'beat' }],
};

const PREFABS = [
  {
    prefabId: 'crate',
    displayName: 'Crate',
    createdRevision: 1,
    entityCount: 1,
    depth: 1,
    entities: [{ localId: 'root', components: { transform: T([0, 0, 0]), box: { size: [1, 1, 1], material: { color: '#aa7733' } }, behavior: { behaviorId: 'life', values: {} } } }],
  },
];

type Dim = 2 | 3;

function level(dim: Dim): { main: Any[]; two: Any[] } {
  const z = dim === 3;
  const main: Any[] = [
    { id: 'cam-main', components: { transform: T([0, 4, 14]), camera: { type: 'perspective', fovY: 50, near: 0.1, far: 300 } } },
    { id: 'player-0001', components: { transform: T([0, 0.91, 0]), controller: {} } },
    { id: 'floor-0001', components: { transform: T([0, -0.5, 0]), box: { size: [60, 1, 4], material: { color: '#888888' } }, collider: { shape: z ? { type: 'box', hx: 30, hy: 0.5, hz: 2 } : { type: 'box', hx: 30, hy: 0.5 } } } },
    { id: 'zone-0001', components: { transform: T([3, 1.5, 0]), trigger: z ? { size: [1, 3, 2], signal: 'zone' } : { size: [1, 3], signal: 'zone' } } },
    { id: 'thorn-0001', components: { transform: T([6, 0.25, 0]), hitbox: { size: z ? [0.5, 0.5, 0.5] : [0.5, 0.5] }, behavior: { behaviorId: 'vs', values: {} } } },
    { id: 'table-0001', components: { transform: T([-5, 0, 0]), model: { asset: { assetId: 'model-socket' } }, animator: { controller: 'ctl-slide' } } },
    { id: 'lamp-0001', components: { transform: T([-2, 3, 0]), box: { size: [0.5, 0.5, 0.5], material: { color: '#ffffff' } }, behavior: { behaviorId: 'life', values: {} } } },
    { id: 'bulb-0001', parentId: 'lamp-0001', components: { transform: T([0, -0.5, 0]), box: { size: [0.2, 0.2, 0.2], material: { color: '#ffff00' } }, behavior: { behaviorId: 'life', values: {} } } },
    { id: 'logger-0001', components: { transform: T([0, -5, 0]), behavior: { behaviorId: 'logger', values: { zone: 'zone-0001', thorn: 'thorn-0001', table: 'table-0001' } } } },
    { id: 'director-0001', components: { transform: T([1, -5, 0]), behavior: { behaviorId: 'director', values: {} } } },
  ];
  const two: Any[] = [{ id: 'visitor-0002', components: { transform: T([-12, 2, 0]), box: { size: [1, 1, 1], material: { color: '#5588ff' } }, behavior: { behaviorId: 'life', values: {} } } }];
  return { main, two };
}

const SETTINGS_2D = { run_speed: 4, jump_velocity: 8, gravity_y: -20, max_fall_speed: -20, max_slope_climb_deg: 45, min_slope_slide_deg: 30 };
const SETTINGS_3D = { gravity_y: -19.62, run_speed: 4, jump_velocity: 7, max_fall_speed: -30, max_slope_climb_deg: 45, min_slope_slide_deg: 30, physics_dimension: 3 };

function physicsOf(dim: Dim, main: Any[]): { settings: Any; physics: Any } {
  if (dim === 3) return { settings: SETTINGS_3D, physics: physics3DConfigOf(main, SETTINGS_3D) };
  const statics = main
    .filter((e) => e.components.collider)
    .map((e) => ({ entityId: e.id, shape: e.components.collider.shape, position: { x: e.components.transform.position[0], y: e.components.transform.position[1] }, rotationZ: 0 }));
  return {
    settings: SETTINGS_2D,
    physics: { character: { x: 0, y: 0.91 }, statics, solver: { hz: 120, gravityY: SETTINGS_2D.gravity_y }, controller: { offsetSkin: 0.01, groundSnap: 0.1, maxSlopeClimbRad: Math.PI / 4, minSlopeSlideRad: Math.PI / 6, autostep: false } },
  };
}

const HUD = { uiDocumentId: 'hud', name: 'HUD', root: { type: 'button', id: 'go', text: 'Go', onClick: { do: 'event', name: 'go', value: 3 } } };
const PATTERN = [1, 2, 1, 0, 3, 1, 1, 2, 0, 1];
const STEPS = 760;

/** Walk right (the character passes the zone at x 3 and runs into the thorn at x 6), then stand; a UI click at step 50. */
function recording(dim: Dim): Any[] {
  const walk = dim === 3 ? 520 : 260;
  return Array.from({ length: STEPS + 200 }, (_, s) => {
    const f: Any = { stepIndex: s, moveX: s < walk ? 1 : 0, ...(dim === 3 ? { moveY: 0 } : {}), jump: 'none', actions: {} };
    if (s === 50) f.ui = [{ kind: 'click', doc: 'hud', widget: 'go', name: 'go', value: 3 }];
    return f;
  });
}

interface Outcome {
  /** The run's counters before the restart (the visual script's). */
  counters: Record<string, number>;
  life: string[];
  ev: string[];
  digests: string[];
  errors: Any[];
}

async function run(mode: Mode, dim: Dim): Promise<Outcome> {
  const { main, two } = level(dim);
  const h = await startHarness(mode, {
    snapshot: {
      snapshotId: `callbacks${dim}@r1`,
      projectId: `callbacks${dim}`,
      revision: 1,
      scene: { schemaVersion: 4, sceneId: 'scene-main', revision: 1, entities: main },
      scenes: [
        { sceneId: 'scene-main', start: true, entityIds: main.map((e) => e.id) },
        { sceneId: 'scene-two', start: false },
      ],
      prefabs: PREFABS,
      animators: [CONTROLLER],
      rigs: { 'model-socket': RIG },
      uiDocuments: [{ uiDocumentId: 'hud', layer: 0, modal: false }],
    },
    ...physicsOf(dim, main),
    ...(dim === 3 ? { modules: MODULES_3D } : {}),
    behaviors: [behaviorModule('director', DIRECTOR), behaviorModule('logger', LOGGER, LOGGER_DECLARATION), behaviorModule('life', LIFE), behaviorModule('vs', await visualScript())],
    loadScene: async (sceneId: string) => {
      if (sceneId !== 'scene-two') throw new Error('unknown scene');
      return two;
    },
    replay: recording(dim),
    digestSteps: true,
    storage: true,
    host: { buildId: 'b', container: new FakeNode(), ui: { documents: [HUD] } },
  });
  try {
    let now = 10;
    await h.tick(now);
    let i = 0;
    let counters: Record<string, number> | null = null;
    while (h.digests.length < STEPS) {
      if (counters === null && h.digests.length >= 660) counters = { ...((h.rt as Any).gameCounters?.()?.counters ?? {}) };
      now += PATTERN[i++ % PATTERN.length]! * DT;
      try {
        await h.tick(now);
      } catch (e) {
        const d = (h.rt as Any).getDiagnostics();
        throw new Error(`${String(e)} at step ${h.digests.length}: ${JSON.stringify(d.ok ? d.diagnostics.errors.slice(-3) : d).slice(0, 2500)}`);
      }
      if (i % 20 === 0) await new Promise((r) => setTimeout(r, 0));
    }
    await h.tick(now);
    const d = (h.rt as Any).getDiagnostics();
    const values = await h.storage();
    return { counters: counters ?? {}, life: values['life'] ?? [], ev: values['ev'] ?? [], digests: h.digests.slice(0, STEPS), errors: d.ok ? d.diagnostics.errors : [d] };
  } finally {
    await h.dispose();
  }
}

/** The log entries without their step, in order. */
const what = (log: string[]): string[] => log.map((l) => l.slice(l.indexOf(':') + 1));
const stepOf = (log: string[], entry: string): number => {
  const hit = log.find((l) => l.slice(l.indexOf(':') + 1) === entry);
  expect(hit, `${entry} in ${JSON.stringify(log)}`).toBeDefined();
  return Number(hit!.slice(0, hit!.indexOf(':')));
};

function expectInOrder(log: string[], expected: string[]): void {
  const items = what(log);
  let at = -1;
  for (const e of expected) {
    const i = items.indexOf(e, at + 1);
    expect(i, `"${e}" after position ${at} in ${JSON.stringify(log)}`).toBeGreaterThan(at);
    at = i;
  }
}

function checkLife(life: string[]): void {
  const crates = [...new Set(what(life).filter((w) => w.startsWith('enable:') && !/lamp|bulb|visitor/.test(w)).map((w) => w.slice('enable:'.length)))];
  expect(crates, JSON.stringify(life)).toHaveLength(2);
  const [crate, crate2] = crates as [string, string];
  expectInOrder(life, [
    'enable:lamp-0001', 'step:lamp-0001', 'enable:bulb-0001', 'step:bulb-0001',
    // Switched off (with its child) and on again.
    'disable:lamp-0001', 'disable:bulb-0001', 'enable:lamp-0001', 'step:lamp-0001', 'enable:bulb-0001', 'step:bulb-0001',
    // A spawned copy: enabled, then destroyed (onDisable first; the object is gone).
    `enable:${crate}`, `step:${crate}`, `disable:${crate}`, `destroy:${crate}`,
    // A loaded scene's object, unloaded.
    'enable:visitor-0002', 'step:visitor-0002', 'disable:visitor-0002', 'destroy:visitor-0002',
    `enable:${crate2}`,
    // The restart: every instance starts again (onEnable), the copy it clears gets no callback.
    'enable:lamp-0001', 'enable:bulb-0001',
  ]);
  // Each enable comes in the same step as the step that follows it.
  for (let i = 0; i < life.length; i += 1) {
    const e = life[i]!;
    const m = /^(\d+):enable:(.+)$/.exec(e);
    if (m === null) continue;
    const next = life.slice(i + 1).find((l) => l.endsWith(`:step:${m[2]}`));
    if (next !== undefined) expect(next.startsWith(`${m[1]}:`), `${e} then ${next}`).toBe(true);
  }
  // The switch at step 100 applies at its end: the scripts hear it in step 101 (and 151 when switched on).
  expect(stepOf(life, 'disable:lamp-0001')).toBe(101);
  expect(life.filter((l) => l.endsWith('enable:lamp-0001')).map((l) => Number(l.split(':')[0])).slice(1, 2)).toEqual([151]);
  expect(stepOf(life, `destroy:${crate}`)).toBe(261);
  expect(what(life).filter((w) => w.includes(crate2))).toEqual([`enable:${crate2}`, `step:${crate2}`]);
  expect(what(life).some((w) => w.includes('still-there'))).toBe(false);
  // Nothing while the lamp was off.
  const off = life.filter((l) => { const s = Number(l.split(':')[0]); return s > 101 && s < 151 && /lamp|bulb/.test(l); });
  expect(off).toEqual([]);
}

function checkEvents(ev: string[]): void {
  const items = what(ev);
  // Messages of the last step, in send order: the broadcast and the one to this object, not the other object's.
  expect(items.filter((w) => w.startsWith('msg:'))).toEqual(['msg:ping:7:director-0001', 'msg:poke:hi:director-0001']);
  expect(stepOf(ev, 'msg:ping:7:director-0001')).toBe(11);
  expect(items.filter((w) => w.startsWith('ui:'))).toEqual(['ui:click:go:3']);
  // The clip passes its event every 4 s (steps 60 and 540; the restart at 700 starts the animator again).
  const anims = ev.filter((l) => what([l])[0]!.startsWith('anim:'));
  expect(anims.slice(0, 2)).toEqual(['60:anim:beat:table-0001', '540:anim:beat:table-0001']);
  expect(ev.filter((l) => l.endsWith(':list:anim')).map((l) => l.split(':')[0])).toEqual(anims.map((l) => l.split(':')[0]));
  expectInOrder(ev, ['enter:zone-0001', 'exit:zone-0001', 'contact:thorn-0001:player-0001', 'separate:thorn-0001:player-0001']);
  // The callbacks run before the step, which still lists the same events (in the same step).
  for (const [cb, list] of [['enter:zone-0001', 'list:enter'], ['exit:zone-0001', 'list:exit'], ['anim:beat:table-0001', 'list:anim']] as const) {
    const at = stepOf(ev, cb);
    const i = ev.indexOf(`${at}:${cb}`);
    expect(ev.indexOf(`${at}:${list}`), `${cb} then ${list} in step ${at}`).toBeGreaterThan(i);
  }
  expect(items.filter((w) => w === 'list:contact')).toHaveLength(items.filter((w) => w.startsWith('contact:')).length);
}

describe('behavior callbacks', () => {
  for (const dim of [2, 3] as const) {
    it(`lifecycle and event callbacks run in the step in a fixed order, alike in page and worker, replays identical (${dim}D)`, async () => {
      const single = await run('single', dim);
      expect(single.errors).toEqual([]);
      checkLife(single.life);
      checkEvents(single.ev);
      // The visual script's callback events: enabled at the start and when switched on again, one disable,
      // one contact (not the separation), the UI event's value added.
      expect(single.counters).toMatchObject({ vs_enable: 2, vs_disable: 1, vs_contact: 1, vs_ui: 3 });

      const worker = await run('worker', dim);
      expect(worker.life).toEqual(single.life);
      expect(worker.counters).toEqual(single.counters);
      expect(worker.ev).toEqual(single.ev);
      expect(worker.digests).toEqual(single.digests);

      // A second run plays the same, step for step.
      const again = await run('single', dim);
      expect(again.digests).toEqual(single.digests);
      expect(again.life).toEqual(single.life);
    }, 240_000);
  }
});
