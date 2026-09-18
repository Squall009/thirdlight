/**
 * Three-adapter error model (packet 08; the dependencies.md §3 surface
 * row lists `ERROR_CODES` for the adapter — the code set below is the
 * adapter's stable set, recorded in docs/handoffs/08.md).
 *
 * Every public call returns a result object and never throws.
 */

export const ERROR_CODES = [
  /** The canvas argument is missing or does not expose `getContext`. */
  'canvas_invalid',
  /** No WebGL context could be created (non-browser environment, or
   *  WebGL unsupported by the browser). */
  'render_unsupported',
  /** A render/capture step failed after context creation (e.g. the
   *  runtime state is unavailable). */
  'render_failed',
  /** PNG capture failed (e.g. `toDataURL` unavailable). */
  'screenshot_failed',
  /** A method was called after `dispose()`. */
  'adapter_disposed',
] as const;

export type AdapterErrorCode = (typeof ERROR_CODES)[number];

/** One structured adapter error object. */
export interface AdapterError {
  code: AdapterErrorCode;
  /** ≤ 256 chars, log-safe. */
  message: string;
}

function clip(message: string): string {
  return message.length > 256 ? `${message.slice(0, 255)}…` : message;
}

export function adapterError(code: AdapterErrorCode, message: string): AdapterError {
  return { code, message: clip(message) };
}