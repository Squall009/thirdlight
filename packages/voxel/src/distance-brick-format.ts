/**
 * The distance-brick format's constants: a sparse signed distance field cut
 * into bricks of 8 × 8 × 8 cells, each storing its 9 × 9 × 9 corner samples
 * as bytes over ± a band, or one word saying the brick is wholly outside or
 * inside. Imported models' fields (project-model `distance-bricks.ts`) and
 * a voxel world's far bricks (`far-bricks.ts`) share it, and so do the
 * marchers that walk them (the lighting tracer, the far field's draw), so
 * the constants live here, below both.
 */

/** Cells per brick side. */
export const DISTANCE_BRICK_CELLS = 8;
/** Samples per brick side (its corners included). */
export const DISTANCE_BRICK_SIDE = DISTANCE_BRICK_CELLS + 1;
/** Samples per brick. */
export const DISTANCE_BRICK_SAMPLES = DISTANCE_BRICK_SIDE ** 3;
/** A brick the surface does not pass through, outside the shape. */
export const DISTANCE_BRICK_OUTSIDE = -1;
/** A brick wholly inside the shape. */
export const DISTANCE_BRICK_INSIDE = -2;
/** Band of the stored distances, in voxels: a sample farther than this from the surface stores the band. */
export const DISTANCE_BRICK_BAND_VOXELS = 2;

/** Sphere tracing through bricks stops this close to the surface (voxels). */
export const BRICK_HIT_VOXELS = 0.05;
/** The shortest sphere-tracing step through bricks (voxels): thinner features than this may be stepped over. */
export const BRICK_MIN_STEP_VOXELS = 0.25;

/** A stored byte as a distance (in the band's unit: metres for a model's field, cells for a far brick). */
export function distanceOfSample(q: number, band: number): number {
  return ((q / 255) * 2 - 1) * band;
}

/** A distance (the band's unit) as a stored byte: clamped to ± band, 0 is −band, 255 is +band. */
export function sampleOfDistance(d: number, band: number): number {
  const u = Math.max(-1, Math.min(1, d / band));
  return Math.round((u * 0.5 + 0.5) * 255);
}
