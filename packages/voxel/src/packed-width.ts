/**
 * Palette id widths: every packed form (whole-chunk bit packing, bricks)
 * stores entry ids at one of these widths, so they share the rule.
 */

/** The largest palette a layout addresses (entry ids are 16-bit). */
export const MAX_PALETTE = 65536;

/**
 * Bits per cell for a palette of `count` entries: 0, 1, 2, 4, 8 or 16. Only
 * powers of two, so a cell never straddles two 32-bit words and a read is
 * one load, a shift and a mask; a 3-entry palette pays 2 bits, a 5-entry
 * palette 4.
 */
export function packedWidth(count: number): number {
  if (count <= 1) return 0;
  if (count <= 2) return 1;
  if (count <= 4) return 2;
  if (count <= 16) return 4;
  if (count <= 256) return 8;
  if (count <= MAX_PALETTE) return 16;
  throw new RangeError(`palette of ${count} entries is past the 16-bit entry ids`);
}
