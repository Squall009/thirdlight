/**
 * The surface cache's view of a scene: its static geometry as cache tiles,
 * in the same order the tracer packs it, so a traced hit's address (the
 * kind, the object by packing order and the kind's address words) resolves
 * to the texel that holds the light there, or to "not resident".
 *
 * - Block layers: a tile per loaded chunk column (`blockChunkCharts`).
 * - Terrain: its rings (`surface-cache-terrain.ts`).
 * - Generated architecture: a tile per object (`architectureCharts`).
 * - Imported static models: a tile per placed piece (`modelChart`).
 *
 * Pure (no three.js, no device).
 */
import { CHUNK_SIZE, DISTANCE_BRICK_CELLS, type ArchitectureComponent, type BlockCell, type DistanceBricks, type DistanceBrickSet } from '@thirdlight/runtime';

import { blockChunkCharts, chunkOfCell, locateBlockFace, type BlockChunkCharts, type SurfaceBlockGrid } from './surface-cache-blocks';
import { architectureCharts, architecturePiecesOf, boxFacePoint, locateArchitecturePoint, trianglePoint, type ArchitectureCharts } from './surface-cache-arch';
import { brickHitPoint, localNormal, locateModelPoint, modelChart } from './surface-cache-models';
import type { SurfaceCache, SurfaceTexel, SurfaceTile } from './surface-cache';
import type { SurfaceChart } from './surface-cache-atlas';
import type { TerrainRingSource } from './surface-cache-terrain';
import { unpackUnorm2, type TraceHit } from './tracer-cpu-math';
import type { TraceArchitecture, TraceModelInstance } from './tracer-objects';
import { TRACE_ARCH, TRACE_BLOCKS, TRACE_BRICKS, TRACE_TERRAIN, type TraceBlockLayer, type TraceSceneSource, type TraceTerrain } from './tracer-scene';
import { invertAffine, type Affine } from './tracer-words';

/** A block layer: its grid, where it sits, which cells stop light, and which chunk columns are loaded. */
export interface SurfaceBlockLayer {
  readonly key: string;
  readonly grid: SurfaceBlockGrid;
  /** The world position of cell 0, 0, 0's min corner. */
  readonly origin: readonly number[];
  readonly opaque: (cell: BlockCell) => boolean;
  /** Changes with the layer's cells. */
  readonly version: number;
  /** The loaded chunk columns ("cx,cz"). */
  readonly chunks: readonly string[];
  /** The tracer's record of the layer (made from the same grid). */
  readonly trace: TraceBlockLayer;
}

export interface SurfaceTerrain {
  readonly key: string;
  readonly trace: TraceTerrain;
}

export interface SurfaceArchitectureObject {
  readonly key: string;
  readonly component: ArchitectureComponent;
  readonly origin: readonly number[];
  readonly version: number;
  /** Its pieces, when already made (else made from the component). */
  readonly pieces?: TraceArchitecture;
}

export interface SurfaceModel {
  readonly key: string;
  readonly worldToLocal: Affine;
  readonly bricks: DistanceBricks;
  /** The one piece placed (null: the whole model). */
  readonly piece?: string | null;
  readonly version: number;
}

export interface SurfaceSceneInput {
  readonly blocks?: readonly SurfaceBlockLayer[];
  readonly terrain?: readonly SurfaceTerrain[];
  readonly architecture?: readonly SurfaceArchitectureObject[];
  readonly models?: readonly SurfaceModel[];
}

interface BlockTile extends SurfaceTile {
  readonly layer: number;
  readonly cx: number;
  readonly cz: number;
  made: BlockChunkCharts | null;
}

interface ArchTile extends SurfaceTile {
  readonly pieces: TraceArchitecture;
  readonly made: ArchitectureCharts;
}

interface ModelTile extends SurfaceTile {
  readonly set: DistanceBrickSet;
  readonly worldToLocal: Affine;
  readonly chart: SurfaceChart | null;
}

/** The world box of an affine map's local box. */
function worldBox(toWorld: readonly number[], lo: readonly number[], hi: readonly number[]): { min: number[]; max: number[] } {
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (let c = 0; c < 8; c += 1) {
    const p = [c & 1 ? hi[0]! : lo[0]!, c & 2 ? hi[1]! : lo[1]!, c & 4 ? hi[2]! : lo[2]!];
    for (let r = 0; r < 3; r += 1) {
      const v = toWorld[r * 4]! * p[0]! + toWorld[r * 4 + 1]! * p[1]! + toWorld[r * 4 + 2]! * p[2]! + toWorld[r * 4 + 3]!;
      min[r] = Math.min(min[r]!, v);
      max[r] = Math.max(max[r]!, v);
    }
  }
  return { min, max };
}

export class SurfaceScene {
  readonly tiles: SurfaceTile[] = [];
  readonly terrains: TerrainRingSource[] = [];
  private readonly blockTiles = new Map<string, BlockTile>();
  private readonly archObjects: { tile: ArchTile; boxes: number; triangles: number }[] = [];
  private readonly archBoxStarts: number[] = [];
  private readonly archTriStarts: number[] = [];
  private archBoxes = 0;
  private readonly modelTiles: ModelTile[] = [];

  constructor(readonly input: SurfaceSceneInput) {
    (input.blocks ?? []).forEach((layer, li) => {
      const memo = new Map<number, boolean>();
      const { grid } = layer;
      for (const ck of layer.chunks) {
        const [cx, cz] = ck.split(',').map(Number) as [number, number];
        const x0 = Math.max(grid.min[0]!, cx * CHUNK_SIZE);
        const z0 = Math.max(grid.min[2]!, cz * CHUNK_SIZE);
        const x1 = Math.min(grid.max[0]!, cx * CHUNK_SIZE + CHUNK_SIZE);
        const z1 = Math.min(grid.max[2]!, cz * CHUNK_SIZE + CHUNK_SIZE);
        const s = grid.cellSize;
        const o = layer.origin;
        const tile: BlockTile = {
          key: `${layer.key}/${ck}`,
          min: [o[0]! + x0 * s[0]!, o[1]! + grid.min[1]! * s[1]!, o[2]! + z0 * s[2]!],
          max: [o[0]! + x1 * s[0]!, o[1]! + grid.max[1]! * s[1]!, o[2]! + z1 * s[2]!],
          version: layer.version,
          layer: li,
          cx,
          cz,
          made: null,
          charts() {
            return (this.made ??= blockChunkCharts(grid, layer.opaque, cx, cz, memo)).charts;
          },
        };
        this.blockTiles.set(`${li}/${cx},${cz}`, tile);
        this.tiles.push(tile);
      }
    });
    for (const t of input.terrain ?? []) {
      const toWorld = invertAffine(t.trace.worldToLocal);
      const s = t.trace.spacing;
      const box = worldBox(toWorld, [t.trace.cellX0 * s, 0, t.trace.cellZ0 * s], [(t.trace.cellX0 + t.trace.cellsX) * s, 0, (t.trace.cellZ0 + t.trace.cellsZ) * s]);
      this.terrains.push({ key: t.key, min: box.min, max: box.max });
    }
    let tris = 0;
    for (const a of input.architecture ?? []) {
      const pieces = a.pieces ?? architecturePiecesOf(a.component, a.origin);
      // The charts give the object's box, so they are made with the scene (the tracer meets every piece anyway).
      const made = architectureCharts(pieces);
      const tile: ArchTile = { key: a.key, min: made.min, max: made.max, version: a.version, pieces, made, charts: () => made.charts };
      const nt = Math.floor(pieces.triangles.length / 9);
      this.archBoxStarts.push(this.archBoxes);
      this.archTriStarts.push(tris);
      this.archBoxes += pieces.boxes.length;
      tris += nt;
      this.archObjects.push({ tile, boxes: pieces.boxes.length, triangles: nt });
      if (made.charts.length > 0) this.tiles.push(tile);
    }
    for (const m of input.models ?? []) {
      const toWorld = invertAffine(m.worldToLocal);
      for (const set of m.bricks.sets) {
        if (m.piece !== undefined && m.piece !== null && set.piece !== m.piece) continue;
        const size = set.voxel * DISTANCE_BRICK_CELLS;
        const box = worldBox(toWorld, set.min, [0, 1, 2].map((k) => set.min[k]! + set.dims[k]! * size));
        const chart = modelChart(set, m.worldToLocal);
        const tile: ModelTile = { key: `${m.key}/${set.piece}`, min: box.min, max: box.max, version: m.version, set, worldToLocal: m.worldToLocal, chart, charts: () => (chart === null ? [] : [chart]) };
        this.modelTiles.push(tile);
        if (chart !== null) this.tiles.push(tile);
      }
    }
  }

  /** What the tracer packs, in the order the hits name objects by. */
  traceSource(): TraceSceneSource {
    const boxes = this.archObjects.flatMap((o) => o.tile.pieces.boxes);
    const tris = new Float32Array(this.archObjects.reduce((s, o) => s + o.tile.pieces.triangles.length, 0));
    let at = 0;
    for (const o of this.archObjects) {
      tris.set(o.tile.pieces.triangles, at);
      at += o.tile.pieces.triangles.length;
    }
    const bricks: TraceModelInstance[] = this.modelTiles.map((t) => ({ worldToLocal: t.worldToLocal, set: t.set }));
    return {
      blocks: (this.input.blocks ?? []).map((l) => l.trace),
      terrain: (this.input.terrain ?? []).map((t) => t.trace),
      arch: { boxes, triangles: tris },
      bricks,
    };
  }

  /** The texel a traced hit's light is in (null: a miss, an unfinished ray, or not resident). */
  resolve(cache: SurfaceCache, hit: TraceHit): SurfaceTexel | null {
    if (hit.kind === TRACE_BLOCKS) {
      const layer = this.input.blocks?.[hit.object];
      if (layer === undefined) return null;
      const g = layer.grid;
      const dx = g.max[0]! - g.min[0]!;
      const dz = g.max[2]! - g.min[2]!;
      const local = [hit.a0 % dx, Math.floor(hit.a0 / (dx * dz)), Math.floor(hit.a0 / dx) % dz];
      const cell = [local[0]! + g.min[0]!, local[1]! + g.min[1]!, local[2]! + g.min[2]!];
      const [cx, cz] = chunkOfCell(cell[0]!, cell[2]!);
      const tile = this.blockTiles.get(`${hit.object}/${cx},${cz}`);
      if (tile === undefined || cache.levelOf(tile.key) === null) return null;
      tile.charts();
      const [fu, fv] = unpackUnorm2(hit.a1);
      const at = locateBlockFace(g, tile.made!, cx, cz, cell, hit.face, fu, fv);
      return at === null ? null : cache.texelOf(tile.key, at.chart, at);
    }
    if (hit.kind === TRACE_TERRAIN) {
      const t = this.input.terrain?.[hit.object];
      if (t === undefined) return null;
      const [fx, fz] = unpackUnorm2(hit.a1);
      const s = t.trace.spacing;
      const lx = (t.trace.cellX0 + (hit.a0 % t.trace.cellsX) + fx) * s;
      const lz = (t.trace.cellZ0 + Math.floor(hit.a0 / t.trace.cellsX) + fz) * s;
      const m = invertAffine(t.trace.worldToLocal);
      return cache.ringTexelOf(t.key, m[0]! * lx + m[2]! * lz + m[3]!, m[8]! * lx + m[10]! * lz + m[11]!);
    }
    if (hit.kind === TRACE_ARCH) {
      const [b1, b2] = unpackUnorm2(hit.a1);
      if (hit.object < this.archBoxes) {
        const o = upperIndex(this.archBoxStarts, hit.object);
        const obj = this.archObjects[o]!;
        const box = hit.object - this.archBoxStarts[o]!;
        return this.archTexel(cache, obj.tile, box * 6 + hit.face, boxFacePoint(obj.tile.pieces, box, hit.face, b1, b2));
      }
      const tri = hit.object - this.archBoxes;
      const o = upperIndex(this.archTriStarts, tri);
      const obj = this.archObjects[o]!;
      const local = tri - this.archTriStarts[o]!;
      return this.archTexel(cache, obj.tile, obj.boxes * 6 + local, trianglePoint(obj.tile.pieces, local, b1, b2));
    }
    if (hit.kind === TRACE_BRICKS) {
      const tile = this.modelTiles[hit.object];
      if (tile === undefined || tile.chart === null) return null;
      const level = cache.levelOf(tile.key);
      if (level === null) return null;
      const at = locateModelPoint(tile.set, tile.chart, brickHitPoint(tile.set, hit.a0), localNormal(tile.worldToLocal, hit.normal), level);
      return at === null ? null : cache.texelOf(tile.key, 0, at);
    }
    return null;
  }

  private archTexel(cache: SurfaceCache, tile: ArchTile, piece: number, p: readonly number[]): SurfaceTexel | null {
    if (cache.levelOf(tile.key) === null) return null;
    const at = locateArchitecturePoint(tile.made, piece, p);
    return at === null ? null : cache.texelOf(tile.key, at.chart, at);
  }

  /** The block tile of layer `layer`'s chunk column (for the checks). */
  blockTile(layer: number, cx: number, cz: number): (SurfaceTile & { readonly made: BlockChunkCharts | null }) | undefined {
    return this.blockTiles.get(`${layer}/${cx},${cz}`);
  }
}

/** The last index whose start is at most `v` (starts ascending). */
function upperIndex(starts: readonly number[], v: number): number {
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid]! <= v) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}
