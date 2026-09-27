/**
 * Phase 9.8: named input actions from raw device state.
 *
 * Pure apart from each action's previous "down" bit (for its phase), which
 * the evaluator keeps. Bindings never add up: an action takes the binding
 * with the largest magnitude (like the move mapping of M2). A 1D axis from
 * a stick gets a radial dead zone (default 0.2) and is rescaled; 2D axes are
 * clipped to length 1. `invert` and `scale` apply last. A button — or an axis
 * past 0.5 — is "down"; its phase is pressed / held / released / none.
 */
import type { ActionValue, JumpPhase } from '@thirdlight/runtime';

export interface InputBindingLike {
  readonly kind: string;
  readonly code?: string;
  readonly button?: number | string;
  readonly axis?: number | string;
  readonly negative?: string | number;
  readonly positive?: string | number;
  readonly up?: string;
  readonly down?: string;
  readonly left?: string;
  readonly right?: string;
  readonly x?: number;
  readonly y?: number;
  /** Phase 23.14: hold instead of tap — seconds a key/button binding must be held before it counts. */
  readonly hold?: number;
}

export interface InputActionLike {
  readonly name: string;
  readonly type: 'button' | 'axis1d' | 'axis2d';
  /** gameplay, ui or (phase 23.10) one of the project's own maps. */
  readonly map: string;
  readonly bindings: readonly InputBindingLike[];
  readonly deadZone?: number;
  readonly invert?: boolean;
  readonly scale?: number;
}

export interface InputConfigLike {
  readonly actions: readonly InputActionLike[];
  /** Phase 23.3: the cursor while each map is active (absent: free). */
  readonly cursor?: { readonly gameplay?: 'free' | 'locked'; readonly ui?: 'free' | 'locked' };
}

/**
 * Phase 23.3: the pointer as one sample reads it — the position (fractions of
 * the view, 0,0 top left), the movement and wheel since the previous sample,
 * the held buttons and those pressed since the previous sample (bits: 1
 * left, 2 right, 4 middle).
 */
export interface RawPointerState {
  readonly x: number;
  readonly y: number;
  readonly dx: number;
  readonly dy: number;
  readonly wheel: number;
  readonly buttons: number;
  readonly pressed: number;
}

/** The raw state one sample reads (plain data). */
export interface RawDeviceState {
  /** Keys held now (`KeyboardEvent.code`). */
  readonly keys: ReadonlySet<string>;
  /** Keys that went down since the previous sample (a tap between samples still counts). */
  readonly pressedKeys: ReadonlySet<string>;
  /** The active standard-mapped pad, or null. */
  readonly gamepad: { readonly buttons: readonly boolean[]; readonly axes: readonly number[] } | null;
  /** Phase 23.3: the pointer (absent/null: none seen yet). */
  readonly pointer?: RawPointerState | null;
  /**
   * Phase 23.14: the sample's time in milliseconds (any monotonic clock) —
   * hold bindings measure how long they have been held with it. Absent: a
   * hold binding never counts.
   */
  readonly now?: number;
}

const POINTER_BUTTON_BIT: Readonly<Record<string, number>> = Object.freeze({ left: 1, right: 2, middle: 4 });
/**
 * Phase 23.3: a pointer movement axis in an action is the movement since the
 * last step in percent of the view (moving a tenth of the view in a step is
 * 10, the most an action value holds) — a stick's full push is 1, so 1% of
 * the view per step drives like a full stick; `scale` tunes it.
 */
const POINTER_AXIS_PERCENT = 100;
const clamp10 = (v: number): number => (v > 10 ? 10 : v < -10 ? -10 : v);

const DEFAULT_STICK_DEAD_ZONE = 0.2;

function deadZone(v: number, dz: number): number {
  if (!Number.isFinite(v)) return 0;
  const a = Math.abs(v);
  if (a <= dz) return 0;
  return Math.sign(v) * Math.min(1, (a - dz) / (1 - dz));
}

const q = (v: number): number => {
  const r = Math.round(v * 1e4) / 1e4;
  return r === 0 ? 0 : r;
};

/** Every key code an action's bindings use. */
export function actionKeys(action: InputActionLike): string[] {
  const out: string[] = [];
  for (const b of action.bindings) {
    for (const k of ['code', 'up', 'down', 'left', 'right'] as const) if (typeof b[k] === 'string') out.push(b[k] as string);
    if (b.kind === 'keys1d') for (const k of ['negative', 'positive'] as const) if (typeof b[k] === 'string') out.push(b[k] as string);
  }
  return out;
}

export function createActionEvaluator(config: InputConfigLike): {
  /** Phase 23.9a: `active` (absent: all) — an inactive action reads as released (its map is switched off). */
  sample(raw: RawDeviceState, active?: (action: InputActionLike) => boolean): Record<string, ActionValue>;
  /** Forget every previous state (a suspension). */
  reset(): void;
  /** Phase 23.9a: every action down at the next sample reads neutral until it is released once (a map switched back on). */
  holdUntilReleased(): void;
} {
  const prevDown = new Map<string, boolean>();
  /** Phase 23.14: when each hold binding (action#index) went down (absent: up). */
  const holdSince = new Map<string, number>();
  /**
   * Phase 23.14: a hold binding counts once it has been held `hold` seconds
   * (only held state: a tap between two samples never completes a hold).
   */
  const holdValue = (raw: RawDeviceState, id: string, down: boolean, hold: number): number => {
    if (!down || typeof raw.now !== 'number' || !Number.isFinite(raw.now)) {
      holdSince.delete(id);
      return 0;
    }
    const since = holdSince.get(id);
    if (since === undefined) {
      holdSince.set(id, raw.now);
      return hold <= 0 ? 1 : 0;
    }
    return raw.now - since >= hold * 1000 - 1e-6 ? 1 : 0;
  };
  const heldOnly = (raw: RawDeviceState, b: InputBindingLike): boolean => {
    if (b.kind === 'key') return typeof b.code === 'string' && raw.keys.has(b.code);
    if (b.kind === 'gamepadButton') return typeof b.button === 'number' && raw.gamepad?.buttons[b.button] === true;
    if (b.kind === 'pointerButton') {
      const bit = POINTER_BUTTON_BIT[String(b.button)] ?? 0;
      return raw.pointer !== undefined && raw.pointer !== null && (raw.pointer.buttons & bit) !== 0;
    }
    return false;
  };
  let holdNext = false;
  const held = new Set<string>();
  const key = (raw: RawDeviceState, code: string | number | undefined): number => (typeof code === 'string' && (raw.keys.has(code) || raw.pressedKeys.has(code)) ? 1 : 0);
  const pad = (raw: RawDeviceState, button: number | string | undefined): number => (typeof button === 'number' && raw.gamepad?.buttons[button] === true ? 1 : 0);
  const axisOf = (raw: RawDeviceState, axis: number | undefined): number => {
    const v = typeof axis === 'number' ? raw.gamepad?.axes[axis] : undefined;
    return typeof v === 'number' && Number.isFinite(v) ? v : 0;
  };

  const pointerButton = (raw: RawDeviceState, button: unknown): number => {
    const bit = POINTER_BUTTON_BIT[String(button)] ?? 0;
    const p = raw.pointer;
    return p !== undefined && p !== null && ((p.buttons | p.pressed) & bit) !== 0 ? 1 : 0;
  };
  const pointerAxis = (raw: RawDeviceState, axis: unknown): number => {
    const p = raw.pointer;
    if (p === undefined || p === null) return 0;
    if (axis === 'x') return clamp10(p.dx * POINTER_AXIS_PERCENT);
    if (axis === 'y') return clamp10(-p.dy * POINTER_AXIS_PERCENT); // up positive, like a stick
    if (axis === 'wheel') return clamp10(p.wheel);
    return 0;
  };

  const evaluate = (a: InputActionLike, raw: RawDeviceState): { v: number; x?: number; y?: number; i?: 1 } => {
    if (a.type === 'axis2d') {
      let best: [number, number] = [0, 0];
      // Phase 23.3: a pointer position / movement is taken as it is (no length clip) and a movement is per sample.
      let bestKind = '';
      for (const b of a.bindings) {
        let x = 0;
        let y = 0;
        if (b.kind === 'pointerPosition') {
          const p = raw.pointer;
          if (p === undefined || p === null) continue;
          x = p.x;
          y = p.y;
        } else if (b.kind === 'pointerDelta') {
          x = pointerAxis(raw, 'x');
          y = pointerAxis(raw, 'y');
        } else if (b.kind === 'keys2d') {
          x = key(raw, b.right) - key(raw, b.left);
          y = key(raw, b.up) - key(raw, b.down);
        } else if (b.kind === 'gamepadStick') {
          x = axisOf(raw, b.x);
          y = -axisOf(raw, b.y); // a stick's y axis is down-positive
          const len = Math.hypot(x, y);
          const dz = a.deadZone ?? DEFAULT_STICK_DEAD_ZONE;
          const scaled = deadZone(len, dz);
          x = len > 0 ? (x / len) * scaled : 0;
          y = len > 0 ? (y / len) * scaled : 0;
        }
        if (Math.hypot(x, y) > Math.hypot(best[0], best[1]) || (b.kind === 'pointerPosition' && bestKind === '')) {
          best = [x, y];
          bestKind = b.kind;
        }
      }
      let [x, y] = best;
      const len = Math.hypot(x, y);
      if (len > 1 && bestKind !== 'pointerPosition' && bestKind !== 'pointerDelta') {
        x /= len;
        y /= len;
      }
      const s = (a.invert === true ? -1 : 1) * (a.scale ?? 1);
      x = q(clamp10(x * s));
      y = q(clamp10(y * s));
      return { v: q(clamp10(Math.hypot(x, y))), x, y, ...(bestKind === 'pointerDelta' ? { i: 1 as const } : {}) };
    }
    let best = 0;
    let impulse = false;
    for (let bi = 0; bi < a.bindings.length; bi += 1) {
      const b = a.bindings[bi]!;
      let v = 0;
      if (typeof b.hold === 'number' && (b.kind === 'key' || b.kind === 'gamepadButton' || b.kind === 'pointerButton')) v = holdValue(raw, `${a.name}#${bi}`, heldOnly(raw, b), b.hold);
      else if (b.kind === 'pointerButton') v = pointerButton(raw, b.button);
      else if (b.kind === 'pointerAxis') {
        v = pointerAxis(raw, b.axis);
        if (Math.abs(v) > Math.abs(best)) {
          best = v;
          impulse = true;
        }
        continue;
      } else if (b.kind === 'key') v = key(raw, b.code);
      else if (b.kind === 'gamepadButton') v = pad(raw, b.button);
      else if (b.kind === 'keys1d') v = key(raw, b.positive) - key(raw, b.negative);
      else if (b.kind === 'gamepadButtons1d') v = pad(raw, b.positive) - pad(raw, b.negative);
      else if (b.kind === 'gamepadAxis') v = deadZone(axisOf(raw, typeof b.axis === 'number' ? b.axis : undefined), a.deadZone ?? DEFAULT_STICK_DEAD_ZONE);
      if (Math.abs(v) > Math.abs(best)) {
        best = v;
        impulse = false;
      }
    }
    const s = (a.invert === true ? -1 : 1) * (a.scale ?? 1);
    // A pointer axis may exceed a stick's range (up to 10); everything else stays within [-1, 1].
    if (impulse) return { v: q(clamp10(best * s)), i: 1 };
    return { v: q(Math.max(-1, Math.min(1, best)) * s) };
  };

  return {
    sample(raw, active) {
      const out: Record<string, ActionValue> = {};
      for (const a of config.actions) {
        let e = active === undefined || active(a) ? evaluate(a, raw) : a.type === 'axis2d' ? { v: 0, x: 0, y: 0 } : { v: 0 };
        let down = a.type === 'button' ? e.v !== 0 : Math.abs(e.v) > 0.5;
        if (holdNext && down) held.add(a.name);
        if (held.has(a.name)) {
          if (down) {
            e = a.type === 'axis2d' ? { v: 0, x: 0, y: 0 } : { v: 0 };
            down = false;
          } else held.delete(a.name);
        }
        const was = prevDown.get(a.name) ?? false;
        const p: JumpPhase = down ? (was ? 'held' : 'pressed') : was ? 'released' : 'none';
        prevDown.set(a.name, down);
        out[a.name] = Object.freeze({ v: e.v, ...(e.x !== undefined ? { x: e.x, y: e.y! } : {}), p, ...(e.i === 1 ? { i: 1 as const } : {}) });
      }
      holdNext = false;
      return out;
    },
    reset() {
      prevDown.clear();
      holdSince.clear();
      held.clear();
    },
    holdUntilReleased() {
      holdNext = true;
    },
  };
}

/**
 * Phase 23.3: what the browser does with the cursor — lock it (pointer lock)
 * in locked mode; hide it when locked or while a gamepad is the device the
 * player used last (it shows again when the pointer or a key is used).
 */
export function cursorPresentation(mode: 'free' | 'locked', device: 'keyboard' | 'gamepad'): { lock: boolean; hide: boolean } {
  return { lock: mode === 'locked', hide: mode === 'locked' || device === 'gamepad' };
}

/** Phase 23.3: whether an action binds a pointer button (right: the view's context menu is suppressed then). */
export function bindsPointerButton(config: InputConfigLike, button: 'left' | 'right' | 'middle'): boolean {
  return config.actions.some((a) => a.bindings.some((b) => b.kind === 'pointerButton' && (b as { button?: unknown }).button === button));
}

/** Phase 23.3: whether an action binds the wheel (the view then keeps the wheel from scrolling the page). */
export function bindsWheel(config: InputConfigLike): boolean {
  return config.actions.some((a) => a.bindings.some((b) => b.kind === 'pointerAxis' && (b as { axis?: unknown }).axis === 'wheel'));
}

/** The keyboard codes the platformer's move and jump come from (the M2 mapping reads these). */
export function platformerKeys(config: InputConfigLike): { left: string[]; right: string[]; jump: string[] } {
  const move = config.actions.find((a) => a.name === 'move');
  const jump = config.actions.find((a) => a.name === 'jump');
  const left: string[] = [];
  const right: string[] = [];
  for (const b of move?.bindings ?? []) {
    if (b.kind === 'keys1d') {
      if (typeof b.negative === 'string') left.push(b.negative);
      if (typeof b.positive === 'string') right.push(b.positive);
    } else if (b.kind === 'key' && typeof b.code === 'string' && b.hold === undefined) right.push(b.code);
  }
  // Phase 23.14: a hold binding counts in the action values only (the platformer reads its keys directly).
  const jumpKeys = (jump?.bindings ?? []).filter((b) => b.kind === 'key' && typeof b.code === 'string' && b.hold === undefined).map((b) => b.code as string);
  return { left, right, jump: jumpKeys };
}

/** Phase 14.5: the pad controls the platformer's move and jump come from. */
export interface PlatformerPad {
  /** Buttons that jump (any held = jump down). */
  readonly jump: readonly number[];
  /** Buttons that move left / right (digital, like the D-pad). */
  readonly left: readonly number[];
  readonly right: readonly number[];
  /** Stick axes that move (the one pushed furthest wins). */
  readonly axes: readonly number[];
}

/** The standard layout the platformer used before pad rebinding: A jumps, D-pad left/right and the left stick move. */
export const STANDARD_PLATFORMER_PAD: PlatformerPad = Object.freeze({ jump: Object.freeze([0]), left: Object.freeze([14]), right: Object.freeze([15]), axes: Object.freeze([0]) });

const PAD_BUTTON_MAX = 31;
const padIndex = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= PAD_BUTTON_MAX;

/**
 * Phase 14.5: the pad buttons and axes of the project's `move` and `jump`
 * actions (`gamepadButton`, `gamepadButtons1d`, `gamepadAxis` bindings). A
 * part with no pad binding of its kind keeps the standard layout — so every
 * project made before pad rebinding (whose pad bindings were never read)
 * plays exactly as before; a rebinding replaces the part.
 */
export function platformerPad(config: InputConfigLike): PlatformerPad {
  const move = config.actions.find((a) => a.name === 'move');
  const jump = config.actions.find((a) => a.name === 'jump');
  const jumpButtons = (jump?.bindings ?? []).filter((b) => b.kind === 'gamepadButton' && padIndex(b.button) && b.hold === undefined).map((b) => b.button as number);
  const left: number[] = [];
  const right: number[] = [];
  const axes: number[] = [];
  for (const b of move?.bindings ?? []) {
    if (b.kind === 'gamepadButtons1d') {
      if (padIndex(b.negative)) left.push(b.negative);
      if (padIndex(b.positive)) right.push(b.positive);
    } else if (b.kind === 'gamepadAxis' && padIndex(b.axis)) axes.push(b.axis);
  }
  const hasButtons = (move?.bindings ?? []).some((b) => b.kind === 'gamepadButtons1d');
  return {
    jump: jumpButtons.length > 0 ? jumpButtons : STANDARD_PLATFORMER_PAD.jump,
    left: hasButtons ? left : STANDARD_PLATFORMER_PAD.left,
    right: hasButtons ? right : STANDARD_PLATFORMER_PAD.right,
    axes: axes.length > 0 ? axes : STANDARD_PLATFORMER_PAD.axes,
  };
}

/**
 * Phase 14.5: reduce one pad's buttons and axes to the platformer's jump,
 * left, right and stick values through `pad` (pure; the fake pads of the
 * tests and the browser owner both go through here).
 */
export function readPlatformerPad(pad: PlatformerPad, buttons: readonly boolean[], axes: readonly number[], ignoreButtons?: ReadonlySet<number>): { jump: boolean; left: boolean; right: boolean; axis: number } {
  const down = (i: number): boolean => buttons[i] === true && ignoreButtons?.has(i) !== true;
  let axis = 0;
  for (const i of pad.axes) {
    const v = axes[i];
    if (typeof v === 'number' && Number.isFinite(v) && Math.abs(v) > Math.abs(axis)) axis = v;
  }
  return { jump: pad.jump.some(down), left: pad.left.some(down), right: pad.right.some(down), axis };
}

/**
 * The default actions (a copy of project-model's `DEFAULT_INPUT`, which the
 * editor may not import as a value; tests/input-defaults-parity.test.ts keeps
 * them equal): today's controls plus attack, interact, pause, submit, cancel
 * and navigate.
 */
export const DEFAULT_INPUT_CONFIG: InputConfigLike = Object.freeze({
  actions: [
    { name: 'move', type: 'axis1d', map: 'gameplay', bindings: [{ kind: 'keys1d', negative: 'KeyA', positive: 'KeyD' }, { kind: 'keys1d', negative: 'ArrowLeft', positive: 'ArrowRight' }, { kind: 'gamepadButtons1d', negative: 14, positive: 15 }, { kind: 'gamepadAxis', axis: 0 }] },
    { name: 'jump', type: 'button', map: 'gameplay', bindings: [{ kind: 'key', code: 'Space' }, { kind: 'gamepadButton', button: 0 }] },
    { name: 'attack', type: 'button', map: 'gameplay', bindings: [{ kind: 'key', code: 'KeyJ' }, { kind: 'gamepadButton', button: 2 }] },
    { name: 'interact', type: 'button', map: 'gameplay', bindings: [{ kind: 'key', code: 'KeyE' }, { kind: 'gamepadButton', button: 3 }] },
    { name: 'pause', type: 'button', map: 'ui', bindings: [{ kind: 'key', code: 'Escape' }, { kind: 'gamepadButton', button: 9 }] },
    { name: 'submit', type: 'button', map: 'ui', bindings: [{ kind: 'key', code: 'Enter' }, { kind: 'gamepadButton', button: 0 }] },
    { name: 'cancel', type: 'button', map: 'ui', bindings: [{ kind: 'key', code: 'Backspace' }, { kind: 'gamepadButton', button: 1 }] },
    { name: 'navigate', type: 'axis2d', map: 'ui', bindings: [{ kind: 'keys2d', up: 'ArrowUp', down: 'ArrowDown', left: 'ArrowLeft', right: 'ArrowRight' }, { kind: 'keys2d', up: 'KeyW', down: 'KeyS', left: 'KeyA', right: 'KeyD' }, { kind: 'gamepadStick', x: 0, y: 1 }] },
  ],
} as InputConfigLike);

/**
 * Phase 23.2: the default actions of a 3D project (a copy of project-model's
 * `DEFAULT_INPUT_3D`; tests/input-defaults-parity.test.ts keeps them equal):
 * `move` is a 2D axis (W/A/S/D, arrows, left stick) and `run` a button.
 */
export const DEFAULT_INPUT_CONFIG_3D: InputConfigLike = Object.freeze({
  actions: [
    { name: 'move', type: 'axis2d', map: 'gameplay', bindings: [{ kind: 'keys2d', up: 'KeyW', down: 'KeyS', left: 'KeyA', right: 'KeyD' }, { kind: 'keys2d', up: 'ArrowUp', down: 'ArrowDown', left: 'ArrowLeft', right: 'ArrowRight' }, { kind: 'gamepadStick', x: 0, y: 1 }] },
    { name: 'run', type: 'button', map: 'gameplay', bindings: [{ kind: 'key', code: 'ShiftLeft' }, { kind: 'key', code: 'ShiftRight' }, { kind: 'gamepadButton', button: 10 }] },
    ...DEFAULT_INPUT_CONFIG.actions.filter((a) => a.name !== 'move'),
  ],
} as InputConfigLike);
