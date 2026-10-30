import { describe, expect, it } from 'vitest';
import { parseStrictJsonText } from './strict-json';

const fail = (text: string, options = {}) => {
  const r = parseStrictJsonText(text, options);
  if (r.ok) throw new Error(`parsed: ${text}`);
  return r;
};

describe('parseStrictJsonText', () => {
  it('reads RFC 8259 JSON and refuses what JSON.parse refuses', () => {
    expect(parseStrictJsonText('{"a":[1,-0.5e2,true,null,"\\u00e9\\uD83D\\uDE00"]}')).toEqual({ ok: true, value: { a: [1, -50, true, null, 'é😀'] } });
    for (const t of ['', '[1,]', '{"a":1,}', '01', '1.', 'NaN', '"\\x"', '"a\nb"', '1 2', ' 1']) {
      expect(() => JSON.parse(t)).toThrow();
      expect(fail(t).kind).toBe('syntax');
    }
  });

  it('reports the first repeated name in source order, or after the whole syntax with after-syntax', () => {
    expect(fail('{"a":{"b/~":1,"b/~":2}}')).toMatchObject({ kind: 'duplicate', pointer: '/a/b~1~0', name: 'b/~' });
    expect(fail('{"a":1,"a":2,]').kind).toBe('duplicate');
    expect(fail('{"a":1,"a":2,]', { duplicates: 'after-syntax' })).toMatchObject({ kind: 'syntax', pos: 13 });
    expect(parseStrictJsonText('{"a":1,"a":2}', { duplicates: false })).toEqual({ ok: true, value: { a: 2 } });
  });

  it('keeps each caller rule apart: overflow, raw control characters, lone surrogates, null prototypes', () => {
    expect(parseStrictJsonText('1e400')).toEqual({ ok: true, value: Infinity });
    expect(fail('1e400', { finiteNumbers: true }).message).toBe('number out of the finite range');
    expect(parseStrictJsonText('"a\tb"', { rawControlChars: true })).toEqual({ ok: true, value: 'a\tb' });
    expect(parseStrictJsonText('"\\uD800"')).toEqual({ ok: true, value: '\uD800' });
    expect(fail('"\\uD800"', { rejectLoneSurrogates: true }).kind).toBe('syntax');
    const r = parseStrictJsonText('{"__proto__":{"x":1}}', { nullPrototype: true });
    expect(r.ok && Object.getPrototypeOf(r.value)).toBe(null);
    expect(r.ok && Object.keys(r.value as object)).toEqual(['__proto__']);
  });
});
