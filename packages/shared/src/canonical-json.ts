/**
 * Canonical JSON text. Digests are taken over these strings (content and
 * recipe digests, manifest digests, request digests), so each variant below
 * must keep its exact output: the variants already differed when they were
 * gathered here, and stored digests depend on each, so they stay apart
 * rather than being merged.
 *
 * - {@link canonicalJsonText}: compact, keys sorted by code point at every
 *   level, members set to `undefined` left out, `-0` written as `0`, numbers
 *   with `JSON.stringify` semantics. Content and recipe digests.
 * - {@link canonicalJsonKey}: that text as a comparison key, `undefined`
 *   kept apart from `null` (prefab overrides).
 * - {@link canonicalJsonTextStrict}: the same text, but a non-finite number
 *   or a value JSON cannot hold throws instead of becoming `null`
 *   (behaviour build manifests, where such a value is a defect).
 * - {@link canonicalJsonUtf16}: compact, keys in UTF-16 unit order (the
 *   default sort; the same as code point order while keys are in the BMP),
 *   and any non-JSON value, an `undefined` member included, throws (request
 *   digests).
 * - {@link canonicalJsonValue}: not text but a copy of the value with its
 *   keys sorted (UTF-16 order), for stored documents whose field order must
 *   not depend on how they were built.
 * - {@link indentedJsonText}: two-space indented, keys as inserted (export
 *   documents, whose callers build them in the normative field order).
 */

/** Code point order of two strings (not UTF-16 unit order). */
export function compareCodePoints(a: string, b: string): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const ca = a.codePointAt(i) as number;
    const cb = b.codePointAt(i) as number;
    if (ca !== cb) return ca < cb ? -1 : 1;
  }
  return a.length === b.length ? 0 : a.length < b.length ? -1 : 1;
}

function sortedText(value: unknown, strict: boolean): string {
  if (value === null) return 'null';
  const t = typeof value;
  if (t === 'number') {
    const n = value as number;
    if (strict && !Number.isFinite(n)) throw new Error('canonicalJsonText: non-finite number');
    return JSON.stringify(n === 0 ? 0 : n);
  }
  if (t === 'boolean') return value === true ? 'true' : 'false';
  if (t === 'string') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((v) => sortedText(v, strict)).join(',')}]`;
  if (t === 'object') {
    const obj = value as Record<string, unknown>;
    const parts: string[] = [];
    for (const k of Object.keys(obj).sort(compareCodePoints)) {
      const v = obj[k];
      if (v === undefined) continue;
      parts.push(`${JSON.stringify(k)}:${sortedText(v, strict)}`);
    }
    return `{${parts.join(',')}}`;
  }
  if (strict) throw new Error(`canonicalJsonText: unsupported value type ${t}`);
  return 'null';
}

/** Canonical JSON text, keys by code point; a value JSON cannot hold becomes `null`. */
export function canonicalJsonText(value: unknown): string {
  return sortedText(value, false);
}

/** {@link canonicalJsonText}, but a non-finite number or a non-JSON value throws. */
export function canonicalJsonTextStrict(value: unknown): string {
  return sortedText(value, true);
}

/** Canonical JSON text, keys in UTF-16 unit order; any non-JSON value throws. */
export function canonicalJsonUtf16(value: unknown): string {
  if (value === null) return 'null';
  const t = typeof value;
  if (t === 'string') return JSON.stringify(value);
  if (t === 'number') {
    if (!Number.isFinite(value)) throw new Error('non-finite number in request');
    return JSON.stringify(value);
  }
  if (t === 'boolean') return value ? 'true' : 'false';
  if (Array.isArray(value)) return `[${value.map((x) => canonicalJsonUtf16(x)).join(',')}]`;
  if (t === 'object') {
    const obj = value as Record<string, unknown>;
    const parts = Object.keys(obj)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonicalJsonUtf16(obj[k])}`);
    return `{${parts.join(',')}}`;
  }
  throw new Error(`non-JSON value in request: ${t}`);
}

/** A copy of `v` with object keys sorted (UTF-16 order), `undefined` members dropped and `-0` as `0`. */
export function canonicalJsonValue(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(canonicalJsonValue);
  if (typeof v === 'object' && v !== null) {
    const obj = v as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(obj).sort()) if (obj[k] !== undefined) out[k] = canonicalJsonValue(obj[k]);
    return out;
  }
  return Object.is(v, -0) ? 0 : v;
}

/**
 * Two-space indented JSON text at nesting depth `indent`, keys in insertion
 * order, no trailing newline. Throws on a value JSON cannot hold.
 */
export function indentedJsonText(value: unknown, indent = 0): string {
  const pad = '  '.repeat(indent);
  const inner = '  '.repeat(indent + 1);
  if (value === null) return 'null';
  switch (typeof value) {
    case 'string':
      return JSON.stringify(value);
    case 'number':
      if (!Number.isFinite(value)) throw new Error('canonicalJson: non-finite number');
      return JSON.stringify(value);
    case 'boolean':
      return value ? 'true' : 'false';
    case 'bigint':
      throw new Error('canonicalJson: bigint is not JSON');
    case 'undefined':
      throw new Error('canonicalJson: undefined is not JSON');
    default:
      break;
  }
  if (Array.isArray(value)) {
    if (value.length === 0) return '[]';
    const items = value.map((v) => inner + indentedJsonText(v, indent + 1));
    return '[\n' + items.join(',\n') + '\n' + pad + ']';
  }
  if (typeof value === 'object') {
    const keys = Object.keys(value);
    if (keys.length === 0) return '{}';
    const items = keys.map((k) => inner + JSON.stringify(k) + ': ' + indentedJsonText((value as Record<string, unknown>)[k], indent + 1));
    return '{\n' + items.join(',\n') + '\n' + pad + '}';
  }
  throw new Error('canonicalJson: unsupported value type ' + typeof value);
}

/**
 * {@link canonicalJsonText} as a comparison key that keeps an absent value
 * (`undefined`) apart from one set to `null`: two values are the same when
 * their keys are equal.
 */
export function canonicalJsonKey(v: unknown): string {
  return v === undefined ? 'undefined' : canonicalJsonText(v);
}
