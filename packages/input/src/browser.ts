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
import { actionKeys, createActionEvaluator, DEFAULT_INPUT_CONFIG, platformerKeys, platformerPad, readPlatformerPad, STANDARD_PLATFORMER_PAD, type InputConfigLike, type PlatformerPad } from './actions';
import {
  DEFAULT_KEYBOARD_MAP,
  GAMEPAD_DEAD_ZONE,
  type InputBindingOptions,
  type RawInputSnapshot,
} from './types';

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
/** Phase 9.10: one frame's menu edges. */
export interface UiSample {
  up: boolean;
  down: boolean;
  left: boolean;
  right: boolean;
  submit: boolean;
  cancel: boolean;
  pause: boolean;
}

/** Phase 9.10: the keys of the `ui` actions (navigate's composites give the directions). */
function uiKeys(cfg: InputConfigLike): { up: Set<string>; down: Set<string>; left: Set<string>; right: Set<string>; submit: Set<string>; cancel: Set<string>; pause: Set<string> } {
  const out = { up: new Set<string>(), down: new Set<string>(), left: new Set<string>(), right: new Set<string>(), submit: new Set<string>(), cancel: new Set<string>(), pause: new Set<string>() };
  for (const a of cfg.actions) {
    for (const b of a.bindings as readonly { kind: string; code?: string; up?: string; down?: string; left?: string; right?: string; negative?: string; positive?: string }[]) {
      if (a.name === 'navigate') {
        if (b.kind === 'keys2d') {
          out.up.add(b.up!);
          out.down.add(b.down!);
          out.left.add(b.left!);
          out.right.add(b.right!);
        } else if (b.kind === 'keys1d') {
          out.left.add(b.negative!);
          out.right.add(b.positive!);
        }
      } else if ((a.name === 'submit' || a.name === 'cancel' || a.name === 'pause') && b.kind === 'key') {
        out[a.name as 'submit' | 'cancel' | 'pause'].add(b.code!);
      }
    }
  }
  return out;
}

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
  /** Phase 9.10: the next menu edge (the `ui` actions' keys, pad D-pad/stick/A/B/Start), one per call in arrival order. */
  sampleUi(): UiSample;
  /** Phase 9.10: rebind at runtime (a player's settings); held state is cleared. */
  configure(inputConfig: InputConfigLike): void;
  /** Phase 9.10: hand the next key press to `onKey` (Escape gives null); returns a cancel function. */
  captureKey(onKey: (code: string | null) => void): () => void;
  /**
   * Phase 14.5: hand the next pad button pressed (a fresh press — a button
   * already held when the capture starts must be released first) to
   * `onButton`; the Escape key gives null. Polled by `sampleUi` (the host
   * calls it every frame).
   * Returns a cancel function.
   */
  capturePadButton(onButton: (button: number | null) => void): () => void;
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

  // Phase 9.8: the platformer keys come from the project's move/jump actions
  // (phase 9.10: `configure` rebinds them at runtime).
  let LEFT_CODES = new Set<string>();
  let RIGHT_CODES = new Set<string>();
  let JUMP_CODES = new Set<string>();
  /** Phase 14.5: the pad buttons/axes of the platformer's move and jump (rebindable). */
  let PAD: PlatformerPad = STANDARD_PLATFORMER_PAD;
  let evaluator: ReturnType<typeof createActionEvaluator> | null = null;
  /** Every key an action uses (held keys and taps between samples feed the evaluator). */
  let ACTION_CODES = new Set<string>();
  /** Phase 9.10: the ui actions' keys (menus). */
  let UI_KEYS: { up: Set<string>; down: Set<string>; left: Set<string>; right: Set<string>; submit: Set<string>; cancel: Set<string>; pause: Set<string> } = uiKeys(DEFAULT_INPUT_CONFIG);
  const applyConfig = (cfg: InputConfigLike | undefined): void => {
    const keyMap = cfg !== undefined ? platformerKeys(cfg) : DEFAULT_KEYBOARD_MAP;
    LEFT_CODES = new Set(keyMap.left);
    RIGHT_CODES = new Set(keyMap.right);
    JUMP_CODES = new Set(keyMap.jump);
    PAD = cfg !== undefined ? platformerPad(cfg) : STANDARD_PLATFORMER_PAD;
    evaluator = cfg !== undefined ? createActionEvaluator(cfg) : null;
    ACTION_CODES = new Set(cfg?.actions.flatMap(actionKeys) ?? []);
    UI_KEYS = uiKeys(cfg ?? DEFAULT_INPUT_CONFIG);
  };
  applyConfig(options.inputConfig);
  /** Menu edges in arrival order; `sampleUi` hands out one per call (fast key bursts keep their order). */
  const uiQueue: (keyof UiSample)[] = [];
  const pushUi = (k: keyof UiSample): void => {
    if (uiQueue.length < 16) uiQueue.push(k);
  };
  let prevUiPad: boolean[] = [];
  let capture: ((code: string | null) => void) | null = null;
  let padCapture: ((button: number | null) => void) | null = null;
  /** The buttons held when the pad capture last looked (a press is a fresh down edge). */
  let padCaptureBase: boolean[] | null = null;
  const actionHeld = new Set<string>();
  const actionPressed = new Set<string>();
  const isMappedCode = (code: unknown): code is string =>
    typeof code === 'string' && (LEFT_CODES.has(code) || RIGHT_CODES.has(code) || JUMP_CODES.has(code));
  let lastPad: { buttons: boolean[]; axes: number[] } | null = null;

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
    actionHeld.clear();
    actionPressed.clear();
    evaluator?.reset();
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

  /**
   * The pad reduced to the snapshot through the platformer's pad bindings
   * (phase 14.5: `button0` is the mapped jump, `button14`/`button15` the
   * mapped left/right buttons, `axis0` the mapped stick — the standard
   * layout unless rebound). `ignore`: buttons that must not count (a
   * consumed menu confirm still held).
   */
  const padButtons = (gp: Gamepad): boolean[] => Array.from(gp.buttons, (b) => b?.pressed === true);
  const padAxes = (gp: Gamepad): number[] => Array.from(gp.axes, (a) => (typeof a === 'number' && Number.isFinite(a) ? a : 0));
  const toSnapshot = (gp: Gamepad, ignore?: ReadonlySet<number>): NonNullable<RawInputSnapshot['gamepad']> => {
    const r = readPlatformerPad(PAD, padButtons(gp), padAxes(gp), ignore);
    return {
      index: gp.index,
      id: clipDeviceId(gp.id),
      mapping: typeof gp.mapping === 'string' ? gp.mapping : '',
      axis0: r.axis,
      button0: r.jump,
      button14: r.left,
      button15: r.right,
    };
  };

  const deviceHasActivity = (gp: Gamepad): boolean => {
    const r = readPlatformerPad(PAD, padButtons(gp), padAxes(gp));
    if (Math.abs(r.axis) > GAMEPAD_DEAD_ZONE) return true;
    // The menu confirm (button 0) wakes a pad too, whatever jump is bound to.
    return r.jump || r.left || r.right || gp.buttons[0]?.pressed === true;
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
    if (isEditableTarget(e.target)) return; // typing in the inspector must not move the character
    const code = String(e.code ?? '');
    if (padCapture !== null && code === 'Escape' && e.repeat !== true) {
      // Phase 14.5: Escape cancels a pad rebinding.
      const cb = padCapture;
      padCapture = null;
      padCaptureBase = null;
      if (typeof e.preventDefault === 'function') e.preventDefault();
      cb(null);
      return;
    }
    if (capture !== null && e.repeat !== true) {
      // Phase 9.10: a rebinding screen takes this key (nothing else sees it).
      const cb = capture;
      capture = null;
      if (typeof e.preventDefault === 'function') e.preventDefault();
      cb(code === 'Escape' ? null : code);
      return;
    }
    // Phase 9.10: menu edges (navigation repeats while held).
    if (UI_KEYS.up.has(code)) pushUi('up');
    if (UI_KEYS.down.has(code)) pushUi('down');
    if (UI_KEYS.left.has(code)) pushUi('left');
    if (UI_KEYS.right.has(code)) pushUi('right');
    if (e.repeat === true) return; // auto-repeat never creates a latch (runtime.md §12.5.2)
    if (UI_KEYS.submit.has(code)) pushUi('submit');
    if (UI_KEYS.cancel.has(code)) pushUi('cancel');
    if (UI_KEYS.pause.has(code)) {
      pushUi('pause');
      if (typeof e.preventDefault === 'function') e.preventDefault();
    }
    // The menu channel sees the fresh press BEFORE the gameplay mapping gate
    // (Enter/KeyM are not gameplay bindings — packet-38); the editable-target
    // and repeat gates above still apply (menu keys in a text field are inert).
    menu.keyboardDown(String(e.code ?? ''));
    if (typeof e.code === 'string' && ACTION_CODES.has(e.code)) {
      actionHeld.add(e.code);
      actionPressed.add(e.code);
      if (!isMappedCode(e.code) && typeof e.preventDefault === 'function') e.preventDefault();
    }
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
    if (typeof e.code === 'string') actionHeld.delete(e.code);
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
    let active: Gamepad | null = null;
    if (gamepadEnabled && pollGamepads) {
      try {
        const list = pollGamepads();
        active = pickActiveGamepad(list);
        lastPad = active ? { buttons: padButtons(active), axes: padAxes(active) } : null;
      } catch (error) {
        markUnavailable('gamepad', `getGamepads failed: ${messageOf(error)}; keyboard-only`);
        active = null;
      }
    }
    // The menu channel sees the primary button (a fresh press confirms; the
    // same button is the pad's M2 jump unless rebound — §4.2 suppression
    // below). A disabled/blocked poll reads as released.
    menu.gamepadButton0(active !== null && active.buttons[0]?.pressed === true);
    const suppressed = menu.suppress();
    // A consumed confirm press still held: the SAME physical button must
    // not also drive the pad jump until it is released (phase 14.5: only
    // when button 0 is one of the jump buttons; a rebound jump is another button).
    gamepad = active !== null ? toSnapshot(active, suppressed.gamepad ? new Set([0]) : undefined) : null;
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
    if (evaluator === null) return frame;
    const actions = evaluator.sample({ keys: actionHeld, pressedKeys: actionPressed, gamepad: gamepadEnabled ? lastPad : null });
    actionPressed.clear();
    return { ...frame, actions };
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
    actionHeld.clear();
    actionPressed.clear();
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
    sampleUi(): UiSample {
      if (gamepadEnabled && pollGamepads && !detached) {
        try {
          const pad = Array.from(pollGamepads()).find((g) => g !== null && g.mapping === 'standard') ?? null;
          const now = pad === null ? [] : Array.from(pad.buttons, (b) => b?.pressed === true);
          if (padCapture !== null) {
            // Phase 14.5: a pad rebinding takes the next fresh button press
            // (nothing else sees the pad meanwhile).
            const base = padCaptureBase ?? now;
            const hit = now.findIndex((d, i) => d && base[i] !== true);
            padCaptureBase = now;
            prevUiPad = [];
            if (hit >= 0 && hit <= 31) {
              const cb = padCapture;
              padCapture = null;
              padCaptureBase = null;
              // The chosen button is still down: the menus wait for its release.
              prevUiPad = [now[12] === true, now[13] === true, now[14] === true, now[15] === true, now[0] === true, now[1] === true, now[9] === true];
              cb(hit);
            }
            return { up: false, down: false, left: false, right: false, submit: false, cancel: false, pause: false };
          }
          const ax = pad === null ? [0, 0] : [pad.axes[0] ?? 0, pad.axes[1] ?? 0];
          const dirs = [ax[1]! < -0.6, ax[1]! > 0.6, ax[0]! < -0.6, ax[0]! > 0.6];
          const cur = [now[12] === true || dirs[0]!, now[13] === true || dirs[1]!, now[14] === true || dirs[2]!, now[15] === true || dirs[3]!, now[0] === true, now[1] === true, now[9] === true];
          const edge = (i: number): boolean => cur[i] === true && prevUiPad[i] !== true;
          (['up', 'down', 'left', 'right', 'submit', 'cancel', 'pause'] as const).forEach((k, i) => {
            if (edge(i)) pushUi(k);
          });
          prevUiPad = cur;
        } catch {
          // a failed poll reads as no pad
        }
      }
      const out: UiSample = { up: false, down: false, left: false, right: false, submit: false, cancel: false, pause: false };
      const next = uiQueue.shift();
      if (next !== undefined) out[next] = true;
      return out;
    },
    configure(inputConfig: InputConfigLike): void {
      applyConfig(inputConfig);
      held.clear();
      actionHeld.clear();
      actionPressed.clear();
      freshActivation();
    },
    capturePadButton(onButton: (button: number | null) => void): () => void {
      padCapture = onButton;
      padCaptureBase = null;
      if (gamepadEnabled && pollGamepads && !detached) {
        try {
          const pad = Array.from(pollGamepads()).find((g) => g !== null && g.mapping === 'standard') ?? null;
          padCaptureBase = pad === null ? [] : Array.from(pad.buttons, (b) => b?.pressed === true);
        } catch {
          padCaptureBase = [];
        }
      }
      return () => {
        if (padCapture === onButton) {
          padCapture = null;
          padCaptureBase = null;
        }
      };
    },
    captureKey(onKey: (code: string | null) => void): () => void {
      capture = onKey;
      return () => {
        if (capture === onKey) capture = null;
      };
    },
    detach,
    dispose: detach,
    unavailable: () => (unavailableState ? { ...unavailableState } : null),
    get attached() {
      return !detached;
    },
  };
}
