/**
 * What one cell of a derived chunk looks like to each consumer: the base
 * surface faces drawn for it, the detail piece standing in it, its
 * collision (a full-cell box, a partial shape, the ground surface or
 * nothing), whether it blocks movement or can be stood in, its light
 * coverage and its render occupancy.
 *
 * Read from the derived outputs themselves, not from the assembly classes
 * (which live only inside the derive job), so it reports what the
 * renderer, physics, navigation and lighting actually receive. Tests and
 * the slice's acceptance hooks use it to show that the different resolved
 * cases (wall, beam, banister rail and post) come out differently for
 * every consumer from one evaluation.
 */
import { createNeighbourhood, evaluateAssembly, fillNeighbourhood, jobRadius, type AssemblyRuleSet } from './assembly';
import { buildApron } from './apron';
import { chunkOf, localOf, type ChunkGrid } from './coords';
import { createDenseChunk } from './dense-chunk';
import { cellBit, COLLISION_STEPS_PER_CELL, OCCUPANCY, type DerivedData } from './derived-data';
import { INSTANCE_BYTES, INSTANCE_FLAG, POSITION_STEPS_PER_CELL, SURFACE_VERTEX_BYTES } from './derived-mesh';
import type { VoxelStoreCandidate } from './store';

/** A cell's view through every consumer of a derived chunk. */
export interface CellOutputs {
  /** Render occupancy: solid for rendering and culling. */
  readonly renderSolid: boolean;
  /** Base surface quads emitted for this cell (exposed faces of a wall cell; 0 under a piece that replaces it). */
  readonly baseFaces: number;
  /** The detail piece in this cell, if any: family, run section, quarter turns, whether it replaces the base. */
  readonly piece: { readonly family: number; readonly section: number; readonly turns: number; readonly replacesBase: boolean } | null;
  /** `full`: inside a full-cell box; `partial`: a partial shape inside the cell; `none`: neither (ground collides as its surface). */
  readonly collision: 'full' | 'partial' | 'none';
  /** The partial shape's box in 1/16 cell within the cell (min x, y, z, max x, y, z), when `collision` is partial. */
  readonly partialBox: readonly number[] | null;
  /** Whether the cell blocks movement. */
  readonly navBlocks: boolean;
  /** Whether a walker can stand in the cell (free, on a supporting cell), and its headroom in cells. */
  readonly standable: boolean;
  readonly clearance: number;
  /** Light coverage 0 … 255. */
  readonly light: number;
}

function sortedIndex(list: Uint16Array, v: number): number {
  let lo = 0;
  let hi = list.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const m = list[mid]!;
    if (m === v) return mid;
    if (m < v) lo = mid + 1;
    else hi = mid - 1;
  }
  return -1;
}

/**
 * Faces of cell (lx, ly, lz) the base surface draws: per face direction, a
 * base triangle facing that way, in the face's plane, covering a point
 * inside the face (triangles may span many merged faces).
 */
function baseFacesOf(d: DerivedData, lx: number, ly: number, lz: number): number {
  const b = d.base;
  if (b.vertexCount === 0) return 0;
  const stride = SURFACE_VERTEX_BYTES;
  const view = new DataView(b.vertices.buffer, b.vertices.byteOffset, b.vertices.byteLength);
  const steps = POSITION_STEPS_PER_CELL;
  // Positions count from one cell below the chunk's corner.
  const at = (v: number, a: number): number => view.getUint16(v * stride + 2 * a, true) / steps - 1;
  const cell = [lx, ly, lz];
  let found = 0;
  for (let t = 0; t < b.indices.length; t += 3) {
    const i0 = b.indices[t]!, i1 = b.indices[t + 1]!, i2 = b.indices[t + 2]!;
    let axis = 0;
    while (axis < 3 && view.getInt8(i0 * stride + 8 + axis) === 0) axis++;
    if (axis === 3) continue;
    const sign = view.getInt8(i0 * stride + 8 + axis) > 0 ? 1 : 0;
    const bit = 1 << (2 * axis + sign);
    if ((found & bit) !== 0 || at(i0, axis) !== cell[axis]! + sign) continue;
    const u = (axis + 1) % 3;
    const w = (axis + 2) % 3;
    // A point inside the face, off every line through two lattice points of the chunk.
    const pu = cell[u]! + 0.3183;
    const pw = cell[w]! + 0.5772;
    const side = (p: number, q: number): number => (at(q, u) - at(p, u)) * (pw - at(p, w)) - (at(q, w) - at(p, w)) * (pu - at(p, u));
    const s1 = side(i0, i1), s2 = side(i1, i2), s3 = side(i2, i0);
    if ((s1 >= 0 && s2 >= 0 && s3 >= 0) || (s1 <= 0 && s2 <= 0 && s3 <= 0)) found |= bit;
  }
  let n = 0;
  for (let f = found; f !== 0; f &= f - 1) n++;
  return n;
}

/** What every consumer of a derived chunk receives for its local cell (lx, ly, lz). */
export function cellOutputs(d: DerivedData, lx: number, ly: number, lz: number): CellOutputs {
  const e = d.edge;
  if (lx < 0 || ly < 0 || lz < 0 || lx >= e || ly >= e || lz >= e) throw new RangeError(`cell ${lx},${ly},${lz} outside a ${e}³ chunk`);
  const i = (lx * e + lz) * e + ly;
  const occ = d.occupancy;
  const renderSolid = occ.flag === OCCUPANCY.solid || (occ.flag === OCCUPANCY.mixed && cellBit(occ.mask, i));
  let piece: CellOutputs['piece'] = null;
  const list = d.instances;
  for (let k = 0; k < list.count; k++) {
    const o = k * INSTANCE_BYTES;
    if (list.data[o] !== lx || list.data[o + 1] !== ly || list.data[o + 2] !== lz) continue;
    const id = list.data[o + 4]! | (list.data[o + 5]! << 8);
    const flags = list.data[o + 3]!;
    piece = { family: id >> 2, section: id & 3, turns: flags & 3, replacesBase: (flags & INSTANCE_FLAG.replacesBase) !== 0 };
    break;
  }
  const S = COLLISION_STEPS_PER_CELL;
  const c0 = [lx * S, ly * S, lz * S];
  const c1 = [c0[0]! + S, c0[1]! + S, c0[2]! + S];
  let collision: CellOutputs['collision'] = 'none';
  let partialBox: number[] | null = null;
  const boxes = d.collision.boxes;
  for (let b = 0; b * 6 < boxes.length; b++) {
    const lo = [boxes[b * 6]!, boxes[b * 6 + 1]!, boxes[b * 6 + 2]!];
    const hi = [boxes[b * 6 + 3]!, boxes[b * 6 + 4]!, boxes[b * 6 + 5]!];
    if (b < d.collision.fullBoxes) {
      if (lo.every((v, a) => v <= c0[a]!) && hi.every((v, a) => v >= c1[a]!)) {
        collision = 'full';
        break;
      }
    } else if (lo.every((v, a) => v >= c0[a]!) && hi.every((v, a) => v <= c1[a]!)) {
      collision = 'partial';
      partialBox = [...lo.map((v, a) => v - c0[a]!), ...hi.map((v, a) => v - c0[a]!)];
      break;
    }
  }
  const nav = d.nav;
  const navBlocks = nav.blocking === OCCUPANCY.solid || (nav.blocking === OCCUPANCY.mixed && cellBit(nav.blocks, i));
  const s = sortedIndex(nav.standable, i);
  const light = d.light;
  let cover: number;
  if (light.uniform >= 0) cover = light.uniform;
  else if (cellBit(light.full, i)) cover = 255;
  else {
    const p = sortedIndex(light.partialCells, i);
    cover = p < 0 ? 0 : light.partialCover[p]!;
  }
  return {
    renderSolid,
    baseFaces: baseFacesOf(d, lx, ly, lz),
    piece,
    collision,
    partialBox,
    navBlocks,
    standable: s >= 0,
    clearance: s >= 0 ? nav.clearance[s]! : 0,
    light: cover,
  };
}

/**
 * The resolved assembly class byte of a world cell (class | run bits), by
 * evaluating its chunk with `rules` in this thread from the store (the
 * same evaluation a derive job runs). For inspection and tests: a derive
 * keeps no classes.
 */
export function resolvedClassAt(store: VoxelStoreCandidate, rules: AssemblyRuleSet, x: number, y: number, z: number): number {
  const grid: ChunkGrid = store.grid;
  const cx = chunkOf(grid, x);
  const cy = chunkOf(grid, y);
  const cz = chunkOf(grid, z);
  const pad = jobRadius(rules);
  const n = createNeighbourhood(grid.edge, pad);
  const dense = createDenseChunk(grid);
  const has = store.exportChunk(cx, cy, cz, dense);
  fillNeighbourhood(n, grid, has ? dense : null, buildApron(store, cx, cy, cz, pad));
  const classes = new Uint8Array(n.values.length);
  evaluateAssembly(n, rules, classes);
  const i = ((localOf(grid, x) + pad) * n.side + (localOf(grid, z) + pad)) * n.side + (localOf(grid, y) + pad);
  return classes[i]!;
}

