/**
 * The voxel record the storage candidates are measured with.
 *
 * PROVISIONAL: this is a test shape, not the voxel format. It keeps every
 * field the plan's voxel may need apart (material, coarse category,
 * shape/density, orientation) so a candidate can be measured with and
 * without each plane; which planes the format keeps, their widths and the
 * category set are open questions the measurements and the owner settle.
 * Nothing outside the storage benchmarks may treat these widths or values as
 * the format.
 */

/** One voxel's fields (PROVISIONAL widths: material 16 bits, the rest 8 bits each). */
export interface VoxelRecord {
  /** Material id; 0 is air. */
  material: number;
  /** Coarse category ({@link VOXEL_CATEGORY}); architectural detail is inferred, never stored. */
  category: number;
  /** Shape/density: 0 empty … 255 full; between is a surface (or a liquid's fill). */
  shape: number;
  /** Orientation code (quarter turns and slope direction; meaning still open). */
  orientation: number;
}

/**
 * PROVISIONAL coarse categories: what a stored voxel says about itself.
 * Beams, banisters, soffits and mouldings are not categories: they are read
 * from the arrangement of construction voxels around them.
 */
export const VOXEL_CATEGORY = Object.freeze({
  air: 0,
  terrain: 1,
  construction: 2,
  roof: 3,
  liquid: 4,
});

/** Material id of air. */
export const MATERIAL_AIR = 0;

/** Shape of an empty cell. */
export const SHAPE_EMPTY = 0;

/** Shape of a full cell. */
export const SHAPE_FULL = 255;

/** The largest material id the provisional 16-bit plane holds. */
export const MATERIAL_ID_MAX = 0xffff;

/** The largest value of an 8-bit plane. */
export const BYTE_PLANE_MAX = 0xff;

/** Air: every field zero. */
export const AIR: Readonly<VoxelRecord> = Object.freeze({ material: MATERIAL_AIR, category: VOXEL_CATEGORY.air, shape: SHAPE_EMPTY, orientation: 0 });

/** The record's planes, in the order a plane-wise encoding writes them. */
export type VoxelPlane = 'material' | 'category' | 'shape' | 'orientation';

/** Every plane, in encoding order. */
export const VOXEL_PLANES: readonly VoxelPlane[] = Object.freeze(['material', 'category', 'shape', 'orientation']);

/** Bytes per cell of each plane in the provisional widths. */
export const PLANE_BYTES: Readonly<Record<VoxelPlane, number>> = Object.freeze({ material: 2, category: 1, shape: 1, orientation: 1 });

/** A fresh record (air unless fields are given). */
export function voxel(material = MATERIAL_AIR, category: number = VOXEL_CATEGORY.air, shape = SHAPE_EMPTY, orientation = 0): VoxelRecord {
  return { material, category, shape, orientation };
}

/** Whether two records are equal in every field. */
export function sameVoxel(a: Readonly<VoxelRecord>, b: Readonly<VoxelRecord>): boolean {
  return a.material === b.material && a.category === b.category && a.shape === b.shape && a.orientation === b.orientation;
}

/** Whether a record is air (material 0; the other fields are then ignored). */
export function isAir(v: Readonly<VoxelRecord>): boolean {
  return v.material === MATERIAL_AIR;
}

/** Throws unless every field fits its provisional plane. */
export function checkVoxel(v: Readonly<VoxelRecord>): void {
  const ok = (n: number, max: number): boolean => Number.isInteger(n) && n >= 0 && n <= max;
  if (!ok(v.material, MATERIAL_ID_MAX) || !ok(v.category, BYTE_PLANE_MAX) || !ok(v.shape, BYTE_PLANE_MAX) || !ok(v.orientation, BYTE_PLANE_MAX)) {
    throw new RangeError(`voxel field out of range: ${JSON.stringify(v)}`);
  }
}
