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
import type { ActionFrame, ActionSource, InputStatusEntry } from '@thirdlight/runtime';
import { mapRawStep, quantizeMove, toActionFrame, type StepState } from './mapping';
import {
  createMenuController,
  type MenuSample,
} from './menu';
import { actionKeys, bindsPointerButton, bindsWheel, createActionEvaluator, cursorPresentation, DEFAULT_INPUT_CONFIG, characterKeys, characterPad, readCharacterPad, STANDARD_CHARACTER_PAD, type InputConfigLike, type CharacterPad, type RawPointerState } from './actions';
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

/** Phase 23.3: the pointer/wheel event surface the owner reads (real DOM events satisfy it). */
interface PointerEventLike {
  clientX?: unknown;
  clientY?: unknown;
  movementX?: unknown;
  movementY?: unknown;
  button?: unknown;
  buttons?: unknown;
  pointerType?: unknown;
  deltaY?: unknown;
  deltaMode?: unknown;
  preventDefault?: () => void;
}

/** Phase 23.3: DOM `button` (0 left, 1 middle, 2 right) → the frame's button bit (1 left, 2 right, 4 middle). */
function buttonBit(button: unknown): number {
  return button === 0 ? 1 : button === 2 ? 2 : button === 1 ? 4 : 0;
}

/** Phase 23.3: a wheel event's notches (pixel deltas: 100 px a notch — Chrome's line; lines: 3 a notch; pages: 1). */
function wheelNotches(deltaY: unknown, deltaMode: unknown): number {
  const d = typeof deltaY === 'number' && Number.isFinite(deltaY) ? deltaY : 0;
  return deltaMode === 1 ? d / 3 : deltaMode === 2 ? d : d / 100;
}

/** Phase 23.3: 1e-4 quantization (the frame's), negative zero normalized. */
function q4(v: number): number {
  const r = Math.round(v * 1e4) / 1e4;
  return r === 0 ? 0 : r;
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
  return { stepIndex };
}

/**
 * Make the game surface receive keyboard input: a canvas is not focusable by
 * default, so keys would never reach the keydown listener. Gives it a tab
 * stop, focuses it now and whenever it is clicked. Returns the release of
 * the click listener (phase 21.5: a page that composes the game again on the
 * same canvas — a new Play snapshot — must not pile up listeners).
 */
export function focusGameSurface(el: HTMLElement): () => void {
  if (el.tabIndex < 0) el.tabIndex = 0;
  el.style.outline = 'none';
  const onDown = (): void => el.focus();
  el.addEventListener('pointerdown', onDown);
  el.focus();
  return () => el.removeEventListener('pointerdown', onDown);
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

/** Phase 23.14: what a rebind listens to. */
export interface CaptureInputOptions {
  /** The devices (default all). */
  readonly devices?: readonly ('keyboard' | 'mouse' | 'gamepad')[];
  /** Keys that cancel (default Escape). */
  readonly cancelKeys?: readonly string[];
}

/** Phase 23.14: the input a rebind heard. */
export type CapturedInput =
  | { readonly device: 'keyboard'; readonly code: string }
  | { readonly device: 'mouse'; readonly button: 'left' | 'right' | 'middle' }
  | { readonly device: 'mouse'; readonly wheel: 1 | -1 }
  | { readonly device: 'gamepad'; readonly button: number }
  | { readonly device: 'gamepad'; readonly axis: number; readonly sign: 1 | -1 };

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
  /** Phase 15.5: the device the player used last (a key press, or a pad button/stick) — the HUD names its bindings. */
  activeDevice(): 'keyboard' | 'gamepad';
  /**
   * Phase 23.14: the device used last with the active gamepad's id (the
   * browser's `Gamepad.id`, clipped; null without an active pad) — glyphs
   * name the pad family from it.
   */
  activeDeviceInfo(): { device: 'keyboard' | 'gamepad'; gamepadId: string | null };
  /**
   * Phase 23.14: listen for the next input for a rebind — a key (not
   * auto-repeat), a mouse button or wheel notch over the view, a fresh pad
   * button press or a pad axis pushed past half way from where it rested —
   * from the devices asked for. A cancel key gives null. Returns a cancel
   * function (the host times the listening out).
   */
  captureInput(options: CaptureInputOptions, onInput: (input: CapturedInput | null) => void): () => void;
  /**
   * Phase 23.14: what the host adds to the next sampled frame (`ActionFrame.input`:
   * the device, the bindings, rebind outcomes) — called once per sample; null removes it.
   */
  setFrameInput(source: (() => InputStatusEntry | undefined) | null): void;
  /**
   * Phase 23.9a: only the actions of these maps feed the frame (null: every
   * map) — the host switches to a focused UI document's map. With the
   * gameplay map off the character controller's move and jump read neutral too; when it
   * comes back, a control still held must be released before it acts.
   */
  setActiveMaps(maps: readonly string[] | null): void;
  /**
   * Phase 23.3: the cursor the game wants now (the host resolves it every
   * frame from the input map and a script's request): locked → pointer lock
   * on the view (taken on the next click in the view when the browser wants
   * a gesture), free → released. The cursor is hidden while locked or while
   * a gamepad drives.
   */
  applyCursor(mode: 'free' | 'locked'): void;
  /** Phase 23.3: the cursor as it is (the mode asked for, whether the browser holds the lock, whether it is hidden). */
  cursorState(): { mode: 'free' | 'locked'; locked: boolean; hidden: boolean };
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

  // Phase 9.8: the character controller keys come from the project's move/jump actions
  // (phase 9.10: `configure` rebinds them at runtime).
  let LEFT_CODES = new Set<string>();
  let RIGHT_CODES = new Set<string>();
  let JUMP_CODES = new Set<string>();
  /** Phase 14.5: the pad buttons/axes of the character controller's move and jump (rebindable). */
  let PAD: CharacterPad = STANDARD_CHARACTER_PAD;
  let evaluator: ReturnType<typeof createActionEvaluator> | null = null;
  /** Phase 23.2: the project's `move` action is a 2D axis (a 3D character's move vector: the frame's moveX and moveY). */
  let MOVE_2D = false;
  /** Every key an action uses (held keys and taps between samples feed the evaluator). */
  let ACTION_CODES = new Set<string>();
  /** Phase 9.10: the ui actions' keys (menus). */
  let UI_KEYS: { up: Set<string>; down: Set<string>; left: Set<string>; right: Set<string>; submit: Set<string>; cancel: Set<string>; pause: Set<string> } = uiKeys(DEFAULT_INPUT_CONFIG);
  /** Phase 23.3: the view keeps its context menu / the page scroll from the right button / wheel when an action binds them. */
  let SUPPRESS_CONTEXT_MENU = false;
  let SUPPRESS_WHEEL = false;
  const applyConfig = (cfg: InputConfigLike | undefined): void => {
    SUPPRESS_CONTEXT_MENU = cfg !== undefined && bindsPointerButton(cfg, 'right');
    SUPPRESS_WHEEL = cfg !== undefined && bindsWheel(cfg);
    const keyMap = cfg !== undefined ? characterKeys(cfg) : DEFAULT_KEYBOARD_MAP;
    LEFT_CODES = new Set(keyMap.left);
    RIGHT_CODES = new Set(keyMap.right);
    JUMP_CODES = new Set(keyMap.jump);
    PAD = cfg !== undefined ? characterPad(cfg) : STANDARD_CHARACTER_PAD;
    evaluator = cfg !== undefined ? createActionEvaluator(cfg) : null;
    ACTION_CODES = new Set(cfg?.actions.flatMap(actionKeys) ?? []);
    UI_KEYS = uiKeys(cfg ?? DEFAULT_INPUT_CONFIG);
    MOVE_2D = cfg?.actions.some((a) => a.name === 'move' && a.type === 'axis2d') === true;
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
  /** Phase 15.5: the device used last (keyboard until a pad button or stick moves). */
  let lastDevice: 'keyboard' | 'gamepad' = 'keyboard';
  /** Phase 23.14: the id of the pad used last (null: none yet). */
  let lastPadId: string | null = null;
  /** Phase 23.14: a rebind listening for input, and the pad's buttons/axes when it started (a press is a change from there). */
  type Capture = { devices: ReadonlySet<string>; cancel: ReadonlySet<string>; cb: (input: CapturedInput | null) => void; buttons: boolean[] | null; axes: number[] | null };
  let inputCapture: Capture | null = null;
  /** Phase 23.14: the host's frame entry source. */
  let frameInput: (() => InputStatusEntry | undefined) | null = null;
  const clock: () => number = options.now ?? (() => (typeof performance !== 'undefined' && typeof performance.now === 'function' ? performance.now() : Date.now()));
  const finishCapture = (input: CapturedInput | null): void => {
    const c = inputCapture;
    inputCapture = null;
    c?.cb(input);
  };
  /** Phase 23.9a: the active action maps (null: all). */
  let activeMaps: ReadonlySet<string> | null = null;
  const actionActive = (a: { map: string }): boolean => activeMaps === null || activeMaps.has(a.map);

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
    // Phase 23.3: held pointer buttons are let go (the next sample reports their release) and pending movement dropped.
    pointerButtons = 0;
    pointerPressed = 0;
    pointerDx = 0;
    pointerDy = 0;
    pointerWheel = 0;
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
   * The pad reduced to the snapshot through the character controller's pad bindings
   * (phase 14.5: `button0` is the mapped jump, `button14`/`button15` the
   * mapped left/right buttons, `axis0` the mapped stick — the standard
   * layout unless rebound). `ignore`: buttons that must not count (a
   * consumed menu confirm still held).
   */
  const padButtons = (gp: Gamepad): boolean[] => Array.from(gp.buttons, (b) => b?.pressed === true);
  const padAxes = (gp: Gamepad): number[] => Array.from(gp.axes, (a) => (typeof a === 'number' && Number.isFinite(a) ? a : 0));
  const toSnapshot = (gp: Gamepad, ignore?: ReadonlySet<number>): NonNullable<RawInputSnapshot['gamepad']> => {
    const r = readCharacterPad(PAD, padButtons(gp), padAxes(gp), ignore);
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

  /** Phase 23.14: the pad part of a rebind: a fresh button press or an axis pushed past half way from its rest. */
  const pollCapture = (pads: ArrayLike<Gamepad | null> | null): void => {
    const c = inputCapture;
    if (c === null || !c.devices.has('gamepad') || pads === null) return;
    const pad = Array.from(pads).find((g) => g !== null && g.mapping === 'standard') ?? null;
    if (pad === null) return;
    const buttons = padButtons(pad);
    const axes = padAxes(pad);
    if (c.buttons === null || c.axes === null) {
      c.buttons = buttons;
      c.axes = axes;
      return;
    }
    const hit = buttons.findIndex((d, i) => d && c.buttons![i] !== true);
    if (hit >= 0 && hit <= 31) {
      lastDevice = 'gamepad';
      lastPadId = clipDeviceId(pad.id);
      finishCapture({ device: 'gamepad', button: hit });
      return;
    }
    for (let i = 0; i < axes.length && i <= 7; i += 1) {
      const d = axes[i]! - (c.axes[i] ?? 0);
      if (Math.abs(d) > 0.5 && Math.abs(axes[i]!) > 0.5) {
        lastDevice = 'gamepad';
        lastPadId = clipDeviceId(pad.id);
        finishCapture({ device: 'gamepad', axis: i, sign: axes[i]! > 0 ? 1 : -1 });
        return;
      }
    }
    // A button let go is ready to be pressed again.
    c.buttons = c.buttons.map((b, i) => b && buttons[i] === true);
  };

  const deviceHasActivity = (gp: Gamepad): boolean => {
    const r = readCharacterPad(PAD, padButtons(gp), padAxes(gp));
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
    lastDevice = 'keyboard';
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
    if (inputCapture !== null && e.repeat !== true && (inputCapture.devices.has('keyboard') || inputCapture.cancel.has(code))) {
      // Phase 23.14: a rebind takes this key (nothing else sees it); a cancel key gives null.
      if (typeof e.preventDefault === 'function') e.preventDefault();
      finishCapture(inputCapture.cancel.has(code) ? null : { device: 'keyboard', code });
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

  // --- phase 23.3: the pointer ----------------------------------------------

  /** Seen once (a pointer event over the view): from then on every sample carries the pointer. */
  let pointerSeen = false;
  let pointerX = 0.5;
  let pointerY = 0.5;
  let pointerOver = false;
  let pointerButtons = 0;
  let pointerPressed = 0;
  let pointerReleased = 0;
  let pointerDx = 0;
  let pointerDy = 0;
  let pointerWheel = 0;
  let cursorMode: 'free' | 'locked' = 'free';
  let cursorHidden = false;
  const targetEl = target as (EventTarget & { getBoundingClientRect?: () => { left: number; top: number; width: number; height: number }; requestPointerLock?: () => unknown; style?: { cursor?: string }; setAttribute?: (k: string, v: string) => void }) | null;
  const rectOf = (): { left: number; top: number; width: number; height: number } | null => {
    try {
      const r = targetEl?.getBoundingClientRect?.();
      return r !== undefined && r.width > 0 && r.height > 0 ? r : null;
    } catch {
      return null;
    }
  };
  const isLocked = (): boolean => doc !== null && (doc as { pointerLockElement?: unknown }).pointerLockElement === target && target !== null;
  const finiteOr0 = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
  const movePointer = (e: PointerEventLike): void => {
    const r = rectOf();
    if (r === null) return;
    if (isLocked()) {
      // Locked: the position stays at the centre; only the movement counts.
      pointerDx += finiteOr0(e.movementX) / r.width;
      pointerDy += finiteOr0(e.movementY) / r.height;
      pointerX = 0.5;
      pointerY = 0.5;
    } else {
      const x = Math.min(1, Math.max(0, (finiteOr0(e.clientX) - r.left) / r.width));
      const y = Math.min(1, Math.max(0, (finiteOr0(e.clientY) - r.top) / r.height));
      if (pointerSeen) {
        pointerDx += x - pointerX;
        pointerDy += y - pointerY;
      }
      pointerX = x;
      pointerY = y;
    }
    pointerSeen = true;
  };
  const onPointerMove = (event: Event): void => {
    if (detached) return;
    const e = event as unknown as PointerEventLike;
    movePointer(e);
    pointerOver = true;
    if (e.pointerType !== 'touch') lastDevice = 'keyboard'; // keyboard and mouse are one device for the HUD
  };
  const onPointerDown = (event: Event): void => {
    if (detached) return;
    const e = event as unknown as PointerEventLike;
    movePointer(e);
    pointerOver = true;
    lastDevice = 'keyboard';
    if (inputCapture !== null && inputCapture.devices.has('mouse') && buttonBit(e.button) !== 0) {
      // Phase 23.14: a rebind takes this mouse button.
      finishCapture({ device: 'mouse', button: e.button === 0 ? 'left' : e.button === 2 ? 'right' : 'middle' });
      if (typeof e.preventDefault === 'function') e.preventDefault();
      return;
    }
    const bit = buttonBit(e.button);
    if (bit !== 0 && (pointerButtons & bit) === 0) {
      pointerButtons |= bit;
      pointerPressed |= bit;
    }
    // Locked mode waits for a click in the view when the browser needs a gesture for the lock.
    if (cursorMode === 'locked' && !isLocked()) requestLock();
  };
  const onPointerUp = (event: Event): void => {
    if (detached) return;
    const e = event as unknown as PointerEventLike;
    const bit = buttonBit(e.button);
    if (bit !== 0 && (pointerButtons & bit) !== 0) {
      pointerButtons &= ~bit;
      pointerReleased |= bit;
    }
  };
  const onPointerEnter = (event: Event): void => {
    if (detached) return;
    movePointer(event as unknown as PointerEventLike);
    pointerOver = true;
  };
  const onPointerLeave = (): void => {
    if (detached || isLocked()) return;
    pointerOver = false;
  };
  const onWheel = (event: Event): void => {
    if (detached) return;
    const e = event as unknown as PointerEventLike;
    if (inputCapture !== null && inputCapture.devices.has('mouse')) {
      const n = wheelNotches(e.deltaY, e.deltaMode);
      if (n !== 0) {
        // Phase 23.14: a rebind takes the wheel (positive towards the user).
        finishCapture({ device: 'mouse', wheel: n > 0 ? 1 : -1 });
        if (typeof e.preventDefault === 'function') e.preventDefault();
        return;
      }
    }
    pointerWheel += wheelNotches(e.deltaY, e.deltaMode);
    pointerSeen = true;
    if (SUPPRESS_WHEEL && typeof e.preventDefault === 'function') e.preventDefault();
  };
  const onContextMenu = (event: Event): void => {
    if (detached || !SUPPRESS_CONTEXT_MENU) return;
    const e = event as unknown as PointerEventLike;
    if (typeof e.preventDefault === 'function') e.preventDefault();
  };
  const requestLock = (): void => {
    try {
      const r = targetEl?.requestPointerLock?.() as { catch?: (f: () => void) => void } | undefined;
      // The promise form rejects without a user gesture; the next click in the view asks again.
      if (r !== undefined && r !== null && typeof r.catch === 'function') r.catch(() => undefined);
    } catch {
      // an environment without pointer lock keeps the cursor free (the mode is still reported)
    }
  };
  const releaseLock = (): void => {
    try {
      if (isLocked()) (doc as { exitPointerLock?: () => void } | null)?.exitPointerLock?.();
    } catch {
      /* nothing to release */
    }
  };
  const onPointerLockChange = (): void => {
    if (detached) return;
    if (isLocked()) {
      pointerX = 0.5;
      pointerY = 0.5;
      pointerOver = true;
      pointerSeen = true;
    }
    presentCursor();
  };
  /** Hide or show the cursor over the view and report the state on the element (tests, the observation). */
  const presentCursor = (): void => {
    const pres = cursorPresentation(cursorMode, lastDevice);
    const hide = pres.hide;
    if (targetEl?.style !== undefined && hide !== cursorHidden) targetEl.style.cursor = hide ? 'none' : '';
    cursorHidden = hide;
    const lock = isLocked() ? 'on' : 'off';
    const shown = `${cursorMode}|${lock}|${hide}`;
    if (shown === cursorShown) return;
    cursorShown = shown;
    try {
      targetEl?.setAttribute?.('data-tl-cursor', cursorMode);
      targetEl?.setAttribute?.('data-tl-pointer-lock', lock);
      targetEl?.setAttribute?.('data-tl-cursor-hidden', hide ? 'true' : 'false');
    } catch {
      /* a fake target without attributes */
    }
  };
  let cursorShown = '';
  /** The pointer part of one sample (null before the pointer is first seen); the accumulators are cleared. */
  const takePointer = (): RawPointerState | null => {
    if (!pointerSeen) return null;
    const out: RawPointerState = { x: pointerX, y: pointerY, dx: pointerDx, dy: pointerDy, wheel: pointerWheel, buttons: pointerButtons, pressed: pointerPressed };
    return out;
  };
  const clearPointerEdges = (): void => {
    pointerDx = 0;
    pointerDy = 0;
    pointerWheel = 0;
    pointerPressed = 0;
    pointerReleased = 0;
  };
  const clamp10 = (v: number): number => (v > 10 ? 10 : v < -10 ? -10 : v);
  /** The frame's pointer sample (quantized; only the non-zero movement, wheel and edges). */
  const pointerSample = (): NonNullable<ActionFrame['pointer']> | null => {
    if (!pointerSeen) return null;
    const locked = isLocked();
    const dx = q4(clamp10(pointerDx));
    const dy = q4(clamp10(pointerDy));
    const wheel = q4(clamp10(pointerWheel));
    return {
      x: q4(locked ? 0.5 : pointerX),
      y: q4(locked ? 0.5 : pointerY),
      ...(dx !== 0 ? { dx } : {}),
      ...(dy !== 0 ? { dy } : {}),
      ...(wheel !== 0 ? { wheel } : {}),
      ...(pointerButtons !== 0 ? { buttons: pointerButtons } : {}),
      ...(pointerPressed !== 0 ? { pressed: pointerPressed } : {}),
      ...(pointerReleased !== 0 ? { released: pointerReleased } : {}),
      ...(!pointerOver && !locked ? { over: false } : {}),
      ...(locked ? { locked: true } : {}),
    };
  };

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
  // Phase 23.3: the pointer over the view (a release outside it still counts), the wheel, pointer lock.
  listen(target, 'pointermove', onPointerMove);
  listen(target, 'pointerdown', onPointerDown);
  listen(win, 'pointerup', onPointerUp);
  listen(win, 'pointercancel', onPointerUp);
  listen(target, 'pointerenter', onPointerEnter);
  listen(target, 'pointerleave', onPointerLeave);
  listen(target, 'wheel', onWheel);
  listen(target, 'contextmenu', onContextMenu);
  listen(doc, 'pointerlockchange', onPointerLockChange);

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

  /** Phase 23.14: the frame with the host's input entry (device, bindings, rebind outcomes) when it has one. */
  const sample = (stepIndex: number): ActionFrame => {
    const frame = sampleDevices(stepIndex);
    const extra = frameInput?.();
    return extra === undefined ? frame : { ...frame, input: extra };
  };

  const sampleDevices = (stepIndex: number): ActionFrame => {
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
        pollCapture(list);
        active = pickActiveGamepad(list);
        lastPad = active ? { buttons: padButtons(active), axes: padAxes(active) } : null;
        if (active !== null && (active.buttons.some((b) => b?.pressed === true) || active.axes.some((v) => Math.abs(v ?? 0) > 0.5))) {
          lastDevice = 'gamepad';
          lastPadId = clipDeviceId(active.id);
        }
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

    // Phase 23.9a: the gameplay map switched off (a focused UI document): move and jump read neutral.
    const gameplayOn = activeMaps === null || activeMaps.has('gameplay');
    const snapshot: RawInputSnapshot = gameplayOn
      ? {
          keyboardLeft: anyHeld(LEFT_CODES),
          keyboardRight: anyHeld(RIGHT_CODES),
          keyboardJump: keyboardJumpSuppressed ? false : anyHeld(JUMP_CODES),
          jumpLatch,
          gamepad,
        }
      : { keyboardLeft: false, keyboardRight: false, keyboardJump: false, jumpLatch: false, gamepad: null };
    const { frame, next } = mapRawStep(snapshot, {
      stepIndex,
      previousJumpDown: state.down,
      jumpAwaitingRelease: state.awaitingRelease,
    });
    state = next;
    jumpLatch = false; // the latch is cleared after the sample, in the same call
    // Phase 23.3: the pointer (once seen) rides in every frame; the cursor follows the last device.
    const pointer = pointerSample();
    const rawPointer = takePointer();
    presentCursor();
    // Phase 24.8: the mapped controls are the frame's `move` and `jump` actions (frame version 2).
    if (evaluator === null) {
      clearPointerEdges();
      return toActionFrame(frame, pointer === null ? {} : { pointer });
    }
    const actions = evaluator.sample({ keys: actionHeld, pressedKeys: actionPressed, gamepad: gamepadEnabled ? lastPad : null, pointer: rawPointer, now: clock() }, activeMaps === null ? undefined : actionActive);
    actionPressed.clear();
    clearPointerEdges();
    // Phase 23.2: a 2D `move` action gives the move vector (x right, y forward/up); a 1D one keeps the M2 mapping exactly.
    const move = MOVE_2D ? actions['move'] : undefined;
    if (move !== undefined) return toActionFrame({ ...frame, moveX: quantizeMove(move.x ?? 0), moveY: quantizeMove(move.y ?? 0) }, { actions, ...(pointer !== null ? { pointer } : {}) });
    return toActionFrame(frame, { actions, ...(pointer !== null ? { pointer } : {}) });
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
    // Phase 23.3: give the cursor back.
    releaseLock();
    if (targetEl?.style !== undefined && cursorHidden) targetEl.style.cursor = '';
    cursorHidden = false;
    pointerSeen = false;
    pointerButtons = 0;
    clearPointerEdges();
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
    activeDevice(): 'keyboard' | 'gamepad' {
      return lastDevice;
    },
    activeDeviceInfo(): { device: 'keyboard' | 'gamepad'; gamepadId: string | null } {
      return { device: lastDevice, gamepadId: lastPadId };
    },
    captureInput(opts: CaptureInputOptions, onInput: (input: CapturedInput | null) => void): () => void {
      const prev = inputCapture;
      inputCapture = null;
      prev?.cb(null);
      const devices = new Set<string>(opts.devices ?? ['keyboard', 'mouse', 'gamepad']);
      const cancel = new Set<string>(opts.cancelKeys ?? ['Escape']);
      const entry: Capture = { devices, cancel, cb: onInput, buttons: null, axes: null };
      inputCapture = entry;
      if (devices.has('gamepad') && gamepadEnabled && pollGamepads && !detached) {
        try {
          const pad = Array.from(pollGamepads()).find((g) => g !== null && g.mapping === 'standard') ?? null;
          if (pad !== null) {
            entry.buttons = padButtons(pad);
            entry.axes = padAxes(pad);
          }
        } catch {
          /* a failed poll: the next poll takes the rest state */
        }
      }
      return () => {
        if (inputCapture === entry) inputCapture = null;
      };
    },
    setFrameInput(source: (() => InputStatusEntry | undefined) | null): void {
      frameInput = source;
    },
    applyCursor(mode: 'free' | 'locked'): void {
      if (detached) return;
      const next = mode === 'locked' ? 'locked' : 'free';
      if (next !== cursorMode) {
        cursorMode = next;
        if (next === 'locked') requestLock();
        else releaseLock();
      }
      presentCursor();
    },
    cursorState(): { mode: 'free' | 'locked'; locked: boolean; hidden: boolean } {
      return { mode: cursorMode, locked: isLocked(), hidden: cursorHidden };
    },
    /** The host consumed a confirm sample: the held press now needs a release. */
    markConfirmConsumed(): void {
      menu.consumeConfirm();
    },
    sampleUi(): UiSample {
      if (gamepadEnabled && pollGamepads && !detached) {
        try {
          const list = pollGamepads();
          const pad = Array.from(list).find((g) => g !== null && g.mapping === 'standard') ?? null;
          const now = pad === null ? [] : Array.from(pad.buttons, (b) => b?.pressed === true);
          // Phase 23.14: the pad counts as the device used last while a menu is open too; a rebind listens.
          if (pad !== null && (now.some((d) => d) || Array.from(pad.axes).some((v) => Math.abs(v ?? 0) > 0.5))) {
            lastDevice = 'gamepad';
            lastPadId = clipDeviceId(pad.id);
          }
          if (inputCapture !== null) {
            pollCapture(list);
            // What is held now waits for its release before the menus see it.
            const ax = pad === null ? [0, 0] : [pad.axes[0] ?? 0, pad.axes[1] ?? 0];
            prevUiPad = [now[12] === true || ax[1]! < -0.6, now[13] === true || ax[1]! > 0.6, now[14] === true || ax[0]! < -0.6, now[15] === true || ax[0]! > 0.6, now[0] === true, now[1] === true, now[9] === true];
            return { up: false, down: false, left: false, right: false, submit: false, cancel: false, pause: false };
          }
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
    setActiveMaps(maps: readonly string[] | null): void {
      const next = maps === null ? null : new Set(maps);
      const wasGameplay = activeMaps === null || activeMaps.has('gameplay');
      activeMaps = next;
      const isGameplay = next === null || next.has('gameplay');
      // Back to gameplay: a key or button still held from the menu must be released before it moves or jumps.
      if (!wasGameplay && isGameplay) {
        freshActivation();
        evaluator?.holdUntilReleased();
      }
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
