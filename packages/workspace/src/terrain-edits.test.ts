/**
 * A terrain tile as the backend stores it: a gzip blob whose digest is its
 * name, read back to the same tile; equal tiles are one blob; smooth ground
 * stores at a small part of its size; a blob that is no tile, or one cut
 * short, is refused with a message.
 */
import { describe, expect, it } from 'vitest';
import { flatTerrainTile, readTerrainTileBlob, setTerrainHole, terrainNoise, type TerrainTile } from '@thirdlight/project-model';

import { sha256Hex } from './digest';
import { terrainBlobOf, terrainTileOfBlob } from './terrain-edits';

function hills(samples: number): TerrainTile {
  const t = flatTerrainTile(samples, 0);
  for (let z = 0; z < samples; z++) for (let x = 0; x < samples; x++) t.heights[z * samples + x] = 30000 + Math.round(2000 * terrainNoise(x / 60, z / 60, 1) + 400 * terrainNoise(x / 15, z / 15, 2));
  return t;
}

describe('terrain tile blobs', () => {
  it('a stored tile reads back the same, under its own digest; equal tiles are one blob', () => {
    const t = hills(129);
    setTerrainHole(t, 3, 4, true);
    const blob = terrainBlobOf(t);
    expect(blob.digest).toBe(sha256Hex(blob.bytes));
    expect(readTerrainTileBlob(blob.bytes).compression).toBe('gzip');
    expect(terrainTileOfBlob(blob.bytes)).toEqual(t);
    expect(terrainBlobOf(hills(129)).digest).not.toBe(blob.digest);
    const again = hills(129);
    setTerrainHole(again, 3, 4, true);
    expect(terrainBlobOf(again).digest).toBe(blob.digest);
  });

  it('smooth ground stores at a small part of its size (heights as differences from a plane)', () => {
    const blob = terrainBlobOf(hills(257));
    expect(blob.bytes.length).toBeLessThan((257 * 257 * 2) / 4);
  });

  it('refuses bytes that are no tile, and a tile cut short', () => {
    expect(() => terrainTileOfBlob(new TextEncoder().encode('{"not": "a tile"}'))).toThrow(/not a binary terrain tile/);
    const blob = terrainBlobOf(hills(65)).bytes;
    expect(() => terrainTileOfBlob(blob.subarray(0, blob.length - 20))).toThrow();
  });
});
