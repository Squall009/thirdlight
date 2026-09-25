/**
 * Phase 19.2: the plumbing of visual-script debugging in Play.
 *
 * - The Play debug build of a graph (`generateGraphSource(…, {debug: true})`)
 *   records per instance the nodes it enters in the current step (bounded),
 *   the last step each node ran, the values read along data wires and local
 *   variables, and answers `debug(state)`; the ordinary build (what is
 *   published and exported) carries none of it.
 * - Debug builds change nothing the game computes: the same per-step trace
 *   over a run and a replay as the ordinary build.
 * - Breakpoints: a step watcher on the runtime holds the simulation right
 *   after the step in which the node ran — the same step whatever the frame
 *   rate (deterministic); held, frames run no steps; "step once" runs exactly
 *   one; released, the run continues and ends exactly where an uninterrupted
 *   run does. The flow's own pause never releases the hold.
 */
import { describe, expect, it } from 'vitest';

import type { GraphData } from '@thirdlight/project-model';

import { compileBehaviorGraph, createBehaviorCompiler, generateGraphSource } from '../../packages/behavior-build/src/index';
import { level, node, trace, wire, type Any, type Compiled } from './harness';

const compiler = createBehaviorCompiler();

/** Every 30th step (On step → step mod 30 = 0 → Branch) adds a "hits" counter; a local keeps the step. */
const GRAPH: GraphData = {
  nodes: [
    node('ev', 'event.step'),
    node('mod', 'math.modulo', { b: 30 }, [200, 100]),
    node('cmp', 'math.compare', { op: '==' }, [400, 100]),
    node('br', 'flow.branch', {}, [600, 0]),
    node('add', 'api.game.add', { name: 'hits' }, [800, 0]),
    node('seen', 'var.number', { name: 'seen', visibility: 'local' }, [0, 300]),
    node('keep', 'var.set', { variable: 'seen' }, [800, 200]),
    node('total', 'var.number', { name: 'total', visibility: 'private' }, [0, 400]),
  ],
  edges: [
    wire('w1', 'ev', 'then', 'br', 'in'),
    wire('w2', 'ev', 'step', 'mod', 'a'),
    wire('w3', 'mod', 'result', 'cmp', 'a'),
    wire('w4', 'cmp', 'result', 'br', 'condition'),
    wire('w5', 'br', 'true', 'add', 'in'),
    wire('w6', 'add', 'then', 'keep', 'in'),
    wire('w7', 'ev', 'step', 'keep', 'value'),
  ],
};

async function compile(debug: boolean): Promise<Compiled> {
  const r = await compileBehaviorGraph(compiler, { behaviorId: 'director', graph: GRAPH, debug, limits: { timeoutMs: 30_000 } });
  if (!r.ok) throw new Error(JSON.stringify(r.failure));
  return r.result;
}

const text = (bytes: Uint8Array): string => new TextDecoder().decode(bytes);

interface DebugView {
  step: number;
  trace: string[];
  dropped: number;
  last: Record<string, number>;
  wires: Record<string, unknown>;
  locals: Record<string, unknown>;
  vars: Record<string, unknown>;
}
const debugOf = (rt: Any): DebugView => rt.behaviorDebug({ behaviorId: 'director', entityId: 'box-director' })[0].debug as DebugView;

describe('visual-script debugging (phase 19.2)', () => {
  it('the ordinary build carries no debug hooks; the Play debug build records the trace, wires and locals', async () => {
    const plain = generateGraphSource(GRAPH);
    const again = generateGraphSource(GRAPH, {}, { debug: false });
    const debug = generateGraphSource(GRAPH, {}, { debug: true });
    if (!plain.ok || !again.ok || !debug.ok) throw new Error('generation failed');
    expect(text(again.containerBytes)).toBe(text(plain.containerBytes));
    const plainText = plain.container.files.map((f) => f.text).join('\n');
    for (const hook of ['T(s, ', 'W(s, ', 'LV(s, ', 'DBG_TRACE', 'db:', 's.db', 'debug(s']) expect(plainText, hook).not.toContain(hook);
    const debugText = debug.container.files.map((f) => f.text).join('\n');
    for (const hook of ['T(s, "br")', 'W(s, "w3", ', 'LV(s, "seen", ', 'debug(s: S)']) expect(debugText, hook).toContain(hook);
    // Same declaration and owned transforms: only the recording differs.
    expect(debug.declaration).toEqual(plain.declaration);
    expect(debug.container.ownedTransforms).toEqual(plain.container.ownedTransforms);

    const [p, d] = [await compile(false), await compile(true)];
    expect(text(p.outputBytes)).not.toContain('DBG_TRACE');
    expect(p.outputDigest).not.toBe(d.outputDigest);
    const L = await level(d);
    L.tick();
    expect(L.rt.gameCommand('start').ok).toBe(true);
    let hitStep = -1;
    for (let i = 0; i < 80 && hitStep < 0; i++) {
      L.tick();
      const v = debugOf(L.rt);
      if (v.trace.includes('add')) hitStep = v.step;
    }
    expect(hitStep).toBeGreaterThan(0);
    const v = debugOf(L.rt);
    // The trace of the step: the event, then the nodes in the order they ran (a node's inputs are read before it runs).
    expect(v.trace.slice(0, 4)).toEqual(['ev', 'mod', 'cmp', 'br']);
    expect(v.trace).toEqual(expect.arrayContaining(['add', 'keep']));
    expect(v.dropped).toBe(0);
    expect(v.last['add']).toBe(hitStep);
    expect(v.last['ev']).toBe(hitStep);
    expect(v.wires['w4']).toBe(true);
    expect(v.wires['w3']).toBe(0);
    expect(v.locals['seen']).toBe(hitStep);
    expect(v.vars).toEqual({ total: 0 });
    // The next step: a new trace, the Branch took "false" (Add did not run again).
    L.tick();
    const n = debugOf(L.rt);
    expect(n.step).toBe(hitStep + 1);
    expect(n.trace).not.toContain('add');
    expect(n.last['add']).toBe(hitStep);
    expect(n.wires['w4']).toBe(false);
  });

  it('a debug build plays exactly like the ordinary build (run and replay)', async () => {
    const [p, d] = [await compile(false), await compile(true)];
    const a = await trace(p, {}, 90);
    const b = await trace(d, {}, 90);
    expect(b).toEqual(a);
    expect(a.some((line) => line.includes('"hits":2'))).toBe(true);
  });

  it('a breakpoint holds at the step boundary after its node ran — the same step at any frame rate; step once, then resume ends like an uninterrupted run', async () => {
    const d = await compile(true);
    /** Run with `perFrame` steps per frame; a breakpoint on "add"; returns where it held and the end state. */
    const run = async (perFrame: number, total: number): Promise<{ heldAt: number; stepped: number; end: string; frozen: boolean }> => {
      const L = await level(d);
      L.tick();
      expect(L.rt.gameCommand('start').ok).toBe(true);
      const rt = L.rt;
      const start = rt.getDiagnostics().diagnostics.stepIndex as number;
      rt.setStepWatcher(() => debugOf(rt).trace.includes('add'));
      let now = 1;
      const frame = (steps: number): void => {
        now += steps / 120;
        expect(rt.tick(now).ok).toBe(true);
      };
      const stepIndex = (): number => rt.getDiagnostics().diagnostics.stepIndex as number;
      for (let i = 0; i < 200 && !rt.debugHeld; i++) frame(perFrame);
      expect(rt.debugHeld).toBe(true);
      const heldAt = stepIndex();
      expect(debugOf(rt).trace).toContain('add');
      // Held: frames run no steps (even long ones), and the flow's pause does not release it.
      frame(10);
      frame(3);
      rt.setPaused(false);
      frame(5);
      const frozen = stepIndex() === heldAt;
      // Step once: exactly one step, still held.
      rt.debugStep();
      frame(4);
      const stepped = stepIndex() - heldAt;
      expect(rt.debugHeld).toBe(true);
      // Resume without the breakpoint: run to `total` steps after the start.
      rt.setStepWatcher(null);
      rt.setDebugHold(false);
      frame(0);
      while (stepIndex() - start < total) frame(Math.min(perFrame, total - (stepIndex() - start)));
      return { heldAt: heldAt - start, stepped, end: JSON.stringify([rt.gameCounters().counters, debugOf(rt).vars, stepIndex() - start]), frozen };
    };
    const one = await run(1, 100);
    const many = await run(7, 100);
    expect(one.frozen).toBe(true);
    expect(many.frozen).toBe(true);
    expect(one.stepped).toBe(1);
    expect(many.stepped).toBe(1);
    // The same step, whatever the frame rate.
    expect(many.heldAt).toBe(one.heldAt);
    // An uninterrupted run of the same length ends in the same state.
    const L = await level(d);
    L.tick();
    L.rt.gameCommand('start');
    const start = L.rt.getDiagnostics().diagnostics.stepIndex as number;
    let now = 1;
    L.rt.tick(now);
    while ((L.rt.getDiagnostics().diagnostics.stepIndex as number) - start < 100) {
      now += 1 / 120;
      L.rt.tick(now);
    }
    const plain = JSON.stringify([L.rt.gameCounters().counters, debugOf(L.rt).vars, (L.rt.getDiagnostics().diagnostics.stepIndex as number) - start]);
    expect(one.end).toBe(plain);
    expect(many.end).toBe(plain);
  });

  it('the trace is bounded per step (a long loop is counted, not stored)', async () => {
    const loop: GraphData = {
      nodes: [node('ev', 'event.step'), node('for', 'flow.for', { first: 1, last: 400 }, [200, 0]), node('log', 'api.game.add', { name: 'n' }, [400, 0])],
      edges: [wire('a', 'ev', 'then', 'for', 'in'), wire('b', 'for', 'body', 'log', 'in')],
    };
    const r = await compileBehaviorGraph(compiler, { behaviorId: 'director', graph: loop, debug: true, limits: { timeoutMs: 30_000 } });
    if (!r.ok) throw new Error(JSON.stringify(r.failure));
    const L = await level(r.result);
    L.tick();
    L.rt.gameCommand('start');
    L.tick();
    L.tick();
    const v = debugOf(L.rt);
    expect(v.trace.length).toBe(256);
    expect(v.dropped).toBeGreaterThan(500);
  });
});
