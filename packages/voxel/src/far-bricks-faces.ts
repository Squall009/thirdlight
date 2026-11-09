/**
 * Far bricks from the faces of finer cells (far-bricks.ts `faces` build):
 * a far node's bricks whose samples are the exact signed distance to the
 * solid cells' faces, read from the node's descendants `scale` times finer
 * than its own cells.
 *
 * Why: the node's own cells are a mip, each one standing for 8^k finer
 * cells, and the occupancy field (far-bricks.ts) averages each corner over
 * eight of them, so a roof or a rock a cell or two across is averaged away
 * and a slope sits up to a cell off where the finer cells put it. Here a
 * corner touching both a solid and an air cell is on the surface (0), any
 * other corner takes its Euclidean distance to the nearest corner of the
 * other kind (the nearest point of a union of whole cells from a lattice
 * point is a lattice point), so a one-cell body keeps a body and the field
 * stays a true distance at the node's sample spacing.
 *
 * A sample's look is the material most surface cells round it show (a
 * cell with air above counted twice, so tops win over the sides of steps),
 * read over the finer cells the sample's trilinear footprint covers: the
 * colour of a sample is its neighbourhood's, not one cell's.
 */
import type { ChunkGrid } from './coords';
import { BRICK_HIT_VOXELS, DISTANCE_BRICK_BAND_VOXELS, DISTANCE_BRICK_CELLS, DISTANCE_BRICK_INSIDE, DISTANCE_BRICK_OUTSIDE, DISTANCE_BRICK_SAMPLES, DISTANCE_BRICK_SIDE, sampleOfDistance } from './distance-brick-format';
import { brickFarNode, FAR_BRICK_BLOCK_BYTES, FAR_BRICK_BOUNDS_BYTES, squaredDistances, type FarBricks } from './far-bricks';
import { withFarNeighbourhood, type FarMeshInput } from './far-mesh';
import type { PaletteStore } from './palette-store';
import { fillLevel, MATERIAL_AIR, MATERIAL_BITS, SHAPE_FULL, VOXEL_ROLE, type VoxelRecord } from './record';
import { regionChunkCodecBytes } from './region-file';

/** The finest source a `faces` build reads: cells this many times finer than the node's an axis. */
export const FAR_BRICK_SCALE_MAX = 4;

/** Whether a brick's samples put the surface on one of its faces (a whole face of samples within a hit of 0). */
function surfaceOnFace(values: Float32Array): boolean {
  const T = DISTANCE_BRICK_SIDE;
  const last = T - 1;
  for (let axis = 0; axis < 3; axis++) for (const at of [0, last]) {
    let near = 0;
    for (let u = 0; u < T; u++) for (let v = 0; v < T; v++) {
      const c = axis === 0 ? [at, u, v] : axis === 1 ? [u, at, v] : [u, v, at];
      if (values[(c[2]! * T + c[1]!) * T + c[0]!]! > -BRICK_HIT_VOXELS) near++;
    }
    if (near > 0) return true;
  }
  return false;
}

/**
 * A far brick job: the node's bricks by its build (the occupancy build, or
 * faces from its own cells or from the finer cells it carries), from
 * `store` (a scratch store: the job's entries are put in and taken out
 * again before it returns).
 */
export function brickFarNodeBy(store: PaletteStore, input: Pick<FarMeshInput, 'cells' | 'level' | 'node' | 'build' | 'fine'>, decompress: (b: Uint8Array) => Uint8Array): FarBricks {
  const b = input.build;
  if (b === undefined || b.field === 'occupancy') return brickFarNode(store, input, decompress);
  const side = store.grid.edge / DISTANCE_BRICK_CELLS;
  const none = (): FarBricks => ({ side, bricks: new Int32Array(side ** 3).fill(DISTANCE_BRICK_OUTSIDE), samples: new Uint8Array(0), looks: new Uint16Array(0), blocks: new Uint8Array(0), bounds: new Uint8Array(0) });
  const f = input.fine;
  if (f === undefined || f.scale === 1) return withFarNeighbourhood(store, input, decompress, () => farBricksFromFaces(store.grid, store, input.node, 1), none);
  const S = f.scale;
  if (f.cells.length !== (S + 2) ** 3) throw new RangeError(`far bricks: ${f.cells.length} finer cells for scale ${S}`);
  const g = store.grid;
  const placed: Array<[number, number, number]> = [];
  try {
    let any = false;
    let k = 0;
    for (let dx = -1; dx <= S; dx++) for (let dz = -1; dz <= S; dz++) for (let dy = -1; dy <= S; dy++, k++) {
      const c = f.cells[k];
      if (c == null) continue;
      const at: [number, number, number] = [input.node[0] * S + dx, input.node[1] * S + dy, input.node[2] * S + dz];
      const read = 'uniform' in c ? (c.uniform === 0 ? null : ({ cx: at[0], cy: at[1], cz: at[2], kind: 'uniform', value: c.uniform } as const)) : ({ cx: at[0], cy: at[1], cz: at[2], kind: 'stored', bytes: c.stored, raw: c.raw } as const);
      if (read === null) continue;
      const codec = regionChunkCodecBytes(g, read, decompress);
      if (codec === null) continue;
      store.decodeChunk(at[0], at[1], at[2], codec);
      placed.push(at);
      if (dx >= 0 && dx < S && dy >= 0 && dy < S && dz >= 0 && dz < S) any = true;
    }
    return any ? farBricksFromFaces(g, store, input.node, S) : none();
  } finally {
    for (const [x, y, z] of placed) store.dropChunk(x, y, z);
  }
}

/**
 * The bricks of the node at `node` (its level's coordinates) from `store`,
 * which holds the cells `scale` times finer (the node's descendants and
 * theirs round it, at least one fine node deep on every side).
 */
export function farBricksFromFaces(g: ChunkGrid, store: PaletteStore, node: readonly [number, number, number], scale: number): FarBricks {
  if (!Number.isInteger(scale) || scale < 1 || scale > FAR_BRICK_SCALE_MAX || (scale & (scale - 1)) !== 0) throw new RangeError(`far bricks: scale ${scale}`);
  const e = g.edge;
  if (e % DISTANCE_BRICK_CELLS !== 0) throw new RangeError(`far bricks: a chunk edge of ${e} cells is not whole bricks`);
  const side = e / DISTANCE_BRICK_CELLS;
  const S = scale;
  const band = DISTANCE_BRICK_BAND_VOXELS;
  // Fine cells read round the node: the band at the node's spacing, and one more cell for the corners on its edge.
  const A = (band + 1) * S + 1;
  const F = e * S;
  const n = F + 2 * A;
  const n2 = n * n;
  const m = n + 1;
  const m2 = m * m;
  const base = [node[0] * F - A, node[1] * F - A, node[2] * F - A];
  const solid = new Uint8Array(n2 * n);
  const density = new Float32Array(n2 * n);
  const word = new Uint16Array(n2 * n);
  const v: VoxelRecord = { material: 0, role: 0, shape: 0, wetness: 0 };
  let count = 0;
  for (let z = 0; z < n; z++) for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
    store.voxelAt(base[0]! + x, base[1]! + y, base[2]! + z, v);
    if (v.material === MATERIAL_AIR || v.role === VOXEL_ROLE.liquid) continue;
    const i = (z * n + y) * n + x;
    density[i] = fillLevel(v.role, v.shape) / SHAPE_FULL;
    if (density[i]! < 0.5) continue;
    solid[i] = 1;
    word[i] = v.material | (v.wetness << MATERIAL_BITS);
    count++;
  }
  const empty = (fill: number): FarBricks => ({ side, bricks: new Int32Array(side ** 3).fill(fill), samples: new Uint8Array(0), looks: new Uint16Array(0), blocks: new Uint8Array(0), bounds: new Uint8Array(0) });
  if (count === 0) return empty(DISTANCE_BRICK_OUTSIDE);
  if (count === solid.length) return empty(DISTANCE_BRICK_INSIDE);
  // Corners touching a solid cell, and corners touching an air cell (a corner touches the up to 8 cells round it).
  const touchSolid = new Uint8Array(m2 * m);
  const touchAir = new Uint8Array(m2 * m);
  for (let z = 0; z < n; z++) for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
    const into = solid[(z * n + y) * n + x] === 1 ? touchSolid : touchAir;
    const c = (z * m + y) * m + x;
    into[c] = into[c + 1] = into[c + m] = into[c + m + 1] = into[c + m2] = into[c + m2 + 1] = into[c + m2 + m] = into[c + m2 + m + 1] = 1;
  }
  const toSolid = squaredDistances(touchSolid, m, 1);
  const toAir = squaredDistances(touchAir, m, 1);
  // Surface cells by how they show: 2 with air above, 1 with air at a side or below, 0 hidden or air.
  const shown = new Uint8Array(n2 * n);
  for (let z = 1; z < n - 1; z++) for (let y = 1; y < n - 1; y++) for (let x = 1; x < n - 1; x++) {
    const i = (z * n + y) * n + x;
    if (solid[i] !== 1) continue;
    if (solid[i + n] === 0) shown[i] = 2;
    else if (solid[i - n] === 0 || solid[i + 1] === 0 || solid[i - 1] === 0 || solid[i + n2] === 0 || solid[i - n2] === 0) shown[i] = 1;
  }
  /**
   * A surface corner's offset by the fill of the 8 cells round it (lowest at `i`): ½ less their mean fill, as the
   * occupancy build moves a cell next to air, so a ¾-full top layer's surface sits ¾ up it (a whole cell's convex
   * edges and corners round off by up to ⅜ of a finer cell, which the finer source makes small).
   */
  const fillOffset = (i: number): number => 0.5 - (density[i]! + density[i + 1]! + density[i + n]! + density[i + n + 1]! + density[i + n2]! + density[i + n2 + 1]! + density[i + n2 + n]! + density[i + n2 + n + 1]!) / 8;
  /** The signed distance (node cells) at node corner (cx, cy, cz), 0–e an axis. */
  const at = (cx: number, cy: number, cz: number): number => {
    const c = ((cz * S + A) * m + cy * S + A) * m + cx * S + A;
    if (touchSolid[c] === 1 && touchAir[c] === 1) {
      return fillOffset(((cz * S + A - 1) * n + cy * S + A - 1) * n + cx * S + A - 1) / S;
    }
    return (touchSolid[c] === 1 ? -Math.sqrt(toAir[c]!) : Math.sqrt(toSolid[c]!)) / S;
  };
  const words: number[] = [];
  const weights: number[] = [];
  /** The look of node corner (cx, cy, cz): the material most shown cells round it show; −1 when none shows. */
  const look = (cx: number, cy: number, cz: number): number => {
    words.length = 0;
    weights.length = 0;
    const x0 = cx * S + A - S, y0 = cy * S + A - S, z0 = cz * S + A - S;
    for (let z = z0; z < z0 + 2 * S; z++) for (let y = y0; y < y0 + 2 * S; y++) for (let x = x0; x < x0 + 2 * S; x++) {
      const i = (z * n + y) * n + x;
      const w = shown[i]!;
      if (w === 0) continue;
      const k = words.indexOf(word[i]!);
      if (k < 0) {
        words.push(word[i]!);
        weights.push(w);
      } else weights[k]! += w;
    }
    let best = -1;
    let bestW = 0;
    for (let k = 0; k < words.length; k++) if (weights[k]! > bestW) {
      bestW = weights[k]!;
      best = words[k]!;
    }
    return best;
  };
  const C = DISTANCE_BRICK_CELLS;
  const T = DISTANCE_BRICK_SIDE;
  /** Solid finer cells inside brick (bx, by, bz). */
  const solidsIn = (bx: number, by: number, bz: number): number => {
    let k = 0;
    const x0 = bx * C * S + A, y0 = by * C * S + A, z0 = bz * C * S + A;
    for (let z = z0; z < z0 + C * S; z++) for (let y = y0; y < y0 + C * S; y++) {
      const row = (z * n + y) * n;
      for (let x = x0; x < x0 + C * S; x++) k += solid[row + x]!;
    }
    return k;
  };
  const bricks = new Int32Array(side ** 3);
  const samples: Uint8Array[] = [];
  const looks: Uint16Array[] = [];
  const blocks: number[] = [];
  const bounds: number[] = [];
  const values = new Float32Array(DISTANCE_BRICK_SAMPLES);
  let lastLook = 0;
  for (let bz = 0; bz < side; bz++) for (let by = 0; by < side; by++) for (let bx = 0; bx < side; bx++) {
    let lo = Infinity;
    let hi = -Infinity;
    for (let sz = 0; sz < T; sz++) for (let sy = 0; sy < T; sy++) for (let sx = 0; sx < T; sx++) {
      const d = at(bx * C + sx, by * C + sy, bz * C + sz);
      values[(sz * T + sy) * T + sx] = d;
      if (d < lo) lo = d;
      if (d > hi) hi = d;
    }
    const b = (bz * side + by) * side + bx;
    // A surface on the brick's face (samples of 0 there) is drawn by the brick on its solid side, which a node always
    // has (a node of only air is not kept, so its side of a shared face would draw nothing): a brick holding no solid
    // cell draws nothing, one holding only solid cells draws only a surface on its faces.
    const held = solidsIn(bx, by, bz);
    if (lo > 0 || (held === 0 && lo >= 0)) {
      bricks[b] = DISTANCE_BRICK_OUTSIDE;
      continue;
    }
    if (hi < 0 || (held === (C * S) ** 3 && hi <= 0 && lo < 0 && !surfaceOnFace(values))) {
      bricks[b] = DISTANCE_BRICK_INSIDE;
      continue;
    }
    const block = new Uint8Array(DISTANCE_BRICK_SAMPLES);
    for (let k = 0; k < DISTANCE_BRICK_SAMPLES; k++) block[k] = sampleOfDistance(values[k]!, band);
    const lk = new Uint16Array(DISTANCE_BRICK_SAMPLES);
    for (let sz = 0; sz < T; sz++) for (let sy = 0; sy < T; sy++) for (let sx = 0; sx < T; sx++) {
      const w = look(bx * C + sx, by * C + sy, bz * C + sz);
      if (w >= 0) lastLook = w;
      lk[(sz * T + sy) * T + sx] = w >= 0 ? w : lastLook;
    }
    const faces = (bx === 0 ? 1 : 0) | (bx === side - 1 ? 2 : 0) | (by === 0 ? 4 : 0) | (by === side - 1 ? 8 : 0) | (bz === 0 ? 16 : 0) | (bz === side - 1 ? 32 : 0);
    // The cells a ray can hit in: those the surface crosses; on a node's side faces also the cells under it, where a
    // coarser neighbour lying lower shows the brick's side as a wall.
    const sideFaces = (faces & (1 | 2 | 16 | 32)) !== 0;
    const box = [C, C, C, 0, 0, 0];
    for (let z = 0; z < C; z++) for (let y = 0; y < C; y++) for (let x = 0; x < C; x++) {
      let cLo = Infinity;
      let cHi = -Infinity;
      for (let k = 0; k < 8; k++) {
        const d = values[((z + ((k >> 2) & 1)) * T + y + ((k >> 1) & 1)) * T + x + (k & 1)]!;
        if (d < cLo) cLo = d;
        if (d > cHi) cHi = d;
      }
      if (cLo >= BRICK_HIT_VOXELS || (cHi <= -BRICK_HIT_VOXELS && !sideFaces)) continue;
      box[0] = Math.min(box[0]!, x);
      box[1] = Math.min(box[1]!, y);
      box[2] = Math.min(box[2]!, z);
      box[3] = Math.max(box[3]!, x + 1);
      box[4] = Math.max(box[4]!, y + 1);
      box[5] = Math.max(box[5]!, z + 1);
    }
    if (box[3]! <= box[0]!) box.splice(0, 6, 0, 0, 0, C, C, C);
    bricks[b] = samples.length;
    samples.push(block);
    looks.push(lk);
    blocks.push(bx, by, bz, faces);
    bounds.push(...box);
  }
  const out = new Uint8Array(samples.length * DISTANCE_BRICK_SAMPLES);
  const outLooks = new Uint16Array(samples.length * DISTANCE_BRICK_SAMPLES);
  samples.forEach((s, i) => out.set(s, i * DISTANCE_BRICK_SAMPLES));
  looks.forEach((s, i) => outLooks.set(s, i * DISTANCE_BRICK_SAMPLES));
  if (blocks.length / FAR_BRICK_BLOCK_BYTES !== bounds.length / FAR_BRICK_BOUNDS_BYTES) throw new Error('far bricks: blocks and bounds parted');
  return { side, bricks, samples: out, looks: outLooks, blocks: Uint8Array.from(blocks), bounds: Uint8Array.from(bounds) };
}
