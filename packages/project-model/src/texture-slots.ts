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
 */
import { KTX2_ENCODINGS, MAX_TEXTURE_LAYERS, type Ktx2Encoding } from './content-limits';
import type { GraphData } from './graph';
import { FLAT_NORMAL_TEXEL, TEXTURE_ABSENT_VALUES } from './material-graph-kinds';
import { ID_RE } from './validate';

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

/** Marks a constant layer in a layer list (asset ids never hold it). */
const FILL_PREFIX = '#';

/** The layer-list entry of a constant layer of `rgba` (0–1 per channel): `#rrggbbaa`. */
export function fillLayerId(rgba: readonly number[]): string {
  return FILL_PREFIX + [0, 1, 2, 3].map((c) => Math.max(0, Math.min(255, Math.round((rgba[c] ?? 1) * 255))).toString(16).padStart(2, '0')).join('');
}

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
  for (const e of graph.edges) {
    if (!params.has(e.from.node)) continue;
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
}

/** The key one assembled array is known by (the same layers and encoding are one array). */
export function textureSlotSetKey(s: TextureSlotSet): string {
  return `${s.mode}:${s.layers.join(',')}`;
}

/** The layers and encoding a `textureSlotSetKey` names (null: not such a key). */
export function parseTextureSlotSetKey(key: string): TextureSlotSet | null {
  const [mode, list] = key.split(':', 2) as [string, string | undefined];
  if (!(KTX2_ENCODINGS as readonly string[]).includes(mode) || list === undefined || list === '') return null;
  return { mode: mode as Ktx2Encoding, layers: list.split(',') };
}

interface SlottedMaterial {
  readonly materialId: string;
  readonly graph?: GraphData;
  readonly parameters?: readonly { readonly key: string; readonly type: string; readonly default: unknown }[];
}

/** Every distinct slot set the materials (resolved: no instances) draw with, in first-use order. */
export function materialTextureSlotSets(materials: readonly SlottedMaterial[]): TextureSlotSet[] {
  const out = new Map<string, TextureSlotSet>();
  for (const m of materials) {
    for (const p of m.parameters ?? []) {
      if (p.type !== 'texture' || !isTextureSlots(p.default)) continue;
      const layers = textureSlotLayers(p.default, textureSlotFill(m.graph, p.key));
      if (layers === null) continue;
      const set: TextureSlotSet = { layers, mode: textureSlotMode(m.graph, p.key) };
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
 * The materials with each slot list replaced by the id of its assembled
 * array (`idOf`: by `textureSlotSetKey`; "" when it has none). Materials
 * without slots are returned as they are.
 */
export function withAssembledSlots<M extends SlottedMaterial>(materials: readonly M[], idOf: (set: TextureSlotSet) => string): M[] {
  return materials.map((m) => {
    if (!hasTextureSlots([m])) return m;
    const parameters = (m.parameters ?? []).map((p) => {
      if (p.type !== 'texture' || !isTextureSlots(p.default)) return p;
      const layers = textureSlotLayers(p.default, textureSlotFill(m.graph, p.key));
      return { ...p, default: layers === null ? '' : idOf({ layers, mode: textureSlotMode(m.graph, p.key) }) };
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
