/**
 * The page's decoded terrain tiles, one copy of each by digest, shared by
 * the renderer (which packs them into its texture arrays), the page's
 * terrain queries and picking (`TerrainField`), and the simulation's
 * colliders and surface queries (handed the same objects when it runs on
 * the page; their heights, holes, layer weights and paint copied to its
 * worker otherwise).
 *
 * A tile is read by digest (the build's buffers, the editor's content
 * route), then inflated, decoded and — for drawing — packed into its texels
 * on a worker (`terrain-pack-worker.ts`, in the view's worker script), so a
 * large tile never holds a frame; with no worker it is done on the page.
 * Texels are not kept here: a request hands them to its caller, except those
 * packed ahead at a game's start (`preload`), held until the renderer takes
 * them.
 */
import { terrainOverviewOf, terrainTileBytes, terrainTileOf, type TerrainComponent, type TerrainOverviewTile, type TerrainTile } from '@thirdlight/runtime';

import type { MeshWorkerPort } from './block-mesh-pool';
import { packTerrainTile, type TerrainPackReply, type TerrainPackRequest, type TerrainPackShape, type TerrainTexels } from './terrain-pack-worker';
import { metresPerStep } from './terrain-texels';

/** A decoded tile and, packed for drawing, its texels. */
export interface PackedTerrainTile {
  readonly tile: TerrainTile;
  readonly texels: TerrainTexels;
  /** Milliseconds the decode and the packing took (on the worker, or the page without one). */
  readonly decodeMs: number;
  readonly packMs: number;
}

export interface TerrainTileStoreOptions {
  /** A tile blob's bytes by digest (null: tiles with data cannot be read). */
  readonly read: ((digest: string) => Promise<ArrayBuffer>) | null;
  /** Makes the worker (null or absent, or it fails: decoded and packed on the page). */
  readonly worker?: (() => MeshWorkerPort | null) | null;
}

const shapeKey = (digest: string, s: TerrainPackShape): string => `${digest}|${s.metresPerStep}|${s.spacing}`;

/** What a terrain's tiles are packed for. */
export const terrainPackShape = (c: Pick<TerrainComponent, 'heightRange' | 'spacing'>): TerrainPackShape => ({ metresPerStep: metresPerStep(c.heightRange), spacing: c.spacing });

export class TerrainTileStore {
  private readonly o: TerrainTileStoreOptions;
  private readonly decodedTiles = new Map<string, TerrainTile>();
  private readonly decoding = new Map<string, Promise<TerrainTile>>();
  /** Texels packed ahead (a game's start) until the renderer takes them. */
  private readonly ahead = new Map<string, Promise<PackedTerrainTile>>();
  private readonly listeners = new Set<(digest: string, tile: TerrainTile) => void>();
  private readonly releaseListeners = new Set<(digest: string) => void>();
  private readonly overviews = new Map<string, Promise<TerrainOverviewTile[]>>();
  private worker: MeshWorkerPort | null | undefined = undefined;
  private readonly jobs = new Map<number, (r: TerrainPackReply) => void>();
  private serial = 0;
  private disposed = false;

  constructor(o: TerrainTileStoreOptions) {
    this.o = o;
  }

  /** Whether tiles with data can be read here. */
  get reads(): boolean {
    return this.o.read !== null;
  }

  /** The decoded tile of a digest, once read. */
  tile(digest: string): TerrainTile | undefined {
    return this.decodedTiles.get(digest);
  }

  /** Every decoded tile by digest. */
  tiles(): ReadonlyMap<string, TerrainTile> {
    return this.decodedTiles;
  }

  /** Called with every tile decoded from now on (the simulation's colliders). */
  onTile(listener: (digest: string, tile: TerrainTile) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Called with every tile let go from now on (the simulation lets go of its copy too). */
  onRelease(listener: (digest: string) => void): () => void {
    this.releaseListeners.add(listener);
    return () => this.releaseListeners.delete(listener);
  }

  /** A streamed terrain's overview (every tile at its coarsest level), read and decoded on the page (it is small). */
  overview(digest: string): Promise<TerrainOverviewTile[]> {
    let p = this.overviews.get(digest);
    if (p === undefined) {
      const read = this.o.read;
      p = read === null ? Promise.reject(new Error('an overview cannot be read here')) : read(digest).then(terrainOverviewOf);
      // Read once (a terrain realized again, the start's preload): a few kilobytes a tile, kept.
      this.overviews.set(digest, p);
      p.catch(() => this.overviews.delete(digest));
    }
    return p;
  }

  /** What the decoded tiles take in memory. */
  memory(): { tiles: number; bytes: number } {
    let bytes = 0;
    for (const t of this.decodedTiles.values()) bytes += terrainTileBytes(t);
    return { tiles: this.decodedTiles.size, bytes };
  }

  /** A tile decoded (once: later calls share it). */
  decoded(digest: string): Promise<TerrainTile> {
    const have = this.decodedTiles.get(digest);
    if (have !== undefined) return Promise.resolve(have);
    let p = this.decoding.get(digest);
    if (p === undefined) {
      p = this.job(digest, null).then((r) => r.tile);
      this.decoding.set(digest, p);
      p.finally(() => this.decoding.delete(digest)).catch(() => undefined);
    }
    return p;
  }

  /** A tile decoded and packed for drawing with `shape` (packed ahead at the start: those texels). */
  packed(digest: string, shape: TerrainPackShape): Promise<PackedTerrainTile> {
    const key = shapeKey(digest, shape);
    const ahead = this.ahead.get(key);
    if (ahead !== undefined) {
      this.ahead.delete(key);
      return ahead;
    }
    return this.job(digest, shape) as Promise<PackedTerrainTile>;
  }

  /**
   * Read a terrain's tiles before a game starts (its colliders need them
   * before the first step); `pack` also packs them for drawing, held until
   * the renderer asks, and reads a streamed terrain's overview. `only`: the
   * tiles to read (a streamed terrain's near the start; absent: all).
   */
  async preload(component: TerrainComponent, pack: boolean, only?: (x: number, z: number) => boolean): Promise<void> {
    const shape = pack ? terrainPackShape(component) : null;
    const digests = [...new Set(component.tiles.flatMap((t) => (t.data !== undefined && (only === undefined || only(t.x, t.z)) ? [t.data] : [])))];
    await Promise.all(
      [...(pack && component.overview !== undefined ? [this.overview(component.overview)] : []), ...digests.map((d) => {
        if (shape === null) return this.decoded(d);
        const key = shapeKey(d, shape);
        let p = this.ahead.get(key);
        if (p === undefined) {
          p = this.job(d, shape) as Promise<PackedTerrainTile>;
          this.ahead.set(key, p);
        }
        return p;
      })],
    );
  }

  /** Forget a decoded tile no terrain draws any more. */
  release(digest: string): void {
    if (!this.decodedTiles.delete(digest)) return;
    for (const l of this.releaseListeners) l(digest);
  }

  dispose(): void {
    this.disposed = true;
    this.worker?.terminate();
    this.worker = null;
    for (const done of this.jobs.values()) done({ t: 'terrainPacked', id: -1, ok: false, message: 'the terrain tiles were let go' });
    this.jobs.clear();
    this.ahead.clear();
    this.decodedTiles.clear();
    this.listeners.clear();
    this.releaseListeners.clear();
    this.overviews.clear();
  }

  // ---- jobs ------------------------------------------------------------------------------

  private async job(digest: string, shape: TerrainPackShape | null): Promise<{ tile: TerrainTile; texels: TerrainTexels | null; decodeMs: number; packMs: number }> {
    const read = this.o.read;
    if (read === null) throw new Error('tiles with data cannot be read here');
    const blob = await read(digest);
    if (this.disposed) throw new Error('the terrain tiles were let go');
    const w = this.workerNow();
    let r: { tile: TerrainTile; texels: TerrainTexels | null; decodeMs: number; packMs: number };
    // The worker takes its own copy (the reader may keep these bytes, and the page needs them if the worker fails).
    const reply = w === null ? null : await this.ask(w, blob.slice(0), shape);
    if (this.disposed) throw new Error('the terrain tiles were let go');
    if (reply !== null && reply.ok) r = reply;
    else if (reply !== null && this.worker !== null) throw new Error(reply.message);
    else {
      const t0 = performance.now();
      const tile = await terrainTileOf(blob);
      const t1 = performance.now();
      const texels = shape === null ? null : packTerrainTile(tile, shape);
      r = { tile, texels, decodeMs: t1 - t0, packMs: performance.now() - t1 };
    }
    // One decoded copy per digest: a tile decoded again (to pack it) gives way to the one held.
    const held = this.decodedTiles.get(digest);
    if (held !== undefined) return { ...r, tile: held };
    this.decodedTiles.set(digest, r.tile);
    for (const l of this.listeners) l(digest, r.tile);
    return r;
  }

  private ask(w: MeshWorkerPort, blob: ArrayBuffer, shape: TerrainPackShape | null): Promise<TerrainPackReply> {
    const id = ++this.serial;
    return new Promise((done) => {
      this.jobs.set(id, done);
      const req: TerrainPackRequest = { t: 'terrainPack', id, blob, shape };
      w.post(req, [blob]);
    });
  }

  /** The worker (started on first use; null when none can run here). */
  private workerNow(): MeshWorkerPort | null {
    if (this.worker !== undefined) return this.worker;
    const make = this.o.worker;
    const w = make === undefined || make === null ? null : make();
    this.worker = w;
    if (w === null) return null;
    w.listen((raw) => {
      const m = raw as Partial<TerrainPackReply> | null;
      if (m?.t !== 'terrainPacked' || typeof m.id !== 'number') return;
      const done = this.jobs.get(m.id);
      this.jobs.delete(m.id);
      done?.(m as TerrainPackReply);
    });
    w.onError((message) => {
      // The worker cannot run: its jobs are done on the page instead, and later ones too.
      this.worker = null;
      w.terminate();
      for (const done of [...this.jobs.values()]) done({ t: 'terrainPacked', id: -1, ok: false, message: `the terrain worker failed (${message})` });
      this.jobs.clear();
    });
    return w;
  }
}
