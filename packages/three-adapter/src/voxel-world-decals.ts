/**
 * What a scene's voxel worlds take from its decals: the decal layers each
 * world's `voxelWorld` object puts it in, and the scene's clipped decals,
 * told of the worlds' chunk surfaces.
 *
 * The worlds' draws hang under the scene outside the render graph (one
 * object a chunk, replaced by the stream; voxel-world-draws.ts), so the
 * adapter that realizes the scene's objects keeps this link on the scene
 * and the draws read it when a world's view is made. The same path serves
 * the editor's Scene view, Play and an exported game: each draws through a
 * scene adapter.
 *
 * A world named by several objects takes the first one's layers, as it
 * streams with the first one's settings (runtime voxel-worlds.ts).
 */
import { decalLayersField } from './projected-decals';
import type { VoxelDecalSurfaces } from './voxel-chunk-view';

export class VoxelWorldDecals {
  /** Objects naming each world, in arrival order, with the layers each sets. */
  private readonly byWorld = new Map<string, { id: string; layers: number | undefined }[]>();
  private readonly worldOf = new Map<string, string>();
  private readonly listeners = new Set<(world: string) => void>();

  /** `surfaces`: the scene's clipped decals (null: none, `?decals=off` or turned off). */
  constructor(readonly surfaces: VoxelDecalSurfaces | null) {}

  /** The decal layers world `world` is drawn in (undefined: every layer). */
  layersOf(world: string): number | undefined {
    return this.byWorld.get(world)?.[0]?.layers;
  }

  /** Call `fn` with a world whose layers changed; returns the unsubscribe. */
  onLayers(fn: (world: string) => void): () => void {
    this.listeners.add(fn);
    return () => void this.listeners.delete(fn);
  }

  /** Object `entityId` was realized with `components` (its `voxelWorld`, if any), or released (null). */
  set(entityId: string, components: unknown): void {
    const c = (components as { voxelWorld?: { world?: unknown; decalLayers?: unknown } } | null)?.voxelWorld;
    const world = typeof c?.world === 'string' ? c.world : null;
    const layers = decalLayersField(c?.decalLayers);
    const was = this.worldOf.get(entityId);
    const before = new Map<string, number | undefined>();
    for (const w of [was, world]) if (w !== undefined && w !== null) before.set(w, this.layersOf(w));
    const list = was === undefined ? undefined : this.byWorld.get(was)!;
    const at = list?.findIndex((o) => o.id === entityId) ?? -1;
    if (was !== undefined && was === world) list![at]!.layers = layers;
    else {
      if (was !== undefined) {
        list!.splice(at, 1);
        if (list!.length === 0) this.byWorld.delete(was);
        this.worldOf.delete(entityId);
      }
      if (world !== null) {
        const into = this.byWorld.get(world);
        if (into === undefined) this.byWorld.set(world, [{ id: entityId, layers }]);
        else into.push({ id: entityId, layers });
        this.worldOf.set(entityId, world);
      }
    }
    for (const [w, l] of before) if (this.layersOf(w) !== l) for (const fn of this.listeners) fn(w);
  }
}

/** Each scene's link (kept by its scene adapter until disposed). */
const linked = new WeakMap<object, VoxelWorldDecals>();

/** Keep `link` on `scene` (null: take it off). */
export function attachVoxelWorldDecals(scene: object, link: VoxelWorldDecals | null): void {
  if (link === null) linked.delete(scene);
  else linked.set(scene, link);
}

/** The link kept on `scene` (null: none; its voxel worlds take every layer and no clipped decal). */
export function voxelWorldDecalsOf(scene: object): VoxelWorldDecals | null {
  return linked.get(scene) ?? null;
}
