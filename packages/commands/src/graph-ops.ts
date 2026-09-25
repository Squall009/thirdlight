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
 * Phase 19.0: `behavior` — a visual script (`BehaviorRecord.graph`, kind
 * `behavior`); the change is the generic `graphEdit` with its ops, undone by
 * the inverse ops. Editing the graph does not touch the published source:
 * publishing compiles it (the behavior source route).
 * Later phases register the material (18) and effect (20) owners here with
 * the same op set.
 */
import {
  animatorGraphOf,
  applyAnimatorGraph,
  applyGraphOps,
  canonicalAnimators,
  canonicalGraphDocuments,
  GRAPH_KINDS,
  parseAnimatorOwnerId,
  type AnimatorController,
  type BehaviorRecord,
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
type WithAnimators = ContentDocument & { animators?: AnimatorController[] };

/** Where an owner kind keeps its graph (and which graph kind it is). */
export interface GraphOwnerAdapter {
  /** The owner's graph and kind, or null when the owner does not exist. */
  read(content: ContentDocument, id: string): { kind: GraphKindDef; graph: GraphData } | null;
  /** The content with the owner's graph replaced, or why the graph does not fit the owner. */
  write(content: ContentDocument, id: string, graph: GraphData): ContentDocument | { refused: string };
  /**
   * Phase 16.2: the change and undo an edit records when the owner stores its
   * graph as its own data (absent = a `graphEdit` change with the ops, undone
   * by the inverse ops).
   */
  record?(before: ContentDocument, after: ContentDocument): { change: ForwardChange; inverse: InverseSpec };
}

/** Phase 19.0: the behavior records (a visual script keeps its graph in its record). */
const behaviorsOf = (content: ContentDocument): BehaviorRecord[] => (content as ContentDocument & { behaviors?: BehaviorRecord[] }).behaviors ?? [];

const animatorsOf = (content: ContentDocument): AnimatorController[] => (content as WithAnimators).animators ?? [];

export const GRAPH_OWNERS: Readonly<Record<string, GraphOwnerAdapter>> = {
  graph: {
    read(content, id) {
      const doc = ((content as WithGraphs).graphs ?? []).find((g) => g.graphId === id);
      const kind = doc !== undefined ? GRAPH_KINDS[doc.kind] : undefined;
      return doc !== undefined && kind !== undefined ? { kind, graph: doc.graph } : null;
    },
    write(content, id, graph) {
      const list = ((content as WithGraphs).graphs ?? []).map((g) => (g.graphId === id ? { ...g, graph } : g));
      return { ...(content as WithGraphs), graphs: list } as ContentDocument;
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
  // Phase 19.0: `<behaviorId>` — a visual script's graph (only behaviors that are visual scripts have one).
  behavior: {
    read(content, id) {
      const b = behaviorsOf(content).find((x) => x.behaviorId === id);
      const kind = GRAPH_KINDS['behavior'];
      return b?.graph !== undefined && kind !== undefined ? { kind, graph: b.graph } : null;
    },
    write(content, id, graph) {
      const list = behaviorsOf(content).map((b) => (b.behaviorId === id ? { ...b, graph } : b));
      return { ...content, behaviors: list } as ContentDocument;
    },
  },
};

export const GRAPH_OWNER_KINDS: readonly string[] = Object.keys(GRAPH_OWNERS);

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
  validateGraphData(current.kind, applied.graph, '', errors);
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
  validateGraphDocument(GRAPH_KINDS, args.graph, '', errors);
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
  return commit(input, withGraphDocument(catalog, args.graphId, null), { type: 'setGraph', graphId: args.graphId, previous: deepClone(previous), next: null }, { kind: 'setGraph', graphId: args.graphId, restore: deepClone(previous) });
}
