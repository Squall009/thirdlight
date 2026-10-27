/**
 * Adaptive probe placement (probe-bricks.ts, probe-geometry.ts) from real
 * scene data — a `BlockGrid` and its surface cache charts, a
 * `TerrainField`, a model's distance-field bricks — and its lookups against
 * brute force:
 *
 * - dense near geometry, sparse in open space: level 0 where surfaces meet,
 *   level 1 over flat ground, the coarsest level above, nothing in the sky;
 *   far fewer probes than a uniform grid over the same scene;
 * - validity: a probe inside geometry is moved to free space within about
 *   half its spacing (up or across), or dropped where it stands between two
 *   spaces (a wall) or nothing is free, as the geometry itself says;
 * - the brick map, the live probes' lookup and the shaders' texture
 *   layout each give what a search over every brick gives;
 * - terrain probes follow the eye within the surface cache's rings.
 */
import { describe, expect, it } from 'vitest';
import { BlockGrid, TerrainField, buildDistanceBrickSet, placeProbeGrids, probeCount, type BlockType, type TerrainComponent, type TerrainTile } from '@thirdlight/runtime';

import { NO_BRICK, PROBE_BRICK_SIDE, PROBE_PLACED_DROPPED, PROBE_PLACED_MOVED, PROBE_PLACED_VALID, ProbeMarks, brickMapAt, brickSide, latticeKey, levelSpacing, placeProbeBricks, type PlacedBricks, type ProbeSolid } from './probe-bricks';
import { blockTileMarks, insideDistanceBricks, probeSolid, terrainMarks, terrainProbeWindow } from './probe-geometry';
import { EMPTY_PROBE_INDEX, PROBE_INDEX_WIDTH, probeRowAt, withBrickMap } from './probe-index';
import { blockChunkCharts } from './surface-cache-blocks';
import { LiveProbes, PROBE_FLOATS, PROBE_UPDATES_AT, liveProbeWeight, probesIrradianceAt, shIrradiance } from './surface-probes';
import { opaqueByBlockTypes } from './tracer-sources';
import { SurfaceCacheHost } from './surface-cache-host';

type V3 = [number, number, number];
const SPACING = 2;
const OPAQUE = opaqueByBlockTypes([{ blockId: 'rock', shape: 'full' } as BlockType]);

/** A 96 m block ground 6 cells deep (its top at y 0) with a walled 8 m yard at one corner of the middle (and a solid 8 m cube), as the surface cache charts it. */
function town(cube = false): { grid: BlockGrid; marks: () => ProbeMarks; solid: ProbeSolid } {
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

  it('validity: a probe inside blocks is dropped (moved out of a wall it would carry one side\'s light to the other), as the grid says', () => {
    const { grid, marks, solid } = town(true);
    const placed = placeProbeBricks(marks(), solid);
    const opaqueAt = (p: readonly number[]): boolean => {
      const c = p.map((v) => Math.floor(v));
      if (c[0]! < -48 || c[0]! >= 48 || c[1]! < -6 || c[1]! >= 6 || c[2]! < -48 || c[2]! >= 48) return false;
      return grid.get(c[0]!, c[1]!, c[2]!)?.block === 'rock';
    };
    let dropped = 0;
    for (let i = 0; i < placed.keys.length; i += 1) {
      const pt = [...placed.points.subarray(i * 3, i * 3 + 3)];
      expect(solid.solid(pt)).toBe(opaqueAt(pt));
      expect(solid.ground?.(pt) ?? null).toBe(null);
      expect(placed.states[i] === PROBE_PLACED_DROPPED).toBe(opaqueAt(pt));
      if (placed.states[i] === PROBE_PLACED_DROPPED) dropped += 1;
    }
    expect(placed.states.includes(PROBE_PLACED_MOVED)).toBe(false);
    expect(dropped).toBeGreaterThan(0);
    // The yard's 1 m walls and the solid cube's face: dropped.
    expect(placed.states[placed.keys.indexOf(latticeKey(0, 1, 2))]).toBe(PROBE_PLACED_DROPPED);
    expect(placed.states[placed.keys.indexOf(latticeKey(9, 1, 10))]).toBe(PROBE_PLACED_DROPPED);
  });

  it('validity in a model: its distance-field bricks say inside as the mesh does, and a probe inside is dropped', () => {
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
    // The probe at the crate's middle (40, 2, 0) is inside it: dropped; the one above it (40, 4, 0) is lit.
    expect(placed.states[placed.keys.indexOf(latticeKey(20, 1, 0))]).toBe(PROBE_PLACED_DROPPED);
    expect(placed.states[placed.keys.indexOf(latticeKey(20, 2, 0))]).toBe(PROBE_PLACED_VALID);
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
    // Lit probes stand above the ground: those just under it were moved up onto it (a tenth of their spacing over it), the others dropped.
    let moved = 0;
    for (let i = 0; i < placed.keys.length; i += 1) {
      const pt = placed.points.subarray(i * 3, i * 3 + 3);
      const o = placed.origins.subarray(i * 3, i * 3 + 3);
      const g = field.heightAt(pt[0]!, pt[2]!)!;
      const s = levelSpacing(SPACING, placed.levels[i]!);
      if (placed.states[i] === PROBE_PLACED_MOVED) {
        moved += 1;
        expect(o[1]!).toBeCloseTo(g + 0.1 * s, 3);
        expect(g + 0.1 * s - pt[1]!).toBeLessThanOrEqual(0.55 * s + 1e-6);
      } else if (placed.states[i] === PROBE_PLACED_DROPPED) expect(g + 0.1 * s - pt[1]!).toBeGreaterThan(0.55 * s - 1e-6);
      else expect(pt[1]!).toBeGreaterThanOrEqual(g);
    }
    expect(moved).toBeGreaterThan(0);
    // 100 m on, the fine bricks went with the eye.
    const on = placeAt([100, 4, 0]);
    expect(levelAt(on, [105, ground(105, 5) + 1, 5])).toBe(1);
    expect(levelAt(on, [5, ground(5, 5) + 1, 5])).toBe(2);
  });

  it('a placement in steps keeps the probes as they were until its last step, then is the one made at once; the probes go on updating meanwhile', () => {
    const { marks, solid } = town(true);
    const at = new LiveProbes(SPACING, 0.5);
    at.place({ key: 'town', geometry: () => ({ marks: marks(), solid }) }, null);
    const live = new LiveProbes(SPACING, 0.5);
    live.place({ key: 'yard', geometry: () => ({ marks: town().marks(), solid: town().solid }) }, null);
    const before = { layout: live.layout, grids: live.grids.map((g) => g.key) };
    // A kept probe's light changes while the placement is being made: the placement carries the newer light.
    const kept = live.grids.findIndex((g) => at.grids.some((h) => h.key === g.key));
    const probe = live.lattice[live.grids[kept]!.at]!;
    const steps = live.placeSteps({ key: 'town', geometry: () => ({ marks: marks(), solid }) }, null);
    let n = 0;
    let r = steps.next();
    for (; r.done !== true; r = steps.next()) {
      n += 1;
      expect(live.layout).toBe(before.layout);
      if (n === 2) {
        const values = new Float32Array(PROBE_FLOATS).fill(0.5);
        values[PROBE_UPDATES_AT] = 1;
        live.accept(Uint32Array.of(probe), values, true, 0);
      }
    }
    expect(r.value).toBe(true);
    expect(n).toBeGreaterThan(2);
    expect(live.layout).toBe(before.layout + 1);
    expect(live.grids.map((g) => g.key)).toEqual(at.grids.map((g) => g.key));
    expect([...live.lattice]).toEqual([...at.lattice]);
    const moved = live.lattice[live.grids.find((g) => g.key === before.grids[kept])!.at]!;
    expect(live.state[moved * PROBE_FLOATS]).toBe(0.5);
  });

  it('on the page: a changed surface is placed once it is made again (never without it), and the probes are not settled while a placement waits', async () => {
    const hostOver = (grid: BlockGrid, gens: Map<string, number>): SurfaceCacheHost =>
      new SurfaceCacheHost({ layers: () => [{ id: 'town', origin: [0, 0, 0], grid, version: 1, chunks: [...gens], opaque: OPAQUE }], terrains: () => [], architecture: () => [], models: () => [], bricks: () => null }, 64 * 1024 * 1024);
    const gens = new Map<string, number>();
    for (let cz = -3; cz < 3; cz += 1) for (let cx = -3; cx < 3; cx += 1) gens.set(`${cx},${cz}`, 1);
    const { grid } = town();
    const host = hostOver(grid, gens);
    // Frame times from now on (the host makes tiles within a time share from the frame's start).
    let now = performance.now();
    const eye = [4, 2, 4];
    const frames = async (n: number, each: (settled: boolean) => void = () => {}): Promise<void> => {
      for (let f = 0; f < n; f += 1) {
        host.update(eye, (now += 16));
        await Promise.resolve();
        each(host.diagnostics().probes.settled);
      }
    };
    await frames(200);
    const before = host.probes.layout;
    expect(host.probes.grids.length).toBeGreaterThan(0);
    // A wall of the yard dug through: its chunk is made again a frame later; the probes are placed once, over it.
    for (let y = 0; y < 4; y += 1) grid.set(3, y, 0, null);
    gens.set('0,0', 2);
    let waited = 0;
    await frames(200, (settled) => {
      if (host.probes.layout === before && !settled) waited += 1;
    });
    expect(host.probes.layout).toBe(before + 1);
    expect(waited).toBeGreaterThan(0);
    // The same bricks as a page that loaded the dug scene.
    const fresh = hostOver(grid, gens);
    for (let f = 0; f < 200; f += 1) {
      fresh.update(eye, (now += 16));
      await Promise.resolve();
    }
    const keys = (h: SurfaceCacheHost): string[] => h.probes.grids.map((g) => g.key).sort();
    expect(keys(host)).toEqual(keys(fresh));
  });
});
