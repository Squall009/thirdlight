/**
 * What a build's decal pages cost, as the editor's decal atlas shows them:
 * each page and every decal image's rectangle on it, the share of page area
 * no image uses, the GPU memory, and the images that set the pages' size
 * (every page of a build has the size of the largest image: one large image
 * makes every page that large), with what halving them would give.
 *
 * Read from the plan the build makes ({@link planDecalPages}, the same
 * inputs), so the numbers are the build's. Pure.
 */
import { DECAL_PAGE_LIMITS, DECAL_PAGE_SETS, planDecalPages, type DecalPageMaterial, type DecalPagePlan, type DecalPageSheet } from './decal-pages';

/** One decal image on a page: the materials drawing it, where it is, its source size. */
export interface DecalPageReportRect {
  readonly materials: readonly string[];
  /** [x, y, width, height] in page pixels. */
  readonly rect: readonly [number, number, number, number];
  readonly source: readonly [number, number];
}

export interface DecalPageReportPage {
  readonly page: number;
  readonly rects: readonly DecalPageReportRect[];
  /** The share of the page's area no rectangle covers (0–1). */
  readonly unused: number;
}

/** The images that set the pages' size, and the pages if they were half as large. */
export interface DecalPageOffender {
  /** The materials drawing them. */
  readonly materials: readonly string[];
  /** The largest of their source sizes, and that halved. */
  readonly source: readonly [number, number];
  readonly halved: readonly [number, number];
  /** The pages' side now, and with those images halved. */
  readonly size: number;
  readonly sizeHalved: number;
  readonly pagesHalved: number;
  readonly gpuBytesHalved: number;
}

export interface DecalPageReport {
  /** The pages' side (pixels) and their number. */
  readonly size: number;
  readonly pages: readonly DecalPageReportPage[];
  /** Distinct images placed, and the decal materials drawing them. */
  readonly images: number;
  readonly materials: number;
  /** The share of all pages' area no rectangle covers (0–1). */
  readonly unused: number;
  /** The channel sets with pages (one texture array each), and every page of them on the GPU. */
  readonly maps: number;
  readonly gpuBytes: number;
  /** Null: no image asks for more than the smallest page. */
  readonly offender: DecalPageOffender | null;
  readonly notes: readonly string[];
}

/**
 * The GPU bytes of `layers` pages of side `size`: block-compressed as the
 * KTX2 pages transcode (16 bytes a 4 × 4 block), every mip level.
 */
export function decalPageGpuBytes(size: number, layers: number): number {
  let bytes = 0;
  for (let s = size; s >= 1; s = Math.floor(s / 2)) {
    bytes += Math.ceil(s / 4) * Math.ceil(s / 4) * 16;
    if (s === 1) break;
  }
  return bytes * layers;
}

const planBytes = (plan: DecalPagePlan): number => DECAL_PAGE_SETS.reduce((n, s) => n + decalPageGpuBytes(plan.size, plan.sets[s].length), 0);

/** The report of the pages `planDecalPages(materials, sheets, sizeOf)` plans. */
export function decalPageReport(materials: readonly DecalPageMaterial[], sheets: ReadonlyMap<string, DecalPageSheet>, sizeOf: (textureId: string) => readonly [number, number] | null): DecalPageReport {
  const plan = planDecalPages(materials, sheets, sizeOf);
  // Materials drawing one image share its entry.
  const byEntry = new Map<object, string[]>();
  for (const [id, e] of plan.entries) {
    const l = byEntry.get(e);
    if (l === undefined) byEntry.set(e, [id]);
    else l.push(id);
  }
  const pages: { page: number; rects: DecalPageReportRect[] }[] = Array.from({ length: plan.pages }, (_, page) => ({ page, rects: [] }));
  for (const ids of byEntry.values()) {
    const entry = plan.entries.get(ids[0]!)!;
    pages[entry.page]!.rects.push({ materials: ids.sort(), rect: entry.rect, source: entry.source });
  }
  const area = plan.size * plan.size;
  const covered = (rects: readonly DecalPageReportRect[]): number => rects.reduce((n, r) => n + r.rect[2] * r.rect[3], 0);
  const out = pages.map((p) => ({ page: p.page, rects: p.rects.sort((a, b) => a.rect[1] - b.rect[1] || a.rect[0] - b.rect[0]), unused: Math.max(0, 1 - covered(p.rects) / area) }));
  const unused = plan.pages === 0 ? 0 : Math.max(0, 1 - out.reduce((n, p) => n + covered(p.rects), 0) / (area * plan.pages));

  // The images asking for the pages' side, when it is more than the smallest page.
  let offender: DecalPageOffender | null = null;
  const big = [...byEntry.values()].filter((ids) => plan.entries.get(ids[0]!)!.side >= plan.size);
  if (plan.pages > 0 && plan.size > DECAL_PAGE_LIMITS.sizeMin && big.length > 0) {
    const ids = new Set(big.flat());
    // Their textures (a sheet cell's: its sheet's) at half their size.
    const halve = new Set<string>();
    for (const m of materials) {
      if (!ids.has(m.materialId)) continue;
      for (const t of Object.values(m.textures)) halve.add(t);
      const sheet = m.decal !== undefined ? sheets.get(m.decal.sheet) : undefined;
      for (const t of Object.values(sheet?.textures ?? {})) halve.add(t);
    }
    const halfSizeOf = (id: string): readonly [number, number] | null => {
      const s = sizeOf(id);
      return s !== null && halve.has(id) ? [Math.max(1, Math.floor(s[0] / 2)), Math.max(1, Math.floor(s[1] / 2))] : s;
    };
    // A sheet's cells are scaled with their sheet.
    const halfSheets = new Map([...sheets].map(([id, sh]) => [id, sh.trim !== undefined && Object.values(sh.textures).some((t) => halve.has(t)) ? { ...sh, trim: halvedSheet(sh.trim) } : sh]));
    const half = planDecalPages(materials, halfSheets, halfSizeOf);
    const source = big.map((g) => plan.entries.get(g[0]!)!.source).reduce((a, b) => (b[0] * b[1] > a[0] * a[1] ? b : a));
    offender = {
      materials: [...ids].sort(),
      source,
      halved: [Math.max(1, Math.floor(source[0] / 2)), Math.max(1, Math.floor(source[1] / 2))],
      size: plan.size,
      sizeHalved: half.size,
      pagesHalved: half.pages,
      gpuBytesHalved: planBytes(half),
    };
  }
  return {
    size: plan.size,
    pages: out,
    images: byEntry.size,
    materials: plan.entries.size,
    unused,
    maps: DECAL_PAGE_SETS.filter((s) => plan.sets[s].length > 0).length,
    gpuBytes: planBytes(plan),
    offender,
    notes: plan.notes,
  };
}

/** A trim sheet's table at half its pixel size (its cells and rows with it). */
function halvedSheet(t: NonNullable<DecalPageSheet['trim']>): NonNullable<DecalPageSheet['trim']> {
  const h = (n: number): number => Math.floor(n / 2);
  return {
    ...t,
    size: [Math.max(1, h(t.size[0])), Math.max(1, h(t.size[1]))],
    padding: h(t.padding),
    rows: t.rows.map((r) => ({ ...r, top: h(r.top), bottom: h(r.bottom) })),
    ...(t.cells !== undefined ? { cells: t.cells.map((c) => ({ ...c, rect: [h(c.rect[0]), h(c.rect[1]), Math.max(1, h(c.rect[2])), Math.max(1, h(c.rect[3]))] as [number, number, number, number] })) } : {}),
  };
}
