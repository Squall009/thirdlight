/**
 * The streaming core's detail levels against real boundaries: mip nodes, the seams between the levels drawn and
 * the levels chosen round a moving focus, built by `worker_threads` workers running the bundled worker module
 * from region files on disk, checked against fresh builds from the world store as the oracle (the shared world:
 * stream-fixture.ts).
 */
import { join } from 'node:path';
import {
  applyEdit,
  canonicalEditCommand,
  chunkOfKey,
  createWorldStore,
  deriveFromStore,
  deriveMipNode,
  derivedBytes,
  encodeDerived,
  jobRadius,
  MipTree,
  WORLD_RULES,
  RESIDENT_CHUNK_OVERHEAD_BYTES,
  setNearOnly,
  voxel,
  VOXEL_ROLE,
  VoxelStreamer,
  WorkerPool,
  buildFaceSeam,
  faceLevels,
  POSITION_STEPS_PER_CELL,
  SURFACE_VERTEX_BYTES,
  type FaceSeam,
  type LevelNode,
  type LevelSelection,
  levelNodeDistance,
  type NodeFace,
  type SeamEvent,
  type SeamKey,
  type SeamSurface,
  type MipEvent,
  type StreamEvent,
  type StreamRing,
  type SwapReport,
} from '@thirdlight/voxel';
import { describe, expect, it } from 'vitest';
import { DiskRegions } from './stream-node';
import { checkLevels, chunkId, nodeChunks } from './lod-checks';
import {
  useStreamWorld,
  grid,
  dir,
  oracle,
  disks,
  pool,
  sleep,
  copyOracle,
} from './stream-fixture';

useStreamWorld();

describe('streamer: detail levels (workers, region files on disk)', () => {
  it('builds mip nodes in workers from the resident chunks: each a fresh downsample and derive, a dig re-derives its ancestors only, bytes in the budget, unload drops them', async () => {
    const disk = new DiskRegions(join(dir, 'world'));
    disks.push(disk);
    // The whole world's height and two chunks above and below it are loaded, 256 cells around: the four level-2 nodes
    // meeting at the focus have the octants of their neighbours that face them (two chunks deep) resident.
    let minCy = Infinity;
    let maxCy = -Infinity;
    for (const key of oracle.chunkKeys()) {
      const c = chunkOfKey(grid, key);
      minCy = Math.min(minCy, c.cy);
      maxCy = Math.max(maxCy, c.cy);
    }
    const midY = ((minCy + maxCy + 1) * 32) / 2;
    const half = ((maxCy - minCy + 1) * 32) / 2 + 64;
    const ring: StreamRing = { loadRadius: 256, unloadRadius: 288, loadHeight: half, unloadHeight: half + 32, nearRadius: 96 };
    const s = new VoxelStreamer({ store: createWorldStore(grid), source: disk.source(grid, 'stacked', 512), pool: pool(4), ring, budgetBytes: 256 * 1024 * 1024, dependencyRadius: jobRadius(WORLD_RULES), derive: true, rules: WORLD_RULES, sectionEdge: 32, deriveMsPerUpdate: 10_000, mips: [{ level: 1, radius: 64 }, { level: 2, radius: 32 }] });
    const mips = s.mips!;
    const events: MipEvent[] = [];
    s.on((e) => {
      if (e.type === 'node') events.push(e);
    });
    const truth = copyOracle();
    /** Every node with a result equals a fresh downsample of `truth` derived through the chunk derive; the count per level. */
    const sameAsFresh = (): number[] => {
      const tree = new MipTree(truth);
      const n = [0, 0, 0];
      for (const d of mips.derived()) {
        const want = deriveMipNode(tree, { level: d.level, nx: d.nx, ny: d.ny, nz: d.nz }, WORLD_RULES);
        if (d.result === null) {
          // Nothing to draw: air with air around it.
          expect(want.ground.vertexCount + want.base.vertexCount + want.instances.count).toBe(0);
        } else if (Buffer.compare(Buffer.from(encodeDerived(d.result)), Buffer.from(encodeDerived(want))) !== 0) throw new Error(`node ${d.level}:${d.nx},${d.ny},${d.nz} differs from a fresh derive`);
        expect(d.result?.level ?? d.level).toBe(d.level);
        n[d.level]!++;
      }
      return n;
    };
    /** Every node with a result lies over resident chunks only. */
    const overResident = (): void => {
      for (const d of mips.derived()) {
        const k = 2 ** d.level;
        for (let x = 0; x < k; x++) for (let y = 0; y < k; y++) for (let z = 0; z < k; z++) expect(s.isResident(d.nx * k + x, d.ny * k + y, d.nz * k + z)).toBe(true);
      }
    };
    const surface = (x: number, z: number): number => {
      const v = voxel();
      for (let y = 300; y > -300; y--) if (truth.voxelAt(x, y, z, v).material !== 0 && v.role !== VOXEL_ROLE.liquid) return y;
      throw new Error(`no ground at ${x}, ${z}`);
    };

    s.setFocus(0, midY, 0);
    await s.settle();
    const counts = sameAsFresh();
    // Every node of the world's layers within its ring (box distance: 12 of level 1 a layer, the 2 × 2 of level 2
    // meeting at the focus); air above and below may add nodes with nothing to draw.
    const keys = new Set([...mips.derived()].map((d) => `${d.level}:${d.nx},${d.ny},${d.nz}`));
    const boxDistance = (lo: number, size: number): number => Math.max(0, lo, -(lo + size));
    let inRings = 0;
    for (const [l, radius] of [[1, 64], [2, 32]] as const) {
      const size = 32 * 2 ** l;
      for (let ny = minCy >> l; ny <= maxCy >> l; ny++) for (let nx = -4; nx < 4; nx++) for (let nz = -4; nz < 4; nz++) {
        if (Math.hypot(boxDistance(nx * size, size), boxDistance(nz * size, size)) > radius) continue;
        expect(keys.has(`${l}:${nx},${ny},${nz}`)).toBe(true);
        inRings++;
      }
    }
    expect(inRings).toBe(12 * ((maxCy >> 1) - (minCy >> 1) + 1) + 4 * ((maxCy >> 2) - (minCy >> 2) + 1));
    expect(counts[1]! + counts[2]!).toBe(keys.size);
    overResident();
    expect(mips.counters.staleRefused).toBe(0);
    // Mip bytes are a budget part: node cells, results and bookkeeping.
    let derived = 0;
    for (const d of mips.derived()) derived += d.result === null ? 0 : derivedBytes(d.result);
    const m = s.metrics();
    expect(m.bytes.mips).toBe(mips.cellBytes() + derived + mips.nodeCount * RESIDENT_CHUNK_OVERHEAD_BYTES);
    expect(m.bytes.mips).toBeGreaterThan(0);
    expect(m.bytes.total).toBe(m.bytes.chunks + m.bytes.derived + m.bytes.overlay + m.bytes.tables + m.bytes.mips);
    const measured = { l1: counts[1], l2: counts[2], mipKB: Math.round(m.bytes.mips / 1024), chunkKB: Math.round(m.bytes.chunks / 1024), derivedKB: Math.round(m.bytes.derived / 1024), downsampleUsP50: Math.round(mips.downsampleUs.quantile(0.5)), deriveUsP50: Math.round(mips.deriveUs.quantile(0.5)) };

    // A dig in the middle of a level-1 node, its cells more than the rules' radius from every node face at both
    // levels: its two ancestors are downsampled and derived again, nothing else.
    let at: [number, number, number] | null = null;
    for (const [x, z] of [[32, 32], [40, 32], [32, 40], [24, 24], [40, 40], [-32, -32], [-40, -32], [-24, -24], [32, -32], [-32, 32]] as const) {
      const y = surface(x, z);
      const in1 = ((y % 64) + 64) % 64;
      const in2 = ((y % 128) + 128) % 128;
      if (in1 >= 12 && in1 <= 52 && in2 >= 20 && in2 <= 104) {
        at = [x, y, z];
        break;
      }
    }
    if (at === null) throw new Error('no ground in the middle of a node');
    const dig = canonicalEditCommand({ v: 2, grid: 0, kind: 'brush', shape: 'sphere', size: [3, 3, 3], points: at, mode: 'dig', smooth: false });
    const before = new Map<string, unknown>();
    for (const d of mips.derived()) before.set(`${d.level}:${d.nx},${d.ny},${d.nz}`, d.result);
    const d0 = { ...mips.counters };
    events.length = 0;
    s.edit(dig);
    applyEdit({ store: () => truth }, dig);
    await s.settle();
    const ancestors = [1, 2].map((l) => `${l}:${at![0] >> (5 + l)},${at![1] >> (5 + l)},${at![2] >> (5 + l)}`);
    expect(events.map((e) => `${e.level}:${e.nx},${e.ny},${e.nz}`).sort()).toEqual(ancestors.sort());
    expect(events.every((e) => !e.removed)).toBe(true);
    expect(mips.counters.derives - d0.derives).toBe(2);
    expect(mips.counters.downsamples - d0.downsamples).toBe(2);
    for (const d of mips.derived()) {
      const key = `${d.level}:${d.nx},${d.ny},${d.nz}`;
      if (!ancestors.includes(key)) expect(d.result).toBe(before.get(key));
    }
    expect(sameAsFresh()).toEqual(counts);

    // The focus leaves: every node over unloaded chunks loses its result (a `removed` event), its cells and bytes go.
    const withNodes = s.metrics().bytes.mips;
    events.length = 0;
    s.setFocus(448, midY, 0);
    await s.settle();
    overResident();
    for (const key of before.keys()) {
      const [l, rest] = key.split(':');
      const [nx, ny, nz] = rest!.split(',').map(Number);
      expect(mips.derivedOf(Number(l), nx!, ny!, nz!)).toBeNull();
    }
    const removed = new Set(events.filter((e) => e.removed).map((e) => `${e.level}:${e.nx},${e.ny},${e.nz}`));
    for (const [key, r] of before) if (r !== null) expect(removed.has(key)).toBe(true);
    for (const d of mips.derived()) expect(d.nx * 2 ** d.level * 32).toBeGreaterThan(64);
    expect(s.metrics().bytes.mips).toBeLessThan(withNodes);
    sameAsFresh();
    console.log('mips', JSON.stringify(measured));
  }, 120_000);

  it('builds the seams between the levels drawn in workers: each equal to a fresh build, a level change re-derives exactly the faces it adds and drops in one swap, an edit at a border re-derives the strip inside its own swap', async () => {
    const disk = new DiskRegions(join(dir, 'world'));
    disks.push(disk);
    let minCy = Infinity;
    let maxCy = -Infinity;
    for (const key of oracle.chunkKeys()) {
      const c = chunkOfKey(grid, key);
      minCy = Math.min(minCy, c.cy);
      maxCy = Math.max(maxCy, c.cy);
    }
    const midY = ((minCy + maxCy + 1) * 32) / 2;
    const half = ((maxCy - minCy + 1) * 32) / 2 + 64;
    const ring: StreamRing = { loadRadius: 256, unloadRadius: 288, loadHeight: half, unloadHeight: half + 32, nearRadius: 96 };
    const s = new VoxelStreamer({ store: createWorldStore(grid), source: disk.source(grid, 'stacked', 512), pool: pool(4), ring, budgetBytes: 256 * 1024 * 1024, dependencyRadius: jobRadius(WORLD_RULES), derive: true, rules: WORLD_RULES, sectionEdge: 32, deriveMsPerUpdate: 10_000, mips: [{ level: 1, radius: 160 }], levels: { radii: [48], hysteresis: 0 } });
    const seams = s.mips!.seams;
    const focus = { x: 0, y: midY, z: 0 };
    // Level 0 where its level-1 parent lies within 48 cells of the focus (the 2 × 2 nodes round it), level 1 past it.
    const log: Array<{ type: string; e?: SeamEvent }> = [];
    s.on((e) => log.push(e.type === 'seams' ? { type: e.type, e } : { type: e.type }));
    const truth = copyOracle();
    const id = (k: SeamKey): string => `${k.level}:${k.nx},${k.ny},${k.nz}:${k.face}`;
    /** A seam's triangles as world positions (finer-level steps) and normals, sorted: the same seam whatever the order it was built in. */
    const canonical = (seam: FaceSeam): string[] => {
      const out: string[] = [];
      for (const p of seam.pieces) for (const buf of [p.ground, p.base]) {
        const v = new DataView(buf.vertices.buffer, buf.vertices.byteOffset, buf.vertices.byteLength);
        const corner = (i: number): string => [0, 1, 2].map((a) => p.origin[a]! * POSITION_STEPS_PER_CELL + v.getUint16(i * SURFACE_VERTEX_BYTES + 2 * a, true)).join(',') + '/' + [8, 9, 10].map((o) => v.getInt8(i * SURFACE_VERTEX_BYTES + o)).join(',');
        for (let t = 0; t < buf.indices.length; t += 3) out.push(`${buf === p.ground ? 'g' : 'b'} ${corner(buf.indices[t]!)} ${corner(buf.indices[t + 1]!)} ${corner(buf.indices[t + 2]!)}`);
      }
      return out.sort();
    };
    /** A face's seam built from a fresh derive of `truth`: the node and its neighbours beside the face, the chunks against it and beside them. */
    let tree = new MipTree(truth);
    const chunkDerives = new Map<string, ReturnType<typeof deriveFromStore>>();
    const fresh = (k: SeamKey): FaceSeam => {
      const axis = k.face >> 1;
      const inPlane = [0, 1, 2].filter((a) => a !== axis);
      const n = [k.nx, k.ny, k.nz];
      const node = (x: number, y: number, z: number): SeamSurface => {
        const d = deriveMipNode(tree, { level: 1, nx: x, ny: y, nz: z }, WORLD_RULES);
        return { x0: x * 32, y0: y * 32, z0: z * 32, ground: d.ground, base: d.base };
      };
      const coarseAround: SeamSurface[] = [];
      for (let du = -1; du <= 1; du++) for (let dw = -1; dw <= 1; dw++) {
        if (du === 0 && dw === 0) continue;
        const m = [...n];
        m[inPlane[0]!]! += du;
        m[inPlane[1]!]! += dw;
        // Only neighbours the streamer has a result for (past the loaded height it has none).
        if (s.mips!.derivedOf(1, m[0]!, m[1]!, m[2]!) !== null) coarseAround.push(node(m[0]!, m[1]!, m[2]!));
      }
      const fine: SeamSurface[] = [];
      for (let i = -1; i <= 2; i++) for (let j = -1; j <= 2; j++) {
        const c = [0, 0, 0];
        c[axis] = k.face & 1 ? 2 * (n[axis]! + 1) : 2 * n[axis]! - 1;
        c[inPlane[0]!] = 2 * n[inPlane[0]!]! + i;
        c[inPlane[1]!] = 2 * n[inPlane[1]!]! + j;
        if (s.derivedOf(c[0]!, c[1]!, c[2]!) === null) continue;
        const ck = c.join();
        let d = chunkDerives.get(ck);
        if (d === undefined) chunkDerives.set(ck, (d = deriveFromStore(truth, c[0]!, c[1]!, c[2]!, WORLD_RULES)));
        fine.push({ x0: c[0]! * 32, y0: c[1]! * 32, z0: c[2]! * 32, ground: d.ground, base: d.base });
      }
      return buildFaceSeam({ edge: 32, level: 1, nx: k.nx, ny: k.ny, nz: k.nz, face: k.face, coarse: node(k.nx, k.ny, k.nz), coarseAround, fine });
    };
    /** Faces a selection wants on the derived level-1 nodes: drawn, with level 0 drawn across. */
    const wanted = (sel: LevelSelection): Set<string> => {
      const out = new Set<string>();
      for (const d of s.mips!.derived()) {
        if (!sel.drawn(1, d.nx, d.ny, d.nz)) continue;
        faceLevels(sel, 1, 1, d.nx, d.ny, d.nz).forEach((l, f) => {
          if (l === 0) out.add(id({ level: 1, nx: d.nx, ny: d.ny, nz: d.nz, face: f as NodeFace }));
        });
      }
      return out;
    };
    const built = (): Map<string, FaceSeam> => new Map([...seams.seams()].filter((x) => x.seam !== null).map((x) => [id(x.key), x.seam!]));
    const checkFresh = (keys: Iterable<string>): number => {
      let n = 0;
      const have = built();
      for (const key of keys) {
        const seam = have.get(key);
        if (seam === undefined) throw new Error(`face ${key} has no seam`);
        const want = fresh(seam);
        expect(canonical(seam), key).toEqual(canonical(want));
        n++;
      }
      return n;
    };

    s.setFocus(focus.x, focus.y, focus.z);
    await s.settle();
    const first = wanted(s.mips!.lod.drawn);
    // Every face the selection wants on the derived nodes has its seam, as a fresh build gives it; nothing else does.
    expect(first.size).toBeGreaterThan(8);
    expect(new Set(built().keys())).toEqual(first);
    expect(checkFresh(first)).toBe(first.size);
    let tris = 0;
    for (const seam of built().values()) tris += seam.counts.strip + seam.counts.flaps;
    const m = s.metrics();
    expect(m.bytes.mips).toBe(s.mips!.cellBytes() + [...s.mips!.derived()].reduce((a, d) => a + (d.result === null ? 0 : derivedBytes(d.result)), 0) + s.mips!.nodeCount * RESIDENT_CHUNK_OVERHEAD_BYTES + seams.bytes);
    const measured = { faces: first.size, trianglesPerFace: Math.round(tris / first.size), seamKB: Math.round(seams.bytes / 1024), seamUsP50: Math.round(seams.seamUs.quantile(0.5)), seamUsP95: Math.round(seams.seamUs.quantile(0.95)) };

    // Level 0 out to 80 cells: the faces it adds are built and those it drops removed in one `seams` event, nothing else.
    log.length = 0;
    const c0 = { ...seams.counters };
    s.mips!.lod.setRings({ radii: [80], hysteresis: 0 });
    await s.settle();
    const second = wanted(s.mips!.lod.drawn);
    const events = log.filter((l) => l.type === 'seams').map((l) => l.e!);
    expect(events.length).toBe(1);
    const added = [...second].filter((k) => !first.has(k)).sort();
    const dropped = [...first].filter((k) => !second.has(k)).sort();
    expect(added.length).toBeGreaterThan(0);
    expect(dropped.length).toBeGreaterThan(0);
    expect(events[0]!.built.map(id).sort()).toEqual(added);
    for (const k of dropped) expect(events[0]!.removed.map(id)).toContain(k);
    expect(seams.counters.built - c0.built).toBe(added.length);
    expect(new Set(built().keys())).toEqual(second);
    checkFresh(added);

    // A dig on the level-0 side of a face, two cells from it: the strip is built again inside the edit's swap (its
    // `seams` event just before the `swap`), as a fresh build of the dug world gives it.
    const face = [...second].map((k) => k.split(/[:,]/).map(Number)).find(([, nx, , nz, f]) => f === 0 && nz! >= 0 && nx! > 0);
    if (face === undefined) throw new Error('no low-x face toward level 0');
    const [, fx, , fz] = face;
    const x = fx! * 64 - 2;
    const z = fz! * 64 + 20;
    let y = 300;
    const v = voxel();
    while (y > -300 && (truth.voxelAt(x, y, z, v).material === 0 || v.role === VOXEL_ROLE.liquid)) y--;
    const fk = `1:${fx},${y >> 6},${fz}:0`;
    expect(second.has(fk)).toBe(true);
    const dig = canonicalEditCommand({ v: 2, grid: 0, kind: 'brush', shape: 'sphere', size: [3, 3, 3], points: [x, y, z], mode: 'dig', smooth: false });
    log.length = 0;
    s.edit(dig);
    applyEdit({ store: () => truth }, dig);
    tree = new MipTree(truth);
    chunkDerives.clear();
    await s.settle();
    const swapAt = log.findIndex((l) => l.type === 'swap');
    expect(swapAt).toBeGreaterThan(0);
    expect(log[swapAt - 1]!.type).toBe('seams');
    expect(log[swapAt - 1]!.e!.built.map(id)).toContain(fk);
    checkFresh([fk]);
    console.log('seams', JSON.stringify(measured));
  }, 180_000);

  it('swaps the drawn nodes an edit changes with its chunks, in one task: a blast across level-1 node faces, a dig across an L0|L1 face, two edits meeting merge; edit-lane mip jobs', async () => {
    const disk = new DiskRegions(join(dir, 'world'));
    disks.push(disk);
    let minCy = Infinity;
    let maxCy = -Infinity;
    for (const key of oracle.chunkKeys()) {
      const c = chunkOfKey(grid, key);
      minCy = Math.min(minCy, c.cy);
      maxCy = Math.max(maxCy, c.cy);
    }
    const midY = ((minCy + maxCy + 1) * 32) / 2;
    const half = ((maxCy - minCy + 1) * 32) / 2 + 64;
    const ring: StreamRing = { loadRadius: 256, unloadRadius: 288, loadHeight: half, unloadHeight: half + 32, nearRadius: 96 };
    const p = pool(4);
    // Every job's lane, as the pool is handed it.
    const lanes: Array<{ kind: string; lane: string; level?: number }> = [];
    const submit = p.submit.bind(p);
    p.submit = ((job: Parameters<WorkerPool['submit']>[0]) => {
      lanes.push({ kind: job.kind, lane: job.lane, ...(job.kind === 'derive' ? { level: (job.input as { level?: number }).level ?? 0 } : {}) });
      return submit(job);
    }) as WorkerPool['submit'];
    // Level 0 within 48 cells (the 2 × 2 level-1 nodes round the focus split), level 1 past it.
    const s = new VoxelStreamer({ store: createWorldStore(grid), source: disk.source(grid, 'stacked', 512), pool: p, ring, budgetBytes: 256 * 1024 * 1024, dependencyRadius: jobRadius(WORLD_RULES), derive: true, rules: WORLD_RULES, sectionEdge: 32, deriveMsPerUpdate: 10_000, mips: [{ level: 1, radius: 160 }], levels: { radii: [48], hysteresis: 0 } });
    const mips = s.mips!;
    const lod = mips.lod;
    // Events with the task they came in (a batch is one task: what one task brings is drawn between the same two frames).
    let task = 0;
    let open = false;
    const log: Array<{ task: number; e: StreamEvent; drawn?: boolean }> = [];
    s.on((e) => {
      if (!open) {
        open = true;
        task++;
        queueMicrotask(() => (open = false));
      }
      log.push({ task, e, ...(e.type === 'node' ? { drawn: lod.drawn.drawn(e.level, e.nx, e.ny, e.nz) } : {}) });
    });
    const truth = copyOracle();
    const v = voxel();
    const surface = (x: number, z: number): number => {
      for (let y = 300; y > -300; y--) if (truth.voxelAt(x, y, z, v).material !== 0 && v.role !== VOXEL_ROLE.liquid) return y;
      throw new Error(`no ground at ${x}, ${z}`);
    };
    const key = (l: number, x: number, y: number, z: number): string => `${l}:${x},${y},${z}`;
    const sameAsFresh = (keys: Iterable<string>): void => {
      const tree = new MipTree(truth);
      for (const k of keys) {
        const [l, rest] = k.split(':');
        const [nx, ny, nz] = rest!.split(',').map(Number) as [number, number, number];
        const want = deriveMipNode(tree, { level: Number(l), nx, ny, nz }, WORLD_RULES);
        const got = mips.derivedOf(Number(l), nx, ny, nz);
        if (got === null) expect(want.ground.vertexCount + want.base.vertexCount + want.instances.count).toBe(0);
        else if (Buffer.compare(Buffer.from(encodeDerived(got)), Buffer.from(encodeDerived(want))) !== 0) throw new Error(`node ${k} differs from a fresh derive`);
      }
    };
    /** Digs, settles, and returns what the edit brought: its swaps, the drawn nodes' events and the tasks they came in. */
    const blast = async (cells: ReadonlyArray<readonly [number, number, number]>, size: number) => {
      log.length = 0;
      lanes.length = 0;
      const groups: number[] = [];
      for (const at of cells) {
        const dig = canonicalEditCommand({ v: 2, grid: 0, kind: 'brush', shape: 'sphere', size: [size, size, size], points: [...at], mode: 'dig', smooth: false });
        groups.push(s.edit(dig).group);
        applyEdit({ store: () => truth }, dig);
      }
      await s.settle();
      const swaps = log.filter((l) => l.e.type === 'swap');
      const drawnNodes = log.filter((l) => l.e.type === 'node' && l.drawn === true);
      return { groups, swaps, drawnNodes, seams: log.filter((l) => l.e.type === 'seams') };
    };

    s.setFocus(0, midY, 0);
    await s.settle();

    // A blast in the level-1 ring where four level-1 nodes meet (x = 128 and z = 0 are node faces), 64–128 cells out.
    const y1 = surface(128, 0);
    expect(levelNodeDistance(grid, [{ x: 0, y: midY, z: 0 }], { level: 1, nx: 1, ny: y1 >> 6, nz: 0 })).toBeGreaterThan(48);
    const a = await blast([[128, y1, 0]], 6);
    expect(a.swaps.length).toBe(1);
    const report = (a.swaps[0]!.e as { report: SwapReport }).report;
    const nodes = new Set(report.nodes.map(([l, x, y, z]) => key(l, x, y, z)));
    // Every node across the faces it reached is drawn at level 1 and went in with the swap; no drawn node and no seam
    // changed in a task of its own.
    for (const [nx, nz] of [[1, -1], [1, 0], [2, -1], [2, 0]] as const) expect(nodes.has(key(1, nx, y1 >> 6, nz))).toBe(true);
    const nodeKey = (e: StreamEvent): string => (e.type === 'node' ? key(e.level, e.nx, e.ny, e.nz) : '');
    for (const n of a.drawnNodes) {
      expect(nodes.has(nodeKey(n.e))).toBe(true);
      expect(n.task).toBe(a.swaps[0]!.task);
    }
    for (const sm of a.seams) expect(sm.task).toBe(a.swaps[0]!.task);
    expect(report.chunks.length).toBeGreaterThan(0);
    sameAsFresh(nodes);
    // The edit's mip jobs (cells and level-1 derives) went in the edit lane.
    const mipJobs = lanes.filter((l) => l.kind === 'mip' || (l.kind === 'derive' && (l.level ?? 0) > 0));
    expect(mipJobs.length).toBeGreaterThanOrEqual(2 * nodes.size);
    expect(mipJobs.every((l) => l.lane === 'edit')).toBe(true);
    const measured = { l1Nodes: nodes.size, sections: report.sections, swapMs: report.ms };

    // A dig across the face between level 0 (chunk x 1, cells 32–63) and the level-1 node x 1 (cells 64–127): its
    // chunks, the node and the seam on that face go in one swap, in one task.
    const y2 = surface(64, 20);
    const b = await blast([[64, y2, 20]], 3);
    expect(b.swaps.length).toBe(1);
    const rb = (b.swaps[0]!.e as { report: SwapReport }).report;
    expect(rb.chunks.some(([cx, , cz]) => cx === 1 && cz === 0)).toBe(true);
    expect(rb.nodes.some(([l, x, , z]) => l === 1 && x === 1 && z === 0)).toBe(true);
    expect(lod.drawn.drawn(0, 1, y2 >> 5, 0)).toBe(true);
    for (const n of b.drawnNodes) {
      expect(new Set(rb.nodes.map(([l, x, y, z]) => key(l, x, y, z))).has(nodeKey(n.e))).toBe(true);
      expect(n.task).toBe(b.swaps[0]!.task);
    }
    expect(b.seams.length).toBeGreaterThan(0);
    for (const sm of b.seams) expect(sm.task).toBe(b.swaps[0]!.task);
    expect((b.seams.at(-1)!.e as SeamEvent).built.some((k) => k.level === 1 && k.nx === 1 && k.nz === 0 && k.face === 0)).toBe(true);
    sameAsFresh(rb.nodes.map(([l, x, y, z]) => key(l, x, y, z)));

    // Two blasts in one task whose nodes meet: one swap naming both edits, the nodes in it.
    const y3 = surface(140, 10);
    const c = await blast([[128, y1 - 2, 4], [140, y3, 10]], 4);
    expect(c.swaps.length).toBe(1);
    const rc = (c.swaps[0]!.e as { report: SwapReport }).report;
    expect([...rc.groups].sort()).toEqual([...c.groups].sort());
    const nodesC = new Set(rc.nodes.map(([l, x, y, z]) => key(l, x, y, z)));
    for (const n of c.drawnNodes) {
      expect(nodesC.has(nodeKey(n.e))).toBe(true);
      expect(n.task).toBe(c.swaps[0]!.task);
    }
    for (const sm of c.seams) expect(sm.task).toBe(c.swaps[0]!.task);
    sameAsFresh(rc.nodes.map(([l, x, y, z]) => key(l, x, y, z)));

    console.log('edit swaps', JSON.stringify(measured));
  }, 180_000);

  it('never holds an edit for another that meets it only under a node nobody draws: two digs in the level-0 ring swap apart, also while one is dug every update', async () => {
    const disk = new DiskRegions(join(dir, 'world'));
    disks.push(disk);
    let minCy = Infinity;
    let maxCy = -Infinity;
    for (const k of oracle.chunkKeys()) {
      const c = chunkOfKey(grid, k);
      minCy = Math.min(minCy, c.cy);
      maxCy = Math.max(maxCy, c.cy);
    }
    const midY = ((minCy + maxCy + 1) * 32) / 2;
    const half = ((maxCy - minCy + 1) * 32) / 2 + 64;
    const ring: StreamRing = { loadRadius: 256, unloadRadius: 288, loadHeight: half, unloadHeight: half + 32, nearRadius: 96 };
    const p = pool(4);
    const lanes: Array<{ kind: string; lane: string; level: number }> = [];
    const submit = p.submit.bind(p);
    p.submit = ((job: Parameters<WorkerPool['submit']>[0]) => {
      if (job.kind === 'derive') lanes.push({ kind: job.kind, lane: job.lane, level: (job.input as { level?: number }).level ?? 0 });
      return submit(job);
    }) as WorkerPool['submit'];
    // Level 0 within 112 cells: the level-1 nodes x, z in -1…0 are split and so are all their neighbours, so no seam reads them.
    const s = new VoxelStreamer({ store: createWorldStore(grid), source: disk.source(grid, 'stacked', 512), pool: p, ring, budgetBytes: 256 * 1024 * 1024, dependencyRadius: jobRadius(WORLD_RULES), derive: true, rules: WORLD_RULES, sectionEdge: 32, deriveMsPerUpdate: 10_000, mips: [{ level: 1, radius: 160 }], levels: { radii: [112], hysteresis: 0 } });
    const mips = s.mips!;
    const swaps: SwapReport[] = [];
    s.on((e) => {
      if (e.type === 'swap') swaps.push(e.report);
    });
    const truth = copyOracle();
    const v = voxel();
    const surface = (x: number, z: number): number => {
      for (let y = 300; y > -300; y--) if (truth.voxelAt(x, y, z, v).material !== 0 && v.role !== VOXEL_ROLE.liquid) return y;
      throw new Error(`no ground at ${x}, ${z}`);
    };
    const dig = (x: number, y: number, z: number, size: number): number => {
      const cmd = canonicalEditCommand({ v: 2, grid: 0, kind: 'brush', shape: 'sphere', size: [size, size, size], points: [x, y, z], mode: 'dig', smooth: false });
      const group = s.edit(cmd).group;
      applyEdit({ store: () => truth }, cmd);
      return group;
    };
    const fresh = (nx: number, ny: number, nz: number): void => {
      const want = deriveMipNode(new MipTree(truth), { level: 1, nx, ny, nz }, WORLD_RULES);
      const got = mips.derivedOf(1, nx, ny, nz);
      if (got === null) expect(want.ground.vertexCount + want.base.vertexCount + want.instances.count).toBe(0);
      else expect(Buffer.compare(Buffer.from(encodeDerived(got)), Buffer.from(encodeDerived(want)))).toBe(0);
    };
    s.setFocus(0, midY, 0);
    await s.settle();

    // Two digs 44 cells apart under the level-1 node (-1, ny, -1), which is split: each swaps alone, naming no node.
    const ya = surface(-50, -14);
    const yb = surface(-14, -50);
    expect(ya >> 6).toBe(yb >> 6);
    const ny = ya >> 6;
    expect(mips.lod.drawn.drawn(1, -1, ny, -1)).toBe(false);
    swaps.length = 0;
    lanes.length = 0;
    const ga = dig(-50, ya, -14, 3);
    const gb = dig(-14, yb, -50, 3);
    await s.settle();
    // Each alone, in whichever order its workers finish (independent edits swap as they land; under load the second
    // can land first).
    expect(swaps.map((r) => [...r.groups]).sort((x, y) => x[0]! - y[0]!)).toEqual([[ga], [gb]].sort((x, y) => x[0]! - y[0]!));
    for (const r of swaps) expect(r.nodes.length).toBe(0);
    // The node is derived again all the same, in the edit lane, equal to a fresh derive of the dug world.
    expect(lanes.some((l) => l.level === 1 && l.lane === 'edit')).toBe(true);
    expect(lanes.filter((l) => l.level === 1).every((l) => l.lane === 'edit')).toBe(true);
    fresh(-1, ny, -1);

    // One dig while the other spot is dug again every update (a held tool): the first swaps while the second goes on.
    swaps.length = 0;
    const first = dig(-50, ya - 3, -14, 2);
    let updates = 0;
    const swapped = (): boolean => swaps.some((r) => r.groups.includes(first));
    expect(swapped()).toBe(false);
    do {
      // A new spot every update, so every dig changes cells (a dig of air rebuilds nothing).
      dig(-20 + (updates % 13), yb - 3 - Math.floor(updates / 169), -56 + (Math.floor(updates / 13) % 13), 2);
      s.update();
      await sleep(2);
    } while (++updates < 300 && !swapped());
    expect(swapped()).toBe(true);
    await s.settle();
    fresh(-1, ny, -1);
    console.log('apart', JSON.stringify({ heldToolUpdates: updates }));
  }, 180_000);

  it('near only (fine far bricks past the detail ring): no level above 0 is downsampled, derived or drawn, level 0 is derived only within the detail ring\'s reach, and off the levels come back as fresh builds (real workers)', async () => {
    const disk = new DiskRegions(join(dir, 'world'));
    disks.push(disk);
    let minCy = Infinity;
    let maxCy = -Infinity;
    for (const k of oracle.chunkKeys()) {
      const c = chunkOfKey(grid, k);
      minCy = Math.min(minCy, c.cy);
      maxCy = Math.max(maxCy, c.cy);
    }
    const midY = ((minCy + maxCy + 1) * 32) / 2;
    const half = ((maxCy - minCy + 1) * 32) / 2 + 64;
    const ring: StreamRing = { loadRadius: 192, unloadRadius: 224, loadHeight: half, unloadHeight: half + 32, nearRadius: 96 };
    const p = pool(4);
    const jobs: Array<{ kind: string; level: number; cx: number; cy: number; cz: number }> = [];
    const submit = p.submit.bind(p);
    p.submit = ((job: Parameters<WorkerPool['submit']>[0]) => {
      const input = job.input as { level?: number; chunk?: { cx: number; cy: number; cz: number } };
      jobs.push({ kind: job.kind, level: input.level ?? 0, cx: input.chunk?.cx ?? NaN, cy: input.chunk?.cy ?? NaN, cz: input.chunk?.cz ?? NaN });
      return submit(job);
    }) as WorkerPool['submit'];
    // The default mip rings (to the load ring), level 0 drawn within 48 cells.
    const s = new VoxelStreamer({ store: createWorldStore(grid), source: disk.source(grid, 'stacked', 512), pool: p, ring, budgetBytes: 256 * 1024 * 1024, dependencyRadius: jobRadius(WORLD_RULES), derive: true, rules: WORLD_RULES, sectionEdge: 32, deriveMsPerUpdate: 10_000, levels: { radii: [48, 96], hysteresis: 8 } });
    const mips = s.mips!;
    const count = (kind: string, above0: boolean): number => jobs.filter((j) => j.kind === kind && (j.level > 0) === above0).length;
    setNearOnly(s, true);
    expect(mips.isDormant).toBe(true);
    const visit = async (x: number): Promise<void> => {
      jobs.length = 0;
      s.setFocus(x, midY, 8);
      await s.settle();
      expect(count('mip', false) + count('mip', true), 'downsample jobs').toBe(0);
      expect(count('derive', true), 'level-1/2 derives').toBe(0);
      const derives = jobs.filter((j) => j.kind === 'derive');
      expect(derives.length).toBeGreaterThan(0);
      // Every level-0 derive within the detail ring's reach (its ring, hysteresis and a chunk) of the focus.
      for (const j of derives) expect(levelNodeDistance(grid, [{ x, y: midY, z: 8 }], { level: 0, nx: j.cx, ny: j.cy, nz: j.cz })).toBeLessThan(48 + 8 + 32);
      expect(mips.nodeCount).toBe(0);
      const drawn = [...mips.lod.drawn.nodes()];
      expect(drawn.length).toBeGreaterThan(0);
      expect(drawn.every((n) => n.level === 0)).toBe(true);
    };
    await visit(-64);
    const near = jobs.filter((j) => j.kind === 'derive').length;
    // Moving on: chunks entering the detail ring are derived as it reaches them; the ones it left are not.
    await visit(64);
    const resident = s.metrics().resident;
    // The same chunks read; with every ring they would all be derived, and their levels downsampled.
    setNearOnly(s, false);
    jobs.length = 0;
    await s.settle();
    expect(mips.isDormant).toBe(false);
    const off = { derives: count('derive', false), mips: count('mip', false) + count('mip', true), levelDerives: count('derive', true) };
    expect(off.mips).toBeGreaterThan(0);
    expect(off.levelDerives).toBeGreaterThan(0);
    expect([...mips.lod.drawn.nodes()].some((n) => n.level > 0)).toBe(true);
    const truth = copyOracle();
    const tree = new MipTree(truth);
    let checked = 0;
    for (const n of mips.derived()) {
      if (n.level !== 1 || checked >= 6) continue;
      const want = deriveMipNode(tree, { level: n.level, nx: n.nx, ny: n.ny, nz: n.nz }, WORLD_RULES);
      if (n.result === null) expect(want.ground.vertexCount + want.base.vertexCount + want.instances.count).toBe(0);
      else expect(Buffer.compare(Buffer.from(encodeDerived(n.result)), Buffer.from(encodeDerived(want)))).toBe(0);
      checked++;
    }
    expect(checked).toBeGreaterThan(0);
    console.log('near only', JSON.stringify({ resident, nearOnlyDerives: near, off }));
  }, 180_000);

  it('chooses the levels drawn round a moving focus in real workers: every chunk drawn once across the levels at every task boundary, neighbours a level apart, a level change one swap with its seams, stable under jitter', async () => {
    const disk = new DiskRegions(join(dir, 'world'));
    disks.push(disk);
    let minCy = Infinity;
    let maxCy = -Infinity;
    for (const key of oracle.chunkKeys()) {
      const c = chunkOfKey(grid, key);
      minCy = Math.min(minCy, c.cy);
      maxCy = Math.max(maxCy, c.cy);
    }
    const midY = ((minCy + maxCy + 1) * 32) / 2;
    const half = ((maxCy - minCy + 1) * 32) / 2 + 64;
    // The default load ring over the whole height (past the hilly square the chunks are air); the levels at half the default distances.
    const ring: StreamRing = { loadRadius: 384, unloadRadius: 448, loadHeight: half, unloadHeight: half + 32, nearRadius: 192 };
    const levels = { radii: [64, 128], hysteresis: 16 };
    const workers = pool(4), s = new VoxelStreamer({ store: createWorldStore(grid), source: disk.source(grid, 'stacked', 512), pool: workers, ring, budgetBytes: 512 * 1024 * 1024, dependencyRadius: jobRadius(WORLD_RULES), derive: true, rules: WORLD_RULES, sectionEdge: 32, mips: [{ level: 1, radius: 384 }, { level: 2, radius: 384 }], levels });
    const lod = s.mips!.lod;
    const seams = s.mips!.seams;
    const stats = { events: 0, swaps: 0, lost: 0, doubled: 0, unbalanced: 0, around: 0, silent: 0, uncovered: 0, pastReach: 0, bare: 0, seamsBefore: 0, notResident: 0, flips: 0, standInsLeft: 0 };
    let lastType = '';
    let now = { x: 0, y: 0, z: 0 };
    let jitter: Set<string> | null = null;
    s.on((e) => {
      const before = lastType;
      lastType = e.type;
      if (e.type !== 'levels') return;
      stats.events++;
      // Every task that changes the levels drawn leaves them whole: each chunk under one node, neighbours a level apart.
      const c = checkLevels(lod.drawn.nodes());
      stats.doubled += c.doubled;
      stats.unbalanced += c.unbalanced;
      // Across edges and corners too, unless the choice reported what it could not mend (children not ready: here
      // level-2 nodes above or below level-0 chunks at the load box's top and bottom, whose level-1 children are not
      // complete there).
      if (c.unbalancedAround > 0) {
        stats.around++;
        if (lod.counters.unbalanced === 0) stats.silent++;
      }
      for (const n of lod.drawn.nodes()) {
        const [x, y, z] = nodeChunks(n).next().value!;
        if (!s.isResident(x, y, z)) stats.notResident++;
      }
      if (e.reason === 'lost') {
        stats.lost++;
        return;
      }
      stats.swaps++;
      if (jitter !== null) {
        // Under jitter a node may come in once (work the jitter's loads made possible), but never go and come back. The
        // one way a node that came in may go again is a stand-in leaving for the level it stood in for, when that comes in
        // for the first time: the jitter's loads complete a coarse node at the load ring's edge, and the step that brought
        // its finer children within their stand-in reach drew them first (which comes first is the workers' timing).
        const key = (n: LevelNode): string => `${n.level}:${n.nx},${n.ny},${n.nz}`;
        const arriving = e.added.filter((a) => !jitter!.has(key(a)));
        for (const n of e.added) if (jitter.has(key(n))) stats.flips++;
        for (const n of e.removed) {
          if (!jitter.has(key(n))) continue;
          const over = arriving.some((a) => a.level > n.level && n.nx >> (a.level - n.level) === a.nx && n.ny >> (a.level - n.level) === a.ny && n.nz >> (a.level - n.level) === a.nz);
          if (over) stats.standInsLeft++;
          else stats.flips++;
        }
        for (const n of [...e.added, ...e.removed]) jitter.add(key(n));
      }
      // A swap draws again all the space it stops drawing.
      const added = new Set<string>();
      for (const a of e.added) for (const [x, y, z] of nodeChunks(a)) added.add(chunkId(x, y, z));
      // Except a finer level standing in for a coarser one that is not ready (at the load box's top and bottom, where the
      // coarser nodes are never complete), which goes once it is past its reach: one node of the next level past its ring.
      for (const r of e.removed) {
        const atReach = levelNodeDistance(grid, [now], r) >= levels.radii[r.level]! + 32 * 2 ** (r.level + 1) - 4;
        for (const [x, y, z] of nodeChunks(r)) if (!added.has(chunkId(x, y, z))) stats[atReach ? 'pastReach' : 'uncovered']++;
      }
      // And it comes with its seams: every face toward a finer level has one, built in the same task.
      for (const n of lod.drawn.nodes()) {
        if (n.level === 0) continue;
        faceLevels(lod.drawn, 2, n.level, n.nx, n.ny, n.nz).forEach((l, f) => {
          if (l === n.level - 1 && seams.seamOf(n.level, n.nx, n.ny, n.nz, f as NodeFace) === null) stats.bare++;
        });
      }
      if (before === 'seams') stats.seamsBefore++;
    });
    /** After settling: every resident chunk with its result, within level 0's reach, is drawn once (itself or a node over it). */
    const expectSettledCover = (focus: { x: number; z: number }): number => {
      const c = checkLevels(lod.drawn.nodes());
      let n = 0;
      for (const key of oracle.chunkKeys()) {
        const k = chunkOfKey(grid, key);
        if (!s.isResident(k.cx, k.cy, k.cz) || s.derivedOf(k.cx, k.cy, k.cz, true) === null) continue;
        const dx = Math.max(0, k.cx * 32 - focus.x, focus.x - (k.cx + 1) * 32);
        const dz = Math.max(0, k.cz * 32 - focus.z, focus.z - (k.cz + 1) * 32);
        if (Math.hypot(dx, dz) >= levels.radii[0]! + 64) continue;
        expect(c.covered.has(chunkId(k.cx, k.cy, k.cz)), `${k.cx},${k.cy},${k.cz}`).toBe(true);
        n++;
      }
      expect(c.doubled).toBe(0);
      expect(c.unbalanced).toBe(0);
      return n;
    };

    const focus = { x: -160, y: midY, z: 8 };
    const move = (x: number, y: number, z: number): void => {
      now = { x, y, z };
      s.setFocus(x, y, z);
    };
    move(focus.x, focus.y, focus.z);
    await s.settle();
    expect(expectSettledCover(focus)).toBeGreaterThan(20);
    const cold = { ...stats };
    const c0 = { ...lod.counters };
    // A 160 m flight along x at about 40 m/s: a 2 m step every ~50 ms of updates (the work streams behind it, as in a game).
    // Its second half with the queue kept full by other work (a fast flight's loads): the levels still swap, with seams.
    let busy = 0, sleeperId = 5e7, full = 0;
    // Topped up right before each update too (a 2 ms timer alone fell behind the workers on a busy host).
    const topUp = (): void => { for (let n = busy && workers.room(); n > 0; n--) void workers.submit({ id: sleeperId++, kind: 'test-sleep', lane: 'mip', distance: 0, input: { ms: 5 }, transfer: [] }); };
    const fill = setInterval(topUp, 2);
    const t0 = performance.now();
    for (let step = 1; step <= 160; step++) {
      focus.x = -160 + 2 * step;
      move(focus.x, focus.y, focus.z);
      if (step === 81) busy = lod.counters.swaps;
      for (let k = 0; k < 6; k++, topUp(), full += busy && workers.room() === 0 ? 1 : 0, s.update(), await sleep(8));
    }
    clearInterval(fill), expect([full > 200, lod.counters.swaps - busy > 2]).toEqual([true, true]);
    const flightMs = performance.now() - t0;
    await s.settle();
    expect(expectSettledCover(focus)).toBeGreaterThan(20);
    const flight = { swaps: lod.counters.swaps - c0.swaps, levelChanges: lod.counters.levelChanges - c0.levelChanges, lost: lod.counters.lost - c0.lost, choices: lod.counters.choices - c0.choices };
    expect(stats.doubled).toBe(0);
    expect(stats.unbalanced).toBe(0);
    expect(stats.silent).toBe(0);
    expect(stats.uncovered).toBe(0);
    expect(stats.bare).toBe(0);
    expect(stats.notResident).toBe(0);
    expect(flight.levelChanges).toBeGreaterThan(0);
    expect(lod.drawn.countAt(0)).toBeGreaterThan(0);
    expect(lod.drawn.countAt(1)).toBeGreaterThan(0);
    expect(lod.drawn.countAt(2)).toBeGreaterThan(0);
    expect(lod.counters.unbalanced).toBe(0);

    // Jitter of 6 cells either way round the end (12 steps): no node flips, and the last six steps swap nothing.
    jitter = new Set();
    let swaps = -1;
    for (let i = 0; i < 12; i++) {
      if (i === 6) swaps = lod.counters.swaps;
      move(focus.x + (i % 2 === 0 ? 6 : -6), focus.y, focus.z);
      await s.settle();
    }
    expect(stats.flips).toBe(0);
    expect(lod.counters.swaps - swaps).toBe(0);
    const measured = {
      flight: { ...flight, metres: 320 * 0.5, ms: Math.round(flightMs), swapMsP50: Number(lod.swapMs.quantile(0.5).toFixed(1)), swapMsP95: Number(lod.swapMs.quantile(0.95).toFixed(1)), swapMsMax: Number(lod.swapMs.quantile(1).toFixed(1)) },
      events: { cold: cold.events, all: stats.events, seamsBefore: stats.seamsBefore, swaps: stats.swaps, lost: stats.lost, pastReach: stats.pastReach, jitterStandInsLeft: stats.standInsLeft },
      drawn: [0, 1, 2].map((l) => lod.drawn.countAt(l)),
      planMsP50: Number(s.planMs.quantile(0.5).toFixed(2)),
      planMsP95: Number(s.planMs.quantile(0.95).toFixed(2)),
    };
    console.log('levels', JSON.stringify(measured));
  }, 300_000);
});
