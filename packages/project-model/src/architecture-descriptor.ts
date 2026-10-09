/**
 * The descriptor of the `architecture` component (its own file, beside its
 * format). Elements, profiles and overrides are JSON fields: their shape is
 * a small language of operators (validated by `validateArchitectureComponent`).
 * Outlines styled by presets have their own Inspector panel (the presets'
 * sliders) beside the JSON.
 *
 * Pure data.
 */
import { bool, int, json, num, obj, str } from './descriptor-builders';
import type { ComponentDescriptor } from './descriptor-types';
import { ARCHITECTURE_AO_DEFAULTS, ARCHITECTURE_CHUNK_DEFAULT, ARCHITECTURE_LIMITS, ARCHITECTURE_LOD_DISTANCE_DEFAULT } from './architecture';

const L = ARCHITECTURE_LIMITS;

// A new component: one 6 m wall, 3 m tall and 0.2 m thick, on the starter layout's rows.
const NEW_VALUE = {
  profiles: { wall: { points: [[0.1, 0], [0.1, 3], [-0.1, 3], [-0.1, 0]], slots: ['lower_wall', 'bevel', 'upper_wall'] } },
  elements: [{ id: 'wall', kind: 'sweep', path: { points: [[0, 0, 0], [6, 0, 0]] }, profile: 'wall' }],
};

export const architecture: ComponentDescriptor = {
  name: 'architecture',
  label: 'Architecture',
  tooltip: 'Walls, mouldings, floors, vaults, roofs and repeated pieces generated at load from parameters: profiles swept along paths, things repeated along paths, and fills, on one trim sheet (Materials slot "architecture").',
  category: 'Rendering',
  value: obj('architecture', 'Architecture', "Generated from these parameters at load; points are offsets from the object's position (its rotation and scale are not applied).", [
    json('elements', 'Elements', 'Sweeps {id, kind: "sweep", path, profile, openings?}, repeats {id, kind: "repeat", path, spacing, piece} and fills {id, kind: "fill", path, shape, slot}.', { required: true, shape: 'ArchitectureElement[]' }),
    json('profiles', 'Profiles', 'Named cross-sections {points: [[across, up], …], slots: [row per segment], closed?, smooth?, chamfer?}.', { shape: 'Record<string, ArchitectureProfile>' }),
    json('overrides', 'Overrides', 'Kit models in place of a segment or a corner: [{element, segment | corner, model: {assetId}}].', { shape: 'ArchitectureOverride[]' }),
    json('outlines', 'Outlines', 'Rooms (closed) and runs (open) styled by presets: [{id, path, preset, openings?, outside?, storeys?, storeyHeight?, holes?, stairs?}] (the preset\'s style graph makes their elements; a block layer\'s Rooms tool draws them).', { shape: 'ArchitectureOutline[]' }),
    json('buildings', 'Buildings', 'Rooms with a roof: [{id, path, preset, outside?, storeys?, openings?, roof?: {shape, rise?, overhang?, slot?}, interior?: {scene, offset?}}] (the Rooms tool draws them).', { shape: 'ArchitectureBuilding[]' }),
    json('masks', 'Masks', 'Painted masks presets read: {name: {points: [[x, z, radius, weight], …]}}.', { shape: 'Record<string, ArchitectureMask>' }),
    num('chunkSize', 'Chunk size', 'Metres a generated chunk covers (one draw per material each).', { min: L.chunkMin, max: L.chunkMax, step: 1, unit: 'm', default: ARCHITECTURE_CHUNK_DEFAULT }),
    int('seed', 'Seed', 'Seeds the variation of repeated copies.', { min: 0, max: 0xffffffff, default: 0 }),
    obj('ao', 'Baked AO', 'Vertex ambient occlusion in inside corners and where walls meet the ground.', [
      num('strength', 'Strength', 'How dark a right-angled inside corner gets (0: none).', { min: 0, max: 1, step: 0.05, default: ARCHITECTURE_AO_DEFAULTS.strength }),
      num('radius', 'Radius', 'Metres the darkening reaches.', { min: 0.01, max: 10, step: 0.05, unit: 'm', default: ARCHITECTURE_AO_DEFAULTS.radius }),
    ]),
    num('lodDistance', 'Far level from', 'Metres from the camera where detail (mouldings, frames, chamfers) is left out.', { min: 0, max: 100_000, step: 1, unit: 'm', default: ARCHITECTURE_LOD_DISTANCE_DEFAULT }),
    bool('castShadow', 'Casts shadows', 'Blocks the directional light.', { default: true }),
    bool('receiveShadow', 'Receives shadows', 'Shows the shadows falling on it.', { default: true }),
    str('layer', 'Block layer', 'The block layer object the rooms are drawn on: their walls block its grid walks, rooms are its regions, its wall paint shows on them.', { maxLength: 128 }),
    str('baked', 'Shipped meshes', 'SHA-256 of the generated meshes an export shipped (written by the export).', { format: 'sha256', minLength: 64, maxLength: 64, readOnly: true }),
  ]),
  add: { kind: 'menu', value: NEW_VALUE },
  handles: [],
  excludes: ['blockLayer', 'terrain', 'spline'].map((c) => ({ component: c, reason: 'generated architecture is its own object beside the level geometry' })),
  prefab: false,
};
