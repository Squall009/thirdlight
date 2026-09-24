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
  readonly button?: number;
  readonly axis?: number;
  readonly negative?: string | number;
  readonly positive?: string | number;
  readonly up?: string;
  readonly down?: string;
  readonly left?: string;
  readonly right?: string;
  readonly x?: number;
  readonly y?: number;
}

export interface InputActionLike {
  readonly name: string;
  readonly type: 'button' | 'axis1d' | 'axis2d';
  readonly map: 'gameplay' | 'ui';
  readonly bindings: readonly InputBindingLike[];
  readonly deadZone?: number;
  readonly invert?: boolean;
  readonly scale?: number;
}

export interface InputConfigLike {
  readonly actions: readonly InputActionLike[];
}

/** The raw state one sample reads (plain data). */
export interface RawDeviceState {
  /** Keys held now (`KeyboardEvent.code`). */
  readonly keys: ReadonlySet<string>;
  /** Keys that went down since the previous sample (a tap between samples still counts). */
  readonly pressedKeys: ReadonlySet<string>;
  /** The active standard-mapped pad, or null. */
  readonly gamepad: { readonly buttons: readonly boolean[]; readonly axes: readonly number[] } | null;
}

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
  sample(raw: RawDeviceState): Record<string, ActionValue>;
  /** Forget every previous state (a suspension). */
  reset(): void;
} {
  const prevDown = new Map<string, boolean>();
  const key = (raw: RawDeviceState, code: string | number | undefined): number => (typeof code === 'string' && (raw.keys.has(code) || raw.pressedKeys.has(code)) ? 1 : 0);
  const pad = (raw: RawDeviceState, button: number | string | undefined): number => (typeof button === 'number' && raw.gamepad?.buttons[button] === true ? 1 : 0);
  const axisOf = (raw: RawDeviceState, axis: number | undefined): number => {
    const v = typeof axis === 'number' ? raw.gamepad?.axes[axis] : undefined;
    return typeof v === 'number' && Number.isFinite(v) ? v : 0;
  };

  const evaluate = (a: InputActionLike, raw: RawDeviceState): { v: number; x?: number; y?: number } => {
    if (a.type === 'axis2d') {
      let best: [number, number] = [0, 0];
      for (const b of a.bindings) {
        let x = 0;
        let y = 0;
        if (b.kind === 'keys2d') {
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
        if (Math.hypot(x, y) > Math.hypot(best[0], best[1])) best = [x, y];
      }
      let [x, y] = best;
      const len = Math.hypot(x, y);
      if (len > 1) {
        x /= len;
        y /= len;
      }
      const s = (a.invert === true ? -1 : 1) * (a.scale ?? 1);
      x = q(x * s);
      y = q(y * s);
      return { v: q(Math.hypot(x, y)), x, y };
    }
    let best = 0;
    for (const b of a.bindings) {
      let v = 0;
      if (b.kind === 'key') v = key(raw, b.code);
      else if (b.kind === 'gamepadButton') v = pad(raw, b.button);
      else if (b.kind === 'keys1d') v = key(raw, b.positive) - key(raw, b.negative);
      else if (b.kind === 'gamepadButtons1d') v = pad(raw, b.positive) - pad(raw, b.negative);
      else if (b.kind === 'gamepadAxis') v = deadZone(axisOf(raw, b.axis), a.deadZone ?? DEFAULT_STICK_DEAD_ZONE);
      if (Math.abs(v) > Math.abs(best)) best = v;
    }
    const s = (a.invert === true ? -1 : 1) * (a.scale ?? 1);
    return { v: q(Math.max(-1, Math.min(1, best)) * s) };
  };

  return {
    sample(raw) {
      const out: Record<string, ActionValue> = {};
      for (const a of config.actions) {
        const e = evaluate(a, raw);
        const down = a.type === 'button' ? e.v !== 0 : Math.abs(e.v) > 0.5;
        const was = prevDown.get(a.name) ?? false;
        const p: JumpPhase = down ? (was ? 'held' : 'pressed') : was ? 'released' : 'none';
        prevDown.set(a.name, down);
        out[a.name] = Object.freeze({ v: e.v, ...(e.x !== undefined ? { x: e.x, y: e.y! } : {}), p });
      }
      return out;
    },
    reset() {
      prevDown.clear();
    },
  };
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
    } else if (b.kind === 'key' && typeof b.code === 'string') right.push(b.code);
  }
  const jumpKeys = (jump?.bindings ?? []).filter((b) => b.kind === 'key' && typeof b.code === 'string').map((b) => b.code as string);
  return { left, right, jump: jumpKeys };
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
