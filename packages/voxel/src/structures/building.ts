/**
 * The building generator: a definition's voxels, a chunk at a time.
 *
 * What it writes, every cell a full construction voxel (integrity 15, dry)
 * of its part's material and role:
 * - **foundation**: the union's columns from the ground floor's row (0) down
 *   `foundationDepth` rows (the ground floor's own slab is foundation, as
 *   the kits read a building's base);
 * - **walls**: the union's outline one cell thick from row 1 to under the
 *   roof (see building-roof.ts for how they meet it);
 * - **floors**: each upper storey's slab (row s · storeyHeight) inside the
 *   walls, open over the stairs that climb to it;
 * - **openings** (role `opening`, the wall's material): their cells of the
 *   wall, which a door or window prop fills;
 * - **stairs**: steps of one cell rise a cell run, two cells wide;
 * - **roof**: one cell thick over the union widened by the overhang.
 * Nothing else: the building leaves the ground alone, and beams, rails and
 * edge pieces come from the kits reading the arrangement.
 */
import { chunkOrigin, WORLD_CELL_MAX_XZ, WORLD_CELL_MAX_Y, WORLD_CELL_MIN_XZ, WORLD_CELL_MIN_Y, type ChunkGrid } from '../coords';
import { clearDenseChunk, type DenseChunk } from '../dense-chunk';
import { recordValue, SHAPE_FULL, valueMaterial, valueRole, VOXEL_ROLE } from '../record';
import type { CellBox } from '../stroke';
import { parseStructureDefinition, StructureDefinitionError, translateDefinition, type StructureDefinition } from './definition';
import type { StructureGenerator } from './generator';
import { NO_ROOF, planGrid, type BuildingPlan } from './building-plan';
import { openingRows, stairRows } from './building-features';
import { roofRows } from './building-roof';

/**
 * The building generator's version: moves by one whenever what it writes
 * for any definition changes, so every structure an older engine wrote is
 * regenerated once (one undoable regenerate-all step).
 */
export const BUILDING_GENERATOR_VERSION = 1;

const plans = new WeakMap<StructureDefinition, BuildingPlan>();

function compile(def: StructureDefinition): BuildingPlan {
  const g = planGrid(def, def.roof.overhang);
  const h = def.storeyHeight;
  const top = def.storeys * h;
  const { roofY, wallTop, eaves } = roofRows(def, g, top);
  const openings = openingRows(def, g);
  const { steps, holes } = stairRows(def, g);
  let minX = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxZ = -Infinity;
  let maxY = top - 1;
  for (let ix = 0; ix < g.w; ix++) for (let iz = 0; iz < g.d; iz++) {
    const y = roofY[ix * g.d + iz]!;
    if (y === NO_ROOF) continue;
    minX = Math.min(minX, g.x0 + ix);
    maxX = Math.max(maxX, g.x0 + ix);
    minZ = Math.min(minZ, g.z0 + iz);
    maxZ = Math.max(maxZ, g.z0 + iz);
    maxY = Math.max(maxY, y);
  }
  const box: CellBox = { minX, minY: -def.foundationDepth, minZ, maxX, maxY, maxZ };
  if (box.minX < WORLD_CELL_MIN_XZ || box.minZ < WORLD_CELL_MIN_XZ || box.maxX > WORLD_CELL_MAX_XZ || box.maxZ > WORLD_CELL_MAX_XZ) throw new StructureDefinitionError('/footprint', `the building with its roof reaches cells ${box.minX}…${box.maxX} × ${box.minZ}…${box.maxZ}, past the grid's ±32,768`);
  if (box.minY < WORLD_CELL_MIN_Y || box.maxY > WORLD_CELL_MAX_Y) throw new StructureDefinitionError('/storeys', `the building reaches rows ${box.minY}…${box.maxY}, past the grid's ${WORLD_CELL_MIN_Y}…${WORLD_CELL_MAX_Y}`);
  return { def, x0: g.x0, z0: g.z0, w: g.w, d: g.d, storeyHeight: h, top, foundationDepth: def.foundationDepth, inside: g.inside, wall: g.wall, polygons: g.polygons, roofY, wallTop, eaves, openings, steps, holes, box };
}

/** The plan of a definition (laid out once a definition object). */
export function buildingPlan(def: StructureDefinition): BuildingPlan {
  let p = plans.get(def);
  if (p === undefined) plans.set(def, (p = compile(def)));
  return p;
}

/**
 * A definition checked and rebuilt field by field (StructureDefinitionError
 * names the field and what to change): its fields, each polygon's outline,
 * every opening on an outside wall of its storey, every stair inside its
 * polygon below the top storey, nothing over anything else, and a
 * generator version this build knows.
 */
export function canonicalStructureDefinition(input: unknown): StructureDefinition {
  const def = parseStructureDefinition(input);
  if (def.generator > BUILDING_GENERATOR_VERSION) throw new StructureDefinitionError('/generator', `written by building generator ${def.generator}; this build has ${BUILDING_GENERATOR_VERSION}: open it with a newer engine`);
  buildingPlan(def);
  return def;
}

/**
 * Where a new structure's definition starts (the anchor): moved by whole
 * cells so its grid's cell (0, 0) on x and z is the minimum corner of all it
 * writes (eaves and overhang included), so a building under 256 m is one
 * region file. Applied when a structure is made, never by a regenerate.
 */
export function anchoredDefinition(def: StructureDefinition): StructureDefinition {
  const b = buildingPlan(def).box;
  return b.minX === 0 && b.minZ === 0 ? def : translateDefinition(def, -b.minX, -b.minZ);
}

function cellValue(material: number, role: number): number {
  return recordValue(material, role, SHAPE_FULL, 0);
}

function within(rows: readonly number[] | undefined, y: number): boolean {
  if (rows === undefined) return false;
  for (let r = 0; r < rows.length; r += 2) if (y >= rows[r]! && y <= rows[r + 1]!) return true;
  return false;
}

/** Writes chunk (cx, cy, cz) of a building's grid into `out` (every cell); whether any cell is not air. */
export function buildingChunk(def: StructureDefinition, grid: ChunkGrid, cx: number, cy: number, cz: number, out: DenseChunk): boolean {
  const p = buildingPlan(def);
  const e = grid.edge;
  const x0 = chunkOrigin(grid, cx);
  const y0 = chunkOrigin(grid, cy);
  const z0 = chunkOrigin(grid, cz);
  const b = p.box;
  clearDenseChunk(out);
  if (x0 > b.maxX || x0 + e <= b.minX || y0 > b.maxY || y0 + e <= b.minY || z0 > b.maxZ || z0 + e <= b.minZ) return false;
  const m = def.materials;
  const FOUND = cellValue(m.foundation, VOXEL_ROLE.foundation);
  const WALL = cellValue(m.wall, VOXEL_ROLE.wall);
  const OPEN = cellValue(m.wall, VOXEL_ROLE.opening);
  const FLOOR = cellValue(m.floor, VOXEL_ROLE.floor);
  const STAIR = cellValue(m.stair, VOXEL_ROLE.stair);
  const ROOF = cellValue(m.roof, VOXEL_ROLE.roof);
  const { top, storeyHeight: h, foundationDepth: fd } = p;
  let any = false;
  for (let lx = 0; lx < e; lx++) {
    const ix = x0 + lx - p.x0;
    if (ix < 0 || ix >= p.w) continue;
    for (let lz = 0; lz < e; lz++) {
      const iz = z0 + lz - p.z0;
      if (iz < 0 || iz >= p.d) continue;
      const col = ix * p.d + iz;
      const inside = p.inside[col] === 1;
      const ry = p.roofY[col]!;
      if (!inside && ry === NO_ROOF) continue;
      const low = p.eaves.get(col);
      const wall = p.wall[col] === 1;
      const wt = p.wallTop[col]!;
      const ops = p.openings.get(col);
      const steps = p.steps.get(col);
      const holes = p.holes.get(col);
      const base = (lx * e + lz) * e;
      for (let ly = 0; ly < e; ly++) {
        const y = y0 + ly;
        let v = 0;
        if (y === ry) v = ROOF;
        else if (!inside) {
          if (low === undefined || !low.includes(y)) continue;
          v = ROOF;
        }
        else if (y <= 0) v = y >= -fd ? FOUND : 0;
        else if (y < top) {
          if (wall) v = within(ops, y) ? OPEN : WALL;
          else if (y % h === 0) v = holes?.includes(y) ? 0 : FLOOR;
          else if (steps?.includes(y)) v = STAIR;
        } else if (wall && y <= wt) v = WALL;
        if (v === 0) continue;
        const i = base + ly;
        out.material[i] = valueMaterial(v);
        out.role[i] = valueRole(v);
        out.shape[i] = SHAPE_FULL;
        any = true;
      }
    }
  }
  return any;
}

/** The building generator on the structures' contract. */
export const BUILDING_GENERATOR: StructureGenerator<StructureDefinition> = Object.freeze({
  kind: 'building',
  version: BUILDING_GENERATOR_VERSION,
  canonical: canonicalStructureDefinition,
  box: (def: StructureDefinition): CellBox => ({ ...buildingPlan(def).box }),
  chunk: buildingChunk,
});
