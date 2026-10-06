/**
 * The baked probe grids of the loaded scenes (Play, export and the editor's
 * Scene view).
 *
 * Each scene's bake may carry probe tiles (`lighting[sceneId].probes`); a
 * tile's artifact (a texture asset, see probe-artifact.ts) is read when its
 * scene is loaded, decoded to three's `LightProbeGrid` atlas and held in the
 * resource manager (kind `texture`, its GPU size counted) until the scene
 * goes. Every tile becomes a `LightProbeGrid` light over its box, kept out of
 * the three.js scene: how materials sample the probes in place of the flat
 * ambient light is the materials' business (`tiles()`).
 *
 * The artifact's bytes come from the host (`loadBytes`: the verified asset
 * reader in a game page, the session's asset bytes in the editor; it rejects
 * with the reason a file cannot be read).
 */
import type * as THREE from 'three';
import type { LightProbeGrid } from 'three/examples/jsm/lighting/LightProbeGrid.js';
import { probeCount, probeGridGpuBytes, type ProbeGridRecord, type ResourceManager } from '@thirdlight/runtime';

import { decodeProbeArtifact, probeAtlasTexture, probeGridLight } from './probe-artifact';

/** A bake record as the adapter carries it (`LightingBake.probes`, structurally). */
export interface ProbeBakeLike {
  readonly grids: readonly ProbeGridRecord[];
}

export interface LoadedProbeTile {
  readonly sceneId: string;
  readonly grid: ProbeGridRecord;
  /** three's grid over the tile (not in any scene), its atlas as `texture`. */
  readonly light: LightProbeGrid;
}

export interface ProbeGridsObservation {
  /** Tiles of the loaded scenes, of those loaded, and their probes and GPU bytes; artifacts that failed to load. */
  readonly tiles: number;
  readonly loaded: number;
  readonly probes: number;
  readonly gpuBytes: number;
  readonly failed: number;
  /** Why the last failed load failed. */
  readonly error?: string;
}

export interface ProbeGridSet {
  /** Load the tiles of these scenes and let go of the others' (the loaded scene set changed). */
  follow(sceneIds: Iterable<string>): void;
  /** The loaded tiles. */
  tiles(): readonly LoadedProbeTile[];
  observe(): ProbeGridsObservation;
  dispose(): void;
}

type Atlas = { texture: THREE.Data3DTexture };

/** The probe tiles of `bakes` (sceneId → probes), loaded per scene into `resources`. `onLoaded`: a tile arrived. */
export function createProbeGridSet(
  bakes: Readonly<Record<string, ProbeBakeLike | undefined>>,
  loadBytes: (assetId: string) => Promise<Uint8Array>,
  resources: ResourceManager,
  onLoaded?: () => void,
): ProbeGridSet {
  const holder = 'probe-grids';
  const followed = new Map<string, { tiles: LoadedProbeTile[]; pending: number }>();
  let failed = 0;
  let error: string | undefined;
  let disposed = false;
  const load = (grid: ProbeGridRecord) => async () => {
    const bytes = await loadBytes(grid.asset);
    const decoded = decodeProbeArtifact(bytes, grid);
    if (!decoded.ok) throw new Error(decoded.message);
    const texture = probeAtlasTexture(decoded.atlas, grid.resolution);
    return { value: { texture } as Atlas, bytes: probeGridGpuBytes(grid), free: (a: Atlas) => a.texture.dispose() };
  };
  const drop = (sceneId: string): void => {
    const rec = followed.get(sceneId);
    if (rec === undefined) return;
    for (const t of rec.tiles) t.light.dispose();
    for (const g of bakes[sceneId]?.grids ?? []) resources.release('texture', `probes:${g.asset}`, holder);
    followed.delete(sceneId);
  };
  const set: ProbeGridSet = {
    follow(sceneIds) {
      if (disposed) return;
      const want = new Set([...sceneIds].filter((id) => (bakes[id]?.grids.length ?? 0) > 0));
      for (const id of [...followed.keys()]) if (!want.has(id)) drop(id);
      for (const sceneId of want) {
        if (followed.has(sceneId)) continue;
        const rec = { tiles: [] as LoadedProbeTile[], pending: 0 };
        followed.set(sceneId, rec);
        for (const grid of bakes[sceneId]!.grids) {
          rec.pending++;
          resources.acquire<Atlas>('texture', `probes:${grid.asset}`, holder, load(grid)).then(
            (atlas) => {
              rec.pending--;
              if (disposed || followed.get(sceneId) !== rec) return;
              rec.tiles.push({ sceneId, grid, light: probeGridLight(grid, atlas.texture) });
              onLoaded?.();
            },
            (e: unknown) => {
              rec.pending--;
              failed++;
              error = e instanceof Error ? e.message : String(e);
            },
          );
        }
      }
    },
    tiles: () => [...followed.values()].flatMap((r) => r.tiles),
    observe() {
      let tiles = 0;
      let loaded = 0;
      let probes = 0;
      let gpuBytes = 0;
      for (const [sceneId, rec] of followed) {
        tiles += bakes[sceneId]?.grids.length ?? 0;
        loaded += rec.tiles.length;
        for (const t of rec.tiles) {
          probes += probeCount(t.grid);
          gpuBytes += probeGridGpuBytes(t.grid);
        }
      }
      return { tiles, loaded, probes, gpuBytes, failed, ...(error !== undefined ? { error } : {}) };
    },
    dispose() {
      for (const id of [...followed.keys()]) drop(id);
      disposed = true;
    },
  };
  return set;
}
