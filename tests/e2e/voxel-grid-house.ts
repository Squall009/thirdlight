/**
 * A small stone house as a structure object, for voxel-world.e2e.ts's Play and Export tests: its definition (a
 * `voxelStructure` component the backend writes into its own grid of the world, the grid and the anchor given by the
 * backend) and its porch, a hand edit on the grid kept as the structure's overrides. Where it stands is its object's
 * transform: Play and the export read it from the project, never from a page switch.
 *
 * Walls one cell thick round a 6 × 5 m room, 3 m tall, on a slab one cell thick over its footprint, of the test kit's
 * stone (its free ends draw the kit's magenta boards); a door 1.5 m wide and 2.5 m tall in its front wall (opening
 * cells: a portal, which a character walks through); a flat roof one cell thick on the walls, so the room is a room
 * for the world's regions and its light once the grid is stamped into the world grid. Before the door, a porch slab
 * 3 m deep (so a character stands on the grid's own cells, whatever the hill under it does).
 *
 * The grid's cells: the front wall at z = 0 (`porch`), the room to z = d − 1, the porch at z −porchLen … −1.
 */
import { GridFrame, VOXEL_ROLE, VOXEL_SIZE_M, type GridPlacement, type PaletteStore } from '@thirdlight/voxel';

/** Cells: the room's footprint (x, z), the front wall's z, the porch's depth before it, the walls' height over the slab, the door's cells along x and its height. */
export const GRID_HOUSE = { w: 12, d: 10, porch: 0, porchLen: 6, h: 6, doorX: [5, 7], doorH: 5 } as const;

/** Grid metres: the door wall's outer face (z), the door's middle (x), the back wall's inner face (z), the slab's top (y), the room's middle, a point on the porch open to the sky (z). */
export const GRID_HOUSE_M = {
  room: [(GRID_HOUSE.w * VOXEL_SIZE_M) / 2, VOXEL_SIZE_M + (GRID_HOUSE.h * VOXEL_SIZE_M) / 2, (GRID_HOUSE.porch + GRID_HOUSE.d / 2) * VOXEL_SIZE_M] as const,
  doorWallZ: GRID_HOUSE.porch * VOXEL_SIZE_M,
  doorX: ((GRID_HOUSE.doorX[0] + GRID_HOUSE.doorX[1] + 1) / 2) * VOXEL_SIZE_M,
  backWallZ: (GRID_HOUSE.porch + GRID_HOUSE.d - 1) * VOXEL_SIZE_M,
  slabTop: VOXEL_SIZE_M,
  porchLight: GRID_HOUSE.porch * VOXEL_SIZE_M - 1.5,
} as const;

/** The house's definition (a `voxelStructure` value but its grid) of voxel material `material`, in world `world`. */
export function gridHouseStructure(world: string, material: number): Record<string, unknown> {
  const { w, d, h, doorX, doorH } = GRID_HOUSE;
  return {
    world,
    footprint: [{ id: 'room', points: [[0, 0], [w, 0], [w, d], [0, d]] }],
    storeys: 1,
    // The walls rows 1 … h, the flat roof on them (row h + 1).
    storeyHeight: h + 1,
    foundationDepth: 0,
    roof: { shape: 'flat', overhang: 0, axis: 'x' },
    materials: { wall: material, floor: material, roof: material, foundation: material, stair: material },
    openings: [{ id: 'door', polygon: 'room', edge: 0, storey: 0, at: doorX[0], width: doorX[1] - doorX[0] + 1, height: doorH, sill: 0 }],
    stairs: [],
  };
}

/** The porch: one `set` stroke of the house's grid (`gridId`), floor cells at the slab's row before the door wall. */
export function gridHousePorch(gridId: number, material: number): Record<string, unknown> {
  const cells: number[] = [];
  for (let x = 0; x < GRID_HOUSE.w; x++) for (let z = GRID_HOUSE.porch - GRID_HOUSE.porchLen; z < GRID_HOUSE.porch; z++) cells.push(x, 0, z);
  return { v: 2, grid: gridId, kind: 'set', cells, voxel: { material, role: VOXEL_ROLE.floor, shape: 15, wetness: 0 } };
}

/** The top of the highest solid cell (metres) over a square of `radius` metres round (x, z) metres in `store`. */
export function siteTop(store: PaletteStore, x: number, z: number, radius: number): number {
  const r = { material: 0, role: 0, shape: 0, wetness: 0 };
  let top = -Infinity;
  const c = (m: number): number => Math.floor(m / VOXEL_SIZE_M);
  for (let cx = c(x - radius); cx <= c(x + radius); cx++) for (let cz = c(z - radius); cz <= c(z + radius); cz++) {
    for (let cy = 400; cy > -200; cy--) {
      store.voxelAt(cx, cy, cz, r);
      if (r.material !== 0) {
        top = Math.max(top, (cy + 1) * VOXEL_SIZE_M);
        break;
      }
    }
  }
  return top;
}

/**
 * The house turned by `yawDeg` about its footprint's middle (porch included), that middle at `centre` (world
 * metres; y the slab's underside): its placement, its frame (where its walls and door are in the world) and the
 * rotation its object carries (a turn about the vertical axis).
 */
export function gridHousePlacement(gridId: number, centre: readonly [number, number, number], yawDeg: number): { place: GridPlacement; frame: GridFrame; rotation: [number, number, number, number] } {
  const yawRad = (yawDeg * Math.PI) / 180;
  const mid = [(GRID_HOUSE.w * VOXEL_SIZE_M) / 2, 0, ((2 * GRID_HOUSE.porch - GRID_HOUSE.porchLen + GRID_HOUSE.d) * VOXEL_SIZE_M) / 2] as const;
  // The grid's cell 0 so that its footprint's middle lands on `centre`: centre − R(yaw)·mid.
  const turned = new GridFrame({ gridId, position: [0, 0, 0], yawRad }).toWorld(mid[0], mid[1], mid[2]);
  const place: GridPlacement = { gridId, position: [centre[0] - turned[0], centre[1], centre[2] - turned[2]], yawRad };
  const q = new GridFrame(place).quaternion();
  return { place, frame: new GridFrame(place), rotation: [q.x, q.y, q.z, q.w] };
}
