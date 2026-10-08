/**
 * A streamed terrain on the page (no renderer: the view's own bookkeeping):
 * only the tiles in its render ring are read and given a texture layer, the
 * ring reaching at least where tiles draw only their coarsest level; its
 * overview's tiles are drawn wherever a full tile is not (and give way the
 * frame one is up); a tile past the ring goes only once its overview tile is
 * there, at the resource manager's settle; its decoded copy goes with it.
 */
import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { createResourceManager, encodeTerrainOverview, encodeTerrainTile, flatTerrainTile, terrainOverviewTile, wrapTerrainOverview, wrapTerrainTile, type TerrainComponent } from '@thirdlight/runtime';

import { TerrainTileStore } from './terrain-tile-store';
import { TerrainView } from './terrain-view';
import { CullView } from './view-cull';
import { PageWorldStream } from './world-stream';

const MB = 1024 * 1024;
const S = 65;
const SPACING = 2;
const SIZE = (S - 1) * SPACING;

describe('terrain view streaming', () => {
  it('reads only the tiles round the eye, draws the overview elsewhere, and lets far tiles go once the overview covers them', async () => {
    const blobs = new Map<string, Uint8Array>();
    const tiles: TerrainComponent['tiles'] = [];
    // 12 tiles of 128 m along x, each a different flat height.
    for (let x = 0; x < 12; x++) {
      const t = flatTerrainTile(S, 1000 + x * 100);
      const digest = String.fromCharCode(97 + x).repeat(64);
      blobs.set(digest, wrapTerrainTile('none', encodeTerrainTile(t), encodeTerrainTile(t).payload));
      tiles.push({ x, z: 0, data: digest });
    }
    const overview = encodeTerrainOverview(tiles.map((r, i) => ({ x: r.x, z: r.z, tile: terrainOverviewTile(flatTerrainTile(S, 1000 + i * 100)) })));
    blobs.set('f'.repeat(64), wrapTerrainOverview('none', overview.length, overview));
    const reads: string[] = [];
    const store = new TerrainTileStore({ read: async (d) => (reads.push(d), blobs.get(d)!.slice().buffer) });
    const released: string[] = [];
    store.onRelease((d) => released.push(d));
    const resources = createResourceManager();
    const stream = new PageWorldStream({ budgetBytes: 512 * MB, resources });
    const listed = new Set<string>();
    const view = new TerrainView({ tiles: store, materials: null, place: (mesh, shown) => void (shown ? listed.add(mesh.name) : listed.delete(mesh.name)), shapeChanged: () => undefined, changed: () => undefined, lodBias: () => 1, stream });
    const comp: TerrainComponent = { tileSamples: S, spacing: SPACING, heightRange: [0, 100], tiles, streaming: { render: 50, hysteresis: 10 }, overview: 'f'.repeat(64) };
    view.setTerrain('ground', comp, [0, 0, 0], { components: {}, materials: null, overrides: null });
    const cull = new CullView();
    const frame = async (x: number): Promise<void> => {
      const cam = new THREE.PerspectiveCamera(60, 1, 0.1, 10_000);
      cam.position.set(x, 50, 64);
      cam.updateMatrixWorld();
      cull.set(cam);
      stream.beginFrame(cull.eye);
      view.update(cull, null);
      await new Promise((r) => setTimeout(r, 0));
      resources.settle();
    };
    for (let i = 0; i < 4; i++) await frame(64);
    const d = view.diagnostics();
    // 65 samples at 2 m: leaf nodes of 32 m, levels 32/64/128 m; the coarsest starts past 2 × 144 m = 288 m, so the
    // ring reaches 288 m (more than the 50 asked for): tiles 0–2 (the eye at 64 m, tile 2 starts 192 m away).
    expect(d.streamed!.ringMetres).toBe(288);
    expect(d.streamed!.resident).toBe(3);
    expect(d.tilesDrawn).toBe(3);
    // The overview: all 12 read, 9 drawn (where the full tiles are not).
    expect(d.streamed!.overviewTiles).toBe(12);
    expect(d.streamed!.overviewDrawn).toBe(9);
    expect(reads.filter((r) => r !== 'f'.repeat(64)).sort()).toEqual(['a', 'b', 'c'].map((c) => c.repeat(64)));
    // Both draw: the terrain's page (made when its first tile came near) and the overview's are in the scene.
    expect([...listed].sort()).toEqual(['terrain:ground', 'terrain:ground#overview']);
    // The eye moves 1 km along x: tiles 0–2 go (past 288 + 28.8 m), the ones round it come.
    for (let i = 0; i < 4; i++) await frame(1064);
    const e = view.diagnostics();
    expect(e.tilesDrawn).toBe(e.streamed!.resident);
    expect(released.sort()).toEqual(['a', 'b', 'c'].map((c) => c.repeat(64)));
    expect(store.tile('a'.repeat(64))).toBeUndefined();
    expect(e.streamed!.overviewDrawn).toBe(12 - e.streamed!.resident);
    expect(resources.observe().frees['terrain-tile']).toBe(3);
    view.dispose();
  });
});
