/**
 * Terrain sizes read by modules the terrain's own modules load (the
 * collider limits, the surface rules, splines, scatter): in a module of
 * their own with no imports, so they are there whatever loads first.
 */

/** The tile sizes a terrain may use (samples per side, 2ⁿ + 1). */
export const TERRAIN_TILE_SAMPLES: readonly number[] = Object.freeze([17, 33, 65, 129, 257, 513, 1025]);
/** The most material layers a terrain can index (one byte per index). */
export const TERRAIN_LAYER_MAX = 255;
