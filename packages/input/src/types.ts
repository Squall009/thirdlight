/**
 * `@thirdlight/input` attachment options and the stick dead zone. The browser
 * owner (`browser.ts`) is the only module in the package that touches
 * `window`/`document`/`navigator`; it reduces them to plain device state for
 * the action evaluator.
 */
import type { InputConfigLike } from './actions';

/** The radial gamepad dead zone an action without its own `deadZone` uses. */
export const GAMEPAD_DEAD_ZONE = 0.2;

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
  /** The project's input actions, each sampled into the frame's `actions`. Absent: the side-view defaults. */
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
