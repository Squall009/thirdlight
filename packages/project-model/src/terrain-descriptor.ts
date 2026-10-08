/**
 * The descriptor of the `terrain` component (its own file, so the terrain's
 * fields grow beside its format). The registry (`descriptors.ts`) lists it
 * with every other component.
 *
 * Pure data.
 */
import { bool, int, json, num, obj, vec2 } from './descriptor-builders';
import type { ComponentDescriptor } from './descriptor-types';
import { streamingField } from './world-streaming-descriptor';
import { TERRAIN_HEIGHT_LIMIT, TERRAIN_LOD_DISTANCE_LIMITS, TERRAIN_MACRO_DISTANCE_LIMITS, TERRAIN_SPACING_LIMITS, TERRAIN_TILE_SAMPLES, TERRAIN_TILE_SAMPLES_DEFAULT } from './terrain';

export const terrain: ComponentDescriptor = {
  name: 'terrain',
  label: 'Terrain',
  tooltip: 'A heightfield of square tiles for landscape reaching the horizon, sculpted, painted and cut with the terrain commands (editTerrain).',
  category: 'Rendering',
  value: obj('terrain', 'Terrain', "Tiles of height samples. The object's position is the min corner of tile [0, 0]; its rotation and scale are not applied.", [
    int('tileSamples', 'Tile samples', `Samples along a tile side: ${TERRAIN_TILE_SAMPLES.join(', ')} (2^n + 1; neighbouring tiles share their edge samples). Fixed once tiles hold data.`, { required: true, min: TERRAIN_TILE_SAMPLES[0]!, max: TERRAIN_TILE_SAMPLES[TERRAIN_TILE_SAMPLES.length - 1]!, values: TERRAIN_TILE_SAMPLES, default: TERRAIN_TILE_SAMPLES_DEFAULT }),
    num('spacing', 'Spacing', 'Metres between samples.', { required: true, min: TERRAIN_SPACING_LIMITS.min, max: TERRAIN_SPACING_LIMITS.max, step: 0.05, unit: 'm', default: 1 }),
    vec2('heightRange', 'Height range', 'The lowest and highest height a sample can hold, metres above the object (16-bit steps between them: a narrower range is finer).', { required: true, min: -TERRAIN_HEIGHT_LIMIT, max: TERRAIN_HEIGHT_LIMIT, step: 1, unit: 'm', default: [-128, 384], labels: ['low', 'high'], ascending: true }),
    json('tiles', 'Tiles', 'The tiles: [{x, z, data?, scatter?, base?}], data the SHA-256 of the tile\'s heights, layers, holes and paint (absent: flat at 0 m), scatter of its scatter rules\' copies, base of the tile as made by hand before splines shaped it (written by the terrain commands).', { required: true, readOnly: true }),
    num('lodDistance', 'Detail distance', 'Metres the finest level of detail reaches from the camera; each coarser level reaches twice as far (a quality level\'s LOD bias divides it). Empty: the nearest the tile size allows, also the least it takes.', { min: TERRAIN_LOD_DISTANCE_LIMITS.min, max: TERRAIN_LOD_DISTANCE_LIMITS.max, step: 1, unit: 'm' }),
    bool('collision', 'Collision', 'The tiles are heightfield colliders in a 3D project; off for scenery the player never reaches.', { default: true }),
    num('macroDistance', 'Macro distance', 'Metres past which each tile is drawn from its macro texture — its look baked from above (albedo and normal, a few metres a texel) — instead of its material\'s layers: two texture reads instead of a dozen for the far ground. Empty: the layers everywhere.', { min: TERRAIN_MACRO_DISTANCE_LIMITS.min, max: TERRAIN_MACRO_DISTANCE_LIMITS.max, step: 10, unit: 'm' }),
    json('rules', 'Material rules', 'Layers by slope, height, cavity and noise, baked into the tiles: [{layer, strength?, face?, height?, slope?, cavity?, noise?, weight?}] (set and baked by Material rules in the terrain tools, or editTerrain bake; hand paint stays over them).', { readOnly: true }),
    json('scatter', 'Scatter rules', 'Models placed by rules, their copies baked per tile: [{id, asset, density, spacing?, scale?, yaw?, align?, sink?, seed?, height?, slope?, cavity?, noise?, layers?, exclude?, castShadow?, chunkSize?, density falloff, lodPerCopy?, impostorSize?, collide?}] (set and baked by Scatter rules in the terrain tools, or editTerrain bake; the scatter brush\'s hand edits stay over them).', { readOnly: true }),
    json('layers', 'Edit layers', 'Layers over the hand-made ground, applied in order and combined into the tiles: [{id, kind: stamps|erosion|splines|blocks, name?, enabled?, strength?, stamps?: [{asset, at, size, rotation?, height, mode?, y?, falloff?}], tiles?, settings?, blockLayers?, mode?: cut|flatten, blend?, paint?}] (the Layers list in the terrain tools; erosion is run by editTerrain erode; a blocks layer makes the ground meet block layers: their border followed over blend metres, cut away or flattened under them, their paint carried across; absent: one base layer with the splines on top).', { readOnly: true }),
    streamingField('tiles', false, 1500),
    vec2('uvOrigin', 'Texture origin', 'The world x, z its material\'s texture coordinates count from (empty: the object\'s position). A terrain with a blocks layer takes the block layer\'s origin, so textures line up across the border.', { min: -TERRAIN_HEIGHT_LIMIT * 100, max: TERRAIN_HEIGHT_LIMIT * 100, step: 1, unit: 'm', labels: ['x', 'z'] }),
    json('overview', 'Overview', 'The SHA-256 of every tile at its coarsest level, which a streamed terrain draws past its render ring (written by a build, never in the editor).', { readOnly: true }),
  ]),
  add: { kind: 'tool', tool: 'terrain commands (editTerrain)' },
  handles: [],
  excludes: ['model', 'box', 'collider', 'controller', 'instances', 'blockLayer', 'spline'].map((c) => ({ component: c, reason: 'a terrain is its own level geometry' })),
  prefab: false,
};
