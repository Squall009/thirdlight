/**
 * Pure digest helpers for the M2 content view — project-model.md §19.1
 * (`contentDigest`) and §18.5 (`recipeDigest` shape reference).
 *
 * The project-model package is the zero-dependency leaf of the node-side
 * graph (dependencies.md §4.1: no project deps, no externals, no Node
 * built-ins), so SHA-256 is implemented here in pure TypeScript. This is
 * the standard FIPS 180-4 algorithm with the usual constants; it operates
 * on `Uint8Array` and never touches the filesystem, a clock or the network.
 *
 * `canonicalJsonText` is commands.md §6.6 rule 2: object keys sorted in
 * codepoint order at every level, no insignificant whitespace, strings
 * JSON-escaped in the shortest form, numbers with JavaScript
 * `JSON.stringify` double semantics.
 */

/** UTF-8 encode without a BOM (the fixtures and canonical bytes are BOM-free). */
export function utf8Encode(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

/** UTF-8 decode; the caller supplies valid UTF-8 for digest inputs. */
export function utf8Decode(bytes: Uint8Array): string {
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
}

const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1,
  0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
  0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786,
  0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147,
  0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
  0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b,
  0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a,
  0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
  0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

function rotr(x: number, n: number): number {
  return (x >>> n) | (x << (32 - n));
}

function sha256Words(bytes: Uint8Array): Uint32Array {
  const bitLen = bytes.length * 8;
  // FIPS 180-4 padding: the message, one 0x80 byte and the 8-byte big-endian
  // bit length, zero-padded to a 64-byte block boundary.
  //
  // PACKET-36 DEFECT REPAIR (P1): the previous expression
  // `(((len + 9) >> 6) + 1) << 6` allocated an EXTRA block whenever
  // `(len + 9) % 64 === 0` (len ≡ 55 mod 64) and wrote the length field at the
  // end of that extra block, so every input of length 55, 119, 183, … produced
  // a WRONG digest (regression test: `sha256-length.test.ts`, cross-checked
  // against node:crypto). The correct block count is ceil((len + 9) / 64).
  const withPad = new Uint8Array((((bytes.length + 8) >> 6) + 1) << 6);
  withPad.set(bytes);
  withPad[bytes.length] = 0x80;
  // 64-bit big-endian bit length (JS safe for the bounded M2 inputs).
  const hi = Math.floor(bitLen / 0x100000000);
  const lo = bitLen >>> 0;
  const dv = new DataView(withPad.buffer);
  dv.setUint32(withPad.length - 8, hi);
  dv.setUint32(withPad.length - 4, lo);

  const H = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c,
    0x1f83d9ab, 0x5be0cd19,
  ]);
  const w = new Uint32Array(64);

  for (let off = 0; off < withPad.length; off += 64) {
    for (let t = 0; t < 16; t++) w[t] = dv.getUint32(off + t * 4);
    for (let t = 16; t < 64; t++) {
      const w15 = w[t - 15] as number;
      const w2 = w[t - 2] as number;
      const s0 = rotr(w15, 7) ^ rotr(w15, 18) ^ (w15 >>> 3);
      const s1 = rotr(w2, 17) ^ rotr(w2, 19) ^ (w2 >>> 10);
      w[t] = ((w[t - 16] as number) + s0 + (w[t - 7] as number) + s1) >>> 0;
    }
    let [a, b, c, d, e, f, g, h] = H as unknown as [
      number, number, number, number, number, number, number, number,
    ];
    for (let t = 0; t < 64; t++) {
      const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const temp1 = (h + S1 + ch + (K[t] as number) + (w[t] as number)) >>> 0;
      const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (S0 + maj) >>> 0;
      h = g;
      g = f;
      f = e;
      e = (d + temp1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (temp1 + temp2) >>> 0;
    }
    H[0] = (H[0] as number) + a;
    H[1] = (H[1] as number) + b;
    H[2] = (H[2] as number) + c;
    H[3] = (H[3] as number) + d;
    H[4] = (H[4] as number) + e;
    H[5] = (H[5] as number) + f;
    H[6] = (H[6] as number) + g;
    H[7] = (H[7] as number) + h;
  }
  return H;
}

const HEX = '0123456789abcdef';

/** SHA-256 of `bytes`, lowercase hex (§18.4/§19.1 digest syntax). */
export function sha256Hex(bytes: Uint8Array): string {
  const words = sha256Words(bytes);
  let out = '';
  for (let i = 0; i < 8; i++) {
    const word = words[i] as number;
    for (let shift = 28; shift >= 0; shift -= 4) {
      out += HEX[(word >>> shift) & 0xf];
    }
  }
  return out;
}

/** {@link sha256Hex} over the UTF-8 bytes of `text`. */
export function sha256HexOfText(text: string): string {
  return sha256Hex(utf8Encode(text));
}

/** Codepoint-order key comparison (not UTF-16 code-unit order). */
function compareCodePoints(a: string, b: string): number {
  const la = a.length;
  const lb = b.length;
  const n = Math.min(la, lb);
  for (let i = 0; i < n; i++) {
    const ca = a.codePointAt(i) as number;
    const cb = b.codePointAt(i) as number;
    if (ca !== cb) return ca < cb ? -1 : 1;
  }
  return la === lb ? 0 : la < lb ? -1 : 1;
}

/**
 * commands.md §6.6 rule 2 canonical JSON text: keys sorted in codepoint order
 * at every level, no insignificant whitespace, shortest JSON string escapes,
 * JavaScript `JSON.stringify` number semantics.
 */
export function canonicalJsonText(value: unknown): string {
  if (value === null) return 'null';
  const t = typeof value;
  if (t === 'number') {
    const n = value as number;
    // Canonical JSON is only defined over JSON-serializable values; -0 is
    // serialized as 0 (§12.2 rule 2).
    return JSON.stringify(n === 0 ? 0 : n);
  }
  if (t === 'boolean') return value === true ? 'true' : 'false';
  if (t === 'string') return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map((v) => canonicalJsonText(v)).join(',')}]`;
  }
  if (t === 'object') {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj).sort(compareCodePoints);
    const parts: string[] = [];
    for (const k of keys) {
      const v = obj[k];
      if (v === undefined) continue;
      parts.push(`${JSON.stringify(k)}:${canonicalJsonText(v)}`);
    }
    return `{${parts.join(',')}}`;
  }
  // Functions/symbols/undefined cannot appear in validated documents.
  return 'null';
}
