/**
 * The project's block layers in the Scene view: handed to the adapter's
 * block view (the same merged chunk meshes Play and exports draw), only the
 * chunks whose stored object changed after the first time, and kept so an
 * adapter made again gets them all. The instance brush paints on the same
 * layers.
 *
 * Browser-only (the scene adapter).
 */
import type { SceneAdapter } from '@thirdlight/three-adapter';
import type { BlockChunk, BlockLayerComponent, BlockRegion, BlockType } from '@thirdlight/project-model';
import { BrushBlockSurfaces } from './instance-brush';

export type BlockLayersInput = ReadonlyMap<string, { component: BlockLayerComponent; chunks: ReadonlyMap<string, BlockChunk>; origin: readonly number[]; regions?: readonly BlockRegion[]; hidden?: boolean }>;

export interface ViewportBlocksHost {
  readonly adapter: () => SceneAdapter;
  readonly requestRender: () => void;
}

export class ViewportBlocks {
  /** The block layers the instance brush paints on. */
  readonly surfaces = new BrushBlockSurfaces();
  /** The layers last handed over (a new adapter gets them again). */
  private input: { types: readonly BlockType[]; layers: BlockLayersInput; revision: number } | null = null;
  private revision = -1;
  /** The chunk objects each layer was last drawn from (edits hand over only the changed ones). */
  private readonly applied = new Map<string, { component: string; chunks: Map<string, BlockChunk> }>();

  constructor(private readonly host: ViewportBlocksHost) {}

  /** Whether the project's layers were handed over (the view then reports what it draws). */
  get handedOver(): boolean {
    return this.input !== null;
  }

  /** A new adapter: everything is handed over again. */
  adapterReplaced(): void {
    this.revision = -1;
    this.applied.clear();
    if (this.input !== null) this.set(this.input.types, this.input.layers, this.input.revision);
  }

  set(types: readonly BlockType[], layers: BlockLayersInput, revision: number): void {
    this.input = { types, layers, revision };
    const view = this.host.adapter().blockLayers?.();
    if (view === undefined) return;
    this.surfaces.update(types, layers, revision);
    if (revision !== this.revision) {
      this.revision = revision;
      view.setTypes(types);
      for (const id of view.layerIds()) {
        if (layers.has(id)) continue;
        view.removeLayer(id);
        this.applied.delete(id);
      }
      for (const [id, l] of layers) {
        // Only the chunks whose stored object changed are handed over (an edit re-meshes
        // the chunks it touched, not the layer; a previewed stroke's chunks then compare equal).
        // A layer with cut-aways is split by its regions: a region edit meshes it again.
        const key = JSON.stringify(l.component) + (l.component.cutaway !== undefined ? JSON.stringify(l.regions ?? []) : '');
        const prev = this.applied.get(id);
        if (prev === undefined || prev.component !== key || !view.layerPlacement(id)) view.setLayer(id, l.component, l.origin, { entityId: id, chunks: [...l.chunks.values()], ...(l.regions !== undefined && l.regions.length > 0 ? { regions: l.regions.map((r) => ({ regionId: r.regionId, boxes: r.boxes.map((b) => [...b]) })) } : {}) });
        else {
          const changed: { cx: number; cz: number; chunk: BlockChunk | null }[] = [];
          for (const [k, c] of l.chunks) if (prev.chunks.get(k) !== c) changed.push({ cx: c.cx, cz: c.cz, chunk: c });
          for (const k of prev.chunks.keys()) {
            if (l.chunks.has(k)) continue;
            const [cx, cz] = k.split(',').map(Number) as [number, number];
            changed.push({ cx, cz, chunk: null });
          }
          if (changed.length > 0) view.replaceChunks(id, changed);
          view.setOrigin(id, l.origin);
        }
        this.applied.set(id, { component: key, chunks: new Map(l.chunks) });
      }
    } else {
      for (const [id, l] of layers) view.setOrigin(id, l.origin);
    }
    // A hidden layer object (inactive) is not drawn.
    for (const [id, l] of layers) view.setHidden(id, l.hidden === true);
    this.host.requestRender();
  }
}
