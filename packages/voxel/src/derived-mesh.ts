/**
 * Mesh output buffers of a derived chunk (formats, DRAFT) and the
 * detail-instance list of the kit pieces its edges, corners, roof edges and
 * damaged cells carry. The ground surface is the terrain mesher's
 * (terrain-mesher.ts), the modular bodies' faces the base surface's
 * (base-surface.ts: coplanar faces merged), both in the surface layout
 * below.
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
 * a byte of rotation (bits 0–1: quarter turns about +y, bits 2–3 the
 * placement, {@link INSTANCE_PLACE}) and flags (bits 4–7,
 * {@link INSTANCE_FLAG}), the piece (uint16) and its variant word
 * (uint16): the stride stays a multiple of four, as a GPU instance buffer
 * needs. The piece is **kit-local** (piece-table.ts): the filled slot of
 * the kit its cell's material names; the material is its cell's, read from
 * the shader data like a surface's. The variant word holds which of the
 * slot's meshes it draws (bits 0–14) and the mirror of the case's transform
 * (bit 15). A piece that replaces its cell's base surface says so
 * (`replacesBase`: a debris piece drawn in a damaged cell's place); an edge
 * piece adds to the faces it sits between. A cell may own several
 * instances: one each edge, corner, roof edge or debris piece it carries.
 *
 * **Pieces per level** ({@link levelDrawsPieces}): only a chunk (level 0, the
 * near ring) lists pieces. Coarser nodes list none: their edges are plain
 * square voxel faces. Two detail states, not a piece mesh per level: a kit
 * authors one mesh a piece.
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

/** Instance flags (bits 4–7 of the rotation byte; 0x20 and 0x80 are written 0). */
export const INSTANCE_FLAG = Object.freeze({
  /** The piece replaces its cell's base surface (none is emitted under it). */
  replacesBase: 0x10,
  /**
   * The piece covers half its run (piece-placement.ts {@link pieceHalfRun}):
   * a roof's ridge and hips end at the middle of an apex cell, where they
   * meet.
   */
  half: 0x40,
});

/** Whether chunk-tree level `level` draws detail pieces: level 0 only (coarser levels draw plain voxel edges). */
export function levelDrawsPieces(level: number): boolean {
  return level === 0;
}

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

/**
 * How a piece is placed beyond its quarter turns (bits 2–3 of the rotation
 * byte), applied in the case's own orientation before the turns: `upright`
 * as authored; `faceUp` / `faceDown` tip the case's +z (its open side) to
 * +y / −y, so a piece written for a side face dresses a top or bottom face;
 * `centred` moves it half a cell toward its own −z and half a cell down,
 * so a ridge piece written on the cell's +z side (where a 45° plane is
 * highest) runs along the cell's middle at the plane's height there (a
 * ridge on an odd-width roof).
 */
export const INSTANCE_PLACE = Object.freeze({ upright: 0, faceUp: 1, faceDown: 2, centred: 3 });

/** Shift of the {@link INSTANCE_PLACE} field in the rotation byte. */
export const INSTANCE_PLACE_SHIFT = 2;

/** The {@link INSTANCE_PLACE} of an instance's rotation byte. */
export function instancePlaceOf(rotation: number): number {
  return (rotation >> INSTANCE_PLACE_SHIFT) & 3;
}

/** What a derive's piece choice gives for one piece of a cell (detailInstances reuses one). */
export interface CellPiece {
  /** The kit-local piece. */
  piece: number;
  /** Quarter turns about +y. */
  turns: number;
  /** {@link INSTANCE_PLACE}. */
  place: number;
  /** {@link INSTANCE_FLAG} bits the piece sets (`replacesBase`). */
  flags: number;
  /** The variant word: variant | mirror bit (piece-table.ts). */
  variant: number;
}

/**
 * Detail instances: every piece `piecesAt` gives each cell of the derive
 * unit (padded index, then the cell's local x, y, z), in cell order and then
 * in the order given; a cell may own several (its edges, its corners).
 */
export function detailInstances(n: Neighbourhood, piecesAt: (i: number, x: number, y: number, z: number, cell: CellPiece, emit: () => void) => void): InstanceList {
  const e = n.edge;
  const p = n.pad;
  const s = n.side;
  const out = new Bytes();
  const cell: CellPiece = { piece: 0, turns: 0, place: 0, flags: 0, variant: 0 };
  let count = 0;
  let cx = 0;
  let cy = 0;
  let cz = 0;
  const emit = (): void => {
    const at = out.reserve(INSTANCE_BYTES);
    const d = out.view;
    d.setUint8(at, cx);
    d.setUint8(at + 1, cy);
    d.setUint8(at + 2, cz);
    d.setUint8(at + 3, (cell.turns & 3) | ((cell.place & 3) << INSTANCE_PLACE_SHIFT) | cell.flags);
    d.setUint16(at + 4, cell.piece, true);
    d.setUint16(at + 6, cell.variant, true);
    count++;
  };
  for (let x = 0; x < e; x++) for (let z = 0; z < e; z++) for (let y = 0; y < e; y++) {
    cx = x;
    cy = y;
    cz = z;
    piecesAt(((x + p) * s + (z + p)) * s + (y + p), x, y, z, cell, emit);
  }
  return { count, data: out.done() };
}
