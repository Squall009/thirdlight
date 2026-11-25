/**
 * The portal state of a voxel world's structure openings where the world
 * runs: each prop with a `voxelPortal` (a door leaf, a pane) joined to the
 * opening it stands in, and its open or shut state applied to that opening.
 *
 * **The join** is by place, from what an export has: the prop's middle (its
 * light shape's box, else its position a quarter metre up) lies in a
 * structure grid's `opening` cell, read from the grid's resident voxels where
 * the grid stands; the opening is that cell and the `opening` cells joined to
 * it by faces, however far they run. Two openings side by side on a wall are one run of `opening`
 * cells: a prop whose middle lies in a run with another's takes the cells on
 * its side of the cell boundary nearest the midpoint between the two (along
 * the axis they lie apart on), so each governs its own opening. No definition is read (an export ships none): an opening's
 * record names its prop in the editor, and the prop stands in it.
 *
 * **What a shut portal stops**, exactly at its opening and the same step:
 * - light: the opening's cells, stamped into the world's cells where the
 *   grid stands (every world cell any of them reaches), stop the light's
 *   rays whole, at level 0 and at the walk's mip levels: one more stamp in the world's prop channel, so a flip
 *   recombines only those cells and sends again only the walk blocks they
 *   touch, the volume taking it in as it takes an edit. The leaf's own shape
 *   is never stamped: its thickness does not matter.
 * - walkers: the opening's cells are shut in the grid's walk graph, so a path
 *   goes through them only when asked (`doors: 'shut-too'`); only the chunks
 *   they lie in are made again.
 * - sight: `portalsOf` says so; the rooms are already parted at every portal,
 *   open or shut, so nothing else reads it.
 *
 * Open, the stamp and the shut cells go. A prop whose opening is not resident
 * yet is joined once it is; one standing in no opening stops nothing.
 */
import { gridStampBounds, MATERIAL_AIR, stampGrid, STAMP_CLASS, VOXEL_ROLE, VOXEL_SIZE_M, type GridStampCells, type LitStamp, type PropLightChannel, type VoxelRecord } from '@thirdlight/voxel';
import type { VoxelGridHost } from './voxel-grid-host';

/** What a portal stops while shut. */
export interface PortalStops {
  readonly light: boolean;
  readonly sight: boolean;
  readonly walk: boolean;
}

/** A prop with a portal as the world reads it each step. */
export interface PortalProp {
  readonly open: boolean;
  readonly stops: PortalStops;
  /** Its middle (world metres): what joins it to the opening it stands in. */
  readonly at: readonly [number, number, number];
}

/** An opening a prop is joined to. */
interface Joined {
  readonly grid: VoxelGridHost;
  /** The opening's cells in the grid (x y z each). */
  readonly cells: readonly (readonly [number, number, number])[];
  /** Its stamp into the world's cells (coverage bytes only: it changes no region). */
  readonly stamp: LitStamp;
  /** The world cells the stamp covers (inclusive box). */
  readonly min: readonly [number, number, number];
  readonly max: readonly [number, number, number];
  /** What is applied now. */
  light: boolean;
  walk: boolean;
}

/** The id a portal's stamp has in its world's prop channel (beside the props' object ids). */
const portalStampId = (id: string): string => `portal\u0000${id}`;

/**
 * The grid cells of the opening holding a grid cell: every `opening` cell joined to it by faces, however wide or tall
 * the opening (null: the cell is no opening; `later`: the opening runs on into a chunk of the grid not resident yet, so
 * it is joined once that chunk is). The flood is bounded by the opening's own cells and the grid's resident chunks,
 * nothing else: a barn door shuts whole.
 */
function openingCellsAt(g: VoxelGridHost, start: readonly [number, number, number]): [number, number, number][] | null | 'later' {
  const s = g.streamer;
  const sh = s.grid.shift;
  const cell: VoxelRecord = { material: 0, role: 0, shape: 0, wetness: 0 } as VoxelRecord;
  const isOpening = (x: number, y: number, z: number): boolean | null => {
    if (!s.isResident(x >> sh, y >> sh, z >> sh)) return null;
    s.voxelAt(x, y, z, cell);
    return cell.role === VOXEL_ROLE.opening;
  };
  const first = isOpening(start[0], start[1], start[2]);
  if (first !== true) return null;
  const seen = new Set<string>([start.join(',')]);
  const out: [number, number, number][] = [];
  const queue: [number, number, number][] = [[start[0], start[1], start[2]]];
  while (queue.length > 0) {
    const c = queue.pop()!;
    out.push(c);
    for (const [dx, dy, dz] of [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]] as const) {
      const n: [number, number, number] = [c[0] + dx, c[1] + dy, c[2] + dz];
      const k = n.join(',');
      if (seen.has(k)) continue;
      seen.add(k);
      const o = isOpening(n[0], n[1], n[2]);
      if (o === null) return 'later';
      if (o) queue.push(n);
    }
  }
  return out;
}

/** An opening's cells as a stamp of stopping cells: every world cell any of them reaches stops light whole. */
function shutStamp(g: VoxelGridHost, cells: readonly (readonly [number, number, number])[]): { stamp: LitStamp; min: [number, number, number]; max: [number, number, number] } {
  const lo: [number, number, number] = [Infinity, Infinity, Infinity];
  const hi: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (const c of cells) for (let a = 0; a < 3; a++) {
    lo[a] = Math.min(lo[a]!, c[a]!);
    hi[a] = Math.max(hi[a]!, c[a]!);
  }
  const size: [number, number, number] = [hi[0] - lo[0] + 1, hi[1] - lo[1] + 1, hi[2] - lo[2] + 1];
  const classes = new Uint8Array(size[0] * size[1] * size[2]);
  for (const c of cells) classes[((c[0] - lo[0]) * size[2] + (c[2] - lo[2])) * size[1] + (c[1] - lo[1])] = STAMP_CLASS.stop;
  const box: GridStampCells = { lo, size, classes };
  const cellM = VOXEL_SIZE_M;
  const b = gridStampBounds(box, g.frame, cellM);
  const stamp: LitStamp = {
    stamp: true,
    // The walk's mip levels (past the detail ring) meet the shut door too; no class, so the regions keep the portal.
    mipStop: true,
    bounds: () => b,
    sample: (m: number) => {
      // The `any` rule: a world cell one sample of the opening reaches stops whole. No classes: the regions keep the portal.
      const r = stampGrid(box, g.frame, 'any', m);
      return { lo: r.lo, size: r.size, bytes: r.bytes, cells: r.cells };
    },
  };
  const min = [0, 1, 2].map((a) => Math.floor(b.min[a]! / cellM)) as [number, number, number];
  const max = [0, 1, 2].map((a) => Math.ceil(b.max[a]! / cellM) - 1) as [number, number, number];
  return { stamp, min, max };
}

export class WorldPortals {
  private readonly props = new Map<string, PortalProp>();
  private readonly joined = new Map<string, Joined>();
  /** Props not joined yet (their opening's chunk not resident, or they stand in none so far). */
  private readonly waiting = new Set<string>();
  /** Flips applied since the world opened (diagnostics, the measurements). */
  flips = 0;

  constructor(
    private readonly grids: () => readonly VoxelGridHost[],
    private readonly channel: () => PropLightChannel | null,
  ) {}

  /** Props with a portal placed, changed (state or place) or gone (null). */
  set(changes: readonly (readonly [string, PortalProp | null])[]): void {
    for (const [id, p] of changes) {
      const was = this.props.get(id);
      if (p === null) {
        this.props.delete(id);
        this.unjoin(id);
        continue;
      }
      this.props.set(id, p);
      const moved = was === undefined || was.at.some((v, i) => Math.abs(v - p.at[i]!) > 1e-6);
      if (moved) {
        this.unjoin(id);
        this.waiting.add(id);
      } else this.apply(id);
    }
  }

  /** Joins the props waiting whose opening is now resident, then applies each joined prop's state. */
  step(): void {
    if (this.waiting.size === 0) return;
    for (const id of [...this.waiting]) {
      const p = this.props.get(id);
      if (p === undefined) {
        this.waiting.delete(id);
        continue;
      }
      const j = this.join(id, p);
      if (j === 'later') continue;
      this.waiting.delete(id);
      if (j === null) continue;
      this.joined.set(id, j);
      this.apply(id);
      // A prop joined before it to the same run (at another cell) took the whole run: it joins again, split against this one.
      const mine = new Set(j.cells.map((c) => c.join(',')));
      const cellOf = (q: PortalProp): string => {
        const g = j.grid.frame.toGrid(q.at[0], q.at[1], q.at[2]);
        return `${Math.floor(g[0] / VOXEL_SIZE_M)},${Math.floor(g[2] / VOXEL_SIZE_M)}`;
      };
      for (const [other, o] of [...this.joined]) if (other !== id && o.grid === j.grid && cellOf(this.props.get(other)!) !== cellOf(p) && o.cells.some((c) => mine.has(c.join(',')))) {
        this.unjoin(other);
        this.waiting.add(other);
      }
    }
  }

  /** The prop whose opening a world-cell box (a region portal's) holds, with its state (null: none). */
  propOf(min: readonly number[], max: readonly number[]): { readonly id: string; readonly open: boolean; readonly stops: PortalStops } | null {
    for (const [id, j] of this.joined) {
      if ([0, 1, 2].some((a) => j.max[a]! < min[a]! || j.min[a]! > max[a]!)) continue;
      const p = this.props.get(id);
      if (p !== undefined) return { id, open: p.open, stops: p.stops };
    }
    return null;
  }

  /** What is held (diagnostics). */
  stats(): { readonly props: number; readonly joined: number; readonly waiting: number; readonly shutLight: number; readonly shutWalk: number; readonly flips: number } {
    let light = 0;
    let walk = 0;
    for (const j of this.joined.values()) {
      if (j.light) light++;
      if (j.walk) walk++;
    }
    return { props: this.props.size, joined: this.joined.size, waiting: this.waiting.size, shutLight: light, shutWalk: walk, flips: this.flips };
  }

  /** Everything goes (the world closes). */
  clear(): void {
    for (const id of [...this.joined.keys()]) this.unjoin(id);
    this.props.clear();
    this.waiting.clear();
  }

  private join(id: string, p: PortalProp): Joined | null | 'later' {
    const record: VoxelRecord = { material: 0, role: 0, shape: 0, wetness: 0 } as VoxelRecord;
    const grids = this.grids();
    // The world's grids open with it, a step or more after its props arrive: nothing is decided before.
    if (grids.length === 0) return 'later';
    for (const g of grids) {
      const e = g.extent;
      if (e === null) continue;
      const q = g.frame.toGrid(p.at[0], p.at[1], p.at[2]);
      const c: [number, number, number] = [Math.floor(q[0] / VOXEL_SIZE_M), Math.floor(q[1] / VOXEL_SIZE_M), Math.floor(q[2] / VOXEL_SIZE_M)];
      const s = g.streamer;
      const sh = s.grid.shift;
      const k = [c[0] >> sh, c[1] >> sh, c[2] >> sh];
      if (k.some((v, a) => v < e.min[a]! || v > e.max[a]!)) continue;
      if (!s.isResident(k[0]!, k[1]!, k[2]!)) return 'later';
      s.voxelAt(c[0], c[1], c[2], record);
      if (record.material === MATERIAL_AIR && record.role !== VOXEL_ROLE.opening) continue;
      const found = openingCellsAt(g, c);
      if (found === 'later') return 'later';
      if (found === null) continue;
      let cells = found;
      cells = this.splitRun(id, g, c, q, cells);
      const { stamp, min, max } = shutStamp(g, cells);
      return { grid: g, cells, stamp, min, max, light: false, walk: false };
    }
    return null;
  }

  /**
   * A run's cells this prop governs: with another prop's middle in the same run (a cell of it apart from this one's),
   * the cells on this prop's side of the cell boundary nearest their midpoint, along the axis (x or z of the grid) they
   * lie farther apart on; each other prop cuts it again. Props at the same cell share the run.
   */
  private splitRun(id: string, g: VoxelGridHost, c: readonly number[], q: readonly number[], cells: [number, number, number][]): [number, number, number][] {
    const inRun = new Set(cells.map((x) => x.join(',')));
    let out = cells;
    for (const [other, o] of this.props) {
      if (other === id) continue;
      const qo = g.frame.toGrid(o.at[0], o.at[1], o.at[2]);
      const co = [Math.floor(qo[0] / VOXEL_SIZE_M), Math.floor(qo[1] / VOXEL_SIZE_M), Math.floor(qo[2] / VOXEL_SIZE_M)];
      if (!inRun.has(co.join(',')) || (co[0] === c[0] && co[2] === c[2])) continue;
      const axis = Math.abs(qo[0] - q[0]!) >= Math.abs(qo[2] - q[2]!) ? 0 : 2;
      const cut = Math.round((q[axis]! + qo[axis]!) / 2 / VOXEL_SIZE_M);
      const below = c[axis]! < cut;
      out = out.filter((x) => x[axis]! < cut === below);
    }
    return out;
  }

  /** A joined prop's state onto its opening: its light stamp and its walk graph's shut cells as the state asks. */
  private apply(id: string): void {
    const j = this.joined.get(id);
    const p = this.props.get(id);
    if (j === undefined || p === undefined) return;
    const light = !p.open && p.stops.light;
    const walk = !p.open && p.stops.walk;
    if (light !== j.light) {
      this.channel()?.apply([[portalStampId(id), light ? j.stamp : null]]);
      j.light = light;
      this.flips++;
    }
    if (walk !== j.walk) {
      j.grid.walk.setShut(id, walk ? j.cells : null);
      j.walk = walk;
    }
  }

  private unjoin(id: string): void {
    const j = this.joined.get(id);
    if (j === undefined) return;
    if (j.light) this.channel()?.apply([[portalStampId(id), null]]);
    if (j.walk) j.grid.walk.setShut(id, null);
    this.joined.delete(id);
  }
}
