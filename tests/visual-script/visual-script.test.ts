/**
 * Phase 19.0: visual scripts run like TypeScript behaviors — compiled by the
 * one compiler, executed by the real behavior host inside the production
 * composition (game host, platformer controller, Rapier), with neutral
 * fixtures.
 *
 * - Determinism: a graph and the hand-written equivalent TypeScript give the
 *   same per-step trace (counters, log count, the player's position) over a
 *   run, a replay and a second run of the graph.
 * - Every run starts fresh: On start runs again after a replay (the behavior
 *   host re-instantiates script state at the start of each run).
 * - The loop bound: a runaway For loop is a script error naming its node
 *   (`nodeId`, detail `iteration_cap`) in the runtime diagnostics.
 *
 * The compiled module is evaluated in a bounded `node:vm` context (no code
 * generation), as in tests/browser/m2-behaviors/behavior-host.test.ts.
 */
import { describe, expect, it } from 'vitest';

import type { GraphData } from '@thirdlight/project-model';

import { compileGraph, compileTs, level, node, trace, wire } from './harness';

/**
 * On start: add `amount` coins, emit "go". On step: a sequence of (1) count
 * "heard" when "go" was received, (2) ticks += 1, then "late" once ticks ≥ 5
 * else log the tick count, (3) a For loop 1..3 adding the index to "loops".
 */
const GRAPH: GraphData = {
  nodes: [
    { ...node('amount', 'var.number', { name: 'amount', default: 2 }), position: [0, -300] },
    { ...node('ticks', 'var.number', { name: 'ticks', visibility: 'private' }), position: [0, -200] },
    node('start', 'event.start'),
    node('coins', 'api.game.add', { name: 'coins' }),
    node('get-amount', 'var.get', { variable: 'amount' }),
    node('go', 'api.signals.emit', { name: 'go' }),
    node('step', 'event.step'),
    node('seq', 'flow.sequence'),
    node('heard-branch', 'flow.branch'),
    node('go-on', 'api.signals.on', { name: 'go' }),
    node('heard', 'api.game.add', { name: 'heard' }),
    node('set-ticks', 'var.set', { variable: 'ticks' }),
    node('get-ticks', 'var.get', { variable: 'ticks' }),
    node('plus-one', 'math.add', { b: 1 }),
    node('late-test', 'math.compare', { op: '>=', b: 5 }),
    node('late-branch', 'flow.branch'),
    node('late', 'api.game.add', { name: 'late' }),
    node('log', 'debug.log'),
    node('loop', 'flow.for', { first: 1, last: 3 }),
    node('loops', 'api.game.add', { name: 'loops' }),
  ],
  edges: [
    wire('w1', 'start', 'then', 'coins', 'in'),
    wire('w2', 'get-amount', 'value', 'coins', 'amount'),
    wire('w3', 'coins', 'then', 'go', 'in'),
    wire('w4', 'step', 'then', 'seq', 'in'),
    wire('w5', 'seq', 'then1', 'heard-branch', 'in'),
    wire('w6', 'go-on', 'value', 'heard-branch', 'condition'),
    wire('w7', 'heard-branch', 'true', 'heard', 'in'),
    wire('w8', 'seq', 'then2', 'set-ticks', 'in'),
    wire('w9', 'get-ticks', 'value', 'plus-one', 'a'),
    wire('w10', 'plus-one', 'result', 'set-ticks', 'value'),
    wire('w11', 'set-ticks', 'then', 'late-branch', 'in'),
    wire('w12', 'set-ticks', 'value', 'late-test', 'a'),
    wire('w13', 'late-test', 'result', 'late-branch', 'condition'),
    wire('w14', 'late-branch', 'true', 'late', 'in'),
    wire('w15', 'late-branch', 'false', 'log', 'in'),
    wire('w16', 'get-ticks', 'value', 'log', 'message'),
    wire('w17', 'seq', 'then3', 'loop', 'in'),
    wire('w18', 'loop', 'body', 'loops', 'in'),
    wire('w19', 'loop', 'index', 'loops', 'amount'),
  ],
};

const EQUIVALENT_TS = `
import type { BehaviorContext } from '@thirdlight/runtime';

export const properties = {
  amount: property.number(2),
  ticks: property.private.number(0),
};

type State = { started: boolean; amount: number; ticks: number };

export default {
  instantiate(_p: unknown, inst: { properties: Record<string, any> }): State {
    return { started: false, amount: inst.properties.amount, ticks: inst.properties.ticks };
  },
  step(s: State, ctx: BehaviorContext): void {
    if (ctx.phase !== 'intent') return;
    if (!s.started) {
      s.started = true;
      ctx.game?.add('coins', s.amount);
      ctx.signals?.emit('go');
    }
    if (ctx.signals?.on('go') ?? false) ctx.game?.add('heard', 1);
    s.ticks = s.ticks + 1;
    if (s.ticks >= 5) ctx.game?.add('late', 1);
    else ctx.log('info', String(s.ticks));
    for (let i = 1; i <= 3; i++) ctx.game?.add('loops', i);
  },
};
`;

describe('visual scripts in the running game', () => {
  it('a graph and the equivalent TypeScript give the same replay, step by step', async () => {
    const [graphRun, tsRun, graphAgain] = [await trace(await compileGraph(GRAPH)), await trace(await compileTs(EQUIVALENT_TS)), await trace(await compileGraph(GRAPH))];
    expect(graphRun).toHaveLength(121);
    expect(graphRun).toEqual(tsRun);
    expect(graphRun).toEqual(graphAgain);
    // What the script did: coins once per run start (the amount), loops 1+2+3 per step, late from the 5th step.
    const afterStart = JSON.parse(graphRun[1]!) as [Record<string, number>, number];
    expect(afterStart[0]['coins']).toBe(2);
    expect(afterStart[0]['loops']).toBe(6);
    const endOfRun = JSON.parse(graphRun[60]!) as [Record<string, number>, number, number, boolean];
    expect(endOfRun[0]['loops']).toBe(360);
    expect(endOfRun[0]['late']).toBe(56);
    expect(endOfRun[3]).toBe(false);
    // The replay starts fresh: On start ran again (coins = amount) and the ticks restarted (late counts from 5 again).
    const afterReplay = JSON.parse(graphRun[61]!) as [Record<string, number>];
    expect(afterReplay[0]['coins']).toBe(2);
    expect(afterReplay[0]['late']).toBeUndefined();
    expect(JSON.parse(graphRun[120]!)[0]).toEqual(endOfRun[0]);
  });

  it('a runaway loop is a script error naming the loop node (iteration cap per step)', async () => {
    const compiled = await compileGraph({
      nodes: [{ ...node('v', 'var.number', { name: 'value' }), position: [0, -100] }, node('step', 'event.step'), node('runaway', 'flow.for', { first: 0, last: 1e9 }), node('count', 'api.game.add', { name: 'spins' })],
      edges: [wire('a', 'step', 'then', 'runaway', 'in'), wire('b', 'runaway', 'body', 'count', 'in')],
    });
    const L = await level(compiled);
    const line = L.tick();
    expect(JSON.parse(line)[3]).toBe(true);
    const d = L.rt.getDiagnostics().diagnostics;
    const err = d.errors[d.errors.length - 1];
    expect(err).toMatchObject({ code: 'module_error', reason: 'behavior_step_failed', nodeId: 'runaway', detail: 'iteration_cap' });
    expect(err.message).toContain('10000 iterations');
  });

  it('a bounded loop under the cap runs its whole range in one step', async () => {
    const compiled = await compileGraph({
      nodes: [{ ...node('v', 'var.number', { name: 'value' }), position: [0, -100] }, node('start', 'event.start'), node('loop', 'flow.for', { first: 1, last: 10_000 }), node('count', 'api.game.add', { name: 'spins' })],
      edges: [wire('a', 'start', 'then', 'loop', 'in'), wire('b', 'loop', 'body', 'count', 'in')],
    });
    const L = await level(compiled);
    L.tick();
    expect(L.rt.gameCommand('start').ok).toBe(true);
    const line = JSON.parse(L.tick());
    expect(line[3]).toBe(false);
    expect(line[0]).toEqual({ spins: 10_000 });
  });
});
