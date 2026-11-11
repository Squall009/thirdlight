/**
 * Joining a storage chunk's derive sections into what a renderer draws and
 * a physics engine collides with for the chunk: one ground and one base
 * surface buffer, one detail-instance list, one list of collision boxes and
 * one shader grid of the chunk's side (edge + 2 · border, 34 at
 * 32³). Sections keep an edit's derive work small (only the sections within
 * the rules' reach are derived again); drawing per chunk keeps the object
 * count, and so the render CPU and the swap's replace work, at the chunk
 * count. The join runs on the thread that draws, when a swap or a landed
 * result changes a chunk.
 *
 * - **Surfaces.** Section buffers are concatenated in section id order,
 *   their positions moved from the section's corner to the chunk's (whole
 *   cell steps, so a position stays bit for bit what a whole-chunk derive
 *   gives) and their indices offset. Vertices on a face between two
 *   sections are not welded: each section emits its own copy at the same
 *   position with the same normal, so the ground's triangles equal the
 *   whole-chunk derive's and only the vertex count is a little higher. The
 *   base merges faces inside each section only (base-surface.ts): its
 *   triangles differ from a whole-chunk derive's, covering the same faces
 *   with no T-junction.
 * - **Instances.** Concatenated, cells moved to the chunk.
 * - **Collision boxes.** Concatenated, moved to the chunk, every section's
 *   full-cell merges before the partial shapes. Boxes are not merged across
 *   section faces again: the same space is solid, in a few more boxes. The
 *   roofs' ramp meshes are joined as the surfaces are.
 * - **Shader grid.** Each grid cell is taken from the section that holds
 *   it (a cell of the chunk's border from the section at that face), then
 *   the palette is built in grid order, so the bytes equal a whole-chunk
 *   derive's shader data (encodeShader).
 *
 * A missing section (none derived: air with air around it) adds no
 * triangles and air to the grid.
 */
import { COLLISION_STEPS_PER_CELL, type CollisionOut, type CollisionPart, type DerivedData } from './derived-data';
import { INSTANCE_BYTES, POSITION_STEPS_PER_CELL, SURFACE_VERTEX_BYTES, type InstanceList, type SurfaceBuffer } from './derived-mesh';
import { shaderGridEntries, shaderGridSide, shaderSolidEntry, SHADER_BORDER_CELLS, type ShaderOut } from './derived-shader';
import { sectionLocalOrigin } from './derive-assembly';
import { packedWidth } from './packed-width';
import type { ReliefSurface } from './relief-mesh';

/** What a renderer draws for one storage chunk, joined from its derive sections. */
export interface JoinedChunk {
  /** The chunk's edge (cells). */
  readonly edge: number;
  /** Positions from one cell below the chunk's corner, as in a whole-chunk derive. */
  readonly ground: SurfaceBuffer;
  readonly base: SurfaceBuffer;
  /** Cells chunk-local. */
  readonly instances: InstanceList;
  /** Collision boxes in steps from the chunk's corner (the ground collides as {@link ground}). */
  readonly collision: CollisionOut;
  /** Side edge + 2 · border: equal to a whole-chunk derive's shader data. */
  readonly shader: ShaderOut;
}

/**
 * A joined chunk as a renderer uploads it: the surfaces and instances of
 * {@link JoinedChunk}, and the shader grid as entries (no palette packed
 * only to be expanded again for the upload).
 */
export interface JoinedDraw {
  readonly edge: number;
  readonly ground: SurfaceBuffer;
  readonly base: SurfaceBuffer;
  readonly instances: InstanceList;
  readonly collision: CollisionOut;
  /** The grid's one solid entry (0: all air), or −1: its side³ entries are in the cell array given to the join. */
  readonly solid: number;
  /** The grid's side (edge + 2 · border). */
  readonly side: number;
  /**
   * The relief meshes of its sections joined as the surfaces are (a section
   * without one gives its plain surfaces, every crease weight 0), when any
   * section has one: drawn in place of {@link ground} and {@link base},
   * which stay what collides.
   */
  readonly relief?: { readonly ground: ReliefSurface; readonly base: ReliefSurface };
}

/** How a joined chunk's buffers came about (for measurements). */
export interface JoinTimes {
  surfacesUs: number;
  shaderUs: number;
}

function checkSectionCount(chunkEdge: number, sectionEdge: number, count: number): number {
  if (sectionEdge <= 0 || chunkEdge % sectionEdge !== 0) throw new RangeError(`section edge ${sectionEdge} for chunks of ${chunkEdge}`);
  const n = chunkEdge / sectionEdge;
  if (count !== n * n * n) throw new RangeError(`a chunk of ${chunkEdge} holds ${n * n * n} sections of ${sectionEdge}, given ${count}`);
  return n;
}

/** One surface buffer of every section, moved to the chunk's corner. */
export function joinSurfaces(chunkEdge: number, sectionEdge: number, parts: ReadonlyArray<SurfaceBuffer | null>): SurfaceBuffer {
  checkSectionCount(chunkEdge, sectionEdge, parts.length);
  let vertexCount = 0;
  let indexCount = 0;
  for (const p of parts) {
    if (p === null) continue;
    vertexCount += p.vertexCount;
    indexCount += p.indices.length;
  }
  const vertices = new Uint8Array(vertexCount * SURFACE_VERTEX_BYTES);
  const indices = vertexCount < 65536 ? new Uint16Array(indexCount) : new Uint32Array(indexCount);
  const view = new DataView(vertices.buffer);
  const steps = POSITION_STEPS_PER_CELL;
  let v0 = 0;
  let i0 = 0;
  parts.forEach((p, id) => {
    if (p === null || p.vertexCount === 0) return;
    const [ox, oy, oz] = sectionLocalOrigin(chunkEdge, sectionEdge, id);
    vertices.set(p.vertices.subarray(0, p.vertexCount * SURFACE_VERTEX_BYTES), v0 * SURFACE_VERTEX_BYTES);
    if (ox !== 0 || oy !== 0 || oz !== 0) {
      const dx = ox * steps;
      const dy = oy * steps;
      const dz = oz * steps;
      for (let v = 0, at = v0 * SURFACE_VERTEX_BYTES; v < p.vertexCount; v++, at += SURFACE_VERTEX_BYTES) {
        view.setUint16(at, view.getUint16(at, true) + dx, true);
        view.setUint16(at + 2, view.getUint16(at + 2, true) + dy, true);
        view.setUint16(at + 4, view.getUint16(at + 4, true) + dz, true);
      }
    }
    const src = p.indices;
    if (v0 === 0) indices.set(src, i0);
    else for (let k = 0; k < src.length; k++) indices[i0 + k] = src[k]! + v0;
    v0 += p.vertexCount;
    i0 += src.length;
  });
  return { vertexCount, vertices, indices };
}

/** One instance list of every section, cells moved into the chunk. */
export function joinInstances(chunkEdge: number, sectionEdge: number, parts: ReadonlyArray<InstanceList | null>): InstanceList {
  checkSectionCount(chunkEdge, sectionEdge, parts.length);
  let count = 0;
  for (const p of parts) count += p?.count ?? 0;
  const data = new Uint8Array(count * INSTANCE_BYTES);
  let at = 0;
  parts.forEach((p, id) => {
    if (p === null || p.count === 0) return;
    const [ox, oy, oz] = sectionLocalOrigin(chunkEdge, sectionEdge, id);
    const bytes = p.count * INSTANCE_BYTES;
    data.set(p.data.subarray(0, bytes), at);
    for (let o = at; o < at + bytes; o += INSTANCE_BYTES) {
      data[o] = data[o]! + ox;
      data[o + 1] = data[o + 1]! + oy;
      data[o + 2] = data[o + 2]! + oz;
    }
    at += bytes;
  });
  return { count, data };
}

/** The sections' collision boxes moved to the chunk's corner: every full-cell merge, then every partial shape. */
export function joinCollision(chunkEdge: number, sectionEdge: number, parts: ReadonlyArray<CollisionOut | null>): CollisionOut {
  checkSectionCount(chunkEdge, sectionEdge, parts.length);
  let total = 0;
  let fullBoxes = 0;
  for (const p of parts) {
    total += p === null ? 0 : p.boxes.length / 6;
    fullBoxes += p?.fullBoxes ?? 0;
  }
  const boxes = new Uint16Array(total * 6);
  let full = 0;
  let partial = fullBoxes;
  parts.forEach((p, id) => {
    if (p === null) return;
    const [ox, oy, oz] = sectionLocalOrigin(chunkEdge, sectionEdge, id).map((o) => o * COLLISION_STEPS_PER_CELL) as [number, number, number];
    for (let b = 0; b * 6 < p.boxes.length; b++) {
      const at = (b < p.fullBoxes ? full++ : partial++) * 6;
      for (let k = 0; k < 6; k += 3) {
        boxes[at + k] = p.boxes[b * 6 + k]! + ox;
        boxes[at + k + 1] = p.boxes[b * 6 + k + 1]! + oy;
        boxes[at + k + 2] = p.boxes[b * 6 + k + 2]! + oz;
      }
    }
  });
  const ramps = joinSurfaces(chunkEdge, sectionEdge, parts.map((p) => p?.ramps ?? null));
  return { boxes, fullBoxes, ramps };
}

let chunkCells = new Uint16Array(0);
let sectionCells = new Uint16Array(0);
/** Entry → palette id while a grid is packed (−1: not seen); reset after each use. */
const idOfEntry = new Int32Array(1 << 16).fill(-1);

/**
 * Where grid cells along one axis come from: for section k of n (edge S),
 * the chunk grid's cells [from, to) and the offset that turns a chunk grid
 * cell into the section grid's (both grids have the same border).
 */
function axisSpan(k: number, n: number, sectionEdge: number, side: number): [number, number, number] {
  const b = SHADER_BORDER_CELLS;
  const from = k === 0 ? 0 : k * sectionEdge + b;
  const to = k === n - 1 ? side : (k + 1) * sectionEdge + b;
  return [from, to, k * sectionEdge];
}

/** Writes the chunk's grid cells (side³, grid order) from its sections' grids into `out`. */
function writeGridCells(chunkEdge: number, sectionEdge: number, parts: ReadonlyArray<ShaderOut | null>, out: Uint16Array): void {
  const n = chunkEdge / sectionEdge;
  const side = shaderGridSide(chunkEdge);
  const sside = shaderGridSide(sectionEdge);
  if (out.length < side * side * side) throw new RangeError(`shader grid: ${out.length} cells for a side of ${side}`);
  if (sectionCells.length < sside ** 3) sectionCells = new Uint16Array(sside ** 3);
  parts.forEach((p, id) => {
    if (p !== null && p.side !== sside) throw new RangeError(`section ${id}: a shader grid of side ${p.side}, sections of ${sectionEdge} need ${sside}`);
    const [ox, oy, oz] = sectionLocalOrigin(chunkEdge, sectionEdge, id);
    const [x0, x1, dx] = axisSpan(ox / sectionEdge, n, sectionEdge, side);
    const [y0, y1, dy] = axisSpan(oy / sectionEdge, n, sectionEdge, side);
    const [z0, z1, dz] = axisSpan(oz / sectionEdge, n, sectionEdge, side);
    const fill = p === null ? 0 : p.width === 0 ? p.palette[0]! : -1;
    const src = fill >= 0 ? null : shaderGridEntries(p!, sectionCells);
    for (let x = x0; x < x1; x++) for (let z = z0; z < z1; z++) {
      const row = (x * side + z) * side;
      if (src === null) out.fill(fill, row + y0, row + y1);
      else {
        const from = ((x - dx) * sside + (z - dz)) * sside - dy;
        out.set(src.subarray(from + y0, from + y1), row + y0);
      }
    }
  });
}

/**
 * The chunk's shader grid from its sections' grids (null section: air) as
 * entries, for a renderer that uploads entries and needs no palette: the
 * grid's one solid entry as `shaderSolidEntry` gives it (the only non-air
 * entry; 0 when all air), `out` left as it was, or −1 with the side³
 * entries written into `out` in grid order. Every cell of a section's grid
 * lies inside the chunk's, so the sections' palettes hold exactly the
 * chunk's entries and the solid test needs no pass over the cells.
 */
export function joinShaderCells(chunkEdge: number, sectionEdge: number, parts: ReadonlyArray<ShaderOut | null>, out: Uint16Array): number {
  checkSectionCount(chunkEdge, sectionEdge, parts.length);
  let solid = 0;
  for (const p of parts) {
    if (p === null) continue;
    for (const e of p.palette) {
      if (e === 0 || e === solid) continue;
      if (solid !== 0) {
        writeGridCells(chunkEdge, sectionEdge, parts, out);
        return -1;
      }
      solid = e;
    }
  }
  return solid;
}

/** The chunk's shader grid from its sections' grids (null section: air), equal to a whole-chunk derive's. */
export function joinShader(chunkEdge: number, sectionEdge: number, parts: ReadonlyArray<ShaderOut | null>): ShaderOut {
  checkSectionCount(chunkEdge, sectionEdge, parts.length);
  const side = shaderGridSide(chunkEdge);
  // Every section one entry, the same one: the chunk's grid is that entry alone.
  const first = parts[0] ?? null;
  const one = first === null ? 0 : first.width === 0 ? first.palette[0]! : -1;
  if (one >= 0 && parts.every((p) => (p === null ? one === 0 : p.width === 0 && p.palette[0] === one))) return { side, palette: Uint16Array.of(one), width: 0, ids: new Uint32Array(0) };
  const cells = side * side * side;
  if (chunkCells.length < cells) chunkCells = new Uint16Array(cells);
  const grid = chunkCells;
  writeGridCells(chunkEdge, sectionEdge, parts, grid);
  // The palette in grid order (first seen first), as a whole-chunk derive builds it.
  const entries: number[] = [];
  let prev = -1;
  for (let i = 0; i < cells; i++) {
    const e = grid[i]!;
    if (e === prev) continue;
    prev = e;
    if (idOfEntry[e]! < 0) {
      idOfEntry[e] = entries.length;
      entries.push(e);
    }
  }
  const width = packedWidth(entries.length);
  const ids = new Uint32Array(width === 0 ? 0 : Math.ceil((cells * width) / 32));
  if (width > 0) {
    for (let k = 0; k < cells; k++) {
      const bit = k * width;
      ids[bit >>> 5]! |= idOfEntry[grid[k]!]! << (bit & 31);
    }
  }
  for (const e of entries) idOfEntry[e] = -1;
  return { side, palette: Uint16Array.from(entries), width, ids };
}

/**
 * A chunk's sections' collision alone (indexed by section id, null: none) joined as {@link joinSections} joins
 * the full results' `ground` and `collision`: the same code on the same arrays, so a body made from it is the body
 * the full derive gives.
 */
export function joinCollisionParts(chunkEdge: number, sectionEdge: number, sections: ReadonlyArray<CollisionPart | null>): { readonly edge: number; readonly ground: SurfaceBuffer; readonly collision: CollisionOut } {
  checkSectionCount(chunkEdge, sectionEdge, sections.length);
  if (sectionEdge === chunkEdge && sections[0] != null) return { edge: chunkEdge, ground: sections[0].ground, collision: sections[0].collision };
  const ground = joinSurfaces(chunkEdge, sectionEdge, sections.map((s) => s?.ground ?? null));
  const collision = joinCollision(chunkEdge, sectionEdge, sections.map((s) => s?.collision ?? null));
  return { edge: chunkEdge, ground, collision };
}

/**
 * A chunk's derive sections (indexed by section id, null: none) joined into
 * one draw. Sections of the chunk's own edge are the chunk's derive: its
 * buffers are passed on as they are, nothing copied.
 */
export function joinSections(chunkEdge: number, sectionEdge: number, sections: ReadonlyArray<DerivedData | null>, times?: JoinTimes): JoinedChunk {
  checkSectionCount(chunkEdge, sectionEdge, sections.length);
  if (sectionEdge === chunkEdge && sections[0] != null) {
    const d = sections[0];
    return { edge: chunkEdge, ground: d.ground, base: d.base, instances: d.instances, collision: d.collision, shader: d.shader };
  }
  const t0 = performance.now();
  const ground = joinSurfaces(chunkEdge, sectionEdge, sections.map((s) => s?.ground ?? null));
  const base = joinSurfaces(chunkEdge, sectionEdge, sections.map((s) => s?.base ?? null));
  const instances = joinInstances(chunkEdge, sectionEdge, sections.map((s) => s?.instances ?? null));
  const collision = joinCollision(chunkEdge, sectionEdge, sections.map((s) => s?.collision ?? null));
  const t1 = performance.now();
  const shader = joinShader(chunkEdge, sectionEdge, sections.map((s) => s?.shader ?? null));
  if (times !== undefined) {
    times.surfacesUs += (t1 - t0) * 1000;
    times.shaderUs += (performance.now() - t1) * 1000;
  }
  return { edge: chunkEdge, ground, base, instances, collision, shader };
}

/**
 * {@link joinSections} for a renderer: the same surfaces and instances, the
 * shader grid's entries written into `cells` (side³, grid order) unless it
 * is one solid entry ({@link JoinedDraw.solid}).
 */
export function joinSectionsForDraw(chunkEdge: number, sectionEdge: number, sections: ReadonlyArray<DerivedData | null>, cells: Uint16Array, times?: JoinTimes): JoinedDraw {
  checkSectionCount(chunkEdge, sectionEdge, sections.length);
  const side = shaderGridSide(chunkEdge);
  if (sectionEdge === chunkEdge && sections[0] != null) {
    const d = sections[0];
    const t0 = performance.now();
    const solid = shaderSolidEntry(d.shader);
    if (solid < 0) shaderGridEntries(d.shader, cells);
    if (times !== undefined) times.shaderUs += (performance.now() - t0) * 1000;
    return { edge: chunkEdge, ground: d.ground, base: d.base, instances: d.instances, collision: d.collision, solid, side, ...(d.relief === undefined ? {} : { relief: { ground: d.relief.ground, base: d.relief.base } }) };
  }
  const t0 = performance.now();
  const ground = joinSurfaces(chunkEdge, sectionEdge, sections.map((s) => s?.ground ?? null));
  const base = joinSurfaces(chunkEdge, sectionEdge, sections.map((s) => s?.base ?? null));
  const instances = joinInstances(chunkEdge, sectionEdge, sections.map((s) => s?.instances ?? null));
  const collision = joinCollision(chunkEdge, sectionEdge, sections.map((s) => s?.collision ?? null));
  const relief = joinRelief(chunkEdge, sectionEdge, sections);
  const t1 = performance.now();
  const solid = joinShaderCells(chunkEdge, sectionEdge, sections.map((s) => s?.shader ?? null), cells);
  if (times !== undefined) {
    times.surfacesUs += (t1 - t0) * 1000;
    times.shaderUs += (performance.now() - t1) * 1000;
  }
  return { edge: chunkEdge, ground, base, instances, collision, solid, side, ...(relief === undefined ? {} : { relief }) };
}

/** The sections' relief meshes joined (see {@link JoinedDraw.relief}); undefined when no section has one. */
export function joinRelief(chunkEdge: number, sectionEdge: number, sections: ReadonlyArray<DerivedData | null>): JoinedDraw['relief'] {
  if (!sections.some((s) => s?.relief !== undefined)) return undefined;
  const one = (kind: 'ground' | 'base'): ReliefSurface => {
    const parts = sections.map((s) => (s === null ? null : (s.relief?.[kind] ?? s[kind])));
    const joined = joinSurfaces(chunkEdge, sectionEdge, parts);
    const crease = new Uint8Array(joined.vertexCount);
    let at = 0;
    // In joinSurfaces' order: section id order, empty parts left out.
    for (const p of parts) {
      if (p === null || p.vertexCount === 0) continue;
      if ('crease' in p) crease.set((p as ReliefSurface).crease.subarray(0, p.vertexCount), at);
      at += p.vertexCount;
    }
    return { ...joined, crease };
  };
  return { ground: one('ground'), base: one('base') };
}
