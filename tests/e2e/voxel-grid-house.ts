/**
 * A small stone house in a structure grid of its own, for voxel-world.e2e.ts's Play test: written into a world
 * folder as a grid's region files (`grid-<id>/`) and listed in the world's manifest (format 3). Its cell (0, 0, 0)
 * is the minimum corner of its footprint at its floor (the anchor rule), so it is one region file. Where it stands
 * is not stored: the test passes its placement to Play (`?voxelGrids=`).
 *
 * A floor slab one cell thick over its footprint and a porch before its door (so a character stands on the grid's
 * own cells, whatever the hill under it does), walls one cell thick round a 6 × 5 m room, 3 m tall, of the test
 * kit's stone (its free ends draw the kit's magenta boards), a door 1.5 m wide and 2.5 m tall in the wall the porch
 * faces (opening cells: a portal, which a character walks through), and a flat roof one cell thick on the walls, so
 * the room is a room for the world's regions and its light once the grid is stamped into the world grid.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { chunkGrid, createWorldStore, GridFrame, VOXEL_ROLE, VOXEL_SIZE_M, type GridPlacement, type PaletteStore } from '@thirdlight/voxel';
import { hexToBytes } from '@thirdlight/shared';
import { RegionWorld } from '@thirdlight/workspace';

/** Cells: the room's footprint (x, z), the porch before it (z), the walls' height over the slab, the door's cells along x and its height. */
export const GRID_HOUSE = { w: 12, d: 10, porch: 6, h: 6, doorX: [5, 7], doorH: 5 } as const;

/** Grid metres: the door wall's outer face (z), the door's middle (x), the back wall's inner face (z), the slab's top (y), the room's middle. */
export const GRID_HOUSE_M = {
  room: [(GRID_HOUSE.w * VOXEL_SIZE_M) / 2, VOXEL_SIZE_M + (GRID_HOUSE.h * VOXEL_SIZE_M) / 2, (GRID_HOUSE.porch + GRID_HOUSE.d / 2) * VOXEL_SIZE_M] as const,
  doorWallZ: GRID_HOUSE.porch * VOXEL_SIZE_M,
  doorX: ((GRID_HOUSE.doorX[0] + GRID_HOUSE.doorX[1] + 1) / 2) * VOXEL_SIZE_M,
  backWallZ: (GRID_HOUSE.porch + GRID_HOUSE.d - 1) * VOXEL_SIZE_M,
  slabTop: VOXEL_SIZE_M,
} as const;

/** Writes the house as grid `gridId` of the world in `worldDir` of material `material`; returns its region files. */
export function writeGridHouse(worldDir: string, gridId: number, material: number): string[] {
  const m = JSON.parse(readFileSync(join(worldDir, 'world.json'), 'utf8')) as { worldId: string; edge: 16 | 32; layout: 'stacked' | 'column'; footprint: 512 | 1024; grids: Array<{ id: number; regions: string[] }> };
  const grid = chunkGrid(m.edge);
  const store = createWorldStore(grid);
  const v = (role: number) => ({ material, role, shape: 15, wetness: 0 });
  const { w, d, porch, h, doorX, doorH } = GRID_HOUSE;
  for (let x = 0; x < w; x++) for (let z = 0; z < porch + d; z++) {
    store.setVoxel(x, 0, z, v(VOXEL_ROLE.floor));
    if (z < porch) continue;
    const edge = x === 0 || x === w - 1 || z === porch || z === porch + d - 1;
    for (let y = 1; y <= h; y++) {
      const door = z === porch && x >= doorX[0] && x <= doorX[1] && y <= doorH;
      if (edge) store.setVoxel(x, y, z, v(door ? VOXEL_ROLE.opening : VOXEL_ROLE.wall));
    }
    store.setVoxel(x, h + 1, z, v(VOXEL_ROLE.roof));
  }
  const files = RegionWorld.create(join(worldDir, `grid-${gridId}`), { grid, worldId: hexToBytes(m.worldId), layout: m.layout, footprint: m.footprint, gridId }, store).listedRegions();
  const grids = [...m.grids.filter((g) => g.id !== gridId), { id: gridId, regions: files }].sort((a, b) => a.id - b.id);
  writeFileSync(join(worldDir, 'world.json'), `${JSON.stringify({ ...m, grids }, null, 2)}\n`);
  return files;
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
 * metres; y the slab's underside): its placement, and its frame (where its walls and door are in the world).
 */
export function gridHousePlacement(gridId: number, centre: readonly [number, number, number], yawDeg: number): { place: GridPlacement; frame: GridFrame } {
  const yawRad = (yawDeg * Math.PI) / 180;
  const mid = [(GRID_HOUSE.w * VOXEL_SIZE_M) / 2, 0, ((GRID_HOUSE.porch + GRID_HOUSE.d) * VOXEL_SIZE_M) / 2] as const;
  // The grid's cell 0 so that its footprint's middle lands on `centre`: centre − R(yaw)·mid.
  const turned = new GridFrame({ gridId, position: [0, 0, 0], yawRad }).toWorld(mid[0], mid[1], mid[2]);
  const place: GridPlacement = { gridId, position: [centre[0] - turned[0], centre[1], centre[2] - turned[2]], yawRad };
  return { place, frame: new GridFrame(place) };
}
