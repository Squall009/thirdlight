/**
 * Strict byte parsing — project-model.md §12.3 pass 1, normative order:
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
 * the value validator's job (§12.3/§12.7), not a syntax error.
 *
 * The input bytes are never mutated or consumed.
 */

import type { ModelError } from './errors';

const BOM = [0xef, 0xbb, 0xbf] as const;

/** RFC 6901 JSON Pointer escaping of one reference token (§12.5). */
export function escapePointer(token: string): string {
  return token.replace(/~/g, '~0').replace(/\//g, '~1');
}

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

/** Strict JSON syntax violation (control flow only; not thrown across the API). */
class SyntaxErr extends Error {
  constructor(readonly pos: number) {
    super(`strict JSON syntax error at ${pos}`);
  }
}

/** Duplicate key violation (control flow only). */
class DuplicateKeyErr extends Error {
  constructor(readonly pointer: string, readonly name: string) {
    super(`duplicate key at ${pointer}`);
  }
}

/**
 * Strict recursive-descent JSON parse.
 *
 * - `trackDuplicates` off: pure syntax check (pass 1) — the materialized
 *   value is discarded by the caller, so last-key-wins materialization can
 *   never feed duplicate detection (contract §12.3 pass 1).
 * - `trackDuplicates` on: materializes the value and stops at the first
 *   repeated (escape-decoded) member name within a single object.
 */
function strictJsonParse(
  text: string,
  trackDuplicates: boolean,
):
  | { ok: true; value: unknown }
  | { ok: false; syntaxPos: number }
  | { ok: false; duplicatePointer: string; duplicateName: string } {
  const n = text.length;
  let i = 0;

  const isDigit = (c: number): boolean => c >= 0x30 && c <= 0x39;

  const skipWs = (): boolean => {
    while (i < n) {
      const c = text.charCodeAt(i);
      if (c === 0x20 || c === 0x09 || c === 0x0a || c === 0x0d) i += 1;
      else break;
    }
    return i < n;
  };

  const hex4 = (): number => {
    if (i + 4 > n) throw new SyntaxErr(i);
    const s = text.slice(i, i + 4);
    for (let k = 0; k < 4; k++) {
      const c = s.charCodeAt(k);
      const d =
        (c >= 0x30 && c <= 0x39 ? c - 0x30 : 0) +
        (c >= 0x41 && c <= 0x46 ? c - 0x41 + 10 : 0) +
        (c >= 0x61 && c <= 0x66 ? c - 0x61 + 10 : 0);
      if (d < 0 || d > 15 || ((c < 0x30 || c > 0x39) && (c < 0x41 || c > 0x46) && (c < 0x61 || c > 0x66))) {
        throw new SyntaxErr(i);
      }
    }
    i += 4;
    return parseInt(s, 16);
  };

  const parseString = (): string => {
    i += 1; // opening quote
    let out = '';
    for (;;) {
      if (i >= n) throw new SyntaxErr(i);
      const c = text.charCodeAt(i);
      if (c === 0x22) {
        i += 1;
        return out;
      }
      if (c < 0x20) throw new SyntaxErr(i); // unescaped control character
      if (c === 0x5c) {
        i += 1;
        if (i >= n) throw new SyntaxErr(i);
        const e = text.charCodeAt(i);
        switch (e) {
          case 0x22:
            out += '"';
            i += 1;
            break;
          case 0x5c:
            out += '\\';
            i += 1;
            break;
          case 0x2f:
            out += '/';
            i += 1;
            break;
          case 0x62:
            out += '\b';
            i += 1;
            break;
          case 0x66:
            out += '\f';
            i += 1;
            break;
          case 0x6e:
            out += '\n';
            i += 1;
            break;
          case 0x72:
            out += '\r';
            i += 1;
            break;
          case 0x74:
            out += '\t';
            i += 1;
            break;
          case 0x75: {
            i += 1;
            const cp1 = hex4();
            let ch: string;
            if (cp1 >= 0xd800 && cp1 <= 0xdbff) {
              // High surrogate: pair with a following \uDC00–\uDFFF if present.
              if (
                i + 6 <= n &&
                text.charCodeAt(i) === 0x5c &&
                text.charCodeAt(i + 1) === 0x75
              ) {
                const save = i;
                i += 2;
                const cp2 = hex4();
                if (cp2 >= 0xdc00 && cp2 <= 0xdfff) {
                  ch = String.fromCodePoint(
                    0x10000 + ((cp1 - 0xd800) << 10) + (cp2 - 0xdc00),
                  );
                } else {
                  i = save; // lone high surrogate
                  ch = String.fromCharCode(cp1);
                }
              } else {
                ch = String.fromCharCode(cp1);
              }
            } else {
              ch = String.fromCharCode(cp1);
            }
            out += ch;
            break;
          }
          default:
            throw new SyntaxErr(i);
        }
      } else {
        out += String.fromCharCode(c);
        i += 1;
      }
    }
  };

  const parseNumber = (): number => {
    const start = i;
    if (text.charCodeAt(i) === 0x2d) i += 1; // '-'
    const c0 = text.charCodeAt(i);
    if (c0 === 0x30) {
      i += 1;
    } else if (c0 >= 0x31 && c0 <= 0x39) {
      i += 1;
      while (i < n && isDigit(text.charCodeAt(i))) i += 1;
    } else {
      throw new SyntaxErr(i);
    }
    if (text.charCodeAt(i) === 0x2e) {
      i += 1;
      if (!isDigit(text.charCodeAt(i))) throw new SyntaxErr(i);
      while (i < n && isDigit(text.charCodeAt(i))) i += 1;
    }
    const e = text.charCodeAt(i);
    if (e === 0x65 || e === 0x45) {
      i += 1;
      const s = text.charCodeAt(i);
      if (s === 0x2b || s === 0x2d) i += 1;
      if (!isDigit(text.charCodeAt(i))) throw new SyntaxErr(i);
      while (i < n && isDigit(text.charCodeAt(i))) i += 1;
    }
    // JavaScript JSON.parse semantics: `1e400` → Infinity (a value-validation
    // concern, §12.7), never a syntax error.
    return Number(text.slice(start, i));
  };

  const literal = (word: string, value: unknown): unknown => {
    if (!text.startsWith(word, i)) throw new SyntaxErr(i);
    i += word.length;
    return value;
  };

  const parseObject = (pointer: string): Record<string, unknown> => {
    i += 1; // '{'
    const obj: Record<string, unknown> = {};
    const seen = new Set<string>();
    if (!skipWs()) throw new SyntaxErr(i);
    if (text.charCodeAt(i) === 0x7d) {
      i += 1;
      return obj;
    }
    for (;;) {
      if (!skipWs()) throw new SyntaxErr(i);
      if (text.charCodeAt(i) !== 0x22) throw new SyntaxErr(i);
      const key = parseString(); // decoded (escape-resolved) name
      const keyPointer = `${pointer}/${escapePointer(key)}`;
      if (trackDuplicates && seen.has(key)) {
        throw new DuplicateKeyErr(keyPointer, key);
      }
      if (trackDuplicates) seen.add(key);
      if (!skipWs()) throw new SyntaxErr(i);
      if (text.charCodeAt(i) !== 0x3a) throw new SyntaxErr(i);
      i += 1;
      obj[key] = parseValue(keyPointer);
      if (!skipWs()) throw new SyntaxErr(i);
      const c = text.charCodeAt(i);
      if (c === 0x2c) {
        i += 1;
        if (!skipWs()) throw new SyntaxErr(i);
        // A member name must follow the comma — this rejects trailing commas.
        if (text.charCodeAt(i) !== 0x22) throw new SyntaxErr(i);
        continue;
      }
      if (c === 0x7d) {
        i += 1;
        return obj;
      }
      throw new SyntaxErr(i);
    }
  };

  const parseArray = (pointer: string): unknown[] => {
    i += 1; // '['
    const arr: unknown[] = [];
    if (!skipWs()) throw new SyntaxErr(i);
    if (text.charCodeAt(i) === 0x5d) {
      i += 1;
      return arr;
    }
    for (;;) {
      arr.push(parseValue(`${pointer}/${arr.length}`));
      if (!skipWs()) throw new SyntaxErr(i);
      const c = text.charCodeAt(i);
      if (c === 0x2c) {
        i += 1;
        if (!skipWs()) throw new SyntaxErr(i);
        continue;
      }
      if (c === 0x5d) {
        i += 1;
        return arr;
      }
      throw new SyntaxErr(i);
    }
  };

  const parseValue = (pointer: string): unknown => {
    if (!skipWs()) throw new SyntaxErr(i);
    const c = text.charCodeAt(i);
    if (c === 0x7b) return parseObject(pointer);
    if (c === 0x5b) return parseArray(pointer);
    if (c === 0x22) return parseString();
    if (c === 0x74) return literal('true', true);
    if (c === 0x66) return literal('false', false);
    if (c === 0x6e) return literal('null', null);
    if (c === 0x2d || (c >= 0x30 && c <= 0x39)) return parseNumber();
    throw new SyntaxErr(i);
  };

  try {
    if (!skipWs()) throw new SyntaxErr(i); // empty document
    const value = parseValue('');
    // skipWs() returns true when a NON-whitespace character remains — that
    // is exactly the trailing-garbage condition.
    if (skipWs()) throw new SyntaxErr(i);
    return { ok: true, value };
  } catch (err) {
    if (err instanceof DuplicateKeyErr) {
      return {
        ok: false,
        duplicatePointer: err.pointer,
        duplicateName: err.name,
      };
    }
    if (err instanceof SyntaxErr) return { ok: false, syntaxPos: err.pos };
    throw err;
  }
}

/**
 * Result of pass 1: the decoded value, or the single pass-1 error
 * (`encoding_invalid` / `json_parse_error` / `duplicate_key`).
 */
export type ByteParse =
  | { ok: true; value: unknown }
  | { ok: false; error: ModelError };

/**
 * Run §12.3 pass 1 over raw document bytes (manifest or scene interchange
 * bytes). Pure: never mutates `bytes`, never throws. Parse failures stop
 * all deeper checks, even for unknown schema versions.
 */
export function parseDocumentBytes(bytes: Uint8Array): ByteParse {
  // Leading UTF-8 BOM: exactly one encoding_invalid (never silently stripped).
  if (
    bytes.length >= 3 &&
    bytes[0] === BOM[0] &&
    bytes[1] === BOM[1] &&
    bytes[2] === BOM[2]
  ) {
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
  const syntax = strictJsonParse(text, false);
  if (!syntax.ok && 'syntaxPos' in syntax) {
    return {
      ok: false,
      error: {
        code: 'json_parse_error',
        path: '',
        message:
          'document is not strict JSON (RFC 8259: no NaN/Infinity/undefined tokens, ' +
          'no trailing garbage, no trailing commas)',
        found: text.slice(syntax.syntaxPos, syntax.syntaxPos + 32),
        expected: 'strict JSON text',
      },
    };
  }
  const materialized = strictJsonParse(text, true);
  if (!materialized.ok) {
    if ('syntaxPos' in materialized) {
      // Unreachable (pass 1 already proved the syntax); keep the plane total.
      return {
        ok: false,
        error: {
          code: 'json_parse_error',
          path: '',
          message: 'document is not strict JSON (RFC 8259)',
          found: text.slice(materialized.syntaxPos, materialized.syntaxPos + 32),
          expected: 'strict JSON text',
        },
      };
    }
    return {
      ok: false,
      error: {
        code: 'duplicate_key',
        path: materialized.duplicatePointer,
        message:
          'duplicate object member name in the JSON text (names are compared ' +
          'after escape decoding; earlier occurrences are not materialized)',
        found: materialized.duplicateName,
        expected: 'unique member names within each object',
      },
    };
  }
  return { ok: true, value: materialized.value };
}