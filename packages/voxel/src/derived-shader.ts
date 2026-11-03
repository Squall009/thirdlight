/**
 * Shader data: the per-chunk grid the surface shader blends materials and
 * wetness from. Material and wetness feed only this output (record.ts,
 * FIELD_FEEDS), so a change of only those fields re-derives this and
 * leaves the mesh, collision, navigation and light as they are; meshes
 * carry no material at all (derived-mesh.ts).
 *
 * The grid covers the chunk and a border of {@link SHADER_BORDER_CELLS}
 * around it (side = edge + 2 · border, 34 at 32³), so a pixel near a chunk
 * face blends with the neighbour's cells from its own chunk's grid and no
 * seam shows where two chunks meet. The border makes a chunk's shader data
 * depend on its neighbours' cells within that distance: a material or
 * wetness change re-derives the shader data of every chunk within the
 * border of the changed cells, and nothing else.
 *
 * Cells are in the grid's local order (x · side + z) · side + y, y fastest,
 * grid cell g at chunk cell g − border. Each holds an id into a small
 * palette of (material, wetness) entries, packed at the palette's width
 * (0, 1, 2, 4, 8 or 16 bits, 32 / width ids a word, cell i at word
 * i / (32 / width), least significant first). Air is entry value 0. A grid
 * of one entry stores no ids. The packed form is what the derived result
 * keeps; a renderer expands it to one u16 entry a cell
 * ({@link shaderGridEntries}) when it uploads the grid.
 */
import type { Neighbourhood } from './assembly';
import { packedWidth } from './packed-width';
import { MATERIAL_BITS, valueMaterial, valueWetness } from './record';

/** Cells of neighbouring chunks the shader data holds around its chunk, on every side. */
export const SHADER_BORDER_CELLS = 1;

/**
 * How far into a surface (level-0 cells, along its normal) the surface
 * shader reads the grid, so a face between a solid and an air cell reads
 * the solid one. A length in metres, the same at every level of the chunk
 * tree: read a fraction of a coarse cell deep instead, a coarse level would
 * show what lies under a surface layer thinner than its cells.
 */
export const SHADER_READ_DEPTH_CELLS = 0.25;

/** Cells along a side of a chunk's shader grid. */
export function shaderGridSide(edge: number): number {
  return edge + 2 * SHADER_BORDER_CELLS;
}

/** A shader palette entry: material in the low bits, wetness above it. */
export function shaderEntry(material: number, wetness: number): number {
  return material === 0 ? 0 : material | (wetness << MATERIAL_BITS);
}

export interface ShaderOut {
  /** Cells along the grid's side (the chunk edge plus the border on both sides). */
  readonly side: number;
  /** Entries: material | wetness << 12 ({@link shaderEntry}); air is 0. */
  readonly palette: Uint16Array;
  /** Bits per cell id (0 when the palette has one entry). */
  readonly width: number;
  /** Cell ids, packed (grid order); empty when width is 0. */
  readonly ids: Uint32Array;
}

const seen = new Map<number, number>();
let cellScratch = new Uint16Array(0);

/**
 * The shader data of a neighbourhood's chunk and its border (the
 * neighbourhood's pad must reach the border).
 */
export function shaderOfNeighbourhood(n: Neighbourhood): ShaderOut {
  const b = SHADER_BORDER_CELLS;
  if (n.pad < b) throw new RangeError(`shader data: a pad of ${n.pad} does not reach the ${b}-cell border`);
  const side = shaderGridSide(n.edge);
  const o = n.pad - b;
  const s = n.side;
  const cells = side * side * side;
  if (cellScratch.length < cells) cellScratch = new Uint16Array(cells);
  const cellIds = cellScratch;
  seen.clear();
  const entries: number[] = [];
  let prev = -1;
  let prevId = 0;
  let i = 0;
  for (let x = 0; x < side; x++) for (let z = 0; z < side; z++) {
    const row = ((x + o) * s + (z + o)) * s + o;
    for (let y = 0; y < side; y++, i++) {
      const v = n.values[row + y]!;
      // Runs of one value along y are common (ground, air): the palette lookup is skipped for them.
      if (v !== prev) {
        const e = shaderEntry(valueMaterial(v), valueWetness(v));
        let id = seen.get(e);
        if (id === undefined) {
          id = entries.length;
          entries.push(e);
          seen.set(e, id);
        }
        prev = v;
        prevId = id;
      }
      cellIds[i] = prevId;
    }
  }
  const width = packedWidth(entries.length);
  const ids = new Uint32Array(width === 0 ? 0 : Math.ceil((cells * width) / 32));
  if (width > 0) {
    for (let k = 0; k < cells; k++) {
      const bit = k * width;
      ids[bit >>> 5]! |= cellIds[k]! << (bit & 31);
    }
  }
  return { side, palette: Uint16Array.from(entries), width, ids };
}

/** The entry of grid cell `i` (grid order). */
export function shaderEntryAt(s: ShaderOut, i: number): number {
  if (s.width === 0) return s.palette[0]!;
  const bit = i * s.width;
  return s.palette[(s.ids[bit >>> 5]! >>> (bit & 31)) & ((1 << s.width) - 1)]!;
}

/**
 * Every grid cell's entry, in grid order, into `out` (side³ long): the form
 * a renderer uploads (a u16 a cell; little-endian bytes are material low
 * byte, then material high bits | wetness << 4).
 */
export function shaderGridEntries(s: ShaderOut, out: Uint16Array): Uint16Array {
  const cells = s.side * s.side * s.side;
  if (out.length < cells) throw new RangeError(`shader grid: ${out.length} cells for a side of ${s.side}`);
  if (s.width === 0) return out.fill(s.palette[0]!, 0, cells);
  const w = s.width;
  const mask = (1 << w) - 1;
  const per = 32 / w;
  const pal = s.palette;
  let i = 0;
  for (let k = 0; k < s.ids.length && i < cells; k++) {
    let word = s.ids[k]!;
    for (let j = 0; j < per && i < cells; j++, i++, word >>>= w) out[i] = pal[word & mask]!;
  }
  return out;
}

/**
 * The one solid entry every non-air cell of the grid holds, or −1 when it
 * holds two or more (0 when all air). A grid of one solid entry blends to
 * that entry wherever a surface is, so a renderer needs no grid for it.
 */
export function shaderSolidEntry(s: ShaderOut): number {
  let one = 0;
  for (const e of s.palette) {
    if (e === 0 || e === one) continue;
    if (one !== 0) return -1;
    one = e;
  }
  return one;
}

/** Bytes the shader data holds. */
export function shaderBytes(s: ShaderOut): number {
  return s.palette.byteLength + s.ids.byteLength;
}

/** Canonical bytes of shader data (side, width, entry count, palette, ids; little-endian), to compare and hash results; never stored. */
export function encodeShader(s: ShaderOut): Uint8Array {
  const out = new Uint8Array(6 + s.palette.byteLength + s.ids.byteLength);
  const view = new DataView(out.buffer);
  view.setUint16(0, s.side, true);
  view.setUint16(2, s.width, true);
  view.setUint16(4, s.palette.length - 1, true);
  s.palette.forEach((e, k) => view.setUint16(6 + k * 2, e, true));
  s.ids.forEach((w, k) => view.setUint32(6 + s.palette.byteLength + k * 4, w, true));
  return out;
}
