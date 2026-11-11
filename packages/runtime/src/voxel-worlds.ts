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
 * Props whose model is marked `affectsLighting` are stamped into every
 * loaded world's lighting occupancy: their shape (collider, else model
 * bounds) where they are, again whenever their world transform changes
 * between steps, and out again when they leave.
 */
import { deepFreeze } from '@thirdlight/shared';
import { qualityLevelsOf, resolveVoxelWorld, voxelMaterialInfos, type EntityV3, type QualityLevelConfig, type VoxelMaterialInfo, type VoxelWorldComponent } from '@thirdlight/project-model';
import type { PropShape } from '@thirdlight/voxel';
import type { PhysicsPort3D } from './ports';
import type { BehaviorVoxels, BehaviorVoxelWorld, VoxelChange, VoxelMismatch, VoxelRefused, VoxelRestoreResult, VoxelRings, VoxelSaveAnswer, VoxelWaitAnswer } from './voxel-api';
import { VoxelWorldHost, type VoxelWorldPorts } from './voxel-world-host';
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
  /** Props marked `affectsLighting`, by object, in arrival order. */
  private readonly props = new Map<string, LitProp>();
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
      get: (x: number, y: number, z: number) => first()?.get(x, y, z) ?? null,
      coverageAt: (x: number, y: number, z: number) => first()?.coverageAt(x, y, z) ?? null,
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
      if (model?.affectsLighting === true && !this.props.has(e.id)) this.props.set(e.id, { components: e.components as unknown as Readonly<Record<string, unknown>>, pose: null, shape: null });
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
        warn: (m) => this.view.warn(m),
      }, () => ++this.editSeq, this.materials);
      this.worlds.set(c.world, { host, objects: [e.id] });
      host.stampProps([...this.props].filter(([, p]) => p.shape !== null).map(([id, p]) => [id, p.shape] as const));
    }
  }

  /** Objects left (a scene unloaded): a world no object names any more is disposed. */
  remove(ids: ReadonlySet<string>): void {
    const gone: (readonly [string, null])[] = [];
    for (const id of ids) if (this.props.delete(id)) gone.push([id, null]);
    for (const held of this.worlds.values()) held.host.stampProps(gone);
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
    this.stepChanges = Object.freeze(this.pending);
    this.pending = [];
    this.stepAnswers = Object.freeze(this.answers);
    this.answers = [];
    this.stepSaved = Object.freeze(this.saved);
    this.saved = [];
    this.stepMismatched = Object.freeze(this.mismatched);
    this.mismatched = [];
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
    const camera = v.camera();
    for (const held of this.worlds.values()) {
      const at = camera ?? v.positionOf(held.objects[0]!) ?? [0, 0, 0];
      held.host.step({ stream: [at[0]!, at[1]!, at[2]!], collide: characters, collideVelocity: velocities });
    }
  }

  /**
   * Each lit prop whose world transform changed since its stamp (or that
   * has none yet) is stamped again into every world, all of a step's
   * together: the chunks they left and entered are rebuilt there once.
   */
  private stampProps(): void {
    if (this.props.size === 0) return;
    const changes: (readonly [string, PropShape | null])[] = [];
    for (const [id, p] of this.props) {
      const w = this.view.worldTransform(id);
      if (w === undefined) continue;
      const pose = [...w.position, ...w.rotation, ...w.scale];
      if (p.pose !== null && pose.every((n, i) => n === p.pose![i])) continue;
      const first = p.pose === null;
      p.pose = pose;
      p.shape = this.view.propShape(id, p.components, w);
      if (p.shape === null && first) this.view.warn(`"${id}" affects lighting but has neither a collider nor recorded model bounds; it blocks no light`);
      changes.push([id, p.shape]);
    }
    for (const held of this.worlds.values()) held.host.stampProps(changes);
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

  /** Whether every loaded world's collision under a point (world metres) is in place. */
  loadedAt(x: number, z: number): boolean {
    for (const held of this.worlds.values()) if (!held.host.collisionReadyAt(x, z)) return false;
    return true;
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
