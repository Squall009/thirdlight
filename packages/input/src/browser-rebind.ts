/**
 * The browser binding's rebinding: listening for the next key, pad button or any input (key,
 * mouse button or wheel notch, fresh pad button, pad axis pushed past half way) for a player's
 * settings. While one listens it takes that input and nothing else sees it.
 */
import { clipDeviceId, padAxes, padButtons } from './browser-pads';

/** What a rebind listens to. */
export interface CaptureInputOptions {
  /** The devices (default all). */
  readonly devices?: readonly ('keyboard' | 'mouse' | 'gamepad')[];
  /** Keys that cancel (default Escape). */
  readonly cancelKeys?: readonly string[];
}

/** The input a rebind heard. */
export type CapturedInput =
  | { readonly device: 'keyboard'; readonly code: string }
  | { readonly device: 'mouse'; readonly button: 'left' | 'right' | 'middle' }
  | { readonly device: 'mouse'; readonly wheel: 1 | -1 }
  | { readonly device: 'gamepad'; readonly button: number }
  | { readonly device: 'gamepad'; readonly axis: number; readonly sign: 1 | -1 };

/** The key event surface a rebind reads. */
interface KeyLike {
  repeat?: unknown;
  preventDefault?: () => void;
}

export interface RebindHost {
  /** The gamepad poll while pads can be read (enabled and attached), else null. */
  padPoll(): (() => ArrayLike<Gamepad | null>) | null;
  /** A pad was used (its id): it is the device used last. */
  usePad(id: string): void;
}

export function createRebind(host: RebindHost) {
  let capture: ((code: string | null) => void) | null = null;
  let padCapture: ((button: number | null) => void) | null = null;
  /** The buttons held when the pad capture last looked (a press is a fresh down edge). */
  let padCaptureBase: boolean[] | null = null;
  /** A rebind listening for input, and the pad's buttons/axes when it started (a press is a change from there). */
  type Capture = { devices: ReadonlySet<string>; cancel: ReadonlySet<string>; cb: (input: CapturedInput | null) => void; buttons: boolean[] | null; axes: number[] | null };
  let inputCapture: Capture | null = null;
  const finishCapture = (input: CapturedInput | null): void => {
    const c = inputCapture;
    inputCapture = null;
    c?.cb(input);
  };

  /** The pad part of a rebind: a fresh button press or an axis pushed past half way from its rest. */
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
      host.usePad(clipDeviceId(pad.id));
      finishCapture({ device: 'gamepad', button: hit });
      return;
    }
    for (let i = 0; i < axes.length && i <= 7; i += 1) {
      const d = axes[i]! - (c.axes[i] ?? 0);
      if (Math.abs(d) > 0.5 && Math.abs(axes[i]!) > 0.5) {
        host.usePad(clipDeviceId(pad.id));
        finishCapture({ device: 'gamepad', axis: i, sign: axes[i]! > 0 ? 1 : -1 });
        return;
      }
    }
    // A button let go is ready to be pressed again.
    c.buttons = c.buttons.map((b, i) => b && buttons[i] === true);
  };

  return {
    pollCapture,
    /** A listen-for-input rebind is open. */
    listening(): boolean {
      return inputCapture !== null;
    },
    /** A pad-button rebind is open. */
    listeningPad(): boolean {
      return padCapture !== null;
    },
    /** The open rebind's hand-off when it listens to the mouse (null: none does). */
    mouseCapture(): ((input: CapturedInput) => void) | null {
      return inputCapture !== null && inputCapture.devices.has('mouse') ? finishCapture : null;
    },
    /** A key press (not editable-target); true when a rebind took it (nothing else may see it). */
    takeKey(code: string, e: KeyLike): boolean {
      if (padCapture !== null && code === 'Escape' && e.repeat !== true) {
        // Escape cancels a pad rebinding.
        const cb = padCapture;
        padCapture = null;
        padCaptureBase = null;
        if (typeof e.preventDefault === 'function') e.preventDefault();
        cb(null);
        return true;
      }
      if (inputCapture !== null && e.repeat !== true && (inputCapture.devices.has('keyboard') || inputCapture.cancel.has(code))) {
        // A rebind takes this key (nothing else sees it); a cancel key gives null.
        if (typeof e.preventDefault === 'function') e.preventDefault();
        finishCapture(inputCapture.cancel.has(code) ? null : { device: 'keyboard', code });
        return true;
      }
      if (capture !== null && e.repeat !== true) {
        // A rebinding screen takes this key (nothing else sees it).
        const cb = capture;
        capture = null;
        if (typeof e.preventDefault === 'function') e.preventDefault();
        cb(code === 'Escape' ? null : code);
        return true;
      }
      return false;
    },
    /**
     * The pad-button rebind's step over the buttons held now: it takes the next fresh press
     * (`taken` runs first, then the rebind hears the button).
     */
    padStep(now: boolean[], taken: () => void): void {
      if (padCapture === null) return;
      const base = padCaptureBase ?? now;
      const hit = now.findIndex((d, i) => d && base[i] !== true);
      padCaptureBase = now;
      if (hit >= 0 && hit <= 31) {
        const cb = padCapture;
        padCapture = null;
        padCaptureBase = null;
        taken();
        cb(hit);
      }
    },
    captureInput(opts: CaptureInputOptions, onInput: (input: CapturedInput | null) => void): () => void {
      const prev = inputCapture;
      inputCapture = null;
      prev?.cb(null);
      const devices = new Set<string>(opts.devices ?? ['keyboard', 'mouse', 'gamepad']);
      const cancel = new Set<string>(opts.cancelKeys ?? ['Escape']);
      const entry: Capture = { devices, cancel, cb: onInput, buttons: null, axes: null };
      inputCapture = entry;
      const poll = host.padPoll();
      if (devices.has('gamepad') && poll !== null) {
        try {
          const pad = Array.from(poll()).find((g) => g !== null && g.mapping === 'standard') ?? null;
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
    capturePadButton(onButton: (button: number | null) => void): () => void {
      padCapture = onButton;
      padCaptureBase = null;
      const poll = host.padPoll();
      if (poll !== null) {
        try {
          const pad = Array.from(poll()).find((g) => g !== null && g.mapping === 'standard') ?? null;
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
  };
}

export type Rebind = ReturnType<typeof createRebind>;
