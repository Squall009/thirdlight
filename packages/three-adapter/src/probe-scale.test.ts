/**
 * Probe tiles at world scale: the texture layout, the spatial index, the
 * residency around the camera and the incremental upload, and a synthetic
 * 2 km world of 512 tiles through the whole CPU path (load, pick, upload)
 * with an upload-recording renderer. Pixels are the e2e's (lightmaps.e2e).
 */
import { createResourceManager, placeProbeGrids, type ProbeGridRecord } from '@thirdlight/runtime';
import * as THREE from 'three/webgpu';
import { describe, expect, it } from 'vitest';

import { encodePng16, packProbeTexels } from './probe-artifact';
import { ProbeTileStore, type ProbeTileForGpu, type ProbeUploadRenderer } from './probe-atlas';
import { createProbeLightingHost } from './probe-grids';
import { buildProbeIndex, PROBE_INDEX_MAX_CELLS, probeRowAt, type ProbeIndexTile } from './probe-index';
import { packedProbeDepth, ProbeAtlasLayout, probeFade, type PackedProbeTile } from './probe-pack';
import { pickResidentProbeTiles } from './probe-residency';

/** A renderer that records what the store puts on the GPU (both backends' paths). */
function recordingRenderer(webgl: boolean): ProbeUploadRenderer & { writes: { bytes: number; at: [number, number] }[]; copies: number; inits: number } {
  const writes: { bytes: number; at: [number, number] }[] = [];
  const r = {
    writes,
    copies: 0,
    inits: 0,
    backend: {
      isWebGLBackend: webgl,
      device: { queue: { writeTexture: (dst: { origin: { x: number; y: number } }, data: ArrayBufferView) => writes.push({ bytes: data.byteLength, at: [dst.origin.x, dst.origin.y] }) } },
      get: () => ({ texture: {} }),
      copyTextureToTexture: (src: THREE.Texture, _dst: THREE.Texture, _region: null, at: THREE.Vector3) => writes.push({ bytes: ((src.image as { data: Uint16Array }).data).byteLength, at: [at.x, at.y] }),
    },
    initTexture: () => void r.inits++,
    copyTextureToTexture: () => void r.copies++,
  };
  return r;
}

function packedOf(resolution: readonly number[]): PackedProbeTile {
  const [nx, ny] = resolution as [number, number, number];
  const depth = packedProbeDepth(resolution);
  return { data: new Uint16Array(nx * ny * depth * 4), nx, ny, depth };
}

function tileFor(key: string, grid: ProbeGridRecord): ProbeTileForGpu {
  return { key, sceneId: 's', grid, packed: packedOf(grid.resolution), validity: new Float32Array(0) };
}

/** Tiles over a box at 2 m (the placement's own tiling), as records. */
function worldTiles(size: number, height: number): ProbeGridRecord[] {
  return placeProbeGrids({ min: [-size / 2, 0, -size / 2], max: [size / 2, height, size / 2] }, 2).map((b, i) => ({ ...b, asset: `t${i}` }));
}

describe('probe texture layout', () => {
  it('places tiles first fit, gives rows back, and grows without moving placed tiles', () => {
    const layout = new ProbeAtlasLayout(65, 402, 2048);
    expect(layout.place(5)).toBeNull();
    expect(layout.grow(5, Infinity)).toBe(true);
    const a = layout.place(5)!;
    expect(a).toEqual({ x: 0, y: 0 });
    // Growing (rows, then columns) keeps `a` where it is.
    const places = [a];
    for (let i = 0; i < 40; i++) {
      let at = layout.place(9);
      if (at === null) {
        expect(layout.grow(9, Infinity)).toBe(true);
        at = layout.place(9)!;
      }
      places.push(at);
    }
    expect(places[0]).toEqual({ x: 0, y: 0 });
    expect(new Set(places.map((p) => `${p.x},${p.y}`)).size).toBe(places.length);
    expect(layout.width).toBeLessThanOrEqual(2048);
    expect(layout.height).toBeLessThanOrEqual(2048);
    // A freed run is used again.
    layout.release(places[3]!, 9);
    expect(layout.place(9)).toEqual(places[3]);
    // No growth past the budget.
    const small = new ProbeAtlasLayout(65, 402, 2048);
    expect(small.grow(5, small.bytes(1, 4))).toBe(false);
    expect(small.grow(5, small.bytes(1, 5))).toBe(true);
  });
});

describe('probe spatial index', () => {
  it("finds the same tile as testing every tile, with a few entries a cell over a lattice", () => {
    const grids = worldTiles(600, 40);
    const tiles: ProbeIndexTile[] = grids.map((g, row) => ({ row, min: g.min, max: g.max, fade: probeFade(g) }));
    const index = buildProbeIndex(tiles);
    expect(index.cells).toBeLessThanOrEqual(PROBE_INDEX_MAX_CELLS);
    let most = 0;
    for (let c = 0; c < index.cells; c++) most = Math.max(most, index.data[c * 4 + 1]!);
    expect(most).toBeLessThanOrEqual(8);
    const boxes = new Float32Array(grids.length * 6);
    grids.forEach((g, i) => boxes.set([...g.min, ...g.max], i * 6));
    // Every tile, the old way: the first containing, else the nearest; and how far out it is.
    const brute = (p: THREE.Vector3): { row: number; out: number } => {
      let best = -1;
      let bestOut = Infinity;
      for (let k = 0; k < grids.length; k++) {
        const g = grids[k]!;
        const out = Math.hypot(...[0, 1, 2].map((a) => Math.max(g.min[a]! - p.getComponent(a), 0, p.getComponent(a) - g.max[a]!)));
        if (out < bestOut) {
          best = k;
          bestOut = out;
          if (out <= 0) break;
        }
      }
      return { row: best, out: bestOut };
    };
    let seed = 7;
    const rnd = (): number => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    for (let i = 0; i < 4000; i++) {
      const p = new THREE.Vector3(rnd() * 640 - 320, rnd() * 50 - 5, rnd() * 640 - 320);
      const want = brute(p);
      // Within the fade the same tile; past it the light is 0 either way (the index may name none).
      if (want.out <= probeFade(grids[want.row]!)) expect(probeRowAt(index, boxes, p)).toBe(want.row);
    }
  });

  it('a sparse spread of tiles keeps the grid within its cells (longer lists, no tile left out)', () => {
    const far: ProbeIndexTile[] = Array.from({ length: 50 }, (_, i) => ({ row: i, min: [i * 10_000, 0, 0], max: [i * 10_000 + 4, 4, 4], fade: 1 }));
    const index = buildProbeIndex(far);
    expect(index.cells).toBeLessThanOrEqual(PROBE_INDEX_MAX_CELLS);
    const boxes = new Float32Array(far.length * 6);
    far.forEach((t, i) => boxes.set([...t.min, ...t.max], i * 6));
    for (const t of far) expect(probeRowAt(index, boxes, new THREE.Vector3(t.min[0]! + 2, 2, 2))).toBe(t.row);
  });
});

describe('probe residency', () => {
  it('holds the tiles nearest the camera within the budget, whatever their scene or order', () => {
    const tiles = Array.from({ length: 20 }, (_, i) => ({ key: `k${i}`, min: [i * 100, 0, 0], max: [i * 100 + 100, 10, 100], bytes: 10 }));
    // Listed far-first: order does not decide.
    const listed = [...tiles].reverse();
    const near = pickResidentProbeTiles(listed, [50, 5, 50], 50, new Set(), 0);
    expect([...near.wanted].sort()).toEqual(['k0', 'k1', 'k2', 'k3', 'k4']);
    expect(near.beyond).toBe(15);
    const there = pickResidentProbeTiles(listed, [1550, 5, 50], 50, new Set(), 0);
    expect([...there.wanted].sort()).toEqual(['k13', 'k14', 'k15', 'k16', 'k17']);
    // Within the hysteresis the resident set stays.
    const stay = pickResidentProbeTiles(listed, [1560, 5, 50], 50, there.wanted, 50);
    expect(stay.wanted).toEqual(there.wanted);
    // Everything fits: all of it.
    expect(pickResidentProbeTiles(listed, [0, 0, 0], 1000, new Set(), 0)).toMatchObject({ beyond: 0 });
  });
});

describe('probe tile store', () => {
  for (const webgl of [false, true]) {
    it(`uploads only a tile that arrives and frees the place of one that goes (${webgl ? 'WebGL 2' : 'WebGPU'})`, () => {
      const renderer = recordingRenderer(webgl);
      const store = new ProbeTileStore();
      const grids = worldTiles(400, 10);
      const all = grids.map((g, i) => tileFor(`k${i}`, g));
      const keys = (ts: ProbeTileForGpu[]) => new Set(ts.map((t) => t.key));
      store.sync(all.slice(0, 1), keys(all.slice(0, 1)), renderer, Infinity);
      expect(renderer.writes).toHaveLength(1);
      // The second arrival writes its own region only.
      store.sync(all.slice(0, 2), keys(all.slice(0, 2)), renderer, Infinity);
      expect(renderer.writes).toHaveLength(2);
      expect(renderer.writes[1]!.bytes).toBe(all[1]!.packed.data.byteLength);
      // All of them: each uploaded once, the texture grown a few times (copies on the GPU, not re-uploads).
      store.sync(all, keys(all), renderer, Infinity);
      expect(renderer.writes).toHaveLength(all.length);
      expect(renderer.copies).toBeLessThan(10);
      expect(store.count).toBe(all.length);
      // One goes: nothing uploaded; one comes back into the freed place.
      const gone = all[2]!;
      const placeOf = (key: string) => store.tiles.find((t) => t.key === key)!.at;
      const was = placeOf(gone.key);
      const rest = all.filter((t) => t !== gone);
      store.sync(rest, keys(rest), renderer, Infinity);
      expect(renderer.writes).toHaveLength(all.length);
      expect(store.count).toBe(all.length - 1);
      store.sync(all, keys(all), renderer, Infinity);
      expect(renderer.writes).toHaveLength(all.length + 1);
      expect(placeOf(gone.key)).toEqual(was);
      store.dispose();
    });
  }
});

describe('a 2 km world of probe tiles (synthetic)', () => {
  it('loads only what the budget holds near the camera, uploads each tile once, and moves with the camera', async () => {
    // 2048 m × 2048 m × 16 m at 2 m: 16 × 16 tiles in two layers (the ground band and above).
    const grids = worldTiles(2048, 16);
    expect(grids.length).toBe(512);
    // One file per tile shape, shared (the bytes are what a tile's file holds).
    const files = new Map<string, Uint8Array>();
    for (const g of grids) {
      const k = g.resolution.join('x');
      if (files.has(k)) continue;
      const n = g.resolution[0] * g.resolution[1] * g.resolution[2];
      const packed = packProbeTexels(new Float32Array(n * 27).fill(0.2), new Float32Array(n).fill(1));
      files.set(k, await encodePng16(packed.width, packed.height, packed.samples));
    }
    const byAsset = new Map(grids.map((g) => [g.asset, files.get(g.resolution.join('x'))!]));
    let reads = 0;
    const loadBytes = async (asset: string): Promise<Uint8Array> => (reads++, byAsset.get(asset)!);
    const resources = createResourceManager({ schedule: (f) => queueMicrotask(f) });
    const scene = new THREE.Scene();
    const problems: string[] = [];
    const host = createProbeLightingHost(scene, resources, loadBytes, { onProblem: (code) => problems.push(code) });
    host.setBakes({ world: { probes: { grids, createdAt: '2026-10-07T00:00:00.000Z' } } });
    host.follow(['world']);
    const renderer = recordingRenderer(false);
    const camera = new THREE.Object3D();
    // Until every wanted tile arrived (the reads and inflates are asynchronous).
    const settle = async (): Promise<void> => {
      for (let i = 0; i < 2000; i++) {
        const o = host.observe()!;
        if (o.loaded === o.resident) return;
        await new Promise((r) => setTimeout(r, 1));
      }
    };
    const t0 = performance.now();
    host.beforeFrame(renderer, camera);
    await settle();
    host.beforeFrame(renderer, camera);
    const loadMs = performance.now() - t0;
    const o = host.observe()!;
    expect(o.tiles).toBe(512);
    expect(o.beyondBudget).toBeGreaterThan(0);
    expect(o.resident).toBe(o.sampled);
    expect(o.loaded).toBe(o.resident);
    expect(o.unplaced).toBe(0);
    expect(o.textureBytes).toBeLessThanOrEqual(o.budgetBytes! * 1.25 + 4 * 1048576);
    expect(renderer.writes).toHaveLength(o.resident!);
    expect(problems).toEqual(['probe_budget']);
    // The camera's tile and its neighbours are resident.
    const light = host.light()!;
    expect(probeRowAt(light.store.indexOf, light.store.boxes, new THREE.Vector3(0, 1, 0))).toBeGreaterThanOrEqual(0);
    expect(probeRowAt(light.store.indexOf, light.store.boxes, new THREE.Vector3(1000, 1, 1000))).toBe(-1);
    // A frame without movement costs no pick, no upload.
    const writes = renderer.writes.length;
    const f0 = performance.now();
    for (let i = 0; i < 1000; i++) host.beforeFrame(renderer, camera);
    const idleUs = ((performance.now() - f0) / 1000) * 1000;
    expect(renderer.writes).toHaveLength(writes);
    // Walk to a corner: the tiles there come in, the ones behind go; each arrival uploads once.
    const p0 = performance.now();
    camera.position.set(900, 2, 900);
    camera.updateMatrixWorld();
    host.beforeFrame(renderer, camera);
    const pickMs = performance.now() - p0;
    await settle();
    host.beforeFrame(renderer, camera);
    expect(probeRowAt(light.store.indexOf, light.store.boxes, new THREE.Vector3(1000, 1, 1000))).toBeGreaterThanOrEqual(0);
    expect(probeRowAt(light.store.indexOf, light.store.boxes, new THREE.Vector3(0, 1, 0))).toBe(-1);
    const after = host.observe()!;
    expect(after.unplaced).toBe(0);
    expect(renderer.writes.length - writes).toBe(after.uploads! - o.uploads!);
    const heldBytes = light.store.tiles.reduce((s, t) => s + t.grid.resolution[0] * t.grid.resolution[1] * packedProbeDepth(t.grid.resolution) * 8, 0);
    console.log(
      `probe world: ${o.tiles} tiles, ${o.resident} resident (${o.beyondBudget} beyond the ${Math.round(o.budgetBytes! / 1048576)} MB budget), ` +
        `load ${loadMs.toFixed(0)} ms CPU (${reads} reads), texture ${(o.textureBytes! / 1048576).toFixed(1)} MB, held packed ${(heldBytes / 1048576).toFixed(1)} MB, ` +
        `index ${o.indexCells} cells / ${o.indexEntries} entries, idle frame ${idleUs.toFixed(2)} µs, re-pick ${pickMs.toFixed(2)} ms, walk uploads ${after.uploads! - o.uploads!}`,
    );
    host.dispose();
  }, 120_000);
});
