/**
 * The blob of generated architecture (`TLAR`): every chunk's meshes and
 * kit copies, as an export ships them when the project asks to ship meshes
 * instead of generating them at load (`architecture_ship_meshes`), and as
 * the page keeps them in its IndexedDB cache. The same generator made
 * them, so a game reading the blob draws what it would have generated.
 *
 * Pure.
 */
import type { ArchitectureChunk, ArchitectureChunkMesh, ArchitectureCopySet } from './arch-generate';
import type { ArchMeshArrays } from './arch-mesh';
import { hasBinaryMagic, readBinaryBlob, wrapBinaryBlob } from './binary-container';
import { utf8Decode, utf8Encode } from './sha256';

/** The first bytes of a generated-architecture blob ("TLAR"). */
export const ARCHITECTURE_BLOB_MAGIC = Object.freeze([0x54, 0x4c, 0x41, 0x52]);
/** The payload layout this engine writes and reads. */
export const ARCHITECTURE_BLOB_LAYOUT = 1;

class Writer {
  private buf = new Uint8Array(1024);
  private dv = new DataView(this.buf.buffer);
  o = 0;
  private need(n: number): void {
    if (this.o + n <= this.buf.length) return;
    const b = new Uint8Array(Math.max(this.buf.length * 2, this.o + n));
    b.set(this.buf);
    this.buf = b;
    this.dv = new DataView(b.buffer);
  }
  u32(v: number): void {
    this.need(4);
    this.dv.setUint32(this.o, v >>> 0, true);
    this.o += 4;
  }
  i32(v: number): void {
    this.need(4);
    this.dv.setInt32(this.o, v, true);
    this.o += 4;
  }
  str(s: string): void {
    const b = utf8Encode(s);
    this.u32(b.length);
    this.need(b.length);
    this.buf.set(b, this.o);
    this.o += b.length;
  }
  array(a: Float32Array | Uint32Array): void {
    this.u32(a.length);
    this.need(a.length * 4);
    for (let i = 0; i < a.length; i++) {
      if (a instanceof Float32Array) this.dv.setFloat32(this.o + i * 4, a[i]!, true);
      else this.dv.setUint32(this.o + i * 4, a[i]!, true);
    }
    this.o += a.length * 4;
  }
  bytes8(a: Uint8Array): void {
    this.u32(a.length);
    this.need(a.length);
    this.buf.set(a, this.o);
    this.o += a.length;
  }
  bytes(): Uint8Array {
    return this.buf.slice(0, this.o);
  }
}

class Reader {
  private readonly dv: DataView;
  o = 0;
  constructor(private readonly b: Uint8Array) {
    this.dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  }
  private need(n: number): void {
    if (this.o + n > this.b.byteLength) throw new Error('architecture binary: cut short');
  }
  u32(): number {
    this.need(4);
    const v = this.dv.getUint32(this.o, true);
    this.o += 4;
    return v;
  }
  i32(): number {
    this.need(4);
    const v = this.dv.getInt32(this.o, true);
    this.o += 4;
    return v;
  }
  str(): string {
    const n = this.u32();
    this.need(n);
    const s = utf8Decode(this.b.subarray(this.o, this.o + n));
    this.o += n;
    return s;
  }
  bytes8(): Uint8Array {
    const n = this.u32();
    this.need(n);
    const out = this.b.slice(this.o, this.o + n);
    this.o += n;
    return out;
  }
  floats(): Float32Array {
    const n = this.u32();
    this.need(n * 4);
    const out = new Float32Array(n);
    for (let i = 0; i < n; i++) out[i] = this.dv.getFloat32(this.o + i * 4, true);
    this.o += n * 4;
    return out;
  }
  uints(limit: number): Uint32Array {
    const n = this.u32();
    this.need(n * 4);
    const out = new Uint32Array(n);
    for (let i = 0; i < n; i++) {
      const v = this.dv.getUint32(this.o + i * 4, true);
      if (v >= limit) throw new Error('architecture binary: an index past the vertices');
      out[i] = v;
    }
    this.o += n * 4;
    return out;
  }
}

/** Chunks into a blob (uncompressed: floats and indices). */
export function encodeArchitectureChunks(chunks: readonly ArchitectureChunk[]): Uint8Array {
  const w = new Writer();
  w.u32(ARCHITECTURE_BLOB_LAYOUT);
  w.u32(chunks.length);
  for (const c of chunks) {
    w.i32(c.cx);
    w.i32(c.cz);
    w.u32(c.meshes.length);
    for (const m of c.meshes) {
      w.str(m.material);
      w.array(m.mesh.positions);
      w.array(m.mesh.normals);
      w.array(m.mesh.uvs);
      w.bytes8(m.mesh.colors);
      w.array(m.mesh.indices);
      w.array(m.mesh.farIndices);
    }
    w.u32(c.copies.length);
    for (const s of c.copies) {
      w.str(s.model.assetId);
      w.str(s.model.piece ?? '');
      w.u32(s.collide ? 1 : 0);
      w.u32(s.ids.length);
      for (const id of s.ids) w.str(id);
      w.array(s.transforms);
    }
    w.u32(c.problems.length);
    for (const p of c.problems) w.str(p);
  }
  const payload = w.bytes();
  return wrapBinaryBlob(ARCHITECTURE_BLOB_MAGIC, 'none', payload.length, payload);
}

/** A blob's chunks (throws a short message when it is not one). */
export function decodeArchitectureChunks(blob: Uint8Array): ArchitectureChunk[] {
  const h = readBinaryBlob(blob, ARCHITECTURE_BLOB_MAGIC, 'architecture');
  if (h.compression !== 'none') throw new Error('architecture binary: stored uncompressed');
  const r = new Reader(h.stored);
  const layout = r.u32();
  if (layout !== ARCHITECTURE_BLOB_LAYOUT) throw new Error(`architecture binary: layout ${layout} is not one this engine reads`);
  const out: ArchitectureChunk[] = [];
  const n = r.u32();
  for (let k = 0; k < n; k++) {
    const cx = r.i32();
    const cz = r.i32();
    const meshes: ArchitectureChunkMesh[] = [];
    const mc = r.u32();
    for (let m = 0; m < mc; m++) {
      const material = r.str();
      const positions = r.floats();
      const normals = r.floats();
      const uvs = r.floats();
      const colors = r.bytes8();
      const indices = r.uints(positions.length / 3);
      const farIndices = r.uints(positions.length / 3);
      const mesh: ArchMeshArrays = { positions, normals, uvs, colors, indices, farIndices };
      meshes.push({ material, mesh });
    }
    const copies: ArchitectureCopySet[] = [];
    const cc = r.u32();
    for (let q = 0; q < cc; q++) {
      const assetId = r.str();
      const piece = r.str();
      const collide = r.u32() === 1;
      const ids: string[] = [];
      const ic = r.u32();
      for (let i = 0; i < ic; i++) ids.push(r.str());
      copies.push({ model: { assetId, ...(piece !== '' ? { piece } : {}) }, collide, ids, transforms: r.floats() });
    }
    const problems: string[] = [];
    const pc = r.u32();
    for (let i = 0; i < pc; i++) problems.push(r.str());
    out.push({ cx, cz, meshes, copies, problems });
  }
  return out;
}

/** Whether bytes are a generated-architecture blob (its first bytes suffice). */
export function isArchitectureBlob(bytes: Uint8Array): boolean {
  return hasBinaryMagic(bytes, ARCHITECTURE_BLOB_MAGIC);
}
