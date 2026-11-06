/**
 * The descriptor of the `voxelWorld` component (its own file, beside the
 * format in `voxel-world.ts`). The registry (`descriptors.ts`) lists it with
 * every other component. Its defaults are the voxel format's, in metres.
 *
 * Pure data.
 */
import { COLLISION_RING_HYSTERESIS_CELLS, SECTION_EDGES, VOXEL_PLANES, VOXEL_SIZE_M } from '@thirdlight/voxel';
import { enm, ID, int, list, map, num, obj, str } from './descriptor-builders';
import type { ComponentDescriptor } from './descriptor-types';
import { STREAMING_RADIUS_LIMITS } from './world-streaming';
import { VOXEL_RING_SCALE_MAX, VOXEL_RING_SCALE_MIN } from './quality-levels';
import { VOXEL_WORLD_DEFAULTS } from './voxel-world';

const D = VOXEL_WORLD_DEFAULTS;
const metres = (key: string, label: string, tooltip: string, value?: number): ReturnType<typeof num> =>
  num(key, label, tooltip, { min: STREAMING_RADIUS_LIMITS.min, max: STREAMING_RADIUS_LIMITS.max, step: 1, unit: 'm', ...(value !== undefined ? { default: value } : {}) });
/** An unload distance left empty keeps the default ring's gap past its load distance. */
const gapRadius = D.ring.unloadRadius - D.ring.loadRadius;
const gapHeight = D.ring.unloadHeight - D.ring.loadHeight;
/** How far past the collision radius a chunk keeps its collider (level 0 reaches at least that far). */
const colliderKeep = COLLISION_RING_HYSTERESIS_CELLS * VOXEL_SIZE_M;

/** The three ring groups, with the defaults shown (a scene's) or without (a quality level's own distances, absent: scaled). */
const rings = (withDefaults: boolean): ReturnType<typeof obj>[] => {
  const d = (v: number): number | undefined => (withDefaults ? v : undefined);
  return [
    obj('ring', 'Load ring', 'Where chunks load round the focus and how far past it they stay (the hysteresis).', [
      metres('loadRadius', 'Load radius', 'Metres across the ground within which chunks load.', d(D.ring.loadRadius)),
      metres('unloadRadius', 'Unload radius', `Metres across the ground past which loaded chunks go (below the load radius: taken as it; empty: the load radius + ${gapRadius} m).`),
      metres('loadHeight', 'Load height', 'Metres above and below within which chunks load.', d(D.ring.loadHeight)),
      metres('unloadHeight', 'Unload height', `Metres above and below past which loaded chunks go (below the load height: taken as it; empty: the load height + ${gapHeight} m).`),
    ]),
    obj('collision', 'Collision ring', 'Where loaded chunks have colliders round a focus (never past the load ring).', [
      metres('radius', 'Radius', 'Metres across the ground.', d(D.collision.radius)),
      metres('height', 'Height', 'Metres above and below.', d(D.collision.height)),
    ]),
    obj('levels', 'Detail levels', 'Where the world is drawn coarser, from full detail near the camera and characters to 2 m voxels far out (level 0 always covers the collision ring).', [
      metres('level0', 'Full detail', `Metres across the ground within which the world is drawn at full detail (0.5 m voxels) with its kit pieces; at least the collision radius + ${colliderKeep} m.`, d(D.levels.level0)),
      metres('level1', 'Level 1', 'Metres across the ground within which 1 m voxels are drawn; past it, 2 m voxels to the load ring (below full detail: taken as it).', d(D.levels.level1)),
    ]),
  ];
};

export const voxelWorld: ComponentDescriptor = {
  name: 'voxelWorld',
  label: 'Voxel world',
  tooltip: "Streams one of the project's voxel worlds (voxels/<world>/) round the camera while this scene is loaded.",
  category: 'Rendering',
  value: obj('voxelWorld', 'Voxel world', 'The world and how it streams (empty settings: the engine defaults).', [
    str('world', 'World', "The world's name: its folder voxels/<world>/ in the project (lower-case letters, digits, - and _).", { ...ID, required: true, default: 'world' }),
    ...rings(true),
    map('quality', 'Per quality level', "The distances at a quality level, by the level's id: a scale of the distances above (absent: the level's voxel ring scale), or distances of its own (each one replaces the scaled one).", 'Level id', obj('*', 'At this level', 'A scale, or distances of its own.', [
      num('scale', 'Scale', 'Every distance above times this at the level.', { min: VOXEL_RING_SCALE_MIN, max: VOXEL_RING_SCALE_MAX, step: 0.05, unit: '×' }),
      ...rings(false),
    ])),
    int('sectionEdge', 'Section edge', 'Voxels along the edge of the sections a chunk is rebuilt in after an edit: smaller rebuilds less per edit, larger draws fewer pieces.', { values: SECTION_EDGES, default: D.sectionEdge }),
    list('savedFields', 'Saved fields', "The fields of the game's changes to the world that a game save keeps; the rest are dropped on quit (wetness, by default, which weather sets again).", enm('field', 'Field', 'A voxel field.', VOXEL_PLANES), { unique: true, default: [...D.savedFields] }),
  ]),
  add: { kind: 'menu', value: { world: 'world' } },
  handles: [],
  excludes: [],
  prefab: false,
  rules: ["The world is the project's folder voxels/<world>/; it streams while the scene holding this object is loaded."],
};
