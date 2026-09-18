/**
 * Runtime error model and stable codes — runtime.md §8 (normative).
 *
 * Every public call returns a result object and never throws on protocol
 * misuse (runtime.md §3). Error entries in diagnostics are bounded
 * (last 32 kept; `errorCount` cumulative) and messages are ≤ 256 chars,
 * log-safe (no secrets/paths).
 */
import type { ModelError } from '@thirdlight/project-model';

/** The stable M1 runtime error code set (runtime.md §8, normative). */
export const ERROR_CODES = [
  'config_invalid',
  'snapshot_invalid',
  'runtime_already_started',
  'runtime_not_running',
  'runtime_disposed',
  'tick_not_allowed',
  'module_error',
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

/** One structured error object carried by `{ ok: false, error }` results. */
export interface RuntimeError {
  code: ErrorCode;
  /** ≤ 256 chars, log-safe, no secrets/paths. */
  message: string;
  /**
   * `snapshot_invalid` only (runtime.md §2):
   * `id_mismatch` | `revision_mismatch` | `shape` | `scene_validation`.
   * `config_invalid` carries a short reason string as well.
   */
  reason?: string;
  /** JSON Pointer to the offending field (shape/config errors). */
  path?: string;
  /**
   * `snapshot_invalid` with `reason: "scene_validation"` only: the
   * project-model validation errors, at most 10 (runtime.md §2: "≤ 10
   * reported, total count given").
   */
  errors?: readonly ModelError[];
  /** `snapshot_invalid` (`scene_validation`): total project-model error count. */
  errorTotal?: number;
  /** `module_error` only: the stepIndex of the failed step attempt. */
  stepIndex?: number;
}

/** Success result carrying an extra payload. */
export type Ok<T extends object> = { ok: true } & T;
/** Failure result. */
export interface Err {
  ok: false;
  error: RuntimeError;
}

export const MESSAGE_LIMIT = 256;

/** Messages are clipped to 256 chars (runtime.md §8), log-safe. */
export function clipMessage(message: string): string {
  if (message.length <= MESSAGE_LIMIT) return message;
  return `${message.slice(0, MESSAGE_LIMIT - 1)}…`;
}