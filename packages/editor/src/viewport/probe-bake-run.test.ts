import { describe, expect, it } from 'vitest';

import { sameTurn } from './probe-bake-run';

describe('probe staleness', () => {
  it('a sky turned by a whole turn (or to the same direction the other way round) leaves the probes fresh', () => {
    expect(sameTurn(0, 360)).toBe(true);
    expect(sameTurn(180, -180)).toBe(true);
    expect(sameTurn(-90, 270)).toBe(true);
    expect(sameTurn(10, 10)).toBe(true);
    expect(sameTurn(10, 11)).toBe(false);
    expect(sameTurn(0, 359.5)).toBe(false);
  });
});
