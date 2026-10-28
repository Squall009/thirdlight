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
import { BlockGrid, PROBE_VALIDITY_THRESHOLD, TerrainField, buildRoomGraph, decodeDistanceBricks, type ArchitectureRoomPlan, type BlockType, type TerrainComponent, type TerrainTile } from '@thirdlight/runtime';

import { probeUpdateCpu } from '../../packages/three-adapter/src/surface-probe-cpu';
import { PROBE_FLOATS } from '../../packages/three-adapter/src/surface-probes';
import { SURFACE_PAGE_TEXELS } from '../../packages/three-adapter/src/surface-cache-atlas';
import { TERRAIN_RINGS_MAX, TERRAIN_RING_TEXELS } from '../../packages/three-adapter/src/surface-cache-terrain';

import { GpuResolve } from '../../packages/three-adapter/src/surface-resolve-gpu';
import { SurfaceCacheHost, type SurfaceHostModel } from '../../packages/three-adapter/src/surface-cache-host';
import type { CacheLight } from '../../packages/three-adapter/src/surface-changes';
import { SHADOW_TRACE, lightFrameOf } from '../../packages/three-adapter/src/surface-light-pass';
import { SurfaceLightRuntime } from '../../packages/three-adapter/src/surface-light-runtime';
import { lightFrameCpu } from '../../packages/three-adapter/src/surface-light-cpu';
import { splitLightFrame } from '../../packages/three-adapter/src/surface-light-frame';
import { SurfaceScene } from '../../packages/three-adapter/src/surface-cache-scene';
import { packResolveTable, resolveHitCpu } from '../../packages/three-adapter/src/surface-resolve';
import type { TracerDevice } from '../../packages/three-adapter/src/tracer-gpu';
import { RAY_FLOATS, packTraceScene } from '../../packages/three-adapter/src/tracer-scene';
import { opaqueByBlockTypes, traceBlockLayerOf, traceModelInstancesOf, traceTerrainOf } from '../../packages/three-adapter/src/tracer-sources';
import { invertAffine } from '../../packages/three-adapter/src/tracer-words';

type V3 = [number, number, number];

const roomGraphs = new WeakMap<object, ReturnType<typeof buildRoomGraph>>();
/** The input's room as the room culling hands it to light: its doorway open or shut. */
function roomsOf(r: NonNullable<RelightInput['rooms']>): { graph: ReturnType<typeof buildRoomGraph>; open: (p: number) => boolean; version: number } {
  let graph = roomGraphs.get(r);
  if (graph === undefined) roomGraphs.set(r, (graph = buildRoomGraph([{ id: 'house', origin: [0, 0, 0], rooms: [r.plan] }])));
  const g = graph;
  return { graph: g, open: (p) => g.portals[p]!.kind !== 'opening' || r.doorOpen, version: 0 };
}

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
  /** A room on the block layer (generated architecture's) and whether its doorway is open (null: no rooms). */
  rooms: { plan: ArchitectureRoomPlan; doorOpen: boolean } | null;
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
      ...(input.rooms !== null ? { rooms: () => roomsOf(input.rooms!) } : {}),
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
  const rt = await SurfaceLightRuntime.create(device as TracerDevice, host);
  const pass = rt.pass;
  let timed: ((ms: number, t: number, parts: readonly number[]) => void) | null = null;
  rt.onTimed = (ms, t, parts) => timed?.(ms, t, parts);
  let probeTimed: ((ms: number, passes: readonly number[]) => void) | null = null;
  rt.onProbeTimed = (ms, _n, passes) => probeTimed?.(ms, passes);
  let lights = input.lights;
  const loop = async (maxMs: number): Promise<Record<string, unknown>> => {
    const t0 = performance.now();
    const gpuMs: number[] = [];
    const cpuMs: number[] = [];
    const counts: number[] = [];
    const intervals: number[] = [];
    const passMs: number[][] = [];
    const perTexel: number[] = [];
    timed = (ms, t, parts) => {
      gpuMs.push(ms);
      passMs.push([...parts]);
      perTexel.push((ms * 1e6) / t);
    };
    const probeMs: number[] = [];
    const probePassMs: number[][] = [];
    probeTimed = (ms, passes) => {
      probeMs.push(ms);
      probePassMs.push([...passes]);
    };
    const updates0 = host.probes.diagnostics().updates;
    let probesMs: number | null = null;
    let directMs: number | null = null;
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
      counts.push(host.slicesThisFrame().reduce((n, s) => n + s.to - s.from, 0));
      // The page's own runtime: the frame's rays held to the GPU budget, the light written into the cache's textures.
      rt.frame(lights, c0);
      cpuMs.push(performance.now() - c0);
      frames += 1;
      if (roomMs === null && input.room !== null && !roomStale()) {
        roomMs = performance.now() - t0;
        roomFrames = frames;
      }
      const d = host.diagnostics();
      const direct = d.preparing === 0 && d.reading === 0 && d.tiles.resident === d.tiles.offered && d.tiles.offered > 0 && d.relight.settled;
      if (direct && directMs === null) directMs = performance.now() - t0;
      if (direct && d.probes.settled) {
        probesMs = performance.now() - t0;
        break;
      }
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
      probePassMsMedian: [0, 1, 2, 3].map((i) => [...probePassMs.map((p) => p[i]!)].sort((a, b) => a - b)[Math.floor(probePassMs.length / 2)] ?? null),
      passMsMedian: [0, 1, 2].map((i) => [...passMs.map((p) => p[i]!)].sort((a, b) => a - b)[Math.floor(passMs.length / 2)] ?? null),
      nsPerTexelMedian: [...perTexel].sort((a, b) => a - b)[Math.floor(perTexel.length / 2)] ?? null,
      cpuMsMax: Math.max(...cpuMs),
      cpuMsMedian: [...cpuMs].sort((a, b) => a - b)[Math.floor(cpuMs.length / 2)],
      missed: intervals.filter((v) => v > 1.5 * (1000 / 60)).length,
      relight: d.relight,
      cache: { usedBytes: d.usedBytes, resident: d.tiles.resident, offered: d.tiles.offered, rings: d.rings },
      probesMs,
      directMs,
      probeMsMedian: probeMs.length > 0 ? [...probeMs].sort((a, b) => a - b)[Math.floor(probeMs.length / 2)] : null,
      probeMsMax: probeMs.length > 0 ? Math.max(...probeMs) : null,
      probeUpdates: d.probes.updates - updates0,
      probeCount: d.probes.probes,
      probesPerUpdate: d.probes.perUpdate,
      probeLayout: { bricks: d.probes.bricks, lit: d.probes.lit, moved: d.probes.moved, grids: d.probes.grids, placeMs: d.probes.placeMs, placeFrameMs: d.probes.placeFrameMs ?? d.probes.placeMs },
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
  // The GPU's light against its CPU twin on the same texels, rays and random sequence.
  host.relight.markAll();
  host.update(input.eye, performance.now());
  const all = lightFrameOf(host, lights.map((l) => ({ ...l, on: true })));
  const part = splitLightFrame(all, 1 << 17)[0]!.frame;
  pass.run(part);
  const gpuSeed = pass.lastSeed;
  const nt = part.slices.reduce((k, s) => k + s.texels, 0);
  const rb = device.createBuffer({ size: nt * 16, usage: 0x1 | 0x8 });
  const enc = device.createCommandEncoder();
  enc.copyBufferToBuffer(pass.irradiance, 0, rb, 0, nt * 16);
  device.queue.submit([enc.finish()]);
  await rb.mapAsync(0x1);
  const gpuE = new Float32Array(rb.getMappedRange().slice(0));
  rb.unmap();
  const cpuE = lightFrameCpu(part, trace, gpuSeed, SHADOW_TRACE);
  let lit = 0;
  let close = 0;
  for (let i = 0; i < nt; i += 1) {
    const g = gpuE[i * 4]! + gpuE[i * 4 + 1]! + gpuE[i * 4 + 2]!;
    const c = cpuE[i * 3]! + cpuE[i * 3 + 1]! + cpuE[i * 3 + 2]!;
    if (Math.max(g, c) <= 1e-6) continue;
    lit += 1;
    if (Math.abs(g - c) <= 0.02 * Math.max(g, c) + 1e-4) close += 1;
  }
  const probeTwin = await probesAgainstTwin(device, host, rt, packTraceScene(host.traceSource().source));
  rt.dispose();
  device.destroy();
  return { adapter: adapter.info?.description ?? adapter.info?.vendor ?? '', timed: pass.timed, cold, still, events, resolve: { rays: n, resolved, mismatches, kinds, tableBytes: table.words.byteLength }, light: { texels: nt, lit, within2pc: close }, probeTwin };
}

/**
 * One probe update on the GPU against its CPU twin on the same probes and
 * seed, the twin reading the cache's light from the atlas and rings read
 * back (the GPU's own texels at its hits).
 */
async function probesAgainstTwin(device: any, host: SurfaceCacheHost, rt: SurfaceLightRuntime, trace: ReturnType<typeof packTraceScene>): Promise<Record<string, number>> {
  const probes = host.probes;
  const before = probes.state.slice();
  const slots = Uint32Array.from({ length: Math.min(probes.count, 256) }, (_, i) => Math.floor((i * probes.count) / Math.min(probes.count, 256)));
  const { atlas, rings } = rt.textures;
  if (atlas === null || rings === null || slots.length === 0) return { probes: 0, lit: 0, within5pc: 0, meanShare: 0 };
  // The textures read back: every page layer of the atlas and every ring layer.
  const readLayers = async (tex: any, side: number, layers: number): Promise<Float32Array[]> => {
    const out: Float32Array[] = [];
    for (let l = 0; l < layers; l += 1) {
      const buf = device.createBuffer({ size: side * side * 8, usage: 0x1 | 0x8 });
      const enc = device.createCommandEncoder();
      enc.copyTextureToBuffer({ texture: tex, origin: { x: 0, y: 0, z: l } }, { buffer: buf, bytesPerRow: side * 8, rowsPerImage: side }, { width: side, height: side, depthOrArrayLayers: 1 });
      device.queue.submit([enc.finish()]);
      await buf.mapAsync(0x1);
      const half = new Uint16Array(buf.getMappedRange().slice(0));
      buf.unmap();
      buf.destroy();
      const f = new Float32Array(half.length);
      for (let i = 0; i < half.length; i += 1) {
        const h = half[i]!;
        const e = (h >> 10) & 31;
        const m = h & 1023;
        f[i] = (h & 0x8000 ? -1 : 1) * (e === 0 ? m * 2 ** -24 : e === 31 ? Infinity : (1 + m / 1024) * 2 ** (e - 15));
      }
      out.push(f);
    }
    return out;
  };
  const pages = await readLayers(atlas, SURFACE_PAGE_TEXELS, Math.ceil(host.cache.budgetBytes / (SURFACE_PAGE_TEXELS * SURFACE_PAGE_TEXELS * 8)));
  const ringSide = TERRAIN_RING_TEXELS;
  const ringLayers = await readLayers(rings, ringSide, Math.max(1, host.cache.ringTerrains().length) * TERRAIN_RINGS_MAX);
  const scene = host.resolveScene().scene;
  // The hit's texel as the GPU's resolve finds it (its CPU twin over the same tables), its light from the textures read back.
  rt.syncProbeInputs();
  const table = packResolveTable(scene, host.cache).words;
  const one = new Uint32Array(8);
  const onef = new Float32Array(one.buffer);
  const direct = (_p: unknown, _n: unknown, hit: Parameters<Parameters<typeof probeUpdateCpu>[0]['direct']>[2]): [number, number, number] => {
    onef[0] = hit.t;
    onef.set(hit.normal, 1);
    one[4] = (hit.kind | (hit.face << 8)) >>> 0;
    one[5] = hit.object;
    one[6] = hit.a0;
    one[7] = hit.a1;
    const [a, b] = resolveHitCpu(table, one, 0);
    const x = b & 0xffff;
    const y = b >>> 16;
    if (a >>> 30 === 1) {
      const d = pages[a & 0x3fffffff]!;
      const at = (y * SURFACE_PAGE_TEXELS + x) * 4;
      return [d[at]!, d[at + 1]!, d[at + 2]!];
    }
    if (a >>> 30 === 2) {
      const d = ringLayers[((a >>> 3) & 0x7ffffff) * TERRAIN_RINGS_MAX + (a & 7)]!;
      const at = (y * ringSide + x) * 4;
      return [d[at]!, d[at + 1]!, d[at + 2]!];
    }
    return [0, 0, 0];
  };
  // Both from one state: the probes as the CPU holds them, and (first) all dark, so only the cache's light and the sky count.
  const twin = async (dark: boolean): Promise<{ gpu: Float32Array; cpu: Float32Array }> => {
    if (dark) probes.state.fill(0);
    else probes.state.set(before);
    while (rt.probePass.busy) await frame();
    rt.syncProbeInputs();
    rt.probePass.reload();
    const start = probes.state.slice();
    const gpu = await new Promise<Float32Array>((resolve) => rt.probePass.run({ probes, slots, sky: rt.sky, rooms: host.rooms()?.words ?? null, atlas, rings, albedo: rt.textures.albedo!.buffer, albedoRingsAt: rt.textures.albedo!.ringsAt }, (v) => resolve(v)));
    probes.state.set(start);
    const cpu = probeUpdateCpu({ probes, slots, sky: rt.sky, rooms: host.rooms()?.words ?? null, seed: rt.probePass.lastSeed, scene: trace, direct });
    return { gpu, cpu };
  };
  const darkRun = await twin(true);
  const compare = (g: Float32Array, c: Float32Array): { lit: number; close: number; share: number } => {
    let lit = 0;
    let close = 0;
    let share = 0;
    for (let s = 0; s < slots.length; s += 1) {
      const a = g[s * PROBE_FLOATS]! + g[s * PROBE_FLOATS + 1]! + g[s * PROBE_FLOATS + 2]!;
      const b = c[s * PROBE_FLOATS]! + c[s * PROBE_FLOATS + 1]! + c[s * PROBE_FLOATS + 2]!;
      // Probes inside geometry (under the terrain, in a wall) start their rays where the two tracers may part: only valid ones are held to the twin.
      if (Math.max(a, b) <= 1e-6 || g[s * PROBE_FLOATS + 12]! > PROBE_VALIDITY_THRESHOLD || c[s * PROBE_FLOATS + 12]! > PROBE_VALIDITY_THRESHOLD) continue;
      lit += 1;
      const sh = Math.abs(a - b) / Math.max(b, 1e-6);
      share += sh;
      if (sh <= 0.05) close += 1;
    }
    return { lit, close, share: lit > 0 ? share / lit : 0 };
  };
  const dark = compare(darkRun.gpu, darkRun.cpu);
  const { gpu, cpu } = await twin(false);
  probes.state.set(before);
  const { lit, close, share } = compare(gpu, cpu);
  return { probes: slots.length, lit, within5pc: close, meanShare: share, darkLit: dark.lit, darkWithin5pc: dark.close, darkMeanShare: dark.share };
}

(window as unknown as { __tlRelight: unknown }).__tlRelight = { run };
