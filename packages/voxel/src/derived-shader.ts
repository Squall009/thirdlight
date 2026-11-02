/**
 * Shader data: the per-chunk grid the surface shader blends materials and
 * wetness from. Material and wetness feed only this output (record.ts,
 * FIELD_FEEDS), so a change of only those fields re-derives this and
 * leaves the mesh, collision, navigation and light as they are.
 *
 * Each cell holds an id into a small palette of (material, wetness)
 * entries, packed at the palette's width (0, 1, 2, 4, 8 or 16 bits, 32 /
 * width ids a word, cell i at word i / (32 / width), least significant
 * first), so the GPU reads a cell with one load, a shift and a mask. Air is
 * entry value 0. A chunk of one entry stores no ids. It reads only the
 * chunk's own cells: no apron.
 */
import type { ChunkGrid } from './coords';
import type { DenseChunk } from './dense-chunk';
import { packedWidth } from './packed-width';
import { MATERIAL_BITS, valueMaterial, valueWetness } from './record';

/** A shader palette entry: material in the low bits, wetness above it. */
export function shaderEntry(material: number, wetness: number): number {
  return material === 0 ? 0 : material | (wetness << MATERIAL_BITS);
}

export interface ShaderOut {
  /** Entries: material | wetness << 12 ({@link shaderEntry}); air is 0. */
  readonly palette: Uint16Array;
  /** Bits per cell id (0 when the palette has one entry). */
  readonly width: number;
  /** Cell ids, packed (local index order); empty when width is 0. */
  readonly ids: Uint32Array;
}

const seen = new Map<number, number>();

/** The shader data of a chunk's cells (null: all air). */
export function shaderDataOf(grid: ChunkGrid, chunk: DenseChunk | null): ShaderOut {
  if (chunk === null) return shaderDataBy(grid.cellsPerChunk, () => 0);
  return shaderDataBy(grid.cellsPerChunk, (i) => shaderEntry(chunk.material[i]!, chunk.wetness[i]!));
}

/** The shader data of a chunk of `cells` cells whose cell `i` holds the voxel value `valueAt(i)` (local index order). */
export function shaderDataOfValues(cells: number, valueAt: (i: number) => number): ShaderOut {
  return shaderDataBy(cells, (i) => {
    const v = valueAt(i);
    return shaderEntry(valueMaterial(v), valueWetness(v));
  });
}

function shaderDataBy(n: number, entryAt: (i: number) => number): ShaderOut {
  seen.clear();
  const entries: number[] = [];
  const cellIds = new Uint16Array(n);
  let prev = -1;
  let prevId = 0;
  for (let i = 0; i < n; i++) {
    const v = entryAt(i);
    if (v !== prev) {
      let id = seen.get(v);
      if (id === undefined) {
        id = entries.length;
        entries.push(v);
        seen.set(v, id);
      }
      prev = v;
      prevId = id;
    }
    cellIds[i] = prevId;
  }
  const width = packedWidth(entries.length);
  const ids = new Uint32Array(width === 0 ? 0 : (n * width) >>> 5);
  if (width > 0) {
    for (let i = 0; i < n; i++) {
      const bit = i * width;
      ids[bit >>> 5]! |= cellIds[i]! << (bit & 31);
    }
  }
  return { palette: Uint16Array.from(entries), width, ids };
}

/** The entry of cell `i` (local index). */
export function shaderEntryAt(s: ShaderOut, i: number): number {
  if (s.width === 0) return s.palette[0]!;
  const bit = i * s.width;
  return s.palette[(s.ids[bit >>> 5]! >>> (bit & 31)) & ((1 << s.width) - 1)]!;
}

/** Bytes the shader data holds. */
export function shaderBytes(s: ShaderOut): number {
  return s.palette.byteLength + s.ids.byteLength;
}

/** Canonical bytes of shader data (width, entry count, palette, ids; little-endian), to compare and hash results; never stored. */
export function encodeShader(s: ShaderOut): Uint8Array {
  const out = new Uint8Array(4 + s.palette.byteLength + s.ids.byteLength);
  const view = new DataView(out.buffer);
  view.setUint16(0, s.width, true);
  view.setUint16(2, s.palette.length - 1, true);
  s.palette.forEach((e, k) => view.setUint16(4 + k * 2, e, true));
  s.ids.forEach((w, k) => view.setUint32(4 + s.palette.byteLength + k * 4, w, true));
  return out;
}
