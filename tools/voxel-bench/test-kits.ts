/**
 * Engine-owned test kits for the piece table (piece-table.ts): plain kit
 * sources with the fields a table reads (cases, sections, variant weights,
 * the material binding), no meshes. Shared by the kit-piece tests and the
 * `cases --pieces` measurement.
 */
import { DRAFT_CASE_CATALOGUE, RUN_SECTION_IDS, type PieceKitSource } from '@thirdlight/voxel';
import { MAT } from './world-kit';

/** The town's and the scenes' construction materials. */
export const BUILDING_MATERIALS: readonly number[] = Object.freeze([MAT.stone, MAT.timber, MAT.plaster, MAT.roofTile, MAT.plank, MAT.brick]);

/** `n` variants weighted 1, 2, … n. */
export function weightedVariants(n: number): { weight: number }[] {
  return Array.from({ length: n }, (_, k) => ({ weight: k + 1 }));
}

/** A kit with a piece for every section of every case of the draft catalogue but `enclosed` (nothing shows there), `variants` variants each. */
export function fullTestKit(id: string, materials: readonly number[], variants = 2): PieceKitSource {
  const cases: Record<string, { sections: Record<string, { variants: { weight: number }[] }> }> = {};
  for (const c of DRAFT_CASE_CATALOGUE.cases) {
    if (c.id === 'enclosed') continue;
    cases[c.id] = { sections: Object.fromEntries(RUN_SECTION_IDS.map((s) => [s, { variants: weightedVariants(variants) }])) };
  }
  return { voxelKitId: id, materials: [...materials], cases };
}
