/**
 * One voxel world while a scene that names it is loaded: its streamer (the
 * world's files as the base, the game's changes in the overlay), the derive
 * work in the injected worker pool, the collision ring's bodies in the
 * runtime's physics port, and the answers of `ctx.voxels` for it.
 *
 * The chunk source and the pool are injected (`VoxelWorldConnection`), so
 * the runtime is the same in Play (range reads from the backend) and in an
 * exported game (whole files from the content closure); it never fetches.
 *
 * The update path: a change is applied to the overlay on the simulation's
 * thread in the step that asks for it (every cell it can touch must be
 * loaded, else nothing is written), so reads see it at once. The sections
 * within the rules' reach are derived again in workers and swap in
 * together: in the task that brings them, each storage chunk's body is
 * replaced from its new join (the `chunk` event), then the `swap` closes
 * the group and the change is reported at the next step.
 *
 * Lighting occupancy: the props marked `affectsLighting` are stamped into
 * a channel a resident chunk (`PropLightChannel`), combined when the chunk
 * loads and where a prop is placed, moves or goes (each prop sampled once
 * where it stands, the stamps spread over steps in the derive slice),
 * counted in the stream budget and never saved; `coverageAt` reads it
 * joined with the construction's own coverage from the drawn derive
 * results, and the walk's light stop reads it with the voxels (rays here,
 * and the page's walk blocks through the presentation).
 *
 * Paths: the world's walk graph (walk-graph.ts) is kept where it runs from
 * the drawn results' navigation, chunk by chunk as they arrive, change and
 * leave, in the derive slice after the open regions; `findPath` and `reach`
 * queue their queries (walk-graph-queries.ts), served in order by the world
 * list within the step's path-finding budget, and answered at a later step.
 * The graph and its searches go with the world. A world with structure grids
 * walks each grid in its own graph (voxel-grid-host.ts), linked to the
 * world's at doorsteps and foundation edges (walk-graph-links.ts), the
 * world's walker blocked by the grids' stamps; a path between them is joined
 * at a link (walk-graph-linked.ts).
 *
 * Saves: `save()` writes the overlay's changes as a voxel save file (the
 * fields the game marks saved, a base hash per chunk) once the bases of
 * chunks that left are read again, answered at a later step; `restore()`
 * replaces the overlay with a save's entries (never the base store), laid
 * over loaded chunks at once and over the others as they load.
 *
 * Structure grids: `ctx.voxels` reaches the grid a point lies in
 * (voxel-grid-access.ts: a structure's cell that is not air, else the
 * world's own): reads, exact rays through each grid in its own frame,
 * changes written to each grid's overlay (its chunks derived again, its
 * stamp read again, its links and body following its swap), and saves
 * holding every grid's changes, restored into each grid by its id.
 */
import { canonicalVoxelWorldRings, COLLIDER_3D_LIMITS, decodeBase64, encodeBase64, resolveVoxelWorld, validateVoxelWorldRings, type ModelErrorV2, type QualityLevelConfig, type ResolvedVoxelWorld, type VoxelWorldComponent, type VoxelWorldRings, type VoxelMaterialInfo, voxelMaterialInfos } from '@thirdlight/project-model';
import {
  heldWetness,
  applyWorldRings,
  canonicalEditCommand,
  chunkInWorld,
  chunkKey,
  collisionBodyParts,
  collisionGeometry,
  CollisionRing,
  collisionLeadPoints,
  collisionRingBounds,
  editBounds,
  EditCommandError,
  EditRefused,
  FarGround,
  MATERIAL_AIR,
  planeMask,
  PropLightChannel,
  readSave,
  SampleRing,
  STRUCTURE_STAMP_DEFAULT,
  type LitShape,
  type LitStamp,
  type StructureStampRule,
  type ShutOpeningWire,
  SaveFileError,
  setFineBricks,
  FarWalkNodes,
  OpenRegionStitch,
  streamerWalkSource,
  WalkGraph,
  walkRay,
  walkVoxels,
  WALK_STOPS,
  type WalkSource,
  VOXEL_PLANES,
  VOXEL_SIZE_M,
  VoxelStreamer,
  worldBudgetBytes,
  worldStreamer,
  writeSave,
  type CellBox,
  type ChunkGrid,
  type ChunkSource,
  type FarNodeSource,
  type GroundCoverage,
  type CollisionBodies,
  type CollisionRingFeed,
  type CollisionSource,
  type Focus,
  type PropShape,
  type StreamEvent,
  type VoxelEditCommand,
  type VoxelPlane,
  type VoxelRecord,
  type WorkerPool,
  type PieceTable,
  type GridPlacement,
  type ChunkBox,
} from '@thirdlight/voxel';
import { frameSliceMs, residentBytes, threadProfiler } from '@thirdlight/shared';

import type { ColliderShape3D, PhysicsPort3D } from './ports';
import { WorldPortals, type PortalProp } from './voxel-portals';
import { gridStats, streamerCollisionFeed, VoxelGridHost, type VoxelGridConnection } from './voxel-grid-host';
import { floorColumns, VoxelFloors } from './voxel-floor';
import { noPathAnswer, noReachAnswer, walkCellAt, walkOptionsOf } from './voxel-paths';
import { WorldPaths } from './voxel-world-paths';
import { cellCoverage, gridCellsIn, gridChunkBox, gridResident, raycastWithGrids, structureAt, structureBoxAt, VoxelChanges } from './voxel-grid-access';
import {
  regionCellList,
  regionCells,
  validPaint,
  voxelPortalInfo,
  voxelRayHit,
  voxelRegionInfo,
  writeRecord,
  type BehaviorVoxelWorld,
  type VoxelPortalInfo,
  type VoxelRayHit,
  type VoxelRayOptions,
  type VoxelRegionInfo,
  type RegionCells,
  type VoxelBox,
  type VoxelChange,
  type VoxelEditResult,
  type VoxelField,
  type VoxelMismatch,
  type VoxelMismatchChoice,
  type VoxelPaint,
  type VoxelRefusal,
  type VoxelRefused,
  type VoxelRegion,
  type VoxelRestoreResult,
  type VoxelRingChange,
  type VoxelRings,
  type VoxelRingsResult,
  type VoxelSaveAnswer,
  type VoxelValue,
  type VoxelPathAnswer,
  type VoxelReachAnswer,
  type VoxelWalkOptions,
  type VoxelWrite,
} from './voxel-api';

/** A script's ray walks, as a span of the simulation's frame (what its rays cost). */
const RAYCAST_SPAN = threadProfiler.span('voxel rays', 'scripts');
/** Stitching the chunks' open regions into the world's (open-region-stitch.ts), as streaming work of this thread. */
const REGIONS_SPAN = threadProfiler.span('open regions stitched', 'voxelStream');
/** Keeping the walk graph (walk-graph.ts) as chunks arrive, change and leave, in the derive slice after the regions. */
const WALK_GRAPH_SPAN = threadProfiler.span('walk graph stitched', 'voxelStream');
/** Keeping the far nodes' bricks for the walk where the world runs (copied as their draws leave for the page). */
const FAR_WALK_SPAN = threadProfiler.span('far walk nodes kept', 'voxelStream');
/** Reading a structure grid's cells for its stamp into the world grid (structure-stamp.ts), as its chunks arrive and leave. */
const GRID_STAMP_SPAN = threadProfiler.span('structure grids stamped into the world', 'voxelStream');
/** Stamping the lit props into the lighting occupancy (prop-channel.ts), in the derive's slice. */
const PROP_STAMP_SPAN = threadProfiler.span('prop light stamped', 'voxelStream');
/** A world's stats for the diagnostics: the streamer's, the open regions' and the far field's counts. */
/** The structure grids' streaming and bodies a step (each grid's foci moved into its frame), as streaming work of this thread. */
const GRIDS_SPAN = threadProfiler.span('structure grids streamed', 'voxelStream');
const STATS_SPAN = { stream: threadProfiler.span('voxel stats: streamer', 'other'), regions: threadProfiler.span('voxel stats: open regions', 'other'), far: threadProfiler.span('voxel stats: far field', 'other'), rest: threadProfiler.span('voxel stats: the rest', 'other') };

/** The id a structure grid's stamp has in its world's prop channel (beside the props' object ids). */
const gridStampId = (gridId: number): string => `grid:${gridId}`;

/** A world's chunk source and the workers its jobs run on, as the host (Play, an export, a test) provides them. */
export interface VoxelWorldConnection {
  /** The grid the world's files hold (its storage chunks). */
  readonly grid: ChunkGrid;
  /** The world's id (its manifest's): a save belongs to this world and no other. */
  readonly worldId: Uint8Array;
  readonly source: ChunkSource;
  /** The world's own pool: closed with the world. */
  readonly pool: WorkerPool;
  /** The world's memory budget in bytes (default the low tier's, `VOXEL_STREAM_BUDGET_BYTES.low`). */
  readonly budgetBytes?: number;
  /** The kit piece table its derives choose detail pieces from (the project's kits and piece seed, `worldPieceTable`; absent: no pieces). */
  readonly pieces?: PieceTable | null;
  /** The world's far cache (absent: nothing is drawn past the near rings). */
  readonly far?: FarNodeSource;
  /**
   * Fine far bricks past the detail ring built while playing, over the world's own `fineBuild`: true (the page's
   * `?fineBricks=1` bench switch), false (the page's renderer cannot build them: WebGL 2), absent: the world's.
   */
  readonly fineBricks?: boolean;
  /** Lets go of what the source holds (open files, connections); called once when the world unloads. */
  close?(): void;
  /**
   * The world's streamer once it is made (before it streams anything), for
   * what draws the world: it listens to the streamer's events and joins the
   * chunks it announces. `sectionEdge`: the world's derive section edge;
   * `regions`: the world's open regions as stitched here (their sky heights
   * travel with the draws); `props`: the world's prop lighting channel (the
   * walk's light stop joins it, and its changes are walk changes).
   */
  present?(stream: VoxelStreamer, sectionEdge: number, regions?: OpenRegionStitch, props?: PropLightChannel): void;
  /**
   * Structure grids streamed beside the world grid, each where it stands (a presentation makes them from
   * {@link placements}, or a bench's placements over them). Absent or empty: the world grid alone.
   */
  readonly grids?: readonly VoxelGridConnection[];
  /**
   * Where the world's structure grids stand, as the project's structure objects place them: what Play reads of the
   * backend's world route and an export ships in its catalog. Read when the world opens: a structure object moved
   * while the game runs moves no grid (structures are authoring objects).
   */
  readonly placements?: readonly GridPlacement[];
  /**
   * Opens one of the world's structure grids by id (null: the world lists no such grid): its chunk source and the
   * chunks its files hold. What a presentation reads to make {@link grids} from placements.
   */
  openGrid?(gridId: number): Promise<{ readonly source: ChunkSource; readonly extent: ChunkBox | null } | null>;
  /** A structure grid's streamer once it is made, for what draws it (its draws stand where `place` says). */
  presentGrid?(place: GridPlacement, stream: VoxelStreamer, sectionEdge: number): void;
  /**
   * A structure grid's shut openings that stop light changed (the whole set; cells in the grid's frame): what draws
   * the grid casts the sun's shadow over exactly them (voxel-portals.ts).
   */
  shutOpenings?(gridId: number, openings: readonly ShutOpeningWire[]): void;
  /**
   * How the structure grids are stamped into the world grid's light occupancy, sun heights and regions
   * (structure-stamp.ts; absent: `STRUCTURE_STAMP_DEFAULT`; null: not stamped, a bench's comparison).
   */
  readonly gridStamp?: StructureStampRule | null;
}

/** How the runtime reaches a project's voxel worlds (absent: a game's voxel worlds stream nothing and read null). */
export interface VoxelWorldPorts {
  /** Opens a world by its name (`voxels/<world>/`); a rejection leaves the world unloaded (logged). */
  open(world: string): Promise<VoxelWorldConnection>;
  /** The project's quality levels (absent: the engine's): the level the page reports scales each world's distances and sets its budget. */
  readonly qualityLevels?: readonly QualityLevelConfig[];
  /** The build's materials (resolved, as it ships them): the voxel ones answer `ctx.voxels.materialOf` (absent: none). */
  readonly materials?: VoxelMaterialSources;
}

/** Materials as the build ships them, the voxel ones read by voxel id. */
export type VoxelMaterialSources = Parameters<typeof voxelMaterialInfos>[0];

/** The step's view of where the world is looked at and what collides in it (world metres). */
export interface VoxelFoci {
  /** Where the world streams around. */
  readonly stream: readonly [number, number, number];
  /** Where bodies are kept around (the characters). */
  readonly collide: readonly (readonly [number, number, number])[];
  /** Their velocities (m/s, by the same index; absent or short: still): their collision is asked for ahead of them too. */
  readonly collideVelocity?: readonly (readonly [number, number, number])[];
}

const IDENTITY = Object.freeze({ x: 0, y: 0, z: 0, w: 1 });
const toCells = (p: readonly number[]): Focus => ({ x: p[0]! / VOXEL_SIZE_M, y: p[1]! / VOXEL_SIZE_M, z: p[2]! / VOXEL_SIZE_M });

/** The world's chunk bodies in the runtime's physics port, in world coordinates, a compound body a storage chunk. */
class PortBodies implements CollisionBodies {
  private readonly ids = new Map<number, string>();

  constructor(
    private readonly port: PhysicsPort3D,
    private readonly grid: ChunkGrid,
    private readonly prefix: string,
  ) {}

  set(key: number, cx: number, cy: number, cz: number, source: CollisionSource): number {
    this.remove(key);
    const geo = collisionGeometry(source, { maxVertices: COLLIDER_3D_LIMITS.meshVertices, maxTriangles: COLLIDER_3D_LIMITS.meshTriangles });
    const parts = collisionBodyParts(geo);
    if (parts.length === 0) return 0;
    // The port reads the typed arrays element by element; the runtime's shape lists them as plain lists.
    const shape = { type: 'compound', parts } as unknown as ColliderShape3D;
    const id = `${this.prefix}${cx},${cy},${cz}`;
    const m = this.grid.edge * VOXEL_SIZE_M;
    this.port.addStaticColliders!([{ entityId: id, shape, position: { x: cx * m, y: cy * m, z: cz * m }, rotation: IDENTITY }]);
    this.ids.set(key, id);
    return geo.bytes + (this.port.staticBodyBytes?.(shape) ?? 0);
  }

  remove(key: number): void {
    const id = this.ids.get(key);
    if (id === undefined) return;
    this.ids.delete(key);
    this.port.removeStaticColliders!([id]);
  }

  /** Every body out of the port (the world unloads). */
  clear(): void {
    if (this.ids.size > 0) this.port.removeStaticColliders!([...this.ids.values()]);
    this.ids.clear();
  }

  get count(): number {
    return this.ids.size;
  }
}

/** What the host reports to the world list. */
export interface VoxelHostEvents {
  /** A change swapped in (to `ctx.voxels.changes` at the next step). */
  changed(c: VoxelChange): void;
  /** A `whenResident` wait answered (to `ctx.voxels.waits` at the next step's start). */
  answered(wait: number, resident: boolean): void;
  /** A new wait's id. */
  nextWait(): number;
  /** A `save()` answered (to `ctx.voxels.saves` at the next step's start). */
  saved(a: VoxelSaveAnswer): void;
  /** A new save's id. */
  nextSave(): number;
  /** A restored chunk made on other world files than now (to `ctx.voxels.mismatches` at the next step). */
  mismatch(m: VoxelMismatch): void;
  /** A path or reach query answered (to `ctx.voxels.paths` or `reaches` at the next step's start). */
  pathAnswered(a: VoxelPathAnswer): void;
  reachAnswered(a: VoxelReachAnswer): void;
  /** A new path or reach query's id. */
  nextQuery(): number;
  /** Why a world could not load or a step's work failed. */
  warn(message: string): void;
}

/** What a world's host holds and does (diagnostics): its stream, its pool and its far field. */
export interface VoxelHostStats {
  readonly world: string;
  readonly open: boolean;
  readonly resident: number;
  readonly bytes: number;
  readonly overlayBytes: number;
  readonly bodies: number;
  /** The coarse floor's bodies now and since the world opened: added, removed, handed to the fine ground, bodies lifted. */
  readonly floors?: { readonly count: number; readonly added: number; readonly removed: number; readonly handedOver: number; readonly lifted: number };
  readonly propChannelBytes: number;
  /** The structure grids' stamps into the world grid (absent: none stamped): the rule, the classes' bytes, stamps waiting, the sampling steps run and their ms (a step: a row of world cells at least, more while the derive slice lasts). */
  readonly gridStamps?: { readonly rule: StructureStampRule; readonly grids: number; readonly classBytes: number; readonly pending: number; readonly samples: number; readonly sampleMs: { readonly p50: number; readonly max: number } };
  readonly pool?: { readonly workers: number; readonly queued: number; readonly queuedKinds: Readonly<Record<string, number>>; readonly inFlight: number; readonly done: number; readonly queueFull: number; readonly cancelledQueued: number; readonly cancelledSent: number; readonly runMs: { readonly p50: number; readonly p95: number }; readonly workerMs: { readonly p50: number } };
  /** The open regions stitched (counts, bytes held) and the derive µs of a section's regions beside its mesh and its whole derive. */
  readonly regions?: Readonly<Record<string, unknown>> & { readonly regions: number; readonly enclosed: number; readonly portals: number; readonly bytes: number };
  /** The walk graph (chunks, cells, pieces, exits, made and kept, bytes) and its queries (queued, nodes and queries served). */
  readonly walk?: Readonly<Record<string, unknown>> & { readonly chunks: number; readonly pending: boolean; readonly bytes: number; readonly queued: number };
  readonly far?: Readonly<Record<string, unknown>> & { readonly selected: number; readonly drawn: number; readonly pending: number };
  /** Streamer updates, those where the ground under the focus or a second ahead of it was not resident and derived, and those with no ground within the ring's height under the focus. */
  readonly coverage?: Readonly<GroundCoverage>;
  /**
   * The voxels read round the focus (metres): the load ring as set, the ring read now (narrowed at speed, or ended at
   * the detail ring's reach where the fine far levels are baked round the focus), and that reach (null: none).
   */
  readonly readRing?: { readonly setM: number; readonly nowM: number; readonly reachM: number | null };
  /** The structure grids streamed beside the world grid: how many, their resident chunks and bytes, their bodies (absent: none). */
  readonly grids?: { readonly count: number; readonly resident: number; readonly reading: number; readonly decoding: number; readonly deriving: number; readonly bytes: number; readonly bodies: number; readonly shapes: number; readonly bodyBuilds: number; readonly bodyBuildMs: number; readonly updates: number; readonly skipped: number; readonly waits: Readonly<Record<string, number>>; readonly bytesPerGrid: { readonly min: number; readonly max: number }; readonly nearest: Readonly<Record<string, unknown>> | null };
}

/** A cell's record read by `get` (one use at a time, on this thread). */
const SCRATCH_CELL: VoxelRecord = { material: 0, role: 0, shape: 0, wetness: 0 };

export class VoxelWorldHost {
  readonly name: string;
  /** The distances and settings in use: the scene's (as a script changed them) at the quality level. */
  settings: ResolvedVoxelWorld;
  /** The scene's ring distances as a script set them (the object's own until `setRings`). */
  private rings0: VoxelWorldRings;
  private level: QualityLevelConfig | null;
  private conn: VoxelWorldConnection | null = null;
  private streamer: VoxelStreamer | null = null;
  private unresident: (() => void) | null = null;
  private ring: CollisionRing | null = null;
  private bodies: PortBodies | null = null;
  /** The coarse floor where fine collision is late (null: no physics port, or no far cache). */
  private floors: VoxelFloors | null = null;
  /** The props' lighting occupancy over the resident chunks (null until the world is open). */
  private channel: PropLightChannel | null = null;
  /** The far nodes drawn, kept for rays past the rings (their bricks copied before they leave for the page). */
  private farWalk: FarWalkNodes | null = null;
  private walkSource: WalkSource | null = null;
  private unresidentWalk: (() => void) | null = null;
  /** The world's open regions, stitched as chunks' results arrive (null: no world open). */
  private regions: OpenRegionStitch | null = null;
  private unresidentRegions: (() => void) | null = null;
  /** The world's walk graph and its queries (null: no world open). */
  private walk: WalkGraph | null = null;
  private paths: WorldPaths | null = null;
  private unresidentWalkGraph: (() => void) | null = null;
  /** The props stamped into the world, by object: kept while the world opens, placed into the channel when it is. */
  private readonly props = new Map<string, PropShape>();
  /** The structure grids opened with the world (empty: the world grid alone). */
  private grids: VoxelGridHost[] = [];
  /** The props with a portal and the openings they stand in (their shut state applied to light and walkers). */
  private readonly portals = new WorldPortals(() => this.grids, () => this.channel, (g, list) => this.conn?.shutOpenings?.(g.frame.gridId, list));
  /** How the grids are stamped into the world grid (null: not stamped, or no grids). */
  private stampRule: StructureStampRule | null = null;
  /** µs each step of a grid's stamp sampling took (a row of world cells at least, more while the derive slice lasts). */
  private readonly gridStampUs = new SampleRing();
  private disposed = false;
  private readonly waits: { readonly cells: RegionCells; readonly id: number }[] = [];
  /** Changes until their swaps, in the world grid and its structure grids. */
  private readonly changes: VoxelChanges;
  /** The world's cells as a light ray through structure grids walks them: the lit props, not the grids' stamps (null: no grid). */
  private lightWalk: WalkSource | null = null;
  /** The props' coverage without the grids' stamps (null: no grid). */
  private propsView: ReturnType<PropLightChannel['propsOnly']> | null = null;
  /** Resident chunks whose derive results arrived (their bodies are their ground, not a placeholder). */
  private readonly derived = new Set<number>();
  /** The world is being opened (bodies wait for it; a world that cannot open holds nothing up). */
  private opening = false;
  /** The fields a save keeps (a plane mask): the world's setting until the game sets them, again each run. */
  private savedFields: number;
  /** Bumped by each new run: a save answered after it belongs to the run before and is dropped. */
  private run = 0;
  readonly api: BehaviorVoxelWorld;

  constructor(
    /** The `voxelWorld` component of the object that brought the world. */
    readonly component: VoxelWorldComponent,
    level: QualityLevelConfig | null,
    ports: VoxelWorldPorts | null,
    private readonly physics: PhysicsPort3D | undefined,
    private readonly events: VoxelHostEvents,
    private readonly nextEdit: () => number,
    /** The build's voxel materials by id (the same for every world of the game). */
    private readonly materials: ReadonlyMap<number, VoxelMaterialInfo> = new Map(),
  ) {
    this.rings0 = component;
    this.level = level;
    const settings = resolveVoxelWorld(component, level);
    this.name = settings.world;
    this.settings = settings;
    this.changes = new VoxelChanges(this.name, (c) => events.changed(c));
    this.savedFields = settings.savedFields;
    this.api = Object.freeze({
      name: this.name,
      get: (x: number, y: number, z: number) => this.get(x, y, z),
      coverageAt: (x: number, y: number, z: number) => this.coverageAt(x, y, z),
      raycast: (origin: readonly [number, number, number], direction: readonly [number, number, number], maxDistance: number, options?: VoxelRayOptions) => this.raycast(origin, direction, maxDistance, options),
      regionAt: (x: number, y: number, z: number) => this.regionAt(x, y, z),
      portalsOf: (id: number) => this.portalsOf(id),
      findPath: (from: readonly [number, number, number], to: readonly [number, number, number], options?: VoxelWalkOptions) => this.findPath(from, to, options),
      reach: (from: readonly [number, number, number], maxDistance: number, options?: VoxelWalkOptions & { readonly points?: boolean }) => this.reach(from, maxDistance, options),
      materialAt: (x: number, y: number, z: number) => {
        const v = this.get(x, y, z);
        return v === null ? null : (this.materials.get(v.material) ?? null);
      },
      materialOf: (id: number) => this.materials.get(id) ?? null,
      set: (region: VoxelRegion, voxel: VoxelWrite) => this.set(region, voxel),
      dig: (region: VoxelRegion) => this.dig(region),
      paint: (region: VoxelRegion, paint: VoxelPaint) => this.paint(region, paint),
      isResident: (region: VoxelRegion) => this.isResident(region),
      whenResident: (region: VoxelRegion) => this.whenResident(region),
      setSavedFields: (fields: readonly VoxelField[]) => this.setSavedFields(fields),
      save: () => this.save(),
      restore: (save: Uint8Array | string, onMismatch: VoxelMismatchChoice) => this.restore(save, onMismatch),
      rings: () => this.ringsInUse(),
      setRings: (change: VoxelRingChange | null) => this.setRings(change),
    });
    if (ports === null) return;
    this.opening = true;
    ports.open(this.name).then(
      (conn) => this.connect(conn),
      (e: unknown) => {
        this.opening = false;
        if (!this.disposed) events.warn(`voxel world "${this.name}" could not be opened: ${e instanceof Error ? e.message : String(e)}`);
      },
    );
  }

  private connect(conn: VoxelWorldConnection): void {
    if (this.disposed) {
      conn.pool.close();
      conn.close?.();
      return;
    }
    this.conn = conn;
    const s = this.settings;
    const streamer = worldStreamer(conn, s);
    this.streamer = streamer;
    // The memory report reads the streamer's own count against its budget.
    this.unresident?.();
    this.unresident = residentBytes.register('voxelStream', () => streamer.held.total);
    const port = this.physics;
    if (port !== undefined && typeof port.addStaticColliders === 'function' && typeof port.removeStaticColliders === 'function') {
      this.bodies = new PortBodies(port, conn.grid, `voxel:${this.name}:`);
      this.ring = new CollisionRing({ grid: conn.grid, bodies: this.bodies, feed: this.collisionFeed(streamer), bounds: this.collisionBounds() });
      const far = streamer.far;
      if (far !== null) {
        const ground = new FarGround({ source: far.cache.source, index: () => far.cache.index(), jobId: () => far.cache.jobId(), pool: conn.pool, grid: conn.grid, poke: () => undefined });
        this.floors = new VoxelFloors(port, conn.grid, `voxel:${this.name}:`, ground);
      }
    }
    // The collision-only derives ask within the ring's add bounds, with or without a physics port (a test's ring reads them).
    if (streamer.collision !== null) streamer.collision.bounds = this.collisionBounds();
    const channel = new PropLightChannel(streamer, VOXEL_SIZE_M);
    channel.apply(this.props);
    this.channel = channel;
    // Rays past the rings march the far nodes drawn: their bricks are copied as they go out (the batches hand theirs over).
    const farWalk = streamer.far !== null ? new FarWalkNodes(conn.grid.edge, true) : null;
    if (farWalk !== null)
      streamer.far!.on((e) => {
        threadProfiler.begin(FAR_WALK_SPAN);
        try {
          farWalk.apply(e);
        } finally {
          threadProfiler.end(FAR_WALK_SPAN);
        }
      });
    this.farWalk = farWalk;
    this.walkSource = streamerWalkSource(streamer, farWalk, { props: channel });
    this.unresidentWalk?.();
    this.unresidentWalk = farWalk === null ? null : residentBytes.register('voxelStream', () => farWalk.bytes);
    // Structure grids are stamped into the props' channel; the regions and the walk graph read their classes (never with no grid).
    const stampRule = (conn.grids ?? []).some((g) => g.extent !== null) ? (conn.gridStamp === undefined ? STRUCTURE_STAMP_DEFAULT : conn.gridStamp) : null;
    this.stampRule = stampRule;
    const regions = new OpenRegionStitch(streamer, stampRule !== null ? channel : null);
    this.regions = regions;
    this.unresidentRegions?.();
    this.unresidentRegions = residentBytes.register('regionStitch', () => regions.bytes);
    // The world's walker goes round a structure grid's stamp (it blocks, it carries nothing): the grid is walked in its own graph.
    const walk = new WalkGraph(streamer, VOXEL_SIZE_M, stampRule !== null ? { stamps: channel } : null);
    if (stampRule !== null)
      channel.listen((cx, cy, cz, classes) => {
        if (!classes) return;
        regions.touch(cx, cy, cz);
        walk.touchStamp(cx, cy, cz);
      });
    const paths = new WorldPaths(walk);
    this.walk = walk;
    this.paths = paths;
    this.unresidentWalkGraph?.();
    this.unresidentWalkGraph = residentBytes.register('walkGraph', () => walk.bytes + paths.bytes);
    streamer.on((e) => this.onStream(e));
    conn.present?.(streamer, s.sectionEdge, regions, channel);
    // The structure grids: their own streamers in the world's pool under its job ids, a body each.
    for (const g of conn.grids ?? []) {
      if (g.extent === null) continue;
      const host = new VoxelGridHost(this.name, conn.grid, g, s, { pool: conn.pool, tracker: streamer.tracker, ...(conn.pieces !== undefined ? { pieces: conn.pieces } : {}), ...(conn.budgetBytes !== undefined ? { budgetBytes: conn.budgetBytes } : {}) }, this.physics);
      this.grids.push(host);
      conn.presentGrid?.(g.place, host.streamer, s.sectionEdge);
      // A change of `ctx.voxels` in the grid is reported once its swap is in, its pieces as world boxes.
      const id = g.place.gridId;
      host.streamer.on((e) => {
        if (this.disposed) return;
        if (e.type === 'chunk') this.changes.chunk(id, e.cx, e.cy, e.cz, e.shaderOnly);
        else if (e.type === 'swap') {
          host.walk.editSwapped(e.report.groups);
          this.changes.swap(id, e.report, (cx, cy, cz) => gridChunkBox(host, cx, cy, cz));
        }
        else if (e.type === 'mismatch') this.events.mismatch(Object.freeze({ world: this.name, grid: id, chunk: gridChunkBox(host, e.cx, e.cy, e.cz), kept: e.applied }));
      });
    }
    // The lower grid id wins where structures overlap: the grids are kept in that order.
    this.grids.sort((a, b) => a.frame.gridId - b.frame.gridId);
    if (this.grids.length > 0) {
      this.propsView = channel.propsOnly();
      this.lightWalk = streamerWalkSource(streamer, farWalk, { props: this.propsView });
    }
    paths.linkGrids(this.grids);
  }

  /**
   * What a chunk's body is made of: its collision-only join while that is of the chunk as it is now (stream-collision.ts:
   * the same surface the full join gives), else its full sections joined once all have results, else the
   * collision-only join it has, else the full sections it has.
   */
  private collisionFeed(streamer: VoxelStreamer): CollisionRingFeed {
    return streamerCollisionFeed(streamer);
  }

  /** Whether a chunk's body is its ground: its full result arrived whole, or its collision-only one did. */
  private chunkCollides(cx: number, cy: number, cz: number): boolean {
    const s = this.streamer!;
    return (this.derived.has(chunkKey(this.conn!.grid, cx, cy, cz)) && s.chunkReady(cx, cy, cz)) || s.collision?.source(cx, cy, cz) != null;
  }

  /** The collision ring's bounds (cells): never past the load ring, which holds the chunks the bodies are made of. */
  private collisionBounds(): ReturnType<typeof collisionRingBounds> {
    const s = this.settings;
    const cells = (m: number): number => m / VOXEL_SIZE_M;
    return collisionRingBounds({ radius: Math.min(cells(s.collision.radius), cells(s.ring.loadRadius)), height: Math.min(cells(s.collision.height), cells(s.ring.loadHeight)) });
  }

  /** The quality level the page draws at (null: none known): the distances and budget follow it, without a reload. */
  setQuality(level: QualityLevelConfig | null): void {
    this.level = level;
    this.applyRings();
  }

  /** Resolves the distances again and hands them to the running streamer and collision ring. */
  private applyRings(): void {
    this.settings = resolveVoxelWorld({ ...this.component, ...this.rings0 }, this.level);
    if (this.streamer === null || this.disposed) return;
    applyWorldRings(this.streamer, this.settings);
    const fine = this.conn?.fineBricks ?? this.settings.fineBricks;
    if (this.streamer.far !== null && this.streamer.far.fineNodes.wanted !== fine) setFineBricks(this.streamer, fine);
    this.ring?.setBounds(this.collisionBounds());
    if (this.streamer.collision !== null) this.streamer.collision.bounds = this.collisionBounds();
    for (const g of this.grids) g.setRings(this.settings);
  }

  private ringsInUse(): VoxelRings {
    const s = this.settings;
    return Object.freeze({ ring: s.ring, collision: s.collision, levels: s.levels, quality: s.quality, budgetBytes: s.budgetBytes, reliefSteps: s.reliefSteps });
  }

  /**
   * A script's change of the scene's distances: each field it gives replaces
   * the scene's (null: the object's own again), then the quality level
   * applies. Refused whole when a field is unknown or out of range.
   */
  private setRings(change: VoxelRingChange | null): VoxelRingsResult {
    if (change === null) {
      this.rings0 = this.component;
      this.applyRings();
      return Object.freeze({ ok: true, rings: this.ringsInUse() });
    }
    const errors: ModelErrorV2[] = [];
    if (typeof change !== 'object' || Array.isArray(change)) errors.push({ code: 'field_type', path: '', message: 'a ring change is { ring?, collision?, levels? } in metres' } as ModelErrorV2);
    else {
      for (const k of Object.keys(change)) if (k !== 'ring' && k !== 'collision' && k !== 'levels') errors.push({ code: 'field_unexpected', path: `/${k}`, message: `unknown ring group "${k}" (ring, collision, levels)` } as ModelErrorV2);
      validateVoxelWorldRings(change as Record<string, unknown>, '', errors);
    }
    if (errors.length > 0) return this.refuse('invalid', errors.map((e) => `${e.path || '/'}: ${e.message}`).join('; '));
    const next: VoxelWorldRings = {};
    canonicalVoxelWorldRings({ ring: { ...this.rings0.ring, ...change.ring }, collision: { ...this.rings0.collision, ...change.collision }, levels: { ...this.rings0.levels, ...change.levels } }, next);
    this.rings0 = next;
    this.applyRings();
    return Object.freeze({ ok: true, rings: this.ringsInUse() });
  }

  private onStream(e: StreamEvent): void {
    if (this.disposed) return;
    if (e.type === 'loaded') this.channel?.loaded(e.cx, e.cy, e.cz);
    else if (e.type === 'unloaded') {
      this.regions?.touch(e.cx, e.cy, e.cz);
      this.walk?.touch(e.cx, e.cy, e.cz);
      this.channel?.unloaded(e.cx, e.cy, e.cz);
      this.derived.delete(chunkKey(this.conn!.grid, e.cx, e.cy, e.cz));
      this.ring?.unloaded(e.cx, e.cy, e.cz);
    } else if (e.type === 'chunk') {
      this.derived.add(chunkKey(this.conn!.grid, e.cx, e.cy, e.cz));
      // The body follows the chunk's new join in this task, so it swaps with the draw and the shader data; a change of
      // the relief meshes alone (the relief ring moved) leaves what collides as it was.
      if (!e.shaderOnly && !e.reliefOnly) {
        this.ring?.changed(e.cx, e.cy, e.cz);
        this.regions?.touch(e.cx, e.cy, e.cz);
        this.walk?.touch(e.cx, e.cy, e.cz);
      }
      this.changes.chunk(0, e.cx, e.cy, e.cz, e.shaderOnly);
    } else if (e.type === 'collision') {
      // A collision-only result: the body stands for the chunk's ground until its full result replaces it (the same surface).
      this.ring?.changed(e.cx, e.cy, e.cz);
    } else if (e.type === 'mismatch') {
      this.events.mismatch(Object.freeze({ world: this.name, grid: 0, chunk: this.chunkBox(e.cx, e.cy, e.cz), kept: e.applied }));
    } else if (e.type === 'swap') {
      this.walk?.editSwapped(e.report.groups);
      this.changes.swap(0, e.report, (cx, cy, cz) => this.chunkBox(cx, cy, cz));
    }
  }

  private chunkBox(cx: number, cy: number, cz: number): VoxelBox {
    const m = this.conn!.grid.edge * VOXEL_SIZE_M;
    return Object.freeze({ min: Object.freeze([cx * m, cy * m, cz * m] as const), max: Object.freeze([(cx + 1) * m, (cy + 1) * m, (cz + 1) * m] as const) });
  }

  /** The step's start: the foci move, streaming plans, bodies enter and leave the ring, waits whose cells arrived resolve. */
  step(foci: VoxelFoci): void {
    const s = this.streamer;
    if (s === null || this.disposed) return;
    const f = toCells(foci.stream);
    s.setFocus(f.x, f.y, f.z);
    if (this.grids.length > 0) {
      // Before the world grid's: a structure grid's few chunks take their room in the shared pool first, so a world
      // grid that keeps the pool's queue full never starves them.
      threadProfiler.begin(GRIDS_SPAN);
      try {
        this.shareBudget(s);
        for (const g of this.grids) g.step(foci.stream, foci.collide, foci.collideVelocity, this.settings);
        this.portals.step();
      } finally {
        threadProfiler.end(GRIDS_SPAN);
      }
    }
    const bodies = foci.collide.map(toCells);
    // Level 0 is drawn round every collision focus too: what a character touches is what is drawn.
    s.mips?.lod.setFoci(bodies);
    // Collision follows the bodies and the way they are going; the camera's ground only while it is not travelling fast
    // (at rest it is what scripts cast rays at near the view), not at speed, where nothing stands on it.
    const radius = this.collisionBounds().radius;
    const ahead = bodies.flatMap((b, i) => {
      const v = foci.collideVelocity?.[i];
      return v === undefined ? [] : collisionLeadPoints(b, toCells(v), radius);
    });
    const collide = [...(s.detail.fast ? [] : [f]), ...bodies, ...ahead];
    s.collision?.setFoci(collide);
    s.update();
    const channel = this.channel;
    if (channel !== null && this.stampRule !== null) this.restampGrids(channel, this.stampRule);
    if (channel?.pending === true) {
      // The props' stamps in the derive slice, as its other streaming work: a scene's props arriving at once take steps.
      threadProfiler.begin(PROP_STAMP_SPAN);
      try {
        const t0 = performance.now();
        const ms = frameSliceMs('voxelDerive');
        channel.update(() => performance.now() - t0 < ms);
      } finally {
        threadProfiler.end(PROP_STAMP_SPAN);
      }
    }
    const sliceMs = frameSliceMs('voxelDerive');
    const stitchT0 = performance.now();
    if (this.regions?.pending === true) {
      // The derive slice: stitching follows the chunks the derives let through, a share of the same streaming work.
      threadProfiler.begin(REGIONS_SPAN);
      try {
        this.regions.update(sliceMs);
      } finally {
        threadProfiler.end(REGIONS_SPAN);
      }
    }
    if (this.walk?.pending === true) {
      // The walk graph takes what the regions left of the same slice (at least one chunk an update).
      threadProfiler.begin(WALK_GRAPH_SPAN);
      try {
        this.walk.update(sliceMs - (performance.now() - stitchT0));
      } finally {
        threadProfiler.end(WALK_GRAPH_SPAN);
      }
    }
    if (this.paths?.pending === true) {
      // The structure grids' own walk graphs and their links, in what the slice leaves.
      threadProfiler.begin(WALK_GRAPH_SPAN);
      try {
        this.paths.update(sliceMs - (performance.now() - stitchT0));
      } finally {
        threadProfiler.end(WALK_GRAPH_SPAN);
      }
    }
    if (this.ring !== null) {
      this.ring.setFoci(collide);
      this.ring.update();
      if (this.floors !== null) {
        const b = this.collisionBounds();
        const ring = this.ring;
        this.floors.update(floorColumns(s.grid, collide, b.radius, b.keepRadius), (cx, cz) => ring.columnSettled(cx, cz, (x, y, z) => this.chunkCollides(x, y, z)));
      }
    }
    for (let i = 0; i < this.waits.length; ) {
      const w = this.waits[i]!;
      if (!this.resident(w.cells)) {
        i++;
        continue;
      }
      this.waits.splice(i, 1);
      this.events.answered(w.id, true);
    }
  }

  /** The grids whose chunks arrived or left since their stamp: read again and placed (sampled in the derive slice). */
  private restampGrids(channel: PropLightChannel, rule: StructureStampRule): void {
    let changes: [string, LitShape | null][] | null = null;
    threadProfiler.begin(GRID_STAMP_SPAN);
    try {
      for (const g of this.grids) {
        if (!g.stampDirty) continue;
        const stamp = g.stamp(rule, VOXEL_SIZE_M);
        const shape: LitStamp | null =
          stamp === null
            ? null
            : {
                stamp: true,
                bounds: () => stamp.bounds(),
                sample: (m) => stamp.sample(m),
                // Sampled a row of world cells at a time in the derive slice: a large building arriving takes steps.
                sampler: (m) => {
                  const run = stamp.sampler(m);
                  return {
                    step: (more) => {
                      const t0 = performance.now();
                      const done = run.step(more);
                      this.gridStampUs.add((performance.now() - t0) * 1000);
                      return done ? run.result() : null;
                    },
                  };
                },
              };
        (changes ??= []).push([gridStampId(g.frame.gridId), shape]);
      }
      if (changes !== null) channel.apply(changes);
    } finally {
      threadProfiler.end(GRID_STAMP_SPAN);
    }
  }

  /**
   * One budget for the world grid and its structure grids. The grids come first: the world grid's share is the
   * budget less what the grids hold, so past it the world grid evicts its own farthest chunks (its ring's far edge,
   * farther than anything a grid in reach holds); a grid's is the budget less the other grids', so grids evict only
   * when they alone would fill it.
   */
  private shareBudget(s: VoxelStreamer): void {
    const budget = worldBudgetBytes(this.settings, this.conn?.budgetBytes);
    let grids = 0;
    for (const g of this.grids) grids += g.streamer.held.total;
    s.budgetBytes = Math.max(1, budget - grids);
    for (const g of this.grids) g.setBudget(budget - (grids - g.streamer.held.total));
  }

  /**
   * Whether the world's collision under a point (world metres) is in place:
   * the world is open and every chunk of the column within the collision
   * ring has its body from its derived ground, or the column has its coarse
   * floor and the body (at height `y`, when given) is not in a cave under it.
   * Without a physics port nothing collides here, so nothing waits for it.
   */
  collisionReadyAt(x: number, z: number, y?: number): boolean {
    if (this.disposed) return true;
    if (this.streamer === null) return !this.opening || this.physics === undefined;
    const ring = this.ring;
    if (ring === null) return true;
    const grid = this.conn!.grid;
    const sh = grid.shift;
    // A chunk counts once every section has its result (or its collision-only result is in): its first `chunk` event
    // may carry only some of them (a section waits while a chunk its apron reaches is still loading), and a body let
    // go then falls through.
    return ring.columnSettled(Math.floor(x / VOXEL_SIZE_M) >> sh, Math.floor(z / VOXEL_SIZE_M) >> sh, (cx, cy, cz) => this.chunkCollides(cx, cy, cz)) || this.floors?.holds(x, z, y) === true;
  }

  /**
   * Where a body at (x, y, z) (world metres, its feet) is to be lifted to: the fine ground's height where it replaced
   * the column's coarse floor this step and holds the body inside it; null otherwise.
   */
  riseAt(x: number, y: number, z: number): number | null {
    return this.floors?.riseAt(x, y, z) ?? null;
  }

  /** A new run: the game's changes are dropped (the world reads as its files again, rebuilt in one swap). */
  reset(): void {
    // Queries of the run before are answered (unknown) and dropped with its answers.
    this.paths?.clear();
    this.streamer?.clearOverlay();
    for (const g of this.grids) g.reset();
    this.changes.clear();
    this.savedFields = this.settings.savedFields;
    this.run++;
  }

  /** The scene that named the world unloaded: bodies out of physics, workers stopped, waits answered false. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.floors?.clear();
    this.bodies?.clear();
    this.portals.clear();
    for (const g of this.grids) g.dispose();
    this.grids = [];
    this.conn?.pool.close();
    this.conn?.close?.();
    for (const w of this.waits.splice(0)) this.events.answered(w.id, false);
    this.changes.clear();
    this.lightWalk = null;
    this.propsView = null;
    this.streamer = null;
    this.unresident?.();
    this.unresident = null;
    this.ring = null;
    this.channel = null;
    this.unresidentWalk?.();
    this.unresidentWalk = null;
    this.unresidentRegions?.();
    this.unresidentRegions = null;
    this.regions?.clear();
    this.regions = null;
    this.paths?.clear();
    this.paths = null;
    this.walk?.clear();
    this.walk = null;
    this.unresidentWalkGraph?.();
    this.unresidentWalkGraph = null;
    this.farWalk?.clear();
    this.farWalk = null;
    this.walkSource = null;
    this.derived.clear();
  }

  /**
   * Props marked `affectsLighting` placed or moved (their shapes where they
   * now are) or gone (null), together: recorded now, stamped in the steps'
   * derive slices (each prop sampled once, the cells it left and entered
   * combined again).
   */
  stampProps(changes: readonly (readonly [string, PropShape | null])[], portals: readonly (readonly [string, PortalProp | null])[] = []): void {
    if (this.disposed) return;
    // Props with a portal (voxel-portals.ts), placed, changed or gone: joined to their openings, their state applied there.
    if (portals.length > 0) {
      this.portals.set(portals);
      if (this.grids.length > 0) this.portals.step();
    }
    if (changes.length === 0) return;
    for (const [id, shape] of changes) {
      if (shape !== null) this.props.set(id, shape);
      else this.props.delete(id);
    }
    this.channel?.apply(changes);
  }

  /** The world's prop lighting channel (null until the world is open): what the light tracer reads, with `coverageAt`. */
  get lightChannel(): PropLightChannel | null {
    return this.channel;
  }

  /** What the host holds (diagnostics). */
  stats(): VoxelHostStats {
    const P = threadProfiler;
    P.begin(STATS_SPAN.stream);
    const m = this.streamer?.metrics();
    P.end(STATS_SPAN.stream);
    const pool = this.conn?.pool;
    P.begin(STATS_SPAN.far);
    const far = this.streamer?.far?.metrics();
    P.end(STATS_SPAN.far);
    P.begin(STATS_SPAN.regions);
    const regions = this.regions !== null ? { ...this.regions.stats(), bytes: this.regions.bytes, deriveUs: m?.regionsUs ?? null } : null;
    P.end(STATS_SPAN.regions);
    P.begin(STATS_SPAN.rest);
    const out: VoxelHostStats = {
      world: this.name,
      open: this.streamer !== null,
      resident: m?.resident ?? 0,
      bytes: m?.bytes.total ?? 0,
      overlayBytes: m?.bytes.overlay ?? 0,
      bodies: this.bodies?.count ?? 0,
      ...(this.floors !== null ? { floors: { count: this.floors.count, ...this.floors.counters } } : {}),
      propChannelBytes: this.channel?.stats().bytes ?? 0,
      ...(this.stampRule !== null ? { gridStamps: { rule: this.stampRule, grids: this.grids.length, classBytes: this.channel?.stats().classBytes ?? 0, pending: this.channel?.stats().pending ?? 0, samples: this.gridStampUs.count, sampleMs: { p50: this.gridStampUs.quantile(0.5) / 1000, max: this.gridStampUs.quantile(1) / 1000 } } } : {}),
      ...(pool !== undefined ? { pool: { workers: pool.size, queued: pool.queued, queuedKinds: pool.queuedKinds(), inFlight: pool.inFlight, done: pool.stats.done, queueFull: pool.stats.queueFull, cancelledQueued: pool.stats.cancelledQueued, cancelledSent: pool.stats.cancelledSent, runMs: { p50: pool.stats.runMs.quantile(0.5), p95: pool.stats.runMs.quantile(0.95) }, workerMs: { p50: pool.stats.workerUs.quantile(0.5) / 1000 } } } : {}),
      ...(m !== undefined ? { coverage: m.coverage } : {}),
      ...(this.grids.length > 0 ? { grids: gridStats(this.grids.map((g) => g.stats())) } : {}),
      ...(this.streamer !== null ? { readRing: { setM: this.streamer.readReach.sceneRing.loadRadius * VOXEL_SIZE_M, nowM: this.streamer.ring.loadRadius * VOXEL_SIZE_M, reachM: this.streamer.readReach.cells === null ? null : this.streamer.readReach.cells * VOXEL_SIZE_M } } : {}),
      ...(m !== undefined ? { stream: { reading: m.reading, decoding: m.decoding, deriving: m.deriving, damaged: m.damaged, derivedBytes: m.bytes.derived, counters: m.counters, lod: this.streamer?.mips?.lod.counters ?? null } } : {}),
      ...(regions !== null ? { regions } : {}),
      ...(this.walk !== null ? { walk: { ...this.walk.stats(), pending: this.walk.pending, bytes: this.walk.bytes, searchBytes: this.paths!.queries.bytes, queued: this.paths!.queued, ...this.paths!.queries.served, ...this.paths!.gridStatsPart() } } : {}),
      ...(far !== undefined ? { far: { selected: far.nodes, drawn: far.drawn, pending: far.pending, jobs: far.jobs, selectMs: far.selectMs, meshUs: far.meshUs, queueMs: far.queueMs, readMs: far.readMs, pumpMs: far.pumpMs, commitMs: far.commitMs, firsts: far.firsts, counters: far.counters, gpu: far.gpu, standIns: far.standIns, seen: far.seen, fine: far.fine } } : {}),
    };
    P.end(STATS_SPAN.rest);
    return out;
  }

  /** The streamer (null until the world is open): what the presentation joins draws from. */
  get stream(): VoxelStreamer | null {
    return this.streamer;
  }

  // ---- ctx.voxels ------------------------------------------------------------


  private get(x: number, y: number, z: number): VoxelValue | null {
    const s = this.streamer;
    if (s === null || ![x, y, z].every(Number.isFinite)) return null;
    // A structure's cell that is not air is the answer (the grid a point lies in, voxel-grid-access.ts).
    const at = this.grids.length === 0 ? null : structureAt(this.grids, x, y, z, SCRATCH_CELL);
    if (at === 'unknown') return null;
    if (at !== null) return Object.freeze({ material: SCRATCH_CELL.material, role: SCRATCH_CELL.role, shape: SCRATCH_CELL.shape, wetness: SCRATCH_CELL.wetness });
    const cx = Math.floor(x / VOXEL_SIZE_M);
    const cy = Math.floor(y / VOXEL_SIZE_M);
    const cz = Math.floor(z / VOXEL_SIZE_M);
    const sh = s.grid.shift;
    if (!s.isResident(cx >> sh, cy >> sh, cz >> sh)) return null;
    const v = s.voxelAt(cx, cy, cz, SCRATCH_CELL);
    return Object.freeze({ material: v.material, role: v.role, shape: v.shape, wetness: v.wetness });
  }

  /**
   * How much light a cell blocks, 0 … 1: the construction's coverage from
   * the section's drawn derive result joined with the props' channel
   * (1 − (1 − a)(1 − b)). Null where the chunk is not resident or its
   * section has no result yet.
   */
  private coverageAt(x: number, y: number, z: number): number | null {
    const s = this.streamer;
    if (s === null || this.channel === null || ![x, y, z].every(Number.isFinite)) return null;
    // In a structure's cell that is not air, the structure's own coverage; elsewhere the world's with the lit props
    // (the structures' stamps are not the answer there: the structure's own cell, air, is).
    const at = this.grids.length === 0 ? null : structureAt(this.grids, x, y, z, SCRATCH_CELL);
    if (at === 'unknown') return null;
    if (at !== null) {
      const g = cellCoverage(at.host.streamer, at.cell[0], at.cell[1], at.cell[2], 0);
      return g === null ? null : g / 255;
    }
    const [cx, cy, cz] = [x, y, z].map((m) => Math.floor(m / VOXEL_SIZE_M)) as [number, number, number];
    const v = cellCoverage(s, cx, cy, cz, (this.propsView ?? this.channel).at(cx, cy, cz));
    return v === null ? null : v / 255;
  }

  /** A ray's first hit through the world's occupancy (occupancy-walk.ts), or null (nothing within the distance, or no world). */
  raycast(origin: readonly [number, number, number], direction: readonly [number, number, number], maxDistance: number, options?: VoxelRayOptions): VoxelRayHit | null {
    const src = this.walkSource;
    if (src === null || !(maxDistance >= 0) || !Number.isFinite(maxDistance)) return null;
    const stop = options?.stop ?? 'solid';
    if (!WALK_STOPS.includes(stop)) return null;
    const ray = Array.isArray(origin) && Array.isArray(direction) ? walkRay(origin, direction) : null;
    if (ray === null) return null;
    threadProfiler.begin(RAYCAST_SPAN);
    try {
      // With structure grids, each is walked in its own frame (a light ray reads the world's props without their stamps).
      if (this.grids.length > 0) return raycastWithGrids(stop === 'light' ? (this.lightWalk ?? src) : src, this.grids, ray, maxDistance, stop);
      const hit = walkVoxels(src, ray, maxDistance, { stop }).hit;
      return hit === null ? null : voxelRayHit(ray, hit);
    } finally {
      threadProfiler.end(RAYCAST_SPAN);
    }
  }

  /** The open region of the cell at a world position (open-region-stitch.ts), or null. */
  regionAt(x: number, y: number, z: number): VoxelRegionInfo | null {
    const r = this.regions;
    if (r === null || ![x, y, z].every(Number.isFinite)) return null;
    const s = VOXEL_SIZE_M;
    const cx = Math.floor(x / s);
    const cy = Math.floor(y / s);
    const cz = Math.floor(z / s);
    const info = r.regionAt(cx, cy, cz);
    if (info === null) return null;
    return voxelRegionInfo(info, r.skyAt(cx, cy, cz) ?? true, this.grids.length === 0 ? 0 : structureBoxAt(this.grids, x, y, z));
  }

  /** A region's portals (open-region-stitch.ts), in metres. */
  portalsOf(id: number): readonly VoxelPortalInfo[] {
    const r = this.regions;
    if (r === null || !Number.isInteger(id)) return [];
    return r.portalsOf(id).map((p) => voxelPortalInfo(p, this.portals.propOf(p.min, p.max)));
  }

  /** Asks for a path (voxel-paths.ts): its id, answered when served (`servePaths`). */
  findPath(from: readonly [number, number, number], to: readonly [number, number, number], options?: VoxelWalkOptions): number {
    const id = this.events.nextQuery();
    const a = walkCellAt(from);
    const b = walkCellAt(to);
    const o = walkOptionsOf(options);
    if (a === null || b === null || o === null) this.events.pathAnswered(noPathAnswer(id, this.name, 'unreachable', 'invalid'));
    else if (this.paths === null) this.events.pathAnswered(noPathAnswer(id, this.name, 'unknown'));
    else this.paths.path(id, this.name, a, b, o, (w) => this.events.pathAnswered(w));
    return id;
  }

  /** Asks for the places within a walking distance: its id, answered when served. */
  reach(from: readonly [number, number, number], maxDistance: number, options?: VoxelWalkOptions & { readonly points?: boolean }): number {
    const id = this.events.nextQuery();
    const a = walkCellAt(from);
    const o = walkOptionsOf(options);
    if (a === null || o === null || typeof maxDistance !== 'number' || !(maxDistance >= 0) || !Number.isFinite(maxDistance)) this.events.reachAnswered(noReachAnswer(id, this.name, 'unreachable', 'invalid'));
    else if (this.paths === null) this.events.reachAnswered(noReachAnswer(id, this.name, 'unknown'));
    else this.paths.reach(id, this.name, a, maxDistance, { ...o, cells: options?.points === true }, (w) => this.events.reachAnswered(w));
    return id;
  }

  /** Serves the world's path and reach queries in order within `ms` (the world list's path-finding budget); whether any waited. */
  servePaths(ms: number): boolean {
    const p = this.paths;
    if (p === null || p.queued === 0 || this.disposed) return false;
    p.serve(ms);
    return true;
  }

  /** Path and reach queries waiting (the grids' legs included). */
  get pathsQueued(): number {
    return this.paths?.queued ?? 0;
  }

  /** The world's walk graph (null: no world open): what the benches read beside `findPath`. */
  get walkGraph(): WalkGraph | null {
    return this.walk;
  }

  /** The world's open regions as stitched (null: no world open): what lighting and benches read beside `regionAt`. */
  get openRegions(): OpenRegionStitch | null {
    return this.regions;
  }

  private resident(r: RegionCells): boolean {
    const s = this.streamer;
    if (s === null) return false;
    const sh = s.grid.shift;
    for (let cx = r.minX >> sh; cx <= r.maxX >> sh; cx++) for (let cz = r.minZ >> sh; cz <= r.maxZ >> sh; cz++) for (let cy = r.minY >> sh; cy <= r.maxY >> sh; cy++) {
      if (chunkInWorld(s.grid, cx, cy, cz) && !s.isResident(cx, cy, cz)) return false;
    }
    // The structures' cells a region reaches too (what a change of it reads and writes).
    return this.grids.every((g) => gridResident(g, r));
  }

  private isResident(region: VoxelRegion): boolean {
    const r = regionCells(region);
    return r !== null && this.resident(r);
  }

  private whenResident(region: VoxelRegion): number {
    const id = this.events.nextWait();
    const r = regionCells(region);
    if (r === null || this.disposed) this.events.answered(id, false);
    // Checked at each step's start, so even a region loaded now is answered then.
    else this.waits.push({ cells: r, id });
    return id;
  }

  private refuse(reason: VoxelRefusal, message: string): VoxelRefused {
    return Object.freeze({ ok: false, reason, message });
  }

  private setSavedFields(fields: readonly VoxelField[]): boolean {
    if (!Array.isArray(fields) || !fields.every((f) => (VOXEL_PLANES as readonly unknown[]).includes(f))) return false;
    this.savedFields = planeMask(fields as readonly VoxelPlane[]);
    return true;
  }

  private save(): number {
    const id = this.events.nextSave();
    const s = this.streamer;
    const conn = this.conn;
    const run = this.run;
    const answer = (a: Omit<VoxelSaveAnswer, 'save' | 'world'>): void => {
      if (run === this.run && !this.disposed) this.events.saved(Object.freeze({ save: id, world: this.name, ...a }));
    };
    const failed = (message: string): void => answer({ ok: false, bytes: null, text: null, chunks: 0, message });
    if (s === null || conn === null) {
      // Answered at a later step like every save, so a game handles one way.
      queueMicrotask(() => failed(`voxel world "${this.name}" is not loaded yet`));
      return id;
    }
    // The world grid's changes and each structure grid's, one save (its entries keyed by grid, then chunk).
    Promise.all([s.saveChunks(this.savedFields), ...this.grids.map((g) => g.streamer.saveChunks(this.savedFields))]).then(
      (parts) => {
        const chunks = parts.flat();
        const bytes = writeSave({ worldId: conn.worldId, grid: conn.grid, chunks }, 'none', (b) => b);
        answer({ ok: true, bytes, text: encodeBase64(bytes), chunks: chunks.length });
      },
      (e: unknown) => failed(e instanceof Error ? e.message : String(e)),
    );
    return id;
  }

  /**
   * One change, like an edit: its group holds every loaded chunk the game's changes left or the save's entries reach,
   * in the world grid and each structure grid, swapped together. A save's pieces of a structure grid the world does
   * not hold are reported as mismatches and left out.
   */
  private restore(save: Uint8Array | string, onMismatch: VoxelMismatchChoice): VoxelRestoreResult {
    const s = this.streamer;
    if (s === null) return this.refuse('not_resident', `voxel world "${this.name}" is not loaded yet (whenResident tells when it is)`);
    if (onMismatch !== 'save' && onMismatch !== 'base') return this.refuse('invalid', "onMismatch is 'save' (the player's cells over the new files) or 'base' (the new files)");
    const bytes = typeof save === 'string' ? decodeBase64(save) : save instanceof Uint8Array ? save : null;
    if (bytes === null) return this.refuse('invalid', 'a save is the bytes save() answered, or their text');
    let chunks;
    try {
      chunks = readSave(bytes, s.grid, this.conn!.worldId, () => {
        throw new SaveFileError('a compressed voxel save is not read by the game runtime (saves it makes are not compressed)');
      }).chunks;
    } catch (e) {
      if (e instanceof SaveFileError) return this.refuse('invalid', e.message);
      throw e;
    }
    const change = this.changes.begin(this.nextEdit(), false);
    try {
      this.changes.joined(change, 0, s.restoreSave(chunks, onMismatch));
      for (const g of this.grids) {
        this.changes.joined(change, g.frame.gridId, g.streamer.restoreSave(chunks, onMismatch));
        g.stampDirty = true;
      }
    } finally {
      this.changes.end(change);
    }
    const held = new Set([0, ...this.grids.map((g) => g.frame.gridId)]);
    const m = s.grid.edge * VOXEL_SIZE_M;
    for (const e of chunks) {
      if (held.has(e.grid)) continue;
      this.events.mismatch(Object.freeze({ world: this.name, grid: e.grid, chunk: Object.freeze({ min: Object.freeze([e.cx * m, e.cy * m, e.cz * m] as const), max: Object.freeze([(e.cx + 1) * m, (e.cy + 1) * m, (e.cz + 1) * m] as const) }), kept: false }));
    }
    return Object.freeze({ ok: true, edit: change.edit, chunks: chunks.length });
  }

  /** Applies commands (each in its grid: the world's, or a structure's) as one change (one id, one report once all their groups swapped). */
  private apply(commands: readonly VoxelEditCommand[]): VoxelEditResult {
    const s = this.streamer;
    if (s === null) return this.refuse('not_resident', `voxel world "${this.name}" is not loaded yet`);
    const checked: VoxelEditCommand[] = [];
    try {
      for (const c of commands) checked.push(canonicalEditCommand(c));
    } catch (e) {
      if (e instanceof EditCommandError) return this.refuse('invalid', e.message);
      throw e;
    }
    const change = this.changes.begin(this.nextEdit(), true);
    let cells = 0;
    try {
      for (const cmd of checked) {
        const g = cmd.grid === 0 ? null : (this.grids.find((h) => h.frame.gridId === cmd.grid) ?? null);
        const o = (g?.streamer ?? s).edit(cmd);
        cells += o.cells;
        if (o.cells === 0) continue;
        this.changes.joined(change, cmd.grid, o.group);
        // A path asked before the edit's swap reads its chunks as not current and waits for them.
        (g?.walk ?? this.walk)?.editSent(o.group, walkEditChunks((g?.streamer ?? s).grid, cmd));
        // A structure's cells changed: its stamp into the world's light, sun heights and rooms is read again.
        if (g !== null) g.stampDirty = true;
      }
    } catch (e) {
      // Residency was checked for the whole region first, so a refusal here is a command the format refuses.
      if (e instanceof EditRefused) return this.refuse(e.code === 'chunk_not_loaded' ? 'not_resident' : 'invalid', e.message);
      throw e;
    } finally {
      this.changes.end(change);
    }
    return Object.freeze({ ok: true, edit: change.edit, cells });
  }

  private regionOrRefuse(region: VoxelRegion): RegionCells | VoxelEditResult {
    const r = regionCells(region);
    if (r === null) return this.refuse('invalid', 'a region is { at: [x, y, z] }, { min, max } or { center, radius } in metres, inside the world');
    if (this.streamer === null) return this.refuse('not_resident', `voxel world "${this.name}" is not loaded yet`);
    if (!this.resident(r)) return this.refuse('not_resident', 'the region is not loaded (whenResident tells when it is)');
    return r;
  }

  /** The structure grids' cells of a region that are not air, a command each (`kind` made from a grid's id and cells). */
  private gridCommands(region: VoxelRegion, r: RegionCells, make: (grid: number, cells: number[]) => VoxelEditCommand | readonly VoxelEditCommand[]): VoxelEditCommand[] {
    const out: VoxelEditCommand[] = [];
    for (const g of this.grids) {
      const cells = gridCellsIn(g, region, r, (v) => v.material !== MATERIAL_AIR, SCRATCH_CELL);
      if (cells.length > 0) out.push(...[make(g.frame.gridId, cells)].flat());
    }
    return out;
  }

  /** A set writes the structures' cells that are not air there, and the world's own cells whose centres lie in no structure's solid cell. */
  private set(region: VoxelRegion, voxel: VoxelWrite): VoxelEditResult {
    const r = this.regionOrRefuse(region);
    if ('ok' in r) return r;
    const v = writeRecord(voxel);
    if (v === null) return this.refuse('invalid', 'a voxel is { material, role, shape?, wetness? } with each field in its range');
    if (v.material === MATERIAL_AIR || v.shape === 0) return this.dig(region);
    let cells = regionCellList(r);
    if (this.grids.length > 0) {
      const kept: number[] = [];
      const s = VOXEL_SIZE_M;
      const probe: VoxelRecord = { material: 0, role: 0, shape: 0, wetness: 0 };
      for (let i = 0; i < cells.length; i += 3) if (structureAt(this.grids, (cells[i]! + 0.5) * s, (cells[i + 1]! + 0.5) * s, (cells[i + 2]! + 0.5) * s, probe) === null) kept.push(cells[i]!, cells[i + 1]!, cells[i + 2]!);
      cells = kept;
    }
    const world: VoxelEditCommand[] = cells.length > 0 ? [{ v: 2, grid: 0, kind: 'set', cells, voxel: v }] : [];
    return this.apply([...world, ...this.gridCommands(region, r, (grid, c) => ({ v: 2, grid, kind: 'set', cells: c, voxel: v }))]);
  }

  /** A dig empties the world's own cells and every structure's whose centres lie in the region. */
  private dig(region: VoxelRegion): VoxelEditResult {
    const r = this.regionOrRefuse(region);
    if ('ok' in r) return r;
    return this.apply([{ v: 2, grid: 0, kind: 'dig', cells: regionCellList(r) }, ...this.gridCommands(region, r, (grid, cells) => ({ v: 2, grid, kind: 'dig', cells }))]);
  }

  /**
   * Paint keeps each cell's shape and role, which differ from cell to cell:
   * the cells are written by one exact set a resulting voxel (each in its
   * grid: the world's own cells, every structure's), all applied in this
   * task so they swap together as one change.
   */
  private paint(region: VoxelRegion, paint: VoxelPaint): VoxelEditResult {
    const r = this.regionOrRefuse(region);
    if ('ok' in r) return r;
    if (!validPaint(paint)) return this.refuse('invalid', 'a paint is { material?, wetness? } (at least one; material 1 or more)');
    const v = SCRATCH_CELL;
    const painted = (grid: number, st: VoxelStreamer, list: readonly number[]): VoxelEditCommand[] => {
      const groups = new Map<string, { voxel: VoxelRecord; cells: number[] }>();
      for (let i = 0; i < list.length; i += 3) {
        st.voxelAt(list[i]!, list[i + 1]!, list[i + 2]!, v);
        if (v.material === MATERIAL_AIR) continue;
        const material = paint.material ?? v.material;
        const wetness = heldWetness(v.role, paint.wetness ?? v.wetness);
        if (material === v.material && wetness === v.wetness) continue;
        const key = `${material},${v.role},${v.shape},${wetness}`;
        let g = groups.get(key);
        if (g === undefined) groups.set(key, (g = { voxel: { material, role: v.role, shape: v.shape, wetness }, cells: [] }));
        g.cells.push(list[i]!, list[i + 1]!, list[i + 2]!);
      }
      return [...groups.values()].map((g) => ({ v: 2, grid, kind: 'set', cells: g.cells, voxel: g.voxel }) as const);
    };
    return this.apply([...painted(0, this.streamer!, regionCellList(r)), ...this.gridCommands(region, r, (grid, cells) => painted(grid, this.grids.find((h) => h.frame.gridId === grid)!.streamer, cells))]);
  }
}

/**
 * The chunks whose walk an edit can change: its cells' box and a cell round it (a cell edited changes whether the one
 * over it stands, and the clearance of those under it), as chunks.
 */
function walkEditChunks(grid: ChunkGrid, cmd: VoxelEditCommand): (readonly [number, number, number])[] {
  let b: CellBox;
  try {
    b = editBounds(grid, cmd);
  } catch {
    return [];
  }
  const s = grid.shift;
  const out: (readonly [number, number, number])[] = [];
  for (let cx = (b.minX - 1) >> s; cx <= (b.maxX + 1) >> s; cx++) for (let cy = (b.minY - 1) >> s; cy <= (b.maxY + 1) >> s; cy++) for (let cz = (b.minZ - 1) >> s; cz <= (b.maxZ + 1) >> s; cz++) out.push([cx, cy, cz]);
  return out;
}
