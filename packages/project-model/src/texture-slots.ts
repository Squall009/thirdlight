/**
 * Per-layer texture slots of a graph material.
 *
 * A texture parameter that a graph samples as an array (the height-blended
 * layers template's `albedoHeight`, `normals`, `orm`) may name one
 * single-layer texture asset per array layer instead of a prebuilt array:
 * its default (or a material instance's value) is then a list of texture
 * asset ids, slot i = array layer i. Trying another texture in one slot is
 * an instance with that one id changed; the slots it shares with its parent
 * stay one array.
 *
 * Play and the export assemble each distinct list into one KTX2 array (the
 * backend: UASTC layers joined as stored, the rest encoded once, cached by
 * the layers' digests) and hand the runtime that array under an id of its
 * own (`withAssembledSlots`), so the runtime only ever sees texture ids and
 * the exported game never needs the backend. The editor's views do the same
 * through the backend's assembly route.
 *
 * - An empty slot ("") of an array read as a normal map is a flat normal,
 *   and of one whose reading node says what it gives without a texture
 *   (`absent`: an ORM map's neutral) that value — a constant layer, named in
 *   the layer list by `fillLayerId` (never an asset id), so a layer left
 *   without its normal or ORM map looks as a material without one does.
 *   Any other empty slot takes the first filled slot's texture: an array
 *   needs every layer, and the first slot's texture keeps a join without
 *   re-encoding possible; a layer nothing paints never shows.
 * - The encoding of the array follows how the graph reads the parameter: a
 *   Normal map node makes it a normal map, a Sample texture or Triplanar
 *   node in linear colour space data, anything else colour
 *   (`textureSlotMode`).
 * - An object's overrides cannot hold slots (they stay plain values).
 * - An array whose alpha the graph reads as a height (`heightAlphaParams`:
 *   the layered surface's albedo) is a height array (`TextureSlotSet.height`):
 *   the assembly gives a layer whose texture has no height in A (none, or a
 *   flat one) a height made from its brightness, so its blends are not
 *   decided by a constant. Play, the export and the views all draw the one
 *   assembled array, so they agree.
 */
import { KTX2_ENCODINGS, MAX_TEXTURE_LAYERS, type Ktx2Encoding } from './content-limits';
import type { GraphData, GraphEdge, GraphNode } from './graph';
import { LAYER_NOT_READ, LAYERED_TEXTURES, TEMPLATE_LAYERS, UV_SOURCES } from './layered-surface';
import { heightAlphaParams } from './material-reads';
import { FLAT_NORMAL_TEXEL, MATERIAL_PARAMETER_KEY_RE, TEXTURE_ABSENT_VALUES } from './material-graph-kinds';
import { ID_MAX_LENGTH, ID_RE } from './validate';

export { KTX2_ENCODINGS };

/** A parameter value that is per-layer slots (a list of ids or ""). */
export function isTextureSlots(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === 'string');
}

/** Slots against the rules (null = valid): 1–MAX_TEXTURE_LAYERS entries, each a texture asset id or "", at least one filled. */
export function textureSlotsError(v: readonly unknown[]): string | null {
  if (v.length < 1 || v.length > MAX_TEXTURE_LAYERS) return `per-layer slots: a list of 1-${MAX_TEXTURE_LAYERS} texture asset ids`;
  if (!v.every((x) => typeof x === 'string' && (x === '' || ID_RE.test(x)))) return 'per-layer slots: each slot a texture asset id (or "" for empty)';
  if (v.every((x) => x === '')) return 'per-layer slots: at least one slot names a texture';
  return null;
}

/** The longest stem of a drawn node's or edge's id, leaving room for a `-n` that makes it unique within `ID_RE`. */
const DRAWN_ID_STEM = ID_MAX_LENGTH - 8;

/** Marks a constant layer in a layer list (asset ids never hold it). */
const FILL_PREFIX = '#';

/** The layer-list entry of a constant layer of `rgba` (0–1 per channel): `#rrggbbaa`. */
export function fillLayerId(rgba: readonly number[]): string {
  return FILL_PREFIX + [0, 1, 2, 3].map((c) => Math.max(0, Math.min(255, Math.round((rgba[c] ?? 1) * 255))).toString(16).padStart(2, '0')).join('');
}

/** A layered surface's empty layer in a height array as drawn (`layeredForDraw`): mid grey with height 0, so it never wins a blend. */
const NEUTRAL_HEIGHT_LAYER = fillLayerId([0.5, 0.5, 0.5, 0]);

/** A constant layer's bytes (RGBA 0–255) from its layer-list entry (null: an asset id). */
export function parseFillLayer(id: string): [number, number, number, number] | null {
  if (!/^#[0-9a-f]{8}$/.test(id)) return null;
  return [0, 1, 2, 3].map((c) => parseInt(id.slice(1 + c * 2, 3 + c * 2), 16)) as [number, number, number, number];
}

/**
 * What an empty slot of a parameter's array is (RGBA 0–1), from how the graph
 * reads it: a flat normal for a normal map, a reading node's `absent` value
 * where one says it; null — the first filled slot's texture — otherwise.
 */
export function textureSlotFill(graph: GraphData | undefined, key: string): readonly number[] | null {
  if (graph === undefined) return null;
  const params = new Set(graph.nodes.filter((n) => n.type === 'parameter' && n.data?.['key'] === key).map((n) => n.id));
  let fill: readonly number[] | null = null;
  // A read of no layer (`LAYER_NOT_READ`: a layer a drawn layered surface leaves out) says nothing of the slots.
  const readsNoLayer = (node: string): boolean => {
    const e = graph.edges.find((x) => x.to.node === node && x.to.port === 'layer');
    const from = e === undefined ? undefined : graph.nodes.find((n) => n.id === e.from.node);
    return from?.type === 'float' && Number(from.data?.['value']) === LAYER_NOT_READ;
  };
  for (const e of graph.edges) {
    if (!params.has(e.from.node) || readsNoLayer(e.to.node)) continue;
    const to = graph.nodes.find((n) => n.id === e.to.node);
    if (to?.type === 'normalMap' || (to?.type === 'projectedSample' && to.data?.['decode'] === 'normal')) return FLAT_NORMAL_TEXEL;
    const absent = to?.data?.['absent'];
    if (typeof absent === 'string' && absent in TEXTURE_ABSENT_VALUES) fill ??= TEXTURE_ABSENT_VALUES[absent as keyof typeof TEXTURE_ABSENT_VALUES];
  }
  return fill;
}

/**
 * The layers an array is assembled from: each slot's texture; an empty one
 * the constant `fill` (`textureSlotFill`) where given, else the first filled
 * slot's (null: none filled).
 */
export function textureSlotLayers(slots: readonly string[], fill: readonly number[] | null = null): string[] | null {
  const first = slots.find((s) => s !== '');
  if (first === undefined) return null;
  const empty = fill !== null ? fillLayerId(fill) : first;
  return slots.map((s) => (s === '' ? empty : s));
}

/** How the array of a parameter's slots is encoded, from how the material's graph reads the parameter. */
export function textureSlotMode(graph: GraphData | undefined, key: string): Ktx2Encoding {
  if (graph === undefined) return 'color';
  const params = new Set(graph.nodes.filter((n) => n.type === 'parameter' && n.data?.['key'] === key).map((n) => n.id));
  let mode: Ktx2Encoding = 'color';
  for (const e of graph.edges) {
    if (!params.has(e.from.node)) continue;
    const to = graph.nodes.find((n) => n.id === e.to.node);
    if (to?.type === 'normalMap' || (to?.type === 'projectedSample' && to.data?.['decode'] === 'normal')) return 'normal';
    // These read the texture with their own colour space field.
    if ((to?.type === 'sampleTexture' || to?.type === 'triplanar' || to?.type === 'projectedSample') && to.data?.['colorSpace'] === 'linear') mode = 'data';
  }
  return mode;
}

/** One list of slots a material draws with: the layers (empty slots filled) and the encoding. */
export interface TextureSlotSet {
  readonly layers: readonly string[];
  readonly mode: Ktx2Encoding;
  /** Its alpha is read as a height: a layer without one gets a height from its brightness (absent: A as it is). */
  readonly height?: true;
}

/** Marks a height array's key (after the encoding; no encoding holds it). */
const HEIGHT_KEY_MARK = '+height';

/** The key one assembled array is known by (the same layers, encoding and height rule are one array). */
export function textureSlotSetKey(s: TextureSlotSet): string {
  return `${s.mode}${s.height === true ? HEIGHT_KEY_MARK : ''}:${s.layers.join(',')}`;
}

/** The layers and encoding a `textureSlotSetKey` names (null: not such a key). */
export function parseTextureSlotSetKey(key: string): TextureSlotSet | null {
  const [head, list] = key.split(':', 2) as [string, string | undefined];
  const height = head.endsWith(HEIGHT_KEY_MARK);
  const mode = height ? head.slice(0, -HEIGHT_KEY_MARK.length) : head;
  if (!(KTX2_ENCODINGS as readonly string[]).includes(mode) || list === undefined || list === '') return null;
  return { mode: mode as Ktx2Encoding, layers: list.split(','), ...(height ? { height: true as const } : {}) };
}

/** The graphs' height parameters, once per graph object (a resolved instance shares its root's graph). */
const heightKeysOf = new WeakMap<GraphData, ReadonlySet<string>>();

/**
 * The texture parameters of a material whose arrays are height arrays (its
 * graph's `heightAlphaParams`, and their trim groups as `layeredForDraw`
 * names them).
 */
export function heightSlotKeys(m: { readonly graph?: GraphData }): ReadonlySet<string> {
  if (m.graph === undefined) return new Set();
  let keys = heightKeysOf.get(m.graph);
  if (keys === undefined) {
    const own = heightAlphaParams(m.graph);
    keys = new Set([...own, ...[...own].map(TRIM_GROUP_KEY)]);
    heightKeysOf.set(m.graph, keys);
  }
  return keys;
}

/**
 * The texture assets the materials read with their alpha as a height: the
 * textures of their height arrays' slots (`heightSlotKeys`) and a prebuilt
 * one in such a parameter. Resolved materials (an instance's values are its
 * own slots). A trim sheet whose albedo is among them has a height in A, not
 * an opacity, so its decal cells draw opaque (`planDecalPages`).
 */
export function heightAlphaTextures(materials: readonly SlottedMaterial[]): ReadonlySet<string> {
  const out = new Set<string>();
  for (const m of materials) {
    const keys = heightSlotKeys(m);
    if (keys.size === 0) continue;
    for (const p of m.parameters ?? []) {
      if (p.type !== 'texture' || !keys.has(p.key)) continue;
      if (isTextureSlots(p.default)) for (const id of p.default) if (id !== '' && parseFillLayer(id) === null) out.add(id);
      if (typeof p.default === 'string' && p.default !== '') out.add(p.default);
    }
  }
  return out;
}

/** The slot set a drawn material's parameter assembles to (null: no slot names a texture). */
function slotSetOf(m: SlottedMaterial, key: string, slots: readonly string[], heights: ReadonlySet<string>): TextureSlotSet | null {
  const layers = textureSlotLayers(slots, textureSlotFill(m.graph, key));
  if (layers === null) return null;
  return { layers, mode: textureSlotMode(m.graph, key), ...(heights.has(key) ? { height: true as const } : {}) };
}

interface SlottedMaterial {
  readonly materialId: string;
  readonly graph?: GraphData;
  readonly parameters?: readonly { readonly key: string; readonly type: string; readonly default: unknown; readonly extraLayers?: readonly number[] }[];
}

/**
 * The key a layered surface's trim group of an array is drawn under
 * (`layeredForDraw`). It is a parameter key like any other (an identifier):
 * the drawn material is what a build hands the runtime, whose read validates
 * every key. `layeredForDraw` splits only where it is free.
 */
export const TRIM_GROUP_KEY = (key: string): string => `${key}_trim`;

/** Whether a slotted parameter's trim group key is usable: an identifier no parameter of the material already has. */
function trimGroupKeyFree(key: string, params: readonly { readonly key: string }[]): boolean {
  const k = TRIM_GROUP_KEY(key);
  return MATERIAL_PARAMETER_KEY_RE.test(k) && !params.some((p) => p.key === k);
}

/**
 * A layered surface as it is drawn (the project's material is never
 * changed), when it has a layer whose UV source is the mesh's own UVs
 * (`geometry`: a trim sheet, a model's unwrap) among the layers it uses:
 *
 * - **used layers**: up to its last filled colour slot (at most four).
 *   The reads of the others read nothing (`LAYER_NOT_READ`; a colour read
 *   gives black, so its height never wins the blend) and their weights are
 *   masked to 0 before the Height blend;
 * - **groups**: the used `geometry` layers (trim sheets, the sheet's size)
 *   and the rest (tiling textures, their own size) each get their own slot
 *   list of every array — the trim group's under `TRIM_GROUP_KEY` — and each
 *   read reads its group's array at its index there. Two arrays per map at
 *   most, so a 512² moss never has to be stored at a 1024² sheet's size. A
 *   group whose list for an array names no texture reads nothing there (its
 *   absent value: a flat normal, a plain ORM).
 *
 * Any other material comes back as it is (block ground, a wall of tiling
 * layers only, a material with layers past the four — a terrain's: every
 * layer reads, as before). Only the template's
 * shape is recognised: reads of a slot-list texture parameter at a constant
 * layer.
 */
export function layeredForDraw<M extends SlottedMaterial>(m: M): M {
  const graph = m.graph;
  const params = m.parameters ?? [];
  const drawn = drawnLayersOf(m);
  if (graph === undefined || drawn === null) return m;
  const { used, geometry } = drawn;
  const groups = { trim: geometry.flatMap((g, i) => (g ? [i] : [])), tiling: geometry.flatMap((g, i) => (g ? [] : [i])) };
  const slotted = new Map(params.filter((p) => p.type === 'texture' && isTextureSlots(p.default)).map((p) => [p.key, p.default as string[]]));
  // A key whose trim group key is taken keeps one array for every layer (each read at its own index), as before groups.
  const split = groups.trim.length > 0 && groups.tiling.length > 0 && [...slotted.keys()].every((k) => trimGroupKeyFree(k, params));
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const into = (node: string, port: string): GraphEdge | undefined => graph.edges.find((e) => e.to.node === node && e.to.port === port);
  const nodes: GraphNode[] = [...graph.nodes];
  const edges: GraphEdge[] = [...graph.edges];
  // The drawn graph is what a build hands the runtime, whose read validates it: its own nodes and edges get ids like
  // a project's (`ID_RE`), unused by the material's graph.
  const taken = new Set([...nodes.map((n) => n.id), ...edges.map((e) => e.id)]);
  const freshId = (base: string): string => {
    const stem = base.toLowerCase().slice(0, DRAWN_ID_STEM);
    let id = stem;
    for (let i = 2; taken.has(id); i += 1) id = `${stem}-${i}`;
    taken.add(id);
    return id;
  };
  const ours = new Map<string, string>();
  /** A node of the drawn graph (once per name). */
  const node = (name: string, type: string, data: Record<string, unknown>): string => {
    let id = ours.get(name);
    if (id === undefined) {
      id = freshId(`draw-${name}`);
      ours.set(name, id);
      nodes.push({ id, type, position: [0, 0], data } as GraphNode);
    }
    return id;
  };
  const edge = (from: string, fromPort: string, to: string, port: string): GraphEdge => ({ id: freshId('draw-edge'), from: { node: from, port: fromPort }, to: { node: to, port } });
  const rewire = (to: string, port: string, from: string, fromPort: string): void => {
    const i = edges.findIndex((e) => e.to.node === to && e.to.port === port);
    if (i >= 0) edges[i] = edge(from, fromPort, to, port);
    else edges.push(edge(from, fromPort, to, port));
  };
  const notRead = (): string => node('notRead', 'float', { value: LAYER_NOT_READ });
  const heightKeys = heightSlotKeys(m);
  /**
   * A group's slots of an array: its layers' slots ("" past the list). In a
   * height array an empty slot is a neutral constant layer (mid grey, height
   * 0: it never wins a blend), not the first filled slot's texture, once the
   * list names a texture to take its size from.
   */
  const groupSlots = (key: string, slots: readonly string[], layers: readonly number[]): string[] => {
    const l = layers.map((i) => slots[i] ?? '');
    return heightKeys.has(key) && l.some((x) => x !== '') ? l.map((x) => (x === '' ? NEUTRAL_HEIGHT_LAYER : x)) : l;
  };
  type Group = 'tiling' | 'trim';
  /** Each slotted array's lists as drawn, per group (unsplit: the used layers, all under `tiling`). */
  const lists = new Map<string, Record<Group, string[]>>();
  for (const [key, slots] of slotted) lists.set(key, split ? { tiling: groupSlots(key, slots, groups.tiling), trim: groupSlots(key, slots, groups.trim) } : { tiling: groupSlots(key, slots, Array.from({ length: used }, (_, i) => i)), trim: [] });
  for (const n of graph.nodes) {
    if (n.type !== 'projectedSample' && n.type !== 'sampleTexture' && n.type !== 'normalMap') continue;
    const tex = into(n.id, 'tex');
    const source = tex === undefined ? undefined : byId.get(tex.from.node);
    const key = source?.type === 'parameter' ? String(source.data?.['key'] ?? '') : '';
    const drawnLists = lists.get(key);
    const layerEdge = into(n.id, 'layer');
    const layerNode = layerEdge === undefined ? undefined : byId.get(layerEdge.from.node);
    const layer = layerNode?.type === 'float' ? Number(layerNode.data?.['value'] ?? 0) : Number.NaN;
    if (!params.some((p) => p.key === key && p.type === 'texture') || !Number.isInteger(layer) || layer < 0) continue;
    const colourRead = n.type !== 'normalMap' && n.data?.['decode'] !== 'normal' && n.data?.['absent'] !== 'orm';
    if (layer >= used) {
      // A layer the material does not use: no read; a colour read gives black (no height to win the blend with).
      if (colourRead) {
        const i = nodes.indexOf(n);
        nodes[i] = { ...n, data: { ...(n.data ?? {}), absent: 'black' } };
      }
      rewire(n.id, 'layer', notRead(), 'value');
      continue;
    }
    // A prebuilt array (or none) is read as it is: its layers are all there.
    if (drawnLists === undefined) continue;
    const group: Group = split && geometry[layer] === true ? 'trim' : 'tiling';
    let target = group;
    let local = split ? groups[group].indexOf(layer) : layer;
    if (drawnLists[group].every((x) => x === '')) {
      // A group whose list names no texture: a height array's colour read takes the neutral layer from the other
      // group's array (one constant layer more there); any other read reads nothing (its absent value).
      const other: Group = group === 'trim' ? 'tiling' : 'trim';
      if (!(split && colourRead && heightKeys.has(key) && drawnLists[other].some((x) => x !== ''))) {
        rewire(n.id, 'layer', notRead(), 'value');
        continue;
      }
      if (!drawnLists[other].includes(NEUTRAL_HEIGHT_LAYER)) drawnLists[other].push(NEUTRAL_HEIGHT_LAYER);
      target = other;
      local = drawnLists[other].indexOf(NEUTRAL_HEIGHT_LAYER);
    }
    if (!split) continue;
    rewire(n.id, 'layer', node(`${target}Layer${local + 1}`, 'float', { value: local }), 'value');
    if (target === 'trim') rewire(n.id, 'tex', node(TRIM_GROUP_KEY(key), 'parameter', { key: TRIM_GROUP_KEY(key) }), 'value');
  }
  // The unused layers' weights are 0 before the blend (whatever the paint says).
  if (used < TEMPLATE_LAYERS) {
    const mask = node('usedLayers', 'vec4', { value: Array.from({ length: TEMPLATE_LAYERS }, (_, i) => (i < used ? 1 : 0)) });
    for (const n of graph.nodes) {
      if (n.type !== 'heightBlend') continue;
      const w = into(n.id, 'weights');
      if (w === undefined) continue;
      const masked = node(`${n.id}UsedWeights`, 'multiply', {});
      edges.push(edge(w.from.node, w.from.port, masked, 'a'), edge(mask, 'value', masked, 'b'));
      rewire(n.id, 'weights', masked, 'out');
    }
  }
  const parameters = params.flatMap((p) => {
    const l = lists.get(p.key);
    if (l === undefined) return [p];
    const list = (x: readonly string[]): string[] | '' => (x.every((s) => s === '') ? '' : [...x]);
    if (!split) return [{ ...p, default: list(l.tiling) }];
    return [
      { ...p, default: list(l.tiling) },
      { ...p, key: TRIM_GROUP_KEY(p.key), default: list(l.trim) },
    ];
  });
  return { ...m, graph: { ...graph, nodes, edges }, parameters };
}

/** The layers a layered surface draws and which of them read the mesh's own UVs (null: it draws as it is, every layer). */
function drawnLayersOf(m: SlottedMaterial): { used: number; geometry: boolean[] } | null {
  const params = m.parameters ?? [];
  const albedo = params.find((p) => p.key === LAYERED_TEXTURES.albedo && p.type === 'texture');
  if (albedo === undefined || !isTextureSlots(albedo.default)) return null;
  const projection = params.find((p) => p.key === 'layerProjection' && p.type === 'vec4' && Array.isArray(p.default))?.default as readonly number[] | undefined;
  // Up to its last filled colour slot (a palette's list keeps empty slots past the layers in use).
  const lastFilled = (slots: readonly string[]): number => slots.reduce((last, id, i) => (id !== '' ? i + 1 : last), 0);
  const filled = lastFilled(albedo.default);
  // A material with layers past the four is a terrain's (only a terrain draws them, picking per pixel which array
  // layer each of the four slots shows): renumbering its layers per group or masking slots by number would read the
  // wrong layers there, so it draws as it is, every layer in one array.
  const pastFour = params.some((p) => (p.type === 'texture' && isTextureSlots(p.default) && lastFilled(p.default) > TEMPLATE_LAYERS) || (p.extraLayers?.length ?? 0) > 0);
  if (pastFour) return null;
  const used = Math.max(1, Math.min(TEMPLATE_LAYERS, filled));
  const geometry = Array.from({ length: used }, (_, i) => Math.round(Number(projection?.[i] ?? 0)) === UV_SOURCES.geometry);
  return geometry.some(Boolean) ? { used, geometry } : null;
}

/** How many layers a layered material reads per pixel (`layeredForDraw`): its used ones, else all four. */
export function layeredDrawnLayers(m: SlottedMaterial): number {
  return drawnLayersOf(m)?.used ?? TEMPLATE_LAYERS;
}

/** Every distinct slot set the materials (resolved: no instances) draw with, in first-use order. */
export function materialTextureSlotSets(materials: readonly SlottedMaterial[]): TextureSlotSet[] {
  const out = new Map<string, TextureSlotSet>();
  for (const source of materials) {
    const heights = heightSlotKeys(source);
    const m = layeredForDraw(source);
    for (const p of m.parameters ?? []) {
      if (p.type !== 'texture' || !isTextureSlots(p.default)) continue;
      const set = slotSetOf(m, p.key, p.default, heights);
      if (set === null) continue;
      const k = textureSlotSetKey(set);
      if (!out.has(k)) out.set(k, set);
    }
  }
  return [...out.values()];
}

/** Whether any material (resolved) names per-layer slots. */
export function hasTextureSlots(materials: readonly SlottedMaterial[]): boolean {
  return materials.some((m) => (m.parameters ?? []).some((p) => p.type === 'texture' && isTextureSlots(p.default)));
}

/**
 * The materials as drawn (`layeredForDraw`) with each slot list replaced by
 * the id of its assembled array (`idOf`: by `textureSlotSetKey`; "" when it
 * has none). Materials without slots are returned as they are.
 */
export function withAssembledSlots<M extends SlottedMaterial>(materials: readonly M[], idOf: (set: TextureSlotSet) => string): M[] {
  return materials.map((source) => {
    const m = layeredForDraw(source);
    if (!hasTextureSlots([m])) return m;
    const heights = heightSlotKeys(source);
    const parameters = (m.parameters ?? []).map((p) => {
      if (p.type !== 'texture' || !isTextureSlots(p.default)) return p;
      const set = slotSetOf(m, p.key, p.default, heights);
      return { ...p, default: set === null ? '' : idOf(set) };
    });
    return { ...m, parameters };
  });
}

/** The texture assets a material's slots name (its own defaults and an instance's values). */
export function materialSlotTextureRefs(m: { readonly parameters?: readonly { readonly type: string; readonly default: unknown }[]; readonly values?: Readonly<Record<string, unknown>> }): string[] {
  const out = new Set<string>();
  const add = (v: unknown): void => {
    if (isTextureSlots(v)) for (const id of v) if (id !== '') out.add(id);
  };
  for (const p of m.parameters ?? []) if (p.type === 'texture') add(p.default);
  for (const v of Object.values(m.values ?? {})) add(v);
  return [...out].sort();
}
