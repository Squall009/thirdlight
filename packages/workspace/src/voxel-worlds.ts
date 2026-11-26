/**
 * A project's voxel worlds, as the backend serves and edits them: each
 * world is a folder `voxels/<name>/` in the project holding `world.json`
 * (its format, id, chunk edge, region layout and footprint, the world
 * grid's region files, its structure grids' region files, and a revision
 * that moves with every applied change), the world grid's region files
 * under `grid-0/` and each structure grid's under `grid-<id>/`. Where a
 * structure grid stands is not the world's to say (its structure object's
 * place and yaw): the files hold only its cells.
 *
 * The manifest says which region files the world has: a region it does not
 * list is all air, and one it lists that is missing or unreadable is
 * damaged (reported, never read as air), so a lost tile cannot pass as
 * empty sky.
 *
 * Edits arrive as commands (`editVoxels`: one stroke command, the same
 * format and the same deterministic apply as everywhere else). A world's
 * edits are taken back and applied again by {@link VoxelWorlds.step}: an
 * undo writes back the record of what its stroke changed and keeps what it
 * found as the redo record; a redo writes that back (the exact voxels the
 * undo took away, no brush run again). The project's one undo
 * (undo-timeline.ts) decides which world's stroke is next. Each command is applied to the world in memory, then its dirty
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
import { sceneStructures, sceneWaterBodies, structureDefinitionOf, structurePlacements, voxelWorldBakeLevel, voxelWorldBakeLevels, type SceneWaterBody } from '@thirdlight/project-model';
import {
  canonicalEditCommand,
  editBounds,
  editChunks,
  materialSwap,
  swapFrom,
  swapTo,
  EditCommandError,
  EditRefused,
  valueRole,
  isLiquidRole,
  CellSet,
  UndoStore,
  VOXEL_WORLD_NAME_RE,
  WORLD_GRID_ID,
  VOXEL_GRID_ID_MAX,
  FAR_MIN_LEVEL,
  DEFAULT_FAR_BAKE_LEVEL_M,
  farBakeLevelOf,
  VOXEL_SIZE_M,
  BUILDING_GENERATOR,
  GridFrame,
  StructureDefinitionError,
  type GridPlacement,
  type StructureDefinition,
  type StructureGenerator,
  type CellBox,
  type ChunkCoord,
  type ChunkUndo,
} from '@thirdlight/voxel';
import { isVoxelWorldOp, type VoxelWorldOp } from '@thirdlight/commands/mutation-ops';
import type { StructureOverrides } from '@thirdlight/voxel';
import { parseOrigin } from '@thirdlight/commands';
import { sha256HexNative } from './digest';
import { commitWorldsStaged, DiskUndoSpill, REGION_FILE_NAME_RE, RegionWorld, replaceFile, addressName, addressOf, type StagedFile, type StagedOutcome } from './voxel-world-files';
import { applyStructureChanges, capturedOverrides, readOverrides, StructureWriteRefused, STRUCTURE_OVERRIDES_FILE, type StructureChange, type StructureChangeReport, type StructureGridHost } from './voxel-structure-writes';
import { farBricksFolder } from './voxel-far-bake';
import { FAR_EXPORT_WAIT_MS, farCacheBuildDir, farCacheDir, farCacheFiles, farCacheStale, FarWorldSource, placedGridChunks, readFarCacheManifest, swapFarCache, type FarCacheManifest } from './voxel-far-cache';
import { farFineComplete, farFinePending, farFineProgress, rebakeFarFine, startFarFine, writeFarFineColumn, type FarFineResult } from './voxel-far-fine';
import { FarFollow } from './voxel-far-follow';
import { inProcessFarJobs, type FarCacheJobs } from './voxel-far-jobs';
import { gridBoxInWorld, WaterBodies, type WaterBodyReport, type WaterChange, type WaterWorld } from './voxel-water';
import { applySplineChanges, listedSplineRecords, readSplineRecord, splineRecordFile, SPLINE_RECORDS_FOLDER, type HeldRecord, type SplineChange, type SplineChangeReport } from './voxel-spline-writes';

import { gridFolder, liftManifest, manifestBytes, parseVoxelWorldManifest, worldOptions, VOXEL_WORLD_MANIFEST, VOXEL_WORLDS_FOLDER, type VoxelWorldManifest } from './voxel-world-manifest';
import { fileStamp, isFarLevel, NO_CELLS, refuse, splineReportAt, strokeRecords, waitAtMost, worldKey, type FarBuild, type FarRebuilt, type FineBake, type HistoryEntry, type OpenWorld, type RegionFileAnswer, type ShippedWorldFiles, type StructureGridReport, type VoxelCommandApplied, type VoxelCommandResult, type VoxelFarInfo, type VoxelFineBake, type VoxelStepDirection, type VoxelWaterAnswer, type VoxelWorldError, type VoxelWorldInfo, type VoxelWorldsOptions, type WorldState, SPLINE_WRITE_OP, STRUCTURE_WRITE_OP, WATER_WRITE_OP } from './voxel-world-answers';
import { writeKitTestScene } from './voxel-kit-scene-write';

export * from './voxel-world-manifest';
export * from './voxel-world-answers';

/** Answers kept per world for request ids sent again. */
const ANSWERS_KEPT = 256;
/** Refusals of a step that mean the world no longer holds its strokes. */
const STROKES_LOST = new Set(['world_changed', 'world_not_found', 'world_unreadable', 'project_not_found']);

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
  /** The worlds opened, by their pending open (what {@link residency} reads without waiting). */
  private readonly known = new WeakMap<Promise<unknown>, OpenWorld>();
  /** Far cache builds running, by world. */
  private readonly farBuilds = new Map<string, FarBuild>();
  /** Fine bakes running, by world. */
  private readonly fineBakes = new Map<string, FineBake>();
  /** Worlds whose last fine bake failed, with why (keyed as {@link fineBakes}): not started again by a far read. */
  private readonly fineFailed = new Map<string, string>();
  /** Worlds whose fine bake the editor paused (keyed as {@link fineBakes}). */
  private readonly finePaused = new Set<string>();
  /** Per project, the bake level each world its scenes name asks, as last seen ({@link scenesChanged}). */
  private readonly bakeAsked = new Map<string, Map<string, number>>();
  private readonly farJobs: FarCacheJobs;
  /** The next stroke id: unique in this process, so a stroke named after its world was read again is never another's. */
  private nextStroke = 1;
  /** The generator structure grids are written with. */
  readonly generator: StructureGenerator<StructureDefinition>;
  /** The water bodies' held state (what each owns, its last report): memory only. */
  private readonly water = new WaterBodies();
  /** Per world, the highest structure grid id handed out in this process ({@link nextGridId}). */
  private readonly gridsGiven = new Map<string, number>();

  /** The far rebuilds that follow commands after their answers, and the worlds they are for (by {@link worldKey}). */
  private readonly farGather: FarFollow<FarRebuilt | { readonly stale: string }>;
  private readonly farFollowing = new Map<string, OpenWorld>();

  constructor(private readonly opts: VoxelWorldsOptions) {
    this.farGather = new FarFollow((key, before, chunks) => this.farFollowRun(key, before, chunks), opts.farFollowSettleMs);
    this.farJobs = opts.farJobs ?? inProcessFarJobs();
    this.generator = opts.structureGenerator ?? BUILDING_GENERATOR;
  }

  private load(projectId: string, name: string): Promise<OpenWorld | { ok: false; error: VoxelWorldError }> {
    if (!VOXEL_WORLD_NAME_RE.test(name)) return Promise.resolve(refuse('invalid_request', 'validation', `a world name matches ${VOXEL_WORLD_NAME_RE.source}`, '/world'));
    const key = `${projectId}\u0000${name}`;
    let p = this.open.get(key);
    if (p === undefined) {
      p = this.openWorld(projectId, name);
      this.open.set(key, p);
      const opened = p;
      void opened.then((w) => {
        if (!('ok' in w)) this.known.set(opened, w);
      });
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
    return { projectId, name, dir, farDir: farCacheDir(projectDir, name), farTags: new Map(), ...state, answers: new Map(), queue: Promise.resolve() };
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
    // Opened on demand: a file's chunks load when an edit reaches them, so a world of any size is served in bounded memory.
    const world = RegionWorld.scan(gridDir, opts, manifest.regions, this.opts.residentBytes);
    const grids = new Map<number, RegionWorld>();
    for (const g of manifest.grids) {
      const dirOf = join(dir, gridFolder(g.id));
      for (const file of g.regions) stamps.set(join(dirOf, file), fileStamp(join(dirOf, file)));
      grids.set(g.id, RegionWorld.scan(dirOf, worldOptions(manifest, g.id), g.regions, this.opts.residentBytes));
    }
    // A grid's overrides file is stamped with its region files (read when a command first needs it).
    for (const g of manifest.grids) {
      const path = join(dir, gridFolder(g.id), STRUCTURE_OVERRIDES_FILE);
      stamps.set(path, fileStamp(path));
    }
    // So is every spline's record.
    for (const id of listedSplineRecords(dir)) {
      const path = join(dir, SPLINE_RECORDS_FOLDER, splineRecordFile(id));
      stamps.set(path, fileStamp(path));
    }
    // Undo records of an earlier run (or of the files before someone else changed them) are gone: the folder starts empty.
    const spillDir = join(projectDir, 'cache', 'voxel-undo', name);
    rmSync(spillDir, { recursive: true, force: true });
    mkdirSync(spillDir, { recursive: true });
    return { manifest, manifestHash, world, grids, overrides: new Map(), reports: new Map(), records: new Map(), splineReports: new Map(), undo: new UndoStore(opts.grid, new DiskUndoSpill(spillDir)), history: [], redo: [], stamps };
  }

  /**
   * The files of a world (the manifest and `files`, by default every listed
   * region of every grid; a structure grid's named `grid-<id>/<file>`)
   * someone else changed since this process last read or wrote them: a
   * moved stamp whose bytes still hash to what this process knows is not a
   * change (the stamp is renewed).
   */
  private changedOnDisk(w: OpenWorld, files?: readonly string[]): string[] {
    const checks: Array<{ name: string; path: string; known: string | null | undefined }> = [{ name: VOXEL_WORLD_MANIFEST, path: join(w.dir, VOXEL_WORLD_MANIFEST), known: w.manifestHash }];
    const all = files ?? [...w.manifest.regions, ...w.manifest.grids.flatMap((g) => g.regions.map((f) => `${gridFolder(g.id)}/${f}`))];
    for (const name of all) {
      const inGrid = /^grid-(\d+)\/(.+)$/.exec(name);
      const g = inGrid === null ? w.world : w.grids.get(Number(inGrid[1]));
      const file = inGrid === null ? name : inGrid[2]!;
      if (g === undefined) continue;
      checks.push({ name, path: join(g.dir, file), known: g.files.get(file)?.hash });
    }
    if (files === undefined) {
      for (const g of w.manifest.grids) {
        const held = w.overrides.get(g.id);
        // A file this process never read: any change of its stamp is someone else's (absent: known absent).
        checks.push({ name: `${gridFolder(g.id)}/${STRUCTURE_OVERRIDES_FILE}`, path: join(w.dir, gridFolder(g.id), STRUCTURE_OVERRIDES_FILE), known: held === undefined ? undefined : held.hash });
      }
      for (const id of new Set([...listedSplineRecords(w.dir), ...w.records.keys()])) {
        const held = w.records.get(id);
        checks.push({ name: `${SPLINE_RECORDS_FOLDER}/${splineRecordFile(id)}`, path: join(w.dir, SPLINE_RECORDS_FOLDER, splineRecordFile(id)), known: held === undefined ? undefined : held.hash });
      }
    }
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
    // Someone else's change: a far cache being built meanwhile cannot tell which chunks it missed.
    const build = this.farBuilds.get(worldKey(w));
    if (build !== undefined) build.lost = true;
    const projectDir = this.opts.projectDir(w.projectId);
    const state = projectDir === null ? refuse('project_not_found', 'not_found', `project ${w.projectId} cannot be opened`) : await this.readState(projectDir, w.dir, w.name);
    if ('ok' in state) {
      this.forget(w);
      return state;
    }
    Object.assign(w, state);
    // What the bodies owned was read from the files as they were.
    this.water.forget(worldKey(w));
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
      const tags = (g: RegionWorld): Array<{ name: string; etag: string | null }> => g.listedRegions().map((file) => ({ name: file, etag: g.files.get(file)?.hash ?? null }));
      const places = this.placements(w);
      const host = this.gridHost(w);
      return {
        ok: true,
        world: name,
        manifest: w.manifest,
        files: tags(w.world),
        grids: w.manifest.grids.map((g) => {
          const report = w.reports.get(g.id);
          const place = places.find((p) => p.gridId === g.id);
          let overrides = 0;
          for (const c of host.overrides(g.id).value.chunks.values()) overrides += c.value.count;
          return { id: g.id, files: tags(this.gridOf(w, g.id)), ...(place !== undefined ? { place } : {}), ...(report !== undefined ? { lastRegenerate: this.reportAt(w, report) } : {}), overrides };
        }),
        bodies: await this.waterReports(w),
        splines: [...new Set([...listedSplineRecords(w.dir), ...w.splineReports.keys()])].sort().map((id) => {
          const held = this.recordOf(w, id);
          const report = w.splineReports.get(id);
          let written = 0;
          for (const c of held.value.chunks.values()) written += c.value.count;
          return { entityId: id, written, recordBytes: held.bytes?.length ?? 0, ...(report !== undefined ? { lastWrite: splineReportAt(report) } : {}) };
        }),
      };
    });
  }

  /**
   * What an open world holds in this process: the store bytes of its loaded
   * region files, how many of its listed files are loaded, and the loads
   * and drops since it opened (null: not open).
   */
  residency(projectId: string, name: string): { residentBytes: number; loaded: number; listed: number; loads: number; drops: number } | null {
    const p = this.open.get(`${projectId}\u0000${name}`);
    if (p === undefined) return null;
    const known = this.known.get(p);
    if (known === undefined) return null;
    const world = known.world;
    let loaded = 0;
    for (const f of world.files.values()) if (f.loaded && f.hash !== null) loaded++;
    return { residentBytes: world.residentBytes, loaded, listed: world.listedRegions().length, loads: world.counters.loads, drops: world.counters.drops };
  }

  /**
   * Where a region file is and its entity tag (the hash of its bytes as
   * this process wrote or read them). A region the world does not list is
   * not found: a client reads its chunks as air. A listed region that is
   * missing or unreadable is refused as damaged: a client reports its chunks.
   * `gridId`: the grid the file is of (default the world grid); a grid the
   * world does not list has no region.
   */
  async regionFile(projectId: string, name: string, file: string, gridId: number = WORLD_GRID_ID): Promise<RegionFileAnswer> {
    if (!REGION_FILE_NAME_RE.test(file)) return refuse('invalid_request', 'validation', 'not a region file name', '/file');
    if (!Number.isInteger(gridId) || gridId < 0 || gridId > VOXEL_GRID_ID_MAX) return refuse('invalid_request', 'validation', 'not a grid id', '/grid');
    const w = await this.load(projectId, name);
    if ('ok' in w) return w;
    return this.queued(w, async (): Promise<RegionFileAnswer> => {
      const listed = gridId === WORLD_GRID_ID ? w.manifest.regions : (w.manifest.grids.find((g) => g.id === gridId)?.regions ?? []);
      const key = gridId === WORLD_GRID_ID ? file : `${gridFolder(gridId)}/${file}`;
      // Only a listed file can be stale here; a file the manifest does not list is no part of the world (a new one comes with a changed manifest).
      const fresh = await this.refresh(w, listed.includes(file) ? [key] : []);
      if (!Array.isArray(fresh)) return fresh;
      const g = gridId === WORLD_GRID_ID ? w.world : w.grids.get(gridId);
      const broken = g?.damagedRegions.get(file);
      if (broken !== undefined) return refuse('region_damaged', 'conflict', `voxel world ${name} lists region ${key}, which cannot be read: ${broken}`);
      const f = g?.files.get(file);
      if (g === undefined || f === undefined || f.hash === null) return refuse('region_not_found', 'not_found', `voxel world ${name} has no region ${key}`);
      return { ok: true, path: join(g.dir, file), etag: f.hash };
    });
  }

  /**
   * The world's far cache, current with its revision; when it is missing or
   * stale it is built in the background (commands go on meanwhile, see
   * {@link buildFar}) and the answer is `far_cache_building` until it lands.
   */
  async farInfo(projectId: string, name: string): Promise<VoxelFarInfo> {
    const w = await this.load(projectId, name);
    if ('ok' in w) return w;
    // What commands left to build goes first: a cache read now is the one they made.
    await this.farGather.settle(worldKey(w));
    const stale = farCacheStale(w.farDir, w.manifest);
    if (stale !== null) {
      void this.buildFar(w);
      return refuse('far_cache_building', 'conflict', `voxel world ${name}'s far cache is being built (${stale}); ask again shortly`);
    }
    return this.queued(w, async (): Promise<VoxelFarInfo> => {
      const fresh = await this.refresh(w);
      if (!Array.isArray(fresh)) return fresh;
      const now = farCacheStale(w.farDir, w.manifest);
      if (now !== null) {
        void this.buildFar(w);
        return refuse('far_cache_building', 'conflict', `voxel world ${name}'s far cache is being built (${now}); ask again shortly`);
      }
      const files = farCacheFiles(w.farDir).slice(1).map((f) => ({ name: f, etag: this.farTag(w, f) }));
      const manifest = readFarCacheManifest(w.farDir);
      const fine = this.fineState(w, manifest);
      if (fine !== undefined && !fine.baking && !fine.paused && fine.failed === undefined && fine.levels.some((l) => l.done < l.total)) void this.bakeFine(w);
      const follow = this.farGather.last.get(worldKey(w));
      return { ok: true, world: name, manifest, files, ...(fine !== undefined ? { fine: { ...fine, baking: this.fineBakes.has(worldKey(w)) } } : {}), ...(follow !== undefined ? { follow } : {}) };
    });
  }

  /**
   * Builds a world's whole far cache unless a build runs already: by the far
   * jobs (a worker thread in the backend) into a fresh folder, outside the
   * world's queue, so commands, reads and other worlds go on while it runs.
   * It lands in the queue: swapped in whole, then the chunks commands
   * changed meanwhile built again on it, so it is current when the queue
   * moves on.
   */
  private buildFar(w: OpenWorld): Promise<void> {
    const key = worldKey(w);
    const had = this.farBuilds.get(key);
    if (had !== undefined) return had.done;
    const job: FarBuild = { changed: new Map(), lost: false, done: Promise.resolve() };
    const fresh = farCacheBuildDir(w.farDir);
    const drop = (): void => {
      if (this.farBuilds.get(key) === job) this.farBuilds.delete(key);
    };
    job.done = (async () => {
      if (farCacheStale(w.farDir, w.manifest) === null) return;
      await this.farJobs.build(w.dir, fresh, this.placements(w));
      await this.queued(w, async () => {
        // From here commands see no build under way: theirs rebuild the landed cache themselves.
        drop();
        swapFarCache(fresh, w.farDir);
        w.farTags.clear();
        if (!job.lost && job.changed.size > 0) await this.farRebuild(w, [...job.changed.values()]);
      });
      if (this.wantedBake(w) < FAR_MIN_LEVEL) void this.bakeFine(w);
    })()
      .catch(() => rmSync(fresh, { recursive: true, force: true }))
      .finally(drop);
    this.farBuilds.set(key, job);
    return job.done;
  }

  /** The kept ancestors of `chunks` built again by the far jobs; a cache that cannot be is dropped (the next read builds it whole). */
  private async farRebuild(w: OpenWorld, chunks: readonly ChunkCoord[]): Promise<FarRebuilt | { readonly stale: string }> {
    try {
      const r = await this.farJobs.rebuild(w.dir, w.farDir, chunks, this.placements(w));
      return { nodes: r.rebuilt.length, ms: r.ms, ...(r.bricks !== undefined ? { bricks: r.bricks } : {}), ...(r.fine !== undefined ? { fine: r.fine } : {}) };
    } catch (e) {
      rmSync(w.farDir, { recursive: true, force: true });
      w.farTags.clear();
      return { stale: e instanceof Error ? e.message : String(e) };
    }
  }

  /** The far level a world's scenes bake down to (2: the kept levels only). */
  private wantedBake(w: OpenWorld): number {
    return farBakeLevelOf(this.opts.scenes === undefined ? DEFAULT_FAR_BAKE_LEVEL_M : voxelWorldBakeLevel(this.opts.scenes(w.projectId), w.name));
  }

  /** A world's fine bake toward the level its scenes ask, as the far info answers it (undefined: it asks none). */
  private fineState(w: OpenWorld, m: FarCacheManifest): VoxelFineBake | undefined {
    const want = this.wantedBake(w);
    if (want >= FAR_MIN_LEVEL) return undefined;
    const failed = this.fineFailed.get(worldKey(w));
    return { bakeLevel: want, baking: this.fineBakes.has(worldKey(w)), paused: this.finePaused.has(worldKey(w)), ...(failed !== undefined ? { failed } : {}), levels: farFineProgress(m, new FarWorldSource(w.dir, this.placements(w)), want) };
  }

  /**
   * The project's scenes changed (a command applied): a world whose bake level they ask changed starts baking toward
   * it at once (its far cache built first when it is not current), and a bake toward a level no longer asked stops.
   * Background work: the command has answered; the bake writes a column at a time in the world's queue.
   */
  scenesChanged(projectId: string): void {
    if (this.opts.scenes === undefined) return;
    const asked = new Map([...voxelWorldBakeLevels(this.opts.scenes(projectId))].map(([world, m]) => [world, farBakeLevelOf(m)]));
    const before = this.bakeAsked.get(projectId);
    this.bakeAsked.set(projectId, asked);
    for (const [world, level] of asked) {
      // First seen: only a world asking a fine level (a bake left part way goes on).
      if (before === undefined ? level >= FAR_MIN_LEVEL : before.get(world) === level) continue;
      this.startFineBake(projectId, world).catch(() => undefined);
    }
  }

  /**
   * The editor pauses (`run` false) or resumes a world's fine bake. Paused, the columns baked stay and nothing more
   * bakes (a far read does not start it either); resumed, it goes on from the columns written. Answers the bake's state.
   */
  async fineBakeControl(projectId: string, name: string, run: boolean): Promise<VoxelFarInfo> {
    const w = await this.load(projectId, name);
    if ('ok' in w) return w;
    const key = worldKey(w);
    if (run) {
      this.finePaused.delete(key);
      this.fineFailed.delete(key);
      this.startFineBake(projectId, name).catch(() => undefined);
    } else {
      this.finePaused.add(key);
      const job = this.fineBakes.get(key);
      if (job !== undefined) job.stopped = true;
    }
    return this.farInfo(projectId, name);
  }

  /** A world's fine bake toward the level its scenes ask, started now (its far cache built first where not current). */
  private async startFineBake(projectId: string, name: string): Promise<void> {
    const w = await this.load(projectId, name);
    if ('ok' in w) return;
    const key = worldKey(w);
    const level = this.wantedBake(w);
    const running = this.fineBakes.get(key);
    // A bake toward another level stops; the next one starts from the columns written.
    if (running !== undefined && running.level !== level) {
      running.stopped = true;
      await running.done;
      this.fineFailed.delete(key);
    }
    if (level >= FAR_MIN_LEVEL || this.finePaused.has(key)) return;
    if (farCacheStale(w.farDir, w.manifest) !== null) await this.buildFar(w);
    await this.bakeFine(w);
  }

  /**
   * Bakes a world's fine levels down to the level its scenes ask unless a bake runs already: the columns not baked
   * yet, in the far jobs (bake threads in the backend) outside the world's queue, each column written in the queue
   * as it lands, so commands go on and a stopped bake goes on from the columns written. A full build of the cache
   * (another revision on disk) stops it; the next read starts it again on the new cache.
   */
  private bakeFine(w: OpenWorld): Promise<void> {
    const key = worldKey(w);
    const had = this.fineBakes.get(key);
    if (had !== undefined) return had.done;
    const level = this.wantedBake(w);
    if (level >= FAR_MIN_LEVEL) return Promise.resolve();
    const job: FineBake = { level, changed: [], done: Promise.resolve(), stopped: false };
    const drop = (): void => {
      if (this.fineBakes.get(key) === job) this.fineBakes.delete(key);
    };
    const current = (): boolean => !this.farBuilds.has(key) && farCacheStale(w.farDir, w.manifest) === null;
    job.done = (async () => {
      const pending = await this.queued(w, () => Promise.resolve(current() ? farFinePending(startFarFine(w.farDir, level), new FarWorldSource(w.dir, this.placements(w)), level) : []));
      if (pending.length === 0) return;
      for await (const r of this.farJobs.bakeFine(pending.map((t) => ({ worldDir: w.dir, ...t, grids: this.placements(w) })))) {
        if (job.stopped) break;
        const landed = await this.queued(w, () => Promise.resolve(current() && !job.stopped && this.landFine(w, job, r)));
        if (!landed) break;
      }
    })()
      // Kept and answered (the far info's `failed`, the Inspector's state): a full disk would otherwise fail again
      // at every far read, unseen. The columns written stay; a resume goes on from them.
      .catch((e: unknown) => void this.fineFailed.set(key, e instanceof Error ? e.message : String(e)))
      .finally(drop);
    this.fineBakes.set(key, job);
    return job.done;
  }

  /**
   * A baked column written (in the world's queue), then its nodes over the chunks changed since the bake began built
   * again: it may have read them before they changed. Only its own: a column baked before a change was built again
   * with the change, and one not baked yet reads the chunks as they are.
   */
  private landFine(w: OpenWorld, job: FineBake, r: FarFineResult): boolean {
    writeFarFineColumn(w.farDir, w.world.store.grid, r);
    w.farTags.clear();
    if (job.changed.length > 0) rebakeFarFine(w.dir, w.farDir, job.changed, { level: r.level, rx: r.rx, rz: r.rz }, this.placements(w));
    return true;
  }

  /** A far cache file's tag (the hash of its bytes), taken again only when its stamp moved. */
  private farTag(w: OpenWorld, file: string): string {
    const path = join(w.farDir, file);
    const stamp = fileStamp(path);
    const had = w.farTags.get(path);
    if (had !== undefined && had.stamp === stamp) return had.hash;
    const hash = sha256HexNative(readFileSync(path));
    w.farTags.set(path, { stamp, hash });
    return hash;
  }

  /** Where a far cache file is and its tag (`level`: `L<n>`), when the cache lists it (a stale one is built again meanwhile). */
  async farFile(projectId: string, name: string, level: string, file: string): Promise<RegionFileAnswer> {
    if (!isFarLevel(level) || !REGION_FILE_NAME_RE.test(file)) return refuse('invalid_request', 'validation', 'not a far cache file name', '/file');
    const w = await this.load(projectId, name);
    if ('ok' in w) return w;
    return this.queued(w, async (): Promise<RegionFileAnswer> => {
      // A stale cache (the world changed on disk) is served as it is while it is built again: a page drawing it
      // keeps the old far field rather than a hole, and the build replaces the folder whole.
      if (farCacheStale(w.farDir, w.manifest) !== null) void this.buildFar(w);
      const rel = `${level}/${file}`;
      if (!farCacheFiles(w.farDir).includes(rel)) return refuse('region_not_found', 'not_found', `voxel world ${name}'s far cache has no ${rel}`);
      return { ok: true, path: join(w.farDir, level, file), etag: this.farTag(w, rel) };
    });
  }

  /**
   * After a change written in full: the far cache's ancestors of the
   * changed chunks rebuilt (it was current before the change) by the far
   * jobs, off the event loop; while a full build runs, the chunks join it
   * instead; else the reason it is now stale (built again whole when next
   * read).
   */
  private async farAfter(w: OpenWorld, before: number, chunks: ReadonlyArray<readonly [number, number, number]>): Promise<VoxelCommandApplied['far']> {
    // A column of a fine bake under way may have read these chunks before they changed: built again when it lands.
    this.fineBakes.get(worldKey(w))?.changed.push(...chunks.map(([cx, cy, cz]) => ({ cx, cy, cz })));
    const build = this.farBuilds.get(worldKey(w));
    if (build !== undefined) {
      for (const [cx, cy, cz] of chunks) build.changed.set(`${cx},${cy},${cz}`, { cx, cy, cz });
      return { stale: 'the far cache is being built; this change is built into it when it lands' };
    }
    // Changes gathered and not built yet: the cache is still at the revision the first of them found.
    const key = worldKey(w);
    const base = this.farGather.before(key) ?? before;
    const stale = farCacheStale(w.farDir, { ...w.manifest, revision: base });
    if (stale === 'not built') return null;
    if (stale !== null) return { stale };
    this.farFollowing.set(key, w);
    return { queued: this.farGather.add(key, base, chunks.map(([cx, cy, cz]) => ({ cx, cy, cz }))) };
  }

  /** A world's gathered far changes built (voxel-far-follow.ts), in its queue: on the cache as it is when their turn comes. */
  private farFollowRun(key: string, before: number, chunks: ChunkCoord[]): Promise<FarRebuilt | { readonly stale: string } | null> {
    const w = this.farFollowing.get(key);
    if (w === undefined) return Promise.resolve(null);
    return this.queued(w, async () => {
      const build = this.farBuilds.get(key);
      if (build !== undefined) {
        for (const c of chunks) build.changed.set(`${c.cx},${c.cy},${c.cz}`, c);
        return { stale: 'the far cache is being built; these changes are built into it when it lands' };
      }
      const stale = farCacheStale(w.farDir, { ...w.manifest, revision: before });
      if (stale === 'not built') return null;
      if (stale !== null) return { stale };
      const r = await this.farRebuild(w, chunks);
      return r;
    });
  }

  /**
   * Builds now what commands left for a world's far cache and answers once it landed: the rebuild's answer (null: none
   * waited, or the world has no far cache). Benches and tests read the far cache current with it.
   */
  async farSettled(projectId: string, world: string): Promise<FarRebuilt | { readonly stale: string } | null> {
    const w = await this.load(projectId, world);
    if ('ok' in w) return null;
    return this.farGather.settle(worldKey(w));
  }

  /**
   * What an export ships of a world: its manifest fields and every listed
   * region file with its path, length and hash, read in one queued step (no
   * command half applied). A listed file that is missing or damaged refuses
   * it: an export never ships a world with holes. A far cache being built
   * is waited for outside the queue (commands go on) up to the export's
   * wait; one still not current then is left out, and `farNote` says so.
   */
  async shippedFiles(projectId: string, name: string): Promise<ShippedWorldFiles> {
    const w = await this.load(projectId, name);
    if ('ok' in w) return { ok: false, code: w.error.code, message: w.error.message };
    const wait = this.opts.farExportWaitMs ?? FAR_EXPORT_WAIT_MS;
    const t0 = performance.now();
    await this.farGather.settle(worldKey(w));
    if (farCacheStale(w.farDir, w.manifest) !== null) await waitAtMost(this.buildFar(w), wait);
    if (this.wantedBake(w) < FAR_MIN_LEVEL && farCacheStale(w.farDir, w.manifest) === null) await waitAtMost(this.bakeFine(w), Math.max(0, wait - (performance.now() - t0)));
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
      // Each placed structure grid ships its region files as the world grid's are, with its place (never resampled into the world grid).
      const grids: NonNullable<Extract<ShippedWorldFiles, { ok: true }>['grids']> = [];
      for (const place of this.placements(w)) {
        if (!m.grids.some((g) => g.id === place.gridId)) continue;
        const rw = this.gridOf(w, place.gridId);
        const gridFiles: (typeof grids)[number]['files'] = [];
        for (const file of rw.listedRegions()) {
          const broken = rw.damagedRegions.get(file);
          const f = rw.files.get(file);
          if (broken !== undefined || f === undefined || f.hash === null) return { ok: false, code: 'region_damaged', message: `voxel world ${name} lists region ${gridFolder(place.gridId)}/${file}, which cannot be read${broken !== undefined ? `: ${broken}` : ''}` };
          const path = join(rw.dir, file);
          gridFiles.push({ name: file, path, digest: f.hash, byteLength: statSync(path).size });
        }
        grids.push({ id: place.gridId, position: [place.position[0], place.position[1], place.position[2]], yawRad: place.yawRad, files: gridFiles });
      }
      const withGrids = grids.length > 0 ? { grids } : {};
      const stale = farCacheStale(w.farDir, m);
      if (stale !== null) {
        void this.buildFar(w);
        const shipped = { world: name, worldId: m.worldId, edge: m.edge, layout: m.layout, footprint: m.footprint, revision: m.revision };
        return { ok: true, world: shipped, files, ...withGrids, farNote: `voxel world ${name} ships without its far field: its far cache is still being built (${stale}); export again once it is built to draw the world past its load ring` };
      }
      const far = readFarCacheManifest(w.farDir);
      // The fine levels ship only whole, and only down to the level the scenes ask (a finer bake held stays home).
      const want = this.wantedBake(w);
      const fine = want < FAR_MIN_LEVEL ? farFineComplete(far, new FarWorldSource(w.dir, this.placements(w)), want) : [];
      const fineFolders = new Set(fine.map((l) => `${farBricksFolder(l)}/`));
      const farFiles = farCacheFiles(w.farDir)
        .slice(1)
        .filter((f) => {
          const level = Number(/^[LB](\d+)\//.exec(f)?.[1] ?? NaN);
          return level >= far.minLevel || fineFolders.has(f.slice(0, f.indexOf('/') + 1));
        })
        .map((f) => {
          const path = join(w.farDir, f);
          return { name: f, path, digest: this.farTag(w, f), byteLength: statSync(path).size };
        });
      const shipped = { world: name, worldId: m.worldId, edge: m.edge, layout: m.layout, footprint: m.footprint, revision: m.revision };
      const farOut = { minLevel: far.minLevel, maxLevel: far.maxLevel, files: farFiles, ...(fine.length > 0 ? { bakeLevel: Math.min(...fine) } : {}) };
      if (want < FAR_MIN_LEVEL && fine.length === 0) {
        void this.bakeFine(w);
        return { ok: true, world: shipped, files, ...withGrids, far: farOut, farNote: `voxel world ${name} ships without its baked fine levels (bake level ${VOXEL_SIZE_M * 2 ** want} m): they are still being baked; until an export ships them the game draws its mesh rings past the detail ring (or builds fine bricks on WebGPU where the world's fine build is compute): export again once the bake is done` };
      }
      return { ok: true, world: shipped, files, ...withGrids, far: farOut };
    });
  }

  /**
   * Applies a voxel command envelope (`op`, `projectId`, optional
   * `requestId`, `origin` and `expectedRevision`, `args`: `{ world, command }` for an edit). A command that changes
   * nothing is refused with `no_change`; one whose `expectedRevision` is not the world's revision is refused with
   * `revision_conflict` (the world's current revision named), the way project commands are.
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
    const expected = envelope.expectedRevision;
    if (expected !== undefined && (typeof expected !== 'number' || !Number.isSafeInteger(expected) || expected < 0)) return refuse('invalid_request', 'validation', "expectedRevision is the world's revision (a whole number ≥ 0)", '/expectedRevision');
    const args = envelope.args;
    if (typeof args !== 'object' || args === null || Array.isArray(args)) return refuse('invalid_request', 'validation', 'args must be an object', '/args');
    const a = args as Record<string, unknown>;
    const allowed = op === 'editVoxels' ? ['world', 'command'] : ['world', 'origin', 'material'];
    const extra = Object.keys(a).find((k) => !allowed.includes(k));
    if (extra !== undefined) return refuse('invalid_request', 'validation', `unknown field ${extra}`, `/args/${extra}`);
    if (typeof a.world !== 'string') return refuse('invalid_request', 'validation', 'args.world names the voxel world', '/args/world');
    const w = await this.load(projectId, a.world);
    if ('ok' in w) return w;
    return this.queued(w, () => this.apply(w, op, a, rid ?? null, expected as number | undefined));
  }

  /**
   * A structure command's writes to a world's grids (voxel-structure-writes.ts) as one stroke: every change's
   * region files, overrides files and the next manifest in one staged write; one undo takes them all back. The
   * answer names each grid's cells, kept and absorbed overrides and misfits; a world grid edit is not one of them.
   */
  async writeStructures(projectId: string, world: string, changes: readonly StructureChange[], requestId: string | null): Promise<VoxelCommandResult> {
    if (changes.length === 0) return refuse('no_change', 'validation', 'no structure to write');
    const w = await this.load(projectId, world);
    if ('ok' in w) return w;
    return this.queued(w, () => this.apply(w, STRUCTURE_WRITE_OP, { changes }, requestId));
  }

  /**
   * A command's splines written into a world (voxel-spline-writes.ts) as one stroke: what each wrote put back where
   * it still holds it, its new course written, the region files and the record files in one staged write. The answer
   * names each spline's cells, those left alone and the fit rule's misfits.
   */
  async writeSplines(projectId: string, world: string, changes: readonly SplineChange[], requestId: string | null): Promise<VoxelCommandResult> {
    if (changes.length === 0) return refuse('no_change', 'validation', 'no spline to write');
    const w = await this.load(projectId, world);
    if ('ok' in w) return w;
    return this.queued(w, () => this.apply(w, SPLINE_WRITE_OP, { changes }, requestId));
  }

  /**
   * A command's water as one stroke of the world (voxel-water.ts): the bodies it made, changed, moved or deleted
   * (`changes`, as the scenes held them before and hold them now) written again or cleared, then every other body
   * of the world whose reach `boxes` meet (the world cells under the structures it wrote) followed round them. The
   * answer's `water.bodies` reports each body; `no_change` when no cell changes.
   */
  async writeWater(projectId: string, world: string, changes: readonly WaterChange[], boxes: readonly CellBox[], requestId: string | null): Promise<VoxelCommandResult> {
    if (changes.length === 0 && boxes.length === 0) return refuse('no_change', 'validation', 'no water to write');
    const w = await this.load(projectId, world);
    if ('ok' in w) return w;
    return this.queued(w, () => this.apply(w, WATER_WRITE_OP, { changes, boxes }, requestId));
  }

  /**
   * The next free structure grid id of a world, given out once: one above every id the world's manifest lists, the
   * project's structure objects name, a command made in this process and this process gave out before. So an id is
   * never given again while this backend runs, which is as long as an undo can bring back a deleted structure (the
   * project's undo is held in this process); after a restart nothing can bring one back, and the ids its files and
   * objects hold are skipped.
   */
  async nextGridId(projectId: string, world: string): Promise<number | { ok: false; error: VoxelWorldError }> {
    const w = await this.load(projectId, world);
    if ('ok' in w) return w;
    return this.queued(w, async () => {
      const key = worldKey(w);
      let top = this.gridsGiven.get(key) ?? 0;
      for (const g of w.manifest.grids) top = Math.max(top, g.id);
      for (const id of w.grids.keys()) top = Math.max(top, id);
      for (const s of this.structuresOf(w)) top = Math.max(top, s.component.grid);
      if (top >= VOXEL_GRID_ID_MAX) return refuse('grid_ids_exhausted', 'conflict', `voxel world ${world} has given out every grid id`);
      this.gridsGiven.set(key, top + 1);
      return top + 1;
    });
  }

  /**
   * The world chunks each placed structure grid lies over, by grid (what the far build reads of it), from the grids'
   * files as they are now; empty while the world has no far cache (nothing to build again). Read outside the world's
   * queue (a structure's move must not wait for a far rebuild under way there; region files are replaced whole, so a
   * read sees a file before or after a write).
   */
  async gridFarChunks(projectId: string, world: string, places: readonly GridPlacement[]): Promise<Map<number, Array<readonly [number, number, number]>>> {
    const w = await this.load(projectId, world);
    if ('ok' in w) return new Map();
    return farCacheStale(w.farDir, w.manifest) === 'not built' ? new Map() : new Map(places.map((p) => [p.gridId, placedGridChunks(w.dir, [p])]));
  }

  /**
   * The world's far cache to be built again over `chunks` with the structure grids where their objects stand then (a
   * structure made, moved, turned or deleted: no voxel of the world grid changed): gathered, not waited for, outside
   * the world's queue, so a drag's moves gather into one rebuild while each is answered. Null: no far cache yet.
   */
  async farFollow(projectId: string, world: string, chunks: ReadonlyArray<readonly [number, number, number]>): Promise<VoxelCommandApplied['far']> {
    const w = await this.load(projectId, world);
    if ('ok' in w || chunks.length === 0) return null;
    return this.farAfter(w, w.manifest.revision, [...new Map(chunks.map((c) => [c.join(','), c])).values()]);
  }

  /**
   * Takes back (`undo`) or applies again (`redo`) one of a world's strokes: `stroke` must be the newest of the
   * world's undoable strokes (undo) or of its undone ones (redo); anything else, or a stroke whose record is lost,
   * is refused `history_gone` (the world was read again, closed or deleted since, or the stroke was stepped by
   * someone else), so a caller holding an order of strokes can skip it. Derived data follows as for an edit: the
   * answer names the stroke's chunks, box, parts and material changes.
   */
  async step(projectId: string, world: string, direction: VoxelStepDirection, stroke: number, requestId: string | null): Promise<VoxelCommandResult> {
    const w = await this.load(projectId, world);
    const r = 'ok' in w ? w : await this.queued(w, () => this.apply(w, direction, {}, requestId, undefined, stroke));
    // A world deleted, unreadable or changed on disk (read again: its history cleared) holds none of its strokes now.
    if (!r.ok && STROKES_LOST.has(r.error.code)) return refuse('history_gone', 'conflict', `stroke ${stroke} of voxel world ${world} cannot be ${direction === 'undo' ? 'undone' : 'redone'}: ${r.error.message}`);
    return r;
  }

  /**
   * Where a stroke stands in a world this process has open: `undo` while it can be undone, `redo` while it is undone
   * and can be applied again, null when the world holds it no longer (read again, closed, or never). Read without
   * waiting for the world's queue: a step under way may have taken it off one stack and not put it on the other yet.
   */
  strokeSide(projectId: string, world: string, stroke: number): VoxelStepDirection | null {
    const w = this.openNow(projectId, world);
    if (w === null) return null;
    if (w.history.some((e) => e.stroke === stroke)) return 'undo';
    return w.redo.some((e) => e.stroke === stroke) ? 'redo' : null;
  }

  /** The stroke a step of a world this process has open would take next: its newest undoable one, or the last undone (null: none, or not open). */
  newestStroke(projectId: string, world: string, side: VoxelStepDirection = 'undo'): number | null {
    const w = this.openNow(projectId, world);
    return (side === 'undo' ? w?.history : w?.redo)?.at(-1)?.stroke ?? null;
  }

  /** Drops a world's undone strokes (a new edit elsewhere in the project's one timeline ends their redo). */
  clearRedo(projectId: string, world: string): Promise<void> {
    const w = this.openNow(projectId, world);
    if (w === null) return Promise.resolve();
    return this.queued(w, async () => {
      for (const e of w.redo.splice(0)) await w.undo.drop(e.id);
    });
  }

  private openNow(projectId: string, world: string): OpenWorld | null {
    const p = this.open.get(`${projectId}\u0000${world}`);
    return p === undefined ? null : (this.known.get(p) ?? null);
  }

  /** The refusal of a command that met files someone else changed: the world is read again first. */
  private changedRefusal(w: OpenWorld, changed: readonly string[]): { ok: false; error: VoxelWorldError } {
    const shown = changed.slice(0, 4).join(', ') + (changed.length > 4 ? `, … (${changed.length})` : '');
    return refuse('world_changed', 'conflict', `voxel world ${w.name} changed on disk outside this backend (${shown}); reloaded at revision ${w.manifest.revision}, undo history cleared: read the world again, then send the edit again`);
  }

  private async apply(w: OpenWorld, op: VoxelWorldOp | VoxelStepDirection | typeof STRUCTURE_WRITE_OP | typeof SPLINE_WRITE_OP | typeof WATER_WRITE_OP, a: Record<string, unknown>, requestId: string | null, expectedRevision?: number, stroke?: number): Promise<VoxelCommandResult> {
    if (requestId !== null) {
      const seen = w.answers.get(requestId);
      if (seen !== undefined) return { ...seen, duplicated: true };
    }
    const fresh = await this.refresh(w);
    if (!Array.isArray(fresh)) return fresh;
    if (fresh.length > 0) return this.changedRefusal(w, fresh);
    if (expectedRevision !== undefined && expectedRevision !== w.manifest.revision) {
      return { ok: false, error: { code: 'revision_conflict', cls: 'conflict', message: `voxel world ${w.name} is at revision ${w.manifest.revision}, not ${expectedRevision}: read the world again, then send the edit again`, expectedRevision, currentRevision: w.manifest.revision } };
    }
    const t0 = performance.now();
    let record: readonly ChunkUndo[];
    let cells: number;
    let box: Readonly<CellBox>;
    let parts: number;
    let materialSwaps: readonly number[];
    /** The stroke a step takes from one stack to the other (null: a forward op). */
    let stepped: HistoryEntry | null = null;
    let scene: VoxelCommandApplied['scene'];
    /** Overrides files this change writes (null: the file goes), by grid; their bytes before, for the undo. */
    const flips = new Map<number, { before: Uint8Array | null; after: Uint8Array | null; value?: StructureOverrides }>();
    let structures: StructureChangeReport[] | undefined;
    /** Spline record files this change writes (null: the file goes), by object id; their bytes before, for the undo. */
    const recordFlips = new Map<string, { before: Uint8Array | null; after: Uint8Array | null; value?: HeldRecord['value'] }>();
    let splines: SplineChangeReport[] | undefined;
    /** The water a stroke wrote after its edit (or a water step's bodies). */
    let water: VoxelWaterAnswer | undefined;
    /** A step's chunks as it found them: the other way's record, and written back if the step cannot be saved. */
    let inverse: ChunkUndo[] = [];
    const isStep = op === 'undo' || op === 'redo';
    const from = op === 'undo' ? w.history : w.redo;
    const to = op === 'undo' ? w.redo : w.history;
    const host = this.gridHost(w);
    if (op === 'editVoxels') {
      try {
        const cmd = canonicalEditCommand(a.command);
        const target = cmd.grid === WORLD_GRID_ID ? w.world : w.grids.get(cmd.grid);
        if (target === undefined || (cmd.grid !== WORLD_GRID_ID && !w.manifest.grids.some((g) => g.id === cmd.grid))) return refuse('grid_not_found', 'not_found', `voxel world ${w.name} has no structure grid ${cmd.grid}`, '/args/command/grid');
        await target.ensure(editChunks(w.world.opts.grid, cmd));
        const out = target.edit(cmd);
        if (out.cells === 0) return refuse('no_change', 'validation', 'the stroke changes no voxel');
        record = out.chunks;
        cells = out.cells;
        box = cmd.grid === WORLD_GRID_ID ? editBounds(w.world.opts.grid, cmd) : NO_CELLS;
        parts = out.parts;
        materialSwaps = out.materialSwaps;
        // A hand edit on a structure's grid is kept as overrides over what its generator makes there.
        const def = cmd.grid === WORLD_GRID_ID ? null : this.structureDefinition(w, cmd.grid);
        if (def !== null) {
          const captured = capturedOverrides(host, this.generator, cmd.grid, def, out.chunks);
          if (captured !== null) flips.set(cmd.grid, { before: host.overrides(cmd.grid).bytes, after: captured.bytes, value: captured.value });
        }
        // The bodies whose reach the stroke meets follow it, in the same stroke: ground (or a building's hand edit) first, then water.
        const bodies = this.waterBodies(w);
        const reached = bodies.length === 0 ? [] : cmd.grid === WORLD_GRID_ID ? [box] : this.gridEditBoxes(w, cmd.grid, out.chunks);
        const followed = reached.length === 0 ? null : this.water.follow(await this.waterWorld(w), bodies, reached);
        if (followed !== null) {
          record = [...followed.record, ...record];
          cells += followed.cells;
          for (const sw of followed.materialSwaps) if (!materialSwaps.includes(sw)) materialSwaps = [...materialSwaps, sw].sort((x, y) => x - y);
          water = { box: followed.box ?? NO_CELLS, parts: followed.parts, chunks: followed.chunks, bodies: followed.bodies, ms: followed.ms };
        }
      } catch (e) {
        if (e instanceof EditCommandError) return refuse('invalid_args', 'validation', e.message, `/args/command${e.path}`);
        if (e instanceof EditRefused) return refuse(e.code, e.code === 'chunk_not_loaded' ? 'conflict' : 'validation', e.message);
        throw e;
      }
    } else if (op === 'writeKitTestScene') {
      const made = await writeKitTestScene(w.world, a);
      if (!made.ok) return made;
      ({ record, cells, box, parts, materialSwaps } = made);
      scene = made.scene;
    } else if (op === STRUCTURE_WRITE_OP) {
      const changes = a.changes as readonly StructureChange[];
      let made: Awaited<ReturnType<typeof applyStructureChanges>>;
      try {
        made = await applyStructureChanges(host, this.generator, changes);
      } catch (e) {
        // What the changes before the refused one did is in no record: the grids are read again from their files.
        if (e instanceof StructureWriteRefused || e instanceof StructureDefinitionError) {
          await this.reloadGrids(w, changes);
          return e instanceof StructureWriteRefused ? refuse(e.code, 'conflict', e.message) : refuse('invalid_structure', 'validation', e.message, `/definition${e.path}`);
        }
        throw e;
      }
      if (made.cells === 0 && made.overrides.size === 0) return refuse('no_change', 'validation', 'the structures already hold these voxels: nothing to write');
      record = made.record;
      cells = made.cells;
      box = NO_CELLS;
      parts = made.parts;
      materialSwaps = made.materialSwaps;
      for (const [grid, o] of made.overrides) flips.set(grid, { before: host.overrides(grid).bytes, after: o.bytes, value: o.value });
      structures = made.reports;
    } else if (op === SPLINE_WRITE_OP) {
      const made = await applySplineChanges({ world: w.world, record: (id) => this.recordOf(w, id) }, a.changes as readonly SplineChange[]);
      if (made.cells === 0 && made.records.size === 0) return refuse('no_change', 'validation', 'the splines already hold these voxels: nothing to write');
      record = made.record;
      cells = made.cells;
      box = made.box ?? NO_CELLS;
      parts = made.parts;
      materialSwaps = made.materialSwaps;
      for (const [id, r] of made.records) recordFlips.set(id, { before: this.recordOf(w, id).bytes, after: r.bytes, value: r.value });
      splines = made.reports;
    } else if (op === WATER_WRITE_OP) {
      const made = this.water.rewrite(await this.waterWorld(w), w.name, a.changes as readonly WaterChange[], this.waterBodies(w), a.boxes as readonly CellBox[]);
      if (made === null || made.cells === 0) {
        // Nothing to write; the bodies' reports stand for the world's route all the same.
        return refuse('no_change', 'validation', 'the water bodies already hold this water: nothing to write');
      }
      record = made.record;
      cells = made.cells;
      box = made.box ?? NO_CELLS;
      parts = made.parts;
      materialSwaps = made.materialSwaps;
      water = { box, parts, chunks: made.chunks, bodies: made.bodies, ms: made.ms };
    } else {
      const top = from[from.length - 1];
      if (top === undefined || top.stroke !== stroke) return refuse('history_gone', 'conflict', `voxel world ${w.name} holds no stroke ${stroke} to ${op} (the world was read again since, or the stroke was stepped by another command)`);
      from.pop();
      try {
        record = await w.undo.take(top.id);
      } catch (e) {
        return refuse('history_gone', 'conflict', `voxel world ${w.name}: the record of stroke ${stroke} is lost (${e instanceof Error ? e.message : String(e)}); it cannot be ${op === 'undo' ? 'undone' : 'redone'}`);
      }
      stepped = top;
      // What the bodies owned is the step's to change: they read it again from the voxels when next followed.
      this.water.forget(worldKey(w));
      if (top.water !== undefined) water = top.water;
      await this.ensureRecord(w, record);
      inverse = record.map((u) => ({ grid: u.grid, cx: u.cx, cy: u.cy, cz: u.cz, before: { kind: 'image', bytes: this.gridOf(w, u.grid).store.encodeChunk(u.cx, u.cy, u.cz) } }));
      this.undoInto(w, record);
      for (const f of top.overrides ?? []) flips.set(f.grid, { before: op === 'undo' ? f.after : f.before, after: op === 'undo' ? f.before : f.after });
      for (const f of top.records ?? []) recordFlips.set(f.entityId, { before: op === 'undo' ? f.after : f.before, after: op === 'undo' ? f.before : f.after });
      cells = top.cells;
      box = top.box;
      parts = top.parts;
      // Undoing a change takes each cell back from the material it took to the one it left; a redo makes it again.
      materialSwaps = op === 'undo' ? top.materialSwaps.map((sw) => materialSwap(swapTo(sw), swapFrom(sw))).sort((x, y) => x - y) : top.materialSwaps;
    }
    const t1 = performance.now();
    const structural = op === STRUCTURE_WRITE_OP || stepped?.structural === true;
    const saved = this.save(w, flips, recordFlips);
    // Saved files are clean: they may be dropped again (the next edit reaching them reads them back).
    w.world.trim();
    for (const g of w.grids.values()) g.trim();
    if (!saved.ok && saved.kind === 'external') {
      // Someone else's files: read the world again (memory and history describe the old ones).
      const again = await this.refresh(w);
      if (!Array.isArray(again)) return again;
      return this.changedRefusal(w, saved.changed);
    }
    if (!saved.ok && saved.kind === 'failed') {
      // Nothing was written: memory and history go back to what the files hold (the chunks stay dirty; the next save rewrites them as they are).
      if (stepped === null) this.undoInto(w, record);
      else {
        this.undoInto(w, inverse);
        from.push({ ...stepped, id: await w.undo.put(record) });
      }
      return refuse('write_failed', 'internal', `voxel world ${w.name}: ${saved.why}`);
    }
    // Written in full, or in part: memory keeps the change, which the files written hold.
    let made: number;
    if (stepped !== null) {
      to.push({ ...stepped, id: await w.undo.put(inverse) });
      made = stepped.stroke;
      // A regenerate's misfits answered again are its own: an undo or redo of a grid leaves none held.
      for (const u of record) w.reports.delete(u.grid);
      for (const f of strokeRecords(stepped)) w.splineReports.delete(f);
    } else {
      made = this.nextStroke++;
      const overrides = [...flips].map(([grid, f]) => ({ grid, before: f.before, after: f.after }));
      const records = [...recordFlips].map(([entityId, f]) => ({ entityId, before: f.before, after: f.after }));
      w.history.push({ stroke: made, id: await w.undo.put(record), cells, box, parts, materialSwaps, ...(overrides.length > 0 ? { overrides } : {}), ...(records.length > 0 ? { records } : {}), ...(structural ? { structural: true as const } : {}), ...(water !== undefined && op === 'editVoxels' ? { water: { box: water.box, parts: water.parts, chunks: water.chunks } } : {}) });
      // A new edit ends the redo of what was undone before it.
      for (const e of w.redo.splice(0)) await w.undo.drop(e.id);
      for (const r of structures ?? []) if (r.kind === 'write') w.reports.set(r.grid, r);
      for (const r of splines ?? []) w.splineReports.set(r.entityId, r);
    }
    if (!saved.ok) {
      return refuse('write_partial', 'internal', `voxel world ${w.name}: ${saved.why}. The ${isStep ? op : 'edit'} is applied in this backend and in ${saved.written.join(', ') || 'no file'}; ${saved.notWritten.join(', ') || 'no file'} still hold${saved.notWritten.length === 1 ? 's' : ''} the state before it, rewritten by the next save that succeeds`);
    }
    // A scene's record names a chunk once an edit of it: each chunk is answered once.
    const chunksOf = (id: number): Array<readonly [number, number, number]> => [...new Map(record.filter((u) => u.grid === id).map((u) => [`${u.cx},${u.cy},${u.cz}`, [u.cx, u.cy, u.cz] as const])).values()];
    const chunks = chunksOf(WORLD_GRID_ID);
    const gridIds = [...new Set(record.map((u) => u.grid).filter((g) => g !== WORLD_GRID_ID))].sort((x, y) => x - y);
    // The far field reads the grids where they stand: a hand edit on a grid builds the world chunks under it again
    // (a structure command does that itself once its objects are where the command leaves them).
    const far = await this.farAfter(w, w.manifest.revision - 1, [...chunks, ...(structural ? [] : this.farChunksOf(w, record))]);
    const files = [...new Set(record.map((u) => this.fileName(w, u)))].sort().map((name) => ({ name, etag: saved.tags.get(name) ?? this.fileTag(w, name) }));
    const answer: VoxelCommandApplied = {
      ok: true,
      op,
      requestId,
      world: w.name,
      revision: w.manifest.revision,
      far,
      cells,
      chunks,
      ...(gridIds.length > 0 ? { grids: gridIds.map((grid) => ({ grid, chunks: chunksOf(grid) })) } : {}),
      ...(structures !== undefined ? { structures: structures.map((r) => this.reportAt(w, r)) } : {}),
      ...(splines !== undefined ? { splines: splines.map(splineReportAt) } : {}),
      ...(water !== undefined ? { water } : {}),
      box,
      parts,
      materialSwaps,
      files,
      undoable: w.history.length,
      redoable: w.redo.length,
      stroke: made,
      duplicated: false,
      ms: { apply: t1 - t0, save: performance.now() - t1 },
      ...(scene !== undefined ? { scene } : {}),
    };
    if (requestId !== null) {
      w.answers.set(requestId, answer);
      if (w.answers.size > ANSWERS_KEPT) w.answers.delete(w.answers.keys().next().value!);
    }
    return answer;
  }

  /** A chunk's region file name as answers name it: the world grid's by name, a structure grid's `grid-<id>/<name>`. */
  private fileName(w: OpenWorld, c: ChunkCoord & { readonly grid?: number }): string {
    const name = addressName(addressOf(w.world.opts.grid, w.manifest.layout, w.manifest.footprint, c));
    return c.grid === undefined || c.grid === WORLD_GRID_ID ? name : `${gridFolder(c.grid)}/${name}`;
  }

  /** A region file's tag as last written or read ({@link fileName}'s names). */
  private fileTag(w: OpenWorld, name: string): string | null {
    const inGrid = /^grid-(\d+)\/(.+)$/.exec(name);
    return inGrid === null ? (w.world.files.get(name)?.hash ?? null) : (w.grids.get(Number(inGrid[1]))?.files.get(inGrid[2]!)?.hash ?? null);
  }

  /** The region world of grid `id` (a structure grid not on disk yet starts empty, in its folder to be). */
  private gridOf(w: OpenWorld, id: number): RegionWorld {
    if (id === WORLD_GRID_ID) return w.world;
    let g = w.grids.get(id);
    if (g === undefined) {
      g = RegionWorld.scan(join(w.dir, gridFolder(id)), worldOptions(w.manifest, id), [], this.opts.residentBytes);
      w.grids.set(id, g);
    }
    return g;
  }

  /** A spline's record as held (read on first use; absent: empty). */
  private recordOf(w: OpenWorld, entityId: string): HeldRecord {
    let held = w.records.get(entityId);
    if (held === undefined) {
      held = readSplineRecord(w.dir, w.world.opts.grid, entityId);
      w.records.set(entityId, held);
    }
    return held;
  }

  /** What a structure change needs of a world: its grids and their overrides. */
  private gridHost(w: OpenWorld): StructureGridHost {
    return {
      grid: w.world.opts.grid,
      gridWorld: (id) => this.gridOf(w, id),
      overrides: (id) => {
        let held = w.overrides.get(id);
        if (held === undefined) {
          held = readOverrides(join(w.dir, gridFolder(id)), w.world.opts.grid, id);
          w.overrides.set(id, held);
        }
        return held;
      },
    };
  }

  /** The world's water bodies as the project's scenes hold them now (placed ones only: a seed is a place). */
  private waterBodies(w: OpenWorld): SceneWaterBody[] {
    return this.opts.scenes === undefined ? [] : sceneWaterBodies(this.opts.scenes(w.projectId)).filter((b) => b.body.world === w.name && b.seed !== null);
  }

  /** The world as its water reads it: its grid and its placed structure grids, loaded whole (they are small). */
  private async waterWorld(w: OpenWorld): Promise<WaterWorld> {
    const grids: Array<{ place: GridPlacement; world: RegionWorld }> = [];
    for (const place of this.placements(w)) {
      if (!w.manifest.grids.some((g) => g.id === place.gridId) && !w.grids.has(place.gridId)) continue;
      const rw = this.gridOf(w, place.gridId);
      await rw.ensureAll();
      grids.push({ place, world: rw });
    }
    let rivers: CellSet | null = null;
    const riversOf = (): CellSet => (rivers ??= this.riverCells(w));
    return { key: worldKey(w), world: w.world, grids, rivers: riversOf };
  }

  /** The cells the world's splines wrote liquid into, from their records. */
  private riverCells(w: OpenWorld): CellSet {
    const out = new CellSet();
    const g = w.world.opts.grid;
    const s = g.shift;
    for (const id of new Set([...listedSplineRecords(w.dir), ...w.records.keys()])) {
      for (const c of this.recordOf(w, id).value.chunks.values()) {
        for (let k = 0; k < c.value.count; k++) {
          const v = c.value.values[k]!;
          if (v === 0 || !isLiquidRole(valueRole(v))) continue;
          const i = c.value.cells[k]!;
          out.add((c.cx << s) + (i >>> (s << 1)), (c.cy << s) + (i & g.mask), (c.cz << s) + ((i >>> s) & g.mask));
        }
      }
    }
    return out;
  }

  /** The world cells a hand edit on structure grid `gridId` can have changed (its chunks where the grid stands; none while it is not placed). */
  private gridEditBoxes(w: OpenWorld, gridId: number, chunks: readonly ChunkCoord[]): CellBox[] {
    const place = this.placements(w).find((p) => p.gridId === gridId);
    if (place === undefined || chunks.length === 0) return [];
    const s = w.world.opts.grid.shift;
    const b = { minX: Infinity, minY: Infinity, minZ: Infinity, maxX: -Infinity, maxY: -Infinity, maxZ: -Infinity };
    for (const c of chunks) {
      b.minX = Math.min(b.minX, c.cx << s);
      b.minY = Math.min(b.minY, c.cy << s);
      b.minZ = Math.min(b.minZ, c.cz << s);
      b.maxX = Math.max(b.maxX, ((c.cx + 1) << s) - 1);
      b.maxY = Math.max(b.maxY, ((c.cy + 1) << s) - 1);
      b.maxZ = Math.max(b.maxZ, ((c.cz + 1) << s) - 1);
    }
    return [gridBoxInWorld(b, place)];
  }

  /** Each placed body's report (held, or the fill read now). */
  private async waterReports(w: OpenWorld): Promise<WaterBodyReport[]> {
    const bodies = this.waterBodies(w);
    return bodies.length === 0 ? [] : this.water.reports(await this.waterWorld(w), bodies);
  }

  /** The chunks of an undo record loaded, each in its grid. */
  private async ensureRecord(w: OpenWorld, record: readonly ChunkUndo[]): Promise<void> {
    for (const id of new Set(record.map((u) => u.grid))) await this.gridOf(w, id).ensure(record.filter((u) => u.grid === id));
  }

  /** An undo record written back, each chunk into its grid. */
  private undoInto(w: OpenWorld, record: readonly ChunkUndo[]): void {
    for (const id of new Set(record.map((u) => u.grid))) this.gridOf(w, id).undo(record.filter((u) => u.grid === id));
  }

  /** Grids a refused structure command touched, read again from their files (what it applied is in no record). */
  private async reloadGrids(w: OpenWorld, changes: readonly StructureChange[]): Promise<void> {
    for (const id of new Set(changes.flatMap((c) => (c.kind === 'copy' ? [c.grid, c.from] : [c.grid])))) {
      const listed = w.manifest.grids.find((g) => g.id === id)?.regions ?? [];
      w.grids.set(id, RegionWorld.scan(join(w.dir, gridFolder(id)), worldOptions(w.manifest, id), listed, this.opts.residentBytes));
    }
  }

  /** The structure objects of the world's project naming this world (as stored now). */
  private structuresOf(w: OpenWorld): ReturnType<typeof sceneStructures> {
    return this.opts.scenes === undefined ? [] : sceneStructures(this.opts.scenes(w.projectId)).filter((s) => s.component.world === w.name);
  }

  /** The definition of the structure owning grid `id` (canonical, by the generator; null: no object owns it). */
  private structureDefinition(w: OpenWorld, id: number): StructureDefinition | null {
    const s = this.structuresOf(w).find((x) => x.component.grid === id);
    return s === undefined ? null : this.generator.canonical(structureDefinitionOf(s.component as unknown as Record<string, unknown>));
  }

  /** Where the world's structure grids stand: their objects' places (what the far field and an export read). */
  private placements(w: OpenWorld): GridPlacement[] {
    return this.opts.scenes === undefined ? [] : (structurePlacements(this.opts.scenes(w.projectId)).get(w.name) ?? []);
  }

  /** The world chunks the record's structure grids lie over where they stand (none while the far cache is not built). */
  private farChunksOf(w: OpenWorld, record: readonly ChunkUndo[]): Array<readonly [number, number, number]> {
    const ids = new Set(record.map((u) => u.grid).filter((g) => g !== WORLD_GRID_ID));
    if (ids.size === 0 || farCacheStale(w.farDir, w.manifest) === 'not built') return [];
    return placedGridChunks(w.dir, this.placements(w).filter((p) => ids.has(p.gridId)));
  }

  /** A grid's report with its misfits' places in the world (its structure's place now). */
  private reportAt(w: OpenWorld, r: StructureChangeReport): StructureGridReport {
    const place = this.placements(w).find((p) => p.gridId === r.grid);
    const frame = place === undefined ? null : new GridFrame(place);
    const m = VOXEL_SIZE_M;
    return { ...r, misfits: r.misfits.map((x) => ({ ...x, at: frame === null ? null : frame.toWorld((x.x + 0.5) * m, (x.y + 0.5) * m, (x.z + 0.5) * m) })) };
  }

  /**
   * Writes the dirty region files of every grid, the overrides files that
   * change (`flips`: the bytes after; null: the file goes) and the next
   * revision of the manifest (its grids: those holding a region file) as one
   * staged write (every file staged on disk first, the manifest renamed
   * last), then renews the files' stamps; the new tags by region file.
   */
  private save(w: OpenWorld, flips: ReadonlyMap<number, { readonly after: Uint8Array | null; readonly value?: StructureOverrides }> = new Map(), recordFlips: ReadonlyMap<string, { readonly after: Uint8Array | null; readonly value?: HeldRecord['value'] }> = new Map()): { ok: true; tags: Map<string, string | null> } | Exclude<StagedOutcome, { ok: true }> {
    const listedAfter = (rw: RegionWorld, prepared: ReturnType<RegionWorld['prepareSaves']>): string[] => {
      const listed = new Set(rw.listedRegions());
      for (const p of prepared) {
        if (p.bytes === null) listed.delete(p.name);
        else listed.add(p.name);
      }
      return [...listed].sort();
    };
    const parts = [w.world, ...[...w.grids.keys()].sort((x, y) => x - y).map((id) => w.grids.get(id)!)].map((world) => ({ world, prepared: world.prepareSaves() }));
    const grids = parts
      .slice(1)
      .map((p) => ({ id: p.world.gridId, regions: listedAfter(p.world, p.prepared) }))
      .filter((g) => g.regions.length > 0);
    const next: VoxelWorldManifest = { ...w.manifest, regions: listedAfter(w.world, parts[0]!.prepared), grids, revision: w.manifest.revision + 1 };
    const bytes = manifestBytes(next);
    const manifestPath = join(w.dir, VOXEL_WORLD_MANIFEST);
    const extra: StagedFile[] = [];
    for (const [grid, f] of flips) {
      if (f.after === null) continue;
      const dir = join(w.dir, gridFolder(grid));
      extra.push({ dir, name: STRUCTURE_OVERRIDES_FILE, bytes: f.after, expect: w.overrides.get(grid)?.hash ?? null });
    }
    for (const [id, f] of recordFlips) {
      if (f.after === null) continue;
      extra.push({ dir: join(w.dir, SPLINE_RECORDS_FOLDER), name: splineRecordFile(id), bytes: f.after, expect: this.recordOf(w, id).hash });
    }
    // A new grid's folder is made before its files are staged in it.
    for (const p of parts.slice(1)) if (p.prepared.some((x) => x.bytes !== null)) mkdirSync(p.world.dir, { recursive: true });
    for (const f of extra) mkdirSync(f.dir, { recursive: true });
    const out = commitWorldsStaged(parts, [{ dir: w.dir, name: VOXEL_WORLD_MANIFEST, bytes, expect: w.manifestHash }], this.opts.writeOps, extra);
    const written = out.ok || out.kind === 'partial' ? out.hashes : new Map<string, string>();
    for (const path of written.keys()) w.stamps.set(path, fileStamp(path));
    if (written.has(manifestPath)) {
      w.manifest = next;
      w.manifestHash = sha256HexNative(bytes);
      if (out.ok) for (const p of parts) p.world.flushRemovals();
    }
    for (const [grid, f] of flips) {
      const path = join(w.dir, gridFolder(grid), STRUCTURE_OVERRIDES_FILE);
      // A grid's overrides gone with it go once the manifest is written; a file written is held as written.
      if (f.after === null ? !out.ok : !written.has(path)) continue;
      if (f.after === null) replaceFile(join(w.dir, gridFolder(grid)), STRUCTURE_OVERRIDES_FILE, null, null);
      const value = f.value ?? readOverrides(join(w.dir, gridFolder(grid)), w.world.opts.grid, grid).value;
      w.overrides.set(grid, { bytes: f.after, hash: f.after === null ? null : sha256HexNative(f.after), value: f.after === null ? { ...value, chunks: new Map() } : value });
      w.stamps.set(path, fileStamp(path));
    }
    for (const [id, f] of recordFlips) {
      const dir = join(w.dir, SPLINE_RECORDS_FOLDER);
      const path = join(dir, splineRecordFile(id));
      // A record emptied goes once the manifest is written; a file written is held as written.
      if (f.after === null ? !out.ok : !written.has(path)) continue;
      if (f.after === null) replaceFile(dir, splineRecordFile(id), null, null);
      const value = f.value ?? readSplineRecord(w.dir, w.world.opts.grid, id).value;
      w.records.set(id, { bytes: f.after, hash: f.after === null ? null : sha256HexNative(f.after), value: f.after === null ? { ...value, chunks: new Map() } : value });
      w.stamps.set(path, fileStamp(path));
    }
    if (!out.ok) return out;
    const tags = new Map<string, string | null>();
    for (const p of parts) for (const x of p.prepared) tags.set(p.world.gridId === WORLD_GRID_ID ? x.name : `${gridFolder(p.world.gridId)}/${x.name}`, p.world.files.get(x.name)?.hash ?? null);
    return { ok: true, tags };
  }

  /**
   * Forgets a project's open worlds (or every world): called when a project
   * is closed, released or unregistered, so its next use reads the folder
   * again. A command already running finishes on the world it started on.
   */
  close(projectId?: string): void {
    for (const key of [...this.open.keys()]) if (projectId === undefined || key.startsWith(`${projectId}\u0000`)) this.open.delete(key);
    if (projectId === undefined) this.bakeAsked.clear();
    else this.bakeAsked.delete(projectId);
  }
}
