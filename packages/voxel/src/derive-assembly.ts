/**
 * Running the assembly derive for one chunk: gather the chunk and its
 * apron (rule radius + consumer reach deep) into a neighbourhood, then
 * derive. The worker's derive job and the main-thread path (tests, a
 * fallback without workers) share this, so both give the same bytes.
 */
import { buildApron, type Apron } from './apron';
import { createNeighbourhood, fillNeighbourhood, jobRadius, type AssemblyRuleSet, type Neighbourhood } from './assembly';
import { assemblyRules } from './rule-registry';
import { crc32 } from '@thirdlight/shared';
import { cellInWorld, SECTION_EDGES, type CellGrid, type ChunkGrid } from './coords';
import { createDenseChunk, type DenseChunk } from './dense-chunk';
import { deriveChunk, encodeDerived, type DerivedData, type DeriveTimes } from './derived-data';
import { encodeShader, SHADER_BORDER_CELLS, shaderOfNeighbourhood, type ShaderOut } from './derived-shader';
import { shapeDensity, valueOf, type VoxelRecord } from './record';
import type { VoxelStoreCandidate } from './store';

interface Scratch {
  n: Neighbourhood;
  classes: Uint8Array;
  dense: DenseChunk;
}

const scratches = new Map<string, Scratch>();

/** A reusable neighbourhood, class array and dense chunk for an edge and pad (one set per thread). */
function scratchFor(grid: ChunkGrid, pad: number): Scratch {
  const key = `${grid.edge}:${pad}`;
  let s = scratches.get(key);
  if (s === undefined) {
    const n = createNeighbourhood(grid.edge, pad);
    s = { n, classes: new Uint8Array(n.values.length), dense: createDenseChunk(grid) };
    scratches.set(key, s);
  }
  return s;
}

/**
 * Derives a chunk of `store` (resident, or absent = air) whose apron is
 * already built (radius = jobRadius(rules)); `exportChunk` writes its cells.
 * A mip node of chunk-tree level `level` derives the same way from its own
 * cells and apron (mip-derive.ts); the result records the level.
 */
export function deriveWithApron(grid: ChunkGrid, rules: AssemblyRuleSet, apron: Apron, exportChunk: (out: DenseChunk) => boolean, times?: DeriveTimes, level = 0): DerivedData {
  const pad = jobRadius(rules);
  if (apron.radius !== pad) throw new RangeError(`assembly derive: apron ${apron.radius} deep, rules need ${pad}`);
  const s = scratchFor(grid, pad);
  const has = exportChunk(s.dense);
  fillNeighbourhood(s.n, grid, has ? s.dense : null, apron);
  return deriveChunk(s.n, rules, s.classes, times, level);
}

/**
 * The shader data alone of a chunk of `store`, from its apron
 * {@link SHADER_BORDER_CELLS} deep (what a material or wetness change
 * re-derives); the same bytes a full derive gives for it.
 */
export function deriveShaderWithApron(grid: ChunkGrid, apron: Apron, exportChunk: (out: DenseChunk) => boolean): ShaderOut {
  if (apron.radius !== SHADER_BORDER_CELLS) throw new RangeError(`shader derive: apron ${apron.radius} deep, the shader border is ${SHADER_BORDER_CELLS}`);
  const s = scratchFor(grid, SHADER_BORDER_CELLS);
  const has = exportChunk(s.dense);
  fillNeighbourhood(s.n, grid, has ? s.dense : null, apron);
  return shaderOfNeighbourhood(s.n);
}

/** Derives chunk (cx, cy, cz) of a store in this thread (its neighbours read from the same store). */
export function deriveFromStore(store: VoxelStoreCandidate, cx: number, cy: number, cz: number, rules: AssemblyRuleSet | { id: string; version: number }, times?: DeriveTimes): DerivedData {
  const r = 'resolve' in rules ? rules : assemblyRules(rules);
  const apron = buildApron(store, cx, cy, cz, jobRadius(r));
  return deriveWithApron(store.grid, r, apron, (out) => store.exportChunk(cx, cy, cz, out), times);
}

/**
 * A derive section inside a storage chunk: section `id` of a chunk of edge
 * E cut into sections of edge S is (sx · n + sz) · n + sy with n = E / S, the
 * same x, z, y order as cells; its first cell is (sx, sy, sz) · S in the chunk.
 */
export function sectionLocalOrigin(chunkEdge: number, sectionEdge: number, id: number): [number, number, number] {
  const n = chunkEdge / sectionEdge;
  const sy = id % n;
  const sz = Math.floor(id / n) % n;
  const sx = Math.floor(id / (n * n));
  return [sx * sectionEdge, sy * sectionEdge, sz * sectionEdge];
}

/** Section id of local section (sx, sy, sz) in a chunk cut into n sections a side. */
export function sectionIdOf(n: number, sx: number, sy: number, sz: number): number {
  return (sx * n + sz) * n + sy;
}

/** Throws unless a section edge divides the chunk edge and every id names a section of it, once. */
export function checkSections(chunkEdge: number, sectionEdge: number, ids: readonly number[]): void {
  if (!(SECTION_EDGES as readonly number[]).includes(sectionEdge) || sectionEdge > chunkEdge || chunkEdge % sectionEdge !== 0) throw new RangeError(`section edge ${sectionEdge} for chunks of ${chunkEdge}`);
  const count = (chunkEdge / sectionEdge) ** 3;
  const seen = new Set<number>();
  if (ids.length === 0) throw new RangeError('a section derive names at least one section');
  for (const id of ids) {
    if (!Number.isInteger(id) || id < 0 || id >= count || seen.has(id)) throw new RangeError(`section id ${id} (of ${count})`);
    seen.add(id);
  }
}

/** What one section of a derive job gives: its derived data, or its shader data alone, and how long the parts took. */
export interface SectionResult {
  readonly id: number;
  /** CRC-32 of the canonical bytes (encodeDerived, or encodeShader for the shader data alone). */
  readonly hash: number;
  readonly assembly: DerivedData | null;
  /** The shader data alone (a shader-only job), else null. */
  readonly shader: ShaderOut | null;
  readonly times: DeriveTimes;
}

const subScratches = new Map<string, Scratch>();

/** A reusable section-sized neighbourhood and class array (one set per thread and edge/pad). */
function sectionScratch(grid: ChunkGrid, edge: number, pad: number): Scratch {
  const key = `${edge}:${pad}`;
  let s = subScratches.get(key);
  if (s === undefined) {
    const n = createNeighbourhood(edge, pad);
    s = { n, classes: new Uint8Array(n.values.length), dense: createDenseChunk(grid) };
    subScratches.set(key, s);
  }
  return s;
}

/** Copies a section's cells and its pad out of its chunk's neighbourhood (both of the same pad). */
function cropNeighbourhood(full: Neighbourhood, lx: number, ly: number, lz: number, out: Neighbourhood): void {
  const fs = full.side;
  const os = out.side;
  for (let x = 0; x < os; x++) for (let z = 0; z < os; z++) {
    const src = ((lx + x) * fs + (lz + z)) * fs + ly;
    const dst = (x * os + z) * os;
    out.values.set(full.values.subarray(src, src + os), dst);
    out.shapes.set(full.shapes.subarray(src, src + os), dst);
  }
}

/**
 * Derives sections of one chunk whose apron is built (radius =
 * jobRadius(rules)): the chunk's neighbourhood is filled once, then each
 * section's own neighbourhood (its cells and the same pad) is cut out of it
 * and derived as a cube of the section's edge. A section of the chunk's
 * whole edge is the chunk's derive, byte for byte. A mip node's sections
 * derive the same way (`level` > 0).
 */
export function deriveSectionsWithApron(grid: ChunkGrid, rules: AssemblyRuleSet, apron: Apron, exportChunk: (out: DenseChunk) => boolean, sectionEdge: number, ids: readonly number[], level = 0): SectionResult[] {
  checkSections(grid.edge, sectionEdge, ids);
  const pad = jobRadius(rules);
  if (apron.radius !== pad) throw new RangeError(`assembly derive: apron ${apron.radius} deep, rules need ${pad}`);
  const s = scratchFor(grid, pad);
  fillNeighbourhood(s.n, grid, exportChunk(s.dense) ? s.dense : null, apron);
  const sub = sectionEdge === grid.edge ? s : sectionScratch(grid, sectionEdge, pad);
  return ids.map((id) => {
    if (sub !== s) cropNeighbourhood(s.n, ...sectionLocalOrigin(grid.edge, sectionEdge, id), sub.n);
    const times: DeriveTimes = { evaluateUs: 0, consumersUs: 0, meshUs: 0 };
    const assembly = deriveChunk(sub.n, rules, sub.classes, times, level);
    return { id, hash: crc32(encodeDerived(assembly)), assembly, shader: null, times };
  });
}

/** The shader data alone of sections of one chunk, from its apron {@link SHADER_BORDER_CELLS} deep. */
export function deriveSectionShadersWithApron(grid: ChunkGrid, apron: Apron, exportChunk: (out: DenseChunk) => boolean, sectionEdge: number, ids: readonly number[]): SectionResult[] {
  checkSections(grid.edge, sectionEdge, ids);
  if (apron.radius !== SHADER_BORDER_CELLS) throw new RangeError(`shader derive: apron ${apron.radius} deep, the shader border is ${SHADER_BORDER_CELLS}`);
  const s = scratchFor(grid, SHADER_BORDER_CELLS);
  fillNeighbourhood(s.n, grid, exportChunk(s.dense) ? s.dense : null, apron);
  const sub = sectionEdge === grid.edge ? s : sectionScratch(grid, sectionEdge, SHADER_BORDER_CELLS);
  return ids.map((id) => {
    if (sub !== s) cropNeighbourhood(s.n, ...sectionLocalOrigin(grid.edge, sectionEdge, id), sub.n);
    const shader = shaderOfNeighbourhood(sub.n);
    return { id, hash: crc32(encodeShader(shader)), assembly: null, shader, times: { evaluateUs: 0, consumersUs: 0, meshUs: 0 } };
  });
}

/**
 * Derives section (sx, sy, sz) of `sections` (a section grid) from a store
 * in this thread, reading every cell of its neighbourhood with `voxelAt`
 * (a path of its own, independent of chunk payloads and aprons: what a
 * worker's section results are checked against). Sections of the store's
 * chunk edge are chunks, derived as {@link deriveFromStore} does.
 */
export function deriveSectionFromStore(store: VoxelStoreCandidate, sections: CellGrid, sx: number, sy: number, sz: number, rules: AssemblyRuleSet): DerivedData {
  if (sections.edge === store.grid.edge) return deriveFromStore(store, sx, sy, sz, rules);
  const pad = jobRadius(rules);
  const n = createNeighbourhood(sections.edge, pad);
  const v: VoxelRecord = { material: 0, role: 0, shape: 0, wetness: 0 };
  const ox = (sx << sections.shift) - pad;
  const oy = (sy << sections.shift) - pad;
  const oz = (sz << sections.shift) - pad;
  const side = n.side;
  for (let x = 0; x < side; x++) for (let z = 0; z < side; z++) for (let y = 0; y < side; y++) {
    const i = (x * side + z) * side + y;
    const wx = ox + x;
    const wy = oy + y;
    const wz = oz + z;
    if (!cellInWorld(wx, wy, wz)) continue;
    store.voxelAt(wx, wy, wz, v);
    n.values[i] = valueOf(v);
    n.shapes[i] = shapeDensity(v.shape);
  }
  return deriveChunk(n, rules);
}
