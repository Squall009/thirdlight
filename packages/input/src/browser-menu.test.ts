/**
 * Packet 55 — the browser input owner's menu seam (delivery.md
 * §4.1/§4.2), through injected fakes (no browser in this container).
 *
 * The real `attachBrowserInput` implementation is driven against a fake
 * target/window/navigator: menu keys (Enter/Space/KeyM) and the pad
 * primary button feed the pure menu controller; the consumed-press
 * fresh-release state machine suppresses the same physical press from
 * becoming a gameplay jump; focus loss and disconnect clear the right
 * slices of menu state.
 */
import { describe, expect, it } from 'vitest';
import { attachBrowserInput } from './browser';

/** A minimal EventTarget stand-in (same pattern as browser.test.ts). */
class FakeTarget {
  private readonly listeners = new Map<string, Set<Function>>();

  addEventListener(type: string, handler: EventListenerOrEventListenerObject): void {
    let set = this.listeners.get(type);
    if (!set) {
      set = new Set();
      this.listeners.set(type, set);
    }
    set.add(handler as unknown as Function);
  }

  removeEventListener(type: string, handler: EventListenerOrEventListenerObject): void {
    this.listeners.get(type)?.delete(handler as unknown as Function);
  }

  dispatch(type: string, event: Record<string, unknown> = {}): void {
    for (const fn of [...(this.listeners.get(type) ?? [])]) {
      fn({ type, ...event } as unknown as Event);
    }
  }
}

interface PadOptions {
  index?: number;
  id?: string;
  mapping?: string;
  pressed?: number[];
  connected?: boolean;
}

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
    axes: [0, 0, 0, 0],
    buttons,
    timestamp: 0,
    hapticActuators: [],
    vibrationActuator: null,
  } as unknown as Gamepad;
}

interface Harness {
  source: ReturnType<typeof attachBrowserInput>;
  win: FakeTarget;
  doc: FakeTarget;
  key: (code: string, down?: boolean, extra?: Record<string, unknown>) => void;
  setPads: (pads: ArrayLike<Gamepad | null>) => void;
}

function harness(pads: ArrayLike<Gamepad | null> = []): Harness {
  const target = new FakeTarget();
  const win = new FakeTarget();
  const doc = new FakeTarget();
  (win as unknown as { document: FakeTarget }).document = doc;
  let padList: ArrayLike<Gamepad | null> = pads;
  (win as unknown as { navigator: object }).navigator = {
    getGamepads: () => padList,
  };
  (win as unknown as { isSecureContext: boolean }).isSecureContext = true;
  const source = attachBrowserInput(target as unknown as EventTarget, {
    window: win as unknown as Window,
    document: doc as unknown as Document,
    navigator: (win as unknown as { navigator: object }).navigator as unknown as Navigator,
    getGamepads: () => padList,
  });
  const key = (code: string, down = true, extra: Record<string, unknown> = {}): void => {
    const targetLike = { isContentEditable: false, tagName: 'CANVAS' };
    if (down) {
      target.dispatch('keydown', { code, target: targetLike, ...extra });
    } else {
      target.dispatch('keyup', { code, target: targetLike, ...extra });
    }
  };
  return { source, win, doc, key, setPads: (p: ArrayLike<Gamepad | null>): void => { padList = p; } };
}

describe('the owner feeds the menu channel (delivery.md §4.1)', () => {
  it('Enter and Space keydowns latch a menu confirm (Enter never touches the gameplay frame)', () => {
    const { source, key } = harness();
    key('Enter');
    expect(source.sample(0)).toEqual({ stepIndex: 0, moveX: 0, jump: 'none' });
    expect(source.sampleMenu().confirm).toBe(true);
    key('Enter', false);
    key('Space');
    expect(source.sampleMenu().confirm).toBe(true);
    expect(source.sampleMenu().confirm).toBe(false); // latches clear on read
  });

  it('KeyM latches the mute toggle', () => {
    const { source, key } = harness();
    key('KeyM');
    const s = source.sampleMenu();
    expect(s.mute).toBe(true);
    expect(s.confirm).toBe(false);
    expect(source.sampleMenu().mute).toBe(false);
  });

  it('a held gamepad primary button latches a fresh-press confirm on the poll that sees it', () => {
    const { source, setPads } = harness();
    setPads([pad({ pressed: [0] })]);
    source.sample(0); // the poll sees the fresh press
    const s = source.sampleMenu();
    expect(s.confirm).toBe(true);
    expect(s.confirmDevice).toBe(null); // not consumed yet
    source.sample(1); // held: no re-report
    expect(source.sampleMenu().confirm).toBe(false);
  });
});

describe('the §4.2 fresh-release state machine (delivery.md)', () => {
  it('a consumed Space confirm held down does NOT jump; a fresh press in play jumps (C1/C2)', () => {
    const { source, key } = harness();
    key('Space');
    source.sampleMenu(); // the host samples the confirm at the title
    source.markConfirmConsumed(); // and acts on it (start) — the press is consumed
    // The held press: the gameplay frame must be neutral (case C1 — no
    // phantom jump; the run starts with a neutral frame).
    expect(source.sample(0)).toEqual({ stepIndex: 0, moveX: 0, jump: 'none' });
    expect(source.sample(1)).toEqual({ stepIndex: 1, moveX: 0, jump: 'none' });
    const s = source.sampleMenu();
    expect(s.confirmNeedsRelease).toBe(true);
    expect(s.confirmDevice).toBe('keyboard');
    // Release clears the needsRelease state...
    key('Space', false);
    expect(source.sample(2).jump).toBe('none');
    // ...and a fresh press (the release-then-press cycle, case C2) is a
    // confirm latch AND — in play, where the host does not act on the
    // confirm as a menu action — a legitimate jump of the same press.
    key('Space');
    expect(source.sampleMenu().confirm).toBe(true);
    expect(source.sample(3).jump).toBe('pressed');
    expect(source.sample(4).jump).toBe('held'); // the full hold survives (no early 'released')
  });

  it('a consumed pad primary-button confirm held down does NOT jump; release then press does (C3)', () => {
    const { source, setPads } = harness();
    setPads([pad({ pressed: [0] })]);
    source.sample(0); // fresh press seen
    source.sampleMenu();
    source.markConfirmConsumed();
    source.sample(1); // still held: the pad jump must be suppressed
    expect(source.sample(1 + 1)).toEqual({ stepIndex: 2, moveX: 0, jump: 'none' });
    setPads([pad({})]); // released
    source.sample(3);
    expect(source.sampleMenu().confirmNeedsRelease).toBe(false);
    setPads([pad({ pressed: [0] })]); // fresh press after release
    const f4 = source.sample(4); // the fresh press is a confirm AND may jump (in play)
    expect(source.sampleMenu().confirm).toBe(true);
    expect(f4.jump).toBe('pressed');
    expect(source.sample(5).jump).toBe('held'); // the hold continues normally (no early release)
  });

  it('gameplay movement and jump from other sources are unaffected by a held Enter confirm', () => {
    const { source, key } = harness();
    key('Enter');
    source.sampleMenu();
    source.markConfirmConsumed(); // Enter held and consumed
    key('KeyD'); // move right (a different key)
    const frame = source.sample(0);
    expect(frame.moveX).toBeGreaterThan(0); // movement is untouched
    expect(frame.jump).toBe('none'); // Enter suppresses no jump
  });
});

describe('environment transitions (delivery.md §4.3/§4.6)', () => {
  it('visibility-hidden clears the menu latches and held confirm state (C9)', () => {
    const { source, doc, key } = harness();
    key('Space');
    key('KeyM');
    (doc as unknown as { visibilityState: string }).visibilityState = 'hidden';
    doc.dispatch('visibilitychange');
    const s = source.sampleMenu();
    expect(s.confirm).toBe(false);
    expect(s.mute).toBe(false);
    // The held keyboard jump is also cleared (the M2 suspend behavior).
    expect(source.sample(0)).toEqual({ stepIndex: 0, moveX: 0, jump: 'none' });
  });

  it('window blur clears the menu channel the same way', () => {
    const { source, win, key } = harness();
    key('Enter');
    win.dispatch('blur');
    expect(source.sampleMenu().confirm).toBe(false);
  });

  it('a pad disconnect clears only the pad menu state (C7)', () => {
    const { source, setPads, key } = harness([pad({ pressed: [0] })]);
    source.sample(0); // the poll sees the fresh pad press
    key('Enter'); // a keyboard confirm is in flight too
    source.sampleMenu(); // the host reads the confirms
    source.markConfirmConsumed();
    setPads([]); // the pad disconnects
    source.sample(1); // the poll reconciles the loss
    const s = source.sampleMenu();
    expect(s.confirm).toBe(false);
    expect(s.confirmNeedsRelease).toBe(true);
    expect(s.confirmDevice).toBe('keyboard'); // the keyboard hold survives the pad loss
    expect(source.sample(2).jump).toBe('none'); // Enter is not the jump key
  });

  it('detach leaves the menu channel readable and clear', () => {
    const { source, key } = harness();
    key('Space');
    source.detach();
    const s = source.sampleMenu();
    expect(s.confirm).toBe(false);
    expect(s.confirmNeedsRelease).toBe(false);
  });
});

describe('input-gate rules still apply to the menu channel', () => {
  it('auto-repeat never latches a second confirm (repeat is dropped before the menu sees it)', () => {
    const { source, key } = harness();
    key('Space');
    key('Space', true, { repeat: true }); // e.repeat === true
    expect(source.sampleMenu().confirm).toBe(true); // one press
    expect(source.sampleMenu().confirm).toBe(false);
  });

  it('a keydown on an editable target never latches a menu action', () => {
    const { source } = harness();
    const target = new FakeTarget();
    const win = new FakeTarget();
    const doc = new FakeTarget();
    (win as unknown as { document: FakeTarget }).document = doc;
    (win as unknown as { navigator: object }).navigator = {};
    (win as unknown as { isSecureContext: boolean }).isSecureContext = true;
    const src = attachBrowserInput(target as unknown as EventTarget, {
      window: win as unknown as Window,
      document: doc as unknown as Document,
      navigator: (win as unknown as { navigator: object }).navigator as unknown as Navigator,
    });
    const editable = { isContentEditable: true, tagName: 'INPUT' };
    target.dispatch('keydown', { code: 'Enter', target: editable });
    target.dispatch('keydown', { code: 'KeyM', target: editable });
    expect(src.sampleMenu().confirm).toBe(false);
    expect(src.sampleMenu().mute).toBe(false);
    // ...but the keyup still releases (always-release rule).
    target.dispatch('keyup', { code: 'Enter', target: editable });
  });
});