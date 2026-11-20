/**
 * Open regions on the generated town (the world rules' derive in this process, 16³ sections, a box of 6 × 3 × 6
 * chunks): every house standing whole in the box in the world grid is one enclosed region of its rooms (its storeys
 * joined by the stair holes, its attic under the roof), its doors and windows portals to the street; the street is
 * under the sky. The houses are counted from the generator's own lots, not from the labels.
 */
import { describe, expect, it } from 'vitest';
import { CPU_SCALAR_OPS } from '@thirdlight/shared';
import { OpenRegionStitch, SUN_COVER_OFFSET, sunCovered, voxel, VOXEL_ROLE, type RegionStreamerView } from '@thirdlight/voxel';

import { walkWorld, WALK_GRID } from './walk-world';
import { townWorld } from './worlds';

describe('open regions on the town', () => {
  const world = townWorld({ footprint: 512 });
  // World chunks 5 … 10 on x and z (the box's −3 … 2 moved by 8), y −1 … 1.
  const w = walkWorld(world, [-3, -1, -3], [2, 1, 2], [8, 0, 8]);
  const view: RegionStreamerView = { grid: WALK_GRID, sections: { edge: 16, shift: 4, mask: 15, cellsPerChunk: 4096, chunkMinXZ: 0, chunkMinY: 0, chunkSpanXZ: 0, chunkSpanY: 0 } as never, derivedOf: (sx, sy, sz) => w.view().derivedOf(sx, sy, sz) };

  it('gives each house in the box one enclosed region with portals, and the street the sky', () => {
    const s = new OpenRegionStitch(view);
    for (let cx = -3; cx <= 2; cx++) for (let cy = -1; cy <= 1; cy++) for (let cz = -3; cz <= 2; cz++) s.touch(cx, cy, cz);
    const t0 = performance.now();
    s.update();
    const ms = performance.now() - t0;
    const stats = s.stats();
    const enclosed = [...s.all()].filter((r) => r.enclosed);
    console.log(`[open-regions town] ${JSON.stringify(stats)}, ${s.bytes} B, stitched in ${ms.toFixed(1)} ms; enclosed ${JSON.stringify(enclosed.map((r) => ({ m3: r.cells / 8, portals: r.portals })))}`);
    expect(stats.pieces).toBe(108);
    expect(enclosed.length).toBeGreaterThan(0);
    for (const r of enclosed) expect(r.portals).toBeGreaterThan(0);
    // The street 4 m up at a lot's corner (box cell 24 is world cell 280, the lot's first cells: no house) is under the sky.
    const street = s.regionAt(24, 8, 24)!;
    expect(street.enclosed).toBe(false);
    expect(street.sky).toBe(true);
    expect(s.skyAt(24, 8, 24)).toBe(true);
    // Houses of 8–14 m by 8–14 m, one to three 3 m storeys and a 45° roof: 190–2,000 m³ each, never more than one
    // house a region (a leak through a roof or a wall would join one to the street, or two houses together).
    expect(enclosed.length).toBeGreaterThanOrEqual(15);
    for (const r of enclosed) expect(r.cells / 8).toBeGreaterThan(190);
    for (const r of enclosed) expect(r.cells / 8).toBeLessThan(2000);
    // Each house as a room for a game: its cells and surface against a flood fill from one of its cells (open cells,
    // openings apart), its box inside a lot, a mean free path 4V/S of a few metres, its portals (its doors and windows)
    // each joining it to another region.
    const opening = (x: number, y: number, z: number): boolean => {
      const v = voxel();
      w.store.voxelAt(x, y, z, v);
      return v.role === VOXEL_ROLE.opening;
    };
    const sizes: string[] = [];
    for (const r of enclosed) {
      const fill = floodFrom(r, w.solidAt.bind(w), opening);
      expect([fill.cells, fill.faces]).toEqual([r.cells, r.faces]);
      const span = r.max.map((v, a) => (v - r.min[a]! + 1) / 2);
      expect(Math.max(span[0]!, span[2]!)).toBeLessThan(16);
      const mfp = (4 * r.cells * 0.125) / (r.faces * 0.25);
      expect(mfp).toBeGreaterThan(1);
      expect(mfp).toBeLessThan(6);
      const ports = s.portalsOf(r.id);
      expect(ports.length).toBe(r.portals);
      for (const p of ports) {
        expect(p.regions).toContain(r.id);
        expect(p.regions.length).toBe(2);
      }
      sizes.push(`${(r.cells / 8).toFixed(0)} m³ ${(r.faces / 4).toFixed(0)} m² mfp ${mfp.toFixed(2)} m box ${span.join('×')} m portals ${ports.length}`);
    }
    console.log(`[open-regions town] rooms: ${sizes.join('; ')}`);
    // The light volume's indoor share reads a point's column top (the sky heights) over the point taken off its surface:
    // every wall face inside a house is under a roof, the walls' faces outside are not (the point is taken past the eaves).
    const streetId = street.id;
    const count = { inside: 0, insideCovered: 0, outside: 0, outsideCovered: 0 };
    for (const r of enclosed) {
      for (let x = r.min[0]! - 1; x <= r.max[0]! + 1; x++) for (let z = r.min[2]! - 1; z <= r.max[2]! + 1; z++) for (let y = r.min[1]!; y <= r.max[1]!; y++) {
        const id = s.regionIdAt(x, y, z);
        if (id !== r.id && id !== streetId) continue;
        for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
          if (!w.solidAt(x + dx, y, z + dz)) continue;
          // The face's middle (metres), its normal away from the wall, the point taken off by the column share.
          const m = 0.5;
          const px = (x + 0.5 + dx / 2) * m - dx * SUN_COVER_OFFSET * m;
          const pz = (z + 0.5 + dz / 2) * m - dz * SUN_COVER_OFFSET * m;
          const top = s.skyHeight(Math.floor(px / m), Math.floor(pz / m))! * m;
          const c = sunCovered(CPU_SCALAR_OPS, (y + 0.5) * m, top);
          if (id === r.id) (count.inside++, (count.insideCovered += c));
          else (count.outside++, (count.outsideCovered += c));
        }
      }
    }
    console.log(`[open-regions town] wall faces under a roof: inside ${count.insideCovered} of ${count.inside}, outside ${count.outsideCovered} of ${count.outside}`);
    expect(count.inside).toBeGreaterThan(1000);
    expect(count.insideCovered).toBe(count.inside);
    expect(count.outside).toBeGreaterThan(1000);
    expect(count.outsideCovered / count.outside).toBeLessThan(0.05);
  });
});

/** A 6-connected flood fill of a region's open cells from a cell inside it (openings apart), within its box: its cells and the faces against solid cells. */
function floodFrom(r: { readonly min: readonly number[]; readonly max: readonly number[] }, solid: (x: number, y: number, z: number) => boolean, opening: (x: number, y: number, z: number) => boolean): { cells: number; faces: number } {
  let start: number[] | null = null;
  for (let x = r.min[0]!; x <= r.max[0]! && start === null; x++) for (let y = r.min[1]!; y <= r.max[1]! && start === null; y++) for (let z = r.min[2]!; z <= r.max[2]! && start === null; z++) if (!solid(x, y, z) && !opening(x, y, z)) start = [x, y, z];
  const seen = new Set<string>([start!.join(',')]);
  const stack = [start!];
  let faces = 0;
  while (stack.length > 0) {
    const p = stack.pop()!;
    for (const d of [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]]) {
      const q = p.map((v, a) => v + d[a]!);
      if (solid(q[0]!, q[1]!, q[2]!)) {
        faces++;
        continue;
      }
      const k = q.join(',');
      if (seen.has(k) || opening(q[0]!, q[1]!, q[2]!)) continue;
      seen.add(k);
      stack.push(q);
    }
  }
  return { cells: seen.size, faces };
}
