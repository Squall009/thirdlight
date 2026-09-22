/**
 * The single explicit browser listener owner (packet 30; input.md §4/§5).
 *
 * This is the **only** file in `@thirdlight/input` that touches `window`,
 * `document` or `navigator` (input.md §1). It owns every listener it installs,
 * reduces raw events and `Navigator.getGamepads()` to plain
 * `RawInputSnapshot` values, and delegates all mapping to the pure
 * `mapRawStep`. It never throws into the caller and never pretends the
 * gamepad API works: a blocked/insecure/absent API degrades to keyboard-only
 * with a structured `input_unavailable` diagnostic.
 *
 * Failure handling covered here (packet 30 "Failures" row):
 *  - blocked / insecure API → `input_unavailable` once per attach;
 *  - absent or non-standard device → keyboard-only / `input_mapping_unsupported`;
 *  - reconnect and **index reuse** → the active pad is keyed by `index`+`id`,
 *    and a changed id at a reused index is treated as a disconnect;
 *  - keyboard auto-repeat (`event.repeat === true`) → ignored entirely;
 *  - hidden tab / focus loss / `pagehide` → held state cleared, jump forced up,
 *    `awaitingRelease` so resume cannot produce a phantom `pressed`;
 *  - typing in the inspector → editable `event.target` events are suppressed
 *    (detected per event, never via `document.activeElement`), and focus
 *    entering an editable element suspends the binding;
 *  - cleanup → `detach()`/`dispose()` remove every listener and clear held
 *    state, idempotently.
 */
import type { ActionFrame, ActionSource } from '@thirdlight/runtime';
import { mapRawStep, type StepState } from './mapping';
import {
  createMenuController,
  type MenuSample,
} from './menu';
import {
  DEFAULT_KEYBOARD_MAP,
  GAMEPAD_DEAD_ZONE,
  type InputBindingOptions,
  type RawInputSnapshot,
} from './types';

const LEFT_CODES = new Set(DEFAULT_KEYBOARD_MAP.left);
const RIGHT_CODES = new Set(DEFAULT_KEYBOARD_MAP.right);
const JUMP_CODES = new Set(DEFAULT_KEYBOARD_MAP.jump);
const DEVICE_ID_MAX = 64;

/** The minimal event surface the owner reads (real DOM events satisfy it). */
interface KeyboardEventLike {
  code?: unknown;
  repeat?: unknown;
  target?: unknown;
  preventDefault?: () => void;
}

interface GamepadEventLike {
  gamepad?: Gamepad | null;
}

interface VisibilityEventLike {
  target?: unknown;
}

function isMappedCode(code: unknown): code is string {
  return (
    typeof code === 'string' &&
    (LEFT_CODES.has(code) || RIGHT_CODES.has(code) || JUMP_CODES.has(code))
  );
}

/** Editable-target detection from the event's own target (input.md §5.1). */
function isEditableTarget(target: unknown): boolean {
  if (typeof target !== 'object' || target === null) return false;
  const el = target as { tagName?: unknown; isContentEditable?: unknown };
  if (el.isContentEditable === true) return true;
  const tag = typeof el.tagName === 'string' ? el.tagName.toUpperCase() : '';
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
}

function clipDeviceId(id: unknown): string {
  const s = typeof id === 'string' ? id : '';
  return s.length > DEVICE_ID_MAX ? s.slice(0, DEVICE_ID_MAX) : s;
}

function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message.slice(0, 200);
  return String(error).slice(0, 200);
}

function neutral(stepIndex: number): ActionFrame {
  return { stepIndex, moveX: 0, jump: 'none' };
}

/**
 * Make the game surface receive keyboard input: a canvas is not focusable by
 * default, so keys would never reach the keydown listener. Gives it a tab
 * stop, focuses it now and whenever it is clicked.
 */
export function focusGameSurface(el: HTMLElement): void {
  if (el.tabIndex < 0) el.tabIndex = 0;
  el.style.outline = 'none';
  el.addEventListener('pointerdown', () => el.focus());
  el.focus();
}

/**
 * Attach the browser binding to one play host. `target` scopes keyboard
 * `keydown`/`focusin`/`focusout`; window/document events handle release,
 * suspension and gamepad hot-plug (input.md §5.2/§5.3).
 *
 * The returned source is the runtime's `ActionSource` plus `detach()` /
 * `dispose()`, `unavailable()` and `attached`. Attaching never throws, even
 * with no DOM at all.
 */
export function attachBrowserInput(
  target: EventTarget | null,
  options: InputBindingOptions = {},
): ActionSource & {
  /** Remove every listener and clear held state; idempotent. */
  detach(): void;
  /** Alias of `detach` (input.md §5.6 disposal). */
  dispose(): void;
  /** The structured unavailable state, or `null` while the API is usable. */
  unavailable(): { reason: 'gamepad' | 'environment'; message: string } | null;
  /** `true` until `detach()`; a detached source samples neutral frames. */
  readonly attached: boolean;
  /**
   * The bounded semantic menu channel (delivery.md §4.1 — packet 55): one
   * plain-data sample, latches cleared on read. Consumed by the game host,
   * never by the runtime ActionFrame.
   */
  sampleMenu(): MenuSample;
  /** The host consumed a confirm sample: the held press now needs a release (delivery.md §4.2). */
  markConfirmConsumed(): void;
} {
  const globalWindow =
    typeof globalThis === 'object'
      ? ((globalThis as { window?: Window | null }).window ?? null)
      : null;
  const win: Window | null = options.window !== undefined ? options.window : globalWindow;
  const doc: Document | null =
    options.document !== undefined ? options.document : (win?.document ?? null);
  const nav: Navigator | null =
    options.navigator !== undefined ? options.navigator : (win?.navigator ?? null);

  const pollGamepads: (() => ArrayLike<Gamepad | null>) | null = (() => {
    if (options.getGamepads !== undefined) return options.getGamepads;
    const candidate = nav?.getGamepads;
    if (typeof candidate !== 'function') return null;
    return () => candidate.call(nav);
  })();

  let detached = false;
  let unavailableState: { reason: 'gamepad' | 'environment'; message: string } | null = null;
  let unavailableReported = false;
  let suspendPending = false;

  const counters = {
    suspendCount: 0,
    activateCount: 0,
    disconnectCount: 0,
    mappingUnsupportedCount: 0,
  };
  const held = new Set<string>();
  let jumpLatch = false;
  let state: StepState = { down: false, awaitingRelease: false };
  // The bounded semantic menu channel (delivery.md §4.1/§4.2) — separate
  // from the gameplay ActionFrame: the owner feeds its device events into
  // the pure controller; the game host consumes `sampleMenu()` and calls
  // `markConfirmConsumed()`. The controller's `suppress()` state feeds the
  // gameplay sampler so a consumed menu press can never become a jump from
  // the same physical press (§4.2 fresh release).
  const menu = createMenuController();
  let prevGamepadJumpDown = false;
  let activeIndex: number | null = null;
  let activeId: string | null = null;
  const tracked = new Map<number, string>();
  const reportedMappingIds = new Set<string>();

  const emit = (event: {
    code:
      | 'input_unavailable'
      | 'input_mapping_unsupported'
      | 'input_suspend'
      | 'input_activate'
      | 'input_disconnect';
    reason?: string;
    message?: string;
    deviceId?: string;
  }): void => {
    if (!options.onDiagnostic) return;
    try {
      options.onDiagnostic(event);
    } catch {
      // A diagnostic sink must never break input (input.md §5.3 "diagnostics only").
    }
  };

  const markUnavailable = (reason: 'gamepad' | 'environment', message: string): void => {
    if (unavailableState === null) unavailableState = { reason, message };
    if (unavailableReported) return;
    unavailableReported = true;
    emit({ code: 'input_unavailable', reason, message });
  };

  // --- suspension / fresh activation (input.md §5.3) ------------------------

  /**
   * Fresh activation after a suspension or an active-pad change (input.md
   * §5.3/§5.4): held state and pending edges are discarded and every control
   * enters `awaitingRelease`, so a physically down control yields `held` —
   * never `pressed` — until it is observed up once (§12.5.6/§12.5.7).
   */
  const freshActivation = (): void => {
    jumpLatch = false;
    state = { down: false, awaitingRelease: true };
    prevGamepadJumpDown = false;
  };

  const suspend = (reason: string): void => {
    if (detached) return;
    held.clear();
    menu.clear('all'); // focus/visibility loss: every held key/button and the
    // menu latch clear (delivery.md §4.6)
    freshActivation();
    suspendPending = true;
    counters.suspendCount += 1;
    emit({ code: 'input_suspend', reason });
  };

  const activate = (reason: string): void => {
    if (detached) return;
    suspendPending = false;
    counters.activateCount += 1;
    emit({ code: 'input_activate', reason });
  };

  // --- gamepad bookkeeping (input.md §4.4/§5.4) ----------------------------

  const toSnapshot = (gp: Gamepad): NonNullable<RawInputSnapshot['gamepad']> => {
    const axis0 = gp.axes[0];
    const button = (i: number): boolean => gp.buttons[i]?.pressed === true;
    return {
      index: gp.index,
      id: clipDeviceId(gp.id),
      mapping: typeof gp.mapping === 'string' ? gp.mapping : '',
      axis0: typeof axis0 === 'number' && Number.isFinite(axis0) ? axis0 : 0,
      button0: button(0),
      button14: button(14),
      button15: button(15),
    };
  };

  const deviceHasActivity = (gp: Gamepad): boolean => {
    const axis0 = gp.axes[0];
    if (typeof axis0 === 'number' && Number.isFinite(axis0) && Math.abs(axis0) > GAMEPAD_DEAD_ZONE) {
      return true;
    }
    return (
      gp.buttons[0]?.pressed === true ||
      gp.buttons[14]?.pressed === true ||
      gp.buttons[15]?.pressed === true
    );
  };

  const reportMappingUnsupported = (gp: Gamepad): void => {
    const id = clipDeviceId(gp.id);
    if (reportedMappingIds.has(id)) return;
    reportedMappingIds.add(id);
    counters.mappingUnsupportedCount += 1;
    emit({
      code: 'input_mapping_unsupported',
      reason: 'mapping',
      message: 'gamepad mapping is not "standard"; the device is ignored (no remapping UI in M2)',
      deviceId: id,
    });
  };

  /** The active pad is gone (disconnect event, index reuse, or a missing poll entry). */
  const deviceLost = (index: number, reason: string): void => {
    tracked.delete(index);
    if (activeIndex !== index) return;
    const lostId = activeId;
    activeIndex = null;
    activeId = null;
    menu.clear('gamepad'); // disconnect clears that device's held menu state;
    // keyboard play is unaffected and nothing stays stuck (delivery.md §4.3)
    freshActivation();
    counters.disconnectCount += 1;
    emit({ code: 'input_disconnect', reason, deviceId: clipDeviceId(lostId ?? '') });
  };

  /**
   * Pick the active pad (input.md §4.4): the lowest-index connected
   * standard-mapped pad showing activity; the current pad stays active until
   * it is lost or a lower-index active pad appears. Reconciles index reuse.
   */
  const pickActiveGamepad = (list: ArrayLike<Gamepad | null>): Gamepad | null => {
    const standard: Gamepad[] = [];
    for (let i = 0; i < list.length; i += 1) {
      const gp = list[i];
      if (!gp || gp.connected === false) continue;
      if (gp.mapping !== 'standard') {
        reportMappingUnsupported(gp);
        continue;
      }
      const knownId = tracked.get(gp.index);
      if (knownId !== undefined && knownId !== gp.id) {
        // The browser reuses indexes (MDN): a different id at a known index
        // is a new device, so the old one is treated as lost.
        deviceLost(gp.index, 'index_reuse');
      }
      tracked.set(gp.index, gp.id);
      standard.push(gp);
    }

    if (activeIndex !== null) {
      const current = standard.find((gp) => gp.index === activeIndex) ?? null;
      if (!current) {
        deviceLost(activeIndex, 'disconnected');
      } else {
        const lower = standard.find((gp) => gp.index < (activeIndex ?? 0) && deviceHasActivity(gp));
        if (lower) {
          // A lower-index pad takes over. This is an active-pad change, so it
          // goes through the same fresh-activation transition as a disconnect:
          // a button already held on the new pad yields `held`, never
          // `pressed` (input.md §4.4/§5.4).
          freshActivation();
          activeIndex = lower.index;
          activeId = lower.id;
          return lower;
        }
        return current;
      }
    }

    const candidate = standard
      .filter((gp) => deviceHasActivity(gp))
      .sort((a, b) => a.index - b.index)[0];
    if (!candidate) return null;
    activeIndex = candidate.index;
    activeId = candidate.id;
    return candidate;
  };

  // --- listeners ------------------------------------------------------------

  const onKeyDown = (event: Event): void => {
    if (detached) return;
    const e = event as unknown as KeyboardEventLike;
    if (e.repeat === true) return; // auto-repeat never creates a latch (runtime.md §12.5.2)
    if (isEditableTarget(e.target)) return; // typing in the inspector must not move the character
    // The menu channel sees the fresh press BEFORE the gameplay mapping gate
    // (Enter/KeyM are not gameplay bindings — packet-38); the editable-target
    // and repeat gates above still apply (menu keys in a text field are inert).
    menu.keyboardDown(String(e.code ?? ''));
    if (!isMappedCode(e.code)) return;
    if (JUMP_CODES.has(e.code)) jumpLatch = true;
    held.add(e.code);
    if (typeof e.preventDefault === 'function') e.preventDefault();
  };

  const onKeyUp = (event: Event): void => {
    if (detached) return;
    const e = event as unknown as KeyboardEventLike;
    // Always release the menu channel, even for an unmapped or editable-
    // target key: otherwise a consumed confirm would stay needsRelease until
    // the next focus loss.
    menu.keyboardUp(String(e.code ?? ''));
    if (!isMappedCode(e.code)) return;
    // Always release the control, even when the up event lands on an editable
    // target: otherwise a key held before focus moved into a text field would
    // stay down forever.
    held.delete(e.code);
  };

  const onGamepadConnected = (event: Event): void => {
    if (detached) return;
    const e = event as unknown as GamepadEventLike;
    if (!e.gamepad) return;
    tracked.set(e.gamepad.index, e.gamepad.id);
  };

  const onGamepadDisconnected = (event: Event): void => {
    if (detached) return;
    const e = event as unknown as GamepadEventLike;
    if (!e.gamepad) return;
    deviceLost(e.gamepad.index, 'disconnected');
  };

  const onBlur = (): void => suspend('blur');
  const onFocus = (): void => activate('focus');
  const onPageHide = (): void => suspend('pagehide');

  const onVisibilityChange = (event: Event): void => {
    if (detached) return;
    const e = event as unknown as VisibilityEventLike;
    const source = (e.target ?? doc) as { visibilityState?: string } | null;
    const visibility = source?.visibilityState;
    if (visibility !== undefined && visibility !== 'visible') suspend('hidden');
    else if (visibility === 'visible') activate('visible');
  };

  const onFocusIn = (event: Event): void => {
    if (detached) return;
    const e = event as unknown as KeyboardEventLike;
    if (isEditableTarget(e.target)) suspend('editable');
    else activate('focusin');
  };

  const onFocusOut = (): void => suspend('focusout');

  const listeners: Array<{ target: EventTarget; type: string; handler: EventListener }> = [];
  const listen = (on: EventTarget | null | undefined, type: string, handler: EventListener): void => {
    if (!on || typeof on.addEventListener !== 'function') return;
    on.addEventListener(type, handler);
    listeners.push({ target: on, type, handler });
  };

  listen(target, 'keydown', onKeyDown);
  listen(target, 'keyup', onKeyUp);
  listen(target, 'focusin', onFocusIn);
  listen(target, 'focusout', onFocusOut);
  listen(win, 'keyup', onKeyUp);
  listen(win, 'blur', onBlur);
  listen(win, 'focus', onFocus);
  listen(win, 'pagehide', onPageHide);
  listen(win, 'gamepadconnected', onGamepadConnected);
  listen(win, 'gamepaddisconnected', onGamepadDisconnected);
  listen(doc, 'visibilitychange', onVisibilityChange);

  // --- availability (input.md §5.5) ----------------------------------------

  const insecure = win !== null && win.isSecureContext === false;
  if (!win && !doc && !nav && pollGamepads === null) {
    markUnavailable('environment', 'no browser window/navigator available; keyboard-only');
  } else if (pollGamepads === null) {
    markUnavailable('gamepad', 'navigator.getGamepads is unavailable; keyboard-only');
  } else if (insecure) {
    markUnavailable('gamepad', 'insecure context; the gamepad API is not exposed; keyboard-only');
  }
  // A blocked API must never pretend input works: while the context is
  // insecure the pad is not polled at all (keyboard stays operational).
  const gamepadEnabled = pollGamepads !== null && !insecure;

  // --- sampling -------------------------------------------------------------

  const anyHeld = (codes: ReadonlySet<string>): boolean => {
    for (const code of codes) if (held.has(code)) return true;
    return false;
  };

  const sample = (stepIndex: number): ActionFrame => {
    if (detached) return neutral(stepIndex);
    if (suspendPending) {
      suspendPending = false;
      return neutral(stepIndex);
    }

    let gamepad: NonNullable<RawInputSnapshot['gamepad']> | null = null;
    let keyboardJumpSuppressed = false;
    if (gamepadEnabled && pollGamepads) {
      try {
        const list = pollGamepads();
        const active = pickActiveGamepad(list);
        gamepad = active ? toSnapshot(active) : null;
      } catch (error) {
        markUnavailable('gamepad', `getGamepads failed: ${messageOf(error)}; keyboard-only`);
        gamepad = null;
      }
    }
    // The menu channel sees the primary button (a fresh press confirms; the
    // same button is the pad's M2 jump — §4.2 suppression below). A
    // disabled/blocked poll reads as released.
    menu.gamepadButton0(gamepad !== null && gamepad.button0);
    const suppressed = menu.suppress();
    if (suppressed.gamepad && gamepad !== null) {
      // A consumed confirm press still held: the SAME physical button must
      // not also drive the pad jump until it is released.
      gamepad = { ...gamepad, button0: false };
    }
    if (suppressed.keyboard) {
      // A consumed confirm press still held: the same physical key must not
      // contribute to the jump at all — the mapping derives the jump
      // down-transition from the HELD keyboard state, so the suppression
      // zeroes the held contribution, not just the owner's press latch
      // (delivery.md §4.2 fresh release).
      jumpLatch = false;
      keyboardJumpSuppressed = true;
    }

    const gamepadJumpDown = gamepad !== null && gamepad.button0;
    if (gamepadJumpDown && !prevGamepadJumpDown) jumpLatch = true;
    prevGamepadJumpDown = gamepadJumpDown;

    const snapshot: RawInputSnapshot = {
      keyboardLeft: anyHeld(LEFT_CODES),
      keyboardRight: anyHeld(RIGHT_CODES),
      keyboardJump: keyboardJumpSuppressed ? false : anyHeld(JUMP_CODES),
      jumpLatch,
      gamepad,
    };
    const { frame, next } = mapRawStep(snapshot, {
      stepIndex,
      previousJumpDown: state.down,
      jumpAwaitingRelease: state.awaitingRelease,
    });
    state = next;
    jumpLatch = false; // the latch is cleared after the sample, in the same call
    return frame;
  };

  const reset = (reason?: string): void => suspend(reason ?? 'reset');

  const diagnostics = (): {
    suspendCount: number;
    activateCount: number;
    disconnectCount: number;
    mappingUnsupportedCount: number;
  } => ({ ...counters });

  const detach = (): void => {
    if (detached) return;
    detached = true;
    for (const { target: on, type, handler } of listeners) {
      if (typeof on.removeEventListener === 'function') on.removeEventListener(type, handler);
    }
    listeners.length = 0;
    held.clear();
    jumpLatch = false;
    menu.clear('all');
    state = { down: false, awaitingRelease: false };
    prevGamepadJumpDown = false;
    activeIndex = null;
    activeId = null;
    tracked.clear();
    reportedMappingIds.clear();
  };

  return {
    sample,
    reset,
    diagnostics,
    /**
     * The bounded semantic menu channel (delivery.md §4.1): one plain-data
     * sample, latches cleared on read. Consumed by the game host, never by
     * the runtime ActionFrame.
     */
    sampleMenu(): MenuSample {
      return menu.sample();
    },
    /** The host consumed a confirm sample: the held press now needs a release. */
    markConfirmConsumed(): void {
      menu.consumeConfirm();
    },
    detach,
    dispose: detach,
    unavailable: () => (unavailableState ? { ...unavailableState } : null),
    get attached() {
      return !detached;
    },
  };
}
