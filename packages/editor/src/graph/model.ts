/**
 * Phase 16.1: the graph editor's pure model.
 *
 * The editor may import project-model types only (dependencies.md §4.1), so
 * this module holds the editor side of the graph framework:
 *
 * - `applyGraphOpsLocal`: advances the editor's copy of a graph from a
 *   `graphEdit` change (the backend applied and validated the same ops; this
 *   is the projection, kept equal to project-model's `applyGraphOps` by
 *   tests/graph-parity.test.ts);
 * - connection helpers over the kind's data (port compatibility with the
 *   implicit conversions, the live cycle check, the catalogue filter for
 *   "drag from a port to empty space");
 * - diagnostics (the kind's rules as per-node errors/warnings);
 * - geometry (node sizes, port positions, wires, hit tests, fit/zoom);
 * - edit builders (copy/paste with id remapping, duplicate, delete,
 *   alignment, grouping), each returning the op list of ONE graphEdit;
 * - phase 18.1: data-dependent ports (`resolvePorts`: a sub-graph call's
 *   interface, types from node data, `auto` widths from the wires), the
 *   same rules as project-model's `resolveGraphPorts` (parity-tested). Every
 *   port lookup takes an optional `PortsOf` (default: the node type's ports
 *   with types from the node's own data).
 *
 * Pure: no DOM, no I/O.
 */
import type {
  GraphComment,
  GraphContext,
  GraphConversion,
  GraphData,
  GraphEdge,
  GraphFieldDef,
  GraphGroup,
  GraphKindDef,
  GraphNode,
  GraphNodeDef,
  GraphOp,
  GraphPoint,
  GraphPortDef,
  GraphValue,
} from '@thirdlight/project-model';

export type { GraphData, GraphKindDef, GraphNode, GraphNodeDef, GraphEdge, GraphGroup, GraphComment, GraphOp, GraphPoint, GraphValue, GraphContext };

// ---- the projection -----------------------------------------------------------------------

const byId = <T extends { id: string }>(a: T, b: T): number => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
const clone = <T>(v: T): T => structuredClone(v);

/** The canonical form (sorted by id, empty optionals dropped) — as the backend stores it. */
export function canonicalGraph(g: GraphData): GraphData {
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
    from: { node: e.from.node, port: e.from.port },
    to: { node: e.to.node, port: e.to.port },
    ...(e.reroutes !== undefined && e.reroutes.length > 0 ? { reroutes: e.reroutes.map((p) => [p[0], p[1]] as GraphPoint) } : {}),
  }));
  const groups = [...(g.groups ?? [])].sort(byId).map((x) => ({ id: x.id, title: x.title, color: x.color, rect: [x.rect[0], x.rect[1], x.rect[2], x.rect[3]] as GraphGroup['rect'] }));
  const comments = [...(g.comments ?? [])].sort(byId).map((c) => ({ id: c.id, text: c.text, position: [c.position[0], c.position[1]] as GraphPoint, ...(c.size !== undefined ? { size: [c.size[0], c.size[1]] as [number, number] } : {}) }));
  return { nodes, edges, ...(groups.length > 0 ? { groups } : {}), ...(comments.length > 0 ? { comments } : {}) };
}

/**
 * Apply a change's ops to the editor's copy. Returns null when an op does
 * not fit the copy (the copy is stale: the caller re-reads the full state).
 */
export function applyGraphOpsLocal(input: GraphData, ops: readonly GraphOp[]): GraphData | null {
  const nodes = new Map(input.nodes.map((n) => [n.id, clone(n)]));
  const edges = new Map(input.edges.map((e) => [e.id, clone(e)]));
  const groups = new Map((input.groups ?? []).map((g) => [g.id, clone(g)]));
  const comments = new Map((input.comments ?? []).map((c) => [c.id, clone(c)]));
  const taken = (id: string): boolean => nodes.has(id) || edges.has(id) || groups.has(id) || comments.has(id);
  for (const op of ops) {
    switch (op.op) {
      case 'addNodes':
        for (const n of op.nodes) {
          if (taken(n.id)) return null;
          nodes.set(n.id, clone(n));
        }
        break;
      case 'removeNodes': {
        for (const id of op.ids) if (!nodes.delete(id)) return null;
        const gone = new Set(op.ids);
        for (const [id, e] of edges) if (gone.has(e.from.node) || gone.has(e.to.node)) edges.delete(id);
        break;
      }
      case 'moveNodes':
        for (const m of op.moves) {
          const n = nodes.get(m.id);
          const c = comments.get(m.id);
          const g = groups.get(m.id);
          if (n !== undefined) n.position = [m.position[0], m.position[1]];
          else if (c !== undefined) c.position = [m.position[0], m.position[1]];
          else if (g !== undefined) g.rect = [m.position[0], m.position[1], g.rect[2], g.rect[3]];
          else return null;
        }
        break;
      case 'setNodeData': {
        const n = nodes.get(op.id);
        if (n === undefined) return null;
        if (Object.keys(op.data).length > 0) n.data = clone(op.data);
        else delete n.data;
        break;
      }
      case 'setCollapsed':
        for (const id of op.ids) {
          const n = nodes.get(id);
          if (n === undefined) return null;
          if (op.collapsed) n.collapsed = true;
          else delete n.collapsed;
        }
        break;
      case 'connect':
        for (const e of op.edges) {
          if (taken(e.id)) return null;
          edges.set(e.id, clone(e));
        }
        break;
      case 'disconnect':
        for (const id of op.ids) if (!edges.delete(id)) return null;
        break;
      case 'setReroutes': {
        const e = edges.get(op.id);
        if (e === undefined) return null;
        if (op.reroutes.length > 0) e.reroutes = clone(op.reroutes);
        else delete e.reroutes;
        break;
      }
      case 'setGroups':
        for (const g of op.groups) {
          if (!groups.has(g.id) && taken(g.id)) return null;
          groups.set(g.id, clone(g));
        }
        break;
      case 'removeGroups':
        for (const id of op.ids) if (!groups.delete(id)) return null;
        break;
      case 'setComments':
        for (const c of op.comments) {
          if (!comments.has(c.id) && taken(c.id)) return null;
          comments.set(c.id, clone(c));
        }
        break;
      case 'removeComments':
        for (const id of op.ids) if (!comments.delete(id)) return null;
        break;
    }
  }
  return canonicalGraph({ nodes: [...nodes.values()], edges: [...edges.values()], groups: [...groups.values()], comments: [...comments.values()] });
}

// ---- kind helpers ---------------------------------------------------------------------------

export function nodeDefOf(kind: GraphKindDef, type: string): GraphNodeDef | undefined {
  return kind.nodes.find((n) => n.type === type);
}

export function portTypeColor(kind: GraphKindDef, type: string): string {
  return kind.portTypes.find((t) => t.id === type)?.color ?? '#b0b0b0';
}

export function portTypeLabel(kind: GraphKindDef, type: string): string {
  return kind.portTypes.find((t) => t.id === type)?.label ?? type;
}

/** Output type → input type: null (incompatible), or ok with the implicit conversion (null = none needed). */
export function compatibility(kind: GraphKindDef, from: string, to: string): { conversion: GraphConversion | null } | null {
  if (from === to || (kind.anyType !== undefined && (from === kind.anyType || to === kind.anyType))) return { conversion: null };
  const c = kind.conversions.find((x) => x.from === from && x.to === to);
  return c !== undefined ? { conversion: c } : null;
}

// ---- phase 18.1: data-dependent ports ---------------------------------------------------------

export interface NodePorts {
  inputs: readonly GraphPortDef[];
  outputs: readonly GraphPortDef[];
}
/** A node's resolved ports (see `portsResolver`). */
export type PortsOf = (n: GraphNode) => NodePorts;
const NO_PORTS: NodePorts = { inputs: [], outputs: [] };
/** The value of a type field that asks for the widest connected type. */
export const AUTO_TYPE = 'auto';

const byPosition = (a: GraphNode, b: GraphNode): number => a.position[1] - b.position[1] || a.position[0] - b.position[0] || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/** A callable graph's interface: its input nodes as input ports, its output nodes as output ports. */
export function graphInterface(kind: GraphKindDef, graph: GraphData): NodePorts {
  const itf = kind.interface;
  if (itf === undefined) return NO_PORTS;
  const side = (type: string): GraphPortDef[] => {
    const def = nodeDefOf(kind, type);
    const lf = def?.fields?.find((f) => f.key === itf.labelField);
    const tf = def?.fields?.find((f) => f.key === itf.typeField);
    return graph.nodes
      .filter((n) => n.type === type)
      .sort(byPosition)
      .map((n) => {
        const label = lf !== undefined ? fieldValue(n, lf) : '';
        const t = tf !== undefined ? fieldValue(n, tf) : '';
        return { id: n.id, label: typeof label === 'string' && label !== '' ? label : n.id, type: String(t) };
      });
  };
  return { inputs: side(itf.input), outputs: side(itf.output) };
}

type Slot = GraphPortDef | { port: GraphPortDef; auto: string };

function declared(kind: GraphKindDef, def: GraphNodeDef, node: GraphNode, port: GraphPortDef, ctx: GraphContext | undefined): { type: string } | { auto: string } {
  const rule = port.typeFrom;
  if (rule === undefined) return { type: port.type };
  const f = def.fields?.find((x) => x.key === rule.field);
  if (f === undefined) return { type: port.type };
  const v = fieldValue(node, f);
  const s = typeof v === 'string' ? v : String(v);
  if (rule.lookup !== undefined) return { type: ctx?.lookup?.(rule.lookup, s) ?? port.type };
  if (rule.map !== undefined && Object.prototype.hasOwnProperty.call(rule.map, s)) return { type: rule.map[s]! };
  if (rule.byLength !== undefined) return { type: rule.byLength[s.length - 1] ?? port.type };
  if (s === AUTO_TYPE) return { auto: rule.field };
  return { type: kind.portTypes.some((t) => t.id === s) ? s : port.type };
}

const optionsOf = (def: GraphNodeDef, field: string): readonly string[] => def.fields?.find((f) => f.key === field)?.options ?? [];

/**
 * Every node's ports with resolved types: static ports, a call's interface
 * (`portsFrom`, through `ctx.graph`), types from node data (`typeFrom`) and
 * `auto` widths from the wires (the widest among the wires in, in the type
 * field's option order; none → the first option after `auto`).
 */
export function resolvePorts(kind: GraphKindDef, graph: { nodes: readonly GraphNode[]; edges: readonly GraphEdge[] }, ctx?: GraphContext): Map<string, NodePorts> {
  const out = new Map<string, NodePorts>();
  const pending = new Map<string, { def: GraphNodeDef; inputs: Slot[]; outputs: Slot[] }>();
  for (const node of graph.nodes) {
    const def = nodeDefOf(kind, node.type);
    if (def === undefined) continue;
    let inputs: readonly GraphPortDef[] = def.inputs;
    let outputs: readonly GraphPortDef[] = def.outputs;
    const pf = def.portsFrom;
    if (pf !== undefined) {
      const f = def.fields?.find((x) => x.key === pf.field);
      const ref = f !== undefined ? fieldValue(node, f) : '';
      const target = typeof ref === 'string' && ref !== '' ? (ctx?.graph?.(pf.kind, ref) ?? null) : null;
      const itf = target !== null ? graphInterface(target.kind, target.graph) : NO_PORTS;
      inputs = [...inputs, ...itf.inputs];
      outputs = [...outputs, ...itf.outputs];
    }
    let hasAuto = false;
    const map = (p: GraphPortDef): Slot => {
      const d = declared(kind, def, node, p, ctx);
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
    const l = incoming.get(e.to.node) ?? [];
    l.push(e);
    incoming.set(e.to.node, l);
  }
  const visiting = new Set<string>();
  const resolve = (id: string): NodePorts | undefined => {
    const done = out.get(id);
    if (done !== undefined) return done;
    const p = pending.get(id);
    if (p === undefined || visiting.has(id)) return undefined;
    visiting.add(id);
    const widest = new Map<string, number>();
    for (const e of incoming.get(id) ?? []) {
      const slot = p.inputs.find((x) => ('auto' in x ? x.port.id : x.id) === e.to.port);
      if (slot === undefined || !('auto' in slot)) continue;
      const src = resolve(e.from.node)?.outputs.find((x) => x.id === e.from.port);
      if (src === undefined) continue;
      const i = optionsOf(p.def, slot.auto).indexOf(src.type);
      if (i >= 0 && src.type !== AUTO_TYPE && i > (widest.get(slot.auto) ?? -1)) widest.set(slot.auto, i);
    }
    const fix = (x: Slot): GraphPortDef => {
      if (!('auto' in x)) return x;
      const opts = optionsOf(p.def, x.auto);
      const i = widest.get(x.auto);
      return { ...x.port, type: i !== undefined ? opts[i]! : (opts.find((o) => o !== AUTO_TYPE) ?? x.port.type) };
    };
    const r = { inputs: p.inputs.map(fix), outputs: p.outputs.map(fix) };
    visiting.delete(id);
    out.set(id, r);
    return r;
  };
  for (const id of pending.keys()) resolve(id);
  return out;
}

/** A node's ports without wires (a node not in a graph yet; `auto` takes its fallback). */
export function staticPorts(kind: GraphKindDef, node: GraphNode, ctx?: GraphContext): NodePorts {
  return resolvePorts(kind, { nodes: [node], edges: [] }, ctx).get(node.id) ?? NO_PORTS;
}

/** A `PortsOf` for one graph value: resolved once, nodes not in the graph (drags keep ids; new nodes) resolved alone. */
export function portsResolver(kind: GraphKindDef, graph: GraphData, ctx?: GraphContext): PortsOf {
  const table = resolvePorts(kind, graph, ctx);
  return (n) => table.get(n.id) ?? staticPorts(kind, n, ctx);
}

/** The default `PortsOf`: the node type's ports, types from the node's own data. */
export function defaultPortsOf(kind: GraphKindDef): PortsOf {
  return (n) => staticPorts(kind, n);
}

export function portDef(kind: GraphKindDef, graph: GraphData, nodeId: string, port: string, side: 'in' | 'out', portsOf?: PortsOf): GraphPortDef | undefined {
  const n = graph.nodes.find((x) => x.id === nodeId);
  if (n === undefined) return undefined;
  const ports = (portsOf ?? defaultPortsOf(kind))(n);
  return (side === 'in' ? ports.inputs : ports.outputs).find((p) => p.id === port);
}

/** Would an edge from `fromNode` into `toNode` close a cycle? */
export function wouldCycle(graph: GraphData, fromNode: string, toNode: string): boolean {
  if (fromNode === toNode) return true;
  const adj = new Map<string, string[]>();
  for (const e of graph.edges) {
    const l = adj.get(e.from.node) ?? [];
    l.push(e.to.node);
    adj.set(e.from.node, l);
  }
  const seen = new Set<string>([toNode]);
  const stack = [toNode];
  while (stack.length > 0) {
    const n = stack.pop()!;
    for (const m of adj.get(n) ?? []) {
      if (m === fromNode) return true;
      if (!seen.has(m)) {
        seen.add(m);
        stack.push(m);
      }
    }
  }
  return false;
}

export interface PortEnd {
  node: string;
  port: string;
  side: 'in' | 'out';
}

/**
 * Why `a` and `b` cannot be connected (a message), or the edge to add plus
 * the edges it replaces (a single input's current edge), with the implicit
 * conversion it uses.
 */
export function planConnection(
  kind: GraphKindDef,
  graph: GraphData,
  a: PortEnd,
  b: PortEnd,
  portsOf?: PortsOf,
): { ok: true; from: { node: string; port: string }; to: { node: string; port: string }; replaces: string[]; conversion: GraphConversion | null } | { ok: false; reason: string } {
  if (a.side === b.side) return { ok: false, reason: a.side === 'in' ? 'connect an output to an input' : 'connect an output to an input' };
  const out = a.side === 'out' ? a : b;
  const inp = a.side === 'in' ? a : b;
  const po = portDef(kind, graph, out.node, out.port, 'out', portsOf);
  const pi = portDef(kind, graph, inp.node, inp.port, 'in', portsOf);
  if (po === undefined || pi === undefined) return { ok: false, reason: 'unknown port' };
  const c = compatibility(kind, po.type, pi.type);
  if (c === null) return { ok: false, reason: `a ${portTypeLabel(kind, po.type)} output cannot feed a ${portTypeLabel(kind, pi.type)} input` };
  if (!kind.allowCycles && wouldCycle(graph, out.node, inp.node)) return { ok: false, reason: 'this would make a cycle' };
  if (graph.edges.some((e) => e.from.node === out.node && e.from.port === out.port && e.to.node === inp.node && e.to.port === inp.port)) return { ok: false, reason: 'already connected' };
  const replaces = pi.multi === true ? [] : graph.edges.filter((e) => e.to.node === inp.node && e.to.port === inp.port).map((e) => e.id);
  // Phase 16.2: a single output (e.g. a state machine's Entry) keeps one wire: the new one replaces it.
  if (po.single === true) for (const e of graph.edges) if (e.from.node === out.node && e.from.port === out.port && !replaces.includes(e.id)) replaces.push(e.id);
  return { ok: true, from: { node: out.node, port: out.port }, to: { node: inp.node, port: inp.port }, replaces, conversion: c.conversion };
}

/** The implicit conversion an edge uses (null = none). */
export function edgeConversion(kind: GraphKindDef, graph: GraphData, e: GraphEdge, portsOf?: PortsOf): GraphConversion | null {
  const po = portDef(kind, graph, e.from.node, e.from.port, 'out', portsOf);
  const pi = portDef(kind, graph, e.to.node, e.to.port, 'in', portsOf);
  if (po === undefined || pi === undefined) return null;
  return compatibility(kind, po.type, pi.type)?.conversion ?? null;
}

/**
 * The catalogue entries that can take a wire dragged from `type` on `side`
 * (an output → nodes with a compatible input, and vice versa), with the
 * port to connect.
 */
export function compatibleNodeDefs(kind: GraphKindDef, type: string, side: 'in' | 'out'): { def: GraphNodeDef; port: string }[] {
  const out: { def: GraphNodeDef; port: string }[] = [];
  for (const def of kind.nodes) {
    if (def.fixed === true) continue;
    // A new node's ports: its type's, with data-dependent types at their defaults.
    const fresh = staticPorts(kind, { id: '_', type: def.type, position: [0, 0] });
    const ports = side === 'out' ? fresh.inputs : fresh.outputs;
    const hit = ports.find((p) => (side === 'out' ? compatibility(kind, type, p.type) : compatibility(kind, p.type, type)) !== null);
    if (hit !== undefined) out.push({ def, port: hit.id });
  }
  return out;
}

/** Catalogue search: entries matching every word of `query` (label, type, category, description), in category order. */
export function searchCatalogue(kind: GraphKindDef, query: string, only?: readonly GraphNodeDef[]): GraphNodeDef[] {
  const words = query.toLowerCase().split(/\s+/).filter((w) => w.length > 0);
  // Fixed nodes (phase 16.2) are part of every graph of the kind: never added from the catalogue.
  const pool = (only ?? kind.nodes).filter((d) => d.fixed !== true);
  const hits = pool.filter((d) => {
    const hay = `${d.label} ${d.type} ${d.category} ${d.description ?? ''}`.toLowerCase();
    return words.every((w) => hay.includes(w));
  });
  const order = (c: string): number => {
    const i = kind.categories.indexOf(c);
    return i < 0 ? kind.categories.length : i;
  };
  return hits.sort((a, b) => order(a.category) - order(b.category));
}

export function fieldValue(node: GraphNode, f: GraphFieldDef): GraphValue {
  const v = node.data?.[f.key];
  return v === undefined ? f.default : v;
}

/** Phase 16.2: a node's title — its title field's value when the type has one and it is set, else the type's label. */
export function nodeTitle(kind: GraphKindDef, node: GraphNode): string {
  const def = nodeDefOf(kind, node.type);
  if (def === undefined) return node.type;
  if (def.titleField !== undefined) {
    const v = node.data?.[def.titleField];
    if (typeof v === 'string' && v !== '') return v;
  }
  return def.label;
}

/** The fields drawn on the node body (the title field is the title), at most SHOWN_FIELDS. */
export function shownFields(def: GraphNodeDef): GraphFieldDef[] {
  return (def.fields ?? []).filter((f) => f.key !== def.titleField).slice(0, SHOWN_FIELDS);
}

// ---- diagnostics ----------------------------------------------------------------------------

export interface GraphProblem {
  severity: 'error' | 'warning';
  /** The node the problem is on (absent = the whole graph). */
  nodeId?: string;
  message: string;
}

/**
 * The kind's rules as problems (shown on the node and in the Problems tab;
 * never a refusal): a required input left unconnected (error), a required
 * node type missing (error), a node whose result reaches no sink (warning).
 */
export function diagnoseGraph(kind: GraphKindDef, graph: GraphData, portsOf?: PortsOf): GraphProblem[] {
  const out: GraphProblem[] = [];
  const ports = portsOf ?? defaultPortsOf(kind);
  const connected = new Set(graph.edges.map((e) => `${e.to.node}\u0000${e.to.port}`));
  for (const n of graph.nodes) {
    const def = nodeDefOf(kind, n.type);
    if (def === undefined) {
      out.push({ severity: 'error', nodeId: n.id, message: `unknown node type "${n.type}"` });
      continue;
    }
    for (const p of ports(n).inputs) {
      if (p.required === true && !connected.has(`${n.id}\u0000${p.id}`)) out.push({ severity: 'error', nodeId: n.id, message: `${def.label}: input "${p.label}" is not connected` });
    }
  }
  for (const def of kind.nodes) {
    if (def.required !== true) continue;
    // Phase 18.1: any node of the same exclusive tag satisfies a required type (e.g. an Unlit instead of a PBR output).
    const satisfies = (t: string): boolean => t === def.type || (def.exclusive !== undefined && nodeDefOf(kind, t)?.exclusive === def.exclusive);
    if (!graph.nodes.some((n) => satisfies(n.type))) {
      const alts = def.exclusive !== undefined ? kind.nodes.filter((d) => d.exclusive === def.exclusive && d.type !== def.type).map((d) => `"${d.label}"`) : [];
      out.push({ severity: 'error', message: `the graph needs a "${def.label}" node${alts.length > 0 ? ` (or ${alts.join(', ')})` : ''}` });
    }
  }
  const sinks = kind.sinks ?? [];
  if (sinks.length > 0) {
    const incoming = new Map<string, string[]>();
    for (const e of graph.edges) {
      const l = incoming.get(e.to.node) ?? [];
      l.push(e.from.node);
      incoming.set(e.to.node, l);
    }
    const reached = new Set<string>();
    const stack = graph.nodes.filter((n) => sinks.includes(n.type)).map((n) => n.id);
    for (const id of stack) reached.add(id);
    while (stack.length > 0) {
      const id = stack.pop()!;
      for (const m of incoming.get(id) ?? []) {
        if (!reached.has(m)) {
          reached.add(m);
          stack.push(m);
        }
      }
    }
    const sinkLabels = sinks.map((s) => nodeDefOf(kind, s)?.label ?? s).join(' or ');
    for (const n of graph.nodes) {
      const def = nodeDefOf(kind, n.type);
      if (!reached.has(n.id) && def !== undefined) out.push({ severity: 'warning', nodeId: n.id, message: `${def.label}: its result is not used (it reaches no ${sinkLabels})` });
    }
  }
  return out;
}

// ---- geometry -------------------------------------------------------------------------------

export const NODE_WIDTH = 180;
export const HEADER = 26;
export const ROW = 20;
export const FIELD_ROW = 18;
export const GROUP_HEADER = 24;
/** Grid step (graph units): snapping and keyboard moves. */
export const GRID = 20;

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Fields shown on the node body (the rest are in the Inspector). */
export const SHOWN_FIELDS = 2;

export function nodeRect(kind: GraphKindDef, n: GraphNode, position: GraphPoint = n.position, portsOf?: PortsOf): Rect {
  const def = nodeDefOf(kind, n.type);
  if (n.collapsed === true || def === undefined) return { x: position[0], y: position[1], w: NODE_WIDTH, h: HEADER };
  const ports = (portsOf ?? defaultPortsOf(kind))(n);
  const rows = Math.max(ports.inputs.length, ports.outputs.length, 0);
  const fields = shownFields(def).length;
  return { x: position[0], y: position[1], w: NODE_WIDTH, h: HEADER + rows * ROW + fields * FIELD_ROW + 8 };
}

/** A port's anchor point (collapsed nodes gather their ports on the header). */
export function portPoint(kind: GraphKindDef, n: GraphNode, side: 'in' | 'out', port: string, position: GraphPoint = n.position, portsOf?: PortsOf): GraphPoint {
  const ports = (portsOf ?? defaultPortsOf(kind))(n);
  const list = side === 'in' ? ports.inputs : ports.outputs;
  const i = Math.max(0, list.findIndex((p) => p.id === port));
  const x = side === 'in' ? position[0] : position[0] + NODE_WIDTH;
  if (n.collapsed === true) return [x, position[1] + HEADER / 2];
  return [x, position[1] + HEADER + ROW / 2 + i * ROW + 2];
}

export function commentRect(c: GraphComment, position: GraphPoint = c.position): Rect {
  const lines = c.text.split('\n');
  const w = c.size?.[0] ?? Math.min(400, Math.max(120, Math.max(...lines.map((l) => l.length)) * 7 + 20));
  const h = c.size?.[1] ?? Math.max(40, lines.length * 16 + 20);
  return { x: position[0], y: position[1], w, h };
}

export function groupRect(g: GraphGroup): Rect {
  return { x: g.rect[0], y: g.rect[1], w: g.rect[2], h: g.rect[3] };
}

export const inside = (r: Rect, p: GraphPoint): boolean => p[0] >= r.x && p[0] <= r.x + r.w && p[1] >= r.y && p[1] <= r.y + r.h;
export const overlaps = (a: Rect, b: Rect): boolean => a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
export const contains = (outer: Rect, r: Rect): boolean => r.x >= outer.x && r.y >= outer.y && r.x + r.w <= outer.x + outer.w && r.y + r.h <= outer.y + outer.h;

export function snap(v: number, on: boolean): number {
  return on ? Math.round(v / GRID) * GRID : Math.round(v);
}

/** A wire's cubic segments (through its reroute points), as [p0, c1, c2, p1] tuples. */
export function wireSegments(from: GraphPoint, to: GraphPoint, reroutes: readonly GraphPoint[] = []): [GraphPoint, GraphPoint, GraphPoint, GraphPoint][] {
  const pts = [from, ...reroutes, to];
  const segs: [GraphPoint, GraphPoint, GraphPoint, GraphPoint][] = [];
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i]!;
    const b = pts[i + 1]!;
    const d = Math.max(30, Math.abs(b[0] - a[0]) / 2);
    segs.push([a, [a[0] + d, a[1]], [b[0] - d, b[1]], b]);
  }
  return segs;
}

export function bezierAt(s: [GraphPoint, GraphPoint, GraphPoint, GraphPoint], t: number): GraphPoint {
  const u = 1 - t;
  const [p0, p1, p2, p3] = s;
  return [
    u * u * u * p0[0] + 3 * u * u * t * p1[0] + 3 * u * t * t * p2[0] + t * t * t * p3[0],
    u * u * u * p0[1] + 3 * u * u * t * p1[1] + 3 * u * t * t * p2[1] + t * t * t * p3[1],
  ];
}

/** Distance from `p` to a wire (sampled), in graph units. */
export function wireDistance(segs: readonly [GraphPoint, GraphPoint, GraphPoint, GraphPoint][], p: GraphPoint): number {
  let best = Infinity;
  for (const s of segs) {
    let prev = s[0];
    for (let i = 1; i <= 16; i++) {
      const q = bezierAt(s, i / 16);
      best = Math.min(best, segmentDistance(prev, q, p));
      prev = q;
    }
  }
  return best;
}

function segmentDistance(a: GraphPoint, b: GraphPoint, p: GraphPoint): number {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const len = dx * dx + dy * dy;
  const t = len === 0 ? 0 : Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len));
  return Math.hypot(a[0] + t * dx - p[0], a[1] + t * dy - p[1]);
}

/** The bounds of items (graph units), or null for none. */
export function boundsOf(rects: readonly Rect[]): Rect | null {
  if (rects.length === 0) return null;
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const r of rects) {
    x0 = Math.min(x0, r.x);
    y0 = Math.min(y0, r.y);
    x1 = Math.max(x1, r.x + r.w);
    y1 = Math.max(y1, r.y + r.h);
  }
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

export interface View {
  /** Screen = graph × zoom + (x, y). */
  x: number;
  y: number;
  zoom: number;
}

export const MIN_ZOOM = 0.1;
export const MAX_ZOOM = 2.5;

/** Zoom by `factor` keeping the graph point under the screen point (sx, sy) fixed. */
export function zoomAt(v: View, sx: number, sy: number, factor: number): View {
  const zoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, v.zoom * factor));
  const gx = (sx - v.x) / v.zoom;
  const gy = (sy - v.y) / v.zoom;
  return { zoom, x: sx - gx * zoom, y: sy - gy * zoom };
}

/** The view that shows `r` in a `w`×`h` screen with a margin (zoom capped at 1). */
export function fitView(r: Rect, w: number, h: number, margin = 40): View {
  const zoom = Math.min(1, Math.max(MIN_ZOOM, Math.min((w - 2 * margin) / Math.max(1, r.w), (h - 2 * margin) / Math.max(1, r.h))));
  return { zoom, x: w / 2 - (r.x + r.w / 2) * zoom, y: h / 2 - (r.y + r.h / 2) * zoom };
}

export const toGraph = (v: View, sx: number, sy: number): GraphPoint => [(sx - v.x) / v.zoom, (sy - v.y) / v.zoom];

// ---- edit builders --------------------------------------------------------------------------

/** A fresh item id no item of `graph` uses (and none of `extra`). */
export function makeIdFactory(graph: GraphData, prefix = 'n'): () => string {
  const used = new Set<string>([...graph.nodes.map((n) => n.id), ...graph.edges.map((e) => e.id), ...(graph.groups ?? []).map((g) => g.id), ...(graph.comments ?? []).map((c) => c.id)]);
  const stamp = Date.now().toString(36).slice(-5);
  let i = 0;
  return () => {
    let id: string;
    do id = `${prefix}${stamp}${(i++).toString(36)}`;
    while (used.has(id));
    used.add(id);
    return id;
  };
}

/** What the clipboard holds: a self-contained piece of a graph of one kind. */
export interface GraphClipboard {
  kind: string;
  nodes: GraphNode[];
  /** Only edges between copied nodes. */
  edges: GraphEdge[];
  groups: GraphGroup[];
  comments: GraphComment[];
}

/** `fixedTypes`: node types that are part of every graph of the kind (phase 16.2) — never copied. */
export function copyItems(kind: string, graph: GraphData, ids: ReadonlySet<string>, fixedTypes: ReadonlySet<string> = new Set()): GraphClipboard {
  const nodes = graph.nodes.filter((n) => ids.has(n.id) && !fixedTypes.has(n.type)).map(clone);
  const kept = new Set(nodes.map((n) => n.id));
  return {
    kind,
    nodes,
    edges: graph.edges.filter((e) => kept.has(e.from.node) && kept.has(e.to.node)).map(clone),
    groups: (graph.groups ?? []).filter((g) => ids.has(g.id)).map(clone),
    comments: (graph.comments ?? []).filter((c) => ids.has(c.id)).map(clone),
  };
}

/**
 * Paste a piece with fresh ids (edges remapped to the new node ids; edges to
 * nodes outside the piece never travel), placed with its top-left at `at` or
 * shifted by `offset`. One graphEdit; returns the ops and the new ids.
 */
export function pasteItems(clip: GraphClipboard, newId: () => string, place: { at: GraphPoint } | { offset: GraphPoint }): { ops: GraphOp[]; ids: string[] } {
  const xs = [...clip.nodes.map((n) => n.position[0]), ...clip.comments.map((c) => c.position[0]), ...clip.groups.map((g) => g.rect[0])];
  const ys = [...clip.nodes.map((n) => n.position[1]), ...clip.comments.map((c) => c.position[1]), ...clip.groups.map((g) => g.rect[1])];
  const [dx, dy] = 'at' in place ? [place.at[0] - (xs.length > 0 ? Math.min(...xs) : 0), place.at[1] - (ys.length > 0 ? Math.min(...ys) : 0)] : place.offset;
  const map = new Map<string, string>();
  const idFor = (old: string): string => {
    let id = map.get(old);
    if (id === undefined) {
      id = newId();
      map.set(old, id);
    }
    return id;
  };
  const nodes = clip.nodes.map((n) => ({ ...clone(n), id: idFor(n.id), position: [n.position[0] + dx, n.position[1] + dy] as GraphPoint }));
  const edges = clip.edges
    .filter((e) => map.has(e.from.node) && map.has(e.to.node))
    .map((e) => {
      const { reroutes, ...rest } = clone(e);
      return {
        ...rest,
        id: idFor(e.id),
        from: { node: map.get(e.from.node)!, port: e.from.port },
        to: { node: map.get(e.to.node)!, port: e.to.port },
        ...(reroutes !== undefined ? { reroutes: reroutes.map((p) => [p[0] + dx, p[1] + dy] as GraphPoint) } : {}),
      };
    });
  const groups = clip.groups.map((g) => ({ ...clone(g), id: idFor(g.id), rect: [g.rect[0] + dx, g.rect[1] + dy, g.rect[2], g.rect[3]] as GraphGroup['rect'] }));
  const comments = clip.comments.map((c) => ({ ...clone(c), id: idFor(c.id), position: [c.position[0] + dx, c.position[1] + dy] as GraphPoint }));
  const ops: GraphOp[] = [];
  if (nodes.length > 0) ops.push({ op: 'addNodes', nodes });
  if (edges.length > 0) ops.push({ op: 'connect', edges });
  if (groups.length > 0) ops.push({ op: 'setGroups', groups });
  if (comments.length > 0) ops.push({ op: 'setComments', comments });
  return { ops, ids: [...nodes.map((n) => n.id), ...groups.map((g) => g.id), ...comments.map((c) => c.id)] };
}

/** Delete a selection (nodes take their edges; selected edges, groups and comments go too). */
export function deleteOps(graph: GraphData, ids: ReadonlySet<string>, fixedTypes: ReadonlySet<string> = new Set()): GraphOp[] {
  const nodeIds = graph.nodes.filter((n) => ids.has(n.id) && !fixedTypes.has(n.type)).map((n) => n.id);
  const gone = new Set(nodeIds);
  const edgeIds = graph.edges.filter((e) => ids.has(e.id) && !gone.has(e.from.node) && !gone.has(e.to.node)).map((e) => e.id);
  const groupIds = (graph.groups ?? []).filter((g) => ids.has(g.id)).map((g) => g.id);
  const commentIds = (graph.comments ?? []).filter((c) => ids.has(c.id)).map((c) => c.id);
  const ops: GraphOp[] = [];
  if (edgeIds.length > 0) ops.push({ op: 'disconnect', ids: edgeIds });
  if (nodeIds.length > 0) ops.push({ op: 'removeNodes', ids: nodeIds });
  if (groupIds.length > 0) ops.push({ op: 'removeGroups', ids: groupIds });
  if (commentIds.length > 0) ops.push({ op: 'removeComments', ids: commentIds });
  return ops;
}

export type Alignment = 'left' | 'right' | 'top' | 'bottom' | 'centerX' | 'centerY' | 'distributeX' | 'distributeY';

/** Align or distribute the selected nodes (one moveNodes; null when nothing moves). */
export function alignOps(kind: GraphKindDef, graph: GraphData, ids: ReadonlySet<string>, how: Alignment, snapOn: boolean, portsOf?: PortsOf): GraphOp | null {
  const nodes = graph.nodes.filter((n) => ids.has(n.id));
  if (nodes.length < 2) return null;
  const rects = nodes.map((n) => ({ n, r: nodeRect(kind, n, n.position, portsOf) }));
  const moves: { id: string; position: GraphPoint }[] = [];
  const b = boundsOf(rects.map((x) => x.r))!;
  if (how === 'distributeX' || how === 'distributeY') {
    const horiz = how === 'distributeX';
    const sorted = [...rects].sort((a, c) => (horiz ? a.r.x - c.r.x : a.r.y - c.r.y));
    const total = sorted.reduce((s, x) => s + (horiz ? x.r.w : x.r.h), 0);
    const gap = ((horiz ? b.w : b.h) - total) / (sorted.length - 1);
    let at = horiz ? b.x : b.y;
    for (const x of sorted) {
      const pos: GraphPoint = horiz ? [snap(at, snapOn), x.n.position[1]] : [x.n.position[0], snap(at, snapOn)];
      if (pos[0] !== x.n.position[0] || pos[1] !== x.n.position[1]) moves.push({ id: x.n.id, position: pos });
      at += (horiz ? x.r.w : x.r.h) + gap;
    }
  } else {
    for (const { n, r } of rects) {
      let [x, y] = n.position;
      if (how === 'left') x = b.x;
      if (how === 'right') x = b.x + b.w - r.w;
      if (how === 'top') y = b.y;
      if (how === 'bottom') y = b.y + b.h - r.h;
      if (how === 'centerX') x = snap(b.x + b.w / 2 - r.w / 2, snapOn);
      if (how === 'centerY') y = snap(b.y + b.h / 2 - r.h / 2, snapOn);
      if (x !== n.position[0] || y !== n.position[1]) moves.push({ id: n.id, position: [x, y] });
    }
  }
  return moves.length > 0 ? { op: 'moveNodes', moves } : null;
}

/** A group framing the selected nodes and comments (null when none is selected). */
export function groupAround(kind: GraphKindDef, graph: GraphData, ids: ReadonlySet<string>, id: string, color: string, title = 'Group', portsOf?: PortsOf): GraphGroup | null {
  const rects = [...graph.nodes.filter((n) => ids.has(n.id)).map((n) => nodeRect(kind, n, n.position, portsOf)), ...(graph.comments ?? []).filter((c) => ids.has(c.id)).map((c) => commentRect(c))];
  const b = boundsOf(rects);
  if (b === null) return null;
  const pad = 20;
  return { id, title, color, rect: [b.x - pad, b.y - pad - GROUP_HEADER, b.w + 2 * pad, b.h + 2 * pad + GROUP_HEADER] };
}

/** The nodes and comments inside a group's frame (they move with it). */
export function itemsInGroup(kind: GraphKindDef, graph: GraphData, g: GraphGroup, portsOf?: PortsOf): string[] {
  const r = groupRect(g);
  return [...graph.nodes.filter((n) => contains(r, nodeRect(kind, n, n.position, portsOf))).map((n) => n.id), ...(graph.comments ?? []).filter((c) => contains(r, commentRect(c))).map((c) => c.id)];
}

/** Phase 16.2: the kind's fixed node types (in every graph once; never added, copied or deleted). */
export function fixedTypesOf(kind: GraphKindDef): ReadonlySet<string> {
  return new Set(kind.nodes.filter((d) => d.fixed === true).map((d) => d.type));
}

/** Default values of a new node's fields are not stored (absent = default). */
export function newNode(def: GraphNodeDef, id: string, position: GraphPoint): GraphNode {
  return { id, type: def.type, position };
}
