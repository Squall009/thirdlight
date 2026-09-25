/**
 * Phase 22.1: the Problems tab's graph diagnostics as pure functions of the
 * project data (they ran as `useMemo`s in the editor's main component).
 *
 * - standalone graphs: each kind's rules with data-dependent ports
 *   (`diagnoseGraph` over `portsResolver`, sub-graph calls resolved from the
 *   project's graphs);
 * - graph materials: the kind's rules and the material compiler's problems
 *   (`materialGraphProblems` builds the TSL nodes without a renderer).
 *
 * Plain data in, plain data out, so they run in the editor worker (the
 * result is the same object inline and off-thread; tests compare both).
 * Node labels are looked up through a map (the old per-problem `find` was
 * quadratic in a large graph whose every node has a warning).
 */
import type { GraphDocument, GraphKindDef, GraphNode, MaterialDef } from '@thirdlight/project-model';
import { materialGraphProblems, type MaterialFunctionLike } from '@thirdlight/three-adapter';

import { diagnoseGraph, portsResolver } from '../graph/model';
import { graphsPortContext, materialPortContext } from '../session/material-graph';

export interface GraphIssue {
  key: string;
  graphId: string;
  graphName: string;
  nodeId?: string;
  nodeLabel: string | null;
  severity: 'error' | 'warning';
  message: string;
}

export interface MaterialIssue extends GraphIssue {
  materialId: string;
}

function labeller(kind: GraphKindDef, nodes: readonly GraphNode[]): (nodeId: string | undefined) => string | null {
  let byId: Map<string, GraphNode> | null = null;
  const labels = new Map<string, string>();
  for (const d of kind.nodes) if (!labels.has(d.type)) labels.set(d.type, d.label);
  return (nodeId) => {
    if (nodeId === undefined) return null;
    byId ??= new Map(nodes.map((n) => [n.id, n]));
    const node = byId.get(nodeId);
    return node !== undefined ? (labels.get(node.type) ?? node.type) : null;
  };
}

/** Every standalone graph's problems (the kind's rules). */
export function graphIssuesOf(graphs: readonly GraphDocument[], kinds: Readonly<Record<string, GraphKindDef>>): GraphIssue[] {
  const ctx = graphsPortContext(graphs, kinds);
  return graphs.flatMap((g) => {
    const k = kinds[g.kind];
    if (k === undefined) return [];
    const label = labeller(k, g.graph.nodes);
    return diagnoseGraph(k, g.graph, portsResolver(k, g.graph, ctx)).map((p, i) => ({
      key: `${g.graphId}:${i}`,
      graphId: g.graphId,
      graphName: g.name,
      ...(p.nodeId !== undefined ? { nodeId: p.nodeId } : {}),
      nodeLabel: label(p.nodeId),
      severity: p.severity,
      message: p.message,
    }));
  });
}

/** Graph materials' problems: the kind's rules and the compiler's. */
export function materialIssuesOf(materials: readonly MaterialDef[], graphs: readonly GraphDocument[], kinds: Readonly<Record<string, GraphKindDef>>, textureIds: readonly string[]): MaterialIssue[] {
  const kind = kinds['material'];
  if (kind === undefined) return [];
  const textures = new Set(textureIds);
  const functions = graphs.filter((g) => g.kind === 'material-function') as unknown as MaterialFunctionLike[];
  return materials.flatMap((m) => {
    if (m.graph === undefined) return [];
    const g = m.graph;
    const rules = diagnoseGraph(kind, g, portsResolver(kind, g, materialPortContext(m.parameters, graphs, kinds)));
    const compiled = materialGraphProblems({ graph: g, ...(m.parameters !== undefined ? { parameters: m.parameters } : {}) }, functions, textures);
    const label = labeller(kind, g.nodes);
    return [...rules, ...compiled].map((p, i) => ({
      key: `material:${m.materialId}:${i}`,
      graphId: m.materialId,
      graphName: m.name,
      ...(p.nodeId !== undefined ? { nodeId: p.nodeId } : {}),
      nodeLabel: label(p.nodeId),
      severity: p.severity,
      message: p.message,
      materialId: m.materialId,
    }));
  });
}
