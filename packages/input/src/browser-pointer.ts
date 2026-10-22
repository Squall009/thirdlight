/**
 * The browser binding's pointer: the position over the view (or the movement while the pointer
 * is locked), the buttons and the wheel between samples, the cursor the game asked for and the
 * UI hit test. The binding owns the listeners; this part gets the view element and the document
 * it was given and keeps the pointer state behind a small surface.
 */
import type { ActionFrame } from '@thirdlight/runtime';
import { cursorPresentation, type RawPointerState } from './actions';
import type { CapturedInput } from './browser-rebind';

/** The pointer/wheel event surface the owner reads (real DOM events satisfy it). */
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

/** DOM `button` (0 left, 1 middle, 2 right) → the frame's button bit (1 left, 2 right, 4 middle). */
function buttonBit(button: unknown): number {
  return button === 0 ? 1 : button === 2 ? 2 : button === 1 ? 4 : 0;
}

/** A wheel event's notches (pixel deltas: 100 px a notch — Chrome's line; lines: 3 a notch; pages: 1). */
export function wheelNotches(deltaY: unknown, deltaMode: unknown): number {
  const d = typeof deltaY === 'number' && Number.isFinite(deltaY) ? deltaY : 0;
  return deltaMode === 1 ? d / 3 : deltaMode === 2 ? d : d / 100;
}

/** 1e-4 quantization (the frame's), negative zero normalized. */
function q4(v: number): number {
  const r = Math.round(v * 1e4) / 1e4;
  return r === 0 ? 0 : r;
}

/** What the pointer reads from the rest of the binding. */
export interface PointerHost {
  detached(): boolean;
  /** The device used last (the cursor hides while a gamepad drives). */
  device(): 'keyboard' | 'gamepad';
  /** The mouse was used (keyboard and mouse are one device for the HUD). */
  useMouse(): void;
  /** A rebind listening to the mouse: hand it the input (null: none listening). */
  mouseCapture(): ((input: CapturedInput) => void) | null;
  /** An action binds the wheel / the right button: the page keeps neither. */
  suppressWheel(): boolean;
  suppressContextMenu(): boolean;
}

export function createPointerChannel(target: EventTarget | null, doc: Document | null, host: PointerHost) {
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
  let cursorShown = '';
  /** The UI hit test (the host's). */
  let uiHit: ((x: number, y: number) => boolean) | null = null;
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
    if (host.detached()) return;
    const e = event as unknown as PointerEventLike;
    movePointer(e);
    pointerOver = true;
    if (e.pointerType !== 'touch') host.useMouse(); // keyboard and mouse are one device for the HUD
  };
  /** A move over the page's UI (an element over the view): the pointer stays tracked there. */
  const onWindowPointerMove = (event: Event): void => {
    if (host.detached() || uiHit === null || isLocked()) return;
    if ((event as { target?: unknown }).target === target) return; // the view's own listener has it
    const e = event as unknown as PointerEventLike;
    const r = rectOf();
    if (r === null) return;
    const x = (finiteOr0(e.clientX) - r.left) / r.width;
    const y = (finiteOr0(e.clientY) - r.top) / r.height;
    if (x < 0 || x > 1 || y < 0 || y > 1 || !uiHit(x, y)) return;
    movePointer(e);
    pointerOver = true;
    if (e.pointerType !== 'touch') host.useMouse();
  };
  const onPointerDown = (event: Event): void => {
    if (host.detached()) return;
    const e = event as unknown as PointerEventLike;
    movePointer(e);
    pointerOver = true;
    host.useMouse();
    const capture = host.mouseCapture();
    if (capture !== null && buttonBit(e.button) !== 0) {
      // A rebind takes this mouse button.
      capture({ device: 'mouse', button: e.button === 0 ? 'left' : e.button === 2 ? 'right' : 'middle' });
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
    if (host.detached()) return;
    const e = event as unknown as PointerEventLike;
    const bit = buttonBit(e.button);
    if (bit !== 0 && (pointerButtons & bit) !== 0) {
      pointerButtons &= ~bit;
      pointerReleased |= bit;
    }
  };
  const onPointerEnter = (event: Event): void => {
    if (host.detached()) return;
    movePointer(event as unknown as PointerEventLike);
    pointerOver = true;
  };
  const onPointerLeave = (): void => {
    if (host.detached() || isLocked()) return;
    pointerOver = false;
  };
  const onWheel = (event: Event): void => {
    if (host.detached()) return;
    const e = event as unknown as PointerEventLike;
    const capture = host.mouseCapture();
    if (capture !== null) {
      const n = wheelNotches(e.deltaY, e.deltaMode);
      if (n !== 0) {
        // A rebind takes the wheel (positive towards the user).
        capture({ device: 'mouse', wheel: n > 0 ? 1 : -1 });
        if (typeof e.preventDefault === 'function') e.preventDefault();
        return;
      }
    }
    pointerWheel += wheelNotches(e.deltaY, e.deltaMode);
    pointerSeen = true;
    if (host.suppressWheel() && typeof e.preventDefault === 'function') e.preventDefault();
  };
  const onContextMenu = (event: Event): void => {
    if (host.detached() || !host.suppressContextMenu()) return;
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
    if (host.detached()) return;
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
    const pres = cursorPresentation(cursorMode, host.device());
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
      // Over the UI (the host's hit test at the pointer).
      ...(pointerOver && !locked && uiHit !== null && uiHit(pointerX, pointerY) ? { overUi: true } : {}),
    };
  };

  return {
    onPointerMove,
    onWindowPointerMove,
    onPointerDown,
    onPointerUp,
    onPointerEnter,
    onPointerLeave,
    onWheel,
    onContextMenu,
    onPointerLockChange,
    sample: pointerSample,
    take: takePointer,
    clearEdges: clearPointerEdges,
    present: presentCursor,
    /** Focus loss: held buttons are let go (the next sample reports their release) and pending movement dropped. */
    suspend(): void {
      pointerButtons = 0;
      pointerPressed = 0;
      pointerDx = 0;
      pointerDy = 0;
      pointerWheel = 0;
    },
    /** Detach: give the cursor back and forget the pointer. */
    detach(): void {
      releaseLock();
      if (targetEl?.style !== undefined && cursorHidden) targetEl.style.cursor = '';
      cursorHidden = false;
      pointerSeen = false;
      pointerButtons = 0;
      clearPointerEdges();
    },
    applyCursor(mode: 'free' | 'locked'): void {
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
    setUiHitTest(hit: ((x: number, y: number) => boolean) | null): void {
      uiHit = hit;
    },
  };
}

export type PointerChannel = ReturnType<typeof createPointerChannel>;
