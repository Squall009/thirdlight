/**
 * The surface cache: the light of every static surface, kept in an atlas of
 * pages (a dynamic lightmap) and terrain rings. This module decides what is
 * resident: the tiles around the view (block chunk columns, architecture
 * objects, placed model pieces), each at a resolution level falling with its
 * distance, within the memory budget of the quality level. Tiles come and go
 * with the scene's own streaming (only loaded tiles are offered), the ones
 * the budget has no room for are let go farthest first, and a tile changing
 * level is packed again.
 *
 * The budget is bytes, never a count of surfaces or lights: terrain rings
 * take at most `TERRAIN_RING_SHARE` of it, pages the rest.
 *
 * A texel's light is not computed here (that is the lighting passes'
 * work); `takeChanges` names what became resident or moved, so they know
 * what needs light.
 *
 * Pure (no three.js, no device).
 */
import { textDigest } from '@thirdlight/runtime';

import { SURFACE_CHART_BORDER, SURFACE_LEVELS, SURFACE_PAGE_BYTES, SURFACE_TEXEL_BYTES, PageAtlas, areaTexels, packTile, type AtlasBlock, type SurfaceChart, type TilePacking } from './surface-cache-atlas';
import { TERRAIN_RING_BYTES, TerrainRings, terrainRingsNeeded, type RingTexel, type TerrainRingSource } from './surface-cache-terrain';

/**
 * A tile as a saved bake holds it: what its charts were (`digest`), the
 * level it was lit at and its blocks of the saved pages.
 */
export interface SavedSurfaceTile {
  readonly digest: string;
  readonly level: number;
  readonly blocks: readonly AtlasBlock[];
}

/** At most this share of the budget goes to terrain rings. */
export const TERRAIN_RING_SHARE = 0.25;
/** Level 0 (10 cm texels) reaches this far (m); each level after doubles the distance, as the texels double. */
export const SURFACE_LEVEL_METRES = 12;
/** A resident tile keeps its level until its distance is this share past the level's edge, so a still eye does not flip levels. */
export const SURFACE_LEVEL_HYSTERESIS = 0.1;
/** How far (m) the eye moves before residency is decided again (sooner when the tiles changed). */
export const SURFACE_RECHECK_METRES = 1;

/** One streaming unit of the cache: a block chunk column, an architecture object, a placed model piece. */
export interface SurfaceTile {
  readonly key: string;
  /** World box. */
  readonly min: readonly number[];
  readonly max: readonly number[];
  /** Changes when its charts do (an edit): a resident tile is packed again. */
  readonly version: number;
  /** Its charts (asked only when the tile is a candidate; may be costly). */
  charts(): readonly SurfaceChart[];
}

/** A texel of the cache: on a page, or in a terrain's ring. */
export type SurfaceTexel = { readonly page: number; readonly x: number; readonly y: number; readonly level: number } | { readonly terrain: string; readonly ring: number; readonly x: number; readonly y: number };

/** A point within a chart: metres along an area chart, or a surfel's index. */
export type ChartPoint = { readonly u: number; readonly v: number } | { readonly index: number };

export interface SurfaceCacheDiagnostics {
  readonly budgetBytes: number;
  /** Bytes held: blocks handed out on the pages, and the rings. */
  readonly usedBytes: number;
  readonly peakUsedBytes: number;
  readonly pageBytes: number;
  readonly pages: number;
  readonly ringBytes: number;
  readonly rings: Readonly<Record<string, number>>;
  readonly tiles: { readonly offered: number; readonly resident: number; readonly beyond: number };
  /** Resident tiles per level (index: level). */
  readonly levels: readonly number[];
  readonly charts: number;
  /** Totals since the start. */
  readonly evicted: number;
  readonly allocated: number;
  readonly relevelled: number;
  /** The last decision's time (ms). */
  readonly ms: number;
}

interface Resident {
  min: readonly number[];
  max: readonly number[];
  version: number;
  level: number;
  packing: TilePacking;
  charts: readonly SurfaceChart[];
  blocks: AtlasBlock[];
}

function boxDistance(t: SurfaceTile, p: readonly number[]): number {
  let s = 0;
  for (let a = 0; a < 3; a += 1) {
    const d = Math.max(t.min[a]! - p[a]!, 0, p[a]! - t.max[a]!);
    s += d * d;
  }
  return Math.sqrt(s);
}

/** The level for distance `d` (m), level 0 reaching `metres` (the lighting tier's reach × `SURFACE_LEVEL_METRES`). */
export function surfaceLevelFor(d: number, metres = SURFACE_LEVEL_METRES): number {
  if (d <= metres) return 0;
  return Math.min(SURFACE_LEVELS - 1, Math.ceil(Math.log2(d / metres) - 1e-9));
}

export class SurfaceCache {
  private atlas: PageAtlas;
  private readonly resident = new Map<string, Resident>();
  private readonly packs = new Map<string, { version: number; charts: readonly SurfaceChart[]; byLevel: (TilePacking | undefined)[] }>();
  private readonly rings = new Map<string, TerrainRings>();
  private at: number[] | null = null;
  private allocated: string[] = [];
  private freed: string[] = [];
  private ringMoves: { terrain: string; rings: number[] }[] = [];
  private stats = { offered: 0, beyond: 0, evicted: 0, allocated: 0, relevelled: 0, ms: 0, peak: 0 };
  /** A bake's run: every tile at this level whatever its distance, coarser only where the budget has no room (null: by distance). */
  private bakeLevel: number | null = null;
  /** A saved bake drawn (no live light): the tiles it holds stand where it put them, nothing else is resident (null: live residency). */
  private saved: ReadonlyMap<string, SavedSurfaceTile> | null = null;
  private savedPages = 0;
  /** How far level 0 reaches (m): the lighting tier's reach × `SURFACE_LEVEL_METRES`. */
  private levelMetres = SURFACE_LEVEL_METRES;
  private rays = 1;

  constructor(private budget: number) {
    this.atlas = new PageAtlas(0);
  }

  /** The budget changed (the quality level): everything is decided again, from empty. */
  setBudget(bytes: number): void {
    if (bytes === this.budget) return;
    this.budget = bytes;
    for (const key of [...this.resident.keys()]) this.evict(key);
    this.atlas = new PageAtlas(0);
    this.rings.clear();
    this.at = null;
  }

  get budgetBytes(): number {
    return this.budget;
  }

  /** The lighting tier's multiple of every light's rays a texel casts (1: the engine's counts). */
  get rayScale(): number {
    return this.rays;
  }

  /**
   * The lighting tier's detail: its multiple of the rays a texel casts, and
   * of how far each level reaches (every tile takes its level again on the
   * next update).
   */
  setDetail(rays: number, reach: number): void {
    this.rays = rays;
    const metres = SURFACE_LEVEL_METRES * reach;
    if (metres === this.levelMetres) return;
    this.levelMetres = metres;
    this.at = null;
  }

  /** A bake's run (`level`: every tile at it; null: back to levels by distance). Everything is decided again on the next update. */
  setBakeLevel(level: number | null): void {
    if (level === this.bakeLevel) return;
    this.bakeLevel = level;
    for (const key of [...this.resident.keys()]) this.evict(key);
    this.at = null;
  }

  /**
   * Draw a saved bake (`tiles` by key, on `pages` pages; null: live
   * residency again). A tile is resident where the bake put it while its
   * charts are the ones it was lit with; terrain rings are not saved.
   */
  setSaved(tiles: ReadonlyMap<string, SavedSurfaceTile> | null, pages = 0): void {
    for (const key of [...this.resident.keys()]) this.evict(key);
    this.saved = tiles;
    this.savedPages = pages;
    this.atlas = new PageAtlas(0);
    this.rings.clear();
    this.at = null;
  }

  /** The atlas's pages: the budget's, or the saved bake's. */
  get pageCount(): number {
    return this.saved !== null ? this.savedPages : this.atlas.pages;
  }

  /** Whether a saved bake is drawn. */
  get drawsSaved(): boolean {
    return this.saved !== null;
  }

  /** The finest level at which every one of `tiles` fits `bytes` of pages (null: none fits even at the coarsest). */
  fitLevel(tiles: readonly SurfaceTile[], bytes: number): number | null {
    for (let l = 0; l < SURFACE_LEVELS; l += 1) {
      let sum = 0;
      for (const t of tiles) sum += this.packingOf(t, l).packing.bytes;
      if (sum <= bytes) return l;
    }
    return null;
  }

  /** A tile's charts and box as one digest: a saved tile is drawn only on the charts it was lit with. */
  digestOf(t: SurfaceTile): string {
    const { charts } = this.packingOf(t, 0);
    return textDigest(JSON.stringify([charts, t.min.map((v) => Math.round(v * 1000)), t.max.map((v) => Math.round(v * 1000))]));
  }

  private packingOf(t: SurfaceTile, level: number): { packing: TilePacking; charts: readonly SurfaceChart[] } {
    let p = this.packs.get(t.key);
    if (p === undefined || p.version !== t.version) this.packs.set(t.key, (p = { version: t.version, charts: t.charts(), byLevel: [] }));
    return { packing: (p.byLevel[level] ??= packTile(p.charts, level)), charts: p.charts };
  }

  private evict(key: string): void {
    const r = this.resident.get(key);
    if (r === undefined) return;
    if (this.saved === null) for (const b of r.blocks) this.atlas.release(b);
    this.resident.delete(key);
    this.freed.push(key);
  }

  /**
   * Decides what is resident around `eye`: the offered tiles (the loaded
   * ones) and terrains. Runs when the eye moved `SURFACE_RECHECK_METRES` or
   * `changed` says the offered tiles changed.
   */
  update(eye: readonly number[], tiles: readonly SurfaceTile[], terrains: readonly TerrainRingSource[], changed: boolean): void {
    const moved = this.at === null || Math.hypot(eye[0]! - this.at[0]!, eye[1]! - this.at[1]!, eye[2]! - this.at[2]!) >= SURFACE_RECHECK_METRES;
    for (const [key, r] of this.rings) {
      const steps = r.update(eye);
      if (steps.length > 0) this.ringMoves.push({ terrain: key, rings: steps });
    }
    if (!moved && !changed) return;
    const t0 = performance.now();
    this.at = [eye[0]!, eye[1]!, eye[2]!];
    if (this.saved !== null) {
      this.placeSaved(tiles);
      this.stats.ms = performance.now() - t0;
      return;
    }
    this.placeRings(terrains, eye);
    const ringBytes = this.ringBytes();
    const pages = Math.max(0, Math.floor((this.budget - ringBytes) / SURFACE_PAGE_BYTES));
    if (pages !== this.atlas.pages) {
      // The page count only changes with the rings' share; pack everything again.
      for (const key of [...this.resident.keys()]) this.evict(key);
      this.atlas = new PageAtlas(pages);
    }
    const order = tiles.map((t, i) => ({ t, i, d: boxDistance(t, eye) }));
    order.sort((a, b) => a.d - b.d || a.i - b.i);
    const offered = new Set(tiles.map((t) => t.key));
    for (const key of [...this.resident.keys()]) if (!offered.has(key)) {
      this.evict(key);
      this.stats.evicted += 1;
    }
    for (const key of [...this.packs.keys()]) if (!offered.has(key)) this.packs.delete(key);
    // Nearest first at the level its distance asks, else coarser, while the pages last.
    const capacity = pages * SURFACE_PAGE_BYTES;
    let used = 0;
    const want = new Map<string, number>();
    let beyond = 0;
    for (let n = 0; n < order.length; n += 1) {
      const { t, d } = order[n]!;
      const r = this.resident.get(t.key);
      let level = this.bakeLevel ?? surfaceLevelFor(d, this.levelMetres);
      if (r !== undefined && r.version === t.version && this.bakeLevel === null) {
        const near = surfaceLevelFor(d * (1 - SURFACE_LEVEL_HYSTERESIS), this.levelMetres);
        const far = surfaceLevelFor(d * (1 + SURFACE_LEVEL_HYSTERESIS), this.levelMetres);
        if (r.level >= near && r.level <= far) level = r.level;
      }
      let got = -1;
      for (let l = level; l < SURFACE_LEVELS; l += 1) {
        const bytes = this.packingOf(t, l).packing.bytes;
        if (used + bytes <= capacity) {
          used += bytes;
          got = l;
          break;
        }
      }
      if (got < 0) {
        beyond = order.length - n;
        break;
      }
      want.set(t.key, got);
    }
    // Let go of what is not wanted, or wanted at another level or version, before taking new blocks.
    const byKey = new Map(tiles.map((t) => [t.key, t]));
    for (const [key, r] of [...this.resident]) {
      const l = want.get(key);
      if (l === undefined) {
        this.evict(key);
        this.stats.evicted += 1;
      } else if (l !== r.level || r.version !== byKey.get(key)!.version) {
        this.evict(key);
        this.stats.relevelled += 1;
      }
    }
    for (const { t } of order) {
      const l = want.get(t.key);
      if (l === undefined || this.resident.has(t.key)) continue;
      if (!this.take(t, l)) beyond += 1;
    }
    this.stats.offered = tiles.length;
    this.stats.beyond = beyond;
    this.stats.ms = performance.now() - t0;
    this.stats.peak = Math.max(this.stats.peak, this.usedBytes());
  }

  /** The offered tiles a saved bake holds, on its blocks (a tile whose charts changed since is not drawn from it). */
  private placeSaved(tiles: readonly SurfaceTile[]): void {
    const saved = this.saved!;
    const offered = new Set<string>();
    for (const t of tiles) {
      const s = saved.get(t.key);
      const r = this.resident.get(t.key);
      if (s === undefined) continue;
      if (r !== undefined && r.version === t.version) {
        offered.add(t.key);
        continue;
      }
      if (r !== undefined) this.evict(t.key);
      const { packing, charts } = this.packingOf(t, s.level);
      if (packing.blocks.length !== s.blocks.length || packing.blocks.some((side, i) => side !== s.blocks[i]!.side || s.blocks[i]!.page >= this.savedPages) || this.digestOf(t) !== s.digest) continue;
      this.resident.set(t.key, { min: t.min, max: t.max, version: t.version, level: s.level, packing, charts, blocks: [...s.blocks] });
      this.allocated.push(t.key);
      offered.add(t.key);
    }
    for (const key of [...this.resident.keys()]) if (!offered.has(key)) this.evict(key);
    this.stats.offered = tiles.length;
    this.stats.beyond = 0;
  }

  /** Blocks for `t` at `level`, else at a coarser one (false: none fit, the pages are too cut up). */
  private take(t: SurfaceTile, level: number): boolean {
    for (let l = level; l < SURFACE_LEVELS; l += 1) {
      const { packing, charts } = this.packingOf(t, l);
      const blocks: AtlasBlock[] = [];
      let ok = true;
      for (const side of packing.blocks) {
        const b = this.atlas.alloc(side);
        if (b === null) {
          ok = false;
          break;
        }
        blocks.push(b);
      }
      if (ok) {
        this.resident.set(t.key, { min: t.min, max: t.max, version: t.version, level: l, packing, charts, blocks });
        this.allocated.push(t.key);
        this.stats.allocated += 1;
        return true;
      }
      for (const b of blocks) this.atlas.release(b);
    }
    return false;
  }

  private placeRings(terrains: readonly TerrainRingSource[], eye: readonly number[]): void {
    const keys = new Set(terrains.map((t) => t.key));
    for (const key of [...this.rings.keys()]) if (!keys.has(key)) this.rings.delete(key);
    // Rings in turn, finest first across terrains, within their share of the budget.
    const share = Math.floor((this.budget * TERRAIN_RING_SHARE) / TERRAIN_RING_BYTES);
    const need = terrains.map(terrainRingsNeeded);
    const give = terrains.map(() => 0);
    let left = share;
    for (let k = 0; left > 0; k += 1) {
      let any = false;
      terrains.forEach((_, i) => {
        if (left > 0 && need[i]! > k) {
          give[i]! += 1;
          left -= 1;
          any = true;
        }
      });
      if (!any) break;
    }
    terrains.forEach((src, i) => {
      let r = this.rings.get(src.key);
      if (r === undefined) this.rings.set(src.key, (r = new TerrainRings(src, give[i]!)));
      else r.rings = give[i]!;
      const steps = r.update(eye);
      if (steps.length > 0) this.ringMoves.push({ terrain: src.key, rings: steps });
    });
  }

  private ringBytes(): number {
    let s = 0;
    for (const r of this.rings.values()) s += r.bytes;
    return s;
  }

  usedBytes(): number {
    if (this.saved !== null) {
      let texels = 0;
      for (const r of this.resident.values()) for (const b of r.blocks) texels += b.side * b.side;
      return texels * SURFACE_TEXEL_BYTES;
    }
    return this.atlas.usedTexels * SURFACE_TEXEL_BYTES + this.ringBytes();
  }

  /** A resident tile's level (null: not resident). */
  levelOf(key: string): number | null {
    return this.resident.get(key)?.level ?? null;
  }

  /** A resident tile's world box and the texels its charts hold (null: not resident). */
  residentUnit(key: string): { min: readonly number[]; max: readonly number[]; texels: number } | null {
    const r = this.resident.get(key);
    if (r === undefined) return null;
    let texels = 0;
    for (const p of r.packing.places) texels += p.w * p.h;
    return { min: r.min, max: r.max, texels };
  }

  /** A resident tile's level, blocks, packing and charts (null: not resident). */
  residentOf(key: string): { level: number; blocks: readonly AtlasBlock[]; packing: TilePacking; charts: readonly SurfaceChart[] } | null {
    return this.resident.get(key) ?? null;
  }

  /** A terrain's rings (null: none). */
  ringsOf(key: string): TerrainRings | null {
    return this.rings.get(key) ?? null;
  }

  /** The terrains holding rings. */
  ringTerrains(): string[] {
    return [...this.rings.keys()];
  }

  /** The texel of a point in chart `chart` of tile `key` (null: the tile is not resident). */
  texelOf(key: string, chart: number, point: ChartPoint): SurfaceTexel | null {
    const r = this.resident.get(key);
    if (r === undefined) return null;
    const place = r.packing.places[chart];
    const c = r.charts[chart];
    if (place === undefined || c === undefined) return null;
    const b = r.blocks[place.block]!;
    if ('index' in point) {
      if (c.kind !== 'surfels' || point.index < 0 || point.index >= place.w * place.h) return null;
      return { page: b.page, x: b.x + place.x + (point.index % place.w), y: b.y + place.y + Math.floor(point.index / place.w), level: r.level };
    }
    if (c.kind !== 'area') return null;
    const iw = areaTexels(c.w, r.level);
    const ih = areaTexels(c.h, r.level);
    const tx = Math.min(iw - 1, Math.max(0, Math.floor((point.u / c.w) * iw)));
    const ty = Math.min(ih - 1, Math.max(0, Math.floor((point.v / c.h) * ih)));
    return { page: b.page, x: b.x + place.x + SURFACE_CHART_BORDER + tx, y: b.y + place.y + SURFACE_CHART_BORDER + ty, level: r.level };
  }

  /** The texel of world point (x, z) of terrain `key` (null: beyond its rings). */
  ringTexelOf(key: string, x: number, z: number): (RingTexel & { terrain: string }) | null {
    const t = this.rings.get(key)?.texelOf(x, z) ?? null;
    return t === null ? null : { terrain: key, ...t };
  }

  /** Each resident tile's blocks (for the passes that write light, and the checks). */
  forEachResident(cb: (key: string, level: number, blocks: readonly AtlasBlock[], packing: TilePacking, charts: readonly SurfaceChart[]) => void): void {
    for (const [key, r] of this.resident) cb(key, r.level, r.blocks, r.packing, r.charts);
  }

  /** What became resident (or was packed again) and what was let go since the last call, and the rings that stepped. */
  takeChanges(): { allocated: string[]; freed: string[]; rings: { terrain: string; rings: number[] }[] } {
    const out = { allocated: this.allocated, freed: this.freed, rings: this.ringMoves };
    this.allocated = [];
    this.freed = [];
    this.ringMoves = [];
    return out;
  }

  diagnostics(): SurfaceCacheDiagnostics {
    const levels = new Array<number>(SURFACE_LEVELS).fill(0);
    let charts = 0;
    for (const r of this.resident.values()) {
      levels[r.level]! += 1;
      charts += r.charts.length;
    }
    const rings: Record<string, number> = {};
    for (const [k, r] of this.rings) rings[k] = r.rings;
    return {
      budgetBytes: this.budget,
      usedBytes: this.usedBytes(),
      peakUsedBytes: this.stats.peak,
      pageBytes: this.pageCount * SURFACE_PAGE_BYTES,
      pages: this.pageCount,
      ringBytes: this.ringBytes(),
      rings,
      tiles: { offered: this.stats.offered, resident: this.resident.size, beyond: this.stats.beyond },
      levels,
      charts,
      evicted: this.stats.evicted,
      allocated: this.stats.allocated,
      relevelled: this.stats.relevelled,
      ms: this.stats.ms,
    };
  }
}

