/**
 * A test world derived in this process for the occupancy walk: a box of a
 * synthetic world's chunks (moved so it crosses negative coordinates)
 * written into a store, every chunk's derive sections derived with the
 * world rules, and (on request) far nodes built from the store as distance
 * bricks, so a walk source reads level 0, far nodes and voxel records as
 * it does over a streamer.
 *
 * Engine-owned test data (walk.test.ts, `run.mjs walk`); nothing is
 * written to disk.
 */
import {
  buildApron,
  chunkGrid,
  createDenseChunk,
  createWorldStore,
  deriveSectionsWithApron,
  FarWalkNodes,
  farBricksFromFaces,
  jobRadius,
  OCCUPANCY,
  sectionLocalOrigin,
  streamerWalkSource,
  WORLD_RULES,
  type DeriveOutput,
  type DerivedData,
  type PaletteStore,
  type WalkSource,
  type WalkStreamerView,
} from '@thirdlight/voxel';

import type { TestWorld } from './world-kit';

export const WALK_GRID = chunkGrid(32);
const SECTION = 16;
const IDS = Array.from({ length: 8 }, (_, i) => i);

export interface WalkWorld {
  readonly store: PaletteStore;
  /** Derived sections by `sx,sy,sz`. */
  readonly sections: Map<string, DerivedData | null>;
  /** The chunk box derived (chunks, inclusive). */
  readonly min: readonly [number, number, number];
  readonly max: readonly [number, number, number];
  readonly far: FarWalkNodes;
  view(known?: (sx: number, sy: number, sz: number) => boolean): WalkStreamerView;
  source(opts?: { readonly known?: (sx: number, sy: number, sz: number) => boolean; readonly far?: boolean }): WalkSource;
  /** Whether a level-0 cell is a body drawn (the derived occupancy), read cell by cell. */
  solidAt(x: number, y: number, z: number): boolean;
  /** A chunk's sections derived again from the store (after an edit written into it). */
  rederive(cx: number, cy: number, cz: number): void;
}

/**
 * Chunks `min`–`max` (inclusive) of `world`'s first grid, the world's chunk `c + shift` written at `c`; `farLevel`:
 * far nodes of that level (≥ 1) over the box, built from the store at their own scale.
 */
export function walkWorld(world: TestWorld, min: readonly [number, number, number], max: readonly [number, number, number], shift: readonly [number, number, number], farLevel = 0): WalkWorld {
  const grid = WALK_GRID;
  const g = world.grids[0]!;
  const store = createWorldStore(grid);
  const d = createDenseChunk(grid);
  // An apron of chunks round the box: the derive reads its neighbours' cells.
  for (let cx = min[0] - 1; cx <= max[0] + 1; cx++) for (let cy = min[1] - 1; cy <= max[1] + 1; cy++) for (let cz = min[2] - 1; cz <= max[2] + 1; cz++) {
    if (g.fill(grid, cx + shift[0], cy + shift[1], cz + shift[2], d)) store.importChunk(cx, cy, cz, d);
  }
  const sections = new Map<string, DerivedData | null>();
  const R = jobRadius(WORLD_RULES);
  const derive = (cx: number, cy: number, cz: number): void => {
    const results = deriveSectionsWithApron(grid, WORLD_RULES, buildApron(store, cx, cy, cz, R), (out) => store.exportChunk(cx, cy, cz, out), SECTION, IDS);
    for (const r of results) {
      const [lx, ly, lz] = sectionLocalOrigin(grid.edge, SECTION, r.id);
      sections.set(`${cx * 2 + lx / SECTION},${cy * 2 + ly / SECTION},${cz * 2 + lz / SECTION}`, r.assembly);
    }
  };
  for (let cx = min[0]; cx <= max[0]; cx++) for (let cy = min[1]; cy <= max[1]; cy++) for (let cz = min[2]; cz <= max[2]; cz++) derive(cx, cy, cz);
  const far = new FarWalkNodes(grid.edge, false);
  if (farLevel > 0) {
    const span = 2 ** farLevel;
    const lo = min.map((m) => Math.floor(m / span));
    const hi = max.map((m) => Math.floor(m / span));
    for (let nx = lo[0]!; nx <= hi[0]!; nx++) for (let ny = lo[1]!; ny <= hi[1]!; ny++) for (let nz = lo[2]!; nz <= hi[2]!; nz++) {
      const bricks = farBricksFromFaces(grid, store, [nx, ny, nz], span);
      if (bricks.samples.length > 0) far.apply({ added: [{ level: farLevel, nx, ny, nz, bricks }], removed: [] });
    }
  }
  const resident = (cx: number, cy: number, cz: number): boolean => cx >= min[0] && cx <= max[0] && cy >= min[1] && cy <= max[1] && cz >= min[2] && cz <= max[2];
  const view = (known?: (sx: number, sy: number, sz: number) => boolean): WalkStreamerView => ({
    sections: { shift: 4 },
    grid,
    derivedOf: (sx, sy, sz) => {
      if (known !== undefined && !known(sx, sy, sz)) return null;
      const a = sections.get(`${sx},${sy},${sz}`);
      return a === undefined ? null : ({ assembly: a } as DeriveOutput);
    },
    mips: null,
    isResident: resident,
    voxelAt: (x, y, z, out) => store.voxelAt(x, y, z, out),
  });
  return {
    store,
    sections,
    min,
    max,
    far,
    view,
    source: (opts = {}) => streamerWalkSource(view(opts.known), opts.far === true ? far : null),
    rederive: derive,
    solidAt(x, y, z) {
      const a = sections.get(`${x >> 4},${y >> 4},${z >> 4}`);
      if (a == null) return false;
      const o = a.occupancy;
      if (o.flag !== OCCUPANCY.mixed) return o.flag === OCCUPANCY.solid;
      const i = (((x & 15) * 16 + (z & 15)) * 16) + (y & 15);
      return ((o.mask![i >>> 5]! >>> (i & 31)) & 1) === 1;
    },
  };
}
