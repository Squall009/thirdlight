/**
 * Phase 16.1: the generic node-graph model.
 *
 * Every graph in Thirdlight (animator state graphs, material graphs, visual
 * scripts, effect graphs) is the same data: nodes (id, type, position,
 * collapsed, per-node data), typed ports that come from the node type's
 * schema, edges between an output and an input port (with optional reroute
 * points), groups (titled, coloured frames) and comments. What differs per
 * graph is the **graph kind**: its node catalogue (types, categories, ports,
 * data fields), its port types with the compatibility table and implicit
 * conversions, and its rules (cycles allowed or not, a node budget, nodes a
 * graph must contain, the "sink" nodes every node should reach). Kinds are
 * plain data registered in `GRAPH_KINDS` (graph-kinds.ts), so the backend
 * validator, the command layer and the editor read the same table.
 *
 * This module is pure and total: structural validation (a refusal), the
 * canonical form and the edit-op application with its inverse (the backend's
 * commands and their undo/redo). The editor may import model types only
 * (dependencies.md §4.1): it advances its copy of a graph from the change
 * data with its own projection (editor/src/graph/model.ts, kept equal by
 * tests/graph-parity.test.ts) and gets the kinds from `queryGameConfig`.
 */
import type { ModelErrorV2 } from './errors';

// ---- data --------------------------------------------------------------------

export type GraphPoint = [number, number];
/** A node data value: a number, a string, a boolean or a short number vector. */
export type GraphValue = number | string | boolean | number[];

export interface GraphNode {
  id: string;
  /** The node type (an entry of the graph kind's catalogue). */
  type: string;
  /** Top-left corner in graph units. */
  position: GraphPoint;
  /** Drawn as its title bar only (edges attach to it). Absent = expanded. */
  collapsed?: true;
  /** Values of the node type's fields (absent keys use the field default). */
  data?: Record<string, GraphValue>;
}

export interface GraphPortRef {
  node: string;
  port: string;
}

export interface GraphEdge {
  id: string;
  /** An output port. */
  from: GraphPortRef;
  /** An input port. */
  to: GraphPortRef;
  /** Reroute points the wire passes through, in order (graph units). */
  reroutes?: GraphPoint[];
}

/** A titled, coloured frame; nodes inside its rectangle move with it in the editor. */
export interface GraphGroup {
  id: string;
  title: string;
  /** `#rrggbb`. */
  color: string;
  /** x, y, width, height in graph units. */
  rect: [number, number, number, number];
}

export interface GraphComment {
  id: string;
  text: string;
  position: GraphPoint;
  /** width, height in graph units (absent = sized to the text). */
  size?: [number, number];
}

export interface GraphData {
  nodes: GraphNode[];
  edges: GraphEdge[];
  groups?: GraphGroup[];
  comments?: GraphComment[];
}

// ---- graph kinds (data) ------------------------------------------------------------

export interface GraphPortType {
  id: string;
  label: string;
  /** Wire and port colour in the editor (`#rrggbb`). */
  color: string;
  /**
   * Phase 19.2: a control-flow type (e.g. a visual script's exec): its wires
   * say in which order things run, not which value moves, so the editor draws
   * them thicker with arrows along the direction of flow. Presentation only.
   */
  flow?: boolean;
}

/** An implicit conversion: an output of `from` may feed an input of `to`. */
export interface GraphConversion {
  from: string;
  to: string;
  /** Shown on the wire (e.g. "number → vector (all components)"). */
  label: string;
}

export interface GraphPortDef {
  id: string;
  label: string;
  /** A port type id of the kind, or the kind's `anyType`. */
  type: string;
  /** Input only: accepts several edges (outputs fan out unless `single`). */
  multi?: boolean;
  /**
   * Phase 16.2, output only: at most one edge leaves it (a new wire replaces
   * the old one) — e.g. a state machine's Entry names exactly one state.
   */
  single?: boolean;
  /** Input only: an unconnected required input is a diagnostic error. */
  required?: boolean;
  /**
   * Phase 18.1: the port's type comes from the node's data (a data-dependent
   * port); `type` is then the fallback when the rule gives nothing.
   */
  typeFrom?: GraphPortTypeRule;
  /**
   * Phase 18.1, input only: what an unconnected input reads — a number or a
   * vector is a constant; a string names a built-in source of the kind
   * (e.g. a material's `uv0`). Documentation for the kind's compiler and the
   * editor; the framework never refuses an unconnected defaulted input.
   */
  default?: GraphValue;
  /**
   * Phase 19.2: a repeated port — the port stands for as many ports as the
   * node field `field` says (see `repeatedPorts`), at most `max`: ids
   * `<id>1`, `<id>2`, … (1-based), so a port keeps its id (and wires) while
   * later ones are added or removed. E.g. a switch's cases.
   */
  repeat?: GraphPortRepeat;
}

/**
 * Phase 19.2: how many copies a repeated port has. A number field gives the
 * count (whole, clamped to 0..max; labels "<label> 1", "<label> 2", …); a
 * text field is a comma-separated list — one port per item (empty items
 * included, so "a,,b" keeps three ports), labelled with the item (or
 * "<label> n" for an empty one); items beyond `max` get no port.
 */
export interface GraphPortRepeat {
  field: string;
  max: number;
}

/** Phase 19.2: the items of a repeated port's text field (trimmed, comma separated; "" = none). */
export function repeatItems(value: string): string[] {
  return value.trim() === '' ? [] : value.split(',').map((x) => x.trim());
}

/**
 * Phase 19.2: the ports a repeated port stands for on a node (see
 * `GraphPortRepeat`); a port without `repeat` is itself. Shared by
 * validation, the compilers and (copied) the editor.
 */
export function repeatedPorts(def: GraphNodeDef, node: GraphNode, port: GraphPortDef): GraphPortDef[] {
  const rep = port.repeat;
  if (rep === undefined) return [port];
  const f = def.fields?.find((x) => x.key === rep.field);
  const v = f !== undefined ? nodeFieldValue(node, f) : 0;
  const { repeat: _r, ...base } = port;
  void _r;
  const out: GraphPortDef[] = [];
  if (typeof v === 'number') {
    const n = Number.isFinite(v) ? Math.max(0, Math.min(rep.max, Math.trunc(v))) : 0;
    for (let i = 1; i <= n; i++) out.push({ ...base, id: `${port.id}${i}`, label: `${port.label} ${i}`.trim() });
  } else if (typeof v === 'string') {
    repeatItems(v)
      .slice(0, rep.max)
      .forEach((item, i) => out.push({ ...base, id: `${port.id}${i + 1}`, label: item !== '' ? item : `${port.label} ${i + 1}`.trim() }));
  }
  return out;
}

/**
 * Phase 18.1: how a data-dependent port gets its type from a node field. In
 * order: `lookup` (the value names an external declaration the context
 * types, e.g. a material parameter), `map`, `byLength` (the value's length,
 * e.g. a swizzle mask "xy" → the 2nd entry), the value `auto` (the widest
 * type among the wires into the node's ports that share this field, in the
 * order of the field's options; none → the first option after `auto`), else
 * the value itself is the type.
 */
export interface GraphPortTypeRule {
  field: string;
  lookup?: string;
  map?: Readonly<Record<string, string>>;
  byLength?: readonly string[];
}

/** Phase 18.1: the value of a type field that asks for the widest connected type. */
export const GRAPH_AUTO_TYPE = 'auto';

export interface GraphFieldDef {
  key: string;
  label: string;
  /** Phase 18.1: `color` is a `#rrggbb` string (lower case). */
  type: 'number' | 'string' | 'boolean' | 'enum' | 'vector' | 'color';
  default: GraphValue;
  min?: number;
  max?: number;
  /** `enum`: the allowed values. */
  options?: readonly string[];
  /** `vector`: the component count (2–4). */
  size?: number;
  /** `string`: the longest value (default 256). */
  maxLength?: number;
  /** Phase 18.1, `string`: the whole value matches this regular expression (source text). */
  pattern?: string;
  /** Phase 18.1, `string`: the value names an asset of this kind (e.g. `texture`); "" = none. Checked against the project's assets. */
  asset?: string;
}

export interface GraphNodeDef {
  type: string;
  label: string;
  category: string;
  description?: string;
  inputs: readonly GraphPortDef[];
  outputs: readonly GraphPortDef[];
  fields?: readonly GraphFieldDef[];
  /** At most this many nodes of the type in one graph (a refusal beyond). */
  max?: number;
  /** A graph without one is a diagnostic error. */
  required?: boolean;
  /**
   * Phase 16.2: part of every graph of the kind, exactly once (a refusal
   * otherwise): not in the catalogue, not copied, not deleted — e.g. a state
   * machine's Entry and Any State.
   */
  fixed?: boolean;
  /** Phase 16.2: the field whose (non-empty) value is the node's title instead of the type label. */
  titleField?: string;
  /**
   * Phase 18.1: at most one node among the types sharing this tag (a
   * refusal beyond) — e.g. a material's PBR and Unlit outputs. A `required`
   * type is satisfied by any node of its tag.
   */
  exclusive?: string;
  /**
   * Phase 18.1: the node's ports are the interface of another graph — the
   * standalone graph of kind `kind` whose id is the value of `field` (a
   * sub-graph call). Resolved through the validation context.
   */
  portsFrom?: { field: string; kind: string };
}

/**
 * Phase 18.1: a graph kind whose graphs can be called (sub-graphs): the
 * nodes of type `input` become the caller's input ports and those of type
 * `output` its output ports, ordered by position (top to bottom, then left
 * to right). A port's id is the interface node's id (so renaming keeps the
 * callers' wires), its label the `labelField` value (or the id) and its type
 * the `typeField` value.
 */
export interface GraphInterfaceDef {
  input: string;
  output: string;
  labelField: string;
  typeField: string;
}

/** Phase 18.1: what validation and port resolution may read outside the graph. */
export interface GraphContext {
  /** A standalone graph of `kind` by id (sub-graph calls), or null. */
  graph?: (kind: string, id: string) => { kind: GraphKindDef; graph: GraphData } | null;
  /** The port type of an external declaration (`GraphPortTypeRule.lookup`), or null. */
  lookup?: (name: string, value: string) => string | null;
}

export interface GraphKindDef {
  kind: string;
  label: string;
  portTypes: readonly GraphPortType[];
  conversions: readonly GraphConversion[];
  /** A wildcard port type that connects to every type (absent = none). */
  anyType?: string;
  /** Catalogue categories, in menu order. */
  categories: readonly string[];
  nodes: readonly GraphNodeDef[];
  /** false: an edit that closes a cycle is refused. */
  allowCycles: boolean;
  /** The node budget of one graph (a refusal beyond). */
  maxNodes: number;
  /** Node types that are the graph's results; a node reaching none gets a warning. */
  sinks?: readonly string[];
  /**
   * Phase 16.2: the owner kind whose documents hold graphs of this kind
   * (e.g. `animator`); absent = standalone graphs (`content.graphs`). A kind
   * with an owner cannot be a standalone graph.
   */
  owner?: string;
  /** Phase 18.1: graphs of this kind can be called from other graphs (sub-graphs). */
  interface?: GraphInterfaceDef;
}

// ---- limits ------------------------------------------------------------------------

/** Engine limits that protect the editor and the backend (not tuning values). */
export const GRAPH_LIMITS = {
  /** Upper bound of any kind's node budget. */
  nodes: 4096,
  /** Edges per graph, relative to its node budget. */
  edgesPerNode: 4,
  groups: 256,
  comments: 256,
  reroutesPerEdge: 16,
  titleLength: 64,
  commentLength: 2000,
  /** |x|, |y| of any position (graph units). */
  coordinate: 1_000_000,
  /** Largest group / comment side. */
  size: 100_000,
  /** Ops in one graph edit. */
  ops: 512,
} as const;

/** 1-64 characters (64: the longest state/controller id, so an owner's ids can be graph ids). */
export const GRAPH_ITEM_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const COLOR_RE = /^#[0-9a-f]{6}$/;
const patternCache = new Map<string, RegExp>();
function patternOf(src: string): RegExp {
  let re = patternCache.get(src);
  if (re === undefined) {
    re = new RegExp(`^(?:${src})$`);
    patternCache.set(src, re);
  }
  return re;
}

// ---- small helpers -----------------------------------------------------------------

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
function err(errors: ModelErrorV2[], code: string, path: string, message: string, found?: unknown, expected?: string): void {
  errors.push({ code, path, message, ...(found !== undefined ? { found } : {}), ...(expected !== undefined ? { expected } : {}) } as ModelErrorV2);
}
function onlyKeys(v: Record<string, unknown>, keys: readonly string[], path: string, errors: ModelErrorV2[]): void {
  for (const k of Object.keys(v)) if (!keys.includes(k)) err(errors, 'field_unexpected', `${path}/${k}`, `unexpected field "${k}"`, k, keys.join(', '));
}
const finite = (v: unknown, bound: number): v is number => typeof v === 'number' && Number.isFinite(v) && Math.abs(v) <= bound;
function point(v: unknown): v is GraphPoint {
  return Array.isArray(v) && v.length === 2 && finite(v[0], GRAPH_LIMITS.coordinate) && finite(v[1], GRAPH_LIMITS.coordinate);
}
const byId = <T extends { id: string }>(a: T, b: T): number => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

export function nodeDef(kind: GraphKindDef, type: string): GraphNodeDef | undefined {
  return kind.nodes.find((n) => n.type === type);
}

/**
 * Can an output of type `from` feed an input of type `to`? `same` (or a
 * wildcard), a conversion (its label is shown on the wire), or null.
 */
export function portCompatibility(kind: GraphKindDef, from: string, to: string): { ok: true; conversion: GraphConversion | null } | null {
  if (from === to || (kind.anyType !== undefined && (from === kind.anyType || to === kind.anyType))) return { ok: true, conversion: null };
  const c = kind.conversions.find((x) => x.from === from && x.to === to);
  return c !== undefined ? { ok: true, conversion: c } : null;
}

/** The node's ports (from its type's schema); empty for an unknown type. */
export function nodePorts(kind: GraphKindDef, type: string): { inputs: readonly GraphPortDef[]; outputs: readonly GraphPortDef[] } {
  const d = nodeDef(kind, type);
  return d === undefined ? { inputs: [], outputs: [] } : { inputs: d.inputs, outputs: d.outputs };
}

/** A field's value on a node (the stored value or the field default). */
export function nodeFieldValue(node: GraphNode, field: GraphFieldDef): GraphValue {
  const v = node.data?.[field.key];
  return v === undefined ? field.default : v;
}

// ---- phase 18.1: data-dependent ports ----------------------------------------------------

export interface GraphNodePorts {
  inputs: readonly GraphPortDef[];
  outputs: readonly GraphPortDef[];
}
const NO_PORTS: GraphNodePorts = { inputs: [], outputs: [] };

const byPosition = (a: GraphNode, b: GraphNode): number => a.position[1] - b.position[1] || a.position[0] - b.position[0] || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/**
 * The interface of a callable graph (`GraphKindDef.interface`): its input
 * nodes as input ports and its output nodes as output ports.
 */
export function graphInterface(kind: GraphKindDef, graph: GraphData): GraphNodePorts {
  const itf = kind.interface;
  if (itf === undefined) return NO_PORTS;
  const side = (type: string): GraphPortDef[] => {
    const def = nodeDef(kind, type);
    const field = (key: string): GraphFieldDef | undefined => def?.fields?.find((f) => f.key === key);
    const lf = field(itf.labelField);
    const tf = field(itf.typeField);
    return graph.nodes
      .filter((n) => n.type === type)
      .sort(byPosition)
      .map((n) => {
        const label = lf !== undefined ? nodeFieldValue(n, lf) : '';
        const t = tf !== undefined ? nodeFieldValue(n, tf) : '';
        return { id: n.id, label: typeof label === 'string' && label !== '' ? label : n.id, type: String(t) };
      });
  };
  return { inputs: side(itf.input), outputs: side(itf.output) };
}

type Declared = { type: string } | { auto: string };
type Slot = GraphPortDef | { port: GraphPortDef; auto: string };

function declaredType(kind: GraphKindDef, def: GraphNodeDef, node: GraphNode, port: GraphPortDef, ctx: GraphContext | undefined): Declared {
  const rule = port.typeFrom;
  if (rule === undefined) return { type: port.type };
  const f = def.fields?.find((x) => x.key === rule.field);
  if (f === undefined) return { type: port.type };
  const v = nodeFieldValue(node, f);
  const s = typeof v === 'string' ? v : String(v);
  if (rule.lookup !== undefined) return { type: ctx?.lookup?.(rule.lookup, s) ?? port.type };
  if (rule.map !== undefined && Object.prototype.hasOwnProperty.call(rule.map, s)) return { type: rule.map[s]! };
  if (rule.byLength !== undefined) return { type: rule.byLength[s.length - 1] ?? port.type };
  if (s === GRAPH_AUTO_TYPE) return { auto: rule.field };
  return { type: kind.portTypes.some((t) => t.id === s) ? s : port.type };
}

/** The options of a type field (for `auto` widening). */
function typeOptions(def: GraphNodeDef, field: string): readonly string[] {
  return def.fields?.find((f) => f.key === field)?.options ?? [];
}

/**
 * Every node's ports with their types resolved (phase 18.1): static ports,
 * a sub-graph call's interface (`portsFrom`), types from node data
 * (`typeFrom`) and `auto` types from the wires. Nodes of unknown types have
 * no ports; malformed edges are ignored (validation reports them).
 */
export function resolveGraphPorts(kind: GraphKindDef, graph: { nodes: readonly GraphNode[]; edges: readonly GraphEdge[] }, ctx?: GraphContext): Map<string, GraphNodePorts> {
  const out = new Map<string, GraphNodePorts>();
  const pending = new Map<string, { def: GraphNodeDef; inputs: Slot[]; outputs: Slot[] }>();
  for (const node of graph.nodes) {
    const def = nodeDef(kind, node.type);
    if (def === undefined) continue;
    // Phase 19.2: repeated ports first (their copies are ordinary ports).
    let inputs: readonly GraphPortDef[] = def.inputs.some((p) => p.repeat !== undefined) ? def.inputs.flatMap((p) => repeatedPorts(def, node, p)) : def.inputs;
    let outputs: readonly GraphPortDef[] = def.outputs.some((p) => p.repeat !== undefined) ? def.outputs.flatMap((p) => repeatedPorts(def, node, p)) : def.outputs;
    const pf = def.portsFrom;
    if (pf !== undefined) {
      const f = def.fields?.find((x) => x.key === pf.field);
      const ref = f !== undefined ? nodeFieldValue(node, f) : '';
      const target = typeof ref === 'string' && ref !== '' ? (ctx?.graph?.(pf.kind, ref) ?? null) : null;
      const itf = target !== null ? graphInterface(target.kind, target.graph) : NO_PORTS;
      inputs = [...inputs, ...itf.inputs];
      outputs = [...outputs, ...itf.outputs];
    }
    let hasAuto = false;
    const map = (p: GraphPortDef): Slot => {
      const d = declaredType(kind, def, node, p, ctx);
      if ('auto' in d) {
        hasAuto = true;
        return { port: p, auto: d.auto };
      }
      return d.type === p.type ? p : { ...p, type: d.type };
    };
    const ins = inputs.map(map);
    const outs = outputs.map(map);
    if (hasAuto) pending.set(node.id, { def, inputs: ins, outputs: outs });
    else out.set(node.id, { inputs: ins as GraphPortDef[], outputs: outs as GraphPortDef[] });
  }
  if (pending.size === 0) return out;
  const incoming = new Map<string, GraphEdge[]>();
  for (const e of graph.edges) {
    if (!isPlainObject(e) || !isPlainObject(e.to) || !isPlainObject(e.from) || typeof e.to.node !== 'string' || typeof e.from.node !== 'string') continue;
    const l = incoming.get(e.to.node) ?? [];
    l.push(e);
    incoming.set(e.to.node, l);
  }
  const visiting = new Set<string>();
  const resolve = (id: string): GraphNodePorts | undefined => {
    const done = out.get(id);
    if (done !== undefined) return done;
    const p = pending.get(id);
    if (p === undefined || visiting.has(id)) return undefined;
    visiting.add(id);
    const widest = new Map<string, number>();
    for (const e of incoming.get(id) ?? []) {
      const slot = p.inputs.find((x) => ('auto' in x ? x.port.id : x.id) === e.to.port);
      if (slot === undefined || !('auto' in slot)) continue;
      // A wire from a node still being resolved (a cycle) does not widen.
      const src = resolve(e.from.node)?.outputs.find((x) => x.id === e.from.port);
      if (src === undefined) continue;
      const i = typeOptions(p.def, slot.auto).indexOf(src.type);
      if (i >= 0 && src.type !== GRAPH_AUTO_TYPE && i > (widest.get(slot.auto) ?? -1)) widest.set(slot.auto, i);
    }
    const fix = (x: Slot): GraphPortDef => {
      if (!('auto' in x)) return x;
      const opts = typeOptions(p.def, x.auto);
      const i = widest.get(x.auto);
      return { ...x.port, type: i !== undefined ? opts[i]! : (opts.find((o) => o !== GRAPH_AUTO_TYPE) ?? x.port.type) };
    };
    const r = { inputs: p.inputs.map(fix), outputs: p.outputs.map(fix) };
    visiting.delete(id);
    out.set(id, r);
    return r;
  };
  for (const id of pending.keys()) resolve(id);
  return out;
}

/**
 * Phase 18.1: the asset references in a graph's node data (fields with an
 * `asset` kind and a non-empty value), with their paths relative to the graph.
 */
export function graphAssetRefs(kind: GraphKindDef, graph: GraphData): { path: string; asset: string; id: string }[] {
  const out: { path: string; asset: string; id: string }[] = [];
  graph.nodes.forEach((n, i) => {
    for (const f of nodeDef(kind, n.type)?.fields ?? []) {
      const v = n.data?.[f.key];
      if (f.asset !== undefined && typeof v === 'string' && v !== '') out.push({ path: `/nodes/${i}/data/${f.key}`, asset: f.asset, id: v });
    }
  });
  return out;
}

/** One node's ports without wires (e.g. a node about to be added; `auto` types take their fallback). */
export function staticNodePorts(kind: GraphKindDef, node: GraphNode, ctx?: GraphContext): GraphNodePorts {
  return resolveGraphPorts(kind, { nodes: [node], edges: [] }, ctx).get(node.id) ?? NO_PORTS;
}

function fieldValueError(f: GraphFieldDef, v: unknown): string | null {
  switch (f.type) {
    case 'number':
      if (typeof v !== 'number' || !Number.isFinite(v)) return 'a number';
      if ((f.min !== undefined && v < f.min) || (f.max !== undefined && v > f.max)) return `a number ${f.min ?? '-∞'}–${f.max ?? '∞'}`;
      return null;
    case 'string':
      if (typeof v !== 'string' || v.length > (f.maxLength ?? 256)) return `a string of at most ${f.maxLength ?? 256} characters`;
      if (f.pattern !== undefined && !(f.asset !== undefined && v === '') && !patternOf(f.pattern).test(v)) return `text matching ${f.pattern}`;
      return null;
    case 'color':
      return typeof v === 'string' && COLOR_RE.test(v) ? null : 'a colour #rrggbb (lower case)';
    case 'boolean':
      return typeof v === 'boolean' ? null : 'true or false';
    case 'enum':
      return typeof v === 'string' && (f.options ?? []).includes(v) ? null : `one of ${(f.options ?? []).join(', ')}`;
    case 'vector': {
      const n = f.size ?? 3;
      if (!Array.isArray(v) || v.length !== n || !v.every((x) => finite(x, 1e9))) return `${n} numbers`;
      if (v.some((x) => (f.min !== undefined && (x as number) < f.min) || (f.max !== undefined && (x as number) > f.max))) return `${n} numbers ${f.min ?? '-∞'}–${f.max ?? '∞'}`;
      return null;
    }
  }
}

// ---- structural validation (refusals) --------------------------------------------------

/**
 * Validate a graph against its kind. Errors are refusals: malformed items,
 * duplicate ids, unknown node types, fields or ports, an edge between
 * incompatible types, a second edge into a single input, a cycle in a kind
 * that forbids them, or a budget exceeded.
 */
export function validateGraphData(kind: GraphKindDef, value: unknown, path: string, errors: ModelErrorV2[], ctx?: GraphContext): void {
  if (!isPlainObject(value)) return err(errors, 'field_type', path, 'a graph is { nodes, edges, groups?, comments? }', value);
  onlyKeys(value, ['nodes', 'edges', 'groups', 'comments'], path, errors);
  const ids = new Set<string>();
  const claim = (id: unknown, p: string): boolean => {
    if (typeof id !== 'string' || !GRAPH_ITEM_ID_RE.test(id)) {
      err(errors, 'field_value', p, 'an item id is 1-64 letters, digits, _ or -', id);
      return false;
    }
    if (ids.has(id)) {
      err(errors, 'id_duplicate', p, 'ids are unique across the nodes, edges, groups and comments of a graph', id);
      return false;
    }
    ids.add(id);
    return true;
  };

  const nodes = value['nodes'];
  const maxNodes = Math.min(kind.maxNodes, GRAPH_LIMITS.nodes);
  const nodeTypes = new Map<string, GraphNodeDef>();
  const goodNodes: GraphNode[] = [];
  if (!Array.isArray(nodes)) err(errors, 'field_type', `${path}/nodes`, 'nodes is a list', nodes);
  else {
    if (nodes.length > maxNodes) err(errors, 'limits_exceeded', `${path}/nodes`, `a ${kind.label} has at most ${maxNodes} nodes`, nodes.length, `at most ${maxNodes}`);
    const counts = new Map<string, number>();
    nodes.forEach((n, i) => {
      const p = `${path}/nodes/${i}`;
      if (!isPlainObject(n)) return err(errors, 'field_type', p, 'a node is { id, type, position, collapsed?, data? }', n);
      onlyKeys(n, ['id', 'type', 'position', 'collapsed', 'data'], p, errors);
      const idOk = claim(n['id'], `${p}/id`);
      const def = typeof n['type'] === 'string' ? nodeDef(kind, n['type']) : undefined;
      if (def === undefined) err(errors, 'reference_missing', `${p}/type`, `not a node type of the ${kind.label} catalogue`, n['type']);
      else {
        if (idOk) {
          nodeTypes.set(n['id'] as string, def);
          if (point(n['position'])) goodNodes.push({ id: n['id'] as string, type: def.type, position: n['position'], ...(isPlainObject(n['data']) ? { data: n['data'] as Record<string, GraphValue> } : {}) });
        }
        const c = (counts.get(def.type) ?? 0) + 1;
        counts.set(def.type, c);
        if (def.max !== undefined && c === def.max + 1) err(errors, 'limits_exceeded', `${p}/type`, `a ${kind.label} has at most ${def.max} "${def.label}" node${def.max === 1 ? '' : 's'}`, def.type);
      }
      if (!point(n['position'])) err(errors, 'field_value', `${p}/position`, 'a position is [x, y] (finite, within ±1e6)', n['position']);
      if (n['collapsed'] !== undefined && n['collapsed'] !== true) err(errors, 'field_value', `${p}/collapsed`, 'collapsed is true or absent', n['collapsed']);
      const data = n['data'];
      if (data !== undefined) {
        if (!isPlainObject(data)) err(errors, 'field_type', `${p}/data`, 'data maps field keys to values', data);
        else if (def !== undefined) {
          for (const [k, v] of Object.entries(data)) {
            const f = (def.fields ?? []).find((x) => x.key === k);
            if (f === undefined) {
              err(errors, 'field_unexpected', `${p}/data/${k}`, `"${def.label}" has no field "${k}"`, k, (def.fields ?? []).map((x) => x.key).join(', '));
              continue;
            }
            const bad = fieldValueError(f, v);
            if (bad !== null) err(errors, 'field_value', `${p}/data/${k}`, `${f.label} is ${bad}`, v, bad);
          }
        }
      }
    });
    // Phase 18.1: at most one node per exclusive tag.
    const tags = new Map<string, number>();
    for (const def of kind.nodes) if (def.exclusive !== undefined) tags.set(def.exclusive, (tags.get(def.exclusive) ?? 0) + (counts.get(def.type) ?? 0));
    for (const [tag, c] of tags) {
      if (c > 1) err(errors, 'limits_exceeded', `${path}/nodes`, `a ${kind.label} has at most one of ${kind.nodes.filter((d) => d.exclusive === tag).map((d) => `"${d.label}"`).join(', ')}`, c, 'at most 1');
    }
    // Phase 18.1: a sub-graph call names an existing graph of its kind.
    goodNodes.forEach((n) => {
      const def = nodeTypes.get(n.id)!;
      const pf = def.portsFrom;
      if (pf === undefined) return;
      const ref = n.data?.[pf.field];
      const i = (nodes as unknown[]).findIndex((x) => isPlainObject(x) && x['id'] === n.id);
      if (typeof ref !== 'string' || ref === '' || (ctx?.graph?.(pf.kind, ref) ?? null) === null) {
        err(errors, 'reference_missing', `${path}/nodes/${i}/data/${pf.field}`, `"${def.label}" names no ${pf.kind} graph of this project`, ref ?? '', `the id of a ${pf.kind} graph`);
      }
    });
    for (const def of kind.nodes) {
      if (def.fixed === true && (counts.get(def.type) ?? 0) !== 1) err(errors, 'field_value', `${path}/nodes`, `every ${kind.label} has exactly one "${def.label}" node (it cannot be added or removed)`, counts.get(def.type) ?? 0, '1');
    }
  }

  const edges = value['edges'];
  const maxEdges = maxNodes * GRAPH_LIMITS.edgesPerNode;
  const adjacency = new Map<string, string[]>();
  if (!Array.isArray(edges)) err(errors, 'field_type', `${path}/edges`, 'edges is a list', edges);
  else {
    if (edges.length > maxEdges) err(errors, 'limits_exceeded', `${path}/edges`, `a ${kind.label} has at most ${maxEdges} edges`, edges.length, `at most ${maxEdges}`);
    // Phase 18.1: ports come from the node type, a call's sub-graph and the node data.
    const wellFormed = (edges as unknown[]).filter((e): e is GraphEdge => isPlainObject(e) && isPlainObject(e['from']) && isPlainObject(e['to']) && typeof e['from']['node'] === 'string' && typeof e['from']['port'] === 'string' && typeof e['to']['node'] === 'string' && typeof e['to']['port'] === 'string');
    const resolved = resolveGraphPorts(kind, { nodes: goodNodes, edges: wellFormed }, ctx);
    const intoSingle = new Set<string>();
    const fromSingle = new Set<string>();
    const pairs = new Set<string>();
    edges.forEach((e, i) => {
      const p = `${path}/edges/${i}`;
      if (!isPlainObject(e)) return err(errors, 'field_type', p, 'an edge is { id, from: {node, port}, to: {node, port}, reroutes? }', e);
      onlyKeys(e, ['id', 'from', 'to', 'reroutes'], p, errors);
      claim(e['id'], `${p}/id`);
      const ends: [GraphPortDef | undefined, GraphPortDef | undefined] = [undefined, undefined];
      (['from', 'to'] as const).forEach((end, j) => {
        const r = e[end];
        if (!isPlainObject(r) || typeof r['node'] !== 'string' || typeof r['port'] !== 'string' || Object.keys(r).length !== 2) {
          return err(errors, 'field_type', `${p}/${end}`, `${end} is { node, port }`, r);
        }
        const def = nodeTypes.get(r['node']);
        if (def === undefined) return err(errors, 'reference_missing', `${p}/${end}/node`, 'the edge names no node of this graph', r['node']);
        const ports = resolved.get(r['node']) ?? NO_PORTS;
        const port = (end === 'from' ? ports.outputs : ports.inputs).find((x) => x.id === r['port']);
        if (port === undefined) return err(errors, 'reference_missing', `${p}/${end}/port`, `"${def.label}" has no ${end === 'from' ? 'output' : 'input'} "${String(r['port'])}"`, r['port']);
        ends[j] = port;
      });
      const [out, inp] = ends;
      if (out !== undefined && inp !== undefined) {
        const from = e['from'] as GraphPortRef;
        const to = e['to'] as GraphPortRef;
        if (portCompatibility(kind, out.type, inp.type) === null) {
          err(errors, 'field_value', `${p}/to`, `a ${typeLabel(kind, out.type)} output cannot feed a ${typeLabel(kind, inp.type)} input`, `${out.type} → ${inp.type}`);
        }
        const key = `${to.node}\u0000${to.port}`;
        if (inp.multi !== true) {
          if (intoSingle.has(key)) err(errors, 'field_value', `${p}/to`, `input "${inp.label}" takes one connection`, to.node);
          intoSingle.add(key);
        }
        if (out.single === true) {
          const fromKey = `${from.node}\u0000${from.port}`;
          if (fromSingle.has(fromKey)) err(errors, 'field_value', `${p}/from`, `output "${out.label}" takes one connection`, from.node);
          fromSingle.add(fromKey);
        }
        const pair = `${from.node}\u0000${from.port}\u0000${key}`;
        if (pairs.has(pair)) err(errors, 'id_duplicate', p, 'these two ports are already connected', e['id']);
        pairs.add(pair);
        if (from.node === to.node && !kind.allowCycles) err(errors, 'field_value', p, 'a node cannot feed itself in this graph', from.node);
        const list = adjacency.get(from.node) ?? [];
        list.push(to.node);
        adjacency.set(from.node, list);
      }
      const rr = e['reroutes'];
      if (rr !== undefined && (!Array.isArray(rr) || rr.length === 0 || rr.length > GRAPH_LIMITS.reroutesPerEdge || !rr.every(point))) {
        err(errors, 'field_value', `${p}/reroutes`, `reroutes is a list of 1-${GRAPH_LIMITS.reroutesPerEdge} [x, y] points`, rr);
      }
    });
    if (!kind.allowCycles) {
      const cyc = findCycle(adjacency);
      if (cyc !== null) err(errors, 'hierarchy_cycle', `${path}/edges`, `this ${kind.label} cannot have a cycle (${cyc.join(' → ')})`, cyc[0]);
    }
  }

  const groups = value['groups'];
  if (groups !== undefined) {
    if (!Array.isArray(groups) || groups.length > GRAPH_LIMITS.groups) err(errors, 'field_value', `${path}/groups`, `groups is a list of at most ${GRAPH_LIMITS.groups}`, groups);
    else
      groups.forEach((g, i) => {
        const p = `${path}/groups/${i}`;
        if (!isPlainObject(g)) return err(errors, 'field_type', p, 'a group is { id, title, color, rect }', g);
        onlyKeys(g, ['id', 'title', 'color', 'rect'], p, errors);
        claim(g['id'], `${p}/id`);
        if (typeof g['title'] !== 'string' || g['title'].length > GRAPH_LIMITS.titleLength) err(errors, 'field_value', `${p}/title`, `a title is at most ${GRAPH_LIMITS.titleLength} characters`, g['title']);
        if (typeof g['color'] !== 'string' || !COLOR_RE.test(g['color'])) err(errors, 'field_value', `${p}/color`, 'a colour is #rrggbb (lower case)', g['color']);
        const r = g['rect'];
        if (!Array.isArray(r) || r.length !== 4 || !finite(r[0], GRAPH_LIMITS.coordinate) || !finite(r[1], GRAPH_LIMITS.coordinate) || !finite(r[2], GRAPH_LIMITS.size) || !finite(r[3], GRAPH_LIMITS.size) || (r[2] as number) < 1 || (r[3] as number) < 1) {
          err(errors, 'field_value', `${p}/rect`, 'rect is [x, y, width, height] (width and height at least 1)', r);
        }
      });
  }

  const comments = value['comments'];
  if (comments !== undefined) {
    if (!Array.isArray(comments) || comments.length > GRAPH_LIMITS.comments) err(errors, 'field_value', `${path}/comments`, `comments is a list of at most ${GRAPH_LIMITS.comments}`, comments);
    else
      comments.forEach((c, i) => {
        const p = `${path}/comments/${i}`;
        if (!isPlainObject(c)) return err(errors, 'field_type', p, 'a comment is { id, text, position, size? }', c);
        onlyKeys(c, ['id', 'text', 'position', 'size'], p, errors);
        claim(c['id'], `${p}/id`);
        if (typeof c['text'] !== 'string' || c['text'].length > GRAPH_LIMITS.commentLength) err(errors, 'field_value', `${p}/text`, `a comment is at most ${GRAPH_LIMITS.commentLength} characters`, c['text']);
        if (!point(c['position'])) err(errors, 'field_value', `${p}/position`, 'a position is [x, y]', c['position']);
        const s = c['size'];
        if (s !== undefined && (!Array.isArray(s) || s.length !== 2 || !finite(s[0], GRAPH_LIMITS.size) || !finite(s[1], GRAPH_LIMITS.size) || (s[0] as number) < 1 || (s[1] as number) < 1)) {
          err(errors, 'field_value', `${p}/size`, 'size is [width, height] (at least 1)', s);
        }
      });
  }
}

function typeLabel(kind: GraphKindDef, id: string): string {
  return kind.portTypes.find((t) => t.id === id)?.label ?? id;
}

/** A cycle through the adjacency (node ids in order), or null. Iterative DFS. */
export function findCycle(adjacency: ReadonlyMap<string, readonly string[]>): string[] | null {
  const state = new Map<string, 1 | 2>();
  for (const start of adjacency.keys()) {
    if (state.has(start)) continue;
    const stack: { id: string; i: number }[] = [{ id: start, i: 0 }];
    const onPath: string[] = [start];
    state.set(start, 1);
    while (stack.length > 0) {
      const top = stack[stack.length - 1]!;
      const next = adjacency.get(top.id) ?? [];
      if (top.i < next.length) {
        const to = next[top.i++]!;
        const s = state.get(to);
        if (s === 1) return [...onPath.slice(onPath.indexOf(to)), to];
        if (s === undefined) {
          state.set(to, 1);
          stack.push({ id: to, i: 0 });
          onPath.push(to);
        }
      } else {
        state.set(top.id, 2);
        stack.pop();
        onPath.pop();
      }
    }
  }
  return null;
}

/** Would connecting `from` → `to` close a cycle in the graph? (the editor's live check) */
export function wouldCycle(graph: GraphData, fromNode: string, toNode: string): boolean {
  if (fromNode === toNode) return true;
  const adj = new Map<string, string[]>();
  for (const e of graph.edges) {
    const l = adj.get(e.from.node) ?? [];
    l.push(e.to.node);
    adj.set(e.from.node, l);
  }
  // Is `fromNode` reachable from `toNode`?
  const seen = new Set<string>([toNode]);
  const queue = [toNode];
  while (queue.length > 0) {
    const n = queue.pop()!;
    for (const m of adj.get(n) ?? []) {
      if (m === fromNode) return true;
      if (!seen.has(m)) {
        seen.add(m);
        queue.push(m);
      }
    }
  }
  return false;
}

// ---- canonical form ----------------------------------------------------------------------

/**
 * A port reference copied in canonical key order. Written by assignment: the
 * export bundle may carry this module, and a minified `{node: …}` literal
 * would put the forbidden text "node:" into it (exporter/src/scan.ts).
 */
function portRef(r: GraphPortRef): GraphPortRef {
  const o = {} as Record<string, string>;
  o['node'] = r.node;
  o['port'] = r.port;
  return o as unknown as GraphPortRef;
}

/** Canonical graph: items sorted by id, fields in a fixed order, empty optionals dropped. */
export function canonicalGraphData(g: GraphData): GraphData {
  const nodes = [...g.nodes].sort(byId).map((n) => {
    const keys = n.data !== undefined ? Object.keys(n.data).sort() : [];
    return {
      id: n.id,
      type: n.type,
      position: [n.position[0], n.position[1]] as GraphPoint,
      ...(n.collapsed === true ? { collapsed: true as const } : {}),
      ...(keys.length > 0 ? { data: Object.fromEntries(keys.map((k) => { const v = n.data![k]!; return [k, Array.isArray(v) ? [...v] : v]; })) } : {}),
    };
  });
  const edges = [...g.edges].sort(byId).map((e) => ({
    id: e.id,
    from: portRef(e.from),
    to: portRef(e.to),
    ...(e.reroutes !== undefined && e.reroutes.length > 0 ? { reroutes: e.reroutes.map((p) => [p[0], p[1]] as GraphPoint) } : {}),
  }));
  const groups = [...(g.groups ?? [])].sort(byId).map((x) => ({ id: x.id, title: x.title, color: x.color, rect: [x.rect[0], x.rect[1], x.rect[2], x.rect[3]] as GraphGroup['rect'] }));
  const comments = [...(g.comments ?? [])].sort(byId).map((c) => ({ id: c.id, text: c.text, position: [c.position[0], c.position[1]] as GraphPoint, ...(c.size !== undefined ? { size: [c.size[0], c.size[1]] as [number, number] } : {}) }));
  return { nodes, edges, ...(groups.length > 0 ? { groups } : {}), ...(comments.length > 0 ? { comments } : {}) };
}


// ---- edit ops ------------------------------------------------------------------------------

export type GraphOp =
  | { op: 'addNodes'; nodes: GraphNode[] }
  | { op: 'removeNodes'; ids: string[] }
  /** Moves nodes, comments and groups (a group's position is its rect's corner). */
  | { op: 'moveNodes'; moves: { id: string; position: GraphPoint }[] }
  | { op: 'setNodeData'; id: string; data: Record<string, GraphValue> }
  | { op: 'setCollapsed'; ids: string[]; collapsed: boolean }
  | { op: 'connect'; edges: GraphEdge[] }
  | { op: 'disconnect'; ids: string[] }
  | { op: 'setReroutes'; id: string; reroutes: GraphPoint[] }
  | { op: 'setGroups'; groups: GraphGroup[] }
  | { op: 'removeGroups'; ids: string[] }
  | { op: 'setComments'; comments: GraphComment[] }
  | { op: 'removeComments'; ids: string[] };

export const GRAPH_OP_NAMES = ['addNodes', 'removeNodes', 'moveNodes', 'setNodeData', 'setCollapsed', 'connect', 'disconnect', 'setReroutes', 'setGroups', 'removeGroups', 'setComments', 'removeComments'] as const;

const OP_KEYS: Record<GraphOp['op'], readonly string[]> = {
  addNodes: ['nodes'],
  removeNodes: ['ids'],
  moveNodes: ['moves'],
  setNodeData: ['id', 'data'],
  setCollapsed: ['ids', 'collapsed'],
  connect: ['edges'],
  disconnect: ['ids'],
  setReroutes: ['id', 'reroutes'],
  setGroups: ['groups'],
  removeGroups: ['ids'],
  setComments: ['comments'],
  removeComments: ['ids'],
};

/**
 * Shape check of an op list (the request layer): known op names, the op's
 * keys, lists of the right kind and size. Values are checked by
 * `validateGraphData` on the result.
 */
export function validateGraphOps(value: unknown, path: string, errors: ModelErrorV2[]): value is GraphOp[] {
  const before = errors.length;
  if (!Array.isArray(value) || value.length === 0 || value.length > GRAPH_LIMITS.ops) {
    err(errors, 'field_value', path, `ops is a list of 1-${GRAPH_LIMITS.ops} graph ops`, Array.isArray(value) ? value.length : value);
    return false;
  }
  value.forEach((o, i) => {
    const p = `${path}/${i}`;
    if (!isPlainObject(o) || typeof o['op'] !== 'string' || !(GRAPH_OP_NAMES as readonly string[]).includes(o['op'])) {
      return err(errors, 'field_value', `${p}/op`, `op is one of ${GRAPH_OP_NAMES.join(', ')}`, isPlainObject(o) ? o['op'] : o);
    }
    const name = o['op'] as GraphOp['op'];
    const keys = OP_KEYS[name];
    onlyKeys(o, ['op', ...keys], p, errors);
    for (const k of keys) {
      const v = o[k];
      if (v === undefined) {
        err(errors, 'field_missing', `${p}/${k}`, `${name} needs ${k}`, undefined, k);
        continue;
      }
      if (k === 'ids') {
        if (!Array.isArray(v) || v.length === 0 || v.length > GRAPH_LIMITS.nodes || !v.every((x) => typeof x === 'string')) err(errors, 'field_value', `${p}/ids`, 'ids is a non-empty list of item ids', v);
      } else if (k === 'id') {
        if (typeof v !== 'string') err(errors, 'field_type', `${p}/id`, 'id is an item id', v);
      } else if (k === 'collapsed') {
        if (typeof v !== 'boolean') err(errors, 'field_type', `${p}/collapsed`, 'collapsed is true or false', v);
      } else if (k === 'data') {
        if (!isPlainObject(v)) err(errors, 'field_type', `${p}/data`, 'data maps field keys to values', v);
      } else if (k === 'reroutes') {
        if (!Array.isArray(v) || v.length > GRAPH_LIMITS.reroutesPerEdge) err(errors, 'field_value', `${p}/reroutes`, `reroutes is a list of at most ${GRAPH_LIMITS.reroutesPerEdge} points ([] removes them)`, v);
      } else if (k === 'moves') {
        if (!Array.isArray(v) || v.length === 0 || v.length > GRAPH_LIMITS.nodes + GRAPH_LIMITS.groups + GRAPH_LIMITS.comments || !v.every((m) => isPlainObject(m) && typeof m['id'] === 'string' && point(m['position']) && Object.keys(m).length === 2)) {
          err(errors, 'field_value', `${p}/moves`, 'moves is a non-empty list of { id, position: [x, y] }', v);
        }
      } else if (!Array.isArray(v) || v.length === 0 || v.length > GRAPH_LIMITS.nodes || !v.every(isPlainObject)) {
        err(errors, 'field_value', `${p}/${k}`, `${k} is a non-empty list of objects`, v);
      }
    }
  });
  return errors.length === before;
}

export type GraphOpsResult = { ok: true; graph: GraphData; inverse: GraphOp[] } | { ok: false; error: ModelErrorV2 };

function opError(index: number, rel: string, message: string, found?: unknown): { ok: false; error: ModelErrorV2 } {
  return { ok: false, error: { code: 'reference_missing', path: `/${index}${rel}`, message, ...(found !== undefined ? { found } : {}) } as ModelErrorV2 };
}

const clone = <T>(v: T): T => (v === undefined ? v : (JSON.parse(JSON.stringify(v)) as T));

/**
 * Apply ops in order to a graph (not validated here — validate the result
 * with `validateGraphData`). Every op names existing items (a missing id is
 * refused with the op's index in `path`); `addNodes`/`connect`/`setGroups`/
 * `setComments` with a new id add, an existing id is refused for nodes and
 * edges and replaced for groups and comments. Returns the canonical result
 * and the inverse op list that restores the input exactly.
 */
export function applyGraphOps(input: GraphData, ops: readonly GraphOp[]): GraphOpsResult {
  const nodes = new Map(input.nodes.map((n) => [n.id, clone(n)]));
  const edges = new Map(input.edges.map((e) => [e.id, clone(e)]));
  const groups = new Map((input.groups ?? []).map((g) => [g.id, clone(g)]));
  const comments = new Map((input.comments ?? []).map((c) => [c.id, clone(c)]));
  const taken = (id: string): boolean => nodes.has(id) || edges.has(id) || groups.has(id) || comments.has(id);
  const inverses: GraphOp[][] = [];
  for (let i = 0; i < ops.length; i++) {
    const op = ops[i]!;
    const inv: GraphOp[] = [];
    switch (op.op) {
      case 'addNodes': {
        for (const n of op.nodes) {
          if (typeof n.id !== 'string' || taken(n.id)) return { ok: false, error: { code: 'id_duplicate', path: `/${i}/nodes`, message: 'a new node needs an id no other item of the graph uses', found: n.id } as ModelErrorV2 };
          nodes.set(n.id, clone(n));
        }
        inv.push({ op: 'removeNodes', ids: op.nodes.map((n) => n.id) });
        break;
      }
      case 'removeNodes': {
        const gone = new Set(op.ids);
        const removed: GraphNode[] = [];
        for (const id of op.ids) {
          const n = nodes.get(id);
          if (n === undefined) return opError(i, '/ids', 'no node with this id', id);
          removed.push(n);
          nodes.delete(id);
        }
        const cut: GraphEdge[] = [];
        for (const [id, e] of edges) {
          if (gone.has(e.from.node) || gone.has(e.to.node)) {
            cut.push(e);
            edges.delete(id);
          }
        }
        inv.push({ op: 'addNodes', nodes: removed });
        if (cut.length > 0) inv.push({ op: 'connect', edges: cut });
        break;
      }
      case 'moveNodes': {
        const back: { id: string; position: GraphPoint }[] = [];
        for (const m of op.moves) {
          const n = nodes.get(m.id);
          const c = comments.get(m.id);
          const g = groups.get(m.id);
          if (n !== undefined) {
            back.push({ id: m.id, position: [...n.position] as GraphPoint });
            n.position = [m.position[0], m.position[1]];
          } else if (c !== undefined) {
            back.push({ id: m.id, position: [...c.position] as GraphPoint });
            c.position = [m.position[0], m.position[1]];
          } else if (g !== undefined) {
            back.push({ id: m.id, position: [g.rect[0], g.rect[1]] });
            g.rect = [m.position[0], m.position[1], g.rect[2], g.rect[3]];
          } else return opError(i, '/moves', 'no node, comment or group with this id', m.id);
        }
        inv.push({ op: 'moveNodes', moves: back });
        break;
      }
      case 'setNodeData': {
        const n = nodes.get(op.id);
        if (n === undefined) return opError(i, '/id', 'no node with this id', op.id);
        inv.push({ op: 'setNodeData', id: op.id, data: clone(n.data ?? {}) });
        if (Object.keys(op.data).length > 0) n.data = clone(op.data);
        else delete n.data;
        break;
      }
      case 'setCollapsed': {
        const flip: string[] = [];
        for (const id of op.ids) {
          const n = nodes.get(id);
          if (n === undefined) return opError(i, '/ids', 'no node with this id', id);
          if ((n.collapsed === true) !== op.collapsed) flip.push(id);
          if (op.collapsed) n.collapsed = true;
          else delete n.collapsed;
        }
        if (flip.length > 0) inv.push({ op: 'setCollapsed', ids: flip, collapsed: !op.collapsed });
        break;
      }
      case 'connect': {
        for (const e of op.edges) {
          if (typeof e.id !== 'string' || taken(e.id)) return { ok: false, error: { code: 'id_duplicate', path: `/${i}/edges`, message: 'a new edge needs an id no other item of the graph uses', found: e.id } as ModelErrorV2 };
          edges.set(e.id, clone(e));
        }
        inv.push({ op: 'disconnect', ids: op.edges.map((e) => e.id) });
        break;
      }
      case 'disconnect': {
        const cut: GraphEdge[] = [];
        for (const id of op.ids) {
          const e = edges.get(id);
          if (e === undefined) return opError(i, '/ids', 'no edge with this id', id);
          cut.push(e);
          edges.delete(id);
        }
        inv.push({ op: 'connect', edges: cut });
        break;
      }
      case 'setReroutes': {
        const e = edges.get(op.id);
        if (e === undefined) return opError(i, '/id', 'no edge with this id', op.id);
        inv.push({ op: 'setReroutes', id: op.id, reroutes: clone(e.reroutes ?? []) });
        if (op.reroutes.length > 0) e.reroutes = clone(op.reroutes);
        else delete e.reroutes;
        break;
      }
      case 'setGroups': {
        const fresh: string[] = [];
        const old: GraphGroup[] = [];
        for (const g of op.groups) {
          const prev = groups.get(g.id);
          if (prev !== undefined) old.push(prev);
          else if (typeof g.id !== 'string' || taken(g.id)) return { ok: false, error: { code: 'id_duplicate', path: `/${i}/groups`, message: 'a new group needs an id no other item of the graph uses', found: g.id } as ModelErrorV2 };
          else fresh.push(g.id);
          groups.set(g.id, clone(g));
        }
        if (fresh.length > 0) inv.push({ op: 'removeGroups', ids: fresh });
        if (old.length > 0) inv.push({ op: 'setGroups', groups: old });
        break;
      }
      case 'removeGroups': {
        const old: GraphGroup[] = [];
        for (const id of op.ids) {
          const g = groups.get(id);
          if (g === undefined) return opError(i, '/ids', 'no group with this id', id);
          old.push(g);
          groups.delete(id);
        }
        inv.push({ op: 'setGroups', groups: old });
        break;
      }
      case 'setComments': {
        const fresh: string[] = [];
        const old: GraphComment[] = [];
        for (const c of op.comments) {
          const prev = comments.get(c.id);
          if (prev !== undefined) old.push(prev);
          else if (typeof c.id !== 'string' || taken(c.id)) return { ok: false, error: { code: 'id_duplicate', path: `/${i}/comments`, message: 'a new comment needs an id no other item of the graph uses', found: c.id } as ModelErrorV2 };
          else fresh.push(c.id);
          comments.set(c.id, clone(c));
        }
        if (fresh.length > 0) inv.push({ op: 'removeComments', ids: fresh });
        if (old.length > 0) inv.push({ op: 'setComments', comments: old });
        break;
      }
      case 'removeComments': {
        const old: GraphComment[] = [];
        for (const id of op.ids) {
          const c = comments.get(id);
          if (c === undefined) return opError(i, '/ids', 'no comment with this id', id);
          old.push(c);
          comments.delete(id);
        }
        inv.push({ op: 'setComments', comments: old });
        break;
      }
    }
    inverses.push(inv);
  }
  const inverse: GraphOp[] = [];
  for (let i = inverses.length - 1; i >= 0; i--) inverse.push(...inverses[i]!);
  const graph = canonicalGraphData({
    nodes: [...nodes.values()],
    edges: [...edges.values()],
    groups: [...groups.values()],
    comments: [...comments.values()],
  });
  return { ok: true, graph, inverse };
}

// ---- standalone graph documents (content.graphs) ------------------------------------------

/**
 * A graph stored as its own content record (owner kind `graph`). Graphs that
 * belong to another document (an animator controller, a material, a
 * behavior, an effect) are stored inside that document instead; the graph
 * edit command reaches them through the owner kind.
 */
export interface GraphDocument {
  graphId: string;
  /** The graph kind (a key of GRAPH_KINDS). */
  kind: string;
  name: string;
  graph: GraphData;
}

export const MAX_GRAPH_DOCUMENTS = 64;
const DOC_ID_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;

export function validateGraphDocument(kinds: Readonly<Record<string, GraphKindDef>>, value: unknown, path: string, errors: ModelErrorV2[], ctx?: GraphContext): void {
  if (!isPlainObject(value)) return err(errors, 'field_type', path, 'a graph document is { graphId, kind, name, graph }', value);
  onlyKeys(value, ['graphId', 'kind', 'name', 'graph'], path, errors);
  if (typeof value['graphId'] !== 'string' || !DOC_ID_RE.test(value['graphId'])) err(errors, 'field_value', `${path}/graphId`, 'graphId is an id (a-z, 0-9, _ and -)', value['graphId']);
  if (typeof value['name'] !== 'string' || value['name'].length < 1 || value['name'].length > GRAPH_LIMITS.titleLength) err(errors, 'field_value', `${path}/name`, `a name is 1-${GRAPH_LIMITS.titleLength} characters`, value['name']);
  const kind = typeof value['kind'] === 'string' && Object.prototype.hasOwnProperty.call(kinds, value['kind']) ? kinds[value['kind']] : undefined;
  if (kind === undefined) return err(errors, 'reference_missing', `${path}/kind`, 'not a registered graph kind', value['kind'], Object.keys(kinds).join(', '));
  if (kind.owner !== undefined) return err(errors, 'field_value', `${path}/kind`, `a ${kind.label} belongs to its ${kind.owner} (edit it there with graphEdit {owner: {kind: "${kind.owner}", …}})`, value['kind'], Object.keys(kinds).filter((k) => kinds[k]!.owner === undefined).join(', '));
  validateGraphData(kind, value['graph'], `${path}/graph`, errors, ctx);
}

/**
 * Phase 18.1: the context standalone graphs give each other (sub-graph
 * calls): a graph of `kind` by id, read from the list as it is (malformed
 * entries are skipped; their own validation reports them).
 */
export function graphDocumentsContext(kinds: Readonly<Record<string, GraphKindDef>>, list: unknown): GraphContext {
  const docs = Array.isArray(list) ? list : [];
  return {
    graph(kind, id) {
      const d = docs.find((x) => isPlainObject(x) && x['graphId'] === id && x['kind'] === kind) as Record<string, unknown> | undefined;
      const k = Object.prototype.hasOwnProperty.call(kinds, kind) ? kinds[kind] : undefined;
      const g = d?.['graph'];
      if (k === undefined || !isPlainObject(g) || !Array.isArray(g['nodes']) || !Array.isArray(g['edges'])) return null;
      const nodes = (g['nodes'] as unknown[]).filter((n): n is GraphNode => isPlainObject(n) && typeof n['id'] === 'string' && typeof n['type'] === 'string' && point(n['position']) && (n['data'] === undefined || isPlainObject(n['data'])));
      return { kind: k, graph: { nodes, edges: [] } };
    },
  };
}

export function validateGraphDocuments(kinds: Readonly<Record<string, GraphKindDef>>, value: unknown, path: string, errors: ModelErrorV2[]): void {
  if (!Array.isArray(value) || value.length > MAX_GRAPH_DOCUMENTS) return err(errors, 'field_value', path, `graphs is a list of at most ${MAX_GRAPH_DOCUMENTS}`, value);
  const ids = new Set<string>();
  const ctx = graphDocumentsContext(kinds, value);
  // Phase 18.1: sub-graph calls between documents must not form a cycle.
  const calls = new Map<string, string[]>();
  value.forEach((g) => {
    if (!isPlainObject(g) || typeof g['graphId'] !== 'string' || typeof g['kind'] !== 'string') return;
    const k = Object.prototype.hasOwnProperty.call(kinds, g['kind']) ? kinds[g['kind']] : undefined;
    const graph = g['graph'];
    if (k === undefined || !isPlainObject(graph) || !Array.isArray(graph['nodes'])) return;
    const to: string[] = [];
    for (const n of graph['nodes'] as unknown[]) {
      if (!isPlainObject(n) || typeof n['type'] !== 'string') continue;
      const pf = nodeDef(k, n['type'])?.portsFrom;
      const ref = pf !== undefined && isPlainObject(n['data']) ? n['data'][pf.field] : undefined;
      if (typeof ref === 'string' && ref !== '') to.push(ref);
    }
    calls.set(g['graphId'], to);
  });
  const cycle = findCycle(calls);
  if (cycle !== null) err(errors, 'hierarchy_cycle', path, `graphs cannot call each other in a cycle (${cycle.join(' → ')})`, cycle[0]);
  value.forEach((g, i) => {
    validateGraphDocument(kinds, g, `${path}/${i}`, errors, ctx);
    const id = isPlainObject(g) ? g['graphId'] : undefined;
    if (typeof id === 'string') {
      if (ids.has(id)) err(errors, 'id_duplicate', `${path}/${i}/graphId`, 'graph ids are unique', id);
      ids.add(id);
    }
  });
}

export function canonicalGraphDocuments(list: readonly GraphDocument[]): GraphDocument[] {
  return [...list]
    .sort((a, b) => (a.graphId < b.graphId ? -1 : a.graphId > b.graphId ? 1 : 0))
    .map((d) => ({ graphId: d.graphId, kind: d.kind, name: d.name, graph: canonicalGraphData(d.graph) }));
}
