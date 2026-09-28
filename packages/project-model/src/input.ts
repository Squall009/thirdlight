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
  | { kind: 'key'; code: string; hold?: number }
  | { kind: 'gamepadButton'; button: number; hold?: number }
  | { kind: 'gamepadAxis'; axis: number }
  | { kind: 'keys1d'; negative: string; positive: string }
  | { kind: 'keys2d'; up: string; down: string; left: string; right: string }
  | { kind: 'gamepadButtons1d'; negative: number; positive: number }
  | { kind: 'gamepadStick'; x: number; y: number }
  // Phase 23.3: the pointer (mouse, pen or touch). A button, the position in
  // the view (x, y 0–1 from the top left), the movement this step (a 2D axis,
  // up positive like a stick) or one axis of it (x, y up positive, or the wheel).
  | { kind: 'pointerButton'; button: PointerButtonName; hold?: number }
  | { kind: 'pointerPosition' }
  | { kind: 'pointerDelta' }
  | { kind: 'pointerAxis'; axis: PointerAxisName };

/** Phase 23.3: the pointer buttons an action binds. */
export type PointerButtonName = 'left' | 'right' | 'middle';
export const POINTER_BUTTONS = ['left', 'right', 'middle'] as const;
/** Phase 23.3: one axis of the pointer's movement (x, y) or the wheel. */
export type PointerAxisName = 'x' | 'y' | 'wheel';
export const POINTER_AXES = ['x', 'y', 'wheel'] as const;
/** Phase 23.3: the cursor while a map is active — free (visible, moves) or locked (hidden, held in the view; the movement still counts). */
export type CursorMode = 'free' | 'locked';
export const CURSOR_MODES = ['free', 'locked'] as const;

export interface InputAction {
  name: string;
  type: InputActionType;
  /** The map it belongs to: gameplay, ui, or (phase 23.10) one of the project's `maps`. */
  map: InputMapName;
  bindings: InputBinding[];
  /** Axis values within this are 0 (then rescaled); default 0.2 for stick axes. */
  deadZone?: number;
  invert?: boolean;
  scale?: number;
}

/** Phase 23.10: an input map name — the engine's gameplay and ui, or one the project declares in `input.maps`. */
export type InputMapName = 'gameplay' | 'ui' | (string & {});

/** Phase 23.10: at most this many project maps besides gameplay and ui (an engine limit). */
export const MAX_INPUT_MAPS = 8;

export interface InputConfig {
  actions: InputAction[];
  /**
   * Phase 23.10: the project's own input maps besides gameplay and ui (a
   * game mode activates maps; absent: none). A map name is a letter or _,
   * then up to 31 letters, digits or _.
   */
  maps?: string[];
  /**
   * Phase 23.14: the project's own glyph images — a glyph key (an icon id of
   * the engine's generic set such as `pad-south`, `mouse-left` or `key`,
   * optionally for one gamepad family `xbox:pad-south` or one key
   * `key:Space`) → a texture asset shown instead of the generic icon.
   */
  glyphs?: Record<string, string>;
  /**
   * Phase 23.3: the cursor while each map is active (absent: free —
   * a pointer-driven game needs a visible cursor; mouse-look opts in to locked).
   * Phase 25.6: keyed by any map — gameplay, ui or one of `maps`.
   */
  cursor?: { gameplay?: CursorMode; ui?: CursorMode; [map: string]: CursorMode | undefined };
}

/**
 * Phase 23.10: every input map a project has — the engine's gameplay and ui,
 * then its own `input.maps` (an unvalidated value reads as none of its own).
 */
export function projectInputMaps(input: unknown): string[] {
  const own = isPlainObject(input) && Array.isArray(input['maps']) ? input['maps'].filter((m): m is string => typeof m === 'string') : [];
  return [...INPUT_MAPS, ...own.filter((m) => !(INPUT_MAPS as readonly string[]).includes(m))];
}

/** Phase 23.14: 64 (was 32) — a game with many abilities or hotbar slots names more actions; the frame bound follows. */
export const MAX_INPUT_ACTIONS = 64;
export const MAX_INPUT_BINDINGS = 8;

/**
 * Phase 23.14: a binding's hold modifier — the binding counts only after it
 * has been held this long (seconds): a hold instead of a tap. 0.05 s is
 * about three frames at 60 Hz (shorter is indistinguishable from a tap);
 * 10 s bounds a deliberate long hold.
 */
export const INPUT_HOLD_MIN = 0.05;
export const INPUT_HOLD_MAX = 10;
/** Phase 23.14: the binding kinds that take the hold modifier (the single on/off ones). */
export const HOLD_BINDING_KINDS = ['key', 'gamepadButton', 'pointerButton'] as const;
/** Phase 23.14: the gamepad families glyphs distinguish (detected from the pad's id). */
export const GAMEPAD_FAMILIES = ['xbox', 'playstation', 'switch', 'generic'] as const;
/** Phase 23.14: a glyph key — `[family:]icon[:code]` (see `InputConfig.glyphs`). */
export const GLYPH_KEY_RE = /^(?:(?:xbox|playstation|switch|generic):)?[a-z][a-z0-9-]{0,31}(?::[A-Za-z0-9]{1,32})?$/;
export const MAX_INPUT_GLYPHS = 128;

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

/**
 * Phase 23.2: the default actions of a 3D project (physics_dimension 3)
 * without its own input — the 2D defaults with `move` as a 2D axis (W/A/S/D,
 * the arrow keys and the left stick: forward, back and sideways) and a `run`
 * button (Shift, the left-stick press — the usual sprint controls), which
 * the 3D character controller reads.
 */
export const DEFAULT_INPUT_3D: Readonly<InputConfig> = Object.freeze({
  actions: [
    { name: 'move', type: 'axis2d', map: 'gameplay', bindings: [{ kind: 'keys2d', up: 'KeyW', down: 'KeyS', left: 'KeyA', right: 'KeyD' }, { kind: 'keys2d', up: 'ArrowUp', down: 'ArrowDown', left: 'ArrowLeft', right: 'ArrowRight' }, { kind: 'gamepadStick', x: 0, y: 1 }] },
    { name: 'run', type: 'button', map: 'gameplay', bindings: [{ kind: 'key', code: 'ShiftLeft' }, { kind: 'key', code: 'ShiftRight' }, { kind: 'gamepadButton', button: 10 }] },
    ...DEFAULT_INPUT.actions.filter((a) => a.name !== 'move'),
  ],
} as InputConfig);

/** Phase 23.2: the default actions of a project of this physics dimension (absent: the 2D plane). */
export function defaultInputFor(dimension: 2 | 3 | undefined): Readonly<InputConfig> {
  return dimension === 3 ? DEFAULT_INPUT_3D : DEFAULT_INPUT;
}

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
  pointerButton: ['button'],
  pointerPosition: [],
  pointerDelta: [],
  pointerAxis: ['axis'],
};
/** Which bindings fit which action type. */
const FITS: Record<InputActionType, readonly InputBinding['kind'][]> = {
  button: ['key', 'gamepadButton', 'pointerButton'],
  axis1d: ['keys1d', 'gamepadButtons1d', 'gamepadAxis', 'key', 'gamepadButton', 'pointerAxis', 'pointerButton'],
  axis2d: ['keys2d', 'gamepadStick', 'pointerPosition', 'pointerDelta'],
};

export function validateInput(value: unknown, path: string, errors: ModelErrorV2[]): void {
  if (!isPlainObject(value)) return err(errors, 'field_type', path, 'input is { actions }', value);
  for (const k of Object.keys(value)) if (k !== 'actions' && k !== 'cursor' && k !== 'glyphs' && k !== 'maps') err(errors, 'field_unexpected', `${path}/${k}`, `unknown field "${k}"`, k, 'actions, maps, cursor, glyphs');
  // Phase 23.10: the project's own maps (unique names, not gameplay/ui).
  const maps = value['maps'];
  const mapNames = new Set<string>(INPUT_MAPS);
  if (maps !== undefined) {
    if (!Array.isArray(maps) || maps.length > MAX_INPUT_MAPS) err(errors, 'field_value', `${path}/maps`, `maps is a list of at most ${MAX_INPUT_MAPS} names`, maps);
    else
      maps.forEach((m, i) => {
        if (typeof m !== 'string' || !NAME_RE.test(m)) err(errors, 'field_value', `${path}/maps/${i}`, 'a map name is a letter or _ then up to 31 letters, digits or _', m);
        else if (mapNames.has(m)) err(errors, 'field_value', `${path}/maps/${i}`, (INPUT_MAPS as readonly string[]).includes(m) ? `"${m}" is an engine map (always there)` : 'map names are unique', m);
        else mapNames.add(m);
      });
  }
  const glyphs = value['glyphs'];
  if (glyphs !== undefined) {
    if (!isPlainObject(glyphs) || Object.keys(glyphs).length > MAX_INPUT_GLYPHS) err(errors, 'field_type', `${path}/glyphs`, `glyphs maps at most ${MAX_INPUT_GLYPHS} glyph keys to texture assets`, glyphs);
    else
      for (const [k, v] of Object.entries(glyphs)) {
        if (!GLYPH_KEY_RE.test(k)) err(errors, 'field_value', `${path}/glyphs/${k}`, 'a glyph key is [family:]icon[:key code] (e.g. pad-south, xbox:pad-south, key:Space)', k);
        else if (typeof v !== 'string' || v.length === 0 || v.length > 128) err(errors, 'field_value', `${path}/glyphs/${k}`, 'a glyph names a texture asset', v);
      }
  }
  const cursor = value['cursor'];
  if (cursor !== undefined) {
    if (!isPlainObject(cursor)) err(errors, 'field_type', `${path}/cursor`, 'cursor maps input maps (gameplay, ui or the project\'s own) to free or locked', cursor);
    else
      for (const [k, v] of Object.entries(cursor)) {
        // Phase 25.6: any map the project has (the engine's and its own).
        if (!mapNames.has(k)) err(errors, 'field_unexpected', `${path}/cursor/${k}`, `"${k}" is not an input map of this project`, k, [...mapNames].join(', '));
        else if (!(CURSOR_MODES as readonly unknown[]).includes(v)) err(errors, 'field_value', `${path}/cursor/${k}`, 'the cursor is free or locked', v);
      }
  }
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
    if (typeof a['map'] !== 'string' || !mapNames.has(a['map'])) err(errors, 'field_value', `${p}/map`, mapNames.size > INPUT_MAPS.length ? `map is one of ${[...mapNames].join(', ')}` : 'map is gameplay or ui', a['map']);
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
      if (keys === undefined) return err(errors, 'field_value', `${bp}/kind`, 'kind is key, gamepadButton, gamepadAxis, keys1d, keys2d, gamepadButtons1d, gamepadStick, pointerButton, pointerPosition, pointerDelta or pointerAxis', kind);
      if (!FITS[type].includes(kind)) return err(errors, 'field_value', `${bp}/kind`, `a ${kind} binding does not fit a ${type} action`, kind);
      const holdable = (HOLD_BINDING_KINDS as readonly string[]).includes(kind);
      for (const k of Object.keys(b)) if (k !== 'kind' && !keys.includes(k) && !(holdable && k === 'hold')) err(errors, 'field_unexpected', `${bp}/${k}`, `unknown field "${k}"`, k, ['kind', ...keys, ...(holdable ? ['hold'] : [])].join(', '));
      if (b['hold'] !== undefined && holdable && !(typeof b['hold'] === 'number' && Number.isFinite(b['hold']) && b['hold'] >= INPUT_HOLD_MIN && b['hold'] <= INPUT_HOLD_MAX)) err(errors, 'field_value', `${bp}/hold`, `hold is the seconds to hold, in [${INPUT_HOLD_MIN}, ${INPUT_HOLD_MAX}]`, b['hold']);
      if (kind === 'pointerButton' || kind === 'pointerAxis') {
        const v = b[keys[0]!];
        const allowed: readonly unknown[] = kind === 'pointerButton' ? POINTER_BUTTONS : POINTER_AXES;
        if (!allowed.includes(v)) err(errors, 'field_value', `${bp}/${keys[0]}`, kind === 'pointerButton' ? 'a pointer button: left, right or middle' : 'a pointer axis: x, y or wheel', v);
        return;
      }
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
    ...(c.maps !== undefined && c.maps.length > 0 ? { maps: [...c.maps] } : {}),
    // Phase 25.6: gameplay, ui, then the project's own maps in their order.
    ...(c.cursor !== undefined ? { cursor: Object.fromEntries([...INPUT_MAPS, ...(c.maps ?? [])].filter((m) => c.cursor![m] !== undefined).map((m) => [m, c.cursor![m]!])) } : {}),
    // Phase 23.14: glyph images by key (sorted, so the canonical bytes do not depend on insertion order).
    ...(c.glyphs !== undefined ? { glyphs: Object.fromEntries(Object.keys(c.glyphs).sort().map((k) => [k, c.glyphs![k]!])) } : {}),
  };
}
