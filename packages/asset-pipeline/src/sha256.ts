/**
 * Pure digest helpers for the bounded GLB importer.
 *
 * Why this package carries its own SHA-256 and canonical-JSON text:
 * `asset-pipeline` is a pure leaf whose only allowed edge is
 * `@thirdlight/project-model` **types** (`dependencies.md` §4.1/§4.3: "bytes
 * in, proposal out"; no Node built-ins, no I/O, no `three`). A value import
 * of the model's own digest helpers is therefore not available, and the
 * proposal must still be byte-deterministic (`project-model.md` §18.8.3:
 * the source digest and the recipe digest feed the derived-cache key), so the
 * FIPS 180-4 compression function is implemented here over `Uint8Array`.
 *
 * `canonicalJsonText` is commands.md §6.6 rule 2 (the same definition the
 * model package uses for `contentDigest`): object keys sorted in codepoint
 * order at every level, no insignificant whitespace, shortest JSON string
 * escapes, JavaScript `JSON.stringify` number semantics.
 *
 * Nothing here reads a clock, a locale, an environment variable or the
 * network: same input → same digest, always.
 */

/** UTF-8 encode without a BOM. */
export function utf8Encode(text: string): Uint8Array {
  return new TextEncoder().encode(text);
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

/**
 * One 64-byte block of the SHA-256 compression function, in place on `h`.
 * `W` is the caller's scratch schedule — no module-level mutable state
 * (dependencies.md §4.3).
 */
function block(src: Uint8Array, off: number, h: Uint32Array, W: Uint32Array): void {
  for (let t = 0; t < 16; t++) {
    const p = off + t * 4;
    W[t] =
      (((src[p] as number) << 24) |
        ((src[p + 1] as number) << 16) |
        ((src[p + 2] as number) << 8) |
        (src[p + 3] as number)) >>>
      0;
  }
  for (let t = 16; t < 64; t++) {
    const w15 = W[t - 15] as number;
    const w2 = W[t - 2] as number;
    const s0 = rotr(w15, 7) ^ rotr(w15, 18) ^ (w15 >>> 3);
    const s1 = rotr(w2, 17) ^ rotr(w2, 19) ^ (w2 >>> 10);
    W[t] = ((W[t - 16] as number) + s0 + (W[t - 7] as number) + s1) >>> 0;
  }
  let a = h[0] as number;
  let b = h[1] as number;
  let c = h[2] as number;
  let d = h[3] as number;
  let e = h[4] as number;
  let f = h[5] as number;
  let g = h[6] as number;
  let hh = h[7] as number;
  for (let t = 0; t < 64; t++) {
    const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
    const ch = (e & f) ^ (~e & g);
    const temp1 = (hh + S1 + ch + (K[t] as number) + (W[t] as number)) >>> 0;
    const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
    const maj = (a & b) ^ (a & c) ^ (b & c);
    const temp2 = (S0 + maj) >>> 0;
    hh = g;
    g = f;
    f = e;
    e = (d + temp1) >>> 0;
    d = c;
    c = b;
    b = a;
    a = (temp1 + temp2) >>> 0;
  }
  h[0] = ((h[0] as number) + a) >>> 0;
  h[1] = ((h[1] as number) + b) >>> 0;
  h[2] = ((h[2] as number) + c) >>> 0;
  h[3] = ((h[3] as number) + d) >>> 0;
  h[4] = ((h[4] as number) + e) >>> 0;
  h[5] = ((h[5] as number) + f) >>> 0;
  h[6] = ((h[6] as number) + g) >>> 0;
  h[7] = ((h[7] as number) + hh) >>> 0;
}

const HEX = '0123456789abcdef';

/** SHA-256 of `bytes`, lowercase hex (project-model §18.4/§19.1 syntax). */
export function sha256Hex(bytes: Uint8Array): string {
  const h = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c,
    0x1f83d9ab, 0x5be0cd19,
  ]);
  const W = new Uint32Array(64);
  const n = bytes.length;
  const fullBlocks = Math.floor(n / 64);
  for (let b = 0; b < fullBlocks; b++) block(bytes, b * 64, h, W);

  const rem = n - fullBlocks * 64;
  const tailBlocks = rem < 56 ? 1 : 2;
  const tail = new Uint8Array(tailBlocks * 64);
  tail.set(bytes.subarray(fullBlocks * 64, n));
  tail[rem] = 0x80;
  const bitLen = n * 8;
  const dv = new DataView(tail.buffer);
  dv.setUint32(tail.length - 8, Math.floor(bitLen / 0x100000000));
  dv.setUint32(tail.length - 4, bitLen >>> 0);
  for (let b = 0; b < tailBlocks; b++) block(tail, b * 64, h, W);

  let out = '';
  for (let i = 0; i < 8; i++) {
    const word = h[i] as number;
    for (let shift = 28; shift >= 0; shift -= 4) out += HEX[(word >>> shift) & 0xf];
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
 * at every level, no insignificant whitespace, JavaScript `JSON.stringify`
 * number semantics, `-0` serialized as `0`.
 */
export function canonicalJsonText(value: unknown): string {
  if (value === null) return 'null';
  const t = typeof value;
  if (t === 'number') {
    const n = value as number;
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
  return 'null';
}
