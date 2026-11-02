/**
 * Apron strips: the thin slabs of neighbouring chunks a job needs to see
 * around its own chunk, never whole neighbour chunks.
 *
 * A rule that looks up to R cells away (the assembly rules' dependency
 * radius) needs, around a chunk of edge E, the cells of the box
 * [−R, E + R)³ outside the chunk: 6 face slabs (E × E × R), 12 edge bars
 * (E × R × R) and 8 corner cubes (R³), one strip per neighbour. R is a
 * parameter of every job (the full rule catalogue decides it), never a
 * constant here; it may be at most E, so only the 26 touching neighbours
 * are involved.
 *
 * A strip whose neighbour is absent (air) or one voxel everywhere is a
 * single value, so the common case (sky above, rock below) costs a few
 * bytes; any other strip is its cells as voxel values (record.ts), in the
 * same x, z, y order (y fastest) as a chunk.
 */
import { chunkInWorld, type CellGrid } from './coords';
import { readValue, valueOf, type VoxelRecord } from './record';
import type { VoxelStoreCandidate } from './store';

/** Strips around a chunk: one per touching neighbour. */
export const APRON_STRIPS = 26;

/** The cells a job sees around its chunk, R cells deep. */
export interface Apron {
  readonly edge: number;
  readonly radius: number;
  /** Per strip: 1 when its cells are stored, 0 when it is one value. */
  readonly dense: Uint8Array;
  /** Per strip: its one voxel value (uniform strips), else unused. */
  readonly uniform: Uint32Array;
  /** Per strip: where its cells start in `values` (27 entries; uniform strips take none). */
  readonly offsets: Uint32Array;
  readonly values: Uint32Array;
}

/** The axis band of a cell: 0 below the chunk, 1 inside, 2 above. */
function band(edge: number, l: number): number {
  return l < 0 ? 0 : l < edge ? 1 : 2;
}

/** Strip index of a neighbour offset (bands x, z, y), −1 for the chunk itself. */
const STRIP_OF = new Int8Array(27);
{
  let k = 0;
  for (let bx = 0; bx < 3; bx++) for (let bz = 0; bz < 3; bz++) for (let by = 0; by < 3; by++) {
    const i = bx * 9 + bz * 3 + by;
    STRIP_OF[i] = bx === 1 && by === 1 && bz === 1 ? -1 : k++;
  }
}

/** Per strip: its bands (x, z, y). */
const BANDS: Array<[number, number, number]> = [];
for (let i = 0; i < 27; i++) if (STRIP_OF[i]! >= 0) BANDS[STRIP_OF[i]!] = [Math.floor(i / 9), Math.floor(i / 3) % 3, i % 3];

function bandStart(edge: number, radius: number, b: number): number {
  return b === 0 ? -radius : b === 1 ? 0 : edge;
}

function bandSize(edge: number, radius: number, b: number): number {
  return b === 1 ? edge : radius;
}

/** Cells in an apron of radius R around a chunk of edge E (what a fully stored apron costs). */
export function apronCellCount(edge: number, radius: number): number {
  const s = edge + 2 * radius;
  return s * s * s - edge * edge * edge;
}

/** Throws unless R fits the chunk edge (0 ≤ R ≤ E, an integer). */
export function checkRadius(edge: number, radius: number): void {
  if (!Number.isInteger(radius) || radius < 0 || radius > edge) throw new RangeError(`dependency radius ${radius} must be an integer in 0 … ${edge}`);
}

/**
 * The apron of radius R around chunk (cx, cy, cz) of `store`, read from its
 * neighbours. `known` says whether a neighbour's content is known (loaded,
 * or known to be air); an apron over an unknown neighbour would be wrong,
 * so it throws instead. Neighbours outside the world are air.
 */
export function buildApron(store: VoxelStoreCandidate, cx: number, cy: number, cz: number, radius: number, known?: (cx: number, cy: number, cz: number) => boolean): Apron {
  const grid = store.grid;
  const edge = grid.edge;
  checkRadius(edge, radius);
  const dense = new Uint8Array(APRON_STRIPS);
  const uniform = new Uint32Array(APRON_STRIPS);
  const offsets = new Uint32Array(APRON_STRIPS + 1);
  let cells = 0;
  const v: VoxelRecord = { material: 0, role: 0, shape: 0, wetness: 0 };
  for (let k = 0; k < APRON_STRIPS; k++) {
    const [bx, bz, by] = BANDS[k]!;
    const nx = cx + bx - 1;
    const ny = cy + by - 1;
    const nz = cz + bz - 1;
    offsets[k] = cells;
    if (radius === 0 || !chunkInWorld(grid, nx, ny, nz)) continue;
    if (known !== undefined && !known(nx, ny, nz)) throw new RangeError(`apron of (${cx}, ${cy}, ${cz}): neighbour (${nx}, ${ny}, ${nz}) is not known`);
    const form = store.chunkForm?.(nx, ny, nz) ?? 'stored';
    if (form === 'absent') continue;
    if (form === 'uniform') {
      store.voxelAt(nx << grid.shift, ny << grid.shift, nz << grid.shift, v);
      uniform[k] = valueOf(v);
      continue;
    }
    dense[k] = 1;
    cells += bandSize(edge, radius, bx) * bandSize(edge, radius, bz) * bandSize(edge, radius, by);
  }
  offsets[APRON_STRIPS] = cells;
  const values = new Uint32Array(cells);
  const ox = cx << grid.shift;
  const oy = cy << grid.shift;
  const oz = cz << grid.shift;
  for (let k = 0; k < APRON_STRIPS; k++) {
    if (dense[k] === 0) continue;
    const [bx, bz, by] = BANDS[k]!;
    const x0 = bandStart(edge, radius, bx);
    const z0 = bandStart(edge, radius, bz);
    const y0 = bandStart(edge, radius, by);
    const sx = bandSize(edge, radius, bx);
    const sz = bandSize(edge, radius, bz);
    const sy = bandSize(edge, radius, by);
    let i = offsets[k]!;
    for (let x = 0; x < sx; x++) for (let z = 0; z < sz; z++) for (let y = 0; y < sy; y++, i++) {
      store.voxelAt(ox + x0 + x, oy + y0 + y, oz + z0 + z, v);
      values[i] = valueOf(v);
    }
  }
  return { edge, radius, dense, uniform, offsets, values };
}

/** The apron's buffers, for a postMessage transfer list. */
export function apronTransfer(a: Apron, out: ArrayBuffer[] = []): ArrayBuffer[] {
  for (const arr of [a.dense, a.uniform, a.offsets, a.values]) if (arr.buffer instanceof ArrayBuffer && !out.includes(arr.buffer)) out.push(arr.buffer);
  return out;
}

/** Bytes an apron's arrays hold. */
export function apronBytes(a: Apron): number {
  return a.dense.byteLength + a.uniform.byteLength + a.offsets.byteLength + a.values.byteLength;
}

/** Throws unless an apron's arrays are consistent (a damaged message is refused, not read out of range). */
export function checkApron(a: Apron): void {
  checkRadius(a.edge, a.radius);
  if (a.dense.length !== APRON_STRIPS || a.uniform.length !== APRON_STRIPS || a.offsets.length !== APRON_STRIPS + 1) throw new RangeError('apron: strip tables of the wrong length');
  let cells = 0;
  for (let k = 0; k < APRON_STRIPS; k++) {
    if (a.offsets[k] !== cells) throw new RangeError(`apron: strip ${k} offset`);
    if (a.dense[k] === 1) {
      const [bx, bz, by] = BANDS[k]!;
      cells += bandSize(a.edge, a.radius, bx) * bandSize(a.edge, a.radius, bz) * bandSize(a.edge, a.radius, by);
    } else if (a.dense[k] !== 0) throw new RangeError(`apron: strip ${k} flag`);
  }
  if (a.offsets[APRON_STRIPS] !== cells || a.values.length !== cells) throw new RangeError('apron: cell arrays do not match the strips');
}

/**
 * Reads the apron cell at chunk-local (lx, ly, lz), each in [−R, E + R) and
 * outside the chunk itself, into `out`.
 */
export function apronVoxelAt(a: Apron, lx: number, ly: number, lz: number, out: VoxelRecord): VoxelRecord {
  const e = a.edge;
  const r = a.radius;
  const bx = band(e, lx);
  const by = band(e, ly);
  const bz = band(e, lz);
  const k = STRIP_OF[bx * 9 + bz * 3 + by]!;
  if (k < 0 || lx < -r || ly < -r || lz < -r || lx >= e + r || ly >= e + r || lz >= e + r) throw new RangeError(`apron cell (${lx}, ${ly}, ${lz}) is outside the apron`);
  if (a.dense[k] === 0) return readValue(a.uniform[k]!, out);
  const sz = bandSize(e, r, bz);
  const sy = bandSize(e, r, by);
  return readValue(a.values[a.offsets[k]! + ((lx - bandStart(e, r, bx)) * sz + (lz - bandStart(e, r, bz))) * sy + (ly - bandStart(e, r, by))]!, out);
}

/**
 * Every chunk whose result can depend on cells in `box` under radius R:
 * the chunks overlapping the box grown by R on every side (and inside the
 * world). An edit near a chunk corner reaches the 7 chunks around that
 * corner; a box spanning a chunk reaches all 26 neighbours.
 */
export function dependentChunks(grid: CellGrid, box: { minX: number; minY: number; minZ: number; maxX: number; maxY: number; maxZ: number }, radius: number): Array<{ cx: number; cy: number; cz: number }> {
  checkRadius(grid.edge, radius);
  const out: Array<{ cx: number; cy: number; cz: number }> = [];
  const s = grid.shift;
  for (let cx = (box.minX - radius) >> s; cx <= (box.maxX + radius) >> s; cx++) {
    for (let cz = (box.minZ - radius) >> s; cz <= (box.maxZ + radius) >> s; cz++) {
      for (let cy = (box.minY - radius) >> s; cy <= (box.maxY + radius) >> s; cy++) if (chunkInWorld(grid, cx, cy, cz)) out.push({ cx, cy, cz });
    }
  }
  return out;
}
