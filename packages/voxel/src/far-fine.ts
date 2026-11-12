/**
 * Fine far bricks: far-tree nodes at levels 0 and 1 (0.5 m and 1 m cells)
 * drawn as distance bricks past the near field's detail ring, built on the
 * GPU from the chunks' voxels as they stream (three-adapter
 * voxel-fine-bricks.ts), never stored. Levels 2 and up stay the far
 * cache's, built on the CPU (far-bricks-faces.ts); no level has two
 * builders.
 *
 * - **Input.** A fine node's cell block (far-bricks-faces.ts
 *   `gatherFarCells`, the very block the CPU build reads): a level-0 node
 *   reads its chunk's cells and an apron of 4 round it, a level-1 node its
 *   eight chunks' cells (twice finer than its own) and an apron of 7. The
 *   block goes to the page packed a cell in 16 bits (its fill level, 4 bits,
 *   and its look word's place in the node's own word list, 12 bits)
 *   ({@link packFarFine}); the page uploads it, builds, and lets it go.
 * - **Where the cells come from.** The streamer's resident chunks (the
 *   world's files with its run-time edits over them): a fine node is drawn
 *   only where every chunk its block reads is resident, so a level-2 node
 *   opens into fine children only there ({@link FarFineIndex}); past the
 *   load ring the far cache's levels draw as before.
 * - **Selection.** The far tree's own, by screen error and the visibility
 *   feedback: the fine levels are the tree's levels below its kept ones,
 *   opened where a 1 m or 0.5 m cell is worth its pixels. A node the near
 *   field draws whole is not opened (the detail ring draws it).
 * - **Edits.** A changed chunk makes every fine node whose block reads it
 *   stale: its block is read again from the edited cells and sent, and its
 *   old draw stays until the new one is built.
 */
import { VOXEL_SIZE_M, type ChunkGrid } from './coords';
import { DISTANCE_BRICK_SAMPLES } from './distance-brick-format';
import { FAR_BRICK_BAKED_BYTES, FAR_BRICK_TABLE_GPU_BYTES } from './far-bricks-shade';
import { farCellApron, type ChunkCells, type FarCellBlock } from './far-bricks-faces';
import { FAR_MIN_LEVEL, type FarNodeIndex } from './far-tree';
import { SHAPE_FULL } from './record';
import { mipChildren, type MipNode } from './voxel-mips';

/** The finest far level the cache keeps less one: the levels below {@link FAR_MIN_LEVEL} are the fine ones. */
export const FAR_FINE_TOP_LEVEL = FAR_MIN_LEVEL - 1;

/** Whether a node is a fine one (built on the GPU from streamed chunks). */
export function isFarFine(n: Pick<MipNode, 'level'>): boolean {
  return n.level <= FAR_FINE_TOP_LEVEL;
}

/** The source scale of a fine level's build: level 0 its own cells, level 1 the chunks' (twice finer), as the CPU build reads children. */
export function farFineScale(level: number): number {
  return 2 ** level;
}

/**
 * GPU bytes a fine node is foreseen to hold before it is built (the page builds it; the far field never sees its
 * bricks): 16 stored bricks and its brick table, about what a level-1 node of the 8 km world's town holds.
 */
export const FAR_FINE_GPU_FORESEEN_BYTES = 16 * DISTANCE_BRICK_SAMPLES * (1 + FAR_BRICK_BAKED_BYTES) + 64 * FAR_BRICK_TABLE_GPU_BYTES;

/** ms of the world's thread a far field update may spend reading fine nodes' blocks (each a few chunks exported). */
export const FAR_FINE_PACK_MS = 4;

/**
 * Chunks short of the load ring where level 2 can begin: a level-2 node opens into fine children only with its four
 * chunks a side and one more round them resident.
 */
const FAR_FINE_REACH_CHUNKS = 2 ** FAR_MIN_LEVEL + 1;

/** Share of the fade's end at which fine bricks' textures begin to fade to the far palette's colour. */
export const FAR_FINE_FADE_START_SHARE = 0.5;

/**
 * Where fine bricks' textures fade to the far palette's colour (metres from the eye: start, end). They end where level
 * 2 can begin, so the level 1 → 2 hand-over joins two palette colours, not a texture and a flat colour: where a level-2
 * cell is the selection's error on screen (`errorPixels` at `pixelsPerRadian`), or nearer where the load ring
 * (`loadRadiusCells`) keeps level 2 closed sooner.
 */
export function farFineFade(errorPixels: number, pixelsPerRadian: number, loadRadiusCells: number, edge: number): readonly [number, number] {
  const handover = (2 ** FAR_MIN_LEVEL * VOXEL_SIZE_M * pixelsPerRadian) / errorPixels;
  const reach = Math.max(0, (loadRadiusCells - FAR_FINE_REACH_CHUNKS * edge) * VOXEL_SIZE_M);
  const end = Math.min(handover, reach);
  return [FAR_FINE_FADE_START_SHARE * end, end];
}

/** Bytes of fine blocks one far event may carry (the page builds them over frames; the coarse levels keep their own budget). */
export const FAR_FINE_COMMIT_BYTES = 8 * 1024 * 1024;

/** ms between selections made again because chunks a fine node reads became resident or left. */
export const FAR_FINE_RESELECT_MS = 500;

/** A fine node's packed cell block as it goes to the page. */
export interface FarFineCells {
  /** Finer cells a node cell an axis ({@link farFineScale}). */
  readonly scale: number;
  /** Cells a side of the block. */
  readonly n: number;
  /** Per cell (x fastest, then y, then z): fill level 0–15 in bits 0–3, its word's place in {@link words} in bits 4–15. */
  readonly cells: Uint16Array;
  /** The block's look words (material | wetness << 12, construction cells | `SHADER_CONSTRUCTION_BIT`), first seen first. */
  readonly words: Uint16Array;
}

/** Look words a packed block can name (12 bits). */
const FINE_WORDS_MAX = 1 << 12;

/** Bytes a fine block holds on the wire. */
export function farFineBytes(f: FarFineCells): number {
  return f.cells.byteLength + f.words.byteLength;
}

/**
 * A cell block packed for the GPU build ({@link FarFineCells}); null when it draws nothing whatever is built (no
 * solid cell, or nothing but solid ones: the CPU build's empty node).
 */
export function packFarFine(b: FarCellBlock): FarFineCells | null {
  if (b.count === 0 || b.count === b.solid.length) return null;
  const cells = new Uint16Array(b.density.length);
  const words: number[] = [0];
  const place = new Map<number, number>([[0, 0]]);
  for (let i = 0; i < cells.length; i++) {
    const d = b.density[i]!;
    if (d === 0) continue;
    const w = b.word[i]!;
    let k = place.get(w);
    if (k === undefined) {
      if (words.length >= FINE_WORDS_MAX) throw new RangeError(`far fine block: more than ${FINE_WORDS_MAX} look words`);
      k = words.length;
      words.push(w);
      place.set(w, k);
    }
    cells[i] = (k << 4) | Math.round(d * SHAPE_FULL);
  }
  return { scale: b.scale, n: b.n, cells, words: Uint16Array.from(words) };
}

/** The packed block back to the CPU build's (the check of a GPU build against the CPU one reads the same cells). */
export function unpackFarFine(f: FarFineCells): FarCellBlock {
  const n3 = f.cells.length;
  const density = new Float32Array(n3);
  const word = new Uint16Array(n3);
  const solid = new Uint8Array(n3);
  let count = 0;
  for (let i = 0; i < n3; i++) {
    const c = f.cells[i]!;
    const fill = c & 15;
    if (fill === 0) continue;
    density[i] = fill / SHAPE_FULL;
    word[i] = f.words[c >> 4]!;
    if (density[i]! >= 0.5) {
      solid[i] = 1;
      count++;
    }
  }
  return { n: f.n, apron: farCellApron(f.scale), scale: f.scale, density, word, solid, count };
}

/** The chunks a fine node's block reads (its own and one round them: the apron is under a chunk deep), min and max inclusive. */
export function farFineChunks(n: MipNode): { readonly min: readonly [number, number, number]; readonly max: readonly [number, number, number] } {
  const s = 1 << n.level;
  return { min: [n.nx * s - 1, n.ny * s - 1, n.nz * s - 1], max: [(n.nx + 1) * s, (n.ny + 1) * s, (n.nz + 1) * s] };
}

/** What the far field reads fine nodes from: the streamer's chunks. */
export interface FarFineHost {
  /** Whether a chunk's cells are here (resident, or outside the world: air). */
  resident(cx: number, cy: number, cz: number): boolean;
  /** Whether a resident chunk holds anything but air. */
  holds(cx: number, cy: number, cz: number): boolean;
  /** A resident chunk's cells (the world's files with the run-time edits over them); false: air. */
  readonly cells: ChunkCells;
  /** Whether the near field draws a chunk whole now (the detail ring): a fine node there is not opened. */
  nearDrawn(cx: number, cy: number, cz: number): boolean;
}

/**
 * The far tree's index with the fine levels under its kept ones, as the selection walks it: a kept level-2 node opens
 * into the level-1 nodes over its chunks, a level-1 node into its chunks, where every chunk their blocks read is
 * resident and the near field does not draw the node whole; elsewhere a level-2 node stays closed (the kept tree's
 * finest, as without fine bricks).
 */
export class FarFineIndex {
  readonly minLevel = 0;

  constructor(
    private readonly base: FarNodeIndex,
    private readonly host: FarFineHost,
  ) {}

  get grid(): ChunkGrid {
    return this.base.grid;
  }

  get maxLevel(): number {
    return this.base.maxLevel;
  }

  nodes(level: number): MipNode[] {
    return this.base.nodes(level);
  }

  /** Stored bytes (fine nodes store nothing). */
  bytesOf(n: MipNode): number {
    return isFarFine(n) ? 0 : this.base.bytesOf(n);
  }

  has(n: MipNode): boolean {
    return isFarFine(n) ? this.holds(n) : this.base.has(n);
  }

  /** Whether a node may open into its children (a kept level above the fine ones always may). */
  openable(n: MipNode): boolean {
    if (n.level > FAR_MIN_LEVEL || n.level === 0) return n.level > 0;
    const { min, max } = farFineChunks(n);
    // The children's blocks read one chunk round the node: all of those here, or the node stays closed.
    for (let cx = min[0]; cx <= max[0]; cx++) for (let cy = min[1]; cy <= max[1]; cy++) for (let cz = min[2]; cz <= max[2]; cz++) if (!this.host.resident(cx, cy, cz)) return false;
    const s = 1 << n.level;
    for (let cx = n.nx * s; cx < (n.nx + 1) * s; cx++) for (let cy = n.ny * s; cy < (n.ny + 1) * s; cy++) for (let cz = n.nz * s; cz < (n.nz + 1) * s; cz++) if (!this.host.nearDrawn(cx, cy, cz)) return true;
    return false;
  }

  children(n: MipNode): MipNode[] {
    if (n.level > FAR_MIN_LEVEL) return this.base.children(n);
    if (n.level === 0) return [];
    return mipChildren(n).filter((c) => this.holds(c));
  }

  /** A fine node holds anything: one of its chunks holds more than air. */
  private holds(n: MipNode): boolean {
    const s = 1 << n.level;
    for (let cx = n.nx * s; cx < (n.nx + 1) * s; cx++) for (let cy = n.ny * s; cy < (n.ny + 1) * s; cy++) for (let cz = n.nz * s; cz < (n.nz + 1) * s; cz++) if (this.host.holds(cx, cy, cz)) return true;
    return false;
  }
}

/** The fine nodes whose blocks read a changed chunk (levels 0 and 1). */
export function farFineDirty(chunks: Iterable<{ readonly cx: number; readonly cy: number; readonly cz: number }>): MipNode[] {
  const out = new Map<string, MipNode>();
  for (const c of chunks) for (let level = 0; level <= FAR_FINE_TOP_LEVEL; level++) {
    // A node's block reads its chunks and one round them: the nodes over the chunk and its 26 neighbours.
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (let dz = -1; dz <= 1; dz++) {
      const n = { level, nx: (c.cx + dx) >> level, ny: (c.cy + dy) >> level, nz: (c.cz + dz) >> level };
      out.set(`${level}:${n.nx},${n.ny},${n.nz}`, n);
    }
  }
  return [...out.values()];
}
