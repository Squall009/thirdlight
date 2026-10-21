/**
 * Runtime error model and stable codes.
 *
 * Every public call returns a result object and never throws on protocol
 * misuse. Error entries in diagnostics are bounded
 * (last 32 kept; `errorCount` cumulative) and messages are ≤ 256 chars,
 * log-safe (no secrets/paths).
 */
import type { ModelErrorV2 } from '@thirdlight/project-model';
import type { DiagnosticErrorEntry, ScriptStop } from './types';

/** The stable runtime error code set (normative). */
export const ERROR_CODES = [
  'config_invalid',
  'snapshot_invalid',
  'runtime_already_started',
  'runtime_not_running',
  'runtime_disposed',
  'runtime_failed',
  'tick_not_allowed',
  'module_error',
  'module_combination_unsupported',
  'transform_owner_conflict',
  'transform_owner_forbidden',
  'physics_port_error',
  // Codes are additive: none changes meaning or shape.
  // "game" here is the running game.
  'game_command_invalid',
  'camera_viewport_invalid',
  // Scene set: a bad load/unload request, and a scene that could
  // not be loaded (a diagnostic entry; the run continues without it).
  'scene_invalid',
  'scene_load_failed',
  // A spawn an engine limit refused, or one that could not be added
  // (a diagnostic entry; the script got null and the run continues).
  'spawn_refused',
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

/** One structured error object carried by `{ ok: false, error }` results. */
export interface RuntimeError {
  code: ErrorCode;
  /** ≤ 256 chars, log-safe, no secrets/paths. */
  message: string;
  /**
   * `snapshot_invalid` only:
   * `id_mismatch` | `revision_mismatch` | `shape` | `scene_validation`.
   * `config_invalid` carries a short reason string as well.
   */
  reason?: string;
  /** JSON Pointer to the offending field (shape/config errors). */
  path?: string;
  /**
   * `snapshot_invalid` with `reason: "scene_validation"` only: the
   * project-model validation errors, at most 10 (`errorTotal` gives the
   * total count).
   */
  errors?: readonly ModelErrorV2[];
  /** `snapshot_invalid` (`scene_validation`): total project-model error count. */
  errorTotal?: number;
  /** `module_error` only: the stepIndex of the failed step attempt. */
  stepIndex?: number;
  /** M2 fail-stop/ownership errors: the module ID involved. */
  moduleId?: string;
  /** M2 fail-stop errors: the phase in which the failure occurred. */
  phase?: string;
  /** A short contract `detail` string (M2 error table). */
  detail?: string;
  /** `game_command_invalid` only: the rejected command. */
  command?: string;
  /** `game_command_invalid` only: the run state that rejected it. */
  state?: string;
  /** `camera_viewport_invalid` only: the rejected size. */
  width?: number;
  height?: number;
}

/** Success result carrying an extra payload. */
export type Ok<T extends object> = { ok: true } & T;
/** Failure result. */
export interface Err {
  ok: false;
  error: RuntimeError;
}

export const MESSAGE_LIMIT = 256;

/** Messages are clipped to 256 chars, log-safe. */
export function clipMessage(message: string): string {
  if (message.length <= MESSAGE_LIMIT) return message;
  return `${message.slice(0, MESSAGE_LIMIT - 1)}…`;
}
/**
 * A script instance its own error switched off, as the runtime reports it:
 * one error-ring entry (with the object and the compiled frames the Play
 * backend maps to the source line) and one Problems line per script.
 */
export function scriptStopReport(moduleId: string, stop: ScriptStop, stepIndex: number): { entry: DiagnosticErrorEntry; code: string; message: string } {
  // The entry names its object in `entityId`, not in the text, so the same error on many copies folds into one
  // row (`repeated-rows`); the Problems line, one per script, names the object it happened on first.
  const message = clipMessage(`${stop.message}; script "${stop.behaviorId}" is switched off on its object for the rest of the run`);
  const onObject = clipMessage(`${stop.message}; script "${stop.behaviorId}" is switched off on "${stop.entityId}" for the rest of the run`);
  const step = stop.stepIndex ?? stepIndex;
  const entry: DiagnosticErrorEntry = { code: stop.code, reason: stop.reason, message, stepIndex: step, moduleId, entityId: stop.entityId };
  if (stop.phase !== undefined) entry.phase = stop.phase;
  if (stop.detail !== undefined) entry.detail = stop.detail;
  if (stop.nodeId !== undefined) entry.nodeId = stop.nodeId;
  if (stop.frames !== undefined && stop.frames.length > 0) {
    entry.at = stop.frames[0];
    entry.frames = stop.frames;
  }
  // A Problems kind is a lowercase code of at most 64 characters.
  const code = `script_error_${stop.behaviorId.replace(/[^a-z0-9_]/g, '_')}`.slice(0, 64);
  return { entry, code, message: `${onObject} (step ${step}, ${stop.hook})` };
}
