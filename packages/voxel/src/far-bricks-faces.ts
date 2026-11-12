/**
 * Far bricks from the faces of finer cells (far-bricks.ts `FarBrickBuild`):
 * a far node's bricks whose samples are the exact signed distance to the
 * solid cells' faces, read from the node's descendants `scale` times finer
 * than its own cells.
 *
 * Why: the node's own cells are a mip, each one standing for 8^k finer
 * cells, and a field of cell-centre distances averaged into each corner
 * over eight of them (the first build) averaged a roof or a rock a cell or
 * two across away and set a slope up to a cell off where the finer cells
 * put it. Here a
 * corner touching both a solid and an air cell is on the surface (0), any
 * other corner takes its Euclidean distance to the nearest corner of the
 * other kind (the nearest point of a union of whole cells from a lattice
 * point is a lattice point), so a one-cell body keeps a body and the field
 * stays a true distance at the node's sample spacing.
 *
 * A sample's look is the material most top cells round it show (a top
 * under half full included: it is not solid, but it is what the ground
 * shows), else, with no top in reach, the one most other surface cells
 * show, read over the finer cells the sample's trilinear footprint covers:
 * the colour of a sample is its neighbourhood's, not one cell's, and a
 * slope's step risers do not paint it the subsoil's.
 */
import { decodeDenseChunk } from './cell-delta';
import { chunkInWorld, type ChunkGrid } from './coords';
import { createDenseChunk, type DenseChunk } from './dense-chunk';
import { BRICK_HIT_VOXELS, DISTANCE_BRICK_BAND_VOXELS, DISTANCE_BRICK_CELLS, DISTANCE_BRICK_INSIDE, DISTANCE_BRICK_OUTSIDE, DISTANCE_BRICK_SAMPLES, DISTANCE_BRICK_SIDE, sampleOfDistance } from './distance-brick-format';
import { DISTANCE_NONE, FAR_BRICK_BLOCK_BYTES, FAR_BRICK_BOUNDS_BYTES, squaredDistanceLines, type FarBricks } from './far-bricks';
import { farBrickOcclusion } from './far-bricks-shade';
import { withFarNeighbourhood, type FarMeshInput } from './far-mesh';
import type { PaletteStore } from './palette-store';
import { SHADER_CONSTRUCTION_BIT } from './derived-shader';
import { fillLevel, isConstructionRole, MATERIAL_AIR, MATERIAL_BITS, recordValue, SHAPE_FULL, valueMaterial, valueRole, valueShape, valueWetness, VOXEL_ROLE } from './record';
import { OPEN_ROLE } from './assembly';
import { FAR_ROOF_COLUMN, FAR_ROOF_READ_PAD, farRoofColumns, farRoofDistance, type FarRoofColumns } from './far-bricks-roofs';
import { isRoofCellValue } from './roof-words';
import { regionChunkCodecBytes } from './region-file';

/**
 * A shown cell's vote by how it shows (none, side, top) in a corner's footprint, and a top's a node cell above or
 * below it: the footprint's tops outweigh every top beyond it, and those every side (a footprint and its rows above
 * and below hold at most (2 · 4)³ = 512 finer cells each, so each step is over 512 times the one below).
 */
const TOP_VOTE = [0, 1, 1 << 20] as const;
const NEAR_TOP_VOTE = 1 << 10;

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
 * A far brick job: the node's bricks from the finer cells it carries (the
 * build's scale), else from its own cells, from `store` (a scratch store:
 * the job's entries are put in and taken out again before it returns).
 */
export function brickFarNodeBy(store: PaletteStore, input: Pick<FarMeshInput, 'cells' | 'level' | 'node' | 'build' | 'fine'>, decompress: (b: Uint8Array) => Uint8Array): FarBricks {
  const out = bricksBy(store, input, decompress);
  // The occlusion is the field's alone, so it is baked here, off the page's thread, for a draw that shades from baked samples.
  return input.build?.occlusion === true ? { ...out, occlusion: farBrickOcclusion(out) } : out;
}

function bricksBy(store: PaletteStore, input: Pick<FarMeshInput, 'cells' | 'level' | 'node' | 'build' | 'fine'>, decompress: (b: Uint8Array) => Uint8Array): FarBricks {
  const g = store.grid;
  const side = g.edge / DISTANCE_BRICK_CELLS;
  const none = (): FarBricks => ({ side, bricks: new Int32Array(side ** 3).fill(DISTANCE_BRICK_OUTSIDE), samples: new Uint8Array(0), looks: new Uint16Array(0), blocks: new Uint8Array(0), bounds: new Uint8Array(0) });
  const f = input.fine;
  if (f === undefined || f.scale === 1) return withFarNeighbourhood(store, input, decompress, () => farBricksFromFaces(g, store, input.node, 1), none);
  const S = f.scale;
  if (f.cells.length !== (S + 2) ** 3) throw new RangeError(`far bricks: ${f.cells.length} finer cells for scale ${S}`);
  // The finer entries are decoded straight to dense cells as the build reads them, never put in a store: a store
  // read a cell at a time was most of the job.
  const [nx, ny, nz] = input.node;
  let any = false;
  for (let dx = 0; dx < S && !any; dx++) for (let dz = 0; dz < S && !any; dz++) for (let dy = 0; dy < S && !any; dy++) {
    const c = f.cells[((dx + 1) * (S + 2) + dz + 1) * (S + 2) + dy + 1];
    if (c != null && !('uniform' in c && c.uniform === 0)) any = true;
  }
  if (!any) return none();
  const chunkCells: ChunkCells = (cx, cy, cz, out) => {
    const dx = cx - nx * S, dy = cy - ny * S, dz = cz - nz * S;
    if (dx < -1 || dx > S || dy < -1 || dy > S || dz < -1 || dz > S) return false;
    const c = f.cells[((dx + 1) * (S + 2) + dz + 1) * (S + 2) + dy + 1];
    if (c == null) return false;
    if ('uniform' in c) {
      if (c.uniform === 0) return false;
      out.material.fill(valueMaterial(c.uniform));
      out.role.fill(valueRole(c.uniform));
      out.shape.fill(valueShape(c.uniform));
      out.wetness.fill(valueWetness(c.uniform));
      return true;
    }
    const codec = regionChunkCodecBytes(g, { cx, cy, cz, kind: 'stored', bytes: c.stored, raw: c.raw }, decompress);
    if (codec === null) return false;
    decodeDenseChunk(g, codec, out);
    return true;
  };
  return facesFromChunks(g, chunkCells, input.node, S);
}

/** A job's cells a chunk at a time: chunk (cx, cy, cz) into `out`; false when it holds none (air, absent, not kept). */
export type ChunkCells =(cx: number, cy: number, cz: number, out: DenseChunk) => boolean;

/**
 * The bricks of the node at `node` (its level's coordinates) from `store`,
 * which holds the cells `scale` times finer (the node's descendants and
 * theirs round it, at least one fine node deep on every side).
 */
export function farBricksFromFaces(g: ChunkGrid, store: PaletteStore, node: readonly [number, number, number], scale: number): FarBricks {
  return facesFromChunks(g, (cx, cy, cz, out) => chunkInWorld(g, cx, cy, cz) && store.exportChunk(cx, cy, cz, out), node, scale);
}

/**
 * The cells a far node's bricks are made from (x fastest, then y, then z; `n` a side): the node's own `scale` times
 * finer and {@link FarCellBlock.apron} more round it, each one's fill as a density 0–1, its look word (material |
 * wetness << 12; 0 where nothing is), and whether it is solid (half full or more). The CPU build and the GPU build
 * (three-adapter voxel-fine-bricks.ts) read the same block.
 */
export interface FarCellBlock {
  readonly n: number;
  /** Finer cells read past the node on each side: the band at the node's spacing, and one more for its edge's corners. */
  readonly apron: number;
  readonly scale: number;
  readonly density: Float32Array;
  readonly word: Uint16Array;
  readonly solid: Uint8Array;
  /** Solid cells. */
  readonly count: number;
  /**
   * Sloped roofs drawn as the roof mesher's planes (far-bricks-roofs.ts; fine blocks only): the columns' plane cells,
   * which read as air in `density` and `solid` and keep their look word. Null: none.
   */
  readonly roofs: FarRoofColumns | null;
}

/** Finer cells a far node's block reads past the node on each side at a build scale ({@link FarCellBlock.apron}). */
export function farCellApron(scale: number): number {
  return (DISTANCE_BRICK_BAND_VOXELS + 1) * scale + 1;
}

/** Scratch of a fine gather: per cell of the block and {@link FAR_ROOF_READ_PAD} round it, bit 0 solid, bit 1 a roof cell. */
let roofScratch = new Uint8Array(0);

/**
 * The cell block of the node at `node` (its level's coordinates) at `scale`, read a chunk at a time. `fine`: the
 * block of a fine node, textured and shaped as the near surface is: a construction cell's word also carries
 * {@link SHADER_CONSTRUCTION_BIT} (the near surface's grid entry, above the wetness), so the samples know a wall from
 * the ground of the same material, and sloped roofs are the roof mesher's planes ({@link FarCellBlock.roofs}). The
 * far cache's builds leave both out (their words index the far palette; their levels re-lay roofs in the mip).
 */
export function gatherFarCells(g: ChunkGrid, chunkCells: ChunkCells, node: readonly [number, number, number], scale: number, fine = false): FarCellBlock {
  if (!Number.isInteger(scale) || scale < 1 || scale > FAR_BRICK_SCALE_MAX || (scale & (scale - 1)) !== 0) throw new RangeError(`far bricks: scale ${scale}`);
  const e = g.edge;
  if (e % DISTANCE_BRICK_CELLS !== 0) throw new RangeError(`far bricks: a chunk edge of ${e} cells is not whole bricks`);
  const S = scale;
  const A = farCellApron(S);
  const F = e * S;
  const n = F + 2 * A;
  const n2 = n * n;
  const base = [node[0] * F - A, node[1] * F - A, node[2] * F - A];
  const solid = new Uint8Array(n2 * n);
  const density = new Float32Array(n2 * n);
  const word = new Uint16Array(n2 * n);
  let count = 0;
  const sh = g.shift;
  const mask = e - 1;
  const cell = createDenseChunk(g);
  // A fine block also reads the cells a little past its side for the roofs' reading.
  const pad = fine ? FAR_ROOF_READ_PAD : 0;
  const np = n + 2 * pad;
  if (fine && roofScratch.length < np ** 3) roofScratch = new Uint8Array(np ** 3);
  const flags = roofScratch;
  if (fine) flags.fill(0, 0, np ** 3);
  let anyRoof = false;
  const [bx0, by0, bz0] = base as [number, number, number];
  const [px0, py0, pz0] = [bx0 - pad, by0 - pad, bz0 - pad];
  for (let cx = px0 >> sh; cx <= (px0 + np - 1) >> sh; cx++) for (let cz = pz0 >> sh; cz <= (pz0 + np - 1) >> sh; cz++) for (let cy = py0 >> sh; cy <= (py0 + np - 1) >> sh; cy++) {
    if (!chunkCells(cx, cy, cz, cell)) continue;
    const { material, role, shape, wetness } = cell;
    const x1 = Math.min(px0 + np, (cx + 1) * e), y1 = Math.min(py0 + np, (cy + 1) * e), z1 = Math.min(pz0 + np, (cz + 1) * e);
    const y0 = Math.max(py0, cy * e);
    for (let x = Math.max(px0, cx * e); x < x1; x++) for (let z = Math.max(pz0, cz * e); z < z1; z++) {
      const column = (((x & mask) << sh) | (z & mask)) << sh;
      const inXZ = x >= bx0 && x < bx0 + n && z >= bz0 && z < bz0 + n;
      const row = (z - bz0) * n2 + (x - bx0);
      for (let y = y0; y < y1; y++) {
        const li = column | (y & mask);
        const m = material[li]!;
        const r = role[li]!;
        if (m === MATERIAL_AIR || r === VOXEL_ROLE.liquid) continue;
        const fill = fillLevel(r, shape[li]!);
        if (fine) {
          const f = ((z - pz0) * np + (y - py0)) * np + (x - px0);
          // Only a roof cell's value is read (its damage stage): the rest of the block pays a flag.
          const roof = r === VOXEL_ROLE.roof && isRoofCellValue(recordValue(m, r, shape[li]!, wetness[li]!));
          flags[f] = (OPEN_ROLE[r] !== 1 && fill * 2 >= SHAPE_FULL ? 1 : 0) | (roof ? 2 : 0);
          if (roof) anyRoof = true;
        }
        if (!inXZ || y < by0 || y >= by0 + n) continue;
        const i = row + (y - by0) * n;
        density[i] = fill / SHAPE_FULL;
        if (density[i] === 0) continue;
        word[i] = m | (wetness[li]! << MATERIAL_BITS) | (fine && isConstructionRole(r) ? SHADER_CONSTRUCTION_BIT : 0);
        if (density[i]! < 0.5) continue;
        solid[i] = 1;
        count++;
      }
    }
  }
  let roofs: FarRoofColumns | null = null;
  if (anyRoof) {
    const at = (x: number, y: number, z: number): number => flags[((z + pad) * np + y + pad) * np + x + pad]!;
    roofs = farRoofColumns(n, (x, y, z) => (at(x, y, z) & 2) !== 0, (x, y, z) => (at(x, y, z) & 1) !== 0);
    // A column's plane cell leaves the cell field (the roofs' own field draws it) and keeps its word for the looks.
    if (roofs !== null) for (let z = 0; z < n; z++) for (let x = 0; x < n; x++) {
      const c = roofs[z * n + x]!;
      if (c === 0) continue;
      const i = (z * n + (c & FAR_ROOF_COLUMN.yMask) - 1) * n + x;
      density[i] = 0;
      if (solid[i] === 1) count--;
      solid[i] = 0;
    }
  }
  return { n, apron: A, scale: S, density, word, solid, count, roofs };
}

/** {@link farBricksFromFaces} from cells read a chunk at a time. */
function facesFromChunks(g: ChunkGrid, chunkCells: ChunkCells, node: readonly [number, number, number], scale: number): FarBricks {
  return farBricksFromBlock(g, gatherFarCells(g, chunkCells, node, scale));
}

/** A far node's bricks from its cell block ({@link gatherFarCells}): the CPU build. */
export function farBricksFromBlock(g: ChunkGrid, block: FarCellBlock): FarBricks {
  const e = g.edge;
  const side = e / DISTANCE_BRICK_CELLS;
  const band = DISTANCE_BRICK_BAND_VOXELS;
  const { n, apron: A, scale: S, density, word, solid, count, roofs } = block;
  const n2 = n * n;
  const m = n + 1;
  const empty = (fill: number): FarBricks => ({ side, bricks: new Int32Array(side ** 3).fill(fill), samples: new Uint8Array(0), looks: new Uint16Array(0), blocks: new Uint8Array(0), bounds: new Uint8Array(0) });
  if (count === 0 && roofs === null) return empty(DISTANCE_BRICK_OUTSIDE);
  if (count === solid.length) return empty(DISTANCE_BRICK_INSIDE);
  const { toSolid, toAir } = spanDistances(density, n, S, A % S);
  // Cells by how they show: 2 a top (nothing above; a thin top cell too, which is not solid but is what the ground
  // shows, while the solid cell under it is not a top; a roof's plane cell, out of the field but what the roof shows),
  // 1 a solid cell with a non-solid cell at a side or below (a riser, a wall, an underside), 0 hidden or air.
  const shown = new Uint8Array(n2 * n);
  for (let z = 1; z < n - 1; z++) for (let y = 1; y < n - 1; y++) for (let x = 1; x < n - 1; x++) {
    const i = (z * n + y) * n + x;
    if (density[i] === 0) {
      if (word[i] !== 0) shown[i] = 2;
      continue;
    }
    if (density[i + n] === 0 && word[i + n] === 0) shown[i] = 2;
    else if (solid[i] === 1 && (solid[i + n] === 0 || solid[i - n] === 0 || solid[i + 1] === 0 || solid[i - 1] === 0 || solid[i + n2] === 0 || solid[i - n2] === 0)) shown[i] = 1;
  }
  /**
   * The signed distance (node cells) at node corner (cx, cy, cz), 0–e an axis. A corner on the surface whose 8 cells
   * are all whole (solid or air) is moved by ½ less their mean fill, so a staircase of whole cells (blocks, terraces
   * built of them) rounds its edges by up to ⅜ of a finer cell instead of drawing every step's edge sharp; part-full
   * cells are already where their fill puts them.
   */
  const at = (cx: number, cy: number, cz: number): number => {
    const c = ((cy + ((A / S) | 0)) * m + cz * S + A) * m + cx * S + A;
    const out = Math.sqrt(toSolid[c]!);
    const inside = Math.sqrt(toAir[c]!);
    if (out === 0 && inside === 0) {
      const i = ((cz * S + A - 1) * n + cy * S + A - 1) * n + cx * S + A - 1;
      let sum = 0;
      let whole = true;
      for (const k of [i, i + 1, i + n, i + n + 1, i + n2, i + n2 + 1, i + n2 + n, i + n2 + n + 1]) {
        const d = density[k]!;
        sum += d;
        if (d > 0 && d < 1) whole = false;
      }
      if (whole) {
        const d = (0.5 - sum / 8) / S;
        return roofs === null ? d : Math.min(d, farRoofDistance(roofs, n, cx * S + A, cy * S + A, cz * S + A, S) / S);
      }
    }
    const d = (out > 0 ? out : -inside) / S;
    return roofs === null ? d : Math.min(d, farRoofDistance(roofs, n, cx * S + A, cy * S + A, cz * S + A, S) / S);
  };
  const words: number[] = [];
  const weights: number[] = [];
  /**
   * The look of node corner (cx, cy, cz): the material most tops round it show, else (no top in reach: a cliff, a
   * wall) the one most other shown cells show; −1 when none shows. Tops first so a slope's step risers, which show
   * the subsoil, do not colour the slope.
   */
  const look = (cx: number, cy: number, cz: number): number => {
    words.length = 0;
    weights.length = 0;
    const x0 = cx * S + A - S, y0 = cy * S + A - S, z0 = cz * S + A - S;
    // Tops a node cell above and below the footprint vote too, under the footprint's own tops: a sample a cell off
    // the surface (it still colours the hit by its weight) would otherwise see only a riser's or nothing's.
    for (let z = z0; z < z0 + 2 * S; z++) for (let y = y0 - S; y < y0 + 3 * S; y++) for (let x = x0; x < x0 + 2 * S; x++) {
      const i = (z * n + y) * n + x;
      const w = y < y0 || y >= y0 + 2 * S ? (shown[i] === 2 ? NEAR_TOP_VOTE : 0) : TOP_VOTE[shown[i]!]!;
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

/**
 * Squared distances (finer cells) from the corners of an n³ block of finer
 * cells (`density` 0–1 a cell, y stride n, z stride n²) to its solid and
 * to its air, at the corners whose y is `from` plus a multiple of `every`
 * (all x and z; index `(k · (n + 1) + z) · (n + 1) + x` for the k-th such
 * y), exact at the corners whose x and z are on that lattice too.
 *
 * A part-full cell's solid is its fill as a height, laid from its fuller
 * vertical neighbour's side (from below on a tie), the rest of the cell
 * air: so a gentle slope's tops are a ramp of heights and its field a
 * slope, where whole-cell solids (fill over half) put a step of one finer
 * cell every few columns that the node's samples, twice as far apart,
 * turned into flat terraces and risers (light and dark bands on the slope).
 *
 * Why exact: the solid is a union of boxes whose x and z sides lie on the
 * corner lattice, so from a corner the nearest point of any of them has
 * lattice x and z and lies on one of the box's four vertical corner lines;
 * the distance along y to those lines' spans comes first (per corner line,
 * analytically), then the separable transform's x and z passes over it.
 */
export function spanDistances(density: Float32Array, n: number, every: number, from: number): { toSolid: Float32Array; toAir: Float32Array } {
  const m = n + 1;
  const n2 = n * n;
  // Each finer cell's solid span (cell units from its bottom): lowest and highest point, and its air's; none: NaN.
  const sLo = new Float32Array(n2 * n), sHi = new Float32Array(n2 * n), aLo = new Float32Array(n2 * n), aHi = new Float32Array(n2 * n);
  for (let i = 0; i < density.length; i++) {
    const d = density[i]!;
    if (d <= 0) {
      sLo[i] = sHi[i] = NaN;
      aLo[i] = 0;
      aHi[i] = 1;
    } else if (d >= 1) {
      sLo[i] = 0;
      sHi[i] = 1;
      aLo[i] = aHi[i] = NaN;
    } else {
      const y = ((i / n) | 0) % n;
      const above = y < n - 1 ? density[i + n]! : 0;
      const below = y > 0 ? density[i - n]! : 0;
      if (above > below) {
        sLo[i] = 1 - d;
        sHi[i] = 1;
        aLo[i] = 0;
        aHi[i] = 1 - d;
      } else {
        sLo[i] = 0;
        sHi[i] = d;
        aLo[i] = d;
        aHi[i] = 1;
      }
    }
  }
  const ks = Math.max(0, Math.floor((m - 1 - from) / every) + 1);
  const toSolid = new Float32Array(ks * m * m).fill(DISTANCE_NONE);
  const toAir = new Float32Array(ks * m * m).fill(DISTANCE_NONE);
  const lowS = new Float32Array(n), highS = new Float32Array(n), lowA = new Float32Array(n), highA = new Float32Array(n);
  const nearBelow = new Float64Array(ks);
  const cells = new Int32Array(4);
  for (let z = 0; z < m; z++) for (let x = 0; x < m; x++) {
    // The corner line's spans a cell: the union over the up to four cells round it.
    let count = 0;
    for (let cz = z - 1; cz <= z; cz++) for (let cx = x - 1; cx <= x; cx++) if (cx >= 0 && cx < n && cz >= 0 && cz < n) cells[count++] = cz * n2 + cx;
    for (let y = 0; y < n; y++) {
      let ls = Infinity, hs = -Infinity, la = Infinity, ha = -Infinity;
      for (let j = 0; j < count; j++) {
        const i = cells[j]! + y * n;
        if (sHi[i]! >= 0) {
          ls = Math.min(ls, sLo[i]!);
          hs = Math.max(hs, sHi[i]!);
        }
        if (aHi[i]! >= 0) {
          la = Math.min(la, aLo[i]!);
          ha = Math.max(ha, aHi[i]!);
        }
      }
      lowS[y] = y + ls;
      highS[y] = y + hs;
      lowA[y] = y + la;
      highA[y] = y + ha;
    }
    // Along the line: the nearest span below (the highest point of the cells under the corner) and above.
    const line = z * m + x;
    for (const [lo, hi, out] of [[lowS, highS, toSolid], [lowA, highA, toAir]] as const) {
      // A span's points lie inside its cell, so the nearest below a corner is the last cell under it holding one, the
      // nearest above the first over it: one pass up, one down.
      let below = -Infinity;
      let y = 0;
      for (let k = 0; k < ks; k++) {
        const Y = from + k * every;
        for (; y < Y; y++) if (hi[y]! > below) below = hi[y]!;
        nearBelow[k] = Y - below;
      }
      let above = Infinity;
      y = n - 1;
      for (let k = ks - 1; k >= 0; k--) {
        const Y = from + k * every;
        for (; y >= Y; y--) if (lo[y]! < above) above = lo[y]!;
        const dy = Math.min(nearBelow[k]!, above - Y);
        if (dy < Infinity) out[k * m * m + line] = dy * dy;
      }
    }
  }
  const lines = squaredDistanceLines(m);
  for (const out of [toSolid, toAir]) for (let k = 0; k < ks; k++) {
    for (let z = 0; z < m; z++) lines(out, (k * m + z) * m, 1); // x
    for (let x = from; x < m; x += every) lines(out, k * m * m + x, m); // z, on the lattice's x only
  }
  return { toSolid, toAir };
}
