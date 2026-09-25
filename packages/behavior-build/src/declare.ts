/**
 * Phase 15.4: properties declared in code.
 *
 * A script may declare its properties in `src/index.ts`:
 *
 * ```ts
 * export const properties = {
 *   speed: property.number(3, { min: 0, group: 'Movement', tooltip: 'Metres per second' }),
 *   secret: property.private.number(1),
 *   mode: property.enum('walk', { values: ['walk', 'run'] }),
 * };
 * ```
 *
 * The compiler reads that literal statically (it never evaluates source) and
 * derives the behavior's declaration from it, so the declaration and the code
 * cannot drift. The statement is then rewritten to plain data (each key maps
 * to its declared property object) so the module runs without any `property`
 * helper in scope; scripts keep reading values through `ctx.properties`.
 *
 * Accepted form (anything else under `export const properties` is a compile
 * error naming the position): an object literal whose values are
 * `property[.public|.private].<type>(<default>[, <options>])` with `<type>`
 * one of number, boolean, string, enum, vec3, entityRef, assetRef; defaults
 * and options are literals (numbers, strings, booleans, null, arrays,
 * objects). Options: label, min, max, step, maxLength, values, bounds, group,
 * header, tooltip. A missing label is the key in words ("jump_height" →
 * "Jump height"). Value rules (ranges, enum members, limits) are checked by
 * the publication command exactly as for a JSON declaration.
 */

import type { DeclaredProperty } from '@thirdlight/project-model';

/** The seven declared property types (`property.<type>`). */
const TYPES = ['number', 'boolean', 'string', 'enum', 'vec3', 'entityRef', 'assetRef'] as const;
/** Option keys a code declaration may pass (the declared-property fields minus key/type/default/visibility). */
const OPTION_KEYS = ['label', 'min', 'max', 'step', 'maxLength', 'values', 'bounds', 'group', 'header', 'tooltip'] as const;

export type CodeDeclarationResult =
  | { found: false }
  | { found: true; ok: true; properties: DeclaredProperty[]; start: number; end: number }
  | { found: true; ok: false; message: string; line: number; column: number };

class ParseError extends Error {
  constructor(message: string, readonly index: number) {
    super(message);
  }
}

type Literal = number | string | boolean | null | Literal[] | { [k: string]: Literal };

/** A small recursive-descent reader over the literal subset. */
class Reader {
  i: number;
  constructor(readonly text: string, start: number) {
    this.i = start;
  }

  fail(message: string, at = this.i): never {
    throw new ParseError(message, at);
  }

  /** Skip whitespace and comments. */
  ws(): void {
    const t = this.text;
    for (;;) {
      const c = t[this.i];
      if (c === ' ' || c === '\t' || c === '\n' || c === '\r') this.i++;
      else if (c === '/' && t[this.i + 1] === '/') {
        while (this.i < t.length && t[this.i] !== '\n') this.i++;
      } else if (c === '/' && t[this.i + 1] === '*') {
        const end = t.indexOf('*/', this.i + 2);
        if (end < 0) this.fail('unterminated comment');
        this.i = end + 2;
      } else return;
    }
  }

  peek(): string | undefined {
    this.ws();
    return this.text[this.i];
  }

  expect(ch: string): void {
    if (this.peek() !== ch) this.fail(`expected "${ch}"`);
    this.i++;
  }

  identifier(): string {
    this.ws();
    const m = /^[A-Za-z_$][A-Za-z0-9_$]*/.exec(this.text.slice(this.i, this.i + 256));
    if (m === null) this.fail('expected a name');
    this.i += m[0].length;
    return m[0];
  }

  string(): string {
    this.ws();
    const q = this.text[this.i];
    if (q !== "'" && q !== '"') this.fail('expected a quoted string (template strings are not accepted)');
    this.i++;
    let out = '';
    for (;;) {
      const c = this.text[this.i];
      if (c === undefined || c === '\n') this.fail('unterminated string');
      this.i++;
      if (c === q) return out;
      if (c === '\\') {
        const e = this.text[this.i++];
        const simple: Record<string, string> = { n: '\n', t: '\t', r: '\r', '\\': '\\', "'": "'", '"': '"', '0': '\0' };
        if (e !== undefined && simple[e] !== undefined) out += simple[e];
        else if (e === 'u') {
          const hex = /^[0-9a-fA-F]{4}/.exec(this.text.slice(this.i, this.i + 4));
          if (hex === null) this.fail('bad \\u escape');
          out += String.fromCharCode(parseInt(hex[0], 16));
          this.i += 4;
        } else this.fail('unsupported string escape');
      } else out += c;
    }
  }

  number(): number {
    this.ws();
    const m = /^-?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/.exec(this.text.slice(this.i, this.i + 64));
    if (m === null) this.fail('expected a number');
    this.i += m[0].length;
    const n = Number(m[0]);
    if (!Number.isFinite(n)) this.fail('the number is not finite');
    return n;
  }

  /** A literal value: number, string, true/false/null, array or object. */
  literal(depth = 0): Literal {
    if (depth > 8) this.fail('the literal is nested too deeply');
    const c = this.peek();
    if (c === '[') {
      this.i++;
      const out: Literal[] = [];
      while (this.peek() !== ']') {
        out.push(this.literal(depth + 1));
        if (out.length > 64) this.fail('the list is too long');
        if (this.peek() === ',') this.i++;
        else if (this.peek() !== ']') this.fail('expected "," or "]"');
      }
      this.i++;
      return out;
    }
    if (c === '{') {
      this.i++;
      const out: { [k: string]: Literal } = {};
      while (this.peek() !== '}') {
        const at = this.i;
        const key = this.peek() === "'" || this.peek() === '"' ? this.string() : this.identifier();
        if (Object.prototype.hasOwnProperty.call(out, key)) this.fail(`"${key}" is given twice`, at);
        this.expect(':');
        out[key] = this.literal(depth + 1);
        if (this.peek() === ',') this.i++;
        else if (this.peek() !== '}') this.fail('expected "," or "}"');
      }
      this.i++;
      return out;
    }
    if (c === "'" || c === '"') return this.string();
    if (c === '-' || c === '.' || (c !== undefined && c >= '0' && c <= '9')) return this.number();
    const at = this.i;
    const word = this.identifier();
    if (word === 'true') return true;
    if (word === 'false') return false;
    if (word === 'null') return null;
    return this.fail(`"${word}" is not a literal (declared defaults and options must be literal values)`, at);
  }
}

/** "jump_height" → "Jump height" (a readable default label, ≤ 64 characters). */
export function labelOfKey(key: string): string {
  const words = key.split('_').filter((w) => w.length > 0).join(' ');
  const text = words.length > 0 ? words.charAt(0).toUpperCase() + words.slice(1) : key;
  return text.slice(0, 64);
}

function isPlain(v: unknown): v is Record<string, Literal> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** One `property[.public|.private].<type>(default[, options])` call. */
function readProperty(r: Reader, key: string): DeclaredProperty {
  r.ws();
  const at = r.i;
  const head = /^[A-Za-z_$]/.test(r.text[r.i] ?? '') ? r.identifier() : '';
  if (head !== 'property') r.fail(`the value of "${key}" must be property.<type>(default, options?)`, at);
  r.expect('.');
  let visibility: 'public' | 'private' | undefined;
  let typeAt = r.i;
  let type = r.identifier();
  if (type === 'private' || type === 'public') {
    visibility = type;
    r.expect('.');
    typeAt = r.i;
    type = r.identifier();
  }
  if (!(TYPES as readonly string[]).includes(type)) r.fail(`property.${type} is not a property type (use ${TYPES.join(', ')})`, typeAt);
  r.expect('(');
  if (r.peek() === ')') r.fail(`property.${type} needs a default value`);
  const def = r.literal();
  let options: Record<string, Literal> = {};
  if (r.peek() === ',') {
    r.i++;
    if (r.peek() !== ')') {
      const optAt = r.i;
      const o = r.literal();
      if (!isPlain(o)) r.fail('the options must be an object literal', optAt);
      options = o;
      if (r.peek() === ',') r.i++;
    }
  }
  r.expect(')');
  for (const k of Object.keys(options)) {
    if (!(OPTION_KEYS as readonly string[]).includes(k)) r.fail(`unknown option "${k}" for "${key}" (options: ${OPTION_KEYS.join(', ')})`, at);
  }
  const label = options['label'];
  // Canonical field order (project-model §20.5 + phase 15.4).
  const out: Record<string, unknown> = {
    key,
    label: typeof label === 'string' ? label : labelOfKey(key),
    type,
    default: def,
  };
  if (label !== undefined && typeof label !== 'string') r.fail(`the label of "${key}" must be a string`, at);
  for (const k of ['min', 'max', 'step', 'maxLength', 'values', 'bounds'] as const) {
    if (options[k] !== undefined) out[k] = options[k];
  }
  if (visibility === 'private') out['visibility'] = 'private';
  for (const k of ['group', 'header', 'tooltip'] as const) {
    if (options[k] !== undefined) out[k] = options[k];
  }
  return out as unknown as DeclaredProperty;
}

/** 1-based line and column of a text offset. */
function position(text: string, index: number): { line: number; column: number } {
  let line = 1;
  let last = -1;
  for (let i = 0; i < index && i < text.length; i++) {
    if (text.charCodeAt(i) === 10) {
      line++;
      last = i;
    }
  }
  return { line, column: index - last };
}

/** Where `export const properties` starts (outside a line comment), or -1. */
function findDeclaration(text: string): { start: number; valueAt: number } | null {
  const re = /\bexport\s+const\s+properties\b\s*(?::[^=;{]*)?=/g;
  for (const m of text.matchAll(re)) {
    const start = m.index ?? 0;
    const lineStart = text.lastIndexOf('\n', start) + 1;
    if (text.slice(lineStart, start).includes('//')) continue;
    return { start, valueAt: start + m[0].length };
  }
  return null;
}

/**
 * Read `export const properties = { … }` from the entry file. `found: false`
 * when the file does not declare properties in code (the JSON declaration
 * applies).
 */
export function readCodeDeclaration(entryText: string): CodeDeclarationResult {
  const hit = findDeclaration(entryText);
  if (hit === null) return { found: false };
  const r = new Reader(entryText, hit.valueAt);
  try {
    r.expect('{');
    const properties: DeclaredProperty[] = [];
    const seen = new Set<string>();
    while (r.peek() !== '}') {
      const at = r.i;
      const key = r.peek() === "'" || r.peek() === '"' ? r.string() : r.identifier();
      if (seen.has(key)) r.fail(`property "${key}" is declared twice`, at);
      seen.add(key);
      r.expect(':');
      properties.push(readProperty(r, key));
      if (properties.length > 64) r.fail('too many properties');
      if (r.peek() === ',') r.i++;
      else if (r.peek() !== '}') r.fail('expected "," or "}"');
    }
    r.i++;
    return { found: true, ok: true, properties, start: hit.start, end: r.i };
  } catch (e) {
    if (!(e instanceof ParseError)) throw e;
    const { line, column } = position(entryText, e.index);
    return { found: true, ok: false, message: `export const properties (src/index.ts:${line}:${column}): ${e.message}`, line, column };
  }
}

/**
 * The entry text the bundler compiles: the declaration statement becomes
 * plain data (key → declared property), so no `property` helper is needed at
 * run time.
 */
export function rewriteCodeDeclaration(entryText: string, start: number, end: number, properties: readonly DeclaredProperty[]): string {
  const data: Record<string, DeclaredProperty> = {};
  for (const p of properties) data[p.key] = p;
  return `${entryText.slice(0, start)}export const properties = ${JSON.stringify(data)}${entryText.slice(end)}`;
}
