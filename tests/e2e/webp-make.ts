/**
 * Write small lossless WebP images for tests: two opaque colours (a checker,
 * a pattern), which the VP8L format codes with its "simple" prefix codes (at
 * most two symbols per channel, one bit a pixel per channel that differs),
 * so no Huffman tables or transforms are needed. The browser decodes them
 * like any WebP; what matters to the tests is the decoded size, not the
 * compression.
 */

class Bits {
  private readonly out: number[] = [];
  private acc = 0;
  private n = 0;
  /** `count` bits of `value`, least significant first (VP8L's bit order). */
  put(value: number, count: number): void {
    for (let i = 0; i < count; i += 1) {
      this.acc |= ((value >>> i) & 1) << this.n;
      this.n += 1;
      if (this.n === 8) {
        this.out.push(this.acc);
        this.acc = 0;
        this.n = 0;
      }
    }
  }
  bytes(): Buffer {
    return Buffer.from(this.n > 0 ? [...this.out, this.acc] : this.out);
  }
}

type Rgb = readonly [number, number, number];

/** A `w`×`h` opaque WebP (lossless): pixel (x, y) is colour `a` where `pick` says 0, `b` where it says 1. */
export function makeTwoColourWebp(w: number, h: number, a: Rgb, b: Rgb, pick: (x: number, y: number) => 0 | 1): Buffer {
  if (w < 1 || h < 1 || w > 16384 || h > 16384) throw new Error('makeTwoColourWebp: 1..16384 px a side');
  const bits = new Bits();
  bits.put(0x2f, 8);
  bits.put(w - 1, 14);
  bits.put(h - 1, 14);
  bits.put(0, 1); // alpha is not used
  bits.put(0, 3); // version
  bits.put(0, 1); // no transform
  bits.put(0, 1); // no colour cache
  bits.put(0, 1); // no meta prefix codes
  // Channel order of the prefix codes and of each pixel: green, red, blue, alpha; then distance.
  const channels: [number, number][] = [
    [a[1], b[1]],
    [a[0], b[0]],
    [a[2], b[2]],
    [255, 255],
  ];
  const simple = (s0: number, s1: number): void => {
    bits.put(1, 1); // simple code
    if (s0 === s1) {
      bits.put(0, 1); // one symbol: no bits per pixel
      bits.put(1, 1);
      bits.put(s0, 8);
    } else {
      bits.put(1, 1); // two symbols, one bit per pixel (the smaller symbol is code 0)
      bits.put(1, 1);
      bits.put(Math.min(s0, s1), 8);
      bits.put(Math.max(s0, s1), 8);
    }
  };
  for (const [s0, s1] of channels) simple(s0, s1);
  // Distance: one symbol (0), never read since no pixel is a back-reference.
  bits.put(1, 1);
  bits.put(0, 1);
  bits.put(0, 1);
  bits.put(0, 1);
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const which = pick(x, y);
      for (const [s0, s1] of channels) {
        if (s0 === s1) continue;
        const v = which === 0 ? s0 : s1;
        bits.put(v === Math.max(s0, s1) ? 1 : 0, 1);
      }
    }
  }
  const data = bits.bytes();
  const pad = data.length % 2;
  const chunkHead = Buffer.alloc(8);
  chunkHead.write('VP8L', 0, 'ascii');
  chunkHead.writeUInt32LE(data.length, 4);
  const riff = Buffer.alloc(12);
  riff.write('RIFF', 0, 'ascii');
  riff.writeUInt32LE(4 + 8 + data.length + pad, 4);
  riff.write('WEBP', 8, 'ascii');
  return Buffer.concat([riff, chunkHead, data, Buffer.alloc(pad)]);
}
