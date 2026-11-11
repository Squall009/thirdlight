import { latticeHash4 } from '@thirdlight/shared';
import { describe, expect, it } from 'vitest';
import { apronBytes, apronCellCount, apronVoxelAt, buildApron, dependentChunks } from './apron';
import { chunkGrid, chunkKey, type ChunkGrid } from './coords';
import { createDenseChunk } from './dense-chunk';
import { DirtyTracker } from './dirty-tracker';
import { DEFAULT_REBASE_DISTANCE_M, FloatingOrigin } from './floating-origin';
import { JobQueue } from './job-queue';
import { createWorldStore, type PaletteStore } from './palette-store';
import { MATERIAL_AIR, SHAPE_FULL, VOXEL_ROLE, voxel, type VoxelRecord } from './record';
import { deriveNow } from './stream-handlers';
import { FocusMotion, readOrder, StreamReadPlan, STREAM_WIDEN_AFTER_MS } from './stream-reads';
import { chunkDistance2, DEFAULT_STREAM_RING, inLoadRing, pastUnloadRing, ringChunks } from './stream-ring';

const grid = chunkGrid(32);

/** A deterministic value in [0, 1) per integer triple. */
const h = (x: number, y: number, z: number, s = 1): number => latticeHash4(x, y, z, s) / 2 ** 32;

/**
 * A test world over chunks [c0, c1)³: ground whose surface wanders around
 * y = 40 with partly full surface cells, some air pockets, some oriented
 * construction cells and a liquid pool; chunks far above are absent, far
 * below uniform rock.
 */
function makeWorld(g: ChunkGrid, c0: number, c1: number, y0: number, y1: number): PaletteStore {
  const store = createWorldStore(g);
  const cells = createDenseChunk(g);
  for (let cx = c0; cx < c1; cx++) for (let cz = c0; cz < c1; cz++) for (let cy = y0; cy < y1; cy++) {
    let any = false;
    for (let lx = 0; lx < g.edge; lx++) for (let lz = 0; lz < g.edge; lz++) {
      const x = (cx << g.shift) + lx;
      const z = (cz << g.shift) + lz;
      const surface = 40 + Math.floor(6 * Math.sin(x / 9) + 5 * Math.cos(z / 7));
      for (let ly = 0; ly < g.edge; ly++) {
        const y = (cy << g.shift) + ly;
        const i = (((lx << g.shift) | lz) << g.shift) | ly;
        let m = 0;
        let cat = 0;
        let shape = 0;
        let o = 0;
        if (y < surface && !(y > 20 && h(x >> 2, y >> 2, z >> 2) < 0.08)) {
          m = y < surface - 4 ? 3 : 2;
          cat = VOXEL_ROLE.terrain;
          shape = y === surface - 1 ? 1 + ((x * 7 + z) % 14) : SHAPE_FULL;
        } else if (y < 38 && x % 50 < 10) {
          m = 9;
          cat = VOXEL_ROLE.liquid;
          shape = y === 37 ? 9 : SHAPE_FULL;
        } else if (y >= surface && y < surface + 3 && h(x, y, z, 2) < 0.02) {
          m = 5;
          cat = VOXEL_ROLE.wall;
          shape = SHAPE_FULL;
          o = (x + z) & 3;
        }
        cells.material[i] = m;
        cells.role[i] = cat;
        cells.shape[i] = shape;
        cells.wetness[i] = o;
        if (m !== 0) any = true;
      }
    }
    if (any) store.importChunk(cx, cy, cz, cells);
  }
  return store;
}

const v = (): VoxelRecord => voxel();

describe('job queue', () => {
  it('orders by lane, then distance, then arrival; moves and removes jobs', () => {
    const q = new JobQueue<string>();
    q.push(1, 'far', 5, 'far5');
    q.push(2, 'near', 50, 'near50');
    q.push(3, 'near', 10, 'near10');
    q.push(4, 'edit', 900, 'edit900');
    q.push(5, 'near', 10, 'near10b');
    q.push(6, 'far', 1, 'far1');
    expect(q.remove(6)).toBe('far1');
    expect(q.update(1, 'near', 0)).toBe(true);
    const order: string[] = [];
    for (let e = q.pop(); e !== undefined; e = q.pop()) order.push(e.value);
    expect(order).toEqual(['edit900', 'far5', 'near10', 'near10b', 'near50']);
    expect(q.update(99, 'far', 0)).toBe(false);
  });

  it('stays a heap under random pushes, updates and removes', () => {
    const q = new JobQueue<number>();
    const live = new Map<number, [number, number, number]>();
    let seq = 0;
    for (let i = 0; i < 2000; i++) {
      const r = h(i, 0, 0);
      if (r < 0.5 || live.size === 0) {
        const lane = Math.floor(h(i, 1, 0) * 3);
        const d = Math.floor(h(i, 2, 0) * 100);
        q.push(i, (['edit', 'near', 'far'] as const)[lane]!, d, i);
        live.set(i, [lane, d, seq++]);
      } else {
        const ids = [...live.keys()];
        const id = ids[Math.floor(h(i, 3, 0) * ids.length)]!;
        if (r < 0.75) {
          q.remove(id);
          live.delete(id);
        } else {
          const d = Math.floor(h(i, 4, 0) * 100);
          q.update(id, 'near', d);
          live.set(id, [1, d, live.get(id)![2]]);
        }
      }
    }
    const want = [...live].sort((a, b) => a[1][0] - b[1][0] || a[1][1] - b[1][1] || a[1][2] - b[1][2]).map((e) => e[0]);
    const got: number[] = [];
    for (let e = q.pop(); e !== undefined; e = q.pop()) got.push(e.id);
    expect(got).toEqual(want);
  });
});

describe('chunk payloads', () => {
  it('moves a chunk between stores with no per-cell work, equal cell for cell; refuses damaged payloads', () => {
    const a = makeWorld(grid, 0, 2, 0, 2);
    const b = createWorldStore(grid);
    const x = v();
    const y = v();
    for (let cx = 0; cx < 2; cx++) for (let cz = 0; cz < 2; cz++) for (let cy = 0; cy < 2; cy++) {
      const p = a.chunkPayload(cx, cy, cz, true);
      b.adoptPayload(cx, cy, cz, p);
      expect(b.chunkForm(cx, cy, cz)).toBe(a.chunkForm(cx, cy, cz));
      expect(b.chunkBytes(cx, cy, cz)).toBeLessThanOrEqual(a.chunkBytes(cx, cy, cz) + 64);
    }
    for (let x0 = 0; x0 < 64; x0++) for (let z0 = 0; z0 < 64; z0++) for (let y0 = 0; y0 < 64; y0++) {
      a.voxelAt(x0, y0, z0, x);
      b.voxelAt(x0, y0, z0, y);
      if (x.material !== y.material || x.shape !== y.shape || x.role !== y.role || x.wetness !== y.wetness) throw new Error(`cell ${x0},${y0},${z0} differs`);
    }
    // Handing the arrays over drops the chunk here.
    const moved = a.chunkPayload(0, 1, 0, false);
    expect(moved.form).toBe('stored');
    expect(a.chunkForm(0, 1, 0)).toBe('absent');
    // Damaged payloads are refused and leave the target as it was.
    const good = b.chunkPayload(1, 1, 1, true);
    if (good.form !== 'stored') throw new Error('expected a stored chunk');
    const layout = good.wire.plane.layout;
    if (layout.kind !== 'bricks') throw new Error('expected a brick layout');
    const before = b.chunkPayload(1, 1, 1, true);
    const brick = layout.brick.slice();
    brick[0] = 60000;
    expect(() => b.adoptPayload(1, 1, 1, { ...good, wire: { ...good.wire, plane: { ...good.wire.plane, layout: { ...layout, brick } } } })).toThrow(RangeError);
    const meta = good.wire.plane.meta.slice();
    meta[0] = meta[0]! + 1;
    expect(() => b.adoptPayload(1, 1, 1, { ...good, wire: { ...good.wire, plane: { ...good.wire.plane, meta } } })).toThrow(RangeError);
    expect(() => b.adoptPayload(1, 1, 1, { ...good, edge: 16 })).toThrow(RangeError);
    expect(b.chunkPayload(1, 1, 1, true)).toEqual(before);
  });
});

describe('aprons', () => {
  const world = makeWorld(grid, -1, 2, 0, 3);
  const known = (cx: number, cy: number, cz: number): boolean => cx >= -1 && cx < 2 && cz >= -1 && cz < 2 && cy >= 0 && cy < 3;

  it('reads every cell within R of a chunk exactly as the store holds it, across every neighbour', () => {
    const x = v();
    const y = v();
    for (const r of [1, 2, 4, 32]) {
      const a = buildApron(world, 0, 1, 0, r, known);
      let dense = 0;
      for (let k = 0; k < 26; k++) dense += a.dense[k]!;
      expect(a.values.length).toBeLessThanOrEqual(apronCellCount(32, r));
      expect(dense).toBeGreaterThan(0);
      for (let lx = -r; lx < 32 + r; lx++) for (let lz = -r; lz < 32 + r; lz++) for (let ly = -r; ly < 32 + r; ly++) {
        if (lx >= 0 && lx < 32 && ly >= 0 && ly < 32 && lz >= 0 && lz < 32) continue;
        apronVoxelAt(a, lx, ly, lz, x);
        world.voxelAt(lx, 32 + ly, lz, y);
        if (x.material !== y.material || x.shape !== y.shape || x.role !== y.role || x.wetness !== y.wetness) throw new Error(`R ${r}: apron cell ${lx},${ly},${lz} differs`);
      }
    }
  });

  it('keeps a strip over air or one voxel as one value, and refuses a neighbour it does not know', () => {
    // Chunk (0, 2, 0) is sky: the strips above and beside it are absent (air), only the ground below is stored.
    const a = buildApron(world, 0, 2, 0, 2, () => true);
    let dense = 0;
    for (let k = 0; k < 26; k++) dense += a.dense[k]!;
    expect(dense).toBe(9);
    expect(apronBytes(a)).toBeLessThan(apronCellCount(32, 2) * 5 * 0.4);
    expect(() => buildApron(world, 1, 1, 1, 2, known)).toThrow(/not known/);
    expect(() => buildApron(world, 0, 1, 0, 33)).toThrow(RangeError);
  });

  it('names every chunk an edit can reach within R: corners reach 8 chunks, a box over a chunk all 27', () => {
    const one = (x: number, y: number, z: number, r: number): number => dependentChunks(grid, { minX: x, minY: y, minZ: z, maxX: x, maxY: y, maxZ: z }, r).length;
    expect(one(16, 16, 16, 2)).toBe(1);
    expect(one(31, 16, 16, 2)).toBe(2);
    expect(one(31, 31, 16, 2)).toBe(4);
    expect(one(31, 31, 31, 2)).toBe(8);
    expect(one(32, 32, 32, 2)).toBe(8);
    expect(one(31, 31, 31, 0)).toBe(1);
    expect(one(29, 16, 16, 2)).toBe(1);
    expect(one(30, 16, 16, 2)).toBe(2);
    expect(dependentChunks(grid, { minX: 0, minY: 0, minZ: 0, maxX: 31, maxY: 31, maxZ: 31 }, 1).length).toBe(27);
  });

  it('derives from a chunk and its apron what a whole-world pass derives (R 1 and 2)', () => {
    const x = v();
    for (const r of [1, 2]) {
      for (const [cx, cy, cz] of [
        [0, 1, 0],
        [0, 0, 0],
      ] as const) {
        const out = deriveNow({ edge: 32, chunk: { grid: 0, cx, cy, cz }, payload: world.chunkPayload(cx, cy, cz, true), radius: r, apron: buildApron(world, cx, cy, cz, r) });
        let solid = 0;
        let exposed = 0;
        const ox = cx * 32;
        const oy = cy * 32;
        const oz = cz * 32;
        for (let lx = 0; lx < 32; lx++) for (let lz = 0; lz < 32; lz++) for (let ly = 0; ly < 32; ly++) {
          if (world.voxelAt(ox + lx, oy + ly, oz + lz, x).material === MATERIAL_AIR) continue;
          solid++;
          let open = false;
          for (let dx = -r; dx <= r && !open; dx++) for (let dz = -r; dz <= r && !open; dz++) for (let dy = -r; dy <= r && !open; dy++) if (world.voxelAt(ox + lx + dx, oy + ly + dy, oz + lz + dz, x).material === MATERIAL_AIR) open = true;
          const i = (((lx << 5) | lz) << 5) | ly;
          const bit = out.mask === null ? 0 : (out.mask[i >>> 5]! >>> (i & 31)) & 1;
          if (bit !== (open ? 1 : 0)) throw new Error(`R ${r}: cell ${lx},${ly},${lz} of (${cx},${cy},${cz}) exposure differs`);
          if (open) exposed++;
        }
        expect(out.solid).toBe(solid);
        expect(out.exposed).toBe(exposed);
        expect(exposed).toBeGreaterThan(0);
      }
    }
  });
});

describe('dirty tracker input stamps', () => {
  it('refuses a result once its chunk, or a neighbour within R, changed; and across unload and reload', () => {
    const t = new DirtyTracker();
    const a = { grid: 0, key: chunkKey(grid, 0, 0, 0) };
    const b = { grid: 0, key: chunkKey(grid, 1, 0, 0) };
    t.loaded(a);
    t.loaded(b);
    const j1 = t.beginJob(a);
    t.invalidated(a);
    expect(t.acceptResult(j1.id)).toEqual({ ok: false, reason: 'superseded' });
    expect(t.isDirty(a)).toBe(false);
    const group = t.beginJob([a, b]);
    t.edited(b);
    expect(t.acceptResult(group.id)).toEqual({ ok: false, reason: 'superseded' });
    const j2 = t.beginJob(a);
    expect(t.unload(a)).toBe(true);
    t.loaded(a);
    expect(t.acceptResult(j2.id)).toEqual({ ok: false, reason: 'superseded' });
    const j3 = t.beginJob(a);
    t.expireJob(j3.id);
    expect(t.acceptResult(j3.id)).toEqual({ ok: false, reason: 'unknown_job' });
    const j4 = t.beginJob([a, b]);
    expect(t.acceptResult(j4.id)).toEqual({ ok: true });
  });
});

describe('streaming ring', () => {
  it('lists the load bounds nearest first, with hysteresis before unloading', () => {
    const f = { x: 1000.5, y: 64, z: -2000.25 };
    const r = DEFAULT_STREAM_RING;
    const list = ringChunks(grid, r, f);
    expect(list.length).toBeGreaterThan(1000);
    for (let i = 1; i < list.length; i++) expect(list[i]!.d2).toBeGreaterThanOrEqual(list[i - 1]!.d2);
    for (const c of list) expect(pastUnloadRing(grid, r, f, c.cx, c.cy, c.cz)).toBe(false);
    // A focus moving one chunk and back unloads nothing it loaded.
    const g = { x: f.x + 32, y: f.y, z: f.z };
    for (const c of list) expect(pastUnloadRing(grid, r, g, c.cx, c.cy, c.cz)).toBe(false);
    const far = { x: f.x + r.unloadRadius + 64, y: f.y, z: f.z };
    expect(list.some((c) => pastUnloadRing(grid, r, far, c.cx, c.cy, c.cz))).toBe(true);
    expect(inLoadRing(grid, r, f, list[0]!.cx, list[0]!.cy, list[0]!.cz)).toBe(true);
    expect(chunkDistance2(grid, f, list[0]!.cx, list[0]!.cy, list[0]!.cz)).toBe(list[0]!.d2);
  });
});

describe('read order and prefetch', () => {
  const g = chunkGrid(32);
  const ring = DEFAULT_STREAM_RING;

  it('keeps a column together, nearest column first, the focus height first inside it; the same chunks as the ring', () => {
    const f = { x: 40, y: 120, z: -70 };
    const list = readOrder(g, ring, f, f);
    const ringSet = new Set(ringChunks(g, ring, f).map((w) => chunkKey(g, w.cx, w.cy, w.cz)));
    expect(list.length).toBe(ringSet.size);
    expect(list.every((w) => ringSet.has(chunkKey(g, w.cx, w.cy, w.cz)))).toBe(true);
    const h2 = (cx: number, cz: number): number => ((cx << 5) + 16 - f.x) ** 2 + ((cz << 5) + 16 - f.z) ** 2;
    const seenColumns = new Set<number>();
    for (let i = 0; i < list.length; i++) {
      const w = list[i]!;
      expect(w.d2).toBe(chunkDistance2(g, f, w.cx, w.cy, w.cz));
      if (i === 0 || list[i - 1]!.column !== w.column) {
        // A column starts once, at or past the previous column's distance.
        expect(seenColumns.has(w.column)).toBe(false);
        seenColumns.add(w.column);
        if (i > 0) expect(h2(w.cx, w.cz)).toBeGreaterThanOrEqual(h2(list[i - 1]!.cx, list[i - 1]!.cz));
      } else {
        const p = list[i - 1]!;
        expect([p.cx, p.cz]).toEqual([w.cx, w.cz]);
        expect(Math.abs((w.cy << 5) + 16 - f.y)).toBeGreaterThanOrEqual(Math.abs((p.cy << 5) + 16 - f.y));
      }
    }
  });

  it('wants the ring around the focus and around the lead point, the lead side first', () => {
    const f = { x: 0, y: 120, z: 0 };
    const lead = { x: 160, y: 120, z: 0 };
    const list = readOrder(g, ring, f, lead);
    const keys = new Set(list.map((w) => chunkKey(g, w.cx, w.cy, w.cz)));
    expect(keys.size).toBe(list.length);
    for (const p of [f, lead]) for (const w of ringChunks(g, ring, p)) expect(keys.has(chunkKey(g, w.cx, w.cy, w.cz))).toBe(true);
    // Ahead of the focus past its ring (x 384..544 cells) is wanted; the first columns are around the lead point.
    expect(list.some((w) => (w.cx << 5) > f.x + ring.loadRadius)).toBe(true);
    expect(Math.abs((list[0]!.cx << 5) + 16 - lead.x)).toBeLessThanOrEqual(32);
  });

  it('puts the lead a second ahead of steady motion, capped; a jump or a pause is not motion', () => {
    const m = new FocusMotion(ring.nearRadius);
    // 80 m/s along +x is 160 cells a second, at 60 frames a second.
    let t = 1000;
    for (let i = 0; i <= 60; i++, t += 1000 / 60) m.move({ x: (160 * i) / 60, y: 50, z: 0 }, t);
    t -= 1000 / 60;
    const f = { x: 160, y: 50, z: 0 };
    const lead = m.lead(f, t, 1, 1e9);
    // Smoothed over a quarter second: after a second of steady motion within 2 % of the speed.
    expect(lead.x).toBeGreaterThan(160 + 0.98 * 160);
    expect(lead.x).toBeLessThanOrEqual(320);
    expect(lead.y).toBe(50);
    expect(lead.z).toBe(0);
    expect(m.lead(f, t, 1, 100).x).toBeCloseTo(260, 6);
    expect(m.lead(f, t, 0, 100)).toBe(f);
    // Still for longer than half a second: no lead.
    expect(m.lead(f, t + 600, 1, 1e9)).toBe(f);
    // A jump resets the velocity.
    m.move({ x: 5000, y: 50, z: 0 }, t + 16);
    expect(m.lead({ x: 5000, y: 50, z: 0 }, t + 16, 1, 1e9)).toEqual({ x: 5000, y: 50, z: 0 });
  });

  it('takes a camera placed a little way off (one step, slower than a cut) for no motion: neither speed nor lead', () => {
    const m = new FocusMotion(ring.nearRadius);
    m.move({ x: 0, y: 50, z: 0 }, 1000);
    // 52 cells (26 m) in one 60 Hz frame, then the camera stays: read as a burst it narrowed the ring for half a
    // second, then the ring widened and refilled.
    m.move({ x: 52, y: 50, z: 0 }, 1016);
    for (let t = 1016; t < 1600; t += 16) {
      m.move({ x: 52, y: 50, z: 0 }, t);
      expect(m.speed(t)).toBe(0);
      expect(m.lead({ x: 52, y: 50, z: 0 }, t, 1, 1e9)).toEqual({ x: 52, y: 50, z: 0 });
    }
    // Steady travel is motion again after a smoothing window.
    let x = 52;
    for (let t = 1632; t <= 2000; t += 16) m.move({ x: (x += 2), y: 50, z: 0 }, t);
    expect(m.speed(2000)).toBeGreaterThan(60);
  });

  it('keeps the ring narrowed through a 150 m/s flight whose steps come at uneven ticks, and widens it a while after a stop', () => {
    const base = { loadRadius: 384, unloadRadius: 448, loadHeight: 192, unloadHeight: 256, nearRadius: 192 };
    const plan = new StreamReadPlan<never>(g, base, 1);
    // 300 cells a second in 30 Hz frames of 10 cells, each reaching the plan twice: on its tick and 0.3 ms later
    // again (the simulation's ticks are not the frames).
    let changes = 0;
    let t = 1000;
    const f = { x: 0, y: 100, z: 0 };
    for (let i = 0; i < 300; i++, t += 1000 / 30) {
      const p = { x: 10 * i, y: 100, z: 0 };
      plan.moved(p, t);
      if (plan.update(p, t) && plan.ringChanged) changes++;
      plan.moved({ x: p.x + 0.1, y: 100, z: 0 }, t + 0.3);
      if (plan.update({ x: p.x + 0.1, y: 100, z: 0 }, t + 0.3) && plan.ringChanged) changes++;
      Object.assign(f, p);
    }
    // Narrowed once, never widened in flight.
    expect(changes).toBe(1);
    expect(plan.ring.loadRadius).toBeLessThan(base.loadRadius);
    // Stopped: still narrow until the speed has stayed down for the widening hold, then the base ring.
    const stop = t + 600;
    plan.update(f, stop);
    expect(plan.ring.loadRadius).toBeLessThan(base.loadRadius);
    plan.update(f, stop + STREAM_WIDEN_AFTER_MS - 10);
    expect(plan.ring.loadRadius).toBeLessThan(base.loadRadius);
    plan.update(f, stop + STREAM_WIDEN_AFTER_MS + 10);
    expect(plan.ring).toBe(base);
  });
});

describe('floating origin', () => {
  // A path near the far corner of a 10 km world: 9.9 km out on x and z, 2 km up or down.
  const pointsAt = (y: number): Array<[number, number, number]> => {
    const out: Array<[number, number, number]> = [];
    for (let i = 0; i < 2000; i++) out.push([9900 + h(i, 1, y) * 150 + 0.0001 * i, y + h(i, 2, y) * 30, 9900 + h(i, 3, y) * 150]);
    return out;
  };
  const up = pointsAt(2000);
  const down = pointsAt(-2000);

  /** Largest error (m) of 32-bit positions against the exact ones, absolute or relative to an origin. */
  function maxError(points: ReadonlyArray<[number, number, number]>, origin: FloatingOrigin | null): number {
    const out = new Float32Array(3);
    let worst = 0;
    for (const [x, y, z] of points) {
      if (origin === null) {
        out[0] = x;
        out[1] = y;
        out[2] = z;
        worst = Math.max(worst, Math.abs(out[0] - x), Math.abs(out[1] - y), Math.abs(out[2] - z));
      } else {
        origin.toLocal(x, y, z, out);
        const back = origin.toWorld(out[0]!, out[1]!, out[2]!);
        worst = Math.max(worst, Math.abs(back.x - x), Math.abs(back.y - y), Math.abs(back.z - z));
      }
    }
    return worst;
  }

  it('keeps 32-bit positions within 0.1 mm at 9.9 km and ±2 km, where absolute ones are off by up to ~0.5 mm', () => {
    const o = new FloatingOrigin({ grid: chunkGrid(32) });
    const events: number[] = [];
    o.onRebase((e) => events.push(e.shiftM.x));
    // Fly from the origin out to the corner: the origin follows every ~1 km.
    for (let d = 0; d <= 9900; d += 50) o.update(d, d > 4000 ? 2000 : 0, d);
    expect(o.rebases).toBeGreaterThanOrEqual(9);
    expect(events.every((s) => Number.isInteger(s / 16))).toBe(true);
    o.update(9950, 2000, 9950);
    expect(maxError(up, o)).toBeLessThan(0.0001);
    // Following the focus 4 km down re-bases again, and the deep points are as precise.
    expect(o.update(9950, -2000, 9950)).not.toBeNull();
    expect(maxError(down, o)).toBeLessThan(0.0001);
    // Without re-basing, 32-bit floats step ~0.98 mm at 9.9 km: errors up to half a step.
    const without = Math.max(maxError(up, null), maxError(down, null));
    expect(without).toBeGreaterThan(0.0004);
    expect(without).toBeLessThanOrEqual(0.000489);
  });

  it("snaps the origin to the grid's chunk edge, so chunk-local offsets stay whole at any edge", () => {
    for (const edge of [16, 32] as const) {
      const o = new FloatingOrigin({ grid: chunkGrid(edge), origin: { x: 100, y: -9, z: 7 } });
      expect(o.snapCells).toBe(edge);
      expect(o.origin).toEqual({ x: Math.round(100 / edge) * edge, y: Math.round(-9 / edge) * edge, z: Math.round(7 / edge) * edge });
      const e = o.update(1240, 0, -987.6)!;
      for (const v of [e.to.x, e.to.y, e.to.z]) expect(Number.isInteger(v / edge)).toBe(true);
      // A 16-cell grid lands on 16-cell multiples a 32-cell snap would not reach.
      if (edge === 16) expect(e.to.x % 32).toBe(16);
    }
  });

  it('shows the jitter it prevents: 0.1 mm steps far out move a 32-bit position in ~1 mm jumps', () => {
    const o = new FloatingOrigin({ grid: chunkGrid(32), origin: { x: 19808, y: 4000, z: 19808 } });
    const out = new Float32Array(3);
    let absoluteMoves = 0;
    let localMoves = 0;
    let prevAbs = Math.fround(9904);
    let prevLocal = NaN;
    for (let i = 1; i <= 100; i++) {
      const x = 9904 + i * 0.0001;
      const abs = Math.fround(x);
      if (abs !== prevAbs) absoluteMoves++;
      prevAbs = abs;
      o.toLocal(x, 2000, 9904, out);
      if (out[0] !== prevLocal) localMoves++;
      prevLocal = out[0]!;
    }
    // 100 steps of 0.1 mm: the absolute float moves ~10 times (≈ 0.98 mm a step), the local one every step.
    expect(absoluteMoves).toBeLessThanOrEqual(11);
    expect(localMoves).toBe(100);
    expect(DEFAULT_REBASE_DISTANCE_M).toBe(1000);
    // Cells far out map to exact local metres.
    o.cellToLocal(19808 + 1, 4000 - 3, 19808 + 2000, out);
    expect([...out]).toEqual([0.5, -1.5, 1000]);
  });
});
