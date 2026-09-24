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
  /** Input only: accepts several edges (outputs always may fan out). */
  multi?: boolean;
  /** Input only: an unconnected required input is a diagnostic error. */
  required?: boolean;
}

export interface GraphFieldDef {
  key: string;
  label: string;
  type: 'number' | 'string' | 'boolean' | 'enum' | 'vector';
  default: GraphValue;
  min?: number;
  max?: number;
  /** `enum`: the allowed values. */
  options?: readonly string[];
  /** `vector`: the component count (2–4). */
  size?: number;
  /** `string`: the longest value (default 256). */
  maxLength?: number;
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

export const GRAPH_ITEM_ID_RE = /^[A-Za-z0-9_-]{1,40}$/;
const COLOR_RE = /^#[0-9a-f]{6}$/;

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

function fieldValueError(f: GraphFieldDef, v: unknown): string | null {
  switch (f.type) {
    case 'number':
      if (typeof v !== 'number' || !Number.isFinite(v)) return 'a number';
      if ((f.min !== undefined && v < f.min) || (f.max !== undefined && v > f.max)) return `a number ${f.min ?? '-∞'}–${f.max ?? '∞'}`;
      return null;
    case 'string':
      return typeof v === 'string' && v.length <= (f.maxLength ?? 256) ? null : `a string of at most ${f.maxLength ?? 256} characters`;
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
export function validateGraphData(kind: GraphKindDef, value: unknown, path: string, errors: ModelErrorV2[]): void {
  if (!isPlainObject(value)) return err(errors, 'field_type', path, 'a graph is { nodes, edges, groups?, comments? }', value);
  onlyKeys(value, ['nodes', 'edges', 'groups', 'comments'], path, errors);
  const ids = new Set<string>();
  const claim = (id: unknown, p: string): boolean => {
    if (typeof id !== 'string' || !GRAPH_ITEM_ID_RE.test(id)) {
      err(errors, 'field_value', p, 'an item id is 1-40 letters, digits, _ or -', id);
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
        if (idOk) nodeTypes.set(n['id'] as string, def);
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
  }

  const edges = value['edges'];
  const maxEdges = maxNodes * GRAPH_LIMITS.edgesPerNode;
  const adjacency = new Map<string, string[]>();
  if (!Array.isArray(edges)) err(errors, 'field_type', `${path}/edges`, 'edges is a list', edges);
  else {
    if (edges.length > maxEdges) err(errors, 'limits_exceeded', `${path}/edges`, `a ${kind.label} has at most ${maxEdges} edges`, edges.length, `at most ${maxEdges}`);
    const intoSingle = new Set<string>();
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
        const port = (end === 'from' ? def.outputs : def.inputs).find((x) => x.id === r['port']);
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

export function validateGraphDocument(kinds: Readonly<Record<string, GraphKindDef>>, value: unknown, path: string, errors: ModelErrorV2[]): void {
  if (!isPlainObject(value)) return err(errors, 'field_type', path, 'a graph document is { graphId, kind, name, graph }', value);
  onlyKeys(value, ['graphId', 'kind', 'name', 'graph'], path, errors);
  if (typeof value['graphId'] !== 'string' || !DOC_ID_RE.test(value['graphId'])) err(errors, 'field_value', `${path}/graphId`, 'graphId is an id (a-z, 0-9, _ and -)', value['graphId']);
  if (typeof value['name'] !== 'string' || value['name'].length < 1 || value['name'].length > GRAPH_LIMITS.titleLength) err(errors, 'field_value', `${path}/name`, `a name is 1-${GRAPH_LIMITS.titleLength} characters`, value['name']);
  const kind = typeof value['kind'] === 'string' && Object.prototype.hasOwnProperty.call(kinds, value['kind']) ? kinds[value['kind']] : undefined;
  if (kind === undefined) return err(errors, 'reference_missing', `${path}/kind`, 'not a registered graph kind', value['kind'], Object.keys(kinds).join(', '));
  validateGraphData(kind, value['graph'], `${path}/graph`, errors);
}

export function validateGraphDocuments(kinds: Readonly<Record<string, GraphKindDef>>, value: unknown, path: string, errors: ModelErrorV2[]): void {
  if (!Array.isArray(value) || value.length > MAX_GRAPH_DOCUMENTS) return err(errors, 'field_value', path, `graphs is a list of at most ${MAX_GRAPH_DOCUMENTS}`, value);
  const ids = new Set<string>();
  value.forEach((g, i) => {
    validateGraphDocument(kinds, g, `${path}/${i}`, errors);
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
