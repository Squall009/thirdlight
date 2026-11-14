/**
 * Mesh output buffers of a derived chunk (formats, DRAFT) and the
 * detail-instance list of the kit pieces its edges, corners, roof edges and
 * faces toward a hole carry. The ground surface is the terrain mesher's
 * (terrain-mesher.ts), the modular bodies' faces the base surface's
 * (base-surface.ts: coplanar faces merged), both in the surface layout
 * below.
 *
 * **Surface buffer** (one per surface kind): interleaved vertices whose
 * attributes are WebGPU/WebGL 2 vertex formats, then indices.
 * - position `uint16x4`: chunk-local, in 1/{@link POSITION_STEPS_PER_CELL}
 *   cell steps from one cell below the chunk's corner (so the surface's
 *   boundary vertices at −0.5 fit); w holds the crack overlay's strength
 *   (0 … 255: 0 none) of the face it belongs to, non-zero only on the faces
 *   of a cracked
 *   cell (damage stage 1, damage-stages.ts) in its low byte; its high byte
 *   is half of the vertex's **owner offset** (below);
 * - normal `snorm8x4`, w the other half of the owner offset (0: none).
 * A vertex carries no material: the surface shader finds the materials
 * around each pixel in the chunk's shader data (derived-shader.ts) and
 * blends them there, so a material or wetness change never rebuilds a mesh
 * and blends look the same on every mesh detail level.
 *
 * **Owner offset** ({@link surfaceOwnerOf}): a face that must show one
 * cell's material alone, never blended with the cells round it, names that
 * cell, or (a merged face) the row of cells it covers. Its vertices carry
 * the offset from the vertex to a point a quarter cell inside the cell
 * across the row, and nothing along it (quarter cells, x and z 4 bits each
 * in position w's high byte, y 7 bits over a set bit 0 in normal w);
 * interpolated across the triangle, the offset added to a pixel's position
 * lands in the row's cell under the pixel, whatever cells its triangle
 * crosses. The roof mesher's faces name theirs (a roof
 * plane its plane cell, the closing sides and floor over a wall the wall's
 * cell: wall and roof never blend across their seam), and a body's faces
 * next to a plane cell name the cell behind them (a quarter cell in). A
 * vertex without one (normal w 0) is blended as described.
 * Indices are `uint16` below 65,536 vertices, else `uint32`; triangles are
 * counter-clockwise seen from outside.
 *
 * **Shared boundaries** (no cracks): a vertex's position is a function of
 * the samples around it only, quantised as an integer number of steps in
 * world cells, so two chunks that compute the same boundary vertex get the
 * same world position bit for bit. Each sample edge belongs to exactly one
 * chunk (the one holding its lower sample), so no triangle is emitted twice.
 *
 * **Detail instances**: 12 bytes each: x, y, z (chunk-local cell, uint8),
 * a byte of rotation (bits 0–1: quarter turns about +y, bits 2–3 the
 * placement, {@link INSTANCE_PLACE}) and flags (bits 4–7,
 * {@link INSTANCE_FLAG}), the piece (uint16), its variant word (uint16)
 * and its dressing word (uint32): the stride stays a multiple of four, as a
 * GPU instance buffer needs. The piece is **kit-local** (piece-table.ts):
 * the filled slot of the kit its dressing cell's material names; the
 * material is read from the shader data like a surface's. The dressing
 * cell is the instance's own cell or a neighbour (edge-cases.ts
 * `slotDressing`: where roles meet, the higher role's kit dresses the
 * piece): bits 0–4 of the dressing word, {@link instanceDressingCell}. Bits
 * 5–10 are the cell's faces the piece is cut at, so nothing of it passes
 * into an opening beside them ({@link instanceFlushFaces}); bits 11–14 a
 * damage piece's scatter index (which of the pieces on its face it is,
 * {@link instanceScatter}); the rest are written 0. The variant word holds
 * which of the slot's meshes it draws (bits 0–14) and the mirror of the
 * case's transform (bit 15). Every piece adds to the faces it sits on or
 * between (none replaces a cell's base surface). A cell may own several
 * instances: one each edge, corner or roof edge it carries, and its damage
 * pieces on each face toward a hole.
 *
 * **Pieces per level** ({@link levelDrawsPieces}): only a chunk (level 0, the
 * near ring) lists pieces. Coarser nodes list none: their edges are plain
 * square voxel faces. Two detail states, not a piece mesh per level: a kit
 * authors one mesh a piece.
 */
import { grownCapacity } from '@thirdlight/shared';
import type { Neighbourhood } from './assembly';
import { DAMAGE_PIECES_MAX } from './damage-stages';

/** Position steps per cell (1/1024 cell ≈ 0.5 mm). */
export const POSITION_STEPS_PER_CELL = 1024;

/** Density at or above which a projected sample is inside the ground. */
export const SURFACE_ISO = 128;

/** Bytes a surface vertex takes: position `uint16x4` and normal `snorm8x4`. */
export const SURFACE_VERTEX_BYTES = 12;

/** Owner offsets count in quarter cells (every lattice point of the roof mesher's faces is a whole quarter). */
export const SURFACE_OWNER_STEPS_PER_CELL = 4;

/** The largest owner offset a vertex holds (quarter cells): across (x, z) and up (y). */
const OWNER_ACROSS_MAX = 7;
const OWNER_UP_MAX = 63;

/**
 * Writes vertex `v`'s crack strength and owner offset (quarter cells from
 * the vertex to its owner cell's centre, null: none) into a surface buffer.
 */
export function writeSurfaceExtras(view: DataView, v: number, crack: number, owner: readonly number[] | null): void {
  const o = v * SURFACE_VERTEX_BYTES;
  if (owner === null) {
    view.setUint16(o + 6, crack, true);
    view.setInt8(o + 11, 0);
    return;
  }
  const [dx, dy, dz] = owner as [number, number, number];
  if (Math.abs(dx) > OWNER_ACROSS_MAX || Math.abs(dz) > OWNER_ACROSS_MAX || Math.abs(dy) > OWNER_UP_MAX) throw new RangeError(`surface owner offset ${dx}, ${dy}, ${dz} (quarter cells) out of reach`);
  view.setUint16(o + 6, crack | ((dx & 15) << 8) | ((dz & 15) << 12), true);
  view.setInt8(o + 11, (dy << 1) | 1);
}

/** The crack strength (0 … 255) of the vertex at byte `o` of a surface buffer's view. */
export function surfaceCrackOf(view: DataView, o: number): number {
  return view.getUint16(o + 6, true) & 0xff;
}

/**
 * The owner offset (quarter cells, x, y, z from the vertex to the centre of
 * the cell whose material the face shows alone) of the vertex at byte `o`,
 * or null when the vertex has none (blended).
 */
export function surfaceOwnerOf(view: DataView, o: number): [number, number, number] | null {
  const w = view.getInt8(o + 11);
  if ((w & 1) === 0) return null;
  const hi = view.getUint16(o + 6, true) >>> 8;
  const four = (b: number): number => ((b & 15) ^ 8) - 8;
  return [four(hi), w >> 1, four(hi >>> 4)];
}

/** Bytes per detail instance. */
export const INSTANCE_BYTES = 12;

/** Byte offset of an instance's dressing word (uint32). */
export const INSTANCE_DRESSING_OFFSET = 8;

/** The dressing word's code for the instance's own cell (a neighbour's: its 3³ block index + 1, wrapping). */
const DRESSING_OWN = 13;

/**
 * A dressing word (see the file comment) for the cell at 3³ block index
 * `block` round the instance's cell (13: its own) and the faces `flush`
 * (bit 2a: the −a face, 2a + 1: the +a face).
 */
export function dressingWord(block: number, flush: number, scatter = 0): number {
  return (((block + 27 - DRESSING_OWN) % 27) | ((flush & 63) << 5) | ((scatter & (DAMAGE_PIECES_MAX - 1)) << DRESSING_SCATTER_SHIFT)) >>> 0;
}

/** Where a damage piece's scatter index starts in the dressing word. */
const DRESSING_SCATTER_SHIFT = 11;

/** Which of the damage pieces on its face an instance is (0 … DAMAGE_PIECES_MAX − 1; 0 for any other piece), from its dressing word. */
export function instanceScatter(word: number): number {
  return (word >>> DRESSING_SCATTER_SHIFT) & (DAMAGE_PIECES_MAX - 1);
}

/** The offset (x, y, z, each −1 … 1) from an instance's cell to its dressing cell, from its dressing word. */
export function instanceDressingCell(word: number): [number, number, number] {
  const b = ((word & 31) + DRESSING_OWN) % 27;
  return [Math.floor(b / 9) - 1, (Math.floor(b / 3) % 3) - 1, (b % 3) - 1];
}

/** The faces of an instance's cell its piece is cut at (bit 2a: −a, 2a + 1: +a), from its dressing word. */
export function instanceFlushFaces(word: number): number {
  return (word >>> 5) & 63;
}

/** Instance flags (bits 5–7 of the rotation byte; bit 4 is written 0). */
export const INSTANCE_FLAG = Object.freeze({
  /**
   * A roof-edge piece on a 1:2 roof: the renderer pitches the case's one
   * mesh (authored for 45°) onto the shallower plane (piece-placement.ts
   * `roofPitch`).
   */
  shallow: 0x20,
  /** With `shallow`: the plane it follows is the high cell of its 1:2 pair (half a cell higher at the cell). */
  high: 0x80,
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
      const size = grownCapacity(this.buf.length, at + n);
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
  /** {@link INSTANCE_FLAG} bits the piece sets. */
  flags: number;
  /** The variant word: variant | mirror bit (piece-table.ts). */
  variant: number;
  /** The dressing word ({@link dressingWord}). */
  dressing: number;
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
  const cell: CellPiece = { piece: 0, turns: 0, place: 0, flags: 0, variant: 0, dressing: 0 };
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
    d.setUint32(at + INSTANCE_DRESSING_OFFSET, cell.dressing, true);
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
