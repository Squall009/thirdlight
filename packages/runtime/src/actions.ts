/**
 * Step-indexed action frames and the injected input port — runtime.md §12.5
 * (promoted from `input.md` §2/§3/§6).
 *
 * `ActionFrame` is the ONLY input vocabulary the runtime core and modules
 * see: numbers plus one string enum, never a raw DOM/Gamepad object. The
 * runtime samples a frame exactly once per executed fixed step
 * (`ActionSource.sample(stepIndex)`), before any module phase.
 *
 * `createRecordedActionSource` is the engine-level replay source
 * (runtime.md §12.7): construction validates every frame, the strict ascent
 * of `stepIndex` and the jump phase chain, so a recorded fixture replays
 * identically in the Node harness, the preview bundle and the export bundle.
 */
import { clipMessage } from './errors';

/** The four jump phases (input.md §2). */
export type JumpPhase = 'none' | 'pressed' | 'held' | 'released';

/** Canonical `JumpPhase` order (input.md §2 table order). */
export const JUMP_PHASES: readonly JumpPhase[] = ['none', 'pressed', 'held', 'released'];

/** One quantized, self-describing action frame (runtime.md §12.5). */
export interface ActionFrame {
  /** Integer, `0 ≤ v ≤ 2^53−1` — the executed fixed-step index. */
  stepIndex: number;
  /** Finite, `−1 ≤ v ≤ 1`, quantized to 1e-4 (`round(v·1e4)/1e4`). */
  moveX: number;
  jump: JumpPhase;
  /**
   * Phase 9.8, optional: every named input action this step — `v` its value
   * (a button 0/1, an axis −1..1 after its processors), `x`/`y` for a 2D
   * axis, `p` the button phase. Absent: only move and jump exist.
   */
  actions?: Readonly<Record<string, ActionValue>>;
  /**
   * Phase 23.8, optional: the debug commands run in this step (a tool, the
   * in-game console) — part of the input so a recording replays them exactly.
   * Absent: none (every older frame and recording is unchanged).
   * @graphNode skip a script receives its debug commands with ctx.debug.command
   */
  commands?: readonly DebugCommandCall[];
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
}

/** Most named actions in a frame (project-model MAX_INPUT_ACTIONS). */
export const MAX_FRAME_ACTIONS = 32;
const ACTION_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]{0,31}$/;

/** Movement quantization (input.md §3.3). */
export const MOVE_QUANTUM = 1e-4;
/** `maxRelaySteps`-independent upper bound for a step index. */
const MAX_STEP_INDEX = 2 ** 53 - 1;
const FRAME_KEYS = new Set(['stepIndex', 'moveX', 'jump']);

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

/** The neutral frame for a step index (input.md §2, normative). */
export function neutralFrame(stepIndex: number): ActionFrame {
  return { stepIndex, moveX: 0, jump: 'none' };
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
  value: unknown,
  expectedStepIndex?: number,
  previous?: ActionFrame,
): { ok: true; frame: ActionFrame } | { ok: false; field: string; message: string } {
  if (!isPlainObject(value)) {
    return { ok: false, field: '', message: 'action frame must be an object' };
  }
  for (const key in value) {
    if (!hasOwn.call(value, key) || key === 'actions' || key === 'commands') continue;
    if (!FRAME_KEYS.has(key)) {
      return { ok: false, field: key, message: `unknown action frame field "${key}" (strict shape)` };
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
  const moveX = value['moveX'];
  if (typeof moveX !== 'number' || !Number.isFinite(moveX) || moveX < -1 || moveX > 1) {
    return { ok: false, field: 'moveX', message: 'moveX must be finite and within [-1, 1]' };
  }
  if (quantizeMove(moveX) !== moveX || Object.is(moveX, -0)) {
    return { ok: false, field: 'moveX', message: 'moveX must be quantized to 1e-4 (negative zero normalized)' };
  }
  const jump = value['jump'];
  if (typeof jump !== 'string' || !JUMP_PHASES.includes(jump as JumpPhase)) {
    return { ok: false, field: 'jump', message: 'jump must be one of none | pressed | held | released' };
  }
  // Phase 23.8: the frame's debug commands (validated and frozen; absent keeps the frame as it was).
  let commands: readonly DebugCommandCall[] | undefined;
  if (value['commands'] !== undefined) {
    const c = validateDebugCommands(value['commands']);
    if (!c.ok) return c;
    commands = c.commands;
  }
  const rawActions = value['actions'];
  if (rawActions === undefined) return { ok: true, frame: commands !== undefined ? { stepIndex, moveX, jump: jump as JumpPhase, commands } : { stepIndex, moveX, jump: jump as JumpPhase } };
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
    if (!ACTION_NAME_RE.test(name) || !isPlainObject(a) || !actionNumber(a['v']) || !JUMP_PHASES.includes(a['p'] as JumpPhase) || (a['x'] !== undefined && !actionNumber(a['x'])) || (a['y'] !== undefined && !actionNumber(a['y']))) {
      return { ok: false, field: `actions/${name}`, message: 'an action value is { v, x?, y? (numbers in [-10, 10]), p: none | pressed | held | released }' };
    }
    for (const k in a) if (hasOwn.call(a, k) && k !== 'v' && k !== 'x' && k !== 'y' && k !== 'p') return { ok: false, field: `actions/${name}/${k}`, message: `unknown action value field "${k}"` };
    if (same && !(sameActionValue(prevActions![name], a) && keyAt(prevActions!, index) === name)) same = false;
    index += 1;
  }
  const withCommands = commands !== undefined ? { commands } : {};
  if (same && ownKeyCount(prevActions!) === index) return { ok: true, frame: { stepIndex, moveX, jump: jump as JumpPhase, actions: prevActions!, ...withCommands } };
  const actions: Record<string, ActionValue> = {};
  for (const name in rawActions) {
    if (!hasOwn.call(rawActions, name)) continue;
    const a = rawActions[name] as Record<string, unknown>;
    const prev = prevActions?.[name];
    actions[name] =
      prev !== undefined && sameActionValue(prev, a)
        ? prev
        : Object.freeze({ v: a['v'] as number, ...(a['x'] !== undefined ? { x: a['x'] as number } : {}), ...(a['y'] !== undefined ? { y: a['y'] as number } : {}), p: a['p'] as JumpPhase });
  }
  return { ok: true, frame: { stepIndex, moveX, jump: jump as JumpPhase, actions: Object.freeze(actions), ...withCommands } };
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
 * The allowed jump-phase transitions of the source chain (input.md §3.2):
 * `none → pressed → held* → released → none`. A gap between recorded frames
 * inserts neutral frames, which is only valid from `none`/`released`.
 */
function transitionAllowed(from: JumpPhase, to: JumpPhase): boolean {
  switch (to) {
    case 'none':
      return from === 'none' || from === 'released';
    case 'pressed':
      return from === 'none';
    case 'held':
      return from === 'pressed' || from === 'held';
    case 'released':
      return from === 'pressed' || from === 'held';
  }
}

/**
 * Build the engine-level replay source (runtime.md §12.7/`input.md` §6).
 *
 * Construction is strict: every frame is validated, `stepIndex` must strictly
 * ascend, and the jump column must be a valid phase chain (including across
 * index gaps). A violation throws an `InputFrameError` (code
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
  let prevPhase: JumpPhase = 'none';
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
      if (frame.stepIndex > prevIndex + 1 && !(prevPhase === 'none' || prevPhase === 'released')) {
        throw new InputFrameError(
          'jump',
          `frame ${i}: a gap after a down phase ("${prevPhase}") is not a valid phase chain`,
        );
      }
    }
    const from = prevIndex !== null && frame.stepIndex > prevIndex + 1 ? 'none' : prevPhase;
    if (!transitionAllowed(from, frame.jump)) {
      throw new InputFrameError(
        'jump',
        `frame ${i}: jump "${frame.jump}" does not follow "${from}" in the phase chain`,
      );
    }
    prevPhase = frame.jump;
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
