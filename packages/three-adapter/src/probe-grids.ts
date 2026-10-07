/**
 * The baked probe grids of the loaded scenes (Play, export and the editor's
 * Scene view).
 *
 * Each scene's bake may carry probe tiles (`lighting[sceneId].probes`); a
 * tile's artifact (a texture asset, see probe-artifact.ts) is read when its
 * scene is loaded, decoded to three's `LightProbeGrid` atlas and held in the
 * resource manager (kind `texture`, its GPU size counted) until the scene
 * goes. Only the tiles near the camera are loaded (probe-residency.ts); each
 * is packed for the GPU as it is decoded and uploaded into its own region of
 * the one 3D texture every lit material samples (probe-atlas.ts).
 *
 * The artifact's bytes come from the host (`loadBytes`: the verified asset
 * reader in a game page, the session's asset bytes in the editor; it rejects
 * with the reason a file cannot be read).
 */
import type * as THREE from 'three';
import { probeCount, probeGridGpuBytes, type ProbeGridRecord, type ResourceManager } from '@thirdlight/runtime';

import { decodeProbeSamples } from './probe-artifact';
import { PROBE_PACK_MAX_EDGE, type ProbeTileForGpu, type ProbeUploadRenderer } from './probe-atlas';
import { ProbeLighting } from './probe-lighting';
import { packedProbeDepth, packProbeTile, PROBE_TEXEL_BYTES, type PackedProbeTile } from './probe-pack';
import { PROBE_ATLAS_SLACK, PROBE_RESIDENT_BYTES, pickResidentProbeTiles } from './probe-residency';

/** A bake record as the adapter carries it (`LightingBake.probes`, structurally). */
export interface ProbeBakeLike {
  readonly grids: readonly ProbeGridRecord[];
  /** When it was baked: a bake again in the editor publishes its tiles under the same asset ids. */
  readonly createdAt?: string;
}

/**
 * A tile's resource key: its file, the bake that wrote it and its probe count. A re-bake keeps the asset
 * ids (the files are replaced in place), so the file alone would hand back the old bake's decoded probes,
 * packed with the new tile's resolution.
 */
export function probeTileKey(grid: ProbeGridRecord, bake: ProbeBakeLike): string {
  return `probes:${grid.asset}@${bake.createdAt ?? ''}:${grid.resolution.join('x')}`;
}

/** A loaded tile: packed for the GPU (probe-pack.ts) as its file was decoded; its rank is its place in the table order. */
export interface LoadedProbeTile extends ProbeTileForGpu {
  readonly rank: number;
}

type Decoded = { packed: PackedProbeTile; validity: Float32Array };

/** A tile of the followed scenes, loaded or not. */
export interface ProbeTileEntry {
  readonly key: string;
  readonly sceneId: string;
  readonly grid: ProbeGridRecord;
  /** Table order: scene id, then the record's order (where tiles share a face the first wins). */
  readonly rank: number;
}

export interface ProbeGridsObservation {
  /** Tiles of the loaded scenes, of those loaded, and their probes and GPU bytes (as the bake counts them); artifacts that failed to load. */
  readonly tiles: number;
  readonly loaded: number;
  readonly probes: number;
  readonly gpuBytes: number;
  readonly failed: number;
  /** Why the last failed load failed. */
  readonly error?: string;
  /** Tiles kept resident (the nearest to the camera within the budget), and those left out by the budget (their surfaces get the flat ambient light). */
  readonly resident?: number;
  readonly beyondBudget?: number;
  /** The budget (bytes) and the bytes the probe textures take on the GPU (the packed texture as allocated, the table and the index). */
  readonly budgetBytes?: number;
  readonly textureBytes?: number;
  /** Tiles on the GPU the materials sample, and loaded tiles that did not fit the texture (0 unless its edge or budget is reached). */
  readonly sampled?: number;
  readonly unplaced?: number;
  /** The spatial index's cells and entries. */
  readonly indexCells?: number;
  readonly indexEntries?: number;
  /** Tiles uploaded so far, and their bytes (each arrival uploads only its own region). */
  readonly uploads?: number;
  readonly uploadedBytes?: number;
}

export interface ProbeGridSet {
  /** Load the tiles of these scenes (those wanted) and let go of the others' (the loaded scene set changed). */
  follow(sceneIds: Iterable<string>): void;
  /** The tiles of the followed scenes, in table order. */
  entries(): readonly ProbeTileEntry[];
  /** Hold only these tiles (keys; the residency's pick) and let go of the rest. Until called, every tile is wanted. */
  want(keys: ReadonlySet<string>): void;
  /** The keys wanted now. */
  wanted(): ReadonlySet<string>;
  /** The loaded wanted tiles, in table order. */
  tiles(): readonly LoadedProbeTile[];
  observe(): ProbeGridsObservation;
  dispose(): void;
}

/**
 * The probe tiles of `bakes` (sceneId → probes), loaded per scene into
 * `resources` (counted at their GPU size: the packed texture holds them).
 * Each tile is decoded and packed when it loads; the packed bytes are held
 * while the tile is wanted (CPU memory follows the residency, not the
 * world). `onChange`: the loaded tiles changed; `onFailed`: a tile's file
 * could not be read or decoded (why).
 */
export function createProbeGridSet(
  bakes: Readonly<Record<string, ProbeBakeLike | undefined>>,
  loadBytes: (assetId: string) => Promise<Uint8Array>,
  resources: ResourceManager,
  onChange?: () => void,
  onFailed?: (message: string) => void,
): ProbeGridSet {
  const holder = 'probe-grids';
  let followed: ProbeTileEntry[] = [];
  let wantAll = true;
  let wantedKeys = new Set<string>();
  /** Tiles acquired (loading or loaded) by key. */
  const held = new Map<string, { entry: ProbeTileEntry; tile: LoadedProbeTile | null }>();
  let failed = 0;
  let error: string | undefined;
  let disposed = false;
  const load = (grid: ProbeGridRecord) => async () => {
    const bytes = await loadBytes(grid.asset);
    const decoded = await decodeProbeSamples(bytes, grid);
    if (!decoded.ok) throw new Error(decoded.message);
    const packed = packProbeTile(grid, decoded.samples, decoded.validity);
    return { value: { packed, validity: decoded.validity } as Decoded, bytes: probeGridGpuBytes(grid), free: () => undefined };
  };
  const apply = (): void => {
    if (disposed) return;
    const want = wantAll ? new Set(followed.map((e) => e.key)) : wantedKeys;
    let changed = false;
    for (const [key, h] of [...held]) {
      if (want.has(key)) continue;
      resources.release('texture', key, holder);
      held.delete(key);
      if (h.tile !== null) changed = true;
    }
    for (const entry of followed) {
      if (!want.has(entry.key) || held.has(entry.key)) continue;
      const h = { entry, tile: null as LoadedProbeTile | null };
      held.set(entry.key, h);
      resources.acquire<Decoded>('texture', entry.key, holder, load(entry.grid)).then(
        (d) => {
          if (disposed || held.get(entry.key) !== h) return;
          h.tile = { key: entry.key, sceneId: entry.sceneId, grid: entry.grid, rank: entry.rank, packed: d.packed, validity: d.validity };
          onChange?.();
        },
        (e: unknown) => {
          if (held.get(entry.key) === h) held.delete(entry.key);
          failed++;
          error = e instanceof Error ? e.message : String(e);
          if (!disposed) onFailed?.(error);
        },
      );
    }
    if (changed) onChange?.();
  };
  const set: ProbeGridSet = {
    follow(sceneIds) {
      if (disposed) return;
      const ids = [...new Set(sceneIds)].filter((id) => (bakes[id]?.grids.length ?? 0) > 0).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
      const next: ProbeTileEntry[] = [];
      for (const sceneId of ids) {
        const bake = bakes[sceneId]!;
        for (const grid of bake.grids) next.push({ key: probeTileKey(grid, bake), sceneId, grid, rank: next.length });
      }
      followed = next;
      apply();
    },
    entries: () => followed,
    want(keys) {
      wantAll = false;
      wantedKeys = new Set(keys);
      apply();
    },
    wanted: () => (wantAll ? new Set(followed.map((e) => e.key)) : wantedKeys),
    tiles: () =>
      [...held.values()]
        .map((h) => h.tile)
        .filter((t): t is LoadedProbeTile => t !== null)
        .sort((a, b) => a.rank - b.rank),
    observe() {
      let loaded = 0;
      let probes = 0;
      let gpuBytes = 0;
      for (const h of held.values()) {
        if (h.tile === null) continue;
        loaded++;
        probes += probeCount(h.tile.grid);
        gpuBytes += probeGridGpuBytes(h.tile.grid);
      }
      return { tiles: followed.length, loaded, probes, gpuBytes, failed, ...(error !== undefined ? { error } : {}) };
    },
    dispose() {
      disposed = true;
      for (const key of held.keys()) resources.release('texture', key, holder);
      held.clear();
    },
  };
  return set;
}

/**
 * The adapter's probes: the loaded scenes' tiles and the probe light that
 * lights every material with them. The light is in the scene while any bake
 * has probes (its presence is part of every lit program: it comes and goes
 * with the bakes, not with each tile). Before each frame the tiles nearest
 * the camera are picked within the budget (probe-residency.ts), the ones
 * that arrived are uploaded and the ones that went give their place back.
 * Tiles left out by the budget and tiles that fail to load are told as
 * problems (once each kind) as well as in the diagnostics.
 */
export interface ProbeLightingHost {
  /** The project's bakes changed (an editing host; a game's are fixed). */
  setBakes(bakes: Readonly<Record<string, { probes?: ProbeBakeLike } | undefined>> | null): void;
  /** Follow the realized scenes. */
  follow(sceneIds: Iterable<string>): void;
  /** Before a frame: pick the resident tiles around the camera and put what arrived on the GPU. */
  beforeFrame(renderer: ProbeUploadRenderer, camera: THREE.Object3D): void;
  /** The probe light (null while no bake has probes). */
  light(): ProbeLighting | null;
  observe(): ProbeGridsObservation | null;
  /** A frame was drawn (replaced textures can go). */
  frameDrawn(): void;
  dispose(): void;
}

export interface ProbeLightingHostOptions {
  /** Something to redraw (a tile arrived). */
  readonly onChange?: () => void;
  /** A problem for the game's author: `probe_budget` (tiles left out by the budget) or `probe_load` (a tile's file failed). */
  readonly onProblem?: (code: string, message: string) => void;
  /** GPU bytes the resident tiles may take (default `PROBE_RESIDENT_BYTES`). */
  readonly budgetBytes?: number;
}

export function createProbeLightingHost(scene: THREE.Scene, resources: ResourceManager, loadBytes: ((assetId: string) => Promise<Uint8Array>) | undefined, options: ProbeLightingHostOptions = {}): ProbeLightingHost {
  const budget = options.budgetBytes ?? PROBE_RESIDENT_BYTES;
  let set: ProbeGridSet | null = null;
  let light: ProbeLighting | null = null;
  let following: string[] = [];
  /** The residency is picked again when the tiles followed change or the camera moved this far. */
  let pickedAt: [number, number, number] | null = null;
  let entriesSeen: readonly ProbeTileEntry[] | null = null;
  let shape = { columnWidth: 1, depth: 1, step: 1, hysteresis: 0 };
  let beyond = 0;
  let tilesChanged = true;
  let uploads = 0;
  let uploadedBytes = 0;
  let markedResident = false;
  const told = new Set<string>();
  const tell = (code: string, message: string): void => {
    if (told.has(code)) return;
    told.add(code);
    options.onProblem?.(code, message);
  };
  const changed = (): void => {
    tilesChanged = true;
    options.onChange?.();
  };
  const failed = (message: string): void => tell('probe_load', `a probe tile could not be loaded (its surfaces get the flat ambient light): ${message}`.slice(0, 300));
  /** The followed tiles' widest column, deepest tile, and how far the camera moves before the pick is made again. */
  const shapeOf = (entries: readonly ProbeTileEntry[]): typeof shape => {
    let columnWidth = 1;
    let depth = 1;
    let smallest = Infinity;
    for (const e of entries) {
      columnWidth = Math.max(columnWidth, e.grid.resolution[0]);
      depth = Math.max(depth, packedProbeDepth(e.grid.resolution));
      smallest = Math.min(smallest, e.grid.max[0] - e.grid.min[0], e.grid.max[2] - e.grid.min[2]);
    }
    const tile = Number.isFinite(smallest) ? smallest : 1;
    return { columnWidth, depth, step: Math.max(0.5, tile / 8), hysteresis: tile / 2 };
  };
  const host: ProbeLightingHost = {
    setBakes(bakes) {
      set?.dispose();
      set = null;
      entriesSeen = null;
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
      set = createProbeGridSet(Object.fromEntries(withProbes.map(([id, b]) => [id, b!.probes])), loadBytes!, resources, changed, failed);
      // Nothing loads before the first frame picks the tiles around the camera.
      set.want(new Set());
      set.follow(following);
      tilesChanged = true;
    },
    follow(sceneIds) {
      following = [...sceneIds];
      set?.follow(following);
    },
    beforeFrame(renderer, camera) {
      if (set === null || light === null) return;
      const e = camera.matrixWorld.elements;
      const at: [number, number, number] = [e[12]!, e[13]!, e[14]!];
      const entries = set.entries();
      if (entries !== entriesSeen) {
        entriesSeen = entries;
        shape = shapeOf(entries);
        pickedAt = null;
      }
      if (pickedAt === null || Math.hypot(at[0] - pickedAt[0], at[1] - pickedAt[1], at[2] - pickedAt[2]) >= shape.step) {
        pickedAt = at;
        const tiles = entries.map((t) => ({ key: t.key, min: t.grid.min, max: t.grid.max, bytes: shape.columnWidth * t.grid.resolution[1] * shape.depth * PROBE_TEXEL_BYTES }));
        const pick = pickResidentProbeTiles(tiles, at, budget, set.wanted(), shape.hysteresis);
        beyond = pick.beyond;
        set.want(pick.wanted);
        if (beyond > 0) tell('probe_budget', `${beyond} of ${entries.length} probe tiles do not fit the probe memory budget (${Math.round(budget / 1048576)} MB): the ones farthest from the camera get the flat ambient light until the camera comes near`);
        tilesChanged = true;
      }
      if (!tilesChanged) return;
      tilesChanged = false;
      try {
        const r = light.store.sync(set.tiles(), set.wanted(), renderer, budget * PROBE_ATLAS_SLACK, shape);
        uploads += r.uploaded;
        uploadedBytes += r.uploadedBytes;
        light.rebind();
        if (!markedResident && set.wanted().size > 0 && light.store.count >= set.wanted().size) {
          // A user-timing mark (the perf harness, DevTools): the first resident set is on the GPU.
          markedResident = true;
          globalThis.performance?.mark?.('tl:probes:resident', { detail: { resident: light.store.count, beyondBudget: beyond, textureBytes: light.store.gpuBytes, uploadedBytes } });
        }
        if (r.unplaced > 0) tell('probe_budget', `${r.unplaced} probe tiles did not fit the probe texture (${Math.round(budget / 1048576)} MB budget, ${PROBE_PACK_MAX_EDGE}-texel edge): their surfaces get the flat ambient light`);
      } catch (err) {
        failed(`the probe texture could not be updated: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
    light: () => light,
    observe() {
      if (set === null) return null;
      const store = light?.store;
      return {
        ...set.observe(),
        resident: set.wanted().size,
        beyondBudget: beyond,
        budgetBytes: budget,
        textureBytes: store?.gpuBytes ?? 0,
        sampled: store?.count ?? 0,
        unplaced: store?.unplaced ?? 0,
        indexCells: store?.indexOf.cells ?? 0,
        indexEntries: store?.indexOf.entries ?? 0,
        uploads,
        uploadedBytes,
      };
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
