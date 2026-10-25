/**
 * Block layers' chunk colliders: the one flush loop that rebuilds them on
 * the physics port at the same flush points (cells written before the
 * physics phase collide in its sweep), batched into one remove and one add.
 */

/** The id of one chunk collider piece on the physics port. */
export function gridColliderId(entityId: string, ck: string, piece: number): string {
  return `${entityId}#blocks:${ck}:${piece}`;
}

/** What the flush reads of a loaded layer. */
export interface ChunkColliderLayer {
  readonly component: { readonly collision?: boolean; readonly metadataOnly?: boolean };
  /** The collider ids per chunk key (the flush keeps it). */
  readonly colliders: Map<string, string[]>;
}

/** The port's static collider calls the flush makes. */
interface StaticColliderPort<S> {
  addStaticColliders?(specs: readonly S[]): void;
  removeStaticColliders?(entityIds: readonly string[]): void;
}

/**
 * Rebuild the colliders of the dirty chunks: layers in id order, chunks in
 * key order (the same batch on every thread), one remove and one add. A
 * chunk's old colliders always go; `inRing` says whether a streamed layer's
 * chunk collides; `build` makes a chunk's specs (none: nothing to collide
 * with).
 */
export function flushChunkColliders<L extends ChunkColliderLayer, S extends { entityId: string }>(
  dirty: ReadonlyMap<string, ReadonlySet<string>>,
  layerOf: (entityId: string) => L | undefined,
  inRing: (entityId: string, ck: string) => boolean,
  build: (entityId: string, ck: string, layer: L) => S[],
  port: StaticColliderPort<S>,
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
