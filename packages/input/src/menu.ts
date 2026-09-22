/**
 * The bounded semantic menu-control channel (delivery.md §4.1/§4.2) — the
 * pure state machine the browser input owner feeds from its device events.
 *
 * This module is the "approved menu-control seam" of `packages/input`
 * (packet 55): a second, SEPARATE channel beside the gameplay `ActionFrame`
 * (which it never touches — a menu action never enters a runtime
 * `ActionFrame`, delivery.md §4.1). The browser owner (`browser.ts`) reduces
 * real keyboard/gamepad events to plain-data calls here and reads the
 * `MenuSample` out; the game host consumes `confirm`/`mute` and calls
 * `consumeConfirm()` when it consumes a press (the §4.2 fresh-release
 * state machine lives here so the owner can suppress the same physical
 * press from also becoming a jump).
 *
 * Bindings (delivery.md §4.1, hard constants — no remapping):
 *  - `Enter` OR `Space` OR a fresh primary gamepad button (button 0) →
 *    `menuConfirm`;
 *  - `KeyM` → `mute` toggle.
 * `Enter` is not a gameplay binding (packet-38 probe: `Enter → unbound`).
 *
 * No DOM, no `KeyboardEvent`/`Gamepad` objects, no clock — plain data in,
 * plain data out (input.md §5: the browser owner is the only module that
 * touches the environment).
 */

/** The keyboard `KeyboardEvent.code` values that map to `menuConfirm`. */
export const MENU_CONFIRM_CODES: readonly string[] = Object.freeze(['Enter', 'Space']);
/** The keyboard `KeyboardEvent.code` value that maps to the `mute` toggle. */
export const MENU_MUTE_CODE = 'KeyM';
/** The primary face button (standard mapping) that maps to `menuConfirm`. */
export const MENU_GAMEPAD_CONFIRM_BUTTON = 0;

export type MenuConfirmDevice = 'keyboard' | 'gamepad';

/** One plain-data menu sample (delivery.md §4.1; read + cleared per sample). */
export interface MenuSample {
  /** A fresh confirm press since the previous sample (latched). */
  readonly confirm: boolean;
  /** A fresh mute press since the previous sample (latched). */
  readonly mute: boolean;
  /**
   * A consumed confirm press is still physically held (delivery.md §4.2
   * `consumed(needsRelease)`): both a re-report `menuConfirm` and the jump
   * from the same physical press are suppressed until the release.
   */
  readonly confirmNeedsRelease: boolean;
  /** The device of the held confirm press while `confirmNeedsRelease`. */
  readonly confirmDevice: MenuConfirmDevice | null;
  /** Suppress the keyboard jump contribution for the next gameplay sample. */
  readonly suppressKeyboardJump: boolean;
  /** Suppress the gamepad jump contribution for the next gameplay sample. */
  readonly suppressGamepadJump: boolean;
}

/**
 * The pure menu state machine. Presses are first transitions only (the
 * browser owner already drops `event.repeat`); releases and device loss
 * clear the held state. `clear('all')` is the focus/visibility-loss path
 * (delivery.md §4.6); `clear('gamepad')` is the disconnect/index-reuse path
 * (delivery.md §4.3 — keyboard play is unaffected, nothing stays stuck).
 */
export interface MenuController {
  /** A keyboard press first transition (the owner already filtered repeat/editable). */
  keyboardDown(code: string): void;
  /** A keyboard release (always applied — even on an editable target). */
  keyboardUp(code: string): void;
  /** The active standard-mapped pad's primary button state (per poll). */
  gamepadButton0(pressed: boolean): void;
  /** The host consumed a confirm sample: the held press now needs a release. */
  consumeConfirm(): void;
  /** Focus/visibility loss (`'all'`) or gamepad disconnect (`'gamepad'`). */
  clear(scope: 'all' | 'gamepad'): void;
  /**
   * The current jump-suppression state WITHOUT consuming the press latches
   * (the gameplay sampler reads this per step; the host consumes the latches
   * with `sample()` per frame — the two channels run at different rates).
   */
  suppress(): { readonly keyboard: boolean; readonly gamepad: boolean };
  /** Read the current sample and clear the press latches. */
  sample(): MenuSample;
}

export function createMenuController(): MenuController {
  /** The confirm codes currently physically held (keyboard). */
  const kbConfirmHeld = new Set<string>();
  /** The mute code currently held. */
  let kbMuteHeld = false;
  /** A consumed confirm is still held on the keyboard (§4.2). */
  let kbConfirmConsumed = false;
  /** The pad's primary button is physically held. */
  let padConfirmHeld = false;
  /** A consumed confirm is still held on the pad (§4.2). */
  let padConfirmConsumed = false;
  /** Fresh-press latches since the previous `sample()`. */
  let confirmLatch = false;
  let muteLatch = false;

  return {
    keyboardDown(code: string): void {
      if (MENU_CONFIRM_CODES.includes(code)) {
        if (kbConfirmHeld.has(code)) return; // re-report of the same held button
        kbConfirmHeld.add(code);
        // A fresh press of a confirm code latches — UNLESS a confirm is
        // already consumed-and-held on this device (the same held-press
        // situation; a second button of the same device does not create a
        // new press while the first is consumed and held).
        if (!kbConfirmConsumed) confirmLatch = true;
        return;
      }
      if (code === MENU_MUTE_CODE) {
        if (kbMuteHeld) return;
        kbMuteHeld = true;
        muteLatch = true;
      }
    },

    keyboardUp(code: string): void {
      if (code === MENU_MUTE_CODE) {
        kbMuteHeld = false;
        return;
      }
      if (!MENU_CONFIRM_CODES.includes(code)) return;
      kbConfirmHeld.delete(code);
      if (kbConfirmHeld.size === 0) kbConfirmConsumed = false; // release clears
    },

    gamepadButton0(pressed: boolean): void {
      if (pressed && !padConfirmHeld) {
        padConfirmHeld = true;
        if (!padConfirmConsumed) confirmLatch = true; // fresh primary-button press
      } else if (!pressed && padConfirmHeld) {
        padConfirmHeld = false;
        padConfirmConsumed = false; // release clears
      }
    },

    consumeConfirm(): void {
      // The host consumed a confirm sample; whichever device is physically
      // holding a confirm press now needs a release before it may jump.
      if (kbConfirmHeld.size > 0) kbConfirmConsumed = true;
      if (padConfirmHeld) padConfirmConsumed = true;
    },

    clear(scope: 'all' | 'gamepad'): void {
      if (scope === 'gamepad') {
        padConfirmHeld = false;
        padConfirmConsumed = false;
        return;
      }
      kbConfirmHeld.clear();
      kbMuteHeld = false;
      kbConfirmConsumed = false;
      padConfirmHeld = false;
      padConfirmConsumed = false;
      confirmLatch = false;
      muteLatch = false;
    },

    suppress(): { readonly keyboard: boolean; readonly gamepad: boolean } {
      const needsKb = kbConfirmConsumed && kbConfirmHeld.size > 0;
      const needsPad = padConfirmConsumed && padConfirmHeld;
      return {
        keyboard: needsKb && kbConfirmHeld.has('Space'),
        gamepad: needsPad,
      };
    },

    sample(): MenuSample {
      const needsKb = kbConfirmConsumed && kbConfirmHeld.size > 0;
      const needsPad = padConfirmConsumed && padConfirmHeld;
      const out: MenuSample = {
        confirm: confirmLatch,
        mute: muteLatch,
        confirmNeedsRelease: needsKb || needsPad,
        confirmDevice: needsKb ? 'keyboard' : needsPad ? 'gamepad' : null,
        // The consumed press may only suppress the jump of the SAME physical
        // source: keyboard Space (the jump key) or the pad primary button
        // (the pad's M2 jump, button 0).
        suppressKeyboardJump: needsKb && kbConfirmHeld.has('Space'),
        suppressGamepadJump: needsPad,
      };
      confirmLatch = false;
      muteLatch = false;
      return out;
    },
  };
}