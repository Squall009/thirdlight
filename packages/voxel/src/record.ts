/**
 * The voxel record: what one cell of a voxel world stores, as one 32-bit
 * value.
 *
 *   bits  0–11  material   (4,096 ids a world; 0 is air)
 *   bits 12–15  role       (what the voxel is for: terrain, wall, roof, …)
 *   bits 16–19  shape      (16 fill levels: 0 empty … 15 full)
 *   bits 20–22  wetness    (0 dry … 7 soaked)
 *   bits 23–31  reserved   (0; the next per-voxel field takes them)
 *
 * The value is the unit everywhere: palettes, aprons, cell deltas, region
 * uniform entries, saves and the runtime overlay all hold whole values, so
 * a read or write of one voxel is one 32-bit load or store. Orientation is
 * not stored: a structure's grid carries its rotation, stamps are rotated
 * before they are voxelized and details come from the arrangement.
 * Beams, banisters and soffits are not roles either: they are inferred from
 * the arrangement, never stored.
 *
 * Every form that stores raw values outside the chunk codec names the value
 * form it holds ({@link RECORD_VALUE_FORM}).
 */

/** One voxel's fields (material 12 bits, role 4, shape 4, wetness 3). */
export interface VoxelRecord {
  /** Material id; 0 is air. */
  material: number;
  /** Role ({@link VOXEL_ROLE}); architectural detail is inferred, never stored. */
  role: number;
  /** Fill level: 0 empty … {@link SHAPE_FULL} full; between is a surface (or a liquid's fill). */
  shape: number;
  /** Wetness: 0 dry … {@link WETNESS_MAX}. Feeds shading only. */
  wetness: number;
}

/**
 * Roles: what a stored voxel is for. Values past {@link VOXEL_ROLE_COUNT}
 * are unassigned and refused (room for 16). Beams, banisters, soffits and
 * mouldings are not roles: the assembly rules read them from the
 * arrangement of the voxels around them.
 */
export const VOXEL_ROLE = Object.freeze({
  air: 0,
  terrain: 1,
  liquid: 2,
  wall: 3,
  floor: 4,
  roof: 5,
  foundation: 6,
  stair: 7,
  pillar: 8,
  opening: 9,
});

/** Roles assigned so far; a stored role of this value or above is refused. */
export const VOXEL_ROLE_COUNT = 10;

/** Material id of air. */
export const MATERIAL_AIR = 0;

/** Bits of a material id: 4,096 ids a world (a format width, not a count cap on anything else). */
export const MATERIAL_BITS = 12;
/** Bits of a role (room for 16; {@link VOXEL_ROLE_COUNT} are assigned). */
export const ROLE_BITS = 4;
/** Bits of a shape: 16 fill levels. */
export const SHAPE_BITS = 4;
/** Bits of wetness: 8 levels. */
export const WETNESS_BITS = 3;
/** Bits no field uses yet; they must be 0 and are refused otherwise. */
export const RESERVED_BITS = 32 - MATERIAL_BITS - ROLE_BITS - SHAPE_BITS - WETNESS_BITS;

export const ROLE_SHIFT = MATERIAL_BITS;
export const SHAPE_SHIFT = ROLE_SHIFT + ROLE_BITS;
export const WETNESS_SHIFT = SHAPE_SHIFT + SHAPE_BITS;
export const RESERVED_SHIFT = WETNESS_SHIFT + WETNESS_BITS;

/** The largest material id. */
export const MATERIAL_ID_MAX = 2 ** MATERIAL_BITS - 1;
/** Shape of an empty cell. */
export const SHAPE_EMPTY = 0;
/** Shape of a full cell. */
export const SHAPE_FULL = 2 ** SHAPE_BITS - 1;
/** The largest wetness. */
export const WETNESS_MAX = 2 ** WETNESS_BITS - 1;

/** Mask of the role field once shifted down by {@link ROLE_SHIFT}. */
export const ROLE_MASK = 2 ** ROLE_BITS - 1;
const SHAPE_MASK = 2 ** SHAPE_BITS - 1;
const WETNESS_MASK = 2 ** WETNESS_BITS - 1;

/** A voxel value from its fields (each must fit its width; callers check with {@link checkVoxel}). */
export function recordValue(material: number, role: number, shape: number, wetness: number): number {
  return (material | (role << ROLE_SHIFT) | (shape << SHAPE_SHIFT) | (wetness << WETNESS_SHIFT)) >>> 0;
}

export function valueMaterial(v: number): number {
  return v & MATERIAL_ID_MAX;
}

export function valueRole(v: number): number {
  return (v >>> ROLE_SHIFT) & ROLE_MASK;
}

export function valueShape(v: number): number {
  return (v >>> SHAPE_SHIFT) & SHAPE_MASK;
}

export function valueWetness(v: number): number {
  return (v >>> WETNESS_SHIFT) & WETNESS_MASK;
}

/** The reserved bits of a value (0 in every value this format holds). */
export function valueReserved(v: number): number {
  return v >>> RESERVED_SHIFT;
}

/** A record's value; air is always 0, whatever its other fields say. */
export function valueOf(v: Readonly<VoxelRecord>): number {
  return v.material === MATERIAL_AIR ? 0 : recordValue(v.material, v.role, v.shape, v.wetness);
}

/** Writes a value's fields into `out`. */
export function readValue(value: number, out: VoxelRecord): VoxelRecord {
  out.material = valueMaterial(value);
  out.role = valueRole(value);
  out.shape = valueShape(value);
  out.wetness = valueWetness(value);
  return out;
}

/** Density 0 … 255 of a shape (the scale the derived consumers' thresholds use). */
export const DENSITY_FULL = 255;
const DENSITY_STEP = DENSITY_FULL / SHAPE_FULL;

/** A shape's density on the 0 … {@link DENSITY_FULL} scale. */
export function shapeDensity(shape: number): number {
  return shape * DENSITY_STEP;
}

/**
 * The record value form: how a raw value is laid out where a format stores
 * it outside the chunk codec (region uniform entries, cell deltas in undo
 * records and saves, save uniform payloads, structure overrides). Form 2 is
 * the u32 above. Form 1 (the draft 23/4/5 layout: material, category,
 * orientation, with shape beside it) was never approved and is not read.
 * A later field takes reserved bits inside form 2's u32; a form changes only
 * if the value has to grow past 32 bits.
 */
export const RECORD_VALUE_FORM = 2;

/** Throws unless `form` is a record value form this build reads (`what` names the format). */
export function checkValueForm(what: string, form: number): void {
  if (form !== RECORD_VALUE_FORM) throw new RangeError(`${what}: record value form ${form} (this build reads ${RECORD_VALUE_FORM})`);
}

/** Air: every field zero. */
export const AIR: Readonly<VoxelRecord> = Object.freeze({ material: MATERIAL_AIR, role: VOXEL_ROLE.air, shape: SHAPE_EMPTY, wetness: 0 });

/** The record's fields, in the order a field-wise encoding writes them. */
export type VoxelPlane = 'material' | 'role' | 'shape' | 'wetness';

/** Every field, in encoding order. */
export const VOXEL_PLANES: readonly VoxelPlane[] = Object.freeze(['material', 'role', 'shape', 'wetness']);

/** Each field's bit in a field mask (plane masks, the feeds table and the saved-fields mask). */
export const PLANE_BIT: Readonly<Record<VoxelPlane, number>> = Object.freeze({ material: 1, role: 2, shape: 4, wetness: 8 });

/** The mask of every field. */
export const ALL_PLANES = 15;

/** The mask of a field list. */
export function planeMask(planes: readonly VoxelPlane[]): number {
  let m = 0;
  for (const p of planes) m |= PLANE_BIT[p];
  return m;
}

/** The fields (as a {@link PLANE_BIT} mask) in which two values differ. */
export function changedFields(a: number, b: number): number {
  if (a === b) return 0;
  let m = 0;
  if (valueMaterial(a) !== valueMaterial(b)) m |= PLANE_BIT.material;
  if (valueRole(a) !== valueRole(b)) m |= PLANE_BIT.role;
  if (valueShape(a) !== valueShape(b)) m |= PLANE_BIT.shape;
  if (valueWetness(a) !== valueWetness(b)) m |= PLANE_BIT.wetness;
  return m;
}

/**
 * A cell's material change as one number, `from << MATERIAL_BITS | to`: an
 * edit reports the distinct ones it made, so what reads materials beside
 * the shader data (a kit's pieces) can tell whether the change reaches it.
 */
export function materialSwap(from: number, to: number): number {
  return (from << MATERIAL_BITS) | to;
}

/** The material a {@link materialSwap} changed from. */
export function swapFrom(swap: number): number {
  return swap >>> MATERIAL_BITS;
}

/** The material a {@link materialSwap} changed to. */
export function swapTo(swap: number): number {
  return swap & MATERIAL_ID_MAX;
}

/** Bytes per cell of each field in a dense chunk and the measurement encodings. */
export const PLANE_BYTES: Readonly<Record<VoxelPlane, number>> = Object.freeze({ material: 2, role: 1, shape: 1, wetness: 1 });

/** A fresh record (air unless fields are given). */
export function voxel(material = MATERIAL_AIR, role: number = VOXEL_ROLE.air, shape = SHAPE_EMPTY, wetness = 0): VoxelRecord {
  return { material, role, shape, wetness };
}

/** Whether two records are equal in every field. */
export function sameVoxel(a: Readonly<VoxelRecord>, b: Readonly<VoxelRecord>): boolean {
  return a.material === b.material && a.role === b.role && a.shape === b.shape && a.wetness === b.wetness;
}

/** Whether a record is air (material 0; the other fields are then ignored). */
export function isAir(v: Readonly<VoxelRecord>): boolean {
  return v.material === MATERIAL_AIR;
}

/** Throws unless every field fits its width and holds an assigned value. */
export function checkVoxel(v: Readonly<VoxelRecord>): void {
  const ok = (n: number, max: number): boolean => Number.isInteger(n) && n >= 0 && n <= max;
  if (!ok(v.material, MATERIAL_ID_MAX) || !ok(v.role, VOXEL_ROLE_COUNT - 1) || !ok(v.shape, SHAPE_FULL) || !ok(v.wetness, WETNESS_MAX)) {
    throw new RangeError(`voxel field out of range: ${JSON.stringify(v)}`);
  }
}

/**
 * Throws unless a value is one the format holds: a u32, air as the one
 * value 0, an assigned role, reserved bits 0. `what` names the bytes it was
 * read from.
 */
export function checkRecordValue(v: number, what = 'voxel value'): void {
  if (!Number.isInteger(v) || v < 0 || v > 0xffffffff) throw new RangeError(`${what}: value ${v} is not a u32`);
  if (valueReserved(v) !== 0) throw new RangeError(`${what}: value ${v} sets reserved bits`);
  if (valueMaterial(v) === MATERIAL_AIR) {
    if (v !== 0) throw new RangeError(`${what}: air with a role, shape or wetness`);
    return;
  }
  if (valueRole(v) >= VOXEL_ROLE_COUNT) throw new RangeError(`${what}: unassigned role ${valueRole(v)}`);
}

/**
 * Derived outputs, as bits of a parts mask: what a change to the voxels can
 * make stale. `shader` is the per-chunk material and wetness grid the
 * surface shader blends from; the others are built by the assembly
 * evaluation.
 */
export const DERIVED_PART = Object.freeze({ mesh: 1, collision: 2, nav: 4, light: 8, shader: 16 });

/** Every derived part. */
export const ALL_DERIVED_PARTS = 31;

/**
 * Which derived outputs each field drives (the feeds mask). Shape and role
 * decide geometry, so they drive the mesh, collision, navigation and light
 * occupancy; material and wetness only change how a surface is shaded, so a
 * change of only those re-derives the shader data and nothing else.
 */
export const FIELD_FEEDS: Readonly<Record<VoxelPlane, number>> = Object.freeze({
  material: DERIVED_PART.shader,
  role: DERIVED_PART.mesh | DERIVED_PART.collision | DERIVED_PART.nav | DERIVED_PART.light,
  shape: DERIVED_PART.mesh | DERIVED_PART.collision | DERIVED_PART.nav | DERIVED_PART.light,
  wetness: DERIVED_PART.shader,
});

/** The derived parts a change of `fields` (a {@link PLANE_BIT} mask) feeds, by {@link FIELD_FEEDS}. */
export function fieldsFeed(fields: number): number {
  let parts = 0;
  for (const p of VOXEL_PLANES) if (fields & PLANE_BIT[p]) parts |= FIELD_FEEDS[p];
  return parts;
}

/**
 * The fields a runtime change keeps in a save unless the game chooses
 * otherwise: everything but wetness, which weather sets again on its own.
 */
export const DEFAULT_SAVED_FIELDS = PLANE_BIT.material | PLANE_BIT.role | PLANE_BIT.shape;

/**
 * The value a save keeps for a cell: `now`'s fields where `saved` has
 * their bit, `base`'s elsewhere. Air is whole: a dug cell stays air only
 * when material is saved, and a saved field on a cell whose base is air
 * keeps `now`'s whole value (there is no base voxel to merge onto).
 */
export function savedValue(base: number, now: number, saved: number): number {
  if (base === now || (saved & ALL_PLANES) === ALL_PLANES) return now;
  if (base === 0 || now === 0) return saved & PLANE_BIT.material ? now : base;
  return recordValue(
    saved & PLANE_BIT.material ? valueMaterial(now) : valueMaterial(base),
    saved & PLANE_BIT.role ? valueRole(now) : valueRole(base),
    saved & PLANE_BIT.shape ? valueShape(now) : valueShape(base),
    saved & PLANE_BIT.wetness ? valueWetness(now) : valueWetness(base),
  );
}
