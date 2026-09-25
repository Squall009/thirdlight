/**
 * Phase 19.0: visual scripts — the `behavior` graph kind.
 *
 * A visual script is a behavior record whose `graph` holds a node graph of
 * this kind (owner kind `behavior`, edited with the generic `graphEdit`). The
 * backend compiles it to TypeScript and feeds that to the one behavior
 * compiler (`behavior-build`), so a graph behavior runs, is sandboxed and
 * exports exactly like a TypeScript behavior.
 *
 * The node catalogue is data built from three tables:
 *
 * - the hand-written core nodes (events, flow, maths, logic, log),
 * - the variable nodes: `var.<t>` declares a variable of value type t (one
 *   node type per value type: its default field has that type); `var.get` /
 *   `var.set` read and write one by name — their value ports take the
 *   variable's type through the framework's data-dependent ports
 *   (`typeFrom` with the `variable` lookup of `behaviorGraphContext`, the
 *   graph's own declarations),
 * - the API nodes (`BEHAVIOR_API_NODES`): each names a `ctx` member path,
 *   its arguments and its result; the compiler emits every API node from
 *   this data alone, so a new entry needs no compiler change (phase 19.1
 *   generates the full table from the runtime's `BehaviorContext` typings).
 *
 * Wiring rules (the generic validator enforces them from this data):
 * exec ports (`exec`) connect only to exec ports; every exec output takes
 * one wire (a Sequence has several outputs); exec inputs take many; data
 * inputs take one wire and outputs fan out; the graph has no cycles at all
 * (`allowCycles: false`), so data cycles are refused and repetition exists
 * only inside the bounded For node's body. An unconnected data input reads
 * the node's field of the same key (its inline value).
 *
 * Semantic rules that depend on node data (variable names and types, ≥ 1
 * variable, empty names) are compile diagnostics (`checkBehaviorGraph`),
 * never edit refusals: a graph is edited through incomplete states.
 */
import type { GraphContext, GraphData, GraphFieldDef, GraphKindDef, GraphNode, GraphNodeDef, GraphPortDef, GraphValue } from './graph';
import type { DeclaredProperty, PropertyDeclaration } from './types-v2';

// ---- limits (engine limits, not tuning values) -------------------------------------------

export const BEHAVIOR_GRAPH_LIMITS = {
  /** Nodes per visual script: keeps the generated module under the compiler's 64 KiB-per-file bound. */
  nodes: 256,
  /** Variables per script = the declared-property bound of a behavior (1–32). */
  variables: 32,
  /**
   * Loop iterations one script instance may run in one step (all its For
   * nodes together): far above any per-step game logic, low enough that a
   * runaway loop costs well under a frame. Exceeding it is a script error
   * naming the loop node.
   */
  loopIterationsPerStep: 10_000,
} as const;

/** The value types a variable (and a data port) can have. */
export const BEHAVIOR_VALUE_TYPES = ['number', 'boolean', 'string'] as const;
export type BehaviorValueType = (typeof BEHAVIOR_VALUE_TYPES)[number];
const VALUE_TYPE_LABEL: Record<BehaviorValueType, string> = { number: 'Number', boolean: 'Boolean', string: 'Text' };
const VALUE_DEFAULT: Record<BehaviorValueType, GraphValue> = { number: 0, boolean: false, string: '' };
/** The declared-property type a variable of each value type becomes. */
export const VARIABLE_PROPERTY_TYPE: Record<BehaviorValueType, DeclaredProperty['type']> = { number: 'number', boolean: 'boolean', string: 'string' };

/** Property keys (a variable's name is its property key). */
export const BEHAVIOR_VARIABLE_NAME_RE = /^[a-z][a-z0-9_]{0,63}$/;

// ---- API nodes (data) ------------------------------------------------------------------------

export interface BehaviorApiArg {
  id: string;
  label: string;
  type: BehaviorValueType;
  /** The inline value used when the input is not wired. */
  default: GraphValue;
  /** A text argument that must not be empty (checked when the input is not wired). */
  required?: true;
}

/** One `ctx` call as a node (phase 19.1 generates these from the runtime typings). */
export interface BehaviorApiNodeSpec {
  type: string;
  label: string;
  category: string;
  description: string;
  /** The `ctx` member path, e.g. `['game', 'add']` → `ctx.game?.add(…)`. */
  path: readonly string[];
  /** Path segments before the call that may be absent on `ctx` (read with `?.`). */
  optional?: readonly string[];
  /** true: an exec node (runs in the flow); false: a data node (evaluated where it is read). */
  exec: boolean;
  args: readonly BehaviorApiArg[];
  /** The call's result as an output (a data node needs one). */
  returns?: { id: string; label: string; type: BehaviorValueType; fallback: GraphValue };
}

export const BEHAVIOR_API_NODES: readonly BehaviorApiNodeSpec[] = [
  {
    type: 'api.game.add',
    label: 'Add to counter',
    category: 'Game',
    description: "Adds to one of the run's counters (coins, keys, anything you name); the HUD and score rules read them.",
    path: ['game', 'add'],
    optional: ['game'],
    exec: true,
    args: [
      { id: 'name', label: 'counter', type: 'string', default: '', required: true },
      { id: 'amount', label: 'amount', type: 'number', default: 1 },
    ],
  },
  {
    type: 'api.game.counter',
    label: 'Counter value',
    category: 'Game',
    description: "The current value of one of the run's counters (0 when it was never added to).",
    path: ['game', 'counter'],
    optional: ['game'],
    exec: false,
    args: [{ id: 'name', label: 'counter', type: 'string', default: '', required: true }],
    returns: { id: 'value', label: 'value', type: 'number', fallback: 0 },
  },
  {
    type: 'api.signals.emit',
    label: 'Emit signal',
    category: 'Signals',
    description: 'Sends a named signal; switches, doors and scripts see it in the next step.',
    path: ['signals', 'emit'],
    optional: ['signals'],
    exec: true,
    args: [{ id: 'name', label: 'signal', type: 'string', default: '', required: true }],
  },
  {
    type: 'api.signals.on',
    label: 'Signal received',
    category: 'Signals',
    description: 'True when the named signal was emitted in the previous step.',
    path: ['signals', 'on'],
    optional: ['signals'],
    exec: false,
    args: [{ id: 'name', label: 'signal', type: 'string', default: '', required: true }],
    returns: { id: 'on', label: 'received', type: 'boolean', fallback: false },
  },
];

// ---- the catalogue -----------------------------------------------------------------------------

const EXEC_IN: GraphPortDef = { id: 'in', label: '', type: 'exec', multi: true };
const execOut = (id: string, label: string): GraphPortDef => ({ id, label, type: 'exec', single: true });
const dataIn = (id: string, label: string, type: string): GraphPortDef => ({ id, label, type });
const dataOut = (id: string, label: string, type: string): GraphPortDef => ({ id, label, type });

/** The inline-value field of a data input (read when the input is not wired). */
function inlineField(id: string, label: string, type: BehaviorValueType, value: GraphValue): GraphFieldDef {
  if (type === 'number') return { key: id, label, type: 'number', default: value, min: -1e9, max: 1e9 };
  if (type === 'boolean') return { key: id, label, type: 'boolean', default: value };
  return { key: id, label, type: 'string', default: value, maxLength: 256 };
}

const VISIBILITY_FIELD: GraphFieldDef = { key: 'visibility', label: 'Visibility', type: 'enum', options: ['public', 'private'], default: 'public' };

/** A variable's declaration node, one type per value type (its default field has that type). */
function variableNode(t: BehaviorValueType): GraphNodeDef {
  const L = VALUE_TYPE_LABEL[t];
  return {
    type: `var.${t}`,
    label: `${L} variable`,
    category: 'Variables',
    description: `Declares a ${L.toLowerCase()} variable of each object carrying the script. Public: its start value is a property shown and set per object in the Inspector; private: it starts at the default.`,
    inputs: [],
    outputs: [],
    titleField: 'name',
    fields: [
      { key: 'name', label: 'Name', type: 'string', default: '', maxLength: 64 },
      inlineField('default', 'Default', t, VALUE_DEFAULT[t]),
      VISIBILITY_FIELD,
      { key: 'label', label: 'Label', type: 'string', default: '', maxLength: 64 },
      { key: 'group', label: 'Group', type: 'string', default: '', maxLength: 64 },
      { key: 'tooltip', label: 'Tooltip', type: 'string', default: '', maxLength: 256 },
    ],
  };
}

/**
 * The value port of Get/Set variable: typed by the named variable's value
 * type (`behaviorGraphContext`); `any` while the name declares nothing (the
 * compile check reports it), so renaming or deleting a variable never
 * strands its wires.
 */
const variablePort = (id: string, label: string): GraphPortDef => ({ id, label, type: 'any', typeFrom: { field: 'variable', lookup: 'variable' } });
const VARIABLE_NAME_FIELD: GraphFieldDef = { key: 'variable', label: 'Variable', type: 'string', default: '', maxLength: 64 };

const VARIABLE_ACCESS_NODES: readonly GraphNodeDef[] = [
  { type: 'var.get', label: 'Get variable', category: 'Variables', description: 'Reads a variable (its output takes the variable\'s type).', inputs: [], outputs: [variablePort('value', 'value')], titleField: 'variable', fields: [VARIABLE_NAME_FIELD] },
  {
    type: 'var.set',
    label: 'Set variable',
    category: 'Variables',
    description: 'Writes a variable (it keeps the value until the next write or a new run). Unwired, it writes "Value": a number, true/false or text for the variable\'s type (empty = 0, false or empty text).',
    inputs: [EXEC_IN, variablePort('value', 'value')],
    outputs: [execOut('then', ''), variablePort('value', 'value')],
    titleField: 'variable',
    fields: [VARIABLE_NAME_FIELD, { key: 'value', label: 'Value', type: 'string', default: '', maxLength: 256 }],
  },
];

function apiNodeDef(s: BehaviorApiNodeSpec): GraphNodeDef {
  return {
    type: s.type,
    label: s.label,
    category: s.category,
    description: s.description,
    inputs: [...(s.exec ? [EXEC_IN] : []), ...s.args.map((a) => dataIn(a.id, a.label, a.type))],
    outputs: [...(s.exec ? [execOut('then', '')] : []), ...(s.returns !== undefined ? [dataOut(s.returns.id, s.returns.label, s.returns.type)] : [])],
    fields: s.args.map((a) => inlineField(a.id, a.label, a.type, a.default)),
  };
}

const num = (id: string, label = id): GraphPortDef => dataIn(id, label, 'number');
const bool = (id: string, label = id): GraphPortDef => dataIn(id, label, 'boolean');
const numField = (id: string, v = 0): GraphFieldDef => inlineField(id, id, 'number', v);
const boolField = (id: string, v = false): GraphFieldDef => inlineField(id, id, 'boolean', v);
const binaryMath = (type: string, label: string, description: string): GraphNodeDef => ({
  type,
  label,
  category: 'Maths',
  description,
  inputs: [num('a'), num('b')],
  outputs: [dataOut('result', 'result', 'number')],
  fields: [numField('a'), numField('b')],
});
const binaryLogic = (type: string, label: string, description: string): GraphNodeDef => ({
  type,
  label,
  category: 'Logic',
  description,
  inputs: [bool('a'), bool('b')],
  outputs: [dataOut('result', 'result', 'boolean')],
  fields: [boolField('a'), boolField('b')],
});

/** The core nodes: events, flow, maths, logic and log. */
const CORE_NODES: readonly GraphNodeDef[] = [
  { type: 'event.start', label: 'On start', category: 'Events', description: 'Runs once when the script starts and again at the start of every run (a new game or a replay).', inputs: [], outputs: [execOut('then', '')] },
  { type: 'event.step', label: 'On step', category: 'Events', description: 'Runs every fixed simulation step (after the On start nodes of that step).', inputs: [], outputs: [execOut('then', ''), dataOut('step', 'step', 'number')] },
  { type: 'flow.branch', label: 'Branch', category: 'Flow', description: 'Continues on "true" or "false".', inputs: [EXEC_IN, bool('condition')], outputs: [execOut('true', 'true'), execOut('false', 'false')], fields: [boolField('condition')] },
  { type: 'flow.sequence', label: 'Sequence', category: 'Flow', description: 'Runs its outputs one after the other, top to bottom.', inputs: [EXEC_IN], outputs: [execOut('then1', 'then 1'), execOut('then2', 'then 2'), execOut('then3', 'then 3'), execOut('then4', 'then 4')] },
  {
    type: 'flow.for',
    label: 'For',
    category: 'Flow',
    description: `Runs "body" once per whole number from first to last (both included), then "completed". Bounded: a script may run ${BEHAVIOR_GRAPH_LIMITS.loopIterationsPerStep} loop iterations per step; more is a script error naming this node.`,
    inputs: [EXEC_IN, num('first'), num('last')],
    outputs: [execOut('body', 'body'), dataOut('index', 'index', 'number'), execOut('completed', 'completed')],
    // 0..0: one iteration until the designer sets the range (no genre-specific count).
    fields: [numField('first'), numField('last')],
  },
  binaryMath('math.add', 'Add', 'a + b'),
  binaryMath('math.subtract', 'Subtract', 'a − b'),
  binaryMath('math.multiply', 'Multiply', 'a × b'),
  binaryMath('math.divide', 'Divide', 'a ÷ b (0 when b is 0, so values stay finite)'),
  {
    type: 'math.compare',
    label: 'Compare',
    category: 'Maths',
    description: 'Compares two numbers.',
    inputs: [num('a'), num('b')],
    outputs: [dataOut('result', 'result', 'boolean')],
    fields: [numField('a'), numField('b'), { key: 'op', label: 'Test', type: 'enum', options: ['==', '!=', '<', '<=', '>', '>='], default: '==' }],
  },
  binaryLogic('logic.and', 'And', 'true when a and b are true'),
  binaryLogic('logic.or', 'Or', 'true when a or b is true'),
  { type: 'logic.not', label: 'Not', category: 'Logic', description: 'true when the value is false', inputs: [bool('value')], outputs: [dataOut('result', 'result', 'boolean')], fields: [boolField('value')] },
  {
    type: 'debug.log',
    label: 'Log',
    category: 'Debug',
    description: 'Writes a line to the play log.',
    inputs: [EXEC_IN, dataIn('message', 'message', 'string')],
    outputs: [execOut('then', '')],
    fields: [inlineField('message', 'message', 'string', ''), { key: 'level', label: 'Level', type: 'enum', options: ['info', 'warn', 'error'], default: 'info' }],
  },
];

export const BEHAVIOR_GRAPH_KIND: GraphKindDef = {
  kind: 'behavior',
  label: 'Visual script',
  portTypes: [
    { id: 'exec', label: 'exec', color: '#f4f4f4' },
    { id: 'number', label: 'number', color: '#7fb3ff' },
    { id: 'boolean', label: 'boolean', color: '#e67e9b' },
    { id: 'string', label: 'text', color: '#f2b544' },
    { id: 'any', label: 'any (no such variable)', color: '#9a9a9a' },
  ],
  conversions: [
    { from: 'number', to: 'string', label: 'number → text' },
    { from: 'boolean', to: 'string', label: 'boolean → text ("true"/"false")' },
    { from: 'boolean', to: 'number', label: 'boolean → number (0 or 1)' },
  ],
  // Only a Get/Set variable naming no variable has an `any` port (see variablePort).
  anyType: 'any',
  categories: ['Events', 'Flow', 'Variables', 'Maths', 'Logic', 'Game', 'Signals', 'Debug'],
  nodes: [...CORE_NODES, ...BEHAVIOR_VALUE_TYPES.map(variableNode), ...VARIABLE_ACCESS_NODES, ...BEHAVIOR_API_NODES.map(apiNodeDef)],
  allowCycles: false,
  maxNodes: BEHAVIOR_GRAPH_LIMITS.nodes,
  owner: 'behavior',
};

// ---- semantic checks (compile diagnostics) ---------------------------------------------------

export interface BehaviorGraphProblem {
  severity: 'error' | 'warning';
  /** The node the problem is on (absent: the whole graph). */
  nodeId?: string;
  message: string;
}

/** The value type a variable declaration node type declares (`var.number` → number), or null. */
export function variableTypeOf(nodeType: string): BehaviorValueType | null {
  const m = /^var\.(number|boolean|string)$/.exec(nodeType);
  return m === null ? null : (m[1] as BehaviorValueType);
}

/** A Get/Set variable node type (`var.get` / `var.set`). */
export const isVariableAccess = (nodeType: string): boolean => nodeType === 'var.get' || nodeType === 'var.set';

/**
 * The validation context of a behavior graph: the `variable` lookup types a
 * Get/Set variable's value port by the variable its `variable` field names
 * (the first declaration of that name in declaration order). Read from the
 * graph as it is (malformed nodes are skipped; validation reports them).
 */
export function behaviorGraphContext(graph: unknown): GraphContext {
  const nodes = typeof graph === 'object' && graph !== null && Array.isArray((graph as { nodes?: unknown }).nodes) ? ((graph as { nodes: unknown[] }).nodes) : [];
  const types = new Map<string, BehaviorValueType>();
  const decls = nodes
    .filter((n): n is GraphNode => typeof n === 'object' && n !== null && typeof (n as GraphNode).type === 'string' && variableTypeOf((n as GraphNode).type) !== null && Array.isArray((n as GraphNode).position))
    .sort((a, b) => a.position[1] - b.position[1] || a.position[0] - b.position[0] || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  for (const n of decls) {
    const name = n.data?.['name'];
    if (typeof name === 'string' && name !== '' && !types.has(name)) types.set(name, variableTypeOf(n.type)!);
  }
  return { lookup: (name, value) => (name === 'variable' ? (types.get(value) ?? null) : null) };
}

/** The value a Set variable's inline text means for a variable of type t, or an error. */
export function parseVariableValue(t: BehaviorValueType, text: string): { ok: true; value: GraphValue } | { ok: false; message: string } {
  if (t === 'string') return { ok: true, value: text };
  if (t === 'boolean') return text === '' || text === 'false' ? { ok: true, value: false } : text === 'true' ? { ok: true, value: true } : { ok: false, message: `"${text}" is not true or false` };
  if (text.trim() === '') return { ok: true, value: 0 };
  const v = Number(text);
  return Number.isFinite(v) ? { ok: true, value: v } : { ok: false, message: `"${text}" is not a number` };
}

function field(node: GraphNode, key: string, fallback: GraphValue): GraphValue {
  const v = node.data?.[key];
  return v === undefined ? fallback : v;
}

/** Variable declaration nodes in declaration order: top to bottom, then left to right, then id. */
export function variableNodesOf(graph: GraphData): GraphNode[] {
  return graph.nodes
    .filter((n) => variableTypeOf(n.type) !== null)
    .sort((a, b) => a.position[1] - b.position[1] || a.position[0] - b.position[0] || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

function isControlFree(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c <= 0x1f || c === 0x7f) return false;
  }
  return true;
}

/** "jump_height" → "Jump height" (the label of a variable without one). */
export function variableLabel(name: string): string {
  const words = name.replace(/_+/g, ' ').trim();
  return words.length === 0 ? name : words[0]!.toUpperCase() + words.slice(1);
}

/**
 * The declaration a graph's variables make: one declared property per
 * variable node (declaration order), public or private.
 */
export function behaviorGraphDeclaration(graph: GraphData): PropertyDeclaration {
  return {
    properties: variableNodesOf(graph).map((n) => {
      const t = variableTypeOf(n.type)!;
      const name = String(field(n, 'name', ''));
      const label = String(field(n, 'label', ''));
      const group = String(field(n, 'group', ''));
      const tooltip = String(field(n, 'tooltip', ''));
      const p: DeclaredProperty = { key: name, label: label !== '' ? label : variableLabel(name).slice(0, 64), type: VARIABLE_PROPERTY_TYPE[t], default: field(n, 'default', VALUE_DEFAULT[t]) as DeclaredProperty['default'] };
      if (field(n, 'visibility', 'public') === 'private') p.visibility = 'private';
      if (group !== '') p.group = group;
      if (tooltip !== '') p.tooltip = tooltip;
      return p;
    }),
  };
}

/**
 * The compile diagnostics of a structurally valid graph: variable names
 * (the property key syntax, unique, 1–32 variables — a behavior declares
 * 1–32 properties), get/set nodes naming a declared variable of their type,
 * text fields a property accepts, required text arguments that are neither
 * wired nor filled in; warnings for flow nodes no event reaches.
 */
export function checkBehaviorGraph(graph: GraphData): BehaviorGraphProblem[] {
  const out: BehaviorGraphProblem[] = [];
  const vars = variableNodesOf(graph);
  const declared = new Map<string, BehaviorValueType>();
  for (const n of vars) {
    const t = variableTypeOf(n.type)!;
    const name = String(field(n, 'name', ''));
    if (!BEHAVIOR_VARIABLE_NAME_RE.test(name)) {
      out.push({ severity: 'error', nodeId: n.id, message: `variable name "${name}" must start with a lower-case letter and use a-z, 0-9 and _ (at most 64)` });
      continue;
    }
    if (declared.has(name)) {
      out.push({ severity: 'error', nodeId: n.id, message: `a variable named "${name}" is already declared` });
      continue;
    }
    declared.set(name, t);
    for (const k of ['label', 'group', 'tooltip', 'default'] as const) {
      const v = field(n, k, '');
      if (typeof v === 'string' && !isControlFree(v)) out.push({ severity: 'error', nodeId: n.id, message: `${k} must not contain control characters` });
    }
  }
  if (vars.length === 0) out.push({ severity: 'error', message: 'declare at least one variable (a behavior has 1-32 properties)' });
  if (vars.length > BEHAVIOR_GRAPH_LIMITS.variables) out.push({ severity: 'error', nodeId: vars[BEHAVIOR_GRAPH_LIMITS.variables]!.id, message: `a script has at most ${BEHAVIOR_GRAPH_LIMITS.variables} variables` });

  const wired = new Set(graph.edges.map((e) => `${e.to.node}\u0000${e.to.port}`));
  for (const n of graph.nodes) {
    if (isVariableAccess(n.type)) {
      const name = String(field(n, 'variable', ''));
      const t = declared.get(name);
      if (name === '') out.push({ severity: 'error', nodeId: n.id, message: 'choose the variable this node reads or writes' });
      else if (t === undefined) out.push({ severity: 'error', nodeId: n.id, message: `no variable named "${name}" is declared` });
      else if (n.type === 'var.set' && !wired.has(`${n.id}\u0000value`)) {
        const parsed = parseVariableValue(t, String(field(n, 'value', '')));
        if (!parsed.ok) out.push({ severity: 'error', nodeId: n.id, message: `${parsed.message} (the value for ${VALUE_TYPE_LABEL[t].toLowerCase()} variable "${name}")` });
      }
    }
    const api = BEHAVIOR_API_NODES.find((s) => s.type === n.type);
    for (const a of api?.args ?? []) {
      if (a.required === true && !wired.has(`${n.id}\u0000${a.id}`) && String(field(n, a.id, a.default)) === '') {
        out.push({ severity: 'error', nodeId: n.id, message: `fill in the ${a.label} (or wire a text into it)` });
      }
    }
  }

  // An `any` port (a Get/Set naming no variable) must not join the exec flow.
  for (const e of graph.edges) {
    const fromExec = isExecPort(graph, e.from.node, e.from.port);
    const toNode = graph.nodes.find((x) => x.id === e.to.node);
    const toExec = toNode !== undefined && BEHAVIOR_GRAPH_KIND.nodes.find((d) => d.type === toNode.type)?.inputs.find((p) => p.id === e.to.port)?.type === 'exec';
    if (fromExec !== toExec) out.push({ severity: 'error', nodeId: fromExec ? e.to.node : e.from.node, message: 'an exec wire connects only exec ports' });
  }
  // Flow nodes no event reaches never run.
  const execNode = (n: GraphNode): boolean => BEHAVIOR_GRAPH_KIND.nodes.find((d) => d.type === n.type)?.inputs.some((p) => p.type === 'exec') === true;
  const reached = new Set<string>();
  const queue = graph.nodes.filter((n) => n.type.startsWith('event.')).map((n) => n.id);
  while (queue.length > 0) {
    const id = queue.pop()!;
    if (reached.has(id)) continue;
    reached.add(id);
    for (const e of graph.edges) if (e.from.node === id && isExecPort(graph, e.from.node, e.from.port)) queue.push(e.to.node);
  }
  for (const n of graph.nodes) {
    if (execNode(n) && !reached.has(n.id)) out.push({ severity: 'warning', nodeId: n.id, message: 'no event reaches this node: it never runs' });
  }
  return out;
}

function isExecPort(graph: GraphData, nodeId: string, portId: string): boolean {
  const n = graph.nodes.find((x) => x.id === nodeId);
  const d = n !== undefined ? BEHAVIOR_GRAPH_KIND.nodes.find((x) => x.type === n.type) : undefined;
  return d?.outputs.find((p) => p.id === portId)?.type === 'exec';
}
