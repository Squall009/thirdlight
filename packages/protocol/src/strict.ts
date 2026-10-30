/**
 * Strict JSON payload discipline: unknown fields rejected, mirroring the
 * command discipline, plus the project-model pass-1 byte rules applied to
 * request bodies.
 *
 * `parseStrictJsonBytes` enforces the pass-1 byte rules itself (BOM-free
 * UTF-8 → strict RFC 8259 syntax → no duplicate keys → no trailing
 * garbage) with the shared strict parser and maps failures to the
 * session-layer `invalid_request` shape. The shape helpers below
 * produce `field_missing` /
 * `field_unexpected` / `field_type` / `field_value` with `path`
 * (JSON Pointer), `found`, and `expected`.
 *
 * Pure: no I/O.
 */
import { hasUtf8Bom, parseStrictJsonText } from '@thirdlight/shared';
import { sessionError, type SessionError } from './errors';
export { isPlainObject } from '@thirdlight/shared';

export type StrictParseResult =
  | { ok: true; value: unknown }
  | { ok: false; error: SessionError };

/**
 * Strict pass-1 parse of HTTP/WS payload bytes: the bytes are parsed
 * strictly first, with the project-model pass-1 rules applied to the
 * request body.
 */
export function parseStrictJsonBytes(bytes: Uint8Array): StrictParseResult {
  // Exactly one UTF-8 BOM is an encoding_invalid (never silently stripped).
  if (hasUtf8Bom(bytes)) {
    return {
      ok: false,
      error: sessionError('invalid_request', 'validation', 'payload bytes start with a UTF-8 BOM; BOM-free UTF-8 is required'),
    };
  }
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    return {
      ok: false,
      error: sessionError('invalid_request', 'validation', 'payload bytes are not valid UTF-8'),
    };
  }
  let message: string;
  try {
    // Unescaped control characters in strings and lone surrogate escapes pass, as they always have on the wire;
    // a number that overflows to Infinity does not.
    const r = parseStrictJsonText(text, { finiteNumbers: true, rawControlChars: true });
    if (r.ok) return { ok: true, value: r.value };
    message = r.message.slice(0, 128);
  } catch {
    message = 'invalid JSON';
  }
  return {
    ok: false,
    error: sessionError('invalid_request', 'validation', `payload is not strict JSON: ${message}`.slice(0, 256)),
  };
}

/** Strict parse of an already-decoded string (WS text frames). */
export function parseStrictJson(text: string): StrictParseResult {
  const bytes = new TextEncoder().encode(text);
  return parseStrictJsonBytes(bytes);
}

export type FieldErrorResult =
  | { ok: true; value: Record<string, unknown> }
  | { ok: false; error: SessionError };

/**
 * Strict object shape check (unknown fields rejected):
 * unknown keys ⇒ `field_unexpected`, missing required keys ⇒
 * `field_missing`, wrong JSON types ⇒ `field_type`.
 *
 * @param value    the parsed JSON value
 * @param path     the JSON Pointer of this object (for error paths)
 * @param allowed  the exact allowed field set (field ⇒ type names for `expected`)
 * @param required the required subset
 */
export function checkShape(
  value: unknown,
  path: string,
  allowed: ReadonlyMap<string, string>,
  required: readonly string[],
): FieldErrorResult {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return {
      ok: false,
      error: sessionError(
        'field_type',
        'validation',
        'expected an object',
        { path, found: typeof value, expected: 'object' },
      ),
    };
  }
  const obj = value as Record<string, unknown>;
  for (const key of Object.keys(obj)) {
    if (!allowed.has(key)) {
      return {
        ok: false,
        error: sessionError(
          'field_unexpected',
          'validation',
          `unknown field "${key}"`,
          { path: `${path}/${key}`, found: key, expected: `known fields: ${[...allowed.keys()].join(', ')}` },
        ),
      };
    }
  }
  for (const key of required) {
    if (!(key in obj)) {
      return {
        ok: false,
        error: sessionError(
          'field_missing',
          'validation',
          `required field "${key}" is missing`,
          { path: `${path}/${key}`, expected: allowed.get(key) ?? 'value' },
        ),
      };
    }
  }
  return { ok: true, value: obj };
}

/** A strict field validator verdict. */
export type FieldVerdict = { problem: string; kind: 'type' | 'value' } | null;

/** Strict single-field check with a custom validator. */
export function checkField(
  obj: Record<string, unknown>,
  key: string,
  path: string,
  expected: string,
  validate: (v: unknown) => FieldVerdict,
): { ok: true; value: unknown } | { ok: false; error: SessionError } {
  const v = obj[key];
  const verdict = validate(v);
  if (verdict !== null) {
    return {
      ok: false,
      error: sessionError(
        verdict.kind === 'type' ? 'field_type' : 'field_value',
        'validation',
        verdict.problem,
        { path: `${path}/${key}`, found: typeof v, expected },
      ),
    };
  }
  return { ok: true, value: v };
}

/** Standard field helpers (used by the payload validators). */
export function isStringNoControl(v: unknown): v is string {
  return (
    typeof v === 'string' &&
    v.length >= 1 &&
    v.length <= 128 &&
    !/[\u0000-\u001f\u007f]/.test(v)
  );
}

/**
 * Strict shape for an optional object field: absent OR a plain object whose
 * keys are a subset of `allowed`. Returns the object (or `{}`).
 */
export function checkOptionalObject(
  obj: Record<string, unknown>,
  key: string,
  path: string,
  allowed: ReadonlyMap<string, string>,
  required: readonly string[],
): { ok: true; value: Record<string, unknown> } | { ok: false; error: SessionError } {
  const v = obj[key];
  if (v === undefined) return { ok: true, value: {} };
  return checkShape(v, `${path}/${key}`, allowed, required);
}