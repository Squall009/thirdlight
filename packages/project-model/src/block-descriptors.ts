/**
 * The descriptors of the block-layer components (`blockLayer`,
 * `blockFootprint`), kept apart from the registry's main table so the block
 * system's fields grow in one place. The registry (`descriptors.ts`) lists
 * them with every other component.
 *
 * Pure data.
 */
import { BLOCK_MAX_SLOPE_RANGE } from './block-layers';
import type { BoolFieldDescriptor, ComponentDescriptor, EntityRefFieldDescriptor, FieldDescriptor, JsonFieldDescriptor, NumberFieldDescriptor, ObjectFieldDescriptor, VecFieldDescriptor } from './descriptors';

type Opts<T extends FieldDescriptor> = Omit<T, 'type' | 'key' | 'label' | 'tooltip'>;
const num = (key: string, label: string, tooltip: string, o: Opts<NumberFieldDescriptor> = {}): NumberFieldDescriptor => ({ type: 'number', key, label, tooltip, ...o });
const bool = (key: string, label: string, tooltip: string, o: Opts<BoolFieldDescriptor> = {}): BoolFieldDescriptor => ({ type: 'bool', key, label, tooltip, ...o });
const vec2 = (key: string, label: string, tooltip: string, o: Omit<Opts<VecFieldDescriptor>, 'labels'> & { labels?: readonly string[] } = {}): VecFieldDescriptor => ({ type: 'vec2', key, label, tooltip, labels: ['x', 'y'], ...o });
const vec3 = (key: string, label: string, tooltip: string, o: Omit<Opts<VecFieldDescriptor>, 'labels'> & { labels?: readonly string[] } = {}): VecFieldDescriptor => ({ type: 'vec3', key, label, tooltip, labels: ['x', 'y', 'z'], ...o });
const entity = (key: string, label: string, tooltip: string, o: Opts<EntityRefFieldDescriptor> = {}): EntityRefFieldDescriptor => ({ type: 'entityRef', key, label, tooltip, ...o });
const json = (key: string, label: string, tooltip: string, o: Opts<JsonFieldDescriptor> = {}): JsonFieldDescriptor => ({ type: 'json', key, label, tooltip, ...o });
const obj = (key: string, label: string, tooltip: string, fields: readonly FieldDescriptor[]): ObjectFieldDescriptor => ({ type: 'object', key, label, tooltip, fields });

/** A grid of blocks (its cells are scene data written by editBlocks). */
export const blockLayer: ComponentDescriptor = {
  name: 'blockLayer',
  label: 'Block layer',
  tooltip: 'A grid of blocks for building levels (terrain, buildings, a tactics map); its cells are painted and edited with block commands.',
  category: 'Rendering',
  value: obj('blockLayer', 'Block layer', "The grid: cell size and bounds. The object's position is the min corner of cell [0, 0, 0].", [
    vec3('cellSize', 'Cell size', 'Metres per cell along x, y and z (a half-metre step: [1, 0.5, 1]).', { required: true, min: 0.05, max: 64, step: 0.05, unit: 'm', default: [1, 1, 1], labels: ['x', 'y', 'z'] }),
    json('bounds', 'Bounds', 'The cells the layer may hold: {min: [x, y, z], max: [x, y, z]} (max exclusive; at most 1024 × 256 × 1024 cells, within ±4096 / ±1024).', { required: true }),
    bool('metadataOnly', 'Metadata only', 'Cells carry data only (deploy zones, no-walk areas, trigger ids): no blocks, nothing drawn.', { default: false }),
    bool('collision', 'Collision', "The blocks' collision shapes are colliders (3D projects).", { default: true }),
    bool('castShadow', 'Cast shadows', "The blocks cast the directional light's shadow.", { default: true }),
    bool('receiveShadow', 'Receive shadows', 'Shadows fall on the blocks.', { default: true }),
    num('maxSlope', 'Max slope', "The steepest part of the layer's surface that counts as ground: characters do not walk up steeper slopes whatever their own limit, and surface queries call steeper ground not walkable (absent: each character's own limit; queries use the project's max_slope_climb_deg).", {
      min: BLOCK_MAX_SLOPE_RANGE.min,
      max: BLOCK_MAX_SLOPE_RANGE.max,
      step: 1,
      unit: 'deg',
    }),
  ]),
  // 1 m cells over 64 × 16 × 64 — a common kit module over the interactive-editing target; no genre assumed.
  add: { kind: 'menu', value: { cellSize: [1, 1, 1], bounds: { min: [0, 0, 0], max: [64, 16, 64] } } },
  handles: [],
  excludes: ['model', 'box', 'camera', 'collider', 'controller', 'instances'].map((c) => ({ component: c, reason: 'a block layer is its own level geometry' })),
  prefab: false,
  rules: ['A block layer is a root object (a folder may hold it) at identity rotation and unit scale; at most 16 layers with cells per scene.'],
};

/** A prop's occupancy footprint (the editor writes it into the block cells beneath the prop). */
export const blockFootprint: ComponentDescriptor = {
  name: 'blockFootprint',
  label: 'Block footprint',
  tooltip: 'The cell metadata this object writes into the block-layer cells beneath it when it is placed or moved (a house marks its cells blocked).',
  category: 'Gameplay',
  value: obj('blockFootprint', 'Block footprint', 'Which cells (a rectangle centred on the object, turned with it) take which metadata.', [
    entity('layer', 'Layer', 'The block layer written (none: every layer under the object).', { component: 'blockLayer' }),
    vec2('size', 'Size', 'Cells along x and z, centred on the object and turned with its quarter turns.', { min: 1, max: 64, step: 1, default: [1, 1], labels: ['x', 'z'] }),
    json('set', 'Metadata', "The metadata the cells take: field key → value (fields of the project's cell schema).", { required: true }),
  ]),
  // Starts empty (writes nothing) until its metadata is chosen.
  add: { kind: 'menu', value: { set: {} } },
  handles: [],
  excludes: [],
  prefab: true,
  rules: ['The cells are written when the object is placed or moved in the editor (one metadata edit of the layer); moving it clears the fields it wrote where it stood.'],
};
