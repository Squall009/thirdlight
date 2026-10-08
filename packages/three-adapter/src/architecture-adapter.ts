/**
 * The adapter's generated architecture wired to the rest of the adapter: the
 * object's materials (over the trim sheets its presets name) and their row
 * tables, kit models' templates, the static drawables and the cached
 * shadow, the generator workers, world streaming's arrival time, the style
 * and preset graphs, and the presets a script swapped (the simulation's
 * grid changes).
 */
import type * as THREE from 'three';
import { architecturePaintOf, architectureSheets, type ArchitectureGraphLike, type BlockLayerComponent, type BlockLayerData, type GridRenderChange } from '@thirdlight/runtime';

import { ArchitectureView, type ArchitectureChunkStore } from './architecture-view';
import { createBrowserMeshWorker } from './block-mesh-pool';
import type { MaterialLibrary } from './material-library';
import type { RenderGraph } from './render-graph';
import type { StaticShadowRevision } from './shadow-casters';
import type { ModelInstance } from './visual';

export interface AdapterArchitectureDeps {
  /** A realized object's components (the layer rooms are drawn on: its cells and wall paint). */
  components(entityId: string): object | undefined;
  /** The object's material mapping as worn now (its own with a script's swaps), and its graph materials' values. */
  effectiveMaterials(entityId: string, own: Readonly<Record<string, string>> | undefined): Readonly<Record<string, string>> | undefined;
  materialParams(components: unknown): Parameters<MaterialLibrary['apply']>[2];
  materialLibrary: MaterialLibrary | null;
  assetMaterials(assetId: string): Readonly<Record<string, string>> | undefined;
  template(assetId: string, piece: string | undefined, onReady: () => void): ModelInstance | null;
  read: ((digest: string) => Promise<ArrayBuffer>) | null;
  graph: Pick<RenderGraph, 'listStatic' | 'unlistStatic' | 'lodTuning'>;
  staticShadows: StaticShadowRevision | null;
  arrival: { left(): number; spent(ms: number): void } | null;
  meshWorkerUrl: string | undefined;
  store: ArchitectureChunkStore | null;
  styles: readonly ArchitectureGraphLike[] | undefined;
  drawn: boolean;
  changed(): void;
}

export interface AdapterArchitecture {
  readonly view: ArchitectureView;
  /** The simulation's grid changes without the architecture preset swaps (those were taken). */
  takeSwaps(changes: GridRenderChange[]): GridRenderChange[];
  dispose(): void;
}

export function createAdapterArchitecture(d: AdapterArchitectureDeps): AdapterArchitecture {
  const lib = d.materialLibrary;
  const mapping = (id: string, extra: Readonly<Record<string, string>>): Readonly<Record<string, string>> | undefined => {
    const own = d.effectiveMaterials(id, (d.components(id) as { materials?: Record<string, string> } | undefined)?.materials);
    return Object.keys(extra).length === 0 ? own : { ...extra, ...(own ?? {}) };
  };
  const view = new ArchitectureView({
    sheets: (id, c, extra) => architectureSheets(c, mapping(id, extra), (m) => lib?.trimSheetOf?.(m) ?? null),
    materials: (root: THREE.Object3D, id, extra) => {
      const m = mapping(id, extra);
      return lib !== null && m !== undefined ? lib.apply(root, m, d.materialParams(d.components(id))) : null;
    },
    template: d.template,
    dress: (root, assetId) => (lib !== null && Object.keys(d.assetMaterials(assetId) ?? {}).length > 0 ? lib.apply(root, d.assetMaterials(assetId)!, null) : null),
    read: d.read,
    place: (root, shown) => (shown ? d.graph.listStatic(root) : d.graph.unlistStatic(root)),
    shapeChanged: () => d.staticShadows?.bump(),
    changed: d.changed,
    ...(d.meshWorkerUrl !== undefined ? { worker: () => createBrowserMeshWorker(d.meshWorkerUrl!, 'thirdlight-architecture') } : {}),
    store: d.store,
    arrival: d.arrival,
    tuning: d.graph.lodTuning,
    drawn: d.drawn,
    styles: d.styles ?? null,
    // Rooms drawn on a block layer wear its wall paint (the layer object's cells ride on its component).
    paint: (layerId, origin) => {
      const c = d.components(layerId) as { blockLayer?: BlockLayerComponent & { data?: BlockLayerData }; transform?: { position?: number[] } } | undefined;
      return c?.blockLayer === undefined ? null : architecturePaintOf(c.blockLayer, c.blockLayer.data?.chunks ?? [], c.transform?.position ?? [0, 0, 0], origin);
    },
  });
  const stopDefinitions = lib?.onDefinitions?.(() => view.restyleAll());
  return {
    view,
    takeSwaps(changes) {
      if (!changes.some((c) => 'architecturePresets' in c)) return changes;
      const rest: GridRenderChange[] = [];
      for (const c of changes) {
        if ('architecturePresets' in c) view.setSwaps(c.architecturePresets);
        else rest.push(c);
      }
      return rest;
    },
    dispose() {
      stopDefinitions?.();
      view.dispose();
    },
  };
}
