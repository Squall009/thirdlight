/**
 * Packet 33 — the `behavior-build` SHA-256 cross-check against Node's OpenSSL
 * implementation (Gate I repair R-I-1, P1).
 *
 * `packages/behavior-build/src/canonical.ts` carried the same
 * `len ≡ 55 (mod 64)` padding defect packet 36 repaired in `project-model`:
 * an extra zero block was allocated whenever `(len + 9) % 64 === 0`, so the
 * wrong digest was recorded for that whole length class. The digest is the
 * identity of every behavior artifact (`sourceDigest`/`manifestDigest`/
 * `outputDigest`), so a silent divergence between the pure implementation and
 * the platform crypto is exactly the failure this suite exists to catch.
 *
 * This lives under `tests/integration/**` because `behavior-build`'s allowed
 * edges contain no Node builtins (dependencies.md §4.1).
 */
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import { sha256Hex, utf8Encode } from '../../../packages/behavior-build/src/canonical';

function nodeSha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function pattern(len: number): Uint8Array {
  const b = new Uint8Array(len);
  for (let i = 0; i < len; i += 1) b[i] = (i * 7 + 3) & 0xff;
  return b;
}

describe('behavior-build sha256 == node:crypto sha256', () => {
  it('agrees for every length 0…320, the named boundaries and the larger cases', () => {
    // The named boundaries from the R-I-1 adjudication: 0/55/56/64/119/120/951.
    for (const len of [0, 55, 56, 64, 119, 120, 951]) {
      const bytes = pattern(len);
      expect(sha256Hex(bytes), `named length ${len}`).toBe(nodeSha256(bytes));
    }
    const lengths: number[] = Array.from({ length: 321 }, (_, i) => i);
    for (const extra of [439, 823, 1000, 2007, 4103, 8199]) lengths.push(extra);
    for (const len of lengths) {
      const bytes = pattern(len);
      expect(sha256Hex(bytes), `length ${len}`).toBe(nodeSha256(bytes));
    }
  });

  it('agrees on the 951-byte canonical container bytes', () => {
    // The R-I-1(b) end-to-end case uses a 951-byte canonical container; pin
    // the cross-check for exactly that length too (the fixture generator in
    // `tests/integration/m2-builds/publication.test.ts` asserts the length).
    const bytes = utf8Encode('p'.repeat(951));
    expect(bytes.length).toBe(951);
    expect(sha256Hex(bytes)).toBe(nodeSha256(bytes));
  });
});
