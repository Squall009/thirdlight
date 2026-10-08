/**
 * A build's overviews of its streamed terrains (project-model
 * `terrain-overview.ts`): for each terrain with `streaming`, every tile at
 * its coarsest level in one blob (gzip-compressed when the host gives a
 * gzip), a digest-addressed buffer the game reads like a tile
 * (`content/sha256/<digest>`, listed in `manifest.buffers`), named by the
 * terrain component as `overview`. A terrain that does not stream ships as it
 * did (its scene file's bytes unchanged).
 *
 * The editor never stores an overview: it is made here from the tiles'
 * stored blobs, so it always matches the tiles it ships with. A tile's
 * overview is kept across builds by its digest (a build after an edit
 * decodes only the tiles that changed).
 */
import { decodeTerrainTile, encodeTerrainOverview, readTerrainTileBlob, terrainOverviewTile, wrapTerrainOverview, type TerrainComponent, type TerrainOverviewTile, type TerrainTile } from '@thirdlight/project-model';

import type { BlockDataBlob, GzipPort } from './block-chunk-data';

/**
 * Tiles' overviews kept between builds, by tile digest (each a few
 * kilobytes): a cache's bound, not a project's — past it the oldest are made
 * again when next asked for.
 */
const TILE_OVERVIEWS_KEPT = 8192;
const tileOverviews = new Map<string, TerrainTile>();

function overviewOfTile(digest: string, read: (digest: string) => Uint8Array, gzip: GzipPort | undefined): TerrainTile {
  const hit = tileOverviews.get(digest);
  if (hit !== undefined) return hit;
  const { compression, rawLength, stored } = readTerrainTileBlob(read(digest));
  if (compression === 'zstd') throw new Error(`terrain tile ${digest.slice(0, 12)}… is zstd (tiles are stored gzip)`);
  if (compression === 'gzip' && gzip === undefined) throw new Error('a gzip terrain tile and no gzip to read it');
  const tile = decodeTerrainTile(compression === 'gzip' ? gzip!.gunzip(stored, rawLength) : stored);
  const overview = terrainOverviewTile(tile);
  if (tileOverviews.size >= TILE_OVERVIEWS_KEPT) tileOverviews.delete(tileOverviews.keys().next().value!);
  tileOverviews.set(digest, overview);
  return overview;
}

/**
 * Packs documents' streamed terrains: each gets its overview's digest; one
 * packer per build collects the blobs. `read` gives a tile blob's stored
 * bytes by digest (throws when it cannot).
 */
export function terrainOverviewPacker(hash: (bytes: Uint8Array) => string, gzip: GzipPort | undefined, read: (digest: string) => Uint8Array): { pack(doc: unknown): unknown; blobs(): BlockDataBlob[] } {
  const blobs = new Map<string, Uint8Array>();
  const byTiles = new Map<string, string>();
  const overviewOf = (c: TerrainComponent): string => {
    const key = JSON.stringify(c.tiles.map((t) => [t.x, t.z, t.data ?? '']));
    const known = byTiles.get(key);
    if (known !== undefined) return known;
    const tiles: TerrainOverviewTile[] = [];
    for (const t of c.tiles) if (t.data !== undefined) tiles.push({ x: t.x, z: t.z, tile: overviewOfTile(t.data, read, gzip) });
    const raw = encodeTerrainOverview(tiles);
    const bytes = gzip !== undefined ? wrapTerrainOverview('gzip', raw.length, gzip.gzip(raw)) : wrapTerrainOverview('none', raw.length, raw);
    const digest = hash(bytes);
    blobs.set(digest, bytes);
    byTiles.set(key, digest);
    return digest;
  };
  return {
    pack(doc: unknown): unknown {
      const entities = (doc as { entities?: unknown } | null)?.entities;
      if (!Array.isArray(entities) || !entities.some((e) => (e as { components?: { terrain?: TerrainComponent } } | null)?.components?.terrain?.streaming !== undefined)) return doc;
      const packed = entities.map((e: { components?: Record<string, unknown> } & Record<string, unknown>) => {
        const t = e.components?.['terrain'] as TerrainComponent | undefined;
        if (t?.streaming === undefined) return e;
        return { ...e, components: { ...e.components, terrain: { ...t, overview: overviewOf(t) } } };
      });
      return { ...(doc as Record<string, unknown>), entities: packed };
    },
    blobs: () => [...blobs.entries()].map(([digest, bytes]) => ({ digest, bytes })),
  };
}

/** The overviews a packed document's terrains name, by entity (undefined: none). */
export function overviewsIn(doc: unknown): Readonly<Record<string, string>> | undefined {
  const entities = (doc as { entities?: unknown } | null)?.entities;
  if (!Array.isArray(entities)) return undefined;
  const out: Record<string, string> = {};
  for (const e of entities as { id?: unknown; components?: { terrain?: { overview?: unknown } } }[]) {
    const o = e.components?.terrain?.overview;
    if (typeof e.id === 'string' && typeof o === 'string') out[e.id] = o;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}
