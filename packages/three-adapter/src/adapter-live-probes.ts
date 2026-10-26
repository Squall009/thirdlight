/**
 * The live probes on the page (`surface-probes.ts`, updated by the light
 * runtime's probe pass) as the probe lighting draws them: while the
 * surface cache's light is live, the probes' grids stand in for the bakes'
 * probe tiles (`ProbeLightingHost.setLive`), so every lit material — moving
 * objects, foliage and ground cover among them — reads bounced light from
 * the live cache through the probe sampling it always used.
 *
 * - A grid whose probes changed is packed again (the bake's layout:
 *   `packProbeTexels`, `packProbeTile`) and uploaded in place, at most
 *   every `LIVE_TILE_MS`.
 * - The sky the probes see (`SkyProbe`) is looked at here; when it
 *   changes every probe is stale.
 * - `?probesView=1` on the page draws the probes (the editor's probe debug
 *   view): each a small sphere lit by its own light.
 */
import type * as THREE from 'three';

import { pageSearch } from './renderer-factory';
import { packProbeTexels } from './probe-artifact';
import type { ProbeTileForGpu } from './probe-atlas';
import { createProbeDebugView, type ProbeDebugView } from './probe-debug';
import type { ProbeLightingHost } from './probe-grids';
import type { ProbeLighting } from './probe-lighting';
import { packProbeTile } from './probe-pack';
import type { SurfaceCacheHost } from './surface-cache-host';
import { SkyProbe } from './surface-probe-sky';
import type { SurfaceLightRuntime } from './surface-light-runtime';

/** Shortest time (ms) between two uploads of one grid's probes. */
export const LIVE_TILE_MS = 200;

export class AdapterLiveProbes {
  private readonly sky = new SkyProbe();
  private skyVersion = -1;
  private layout = -1;
  private readonly tiles = new Map<number, ProbeTileForGpu>();
  private readonly packedAt = new Map<number, number>();
  private pending = new Set<number>();
  private on = false;
  private viewOn: boolean;
  private view: { light: ProbeLighting; view: ProbeDebugView } | null = null;

  constructor(private readonly host: SurfaceCacheHost, private readonly probes: ProbeLightingHost, private readonly scene: THREE.Scene) {
    this.viewOn = new URLSearchParams(pageSearch()).get('probesView') === '1';
  }

  /** After the light runtime's frame (null: not live; the bakes' tiles come back). */
  frame(renderer: unknown, runtime: SurfaceLightRuntime | null, now = performance.now()): void {
    const probes = this.host.probes;
    if (runtime === null || probes.count === 0) {
      if (this.on) this.probes.setLive(null, new Set());
      this.on = false;
      this.layout = -1;
      return;
    }
    this.sky.update(renderer, this.scene as never, now);
    if (this.sky.version !== this.skyVersion) {
      this.skyVersion = this.sky.version;
      runtime.sky = this.sky.coefficients.slice();
      probes.markBox(null, null);
    }
    if (probes.layout !== this.layout) {
      this.layout = probes.layout;
      this.tiles.clear();
      this.packedAt.clear();
      this.pending = new Set(probes.grids.map((_, i) => i));
    }
    for (const g of probes.takeChanged()) this.pending.add(g);
    const changed = new Set<string>();
    for (const g of [...this.pending]) {
      if (now - (this.packedAt.get(g) ?? -Infinity) < LIVE_TILE_MS) continue;
      const t = probes.tileOf(g);
      const samples = packProbeTexels(t.sh, t.validity, t.walls).samples;
      const grid = { min: [...t.grid.min] as [number, number, number], max: [...t.grid.max] as [number, number, number], resolution: [...t.grid.resolution] as [number, number, number], asset: '' };
      const key = `live:${t.grid.key}`;
      this.tiles.set(g, { key, sceneId: '', grid, packed: packProbeTile(grid, samples, t.validity), validity: t.validity });
      this.packedAt.set(g, now);
      this.pending.delete(g);
      changed.add(key);
    }
    if (changed.size > 0 || !this.on) {
      this.probes.setLive([...this.tiles.keys()].sort((a, b) => a - b).map((g) => this.tiles.get(g)!), changed);
      this.on = true;
    }
    this.drawView();
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
