/**
 * Phase 19.0: the editor's side of visual scripts (behavior graphs).
 *
 * The editor may import project-model types only (dependencies.md §4.1), so
 * the `variable` lookup that types Get/Set variable ports is repeated here
 * (project-model `behaviorGraphContext`); tests/behavior-graph-parity.test.ts
 * keeps the two equal. Pure.
 */
import type { GraphContext, GraphData, GraphNode } from '@thirdlight/project-model';

const VARIABLE_TYPE_RE = /^var\.(number|boolean|string)$/;

/** The graph's own variables type its Get/Set ports (the first declaration of a name, top to bottom). */
export function behaviorPortContext(graph: GraphData | undefined): GraphContext {
  const types = new Map<string, string>();
  const decls = (graph?.nodes ?? []).filter((n) => VARIABLE_TYPE_RE.test(n.type)).sort(byPosition);
  for (const n of decls) {
    const name = n.data?.['name'];
    if (typeof name === 'string' && name !== '' && !types.has(name)) types.set(name, VARIABLE_TYPE_RE.exec(n.type)![1]!);
  }
  return { lookup: (name, value) => (name === 'variable' ? (types.get(value) ?? null) : null) };
}

function byPosition(a: GraphNode, b: GraphNode): number {
  return a.position[1] - b.position[1] || a.position[0] - b.position[0] || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

/**
 * A new visual script: one On start node and one public number variable
 * "value" (a behavior declares 1–32 properties; the name is no genre's
 * quantity), and the declaration that variable makes.
 */
export function newBehaviorGraph(): { graph: GraphData; declaration: { properties: { key: string; label: string; type: 'number'; default: number }[] } } {
  return {
    graph: {
      nodes: [
        { id: 'start', type: 'event.start', position: [0, 0] },
        { id: 'var-value', type: 'var.number', position: [0, -140], data: { name: 'value' } },
      ],
      edges: [],
    },
    declaration: { properties: [{ key: 'value', label: 'Value', type: 'number', default: 0 }] },
  };
}
