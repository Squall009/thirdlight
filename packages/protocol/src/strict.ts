/**
 * Strict JSON payload discipline — sessions.md §1/§11.2 (unknown fields
 * rejected, mirroring the commands.md discipline) + the project-model
 * §12.3 pass-1 byte rules applied to request bodies (sessions.md §6.1).
 *
 * `parseStrictJsonBytes` enforces the pass-1 byte rules itself (BOM-free
 * UTF-8 → strict RFC 8259 syntax → no duplicate keys → no trailing
 * garbage) and maps failures to the session-layer `invalid_request`
 * shape. The parser is self-contained: `protocol` is pure, I/O-free, and
 * its edges to `project-model`/`commands` are types-only
 * (dependencies.md §4.1), so it must not call project-model's byte
 * parser at runtime. The shape helpers below produce `field_missing` /
 * `field_unexpected` / `field_type` / `field_value` with `path`
 * (JSON Pointer), `found`, and `expected`.
 *
 * Pure: no I/O.
 */
import { sessionError, type SessionError } from './errors';

export type StrictParseResult =
  | { ok: true; value: unknown }
  | { ok: false; error: SessionError };

/**
 * Strict pass-1 parse of HTTP/WS payload bytes (sessions.md §6.1:
 * "strict parsing of the bytes first — project-model §12.3 pass 1 rules
 * apply to the request body").
 */
export function parseStrictJsonBytes(bytes: Uint8Array): StrictParseResult {
  // Exactly one UTF-8 BOM is an encoding_invalid (never silently stripped).
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
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
  const r = strictJsonParse(text);
  if (r.ok) return { ok: true, value: r.value };
  return {
    ok: false,
    error: sessionError('invalid_request', 'validation', `payload is not strict JSON: ${r.message}`.slice(0, 256)),
  };
}

/**
 * A strict RFC 8259 JSON parser (no NaN/Infinity/undefined tokens, no
 * trailing garbage, no trailing commas, no duplicate object keys, no
 * leading zeros in numbers). Returns the parsed value or a one-line
 * problem description. Pure.
 */
function strictJsonParse(
  text: string,
): { ok: true; value: unknown } | { ok: false; message: string } {
  let i = 0;
  const n = text.length;
  const fail = (message: string): never => {
    throw { __strictJson: true, message };
  };

  const skipWs = (): void => {
    while (i < n) {
      const c = text[i]!;
      if (c === ' ' || c === '\t' || c === '\n' || c === '\r') i += 1;
      else break;
    }
  };

  const expectLit = (lit: string): void => {
    if (text.slice(i, i + lit.length) !== lit) fail(`invalid literal (expected "${lit}")`);
    i += lit.length;
  };

  const parseString = (): string => {
    i += 1; // consume the opening quote
    let out = '';
    for (;;) {
      if (i >= n) fail('unterminated string');
      const c = text[i]!;
      if (c === '"') {
        i += 1;
        return out;
      }
      if (c === '\\') {
        i += 1;
        if (i >= n) fail('unterminated escape sequence');
        const e = text[i]!;
        if (e === '"') {
          out += '"';
          i += 1;
        } else if (e === '\\') {
          out += '\\';
          i += 1;
        } else if (e === '/') {
          out += '/';
          i += 1;
        } else if (e === 'b') {
          out += '\b';
          i += 1;
        } else if (e === 'f') {
          out += '\f';
          i += 1;
        } else if (e === 'n') {
          out += '\n';
          i += 1;
        } else if (e === 'r') {
          out += '\r';
          i += 1;
        } else if (e === 't') {
          out += '\t';
          i += 1;
        } else if (e === 'u') {
          if (i + 5 > n) fail('truncated \\u escape');
          const hex = text.slice(i + 1, i + 5);
          if (!/^[0-9a-fA-F]{4}$/.test(hex)) fail('invalid \\u escape');
          out += String.fromCharCode(parseInt(hex, 16));
          i += 5;
        } else {
          fail(`invalid escape character "\\${e}"`);
        }
      } else {
        out += c;
        i += 1;
      }
    }
  };

  const parseNumber = (): number => {
    const start = i;
    if (i < n && text[i] === '-') i += 1;
    if (i >= n) fail('invalid number');
    if (text[i] === '0') {
      i += 1;
    } else if (text[i]! >= '1' && text[i]! <= '9') {
      while (i < n && text[i]! >= '0' && text[i]! <= '9') i += 1;
    } else {
      fail('invalid number');
    }
    if (i < n && text[i] === '.') {
      i += 1;
      if (i >= n || text[i]! < '0' || text[i]! > '9') fail('invalid number fraction');
      while (i < n && text[i]! >= '0' && text[i]! <= '9') i += 1;
    }
    if (i < n && (text[i] === 'e' || text[i] === 'E')) {
      i += 1;
      if (i < n && (text[i] === '+' || text[i] === '-')) i += 1;
      if (i >= n || text[i]! < '0' || text[i]! > '9') fail('invalid number exponent');
      while (i < n && text[i]! >= '0' && text[i]! <= '9') i += 1;
    }
    const v = Number(text.slice(start, i));
    if (!Number.isFinite(v)) fail('number out of the finite range');
    return v;
  };

  const parseValue = (): unknown => {
    skipWs();
    if (i >= n) fail('unexpected end of input');
    const c = text[i]!;
    if (c === '{') return parseObject();
    if (c === '[') return parseArray();
    if (c === '"') return parseString();
    if (c === 't') {
      expectLit('true');
      return true;
    }
    if (c === 'f') {
      expectLit('false');
      return false;
    }
    if (c === 'n') {
      expectLit('null');
      return null;
    }
    if (c === '-' || (c >= '0' && c <= '9')) return parseNumber();
    fail(`unexpected character "${c}"`);
  };

  const parseObject = (): Record<string, unknown> => {
    i += 1; // consume {
    const obj: Record<string, unknown> = {};
    const keys = new Set<string>();
    skipWs();
    if (i < n && text[i] === '}') {
      i += 1;
      return obj;
    }
    for (;;) {
      skipWs();
      if (i >= n || text[i] !== '"') fail('expected a string object key');
      const key = parseString();
      if (keys.has(key)) fail(`duplicate key "${key.slice(0, 32)}"`);
      keys.add(key);
      skipWs();
      if (i >= n || text[i] !== ':') fail('expected ":" after an object key');
      i += 1;
      obj[key] = parseValue();
      skipWs();
      if (i >= n) fail('unterminated object');
      const c = text[i]!;
      if (c === ',') {
        i += 1;
        continue;
      }
      if (c === '}') {
        i += 1;
        return obj;
      }
      fail('expected "," or "}" in an object');
    }
  };

  const parseArray = (): unknown[] => {
    i += 1; // consume [
    const arr: unknown[] = [];
    skipWs();
    if (i < n && text[i] === ']') {
      i += 1;
      return arr;
    }
    for (;;) {
      arr.push(parseValue());
      skipWs();
      if (i >= n) fail('unterminated array');
      const c = text[i]!;
      if (c === ',') {
        i += 1;
        skipWs();
        if (i < n && text[i] === ']') fail('trailing comma in an array');
        continue;
      }
      if (c === ']') {
        i += 1;
        return arr;
      }
      fail('expected "," or "]" in an array');
    }
  };

  try {
    const value = parseValue();
    skipWs();
    if (i !== n) fail('trailing data after the JSON value');
    return { ok: true, value };
  } catch (e) {
    const message =
      e !== null && typeof e === 'object' && '__strictJson' in e
        ? (((e as Record<string, unknown>).message as string | undefined) ?? 'invalid JSON').slice(0, 128)
        : 'invalid JSON';
    return { ok: false, message };
  }
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
 * Strict object shape check (sessions.md §1: unknown fields rejected):
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

export function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
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