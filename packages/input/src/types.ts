/**
 * `@thirdlight/input` public data shapes and M2 mapping constants
 * (docs/contracts/runtime.md §12.5, promoted from `input.md` §4/§9).
 *
 * `RawInputSnapshot` is **plain data**: no `KeyboardEvent`, no `Gamepad`, no
 * DOM node and no wall-clock value ever crosses this boundary (runtime.md
 * §12.5). The browser owner (`browser.ts`) is the only module in the package
 * that touches `window`/`document`/`navigator`; it reduces those objects to a
 * snapshot and hands it to the pure mapping.
 */

/**
 * The M2 keyboard map (input.md §4.1, normative default; no remapping UI).
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

/** The M2 radial gamepad dead zone (`input.md` §4.2/§9, hard constant). */
export const GAMEPAD_DEAD_ZONE = 0.2;

/** `moveX` quantization (`input.md` §3.3, hard constant). */
export const MOVE_QUANTUM = 1e-4;

/**
 * One plain-data snapshot of the raw device state at a single sampling moment
 * (input.md §4). `gamepad` is the *active* standard-mapped pad only
 * (input.md §4.4); non-standard-mapped pads never appear here — the browser
 * owner ignores them and reports `input_mapping_unsupported`.
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
   * latch, runtime.md §12.5.2). `true` only when a keydown / button-down
   * transition happened in the window; a keyup never sets it. Cleared by the
   * owner immediately after the sample is produced.
   */
  jumpLatch?: boolean;
  /** The active standard-mapped gamepad contribution, or `null`/absent. */
  gamepad?: {
    /** `Gamepad.index`; the stable key while connected (MDN Gamepad API guide). */
    index: number;
    /** `Gamepad.id`, clipped before it reaches a diagnostic (input.md §4.1). */
    id: string;
    /** `Gamepad.mapping`; only exactly `'standard'` contributes (input.md §4.1). */
    mapping: string;
    /**
     * The move stick axis, raw (axis 0 unless the project's `move` action
     * binds other axes — phase 14.5); dead-zone rescaling happens in the mapping.
     */
    axis0: number;
    /** The jump button(s) held (standard: `buttons[0]`, A/cross; phase 14.5: the `jump` action's pad buttons when bound). */
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
   * Structured diagnostic sink (bounded event codes, input.md §7). Never
   * throws into the binding — a throwing sink is swallowed.
   */
  /**
   * Phase 9.8: the project's input actions. Its `move`/`jump` keyboard
   * bindings drive the platformer; every action is sampled into the frame's
   * `actions`. Absent: the M2 keys only.
   */
  inputConfig?: InputConfigLike;
  onDiagnostic?: (event: {
    code:
      | 'input_unavailable'
      | 'input_mapping_unsupported'
      | 'input_suspend'
      | 'input_activate'
      | 'input_disconnect';
    reason?: string;
    message?: string;
    /** Clipped to 64 log-safe characters (input.md §4.1). */
    deviceId?: string;
  }) => void;
}
