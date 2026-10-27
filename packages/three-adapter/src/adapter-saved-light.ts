/**
 * The saved lighting drawn where the light is not live (WebGL 2, a level
 * with no live budget, a device that cannot run the passes): the loaded
 * scenes' bakes (`LightingBake.surface`, made by "Bake lighting") read from
 * their files and drawn the way the live light is drawn.
 *
 * - The cache's tiles stand where the bake put them (`SurfaceCache.setSaved`;
 *   a tile whose charts changed since is left out and keeps its per-pixel
 *   lights), on an atlas made from the saved pages; the materials read it
 *   through the same lookup (`packSurfaceLookup`, packed again when the
 *   residency changes) and the same reading variant as live, which on saved
 *   textures adds the cache's light to the per-pixel lights (those a bake
 *   saves no direct light of: mixed and realtime lights) instead of standing
 *   in for them.
 * - The probes' tiles (rooms' grids and bricks, as the live probes held
 *   them) go to the probe lighting as the live ones do (`setLive`), so
 *   moving objects, foliage and every lit material read them through the
 *   same sparse lookup.
 *
 * Several loaded scenes' bakes are drawn together: each one's pages follow
 * the ones before it.
 *
 * Where the light is live the same saved light is its starting state
 * (`seed`, `surface-seed.ts`): read the same way and handed to the host.
 */
import * as THREE from 'three';

import type { ProbeLightingHost } from './probe-grids';
import { probesFromUrl } from './probe-lighting';
import { pageSearch } from './renderer-factory';
import type { ProbeTileForGpu } from './probe-atlas';
import type { SurfaceCacheHost } from './surface-cache-host';
import type { SavedSurfaceTile } from './surface-cache';
import { savedSurfaceFromFiles, type SavedProbeTile, type SavedSurfaceLight } from './surface-bake-file';
import { readPackedProbe } from './probe-pack';
import { PROBE_FILLED, PROBE_SH_TEXELS } from '@thirdlight/runtime';
import { PROBE_NEVER_LIT } from './probe-weights';
import type { CacheLight } from './surface-changes';
import type { SavedProbeGrid } from './surface-probes';
import type { SurfaceSeed } from './surface-seed';
import { BLOCK_LAYERS_HELD, LAYER_TEXELS, packSurfaceLookup } from './surface-cache-lookup';
import { SURFACE_READ_LIVE_KEY, SurfaceCacheTextures } from './surface-cache-read';
import { SURFACE_PAGE_TEXELS } from './surface-cache-atlas';

/** A scene's bake as the adapter carries it (`LightingBake.surface`, structurally). */
export interface SurfaceBakeLike {
  readonly files: readonly string[];
  readonly createdAt: string;
}

/** The lookup words the reading programs take as uniforms (`SurfaceCacheTextures.setTable`): its header and the first block layers' records. */
function uniformWords(words: Uint32Array): string {
  const layers = words.subarray(words[1]! * 4, (words[1]! + BLOCK_LAYERS_HELD * LAYER_TEXELS) * 4);
  return `${Array.from(words.subarray(0, 8)).join(',')}|${Array.from(layers).join(',')}`;
}

/** Shortest time (ms) between two packings of the lookup while residency keeps changing (as live). */
const LOOKUP_MS = 100;

type Loaded = { saved: SavedSurfaceLight } | { failed: string };

/** The file values of a probe (its light values, then its walls). */
const PROBE_FILE_VALUES = PROBE_SH_TEXELS * 4 + 8;

/** A saved probe tile as the live probes take it (`LiveProbes.seed`). */
function savedProbeGrid(t: SavedProbeTile): SavedProbeGrid {
  const [nx, ny, nz] = t.resolution;
  const packed = { data: t.data, nx, ny, depth: t.data.length / (nx * ny * 4) };
  const v = new Float32Array(PROBE_FILE_VALUES);
  const walls = PROBE_SH_TEXELS * 4;
  return {
    min: t.min,
    max: t.max,
    resolution: t.resolution,
    read(l, light, cut) {
      if (t.validity[l] === PROBE_NEVER_LIT) return null;
      readPackedProbe(packed, l % nx, Math.floor(l / nx) % ny, Math.floor(l / (nx * ny)), nz, v);
      light.set(v.subarray(0, 12));
      cut.set(v.subarray(walls, walls + 6));
      return { filled: t.validity[l] === PROBE_FILLED };
    },
  };
}

/** The followed scenes' saved light together: each scene's pages after the ones before it. */
function merged(ready: readonly [string, SavedSurfaceLight][]): { texels: Uint16Array<ArrayBuffer>; pages: number; tiles: Map<string, SavedSurfaceTile>; probeTiles: ProbeTileForGpu[]; seed: SurfaceSeed } {
  const pageHalves = SURFACE_PAGE_TEXELS * SURFACE_PAGE_TEXELS * 4;
  const pages = ready.reduce((n, [, s]) => n + s.pages, 0);
  const texels = new Uint16Array(Math.max(1, pages) * pageHalves);
  const tiles = new Map<string, SavedSurfaceTile>();
  const probeTiles: ProbeTileForGpu[] = [];
  const grids = new Map<string, SavedProbeTile>();
  let lights: CacheLight[] | null = [];
  let at = 0;
  for (const [sceneId, s] of ready) {
    texels.set(s.texels, at * pageHalves);
    for (const t of s.tiles) tiles.set(t.key, { digest: t.digest, level: t.level, blocks: t.blocks.map((b) => ({ ...b, page: b.page + at })) });
    for (const p of s.probes) {
      const [nx, ny] = p.resolution;
      probeTiles.push({ key: `saved:${sceneId}:${p.key}`, sceneId, grid: { min: [...p.min], max: [...p.max], resolution: [...p.resolution], asset: '' }, packed: { data: p.data, nx, ny, depth: p.data.length / (nx * ny * 4) }, validity: p.validity, ...(p.brick ? { brick: true } : {}) });
      grids.set(p.key, p);
    }
    lights = lights === null || s.lights === undefined ? null : [...lights, ...s.lights];
    at += s.pages;
  }
  const decoded = new Map<string, SavedProbeGrid>();
  const probes = (key: string): SavedProbeGrid | null => {
    const t = grids.get(key);
    if (t === undefined) return null;
    let g = decoded.get(key);
    if (g === undefined) decoded.set(key, (g = savedProbeGrid(t)));
    return g;
  };
  return { texels, pages, tiles, probeTiles, seed: { tiles, texels, probes, lights } };
}

export interface SavedLightDiagnostics {
  /** Scenes whose saved light is drawn, tiles drawn from it, pages, probe tiles. */
  readonly scenes: number;
  readonly pages: number;
  readonly probeTiles: number;
  /** Why a scene's saved light could not be read (absent: none failed). */
  readonly error?: string;
}

export class AdapterSavedLight {
  private bakes: Readonly<Record<string, { surface?: SurfaceBakeLike } | undefined>> = {};
  private followed: string[] = [];
  private readonly loads = new Map<string, Loaded | 'loading'>();
  /** What is drawn now: its key (scenes and bakes), textures and probe tiles. */
  private appliedKey = '';
  private textures: SurfaceCacheTextures | null = null;
  private probeTiles: ProbeTileForGpu[] = [];
  private probesSent = false;
  private lookupFor = '';
  private lookupAt = -Infinity;
  private on = false;
  /** The saved pages the textures hold, and whether the scene reads them yet (the lookup's header the programs hold). */
  private texels = new Uint16Array(0);
  private pages = 1;
  private exposed = false;
  private headFor = '';
  /** What the host was last handed as the live light's start. */
  private seedKey: string | null = null;
  private diag: SavedLightDiagnostics = { scenes: 0, pages: 0, probeTiles: 0 };
  /** `?probes=off` draws without probes, saved ones too (a diagnostic comparison). */
  private readonly probesOn = probesFromUrl(pageSearch());

  constructor(
    private readonly host: SurfaceCacheHost,
    private readonly scene: THREE.Scene,
    private readonly probes: ProbeLightingHost | null,
    private readonly loadBytes: ((assetId: string) => Promise<Uint8Array>) | undefined,
    private readonly changed: () => void,
  ) {}

  /** The project's bakes (sceneId → bake; an editing host replaces them). */
  setBakes(bakes: Readonly<Record<string, { surface?: SurfaceBakeLike } | undefined>> | null): void {
    this.bakes = bakes ?? {};
  }

  /** The realized scenes (their bakes are drawn). */
  follow(sceneIds: Iterable<string>): void {
    this.followed = [...sceneIds];
  }

  /** A scene's bake read from its files (once a bake). */
  private load(sceneId: string, s: SurfaceBakeLike): Loaded | 'loading' {
    const key = `${sceneId}@${s.createdAt}@${s.files.join(',')}`;
    const had = this.loads.get(key);
    if (had !== undefined) return had;
    this.loads.set(key, 'loading');
    const read = this.loadBytes;
    if (read === undefined) {
      this.loads.set(key, { failed: 'this page reads no lighting files' });
      return this.loads.get(key)!;
    }
    void Promise.all(s.files.map((f) => read(f)))
      .then((files) => savedSurfaceFromFiles(files))
      .then(
        (r) => this.loads.set(key, r.ok ? { saved: r.saved } : { failed: r.message }),
        (e: unknown) => this.loads.set(key, { failed: e instanceof Error ? e.message : String(e) }),
      )
      .finally(() => this.changed());
    return 'loading';
  }

  /** Before a frame where the light is not live: the followed scenes' saved light, read and drawn. */
  frame(): void {
    this.on = true;
    const { ready, key, error } = this.readyNow();
    if (key !== this.appliedKey) this.apply(key, ready, error);
    this.syncLookup();
  }

  /** The followed scenes' bakes read so far (and why one could not be). */
  private readyNow(): { ready: [string, SavedSurfaceLight][]; key: string; error: string | undefined } {
    const ready: [string, SavedSurfaceLight][] = [];
    let error: string | undefined;
    for (const id of this.followed) {
      const s = this.bakes[id]?.surface;
      if (s === undefined) continue;
      const l = this.load(id, s);
      if (l === 'loading') continue;
      if ('failed' in l) error = l.failed;
      else ready.push([id, l.saved]);
    }
    const key = ready.map(([id, s]) => `${id}:${s.pages}:${s.tiles.length}:${s.probes.length}:${this.bakes[id]?.surface?.createdAt ?? ''}`).join('|');
    return { ready, key, error };
  }

  /** Before a frame where the light is live: the followed scenes' saved light, read and handed to the host as the live light's start. */
  seed(): void {
    const { ready, key } = this.readyNow();
    if (key === this.seedKey) return;
    this.seedKey = key;
    this.host.seeding.set(ready.length === 0 ? null : merged(ready).seed);
  }

  private apply(key: string, ready: readonly [string, SavedSurfaceLight][], error: string | undefined): void {
    this.appliedKey = key;
    this.textures?.dispose();
    this.textures = null;
    this.lookupFor = '';
    delete this.scene.userData[SURFACE_READ_LIVE_KEY];
    if (ready.length === 0) {
      this.seedKey = key;
      this.host.seeding.set(null);
      this.host.cache.setSaved(null);
      this.dropProbes();
      this.diag = { scenes: 0, pages: 0, probeTiles: 0, ...(error !== undefined ? { error } : {}) };
      return;
    }
    const { texels, pages, tiles, probeTiles, seed } = merged(ready);
    // The same saved light starts the live light once it runs.
    this.seedKey = key;
    this.host.seeding.set(seed);
    this.host.cache.setSaved(tiles, pages);
    this.texels = texels;
    this.pages = Math.max(1, pages);
    this.exposed = false;
    this.textures = SurfaceCacheTextures.saved(texels, this.pages);
    this.probeTiles = probeTiles;
    this.probesSent = false;
    this.diag = { scenes: ready.length, pages, probeTiles: probeTiles.length, ...(error !== undefined ? { error } : {}) };
  }

  /** Before the frame's programs are built: the saved probes join the probe lighting (as live ones do). */
  prepare(): void {
    if (!this.on || !this.probesOn || this.probes === null || this.probesSent || this.probeTiles.length === 0) return;
    this.probes.setLive(this.probeTiles, new Set(this.probeTiles.map((t) => t.key)));
    this.probesSent = true;
  }

  /** The lookup packed again when what is resident changed; the scene says it may be read once it is up. */
  private syncLookup(): void {
    const tex = this.textures;
    if (tex === null) return;
    // Read once a tile is resident (a header packed before them would stay in the programs).
    if (!this.exposed && this.host.cache.diagnostics().tiles.resident === 0) return;
    const key = `${this.host.traceVersion}/${this.host.residencyVersion}`;
    const now = performance.now();
    if (key !== this.lookupFor && now - this.lookupAt >= LOOKUP_MS) {
      const words = packSurfaceLookup(this.host.resolveScene().scene, this.host.cache, (owner) => this.host.modelSlots.peek(owner));
      // The lookup's header and first records are uniforms of the reading programs, which keep the values they were
      // first drawn with: a header that changed once the textures are read takes textures of its own (new programs).
      const head = uniformWords(words);
      if (this.exposed && head !== this.headFor) {
        tex.dispose();
        this.textures = SurfaceCacheTextures.saved(this.texels, this.pages);
        this.exposed = false;
      }
      this.headFor = head;
      this.textures!.setTable(words);
      this.lookupFor = key;
      this.lookupAt = now;
    }
    if (this.lookupFor !== '') {
      this.scene.userData[SURFACE_READ_LIVE_KEY] = this.textures!;
      this.exposed = true;
    }
  }

  private dropProbes(): void {
    if (this.probesSent) this.probes?.setLive(null, new Set());
    this.probeTiles = [];
    this.probesSent = false;
  }

  /** The light is live (or the page goes): nothing saved is drawn. */
  drop(): void {
    if (!this.on) return;
    this.on = false;
    this.appliedKey = '';
    this.lookupFor = '';
    if (this.scene.userData[SURFACE_READ_LIVE_KEY] === this.textures) delete this.scene.userData[SURFACE_READ_LIVE_KEY];
    this.textures?.dispose();
    this.textures = null;
    if (this.host.cache.drawsSaved) this.host.cache.setSaved(null);
    // The live probes take the probe lighting over themselves (their hold); here only the saved ones go.
    this.probeTiles = [];
    this.probesSent = false;
  }

  diagnostics(): SavedLightDiagnostics {
    return this.diag;
  }
}
