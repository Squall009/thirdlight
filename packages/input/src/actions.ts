/**
 * Named input actions from raw device state.
 *
 * Pure apart from each action's previous "down" bit (for its phase), which
 * the evaluator keeps. Bindings never add up: an action takes the binding
 * with the largest magnitude. A 1D axis from
 * a stick gets a radial dead zone (default `GAMEPAD_DEAD_ZONE`) and is rescaled; 2D axes are
 * clipped to length 1. `invert` and `scale` apply last. A button — or an axis
 * past 0.5 — is "down"; its phase is pressed / held / released / none.
 */
import { DEFAULT_INPUT, DEFAULT_INPUT_3D } from '@thirdlight/project-model/input';
import type { ActionValue, JumpPhase } from '@thirdlight/runtime';
import { GAMEPAD_DEAD_ZONE } from './types';

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
  /** Hold instead of tap — seconds a key/button binding must be held before it counts. */
  readonly hold?: number;
  /**
   * A gamepad binding of one pad — its slot in `navigator.getGamepads()`
   * (each player of a local co-op game on their own pad). Absent: the pad
   * the player used last.
   */
  readonly pad?: number;
}

export interface InputActionLike {
  readonly name: string;
  readonly type: 'button' | 'axis1d' | 'axis2d';
  /** gameplay, ui or one of the project's own maps. */
  readonly map: string;
  readonly bindings: readonly InputBindingLike[];
  readonly deadZone?: number;
  readonly invert?: boolean;
  readonly scale?: number;
}

export interface InputConfigLike {
  readonly actions: readonly InputActionLike[];
  /** The cursor while each map is active (absent: free). */
  readonly cursor?: { readonly [map: string]: 'free' | 'locked' | undefined };
}

/**
 * The pointer as one sample reads it — the position (fractions of
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
  /** Every standard-mapped pad by its slot (`navigator.getGamepads()` index; null: none there) — what a binding naming a `pad` reads. */
  readonly pads?: readonly ({ readonly buttons: readonly boolean[]; readonly axes: readonly number[] } | null)[];
  /** The pointer (absent/null: none seen yet). */
  readonly pointer?: RawPointerState | null;
  /**
   * The sample's time in milliseconds (any monotonic clock) —
   * hold bindings measure how long they have been held with it. Absent: a
   * hold binding never counts.
   */
  readonly now?: number;
}

const POINTER_BUTTON_BIT: Readonly<Record<string, number>> = Object.freeze({ left: 1, right: 2, middle: 4 });
/**
 * A pointer movement axis in an action is the movement since the
 * last step in percent of the view (moving a tenth of the view in a step is
 * 10, the most an action value holds) — a stick's full push is 1, so 1% of
 * the view per step drives like a full stick; `scale` tunes it.
 */
const POINTER_AXIS_PERCENT = 100;
const clamp10 = (v: number): number => (v > 10 ? 10 : v < -10 ? -10 : v);

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
  /**
   * `active` (absent: all) — an inactive action reads as released (its map is switched off).
   * `game` (absent: `raw`) — what the actions outside the `ui` map read: the browser hides a menu
   * confirm the host consumed and that is still held, so one press never both confirms and acts.
   */
  sample(raw: RawDeviceState, active?: (action: InputActionLike) => boolean, game?: RawDeviceState): Record<string, ActionValue>;
  /** Forget every previous state (a suspension). */
  reset(): void;
  /** Every action down at the next sample reads neutral until it is released once (a map switched back on). */
  holdUntilReleased(): void;
  /**
   * Every action down at the next sample reads `held`, never `pressed`, until it is released once,
   * and that release reads `none` (focus came back or the pad changed: no press was seen, so none is reported).
   */
  freshActivation(): void;
} {
  const prevDown = new Map<string, boolean>();
  /** When each hold binding (action#index) went down (absent: up). */
  const holdSince = new Map<string, number>();
  /**
   * A hold binding counts once it has been held `hold` seconds
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
  /** The pad a gamepad binding reads: its own slot's, else the active pad. */
  const padOf = (raw: RawDeviceState, b: InputBindingLike): RawDeviceState['gamepad'] => (typeof b.pad === 'number' ? (raw.pads?.[b.pad] ?? null) : raw.gamepad);
  const heldOnly = (raw: RawDeviceState, b: InputBindingLike): boolean => {
    if (b.kind === 'key') return typeof b.code === 'string' && raw.keys.has(b.code);
    if (b.kind === 'gamepadButton') return typeof b.button === 'number' && padOf(raw, b)?.buttons[b.button] === true;
    if (b.kind === 'pointerButton') {
      const bit = POINTER_BUTTON_BIT[String(b.button)] ?? 0;
      return raw.pointer !== undefined && raw.pointer !== null && (raw.pointer.buttons & bit) !== 0;
    }
    return false;
  };
  let holdNext = false;
  const held = new Set<string>();
  const key = (raw: RawDeviceState, code: string | number | undefined): number => (typeof code === 'string' && (raw.keys.has(code) || raw.pressedKeys.has(code)) ? 1 : 0);
  const pad = (gp: RawDeviceState['gamepad'], button: number | string | undefined): number => (typeof button === 'number' && gp?.buttons[button] === true ? 1 : 0);
  const axisOf = (gp: RawDeviceState['gamepad'], axis: number | undefined): number => {
    const v = typeof axis === 'number' ? gp?.axes[axis] : undefined;
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
      // A pointer position / movement is taken as it is (no length clip) and a movement is per sample.
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
          x = axisOf(padOf(raw, b), b.x);
          y = -axisOf(padOf(raw, b), b.y); // a stick's y axis is down-positive
          const len = Math.hypot(x, y);
          const dz = a.deadZone ?? GAMEPAD_DEAD_ZONE;
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
      else if (b.kind === 'gamepadButton') v = pad(padOf(raw, b), b.button);
      else if (b.kind === 'keys1d') v = key(raw, b.positive) - key(raw, b.negative);
      else if (b.kind === 'gamepadButtons1d') v = pad(padOf(raw, b), b.positive) - pad(padOf(raw, b), b.negative);
      else if (b.kind === 'gamepadAxis') v = deadZone(axisOf(padOf(raw, b), typeof b.axis === 'number' ? b.axis : undefined), a.deadZone ?? GAMEPAD_DEAD_ZONE);
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

  let freshNext = false;
  /** Actions down since a fresh activation, not yet released. */
  const fresh = new Set<string>();
  return {
    sample(raw, active, game) {
      const out: Record<string, ActionValue> = {};
      for (const a of config.actions) {
        let e = active === undefined || active(a) ? evaluate(a, game !== undefined && a.map !== 'ui' ? game : raw) : a.type === 'axis2d' ? { v: 0, x: 0, y: 0 } : { v: 0 };
        let down = a.type === 'button' ? e.v !== 0 : Math.abs(e.v) > 0.5;
        if (holdNext && down) held.add(a.name);
        if (held.has(a.name)) {
          if (down) {
            e = a.type === 'axis2d' ? { v: 0, x: 0, y: 0 } : { v: 0 };
            down = false;
          } else held.delete(a.name);
        }
        if (freshNext && down) fresh.add(a.name);
        const was = prevDown.get(a.name) ?? false;
        let p: JumpPhase = down ? (was ? 'held' : 'pressed') : was ? 'released' : 'none';
        if (fresh.has(a.name)) {
          p = down ? 'held' : 'none';
          if (!down) fresh.delete(a.name);
        }
        prevDown.set(a.name, down);
        out[a.name] = Object.freeze({ v: e.v, ...(e.x !== undefined ? { x: e.x, y: e.y! } : {}), p, ...(e.i === 1 ? { i: 1 as const } : {}) });
      }
      holdNext = false;
      freshNext = false;
      return out;
    },
    reset() {
      prevDown.clear();
      holdSince.clear();
      held.clear();
      fresh.clear();
    },
    holdUntilReleased() {
      holdNext = true;
    },
    freshActivation() {
      freshNext = true;
    },
  };
}

/**
 * What the browser does with the cursor — lock it (pointer lock)
 * in locked mode; hide it when locked or while a gamepad is the device the
 * player used last (it shows again when the pointer or a key is used).
 */
export function cursorPresentation(mode: 'free' | 'locked', device: 'keyboard' | 'gamepad'): { lock: boolean; hide: boolean } {
  return { lock: mode === 'locked', hide: mode === 'locked' || device === 'gamepad' };
}

/** Whether an action binds a pointer button (right: the view's context menu is suppressed then). */
export function bindsPointerButton(config: InputConfigLike, button: 'left' | 'right' | 'middle'): boolean {
  return config.actions.some((a) => a.bindings.some((b) => b.kind === 'pointerButton' && (b as { button?: unknown }).button === button));
}

/** Whether an action binds the wheel (the view then keeps the wheel from scrolling the page). */
export function bindsWheel(config: InputConfigLike): boolean {
  return config.actions.some((a) => a.bindings.some((b) => b.kind === 'pointerAxis' && (b as { axis?: unknown }).axis === 'wheel'));
}

/** The default actions (project-model's, defined once there), seen through this package's structural shape. */
export const DEFAULT_INPUT_CONFIG: InputConfigLike = DEFAULT_INPUT as InputConfigLike;

/** The default actions of a 3D project (project-model's): `move` is a 2D axis and `run` a button. */
export const DEFAULT_INPUT_CONFIG_3D: InputConfigLike = DEFAULT_INPUT_3D as InputConfigLike;
