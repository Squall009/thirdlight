/**
 * What a clipped decal's mesh is kept by between clips: a key made of every
 * input the clipper reads, and the mesh as bytes.
 *
 * A clipped decal stores its projector, not its triangles; the renderer
 * clips it whenever its receivers change (a block chunk re-meshed, an
 * architecture chunk made again, a model reimported). The key hashes the
 * projector's box and fades, each receiver's geometry and its place relative
 * to the decal, and {@link DECAL_CLIP_VERSION}, so equal inputs find the
 * mesh made before (in the page's memory, or an exported game's IndexedDB
 * on a second visit) and changed ones never find a stale mesh.
 *
 * Receivers are placed relative to the decal's rigid frame (its position and
 * rotation, without its scale): a decal and the surface it marks moving
 * together keep their key, so a mark on a moving platform is never clipped
 * again for the motion. The numbers in the key are float32 bits, the same
 * numbers the clipper is given, so the key names exactly what is made.
 *
 * Pure: no three.js, no I/O.
 */
import { hashText64 } from './arch-math';
import { DECAL_CLIP_VERSION, decalClipSettings, type DecalClipMesh } from './decal-clip';

/** Two 32-bit lanes over a run of 32-bit words (cyrb53's mixing, as `hashText64` does for text). */
class WordHash {
  private h1 = 0xdeadbeef;
  private h2 = 0x41c6ce57;
  words(w: Uint32Array | Uint16Array | Uint8Array): void {
    let h1 = this.h1;
    let h2 = this.h2;
    for (let i = 0; i < w.length; i++) {
      const v = w[i]!;
      h1 = Math.imul(h1 ^ v, 2654435761);
      h2 = Math.imul(h2 ^ v, 1597334677);
    }
    this.h1 = h1;
    this.h2 = h2;
  }
  word(v: number): void {
    this.h1 = Math.imul(this.h1 ^ v, 2654435761);
    this.h2 = Math.imul(this.h2 ^ v, 1597334677);
  }
  digest(): string {
    let h1 = this.h1;
    let h2 = this.h2;
    h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
    h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
    return (h1 >>> 0).toString(16).padStart(8, '0') + (h2 >>> 0).toString(16).padStart(8, '0');
  }
}

const bitsOf = (a: Float32Array): Uint32Array => new Uint32Array(a.buffer, a.byteOffset, a.length);

/**
 * A receiver's geometry as the clipper reads it: its positions, normals (null:
 * none) and index (null: none), by value. Equal arrays hash equal wherever
 * they come from (two chunks of the same shape share their meshes' clips).
 */
export function decalClipGeometryHash(positions: Float32Array, normals: Float32Array | null, index: Uint16Array | Uint32Array | null): string {
  const h = new WordHash();
  h.word(positions.length);
  h.words(bitsOf(positions));
  h.word(normals === null ? 0 : normals.length);
  if (normals !== null) h.words(bitsOf(normals));
  h.word(index === null ? 0 : index.length);
  if (index !== null) h.words(index);
  return h.digest();
}

/** A receiver in a clip's key: its geometry's hash and its matrix relative to the decal's frame (16 float32 numbers). */
export interface DecalClipKeyReceiver {
  readonly geometry: string;
  readonly matrix: ArrayLike<number>;
}

/** The projector's part of a clip's key: what the clipper reads of the component and the decal's scale. */
export interface DecalClipKeyProjector {
  /** The projector matrix the clipper is given (the decal's scale alone, its frame being the receivers'). */
  readonly matrix: ArrayLike<number>;
  readonly size: readonly number[];
  readonly normalFade?: number | undefined;
  readonly edgeFade?: readonly number[] | undefined;
  readonly rect?: readonly number[] | undefined;
  readonly lift?: number | undefined;
}

const f32 = new Float32Array(1);
const u32 = new Uint32Array(f32.buffer);
const bits = (v: number | undefined): string => {
  if (v === undefined) return '-';
  f32[0] = v;
  return u32[0]!.toString(36);
};

/**
 * The key of one clip: the clipper's version, the projector and the
 * receivers in the order the clipper takes them. The caller passes the
 * receivers sorted ({@link sortDecalClipReceivers}) so the same surfaces
 * found in another order make the same key and the same mesh.
 */
export function decalClipKey(projector: DecalClipKeyProjector, receivers: readonly DecalClipKeyReceiver[]): string {
  const parts: string[] = [`v${DECAL_CLIP_VERSION}`];
  const nums = (a: ArrayLike<number> | readonly number[] | undefined, n: number): void => {
    for (let k = 0; k < n; k++) parts.push(bits(a?.[k]));
  };
  nums(projector.matrix, 16);
  nums(projector.size, 3);
  // The values the clipper uses, not the fields as given: a default or a limit that changes changes the key.
  const c = decalClipSettings(projector);
  parts.push(bits(c.normalFade), c.allFacings ? 'all' : '', bits(c.fullMarkShare));
  nums(c.edgeFade, 2);
  nums(c.rect, 4);
  parts.push(bits(c.lift));
  for (const r of receivers) {
    parts.push(`|${r.geometry}`);
    nums(r.matrix, 16);
  }
  return `${DECAL_CLIP_VERSION}-${hashText64(parts.join(','))}${hashText64(parts.join(';'))}`;
}

/** The order receivers go to the clipper and into the key: by geometry, then by matrix (the clip is the same for any order found). */
export function sortDecalClipReceivers<T extends DecalClipKeyReceiver>(list: T[]): T[] {
  const tag = (r: T): string => `${r.geometry}:${Array.from({ length: 16 }, (_, k) => bits(r.matrix[k])).join(',')}`;
  const tags = new Map(list.map((r) => [r, tag(r)]));
  return list.sort((a, b) => (tags.get(a)! < tags.get(b)! ? -1 : tags.get(a)! > tags.get(b)! ? 1 : 0));
}

/** "TLDC" little-endian: a clipped decal mesh's bytes. */
const MAGIC = 0x43444c54;

/** A clipped mesh as bytes (what an exported game keeps between visits): a header, then each array as made. */
export function encodeDecalClipMesh(m: DecalClipMesh): Uint8Array {
  const vc = m.positions.length / 3;
  const wide = m.index instanceof Uint32Array ? 1 : 0;
  const floats = m.positions.length + m.normals.length + m.uvs.length + m.tangents.length + m.fades.length;
  const head = 5 * 4;
  const indexBytes = m.index.length * (wide === 1 ? 4 : 2);
  const out = new Uint8Array(head + floats * 4 + indexBytes + ((4 - (indexBytes % 4)) % 4));
  const dv = new DataView(out.buffer);
  dv.setUint32(0, MAGIC, true);
  dv.setUint32(4, DECAL_CLIP_VERSION, true);
  dv.setUint32(8, vc, true);
  dv.setUint32(12, m.index.length, true);
  dv.setUint32(16, wide, true);
  let o = head;
  for (const a of [m.positions, m.normals, m.uvs, m.tangents, m.fades]) {
    out.set(new Uint8Array(a.buffer, a.byteOffset, a.byteLength), o);
    o += a.byteLength;
  }
  out.set(new Uint8Array(m.index.buffer, m.index.byteOffset, m.index.byteLength), o);
  return out;
}

/** The mesh back from {@link encodeDecalClipMesh}'s bytes (null: not such bytes, or another clipper version's). */
export function decodeDecalClipMesh(bytes: Uint8Array): DecalClipMesh | null {
  if (bytes.byteLength < 20) return null;
  const copy = bytes.byteOffset % 4 === 0 ? bytes : bytes.slice();
  const dv = new DataView(copy.buffer, copy.byteOffset, copy.byteLength);
  if (dv.getUint32(0, true) !== MAGIC || dv.getUint32(4, true) !== DECAL_CLIP_VERSION) return null;
  const vc = dv.getUint32(8, true);
  const ic = dv.getUint32(12, true);
  const wide = dv.getUint32(16, true) === 1;
  const need = 20 + vc * (3 + 3 + 2 + 4 + 1) * 4 + ic * (wide ? 4 : 2);
  if (copy.byteLength < need) return null;
  let o = copy.byteOffset + 20;
  const take = (n: number): Float32Array => {
    const a = new Float32Array(copy.buffer.slice(o, o + n * 4));
    o += n * 4;
    return a;
  };
  const positions = take(vc * 3);
  const normals = take(vc * 3);
  const uvs = take(vc * 2);
  const tangents = take(vc * 4);
  const fades = take(vc);
  const index = wide ? new Uint32Array(copy.buffer.slice(o, o + ic * 4)) : new Uint16Array(copy.buffer.slice(o, o + ic * 2));
  return { positions, normals, uvs, tangents, fades, index, stats: { triangles: 0, faded: 0, degenerate: 0 } };
}

/** Bytes a clipped mesh holds (a cache's measure). */
export function decalClipMeshBytes(m: DecalClipMesh): number {
  return m.positions.byteLength + m.normals.byteLength + m.uvs.byteLength + m.tangents.byteLength + m.fades.byteLength + m.index.byteLength + 64;
}
