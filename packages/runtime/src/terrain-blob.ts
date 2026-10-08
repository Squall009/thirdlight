/**
 * A terrain tile blob as its data on a page or in a worker: the blob a
 * build ships (`manifest.buffers`) or the editor reads by digest, stored gzip
 * by the editor, inflated by the platform's own DecompressionStream and
 * decoded. The renderer's tile textures and the page's `TerrainField` both
 * read tiles through here.
 */
import { decodeTerrainOverview, decodeTerrainTile, readTerrainOverviewBlob, readTerrainTileBlob, type TerrainOverviewTile, type TerrainTile } from '@thirdlight/project-model';

import { gunzip } from './gunzip';

/** One tile blob's data. */
export async function terrainTileOf(blob: ArrayBuffer): Promise<TerrainTile> {
  const { compression, rawLength, stored } = readTerrainTileBlob(new Uint8Array(blob));
  if (compression === 'zstd') throw new Error('terrain tile: zstd is not read in a game (tiles are stored gzip)');
  return decodeTerrainTile(compression === 'gzip' ? await gunzip(stored, rawLength, 'terrain tile') : stored);
}

/** A terrain overview blob's tiles (`terrain-overview.ts`; a build ships it gzip, inflated by the platform). */
export async function terrainOverviewOf(blob: ArrayBuffer): Promise<TerrainOverviewTile[]> {
  const { compression, rawLength, stored } = readTerrainOverviewBlob(new Uint8Array(blob));
  if (compression === 'zstd') throw new Error('terrain overview: zstd is not read in a game (a build ships gzip)');
  return decodeTerrainOverview(compression === 'gzip' ? await gunzip(stored, rawLength, 'terrain overview') : stored);
}
