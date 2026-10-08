/**
 * The page side of the terrains' stored scatter for the simulation: each
 * tile's scatter blob (`TerrainTileRef.scatter`) read, verified and decoded
 * here, then handed over by digest, so the simulation knows the copies
 * (`ctx.scatter`) and builds the colliders of those that collide, as it
 * gets the tiles' heights (`terrain-tiles.ts`). The simulation never touches
 * the network. A block layer's copies travel in its chunks.
 *
 * The start scenes' blobs are read before the game starts (their copies are
 * there on its first step); a scene loaded later brings its own.
 */
import { scatterCellOfBlob, storedScatterRules, type ScatterCell, type TerrainComponent, type TerrainScatterData } from '@thirdlight/runtime';

export class PageScatterBlobs {
  private readonly cells = new Map<string, ScatterCell>();
  private readonly reading = new Map<string, Promise<void>>();
  private readonly listeners = new Set<(data: TerrainScatterData) => void>();

  constructor(private readonly read: ((digest: string) => Promise<ArrayBuffer>) | null) {}

  /** Read the scatter blobs of the terrains of `entities` that have stored scatter rules. */
  async preload(entities: readonly { readonly components?: unknown }[]): Promise<void> {
    const read = this.read;
    if (read === null) return;
    const work: Promise<void>[] = [];
    for (const e of entities) {
      const c = (e.components as { terrain?: TerrainComponent } | undefined)?.terrain;
      if (c === undefined || storedScatterRules(c.scatter).length === 0) continue;
      for (const t of c.tiles) {
        const digest = t.scatter;
        if (digest === undefined || this.cells.has(digest)) continue;
        let p = this.reading.get(digest);
        if (p === undefined) {
          p = read(digest).then(
            (bytes) => {
              const cell = scatterCellOfBlob(new Uint8Array(bytes));
              this.cells.set(digest, cell);
              for (const l of this.listeners) l({ digest, scatter: cell });
            },
            (e: unknown) => console.warn(`terrain scatter ${digest.slice(0, 12)}…: ${e instanceof Error ? e.message : String(e)}`),
          );
          this.reading.set(digest, p);
        }
        work.push(p);
      }
    }
    await Promise.all(work);
  }

  /** Hand the decoded blobs to a simulation: those decoded now, and each one as it is; returns the stop. */
  feed(add: (data: readonly TerrainScatterData[]) => void): () => void {
    const now = [...this.cells].map(([digest, scatter]) => ({ digest, scatter }));
    if (now.length > 0) add(now);
    const l = (d: TerrainScatterData): void => add([d]);
    this.listeners.add(l);
    return () => void this.listeners.delete(l);
  }
}
