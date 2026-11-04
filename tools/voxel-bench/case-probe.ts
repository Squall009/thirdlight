/**
 * The case and run section a derive job's case and run passes give one
 * world cell of a store (the world rules, level 0): what the kit test
 * scene's tests compare its labels with.
 */
import {
  buildApron,
  caseIndexOf,
  chunkGrid,
  createDenseChunk,
  createNeighbourhood,
  evaluateCases,
  evaluateRuns,
  fillNeighbourhood,
  jobRadius,
  NO_CASE,
  NO_SECTION,
  RUN_SECTION_IDS,
  runSectionOf,
  WORLD_RULES,
  type PaletteStore,
} from '@thirdlight/voxel';

const grid = chunkGrid(32);
const E = grid.edge;
const PAD = jobRadius(WORLD_RULES);

/** Case id and run section the derive job's case and run passes give world cell (x, y, z). */
export function caseAndSectionAt(store: Pick<PaletteStore, 'grid' | 'voxelAt' | 'chunkForm' | 'exportChunk'>, x: number, y: number, z: number): { caseId: string | null; section: string | null } {
  const [cx, cy, cz] = [x >> grid.shift, y >> grid.shift, z >> grid.shift];
  const n = createNeighbourhood(E, PAD);
  const dense = createDenseChunk(grid);
  fillNeighbourhood(n, grid, store.exportChunk(cx, cy, cz, dense) ? dense : null, buildApron(store, cx, cy, cz, PAD));
  const cases = new Uint16Array(n.values.length);
  const count = evaluateCases(n, WORLD_RULES, 0, cases);
  const sections = new Uint16Array(n.values.length);
  evaluateRuns(n, WORLD_RULES, cases, sections, count);
  const s = n.side;
  const i = (((x & grid.mask) + PAD) * s + ((z & grid.mask) + PAD)) * s + ((y & grid.mask) + PAD);
  const c = cases[i]!;
  const sec = sections[i]!;
  return { caseId: c === NO_CASE ? null : WORLD_RULES.catalogue!.cases[caseIndexOf(c)]!.id, section: sec === NO_SECTION ? null : RUN_SECTION_IDS[runSectionOf(sec)]! };
}

