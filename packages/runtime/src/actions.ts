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
}

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
): { ok: true; frame: ActionFrame } | { ok: false; field: string; message: string } {
  if (!isPlainObject(value)) {
    return { ok: false, field: '', message: 'action frame must be an object' };
  }
  for (const key of Object.keys(value)) {
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
  return { ok: true, frame: { stepIndex, moveX, jump: jump as JumpPhase } };
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
