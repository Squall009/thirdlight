/**
 * Phase 19.0/19.1: visual scripts — the `behavior` graph kinds, their
 * validation context and the compile checks.
 *
 * A visual script is a behavior record whose `graph` holds a node graph of
 * kind `behavior` (owner kind `behavior`, edited with the generic
 * `graphEdit`); its functions are the record's `functions` (kind
 * `behavior-function`, owner id `<behaviorId>#<functionId>`) and shared
 * functions are standalone graphs of kind `behavior-library`. The backend
 * compiles a script to TypeScript and feeds that to the one behavior compiler
 * (`behavior-build`), so a graph behavior runs, is sandboxed and exports
 * exactly like a TypeScript behavior. The catalogue is behavior-graph-nodes.ts.
 *
 * Wiring rules (the generic validator enforces them from the kind data):
 * exec ports connect only to exec ports; every exec output takes one wire;
 * exec inputs take many; data inputs take one wire and outputs fan out; a
 * graph has no cycles (`allowCycles: false`), so repetition exists only
 * inside the bounded loop nodes. An unconnected data input reads the node's
 * field of the same key (its inline value).
 *
 * Semantic rules that depend on node data (variable names and kinds, calls,
 * phases, the objects a script moves, empty required names) are compile
 * diagnostics (`checkBehaviorGraph`), never edit refusals: a graph is edited
 * through incomplete states.
 */
import type { GraphContext, GraphData, GraphEdge, GraphNode, GraphValue } from './graph';
import { graphInterface, nodeDef } from './graph';
import type { BehaviorApiNodeSpec } from './behavior-api';
import type { DeclaredProperty, PropertyDeclaration } from './types-v2';
import {
  BEHAVIOR_API_NODES,
  BEHAVIOR_FUNCTION_GRAPH_KIND,
  BEHAVIOR_FUNCTION_KIND,
  BEHAVIOR_GRAPH_KIND,
  BEHAVIOR_GRAPH_LIMITS,
  BEHAVIOR_LIBRARY_GRAPH_KIND,
  BEHAVIOR_LIBRARY_KIND,
  BEHAVIOR_VARIABLE_KINDS,
  REQUIRED_CORE_FIELDS,
  VARIABLE_PORT_TYPE,
  VARIABLE_PROPERTY_TYPE,
  type BehaviorVariableKind,
} from './behavior-graph-nodes';

export * from './behavior-graph-nodes';

/** Property keys (a variable's name is its property key). */
export const BEHAVIOR_VARIABLE_NAME_RE = /^[a-z][a-z0-9_]{0,63}$/;
/** A function id inside a script (the project-model id syntax). */
export const BEHAVIOR_FUNCTION_ID_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const ENTITY_ID_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;

// ---- records -------------------------------------------------------------------------------

/** Phase 19.1: one function inside a visual script (`BehaviorRecord.functions`). */
export interface BehaviorFunctionRecord {
  functionId: string;
  graph: GraphData;
}

/** What a script's graphs may call and read besides themselves. */
export interface BehaviorScriptEnv {
  /** The script's functions (`BehaviorRecord.functions`). */
  functions?: unknown;
  /** The project's standalone graphs (`content.graphs`; the shared functions are those of kind `behavior-library`). */
  graphs?: unknown;
  /** For a function of the script: the script's own graph (its variables are readable). */
  script?: unknown;
}

// ---- small helpers ---------------------------------------------------------------------------

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
const byPosition = (a: GraphNode, b: GraphNode): number => a.position[1] - b.position[1] || a.position[0] - b.position[0] || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/** Nodes of a graph as it is (malformed ones skipped; validation reports them). */
function nodesOf(graph: unknown): GraphNode[] {
  const nodes = isObj(graph) && Array.isArray(graph['nodes']) ? (graph['nodes'] as unknown[]) : [];
  return nodes.filter((n): n is GraphNode => isObj(n) && typeof n['id'] === 'string' && typeof n['type'] === 'string' && Array.isArray(n['position']) && (n['data'] === undefined || isObj(n['data'])));
}

function field(node: GraphNode, key: string, fallback: GraphValue): GraphValue {
  const v = node.data?.[key];
  return v === undefined ? fallback : v;
}

/** The variable kind a declaration node type declares (`var.number` → number), or null. */
export function variableTypeOf(nodeType: string): BehaviorVariableKind | null {
  const k = nodeType.startsWith('var.') ? nodeType.slice(4) : '';
  return (BEHAVIOR_VARIABLE_KINDS as readonly string[]).includes(k) ? (k as BehaviorVariableKind) : null;
}

/** A Get/Set variable node type (`var.get` / `var.set`). */
export const isVariableAccess = (nodeType: string): boolean => nodeType === 'var.get' || nodeType === 'var.set';

/** Variable declaration nodes in declaration order: top to bottom, then left to right, then id. */
export function variableNodesOf(graph: GraphData): GraphNode[] {
  return nodesOf(graph)
    .filter((n) => variableTypeOf(n.type) !== null)
    .sort(byPosition);
}

/** The first declaration of each variable name (declaration order). */
function declarations(graph: unknown): Map<string, GraphNode> {
  const out = new Map<string, GraphNode>();
  for (const n of nodesOf(graph).filter((x) => variableTypeOf(x.type) !== null).sort(byPosition)) {
    const name = n.data?.['name'];
    if (typeof name === 'string' && name !== '' && !out.has(name)) out.set(name, n);
  }
  return out;
}

/** A variable's visibility: public/private (a property of each object) or local (one event run / call). In a function every variable is local. */
export function variableVisibility(n: GraphNode, inFunction = false): 'public' | 'private' | 'local' {
  if (inFunction) return 'local';
  const k = variableTypeOf(n.type);
  const v = field(n, 'visibility', k === 'list' || k === 'map' ? 'private' : 'public');
  return v === 'private' || v === 'local' ? v : 'public';
}

/** The choices of an enum variable (its comma-separated `options`). */
export function enumOptions(n: GraphNode): string[] {
  return String(field(n, 'options', ''))
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s !== '');
}

/** The standalone graph of `kind`/`id` among `graphs` (as it is), or null. */
function standalone(graphs: unknown, kind: string, id: string): GraphData | null {
  const docs = Array.isArray(graphs) ? graphs : [];
  const d = docs.find((x) => isObj(x) && x['graphId'] === id && x['kind'] === kind) as Record<string, unknown> | undefined;
  const g = d?.['graph'];
  return isObj(g) && Array.isArray(g['nodes']) ? { nodes: nodesOf(g), edges: Array.isArray(g['edges']) ? (g['edges'] as GraphEdge[]) : [] } : null;
}

/** A script function by id (as it is), or null. */
function localFunction(functions: unknown, id: string): GraphData | null {
  const list = Array.isArray(functions) ? functions : [];
  const f = list.find((x) => isObj(x) && x['functionId'] === id) as Record<string, unknown> | undefined;
  const g = f?.['graph'];
  return isObj(g) && Array.isArray(g['nodes']) ? { nodes: nodesOf(g), edges: Array.isArray(g['edges']) ? (g['edges'] as GraphEdge[]) : [] } : null;
}

/**
 * The validation context of a script graph or function graph: the
 * `variable` lookup types a Get/Set variable's value port by the variable
 * its `variable` field names (the graph's own first declaration of that
 * name, else — in a script function — the script's); `graph` resolves calls
 * (`behavior-function`: the script's functions, `behavior-library`: the
 * project's shared functions). Read from the data as it is.
 */
export function behaviorGraphContext(graph: unknown, env: BehaviorScriptEnv = {}): GraphContext {
  const own = declarations(graph);
  const script = env.script !== undefined ? declarations(env.script) : new Map<string, GraphNode>();
  return {
    lookup: (name, value) => {
      if (name !== 'variable') return null;
      const n = own.get(value) ?? script.get(value);
      return n === undefined ? null : VARIABLE_PORT_TYPE[variableTypeOf(n.type)!];
    },
    graph: (kind, id) => {
      if (kind === BEHAVIOR_FUNCTION_KIND) {
        const g = localFunction(env.functions, id);
        return g === null ? null : { kind: BEHAVIOR_FUNCTION_GRAPH_KIND, graph: g };
      }
      if (kind === BEHAVIOR_LIBRARY_KIND) {
        const g = standalone(env.graphs, BEHAVIOR_LIBRARY_KIND, id);
        return g === null ? null : { kind: BEHAVIOR_LIBRARY_GRAPH_KIND, graph: g };
      }
      return null;
    },
  };
}

/** The value a Set variable's inline text means for a variable of kind k, or an error. */
export function parseVariableValue(k: BehaviorVariableKind, text: string, options: readonly string[] = []): { ok: true; value: GraphValue | null } | { ok: false; message: string } {
  if (k === 'string' || k === 'entity') return { ok: true, value: text };
  if (k === 'enum') return text === '' || options.includes(text) ? { ok: true, value: text === '' ? (options[0] ?? '') : text } : { ok: false, message: `"${text}" is not one of ${options.join(', ')}` };
  if (k === 'boolean') return text === '' || text === 'false' ? { ok: true, value: false } : text === 'true' ? { ok: true, value: true } : { ok: false, message: `"${text}" is not true or false` };
  if (k === 'list' || k === 'map') return text.trim() === '' ? { ok: true, value: null } : { ok: false, message: `a ${k} variable is set from a wire (unwired it becomes empty)` };
  if (k === 'vector') {
    if (text.trim() === '') return { ok: true, value: [0, 0, 0] };
    const parts = text.split(',').map((s) => Number(s.trim()));
    return parts.length === 3 && parts.every(Number.isFinite) ? { ok: true, value: parts } : { ok: false, message: `"${text}" is not three numbers "x, y, z"` };
  }
  if (text.trim() === '') return { ok: true, value: 0 };
  const v = Number(text);
  return Number.isFinite(v) ? { ok: true, value: v } : { ok: false, message: `"${text}" is not a number` };
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

/** The declared property one variable node makes, or null (a local variable, a list or a map). */
export function variableProperty(n: GraphNode): DeclaredProperty | null {
  const k = variableTypeOf(n.type);
  const type = k !== null ? VARIABLE_PROPERTY_TYPE[k] : undefined;
  if (k === null || type === undefined || variableVisibility(n) === 'local') return null;
  const name = String(field(n, 'name', ''));
  const label = String(field(n, 'label', ''));
  const group = String(field(n, 'group', ''));
  const tooltip = String(field(n, 'tooltip', ''));
  let dflt: DeclaredProperty['default'];
  if (k === 'entity') dflt = String(field(n, 'default', '')) === '' ? null : String(field(n, 'default', ''));
  else if (k === 'enum') {
    const d = String(field(n, 'default', ''));
    dflt = d === '' ? (enumOptions(n)[0] ?? '') : d;
  } else if (k === 'vector') {
    const v = field(n, 'default', [0, 0, 0]);
    dflt = (Array.isArray(v) ? v : [0, 0, 0]) as [number, number, number];
  } else dflt = field(n, 'default', k === 'number' ? 0 : k === 'boolean' ? false : '') as DeclaredProperty['default'];
  const p: DeclaredProperty = { key: name, label: label !== '' ? label : variableLabel(name).slice(0, 64), type, default: dflt };
  if (k === 'enum') p.values = enumOptions(n);
  if (variableVisibility(n) === 'private') p.visibility = 'private';
  if (group !== '') p.group = group;
  if (tooltip !== '') p.tooltip = tooltip;
  return p;
}

/**
 * The declaration a script's variables make: one declared property per
 * public or private variable of a property kind (declaration order); local
 * variables, lists and maps are no properties.
 */
export function behaviorGraphDeclaration(graph: GraphData): PropertyDeclaration {
  return { properties: variableNodesOf(graph).map(variableProperty).filter((p): p is DeclaredProperty => p !== null) };
}

// ---- API entries ---------------------------------------------------------------------------

const API_BY_TYPE = new Map(BEHAVIOR_API_NODES.map((s) => [s.type, s]));
/** The API entry of a node type, or undefined. */
export function behaviorApiSpec(type: string): BehaviorApiNodeSpec | undefined {
  return API_BY_TYPE.get(type);
}

// ---- the script as a whole (graphs, calls, phases) -----------------------------------------

export interface BehaviorGraphProblem {
  severity: 'error' | 'warning';
  /** The node the problem is on (absent: the whole graph). In a function: `fn:<functionId>/<nodeId>`; in a shared function: `lib:<graphId>/<nodeId>`. */
  nodeId?: string;
  message: string;
}

/** One graph of a script: the script itself, one of its functions or a shared function it calls. */
export interface BehaviorScriptGraph {
  /** '' (the script), `fn:<functionId>` or `lib:<graphId>`. */
  scope: string;
  kind: typeof BEHAVIOR_GRAPH_KIND;
  graph: GraphData;
  ctx: GraphContext;
}

/** The node id as problems and run-time errors name it (`fn:<functionId>/<nodeId>` inside a function). */
export const scopedNodeId = (scope: string, id: string): string => (scope === '' ? id : `${scope}/${id}`);

/**
 * Every graph a script consists of: the script, its functions, and the
 * shared functions it calls (transitively), each with its validation
 * context. Missing or malformed callees are skipped (the checks report them).
 */
export function behaviorScriptGraphs(graph: GraphData, env: BehaviorScriptEnv = {}): BehaviorScriptGraph[] {
  const out: BehaviorScriptGraph[] = [{ scope: '', kind: BEHAVIOR_GRAPH_KIND, graph, ctx: behaviorGraphContext(graph, env) }];
  const list = Array.isArray(env.functions) ? env.functions : [];
  for (const f of list) {
    if (!isObj(f) || typeof f['functionId'] !== 'string') continue;
    const g = localFunction(list, f['functionId']);
    if (g !== null) out.push({ scope: `fn:${f['functionId']}`, kind: BEHAVIOR_FUNCTION_GRAPH_KIND, graph: g, ctx: behaviorGraphContext(g, { ...env, script: graph }) });
  }
  const seen = new Set<string>();
  const queue = [...out];
  while (queue.length > 0) {
    const sg = queue.shift()!;
    for (const n of sg.graph.nodes) {
      if (n.type !== 'fn.library') continue;
      const id = String(field(n, 'function', ''));
      if (id === '' || seen.has(id)) continue;
      seen.add(id);
      const g = standalone(env.graphs, BEHAVIOR_LIBRARY_KIND, id);
      if (g === null) continue;
      const lib: BehaviorScriptGraph = { scope: `lib:${id}`, kind: BEHAVIOR_LIBRARY_GRAPH_KIND, graph: g, ctx: behaviorGraphContext(g, { graphs: env.graphs }) };
      out.push(lib);
      queue.push(lib);
    }
  }
  return out;
}

/** The scope a call node calls (`fn:<id>` / `lib:<id>`), or null. */
export function calleeScope(n: GraphNode): string | null {
  const id = String(field(n, 'function', ''));
  if (id === '') return null;
  return n.type === 'fn.call' ? `fn:${id}` : n.type === 'fn.library' ? `lib:${id}` : null;
}

function execOutputs(sg: BehaviorScriptGraph, n: GraphNode): Set<string> {
  const d = nodeDef(sg.kind, n.type);
  return new Set((d?.outputs ?? []).filter((p) => p.type === 'exec').map((p) => p.id));
}

/** The exec nodes each root reaches (following exec wires) in one graph. */
function reach(sg: BehaviorScriptGraph, roots: readonly string[]): Set<string> {
  const out = new Set<string>();
  const byNode = new Map(sg.graph.nodes.map((n) => [n.id, n]));
  const queue = [...roots];
  while (queue.length > 0) {
    const id = queue.pop()!;
    if (out.has(id)) continue;
    out.add(id);
    const n = byNode.get(id);
    if (n === undefined) continue;
    const execs = execOutputs(sg, n);
    for (const e of sg.graph.edges) if (e.from.node === id && execs.has(e.from.port)) queue.push(e.to.node);
  }
  return out;
}

/** An event node's phase. */
export const eventPhase = (n: GraphNode): 'intent' | 'transform' => (field(n, 'phase', 'intent') === 'transform' ? 'transform' : 'intent');

/**
 * The phases each exec node of each graph may run in: from the script's
 * events along the exec wires, into the functions a call reaches (a
 * function runs in the phases of its calls).
 */
export function behaviorNodePhases(graphs: readonly BehaviorScriptGraph[]): Map<string, Set<'intent' | 'transform'>> {
  const out = new Map<string, Set<'intent' | 'transform'>>();
  const byScope = new Map(graphs.map((g) => [g.scope, g]));
  const add = (key: string, p: 'intent' | 'transform'): boolean => {
    const s = out.get(key) ?? new Set();
    if (s.has(p)) return false;
    s.add(p);
    out.set(key, s);
    return true;
  };
  const queue: { scope: string; roots: string[]; phase: 'intent' | 'transform' }[] = [];
  const main = byScope.get('');
  if (main !== undefined) for (const n of main.graph.nodes) if (n.type.startsWith('event.')) queue.push({ scope: '', roots: [n.id], phase: eventPhase(n) });
  let guard = 0;
  while (queue.length > 0 && guard++ < 10_000) {
    const { scope, roots, phase } = queue.shift()!;
    const sg = byScope.get(scope);
    if (sg === undefined) continue;
    const byNode = new Map(sg.graph.nodes.map((n) => [n.id, n]));
    for (const id of reach(sg, roots)) {
      if (!add(scopedNodeId(scope, id), phase)) continue;
      const n = byNode.get(id);
      const callee = n !== undefined ? calleeScope(n) : null;
      const target = callee !== null ? byScope.get(callee) : undefined;
      if (target !== undefined) {
        const entries = target.graph.nodes.filter((x) => x.type === 'fn.entry').map((x) => x.id);
        queue.push({ scope: target.scope, roots: entries, phase });
      }
    }
  }
  return out;
}

/**
 * The entities a script moves (its `ownedTransforms`): `@self` for a
 * Move/Pose node whose entity is empty (this object), else the typed id.
 */
export function behaviorOwnedTransforms(graphs: readonly BehaviorScriptGraph[]): string[] {
  const out = new Set<string>();
  for (const sg of graphs) {
    const wired = new Set(sg.graph.edges.map((e) => `${e.to.node}\u0000${e.to.port}`));
    for (const n of sg.graph.nodes) {
      const spec = behaviorApiSpec(n.type);
      if (spec?.moves === undefined || wired.has(`${n.id}\u0000${spec.moves}`)) continue;
      const id = String(field(n, spec.moves, ''));
      if (id === '') out.add('@self');
      else if (ENTITY_ID_RE.test(id)) out.add(id);
    }
  }
  return [...out].sort();
}

// ---- compile checks ------------------------------------------------------------------------

/**
 * The compile diagnostics of a structurally valid script (its graph, its
 * functions and the shared functions it calls): variable names, kinds and
 * choices; at most 32 properties; Get/Set naming a declared variable; Set
 * values; required texts; function calls (an existing function, no call
 * cycles, interface names that do not hide the call's own ports); the
 * phases API nodes and Delays run in; the objects Move/Pose nodes move.
 * Warnings: flow nodes nothing reaches, a transform-phase event in a script
 * that moves nothing.
 */
export function checkBehaviorGraph(graph: GraphData, env: BehaviorScriptEnv = {}): BehaviorGraphProblem[] {
  const out: BehaviorGraphProblem[] = [];
  const graphs = behaviorScriptGraphs(graph, env);
  const scriptDecls = declarations(graph);
  const functionList = Array.isArray(env.functions) ? env.functions : [];
  if (functionList.length > BEHAVIOR_GRAPH_LIMITS.functions) out.push({ severity: 'error', message: `a script has at most ${BEHAVIOR_GRAPH_LIMITS.functions} functions` });
  for (const sg of graphs) checkOne(sg, sg.scope === '' ? new Map() : sg.scope.startsWith('fn:') ? scriptDecls : new Map(), out);

  // Properties: at most 32 (a behavior declares 0–32).
  const props = variableNodesOf(graph).filter((n) => variableProperty(n) !== null);
  if (props.length > BEHAVIOR_GRAPH_LIMITS.variables) out.push({ severity: 'error', nodeId: props[BEHAVIOR_GRAPH_LIMITS.variables]!.id, message: `a script has at most ${BEHAVIOR_GRAPH_LIMITS.variables} public and private variables (its properties)` });

  // Calls: an existing function, and no call cycles.
  const byScope = new Map(graphs.map((g) => [g.scope, g]));
  const calls = new Map<string, { node: string; to: string }[]>();
  for (const sg of graphs) {
    const list: { node: string; to: string }[] = [];
    for (const n of sg.graph.nodes) {
      const callee = calleeScope(n);
      if (n.type !== 'fn.call' && n.type !== 'fn.library') continue;
      if (callee === null || !byScope.has(callee)) out.push({ severity: 'error', nodeId: scopedNodeId(sg.scope, n.id), message: n.type === 'fn.call' ? 'choose one of this script\'s functions' : 'choose a shared function of the project' });
      else list.push({ node: n.id, to: callee });
    }
    calls.set(sg.scope, list);
  }
  const state = new Map<string, 1 | 2>();
  const visit = (scope: string, path: string[]): void => {
    state.set(scope, 1);
    for (const c of calls.get(scope) ?? []) {
      if (state.get(c.to) === 1) {
        out.push({ severity: 'error', nodeId: scopedNodeId(scope, c.node), message: `functions cannot call each other in a cycle (${[...path, c.to].map((s) => s || 'script').join(' → ')})` });
        continue;
      }
      if (state.get(c.to) === undefined) visit(c.to, [...path, c.to]);
    }
    state.set(scope, 2);
  };
  for (const sg of graphs) if (state.get(sg.scope) === undefined) visit(sg.scope, [sg.scope]);

  // Phases: API nodes valid in one phase, Delays in one phase.
  const phases = behaviorNodePhases(graphs);
  for (const sg of graphs) {
    for (const n of sg.graph.nodes) {
      const key = scopedNodeId(sg.scope, n.id);
      const ph = phases.get(key);
      if (ph === undefined) continue;
      const spec = behaviorApiSpec(n.type);
      if (spec?.phase !== undefined && [...ph].some((p) => p !== spec.phase)) {
        out.push({ severity: 'error', nodeId: key, message: `"${spec.label}" runs only in the ${spec.phase} phase: reach it from events whose phase is ${spec.phase}` });
      }
      if (n.type === 'flow.delay' && ph.size > 1) out.push({ severity: 'error', nodeId: key, message: 'a Delay continues in one phase: reach it from events of one phase only' });
    }
  }

  // Moved objects: the entity of a Move/Pose node is typed in (empty: this object).
  for (const sg of graphs) {
    const wired = new Set(sg.graph.edges.map((e) => `${e.to.node}\u0000${e.to.port}`));
    for (const n of sg.graph.nodes) {
      const spec = behaviorApiSpec(n.type);
      if (spec?.moves === undefined) continue;
      if (wired.has(`${n.id}\u0000${spec.moves}`)) {
        out.push({ severity: 'error', nodeId: scopedNodeId(sg.scope, n.id), message: `type the entity "${spec.label}" moves (empty: this object) instead of wiring it: a script declares the objects it moves` });
        continue;
      }
      const id = String(field(n, spec.moves, ''));
      if (id !== '' && !ENTITY_ID_RE.test(id)) out.push({ severity: 'error', nodeId: scopedNodeId(sg.scope, n.id), message: `"${id}" is not an entity id` });
    }
  }
  const owned = behaviorOwnedTransforms(graphs);
  if (owned.length > 16) out.push({ severity: 'error', message: `a script moves at most 16 objects (it moves ${owned.length})` });
  if (owned.length === 0) {
    for (const n of graph.nodes) {
      if (n.type.startsWith('event.') && eventPhase(n) === 'transform') out.push({ severity: 'warning', nodeId: n.id, message: 'the transform phase runs only for scripts that move objects (Move/Pose object): this event never runs' });
    }
  }
  return out;
}

/** The per-graph checks. `outer`: the script's variables a function may use. */
function checkOne(sg: BehaviorScriptGraph, outer: Map<string, GraphNode>, out: BehaviorGraphProblem[]): void {
  const { graph, scope } = sg;
  const inFunction = scope !== '';
  const at = (id: string): string => scopedNodeId(scope, id);
  const declared = new Map<string, GraphNode>();
  for (const n of variableNodesOf(graph)) {
    const k = variableTypeOf(n.type)!;
    const name = String(field(n, 'name', ''));
    if (!BEHAVIOR_VARIABLE_NAME_RE.test(name)) {
      out.push({ severity: 'error', nodeId: at(n.id), message: `variable name "${name}" must start with a lower-case letter and use a-z, 0-9 and _ (at most 64)` });
      continue;
    }
    if (declared.has(name)) {
      out.push({ severity: 'error', nodeId: at(n.id), message: `a variable named "${name}" is already declared` });
      continue;
    }
    declared.set(name, n);
    for (const key of ['label', 'group', 'tooltip', 'default', 'options'] as const) {
      const v = field(n, key, '');
      if (typeof v === 'string' && !isControlFree(v)) out.push({ severity: 'error', nodeId: at(n.id), message: `${key} must not contain control characters` });
    }
    if (k === 'enum') {
      const opts = enumOptions(n);
      if (opts.length === 0 || opts.length > 32) out.push({ severity: 'error', nodeId: at(n.id), message: 'a choice variable lists 1-32 choices, comma separated' });
      else if (new Set(opts).size !== opts.length || opts.some((o) => o.length > 64)) out.push({ severity: 'error', nodeId: at(n.id), message: 'choices are unique and at most 64 characters each' });
      const d = String(field(n, 'default', ''));
      if (d !== '' && !opts.includes(d)) out.push({ severity: 'error', nodeId: at(n.id), message: `the default "${d}" is not one of the choices` });
    }
    if (k === 'entity') {
      const d = String(field(n, 'default', ''));
      if (d !== '' && !ENTITY_ID_RE.test(d)) out.push({ severity: 'error', nodeId: at(n.id), message: `the default "${d}" is not an entity id (empty: none)` });
    }
  }
  const wired = new Set(graph.edges.map((e) => `${e.to.node}\u0000${e.to.port}`));
  for (const n of graph.nodes) {
    if (isVariableAccess(n.type)) {
      const name = String(field(n, 'variable', ''));
      const decl = declared.get(name) ?? outer.get(name);
      if (name === '') out.push({ severity: 'error', nodeId: at(n.id), message: 'choose the variable this node reads or writes' });
      else if (decl === undefined) out.push({ severity: 'error', nodeId: at(n.id), message: `no variable named "${name}" is declared` });
      else if (n.type === 'var.set' && !wired.has(`${n.id}\u0000value`)) {
        const k = variableTypeOf(decl.type)!;
        const parsed = parseVariableValue(k, String(field(n, 'value', '')), enumOptions(decl));
        if (!parsed.ok) out.push({ severity: 'error', nodeId: at(n.id), message: `${parsed.message} (the value for variable "${name}")` });
      }
    }
    const spec = behaviorApiSpec(n.type);
    for (const a of spec?.args ?? []) {
      if (a.required === true && !wired.has(`${n.id}\u0000${a.id}`) && String(field(n, a.id, a.default ?? '')) === '') {
        out.push({ severity: 'error', nodeId: at(n.id), message: `fill in the ${a.label} (or wire a text into it)` });
      }
    }
    for (const key of REQUIRED_CORE_FIELDS[n.type] ?? []) {
      if (String(field(n, key, '')) === '') out.push({ severity: 'error', nodeId: at(n.id), message: `fill in the ${nodeDef(sg.kind, n.type)?.fields?.find((f) => f.key === key)?.label.toLowerCase() ?? key}` });
    }
    if (n.type === 'flow.switch' && field(n, 'on', 'text') === 'int') {
      for (let i = 1; i <= BEHAVIOR_GRAPH_LIMITS.switchCases; i++) {
        const c = String(field(n, `case${i}`, '')).trim();
        if (c !== '' && !/^-?\d{1,15}$/.test(c)) out.push({ severity: 'error', nodeId: at(n.id), message: `case ${i} "${c}" is not a whole number` });
      }
      const v = String(field(n, 'value', '')).trim();
      if (!wired.has(`${n.id}\u0000value`) && v !== '' && !Number.isFinite(Number(v))) out.push({ severity: 'error', nodeId: at(n.id), message: `"${v}" is not a number` });
    }
    // A function's Input/Output id is a port id of every call: not the call's own "in"/"then".
    if ((n.type === 'fn.input' || n.type === 'fn.output') && (n.id === 'in' || n.id === 'then')) {
      out.push({ severity: 'error', nodeId: at(n.id), message: `an ${n.type === 'fn.input' ? 'Input' : 'Output'} node cannot have the id "${n.id}" (a call's own port)` });
    }
  }
  if (inFunction && !graph.nodes.some((n) => n.type === 'fn.entry')) out.push({ severity: 'error', message: `function "${scope.slice(scope.indexOf(':') + 1)}" needs a Function start node` });

  // An `any` port (a Get/Set naming no variable) must not join the exec flow.
  for (const e of graph.edges) {
    const from = graph.nodes.find((x) => x.id === e.from.node);
    const to = graph.nodes.find((x) => x.id === e.to.node);
    const fromExec = from !== undefined && nodeDef(sg.kind, from.type)?.outputs.find((p) => p.id === e.from.port)?.type === 'exec';
    const toExec = to !== undefined && nodeDef(sg.kind, to.type)?.inputs.find((p) => p.id === e.to.port)?.type === 'exec';
    if (fromExec !== toExec) out.push({ severity: 'error', nodeId: at(fromExec ? e.to.node : e.from.node), message: 'an exec wire connects only exec ports' });
  }
  // Flow nodes no event (or function start) reaches never run.
  const roots = graph.nodes.filter((n) => n.type.startsWith('event.') || n.type === 'fn.entry').map((n) => n.id);
  const reached = reach(sg, roots);
  for (const n of graph.nodes) {
    const hasExecIn = nodeDef(sg.kind, n.type)?.inputs.some((p) => p.type === 'exec') === true;
    if (hasExecIn && !reached.has(n.id)) out.push({ severity: 'warning', nodeId: at(n.id), message: 'no event reaches this node: it never runs' });
  }
}

/** A function graph's interface (its Input and Output nodes, the call's ports). */
export function behaviorFunctionInterface(sg: BehaviorScriptGraph): ReturnType<typeof graphInterface> {
  return graphInterface(sg.kind, sg.graph);
}
