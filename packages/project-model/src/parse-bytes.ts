/**
 * Strict byte parsing — pass 1, normative order:
 *
 *   1. UTF-8 decode WITHOUT replacement of malformed bytes; invalid UTF-8 or
 *      a leading UTF-8 BOM ⇒ exactly one `encoding_invalid` at `""`.
 *   2. Complete strict JSON syntax (RFC 8259): no `NaN`/`Infinity`/
 *      `undefined` tokens, no trailing garbage, no lone surrogates in
 *      non-escape text, exactly the four JSON whitespace characters.
 *      Failure ⇒ exactly one `json_parse_error` at `""`.
 *   3. Repeated object member names — compared AFTER JSON escape decoding,
 *      separately within each object ⇒ one `duplicate_key` for the first
 *      repeated name in source order, at its decoded, JSON-Pointer-escaped
 *      path. Equal names in different objects are allowed.
 *
 * `JSON.parse` alone cannot perform this check (it silently keeps the last
 * value for duplicate keys and accepts numeric overflow), so a strict
 * recursive-descent parser is used. Numeric tokens are decoded with
 * JavaScript `JSON.parse` semantics (`1e400` → `Infinity`); finiteness is
 * the value validator's job, not a syntax error.
 *
 * The input bytes are never mutated or consumed.
 */

import { hasUtf8Bom, parseStrictJsonText } from '@thirdlight/shared';
import type { ModelError } from './errors';

const BOM = [0xef, 0xbb, 0xbf] as const;

/** First byte that is not valid UTF-8 (offset semantics per RFC 3629), or null. */
function firstInvalidUtf8Byte(bytes: Uint8Array): number | null {
  const n = bytes.length;
  let i = 0;
  while (i < n) {
    const b0 = bytes[i] as number;
    let len: number;
    let lo: number;
    let hi: number;
    if (b0 < 0x80) {
      i += 1;
      continue;
    }
    if ((b0 & 0xe0) === 0xc0) {
      if (b0 < 0xc2) return b0; // 0xC0/0xC1: overlong 2-byte form
      len = 2;
      lo = 0x80;
      hi = 0xbf;
    } else if ((b0 & 0xf0) === 0xe0) {
      len = 3;
      if (b0 === 0xe0) {
        lo = 0xa0; // reject overlong 3-byte forms
        hi = 0xbf;
      } else if (b0 === 0xed) {
        lo = 0x80; // reject UTF-16 surrogates (ED A0–BF)
        hi = 0x9f;
      } else {
        lo = 0x80;
        hi = 0xbf;
      }
    } else if ((b0 & 0xf8) === 0xf0) {
      len = 4;
      if (b0 === 0xf0) {
        lo = 0x90; // reject overlong 4-byte forms
        hi = 0xbf;
      } else if (b0 === 0xf4) {
        lo = 0x80; // reject > U+10FFFF
        hi = 0x8f;
      } else {
        return b0; // 0xF5..0xF7
      }
    } else {
      return b0; // stray continuation byte 0x80..0xBF, or 0xF8..0xFF
    }
    for (let k = 1; k < len; k++) {
      const b = bytes[i + k];
      if (b === undefined) return b0; // truncated sequence
      // Only the FIRST continuation byte of E0/ED/F0/F4 carries a
      // restricted low bound; the rest are 0x80..0xBF.
      if (b < (k === 1 ? lo : 0x80) || b > (k === 1 ? hi : 0xbf)) return b;
    }
    i += len;
  }
  return null;
}

/**
 * Result of pass 1: the decoded value, or the single pass-1 error
 * (`encoding_invalid` / `json_parse_error` / `duplicate_key`).
 */
export type ByteParse =
  | { ok: true; value: unknown }
  | { ok: false; error: ModelError };

/**
 * Run pass 1 (strict byte parsing) over raw document bytes (manifest or scene interchange
 * bytes). Pure: never mutates `bytes`, never throws. Parse failures stop
 * all deeper checks, even for unknown schema versions.
 */
export function parseDocumentBytes(bytes: Uint8Array): ByteParse {
  // Leading UTF-8 BOM: exactly one encoding_invalid (never silently stripped).
  if (hasUtf8Bom(bytes)) {
    return {
      ok: false,
      error: {
        code: 'encoding_invalid',
        path: '',
        message: 'document bytes start with a UTF-8 BOM; BOM-free UTF-8 is required',
        found: [BOM[0], BOM[1], BOM[2]],
        expected: 'BOM-free UTF-8 bytes',
      },
    };
  }
  const badByte = firstInvalidUtf8Byte(bytes);
  if (badByte !== null) {
    return {
      ok: false,
      error: {
        code: 'encoding_invalid',
        path: '',
        message: 'document bytes are not valid UTF-8',
        found: badByte,
        expected: 'valid UTF-8 bytes (no replacement of malformed sequences)',
      },
    };
  }
  // Safe here: firstInvalidUtf8Byte accepted the full sequence, so the
  // fatal decode cannot throw.
  const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);

  // Syntax precedes duplicates: a syntax error is reported even when a
  // duplicate key also exists in the same text (byte-input case B4).
  const parsed = parseStrictJsonText(text, { duplicates: 'after-syntax' });
  if (parsed.ok) return { ok: true, value: parsed.value };
  if (parsed.kind === 'syntax') {
    return {
      ok: false,
      error: {
        code: 'json_parse_error',
        path: '',
        message:
          'document is not strict JSON (RFC 8259: no NaN/Infinity/undefined tokens, ' +
          'no trailing garbage, no trailing commas)',
        found: text.slice(parsed.pos, parsed.pos + 32),
        expected: 'strict JSON text',
      },
    };
  }
  return {
    ok: false,
    error: {
      code: 'duplicate_key',
      path: parsed.pointer,
      message:
        'duplicate object member name in the JSON text (names are compared ' +
        'after escape decoding; earlier occurrences are not materialized)',
      found: parsed.name,
      expected: 'unique member names within each object',
    },
  };
}
