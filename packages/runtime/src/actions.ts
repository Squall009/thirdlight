/**
 * Step-indexed action frames and the injected input port — runtime.md §12.5
 * (promoted from `input.md` §2/§3/§6).
 *
 * `ActionFrame` is the ONLY input vocabulary the runtime core and modules
 * see: numbers plus one string enum, never a raw DOM/Gamepad object. The
 * runtime samples a frame exactly once per executed fixed step
 * (`ActionSource.sample(stepIndex)`), before any module phase.
 *
 * Phase 24.8: frame version 2. A frame carries only named actions
 * (`actions`); the fixed `moveX`/`moveY`/`jump` channels of version 1 are
 * gone — the character controller reads the actions it is configured with
 * (`move` and `jump` by default). A version 1 frame (one with `moveX` or
 * `jump`) is upgraded when it is read (`upgradeActionFrameV1`): the channels
 * become the `move` and `jump` actions, so a recording made before replays
 * the same.
 *
 * `createRecordedActionSource` is the engine-level replay source
 * (runtime.md §12.7): construction validates every frame and the strict
 * ascent of `stepIndex`, so a recorded fixture replays identically in the
 * Node harness, the preview bundle and the export bundle.
 */
import { clipMessage } from './errors';
// Phase 24.8: the action names a character controller reads (re-exported for the controller modules).
export { controllerActionsOf } from '@thirdlight/project-model';
import { validateSaveEvents, type SaveEvent } from './project-saves';
import { validateInputStatus, type InputStatusEntry } from './input-status';
import { validateUiEvents, type UiEventRecord } from './ui';
import { validateDialogueInputs, type DialogueInputRecord } from './dialogue';

/** The four jump phases (input.md §2). */
export type JumpPhase = 'none' | 'pressed' | 'held' | 'released';

/** Canonical `JumpPhase` order (input.md §2 table order). */
export const JUMP_PHASES: readonly JumpPhase[] = ['none', 'pressed', 'held', 'released'];

/** Phase 24.8: the action frame format version (2: named actions only; 1 had the fixed moveX/moveY/jump channels). */
export const ACTION_FRAME_VERSION = 2;

/** One self-describing action frame (runtime.md §12.5; phase 24.8: version 2). */
export interface ActionFrame {
  /** Integer, `0 ≤ v ≤ 2^53−1` — the executed fixed-step index. */
  stepIndex: number;
  /**
   * Phase 9.8, optional: every named input action this step — `v` its value
   * (a button 0/1, an axis −1..1 after its processors), `x`/`y` for a 2D
   * axis, `p` the button phase. Absent: no action has a value (all neutral).
   */
  actions?: Readonly<Record<string, ActionValue>>;
  /**
   * Phase 23.3, optional: the pointer (mouse, pen, touch) this step. Absent:
   * no new sample — the runtime keeps the last position, buttons and
   * over/locked state (no movement, no edges).
   */
  pointer?: PointerSample;
  /**
   * Phase 23.8, optional: the debug commands run in this step (a tool, the
   * in-game console) — part of the input so a recording replays them exactly.
   * Absent: none (every older frame and recording is unchanged).
   * @graphNode skip a script receives its debug commands with ctx.debug.command
   */
  commands?: readonly DebugCommandCall[];
  /**
   * Phase 23.19, optional: storage's answers this step (the slot list, save and
   * delete outcomes, a loaded save document) — part of the input so a
   * recording replays them and the worker applies them at the same step.
   * Absent: none (every older frame and recording is unchanged).
   * @graphNode skip a script reads them through ctx.saves
   */
  saves?: readonly SaveEvent[];
  /**
   * Phase 23.14, optional: the host's input status for scripts — the device
   * used last, the player's bindings with their glyphs (each only when it
   * changed) and the outcome of binding requests. Part of the input so a
   * replay shows scripts what they saw live. Absent: nothing changed.
   * @graphNode skip scripts read it with ctx.input.device, bindings and glyph
   */
  input?: InputStatusEntry;
  /**
   * Phase 23.9a, optional: the UI events of this step (a click, a submit, a
   * focus change, a custom event, a document shown or hidden by a button) —
   * part of the input so a recording replays them exactly. Absent: none
   * (every older frame and recording is unchanged).
   * @graphNode skip a script reads its UI events with ctx.ui.events / ctx.ui.event
   */
  ui?: readonly UiEventRecord[];
  /**
   * Phase 23.16, optional: the dialogue inputs of this step (advance, choose,
   * skip, auto, backlog — from the dialogue UI's buttons) — part of the input
   * so a recording replays them exactly. Absent: none (every older frame and
   * recording is unchanged).
   * @graphNode skip scripts drive conversations with ctx.dialogue
   */
  dialogue?: readonly DialogueInputRecord[];
}

/** Phase 23.8: one debug command call carried by an input frame. */
export interface DebugCommandCall {
  /** The command a script registered (`ctx.debug.command(name, …)`). */
  readonly name: string;
  /** Its arguments by name: numbers, text (≤ 256 characters) or true/false. */
  readonly args: Readonly<Record<string, DebugCommandArg>>;
}
export type DebugCommandArg = number | string | boolean;

/** Phase 23.8: engine limits of debug commands (per frame; arguments per call). */
export const MAX_FRAME_COMMANDS = 8;
export const MAX_COMMAND_ARGS = 8;
export const MAX_COMMAND_TEXT = 256;
/** A debug command or argument name. */
export const DEBUG_COMMAND_NAME_RE = /^[A-Za-z_][A-Za-z0-9_.:-]{0,31}$/;

/** Phase 9.8: one input action's value in a step. */
export interface ActionValue {
  readonly v: number;
  readonly x?: number;
  readonly y?: number;
  readonly p: JumpPhase;
  /**
   * Phase 23.3: 1 when the value is an amount per sample (pointer movement,
   * wheel) rather than a level: a further step of the same sample sees 0,
   * and two samples merged before a step add up.
   */
  readonly i?: 1;
}

/**
 * Phase 23.3: one pointer sample. Positions are fractions of the game view
 * (x 0 left → 1 right, y 0 top → 1 bottom — the camera's screen
 * coordinates), quantized to 1e-4; with a locked cursor the position is the
 * view's centre and only the movement counts. Buttons are bits: 1 left,
 * 2 right, 4 middle.
 */
export interface PointerSample {
  readonly x: number;
  readonly y: number;
  /** Movement since the last sample, as fractions of the view's width / height (y down); absent 0. */
  readonly dx?: number;
  readonly dy?: number;
  /** Wheel notches since the last sample (positive towards the user); absent 0. */
  readonly wheel?: number;
  /** Buttons held now (bits); absent 0. */
  readonly buttons?: number;
  /** Buttons that went down / up since the last sample (a click between two samples sets both); absent 0. The runtime also derives them from `buttons`. */
  readonly pressed?: number;
  readonly released?: number;
  /** The pointer is over the game view; absent true. */
  readonly over?: boolean;
  /** The cursor is locked (hidden, held in the view); absent false. */
  readonly locked?: boolean;
}

/** Phase 23.3: the pointer's button bits (DOM `buttons`). */
export const POINTER_BUTTON_BITS = Object.freeze({ left: 1, right: 2, middle: 4 } as const);
const POINTER_KEYS = new Set(['x', 'y', 'dx', 'dy', 'wheel', 'buttons', 'pressed', 'released', 'over', 'locked']);

/** Most named actions in a frame (project-model MAX_INPUT_ACTIONS). */
export const MAX_FRAME_ACTIONS = 64;
const ACTION_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]{0,31}$/;

/** Movement quantization (input.md §3.3). */
export const MOVE_QUANTUM = 1e-4;
/** `maxRelaySteps`-independent upper bound for a step index. */
const MAX_STEP_INDEX = 2 ** 53 - 1;
const FRAME_KEYS = new Set(['stepIndex']);
/** The version 1 channels (`upgradeActionFrameV1`). */
const V1_CHANNELS = new Set(['moveX', 'moveY', 'jump']);

/** Input-source lifecycle/diagnostic counters a binding may expose (input.md §5). */
export interface ActionSourceDiagnostics {
  suspendCount?: number;
  activateCount?: number;
  disconnectCount?: number;
  mappingUnsupportedCount?: number;
}

/**
 * The injected per-step input port (runtime.md §12.5.1). Strict shape: not a
 * raw DOM/Gamepad object. `sample(n)` is called exactly once per executed
 * step; `reset`/`diagnostics` are optional host hooks.
 */
export interface ActionSource {
  sample(stepIndex: number): ActionFrame;
  reset?(reason?: string): void;
  diagnostics?(): ActionSourceDiagnostics;
}

/** The neutral frame for a step index (input.md §2, normative; phase 24.8: no action has a value). */
export function neutralFrame(stepIndex: number): ActionFrame {
  return { stepIndex };
}

/**
 * Phase 24.8: read a version 1 frame (one with the fixed `moveX`/`moveY`/
 * `jump` channels) as version 2. The channels become the `move` action (`v`
 * = moveX; with moveY also `x`, `y`) and the `jump` action (`v` 1 while
 * pressed or held, `p` the phase), replacing those actions' values if the
 * frame had them too — the channels were what the character controller read,
 * so a recording replays the same. Other fields are kept. A frame without
 * the channels is returned as it is. The values are not validated here.
 */
export function upgradeActionFrameV1(raw: unknown): unknown {
  if (!isPlainObject(raw) || !(hasOwn.call(raw, 'moveX') || hasOwn.call(raw, 'jump') || hasOwn.call(raw, 'moveY'))) return raw;
  const { moveX, moveY, jump, ...rest } = raw;
  const actions: Record<string, unknown> = isPlainObject(rest['actions']) ? { ...(rest['actions'] as Record<string, unknown>) } : {};
  if (moveX !== undefined || moveY !== undefined) {
    const prev = isPlainObject(actions['move']) ? (actions['move'] as Record<string, unknown>) : null;
    const x = moveX ?? 0;
    actions['move'] =
      moveY !== undefined
        ? { v: prev?.['v'] ?? x, x, y: moveY, p: prev?.['p'] ?? 'none' }
        : prev !== null && (prev['x'] !== undefined || prev['y'] !== undefined)
          ? { ...prev, x }
          : { v: x, p: prev?.['p'] ?? 'none' };
  }
  if (jump !== undefined) actions['jump'] = { v: jump === 'pressed' || jump === 'held' ? 1 : 0, p: jump };
  return { ...rest, actions };
}

/** Phase 24.8: the version 1 channel rules (moveX and jump required together; moveX/moveY in [−1, 1] quantized to 1e-4; jump a phase). */
function checkV1Channels(raw: unknown): { ok: false; field: string; message: string } | null {
  if (!isPlainObject(raw) || !(hasOwn.call(raw, 'moveX') || hasOwn.call(raw, 'jump') || hasOwn.call(raw, 'moveY'))) return null;
  for (const key of ['moveX', 'jump']) {
    if (!(key in raw)) return { ok: false, field: key, message: `action frame field "${key}" is missing (a version 1 frame has moveX and jump)` };
  }
  for (const key of ['moveX', 'moveY'] as const) {
    const v = raw[key];
    if (key === 'moveY' && v === undefined) continue;
    if (typeof v !== 'number' || !Number.isFinite(v) || v < -1 || v > 1) return { ok: false, field: key, message: `${key} must be finite and within [-1, 1]` };
    if (quantizeMove(v) !== v || Object.is(v, -0)) return { ok: false, field: key, message: `${key} must be quantized to 1e-4 (negative zero normalized)` };
  }
  const jump = raw['jump'];
  if (typeof jump !== 'string' || !JUMP_PHASES.includes(jump as JumpPhase)) return { ok: false, field: 'jump', message: 'jump must be one of none | pressed | held | released' };
  return null;
}

/**
 * Phase 24.8: the move vector of the action `name` in a frame — `x` (a 2D
 * axis) else `v`, and `y` (0 without a second axis); [0, 0] when absent.
 */
export function actionAxis(frame: ActionFrame, name: string): [number, number] {
  const a = frame.actions?.[name];
  if (a === undefined) return [0, 0];
  return [a.x ?? a.v, a.y ?? 0];
}

/** Phase 24.8: the button phase of the action `name` in a frame ('none' when absent). */
export function actionPhase(frame: ActionFrame, name: string): JumpPhase {
  return frame.actions?.[name]?.p ?? 'none';
}

/**
 * The built-in source used when the host injects none: always the neutral
 * frame (M1 behavior preserved exactly).
 */
export const NEUTRAL_ACTION_SOURCE: ActionSource = Object.freeze({
  sample: (stepIndex: number): ActionFrame => neutralFrame(stepIndex),
});

/** The malformed-frame failure (input.md §2): `input_frame_invalid`. */
export class InputFrameError extends Error {
  readonly code = 'input_frame_invalid';
  readonly field: string;
  constructor(field: string, message: string) {
    super(clipMessage(message));
    this.name = 'InputFrameError';
    this.field = field;
  }
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** `round(v·1e4)/1e4`, negative zero normalized to `0` (input.md §3.3). */
export function quantizeMove(v: number): number {
  const q = Math.round(v * 1e4) / 1e4;
  return q === 0 ? 0 : q;
}

/**
 * Validate one `ActionFrame` strictly. Returns a failure with the offending
 * `field` instead of throwing so callers choose the outcome (config_invalid
 * at construction, module_error at sample time).
 */
export function validateActionFrame(
  raw: unknown,
  expectedStepIndex?: number,
  previous?: ActionFrame,
): { ok: true; frame: ActionFrame } | { ok: false; field: string; message: string } {
  // Phase 24.8: a version 1 frame is read as version 2 (its channels become the move/jump actions),
  // after its channels pass the version 1 rules.
  const v1 = checkV1Channels(raw);
  if (v1 !== null) return v1;
  const value = upgradeActionFrameV1(raw);
  if (!isPlainObject(value)) {
    return { ok: false, field: '', message: 'action frame must be an object' };
  }
  for (const key in value) {
    if (!hasOwn.call(value, key) || key === 'actions' || key === 'pointer' || key === 'commands' || key === 'saves' || key === 'ui' || key === 'input' || key === 'dialogue') continue;
    if (!FRAME_KEYS.has(key)) {
      return { ok: false, field: key, message: V1_CHANNELS.has(key) ? `action frame field "${key}" is a version 1 channel (upgradeActionFrameV1)` : `unknown action frame field "${key}" (strict shape)` };
    }
  }
  for (const key of FRAME_KEYS) {
    if (!(key in value)) {
      return { ok: false, field: key, message: `action frame field "${key}" is missing` };
    }
  }
  const stepIndex = value['stepIndex'];
  if (
    typeof stepIndex !== 'number' ||
    !Number.isInteger(stepIndex) ||
    stepIndex < 0 ||
    stepIndex > MAX_STEP_INDEX
  ) {
    return { ok: false, field: 'stepIndex', message: 'stepIndex must be an integer in [0, 2^53-1]' };
  }
  if (expectedStepIndex !== undefined && stepIndex !== expectedStepIndex) {
    return {
      ok: false,
      field: 'stepIndex',
      message: `frame stepIndex ${stepIndex} does not match the sampled step ${expectedStepIndex}`,
    };
  }
  // Phase 23.3: the pointer sample (optional; old frames have none).
  let pointer: PointerSample | undefined;
  if (value['pointer'] !== undefined) {
    const checked = validatePointerSample(value['pointer']);
    if (!checked.ok) return { ok: false, field: `pointer${checked.field === '' ? '' : `/${checked.field}`}`, message: checked.message };
    pointer = checked.pointer;
  }
  // Phase 23.8: the frame's debug commands (validated and frozen; absent keeps the frame as it was).
  let commands: readonly DebugCommandCall[] | undefined;
  if (value['commands'] !== undefined) {
    const c = validateDebugCommands(value['commands']);
    if (!c.ok) return c;
    commands = c.commands;
  }
  // Phase 23.19: storage's answers (validated and frozen; absent keeps the frame as it was).
  let saves: readonly SaveEvent[] | undefined;
  if (value['saves'] !== undefined) {
    const sv = validateSaveEvents(value['saves']);
    if (!sv.ok) return sv;
    saves = sv.events;
  }
  // Phase 23.14: the host's input status (validated and frozen).
  let input: InputStatusEntry | undefined;
  if (value['input'] !== undefined) {
    const c = validateInputStatus(value['input']);
    if (!c.ok) return c;
    input = c.input;
  }
  // Phase 23.9a: the frame's UI events (validated and frozen; absent keeps the frame as it was).
  let uiEvents: readonly UiEventRecord[] | undefined;
  if (value['ui'] !== undefined) {
    const u = validateUiEvents(value['ui']);
    if (!u.ok) return u;
    uiEvents = u.events;
  }
  // Phase 23.16: the frame's dialogue inputs (validated and frozen; absent keeps the frame as it was).
  let dialogueInputs: readonly DialogueInputRecord[] | undefined;
  if (value['dialogue'] !== undefined) {
    const d = validateDialogueInputs(value['dialogue']);
    if (!d.ok) return d;
    dialogueInputs = d.inputs;
  }
  const withExtras = <F extends ActionFrame>(f: F): F => (dialogueInputs === undefined ? withExtras0(f) : { ...withExtras0(f), dialogue: dialogueInputs });
  const withExtras0 = <F extends ActionFrame>(f: F): F => (pointer === undefined && commands === undefined && uiEvents === undefined && saves === undefined && input === undefined ? f : { ...f, ...(commands !== undefined ? { commands } : {}), ...(saves !== undefined ? { saves } : {}), ...(pointer !== undefined ? { pointer } : {}), ...(uiEvents !== undefined ? { ui: uiEvents } : {}), ...(input !== undefined ? { input } : {}) });
  const rawActions = value['actions'];
  // Phase 23.8 / 23.3 / 23.9a: commands, the pointer and UI events only when present (a frame without them stays as it was).
  if (rawActions === undefined) return { ok: true, frame: withExtras({ stepIndex }) };
  if (!isPlainObject(rawActions) || ownKeyCount(rawActions) > MAX_FRAME_ACTIONS) {
    return { ok: false, field: 'actions', message: `actions must map at most ${MAX_FRAME_ACTIONS} action names to values` };
  }
  // Phase 21.2: the frozen action values (and the whole frozen map) of the
  // previous frame are reused when they are equal — they are immutable, so
  // sharing them is invisible, and steady input makes no objects per step.
  const prevActions = previous?.actions;
  let same = prevActions !== undefined;
  let index = 0;
  for (const name in rawActions) {
    if (!hasOwn.call(rawActions, name)) continue;
    const a = rawActions[name];
    if (!ACTION_NAME_RE.test(name) || !isPlainObject(a) || !actionNumber(a['v']) || !JUMP_PHASES.includes(a['p'] as JumpPhase) || (a['x'] !== undefined && !actionNumber(a['x'])) || (a['y'] !== undefined && !actionNumber(a['y'])) || (a['i'] !== undefined && a['i'] !== 1)) {
      return { ok: false, field: `actions/${name}`, message: 'an action value is { v, x?, y? (numbers in [-10, 10]), p: none | pressed | held | released, i?: 1 }' };
    }
    for (const k in a) if (hasOwn.call(a, k) && k !== 'v' && k !== 'x' && k !== 'y' && k !== 'p' && k !== 'i') return { ok: false, field: `actions/${name}/${k}`, message: `unknown action value field "${k}"` };
    if (same && !(sameActionValue(prevActions![name], a) && keyAt(prevActions!, index) === name)) same = false;
    index += 1;
  }
  if (same && ownKeyCount(prevActions!) === index) return { ok: true, frame: withExtras({ stepIndex, actions: prevActions! }) };
  const actions: Record<string, ActionValue> = {};
  for (const name in rawActions) {
    if (!hasOwn.call(rawActions, name)) continue;
    const a = rawActions[name] as Record<string, unknown>;
    const prev = prevActions?.[name];
    actions[name] =
      prev !== undefined && sameActionValue(prev, a)
        ? prev
        : Object.freeze({ v: a['v'] as number, ...(a['x'] !== undefined ? { x: a['x'] as number } : {}), ...(a['y'] !== undefined ? { y: a['y'] as number } : {}), p: a['p'] as JumpPhase, ...(a['i'] === 1 ? { i: 1 as const } : {}) });
  }
  return { ok: true, frame: withExtras({ stepIndex, actions: Object.freeze(actions) }) };
}

/**
 * Phase 23.3: validate one pointer sample strictly (numbers finite; x, y in
 * [0, 1]; movement and wheel in [-10, 10]; button masks 0–7; booleans).
 * Returns a frozen copy with only the fields given.
 */
export function validatePointerSample(value: unknown): { ok: true; pointer: PointerSample } | { ok: false; field: string; message: string } {
  if (!isPlainObject(value)) return { ok: false, field: '', message: 'pointer is { x, y, dx?, dy?, wheel?, buttons?, pressed?, released?, over?, locked? }' };
  for (const k in value) if (hasOwn.call(value, k) && !POINTER_KEYS.has(k)) return { ok: false, field: k, message: `unknown pointer field "${k}"` };
  const unit = (v: unknown): boolean => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1;
  const mask = (v: unknown): boolean => v === undefined || (typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= 7);
  const amount = (v: unknown): boolean => v === undefined || actionNumber(v);
  const flag = (v: unknown): boolean => v === undefined || typeof v === 'boolean';
  if (!unit(value['x'])) return { ok: false, field: 'x', message: 'pointer x is a number in [0, 1] (0 = the left of the view)' };
  if (!unit(value['y'])) return { ok: false, field: 'y', message: 'pointer y is a number in [0, 1] (0 = the top of the view)' };
  for (const k of ['dx', 'dy', 'wheel'] as const) if (!amount(value[k])) return { ok: false, field: k, message: `pointer ${k} is a number in [-10, 10]` };
  for (const k of ['buttons', 'pressed', 'released'] as const) if (!mask(value[k])) return { ok: false, field: k, message: `pointer ${k} is a button mask 0-7 (1 left, 2 right, 4 middle)` };
  for (const k of ['over', 'locked'] as const) if (!flag(value[k])) return { ok: false, field: k, message: `pointer ${k} is true or false` };
  const out: Record<string, number | boolean> = { x: value['x'] as number, y: value['y'] as number };
  for (const k of ['dx', 'dy', 'wheel', 'buttons', 'pressed', 'released', 'over', 'locked'] as const) if (value[k] !== undefined) out[k] = value[k] as number | boolean;
  return { ok: true, pointer: Object.freeze(out) as unknown as PointerSample };
}

/**
 * Phase 23.8: validate a frame's `commands` (at most 8 calls, each
 * `{ name, args }` with at most 8 arguments: finite numbers, text up to 256
 * characters, or booleans). Returns frozen copies.
 */
export function validateDebugCommands(raw: unknown): { ok: true; commands: readonly DebugCommandCall[] } | { ok: false; field: string; message: string } {
  if (!Array.isArray(raw) || raw.length > MAX_FRAME_COMMANDS) return { ok: false, field: 'commands', message: `commands must be an array of at most ${MAX_FRAME_COMMANDS} debug command calls` };
  const out: DebugCommandCall[] = [];
  for (let i = 0; i < raw.length; i += 1) {
    const c = validateDebugCommandCall(raw[i]);
    if (!c.ok) return { ok: false, field: `commands/${i}${c.field === '' ? '' : `/${c.field}`}`, message: c.message };
    out.push(c.call);
  }
  return { ok: true, commands: Object.freeze(out) };
}

/** Phase 23.8: validate one debug command call (see `validateDebugCommands`). */
export function validateDebugCommandCall(raw: unknown): { ok: true; call: DebugCommandCall } | { ok: false; field: string; message: string } {
  if (!isPlainObject(raw)) return { ok: false, field: '', message: 'a debug command call is { name, args }' };
  for (const k in raw) if (hasOwn.call(raw, k) && k !== 'name' && k !== 'args') return { ok: false, field: k, message: `unknown debug command field "${k}"` };
  const name = raw['name'];
  if (typeof name !== 'string' || !DEBUG_COMMAND_NAME_RE.test(name)) return { ok: false, field: 'name', message: 'a debug command name is a letter or _, then up to 31 letters, digits, _ . : -' };
  const rawArgs = raw['args'] ?? {};
  if (!isPlainObject(rawArgs) || ownKeyCount(rawArgs) > MAX_COMMAND_ARGS) return { ok: false, field: 'args', message: `args maps at most ${MAX_COMMAND_ARGS} argument names to values` };
  const args: Record<string, DebugCommandArg> = {};
  for (const k of Object.keys(rawArgs).sort()) {
    const v = rawArgs[k];
    if (!DEBUG_COMMAND_NAME_RE.test(k)) return { ok: false, field: `args/${k}`, message: 'an argument name is a letter or _, then up to 31 letters, digits, _ . : -' };
    if (!((typeof v === 'number' && Number.isFinite(v)) || (typeof v === 'string' && v.length <= MAX_COMMAND_TEXT) || typeof v === 'boolean')) {
      return { ok: false, field: `args/${k}`, message: `an argument is a finite number, text of at most ${MAX_COMMAND_TEXT} characters, or true/false` };
    }
    args[k] = Object.is(v, -0) ? 0 : (v as DebugCommandArg);
  }
  return { ok: true, call: Object.freeze({ name, args: Object.freeze(args) }) };
}

const hasOwn = Object.prototype.hasOwnProperty;

function actionNumber(x: unknown): boolean {
  return typeof x === 'number' && Number.isFinite(x) && x >= -10 && x <= 10;
}

function ownKeyCount(o: object): number {
  let n = 0;
  for (const k in o) if (hasOwn.call(o, k)) n += 1;
  return n;
}

/** The `index`-th own key of `o` (for-in order, as `Object.keys`). */
function keyAt(o: object, index: number): string | undefined {
  let i = 0;
  for (const k in o) {
    if (!hasOwn.call(o, k)) continue;
    if (i === index) return k;
    i += 1;
  }
  return undefined;
}

/** A validated raw action value equals a frozen one (the same fields; an absent x/y stays absent). */
function sameActionValue(prev: ActionValue | undefined, a: unknown): boolean {
  if (prev === undefined) return false;
  const r = a as Record<string, unknown>;
  return Object.is(prev.v, r['v']) && prev.p === r['p'] && Object.is(prev.x, r['x']) && Object.is(prev.y, r['y']) && ('x' in prev) === (r['x'] !== undefined) && ('y' in prev) === (r['y'] !== undefined);
}

/**
 * Build the engine-level replay source (runtime.md §12.7/`input.md` §6).
 *
 * Construction is strict: every frame is validated (a version 1 frame is
 * upgraded) and `stepIndex` must strictly ascend (phase 24.8: there is no
 * fixed jump column to chain-check). A violation throws an `InputFrameError` (code
 * `input_frame_invalid`) — the host maps it to `config_invalid` when it
 * builds the config. `sample(n)` is a pure lookup: a recorded frame, else the
 * neutral frame for `n`. `reset()` is a no-op (recorded sequences never
 * change on focus events).
 */
export function createRecordedActionSource(frames: readonly ActionFrame[]): ActionSource {
  if (!Array.isArray(frames)) {
    throw new InputFrameError('', 'recorded frames must be an array');
  }
  const byIndex = new Map<number, ActionFrame>();
  let prevIndex: number | null = null;
  for (let i = 0; i < frames.length; i += 1) {
    const check = validateActionFrame(frames[i]);
    if (!check.ok) {
      throw new InputFrameError(check.field, `frame ${i}: ${check.message}`);
    }
    const frame = check.frame;
    if (prevIndex !== null) {
      if (frame.stepIndex <= prevIndex) {
        throw new InputFrameError(
          'stepIndex',
          `frame ${i}: stepIndex ${frame.stepIndex} does not strictly ascend past ${prevIndex}`,
        );
      }
    }
    prevIndex = frame.stepIndex;
    byIndex.set(frame.stepIndex, Object.freeze({ ...frame }));
  }
  return Object.freeze({
    sample: (stepIndex: number): ActionFrame => byIndex.get(stepIndex) ?? neutralFrame(stepIndex),
    reset: (): void => {
      /* recorded sequences must not silently change on focus events */
    },
  });
}
