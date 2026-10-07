/**
 * The page side of a terrain's tiles: each tile the component names with
 * data is a `manifest.buffers` blob (`content/sha256/<digest>`, digest-verified
 * by the reader), stored gzip by the editor and shipped as it is; here it is
 * inflated by the browser's own DecompressionStream and decoded, and the
 * tiles become a `TerrainField` to ask for heights, normals, holes and
 * layers. A tile named by several terrains (or twice) is read once.
 */
import { TerrainField, terrainTileKey, terrainTileOf, type TerrainComponent, type TerrainTile } from '@thirdlight/runtime';

export { terrainTileOf };

/**
 * A terrain's tiles loaded (all of them; streaming by distance loads a ring
 * at a time through the same reader). `read` gives a buffer's verified bytes
 * by digest; `origin` is the terrain object's world position.
 */
export async function loadTerrainField(component: TerrainComponent, origin: readonly number[], read: (digest: string) => Promise<ArrayBuffer>, only?: (x: number, z: number) => boolean): Promise<TerrainField> {
  const byDigest = new Map<string, Promise<TerrainTile>>();
  const tiles = new Map<string, TerrainTile>();
  await Promise.all(
    component.tiles.map(async (t) => {
      if (t.data === undefined || (only !== undefined && !only(t.x, t.z))) return;
      let p = byDigest.get(t.data);
      if (p === undefined) {
        p = read(t.data).then(terrainTileOf);
        byDigest.set(t.data, p);
      }
      const tile = await p;
      if (tile.samples !== component.tileSamples) throw new Error(`terrain tile [${t.x}, ${t.z}] holds ${tile.samples} samples a side, the terrain ${component.tileSamples}`);
      tiles.set(terrainTileKey(t.x, t.z), tile);
    }),
  );
  return new TerrainField(component, origin, tiles);
}
