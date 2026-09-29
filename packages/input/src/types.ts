/**
 * `@thirdlight/input` public data shapes and mapping constants (from
 * `input.md`).
 *
 * `RawInputSnapshot` is **plain data**: no `KeyboardEvent`, no `Gamepad`, no
 * DOM node and no wall-clock value ever crosses this boundary (runtime.md).
 * The browser owner (`browser.ts`) is the only module in the package
 * that touches `window`/`document`/`navigator`; it reduces those objects to a
 * snapshot and hands it to the pure mapping.
 */

/**
 * The default keyboard map (input.md, normative default).
 * Values are `KeyboardEvent.code` values, so the map is layout-independent
 * and testable without a browser.
 */
export const DEFAULT_KEYBOARD_MAP: Readonly<{
  left: readonly string[];
  right: readonly string[];
  jump: readonly string[];
}> = Object.freeze({
  left: Object.freeze(['KeyA', 'ArrowLeft']),
  right: Object.freeze(['KeyD', 'ArrowRight']),
  jump: Object.freeze(['Space']),
});

/** The radial gamepad dead zone (`input.md`, hard constant). */
export const GAMEPAD_DEAD_ZONE = 0.2;

/** `moveX` quantization (`input.md`, hard constant). */
export const MOVE_QUANTUM = 1e-4;

/**
 * One plain-data snapshot of the raw device state at a single sampling
 * moment. `gamepad` is the *active* standard-mapped pad only;
 * non-standard-mapped pads never appear here — the browser owner ignores them and reports `input_mapping_unsupported`.
 */
export interface RawInputSnapshot {
  /** A mapped move-left keyboard control is held. */
  keyboardLeft: boolean;
  /** A mapped move-right keyboard control is held. */
  keyboardRight: boolean;
  /** The mapped jump keyboard control is held (Space). */
  keyboardJump: boolean;
  /**
   * A jump down-transition observed since the previous sample (the press
   * latch). `true` only when a keydown / button-down
   * transition happened in the window; a keyup never sets it. Cleared by the
   * owner immediately after the sample is produced.
   */
  jumpLatch?: boolean;
  /** The active standard-mapped gamepad contribution, or `null`/absent. */
  gamepad?: {
    /** `Gamepad.index`; the stable key while connected (MDN Gamepad API guide). */
    index: number;
    /** `Gamepad.id`, clipped before it reaches a diagnostic. */
    id: string;
    /** `Gamepad.mapping`; only exactly `'standard'` contributes. */
    mapping: string;
    /**
     * The move stick axis, raw (axis 0 unless the project's `move` action
     * binds other axes); dead-zone rescaling happens in the mapping.
     */
    axis0: number;
    /** The jump button(s) held (standard: `buttons[0]`, A/cross; the `jump` action's pad buttons when bound). */
    button0: boolean;
    /** Move left held (standard: D-pad left, `buttons[14]`; or the `move` action's rebound button). */
    button14: boolean;
    /** Move right held (standard: D-pad right, `buttons[15]`; or the `move` action's rebound button). */
    button15: boolean;
  } | null;
}

import type { InputConfigLike } from './actions';

/**
 * The explicit browser attachment options (`attachBrowserInput`). Every
 * environment surface is injectable so the owner is testable against fakes;
 * in a browser the defaults resolve from `globalThis.window`.
 */
export interface InputBindingOptions {
  /** Window-like event source; defaults to `globalThis.window` when present. */
  window?: Window | null;
  /** Document-like event source; defaults to `options.window?.document`. */
  document?: Document | null;
  /** Navigator-like global; defaults to `options.window?.navigator`. */
  navigator?: Navigator | null;
  /**
   * Gamepad poller; defaults to `navigator.getGamepads`.
   * `null` (or an environment without the method) reports `input_unavailable`.
   */
  getGamepads?: (() => ArrayLike<Gamepad | null>) | null;
  /**
   * Structured diagnostic sink (bounded event codes). Never
   * throws into the binding — a throwing sink is swallowed.
   */
  /**
   * The project's input actions. Its `move`/`jump` keyboard
   * bindings drive the character controller; every action is sampled into the frame's
   * `actions`. Absent: the default keys only.
   */
  inputConfig?: InputConfigLike;
  /** The clock (milliseconds) hold bindings measure with; defaults to `performance.now`. */
  now?: () => number;
  onDiagnostic?: (event: {
    code:
      | 'input_unavailable'
      | 'input_mapping_unsupported'
      | 'input_suspend'
      | 'input_activate'
      | 'input_disconnect';
    reason?: string;
    message?: string;
    /** Clipped to 64 log-safe characters. */
    deviceId?: string;
  }) => void;
}
