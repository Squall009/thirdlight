/**
 * The decal editor, as data: what its palette lists, which decals a filter
 * lets the pointer pick, what a selection of many shows in its fields (one
 * value, or "mixed"), the one command an edit of many is, and where a
 * scatter stroke puts its decals.
 *
 * - **Palette:** the project's decal materials (roots and instances), then
 *   every trim sheet's decal cell no decal material draws yet; a cell gets
 *   its material when it is picked. Each entry names the texture its
 *   picture comes from and, for a cell, the part of the sheet it is.
 * - **Edits of many:** one `setComponent` on the first decal with the
 *   others in `entityIds` (one revision, one undo); the value is merged into
 *   each decal's own component, so a field edited leaves the others' sizes,
 *   materials and fades as they were.
 * - **Scatter:** decals per square metre of surface, at least the spacing
 *   apart, each turned and sized by a random draw from the seed and its
 *   number in the stroke, so the same stroke with the same seed places the
 *   same decals. A dab lays its places on the plane of the surface under it;
 *   the Scene view drops each onto the surface along its normal.
 *
 * Pure: no DOM, no three.js.
 */
import type { DecalComponent, DecalOpacity, MaterialDef } from '@thirdlight/project-model';
import { SET_COMPONENT_ENTITIES_MAX } from '@thirdlight/project-model/limits';
import { DECAL_CHANNELS, DECAL_LAYERS_ALL, DECAL_LIMITS, decalEdgeFade, decalNormalFade, seededRandom } from '@thirdlight/runtime';

import { decalPlacement, type DecalToolSettings } from './decal-place';
import { jsonBytes, requestBatches } from './request-batches';

type V3 = readonly [number, number, number];

// ---- the palette -------------------------------------------------------------------------------

/** One tile of the decal palette. */
export interface DecalPaletteEntry {
  /** `material:<id>` or `cell:<sheet>:<cell>`. */
  readonly key: string;
  readonly kind: 'material' | 'cell';
  readonly name: string;
  /** The decal material placed (null: a cell that has none yet). */
  readonly material: string | null;
  /** The texture the picture comes from (its albedo, or the sheet's). */
  readonly texture: string | null;
  /** The part of that texture shown, as fractions [x, y, width, height] (a sheet's cell); absent: all of it. */
  readonly crop?: readonly [number, number, number, number];
  /** A cell's sheet and name (a material drawn from a cell has them too). */
  readonly cell?: { readonly sheet: string; readonly cell: string };
  /** The trim sheet's name its picture comes from (null: its own image): the palette groups by it, so two sheets' "panel" cells read apart. */
  readonly group: string | null;
}

/** The palette's filter: everything, decal materials only, or trim sheets' cells only (a project with many sheets buries its few decal materials among their cells). */
export type DecalPaletteFilter = 'all' | 'material' | 'cell';

/** A trim sheet's cell as a fraction of the sheet's picture (null: no such cell). */
function cellCrop(sheet: MaterialDef | undefined, cell: string): [number, number, number, number] | null {
  const t = sheet?.trim;
  const c = t?.cells?.find((x) => x.name === cell);
  if (t === undefined || c === undefined || t.size[0] <= 0 || t.size[1] <= 0) return null;
  return [c.rect[0] / t.size[0], c.rect[1] / t.size[1], c.rect[2] / t.size[0], c.rect[3] / t.size[1]];
}

/**
 * The decal palette of a project's materials, grouped by where the picture
 * comes from: the decal materials with their own image first, then each trim
 * sheet (in the project's order) with the materials drawn from its cells and
 * its cells without one.
 */
export function decalPalette(materials: readonly MaterialDef[]): DecalPaletteEntry[] {
  const byId = new Map(materials.map((m) => [m.materialId, m]));
  const root = (m: MaterialDef): MaterialDef => (m.instanceOf !== undefined ? (byId.get(m.instanceOf) ?? m) : m);
  const decals = materials.filter((m) => m.shader === 'decal');
  const out: DecalPaletteEntry[] = [];
  for (const m of decals) {
    const r = root(m);
    const ref = r.decal;
    const sheet = ref === undefined ? undefined : byId.get(ref.sheet);
    const crop = ref === undefined ? null : cellCrop(sheet, ref.cell);
    out.push({
      key: `material:${m.materialId}`,
      kind: 'material',
      name: m.name,
      material: m.materialId,
      texture: ref !== undefined ? (sheet?.textures['map'] ?? null) : (r.textures['map'] ?? null),
      ...(crop !== null ? { crop } : {}),
      ...(ref !== undefined ? { cell: { sheet: ref.sheet, cell: ref.cell } } : {}),
      group: ref !== undefined ? (sheet?.name ?? ref.sheet) : null,
    });
  }
  for (const sheet of materials) {
    if (sheet.shader !== 'trim' || sheet.instanceOf !== undefined) continue;
    for (const c of sheet.trim?.cells ?? []) {
      if (decals.some((d) => d.instanceOf === undefined && d.decal?.sheet === sheet.materialId && d.decal.cell === c.name)) continue;
      const crop = cellCrop(sheet, c.name);
      out.push({ key: `cell:${sheet.materialId}:${c.name}`, kind: 'cell', name: c.name, material: null, texture: sheet.textures['map'] ?? null, ...(crop !== null ? { crop } : {}), cell: { sheet: sheet.materialId, cell: c.name }, group: sheet.name });
    }
  }
  // Own images first, then a sheet's entries together, each group in the order found (a stable sort).
  const sheetOrder = new Map(materials.map((m, i) => [m.materialId, i]));
  const rank = (e: DecalPaletteEntry): number => (e.cell === undefined ? -1 : (sheetOrder.get(e.cell.sheet) ?? materials.length));
  return out.map((e, i) => ({ e, i })).sort((a, b) => rank(a.e) - rank(b.e) || a.i - b.i).map((x) => x.e);
}

/** The entries a palette filter shows (a material drawn from a cell counts as a material). */
export function filterPalette(entries: readonly DecalPaletteEntry[], f: DecalPaletteFilter): DecalPaletteEntry[] {
  return f === 'all' ? [...entries] : entries.filter((e) => e.kind === f);
}

// ---- picking filters ---------------------------------------------------------------------------

/** Which decals the pointer can pick: by material and by decal layer (null: any). */
export interface DecalFilter {
  readonly material: string | null;
  /** A layer index 0–7 (the layer the decal marks). */
  readonly layer: number | null;
}

export const NO_DECAL_FILTER: DecalFilter = Object.freeze({ material: null, layer: null });

/** Whether a decal passes the filter. */
export function decalMatches(d: Pick<DecalComponent, 'material' | 'layers'>, f: DecalFilter): boolean {
  if (f.material !== null && d.material !== f.material) return false;
  if (f.layer !== null && ((d.layers ?? DECAL_LAYERS_ALL) & (1 << f.layer)) === 0) return false;
  return true;
}

// ---- a selection of many -----------------------------------------------------------------------

/** One field's value across a selection: the same on all, or mixed (null). */
export type Shared<T> = T | null;

/** What a selection's fields show. */
export interface DecalSelectionFields {
  readonly count: number;
  readonly material: Shared<string>;
  readonly mode: Shared<'projected' | 'clipped'>;
  readonly width: Shared<number>;
  readonly height: Shared<number>;
  readonly depth: Shared<number>;
  /** Each channel's opacity (absent field: 1). */
  readonly opacity: Readonly<Record<(typeof DECAL_CHANNELS)[number], Shared<number>>>;
  /** Degrees (absent: the default). */
  readonly normalFade: Shared<number>;
  /** Metres where it has faded out (0: never). */
  readonly fadeDistance: Shared<number>;
  readonly edgeFront: Shared<number>;
  readonly edgeBack: Shared<number>;
  readonly sortOrder: Shared<number>;
}

function shared<T>(values: readonly T[]): Shared<T> {
  if (values.length === 0) return null;
  const first = values[0] as T;
  return values.every((v) => v === first) ? first : null;
}

/** The fields of a selection of decals (empty: none selected). */
export function selectionFields(decals: readonly DecalComponent[]): DecalSelectionFields {
  const ch = {} as Record<(typeof DECAL_CHANNELS)[number], Shared<number>>;
  for (const c of DECAL_CHANNELS) ch[c] = shared(decals.map((d) => d.opacity?.[c] ?? 1));
  const edges = decals.map((d) => decalEdgeFade(d.edgeFade));
  return {
    count: decals.length,
    material: shared(decals.map((d) => d.material)),
    mode: shared(decals.map((d) => d.mode ?? 'projected')),
    width: shared(decals.map((d) => d.size[0])),
    height: shared(decals.map((d) => d.size[1])),
    depth: shared(decals.map((d) => d.size[2])),
    opacity: ch,
    normalFade: shared(decals.map((d) => decalNormalFade(d.normalFade).degrees)),
    fadeDistance: shared(decals.map((d) => d.fadeDistance ?? 0)),
    edgeFront: shared(edges.map((e) => e[0])),
    edgeBack: shared(edges.map((e) => e[1])),
    sortOrder: shared(decals.map((d) => d.sortOrder ?? 0)),
  };
}

/** A field of the selection the editor edits. */
export type DecalFieldEdit =
  | { readonly field: 'size'; readonly axis: 0 | 1 | 2; readonly value: number }
  | { readonly field: 'mode'; readonly value: 'projected' | 'clipped' }
  | { readonly field: 'material'; readonly value: string }
  | { readonly field: 'opacity'; readonly channel: (typeof DECAL_CHANNELS)[number]; readonly value: number }
  | { readonly field: 'normalFade' | 'fadeDistance' | 'sortOrder'; readonly value: number }
  | { readonly field: 'edgeFade'; readonly end: 0 | 1; readonly value: number };

/** The `setComponent` arguments of an edit of several decals. */
export type DecalEditArgs = { entityId: string; component: 'decal'; value: Record<string, unknown>; entityIds?: string[]; values?: Record<string, unknown>[] };

/** What `setComponent` holds besides its decals' ids and values (the arguments with empty lists). */
const EDIT_FIXED_BYTES = jsonBytes({ entityId: '', component: 'decal', value: {}, entityIds: [], values: [] });

/**
 * The `setComponent` commands an edit of the selection is: one for all of
 * it when it fits a request (one revision, one undo), else as many as the
 * request's count and bytes take. Each has its first decal's new value, the
 * others in `entityIds`, each with its own value in `values` when they
 * differ (a width set on decals of different heights keeps each one's
 * height). None: nothing selected.
 */
export function selectionEdit(entries: readonly { id: string; decal: DecalComponent }[], edit: DecalFieldEdit): DecalEditArgs[] {
  const pairs = entries.map((e) => ({ id: e.id, value: fieldValue(e.decal, edit) }));
  // An id and its value each take a list place (and a separator) in the request.
  const batches = requestBatches(pairs, SET_COMPONENT_ENTITIES_MAX + 1, EDIT_FIXED_BYTES, (p) => jsonBytes(p.id) + 1 + jsonBytes(p.value));
  return batches.map(editArgs);
}

function editArgs(pairs: readonly { id: string; value: Record<string, unknown> }[]): DecalEditArgs {
  const [first, ...rest] = pairs as [{ id: string; value: Record<string, unknown> }, ...{ id: string; value: Record<string, unknown> }[]];
  if (rest.length === 0) return { entityId: first.id, component: 'decal', value: first.value };
  const values = rest.map((p) => p.value);
  const same = values.every((v) => JSON.stringify(v) === JSON.stringify(first.value));
  return { entityId: first.id, component: 'decal', value: first.value, entityIds: rest.map((p) => p.id), ...(same ? {} : { values }) };
}

const mm = (v: number): number => Math.round(v * 1000) / 1000;

function fieldValue(d: DecalComponent, e: DecalFieldEdit): Record<string, unknown> {
  switch (e.field) {
    case 'size': {
      const size = [d.size[0], d.size[1], d.size[2]];
      size[e.axis] = Math.min(DECAL_LIMITS.sizeMax, Math.max(0.001, mm(e.value)));
      return { size };
    }
    case 'mode':
      return { mode: e.value };
    case 'material':
      return { material: e.value };
    case 'opacity': {
      const o: DecalOpacity = { ...(d.opacity ?? {}) };
      // An opacity of 1 is the default: left out, so a decal set back to full stores what it did before.
      if (e.value >= 1) delete o[e.channel];
      else o[e.channel] = Math.max(0, Math.round(e.value * 100) / 100);
      return { opacity: Object.keys(o).length === 0 ? null : o };
    }
    case 'edgeFade': {
      const f = decalEdgeFade(d.edgeFade);
      f[e.end] = Math.min(1, Math.max(0, Math.round(e.value * 100) / 100));
      return { edgeFade: f };
    }
    case 'fadeDistance':
      return { fadeDistance: e.value <= 0 ? null : Math.min(DECAL_LIMITS.fadeDistanceMax, mm(e.value)) };
    case 'normalFade':
      return { normalFade: Math.min(DECAL_LIMITS.normalFadeMax, Math.max(DECAL_LIMITS.normalFadeMin, Math.round(e.value))) };
    case 'sortOrder':
      return { sortOrder: Math.min(DECAL_LIMITS.sortOrderMax, Math.max(DECAL_LIMITS.sortOrderMin, Math.round(e.value))) };
  }
}

// ---- scatter -----------------------------------------------------------------------------------

/** A scatter stroke's own settings (the footprint is the shared brush's size). */
export interface DecalScatterSettings {
  /** Decals per square metre of surface. */
  density: number;
  /** Each decal turns by a random angle up to ± this many degrees. */
  turn: number;
  /** Each decal is sized by a random factor in [scaleMin, scaleMax]. */
  scaleMin: number;
  scaleMax: number;
  seed: number;
}

/**
 * The scatter's bounds: a density from one decal per 100 m² (leaves over a
 * square) to 20 per m² (gravel, a crowd of footprints), sizes a stamp's.
 */
export const DECAL_SCATTER_LIMITS = Object.freeze({ density: [0.01, 20] as const, scale: [0.05, 10] as const });

export const DECAL_SCATTER_DEFAULTS: DecalScatterSettings = Object.freeze({ density: 1, turn: 180, scaleMin: 0.75, scaleMax: 1.25, seed: 1 }) as DecalScatterSettings;

/** Settings read from anywhere (storage): each within bounds, anything malformed its default. */
export function sanitizeScatter(raw: unknown): DecalScatterSettings {
  const r = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {};
  const n = (k: string, lo: number, hi: number, d: number): number => (typeof r[k] === 'number' && Number.isFinite(r[k]) ? Math.min(hi, Math.max(lo, r[k] as number)) : d);
  const D = DECAL_SCATTER_DEFAULTS;
  const L = DECAL_SCATTER_LIMITS;
  const scaleMin = n('scaleMin', L.scale[0], L.scale[1], D.scaleMin);
  return {
    density: n('density', L.density[0], L.density[1], D.density),
    turn: n('turn', 0, 180, D.turn),
    scaleMin,
    scaleMax: Math.max(scaleMin, n('scaleMax', L.scale[0], L.scale[1], D.scaleMax)),
    seed: typeof r['seed'] === 'number' && Number.isInteger(r['seed']) && r['seed'] >= 0 && r['seed'] <= 0xffffffff ? r['seed'] : D.seed,
  };
}

/** The least distance between two decals of a stroke: half the even spacing the density makes, so they may cluster but never stack. */
export const scatterSpacing = (s: Pick<DecalScatterSettings, 'density'>): number => 0.5 / Math.sqrt(s.density);

/** One place a stroke puts a decal: on the dab's plane (world), with the plane's normal. */
export interface ScatterPlace {
  readonly point: V3;
  readonly normal: V3;
  /** Its number in the stroke (the seed's draw for its turn and size). */
  readonly index: number;
}

const sub = (a: V3, b: V3): [number, number, number] => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a: V3, b: V3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: V3, b: V3): [number, number, number] => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const unit = (v: V3): [number, number, number] => {
  const l = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / l, v[1] / l, v[2] / l];
};

/**
 * A scatter stroke's places, dab by dab: each dab adds decals for the
 * surface it newly covers (a disc of the brush's radius, less what earlier
 * dabs covered), at random points of the disc kept at least the spacing
 * from every earlier place. Seeded by the settings' seed and the dab's
 * number, so a stroke drawn again lays the same places.
 */
export class ScatterStroke {
  readonly places: ScatterPlace[] = [];
  private dabs: { centre: V3; radius: number }[] = [];
  private readonly spacing: number;

  constructor(private readonly s: DecalScatterSettings) {
    this.spacing = scatterSpacing(s);
  }

  /** A dab at `centre` on a surface facing `normal`, of `radius` metres: the places it adds. */
  dab(centre: V3, normal: V3, radius: number): ScatterPlace[] {
    const n = unit(normal);
    // The plane's axes: any two perpendicular to the normal.
    const ref: V3 = Math.abs(n[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
    const u = unit(cross(ref, n));
    const v = cross(n, u);
    const area = Math.PI * radius * radius;
    const want = this.s.density * area;
    const rnd = seededRandom((this.s.seed ^ Math.imul(this.dabs.length + 1, 0x85ebca6b)) >>> 0);
    // The whole count is drawn; the fraction left over is drawn as a chance (a sparse scatter still lays some).
    const tries = Math.floor(want) + (rnd() < want - Math.floor(want) ? 1 : 0);
    const added: ScatterPlace[] = [];
    const earlier = this.dabs;
    for (let i = 0; i < tries; i++) {
      const a = rnd() * Math.PI * 2;
      const r = radius * Math.sqrt(rnd());
      const p: [number, number, number] = [centre[0] + (u[0] * Math.cos(a) + v[0] * Math.sin(a)) * r, centre[1] + (u[1] * Math.cos(a) + v[1] * Math.sin(a)) * r, centre[2] + (u[2] * Math.cos(a) + v[2] * Math.sin(a)) * r];
      // Ground an earlier dab covered got its decals then.
      if (earlier.some((d) => dist(p, d.centre) < d.radius)) continue;
      if (this.places.some((q) => dist(p, q.point) < this.spacing) || added.some((q) => dist(p, q.point) < this.spacing)) continue;
      added.push({ point: [mm(p[0]), mm(p[1]), mm(p[2])], normal: n, index: this.places.length + added.length });
    }
    this.dabs.push({ centre: [...centre] as [number, number, number], radius });
    this.places.push(...added);
    return added;
  }
}

const dist = (a: V3, b: V3): number => {
  const d = sub(a, b);
  return Math.sqrt(dot(d, d));
};

/** The decal a scatter place becomes: placed as a click would, turned and sized by its draw (the stamp's maths with the scatter's jitter). */
export function scatterPlacement(tool: DecalToolSettings, s: DecalScatterSettings, material: string, at: V3, normal: V3, index: number): ReturnType<typeof decalPlacement> {
  return decalPlacement({ ...tool, stamp: { turn: s.turn, scaleMin: s.scaleMin, scaleMax: s.scaleMax, seed: s.seed } }, material, at, normal, index);
}
