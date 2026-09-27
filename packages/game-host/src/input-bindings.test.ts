/**
 * Phase 23.14: rebinding as data — targets, conflicts under each policy,
 * composites, fitting, reset and the saved changes.
 */
import { describe, expect, it } from 'vitest';

import { applyOverrides, applyRebind, bindingFrom, findConflicts, overridesOf, resetBindings, resolveTarget, validBinding, type ConfigData } from './input-bindings';

const CONFIG: ConfigData = {
  actions: [
    { name: 'move', type: 'axis2d', map: 'gameplay', bindings: [{ kind: 'keys2d', up: 'KeyW', down: 'KeyS', left: 'KeyA', right: 'KeyD' }, { kind: 'gamepadStick', x: 0, y: 1 }] },
    { name: 'jump', type: 'button', map: 'gameplay', bindings: [{ kind: 'key', code: 'Space' }, { kind: 'gamepadButton', button: 0 }] },
    { name: 'use', type: 'button', map: 'gameplay', bindings: [{ kind: 'key', code: 'KeyE', hold: 0.5 }, { kind: 'gamepadButton', button: 3 }] },
    { name: 'zoom', type: 'axis1d', map: 'gameplay', bindings: [{ kind: 'pointerAxis', axis: 'wheel' }] },
    { name: 'confirm', type: 'button', map: 'ui', bindings: [{ kind: 'key', code: 'KeyE' }] },
  ],
};
const target = (action: string, opts: Parameters<typeof resolveTarget>[2] = {}, dev: 'keyboardMouse' | 'gamepad' = 'keyboardMouse') => {
  const t = resolveTarget(CONFIG, action, opts, dev);
  if (!t.ok) throw new Error(t.reason);
  return t.target;
};
const bindingsOf = (c: ConfigData, name: string): unknown[] => [...c.actions.find((a) => a.name === name)!.bindings];

describe('targets', () => {
  it('the first binding of the device group, a composite part, the next free slot', () => {
    expect(target('jump')).toEqual({ action: 'jump', index: 0, device: 'keyboardMouse' });
    expect(target('jump', {}, 'gamepad')).toEqual({ action: 'jump', index: 1, device: 'gamepad' });
    expect(target('move', { part: 'left' })).toEqual({ action: 'move', index: 0, part: 'left', device: 'keyboardMouse' });
    expect(target('move')).toMatchObject({ part: 'up' });
    expect(target('zoom', {}, 'gamepad')).toEqual({ action: 'zoom', index: 1, device: 'gamepad' });
    expect(resolveTarget(CONFIG, 'nope', {}, 'gamepad').ok).toBe(false);
    expect(resolveTarget(CONFIG, 'jump', { index: 5 }, 'gamepad').ok).toBe(false);
    expect(resolveTarget(CONFIG, 'move', { part: 'negative' }, 'keyboardMouse').ok).toBe(false);
  });
});

describe('the binding a captured input makes', () => {
  it('fits the action type; a composite part takes its own kind; a pad axis on a 2D axis is its stick; hold stays', () => {
    expect(bindingFrom(CONFIG, target('jump'), { device: 'mouse', button: 'right' })).toEqual({ ok: true, binding: { kind: 'pointerButton', button: 'right' } });
    expect(bindingFrom(CONFIG, target('move', { part: 'left' }), { device: 'keyboard', code: 'KeyQ' })).toEqual({ ok: true, binding: { kind: 'keys2d', up: 'KeyW', down: 'KeyS', left: 'KeyQ', right: 'KeyD' } });
    expect(bindingFrom(CONFIG, target('move', { part: 'left' }), { device: 'gamepad', button: 2 }).ok).toBe(false);
    expect(bindingFrom(CONFIG, target('move', {}, 'gamepad'), { device: 'gamepad', axis: 3, sign: -1 })).toEqual({ ok: true, binding: { kind: 'gamepadStick', x: 2, y: 3 } });
    expect(bindingFrom(CONFIG, target('jump', {}, 'gamepad'), { device: 'gamepad', axis: 2, sign: 1 }).ok).toBe(false);
    expect(bindingFrom(CONFIG, target('zoom'), { device: 'mouse', wheel: 1 })).toEqual({ ok: true, binding: { kind: 'pointerAxis', axis: 'wheel' } });
    expect(bindingFrom(CONFIG, target('use'), { device: 'keyboard', code: 'KeyF' })).toEqual({ ok: true, binding: { kind: 'key', code: 'KeyF', hold: 0.5 } });
  });
});

describe('conflicts and policies', () => {
  it('finds the same input in other actions of the same map only', () => {
    expect(findConflicts(CONFIG, target('jump'), { device: 'keyboard', code: 'KeyE' })).toEqual([{ action: 'use', index: 0 }]);
    expect(findConflicts(CONFIG, target('jump'), { device: 'keyboard', code: 'KeyW' })).toEqual([{ action: 'move', index: 0, part: 'up' }]);
    expect(findConflicts(CONFIG, target('jump'), { device: 'keyboard', code: 'KeyZ' })).toEqual([]);
  });
  it('refuse changes nothing and names the conflict', () => {
    const r = applyRebind(CONFIG, target('jump'), { device: 'keyboard', code: 'KeyE' }, 'refuse');
    expect(r).toEqual({ ok: false, reason: 'the input is used by another action', conflicts: [{ action: 'use', index: 0 }] });
  });
  it('allow keeps the input in both actions', () => {
    const r = applyRebind(CONFIG, target('jump'), { device: 'keyboard', code: 'KeyE' }, 'allow');
    if (!r.ok) throw new Error(r.reason);
    expect(bindingsOf(r.config, 'jump')[0]).toEqual({ kind: 'key', code: 'KeyE' });
    expect(bindingsOf(r.config, 'use')[0]).toEqual({ kind: 'key', code: 'KeyE', hold: 0.5 });
    expect(r.conflicts).toEqual([{ action: 'use', index: 0 }]);
  });
  it('swap gives the other action the input this slot had (a composite part too); the ui map is untouched', () => {
    const r = applyRebind(CONFIG, target('jump'), { device: 'keyboard', code: 'KeyE' }, 'swap');
    if (!r.ok) throw new Error(r.reason);
    expect(bindingsOf(r.config, 'jump')[0]).toEqual({ kind: 'key', code: 'KeyE' });
    expect(bindingsOf(r.config, 'use')[0]).toEqual({ kind: 'key', code: 'Space', hold: 0.5 });
    expect(bindingsOf(r.config, 'confirm')[0]).toEqual({ kind: 'key', code: 'KeyE' });
    expect(r.swapped).toEqual(['use']);
    const w = applyRebind(CONFIG, target('jump'), { device: 'keyboard', code: 'KeyW' }, 'swap');
    if (!w.ok) throw new Error(w.reason);
    expect(bindingsOf(w.config, 'move')[0]).toEqual({ kind: 'keys2d', up: 'Space', down: 'KeyS', left: 'KeyA', right: 'KeyD' });
  });
  it('swap into an empty slot removes the other single binding', () => {
    const ok = applyRebind(CONFIG, target('zoom', {}, 'gamepad'), { device: 'gamepad', button: 3 }, 'swap');
    if (!ok.ok) throw new Error(ok.reason);
    expect(bindingsOf(ok.config, 'zoom')).toEqual([{ kind: 'pointerAxis', axis: 'wheel' }, { kind: 'gamepadButton', button: 3 }]);
    expect(bindingsOf(ok.config, 'use')).toEqual([{ kind: 'key', code: 'KeyE', hold: 0.5 }]);
  });
});

describe('reset and saved changes', () => {
  it('reset one or all; overrides round-trip; damaged saved bindings are ignored', () => {
    const r = applyRebind(CONFIG, target('jump'), { device: 'keyboard', code: 'KeyE' }, 'swap');
    if (!r.ok) throw new Error(r.reason);
    const o = overridesOf(r.config, CONFIG);
    expect(Object.keys(o)).toEqual(['jump', 'use']);
    expect(applyOverrides(CONFIG, o)).toEqual(r.config);
    expect(bindingsOf(resetBindings(r.config, CONFIG, 'jump'), 'jump')).toEqual(bindingsOf(CONFIG, 'jump'));
    expect(bindingsOf(resetBindings(r.config, CONFIG, 'jump'), 'use')[0]).toEqual({ kind: 'key', code: 'Space', hold: 0.5 });
    expect(resetBindings(r.config, CONFIG)).toEqual(CONFIG);
    expect(applyOverrides(CONFIG, { jump: [{ kind: 'keys2d', up: 'KeyW' }], use: 'x', nope: [] })).toBe(CONFIG);
    expect(validBinding({ kind: 'key', code: 'KeyK', hold: 0.2 }, 'button')).toBe(true);
    expect(validBinding({ kind: 'key', code: 'KeyK', hold: 99 }, 'button')).toBe(false);
    expect(validBinding({ kind: 'gamepadStick', x: 0, y: 1 }, 'button')).toBe(false);
  });
});
