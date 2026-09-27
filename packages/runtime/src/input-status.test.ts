/**
 * Phase 23.14: the frame's input entry (validated strictly, frozen, merged)
 * and what `ctx.input` reads from it and queues for the host.
 */
import { describe, expect, it } from 'vitest';

import { validateActionFrame } from './actions';
import { inputView } from './behavior';
import { mergeInputStatus, RuntimeInputStatus, validateInputStatus, type InputStatusEntry } from './input-status';

const ENTRY: InputStatusEntry = {
  device: { kind: 'gamepad', id: 'pad', family: 'xbox' },
  actions: [
    { name: 'jump', type: 'button', map: 'gameplay', bindings: [{ device: 'keyboard', kind: 'key', label: 'Space', icon: 'key' }, { device: 'gamepad', kind: 'gamepadButton', label: 'A', icon: 'pad-south', image: 'tex-a' }] },
    { name: 'move', type: 'axis1d', map: 'gameplay', changed: true, bindings: [{ device: 'keyboard', kind: 'keys1d', label: 'A / D', icon: 'key', parts: [{ part: 'negative', label: 'A', icon: 'key' }, { part: 'positive', label: 'D', icon: 'key' }] }] },
  ],
  events: [{ type: 'started', action: 'jump', index: 0 }],
  profile: 'default',
};

describe('the input entry of a frame', () => {
  it('validates, freezes and rides on a frame; malformed entries name the field', () => {
    const r = validateActionFrame({ stepIndex: 3, moveX: 0, jump: 'none', input: ENTRY }, 3);
    if (!r.ok) throw new Error(r.message);
    expect(r.frame.input).toEqual(ENTRY);
    expect(Object.isFrozen(r.frame.input!.actions![0]!.bindings[1])).toBe(true);
    const bad = (input: unknown): string => {
      const v = validateInputStatus(input);
      return v.ok ? 'ok' : v.field;
    };
    expect(bad({ device: { kind: 'mouse' } })).toBe('input/device/kind');
    expect(bad({ actions: [{ name: 'jump', type: 'button', map: 'gameplay', bindings: [{ device: 'keyboard', kind: 'key', label: 'x', icon: 'Bad Icon' }] }] })).toBe('input/actions/0/bindings/0/icon');
    expect(bad({ events: [{ type: 'exploded' }] })).toBe('input/events/0/type');
    expect(bad({ extra: 1 })).toBe('input/extra');
    expect(bad({ profile: 'no spaces' })).toBe('input/profile');
    expect(validateActionFrame({ stepIndex: 0, moveX: 0, jump: 'none', input: { events: 'x' } }).ok).toBe(false);
  });
  it('two entries before one step: the newer device and list, the events of both', () => {
    const m = mergeInputStatus({ device: { kind: 'keyboardMouse' }, events: [{ type: 'started', action: 'jump', index: 0 }] }, { events: [{ type: 'rebound', action: 'jump', index: 0, label: 'K' }] })!;
    expect(m.device).toEqual({ kind: 'keyboardMouse' });
    expect(m.events!.map((e) => e.type)).toEqual(['started', 'rebound']);
  });
});

describe('ctx.input: device, bindings, glyphs, rebind requests', () => {
  it('reads what the host sent (kept until it changes; events for one step) and queues requests (8 a step)', () => {
    const st = new RuntimeInputStatus();
    const frame = { stepIndex: 0, moveX: 0, jump: 'none' as const };
    const view = inputView(frame, undefined, st.view);
    expect(view.device()).toEqual({ kind: 'keyboardMouse' });
    expect(view.glyphLabel('jump')).toBe('');
    st.apply(ENTRY);
    expect(view.usingGamepad()).toBe(true);
    expect(view.glyph('jump')).toMatchObject({ label: 'A', icon: 'pad-south', image: 'tex-a' });
    expect(view.glyph('jump', 'keyboardMouse')).toMatchObject({ label: 'Space' });
    expect(view.glyphLabel('jump')).toBe('A');
    expect(view.glyphIcon('move')).toBe('');
    expect(view.bindings().map((a) => a.name)).toEqual(['jump', 'move']);
    expect(view.rebinding()).toEqual({ action: 'jump', index: 0 });
    expect(view.rebindEvents()).toHaveLength(1);
    st.apply(undefined);
    expect(view.rebindEvents()).toHaveLength(0);
    expect(view.glyphLabel('jump')).toBe('A');
    st.apply({ events: [{ type: 'timeout', action: 'jump', index: 0 }] });
    expect(view.rebinding()).toBeNull();

    view.rebind('jump', { device: 'gamepad', policy: 'refuse', timeout: 5 });
    view.cancelRebind();
    view.resetBindings('jump');
    view.resetBindings();
    view.useBindingProfile('p2');
    expect(() => view.rebind('jump', { policy: 'maybe' as never })).toThrow(/policy/);
    expect(() => view.rebind('jump', { timeout: 0.5 })).toThrow(/timeout/);
    expect(() => view.useBindingProfile('a b')).toThrow(/profile/);
    expect(() => view.glyph('jump', 'mouse' as never)).toThrow(/device/);
    for (let i = 0; i < 6; i += 1) view.cancelRebind();
    const taken = st.take();
    expect(taken.requests.slice(0, 5)).toEqual([
      { op: 'rebind', action: 'jump', options: { device: 'gamepad', policy: 'refuse', timeout: 5 } },
      { op: 'cancel' },
      { op: 'reset', action: 'jump' },
      { op: 'reset' },
      { op: 'profile', profile: 'p2' },
    ]);
    expect(taken.requests).toHaveLength(8);
    expect(taken.dropped).toBe(3);
    expect(st.take()).toEqual({ requests: [], dropped: 0 });
  });
});
