/**
 * Detail pieces stand only where faces meet, through the real derive with
 * the world's rule set and the engine's default kit (every material no kit
 * binds draws it; it has a piece for every edge, corner, roof-edge and
 * debris case): on a closed box house with a door and a window, a long
 * wall, a floor slab, a gable roof, the town and random worlds.
 *
 * - **No piece on a flat face**: every edge piece's 4 cells round its edge
 *   are 1 or 3 solid, every corner piece's 8 cells 1 or 7, read straight from
 *   the store (not from the edge pass).
 * - **One owner an edge**: every exposed edge and corner of construction
 *   (found by brute force over the lattice) has exactly one piece, and no
 *   piece sits anywhere else.
 * - **Default pieces out of the solid**: every default piece's vertex,
 *   placed as the renderer places it (alias rotation, turns, tip, centring),
 *   lies in its own cell or in open air.
 * - **Roofs** take roof-edge pieces only; **damage** draws debris on the
 *   damaged cell and a debris face on each intact face toward it, nothing
 *   else changes for collision, light or navigation, and at air the
 *   neighbours' plain faces and the hole's edges are back.
 */
import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { createVoxelSurface, VoxelChunkView, VoxelKitMeshes, voxelStandInLook } from '@thirdlight/three-adapter';
import {
  applyFold,
  buildApron,
  chunkGrid,
  createWorldStore,
  applyCubeRotation,
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
  DEFAULT_KIT_PIECES,
  defaultKitMesh,
  defaultKitSource,
  deriveFromStore,
  deriveSectionsWithApron,
  EDGE_CASE_IDS,
  EDGE_SLOTS,
  edgeCaseOf,
  edgeYawOf,
  encodeDerived,
  INSTANCE_BYTES,
  INSTANCE_FLAG,
  INSTANCE_PLACE,
  instancePlaceOf,
  jobRadius,
  KIT_PIECE_BASE,
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
import { MAT } from './world-kit';
import { ROOF_EDGE_NEAR_M, roofCaseOffset, type RoofEdgeCaseId } from './roof-edge-surface';

const grid = chunkGrid(32);
const E = grid.edge;
const R = VOXEL_ROLE;
const RULES = WORLD_RULES;
const CAT = RULES.catalogue!;
const TABLE = worldPieceTable([]);
const OWN = kitPieceList(defaultKitSource(CAT), CAT).pieces;
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
}

/** The kit pieces of derived chunk (cx, cy, cz) (default stand-ins of beams and banisters left out). */
function piecesOf(d: DerivedData, cx: number, cy: number, cz: number): Piece[] {
  const out: Piece[] = [];
  const b = d.instances.data;
  for (let k = 0; k < d.instances.count; k++) {
    const o = k * INSTANCE_BYTES;
    const piece = b[o + 4]! | (b[o + 5]! << 8);
    if (piece < KIT_PIECE_BASE) continue;
    out.push({ cell: [cx * E + b[o]!, cy * E + b[o + 1]!, cz * E + b[o + 2]!], caseId: OWN[piece - KIT_PIECE_BASE]!.caseId, yaw: b[o + 3]! & 3, place: instancePlaceOf(b[o + 3]!), flags: b[o + 3]! & 0xf0, mirror: (b[o + 7]! & 0x80) !== 0 });
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
 * Fails unless every edge piece's 4 cells are 1 or 3 solid (or 2 diagonal:
 * two outer edges, one a cell) and every corner piece's 8 cells 1 or 7:
 * never a piece on a flat face (2 side by side).
 */
function expectNoFlatFace(s: PaletteStore, pieces: readonly Piece[], what: string): number {
  let checked = 0;
  for (const p of pieces.filter(isEdgePiece)) {
    const cells = cellsRound(p);
    const n = cells.filter((c) => solid(s, ...c)).length;
    // An edge's cells are the owner, its two face neighbours and the diagonal (cellsRound's order).
    const diagonal = n === 2 && solid(s, ...cells[0]!) && solid(s, ...cells[3]!);
    const ok = cells.length === 4 ? n === 1 || n === 3 || diagonal : n === 1 || n === 7;
    expect(ok, `${what}: ${p.caseId} yaw ${p.yaw} at ${p.cell.join(',')}: ${n} of ${cells.length} solid`).toBe(true);
    checked++;
  }
  return checked;
}

/**
 * Every exposed lattice edge and corner of the construction in [lo, hi) by
 * brute force: 1 or 3 of its 4 cells solid (1 or 7 of 8), at least one a
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
      const want = axis >= 0 ? n === 1 || n === 3 || diagonal : n === 1 || n === 7;
      if (!want || !cells.some((c) => built(...c)) || cells.some((c) => terrain(...c))) continue;
      // The default kit leaves inner corners to the coves meeting there (no piece of its own: none drawn).
      if (axis < 0 && n === 7 && DEFAULT_KIT_PIECES['corner-in-top'] === null) continue;
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

  it("places every default piece's vertices as the renderer does (alias rotation, tip, centring, turns) in its own cell or open air, never in a solid neighbour", () => {
    const s = createWorldStore(grid);
    boxHouse(s);
    // A piece's vertices in cells about its cell's centre, in its case's orientation (an alias: its target's turned).
    const vertices = (caseId: string): [number, number, number][] => {
      const p = DEFAULT_KIT_PIECES[caseId]!;
      const d = defaultKitMesh(p.alias?.case ?? caseId, false)!;
      const out: [number, number, number][] = [];
      for (let i = 0; i < d.positions.length; i += 3) {
        const v: [number, number, number] = [d.positions[i]! / VOXEL_SIZE_M, d.positions[i + 1]! / VOXEL_SIZE_M, d.positions[i + 2]! / VOXEL_SIZE_M];
        out.push(p.alias === undefined ? v : applyCubeRotation(p.alias.rotation, v));
      }
      // A hair toward the piece's middle: a vertex on a face reads as the cell it faces, not the one behind it.
      const mid = [0, 1, 2].map((a) => out.reduce((n, v) => n + v[a]!, 0) / out.length);
      return out.map((v) => v.map((c, a) => c + (mid[a]! - c) * 0.02) as [number, number, number]);
    };
    let points = 0;
    for (const p of piecesIn(s, [3, 7, 3], [17, 16, 15])) {
      for (const v of vertices(p.caseId)) {
        let q = v;
        if (p.place === INSTANCE_PLACE.faceUp) q = [q[0], q[2], -q[1]];
        if (p.place === INSTANCE_PLACE.faceDown) q = [q[0], -q[2], q[1]];
        if (p.place === INSTANCE_PLACE.centred) q = [q[0], q[1] - 0.5, q[2] - 0.5];
        const w = applyFold(p.yaw, q).map((c, a) => Math.floor(p.cell[a]! + 0.5 + c)) as Cell;
        points++;
        if (w.every((c, a) => c === p.cell[a])) continue;
        expect(solid(s, ...w), `${p.caseId} yaw ${p.yaw} at ${p.cell.join(',')} reaches into ${w.join(',')}`).toBe(false);
      }
    }
    expect(points).toBeGreaterThan(1000);
  });

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

describe('damage drawn as debris', () => {
  /** A wall 10 long, 6 high, 1 thick (x 2…11, y 2…7, z 8), its cell (6, 4, 8) at `shape` (0: dug to air). */
  function damagedWall(shape: number): PaletteStore {
    const s = createWorldStore(grid);
    for (let x = 2; x < 12; x++) for (let y = 2; y < 8; y++) putVoxel(s, x, y, 8, MAT.stone, R.wall);
    if (shape === 0) putVoxel(s, 6, 4, 8, 0, R.air);
    else s.setVoxel(6, 4, 8, { material: MAT.stone, role: R.wall, shape, wetness: 0 });
    return s;
  }
  const D: Cell = [6, 4, 8];

  it('a damaged wall cell: one debris piece of its stage on it, a debris face on each intact face toward it, its edges undressed; collision, light, navigation and occupancy as intact', () => {
    const intact = deriveFromStore(damagedWall(SHAPE_FULL), 0, 0, 0, RULES, undefined, TABLE);
    for (const [shape, stage] of [[12, 'debris'], [7, 'debris-heavy'], [1, 'debris-heavy']] as const) {
      const d = deriveFromStore(damagedWall(shape), 0, 0, 0, RULES, undefined, TABLE);
      const pieces = piecesOf(d, 0, 0, 0);
      const on = pieces.filter((p) => p.cell.join(',') === D.join(','));
      expect(on.map((p) => p.caseId), `shape ${shape}`).toEqual([stage]);
      expect(on[0]!.flags & INSTANCE_FLAG.replacesBase).not.toBe(0);
      // The wall's four neighbours in its plane face the hole (the two in front and behind are air).
      const faces = pieces.filter((p) => p.caseId === 'debris-face');
      expect(faces.map((p) => `${p.cell.join(',')}|${p.yaw}|${p.place}`).sort(), `shape ${shape}`).toEqual(
        [`5,4,8|3|${INSTANCE_PLACE.upright}`, `7,4,8|1|${INSTANCE_PLACE.upright}`, `6,3,8|0|${INSTANCE_PLACE.faceUp}`, `6,5,8|0|${INSTANCE_PLACE.faceDown}`].sort(),
      );
      // Every other piece is the intact wall's (its rim): no edge round the damaged cell, none new.
      const rest = (list: Piece[]): string[] => list.filter((p) => !p.caseId.startsWith('debris')).map((p) => `${p.cell.join(',')}|${p.caseId}|${p.yaw}`).sort();
      expect(rest(pieces)).toEqual(rest(piecesOf(intact, 0, 0, 0)));
      // The block stays whole for every consumer but the drawing.
      expect(encodeDerived({ ...d, base: intact.base, instances: intact.instances })).toEqual(encodeDerived(intact));
      expect(d.base).not.toEqual(intact.base);
    }
  });

  it('broken to air: the debris goes, the neighbours\' faces toward the hole are the ones the debris showed, and the hole\'s edges take pieces', () => {
    const debris = deriveFromStore(damagedWall(7), 0, 0, 0, RULES, undefined, TABLE);
    const air = deriveFromStore(damagedWall(0), 0, 0, 0, RULES, undefined, TABLE);
    const pieces = piecesOf(air, 0, 0, 0);
    expect(pieces.filter((p) => p.caseId.startsWith('debris'))).toEqual([]);
    // The base surface is the same: a debris cell draws none of its faces and hides none of its neighbours'.
    expect(air.base).toEqual(debris.base);
    // The hole's rim: its four inner edges along z (one cell deep) on each face, as an opening has.
    const rim = pieces.filter((p) => cellsRound(p).some((c) => c.join(',') === D.join(',')));
    expect(rim.length).toBeGreaterThanOrEqual(8);
    expectNoFlatFace(damagedWall(0), pieces, 'hole');
  });

  it('a damaged cell buried in a mass stays a body: no debris, no faces or pieces inside the mass', () => {
    const mass = (shape: number): PaletteStore => {
      const s = createWorldStore(grid);
      for (let x = 2; x < 9; x++) for (let y = 2; y < 9; y++) for (let z = 2; z < 9; z++) putVoxel(s, x, y, z, MAT.stone, R.wall);
      s.setVoxel(5, 5, 5, { material: MAT.stone, role: R.wall, shape, wetness: 0 });
      return s;
    };
    expect(encodeDerived(deriveFromStore(mass(7), 0, 0, 0, RULES, undefined, TABLE))).toEqual(encodeDerived(deriveFromStore(mass(SHAPE_FULL), 0, 0, 0, RULES, undefined, TABLE)));
  });

  it('gives the same pieces from a chunk\'s 16³ sections joined as from the whole chunk, damage and all, and keeps them under an edit outside the reach', () => {
    const s = damagedWall(7);
    boxHouse(s);
    const whole = deriveFromStore(s, 0, 0, 0, RULES, undefined, TABLE);
    const key = (p: Piece): string => `${p.cell.join(',')}|${p.caseId}|${p.yaw}|${p.place}`;
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

describe('the default kit drawn through the real chunk view', () => {
  it('roof-edge pieces follow the planes on both sides of a gable and up a hip: verges mirrored on one side, ridges, hips and verges on the planes as drawn, an odd hip\'s ridge and hips stopping at its apex', () => {
    const s = createWorldStore(grid);
    // Hand roofs, each cell's height b + the smallest distance to a low edge (45° everywhere); the top planes over
    // them in world cells are b + 1 + that distance measured to the roof's outer faces.
    const roofs = [
      { x0: 19, x1: 29, z0: 2, z1: 13, b: 8, hip: false },
      { x0: 2, x1: 13, z0: 2, z1: 12, b: 16, hip: false },
      { x0: 2, x1: 13, z0: 18, z1: 29, b: 4, hip: true },
      // An odd hip (13 × 11): its ridge ends at the apex cells' middles, where the hips meet it.
      { x0: 17, x1: 29, z0: 17, z1: 27, b: 4, hip: true },
    ];
    for (const r of roofs) for (let x = r.x0; x <= r.x1; x++) for (let z = r.z0; z <= r.z1; z++) {
      const d = Math.min(x - r.x0, r.x1 - x, ...(r.hip ? [z - r.z0, r.z1 - z] : []));
      putVoxel(s, x, r.b + d, z, MAT.roofTile, R.roof);
    }
    const top = (x: number, z: number): number => {
      for (const r of roofs) {
        if (x < r.x0 - 0.2 || x > r.x1 + 1.2 || z < r.z0 - 0.2 || z > r.z1 + 1.2) continue;
        const cx = Math.max(r.x0, Math.min(r.x1 + 1, x));
        const cz = Math.max(r.z0, Math.min(r.z1 + 1, z));
        return r.b + 1 + Math.min(cx - r.x0, r.x1 + 1 - cx, ...(r.hip ? [cz - r.z0, r.z1 + 1 - cz] : []));
      }
      throw new Error(`no roof at ${x}, ${z}`);
    };
    const surface = createVoxelSurface({ cellMetres: VOXEL_SIZE_M, side: shaderGridSide(grid.edge), border: SHADER_BORDER_CELLS, materialBits: MATERIAL_BITS, wetnessMax: WETNESS_MAX, readDepthCells: SHADER_READ_DEPTH_CELLS }, { look: voxelStandInLook, blendMetres: 0.25 });
    const renderer = { backend: { isWebGLBackend: true, get: () => ({}), copyTextureToTexture: () => undefined }, initTexture: () => undefined, copyTextureToTexture: () => undefined };
    const meshes = new VoxelKitMeshes();
    const view = new VoxelChunkView({ grid, origin: new FloatingOrigin({ grid, rebaseDistanceM: 512, origin: { x: 0, y: 0, z: 0 } }), surface, renderer, kits: meshes.world([]) });
    const d = deriveFromStore(s, 0, 0, 0, RULES, undefined, TABLE);
    const j = joinSectionsForDraw(grid.edge, grid.edge, [d], view.cells);
    view.set(0, 0, 0, { ground: j.ground, base: j.base, instances: j.instances, solid: j.solid });
    view.root.updateMatrixWorld(true);
    const draws = view.root.children.flatMap((g) => g.children.filter((c): c is THREE.InstancedMesh => c instanceof THREE.InstancedMesh && c.userData['voxelKitPiece'] === true));
    // Each roof case's own mesh, plain and mirrored: which draw is which.
    const kinds: { caseId: RoofEdgeCaseId; mirror: boolean; g: THREE.BufferGeometry }[] = [];
    for (const caseId of ['roof-ridge', 'roof-gable', 'roof-hip'] as const) for (const mirror of [false, true]) kinds.push({ caseId, mirror, g: meshes.defaultMesh(caseId, false, mirror)! });
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
    console.log(`[roof edges] ${[...seen].map(([id, n]) => `${id} ${n}`).join(', ')}; worst offset from the planes ${(worst * 100).toFixed(1)} cm`);
    view.dispose();
    meshes.dispose();
  });

  it('a banister on a slab: every post runs up to the rail over it, so the rail rests on the posts (stand-ins drawn by the chunk view)', () => {
    const s = createWorldStore(grid);
    // A plank slab (x 2…11, y 4, z 2…5), posts on its front row every other cell (y 5), a rail along them (y 6).
    for (let x = 2; x <= 11; x++) for (let z = 2; z <= 5; z++) putVoxel(s, x, 4, z, MAT.plank, R.wall);
    for (let x = 2; x <= 11; x += 2) putVoxel(s, x, 5, 5, MAT.timber, R.wall);
    for (let x = 2; x <= 11; x++) putVoxel(s, x, 6, 5, MAT.timber, R.wall);
    const surface = createVoxelSurface({ cellMetres: VOXEL_SIZE_M, side: shaderGridSide(grid.edge), border: SHADER_BORDER_CELLS, materialBits: MATERIAL_BITS, wetnessMax: WETNESS_MAX, readDepthCells: SHADER_READ_DEPTH_CELLS }, { look: voxelStandInLook, blendMetres: 0.25 });
    const renderer = { backend: { isWebGLBackend: true, get: () => ({}), copyTextureToTexture: () => undefined }, initTexture: () => undefined, copyTextureToTexture: () => undefined };
    const meshes = new VoxelKitMeshes();
    const view = new VoxelChunkView({ grid, origin: new FloatingOrigin({ grid, rebaseDistanceM: 512, origin: { x: 0, y: 0, z: 0 } }), surface, renderer, kits: meshes.world([]) });
    const d = deriveFromStore(s, 0, 0, 0, RULES, undefined, TABLE);
    const j = joinSectionsForDraw(grid.edge, grid.edge, [d], view.cells);
    view.set(0, 0, 0, { ground: j.ground, base: j.base, instances: j.instances, solid: j.solid });
    view.root.updateMatrixWorld(true);
    // World boxes (cells) of the stand-in draws' instances: posts are the tall ones, rails the long ones.
    const boxes = (pick: (size: THREE.Vector3) => boolean): THREE.Box3[] => {
      const out: THREE.Box3[] = [];
      const m4 = new THREE.Matrix4();
      for (const g of view.root.children) for (const c of g.children) {
        if (!(c instanceof THREE.InstancedMesh) || c.userData['voxelKitPiece'] !== false) continue;
        c.geometry.computeBoundingBox();
        if (!pick(c.geometry.boundingBox!.getSize(new THREE.Vector3()))) continue;
        for (let i = 0; i < c.count; i++) {
          c.getMatrixAt(i, m4);
          const b = c.geometry.boundingBox!.clone().applyMatrix4(m4.premultiply(c.matrixWorld));
          out.push(new THREE.Box3(b.min.divideScalar(VOXEL_SIZE_M), b.max.divideScalar(VOXEL_SIZE_M)));
        }
      }
      return out;
    };
    const posts = boxes((v) => v.y > v.x && v.y > v.z);
    const rails = boxes((v) => v.x > v.y || v.z > v.y);
    expect(posts).toHaveLength(5);
    expect(rails.length).toBeGreaterThanOrEqual(5);
    for (const p of posts) {
      // From the slab's top, up into the rail's cell, ending within the rail over it.
      expect(p.min.y).toBeCloseTo(5, 3);
      const over = rails.filter((r) => r.min.x < p.max.x && r.max.x > p.min.x && r.min.z < p.max.z && r.max.z > p.min.z);
      expect(over.length, `rail over the post at ${p.min.x.toFixed(2)}`).toBeGreaterThan(0);
      expect(over.some((r) => p.max.y >= r.min.y - 1e-6 && p.max.y <= r.max.y + 1e-6), `post top ${p.max.y.toFixed(3)} within the rail ${over.map((r) => `${r.min.y.toFixed(3)}…${r.max.y.toFixed(3)}`).join(', ')}`).toBe(true);
    }
    view.dispose();
    meshes.dispose();
  });

  it('a box house, a gable house and a damaged wall: one instanced draw a (piece, level), instances by family, aliases on their target\'s geometry, every instance staggered within bounds', () => {
    const s = createWorldStore(grid);
    boxHouse(s);
    // A gable house beside it (x 20…28, z 2…13) and a damaged wall (x 2…11, y 20…25, z 26: one cell at 12, one at 5).
    for (let x = 20; x <= 28; x++) for (let y = 4; y < 8; y++) for (const z of [3, 12]) putVoxel(s, x, y, z, MAT.stone, R.wall);
    for (let x = 19; x <= 29; x++) for (let z = 2; z <= 13; z++) putVoxel(s, x, 8 + Math.min(x - 19, 29 - x), z, MAT.roofTile, R.roof);
    for (let x = 2; x < 12; x++) for (let y = 20; y < 26; y++) putVoxel(s, x, y, 26, MAT.stone, R.wall);
    s.setVoxel(5, 22, 26, { material: MAT.stone, role: R.wall, shape: 12, wetness: 0 });
    s.setVoxel(8, 23, 26, { material: MAT.stone, role: R.wall, shape: 5, wetness: 0 });
    const surface = createVoxelSurface({ cellMetres: VOXEL_SIZE_M, side: shaderGridSide(grid.edge), border: SHADER_BORDER_CELLS, materialBits: MATERIAL_BITS, wetnessMax: WETNESS_MAX, readDepthCells: SHADER_READ_DEPTH_CELLS }, { look: voxelStandInLook, blendMetres: 0.25 });
    const renderer = { backend: { isWebGLBackend: true, get: () => ({}), copyTextureToTexture: () => undefined }, initTexture: () => undefined, copyTextureToTexture: () => undefined };
    const meshes = new VoxelKitMeshes();
    const set = meshes.world([]);
    const view = new VoxelChunkView({ grid, origin: new FloatingOrigin({ grid, rebaseDistanceM: 512, origin: { x: 0, y: 0, z: 0 } }), surface, renderer, kits: set });
    const d = deriveFromStore(s, 0, 0, 0, RULES, undefined, TABLE);
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
    const kinds = new Set(pieces.filter((p) => DEFAULT_KIT_PIECES[p.caseId] !== null).map((p) => `${p.caseId}${p.mirror ? '*' : ''}`));
    expect(kinds.has('roof-gable*')).toBe(true);
    expect(draws.length).toBe(kinds.size);
    const family = (id: string): string => (id.startsWith('edge-') || id.startsWith('corner-') ? 'edge' : id.startsWith('roof-') ? 'roof' : id.startsWith('debris') ? 'debris' : 'other');
    const families = new Map<string, number>();
    for (const [id, n] of byCase) families.set(family(id), (families.get(family(id)) ?? 0) + n);
    for (const f of ['edge', 'roof', 'debris']) expect(families.get(f), f).toBeGreaterThan(0);
    expect(byCase.get('debris')).toBe(1);
    expect(byCase.get('debris-heavy')).toBe(1);
    // Aliased cases draw with their target's geometry: the outer strip serves top, vertical and bottom edges.
    const strip = meshes.defaultMesh('edge-out-top', false);
    const onStrip = draws.filter((m) => m.geometry === strip);
    expect(onStrip.length).toBe(['edge-out-top', 'edge-out-vertical', 'edge-out-bottom'].filter((id) => byCase.has(id)).length);
    expect(onStrip.length).toBeGreaterThanOrEqual(2);
    // Every staggered instance moved into its solid within bounds; a roof board sits exactly on its cell's grid.
    const m4 = new THREE.Matrix4();
    const CUBE_QUATS = CUBE_ROTATIONS.map((r) => new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().set(r[0], r[1], r[2], 0, r[3], r[4], r[5], 0, r[6], r[7], r[8], 0, 0, 0, 0, 1)));
    let staggered = 0;
    for (const mesh of draws) {
      for (let k = 0; k < mesh.count; k++) {
        mesh.getMatrixAt(k, m4);
        expect(m4.determinant()).toBeCloseTo(1, 5);
        const q = new THREE.Quaternion().setFromRotationMatrix(m4);
        // Unstaggered, every instance's rotation is one of the cube's 24 (turns, tips, aliases): the nearest is within the twist.
        const nearest = Math.min(...CUBE_QUATS.map((c) => q.angleTo(c)));
        expect(nearest).toBeLessThanOrEqual(PIECE_STAGGER.twistMax + 1e-6);
        if (nearest > 1e-6) staggered++;
      }
    }
    expect(staggered).toBeGreaterThan(families.get('edge')! / 2);
    console.log(`[default kit] house + gable + damaged wall: ${total} instances in ${draws.length} draws (${[...byCase].map(([id, n]) => `${id} ${n}`).join(', ')})`);
    view.dispose();
    meshes.dispose();
  });
});
