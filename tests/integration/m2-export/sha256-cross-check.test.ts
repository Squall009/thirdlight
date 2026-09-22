/**
 * Packet 36 — the project-model SHA-256 cross-check against Node's OpenSSL
 * implementation, for every length in a window around each 64-byte block
 * boundary (including the `len ≡ 55 (mod 64)` defect class repaired in
 * `packages/project-model/src/sha256.ts`).
 *
 * This lives under `tests/integration/**` because `project-model`'s allowed
 * edges contain no Node builtins (dependencies.md §4.1); the digest is the
 * identity of every M2 artifact, so a silent divergence between the pure
 * implementation and the platform crypto is exactly the failure mode this
 * suite exists to catch.
 */
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { canonicalJsonText, sha256Hex, sha256HexOfText } from '../../../packages/project-model/src/sha256';

function nodeSha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function pattern(len: number): Uint8Array {
  const b = new Uint8Array(len);
  for (let i = 0; i < len; i += 1) b[i] = (i * 7 + 3) & 0xff;
  return b;
}

describe('project-model sha256 == node:crypto sha256', () => {
  it('agrees for every length 0…320 and the larger exact-multiple cases', () => {
    const lengths: number[] = Array.from({ length: 321 }, (_, i) => i);
    for (const extra of [439, 823, 1000, 2007, 4103, 8199]) lengths.push(extra);
    for (const len of lengths) {
      const bytes = pattern(len);
      expect(sha256Hex(bytes), `length ${len}`).toBe(nodeSha256(bytes));
    }
  });

  it('agrees on canonical JSON documents of the defect-class lengths', () => {
    // A canonical document whose UTF-8 length is exactly 55 / 119 / 823 bytes.
    const pad = (n: number): string => {
      let s = canonicalJsonText({ pad: '' });
      while (new TextEncoder().encode(s).length < n) {
        const inner = JSON.parse(s) as { pad: string };
        inner.pad += 'a';
        s = canonicalJsonText(inner);
      }
      return s;
    };
    for (const len of [55, 119, 823]) {
      const text = pad(len);
      expect(new TextEncoder().encode(text).length).toBe(len);
      expect(sha256HexOfText(text), `canonical ${len}`).toBe(nodeSha256(new TextEncoder().encode(text)));
    }
  });
});
