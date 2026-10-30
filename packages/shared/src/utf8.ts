/**
 * UTF-8 text and bytes, BOM-free: digests and canonical bytes are taken over
 * exactly these bytes, so a BOM or a lenient decode would change them.
 */

/** UTF-8 encode without a BOM; a lone surrogate becomes U+FFFD. */
export function utf8Encode(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

/** UTF-8 decode that throws on invalid bytes rather than replacing them. */
export function utf8Decode(bytes: Uint8Array): string {
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
}

/**
 * The UTF-8 byte length of a string without encoding it: the length of
 * `utf8Encode(text)`, so a lone surrogate counts as U+FFFD's three bytes.
 */
export function utf8Length(text: string): number {
  let n = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c < 0x80) n += 1;
    else if (c < 0x800) n += 2;
    else if (c >= 0xd800 && c <= 0xdbff && i + 1 < text.length) {
      const d = text.charCodeAt(i + 1);
      if (d >= 0xdc00 && d <= 0xdfff) {
        n += 4;
        i += 1;
      } else n += 3;
    } else n += 3;
  }
  return n;
}

/**
 * The scene document's size count: a high surrogate is taken as a 4-byte
 * pair with the unit after it, whatever that unit is (even past the end).
 * Equal to `utf8Length` on well-formed text; kept so the scene size limit
 * reads malformed text exactly as it always has.
 */
export function utf8LengthPairingAnyHigh(text: string): number {
  let n = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c < 0x80) n += 1;
    else if (c < 0x800) n += 2;
    else if (c >= 0xd800 && c <= 0xdbff) {
      n += 4;
      i += 1;
    } else n += 3;
  }
  return n;
}

/**
 * The save files' size count: a high surrogate with any unit after it is a
 * 4-byte pair; a high surrogate at the very end counts 3. Equal to
 * `utf8Length` on well-formed text; kept so the save size budget reads
 * malformed text exactly as it always has.
 */
export function utf8LengthPairingHigh(text: string): number {
  let n = 0;
  for (let i = 0; i < text.length; i += 1) {
    const c = text.charCodeAt(i);
    if (c < 0x80) n += 1;
    else if (c < 0x800) n += 2;
    else if (c >= 0xd800 && c <= 0xdbff && i + 1 < text.length) {
      n += 4;
      i += 1;
    } else n += 3;
  }
  return n;
}
