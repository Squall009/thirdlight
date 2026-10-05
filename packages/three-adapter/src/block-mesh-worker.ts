/**
 * The block mesh worker: meshes block chunks off the page's main thread.
 *
 * It keeps a copy of what the page's block view meshes from — the block
 * types (with each variant's model resolved by the page, which knows the
 * prefabs), the models' geometry, and every layer's cells, kept current by
 * the same chunk replacements the view gets — and answers mesh requests with
 * the chunk's parts, their arrays handed over (transferred, not copied).
 *
 * Requests run one at a time, each in its own task, so messages that arrive
 * meanwhile (newer cells, a newer request for the same chunk) are read before
 * the next one: a request whose chunk was asked for again since is skipped.
 *
 * This module imports no three.js: the worker bundle stays small. The page
 * side is `block-mesh-pool.ts`.
 */
import { BlockGrid, type BlockChunk, type BlockLayerComponent, type BlockLayerData, type BlockType } from '@thirdlight/runtime';

import { chunkModelKey, chunkResultBuffers, meshChunkForDrawing, StandInShapes, type ChunkLooks, type ChunkMeshResult, type ChunkModelGeometry, type ChunkModelRef } from './block-chunk-mesh';

/** Page → worker. */
export type MeshWorkerRequest =
  /** The block types and, per type, each variant's model (null: a stand-in). */
  | { t: 'types'; types: BlockType[]; variantModels: [string, (ChunkModelRef | null)[]][] }
  /** A model's geometry (copied: the page keeps meshing with it too). */
  | { t: 'model'; key: string; geometry: ChunkModelGeometry }
  /** A layer's cells, whole (a new layer, or one replaced: `serial` names this version). */
  | { t: 'layer'; entityId: string; serial: number; component: BlockLayerComponent; data: BlockLayerData | null }
  /** Some chunks of a layer replaced (stored form; null empties one). */
  | { t: 'chunks'; entityId: string; chunks: { cx: number; cz: number; chunk: BlockChunk | null }[] }
  | { t: 'drop'; entityId: string }
  /** Mesh a chunk; `gen` is the page's generation of it (a later request or `cancel` supersedes it). */
  | { t: 'mesh'; entityId: string; serial: number; cx: number; cz: number; gen: number; uv: boolean }
  /** The chunk was meshed elsewhere since (on the page): requests up to `gen` are not wanted. */
  | { t: 'cancel'; entityId: string; cx: number; cz: number; gen: number };

/** Worker → page. */
export type MeshWorkerReply = { t: 'meshed'; entityId: string; serial: number; cx: number; cz: number; gen: number; ms: number; result: ChunkMeshResult };

/** Either end of the channel (a dedicated worker's global, or a worker on the page). */
export interface MeshEndpoint {
  post(message: unknown, transfer?: readonly ArrayBuffer[]): void;
  listen(onMessage: (message: unknown) => void): void;
}

/** Inside a dedicated worker: its global scope as the endpoint. */
export function meshWorkerGlobalEndpoint(): MeshEndpoint {
  const self = globalThis as unknown as { postMessage(m: unknown, t?: unknown[]): void; addEventListener(type: string, l: (e: { data: unknown }) => void): void };
  return {
    post: (message, transfer) => self.postMessage(message, transfer === undefined ? undefined : [...transfer]),
    listen: (onMessage) => self.addEventListener('message', (e) => onMessage(e.data)),
  };
}

interface WorkerLayer {
  serial: number;
  component: BlockLayerComponent;
  grid: BlockGrid;
}

/** Run the mesh worker on an endpoint (the worker's global scope); `stop` ends it (a worker on the page, in tests). */
export function runBlockMeshWorker(endpoint: MeshEndpoint): { stop(): void; tracked(): number } {
  let types = new Map<string, BlockType>();
  let variantModels = new Map<string, (ChunkModelRef | null)[]>();
  const models = new Map<string, ChunkModelGeometry>();
  const layers = new Map<string, WorkerLayer>();
  const standIns = new StandInShapes();
  /** The newest generation asked for (or cancelled) per chunk. */
  const latest = new Map<string, number>();
  const queue: Extract<MeshWorkerRequest, { t: 'mesh' }>[] = [];
  const looks: ChunkLooks = {
    variantModel: (type, variant) => {
      const table = variantModels.get(type.blockId);
      if (table === undefined || table.length === 0) return null;
      // Out of range reads variant 0, as the page's lookup does.
      return (variant < table.length ? table[variant] : table[0]) ?? null;
    },
    model: (ref) => models.get(chunkModelKey(ref)) ?? null,
  };
  const chunkId = (entityId: string, cx: number, cz: number): string => `${entityId}\u0000${cx},${cz}`;

  // One request per task: a message channel to itself (timers are throttled when they nest).
  const tick = new MessageChannel();
  let scheduled = false;
  const schedule = (): void => {
    if (scheduled || queue.length === 0) return;
    scheduled = true;
    tick.port2.postMessage(null);
  };
  tick.port1.onmessage = () => {
    scheduled = false;
    const req = queue.shift();
    if (req !== undefined) meshOne(req);
    schedule();
  };

  const meshOne = (req: Extract<MeshWorkerRequest, { t: 'mesh' }>): void => {
    if ((latest.get(chunkId(req.entityId, req.cx, req.cz)) ?? -1) > req.gen) return;
    const layer = layers.get(req.entityId);
    if (layer === undefined || layer.serial !== req.serial) return;
    const t0 = performance.now();
    const result = meshChunkForDrawing(layer.grid, layer.component, types, looks, standIns, { cx: req.cx, cz: req.cz, uv: req.uv });
    const reply: MeshWorkerReply = { t: 'meshed', entityId: req.entityId, serial: req.serial, cx: req.cx, cz: req.cz, gen: req.gen, ms: performance.now() - t0, result };
    endpoint.post(reply, chunkResultBuffers(result));
  };

  endpoint.listen((raw) => {
    const m = raw as MeshWorkerRequest;
    switch (m.t) {
      case 'types':
        types = new Map(m.types.map((t) => [t.blockId, t]));
        variantModels = new Map(m.variantModels);
        break;
      case 'model':
        models.set(m.key, m.geometry);
        break;
      case 'layer':
        layers.set(m.entityId, { serial: m.serial, component: m.component, grid: BlockGrid.from(m.component, m.data) });
        break;
      case 'chunks': {
        const layer = layers.get(m.entityId);
        if (layer === undefined) break;
        for (const c of m.chunks) layer.grid.replaceChunk(c.cx, c.cz, c.chunk);
        // The page's view tracks what to re-mesh; here the grid only has to be current.
        layer.grid.takeDirty();
        break;
      }
      case 'drop': {
        layers.delete(m.entityId);
        // Its chunks' generations and queued requests go with it (a layer dropped is never asked for again).
        const prefix = `${m.entityId}\u0000`;
        for (const k of [...latest.keys()]) if (k.startsWith(prefix)) latest.delete(k);
        for (let i = queue.length - 1; i >= 0; i--) if (queue[i]!.entityId === m.entityId) queue.splice(i, 1);
        break;
      }
      case 'mesh':
        latest.set(chunkId(m.entityId, m.cx, m.cz), m.gen);
        queue.push(m);
        schedule();
        break;
      case 'cancel': {
        const id = chunkId(m.entityId, m.cx, m.cz);
        latest.set(id, Math.max(latest.get(id) ?? -1, m.gen + 1));
        break;
      }
    }
  });
  return {
    stop: () => {
      queue.length = 0;
      tick.port1.close();
      tick.port2.close();
    },
    // The chunks whose newest generation it keeps (bounded by the layers it holds).
    tracked: () => latest.size,
  };
}
