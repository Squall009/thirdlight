/**
 * Runtime error model and stable codes.
 *
 * Every public call returns a result object and never throws on protocol
 * misuse. Error entries in diagnostics are bounded
 * (last 32 kept; `errorCount` cumulative) and messages are ≤ 256 chars,
 * log-safe (no secrets/paths).
 */
import type { ModelErrorV2 } from '@thirdlight/project-model';
import { repeatedRowKey } from '@thirdlight/project-model';
import { MAX_ERROR_ENTRIES } from './error-ring';
import { hashSeed } from './random';
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
/** The fields of one play-log error row (absent optional fields are left out). */
export interface ErrorEntryFields {
  code: DiagnosticErrorEntry['code'];
  message: string;
  stepIndex: number;
  reason?: string | undefined;
  moduleId?: string | undefined;
  phase?: DiagnosticErrorEntry['phase'] | undefined;
  detail?: string | undefined;
  nodeId?: string | undefined;
  entityId?: string | undefined;
  /** Where in the compiled scripts it was thrown, innermost first (`at` is the first). */
  frames?: readonly { file: string; line: number; column: number }[] | undefined;
}

/** One play-log error row: every error the runtime lists (a failed run, a switched-off script) is made here. */
export function errorEntryOf(f: ErrorEntryFields): DiagnosticErrorEntry {
  const entry: DiagnosticErrorEntry = { code: f.code, message: clipMessage(f.message), stepIndex: f.stepIndex };
  if (f.reason !== undefined) entry.reason = f.reason;
  if (f.moduleId !== undefined) entry.moduleId = f.moduleId;
  if (f.entityId !== undefined) entry.entityId = f.entityId;
  if (f.phase !== undefined) entry.phase = f.phase;
  if (f.detail !== undefined) entry.detail = f.detail;
  if (f.nodeId !== undefined) entry.nodeId = f.nodeId;
  if (f.frames !== undefined && f.frames.length > 0) {
    entry.at = f.frames[0];
    entry.frames = [...f.frames];
  }
  return entry;
}

/**
 * A failure of the engine itself (a physics port that threw, a broken
 * result), as opposed to a script's own error. When one happens inside a
 * script's `ctx` call the run fails, as it does anywhere else in the step,
 * rather than the script being blamed for it and switched off while the
 * game goes on over a world that may be broken. Making one records it, so a
 * script that catches it cannot hide it: the hook runner takes it after the
 * hook returns.
 */
export class EngineFailure extends Error {
  constructor(message: string) {
    super(clipMessage(message));
    pendingEngineFailure = this;
  }
}
let pendingEngineFailure: EngineFailure | null = null;

/** The engine failure made since the last call, if any (cleared). */
export function takeEngineFailure(): EngineFailure | null {
  const f = pendingEngineFailure;
  pendingEngineFailure = null;
  return f;
}

/**
 * A script instance its own error switched off, as the runtime reports it:
 * one error-ring entry (with the object and the compiled frames the Play
 * backend maps to the source line) and a Problems line for each distinct
 * error. Errors are the same when their rows fold (code,
 * message, script, reason, position), so copies of one throw on many objects
 * are one line and two different errors of one script are two.
 */
export function scriptStopReport(moduleId: string, stop: ScriptStop, stepIndex: number): { entry: DiagnosticErrorEntry; code: string; message: string } {
  // The entry names its object in `entityId`, not in the text, so the same error on many copies folds into one
  // row (`repeated-rows`); the Problems line names the object it happened on first.
  const step = stop.stepIndex ?? stepIndex;
  const entry = errorEntryOf({ ...stop, message: `${stop.message}; script "${stop.behaviorId}" is switched off on its object for the rest of the run`, stepIndex: step, moduleId });
  const onObject = clipMessage(`${stop.message}; script "${stop.behaviorId}" is switched off on "${stop.entityId}" for the rest of the run`);
  const key = repeatedRowKey(entry) ?? entry.message;
  // A Problems kind is a lowercase code of at most 64 characters: the script id as far as it fits, made
  // unique by a hash of the exact id and the error (ids differing only in '-' / '_' or past the cut differ there).
  const [h1, h2] = hashSeed(`${stop.behaviorId}\u0000${key}`);
  const hash = `${(h1 >>> 0).toString(16).padStart(8, '0')}${(h2 >>> 0).toString(16).padStart(8, '0')}`;
  const code = `${SCRIPT_ERROR_PROBLEM}_${stop.behaviorId.replace(/[^a-z0-9_]/g, '_').slice(0, 64 - SCRIPT_ERROR_PROBLEM.length - 18)}_${hash}`;
  return { entry, code, message: `${onObject} (step ${step}, ${stop.hook})` };
}

/**
 * The script errors a run has put in Problems (and an export's console):
 * each distinct error once, as many as the play log holds rows, then one
 * line saying the rest are in the play log only. A run restart starts over,
 * so an error that comes back after a restart is reported again.
 */
export class ScriptErrorLines {
  private readonly seen = new Set<string>();
  private full = false;

  /** The Problems line of a reported script error, or null when it was already reported (or past the bound). */
  take(r: { code: string; message: string }): { code: string; message: string } | null {
    if (this.seen.has(r.code)) return null;
    if (this.seen.size >= MAX_ERROR_ENTRIES) {
      if (this.full) return null;
      this.full = true;
      return { code: `${SCRIPT_ERROR_PROBLEM}_more`, message: `more than ${MAX_ERROR_ENTRIES} different script errors in this run: the rest are in the play log only` };
    }
    this.seen.add(r.code);
    return { code: r.code, message: clipMessage(r.message) };
  }

  clear(): void {
    this.seen.clear();
    this.full = false;
  }
}

/** The Problems kind prefix of a script error (an export prints these as errors, the other kinds as warnings). */
export const SCRIPT_ERROR_PROBLEM = 'script_error';
