/**
 * The edge pass on real stores and the integrity reading of construction
 * shapes. Every pattern of the 4 cells round a lattice edge and of the 8 round
 * a lattice corner gives exactly the case the edge table names (or none);
 * a turned scene gives the same pieces turned; a flat face gives none; a
 * box house's edges and corners are what the table says; terrain contact
 * gives none. A construction cell at integrity 7 collides, occludes, meshes
 * and mips as one at 15; terrain at 7 is still a partial fill.
 */
import {
  applyEdit,
  buildApron,
  chunkGrid,
  createDenseChunk,
  createEdgeMasks,
  createNeighbourhood,
  createWorldStore,
  deriveFromStore,
  downsampleMip,
  EDGE_CASE_IDS,
  EDGE_RULES,
  edgePiecesOf,
  evaluateEdges,
  fillLevel,
  fillNeighbourhood,
  jobRadius,
  rulesDrawDebris,
  buildPieceTable,
  defaultKitSource,
  localIndex,
  PIECE_SLOT_TABLE,
  shapeDensity,
  SHAPE_FULL,
  TERRAIN_RULES,
  VOXEL_ROLE,
  canonicalEditCommand,
  type DerivedData,
  type EdgeCaseId,
  type PaletteStore,
} from '@thirdlight/voxel';
import { describe, expect, it } from 'vitest';
import { dabDetailRoles, putVoxel, randomAssemblyWorld } from './scenes';
import { MAT } from './world-kit';

const grid = chunkGrid(32);
const E = grid.edge;
const PAD = jobRadius(EDGE_RULES);
const C = VOXEL_ROLE;
type Cell = readonly [number, number, number];

/** A placed piece in world terms: its owner cell, the lattice edge or corner it sits on, case and yaw. */
interface Placed {
  readonly owner: Cell;
  /** `e<axis>:x,y,z` (the edge's low lattice point) or `c:x,y,z` (the corner's lattice point). */
  readonly at: string;
  readonly caseId: EdgeCaseId;
  readonly yaw: number;
  readonly inner: boolean;
}

/** The lattice key of an owner's slot. */
function slotKey(owner: Cell, slot: number): string {
  const s = PIECE_SLOT_TABLE[slot]!;
  const p = owner.map((v, d) => v + (s.side[d]! > 0 ? 1 : 0));
  return s.axis < 0 ? `c:${p.join(',')}` : `e${s.axis}:${p.join(',')}`;
}

/** Every piece the edge pass places in the given chunks. */
function piecesOf(store: PaletteStore, list: ReadonlyArray<Cell>): Placed[] {
  const n = createNeighbourhood(E, PAD);
  const masks = createEdgeMasks(n);
  const dense = createDenseChunk(grid);
  const s = n.side;
  const out: Placed[] = [];
  for (const [cx, cy, cz] of list) {
    const has = store.exportChunk(cx, cy, cz, dense);
    fillNeighbourhood(n, grid, has ? dense : null, buildApron(store, cx, cy, cz, PAD));
    evaluateEdges(n, EDGE_RULES, 0, masks);
    for (let x = 0; x < E; x++) for (let z = 0; z < E; z++) for (let y = 0; y < E; y++) {
      const i = ((x + PAD) * s + (z + PAD)) * s + (y + PAD);
      if (masks.pieces[i] === 0) continue;
      const owner: Cell = [cx * E + x, cy * E + y, cz * E + z];
      for (const p of edgePiecesOf(masks, i)) out.push({ owner, at: slotKey(owner, p.slot), caseId: p.caseId, yaw: p.yaw, inner: p.inner });
    }
  }
  return out;
}

const chunk0: Cell[] = [[0, 0, 0]];

/** Yaw of a horizontal direction the piece's open side faces: +z 0, −x 1, −z 2, +x 3 (each turn takes +x to +z). */
const yawFacing = (dx: number, dz: number): number => (dz > 0 ? 0 : dx < 0 ? 1 : dz < 0 ? 2 : 3);
/** Yaw of a quadrant the piece's open side faces: (+x, +z) 0, (−x, +z) 1, (−x, −z) 2, (+x, −z) 3. */
const yawQuadrant = (dx: number, dz: number): number => (dx > 0 && dz > 0 ? 0 : dx < 0 && dz > 0 ? 1 : dx < 0 ? 2 : 3);

describe('the edge pass: the table', () => {
  // The lattice point every pattern sits round; its cells are 15 or 16 on each axis.
  const L = 16;

  it('every 4-cell pattern round a lattice edge gives exactly the case the table names', () => {
    let checked = 0;
    for (let axis = 0; axis < 3; axis++) {
      const [u, v] = [0, 1, 2].filter((a) => a !== axis) as [number, number];
      const cellOf = (b: number): Cell => {
        const c = [L, L, L];
        c[u] = b & 1 ? L : L - 1;
        c[v] = b & 2 ? L : L - 1;
        return c as unknown as Cell;
      };
      const key = `e${axis}:${L},${L},${L}`;
      for (let p = 0; p < 16; p++) {
        for (const ground of [false, true]) {
          const s = createWorldStore(grid);
          const solid = [0, 1, 2, 3].filter((b) => (p >> b) & 1);
          if (ground && solid.length === 0) continue;
          for (const [k, b] of solid.entries()) putVoxel(s, ...cellOf(b), ground && k === 0 ? MAT.grass : MAT.stone, ground && k === 0 ? C.terrain : C.wall);
          const got = piecesOf(s, chunk0).filter((q) => q.at === key).map((q) => ({ owner: q.owner, caseId: q.caseId, yaw: q.yaw }));
          // Expected, from the table: one solid an outer edge, three an inner one, two diagonal two outer edges, two side
          // by side (a flat face), none or four: nothing; terrain round it: nothing.
          const expected: Array<{ owner: Cell; caseId: EdgeCaseId; yaw: number }> = [];
          const piece = (owner: number, inner: boolean): void => {
            const o = cellOf(owner);
            // The open side, from the owner across the edge: (lattice − cell centre) on the two axes round it.
            const d = [0, 0, 0];
            d[u] = owner & 1 ? -1 : 1;
            d[v] = owner & 2 ? -1 : 1;
            let caseId: EdgeCaseId;
            let yaw: number;
            if (axis === 1) {
              caseId = inner ? 'edge-in-vertical' : 'edge-out-vertical';
              yaw = yawQuadrant(d[0]!, d[2]!);
            } else {
              // Outer: the solid cell below the edge is a top edge. Inner: the open cell (diagonal) below is "in-top".
              const solidBelow = d[1]! > 0;
              caseId = inner ? (solidBelow ? 'edge-in-bottom' : 'edge-in-top') : solidBelow ? 'edge-out-top' : 'edge-out-bottom';
              yaw = yawFacing(d[0]!, d[2]!);
            }
            expected.push({ owner: o, caseId, yaw });
          };
          if (!ground) {
            if (solid.length === 1) piece(solid[0]!, false);
            if (solid.length === 2 && (solid[0]! ^ solid[1]!) === 3) solid.forEach((b) => piece(b, false));
            if (solid.length === 3) piece(3 - [0, 1, 2, 3].find((b) => !solid.includes(b))!, true);
          }
          const sort = (xs: typeof expected): string[] => xs.map((x) => JSON.stringify(x)).sort();
          expect(sort(got), `axis ${axis} pattern ${p}${ground ? ' with ground' : ''}`).toEqual(sort(expected));
          checked++;
        }
      }
    }
    expect(checked).toBe(3 * (16 + 15));
  });

  it('every 8-cell pattern round a lattice corner gives exactly the case the table names', () => {
    const cellOf = (b: number): Cell => [b & 1 ? L : L - 1, b & 2 ? L : L - 1, b & 4 ? L : L - 1];
    const key = `c:${L},${L},${L}`;
    const seen = new Set<string>();
    for (let p = 0; p < 256; p++) {
      const s = createWorldStore(grid);
      const solid = [0, 1, 2, 3, 4, 5, 6, 7].filter((b) => (p >> b) & 1);
      for (const b of solid) putVoxel(s, ...cellOf(b), MAT.stone, (b & 1) === 0 ? C.wall : C.floor);
      const got = piecesOf(s, chunk0).filter((q) => q.at === key).map((q) => ({ owner: q.owner, caseId: q.caseId, yaw: q.yaw }));
      const expected: Array<{ owner: Cell; caseId: EdgeCaseId; yaw: number }> = [];
      const corner = (owner: number, inner: boolean): void => {
        const d = [owner & 1 ? -1 : 1, owner & 2 ? -1 : 1, owner & 4 ? -1 : 1];
        const solidBelow = d[1]! > 0;
        const caseId: EdgeCaseId = inner ? (solidBelow ? 'corner-in-bottom' : 'corner-in-top') : solidBelow ? 'corner-out-top' : 'corner-out-bottom';
        expected.push({ owner: cellOf(owner), caseId, yaw: yawQuadrant(d[0]!, d[2]!) });
        seen.add(caseId);
      };
      if (solid.length === 1) corner(solid[0]!, false);
      if (solid.length === 7) corner(7 - [0, 1, 2, 3, 4, 5, 6, 7].find((b) => !solid.includes(b))!, true);
      expect(got, `pattern ${p}`).toEqual(expected);
    }
    expect([...seen].sort()).toEqual(['corner-in-bottom', 'corner-in-top', 'corner-out-bottom', 'corner-out-top']);
  });
});

/** A hollow box: floor and flat roof slabs, walls round, outer size sx × sy × sz from (x0, y0, z0). */
function boxHouse(s: PaletteStore, x0: number, y0: number, z0: number, sx: number, sy: number, sz: number): void {
  for (let x = x0; x < x0 + sx; x++) for (let z = z0; z < z0 + sz; z++) for (let y = y0; y < y0 + sy; y++) {
    const edge = x === x0 || z === z0 || x === x0 + sx - 1 || z === z0 + sz - 1;
    if (y === y0) putVoxel(s, x, y, z, MAT.plank, C.floor);
    else if (y === y0 + sy - 1) putVoxel(s, x, y, z, MAT.roofTile, C.roof);
    else if (edge) putVoxel(s, x, y, z, MAT.stone, C.wall);
  }
}

const histogram = (ps: readonly Placed[]): Record<string, number> => {
  const h: Record<string, number> = {};
  for (const p of ps) h[p.caseId] = (h[p.caseId] ?? 0) + 1;
  return h;
};

/** The 4 cells round an edge key (or 8 round a corner key), solid or not. */
function solidRound(s: PaletteStore, at: string): boolean[] {
  const [head, rest] = at.split(':') as [string, string];
  const p = rest.split(',').map(Number);
  const v = { material: 0, role: 0, shape: 0, wetness: 0 };
  const solid = (x: number, y: number, z: number): boolean => {
    s.voxelAt(x, y, z, v);
    return v.material !== 0 && v.role !== C.opening && v.role !== C.liquid;
  };
  const out: boolean[] = [];
  if (head === 'c') {
    for (let b = 0; b < 8; b++) out.push(solid(p[0]! - (b & 1 ? 0 : 1), p[1]! - (b & 2 ? 0 : 1), p[2]! - (b & 4 ? 0 : 1)));
    return out;
  }
  const axis = Number(head.slice(1));
  const [u, v2] = [0, 1, 2].filter((a) => a !== axis) as [number, number];
  for (let b = 0; b < 4; b++) {
    const c = [...p];
    c[u] = p[u]! - (b & 1 ? 0 : 1);
    c[v2] = p[v2]! - (b & 2 ? 0 : 1);
    out.push(solid(c[0]!, c[1]!, c[2]!));
  }
  return out;
}

/** No piece on a flat face: every edge piece has 1 or 3 of its 4 cells solid (or 2 diagonal), every corner 1 or 7 of 8. */
function expectNoFlatPiece(s: PaletteStore, ps: readonly Placed[]): void {
  for (const p of ps) {
    const r = solidRound(s, p.at);
    const n = r.filter(Boolean).length;
    if (r.length === 8) expect([1, 7], `${p.caseId} at ${p.at}`).toContain(n);
    else expect(n === 1 || n === 3 || (n === 2 && r[0] === r[3]), `${p.caseId} at ${p.at}: ${r}`).toBe(true);
  }
}

describe('the edge pass: scenes', () => {
  it("gives a wall's flat faces no case: only its rim's edges and corners", () => {
    const s = createWorldStore(grid);
    for (let x = 10; x < 22; x++) for (let y = 8; y < 16; y++) putVoxel(s, x, y, 16, MAT.stone, C.wall);
    const ps = piecesOf(s, chunk0);
    expect(histogram(ps)).toEqual({ 'edge-out-top': 26, 'edge-out-bottom': 26, 'edge-out-vertical': 32, 'corner-out-top': 4, 'corner-out-bottom': 4 });
    // Every piece's owner is on the wall's rim; no cell inside the face owns one.
    for (const p of ps) expect(p.owner[0] === 10 || p.owner[0] === 21 || p.owner[1] === 8 || p.owner[1] === 15, `${p.caseId} of ${p.owner}`).toBe(true);
    expectNoFlatPiece(s, ps);
  });

  it("classifies a box house's outer and inner edges and corners as the table says", () => {
    const s = createWorldStore(grid);
    boxHouse(s, 12, 10, 12, 8, 6, 8);
    const ps = piecesOf(s, chunk0);
    expect(histogram(ps)).toEqual({
      'edge-out-top': 32,
      'edge-out-bottom': 32,
      'edge-out-vertical': 24,
      'corner-out-top': 4,
      'corner-out-bottom': 4,
      'edge-in-bottom': 24,
      'edge-in-top': 24,
      'edge-in-vertical': 16,
      'corner-in-bottom': 4,
      'corner-in-top': 4,
    });
    expectNoFlatPiece(s, ps);
    // An inner edge belongs to the cell diagonal to the open one: the floor under a wall, the roof over it.
    const v = { material: 0, role: 0, shape: 0, wetness: 0 };
    for (const p of ps.filter((q) => q.caseId === 'edge-in-bottom')) expect((s.voxelAt(...p.owner, v), v.role), `${p.owner}`).toBe(C.floor);
    for (const p of ps.filter((q) => q.caseId === 'edge-in-top')) expect((s.voxelAt(...p.owner, v), v.role), `${p.owner}`).toBe(C.roof);
    // A door: its jambs and lintel get edges, the wall round it stays plain.
    putVoxel(s, 15, 11, 12, 0, C.air);
    putVoxel(s, 15, 12, 12, 0, C.air);
    putVoxel(s, 15, 11, 12, MAT.stone, C.opening);
    putVoxel(s, 15, 12, 12, MAT.stone, C.opening);
    const door = piecesOf(s, chunk0);
    expectNoFlatPiece(s, door);
    const jambs = door.filter((p) => p.caseId === 'edge-out-vertical' && p.owner[0] >= 13 && p.owner[0] <= 17 && p.owner[1] >= 11 && p.owner[1] <= 12 && p.owner[2] === 12);
    expect(jambs).toHaveLength(8);
    expect(door.filter((p) => p.caseId === 'edge-out-bottom' && p.owner.join(',') === '15,13,12')).toHaveLength(2);
  });

  it('gives no piece where a building meets terrain', () => {
    const s = createWorldStore(grid);
    for (let x = 8; x < 24; x++) for (let z = 8; z < 24; z++) for (let y = 7; y < 10; y++) putVoxel(s, x, y, z, MAT.grass, C.terrain);
    boxHouse(s, 12, 10, 12, 8, 6, 8);
    const ps = piecesOf(s, chunk0);
    // The slab's underside edges and corners sit on the ground: none; everything clear of it as on air.
    expect(histogram(ps)).toEqual({
      'edge-out-top': 32,
      'edge-out-vertical': 24,
      'corner-out-top': 4,
      'edge-in-bottom': 24,
      'edge-in-top': 24,
      'edge-in-vertical': 16,
      'corner-in-bottom': 4,
      'corner-in-top': 4,
    });
  });

  it('gives a turned scene the same pieces turned (yaw + 1 a quarter turn)', () => {
    // An L of walls with a door and a window, a floor slab overhanging, a step, a free pillar and a beam-like ledge.
    const scene: Array<[number, number, number, number, number]> = [];
    for (let x = 10; x < 20; x++) for (let y = 10; y < 15; y++) scene.push([x, y, 12, MAT.stone, C.wall]);
    for (let z = 12; z < 20; z++) for (let y = 10; y < 15; y++) scene.push([10, y, z, MAT.brick, C.wall]);
    for (let x = 9; x < 21; x++) for (let z = 9; z < 15; z++) scene.push([x, 15, z, MAT.plank, C.floor]);
    for (let x = 10; x < 21; x++) for (let z = 12; z < 21; z++) scene.push([x, 9, z, MAT.plank, C.floor]);
    for (let x = 14; x < 17; x++) scene.push([x, 10, 15, MAT.stone, C.stair], [x, 11, 16, MAT.stone, C.stair]);
    for (let y = 10; y < 13; y++) scene.push([18, y, 18, MAT.timber, C.pillar]);
    scene.push([13, 12, 13, MAT.timber, C.wall], [17, 13, 13, MAT.timber, C.wall]);
    const openings: Cell[] = [[12, 10, 12], [12, 11, 12], [16, 12, 12], [10, 12, 16]];
    const build = (turns: number): PaletteStore => {
      const s = createWorldStore(grid);
      const turn = (x: number, z: number): [number, number] => {
        for (let k = 0; k < turns; k++) [x, z] = [31 - z, x];
        return [x, z];
      };
      for (const [x, y, z, m, r] of scene) {
        const [tx, tz] = turn(x, z);
        const open = openings.some((o) => o[0] === x && o[1] === y && o[2] === z);
        putVoxel(s, tx, y, tz, m, open ? C.opening : r);
      }
      return s;
    };
    const key = (p: Placed): string => `${p.owner.join(',')}|${p.caseId}|${p.yaw}`;
    const base = piecesOf(build(0), chunk0);
    expect(new Set(base.map((p) => p.caseId)).size).toBe(EDGE_CASE_IDS.length);
    for (const turns of [1, 2, 3]) {
      const want = base.map((p) => {
        let [x, z] = [p.owner[0], p.owner[2]];
        for (let k = 0; k < turns; k++) [x, z] = [31 - z, x];
        return key({ ...p, owner: [x, p.owner[1], z], yaw: (p.yaw + turns) % 4 });
      });
      expect(piecesOf(build(turns), chunk0).map(key).sort(), `${turns} turns`).toEqual(want.sort());
    }
  });

  it('places no piece on a flat face on random worlds, and the same pieces cut at 16 or 32', () => {
    for (const seed of [1, 2]) {
      const s = createWorldStore(grid);
      randomAssemblyWorld(s, seed, 24);
      dabDetailRoles(s, seed);
      const chunks: Cell[] = [-1, 0].flatMap((cx) => [-1, 0].flatMap((cy) => [-1, 0].map((cz) => [cx, cy, cz] as Cell)));
      const ps = piecesOf(s, chunks);
      expect(ps.length).toBeGreaterThan(100);
      expectNoFlatPiece(s, ps);
      // One piece a slot: no lattice edge carries two pieces of one owner.
      expect(new Set(ps.map((p) => `${p.owner}|${p.at}`)).size).toBe(ps.length);
    }
  });
});

describe('construction shape is integrity', () => {
  it('reads a construction cell at any integrity as full, other roles by their fill', () => {
    for (const r of [C.wall, C.floor, C.roof, C.foundation, C.stair, C.pillar]) {
      expect([fillLevel(r, 0), fillLevel(r, 1), fillLevel(r, 7), fillLevel(r, 15)]).toEqual([0, 15, 15, 15]);
    }
    for (const r of [C.terrain, C.liquid, C.opening, C.air]) expect(fillLevel(r, 7)).toBe(7);
  });

  /** Every consumer's output of a derive, part by part (the shader's material grid aside: integrity is not shader data). */
  const parts = (d: DerivedData): Record<string, number[]> => ({
    occupancy: [...d.occupancy.mask ?? [], ...(d.occupancy.bricks ?? [])],
    light: [...(d.light.full ?? []), ...(d.light.partialCells ?? []), ...(d.light.partialCover ?? [])],
    collision: [...(d.collision.boxes ?? [])],
    nav: [...(d.nav.blocks ?? []), ...(d.nav.standable ?? []), ...(d.nav.clearance ?? [])],
    base: [...(d.base.vertices ?? []), ...(d.base.indices ?? [])],
    ground: [...(d.ground.vertices ?? []), ...(d.ground.indices ?? [])],
    instances: [...(d.instances.data ?? [])],
  });

  it('a wall at integrity 7 collides, occludes and is walked on as at 15 (meshed as at 15 without debris, as debris with the edge rules); terrain at 7 stays a partial fill', () => {
    const world = (wallShape: number, groundShape: number): PaletteStore => {
      const s = createWorldStore(grid);
      for (let x = 4; x < 28; x++) for (let z = 4; z < 28; z++) for (let y = 4; y < 8; y++) putVoxel(s, x, y, z, MAT.grass, C.terrain);
      for (let x = 10; x < 20; x++) for (let y = 8; y < 14; y++) putVoxel(s, x, y, 16, MAT.stone, C.wall, x === 14 && y === 10 ? wallShape : SHAPE_FULL);
      for (let x = 8; x < 12; x++) for (let z = 20; z < 24; z++) putVoxel(s, x, 8, z, MAT.grass, C.terrain, groundShape);
      return s;
    };
    for (const rules of [TERRAIN_RULES, EDGE_RULES]) {
      // The engine's default kit draws every material, so the pieces show what the derive places (no pieces without a catalogue).
      const table = rules.catalogue === undefined ? null : buildPieceTable([], rules, defaultKitSource(rules.catalogue)).table;
      const intact = parts(deriveFromStore(world(15, 7), 0, 0, 0, rules, undefined, table));
      const damaged = parts(deriveFromStore(world(7, 7), 0, 0, 0, rules, undefined, table));
      // The edge rules draw the damaged cell as debris (its base faces and pieces differ, nothing else); the terrain rules as a block.
      const drawn = rulesDrawDebris(rules) ? ['base', 'instances'] : [];
      for (const k of Object.keys(intact)) {
        if (drawn.includes(k)) expect(damaged[k], `${rules.id}: ${k}`).not.toEqual(intact[k]);
        else expect(damaged[k], `${rules.id}: ${k}`).toEqual(intact[k]);
      }
      // Terrain's shape is its fill: a terrain cell at 7 differs from one at 15 for the consumers.
      const fullGround = parts(deriveFromStore(world(15, 15), 0, 0, 0, rules));
      expect(fullGround['ground'], rules.id).not.toEqual(intact['ground']);
    }
    // The job's neighbourhood: the wall cell reads full, the terrain cell its fill.
    const n = createNeighbourhood(E, PAD);
    const dense = createDenseChunk(grid);
    const s = world(7, 7);
    fillNeighbourhood(n, grid, s.exportChunk(0, 0, 0, dense) ? dense : null, buildApron(s, 0, 0, 0, PAD));
    const at = (x: number, y: number, z: number): number => n.shapes[((x + PAD) * n.side + (z + PAD)) * n.side + (y + PAD)]!;
    expect([at(14, 10, 16), at(9, 8, 21)]).toEqual([shapeDensity(SHAPE_FULL), shapeDensity(7)]);
    // The edge pass: the damaged wall cell is a whole block (no edge opens round it, none moves); the edges touching it
    // (its own rim on the wall's two faces) take no piece, the debris pieces dress it instead.
    const key = (p: Placed): string => `${p.owner}|${p.at}|${p.caseId}`;
    const intactPieces = piecesOf(world(15, 7), chunk0).map(key);
    const damagedPieces = piecesOf(world(7, 7), chunk0).map(key);
    expect(damagedPieces.every((k) => intactPieces.includes(k))).toBe(true);
    expect(damagedPieces.length).toBe(intactPieces.length);
  });

  it('places a smooth stroke of construction as whole blocks (integrity 15) and of terrain as its fill', () => {
    const shapesOf = (role: number): Set<number> => {
      const s = createWorldStore(grid);
      applyEdit({ store: () => s }, canonicalEditCommand({ v: 2, grid: 0, kind: 'brush', shape: 'sphere', size: [3, 0, 0], points: [16.3, 16.2, 16.4], mode: 'add', voxel: { material: MAT.stone, role, wetness: 0 }, smooth: true }));
      const v = { material: 0, role: 0, shape: 0, wetness: 0 };
      const seen = new Set<number>();
      for (let x = 10; x < 23; x++) for (let y = 10; y < 23; y++) for (let z = 10; z < 23; z++) if ((s.voxelAt(x, y, z, v), v.material !== 0)) seen.add(v.shape);
      return seen;
    };
    expect([...shapesOf(C.wall)]).toEqual([SHAPE_FULL]);
    expect(shapesOf(C.terrain).size).toBeGreaterThan(3);
  });

  it('mips a wall at integrity 7 as at 15 (an intact parent), terrain at 7 by its fill', () => {
    const children = (wallShape: number, groundShape: number): ReturnType<typeof createDenseChunk>[] => {
      const out = Array.from({ length: 8 }, () => createDenseChunk(grid));
      const c = out[0]!;
      for (let x = 0; x < 8; x++) for (let y = 0; y < 8; y++) for (let z = 0; z < 2; z++) {
        const i = localIndex(grid, x, y, z);
        c.material[i] = MAT.stone;
        c.role[i] = C.wall;
        c.shape[i] = wallShape;
      }
      for (let x = 0; x < 8; x++) for (let y = 0; y < 2; y++) for (let z = 10; z < 16; z++) {
        const i = localIndex(grid, x, y, z);
        c.material[i] = MAT.grass;
        c.role[i] = C.terrain;
        c.shape[i] = groundShape;
      }
      return out;
    };
    const parent = (wallShape: number, groundShape: number): ReturnType<typeof createDenseChunk> => {
      const out = createDenseChunk(grid);
      downsampleMip(grid, children(wallShape, groundShape), out);
      return out;
    };
    const intact = parent(15, 7);
    const damaged = parent(7, 7);
    expect([...damaged.role]).toEqual([...intact.role]);
    expect([...damaged.shape]).toEqual([...intact.shape]);
    expect([...damaged.material]).toEqual([...intact.material]);
    const wallParent = localIndex(grid, 1, 1, 0);
    expect([intact.role[wallParent], intact.shape[wallParent]]).toEqual([C.wall, SHAPE_FULL]);
    // A one-cell-thick wall's parent is an intact block too (its share of the parent is not integrity).
    const thin = createDenseChunk(grid);
    const kids = children(15, 7);
    for (let x = 0; x < 8; x++) for (let y = 0; y < 8; y++) kids[0]!.shape[localIndex(grid, x, y, 1)] = 0, kids[0]!.material[localIndex(grid, x, y, 1)] = 0, kids[0]!.role[localIndex(grid, x, y, 1)] = 0;
    downsampleMip(grid, kids, thin);
    expect([thin.role[wallParent], thin.shape[wallParent]]).toEqual([C.wall, SHAPE_FULL]);
    // Terrain at 7 throughout a parent: the parent's fill is 7.
    expect([intact.role[localIndex(grid, 1, 0, 6)], intact.shape[localIndex(grid, 1, 0, 6)]]).toEqual([C.terrain, 7]);
  });
});
