/**
 * The page side of a terrain's tiles: each tile the component names with
 * data is a `manifest.buffers` blob (`content/sha256/<digest>`, digest-verified
 * by the reader), stored gzip by the editor and shipped as it is; it is
 * inflated by the platform's own DecompressionStream and decoded, and the
 * tiles become a `TerrainField` to ask for heights, normals, holes and
 * layers. A tile named by several terrains (or twice) is read once.
 *
 * A game page holds its decoded tiles in the renderer's tile store (decoded
 * and packed on a worker) and hands them to the simulation's colliders from
 * there (`preloadTerrainTiles`, `feedTerrainCollision`); `loadTerrainField`
 * reads a terrain whole where no renderer runs.
 */
import { TerrainField, resolveStreamingRings, squareDistance, terrainTileKey, terrainTileOf, terrainTileSize, type TerrainComponent, type TerrainSimData, type TerrainTile, type TerrainTileData } from '@thirdlight/runtime';

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

/** The page's decoded tiles as the game page uses them (three-adapter's `TerrainTileStore`). */
export interface PageTerrainTiles {
  preload(component: TerrainComponent, pack: boolean, only?: (x: number, z: number) => boolean): Promise<void>;
  tiles(): ReadonlyMap<string, TerrainTile>;
  onTile(listener: (digest: string, tile: TerrainTile) => void): () => void;
  onRelease(listener: (digest: string) => void): () => void;
}

type EntityLike = { readonly components?: unknown };

/**
 * Where a game starts looking from, before its simulation has run: its
 * cameras and characters (what world streaming's rings follow) in the start
 * entities.
 */
export function startStreamSources(entities: readonly EntityLike[]): number[][] {
  const out: number[][] = [];
  for (const e of entities) {
    const c = e.components as { transform?: { position?: readonly number[] }; camera?: unknown; virtualCamera?: unknown; controller?: unknown } | undefined;
    const p = c?.transform?.position;
    if (p !== undefined && (c?.camera !== undefined || c?.virtualCamera !== undefined || c?.controller !== undefined)) out.push([p[0] ?? 0, p[1] ?? 0, p[2] ?? 0]);
  }
  return out;
}

/**
 * Read the terrains of `entities` into the page's tiles before the
 * simulation gets them (their colliders are built on its first step): every
 * tile with data — a streamed terrain's only within its collision ring of
 * the start's cameras and characters (the rest stream in round the camera,
 * drawn from the overview until then) — packed for drawing too when
 * terrains are drawn.
 */
export async function preloadTerrainTiles(entities: readonly EntityLike[], tiles: PageTerrainTiles, drawn: boolean): Promise<void> {
  const work: Promise<void>[] = [];
  const sources = startStreamSources(entities);
  for (const e of entities) {
    const c = (e.components as { terrain?: TerrainComponent } | undefined)?.terrain;
    if (c === undefined || !c.tiles.some((t) => t.data !== undefined)) continue;
    if (!drawn && c.collision === false) continue;
    const rings = resolveStreamingRings(c.streaming);
    if (rings === null) {
      work.push(tiles.preload(c, drawn));
      continue;
    }
    const at = (e.components as { transform?: { position?: readonly number[] } }).transform?.position ?? [0, 0, 0];
    const size = terrainTileSize(c);
    const reach = rings.collision.radius + rings.collision.hysteresis;
    const near = (x: number, z: number): boolean => {
      const x0 = (at[0] ?? 0) + x * size;
      const z0 = (at[2] ?? 0) + z * size;
      return sources.some((p) => squareDistance(x0, z0, x0 + size, z0 + size, p[0]!, p[2]!) <= reach);
    };
    work.push(tiles.preload(c, drawn, near));
  }
  await Promise.all(work);
}

/** What the simulation reads of a decoded tile — collision's heights and holes, `ctx.surface`'s layer weights and paint (the same arrays: a simulation on the page shares them; its worker gets a copy). */
export const terrainTileData = (digest: string, tile: TerrainTile): TerrainTileData => ({ digest, samples: tile.samples, heights: tile.heights, holes: tile.holes, weights: tile.weights, paint: tile.paint });

/**
 * Hand the page's decoded tiles to a simulation's colliders: those decoded
 * now, each one as it is, and each one the page lets go of (world streaming:
 * the simulation lets go of its copy too); returns the stop.
 */
export function feedTerrainCollision(tiles: PageTerrainTiles, add: (tiles: readonly TerrainSimData[]) => void): () => void {
  const now = [...tiles.tiles()].map(([d, t]) => terrainTileData(d, t));
  if (now.length > 0) add(now);
  const stopTiles = tiles.onTile((digest, tile) => add([terrainTileData(digest, tile)]));
  const stopReleases = tiles.onRelease((digest) => add([{ digest, dropped: true }]));
  return () => {
    stopTiles();
    stopReleases();
  };
}
