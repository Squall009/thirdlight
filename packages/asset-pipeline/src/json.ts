/**
 * Strict JSON parsing of the GLB JSON chunk (project-model.md §18.7.2 step 4):
 * UTF-8 without replacement, no BOM, RFC 8259 syntax only, root must be an
 * object, and repeated member names **rejected** (decoded, per object).
 *
 * `JSON.parse` cannot do the duplicate-key check (it silently keeps the last
 * value), so this is a small recursive-descent parser. It mirrors the pass-1
 * byte parser the model package uses for envelope/manifest bytes; the model
 * package's parser is not importable here (types-only edge, dependencies.md
 * §4.1) so this package parses the JSON chunk itself — the profile is defined
 * as inspecting bytes without a loader.
 *
 * Objects are built with a null prototype so a hostile `__proto__` member
 * becomes an ordinary own property instead of a prototype write.
 */

export type StrictJsonReason = 'bom' | 'encoding' | 'syntax' | 'duplicate';

export type StrictJsonResult =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly reason: StrictJsonReason; readonly path: string };

/** RFC 6901 JSON Pointer escaping of one reference token. */
export function escapePointer(token: string): string {
  return token.replace(/~/g, '~0').replace(/\//g, '~1');
}

class JsonError extends Error {
  constructor(
    readonly reason: 'syntax' | 'duplicate',
    readonly path: string,
  ) {
    super(reason);
  }
}

const RE_NUMBER = /-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/y;

/** True when `text` contains an unpaired UTF-16 surrogate code unit. */
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

function parseText(text: string): unknown {
  let i = 0;
  const n = text.length;
  const fail = (): never => {
    throw new JsonError('syntax', '');
  };
  const ws = (): void => {
    while (i < n) {
      const c = text.charCodeAt(i);
      if (c === 0x20 || c === 0x09 || c === 0x0a || c === 0x0d) i += 1;
      else return;
    }
  };

  function stringLit(): string {
    const start = i;
    i += 1;
    while (i < n) {
      const c = text.charCodeAt(i);
      if (c === 0x22) {
        i += 1;
        const raw = text.slice(start, i);
        let value: string;
        try {
          value = JSON.parse(raw) as string;
        } catch {
          return fail();
        }
        if (hasLoneSurrogate(value)) return fail();
        return value;
      }
      if (c === 0x5c) {
        i += 2;
        continue;
      }
      if (c < 0x20) return fail();
      i += 1;
    }
    return fail();
  }

  function number(): number {
    RE_NUMBER.lastIndex = i;
    const m = RE_NUMBER.exec(text);
    if (m === null || m[0].length === 0) return fail();
    i = RE_NUMBER.lastIndex;
    return Number(m[0]);
  }

  function literal(word: string, value: unknown): unknown {
    if (text.slice(i, i + word.length) !== word) return fail();
    i += word.length;
    return value;
  }

  function object(path: string): Record<string, unknown> {
    const out = Object.create(null) as Record<string, unknown>;
    const seen = new Set<string>();
    i += 1; // '{'
    ws();
    if (text[i] === '}') {
      i += 1;
      return out;
    }
    for (;;) {
      ws();
      if (text[i] !== '"') return fail();
      const key = stringLit();
      const keyPath = `${path}/${escapePointer(key)}`;
      if (seen.has(key)) throw new JsonError('duplicate', keyPath);
      seen.add(key);
      ws();
      if (text[i] !== ':') return fail();
      i += 1;
      out[key] = value_(keyPath);
      ws();
      const ch = text[i];
      if (ch === ',') {
        i += 1;
        continue;
      }
      if (ch === '}') {
        i += 1;
        return out;
      }
      return fail();
    }
  }

  function array(path: string): unknown[] {
    const out: unknown[] = [];
    i += 1; // '['
    ws();
    if (text[i] === ']') {
      i += 1;
      return out;
    }
    for (;;) {
      out.push(value_(`${path}/${out.length}`));
      ws();
      const ch = text[i];
      if (ch === ',') {
        i += 1;
        continue;
      }
      if (ch === ']') {
        i += 1;
        return out;
      }
      return fail();
    }
  }

  function value_(path: string): unknown {
    ws();
    if (i >= n) return fail();
    const c = text[i] as string;
    if (c === '{') return object(path);
    if (c === '[') return array(path);
    if (c === '"') return stringLit();
    if (c === 't') return literal('true', true);
    if (c === 'f') return literal('false', false);
    if (c === 'n') return literal('null', null);
    return number();
  }

  const value = value_('');
  ws();
  if (i !== n) return fail();
  return value;
}

/** Strictly parse `bytes` as a JSON document; total (never throws). */
export function strictJsonParse(bytes: Uint8Array): StrictJsonResult {
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return { ok: false, reason: 'bom', path: '' };
  }
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return { ok: false, reason: 'encoding', path: '' };
  }
  try {
    return { ok: true, value: parseText(text) };
  } catch (err) {
    if (err instanceof JsonError) return { ok: false, reason: err.reason, path: err.path };
    return { ok: false, reason: 'syntax', path: '' };
  }
}
