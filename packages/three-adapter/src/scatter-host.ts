/**
 * The adapter's rule scatter: the stored copies' view (`scatter-view.ts`)
 * and ground cover's (`cover-view.ts`), and the one sink the block and
 * terrain views hand their sources to, which feeds both.
 */
import type * as THREE from 'three';
import type { WebGPURenderer } from 'three/webgpu';

import type { MeshWorkerPort } from './block-mesh-pool';
import { ImpostorStore } from './impostor';
import { CoverView } from './cover-view';
import type { LodTuning } from './lod-switch';
import { ScatterView, type ScatterSink } from './scatter-view';
import type { TerrainTile } from '@thirdlight/runtime';
import type { CullView } from './view-cull';
import type { ModelInstance } from './visual';

export interface ScatterHostDeps {
  template(assetId: string, piece: string | undefined, onReady: () => void): ModelInstance | null;
  dress(root: THREE.Object3D, assetId: string): (() => void) | null;
  read: ((digest: string) => Promise<ArrayBuffer>) | null;
  place(root: THREE.Object3D, shown: boolean): void;
  shapeChanged(): void;
  tile(digest: string): TerrainTile | undefined;
  /** Makes ground cover's worker. */
  worker?: () => MeshWorkerPort | null;
  /** Makes the worker the stored copies' sets are prepared on. */
  scatterWorker?: () => MeshWorkerPort | null;
  tuning: LodTuning;
  /** The page's renderer the models' impostors are baked with (absent or null: none yet). */
  renderer?: () => WebGPURenderer | null;
  changed(): void;
  /** False: no scatter is drawn (a diagnostic comparison). */
  drawn: boolean;
}

export interface ScatterHost {
  readonly stored: ScatterView;
  readonly cover: CoverView;
  /** What the block and terrain views tell (undefined: scatter not drawn). */
  readonly sink: ScatterSink | undefined;
  /** Put both views' figures on the adapter's diagnostics. */
  diagnostics(d: { scatter?: unknown; cover?: unknown }): void;
  dispose(): void;
}

export function createScatterHost(deps: ScatterHostDeps): ScatterHost {
  // The models' impostors (far copies), baked with the page's renderer when a rule first asks for one.
  const impostors = new ImpostorStore({ renderer: () => deps.renderer?.() ?? null, template: deps.template, dress: deps.dress });
  const stored = new ScatterView({ template: deps.template, dress: deps.dress, read: deps.read, place: deps.place, shapeChanged: deps.shapeChanged, tuning: deps.tuning, changed: deps.changed, impostors, ...(deps.scatterWorker !== undefined ? { worker: deps.scatterWorker } : {}) });
  const cover = new CoverView({ template: deps.template, dress: deps.dress, place: deps.place, tile: deps.tile, ...(deps.worker !== undefined ? { worker: deps.worker } : {}), tuning: deps.tuning, changed: deps.changed });
  const sink: ScatterSink | undefined = !deps.drawn
    ? undefined
    : {
        setBlockLayer: (id, c, o, chunks) => {
          const list = [...chunks];
          stored.setBlockLayer(id, c, o, list);
          cover.setBlockLayer(id, c, o, list);
        },
        replaceBlockChunks: (id, chunks) => {
          stored.replaceBlockChunks(id, chunks);
          cover.replaceBlockChunks(id, chunks);
        },
        setTerrain: (id, c, o) => {
          stored.setTerrain(id, c, o);
          cover.setTerrain(id, c, o);
        },
        setOrigin: (id, o) => {
          stored.setOrigin(id, o);
          cover.setOrigin(id, o);
        },
        setHidden: (id, h) => {
          stored.setHidden(id, h);
          cover.setHidden(id, h);
        },
        remove: (id) => {
          stored.remove(id);
          cover.remove(id);
        },
        setTypes: (types) => cover.setTypes(types),
        // Ground cover is never stored: only the stored copies have addresses scripts name.
        setCopyStates: (changes) => stored.setCopyStates(changes),
      };
  return {
    stored,
    cover,
    sink,
    diagnostics(d): void {
      if (stored.ids().length > 0) d.scatter = { ...stored.diagnostics(), impostors: impostors.diagnostics() };
      if (cover.ids().length > 0) d.cover = cover.diagnostics();
    },
    dispose(): void {
      stored.dispose();
      cover.dispose();
      impostors.dispose();
    },
  };
}

