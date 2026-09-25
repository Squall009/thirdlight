/**
 * Phase 19.2: the Play preview's visual-script debugger over a fake runtime
 * (the real runtime's hold/step/watcher are covered by
 * tests/visual-script/debug.test.ts).
 */
import { describe, expect, it } from 'vitest';

import { PlayDebugger, sampleValue, type DebugRuntime } from './play-debug';
import { idsInTab, splitScoped, toggleBreakpoints, variablesOf, functionIdFor } from '../session/visual-debug';

function fakeRuntime() {
  const state = {
    held: false,
    steps: 0,
    watcher: null as ((i: number) => boolean) | null,
    step: 10,
    instances: [
      { behaviorId: 'door', entityId: 'a', debug: { step: 10, trace: ['ev', 'br'], dropped: 0, last: { ev: 10, br: 10, old: 2 }, wires: { w1: true, 'fn:f/w2': [1, 2, 3] }, locals: { 'fn:f/x': 'text' }, vars: { count: 2.123456 } } },
      { behaviorId: 'door', entityId: 'b', debug: { step: 10, trace: ['ev', 'add'], dropped: 0, last: { ev: 10, add: 10 }, wires: {}, locals: {}, vars: {} } },
      { behaviorId: 'other', entityId: 'c', debug: null },
    ],
  };
  const rt: DebugRuntime = {
    get debugHeld() {
      return state.held;
    },
    setDebugHold: (h) => {
      state.held = h;
    },
    debugStep: () => {
      state.steps += 1;
    },
    setStepWatcher: (w) => {
      state.watcher = w;
    },
    behaviorDebug: (f = {}) => state.instances.filter((i) => (f.behaviorId === undefined || i.behaviorId === f.behaviorId) && (f.entityId === undefined || i.entityId === f.entityId)),
    getDiagnostics: () => ({ ok: true, diagnostics: { stepIndex: state.step } }),
  };
  return { rt, state };
}

describe('PlayDebugger (phase 19.2)', () => {
  it('answers with the watched instance: trace, recent nodes, sampled wires and variables', () => {
    const { rt } = fakeRuntime();
    const d = new PlayDebugger(rt, 5);
    const r = d.request({ behaviorId: 'door', breakpoints: [] });
    expect(r.debuggable).toBe(true);
    expect(r.instances).toEqual(['a', 'b']);
    expect(r.instance?.entityId).toBe('a');
    expect(r.instance?.trace).toEqual(['ev', 'br']);
    expect(r.instance?.recent.sort()).toEqual(['br', 'ev']);
    expect(r.instance?.wires).toEqual({ w1: 'true', 'fn:f/w2': '1, 2, 3' });
    expect(r.instance?.vars).toEqual({ count: '2.123' });
    expect(r.instance?.locals).toEqual({ 'fn:f/x': '"text"' });
    expect(d.request({ behaviorId: 'door', entityId: 'b', breakpoints: [] }).instance?.entityId).toBe('b');
    // A behavior without a debug build is not debuggable.
    expect(d.request({ behaviorId: 'other', breakpoints: [] })).toMatchObject({ debuggable: false, instance: null });
  });

  it('breakpoints arm a step watcher that holds when a breakpoint node ran (on the watched object); pause / step / resume', () => {
    const { rt, state } = fakeRuntime();
    const d = new PlayDebugger(rt, 5);
    d.request({ behaviorId: 'door', breakpoints: [] });
    expect(state.watcher).toBeNull();
    d.request({ behaviorId: 'door', breakpoints: ['add'] });
    expect(state.watcher!(10)).toBe(true); // "b" ran Add
    d.request({ behaviorId: 'door', entityId: 'a', breakpoints: ['add'] });
    expect(state.watcher!(10)).toBe(false); // only "a" is watched: it did not
    d.request({ behaviorId: 'door', breakpoints: ['add'] });
    state.held = true;
    const paused = d.request({ behaviorId: 'door', breakpoints: ['add'] });
    expect(paused).toMatchObject({ paused: true, hit: { entityId: 'b', nodeId: 'add' } });
    expect(d.observation()).toEqual({ paused: true, stepIndex: 10, breakpoints: 1, hit: { behaviorId: 'door', entityId: 'b', nodeId: 'add' } });
    d.request({ behaviorId: 'door', breakpoints: ['add'], command: 'step' });
    expect(state.steps).toBe(1);
    d.request({ behaviorId: 'door', breakpoints: ['add'], command: 'resume' });
    expect(state.held).toBe(false);
    d.request({ behaviorId: 'door', breakpoints: ['add'], command: 'pause' });
    expect(state.held).toBe(true);
    d.control('debugResume');
    expect(state.held).toBe(false);
    d.end();
    expect(state.watcher).toBeNull();
    expect(d.observation()).toBeNull();
  });

  it('values are short texts', () => {
    expect(sampleValue(1 / 3)).toBe('0.333');
    expect(sampleValue([1, 2.5, -3])).toBe('1, 2.5, -3');
    expect(sampleValue([1, 2, 3, 4, 5])).toBe('[5] 1, 2, 3, 4, …');
    expect(sampleValue(new Map([['k', 1]]))).toBe('{1} k: 1');
    expect(sampleValue('x'.repeat(100)).length).toBe(48);
    expect(sampleValue(null)).toBe('none');
  });

  it('tab ids: scoped ids, breakpoint toggles, variables, function ids', () => {
    expect(splitScoped('n1')).toEqual({ target: '', id: 'n1' });
    expect(splitScoped('fn:jump/n1')).toEqual({ target: 'jump', id: 'n1' });
    expect(splitScoped('lib:g/n1')).toBeNull();
    expect([...idsInTab(['a', 'fn:f/b', 'fn:g/c', 'lib:x/d'], 'f')]).toEqual(['b']);
    expect(toggleBreakpoints([], 'f', ['b'])).toEqual(['fn:f/b']);
    expect(toggleBreakpoints(['fn:f/b', 'a'], 'f', ['b'])).toEqual(['a']);
    expect(toggleBreakpoints(['a'], '', ['a', 'c'])).toEqual(['a', 'c']);
    expect(variablesOf({ nodes: [{ id: 'v2', type: 'var.list', position: [0, 10], data: { name: 'items' } }, { id: 'v1', type: 'var.number', position: [0, 0], data: { name: 'hp', visibility: 'private' } }, { id: 'x', type: 'debug.log', position: [0, 0] }], edges: [] }, false)).toEqual([
      { nodeId: 'v1', name: 'hp', kind: 'number', visibility: 'private' },
      { nodeId: 'v2', name: 'items', kind: 'list', visibility: 'private' },
    ]);
    expect(functionIdFor('Open Door!', ['open-door'])).toBe('open-door-2');
    expect(functionIdFor('__', [])).toBe('function');
  });
});
