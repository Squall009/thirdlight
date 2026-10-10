/**
 * Decal pages: where the images of a build's decal materials sit on the GPU.
 *
 * Every decal of a scene may be drawn by one shader (projected decals are
 * evaluated in the receiving material, a loop over the decals under a
 * pixel), so their images cannot be separate textures: they are rectangles
 * on pages, and the pages of one channel set are the layers of one texture
 * array. Three sets, so a decal changing one channel reads one texture:
 * - `albedo`: colour with opacity in alpha (sRGB);
 * - `normal`: tangent-space normals;
 * - `orm`: occlusion, roughness, metalness and an emissive mask in alpha
 *   (linear data). The emissive colour is the material's; the mask says
 *   where it glows.
 * A page is square and every page of a build has one size, the largest its
 * images need (a texture array's layers share one size).
 *
 * How images become pages:
 * - an image (a loose decal's textures, a trim sheet's) exactly the page
 *   size is a layer as it is: a trim sheet's decal cells are then
 *   rectangles on that layer, with the sheet's own gutter (the Texture
 *   Designer repeats each cell's edges), and nothing is copied;
 * - everything else is copied into composed pages, packed on shelves, each
 *   rectangle with {@link DECAL_PAGE_LIMITS}.gutter pixels around it that
 *   repeat its edge, its padded box aligned so mip texels a few levels deep
 *   stay inside it.
 * A composed page is encoded from its pixels, and an encoder takes only so
 * many ({@link DECAL_PAGE_LIMITS}.composeSizeMax); an image larger than a
 * composed page is copied at a reduced size (`notes` says which).
 *
 * Sampling. Each decal's rectangle is inset by half a texel (level 0 reads
 * only its pixels) and carries the deepest mip level whose bilinear reads
 * stay inside its padded box (`mip`): the sampler caps its footprint there,
 * as the trim material does with its rows (`trim-sheet.ts`). The pages clamp
 * at their edges, so a rectangle on a page edge is safe to every level on
 * that side.
 *
 * The page budget is the project's texture budget (`texture-streaming.ts`):
 * pages are textures that do not stream, counted with the rest. There is no
 * cap on decals or pages: a set holds as many layers as its decals need
 * (the backend splits a set into several arrays when one would pass what a
 * join takes).
 *
 * Pure: the plan says which pixels go where; the backend makes the KTX2
 * files and the build hands the runtime each decal material's place
 * ({@link DecalPageRef}).
 */
import type { Ktx2Encoding } from './content-limits';
import type { DecalCellRef } from './decals';
import type { ModelErrorV2 } from './errors';
import { bilinearReadsInside, trimCellOf, type TrimSheet } from './trim-sheet';
import { ID_RE } from './validate';

/** The channel sets, one texture array each (see the module comment). */
export const DECAL_PAGE_SETS = ['albedo', 'normal', 'orm'] as const;
export type DecalPageSet = (typeof DECAL_PAGE_SETS)[number];

/** How each set is encoded: colour (sRGB), a normal map, linear data. */
export const DECAL_PAGE_ENCODINGS: Readonly<Record<DecalPageSet, Ktx2Encoding>> = { albedo: 'color', normal: 'normal', orm: 'data' };

/**
 * - `gutter`: pixels around a copied rectangle that repeat its edge;
 * - `align`: a copied rectangle's padded box starts and ends on multiples
 *   of this, so the texels of the first levels never straddle two boxes
 *   (gutter 8 and align 16 keep levels 0–3 of any rectangle at least 16 px
 *   across inside its box, a 64 px one to level 4);
 * - `sizeMin`: the smallest page (a few small marks still share one);
 * - `composeSizeMax`: the largest page made from copied rectangles: the
 *   KTX2 encoder takes 12 Mpix an image, and 2048² is the largest
 *   power-of-two square within it.
 */
export const DECAL_PAGE_LIMITS = { gutter: 8, align: 16, sizeMin: 256, composeSizeMax: 2048 } as const;

/** One channel of a copied rectangle: a source texture's channel, the largest of its R, G and B (`max`: an emissive mask), or a constant 0–255. */
export type DecalPageChannel = { readonly texture: string; readonly channel: 0 | 1 | 2 | 3 | 'max' } | { readonly value: number };

/** A rectangle copied onto a composed page. */
export interface DecalPagePlacement {
  /** Its R, G, B and A. */
  readonly channels: readonly [DecalPageChannel, DecalPageChannel, DecalPageChannel, DecalPageChannel];
  /** The region read: [u0, v0, u1, v1] of each source image, 0–1 from its top-left corner (a source of another size is read at its own scale). */
  readonly src: readonly [number, number, number, number];
  /** Where it goes: [x, y, width, height] in page pixels. */
  readonly dst: readonly [number, number, number, number];
  /** The padded box [x0, y0, x1, y1] its edges are repeated into (the gutter). */
  readonly pad: readonly [number, number, number, number];
}

/** One layer of a set's page array: a texture as it is, or a page composed of rectangles over a fill. */
export type DecalPageLayer = { readonly whole: string } | { readonly fill: readonly [number, number, number, number]; readonly place: readonly DecalPagePlacement[] };

/** Where one decal material's image is. */
export interface DecalPageEntry {
  readonly page: number;
  /** [x, y, width, height] in page pixels. */
  readonly rect: readonly [number, number, number, number];
  /** The deepest mip level sampling may reach (see the module comment). */
  readonly mip: number;
  /** The sets it has an image in (absent sets: the material's factors alone). */
  readonly sets: readonly DecalPageSet[];
}

export interface DecalPagePlan {
  /** The side of every page (pixels). */
  readonly size: number;
  readonly pages: number;
  /** Per set, its array's layers in order: the pages that have the set. */
  readonly sets: Readonly<Record<DecalPageSet, readonly { readonly page: number; readonly layer: DecalPageLayer }[]>>;
  /** Per decal material id. */
  readonly entries: ReadonlyMap<string, DecalPageEntry>;
  /** What was done that a reader may not expect (an image copied at a reduced size). */
  readonly notes: readonly string[];
}

/** A decal material as the plan reads it (resolved: an instance carries its root's cell). */
export interface DecalPageMaterial {
  readonly materialId: string;
  readonly shader: string;
  readonly textures: Readonly<Record<string, string>>;
  readonly decal?: DecalCellRef;
}

/** A trim material as the plan reads it. */
export interface DecalPageSheet {
  readonly trim?: TrimSheet;
  readonly textures: Readonly<Record<string, string>>;
}

/** The place a build hands the runtime with a decal material (`decalPage`): the rectangle and each set's array and layer. */
export interface DecalPageRef {
  /** [u0, v0, u1, v1] on the page, 0–1 from its top-left, inset half a texel. */
  rect: [number, number, number, number];
  /** The deepest mip level sampling may reach. */
  mip: number;
  albedo?: DecalPageLayerRef;
  normal?: DecalPageLayerRef;
  orm?: DecalPageLayerRef;
}
export interface DecalPageLayerRef {
  /** The texture array (a texture asset id of the build). */
  texture: string;
  layer: number;
}

/** A layer's fill where no rectangle is: clear colour, a flat normal, unoccluded rough non-metal without glow. */
const FILL: Readonly<Record<DecalPageSet, readonly [number, number, number, number]>> = {
  albedo: [0, 0, 0, 0],
  normal: [128, 128, 255, 255],
  orm: [255, 255, 0, 0],
};

const pow2Ceil = (n: number): number => 2 ** Math.ceil(Math.log2(Math.max(1, n)));
const isSquarePow2 = (s: readonly [number, number]): boolean => s[0] === s[1] && s[0] === pow2Ceil(s[0]);
const alignUp = (n: number, a: number): number => Math.ceil(n / a) * a;

/** One image to place: a loose decal's textures or a sheet cell, shared by every material drawing the same. */
interface Item {
  readonly key: string;
  readonly materials: string[];
  /** Per set: the channels (absent: no image in that set). */
  readonly channels: Partial<Record<DecalPageSet, DecalPagePlacement['channels']>>;
  /** Its size in source pixels. */
  readonly size: [number, number];
  /** The region of its sources it reads. */
  readonly src: [number, number, number, number];
  /** A whole layer candidate: the texture each set is as it is (null: not one). */
  readonly whole: Partial<Record<DecalPageSet, string>> | null;
  /** On a whole sheet: the sheet's key (its cells share the layer). */
  readonly sheet?: { readonly key: string; readonly trim: TrimSheet; readonly rect: readonly [number, number, number, number] };
}

const whole4 = (texture: string): DecalPagePlacement['channels'] => [
  { texture, channel: 0 },
  { texture, channel: 1 },
  { texture, channel: 2 },
  { texture, channel: 3 },
];

/**
 * The deepest mip level at which bilinear reads of a rectangle, sampled
 * inside its inset edges, stay in its padded box `pad` [x0, y0, x1, y1] on
 * a clamping page of side `size`; never past the chain's last level.
 */
export function decalRectSafeMipLevel(size: number, rect: readonly [number, number, number, number], pad: readonly [number, number, number, number]): number {
  const levels = Math.floor(Math.log2(size)) + 1;
  const [x, y, w, h] = rect;
  const edges: [number, number, number][] = [
    [x + 0.5, pad[0], pad[2]],
    [x + Math.max(0.5, w - 0.5), pad[0], pad[2]],
    [y + 0.5, pad[1], pad[3]],
    [y + Math.max(0.5, h - 0.5), pad[1], pad[3]],
  ];
  let safe = 0;
  for (let l = 1; l < levels; l++) {
    if (!edges.every(([c, lo, hi]) => bilinearReadsInside(size, l, c, lo, hi, true))) break;
    safe = l;
  }
  return safe;
}

/** A cell's padded box on its sheet: its pixels, the sheet's gutter round it, never past the halfway line to a neighbour (a cell or a row). */
function cellPad(sheet: TrimSheet, rect: readonly [number, number, number, number]): [number, number, number, number] {
  const [x, y, w, h] = rect;
  const g = sheet.padding;
  let x0 = Math.max(0, x - g);
  let x1 = Math.min(sheet.size[0], x + w + g);
  let y0 = Math.max(0, y - g);
  let y1 = Math.min(sheet.size[1], y + h + g);
  const overlaps = (a0: number, a1: number, b0: number, b1: number): boolean => a0 < b1 && b0 < a1;
  for (const c of sheet.cells ?? []) {
    const [cx, cy, cw, ch] = c.rect;
    if (cx === x && cy === y && cw === w && ch === h) continue;
    if (overlaps(y - g, y + h + g, cy, cy + ch)) {
      if (cx + cw <= x) x0 = Math.max(x0, (cx + cw + x) / 2);
      else if (cx >= x + w) x1 = Math.min(x1, (x + w + cx) / 2);
    }
    if (overlaps(x - g, x + w + g, cx, cx + cw)) {
      if (cy + ch <= y) y0 = Math.max(y0, (cy + ch + y) / 2);
      else if (cy >= y + h) y1 = Math.min(y1, (y + h + cy) / 2);
    }
  }
  // Rows span the sheet and their own padding is theirs.
  for (const r of sheet.rows) {
    if (r.bottom <= y) y0 = Math.max(y0, Math.min(y, r.bottom + sheet.padding));
    else if (r.top >= y + h) y1 = Math.min(y1, Math.max(y + h, r.top - sheet.padding));
  }
  return [Math.floor(x0), Math.floor(y0), Math.ceil(x1), Math.ceil(y1)];
}

/**
 * The pages of `materials`' decal materials (others are skipped): `sheets`
 * the trim materials by id, `sizeOf` a texture's size in pixels (null:
 * unknown, it is left out). Deterministic: the same inputs give the same
 * plan.
 */
export function planDecalPages(materials: readonly DecalPageMaterial[], sheets: ReadonlyMap<string, DecalPageSheet>, sizeOf: (textureId: string) => readonly [number, number] | null): DecalPagePlan {
  const notes: string[] = [];
  const items = new Map<string, Item>();
  const add = (materialId: string, make: () => Item | null, key: string): void => {
    const known = items.get(key);
    if (known !== undefined) {
      known.materials.push(materialId);
      return;
    }
    const item = make();
    if (item !== null) items.set(key, item);
  };
  for (const m of [...materials].sort((a, b) => (a.materialId < b.materialId ? -1 : a.materialId > b.materialId ? 1 : 0))) {
    if (m.shader !== 'decal') continue;
    if (m.decal !== undefined) {
      const sheet = sheets.get(m.decal.sheet);
      const trim = sheet?.trim;
      const cell = trim !== undefined ? trimCellOf(trim, m.decal.cell) : null;
      if (sheet === undefined || trim === undefined || cell === null) continue;
      const t = sheet.textures;
      add(m.materialId, () => {
        const channels: Item['channels'] = {};
        if (t['map'] !== undefined) channels.albedo = whole4(t['map']);
        if (t['normalMap'] !== undefined) channels.normal = whole4(t['normalMap']);
        if (t['ormMap'] !== undefined) channels.orm = whole4(t['ormMap']);
        if (Object.keys(channels).length === 0) return null;
        const sizes = Object.values(channels).map((c) => sizeOf((c[0] as { texture: string }).texture));
        const fits = sizes.every((s) => s !== null && s[0] === trim.size[0] && s[1] === trim.size[1]) && isSquarePow2(trim.size);
        const [x, y, w, h] = cell.rect;
        return {
          key: `cell:${m.decal!.sheet}:${cell.name}`,
          materials: [m.materialId],
          channels,
          size: [w, h],
          src: [x / trim.size[0], y / trim.size[1], (x + w) / trim.size[0], (y + h) / trim.size[1]],
          whole: fits ? Object.fromEntries(Object.entries(channels).map(([k, c]) => [k, (c[0] as { texture: string }).texture])) : null,
          ...(fits ? { sheet: { key: `sheet:${m.decal!.sheet}`, trim, rect: cell.rect } } : {}),
        };
      }, `cell:${m.decal.sheet}:${m.decal.cell}`);
      continue;
    }
    const t = m.textures;
    const map = t['map'];
    const normal = t['normalMap'];
    const orm = t['ormMap'];
    const emissive = t['emissiveMap'];
    const key = `own:${map ?? ''}:${normal ?? ''}:${orm ?? ''}:${emissive ?? ''}`;
    add(m.materialId, () => {
      const channels: Item['channels'] = {};
      if (map !== undefined) channels.albedo = whole4(map);
      if (normal !== undefined) channels.normal = whole4(normal);
      if (orm !== undefined || emissive !== undefined) {
        const rgb = (c: 0 | 1 | 2): DecalPageChannel => (orm !== undefined ? { texture: orm, channel: c } : { value: 255 });
        channels.orm = [rgb(0), rgb(1), rgb(2), emissive !== undefined ? { texture: emissive, channel: 'max' } : { texture: orm!, channel: 3 }];
      }
      const used = [map, normal, orm, emissive].filter((x): x is string => x !== undefined);
      if (used.length === 0) return null;
      const sizes = used.map((id) => sizeOf(id));
      if (sizes.some((s) => s === null)) return null;
      const size: [number, number] = [Math.max(...sizes.map((s) => s![0])), Math.max(...sizes.map((s) => s![1]))];
      const alike = sizes.every((s) => s![0] === size[0] && s![1] === size[1]) && isSquarePow2(size);
      // The ORM set is a texture as it is only without an emissive map (else its mask is copied into alpha).
      const whole: Item['whole'] = alike ? { ...(map !== undefined ? { albedo: map } : {}), ...(normal !== undefined ? { normal } : {}), ...(orm !== undefined && emissive === undefined ? { orm } : {}) } : null;
      return { key, materials: [m.materialId], channels, size, src: [0, 0, 1, 1], whole };
    }, key);
  }

  // The page size: the largest image; smaller ones are copied. Copying needs an encodable page.
  const list = [...items.values()];
  const wholeSide = (it: Item): number => (it.sheet !== undefined ? it.sheet.trim.size[0] : it.whole !== null ? it.size[0] : 0);
  let size = Math.max(DECAL_PAGE_LIMITS.sizeMin, ...list.map((it) => pow2Ceil(Math.max(wholeSide(it), it.size[0], it.size[1]))));
  const isWhole = (it: Item, side: number): boolean => it.whole !== null && wholeSide(it) === side;
  if (size > DECAL_PAGE_LIMITS.composeSizeMax && list.some((it) => !isWhole(it, size))) size = DECAL_PAGE_LIMITS.composeSizeMax;

  // Whole layers: a sheet (all its cells) or a loose decal, one page each.
  // Composed layers fill up as rectangles land (the plan hands them out read-only).
  const pages: { layers: Partial<Record<DecalPageSet, { whole: string } | { fill: readonly [number, number, number, number]; place: DecalPagePlacement[] }>> }[] = [];
  const entries = new Map<string, DecalPageEntry>();
  const setsOf = (it: Item): DecalPageSet[] => DECAL_PAGE_SETS.filter((s) => it.channels[s] !== undefined);
  const enter = (it: Item, page: number, rect: readonly [number, number, number, number], pad: readonly [number, number, number, number]): void => {
    const entry: DecalPageEntry = { page, rect, mip: decalRectSafeMipLevel(size, rect, pad), sets: setsOf(it) };
    for (const id of it.materials) entries.set(id, entry);
  };
  const sheetPages = new Map<string, number>();
  const rest: Item[] = [];
  for (const it of list) {
    if (!isWhole(it, size)) {
      rest.push(it);
      continue;
    }
    if (it.sheet !== undefined) {
      let page = sheetPages.get(it.sheet.key);
      if (page === undefined) {
        page = pages.length;
        sheetPages.set(it.sheet.key, page);
        pages.push({ layers: Object.fromEntries(Object.entries(it.whole!).map(([s, id]) => [s, { whole: id }])) });
      }
      enter(it, page, it.sheet.rect, cellPad(it.sheet.trim, it.sheet.rect));
      continue;
    }
    const page = pages.length;
    const layers: (typeof pages)[number]['layers'] = {};
    for (const s of setsOf(it)) {
      const id = it.whole![s];
      layers[s] = id !== undefined ? { whole: id } : { fill: FILL[s], place: [{ channels: it.channels[s]!, src: it.src, dst: [0, 0, size, size], pad: [0, 0, size, size] }] };
    }
    pages.push({ layers });
    enter(it, page, [0, 0, size, size], [0, 0, size, size]);
  }

  // Copied rectangles on shelves, tallest first.
  const { gutter, align } = DECAL_PAGE_LIMITS;
  const boxes = rest.map((it) => {
    const scale = Math.min(1, size / Math.max(it.size[0], it.size[1]));
    if (scale < 1) notes.push(`${it.materials.join(', ')}: ${it.size[0]}×${it.size[1]} copied at ${Math.max(1, Math.round(it.size[0] * scale))}×${Math.max(1, Math.round(it.size[1] * scale))} onto ${size}² decal pages`);
    const w = Math.max(1, Math.round(it.size[0] * scale));
    const h = Math.max(1, Math.round(it.size[1] * scale));
    const gx = w >= size ? 0 : Math.min(gutter, Math.floor((size - w) / 2));
    const gy = h >= size ? 0 : Math.min(gutter, Math.floor((size - h) / 2));
    return { it, w, h, gx, gy, pw: Math.min(size, alignUp(w + 2 * gx, align)), ph: Math.min(size, alignUp(h + 2 * gy, align)) };
  });
  boxes.sort((a, b) => b.ph - a.ph || b.pw - a.pw || (a.it.key < b.it.key ? -1 : a.it.key > b.it.key ? 1 : 0));
  interface Shelf { y: number; h: number; x: number }
  const open: { page: number; shelves: Shelf[]; next: number }[] = [];
  for (const b of boxes) {
    let at: { page: number; x: number; y: number } | null = null;
    for (const p of open) {
      const shelf = p.shelves.find((s) => s.h >= b.ph && s.x + b.pw <= size);
      if (shelf !== undefined) {
        at = { page: p.page, x: shelf.x, y: shelf.y };
        shelf.x += b.pw;
        break;
      }
      if (p.next + b.ph <= size) {
        p.shelves.push({ y: p.next, h: b.ph, x: b.pw });
        at = { page: p.page, x: 0, y: p.next };
        p.next += b.ph;
        break;
      }
    }
    if (at === null) {
      const page = pages.length;
      pages.push({ layers: {} });
      open.push({ page, shelves: [{ y: 0, h: b.ph, x: b.pw }], next: b.ph });
      at = { page, x: 0, y: 0 };
    }
    const dst: [number, number, number, number] = [at.x + b.gx, at.y + b.gy, b.w, b.h];
    const pad: [number, number, number, number] = [at.x, at.y, at.x + b.pw, at.y + b.ph];
    const layers = pages[at.page]!.layers;
    for (const s of setsOf(b.it)) {
      const layer = (layers[s] ??= { fill: FILL[s], place: [] }) as { place: DecalPagePlacement[] };
      layer.place.push({ channels: b.it.channels[s]!, src: b.it.src, dst, pad });
    }
    enter(b.it, at.page, dst, pad);
  }

  const sets = Object.fromEntries(DECAL_PAGE_SETS.map((s) => [s, pages.flatMap((p, page) => (p.layers[s] !== undefined ? [{ page, layer: p.layers[s]! }] : []))])) as unknown as DecalPagePlan['sets'];
  return { size, pages: pages.length, sets, entries, notes };
}

/**
 * Each decal material's place as the runtime gets it: `layerOf(set, i)`
 * names the array and layer the set's i-th layer was shipped as.
 */
export function decalPageRefs(plan: DecalPagePlan, layerOf: (set: DecalPageSet, index: number) => DecalPageLayerRef): Map<string, DecalPageRef> {
  const indexOf = new Map<DecalPageSet, Map<number, number>>();
  for (const s of DECAL_PAGE_SETS) indexOf.set(s, new Map(plan.sets[s].map((l, i) => [l.page, i])));
  const out = new Map<string, DecalPageRef>();
  const n = plan.size;
  for (const [id, e] of plan.entries) {
    const [x, y, w, h] = e.rect;
    // Inset half a texel: level 0 reads the rectangle's own pixels only.
    const ref: DecalPageRef = { rect: [(x + 0.5) / n, (y + 0.5) / n, (x + Math.max(0.5, w - 0.5)) / n, (y + Math.max(0.5, h - 0.5)) / n], mip: e.mip };
    for (const s of e.sets) {
      const i = indexOf.get(s)!.get(e.page);
      if (i !== undefined) ref[s] = layerOf(s, i);
    }
    out.set(id, ref);
  }
  return out;
}

/** A `decalPage` in canonical form: fields in order, sets in {@link DECAL_PAGE_SETS} order. */
export function canonicalDecalPageRef(r: DecalPageRef): DecalPageRef {
  const out: DecalPageRef = { rect: [r.rect[0], r.rect[1], r.rect[2], r.rect[3]], mip: r.mip };
  for (const s of DECAL_PAGE_SETS) {
    const l = r[s];
    if (l !== undefined) out[s] = { texture: l.texture, layer: l.layer };
  }
  return out;
}

const isPlainObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** A runtime material's `decalPage` (a build writes it; a project never stores one). */
export function validateDecalPageRef(v: unknown, path: string, errors: ModelErrorV2[]): void {
  const fail = (p: string, message: string, found: unknown): void => void errors.push({ code: 'field_value', path: p, message, found } as ModelErrorV2);
  if (!isPlainObject(v)) return fail(path, 'decalPage is {rect, mip, albedo?, normal?, orm?}', v);
  for (const k of Object.keys(v)) if (!['rect', 'mip', ...DECAL_PAGE_SETS].includes(k)) fail(`${path}/${k}`, `unknown decalPage field "${k}"`, k);
  const r = v['rect'];
  if (!(Array.isArray(r) && r.length === 4 && r.every((x) => typeof x === 'number' && Number.isFinite(x) && x >= 0 && x <= 1))) fail(`${path}/rect`, 'rect is [u0, v0, u1, v1], each 0-1', r);
  const mip = v['mip'];
  if (!(typeof mip === 'number' && Number.isInteger(mip) && mip >= 0 && mip <= 16)) fail(`${path}/mip`, 'mip is a mip level 0-16', mip);
  for (const s of DECAL_PAGE_SETS) {
    const l = v[s];
    if (l === undefined) continue;
    if (!isPlainObject(l) || typeof l['texture'] !== 'string' || !ID_RE.test(l['texture']) || !(typeof l['layer'] === 'number' && Number.isInteger(l['layer']) && l['layer'] >= 0) || Object.keys(l).length !== 2) fail(`${path}/${s}`, `${s} is {texture, layer}: a texture array of the build and a layer of it`, l);
  }
}
