/**
 * Terrain tiles decoded and packed off the page's main thread: a tile blob
 * in, its decoded data and its three layers' texels out (handed over, not
 * copied). It runs in the view's worker script beside the block mesher
 * (`block-mesh-worker.ts`), on its own worker; the page side is
 * `terrain-tile-store.ts`, which falls back to the same functions on the
 * page when no worker can run.
 *
 * Jobs run one at a time in arrival order; the worker keeps nothing between
 * them (a tile's border normals, which read its neighbours, are written
 * again on the page once they are known).
 *
 * This module imports no three.js: the worker bundle stays small.
 */
import { terrainTileOf, type TerrainTile } from '@thirdlight/runtime';

import { terrainLodLayout, tileHeightBounds, type TileHeightBounds } from './terrain-quadtree';
import { packHeightNormalAlone, packLayers, TERRAIN_TEXEL_BYTES } from './terrain-texels';

/** What a tile's texels are packed for: the metres of one height step and between samples (its normals read both). */
export interface TerrainPackShape {
  readonly metresPerStep: number;
  readonly spacing: number;
}

/** A tile's three layers' texels and its quadtree's height bounds. */
export interface TerrainTexels {
  readonly heights: Uint8Array;
  readonly layers: Uint8Array;
  readonly indices: Uint8Array;
  readonly bounds: TileHeightBounds;
}

/** Page → worker: decode a tile blob, and pack it when `shape` is given. */
export interface TerrainPackRequest {
  readonly t: 'terrainPack';
  readonly id: number;
  readonly blob: ArrayBuffer;
  readonly shape: TerrainPackShape | null;
}

/** Worker → page. */
export type TerrainPackReply =
  | { readonly t: 'terrainPacked'; readonly id: number; readonly ok: true; readonly tile: TerrainTile; readonly texels: TerrainTexels | null; readonly decodeMs: number; readonly packMs: number }
  | { readonly t: 'terrainPacked'; readonly id: number; readonly ok: false; readonly message: string };

/** Pack a decoded tile's texels (alone: no neighbours) and its height bounds. */
export function packTerrainTile(tile: TerrainTile, shape: TerrainPackShape): TerrainTexels {
  const bytes = tile.samples * tile.samples * TERRAIN_TEXEL_BYTES;
  const heights = new Uint8Array(bytes);
  const layers = new Uint8Array(bytes);
  const indices = new Uint8Array(bytes);
  packHeightNormalAlone(heights, tile, shape.metresPerStep, shape.spacing);
  packLayers(layers, indices, tile);
  return { heights, layers, indices, bounds: tileHeightBounds(tile.heights, terrainLodLayout(tile.samples, shape.spacing)) };
}

/** The distinct buffers a reply hands over (a tile's arrays may share one). */
export function terrainReplyBuffers(tile: TerrainTile, texels: TerrainTexels | null): ArrayBuffer[] {
  const set = new Set<ArrayBuffer>();
  for (const a of [tile.heights, tile.weights, tile.paint, tile.holes]) if (a !== null) set.add(a.buffer as ArrayBuffer);
  if (texels !== null) {
    for (const a of [texels.heights, texels.layers, texels.indices, ...texels.bounds.min, ...texels.bounds.max]) set.add(a.buffer as ArrayBuffer);
  }
  return [...set];
}

/** The endpoint a worker talks through (its global scope, or a port in tests). */
export interface TerrainPackEndpoint {
  post(message: unknown, transfer?: readonly ArrayBuffer[]): void;
  listen(onMessage: (message: unknown) => void): void;
}

/** Run the terrain packer on an endpoint (beside the block mesher on the same one: each ignores the other's messages). */
export function runTerrainPackWorker(endpoint: TerrainPackEndpoint): void {
  let chain: Promise<void> = Promise.resolve();
  endpoint.listen((raw) => {
    const m = raw as Partial<TerrainPackRequest> | null;
    if (m?.t !== 'terrainPack') return;
    const req = m as TerrainPackRequest;
    chain = chain.then(async () => {
      try {
        const t0 = performance.now();
        const tile = await terrainTileOf(req.blob);
        const t1 = performance.now();
        const texels = req.shape === null ? null : packTerrainTile(tile, req.shape);
        const reply: TerrainPackReply = { t: 'terrainPacked', id: req.id, ok: true, tile, texels, decodeMs: t1 - t0, packMs: performance.now() - t1 };
        endpoint.post(reply, terrainReplyBuffers(tile, texels));
      } catch (e) {
        const reply: TerrainPackReply = { t: 'terrainPacked', id: req.id, ok: false, message: e instanceof Error ? e.message : String(e) };
        endpoint.post(reply);
      }
    });
  });
}
