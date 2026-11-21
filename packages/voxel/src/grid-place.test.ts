/**
 * A structure grid's frame against the rotation its quaternion stands for
 * (three.js turns the draws' group by it, the physics port the body), the
 * text a page passes placements in, the chunks a grid holds read from its
 * real region files, and the streamer reading only round them.
 */
import { describe, expect, it } from 'vitest';
import { chunkGrid } from './coords';
import { createWorldStore } from './palette-store';
import { GridFrame, gridChunkExtent, gridPlacementProblem, gridPlacementsText, grownChunkBox, parseGridPlacements } from './grid-place';
import { packRegionChunk, regionFileName, writeRegion, type RegionEntry } from './region-file';
import { RegionChunkSource } from './region-source';
import { readOrder } from './stream-reads';
import { DEFAULT_STREAM_RING } from './stream-ring';
import { VOXEL_ROLE } from './record';

const grid = chunkGrid(32);
const WORLD = new Uint8Array(16).fill(7);

describe('a structure grid frame', () => {
  it('turns and moves points as its quaternion (the yaw about +y) and its position do', () => {
    for (const yawDeg of [0, 30, 45, -90, 137]) {
      const place = { gridId: 3, position: [8013.25, 12.5, -7980.75] as [number, number, number], yawRad: (yawDeg * Math.PI) / 180 };
      const f = new GridFrame(place);
      // The quaternion's own rotation matrix (q = (0, sin θ/2, 0, cos θ/2)), applied as three applies it.
      const q4 = f.quaternion();
      expect(Math.hypot(q4.x, q4.y, q4.z, q4.w)).toBeCloseTo(1, 12);
      const m = [1 - 2 * q4.y * q4.y, 2 * q4.x * q4.y - 2 * q4.z * q4.w, 2 * q4.x * q4.z + 2 * q4.y * q4.w, 2 * q4.x * q4.z - 2 * q4.y * q4.w, 2 * q4.y * q4.z + 2 * q4.x * q4.w, 1 - 2 * q4.y * q4.y];
      for (const q of [[0, 0, 0], [3.5, 1, -2], [-10, 4.25, 19.5]] as const) {
        const w = f.toWorld(q[0], q[1], q[2]);
        const byQuat = [m[0]! * q[0] + m[1]! * q[1] + m[2]! * q[2] + place.position[0], q[1] + place.position[1], m[3]! * q[0] + m[4]! * q[1] + m[5]! * q[2] + place.position[2]];
        for (let a = 0; a < 3; a++) expect(w[a]).toBeCloseTo(byQuat[a]!, 6);
        // And back: a world point lands where it came from in the grid.
        const back = f.toGrid(...w);
        for (let a = 0; a < 3; a++) expect(back[a]).toBeCloseTo(q[a]!, 9);
      }
      // A direction turns and does not move.
      const d = f.directionToGrid(...f.toWorld(1, 0, 0).map((v, a) => v - place.position[a]!) as [number, number, number]);
      expect(d.map((v) => Math.round(v * 1e9) / 1e9 + 0)).toEqual([1, 0, 0]);
    }
    // 90°: the grid's +x points along the world's −z (three's right-handed turn about +y).
    const quarter = new GridFrame({ gridId: 1, position: [0, 0, 0], yawRad: Math.PI / 2 }).toWorld(1, 0, 0);
    expect(quarter.map((v) => Math.round(v * 1e9) / 1e9 + 0)).toEqual([0, 0, -1]);
  });

  it('reads and writes the page text, refusing what is not a placement', () => {
    const places = [{ gridId: 1, position: [1.5, 0, -2] as [number, number, number], yawRad: Math.PI / 6 }, { gridId: 9, position: [-100, 2, 3.25] as [number, number, number], yawRad: 0 }];
    const parsed = parseGridPlacements(`${gridPlacementsText('far', places)}|town:4,0,0,0,45`);
    expect([...parsed.keys()]).toEqual(['far', 'town']);
    expect(parsed.get('far')!.map((p) => [p.gridId, p.position, Math.round((p.yawRad * 180) / Math.PI)])).toEqual([[1, [1.5, 0, -2], 30], [9, [-100, 2, 3.25], 0]]);
    expect(parseGridPlacements('').size).toBe(0);
    for (const bad of ['far', 'far:0,0,0,0,0', 'far:1,0,0,0', 'far:1,0,x,0,0', 'far:1,0,0,0,0;1,1,1,1,0', ':1,0,0,0,0']) expect(() => parseGridPlacements(bad), bad).toThrow(/grid placements/);
    expect(gridPlacementProblem({ gridId: 2, position: [0, 0, Infinity], yawRad: 0 })).toMatch(/position/);
    expect(() => new GridFrame({ gridId: 0, position: [0, 0, 0], yawRad: 0 })).toThrow(/world grid/);
  });
});

describe("a structure grid's chunks", () => {
  /** A grid's region files on a byte source in memory: a house of two chunks at its cell 0, and a lone chunk farther. */
  function source(): { src: RegionChunkSource; names: string[] } {
    const store = createWorldStore(grid);
    const v = { material: 3, role: VOXEL_ROLE.wall, shape: 15, wetness: 0 };
    for (let x = 0; x < 40; x++) for (let y = 0; y < 6; y++) store.setVoxel(x, y, 3, v);
    store.setVoxel(5, 70, 600, v);
    const files = new Map<string, Uint8Array>();
    const byRegion = new Map<string, { at: number[]; entries: RegionEntry[] }>();
    for (const [cx, cy, cz] of [[0, 0, 0], [1, 0, 0], [0, 2, 18]] as const) {
      const bytes = store.encodeChunk(cx, cy, cz);
      if (bytes === null) continue;
      const at = [Math.floor(cx / 16), Math.floor(cy / 16), Math.floor(cz / 16)];
      const name = regionFileName('stacked', at[0]!, at[1]!, at[2]!);
      let r = byRegion.get(name);
      if (r === undefined) byRegion.set(name, (r = { at, entries: [] }));
      r.entries.push(packRegionChunk(grid, cx, cy, cz, bytes, 'none', (x) => x));
    }
    for (const [name, r] of byRegion) files.set(name, writeRegion({ worldId: WORLD, gridId: 5, layout: 'stacked', grid, footprint: 512, rx: r.at[0]!, ry: r.at[1]!, rz: r.at[2]!, compressor: 'none' }, r.entries));
    const open = (name: string) => {
      const b = files.get(name);
      return b === undefined ? null : { read: async (o: number, n: number) => b.subarray(o, o + n) };
    };
    return { src: new RegionChunkSource({ worldId: WORLD, gridId: 5, grid, layout: 'stacked', footprint: 512, open, maxOpen: 4 }), names: [...files.keys()] };
  }

  it("is the box round every chunk its files' tables name; a streamer reads nothing outside it", async () => {
    const { src, names } = source();
    expect(names.sort()).toEqual(['r.0.0.0.vxr', 'r.0.0.1.vxr']);
    const box = await gridChunkExtent(src, 'stacked', names);
    expect(box).toEqual({ min: [0, 0, 0], max: [1, 2, 18] });
    expect(await gridChunkExtent(src, 'stacked', [])).toBeNull();
    // A listed file that is gone is left out of the box (its chunks are reported damaged when read).
    expect(await gridChunkExtent(src, 'stacked', ['r.0.0.0.vxr', 'r.5.0.5.vxr'])).toEqual({ min: [0, 0, 0], max: [1, 0, 0] });
    // The load ring round a focus by the house: every chunk asked lies in the grown box, and the house's are asked.
    const near = grownChunkBox({ min: [0, 0, 0], max: [1, 0, 0] }, 2);
    const focus = { x: 20, y: 4, z: 10 };
    const all = readOrder(grid, DEFAULT_STREAM_RING, focus, focus);
    const clipped = readOrder(grid, DEFAULT_STREAM_RING, focus, focus, DEFAULT_STREAM_RING.loadRadius, near);
    expect(all.length).toBeGreaterThan(1000);
    expect(clipped.length).toBe(6 * 5 * 5);
    expect(clipped.every((w) => [w.cx, w.cy, w.cz].every((v, a) => v >= near.min[a]! && v <= near.max[a]!))).toBe(true);
    expect(clipped.some((w) => w.cx === 1 && w.cy === 0 && w.cz === 0)).toBe(true);
    // Far from the grid's chunks: nothing to read.
    expect(readOrder(grid, DEFAULT_STREAM_RING, { x: 4000, y: 0, z: 0 }, { x: 4000, y: 0, z: 0 }, DEFAULT_STREAM_RING.loadRadius, near)).toEqual([]);
  });
});
