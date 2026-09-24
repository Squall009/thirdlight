/**
 * Phase 9.8: input actions (`content.input`).
 *
 * The game reads named actions instead of keys: `move` (a 1D axis), `jump`,
 * `attack`, `interact`, `pause`, `submit`, `cancel` (buttons), `navigate`
 * (a 2D axis) and any the project adds. Each action lists its bindings —
 * keyboard keys (`KeyboardEvent.code`), standard-mapped gamepad buttons and
 * axes, and composites (two keys → a 1D axis, four → a 2D axis) — and
 * optional processors (dead zone, invert, scale). Actions belong to a map:
 * `gameplay` (read by the game) or `ui` (menus).
 */
import type { ModelErrorV2 } from './errors';

export type InputActionType = 'button' | 'axis1d' | 'axis2d';
export const INPUT_ACTION_TYPES = ['button', 'axis1d', 'axis2d'] as const;
export const INPUT_MAPS = ['gameplay', 'ui'] as const;

export type InputBinding =
  | { kind: 'key'; code: string }
  | { kind: 'gamepadButton'; button: number }
  | { kind: 'gamepadAxis'; axis: number }
  | { kind: 'keys1d'; negative: string; positive: string }
  | { kind: 'keys2d'; up: string; down: string; left: string; right: string }
  | { kind: 'gamepadButtons1d'; negative: number; positive: number }
  | { kind: 'gamepadStick'; x: number; y: number };

export interface InputAction {
  name: string;
  type: InputActionType;
  map: 'gameplay' | 'ui';
  bindings: InputBinding[];
  /** Axis values within this are 0 (then rescaled); default 0.2 for stick axes. */
  deadZone?: number;
  invert?: boolean;
  scale?: number;
}

export interface InputConfig {
  actions: InputAction[];
}

export const MAX_INPUT_ACTIONS = 32;
export const MAX_INPUT_BINDINGS = 8;

const NAME_RE = /^[A-Za-z_][A-Za-z0-9_]{0,31}$/;
const CODE_RE = /^[A-Za-z0-9]{1,32}$/;

/** Today's controls, plus the actions menus and gameplay blocks use. */
export const DEFAULT_INPUT: Readonly<InputConfig> = Object.freeze({
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
} as InputConfig);

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
function err(errors: ModelErrorV2[], code: string, path: string, message: string, found?: unknown, expected?: string): void {
  errors.push({ code, path, message, ...(found !== undefined ? { found } : {}), ...(expected !== undefined ? { expected } : {}) } as ModelErrorV2);
}
const button = (v: unknown): boolean => typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= 31;
const axis = (v: unknown): boolean => typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= 7;
const code = (v: unknown): boolean => typeof v === 'string' && CODE_RE.test(v);

const BINDING_KEYS: Record<InputBinding['kind'], readonly string[]> = {
  key: ['code'],
  gamepadButton: ['button'],
  gamepadAxis: ['axis'],
  keys1d: ['negative', 'positive'],
  keys2d: ['up', 'down', 'left', 'right'],
  gamepadButtons1d: ['negative', 'positive'],
  gamepadStick: ['x', 'y'],
};
/** Which bindings fit which action type. */
const FITS: Record<InputActionType, readonly InputBinding['kind'][]> = {
  button: ['key', 'gamepadButton'],
  axis1d: ['keys1d', 'gamepadButtons1d', 'gamepadAxis', 'key', 'gamepadButton'],
  axis2d: ['keys2d', 'gamepadStick'],
};

export function validateInput(value: unknown, path: string, errors: ModelErrorV2[]): void {
  if (!isPlainObject(value)) return err(errors, 'field_type', path, 'input is { actions }', value);
  for (const k of Object.keys(value)) if (k !== 'actions') err(errors, 'field_unexpected', `${path}/${k}`, `unknown field "${k}"`, k, 'actions');
  const actions = value['actions'];
  if (!Array.isArray(actions) || actions.length > MAX_INPUT_ACTIONS) return err(errors, 'field_value', `${path}/actions`, `actions is a list of at most ${MAX_INPUT_ACTIONS}`, actions);
  const names = new Set<string>();
  actions.forEach((a, i) => {
    const p = `${path}/actions/${i}`;
    if (!isPlainObject(a)) return err(errors, 'field_type', p, 'an action is an object', a);
    const ACTION_KEYS = ['name', 'type', 'map', 'bindings', 'deadZone', 'invert', 'scale'];
    for (const k of Object.keys(a)) if (!ACTION_KEYS.includes(k)) err(errors, 'field_unexpected', `${p}/${k}`, `unknown field "${k}"`, k, ACTION_KEYS.join(', '));
    if (typeof a['name'] !== 'string' || !NAME_RE.test(a['name'])) err(errors, 'field_value', `${p}/name`, 'an action name is a letter or _ then up to 31 letters, digits or _', a['name']);
    else if (names.has(a['name'])) err(errors, 'field_value', `${p}/name`, 'action names are unique', a['name']);
    else names.add(a['name']);
    const type = a['type'] as InputActionType;
    if (!(INPUT_ACTION_TYPES as readonly unknown[]).includes(type)) return err(errors, 'field_value', `${p}/type`, 'type is button, axis1d or axis2d', type);
    if (!(INPUT_MAPS as readonly unknown[]).includes(a['map'])) err(errors, 'field_value', `${p}/map`, 'map is gameplay or ui', a['map']);
    if (a['deadZone'] !== undefined && !(typeof a['deadZone'] === 'number' && a['deadZone'] >= 0 && a['deadZone'] < 1)) err(errors, 'field_value', `${p}/deadZone`, 'deadZone is in [0, 1)', a['deadZone']);
    if (a['invert'] !== undefined && typeof a['invert'] !== 'boolean') err(errors, 'field_type', `${p}/invert`, 'invert is true or false', a['invert']);
    if (a['scale'] !== undefined && !(typeof a['scale'] === 'number' && Number.isFinite(a['scale']) && a['scale'] > 0 && a['scale'] <= 10)) err(errors, 'field_value', `${p}/scale`, 'scale is in (0, 10]', a['scale']);
    const bindings = a['bindings'];
    if (!Array.isArray(bindings) || bindings.length > MAX_INPUT_BINDINGS) return err(errors, 'field_value', `${p}/bindings`, `bindings is a list of at most ${MAX_INPUT_BINDINGS}`, bindings);
    bindings.forEach((b, j) => {
      const bp = `${p}/bindings/${j}`;
      if (!isPlainObject(b)) return err(errors, 'field_type', bp, 'a binding is an object', b);
      const kind = b['kind'] as InputBinding['kind'];
      const keys = BINDING_KEYS[kind];
      if (keys === undefined) return err(errors, 'field_value', `${bp}/kind`, 'kind is key, gamepadButton, gamepadAxis, keys1d, keys2d, gamepadButtons1d or gamepadStick', kind);
      if (!FITS[type].includes(kind)) return err(errors, 'field_value', `${bp}/kind`, `a ${kind} binding does not fit a ${type} action`, kind);
      for (const k of Object.keys(b)) if (k !== 'kind' && !keys.includes(k)) err(errors, 'field_unexpected', `${bp}/${k}`, `unknown field "${k}"`, k, ['kind', ...keys].join(', '));
      for (const k of keys) {
        const v = b[k];
        const ok = kind === 'key' || kind === 'keys1d' || kind === 'keys2d' ? code(v) : kind === 'gamepadAxis' || kind === 'gamepadStick' ? axis(v) : button(v);
        if (!ok) err(errors, 'field_value', `${bp}/${k}`, kind.startsWith('key') ? 'a KeyboardEvent.code' : kind === 'gamepadAxis' || kind === 'gamepadStick' ? 'a gamepad axis index 0–7' : 'a gamepad button index 0–31', v);
      }
    });
  });
}

export function canonicalInput(c: InputConfig): InputConfig {
  return {
    actions: c.actions.map((a) => ({
      name: a.name,
      type: a.type,
      map: a.map,
      bindings: a.bindings.map((b) => ({ ...b })),
      ...(a.deadZone !== undefined ? { deadZone: a.deadZone } : {}),
      ...(a.invert !== undefined ? { invert: a.invert } : {}),
      ...(a.scale !== undefined ? { scale: a.scale } : {}),
    })),
  };
}
