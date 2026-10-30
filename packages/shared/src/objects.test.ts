import { describe, expect, it } from 'vitest';
import { deepFreeze, deepFreezeAll, deepFreezeExceptViews, isPlainObject, isPlainObjectStrict } from './objects';
import { utf8Encode, utf8Length, utf8LengthPairingAnyHigh, utf8LengthPairingHigh } from './utf8';

describe('object checks', () => {
  it('isPlainObject takes any non-array object; the strict check only literal and null-prototype objects', () => {
    for (const v of [{}, { a: 1 }, Object.create(null)]) {
      expect(isPlainObject(v)).toBe(true);
      expect(isPlainObjectStrict(v)).toBe(true);
    }
    for (const v of [new Map(), new Date(0), new Error('x')]) {
      expect(isPlainObject(v)).toBe(true);
      expect(isPlainObjectStrict(v)).toBe(false);
    }
    for (const v of [null, undefined, [], [1], 'a', 1, true]) {
      expect(isPlainObject(v)).toBe(false);
      expect(isPlainObjectStrict(v)).toBe(false);
    }
  });
});

describe('deep freezing', () => {
  it('freezes nested objects and arrays', () => {
    for (const freeze of [deepFreeze, deepFreezeAll, deepFreezeExceptViews]) {
      const v = freeze({ a: { b: [1, { c: 2 }] } });
      expect(Object.isFrozen(v.a.b[1])).toBe(true);
    }
  });

  it('deepFreeze skips a frozen parent, deepFreezeAll walks into it', () => {
    const inner = { x: 1 };
    expect(Object.isFrozen(deepFreeze(Object.freeze({ inner })).inner)).toBe(false);
    expect(Object.isFrozen(deepFreezeAll(Object.freeze({ inner })).inner)).toBe(true);
  });

  it('only deepFreezeExceptViews passes typed arrays through', () => {
    const v = deepFreezeExceptViews({ bytes: new Uint8Array([1, 2]) });
    expect(Object.isFrozen(v)).toBe(true);
    expect(Object.isFrozen(v.bytes)).toBe(false);
    expect(() => deepFreeze({ bytes: new Uint8Array([1, 2]) })).toThrow(TypeError);
  });
});

describe('utf8Length', () => {
  const wellFormed = ['', 'abc', 'é', '€', '😀', 'a😀é€\u0000', '߿ࠀ￿'];
  const loneHigh = ['\ud800', '\ud800a', 'a\ud800\ud800', '\udc00'];

  it('equals the encoded length, lone surrogates included', () => {
    for (const s of [...wellFormed, ...loneHigh]) expect(utf8Length(s)).toBe(utf8Encode(s).length);
  });

  it('the scene and save variants agree with it on well-formed text and keep their own counts on lone high surrogates', () => {
    for (const s of wellFormed) {
      expect(utf8LengthPairingAnyHigh(s)).toBe(utf8Length(s));
      expect(utf8LengthPairingHigh(s)).toBe(utf8Length(s));
    }
    expect(loneHigh.map(utf8Length)).toEqual([3, 4, 7, 3]);
    expect(loneHigh.map(utf8LengthPairingAnyHigh)).toEqual([4, 4, 5, 3]);
    expect(loneHigh.map(utf8LengthPairingHigh)).toEqual([3, 4, 5, 3]);
  });
});
