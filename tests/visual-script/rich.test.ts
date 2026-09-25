/**
 * Phase 19.1: rich visual scripts run exactly like the equivalent TypeScript.
 *
 * - Collections, a seeded random switch, a script function and a shared
 *   function, a gate, do once and a step-counted delay: the graph and the
 *   hand-written TypeScript give the same per-step trace over a run and a
 *   replay (and the graph twice gives the same trace).
 * - Sensors and messages: on trigger enter → a timer → hide this object, add
 *   a coin, play a sound, send a message another event counts; the transform
 *   phase moves the script's own object (`ownedTransforms: ["@self"]`,
 *   generated). Graph and TypeScript give the same trace.
 * - Bounds: a runaway While, a list past its cap and a runaway loop inside a
 *   function are script errors naming the node (`fn:<id>/<node>` inside a
 *   function).
 */
import { describe, expect, it } from 'vitest';

import type { GraphData } from '@thirdlight/project-model';

import { compileGraph, compileTs, level, node, trace, wire, type Any } from './harness';

/** The generated module's deterministic helpers, repeated for the TypeScript twins. */
const TS_RANDOM = `
function seed(id: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < id.length; i++) h = Math.imul(h ^ id.charCodeAt(i), 0x01000193);
  return h | 0;
}
function rnd(s: { rng: number }): number {
  let t = (s.rng = (s.rng + 0x6d2b79f5) | 0);
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
function rint(s: { rng: number }, a: number, b: number): number {
  const lo = Math.ceil(Math.min(a, b));
  const hi = Math.floor(Math.max(a, b));
  return hi < lo ? lo : lo + Math.floor(rnd(s) * (hi - lo + 1));
}
`;

const FUNCTION_DOUBLE: GraphData = {
  nodes: [
    node('start', 'fn.entry', { name: 'double' }),
    node('x', 'fn.input', { name: 'x', type: 'number' }, [0, 100]),
    node('y', 'fn.output', { name: 'y', type: 'number' }, [600, 100]),
    node('acc', 'var.number', { name: 'acc' }, [0, -100]),
    node('times', 'math.multiply', { b: 2 }),
    node('set', 'var.set', { variable: 'acc' }),
    node('get', 'var.get', { variable: 'acc' }),
  ],
  edges: [wire('1', 'start', 'then', 'set', 'in'), wire('2', 'x', 'value', 'times', 'a'), wire('3', 'times', 'result', 'set', 'value'), wire('4', 'get', 'value', 'y', 'value')],
};
const SHARED_TRIPLE: GraphData = {
  nodes: [node('start', 'fn.entry', { name: 'triple' }), node('x', 'fn.input', { name: 'x', type: 'number' }, [0, 100]), node('times', 'math.multiply', { b: 3 }), node('y', 'fn.output', { name: 'y', type: 'number' }, [400, 100])],
  edges: [wire('1', 'x', 'value', 'times', 'a'), wire('2', 'times', 'result', 'y', 'value')],
};
const ENV = { functions: [{ functionId: 'double', graph: FUNCTION_DOUBLE }], graphs: [{ graphId: 'shared', kind: 'behavior-library', name: 'Triple', graph: SHARED_TRIPLE }] };

const RICH: GraphData = {
  nodes: [
    node('v-seen', 'var.list', { name: 'seen' }, [0, -400]),
    node('v-total', 'var.number', { name: 'total', visibility: 'private' }, [0, -380]),
    node('v-table', 'var.map', { name: 'table' }, [0, -360]),
    node('v-mode', 'var.enum', { name: 'mode', options: 'calm, busy', default: 'busy' }, [0, -340]),
    // On start: seen = [1, 2, 3, 4, 5].
    node('start', 'event.start'),
    node('fill', 'flow.for', { first: 1, last: 5 }),
    node('get-seen', 'var.get', { variable: 'seen' }),
    node('push', 'list.add', { of: 'number' }),
    node('set-seen', 'var.set', { variable: 'seen' }),
    // On step: sequence A.
    node('step', 'event.step'),
    node('seq-a', 'flow.sequence'),
    node('each', 'flow.foreach', { of: 'number' }),
    node('get-seen-2', 'var.get', { variable: 'seen' }),
    node('call', 'fn.call', { function: 'double' }),
    node('get-total', 'var.get', { variable: 'total' }),
    node('plus', 'math.add'),
    node('set-total', 'var.set', { variable: 'total' }),
    node('lib', 'fn.library', { function: 'shared' }),
    node('get-total-2', 'var.get', { variable: 'total' }),
    node('tripled', 'api.game.add', { name: 'tripled' }),
    node('dice', 'random.integer', { min: 1, max: 6 }),
    node('roll', 'flow.switch', { on: 'int', cases: '1, 6' }),
    node('ones', 'api.game.add', { name: 'ones' }),
    node('sixes', 'api.game.add', { name: 'sixes' }),
    node('other', 'api.game.add', { name: 'other' }),
    node('gate', 'flow.gate'),
    node('gated', 'api.game.add', { name: 'gated' }),
    // Sequence B.
    node('seq-b', 'flow.sequence'),
    node('get-mode', 'var.get', { variable: 'mode' }),
    node('mood', 'flow.switch', { on: 'text', cases: 'calm, busy' }),
    node('once', 'flow.doonce'),
    node('once-add', 'api.game.add', { name: 'once' }),
    node('delay', 'flow.delay', { seconds: 0.1 }),
    node('delayed', 'api.game.add', { name: 'delayed' }),
    node('get-table', 'var.get', { variable: 'table' }),
    node('five', 'math.modulo', { b: 5 }),
    node('key', 'text.join', { a: 'k' }),
    node('put', 'map.set', { of: 'number' }),
    node('get-total-3', 'var.get', { variable: 'total' }),
    node('set-table', 'var.set', { variable: 'table' }),
    node('get-table-2', 'var.get', { variable: 'table' }),
    node('size', 'map.size'),
    node('mapsize', 'api.game.add', { name: 'mapsize' }),
  ],
  edges: [
    wire('s1', 'start', 'then', 'fill', 'in'),
    wire('s2', 'fill', 'body', 'set-seen', 'in'),
    wire('s3', 'get-seen', 'value', 'push', 'list'),
    wire('s4', 'fill', 'index', 'push', 'item'),
    wire('s5', 'push', 'list', 'set-seen', 'value'),
    wire('a1', 'step', 'then', 'seq-a', 'in'),
    wire('a2', 'seq-a', 'then1', 'each', 'in'),
    wire('a3', 'get-seen-2', 'value', 'each', 'list'),
    wire('a4', 'each', 'body', 'call', 'in'),
    wire('a5', 'each', 'item', 'call', 'x'),
    wire('a6', 'call', 'then', 'set-total', 'in'),
    wire('a7', 'get-total', 'value', 'plus', 'a'),
    wire('a8', 'call', 'y', 'plus', 'b'),
    wire('a9', 'plus', 'result', 'set-total', 'value'),
    wire('a10', 'each', 'completed', 'lib', 'in'),
    wire('a11', 'get-total-2', 'value', 'lib', 'x'),
    wire('a12', 'lib', 'then', 'tripled', 'in'),
    wire('a13', 'lib', 'y', 'tripled', 'amount'),
    wire('a14', 'seq-a', 'then2', 'roll', 'in'),
    wire('a15', 'dice', 'result', 'roll', 'value'),
    wire('a16', 'roll', 'case1', 'ones', 'in'),
    wire('a17', 'roll', 'case2', 'sixes', 'in'),
    wire('a18', 'roll', 'default', 'other', 'in'),
    wire('a19', 'seq-a', 'then3', 'gate', 'in'),
    wire('a20', 'gate', 'then', 'gated', 'in'),
    wire('a21', 'seq-a', 'then4', 'seq-b', 'in'),
    wire('b1', 'seq-b', 'then1', 'mood', 'in'),
    wire('b2', 'get-mode', 'value', 'mood', 'value'),
    wire('b3', 'mood', 'case2', 'once', 'in'),
    wire('b4', 'once', 'then', 'once-add', 'in'),
    wire('b5', 'once-add', 'then', 'gate', 'close'),
    wire('b6', 'seq-b', 'then2', 'delay', 'in'),
    wire('b7', 'delay', 'then', 'delayed', 'in'),
    wire('b8', 'seq-b', 'then3', 'set-table', 'in'),
    wire('b9', 'get-table', 'value', 'put', 'map'),
    wire('b10', 'step', 'step', 'five', 'a'),
    wire('b11', 'five', 'result', 'key', 'b'),
    wire('b12', 'key', 'result', 'put', 'key'),
    wire('b13', 'get-total-3', 'value', 'put', 'value'),
    wire('b14', 'put', 'map', 'set-table', 'value'),
    wire('b15', 'set-table', 'then', 'mapsize', 'in'),
    wire('b16', 'get-table-2', 'value', 'size', 'map'),
    wire('b17', 'size', 'result', 'mapsize', 'amount'),
  ],
};

const RICH_TS = `
import type { BehaviorContext } from '@thirdlight/runtime';

export const properties = {
  mode: property.enum('busy', { values: ['calm', 'busy'] }),
};
${TS_RANDOM}
type S = { started: boolean; seen: number[]; total: number; table: Map<string, number>; mode: string; gate: boolean; once: boolean; pending: boolean; rng: number };

export default {
  instantiate(_p: unknown, inst: { entityId: string; properties: Record<string, any> }): S {
    return { started: false, seen: [], total: 0, table: new Map(), mode: inst.properties.mode, gate: true, once: false, pending: false, rng: seed(inst.entityId) };
  },
  step(s: S, ctx: BehaviorContext): void {
    if (ctx.phase !== 'intent') return;
    if (!s.started) {
      s.started = true;
      for (let i = 1; i <= 5; i++) s.seen = [...s.seen, i];
    }
    // Events and pending delays in node-id order: "delay" before "step".
    if (s.pending && ctx.timers.fired('vs.delay.0')) {
      s.pending = false;
      ctx.game?.add('delayed', 1);
    }
    for (const item of s.seen) {
      const acc = item * 2;
      s.total = s.total + acc;
    }
    ctx.game?.add('tripled', s.total * 3);
    const dice = rint(s, 1, 6);
    if (dice === 1) ctx.game?.add('ones', 1);
    else if (dice === 6) ctx.game?.add('sixes', 1);
    else ctx.game?.add('other', 1);
    if (s.gate) ctx.game?.add('gated', 1);
    if (s.mode === 'busy' && !s.once) {
      s.once = true;
      ctx.game?.add('once', 1);
      s.gate = false;
    }
    if (!s.pending) {
      s.pending = true;
      ctx.timers.after('vs.delay.0', 0.1);
    }
    const m = new Map(s.table);
    m.set('k' + String(ctx.stepIndex % 5), s.total);
    s.table = m;
    ctx.game?.add('mapsize', s.table.size);
  },
};
`;

/** Trigger → timer → hide + coin + sound + message; the transform phase moves this object. */
const SENSOR: GraphData = {
  nodes: [
    node('v-speed', 'var.number', { name: 'speed', default: 0.001 }, [0, -200]),
    node('e1-enter', 'event.trigger', { when: 'enter' }),
    node('timer', 'api.timers.after', { name: 'open', seconds: 0.25 }),
    node('e2-exit', 'event.trigger', { when: 'exit' }, [0, 100]),
    node('left', 'api.game.add', { name: 'left' }),
    node('e3-fired', 'event.timer', { timer: 'open' }, [0, 200]),
    node('hide', 'api.game.setVisible', { visible: false }),
    node('coin', 'api.game.add', { name: 'coins' }),
    node('sound', 'api.audio.play', { assetId: 'ding' }),
    node('send', 'api.messages.send', { name: 'opened', value: '7' }),
    node('e4-msg', 'event.message', { message: 'opened', type: 'number' }, [0, 300]),
    node('heard', 'api.game.add', { name: 'heard' }),
    node('e5-move', 'event.step', { phase: 'transform' }, [0, 400]),
    node('move', 'api.emit.transform', { position_axes: 'x' }),
    node('get-speed', 'var.get', { variable: 'speed' }),
    node('scaled', 'math.multiply'),
    node('shifted', 'math.add', { b: 1 }),
    node('vec', 'vec.make'),
  ],
  edges: [
    wire('1', 'e1-enter', 'then', 'timer', 'in'),
    wire('2', 'e2-exit', 'then', 'left', 'in'),
    wire('3', 'e3-fired', 'then', 'hide', 'in'),
    wire('4', 'hide', 'then', 'coin', 'in'),
    wire('5', 'coin', 'then', 'sound', 'in'),
    wire('6', 'sound', 'then', 'send', 'in'),
    wire('7', 'e4-msg', 'then', 'heard', 'in'),
    wire('8', 'e4-msg', 'value', 'heard', 'amount'),
    wire('9', 'e5-move', 'then', 'move', 'in'),
    wire('10', 'e5-move', 'step', 'scaled', 'a'),
    wire('11', 'get-speed', 'value', 'scaled', 'b'),
    wire('12', 'scaled', 'result', 'shifted', 'a'),
    wire('13', 'shifted', 'result', 'vec', 'x'),
    wire('14', 'vec', 'vector', 'move', 'position'),
  ],
};

const SENSOR_TS = `
import type { BehaviorContext } from '@thirdlight/runtime';

export const properties = {
  speed: property.number(0.001),
};

export default {
  instantiate(_p: unknown, inst: { properties: Record<string, any> }) {
    return { speed: inst.properties.speed as number };
  },
  step(s: { speed: number }, ctx: BehaviorContext): void {
    if (ctx.phase === 'intent') {
      for (const ev of (ctx.events ?? []) as any[]) if (ev.type === 'enter') ctx.timers.after('open', 0.25);
      for (const ev of (ctx.events ?? []) as any[]) if (ev.type === 'exit') ctx.game?.add('left', 1);
      if (ctx.timers.fired('open')) {
        ctx.game?.setVisible(ctx.entityId, false);
        ctx.game?.add('coins', 1);
        ctx.audio?.play('ding', { volume: 1 });
        ctx.messages?.send('opened', 7);
      }
      for (const m of ctx.messages?.received('opened') ?? []) ctx.game?.add('heard', Number(m.value));
    } else if (ctx.phase === 'transform') {
      ctx.emit({ kind: 'transform', entityId: ctx.entityId, position: { x: ctx.stepIndex * s.speed + 1 } });
    }
  },
};
`;

const SENSOR_LEVEL = { director: [1, 0.91, 0] as [number, number, number], directorComponents: { trigger: { size: [1, 2], signal: 'passed' } } };

describe('rich visual scripts: the graph and the equivalent TypeScript', () => {
  it('collections, a seeded random switch, a function and a shared function, gate, do once and delay give the same replay', async () => {
    const graph = await compileGraph(RICH, ENV);
    const [graphRun, tsRun, again] = [await trace(graph), await trace(await compileTs(RICH_TS)), await trace(graph)];
    expect(graphRun).toEqual(tsRun);
    expect(graphRun).toEqual(again);
    const end = JSON.parse(graphRun[60]!) as [Record<string, number>, number, number, boolean];
    expect(end[3]).toBe(false);
    // What it did: once and gated once per run, delays every 12 steps, dice rolls every step.
    expect(end[0]['once']).toBe(1);
    expect(end[0]['gated']).toBe(1);
    expect(end[0]['delayed']).toBeGreaterThanOrEqual(4);
    expect((end[0]['ones'] ?? 0) + (end[0]['sixes'] ?? 0) + (end[0]['other'] ?? 0)).toBe(60);
    expect(end[0]['mapsize']).toBeGreaterThan(0);
    expect(end[0]['tripled']).toBeGreaterThan(0);
    // The replay repeats the run exactly (the random sequence restarts with it).
    expect(JSON.parse(graphRun[120]!)[0]).toEqual(end[0]);
  });

  it('trigger enter → timer → hide, coin, sound and a message; the transform phase moves this object (@self generated)', async () => {
    const graph = await compileGraph(SENSOR);
    expect(graph.manifest.ownedTransforms).toEqual(['@self']);
    const [graphRun, tsRun] = [await trace(graph, SENSOR_LEVEL, 90), await trace(await compileTs(SENSOR_TS, ['@self']), SENSOR_LEVEL, 90)];
    expect(graphRun).toEqual(tsRun);
    const end = JSON.parse(graphRun[90]!) as [Record<string, number>, number, number, boolean, number[]];
    expect(end[3]).toBe(false);
    expect(end[0]['coins']).toBe(1);
    expect(end[0]['heard']).toBe(7);
    // Moved by its own transform intents (x = 1 + step × speed).
    expect(end[4][0]).toBeGreaterThan(1_000_000);
  });
});

describe('bounds: script errors naming the node', () => {
  const failure = async (graph: GraphData, env?: Parameters<typeof compileGraph>[1]): Promise<Any> => {
    const L = await level(await compileGraph(graph, env));
    // Scripts also run in the settle step before the game starts: it may fail there already.
    L.tick();
    if (L.rt.getDiagnostics().diagnostics.failed !== true) {
      expect(L.rt.gameCommand('start').ok).toBe(true);
      for (let i = 0; i < 3; i++) L.tick();
    }
    const d = L.rt.getDiagnostics().diagnostics;
    expect(d.failed).toBe(true);
    return d.errors[d.errors.length - 1];
  };

  it('a runaway While', async () => {
    const err = await failure({
      nodes: [node('step', 'event.step'), node('runaway', 'flow.while', { condition: true }), node('count', 'api.game.add', { name: 'spins' })],
      edges: [wire('a', 'step', 'then', 'runaway', 'in'), wire('b', 'runaway', 'body', 'count', 'in')],
    });
    expect(err).toMatchObject({ reason: 'behavior_step_failed', nodeId: 'runaway', detail: 'iteration_cap' });
  });

  it('a list past its cap', async () => {
    const err = await failure({
      nodes: [node('v', 'var.list', { name: 'items' }, [0, -100]), node('start', 'event.start'), node('loop', 'flow.for', { first: 1, last: 1100 }), node('get', 'var.get', { variable: 'items' }), node('push', 'list.add', { of: 'number' }), node('set', 'var.set', { variable: 'items' })],
      edges: [wire('a', 'start', 'then', 'loop', 'in'), wire('b', 'loop', 'body', 'set', 'in'), wire('c', 'get', 'value', 'push', 'list'), wire('d', 'loop', 'index', 'push', 'item'), wire('e', 'push', 'list', 'set', 'value')],
    });
    expect(err).toMatchObject({ reason: 'behavior_step_failed', nodeId: 'push', detail: 'list_cap' });
  });

  it('a runaway loop inside a function (fn:<function>/<node>)', async () => {
    const spin: GraphData = {
      nodes: [node('start', 'fn.entry'), node('loop', 'flow.while', { condition: true }), node('log', 'debug.log')],
      edges: [wire('a', 'start', 'then', 'loop', 'in'), wire('b', 'loop', 'body', 'log', 'in')],
    };
    const err = await failure({ nodes: [node('step', 'event.step'), node('call', 'fn.call', { function: 'spin' })], edges: [wire('a', 'step', 'then', 'call', 'in')] }, { functions: [{ functionId: 'spin', graph: spin }] });
    expect(err).toMatchObject({ reason: 'behavior_step_failed', nodeId: 'fn:spin/loop', detail: 'iteration_cap' });
  });
});
