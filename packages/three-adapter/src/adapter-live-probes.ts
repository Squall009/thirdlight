/**
 * The live probes on the page (`surface-probes.ts`, updated by the light
 * runtime's probe pass) as the probe lighting draws them: while the
 * surface cache's light is live, the probes' grids stand in for the bakes'
 * probe tiles (`ProbeLightingHost.setLive`), so every lit material — moving
 * objects, foliage and ground cover among them — reads bounced light from
 * the live cache through the probe sampling it always used.
 *
 * - Each grid (a room's, or a brick) is a tile in the bake's GPU layout
 *   (`writePackedProbe`); a probe whose record changed is written again
 *   into every tile holding it (with the walls of the points next to it,
 *   which read its axis rays), and a tile whose probes changed is uploaded
 *   in place, at most every `LIVE_TILE_MS` for each `LIVE_TILE_BYTES` it
 *   holds and `LIVE_TILE_WRITES` tiles a frame; tiles of grids placed again
 *   are kept.
 * - The sky the probes see (`SkyProbe`) is looked at here; when it
 *   changes every probe is stale.
 * - `?probesView=1` on the page draws the probes (the editor's probe debug
 *   view, `setView`): each a small sphere lit by its own light, the bakes'
 *   probes while the light is not live.
 */

import * as THREE from 'three';
import { PROBE_FILLED, PROBE_MOVED, PROBE_SH_TEXELS, PROBE_VALID, type ProbeGridRecord } from '@thirdlight/project-model';

import { pageSearch } from './renderer-factory';
import type { ProbeTileForGpu } from './probe-atlas';
import { createProbeDebugView, type ProbeDebugView } from './probe-debug';
import type { ProbeLightingHost } from './probe-grids';
import { probesFromUrl, type ProbeLighting } from './probe-lighting';
import { emptyPackedProbeTile, writePackedProbe, type PackedProbeTile } from './probe-pack';
import { PROBE_NEVER_LIT, PROBE_WEIGHT_FILLED } from './probe-weights';
import { PROBE_FLOATS, liveProbeTileKey, type LiveProbes } from './surface-probes';
import type { SurfaceCacheHost } from './surface-cache-host';
import { SkyProbe } from './surface-probe-sky';
import type { SurfaceLightRuntime } from './surface-light-runtime';
import type { SavedProbeTile } from './surface-bake-file';

/**
 * Shortest time (ms) between two uploads of one grid's probes, for each
 * `LIVE_TILE_BYTES` of its tile: a tile is uploaded whole, so a large
 * outdoor grid (megabytes) takes its probes' changes less often than a
 * room's (kilobytes).
 */
export const LIVE_TILE_MS = 200;
export const LIVE_TILE_BYTES = 256 * 1024;
/**
 * Tiles written to the GPU a frame at most once placed: each write is a
 * call into the GPU process (tens of microseconds of main thread), and a
 * sun step changes every brick's probes at once.
 */
export const LIVE_TILE_WRITES = 16;
/** The file value index of a probe's walls (after its light's texels). */
const WALLS = PROBE_SH_TEXELS * 4;

interface LiveTile {
  readonly tile: ProbeTileForGpu & { readonly packed: PackedProbeTile; readonly validity: Float32Array };
  dirty: boolean;
  uploadedAt: number;
}

export class AdapterLiveProbes {
  private readonly sky = new SkyProbe();
  private skyVersion = -1;
  /** The runtime the sky was handed to. */
  private skyRuntime: SurfaceLightRuntime | null = null;
  private layout = -1;
  private tiles: LiveTile[] = [];
  /** Tiles made by the last placement, written whole once made. */
  private fresh: [number, LiveTile][] = [];
  /** Bumped whenever a probe's validity in its tile changed (the probes view is built again). */
  private validityVersion = 0;
  private readonly walls = [0, 0, 0, 0, 0, 0];
  private on = false;
  private viewOn: boolean;
  /** `?probes=off` draws without probes, live ones too (a diagnostic comparison). */
  private readonly enabled: boolean;
  private view: { light: ProbeLighting; view: ProbeDebugView } | null = null;

  constructor(private readonly host: SurfaceCacheHost, private readonly probes: ProbeLightingHost, private readonly scene: THREE.Scene) {
    this.viewOn = new URLSearchParams(pageSearch()).get('probesView') === '1';
    this.enabled = probesFromUrl(pageSearch());
  }

  /**
   * Before a frame's programs are built: whether the light is live on this
   * page with probes to light (`live`). The probe light joins the scene
   * then (with no tiles yet), before the frame builds its programs; a page
   * with no static surfaces never takes it (every lit program would carry
   * it for nothing). Not live: the bakes' tiles come back.
   */
  hold(live: boolean): void {
    live &&= this.enabled && this.host.probes.count > 0;
    if (live === this.on) return;
    this.probes.setLive(live ? [] : null, new Set());
    this.on = live;
    this.layout = -1;
    this.tiles = [];
  }

  /** After the light runtime's frame (null: not running yet). */
  frame(renderer: unknown, runtime: SurfaceLightRuntime | null, now = performance.now()): void {
    const probes = this.host.probes;
    if (runtime === null || !this.on) {
      // Not live: the view draws the bakes' probes.
      this.drawView();
      return;
    }
    this.sky.update(renderer, this.scene as never, now);
    // A runtime made again (another budget, a bake's run) starts with no sky: it takes the one seen so far.
    if (this.sky.version !== this.skyVersion || runtime !== this.skyRuntime) {
      this.skyVersion = this.sky.version;
      this.skyRuntime = runtime;
      runtime.sky = this.sky.coefficients.slice();
      probes.markBox(null, null);
    }
    let relaid = false;
    if (probes.layout !== this.layout) {
      this.layout = probes.layout;
      // Grids placed again keep their tiles (their probes kept their light); new ones are written whole.
      const old = new Map(this.tiles.map((t) => [t.tile.key, t]));
      this.tiles = probes.grids.map((g, gi) => {
        const key = liveProbeTileKey(g);
        const kept = old.get(key);
        if (kept !== undefined) return kept;
        const grid: ProbeGridRecord = { min: [...g.min] as [number, number, number], max: [...g.max] as [number, number, number], resolution: [...g.resolution] as [number, number, number], asset: '' };
        const n = g.resolution[0] * g.resolution[1] * g.resolution[2];
        const t: LiveTile = { tile: { key, sceneId: '', grid, packed: emptyPackedProbeTile(g.resolution), validity: new Float32Array(n).fill(PROBE_FILLED), ...(g.level >= 0 ? { brick: true } : {}) }, dirty: true, uploadedAt: -Infinity };
        this.fresh.push([gi, t]);
        return t;
      });
      for (const [gi, t] of this.fresh) {
        const n = t.tile.grid.resolution[0] * t.tile.grid.resolution[1] * t.tile.grid.resolution[2];
        for (let l = 0; l < n; l += 1) this.write(probes, gi, l);
        // Placed with what it holds now (the store uploads a tile it places).
        t.dirty = false;
        t.uploadedAt = now;
      }
      this.fresh = [];
      relaid = true;
    }
    for (const i of probes.takeChangedProbes()) {
      // Every grid holding it, and the points before it along each axis there (their walls take its axis rays).
      for (let h = probes.holdersAt[i]!; h < probes.holdersAt[i + 1]!; h += 1) {
        const gi = probes.holders[h * 2]!;
        const l = probes.holders[h * 2 + 1]!;
        const [nx, ny] = probes.grids[gi]!.resolution;
        this.write(probes, gi, l);
        if (l % nx > 0) this.write(probes, gi, l - 1);
        if (Math.floor(l / nx) % ny > 0) this.write(probes, gi, l - nx);
        if (Math.floor(l / (nx * ny)) > 0) this.write(probes, gi, l - nx * ny);
      }
    }
    // The tiles waiting longest go first, a few a frame (each is one texture write).
    const changed = new Set<string>();
    const due = this.tiles.filter((t) => t.dirty && now - t.uploadedAt >= LIVE_TILE_MS * Math.max(1, t.tile.packed.data.byteLength / LIVE_TILE_BYTES));
    due.sort((a, b) => a.uploadedAt - b.uploadedAt);
    for (const t of due.slice(0, LIVE_TILE_WRITES)) {
      t.dirty = false;
      t.uploadedAt = now;
      changed.add(t.tile.key);
    }
    if (changed.size > 0 || relaid) this.probes.setLive(this.tiles.map((t) => t.tile), changed);
    this.drawView();
  }

  /** Point `l` of grid `gi` (its probe's light, weight and walls) into the grid's tile. */
  private write(probes: LiveProbes, gi: number, l: number): void {
    const t = this.tiles[gi]!;
    const g = probes.grids[gi]!;
    const [nx, ny, nz] = g.resolution;
    const i = probes.lattice[g.at + l]!;
    const w = probes.probeWeight(i);
    const validity = !probes.probeLit(i) ? PROBE_NEVER_LIT : w <= PROBE_WEIGHT_FILLED ? PROBE_FILLED : probes.probeMoved(i) ? PROBE_MOVED : PROBE_VALID;
    if (t.tile.validity[l] !== validity) this.validityVersion += 1;
    t.tile.validity[l] = validity;
    const walls = probes.probeWalls(gi, l, this.walls);
    const at = i * PROBE_FLOATS;
    const state = probes.state;
    const toHalf = THREE.DataUtils.toHalfFloat;
    // The file's values: the first band's twelve, then the walls (cut x, cut x × where, cut y, …).
    writePackedProbe(t.tile.packed, l % nx, Math.floor(l / nx) % ny, Math.floor(l / (nx * ny)), nz, w, (src) => {
      if (src < 12) return toHalf(state[at + src]!);
      if (src >= WALLS && src < WALLS + 6) {
        const k = src - WALLS;
        return toHalf(k % 2 === 0 ? walls[k]! : walls[k - 1]! * walls[k]!);
      }
      return 0;
    });
    t.dirty = true;
  }

  /** The probes' tiles as the probe lighting holds them (empty while not live): what a bake saves. */
  savedTiles(): SavedProbeTile[] {
    const v3 = (a: readonly number[]): [number, number, number] => [a[0]!, a[1]!, a[2]!];
    return this.tiles.map(({ tile: t }) => ({ key: t.key, min: v3(t.grid.min), max: v3(t.grid.max), resolution: v3(t.grid.resolution), brick: t.brick === true, validity: t.validity.slice(), data: t.packed.data.slice() }));
  }

  /** The probes view (`?probesView=1` at load; the editor's debug view). */
  setView(on: boolean): void {
    this.viewOn = on;
    if (!on) this.clearView();
  }

  /** Probes the view draws, and of those the ones moved or filled (0 0: off). */
  viewCounts(): { spheres: number; invalid: number } {
    return { spheres: this.view?.view.count() ?? 0, invalid: this.view?.view.invalid() ?? 0 };
  }

  private drawView(): void {
    const light = this.probes.light();
    if (light === null && this.view !== null) this.clearView();
    if (!this.viewOn || light === null) return;
    if (this.view?.light !== light) {
      this.clearView();
      this.view = { light, view: createProbeDebugView(light, () => this.validityVersion) };
      this.scene.add(this.view.view.object as never);
    }
    this.view.view.update();
  }

  private clearView(): void {
    if (this.view === null) return;
    this.scene.remove(this.view.view.object as never);
    this.view.view.dispose();
    this.view = null;
  }

  dispose(): void {
    this.clearView();
    this.sky.dispose();
    if (this.on) this.probes.setLive(null, new Set());
    this.on = false;
  }
}
