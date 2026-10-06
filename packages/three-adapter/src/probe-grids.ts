/**
 * The baked probe grids of the loaded scenes (Play, export and the editor's
 * Scene view).
 *
 * Each scene's bake may carry probe tiles (`lighting[sceneId].probes`); a
 * tile's artifact (a texture asset, see probe-artifact.ts) is read when its
 * scene is loaded, decoded to three's `LightProbeGrid` atlas and held in the
 * resource manager (kind `texture`, its GPU size counted) until the scene
 * goes. The decoded tiles stay on the CPU: the probe lighting
 * (probe-lighting.ts) packs every loaded tile into one 3D texture that every
 * lit material samples, and repacks it when the set changes (`onChange`).
 *
 * The artifact's bytes come from the host (`loadBytes`: the verified asset
 * reader in a game page, the session's asset bytes in the editor; it rejects
 * with the reason a file cannot be read).
 */
import type * as THREE from 'three';
import { probeCount, probeGridGpuBytes, type ProbeGridRecord, type ResourceManager } from '@thirdlight/runtime';

import { decodeProbeArtifact } from './probe-artifact';
import { ProbeLighting } from './probe-lighting';

/** A bake record as the adapter carries it (`LightingBake.probes`, structurally). */
export interface ProbeBakeLike {
  readonly grids: readonly ProbeGridRecord[];
}

export interface LoadedProbeTile {
  readonly sceneId: string;
  readonly grid: ProbeGridRecord;
  /** The tile's probes in three's `LightProbeGrid` atlas layout (RGBA half floats, see probe-artifact.ts). */
  readonly atlas: Uint16Array;
  /** Each probe's validity (PROBE_VALID, PROBE_MOVED or PROBE_FILLED). */
  readonly validity: Float32Array;
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
  /** Tiles the materials sample (packed into one texture), and loaded tiles that did not fit it. */
  readonly sampled?: number;
  readonly unplaced?: number;
}

export interface ProbeGridSet {
  /** Load the tiles of these scenes and let go of the others' (the loaded scene set changed). */
  follow(sceneIds: Iterable<string>): void;
  /** The loaded tiles. */
  tiles(): readonly LoadedProbeTile[];
  observe(): ProbeGridsObservation;
  dispose(): void;
}

type Decoded = { atlas: Uint16Array; validity: Float32Array };

/**
 * The probe tiles of `bakes` (sceneId → probes), loaded per scene into
 * `resources` (counted at their GPU size: the packed texture holds them).
 * `onChange`: the loaded tiles changed (one arrived, a scene's went).
 */
export function createProbeGridSet(
  bakes: Readonly<Record<string, ProbeBakeLike | undefined>>,
  loadBytes: (assetId: string) => Promise<Uint8Array>,
  resources: ResourceManager,
  onChange?: () => void,
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
    return { value: { atlas: decoded.atlas, validity: decoded.validity } as Decoded, bytes: probeGridGpuBytes(grid), free: () => undefined };
  };
  const drop = (sceneId: string): void => {
    const rec = followed.get(sceneId);
    if (rec === undefined) return;
    for (const g of bakes[sceneId]?.grids ?? []) resources.release('texture', `probes:${g.asset}`, holder);
    followed.delete(sceneId);
    if (rec.tiles.length > 0 && !disposed) onChange?.();
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
          resources.acquire<Decoded>('texture', `probes:${grid.asset}`, holder, load(grid)).then(
            (d) => {
              rec.pending--;
              if (disposed || followed.get(sceneId) !== rec) return;
              rec.tiles.push({ sceneId, grid, atlas: d.atlas, validity: d.validity });
              onChange?.();
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
    // In a fixed order (scene, then the record's tile order), whatever order they arrived in: where tiles
    // share a face, the sampling takes the first.
    tiles: () =>
      [...followed.entries()]
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .flatMap(([sceneId, r]) => {
          const order = bakes[sceneId]?.grids ?? [];
          return [...r.tiles].sort((a, b) => order.indexOf(a.grid) - order.indexOf(b.grid));
        }),
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
      disposed = true;
      for (const id of [...followed.keys()]) drop(id);
    },
  };
  return set;
}

/**
 * The adapter's probes: the loaded scenes' tiles and the probe light that
 * lights every material with them. The light is in the scene while any bake
 * has probes (its presence is part of every lit program: it comes and goes
 * with the bakes, not with each tile), and is repacked as tiles arrive and go.
 */
export interface ProbeLightingHost {
  /** The project's bakes changed (an editing host; a game's are fixed). */
  setBakes(bakes: Readonly<Record<string, { probes?: ProbeBakeLike } | undefined>> | null): void;
  /** Follow the realized scenes. */
  follow(sceneIds: Iterable<string>): void;
  /** The probe light (null while no bake has probes). */
  light(): ProbeLighting | null;
  observe(): ProbeGridsObservation | null;
  /** A frame was drawn (replaced textures can go). */
  frameDrawn(): void;
  dispose(): void;
}

export function createProbeLightingHost(scene: THREE.Scene, resources: ResourceManager, loadBytes: ((assetId: string) => Promise<Uint8Array>) | undefined, onChange?: () => void): ProbeLightingHost {
  let set: ProbeGridSet | null = null;
  let light: ProbeLighting | null = null;
  let following: string[] = [];
  const repack = (): void => {
    if (light === null || set === null) return;
    light.setTiles(set.tiles());
    onChange?.();
  };
  const host: ProbeLightingHost = {
    setBakes(bakes) {
      set?.dispose();
      set = null;
      const withProbes = bakes === null || loadBytes === undefined ? [] : Object.entries(bakes).filter(([, b]) => b?.probes !== undefined);
      if (withProbes.length === 0) {
        if (light !== null) {
          scene.remove(light);
          light.dispose();
          light = null;
        }
        return;
      }
      if (light === null) {
        light = new ProbeLighting();
        scene.add(light);
      }
      set = createProbeGridSet(Object.fromEntries(withProbes.map(([id, b]) => [id, b!.probes])), loadBytes!, resources, repack);
      light.setTiles([]);
      set.follow(following);
    },
    follow(sceneIds) {
      following = [...sceneIds];
      set?.follow(following);
    },
    light: () => light,
    observe() {
      if (set === null) return null;
      return { ...set.observe(), sampled: light?.count ?? 0, unplaced: light?.unplaced ?? 0 };
    },
    frameDrawn() {
      light?.frameDrawn();
    },
    dispose() {
      host.setBakes(null);
    },
  };
  return host;
}
