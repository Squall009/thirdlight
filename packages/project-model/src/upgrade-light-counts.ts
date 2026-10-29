/**
 * The schema 8 step that retires the counts of local lights.
 *
 * Local lights are drawn through per-cluster light lists and their shadows
 * share one shadow atlas, so nothing counts them any more. The fields that
 * only existed to stay within the old per-pixel count go:
 * - a quality level's `localLights` (how many point and spot lights were on)
 *   and `shadowedLights` (how many point lights drew a shadow);
 * - a furnishing set's `lights` (the most lights one building got, so a few
 *   buildings fit in a scene's count): every room a Light node names now
 *   gets its light. A set whose count was 0 lit no room: its Light nodes are
 *   kept, switched off (`on: false`), so it still lights none and the author
 *   can switch them back on; nothing the author made is deleted.
 *
 * Pure: works on the raw documents before they are validated; a project that
 * uses none of these fields is returned as it was.
 */
import { FURNISHING_SET_KIND } from './arch-plan-kinds';
import { isPlainObject } from './validate';

type Obj = Record<string, unknown>;

/** A quality level's fields this step drops. */
const RETIRED_LEVEL_FIELDS = ['localLights', 'shadowedLights'] as const;
/** The furnishing node's field this step drops. */
const RETIRED_FURNISHING_FIELD = 'lights';

function withoutLevelCounts(environment: unknown): Obj | null {
  if (!isPlainObject(environment) || !Array.isArray(environment['qualityLevels'])) return null;
  let changed = false;
  const levels = (environment['qualityLevels'] as unknown[]).map((l) => {
    if (!isPlainObject(l) || !RETIRED_LEVEL_FIELDS.some((k) => k in l)) return l;
    changed = true;
    const next = { ...l };
    for (const k of RETIRED_LEVEL_FIELDS) delete next[k];
    return next;
  });
  return changed ? { ...environment, qualityLevels: levels } : null;
}

/** A furnishing set's graph without its light count (null: it had none); `unlit`: the count was 0 (its Light nodes switched off). */
function withoutFurnishingCount(graph: unknown): { graph: Obj; unlit: boolean } | null {
  if (!isPlainObject(graph) || !Array.isArray(graph['nodes'])) return null;
  const nodes = graph['nodes'] as unknown[];
  const head = nodes.find((n) => isPlainObject(n) && n['type'] === 'furnishing' && isPlainObject(n['data']) && RETIRED_FURNISHING_FIELD in n['data']) as Obj | undefined;
  if (head === undefined) return null;
  const count = (head['data'] as Obj)[RETIRED_FURNISHING_FIELD];
  const unlit = typeof count === 'number' && count <= 0;
  const next = nodes.flatMap((n) => {
    if (n === head) {
      const { [RETIRED_FURNISHING_FIELD]: _count, ...data } = head['data'] as Obj;
      return [{ ...head, data }];
    }
    if (!unlit || !isPlainObject(n) || n['type'] !== 'light') return [n];
    return [{ ...n, data: { ...(isPlainObject(n['data']) ? n['data'] : {}), on: false } }];
  });
  // A furnishing set's nodes have no ports, so no edge names a Light node.
  return { graph: { ...graph, nodes: next }, unlit };
}

/** Drop the retired light counts (see the file comment). */
export function retireLightCounts(contentIn: unknown, scenes: readonly unknown[]): { content: unknown; scenes: unknown[]; changed: boolean; notes: string[] } {
  const unchanged = { content: contentIn, scenes: [...scenes], changed: false, notes: [] };
  if (!isPlainObject(contentIn)) return unchanged;
  let content: Obj = contentIn;
  const notes: string[] = [];
  const environment = withoutLevelCounts(content['environment']);
  if (environment !== null) {
    content = { ...content, environment };
    notes.push('quality levels: localLights and shadowedLights were removed (every local light is drawn and shadowed lights share the shadow atlas)');
  }
  if (Array.isArray(content['graphs'])) {
    const lit: string[] = [];
    const dark: string[] = [];
    const graphs = (content['graphs'] as unknown[]).map((g) => {
      if (!isPlainObject(g) || g['kind'] !== FURNISHING_SET_KIND) return g;
      const r = withoutFurnishingCount(g['graph']);
      if (r === null) return g;
      (r.unlit ? dark : lit).push(String(g['name'] ?? g['graphId']));
      return { ...g, graph: r.graph };
    });
    const names = (sets: readonly string[]): string => `${sets.slice(0, 8).join(', ')}${sets.length > 8 ? ', …' : ''}`;
    if (lit.length > 0) notes.push(`furnishing sets: the Lights count was removed, every room a Light node names gets its light (${names(lit)})`);
    if (dark.length > 0) notes.push(`furnishing sets whose Lights count was 0: the count was removed and their Light nodes were switched off (On), so they still light no room; switch a node on to light its rooms (${names(dark)})`);
    if (lit.length + dark.length > 0) content = { ...content, graphs };
  }
  return content === contentIn ? unchanged : { content, scenes: [...scenes], changed: true, notes };
}
