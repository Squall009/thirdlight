/**
 * The surface cache's voxel charts made on a worker (`runVoxelChartWorker`,
 * through a real message port: the job's arrays cloned and handed over as a
 * browser worker's are) equal the page's for the same chunk, hidden surfaces
 * included (the occupancy round the chunk carried from the page's walk
 * table); and the host makes its voxel tiles from the worker's charts.
 */
import { mulberry32 } from '@thirdlight/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { OCCUPANCY, VOXEL_SIZE_M, WALK_BRICK_WORDS, WALK_PAGE_WORDS, WalkTable } from '@thirdlight/voxel';

import { SurfaceCacheHost } from './surface-cache-host';
import type { VoxelChartPort } from './surface-cache-host-voxels';
import { voxelChunkCharts, walkSolidAt, type VoxelChunkCharts, type VoxelTileMesh } from './surface-cache-voxels';
import { runVoxelChartWorker, solidBlocksOf, type VoxelChartReply, type VoxelChartRequest } from './voxel-chart-worker';

const EDGE = 32;
const CELL0: [number, number, number] = [32, 0, -64];

/** Ground 3 m up rolling by a metre over the chunk and a cell past it, and an upright wall. */
function mesh(): VoxelTileMesh {
  const pos: number[] = [];
  const idx: number[] = [];
  const n = 34;
  const h = (x: number, z: number): number => 3 + 0.5 * Math.sin(x * 0.4) + 0.4 * Math.cos(z * 0.3);
  for (let j = 0; j <= n; j++) for (let i = 0; i <= n; i++) pos.push(i * 0.5 - 0.5, h(i * 0.5, j * 0.5), j * 0.5 - 0.5);
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
    const a = j * (n + 1) + i;
    idx.push(a, a + n + 1, a + 1, a + 1, a + n + 1, a + n + 2);
  }
  const w = pos.length / 3;
  pos.push(8, 3, 2, 8, 6, 2, 8, 3, 10, 8, 6, 10);
  idx.push(w, w + 1, w + 2, w + 2, w + 1, w + 3);
  return { positions: Float32Array.from(pos), indices: Uint32Array.from(idx) };
}

/** Walk blocks round the chunk: the ground's body under 3 m, a solid slab over part of it (hiding its surface there), random cells in a neighbour, one block solid and one empty. */
function table(): WalkTable {
  const t = new WalkTable();
  const r = mulberry32(4);
  const cells = 2 * WALK_BRICK_WORDS;
  for (let bz = -3; bz <= -1; bz++) for (let by = -1; by <= 1; by++) for (let bx = 0; bx <= 2; bx++) {
    if (bx === 2 && by === 1) {
      t.set(0, bx, by, bz, { solid: OCCUPANCY.solid, light: OCCUPANCY.solid, page: null });
      continue;
    }
    if (by === 1) {
      t.set(0, bx, by, bz, { solid: OCCUPANCY.empty, light: OCCUPANCY.empty, page: null });
      continue;
    }
    const page = new Uint32Array(WALK_PAGE_WORDS);
    for (let x = 0; x < 32; x++) for (let z = 0; z < 32; z++) for (let y = 0; y < 32; y++) {
      const wy = by * 32 + y;
      const under = wy * VOXEL_SIZE_M < 2.6;
      const slab = bx === 1 && by === 0 && x < 12 && y >= 7 && y <= 9;
      const noise = bx === 0 && r() < 0.05;
      if (!(under || slab || noise)) continue;
      const i = (x * 32 + z) * 32 + y;
      page[cells + (i >>> 5)]! |= 1 << (i & 31);
    }
    t.set(0, bx, by, bz, { solid: OCCUPANCY.mixed, light: OCCUPANCY.mixed, page });
  }
  return t;
}

const stops: (() => void)[] = [];
afterEach(() => {
  for (const s of stops.splice(0)) s();
});

/** The chart worker on message ports, as a browser worker runs it. */
function portWorker(): VoxelChartPort {
  const ch = new MessageChannel();
  const listenOn = (port: MessagePort, cb: (m: unknown) => void): void => {
    port.addEventListener('message', (e) => cb((e as MessageEvent).data));
    port.start();
  };
  runVoxelChartWorker({ post: (m, t) => ch.port2.postMessage(m, [...(t ?? [])]), listen: (cb) => listenOn(ch.port2, cb) });
  const stop = (): void => {
    ch.port1.close();
    ch.port2.close();
  };
  stops.push(stop);
  return { post: (m, t) => ch.port1.postMessage(m, [...(t ?? [])]), listen: (cb) => listenOn(ch.port1, cb), onError: () => undefined, terminate: stop };
}

function plain(m: VoxelChunkCharts): unknown {
  return { charts: m.charts, frames: [...m.frames], samples: [...m.samples], cells: m.cells, keys: [...m.keys], chartOf: [...m.chartOf], offsets: [...m.offsets], cell0: [...m.cell0], edge: m.edge };
}

describe('voxel charts on a worker', () => {
  it('equal the page\'s for the same chunk, its hidden surfaces left out alike', async () => {
    const m = mesh();
    const t = table();
    const page = voxelChunkCharts(m.positions, m.indices, CELL0, EDGE, walkSolidAt(t.source()));
    const open = voxelChunkCharts(m.positions, m.indices, CELL0, EDGE);
    // The slab hides part of the ground: fewer cells charted than with nothing in front of it.
    expect(page.cells).toBeLessThan(open.cells - 40);
    const w = portWorker();
    const reply = await new Promise<VoxelChartReply>((done) => {
      w.listen((r) => done(r as VoxelChartReply));
      const req: VoxelChartRequest = { t: 'voxelCharts', job: 7, positions: Float32Array.from(m.positions), indices: Uint32Array.from(m.indices), cell0: CELL0, edge: EDGE, solid: solidBlocksOf(t, CELL0, EDGE) };
      w.post(req, [req.positions.buffer as ArrayBuffer, req.indices.buffer as ArrayBuffer, req.solid!.flags.buffer as ArrayBuffer, req.solid!.cells.buffer as ArrayBuffer]);
    });
    expect(reply.ok).toBe(true);
    if (!reply.ok) return;
    expect(reply.job).toBe(7);
    expect(plain(reply.made)).toEqual(plain(page));
  });

  it('the host makes its voxel tiles from the worker\'s charts', async () => {
    const m = mesh();
    const t = table();
    const host = new SurfaceCacheHost({ layers: () => [], terrains: () => [], architecture: () => [], models: () => [], bricks: () => null, voxelChartWorker: () => portWorker() }, 32 * 1024 * 1024);
    const src = walkSolidAt(t.source());
    host.voxels.set({ chunks: () => [{ key: 'w/1,0,-2', version: 1, cell0: CELL0, edge: EDGE, mesh: () => m }], walk: () => null, relightMs: 6.67, solidAt: src, solidBlocks: (c, e) => solidBlocksOf(t, c, e) });
    host.setLive(true);
    const eye = [CELL0[0] * VOXEL_SIZE_M + 8, 4, CELL0[2] * VOXEL_SIZE_M + 8];
    let now = performance.now();
    for (let f = 0; f < 40 && host.voxels.diagnostics().resident === 0; f++) {
      host.update(eye, (now += 300));
      await new Promise((r) => setTimeout(r, 5));
    }
    const d = host.voxels.diagnostics();
    expect(d.chartWorker).toBe(true);
    expect(d.charted).toBe(1);
    expect(d.resident).toBe(1);
    expect(d.workerMs).toBeGreaterThan(0);
    const made = (host.resolveScene().scene.resolveView().voxels[0]!).made!;
    expect(plain(made)).toEqual(plain(voxelChunkCharts(m.positions, m.indices, CELL0, EDGE, src)));
  });

  it('starts no worker on a page without voxel worlds, and its dispose ends the one it started', async () => {
    let started = 0;
    let ended = 0;
    const counted = (): VoxelChartPort => {
      started++;
      const w = portWorker();
      return { ...w, terminate: () => (ended++, w.terminate()) };
    };
    const deps = { layers: () => [], terrains: () => [], architecture: () => [], models: () => [], bricks: () => null, voxelChartWorker: counted };
    const plainPage = new SurfaceCacheHost(deps, 32 * 1024 * 1024);
    plainPage.setLive(true);
    let now = performance.now();
    for (let f = 0; f < 5; f++) plainPage.update([0, 2, 0], (now += 300));
    plainPage.voxels.dispose();
    expect(started).toBe(0);
    const m = mesh();
    const host = new SurfaceCacheHost(deps, 32 * 1024 * 1024);
    host.voxels.set({ chunks: () => [{ key: 'w/1,0,-2', version: 1, cell0: CELL0, edge: EDGE, mesh: () => m }], walk: () => null, relightMs: 6.67 });
    host.setLive(true);
    for (let f = 0; f < 3; f++) host.update([CELL0[0] * VOXEL_SIZE_M + 8, 4, CELL0[2] * VOXEL_SIZE_M + 8], (now += 300));
    expect(started).toBe(1);
    host.voxels.dispose();
    expect(ended).toBe(1);
  });
});
