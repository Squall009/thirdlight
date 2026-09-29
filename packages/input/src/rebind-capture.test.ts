/**
 * The hold modifier in the action evaluator, and the browser
 * owner's listen-for-input capture, device detection (with the pad id) and
 * the host's frame entry.
 */
import { describe, expect, it } from 'vitest';

import { createActionEvaluator, characterKeys, type InputConfigLike } from './actions';
import { attachBrowserInput, type CapturedInput } from './browser';

const HOLD: InputConfigLike = {
  actions: [
    { name: 'charge', type: 'button', map: 'gameplay', bindings: [{ kind: 'key', code: 'KeyC', hold: 0.5 }, { kind: 'gamepadButton', button: 2, hold: 0.25 }] },
    { name: 'tap', type: 'button', map: 'gameplay', bindings: [{ kind: 'key', code: 'KeyC' }] },
    { name: 'jump', type: 'button', map: 'gameplay', bindings: [{ kind: 'key', code: 'Space', hold: 1 }, { kind: 'key', code: 'KeyW' }] },
  ],
};
const raw = (keys: string[], now: number | undefined, pressed: string[] = [], buttons: boolean[] = []) => ({ keys: new Set(keys), pressedKeys: new Set(pressed), gamepad: { buttons, axes: [] }, now });

describe('hold instead of tap', () => {
  it('counts only after the binding is held long enough; a tap never completes it; the other bindings are unaffected', () => {
    const e = createActionEvaluator(HOLD);
    expect(e.sample(raw(['KeyC'], 0)).charge).toMatchObject({ v: 0, p: 'none' });
    expect(e.sample(raw(['KeyC'], 0)).tap).toMatchObject({ v: 1, p: 'held' });
    expect(e.sample(raw(['KeyC'], 300)).charge!.v).toBe(0);
    expect(e.sample(raw(['KeyC'], 500)).charge).toMatchObject({ v: 1, p: 'pressed' });
    expect(e.sample(raw(['KeyC'], 700)).charge).toMatchObject({ v: 1, p: 'held' });
    expect(e.sample(raw([], 720)).charge).toMatchObject({ v: 0, p: 'released' });
    // A tap between samples (pressed, not held) never counts for a hold binding.
    expect(e.sample(raw([], 800, ['KeyC'])).charge!.v).toBe(0);
    // Pad button with its own duration.
    e.sample(raw([], 1000, [], [false, false, true]));
    expect(e.sample(raw([], 1250, [], [false, false, true])).charge!.v).toBe(1);
    // Without a clock a hold binding never counts.
    const n = createActionEvaluator(HOLD);
    n.sample(raw(['KeyC'], undefined));
    expect(n.sample(raw(['KeyC'], undefined)).charge!.v).toBe(0);
  });
  it('the character controller reads only tap keys (a hold binding counts in action values)', () => {
    expect(characterKeys(HOLD).jump).toEqual(['KeyW']);
  });
});

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
    for (const fn of [...(this.listeners.get(type) ?? [])]) fn({ type, preventDefault: () => undefined, ...event } as unknown as Event);
  }
}

function attach() {
  const target = new FakeTarget() as FakeTarget & { getBoundingClientRect: () => { left: number; top: number; width: number; height: number } };
  target.getBoundingClientRect = () => ({ left: 0, top: 0, width: 100, height: 100 });
  const win = new FakeTarget() as FakeTarget & { document: FakeTarget; isSecureContext: boolean };
  win.document = new FakeTarget();
  win.isSecureContext = true;
  const held = new Set<number>();
  const axes = [0, 0, 0, 0];
  let t = 0;
  const source = attachBrowserInput(target as unknown as EventTarget, {
    window: win as unknown as Window,
    document: win.document as unknown as Document,
    navigator: {} as Navigator,
    getGamepads: () => [{ id: 'Xbox Wireless Controller (Vendor: 045e)', index: 0, mapping: 'standard', connected: true, axes: [...axes], buttons: Array.from({ length: 17 }, (_, i) => ({ pressed: held.has(i), touched: false, value: held.has(i) ? 1 : 0 })), timestamp: 0 } as unknown as Gamepad],
    inputConfig: HOLD,
    now: () => t,
  });
  return { target, held, axes, source, setTime: (v: number) => (t = v) };
}

describe('listen for input (captureInput)', () => {
  it('a key (the cancel key gives null), a mouse button, the wheel, a fresh pad button, a pad axis; nothing else sees the captured key', () => {
    const a = attach();
    const got: (CapturedInput | null)[] = [];
    a.source.captureInput({}, (c) => got.push(c));
    a.target.dispatch('keydown', { code: 'KeyK' });
    a.source.captureInput({ cancelKeys: ['KeyQ'] }, (c) => got.push(c));
    a.target.dispatch('keydown', { code: 'KeyQ' });
    a.source.captureInput({ devices: ['mouse'] }, (c) => got.push(c));
    a.target.dispatch('keydown', { code: 'KeyZ' }); // not listened to: the game sees it
    a.target.dispatch('pointerdown', { button: 2, clientX: 5, clientY: 5 });
    a.source.captureInput({ devices: ['mouse'] }, (c) => got.push(c));
    a.target.dispatch('wheel', { deltaY: -100, deltaMode: 0 });
    // A pad button already held when listening starts must be released first.
    a.held.add(0);
    a.source.captureInput({ devices: ['gamepad'] }, (c) => got.push(c));
    a.source.sampleUi();
    a.held.add(3);
    a.source.sampleUi();
    a.source.captureInput({ devices: ['gamepad'] }, (c) => got.push(c));
    a.axes[3] = -0.9;
    a.source.sample(0);
    expect(got).toEqual([{ device: 'keyboard', code: 'KeyK' }, null, { device: 'mouse', button: 'right' }, { device: 'mouse', wheel: -1 }, { device: 'gamepad', button: 3 }, { device: 'gamepad', axis: 3, sign: -1 }]);
    const cancel = a.source.captureInput({}, (c) => got.push(c));
    cancel();
    a.target.dispatch('keydown', { code: 'KeyK' });
    expect(got).toHaveLength(6);
  });
  it('the device used last carries the pad id; the host entry rides on the next frame only', () => {
    const a = attach();
    expect(a.source.activeDeviceInfo()).toEqual({ device: 'keyboard', gamepadId: null });
    a.held.add(1);
    a.source.sampleUi();
    expect(a.source.activeDeviceInfo()).toEqual({ device: 'gamepad', gamepadId: 'Xbox Wireless Controller (Vendor: 045e)' });
    let entry: { device: { kind: 'gamepad' } } | undefined = { device: { kind: 'gamepad' } };
    a.source.setFrameInput(() => {
      const e = entry;
      entry = undefined;
      return e;
    });
    expect(a.source.sample(0).input).toEqual({ device: { kind: 'gamepad' } });
    expect(a.source.sample(1).input).toBeUndefined();
  });
  it('hold bindings measure with the owner\'s clock', () => {
    const a = attach();
    a.target.dispatch('keydown', { code: 'KeyC' });
    a.setTime(0);
    expect(a.source.sample(0).actions!['charge']!.v).toBe(0);
    a.setTime(600);
    expect(a.source.sample(1).actions!['charge']!.v).toBe(1);
  });
});
