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
