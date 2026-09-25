/**
 * Phase 19.2: the visual-script debugger tab's id helpers (the debugger itself
 * moved to the game host in phase 22.0, with its own tests).
 */
import { describe, expect, it } from 'vitest';

import { idsInTab, splitScoped, toggleBreakpoints, variablesOf, functionIdFor } from './visual-debug';

describe('visual debugger tab ids (phase 19.2)', () => {
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
