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
 */
import { COLLIDER_3D_LIMITS } from '@thirdlight/project-model';
import type { ResolvedVoxelWorld } from '@thirdlight/project-model';
import {
  canonicalEditCommand,
  chunkInWorld,
  collisionBodyParts,
  collisionGeometry,
  CollisionRing,
  collisionRingBounds,
  createWorldStore,
  DEFAULT_STREAM_RING,
  EditCommandError,
  EditRefused,
  jobRadius,
  MATERIAL_AIR,
  PLACEHOLDER_RULES,
  VOXEL_SIZE_M,
  VOXEL_STREAM_BUDGET_BYTES,
  VoxelStreamer,
  type ChunkGrid,
  type ChunkSource,
  type CollisionBodies,
  type CollisionSource,
  type Focus,
  type StreamEvent,
  type VoxelEditCommand,
  type VoxelRecord,
  type WorkerPool,
} from '@thirdlight/voxel';
import type { ColliderShape3D, PhysicsPort3D } from './ports';
import { regionCellList, regionCells, validPaint, writeRecord, type BehaviorVoxelWorld, type RegionCells, type VoxelBox, type VoxelChange, type VoxelEditResult, type VoxelPaint, type VoxelRegion, type VoxelValue, type VoxelWrite } from './voxel-api';

/** A world's chunk source and the workers its jobs run on, as the host (Play, an export, a test) provides them. */
export interface VoxelWorldConnection {
  /** The grid the world's files hold (its storage chunks). */
  readonly grid: ChunkGrid;
  readonly source: ChunkSource;
  /** The world's own pool: closed with the world. */
  readonly pool: WorkerPool;
  /** The world's memory budget in bytes (default the low tier's, `VOXEL_STREAM_BUDGET_BYTES.low`). */
  readonly budgetBytes?: number;
  /** Lets go of what the source holds (open files, connections); called once when the world unloads. */
  close?(): void;
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
  private disposed = false;
  private readonly waits: { readonly cells: RegionCells; readonly id: number }[] = [];
  /** Changes by their edit groups, until their swaps. */
  private readonly pending = new Map<number, PendingChange>();
  /** Storage chunks announced since the last swap, and whether only their shader data changed. */
  private shaderOnlyChunks = new Map<string, boolean>();
  /** The change whose commands are being applied (a group may swap before its edit call returns). */
  private applying: PendingChange | null = null;
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
    this.api = Object.freeze({
      name: this.name,
      get: (x: number, y: number, z: number) => this.get(x, y, z),
      set: (region: VoxelRegion, voxel: VoxelWrite) => this.set(region, voxel),
      dig: (region: VoxelRegion) => this.dig(region),
      paint: (region: VoxelRegion, paint: VoxelPaint) => this.paint(region, paint),
      isResident: (region: VoxelRegion) => this.isResident(region),
      whenResident: (region: VoxelRegion) => this.whenResident(region),
    });
    if (ports === null) return;
    ports.open(this.name).then(
      (conn) => this.connect(conn),
      (e: unknown) => {
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
    const cells = (m: number): number => m / VOXEL_SIZE_M;
    const r = s.ring;
    const loadRadius = cells(r.loadRadius);
    const ring = { loadRadius, unloadRadius: cells(r.unloadRadius), loadHeight: cells(r.loadHeight), unloadHeight: cells(r.unloadHeight), nearRadius: Math.min(loadRadius, DEFAULT_STREAM_RING.nearRadius) };
    const streamer = new VoxelStreamer({
      store: createWorldStore(conn.grid),
      source: conn.source,
      pool: conn.pool,
      ring,
      budgetBytes: conn.budgetBytes ?? VOXEL_STREAM_BUDGET_BYTES.low,
      dependencyRadius: jobRadius(PLACEHOLDER_RULES),
      derive: true,
      rules: PLACEHOLDER_RULES,
      sectionEdge: s.sectionEdge,
    });
    this.streamer = streamer;
    const port = this.physics;
    if (port !== undefined && typeof port.addStaticColliders === 'function' && typeof port.removeStaticColliders === 'function') {
      // Bodies never reach past the load ring, which holds the chunks they are made of.
      const radius = Math.min(cells(s.collision.radius), loadRadius);
      const height = Math.min(cells(s.collision.height), ring.loadHeight);
      this.bodies = new PortBodies(port, conn.grid, `voxel:${this.name}:`);
      this.ring = new CollisionRing({ grid: conn.grid, bodies: this.bodies, feed: streamer, bounds: collisionRingBounds({ radius, height }) });
    }
    streamer.on((e) => this.onStream(e));
  }

  private onStream(e: StreamEvent): void {
    if (this.disposed) return;
    if (e.type === 'unloaded') this.ring?.unloaded(e.cx, e.cy, e.cz);
    else if (e.type === 'chunk') {
      // The body follows the chunk's new join in this task, so it swaps with the draw and the shader data.
      if (!e.shaderOnly) this.ring?.changed(e.cx, e.cy, e.cz);
      const id = `${e.cx},${e.cy},${e.cz}`;
      this.shaderOnlyChunks.set(id, (this.shaderOnlyChunks.get(id) ?? true) && e.shaderOnly);
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

  /** A new run: the game's changes are dropped (the world reads as its files again, rebuilt in one swap). */
  reset(): void {
    this.streamer?.clearOverlay();
    this.pending.clear();
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
  }

  /** What the host holds (diagnostics). */
  stats(): { world: string; open: boolean; resident: number; bytes: number; overlayBytes: number; bodies: number } {
    const m = this.streamer?.metrics();
    return { world: this.name, open: this.streamer !== null, resident: m?.resident ?? 0, bytes: m?.bytes.total ?? 0, overlayBytes: m?.bytes.overlay ?? 0, bodies: this.bodies?.count ?? 0 };
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

  private refuse(reason: 'no_world' | 'not_resident' | 'invalid', message: string): VoxelEditResult {
    return Object.freeze({ ok: false, reason, message });
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
