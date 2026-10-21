/**
 * Block layers' chunk colliders: the one flush loop both dimensions
 * rebuild them with, and the 2D plane's colliders, each chunk's collision
 * shapes cut at the layer's play plane (`planeCollisionChunk`) and handed to
 * the 2D physics port, rebuilt with the chunk at the same flush points as the
 * 3D triangle meshes (cells written before the physics phase collide in its
 * sweep).
 *
 * A chunk's solid pieces are one compound collider (one body); its one-way
 * pieces are one collider each, since the port lands a character on a
 * one-way collider by that collider's own top.
 */
import { planeCollisionChunk, planeCutChunkRows, planeCutRow, type BlockGridReader, type BlockType } from '@thirdlight/project-model';

import type { PhysicsPort, StaticColliderSpec } from './ports';

/** The id of one chunk collider piece on the physics port. */
export function gridColliderId(entityId: string, ck: string, piece: number): string {
  return `${entityId}#blocks:${ck}:${piece}`;
}

/** What the flush reads of a loaded layer. */
export interface PlaneLayer {
  readonly shown: BlockGridReader;
  readonly origin: { readonly x: number; readonly y: number; readonly z: number };
  readonly component: { readonly collision?: boolean; readonly metadataOnly?: boolean; readonly planeZ?: number };
  /** The collider ids per chunk key (the flush keeps it). */
  readonly colliders: Map<string, string[]>;
}

/** One chunk's 2D colliders (none: the chunk holds nothing on the plane) and which of them are one-way. */
function chunkColliders(entityId: string, ck: string, layer: PlaneLayer, types: ReadonlyMap<string, BlockType>): { specs: StaticColliderSpec[]; oneWay: string[] } {
  const grid = layer.shown;
  const { localZ, row } = planeCutRow(grid.cellSize[2]!, layer.origin.z, layer.component.planeZ ?? 0);
  const [cx, cz] = ck.split(',').map(Number) as [number, number];
  const [from, to] = planeCutChunkRows(row, types);
  if (cz < from || cz > to || row < grid.min[2]! || row >= grid.max[2]!) return { specs: [], oneWay: [] };
  const cut = planeCollisionChunk(grid, cx, cz, types, localZ, row);
  const specs: StaticColliderSpec[] = [];
  const oneWay: string[] = [];
  const o = layer.origin;
  if (cut.solid.length > 0) {
    specs.push({ entityId: gridColliderId(entityId, ck, 0), shape: { type: 'compound', parts: cut.solid.map((p) => ({ shape: { type: 'polygon', vertices: p.vertices }, x: p.x, y: p.y, angle: 0 })) }, position: { x: o.x, y: o.y }, rotationZ: 0 });
  }
  cut.oneWay.forEach((p, i) => {
    const id = gridColliderId(entityId, ck, i + 1);
    oneWay.push(id);
    specs.push({ entityId: id, shape: { type: 'polygon', vertices: p.vertices }, position: { x: o.x + p.x, y: o.y + p.y }, rotationZ: 0, oneWay: true });
  });
  return { specs, oneWay };
}

/** The ports' static collider calls the flush makes (2D and 3D alike, each with its own spec). */
interface StaticColliderPort<S> {
  addStaticColliders?(specs: readonly S[]): void;
  removeStaticColliders?(entityIds: readonly string[]): void;
}

/**
 * Rebuild the colliders of the dirty chunks, in 3D and on the 2D plane
 * alike: layers in id order, chunks in key order (the same batch on every
 * thread), one remove and one add. A chunk's old colliders always go
 * (`forget` hears their ids); `inRing` says whether a streamed layer's chunk
 * collides; `build` makes a chunk's specs (none: nothing to collide with).
 */
export function flushChunkColliders<L extends Pick<PlaneLayer, 'component' | 'colliders'>, S extends { entityId: string }>(
  dirty: ReadonlyMap<string, ReadonlySet<string>>,
  layerOf: (entityId: string) => L | undefined,
  inRing: (entityId: string, ck: string) => boolean,
  build: (entityId: string, ck: string, layer: L) => S[],
  port: StaticColliderPort<S>,
  forget?: (ids: readonly string[]) => void,
): void {
  const remove: string[] = [];
  const add: S[] = [];
  for (const [entityId, keys] of [...dirty.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    const layer = layerOf(entityId);
    if (layer === undefined || layer.component.collision === false || layer.component.metadataOnly === true) continue;
    for (const ck of [...keys].sort()) {
      const old = layer.colliders.get(ck);
      if (old !== undefined) {
        remove.push(...old);
        forget?.(old);
        layer.colliders.delete(ck);
      }
      if (!inRing(entityId, ck)) continue;
      const specs = build(entityId, ck, layer);
      if (specs.length === 0) continue;
      layer.colliders.set(ck, specs.map((s) => s.entityId));
      add.push(...specs);
    }
  }
  if (remove.length > 0) port.removeStaticColliders?.(remove);
  if (add.length > 0) port.addStaticColliders?.(add);
}

/**
 * Rebuild the 2D colliders of the dirty chunks. `oneWay` is the set of
 * one-way collider ids the drop-through reads (kept here).
 */
export function flushPlaneColliders(
  dirty: ReadonlyMap<string, ReadonlySet<string>>,
  layerOf: (entityId: string) => PlaneLayer | undefined,
  types: ReadonlyMap<string, BlockType>,
  inRing: (entityId: string, ck: string) => boolean,
  oneWay: Set<string>,
  port: PhysicsPort,
): void {
  flushChunkColliders(
    dirty,
    layerOf,
    inRing,
    (entityId, ck, layer) => {
      const made = chunkColliders(entityId, ck, layer, types);
      for (const id of made.oneWay) oneWay.add(id);
      return made.specs;
    },
    port,
    (ids) => {
      for (const id of ids) oneWay.delete(id);
    },
  );
}
