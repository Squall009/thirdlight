/**
 * Engine-owned test kits for the piece table (piece-table.ts): plain kit
 * sources with the fields a table reads (slots, their meshes' weights and
 * rotations, the material binding), no meshes. Shared by the kit-piece tests
 * and the `cases --pieces` measurement.
 */
import { WORLD_RULES, type CaseCatalogueDef, type PieceKitSource } from '@thirdlight/voxel';
import { MAT } from './world-kit';

/** The town's and the scenes' construction materials. */
export const BUILDING_MATERIALS: readonly number[] = Object.freeze([MAT.stone, MAT.timber, MAT.plaster, MAT.roofTile, MAT.plank, MAT.brick]);

/** `n` slot meshes weighted 1, 2, … n. */
export function weightedVariants(n: number): { weight: number }[] {
  return Array.from({ length: n }, (_, k) => ({ weight: k + 1 }));
}

/** A kit with every slot of `catalogue` (the world's) filled, `variants` meshes each. */
export function fullTestKit(id: string, materials: readonly number[], variants = 2, catalogue: CaseCatalogueDef = WORLD_RULES.catalogue!): PieceKitSource {
  const slots: Record<string, { meshes: { weight: number }[] }> = {};
  for (const c of catalogue.cases) slots[c.id] = { meshes: weightedVariants(variants) };
  return { voxelKitId: id, materials: [...materials], slots };
}
