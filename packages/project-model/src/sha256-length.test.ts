/**
 * Packet 36 — the SHA-256 padding regression test (bounded defect repair).
 *
 * `packages/project-model/src/sha256.ts` padded the message with
 * `(((len + 9) >> 6) + 1) << 6` bytes, which allocates an EXTRA zero block
 * whenever `(len + 9) % 64 === 0` (i.e. `len ≡ 55 (mod 64)`) and then writes
 * the 64-bit bit-length into that extra block — producing a WRONG digest for
 * every such input length. The repair uses `ceil((len + 9) / 64)` blocks.
 *
 * Known-answer vectors below are the correct FIPS 180-4 digests (cross-checked
 * against Node's OpenSSL SHA-256 while repairing; the cross-check itself runs
 * in `tests/integration/m2-export/sha256-cross-check.test.ts`, because this
 * package's allowed edges contain no Node builtins).
 */
import { describe, expect, it } from 'vitest';
import { sha256Hex, sha256HexOfText } from './sha256';

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
  [439, '016386c2d91f7432a95b96821a0c6e9f2afc7379d8ba4cd499a74ec93d6633d4'],
  [823, 'd073b58a3fd0af60368acb441852e6f33f1637dee1999862cad643573c9f20e5'],
  [2007, '0fbe417c66ba33b5ce353f9f28db6d47c6b1361830a2229cf28db5f0d3efb05f'],
  [4103, '43a57c40e8f884f09f62baf8284401c82d592f634321d6dc645343820a8b7bcc'],
];

describe('sha256Hex padding (FIPS 180-4)', () => {
  it('matches the NIST vectors', () => {
    expect(sha256HexOfText('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
    expect(sha256HexOfText('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    expect(sha256HexOfText('abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq')).toBe(
      '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1',
    );
    expect(sha256HexOfText('a'.repeat(1000000))).toBe('cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0');
  });

  it('hashes every exact-multiple padding length correctly (the repaired class)', () => {
    for (const [len, expected] of BROKEN_LENGTHS) {
      expect(sha256Hex(pattern(len)), `length ${len}`).toBe(expected);
    }
  });

  it('hashes an all-x text of length 55 correctly (the same class via text)', () => {
    expect(sha256HexOfText('x'.repeat(55))).toBe('d5e285683cd4efc02d021a5c62014694958901005d6f71e89e0989fac77e4072');
  });
});
