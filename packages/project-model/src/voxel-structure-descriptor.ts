/**
 * The descriptor of the `voxelStructure` component (beside its format in
 * `voxel-structure.ts`): the Inspector's plain fields of a building's
 * definition. The footprint, openings and stairs are lists the structure
 * mode draws; here they are shown as their values.
 *
 * Pure data.
 */
import { MATERIAL_ID_MAX, ROOF_AXES, ROOF_SHAPES, STRUCTURE_DEFAULTS } from '@thirdlight/voxel';
import { enm, ID, int, json, obj, str } from './descriptor-builders';
import type { ComponentDescriptor } from './descriptor-types';
import { VOXEL_STRUCTURE_GRID_MAX } from './voxel-structure';

const material = (key: string, label: string, part: string): ReturnType<typeof int> => int(key, label, `The voxel material (its id, 1-${MATERIAL_ID_MAX}) of the ${part}; a material's kit draws it.`, { min: 1, max: MATERIAL_ID_MAX, required: true });

export const voxelStructure: ComponentDescriptor = {
  name: 'voxelStructure',
  label: 'Voxel structure',
  tooltip: "A building that writes its own grid of a voxel world: change a field and the backend writes its voxels again (one undo with the change), keeping your hand edits where they still fit. Move and turn it as any object; it never tilts.",
  category: 'Rendering',
  value: obj('voxelStructure', 'Voxel structure', "The building's definition (numbers in its grid's 0.5 m cells) and the world grid it owns.", [
    str('world', 'World', 'The voxel world it is built in (a voxelWorld object of this scene names it).', { ...ID, required: true, readOnly: true }),
    int('grid', 'Grid', "Its own grid of the world (given by the backend when the structure is made; its files are voxels/<world>/grid-<id>/).", { min: 1, max: VOXEL_STRUCTURE_GRID_MAX, required: true, readOnly: true }),
    json('footprint', 'Footprint', 'Polygons [{id, points: [[x, z], …]}] with right-angled corners in cells; a second polygon makes an L, a T or a wing.', { required: true, shape: 'FootprintPolygon[]' }),
    int('storeys', 'Storeys', 'Floors stacked on the ground floor.', { min: 1, required: true, default: 1 }),
    int('storeyHeight', 'Storey height', 'Cells a storey, its floor slab included (6 = 3 m: a 2.5 m room under a floor).', { min: 2, required: true, default: STRUCTURE_DEFAULTS.storeyHeight }),
    int('foundationDepth', 'Foundation depth', 'Cells of foundation below the ground floor (the building leaves the ground alone: dig or fill the site).', { min: 0, required: true, default: STRUCTURE_DEFAULTS.foundationDepth }),
    obj('roof', 'Roof', 'Its shape, the cells it reaches past the walls and a gable\'s ridge direction.', [
      enm('shape', 'Shape', 'Flat, gable (ridge along the axis) or hip (sloping on every side).', ROOF_SHAPES, { required: true, default: 'gable' }),
      int('overhang', 'Overhang', 'Cells past the walls on every side.', { min: 0, required: true, default: STRUCTURE_DEFAULTS.overhang }),
      enm('axis', 'Ridge axis', "The direction a gable's ridge runs (kept for every shape).", ROOF_AXES, { required: true, default: 'x' }),
    ], { required: true }),
    obj('materials', 'Materials', 'One voxel material a part (a swap rewrites material ids only; painted cells keep their paint).', [
      material('wall', 'Walls', 'walls and openings'),
      material('floor', 'Floors', 'upper floors'),
      material('roof', 'Roof', 'roof'),
      material('foundation', 'Foundation', 'foundation and ground floor slab'),
      material('stair', 'Stairs', 'stairs'),
    ], { required: true }),
    json('openings', 'Openings', 'Doors and windows [{id, polygon, edge, storey, at, width, height, sill, prop?}] on an outside wall, in cells.', { required: true, shape: 'StructureOpening[]' }),
    json('stairs', 'Stairs', 'Flights [{id, polygon, from, at: [x, z], facing}] from a storey to the next, two cells wide.', { required: true, shape: 'StructureStair[]' }),
    int('generator', 'Generator', 'The building generator version that last wrote its voxels; a newer engine regenerates every structure in one undoable step (Regenerate structures).', { min: 1, required: true, readOnly: true }),
  ]),
  add: { kind: 'never', reason: 'a structure is made with its definition (createEntity or setComponent with the building, or the structure mode); the backend gives it its grid and writes its voxels' },
  handles: [],
  excludes: [],
  prefab: false,
  rules: [
    "A root object (or in a folder) in the scene holding its world's voxelWorld object; its transform is its grid's place: a position and a turn about the vertical axis only, at unit scale.",
    'Its voxels are written by the backend from the definition; hand edits on its grid are kept as overrides; exports ship the voxels, never the definition.',
  ],
};
