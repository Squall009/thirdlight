/**
 * The descriptor of the `waterBody` component (beside its format in
 * `water-body.ts`): the level (dragged by its handle over the object in the
 * Scene view), the liquid material and the reach. The Inspector shows the
 * editor's own section for it (a picker of the project's liquid materials,
 * the body's state and a breach's warning) in place of these plain fields.
 *
 * Pure data.
 */
import { MATERIAL_ID_MAX } from '@thirdlight/voxel';
import { ID, int, num, obj, str } from './descriptor-builders';
import type { ComponentDescriptor } from './descriptor-types';
import { WATER_BODY_REACH_DEFAULT_M } from './water-body';

export const waterBody: ComponentDescriptor = {
  name: 'waterBody',
  label: 'Water body',
  tooltip: "A lake or pond whose water the editor writes as liquid voxels: from the object (the seed, inside the basin) through the open cells under the level, bounded by the ground and the reach. Dig or build inside its reach and the shore follows in the same undo step; a leak is flagged, never spilled.",
  category: 'Rendering',
  value: obj('waterBody', 'Water body', 'Its level, its liquid and how far it may spread; the seed is the object’s position.', [
    str('world', 'World', 'The voxel world it fills (a voxelWorld object of this scene names it).', { ...ID, required: true, readOnly: true }),
    num('level', 'Level', 'The water surface’s height in the scene (metres); the cells under it fill, the top ones partly.', { unit: 'm', step: 0.5, required: true, handle: 'height' }),
    int('material', 'Liquid', `The liquid's voxel material (its id, 1-${MATERIAL_ID_MAX}).`, { min: 1, max: MATERIAL_ID_MAX, required: true }),
    num('reach', 'Reach', 'How far from the seed the water may spread (metres, across the ground). Water that would pass it is a leak: flagged, nothing written.', { unit: 'm', min: 0, minExclusive: true, step: 1, default: WATER_BODY_REACH_DEFAULT_M }),
  ]),
  add: { kind: 'tool', tool: 'Add component → Water body in the Inspector (the scene’s voxel world, the object’s height as the level, the project’s first liquid material), or createEntity / setComponent with the whole value' },
  handles: [{ kind: 'height', label: 'Level', bind: { height: 'level' }, space: 'local', scene: true }],
  excludes: [],
  prefab: false,
  rules: [
    'A root object in the scene holding its world’s voxelWorld object; its position is the seed, a point inside the basin.',
    'The backend writes its liquid voxels when it is made, changed, moved or deleted, and again after a ground edit or a structure written inside its reach (ground, then buildings, then water); exports ship the voxels, never the definition.',
  ],
};
