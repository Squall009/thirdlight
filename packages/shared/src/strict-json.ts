/**
 * Strict JSON text parsing (RFC 8259): no NaN/Infinity/undefined tokens, no
 * trailing commas or trailing data, exactly the four JSON whitespace
 * characters, and (by default) no repeated member name within one object,
 * compared after escape decoding. `JSON.parse` cannot do the last check: it
 * keeps the last value silently.
 *
 * The document readers, the wire protocol, the GLB importer and the exporter
 * all parse this way but differ at the edges; each difference is an option,
 * so every caller keeps exactly what it accepted before.
 */

/** Where the parsers differ. Every option defaults to the document readers' rule. */
export interface StrictJsonOptions {
  /**
   * Reject a repeated member name within one object (default true): the
   * first in source order. `'after-syntax'` checks the whole text's syntax
   * first, so a syntax error anywhere wins over an earlier repeated name.
   */
  readonly duplicates?: boolean | 'after-syntax';
  /** Build objects with a null prototype, so a `__proto__` member is an ordinary own property (default false). */
  readonly nullPrototype?: boolean;
  /** Reject a number that overflows to ±Infinity (default false: `1e400` reads as `JSON.parse` reads it). */
  readonly finiteNumbers?: boolean;
  /** Accept unescaped control characters inside strings (default false). */
  readonly rawControlChars?: boolean;
  /** Reject a string that decodes to an unpaired surrogate (default false). */
  readonly rejectLoneSurrogates?: boolean;
}

/** A parse failure: a syntax error at a text offset, or the first repeated member name in source order. */
export type StrictJsonFailure =
  | { readonly ok: false; readonly kind: 'syntax'; readonly pos: number; readonly message: string }
  | { readonly ok: false; readonly kind: 'duplicate'; readonly pointer: string; readonly name: string; readonly message: string };

export type StrictJsonResult = { readonly ok: true; readonly value: unknown } | StrictJsonFailure;

/** RFC 6901 JSON Pointer escaping of one reference token. */
export function escapePointer(token: string): string {
  return token.replace(/~/g, '~0').replace(/\//g, '~1');
}

/** Whether bytes start with a UTF-8 byte order mark (strict documents never strip one silently). */
export function hasUtf8Bom(bytes: Uint8Array): boolean {
  return bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf;
}

class SyntaxFail {
  constructor(
    readonly pos: number,
    readonly message: string,
  ) {}
}

class DuplicateFail {
  constructor(
    readonly pointer: string,
    readonly name: string,
  ) {}
}

function hasLoneSurrogate(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      const next = text.charCodeAt(i + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
      i += 1;
    } else if (c >= 0xdc00 && c <= 0xdfff) {
      return true;
    }
  }
  return false;
}

const ESCAPES: Readonly<Record<number, string>> = { 0x22: '"', 0x5c: '\\', 0x2f: '/', 0x62: '\b', 0x66: '\f', 0x6e: '\n', 0x72: '\r', 0x74: '\t' };

/**
 * Parses one JSON text strictly. Never throws for bad input: a syntax error
 * or a repeated name comes back as a failure (anything else, such as a stack
 * overflow on absurd nesting, is left to the caller).
 */
export function parseStrictJsonText(text: string, options: StrictJsonOptions = {}): StrictJsonResult {
  if (options.duplicates === 'after-syntax') {
    const syntax = parseStrictJsonText(text, { ...options, duplicates: false });
    return syntax.ok ? parseStrictJsonText(text, { ...options, duplicates: true }) : syntax;
  }
  const duplicates = options.duplicates ?? true;
  const nullPrototype = options.nullPrototype ?? false;
  const finiteNumbers = options.finiteNumbers ?? false;
  const rawControlChars = options.rawControlChars ?? false;
  const rejectLoneSurrogates = options.rejectLoneSurrogates ?? false;
  const n = text.length;
  let i = 0;
  const fail = (message: string, pos: number = i): never => {
    throw new SyntaxFail(pos, message);
  };
  const isDigit = (c: number): boolean => c >= 0x30 && c <= 0x39;

  /** Skips whitespace; true when a character remains. */
  const skipWs = (): boolean => {
    while (i < n) {
      const c = text.charCodeAt(i);
      if (c === 0x20 || c === 0x09 || c === 0x0a || c === 0x0d) i += 1;
      else break;
    }
    return i < n;
  };

  const hex4 = (): number => {
    if (i + 4 > n) fail('truncated \\u escape');
    const s = text.slice(i, i + 4);
    if (!/^[0-9a-fA-F]{4}$/.test(s)) fail('invalid \\u escape');
    i += 4;
    return parseInt(s, 16);
  };

  const parseString = (): string => {
    i += 1; // the opening quote
    let out = '';
    for (;;) {
      if (i >= n) fail('unterminated string');
      const c = text.charCodeAt(i);
      if (c === 0x22) {
        i += 1;
        if (rejectLoneSurrogates && hasLoneSurrogate(out)) fail('unpaired surrogate in a string');
        return out;
      }
      if (c < 0x20 && !rawControlChars) fail('control character in a string');
      if (c !== 0x5c) {
        out += text[i];
        i += 1;
        continue;
      }
      i += 1;
      if (i >= n) fail('unterminated escape sequence');
      const e = text.charCodeAt(i);
      const simple = ESCAPES[e];
      if (simple !== undefined) {
        out += simple;
        i += 1;
      } else if (e === 0x75) {
        i += 1;
        out += String.fromCharCode(hex4());
      } else {
        fail(`invalid escape character "\\${text[i]}"`);
      }
    }
  };

  const parseNumber = (): number => {
    const start = i;
    if (text.charCodeAt(i) === 0x2d) i += 1;
    const c0 = text.charCodeAt(i);
    if (c0 === 0x30) i += 1;
    else if (c0 >= 0x31 && c0 <= 0x39) {
      while (i < n && isDigit(text.charCodeAt(i))) i += 1;
    } else fail('invalid number');
    if (text.charCodeAt(i) === 0x2e) {
      i += 1;
      if (!isDigit(text.charCodeAt(i))) fail('invalid number fraction');
      while (i < n && isDigit(text.charCodeAt(i))) i += 1;
    }
    const e = text.charCodeAt(i);
    if (e === 0x65 || e === 0x45) {
      i += 1;
      const s = text.charCodeAt(i);
      if (s === 0x2b || s === 0x2d) i += 1;
      if (!isDigit(text.charCodeAt(i))) fail('invalid number exponent');
      while (i < n && isDigit(text.charCodeAt(i))) i += 1;
    }
    const v = Number(text.slice(start, i));
    if (finiteNumbers && !Number.isFinite(v)) fail('number out of the finite range');
    return v;
  };

  const literal = (word: string, value: unknown): unknown => {
    if (!text.startsWith(word, i)) fail(`invalid literal (expected "${word}")`);
    i += word.length;
    return value;
  };

  const parseObject = (pointer: string): Record<string, unknown> => {
    i += 1; // '{'
    const obj = (nullPrototype ? Object.create(null) : {}) as Record<string, unknown>;
    const seen = new Set<string>();
    if (!skipWs()) fail('expected a string object key');
    if (text.charCodeAt(i) === 0x7d) {
      i += 1;
      return obj;
    }
    for (;;) {
      if (!skipWs() || text.charCodeAt(i) !== 0x22) fail('expected a string object key');
      const key = parseString();
      const keyPointer = `${pointer}/${escapePointer(key)}`;
      if (duplicates) {
        if (seen.has(key)) throw new DuplicateFail(keyPointer, key);
        seen.add(key);
      }
      if (!skipWs() || text.charCodeAt(i) !== 0x3a) fail('expected ":" after an object key');
      i += 1;
      obj[key] = parseValue(keyPointer);
      if (!skipWs()) fail('unterminated object');
      const c = text.charCodeAt(i);
      if (c === 0x2c) {
        i += 1;
        // A member name must follow the comma: this rejects a trailing comma.
        if (!skipWs() || text.charCodeAt(i) !== 0x22) fail('expected a string object key');
        continue;
      }
      if (c === 0x7d) {
        i += 1;
        return obj;
      }
      fail('expected "," or "}" in an object');
    }
  };

  const parseArray = (pointer: string): unknown[] => {
    i += 1; // '['
    const arr: unknown[] = [];
    if (!skipWs()) fail('unexpected end of input');
    if (text.charCodeAt(i) === 0x5d) {
      i += 1;
      return arr;
    }
    for (;;) {
      arr.push(parseValue(`${pointer}/${arr.length}`));
      if (!skipWs()) fail('unterminated array');
      const c = text.charCodeAt(i);
      if (c === 0x2c) {
        i += 1;
        if (!skipWs()) fail('unexpected end of input');
        if (text.charCodeAt(i) === 0x5d) fail('trailing comma in an array');
        continue;
      }
      if (c === 0x5d) {
        i += 1;
        return arr;
      }
      fail('expected "," or "]" in an array');
    }
  };

  const parseValue = (pointer: string): unknown => {
    if (!skipWs()) fail('unexpected end of input');
    const c = text.charCodeAt(i);
    if (c === 0x7b) return parseObject(pointer);
    if (c === 0x5b) return parseArray(pointer);
    if (c === 0x22) return parseString();
    if (c === 0x74) return literal('true', true);
    if (c === 0x66) return literal('false', false);
    if (c === 0x6e) return literal('null', null);
    if (c === 0x2d || isDigit(c)) return parseNumber();
    return fail(`unexpected character "${text[i]}"`);
  };

  try {
    const value = parseValue('');
    if (skipWs()) fail('trailing data after the JSON value');
    return { ok: true, value };
  } catch (e) {
    if (e instanceof SyntaxFail) return { ok: false, kind: 'syntax', pos: e.pos, message: e.message };
    if (e instanceof DuplicateFail) return { ok: false, kind: 'duplicate', pointer: e.pointer, name: e.name, message: `duplicate key "${e.name.slice(0, 32)}"` };
    throw e;
  }
}
