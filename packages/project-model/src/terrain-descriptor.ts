/**
 * The descriptor of the `terrain` component (its own file, so the terrain's
 * fields grow beside its format). The registry (`descriptors.ts`) lists it
 * with every other component.
 *
 * Pure data.
 */
import { bool, int, json, num, obj, vec2 } from './descriptor-builders';
import type { ComponentDescriptor } from './descriptor-types';
import { TERRAIN_HEIGHT_LIMIT, TERRAIN_LOD_DISTANCE_LIMITS, TERRAIN_SPACING_LIMITS, TERRAIN_TILE_SAMPLES, TERRAIN_TILE_SAMPLES_DEFAULT } from './terrain';

export const terrain: ComponentDescriptor = {
  name: 'terrain',
  label: 'Terrain',
  tooltip: 'A heightfield of square tiles for landscape reaching the horizon, sculpted, painted and cut with the terrain commands (editTerrain).',
  category: 'Rendering',
  value: obj('terrain', 'Terrain', "Tiles of height samples. The object's position is the min corner of tile [0, 0]; its rotation and scale are not applied.", [
    int('tileSamples', 'Tile samples', `Samples along a tile side: ${TERRAIN_TILE_SAMPLES.join(', ')} (2^n + 1; neighbouring tiles share their edge samples). Fixed once tiles hold data.`, { required: true, min: TERRAIN_TILE_SAMPLES[0]!, max: TERRAIN_TILE_SAMPLES[TERRAIN_TILE_SAMPLES.length - 1]!, values: TERRAIN_TILE_SAMPLES, default: TERRAIN_TILE_SAMPLES_DEFAULT }),
    num('spacing', 'Spacing', 'Metres between samples.', { required: true, min: TERRAIN_SPACING_LIMITS.min, max: TERRAIN_SPACING_LIMITS.max, step: 0.05, unit: 'm', default: 1 }),
    vec2('heightRange', 'Height range', 'The lowest and highest height a sample can hold, metres above the object (16-bit steps between them: a narrower range is finer).', { required: true, min: -TERRAIN_HEIGHT_LIMIT, max: TERRAIN_HEIGHT_LIMIT, step: 1, unit: 'm', default: [-128, 384], labels: ['low', 'high'], ascending: true }),
    json('tiles', 'Tiles', 'The tiles: [{x, z, data?}], data the SHA-256 of the tile\'s heights, layers, holes and paint (written by the terrain commands; absent: flat at 0 m).', { required: true, readOnly: true }),
    num('lodDistance', 'Detail distance', 'Metres the finest level of detail reaches from the camera; each coarser level reaches twice as far (a quality level\'s LOD bias divides it). Empty: the nearest the tile size allows, also the least it takes.', { min: TERRAIN_LOD_DISTANCE_LIMITS.min, max: TERRAIN_LOD_DISTANCE_LIMITS.max, step: 1, unit: 'm' }),
    bool('collision', 'Collision', 'The tiles are heightfield colliders in a 3D project; off for scenery the player never reaches.', { default: true }),
  ]),
  add: { kind: 'tool', tool: 'terrain commands (editTerrain)' },
  handles: [],
  excludes: ['model', 'box', 'collider', 'controller', 'instances', 'blockLayer'].map((c) => ({ component: c, reason: 'a terrain is its own level geometry' })),
  prefab: false,
};
