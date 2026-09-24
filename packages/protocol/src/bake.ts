/**
 * Phase 9.6: the pieces of light baking the editor and the backend share —
 * lightmap atlas packing and the hashes that tell whether a bake is stale.
 *
 * Pure: values in, values out.
 */

/** One entity's lightmap: its size in texels (without padding). */
export interface LightmapItem {
  id: string;
  width: number;
  height: number;
}

export interface LightmapPlacement {
  id: string;
  atlas: number;
  /** Texel rectangle of the lightmap inside the atlas (without padding). */
  x: number;
  y: number;
  width: number;
  height: number;
  /** UV1 → atlas UV: `uv * [sx, sy] + [ox, oy]`. */
  scaleOffset: [number, number, number, number];
}

export interface LightmapPacking {
  atlases: { width: number; height: number }[];
  placements: LightmapPlacement[];
}

export const LIGHTMAP_MAX_ATLAS = 2048;
export const LIGHTMAP_MAX_ATLASES = 16;
export const LIGHTMAP_MIN_ITEM = 4;

/**
 * Shelf packing into square power-of-two atlases: the smallest single atlas
 * that holds everything, else as many `maxSize` atlases as needed (at most
 * 16). Items are sorted tallest first (ties by width, then id) so the result
 * only depends on the input set. `padding` texels surround every item (the
 * bakers dilate into them so bilinear filtering never reads a neighbour).
 */
export function packLightmaps(items: readonly LightmapItem[], options: { maxSize?: number; padding?: number } = {}): LightmapPacking | { error: string } {
  const maxSize = options.maxSize ?? LIGHTMAP_MAX_ATLAS;
  const pad = options.padding ?? 2;
  const inner = maxSize - 2 * pad;
  const sized = items.map((it) => ({
    id: it.id,
    w: Math.max(LIGHTMAP_MIN_ITEM, Math.min(inner, Math.round(it.width))),
    h: Math.max(LIGHTMAP_MIN_ITEM, Math.min(inner, Math.round(it.height))),
  }));
  sized.sort((a, b) => b.h - a.h || b.w - a.w || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  if (sized.length === 0) return { atlases: [], placements: [] };

  const shelf = (size: number, multi: boolean): { atlas: number; x: number; y: number }[] | null => {
    const out: { atlas: number; x: number; y: number }[] = [];
    let atlas = 0;
    let x = 0;
    let y = 0;
    let rowH = 0;
    for (const it of sized) {
      const w = it.w + 2 * pad;
      const h = it.h + 2 * pad;
      if (w > size || h > size) return null; // only at a smaller size (items are clamped to maxSize)
      if (x + w > size) {
        y += rowH;
        x = 0;
        rowH = 0;
      }
      if (y + h > size) {
        if (!multi) return null;
        atlas += 1;
        x = 0;
        y = 0;
        rowH = 0;
      }
      out.push({ atlas, x: x + pad, y: y + pad });
      x += w;
      rowH = Math.max(rowH, h);
    }
    return out;
  };

  let size = 64;
  let spots: { atlas: number; x: number; y: number }[] | null = null;
  while (size <= maxSize && spots === null) {
    spots = shelf(size, false);
    if (spots === null) size *= 2;
  }
  if (spots === null) {
    size = maxSize;
    spots = shelf(size, true)!;
  }
  const count = Math.max(...spots.map((s) => s.atlas)) + 1;
  if (count > LIGHTMAP_MAX_ATLASES) return { error: `the lightmaps need ${count} atlases of ${maxSize}²; at most ${LIGHTMAP_MAX_ATLASES} — lower the texel density` };
  const placements = sized.map((it, i) => {
    const s = spots![i]!;
    return {
      id: it.id,
      atlas: s.atlas,
      x: s.x,
      y: s.y,
      width: it.w,
      height: it.h,
      scaleOffset: [it.w / size, it.h / size, s.x / size, s.y / size] as [number, number, number, number],
    };
  });
  placements.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return { atlases: Array.from({ length: count }, () => ({ width: size, height: size })), placements };
}

// ---- stale detection ---------------------------------------------------------------

/** The parts of an entity the bake hashes read (a loose scene entity). */
export interface BakeHashEntity {
  id: string;
  parentId?: string | null;
  active?: boolean;
  static?: boolean;
  components: Record<string, unknown>;
}

/** 64-bit FNV-1a as 16 hex digits (two 32-bit lanes with different offsets). */
export function hash16(text: string): string {
  let a = 0x811c9dc5;
  let b = 0xcbf29ce4;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    a = Math.imul(a ^ c, 0x01000193) >>> 0;
    b = Math.imul(b ^ c, 0x01000193) >>> 0;
    b = (b ^ (a >>> 13)) >>> 0;
  }
  return a.toString(16).padStart(8, '0') + b.toString(16).padStart(8, '0');
}

function stable(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stable).join(',')}]`;
  if (typeof v === 'object' && v !== null) {
    return `{${Object.keys(v)
      .sort()
      .filter((k) => (v as Record<string, unknown>)[k] !== undefined)
      .map((k) => `${JSON.stringify(k)}:${stable((v as Record<string, unknown>)[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(v);
}

/** Static objects that take part in a bake: static, active, with a box or a model. */
export function isBakeStatic(e: BakeHashEntity): boolean {
  return e.static === true && e.active !== false && (e.components['box'] !== undefined || e.components['model'] !== undefined);
}

/** Lights a bake uses: mode "baked" (direct + bounce) or "mixed" (bounce only). */
export function bakeLightMode(e: BakeHashEntity): 'baked' | 'mixed' | null {
  const light = e.components['light'] as { mode?: string } | undefined;
  if (light === undefined || e.active === false) return null;
  return light.mode === 'baked' ? 'baked' : light.mode === 'mixed' ? 'mixed' : null;
}

/**
 * The hashes a bake records (and the editor compares): the static objects'
 * placement and shape, and the baked/mixed lights' values and placement.
 */
export function bakeHashes(entities: readonly BakeHashEntity[]): { staticsHash: string; lightsHash: string } {
  const byId = (a: BakeHashEntity, b: BakeHashEntity): number => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  const statics = entities.filter(isBakeStatic).sort(byId).map((e) => ({
    id: e.id,
    parentId: e.parentId ?? null,
    transform: e.components['transform'],
    box: e.components['box'],
    model: e.components['model'],
    materials: e.components['materials'],
  }));
  const lights = entities.filter((e) => bakeLightMode(e) !== null).sort(byId).map((e) => ({
    id: e.id,
    parentId: e.parentId ?? null,
    transform: e.components['transform'],
    light: e.components['light'],
  }));
  return { staticsHash: hash16(stable(statics)), lightsHash: hash16(stable(lights)) };
}
