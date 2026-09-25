/**
 * Phase 19.2: the editor side of visual-script tabs and debugging — pure
 * helpers (unit-tested; no DOM).
 *
 * A script's graphs are its event graph (target "") and its functions
 * (target = functionId, owner id `<behaviorId>#<functionId>`). Node, wire and
 * local-variable ids from the running game and the compiler are scoped like
 * run-time errors: plain in the event graph, `fn:<functionId>/<id>` inside a
 * function (`lib:<graphId>/<id>` in a shared function).
 */
import type { GraphData, GraphNode } from '@thirdlight/project-model';

/** The id scope of a tab ("" = the event graph). */
export function scopeOf(target: string): string {
  return target === '' ? '' : `fn:${target}`;
}

/** An id of the tab's graph as the game and the compiler name it. */
export function scopedId(target: string, id: string): string {
  return target === '' ? id : `fn:${target}/${id}`;
}

/** The tab a scoped id belongs to and its id there (null: a shared function's id, not in a script tab). */
export function splitScoped(id: string): { target: string; id: string } | null {
  if (id.startsWith('fn:')) {
    const i = id.indexOf('/');
    return i < 0 ? null : { target: id.slice(3, i), id: id.slice(i + 1) };
  }
  if (id.startsWith('lib:')) return null;
  return { target: '', id };
}

/** The ids of `ids` that belong to the tab, unscoped. */
export function idsInTab(ids: Iterable<string>, target: string): Set<string> {
  const out = new Set<string>();
  for (const x of ids) {
    const s = splitScoped(x);
    if (s !== null && s.target === target) out.add(s.id);
  }
  return out;
}

/** Toggle `ids` (unscoped, of the tab) in a scoped breakpoint list. */
export function toggleBreakpoints(list: readonly string[], target: string, ids: readonly string[]): string[] {
  const next = new Set(list);
  const scoped = ids.map((id) => scopedId(target, id));
  const allOn = scoped.every((x) => next.has(x));
  for (const x of scoped) {
    if (allOn) next.delete(x);
    else next.add(x);
  }
  return [...next].sort();
}

const VARIABLE_RE = /^var\.(number|boolean|string|vector|entity|enum|list|map)$/;
/** The variable kinds, in menu order, with their labels. */
export const VARIABLE_KINDS: readonly { kind: string; label: string }[] = [
  { kind: 'number', label: 'Number' },
  { kind: 'boolean', label: 'Boolean' },
  { kind: 'string', label: 'Text' },
  { kind: 'vector', label: 'Vector' },
  { kind: 'entity', label: 'Entity' },
  { kind: 'enum', label: 'Choice' },
  { kind: 'list', label: 'List' },
  { kind: 'map', label: 'Map' },
];

export interface VariableRow {
  nodeId: string;
  name: string;
  kind: string;
  /** public / private / local (in a function: always local). */
  visibility: string;
}

/** The variable declarations of a graph, top to bottom (the first declaration of a name wins, as in the compiler). */
export function variablesOf(graph: GraphData | undefined, inFunction: boolean): VariableRow[] {
  const decls = (graph?.nodes ?? []).filter((n) => VARIABLE_RE.test(n.type)).sort((a, b) => a.position[1] - b.position[1] || a.position[0] - b.position[0] || (a.id < b.id ? -1 : 1));
  return decls.map((n) => {
    const kind = VARIABLE_RE.exec(n.type)![1]!;
    const collection = kind === 'list' || kind === 'map';
    const v = n.data?.['visibility'];
    return { nodeId: n.id, name: typeof n.data?.['name'] === 'string' ? (n.data['name'] as string) : '', kind, visibility: inFunction ? 'local' : typeof v === 'string' ? v : collection ? 'private' : 'public' };
  });
}

/** The visibilities a variable kind may have (lists and maps are never properties). */
export function visibilitiesOf(kind: string, inFunction: boolean): readonly string[] {
  if (inFunction) return ['local'];
  return kind === 'list' || kind === 'map' ? ['private', 'local'] : ['public', 'private', 'local'];
}

/** A variable name not used yet (property keys: lower case a-z, 0-9, _). */
export function freshVariableName(graph: GraphData | undefined, base = 'variable'): string {
  const used = new Set(variablesOf(graph, false).map((v) => v.name));
  if (!used.has(base)) return base;
  for (let i = 2; ; i++) if (!used.has(`${base}${i}`)) return `${base}${i}`;
}

/** A node id not used in the graph. */
export function freshNodeId(graph: GraphData | undefined, prefix: string): string {
  const used = new Set((graph?.nodes ?? []).map((n) => n.id));
  for (let i = 1; ; i++) if (!used.has(`${prefix}${i}`)) return `${prefix}${i}`;
}

/** Where a new declaration goes: left of the graph, below the other declarations. */
export function newDeclarationPosition(graph: GraphData | undefined): [number, number] {
  const nodes = graph?.nodes ?? [];
  if (nodes.length === 0) return [0, 0];
  const decls = nodes.filter((n) => VARIABLE_RE.test(n.type));
  const minX = Math.min(...nodes.map((n) => n.position[0]));
  if (decls.length === 0) return [minX - 260, Math.min(...nodes.map((n) => n.position[1]))];
  return [Math.min(...decls.map((n) => n.position[0])), Math.max(...decls.map((n) => n.position[1])) + 80];
}

/** A function's display name: its Function start node's name, else its id. */
export function functionName(fn: { functionId: string; graph: GraphData }): string {
  const entry = fn.graph.nodes.find((n: GraphNode) => n.type === 'fn.entry');
  const name = entry?.data?.['name'];
  return typeof name === 'string' && name.trim() !== '' ? name : fn.functionId;
}

/** A function id from a name (`[a-z0-9_-]`, unique among `taken`). */
export function functionIdFor(name: string, taken: readonly string[]): string {
  const base = name.toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^[-_]+|[-_]+$/g, '').slice(0, 40) || 'function';
  let id = base;
  for (let i = 2; taken.includes(id); i++) id = `${base}-${i}`;
  return id;
}
