/**
 * The window case a derive job's case pass gives one world cell of a store
 * (the world rules, level 0): what the kit test scene's tests compare its
 * labels with.
 */
import { buildApron, caseIndexOf, chunkGrid, createDenseChunk, createNeighbourhood, evaluateCases, fillNeighbourhood, jobRadius, NO_CASE, WORLD_RULES, type PaletteStore } from '@thirdlight/voxel';

const grid = chunkGrid(32);
const E = grid.edge;
const PAD = jobRadius(WORLD_RULES);

/** The case id the derive job's case pass gives world cell (x, y, z) (null: none). */
export function caseAt(store: Pick<PaletteStore, 'grid' | 'voxelAt' | 'chunkForm' | 'exportChunk'>, x: number, y: number, z: number): { caseId: string | null } {
  const [cx, cy, cz] = [x >> grid.shift, y >> grid.shift, z >> grid.shift];
  const n = createNeighbourhood(E, PAD);
  const dense = createDenseChunk(grid);
  fillNeighbourhood(n, grid, store.exportChunk(cx, cy, cz, dense) ? dense : null, buildApron(store, cx, cy, cz, PAD));
  const cases = new Uint16Array(n.values.length);
  evaluateCases(n, WORLD_RULES, 0, cases);
  const s = n.side;
  const i = (((x & grid.mask) + PAD) * s + ((z & grid.mask) + PAD)) * s + ((y & grid.mask) + PAD);
  const c = cases[i]!;
  return { caseId: c === NO_CASE ? null : WORLD_RULES.catalogue!.cases[caseIndexOf(c)]!.id };
}
