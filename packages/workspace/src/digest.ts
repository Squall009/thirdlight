/**
 * Request canonicalization and digest.
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
 * transport's job; the service enforces value-level strictness).
 * Values that are not JSON values (undefined/function/symbol, non-finite
 * numbers) cannot be part of a legitimate request: canonicalization fails
 * and the digest is reported as `null` (fail-closed: a null digest can
 * never equal a recorded one, so a collision on a recorded requestId
 * yields `request_id_reused`, never a replay).
 */

import { createHash, randomBytes } from 'node:crypto';
import { canonicalJsonUtf16 } from '@thirdlight/shared';

/**
 * SHA-256 (lowercase hex) of the canonical request bytes. Returns `null` when the value is not a JSON value (fail-closed).
 */
export function requestDigest(value: unknown): string | null {
  try {
    const text = canonicalJsonUtf16(value);
    return createHash('sha256').update(new TextEncoder().encode(text)).digest('hex');
  } catch {
    return null;
  }
}

/**
 * SHA-256 (lowercase hex) of raw bytes through node:crypto. The backend
 * hashes whole asset files (tens of megabytes), where the native hash is
 * about ten times faster than the shared pure one; both give the same digest.
 */
export function sha256HexNative(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/**
 * `tb-` + 32 lowercase hex chars from 16 CSPRNG bytes (128 random bits,
 * generated once per backend process).
 */
export function generateBackendId(): string {
  const b = randomBytes(16);
  let s = '';
  for (let i = 0; i < b.length; i++) s += (b[i] as number).toString(16).padStart(2, '0');
  return `tb-${s}`;
}