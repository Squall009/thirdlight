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

/** One voxel's fields (PROVISIONAL widths: material 23 bits, category 4, orientation 5, shape 8). */
export interface VoxelRecord {
  /** Material id; 0 is air. */
  material: number;
  /** Coarse category ({@link VOXEL_CATEGORY}); architectural detail is inferred, never stored. */
  category: number;
  /** Shape/density: 0 empty … 255 full; between is a surface (or a liquid's fill). */
  shape: number;
  /** One of the 24 axis-aligned rotations ({@link ORIENTATION_COUNT}; 0 = identity; PROVISIONAL). */
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

/** Categories assigned so far; a stored category of this value or above is refused. */
export const VOXEL_CATEGORY_COUNT = 5;

/**
 * Orientations: the 24 rotations of the cube onto itself, so a voxel's
 * local axes always land on world axes. Orientation k is
 * `face(k >> 2) · spin(k & 3)`: first `k & 3` quarter turns about the
 * voxel's own +y (counter-clockwise seen from above, +x towards −z), then
 * the tip that carries +y to its face: 0 +y (none), 1 −y (half turn about
 * +x), 2 +x, 3 −x, 4 +z, 5 −z (quarter turns about z or x). 0 is the
 * identity. PROVISIONAL: the role and case catalogue may give the cases
 * their own meaning for these numbers; values from 24 up are refused.
 */
export const ORIENTATION_COUNT = 24;

/** Material id of air. */
export const MATERIAL_AIR = 0;

/** Shape of an empty cell. */
export const SHAPE_EMPTY = 0;

/** Shape of a full cell. */
export const SHAPE_FULL = 255;

/**
 * Bits of a material id. The record value packs material, category and
 * orientation into 32 bits (palette-image.ts), so the ids a world can name
 * are 2²³ − 1 (8,388,607): a format width far past any world's needs, not a
 * count sized to a sample, at no cost per cell (at rest, 3 bytes a palette
 * entry). A full 32-bit material field measured costs per changed cell
 * (cell deltas 7 → 9 bytes, aprons 4 → 8 bytes a cell); see the format spec.
 */
export const MATERIAL_BITS = 23;
/** Bits of a category (room for 16; {@link VOXEL_CATEGORY_COUNT} are assigned). */
export const CATEGORY_BITS = 4;
/** Bits of an orientation (room for 32; {@link ORIENTATION_COUNT} are assigned). */
export const ORIENTATION_BITS = 5;

/** The largest material id. */
export const MATERIAL_ID_MAX = 2 ** MATERIAL_BITS - 1;

/** The largest value of an 8-bit plane. */
export const BYTE_PLANE_MAX = 0xff;

/** Air: every field zero. */
export const AIR: Readonly<VoxelRecord> = Object.freeze({ material: MATERIAL_AIR, category: VOXEL_CATEGORY.air, shape: SHAPE_EMPTY, orientation: 0 });

/** The record's planes, in the order a plane-wise encoding writes them. */
export type VoxelPlane = 'material' | 'category' | 'shape' | 'orientation';

/** Every plane, in encoding order. */
export const VOXEL_PLANES: readonly VoxelPlane[] = Object.freeze(['material', 'category', 'shape', 'orientation']);

/** Each plane's bit in a plane mask (one byte naming the planes an encoding holds). */
export const PLANE_BIT: Readonly<Record<VoxelPlane, number>> = Object.freeze({ material: 1, category: 2, shape: 4, orientation: 8 });

/** The mask of every plane. */
export const ALL_PLANES = 15;

/** The mask of a plane list. */
export function planeMask(planes: readonly VoxelPlane[]): number {
  let m = 0;
  for (const p of planes) m |= PLANE_BIT[p];
  return m;
}

/** Bytes per cell of each plane in the provisional widths. */
export const PLANE_BYTES: Readonly<Record<VoxelPlane, number>> = Object.freeze({ material: 3, category: 1, shape: 1, orientation: 1 });

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

/** Throws unless every field fits its provisional plane and its assigned values. */
export function checkVoxel(v: Readonly<VoxelRecord>): void {
  const ok = (n: number, max: number): boolean => Number.isInteger(n) && n >= 0 && n <= max;
  if (!ok(v.material, MATERIAL_ID_MAX) || !ok(v.category, VOXEL_CATEGORY_COUNT - 1) || !ok(v.shape, BYTE_PLANE_MAX) || !ok(v.orientation, ORIENTATION_COUNT - 1)) {
    throw new RangeError(`voxel field out of range: ${JSON.stringify(v)}`);
  }
}

/** Row-major 3 × 3 integer matrix (entries −1, 0, 1). */
export type AxisRotation = readonly [number, number, number, number, number, number, number, number, number];

function mul(a: AxisRotation, b: AxisRotation): AxisRotation {
  const o: number[] = [];
  for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) o.push(a[r * 3]! * b[c]! + a[r * 3 + 1]! * b[3 + c]! + a[r * 3 + 2]! * b[6 + c]!);
  return o as unknown as AxisRotation;
}

const IDENTITY: AxisRotation = [1, 0, 0, 0, 1, 0, 0, 0, 1];
/** A quarter turn about +y, counter-clockwise seen from above: +x goes to −z. */
const SPIN: AxisRotation = [0, 0, 1, 0, 1, 0, -1, 0, 0];
/** The tips carrying +y to +y, −y, +x, −x, +z, −z. */
const FACES: readonly AxisRotation[] = [IDENTITY, [1, 0, 0, 0, -1, 0, 0, 0, -1], [0, 1, 0, -1, 0, 0, 0, 0, 1], [0, -1, 0, 1, 0, 0, 0, 0, 1], [1, 0, 0, 0, 0, -1, 0, 1, 0], [1, 0, 0, 0, 0, 1, 0, -1, 0]];

/** The rotation an orientation names ({@link ORIENTATION_COUNT}); throws on a value that names none. */
export function orientationMatrix(k: number): AxisRotation {
  if (!Number.isInteger(k) || k < 0 || k >= ORIENTATION_COUNT) throw new RangeError(`orientation ${k} is not one of the ${ORIENTATION_COUNT} rotations`);
  let m = FACES[k >> 2]!;
  for (let q = 0; q < (k & 3); q++) m = mul(m, SPIN);
  return m;
}
