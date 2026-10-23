/**
 * Local lights: how point and spot lights (and effect lights) reach an object.
 *
 * - An object (box, model, instance set) or a material has a local-light
 *   mode, `localLights`: `pixel` (every local light per pixel) or `none` (no
 *   local light at all: a far backdrop, a sky dome, an unlit look). The
 *   object's mode wins over its material's; with neither, per pixel.
 * - The sun, ambient light and probes are not local: they reach every object.
 *
 * Shading local lights per vertex was measured no cheaper than per pixel on
 * this engine's scenes while it cost a shader variant per lit program, so it
 * is not offered; documents that stored it are upgraded when they load
 * ({@link upgradeVertexLocalLights}).
 *
 * Pure data.
 */
import type { ModelErrorV2 } from './errors';
import { fieldValue, isPlainObject } from './validate';

/** Most point + spot lights per scene: the forward-lighting cost per drawn light (a quality level may draw fewer). */
export const MAX_LOCAL_LIGHTS = 16;

/** An object's local-light modes. */
export const LOCAL_LIGHT_MODES = ['pixel', 'none'] as const;
export type LocalLightMode = (typeof LOCAL_LIGHT_MODES)[number];

/** A material's local-light modes: `object` (absent) follows the object. */
export const MATERIAL_LOCAL_LIGHT_MODES = ['object', ...LOCAL_LIGHT_MODES] as const;
export type MaterialLocalLightMode = (typeof MATERIAL_LOCAL_LIGHT_MODES)[number];

/** An object's or material's mode as the renderer reads it (undefined: not set — `object` on a material too). */
export function localLightModeOf(v: unknown): LocalLightMode | undefined {
  return (LOCAL_LIGHT_MODES as readonly unknown[]).includes(v) ? (v as LocalLightMode) : undefined;
}

/** An optional `localLights` field of a box, model or instance set. */
export function validateLocalLightMode(v: unknown, path: string, errors: ModelErrorV2[]): void {
  if (v === undefined || localLightModeOf(v) !== undefined) return;
  errors.push(fieldValue(path, v, LOCAL_LIGHT_MODES.join(' | '), 'how local (point and spot) lights reach it: per pixel or none'));
}

/** The stored value that is no longer a mode, and the mode it becomes. */
const OLD_VERTEX = 'vertex';
/** The field a point or spot light (and an effect's Lights output) once had: per pixel or per vertex on the objects it lit. */
const OLD_IMPORTANCE = 'importance';

type Counter = { n: number };

/** A component, material params or graph node data: `localLights: vertex` → `pixel`. */
function upgradeMode(o: Record<string, unknown>, count: Counter): Record<string, unknown> {
  if (o['localLights'] !== OLD_VERTEX) return o;
  count.n += 1;
  return { ...o, localLights: 'pixel' };
}

/** A light component (or a Lights output's data) without its importance; a forced per-vertex one counts. */
function dropImportance(o: Record<string, unknown>, count: Counter): Record<string, unknown> {
  if (!(OLD_IMPORTANCE in o)) return o;
  if (o[OLD_IMPORTANCE] === OLD_VERTEX) count.n += 1;
  const { [OLD_IMPORTANCE]: _dropped, ...rest } = o;
  return rest;
}

function upgradeEntities(entities: unknown, count: Counter): unknown {
  if (!Array.isArray(entities)) return entities;
  let changed = false;
  const out = entities.map((e) => {
    if (!isPlainObject(e) || !isPlainObject(e['components'])) return e;
    const before = count.n;
    let touched = false;
    const components: Record<string, unknown> = {};
    for (const [k, c] of Object.entries(e['components'])) {
      const next = !isPlainObject(c) ? c : k === 'light' ? dropImportance(c, count) : upgradeMode(c, count);
      if (next !== c) touched = true;
      components[k] = next;
    }
    if (!touched && count.n === before) return e;
    changed = true;
    return { ...e, components };
  });
  return changed ? out : entities;
}

function upgradeGraph(graph: unknown, count: Counter): unknown {
  if (!isPlainObject(graph) || !Array.isArray(graph['nodes'])) return graph;
  let changed = false;
  const nodes = graph['nodes'].map((n) => {
    if (!isPlainObject(n) || !isPlainObject(n['data'])) return n;
    const data = n['type'] === 'output.light' ? dropImportance(n['data'], count) : upgradeMode(n['data'], count);
    if (data === n['data']) return n;
    changed = true;
    return { ...n, data };
  });
  return changed ? { ...graph, nodes } : graph;
}

function upgradeList(list: unknown, each: (item: Record<string, unknown>) => Record<string, unknown>): unknown {
  if (!Array.isArray(list)) return list;
  let changed = false;
  const out = list.map((item) => {
    if (!isPlainObject(item)) return item;
    const next = each(item);
    if (next !== item) changed = true;
    return next;
  });
  return changed ? out : list;
}

function withField(o: Record<string, unknown>, key: string, value: unknown): Record<string, unknown> {
  return o[key] === value ? o : { ...o, [key]: value };
}

/**
 * Raw project documents with no per-vertex local lighting: an object's or a
 * material's `localLights: "vertex"` (a material graph's output field too)
 * becomes `pixel`, and a light's or a Lights output's `importance` goes (with
 * only per-pixel shading left it chose nothing). `upgraded` counts what was
 * shaded per vertex; dropping an `auto` or `pixel` importance changes no look
 * and is not counted. Documents with nothing to change come back as given.
 */
export function upgradeVertexLocalLights(content: unknown, scenes: readonly unknown[]): { content: unknown; scenes: unknown[]; upgraded: number; changed: boolean } {
  const count: Counter = { n: 0 };
  let changed = false;
  const nextScenes = scenes.map((sc) => {
    if (!isPlainObject(sc)) return sc;
    const next = withField(sc, 'entities', upgradeEntities(sc['entities'], count));
    if (next !== sc) changed = true;
    return next;
  });
  let nextContent = content;
  if (isPlainObject(content)) {
    let c = content;
    c = withField(c, 'prefabs', upgradeList(c['prefabs'], (p) => withField(p, 'entities', upgradeEntities(p['entities'], count))));
    c = withField(c, 'materials', upgradeList(c['materials'], (m) => {
      const params = isPlainObject(m['params']) ? upgradeMode(m['params'], count) : m['params'];
      return withField(withField(m, 'params', params), 'graph', upgradeGraph(m['graph'], count));
    }));
    c = withField(c, 'graphs', upgradeList(c['graphs'], (g) => withField(g, 'graph', upgradeGraph(g['graph'], count))));
    c = withField(c, 'effects', upgradeList(c['effects'], (fx) => withField(fx, 'systems', upgradeList(fx['systems'], (s) => withField(s, 'graph', upgradeGraph(s['graph'], count))))));
    if (c !== content) changed = true;
    nextContent = c;
  }
  return { content: nextContent, scenes: nextScenes, upgraded: count.n, changed };
}
