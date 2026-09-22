/**
 * Packet 33 — the `behavior-build` SHA-256 padding known-answer regression
 * (Gate I repair R-I-1, P1).
 *
 * `packages/behavior-build/src/canonical.ts` padded with
 * `(((len + 9) >> 6) + 1) << 6`, which allocates an EXTRA zero block whenever
 * `(len + 9) % 64 === 0` (i.e. `len ≡ 55 (mod 64)`) and then writes the 64-bit
 * bit-length into that extra block — producing a WRONG digest for every such
 * input length. This is the same defect packet 36 repaired in
 * `packages/project-model/src/sha256.ts`. The repair uses
 * `ceil((len + 9) / 64)` blocks.
 *
 * Known-answer vectors below are the correct FIPS 180-4 digests (cross-checked
 * against Node's OpenSSL SHA-256 while repairing; the live cross-check runs in
 * `tests/integration/m2-builds/canonical-cross-check.test.ts`, because this
 * package's allowed edges contain no Node builtins — dependencies.md §4.1).
 */
import { describe, expect, it } from 'vitest';

import { sha256Hex, sha256HexOfText } from '../../packages/behavior-build/src/canonical';

/** The regression input: `bytes[i] = (i * 7 + 3) & 0xff`. */
function pattern(len: number): Uint8Array {
  const b = new Uint8Array(len);
  for (let i = 0; i < len; i += 1) b[i] = (i * 7 + 3) & 0xff;
  return b;
}

/** `len ≡ 55 (mod 64)` — the exact-multiple padding class that was broken. */
const BROKEN_LENGTHS: ReadonlyArray<[number, string]> = [
  [55, 'e7313d333c272e639f790978283f9eb392e843d0f29b7016828bb1daa4aac70b'],
  [119, '9ce7368e4daf32341631b492e80359dc9f594b48453cd0dd5bf0b19279cc177e'],
  [183, '80e7b84a99c797730865825b4614ead40b157674e54de7f6b07361f10317b866'],
  [247, '47446187d9c5d3961b50b31e131abd3b3af031de4bd57283c6d09658f9fa8b15'],
  [951, 'c4af940ff44bd23c45180c5f329aad6e1be0ef02b2884abd43ef7a82d5b86667'],
];

describe('behavior-build sha256Hex padding (FIPS 180-4)', () => {
  it('matches the NIST vectors', () => {
    expect(sha256HexOfText('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
    expect(sha256HexOfText('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    expect(sha256HexOfText('abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq')).toBe(
      '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1',
    );
    expect(sha256HexOfText('a'.repeat(1000000))).toBe('cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0');
  });

  it('hashes the exact-multiple padding class correctly (the repaired class)', () => {
    for (const [len, expected] of BROKEN_LENGTHS) {
      expect(sha256Hex(pattern(len)), `length ${len}`).toBe(expected);
    }
  });

  it('hashes the plain boundary lengths correctly', () => {
    expect(sha256Hex(pattern(0))).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
    expect(sha256Hex(pattern(56))).toBe('4324d65f3c103567f5589c710bc08f8523f929a9272e3af36fc968e52abc6c27');
    expect(sha256Hex(pattern(64))).toBe('39e3d7b6b5d075d37d053ad89b24b41bef4f3c29760c84447cab3f3be1882241');
    expect(sha256Hex(pattern(120))).toBe('7836b787757e95e58b3ca5aec90b1b004e8deba1e50e9675af9cabf1a13a04b5');
  });

  it('hashes an all-x text of length 55 correctly (the same class via text)', () => {
    expect(sha256HexOfText('x'.repeat(55))).toBe('d5e285683cd4efc02d021a5c62014694958901005d6f71e89e0989fac77e4072');
  });
});
