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
 * in `content.graphs` (created with `setGraph`, removed with `deleteGraph`);
 * later phases register the animator controller (16.2), material (18),
 * behavior (19) and effect (20) owners here with the same op set.
 */
import {
  applyGraphOps,
  canonicalGraphDocuments,
  GRAPH_KINDS,
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
import { deepClone, gateResultState, type OpOutcome } from './ops';
import type { ContentDocument, GraphEditChange, GraphOwner, SetGraphChange } from './types';

type WithGraphs = ContentDocument & { graphs?: GraphDocument[] };

/** Where an owner kind keeps its graph (and which graph kind it is). */
export interface GraphOwnerAdapter {
  /** The owner's graph and kind, or null when the owner does not exist. */
  read(content: ContentDocument, id: string): { kind: GraphKindDef; graph: GraphData } | null;
  /** The content with the owner's graph replaced. */
  write(content: ContentDocument, id: string, graph: GraphData): ContentDocument;
}

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
  return { ok: true, content: adapter.write(content, owner.id, applied.graph), inverse: applied.inverse };
}

function commit(input: OpInput, next: ContentDocument, change: GraphEditChange | SetGraphChange, inverse: { kind: 'graphEdit'; owner: GraphOwner; ops: GraphOp[] } | { kind: 'setGraph'; graphId: string; restore: GraphDocument | null }): OpOutcome {
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
