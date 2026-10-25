/**
 * What ground cover needs worked out off the page's main thread, with the
 * same rule code and the same surfaces the stored scatter is baked with:
 * for a terrain, a cover rule's mask over one tile (`coverMask`: what the
 * GPU cannot read from the terrain's texels); for a block layer or a mesh
 * (a placed model's faces, architecture's floors), a cover rule's point set
 * over one chunk (`bakeCoverPoints`: every floor its conditions keep, at the
 * rule's full density), which the GPU thins.
 *
 * The page hands each source over as it gets it (a terrain's tile list and,
 * before it asks for a mask, the decoded tiles under it; a block layer's
 * chunks and the block types), then asks for masks and point sets one at a
 * time, as the view reaches them and again when their ground changes; each
 * answer is handed over, not copied. A terrain's cover keeps off the block
 * layers its blocks layers meet (`TerrainBlockSeam.covered`, the test its
 * stored scatter was baked with); the page hands those block layers over
 * too. It runs in the view's worker script
 * beside the block mesher and the terrain packer, on its own worker; the
 * page falls back to the same `CoverGenerator` when no worker can run.
 *
 * This module imports no three.js: the worker bundle stays small.
 */
import {
  BlockGrid,
  SurfaceRuleSet,
  TERRAIN_BLOCKS_BLEND_DEFAULT,
  TerrainBlockSeam,
  TerrainField,
  bakeCoverPoints,
  blockChunkRect,
  meshCoverChunkRect,
  meshScatterSurface,
  blockScatterSurface,
  regionExcluder,
  SplineScatterBands,
  terrainScatterSurface,
  terrainSplineInputs,
  type BlockChunk,
  type BlockLayerComponent,
  type BlockLayerData,
  type BlockType,
  type CoverPointSet,
  type ScatterRule,
  type ScatterSurface,
  type SplineComponent,
  type TerrainComponent,
  type TerrainTile,
} from '@thirdlight/runtime';

import { coverMask, coverMaskSide } from './cover-placement';

/** A spline whose scatter band terrain cover keeps clear of: its object id, component and position. */
export interface CoverSpline {
  readonly id: string;
  readonly component: SplineComponent;
  readonly origin: readonly number[];
}

/** A source as the generator holds it. */
export type CoverSource =
  | { readonly kind: 'terrain'; readonly component: TerrainComponent; readonly origin: readonly number[]; readonly rules: readonly ScatterRule[] }
  | { readonly kind: 'blocks'; readonly component: BlockLayerComponent; readonly origin: readonly number[]; readonly rules: readonly ScatterRule[]; readonly data: BlockLayerData | null }
  /** A mesh: a placed model's faces or architecture's floors, 9 floats a triangle in the frame of `origin` (`meshScatterSurface`). */
  | { readonly kind: 'mesh'; readonly origin: readonly number[]; readonly rules: readonly ScatterRule[]; readonly triangles: Float32Array };

/** Page → worker. */
export type CoverRequest =
  | { readonly t: 'coverSource'; readonly id: string; readonly source: CoverSource }
  | { readonly t: 'coverChunks'; readonly id: string; readonly chunks: readonly { cx: number; cz: number; chunk: BlockChunk | null }[] }
  | { readonly t: 'coverTypes'; readonly types: readonly BlockType[] }
  | { readonly t: 'coverTile'; readonly digest: string; readonly tile: TerrainTile }
  | { readonly t: 'coverForget'; readonly digest: string }
  | { readonly t: 'coverDrop'; readonly id: string }
  | { readonly t: 'coverSplines'; readonly splines: readonly CoverSpline[] }
  | { readonly t: 'coverPoints'; readonly job: number; readonly id: string; readonly rule: string; readonly cx: number; readonly cz: number }
  | { readonly t: 'coverMask'; readonly job: number; readonly id: string; readonly rule: string; readonly tx: number; readonly tz: number };

/** Worker → page. */
export type CoverReply =
  | { readonly t: 'coverPointed'; readonly job: number; readonly points: CoverPointSet | null; readonly message?: string }
  | { readonly t: 'coverMasked'; readonly job: number; readonly mask: Uint8Array | null; readonly message?: string };

interface Held {
  source: CoverSource;
  /** The surface, made on the first square asked and kept until the source or its data change. */
  surface: ScatterSurface | null;
  grid: BlockGrid | null;
}

/** The sources, tiles and types a generator holds, and the masks and point sets it makes. */
export class CoverGenerator {
  private readonly sources = new Map<string, Held>();
  private readonly tiles = new Map<string, TerrainTile>();
  private types = new Map<string, BlockType>();
  /** The splines' scatter bands (terrain cover keeps clear of them, as the stored scatter does). */
  private bands: SplineScatterBands | null = null;
  apply(m: Exclude<CoverRequest, { t: 'coverPoints' | 'coverMask' }>): void {
    switch (m.t) {
      case 'coverSource':
        this.sources.set(m.id, { source: m.source, surface: null, grid: null });
        // A block layer's footprint is what terrains' blocks layers keep their cover off.
        if (m.source.kind === 'blocks') this.groundChanged();
        break;
      case 'coverChunks': {
        const h = this.sources.get(m.id);
        if (h === undefined || h.source.kind !== 'blocks') return;
        if (h.grid !== null) for (const c of m.chunks) h.grid.replaceChunk(c.cx, c.cz, c.chunk);
        // The stored form follows too (a terrain's seam reads it).
        const byKey = new Map((h.source.data?.chunks ?? []).map((c) => [`${c.cx},${c.cz}`, c]));
        for (const c of m.chunks) {
          if (c.chunk === null) byKey.delete(`${c.cx},${c.cz}`);
          else byKey.set(`${c.cx},${c.cz}`, c.chunk);
        }
        h.source = { ...h.source, data: { entityId: m.id, chunks: [...byKey.values()], ...(h.source.data?.regions !== undefined ? { regions: h.source.data.regions } : {}) } };
        h.surface = null;
        this.groundChanged();
        break;
      }
      case 'coverTypes':
        this.types = new Map(m.types.map((t) => [t.blockId, t]));
        for (const h of this.sources.values()) h.surface = null;
        break;
      case 'coverTile':
        this.tiles.set(m.digest, m.tile);
        for (const h of this.sources.values()) if (h.source.kind === 'terrain') h.surface = null;
        break;
      case 'coverForget':
        this.tiles.delete(m.digest);
        break;
      case 'coverDrop':
        if (this.sources.get(m.id)?.source.kind === 'blocks') this.groundChanged();
        this.sources.delete(m.id);
        break;
      case 'coverSplines': {
        const bands = new SplineScatterBands(terrainSplineInputs(m.splines.map((s) => ({ id: s.id, components: { spline: s.component, transform: { position: s.origin } } }))));
        this.bands = bands.empty ? null : bands;
        for (const h of this.sources.values()) if (h.source.kind === 'terrain') h.surface = null;
        break;
      }
    }
  }

  /** A block layer changed: the terrains' surfaces (their seams with it) are made again. */
  private groundChanged(): void {
    for (const h of this.sources.values()) if (h.source.kind === 'terrain') h.surface = null;
  }

  /** Whether a world point is on the footprint of a block layer one of terrain `s`'s blocks layers meets (null: it has none). */
  private coveredOf(s: Extract<CoverSource, { kind: 'terrain' }>): ((x: number, z: number) => boolean) | null {
    const seams: TerrainBlockSeam[] = [];
    for (const l of s.component.layers ?? []) {
      if (l.kind !== 'blocks' || l.enabled === false || (l.strength ?? 1) <= 0) continue;
      const sources = [...this.sources.entries()]
        .filter(([id, o]) => o.source.kind === 'blocks' && (l.blockLayers === undefined || l.blockLayers.includes(id)))
        .map(([id, o]) => {
          const b = o.source as Extract<CoverSource, { kind: 'blocks' }>;
          return { id, component: b.component, data: b.data, types: this.types, origin: b.origin };
        });
      if (sources.length > 0) seams.push(new TerrainBlockSeam(sources, { mode: l.mode ?? 'cut', blend: l.blend ?? TERRAIN_BLOCKS_BLEND_DEFAULT, paint: false }, s.component, s.origin));
    }
    return seams.length === 0 ? null : (x, z) => seams.some((seam) => seam.covered(x, z));
  }

  /** Whether the generator holds a tile's data. */
  hasTile(digest: string): boolean {
    return this.tiles.has(digest);
  }

  /** Rule `rule`'s points over chunk (cx, cz) of block layer or mesh `id` (null: no such source or rule). */
  points(id: string, rule: string, cx: number, cz: number): CoverPointSet | null {
    const h = this.sources.get(id);
    if (h === undefined || h.source.kind === 'terrain') return null;
    const r = h.source.rules.find((x) => x.id === rule);
    if (r === undefined) return null;
    h.surface ??= this.surfaceOf(h);
    const o = h.source.origin;
    return bakeCoverPoints(r, h.surface, h.source.kind === 'mesh' ? meshCoverChunkRect(o, cx, cz) : blockChunkRect(o, h.source.component.cellSize, cx, cz), o);
  }

  /** Rule `rule`'s mask over tile (tx, tz) of terrain `id` (`coverMask`; null: none needed, or no such rule). */
  mask(id: string, rule: string, tx: number, tz: number): Uint8Array | null {
    const h = this.sources.get(id);
    if (h === undefined || h.source.kind !== 'terrain') return null;
    const r = h.source.rules.find((x) => x.id === rule);
    if (r === undefined) return null;
    h.surface ??= this.surfaceOf(h);
    const c = h.source.component;
    const size = (c.tileSamples - 1) * c.spacing;
    return coverMask(r, h.surface, (h.source.origin[0] ?? 0) + tx * size, (h.source.origin[2] ?? 0) + tz * size, size, coverMaskSide(c.tileSamples));
  }

  private surfaceOf(h: Held): ScatterSurface {
    const s = h.source;
    // A mesh has no regions: its faces are its own.
    if (s.kind === 'mesh') return meshScatterSurface(s.triangles, s.origin);
    // Ground cover keeps off the named regions of every block layer the generator holds.
    const regions = [...this.sources.values()].flatMap((o) => (o.source.kind === 'blocks' ? [{ regions: this.gridOf(o).regions, cellSize: o.source.component.cellSize, origin: o.source.origin }] : []));
    const excluded = regionExcluder(regions);
    if (s.kind === 'terrain') {
      const tiles = new Map<string, TerrainTile>();
      for (const t of s.component.tiles) {
        const tile = t.data !== undefined ? this.tiles.get(t.data) : undefined;
        if (tile !== undefined) tiles.set(`${t.x},${t.z}`, tile);
      }
      const bands = this.bands;
      const covered = this.coveredOf(s);
      const cleared = bands === null && covered === null ? undefined : (x: number, z: number, rule: string): boolean => (covered?.(x, z) ?? false) || (bands?.cleared(x, z, rule) ?? false);
      return terrainScatterSurface(new TerrainField(s.component, s.origin, tiles), excluded, cleared);
    }
    const rules = s.component.rules;
    return blockScatterSurface({ grid: this.gridOf(h), types: this.types, origin: s.origin, topSubdivision: s.component.topSubdivision ?? 1, ...(rules !== undefined && rules.length > 0 ? { rules: new SurfaceRuleSet(rules) } : {}) }, excluded);
  }

  private gridOf(h: Held): BlockGrid {
    if (h.grid === null) {
      const s = h.source as Extract<CoverSource, { kind: 'blocks' }>;
      h.grid = BlockGrid.from(s.component, s.data);
    }
    return h.grid;
  }
}

/** The endpoint a worker talks through (its global scope, or a port in tests). */
export interface CoverEndpoint {
  post(message: unknown, transfer?: readonly ArrayBuffer[]): void;
  listen(onMessage: (message: unknown) => void): void;
}

/** Run the cover generator on an endpoint (beside the block mesher and terrain packer on the same one: each ignores the others' messages). */
export function runCoverWorker(endpoint: CoverEndpoint): void {
  const gen = new CoverGenerator();
  endpoint.listen((raw) => {
    const m = raw as Partial<CoverRequest> | null;
    if (typeof m?.t !== 'string' || !m.t.startsWith('cover')) return;
    const req = m as CoverRequest;
    if (req.t === 'coverMask') {
      try {
        const mask = gen.mask(req.id, req.rule, req.tx, req.tz);
        endpoint.post({ t: 'coverMasked', job: req.job, mask } satisfies CoverReply, mask !== null ? [mask.buffer as ArrayBuffer] : undefined);
      } catch (e) {
        endpoint.post({ t: 'coverMasked', job: req.job, mask: null, message: e instanceof Error ? e.message : String(e) } satisfies CoverReply);
      }
      return;
    }
    if (req.t !== 'coverPoints') {
      gen.apply(req);
      return;
    }
    try {
      const points = gen.points(req.id, req.rule, req.cx, req.cz);
      endpoint.post({ t: 'coverPointed', job: req.job, points } satisfies CoverReply, points !== null ? [points.data.buffer as ArrayBuffer] : undefined);
    } catch (e) {
      endpoint.post({ t: 'coverPointed', job: req.job, points: null, message: e instanceof Error ? e.message : String(e) } satisfies CoverReply);
    }
  });
}
