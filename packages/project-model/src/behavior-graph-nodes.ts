/**
 * Phase 19.1: the visual-script node catalogue (data).
 *
 * Three graph kinds share it:
 *
 * - `behavior` — a visual script (a behavior record's `graph`, owner kind
 *   `behavior`);
 * - `behavior-function` — a function inside one script (the record's
 *   `functions`, owner id `<behaviorId>#<functionId>`): its Input and Output
 *   nodes are the call node's ports (the framework's graph interface), its
 *   variables are local to one call, and it may read and write the script's
 *   variables;
 * - `behavior-library` — a shared function (a standalone graph in
 *   `content.graphs`), callable from every script; it sees only its own
 *   inputs and locals.
 *
 * The catalogue is built from tables: the hand-written core nodes (events,
 * flow, variables, functions, constants, maths, logic, text, vectors, lists,
 * maps, random, debug) and the API nodes GENERATED from the runtime typings
 * (`BEHAVIOR_API_NODES`, see behavior-api.ts). The compiler
 * (behavior-build/src/graph.ts) has code for every core node type and emits
 * every API node from its entry alone.
 *
 * Value types of data ports: number, boolean, text (`string`), vector (three
 * numbers), list and map (values of any of these; bounded). Exec ports carry
 * the flow and connect only to exec ports.
 */
import type { GraphFieldDef, GraphKindDef, GraphNodeDef, GraphPortDef, GraphValue } from './graph';
import type { BehaviorApiArg, BehaviorApiNodeSpec, BehaviorDataType } from './behavior-api';
import { BEHAVIOR_API_NODES } from './behavior-api.generated';

// ---- limits (engine limits, not tuning values) -------------------------------------------

export const BEHAVIOR_GRAPH_LIMITS = {
  /** Nodes per graph (the script and each function): keeps the generated module within the compiler's bounds. */
  nodes: 256,
  /** Declared properties (public and private variables) per script = the declared-property bound of a behavior (0–32). */
  variables: 32,
  /** Functions inside one script. */
  functions: 32,
  /**
   * Loop iterations one script instance may run in one step (all its For,
   * For each and While nodes together, functions included): far above any
   * per-step game logic, low enough that a runaway loop costs well under a
   * frame. Exceeding it is a script error naming the loop node.
   */
  loopIterationsPerStep: 10_000,
  /** Items in one list value (a longer list is a script error naming the node). */
  listItems: 1024,
  /** Entries in one map value (more is a script error naming the node). */
  mapEntries: 256,
  /** Cases of one Switch node (phase 19.2: one exec output per listed case, up to this many). */
  switchCases: 32,
} as const;

/** The value types of data ports. */
export const BEHAVIOR_DATA_TYPES: readonly BehaviorDataType[] = ['number', 'boolean', 'string', 'vector', 'list', 'map'];
/** Value types a Switch, a message or a function port can be (no collections where a single value is compared or sent). */
const SCALAR_TYPES: readonly BehaviorDataType[] = ['number', 'boolean', 'string', 'vector'];

/**
 * The kinds of variable a script declares (one declaration node type each:
 * its default field has the kind's type). `entity` holds an entity id (a
 * text; its property is an entity reference picked in the Inspector), `enum`
 * one of a list of texts; lists and maps are never properties.
 */
export const BEHAVIOR_VARIABLE_KINDS = ['number', 'boolean', 'string', 'vector', 'entity', 'enum', 'list', 'map'] as const;
export type BehaviorVariableKind = (typeof BEHAVIOR_VARIABLE_KINDS)[number];
/** Phase 19.0 name, kept: the value types of the first variable kinds. */
export const BEHAVIOR_VALUE_TYPES = BEHAVIOR_VARIABLE_KINDS;
export type BehaviorValueType = BehaviorVariableKind;

/** The data port type of a variable kind. */
export const VARIABLE_PORT_TYPE: Readonly<Record<BehaviorVariableKind, BehaviorDataType>> = { number: 'number', boolean: 'boolean', string: 'string', vector: 'vector', entity: 'string', enum: 'string', list: 'list', map: 'map' };
/** The declared-property type of a variable kind (lists and maps are never properties). */
export const VARIABLE_PROPERTY_TYPE: Readonly<Partial<Record<BehaviorVariableKind, 'number' | 'boolean' | 'string' | 'vec3' | 'entityRef' | 'enum'>>> = { number: 'number', boolean: 'boolean', string: 'string', vector: 'vec3', entity: 'entityRef', enum: 'enum' };
const KIND_LABEL: Record<BehaviorVariableKind, string> = { number: 'Number', boolean: 'Boolean', string: 'Text', vector: 'Vector', entity: 'Entity', enum: 'Choice', list: 'List', map: 'Map' };

/** The default value of each data type (an unwired collection is empty). */
export const DATA_TYPE_DEFAULT: Readonly<Record<'number' | 'boolean' | 'string' | 'vector', GraphValue>> = { number: 0, boolean: false, string: '', vector: [0, 0, 0] };

// ---- port and field helpers ----------------------------------------------------------------

export const EXEC_IN: GraphPortDef = { id: 'in', label: '', type: 'exec', multi: true };
const execIn = (id: string, label: string): GraphPortDef => ({ id, label, type: 'exec', multi: true });
const execOut = (id: string, label = ''): GraphPortDef => ({ id, label, type: 'exec', single: true });
const THEN = execOut('then');
const port = (id: string, label: string, type: string): GraphPortDef => ({ id, label, type });
/** A port whose type is the value of the node's field `field` (a data-dependent port). */
const typedPort = (id: string, label: string, field = 'type'): GraphPortDef => ({ id, label, type: 'number', typeFrom: { field } });

/** The inline-value field of a data input (read when the input is not wired). */
export function inlineField(id: string, label: string, type: string, value: GraphValue): GraphFieldDef | null {
  if (type === 'number') return { key: id, label, type: 'number', default: value, min: -1e9, max: 1e9 };
  if (type === 'boolean') return { key: id, label, type: 'boolean', default: value };
  if (type === 'string') return { key: id, label, type: 'string', default: value, maxLength: 256 };
  if (type === 'vector') return { key: id, label, type: 'vector', size: 3, default: value, min: -1e9, max: 1e9 };
  return null;
}
/** A data input with its inline value (collections have none). */
function input(id: string, label: string, type: 'number' | 'boolean' | 'string' | 'vector' | 'list' | 'map', value?: GraphValue): { port: GraphPortDef; field: GraphFieldDef | null } {
  return { port: port(id, label, type), field: type === 'list' || type === 'map' ? null : inlineField(id, label, type, value ?? DATA_TYPE_DEFAULT[type]) };
}
const typeField = (key: string, label: string, options: readonly string[], dflt: string): GraphFieldDef => ({ key, label, type: 'enum', options, default: dflt });
const textField = (key: string, label: string, maxLength = 64): GraphFieldDef => ({ key, label, type: 'string', default: '', maxLength });
/** The phase an event runs in (the transform phase runs only for scripts that move objects). */
const PHASE_FIELD: GraphFieldDef = { key: 'phase', label: 'Phase', type: 'enum', options: ['intent', 'transform'], default: 'intent' };

/** Build a node from inputs that carry their inline fields. */
function node(d: Omit<GraphNodeDef, 'inputs' | 'fields'> & { inputs: readonly (GraphPortDef | { port: GraphPortDef; field: GraphFieldDef | null })[]; fields?: readonly GraphFieldDef[] }): GraphNodeDef {
  const inputs: GraphPortDef[] = [];
  const fields: GraphFieldDef[] = [];
  for (const i of d.inputs) {
    if ('port' in i) {
      inputs.push(i.port);
      if (i.field !== null) fields.push(i.field);
    } else inputs.push(i);
  }
  fields.push(...(d.fields ?? []));
  const out: GraphNodeDef = { ...d, inputs, ...(fields.length > 0 ? { fields } : {}) };
  if (fields.length === 0) delete (out as { fields?: unknown }).fields;
  return out;
}

// ---- events -------------------------------------------------------------------------------

/**
 * Required text fields of core nodes (checked by the compile check when
 * empty, like the API nodes' required texts).
 */
export const REQUIRED_CORE_FIELDS: Readonly<Record<string, readonly string[]>> = {
  'event.signal': ['signal'],
  'event.input': ['action'],
  'event.timer': ['timer'],
  'event.message': ['message'],
};

const EVENT_NODES: readonly GraphNodeDef[] = [
  { type: 'event.start', label: 'On start', category: 'Events', description: 'Runs once when a run starts (a new game, a replay) — in its phase, before the other events of that step.', inputs: [], outputs: [THEN], fields: [PHASE_FIELD] },
  { type: 'event.step', label: 'On step', category: 'Events', description: 'Runs every fixed simulation step in its phase (intent: decide; transform: move owned objects).', inputs: [], outputs: [THEN, port('step', 'step', 'number')], fields: [PHASE_FIELD] },
  { type: 'event.signal', label: 'On signal', category: 'Events', description: 'Runs in the step after the named signal was emitted (by a switch, a trigger or a script).', inputs: [], outputs: [THEN], titleField: 'signal', fields: [textField('signal', 'Signal'), PHASE_FIELD] },
  {
    type: 'event.trigger',
    label: 'On trigger',
    category: 'Events',
    description: 'Runs once per enter (or exit) of the player into a trigger this script owns — on its object, below it, or named by one of its entity variables — in the step after it happened.',
    inputs: [],
    outputs: [THEN, port('trigger', 'trigger', 'string')],
    fields: [typeField('when', 'When', ['enter', 'exit'], 'enter'), textField('trigger', 'Only trigger (empty: any)'), PHASE_FIELD],
  },
  {
    type: 'event.overlap',
    label: 'On overlap',
    category: 'Events',
    description: 'Every step, asks which colliders overlap a box or circle around this object (offset from it; the size is the box half extents or, in x, the circle radius) and runs per entity that starts overlapping, stops overlapping, or overlaps. Counted with the raycasts (32 per step).',
    inputs: [],
    outputs: [THEN, port('entity', 'entity', 'string')],
    fields: [
      typeField('shape', 'Shape', ['box', 'circle'], 'box'),
      typeField('when', 'When', ['enter', 'exit', 'each'], 'enter'),
      { key: 'offset', label: 'Offset', type: 'vector', size: 3, default: [0, 0, 0], min: -1e6, max: 1e6 },
      // 0.5: a 1 m box or circle, about the size of a crate or a person (no genre's value).
      { key: 'size', label: 'Size', type: 'vector', size: 3, default: [0.5, 0.5, 0], min: 0, max: 1e6 },
      PHASE_FIELD,
    ],
  },
  {
    type: 'event.raycast',
    label: 'On raycast',
    category: 'Events',
    description: 'Every step, casts a ray from this object (plus the offset) along the direction and runs when it hits (each step), starts hitting an entity, or stops hitting it. Counted with the raycasts (32 per step).',
    inputs: [],
    outputs: [THEN, port('entity', 'entity', 'string'), port('distance', 'distance', 'number'), port('normal', 'normal', 'vector')],
    fields: [
      typeField('when', 'When', ['enter', 'exit', 'each'], 'enter'),
      { key: 'offset', label: 'Offset', type: 'vector', size: 3, default: [0, 0, 0], min: -1e6, max: 1e6 },
      // +x: "ahead" in a side view; any direction works.
      { key: 'direction', label: 'Direction', type: 'vector', size: 3, default: [1, 0, 0], min: -1e6, max: 1e6 },
      // 10 m: about a room's width.
      { key: 'distance', label: 'Distance', type: 'number', default: 10, min: 0, max: 1e6 },
      PHASE_FIELD,
    ],
  },
  {
    type: 'event.input',
    label: 'On input',
    category: 'Events',
    description: "Runs in the step a named input action is pressed, released, or held (the game's input actions).",
    inputs: [],
    outputs: [THEN, port('value', 'value', 'number')],
    titleField: 'action',
    fields: [textField('action', 'Action'), typeField('when', 'When', ['pressed', 'released', 'held'], 'pressed'), PHASE_FIELD],
  },
  {
    type: 'event.animator',
    label: 'On animator event',
    category: 'Events',
    description: 'Runs once per clip event an animator passed in the previous step (filtered by name and entity when set).',
    inputs: [],
    outputs: [THEN, port('entity', 'entity', 'string'), port('name', 'name', 'string'), port('clip', 'clip', 'string')],
    fields: [textField('event', 'Only event (empty: any)'), textField('entity', 'Only entity (empty: any)'), PHASE_FIELD],
  },
  { type: 'event.timer', label: 'On timer', category: 'Events', description: "Runs in the step one of this script's named timers fires (start it with Start timer).", inputs: [], outputs: [THEN], titleField: 'timer', fields: [textField('timer', 'Timer'), PHASE_FIELD] },
  {
    type: 'event.message',
    label: 'On message',
    category: 'Events',
    description: 'Runs once per message of this name sent (Send message) in the previous step to every script or to this object, with its value and sender.',
    inputs: [],
    outputs: [THEN, typedPort('value', 'value'), port('from', 'from', 'string')],
    titleField: 'message',
    fields: [textField('message', 'Message'), typeField('type', 'Value type', ['number', 'boolean', 'string'], 'number'), PHASE_FIELD],
  },
];

// ---- flow ---------------------------------------------------------------------------------

const cap = BEHAVIOR_GRAPH_LIMITS.loopIterationsPerStep;

const FLOW_NODES: readonly GraphNodeDef[] = [
  node({ type: 'flow.branch', label: 'Branch', category: 'Flow', description: 'Continues on "true" or "false".', inputs: [EXEC_IN, input('condition', 'condition', 'boolean')], outputs: [execOut('true', 'true'), execOut('false', 'false')] }),
  { type: 'flow.sequence', label: 'Sequence', category: 'Flow', description: 'Runs its outputs one after the other, top to bottom.', inputs: [EXEC_IN], outputs: [execOut('then1', 'then 1'), execOut('then2', 'then 2'), execOut('then3', 'then 3'), execOut('then4', 'then 4')] },
  node({
    type: 'flow.for',
    label: 'For',
    category: 'Flow',
    description: `Runs "body" once per whole number from first to last (both included), then "completed". Bounded: a script may run ${cap} loop iterations per step; more is a script error naming the loop.`,
    // 0..0: one iteration until the designer sets the range (no genre-specific count).
    inputs: [EXEC_IN, input('first', 'first', 'number'), input('last', 'last', 'number')],
    outputs: [execOut('body', 'body'), port('index', 'index', 'number'), execOut('completed', 'completed')],
  }),
  {
    type: 'flow.foreach',
    label: 'For each',
    category: 'Flow',
    description: `Runs "body" once per item of a list (in order), then "completed". Bounded like For (${cap} iterations per step).`,
    inputs: [EXEC_IN, port('list', 'list', 'list')],
    outputs: [execOut('body', 'body'), typedPort('item', 'item', 'of'), port('index', 'index', 'number'), execOut('completed', 'completed')],
    fields: [typeField('of', 'Items', BEHAVIOR_DATA_TYPES, 'number')],
  },
  node({
    type: 'flow.while',
    label: 'While',
    category: 'Flow',
    description: `Runs "body" while the condition (read again before each round) is true, then "completed". Bounded like For (${cap} iterations per step).`,
    inputs: [EXEC_IN, input('condition', 'condition', 'boolean')],
    outputs: [execOut('body', 'body'), execOut('completed', 'completed')],
  }),
  {
    type: 'flow.gate',
    label: 'Gate',
    category: 'Flow',
    description: 'Passes the flow from "enter" to "exit" only while open; "open", "close" and "toggle" change it (per object; a new run starts it again).',
    inputs: [execIn('in', 'enter'), execIn('open', 'open'), execIn('close', 'close'), execIn('toggle', 'toggle')],
    outputs: [execOut('then', 'exit')],
    fields: [{ key: 'open', label: 'Starts open', type: 'boolean', default: true }],
  },
  { type: 'flow.doonce', label: 'Do once', category: 'Flow', description: 'Passes the flow the first time only (per object and run) until "reset".', inputs: [EXEC_IN, execIn('reset', 'reset')], outputs: [THEN] },
  node({
    type: 'flow.delay',
    label: 'Delay',
    category: 'Flow',
    description: 'Continues after the given time, counted in fixed steps (a timer of this script). While waiting, a new arrival is ignored. Values of the nodes before it are kept for the rest of the flow.',
    // 1 s: a neutral pause.
    inputs: [EXEC_IN, input('seconds', 'seconds', 'number', 1)],
    outputs: [execOut('then', 'completed')],
  }),
  {
    type: 'flow.switch',
    label: 'Switch',
    category: 'Flow',
    description: `Continues on the first case equal to the value (text, or a whole number), else on "default". The cases are a comma-separated list — one output per case (at most ${BEHAVIOR_GRAPH_LIMITS.switchCases}); empty cases never match.`,
    inputs: [EXEC_IN, { id: 'value', label: 'value', type: 'string', typeFrom: { field: 'on', map: { text: 'string', int: 'number' } } }],
    // Phase 19.2: one exec output per listed case (ids case1, case2, …: a case keeps its wire while others are added after it).
    outputs: [{ ...execOut('case', 'case'), repeat: { field: 'cases', max: BEHAVIOR_GRAPH_LIMITS.switchCases } }, execOut('default', 'default')],
    // "1, 2, 3": three cases, a neutral start that reads the same comparing text or whole numbers.
    fields: [typeField('on', 'Compare', ['text', 'int'], 'text'), { key: 'cases', label: 'Cases (comma separated)', type: 'string', default: '1, 2, 3', maxLength: 1024 }, { key: 'value', label: 'value', type: 'string', default: '', maxLength: 256 }],
  },
  {
    type: 'flow.select',
    label: 'Select',
    category: 'Flow',
    description: 'a when the condition is true, else b.',
    inputs: [port('condition', 'condition', 'boolean'), typedPort('a', 'a'), typedPort('b', 'b')],
    outputs: [typedPort('value', 'value')],
    fields: [{ key: 'condition', label: 'condition', type: 'boolean', default: false }, typeField('type', 'Type', BEHAVIOR_DATA_TYPES, 'number')],
  },
];

// ---- variables ----------------------------------------------------------------------------

/** Where a variable lives: public/private = a per-object property (Inspector / hidden), local = one event run or one function call. */
export const VARIABLE_VISIBILITY = ['public', 'private', 'local'] as const;

/** A variable's declaration node (one type per kind). In a function every variable is local to one call. */
function variableNode(k: BehaviorVariableKind, inFunction: boolean): GraphNodeDef {
  const L = KIND_LABEL[k];
  const collection = k === 'list' || k === 'map';
  const fields: GraphFieldDef[] = [{ key: 'name', label: 'Name', type: 'string', default: '', maxLength: 64 }];
  if (k === 'enum') fields.push({ key: 'options', label: 'Choices (comma separated)', type: 'string', default: '', maxLength: 1024 });
  if (!collection) fields.push(inlineField('default', 'Default', k === 'entity' || k === 'enum' ? 'string' : k, k === 'entity' || k === 'enum' ? '' : DATA_TYPE_DEFAULT[k])!);
  if (!inFunction) {
    fields.push(collection ? { key: 'visibility', label: 'Visibility', type: 'enum', options: ['private', 'local'], default: 'private' } : { key: 'visibility', label: 'Visibility', type: 'enum', options: VARIABLE_VISIBILITY, default: 'public' });
    if (!collection) fields.push(textField('label', 'Label'), textField('group', 'Group'), textField('tooltip', 'Tooltip', 256));
  }
  const where = inFunction
    ? 'Local to one call of the function (it starts at its default each call).'
    : collection
      ? `Private: one per object, kept between steps (never a property); local: one per event run.`
      : 'Public: a property shown and set per object in the Inspector; private: one per object, starting at the default; local: one per event run.';
  return {
    type: `var.${k}`,
    label: `${L} variable`,
    category: 'Variables',
    description: `Declares a ${L.toLowerCase()} variable${k === 'entity' ? ' (an entity id; as a property, picked in the Inspector)' : k === 'enum' ? ' (one of the listed choices)' : ''}. ${where}`,
    inputs: [],
    outputs: [],
    titleField: 'name',
    fields,
  };
}

/**
 * The value port of Get/Set variable: typed by the named variable
 * (`behaviorGraphContext`); `any` while the name declares nothing (the
 * compile check reports it), so renaming or deleting a variable never
 * strands its wires.
 */
const variablePort = (id: string, label: string): GraphPortDef => ({ id, label, type: 'any', typeFrom: { field: 'variable', lookup: 'variable' } });
const VARIABLE_NAME_FIELD: GraphFieldDef = { key: 'variable', label: 'Variable', type: 'string', default: '', maxLength: 64 };

const VARIABLE_ACCESS_NODES: readonly GraphNodeDef[] = [
  { type: 'var.get', label: 'Get variable', category: 'Variables', description: "Reads a variable (its output takes the variable's type).", inputs: [], outputs: [variablePort('value', 'value')], titleField: 'variable', fields: [VARIABLE_NAME_FIELD] },
  {
    type: 'var.set',
    label: 'Set variable',
    category: 'Variables',
    description: 'Writes a variable. Unwired, it writes "Value": a number, true/false, text, or "x, y, z" for the variable\'s type (empty = its type\'s zero; lists and maps become empty).',
    inputs: [EXEC_IN, variablePort('value', 'value')],
    outputs: [THEN, variablePort('value', 'value')],
    titleField: 'variable',
    fields: [VARIABLE_NAME_FIELD, { key: 'value', label: 'Value', type: 'string', default: '', maxLength: 256 }],
  },
];

// ---- functions ----------------------------------------------------------------------------

/** The kinds of the two callable graph kinds (see the file comment). */
export const BEHAVIOR_FUNCTION_KIND = 'behavior-function';
export const BEHAVIOR_LIBRARY_KIND = 'behavior-library';

const CALL_NODES: readonly GraphNodeDef[] = [
  {
    type: 'fn.call',
    label: 'Call function',
    category: 'Functions',
    description: "Runs one of this script's functions: its inputs are the function's Input nodes, its outputs the function's Output nodes (read when the function's flow has finished).",
    inputs: [EXEC_IN],
    outputs: [THEN],
    titleField: 'function',
    fields: [{ key: 'function', label: 'Function', type: 'string', default: '', maxLength: 64 }],
    portsFrom: { field: 'function', kind: BEHAVIOR_FUNCTION_KIND },
  },
  {
    type: 'fn.library',
    label: 'Call shared function',
    category: 'Functions',
    description: "Runs a shared function (a function graph of the project's library, usable from every script).",
    inputs: [EXEC_IN],
    outputs: [THEN],
    titleField: 'function',
    fields: [{ key: 'function', label: 'Shared function', type: 'string', default: '', maxLength: 64 }],
    portsFrom: { field: 'function', kind: BEHAVIOR_LIBRARY_KIND },
  },
];
const INTERFACE_FIELDS: readonly GraphFieldDef[] = [
  { key: 'name', label: 'Name', type: 'string', default: '', maxLength: 64 },
  typeField('type', 'Type', BEHAVIOR_DATA_TYPES, 'number'),
];
const FUNCTION_NODES: readonly GraphNodeDef[] = [
  { type: 'fn.entry', label: 'Function start', category: 'Functions', description: 'Where a call of the function starts its flow.', inputs: [], outputs: [THEN], titleField: 'name', fields: [{ key: 'name', label: 'Function name', type: 'string', default: '', maxLength: 64 }], max: 1, required: true },
  { type: 'fn.input', label: 'Input', category: 'Functions', description: "One of the function's inputs (a port of every call, top to bottom).", inputs: [], outputs: [typedPort('value', 'value')], titleField: 'name', fields: INTERFACE_FIELDS },
  { type: 'fn.output', label: 'Output', category: 'Functions', description: "One of the function's outputs (a port of every call): the value wired into it when the flow has finished.", inputs: [typedPort('value', 'value')], outputs: [], titleField: 'name', fields: INTERFACE_FIELDS },
];

// ---- constants, maths, logic, text, vectors -----------------------------------------------

const constant = (type: string, label: string, t: 'number' | 'boolean' | 'string' | 'vector'): GraphNodeDef => ({
  type,
  label,
  category: 'Constants',
  description: `A fixed ${label.toLowerCase()}.`,
  inputs: [],
  outputs: [port('value', 'value', t)],
  fields: [inlineField('value', 'Value', t, DATA_TYPE_DEFAULT[t])!],
});

const nums = (ids: readonly string[], values: readonly number[] = []) => ids.map((id, i) => input(id, id, 'number', values[i] ?? 0));
const math = (type: string, label: string, description: string, ids: readonly string[] = ['a', 'b'], values: readonly number[] = []): GraphNodeDef =>
  node({ type, label, category: 'Maths', description, inputs: nums(ids, values), outputs: [port('result', 'result', 'number')] });
const bools = (ids: readonly string[]) => ids.map((id) => input(id, id, 'boolean'));
const vecIn = (id: string) => input(id, id, 'vector');

const VALUE_NODES: readonly GraphNodeDef[] = [
  constant('const.number', 'Number', 'number'),
  constant('const.boolean', 'Boolean', 'boolean'),
  constant('const.text', 'Text', 'string'),
  constant('const.vector', 'Vector', 'vector'),
  math('math.add', 'Add', 'a + b'),
  math('math.subtract', 'Subtract', 'a − b'),
  math('math.multiply', 'Multiply', 'a × b'),
  math('math.divide', 'Divide', 'a ÷ b (0 when b is 0, so values stay finite)'),
  math('math.modulo', 'Modulo', 'The remainder of a ÷ b, with the sign of b (0 when b is 0).'),
  math('math.power', 'Power', 'a to the power b (0 when the result is not a finite number).'),
  math('math.min', 'Min', 'The smaller of a and b.'),
  math('math.max', 'Max', 'The larger of a and b.'),
  math('math.abs', 'Absolute', '|value|', ['value']),
  math('math.negate', 'Negate', '−value', ['value']),
  math('math.floor', 'Floor', 'The whole number at or below value.', ['value']),
  math('math.ceil', 'Ceiling', 'The whole number at or above value.', ['value']),
  math('math.round', 'Round', 'The nearest whole number (halves away from zero).', ['value']),
  math('math.sign', 'Sign', '−1, 0 or 1.', ['value']),
  math('math.sqrt', 'Square root', '√value (0 below 0).', ['value']),
  math('math.clamp', 'Clamp', 'value kept between min and max.', ['value', 'min', 'max'], [0, 0, 1]),
  math('math.lerp', 'Lerp', 'a + (b − a) × t.', ['a', 'b', 't']),
  math('math.sin', 'Sine', 'sin of an angle in degrees.', ['degrees']),
  math('math.cos', 'Cosine', 'cos of an angle in degrees.', ['degrees']),
  math('math.atan2', 'Angle of', 'The angle (degrees) of the direction (x, y), from +x towards +y.', ['y', 'x']),
  node({
    type: 'math.compare',
    label: 'Compare',
    category: 'Maths',
    description: 'Compares two numbers.',
    inputs: nums(['a', 'b']),
    outputs: [port('result', 'result', 'boolean')],
    fields: [{ key: 'op', label: 'Test', type: 'enum', options: ['==', '!=', '<', '<=', '>', '>='], default: '==' }],
  }),
  node({ type: 'logic.and', label: 'And', category: 'Logic', description: 'true when a and b are true', inputs: bools(['a', 'b']), outputs: [port('result', 'result', 'boolean')] }),
  node({ type: 'logic.or', label: 'Or', category: 'Logic', description: 'true when a or b is true', inputs: bools(['a', 'b']), outputs: [port('result', 'result', 'boolean')] }),
  node({ type: 'logic.xor', label: 'Xor', category: 'Logic', description: 'true when exactly one of a and b is true', inputs: bools(['a', 'b']), outputs: [port('result', 'result', 'boolean')] }),
  node({ type: 'logic.not', label: 'Not', category: 'Logic', description: 'true when the value is false', inputs: bools(['value']), outputs: [port('result', 'result', 'boolean')] }),
  node({ type: 'text.join', label: 'Join text', category: 'Text', description: 'a followed by b.', inputs: [input('a', 'a', 'string'), input('b', 'b', 'string')], outputs: [port('result', 'result', 'string')] }),
  node({ type: 'text.equal', label: 'Text equals', category: 'Text', description: 'true when a and b are the same text.', inputs: [input('a', 'a', 'string'), input('b', 'b', 'string')], outputs: [port('result', 'result', 'boolean')] }),
  node({ type: 'text.contains', label: 'Text contains', category: 'Text', description: 'true when the text contains the part.', inputs: [input('text', 'text', 'string'), input('part', 'part', 'string')], outputs: [port('result', 'result', 'boolean')] }),
  node({ type: 'text.length', label: 'Text length', category: 'Text', description: 'The number of characters.', inputs: [input('text', 'text', 'string')], outputs: [port('result', 'result', 'number')] }),
  node({ type: 'text.number', label: 'Text to number', category: 'Text', description: 'The number a text spells (0 when it is not a number).', inputs: [input('text', 'text', 'string')], outputs: [port('result', 'result', 'number')] }),
  node({ type: 'vec.make', label: 'Make vector', category: 'Vectors', description: '(x, y, z).', inputs: nums(['x', 'y', 'z']), outputs: [port('vector', 'vector', 'vector')] }),
  node({ type: 'vec.break', label: 'Break vector', category: 'Vectors', description: 'The x, y and z of a vector.', inputs: [vecIn('vector')], outputs: [port('x', 'x', 'number'), port('y', 'y', 'number'), port('z', 'z', 'number')] }),
  node({ type: 'vec.add', label: 'Add vectors', category: 'Vectors', description: 'a + b', inputs: [vecIn('a'), vecIn('b')], outputs: [port('result', 'result', 'vector')] }),
  node({ type: 'vec.subtract', label: 'Subtract vectors', category: 'Vectors', description: 'a − b', inputs: [vecIn('a'), vecIn('b')], outputs: [port('result', 'result', 'vector')] }),
  node({ type: 'vec.scale', label: 'Scale vector', category: 'Vectors', description: 'vector × factor', inputs: [vecIn('vector'), input('factor', 'factor', 'number', 1)], outputs: [port('result', 'result', 'vector')] }),
  node({ type: 'vec.length', label: 'Vector length', category: 'Vectors', description: 'The length of a vector.', inputs: [vecIn('vector')], outputs: [port('result', 'result', 'number')] }),
  node({ type: 'vec.distance', label: 'Distance', category: 'Vectors', description: 'The distance between two points.', inputs: [vecIn('a'), vecIn('b')], outputs: [port('result', 'result', 'number')] }),
  node({ type: 'vec.normalize', label: 'Normalize', category: 'Vectors', description: 'The vector with length 1 (0, 0, 0 stays 0, 0, 0).', inputs: [vecIn('vector')], outputs: [port('result', 'result', 'vector')] }),
  node({ type: 'vec.dot', label: 'Dot product', category: 'Vectors', description: 'a · b', inputs: [vecIn('a'), vecIn('b')], outputs: [port('result', 'result', 'number')] }),
  node({ type: 'vec.cross', label: 'Cross product', category: 'Vectors', description: 'a × b', inputs: [vecIn('a'), vecIn('b')], outputs: [port('result', 'result', 'vector')] }),
  node({ type: 'vec.lerp', label: 'Lerp vectors', category: 'Vectors', description: 'a + (b − a) × t', inputs: [vecIn('a'), vecIn('b'), input('t', 't', 'number')], outputs: [port('result', 'result', 'vector')] }),
];

// ---- lists, maps, random ------------------------------------------------------------------

const OF_FIELD = typeField('of', 'Items', BEHAVIOR_DATA_TYPES, 'number');
const item = (id = 'item', label = 'item'): GraphPortDef => typedPort(id, label, 'of');
const L_ITEMS = BEHAVIOR_GRAPH_LIMITS.listItems;
const M_ENTRIES = BEHAVIOR_GRAPH_LIMITS.mapEntries;

const COLLECTION_NODES: readonly GraphNodeDef[] = [
  {
    type: 'list.make',
    label: 'Make list',
    category: 'Lists',
    description: `A list of the first "count" items (unwired items are their type's zero). Lists keep at most ${L_ITEMS} items. List nodes never change a list: they give a new one (store it with Set variable).`,
    inputs: [item('item1', 'item 1'), item('item2', 'item 2'), item('item3', 'item 3'), item('item4', 'item 4')],
    outputs: [port('list', 'list', 'list')],
    fields: [OF_FIELD, { key: 'count', label: 'Count', type: 'number', default: 0, min: 0, max: 4 }],
  },
  node({ type: 'list.length', label: 'List length', category: 'Lists', description: 'The number of items.', inputs: [port('list', 'list', 'list')], outputs: [port('result', 'result', 'number')] }),
  node({ type: 'list.get', label: 'Get item', category: 'Lists', description: 'The item at an index (0 is the first; found is false outside the list).', inputs: [port('list', 'list', 'list'), input('index', 'index', 'number')], outputs: [item(), port('found', 'found', 'boolean')], fields: [OF_FIELD] }),
  node({ type: 'list.set', label: 'Set item', category: 'Lists', description: 'The list with the item at an index replaced (unchanged outside the list).', inputs: [port('list', 'list', 'list'), input('index', 'index', 'number'), item()], outputs: [port('list', 'list', 'list')], fields: [OF_FIELD] }),
  node({ type: 'list.add', label: 'Add item', category: 'Lists', description: `The list with an item added at the end (at most ${L_ITEMS} items: more is a script error).`, inputs: [port('list', 'list', 'list'), item()], outputs: [port('list', 'list', 'list')], fields: [OF_FIELD] }),
  node({ type: 'list.remove', label: 'Remove item', category: 'Lists', description: 'The list without the item at an index.', inputs: [port('list', 'list', 'list'), input('index', 'index', 'number')], outputs: [port('list', 'list', 'list')] }),
  node({ type: 'list.contains', label: 'List contains', category: 'Lists', description: 'true when an item equals the value.', inputs: [port('list', 'list', 'list'), item()], outputs: [port('result', 'result', 'boolean')], fields: [OF_FIELD] }),
  node({ type: 'list.indexOf', label: 'Index of', category: 'Lists', description: 'The index of the first item equal to the value (−1 when none).', inputs: [port('list', 'list', 'list'), item()], outputs: [port('result', 'result', 'number')], fields: [OF_FIELD] }),
  { type: 'map.make', label: 'Empty map', category: 'Maps', description: `A map with no entries (text keys to values; at most ${M_ENTRIES} entries). Map nodes never change a map: they give a new one.`, inputs: [], outputs: [port('map', 'map', 'map')] },
  node({ type: 'map.set', label: 'Set entry', category: 'Maps', description: `The map with the key set to the value (at most ${M_ENTRIES} entries: more is a script error).`, inputs: [port('map', 'map', 'map'), input('key', 'key', 'string'), item('value', 'value')], outputs: [port('map', 'map', 'map')], fields: [OF_FIELD] }),
  node({ type: 'map.get', label: 'Get entry', category: 'Maps', description: "The key's value (found is false when the map has no such key).", inputs: [port('map', 'map', 'map'), input('key', 'key', 'string')], outputs: [item('value', 'value'), port('found', 'found', 'boolean')], fields: [OF_FIELD] }),
  node({ type: 'map.has', label: 'Has key', category: 'Maps', description: 'true when the map has the key.', inputs: [port('map', 'map', 'map'), input('key', 'key', 'string')], outputs: [port('result', 'result', 'boolean')] }),
  node({ type: 'map.remove', label: 'Remove entry', category: 'Maps', description: 'The map without the key.', inputs: [port('map', 'map', 'map'), input('key', 'key', 'string')], outputs: [port('map', 'map', 'map')] }),
  node({ type: 'map.size', label: 'Map size', category: 'Maps', description: 'The number of entries.', inputs: [port('map', 'map', 'map')], outputs: [port('result', 'result', 'number')] }),
  node({ type: 'map.keys', label: 'Map keys', category: 'Maps', description: 'The keys (in the order they were first set) as a list of texts.', inputs: [port('map', 'map', 'map')], outputs: [port('list', 'keys', 'list')] }),
  node({ type: 'random.number', label: 'Random number', category: 'Random', description: 'A number from min up to (not including) max. Deterministic: each object draws from its own sequence, which starts again with every run (a replay repeats it). Every read draws the next number.', inputs: nums(['min', 'max'], [0, 1]), outputs: [port('result', 'result', 'number')] }),
  node({ type: 'random.integer', label: 'Random integer', category: 'Random', description: 'A whole number from min to max (both included), from the object\'s deterministic sequence.', inputs: nums(['min', 'max'], [1, 6]), outputs: [port('result', 'result', 'number')] }),
  node({ type: 'random.chance', label: 'Random chance', category: 'Random', description: "true with the given probability (0–1), from the object's deterministic sequence.", inputs: [input('probability', 'probability', 'number', 0.5)], outputs: [port('result', 'result', 'boolean')] }),
  node({
    type: 'debug.log',
    label: 'Log',
    category: 'Debug',
    description: 'Writes a line to the play log.',
    inputs: [EXEC_IN, input('message', 'message', 'string')],
    outputs: [THEN],
    fields: [{ key: 'level', label: 'Level', type: 'enum', options: ['info', 'warn', 'error'], default: 'info' }],
  }),
];

// ---- API nodes (generated) ----------------------------------------------------------------

/** The choices of an axes argument (`x y z`, `x y`, …, and `none` when it may be left out). */
export function axesOptions(axes: readonly string[]): string[] {
  const keys = axes.filter((k) => k !== 'none');
  const out: string[] = [];
  for (let size = keys.length; size >= 1; size--) {
    const pick = (start: number, acc: string[]): void => {
      if (acc.length === size) {
        out.push(acc.join(' '));
        return;
      }
      for (let i = start; i < keys.length; i++) pick(i + 1, [...acc, keys[i]!]);
    };
    pick(0, []);
  }
  return axes.includes('none') ? [...out, 'none'] : out;
}

function apiArgFields(a: BehaviorApiArg): GraphFieldDef[] {
  if (a.options !== undefined) return [{ key: a.id, label: a.label, type: 'enum', options: a.options, default: typeof a.default === 'string' ? a.default : a.options[0]! }];
  if (a.type === 'typed') return [typeField(`${a.id}_type`, `${a.label} type`, a.types ?? BEHAVIOR_DATA_TYPES, (a.types ?? BEHAVIOR_DATA_TYPES)[0]!), { key: a.id, label: a.label, type: 'string', default: '', maxLength: 256 }];
  if (a.default === undefined) return [];
  const f0 = inlineField(a.id, a.label, a.type, a.default);
  const f = f0 !== null && a.asset !== undefined ? { ...f0, asset: a.asset } : f0;
  const out = f === null ? [] : [f];
  if (a.axes !== undefined) {
    const opts = axesOptions(a.axes);
    out.push(typeField(`${a.id}_axes`, `${a.label} axes`, opts, opts[0]!));
  }
  return out;
}

/** The graph node definition of one API entry. */
export function apiNodeDef(s: BehaviorApiNodeSpec): GraphNodeDef {
  const inputs: GraphPortDef[] = s.exec ? [EXEC_IN] : [];
  const fields: GraphFieldDef[] = [];
  for (const a of s.args) {
    if (a.options === undefined) inputs.push(a.type === 'typed' ? typedPort(a.id, a.label, `${a.id}_type`) : port(a.id, a.label, a.type));
    fields.push(...apiArgFields(a));
  }
  const outputs: GraphPortDef[] = s.exec ? [THEN] : [];
  for (const o of s.outputs) {
    if (o.type === 'typed') {
      outputs.push(typedPort(o.id, o.label, `${o.id}_type`));
      if (!fields.some((f) => f.key === `${o.id}_type`)) fields.push(typeField(`${o.id}_type`, `${o.label} type`, o.types ?? BEHAVIOR_DATA_TYPES, (o.types ?? BEHAVIOR_DATA_TYPES)[0]!));
    } else outputs.push(port(o.id, o.label, o.type));
  }
  const phase = s.phase !== undefined ? ` Runs only in the ${s.phase} phase.` : '';
  const self = s.args.some((a) => a.self === true) ? ' An empty entity means this object.' : '';
  return { type: s.type, label: s.label, category: s.category, description: `${s.description}${phase}${self}`.trim(), inputs, outputs, ...(fields.length > 0 ? { fields } : {}) };
}

export { BEHAVIOR_API_NODES };

// ---- the kinds ----------------------------------------------------------------------------

const PORT_TYPES: GraphKindDef['portTypes'] = [
  // Phase 19.2: exec wires are control flow (drawn thicker, with arrows).
  { id: 'exec', label: 'exec', color: '#f4f4f4', flow: true },
  { id: 'number', label: 'number', color: '#7fb3ff' },
  { id: 'boolean', label: 'boolean', color: '#e67e9b' },
  { id: 'string', label: 'text', color: '#f2b544' },
  { id: 'vector', label: 'vector', color: '#ffd98a' },
  { id: 'list', label: 'list', color: '#9fd67e' },
  { id: 'map', label: 'map', color: '#c79bf2' },
  { id: 'any', label: 'any (no such variable)', color: '#9a9a9a' },
];
const CONVERSIONS: GraphKindDef['conversions'] = [
  { from: 'number', to: 'string', label: 'number → text' },
  { from: 'boolean', to: 'string', label: 'boolean → text ("true"/"false")' },
  { from: 'boolean', to: 'number', label: 'boolean → number (0 or 1)' },
  { from: 'number', to: 'vector', label: 'number → vector (all components)' },
  { from: 'vector', to: 'string', label: 'vector → text ("x, y, z")' },
];
const CORE_CATEGORIES = ['Events', 'Flow', 'Variables', 'Functions', 'Constants', 'Maths', 'Logic', 'Text', 'Vectors', 'Lists', 'Maps', 'Random', 'Debug'];
const API_CATEGORIES = [...new Set(BEHAVIOR_API_NODES.map((s) => s.category))];
const API_DEFS = BEHAVIOR_API_NODES.map(apiNodeDef);
const VARIABLE_NODES = (inFunction: boolean): GraphNodeDef[] => BEHAVIOR_VARIABLE_KINDS.map((k) => variableNode(k, inFunction));

export const BEHAVIOR_GRAPH_KIND: GraphKindDef = {
  kind: 'behavior',
  label: 'Visual script',
  portTypes: PORT_TYPES,
  conversions: CONVERSIONS,
  // Only a Get/Set variable naming no variable has an `any` port (see variablePort).
  anyType: 'any',
  categories: [...CORE_CATEGORIES, ...API_CATEGORIES],
  nodes: [...EVENT_NODES, ...FLOW_NODES, ...VARIABLE_NODES(false), ...VARIABLE_ACCESS_NODES, ...CALL_NODES, ...VALUE_NODES, ...COLLECTION_NODES, ...API_DEFS],
  allowCycles: false,
  maxNodes: BEHAVIOR_GRAPH_LIMITS.nodes,
  owner: 'behavior',
};

const FUNCTION_INTERFACE = { input: 'fn.input', output: 'fn.output', labelField: 'name', typeField: 'type' } as const;
// A function's flow: every node except events and the latent Delay (a call returns within its step).
const FUNCTION_FLOW = FLOW_NODES.filter((d) => d.type !== 'flow.delay');

export const BEHAVIOR_FUNCTION_GRAPH_KIND: GraphKindDef = {
  kind: BEHAVIOR_FUNCTION_KIND,
  label: 'Script function',
  portTypes: PORT_TYPES,
  conversions: CONVERSIONS,
  anyType: 'any',
  categories: [...CORE_CATEGORIES.filter((c) => c !== 'Events'), ...API_CATEGORIES],
  nodes: [...FUNCTION_NODES, ...FUNCTION_FLOW, ...VARIABLE_NODES(true), ...VARIABLE_ACCESS_NODES, ...CALL_NODES, ...VALUE_NODES, ...COLLECTION_NODES, ...API_DEFS],
  allowCycles: false,
  maxNodes: BEHAVIOR_GRAPH_LIMITS.nodes,
  owner: 'behavior',
  interface: FUNCTION_INTERFACE,
};

export const BEHAVIOR_LIBRARY_GRAPH_KIND: GraphKindDef = {
  kind: BEHAVIOR_LIBRARY_KIND,
  label: 'Shared script function',
  portTypes: PORT_TYPES,
  conversions: CONVERSIONS,
  anyType: 'any',
  categories: [...CORE_CATEGORIES.filter((c) => c !== 'Events'), ...API_CATEGORIES],
  nodes: [...FUNCTION_NODES, ...FUNCTION_FLOW, ...VARIABLE_NODES(true), ...VARIABLE_ACCESS_NODES, CALL_NODES[1]!, ...VALUE_NODES, ...COLLECTION_NODES, ...API_DEFS],
  allowCycles: false,
  maxNodes: BEHAVIOR_GRAPH_LIMITS.nodes,
  interface: FUNCTION_INTERFACE,
};

/** Value types a function Input/Output may have (for docs; the type field lists them). */
export const BEHAVIOR_INTERFACE_TYPES = BEHAVIOR_DATA_TYPES;
export { SCALAR_TYPES as BEHAVIOR_SCALAR_TYPES };
