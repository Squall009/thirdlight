/**
 * The live probes on the page (`surface-probes.ts`, updated by the light
 * runtime's probe pass) as the probe lighting draws them: while the
 * surface cache's light is live, the probes' grids stand in for the bakes'
 * probe tiles (`ProbeLightingHost.setLive`), so every lit material — moving
 * objects, foliage and ground cover among them — reads bounced light from
 * the live cache through the probe sampling it always used.
 *
 * - Each grid is a tile in the bake's GPU layout (`writePackedProbe`); a
 *   probe whose record changed is written into it again (with the walls of
 *   the probes next to it, which read its axis rays), and a tile whose
 *   probes changed is uploaded in place, at most every `LIVE_TILE_MS` for
 *   each `LIVE_TILE_BYTES` it holds.
 * - The sky the probes see (`SkyProbe`) is looked at here; when it
 *   changes every probe is stale.
 * - `?probesView=1` on the page draws the probes (the editor's probe debug
 *   view): each a small sphere lit by its own light.
 */

import * as THREE from 'three';
import { PROBE_FILLED, PROBE_SH_TEXELS, PROBE_VALID, type ProbeGridRecord } from '@thirdlight/runtime';

import { pageSearch } from './renderer-factory';
import type { ProbeTileForGpu } from './probe-atlas';
import { createProbeDebugView, type ProbeDebugView } from './probe-debug';
import type { ProbeLightingHost } from './probe-grids';
import type { ProbeLighting } from './probe-lighting';
import { emptyPackedProbeTile, probeWeight, writePackedProbe, type PackedProbeTile } from './probe-pack';
import { PROBE_FLOATS, type LiveProbes } from './surface-probes';
import type { SurfaceCacheHost } from './surface-cache-host';
import { SkyProbe } from './surface-probe-sky';
import type { SurfaceLightRuntime } from './surface-light-runtime';

/**
 * Shortest time (ms) between two uploads of one grid's probes, for each
 * `LIVE_TILE_BYTES` of its tile: a tile is uploaded whole, so a large
 * outdoor grid (megabytes) takes its probes' changes less often than a
 * room's (kilobytes).
 */
export const LIVE_TILE_MS = 200;
export const LIVE_TILE_BYTES = 256 * 1024;
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
  private layout = -1;
  private tiles: LiveTile[] = [];
  private readonly walls = [0, 0, 0, 0, 0, 0];
  private on = false;
  private viewOn: boolean;
  private view: { light: ProbeLighting; view: ProbeDebugView } | null = null;

  constructor(private readonly host: SurfaceCacheHost, private readonly probes: ProbeLightingHost, private readonly scene: THREE.Scene) {
    this.viewOn = new URLSearchParams(pageSearch()).get('probesView') === '1';
  }

  /**
   * Before a frame's programs are built: whether the light will be live on
   * this page. The probe light joins the scene then, with no tiles yet, so
   * every lit program is built with it from the start: a light coming later
   * would build every program again in the middle of a session. Not live:
   * the bakes' tiles come back.
   */
  hold(live: boolean): void {
    if (live === this.on) return;
    this.probes.setLive(live ? [] : null, new Set());
    this.on = live;
    this.layout = -1;
    this.tiles = [];
  }

  /** After the light runtime's frame (null: not running yet). */
  frame(renderer: unknown, runtime: SurfaceLightRuntime | null, now = performance.now()): void {
    const probes = this.host.probes;
    if (runtime === null || !this.on) return;
    this.sky.update(renderer, this.scene as never, now);
    if (this.sky.version !== this.skyVersion) {
      this.skyVersion = this.sky.version;
      runtime.sky = this.sky.coefficients.slice();
      probes.markBox(null, null);
    }
    if (probes.layout !== this.layout) {
      this.layout = probes.layout;
      this.tiles = probes.grids.map((g) => {
        const grid: ProbeGridRecord = { min: [...g.min] as [number, number, number], max: [...g.max] as [number, number, number], resolution: [...g.resolution] as [number, number, number], asset: '' };
        const n = g.resolution[0] * g.resolution[1] * g.resolution[2];
        return { tile: { key: `live:${g.key}`, sceneId: '', grid, packed: emptyPackedProbeTile(g.resolution), validity: new Float32Array(n).fill(PROBE_FILLED) }, dirty: true, uploadedAt: -Infinity };
      });
      for (let i = 0; i < probes.count; i += 1) this.write(probes, i);
    }
    for (const i of probes.takeChangedProbes()) {
      this.write(probes, i);
      // The probes before it along each axis take their walls from its axis rays.
      const g = probes.grids[probes.gridOf(i)]!;
      const l = i - g.first;
      const [nx, ny] = g.resolution;
      if (l % nx > 0) this.write(probes, i - 1);
      if (Math.floor(l / nx) % ny > 0) this.write(probes, i - nx);
      if (Math.floor(l / (nx * ny)) > 0) this.write(probes, i - nx * ny);
    }
    const changed = new Set<string>();
    for (const t of this.tiles) {
      if (!t.dirty || now - t.uploadedAt < LIVE_TILE_MS * Math.max(1, t.tile.packed.data.byteLength / LIVE_TILE_BYTES)) continue;
      t.dirty = false;
      t.uploadedAt = now;
      changed.add(t.tile.key);
    }
    if (changed.size > 0) this.probes.setLive(this.tiles.map((t) => t.tile), changed);
    this.drawView();
  }

  /** Probe `i` (its light, weight and walls) into its tile's GPU layout. */
  private write(probes: LiveProbes, i: number): void {
    const gi = probes.gridOf(i);
    const t = this.tiles[gi]!;
    const g = probes.grids[gi]!;
    const [nx, ny, nz] = g.resolution;
    const l = i - g.first;
    const valid = probes.probeValid(i);
    t.tile.validity[l] = valid ? PROBE_VALID : PROBE_FILLED;
    const walls = probes.probeWalls(i, this.walls);
    const at = i * PROBE_FLOATS;
    const state = probes.state;
    const toHalf = THREE.DataUtils.toHalfFloat;
    // The file's values: the first band's twelve, then the walls (cut x, cut x × where, cut y, …).
    writePackedProbe(t.tile.packed, l % nx, Math.floor(l / nx) % ny, Math.floor(l / (nx * ny)), nz, probeWeight(t.tile.validity[l]!), (src) => {
      if (src < 12) return toHalf(state[at + src]!);
      if (src >= WALLS && src < WALLS + 6) {
        const k = src - WALLS;
        return toHalf(k % 2 === 0 ? walls[k]! : walls[k - 1]! * walls[k]!);
      }
      return 0;
    });
    t.dirty = true;
  }

  private drawView(): void {
    const light = this.probes.light();
    if (!this.viewOn || light === null) return;
    if (this.view?.light !== light) {
      this.clearView();
      this.view = { light, view: createProbeDebugView(light) };
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
