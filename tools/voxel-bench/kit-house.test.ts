/**
 * Detail pieces stand only where faces meet, through the real derive with
 * the world's rule set and a kit filling every slot, bound to every
 * material: on a closed box house with a door and a window, a long wall, a
 * floor slab, a gable roof, the town and random worlds.
 *
 * - **No piece on a flat face**: every edge piece's 4 cells round its edge
 *   are 1 or 3 solid, every corner piece's 8 cells 1 or 7, read straight from
 *   the store (not from the edge pass).
 * - **One owner an edge**: every exposed edge and corner of construction
 *   (found by brute force over the lattice) has exactly one piece, and no
 *   piece sits anywhere else.
 * - **Roofs** take roof-edge pieces only; **damage** by stage: a cracked
 *   cell keeps its faces (with the crack strength) and edges, a hole draws
 *   nothing and its neighbours' faces toward it carry the stage's damage
 *   pieces (per-kit ranges and counts), collision and navigation stay whole
 *   and light follows the integrity, and at air the neighbours' plain faces
 *   and the hole's edges are back.
 */
import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { createVoxelSurface, VoxelChunkView, VoxelKitMeshes, voxelStandInLook } from '@thirdlight/three-adapter';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createGltfLoaderPort } from '@thirdlight/three-adapter/gltf-loader';
import type { VoxelKitRecordLike } from '@thirdlight/three-adapter';
import {
  buildApron,
  chunkGrid,
  createWorldStore,
  CUBE_ROTATION_X90,
  CUBE_ROTATION_ZM90,
  CUBE_ROTATIONS,
  FloatingOrigin,
  joinSectionsForDraw,
  MATERIAL_BITS,
  PIECE_STAGGER,
  SHADER_BORDER_CELLS,
  SHADER_READ_DEPTH_CELLS,
  shaderGridSide,
  WETNESS_MAX,
  VOXEL_SIZE_M,
  deriveFromStore,
  deriveSectionsWithApron,
  EDGE_CASE_IDS,
  EDGE_SLOTS,
  edgeCaseOf,
  edgeYawOf,
  encodeDerived,
  cellOutputs,
  crackStrengthOf,
  DAMAGE_SCATTER_REACH,
  deriveMipNode,
  INSTANCE_BYTES,
  INSTANCE_DRESSING_OFFSET,
  instanceScatter,
  integrityCoverage,
  MipTree,
  valueOf,
  type PieceKitSource,
  INSTANCE_PLACE,
  instancePlaceOf,
  jobRadius,
  kitPieceList,
  PIECE_SLOT_TABLE,
  PIECE_SLOTS,
  SHAPE_FULL,
  VOXEL_ROLE,
  WORLD_RULES,
  worldPieceTable,
  type DerivedData,
  type PaletteStore,
} from '@thirdlight/voxel';
import { loadArea } from './regions';
import { dabDetailRoles, putVoxel, randomAssemblyWorld } from './scenes';
import { townWorld } from './town';
import { fullTestKit } from './test-kits';
import { MAT } from './world-kit';
import { ROOF_EDGE_NEAR_M, roofCaseOffset, type RoofEdgeCaseId } from './roof-edge-surface';

const grid = chunkGrid(32);
const E = grid.edge;
const R = VOXEL_ROLE;
const RULES = WORLD_RULES;
const CAT = RULES.catalogue!;
/** Every material a test world here uses: the kit binds them all. */
const ALL_MATERIALS = Array.from({ length: 255 }, (_, k) => k + 1);
/** A kit filling every slot, bound to every material: every case the derive gives draws its piece. */
const FULL = fullTestKit('all', ALL_MATERIALS, 1);
const TABLE = worldPieceTable([FULL], 0);
const OWN = kitPieceList(FULL, CAT).pieces;
type Cell = [number, number, number];

/** One instance read back: its world cell, case, yaw, placement and flags. */
interface Piece {
  readonly cell: Cell;
  readonly caseId: string;
  readonly yaw: number;
  readonly place: number;
  readonly flags: number;
  /** The variant's mirror bit (a verge rising toward its own −x). */
  readonly mirror: boolean;
  /** A damage piece's scatter index on its face (0 for any other). */
  readonly scatter: number;
}

/** The kit pieces of derived chunk (cx, cy, cz). */
function piecesOf(d: DerivedData, cx: number, cy: number, cz: number): Piece[] {
  const out: Piece[] = [];
  const b = d.instances.data;
  for (let k = 0; k < d.instances.count; k++) {
    const o = k * INSTANCE_BYTES;
    const piece = b[o + 4]! | (b[o + 5]! << 8);
    out.push({ cell: [cx * E + b[o]!, cy * E + b[o + 1]!, cz * E + b[o + 2]!], caseId: OWN[piece]!.caseId, yaw: b[o + 3]! & 3, place: instancePlaceOf(b[o + 3]!), flags: b[o + 3]! & 0xf0, mirror: (b[o + 7]! & 0x80) !== 0, scatter: instanceScatter(new DataView(b.buffer, b.byteOffset).getUint32(o + INSTANCE_DRESSING_OFFSET, true)) });
  }
  return out;
}

/** Every kit piece of the chunks touching the box [lo, hi) of world cells. */
function piecesIn(s: PaletteStore, lo: Cell, hi: Cell): Piece[] {
  const out: Piece[] = [];
  for (let cx = Math.floor(lo[0] / E); cx <= Math.floor((hi[0] - 1) / E); cx++) for (let cy = Math.floor(lo[1] / E); cy <= Math.floor((hi[1] - 1) / E); cy++) for (let cz = Math.floor(lo[2] / E); cz <= Math.floor((hi[2] - 1) / E); cz++) {
    out.push(...piecesOf(deriveFromStore(s, cx, cy, cz, RULES, undefined, TABLE), cx, cy, cz));
  }
  return out;
}

const v = { material: 0, role: 0, shape: 0, wetness: 0 };
/** Solid as the edge pass reads it, from the store: a role that is not open, filled to the surface (construction at any integrity). */
function solid(s: PaletteStore, x: number, y: number, z: number): boolean {
  s.voxelAt(x, y, z, v);
  if (v.material === 0 || v.role === R.air || v.role === R.opening || v.role === R.liquid) return false;
  return v.role === R.terrain ? v.shape >= 8 : v.shape > 0;
}

/** (case, yaw) → its slot and whether it is inner, for an owner cell (the edge pass's table read backwards). */
const SLOT_OF = new Map<string, { slot: number; inner: boolean }>();
for (let k = 0; k < PIECE_SLOTS; k++) for (const inner of [false, true]) SLOT_OF.set(`${EDGE_CASE_IDS[edgeCaseOf(k, inner)]}|${edgeYawOf(k, inner)}`, { slot: k, inner });

/** The cells round an edge or corner piece (its owner first). */
function cellsRound(p: Piece): Cell[] {
  const at = SLOT_OF.get(`${p.caseId}|${p.yaw}`)!;
  const slot = PIECE_SLOT_TABLE[at.slot]!;
  return [[0, 0, 0] as const, ...slot.faces, ...slot.rest].map((o) => [p.cell[0] + o[0], p.cell[1] + o[1], p.cell[2] + o[2]] as Cell);
}

/** A lattice edge's or corner's key: the doubled coordinates of its middle (unique whichever cell names it). */
function slotKey(p: Piece): string {
  const at = SLOT_OF.get(`${p.caseId}|${p.yaw}`)!;
  const side = PIECE_SLOT_TABLE[at.slot]!.side;
  return `${at.slot < EDGE_SLOTS ? 'e' : 'c'}${p.cell.map((c, a) => 2 * c + 1 + side[a]!).join(',')}`;
}

const isEdgePiece = (p: Piece): boolean => SLOT_OF.has(`${p.caseId}|${p.yaw}`) && p.place === INSTANCE_PLACE.upright && EDGE_CASE_IDS.includes(p.caseId as never);

/**
 * The corner rule, written out over the 8 cells round a lattice point (`at(o)`: octant o, bit 0 +x, 1 +y, 2 +z, is
 * solid): whether outer and inner edges meet there (`mixed`), and whether a corner piece goes there (`piece`: one or
 * seven solid, or mixed, with the solid cells' summed directions naming a solid anchor, an inner one's opposite open).
 */
function cornerRule(at: (o: number) => boolean): { mixed: boolean; piece: boolean } {
  const solid = [0, 1, 2, 3, 4, 5, 6, 7].filter(at);
  let outer = false;
  let inner = false;
  for (let a = 0; a < 3; a++) for (const side of [0, 1]) {
    const round = solid.filter((b) => ((b >> a) & 1) === side);
    if (round.length === 3) inner = true;
    if (round.length === 1 || (round.length === 2 && [0, 1, 2].filter((k) => k !== a && ((round[0]! ^ round[1]!) >> k) & 1).length === 2)) outer = true;
  }
  const mixed = outer && inner && solid.length !== 1 && solid.length !== 7;
  const sum = [0, 1, 2].map((a) => solid.reduce((t, b) => t + ((b >> a) & 1 ? 1 : -1), 0));
  if (!(mixed || solid.length === 1 || solid.length === 7) || sum.some((x) => x === 0)) return { mixed, piece: false };
  const o = (sum[0]! > 0 ? 1 : 0) | (sum[1]! > 0 ? 2 : 0) | (sum[2]! > 0 ? 4 : 0);
  return { mixed, piece: at(o) && (solid.length < 5 || !at(o ^ 7)) };
}

/**
 * Fails unless every edge piece's 4 cells are 1 or 3 solid (or 2 diagonal:
 * two outer edges, one a cell) and every corner piece's 8 cells 1 or 7 or
 * a mixed corner: never a piece on a flat face (2 side by side).
 */
function expectNoFlatFace(s: PaletteStore, pieces: readonly Piece[], what: string): number {
  let checked = 0;
  for (const p of pieces.filter(isEdgePiece)) {
    const cells = cellsRound(p);
    const n = cells.filter((c) => solid(s, ...c)).length;
    // An edge's cells are the owner, its two face neighbours and the diagonal (cellsRound's order).
    const diagonal = n === 2 && solid(s, ...cells[0]!) && solid(s, ...cells[3]!);
    let ok = cells.length === 4 ? n === 1 || n === 3 || diagonal : n === 1 || n === 7;
    if (cells.length === 8 && !ok) {
      const side = PIECE_SLOT_TABLE[SLOT_OF.get(`${p.caseId}|${p.yaw}`)!.slot]!.side;
      const point = p.cell.map((c, a) => c + (side[a]! > 0 ? 1 : 0));
      ok = cornerRule((o) => solid(s, point[0]! - 1 + (o & 1), point[1]! - 1 + ((o >> 1) & 1), point[2]! - 1 + ((o >> 2) & 1))).mixed;
    }
    expect(ok, `${what}: ${p.caseId} yaw ${p.yaw} at ${p.cell.join(',')}: ${n} of ${cells.length} solid`).toBe(true);
    checked++;
  }
  return checked;
}

/**
 * Every exposed lattice edge and corner of the construction in [lo, hi) by
 * brute force: 1 or 3 of its 4 cells solid (a corner by the corner rule, {@link cornerRule}), at least one a
 * construction cell, none terrain; listed twice for two solid diagonally
 * round an edge (one outer edge each).
 */
function exposedSlots(s: PaletteStore, lo: Cell, hi: Cell): string[] {
  const out: string[] = [];
  const built = (x: number, y: number, z: number): boolean => (s.voxelAt(x, y, z, v), v.material !== 0 && v.role !== R.terrain && v.role !== R.opening && v.role !== R.air && v.role !== R.liquid);
  const terrain = (x: number, y: number, z: number): boolean => (s.voxelAt(x, y, z, v), v.material !== 0 && v.role === R.terrain);
  for (let x = lo[0]; x <= hi[0]; x++) for (let y = lo[1]; y <= hi[1]; y++) for (let z = lo[2]; z <= hi[2]; z++) {
    // Lattice point (x, y, z) is the corner of cells x−1…x etc.; edges along each axis start at it.
    for (let axis = -1; axis < 3; axis++) {
      const cells: Cell[] = [];
      for (let a = 0; a < 2; a++) for (let b = 0; b < 2; b++) for (let c = 0; c < 2; c++) {
        const o = [a, b, c];
        // Along an edge's axis its cells start at the lattice point (offset 1 from x − 1).
        if (axis >= 0 && o[axis] === 0) continue;
        cells.push([x - 1 + a, y - 1 + b, z - 1 + c]);
      }
      const n = cells.filter((c) => solid(s, ...c)).length;
      // Two solid diagonally round an edge (cells 0 and 3, or 1 and 2, in this order) are two outer edges: two pieces.
      const diagonal = axis >= 0 && n === 2 && solid(s, ...cells[0]!) === solid(s, ...cells[3]!);
      const want = axis >= 0 ? n === 1 || n === 3 || diagonal : cornerRule((o) => solid(s, x - 1 + (o & 1), y - 1 + ((o >> 1) & 1), z - 1 + ((o >> 2) & 1))).piece;
      if (!want || !cells.some((c) => built(...c)) || cells.some((c) => terrain(...c))) continue;
      const mid = [2 * x, 2 * y, 2 * z];
      if (axis >= 0) mid[axis]! += 1;
      const key = `${axis >= 0 ? 'e' : 'c'}${mid.join(',')}`;
      out.push(key);
      if (diagonal) out.push(key);
    }
  }
  return out;
}

/** A closed box house floating clear of the ground: walls x 4…15, z 4…13, a floor at y 8 and a flat roof at y 14, a door and a window. */
function boxHouse(s: PaletteStore): { lo: Cell; hi: Cell } {
  const put = (x: number, y: number, z: number, role: number): void => putVoxel(s, x, y, z, MAT.stone, role);
  for (let x = 4; x < 16; x++) for (let z = 4; z < 14; z++) {
    put(x, 8, z, R.floor);
    put(x, 14, z, R.roof);
    for (let y = 9; y < 14; y++) if (x === 4 || x === 15 || z === 4 || z === 13) put(x, y, z, R.wall);
  }
  for (let x = 7; x < 9; x++) for (let y = 9; y < 12; y++) putVoxel(s, x, y, 4, 0, R.air);
  // The window has two wall cells under it: a one-cell sill on the floor's edge reads as a banister rail (the window rules).
  for (let x = 11; x < 13; x++) for (let y = 11; y < 13; y++) putVoxel(s, x, y, 13, 0, R.air);
  return { lo: [3, 7, 3], hi: [17, 16, 15] };
}

describe('pieces on edges only', () => {
  it('a box house, a long wall and a floor slab: no piece on a flat face, every exposed edge and corner exactly one piece, nothing else', () => {
    const s = createWorldStore(grid);
    const house = boxHouse(s);
    // A long wall (40 cells along x, 6 high, 1 thick) and a floor slab (12 × 9, 1 thick), apart and clear of the ground.
    for (let x = -20; x < 20; x++) for (let y = 20; y < 26; y++) putVoxel(s, x, y, 40, MAT.stone, R.wall);
    for (let x = 30; x < 42; x++) for (let z = 20; z < 29; z++) putVoxel(s, x, 4, z, MAT.plank, R.floor);
    const boxes: Array<[string, Cell, Cell]> = [['house', house.lo, house.hi], ['wall', [-21, 19, 39], [21, 27, 42]], ['floor', [29, 3, 19], [43, 6, 30]]];
    for (const [what, lo, hi] of boxes) {
      const pieces = piecesIn(s, lo, hi).filter((p) => p.cell.every((c, a) => c >= lo[a]! && c < hi[a]!));
      expect(expectNoFlatFace(s, pieces, what), what).toBeGreaterThan(20);
      expect(pieces.filter(isEdgePiece).map(slotKey).sort(), what).toEqual(exposedSlots(s, lo, hi).sort());
      // Only edge and corner pieces here: no roof planes, beams, banisters or damage.
      expect(pieces.every(isEdgePiece), what).toBe(true);
    }
    // The long wall's flat faces: 2 × 40 × 6 cells, none of whose middles takes a piece; its rim: top and bottom
    // edges of both faces (2 × 2 × 40), four vertical edges (4 × 6), the two end faces' top and bottom (4).
    const wall = piecesIn(s, [-21, 19, 39], [21, 27, 42]).filter(isEdgePiece);
    expect(wall.filter((p) => p.caseId.startsWith('edge-')).length).toBe(2 * 40 * 2 + 4 * 6 + 4);
    expect(wall.filter((p) => p.caseId.startsWith('corner-')).length).toBe(8);
    expect(wall.filter((p) => p.cell[0] > -19 && p.cell[0] < 18 && p.cell[1] > 20 && p.cell[1] < 25)).toEqual([]);
  });

  it('the town and random worlds: no piece on a flat face anywhere, one piece an edge', () => {
    const town = createWorldStore(grid);
    loadArea(townWorld({ footprint: 128 }).grids[0]!, town, 0, 0, 64, 64);
    const random = createWorldStore(grid);
    randomAssemblyWorld(random, 5, 24);
    dabDetailRoles(random, 5);
    for (const [what, s, lo, hi] of [['town', town, [0, 0, 0], [64, 32, 64]], ['random', random, [-24, -24, -24], [24, 24, 24]]] as const) {
      const pieces = piecesIn(s, lo as Cell, hi as Cell);
      expect(expectNoFlatFace(s, pieces, what), what).toBeGreaterThan(500);
      // One piece an edge or corner, two only where two cells meet diagonally across an edge.
      const keys = new Map<string, number>();
      for (const k of pieces.filter(isEdgePiece).map(slotKey)) keys.set(k, (keys.get(k) ?? 0) + 1);
      expect([...keys.values()].every((n) => n <= 2), what).toBe(true);
    }
  }, 60_000);

  it('a gable roof takes ridge, eave and verge pieces on its plane cells and no edge piece round them', () => {
    const s = createWorldStore(grid);
    // Gable walls x 4…12 (9 deep, odd: a ridge along the middle row) under a 45° stair roof along z 2…13.
    for (let x = 4; x <= 12; x++) for (let y = 4; y < 8; y++) for (const z of [3, 12]) putVoxel(s, x, y, z, MAT.stone, R.wall);
    for (let x = 3; x <= 13; x++) {
      const y = 8 + Math.min(x - 3, 13 - x);
      for (let z = 2; z <= 13; z++) putVoxel(s, x, y, z, MAT.roofTile, R.roof);
    }
    const pieces = piecesIn(s, [0, 0, 0], [16, 16, 16]);
    const roof = pieces.filter((p) => p.caseId.startsWith('roof-'));
    const count = (id: string): number => roof.filter((p) => p.caseId === id).length;
    expect([count('roof-ridge'), count('roof-eave'), count('roof-gable')].every((n) => n > 0)).toBe(true);
    expect(count('roof-hip') + count('roof-valley')).toBe(0);
    // The odd roof's ridge runs along the middle row's centre (placed centred), on every cell of the top row.
    const ridge = roof.filter((p) => p.caseId === 'roof-ridge');
    expect(ridge.map((p) => p.cell[2]).sort((a, b) => a - b)).toEqual(Array.from({ length: 12 }, (_, k) => 2 + k));
    expect(ridge.every((p) => p.place === INSTANCE_PLACE.centred && p.cell[0] === 8)).toBe(true);
    for (const p of roof) expect((s.voxelAt(...p.cell, v), v.role), `${p.caseId} at ${p.cell.join(',')}`).toBe(R.roof);
    // No edge piece is owned by, or lies round, a roof cell.
    expect(expectNoFlatFace(s, pieces, 'gable')).toBeGreaterThan(0);
    for (const p of pieces.filter(isEdgePiece)) for (const c of cellsRound(p)) expect((s.voxelAt(...c, v), v.role), `${p.caseId} at ${p.cell.join(',')}`).not.toBe(R.roof);
  });
});

describe('damage drawn by stage', () => {
  /** A wall 10 long, 6 high, 1 thick (x 2…11, y 2…7, z 8), its cell (6, 4, 8) at `shape` (0: dug to air). */
  function damagedWall(shape: number, material: number = MAT.stone): PaletteStore {
    const s = createWorldStore(grid);
    for (let x = 2; x < 12; x++) for (let y = 2; y < 8; y++) putVoxel(s, x, y, 8, material, R.wall);
    if (shape === 0) putVoxel(s, 6, 4, 8, 0, R.air);
    else s.setVoxel(6, 4, 8, { material, role: R.wall, shape, wetness: 0 });
    return s;
  }
  const D: Cell = [6, 4, 8];
  const at = (c: Cell): string => c.join(',');
  /** The four in-plane neighbours' faces toward D (the two in front and behind are air), by cell, yaw and placement. */
  const FACES = [`5,4,8|3|${INSTANCE_PLACE.upright}`, `7,4,8|1|${INSTANCE_PLACE.upright}`, `6,3,8|0|${INSTANCE_PLACE.faceUp}`, `6,5,8|0|${INSTANCE_PLACE.faceDown}`].sort();
  /** Every piece but damage pieces, by cell, case and yaw. */
  const rest = (list: Piece[]): string[] => list.filter((p) => !p.caseId.startsWith('damage-')).map((p) => `${at(p.cell)}|${p.caseId}|${p.yaw}`).sort();
  /** Every output a consumer but the drawing and light reads (collision, navigation, occupancy …). */
  const gameplay = (d: DerivedData, like: DerivedData): Uint8Array => encodeDerived({ ...d, base: like.base, instances: like.instances, light: like.light });
  const intact = deriveFromStore(damagedWall(SHAPE_FULL), 0, 0, 0, RULES, undefined, TABLE);

  it('stage 1 (integrity 11–14): the block is drawn with its edge pieces and its faces carry the crack overlay, stronger as integrity drops; no damage piece', () => {
    let last = 0;
    for (const shape of [14, 13, 12, 11]) {
      const d = deriveFromStore(damagedWall(shape), 0, 0, 0, RULES, undefined, TABLE);
      const cell = cellOutputs(d, ...D);
      expect(cell.baseFaces, `shape ${shape}`).toBe(2);
      expect(cell.crack, `shape ${shape}`).toBe(crackStrengthOf(null, valueOf({ material: MAT.stone, role: R.wall, shape, wetness: 0 })));
      expect(cell.crack, `shape ${shape}`).toBeGreaterThan(last);
      last = cell.crack;
      // Only the cracked cell's faces carry a strength: the wall's other faces none.
      expect(cellOutputs(d, 5, 4, 8).crack).toBe(0);
      const pieces = piecesOf(d, 0, 0, 0);
      expect(pieces.filter((p) => p.caseId.startsWith('damage-'))).toEqual([]);
      expect(rest(pieces)).toEqual(rest(piecesOf(intact, 0, 0, 0)));
      expect(gameplay(d, intact)).toEqual(encodeDerived(intact));
      // Light follows the integrity (the light tracer reads it); the intact neighbour stays covered.
      expect(cell.light, `shape ${shape}`).toBe(integrityCoverage(shape));
      expect(cellOutputs(d, 5, 4, 8).light).toBe(255);
    }
    expect(last).toBe(255);
  });

  it('a cracked cell at the wall\'s corner keeps its edge pieces: the same rim as intact', () => {
    const s = damagedWall(SHAPE_FULL);
    s.setVoxel(2, 7, 8, { material: MAT.stone, role: R.wall, shape: 12, wetness: 0 });
    const d = deriveFromStore(s, 0, 0, 0, RULES, undefined, TABLE);
    expect(rest(piecesOf(d, 0, 0, 0))).toEqual(rest(piecesOf(intact, 0, 0, 0)));
    expect(piecesOf(d, 0, 0, 0).filter((p) => at(p.cell) === '2,7,8').length).toBeGreaterThan(0);
    expect(cellOutputs(d, 2, 7, 8).crack).toBeGreaterThan(0);
  });

  it('stages 2 (6–10) and 3 (1–5): the block is not drawn, no edge piece round the hole, each neighbour face toward it carries its kit\'s stage slot, many then fewer pieces, each its own scatter index; collision and navigation whole', () => {
    for (const [shape, slot, count] of [[10, 'damage-stage-2', 6], [6, 'damage-stage-2', 6], [5, 'damage-stage-3', 3], [1, 'damage-stage-3', 3]] as const) {
      const d = deriveFromStore(damagedWall(shape), 0, 0, 0, RULES, undefined, TABLE);
      const cell = cellOutputs(d, ...D);
      expect(cell.baseFaces, `shape ${shape}`).toBe(0);
      expect(cell.pieces, `shape ${shape}`).toEqual([]);
      const pieces = piecesOf(d, 0, 0, 0);
      const dmg = pieces.filter((p) => p.caseId.startsWith('damage-'));
      expect(new Set(dmg.map((p) => p.caseId)), `shape ${shape}`).toEqual(new Set([slot]));
      // Each face: `count` pieces with scatter 0 … count − 1.
      const byFace = new Map<string, number[]>();
      for (const p of dmg) byFace.set(`${at(p.cell)}|${p.yaw}|${p.place}`, [...(byFace.get(`${at(p.cell)}|${p.yaw}|${p.place}`) ?? []), p.scatter]);
      expect([...byFace.keys()].sort(), `shape ${shape}`).toEqual(FACES);
      for (const list of byFace.values()) expect(list.sort((a, b) => a - b)).toEqual(Array.from({ length: count }, (_, k) => k));
      // No edge round the hole (it is no open air): the rim is the intact wall's.
      expect(rest(pieces), `shape ${shape}`).toEqual(rest(piecesOf(intact, 0, 0, 0)));
      // The neighbours' faces toward the hole are drawn.
      for (const c of [[5, 4, 8], [7, 4, 8], [6, 3, 8], [6, 5, 8]] as Cell[]) expect(cellOutputs(d, ...c).baseFaces, at(c)).toBe(3);
      expect(gameplay(d, intact), `shape ${shape}`).toEqual(encodeDerived(intact));
      expect(cell.collision).toBe('full');
      expect(cell.navBlocks).toBe(true);
      expect(cell.light, `shape ${shape}`).toBe(integrityCoverage(shape));
    }
  });

  it('a kit sets its own ranges, counts and fewer stages: the hole\'s kit decides the stage, the face\'s kit how many pieces', () => {
    const own = (id: string, materials: number[], damage: PieceKitSource['damage']): PieceKitSource => ({ ...fullTestKit(id, materials, 1), damage });
    // Kit "two": no crack stage, one hole stage over 1–14 with two pieces a face, no stage 3.
    const two = own('two', [MAT.stone], { stage1: null, stage2: { min: 1, max: 14, pieces: 2 }, stage3: null });
    // Kit "late": stages 1 and 2 only (stage 3 left out): integrity 1–5 draws intact.
    const late = own('late', [MAT.timber], { stage3: null });
    const table = worldPieceTable([two, late], 0);
    const count = (d: DerivedData): number => piecesOf(d, 0, 0, 0).filter((p) => p.caseId.startsWith('damage-')).length;
    for (const shape of [13, 7, 2]) {
      const d = deriveFromStore(damagedWall(shape), 0, 0, 0, RULES, undefined, table);
      expect([cellOutputs(d, ...D).baseFaces, cellOutputs(d, ...D).crack, count(d)], `two, shape ${shape}`).toEqual([0, 0, 4 * 2]);
    }
    const timber = (shape: number): DerivedData => deriveFromStore(damagedWall(shape, MAT.timber), 0, 0, 0, RULES, undefined, table);
    expect([cellOutputs(timber(12), ...D).crack > 0, count(timber(12))]).toEqual([true, 0]);
    expect(count(timber(8))).toBe(4 * 6);
    const left = timber(3);
    expect([cellOutputs(left, ...D).baseFaces, cellOutputs(left, ...D).crack, count(left)]).toEqual([2, 0, 0]);
    // A timber hole in a stone wall: timber's stages say 8 is stage 2; the stone faces carry stone's ("two") count.
    const mixed = damagedWall(SHAPE_FULL);
    mixed.setVoxel(6, 4, 8, { material: MAT.timber, role: R.wall, shape: 8, wetness: 0 });
    expect(count(deriveFromStore(mixed, 0, 0, 0, RULES, undefined, table))).toBe(4 * 2);
    // The stages ride in the table's bytes: another range is another table.
    expect(worldPieceTable([two, own('late', [MAT.timber], { stage3: { min: 1, max: 4 } })], 0).hash).not.toBe(table.hash);
  });

  it('broken to air: no damage pieces, the neighbours\' faces toward the hole are the ones the hole showed, and the hole\'s edges take pieces', () => {
    const hole = deriveFromStore(damagedWall(7), 0, 0, 0, RULES, undefined, TABLE);
    const air = deriveFromStore(damagedWall(0), 0, 0, 0, RULES, undefined, TABLE);
    const pieces = piecesOf(air, 0, 0, 0);
    expect(pieces.filter((p) => p.caseId.startsWith('damage-'))).toEqual([]);
    // The base surface is the same: a hole draws none of its faces and hides none of its neighbours'.
    expect(air.base).toEqual(hole.base);
    // The hole's rim: its four inner edges along z (one cell deep) on each face, as an opening has.
    const rim = pieces.filter((p) => cellsRound(p).some((c) => at(c) === at(D)));
    expect(rim.length).toBeGreaterThanOrEqual(8);
    expectNoFlatFace(damagedWall(0), pieces, 'hole');
  });

  it('a damaged cell buried in a mass stays a body: no hole, no faces or pieces inside the mass; only its light follows its integrity', () => {
    const mass = (shape: number): PaletteStore => {
      const s = createWorldStore(grid);
      for (let x = 2; x < 9; x++) for (let y = 2; y < 9; y++) for (let z = 2; z < 9; z++) putVoxel(s, x, y, z, MAT.stone, R.wall);
      s.setVoxel(5, 5, 5, { material: MAT.stone, role: R.wall, shape, wetness: 0 });
      return s;
    };
    const whole = deriveFromStore(mass(SHAPE_FULL), 0, 0, 0, RULES, undefined, TABLE);
    for (const shape of [12, 7]) {
      const d = deriveFromStore(mass(shape), 0, 0, 0, RULES, undefined, TABLE);
      expect(encodeDerived({ ...d, light: whole.light })).toEqual(encodeDerived(whole));
      expect(cellOutputs(d, 5, 5, 5).light).toBe(integrityCoverage(shape));
    }
  });

  it('shows at level 0 only: the level-1 and level-2 nodes over a damaged wall are the intact wall\'s', () => {
    for (const shape of [12, 8, 3]) {
      const damaged = new MipTree(damagedWall(shape));
      const whole = new MipTree(damagedWall(SHAPE_FULL));
      for (const level of [1, 2]) {
        const node = { level, nx: 0, ny: 0, nz: 0 };
        expect(encodeDerived(deriveMipNode(damaged, node, RULES, undefined, TABLE)), `shape ${shape} level ${level}`).toEqual(encodeDerived(deriveMipNode(whole, node, RULES, undefined, TABLE)));
      }
    }
  });

  it('gives the same pieces from a chunk\'s 16³ sections joined as from the whole chunk, damage and all, and keeps them under an edit outside the reach', () => {
    const s = damagedWall(7);
    s.setVoxel(9, 6, 8, { material: MAT.stone, role: R.wall, shape: 12, wetness: 0 });
    boxHouse(s);
    const whole = deriveFromStore(s, 0, 0, 0, RULES, undefined, TABLE);
    const key = (p: Piece): string => `${at(p.cell)}|${p.caseId}|${p.yaw}|${p.place}|${p.scatter}`;
    const chunkPieces = piecesOf(whole, 0, 0, 0).map(key).sort();
    const pad = jobRadius(RULES);
    const sections = deriveSectionsWithApron(grid, RULES, buildApron(s, 0, 0, 0, pad), (out) => s.exportChunk(0, 0, 0, out), 16, [0, 1, 2, 3, 4, 5, 6, 7], 0, { table: TABLE, chunk: [0, 0, 0] });
    const joined = sections.flatMap((r) => {
      const [ox, oy, oz] = [(r.id >> 2) & 1, r.id & 1, (r.id >> 1) & 1].map((b) => b * 16) as Cell;
      return piecesOf(r.assembly!, 0, 0, 0).map((p) => key({ ...p, cell: [p.cell[0] + ox, p.cell[1] + oy, p.cell[2] + oz] }));
    });
    expect(joined.sort()).toEqual(chunkPieces);
    // An edit past the job's reach (a block at the chunk's far corner) moves no piece and no variant.
    putVoxel(s, 30, 30, 30, MAT.stone, R.wall);
    const after = deriveFromStore(s, 0, 0, 0, RULES, undefined, TABLE);
    const far = (d: DerivedData): Uint8Array => {
      const keep: number[] = [];
      for (let k = 0; k < d.instances.count; k++) if (d.instances.data[k * INSTANCE_BYTES]! < 30 - pad - 1) keep.push(...d.instances.data.subarray(k * INSTANCE_BYTES, (k + 1) * INSTANCE_BYTES));
      return Uint8Array.from(keep);
    };
    expect(far(after)).toEqual(far(whole));
  });
});

/** A chunk view (stand-in surface and renderer) drawing `kits`' pieces from `meshes`. */
function kitView(meshes: VoxelKitMeshes, kits: readonly VoxelKitRecordLike[]): { view: VoxelChunkView; table: ReturnType<typeof worldPieceTable> } {
  const surface = createVoxelSurface({ cellMetres: VOXEL_SIZE_M, side: shaderGridSide(grid.edge), border: SHADER_BORDER_CELLS, materialBits: MATERIAL_BITS, wetnessMax: WETNESS_MAX, readDepthCells: SHADER_READ_DEPTH_CELLS }, { look: voxelStandInLook, blendMetres: 0.25 });
  const renderer = { backend: { isWebGLBackend: true, get: () => ({}), copyTextureToTexture: () => undefined }, initTexture: () => undefined, copyTextureToTexture: () => undefined };
  const table = worldPieceTable(kits, 0);
  return { view: new VoxelChunkView({ grid, origin: new FloatingOrigin({ grid, rebaseDistanceM: 512, origin: { x: 0, y: 0, z: 0 } }), surface, renderer, kits: meshes.set(table, kits) }), table };
}

/**
 * Roof-edge pieces of the log kit drawn through the real chunk view over hand roofs at `slope` (1: 45°, ½: 1:2,
 * the same meshes pitched): every vertex near the planes, both verges of a gable dressed (one mirrored).
 */
async function roofPiecesFollowThePlanes(slope: number): Promise<void> {
  {
    const s = createWorldStore(grid);
    // Hand roofs, each cell's height b + the smallest distance to a low edge (at 1:2 half of it, rounded down); the
    // top planes over them in world cells are b + 1 + that distance (times the slope) measured to the outer faces.
    const roofs = [
      { x0: 19, x1: 29, z0: 2, z1: 13, b: 8, hip: false },
      { x0: 2, x1: 13, z0: 2, z1: 12, b: 16, hip: false },
      { x0: 2, x1: 13, z0: 18, z1: 29, b: 4, hip: true },
      // An odd hip (13 × 11): its ridge ends at the apex cells' middles, where the hips meet it.
      { x0: 17, x1: 29, z0: 17, z1: 27, b: 4, hip: true },
    ];
    for (const r of roofs) for (let x = r.x0; x <= r.x1; x++) for (let z = r.z0; z <= r.z1; z++) {
      const d = Math.min(x - r.x0, r.x1 - x, ...(r.hip ? [z - r.z0, r.z1 - z] : []));
      putVoxel(s, x, r.b + Math.floor(d * slope), z, MAT.roofTile, R.roof);
    }
    const top = (x: number, z: number): number => {
      for (const r of roofs) {
        // Which roof a vertex is over: the log kit's barge log stands proud of the gable face by its radius and more.
        if (x < r.x0 - 0.4 || x > r.x1 + 1.4 || z < r.z0 - 0.4 || z > r.z1 + 1.4) continue;
        const cx = Math.max(r.x0, Math.min(r.x1 + 1, x));
        const cz = Math.max(r.z0, Math.min(r.z1 + 1, z));
        return r.b + 1 + slope * Math.min(cx - r.x0, r.x1 + 1 - cx, ...(r.hip ? [cz - r.z0, r.z1 + 1 - cz] : []));
      }
      throw new Error(`no roof at ${x}, ${z}`);
    };
    // The log placeholder kit's roof slots (its GLB through the renderer's loader port), bound to the roof tiles, its
    // jitter as authored: the pieces move into the roof, never off its planes past the bound.
    const log = JSON.parse(readFileSync(join(import.meta.dirname, 'kits', 'log.voxelkit.json'), 'utf8')) as VoxelKitRecordLike;
    // Without its trim layout: the draws then hold the slot meshes' own geometries (a trim kit's are run-flagged copies).
    const kit: VoxelKitRecordLike = { voxelKitId: log.voxelKitId, materials: [MAT.roofTile], slots: Object.fromEntries(Object.entries(log.slots).filter(([id]) => id.startsWith('roof-'))) };
    const meshes = new VoxelKitMeshes();
    const glb = new Uint8Array(readFileSync(join(import.meta.dirname, 'kits', 'voxel-kit-log.glb')));
    expect((await meshes.load([kit], async () => ({ bytes: glb, version: 1 }), createGltfLoaderPort())).failed).toEqual([]);
    const { view, table } = kitView(meshes, [kit]);
    const d = deriveFromStore(s, 0, 0, 0, RULES, undefined, table);
    const j = joinSectionsForDraw(grid.edge, grid.edge, [d], view.cells);
    view.set(0, 0, 0, { ground: j.ground, base: j.base, instances: j.instances, solid: j.solid });
    view.root.updateMatrixWorld(true);
    const draws = view.root.children.flatMap((g) => g.children.filter((c): c is THREE.InstancedMesh => c instanceof THREE.InstancedMesh && c.userData['voxelKitPiece'] === true));
    // Each roof slot's mesh, plain and mirrored: which draw is which.
    const kinds: { caseId: RoofEdgeCaseId; mirror: boolean; g: THREE.BufferGeometry }[] = [];
    for (const caseId of ['roof-ridge', 'roof-gable', 'roof-hip'] as const) for (const mirror of [false, true]) kinds.push({ caseId, mirror, g: meshes.mesh(kit.slots[caseId]!.meshes[0]!.mesh, mirror) as THREE.BufferGeometry });
    // Every slope-following mesh lies on its case's planes in its own orientation; the mirrored verge does not (it rises toward −x).
    for (const k of kinds) if (!k.mirror) expect(roofCaseOffset(k.caseId, k.g.getAttribute('position').array), k.caseId).toBeLessThan(ROOF_EDGE_NEAR_M);
    expect(roofCaseOffset('roof-gable', kinds.find((k) => k.caseId === 'roof-gable' && k.mirror)!.g.getAttribute('position').array)).toBeGreaterThan(0.4);
    const m4 = new THREE.Matrix4();
    const p = new THREE.Vector3();
    const seen = new Map<string, number>();
    let worst = 0;
    for (const mesh of draws) {
      const k = kinds.find((q) => q.g === mesh.geometry);
      if (k === undefined) continue;
      const pos = mesh.geometry.getAttribute('position');
      for (let i = 0; i < mesh.count; i++) {
        mesh.getMatrixAt(i, m4);
        m4.premultiply(mesh.matrixWorld);
        for (let v = 0; v < pos.count; v++) {
          p.fromBufferAttribute(pos, v).applyMatrix4(m4).divideScalar(VOXEL_SIZE_M);
          const off = Math.abs(p.y - top(p.x, p.z)) * VOXEL_SIZE_M;
          worst = Math.max(worst, off);
          expect(off, `${k.caseId}${k.mirror ? ' (mirrored)' : ''} vertex at ${p.toArray().map((c) => c.toFixed(2)).join(', ')}`).toBeLessThan(ROOF_EDGE_NEAR_M);
        }
      }
      seen.set(`${k.caseId}${k.mirror ? '*' : ''}`, (seen.get(`${k.caseId}${k.mirror ? '*' : ''}`) ?? 0) + mesh.count);
    }
    // Both verges of every gable end are dressed, one mirrored; ridges (centred and on a side) and hips are drawn.
    expect(seen.get('roof-gable')).toBe(seen.get('roof-gable*'));
    expect(seen.get('roof-gable')).toBeGreaterThan(8);
    expect(seen.get('roof-ridge')).toBeGreaterThan(20);
    expect(seen.get('roof-hip')).toBeGreaterThan(8);
    expect(seen.has('roof-ridge*') || seen.has('roof-hip*')).toBe(false);
    console.log(`[roof edges ${slope === 1 ? '45°' : '1:2'}] ${[...seen].map(([id, n]) => `${id} ${n}`).join(', ')}; worst offset from the planes ${(worst * 100).toFixed(1)} cm`);
    view.dispose();
    meshes.dispose();
  }
}

describe('kit pieces drawn through the real chunk view', () => {
  it('roof-edge pieces follow the planes on both sides of a gable and up a hip: verges mirrored on one side, ridges, hips and verges on the planes as drawn (jittered into the roof), an odd hip\'s ridge and hips stopping at its apex', async () => {
    await roofPiecesFollowThePlanes(1);
  });

  it('the same roof-edge meshes pitched onto 1:2 roofs follow their planes: one mesh a slot serves both slopes', async () => {
    await roofPiecesFollowThePlanes(0.5);
  });

  it('a box house, a gable house and a damaged wall: one instanced draw a (piece, level), instances by family, one mesh filling three slots on one geometry, every instance staggered within bounds, damage pieces spread over their faces', () => {
    const s = createWorldStore(grid);
    boxHouse(s);
    // A gable house beside it (x 20…28, z 2…13) and a damaged wall (x 2…11, y 20…25, z 26: a crack at 12, holes at 8 and 3).
    for (let x = 20; x <= 28; x++) for (let y = 4; y < 8; y++) for (const z of [3, 12]) putVoxel(s, x, y, z, MAT.stone, R.wall);
    for (let x = 19; x <= 29; x++) for (let z = 2; z <= 13; z++) putVoxel(s, x, 8 + Math.min(x - 19, 29 - x), z, MAT.roofTile, R.roof);
    for (let x = 2; x < 12; x++) for (let y = 20; y < 26; y++) putVoxel(s, x, y, 26, MAT.stone, R.wall);
    s.setVoxel(9, 21, 26, { material: MAT.stone, role: R.wall, shape: 12, wetness: 0 });
    s.setVoxel(5, 22, 26, { material: MAT.stone, role: R.wall, shape: 8, wetness: 0 });
    s.setVoxel(8, 24, 26, { material: MAT.stone, role: R.wall, shape: 3, wetness: 0 });
    // A kit of boxes, one a slot, but one strip filling the three outer edge slots turned (top, vertical, bottom).
    const D = 'a'.repeat(64);
    const strip = { assetId: 'strip', digest: D };
    const turned: Record<string, number> = { 'edge-out-top': 0, 'edge-out-vertical': CUBE_ROTATION_ZM90, 'edge-out-bottom': CUBE_ROTATION_X90 };
    const kit: VoxelKitRecordLike = {
      voxelKitId: 'boxes',
      materials: ALL_MATERIALS,
      slots: Object.fromEntries(CAT.cases.map((c) => [c.id, { meshes: [{ mesh: turned[c.id] !== undefined ? strip : { assetId: c.id, digest: D }, rotation: turned[c.id] ?? 0 }] }])),
    };
    const meshes = new VoxelKitMeshes();
    meshes.add(strip, new THREE.BoxGeometry(VOXEL_SIZE_M, 0.06, 0.06).translate(0, VOXEL_SIZE_M / 2, VOXEL_SIZE_M / 2));
    for (const c of CAT.cases) meshes.add({ assetId: c.id, digest: D }, new THREE.BoxGeometry(0.1, 0.1, 0.1));
    const { view, table } = kitView(meshes, [kit]);
    const d = deriveFromStore(s, 0, 0, 0, RULES, undefined, table);
    const j = joinSectionsForDraw(grid.edge, grid.edge, [d], view.cells);
    view.set(0, 0, 0, { ground: j.ground, base: j.base, instances: j.instances, solid: j.solid });
    const draws = view.root.children.flatMap((g) => g.children.filter((c): c is THREE.InstancedMesh => c instanceof THREE.InstancedMesh && c.userData['voxelKitPiece'] === true));
    // Instances by case from the derive, and what the view drew of them: every kit instance, one draw a piece kind.
    const byCase = new Map<string, number>();
    const pieces = piecesOf(d, 0, 0, 0);
    for (const p of pieces) byCase.set(p.caseId, (byCase.get(p.caseId) ?? 0) + 1);
    const total = [...byCase.values()].reduce((a, b) => a + b, 0);
    expect(draws.reduce((n, m) => n + m.count, 0)).toBe(total);
    expect(view.piecesDrawn.kit).toBe(total);
    // One draw a piece kind, a mirrored one (the gable's second verge) its own.
    const kinds = new Set(pieces.map((p) => `${p.caseId}${p.mirror ? '*' : ''}`));
    expect(kinds.has('roof-gable*')).toBe(true);
    expect(draws.length).toBe(kinds.size);
    const family = (id: string): string => (id.startsWith('edge-') || id.startsWith('corner-') ? 'edge' : id.startsWith('roof-') ? 'roof' : id.startsWith('damage-') ? 'damage' : 'other');
    const families = new Map<string, number>();
    for (const [id, n] of byCase) families.set(family(id), (families.get(family(id)) ?? 0) + n);
    for (const f of ['edge', 'roof', 'damage']) expect(families.get(f), f).toBeGreaterThan(0);
    // Each hole's four in-plane neighbour faces: 6 pieces at stage 2, 3 at stage 3 (the crack at 12 none).
    expect(byCase.get('damage-stage-2')).toBe(4 * 6);
    expect(byCase.get('damage-stage-3')).toBe(4 * 3);
    // The three outer edge slots draw with the one strip geometry, turned.
    const stripGeometry = meshes.mesh(strip, false);
    const onStrip = draws.filter((m) => m.geometry === stripGeometry);
    expect(onStrip.length).toBe(['edge-out-top', 'edge-out-vertical', 'edge-out-bottom'].filter((id) => byCase.has(id)).length);
    expect(onStrip.length).toBeGreaterThanOrEqual(2);
    // Every staggered instance moved into its solid within bounds; a roof board sits exactly on its cell's grid.
    const m4 = new THREE.Matrix4();
    const CUBE_QUATS = CUBE_ROTATIONS.map((r) => new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().set(r[0], r[1], r[2], 0, r[3], r[4], r[5], 0, r[6], r[7], r[8], 0, 0, 0, 0, 1)));
    let staggered = 0;
    const damageGeometries = new Set(['damage-stage-2', 'damage-stage-3'].map((id) => meshes.mesh({ assetId: id, digest: D }, false)));
    for (const mesh of draws) {
      if (damageGeometries.has(mesh.geometry as THREE.BufferGeometry)) {
        // Spread over the face toward the hole and spun about its normal: every piece its own place, within the face.
        const at = new Set<string>();
        const p = new THREE.Vector3();
        for (let k = 0; k < mesh.count; k++) {
          mesh.getMatrixAt(k, m4);
          expect(m4.determinant()).toBeCloseTo(1, 5);
          p.setFromMatrixPosition(m4);
          at.add(p.toArray().map((x) => x.toFixed(4)).join(','));
          const cell = p.clone().divideScalar(VOXEL_SIZE_M).floor();
          const centre = cell.clone().addScalar(0.5).multiplyScalar(VOXEL_SIZE_M);
          // On the intact cell's side: within the face's reach (0.3 cell each way) plus the stagger, of its centre.
          expect(p.distanceTo(centre) / VOXEL_SIZE_M).toBeLessThanOrEqual(DAMAGE_SCATTER_REACH * Math.SQRT2 + PIECE_STAGGER.inwardMax * 4 + 1e-6);
        }
        expect(at.size).toBe(mesh.count);
        continue;
      }
      for (let k = 0; k < mesh.count; k++) {
        mesh.getMatrixAt(k, m4);
        expect(m4.determinant()).toBeCloseTo(1, 5);
        const q = new THREE.Quaternion().setFromRotationMatrix(m4);
        // Unstaggered, every instance's rotation is one of the cube's 24 (turns, tips, slot rotations): the nearest is within the twist.
        const nearest = Math.min(...CUBE_QUATS.map((c) => q.angleTo(c)));
        expect(nearest).toBeLessThanOrEqual(PIECE_STAGGER.twistMax + 1e-6);
        if (nearest > 1e-6) staggered++;
      }
    }
    expect(staggered).toBeGreaterThan(families.get('edge')! / 2);
    console.log(`[box kit] house + gable + damaged wall: ${total} instances in ${draws.length} draws (${[...byCase].map(([id, n]) => `${id} ${n}`).join(', ')})`);
    view.dispose();
    meshes.dispose();
  });
});
