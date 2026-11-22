/**
 * The package's building generator against the bench's house pattern and
 * the real derive: the plain house of every town lot writes the pattern's
 * voxels (but for what a structure record does not hold), the same house
 * written by runtime fill commands derives to the same bytes, and a
 * two-storey L-house through the world rules and a full kit gives pieces of
 * known cases only.
 */
import { applyEdit, BUILDING_GENERATOR, boxChunks, canonicalEditCommand, chunkGrid, createWorldStore, deriveFromStore, encodeDerived, valueOf, WORLD_RULES, type VoxelRecord } from '@thirdlight/voxel';
import { describe, expect, it } from 'vitest';
import { benchHouseDefinition, CASE_IDS, FULL_TABLE, generateStructure as generate, lHouse, lHousePieces } from './structure-houses';
import { houseVoxel, STOREY, townHouses, type House } from './town';

const grid = chunkGrid(32);

const v: VoxelRecord = { material: 0, role: 0, shape: 0, wetness: 0 };

describe('the building generator against the bench house and the derive', () => {
  it('writes the bench pattern\'s voxels for every plain town house, but for its beams and the landing cell of its stairs', () => {
    let houses = 0;
    let cells = 0;
    let beams = 0;
    let landings = 0;
    for (const t of townHouses()) {
      const h: House = { ...t.house, balcony: false };
      const s = generate(benchHouseDefinition(h));
      const top = h.storeys * STOREY;
      for (let x = -3; x < h.w + 3; x++) for (let z = -4; z < h.d + 3; z++) for (let y = -2; y < top + h.d; y++) {
        const want = houseVoxel(h, x, y, z, v) ? valueOf(v) : 0;
        const got = valueOf(s.voxelAt(x, y, z, v));
        if (want === got) {
          if (got !== 0) cells++;
          continue;
        }
        const storeyLine = y > 0 && y < top && y % STOREY === 0;
        // The pattern's beams one cell out at the storey lines: not in a structure record (a kit or a later field).
        const beam = storeyLine && (z === -1 || z === h.d) && x >= 0 && x < h.w && got === 0;
        // The pattern leaves the floor open one cell past its top step; the generator floors that landing.
        const landing = storeyLine && (x === 1 || x === 2) && z === 7 && want === 0 && got !== 0;
        if (beam) beams++;
        if (landing) landings++;
        if (!beam && !landing) expect.fail(`house ${t.i},${t.j} (${h.w} × ${h.d}, ${h.storeys} storeys) at (${x}, ${y}, ${z}): pattern ${want}, generator ${got}`);
      }
      houses++;
    }
    expect(houses).toBeGreaterThan(100);
    expect(cells).toBeGreaterThan(houses * 1000);
    // Both differences are there (the town has two- and three-storey houses).
    expect(beams).toBeGreaterThan(houses);
    expect(landings).toBeGreaterThan(houses);
  }, 120_000);

  it('derives the same bytes from the house written by runtime fill commands as from the generated one (an L-house, two storeys)', () => {
    const d = lHouse();
    const structure = generate(d);
    const runtime = createWorldStore(grid);
    const b = BUILDING_GENERATOR.box(d);
    let commands = 0;
    for (let x = b.minX; x <= b.maxX; x++) for (let z = b.minZ; z <= b.maxZ; z++) {
      // Each column's runs of equal voxels as one-cell-wide fill boxes: no structure record on the runtime side.
      let run: { y0: number; m: number; r: number } | null = null;
      const flush = (y1: number): void => {
        if (run === null) return;
        applyEdit({ store: () => runtime }, canonicalEditCommand({ v: 2, grid: 0, kind: 'fill', min: [x, run.y0, z], max: [x, y1, z], mode: 'place', voxel: { material: run.m, role: run.r, wetness: 0 } }));
        commands++;
        run = null;
      };
      for (let y = b.minY; y <= b.maxY + 1; y++) {
        structure.voxelAt(x, y, z, v);
        const hit = v.material !== 0;
        if (run !== null && (!hit || run.m !== v.material || run.r !== v.role)) flush(y - 1);
        if (hit && run === null) run = { y0: y, m: v.material, r: v.role };
      }
      flush(b.maxY + 1);
    }
    expect(commands).toBeGreaterThan(500);
    let chunks = 0;
    for (const c of boxChunks(grid, { ...b, minX: b.minX - 32, minZ: b.minZ - 32, maxX: b.maxX + 32, maxZ: b.maxZ + 32 })) {
      const a = encodeDerived(deriveFromStore(structure, c.cx, c.cy, c.cz, WORLD_RULES, undefined, FULL_TABLE));
      expect(encodeDerived(deriveFromStore(runtime, c.cx, c.cy, c.cz, WORLD_RULES, undefined, FULL_TABLE)), `chunk ${c.cx},${c.cy},${c.cz}`).toEqual(a);
      chunks++;
    }
    expect(chunks).toBeGreaterThan(4);
  }, 120_000);

  it('gives a generated two-storey L-house pieces of the kit rules\' own cases only, on every part', () => {
    const counts = lHousePieces();
    expect(counts.total).toBeGreaterThan(500);
    for (const id of Object.keys(counts.byCase)) expect(CASE_IDS.has(id), id).toBe(true);
    expect(counts.unknown).toBe(0);
    // Edges and corners of the walls, the roof's planes' edges.
    for (const id of ['edge-out-vertical', 'edge-out-top', 'corner-out-top', 'roof-ridge', 'roof-eave', 'roof-valley']) expect(counts.byCase[id] ?? 0, id).toBeGreaterThan(0);
  }, 120_000);
});

