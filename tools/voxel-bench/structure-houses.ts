/**
 * Structure records of the bench's houses and test buildings, for the
 * building generator's tests and measurements: the town's house pattern as
 * a definition, a two-storey L-house, and its pieces through the real
 * derive.
 */
import {
  BUILDING_GENERATOR,
  boxChunks,
  canonicalStructureDefinition,
  chunkGrid,
  createDenseChunk,
  createWorldStore,
  deriveFromStore,
  INSTANCE_BYTES,
  kitPieceList,
  VOXEL_ROLE,
  WORLD_RULES,
  worldPieceTable,
  type ChunkGrid,
  type StructureDefinition,
  type StructureOpening,
  type VoxelRecord,
  type VoxelStoreCandidate,
} from '@thirdlight/voxel';
import { fullTestKit } from './test-kits';
import { houseVoxel, STOREY, type House } from './town';
import { MAT } from './world-kit';

const R = VOXEL_ROLE;
const FULL = fullTestKit('all', Array.from({ length: 255 }, (_, k) => k + 1), 1);
/** A piece table with a kit filling every slot of the world rules' catalogue, bound to every material. */
export const FULL_TABLE = worldPieceTable([FULL], 0);
const OWN = kitPieceList(FULL, WORLD_RULES.catalogue!).pieces;
/** The world rules' case ids. */
export const CASE_IDS: ReadonlySet<string> = new Set(WORLD_RULES.catalogue!.cases.map((c) => c.id));

/**
 * The structure record of a bench house: its footprint, storeys, the
 * pattern's materials, foundation in the ground floor's row only, a 45°
 * gable along x with a cell of overhang, the stairs up the x = 1, 2 strip,
 * and its doors and windows read off the pattern's opening cells, edge by
 * edge and storey by storey.
 */
export function benchHouseDefinition(h: House): StructureDefinition {
  const { w, d } = h;
  const edges: ((j: number) => [number, number])[] = [(j) => [j, 0], (j) => [w - 1, j], (j) => [w - 1 - j, d - 1], (j) => [0, d - 1 - j]];
  const lens = [w, d, w, d];
  const v: VoxelRecord = { material: 0, role: 0, shape: 0, wetness: 0 };
  const openings: StructureOpening[] = [];
  for (let s = 0; s < h.storeys; s++) edges.forEach((cell, e) => {
    let run: { at: number; rows: string } | null = null;
    const close = (end: number): void => {
      if (run === null || run.rows === '') return;
      const rows = run.rows.split(',').map(Number);
      openings.push({ id: `o${openings.length}`, polygon: 'main', edge: e, storey: s, at: run.at, width: end - run.at, height: rows.length, sill: rows[0]! - 1 });
    };
    for (let j = 0; j <= lens[e]!; j++) {
      const rows: number[] = [];
      if (j < lens[e]!) {
        const [x, z] = cell(j);
        for (let lev = 1; lev < STOREY; lev++) if (houseVoxel(h, x, s * STOREY + lev, z, v) && v.role === R.opening) rows.push(lev);
      }
      const key = rows.join(',');
      if (run !== null && run.rows !== key) {
        close(j);
        run = null;
      }
      if (run === null) run = { at: j, rows: key };
    }
  });
  const stairs = Array.from({ length: h.storeys - 1 }, (_, s) => ({ id: `s${s}`, polygon: 'main', from: s, at: [1, 2] as [number, number], facing: '+z' as const }));
  return canonicalStructureDefinition({
    footprint: [{ id: 'main', points: [[0, 0], [w, 0], [w, d], [0, d]] }],
    storeys: h.storeys,
    storeyHeight: STOREY,
    foundationDepth: 0,
    roof: { shape: 'gable', overhang: 1, axis: 'x' },
    materials: { wall: h.wall, floor: MAT.plank, roof: MAT.roofTile, foundation: MAT.stone, stair: MAT.plank },
    openings,
    stairs,
    generator: 1,
  });
}

/** A structure's grid as a store: its definition generated a chunk at a time. */
export function generateStructure(d: StructureDefinition, grid: ChunkGrid = chunkGrid(32)): VoxelStoreCandidate {
  const s = createWorldStore(grid);
  const out = createDenseChunk(grid);
  for (const c of boxChunks(grid, BUILDING_GENERATOR.box(d))) if (BUILDING_GENERATOR.chunk(d, grid, c.cx, c.cy, c.cz, out)) s.importChunk(c.cx, c.cy, c.cz, out);
  return s;
}

/** A two-storey L-house (12 × 8 m and a 5 × 6 m wing), hip roof, a door, windows and a stair. */
export function lHouse(shape: 'gable' | 'hip' = 'hip'): StructureDefinition {
  return canonicalStructureDefinition({
    footprint: [{ id: 'main', points: [[0, 0], [24, 0], [24, 16], [0, 16]] }, { id: 'wing', points: [[0, 16], [10, 16], [10, 28], [0, 28]] }],
    storeys: 2,
    storeyHeight: STOREY,
    foundationDepth: 2,
    roof: { shape, overhang: 1, axis: 'x' },
    materials: { wall: MAT.plaster, floor: MAT.plank, roof: MAT.roofTile, foundation: MAT.stone, stair: MAT.plank },
    openings: [
      { id: 'door', polygon: 'main', edge: 0, storey: 0, at: 11, width: 2, height: 4, sill: 0 },
      { id: 'w1', polygon: 'main', edge: 0, storey: 1, at: 4, width: 2, height: 2, sill: 1 },
      { id: 'w2', polygon: 'main', edge: 1, storey: 0, at: 6, width: 2, height: 2, sill: 1 },
      { id: 'w3', polygon: 'wing', edge: 2, storey: 1, at: 3, width: 3, height: 2, sill: 1 },
    ],
    stairs: [{ id: 's', polygon: 'main', from: 0, at: [20, 3], facing: '+z' }],
    generator: 1,
  });
}

/** The L-house's kit pieces through the real derive (world rules, a full kit on every material), by case. */
export function lHousePieces(d: StructureDefinition = lHouse()): { total: number; unknown: number; byCase: Record<string, number>; chunks: number } {
  const grid = chunkGrid(32);
  const s = generateStructure(d, grid);
  const byCase: Record<string, number> = {};
  let total = 0;
  let unknown = 0;
  let chunks = 0;
  for (const c of boxChunks(grid, BUILDING_GENERATOR.box(d))) {
    const dd = deriveFromStore(s, c.cx, c.cy, c.cz, WORLD_RULES, undefined, FULL_TABLE);
    chunks++;
    const b = dd.instances.data;
    for (let k = 0; k < dd.instances.count; k++) {
      const piece = b[k * INSTANCE_BYTES + 4]! | (b[k * INSTANCE_BYTES + 5]! << 8);
      const id = OWN[piece]?.caseId;
      total++;
      if (id === undefined || !CASE_IDS.has(id)) {
        unknown++;
        continue;
      }
      byCase[id] = (byCase[id] ?? 0) + 1;
    }
  }
  return { total, unknown, byCase, chunks };
}
