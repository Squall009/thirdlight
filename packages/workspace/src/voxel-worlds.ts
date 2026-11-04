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
 * change). Each command is applied to the world in memory, then its dirty
 * region files and the next revision of the manifest are written as one
 * staged change: every file is written beside its target first, and only
 * when all are on disk are they renamed into place, the manifest last. A
 * failed write leaves files, memory and undo history as before the command;
 * a rename failing midway is reported with the files it reached. A client
 * never writes files: it reads region files by range and re-reads the
 * chunks a command reports changed.
 *
 * Files someone else changes (a git checkout or pull, a restore) are found
 * by their stamps before the next command or read: the world is read again
 * and the command meeting the change is refused (`world_changed`), so no
 * edit is written over files this process has not seen.
 *
 * Commands of one world run one at a time in arrival order. A request id
 * seen again answers the first answer (a resent stroke is not applied
 * twice). Undo records live in memory up to the voxel package's budget (per
 * open world) and spill to the project's cache folder; they last as long as
 * the world is open in this process.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { REQUEST_ID_RE } from '@thirdlight/project-model/request-id';
import {
  canonicalEditCommand,
  chunkGrid,
  CHUNK_EDGES,
  editBounds,
  fieldsFeed,
  materialSwap,
  swapFrom,
  swapTo,
  EditCommandError,
  EditRefused,
  isRegionFootprint,
  REGION_FOOTPRINTS,
  liftVersion,
  UndoStore,
  VOXEL_WORLD_NAME_RE,
  WORLD_GRID_ID,
  WORLD_ID_BYTES,
  type CellBox,
  type ChunkCoord,
  type ChunkEdge,
  type ChunkUndo,
  type PaletteStore,
  type RegionFootprint,
  type RegionLayout,
  type VoxelEditCommand,
} from '@thirdlight/voxel';
import { isVoxelWorldOp, type VoxelWorldOp } from '@thirdlight/commands/mutation-ops';
import { parseOrigin } from '@thirdlight/commands';
import { hexToBytes } from '@thirdlight/shared';
import { sha256HexNative } from './digest';
import { DiskUndoSpill, listRegionFiles, REGION_FILE_NAME_RE, RegionWorld, ShippedWorld, addressName, addressOf, type StagedOutcome, type WorldDirOptions } from './voxel-world-files';
import { writeAtomic, type WriteOps } from './write';

/** The project folder holding its voxel worlds, one folder each. */
export const VOXEL_WORLDS_FOLDER = 'voxels';
/** A world's description and revision, next to its grids' folders. */
export const VOXEL_WORLD_MANIFEST = 'world.json';
/** The world manifest's format; a newer one is refused, an older one lifted ({@link liftManifest}). */
export const VOXEL_WORLD_FORMAT = 2;
/**
 * The voxel world ops' arguments, as {@link VoxelWorlds.command} reads them
 * (unknown fields refused). `world` names the folder `voxels/<world>/`.
 */
export type VoxelWorldOpArgs =
  | {
      op: 'editVoxels';
      /** One stroke; `command` is the voxel edit command format (`v`, `grid`, `kind`, …), rebuilt field by field. */
      args: { world: string; command: VoxelEditCommand };
    }
  | {
      op: 'undoVoxels';
      /** Takes back the world's newest edit still in this backend's undo history. */
      args: { world: string };
    };

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
  if (!isRegionFootprint(o.footprint)) throw new Error(`footprint ${String(o.footprint)} (cells a region side, one of ${REGION_FOOTPRINTS.join(', ')})`);
  if (typeof o.revision !== 'number' || !Number.isSafeInteger(o.revision) || o.revision < 0) throw new Error('revision is a whole number ≥ 0');
  return { format: VOXEL_WORLD_FORMAT, worldId: o.worldId, edge: o.edge as ChunkEdge, layout: o.layout, footprint: o.footprint as RegionFootprint, regions: regions as string[], revision: o.revision };
}

function manifestBytes(m: VoxelWorldManifest): Uint8Array {
  const ordered = { format: m.format, worldId: m.worldId, edge: m.edge, layout: m.layout, footprint: m.footprint, regions: m.regions, revision: m.revision };
  return new TextEncoder().encode(`${JSON.stringify(ordered, null, 2)}\n`);
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
  return { grid: chunkGrid(m.edge), worldId: hexToBytes(m.worldId), layout: m.layout, footprint: m.footprint, gridId: WORLD_GRID_ID };
}

/** A world folder's manifest, lifted to this format and checked; throws when it is missing or refused. */
export function readVoxelWorldManifest(dir: string): VoxelWorldManifest {
  const bytes = readFileSync(join(dir, VOXEL_WORLD_MANIFEST));
  return parseVoxelWorldManifest(liftManifest(JSON.parse(bytes.toString('utf8')) as Record<string, unknown>, dir));
}

/**
 * The shipped world a game save is made against, from a world folder: its
 * world grid's region files as its manifest lists them, each checked
 * against the world id and tile it must hold.
 */
export function openShippedWorld(dir: string): ShippedWorld {
  const m = readVoxelWorldManifest(dir);
  return new ShippedWorld(join(dir, gridFolder(WORLD_GRID_ID)), worldOptions(m), m.regions);
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

/** A world's files as an export ships them (`VoxelWorlds.shippedFiles`). */
export type ShippedWorldFiles =
  | { ok: true; world: { world: string; worldId: string; edge: ChunkEdge; layout: RegionLayout; footprint: RegionFootprint; revision: number }; files: Array<{ name: string; path: string; digest: string; byteLength: number }> }
  | { ok: false; code: string; message: string };

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
  /**
   * The derived parts the change makes stale (DERIVED_PART bits of
   * @thirdlight/voxel, from the fields that changed): a client rebuilds
   * only these (only `shader` when only material or wetness changed: the
   * shader data of the chunks within its border of the box, nothing else).
   */
  readonly parts: number;
  /**
   * The distinct material changes (@thirdlight/voxel `materialSwap`: from,
   * to; an undo answers its edit's turned round): what tells a client
   * whether a shader-only change moves cells to another kit's pieces.
   */
  readonly materialSwaps: readonly number[];
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

/** One edit in a world's history: its undo record's id, the cells it changed, the box it could change and the derived parts it made stale. */
interface HistoryEntry {
  readonly id: number;
  readonly cells: number;
  readonly box: Readonly<CellBox>;
  readonly parts: number;
  readonly materialSwaps: readonly number[];
}

/** What a world folder holds as this process last read or wrote it. */
interface WorldState {
  manifest: VoxelWorldManifest;
  /** Hash of the manifest's bytes. */
  manifestHash: string;
  world: RegionWorld;
  undo: UndoStore;
  history: HistoryEntry[];
  /**
   * File stamps (inode, size, change times) of the manifest and every listed
   * region file, by path ('absent' for a missing one): a file whose stamp
   * moved is checked by hash, and one whose bytes differ was changed by
   * someone else (a git checkout, a restore, another program).
   */
  stamps: Map<string, string>;
}

interface OpenWorld extends WorldState {
  readonly projectId: string;
  readonly name: string;
  readonly dir: string;
  readonly answers: Map<string, VoxelCommandApplied>;
  queue: Promise<unknown>;
}

const refuse = (code: string, cls: VoxelWorldError['cls'], message: string, path?: string): { ok: false; error: VoxelWorldError } => ({ ok: false, error: { code, cls, message, ...(path !== undefined ? { path } : {}) } });

export interface VoxelWorldsOptions {
  /** The project's folder (null: the project cannot be opened). */
  projectDir(projectId: string): string | null;
  /** The file operations of region and manifest writes (tests inject failures here). */
  readonly writeOps?: WriteOps;
}

function fileStamp(path: string): string {
  try {
    const s = statSync(path, { bigint: true });
    return `${s.ino}:${s.size}:${s.mtimeNs}:${s.ctimeNs}`;
  } catch {
    return 'absent';
  }
}

/**
 * The voxel worlds of every project this process serves, opened on first
 * use and kept current with their folders: before a command, and before
 * the manifest or a region file is served, the files' stamps are checked,
 * and a world whose files someone else changed is read again (its undo
 * history, which describes the old files, is dropped). A command that
 * meets such a change is refused (`world_changed`) once the world is read
 * again, so a client re-reads what changed before it edits.
 */
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
        if ('ok' in w && this.open.get(key) === p) this.open.delete(key);
      });
    }
    return p;
  }

  private async openWorld(projectId: string, name: string): Promise<OpenWorld | { ok: false; error: VoxelWorldError }> {
    const projectDir = this.opts.projectDir(projectId);
    if (projectDir === null) return refuse('project_not_found', 'not_found', `project ${projectId} cannot be opened`);
    const dir = join(projectDir, VOXEL_WORLDS_FOLDER, name);
    const state = await this.readState(projectDir, dir, name);
    if ('ok' in state) return state;
    return { projectId, name, dir, ...state, answers: new Map(), queue: Promise.resolve() };
  }

  /** Reads a world folder: manifest, region files, a fresh undo store and the files' stamps. */
  private async readState(projectDir: string, dir: string, name: string): Promise<WorldState | { ok: false; error: VoxelWorldError }> {
    let manifest: VoxelWorldManifest;
    let manifestHash: string;
    const manifestPath = join(dir, VOXEL_WORLD_MANIFEST);
    const manifestStamp = fileStamp(manifestPath);
    try {
      const bytes = readFileSync(manifestPath);
      manifestHash = sha256HexNative(bytes);
      manifest = parseVoxelWorldManifest(liftManifest(JSON.parse(bytes.toString('utf8')) as Record<string, unknown>, dir));
    } catch (e) {
      if (!existsSync(manifestPath)) return refuse('world_not_found', 'not_found', `this project has no voxel world ${name}`);
      return refuse('world_unreadable', 'internal', `voxel world ${name}: ${e instanceof Error ? e.message : String(e)}`);
    }
    const opts = worldOptions(manifest);
    const gridDir = join(dir, gridFolder(WORLD_GRID_ID));
    const stamps = new Map<string, string>([[manifestPath, manifestStamp]]);
    // Stamped before the read: a change while reading moves the stamp, and the next check reads the world again.
    for (const file of manifest.regions) stamps.set(join(gridDir, file), fileStamp(join(gridDir, file)));
    const { world } = await RegionWorld.open(gridDir, opts, manifest.regions);
    // Undo records of an earlier run (or of the files before someone else changed them) are gone: the folder starts empty.
    const spillDir = join(projectDir, 'cache', 'voxel-undo', name);
    rmSync(spillDir, { recursive: true, force: true });
    mkdirSync(spillDir, { recursive: true });
    return { manifest, manifestHash, world, undo: new UndoStore(opts.grid, new DiskUndoSpill(spillDir)), history: [], stamps };
  }

  /**
   * The files of a world (the manifest and `files`, by default every listed
   * region) someone else changed since this process last read or wrote
   * them: a moved stamp whose bytes still hash to what this process knows
   * is not a change (the stamp is renewed).
   */
  private changedOnDisk(w: OpenWorld, files?: readonly string[]): string[] {
    const gridDir = w.world.dir;
    const checks: Array<{ name: string; path: string; known: string | null | undefined }> = [{ name: VOXEL_WORLD_MANIFEST, path: join(w.dir, VOXEL_WORLD_MANIFEST), known: w.manifestHash }];
    for (const file of files ?? w.manifest.regions) checks.push({ name: file, path: join(gridDir, file), known: w.world.files.get(file)?.hash });
    const changed: string[] = [];
    for (const c of checks) {
      const stamp = fileStamp(c.path);
      const was = w.stamps.get(c.path);
      if (was === stamp) continue;
      if (was === undefined && stamp === 'absent') continue;
      let now: string | null = null;
      try {
        now = stamp === 'absent' ? null : sha256HexNative(readFileSync(c.path));
      } catch {
        now = null;
      }
      if (c.known !== undefined && now !== null && now === c.known) w.stamps.set(c.path, stamp);
      else changed.push(c.name);
    }
    return changed;
  }

  /**
   * Reads a world again when someone else changed its files; returns the
   * files that changed (empty: none), or why the world cannot be read now
   * (then it is closed, and opened again on next use).
   */
  private async refresh(w: OpenWorld, files?: readonly string[]): Promise<string[] | { ok: false; error: VoxelWorldError }> {
    const changed = this.changedOnDisk(w, files);
    if (changed.length === 0) return changed;
    const projectDir = this.opts.projectDir(w.projectId);
    const state = projectDir === null ? refuse('project_not_found', 'not_found', `project ${w.projectId} cannot be opened`) : await this.readState(projectDir, w.dir, w.name);
    if ('ok' in state) {
      this.forget(w);
      return state;
    }
    Object.assign(w, state);
    return changed;
  }

  private forget(w: OpenWorld): void {
    const key = `${w.projectId}\u0000${w.name}`;
    if (this.open.has(key)) this.open.delete(key);
  }

  /** Runs `fn` after the world's queued commands (reads see no half-applied command). */
  private queued<T>(w: OpenWorld, fn: () => Promise<T>): Promise<T> {
    const run = w.queue.then(fn);
    w.queue = run.catch(() => undefined);
    return run;
  }

  /** The world's manifest and its region files with their entity tags. */
  async info(projectId: string, name: string): Promise<VoxelWorldInfo> {
    const w = await this.load(projectId, name);
    if ('ok' in w) return w;
    return this.queued(w, async (): Promise<VoxelWorldInfo> => {
      const fresh = await this.refresh(w);
      if (!Array.isArray(fresh)) return fresh;
      const files = w.world.listedRegions().map((file) => ({ name: file, etag: w.world.files.get(file)?.hash ?? null }));
      return { ok: true, world: name, manifest: w.manifest, files };
    });
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
    return this.queued(w, async (): Promise<RegionFileAnswer> => {
      // Only a listed file can be stale here; a file the manifest does not list is no part of the world (a new one comes with a changed manifest).
      const fresh = await this.refresh(w, w.manifest.regions.includes(file) ? [file] : []);
      if (!Array.isArray(fresh)) return fresh;
      const broken = w.world.damagedRegions.get(file);
      if (broken !== undefined) return refuse('region_damaged', 'conflict', `voxel world ${name} lists region ${file}, which cannot be read: ${broken}`);
      const f = w.world.files.get(file);
      if (f === undefined || f.hash === null) return refuse('region_not_found', 'not_found', `voxel world ${name} has no region ${file}`);
      return { ok: true, path: join(w.world.dir, file), etag: f.hash };
    });
  }

  /**
   * What an export ships of a world: its manifest fields and every listed
   * region file with its path, length and hash, read in one queued step (no
   * command half applied). A listed file that is missing or damaged refuses
   * it: an export never ships a world with holes.
   */
  async shippedFiles(projectId: string, name: string): Promise<ShippedWorldFiles> {
    const w = await this.load(projectId, name);
    if ('ok' in w) return { ok: false, code: w.error.code, message: w.error.message };
    return this.queued(w, async (): Promise<ShippedWorldFiles> => {
      const fresh = await this.refresh(w);
      if (!Array.isArray(fresh)) return { ok: false, code: fresh.error.code, message: fresh.error.message };
      const m = w.manifest;
      const files: Array<{ name: string; path: string; digest: string; byteLength: number }> = [];
      for (const file of w.world.listedRegions()) {
        const broken = w.world.damagedRegions.get(file);
        const f = w.world.files.get(file);
        if (broken !== undefined || f === undefined || f.hash === null) return { ok: false, code: 'region_damaged', message: `voxel world ${name} lists region ${file}, which cannot be read${broken !== undefined ? `: ${broken}` : ''}` };
        const path = join(w.world.dir, file);
        files.push({ name: file, path, digest: f.hash, byteLength: statSync(path).size });
      }
      return { ok: true, world: { world: name, worldId: m.worldId, edge: m.edge, layout: m.layout, footprint: m.footprint, revision: m.revision }, files };
    });
  }

  /**
   * Applies a voxel command envelope (`op`, `projectId`, optional
   * `requestId` and `origin`, `args`: `{ world, command }` for an edit, `{ world }` for
   * an undo). A command that changes nothing is refused with `no_change`.
   */
  async command(projectId: string, envelope: Record<string, unknown>): Promise<VoxelCommandResult> {
    const op = envelope.op;
    if (!isVoxelWorldOp(op)) return refuse('invalid_request', 'validation', 'not a voxel world op', '/op');
    if (envelope.projectId !== projectId) return refuse('invalid_request', 'validation', 'projectId must name the project of the route', '/projectId');
    const rid = envelope.requestId;
    if (rid !== undefined && (typeof rid !== 'string' || !REQUEST_ID_RE.test(rid))) return refuse('invalid_request', 'validation', 'requestId must be req- + 32 hex', '/requestId');
    if (envelope.origin !== undefined) {
      const origin = parseOrigin(envelope.origin);
      if (!origin.ok) return refuse('invalid_request', 'validation', origin.error.message, origin.error.path ?? '/origin');
    }
    const args = envelope.args;
    if (typeof args !== 'object' || args === null || Array.isArray(args)) return refuse('invalid_request', 'validation', 'args must be an object', '/args');
    const a = args as Record<string, unknown>;
    const allowed = op === 'editVoxels' ? ['world', 'command'] : ['world'];
    const extra = Object.keys(a).find((k) => !allowed.includes(k));
    if (extra !== undefined) return refuse('invalid_request', 'validation', `unknown field ${extra}`, `/args/${extra}`);
    if (typeof a.world !== 'string') return refuse('invalid_request', 'validation', 'args.world names the voxel world', '/args/world');
    const w = await this.load(projectId, a.world);
    if ('ok' in w) return w;
    return this.queued(w, () => this.apply(w, op, a, rid ?? null));
  }

  /** The refusal of a command that met files someone else changed: the world is read again first. */
  private changedRefusal(w: OpenWorld, changed: readonly string[]): { ok: false; error: VoxelWorldError } {
    const shown = changed.slice(0, 4).join(', ') + (changed.length > 4 ? `, … (${changed.length})` : '');
    return refuse('world_changed', 'conflict', `voxel world ${w.name} changed on disk outside this backend (${shown}); reloaded at revision ${w.manifest.revision}, undo history cleared: read the world again, then send the edit again`);
  }

  private async apply(w: OpenWorld, op: VoxelWorldOp, a: Record<string, unknown>, requestId: string | null): Promise<VoxelCommandResult> {
    if (requestId !== null) {
      const seen = w.answers.get(requestId);
      if (seen !== undefined) return { ...seen, duplicated: true };
    }
    const fresh = await this.refresh(w);
    if (!Array.isArray(fresh)) return fresh;
    if (fresh.length > 0) return this.changedRefusal(w, fresh);
    const t0 = performance.now();
    let record: readonly ChunkUndo[];
    let cells: number;
    let box: Readonly<CellBox>;
    let parts: number;
    let materialSwaps: readonly number[];
    let undone: HistoryEntry | null = null;
    /** The undone chunks as the undo found them: written back if the undo cannot be saved. */
    let redo: ChunkUndo[] = [];
    if (op === 'editVoxels') {
      try {
        const cmd = canonicalEditCommand(a.command);
        const out = w.world.edit(cmd);
        if (out.cells === 0) return refuse('no_change', 'validation', 'the stroke changes no voxel');
        record = out.chunks;
        cells = out.cells;
        box = editBounds(w.world.opts.grid, cmd);
        parts = fieldsFeed(out.fields);
        materialSwaps = out.materialSwaps;
      } catch (e) {
        if (e instanceof EditCommandError) return refuse('invalid_args', 'validation', e.message, `/args/command${e.path}`);
        if (e instanceof EditRefused) return refuse(e.code, e.code === 'chunk_not_loaded' ? 'conflict' : 'validation', e.message);
        throw e;
      }
    } else {
      undone = w.history.pop() ?? null;
      if (undone === null) return refuse('nothing_to_undo', 'validation', `voxel world ${w.name} has no edit to undo`);
      record = await w.undo.take(undone.id);
      const store = w.world.store;
      redo = record.map((u) => ({ grid: u.grid, cx: u.cx, cy: u.cy, cz: u.cz, before: { kind: 'image', bytes: store.encodeChunk(u.cx, u.cy, u.cz) } }));
      w.world.undo(record);
      cells = undone.cells;
      box = undone.box;
      parts = undone.parts;
      // Undoing a change takes each cell back from the material it took to the one it left.
      materialSwaps = undone.materialSwaps.map((sw) => materialSwap(swapTo(sw), swapFrom(sw))).sort((x, y) => x - y);
    }
    const t1 = performance.now();
    const saved = this.save(w);
    if (!saved.ok && saved.kind === 'external') {
      // Someone else's files: read the world again (memory and history describe the old ones).
      const again = await this.refresh(w);
      if (!Array.isArray(again)) return again;
      return this.changedRefusal(w, saved.changed);
    }
    if (!saved.ok && saved.kind === 'failed') {
      // Nothing was written: memory and history go back to what the files hold (the chunks stay dirty; the next save rewrites them as they are).
      if (op === 'editVoxels') w.world.undo(record);
      else {
        w.world.undo(redo);
        w.history.push({ ...undone!, id: await w.undo.put(record) });
      }
      return refuse('write_failed', 'internal', `voxel world ${w.name}: ${saved.why}`);
    }
    // Written in full, or in part: memory keeps the change, which the files written hold.
    if (op === 'editVoxels') w.history.push({ id: await w.undo.put(record), cells, box, parts, materialSwaps });
    if (!saved.ok) {
      return refuse('write_partial', 'internal', `voxel world ${w.name}: ${saved.why}. The ${op === 'editVoxels' ? 'edit' : 'undo'} is applied in this backend and in ${saved.written.join(', ') || 'no file'}; ${saved.notWritten.join(', ') || 'no file'} still hold${saved.notWritten.length === 1 ? 's' : ''} the state before it, rewritten by the next save that succeeds`);
    }
    const chunks = record.map((u) => [u.cx, u.cy, u.cz] as const);
    const files = [...new Set(record.map((u) => this.fileName(w, u)))].sort().map((name) => ({ name, etag: saved.tags.get(name) ?? w.world.files.get(name)?.hash ?? null }));
    const answer: VoxelCommandApplied = { ok: true, op, requestId, world: w.name, revision: w.manifest.revision, cells, chunks, box, parts, materialSwaps, files, undoable: w.history.length, duplicated: false, ms: { apply: t1 - t0, save: performance.now() - t1 } };
    if (requestId !== null) {
      w.answers.set(requestId, answer);
      if (w.answers.size > ANSWERS_KEPT) w.answers.delete(w.answers.keys().next().value!);
    }
    return answer;
  }

  private fileName(w: OpenWorld, c: ChunkCoord): string {
    return addressName(addressOf(w.world.opts.grid, w.manifest.layout, w.manifest.footprint, c));
  }

  /**
   * Writes the dirty region files and the next revision of the manifest as
   * one staged write (every file staged on disk first, the manifest renamed
   * last), then renews the files' stamps; the new tags by region file.
   */
  private save(w: OpenWorld): { ok: true; tags: Map<string, string | null> } | Exclude<StagedOutcome, { ok: true }> {
    const prepared = w.world.prepareSaves();
    const listed = new Set(w.world.listedRegions());
    for (const p of prepared) {
      if (p.bytes === null) listed.delete(p.name);
      else listed.add(p.name);
    }
    const next: VoxelWorldManifest = { ...w.manifest, regions: [...listed].sort(), revision: w.manifest.revision + 1 };
    const bytes = manifestBytes(next);
    const manifestPath = join(w.dir, VOXEL_WORLD_MANIFEST);
    const out = w.world.commitAll(prepared, [{ dir: w.dir, name: VOXEL_WORLD_MANIFEST, bytes, expect: w.manifestHash }], this.opts.writeOps);
    const written = out.ok || out.kind === 'partial' ? out.hashes : new Map<string, string>();
    for (const path of written.keys()) w.stamps.set(path, fileStamp(path));
    if (written.has(manifestPath)) {
      w.manifest = next;
      w.manifestHash = sha256HexNative(bytes);
      if (out.ok) w.world.flushRemovals();
    }
    if (!out.ok) return out;
    const tags = new Map<string, string | null>();
    for (const p of prepared) tags.set(p.name, w.world.files.get(p.name)?.hash ?? null);
    return { ok: true, tags };
  }

  /**
   * Forgets a project's open worlds (or every world): called when a project
   * is closed, released or unregistered, so its next use reads the folder
   * again. A command already running finishes on the world it started on.
   */
  close(projectId?: string): void {
    for (const key of [...this.open.keys()]) if (projectId === undefined || key.startsWith(`${projectId}\u0000`)) this.open.delete(key);
  }
}
