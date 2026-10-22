/**
 * The single explicit browser listener owner.
 *
 * This is the **only** module in `@thirdlight/input` that resolves `window`,
 * `document` or `navigator`; its parts (`browser-pointer`, `browser-pads`,
 * `browser-rebind`, `browser-ui`, `browser-keys`,
 * `browser-status`) get what it resolved passed in. It owns
 * every listener it installs,
 * reduces raw events and `Navigator.getGamepads()` to plain
 * `RawInputSnapshot` values, and delegates all mapping to the pure
 * `mapRawStep`. It never throws into the caller and never pretends the
 * gamepad API works: a blocked/insecure/absent API degrades to keyboard-only
 * with a structured `input_unavailable` diagnostic.
 *
 * Failure handling covered here:
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
import { actionKeys, bindsPointerButton, bindsWheel, createActionEvaluator, DEFAULT_INPUT_CONFIG, characterKeys, characterPad, STANDARD_CHARACTER_PAD, type InputConfigLike, type CharacterPad } from './actions';
import { createKeyboard, isEditableTarget, type KeyboardEventLike } from './browser-keys';
import { clipDeviceId, createPadTracker, padAxes, padButtons, padSnapshot } from './browser-pads';
import { createPointerChannel } from './browser-pointer';
import { createRebind, type CaptureInputOptions, type CapturedInput } from './browser-rebind';
import { createInputStatus } from './browser-status';
import { createUiChannel, uiKeys, type UiKeys, type UiSample } from './browser-ui';
import {
  DEFAULT_KEYBOARD_MAP,
  type InputBindingOptions,
  type RawInputSnapshot,
} from './types';

export type { CaptureInputOptions, CapturedInput } from './browser-rebind';
export type { UiSample } from './browser-ui';

interface VisibilityEventLike {
  target?: unknown;
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
 * the click listener (a page that composes the game again on the same
 * canvas — a new Play snapshot — must not pile up listeners).
 */
export function focusGameSurface(el: HTMLElement): () => void {
  if (el.tabIndex < 0) el.tabIndex = 0;
  el.style.outline = 'none';
  const onDown = (): void => el.focus();
  el.addEventListener('pointerdown', onDown);
  el.focus();
  return () => el.removeEventListener('pointerdown', onDown);
}

/** What `attachBrowserInput` returns: the runtime's `ActionSource` and the binding's own controls. */
export interface BrowserInputSource extends ActionSource {
  /** Remove every listener and clear held state; idempotent. */
  detach(): void;
  /** Alias of `detach` (input.md disposal). */
  dispose(): void;
  /** The structured unavailable state, or `null` while the API is usable. */
  unavailable(): { reason: 'gamepad' | 'environment'; message: string } | null;
  /** `true` until `detach()`; a detached source samples neutral frames. */
  readonly attached: boolean;
  /**
   * The bounded semantic menu channel: one
   * plain-data sample, latches cleared on read. Consumed by the game host,
   * never by the runtime ActionFrame.
   */
  sampleMenu(): MenuSample;
  /** The host consumed a confirm sample: the held press now needs a release. */
  markConfirmConsumed(): void;
  /** The next menu edge (the `ui` actions' keys, pad D-pad/stick/A/B/Start), one per call in arrival order. */
  sampleUi(): UiSample;
  /** Rebind at runtime (a player's settings); held state is cleared. */
  configure(inputConfig: InputConfigLike): void;
  /** Hand the next key press to `onKey` (Escape gives null); returns a cancel function. */
  captureKey(onKey: (code: string | null) => void): () => void;
  /**
   * Hand the next pad button pressed (a fresh press — a button
   * already held when the capture starts must be released first) to
   * `onButton`; the Escape key gives null. Polled by `sampleUi` (the host
   * calls it every frame).
   * Returns a cancel function.
   */
  capturePadButton(onButton: (button: number | null) => void): () => void;
  /** The device the player used last (a key press, or a pad button/stick) — the HUD names its bindings. */
  activeDevice(): 'keyboard' | 'gamepad';
  /**
   * The device used last with the active gamepad's id (the
   * browser's `Gamepad.id`, clipped; null without an active pad) — glyphs
   * name the pad family from it.
   */
  activeDeviceInfo(): { device: 'keyboard' | 'gamepad'; gamepadId: string | null };
  /**
   * Listen for the next input for a rebind — a key (not
   * auto-repeat), a mouse button or wheel notch over the view, a fresh pad
   * button press or a pad axis pushed past half way from where it rested —
   * from the devices asked for. A cancel key gives null. Returns a cancel
   * function (the host times the listening out).
   */
  captureInput(options: CaptureInputOptions, onInput: (input: CapturedInput | null) => void): () => void;
  /**
   * What the host adds to the next sampled frame (`ActionFrame.input`:
   * the device, the bindings, rebind outcomes) — called once per sample; null removes it.
   */
  setFrameInput(source: (() => InputStatusEntry | undefined) | null): void;
  /**
   * Only the actions of these maps feed the frame (null: every
   * map) — the host switches to a focused UI document's map. With the
   * gameplay map off the character controller's move and jump read neutral too; when it
   * comes back, a control still held must be released before it acts.
   */
  setActiveMaps(maps: readonly string[] | null): void;
  /**
   * The cursor the game wants now (the host resolves it every
   * frame from the input map and a script's request): locked → pointer lock
   * on the view (taken on the next click in the view when the browser wants
   * a gesture), free → released. The cursor is hidden while locked or while
   * a gamepad drives.
   */
  applyCursor(mode: 'free' | 'locked'): void;
  /**
   * The UI hit test (x, y fractions of the view; null: none).
   * The pointer over an element the test hits is still tracked (a move over
   * the page's UI updates the position) and the frame's pointer reports
   * `overUi`; a press there went to the UI (the view never saw it).
   */
  setUiHitTest(hit: ((x: number, y: number) => boolean) | null): void;
  /** The cursor as it is (the mode asked for, whether the browser holds the lock, whether it is hidden). */
  cursorState(): { mode: 'free' | 'locked'; locked: boolean; hidden: boolean };
}

/**
 * The project's input map as the binding reads it (`configure` rebinds at runtime): the character
 * controller's keys and pad controls, the action evaluator, every key an action uses, the `ui`
 * actions' keys and whether the view keeps its context menu and the page its wheel scroll.
 */
function bindingConfig(cfg: InputConfigLike | undefined) {
  const keyMap = cfg !== undefined ? characterKeys(cfg) : DEFAULT_KEYBOARD_MAP;
  return {
    suppressContextMenu: cfg !== undefined && bindsPointerButton(cfg, 'right'),
    suppressWheel: cfg !== undefined && bindsWheel(cfg),
    left: new Set<string>(keyMap.left),
    right: new Set<string>(keyMap.right),
    jump: new Set<string>(keyMap.jump),
    /** The pad buttons/axes of the character controller's move and jump. */
    pad: (cfg !== undefined ? characterPad(cfg) : STANDARD_CHARACTER_PAD) as CharacterPad,
    evaluator: cfg !== undefined ? createActionEvaluator(cfg) : null,
    /** Every key an action uses (held keys and taps between samples feed the evaluator). */
    actionCodes: new Set<string>(cfg?.actions.flatMap(actionKeys) ?? []),
    uiKeys: uiKeys(cfg ?? DEFAULT_INPUT_CONFIG) as UiKeys,
    /** The project's `move` action is a 2D axis (a 3D character's move vector: the frame's moveX and moveY). */
    move2d: cfg?.actions.some((a) => a.name === 'move' && a.type === 'axis2d') === true,
  };
}

/**
 * Attach the browser binding to one play host. `target` scopes keyboard
 * `keydown`/`focusin`/`focusout`; window/document events handle release,
 * suspension and gamepad hot-plug.
 *
 * The returned source is the runtime's `ActionSource` plus `detach()` /
 * `dispose()`, `unavailable()` and `attached`. Attaching never throws, even
 * with no DOM at all.
 */
export function attachBrowserInput(
  target: EventTarget | null,
  options: InputBindingOptions = {},
): BrowserInputSource {
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

  // The character controller keys come from the project's move/jump actions
  // (`configure` rebinds them at runtime).
  let cfg = bindingConfig(options.inputConfig);
  let lastPad: { buttons: boolean[]; axes: number[] } | null = null;
  /** Every standard-mapped pad by its slot this sample (a binding naming its `pad` reads its own: local co-op). */
  let lastPads: ({ buttons: boolean[]; axes: number[] } | null)[] = [];
  /** The first key or pad button that went down since the last sample (`ActionFrame.press`, for `ctx.input.anyPressed`). */
  let firstPress: { device: 'keyboard' | 'gamepad'; code: string } | null = null;
  /** The device used last (keyboard until a pad button or stick moves). */
  let lastDevice: 'keyboard' | 'gamepad' = 'keyboard';
  /** The id of the pad used last (null: none yet). */
  let lastPadId: string | null = null;
  const usePad = (id: string): void => {
    lastDevice = 'gamepad';
    lastPadId = id;
  };
  /** The host's frame entry source. */
  let frameInput: (() => InputStatusEntry | undefined) | null = null;
  const clock: () => number = options.now ?? (() => (typeof performance !== 'undefined' && typeof performance.now === 'function' ? performance.now() : Date.now()));
  /** The active action maps (null: all). */
  let activeMaps: ReadonlySet<string> | null = null;
  const actionActive = (a: { map: string }): boolean => activeMaps === null || activeMaps.has(a.map);

  let detached = false;
  let suspendPending = false;

  let jumpLatch = false;
  let state: StepState = { down: false, awaitingRelease: false };
  // The bounded semantic menu channel — separate
  // from the gameplay ActionFrame: the owner feeds its device events into
  // the pure controller; the game host consumes `sampleMenu()` and calls
  // `markConfirmConsumed()`. The controller's `suppress()` state feeds the
  // gameplay sampler so a consumed menu press can never become a jump from
  // the same physical press (the fresh-release rule).
  const menu = createMenuController();
  let prevGamepadJumpDown = false;

  const status = createInputStatus(options);
  const { emit, markUnavailable, counters } = status;

  // --- suspension / fresh activation ------------------------

  /**
   * Fresh activation after a suspension or an active-pad change: held state and pending edges are discarded and every control
   * enters `awaitingRelease`, so a physically down control yields `held` —
   * never `pressed` — until it is observed up once.
   */
  const freshActivation = (): void => {
    jumpLatch = false;
    state = { down: false, awaitingRelease: true };
    prevGamepadJumpDown = false;
  };

  // The parts: rebinding, menu edges, gamepads and the pointer (made before any listener can run).
  const rebind = createRebind({
    padPoll: () => (gamepadEnabled && !detached ? pollGamepads : null),
    usePad,
  });
  const ui = createUiChannel(rebind, usePad);
  const pads = createPadTracker({
    detached: () => detached,
    pad: () => cfg.pad,
    freshActivation,
    lost: (id, reason) => {
      menu.clear('gamepad'); // disconnect clears that device's held menu state;
      // keyboard play is unaffected and nothing stays stuck
      freshActivation();
      counters.disconnectCount += 1;
      emit({ code: 'input_disconnect', reason, deviceId: clipDeviceId(id ?? '') });
    },
    mappingUnsupported: (id) => {
      counters.mappingUnsupportedCount += 1;
      emit({
        code: 'input_mapping_unsupported',
        reason: 'mapping',
        message: 'gamepad mapping is not "standard"; the device is ignored (there is no remapping UI)',
        deviceId: id,
      });
    },
  });
  const pointer = createPointerChannel(target, doc, {
    detached: () => detached,
    device: () => lastDevice,
    useMouse: () => {
      lastDevice = 'keyboard';
    },
    mouseCapture: () => rebind.mouseCapture(),
    suppressWheel: () => cfg.suppressWheel,
    suppressContextMenu: () => cfg.suppressContextMenu,
  });

  const keys = createKeyboard({
    detached: () => detached,
    config: () => cfg,
    rebind,
    pushUi: ui.pushUi,
    menu,
    useKeyboard: () => {
      lastDevice = 'keyboard';
    },
    notePress: (code) => {
      if (firstPress === null) firstPress = { device: 'keyboard', code };
    },
    jumpPressed: () => {
      jumpLatch = true;
    },
  });

  const suspend = (reason: string): void => {
    if (detached) return;
    keys.clear();
    firstPress = null;
    cfg.evaluator?.reset();
    pointer.suspend();
    menu.clear('all'); // focus/visibility loss: every held key/button and the
    // menu latch clear
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

  // --- listeners ------------------------------------------------------------

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

  listen(target, 'keydown', keys.onKeyDown);
  listen(target, 'keyup', keys.onKeyUp);
  listen(target, 'focusin', onFocusIn);
  listen(target, 'focusout', onFocusOut);
  listen(win, 'keyup', keys.onKeyUp);
  listen(win, 'blur', onBlur);
  listen(win, 'focus', onFocus);
  listen(win, 'pagehide', onPageHide);
  listen(win, 'gamepadconnected', pads.onConnected);
  listen(win, 'gamepaddisconnected', pads.onDisconnected);
  listen(doc, 'visibilitychange', onVisibilityChange);
  // The pointer over the view (a release outside it still counts), the wheel, pointer lock.
  listen(target, 'pointermove', pointer.onPointerMove);
  listen(win, 'pointermove', pointer.onWindowPointerMove);
  listen(target, 'pointerdown', pointer.onPointerDown);
  listen(win, 'pointerup', pointer.onPointerUp);
  listen(win, 'pointercancel', pointer.onPointerUp);
  listen(target, 'pointerenter', pointer.onPointerEnter);
  listen(target, 'pointerleave', pointer.onPointerLeave);
  listen(target, 'wheel', pointer.onWheel);
  listen(target, 'contextmenu', pointer.onContextMenu);
  listen(doc, 'pointerlockchange', pointer.onPointerLockChange);

  // --- availability ----------------------------------------

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

  /** The frame with the host's input entry (device, bindings, rebind outcomes) when it has one. */
  const sample = (stepIndex: number): ActionFrame => {
    const sampled = sampleDevices(stepIndex);
    const press = firstPress;
    firstPress = null;
    const frame = press === null || detached ? sampled : { ...sampled, press };
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
    /** The pad the character channel reads: the one its move/jump bindings name, else the active pad. */
    let characterGamepad: Gamepad | null = null;
    if (gamepadEnabled && pollGamepads) {
      try {
        const list = pollGamepads();
        rebind.pollCapture(list);
        active = pads.pickActive(list);
        const press = pads.notePresses(list, firstPress !== null || rebind.listening());
        if (press !== null) firstPress = press;
        lastPad = active ? { buttons: padButtons(active), axes: padAxes(active) } : null;
        lastPads = Array.from(list, (gp) => (gp && gp.connected !== false && gp.mapping === 'standard' ? { buttons: padButtons(gp), axes: padAxes(gp) } : null));
        const named = cfg.pad.slot !== null ? (list[cfg.pad.slot] ?? null) : null;
        characterGamepad = cfg.pad.slot === null ? active : named !== null && named.connected !== false && named.mapping === 'standard' ? named : null;
        if (active !== null && (active.buttons.some((b) => b?.pressed === true) || active.axes.some((v) => Math.abs(v ?? 0) > 0.5))) {
          usePad(clipDeviceId(active.id));
        }
      } catch (error) {
        markUnavailable('gamepad', `getGamepads failed: ${messageOf(error)}; keyboard-only`);
        active = null;
        lastPads = [];
      }
    }
    // The menu channel sees the primary button (a fresh press confirms; the
    // same button is the pad's jump unless rebound — suppression below). A disabled/blocked poll reads as released.
    menu.gamepadButton0(active !== null && active.buttons[0]?.pressed === true);
    const suppressed = menu.suppress();
    // A consumed confirm press still held: the SAME physical button must
    // not also drive the pad jump until it is released (only when button 0 is one of the jump buttons; a rebound jump is another button).
    gamepad = characterGamepad !== null ? padSnapshot(cfg.pad, characterGamepad, suppressed.gamepad && characterGamepad === active ? new Set([0]) : undefined) : null;
    if (suppressed.keyboard) {
      // A consumed confirm press still held: the same physical key must not
      // contribute to the jump at all — the mapping derives the jump
      // down-transition from the HELD keyboard state, so the suppression
      // zeroes the held contribution, not just the owner's press latch
      // (the delivery.md fresh-release rule).
      jumpLatch = false;
      keyboardJumpSuppressed = true;
    }

    const gamepadJumpDown = gamepad !== null && gamepad.button0;
    if (gamepadJumpDown && !prevGamepadJumpDown) jumpLatch = true;
    prevGamepadJumpDown = gamepadJumpDown;

    // The gameplay map switched off (a focused UI document): move and jump read neutral.
    const gameplayOn = activeMaps === null || activeMaps.has('gameplay');
    const snapshot: RawInputSnapshot = gameplayOn
      ? {
          keyboardLeft: keys.anyHeld(cfg.left),
          keyboardRight: keys.anyHeld(cfg.right),
          keyboardJump: keyboardJumpSuppressed ? false : keys.anyHeld(cfg.jump),
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
    // The pointer (once seen) rides in every frame; the cursor follows the last device.
    const pointerFrame = pointer.sample();
    const rawPointer = pointer.take();
    pointer.present();
    // The mapped controls are the frame's `move` and `jump` actions (frame version 2).
    const evaluator = cfg.evaluator;
    if (evaluator === null) {
      pointer.clearEdges();
      return toActionFrame(frame, pointerFrame === null ? {} : { pointer: pointerFrame });
    }
    const actions = evaluator.sample({ keys: keys.actionHeld, pressedKeys: keys.actionPressed, gamepad: gamepadEnabled ? lastPad : null, pads: gamepadEnabled ? lastPads : [], pointer: rawPointer, now: clock() }, activeMaps === null ? undefined : actionActive);
    keys.actionPressed.clear();
    pointer.clearEdges();
    // A 2D `move` action gives the move vector (x right, y forward/up); a 1D one keeps the 1D frame exactly.
    const move = cfg.move2d ? actions['move'] : undefined;
    if (move !== undefined) return toActionFrame({ ...frame, moveX: quantizeMove(move.x ?? 0), moveY: quantizeMove(move.y ?? 0) }, { actions, ...(pointerFrame !== null ? { pointer: pointerFrame } : {}) });
    return toActionFrame(frame, { actions, ...(pointerFrame !== null ? { pointer: pointerFrame } : {}) });
  };

  const reset = (reason?: string): void => suspend(reason ?? 'reset');

  const detach = (): void => {
    if (detached) return;
    detached = true;
    for (const { target: on, type, handler } of listeners) {
      if (typeof on.removeEventListener === 'function') on.removeEventListener(type, handler);
    }
    listeners.length = 0;
    keys.clear();
    jumpLatch = false;
    menu.clear('all');
    state = { down: false, awaitingRelease: false };
    prevGamepadJumpDown = false;
    pads.clear();
    // Give the cursor back.
    pointer.detach();
  };

  return {
    sample,
    reset,
    diagnostics: status.diagnostics,
    sampleMenu(): MenuSample {
      return menu.sample();
    },
    activeDevice(): 'keyboard' | 'gamepad' {
      return lastDevice;
    },
    activeDeviceInfo(): { device: 'keyboard' | 'gamepad'; gamepadId: string | null } {
      return { device: lastDevice, gamepadId: lastPadId };
    },
    captureInput: rebind.captureInput,
    setFrameInput(source: (() => InputStatusEntry | undefined) | null): void {
      frameInput = source;
    },
    applyCursor(mode: 'free' | 'locked'): void {
      if (detached) return;
      pointer.applyCursor(mode);
    },
    cursorState: pointer.cursorState,
    setUiHitTest: pointer.setUiHitTest,
    markConfirmConsumed(): void {
      menu.consumeConfirm();
    },
    sampleUi(): UiSample {
      return ui.sample(gamepadEnabled && !detached ? pollGamepads : null);
    },
    setActiveMaps(maps: readonly string[] | null): void {
      const next = maps === null ? null : new Set(maps);
      const wasGameplay = activeMaps === null || activeMaps.has('gameplay');
      activeMaps = next;
      const isGameplay = next === null || next.has('gameplay');
      // Back to gameplay: a key or button still held from the menu must be released before it moves or jumps.
      if (!wasGameplay && isGameplay) {
        freshActivation();
        cfg.evaluator?.holdUntilReleased();
      }
    },
    configure(inputConfig: InputConfigLike): void {
      cfg = bindingConfig(inputConfig);
      keys.clear();
      freshActivation();
    },
    capturePadButton: rebind.capturePadButton,
    captureKey: rebind.captureKey,
    detach,
    dispose: detach,
    unavailable: status.unavailable,
    get attached() {
      return !detached;
    },
  };
}
