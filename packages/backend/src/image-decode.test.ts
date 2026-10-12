import jpeg from 'jpeg-js';
import { describe, expect, it } from 'vitest';

import { decodeSource } from './image-decode';

describe('decodeSource', () => {
  it('decodes a JPEG of exactly the pixel limit (every source of a packed texture is held to its one size)', () => {
    const side = 512;
    const data = new Uint8Array(side * side * 4).fill(200);
    const bytes = new Uint8Array(jpeg.encode({ data, width: side, height: side }, 80).data);
    const img = decodeSource(bytes, 'jpeg', side * side);
    expect([img.width, img.height]).toEqual([side, side]);
    expect(() => decodeSource(bytes, 'jpeg', side * side - side)).toThrow(/limit/);
  });
});
