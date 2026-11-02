/**
 * Applying a voxel edit command: the one function the editor's commands,
 * MCP and a game's runtime set/dig all go through.
 *
 * - **Deterministic.** A cell's new voxel is a function of its old voxel and
 *   the command only (never of its neighbours or of the order cells are
 *   visited), computed with exactly rounded arithmetic, so the same command
 *   on the same voxels gives the same voxels everywhere, and chunks can be
 *   applied in any order or apart.
 * - **Per chunk.** The command's bounds are cut into chunks; each chunk's
 *   cells are visited in local-index order and its changes recorded on their
 *   own, so an undo record, dirty marks and rebuilds are per chunk.
 * - **All or nothing.** Everything that can refuse (grid, stamp, loaded
 *   chunks, world bounds) is checked before the first write.
 * - **Undo is its before-image.** Each changed chunk keeps the cells it had
 *   (or, when that is smaller, its whole canonical image). Undoing writes
 *   them back; redoing applies the command again, which gives the same
 *   voxels because the state is the one it was first applied to.
 *
 * A command that changes no cell reports 0 cells and an empty record; the
 * command layer refuses it as `no_change`.
 */
import { chunkKey, chunkOfKey, cellInWorld, type ChunkCoord, type ChunkGrid } from './coords';
import { CellDelta, chunkScratch, deltaValue, DELTA_CELL_BYTES, encodeDenseChunk, exportOrAir } from './cell-delta';
import { type BrushEdit, type EditMode, type EditVoxel, type StampEdit, type VoxelEditCommand } from './edit-command';
import { scratchImage, uniformImage } from './palette-chunk';
import { encodePaletteImage } from './palette-codec';
import { ALL_PLANES, MATERIAL_AIR, SHAPE_FULL, VOXEL_CATEGORY, type VoxelRecord } from './record';
import type { StampResolver, StampShape } from './stamp-shape';
import type { VoxelStoreCandidate } from './store';
import type { CellBox } from './stroke';
import { impliedShape } from './surface-density';

/** The stores an edit writes, by grid id (0 the world grid, else a structure's grid). */
export interface EditGrids {
  store(gridId: number): VoxelStoreCandidate | undefined;
}

export interface EditOptions {
  /** Stamp shapes by id (needed by stamp commands). */
  readonly stamps?: StampResolver;
  /** When given, every chunk the edit can touch must be loaded; otherwise the edit is refused before any write. */
  readonly loaded?: (gridId: number, cx: number, cy: number, cz: number) => boolean;
}

/** One chunk as it was before an edit: its changed cells' old voxels, or its whole image (null: it was absent, all air). */
export type ChunkBefore = { readonly kind: 'delta'; readonly delta: CellDelta } | { readonly kind: 'image'; readonly bytes: Uint8Array | null };

/** A chunk an edit changed, with what undoing it writes back. */
export interface ChunkUndo {
  readonly grid: number;
  readonly cx: number;
  readonly cy: number;
  readonly cz: number;
  readonly before: ChunkBefore;
}

export interface EditOutcome {
  /** Cells whose voxel changed (0: the command changed nothing). */
  readonly cells: number;
  /** Changed chunks in key order: the undo record and the chunks to rebuild and save. */
  readonly chunks: readonly ChunkUndo[];
}

/** Why an edit could not be applied (nothing was written). */
export type EditRefusal = 'grid_unknown' | 'chunk_not_loaded' | 'stamp_unknown' | 'stamp_changed' | 'outside_world';

export class EditRefused extends Error {
  override readonly name = 'EditRefused';
  constructor(
    readonly code: EditRefusal,
    message: string,
  ) {
    super(message);
  }
}

/**
 * A chunk that was absent (air) or one voxel everywhere before an edit has
 * a before-image of 0 or 13 bytes, known without encoding (when the store
 * tells its chunk form). A chunk with stored cells is compared with its
 * encoded before-image only once the delta outgrows the smallest image such
 * a chunk can have (its cells at one bit each), and at least this many
 * bytes: the encode costs ~0.5 ms at 32³, which a small stroke must not pay
 * for nothing.
 */
export const UNDO_IMAGE_CHECK_BYTES = 1024;

/** How much of a cell (0 … 1) a stroke covers, for cells of one chunk. */
type Cover = (x: number, y: number, z: number) => number;

/** What a command does in one chunk: its cells' coverage, or listed cells. */
interface Plan {
  readonly box: CellBox;
  readonly mode: EditMode;
  readonly smooth: boolean;
  /** The voxel written (absent for a dig). */
  readonly voxel?: EditVoxel;
  /** The exact shape written (set only). */
  readonly shape?: number;
  /** Coverage for the cells of one chunk, or null when the stroke cannot reach it. */
  readonly cover?: (grid: ChunkGrid, cx: number, cy: number, cz: number) => Cover | null;
  /** Listed cells by chunk key, local indices ascending (set and dig). */
  readonly cells?: Map<number, number[]>;
}

function emptyBox(): CellBox {
  return { minX: Infinity, minY: Infinity, minZ: Infinity, maxX: -Infinity, maxY: -Infinity, maxZ: -Infinity };
}

function grow(b: CellBox, x0: number, y0: number, z0: number, x1: number, y1: number, z1: number): void {
  b.minX = Math.min(b.minX, x0);
  b.minY = Math.min(b.minY, y0);
  b.minZ = Math.min(b.minZ, z0);
  b.maxX = Math.max(b.maxX, x1);
  b.maxY = Math.max(b.maxY, y1);
  b.maxZ = Math.max(b.maxZ, z1);
}

const clamp01 = (v: number): number => (v <= 0 ? 0 : v >= 1 ? 1 : v);

/**
 * Coverage of the cell whose centre is (px, py, pz) by one dab at (cx, cy, cz):
 * the depth of the centre inside the shape plus half a cell, clamped, so a
 * hard stroke takes a cell when its centre is inside and a smooth one fades
 * over the cell at the rim.
 */
function dabCover(shape: BrushEdit['shape'], ex: number, ey: number, ez: number, dx: number, dy: number, dz: number): number {
  if (shape === 'sphere') return clamp01(ex - Math.sqrt(dx * dx + dy * dy + dz * dz) + 0.5);
  if (shape === 'cylinder') return clamp01(Math.min(ex - Math.sqrt(dx * dx + dz * dz), ey - Math.abs(dy)) + 0.5);
  return clamp01(Math.min(ex - Math.abs(dx), ey - Math.abs(dy), ez - Math.abs(dz)) + 0.5);
}

function brushPlan(c: BrushEdit): Plan {
  const [ex, ey, ez] = c.size;
  const p = c.points;
  const box = emptyBox();
  // Cells whose centre lies within extent + half a cell of a dab.
  for (let i = 0; i < p.length; i += 3) grow(box, Math.ceil(p[i]! - ex - 1), Math.ceil(p[i + 1]! - ey - 1), Math.ceil(p[i + 2]! - ez - 1), Math.floor(p[i]! + ex), Math.floor(p[i + 1]! + ey), Math.floor(p[i + 2]! + ez));
  const cover = (grid: ChunkGrid, cx: number, cy: number, cz: number): Cover | null => {
    const e = grid.edge;
    const x0 = cx * e;
    const y0 = cy * e;
    const z0 = cz * e;
    const dabs: number[] = [];
    for (let i = 0; i < p.length; i += 3) {
      const x = p[i]!;
      const y = p[i + 1]!;
      const z = p[i + 2]!;
      if (x + ex + 1 < x0 || x - ex - 1 > x0 + e || y + ey + 1 < y0 || y - ey - 1 > y0 + e || z + ez + 1 < z0 || z - ez - 1 > z0 + e) continue;
      dabs.push(x, y, z);
    }
    if (dabs.length === 0) return null;
    return (x, y, z) => {
      let best = 0;
      for (let i = 0; i < dabs.length && best < 1; i += 3) {
        const v = dabCover(c.shape, ex, ey, ez, x + 0.5 - dabs[i]!, y + 0.5 - dabs[i + 1]!, z + 0.5 - dabs[i + 2]!);
        if (v > best) best = v;
      }
      return best;
    };
  };
  return { box, mode: c.mode, smooth: c.smooth, ...(c.voxel !== undefined ? { voxel: c.voxel } : {}), cover };
}

function stampPlan(c: StampEdit, shape: StampShape): Plan {
  const [sx, sy, sz] = shape.size;
  const [ox, oy, oz] = c.origin;
  const [co, si] = c.yaw;
  const k = c.scale;
  const box = emptyBox();
  for (const lx of [0, sx]) for (const ly of [0, sy]) for (const lz of [0, sz]) {
    const wx = ox + k * (co * lx - si * lz);
    const wy = oy + k * ly;
    const wz = oz + k * (si * lx + co * lz);
    grow(box, Math.floor(wx - 1), Math.floor(wy - 1), Math.floor(wz - 1), Math.floor(wx), Math.floor(wy), Math.floor(wz));
  }
  const cov = shape.coverage;
  // Nearest sample of the shape under the cell's centre, mapped back into the stamp's frame.
  const sample: Cover = (x, y, z) => {
    const dx = (x + 0.5 - ox) / k;
    const dy = (y + 0.5 - oy) / k;
    const dz = (z + 0.5 - oz) / k;
    const ix = Math.floor(co * dx + si * dz);
    const iy = Math.floor(dy);
    const iz = Math.floor(co * dz - si * dx);
    if (ix < 0 || iy < 0 || iz < 0 || ix >= sx || iy >= sy || iz >= sz) return 0;
    return cov[(ix * sz + iz) * sy + iy]! / SHAPE_FULL;
  };
  return { box, mode: c.mode, smooth: c.smooth, ...(c.voxel !== undefined ? { voxel: c.voxel } : {}), cover: () => sample };
}

function listPlan(grid: ChunkGrid, cells: readonly number[], mode: EditMode, voxel?: EditVoxel, shape?: number): Plan {
  const box = emptyBox();
  const byChunk = new Map<number, number[]>();
  const s = grid.shift;
  const m = grid.mask;
  for (let i = 0; i < cells.length; i += 3) {
    const x = cells[i]!;
    const y = cells[i + 1]!;
    const z = cells[i + 2]!;
    grow(box, x, y, z, x, y, z);
    const key = chunkKey(grid, x >> s, y >> s, z >> s);
    let list = byChunk.get(key);
    if (list === undefined) byChunk.set(key, (list = []));
    list.push((((x & m) << s) | (z & m)) << s | (y & m));
  }
  for (const [key, list] of byChunk) byChunk.set(key, [...new Set(list)].sort((a, b) => a - b));
  return { box, mode, smooth: false, ...(voxel !== undefined ? { voxel } : {}), ...(shape !== undefined ? { shape } : {}), cells: byChunk };
}

function planOf(grid: ChunkGrid, cmd: VoxelEditCommand, stamps: StampResolver | undefined): Plan {
  switch (cmd.kind) {
    case 'brush':
      return brushPlan(cmd);
    case 'fill': {
      const [x0, y0, z0] = cmd.min;
      const [x1, y1, z1] = cmd.max;
      return { box: { minX: x0, minY: y0, minZ: z0, maxX: x1, maxY: y1, maxZ: z1 }, mode: cmd.mode, smooth: false, ...(cmd.voxel !== undefined ? { voxel: cmd.voxel } : {}), cover: () => () => 1 };
    }
    case 'stamp': {
      const found = stamps?.(cmd.stamp.id);
      if (found === undefined) throw new EditRefused('stamp_unknown', `stamp ${cmd.stamp.id} is not known`);
      if (found.hash !== cmd.stamp.hash) throw new EditRefused('stamp_changed', `stamp ${cmd.stamp.id} has changed since the command was made`);
      return stampPlan(cmd, found.shape);
    }
    case 'set':
      return listPlan(grid, cmd.cells, cmd.voxel.material === MATERIAL_AIR ? 'dig' : 'place', cmd.voxel.material === MATERIAL_AIR ? undefined : cmd.voxel, cmd.voxel.shape);
    case 'dig':
      return listPlan(grid, cmd.cells, 'dig');
  }
}

/**
 * The voxel a stroke leaves in a cell covering `cov` of it, written into
 * `out`; false when the cell stays as it is.
 */
function nextVoxel(plan: Plan, cov: number, old: Readonly<VoxelRecord>, out: VoxelRecord): boolean {
  const smooth = plan.smooth;
  if (!smooth && cov < 0.5) return false;
  const v = plan.voxel;
  const oldAir = old.material === MATERIAL_AIR;
  // Exact shape (set) or full, or the coverage as a density byte at a smooth rim.
  const t = plan.shape ?? (smooth ? (cov >= 1 ? SHAPE_FULL : Math.max(1, Math.round(cov * SHAPE_FULL))) : SHAPE_FULL);
  switch (plan.mode) {
    case 'place':
      out.material = v!.material;
      out.category = v!.category;
      out.orientation = v!.orientation;
      out.shape = t;
      break;
    case 'add': {
      const open = oldAir || old.category === VOXEL_CATEGORY.liquid;
      if (open) {
        out.material = v!.material;
        out.category = v!.category;
        out.orientation = v!.orientation;
        out.shape = t;
      } else if (smooth && old.material === v!.material && old.shape < t) {
        out.material = old.material;
        out.category = old.category;
        out.orientation = old.orientation;
        out.shape = t;
      } else return false;
      break;
    }
    case 'dig': {
      if (oldAir) return false;
      const left = smooth ? Math.min(old.shape, SHAPE_FULL - t) : 0;
      if (left <= 0) {
        out.material = MATERIAL_AIR;
        out.category = 0;
        out.orientation = 0;
        out.shape = 0;
      } else {
        out.material = old.material;
        out.category = old.category;
        out.orientation = old.orientation;
        out.shape = left;
      }
      break;
    }
    case 'paint':
      if (oldAir) return false;
      out.material = v!.material;
      out.category = v!.category;
      out.orientation = v!.orientation;
      out.shape = old.shape === impliedShape(old.material) ? impliedShape(v!.material) : old.shape;
      break;
  }
  return out.material !== old.material || out.category !== old.category || out.orientation !== old.orientation || out.shape !== old.shape;
}

/** Chunk keys of a cell box, in key order (x, then z, then y). */
function chunksOf(grid: ChunkGrid, b: CellBox): ChunkCoord[] {
  const s = grid.shift;
  const out: ChunkCoord[] = [];
  for (let cx = b.minX >> s; cx <= b.maxX >> s; cx++) for (let cz = b.minZ >> s; cz <= b.maxZ >> s; cz++) for (let cy = b.minY >> s; cy <= b.maxY >> s; cy++) out.push({ cx, cy, cz });
  return out;
}

/**
 * The before-record of one chunk from its delta: the delta, or the whole
 * before-image when that is smaller. `form`: the chunk's form before the
 * edit, when the store tells it.
 */
function beforeOf(store: VoxelStoreCandidate, c: ChunkCoord, delta: CellDelta, form: 'absent' | 'uniform' | 'stored' | undefined): ChunkBefore {
  if (form === 'absent') return { kind: 'image', bytes: null };
  if (form === 'uniform') {
    // Every cell held the voxel the first changed cell held.
    const image = encodeUniform(store.grid, delta.values[0]!);
    return image.length < delta.byteLength ? { kind: 'image', bytes: image } : { kind: 'delta', delta: trimmed(delta) };
  }
  const check = Math.max(UNDO_IMAGE_CHECK_BYTES, form === 'stored' ? store.grid.cellsPerChunk / 8 : 0);
  if (delta.byteLength <= check) return { kind: 'delta', delta: trimmed(delta) };
  const cells = exportOrAir(store, c.cx, c.cy, c.cz, chunkScratch(store.grid).cells);
  delta.applyToDense(cells);
  const image = encodeDenseChunk(store.grid, cells);
  if (image === null || image.length < delta.byteLength) return { kind: 'image', bytes: image };
  return { kind: 'delta', delta: trimmed(delta) };
}

/** The codec bytes of a chunk that is one record value everywhere. */
function encodeUniform(grid: ChunkGrid, value: number): Uint8Array {
  const img = scratchImage(grid);
  uniformImage(img, value);
  return encodePaletteImage(img);
}

/** A delta whose arrays are exactly as long as its cells (so memory equals its counted bytes). */
function trimmed(d: CellDelta): CellDelta {
  if (d.cells.length === d.count) return d;
  const t = new CellDelta(d.count);
  t.cells.set(d.cells.subarray(0, d.count));
  t.values.set(d.values.subarray(0, d.count));
  t.shapes.set(d.shapes.subarray(0, d.count));
  t.count = d.count;
  return t;
}

/**
 * The chunks a command (canonical) can touch, in key order: what an edit
 * run off the main thread is sent, and what must be loaded for it. Refuses
 * like {@link applyEdit} (outside the world, unknown or changed stamp).
 */
export function editChunks(grid: ChunkGrid, cmd: VoxelEditCommand, stamps?: StampResolver): ChunkCoord[] {
  return planChunks(grid, planOf(grid, cmd, stamps));
}

/**
 * The cell box a command (canonical) can change: what dependents are
 * invalidated from (every result within the dependency radius of it).
 */
export function editBounds(grid: ChunkGrid, cmd: VoxelEditCommand, stamps?: StampResolver): CellBox {
  return { ...planOf(grid, cmd, stamps).box };
}

function planChunks(grid: ChunkGrid, plan: Plan): ChunkCoord[] {
  const b = plan.box;
  if (!cellInWorld(b.minX, b.minY, b.minZ) || !cellInWorld(b.maxX, b.maxY, b.maxZ)) throw new EditRefused('outside_world', 'the edit reaches outside the world');
  return plan.cells !== undefined ? [...plan.cells.keys()].sort((p, q) => p - q).map((k) => chunkOfKey(grid, k)) : chunksOf(grid, b);
}

/**
 * Applies a command (already canonical: {@link canonicalEditCommand}) and
 * returns the changed cells and the undo record. Refuses with
 * {@link EditRefused} before writing anything.
 */
export function applyEdit(grids: EditGrids, cmd: VoxelEditCommand, opts: EditOptions = {}): EditOutcome {
  const store = grids.store(cmd.grid);
  if (store === undefined) throw new EditRefused('grid_unknown', `grid ${cmd.grid} is not loaded`);
  const grid = store.grid;
  const plan = planOf(grid, cmd, opts.stamps);
  const b = plan.box;
  const chunks = planChunks(grid, plan);
  if (opts.loaded !== undefined) {
    for (const c of chunks) if (!opts.loaded(cmd.grid, c.cx, c.cy, c.cz)) throw new EditRefused('chunk_not_loaded', `chunk (${c.cx}, ${c.cy}, ${c.cz}) of grid ${cmd.grid} is not loaded`);
  }
  const old: VoxelRecord = { material: 0, category: 0, shape: 0, orientation: 0 };
  const next: VoxelRecord = { material: 0, category: 0, shape: 0, orientation: 0 };
  const undo: ChunkUndo[] = [];
  let changed = 0;
  const s = grid.shift;
  const m = grid.mask;
  for (const c of chunks) {
    const ox = c.cx << s;
    const oy = c.cy << s;
    const oz = c.cz << s;
    const delta = new CellDelta();
    const form = store.chunkForm?.(c.cx, c.cy, c.cz);
    const visit = (lx: number, ly: number, lz: number, cov: number): void => {
      const x = ox + lx;
      const y = oy + ly;
      const z = oz + lz;
      store.voxelAt(x, y, z, old);
      if (!nextVoxel(plan, cov, old, next)) return;
      delta.push((((lx << s) | lz) << s) | ly, deltaValue(old), old.material === MATERIAL_AIR ? 0 : old.shape);
      store.setVoxel(x, y, z, next);
    };
    const listed = plan.cells?.get(chunkKey(grid, c.cx, c.cy, c.cz));
    if (listed !== undefined) {
      for (const i of listed) visit(i >>> (s << 1), i & m, (i >>> s) & m, 1);
    } else {
      const cover = plan.cover!(grid, c.cx, c.cy, c.cz);
      if (cover === null) continue;
      const x0 = Math.max(b.minX, ox) - ox;
      const x1 = Math.min(b.maxX, ox + m) - ox;
      const y0 = Math.max(b.minY, oy) - oy;
      const y1 = Math.min(b.maxY, oy + m) - oy;
      const z0 = Math.max(b.minZ, oz) - oz;
      const z1 = Math.min(b.maxZ, oz + m) - oz;
      for (let lx = x0; lx <= x1; lx++) for (let lz = z0; lz <= z1; lz++) for (let ly = y0; ly <= y1; ly++) {
        const cov = cover(ox + lx, oy + ly, oz + lz);
        if (cov > 0) visit(lx, ly, lz, cov);
      }
    }
    if (delta.count === 0) continue;
    changed += delta.count;
    undo.push({ grid: cmd.grid, cx: c.cx, cy: c.cy, cz: c.cz, before: beforeOf(store, c, delta, form) });
  }
  return { cells: changed, chunks: undo };
}

/**
 * Writes an undo record's before-images back (the undo transaction). The
 * chunks must be loaded and as the edit left them (history is last in,
 * first out); returns the chunks written, for rebuilds and dirty marks.
 */
export function applyUndo(grids: EditGrids, record: readonly ChunkUndo[]): ChunkUndo[] {
  for (const u of record) if (grids.store(u.grid) === undefined) throw new EditRefused('grid_unknown', `grid ${u.grid} is not loaded`);
  for (const u of record) {
    const store = grids.store(u.grid)!;
    if (u.before.kind === 'delta') u.before.delta.applyToStore(store, u.cx, u.cy, u.cz);
    else if (u.before.bytes === null) store.dropChunk(u.cx, u.cy, u.cz);
    else store.decodeChunk(u.cx, u.cy, u.cz, u.before.bytes);
  }
  return [...record];
}

/** Bytes an undo record holds (what the undo budget counts). */
export function undoRecordBytes(record: readonly ChunkUndo[]): number {
  let n = 0;
  for (const u of record) n += UNDO_CHUNK_HEADER_BYTES + (u.before.kind === 'delta' ? u.before.delta.count * DELTA_CELL_BYTES : (u.before.bytes?.length ?? 0));
  return n;
}

/** Bytes of one chunk's header in an encoded undo record (grid u32, cx cy cz i16, kind u8, length u32). */
export const UNDO_CHUNK_HEADER_BYTES = 15;
