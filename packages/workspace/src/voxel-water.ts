/**
 * Water bodies in the editor's backend: a `waterBody` object's liquid
 * voxels written into its world grid, and written again when what bounds it
 * changes, as part of the change.
 *
 * - **A stroke** of the world (a dig, an add, a paint) or a hand edit on a
 *   structure's grid: every body whose reach the stroke's cells meet is
 *   followed in the same stroke, after the edit (ground, then buildings,
 *   then water), so one undo takes back the dig and the water together.
 *   The follow-up works round the stroke's cells (`followBody`) and falls
 *   back to the whole body where it cannot stay local (it held nothing, its
 *   start cell changed, a cut, a leak).
 * - **A command** that makes, changes, moves or deletes a body, or writes a
 *   structure inside a body's reach, writes the water as its own stroke
 *   after the structures', attached to the command's project entry (one undo
 *   step with the scene edit).
 *
 * What a body owns (its material's liquid joined to its start cell) is held
 * here between steps, so a follow-up does not walk a whole lake to find its
 * own water; it is memory only, read again from the voxels when it is not
 * held or no longer matches (an undo, a redo, a structure write, files
 * changed on disk, a body changed). The last write's report of each body
 * (filled, drained by a leak and where, its start cell blocked) is held the
 * same way and answered by the world's route; nothing is stored.
 *
 * Structures stand over the world grid's cells in their own grids: the fill
 * reads a world cell as closed where a structure's cell there stops light (a
 * wall, a floor), so water stands round a house and comes in by its door.
 */
import { type SceneWaterBody } from '@thirdlight/project-model';
import {
  bodyCells,
  cellInWorld,
  fillShapeAt,
  recordValue,
  SHAPE_FULL,
  valueRole,
  VOXEL_ROLE,
  withinReach,
  chunksPerRegionSide,
  chunkKeyOrNone,
  chunkOfKey,
  clearBody,
  fillLeaks,
  FILL_OUTSIDE,
  followBody,
  GridFrame,
  regenerateBody,
  stampClassOfValue,
  STAMP_CLASS,
  valueOf,
  VOXEL_SIZE_M,
  writeCells,
  type CellBox,
  type CellSet,
  type CellWrites,
  type ChunkUndo,
  type FillWorld,
  type FollowWholeWhy,
  type GridPlacement,
  type LevelFillSpec,
  type LevelFillStatus,
  type VoxelRecord,
} from '@thirdlight/voxel';
import type { RegionWorld } from './voxel-world-files';

/** A world as the water reads and writes it: its own grid, and its structure grids where their objects stand (loaded whole). */
export interface WaterWorld {
  /** The world's key (project and name): what the held state is filed by. */
  readonly key: string;
  readonly world: RegionWorld;
  readonly grids: ReadonlyArray<{ readonly place: GridPlacement; readonly world: RegionWorld }>;
  /**
   * The cells a spline wrote liquid into (a river), read when first needed. They are the river's: a body reads them
   * as ground (it neither fills, owns nor clears them, so a river running on past a lake's reach is no leak of the
   * lake's), but for the river's mouth, its cells inside the body's reach under its level, which the river writes as
   * the body's liquid at its level and the body takes as its own.
   */
  readonly rivers?: () => CellSet;
}

/** A body's state after the last step that wrote it, or a check (nothing written). */
export interface WaterBodyReport {
  readonly entityId: string;
  /** `filled`; `breached`: the fill leaves its bound, the body holds no water; `seed_blocked`: its start cell is not open (in ground, out of the world, above the level). */
  readonly status: LevelFillStatus;
  /** Liquid cells it owns now. */
  readonly cells: number;
  /** Where it leaks (metres in the scene, a place per 16 m of ground, the bound crossed and the cells there); empty unless breached. */
  readonly leaks: ReadonlyArray<{ readonly at: readonly [number, number, number]; readonly kind: 'reach' | 'world'; readonly cells: number }>;
  /** `local`: followed round the change; `whole`: written from its seed; `check`: read, not written. */
  readonly via: 'local' | 'whole' | 'check';
  /** Why a follow-up was whole. */
  readonly why?: FollowWholeWhy;
  /** Cells this step wrote for it. */
  readonly written: number;
}

/** What a step wrote of the water. */
export interface WaterWrites {
  /** The undo record, newest writes first (so it goes before the edit's own record). */
  readonly record: ChunkUndo[];
  readonly cells: number;
  readonly fields: number;
  readonly parts: number;
  readonly materialSwaps: readonly number[];
  /** The cells written (inclusive; null: none). */
  readonly box: CellBox | null;
  /** The world chunks written ([cx, cy, cz] each). */
  readonly chunks: Array<readonly [number, number, number]>;
  readonly bodies: WaterBodyReport[];
  /** Milliseconds the water took (reads, fills and writes). */
  readonly ms: number;
}

/** A body a command changed: as it was and as it is (null: none). */
export interface WaterChange {
  readonly before: SceneWaterBody | null;
  readonly after: SceneWaterBody | null;
}

/** A body's fill in cells, from its record and its seed (null: it has no seed). */
export function waterSpecOf(b: SceneWaterBody): LevelFillSpec | null {
  if (b.seed === null) return null;
  const m = VOXEL_SIZE_M;
  return { seed: [Math.floor(b.seed[0] / m), Math.floor(b.seed[1] / m), Math.floor(b.seed[2] / m)], level: b.body.level / m, material: b.body.material, reach: b.body.reach / m };
}

/** Whether a change inside `box` (world cells) can meet the body: inside its reach's square, not wholly above its level. */
function meets(spec: LevelFillSpec, box: CellBox): boolean {
  const r = Math.ceil(spec.reach) + 1;
  return box.maxX >= spec.seed[0] - r && box.minX <= spec.seed[0] + r && box.maxZ >= spec.seed[2] - r && box.minZ <= spec.seed[2] + r && box.minY <= Math.ceil(spec.level);
}

/** The world cells a box of a structure grid's cells lies over where the grid stands (inclusive). */
export function gridBoxInWorld(b: CellBox, place: GridPlacement): CellBox {
  const f = new GridFrame(place);
  const m = VOXEL_SIZE_M;
  let minX = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxZ = -Infinity;
  for (const x of [b.minX, b.maxX + 1]) {
    for (const z of [b.minZ, b.maxZ + 1]) {
      const [wx, , wz] = f.toWorld(x * m, 0, z * m);
      minX = Math.min(minX, wx);
      maxX = Math.max(maxX, wx);
      minZ = Math.min(minZ, wz);
      maxZ = Math.max(maxZ, wz);
    }
  }
  const y0 = place.position[1] / m;
  return { minX: Math.floor(minX / m), maxX: Math.floor(maxX / m), minY: Math.floor(y0 + b.minY), maxY: Math.floor(y0 + b.maxY + 1), minZ: Math.floor(minZ / m), maxZ: Math.floor(maxZ / m) };
}

/** The cells a grid's stored chunks span, in its own cells (null: it holds none). */
function gridCells(rw: RegionWorld): CellBox | null {
  const g = rw.opts.grid;
  const s = g.shift;
  let b: CellBox | null = null;
  for (const key of rw.store.chunkKeys()) {
    const c = chunkOfKey(g, key);
    const e = { minX: c.cx << s, minY: c.cy << s, minZ: c.cz << s, maxX: ((c.cx + 1) << s) - 1, maxY: ((c.cy + 1) << s) - 1, maxZ: ((c.cz + 1) << s) - 1 };
    b = b === null ? e : { minX: Math.min(b.minX, e.minX), minY: Math.min(b.minY, e.minY), minZ: Math.min(b.minZ, e.minZ), maxX: Math.max(b.maxX, e.maxX), maxY: Math.max(b.maxY, e.maxY), maxZ: Math.max(b.maxZ, e.maxZ) };
  }
  return b;
}

/**
 * The cells the world's listed region files span together (inclusive; null: none): past them is not the world the
 * fill knows (a region inside them that is not listed is all air, one outside is nowhere), so water that would run
 * past them leaves the loaded world.
 */
function worldCells(rw: RegionWorld): CellBox | null {
  const g = rw.opts.grid;
  const side = chunksPerRegionSide(g, rw.opts.footprint) * g.edge;
  let b: CellBox | null = null;
  for (const name of rw.listedRegions()) {
    const a = rw.files.get(name)?.address;
    if (a === undefined) continue;
    const e = { minX: a.rx * side, maxX: (a.rx + 1) * side - 1, minZ: a.rz * side, maxZ: (a.rz + 1) * side - 1, minY: a.layout === 'stacked' ? a.ry * side : -Infinity, maxY: a.layout === 'stacked' ? (a.ry + 1) * side - 1 : Infinity };
    b = b === null ? e : { minX: Math.min(b.minX, e.minX), minY: Math.min(b.minY, e.minY), minZ: Math.min(b.minZ, e.minZ), maxX: Math.max(b.maxX, e.maxX), maxY: Math.max(b.maxY, e.maxY), maxZ: Math.max(b.maxZ, e.maxZ) };
  }
  return b;
}

/**
 * The world as the fill reads it: the world grid's cells within its listed
 * regions (each region file loaded when the walk first reaches it; a cell
 * past them, past the world's bounds or of a damaged chunk is outside),
 * closed where a structure's cell over it stops light.
 */
export function waterFillWorld(w: WaterWorld): FillWorld {
  const rw = w.world;
  const grid = rw.opts.grid;
  const s = grid.shift;
  const ready = new Map<number, boolean>();
  const rec: VoxelRecord = { material: 0, role: 0, shape: 0, wetness: 0 };
  const placed = w.grids.flatMap((g) => {
    const cells = gridCells(g.world);
    return cells === null ? [] : [{ frame: new GridFrame(g.place), store: g.world.store, box: gridBoxInWorld(cells, g.place) }];
  });
  const m = VOXEL_SIZE_M;
  const known = worldCells(rw);
  const value = (x: number, y: number, z: number): number => {
    if (known === null || x < known.minX || x > known.maxX || y < known.minY || y > known.maxY || z < known.minZ || z > known.maxZ || !cellInWorld(x, y, z)) return FILL_OUTSIDE;
    const key = chunkKeyOrNone(grid, x >> s, y >> s, z >> s);
    if (key < 0) return FILL_OUTSIDE;
    let ok = ready.get(key);
    if (ok === undefined) ready.set(key, (ok = rw.ensureNow(x >> s, y >> s, z >> s)));
    return ok ? valueOf(rw.store.voxelAt(x, y, z, rec)) : FILL_OUTSIDE;
  };
  if (placed.length === 0) return { value };
  return {
    value,
    stops: (x, y, z) => {
      for (const p of placed) {
        const b = p.box;
        if (x < b.minX || x > b.maxX || y < b.minY || y > b.maxY || z < b.minZ || z > b.maxZ) continue;
        const [gx, gy, gz] = p.frame.toGrid((x + 0.5) * m, (y + 0.5) * m, (z + 0.5) * m);
        if (stampClassOfValue(valueOf(p.store.voxelAt(Math.floor(gx / m), Math.floor(gy / m), Math.floor(gz / m), rec))) === STAMP_CLASS.stop) return true;
      }
      return false;
    },
  };
}

/** Collects one step's writes over its bodies. */
class StepWrites {
  record: ChunkUndo[] = [];
  cells = 0;
  fields = 0;
  parts = 0;
  readonly swaps = new Set<number>();
  box: CellBox | null = null;
  readonly chunks = new Map<string, readonly [number, number, number]>();
  readonly bodies: WaterBodyReport[] = [];

  write(w: WaterWorld, writes: CellWrites): number {
    if (writes.values.length === 0) return 0;
    const done = writeCells(w.world.store, 0, writes);
    if (done.cells === 0) return 0;
    w.world.markEdited(done.chunks);
    // Newest first: an undo takes back the last body's writes before the earlier ones, and all before the edit's.
    this.record = [...[...done.chunks].reverse(), ...this.record];
    this.cells += done.cells;
    this.fields |= done.fields;
    this.parts |= done.parts;
    for (const sw of done.materialSwaps) this.swaps.add(sw);
    const b = done.box!;
    this.box = this.box === null ? { ...b } : { minX: Math.min(this.box.minX, b.minX), minY: Math.min(this.box.minY, b.minY), minZ: Math.min(this.box.minZ, b.minZ), maxX: Math.max(this.box.maxX, b.maxX), maxY: Math.max(this.box.maxY, b.maxY), maxZ: Math.max(this.box.maxZ, b.maxZ) };
    for (const c of done.chunks) this.chunks.set(`${c.cx},${c.cy},${c.cz}`, [c.cx, c.cy, c.cz]);
    return done.cells;
  }

  done(t0: number): WaterWrites | null {
    if (this.bodies.length === 0) return null;
    return { record: this.record, cells: this.cells, fields: this.fields, parts: this.parts, materialSwaps: [...this.swaps].sort((a, b) => a - b), box: this.box, chunks: [...this.chunks.values()], bodies: this.bodies, ms: performance.now() - t0 };
  }
}

/** What a river's cell reads as to a body (see {@link WaterWorld.rivers}): ground. */
const RIVER_TO_A_BODY = recordValue(1, VOXEL_ROLE.terrain, SHAPE_FULL, 0);

/** The world as one body's fill reads it: a river's cells ground but at the body's mouth (inside its reach, under its level; null: no body, every river cell ground). */
export function bodyFillWorld(fw: FillWorld, w: WaterWorld, spec: LevelFillSpec | null): FillWorld {
  const rivers = w.rivers?.();
  if (rivers === undefined || rivers.size === 0) return fw;
  const value = (x: number, y: number, z: number): number => {
    const v = fw.value(x, y, z);
    if (v <= 0 || valueRole(v) !== VOXEL_ROLE.liquid || !rivers.has(x, y, z)) return v;
    return spec !== null && withinReach(spec, x, z) && fillShapeAt(spec.level, y) > 0 ? v : RIVER_TO_A_BODY;
  };
  return fw.stops === undefined ? { value } : { value, stops: fw.stops };
}

const leaksOf = (fill: Parameters<typeof fillLeaks>[0]): WaterBodyReport['leaks'] => fillLeaks(fill).map((l) => ({ at: [l.at[0] * VOXEL_SIZE_M, l.at[1] * VOXEL_SIZE_M, l.at[2] * VOXEL_SIZE_M] as const, kind: l.kind, cells: l.cells }));

/** The water bodies of the worlds this backend serves: what each owns and its last report, held between steps. */
export class WaterBodies {
  private readonly owned = new Map<string, { readonly spec: string; readonly set: CellSet }>();
  private readonly held = new Map<string, WaterBodyReport>();

  private ownedOf(w: WaterWorld, entityId: string, spec: LevelFillSpec, fw: FillWorld): CellSet {
    const h = this.owned.get(`${w.key}\u0000${entityId}`);
    return h !== undefined && h.spec === JSON.stringify(spec) ? h.set : bodyCells(spec, fw);
  }

  private keep(w: WaterWorld, entityId: string, spec: LevelFillSpec, set: CellSet, report: WaterBodyReport): void {
    this.owned.set(`${w.key}\u0000${entityId}`, { spec: JSON.stringify(spec), set });
    this.held.set(`${w.key}\u0000${entityId}`, report);
  }

  /** A body written whole from its seed (`before`: what it owned, else read from the voxels). */
  private whole(w: WaterWorld, fw: FillWorld, out: StepWrites, b: SceneWaterBody, spec: LevelFillSpec, before: CellSet | undefined, why?: FollowWholeWhy): void {
    const g = regenerateBody(spec, fw, before);
    const written = out.write(w, g.writes);
    const report: WaterBodyReport = { entityId: b.entityId, status: g.fill.status, cells: g.owned.size, leaks: g.fill.status === 'breached' ? leaksOf(g.fill) : [], via: 'whole', ...(why !== undefined ? { why } : {}), written };
    out.bodies.push(report);
    this.keep(w, b.entityId, spec, g.owned, report);
  }

  /**
   * After a change of the world's cells inside `boxes` (world cells): every body of `bodies` (the world's, as the
   * scenes hold them) whose reach a box meets is followed round it, its writes made into the world grid. Null:
   * no body met.
   */
  follow(w: WaterWorld, bodies: readonly SceneWaterBody[], boxes: readonly CellBox[]): WaterWrites | null {
    const t0 = performance.now();
    const out = new StepWrites();
    let fw: FillWorld | null = null;
    for (const b of bodies) {
      const spec = waterSpecOf(b);
      if (spec === null) continue;
      const hit = boxes.filter((box) => meets(spec, box));
      if (hit.length === 0) continue;
      fw ??= waterFillWorld(w);
      const bw = bodyFillWorld(fw, w, spec);
      let owned = this.ownedOf(w, b.entityId, spec, bw);
      let written = 0;
      let whole: FollowWholeWhy | null = null;
      for (const box of hit) {
        const f = followBody(spec, bw, owned, box);
        if (f.kind === 'whole') {
          whole = f.why;
          break;
        }
        written += out.write(w, f.writes);
        owned = f.owned;
      }
      if (whole !== null) {
        this.whole(w, bw, out, b, spec, owned, whole);
        continue;
      }
      const report: WaterBodyReport = { entityId: b.entityId, status: 'filled', cells: owned.size, leaks: [], via: 'local', written };
      out.bodies.push(report);
      this.keep(w, b.entityId, spec, owned, report);
    }
    return out.done(t0);
  }

  /**
   * A command's water: each body it made, changed or moved written whole (what it owned before cleared), each it
   * deleted (or moved out of this world) cleared, then the bodies it left alone followed round `boxes` (the
   * structures it wrote). Null: nothing to write.
   */
  rewrite(w: WaterWorld, world: string, changes: readonly WaterChange[], bodies: readonly SceneWaterBody[], boxes: readonly CellBox[]): WaterWrites | null {
    const t0 = performance.now();
    const out = new StepWrites();
    const fw = waterFillWorld(w);
    const touched = new Set<string>();
    for (const ch of changes) {
      const was = ch.before !== null && ch.before.body.world === world ? ch.before : null;
      const now = ch.after !== null && ch.after.body.world === world ? ch.after : null;
      if (was === null && now === null) continue;
      touched.add((now ?? was)!.entityId);
      const oldSpec = was === null ? null : waterSpecOf(was);
      const before = oldSpec === null ? undefined : this.ownedOf(w, was!.entityId, oldSpec, bodyFillWorld(fw, w, oldSpec));
      const spec = now === null ? null : waterSpecOf(now);
      if (spec === null) {
        // Deleted, moved to another world, or without a place: the liquid it owned goes with it.
        // A river's cells stay: its own rewrite, earlier in the command, has written them without the body.
        const written = before === undefined ? 0 : out.write(w, clearBody(before, bodyFillWorld(fw, w, null)));
        const id = (now ?? was)!.entityId;
        this.owned.delete(`${w.key}\u0000${id}`);
        this.held.delete(`${w.key}\u0000${id}`);
        out.bodies.push({ entityId: id, status: 'seed_blocked', cells: 0, leaks: [], via: 'whole', written });
        continue;
      }
      this.whole(w, bodyFillWorld(fw, w, spec), out, now!, spec, before);
    }
    const rest = bodies.filter((b) => b.body.world === world && !touched.has(b.entityId));
    const followed = boxes.length === 0 ? null : this.follow(w, rest, boxes);
    if (followed !== null) {
      // The follow-up made its own writes into the world: they are this step's too, the newest.
      out.record = [...followed.record, ...out.record];
      out.cells += followed.cells;
      out.fields |= followed.fields;
      out.parts |= followed.parts;
      for (const sw of followed.materialSwaps) out.swaps.add(sw);
      if (followed.box !== null) out.box = out.box === null ? followed.box : { minX: Math.min(out.box.minX, followed.box.minX), minY: Math.min(out.box.minY, followed.box.minY), minZ: Math.min(out.box.minZ, followed.box.minZ), maxX: Math.max(out.box.maxX, followed.box.maxX), maxY: Math.max(out.box.maxY, followed.box.maxY), maxZ: Math.max(out.box.maxZ, followed.box.maxZ) };
      for (const c of followed.chunks) out.chunks.set(c.join(','), c);
      out.bodies.push(...followed.bodies);
    }
    return out.done(t0);
  }

  /** Forgets what the bodies of a world owned and their reports (its voxels changed some other way: an undo, a redo, files on disk). */
  forget(key: string): void {
    for (const k of [...this.owned.keys()]) if (k.startsWith(`${key}\u0000`)) this.owned.delete(k);
    for (const k of [...this.held.keys()]) if (k.startsWith(`${key}\u0000`)) this.held.delete(k);
  }

  /** Each body's last report, or a check (the fill read, nothing written) for a body without one. */
  reports(w: WaterWorld, bodies: readonly SceneWaterBody[]): WaterBodyReport[] {
    let fw: FillWorld | null = null;
    return bodies.flatMap((b) => {
      const held = this.held.get(`${w.key}\u0000${b.entityId}`);
      const spec = waterSpecOf(b);
      if (held !== undefined && this.owned.get(`${w.key}\u0000${b.entityId}`)?.spec === JSON.stringify(spec)) return [held];
      if (spec === null) return [];
      fw ??= waterFillWorld(w);
      const bw = bodyFillWorld(fw, w, spec);
      const owned = bodyCells(spec, bw);
      const g = regenerateBody(spec, bw, owned);
      // A check: what a regenerate would write is not written; the body's state is the fill's.
      const report: WaterBodyReport = { entityId: b.entityId, status: g.fill.status, cells: owned.size, leaks: g.fill.status === 'breached' ? leaksOf(g.fill) : [], via: 'check', written: 0 };
      this.keep(w, b.entityId, spec, owned, report);
      return [report];
    });
  }
}
