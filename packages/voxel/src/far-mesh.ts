/**
 * Far nodes as meshes: a far-tree node (far-tree.ts) meshed by the world's
 * mesher on its own cells, the far field's cheap stand-in for everything past
 * the near rings.
 *
 * - **Mesh.** A node is derived like a near mip node (the same rules and
 *   mesher, at its level's cell size), from its cells and an apron of its 26
 *   neighbours at the same level, all read from the far cache (which keeps
 *   every node of the level, drawn or not), so two neighbours drawn at one
 *   level meet without a crack. Ground and base surfaces become one buffer.
 * - **Material.** Vertices carry the material and wetness of the cell
 *   behind them (one value a vertex, read where the surface's normal points
 *   in): the far draw colours a vertex from the material table, so a far
 *   node needs no shader grid, and a material record's look reaches it
 *   without a mesh derive.
 * - **Skirts.** Neighbours drawn at different levels do not meet exactly
 *   (a coarser node's surface lies up to one of its cells off the finer
 *   one's), so every edge a node's surface leaves its box through hangs a
 *   skirt {@link FAR_SKIRT_CELLS} of its cells into the surface (along the
 *   surface's inward normal), drawn from both sides: a gap between levels
 *   shows a skirt in the ground's colour, never the sky.
 *
 * The vertex layout ({@link FAR_VERTEX_BYTES}): position `uint16x3` in
 * 1/{@link POSITION_STEPS_PER_CELL} cells from {@link FAR_POSITION_ORIGIN_CELLS}
 * cells below the node's corner (room for skirts under the node), `uint16`
 * material (bits 0–11) and wetness (bits 12–14), normal `snorm8x3` and one
 * byte 0.
 */
import { buildApron } from './apron';
import { jobRadius, type AssemblyRulesRef } from './assembly';
import type { ChunkEdge, ChunkGrid } from './coords';
import { deriveWithApron } from './derive-assembly';
import { POSITION_STEPS_PER_CELL, SURFACE_VERTEX_BYTES, type SurfaceBuffer } from './derived-mesh';
import type { FarBrickBuild } from './far-bricks';
import type { PaletteStore } from './palette-store';
import { MATERIAL_AIR, MATERIAL_BITS, type VoxelRecord } from './record';
import { regionChunkCodecBytes } from './region-file';
import { assemblyRules } from './rule-registry';
import type { StoredChunk } from './stream-job';

/** Cells a vertex's material is looked for behind it (the projected ground lies within a cell or two of its cells). */
const LOOK_REACH_CELLS = 3;

/** Bytes a far vertex takes. */
export const FAR_VERTEX_BYTES = 12;

/** Cells below a node's corner where far positions count from (skirts reach under the node). */
export const FAR_POSITION_ORIGIN_CELLS = 16;

/** How far a skirt hangs into the surface, in the node's cells: one cell of the next level up, the most two neighbouring levels differ by. */
export const FAR_SKIRT_CELLS = 2;

/** A far node's mesh job: its cells and its 26 neighbours' at the same level. */
export interface FarMeshInput {
  readonly edge: ChunkEdge;
  readonly level: number;
  readonly node: readonly [number, number, number];
  /**
   * The node and its neighbours as the far cache stores them (null: air or
   * not kept), 27 entries: index `(dx + 1) * 9 + (dz + 1) * 3 + (dy + 1)`.
   */
  readonly cells: ReadonlyArray<StoredChunk | null>;
  readonly rules: AssemblyRulesRef;
  /** A brick job's build (far-bricks.ts; none: the occupancy build). */
  readonly build?: FarBrickBuild;
  /**
   * A brick job's finer cells (a `faces` build of scale > 1): the nodes `scale`
   * times finer covering the node and one of theirs round it, x outermost,
   * then z, then y, each from −1 to `scale` (null: air or not kept).
   */
  readonly fine?: { readonly level: number; readonly scale: number; readonly cells: ReadonlyArray<StoredChunk | null> };
}

/** A far node's mesh: positions, material and normal a vertex ({@link FAR_VERTEX_BYTES}), triangles, skirts included. */
export interface FarMesh {
  readonly vertexCount: number;
  readonly vertices: Uint8Array;
  readonly indices: Uint16Array | Uint32Array;
  /** Triangles of the skirts (inside `indices`). */
  readonly skirtTriangles: number;
}

/** Index of a neighbour offset in {@link FarMeshInput.cells}. */
export function farNeighbourIndex(dx: number, dy: number, dz: number): number {
  return (dx + 1) * 9 + (dz + 1) * 3 + (dy + 1);
}

/** Bytes a far mesh holds. */
export function farMeshBytes(m: FarMesh): number {
  return m.vertices.byteLength + m.indices.byteLength;
}

/** The buffers a far mesh can hand over. */
export function farMeshTransfer(m: FarMesh, out: ArrayBuffer[] = []): ArrayBuffer[] {
  for (const a of [m.vertices, m.indices]) if (a.buffer instanceof ArrayBuffer && !out.includes(a.buffer)) out.push(a.buffer);
  return out;
}

/** An empty mesh: new arrays each time, since a worker hands its arrays over (a shared one would be detached by the first). */
const emptyMesh = (): FarMesh => ({ vertexCount: 0, vertices: new Uint8Array(0), indices: new Uint16Array(0), skirtTriangles: 0 });

/**
 * Meshes a far node in `store` (a scratch store: the 27 entries are put in,
 * and taken out again before it returns). `decompress` decodes a stored
 * entry's zstd frame.
 */
export function meshFarNode(store: PaletteStore, input: FarMeshInput, decompress: (b: Uint8Array) => Uint8Array): FarMesh {
  return withFarNeighbourhood(store, input, decompress, () => {
    const g = store.grid;
    const [nx, ny, nz] = input.node;
    const rules = assemblyRules(input.rules);
    const apron = buildApron(store, nx, ny, nz, jobRadius(rules));
    const d = deriveWithApron(g, rules, apron, (out) => store.exportChunk(nx, ny, nz, out), undefined, input.level);
    return farMeshOf(g, store, [nx, ny, nz], [d.ground, d.base]);
  }, emptyMesh);
}

/**
 * Runs `use` with a far job's 27 entries decoded into `store` (a scratch
 * store), and takes them out again before it returns; `empty` when the
 * node itself holds nothing. The far mesh and the far bricks read a node
 * and its same-level neighbours this way.
 */
export function withFarNeighbourhood<T>(store: PaletteStore, input: Pick<FarMeshInput, 'cells' | 'level' | 'node'>, decompress: (b: Uint8Array) => Uint8Array, use: () => T, empty: () => T): T {
  const g = store.grid;
  if (input.cells.length !== 27) throw new RangeError('far job: 27 cells, the node and its neighbours');
  if (!Number.isInteger(input.level) || input.level < 1) throw new RangeError(`far job: level ${String(input.level)}`);
  const [nx, ny, nz] = input.node;
  const placed: Array<[number, number, number]> = [];
  try {
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (let dz = -1; dz <= 1; dz++) {
      const c = input.cells[farNeighbourIndex(dx, dy, dz)];
      if (c == null) continue;
      const at: [number, number, number] = [nx + dx, ny + dy, nz + dz];
      const read = 'uniform' in c ? (c.uniform === 0 ? null : ({ cx: at[0], cy: at[1], cz: at[2], kind: 'uniform', value: c.uniform } as const)) : ({ cx: at[0], cy: at[1], cz: at[2], kind: 'stored', bytes: c.stored, raw: c.raw } as const);
      if (read === null) continue;
      const codec = regionChunkCodecBytes(g, read, decompress);
      if (codec === null) continue;
      store.decodeChunk(at[0], at[1], at[2], codec);
      placed.push(at);
    }
    if (store.chunkForm(nx, ny, nz) === 'absent') return empty();
    return use();
  } finally {
    for (const [x, y, z] of placed) store.dropChunk(x, y, z);
  }
}

/**
 * A node's surfaces as one far mesh: every vertex re-placed from the
 * surface origin (one cell below the corner) to the far origin, given the
 * material and wetness behind it, and the skirts added.
 */
export function farMeshOf(g: ChunkGrid, store: PaletteStore, node: readonly [number, number, number], surfaces: readonly SurfaceBuffer[]): FarMesh {
  let vertexCount = 0;
  let indexCount = 0;
  for (const s of surfaces) {
    vertexCount += s.vertexCount;
    indexCount += s.indices.length;
  }
  if (indexCount === 0) return emptyMesh();
  const e = g.edge;
  const step = POSITION_STEPS_PER_CELL;
  // Positions in steps from the far origin, and normals, a vertex.
  const pos = new Int32Array(vertexCount * 3);
  const nor = new Int8Array(vertexCount * 3);
  const tri = new Uint32Array(indexCount);
  const shift = (FAR_POSITION_ORIGIN_CELLS - 1) * step;
  let v0 = 0;
  let i0 = 0;
  for (const s of surfaces) {
    const view = new DataView(s.vertices.buffer, s.vertices.byteOffset, s.vertices.byteLength);
    for (let i = 0; i < s.vertexCount; i++) {
      const o = i * SURFACE_VERTEX_BYTES;
      for (let a = 0; a < 3; a++) {
        pos[(v0 + i) * 3 + a] = view.getUint16(o + a * 2, true) + shift;
        nor[(v0 + i) * 3 + a] = view.getInt8(o + 8 + a);
      }
    }
    for (let k = 0; k < s.indices.length; k++) tri[i0 + k] = s.indices[k]! + v0;
    v0 += s.vertexCount;
    i0 += s.indices.length;
  }
  // Skirts: an edge on the node's box used by one triangle (the surface leaves the box there) hangs a quad inward.
  const lo = FAR_POSITION_ORIGIN_CELLS * step;
  const hi = (FAR_POSITION_ORIGIN_CELLS + e) * step;
  const onFace = (v: number, w: number): boolean => {
    for (let a = 0; a < 3; a++) {
      const p = pos[v * 3 + a]!;
      const q = pos[w * 3 + a]!;
      if (p === q && (p === lo || p === hi)) return true;
    }
    return false;
  };
  // Welded by position: the mesher's surfaces share no vertices with each other.
  const weld = new Map<number, number>();
  const id = new Uint32Array(vertexCount);
  for (let v = 0; v < vertexCount; v++) {
    // Positions are whole steps under 2^16 an axis: one number a position.
    const k = pos[v * 3]! + pos[v * 3 + 1]! * 0x10000 + pos[v * 3 + 2]! * 0x100000000;
    let w = weld.get(k);
    if (w === undefined) weld.set(k, (w = v));
    id[v] = w;
  }
  const edges = new Map<number, { a: number; b: number; n: number }>();
  for (let t = 0; t < indexCount; t += 3) {
    for (let k = 0; k < 3; k++) {
      const a = tri[t + k]!;
      const b = tri[t + ((k + 1) % 3)]!;
      if (!onFace(a, b)) continue;
      const ia = id[a]!, ib = id[b]!;
      if (ia === ib) continue;
      const key = ia < ib ? ia * vertexCount + ib : ib * vertexCount + ia;
      const had = edges.get(key);
      if (had === undefined) edges.set(key, { a, b, n: 1 });
      else had.n++;
    }
  }
  const skirtEdges = [...edges.values()].filter((x) => x.n === 1);
  const total = vertexCount + skirtEdges.length * 2;
  const outIndexCount = indexCount + skirtEdges.length * 12;
  const vertices = new Uint8Array(total * FAR_VERTEX_BYTES);
  const out = new DataView(vertices.buffer);
  const indices = total < 65536 ? new Uint16Array(outIndexCount) : new Uint32Array(outIndexCount);
  indices.set(tri);
  const v: VoxelRecord = { material: 0, role: 0, shape: 0, wetness: 0 };
  const [nx, ny, nz] = node;
  const base = [nx * e, ny * e, nz * e];
  const write = (at: number, x: number, y: number, z: number, src: number): void => {
    const o = at * FAR_VERTEX_BYTES;
    out.setUint16(o, clampStep(x), true);
    out.setUint16(o + 2, clampStep(y), true);
    out.setUint16(o + 4, clampStep(z), true);
    out.setUint16(o + 6, look(src), true);
    out.setInt8(o + 8, nor[src * 3]!);
    out.setInt8(o + 9, nor[src * 3 + 1]!);
    out.setInt8(o + 10, nor[src * 3 + 2]!);
  };
  const looks = new Map<number, number>();
  let lastWord = 0;
  /** The material and wetness behind a vertex: the first solid cell along its inward normal, else any solid cell round it. */
  const look = (src: number): number => {
    const known = looks.get(id[src]!);
    if (known !== undefined) return known;
    const px = pos[src * 3]! / step - FAR_POSITION_ORIGIN_CELLS;
    const py = pos[src * 3 + 1]! / step - FAR_POSITION_ORIGIN_CELLS;
    const pz = pos[src * 3 + 2]! / step - FAR_POSITION_ORIGIN_CELLS;
    const n = [nor[src * 3]! / 127, nor[src * 3 + 1]! / 127, nor[src * 3 + 2]! / 127];
    let word = 0;
    const at = (x: number, y: number, z: number): boolean => {
      store.voxelAt(base[0]! + Math.floor(x), base[1]! + Math.floor(y), base[2]! + Math.floor(z), v);
      if (v.material === MATERIAL_AIR) return false;
      word = v.material | (v.wetness << MATERIAL_BITS);
      return true;
    };
    // The ground's projected surface may lie up to a cell above its solid cells (and a wall's face on its cells' side):
    // along the inward normal, then straight down, then the cells round the vertex.
    let found = false;
    for (let d = 0.5; d <= LOOK_REACH_CELLS && !found; d += 0.5) found = at(px - n[0]! * d, py - n[1]! * d, pz - n[2]! * d);
    for (let d = 0.5; d <= LOOK_REACH_CELLS && !found; d += 0.5) found = at(px, py - d, pz);
    for (let k = 0; k < 125 && !found; k++) found = at(px + (k % 5) - 2, py + (Math.floor(k / 5) % 5) - 2, pz + Math.floor(k / 25) - 2);
    // A face further than that from any solid cell (a roof plane over its cells at a coarse level) takes the last
    // vertex's look: a face's vertices come one after another.
    if (!found) word = lastWord;
    lastWord = word;
    looks.set(id[src]!, word);
    return word;
  };
  for (let i = 0; i < vertexCount; i++) write(i, pos[i * 3]!, pos[i * 3 + 1]!, pos[i * 3 + 2]!, i);
  const drop = FAR_SKIRT_CELLS * step;
  let at = vertexCount;
  let ix = indexCount;
  for (const s of skirtEdges) {
    const a2 = at++;
    const b2 = at++;
    for (const [dst, src] of [[a2, s.a], [b2, s.b]] as const) {
      const n = [nor[src * 3]! / 127, nor[src * 3 + 1]! / 127, nor[src * 3 + 2]! / 127];
      write(dst, pos[src * 3]! - Math.round(n[0]! * drop), pos[src * 3 + 1]! - Math.round(n[1]! * drop), pos[src * 3 + 2]! - Math.round(n[2]! * drop), src);
    }
    // Both windings: the gap a skirt fills can be seen from either side of the node's face.
    indices.set([s.a, b2, s.b, s.a, a2, b2, s.b, b2, s.a, b2, a2, s.a], ix);
    ix += 12;
  }
  return { vertexCount: total, vertices, indices, skirtTriangles: skirtEdges.length * 4 };
}

function clampStep(p: number): number {
  return p < 0 ? 0 : p > 0xffff ? 0xffff : p;
}

/** A far vertex's material id and wetness from its look word. */
export function farVertexLook(word: number): { material: number; wetness: number } {
  return { material: word & ((1 << MATERIAL_BITS) - 1), wetness: (word >>> MATERIAL_BITS) & 7 };
}
