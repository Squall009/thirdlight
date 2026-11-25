/**
 * Closed rooms stay dark under the light volume, whatever way a building is turned: houses from the building
 * generator (one-cell walls, a gable roof, no opening) stamped into a world as a world stamps its structure grids
 * (the prop channel's stamp by the default rule), lit by the update's model (its rays by the light stop, the sky past
 * the reach, a hit's sun behind its walk) at noon and at a low sun. No cell of a room holds light, and the surfaces'
 * read on the inside faces of its walls, floor and roof takes no light from outside: before the read kept to its own
 * side of a thin solid, the eight cells round a point under a roof's step or by a turned wall held cells of the
 * outside too (bright lines at inner corners, a glow under the roof). A house with one window keeps its room's light
 * within a band of the same house unturned.
 */
import { describe, expect, it } from 'vitest';
import { CPU_SCALAR_OPS, mulberry32 } from '@thirdlight/shared';
import { anchoredDefinition, BUILDING_GENERATOR, chunkGrid, createDenseChunk, GridFrame, gridStampBounds, gridStampCells, LIGHT_STOP_COVERAGE, localIndex, PropLightChannel, recordValue, STAMP_CLASS, stampClassOfValue, stampGrid, STRUCTURE_STAMP_DEFAULT, VOXEL_ROLE, type DenseChunk, type StructureDefinition, type StructureOpening } from '@thirdlight/voxel';

import { volumeFaceDirection, volumePredicateSource, volumeRayRadiance, type VolumeLightWorld } from './voxel-light-volume-reference';
import { volumeCellHolds, volumeReadAt, volumeReadReach, VOLUME_READ_MIN_WEIGHT, VOLUME_READ_OFFSET_CELLS } from './voxel-light-volume-layout';

const M = 0.5;
const grid = chunkGrid(32);
const RAYS = 6;
const norm = (v: number[]): number[] => {
  const l = Math.hypot(v[0]!, v[1]!, v[2]!);
  return v.map((c) => c / l);
};
const SUNS = { noon: norm([-0.4, 1, 0.3]), low: norm([-0.9, 0.2, 0.4]) };

const house = (openings: StructureOpening[] = []): StructureDefinition =>
  anchoredDefinition({
    footprint: [{ id: 'main', points: [[0, 0], [21, 0], [21, 15], [0, 15]] }],
    storeys: 2,
    storeyHeight: 6,
    foundationDepth: 2,
    roof: { shape: 'gable', overhang: 1, axis: 'x' },
    materials: { wall: 9, floor: 5, roof: 7, foundation: 3, stair: 5 },
    openings,
    stairs: [],
    generator: 1,
  });

/** A building's cells (class a cell), its box and its rooms: open cells its own flood from outside does not reach. */
function cellsOf(def: StructureDefinition): { lo: [number, number, number]; size: [number, number, number]; cls: (x: number, y: number, z: number) => number; room: (x: number, y: number, z: number) => boolean } {
  const b = BUILDING_GENERATOR.box(def);
  const chunks = new Map<string, DenseChunk | null>();
  const cls = (x: number, y: number, z: number): number => {
    const key = `${x >> 5},${y >> 5},${z >> 5}`;
    if (!chunks.has(key)) {
      const d = createDenseChunk(grid);
      chunks.set(key, BUILDING_GENERATOR.chunk(def, grid, x >> 5, y >> 5, z >> 5, d) ? d : null);
    }
    const d = chunks.get(key)!;
    if (d === null) return STAMP_CLASS.open;
    const i = localIndex(grid, x & 31, y & 31, z & 31);
    if (d.material[i] === 0 && d.role[i] !== VOXEL_ROLE.opening) return STAMP_CLASS.open;
    return stampClassOfValue(recordValue(d.material[i]!, d.role[i]!, d.shape[i]!, d.wetness[i]!));
  };
  const lo: [number, number, number] = [b.minX - 1, 1, b.minZ - 1];
  const size: [number, number, number] = [b.maxX - b.minX + 3, b.maxY + 2, b.maxZ - b.minZ + 3];
  // Openings shut: what a room is, with or without a window in it.
  const shut = (x: number, y: number, z: number): boolean => cls(x, y, z) !== STAMP_CLASS.open;
  const outside = new Set<string>();
  const q: number[][] = [];
  for (let x = lo[0]; x < lo[0] + size[0]; x++) for (let y = lo[1]; y < lo[1] + size[1]; y++) for (let z = lo[2]; z < lo[2] + size[2]; z++) {
    const edge = x === lo[0] || z === lo[2] || x === lo[0] + size[0] - 1 || z === lo[2] + size[2] - 1 || y === lo[1] + size[1] - 1;
    if (edge && !shut(x, y, z)) {
      outside.add(`${x},${y},${z}`);
      q.push([x, y, z]);
    }
  }
  while (q.length > 0) {
    const c = q.pop()!;
    for (const [dx, dy, dz] of [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]]) {
      const n = [c[0]! + dx!, c[1]! + dy!, c[2]! + dz!];
      if (n[0]! < lo[0] || n[1]! < lo[1] || n[2]! < lo[2] || n[0]! >= lo[0] + size[0] || n[1]! >= lo[1] + size[1] || n[2]! >= lo[2] + size[2]) continue;
      const k = n.join(',');
      if (outside.has(k) || shut(n[0]!, n[1]!, n[2]!)) continue;
      outside.add(k);
      q.push(n);
    }
  }
  const room = (x: number, y: number, z: number): boolean => x >= lo[0] && y >= lo[1] && z >= lo[2] && x < lo[0] + size[0] && y < lo[1] + size[1] && z < lo[2] + size[2] && !shut(x, y, z) && !outside.has(`${x},${y},${z}`);
  return { lo: [b.minX, b.minY, b.minZ], size: [b.maxX - b.minX + 1, b.maxY - b.minY + 1, b.maxZ - b.minZ + 1], cls, room };
}

interface Lit {
  /** Room cells holding light, those lit, the brightest and the mean of the rooms' cells. */
  cells: number;
  lit: number;
  brightest: number;
  mean: number;
  /** Points on the rooms' inside faces read, and those whose read took light. */
  read: number;
  readLit: number;
}

/** A building turned `yawDeg` about its middle over flat ground, stamped by the default rule, lit by `sun` (null: the sky alone). */
/** A building turned `yawDeg` about its middle, off the cell lattice, stamped into flat ground by the default rule, lit by `sun` (null: the sky alone). */
function placed(def: StructureDefinition, yawDeg: number, sun: number[] | null): { h: ReturnType<typeof cellsOf>; frame: GridFrame; cells: ReturnType<typeof gridStampCells>; w: VolumeLightWorld } {
  const h = cellsOf(def);
  const yaw = (yawDeg * Math.PI) / 180;
  const mid = [(h.lo[0] + h.size[0] / 2) * M, 0, (h.lo[2] + h.size[2] / 2) * M];
  const at = new GridFrame({ gridId: 1, position: [0, 0, 0], yawRad: yaw }).toWorld(mid[0]!, 0, mid[2]!);
  // A place off the cell lattice, so the turned walls cross world cells every way.
  const frame = new GridFrame({ gridId: 1, position: [20.37 - at[0], 0, 20.11 - at[2]], yawRad: yaw });
  const cells = gridStampCells(h.lo, h.size, h.cls);
  const ch = new PropLightChannel({ grid, setPart: () => true }, M);
  for (let cx = -1; cx <= 3; cx++) for (let cy = -1; cy <= 1; cy++) for (let cz = -1; cz <= 3; cz++) ch.loaded(cx, cy, cz);
  ch.place('house', { stamp: true, bounds: () => gridStampBounds(cells, frame, M), sample: (m) => stampGrid(cells, frame, STRUCTURE_STAMP_DEFAULT, m) });
  // The world's light stop: ground below row 0, and the stamp where it covers half or more.
  const solid = (x: number, y: number, z: number): boolean => y < 0 || ch.at(x, y, z) >= LIGHT_STOP_COVERAGE;
  const src = volumePredicateSource(solid, [-2, -2, -2], [4, 2, 4]);
  const w: VolumeLightWorld = { src, sky: [1, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0], sun: sun === null ? [0, 1, 0, 0, 0, 0, 0] : [sun[0]!, sun[1]!, sun[2]!, 1, 3, 3, 3], lamps: [], lampCount: 0, albedo: () => [0.5, 0.5, 0.5] };
  return { h, frame, cells, w };
}

/** The cells' light as the update's model gives it, `rays` a face, where the update's rule says a cell holds light (null elsewhere); kept. */
function cellLight(w: VolumeLightWorld, rays: number): (x: number, y: number, z: number) => number[][] | null {
  const held = new Map<string, number[][] | null>();
  return (x, y, z) => {
    const key = `${x},${y},${z}`;
    if (held.has(key)) return held.get(key)!;
    let out: number[][] | null = null;
    if (volumeCellHolds(w.src, x, y, z)) {
      const rnd = mulberry32((x * 73856093) ^ (y * 19349663) ^ (z * 83492791));
      const p = [(x + 0.5) * M, (y + 0.5) * M, (z + 0.5) * M];
      out = [];
      for (let f = 0; f < 6; f++) {
        const sum = [0, 0, 0];
        for (let r = 0; r < rays; r++) {
          const c = volumeRayRadiance(w, p, volumeFaceDirection(f, rnd(), rnd()), 24, () => null, [rnd(), rnd()], 48);
          for (let k = 0; k < 3; k++) sum[k]! += c[k]!;
        }
        out.push(sum.map((v) => (Math.PI * v) / rays));
      }
    }
    held.set(key, out);
    return out;
  };
}

function light(def: StructureDefinition, yawDeg: number, sun: number[] | null, reads: boolean): Lit {
  const { h, frame, cells, w } = placed(def, yawDeg, sun);
  const faces = cellLight(w, RAYS);
  const b = gridStampBounds(cells, frame, M);
  const inRoom = (q: readonly number[]): boolean => h.room(Math.floor(q[0]! / M), Math.floor(q[1]! / M), Math.floor(q[2]! / M));
  const out: Lit = { cells: 0, lit: 0, brightest: 0, mean: 0, read: 0, readLit: 0 };
  for (let x = Math.floor(b.min[0]! / M); x < Math.ceil(b.max[0]! / M); x++) for (let y = 0; y < Math.ceil(b.max[1]! / M); y++) for (let z = Math.floor(b.min[2]! / M); z < Math.ceil(b.max[2]! / M); z++) {
    if (!inRoom(frame.toGrid((x + 0.5) * M, (y + 0.5) * M, (z + 0.5) * M))) continue;
    const fc = faces(x, y, z);
    if (fc === null) continue;
    const v = Math.max(...fc.map((f) => (f[0]! + f[1]! + f[2]!) / 3));
    out.cells++;
    out.mean += v;
    if (v > 1e-6) out.lit++;
    out.brightest = Math.max(out.brightest, v);
  }
  out.mean /= Math.max(out.cells, 1);
  if (!reads) return out;
  // The read on every inside face of the rooms (a room cell's face toward a solid cell of the building), four points a face.
  const o = frame.toWorld(0, 0, 0);
  for (let gx = h.lo[0]; gx < h.lo[0] + h.size[0]; gx++) for (let gy = 1; gy < h.lo[1] + h.size[1]; gy++) for (let gz = h.lo[2]; gz < h.lo[2] + h.size[2]; gz++) {
    if (!h.room(gx, gy, gz)) continue;
    const c = [gx, gy, gz];
    for (let a = 0; a < 3; a++) for (const s of [1, -1]) {
      const n = [0, 0, 0];
      n[a] = s;
      if (h.cls(gx + n[0]!, gy + n[1]!, gz + n[2]!) === STAMP_CLASS.open) continue;
      for (const [u, v] of [[0.25, 0.25], [0.75, 0.25], [0.25, 0.75], [0.75, 0.75]]) {
        const q = c.map((x) => x + 0.5);
        q[a] = c[a]! + (s > 0 ? 1 : 0);
        q[(a + 1) % 3] = c[(a + 1) % 3]! + u!;
        q[(a + 2) % 3] = c[(a + 2) % 3]! + v!;
        const p = frame.toWorld(q[0]! * M, q[1]! * M, q[2]! * M);
        const t = frame.toWorld(-n[0]!, -n[1]!, -n[2]!);
        const r = volumeReadAt(p, [t[0] - o[0], t[1] - o[1], t[2] - o[2]], M, faces, CPU_SCALAR_OPS);
        out.read++;
        if (r.weight > 0 && (r.light[0] + r.light[1] + r.light[2]) / 3 > 1e-6) out.readLit++;
      }
    }
  }
  return out;
}

describe('closed rooms under the light volume, turned any way', () => {
  for (const yaw of [0, 7, 15, 30, 38, 45]) {
    it(`a house with no opening turned ${yaw}°: no room cell holds light at noon or at a low sun, and no inside face reads light`, () => {
      const def = house();
      for (const [name, sun] of Object.entries(SUNS)) {
        const r = light(def, yaw, sun, name === 'noon');
        expect(r.cells, name).toBeGreaterThan(1000);
        expect(r.lit, `${name}: room cells lit (brightest ${r.brightest})`).toBe(0);
        if (name === 'noon') {
          expect(r.read).toBeGreaterThan(5000);
          expect(r.readLit, 'inside face points reading light from outside').toBe(0);
        }
      }
    });
  }

  it("a house with one window keeps its room's light within a band of the house unturned (the sky alone)", () => {
    // A window 2 × 1.5 m on the long wall's ground storey.
    const def = house([{ id: 'w', polygon: 'main', edge: 0, storey: 0, at: 8, width: 4, height: 3, sill: 1 }]);
    const base = light(def, 0, null, false);
    expect(base.lit).toBeGreaterThan(50);
    for (const yaw of [15, 30, 38, 45]) {
      const r = light(def, yaw, null, false);
      expect(r.mean / base.mean, `${yaw}°: mean ${r.mean} against ${base.mean}`).toBeGreaterThan(WINDOW_BAND[0]);
      expect(r.mean / base.mean, `${yaw}°: mean ${r.mean} against ${base.mean}`).toBeLessThan(WINDOW_BAND[1]);
    }
  });
  it('a turned wall reads its light as smoothly as a straight one: no step between neighbouring points, four cells or more read', () => {
    // A one-storey house with a window in its front wall; its back wall's inside face read every 5 cm along a row
    // 1.2 m over the floor, 1 m off each side wall, under the sky and the noon sun, the cells near their converged light.
    const def = anchoredDefinition({
      footprint: [{ id: 'main', points: [[0, 0], [21, 0], [21, 15], [0, 15]] }],
      storeys: 1,
      storeyHeight: 6,
      foundationDepth: 2,
      roof: { shape: 'gable', overhang: 1, axis: 'x' },
      materials: { wall: 9, floor: 5, roof: 7, foundation: 3, stair: 5 },
      openings: [{ id: 'w', polygon: 'main', edge: 0, storey: 0, at: 8, width: 4, height: 3, sill: 1 }],
      stairs: [],
      generator: 1,
    });
    const rows: { yaw: number; cv: number; step: number; least: number; mean: number }[] = [];
    for (const yaw of [0, 17, 30, 45]) {
      const { h, frame, w } = placed(def, yaw, SUNS.noon);
      const faces = cellLight(w, WALL_RAYS);
      const room = h.room;
      // The row's grid height, the back wall's inside face and the room's ends along x (the house's own cells).
      const midX = Math.floor(h.lo[0] + h.size[0] / 2);
      const midZ = Math.floor(h.lo[2] + h.size[2] / 2);
      let floor = 0;
      while (!room(midX, floor, midZ) && floor < 20) floor++;
      const gy = floor + 1.2 / M;
      let back = midZ;
      while (room(midX, Math.floor(gy), back + 1)) back++;
      let x0 = midX;
      let x1 = midX;
      while (room(x0 - 1, Math.floor(gy), back)) x0--;
      while (room(x1 + 1, Math.floor(gy), back)) x1++;
      const o = frame.toWorld(0, 0, 0);
      const t = frame.toWorld(0, 0, -1);
      const n = [t[0] - o[0], t[1] - o[1], t[2] - o[2]];
      const reads: number[] = [];
      let least = 8;
      for (let gx = x0 + 2; gx <= x1 - 1; gx += 0.1) {
        const p = frame.toWorld(gx * M, gy * M, (back + 1) * M);
        const r = volumeReadAt(p, n, M, faces, CPU_SCALAR_OPS);
        reads.push((r.light[0] + r.light[1] + r.light[2]) / 3);
        // The cells the read counts (the reach over those holding light with a weight).
        const g = [0, 1, 2].map((a) => (p[a]! + n[a]! * VOLUME_READ_OFFSET_CELLS * M) / M - 0.5);
        const i0 = g.map(Math.floor);
        const f = g.map((v, a) => v - i0[a]!);
        let held = 0;
        for (let k = 0; k < 8; k++) {
          const wk = [0, 1, 2].reduce((acc, a) => acc * (((k >> a) & 1) === 1 ? f[a]! : 1 - f[a]!), 1);
          if (wk > VOLUME_READ_MIN_WEIGHT && faces(i0[0]! + (k & 1), i0[1]! + ((k >> 1) & 1), i0[2]! + ((k >> 2) & 1)) !== null) held |= 1 << k;
        }
        const m = volumeReadReach(held, f, n);
        let c = 0;
        for (let k = 0; k < 8; k++) c += (m >> k) & 1;
        least = Math.min(least, c);
      }
      const mean = reads.reduce((a, v) => a + v, 0) / reads.length;
      const cv = Math.sqrt(reads.reduce((a, v) => a + (v - mean) ** 2, 0) / reads.length) / mean;
      let step = 0;
      for (let i = 1; i < reads.length; i++) step = Math.max(step, Math.abs(reads[i]! - reads[i - 1]!) / mean);
      expect(reads.length).toBeGreaterThan(100);
      rows.push({ yaw, cv, step, least, mean });
    }
    const straight = rows[0]!;
    for (const r of rows) {
      const what = `${r.yaw}°: ${JSON.stringify(r)}`;
      expect(r.step, `${what}: the largest step between points 5 cm apart, over the mean`).toBeLessThan(WALL_STEP_MAX);
      expect(r.least, `${what}: the fewest cells a point reads`).toBeGreaterThanOrEqual(4);
      expect(r.cv / straight.cv, `${what}: the wall's spread against the unturned wall's`).toBeLessThan(WALL_CV_RATIO_MAX);
      expect(r.mean / straight.mean, `${what}: its mean against the unturned wall's`).toBeGreaterThan(0.6);
    }
  });
});

/**
 * How far a turned window's room may read from the unturned one's: the stamp moves an opening's edges by up to a cell,
 * which lets 4–42 % more of the sky in at 15°–45° (measured with these rays), never less.
 */
const WINDOW_BAND = [0.75, 1.5] as const;

/**
 * The cells' rays a face for the wall test: enough for their light to be near converged (a cell's spread from its own
 * rays well under the steps a read across a staircase made), so a step is the read's.
 */
const WALL_RAYS = 1024;
/**
 * The largest step between wall points 5 cm apart, over the wall's mean. Measured with the cells holding light by a
 * face only (a turned wall's room-side cells in its notches held none, and a point read one column of cells or
 * another): 0.61 at 17°, 0.68 at 30°, 0.92 at 45° against 0.09 unturned; by a face or an edge: 0.05–0.09 at every yaw.
 */
const WALL_STEP_MAX = 0.2;
/** A turned wall's spread over its mean against the unturned wall's (the light's own fall across the wall; 0.69–1.06 measured both ways). */
const WALL_CV_RATIO_MAX = 1.25;
