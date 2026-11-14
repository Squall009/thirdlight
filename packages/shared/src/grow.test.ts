import { describe, expect, it } from 'vitest';

import { grownArray, grownCapacity } from './grow';

describe('buffer growth', () => {
  it('doubles from what is held (at least the floor) until the need fits, and keeps a capacity that already fits', () => {
    expect(grownCapacity(256, 100)).toBe(256);
    expect(grownCapacity(256, 257)).toBe(512);
    expect(grownCapacity(256, 5000)).toBe(8192);
    expect(grownCapacity(0, 1, 16)).toBe(16);
    expect(grownCapacity(0, 17, 16)).toBe(32);
    expect(grownCapacity(3, 7)).toBe(12);
    // A run of single steps doubles: few copies for a large final size.
    let have = 1;
    let copies = 0;
    for (let need = 1; need <= 100_000; need++) {
      const next = grownCapacity(have, need);
      if (next !== have) copies++;
      have = next;
    }
    expect(have).toBe(131_072);
    expect(copies).toBe(17);
  });

  it('keeps every value held, in its kind, zeros after it; the same array when the length is unchanged; never shorter', () => {
    const kinds = [Uint8Array, Uint16Array, Uint32Array, Int32Array, Float32Array, Float64Array] as const;
    for (const Kind of kinds) {
      const a = new Kind(5);
      for (let i = 0; i < 5; i++) a[i] = Kind === Int32Array ? -i - 1 : i + 0.5 * Number(Kind === Float32Array || Kind === Float64Array) + 1;
      const b = grownArray(a, 12);
      expect(b).toBeInstanceOf(Kind);
      expect(b.length).toBe(12);
      expect(Array.from(b.subarray(0, 5))).toEqual(Array.from(a));
      expect(Array.from(b.subarray(5))).toEqual(new Array(7).fill(0));
      expect(grownArray(a, 5)).toBe(a);
      expect(() => grownArray(a, 4)).toThrow(/shorter/);
    }
  });
});
