/**
 * Running the assembly derive for one chunk: gather the chunk and its
 * apron (rule radius + consumer reach deep) into a neighbourhood, then
 * derive. The worker's derive job and the main-thread path (tests, a
 * fallback without workers) share this, so both give the same bytes.
 */
import { buildApron, type Apron } from './apron';
import { assemblyRules, createNeighbourhood, fillNeighbourhood, jobRadius, type AssemblyRuleSet, type Neighbourhood } from './assembly';
import type { ChunkGrid } from './coords';
import { createDenseChunk, type DenseChunk } from './dense-chunk';
import { deriveChunk, type DerivedData, type DeriveTimes } from './derived-data';
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
 */
export function deriveWithApron(grid: ChunkGrid, rules: AssemblyRuleSet, apron: Apron, exportChunk: (out: DenseChunk) => boolean, times?: DeriveTimes): DerivedData {
  const pad = jobRadius(rules);
  if (apron.radius !== pad) throw new RangeError(`assembly derive: apron ${apron.radius} deep, rules need ${pad}`);
  const s = scratchFor(grid, pad);
  const has = exportChunk(s.dense);
  fillNeighbourhood(s.n, grid, has ? s.dense : null, apron);
  return deriveChunk(s.n, rules, s.classes, times);
}

/** Derives chunk (cx, cy, cz) of a store in this thread (its neighbours read from the same store). */
export function deriveFromStore(store: VoxelStoreCandidate, cx: number, cy: number, cz: number, rules: AssemblyRuleSet | { id: string; version: number }, times?: DeriveTimes): DerivedData {
  const r = 'resolve' in rules ? rules : assemblyRules(rules);
  const apron = buildApron(store, cx, cy, cz, jobRadius(r));
  return deriveWithApron(store.grid, r, apron, (out) => store.exportChunk(cx, cy, cz, out), times);
}
