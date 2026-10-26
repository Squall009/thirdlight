/**
 * The surface cache's change tracking in a browser page (bundled by
 * relight-run.ts): the product's host (`SurfaceCacheHost`: residency, stale
 * marks, the per-frame budget) and its direct-light pass on a fresh WebGPU
 * device with the default limits, one update a frame at the display's cap.
 * The scene is made here from engine data (a `BlockGrid`, a `TerrainField`,
 * placed models' distance-field files); a light change or a sun step is
 * timed until the cache is settled again. The GPU resolve is held to its
 * CPU twin on the same hits.
 */
import { BlockGrid, TerrainField, decodeDistanceBricks, type BlockType, type TerrainComponent, type TerrainTile } from '@thirdlight/runtime';

import { GpuResolve } from '../../packages/three-adapter/src/surface-resolve-gpu';
import { SurfaceCacheHost, type SurfaceHostModel } from '../../packages/three-adapter/src/surface-cache-host';
import type { CacheLight } from '../../packages/three-adapter/src/surface-changes';
import { SurfaceLightPass, lightFrameOf } from '../../packages/three-adapter/src/surface-light-pass';
import { SurfaceScene } from '../../packages/three-adapter/src/surface-cache-scene';
import { packResolveTable, resolveHitCpu } from '../../packages/three-adapter/src/surface-resolve';
import type { TracerDevice } from '../../packages/three-adapter/src/tracer-gpu';
import { RAY_FLOATS, packTraceScene } from '../../packages/three-adapter/src/tracer-scene';
import { opaqueByBlockTypes, traceBlockLayerOf, traceModelInstancesOf, traceTerrainOf } from '../../packages/three-adapter/src/tracer-sources';
import { invertAffine } from '../../packages/three-adapter/src/tracer-words';

type V3 = [number, number, number];

export interface RelightInput {
  scene: 'door' | 'village';
  /** Block fills [x0, y0, z0, x1, y1, z1] (max exclusive) and the block. */
  fills: { box: number[]; block: string }[];
  grid: { min: V3; max: V3; cellSize: V3; origin: V3 };
  /** Terrain (null: none): its origin, samples a tile side, spacing, height range and bumps (x, z local, height m). */
  terrain: { origin: V3; samples: number; spacing: number; range: [number, number]; tiles: [number, number][]; bumps: [number, number, number][]; flat: [number, number, number] } | null;
  /** Placed static models: the file by asset and the world matrix (column-major). */
  models: { assetId: string; world: number[] }[];
  files: Record<string, string>;
  eye: V3;
  /** The lights at the start; `event` changes them. */
  lights: CacheLight[];
  event: 'lamp' | 'sun';
  rounds: number;
  budgetMs: number;
  cacheMiB: number;
  /** A box whose texels the change is about (the lamp's room): when they are lit, apart from the rest (null: none). */
  room: { min: V3; max: V3 } | null;
  /** GPU time (ms) a stand-in frame takes before each update (0: none): a game's frame holds the GPU's clock up. */
  loadMs: number;
}

/** A stand-in for a game's frame on the GPU: an ALU loop sized to take about `ms` (calibrated by timestamps as the clock settles). */
async function frameLoad(device: any, ms: number): Promise<{ run(): void; ms: number[] } | null> {
  if (ms <= 0) return null;
  const code = `@group(0) @binding(0) var<storage, read_write> O: array<f32>;
@group(0) @binding(1) var<uniform> N: vec4u;
@compute @workgroup_size(64) fn main(@builtin(global_invocation_id) g: vec3u) {
  var x = f32(g.x) * 1e-6;
  for (var i = 0u; i < N.x; i++) { x = fract(x * 1.0001 + 0.3183); }
  if (x > 2.0) { O[g.x] = x; }
}`;
  const pipe = device.createComputePipeline({ layout: 'auto', compute: { module: device.createShaderModule({ code }), entryPoint: 'main' } });
  const out = device.createBuffer({ size: 4 * 65536 * 4, usage: 0x80 });
  const uni = device.createBuffer({ size: 16, usage: 0x40 | 0x8 });
  const bind = device.createBindGroup({ layout: pipe.getBindGroupLayout(0), entries: [{ binding: 0, resource: { buffer: out } }, { binding: 1, resource: { buffer: uni } }] });
  const qs = device.createQuerySet({ type: 'timestamp', count: 2 });
  const res = device.createBuffer({ size: 16, usage: 0x200 | 0x4 });
  let iters = 256;
  const took: number[] = [];
  let reading = false;
  const run = (): void => {
    device.queue.writeBuffer(uni, 0, new Uint32Array([iters, 0, 0, 0]));
    const enc = device.createCommandEncoder();
    const p = enc.beginComputePass(reading ? {} : { timestampWrites: { querySet: qs, beginningOfPassWriteIndex: 0, endOfPassWriteIndex: 1 } });
    p.setPipeline(pipe);
    p.setBindGroup(0, bind);
    p.dispatchWorkgroups(4096);
    p.end();
    let read: any = null;
    if (!reading) {
      read = device.createBuffer({ size: 16, usage: 0x1 | 0x8 });
      enc.resolveQuerySet(qs, 0, 2, res, 0);
      enc.copyBufferToBuffer(res, 0, read, 0, 16);
    }
    device.queue.submit([enc.finish()]);
    if (read !== null) {
      reading = true;
      void read.mapAsync(0x1).then(() => {
        const t = new BigUint64Array(read.getMappedRange().slice(0));
        read.unmap();
        read.destroy();
        reading = false;
        const got = Number(t[1]! - t[0]!) / 1e6;
        took.push(got);
        // Toward the target as the clock moves.
        if (got > 0) iters = Math.max(16, Math.min(1 << 20, Math.round(iters * (0.5 + (0.5 * ms) / got))));
      });
    }
  };
  // Settle the size and the clock before measuring.
  for (let i = 0; i < 90; i += 1) {
    run();
    await frame();
  }
  took.length = 0;
  return { run, ms: took };
}

const TYPES: BlockType[] = [{ blockId: 'soil', shape: 'full' } as BlockType, { blockId: 'rock', shape: 'full' } as BlockType];
const bytesOf = (b64: string): Uint8Array => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
const frame = (): Promise<number> => new Promise((ok) => requestAnimationFrame(ok));

function terrainOf(t: NonNullable<RelightInput['terrain']>): TerrainField {
  const n = t.samples;
  const comp = { tileSamples: n, spacing: t.spacing, heightRange: t.range, tiles: t.tiles.map(([x, z]) => ({ x, z })) } as unknown as TerrainComponent;
  const tiles = new Map<string, TerrainTile>();
  const side = (n - 1) * t.spacing;
  for (const [tx, tz] of t.tiles) {
    const heights = new Uint16Array(n * n);
    for (let z = 0; z < n; z += 1) {
      for (let x = 0; x < n; x += 1) {
        const lx = tx * side + x * t.spacing;
        const lz = tz * side + z * t.spacing;
        let h = 0;
        for (const [bx, bz, bh] of t.bumps) h += bh * Math.exp(-((lx - bx) ** 2 + (lz - bz) ** 2) / (2 * 14 * 14));
        const d = Math.hypot(lx - t.flat[0], lz - t.flat[1]);
        const k = Math.min(1, Math.max(0, (d - t.flat[2]) / 10));
        h *= k * k * (3 - 2 * k);
        heights[z * n + x] = Math.round(((h - t.range[0]) / (t.range[1] - t.range[0])) * 65535);
      }
    }
    tiles.set(`${tx},${tz}`, { samples: n, heights, weights: null, holes: null, paint: null });
  }
  return new TerrainField(comp, t.origin, tiles);
}

async function run(input: RelightInput): Promise<Record<string, unknown>> {
  const gpu = (navigator as unknown as { gpu?: { requestAdapter(o: unknown): Promise<any> } }).gpu;
  const adapter = await gpu?.requestAdapter({ powerPreference: 'high-performance' });
  if (adapter === undefined || adapter === null) return { error: 'no WebGPU adapter' };
  const device = await adapter.requestDevice({ requiredFeatures: adapter.features.has('timestamp-query') ? ['timestamp-query'] : [] });
  const g = input.grid;
  const grid = new BlockGrid({ cellSize: g.cellSize, bounds: { min: g.min, max: g.max } });
  for (const f of input.fills) {
    const b = f.box;
    for (let y = b[1]!; y < b[4]!; y += 1) for (let z = b[2]!; z < b[5]!; z += 1) for (let x = b[0]!; x < b[3]!; x += 1) {
      grid.set(x, y, z, f.block === '' ? null : { block: f.block });
    }
  }
  const opaque = opaqueByBlockTypes(TYPES);
  const chunks: [string, number][] = [];
  for (let cz = Math.floor(g.min[2] / 16); cz * 16 < g.max[2]; cz += 1) for (let cx = Math.floor(g.min[0] / 16); cx * 16 < g.max[0]; cx += 1) chunks.push([`${cx},${cz}`, 1]);
  const field = input.terrain === null ? null : terrainOf(input.terrain);
  const files = new Map(Object.entries(input.files).map(([k, v]) => [k, bytesOf(v)]));
  const models: SurfaceHostModel[] = input.models.map((m, i) => ({ id: `m${i}`, assetId: m.assetId, version: 1, piece: null, world: m.world }));
  const budget = input.cacheMiB * 1024 * 1024;
  const host = new SurfaceCacheHost(
    {
      layers: () => [{ id: 'ground', origin: g.origin, grid, version: 1, chunks, opaque }],
      terrains: () => (field === null ? [] : [{ id: 'land', field }]),
      architecture: () => [],
      models: () => models,
      bricks: (assetId) => Promise.resolve(files.get(assetId)!),
    },
    budget,
    input.budgetMs,
  );
  host.setLive(true);
  const toLocal = (w: number[]): number[] => invertAffine([w[0]!, w[4]!, w[8]!, w[12]!, w[1]!, w[5]!, w[9]!, w[13]!, w[2]!, w[6]!, w[10]!, w[14]!]);
  const decoded = new Map([...files].map(([k, v]) => [k, decodeDistanceBricks(v)]));
  const trace = packTraceScene({
    blocks: [traceBlockLayerOf(grid, g.origin, opaque)],
    terrain: field === null ? [] : [traceTerrainOf(field, input.terrain!.range)!],
    bricks: input.models.flatMap((m) => traceModelInstancesOf(decoded.get(m.assetId)!, toLocal(m.world))),
  });
  const load = await frameLoad(device, input.loadMs);
  const pass = await SurfaceLightPass.create(device as TracerDevice);
  pass.setScene(trace);
  let lights = input.lights;
  let points: Float32Array | null = null;
  const loop = async (maxMs: number): Promise<Record<string, unknown>> => {
    const t0 = performance.now();
    const gpuMs: number[] = [];
    const cpuMs: number[] = [];
    const counts: number[] = [];
    const intervals: number[] = [];
    const passMs: number[][] = [];
    const perTexel: number[] = [];
    let last = await frame();
    let frames = 0;
    let roomMs: number | null = null;
    let roomFrames: number | null = null;
    const roomStale = (): boolean => input.room !== null && host.relight.unitsIn(input.room.min, input.room.max).some((k) => host.relight.isStale(k));
    for (;;) {
      const ts = await frame();
      intervals.push(ts - last);
      last = ts;
      load?.run();
      const c0 = performance.now();
      host.setLights(lights);
      host.update(input.eye, c0);
      const f = lightFrameOf(host, lights, points);
      points = f.points;
      cpuMs.push(performance.now() - c0);
      counts.push(f.slices.reduce((n, s) => n + s.texels, 0));
      pass.run(f, (ms, t, parts) => {
        host.relight.report(ms, t);
        gpuMs.push(ms);
        passMs.push([...parts]);
        perTexel.push((ms * 1e6) / t);
      });
      frames += 1;
      if (roomMs === null && input.room !== null && !roomStale()) {
        roomMs = performance.now() - t0;
        roomFrames = frames;
      }
      const d = host.diagnostics();
      if (d.preparing === 0 && d.reading === 0 && d.tiles.resident === d.tiles.offered && d.tiles.offered > 0 && d.relight.settled) break;
      if (performance.now() - t0 > maxMs) break;
    }
    const wall = performance.now() - t0;
    // The last timestamps arrive after the last frame's work.
    for (let i = 0; i < 4; i += 1) await frame();
    const sorted = [...gpuMs].sort((a, b) => a - b);
    const d = host.diagnostics();
    return {
      frames,
      wallMs: wall,
      roomMs,
      roomFrames,
      loadMs: load === null ? null : [...load.ms].sort((a, b) => a - b)[Math.floor(load.ms.length / 2)] ?? null,
      settled: d.relight.settled,
      texels: counts.reduce((a, b) => a + b, 0),
      perFrame: counts,
      gpuMsMax: sorted.length > 0 ? sorted[sorted.length - 1] : null,
      gpuMsMedian: sorted.length > 0 ? sorted[Math.floor(sorted.length / 2)] : null,
      gpuMs,
      passMsMedian: [0, 1, 2].map((i) => [...passMs.map((p) => p[i]!)].sort((a, b) => a - b)[Math.floor(passMs.length / 2)] ?? null),
      nsPerTexelMedian: [...perTexel].sort((a, b) => a - b)[Math.floor(perTexel.length / 2)] ?? null,
      cpuMsMax: Math.max(...cpuMs),
      cpuMsMedian: [...cpuMs].sort((a, b) => a - b)[Math.floor(cpuMs.length / 2)],
      missed: intervals.filter((v) => v > 1.5 * (1000 / 60)).length,
      relight: d.relight,
      cache: { usedBytes: d.usedBytes, resident: d.tiles.resident, offered: d.tiles.offered, rings: d.rings },
    };
  };
  const cold = await loop(60000);
  // Settled and still: a frame costs nothing.
  const still = await (async () => {
    let work = 0;
    for (let i = 0; i < 30; i += 1) {
      await frame();
      host.setLights(lights);
      host.update(input.eye, performance.now());
      work += host.slicesThisFrame().length;
      load?.run();
    }
    return { framesWithWork: work };
  })();
  const events: Record<string, unknown>[] = [];
  for (let r = 0; r < input.rounds; r += 1) {
    if (input.event === 'lamp') {
      for (const on of [true, false]) {
        lights = lights.map((l) => (l.id === 'lamp' ? { ...l, on } : l));
        events.push({ change: on ? 'lamp on' : 'lamp off', ...(await loop(10000)) });
      }
    } else {
      // One step of the sun: 1° about the axis across its path.
      const a = ((r + 1) * Math.PI) / 180;
      lights = lights.map((l) => {
        if (l.kind !== 'directional') return l;
        const d = input.lights.find((x) => x.id === l.id)!.direction;
        const c = Math.cos(a);
        const s = Math.sin(a);
        return { ...l, direction: [d[0]! * c - d[1]! * s, d[0]! * s + d[1]! * c, d[2]!] };
      });
      events.push({ change: `sun step ${r + 1}`, ...(await loop(20000)) });
    }
  }
  // The GPU resolve against its CPU twin, on GPU hits of rays from round the eye.
  const scene = new SurfaceScene({
    blocks: [{ key: 'ground', grid, origin: g.origin, opaque, version: 65537, chunks: chunks.map(([k]) => k), trace: traceBlockLayerOf(grid, g.origin, opaque) }],
    terrain: field === null ? [] : [{ key: 'land', trace: traceTerrainOf(field, input.terrain!.range)! }],
    models: input.models.map((m, i) => ({ key: `m${i}`, worldToLocal: toLocal(m.world), bricks: decoded.get(m.assetId)!, version: 1 })),
  });
  const table = packResolveTable(scene, host.cache);
  const n = 65536;
  const rays = new Float32Array(n * RAY_FLOATS);
  let seed = 7;
  const rnd = (): number => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296);
  for (let i = 0; i < n; i += 1) {
    const d = [rnd() * 2 - 1, rnd() * 2 - 1.2, rnd() * 2 - 1];
    const l = Math.hypot(d[0]!, d[1]!, d[2]!);
    rays.set([input.eye[0] + (rnd() - 0.5) * 6, input.eye[1], input.eye[2] + (rnd() - 0.5) * 6, 0, d[0]! / l, d[1]! / l, d[2]! / l, 200], i * RAY_FLOATS);
  }
  const hits = await pass.tracer.trace(rays);
  const resolve = await GpuResolve.create(device as TracerDevice);
  resolve.setTable(table.words);
  const texels = await resolve.resolve(pass.tracer.hitsBuffer!, n);
  let resolved = 0;
  let mismatches = 0;
  const kinds: Record<number, number> = {};
  for (let i = 0; i < n; i += 1) {
    const want = resolveHitCpu(table.words, hits, i);
    if (want[0] !== 0) resolved += 1;
    const k = hits[i * 8 + 4]! & 255;
    kinds[k] = (kinds[k] ?? 0) + 1;
    if (want[0] !== texels[i * 2] || want[1] !== texels[i * 2 + 1]) mismatches += 1;
  }
  resolve.dispose();
  pass.dispose();
  device.destroy();
  return { adapter: adapter.info?.description ?? adapter.info?.vendor ?? '', timed: pass.timed, cold, still, events, resolve: { rays: n, resolved, mismatches, kinds, tableBytes: table.words.byteLength } };
}

(window as unknown as { __tlRelight: unknown }).__tlRelight = { run };
