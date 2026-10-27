/**
 * A bake's saved light as the live light's starting state: a WebGPU page on
 * the medium or high tier starts from the light its scenes were baked with
 * and updates only what changed since, instead of lighting everything from
 * nothing.
 *
 * - **Cache.** A tile made resident while the light is live, at the level
 *   the bake lit it at, on the charts it was lit with (its digest), takes
 *   the saved texels into its new blocks (`take`: the light runtime copies
 *   them in place of clearing the blocks) and its units are settled. What
 *   the saved texels lack is then marked stale on them: the direct light of
 *   `mixed` and `realtime` lights (a bake saves only `baked` lights' direct
 *   light) and of `baked` lights added, changed or gone since the bake.
 *   A tile whose charts changed since the bake is a geometry change (marked
 *   round it as any edit is), and the rest of the seed is let go: what it
 *   shadows or bounces onto was saved without it.
 * - **Probes.** Probes placed and never updated take their saved light
 *   (`LiveProbes.seed`); those `realtime` lights reach, and those of lights
 *   changed since the bake, are stale again.
 *
 * Nothing is seeded while a bake runs: a bake lights from what the scene
 * is, not from the last bake.
 *
 * Pure (no three.js).
 */
import type { AtlasBlock } from './surface-cache-atlas';
import type { SavedSurfaceTile, SurfaceCache, SurfaceTile } from './surface-cache';
import type { CacheLight, SurfaceChanges } from './surface-changes';
import type { LiveProbes, SavedProbeGrid } from './surface-probes';
import type { SurfaceRelight } from './surface-relight';

/** The saved light the live light starts from (the loaded scenes' bakes together). */
export interface SurfaceSeed {
  /** The saved tiles by key, their blocks on `texels`' pages. */
  readonly tiles: ReadonlyMap<string, SavedSurfaceTile>;
  /** The saved pages (`SURFACE_PAGE_TEXELS`² RGBA half floats each). */
  readonly texels: Uint16Array;
  /** The saved probe grids by tile key (null: none saved under it). */
  probes(key: string): SavedProbeGrid | null;
  /** The bakes' lights as they were (baked and mixed; null: not known). */
  readonly lights: readonly CacheLight[] | null;
}

/** A saved block copied into a tile's new block. */
export interface SeedCopy {
  readonly to: AtlasBlock;
  readonly from: AtlasBlock;
  readonly texels: Uint16Array;
}

export interface SurfaceSeedingDeps {
  readonly cache: SurfaceCache;
  readonly relight: SurfaceRelight;
  readonly changes: SurfaceChanges;
  readonly probes: LiveProbes;
  /** A ready tile by key. */
  tile(key: string): SurfaceTile | undefined;
  /** A resident tile's unit keys. */
  unitsOf(key: string): readonly string[];
}

export class SurfaceSeeding {
  private seed: SurfaceSeed | null = null;
  private held = false;
  private copies: SeedCopy[] = [];
  private cleared: AtlasBlock[] = [];
  /** The resident tiles wait for the seed (it came, or the light went live). */
  private residentDue = false;
  private probeLayout = -1;
  /** Probes that took saved light (for the checks). */
  seededProbes = 0;
  /** Tiles that took saved light (for the checks). */
  seededTiles = 0;

  constructor(private readonly d: SurfaceSeedingDeps) {}

  /** The saved light to start from (null: none). */
  set(seed: SurfaceSeed | null): void {
    if (seed === this.seed) return;
    this.seed = seed;
    this.residentDue = true;
    this.probeLayout = -1;
  }

  /** While a bake runs nothing is seeded. */
  hold(on: boolean): void {
    this.held = on;
    if (!on) {
      this.residentDue = true;
      this.probeLayout = -1;
    }
  }

  /** The light went live: the tiles resident by then take the seed. */
  wentLive(): void {
    this.residentDue = true;
  }

  /** Atlas blocks just handed to a tile on the live light: given the saved light when it holds them, else cleared. */
  handOut(key: string, blocks: readonly AtlasBlock[]): void {
    if (!this.tile(key)) this.cleared.push(...blocks);
  }

  /** The blocks handed out since the last call: those to clear (they hold another tile's light) and the saved blocks to copy in. */
  take(): { clear: AtlasBlock[]; copies: SeedCopy[] } {
    const out = { clear: this.cleared, copies: this.copies };
    this.cleared = [];
    this.copies = [];
    return out;
  }

  /** A resident tile takes the saved light: true when it did. */
  private tile(key: string): boolean {
    const seed = this.seed;
    const t = this.d.tile(key);
    const r = this.d.cache.residentOf(key);
    if (seed === null || this.held || t === undefined || r === null) return false;
    const s = seed.tiles.get(key);
    if (s === undefined) return false;
    if (this.d.cache.digestOf(t) !== s.digest) {
      // Changed since the bake: an edit's marks round it, and nothing further is seeded.
      this.seed = null;
      this.d.changes.geometryChanged(t.min, t.max);
      return false;
    }
    if (s.level !== r.level || s.blocks.length !== r.blocks.length || s.blocks.some((b, i) => b.side !== r.blocks[i]!.side)) return false;
    r.blocks.forEach((to, i) => this.copies.push({ to, from: s.blocks[i]!, texels: seed.texels }));
    const units = this.d.unitsOf(key);
    for (const u of units) this.d.relight.settle(u);
    this.d.changes.markSinceBake(seed.lights, new Set(units));
    this.seededTiles += 1;
    return true;
  }

  /** Once a frame after the cache's units are synced: resident tiles waiting for the seed, and probes placed since. */
  frame(live: boolean): void {
    if (this.seed === null || this.held) return;
    if (live && this.residentDue) {
      this.residentDue = false;
      const keys: string[] = [];
      this.d.cache.forEachResident((key) => keys.push(key));
      for (const key of keys) this.tile(key);
    }
    const probes = this.d.probes;
    if (this.seed !== null && probes.count > 0 && probes.layout !== this.probeLayout) {
      this.probeLayout = probes.layout;
      const seed = this.seed;
      const n = probes.seed((key) => seed.probes(key));
      if (n > 0) for (const m of this.d.changes.probeMarksSinceBake(seed.lights)) probes.markBox(m?.min ?? null, m?.max ?? null);
      this.seededProbes += n;
    }
  }
}
