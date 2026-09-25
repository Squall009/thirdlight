/**
 * Phase 16.1: graph commands.
 *
 * `graphEdit {owner: {kind, id}, ops}` applies a list of generic graph ops
 * (project-model `GraphOp`: addNodes, removeNodes, moveNodes, setNodeData,
 * setCollapsed, connect, disconnect, setReroutes, setGroups, removeGroups,
 * setComments, removeComments) to ONE owner's graph atomically — one
 * revision, one undo step. The result is validated against the owner's graph
 * kind (catalogue, port types, single inputs, cycles, budgets); a refusal
 * changes nothing. The change carries the applied ops, so clients advance
 * their copy from the change alone; the undo carries the inverse ops.
 *
 * Owner kinds say where a graph is stored. `graph` is a standalone document
 * in `content.graphs` (created with `setGraph`, removed with `deleteGraph`).
 * Phase 16.2: `animator` — an animator controller's layers and blend trees
 * (project-model animator-graph.ts): the ops are applied to the graph read
 * from the controller and the result is written back into it, so the
 * command records the same controller change `setAnimator` makes
 * (`setAnimators` previous/next, undone by restoring the previous list).
 * Phase 18.0: `material` — a graph material's graph (`content.materials[i].graph`,
 * owner id = the materialId); the change carries the ops like a standalone
 * graph (a move in a large graph stays a small record). Material functions
 * (18.1) are standalone graphs of kind `material-function`; calls in any
 * graph resolve their ports through the validation context (the project's
 * standalone graphs and, in a material, its exposed parameters).
 * Phase 19.0: `behavior` — a visual script (`BehaviorRecord.graph`, kind
 * `behavior`); the change is the generic `graphEdit` with its ops, undone by
 * the inverse ops. Editing the graph does not touch the published source:
 * publishing compiles it (the behavior source route). Phase 19.1: owner id
 * `<behaviorId>#<functionId>` is one of the script's functions (kind
 * `behavior-function`, `BehaviorRecord.functions`): a function exists while
 * its graph has nodes — an edit that adds nodes to a new id creates it, one
 * that removes its last node removes it (so undo and redo need nothing else).
 * Calls resolve against the script's functions and the project's shared
 * functions (standalone graphs of kind `behavior-library`).
 * Later phases register the effect (20) owner here with
 * the same op set.
 */
import {
  animatorGraphOf,
  applyAnimatorGraph,
  applyGraphOps,
  canonicalAnimators,
  canonicalMaterials,
  graphDocumentsContext,
  materialGraphContext,
  validateGraphDocuments,
  validateMaterialGraph,
  validateMaterials,
  type GraphContext,
  type MaterialDef,
  canonicalGraphDocuments,
  GRAPH_KINDS,
  parseAnimatorOwnerId,
  type AnimatorController,
  type BehaviorRecord,
  type BehaviorFunctionRecord,
  BEHAVIOR_FUNCTION_ID_RE,
  BEHAVIOR_GRAPH_LIMITS,
  behaviorGraphContext,
  validateGraphData,
  validateGraphDocument,
  type GraphData,
  type GraphDocument,
  type GraphKindDef,
  type GraphOp,
  type ModelErrorV2,
} from '@thirdlight/project-model';

import { fieldValue, type CommandError } from './errors';
import { contentOf, type OpInput } from './content-ops';
import { withAnimators } from './material-ops';
import { deepClone, gateResultState, type OpOutcome } from './ops';
import type { ContentDocument, ForwardChange, GraphEditChange, GraphOwner, InverseSpec, SetGraphChange } from './types';

type WithGraphs = ContentDocument & { graphs?: GraphDocument[] };
type WithMaterials = ContentDocument & { materials?: MaterialDef[] };
type WithAnimators = ContentDocument & { animators?: AnimatorController[] };

/** Where an owner kind keeps its graph (and which graph kind it is). */
export interface GraphOwnerAdapter {
  /** The owner's graph and kind (and, phase 18.1, the context it validates in), or null when the owner does not exist. */
  read(content: ContentDocument, id: string): { kind: GraphKindDef; graph: GraphData; ctx?: GraphContext } | null;
  /** The content with the owner's graph replaced, or why the graph does not fit the owner. */
  write(content: ContentDocument, id: string, graph: GraphData): ContentDocument | { refused: string };
  /**
   * Phase 16.2: the change and undo an edit records when the owner stores its
   * graph as its own data (absent = a `graphEdit` change with the ops, undone
   * by the inverse ops).
   */
  record?(before: ContentDocument, after: ContentDocument): { change: ForwardChange; inverse: InverseSpec };
  /**
   * Phase 19.0: the context an edited graph validates in when it depends on
   * the graph itself (absent = the context `read` gave) — a visual script's
   * variables type its Get/Set ports, so an edit that adds a variable and
   * wires it validates against the result.
   */
  contextOf?(content: ContentDocument, graph: GraphData, id: string): GraphContext;
}

/** Phase 19.1: `<behaviorId>` (the script) or `<behaviorId>#<functionId>` (one of its functions). */
export function parseBehaviorOwnerId(id: string): { behaviorId: string; functionId: string | null } {
  const i = id.indexOf('#');
  return i < 0 ? { behaviorId: id, functionId: null } : { behaviorId: id.slice(0, i), functionId: id.slice(i + 1) };
}

/** A script's functions with one function's graph set (removed when it has no nodes), sorted by id. */
function withFunction(list: readonly BehaviorFunctionRecord[], functionId: string, graph: GraphData): BehaviorFunctionRecord[] {
  const rest = list.filter((f) => f.functionId !== functionId);
  if (graph.nodes.length > 0) rest.push({ functionId, graph });
  return rest.sort((a, b) => (a.functionId < b.functionId ? -1 : a.functionId > b.functionId ? 1 : 0));
}

/** Phase 19.0: the behavior records (a visual script keeps its graph in its record). */
const behaviorsOf = (content: ContentDocument): BehaviorRecord[] => (content as ContentDocument & { behaviors?: BehaviorRecord[] }).behaviors ?? [];

const animatorsOf = (content: ContentDocument): AnimatorController[] => (content as WithAnimators).animators ?? [];

export const GRAPH_OWNERS: Readonly<Record<string, GraphOwnerAdapter>> = {
  graph: {
    read(content, id) {
      const doc = ((content as WithGraphs).graphs ?? []).find((g) => g.graphId === id);
      const kind = doc !== undefined ? GRAPH_KINDS[doc.kind] : undefined;
      return doc !== undefined && kind !== undefined ? { kind, graph: doc.graph, ctx: graphDocumentsContext(GRAPH_KINDS, (content as WithGraphs).graphs) } : null;
    },
    write(content, id, graph) {
      const list = ((content as WithGraphs).graphs ?? []).map((g) => (g.graphId === id ? { ...g, graph } : g));
      // Phase 18.1: graphs that call this one (material functions) must still fit its interface.
      const why = callersRefusal(content, list);
      if (why !== null) return { refused: why };
      return { ...(content as WithGraphs), graphs: list } as ContentDocument;
    },
  },
  // Phase 18.0: a graph material's graph (owner id = materialId; a material without a graph has none — convert it with setMaterial).
  material: {
    read(content, id) {
      const m = ((content as WithMaterials).materials ?? []).find((x) => x.materialId === id);
      const kind = GRAPH_KINDS['material'];
      if (m === undefined || m.graph === undefined || kind === undefined) return null;
      return { kind, graph: m.graph, ctx: materialGraphContext(m.parameters, graphDocumentsContext(GRAPH_KINDS, (content as WithGraphs).graphs)) };
    },
    write(content, id, graph) {
      const list = ((content as WithMaterials).materials ?? []).map((m) => (m.materialId === id ? { ...m, graph } : m));
      // The material rules (every Parameter node names a declared parameter).
      const m = list.find((x) => x.materialId === id)!;
      const errors: ModelErrorV2[] = [];
      validateMaterialGraph(m as unknown as Record<string, unknown>, '', errors, graphDocumentsContext(GRAPH_KINDS, (content as WithGraphs).graphs));
      if (errors.length > 0) return { refused: `${errors[0]!.message} (at ${errors[0]!.path})` };
      return { ...(content as WithMaterials), materials: canonicalMaterials(list) } as ContentDocument;
    },
  },
  // Phase 16.2: `<controllerId>` (base layer), `<controllerId>@<n>` (override layer n), `<controllerId>#<stateId>` (a blend tree).
  animator: {
    read(content, id) {
      const target = parseAnimatorOwnerId(id);
      const c = target !== null ? animatorsOf(content).find((x) => x.controllerId === target.controllerId) : undefined;
      const r = target !== null && c !== undefined ? animatorGraphOf(c, target) : null;
      const kind = r !== null ? GRAPH_KINDS[r.kindId] : undefined;
      return r !== null && kind !== undefined ? { kind, graph: r.graph } : null;
    },
    write(content, id, graph) {
      const target = parseAnimatorOwnerId(id);
      const list = animatorsOf(content);
      const c = target !== null ? list.find((x) => x.controllerId === target.controllerId) : undefined;
      if (target === null || c === undefined) return { refused: 'no animator controller with this id' };
      const r = applyAnimatorGraph(c, target, graph);
      if (!r.ok) return { refused: r.message };
      return withAnimators(content, canonicalAnimators(list.map((x) => (x.controllerId === c.controllerId ? r.controller : x))));
    },
    record(before, after) {
      const previous = deepClone(animatorsOf(before));
      return { change: { type: 'setAnimators', previous, next: deepClone(animatorsOf(after)) }, inverse: { kind: 'setAnimators', restore: previous } };
    },
  },
  // Phase 19.0: `<behaviorId>` — a visual script's graph (only behaviors that are visual scripts have one);
  // phase 19.1: `<behaviorId>#<functionId>` — one of its functions.
  behavior: {
    read(content, id) {
      const target = parseBehaviorOwnerId(id);
      const b = behaviorsOf(content).find((x) => x.behaviorId === target.behaviorId);
      if (b?.graph === undefined) return null;
      const graphs = (content as WithGraphs).graphs;
      if (target.functionId === null) return { kind: GRAPH_KINDS['behavior']!, graph: b.graph, ctx: behaviorGraphContext(b.graph, { functions: b.functions, graphs }) };
      if (!BEHAVIOR_FUNCTION_ID_RE.test(target.functionId)) return null;
      // A function that does not exist yet reads as an empty graph: the edit that adds its nodes creates it.
      const graph = b.functions?.find((f) => f.functionId === target.functionId)?.graph ?? { nodes: [], edges: [] };
      return { kind: GRAPH_KINDS['behavior-function']!, graph, ctx: behaviorGraphContext(graph, { functions: b.functions, graphs, script: b.graph }) };
    },
    contextOf(content, graph, id) {
      const target = parseBehaviorOwnerId(id);
      const b = behaviorsOf(content).find((x) => x.behaviorId === target.behaviorId);
      const graphs = (content as WithGraphs).graphs;
      if (target.functionId === null) return behaviorGraphContext(graph, { functions: b?.functions, graphs });
      const functions = withFunction(b?.functions ?? [], target.functionId, graph);
      return behaviorGraphContext(graph, { functions, graphs, script: b?.graph });
    },
    write(content, id, graph) {
      const target = parseBehaviorOwnerId(id);
      let refused: string | null = null;
      const list = behaviorsOf(content).map((b) => {
        if (b.behaviorId !== target.behaviorId) return b;
        if (target.functionId === null) return { ...b, graph };
        const functions = withFunction(b.functions ?? [], target.functionId, graph);
        if (functions.length > BEHAVIOR_GRAPH_LIMITS.functions) refused = `a script has at most ${BEHAVIOR_GRAPH_LIMITS.functions} functions`;
        // The script and its other functions must still fit this function's interface (calls wired to its ports).
        const graphs = (content as WithGraphs).graphs;
        const errors: ModelErrorV2[] = [];
        validateGraphData(GRAPH_KINDS['behavior']!, b.graph!, '', errors, behaviorGraphContext(b.graph, { functions, graphs }));
        for (const f of functions) if (f.functionId !== target.functionId) validateGraphData(GRAPH_KINDS['behavior-function']!, f.graph, '', errors, behaviorGraphContext(f.graph, { functions, graphs, script: b.graph }));
        if (errors.length > 0 && refused === null) refused = `a call of this function would break: ${errors[0]!.message}`;
        const next: BehaviorRecord = { ...b, functions };
        if (functions.length === 0) delete next.functions;
        return next;
      });
      if (refused !== null) return { refused };
      return { ...content, behaviors: list } as ContentDocument;
    },
  },
};

export const GRAPH_OWNER_KINDS: readonly string[] = Object.keys(GRAPH_OWNERS);

/**
 * Phase 18.1: why a new list of standalone graphs breaks a caller (a graph
 * material or another graph calling a changed material function: a wired
 * port gone, a call cycle), or null. The resulting-state check would refuse
 * it too; this names the caller.
 */
function callersRefusal(content: ContentDocument, graphs: readonly GraphDocument[]): string | null {
  const errors: ModelErrorV2[] = [];
  validateGraphDocuments(GRAPH_KINDS, graphs, '/graphs', errors);
  const mats = (content as WithMaterials).materials ?? [];
  if (errors.length === 0 && mats.length > 0) validateMaterials(mats, '/materials', errors, graphDocumentsContext(GRAPH_KINDS, graphs));
  // Phase 19.1: visual scripts calling a changed shared function.
  const scripts = behaviorsOf(content);
  if (errors.length === 0) {
    scripts.forEach((b, i) => {
      if (b.graph === undefined) return;
      validateGraphData(GRAPH_KINDS['behavior']!, b.graph, `/behaviors/${i}/graph`, errors, behaviorGraphContext(b.graph, { functions: b.functions, graphs }));
      for (const f of b.functions ?? []) validateGraphData(GRAPH_KINDS['behavior-function']!, f.graph, `/behaviors/${i}/functions`, errors, behaviorGraphContext(f.graph, { functions: b.functions, graphs, script: b.graph }));
    });
  }
  if (errors.length === 0) return null;
  const e = errors[0]!;
  const m = /^\/materials\/(\d+)/.exec(e.path ?? '');
  const g = /^\/graphs\/(\d+)/.exec(e.path ?? '');
  const bh = /^\/behaviors\/(\d+)/.exec(e.path ?? '');
  const who = m !== null ? `material "${mats[Number(m[1])]?.name ?? '?'}"` : g !== null ? `graph "${graphs[Number(g[1])]?.name ?? '?'}"` : bh !== null ? `script "${scripts[Number(bh[1])]?.displayName ?? '?'}"` : 'the graphs';
  return `${who} would break: ${e.message}`;
}

function modelError(e: ModelErrorV2, prefix: string): CommandError {
  return { code: e.code, cls: 'validation', path: `${prefix}${e.path ?? ''}`, message: e.message, ...(e.found !== undefined ? { found: e.found } : {}), ...(e.expected !== undefined ? { expected: e.expected } : {}) } as unknown as CommandError;
}

/**
 * Apply ops to an owner's graph in `content` (forward edits, undo and redo
 * share this). Returns the new content, the inverse ops, or the refusal.
 */
export function editOwnerGraph(
  content: ContentDocument,
  owner: GraphOwner,
  ops: readonly GraphOp[],
): { ok: true; content: ContentDocument; inverse: GraphOp[] } | { ok: false; error: CommandError } {
  const adapter = Object.prototype.hasOwnProperty.call(GRAPH_OWNERS, owner.kind) ? GRAPH_OWNERS[owner.kind] : undefined;
  if (adapter === undefined) return { ok: false, error: fieldValue('/args/owner/kind', owner.kind, `one of: ${GRAPH_OWNER_KINDS.join(', ')}`, 'not a graph owner kind') };
  const current = adapter.read(content, owner.id);
  if (current === null) return { ok: false, error: { ...fieldValue('/args/owner/id', owner.id, `an existing ${owner.kind} id`, `no ${owner.kind} with this id has a graph`), code: 'reference_missing' } };
  const applied = applyGraphOps(current.graph, ops);
  if (!applied.ok) return { ok: false, error: modelError(applied.error, '/args/ops') };
  const errors: ModelErrorV2[] = [];
  validateGraphData(current.kind, applied.graph, '', errors, adapter.contextOf !== undefined ? adapter.contextOf(content, applied.graph, owner.id) : current.ctx);
  if (errors.length > 0) {
    // The result names graph paths (/nodes/3/…); say which op list produced it.
    const e = errors[0]!;
    return { ok: false, error: { ...modelError(e, '/args/ops'), path: '/args/ops', message: `${e.message} (at ${e.path})` } as CommandError };
  }
  const written = adapter.write(content, owner.id, applied.graph);
  if ('refused' in written) return { ok: false, error: fieldValue('/args/ops', owner.id, `ops that fit the ${owner.kind}`, written.refused as string) };
  return { ok: true, content: written as ContentDocument, inverse: applied.inverse };
}

function commit(input: OpInput, next: ContentDocument, change: GraphEditChange | SetGraphChange | ForwardChange, inverse: { kind: 'graphEdit'; owner: GraphOwner; ops: GraphOp[] } | { kind: 'setGraph'; graphId: string; restore: GraphDocument | null } | InverseSpec): OpOutcome {
  const catalog = contentOf(input.content);
  const resultScene = { ...input.scene, revision: input.scene.revision + 1 };
  const gate = gateResultState({ scene: input.scene, content: catalog, manifest: input.manifest }, resultScene, next);
  if (!gate.ok) return gate;
  return { ok: true, op: { scene: gate.scene, content: gate.content, change, inverse } };
}

export function applyGraphEdit(input: OpInput, args: { owner: GraphOwner; ops: GraphOp[] }): OpOutcome {
  const catalog = contentOf(input.content);
  const r = editOwnerGraph(catalog, args.owner, args.ops);
  if (!r.ok) return r;
  const owner = { kind: args.owner.kind, id: args.owner.id };
  const record = GRAPH_OWNERS[owner.kind]?.record;
  if (record !== undefined) {
    const { change, inverse } = record(catalog, r.content);
    return commit(input, r.content, change, inverse);
  }
  return commit(input, r.content, { type: 'graphEdit', owner, ops: deepClone(args.ops) }, { kind: 'graphEdit', owner, ops: r.inverse });
}

/** The content with one standalone graph document set (or removed when null). */
export function withGraphDocument(content: ContentDocument, graphId: string, doc: GraphDocument | null): ContentDocument {
  const c = { ...(content as WithGraphs) };
  const list = (c.graphs ?? []).filter((g) => g.graphId !== graphId);
  if (doc !== null) list.push(deepClone(doc));
  if (list.length > 0) c.graphs = canonicalGraphDocuments(list);
  else delete c.graphs;
  return c as ContentDocument;
}

/** `setGraph`: create or replace one standalone graph document. */
export function applySetGraph(input: OpInput, args: { graph: GraphDocument }): OpOutcome {
  const catalog = contentOf(input.content) as WithGraphs;
  const errors: ModelErrorV2[] = [];
  // Phase 18.1: calls resolve against the project's graphs with this one in place.
  const others = (catalog.graphs ?? []).filter((g) => !(typeof args.graph === 'object' && args.graph !== null && g.graphId === args.graph.graphId));
  validateGraphDocument(GRAPH_KINDS, args.graph, '', errors, graphDocumentsContext(GRAPH_KINDS, [...others, args.graph]));
  if (errors.length > 0) return { ok: false, error: modelError(errors[0]!, '/args/graph') };
  const graphId = args.graph.graphId;
  const previous = (catalog.graphs ?? []).find((g) => g.graphId === graphId) ?? null;
  if (previous !== null && previous.kind !== args.graph.kind) {
    return { ok: false, error: fieldValue('/args/graph/kind', args.graph.kind, previous.kind, 'a graph keeps its kind (create a new graph for another kind)') };
  }
  const next = withGraphDocument(catalog, graphId, args.graph);
  const stored = ((next as WithGraphs).graphs ?? []).find((g) => g.graphId === graphId)!;
  return commit(input, next, { type: 'setGraph', graphId, previous: previous === null ? null : deepClone(previous), next: deepClone(stored) }, { kind: 'setGraph', graphId, restore: previous === null ? null : deepClone(previous) });
}

/** `deleteGraph`: remove one standalone graph document. */
export function applyDeleteGraph(input: OpInput, args: { graphId: string }): OpOutcome {
  const catalog = contentOf(input.content) as WithGraphs;
  const previous = (catalog.graphs ?? []).find((g) => g.graphId === args.graphId) ?? null;
  if (previous === null) return { ok: false, error: { ...fieldValue('/args/graphId', args.graphId, 'an existing graphId', 'no graph with this id'), code: 'reference_missing' } };
  // Phase 18.1: a material function still called somewhere stays.
  const why = callersRefusal(catalog, (catalog.graphs ?? []).filter((g) => g.graphId !== args.graphId));
  if (why !== null) return { ok: false, error: { ...fieldValue('/args/graphId', args.graphId, 'a graph nothing calls', why), code: 'reference_missing' } };
  return commit(input, withGraphDocument(catalog, args.graphId, null), { type: 'setGraph', graphId: args.graphId, previous: deepClone(previous), next: null }, { kind: 'setGraph', graphId: args.graphId, restore: deepClone(previous) });
}
