/**
 * Request canonicalization and digest — commands.md §6.6.
 *
 * Semantic equality of requests is digest equality:
 *   1. canonical serialization — object keys sorted in codepoint order at
 *      every level, no insignificant whitespace, strings JSON-escaped in
 *      the shortest form, numbers with JavaScript JSON.stringify double
 *      semantics (so `1` and `1.0` digest the same);
 *   2. UTF-8 encode; digest = SHA-256 lowercase hex.
 *
 * The service receives already-parsed request values (transport byte-
 * strictness — pass-1 encoding/syntax/duplicate-key rules — is the
 * packet-09 transport's job; the service enforces value-level strictness).
 * Values that are not JSON values (undefined/function/symbol, non-finite
 * numbers) cannot be part of a legitimate request: canonicalization fails
 * and the digest is reported as `null` (fail-closed: a null digest can
 * never equal a recorded one, so a collision on a recorded requestId
 * yields `request_id_reused`, never a replay).
 */

import { createHash, randomBytes } from 'node:crypto';

/** Canonical JSON text per commands.md §6.6 (throws on non-JSON values). */
export function canonicalize(value: unknown): string {
  if (value === null) return 'null';
  const t = typeof value;
  if (t === 'string') return JSON.stringify(value);
  if (t === 'number') {
    // JSON.stringify double semantics; non-finite values are not JSON
    // values — fail closed.
    if (!Number.isFinite(value)) throw new Error('non-finite number in request');
    return JSON.stringify(value);
  }
  if (t === 'boolean') return value ? 'true' : 'false';
  if (Array.isArray(value)) {
    return `[${value.map((x) => canonicalize(x)).join(',')}]`;
  }
  if (t === 'object') {
    // Default Array.prototype.sort compares UTF-16 code units = codepoint
    // order for the BMP keys all M1 JSON documents use.
    const obj = value as Record<string, unknown>;
    const parts = Object.keys(obj)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonicalize(obj[k])}`);
    return `{${parts.join(',')}}`;
  }
  throw new Error(`non-JSON value in request: ${t}`);
}

/**
 * SHA-256 (lowercase hex) of the canonical request bytes (commands.md
 * §6.6). Returns `null` when the value is not a JSON value (fail-closed).
 */
export function requestDigest(value: unknown): string | null {
  try {
    const text = canonicalize(value);
    return createHash('sha256').update(new TextEncoder().encode(text)).digest('hex');
  } catch {
    return null;
  }
}

/** SHA-256 (lowercase hex) of raw bytes. */
export function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/**
 * `tb-` + 32 lowercase hex chars from 16 CSPRNG bytes (workspace.md §6.1:
 * 128 random bits, generated once per backend process).
 */
export function generateBackendId(): string {
  const b = randomBytes(16);
  let s = '';
  for (let i = 0; i < b.length; i++) s += (b[i] as number).toString(16).padStart(2, '0');
  return `tb-${s}`;
}