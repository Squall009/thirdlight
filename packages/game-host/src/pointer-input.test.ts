/**
 * Phase 23.3: the worker's per-tick input with pointer samples — the
 * movement, wheel and edges belong to the first step of a tick, two samples
 * merged before a step add their amounts and keep both edges — and the
 * cursor mode the host resolves (input map, a script's request), plus the
 * relay source passing pointer samples through.
 */
import { describe, expect, it } from 'vitest';

import { resolveCursorMode } from './bindings';
import { RelayActionSource } from './relay-input';
import { continueFrame, continuePointer, mergePointer, TickInputSource } from './tick-input';

describe('pointer samples across ticks and steps', () => {
  it('a further step of the same tick keeps the position and buttons, not the movement, wheel or edges', () => {
    const src = new TickInputSource();
    src.push({ stepIndex: 0, pointer: { x: 0.4, y: 0.6, dx: 0.1, wheel: 1, buttons: 1, pressed: 1 }, actions: { look: { v: 5, x: 5, y: 0, p: 'pressed', i: 1 }, fire: { v: 1, p: 'pressed' } } });
    const a = src.sample(12);
    const b = src.sample(13);
    expect(a.pointer).toEqual({ x: 0.4, y: 0.6, dx: 0.1, wheel: 1, buttons: 1, pressed: 1 });
    expect(b.pointer).toEqual({ x: 0.4, y: 0.6, buttons: 1 });
    // A per-sample amount (i) is spent on the first step; a level (fire) holds.
    expect(b.actions!['look']).toEqual({ v: 0, x: 0, y: 0, p: 'held', i: 1 });
    expect(b.actions!['fire']).toEqual({ v: 1, p: 'held' });
    expect(continuePointer({ x: 0.1, y: 0.2 })).toEqual({ x: 0.1, y: 0.2 });
  });

  it('two samples before one step: movement and wheel add up, both edges are kept, the newer position wins', () => {
    const src = new TickInputSource();
    src.push({ stepIndex: 0, pointer: { x: 0.2, y: 0.2, dx: 0.05, buttons: 1, pressed: 1 }, actions: { look: { v: 2, x: 2, y: 0, p: 'pressed', i: 1 } } });
    src.push({ stepIndex: 0, pointer: { x: 0.3, y: 0.2, dx: 0.1, wheel: -1, released: 1 }, actions: { look: { v: 3, x: 3, y: 1, p: 'held', i: 1 } } });
    const f = src.sample(20);
    expect(f.pointer).toEqual({ x: 0.3, y: 0.2, dx: 0.15, wheel: -1, pressed: 1, released: 1 });
    expect(f.actions!['look']).toEqual({ v: 5, x: 5, y: 1, p: 'pressed', i: 1 });
    expect(mergePointer(undefined, { x: 1, y: 1 })).toEqual({ x: 1, y: 1 });
    expect(mergePointer({ x: 1, y: 1 }, undefined)).toEqual({ x: 1, y: 1 });
  });

  it('continueFrame without a pointer adds none', () => {
    expect(continueFrame({ stepIndex: 1 }).pointer).toBeUndefined();
  });

  it('the relay source (tl_input_exercise) passes pointer samples through at their steps', () => {
    const browser = { sample: (n: number) => ({ stepIndex: n }), reset: () => undefined };
    const relay = new RelayActionSource(browser);
    relay.beginTest([{ stepOffset: 0, pointer: { x: 0.5, y: 0.5 } }, { stepOffset: 2, pointer: { x: 0.5, y: 0.5, buttons: 1 } }], 100, () => undefined);
    expect(relay.sample(100).pointer).toEqual({ x: 0.5, y: 0.5 });
    expect(relay.sample(101).pointer).toBeUndefined();
    expect(relay.sample(102).pointer).toEqual({ x: 0.5, y: 0.5, buttons: 1 });
  });
});

describe('the cursor mode in effect', () => {
  it('free by default; each map\'s setting; a script\'s request during play only', () => {
    const cfg = { actions: [], cursor: { gameplay: 'locked' as const } };
    expect(resolveCursorMode(undefined, null, null)).toBe('free');
    expect(resolveCursorMode(cfg, null, null)).toBe('locked');
    expect(resolveCursorMode(cfg, 'menu', null)).toBe('free');
    expect(resolveCursorMode(cfg, null, 'free')).toBe('free');
    // A menu frees the cursor whatever a script asked for (the ui map decides).
    expect(resolveCursorMode(cfg, 'menu', 'locked')).toBe('free');
    expect(resolveCursorMode({ actions: [], cursor: { ui: 'locked' } }, 'menu', null)).toBe('locked');
  });

  it('phase 25.6: a project map sets the cursor while a game mode activates it', () => {
    const cfg = { actions: [], cursor: { gameplay: 'locked' as const, tactical: 'free' as const, ui: 'locked' as const } };
    // The mode's maps in order: the first with a setting wins, ui after the others.
    expect(resolveCursorMode(cfg, ['gameplay', 'ui'], null)).toBe('locked');
    expect(resolveCursorMode(cfg, ['tactical', 'ui'], null)).toBe('free');
    expect(resolveCursorMode(cfg, ['ui', 'tactical'], null)).toBe('free');
    // A mode whose maps set nothing: ui's setting when ui is active, else free.
    expect(resolveCursorMode(cfg, ['board', 'ui'], null)).toBe('locked');
    expect(resolveCursorMode(cfg, ['board'], null)).toBe('free');
    // A script's request still wins during play; a menu still reads ui.
    expect(resolveCursorMode(cfg, ['tactical', 'ui'], 'locked')).toBe('locked');
    expect(resolveCursorMode(cfg, 'menu', null)).toBe('locked');
  });
});
