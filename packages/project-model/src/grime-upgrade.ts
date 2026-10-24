/**
 * The built-in grime is gone: dirt is a layer of a layered surface, painted
 * like any other. Stored projects still name it in three places, and the
 * load takes it out of each so they validate and draw as before wherever no
 * grime showed:
 *
 * - a trim material's `grime` and `grimeColor` params (and an instance's);
 * - a layered surface's graph: the Layer weights node's `grime` output and
 *   what it fed (the template mixed the colour toward `grimeColor` and the
 *   roughness toward matte by it). The output is taken as 0 and folded away
 *   — a Mix whose amount is 0 gives its first input — so the graph is the
 *   one a new layered surface has; a graph that used the output some other
 *   way reads a 0 there. Parameters nothing reads any more go, and with
 *   them instance values and objects' overrides of them;
 * - shared material functions (`graphs`) that read the output, the same way.
 *
 * Where grime showed (generated walls under path paint, trim paint's G) the
 * look loses it; the materials whose grime was set are named so the user can
 * paint a dirt layer instead. Pure: raw documents in, raw documents out;
 * documents with nothing to change come back as given.
 */
import type { GraphEdge, GraphNode } from './graph';

/** The trim material params grime had. */
const TRIM_GRIME_PARAMS = ['grime', 'grimeColor'] as const;

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);

interface GraphLike {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

const outKey = (node: string, port: string): string => `${node}\u0000${port}`;

/**
 * A graph with the Layer weights node's `grime` output taken out (see the
 * file comment): null when it reads none. `dropped` lists the parameter
 * keys whose last reader went.
 */
export function graphWithoutGrime(graph: unknown): { graph: GraphLike; dropped: string[] } | null {
  if (!isObj(graph) || !Array.isArray(graph['nodes']) || !Array.isArray(graph['edges'])) return null;
  const nodes = (graph['nodes'] as unknown[]).filter(isObj) as unknown as GraphNode[];
  let edges = (graph['edges'] as unknown[]).filter(isObj) as unknown as GraphEdge[];
  const fedBefore = new Set(edges.map((e) => e.from.node));
  const weights = new Set(nodes.filter((n) => n.type === 'layerWeights').map((n) => n.id));
  const zero = new Set<string>();
  for (const id of weights) zero.add(outKey(id, 'grime'));
  if (!edges.some((e) => zero.has(outKey(e.from.node, e.from.port)))) return null;
  const typeOf = new Map(nodes.map((n) => [n.id, n.type]));
  const removed = new Set<string>();
  // Fold: a product with a 0 factor, a clamp of 0, a Mix by 0 (its first input stands in for it).
  for (let changed = true; changed; ) {
    changed = false;
    const into = (node: string, port: string): GraphEdge | undefined => edges.find((e) => e.to.node === node && e.to.port === port);
    const isZero = (e: GraphEdge | undefined): boolean => e !== undefined && zero.has(outKey(e.from.node, e.from.port));
    for (const n of nodes) {
      if (removed.has(n.id)) continue;
      const t = typeOf.get(n.id);
      if ((t === 'multiply' && (isZero(into(n.id, 'a')) || isZero(into(n.id, 'b')))) || (t === 'saturate' && isZero(into(n.id, 'in')))) {
        if (!zero.has(outKey(n.id, 'out'))) {
          zero.add(outKey(n.id, 'out'));
          changed = true;
        }
      } else if (t === 'lerp' && isZero(into(n.id, 't'))) {
        const a = into(n.id, 'a');
        if (a === undefined) continue;
        edges = edges.filter((e) => e.to.node !== n.id).map((e) => (e.from.node === n.id ? { ...e, from: { ...a.from } } : e));
        removed.add(n.id);
        changed = true;
      }
    }
  }
  // What still reads a 0: one constant.
  const constId = (() => {
    let id = 'noGrime';
    for (let i = 2; nodes.some((n) => n.id === id); i++) id = `noGrime${i}`;
    return id;
  })();
  let usedConst = false;
  const kept = edges.filter((e) => !(zero.has(outKey(e.from.node, e.from.port)) && (removed.has(e.to.node) || zero.has(outKey(e.to.node, 'out')))));
  edges = kept.map((e) => {
    if (!zero.has(outKey(e.from.node, e.from.port))) return e;
    usedConst = true;
    return { ...e, from: { node: constId, port: 'value' } };
  });
  // Nodes that fed only what went (and are not outputs or the Layer weights node) go with it.
  const zeroNodes = new Set([...zero].map((k) => k.split('\u0000')[0]!).filter((id) => !weights.has(id)));
  for (const id of zeroNodes) removed.add(id);
  edges = edges.filter((e) => !removed.has(e.to.node) && !removed.has(e.from.node));
  for (let changed = true; changed; ) {
    changed = false;
    for (const n of nodes) {
      if (removed.has(n.id) || weights.has(n.id)) continue;
      if (!fedBefore.has(n.id) || edges.some((e) => e.from.node === n.id)) continue;
      removed.add(n.id);
      edges = edges.filter((e) => e.to.node !== n.id);
      changed = true;
    }
  }
  const before = new Set(nodes.filter((n) => n.type === 'parameter').map((n) => String((n.data as Obj | undefined)?.['key'] ?? '')));
  const nextNodes = nodes.filter((n) => !removed.has(n.id));
  if (usedConst) nextNodes.push({ id: constId, type: 'float', position: [0, 0], data: { value: 0 } });
  const after = new Set(nextNodes.filter((n) => n.type === 'parameter').map((n) => String((n.data as Obj | undefined)?.['key'] ?? '')));
  return { graph: { ...(graph as Obj), nodes: nextNodes, edges } as unknown as GraphLike, dropped: [...before].filter((k) => k !== '' && !after.has(k)) };
}

/**
 * Raw project documents without the built-in grime (see the file comment).
 * `named`: the materials (name and id) whose grime was set — a trim
 * material's stored grime above 0 or its grime colour, a layered graph whose
 * grime amount was above 0.
 */
export function upgradeBuiltInGrime(content: unknown, scenes: readonly unknown[]): { content: unknown; scenes: unknown[]; named: string[]; changed: boolean } {
  const unchanged = { content, scenes: [...scenes], named: [], changed: false };
  if (!isObj(content) || !Array.isArray(content['materials'])) return unchanged;
  const named: string[] = [];
  /** Parameter keys each material no longer has (by materialId). */
  const gone = new Map<string, Set<string>>();
  let changed = false;
  const label = (m: Obj): string => `"${String(m['name'] ?? m['materialId'])}" (${String(m['materialId'])})`;
  let materials = (content['materials'] as unknown[]).map((raw) => {
    if (!isObj(raw)) return raw;
    let m = raw;
    const id = String(m['materialId']);
    const params = m['params'];
    if (isObj(params) && TRIM_GRIME_PARAMS.some((k) => k in params) && (m['shader'] === 'trim' || m['instanceOf'] !== undefined)) {
      const amount = params['grime'];
      if ((typeof amount === 'number' ? amount > 0 : 'grimeColor' in params) && m['instanceOf'] === undefined) named.push(label(m));
      const next = { ...params };
      for (const k of TRIM_GRIME_PARAMS) delete next[k];
      m = { ...m, params: next };
    }
    const g = graphWithoutGrime(m['graph']);
    if (g !== null) {
      const declared = Array.isArray(m['parameters']) ? (m['parameters'] as unknown[]).filter(isObj) : [];
      const amount = declared.find((p) => p['key'] === 'grime')?.['default'];
      if (typeof amount !== 'number' || amount > 0) named.push(label(m));
      gone.set(id, new Set(g.dropped));
      m = { ...m, graph: g.graph, ...(Array.isArray(m['parameters']) ? { parameters: declared.filter((p) => !g.dropped.includes(String(p['key']))) } : {}) };
    }
    if (m !== raw) changed = true;
    return m;
  });
  // An instance's values and objects' overrides name their root's parameters.
  const byId = new Map(materials.filter(isObj).map((m) => [String(m['materialId']), m]));
  const goneFor = (id: string): Set<string> | undefined => {
    let cur = byId.get(id);
    for (let i = 0; cur !== undefined && cur['instanceOf'] !== undefined && i < 16; i++) cur = byId.get(String(cur['instanceOf']));
    return cur === undefined ? undefined : gone.get(String(cur['materialId']));
  };
  if (gone.size > 0) {
    materials = materials.map((m) => {
      if (!isObj(m) || m['instanceOf'] === undefined || !isObj(m['values'])) return m;
      const drop = goneFor(String(m['materialId']));
      if (drop === undefined || !Object.keys(m['values']).some((k) => drop.has(k))) return m;
      changed = true;
      return { ...m, values: Object.fromEntries(Object.entries(m['values']).filter(([k]) => !drop.has(k))) };
    });
  }
  const overrides = (entities: unknown): unknown => {
    if (gone.size === 0 || !Array.isArray(entities)) return entities;
    let any = false;
    const out = entities.map((e) => {
      if (!isObj(e) || !isObj(e['components']) || !isObj(e['components']['materialParams'])) return e;
      const mp = e['components']['materialParams'];
      let touched = false;
      const next: Obj = {};
      for (const [id, values] of Object.entries(mp)) {
        const drop = goneFor(id);
        if (drop !== undefined && isObj(values) && Object.keys(values).some((k) => drop.has(k))) {
          touched = true;
          const kept = Object.fromEntries(Object.entries(values).filter(([k]) => !drop.has(k)));
          if (Object.keys(kept).length > 0) next[id] = kept;
        } else next[id] = values;
      }
      if (!touched) return e;
      any = true;
      const components = { ...e['components'] };
      if (Object.keys(next).length > 0) components['materialParams'] = next;
      else delete components['materialParams'];
      return { ...e, components };
    });
    return any ? out : entities;
  };
  let nextContent: Obj = { ...content, materials };
  if (Array.isArray(content['prefabs'])) {
    const prefabs = (content['prefabs'] as unknown[]).map((p) => {
      if (!isObj(p)) return p;
      const ents = overrides(p['entities']);
      return ents === p['entities'] ? p : { ...p, entities: ents };
    });
    if (prefabs.some((p, i) => p !== (content['prefabs'] as unknown[])[i])) {
      changed = true;
      nextContent = { ...nextContent, prefabs };
    }
  }
  if (Array.isArray(content['graphs'])) {
    const graphs = (content['graphs'] as unknown[]).map((raw) => {
      if (!isObj(raw)) return raw;
      const g = graphWithoutGrime(raw['graph']);
      return g === null ? raw : { ...raw, graph: g.graph };
    });
    if (graphs.some((g, i) => g !== (content['graphs'] as unknown[])[i])) {
      changed = true;
      nextContent = { ...nextContent, graphs };
    }
  }
  const nextScenes = scenes.map((sc) => {
    if (!isObj(sc)) return sc;
    const ents = overrides(sc['entities']);
    if (ents === sc['entities']) return sc;
    changed = true;
    return { ...sc, entities: ents };
  });
  return changed ? { content: nextContent, scenes: nextScenes, named, changed } : unchanged;
}
