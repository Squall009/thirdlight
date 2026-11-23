/**
 * The voxel worlds of the loaded scenes and `ctx.voxels`.
 *
 * A world streams while a loaded scene has an object with a `voxelWorld`
 * component naming it: one host a world (made when the first such object
 * arrives, disposed when the last one leaves), whose settings are those of
 * the object that brought it. The world's focus is where the active camera
 * looks (its target, else the camera), else the object's own position;
 * bodies are kept around the focus and every character.
 *
 * The page reports the quality level it draws at (with its frame stats);
 * every world's distances and memory budget follow it, without a reload.
 * Until it does, a world streams at its scene's own distances.
 *
 * Path and reach queries are served at a step's start, after streaming, in
 * the order asked across the worlds, within the frame's path-finding budget
 * (the frame budget table's `pathfinding` share of the simulation's frame at
 * the quality level's tier), shared by the steps a frame runs (a host's tick:
 * at a 30 Hz frame two 60 Hz steps, more while catching up): a query not done
 * carries over to the next step, or the next frame once the frame's is spent.
 *
 * Props whose model is marked `affectsLighting` are stamped into every
 * loaded world's lighting occupancy: their shape (collider, else model
 * bounds) where they are, again once they have moved by the stamp's sample
 * spacing, and out again when they leave.
 */
import { deepFreeze, threadProfiler } from '@thirdlight/shared';
import { frameBudgetMs, levelFrameBudget, qualityLevelsOf, resolveVoxelWorld, voxelMaterialInfos, voxelPortalOf, type VoxelPortalComponent, type EntityV3, type QualityLevelConfig, type VoxelMaterialInfo, type VoxelWorldComponent } from '@thirdlight/project-model';
import { PROP_SAMPLES_PER_AXIS, VOXEL_SIZE_M, type PropShape } from '@thirdlight/voxel';
import type { PhysicsPort3D } from './ports';
import type { BehaviorVoxels, BehaviorVoxelWorld, VoxelChange, VoxelMismatch, VoxelPathAnswer, VoxelRayOptions, VoxelReachAnswer, VoxelRefused, VoxelRestoreResult, VoxelRings, VoxelSaveAnswer, VoxelWaitAnswer, VoxelWalkOptions } from './voxel-api';
import { noPathAnswer, noReachAnswer } from './voxel-paths';
import { VoxelWorldHost, type VoxelWorldPorts } from './voxel-world-host';
import type { PortalProp } from './voxel-portals';
import type { WorldTransform } from './world-transform';

/** What the worlds read of the running game each step (world metres). */
export interface VoxelWorldsView {
  /** Where the active camera looks (its target, else itself), or null without a live camera. */
  camera(): readonly number[] | null;
  /** An object's position (undefined: not loaded). */
  positionOf(entityId: string): readonly number[] | undefined;
  /** The characters' objects (the player controllers). */
  characters(): readonly string[];
  /** An object's velocity over the last step (m/s; undefined: not known): bodies get their collision ahead of them. */
  velocityOf?(entityId: string): readonly number[] | undefined;
  /** An object's world transform this step (undefined: not loaded). */
  worldTransform(entityId: string): WorldTransform | undefined;
  /** An object's lighting shape where it is (null: it has neither a collider nor recorded model bounds). */
  propShape(entityId: string, components: Readonly<Record<string, unknown>>, world: WorldTransform): PropShape | null;
  /** A portal's `open` as a script last wrote it (undefined: as authored). */
  portalOpen?(entityId: string): boolean | undefined;
  warn(message: string): void;
}

/** A prop marked `affectsLighting`: its components, and the world transform its stamp was made at. */
interface LitProp {
  readonly components: Readonly<Record<string, unknown>>;
  /** Position, rotation and scale as stamped (null: not yet). */
  pose: number[] | null;
  shape: PropShape | null;
}

interface HeldWorld {
  readonly host: VoxelWorldHost;
  /** The objects naming it, in arrival order (the first one is its focus without a camera). */
  readonly objects: string[];
}

/**
 * How far a stamped prop may have moved before it is stamped again (metres at its farthest point): one sample's
 * spacing of the stamp, so a prop that moves a little every step (a cart, a door) is stamped a few times a second,
 * not every step, and its coverage is never further than one sample from where it is.
 */
const RESTAMP_M = VOXEL_SIZE_M / PROP_SAMPLES_PER_AXIS;

/** How far a pose (position, quaternion, scale) moved any point of a prop within `reach` m of its origin, at most (metres). */
function poseMoved(a: readonly number[], b: readonly number[], reach: number): number {
  const along = Math.hypot(a[0]! - b[0]!, a[1]! - b[1]!, a[2]! - b[2]!);
  const dot = Math.min(1, Math.abs(a[3]! * b[3]! + a[4]! * b[4]! + a[5]! * b[5]! + a[6]! * b[6]!));
  const turn = 2 * Math.acos(dot) * reach;
  const scale = Math.max(Math.abs(a[7]! - b[7]!), Math.abs(a[8]! - b[8]!), Math.abs(a[9]! - b[9]!)) * reach;
  return along + turn + scale;
}

/** The farthest a shape's box reaches from its origin (metres). */
function shapeReach(s: PropShape | null): number {
  if (s === null) return 0;
  let r = 0;
  for (let k = 0; k < 8; k++) r = Math.max(r, Math.hypot(k & 1 ? s.max[0] : s.min[0], k & 2 ? s.max[1] : s.min[1], k & 4 ? s.max[2] : s.min[2]) * s.scale);
  return r;
}

/** Serving the worlds' path and reach queries (walk-graph-queries.ts) within the step's path-finding budget. */
const PATH_SPAN = threadProfiler.span('path finding', 'pathfinding');

const NO_WORLD: VoxelRefused = Object.freeze({ ok: false, reason: 'no_world', message: 'no loaded scene has a voxel world' });
/** What `rings()` reads without a world: nothing streams. */
const NO_RINGS: VoxelRings = Object.freeze({ ring: Object.freeze({ loadRadius: 0, unloadRadius: 0, loadHeight: 0, unloadHeight: 0 }), collision: Object.freeze({ radius: 0, height: 0 }), levels: Object.freeze({ level0: 0, level1: 0, relief: 0 }), quality: null, budgetBytes: null, reliefSteps: 0 });

export class RuntimeVoxels {
  /** Worlds by name, in load order. */
  private readonly worlds = new Map<string, HeldWorld>();
  /** Object → the world it names. */
  private readonly worldOf = new Map<string, string>();
  private pending: VoxelChange[] = [];
  private stepChanges: readonly VoxelChange[] = Object.freeze([]);
  private answers: VoxelWaitAnswer[] = [];
  private stepAnswers: readonly VoxelWaitAnswer[] = Object.freeze([]);
  private saved: VoxelSaveAnswer[] = [];
  private stepSaved: readonly VoxelSaveAnswer[] = Object.freeze([]);
  private mismatched: VoxelMismatch[] = [];
  private stepMismatched: readonly VoxelMismatch[] = Object.freeze([]);
  private pathAnswers: VoxelPathAnswer[] = [];
  private stepPaths: readonly VoxelPathAnswer[] = Object.freeze([]);
  private reachAnswers: VoxelReachAnswer[] = [];
  private stepReaches: readonly VoxelReachAnswer[] = Object.freeze([]);
  private querySeq = 0;
  /** Ms the worlds' queries have taken in this frame (a host's tick): its steps share the frame's budget. */
  private pathFrameMs = 0;
  /** Props marked `affectsLighting`, by object, in arrival order. */
  private readonly props = new Map<string, LitProp>();
  /** Props with a portal (`voxelPortal`), by object: their authored portal and what was last given the worlds. */
  private readonly portals = new Map<string, { readonly authored: VoxelPortalComponent; readonly components: Readonly<Record<string, unknown>>; sent: PortalProp | null; shape: PropShape | null; pose: number[] | null }>();
  private editSeq = 0;
  private waitSeq = 0;
  private saveSeq = 0;
  /** The quality level the page draws at (null: not reported yet). */
  private level: QualityLevelConfig | null = null;
  /** The build's voxel materials by id (frozen: scripts read them, never change them). */
  private readonly materials: ReadonlyMap<number, VoxelMaterialInfo>;
  readonly api: BehaviorVoxels;

  constructor(
    private readonly ports: VoxelWorldPorts | null,
    private readonly physics: PhysicsPort3D | undefined,
    private readonly view: VoxelWorldsView,
  ) {
    const first = (): BehaviorVoxelWorld | null => this.worlds.values().next().value?.host.api ?? null;
    this.materials = new Map([...voxelMaterialInfos(ports?.materials ?? [])].map(([id, m]) => [id, deepFreeze(m)]));
    const voxels = this;
    this.api = Object.freeze({
      worlds: () => Object.freeze([...this.worlds.keys()]),
      world: (name: string) => this.worlds.get(name)?.host.api ?? null,
      get changes() {
        return voxels.stepChanges;
      },
      get waits() {
        return voxels.stepAnswers;
      },
      get saves() {
        return voxels.stepSaved;
      },
      get mismatches() {
        return voxels.stepMismatched;
      },
      get paths() {
        return voxels.stepPaths;
      },
      get reaches() {
        return voxels.stepReaches;
      },
      get: (x: number, y: number, z: number) => first()?.get(x, y, z) ?? null,
      coverageAt: (x: number, y: number, z: number) => first()?.coverageAt(x, y, z) ?? null,
      raycast: (origin: readonly [number, number, number], direction: readonly [number, number, number], maxDistance: number, options?: VoxelRayOptions) => first()?.raycast(origin, direction, maxDistance, options) ?? null,
      regionAt: (x: number, y: number, z: number) => first()?.regionAt(x, y, z) ?? null,
      portalsOf: (id: number) => first()?.portalsOf(id) ?? [],
      findPath: (from: readonly [number, number, number], to: readonly [number, number, number], options?: VoxelWalkOptions) => {
        const w = first();
        if (w !== null) return w.findPath(from, to, options);
        const id = ++this.querySeq;
        this.pathAnswers.push(noPathAnswer(id, '', 'unknown', 'no_world'));
        return id;
      },
      reach: (from: readonly [number, number, number], maxDistance: number, options?: VoxelWalkOptions & { readonly points?: boolean }) => {
        const w = first();
        if (w !== null) return w.reach(from, maxDistance, options);
        const id = ++this.querySeq;
        this.reachAnswers.push(noReachAnswer(id, '', 'unknown', 'no_world'));
        return id;
      },
      materialAt: (x: number, y: number, z: number) => first()?.materialAt(x, y, z) ?? null,
      // Materials are the game's, not a world's: answered with no world loaded too.
      materialOf: (id: number) => this.materials.get(id) ?? null,
      set: (...a: Parameters<BehaviorVoxelWorld['set']>) => first()?.set(...a) ?? NO_WORLD,
      dig: (...a: Parameters<BehaviorVoxelWorld['dig']>) => first()?.dig(...a) ?? NO_WORLD,
      paint: (...a: Parameters<BehaviorVoxelWorld['paint']>) => first()?.paint(...a) ?? NO_WORLD,
      isResident: (...a: Parameters<BehaviorVoxelWorld['isResident']>) => first()?.isResident(...a) ?? false,
      whenResident: (...a: Parameters<BehaviorVoxelWorld['whenResident']>) => {
        const w = first();
        if (w !== null) return w.whenResident(...a);
        const id = ++this.waitSeq;
        this.answers.push(Object.freeze({ wait: id, resident: false }));
        return id;
      },
      setSavedFields: (...a: Parameters<BehaviorVoxelWorld['setSavedFields']>) => first()?.setSavedFields(...a) ?? false,
      save: () => {
        const w = first();
        if (w !== null) return w.save();
        const id = ++this.saveSeq;
        this.saved.push(Object.freeze({ save: id, world: '', ok: false, bytes: null, text: null, chunks: 0, message: NO_WORLD.message }));
        return id;
      },
      restore: (...a: Parameters<BehaviorVoxelWorld['restore']>): VoxelRestoreResult => first()?.restore(...a) ?? NO_WORLD,
      rings: () => first()?.rings() ?? NO_RINGS,
      setRings: (...a: Parameters<BehaviorVoxelWorld['setRings']>) => first()?.setRings(...a) ?? NO_WORLD,
    });
  }

  /** Objects arrived (a scene loaded): those with a `voxelWorld` bring their world, or join it. */
  add(entities: readonly EntityV3[]): void {
    for (const e of entities) {
      const model = (e.components as { model?: { affectsLighting?: boolean } }).model;
      const portal = voxelPortalOf(e.components as unknown as Readonly<Record<string, unknown>>);
      // A prop with a portal is not stamped by its shape: its opening does the stopping, whatever its thickness.
      if (portal !== null && !this.portals.has(e.id)) this.portals.set(e.id, { authored: portal, components: e.components as unknown as Readonly<Record<string, unknown>>, sent: null, shape: null, pose: null });
      else if (model?.affectsLighting === true && !this.props.has(e.id)) this.props.set(e.id, { components: e.components as unknown as Readonly<Record<string, unknown>>, pose: null, shape: null });
      const c = (e.components as { voxelWorld?: VoxelWorldComponent }).voxelWorld;
      if (c === undefined || this.worldOf.has(e.id)) continue;
      this.worldOf.set(e.id, c.world);
      const held = this.worlds.get(c.world);
      if (held !== undefined) {
        held.objects.push(e.id);
        if (JSON.stringify(resolveVoxelWorld(c, this.level)) !== JSON.stringify(resolveVoxelWorld(held.host.component, this.level))) this.view.warn(`voxel world "${c.world}" is already loaded with other settings; "${e.id}" joins it as it is`);
        continue;
      }
      const host = new VoxelWorldHost(c, this.level, this.ports, this.physics, {
        changed: (ch) => this.pending.push(ch),
        answered: (wait, resident) => this.answers.push(Object.freeze({ wait, resident })),
        nextWait: () => ++this.waitSeq,
        saved: (a) => this.saved.push(a),
        nextSave: () => ++this.saveSeq,
        mismatch: (m) => this.mismatched.push(m),
        pathAnswered: (a) => this.pathAnswers.push(a),
        reachAnswered: (a) => this.reachAnswers.push(a),
        nextQuery: () => ++this.querySeq,
        warn: (m) => this.view.warn(m),
      }, () => ++this.editSeq, this.materials);
      this.worlds.set(c.world, { host, objects: [e.id] });
      host.stampProps([...this.props].filter(([, p]) => p.shape !== null).map(([id, p]) => [id, p.shape] as const), [...this.portals].filter(([, p]) => p.sent !== null).map(([id, p]) => [id, p.sent] as const));
    }
  }

  /** Objects left (a scene unloaded): a world no object names any more is disposed. */
  remove(ids: ReadonlySet<string>): void {
    const gone: (readonly [string, null])[] = [];
    for (const id of ids) if (this.props.delete(id)) gone.push([id, null]);
    for (const held of this.worlds.values()) held.host.stampProps(gone);
    const portalsGone: (readonly [string, null])[] = [];
    for (const id of ids) if (this.portals.delete(id)) portalsGone.push([id, null]);
    for (const held of this.worlds.values()) held.host.stampProps([], portalsGone);
    for (const id of ids) {
      const name = this.worldOf.get(id);
      if (name === undefined) continue;
      this.worldOf.delete(id);
      const held = this.worlds.get(name)!;
      held.objects.splice(held.objects.indexOf(id), 1);
      if (held.objects.length > 0) continue;
      held.host.dispose();
      this.worlds.delete(name);
      this.pending = this.pending.filter((c) => c.world !== name);
      this.mismatched = this.mismatched.filter((m) => m.world !== name);
    }
  }

  /**
   * A step's start: every world streams around its focus and answers the
   * waits whose regions are loaded; the changes swapped and the waits
   * answered since the last step become `changes` and `waits`.
   */
  beginStep(): void {
    this.streamAll();
    this.servePaths();
    this.stepChanges = Object.freeze(this.pending);
    this.pending = [];
    this.stepAnswers = Object.freeze(this.answers);
    this.answers = [];
    this.stepSaved = Object.freeze(this.saved);
    this.saved = [];
    this.stepMismatched = Object.freeze(this.mismatched);
    this.mismatched = [];
    this.stepPaths = Object.freeze(this.pathAnswers);
    this.pathAnswers = [];
    this.stepReaches = Object.freeze(this.reachAnswers);
    this.reachAnswers = [];
  }

  /** A host's tick begins: its steps share one frame's path-finding budget. */
  beginFrame(): void {
    this.pathFrameMs = 0;
  }

  /** The worlds' queued path and reach queries, in turn, within what is left of the frame's path-finding budget (a span of its own). */
  private servePaths(): void {
    let any = false;
    for (const held of this.worlds.values()) any ||= held.host.pathsQueued > 0;
    if (!any) return;
    const left = frameBudgetMs(levelFrameBudget(this.level ?? {}), 'sim', 'pathfinding') - this.pathFrameMs;
    if (left <= 0) return;
    threadProfiler.begin(PATH_SPAN);
    const t0 = performance.now();
    try {
      for (const held of this.worlds.values()) held.host.servePaths(left - (performance.now() - t0));
    } finally {
      this.pathFrameMs += performance.now() - t0;
      threadProfiler.end(PATH_SPAN);
    }
  }

  private streamAll(): void {
    if (this.worlds.size === 0) return;
    const v = this.view;
    const characters: (readonly [number, number, number])[] = [];
    const velocities: (readonly [number, number, number])[] = [];
    for (const id of v.characters()) {
      const p = v.positionOf(id);
      if (p === undefined) continue;
      characters.push([p[0]!, p[1]!, p[2]!]);
      const u = v.velocityOf?.(id);
      velocities.push(u === undefined ? [0, 0, 0] : [u[0]!, u[1]!, u[2]!]);
    }
    this.stampProps();
    this.feedPortals();
    const camera = v.camera();
    for (const held of this.worlds.values()) {
      const at = camera ?? v.positionOf(held.objects[0]!) ?? [0, 0, 0];
      held.host.step({ stream: [at[0]!, at[1]!, at[2]!], collide: characters, collideVelocity: velocities });
    }
  }

  /**
   * Each lit prop that moved by a stamp's sample spacing or more since its
   * stamp (or that has none yet) is stamped again into every world, all of
   * a step's together.
   */
  private stampProps(): void {
    if (this.props.size === 0) return;
    const changes: (readonly [string, PropShape | null])[] = [];
    for (const [id, p] of this.props) {
      const w = this.view.worldTransform(id);
      if (w === undefined) continue;
      const pose = [...w.position, ...w.rotation, ...w.scale];
      if (p.pose !== null && poseMoved(pose, p.pose, shapeReach(p.shape)) < RESTAMP_M) continue;
      const first = p.pose === null;
      p.pose = pose;
      p.shape = this.view.propShape(id, p.components, w);
      if (p.shape === null && first) this.view.warn(`"${id}" affects lighting but has neither a collider nor recorded model bounds; it blocks no light`);
      changes.push([id, p.shape]);
    }
    for (const held of this.worlds.values()) held.host.stampProps(changes);
  }

  /**
   * Each portal prop's state (as authored, `open` as a script last wrote it) and its middle, given every world when
   * either changed (a world joins it to the opening it stands in and applies it the same step). The middle is read
   * again only once the prop moved by a stamp's sample spacing.
   */
  private feedPortals(): void {
    if (this.portals.size === 0) return;
    const changes: (readonly [string, PortalProp | null])[] = [];
    for (const [id, p] of this.portals) {
      const w = this.view.worldTransform(id);
      if (w === undefined) continue;
      const pose = [...w.position, ...w.rotation, ...w.scale];
      if (p.pose === null || poseMoved(pose, p.pose, shapeReach(p.shape)) >= RESTAMP_M) {
        p.pose = pose;
        p.shape = this.view.propShape(id, p.components, w);
      }
      // Its middle: its light shape's box (collider, else model bounds), else its position half a cell up (a prop's
      // origin at its bottom middle stands on the opening's sill).
      const sh = p.shape;
      const at: [number, number, number] = sh !== null ? [0, 1, 2].map((a) => p.pose![a]! + (sh.min[a]! + sh.max[a]!) / 2) as [number, number, number] : [p.pose[0]!, p.pose[1]! + VOXEL_SIZE_M / 2, p.pose[2]!];
      const open = this.view.portalOpen?.(id) ?? p.authored.open;
      const next: PortalProp = { open, stops: p.authored.stops, at };
      const was = p.sent;
      if (was !== null && was.open === next.open && was.at.every((v, i) => v === at[i])) continue;
      p.sent = next;
      changes.push([id, next]);
    }
    for (const held of this.worlds.values()) held.host.stampProps([], changes);
  }

  /**
   * The quality level the page draws at, by id (its frame stats name it):
   * a change re-resolves every world's distances and budget, applied
   * without a reload. An id the project's levels lack changes nothing.
   */
  setQuality(id: string): void {
    if (this.level?.id === id) return;
    const level = qualityLevelsOf(this.ports).find((l) => l.id === id);
    if (level === undefined) return;
    this.level = level;
    for (const held of this.worlds.values()) held.host.setQuality(level);
  }

  /** Whether any world is loaded (bodies then wait for its collision: body-suspension.ts). */
  get active(): boolean {
    return this.worlds.size > 0;
  }

  /** Whether every loaded world's collision under a point (world metres; `y`: the body's height, when known) is in place. */
  loadedAt(x: number, z: number, y?: number): boolean {
    for (const held of this.worlds.values()) if (!held.host.collisionReadyAt(x, z, y)) return false;
    return true;
  }

  /**
   * Where a body at (x, y, z) (world metres, its feet) is lifted to this step: onto the fine ground that replaced a
   * world's coarse floor under it and holds it inside (the highest such; null: none).
   */
  riseAt(x: number, y: number, z: number): number | null {
    let top: number | null = null;
    for (const held of this.worlds.values()) {
      const r = held.host.riseAt(x, y, z);
      if (r !== null && (top === null || r > top)) top = r;
    }
    return top;
  }

  /** A new run: every world's changes are dropped. */
  reset(): void {
    for (const held of this.worlds.values()) held.host.reset();
    this.pending = [];
    this.stepChanges = Object.freeze([]);
    this.saved = [];
    this.stepSaved = Object.freeze([]);
    this.mismatched = [];
    this.stepMismatched = Object.freeze([]);
    this.pathAnswers = [];
    this.stepPaths = Object.freeze([]);
    this.reachAnswers = [];
    this.stepReaches = Object.freeze([]);
  }

  /** What the loaded worlds hold (diagnostics). */
  stats(): ReturnType<VoxelWorldHost['stats']>[] {
    return this.hosts().map((h) => h.stats());
  }

  /** The runtime is disposed: every world goes. */
  dispose(): void {
    this.remove(new Set(this.worldOf.keys()));
  }

  /** The loaded worlds' hosts (diagnostics, and the presentation that draws them). */
  hosts(): readonly VoxelWorldHost[] {
    return [...this.worlds.values()].map((h) => h.host);
  }
}
