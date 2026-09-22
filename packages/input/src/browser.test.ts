/**
 * Packet 30 — browser listener owner acceptance, through injected fakes.
 *
 * There is no browser in this container, so every case here drives the real
 * `attachBrowserInput` implementation against fake DOM/gamepad objects that
 * expose exactly the surfaces the owner reads (`addEventListener`/
 * `removeEventListener`, `visibilityState`, `isSecureContext`,
 * `navigator.getGamepads`, `Gamepad`-shaped plain objects). This establishes
 * the listener/focus/gamepad *logic* and listener cleanup; it is **not**
 * physical-device or real-browser evidence — the named desktop procedure is
 * `tests/browser/m2-input/m2-input.browser.ts`.
 */
import { describe, expect, it } from 'vitest';

import { attachBrowserInput } from './browser';
import { DEFAULT_KEYBOARD_MAP } from './types';

type Handler = (event: Event) => void;

/** A minimal EventTarget stand-in that records listener add/remove counts. */
class FakeTarget {
  private readonly listeners = new Map<string, Set<Handler>>();
  added = 0;
  removed = 0;

  addEventListener(type: string, handler: EventListenerOrEventListenerObject): void {
    const fn = handler as unknown as Handler;
    let set = this.listeners.get(type);
    if (!set) {
      set = new Set();
      this.listeners.set(type, set);
    }
    set.add(fn);
    this.added += 1;
  }

  removeEventListener(type: string, handler: EventListenerOrEventListenerObject): void {
    const fn = handler as unknown as Handler;
    this.listeners.get(type)?.delete(fn);
    this.removed += 1;
  }

  dispatch(type: string, event: Record<string, unknown> = {}): void {
    for (const fn of [...(this.listeners.get(type) ?? [])]) {
      fn({ type, ...event } as unknown as Event);
    }
  }

  count(): number {
    let total = 0;
    for (const set of this.listeners.values()) total += set.size;
    return total;
  }
}

interface PadOptions {
  index?: number;
  id?: string;
  mapping?: string;
  axis0?: number;
  pressed?: number[];
  connected?: boolean;
}

/** A Gamepad-shaped plain object (only the fields the owner reads). */
function pad(options: PadOptions = {}): Gamepad {
  const pressed = new Set(options.pressed ?? []);
  const buttons = Array.from({ length: 17 }, (_, i) => ({
    pressed: pressed.has(i),
    touched: pressed.has(i),
    value: pressed.has(i) ? 1 : 0,
  }));
  return {
    id: options.id ?? 'pad-0',
    index: options.index ?? 0,
    mapping: options.mapping ?? 'standard',
    connected: options.connected ?? true,
    axes: [options.axis0 ?? 0, 0, 0, 0],
    buttons,
    timestamp: 0,
    hapticActuators: [],
    vibrationActuator: null,
  } as unknown as Gamepad;
}

interface DiagnosticEvent {
  code: string;
  reason?: string;
  message?: string;
  deviceId?: string;
}

interface HarnessOptions {
  gamepads?: (() => ArrayLike<Gamepad | null>) | null;
  secure?: boolean;
}

function harness(options: HarnessOptions = {}) {
  const target = new FakeTarget();
  const win = new FakeTarget() as FakeTarget & {
    document: FakeTarget;
    navigator: { getGamepads?: () => ArrayLike<Gamepad | null> };
    isSecureContext: boolean;
  };
  const doc = new FakeTarget();
  win.document = doc;
  win.navigator = options.gamepads ? { getGamepads: options.gamepads } : {};
  win.isSecureContext = options.secure ?? true;
  const diagnostics: DiagnosticEvent[] = [];
  const source = attachBrowserInput(target as unknown as EventTarget, {
    window: win as unknown as Window,
    document: doc as unknown as Document,
    navigator: win.navigator as unknown as Navigator,
    getGamepads: options.gamepads ?? null,
    onDiagnostic: (event) => diagnostics.push({ ...event }),
  });
  const keyEvent = (
    code: string,
    overrides: { repeat?: boolean; target?: unknown; preventDefault?: () => void } = {},
  ): Record<string, unknown> => ({
    code,
    repeat: overrides.repeat ?? false,
    target: overrides.target ?? target,
    preventDefault: overrides.preventDefault ?? (() => undefined),
  });
  return { target, win, doc, diagnostics, source, keyEvent };
}

function neutralFrame(stepIndex: number) {
  return { stepIndex, moveX: 0, jump: 'none' };
}

describe('keyboard mapping and release', () => {
  it('maps the default codes to exact digital frames', () => {
    const h = harness();
    h.target.dispatch('keydown', h.keyEvent('KeyD'));
    expect(h.source.sample(12)).toEqual({ stepIndex: 12, moveX: 1, jump: 'none' });
    h.target.dispatch('keyup', h.keyEvent('KeyD'));
    expect(h.source.sample(13)).toEqual(neutralFrame(13));
  });

  it('maps every code in DEFAULT_KEYBOARD_MAP', () => {
    const h = harness();
    h.target.dispatch('keydown', h.keyEvent('ArrowLeft'));
    expect(h.source.sample(12).moveX).toBe(-1);
    h.target.dispatch('keyup', h.keyEvent('ArrowLeft'));
    h.target.dispatch('keydown', h.keyEvent('ArrowRight'));
    expect(h.source.sample(13).moveX).toBe(1);
    h.target.dispatch('keyup', h.keyEvent('ArrowRight'));
    h.target.dispatch('keydown', h.keyEvent('KeyA'));
    expect(h.source.sample(14).moveX).toBe(-1);
    expect(DEFAULT_KEYBOARD_MAP.jump).toContain('Space');
  });

  it('produces one pressed/hold/release chain for Space', () => {
    const h = harness();
    h.target.dispatch('keydown', h.keyEvent('Space'));
    expect(h.source.sample(12).jump).toBe('pressed');
    expect(h.source.sample(13).jump).toBe('held');
    h.target.dispatch('keyup', h.keyEvent('Space'));
    expect(h.source.sample(14).jump).toBe('released');
    expect(h.source.sample(15).jump).toBe('none');
  });

  it('ignores keyboard auto-repeat entirely', () => {
    const h = harness();
    h.target.dispatch('keydown', h.keyEvent('Space'));
    h.target.dispatch('keydown', h.keyEvent('Space', { repeat: true }));
    expect(h.source.sample(12).jump).toBe('pressed');
    h.target.dispatch('keydown', h.keyEvent('Space', { repeat: true }));
    expect(h.source.sample(13).jump).toBe('held');
    h.target.dispatch('keyup', h.keyEvent('Space'));
    expect(h.source.sample(14).jump).toBe('released');
  });

  it('creates no control state from a repeat-only event', () => {
    const h = harness();
    h.target.dispatch('keydown', h.keyEvent('KeyD', { repeat: true }));
    expect(h.source.sample(12)).toEqual(neutralFrame(12));
  });

  it('prevents the default action only for mapped keys', () => {
    const h = harness();
    let mappedDefault = false;
    let unmappedDefault = false;
    h.target.dispatch('keydown', h.keyEvent('Space', { preventDefault: () => (mappedDefault = true) }));
    h.target.dispatch('keydown', h.keyEvent('KeyQ', { preventDefault: () => (unmappedDefault = true) }));
    expect(mappedDefault).toBe(true);
    expect(unmappedDefault).toBe(false);
  });

  it('releases a held key even when the keyup lands on an editable target', () => {
    const h = harness();
    h.target.dispatch('keydown', h.keyEvent('KeyD'));
    h.target.dispatch('keyup', h.keyEvent('KeyD', { target: { tagName: 'INPUT' } }));
    expect(h.source.sample(12)).toEqual(neutralFrame(12));
  });
});

describe('text-field suppression', () => {
  it('ignores mapped keys whose target is editable and does not preventDefault', () => {
    const h = harness();
    let prevented = false;
    h.target.dispatch(
      'keydown',
      h.keyEvent('KeyD', { target: { tagName: 'INPUT' }, preventDefault: () => (prevented = true) }),
    );
    h.target.dispatch('keydown', h.keyEvent('Space', { target: { isContentEditable: true } }));
    expect(h.source.sample(12)).toEqual(neutralFrame(12));
    expect(prevented).toBe(false);
  });

  it('suppresses textarea/select and contenteditable targets', () => {
    const h = harness();
    h.target.dispatch('keydown', h.keyEvent('KeyD', { target: { tagName: 'TEXTAREA' } }));
    h.target.dispatch('keydown', h.keyEvent('KeyD', { target: { tagName: 'SELECT' } }));
    h.target.dispatch('keydown', h.keyEvent('KeyD', { target: { isContentEditable: true } }));
    expect(h.source.sample(12)).toEqual(neutralFrame(12));
  });

  it('suspends held movement when focus moves into an editable element', () => {
    const h = harness();
    h.target.dispatch('keydown', h.keyEvent('KeyD'));
    expect(h.source.sample(12).moveX).toBe(1);
    h.target.dispatch('focusin', { target: { tagName: 'INPUT' } });
    expect(h.source.sample(13)).toEqual(neutralFrame(13));
    expect(h.source.diagnostics?.().suspendCount).toBe(1);
  });
});

describe('focus loss, hidden tab and page hide', () => {
  it('clears held state and forces a neutral frame on window blur', () => {
    const h = harness();
    h.target.dispatch('keydown', h.keyEvent('KeyD'));
    expect(h.source.sample(12).moveX).toBe(1);
    h.win.dispatch('blur');
    expect(h.source.sample(13)).toEqual(neutralFrame(13));
    expect(h.source.sample(14)).toEqual(neutralFrame(14));
    expect(h.source.diagnostics?.().suspendCount).toBe(1);
  });

  it('suspends on a hidden tab and activates again when visible', () => {
    const h = harness();
    h.target.dispatch('keydown', h.keyEvent('KeyD'));
    h.doc.dispatch('visibilitychange', { target: { visibilityState: 'hidden' } });
    expect(h.source.sample(12)).toEqual(neutralFrame(12));
    h.doc.dispatch('visibilitychange', { target: { visibilityState: 'visible' } });
    expect(h.source.diagnostics?.().activateCount).toBe(1);
  });

  it('suspends on pagehide and on the play host losing focus', () => {
    const h = harness();
    h.target.dispatch('keydown', h.keyEvent('KeyD'));
    h.win.dispatch('pagehide');
    expect(h.source.sample(12)).toEqual(neutralFrame(12));
    h.target.dispatch('keydown', h.keyEvent('KeyD'));
    h.target.dispatch('focusout', { target: { tagName: 'DIV' } });
    expect(h.source.sample(13)).toEqual(neutralFrame(13));
    expect(h.source.diagnostics?.().suspendCount).toBe(2);
  });

  it('requires a fresh up→down transition after suspension (no phantom pressed)', () => {
    const h = harness();
    h.target.dispatch('keydown', h.keyEvent('Space'));
    expect(h.source.sample(12).jump).toBe('pressed');
    h.win.dispatch('blur');
    expect(h.source.sample(13).jump).toBe('none');
    // The key is still physically down, and the user presses it again: held, not pressed.
    h.target.dispatch('keydown', h.keyEvent('Space'));
    expect(h.source.sample(14).jump).toBe('held');
    h.target.dispatch('keyup', h.keyEvent('Space'));
    expect(h.source.sample(15).jump).toBe('none');
    h.target.dispatch('keydown', h.keyEvent('Space'));
    expect(h.source.sample(16).jump).toBe('pressed');
  });

  it('never resumes movement from pre-suspension held state', () => {
    const h = harness();
    h.target.dispatch('keydown', h.keyEvent('KeyD'));
    h.win.dispatch('blur');
    h.win.dispatch('focus');
    expect(h.source.sample(12)).toEqual(neutralFrame(12));
    h.target.dispatch('keydown', h.keyEvent('KeyD'));
    expect(h.source.sample(13).moveX).toBe(1);
  });
});

describe('gamepad binding', () => {
  it('samples the stick through the dead zone', () => {
    const h = harness({ gamepads: () => [null, pad({ index: 1, axis0: 0.6 })] });
    expect(h.source.sample(12).moveX).toBe(0.5);
  });

  it('samples the D-pad and the primary face button', () => {
    const h = harness({ gamepads: () => [pad({ pressed: [14, 0] })] });
    const first = h.source.sample(12);
    expect(first.moveX).toBe(-1);
    expect(first.jump).toBe('pressed');
    expect(h.source.sample(13).jump).toBe('held');
  });

  it('ignores a non-standard mapping and reports it once per device', () => {
    const h = harness({
      gamepads: () => [pad({ id: 'x'.repeat(90), mapping: '', axis0: 1, pressed: [0, 15] })],
    });
    expect(h.source.sample(12)).toEqual(neutralFrame(12));
    expect(h.source.sample(13)).toEqual(neutralFrame(13));
    const reported = h.diagnostics.filter((d) => d.code === 'input_mapping_unsupported');
    expect(reported).toHaveLength(1);
    expect(reported[0]?.deviceId?.length).toBe(64);
    expect(h.source.diagnostics?.().mappingUnsupportedCount).toBe(1);
  });

  it('activates the lowest-index standard pad and lets a lower one take over', () => {
    let list: (Gamepad | null)[] = [null, pad({ index: 1, id: 'pad-1', axis0: 1 })];
    const h = harness({ gamepads: () => list });
    expect(h.source.sample(12).moveX).toBe(1);
    list = [pad({ index: 0, id: 'pad-0', axis0: -1 }), pad({ index: 1, id: 'pad-1', axis0: 1 })];
    expect(h.source.sample(13).moveX).toBe(-1);
  });

  it('a lower-index takeover with the jump button already held yields no phantom pressed', () => {
    // The lower pad takes over while its face button is already down; no
    // up→down was observed on that pad, so the takeover must not latch an edge
    // (input.md §4.4/§5.4).
    let list: (Gamepad | null)[] = [null, pad({ index: 1, id: 'pad-1', axis0: 1 })];
    const h = harness({ gamepads: () => list });
    expect(h.source.sample(12)).toMatchObject({ moveX: 1, jump: 'none' });
    list = [
      pad({ index: 0, id: 'pad-0', axis0: -1, pressed: [0] }),
      pad({ index: 1, id: 'pad-1', axis0: 1 }),
    ];
    const takeover = h.source.sample(13);
    expect(takeover.moveX).toBe(-1);
    expect(takeover.jump).toBe('held'); // never 'pressed'
    // A real release then press on the new pad still produces the edge.
    list = [pad({ index: 0, id: 'pad-0', axis0: -1 }), pad({ index: 1, id: 'pad-1', axis0: 1 })];
    expect(h.source.sample(14).jump).toBe('none');
    list = [
      pad({ index: 0, id: 'pad-0', axis0: -1, pressed: [0] }),
      pad({ index: 1, id: 'pad-1', axis0: 1 }),
    ];
    expect(h.source.sample(15).jump).toBe('pressed');
  });

  it('keeps exactly one pad contributing', () => {
    const h = harness({
      gamepads: () => [pad({ index: 0, id: 'a', axis0: 1 }), pad({ index: 1, id: 'b', axis0: -1 })],
    });
    expect(h.source.sample(12).moveX).toBe(1);
  });

  it('handles hot disconnect and requires release before a new edge', () => {
    let list: (Gamepad | null)[] = [pad({ index: 0, id: 'pad-0', pressed: [0] })];
    const h = harness({ gamepads: () => list });
    expect(h.source.sample(12).jump).toBe('pressed');
    const removed = pad({ index: 0, id: 'pad-0', pressed: [0] });
    // The replacement pad is already holding the button when it takes over: no
    // observable release happened, so it must yield `held`, never `pressed`.
    list = [pad({ index: 1, id: 'pad-1', pressed: [0] })];
    h.win.dispatch('gamepaddisconnected', { gamepad: removed });
    expect(h.source.sample(13).jump).toBe('held');
    expect(h.source.diagnostics?.().disconnectCount).toBe(1);
    expect(h.diagnostics.some((d) => d.code === 'input_disconnect')).toBe(true);
    list = [pad({ index: 1, id: 'pad-1' })];
    expect(h.source.sample(14).jump).toBe('none');
    list = [pad({ index: 1, id: 'pad-1', pressed: [0] })];
    expect(h.source.sample(15).jump).toBe('pressed');
  });

  it('treats a reused index with a new id as a disconnect', () => {
    let list: (Gamepad | null)[] = [pad({ index: 0, id: 'pad-A', pressed: [0] })];
    const h = harness({ gamepads: () => list });
    expect(h.source.sample(12).jump).toBe('pressed');
    list = [pad({ index: 0, id: 'pad-B', pressed: [0] })];
    expect(h.source.sample(13).jump).toBe('held');
    expect(h.source.diagnostics?.().disconnectCount).toBe(1);
    list = [pad({ index: 0, id: 'pad-B' })];
    expect(h.source.sample(14).jump).toBe('none');
    expect(h.source.sample(15).jump).toBe('none');
  });

  it('ignores a disconnect event for a non-active pad', () => {
    const list = () => [pad({ index: 0, id: 'pad-0', axis0: 1 })];
    const h = harness({ gamepads: list });
    expect(h.source.sample(12).moveX).toBe(1);
    h.win.dispatch('gamepaddisconnected', { gamepad: pad({ index: 4, id: 'other' }) });
    expect(h.source.diagnostics?.().disconnectCount).toBe(0);
    expect(h.source.sample(13).moveX).toBe(1);
  });
});

describe('blocked, insecure and absent gamepad APIs (input.md §5.5)', () => {
  it('reports a structured unavailable state when getGamepads is absent', () => {
    const h = harness({ gamepads: null });
    expect(h.source.unavailable()).toEqual({
      reason: 'gamepad',
      message: 'navigator.getGamepads is unavailable; keyboard-only',
    });
    expect(h.diagnostics.filter((d) => d.code === 'input_unavailable')).toHaveLength(1);
    h.target.dispatch('keydown', h.keyEvent('KeyD'));
    expect(h.source.sample(12).moveX).toBe(1);
  });

  it('reports an insecure context without throwing', () => {
    const h = harness({ gamepads: () => [pad({ axis0: 1 })], secure: false });
    expect(h.source.unavailable()?.reason).toBe('gamepad');
    expect(h.source.sample(12)).toEqual(neutralFrame(12));
    h.target.dispatch('keydown', h.keyEvent('Space'));
    expect(h.source.sample(13).jump).toBe('pressed');
  });

  it('degrades to keyboard-only when getGamepads throws', () => {
    const h = harness({
      gamepads: () => {
        throw new Error('SecurityError: blocked by permissions policy');
      },
    });
    h.target.dispatch('keydown', h.keyEvent('KeyD'));
    expect(h.source.sample(12).moveX).toBe(1);
    expect(h.source.unavailable()?.reason).toBe('gamepad');
    expect(h.source.sample(13).moveX).toBe(1);
    expect(h.diagnostics.filter((d) => d.code === 'input_unavailable')).toHaveLength(1);
  });

  it('attaches without any browser environment at all', () => {
    const listeners: string[] = [];
    const source = attachBrowserInput(null, {
      window: null,
      document: null,
      navigator: null,
      getGamepads: null,
      onDiagnostic: (event) => listeners.push(event.code),
    });
    expect(source.unavailable()?.reason).toBe('environment');
    expect(source.sample(12)).toEqual(neutralFrame(12));
    expect(listeners).toEqual(['input_unavailable']);
    source.detach();
    expect(source.attached).toBe(false);
  });

  it('never throws from a throwing diagnostic sink', () => {
    const source = attachBrowserInput(null, {
      window: null,
      document: null,
      navigator: null,
      getGamepads: null,
      onDiagnostic: () => {
        throw new Error('sink failed');
      },
    });
    expect(source.unavailable()?.reason).toBe('environment');
    expect(source.sample(1)).toEqual(neutralFrame(1));
  });
});

describe('attachment cleanup (packet 30 acceptance: cleanup removes listeners and held state)', () => {
  it('detach removes every listener exactly once and is idempotent', () => {
    const h = harness({ gamepads: () => [pad()] });
    expect(h.source.attached).toBe(true);
    expect(h.target.count() + h.win.count() + h.doc.count()).toBeGreaterThan(0);
    h.source.detach();
    expect(h.source.attached).toBe(false);
    expect(h.target.count()).toBe(0);
    expect(h.win.count()).toBe(0);
    expect(h.doc.count()).toBe(0);
    expect(h.target.added).toBe(h.target.removed);
    expect(h.win.added).toBe(h.win.removed);
    expect(h.doc.added).toBe(h.doc.removed);
    const removals = [h.target.removed, h.win.removed, h.doc.removed];
    h.source.detach();
    expect([h.target.removed, h.win.removed, h.doc.removed]).toEqual(removals);
  });

  it('dispose() is the same idempotent cleanup', () => {
    const h = harness();
    h.source.dispose();
    expect(h.source.attached).toBe(false);
    expect(h.target.count()).toBe(0);
    expect(h.win.count()).toBe(0);
  });

  it('clears held state and samples neutral frames after detach', () => {
    const h = harness();
    h.target.dispatch('keydown', h.keyEvent('KeyD'));
    h.target.dispatch('keydown', h.keyEvent('Space'));
    h.source.detach();
    expect(h.source.sample(12)).toEqual(neutralFrame(12));
    expect(h.source.sample(13)).toEqual(neutralFrame(13));
  });

  it('leaves no listeners installed after a detach on every target', () => {
    const h = harness();
    h.source.detach();
    h.target.dispatch('keydown', h.keyEvent('KeyD'));
    h.win.dispatch('gamepadconnected', { gamepad: pad() });
    expect(h.source.sample(12)).toEqual(neutralFrame(12));
  });
});
