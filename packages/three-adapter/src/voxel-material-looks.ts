/**
 * The voxel surface's looks from the project's material records: the voxel
 * material table (`voxel-surface.ts`) is built from each voxel material's
 * record, so a voxel id draws what its material says, in Play, an export,
 * the Scene view and the voxel world page alike.
 *
 * From a record (instances folded in, as a build ships them): its colour
 * (`params.color`; it tints the record's texture sets, white when it has a
 * set and names none), its tile (`voxel.tileMetres`, on both the construction
 * and the terrain projection, so one repeat is what the record names however
 * a cell is projected), its height depth (`voxel.heightDepth`: how its
 * heights blend, fill with water and displace) and its blend distance
 * (`voxel.blendMetres`; absent: the world's). What a record does not say stays the
 * base look's (by default the per-id stand-in, `voxelStandInLook`), as do
 * ids no record has. A record's surface texture sets draw from the texture
 * arrays (`voxelRecordTextures`: the arrays to assemble and each id's
 * layers), handed to the surface apart from the looks, once they are loaded.
 *
 * A tile must divide the surface's phase (`PHASE_CELLS` cells), so the phase
 * never moves a texture; a record's tile is drawn at the nearest one that
 * does (e.g. 3 m as 2.994 m over a 512 m phase).
 */
import { isVoxelMaterial, resolveMaterialInstances, VOXEL_SURFACES, voxelSurfaceSet, voxelSurfaceTextures, type MaterialDef, type VoxelSurfaceTextures } from '@thirdlight/project-model';
import { VOXEL_SIZE_M } from '@thirdlight/voxel';
import { voxelStandInLook } from './voxel-chunk-view';
import { PHASE_CELLS, type VoxelMaterialLook } from './voxel-surface';

/** A material record as the looks read it (a stored or a shipped one). */
export type VoxelLookRecord = Pick<MaterialDef, 'materialId' | 'shader' | 'params'> & Partial<Pick<MaterialDef, 'instanceOf' | 'voxel' | 'graph' | 'textures' | 'name'>>;

/** The tile drawn for `metres`: the nearest that divides the phase of `cellMetres` cells. */
export function phaseTileMetres(metres: number, cellMetres = VOXEL_SIZE_M): number {
  const phase = PHASE_CELLS * cellMetres;
  return phase / Math.max(1, Math.round(phase / metres));
}

const HEX = /^#?([0-9a-f]{6})$/i;

/**
 * Each voxel id's look from the records (instances resolved here; a shipped list is already resolved), over
 * `base` for what a record leaves out and for ids without one.
 */
export function voxelRecordLooks(materials: readonly VoxelLookRecord[], base: (material: number) => VoxelMaterialLook = voxelStandInLook): (material: number) => VoxelMaterialLook {
  const byId = new Map<number, VoxelLookRecord>();
  const resolved = resolveMaterialInstances(materials as unknown as MaterialDef[]) as unknown as VoxelLookRecord[];
  for (const m of resolved) if (m.voxel !== undefined && isVoxelMaterial(m) && !byId.has(m.voxel.id)) byId.set(m.voxel.id, m);
  return (id) => {
    const look = base(id);
    const m = byId.get(id);
    if (m === undefined) return look;
    // A record's colour tints its texture sets; one with a set and no colour draws the set as authored (white), not
    // the stand-in swatch.
    const named = typeof m.params['color'] === 'string' ? HEX.exec(m.params['color'])?.[1] : undefined;
    const colour = named ?? (VOXEL_SURFACES.some((s) => voxelSurfaceSet(m.voxel!, s)?.albedo !== undefined) ? 'ffffff' : undefined);
    const tile = m.voxel!.tileMetres;
    const depth = m.voxel!.heightDepth;
    const blend = m.voxel!.blendMetres;
    return {
      ...look,
      ...(colour !== undefined ? { colour: parseInt(colour, 16) } : {}),
      ...(tile !== undefined ? { constructionTileMetres: phaseTileMetres(tile), terrainTileMetres: phaseTileMetres(tile) } : {}),
      ...(depth !== undefined ? { heightDepthMetres: depth } : {}),
      ...(blend !== undefined ? { blendMetres: blend } : {}),
    };
  };
}

/** A key that changes exactly when the looks {@link voxelRecordLooks} makes of `materials` may (what of the records it reads). */
export function voxelLooksKey(materials: readonly VoxelLookRecord[]): string {
  return JSON.stringify(materials.map((m) => [m.materialId, m.instanceOf ?? null, m.shader, m.params['color'] ?? null, m.voxel ?? null, m.graph !== undefined]));
}

/** The texture arrays the records' surface sets make and each voxel id's layers (instances resolved here; null: no record has a set with an albedo). */
export function voxelRecordTextures(materials: readonly VoxelLookRecord[]): VoxelSurfaceTextures | null {
  return voxelSurfaceTextures(resolveMaterialInstances(materials as unknown as MaterialDef[]));
}
