/**
 * Phase 16.1: the registered graph kinds (data).
 *
 * A graph kind is its node catalogue, port types, conversions and rules
 * (see graph.ts). Later phases register theirs here: the animator state graph
 * (16.2), material graphs (18), visual scripts (19) and effect graphs (20).
 *
 * `test` is the framework's own neutral kind: a small numeric data-flow graph
 * (constants, maths, a vector, a select, one output) that exercises every
 * framework rule — three port types with two implicit conversions and a
 * wildcard, a multi input, required inputs, a required single sink, no
 * cycles and node data fields of every field type. It has no runtime
 * meaning; it exists so the framework and its editor are tested end to end
 * without depending on any later graph kind.
 */
import type { GraphKindDef } from './graph';
import { BEHAVIOR_GRAPH_KIND } from './behavior-graph';
import { MATERIAL_FUNCTION_GRAPH_KIND, MATERIAL_GRAPH_KIND } from './material-graph-kinds';
import { BEHAVIOR_FUNCTION_GRAPH_KIND, BEHAVIOR_LIBRARY_GRAPH_KIND } from './behavior-graph-nodes';
import { EFFECT_GRAPH_KIND } from './effect-graph-kinds';

export const TEST_GRAPH_KIND: GraphKindDef = {
  kind: 'test',
  label: 'Test graph',
  portTypes: [
    { id: 'number', label: 'number', color: '#7fb3ff' },
    { id: 'vector', label: 'vector', color: '#ffc46b' },
    { id: 'boolean', label: 'boolean', color: '#e67e9b' },
    { id: 'any', label: 'any', color: '#b0b0b0' },
  ],
  conversions: [
    { from: 'number', to: 'vector', label: 'number → vector (all components)' },
    { from: 'boolean', to: 'number', label: 'boolean → number (0 or 1)' },
  ],
  anyType: 'any',
  categories: ['Inputs', 'Math', 'Logic', 'Output'],
  nodes: [
    { type: 'constant', label: 'Constant', category: 'Inputs', description: 'A fixed number.', inputs: [], outputs: [{ id: 'value', label: 'value', type: 'number' }], fields: [{ key: 'value', label: 'Value', type: 'number', default: 0, min: -1e6, max: 1e6 }] },
    { type: 'toggle', label: 'Toggle', category: 'Inputs', description: 'A fixed true/false.', inputs: [], outputs: [{ id: 'value', label: 'value', type: 'boolean' }], fields: [{ key: 'on', label: 'On', type: 'boolean', default: false }] },
    { type: 'vector', label: 'Vector', category: 'Inputs', description: 'Three numbers as a vector.', inputs: [{ id: 'x', label: 'x', type: 'number' }, { id: 'y', label: 'y', type: 'number' }, { id: 'z', label: 'z', type: 'number' }], outputs: [{ id: 'vector', label: 'vector', type: 'vector' }], fields: [{ key: 'fallback', label: 'Unconnected', type: 'vector', size: 3, default: [0, 0, 0] }] },
    { type: 'add', label: 'Add', category: 'Math', inputs: [{ id: 'a', label: 'a', type: 'number', required: true }, { id: 'b', label: 'b', type: 'number', required: true }], outputs: [{ id: 'sum', label: 'sum', type: 'number' }] },
    { type: 'multiply', label: 'Multiply', category: 'Math', inputs: [{ id: 'a', label: 'a', type: 'number', required: true }, { id: 'b', label: 'b', type: 'number', required: true }], outputs: [{ id: 'product', label: 'product', type: 'number' }] },
    { type: 'sum', label: 'Sum all', category: 'Math', description: 'Adds every connected number.', inputs: [{ id: 'values', label: 'values', type: 'number', multi: true }], outputs: [{ id: 'sum', label: 'sum', type: 'number' }] },
    { type: 'scale', label: 'Scale vector', category: 'Math', inputs: [{ id: 'vector', label: 'vector', type: 'vector', required: true }, { id: 'factor', label: 'factor', type: 'number' }], outputs: [{ id: 'vector', label: 'vector', type: 'vector' }] },
    { type: 'select', label: 'Select', category: 'Logic', description: 'a when the condition is true, else b.', inputs: [{ id: 'condition', label: 'condition', type: 'boolean', required: true }, { id: 'a', label: 'a', type: 'any' }, { id: 'b', label: 'b', type: 'any' }], outputs: [{ id: 'value', label: 'value', type: 'any' }], fields: [{ key: 'mode', label: 'Compare', type: 'enum', options: ['strict', 'loose'], default: 'strict' }] },
    { type: 'label', label: 'Label', category: 'Logic', description: 'Passes a value through under a name.', inputs: [{ id: 'in', label: 'in', type: 'any' }], outputs: [{ id: 'out', label: 'out', type: 'any' }], fields: [{ key: 'name', label: 'Name', type: 'string', default: '', maxLength: 32 }] },
    { type: 'output', label: 'Output', category: 'Output', description: 'The graph result.', inputs: [{ id: 'value', label: 'value', type: 'vector', required: true }], outputs: [], max: 1, required: true },
  ],
  allowCycles: false,
  // 4096: the framework's upper bound; the editor is measured at 2000 nodes.
  maxNodes: 4096,
  sinks: ['output'],
};

// ---- phase 16.2: the animator controller's graphs (owner kind `animator`) ----------------
//
// A controller layer is a state machine: state nodes (a clip, a blend tree
// or — override layers only — nothing), the fixed Entry (its one wire names
// the layer's first state) and Any State, and transition wires (one wire per
// ordered pair of states; the pair's transitions — conditions, crossfade,
// exit time — are listed on the wire in the Inspector). A blend tree state
// opens as its own graph: one Clip node per blend child feeding the fixed
// Blend node. The graphs are read from and written to the controller data
// (animator-graph.ts); the node fields mirror the state's own fields.

const TRANSITION_PORTS = {
  inputs: [{ id: 'in', label: 'in', type: 'transition', multi: true }],
  outputs: [{ id: 'out', label: 'out', type: 'transition' }],
} as const;
const STATE_COMMON_FIELDS = [
  // 0–10: the controller data's range (a quarter-speed walk to a 10× time-lapse).
  { key: 'speed', label: 'Speed', type: 'number', default: 1, min: 0, max: 10 },
  { key: 'name', label: 'Name', type: 'string', default: '', maxLength: 128 },
  { key: 'loop', label: 'Loop', type: 'boolean', default: true },
] as const;
const SPEED_PARAMETER_FIELD = { key: 'speedParameter', label: '× parameter', type: 'string', default: '', maxLength: 64 } as const;
const CLIP_FIELDS = [
  { key: 'clip', label: 'Clip', type: 'string', default: '', maxLength: 128 },
  { key: 'duration', label: 'Length (s)', type: 'number', default: 1, min: 0.001, max: 600 },
  { key: 'asset', label: 'Model asset', type: 'string', default: '', maxLength: 64 },
] as const;

const ANIMATOR_NODES: GraphKindDef['nodes'] = [
  { type: 'entry', label: 'Entry', category: 'States', description: 'Where the layer starts: its wire names the first state.', inputs: [], outputs: [{ id: 'out', label: 'start', type: 'transition', single: true }], max: 1, required: true, fixed: true },
  { type: 'any', label: 'Any State', category: 'States', description: 'Its transitions may fire from every state of the layer.', inputs: [], outputs: [{ id: 'out', label: 'any', type: 'transition' }], max: 1, required: true, fixed: true },
  { type: 'state', label: 'State', category: 'States', description: 'Plays one clip.', ...TRANSITION_PORTS, titleField: 'name', fields: [CLIP_FIELDS[0], STATE_COMMON_FIELDS[0], STATE_COMMON_FIELDS[1], STATE_COMMON_FIELDS[2], SPEED_PARAMETER_FIELD, CLIP_FIELDS[1], CLIP_FIELDS[2]] },
  {
    type: 'blend',
    label: 'Blend tree',
    category: 'States',
    description: 'Blends clips by a float or int parameter (double-click to open its clips).',
    ...TRANSITION_PORTS,
    titleField: 'name',
    fields: [{ key: 'parameter', label: 'Blend by', type: 'string', default: '', maxLength: 64 }, STATE_COMMON_FIELDS[0], STATE_COMMON_FIELDS[1], STATE_COMMON_FIELDS[2], SPEED_PARAMETER_FIELD],
  },
];
const ANIMATOR_PORT_TYPES: GraphKindDef['portTypes'] = [{ id: 'transition', label: 'transition', color: '#9fb4d6' }];

/** The base layer of an animator controller (no empty states). */
export const ANIMATOR_GRAPH_KIND: GraphKindDef = {
  kind: 'animator',
  label: 'Animator layer',
  portTypes: ANIMATOR_PORT_TYPES,
  conversions: [],
  categories: ['States'],
  nodes: ANIMATOR_NODES,
  // A state machine loops (idle → run → idle); a state may even transition to itself.
  allowCycles: true,
  // MAX_ANIMATOR_STATES (64) + Entry + Any State.
  maxNodes: 66,
  owner: 'animator',
};

/** An override layer (phase 14.6): also empty states (the layers under it show through). */
export const ANIMATOR_LAYER_GRAPH_KIND: GraphKindDef = {
  ...ANIMATOR_GRAPH_KIND,
  kind: 'animator-layer',
  label: 'Animator override layer',
  nodes: [
    ...ANIMATOR_NODES,
    { type: 'empty', label: 'Empty state', category: 'States', description: 'Plays nothing: the layers under this one show through.', ...TRANSITION_PORTS, titleField: 'name', fields: [...STATE_COMMON_FIELDS, SPEED_PARAMETER_FIELD] },
  ],
};

/** A 1D blend tree state's clips. */
export const ANIMATOR_BLEND_GRAPH_KIND: GraphKindDef = {
  kind: 'animator-blend',
  label: 'Blend tree',
  portTypes: [{ id: 'motion', label: 'motion', color: '#7ed491' }],
  conversions: [],
  categories: ['Blend'],
  nodes: [
    { type: 'output', label: 'Blend', category: 'Blend', description: 'The blend tree: every clip feeds it, weighted by the parameter.', inputs: [{ id: 'motions', label: 'clips', type: 'motion', multi: true }], outputs: [], max: 1, required: true, fixed: true },
    {
      type: 'clip',
      label: 'Clip',
      category: 'Blend',
      description: 'A clip played at its threshold of the blend parameter.',
      inputs: [],
      outputs: [{ id: 'motion', label: 'motion', type: 'motion' }],
      titleField: 'clip',
      fields: [{ key: 'threshold', label: 'Threshold', type: 'number', default: 0, min: -1e6, max: 1e6 }, CLIP_FIELDS[0], CLIP_FIELDS[1], CLIP_FIELDS[2]],
    },
  ],
  allowCycles: false,
  // MAX_BLEND_CHILDREN (16) + the Blend node.
  maxNodes: 17,
  owner: 'animator',
};

/** Every registered graph kind, by kind id. */
export const GRAPH_KINDS: Readonly<Record<string, GraphKindDef>> = {
  [TEST_GRAPH_KIND.kind]: TEST_GRAPH_KIND,
  [ANIMATOR_GRAPH_KIND.kind]: ANIMATOR_GRAPH_KIND,
  [ANIMATOR_LAYER_GRAPH_KIND.kind]: ANIMATOR_LAYER_GRAPH_KIND,
  [ANIMATOR_BLEND_GRAPH_KIND.kind]: ANIMATOR_BLEND_GRAPH_KIND,
  // Phase 19.0: visual scripts (owner kind `behavior`).
  [BEHAVIOR_GRAPH_KIND.kind]: BEHAVIOR_GRAPH_KIND,
  // Phase 19.1: a script's functions (owner kind `behavior`) and shared functions (standalone graphs).
  [BEHAVIOR_FUNCTION_GRAPH_KIND.kind]: BEHAVIOR_FUNCTION_GRAPH_KIND,
  [BEHAVIOR_LIBRARY_GRAPH_KIND.kind]: BEHAVIOR_LIBRARY_GRAPH_KIND,
  // Phase 18.1: material graphs (owner kind `material`) and material functions (standalone graphs).
  [MATERIAL_GRAPH_KIND.kind]: MATERIAL_GRAPH_KIND,
  [MATERIAL_FUNCTION_GRAPH_KIND.kind]: MATERIAL_FUNCTION_GRAPH_KIND,
  // Phase 20.1: a particle system of an effect (owner kind `effect`).
  [EFFECT_GRAPH_KIND.kind]: EFFECT_GRAPH_KIND,
};
