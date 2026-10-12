/**
 * The layer palette's model: what a layered material's layers are (one per
 * texture-array layer of its albedo parameter), what each is called and
 * shows, and the edits the palette makes to the material (a texture into a
 * slot, a name, one layer's setting). Every edit is a whole material handed
 * to one `setMaterial`, as the material document's are.
 *
 * - A layer's picture is its slot texture's tile thumbnail (the backend's,
 *   made from the texture's image); a prebuilt array's layers have none.
 * - A layer's name is the material's `layerNames` entry, else the slot
 *   texture's name, else "Layer N" (N counts from 1, as the palette shows it;
 *   the stored layer index is N − 1).
 * - Without a layered material the object draws the four stand-in colours,
 *   and the palette shows them as such.
 *
 * Pure.
 */
import type { MaterialDef, MaterialParameter } from '@thirdlight/project-model';
import { MATERIAL_SLOT_ALL } from '@thirdlight/project-model/limits';
import { isTextureSlots } from '@thirdlight/project-model/texture-slots';

import { LAYER_SETTINGS, LAYERED_TEXTURES, TEMPLATE_LAYERS } from './material-graph';

/** One tile of the palette. */
export interface PaletteLayer {
  /** The texture-array layer (the index paint, rules and scatter store). */
  readonly index: number;
  readonly name: string;
  /** The slot's texture (its thumbnail); null: none to show (an empty slot, a prebuilt array's layer, no material). */
  readonly texture: string | null;
  /** A stand-in colour (no material). */
  readonly colour?: string;
  /** The slot names no texture (it draws the first filled slot's). */
  readonly empty?: boolean;
  /** A short line under the name (its tiling and projection). */
  readonly sub?: string;
}

/** What the palette knows of an object's material. */
export type PaletteSource =
  /** No layered material: the stand-in colours. */
  | { readonly kind: 'none'; readonly material: MaterialDef | null }
  /** A layered material the palette edits. */
  | { readonly kind: 'layered'; readonly material: MaterialDef; readonly slots: 'slots' | 'array' | 'unset' }
  /** A material instance of a layered material: shown, edited on its parent. */
  | { readonly kind: 'instance'; readonly material: MaterialDef; readonly parent: string };

/** Whether a material is a layered one (it has the template's albedo array parameter). */
export function isLayeredMaterial(m: Pick<MaterialDef, 'parameters'> | null | undefined): boolean {
  return (m?.parameters ?? []).some((p) => p.key === LAYERED_TEXTURES.albedo && p.type === 'texture');
}

/** The albedo parameter of a layered material. */
function albedoParam(m: MaterialDef): MaterialParameter | undefined {
  return (m.parameters ?? []).find((p) => p.key === LAYERED_TEXTURES.albedo && p.type === 'texture');
}

/** The material an object draws with for all of its materials (its "*" slot), resolved to a root when it is an instance. */
export function paletteSource(mapping: Readonly<Record<string, string>> | undefined, materials: readonly MaterialDef[]): PaletteSource {
  const id = mapping?.[MATERIAL_SLOT_ALL];
  const own = id === undefined ? undefined : materials.find((m) => m.materialId === id);
  if (own === undefined) return { kind: 'none', material: null };
  if (own.instanceOf !== undefined) {
    let root: MaterialDef | undefined = own;
    for (let i = 0; i < 16 && root?.instanceOf !== undefined; i++) root = materials.find((m) => m.materialId === root!.instanceOf);
    return root !== undefined && isLayeredMaterial(root) ? { kind: 'instance', material: root, parent: own.instanceOf } : { kind: 'none', material: own };
  }
  if (!isLayeredMaterial(own)) return { kind: 'none', material: own };
  const v = albedoParam(own)!.default;
  return { kind: 'layered', material: own, slots: isTextureSlots(v) ? 'slots' : v === '' ? 'unset' : 'array' };
}

/** A per-layer setting's value for a layer (past the vec4's four: its `extraLayers`, else column L % 4's). */
export function layerSettingValue(param: Pick<MaterialParameter, 'default' | 'extraLayers'>, layer: number, fill: number): number {
  const four = Array.isArray(param.default) ? (param.default as number[]) : [];
  if (layer < TEMPLATE_LAYERS) return four[layer] ?? fill;
  return param.extraLayers?.[layer - TEMPLATE_LAYERS] ?? four[layer % TEMPLATE_LAYERS] ?? fill;
}

type SettingKey = (typeof LAYER_SETTINGS)[number]['key'];

/** A layer's value of a per-layer setting (null: the material has no such setting). */
export function layerSetting(m: MaterialDef, key: SettingKey, layer: number): number | null {
  const s = LAYER_SETTINGS.find((x) => x.key === key)!;
  const p = (m.parameters ?? []).find((x) => x.key === key && x.type === 'vec4');
  return p === undefined ? null : layerSettingValue(p, layer, s.fill);
}

/** The material with one layer's setting changed (a layer past the four gets its own value; the ones before it keep what they showed). */
export function withLayerSetting(m: MaterialDef, key: SettingKey, layer: number, value: number): MaterialDef {
  const parameters = (m.parameters ?? []).map((p) => {
    if (p.key !== key || p.type !== 'vec4' || !Array.isArray(p.default)) return p;
    const four = [...(p.default as number[])];
    if (layer < TEMPLATE_LAYERS) {
      four[layer] = value;
      return { ...p, default: four };
    }
    const extra = [...(p.extraLayers ?? [])];
    while (TEMPLATE_LAYERS + extra.length <= layer) extra.push(four[(TEMPLATE_LAYERS + extra.length) % TEMPLATE_LAYERS] ?? 0);
    extra[layer - TEMPLATE_LAYERS] = value;
    return { ...p, extraLayers: extra };
  });
  return { ...m, parameters };
}

/** The material with a texture in a layer's albedo slot (unset or slots only: a prebuilt array is one texture asset). */
export function withSlotTexture(m: MaterialDef, layer: number, textureId: string): MaterialDef {
  const parameters = (m.parameters ?? []).map((p) => {
    if (p.key !== LAYERED_TEXTURES.albedo || p.type !== 'texture') return p;
    const slots = isTextureSlots(p.default) ? [...p.default] : Array.from({ length: TEMPLATE_LAYERS }, () => '');
    while (slots.length <= layer) slots.push('');
    slots[layer] = textureId;
    return { ...p, default: slots };
  });
  return { ...m, parameters };
}

/** The material with a layer's palette name ("" = its texture's name). */
export function withLayerName(m: MaterialDef, layer: number, name: string): MaterialDef {
  const names = [...(m.layerNames ?? [])];
  while (names.length <= layer) names.push('');
  names[layer] = name.trim();
  let n = names.length;
  while (n > 0 && names[n - 1] === '') n--;
  const { layerNames: _old, ...rest } = m;
  return n === 0 ? rest : { ...rest, layerNames: names.slice(0, n) };
}

/** The tiles of a layered material: one per slot (or per layer of a prebuilt array, `arrayLayers` of it). */
export function paletteLayers(m: MaterialDef, nameOf: (textureId: string) => string | undefined, arrayLayers: number | null): PaletteLayer[] {
  const v = albedoParam(m)?.default;
  const slots = isTextureSlots(v) ? v : null;
  const count = slots !== null ? slots.length : typeof v === 'string' && v !== '' ? Math.max(1, arrayLayers ?? TEMPLATE_LAYERS) : TEMPLATE_LAYERS;
  return Array.from({ length: count }, (_, i): PaletteLayer => {
    const slot = slots?.[i] ?? '';
    // A one-layer texture in place of an array is that texture's picture.
    const texture = slots !== null ? (slot === '' ? null : slot) : typeof v === 'string' && v !== '' && count === 1 ? v : null;
    const own = m.layerNames?.[i] ?? '';
    const name = own !== '' ? own : (texture !== null ? nameOf(texture) : undefined) ?? `Layer ${i + 1}`;
    const sub = layerSub(m, i);
    // No texture yet (an empty slot, or none of them set): a place to drop one.
    const empty = slots !== null ? slot === '' : v === '' || v === undefined;
    return { index: i, name, texture, ...(empty ? { empty: true } : {}), ...(sub !== '' ? { sub } : {}) };
  });
}

/** "tiling 5 m · biplanar": the settings a layer's tile shows under its name. */
export function layerSub(m: MaterialDef, layer: number): string {
  const tiling = layerSetting(m, 'layerTiling', layer);
  const projection = layerSetting(m, 'layerProjection', layer);
  const parts: string[] = [];
  if (tiling !== null) parts.push(`tiling ${Number(tiling.toFixed(2))} m`);
  const opt = LAYER_SETTINGS[4].options.find((o) => o.value === projection);
  if (opt !== undefined && opt.value !== 0) parts.push(opt.label);
  return parts.join(' · ');
}

/** The stand-in tiles of an object without a layered material (its four default colours). */
export function standInLayers(colours: readonly string[]): PaletteLayer[] {
  return colours.map((colour, i) => ({ index: i, name: `Layer ${i + 1}`, texture: null, colour, sub: 'no material' }));
}
