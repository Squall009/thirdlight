/**
 * Phase 23.9a: project UI documents (`content.uiDocuments[]`) and themes
 * (`content.uiThemes[]`), v4.
 *
 * A UI document is a tree of widgets drawn by the game host as DOM/CSS over
 * the game view (Play and exports alike; the runtime never draws). Layout is
 * anchors + offsets inside a panel, or a stack (row/column with gap and
 * alignment), a grid, or a list repeated from a bound array. Widgets: panel,
 * stack, grid, text (inline rich text in project fonts), image (texture
 * assets, 9-slice), bar (linear or radial gauge), button, list and a text
 * input. Values come from the scripts' view model (`ctx.ui.set(path, value)`)
 * through bindings (`{ "bind": "hud.hp" }`, `{hud.hp}` inside a text);
 * styles and themes are data (a closed set of style properties, never raw
 * CSS), tweens (fade, slide, scale, stamp) are data played on show/hide or
 * from scripts. A document can follow a world point or an entity (world
 * anchor, projected by the host each frame), declare the input action map it
 * activates while it has focus, and replace a built-in flow screen
 * (`flow.screens`).
 *
 * Stored inline in the content document so the editor and MCP create and
 * edit them with plain commands (`setUiDocument` / `deleteUiDocument`,
 * `setUiTheme` / `deleteUiTheme`), one undo step each. Pure data rules.
 */
import type { ModelErrorV2 } from './errors';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A value from the view model: `{ "bind": "path" }` (`"!path"` negates a boolean). */
export interface UiBinding {
  bind: string;
}
export type UiBindable<T> = T | UiBinding;

/** A colour: `#rgb`, `#rrggbb` or `#rrggbbaa`. */
export type UiColor = string;

/** The closed set of style properties (never raw CSS). */
export interface UiStyleValues {
  color?: UiColor;
  background?: UiColor;
  /** A texture asset drawn behind the widget (stretched, or 9-sliced with `slice`). */
  backgroundImage?: string;
  /** 9-slice insets of `backgroundImage` in image pixels: [top, right, bottom, left]. */
  slice?: [number, number, number, number];
  opacity?: number;
  /** A font asset of the project, or a generic family: sans, serif, mono, rounded. */
  font?: string;
  fontSize?: number;
  bold?: boolean;
  italic?: boolean;
  align?: 'left' | 'center' | 'right';
  lineHeight?: number;
  letterSpacing?: number;
  /** One number (all sides) or [top, right, bottom, left], px. */
  padding?: number | [number, number, number, number];
  radius?: number;
  borderWidth?: number;
  borderColor?: UiColor;
  /** A text shadow colour (1 px down, 2 px blur). */
  textShadow?: UiColor;
  /** A box shadow colour (4 px down, 12 px blur). */
  shadow?: UiColor;
}
export interface UiStyle extends UiStyleValues {
  hover?: UiStyleValues;
  focus?: UiStyleValues;
  pressed?: UiStyleValues;
  disabled?: UiStyleValues;
}

/** An icon glyph for rich text (`[icon=name]`): a texture, or a part of it. */
export interface UiIcon {
  asset: string;
  /** [x, y, width, height] in image pixels (absent: the whole image). */
  rect?: [number, number, number, number];
}

export type UiTweenKind = 'fade' | 'slide' | 'scale' | 'stamp';
export type UiEasing = 'linear' | 'easeIn' | 'easeOut' | 'easeInOut' | 'back';
export interface UiTween {
  kind: UiTweenKind;
  /** Seconds. */
  duration: number;
  delay?: number;
  easing?: UiEasing;
  /** fade: opacity; scale/stamp: scale; slide: progress (1 = `distance` away, 0 = in place). */
  from?: number;
  to?: number;
  /** slide: where it comes from. */
  direction?: 'left' | 'right' | 'up' | 'down';
  /** slide: px. */
  distance?: number;
}

export type UiEngineAction =
  | 'resume'
  | 'pause'
  | 'restartLevel'
  | 'newGame'
  | 'continue'
  | 'nextLevel'
  | 'quitToTitle'
  | 'settings'
  | 'load'
  | 'save'
  | 'back'
  | 'setSetting'
  | 'mute'
  | 'unmute'
  // Phase 23.14: rebinding (the host's bindings API): listen for an action's input, stop listening, reset one action or all.
  | 'rebind'
  | 'cancelRebind'
  | 'resetBindings';

/** What a button click (or an input submit, a cancel, a focus) does. */
export type UiAction =
  /** Raise a UI event to scripts (on the next input frame). */
  | { do: 'event'; name: string; value?: UiScalar | UiBinding }
  /** An engine action of the game flow (resume, quit to title, save, load, set a setting, …). */
  | { do: 'engine'; action: UiEngineAction; slot?: string; setting?: 'music' | 'sfx' | 'ui' | 'quality'; value?: number | string; step?: number; input?: string; device?: 'keyboardMouse' | 'gamepad'; index?: number; part?: 'negative' | 'positive' | 'up' | 'down' | 'left' | 'right'; policy?: 'swap' | 'refuse' | 'allow' }
  /** Show / hide / toggle a UI document (through the input frame, so replays hold). */
  | { do: 'show' | 'hide' | 'toggle'; doc: string }
  /** Play a tween of this document (presentation only). */
  | { do: 'play'; tween: string; widget?: string };
export type UiScalar = number | string | boolean | null;

/** Follow a world point or an entity (projected through the rendered camera each frame). */
export interface UiWorldAnchor {
  entity?: UiBindable<string>;
  point?: [number, number, number];
  /** World offset from the entity or point (m). */
  offset?: [number, number, number];
  /** Keep it on screen at the edge while the target is off screen (else it hides). */
  clamp?: boolean;
  /** px from the screen edge when clamped. */
  margin?: number;
  /** A child widget shown only while clamped, turned towards the target (`--tl-angle`). */
  indicator?: string;
}

export type UiWidgetType = 'panel' | 'stack' | 'grid' | 'text' | 'image' | 'bar' | 'button' | 'list' | 'input';

export interface UiWidget {
  id?: string;
  type: UiWidgetType;
  // Placement in a panel (a stack/grid/list parent flows its children; only `size` and `grow` apply there).
  anchor?: [number, number];
  pivot?: [number, number];
  offset?: [number, number];
  size?: [number | null, number | null];
  stretch?: 'x' | 'y' | 'both';
  margin?: [number, number, number, number];
  grow?: number;
  style?: string | string[];
  css?: UiStyle;
  visible?: UiBindable<boolean>;
  enabled?: UiBindable<boolean>;
  focusable?: boolean;
  nav?: { up?: string; down?: string; left?: string; right?: string; next?: string; prev?: string };
  worldAnchor?: UiWorldAnchor;
  onFocus?: UiAction | UiAction[];
  // Containers.
  children?: UiWidget[];
  direction?: 'row' | 'column' | 'grid' | 'right' | 'left' | 'up' | 'down';
  gap?: number;
  align?: 'start' | 'center' | 'end' | 'stretch';
  justify?: 'start' | 'center' | 'end' | 'between' | 'around';
  wrap?: boolean;
  columns?: number;
  cellSize?: [number, number];
  // text / button / input
  text?: string;
  // image
  image?: UiBindable<string>;
  slice?: [number, number, number, number];
  fit?: 'stretch' | 'contain' | 'cover';
  tint?: UiColor;
  // bar
  value?: UiBindable<number> | UiBinding;
  min?: UiBindable<number>;
  max?: UiBindable<number>;
  shape?: 'linear' | 'radial';
  fillColor?: UiColor;
  fillStyle?: string;
  startAngle?: number;
  // button
  onClick?: UiAction | UiAction[];
  // list
  items?: UiBinding;
  template?: UiWidget;
  // input
  placeholder?: string;
  maxLength?: number;
  onSubmit?: UiAction | UiAction[];
}

export interface UiDocument {
  uiDocumentId: string;
  name: string;
  /** Z-order layer (−100–100, higher on top; absent 0). Documents of one layer stack in show order. */
  layer?: number;
  /** A modal document blocks the documents under it and takes the focus (absent false). */
  modal?: boolean;
  /** Take the keyboard/gamepad focus when shown (absent: `modal`). */
  focus?: boolean;
  /** The input action map active while it has the focus (absent: every map stays active). */
  actionMap?: string;
  theme?: string;
  /** Scale with the view: `reference` [w, h] px drawn to fit the view (`fit`), its width or its height. */
  scale?: { reference: [number, number]; mode: 'fit' | 'width' | 'height' };
  styles?: Record<string, UiStyle>;
  icons?: Record<string, UiIcon>;
  tweens?: Record<string, UiTween>;
  showTween?: string;
  hideTween?: string;
  initialFocus?: string;
  /** What the cancel input (Back, pad B) does while it has the focus. */
  onCancel?: UiAction | UiAction[];
  root: UiWidget;
}

export interface UiTheme {
  uiThemeId: string;
  name: string;
  styles: Record<string, UiStyle>;
  icons?: Record<string, UiIcon>;
}

/** What the runtime knows of a document (it never draws). */
export interface RuntimeUiDocumentRow {
  readonly uiDocumentId: string;
  readonly layer: number;
  readonly modal: boolean;
}

// ---------------------------------------------------------------------------
// Limits (engine limits: they keep one document inside a 64 KiB command and
// the host's DOM bounded)
// ---------------------------------------------------------------------------

export const UI_LIMITS = Object.freeze({
  documents: 64,
  themes: 16,
  /** Canonical JSON bytes of one document or theme. */
  documentBytes: 49_152,
  widgets: 512,
  depth: 16,
  children: 128,
  styles: 64,
  tweens: 32,
  icons: 64,
  textChars: 1024,
  nameChars: 64,
  bindPathChars: 128,
  /** Rendered items of one list (the rest are not drawn). */
  listItems: 256,
  layer: 100,
  px: 16_384,
});

export const UI_WIDGET_TYPES: readonly UiWidgetType[] = ['panel', 'stack', 'grid', 'text', 'image', 'bar', 'button', 'list', 'input'];
export const UI_ENGINE_ACTIONS: readonly UiEngineAction[] = ['resume', 'pause', 'restartLevel', 'newGame', 'continue', 'nextLevel', 'quitToTitle', 'settings', 'load', 'save', 'back', 'setSetting', 'mute', 'unmute', 'rebind', 'cancelRebind', 'resetBindings'];
export const UI_TWEEN_KINDS: readonly UiTweenKind[] = ['fade', 'slide', 'scale', 'stamp'];
export const UI_EASINGS: readonly UiEasing[] = ['linear', 'easeIn', 'easeOut', 'easeInOut', 'back'];
export const UI_GENERIC_FONTS = ['sans', 'serif', 'mono', 'rounded'] as const;
/** The flow screens a project may replace with its own document. */
export const UI_FLOW_SCREENS = ['title', 'paused', 'settings', 'levelComplete', 'gameOver', 'finished', 'load', 'save'] as const;
export type UiFlowScreen = (typeof UI_FLOW_SCREENS)[number];
/** The save slots an engine load/save action names (the game host's). */
export const UI_SAVE_SLOTS = ['auto', '1', '2', '3'] as const;

const ID_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
/** Widget ids, style/tween/icon names and event names. */
const NAME_RE = /^[A-Za-z_][A-Za-z0-9_-]{0,31}$/;
const COLOR_RE = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;
/** A binding path: segments of letters, digits, _ and -, joined by "."; the first may be `$item`, `$index` or `$flow`. */
const PATH_SEGMENT_RE = /^[A-Za-z0-9_-]{1,32}$/;
const SPECIAL_ROOTS = new Set(['$item', '$index', '$flow']);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
function err(errors: ModelErrorV2[], code: string, path: string, message: string, found?: unknown, expected?: string): void {
  errors.push({ code, path, message, ...(found !== undefined ? { found } : {}), ...(expected !== undefined ? { expected } : {}) } as ModelErrorV2);
}
function only(v: Record<string, unknown>, allowed: readonly string[], path: string, errors: ModelErrorV2[], what: string): void {
  for (const k of Object.keys(v)) if (!allowed.includes(k)) err(errors, 'field_unexpected', `${path}/${k}`, `unknown ${what} field "${k}" (allowed: ${allowed.join(', ')})`, k, allowed.join(', '));
}
const isNum = (v: unknown, min: number, max: number): v is number => typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max;
const isName = (v: unknown): v is string => typeof v === 'string' && NAME_RE.test(v);
const isText = (v: unknown, max: number): v is string => typeof v === 'string' && v.length <= max && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(v);
function num(errors: ModelErrorV2[], v: unknown, path: string, min: number, max: number, what: string): void {
  if (v !== undefined && !isNum(v, min, max)) err(errors, 'field_value', path, `${what} is a number ${min}–${max}`, v, `${min}..${max}`);
}
function tuple(errors: ModelErrorV2[], v: unknown, path: string, n: number, min: number, max: number, what: string, nullable = false): void {
  if (v === undefined) return;
  if (!Array.isArray(v) || v.length !== n || !v.every((x) => (nullable && x === null) || isNum(x, min, max))) err(errors, 'field_value', path, `${what} is [${n} numbers ${min}–${max}${nullable ? ' or null' : ''}]`, v, `${n} numbers`);
}
function oneOf(errors: ModelErrorV2[], v: unknown, path: string, values: readonly string[], what: string): void {
  if (v !== undefined && (typeof v !== 'string' || !values.includes(v))) err(errors, 'field_value', path, `${what} is one of ${values.join(', ')}`, v, values.join(' | '));
}
function bool(errors: ModelErrorV2[], v: unknown, path: string, what: string): void {
  if (v !== undefined && typeof v !== 'boolean') err(errors, 'field_type', path, `${what} is true or false`, v, 'boolean');
}
function color(errors: ModelErrorV2[], v: unknown, path: string, what: string): void {
  if (v !== undefined && (typeof v !== 'string' || !COLOR_RE.test(v))) err(errors, 'field_value', path, `${what} is a colour #rgb, #rrggbb or #rrggbbaa`, v, '#rrggbb');
}

/** Why a binding path is refused (null: fine). Shared with the host and the runtime. */
export function uiBindPathProblem(path: string): string | null {
  const p = path.startsWith('!') ? path.slice(1) : path;
  if (p.length < 1 || p.length > UI_LIMITS.bindPathChars) return `a binding path has 1-${UI_LIMITS.bindPathChars} characters`;
  const segs = p.split('.');
  if (segs.length > 8) return 'a binding path has at most 8 segments';
  for (let i = 0; i < segs.length; i += 1) {
    const s = segs[i]!;
    if (i === 0 && SPECIAL_ROOTS.has(s)) continue;
    if (!PATH_SEGMENT_RE.test(s)) return `binding path segment "${s.slice(0, 40)}" uses letters, digits, _ and - (1-32)`;
  }
  return null;
}

function binding(errors: ModelErrorV2[], v: unknown, path: string): void {
  if (!isPlainObject(v)) return;
  only(v, ['bind'], path, errors, 'binding');
  const p = v['bind'];
  const problem = typeof p === 'string' ? uiBindPathProblem(p) : 'bind is a path text';
  if (problem !== null) err(errors, 'field_value', `${path}/bind`, problem, p, 'a view-model path');
}
function bindable(errors: ModelErrorV2[], v: unknown, path: string, check: (x: unknown) => boolean, what: string): void {
  if (v === undefined) return;
  if (isPlainObject(v)) binding(errors, v, path);
  else if (!check(v)) err(errors, 'field_value', path, `${what}, or { "bind": "path" }`, v, what);
}

/** The `{path}` placeholders of a text (their problems, if any). */
export function uiTextPlaceholders(text: string): string[] {
  const out: string[] = [];
  const re = /\{([^{}]*)\}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) out.push(m[1]!);
  return out;
}

// ---------------------------------------------------------------------------
// Styles, icons, tweens, actions
// ---------------------------------------------------------------------------

const STYLE_VALUE_KEYS = ['color', 'background', 'backgroundImage', 'slice', 'opacity', 'font', 'fontSize', 'bold', 'italic', 'align', 'lineHeight', 'letterSpacing', 'padding', 'radius', 'borderWidth', 'borderColor', 'textShadow', 'shadow'] as const;
const STYLE_STATE_KEYS = ['hover', 'focus', 'pressed', 'disabled'] as const;

function validateStyleValues(errors: ModelErrorV2[], v: Record<string, unknown>, path: string, withStates: boolean): void {
  only(v, withStates ? [...STYLE_VALUE_KEYS, ...STYLE_STATE_KEYS] : STYLE_VALUE_KEYS, path, errors, 'style');
  color(errors, v['color'], `${path}/color`, 'color');
  color(errors, v['background'], `${path}/background`, 'background');
  if (v['backgroundImage'] !== undefined && (typeof v['backgroundImage'] !== 'string' || !ID_RE.test(v['backgroundImage']))) err(errors, 'field_value', `${path}/backgroundImage`, 'backgroundImage names a texture asset', v['backgroundImage'], 'a texture assetId');
  tuple(errors, v['slice'], `${path}/slice`, 4, 0, 4096, 'slice');
  num(errors, v['opacity'], `${path}/opacity`, 0, 1, 'opacity');
  if (v['font'] !== undefined && (typeof v['font'] !== 'string' || !ID_RE.test(v['font']))) err(errors, 'field_value', `${path}/font`, 'font names a font asset or sans, serif, mono, rounded', v['font'], 'a font assetId');
  num(errors, v['fontSize'], `${path}/fontSize`, 4, 400, 'fontSize');
  bool(errors, v['bold'], `${path}/bold`, 'bold');
  bool(errors, v['italic'], `${path}/italic`, 'italic');
  oneOf(errors, v['align'], `${path}/align`, ['left', 'center', 'right'], 'align');
  num(errors, v['lineHeight'], `${path}/lineHeight`, 0.5, 4, 'lineHeight');
  num(errors, v['letterSpacing'], `${path}/letterSpacing`, -20, 100, 'letterSpacing');
  const pad = v['padding'];
  if (pad !== undefined && !isNum(pad, 0, 1024)) tuple(errors, pad, `${path}/padding`, 4, 0, 1024, 'padding');
  num(errors, v['radius'], `${path}/radius`, 0, 4096, 'radius');
  num(errors, v['borderWidth'], `${path}/borderWidth`, 0, 256, 'borderWidth');
  color(errors, v['borderColor'], `${path}/borderColor`, 'borderColor');
  color(errors, v['textShadow'], `${path}/textShadow`, 'textShadow');
  color(errors, v['shadow'], `${path}/shadow`, 'shadow');
  if (withStates) {
    for (const s of STYLE_STATE_KEYS) {
      const sub = v[s];
      if (sub === undefined) continue;
      if (!isPlainObject(sub)) err(errors, 'field_type', `${path}/${s}`, `${s} is a style (without states)`, sub, 'object');
      else validateStyleValues(errors, sub, `${path}/${s}`, false);
    }
  }
}

export function validateUiStyle(value: unknown, path: string, errors: ModelErrorV2[]): void {
  if (!isPlainObject(value)) return err(errors, 'field_type', path, 'a style is an object of style values', value, 'object');
  validateStyleValues(errors, value, path, true);
}

function validateNamedMap(errors: ModelErrorV2[], v: unknown, path: string, max: number, what: string, each: (value: unknown, p: string) => void): void {
  if (v === undefined) return;
  if (!isPlainObject(v)) return err(errors, 'field_type', path, `${what} maps names to values`, v, 'object');
  const keys = Object.keys(v);
  if (keys.length > max) err(errors, 'limits_exceeded', path, `at most ${max} ${what}`, keys.length, `≤ ${max}`);
  for (const k of keys) {
    if (!NAME_RE.test(k)) err(errors, 'field_value', `${path}/${k}`, `a ${what} name is a letter or _, then up to 31 letters, digits, _ or -`, k, 'a name');
    each(v[k], `${path}/${k}`);
  }
}

function validateIcon(errors: ModelErrorV2[], v: unknown, path: string): void {
  if (!isPlainObject(v)) return err(errors, 'field_type', path, 'an icon is { asset, rect? }', v, 'object');
  only(v, ['asset', 'rect'], path, errors, 'icon');
  if (typeof v['asset'] !== 'string' || !ID_RE.test(v['asset'])) err(errors, 'field_value', `${path}/asset`, 'an icon names a texture asset', v['asset'], 'a texture assetId');
  tuple(errors, v['rect'], `${path}/rect`, 4, 0, 16_384, 'rect');
}

function validateTween(errors: ModelErrorV2[], v: unknown, path: string): void {
  if (!isPlainObject(v)) return err(errors, 'field_type', path, 'a tween is { kind, duration, … }', v, 'object');
  only(v, ['kind', 'duration', 'delay', 'easing', 'from', 'to', 'direction', 'distance'], path, errors, 'tween');
  if (typeof v['kind'] !== 'string' || !(UI_TWEEN_KINDS as readonly string[]).includes(v['kind'])) err(errors, 'field_value', `${path}/kind`, 'kind is fade, slide, scale or stamp', v['kind'], 'fade | slide | scale | stamp');
  if (!isNum(v['duration'], 0.01, 10)) err(errors, 'field_value', `${path}/duration`, 'duration is 0.01–10 seconds', v['duration'], '0.01..10');
  num(errors, v['delay'], `${path}/delay`, 0, 10, 'delay');
  oneOf(errors, v['easing'], `${path}/easing`, UI_EASINGS, 'easing');
  num(errors, v['from'], `${path}/from`, -10, 10, 'from');
  num(errors, v['to'], `${path}/to`, -10, 10, 'to');
  oneOf(errors, v['direction'], `${path}/direction`, ['left', 'right', 'up', 'down'], 'direction');
  num(errors, v['distance'], `${path}/distance`, 0, UI_LIMITS.px, 'distance');
}

function validateActions(errors: ModelErrorV2[], v: unknown, path: string, refs: DocRefs): void {
  if (v === undefined) return;
  const list = Array.isArray(v) ? v : [v];
  if (Array.isArray(v) && (v.length < 1 || v.length > 4)) err(errors, 'field_value', path, 'a list of 1-4 actions', v.length, '1..4');
  list.forEach((a, i) => {
    const p = Array.isArray(v) ? `${path}/${i}` : path;
    if (!isPlainObject(a)) return err(errors, 'field_type', p, 'an action is { do: event | engine | show | hide | toggle | play, … }', a, 'object');
    switch (a['do']) {
      case 'event':
        only(a, ['do', 'name', 'value'], p, errors, 'event action');
        if (!isName(a['name'])) err(errors, 'field_value', `${p}/name`, 'an event name is a letter or _, then up to 31 letters, digits, _ or -', a['name'], 'a name');
        if (a['value'] !== undefined) {
          if (isPlainObject(a['value'])) binding(errors, a['value'], `${p}/value`);
          else if (!(a['value'] === null || typeof a['value'] === 'boolean' || isNum(a['value'], -1e15, 1e15) || isText(a['value'], 256))) err(errors, 'field_value', `${p}/value`, 'an event value is a number, text (≤ 256), true/false, null or { bind }', a['value'], 'a scalar');
        }
        break;
      case 'engine': {
        only(a, ['do', 'action', 'slot', 'setting', 'value', 'step', 'input', 'device', 'index', 'part', 'policy'], p, errors, 'engine action');
        // Phase 23.14: rebind names the input action (and optionally the device, binding index, composite part and conflict policy).
        if (a['input'] !== undefined && !(typeof a['input'] === 'string' && /^[A-Za-z_][A-Za-z0-9_]{0,31}$/.test(a['input']))) err(errors, 'field_value', `${p}/input`, 'input names an input action', a['input'], 'an action name');
        if (a['action'] === 'rebind' && a['input'] === undefined) err(errors, 'field_missing', `${p}/input`, 'rebind names its input action', undefined, 'an action name');
        oneOf(errors, a['device'], `${p}/device`, ['keyboardMouse', 'gamepad'], 'device');
        oneOf(errors, a['part'], `${p}/part`, ['negative', 'positive', 'up', 'down', 'left', 'right'], 'part');
        oneOf(errors, a['policy'], `${p}/policy`, ['swap', 'refuse', 'allow'], 'policy');
        if (a['index'] !== undefined && !(Number.isInteger(a['index']) && (a['index'] as number) >= 0 && (a['index'] as number) <= 7)) err(errors, 'field_value', `${p}/index`, 'index is a binding index 0–7', a['index'], '0..7');
        oneOf(errors, a['action'], `${p}/action`, UI_ENGINE_ACTIONS, 'an engine action');
        if (a['action'] === undefined) err(errors, 'field_missing', `${p}/action`, 'an engine action names its action', undefined, UI_ENGINE_ACTIONS.join(' | '));
        oneOf(errors, a['slot'], `${p}/slot`, UI_SAVE_SLOTS, 'slot');
        oneOf(errors, a['setting'], `${p}/setting`, ['music', 'sfx', 'ui', 'quality'], 'setting');
        if (a['action'] === 'setSetting' && a['setting'] === undefined) err(errors, 'field_missing', `${p}/setting`, 'setSetting names its setting', undefined, 'music | sfx | ui | quality');
        if (a['value'] !== undefined && !isNum(a['value'], 0, 1) && !(typeof a['value'] === 'string' && ['low', 'medium', 'high'].includes(a['value']))) err(errors, 'field_value', `${p}/value`, 'a setting value is 0–1 (a volume) or low, medium, high (quality)', a['value'], '0..1 | low | medium | high');
        if (a['step'] !== undefined && a['step'] !== 1 && a['step'] !== -1) err(errors, 'field_value', `${p}/step`, 'step is 1 or -1', a['step'], '1 | -1');
        break;
      }
      case 'show':
      case 'hide':
      case 'toggle':
        only(a, ['do', 'doc'], p, errors, `${a['do']} action`);
        if (typeof a['doc'] !== 'string' || !ID_RE.test(a['doc'])) err(errors, 'field_value', `${p}/doc`, 'names a UI document', a['doc'], 'a uiDocumentId');
        else refs.docs.push({ id: a['doc'], path: `${p}/doc` });
        break;
      case 'play':
        only(a, ['do', 'tween', 'widget'], p, errors, 'play action');
        if (!isName(a['tween'])) err(errors, 'field_value', `${p}/tween`, 'names a tween of this document', a['tween'], 'a tween name');
        else refs.tweens.push({ name: a['tween'], path: `${p}/tween` });
        if (a['widget'] !== undefined) {
          if (!isName(a['widget'])) err(errors, 'field_value', `${p}/widget`, 'names a widget of this document', a['widget'], 'a widget id');
          else refs.widgets.push({ id: a['widget'], path: `${p}/widget` });
        }
        break;
      default:
        err(errors, 'field_value', `${p}/do`, 'do is event, engine, show, hide, toggle or play', a['do'], 'event | engine | show | hide | toggle | play');
    }
  });
}

// ---------------------------------------------------------------------------
// Widgets
// ---------------------------------------------------------------------------

interface DocRefs {
  ids: Map<string, string>;
  widgets: { id: string; path: string }[];
  tweens: { name: string; path: string }[];
  styles: { name: string; path: string }[];
  docs: { id: string; path: string }[];
  images: { id: string; path: string }[];
  fonts: { id: string; path: string }[];
  icons: { name: string; path: string }[];
  count: number;
}

const COMMON_KEYS = ['id', 'type', 'anchor', 'pivot', 'offset', 'size', 'stretch', 'margin', 'grow', 'style', 'css', 'visible', 'enabled', 'focusable', 'nav', 'worldAnchor', 'onFocus'];
const TYPE_KEYS: Record<UiWidgetType, readonly string[]> = {
  panel: ['children'],
  stack: ['children', 'direction', 'gap', 'align', 'justify', 'wrap'],
  grid: ['children', 'columns', 'gap', 'cellSize', 'align'],
  text: ['text', 'wrap'],
  image: ['image', 'slice', 'fit', 'tint'],
  bar: ['value', 'min', 'max', 'direction', 'shape', 'fillColor', 'fillStyle', 'startAngle'],
  button: ['text', 'children', 'onClick', 'direction', 'gap', 'align', 'justify'],
  list: ['items', 'template', 'direction', 'gap', 'align', 'justify', 'columns', 'wrap'],
  input: ['value', 'placeholder', 'maxLength', 'onSubmit'],
};

function styleRefs(errors: ModelErrorV2[], v: unknown, path: string, refs: DocRefs): void {
  if (v === undefined) return;
  const list = Array.isArray(v) ? v : [v];
  if (Array.isArray(v) && (v.length < 1 || v.length > 4)) err(errors, 'field_value', path, 'style names 1-4 styles', v.length, '1..4');
  list.forEach((s, i) => {
    const p = Array.isArray(v) ? `${path}/${i}` : path;
    if (!isName(s)) err(errors, 'field_value', p, 'names a style of the document or its theme', s, 'a style name');
    else refs.styles.push({ name: s, path: p });
  });
}

function collectStyleAssets(v: unknown, path: string, refs: DocRefs): void {
  if (!isPlainObject(v)) return;
  const one = (s: Record<string, unknown>, p: string): void => {
    if (typeof s['backgroundImage'] === 'string') refs.images.push({ id: s['backgroundImage'], path: `${p}/backgroundImage` });
    if (typeof s['font'] === 'string' && !(UI_GENERIC_FONTS as readonly string[]).includes(s['font'])) refs.fonts.push({ id: s['font'], path: `${p}/font` });
  };
  one(v, path);
  for (const st of STYLE_STATE_KEYS) if (isPlainObject(v[st])) one(v[st] as Record<string, unknown>, `${path}/${st}`);
}

function textRefs(errors: ModelErrorV2[], text: string, path: string, refs: DocRefs): void {
  for (const ph of uiTextPlaceholders(text)) {
    const problem = uiBindPathProblem(ph);
    if (problem !== null) err(errors, 'field_value', path, `text placeholder {${ph.slice(0, 40)}}: ${problem}`, ph, 'a view-model path');
  }
  const re = /\[icon=([^\]]*)\]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    if (!NAME_RE.test(m[1]!)) err(errors, 'field_value', path, `[icon=${m[1]!.slice(0, 40)}] names an icon of the document or its theme`, m[1], 'an icon name');
    else refs.icons.push({ name: m[1]!, path });
  }
}

function validateWidget(errors: ModelErrorV2[], v: unknown, path: string, refs: DocRefs, depth: number, inTemplate: boolean): void {
  if (!isPlainObject(v)) return err(errors, 'field_type', path, 'a widget is an object { type, … }', v, 'object');
  refs.count += 1;
  if (refs.count === UI_LIMITS.widgets + 1) err(errors, 'limits_exceeded', path, `a document has at most ${UI_LIMITS.widgets} widgets`, refs.count, `≤ ${UI_LIMITS.widgets}`);
  if (depth > UI_LIMITS.depth) return err(errors, 'limits_exceeded', path, `widgets nest at most ${UI_LIMITS.depth} deep`, depth, `≤ ${UI_LIMITS.depth}`);
  const type = v['type'] as UiWidgetType;
  if (typeof type !== 'string' || !(UI_WIDGET_TYPES as readonly string[]).includes(type)) return err(errors, 'field_value', `${path}/type`, `type is one of ${UI_WIDGET_TYPES.join(', ')}`, type, UI_WIDGET_TYPES.join(' | '));
  only(v, [...COMMON_KEYS, ...TYPE_KEYS[type]], path, errors, `${type} widget`);
  const id = v['id'];
  if (id !== undefined) {
    if (!isName(id)) err(errors, 'field_value', `${path}/id`, 'a widget id is a letter or _, then up to 31 letters, digits, _ or -', id, 'a name');
    else if (refs.ids.has(id)) err(errors, 'id_duplicate', `${path}/id`, `two widgets use the id "${id}"`, id, 'a unique widget id');
    else refs.ids.set(id, path);
  }
  const P = UI_LIMITS.px;
  tuple(errors, v['anchor'], `${path}/anchor`, 2, 0, 1, 'anchor');
  tuple(errors, v['pivot'], `${path}/pivot`, 2, 0, 1, 'pivot');
  tuple(errors, v['offset'], `${path}/offset`, 2, -P, P, 'offset');
  tuple(errors, v['size'], `${path}/size`, 2, 0, P, 'size', true);
  oneOf(errors, v['stretch'], `${path}/stretch`, ['x', 'y', 'both'], 'stretch');
  tuple(errors, v['margin'], `${path}/margin`, 4, -P, P, 'margin');
  num(errors, v['grow'], `${path}/grow`, 0, 100, 'grow');
  styleRefs(errors, v['style'], `${path}/style`, refs);
  if (v['css'] !== undefined) {
    validateUiStyle(v['css'], `${path}/css`, errors);
    collectStyleAssets(v['css'], `${path}/css`, refs);
  }
  bindable(errors, v['visible'], `${path}/visible`, (x) => typeof x === 'boolean', 'visible is true/false');
  bindable(errors, v['enabled'], `${path}/enabled`, (x) => typeof x === 'boolean', 'enabled is true/false');
  bool(errors, v['focusable'], `${path}/focusable`, 'focusable');
  const nav = v['nav'];
  if (nav !== undefined) {
    if (!isPlainObject(nav)) err(errors, 'field_type', `${path}/nav`, 'nav is { up?, down?, left?, right?, next?, prev? } widget ids', nav, 'object');
    else {
      only(nav, ['up', 'down', 'left', 'right', 'next', 'prev'], `${path}/nav`, errors, 'nav');
      for (const [k, t] of Object.entries(nav)) {
        if (!isName(t)) err(errors, 'field_value', `${path}/nav/${k}`, 'names a widget of this document', t, 'a widget id');
        else refs.widgets.push({ id: t, path: `${path}/nav/${k}` });
      }
    }
  }
  const wa = v['worldAnchor'];
  if (wa !== undefined) {
    if (!isPlainObject(wa)) err(errors, 'field_type', `${path}/worldAnchor`, 'worldAnchor is { entity? | point?, offset?, clamp?, margin?, indicator? }', wa, 'object');
    else {
      const p = `${path}/worldAnchor`;
      only(wa, ['entity', 'point', 'offset', 'clamp', 'margin', 'indicator'], p, errors, 'world anchor');
      if ((wa['entity'] === undefined) === (wa['point'] === undefined)) err(errors, 'field_value', p, 'a world anchor follows an entity or a point (exactly one)', undefined, 'entity | point');
      bindable(errors, wa['entity'], `${p}/entity`, (x) => typeof x === 'string' && x.length >= 1 && x.length <= 128, 'entity is an entity id');
      tuple(errors, wa['point'], `${p}/point`, 3, -1e6, 1e6, 'point');
      tuple(errors, wa['offset'], `${p}/offset`, 3, -1e4, 1e4, 'offset');
      bool(errors, wa['clamp'], `${p}/clamp`, 'clamp');
      num(errors, wa['margin'], `${p}/margin`, 0, 4096, 'margin');
      if (wa['indicator'] !== undefined) {
        if (!isName(wa['indicator'])) err(errors, 'field_value', `${p}/indicator`, 'names a child widget', wa['indicator'], 'a widget id');
        else refs.widgets.push({ id: wa['indicator'], path: `${p}/indicator` });
      }
    }
  }
  validateActions(errors, v['onFocus'], `${path}/onFocus`, refs);

  const children = v['children'];
  if (children !== undefined) {
    if (!Array.isArray(children)) err(errors, 'field_type', `${path}/children`, 'children is a list of widgets', children, 'array');
    else {
      if (children.length > UI_LIMITS.children) err(errors, 'limits_exceeded', `${path}/children`, `at most ${UI_LIMITS.children} children`, children.length, `≤ ${UI_LIMITS.children}`);
      children.forEach((c, i) => validateWidget(errors, c, `${path}/children/${i}`, refs, depth + 1, inTemplate));
    }
  }
  num(errors, v['gap'], `${path}/gap`, 0, 4096, 'gap');
  oneOf(errors, v['align'], `${path}/align`, ['start', 'center', 'end', 'stretch'], 'align');
  oneOf(errors, v['justify'], `${path}/justify`, ['start', 'center', 'end', 'between', 'around'], 'justify');
  bool(errors, v['wrap'], `${path}/wrap`, 'wrap');
  if (v['columns'] !== undefined && !(Number.isInteger(v['columns']) && isNum(v['columns'], 1, 32))) err(errors, 'field_value', `${path}/columns`, 'columns is an integer 1–32', v['columns'], '1..32');
  tuple(errors, v['cellSize'], `${path}/cellSize`, 2, 1, P, 'cellSize');
  const text = v['text'];
  if (text !== undefined) {
    if (!isText(text, UI_LIMITS.textChars)) err(errors, 'field_value', `${path}/text`, `a text has at most ${UI_LIMITS.textChars} characters`, typeof text === 'string' ? text.length : text, `≤ ${UI_LIMITS.textChars} characters`);
    else textRefs(errors, text, `${path}/text`, refs);
  }
  switch (type) {
    case 'grid':
      if (v['columns'] === undefined) err(errors, 'field_missing', `${path}/columns`, 'a grid has columns', undefined, '1..32');
      break;
    case 'stack':
      oneOf(errors, v['direction'], `${path}/direction`, ['row', 'column'], 'a stack direction');
      break;
    case 'button':
      oneOf(errors, v['direction'], `${path}/direction`, ['row', 'column'], 'a button direction');
      validateActions(errors, v['onClick'], `${path}/onClick`, refs);
      break;
    case 'text':
      if (text === undefined) err(errors, 'field_missing', `${path}/text`, 'a text widget has a text', undefined, 'text');
      break;
    case 'image': {
      const img = v['image'];
      if (img === undefined) err(errors, 'field_missing', `${path}/image`, 'an image widget names a texture asset', undefined, 'image');
      bindable(errors, img, `${path}/image`, (x) => typeof x === 'string' && ID_RE.test(x), 'image names a texture asset');
      if (typeof img === 'string' && ID_RE.test(img)) refs.images.push({ id: img, path: `${path}/image` });
      tuple(errors, v['slice'], `${path}/slice`, 4, 0, 4096, 'slice');
      oneOf(errors, v['fit'], `${path}/fit`, ['stretch', 'contain', 'cover'], 'fit');
      color(errors, v['tint'], `${path}/tint`, 'tint');
      if (v['tint'] !== undefined && v['slice'] !== undefined) err(errors, 'field_value', `${path}/tint`, 'a 9-sliced image cannot be tinted (tint an unsliced image)', v['tint'], 'no tint with slice');
      break;
    }
    case 'bar':
      if (v['value'] === undefined) err(errors, 'field_missing', `${path}/value`, 'a bar has a value (a number or a binding)', undefined, 'value');
      bindable(errors, v['value'], `${path}/value`, (x) => isNum(x, -1e15, 1e15), 'value is a number');
      bindable(errors, v['min'], `${path}/min`, (x) => isNum(x, -1e15, 1e15), 'min is a number');
      bindable(errors, v['max'], `${path}/max`, (x) => isNum(x, -1e15, 1e15), 'max is a number');
      oneOf(errors, v['direction'], `${path}/direction`, ['right', 'left', 'up', 'down'], 'a bar fill direction');
      oneOf(errors, v['shape'], `${path}/shape`, ['linear', 'radial'], 'shape');
      color(errors, v['fillColor'], `${path}/fillColor`, 'fillColor');
      if (v['fillStyle'] !== undefined) styleRefs(errors, v['fillStyle'], `${path}/fillStyle`, refs);
      num(errors, v['startAngle'], `${path}/startAngle`, -360, 360, 'startAngle');
      break;
    case 'list': {
      const items = v['items'];
      if (!isPlainObject(items)) err(errors, 'field_value', `${path}/items`, 'a list repeats its template for a bound array: items is { "bind": "path" }', items, '{ bind }');
      else binding(errors, items, `${path}/items`);
      oneOf(errors, v['direction'], `${path}/direction`, ['row', 'column', 'grid'], 'a list direction');
      if (v['direction'] === 'grid' && v['columns'] === undefined) err(errors, 'field_missing', `${path}/columns`, 'a grid list has columns', undefined, '1..32');
      if (inTemplate) err(errors, 'field_value', path, 'a list template cannot hold another list', undefined, 'no nested list');
      if (v['template'] === undefined) err(errors, 'field_missing', `${path}/template`, 'a list has a template widget', undefined, 'template');
      else validateWidget(errors, v['template'], `${path}/template`, refs, depth + 1, true);
      break;
    }
    case 'input':
      bindable(errors, v['value'], `${path}/value`, (x) => isText(x, 256), 'value is a text');
      if (v['placeholder'] !== undefined && !isText(v['placeholder'], 256)) err(errors, 'field_value', `${path}/placeholder`, 'a placeholder has at most 256 characters', v['placeholder'], '≤ 256 characters');
      if (v['maxLength'] !== undefined && !(Number.isInteger(v['maxLength']) && isNum(v['maxLength'], 1, 256))) err(errors, 'field_value', `${path}/maxLength`, 'maxLength is an integer 1–256', v['maxLength'], '1..256');
      validateActions(errors, v['onSubmit'], `${path}/onSubmit`, refs);
      break;
    default:
      break;
  }
}

// ---------------------------------------------------------------------------
// Documents and themes
// ---------------------------------------------------------------------------

const DOC_KEYS = ['uiDocumentId', 'name', 'layer', 'modal', 'focus', 'actionMap', 'theme', 'scale', 'styles', 'icons', 'tweens', 'showTween', 'hideTween', 'initialFocus', 'onCancel', 'root'];

/** What a document references outside itself (checked against the project by `validateUiReferences`). */
export interface UiDocumentRefs {
  readonly docs: readonly { id: string; path: string }[];
  readonly styles: readonly { name: string; path: string }[];
  readonly images: readonly { id: string; path: string }[];
  readonly fonts: readonly { id: string; path: string }[];
  readonly icons: readonly { name: string; path: string }[];
}

function newRefs(): DocRefs {
  return { ids: new Map(), widgets: [], tweens: [], styles: [], docs: [], images: [], fonts: [], icons: [], count: 0 };
}

function validateName(errors: ModelErrorV2[], v: unknown, path: string, what: string): void {
  if (typeof v !== 'string' || v.length < 1 || v.length > UI_LIMITS.nameChars || /[\u0000-\u001f\u007f]/.test(v)) err(errors, 'field_value', path, `a ${what} name has 1-${UI_LIMITS.nameChars} characters`, v, `1-${UI_LIMITS.nameChars} characters`);
}

function sizeCheck(errors: ModelErrorV2[], value: unknown, path: string, what: string): void {
  let bytes = 0;
  try {
    bytes = new TextEncoder().encode(JSON.stringify(canonicalJson(value))).length;
  } catch {
    return;
  }
  if (bytes > UI_LIMITS.documentBytes) err(errors, 'limits_exceeded', path, `a ${what} has at most ${UI_LIMITS.documentBytes} bytes of JSON`, bytes, `≤ ${UI_LIMITS.documentBytes}`);
}

/** One UI document (its own rules; references to themes, other documents and assets: `validateUiReferences`). */
export function validateUiDocument(value: unknown, path: string, errors: ModelErrorV2[], inputMaps: readonly string[] = ['gameplay', 'ui']): UiDocumentRefs | null {
  if (!isPlainObject(value)) {
    err(errors, 'field_type', path, 'a UI document is an object { uiDocumentId, name, root, … }', value, 'object');
    return null;
  }
  only(value, DOC_KEYS, path, errors, 'UI document');
  const id = value['uiDocumentId'];
  if (typeof id !== 'string' || !ID_RE.test(id)) err(errors, 'id_invalid', `${path}/uiDocumentId`, 'uiDocumentId uses the id syntax [a-z0-9][a-z0-9_-]{0,63}', id, 'an id');
  validateName(errors, value['name'], `${path}/name`, 'UI document');
  if (value['layer'] !== undefined && !(Number.isInteger(value['layer']) && isNum(value['layer'], -UI_LIMITS.layer, UI_LIMITS.layer))) err(errors, 'field_value', `${path}/layer`, `layer is an integer ${-UI_LIMITS.layer}–${UI_LIMITS.layer}`, value['layer'], `${-UI_LIMITS.layer}..${UI_LIMITS.layer}`);
  bool(errors, value['modal'], `${path}/modal`, 'modal');
  bool(errors, value['focus'], `${path}/focus`, 'focus');
  oneOf(errors, value['actionMap'], `${path}/actionMap`, inputMaps, 'actionMap');
  if (value['theme'] !== undefined && (typeof value['theme'] !== 'string' || !ID_RE.test(value['theme']))) err(errors, 'field_value', `${path}/theme`, 'theme names a UI theme', value['theme'], 'a uiThemeId');
  const scale = value['scale'];
  if (scale !== undefined) {
    if (!isPlainObject(scale)) err(errors, 'field_type', `${path}/scale`, 'scale is { reference: [w, h], mode: fit | width | height }', scale, 'object');
    else {
      only(scale, ['reference', 'mode'], `${path}/scale`, errors, 'scale');
      tuple(errors, scale['reference'], `${path}/scale/reference`, 2, 16, UI_LIMITS.px, 'reference');
      if (scale['reference'] === undefined) err(errors, 'field_missing', `${path}/scale/reference`, 'scale has a reference size', undefined, '[w, h]');
      oneOf(errors, scale['mode'], `${path}/scale/mode`, ['fit', 'width', 'height'], 'mode');
      if (scale['mode'] === undefined) err(errors, 'field_missing', `${path}/scale/mode`, 'scale has a mode', undefined, 'fit | width | height');
    }
  }
  const refs = newRefs();
  validateNamedMap(errors, value['styles'], `${path}/styles`, UI_LIMITS.styles, 'styles', (s, p) => {
    validateUiStyle(s, p, errors);
    collectStyleAssets(s, p, refs);
  });
  validateNamedMap(errors, value['icons'], `${path}/icons`, UI_LIMITS.icons, 'icons', (s, p) => {
    validateIcon(errors, s, p);
    if (isPlainObject(s) && typeof s['asset'] === 'string') refs.images.push({ id: s['asset'], path: `${p}/asset` });
  });
  validateNamedMap(errors, value['tweens'], `${path}/tweens`, UI_LIMITS.tweens, 'tweens', (s, p) => validateTween(errors, s, p));
  for (const k of ['showTween', 'hideTween'] as const) {
    const t = value[k];
    if (t === undefined) continue;
    if (!isName(t)) err(errors, 'field_value', `${path}/${k}`, 'names a tween of this document', t, 'a tween name');
    else refs.tweens.push({ name: t, path: `${path}/${k}` });
  }
  if (value['initialFocus'] !== undefined) {
    if (!isName(value['initialFocus'])) err(errors, 'field_value', `${path}/initialFocus`, 'names a widget of this document', value['initialFocus'], 'a widget id');
    else refs.widgets.push({ id: value['initialFocus'], path: `${path}/initialFocus` });
  }
  validateActions(errors, value['onCancel'], `${path}/onCancel`, refs);
  if (value['root'] === undefined) err(errors, 'field_missing', `${path}/root`, 'a UI document has a root widget', undefined, 'root');
  else validateWidget(errors, value['root'], `${path}/root`, refs, 1, false);
  // Document-local references: widget ids and tweens.
  for (const w of refs.widgets) if (!refs.ids.has(w.id)) err(errors, 'reference_missing', w.path, `no widget with the id "${w.id}" in this document`, w.id, 'a widget id of this document');
  const tweens = isPlainObject(value['tweens']) ? value['tweens'] : {};
  for (const t of refs.tweens) if (!Object.prototype.hasOwnProperty.call(tweens, t.name)) err(errors, 'reference_missing', t.path, `no tween "${t.name}" in this document`, t.name, 'a tween name of this document');
  sizeCheck(errors, value, path, 'UI document');
  return { docs: refs.docs, styles: refs.styles, images: refs.images, fonts: refs.fonts, icons: refs.icons };
}

export function validateUiDocuments(value: unknown, path: string, errors: ModelErrorV2[], inputMaps?: readonly string[]): void {
  if (!Array.isArray(value)) return err(errors, 'field_type', path, 'uiDocuments is a list of UI documents', value, 'array');
  if (value.length > UI_LIMITS.documents) err(errors, 'limits_exceeded', path, `a project has at most ${UI_LIMITS.documents} UI documents`, value.length, `≤ ${UI_LIMITS.documents}`);
  const seen = new Set<string>();
  value.forEach((d, i) => {
    validateUiDocument(d, `${path}/${i}`, errors, inputMaps);
    const id = isPlainObject(d) ? d['uiDocumentId'] : undefined;
    if (typeof id === 'string') {
      if (seen.has(id)) err(errors, 'id_duplicate', `${path}/${i}/uiDocumentId`, `two UI documents use the id "${id}"`, id, 'a unique uiDocumentId');
      seen.add(id);
    }
  });
}

export function validateUiTheme(value: unknown, path: string, errors: ModelErrorV2[]): UiDocumentRefs | null {
  if (!isPlainObject(value)) {
    err(errors, 'field_type', path, 'a UI theme is an object { uiThemeId, name, styles, icons? }', value, 'object');
    return null;
  }
  only(value, ['uiThemeId', 'name', 'styles', 'icons'], path, errors, 'UI theme');
  const id = value['uiThemeId'];
  if (typeof id !== 'string' || !ID_RE.test(id)) err(errors, 'id_invalid', `${path}/uiThemeId`, 'uiThemeId uses the id syntax [a-z0-9][a-z0-9_-]{0,63}', id, 'an id');
  validateName(errors, value['name'], `${path}/name`, 'UI theme');
  const refs = newRefs();
  if (value['styles'] === undefined) err(errors, 'field_missing', `${path}/styles`, 'a theme has styles', undefined, 'styles');
  validateNamedMap(errors, value['styles'], `${path}/styles`, UI_LIMITS.styles, 'styles', (s, p) => {
    validateUiStyle(s, p, errors);
    collectStyleAssets(s, p, refs);
  });
  validateNamedMap(errors, value['icons'], `${path}/icons`, UI_LIMITS.icons, 'icons', (s, p) => {
    validateIcon(errors, s, p);
    if (isPlainObject(s) && typeof s['asset'] === 'string') refs.images.push({ id: s['asset'], path: `${p}/asset` });
  });
  sizeCheck(errors, value, path, 'UI theme');
  return { docs: [], styles: [], images: refs.images, fonts: refs.fonts, icons: [] };
}

export function validateUiThemes(value: unknown, path: string, errors: ModelErrorV2[]): void {
  if (!Array.isArray(value)) return err(errors, 'field_type', path, 'uiThemes is a list of UI themes', value, 'array');
  if (value.length > UI_LIMITS.themes) err(errors, 'limits_exceeded', path, `a project has at most ${UI_LIMITS.themes} UI themes`, value.length, `≤ ${UI_LIMITS.themes}`);
  const seen = new Set<string>();
  value.forEach((t, i) => {
    validateUiTheme(t, `${path}/${i}`, errors);
    const id = isPlainObject(t) ? t['uiThemeId'] : undefined;
    if (typeof id === 'string') {
      if (seen.has(id)) err(errors, 'id_duplicate', `${path}/${i}/uiThemeId`, `two UI themes use the id "${id}"`, id, 'a unique uiThemeId');
      seen.add(id);
    }
  });
}

/**
 * The project-level references of the UI documents and themes: a document's
 * theme exists; its style names are its own or its theme's; its icons are its
 * own or its theme's; show/hide actions name documents of the project; images
 * name texture assets and fonts font assets (by `kindOf`). Also checks
 * `flow.screens` (each names a document).
 */
export function validateUiReferences(content: Record<string, unknown>, errors: ModelErrorV2[], kindOf: (assetId: string) => unknown): void {
  const docs = Array.isArray(content['uiDocuments']) ? (content['uiDocuments'] as unknown[]) : [];
  const themes = Array.isArray(content['uiThemes']) ? (content['uiThemes'] as unknown[]) : [];
  const docIds = new Set(docs.filter(isPlainObject).map((d) => d['uiDocumentId']));
  const themeById = new Map(themes.filter(isPlainObject).map((t) => [t['uiThemeId'], t] as const));
  const assetRefs = (r: UiDocumentRefs, at: string): void => {
    for (const img of r.images) if (kindOf(img.id) !== 'texture') err(errors, 'asset_reference_missing', `${at}${img.path}`, 'this image must name a texture asset of this project', img.id, 'a texture assetId');
    for (const f of r.fonts) if (kindOf(f.id) !== 'font') err(errors, 'asset_reference_missing', `${at}${f.path}`, 'this font must name a font asset of this project (or sans, serif, mono, rounded)', f.id, 'a font assetId');
  };
  themes.forEach((t, i) => {
    const scratch: ModelErrorV2[] = [];
    const r = validateUiTheme(t, '', scratch);
    if (r !== null && scratch.length === 0) assetRefs(r, `/uiThemes/${i}`);
  });
  docs.forEach((d, i) => {
    if (!isPlainObject(d)) return;
    const scratch: ModelErrorV2[] = [];
    const r = validateUiDocument(d, '', scratch);
    if (r === null || scratch.length > 0) return;
    const at = `/uiDocuments/${i}`;
    let theme: Record<string, unknown> | undefined;
    if (typeof d['theme'] === 'string') {
      theme = themeById.get(d['theme']) as Record<string, unknown> | undefined;
      if (theme === undefined) err(errors, 'reference_missing', `${at}/theme`, `no UI theme "${d['theme']}" in this project`, d['theme'], 'a uiThemeId');
    }
    const has = (map: unknown, key: string): boolean => isPlainObject(map) && Object.prototype.hasOwnProperty.call(map, key);
    for (const s of r.styles) if (!has(d['styles'], s.name) && !has(theme?.['styles'], s.name)) err(errors, 'reference_missing', `${at}${s.path}`, `no style "${s.name}" in this document or its theme`, s.name, 'a style name');
    for (const ic of r.icons) if (!has(d['icons'], ic.name) && !has(theme?.['icons'], ic.name)) err(errors, 'reference_missing', `${at}${ic.path}`, `no icon "${ic.name}" in this document or its theme`, ic.name, 'an icon name');
    for (const ref of r.docs) if (!docIds.has(ref.id)) err(errors, 'reference_missing', `${at}${ref.path}`, `no UI document "${ref.id}" in this project`, ref.id, 'a uiDocumentId');
    assetRefs(r, at);
  });
  const flow = content['flow'];
  const screens = isPlainObject(flow) ? flow['screens'] : undefined;
  if (isPlainObject(screens)) {
    for (const [k, id] of Object.entries(screens)) if (typeof id === 'string' && !docIds.has(id)) err(errors, 'reference_missing', `/flow/screens/${k}`, `no UI document "${id}" in this project`, id, 'a uiDocumentId');
  }
}

// ---------------------------------------------------------------------------
// Canonical form and runtime rows
// ---------------------------------------------------------------------------

/**
 * The canonical JSON of a validated value: objects with their keys sorted,
 * arrays in order, nothing added or dropped (validation refuses unknown
 * fields, so every field survives).
 */
function canonicalJson(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(canonicalJson);
  if (isPlainObject(v)) {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(v).sort()) if (v[k] !== undefined) out[k] = canonicalJson(v[k]);
    return out;
  }
  return Object.is(v, -0) ? 0 : v;
}

export function canonicalUiDocument(d: UiDocument): UiDocument {
  return canonicalJson(d) as UiDocument;
}
export function canonicalUiDocuments(list: readonly UiDocument[]): UiDocument[] {
  return [...list].map(canonicalUiDocument).sort((a, b) => (a.uiDocumentId < b.uiDocumentId ? -1 : a.uiDocumentId > b.uiDocumentId ? 1 : 0));
}
export function canonicalUiTheme(t: UiTheme): UiTheme {
  return canonicalJson(t) as UiTheme;
}
export function canonicalUiThemes(list: readonly UiTheme[]): UiTheme[] {
  return [...list].map(canonicalUiTheme).sort((a, b) => (a.uiThemeId < b.uiThemeId ? -1 : a.uiThemeId > b.uiThemeId ? 1 : 0));
}

/** The runtime's rows (id, layer, modal) of the project's documents, in id order. */
export function uiDocumentsForRuntime(list: readonly UiDocument[] | undefined): RuntimeUiDocumentRow[] | undefined {
  if (list === undefined || list.length === 0) return undefined;
  return canonicalUiDocuments(list).map((d) => ({ uiDocumentId: d.uiDocumentId, layer: d.layer ?? 0, modal: d.modal === true }));
}

/** Every texture and font asset the documents and themes use (for the export closure and asset checks). */
export function uiAssetRefs(docs: readonly UiDocument[] | undefined, themes: readonly UiTheme[] | undefined): { textures: string[]; fonts: string[] } {
  const textures = new Set<string>();
  const fonts = new Set<string>();
  for (const d of docs ?? []) {
    const r = validateUiDocument(d, '', []);
    for (const x of r?.images ?? []) textures.add(x.id);
    for (const x of r?.fonts ?? []) fonts.add(x.id);
  }
  for (const t of themes ?? []) {
    const r = validateUiTheme(t, '', []);
    for (const x of r?.images ?? []) textures.add(x.id);
    for (const x of r?.fonts ?? []) fonts.add(x.id);
  }
  return { textures: [...textures].sort(), fonts: [...fonts].sort() };
}
