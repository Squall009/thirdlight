/**
 * EXT_meshopt_compression decoding for the import profile: the importer
 * decodes every compressed bufferView itself, so the data it validates
 * (accessor ranges, animation times, the metrics) is the data the game
 * renders — never an undecoded stream taken on trust.
 *
 * Ported from meshoptimizer's reference decoder (js/meshopt_decoder_reference.js,
 * by Jasper St. Pierre; MIT License, Copyright (C) 2016-2026 Arseny
 * Kapoulkine), restricted to what EXT_meshopt_compression allows (vertex codec
 * version 0, index codec version 1, index sequence version 1; filters NONE,
 * OCTAHEDRAL, QUATERNION, EXPONENTIAL) and made total: a malformed stream is
 * a `MeshoptError`, never an out-of-range read. The output is checked against
 * meshoptimizer's own decoder (fixtures/import-ext/meshopt-vectors.json).
 *
 * Pure: no I/O, no WebAssembly.
 */

export class MeshoptError extends Error {}

export type MeshoptMode = 'ATTRIBUTES' | 'TRIANGLES' | 'INDICES';
export type MeshoptFilter = 'NONE' | 'OCTAHEDRAL' | 'QUATERNION' | 'EXPONENTIAL';

function fail(message: string): never {
  throw new MeshoptError(message);
}

function dezig(v: number): number {
  return (v >>> 1) ^ -(v & 1);
}

/** A bounds-checked byte reader over the compressed stream. */
class Reader {
  constructor(readonly src: Uint8Array, public offs = 0) {}
  byte(at?: number): number {
    const i = at ?? this.offs++;
    if (i < 0 || i >= this.src.length) fail('the compressed stream ends early');
    return this.src[i] as number;
  }
  leb128(): number {
    let n = 0;
    for (let shift = 0; shift < 35; shift += 7) {
      const b = this.byte();
      n |= (b & 0x7f) << shift;
      if (b < 0x80) return n >>> 0;
    }
    fail('a LEB128 value is too long');
  }
}

function decodeVertexBuffer(target: Uint8Array, count: number, stride: number, source: Uint8Array): void {
  if (source[0] !== 0xa0) fail('the vertex stream is not codec version 0 (header 0xa0)');
  if (stride % 4 !== 0 || stride < 4 || stride > 256) fail('the vertex stride must be a multiple of 4 up to 256');
  const tailSize = Math.max(stride, 32);
  if (source.length < 1 + tailSize) fail('the vertex stream is shorter than its tail');
  const maxBlock = Math.min((0x2000 / stride) & ~0x0f, 0x100);
  const deltas = new Uint8Array(maxBlock * stride);
  const temp = source.slice(source.length - stride);
  const r = new Reader(source, 1);
  const modes = [0, 2, 4, 8];
  for (let base = 0; base < count; base += maxBlock) {
    const n = Math.min(count - base, maxBlock);
    const groups = (n + 15) >>> 4;
    const headerBytes = (groups + 3) >>> 2;
    deltas.fill(0);
    for (let byte = 0; byte < stride; byte++) {
      const deltaBase = byte * n;
      const headerOffs = r.offs;
      r.offs += headerBytes;
      for (let group = 0; group < groups; group++) {
        const bits = modes[(r.byte(headerOffs + (group >>> 2)) >>> ((group & 3) << 1)) & 3] as number;
        const at = deltaBase + (group << 4);
        const limit = Math.min(16, n - (group << 4));
        if (bits === 0) continue;
        if (bits === 8) {
          for (let m = 0; m < 16; m++) {
            const v = r.byte();
            if (m < limit) deltas[at + m] = v;
          }
          continue;
        }
        const srcBase = r.offs;
        r.offs += bits * 2;
        for (let m = 0; m < 16; m++) {
          let delta: number;
          if (bits === 2) {
            delta = (r.byte(srcBase + (m >>> 2)) >>> (6 - ((m & 3) << 1))) & 3;
            if (delta === 3) delta = r.byte();
          } else {
            delta = (r.byte(srcBase + (m >>> 1)) >>> (4 - ((m & 1) << 2))) & 0x0f;
            if (delta === 0x0f) delta = r.byte();
          }
          if (m < limit) deltas[at + m] = delta;
        }
      }
    }
    for (let e = 0; e < n; e++) {
      for (let byte = 0; byte < stride; byte++) {
        const v = ((temp[byte] as number) + dezig(deltas[byte * n + e] as number)) & 0xff;
        temp[byte] = v;
        target[(base + e) * stride + byte] = v;
      }
    }
  }
  if (r.offs !== source.length - tailSize) fail('the vertex stream length does not match its content');
}

function applyFilter(target: Uint8Array, count: number, stride: number, filter: MeshoptFilter): void {
  if (filter === 'NONE') return;
  if (filter === 'OCTAHEDRAL') {
    if (stride !== 4 && stride !== 8) fail('the OCTAHEDRAL filter needs a stride of 4 or 8');
    const dst = stride === 4 ? new Int8Array(target.buffer, target.byteOffset, count * 4) : new Int16Array(target.buffer, target.byteOffset, count * 4);
    // As meshoptimizer's C decoder does it: float32 arithmetic, the scale
    // channel folded into z, round half away from zero.
    const f = Math.fround;
    const maxInt = f(stride === 4 ? 127 : 32767);
    const round = (v: number): number => Math.trunc(f(v + (v >= 0 ? 0.5 : -0.5)));
    for (let i = 0; i < count * 4; i += 4) {
      let x = f(dst[i] as number);
      let y = f(dst[i + 1] as number);
      const z = f(f(f(dst[i + 2] as number) - f(Math.abs(x))) - f(Math.abs(y)));
      const t = z >= 0 ? 0 : z;
      x = f(x + (x >= 0 ? t : -t));
      y = f(y + (y >= 0 ? t : -t));
      const l = f(Math.sqrt(f(f(f(x * x) + f(y * y)) + f(z * z))));
      const s = l > 0 ? f(maxInt / l) : 0;
      dst[i] = round(f(x * s));
      dst[i + 1] = round(f(y * s));
      dst[i + 2] = round(f(z * s));
    }
    return;
  }
  if (filter === 'QUATERNION') {
    if (stride !== 8) fail('the QUATERNION filter needs a stride of 8');
    const dst = new Int16Array(target.buffer, target.byteOffset, count * 4);
    // float32 arithmetic and half-away rounding, as the C decoder.
    const f = Math.fround;
    const round = (v: number): number => Math.trunc(f(v + (v >= 0 ? 0.5 : -0.5)));
    const scale = f(1 / f(Math.sqrt(2)));
    for (let i = 0; i < count * 4; i += 4) {
      const inputW = dst[i + 3] as number;
      const maxComponent = inputW & 3;
      const s = f(scale / f(inputW | 3));
      const x = f((dst[i] as number) * s);
      const y = f((dst[i + 1] as number) * s);
      const z = f((dst[i + 2] as number) * s);
      const ww = f(f(f(f(1) - f(x * x)) - f(y * y)) - f(z * z));
      const w = f(Math.sqrt(ww >= 0 ? ww : 0));
      dst[i + ((maxComponent + 1) % 4)] = round(f(x * 32767));
      dst[i + ((maxComponent + 2) % 4)] = round(f(y * 32767));
      dst[i + ((maxComponent + 3) % 4)] = round(f(z * 32767));
      dst[i + maxComponent] = round(f(w * 32767));
    }
    return;
  }
  // EXPONENTIAL
  if (stride % 4 !== 0) fail('the EXPONENTIAL filter needs a stride that is a multiple of 4');
  const words = count * (stride / 4);
  const view = new DataView(target.buffer, target.byteOffset, words * 4);
  const bits = new Uint32Array(1);
  const asFloat = new Float32Array(bits.buffer);
  for (let i = 0; i < words; i++) {
    const v = view.getInt32(i * 4, true);
    const exp = v >> 24;
    const mantissa = (v << 8) >> 8;
    bits[0] = ((exp + 127) << 23) >>> 0;
    view.setFloat32(i * 4, (asFloat[0] as number) * mantissa, true);
  }
}

function writeIndex(target: Uint8Array, stride: number, i: number, v: number): void {
  const view = new DataView(target.buffer, target.byteOffset, target.byteLength);
  if (stride === 2) view.setUint16(i * 2, v & 0xffff, true);
  else view.setUint32(i * 4, v >>> 0, true);
}

function decodeIndexBuffer(target: Uint8Array, count: number, stride: number, source: Uint8Array): void {
  if (source[0] !== 0xe1) fail('the index stream is not codec version 1 (header 0xe1)');
  if (count % 3 !== 0) fail('a triangle index count must be a multiple of 3');
  const triCount = count / 3;
  if (source.length < 1 + triCount + 16) fail('the index stream is shorter than its codes');
  const code = new Reader(source, 1);
  const data = new Reader(source, 1 + triCount);
  const codeaux = source.length - 16;
  const edge = new Uint32Array(32);
  const vert = new Uint32Array(16);
  let edgeOffs = 0;
  let vertOffs = 0;
  const readEdge = (n: number): number => edge[(edgeOffs - 1 - n) & 31] as number;
  const readVert = (n: number): number => vert[(vertOffs - 1 - n) & 15] as number;
  const pushEdge = (v: number): void => {
    edge[edgeOffs] = v;
    edgeOffs = (edgeOffs + 1) & 31;
  };
  const pushVert = (v: number): void => {
    vert[vertOffs] = v;
    vertOffs = (vertOffs + 1) & 15;
  };
  let next = 0;
  let last = 0;
  const decodeIndex = (v: number): number => (last = (last + dezig(v)) >>> 0);
  let out = 0;
  for (let t = 0; t < triCount; t++) {
    if (data.offs > codeaux) fail('the index stream data overruns its end');
    const c0 = code.byte();
    const b0 = c0 >>> 4;
    const b1 = c0 & 0x0f;
    let a: number;
    let b: number;
    let c: number;
    if (b0 < 0x0f) {
      a = readEdge((b0 << 1) + 0);
      b = readEdge((b0 << 1) + 1);
      if (b1 === 0) {
        c = next++;
        pushVert(c);
      } else if (b1 < 0x0d) {
        c = readVert(b1);
      } else if (b1 === 0x0d) {
        c = last = (last - 1) >>> 0;
        pushVert(c);
      } else if (b1 === 0x0e) {
        c = last = (last + 1) >>> 0;
        pushVert(c);
      } else {
        c = decodeIndex(data.leb128());
        pushVert(c);
      }
      pushEdge(b);
      pushEdge(c);
      pushEdge(c);
      pushEdge(a);
    } else {
      if (b1 < 0x0e) {
        const e = code.byte(codeaux + b1);
        const z = e >>> 4;
        const w = e & 0x0f;
        a = next++;
        b = z === 0 ? next++ : readVert(z - 1);
        c = w === 0 ? next++ : readVert(w - 1);
        pushVert(a);
        if (z === 0) pushVert(b);
        if (w === 0) pushVert(c);
      } else {
        const e = data.byte();
        if (e === 0) next = 0;
        const z = e >>> 4;
        const w = e & 0x0f;
        a = b1 === 0x0e ? next++ : decodeIndex(data.leb128());
        b = z === 0 ? next++ : z === 0x0f ? decodeIndex(data.leb128()) : readVert(z - 1);
        c = w === 0 ? next++ : w === 0x0f ? decodeIndex(data.leb128()) : readVert(w - 1);
        pushVert(a);
        if (z === 0 || z === 0x0f) pushVert(b);
        if (w === 0 || w === 0x0f) pushVert(c);
      }
      pushEdge(a);
      pushEdge(b);
      pushEdge(b);
      pushEdge(c);
      pushEdge(c);
      pushEdge(a);
    }
    writeIndex(target, stride, out++, a);
    writeIndex(target, stride, out++, b);
    writeIndex(target, stride, out++, c);
  }
}

function decodeIndexSequence(target: Uint8Array, count: number, stride: number, source: Uint8Array): void {
  if (source[0] !== 0xd1) fail('the index sequence is not codec version 1 (header 0xd1)');
  const r = new Reader(source, 1);
  const last = [0, 0];
  for (let i = 0; i < count; i++) {
    const v = r.leb128();
    const which = v & 1;
    last[which] = ((last[which] as number) + dezig(v >>> 1)) >>> 0;
    writeIndex(target, stride, i, last[which] as number);
  }
}

/**
 * Decode one compressed bufferView into `count * byteStride` bytes. Throws
 * `MeshoptError` for anything the extension does not allow or a stream that
 * does not decode exactly.
 */
export function decodeMeshopt(
  source: Uint8Array,
  count: number,
  byteStride: number,
  mode: MeshoptMode,
  filter: MeshoptFilter = 'NONE',
): Uint8Array {
  if (!Number.isSafeInteger(count) || count < 1) fail('count must be a positive integer');
  const target = new Uint8Array(count * byteStride);
  if (mode === 'ATTRIBUTES') {
    decodeVertexBuffer(target, count, byteStride, source);
    applyFilter(target, count, byteStride, filter);
  } else {
    if (byteStride !== 2 && byteStride !== 4) fail('an index stream needs a stride of 2 or 4');
    if (filter !== 'NONE') fail('filters apply to ATTRIBUTES only');
    if (mode === 'TRIANGLES') decodeIndexBuffer(target, count, byteStride, source);
    else decodeIndexSequence(target, count, byteStride, source);
  }
  return target;
}
