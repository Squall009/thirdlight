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
 * a channel a resident chunk (`PropLightChannel`), built when the chunk
 * loads and rebuilt where a prop is placed, moves or goes, counted in the
 * stream budget and never saved; `coverageAt` reads it joined with the
 * construction's own coverage from the drawn derive results.
 *
 * Saves: `save()` writes the overlay's changes as a voxel save file (the
 * fields the game marks saved, a base hash per chunk) once the bases of
 * chunks that left are read again, answered at a later step; `restore()`
 * replaces the overlay with a save's entries (never the base store), laid
 * over loaded chunks at once and over the others as they load.
 */
import { COLLIDER_3D_LIMITS, decodeBase64, encodeBase64 } from '@thirdlight/project-model';
import type { ResolvedVoxelWorld } from '@thirdlight/project-model';
import {
  canonicalEditCommand,
  chunkInWorld,
  chunkKey,
  collisionBodyParts,
  collisionGeometry,
  CollisionRing,
  collisionRingBounds,
  EditCommandError,
  EditRefused,
  lightCoverageAt,
  MATERIAL_AIR,
  planeMask,
  PropLightChannel,
  readSave,
  SaveFileError,
  VOXEL_PLANES,
  VOXEL_SIZE_M,
  VoxelStreamer,
  worldStreamer,
  writeSave,
  type ChunkGrid,
  type ChunkSource,
  type CollisionBodies,
  type CollisionSource,
  type Focus,
  type PropShape,
  type StreamEvent,
  type VoxelEditCommand,
  type VoxelPlane,
  type VoxelRecord,
  type WorkerPool,
} from '@thirdlight/voxel';
import type { ColliderShape3D, PhysicsPort3D } from './ports';
import {
  regionCellList,
  regionCells,
  validPaint,
  writeRecord,
  type BehaviorVoxelWorld,
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
  type VoxelSaveAnswer,
  type VoxelValue,
  type VoxelWrite,
} from './voxel-api';

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
  /** Lets go of what the source holds (open files, connections); called once when the world unloads. */
  close?(): void;
  /**
   * The world's streamer once it is made (before it streams anything), for
   * what draws the world: it listens to the streamer's events and joins the
   * chunks it announces. `sectionEdge`: the world's derive section edge.
   */
  present?(stream: VoxelStreamer, sectionEdge: number): void;
}

/** How the runtime reaches a project's voxel worlds (absent: a game's voxel worlds stream nothing and read null). */
export interface VoxelWorldPorts {
  /** Opens a world by its name (`voxels/<world>/`); a rejection leaves the world unloaded (logged). */
  open(world: string): Promise<VoxelWorldConnection>;
}

/** The step's view of where the world is looked at and what collides in it (world metres). */
export interface VoxelFoci {
  /** Where the world streams around. */
  readonly stream: readonly [number, number, number];
  /** Where bodies are kept around (the stream focus and the characters). */
  readonly collide: readonly (readonly [number, number, number])[];
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

/** A change waiting for its swap. */
interface PendingChange {
  readonly edit: number;
  /** Edit groups of it not swapped yet, and those swapped. */
  readonly groups: Set<number>;
  readonly swapped: Set<number>;
  readonly chunks: Map<string, VoxelBox>;
  shaderOnly: boolean;
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
  /** Why a world could not load or a step's work failed. */
  warn(message: string): void;
}

export class VoxelWorldHost {
  readonly name: string;
  readonly settings: ResolvedVoxelWorld;
  private conn: VoxelWorldConnection | null = null;
  private streamer: VoxelStreamer | null = null;
  private ring: CollisionRing | null = null;
  private bodies: PortBodies | null = null;
  /** The props' lighting occupancy over the resident chunks (null until the world is open). */
  private channel: PropLightChannel | null = null;
  /** The props stamped into the world, by object: kept while the world opens, placed into the channel when it is. */
  private readonly props = new Map<string, PropShape>();
  private disposed = false;
  private readonly waits: { readonly cells: RegionCells; readonly id: number }[] = [];
  /** Changes by their edit groups, until their swaps. */
  private readonly pending = new Map<number, PendingChange>();
  /** Storage chunks announced since the last swap, and whether only their shader data changed. */
  private shaderOnlyChunks = new Map<string, boolean>();
  /** The change whose commands are being applied (a group may swap before its edit call returns). */
  private applying: PendingChange | null = null;
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
    settings: ResolvedVoxelWorld,
    ports: VoxelWorldPorts | null,
    private readonly physics: PhysicsPort3D | undefined,
    private readonly events: VoxelHostEvents,
    private readonly nextEdit: () => number,
  ) {
    this.name = settings.world;
    this.settings = settings;
    this.savedFields = settings.savedFields;
    this.api = Object.freeze({
      name: this.name,
      get: (x: number, y: number, z: number) => this.get(x, y, z),
      coverageAt: (x: number, y: number, z: number) => this.coverageAt(x, y, z),
      set: (region: VoxelRegion, voxel: VoxelWrite) => this.set(region, voxel),
      dig: (region: VoxelRegion) => this.dig(region),
      paint: (region: VoxelRegion, paint: VoxelPaint) => this.paint(region, paint),
      isResident: (region: VoxelRegion) => this.isResident(region),
      whenResident: (region: VoxelRegion) => this.whenResident(region),
      setSavedFields: (fields: readonly VoxelField[]) => this.setSavedFields(fields),
      save: () => this.save(),
      restore: (save: Uint8Array | string, onMismatch: VoxelMismatchChoice) => this.restore(save, onMismatch),
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
    const cells = (m: number): number => m / VOXEL_SIZE_M;
    const ring = streamer.ring;
    const loadRadius = ring.loadRadius;
    this.streamer = streamer;
    const port = this.physics;
    if (port !== undefined && typeof port.addStaticColliders === 'function' && typeof port.removeStaticColliders === 'function') {
      // Bodies never reach past the load ring, which holds the chunks they are made of.
      const radius = Math.min(cells(s.collision.radius), loadRadius);
      const height = Math.min(cells(s.collision.height), ring.loadHeight);
      this.bodies = new PortBodies(port, conn.grid, `voxel:${this.name}:`);
      this.ring = new CollisionRing({ grid: conn.grid, bodies: this.bodies, feed: streamer, bounds: collisionRingBounds({ radius, height }) });
    }
    const channel = new PropLightChannel(streamer, VOXEL_SIZE_M);
    channel.apply(this.props);
    this.channel = channel;
    streamer.on((e) => this.onStream(e));
    conn.present?.(streamer, s.sectionEdge);
  }

  private onStream(e: StreamEvent): void {
    if (this.disposed) return;
    if (e.type === 'loaded') this.channel?.loaded(e.cx, e.cy, e.cz);
    else if (e.type === 'unloaded') {
      this.channel?.unloaded(e.cx, e.cy, e.cz);
      this.derived.delete(chunkKey(this.conn!.grid, e.cx, e.cy, e.cz));
      this.ring?.unloaded(e.cx, e.cy, e.cz);
    } else if (e.type === 'chunk') {
      this.derived.add(chunkKey(this.conn!.grid, e.cx, e.cy, e.cz));
      // The body follows the chunk's new join in this task, so it swaps with the draw and the shader data.
      if (!e.shaderOnly) this.ring?.changed(e.cx, e.cy, e.cz);
      const id = `${e.cx},${e.cy},${e.cz}`;
      this.shaderOnlyChunks.set(id, (this.shaderOnlyChunks.get(id) ?? true) && e.shaderOnly);
    } else if (e.type === 'mismatch') {
      this.events.mismatch(Object.freeze({ world: this.name, chunk: this.chunkBox(e.cx, e.cy, e.cz), kept: e.applied }));
    } else if (e.type === 'swap') {
      const only = this.shaderOnlyChunks;
      this.shaderOnlyChunks = new Map();
      const done = new Set<PendingChange>();
      for (const g of e.report.groups) {
        // A group that swaps inside the edit call that made it belongs to the change being applied.
        const p = this.pending.get(g) ?? this.applying;
        if (p === null) continue;
        this.pending.delete(g);
        p.groups.delete(g);
        p.swapped.add(g);
        for (const [cx, cy, cz] of e.report.chunks) {
          const id = `${cx},${cy},${cz}`;
          p.chunks.set(id, this.chunkBox(cx, cy, cz));
          p.shaderOnly &&= only.get(id) ?? false;
        }
        if (p.groups.size === 0 && p !== this.applying) done.add(p);
      }
      for (const p of done) this.report(p);
    }
  }

  private report(p: PendingChange): void {
    this.events.changed(Object.freeze({ world: this.name, edit: p.edit, chunks: Object.freeze([...p.chunks.values()]), shaderOnly: p.shaderOnly }));
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
    s.update();
    if (this.ring !== null) {
      this.ring.setFoci([f, ...foci.collide.map(toCells)]);
      this.ring.update();
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

  /**
   * Whether the world's collision under a point (world metres) is in place:
   * the world is open and every chunk of the column within the collision
   * ring has its body from its derived ground. Without a physics port
   * nothing collides here, so nothing waits for it.
   */
  collisionReadyAt(x: number, z: number): boolean {
    if (this.disposed) return true;
    if (this.streamer === null) return !this.opening || this.physics === undefined;
    const ring = this.ring;
    if (ring === null) return true;
    const grid = this.conn!.grid;
    const sh = grid.shift;
    return ring.columnSettled(Math.floor(x / VOXEL_SIZE_M) >> sh, Math.floor(z / VOXEL_SIZE_M) >> sh, (cx, cy, cz) => this.derived.has(chunkKey(grid, cx, cy, cz)));
  }

  /** A new run: the game's changes are dropped (the world reads as its files again, rebuilt in one swap). */
  reset(): void {
    this.streamer?.clearOverlay();
    this.pending.clear();
    this.savedFields = this.settings.savedFields;
    this.run++;
  }

  /** The scene that named the world unloaded: bodies out of physics, workers stopped, waits answered false. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.bodies?.clear();
    this.conn?.pool.close();
    this.conn?.close?.();
    for (const w of this.waits.splice(0)) this.events.answered(w.id, false);
    this.pending.clear();
    this.streamer = null;
    this.ring = null;
    this.channel = null;
    this.derived.clear();
  }

  /**
   * Props marked `affectsLighting` placed or moved (their shapes where they
   * now are) or gone (null), together: each chunk any of them left or
   * entered is rebuilt once.
   */
  stampProps(changes: readonly (readonly [string, PropShape | null])[]): void {
    if (this.disposed || changes.length === 0) return;
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
  stats(): { world: string; open: boolean; resident: number; bytes: number; overlayBytes: number; bodies: number; propChannelBytes: number } {
    const m = this.streamer?.metrics();
    return { world: this.name, open: this.streamer !== null, resident: m?.resident ?? 0, bytes: m?.bytes.total ?? 0, overlayBytes: m?.bytes.overlay ?? 0, bodies: this.bodies?.count ?? 0, propChannelBytes: this.channel?.stats().bytes ?? 0 };
  }

  /** The streamer (null until the world is open): what the presentation joins draws from. */
  get stream(): VoxelStreamer | null {
    return this.streamer;
  }

  // ---- ctx.voxels ------------------------------------------------------------

  private readonly cell: VoxelRecord = { material: 0, role: 0, shape: 0, wetness: 0 };

  private get(x: number, y: number, z: number): VoxelValue | null {
    const s = this.streamer;
    if (s === null || ![x, y, z].every(Number.isFinite)) return null;
    const cx = Math.floor(x / VOXEL_SIZE_M);
    const cy = Math.floor(y / VOXEL_SIZE_M);
    const cz = Math.floor(z / VOXEL_SIZE_M);
    const sh = s.grid.shift;
    if (!s.isResident(cx >> sh, cy >> sh, cz >> sh)) return null;
    const v = s.voxelAt(cx, cy, cz, this.cell);
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
    const cx = Math.floor(x / VOXEL_SIZE_M);
    const cy = Math.floor(y / VOXEL_SIZE_M);
    const cz = Math.floor(z / VOXEL_SIZE_M);
    const sh = s.grid.shift;
    if (!s.isResident(cx >> sh, cy >> sh, cz >> sh)) return null;
    const sec = s.sections;
    const d = s.derivedOf(cx >> sec.shift, cy >> sec.shift, cz >> sec.shift, true);
    if (d === null) return null;
    const prop = this.channel.at(cx, cy, cz);
    const light = d.assembly?.light;
    const m = sec.mask;
    // A result without an assembly is air all around: only the props block light there.
    const v = light === undefined ? prop : lightCoverageAt(light, ((((cx & m) << sec.shift) | (cz & m)) << sec.shift) | (cy & m), prop);
    return v / 255;
  }

  private resident(r: RegionCells): boolean {
    const s = this.streamer;
    if (s === null) return false;
    const sh = s.grid.shift;
    for (let cx = r.minX >> sh; cx <= r.maxX >> sh; cx++) for (let cz = r.minZ >> sh; cz <= r.maxZ >> sh; cz++) for (let cy = r.minY >> sh; cy <= r.maxY >> sh; cy++) {
      if (chunkInWorld(s.grid, cx, cy, cz) && !s.isResident(cx, cy, cz)) return false;
    }
    return true;
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
    s.saveChunks(this.savedFields).then(
      (chunks) => {
        const bytes = writeSave({ worldId: conn.worldId, grid: conn.grid, chunks }, 'none', (b) => b);
        answer({ ok: true, bytes, text: encodeBase64(bytes), chunks: chunks.length });
      },
      (e: unknown) => failed(e instanceof Error ? e.message : String(e)),
    );
    return id;
  }

  /**
   * One change, like an edit: its group holds every loaded chunk the
   * game's changes left or the save's entries reach, swapped together.
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
    const edit = this.nextEdit();
    const change: PendingChange = { edit, groups: new Set(), swapped: new Set(), chunks: new Map(), shaderOnly: false };
    this.applying = change;
    let group = 0;
    try {
      group = s.restoreSave(chunks, onMismatch);
    } finally {
      this.applying = null;
    }
    if (group !== 0 && !change.swapped.has(group)) {
      change.groups.add(group);
      this.pending.set(group, change);
    }
    if (change.groups.size === 0 && change.swapped.size > 0) this.report(change);
    return Object.freeze({ ok: true, edit, chunks: chunks.length });
  }

  /** Applies commands as one change (one id, one report once all their groups swapped). */
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
    const edit = this.nextEdit();
    const change: PendingChange = { edit, groups: new Set(), swapped: new Set(), chunks: new Map(), shaderOnly: true };
    let cells = 0;
    this.applying = change;
    try {
      for (const cmd of checked) {
        const o = s.edit(cmd);
        cells += o.cells;
        if (o.cells > 0 && !change.swapped.has(o.group)) {
          change.groups.add(o.group);
          this.pending.set(o.group, change);
        }
      }
    } catch (e) {
      // Residency was checked for the whole region first, so a refusal here is a command the format refuses.
      if (e instanceof EditRefused) return this.refuse(e.code === 'chunk_not_loaded' ? 'not_resident' : 'invalid', e.message);
      throw e;
    } finally {
      this.applying = null;
    }
    if (change.groups.size === 0 && change.swapped.size > 0) this.report(change);
    return Object.freeze({ ok: true, edit, cells });
  }

  private regionOrRefuse(region: VoxelRegion): RegionCells | VoxelEditResult {
    const r = regionCells(region);
    if (r === null) return this.refuse('invalid', 'a region is { at: [x, y, z] }, { min, max } or { center, radius } in metres, inside the world');
    if (this.streamer === null) return this.refuse('not_resident', `voxel world "${this.name}" is not loaded yet`);
    if (!this.resident(r)) return this.refuse('not_resident', 'the region is not loaded (whenResident tells when it is)');
    return r;
  }

  private set(region: VoxelRegion, voxel: VoxelWrite): VoxelEditResult {
    const r = this.regionOrRefuse(region);
    if ('ok' in r) return r;
    const v = writeRecord(voxel);
    if (v === null) return this.refuse('invalid', 'a voxel is { material, role, shape?, wetness? } with each field in its range');
    if (v.material === MATERIAL_AIR || v.shape === 0) return this.dig(region);
    return this.apply([{ v: 2, grid: 0, kind: 'set', cells: regionCellList(r), voxel: v }]);
  }

  private dig(region: VoxelRegion): VoxelEditResult {
    const r = this.regionOrRefuse(region);
    if ('ok' in r) return r;
    return this.apply([{ v: 2, grid: 0, kind: 'dig', cells: regionCellList(r) }]);
  }

  /**
   * Paint keeps each cell's shape and role, which differ from cell to cell:
   * the cells are written by one exact set a resulting voxel, all applied in
   * this task so they swap together as one change.
   */
  private paint(region: VoxelRegion, paint: VoxelPaint): VoxelEditResult {
    const r = this.regionOrRefuse(region);
    if ('ok' in r) return r;
    if (!validPaint(paint)) return this.refuse('invalid', 'a paint is { material?, wetness? } (at least one; material 1 or more)');
    const s = this.streamer!;
    const groups = new Map<string, { voxel: VoxelRecord; cells: number[] }>();
    const list = regionCellList(r);
    const v = this.cell;
    for (let i = 0; i < list.length; i += 3) {
      s.voxelAt(list[i]!, list[i + 1]!, list[i + 2]!, v);
      if (v.material === MATERIAL_AIR) continue;
      const material = paint.material ?? v.material;
      const wetness = paint.wetness ?? v.wetness;
      if (material === v.material && wetness === v.wetness) continue;
      const key = `${material},${v.role},${v.shape},${wetness}`;
      let g = groups.get(key);
      if (g === undefined) groups.set(key, (g = { voxel: { material, role: v.role, shape: v.shape, wetness }, cells: [] }));
      g.cells.push(list[i]!, list[i + 1]!, list[i + 2]!);
    }
    return this.apply([...groups.values()].map((g) => ({ v: 2, grid: 0, kind: 'set', cells: g.cells, voxel: g.voxel }) as const));
  }
}
