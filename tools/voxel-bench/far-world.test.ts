/**
 * The far world and its far cache at real boundaries: region files written
 * column by column in `worker_threads` workers and read back from disk, the
 * far cache built from them in workers and in one thread (byte for byte the
 * same), far data over every part of the world, an edit through the
 * workspace's voxel world commands rebuilding exactly its ancestors (the
 * result byte for byte a full build), and the town's doors and windows
 * closed at levels 1 and 2 (no "legs" under far front walls).
 */
import { cpSync, mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildFarNode, farAncestors, FarField, farVertexLook, FAR_POSITION_ORIGIN_CELLS, FAR_VERTEX_BYTES, FarSelection, localIndex, mipNodeKey, POSITION_STEPS_PER_CELL, regionFarSource, STREAM_POOL_SETTINGS, valueRole, VOXEL_ROLE, WORLD_RULES, WorkerPool, type FarCells, type FarEvent, type FarNodeDraw, type MipNode } from '@thirdlight/voxel';
import { buildFarCache, farCacheDir, FarCacheReader, FarWorldSource, openShippedWorld, readFarCacheManifest, rebuildFarCache, VoxelWorlds } from '@thirdlight/workspace';
import { hexToBytes } from '@thirdlight/shared';
import { farWorldColumns, farWorldDirs, writeFarWorldColumn, FAR_WORLD_GRID } from './far-world';
import { buildFarCacheInPool, FarPool, PIXELS_PER_RADIAN_720P, writeFarWorld } from './far-world-run';
import { bundleWorker, DiskRegions, nodePoolWorker, REPO } from './stream-node';
import { MAT } from './world-kit';

const root = join(tmpdir(), `tl-far-world-${process.pid}-${Date.now().toString(36)}`);
const projectDir = join(root, 'p');
/** 512 m: four region columns, the town at the centre and rolling ground round it (the mountains need kilometres). */
const SIZE_KM = 0.5;
let pool: FarPool;
let worldDir: string;

/** Every file under a folder, relative path → base64. */
function filesOf(dir: string, sub = ''): Record<string, string> {
  const out: Record<string, string> = {};
  for (const e of readdirSync(join(dir, sub), { withFileTypes: true })) {
    const rel = sub === '' ? e.name : `${sub}/${e.name}`;
    if (e.isDirectory()) Object.assign(out, filesOf(dir, rel));
    else out[rel] = readFileSync(join(dir, rel)).toString('base64');
  }
  return out;
}

beforeAll(async () => {
  mkdirSync(root, { recursive: true });
  const file = await bundleWorker('far-worker-node', join(REPO, 'dist', 'voxel-bench', `far-worker-test-${process.pid}.mjs`));
  pool = new FarPool(file, 2);
  const w = await writeFarWorld(pool, projectDir, { sizeKm: SIZE_KM, reserveBytes: 0 });
  expect(w.stopped).toBeNull();
  worldDir = w.dir;
}, 120_000);

afterAll(async () => {
  await pool?.close();
  rmSync(root, { recursive: true, force: true });
  rmSync(join(REPO, 'dist', 'voxel-bench', `far-worker-test-${process.pid}.mjs`), { force: true });
});

describe('the far world on disk', () => {
  it('is written by the workers exactly as one thread writes it, and reads back as a world', () => {
    const { gridDir } = farWorldDirs(projectDir);
    const here = join(root, 'one-thread');
    for (const [rx, rz] of farWorldColumns(SIZE_KM).slice(0, 2)) {
      const w = writeFarWorldColumn(here, rx, rz, { sizeKm: SIZE_KM });
      for (const f of w.files) expect(readFileSync(join(here, f)).equals(readFileSync(join(gridDir, f))), f).toBe(true);
    }
    const shipped = openShippedWorld(worldDir);
    // The town's square at the centre: ground at y 0 (its top cell is grass, the cell above air or a house).
    expect(shipped.chunkBytes({ cx: 0, cy: -1, cz: 0 })).not.toBeNull();
    // Under a mountain the chunks are whole rock: uniform entries, not stored bytes.
    const world = new FarWorldSource(worldDir);
    expect(typeof world.chunk(-16, -4, -16)).toBe('number');
  });
});

describe('the far cache', () => {
  it('builds the same bytes in workers and in one thread, with nodes over every part of the world', async () => {
    const inPool = join(root, 'cache-pool');
    const inThread = join(root, 'cache-thread');
    const a = await buildFarCacheInPool(pool, worldDir, inPool);
    await buildFarCache(worldDir, inThread);
    expect(filesOf(inPool)).toEqual(filesOf(inThread));
    expect(a.manifest.minLevel).toBe(2);
    // 512 m: 32 chunks a side, so two level-4 nodes (one a region) span it.
    expect(a.manifest.maxLevel).toBe(4);
    const index = new FarCacheReader(inPool).index();
    // Every 64 m column of the world has far data (no part of it is missing), and so has every level.
    const half = 512 / 32;
    for (let nx = -half / 4; nx < half / 4; nx++) for (let nz = -half / 4; nz < half / 4; nz++) {
      expect(index.nodes(2).some((n) => n.nx === nx && n.nz === nz), `${nx},${nz}`).toBe(true);
    }
    for (let l = 2; l <= 4; l++) expect(index.nodes(l).length).toBeGreaterThan(0);
    // Seen from the town square, the whole world is drawn (no cut-off) inside the default budget.
    const s = new FarSelection().select(index, { eye: [0, 4, 0], pixelsPerRadian: PIXELS_PER_RADIAN_720P, near: { min: [-384, -188, -384], max: [384, 196, 384] } });
    expect(s.heldByBudget).toBe(0);
    expect(s.drawn.length).toBeGreaterThan(0);
  }, 120_000);

  it('rebuilds exactly the ancestors of an edit, and then equals a full build', async () => {
    const cache = join(root, 'cache-edit');
    const built = await buildFarCacheInPool(pool, worldDir, cache);
    // The world in a project the workspace's voxel worlds serve: one dig command through them.
    const p = join(root, 'edit');
    cpSync(projectDir, p, { recursive: true });
    const worlds = new VoxelWorlds({ projectDir: (id) => (id === 'p' ? p : null) });
    const dig = { v: 2, grid: 0, kind: 'fill', min: [300, -20, 300], max: [340, 10, 330], mode: 'dig' };
    const r = await worlds.command('p', { op: 'editVoxels', projectId: 'p', args: { world: 'far', command: dig } });
    expect(r.ok).toBe(true);
    const chunks = r.ok ? r.chunks.map(([cx, cy, cz]) => ({ cx, cy, cz })) : [];
    expect(chunks.length).toBeGreaterThan(1);
    const before = filesOf(cache);
    const editedWorld = join(p, 'voxels', 'far');
    const report = rebuildFarCache(editedWorld, cache, chunks);
    const ancestors = farAncestors(chunks, built.manifest.minLevel, built.manifest.maxLevel);
    expect(report.rebuilt.map(mipNodeKey)).toEqual(ancestors.map(mipNodeKey));
    // One level-2 to level-5 chain per distinct ancestor; only the files holding them were written.
    const after = filesOf(cache);
    for (const f of Object.keys(after)) if (f !== 'far.json' && !report.files.includes(f)) expect(after[f], f).toBe(before[f]);
    expect(report.files.length).toBeLessThanOrEqual(ancestors.length);
    expect(report.files.some((f) => after[f] !== before[f])).toBe(true);
    // The rebuilt cache equals one built from scratch from the edited world.
    const fresh = join(root, 'cache-fresh');
    await buildFarCache(editedWorld, fresh);
    expect(after).toEqual(filesOf(fresh));
  }, 120_000);

  it('closes the town houses’ doors and windows at levels 1 and 2 (no legs)', () => {
    const world = new FarWorldSource(worldDir);
    const l1 = new Map<string, FarCells>();
    const l2 = new Map<string, FarCells>();
    const keep = (n: MipNode, c: FarCells): void => void (n.level === 1 ? l1 : n.level === 2 ? l2 : null)?.set(mipNodeKey(n), c);
    // The town: chunks −8 … 7 on x and z, its ground and houses in chunk rows −4 … 1 (level-2 rows −1 and 0).
    for (let nx = -2; nx < 2; nx++) for (let nz = -2; nz < 2; nz++) for (const ny of [-1, 0]) {
      buildFarNode(world, { level: 2, nx, ny, nz }, keep);
    }
    const cellAt = (map: Map<string, FarCells>, level: number, x: number, y: number, z: number): number => {
      const s = FAR_WORLD_GRID.shift;
      const c = map.get(mipNodeKey({ level, nx: x >> s, ny: y >> s, nz: z >> s }));
      if (c === null || c === undefined) return VOXEL_ROLE.air;
      if (typeof c === 'number') return valueRole(c);
      return c.role[localIndex(FAR_WORLD_GRID, x & 31, y & 31, z & 31)]!;
    };
    const solid = (r: number): boolean => r !== VOXEL_ROLE.air && r !== VOXEL_ROLE.opening && r !== VOXEL_ROLE.liquid;
    // A leg gap: the coarse cell over an opening is open while the wall goes on solid on both sides of it in its row.
    const legGap = (map: Map<string, FarCells>, level: number, x: number, y: number, z: number): boolean => {
      if (solid(cellAt(map, level, x, y, z))) return false;
      return (solid(cellAt(map, level, x - 1, y, z)) && solid(cellAt(map, level, x + 1, y, z))) || (solid(cellAt(map, level, x, y, z - 1)) && solid(cellAt(map, level, x, y, z + 1)));
    };
    let openings = 0;
    let gaps1 = 0;
    let gaps2 = 0;
    for (let cx = -8; cx < 8; cx++) for (let cz = -8; cz < 8; cz++) for (let cy = -4; cy < 2; cy++) {
      const c = world.chunk(cx, cy, cz);
      if (c === null || typeof c === 'number') continue;
      for (let x = 0; x < 32; x++) for (let z = 0; z < 32; z++) for (let y = 0; y < 32; y++) {
        if (c.role[localIndex(FAR_WORLD_GRID, x, y, z)] !== VOXEL_ROLE.opening) continue;
        openings++;
        const wx = cx * 32 + x, wy = cy * 32 + y, wz = cz * 32 + z;
        if (legGap(l1, 1, wx >> 1, wy >> 1, wz >> 1)) gaps1++;
        if (legGap(l2, 2, wx >> 2, wy >> 2, wz >> 2)) gaps2++;
      }
    }
    expect(openings).toBeGreaterThan(1000);
    expect(gaps1).toBe(0);
    expect(gaps2).toBe(0);
  }, 120_000);
});

/** A far node's mesh triangles without its skirts (the skirts are the last ones), as world-cell edges on one axis plane. */
function planeEdges(d: FarNodeDraw, axis: 0 | 1 | 2, plane: number, which: 'crossing' | 'lying' | 'all' = 'crossing'): Set<string> {
  const m = d.mesh;
  const view = new DataView(m.vertices.buffer, m.vertices.byteOffset, m.vertices.byteLength);
  const scale = 2 ** d.level;
  const corner = [d.nx * 32, d.ny * 32, d.nz * 32];
  // World cells × 1024 of the level, exact integers.
  const at = (v: number): number[] => [0, 1, 2].map((a) => (corner[a]! - FAR_POSITION_ORIGIN_CELLS) * POSITION_STEPS_PER_CELL + view.getUint16(v * FAR_VERTEX_BYTES + a * 2, true)).map((x) => x * scale);
  const out = new Set<string>();
  const plain = m.indices.length - m.skirtTriangles * 3;
  const want = plane * POSITION_STEPS_PER_CELL * scale;
  for (let t = 0; t < plain; t += 3) {
    // A face lying in the plane is one side's own (a wall on the boundary, toward air on the other side): faces crossing the plane end on it or on the other side's crossing faces.
    const lying = [0, 1, 2].every((k) => at(m.indices[t + k]!)[axis] === want);
    if ((which === 'crossing' && lying) || (which === 'lying' && !lying)) continue;
    for (let k = 0; k < 3; k++) {
      const a = at(m.indices[t + k]!), b = at(m.indices[t + ((k + 1) % 3)]!);
      if (a[axis] !== want || b[axis] !== want) continue;
      const ka = a.join(','), kb = b.join(',');
      out.add(ka < kb ? `${ka}|${kb}` : `${kb}|${ka}`);
    }
  }
  return out;
}

/** The largest distance (world cells of the level) from an end of an edge in `from` to the nearest edge of `to`. */
function farthestEnd(from: ReadonlySet<string>, to: ReadonlySet<string>, scale: number): number {
  const seg = [...to].map((e) => e.split('|').map((p) => p.split(',').map(Number)));
  const gap = (p: number[]): number =>
    Math.min(
      ...seg.map(([a, b]) => {
        const ab = [0, 1, 2].map((k) => b![k]! - a![k]!);
        const ap = [0, 1, 2].map((k) => p[k]! - a![k]!);
        const len2 = ab.reduce((s, v) => s + v * v, 0);
        const t = Math.max(0, Math.min(1, ap.reduce((s, v, k) => s + v * ab[k]!, 0) / len2));
        return Math.hypot(...[0, 1, 2].map((k) => ap[k]! - ab[k]! * t));
      }),
    );
  let worst = 0;
  for (const e of from) for (const p of e.split('|')) worst = Math.max(worst, gap(p.split(',').map(Number)));
  return worst / (POSITION_STEPS_PER_CELL * scale);
}

describe('the far field drawn as meshes', () => {
  it('meshes the selection in workers from the cache on disk, swaps whole, meets same-level neighbours exactly, colours from the cells, and meshes an edit again', async () => {
    // The world in a project the workspace's voxel worlds serve, its far cache where they keep it.
    const p = join(root, 'field');
    cpSync(projectDir, p, { recursive: true });
    const world = join(p, 'voxels', 'far');
    const cacheDir = farCacheDir(p, 'far');
    await buildFarCacheInPool(pool, world, cacheDir);
    const m = readFarCacheManifest(cacheDir);
    // A file opened again after an edit is read afresh (the cache's rewritten files are new files, as a range read sees them).
    const opened: DiskRegions[] = [];
    const open = (level: number, name: string) => {
      const d = new DiskRegions(join(cacheDir, `L${level}`));
      opened.push(d);
      return d.open(name);
    };
    const source = regionFarSource({ worldId: hexToBytes(m.worldId), grid: FAR_WORLD_GRID, footprint: m.footprint, minLevel: m.minLevel, maxLevel: m.maxLevel, levels: m.levels, maxOpen: 16, open });
    const file = await bundleWorker('stream-worker-node', join(REPO, 'dist', 'voxel-bench', `far-field-worker-${process.pid}.mjs`));
    const workers = new WorkerPool({ size: 2, create: () => nodePoolWorker(file), ...STREAM_POOL_SETTINGS });
    try {
      const far = new FarField({ source, errorPixels: 2 }, { grid: FAR_WORLD_GRID, pool: workers, rules: WORLD_RULES });
      const shown = new Map<string, FarNodeDraw>();
      const events: FarEvent[] = [];
      far.on((e) => {
        events.push(e);
        for (const n of e.removed) shown.delete(mipNodeKey(n));
        for (const a of e.added) shown.set(mipNodeKey(a), a);
        // Never two drawn nodes over one place: no drawn node has a drawn ancestor.
        for (const a of shown.values()) for (let l = a.level + 1; l <= m.maxLevel; l++) expect(shown.has(mipNodeKey({ level: l, nx: a.nx >> (l - a.level), ny: a.ny >> (l - a.level), nz: a.nz >> (l - a.level) })), mipNodeKey(a)).toBe(false);
      });
      far.setEye(0, 8, 0);
      far.update();
      await far.settle();
      const metrics = far.metrics();
      expect(metrics.problem).toBeNull();
      expect(metrics.pending).toBe(0);
      expect(metrics.drawn).toBe(metrics.nodes);
      expect(shown.size).toBeGreaterThan(8);
      // Nearest at the lowest level, coarser away from the eye.
      expect(Math.min(...[...shown.values()].map((d) => d.level))).toBe(m.minLevel);
      let skirts = 0;
      const looks = new Set<number>();
      for (const d of shown.values()) {
        skirts += d.mesh.skirtTriangles;
        const view = new DataView(d.mesh.vertices.buffer, d.mesh.vertices.byteOffset, d.mesh.vertices.byteLength);
        for (let v = 0; v < d.mesh.vertexCount; v++) looks.add(farVertexLook(view.getUint16(v * FAR_VERTEX_BYTES + 6, true)).material);
      }
      expect(skirts).toBeGreaterThan(0);
      // Every vertex has the material of a cell of the world behind it (the ground's and the town's), never air.
      expect(looks.has(0), `${[...looks]}`).toBe(false);
      for (const mat of [MAT.grass, MAT.rock]) expect(looks.has(mat), `${[...looks]}`).toBe(true);
      // Two drawn neighbours of one level meet edge for edge on the face between them (without skirts): no crack.
      let faces = 0;
      let worstGap = 0;
      for (const a of shown.values()) {
        const b = shown.get(mipNodeKey({ level: a.level, nx: a.nx + 1, ny: a.ny, nz: a.nz }));
        if (b === undefined) continue;
        const ea = planeEdges(a, 0, (a.nx + 1) * 32);
        const eb = planeEdges(b, 0, b.nx * 32);
        if (ea.size === 0 && eb.size === 0) continue;
        faces++;
        // The same boundary line from both sides: every end of one side's edges lies on an edge of the other's (a merged
        // face on one side may span what the other splits, never leaving a gap).
        // What one side's edges on the plane end on: the other side's edges there (its nodes above and below too: the
        // surface may cross into them right at the plane) and its own faces lying in the plane.
        const column = (y: FarNodeDraw): FarNodeDraw[] => [y, ...[-1, 1].flatMap((dy) => shown.get(mipNodeKey({ level: y.level, nx: y.nx, ny: y.ny + dy, nz: y.nz })) ?? [])];
        const meets = (x: FarNodeDraw, y: FarNodeDraw, px: number, py: number): Set<string> => new Set([...column(y).flatMap((c) => [...planeEdges(c, 0, py, 'all')]), ...column(x).flatMap((c) => [...planeEdges(c, 0, px, 'lying')])]);
        const s = 2 ** a.level;
        worstGap = Math.max(worstGap, farthestEnd(ea, meets(a, b, (a.nx + 1) * 32, b.nx * 32), s), farthestEnd(eb, meets(b, a, b.nx * 32, (a.nx + 1) * 32), s));
      }
      expect(faces).toBeGreaterThan(0);
      expect(worstGap).toBe(0);
      // An edit through the workspace's commands: the backend rebuilds the cache's ancestors, the far field reads them again.
      const worlds = new VoxelWorlds({ projectDir: (id) => (id === 'p' ? p : null) });
      const r = await worlds.command('p', { op: 'editVoxels', projectId: 'p', args: { world: 'far', command: { v: 2, grid: 0, kind: 'fill', min: [-40, -30, -40], max: [-8, 40, -8], mode: 'dig' } } });
      expect(r.ok && r.far).toMatchObject({ nodes: expect.any(Number) });
      const chunks = r.ok ? r.chunks.map(([cx, cy, cz]) => ({ cx, cy, cz })) : [];
      const l2 = farAncestors(chunks, m.minLevel, m.minLevel).map(mipNodeKey);
      const before = new Map([...shown].filter(([k]) => l2.includes(k)).map(([k, d]) => [k, d.mesh.vertices.slice()]));
      expect(before.size).toBeGreaterThan(0);
      const seen = events.length;
      far.refresh(chunks);
      await far.settle();
      const again = events.slice(seen).flatMap((e) => e.added.map(mipNodeKey));
      for (const k of before.keys()) {
        expect(again, k).toContain(k);
        expect(Buffer.from(shown.get(k)!.mesh.vertices).equals(Buffer.from(before.get(k)!)), k).toBe(false);
      }
      far.close();
    } finally {
      for (const d of opened) await d.close();
      workers.close();
      rmSync(file, { force: true });
    }
  }, 120_000);
});
