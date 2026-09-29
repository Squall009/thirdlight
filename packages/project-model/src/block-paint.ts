/**
 * Paint and wetness of a block layer — what a painted terrain
 * material reads.
 *
 * A chunk may carry `paint`: for each of its 17 × 17 lattice vertices (the
 * corners of its 16 × 16 columns, the far edges included, so a chunk is drawn
 * from its own data) five bytes: the weights of four material layers (summing
 * to 255) and a wetness (0 dry – 255 soaked). Vertices on a chunk edge are
 * stored in every chunk that shares them, and a dab writes them all alike.
 * An unpainted vertex is all first layer and dry. The paint belongs to the
 * layer's surface, not to cells: copies, stamps and erasing cells do not
 * move it, and a chunk whose cells are all removed drops it.
 *
 * Drawing: a painted layer's chunk meshes carry the paint as vertex colours
 * (COLOR_0 = the four weights, COLOR_1.r = the wetness), taken bilinearly at
 * each vertex from the lattice, so any look (stand-in or model) takes it; a
 * graph material reads them with Vertex colour nodes (the Height blend node
 * mixes layers by them).
 *
 * The paint is visual: the simulation carries it with the cells but no rule
 * reads it (no script API), so play and replays do not depend on it.
 *
 * Pure and deterministic (the brush is `paint-brush.ts`).
 */
import type { BlockChunk } from './block-layers';
import { brushFalloff, paintPoint, type PaintBrush, type PaintLayout } from './paint-brush';
import { decodeBase64, encodeBase64 } from './png-decode';

/**
 * Columns per chunk side: `block-layers`' CHUNK_SIZE (repeated here because
 * block-layers imports this module; a unit test keeps them equal).
 */
export const PAINT_CHUNK_SIZE = 16;
const CHUNK_SIZE = PAINT_CHUNK_SIZE;
/** Lattice vertices per chunk side (16 columns: 17 corners). */
export const PAINT_VERTICES = CHUNK_SIZE + 1;
/** Bytes per vertex: four layer weights and the wetness. */
export const PAINT_CHANNELS = 5;
/** The four layer weights (a partition of 255), then the wetness. */
export const BLOCK_PAINT_LAYOUT: PaintLayout = Object.freeze({ channels: PAINT_CHANNELS, weights: 4 });
/** The wetness channel. */
export const PAINT_WETNESS_CHANNEL = 4;
/** The bytes of one chunk's paint. */
export const PAINT_BYTES = PAINT_VERTICES * PAINT_VERTICES * PAINT_CHANNELS;
/** An unpainted vertex: all first layer, dry. */
const UNPAINTED = [255, 0, 0, 0, 0] as const;

/** A fresh unpainted chunk lattice. */
export function unpaintedChunk(): Uint8Array {
  const out = new Uint8Array(PAINT_BYTES);
  for (let i = 0; i < PAINT_VERTICES * PAINT_VERTICES; i++) out[i * PAINT_CHANNELS] = 255;
  return out;
}

/** Whether a lattice is all unpainted (then it is not stored). */
export function isUnpainted(bytes: Uint8Array): boolean {
  for (let i = 0; i < bytes.length; i++) if (bytes[i] !== UNPAINTED[i % PAINT_CHANNELS]) return false;
  return true;
}

/** A stored chunk's paint (null: none or malformed — validation refuses those). */
export function decodeChunkPaint(paint: string | undefined): Uint8Array | null {
  if (paint === undefined) return null;
  const b = decodeBase64(paint);
  return b !== null && b.length === PAINT_BYTES ? b : null;
}

export function encodeChunkPaint(bytes: Uint8Array): string {
  return encodeBase64(bytes);
}

/** A stored paint's problem (null: fine). */
export function chunkPaintError(v: unknown): string | null {
  if (typeof v !== 'string') return 'paint is base64 of the chunk\'s 17 × 17 vertices × 5 bytes (4 layer weights, wetness)';
  const b = decodeBase64(v);
  if (b === null || b.length !== PAINT_BYTES) return `paint decodes to ${PAINT_BYTES} bytes (17 × 17 vertices × 4 layer weights and a wetness)`;
  for (let i = 0; i < PAINT_VERTICES * PAINT_VERTICES; i++) {
    const o = i * PAINT_CHANNELS;
    if (b[o]! + b[o + 1]! + b[o + 2]! + b[o + 3]! !== 255) return `vertex ${i}: the four layer weights sum to 255`;
  }
  return null;
}

/** The byte offset of layer vertex (x, z) in the lattice of chunk (cx, cz) (null: not one of its vertices). */
export function paintOffset(cx: number, cz: number, x: number, z: number): number | null {
  const lx = x - cx * CHUNK_SIZE;
  const lz = z - cz * CHUNK_SIZE;
  if (lx < 0 || lz < 0 || lx > CHUNK_SIZE || lz > CHUNK_SIZE) return null;
  return (lz * PAINT_VERTICES + lx) * PAINT_CHANNELS;
}

/** The chunks whose lattice holds layer vertex (x, z): its own and, on an edge, the ones before it. */
export function chunksOfVertex(x: number, z: number): [number, number][] {
  const cx = Math.floor(x / CHUNK_SIZE);
  const cz = Math.floor(z / CHUNK_SIZE);
  const xs = x % CHUNK_SIZE === 0 ? [cx - 1, cx] : [cx];
  const zs = z % CHUNK_SIZE === 0 ? [cz - 1, cz] : [cz];
  const out: [number, number][] = [];
  for (const zz of zs) for (const xx of xs) out.push([xx, zz]);
  return out;
}

/** What a paint dab needs of the grid: which chunks hold cells, and their lattices (read and written). */
export interface PaintSurface {
  /** Layer vertex bounds (columns min … max inclusive). */
  readonly minX: number;
  readonly maxX: number;
  readonly minZ: number;
  readonly maxZ: number;
  /** A chunk's lattice to write (made unpainted on first use), or null when the chunk holds no cells. */
  lattice(cx: number, cz: number): Uint8Array | null;
  /** The chunk's paint changed. */
  touched(cx: number, cz: number): void;
}

/**
 * One brush dab at `at` (layer columns; vertices at whole numbers): every
 * vertex within the radius takes the brush by its falloff. A vertex shared
 * by several chunks is painted once and written to each. Returns the number
 * of vertices changed.
 */
export function paintDab(surface: PaintSurface, at: readonly [number, number], brush: PaintBrush): number {
  const r = brush.radius;
  const x0 = Math.max(surface.minX, Math.ceil(at[0] - r));
  const x1 = Math.min(surface.maxX, Math.floor(at[0] + r));
  const z0 = Math.max(surface.minZ, Math.ceil(at[1] - r));
  const z1 = Math.min(surface.maxZ, Math.floor(at[1] + r));
  let changed = 0;
  const scratch = new Uint8Array(PAINT_CHANNELS);
  for (let z = z0; z <= z1; z++) {
    for (let x = x0; x <= x1; x++) {
      const dx = x - at[0];
      const dz = z - at[1];
      const f = brushFalloff(dx * dx + dz * dz, r, brush.falloff);
      if (f <= 0) continue;
      const holders: { cx: number; cz: number; lattice: Uint8Array; offset: number }[] = [];
      for (const [cx, cz] of chunksOfVertex(x, z)) {
        const lattice = surface.lattice(cx, cz);
        if (lattice === null) continue;
        holders.push({ cx, cz, lattice, offset: paintOffset(cx, cz, x, z)! });
      }
      if (holders.length === 0) continue;
      // The first holder's value (chunks in z, then x order) is the vertex's; every copy gets the result.
      const h0 = holders[0]!;
      scratch.set(h0.lattice.subarray(h0.offset, h0.offset + PAINT_CHANNELS));
      paintPoint(scratch, 0, BLOCK_PAINT_LAYOUT, brush, brush.strength * f);
      let any = false;
      for (const h of holders) {
        let differs = false;
        for (let k = 0; k < PAINT_CHANNELS; k++) if (h.lattice[h.offset + k] !== scratch[k]) differs = true;
        if (!differs) continue;
        h.lattice.set(scratch, h.offset);
        surface.touched(h.cx, h.cz);
        any = true;
      }
      if (any) changed += 1;
    }
  }
  return changed;
}

/**
 * The paint at mesh vertices of chunk (cx, cz): positions in layer-local
 * metres (x, y, z per vertex), `lattice` the chunk's paint (null: unpainted).
 * Returns COLOR_0 (the four weights) and COLOR_1 (the wetness in r, alpha
 * 255), normalized bytes, four per vertex — bilinear in the lattice cell
 * under each vertex.
 */
export function chunkPaintColors(lattice: Uint8Array | null, cx: number, cz: number, cellSize: readonly number[], positions: Float32Array): { weights: Uint8Array; wetness: Uint8Array } {
  const n = positions.length / 3;
  const weights = new Uint8Array(n * 4);
  const wetness = new Uint8Array(n * 4);
  for (let i = 0; i < n; i++) {
    wetness[i * 4 + 3] = 255;
    if (lattice === null) {
      weights[i * 4] = 255;
      continue;
    }
    const u = Math.min(CHUNK_SIZE, Math.max(0, positions[i * 3]! / cellSize[0]! - cx * CHUNK_SIZE));
    const v = Math.min(CHUNK_SIZE, Math.max(0, positions[i * 3 + 2]! / cellSize[2]! - cz * CHUNK_SIZE));
    const iu = Math.min(CHUNK_SIZE - 1, Math.floor(u));
    const iv = Math.min(CHUNK_SIZE - 1, Math.floor(v));
    const fu = u - iu;
    const fv = v - iv;
    const at = (a: number, b: number, k: number): number => lattice[((iv + b) * PAINT_VERTICES + iu + a) * PAINT_CHANNELS + k]!;
    const mix = (k: number): number => (at(0, 0, k) * (1 - fu) + at(1, 0, k) * fu) * (1 - fv) + (at(0, 1, k) * (1 - fu) + at(1, 1, k) * fu) * fv;
    for (let k = 0; k < 4; k++) weights[i * 4 + k] = Math.round(mix(k));
    wetness[i * 4] = Math.round(mix(PAINT_WETNESS_CHANNEL));
  }
  return { weights, wetness };
}

/** A chunk's stored paint as bytes (null: unpainted). */
export function chunkPaintOf(c: Pick<BlockChunk, 'paint'>): Uint8Array | null {
  return decodeChunkPaint(c.paint);
}
