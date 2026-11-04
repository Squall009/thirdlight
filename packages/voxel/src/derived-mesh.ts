/**
 * Mesh output buffers of a derived chunk (formats, DRAFT) and the
 * detail-instance list for the features the assembly evaluation resolved
 * (beams, rails, posts). The ground surface is the terrain mesher's
 * (terrain-mesher.ts), the modular bodies' faces the base surface's
 * (base-surface.ts: coplanar faces merged), both in the surface layout
 * below. The placeholder pieces are there to fill and measure the formats;
 * the case pass replaces them, writing the same layouts.
 *
 * **Surface buffer** (one per surface kind): interleaved vertices whose
 * attributes are WebGPU/WebGL 2 vertex formats, then indices.
 * - position `uint16x4`: chunk-local, in 1/{@link POSITION_STEPS_PER_CELL}
 *   cell steps from one cell below the chunk's corner (so the surface's
 *   boundary vertices at −0.5 fit); w is 0, reserved;
 * - normal `snorm8x4` (w 0).
 * A vertex carries no material: the surface shader finds the materials
 * around each pixel in the chunk's shader data (derived-shader.ts) and
 * blends them there, so a material or wetness change never rebuilds a mesh
 * and blends look the same on every mesh detail level.
 * Indices are `uint16` below 65,536 vertices, else `uint32`; triangles are
 * counter-clockwise seen from outside.
 *
 * **Shared boundaries** (no cracks): a vertex's position is a function of
 * the samples around it only, quantised as an integer number of steps in
 * world cells, so two chunks that compute the same boundary vertex get the
 * same world position bit for bit. Each sample edge belongs to exactly one
 * chunk (the one holding its lower sample), so no triangle is emitted twice.
 *
 * **Detail instances**: 8 bytes each: x, y, z (chunk-local cell, uint8),
 * a byte of rotation (bits 0–1: quarter turns about +y) and flags (bits
 * 4–7, {@link INSTANCE_FLAG}), the piece (uint16) and its variant word
 * (uint16): the stride stays a multiple of four, as a GPU instance buffer
 * needs. The piece is **kit-local** (piece-table.ts): below
 * `KIT_PIECE_BASE` the engine's default piece (stand-in family << 3 | run
 * section), from there the own piece of the kit its cell's material names;
 * the material is its cell's, read from the shader data like a surface's.
 * The variant word holds the variant (bits 0–14) and the mirror of the
 * case's transform (bit 15). A piece that replaces its cell's base surface
 * says so (`replacesBase`): the base surface is then not emitted there, so
 * an open rail is open, not a rail drawn over a solid block; a kit's piece
 * on a cell whose base is kept (a moulding, a coping) adds to it.
 *
 * **Pieces per level** ({@link pieceDetailAt}): a chunk (level 0) lists its
 * pieces at high detail, a level-1 node at low detail (`low` set: the
 * renderer draws the piece variant's low mesh, or its high one where the kit
 * authored no low), and coarser nodes list none: there the cells the rules read as
 * beams and rails are drawn by the base surface as the bodies their mip
 * cells are, so a distant balcony or fence keeps its outline as blocks.
 */
import type { Neighbourhood } from './assembly';

/** Position steps per cell (1/1024 cell ≈ 0.5 mm). */
export const POSITION_STEPS_PER_CELL = 1024;

/** Density at or above which a projected sample is inside the ground. */
export const SURFACE_ISO = 128;

/** Bytes a surface vertex takes: position `uint16x4` and normal `snorm8x4`. */
export const SURFACE_VERTEX_BYTES = 12;

/** Bytes per detail instance. */
export const INSTANCE_BYTES = 8;

/** Instance flags (bits 4–7 of the rotation byte). */
export const INSTANCE_FLAG = Object.freeze({
  /** The piece replaces its cell's base surface (none is emitted under it). */
  replacesBase: 0x10,
  /** The piece is drawn at low detail (a level-1 node's). */
  low: 0x20,
});

/** How detailed a level's pieces are: level 0 high, level 1 low, coarser none (their cells drawn as bodies). */
export const PIECE_DETAIL = Object.freeze({ high: 0, low: 1, none: 2 });

/** The detail of chunk-tree level `level`'s pieces ({@link PIECE_DETAIL}). */
export function pieceDetailAt(level: number): number {
  return level === 0 ? PIECE_DETAIL.high : level === 1 ? PIECE_DETAIL.low : PIECE_DETAIL.none;
}

/** The default pieces' stand-in families (a default piece = family << 3 | run section, piece-table.ts). */
export const PIECE_FAMILY = Object.freeze({ beam: 1, rail: 2, post: 3 });

/** Run sections: a merge-compatible piece is a body with ends, or a single. */
export const PIECE_SECTION = Object.freeze({ single: 0, start: 1, body: 2, end: 3 });

export interface SurfaceBuffer {
  readonly vertexCount: number;
  /** Interleaved vertices, {@link SURFACE_VERTEX_BYTES} each. */
  readonly vertices: Uint8Array;
  readonly indices: Uint16Array | Uint32Array;
}

export interface InstanceList {
  readonly count: number;
  /** {@link INSTANCE_BYTES} per instance. */
  readonly data: Uint8Array;
}

/** A growable byte buffer. */
class Bytes {
  buf = new Uint8Array(1024);
  view = new DataView(this.buf.buffer);
  length = 0;

  reserve(n: number): number {
    const at = this.length;
    if (at + n > this.buf.length) {
      let size = this.buf.length * 2;
      while (size < at + n) size *= 2;
      const next = new Uint8Array(size);
      next.set(this.buf.subarray(0, at));
      this.buf = next;
      this.view = new DataView(next.buffer);
    }
    this.length = at + n;
    return at;
  }

  done(): Uint8Array {
    return this.buf.slice(0, this.length);
  }
}

/** Snorm8 of a unit-vector component. */
export function snorm8(v: number): number {
  return Math.max(-127, Math.min(127, Math.round(v * 127)));
}

/** What a derive's piece choice gives for one cell (detailInstances reuses one). */
export interface CellPiece {
  /** The kit-local piece. */
  piece: number;
  /** Quarter turns about +y. */
  turns: number;
  /** {@link INSTANCE_FLAG} bits the piece sets (`replacesBase`). */
  flags: number;
  /** The variant word: variant | mirror bit (piece-table.ts). */
  variant: number;
}

/**
 * Detail instances: one for each cell of the derive unit `pieceAt` gives a
 * piece (padded index, then the cell's local x, y, z; false: none).
 * `detail` ({@link PIECE_DETAIL}): none lists nothing, low flags every
 * piece.
 */
export function detailInstances(n: Neighbourhood, pieceAt: (i: number, x: number, y: number, z: number, out: CellPiece) => boolean, detail: number = PIECE_DETAIL.high): InstanceList {
  if (detail === PIECE_DETAIL.none) return { count: 0, data: new Uint8Array(0) };
  const low = detail === PIECE_DETAIL.low ? INSTANCE_FLAG.low : 0;
  const e = n.edge;
  const p = n.pad;
  const s = n.side;
  const out = new Bytes();
  const cell: CellPiece = { piece: 0, turns: 0, flags: 0, variant: 0 };
  let count = 0;
  for (let x = 0; x < e; x++) for (let z = 0; z < e; z++) for (let y = 0; y < e; y++) {
    if (!pieceAt(((x + p) * s + (z + p)) * s + (y + p), x, y, z, cell)) continue;
    const at = out.reserve(INSTANCE_BYTES);
    const d = out.view;
    d.setUint8(at, x);
    d.setUint8(at + 1, y);
    d.setUint8(at + 2, z);
    d.setUint8(at + 3, (cell.turns & 3) | cell.flags | low);
    d.setUint16(at + 4, cell.piece, true);
    d.setUint16(at + 6, cell.variant, true);
    count++;
  }
  return { count, data: out.done() };
}
