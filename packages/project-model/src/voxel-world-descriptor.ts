/**
 * The descriptor of the `voxelWorld` component (its own file, beside the
 * format in `voxel-world.ts`). The registry (`descriptors.ts`) lists it with
 * every other component. Its defaults are the voxel format's, in metres.
 *
 * Pure data.
 */
import { SECTION_EDGES, VOXEL_PLANES } from '@thirdlight/voxel';
import { enm, ID, int, list, num, obj, str } from './descriptor-builders';
import type { ComponentDescriptor } from './descriptor-types';
import { STREAMING_RADIUS_LIMITS } from './world-streaming';
import { VOXEL_WORLD_DEFAULTS } from './voxel-world';

const D = VOXEL_WORLD_DEFAULTS;
const metres = (key: string, label: string, tooltip: string, value?: number): ReturnType<typeof num> =>
  num(key, label, tooltip, { min: STREAMING_RADIUS_LIMITS.min, max: STREAMING_RADIUS_LIMITS.max, step: 1, unit: 'm', ...(value !== undefined ? { default: value } : {}) });
/** An unload distance left empty keeps the default ring's gap past its load distance. */
const gapRadius = D.ring.unloadRadius - D.ring.loadRadius;
const gapHeight = D.ring.unloadHeight - D.ring.loadHeight;

export const voxelWorld: ComponentDescriptor = {
  name: 'voxelWorld',
  label: 'Voxel world',
  tooltip: "Streams one of the project's voxel worlds (voxels/<world>/) round the camera while this scene is loaded.",
  category: 'Rendering',
  value: obj('voxelWorld', 'Voxel world', 'The world and how it streams (empty settings: the engine defaults).', [
    str('world', 'World', "The world's name: its folder voxels/<world>/ in the project (lower-case letters, digits, - and _).", { ...ID, required: true, default: 'world' }),
    obj('ring', 'Load ring', 'Where chunks load round the focus and how far past it they stay (the hysteresis).', [
      metres('loadRadius', 'Load radius', 'Metres across the ground within which chunks load.', D.ring.loadRadius),
      metres('unloadRadius', 'Unload radius', `Metres across the ground past which loaded chunks go (below the load radius: taken as it; empty: the load radius + ${gapRadius} m).`),
      metres('loadHeight', 'Load height', 'Metres above and below within which chunks load.', D.ring.loadHeight),
      metres('unloadHeight', 'Unload height', `Metres above and below past which loaded chunks go (below the load height: taken as it; empty: the load height + ${gapHeight} m).`),
    ]),
    obj('collision', 'Collision ring', 'Where loaded chunks have colliders round a focus (never past the load ring).', [
      metres('radius', 'Radius', 'Metres across the ground.', D.collision.radius),
      metres('height', 'Height', 'Metres above and below.', D.collision.height),
    ]),
    int('sectionEdge', 'Section edge', 'Voxels along the edge of the sections a chunk is rebuilt in after an edit: smaller rebuilds less per edit, larger draws fewer pieces.', { values: SECTION_EDGES, default: D.sectionEdge }),
    list('savedFields', 'Saved fields', "The fields of the game's changes to the world that a game save keeps; the rest are dropped on quit (wetness, by default, which weather sets again).", enm('field', 'Field', 'A voxel field.', VOXEL_PLANES), { unique: true, default: [...D.savedFields] }),
  ]),
  add: { kind: 'menu', value: { world: 'world' } },
  handles: [],
  excludes: [],
  prefab: false,
  rules: ["The world is the project's folder voxels/<world>/; it streams while the scene holding this object is loaded."],
};
