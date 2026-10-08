/**
 * The generated-architecture graph kinds (graph-kind data): styles and
 * presets, both standalone graphs (`content.graphs`), so the editor's graph
 * editor, its Create menu, rename, delete and undo serve them as they serve
 * material functions.
 *
 * - An **architecture style** is a graph of the generator's operators: the
 *   outline it is drawn on, paths made from it (offset, raise, chamfer, a
 *   square for a piece), parametric profiles (a wall, a band, a cove, a
 *   shaft, a frame), the elements (sweep, repeat, fill) and one Output.
 *   Every number field also has an input port with the field's key: a wired
 *   input replaces the field. Parameter nodes are the style's exposed
 *   sliders (name, default, range).
 * - An **architecture preset** is a style plus values: one Preset node
 *   (its style, the preset it derives from, the trim sheet it wears), Value
 *   nodes overriding a parameter, and Mask nodes driving a parameter by a
 *   world mask (noise, height, or a mask painted on the object). Presets
 *   have no wires: their nodes are a list the Inspector's sliders edit.
 *
 * `arch-style.ts` evaluates them.
 */
import type { GraphFieldDef, GraphKindDef, GraphNodeDef, GraphPortDef } from './graph';
import { ARCHITECTURE_FILL_SHAPES, ARCHITECTURE_LIMITS } from './architecture';

export const ARCHITECTURE_STYLE_KIND = 'architecture-style';
export const ARCHITECTURE_PRESET_KIND = 'architecture-preset';

/** Engine limits of one style or preset graph (not tuning values): a rich style uses a few dozen nodes. */
export const ARCHITECTURE_GRAPH_NODES = 512;

const L = ARCHITECTURE_LIMITS;
/** A field naming an id (or "" for none). */
const ID_OR_EMPTY = '|[a-z0-9][a-z0-9_-]{0,63}';
const ID_PATTERN = '[a-z0-9][a-z0-9_-]{0,63}';

const num = (key: string, label: string, def: number, min: number, max: number): GraphFieldDef => ({ key, label, type: 'number', default: def, min, max });
const port = (id: string, label: string, type: string, extra: Partial<GraphPortDef> = {}): GraphPortDef => ({ id, label, type, ...extra });
/** A number field with an input port of the same key (a wire replaces the field). */
const wired = (fields: GraphFieldDef[]): { inputs: GraphPortDef[]; fields: GraphFieldDef[] } => ({ inputs: fields.map((f) => port(f.key, f.label, 'number')), fields });
const slot = (key: string, label: string, def: string): GraphFieldDef => ({ key, label, type: 'string', default: def, maxLength: 64, pattern: ID_OR_EMPTY });
const ELEMENT_FIELDS: GraphFieldDef[] = [
  { key: 'detail', label: 'Detail', type: 'boolean', default: false },
  { key: 'collide', label: 'Collide', type: 'enum', options: ['auto', 'yes', 'no'], default: 'auto' },
  slot('material', 'Material slot', ''),
];

function profileNode(type: string, label: string, description: string, numbers: GraphFieldDef[], slots: GraphFieldDef[]): GraphNodeDef {
  const w = wired(numbers);
  return { type, label, category: 'Profiles', description, inputs: w.inputs, outputs: [port('profile', 'profile', 'profile')], fields: [...w.fields, ...slots] };
}

const STYLE_NODES: GraphNodeDef[] = [
  { type: 'outline', label: 'Outline', category: 'Inputs', description: 'The outline the style is drawn on (a room\'s or a run\'s path).', inputs: [], outputs: [port('path', 'path', 'path')] },
  {
    type: 'parameter',
    label: 'Parameter',
    category: 'Inputs',
    description: 'An exposed slider: presets set its value, masks vary it across the level.',
    inputs: [],
    outputs: [port('value', 'value', 'number')],
    fields: [
      { key: 'name', label: 'Name', type: 'string', default: 'value', maxLength: 64, pattern: ID_PATTERN },
      num('default', 'Default', 1, -L.coordinate, L.coordinate),
      num('min', 'Min', 0, -L.coordinate, L.coordinate),
      num('max', 'Max', 10, -L.coordinate, L.coordinate),
    ],
    titleField: 'name',
  },
  { type: 'constant', label: 'Constant', category: 'Inputs', inputs: [], outputs: [port('value', 'value', 'number')], fields: [num('value', 'Value', 0, -L.coordinate, L.coordinate)] },
  { type: 'add', label: 'Add', category: 'Math', ...wired([num('a', 'a', 0, -L.coordinate, L.coordinate), num('b', 'b', 0, -L.coordinate, L.coordinate)]), outputs: [port('value', 'value', 'number')] },
  { type: 'multiply', label: 'Multiply', category: 'Math', ...wired([num('a', 'a', 1, -L.coordinate, L.coordinate), num('b', 'b', 1, -L.coordinate, L.coordinate)]), outputs: [port('value', 'value', 'number')] },
  { type: 'mix', label: 'Mix', category: 'Math', description: 'a to b by t.', ...wired([num('a', 'a', 0, -L.coordinate, L.coordinate), num('b', 'b', 1, -L.coordinate, L.coordinate), num('t', 't', 0.5, 0, 1)]), outputs: [port('value', 'value', 'number')] },
  ...(['offset', 'raise', 'chamfer'] as const).map((type): GraphNodeDef => {
    const f = type === 'offset' ? num('distance', 'Distance', 0, -L.distanceMax, L.distanceMax) : type === 'raise' ? num('height', 'Height', 0, -L.distanceMax, L.distanceMax) : num('size', 'Size', 0, 0, L.distanceMax);
    const description = type === 'offset' ? 'Moves the path to the right of travel (inside a room drawn clockwise), corners mitred.' : type === 'raise' ? 'Lifts the path (a ceiling, a vault\'s springing).' : 'Cuts each sharp corner of the path.';
    return { type, label: type[0]!.toUpperCase() + type.slice(1), category: 'Paths', description, inputs: [port('path', 'path', 'path', { required: true }), port(f.key, f.label, 'number')], outputs: [port('path', 'path', 'path')], fields: [f] };
  }),
  { type: 'square', label: 'Square', category: 'Paths', description: 'A closed square round a repeated piece\'s middle (its own frame), inside on the right.', ...wired([num('size', 'Size', 0.3, L.stepMin, L.distanceMax)]), outputs: [port('path', 'path', 'path')] },
  profileNode('wall', 'Wall profile', 'A wall centred on its path: the inside face (right of travel), its top, the outside face; below the dado both faces wear the lower slot.', [num('thickness', 'Thickness', 0.2, 0.01, 10), num('height', 'Height', 3, 0.05, L.distanceMax), num('dado', 'Dado', 0, 0, L.distanceMax), num('chamfer', 'Chamfer', 0, 0, 1)], [slot('inside', 'Inside', 'upper_wall'), slot('outside', 'Outside', 'upper_wall'), slot('lower', 'Lower', 'lower_wall'), slot('top', 'Top', 'bevel')]),
  profileNode('band', 'Band profile', 'A flat band standing out of a face right of travel: a baseboard, a dado rail, a string course (0 depth or height: none).', [num('height', 'Height', 0.15, 0, L.distanceMax), num('depth', 'Depth', 0.03, 0, 10), num('base', 'Base', 0, -L.distanceMax, L.distanceMax)], [slot('slot', 'Slot', 'baseboard')]),
  profileNode('cove', 'Cove profile', 'A cove moulding under a ceiling on a face right of travel (0 depth or size: none).', [num('size', 'Size', 0.4, 0, 10), num('depth', 'Depth', 0.1, 0, 10), num('top', 'Top', 3, -L.distanceMax, L.distanceMax)], [slot('slot', 'Slot', 'crown')]),
  profileNode('shaft', 'Shaft profile', 'A column\'s face, swept round a square.', [num('height', 'Height', 2.5, 0.05, L.distanceMax)], [slot('slot', 'Slot', 'column')]),
  profileNode('frame', 'Frame profile', 'A flat frame round an opening.', [num('width', 'Width', 0.12, 0.01, 10), num('depth', 'Depth', 0.04, 0.001, 10)], [slot('slot', 'Slot', 'frame')]),
  {
    type: 'sweep',
    label: 'Sweep',
    category: 'Elements',
    description: 'A profile swept along a path, mitred at corners; with Openings on it cuts the outline\'s doors and windows (framed with the frame profile).',
    inputs: [port('path', 'path', 'path', { required: true }), port('profile', 'profile', 'profile', { required: true }), port('frame', 'frame', 'profile')],
    outputs: [port('element', 'element', 'element')],
    fields: [{ key: 'openings', label: 'Openings', type: 'boolean', default: false }, ...ELEMENT_FIELDS],
  },
  (() => {
    const w = wired([num('spacing', 'Spacing', 2, L.stepMin, L.distanceMax), num('start', 'Start', 0, 0, L.coordinate), num('jitterYaw', 'Jitter turn', 0, 0, 180), num('jitterAlong', 'Jitter along', 0, 0, L.distanceMax)]);
    return {
      type: 'repeat',
      label: 'Repeat',
      category: 'Elements',
      description: 'Pieces (sweeps and fills in the copy\'s own frame) stamped along a path.',
      inputs: [port('path', 'path', 'path', { required: true }), port('piece', 'piece', 'element', { multi: true, required: true }), ...w.inputs],
      outputs: [port('element', 'element', 'element')],
      fields: [...w.fields, { key: 'corners', label: 'At corners', type: 'boolean', default: false }, { key: 'align', label: 'Face along', type: 'boolean', default: true }, ...ELEMENT_FIELDS],
    } satisfies GraphNodeDef;
  })(),
  (() => {
    const w = wired([num('height', 'Height', 0, -L.distanceMax, L.distanceMax), num('rise', 'Rise', 0, 0, L.distanceMax), num('cell', 'Cell', 1.5, L.cellMin * 2, L.distanceMax), num('depth', 'Depth', 0.2, 0, L.distanceMax), num('overhang', 'Overhang', 0, 0, L.distanceMax)]);
    return {
      type: 'fill',
      label: 'Fill',
      category: 'Elements',
      description: 'A closed path filled: a floor or ceiling, coffers, a vault or a roof (rise 0: the shape\'s own).',
      inputs: [port('path', 'path', 'path', { required: true }), ...w.inputs],
      outputs: [port('element', 'element', 'element')],
      fields: [
        ...w.fields,
        { key: 'shape', label: 'Shape', type: 'enum', options: ARCHITECTURE_FILL_SHAPES, default: 'flat' },
        slot('slot', 'Slot', 'floor'),
        slot('trimSlot', 'Trim slot', ''),
        { key: 'face', label: 'Faces', type: 'enum', options: ['auto', 'up', 'down'], default: 'auto' },
        { key: 'axis', label: 'Axis', type: 'enum', options: ['long', 'short'], default: 'long' },
        ...ELEMENT_FIELDS,
      ],
    } satisfies GraphNodeDef;
  })(),
  { type: 'output', label: 'Output', category: 'Output', description: 'What the style makes.', inputs: [port('elements', 'elements', 'element', { multi: true, required: true })], outputs: [], max: 1, required: true },
];

export const ARCHITECTURE_STYLE_GRAPH_KIND: GraphKindDef = {
  kind: ARCHITECTURE_STYLE_KIND,
  label: 'Architecture style',
  portTypes: [
    { id: 'number', label: 'number', color: '#7fb3ff' },
    { id: 'path', label: 'path', color: '#ffc46b' },
    { id: 'profile', label: 'profile', color: '#c39bff' },
    { id: 'element', label: 'element', color: '#7fd18b' },
  ],
  conversions: [],
  categories: ['Inputs', 'Math', 'Paths', 'Profiles', 'Elements', 'Output'],
  nodes: STYLE_NODES,
  allowCycles: false,
  maxNodes: ARCHITECTURE_GRAPH_NODES,
  sinks: ['output'],
};

/** The mask sources a preset's Mask node reads. */
export const ARCHITECTURE_MASK_SOURCES = ['noise', 'height', 'painted'] as const;

export const ARCHITECTURE_PRESET_GRAPH_KIND: GraphKindDef = {
  kind: ARCHITECTURE_PRESET_KIND,
  label: 'Architecture preset',
  portTypes: [{ id: 'number', label: 'number', color: '#7fb3ff' }],
  conversions: [],
  categories: ['Preset', 'Values'],
  nodes: [
    {
      type: 'preset',
      label: 'Preset',
      category: 'Preset',
      description: 'The style it sets values for (empty: its base\'s), the preset it derives from, and the trim sheet material it wears (empty: its base\'s, else the object\'s).',
      inputs: [],
      outputs: [],
      fields: [
        { key: 'style', label: 'Style', type: 'string', default: '', maxLength: 64, pattern: ID_OR_EMPTY },
        { key: 'base', label: 'Derives from', type: 'string', default: '', maxLength: 64, pattern: ID_OR_EMPTY },
        { key: 'sheet', label: 'Trim sheet', type: 'string', default: '', maxLength: 64, pattern: ID_OR_EMPTY },
      ],
      max: 1,
      required: true,
    },
    { type: 'value', label: 'Value', category: 'Values', description: 'A parameter\'s value (over its base\'s and the style\'s default).', inputs: [], outputs: [], fields: [{ key: 'parameter', label: 'Parameter', type: 'string', default: 'value', maxLength: 64, pattern: ID_PATTERN }, num('value', 'Value', 0, -L.coordinate, L.coordinate)], titleField: 'parameter' },
    {
      type: 'mask',
      label: 'Mask',
      category: 'Values',
      description: 'Drives a parameter by a world mask read at each outline\'s middle: from its value where the mask is 0 to `to` where it is 1. The mask is world noise, the outline\'s height, or a mask painted on the object; it is 0 at `low` and 1 at `high`.',
      inputs: [],
      outputs: [],
      fields: [
        { key: 'parameter', label: 'Parameter', type: 'string', default: 'value', maxLength: 64, pattern: ID_PATTERN },
        num('to', 'To', 1, -L.coordinate, L.coordinate),
        { key: 'source', label: 'Source', type: 'enum', options: ARCHITECTURE_MASK_SOURCES, default: 'noise' },
        { key: 'mask', label: 'Painted mask', type: 'string', default: '', maxLength: 64, pattern: ID_OR_EMPTY },
        num('scale', 'Noise scale', 20, 0.01, L.coordinate),
        num('seed', 'Noise seed', 0, 0, 0xffffffff),
        num('low', 'Low', 0, -L.coordinate, L.coordinate),
        num('high', 'High', 1, -L.coordinate, L.coordinate),
      ],
      titleField: 'parameter',
    },
  ],
  allowCycles: false,
  maxNodes: ARCHITECTURE_GRAPH_NODES,
};
