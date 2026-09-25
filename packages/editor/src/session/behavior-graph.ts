/**
 * Phase 19.0/19.1: the editor's side of visual scripts (behavior graphs).
 *
 * The editor may import project-model types only (dependencies.md §4.1), so
 * the port context of a script graph is repeated here (project-model
 * `behaviorGraphContext`): the `variable` lookup types Get/Set variable
 * ports (the graph's own first declaration of a name, else — in one of the
 * script's functions — the script's), and call nodes resolve their ports from
 * the script's functions (`behavior-function`) and the project's shared
 * functions (`behavior-library`). tests/behavior-graph-parity.test.ts keeps
 * the two equal. Pure.
 */
import type { GraphContext, GraphData, GraphDocument, GraphKindDef, GraphNode } from '@thirdlight/project-model';

const VARIABLE_TYPE_RE = /^var\.(number|boolean|string|vector|entity|enum|list|map)$/;
/** The data port type of each variable kind (an entity id and a choice are texts). */
const PORT_TYPE: Record<string, string> = { number: 'number', boolean: 'boolean', string: 'string', vector: 'vector', entity: 'string', enum: 'string', list: 'list', map: 'map' };

/** A script's function as its record keeps it. */
export interface ScriptFunctionView {
  functionId: string;
  graph: GraphData;
}

function declarations(graph: GraphData | undefined): Map<string, string> {
  const types = new Map<string, string>();
  const decls = (graph?.nodes ?? []).filter((n) => VARIABLE_TYPE_RE.test(n.type)).sort(byPosition);
  for (const n of decls) {
    const name = n.data?.['name'];
    if (typeof name === 'string' && name !== '' && !types.has(name)) types.set(name, PORT_TYPE[VARIABLE_TYPE_RE.exec(n.type)![1]!]!);
  }
  return types;
}

/**
 * The port context of a script graph (or, with `script`, of one of its
 * functions): its variables type Get/Set ports; calls resolve against the
 * script's functions and the shared functions among the project's graphs.
 */
export function behaviorPortContext(
  graph: GraphData | undefined,
  env: { functions?: readonly ScriptFunctionView[]; graphs?: readonly GraphDocument[]; kinds?: Readonly<Record<string, GraphKindDef>>; script?: GraphData } = {},
): GraphContext {
  const own = declarations(graph);
  const script = env.script !== undefined ? declarations(env.script) : new Map<string, string>();
  return {
    lookup: (name, value) => (name === 'variable' ? (own.get(value) ?? script.get(value) ?? null) : null),
    graph: (kind, id) => {
      const k = env.kinds?.[kind];
      if (k === undefined) return null;
      if (kind === 'behavior-function') {
        const f = env.functions?.find((x) => x.functionId === id);
        return f !== undefined ? { kind: k, graph: f.graph } : null;
      }
      if (kind === 'behavior-library') {
        const d = env.graphs?.find((g) => g.graphId === id && g.kind === kind);
        return d !== undefined ? { kind: k, graph: d.graph } : null;
      }
      return null;
    },
  };
}

function byPosition(a: GraphNode, b: GraphNode): number {
  return a.position[1] - b.position[1] || a.position[0] - b.position[0] || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

/**
 * A new visual script: one On start node and no variable (phase 19.1: a
 * behavior may declare no property), and the (empty) declaration it makes.
 */
export function newBehaviorGraph(): { graph: GraphData; declaration: { properties: { key: string; label: string; type: 'number'; default: number }[] } } {
  return {
    graph: { nodes: [{ id: 'start', type: 'event.start', position: [0, 0] }], edges: [] },
    declaration: { properties: [] },
  };
}

/** Phase 19.1: `<behaviorId>` or `<behaviorId>#<functionId>` (a graph edit's owner id) — commands `parseBehaviorOwnerId`. */
export function parseBehaviorOwnerId(id: string): { behaviorId: string; functionId: string | null } {
  const i = id.indexOf('#');
  return i < 0 ? { behaviorId: id, functionId: null } : { behaviorId: id.slice(0, i), functionId: id.slice(i + 1) };
}
