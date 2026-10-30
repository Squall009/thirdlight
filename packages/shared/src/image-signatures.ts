/**
 * The leading bytes that identify an image container. Importers, the
 * exporter's content scan and the texture tools all sniff files by them.
 */

/** The eight bytes every PNG file starts with. */
export const PNG_SIGNATURE: Readonly<Uint8Array> = Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a);

/** The twelve bytes every KTX2 file starts with («KTX 20»\r\n\x1a\n). */
export const KTX2_IDENTIFIER: Readonly<Uint8Array> = Uint8Array.of(0xab, 0x4b, 0x54, 0x58, 0x20, 0x32, 0x30, 0xbb, 0x0d, 0x0a, 0x1a, 0x0a);

/** Whether `bytes` starts with `signature`. */
export function startsWith(bytes: Uint8Array, signature: Readonly<Uint8Array>): boolean {
  if (bytes.length < signature.length) return false;
  for (let i = 0; i < signature.length; i++) if (bytes[i] !== signature[i]) return false;
  return true;
}

/** Whether `bytes` starts like a PNG file. */
export function isPng(bytes: Uint8Array): boolean {
  return startsWith(bytes, PNG_SIGNATURE);
}

/** Whether `bytes` starts like a KTX2 file. */
export function isKtx2(bytes: Uint8Array): boolean {
  return startsWith(bytes, KTX2_IDENTIFIER);
}
