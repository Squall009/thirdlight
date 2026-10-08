/**
 * The page side of the terrains' stored scatter for the simulation: each
 * tile's scatter blob (`TerrainTileRef.scatter`) read, verified and decoded
 * here, then handed over by digest, so the simulation knows the copies
 * (`ctx.scatter`) and builds the colliders of those that collide, as it
 * gets the tiles' heights (`terrain-tiles.ts`). The simulation never touches
 * the network. A block layer's copies travel in its chunks.
 *
 * Splines' made data (`SplineComponent.data`: their meshes and pieces'
 * copies) travel the same way, for their colliders.
 *
 * The start scenes' blobs are read before the game starts (their copies are
 * there on its first step); a scene loaded later brings its own.
 */
import { decodeSplineMade, scatterCellOfBlob, storedScatterRules, type ScatterCell, type SplineComponent, type SplineMade, type TerrainComponent, type TerrainSimData } from '@thirdlight/runtime';

type BlobData = Exclude<TerrainSimData, { heights: Uint16Array } | { dropped: true }>;

export class PageScatterBlobs {
  private readonly cells = new Map<string, ScatterCell | SplineMade>();
  private readonly reading = new Map<string, Promise<void>>();
  private readonly listeners = new Set<(data: BlobData) => void>();

  constructor(private readonly read: ((digest: string) => Promise<ArrayBuffer>) | null) {}

  /** Read the scatter blobs of the terrains of `entities` that have stored scatter rules, and their splines' made data. */
  async preload(entities: readonly { readonly components?: unknown }[]): Promise<void> {
    const read = this.read;
    if (read === null) return;
    const work: Promise<void>[] = [];
    const want = (digest: string, what: string, decode: (bytes: Uint8Array) => BlobData): void => {
      if (this.cells.has(digest)) return;
      let p = this.reading.get(digest);
      if (p === undefined) {
        p = read(digest).then(
          (bytes) => {
            const d = decode(new Uint8Array(bytes));
            this.cells.set(digest, 'scatter' in d ? d.scatter : d.spline);
            for (const l of this.listeners) l(d);
          },
          (e: unknown) => console.warn(`${what} ${digest.slice(0, 12)}…: ${e instanceof Error ? e.message : String(e)}`),
        );
        this.reading.set(digest, p);
      }
      work.push(p);
    };
    for (const e of entities) {
      const comps = e.components as { terrain?: TerrainComponent; spline?: SplineComponent } | undefined;
      const c = comps?.terrain;
      if (c !== undefined && storedScatterRules(c.scatter).length > 0) {
        for (const t of c.tiles) if (t.scatter !== undefined) want(t.scatter, 'terrain scatter', (b) => ({ digest: t.scatter!, scatter: scatterCellOfBlob(b) }));
      }
      const data = comps?.spline?.data;
      if (data !== undefined) want(data, 'spline', (b) => ({ digest: data, spline: decodeSplineMade(b) }));
    }
    await Promise.all(work);
  }

  /** Hand the decoded blobs to a simulation: those decoded now, and each one as it is; returns the stop. */
  feed(add: (data: readonly BlobData[]) => void): () => void {
    const now = [...this.cells].map(([digest, d]): BlobData => (d instanceof Map ? { digest, scatter: d } : { digest, spline: d }));
    if (now.length > 0) add(now);
    const l = (d: BlobData): void => add([d]);
    this.listeners.add(l);
    return () => void this.listeners.delete(l);
  }
}
