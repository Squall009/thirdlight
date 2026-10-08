/**
 * Ground cover made off the page's main thread: the cover rules of a
 * terrain or a block layer (`scatter.ts`, `cover: true`) placed over one
 * square of ground near the camera, with the same rule code and the same
 * surfaces the stored scatter is baked with — only never stored.
 *
 * The page hands each source over as it gets it (a terrain's tile list and,
 * before it asks for a square, the decoded tiles under it; a block layer's
 * chunks and the block types), then asks for squares one at a time; each
 * answer is the square's copies per rule (10 floats each, the source's
 * frame), handed over, not copied. It runs in the view's worker script
 * beside the block mesher and the terrain packer, on its own worker; the
 * page falls back to the same `CoverGenerator` when no worker can run.
 *
 * This module imports no three.js: the worker bundle stays small.
 */
import {
  BlockGrid,
  SurfaceRuleSet,
  TerrainField,
  bakeScatterCell,
  blockScatterSurface,
  regionExcluder,
  SplineScatterBands,
  terrainScatterSurface,
  terrainSplineInputs,
  type BlockChunk,
  type BlockLayerComponent,
  type BlockLayerData,
  type BlockType,
  type ScatterRect,
  type ScatterRule,
  type ScatterSurface,
  type SplineComponent,
  type TerrainComponent,
  type TerrainTile,
} from '@thirdlight/runtime';

/** A spline whose scatter band terrain cover keeps clear of: its object id, component and position. */
export interface CoverSpline {
  readonly id: string;
  readonly component: SplineComponent;
  readonly origin: readonly number[];
}

/** A source as the generator holds it. */
export type CoverSource =
  | { readonly kind: 'terrain'; readonly component: TerrainComponent; readonly origin: readonly number[]; readonly rules: readonly ScatterRule[] }
  | { readonly kind: 'blocks'; readonly component: BlockLayerComponent; readonly origin: readonly number[]; readonly rules: readonly ScatterRule[]; readonly data: BlockLayerData | null };

/** Page → worker. */
export type CoverRequest =
  | { readonly t: 'coverSource'; readonly id: string; readonly source: CoverSource }
  | { readonly t: 'coverChunks'; readonly id: string; readonly chunks: readonly { cx: number; cz: number; chunk: BlockChunk | null }[] }
  | { readonly t: 'coverTypes'; readonly types: readonly BlockType[] }
  | { readonly t: 'coverTile'; readonly digest: string; readonly tile: TerrainTile }
  | { readonly t: 'coverForget'; readonly digest: string }
  | { readonly t: 'coverDrop'; readonly id: string }
  | { readonly t: 'coverSplines'; readonly splines: readonly CoverSpline[] }
  | { readonly t: 'coverMake'; readonly job: number; readonly id: string; readonly rect: ScatterRect };

/** One square's copies per rule. */
export interface CoverCopies {
  readonly rule: string;
  readonly copies: Float32Array;
}

/** Worker → page. */
export type CoverReply = { readonly t: 'coverMade'; readonly job: number; readonly ok: true; readonly made: readonly CoverCopies[]; readonly ms: number; readonly looked?: number } | { readonly t: 'coverMade'; readonly job: number; readonly ok: false; readonly message: string };

interface Held {
  source: CoverSource;
  /** The surface, made on the first square asked and kept until the source or its data change. */
  surface: ScatterSurface | null;
  grid: BlockGrid | null;
}

/** The sources, tiles and types a generator holds, and the squares it makes. */
export class CoverGenerator {
  private readonly sources = new Map<string, Held>();
  private readonly tiles = new Map<string, TerrainTile>();
  private types = new Map<string, BlockType>();
  /** The splines' scatter bands (terrain cover keeps clear of them, as the stored scatter does). */
  private bands: SplineScatterBands | null = null;
  /** Candidate places looked at so far (diagnostics). */
  looked = 0;

  apply(m: Exclude<CoverRequest, { t: 'coverMake' }>): void {
    switch (m.t) {
      case 'coverSource':
        this.sources.set(m.id, { source: m.source, surface: null, grid: null });
        break;
      case 'coverChunks': {
        const h = this.sources.get(m.id);
        if (h === undefined || h.source.kind !== 'blocks') return;
        if (h.grid !== null) for (const c of m.chunks) h.grid.replaceChunk(c.cx, c.cz, c.chunk);
        else {
          const byKey = new Map((h.source.data?.chunks ?? []).map((c) => [`${c.cx},${c.cz}`, c]));
          for (const c of m.chunks) {
            if (c.chunk === null) byKey.delete(`${c.cx},${c.cz}`);
            else byKey.set(`${c.cx},${c.cz}`, c.chunk);
          }
          h.source = { ...h.source, data: { entityId: m.id, chunks: [...byKey.values()], ...(h.source.data?.regions !== undefined ? { regions: h.source.data.regions } : {}) } };
        }
        h.surface = null;
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

  /** Whether the generator holds a tile's data. */
  hasTile(digest: string): boolean {
    return this.tiles.has(digest);
  }

  /** The cover copies over one square (world XZ) of a source, per rule. */
  make(id: string, rect: ScatterRect): CoverCopies[] {
    const h = this.sources.get(id);
    if (h === undefined) return [];
    const s = h.source;
    if (s.rules.length === 0) return [];
    h.surface ??= this.surfaceOf(h);
    const baked = bakeScatterCell(s.rules, h.surface, null, rect, null, s.origin);
    this.looked += baked.looked;
    const cell = baked.cell;
    const out: CoverCopies[] = [];
    for (const r of s.rules) {
      const c = cell.get(r.id);
      if (c !== undefined && c.copies.length > 0) out.push({ rule: r.id, copies: c.copies });
    }
    return out;
  }

  private surfaceOf(h: Held): ScatterSurface {
    const s = h.source;
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
      return terrainScatterSurface(new TerrainField(s.component, s.origin, tiles), excluded, bands === null ? undefined : (x, z, rule) => bands.cleared(x, z, rule));
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
    if (req.t !== 'coverMake') {
      gen.apply(req);
      return;
    }
    const t0 = performance.now();
    try {
      const made = gen.make(req.id, req.rect);
      const reply: CoverReply = { t: 'coverMade', job: req.job, ok: true, made, ms: performance.now() - t0, looked: gen.looked };
      endpoint.post(reply, made.map((c) => c.copies.buffer as ArrayBuffer));
    } catch (e) {
      endpoint.post({ t: 'coverMade', job: req.job, ok: false, message: e instanceof Error ? e.message : String(e) } satisfies CoverReply);
    }
  });
}
