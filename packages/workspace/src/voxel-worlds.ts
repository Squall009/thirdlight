/**
 * A project's voxel worlds, as the backend serves and edits them: each
 * world is a folder `voxels/<name>/` in the project holding `world.json`
 * (its format, id, chunk edge, region layout and footprint, the world
 * grid's region files, and a revision that moves with every applied
 * change) and the world grid's region files under `grid-0/`.
 *
 * The manifest says which region files the world has: a region it does not
 * list is all air, and one it lists that is missing or unreadable is
 * damaged (reported, never read as air), so a lost tile cannot pass as
 * empty sky.
 *
 * Edits arrive as commands (`editVoxels`: one stroke command, the same
 * format and the same deterministic apply as everywhere else;
 * `undoVoxels`: the newest edit's undo record written back as a new
 * change). Each command is applied to the world in memory, its dirty
 * region files are replaced atomically, then the revision is written. A
 * client never writes files: it reads region files by range and re-reads
 * the chunks a command reports changed.
 *
 * Commands of one world run one at a time in arrival order. A request id
 * seen again answers the first answer (a resent stroke is not applied
 * twice). Undo records live in memory up to the voxel package's budget and
 * spill to the project's cache folder; they last as long as the world is
 * open in this process.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { REQUEST_ID_RE } from '@thirdlight/project-model/request-id';
import {
  canonicalEditCommand,
  chunkGrid,
  CHUNK_EDGES,
  editBounds,
  EditCommandError,
  EditRefused,
  liftVersion,
  UndoStore,
  WORLD_GRID_ID,
  WORLD_ID_BYTES,
  type CellBox,
  type ChunkCoord,
  type ChunkEdge,
  type ChunkUndo,
  type PaletteStore,
  type RegionFootprint,
  type RegionLayout,
} from '@thirdlight/voxel';
import { sha256HexNative } from './digest';
import { DiskUndoSpill, RegionWorld, addressName, addressOf, type WorldDirOptions } from './voxel-world-files';
import { writeAtomic } from './write';

/** The project folder holding its voxel worlds, one folder each. */
export const VOXEL_WORLDS_FOLDER = 'voxels';
/** A world's description and revision, next to its grids' folders. */
export const VOXEL_WORLD_MANIFEST = 'world.json';
/** The world manifest's format; a newer one is refused, an older one lifted ({@link liftManifest}). */
export const VOXEL_WORLD_FORMAT = 2;
/** A world's folder name. */
export const VOXEL_WORLD_NAME_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
/** A region file's name as the region writer makes it. */
export const REGION_FILE_NAME_RE = /^[a-z0-9_.-]{1,64}\.vxr$/;
/** The commands a voxel world takes. */
export const VOXEL_WORLD_OPS = ['editVoxels', 'undoVoxels'] as const;
export type VoxelWorldOp = (typeof VOXEL_WORLD_OPS)[number];
/** Answers kept per world for request ids sent again. */
const ANSWERS_KEPT = 256;

/** The folder of a grid's region files inside a world's folder. */
export function gridFolder(gridId: number): string {
  return `grid-${gridId}`;
}

export interface VoxelWorldManifest {
  readonly format: number;
  /** The world id the region files carry (hex, 16 bytes). */
  readonly worldId: string;
  readonly edge: ChunkEdge;
  readonly layout: RegionLayout;
  readonly footprint: RegionFootprint;
  /** The world grid's region files (sorted names): any other region is air. */
  readonly regions: readonly string[];
  /** Moves by one with every applied change. */
  readonly revision: number;
}

export function isVoxelWorldOp(op: unknown): op is VoxelWorldOp {
  return typeof op === 'string' && (VOXEL_WORLD_OPS as readonly string[]).includes(op);
}

/**
 * A manifest of an older format lifted to this one, add-only. Format 1
 * listed no region files: lifting it lists the world grid's region files in
 * the folder at that moment (the most an old world can say).
 */
export function liftManifest(value: Record<string, unknown>, worldDir: string): Record<string, unknown> {
  const format = value.format;
  if (typeof format !== 'number' || !Number.isInteger(format) || format < 1) throw new Error(`unknown world manifest format ${String(format)}`);
  const steps = [{ from: 1, lift: (o: Record<string, unknown>) => ({ ...o, format: 2, regions: listRegionFiles(join(worldDir, gridFolder(WORLD_GRID_ID))) }) }];
  return liftVersion('world manifest', format, VOXEL_WORLD_FORMAT, steps, value, (o) => o.format as number);
}

function listRegionFiles(dir: string): string[] {
  return existsSync(dir) ? readdirSync(dir).filter((n) => REGION_FILE_NAME_RE.test(n)).sort() : [];
}

/** Reads a manifest of this format, refusing anything but its exact fields. */
export function parseVoxelWorldManifest(value: unknown): VoxelWorldManifest {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('a world manifest is an object');
  const o = value as Record<string, unknown>;
  const keys = Object.keys(o).sort().join(',');
  if (keys !== 'edge,footprint,format,layout,regions,revision,worldId') throw new Error(`world manifest fields ${keys}`);
  if (o.format !== VOXEL_WORLD_FORMAT) throw new Error(`unknown world manifest format ${String(o.format)}`);
  const regions = o.regions;
  if (!Array.isArray(regions) || regions.some((n, i) => typeof n !== 'string' || !REGION_FILE_NAME_RE.test(n) || (i > 0 && regions[i - 1] >= n))) throw new Error('regions is a sorted list of region file names, each once');
  if (typeof o.worldId !== 'string' || !new RegExp(`^[0-9a-f]{${WORLD_ID_BYTES * 2}}$`).test(o.worldId)) throw new Error('worldId is 32 hex digits');
  if (!(CHUNK_EDGES as readonly unknown[]).includes(o.edge)) throw new Error(`chunk edge ${String(o.edge)}`);
  if (o.layout !== 'stacked' && o.layout !== 'column') throw new Error(`layout ${String(o.layout)}`);
  if (o.footprint !== 512 && o.footprint !== 1024) throw new Error(`footprint ${String(o.footprint)} (cells a region side)`);
  if (typeof o.revision !== 'number' || !Number.isSafeInteger(o.revision) || o.revision < 0) throw new Error('revision is a whole number ≥ 0');
  return { format: VOXEL_WORLD_FORMAT, worldId: o.worldId, edge: o.edge as ChunkEdge, layout: o.layout, footprint: o.footprint, regions: regions as string[], revision: o.revision };
}

function manifestBytes(m: VoxelWorldManifest): Uint8Array {
  const ordered = { format: m.format, worldId: m.worldId, edge: m.edge, layout: m.layout, footprint: m.footprint, regions: m.regions, revision: m.revision };
  return new TextEncoder().encode(`${JSON.stringify(ordered, null, 2)}\n`);
}

function hexBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/**
 * Writes a new world folder from a store's chunks: the world grid's region
 * files, then the manifest at revision 0. Refuses a folder that already
 * holds a world.
 */
export function writeVoxelWorld(dir: string, m: Omit<VoxelWorldManifest, 'format' | 'revision' | 'regions'>, store: PaletteStore): { files: number } {
  if (existsSync(join(dir, VOXEL_WORLD_MANIFEST))) throw new Error(`${dir} already holds a voxel world`);
  let manifest = parseVoxelWorldManifest({ format: VOXEL_WORLD_FORMAT, revision: 0, regions: [], ...m });
  if (store.grid.edge !== manifest.edge) throw new Error(`the store's chunk edge ${store.grid.edge} is not the world's ${manifest.edge}`);
  const world = RegionWorld.create(join(dir, gridFolder(WORLD_GRID_ID)), worldOptions(manifest), store);
  manifest = { ...manifest, regions: world.listedRegions() };
  const out = writeAtomic({ dir, target: VOXEL_WORLD_MANIFEST, bytes: manifestBytes(manifest), allowedPreHashes: null, previousHash: null });
  if (!out.ok) throw new Error(`${join(dir, VOXEL_WORLD_MANIFEST)}: not written`);
  return { files: world.files.size };
}

function worldOptions(m: VoxelWorldManifest): WorldDirOptions {
  return { grid: chunkGrid(m.edge), worldId: hexBytes(m.worldId), layout: m.layout, footprint: m.footprint, gridId: WORLD_GRID_ID };
}

/** Why a world, a file or a command was refused. */
export interface VoxelWorldError {
  readonly code: string;
  readonly cls: 'validation' | 'conflict' | 'not_found' | 'internal';
  readonly message: string;
  readonly path?: string;
}

/** A world's manifest and its listed region files with their tags (null: listed, but missing or unreadable). */
export type VoxelWorldInfo = { ok: true; world: string; manifest: VoxelWorldManifest; files: Array<{ name: string; etag: string | null }> } | { ok: false; error: VoxelWorldError };

export type RegionFileAnswer = { ok: true; path: string; etag: string } | { ok: false; error: VoxelWorldError };

/** What an applied voxel command answers. */
export interface VoxelCommandApplied {
  readonly ok: true;
  readonly op: VoxelWorldOp;
  readonly requestId: string | null;
  readonly world: string;
  /** The world's revision after the change. */
  readonly revision: number;
  /** Cells whose voxel changed. */
  readonly cells: number;
  /** The chunks whose content changed ([cx, cy, cz] each): what a client re-reads. */
  readonly chunks: ReadonlyArray<readonly [number, number, number]>;
  /**
   * The cells the change can have touched (inclusive; an undo answers the
   * box of the edit it undoes): what a client derives again from, only the
   * results within the rules' radius of it.
   */
  readonly box: Readonly<CellBox>;
  /** The region files rewritten, with their new entity tags. */
  readonly files: ReadonlyArray<{ readonly name: string; readonly etag: string | null }>;
  /** Edits that can still be undone. */
  readonly undoable: number;
  /** True when this answers a request id seen before (nothing was applied again). */
  readonly duplicated: boolean;
  /** Milliseconds: the apply, and the region and manifest writes. */
  readonly ms: { readonly apply: number; readonly save: number };
}

export type VoxelCommandResult = VoxelCommandApplied | { ok: false; error: VoxelWorldError };

interface OpenWorld {
  readonly name: string;
  readonly dir: string;
  manifest: VoxelWorldManifest;
  /** Hash of the manifest's bytes as this process last read or wrote them. */
  manifestHash: string;
  readonly world: RegionWorld;
  readonly undo: UndoStore;
  /** Undo record ids, the cells their edit changed and the box it could change, newest last. */
  readonly history: Array<{ readonly id: number; readonly cells: number; readonly box: Readonly<CellBox> }>;
  readonly answers: Map<string, VoxelCommandApplied>;
  queue: Promise<unknown>;
}

const refuse = (code: string, cls: VoxelWorldError['cls'], message: string, path?: string): { ok: false; error: VoxelWorldError } => ({ ok: false, error: { code, cls, message, ...(path !== undefined ? { path } : {}) } });

export interface VoxelWorldsOptions {
  /** The project's folder (null: the project cannot be opened). */
  projectDir(projectId: string): string | null;
}

/** The voxel worlds of every project this process serves, opened on first use. */
export class VoxelWorlds {
  private readonly open = new Map<string, Promise<OpenWorld | { ok: false; error: VoxelWorldError }>>();

  constructor(private readonly opts: VoxelWorldsOptions) {}

  private load(projectId: string, name: string): Promise<OpenWorld | { ok: false; error: VoxelWorldError }> {
    if (!VOXEL_WORLD_NAME_RE.test(name)) return Promise.resolve(refuse('invalid_request', 'validation', `a world name matches ${VOXEL_WORLD_NAME_RE.source}`, '/world'));
    const key = `${projectId}\u0000${name}`;
    let p = this.open.get(key);
    if (p === undefined) {
      p = this.openWorld(projectId, name);
      this.open.set(key, p);
      // A world that could not be opened is tried again next time (it may be written meanwhile).
      void p.then((w) => {
        if ('ok' in w) this.open.delete(key);
      });
    }
    return p;
  }

  private async openWorld(projectId: string, name: string): Promise<OpenWorld | { ok: false; error: VoxelWorldError }> {
    const projectDir = this.opts.projectDir(projectId);
    if (projectDir === null) return refuse('project_not_found', 'not_found', `project ${projectId} cannot be opened`);
    const dir = join(projectDir, VOXEL_WORLDS_FOLDER, name);
    let manifest: VoxelWorldManifest;
    let manifestHash: string;
    try {
      const bytes = readFileSync(join(dir, VOXEL_WORLD_MANIFEST));
      manifestHash = sha256HexNative(bytes);
      manifest = parseVoxelWorldManifest(liftManifest(JSON.parse(bytes.toString('utf8')) as Record<string, unknown>, dir));
    } catch (e) {
      if (!existsSync(join(dir, VOXEL_WORLD_MANIFEST))) return refuse('world_not_found', 'not_found', `project ${projectId} has no voxel world ${name}`);
      return refuse('world_unreadable', 'internal', `voxel world ${name}: ${e instanceof Error ? e.message : String(e)}`);
    }
    const opts = worldOptions(manifest);
    const { world } = await RegionWorld.open(join(dir, gridFolder(WORLD_GRID_ID)), opts, [], manifest.regions);
    // Undo records of an earlier run are gone with it: the folder starts empty.
    const spillDir = join(projectDir, 'cache', 'voxel-undo', name);
    rmSync(spillDir, { recursive: true, force: true });
    mkdirSync(spillDir, { recursive: true });
    return { name, dir, manifest, manifestHash, world, undo: new UndoStore(opts.grid, new DiskUndoSpill(spillDir)), history: [], answers: new Map(), queue: Promise.resolve() };
  }

  /** The world's manifest and its region files with their entity tags. */
  async info(projectId: string, name: string): Promise<VoxelWorldInfo> {
    const w = await this.load(projectId, name);
    if ('ok' in w) return w;
    const files = w.world.listedRegions().map((file) => ({ name: file, etag: w.world.files.get(file)?.hash ?? null }));
    return { ok: true, world: name, manifest: w.manifest, files };
  }

  /**
   * Where a region file is and its entity tag (the hash of its bytes as
   * this process wrote or read them). A region the world does not list is
   * not found: a client reads its chunks as air. A listed region that is
   * missing or unreadable is refused as damaged: a client reports its chunks.
   */
  async regionFile(projectId: string, name: string, file: string): Promise<RegionFileAnswer> {
    if (!REGION_FILE_NAME_RE.test(file)) return refuse('invalid_request', 'validation', 'not a region file name', '/file');
    const w = await this.load(projectId, name);
    if ('ok' in w) return w;
    const broken = w.world.damagedRegions.get(file);
    if (broken !== undefined) return refuse('region_damaged', 'conflict', `voxel world ${name} lists region ${file}, which cannot be read: ${broken}`);
    const f = w.world.files.get(file);
    if (f === undefined || f.hash === null) return refuse('region_not_found', 'not_found', `voxel world ${name} has no region ${file}`);
    return { ok: true, path: join(w.world.dir, file), etag: f.hash };
  }

  /**
   * Applies a voxel command envelope (`op`, `projectId`, optional
   * `requestId`, `args`: `{ world, command }` for an edit, `{ world }` for
   * an undo). A command that changes nothing is refused with `no_change`.
   */
  async command(projectId: string, envelope: Record<string, unknown>): Promise<VoxelCommandResult> {
    const op = envelope.op;
    if (!isVoxelWorldOp(op)) return refuse('invalid_request', 'validation', 'not a voxel world op', '/op');
    if (envelope.projectId !== projectId) return refuse('invalid_request', 'validation', 'projectId must name the project of the route', '/projectId');
    const rid = envelope.requestId;
    if (rid !== undefined && (typeof rid !== 'string' || !REQUEST_ID_RE.test(rid))) return refuse('invalid_request', 'validation', 'requestId must be req- + 32 hex', '/requestId');
    const args = envelope.args;
    if (typeof args !== 'object' || args === null || Array.isArray(args)) return refuse('invalid_request', 'validation', 'args must be an object', '/args');
    const a = args as Record<string, unknown>;
    const allowed = op === 'editVoxels' ? ['world', 'command'] : ['world'];
    const extra = Object.keys(a).find((k) => !allowed.includes(k));
    if (extra !== undefined) return refuse('invalid_request', 'validation', `unknown field ${extra}`, `/args/${extra}`);
    if (typeof a.world !== 'string') return refuse('invalid_request', 'validation', 'args.world names the voxel world', '/args/world');
    const w = await this.load(projectId, a.world);
    if ('ok' in w) return w;
    const run = w.queue.then(() => this.apply(w, op, a, rid ?? null));
    w.queue = run.catch(() => undefined);
    return run;
  }

  private async apply(w: OpenWorld, op: VoxelWorldOp, a: Record<string, unknown>, requestId: string | null): Promise<VoxelCommandResult> {
    if (requestId !== null) {
      const seen = w.answers.get(requestId);
      if (seen !== undefined) return { ...seen, duplicated: true };
    }
    const t0 = performance.now();
    let record: readonly ChunkUndo[];
    let cells: number;
    let box: Readonly<CellBox>;
    let undone: { readonly id: number; readonly cells: number; readonly box: Readonly<CellBox> } | null = null;
    if (op === 'editVoxels') {
      try {
        const cmd = canonicalEditCommand(a.command);
        const out = w.world.edit(cmd);
        if (out.cells === 0) return refuse('no_change', 'validation', 'the stroke changes no voxel');
        record = out.chunks;
        cells = out.cells;
        box = editBounds(w.world.opts.grid, cmd);
      } catch (e) {
        if (e instanceof EditCommandError) return refuse('invalid_args', 'validation', e.message, `/args/command${e.path}`);
        if (e instanceof EditRefused) return refuse(e.code, e.code === 'chunk_not_loaded' ? 'conflict' : 'validation', e.message);
        throw e;
      }
    } else {
      undone = w.history.pop() ?? null;
      if (undone === null) return refuse('nothing_to_undo', 'validation', `voxel world ${w.name} has no edit to undo`);
      record = await w.undo.take(undone.id);
      w.world.undo(record);
      cells = undone.cells;
      box = undone.box;
    }
    const t1 = performance.now();
    let written: Map<string, string | null>;
    try {
      written = this.save(w);
    } catch (e) {
      // Memory goes back to what the files hold; the chunks stay dirty and the next save writes them again.
      if (op === 'editVoxels') w.world.undo(record);
      else if (undone !== null) w.history.push({ id: await w.undo.put(record), cells, box });
      return refuse('write_failed', 'internal', `voxel world ${w.name}: ${e instanceof Error ? e.message : String(e)}`);
    }
    if (op === 'editVoxels') w.history.push({ id: await w.undo.put(record), cells, box });
    const chunks = record.map((u) => [u.cx, u.cy, u.cz] as const);
    const files = [...new Set(record.map((u) => this.fileName(w, u)))].sort().map((name) => ({ name, etag: written.get(name) ?? w.world.files.get(name)?.hash ?? null }));
    const answer: VoxelCommandApplied = { ok: true, op, requestId, world: w.name, revision: w.manifest.revision, cells, chunks, box, files, undoable: w.history.length, duplicated: false, ms: { apply: t1 - t0, save: performance.now() - t1 } };
    if (requestId !== null) {
      w.answers.set(requestId, answer);
      if (w.answers.size > ANSWERS_KEPT) w.answers.delete(w.answers.keys().next().value!);
    }
    return answer;
  }

  private fileName(w: OpenWorld, c: ChunkCoord): string {
    return addressName(addressOf(w.world.opts.grid, w.manifest.layout, w.manifest.footprint, c));
  }

  /** Replaces the dirty region files, then writes the next revision; returns the new tags by file. */
  private save(w: OpenWorld): Map<string, string | null> {
    const tags = new Map<string, string | null>();
    for (const p of w.world.prepareSaves()) {
      const r = w.world.commit(p);
      if (!r.ok) throw new Error(`region ${p.name}: ${r.why ?? 'not written'}`);
      tags.set(p.name, w.world.files.get(p.name)?.hash ?? null);
    }
    const next: VoxelWorldManifest = { ...w.manifest, regions: w.world.listedRegions(), revision: w.manifest.revision + 1 };
    const bytes = manifestBytes(next);
    const out = writeAtomic({ dir: w.dir, target: VOXEL_WORLD_MANIFEST, bytes, allowedPreHashes: [w.manifestHash], previousHash: w.manifestHash });
    if (!out.ok) throw new Error(`${VOXEL_WORLD_MANIFEST}: ${out.external !== undefined ? 'changed on disk by someone else' : 'not written'}`);
    w.manifest = next;
    w.manifestHash = sha256HexNative(bytes);
    w.world.flushRemovals();
    return tags;
  }

  /** Forgets a project's open worlds (closed, released or unregistered). */
  close(projectId?: string): void {
    for (const key of [...this.open.keys()]) if (projectId === undefined || key.startsWith(`${projectId}\u0000`)) this.open.delete(key);
  }
}
