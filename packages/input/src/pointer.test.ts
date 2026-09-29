/**
 * The pointer in action frames and action maps, and the cursor
 * rules, against the real browser owner driven through fake DOM objects (the
 * same approach as browser.test.ts: logic evidence, not real-device evidence).
 */
import { describe, expect, it } from 'vitest';

import { bindsPointerButton, bindsWheel, createActionEvaluator, cursorPresentation, type InputConfigLike, type RawDeviceState } from './actions';
import { attachBrowserInput } from './browser';

type Handler = (event: Event) => void;

class FakeTarget {
  private readonly listeners = new Map<string, Set<Handler>>();
  attrs: Record<string, string> = {};
  style: { cursor?: string } = {};
  lockRequests = 0;
  rect = { left: 100, top: 50, width: 800, height: 400 };
  addEventListener(type: string, handler: EventListenerOrEventListenerObject): void {
    let set = this.listeners.get(type);
    if (!set) this.listeners.set(type, (set = new Set()));
    set.add(handler as unknown as Handler);
  }
  removeEventListener(type: string, handler: EventListenerOrEventListenerObject): void {
    this.listeners.get(type)?.delete(handler as unknown as Handler);
  }
  dispatch(type: string, event: Record<string, unknown> = {}): void {
    for (const fn of [...(this.listeners.get(type) ?? [])]) fn({ type, ...event } as unknown as Event);
  }
  getBoundingClientRect(): { left: number; top: number; width: number; height: number } {
    return this.rect;
  }
  setAttribute(k: string, v: string): void {
    this.attrs[k] = v;
  }
  requestPointerLock(): void {
    this.lockRequests += 1;
  }
}

const POINTER_CONFIG: InputConfigLike = {
  actions: [
    { name: 'select', type: 'button', map: 'gameplay', bindings: [{ kind: 'pointerButton', button: 'left' }, { kind: 'key', code: 'Enter' }] },
    { name: 'context', type: 'button', map: 'gameplay', bindings: [{ kind: 'pointerButton', button: 'right' }] },
    { name: 'look', type: 'axis2d', map: 'gameplay', bindings: [{ kind: 'pointerDelta' }, { kind: 'gamepadStick', x: 2, y: 3 }] },
    { name: 'aim', type: 'axis2d', map: 'gameplay', bindings: [{ kind: 'pointerPosition' }] },
    { name: 'zoom', type: 'axis1d', map: 'gameplay', bindings: [{ kind: 'pointerAxis', axis: 'wheel' }, { kind: 'keys1d', negative: 'KeyQ', positive: 'KeyE' }] },
    { name: 'turn', type: 'axis1d', map: 'gameplay', bindings: [{ kind: 'pointerAxis', axis: 'x' }], scale: 0.5 },
  ],
};

function harness(config: InputConfigLike = POINTER_CONFIG, pads: Gamepad[] = []) {
  const target = new FakeTarget();
  const win = new FakeTarget() as FakeTarget & { document: FakeTarget; navigator: unknown; isSecureContext: boolean };
  const doc = new FakeTarget() as FakeTarget & { pointerLockElement: unknown; exitPointerLock: () => void };
  doc.pointerLockElement = null;
  let exits = 0;
  doc.exitPointerLock = () => {
    exits += 1;
    doc.pointerLockElement = null;
  };
  win.document = doc;
  win.isSecureContext = true;
  const padList = { list: pads };
  const source = attachBrowserInput(target as unknown as EventTarget, {
    window: win as unknown as Window,
    document: doc as unknown as Document,
    navigator: {} as Navigator,
    getGamepads: () => padList.list,
    inputConfig: config,
  });
  // Client coordinates of a view point (fractions of the 800 × 400 view at 100, 50).
  const at = (fx: number, fy: number): { clientX: number; clientY: number } => ({ clientX: 100 + fx * 800, clientY: 50 + fy * 400 });
  return { target, win, doc, source, at, padList, exits: () => exits };
}

const empty = (pointer: RawDeviceState['pointer']): RawDeviceState => ({ keys: new Set(), pressedKeys: new Set(), gamepad: null, pointer });

describe('pointer bindings in action maps (the evaluator)', () => {
  it('buttons, a wheel axis, the position and the movement (an amount per sample: i = 1)', () => {
    const ev = createActionEvaluator(POINTER_CONFIG);
    const a = ev.sample(empty({ x: 0.25, y: 0.75, dx: 0.02, dy: -0.01, wheel: 2, buttons: 1, pressed: 1 }));
    expect(a['select']).toEqual({ v: 1, p: 'pressed' });
    expect(a['context']).toEqual({ v: 0, p: 'none' });
    // Movement in percent of the view per step, y up positive like a stick; a per-sample amount.
    expect(a['look']).toEqual({ v: expect.closeTo(Math.hypot(2, 1), 4), x: 2, y: 1, p: 'pressed', i: 1 });
    // The position is taken as it is (x, y 0-1 from the top left; no length clip).
    expect(a['aim']).toEqual({ v: expect.closeTo(Math.hypot(0.25, 0.75), 4), x: 0.25, y: 0.75, p: 'pressed' });
    expect(a['zoom']).toEqual({ v: 2, p: 'pressed', i: 1 });
    // scale applies (0.5 × 2%).
    expect(a['turn']).toEqual({ v: 1, p: 'pressed', i: 1 });
    // Next sample: the button is held, nothing moved.
    const b = ev.sample(empty({ x: 0.25, y: 0.75, dx: 0, dy: 0, wheel: 0, buttons: 1, pressed: 0 }));
    expect(b['select']).toEqual({ v: 1, p: 'held' });
    expect(b['look']!.v).toBe(0);
    expect(b['zoom']).toEqual({ v: 0, p: 'released' });
  });

  it('a click between two samples still presses (pressed bit without a held button)', () => {
    const ev = createActionEvaluator(POINTER_CONFIG);
    expect(ev.sample(empty({ x: 0.5, y: 0.5, dx: 0, dy: 0, wheel: 0, buttons: 0, pressed: 1 }))['select']).toEqual({ v: 1, p: 'pressed' });
    expect(ev.sample(empty({ x: 0.5, y: 0.5, dx: 0, dy: 0, wheel: 0, buttons: 0, pressed: 0 }))['select']).toEqual({ v: 0, p: 'released' });
  });

  it('a key and the wheel on one axis: the larger magnitude wins; an amount is clamped to ±10', () => {
    const ev = createActionEvaluator(POINTER_CONFIG);
    const keys: RawDeviceState = { keys: new Set(['KeyE']), pressedKeys: new Set(), gamepad: null, pointer: { x: 0, y: 0, dx: 0.5, dy: 0, wheel: -0.5, buttons: 0, pressed: 0 } };
    const a = ev.sample(keys);
    expect(a['zoom']).toEqual({ v: 1, p: 'pressed' }); // the key (1) beats the wheel (0.5); not an amount
    expect(a['turn']).toEqual({ v: 5, p: 'pressed', i: 1 }); // 50% → the 10 bound, × 0.5
  });

  it('finds the pointer bindings that change the view behaviour', () => {
    expect(bindsPointerButton(POINTER_CONFIG, 'right')).toBe(true);
    expect(bindsPointerButton(POINTER_CONFIG, 'middle')).toBe(false);
    expect(bindsWheel(POINTER_CONFIG)).toBe(true);
    expect(bindsWheel({ actions: [] })).toBe(false);
  });
});

describe('the browser owner samples the pointer into the frame', () => {
  it('no pointer before it is seen; then position, movement, buttons and edges per sample', () => {
    const h = harness();
    expect(h.source.sample(0).pointer).toBeUndefined();
    h.target.dispatch('pointermove', { ...h.at(0.5, 0.5), pointerType: 'mouse' });
    expect(h.source.sample(1).pointer).toEqual({ x: 0.5, y: 0.5 });
    h.target.dispatch('pointermove', { ...h.at(0.6, 0.25), pointerType: 'mouse' });
    h.target.dispatch('pointerdown', { ...h.at(0.6, 0.25), button: 0 });
    const f = h.source.sample(2);
    expect(f.pointer).toEqual({ x: 0.6, y: 0.25, dx: 0.1, dy: -0.25, buttons: 1, pressed: 1 });
    expect(f.actions!['select']).toEqual({ v: 1, p: 'pressed' });
    // Held, not moved: no movement, no edge.
    expect(h.source.sample(3).pointer).toEqual({ x: 0.6, y: 0.25, buttons: 1 });
    // Released outside the view (window pointerup).
    h.win.dispatch('pointerup', { button: 0 });
    expect(h.source.sample(4).pointer).toEqual({ x: 0.6, y: 0.25, released: 1 });
    expect(h.source.sample(5).pointer).toEqual({ x: 0.6, y: 0.25 });
  });

  it('a click between two samples reports both edges; the wheel adds up in notches; leaving the view', () => {
    const h = harness();
    h.target.dispatch('pointerenter', h.at(0.1, 0.9));
    h.target.dispatch('pointerdown', { ...h.at(0.1, 0.9), button: 2 });
    h.win.dispatch('pointerup', { button: 2 });
    h.target.dispatch('wheel', { deltaY: 100, deltaMode: 0 });
    h.target.dispatch('wheel', { deltaY: 150, deltaMode: 0 });
    const f = h.source.sample(0);
    expect(f.pointer).toEqual({ x: 0.1, y: 0.9, wheel: 2.5, pressed: 2, released: 2 });
    expect(f.actions!['context']).toEqual({ v: 1, p: 'pressed' });
    h.target.dispatch('pointerleave', {});
    expect(h.source.sample(1).pointer).toEqual({ x: 0.1, y: 0.9, over: false });
    // Lines count 3 to a notch.
    h.target.dispatch('wheel', { deltaY: -3, deltaMode: 1 });
    expect(h.source.sample(2).pointer!.wheel).toBe(-1);
  });

  it('the context menu and the page scroll are kept only when an action binds the right button / the wheel', () => {
    let prevented = 0;
    const preventDefault = (): void => {
      prevented += 1;
    };
    const bound = harness();
    bound.target.dispatch('contextmenu', { preventDefault });
    bound.target.dispatch('wheel', { deltaY: 100, deltaMode: 0, preventDefault });
    expect(prevented).toBe(2);
    const plain = harness({ actions: [{ name: 'jump', type: 'button', map: 'gameplay', bindings: [{ kind: 'key', code: 'Space' }] }] });
    plain.target.dispatch('contextmenu', { preventDefault });
    plain.target.dispatch('wheel', { deltaY: 100, deltaMode: 0, preventDefault });
    expect(prevented).toBe(2);
  });

  it('a lost focus lets the buttons go (the next sample reports no held button)', () => {
    const h = harness();
    h.target.dispatch('pointerdown', { ...h.at(0.3, 0.3), button: 0 });
    expect(h.source.sample(0).pointer!.buttons).toBe(1);
    h.win.dispatch('blur', {});
    h.source.sample(1); // the suspended sample (neutral)
    expect(h.source.sample(2).pointer).toEqual({ x: 0.3, y: 0.3 });
  });
});

describe('the cursor: free / locked, hidden while a gamepad drives', () => {
  it('the presentation rule', () => {
    expect(cursorPresentation('free', 'keyboard')).toEqual({ lock: false, hide: false });
    expect(cursorPresentation('free', 'gamepad')).toEqual({ lock: false, hide: true });
    expect(cursorPresentation('locked', 'keyboard')).toEqual({ lock: true, hide: true });
    expect(cursorPresentation('locked', 'gamepad')).toEqual({ lock: true, hide: true });
  });

  it('locked asks the browser for pointer lock (again on a click in the view); the position is the centre; free releases it', () => {
    const h = harness();
    h.target.dispatch('pointermove', h.at(0.2, 0.2));
    h.source.sample(0);
    h.source.applyCursor('locked');
    expect(h.target.lockRequests).toBe(1);
    expect(h.target.attrs['data-tl-cursor']).toBe('locked');
    expect(h.target.attrs['data-tl-pointer-lock']).toBe('off');
    // The browser wanted a gesture: a click in the view asks again.
    h.target.dispatch('pointerdown', { ...h.at(0.2, 0.2), button: 0 });
    expect(h.target.lockRequests).toBe(2);
    h.win.dispatch('pointerup', { button: 0 });
    h.source.sample(1);
    // The browser grants it.
    h.doc.pointerLockElement = h.target;
    h.doc.dispatch('pointerlockchange', {});
    expect(h.target.attrs['data-tl-pointer-lock']).toBe('on');
    expect(h.target.style.cursor).toBe('none');
    // Locked: only the movement counts (fractions of the view), the position is the centre.
    h.target.dispatch('pointermove', { ...h.at(0.9, 0.9), movementX: 80, movementY: -40 });
    const f = h.source.sample(2);
    expect(f.pointer).toEqual({ x: 0.5, y: 0.5, dx: 0.1, dy: -0.1, locked: true });
    expect(f.actions!['look']).toEqual({ v: 10, x: 10, y: 10, p: 'pressed', i: 1 }); // 10% of the view each way: the bound
    expect(h.source.cursorState()).toEqual({ mode: 'locked', locked: true, hidden: true });
    h.source.applyCursor('free');
    expect(h.exits()).toBe(1);
    expect(h.source.cursorState()).toEqual({ mode: 'free', locked: false, hidden: false });
    expect(h.target.style.cursor).toBe('');
  });

  it('hidden while a gamepad was used last; shown again when the pointer moves', () => {
    const buttons = Array.from({ length: 17 }, (_, i) => ({ pressed: i === 0, touched: i === 0, value: i === 0 ? 1 : 0 }));
    const gp = { id: 'pad', index: 0, mapping: 'standard', connected: true, axes: [0, 0, 0, 0], buttons, timestamp: 0 } as unknown as Gamepad;
    const h = harness(POINTER_CONFIG, [gp]);
    h.source.applyCursor('free');
    h.source.sample(0);
    expect(h.source.cursorState().hidden).toBe(true);
    expect(h.target.style.cursor).toBe('none');
    h.padList.list = [];
    h.target.dispatch('pointermove', { ...h.at(0.4, 0.4), pointerType: 'mouse' });
    h.source.sample(1);
    expect(h.source.cursorState().hidden).toBe(false);
    expect(h.target.attrs['data-tl-cursor-hidden']).toBe('false');
  });

  it('detach gives the cursor back', () => {
    const h = harness();
    h.source.applyCursor('locked');
    h.doc.pointerLockElement = h.target;
    h.doc.dispatch('pointerlockchange', {});
    h.source.detach();
    expect(h.exits()).toBe(1);
    expect(h.target.style.cursor).toBe('');
  });
});
