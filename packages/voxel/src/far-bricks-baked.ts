/**
 * Far bricks made ahead of time: a far node's bricks as bytes (what the far
 * cache stores beside its nodes), the brick job's input from the nodes it
 * reads (one function for the job sent at run time and the bake, so both
 * hand the same builder the same cells), and the brick nodes an edit makes
 * stale.
 *
 * Why: a brick job is a distance transform over 76³ finer cells, tens of
 * milliseconds a node, and the world it reads was authored, so its bricks
 * are the same every time it loads. Built once with the far cache, the
 * page only decodes and uploads them; a node of an edited world is built
 * again by the same builder, so it meets its baked neighbours exactly.
 */
import { DISTANCE_BRICK_BAND_VOXELS, DISTANCE_BRICK_SAMPLES } from './distance-brick-format';
import { FAR_BRICK_BLOCK_BYTES, FAR_BRICK_BOUNDS_BYTES, type FarBrickBuild, type FarBricks } from './far-bricks';
import { farNeighbourIndex, type FarMeshInput } from './far-mesh';
import { farAncestors } from './far-tree';
import type { StoredChunk } from './stream-job';
import { DISTANCE_BRICK_CELLS, DISTANCE_BRICK_OUTSIDE } from './distance-brick-format';
import type { MipNode } from './voxel-mips';

/** A baked node's bytes start with these four (`TLFB`). */
export const FAR_BRICKS_BLOB_MAGIC = [0x54, 0x4c, 0x46, 0x42] as const;

/** The baked node bytes' layout version; another is refused (the node is built at run time instead). */
export const FAR_BRICKS_BLOB_VERSION = 1;

/** Bytes before a baked node's arrays: magic, version, side, flags, a spare byte, the block count (u32). */
const HEAD = 12;

/** Flag bit: the blob carries each sample's occlusion. */
const OCCLUSION = 1;

/**
 * A far node's bricks as bytes, little-endian: the head, then the brick
 * table (i32 a brick), samples, looks (u16 a sample), blocks, bounds and,
 * with the flag, occlusion. {@link decodeFarBricks} gives the same arrays
 * back.
 */
export function encodeFarBricks(b: FarBricks): Uint8Array {
  const blocks = b.samples.length / DISTANCE_BRICK_SAMPLES;
  const occ = b.occlusion !== undefined;
  const size = HEAD + b.bricks.length * 4 + b.samples.length + b.looks.length * 2 + b.blocks.length + b.bounds.length + (occ ? b.occlusion!.length : 0);
  const out = new Uint8Array(size);
  const v = new DataView(out.buffer);
  out.set(FAR_BRICKS_BLOB_MAGIC, 0);
  out[4] = FAR_BRICKS_BLOB_VERSION;
  out[5] = b.side;
  out[6] = occ ? OCCLUSION : 0;
  v.setUint32(8, blocks, true);
  let o = HEAD;
  for (let i = 0; i < b.bricks.length; i++, o += 4) v.setInt32(o, b.bricks[i]!, true);
  out.set(b.samples, o);
  o += b.samples.length;
  for (let i = 0; i < b.looks.length; i++, o += 2) v.setUint16(o, b.looks[i]!, true);
  out.set(b.blocks, o);
  o += b.blocks.length;
  out.set(b.bounds, o);
  o += b.bounds.length;
  if (occ) out.set(b.occlusion!, o);
  return out;
}

/** A baked node's bricks from {@link encodeFarBricks}'s bytes; throws on other bytes. */
export function decodeFarBricks(bytes: Uint8Array): FarBricks {
  if (bytes.length < HEAD || !FAR_BRICKS_BLOB_MAGIC.every((m, i) => bytes[i] === m)) throw new RangeError('far bricks: not baked node bytes');
  if (bytes[4] !== FAR_BRICKS_BLOB_VERSION) throw new RangeError(`far bricks: baked version ${bytes[4]!}, expected ${FAR_BRICKS_BLOB_VERSION}`);
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const side = bytes[5]!;
  const occ = (bytes[6]! & OCCLUSION) !== 0;
  const blocks = v.getUint32(8, true);
  const n = blocks * DISTANCE_BRICK_SAMPLES;
  const size = HEAD + side ** 3 * 4 + n + n * 2 + blocks * FAR_BRICK_BLOCK_BYTES + blocks * FAR_BRICK_BOUNDS_BYTES + (occ ? n : 0);
  if (bytes.length !== size) throw new RangeError(`far bricks: ${bytes.length} baked bytes, expected ${size}`);
  let o = HEAD;
  const bricks = new Int32Array(side ** 3);
  for (let i = 0; i < bricks.length; i++, o += 4) bricks[i] = v.getInt32(o, true);
  const samples = bytes.slice(o, (o += n));
  const looks = new Uint16Array(n);
  for (let i = 0; i < n; i++, o += 2) looks[i] = v.getUint16(o, true);
  const blockBytes = bytes.slice(o, (o += blocks * FAR_BRICK_BLOCK_BYTES));
  const bounds = bytes.slice(o, (o += blocks * FAR_BRICK_BOUNDS_BYTES));
  const out: FarBricks = { side, bricks, samples, looks, blocks: blockBytes, bounds };
  return occ ? { ...out, occlusion: bytes.slice(o, o + n) } : out;
}

/** The finer nodes a brick job of `n` built `scale` times finer reads (null: it reads its own level and its 26 neighbours). */
export function farFineOf(n: MipNode, scale: number, minLevel: number): { level: number; scale: number; nodes: MipNode[] } | null {
  if (scale <= 1) return null;
  const level = n.level - Math.log2(scale);
  if (level < minLevel) return null;
  const nodes: MipNode[] = [];
  for (let dx = -1; dx <= scale; dx++) for (let dz = -1; dz <= scale; dz++) for (let dy = -1; dy <= scale; dy++) nodes.push({ level, nx: n.nx * scale + dx, ny: n.ny * scale + dy, nz: n.nz * scale + dz });
  return { level, scale, nodes };
}

/**
 * A brick job's cells for node `n` (`cellsOf`: a read node's entry as the
 * far cache stores it, null for air; the caller copies what it will
 * transfer): its finer nodes for a build of scale > 1 above the lowest kept
 * level, else the node and its 26 neighbours.
 */
export function farBrickJobCells(n: MipNode, build: FarBrickBuild, minLevel: number, cellsOf: (m: MipNode) => StoredChunk | null): Pick<FarMeshInput, 'cells' | 'level' | 'node' | 'build' | 'fine'> {
  const cells: Array<StoredChunk | null> = new Array<StoredChunk | null>(27).fill(null);
  const f = farFineOf(n, build.scale, minLevel);
  // A build from finer cells reads only those: the node's own level is neither read nor sent.
  if (f === null) for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (let dz = -1; dz <= 1; dz++) cells[farNeighbourIndex(dx, dy, dz)] = cellsOf({ level: n.level, nx: n.nx + dx, ny: n.ny + dy, nz: n.nz + dz });
  const fine = f === null ? undefined : { level: f.level, scale: f.scale, cells: f.nodes.map(cellsOf) };
  return { level: n.level, node: [n.nx, n.ny, n.nz], cells, build, ...(fine !== undefined ? { fine } : {}) };
}

/**
 * The brick nodes at levels `minLevel` … `maxLevel` an edit of the level-0
 * `chunks` makes stale: a node's build reads its source level's cells over
 * the node and a margin (the distance band at the node's spacing and a
 * cell, far-bricks-faces.ts), and a changed chunk changes its whole
 * ancestor node at that level (the mip's opening rule reads across the
 * node), so a brick node is stale when its read box meets a changed
 * ancestor's: the node over the change and, as a source node always lies
 * on a side of the block a build reads, the neighbours across that side
 * (up to 8 a level; 27 at the lowest level, built from its own cells).
 */
export function farBrickDirty(chunks: Iterable<{ readonly cx: number; readonly cy: number; readonly cz: number }>, edge: number, build: FarBrickBuild, minLevel: number, maxLevel: number): MipNode[] {
  const changed = farAncestors(chunks, minLevel, maxLevel);
  const out = new Map<string, MipNode>();
  for (let level = minLevel; level <= maxLevel; level++) {
    const f = farFineOf({ level, nx: 0, ny: 0, nz: 0 }, build.scale, minLevel);
    const S = f === null ? 1 : f.scale;
    const source = f === null ? level : f.level;
    const F = edge * S;
    const A = (DISTANCE_BRICK_BAND_VOXELS + 1) * S + 1;
    for (const m of changed) {
      if (m.level !== source) continue;
      const at = [m.nx, m.ny, m.nz];
      const from = at.map((v) => Math.ceil((v * edge - A - F + 1) / F));
      const to = at.map((v) => Math.floor(((v + 1) * edge - 1 + A) / F));
      for (let nx = from[0]!; nx <= to[0]!; nx++) for (let ny = from[1]!; ny <= to[1]!; ny++) for (let nz = from[2]!; nz <= to[2]!; nz++) out.set(`${level}:${nx},${ny},${nz}`, { level, nx, ny, nz });
    }
  }
  return [...out.values()].sort((a, b) => a.level - b.level || a.nx - b.nx || a.ny - b.ny || a.nz - b.nz);
}

/** A baked node's bricks from its stored entry (null: none stored: a node with nothing to draw). */
export function bakedFarBricks(edge: number, baked: StoredChunk | null, decompress: (b: Uint8Array) => Uint8Array): FarBricks {
  if (baked === null) {
    const side = edge / DISTANCE_BRICK_CELLS;
    return { side, bricks: new Int32Array(side ** 3).fill(DISTANCE_BRICK_OUTSIDE), samples: new Uint8Array(0), looks: new Uint16Array(0), blocks: new Uint8Array(0), bounds: new Uint8Array(0) };
  }
  if ('uniform' in baked) throw new RangeError('far bricks: a baked node is never a uniform entry');
  return decodeFarBricks(baked.raw ? baked.stored : decompress(baked.stored));
}
