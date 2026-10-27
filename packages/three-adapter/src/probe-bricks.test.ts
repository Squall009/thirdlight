/**
 * Adaptive probe placement (probe-bricks.ts, probe-geometry.ts) from real
 * scene data — a `BlockGrid` and its surface cache charts, a
 * `TerrainField`, a model's distance-field bricks — and its lookups against
 * brute force:
 *
 * - dense near geometry, sparse in open space: level 0 where surfaces meet,
 *   level 1 over flat ground, the coarsest level above, nothing in the sky;
 *   far fewer probes than a uniform grid over the same scene;
 * - validity: a probe inside geometry is moved to free space within half
 *   its spacing (up or across) or dropped, as the geometry itself says;
 * - the brick map, the live probes' lookup and the shaders' texture
 *   layout each give what a search over every brick gives;
 * - terrain probes follow the eye within the surface cache's rings.
 */
import { describe, expect, it } from 'vitest';
import { BlockGrid, TerrainField, buildDistanceBrickSet, placeProbeGrids, probeCount, type BlockType, type TerrainComponent, type TerrainTile } from '@thirdlight/runtime';

import { NO_BRICK, PROBE_BRICK_SIDE, PROBE_PLACED_DROPPED, PROBE_PLACED_MOVED, ProbeMarks, brickMapAt, brickSide, latticeKey, levelSpacing, placeProbeBricks, type PlacedBricks } from './probe-bricks';
import { blockTileMarks, insideDistanceBricks, probeSolid, terrainMarks, terrainProbeWindow } from './probe-geometry';
import { EMPTY_PROBE_INDEX, PROBE_INDEX_WIDTH, probeRowAt, withBrickMap } from './probe-index';
import { blockChunkCharts } from './surface-cache-blocks';
import { LiveProbes, PROBE_FLOATS, PROBE_UPDATES_AT, liveProbeWeight, probesIrradianceAt, shIrradiance } from './surface-probes';
import { opaqueByBlockTypes } from './tracer-sources';

type V3 = [number, number, number];
const SPACING = 2;
const OPAQUE = opaqueByBlockTypes([{ blockId: 'rock', shape: 'full' } as BlockType]);

/** A 96 m block ground 6 cells deep (its top at y 0) with a walled 8 m yard at one corner of the middle (and a solid 8 m cube), as the surface cache charts it. */
function town(cube = false): { grid: BlockGrid; marks: () => ProbeMarks; solid: (p: readonly number[]) => boolean } {
  const grid = new BlockGrid({ cellSize: [1, 1, 1], bounds: { min: [-48, -6, -48], max: [48, 6, 48] } });
  for (let z = -48; z < 48; z += 1) for (let x = -48; x < 48; x += 1) for (let y = -6; y < 0; y += 1) grid.set(x, y, z, { block: 'rock' });
  for (let y = 0; y < 4; y += 1) for (let k = 0; k < 8; k += 1) for (const [x, z] of [[k, 0], [k, 7], [0, k], [7, k]] as const) grid.set(x, y, z, { block: 'rock' });
  if (cube) for (let z = 18; z < 26; z += 1) for (let x = 18; x < 26; x += 1) for (let y = 0; y < 6; y += 1) grid.set(x, y, z, { block: 'rock' });
  const marks = (): ProbeMarks => {
    const m = new ProbeMarks(SPACING);
    for (let cz = -3; cz < 3; cz += 1) for (let cx = -3; cx < 3; cx += 1) blockTileMarks({ grid, origin: [0, 0, 0], made: blockChunkCharts(grid, OPAQUE, cx, cz) }, m);
    return m.finish();
  };
  return { grid, marks, solid: probeSolid({ layers: [{ grid, origin: [0, 0, 0], opaque: OPAQUE }] }, brickSide(SPACING, 0)) };
}

/** The finest placed brick holding `p` (half-open boxes), by a search over all of them. */
function bruteBrick(placed: PlacedBricks, p: readonly number[]): number {
  let best = NO_BRICK;
  placed.bricks.forEach((b, i) => {
    const inside = [0, 1, 2].every((a) => p[a]! >= b.min[a]! && p[a]! < b.min[a]! + b.side);
    if (inside && (best === NO_BRICK || b.side < placed.bricks[best]!.side)) best = i;
  });
  return best;
}

function levelAt(placed: PlacedBricks, p: readonly number[]): number {
  const b = bruteBrick(placed, p);
  return b === NO_BRICK ? -1 : placed.bricks[b]!.level;
}

let seed = 9;
const rnd = (): number => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296);

describe('probes: adaptive placement', () => {
  it('dense where surfaces meet, coarser over flat ground and above it, none in the sky; far fewer than a uniform grid', () => {
    const { marks, solid } = town();
    const placed = placeProbeBricks(marks(), solid);
    // At the yard's walls (a floor meets walls): the finest level.
    expect(levelAt(placed, [3, 1, 3])).toBe(0);
    expect(levelAt(placed, [-1, 2, 4])).toBe(0);
    // Open flat ground: level 1; high above it the coarsest level; nothing far up in the sky.
    expect(levelAt(placed, [-40, 1, -40])).toBe(1);
    expect(levelAt(placed, [30, 1, -30])).toBe(1);
    expect(levelAt(placed, [-40, 30, -40])).toBe(2);
    expect(levelAt(placed, [-40, 120, -40])).toBe(-1);
    // Level 0 only round the yard (within a brick and a margin of its walls) and along the ground's outer edge.
    const edge = 48 - brickSide(SPACING, 0) - SPACING;
    for (const b of placed.bricks) {
      if (b.level !== 0 || [0, 2].some((a) => b.min[a]! < -edge || b.min[a]! + b.side > edge)) continue;
      const out = [0, 1, 2].map((a) => Math.max(0, (a === 1 ? -6 : 0) - (b.min[a]! + b.side), b.min[a]! - (a === 1 ? 4 : 8)));
      expect(Math.max(...out)).toBeLessThanOrEqual(brickSide(SPACING, 0) + SPACING);
    }
    const lit = [...placed.states].filter((s) => s !== PROBE_PLACED_DROPPED).length;
    const uniform = placeProbeGrids({ min: [-48, -6, -48], max: [48, 4, 48] }, SPACING).reduce((n, g) => n + probeCount(g), 0);
    expect(lit).toBeLessThan(uniform / 4);
    // Every brick keeps a lit probe; bricks share their faces' probes.
    for (let b = 0; b < placed.bricks.length; b += 1) expect([...placed.ids.subarray(b * 64, b * 64 + 64)].some((i) => placed.states[i] !== PROBE_PLACED_DROPPED)).toBe(true);
    expect(placed.keys.length).toBeLessThan(placed.bricks.length * PROBE_BRICK_SIDE ** 3 * 0.6);
  });

  it('validity: a probe inside blocks is moved to free space within half its spacing, or dropped, as the grid says', () => {
    const { grid, marks, solid } = town(true);
    const placed = placeProbeBricks(marks(), solid);
    const opaqueAt = (p: readonly number[]): boolean => {
      const c = p.map((v) => Math.floor(v));
      if (c[0]! < -48 || c[0]! >= 48 || c[1]! < -6 || c[1]! >= 6 || c[2]! < -48 || c[2]! >= 48) return false;
      return grid.get(c[0]!, c[1]!, c[2]!)?.block === 'rock';
    };
    let moved = 0;
    let dropped = 0;
    for (let i = 0; i < placed.keys.length; i += 1) {
      const pt = [...placed.points.subarray(i * 3, i * 3 + 3)];
      const o = [...placed.origins.subarray(i * 3, i * 3 + 3)];
      const s = levelSpacing(SPACING, placed.levels[i]!);
      expect(solid(pt)).toBe(opaqueAt(pt));
      if (placed.states[i] === PROBE_PLACED_MOVED) {
        moved += 1;
        expect(opaqueAt(pt)).toBe(true);
        expect(opaqueAt(o)).toBe(false);
        expect(Math.hypot(o[0]! - pt[0]!, o[1]! - pt[1]!, o[2]! - pt[2]!)).toBeLessThanOrEqual(s / 2 + 1e-6);
      } else if (placed.states[i] === PROBE_PLACED_DROPPED) {
        dropped += 1;
        expect(opaqueAt(pt)).toBe(true);
        // Up and across (never down: under the ground is no place for a probe lighting what stands on it).
        for (let a = 0; a < 3; a += 1) for (const d of a === 1 ? [0.25, 0.5] : [-0.5, -0.25, 0.25, 0.5]) {
          const q = [...pt];
          q[a]! += d * s;
          expect(opaqueAt(q)).toBe(true);
        }
      } else expect(opaqueAt(pt)).toBe(false);
    }
    expect(moved).toBeGreaterThan(0);
    expect(dropped).toBeGreaterThan(0);
  });

  it('validity in a model: its distance-field bricks say inside as the mesh does, and a probe inside is moved out or dropped', () => {
    // A 2.6 m crate standing on nothing, its corner at the origin's probe lattice.
    const positions: V3[] = [];
    const triangles: V3[] = [];
    const quad = (a: V3, b: V3, c: V3, e: V3): void => {
      const i = positions.length;
      positions.push(a, b, c, e);
      triangles.push([i, i + 1, i + 2], [i, i + 2, i + 3]);
    };
    const [x0, y0, z0, x1, y1, z1] = [-1.3, 0.5, -1.3, 1.3, 2.8, 1.3];
    quad([x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1]);
    quad([x0, y1, z0], [x0, y1, z1], [x1, y1, z1], [x1, y1, z0]);
    quad([x0, y0, z0], [x0, y1, z0], [x1, y1, z0], [x1, y0, z0]);
    quad([x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]);
    quad([x0, y0, z0], [x0, y0, z1], [x0, y1, z1], [x0, y1, z0]);
    quad([x1, y0, z0], [x1, y1, z0], [x1, y1, z1], [x1, y0, z1]);
    const set = buildDistanceBrickSet('', [{ positions, triangles, uv1: null }])!;
    const inBox = (p: readonly number[], m: number): boolean => p[0]! > x0 + m && p[0]! < x1 - m && p[1]! > y0 + m && p[1]! < y1 - m && p[2]! > z0 + m && p[2]! < z1 - m;
    const far = 2 * set.voxel;
    for (let k = 0; k < 2000; k += 1) {
      const p = [x0 - 1 + rnd() * (x1 - x0 + 2), y0 - 1 + rnd() * (y1 - y0 + 2), z0 - 1 + rnd() * (z1 - z0 + 2)];
      if (inBox(p, far)) expect(insideDistanceBricks(set, p)).toBe(true);
      else if (!inBox(p, -far)) expect(insideDistanceBricks(set, p)).toBe(false);
    }
    // Placed 40 m off at a quarter turn: world → local maps back.
    const c = Math.SQRT1_2;
    const worldToLocal = [c, 0, -c, -40 * c, 0, 1, 0, 0, c, 0, c, -40 * c];
    const solid = probeSolid({ models: [{ worldToLocal, set, min: [36, 0, -4], max: [44, 4, 4] }] }, brickSide(SPACING, 0));
    const marks = new ProbeMarks(SPACING);
    marks.mark([38, 0.5, -2], [42, 2.8, 2], 0);
    const placed = placeProbeBricks(marks.finish(), solid);
    // The probe at the crate's middle (40, 2, 0) is 0.8 m under its top: moved 1 m up (half the spacing).
    const mid = placed.keys.indexOf(latticeKey(20, 1, 0));
    expect(placed.states[mid]).toBe(PROBE_PLACED_MOVED);
    const o = [...placed.origins.subarray(mid * 3, mid * 3 + 3)];
    const local = [0, 1, 2].map((r) => worldToLocal[r * 4]! * o[0]! + worldToLocal[r * 4 + 1]! * o[1]! + worldToLocal[r * 4 + 2]! * o[2]! + worldToLocal[r * 4 + 3]!);
    expect(inBox(local, -far)).toBe(false);
  });

  it('the brick map finds the finest brick a search over every brick finds, also as the shaders read it from the index texture', () => {
    const { marks, solid } = town();
    const placed = placeProbeBricks(marks(), solid);
    const live = new LiveProbes(SPACING, 0.5);
    live.place({ key: 'town', geometry: () => ({ marks: marks(), solid }) }, null);
    const map = live.map;
    // The map's ids are the live grids' (after the rooms' grids, none here): brick i is grid i.
    const index = withBrickMap(EMPTY_PROBE_INDEX, map);
    const boxes = new Float32Array(live.grids.length * 6);
    live.grids.forEach((g, i) => boxes.set([...g.min, ...g.max], i * 6));
    const texel = (e: number): number[] => [...index.data.subarray(e * 4, e * 4 + 4)];
    // The shader's arithmetic over the texture (probe-lighting.ts), the point held inside the map.
    const shader = (p: readonly number[]): number => {
      const top = map.top;
      const hi = map.origin.map((o, a) => o + map.dims[a]! * top - 1e-3);
      const q = p.map((v, a) => Math.min(hi[a]!, Math.max(map.origin[a]!, v)));
      const cf = q.map((v, a) => Math.min(map.dims[a]! - 1, Math.floor((v - map.origin[a]!) / top)));
      const head = texel(index.brickCellsAt + cf[0]! + map.dims[0] * (cf[1]! + map.dims[1] * cf[2]!));
      const side = head[1]!;
      if (side <= 0) return -1;
      const sub = q.map((v, a) => Math.min(side - 1, Math.max(0, Math.floor(((v - map.origin[a]! - cf[a]! * top) * side) / top))));
      return texel(head[0]! + sub[0]! + side * (sub[1]! + side * sub[2]!))[0]!;
    };
    expect(index.data.length % (PROBE_INDEX_WIDTH * 4)).toBe(0);
    for (let k = 0; k < 4000; k += 1) {
      const p = [-60 + rnd() * 120, -20 + rnd() * 80, -60 + rnd() * 120];
      const want = bruteBrick(placed, p);
      expect(brickMapAt(map, p)).toBe(want);
      // The shader holds a point outside the map at its edge (its light fades from there).
      const top = map.top;
      expect(shader(p)).toBe(bruteBrick(placed, p.map((v, a) => Math.min(map.origin[a]! + map.dims[a]! * top - 1e-3, Math.max(map.origin[a]!, v)))));
      if (want !== NO_BRICK) expect(probeRowAt(index, boxes, { x: p[0]!, y: p[1]!, z: p[2]! })).toBe(want);
    }
  });

  it("the live probes' irradiance at a point is the trilinear blend of the finest brick's probes there, by their weights", () => {
    const { marks, solid } = town();
    const live = new LiveProbes(SPACING, 0.5);
    live.place({ key: 'town', geometry: () => ({ marks: marks(), solid }) }, null);
    const placed = placeProbeBricks(marks(), solid);
    // Random light on every lit probe, some never updated (no weight).
    for (let i = 0; i < live.count; i += 1) {
      const at = i * PROBE_FLOATS;
      for (let c = 0; c < 12; c += 1) live.state[at + c] = c < 3 ? 1 + rnd() * 4 : rnd() - 0.5;
      live.state[at + PROBE_UPDATES_AT] = rnd() < 0.9 ? 1 : 0;
    }
    const n = [0.3, 0.9, -0.3];
    for (let k = 0; k < 1000; k += 1) {
      const q = [-50 + rnd() * 100, -2 + rnd() * 30, -50 + rnd() * 100];
      const b = bruteBrick(placed, q);
      const got = probesIrradianceAt(live, q, n);
      if (b === NO_BRICK) {
        expect(got).toEqual([0, 0, 0]);
        continue;
      }
      const g = live.grids[b]!;
      const sh = new Array<number>(12).fill(0);
      let wsum = 0;
      const f = [0, 1, 2].map((a) => ((q[a]! - g.min[a]!) / (g.max[a]! - g.min[a]!)) * (PROBE_BRICK_SIDE - 1));
      for (let iz = 0; iz < PROBE_BRICK_SIDE; iz += 1) for (let iy = 0; iy < PROBE_BRICK_SIDE; iy += 1) for (let ix = 0; ix < PROBE_BRICK_SIDE; ix += 1) {
        const tri = [ix, iy, iz].reduce((w, v, a) => w * Math.max(0, 1 - Math.abs(f[a]! - v)), 1);
        const i = live.lattice[g.at + ix + PROBE_BRICK_SIDE * (iy + PROBE_BRICK_SIDE * iz)]!;
        const w = tri * liveProbeWeight(live.state, i * PROBE_FLOATS);
        for (let c = 0; c < 12; c += 1) sh[c]! += live.state[i * PROBE_FLOATS + c]! * w;
        wsum += w;
      }
      const want = wsum > 0 ? shIrradiance(sh.map((v) => v / wsum), 0, n).map((v) => Math.max(0, v)) : [0, 0, 0];
      for (let c = 0; c < 3; c += 1) expect(got[c]).toBeCloseTo(want[c]!, 4);
    }
  });

  it('terrain: bricks over the ground near the eye within the surface cache rings, none beyond, none under it; they follow the eye', () => {
    const n = 65;
    const comp = { tileSamples: n, spacing: 2, heightRange: [-32, 32], tiles: [0, 1, 2].flatMap((z) => [0, 1, 2].map((x) => ({ x, z }))) } as unknown as TerrainComponent;
    const tiles = new Map<string, TerrainTile>();
    const h = (x: number, z: number): number => 6 * Math.sin(x / 23) * Math.cos(z / 31);
    for (let tz = 0; tz < 3; tz += 1) for (let tx = 0; tx < 3; tx += 1) {
      const heights = new Uint16Array(n * n);
      for (let z = 0; z < n; z += 1) for (let x = 0; x < n; x += 1) heights[z * n + x] = Math.round(((h(-192 + (tx * (n - 1) + x) * 2, -192 + (tz * (n - 1) + z) * 2) + 32) / 64) * 65535);
      tiles.set(`${tx},${tz}`, { samples: n, heights, weights: null, holes: null, paint: null });
    }
    const field = new TerrainField(comp, [-192, 0, -192], tiles);
    const placeAt = (eye: V3): PlacedBricks => {
      const marks = new ProbeMarks(SPACING);
      terrainMarks(field, [eye[0], eye[2]], brickSide(SPACING, 1), marks);
      return placeProbeBricks(marks.finish(), probeSolid({ terrains: [field] }, brickSide(SPACING, 0)));
    };
    const placed = placeAt([0, 4, 0]);
    const ground = (x: number, z: number): number => field.heightAt(x, z)!;
    expect(levelAt(placed, [5, ground(5, 5) + 1, 5])).toBe(1);
    expect(levelAt(placed, [-70, ground(-70, 60) + 1, 60])).toBe(2);
    const [, , far] = terrainProbeWindow(1, [0, 0], brickSide(SPACING, 1));
    expect(levelAt(placed, [far + brickSide(SPACING, 2) + 1, ground(150, 0), 0])).toBe(-1);
    // Lit probes stand above the ground (or were moved there); none is lit under it.
    for (let i = 0; i < placed.keys.length; i += 1) {
      if (placed.states[i] === PROBE_PLACED_DROPPED) continue;
      const o = placed.origins.subarray(i * 3, i * 3 + 3);
      const g = field.heightAt(o[0]!, o[2]!);
      if (g !== null) expect(o[1]!).toBeGreaterThanOrEqual(g - 1e-3);
    }
    // 100 m on, the fine bricks went with the eye.
    const on = placeAt([100, 4, 0]);
    expect(levelAt(on, [105, ground(105, 5) + 1, 5])).toBe(1);
    expect(levelAt(on, [5, ground(5, 5) + 1, 5])).toBe(2);
  });
});
