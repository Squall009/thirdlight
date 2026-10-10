/**
 * Decals: marks (dirt, cracks, stains, signs, scorch marks) laid over the
 * surfaces of a level without new unique textures.
 *
 * The `decal` component is a box around its entity that marks the surfaces
 * inside it, projected along the entity's −Z (the image lies in its XY
 * plane, +Y up). Two modes:
 * - `projected`: the receiving materials blend the decal into their surface
 *   before it is lit, channel by channel (albedo, normal, roughness,
 *   metalness, occlusion, emission), so a wet patch can change roughness
 *   only and a crack the normal only;
 * - `clipped`: a mesh is clipped from the receivers' geometry inside the box
 *   at load and drawn as a mesh decal (its own lit colour blended over the
 *   surface, the material's `blend`).
 * The component stores the projector only, never triangles: a clipped mesh
 * is made again whenever a receiver changes, as generated architecture is.
 *
 * Its material is a `decal` material (`materials.ts`): its own albedo with
 * opacity in alpha, normal, ORM and emissive textures, or one decal cell of
 * a trim sheet (`decal: {sheet, cell}`, the cell a named rectangle of the
 * sheet's `cells`).
 *
 * Decal layers. A decal marks the receivers in any of its `layers`; every
 * drawn object (box, model, instance set, block layer, terrain, generated
 * architecture, spline) carries `decalLayers`, a bit mask of the
 * {@link DECAL_LAYER_COUNT} layers (HDRP's decal layers, Godot's cull mask).
 * Absent, an object is in every layer, except a skinned model, which is in
 * none: a projector fixed in the world slides over a moving skin (marks on a
 * character are mesh decals parented to a bone).
 *
 * There is no cap on decals in a project; what a pixel pays for is the
 * renderer's budget.
 *
 * Pure data rules: no three.js, no I/O.
 */
import type { ModelErrorV2 } from './errors';
import { ID_RE } from './validate';
import type { Vec3 } from './types';

/** How many decal layers there are: the width of every decal layer mask (one row of checkboxes, as light layers). */
export const DECAL_LAYER_COUNT = 8;
/** Every decal layer: the default of every mask. */
export const DECAL_LAYERS_ALL = (1 << DECAL_LAYER_COUNT) - 1;

/** How a decal reaches its receivers (see the module comment). */
export const DECAL_MODES = ['projected', 'clipped'] as const;
export type DecalMode = (typeof DECAL_MODES)[number];

/** The surface channels a projected decal changes, each with its own opacity. */
export const DECAL_CHANNELS = ['albedo', 'normal', 'roughness', 'metalness', 'occlusion', 'emission'] as const;
export type DecalChannel = (typeof DECAL_CHANNELS)[number];

/** How a mesh or clipped decal's lit colour goes over the surface: over it, darkening it (stains), or adding light (glow). */
export const DECAL_BLENDS = ['blend', 'multiply', 'add'] as const;
export type DecalBlend = (typeof DECAL_BLENDS)[number];

/**
 * The component's bounds:
 * - a box side up to 1000 m: a decal is a mark on a level, the size of a
 *   puddle to a road marking; a whole-level change is a material's job;
 * - the normal fade is the angle from facing the projector, 1–180°: 180
 *   lets back faces take the mark too;
 * - edge fades are fractions of the box depth;
 * - the fade distance runs to the farthest a camera sees (a far plane's 100 km);
 * - sort orders −1000 to 1000 leave room between groups of marks.
 */
export const DECAL_LIMITS = {
  sizeMax: 1000,
  normalFadeMin: 1,
  normalFadeMax: 180,
  fadeDistanceMax: 100_000,
  sortOrderMin: -1000,
  sortOrderMax: 1000,
} as const;

/**
 * A new decal: a 1 m cube projected along −Z; faces turned more than 90°
 * from the projector get nothing (it fades out over the last fifth of the
 * angle); it fades over 30 % of the box depth at each end (Godot's upper
 * and lower fades), so a mark ends softly on a surface that leaves the box.
 */
export const DECAL_DEFAULTS = {
  size: [1, 1, 1] as Vec3,
  mode: 'projected' as DecalMode,
  normalFade: 90,
  edgeFade: [0.3, 0.3] as [number, number],
  sortOrder: 0,
} as const;

/** Per-channel opacities (absent: 1, the material's own opacity). */
export type DecalOpacity = Partial<Record<DecalChannel, number>>;

export interface DecalComponent {
  /** The box [width, height, depth] in metres, centred on the entity; it projects along the entity's −Z. */
  size: Vec3;
  /** Absent: projected. */
  mode?: DecalMode;
  /** A decal material (its `shader` is `decal`). */
  material: string;
  /** Projected decals: how much of each channel it changes (absent: all of each). */
  opacity?: DecalOpacity;
  /** Degrees from facing the projector past which a surface takes no mark (absent: {@link DECAL_DEFAULTS}). */
  normalFade?: number;
  /** [front, back]: the fraction of the box depth it fades over at each end (absent: {@link DECAL_DEFAULTS}). */
  edgeFade?: [number, number];
  /** Metres from the camera where it has faded out, over the last fifth (absent: never). */
  fadeDistance?: number;
  /** Where decals overlap, the higher order is drawn over the lower (absent: 0). */
  sortOrder?: number;
  /** The decal layers it marks, a bit mask (absent: every layer). */
  layers?: number;
}

/** The component's fields in canonical order. */
export const DECAL_FIELDS: readonly string[] = Object.freeze(['size', 'mode', 'material', 'opacity', 'normalFade', 'edgeFade', 'fadeDistance', 'sortOrder', 'layers']);

/** A decal material's cell of a trim sheet: the sheet (a trim material) and the cell's name in its `cells`. */
export interface DecalCellRef {
  sheet: string;
  cell: string;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
function err(errors: ModelErrorV2[], code: string, path: string, message: string, found?: unknown): void {
  errors.push({ code, path, message, ...(found !== undefined ? { found } : {}) } as ModelErrorV2);
}
const finite = (v: unknown, lo: number, hi: number): v is number => typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi;

/** A decal layer mask as the renderer reads it: a valid mask, else the default (every layer; none for a skinned model). */
export function decalLayersOf(v: unknown, skinned = false): number {
  if (typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= DECAL_LAYERS_ALL) return v;
  return skinned ? 0 : DECAL_LAYERS_ALL;
}

/** An optional decal layer mask: an integer from `min` (a receiver may take none, a decal marks at least one) to every layer. */
export function validateDecalLayerMask(v: unknown, path: string, errors: ModelErrorV2[], min: 0 | 1): void {
  if (v === undefined) return;
  if (typeof v !== 'number' || !Number.isInteger(v) || v < min || v > DECAL_LAYERS_ALL) {
    err(errors, 'field_value', path, `a decal layer mask is an integer ${min}-${DECAL_LAYERS_ALL}: bit n is layer n + 1 (${DECAL_LAYER_COUNT} layers; ${DECAL_LAYERS_ALL}: every layer)`, v);
  }
}

export function validateDecalComponent(value: unknown, path: string, errors: ModelErrorV2[]): void {
  const L = DECAL_LIMITS;
  if (!isPlainObject(value)) return err(errors, 'field_type', path, 'a decal is an object { size, material, mode?, opacity?, normalFade?, edgeFade?, fadeDistance?, sortOrder?, layers? }', value);
  for (const k of Object.keys(value)) if (!DECAL_FIELDS.includes(k)) err(errors, 'field_unexpected', `${path}/${k}`, `unknown decal field "${k}" (${DECAL_FIELDS.join(', ')})`, k);
  const size = value['size'];
  if (size === undefined) err(errors, 'field_missing', `${path}/size`, 'size is required');
  else if (!(Array.isArray(size) && size.length === 3 && size.every((n) => typeof n === 'number' && Number.isFinite(n) && n > 0 && n <= L.sizeMax))) err(errors, 'field_value', `${path}/size`, `size is [width, height, depth] in metres, each 0 < v <= ${L.sizeMax}`, size);
  const mode = value['mode'];
  if (mode !== undefined && !(DECAL_MODES as readonly unknown[]).includes(mode)) err(errors, 'field_value', `${path}/mode`, `mode is one of ${DECAL_MODES.join(', ')}`, mode);
  const material = value['material'];
  if (material === undefined) err(errors, 'field_missing', `${path}/material`, 'material is required (a decal material)');
  else if (typeof material !== 'string' || !ID_RE.test(material)) err(errors, 'id_invalid', `${path}/material`, 'material names a decal material (its materialId)', material);
  const opacity = value['opacity'];
  if (opacity !== undefined) {
    if (!isPlainObject(opacity)) err(errors, 'field_type', `${path}/opacity`, `opacity is {${DECAL_CHANNELS.join('?, ')}?}, each 0-1`, opacity);
    else {
      for (const [k, v] of Object.entries(opacity)) {
        if (!(DECAL_CHANNELS as readonly string[]).includes(k)) err(errors, 'field_unexpected', `${path}/opacity/${k}`, `unknown decal channel "${k}" (${DECAL_CHANNELS.join(', ')})`, k);
        else if (!finite(v, 0, 1)) err(errors, 'field_value', `${path}/opacity/${k}`, `the ${k} opacity is 0-1`, v);
      }
    }
  }
  const fade = value['normalFade'];
  if (fade !== undefined && !finite(fade, L.normalFadeMin, L.normalFadeMax)) err(errors, 'field_value', `${path}/normalFade`, `normalFade is degrees, ${L.normalFadeMin}-${L.normalFadeMax}`, fade);
  const edge = value['edgeFade'];
  if (edge !== undefined && !(Array.isArray(edge) && edge.length === 2 && edge.every((x) => finite(x, 0, 1)))) err(errors, 'field_value', `${path}/edgeFade`, 'edgeFade is [front, back], each a fraction 0-1 of the box depth', edge);
  const far = value['fadeDistance'];
  if (far !== undefined && !(finite(far, 0, L.fadeDistanceMax) && far > 0)) err(errors, 'field_value', `${path}/fadeDistance`, `fadeDistance is metres, 0 < v <= ${L.fadeDistanceMax}`, far);
  const order = value['sortOrder'];
  if (order !== undefined && !(finite(order, L.sortOrderMin, L.sortOrderMax) && Number.isInteger(order))) err(errors, 'field_value', `${path}/sortOrder`, `sortOrder is an integer ${L.sortOrderMin}-${L.sortOrderMax}`, order);
  validateDecalLayerMask(value['layers'], `${path}/layers`, errors, 1);
}

/** The component in canonical form: fields in order, channels in {@link DECAL_CHANNELS} order, optional fields only when set. */
export function canonicalDecal(c: DecalComponent): DecalComponent {
  const ordered: Record<string, unknown> = { size: [c.size[0], c.size[1], c.size[2]] };
  if (c.mode !== undefined) ordered['mode'] = c.mode;
  ordered['material'] = c.material;
  if (c.opacity !== undefined) {
    const o: DecalOpacity = {};
    for (const ch of DECAL_CHANNELS) if (c.opacity[ch] !== undefined) o[ch] = c.opacity[ch];
    ordered['opacity'] = o;
  }
  if (c.normalFade !== undefined) ordered['normalFade'] = c.normalFade;
  if (c.edgeFade !== undefined) ordered['edgeFade'] = [c.edgeFade[0], c.edgeFade[1]];
  if (c.fadeDistance !== undefined) ordered['fadeDistance'] = c.fadeDistance;
  if (c.sortOrder !== undefined) ordered['sortOrder'] = c.sortOrder;
  if (c.layers !== undefined) ordered['layers'] = c.layers;
  return ordered as unknown as DecalComponent;
}

/** A decal material's `decal` field on its own (ids only; the sheet and the cell are checked against the list by {@link validateDecalCells}). */
export function validateDecalCellRef(v: unknown, path: string, errors: ModelErrorV2[]): void {
  if (!isPlainObject(v)) return err(errors, 'field_type', path, 'decal is {sheet, cell}: a trim material and the name of one of its decal cells', v);
  for (const k of Object.keys(v)) if (k !== 'sheet' && k !== 'cell') err(errors, 'field_unexpected', `${path}/${k}`, `unknown decal cell field "${k}" (sheet, cell)`, k);
  if (v['sheet'] === undefined) err(errors, 'field_missing', `${path}/sheet`, 'sheet is required (a trim material)');
  else if (typeof v['sheet'] !== 'string' || !ID_RE.test(v['sheet'])) err(errors, 'id_invalid', `${path}/sheet`, 'sheet names a trim material (its materialId)', v['sheet']);
  if (v['cell'] === undefined) err(errors, 'field_missing', `${path}/cell`, 'cell is required (a decal cell of the sheet)');
  else if (typeof v['cell'] !== 'string' || !ID_RE.test(v['cell'])) err(errors, 'field_value', `${path}/cell`, 'cell is a decal cell name (the id syntax [a-z0-9][a-z0-9_-]{0,63})', v['cell']);
}

/**
 * The rules between decal materials and their sheets (the whole list): a
 * decal material's `decal.sheet` names a trim material (not an instance:
 * the sheet is the root's table) and `decal.cell` one of its cells.
 */
export function validateDecalCells(value: unknown, path: string, errors: ModelErrorV2[]): void {
  if (!Array.isArray(value)) return;
  const byId = new Map<unknown, Record<string, unknown>>();
  for (const m of value) if (isPlainObject(m)) byId.set(m['materialId'], m);
  value.forEach((m, i) => {
    if (!isPlainObject(m) || !isPlainObject(m['decal'])) return;
    const ref = m['decal'];
    const sheet = byId.get(ref['sheet']);
    const p = `${path}/${i}/decal`;
    if (sheet === undefined) return err(errors, 'reference_missing', `${p}/sheet`, 'sheet names no material of this project', ref['sheet']);
    if (sheet['shader'] !== 'trim' || !isPlainObject(sheet['trim'])) return err(errors, 'field_value', `${p}/sheet`, 'sheet names a trim material with its own row table (not an instance)', ref['sheet']);
    const cells = Array.isArray(sheet['trim']['cells']) ? (sheet['trim']['cells'] as unknown[]) : [];
    if (!cells.some((c) => isPlainObject(c) && c['name'] === ref['cell'])) {
      const names = cells.filter(isPlainObject).map((c) => String(c['name']));
      err(errors, 'reference_missing', `${p}/cell`, `the sheet has no decal cell "${String(ref['cell'])}" (${names.join(', ') || 'it has no cells'})`, ref['cell']);
    }
  });
}

/** The material a decal component names (a project-material use: it ships). */
export function decalMaterialOf(components: unknown): string | null {
  if (!isPlainObject(components) || !isPlainObject(components['decal'])) return null;
  const m = components['decal']['material'];
  return typeof m === 'string' ? m : null;
}

/** The trim sheets the given decal materials take their cells from (they ship with them). */
export function decalSheetsOf(materials: readonly { readonly materialId: string; readonly decal?: DecalCellRef }[], used: ReadonlySet<string>): string[] {
  const out = new Set<string>();
  for (const m of materials) if (used.has(m.materialId) && m.decal !== undefined) out.add(m.decal.sheet);
  return [...out];
}
