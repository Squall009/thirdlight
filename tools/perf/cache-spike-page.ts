/**
 * The surface-cache spike in the page (cache-spike-run.ts drives it): a
 * dynamic lightmap for one block layer, made and lit on the export's own
 * WebGPU device and drawn by the block material's existing lightmap input.
 *
 * - The renderer and the scenes three draws come from three's devtools
 *   channel (`__THREE_DEVTOOLS__`), as frame-probe.ts reads them: no hook in
 *   the product.
 * - The layer's chunk meshes carry the bake's UV1 layout: one slot per (cell,
 *   facing). Each slot is read back from the mesh (its cell face in world
 *   space), every slot of every chunk gets a P × P tile in one rgba16float
 *   atlas, the meshes' UV1 is moved onto their tiles, and the atlas becomes
 *   their `lightMap` (irradiance, intensity 1).
 * - A light change makes a list of stale texels; each frame a compute pass
 *   lights the next budget's worth of them (timestamped) until none are left.
 *
 * The functions are serialized into the page: they must not close over anything.
 */

/** Install with `addInitScript(installCacheSpikeHook)` before the page's scripts. */
export function installCacheSpikeHook(): void {
  const w = window as unknown as { __tlSpike?: Record<string, unknown>; __THREE_DEVTOOLS__?: EventTarget };
  if (w.__tlSpike !== undefined) return;
  const S: Record<string, unknown> = { renderer: null, scenes: [] as unknown[], frames: [] as number[] };
  w.__tlSpike = S;
  const hub = w.__THREE_DEVTOOLS__ ?? new EventTarget();
  w.__THREE_DEVTOOLS__ = hub;
  hub.addEventListener('observe', (ev) => {
    const r = (ev as CustomEvent).detail as { render?: (s: unknown, c: unknown) => unknown; backend?: unknown };
    if (r === null || typeof r !== 'object' || typeof r.render !== 'function' || r.backend === undefined || S['renderer'] !== null) return;
    S['renderer'] = r;
    const render = r.render;
    r.render = function (this: unknown, scene: unknown, camera: unknown) {
      const list = S['scenes'] as unknown[];
      if ((scene as { isScene?: boolean }).isScene === true && !list.includes(scene)) list.push(scene);
      return render.call(this, scene, camera);
    };
  });
  const tick = (t: number): void => {
    const f = S['frames'] as number[];
    f.push(t);
    if (f.length > 4000) f.splice(0, 2000);
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

/** What the run hands the page (plain data). */
export interface SpikeSetup {
  wgsl: string;
  /** Texels per slot side (the face's inner texels are P × (1 − 2 × margin)). */
  P: number;
  margin: number;
  grid: { dims: [number, number, number]; bits: number[] };
  terrain: { origin: [number, number, number]; spacing: number; cells: number; levels: number; data: number[]; patch: { min: [number, number]; texel: number; texels: number } };
  sun: { toLight: [number, number, number]; radius: number; irradiance: [number, number, number]; rays: number };
  rect: { centre: [number, number, number]; eu: [number, number, number]; ev: [number, number, number]; radiance: [number, number, number]; range: number; rays: number; on: boolean };
}

/** In the page: build the cache, its pipeline and the atlas on the chunk meshes. */
export async function cacheSpikeSetup(cfg: SpikeSetup): Promise<Record<string, unknown>> {
  type V3 = [number, number, number];
  const S = (window as unknown as { __tlSpike: Record<string, any> }).__tlSpike;
  const renderer = S['renderer'];
  if (renderer === null) return { error: 'no renderer' };
  const device: any = renderer.backend?.device;
  const GBU = (globalThis as any).GPUBufferUsage;
  if (device === undefined) return { error: 'not a WebGPU renderer' };
  // The layer's chunk meshes (`block:<look>`), wherever the export put them (static ones are hoisted to the scene).
  const meshes: any[] = [];
  for (const sc of S['scenes'] as any[]) {
    sc.updateMatrixWorld(true);
    sc.traverse((o: any) => {
      if (o.isMesh === true && String(o.name).startsWith('block:') && o.geometry?.attributes?.uv1 !== undefined) meshes.push(o);
    });
  }
  if (meshes.length === 0) return { error: 'no chunk mesh has UV1 (not baked?)' };
  // Slots read back from the meshes: per triangle its facing, cell and UV1 rectangle.
  const M = cfg.margin;
  interface Slot { key: string; dir: number; cell: V3; min: V3; max: V3; mesh: number; local: [number, number]; side: number; tile: [number, number]; verts: Set<number> }
  const slots = new Map<string, Slot>();
  const perMesh: Map<number, Slot>[] = [];
  meshes.forEach((m, mi) => {
    const pos = m.geometry.attributes.position;
    const uv1 = m.geometry.attributes.uv1;
    const idx = m.geometry.index;
    const e = m.matrixWorld.elements as number[];
    const world = (i: number): V3 => {
      const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
      return [e[0]! * x + e[4]! * y + e[8]! * z + e[12]!, e[1]! * x + e[5]! * y + e[9]! * z + e[13]!, e[2]! * x + e[6]! * y + e[10]! * z + e[14]!];
    };
    const byVertex = new Map<number, Slot>();
    perMesh.push(byVertex);
    const count = idx !== null ? idx.count : pos.count;
    for (let t = 0; t < count; t += 3) {
      const vi = [0, 1, 2].map((k) => (idx !== null ? idx.getX(t + k) : t + k));
      const p = vi.map(world);
      const a = [p[1]![0] - p[0]![0], p[1]![1] - p[0]![1], p[1]![2] - p[0]![2]];
      const b = [p[2]![0] - p[0]![0], p[2]![1] - p[0]![1], p[2]![2] - p[0]![2]];
      const n = [a[1]! * b[2]! - a[2]! * b[1]!, a[2]! * b[0]! - a[0]! * b[2]!, a[0]! * b[1]! - a[1]! * b[0]!];
      const len = Math.hypot(n[0]!, n[1]!, n[2]!);
      if (len === 0) continue;
      const ax = Math.abs(n[0]!) >= Math.abs(n[1]!) && Math.abs(n[0]!) >= Math.abs(n[2]!) ? 0 : Math.abs(n[1]!) >= Math.abs(n[2]!) ? 1 : 2;
      const dir = ax * 2 + (n[ax]! >= 0 ? 0 : 1);
      const cell = [0, 1, 2].map((k) => Math.floor((p[0]![k]! + p[1]![k]! + p[2]![k]!) / 3 - (n[k]! / len) * 1e-4)) as V3;
      const key = `${cell.join(',')},${dir}`;
      let s = slots.get(key);
      const us = vi.map((v) => uv1.getX(v));
      const vs = vi.map((v) => uv1.getY(v));
      if (s === undefined) {
        s = { key, dir, cell, min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity], mesh: mi, local: [0, 0], side: 0, tile: [0, 0], verts: new Set() };
        slots.set(key, s);
      }
      for (const q of p) for (let k = 0; k < 3; k++) {
        s.min[k] = Math.min(s.min[k]!, q[k]!);
        s.max[k] = Math.max(s.max[k]!, q[k]!);
      }
      // The slot's place in its chunk's layout: the UV1 square it lies in.
      const du = Math.max(...us) - Math.min(...us);
      if (du > 0) s.side = Math.max(s.side, Math.round((1 - 2 * M) / du));
      s.local = [Math.min(...us), Math.min(...vs)];
      for (const v of vi) {
        s.verts.add(v);
        byVertex.set(v, s);
      }
    }
  });
  const list = [...slots.values()].sort((a, b) => a.dir - b.dir || a.cell[1] - b.cell[1] || a.cell[2] - b.cell[2] || a.cell[0] - b.cell[0]);
  const atlasSide = Math.ceil(Math.sqrt(list.length));
  list.forEach((s, i) => (s.tile = [i % atlasSide, Math.floor(i / atlasSide)]));
  // Each slot's face: an origin and the two edges its UV1 (and its tile's texels) run along.
  const PLANE = [[2, 1], [2, 1], [0, 2], [0, 2], [0, 1], [0, 1]];
  const slotData = new Float32Array(list.length * 20);
  const slotU32 = new Uint32Array(slotData.buffer);
  list.forEach((s, i) => {
    const [u, v] = PLANE[s.dir]!;
    const ax = s.dir >> 1;
    const o = [0, 0, 0];
    o[ax] = s.min[ax]!;
    o[u!] = s.min[u!]!;
    o[v!] = s.min[v!]!;
    const du = [0, 0, 0];
    du[u!] = s.max[u!]! - s.min[u!]!;
    const dv = [0, 0, 0];
    dv[v!] = s.max[v!]! - s.min[v!]!;
    const n = [0, 0, 0];
    n[ax] = s.dir % 2 === 0 ? 1 : -1;
    slotData.set([...o, 0, ...du, 0, ...dv, 0, ...n, 0], i * 20);
    slotU32[i * 20 + 16] = s.tile[0];
    slotU32[i * 20 + 17] = s.tile[1];
  });
  // UV1 moved from each chunk's layout onto the slot's atlas tile (vertices are split per slot).
  meshes.forEach((m, mi) => {
    const uv1 = m.geometry.attributes.uv1;
    for (const [v, s] of perMesh[mi]!) {
      if (s.side === 0) continue;
      const col = Math.floor(s.local[0] * s.side + 1e-6);
      const row = Math.floor(s.local[1] * s.side + 1e-6);
      const lu = uv1.getX(v) * s.side - col;
      const lv = uv1.getY(v) * s.side - row;
      uv1.setXY(v, (s.tile[0] + lu) / atlasSide, (s.tile[1] + lv) / atlasSide);
    }
    uv1.needsUpdate = true;
  });
  // The atlas: a storage texture of three's (so the material samples it), written by the spike's own pipeline.
  const texSize = atlasSide * cfg.P;
  const sample = meshes.find((m) => m.material?.lightMap)?.material.lightMap;
  if (sample === undefined) return { error: 'no chunk material has a lightMap' };
  const Tex = sample.constructor;
  const mkTex = (w: number, h: number): any => {
    const t = new Tex();
    t.image = { width: w, height: h };
    t.isStorageTexture = true;
    t.mipmapsAutoUpdate = false;
    t.generateMipmaps = false;
    t.magFilter = 1006;
    t.minFilter = 1006;
    t.type = 1016; // HalfFloatType
    t.format = 1023; // RGBAFormat
    t.colorSpace = '';
    t.flipY = false;
    t.channel = 1;
    return t;
  };
  const atlas = mkTex(texSize, texSize);
  const terrTex = mkTex(cfg.terrain.patch.texels, cfg.terrain.patch.texels);
  renderer.initTexture(atlas);
  renderer.initTexture(terrTex);
  const gpuAtlas: any = renderer.backend.get(atlas).texture;
  const gpuTerr: any = renderer.backend.get(terrTex).texture;
  const mats = new Set<any>();
  for (const m of meshes) {
    const mat = m.material;
    if (mats.has(mat)) continue;
    mats.add(mat);
    mat.lightMap = atlas;
    mat.lightMapIntensity = 1;
    mat.needsUpdate = true;
  }
  // Buffers.
  const buf = (data: ArrayBufferView, usage: number): any => {
    const b = device.createBuffer({ size: Math.max(16, Math.ceil(data.byteLength / 16) * 16), usage: usage | GBU.COPY_DST });
    device.queue.writeBuffer(b, 0, data.buffer, data.byteOffset, data.byteLength);
    return b;
  };
  const occ = buf(new Uint32Array(cfg.grid.bits), GBU.STORAGE);
  const slotBuf = buf(slotData, GBU.STORAGE);
  const terr = buf(new Float32Array(cfg.terrain.data), GBU.STORAGE);
  const uniform = device.createBuffer({ size: 11 * 16, usage: GBU.UNIFORM | GBU.COPY_DST });
  const P2 = cfg.P * cfg.P;
  const blockTexels = list.length * P2;
  const terrTexels = cfg.terrain.patch.texels * cfg.terrain.patch.texels;
  const work = device.createBuffer({ size: (blockTexels + terrTexels) * 4, usage: GBU.STORAGE | GBU.COPY_DST });
  device.pushErrorScope('validation');
  const module = device.createShaderModule({ code: cfg.wgsl });
  const info = await module.getCompilationInfo();
  const err = info.messages.find((m: any) => m.type === 'error');
  if (err !== undefined) return { error: `wgsl: ${err.lineNum}:${err.linePos} ${err.message}` };
  const pipeline = await device.createComputePipelineAsync({ layout: 'auto', compute: { module, entryPoint: 'main' } });
  const bind = device.createBindGroup({
    layout: pipeline.getBindGroupLayout(0),
    entries: [
      { binding: 0, resource: { buffer: uniform } },
      { binding: 1, resource: { buffer: occ } },
      { binding: 2, resource: { buffer: slotBuf } },
      { binding: 3, resource: { buffer: terr } },
      { binding: 4, resource: { buffer: work } },
      { binding: 5, resource: gpuAtlas.createView() },
      { binding: 6, resource: gpuTerr.createView() },
    ],
  });
  const verr = await device.popErrorScope();
  if (verr !== null) return { error: `validation: ${verr.message}` };
  const hasTs = device.features.has('timestamp-query');
  const MAXQ = 4096;
  const qs = hasTs ? device.createQuerySet({ type: 'timestamp', count: MAXQ }) : null;
  const qResolve = device.createBuffer({ size: MAXQ * 8, usage: GBU.QUERY_RESOLVE | GBU.COPY_SRC });
  const qRead = device.createBuffer({ size: MAXQ * 8, usage: GBU.MAP_READ | GBU.COPY_DST });
  // Slot centres and normals, for the stale lists.
  const centres = list.map((s) => [0, 1, 2].map((k) => (s.min[k]! + s.max[k]!) / 2) as V3);
  const normals = list.map((s) => {
    const n: V3 = [0, 0, 0];
    n[s.dir >> 1] = s.dir % 2 === 0 ? 1 : -1;
    return n;
  });
  S['spike'] = { cfg, device, pipeline, bind, uniform, work, qs, qResolve, qRead, list: list.map((s) => ({ dir: s.dir, cell: s.cell })), centres, normals, P2, blockTexels, terrTexels, atlasSide, texSize, gpuAtlas, gpuTerr };
  const area = list.reduce((a, s) => a + [0, 1, 2].map((k) => s.max[k]! - s.min[k]!).filter((x) => x > 0).reduce((x, y) => x * y, 1), 0);
  return {
    meshes: meshes.length,
    materials: mats.size,
    slots: list.length,
    faceArea: Math.round(area * 100) / 100,
    sidesSeen: [...new Set(list.map((s) => s.side))],
    atlasSide,
    texSize,
    atlasBytes: texSize * texSize * 8,
    slotBytes: list.length * P2 * 8,
    terrainTexels: terrTexels,
    terrainBytes: terrTexels * 8,
    timestamps: hasTs,
    limits: { storageBuffers: device.limits.maxStorageBuffersPerShaderStage, storageTextures: device.limits.maxStorageTexturesPerShaderStage },
  };
}

/** What a re-light runs. */
export interface SpikeRelight {
  /** `room`: the block texels within the rect light's range (a lamp switched); `blocks`: every block texel (the sun moved); `terrain`: the terrain patch; `all`: both. */
  stale: 'room' | 'blocks' | 'terrain' | 'all';
  /** `grouped`: texels in order of kind, facing and slot (a workgroup shares a face); `shuffled`: a random order (neighbouring threads on unrelated texels, kinds mixed). */
  order: 'grouped' | 'shuffled';
  /** Texels lit per frame. */
  perFrame: number;
  sun?: { toLight: [number, number, number]; rays?: number };
  rect?: { on: boolean; rays?: number };
  seed: number;
}

/** In the page: re-light the stale texels over frames; GPU ms per frame from timestamps, frame intervals from rAF. */
export async function cacheSpikeRelight(r: SpikeRelight): Promise<Record<string, unknown>> {
  const S = (window as unknown as { __tlSpike: Record<string, any> }).__tlSpike;
  const K = S['spike'];
  if (K === undefined) return { error: 'not set up' };
  const device: any = K.device;
  const cfg: SpikeSetup = K.cfg;
  if (r.sun !== undefined) {
    cfg.sun.toLight = r.sun.toLight;
    if (r.sun.rays !== undefined) cfg.sun.rays = r.sun.rays;
  }
  if (r.rect !== undefined) {
    cfg.rect.on = r.rect.on;
    if (r.rect.rays !== undefined) cfg.rect.rays = r.rect.rays;
  }
  // The stale texels.
  const items: number[] = [];
  const slotsOf = (pick: (i: number) => boolean): number[] => {
    const out: number[] = [];
    for (let i = 0; i < K.list.length; i++) if (pick(i)) out.push(i);
    return out;
  };
  const rc = cfg.rect.centre;
  const inRange = (i: number): boolean => {
    const c = K.centres[i];
    const n = K.normals[i];
    const v = [rc[0] - c[0], rc[1] - c[1], rc[2] - c[2]];
    return Math.hypot(v[0]!, v[1]!, v[2]!) < cfg.rect.range + 0.9 && v[0]! * n[0] + v[1]! * n[1] + v[2]! * n[2] > -0.5;
  };
  const blockSlots = r.stale === 'room' ? slotsOf(inRange) : r.stale === 'blocks' || r.stale === 'all' ? slotsOf(() => true) : [];
  for (const s of blockSlots) for (let t = 0; t < K.P2; t++) items.push(s * K.P2 + t);
  if (r.stale === 'terrain' || r.stale === 'all') for (let t = 0; t < K.terrTexels; t++) items.push((0x80000000 | t) >>> 0);
  if (r.order === 'shuffled') {
    let x = r.seed | 1;
    for (let i = items.length - 1; i > 0; i--) {
      x ^= x << 13;
      x ^= x >>> 17;
      x ^= x << 5;
      const j = (x >>> 0) % (i + 1);
      const t = items[i]!;
      items[i] = items[j]!;
      items[j] = t;
    }
  }
  device.queue.writeBuffer(K.work, 0, new Uint32Array(items));
  const T = cfg.terrain;
  const u = new Float32Array(44);
  const setU = (): void => {
    u.set([...cfg.sun.toLight, cfg.sun.radius, ...cfg.sun.irradiance, cfg.sun.rays, ...cfg.rect.centre, cfg.rect.rays, ...cfg.rect.eu, cfg.rect.on ? 1 : 0, ...cfg.rect.ev, 0, ...cfg.rect.radiance, cfg.rect.range, ...cfg.grid.dims, cfg.P, ...T.origin, T.spacing, T.cells, T.levels, T.patch.texel, T.patch.texels], 0);
  };
  setU();
  const frames: number[] = [];
  const gpu: number[] = [];
  const t0 = performance.now();
  let base = 0;
  let q = 0;
  const pending: Promise<void>[] = [];
  const done = new Promise<void>((resolve) => {
    const step = (t: number): void => {
      frames.push(t);
      if (base >= items.length) {
        resolve();
        return;
      }
      const count = Math.min(r.perFrame, items.length - base);
      u.set([T.patch.min[0], T.patch.min[1], base, count, (r.seed + base) >>> 0, cfg.margin, 0, 0], 36);
      device.queue.writeBuffer(K.uniform, 0, u);
      const enc = device.createCommandEncoder();
      const pass = enc.beginComputePass(K.qs !== null && q + 2 <= 4096 ? { timestampWrites: { querySet: K.qs, beginningOfPassWriteIndex: q, endOfPassWriteIndex: q + 1 } } : {});
      pass.setPipeline(K.pipeline);
      pass.setBindGroup(0, K.bind);
      pass.dispatchWorkgroups(Math.ceil(count / 64));
      pass.end();
      q += 2;
      device.queue.submit([enc.finish()]);
      base += count;
      requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  });
  await done;
  await device.queue.onSubmittedWorkDone();
  const settledMs = performance.now() - t0;
  if (K.qs !== null && q > 0) {
    const enc = device.createCommandEncoder();
    enc.resolveQuerySet(K.qs, 0, q, K.qResolve, 0);
    enc.copyBufferToBuffer(K.qResolve, 0, K.qRead, 0, q * 8);
    device.queue.submit([enc.finish()]);
    await K.qRead.mapAsync((globalThis as any).GPUMapMode.READ, 0, q * 8);
    const ts = new BigUint64Array(K.qRead.getMappedRange(0, q * 8).slice(0));
    K.qRead.unmap();
    for (let i = 0; i < q; i += 2) gpu.push(Number(ts[i + 1]! - ts[i]!) / 1e6);
  }
  await Promise.all(pending);
  const intervals = frames.slice(1).map((t, i) => t - frames[i]!);
  return { items: items.length, blockSlots: blockSlots.length, dispatches: gpu.length || Math.ceil(items.length / r.perFrame), settledMs: Math.round(settledMs * 10) / 10, gpu, intervals };
}

/** In the page: the frame intervals of the last `ms` (rAF, at the display's cap). */
export async function cacheSpikeFrames(ms: number): Promise<number[]> {
  const S = (window as unknown as { __tlSpike: Record<string, any> }).__tlSpike;
  const from = (S['frames'] as number[]).length;
  await new Promise((r) => setTimeout(r, ms));
  const f = (S['frames'] as number[]).slice(from);
  return f.slice(1).map((t, i) => t - f[i]!);
}
