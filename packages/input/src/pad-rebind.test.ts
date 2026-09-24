/**
 * Phase 14.5: the platformer's pad controls come from the project's `move`
 * and `jump` actions (rebindable in the game's settings), read through a fake
 * pad. The standard layout (A jumps, D-pad and left stick move) stays for
 * every config without pad bindings of a kind.
 */
import { describe, expect, it } from 'vitest';

import { DEFAULT_INPUT_CONFIG, platformerPad, readPlatformerPad, STANDARD_PLATFORMER_PAD, type InputConfigLike } from './actions';
import { attachBrowserInput } from './browser';

type Handler = (event: Event) => void;

class FakeTarget {
  private readonly listeners = new Map<string, Set<Handler>>();
  addEventListener(type: string, handler: EventListenerOrEventListenerObject): void {
    const set = this.listeners.get(type) ?? new Set<Handler>();
    set.add(handler as unknown as Handler);
    this.listeners.set(type, set);
  }
  removeEventListener(type: string, handler: EventListenerOrEventListenerObject): void {
    this.listeners.get(type)?.delete(handler as unknown as Handler);
  }
  dispatch(type: string, event: Record<string, unknown> = {}): void {
    for (const fn of [...(this.listeners.get(type) ?? [])]) fn({ type, ...event } as unknown as Event);
  }
}

/** One fake standard pad whose held buttons and axes the test sets. */
function fakePad(): { held: Set<number>; axes: number[]; list: () => ArrayLike<Gamepad | null> } {
  const held = new Set<number>();
  const axes = [0, 0, 0, 0];
  const list = (): ArrayLike<Gamepad | null> => [
    {
      id: 'fake pad',
      index: 0,
      mapping: 'standard',
      connected: true,
      axes: [...axes],
      buttons: Array.from({ length: 17 }, (_, i) => ({ pressed: held.has(i), touched: held.has(i), value: held.has(i) ? 1 : 0 })),
      timestamp: 0,
    } as unknown as Gamepad,
  ];
  return { held, axes, list };
}

function attach(inputConfig?: InputConfigLike) {
  const target = new FakeTarget();
  const win = new FakeTarget() as FakeTarget & { document: FakeTarget; isSecureContext: boolean };
  win.document = new FakeTarget();
  win.isSecureContext = true;
  const pad = fakePad();
  const source = attachBrowserInput(target as unknown as EventTarget, {
    window: win as unknown as Window,
    document: win.document as unknown as Document,
    navigator: {} as Navigator,
    getGamepads: pad.list,
    ...(inputConfig !== undefined ? { inputConfig } : {}),
  });
  return { target, pad, source };
}

/** The default actions with jump's pad button replaced (what the settings screen does). */
function withJumpButton(button: number): InputConfigLike {
  return { actions: DEFAULT_INPUT_CONFIG.actions.map((a) => (a.name === 'jump' ? { ...a, bindings: [...a.bindings.filter((b) => b.kind !== 'gamepadButton'), { kind: 'gamepadButton', button }] } : a)) };
}

describe('platformerPad', () => {
  it('reads the standard layout from the default actions', () => {
    expect(platformerPad(DEFAULT_INPUT_CONFIG)).toEqual({ jump: [0], left: [14], right: [15], axes: [0] });
  });

  it('keeps the standard layout for a config without pad bindings (projects made before pad rebinding)', () => {
    const keysOnly: InputConfigLike = { actions: DEFAULT_INPUT_CONFIG.actions.map((a) => ({ ...a, bindings: a.bindings.filter((b) => !b.kind.startsWith('gamepad')) })) };
    expect(platformerPad(keysOnly)).toEqual(STANDARD_PLATFORMER_PAD);
    expect(platformerPad({ actions: [] })).toEqual(STANDARD_PLATFORMER_PAD);
  });

  it('takes rebound jump and move buttons and move axes', () => {
    const cfg: InputConfigLike = {
      actions: [
        { name: 'move', type: 'axis1d', map: 'gameplay', bindings: [{ kind: 'gamepadButtons1d', negative: 4, positive: 5 }, { kind: 'gamepadAxis', axis: 2 }] },
        { name: 'jump', type: 'button', map: 'gameplay', bindings: [{ kind: 'key', code: 'Space' }, { kind: 'gamepadButton', button: 3 }, { kind: 'gamepadButton', button: 7 }] },
      ],
    };
    expect(platformerPad(cfg)).toEqual({ jump: [3, 7], left: [4], right: [5], axes: [2] });
  });

  it('reads a fake pad through the bindings (the furthest axis wins; ignored buttons do not count)', () => {
    const map = { jump: [3], left: [4], right: [5], axes: [0, 2] };
    const buttons = Array.from({ length: 17 }, (_, i) => i === 3 || i === 5);
    expect(readPlatformerPad(map, buttons, [0.3, 0, -0.9, 0])).toEqual({ jump: true, left: false, right: true, axis: -0.9 });
    expect(readPlatformerPad(map, buttons, [0, 0, 0, 0], new Set([3])).jump).toBe(false);
  });
});

describe('the platformer on a fake pad', () => {
  it('jumps with button 0 and moves with the D-pad by default', () => {
    const h = attach(DEFAULT_INPUT_CONFIG);
    h.pad.held.add(0);
    expect(h.source.sample(1).jump).toBe('pressed');
    h.pad.held.clear();
    h.pad.held.add(14);
    expect(h.source.sample(2)).toMatchObject({ moveX: -1, jump: 'released' });
  });

  it('jumps with button 3 once jump is rebound to it, and no longer with button 0', () => {
    const h = attach(DEFAULT_INPUT_CONFIG);
    h.source.configure(withJumpButton(3));
    h.pad.held.add(0);
    expect(h.source.sample(1).jump).toBe('none');
    expect(h.source.sample(2).jump).toBe('none');
    h.pad.held.clear();
    expect(h.source.sample(3).jump).toBe('none');
    h.pad.held.add(3);
    const pressed = h.source.sample(4);
    expect(pressed.jump).toBe('pressed');
    expect(pressed.actions?.['jump']?.p).toBe('pressed');
    expect(h.source.sample(5).jump).toBe('held');
    h.pad.held.clear();
    expect(h.source.sample(6).jump).toBe('released');
  });

  it('moves with rebound buttons and a rebound stick axis', () => {
    const h = attach({
      actions: [
        { name: 'move', type: 'axis1d', map: 'gameplay', bindings: [{ kind: 'gamepadButtons1d', negative: 4, positive: 5 }, { kind: 'gamepadAxis', axis: 2 }] },
        { name: 'jump', type: 'button', map: 'gameplay', bindings: [{ kind: 'gamepadButton', button: 0 }] },
      ],
    });
    h.pad.held.add(5);
    expect(h.source.sample(1).moveX).toBe(1);
    h.pad.held.clear();
    h.pad.held.add(15); // the D-pad is not bound any more
    expect(h.source.sample(2).moveX).toBe(0);
    h.pad.held.clear();
    h.pad.axes[2] = -1;
    expect(h.source.sample(3).moveX).toBe(-1);
    h.pad.axes[2] = 0;
    h.pad.axes[0] = 1; // axis 0 is not bound
    expect(h.source.sample(4).moveX).toBe(0);
  });

  it('a menu confirm on button 0 still held does not block a jump rebound to button 3', () => {
    const h = attach(withJumpButton(3));
    h.pad.held.add(0);
    h.source.sample(1);
    expect(h.source.sampleMenu().confirm).toBe(true);
    h.source.markConfirmConsumed();
    h.pad.held.add(3);
    expect(h.source.sample(2).jump).toBe('pressed');
  });
});

describe('capturePadButton', () => {
  it('takes the next fresh press; a button held when the capture starts must be released first', () => {
    const h = attach(DEFAULT_INPUT_CONFIG);
    h.pad.held.add(0); // the press that chose the menu item
    const got: (number | null)[] = [];
    h.source.capturePadButton((b) => got.push(b));
    h.source.sampleUi();
    expect(got).toEqual([]);
    h.pad.held.delete(0);
    h.source.sampleUi();
    h.pad.held.add(3);
    expect(h.source.sampleUi()).toEqual({ up: false, down: false, left: false, right: false, submit: false, cancel: false, pause: false });
    expect(got).toEqual([3]);
    // Captured once: later presses are menu input again.
    h.pad.held.clear();
    h.source.sampleUi();
    h.pad.held.add(0);
    expect(h.source.sampleUi().submit).toBe(true);
    expect(got).toEqual([3]);
  });

  it('the Escape key cancels a pad capture (null); the cancel function stops it', () => {
    const h = attach(DEFAULT_INPUT_CONFIG);
    const got: (number | null)[] = [];
    h.source.capturePadButton((b) => got.push(b));
    h.target.dispatch('keydown', { code: 'Escape', repeat: false, target: h.target, preventDefault: () => undefined });
    expect(got).toEqual([null]);
    const stop = h.source.capturePadButton((b) => got.push(b));
    stop();
    h.pad.held.add(2);
    h.source.sampleUi();
    expect(got).toEqual([null]);
  });
});
