/**
 * Block layers of scenes prepared ahead of their load.
 *
 * A game page prepares a scene before the simulation gets it (the game
 * host's scene preloader): until the preparation is done the scene reads as
 * loading, and a transition's fade stays out. A block layer that were meshed
 * only once its object arrived would show its chunks over the frames after
 * the scene read as loaded, popping in under a finished transition. So the
 * layers of a scene being prepared are meshed then (in the mesh workers,
 * under their own ids, not drawn), and the layer arriving builds its chunks
 * from those meshes in the frame it arrives in.
 *
 * A layer that streams is not prepared: it draws only the chunks round the
 * camera, which is not there yet, and meshes those as it arrives.
 */
import { BlockGrid, type BlockGridReader, type BlockLayerComponent, type BlockLayerData } from '@thirdlight/project-model';

import type { ChunkMeshResult, ChunkModelRef } from './block-chunk-mesh';
import type { MeshWorkerPool } from './block-mesh-pool';
import type { MeshWorkerReply } from './block-mesh-worker';

/**
 * A prepared layer's meshes are kept this long after its scene's preparation
 * was let go: a load lets go of it as the scene's status turns loaded, which
 * may come just before the frame that realizes the scene and takes them. Far
 * above a frame; a scene read ahead and dropped frees them soon after.
 */
export const PREPARED_KEEP_MS = 2000;

/** One prepared chunk (`again`: a model it shows was not there; it is meshed again once the layer arrives). */
export interface PreparedChunk {
  readonly result: ChunkMeshResult;
  readonly again: boolean;
}

/** What the block view gives its prepared layers. */
export interface PreparedBlockLayersHost {
  /** The layer is not prepared: nothing to draw, already drawn (an object kept loaded), or streamed. */
  skip(entityId: string, component: BlockLayerComponent): boolean;
  /** A layer's cells as its kits show them with the current block types; the models its palette shows are asked for. */
  viewOf(grid: BlockGrid, component: BlockLayerComponent): BlockGridReader;
  /** The mesh workers, started on first use (null: none, chunks mesh on the page). */
  pool(): MeshWorkerPool | null;
  /** Mesh a chunk on the page. */
  meshHere(view: BlockGridReader, component: BlockLayerComponent, cx: number, cz: number, uv: boolean, origin: readonly number[] | undefined): ChunkMeshResult;
  /** A model a worker did not have (sent to the workers once found). */
  modelMissing(ref: ChunkModelRef): void;
  /** Whether a layer's chunks get lightmap UVs. */
  uvFor(entityId: string): boolean;
  /** A new serial for a layer's copy in the workers. */
  serial(): number;
  /** Chunks are about to wait on the workers (the stall clock starts if none did). */
  waitStarts(): void;
  now(): number;
}

interface PreparedLayer {
  readonly id: string;
  /** What it was meshed from (a layer arriving with other cells or settings is meshed as usual). */
  readonly key: string;
  /** Its copy in the workers. */
  readonly serial: number;
  readonly component: BlockLayerComponent;
  readonly view: BlockGridReader;
  readonly origin: readonly number[];
  readonly uv: boolean;
  readonly results: Map<string, PreparedChunk>;
  /** Chunks still being meshed. */
  readonly waiting: Set<string>;
  done: () => void;
  /** When its scene's preparation was let go (null: held). */
  releasedAt: number | null;
}

/** A prepared layer's id in the workers (never an object id: those use the id syntax). */
const prepId = (id: string): string => `\u0000${id}`;

/**
 * What a layer's meshes depend on besides the block types: its settings, and
 * its cells by their chunk count. The scene the simulation attaches is the
 * one the page read and prepared, so this is a guard, not a comparison of
 * every cell (a large layer's cells would cost the arriving frame).
 */
function preparedKey(component: BlockLayerComponent, data: BlockLayerData | null): string {
  return `${JSON.stringify({ ...component, data: undefined })}|${data?.chunks?.length ?? 0}`;
}

/** Material rules read world positions: a layer with rules is meshed where it stands. */
const rulesOrigin = (component: BlockLayerComponent, origin: readonly number[]): readonly number[] | undefined => ((component.rules?.length ?? 0) > 0 ? origin : undefined);

export class PreparedBlockLayers {
  /** By object id. */
  private readonly layers = new Map<string, PreparedLayer>();

  constructor(private readonly host: PreparedBlockLayersHost) {}

  /**
   * Layers about to load (their objects as the scene's document has them):
   * their chunks meshed, not drawn. `ready` once every chunk is meshed;
   * `release` stops what is still meshing (the meshes made are kept
   * {@link PREPARED_KEEP_MS} for the scene arriving).
   */
  prepare(objects: readonly { readonly id: string; readonly component: BlockLayerComponent; readonly origin: readonly number[]; readonly data: BlockLayerData | null }[]): { readonly ready: Promise<void>; release(): void } {
    const mine: PreparedLayer[] = [];
    const waits: Promise<void>[] = [];
    for (const o of objects) {
      if (this.host.skip(o.id, o.component)) continue;
      this.forget(o.id);
      const grid = BlockGrid.from(o.component, o.data);
      const keys = [...grid.chunkKeys()];
      if (keys.length === 0) continue;
      const p: PreparedLayer = { id: o.id, key: preparedKey(o.component, o.data), serial: this.host.serial(), component: o.component, view: this.host.viewOf(grid, o.component), origin: [...o.origin], uv: this.host.uvFor(o.id), results: new Map(), waiting: new Set(keys), done: () => undefined, releasedAt: null };
      waits.push(new Promise<void>((resolve) => (p.done = resolve)));
      this.layers.set(o.id, p);
      mine.push(p);
      const pool = this.host.pool();
      if (pool === null) {
        this.meshHere(p);
        continue;
      }
      this.host.waitStarts();
      const origin = rulesOrigin(o.component, p.origin);
      pool.broadcast({ t: 'layer', entityId: prepId(o.id), serial: p.serial, component: o.component, data: o.data });
      for (const ck of keys) {
        const [cx, cz] = ck.split(',').map(Number) as [number, number];
        pool.send({ t: 'mesh', entityId: prepId(o.id), serial: p.serial, cx, cz, gen: 1, uv: p.uv, ...(origin !== undefined ? { origin } : {}) });
      }
    }
    return {
      ready: Promise.all(waits).then(() => undefined),
      release: () => {
        for (const p of mine) {
          if (p.releasedAt !== null) continue;
          p.releasedAt = this.host.now();
          this.stop(p);
        }
      },
    };
  }

  /** A worker's chunk for a prepared layer: true when it was one (kept, or dropped as no longer wanted). */
  reply(r: MeshWorkerReply): boolean {
    if (!r.entityId.startsWith('\u0000')) return false;
    const p = this.layers.get(r.entityId.slice(1));
    const ck = `${r.cx},${r.cz}`;
    if (p === undefined || p.serial !== r.serial || !p.waiting.delete(ck)) return true;
    for (const ref of r.result.missing) this.host.modelMissing(ref);
    p.results.set(ck, { result: r.result, again: r.result.missing.length > 0 });
    if (p.waiting.size === 0) this.stop(p);
    return true;
  }

  /** Chunks waiting on the workers. */
  waiting(): number {
    let n = 0;
    for (const p of this.layers.values()) n += p.waiting.size;
    return n;
  }

  /** The workers failed: what they were meshing is meshed on the page. */
  workersFailed(): void {
    for (const p of this.layers.values()) if (p.waiting.size > 0) this.meshHere(p);
  }

  /** Let go of the meshes of preparations let go more than {@link PREPARED_KEEP_MS} ago. */
  expire(): void {
    const now = this.host.now();
    for (const [id, p] of [...this.layers]) if (p.releasedAt !== null && now - p.releasedAt > PREPARED_KEEP_MS) this.forget(id);
  }

  /** Let go of prepared layers (one, or every one: the block types changed, the view goes). */
  forget(id?: string): void {
    for (const [k, p] of [...this.layers]) {
      if (id !== undefined && k !== id) continue;
      this.stop(p);
      this.layers.delete(k);
    }
  }

  /**
   * A layer arrived: the chunks its preparation meshed, if they were meshed
   * as it is now (its settings and cells, lightmap UVs, and where it stands
   * when it has material rules); the preparation is let go either way.
   */
  take(entityId: string, component: BlockLayerComponent, data: BlockLayerData | null, origin: readonly number[]): ReadonlyMap<string, PreparedChunk> {
    const p = this.layers.get(entityId);
    if (p === undefined) return new Map();
    this.forget(entityId);
    if (p.key !== preparedKey(component, data) || p.uv !== this.host.uvFor(entityId)) return new Map();
    const at = rulesOrigin(component, origin);
    if (at !== undefined && (p.origin[0] !== at[0] || p.origin[1] !== at[1] || p.origin[2] !== at[2])) return new Map();
    return p.results;
  }

  private meshHere(p: PreparedLayer): void {
    for (const ck of p.waiting) {
      const [cx, cz] = ck.split(',').map(Number) as [number, number];
      const result = this.host.meshHere(p.view, p.component, cx, cz, p.uv, rulesOrigin(p.component, p.origin));
      p.results.set(ck, { result, again: result.missing.length > 0 });
    }
    this.stop(p);
  }

  /** A prepared layer meshes no more: its copy in the workers goes and its preparation is done. */
  private stop(p: PreparedLayer): void {
    p.waiting.clear();
    this.host.pool()?.broadcast({ t: 'drop', entityId: prepId(p.id) });
    p.done();
  }
}
