/**
 * `ctx.voxels` in a world with structure grids: which grid a point lies in, and the reads, rays and changes that
 * follow from it. One rule for every call:
 *
 * **A point lies in a structure where that structure's own cell holding it is not air; everywhere else it lies in
 * the world grid.** Where two structures' cells overlap, the lower grid id wins.
 *
 * - Reads (`get`, `materialAt`, `coverageAt`) answer from the grid the point lies in. A structure's chunk there not
 *   loaded reads null, as the world's does.
 * - A ray walks the world grid and every structure grid whose box it meets, each in its own frame
 *   (`walkWithGrids`): the nearest stop wins, its cell named in its own grid and its normal turned into the world.
 *   A light ray reads the world's lit props but not the structures' stamps there (the structures are walked
 *   themselves).
 * - A change over a region acts on each grid's own cells whose centres lie in the region. `dig` and `paint` act on
 *   every grid's cells there, the world's and every structure's (a dig through a house's wall into the ground empties
 *   both); `set` replaces the structure cells that are not air and writes the world's cells everywhere else, never a
 *   world cell whose centre lies in a structure's solid cell (so no second solid is made inside a wall). The strokes
 *   go world grid first, then the structures by ascending grid id, as one change: one id, reported once every grid's
 *   swap is in.
 *
 * Changes and their swaps are tracked here for the world grid and its structure grids alike ({@link VoxelChanges}):
 * a grid's swap groups are its own streamer's, so they are kept by (grid, group).
 */
import { MATERIAL_AIR, VOXEL_SIZE_M, lightCoverageAt, walkWithGrids, type GridWalk, type SwapReport, type VoxelRecord, type VoxelStreamer, type WalkRay, type WalkSource } from '@thirdlight/voxel';

import { voxelRayHit, type RegionCells, type VoxelBox, type VoxelChange, type VoxelRayHit, type VoxelRegion } from './voxel-api';
import type { VoxelGridHost } from './voxel-grid-host';

type P3 = readonly [number, number, number];

/** A structure's cell a point lies in. */
export interface StructureCell {
  readonly host: VoxelGridHost;
  readonly cell: P3;
}

const cellOf = (m: number): number => Math.floor(m / VOXEL_SIZE_M);

/**
 * The structure cell a world point (metres) lies in, by the rule above (`grids` ascending by id): null where it lies
 * in the world grid, 'unknown' where a structure's chunk holding it is not loaded. `out` holds the cell's voxel.
 */
export function structureAt(grids: readonly VoxelGridHost[], x: number, y: number, z: number, out: VoxelRecord): StructureCell | null | 'unknown' {
  for (const g of grids) {
    const e = g.extent;
    if (e === null) continue;
    const p = g.frame.toGrid(x, y, z);
    const c: P3 = [cellOf(p[0]), cellOf(p[1]), cellOf(p[2])];
    const s = g.streamer;
    const sh = s.grid.shift;
    const k = [c[0] >> sh, c[1] >> sh, c[2] >> sh];
    if (k.some((v, a) => v < e.min[a]! || v > e.max[a]!)) continue;
    if (!s.isResident(k[0]!, k[1]!, k[2]!)) return 'unknown';
    s.voxelAt(c[0], c[1], c[2], out);
    if (out.material !== MATERIAL_AIR) return { host: g, cell: c };
  }
  return null;
}

/**
 * How much light a cell of a streamer blocks, 0 … 255: its section's drawn light coverage joined with `prop` (a
 * coverage byte of props over it). Null where its chunk is not resident or its section has no result yet.
 */
export function cellCoverage(s: VoxelStreamer, cx: number, cy: number, cz: number, prop: number): number | null {
  const sh = s.grid.shift;
  if (!s.isResident(cx >> sh, cy >> sh, cz >> sh)) return null;
  const sec = s.sections;
  const d = s.derivedOf(cx >> sec.shift, cy >> sec.shift, cz >> sec.shift, true);
  if (d === null) return null;
  const light = d.assembly?.light;
  const m = sec.mask;
  // A result without an assembly is air all around: only the props block light there.
  return light === undefined ? prop : lightCoverageAt(light, ((((cx & m) << sec.shift) | (cz & m)) << sec.shift) | (cy & m), prop);
}

/** A grid point (metres in the grid's frame) or direction turned and moved into the world. */
function dirToWorld(g: VoxelGridHost, d: P3): [number, number, number] {
  const o = g.frame.toWorld(0, 0, 0);
  const w = g.frame.toWorld(d[0], d[1], d[2]);
  return [w[0] - o[0], w[1] - o[1], w[2] - o[2]];
}

/**
 * A ray's first stop through the world grid (`world`) and every structure grid it meets, each in its own frame
 * (`walkWithGrids`); null: nothing within `maxT`. A structure's hit: its cell in its own grid, the voxel's centre and
 * the face's normal in the world.
 */
export function raycastWithGrids(world: WalkSource, grids: readonly VoxelGridHost[], ray: WalkRay, maxT: number, stop: 'solid' | 'light'): VoxelRayHit | null {
  const walks: GridWalk[] = [];
  for (const g of grids) {
    const w = g.walkView();
    if (w !== null) walks.push(w);
  }
  const h = walkWithGrids(world, walks, ray, maxT, { stop });
  if (h === null) return null;
  if (h.gridId === 0) return voxelRayHit(ray, h.hit);
  // A grid's walk starts where the ray meets its box: its hit's distance and point are the whole ray's.
  const g = grids.find((x) => x.frame.gridId === h.gridId)!;
  // The hit's distance is the grid walk's from where it entered: the whole ray's is the walk's answer.
  const base = voxelRayHit(ray, { ...h.hit, t: h.t });
  const s = VOXEL_SIZE_M;
  const c = h.hit.cell;
  const at = g.frame.toWorld((c[0] + 0.5) * s, (c[1] + 0.5) * s, (c[2] + 0.5) * s);
  const n = dirToWorld(g, h.hit.normal);
  // The ray's distance and point are the same in both frames; the voxel's centre and the face's normal are turned out of the grid's.
  return Object.freeze({ ...base, at: Object.freeze(at), normal: Object.freeze(n.map((v) => (Math.abs(v) < 1e-12 ? 0 : v)) as [number, number, number]), grid: g.frame.gridId, cell: Object.freeze([c[0], c[1], c[2]] as [number, number, number]) });
}

/** The structure whose box of cells that are not air holds a world point (its read for its stamp, else its chunks): its grid id, 0 none. */
export function structureBoxAt(grids: readonly VoxelGridHost[], x: number, y: number, z: number): number {
  for (const g of grids) {
    const b = g.solidCells;
    const e = g.extent;
    if (e === null) continue;
    const E = g.streamer.grid.edge;
    const lo = b?.lo ?? [e.min[0] * E, e.min[1] * E, e.min[2] * E];
    const size = b?.size ?? [(e.max[0] - e.min[0] + 1) * E, (e.max[1] - e.min[1] + 1) * E, (e.max[2] - e.min[2] + 1) * E];
    const p = g.frame.toGrid(x, y, z).map((v) => v / VOXEL_SIZE_M);
    if (p.every((v, a) => v >= lo[a]! && v < lo[a]! + size[a]!)) return g.frame.gridId;
  }
  return 0;
}

/** Whether a world point (metres) lies in a region: a box's cells (as `regionCells` gives them) or a ball. */
function regionHolds(region: VoxelRegion, r: RegionCells, p: P3): boolean {
  const s = VOXEL_SIZE_M;
  if ('center' in region) return Math.hypot(p[0] - region.center[0], p[1] - region.center[1], p[2] - region.center[2]) <= region.radius;
  return p[0] >= r.minX * s && p[0] < (r.maxX + 1) * s && p[1] >= r.minY * s && p[1] < (r.maxY + 1) * s && p[2] >= r.minZ * s && p[2] < (r.maxZ + 1) * s;
}

/**
 * A structure grid's cells (its own, x y z flat) whose centres lie in a region, within the chunks its files hold; for
 * `{ at }` the one cell holding the point. `keep`: which of them (read through `cell`, the cell's voxel).
 */
export function gridCellsIn(g: VoxelGridHost, region: VoxelRegion, r: RegionCells, keep: (v: VoxelRecord) => boolean, cell: VoxelRecord): number[] {
  const e = g.extent;
  const out: number[] = [];
  if (e === null) return out;
  const s = VOXEL_SIZE_M;
  const st = g.streamer;
  const E = st.grid.edge;
  const take = (x: number, y: number, z: number): void => {
    st.voxelAt(x, y, z, cell);
    if (keep(cell)) out.push(x, y, z);
  };
  const inside = (x: number, y: number, z: number): boolean => x >= e.min[0] * E && x < (e.max[0] + 1) * E && y >= e.min[1] * E && y < (e.max[1] + 1) * E && z >= e.min[2] * E && z < (e.max[2] + 1) * E;
  if ('at' in region) {
    const p = g.frame.toGrid(region.at[0], region.at[1], region.at[2]);
    const c = p.map(cellOf);
    if (inside(c[0]!, c[1]!, c[2]!)) take(c[0]!, c[1]!, c[2]!);
    return out;
  }
  // The region's world box in the grid's frame (its turned corners' bounds), clipped to the grid's chunks.
  const lo = [Infinity, Infinity, Infinity];
  const hi = [-Infinity, -Infinity, -Infinity];
  for (let k = 0; k < 8; k++) {
    const q = g.frame.toGrid((k & 1 ? r.maxX + 1 : r.minX) * s, (k & 2 ? r.maxY + 1 : r.minY) * s, (k & 4 ? r.maxZ + 1 : r.minZ) * s);
    for (let a = 0; a < 3; a++) {
      lo[a] = Math.min(lo[a]!, q[a]!);
      hi[a] = Math.max(hi[a]!, q[a]!);
    }
  }
  const c0 = lo.map((v, a) => Math.max(cellOf(v), e.min[a]! * E));
  const c1 = hi.map((v, a) => Math.min(cellOf(v), (e.max[a]! + 1) * E - 1));
  for (let x = c0[0]!; x <= c1[0]!; x++) for (let z = c0[2]!; z <= c1[2]!; z++) for (let y = c0[1]!; y <= c1[1]!; y++) {
    if (regionHolds(region, r, g.frame.toWorld((x + 0.5) * s, (y + 0.5) * s, (z + 0.5) * s))) take(x, y, z);
  }
  return out;
}

/** Whether every chunk of a structure grid a region's world box reaches (within the chunks its files hold) is resident. */
export function gridResident(g: VoxelGridHost, r: RegionCells): boolean {
  const e = g.extent;
  if (e === null) return true;
  const s = VOXEL_SIZE_M;
  const st = g.streamer;
  const sh = st.grid.shift;
  const lo = [Infinity, Infinity, Infinity];
  const hi = [-Infinity, -Infinity, -Infinity];
  for (let k = 0; k < 8; k++) {
    const q = g.frame.toGrid((k & 1 ? r.maxX + 1 : r.minX) * s, (k & 2 ? r.maxY + 1 : r.minY) * s, (k & 4 ? r.maxZ + 1 : r.minZ) * s);
    for (let a = 0; a < 3; a++) {
      lo[a] = Math.min(lo[a]!, q[a]!);
      hi[a] = Math.max(hi[a]!, q[a]!);
    }
  }
  const k0 = lo.map((v, a) => Math.max(cellOf(v) >> sh, e.min[a]!));
  const k1 = hi.map((v, a) => Math.min(cellOf(v) >> sh, e.max[a]!));
  for (let cx = k0[0]!; cx <= k1[0]!; cx++) for (let cy = k0[1]!; cy <= k1[1]!; cy++) for (let cz = k0[2]!; cz <= k1[2]!; cz++) if (!st.isResident(cx, cy, cz)) return false;
  return true;
}

/** A chunk of a structure grid as a world box (metres: its turned box's bounds). */
export function gridChunkBox(g: VoxelGridHost, cx: number, cy: number, cz: number): VoxelBox {
  const m = g.streamer.grid.edge * VOXEL_SIZE_M;
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (let k = 0; k < 8; k++) {
    const w = g.frame.toWorld((cx + (k & 1)) * m, (cy + ((k >> 1) & 1)) * m, (cz + ((k >> 2) & 1)) * m);
    for (let a = 0; a < 3; a++) {
      min[a] = Math.min(min[a]!, w[a]!);
      max[a] = Math.max(max[a]!, w[a]!);
    }
  }
  return Object.freeze({ min: Object.freeze(min as [number, number, number]), max: Object.freeze(max as [number, number, number]) });
}

/** A change waiting for its swaps (in every grid it reached). */
export interface PendingChange {
  readonly edit: number;
  /** Swap groups of it not swapped yet, and those swapped, by `grid:group`. */
  readonly groups: Set<string>;
  readonly swapped: Set<string>;
  readonly chunks: Map<string, VoxelBox>;
  shaderOnly: boolean;
}

/**
 * The world's changes until their swaps, across its grids: a change's edits in each grid it reached join it by
 * (grid, group), each swap names its chunks (world boxes), and the change is reported once its last group swapped.
 */
export class VoxelChanges {
  private readonly pending = new Map<string, PendingChange>();
  /** Storage chunks announced since each grid's last swap, and whether only their shader data changed. */
  private readonly only = new Map<number, Map<string, boolean>>();
  /** The change whose commands are being applied (a group may swap before its edit call returns). */
  private applying: PendingChange | null = null;

  constructor(
    private readonly world: string,
    private readonly changed: (c: VoxelChange) => void,
  ) {}

  /** A change's commands begin to be applied. */
  begin(edit: number, shaderOnly: boolean): PendingChange {
    const c: PendingChange = { edit, groups: new Set(), swapped: new Set(), chunks: new Map(), shaderOnly };
    this.applying = c;
    return c;
  }

  /** An edit of the change in `grid` made swap group `group` (0: nothing to derive again). */
  joined(c: PendingChange, grid: number, group: number): void {
    const key = `${grid}:${group}`;
    if (group === 0 || c.swapped.has(key)) return;
    c.groups.add(key);
    this.pending.set(key, c);
  }

  /** The change's commands are applied: reported now if every group it made has swapped already. */
  end(c: PendingChange): void {
    this.applying = null;
    if (c.groups.size === 0 && c.swapped.size > 0) this.report(c);
  }

  /** A chunk of `grid` took new results (shader data alone or more). */
  chunk(grid: number, cx: number, cy: number, cz: number, shaderOnly: boolean): void {
    let m = this.only.get(grid);
    if (m === undefined) this.only.set(grid, (m = new Map()));
    const id = `${cx},${cy},${cz}`;
    m.set(id, (m.get(id) ?? true) && shaderOnly);
  }

  /** `grid` swapped: the changes whose groups it closed take its chunks (as world boxes); those complete are reported. */
  swap(grid: number, r: SwapReport, boxOf: (cx: number, cy: number, cz: number) => VoxelBox): void {
    const only = this.only.get(grid) ?? new Map<string, boolean>();
    this.only.delete(grid);
    const done = new Set<PendingChange>();
    for (const g of r.groups) {
      const key = `${grid}:${g}`;
      // A group that swaps inside the edit call that made it belongs to the change being applied.
      const p = this.pending.get(key) ?? this.applying;
      if (p === null) continue;
      this.pending.delete(key);
      p.groups.delete(key);
      p.swapped.add(key);
      for (const [cx, cy, cz] of r.chunks) {
        const id = `${cx},${cy},${cz}`;
        p.chunks.set(`${grid}|${id}`, boxOf(cx, cy, cz));
        p.shaderOnly &&= only.get(id) ?? false;
      }
      if (p.groups.size === 0 && p !== this.applying) done.add(p);
    }
    for (const p of done) this.report(p);
  }

  private report(p: PendingChange): void {
    this.changed(Object.freeze({ world: this.world, edit: p.edit, chunks: Object.freeze([...p.chunks.values()]), shaderOnly: p.shaderOnly }));
  }

  /** A new run or the world gone: nothing waits. */
  clear(): void {
    this.pending.clear();
    this.only.clear();
  }
}
