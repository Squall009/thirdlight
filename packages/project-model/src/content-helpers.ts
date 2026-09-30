/**
 * Small helpers the content catalog's validators share: bounded limit and
 * digest errors, canonical byte counts, sorted keys and records, the digest
 * and version patterns.
 */

import { utf8Encode } from './sha256';
import { withFound } from './validate';
import type { ModelErrorV2 } from './errors';
import { MAX_SOURCE_PATH_LENGTH } from './content-limits';

export const DIGEST_RE = /^[0-9a-f]{64}$/;
export const SEMVER_RE = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/;

// ---- small helpers ------------------------------------------------------------

export function limitsError(
  path: string,
  limit: NonNullable<ModelErrorV2['limit']>,
  current: number,
  max: number,
  message: string,
): ModelErrorV2 {
  return withFound(
    { code: 'limits_exceeded', path, message, limit, current, max, expected: `<= ${max}` },
    current,
  );
}

export function digestError(path: string, found: unknown): ModelErrorV2 {
  return withFound(
    {
      code: 'digest_invalid',
      path,
      message: 'digest must be exactly 64 lowercase hexadecimal characters',
      expected: '^[0-9a-f]{64}$',
    },
    found,
  );
}

/**
 * A referenced asset version's `sourcePath`: relative to the game folder,
 * forward slashes only, 1–512 characters, no empty, `.` or `..` segment, no
 * leading `/`, no drive letter, no backslash and no control characters. It
 * is a name inside the game folder, never a host path.
 */
export function isValidSourcePath(s: unknown): s is string {
  if (typeof s !== 'string' || s.length < 1 || s.length > MAX_SOURCE_PATH_LENGTH) return false;
  for (let k = 0; k < s.length; k++) {
    const c = s.charCodeAt(k);
    if (c <= 0x1f || c === 0x7f || c === 0x5c /* backslash */ || c === 0x3a /* colon */) return false;
  }
  return s.split('/').every((seg) => seg !== '' && seg !== '.' && seg !== '..');
}

function canonicalBytes(text: string): number {
  return utf8Encode(text).length;
}

/** Canonical document bytes of any validated value. */
export function canonicalDocBytes(value: unknown): number {
  return canonicalBytes(JSON.stringify(value, null, 2) + '\n');
}

/** Codepoint-order-ish key sort (ASCII keys in practice; UTF-16 is enough here). */
export function sortedKeys(obj: Record<string, unknown>): string[] {
  return Object.keys(obj).sort();
}

// ---- canonicalization ---------------------------------------------------------

export function sortedRecord<T>(items: T[], keyOf: (item: T) => string): T[] {
  return [...items].sort((a, b) => (keyOf(a) < keyOf(b) ? -1 : keyOf(a) > keyOf(b) ? 1 : 0));
}
// ---- values derived from immutable lists ---------------------------------------

const derived = new WeakMap<object, Map<string, unknown>>();

/**
 * A value derived from a list (an id → kind map, a set of ids), made once per
 * list object. Documents are immutable values, so a list that is the same
 * object holds the same records, and a command that leaves a list alone keeps
 * the derived value for the next one.
 */
export function derivedOf<T>(list: object, key: string, make: () => T): T {
  let byKey = derived.get(list);
  if (byKey === undefined) {
    byKey = new Map();
    derived.set(list, byKey);
  }
  if (byKey.has(key)) return byKey.get(key) as T;
  const value = make();
  byKey.set(key, value);
  return value;
}
