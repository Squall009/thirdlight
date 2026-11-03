/**
 * The voxel worlds of the loaded scenes and `ctx.voxels`.
 *
 * A world streams while a loaded scene has an object with a `voxelWorld`
 * component naming it: one host a world (made when the first such object
 * arrives, disposed when the last one leaves), whose settings are those of
 * the object that brought it. The world's focus is where the active camera
 * looks (its target, else the camera), else the object's own position;
 * bodies are kept around the focus and every character.
 */
import { resolveVoxelWorld, type EntityV3, type VoxelWorldComponent } from '@thirdlight/project-model';
import type { PhysicsPort3D } from './ports';
import type { BehaviorVoxels, BehaviorVoxelWorld, VoxelChange, VoxelEditResult, VoxelWaitAnswer } from './voxel-api';
import { VoxelWorldHost, type VoxelWorldPorts } from './voxel-world-host';

/** What the worlds read of the running game each step (world metres). */
export interface VoxelWorldsView {
  /** Where the active camera looks (its target, else itself), or null without a live camera. */
  camera(): readonly number[] | null;
  /** An object's position (undefined: not loaded). */
  positionOf(entityId: string): readonly number[] | undefined;
  /** The characters' objects (the player controllers). */
  characters(): readonly string[];
  warn(message: string): void;
}

interface HeldWorld {
  readonly host: VoxelWorldHost;
  /** The objects naming it, in arrival order (the first one is its focus without a camera). */
  readonly objects: string[];
}

const NO_WORLD: VoxelEditResult = Object.freeze({ ok: false, reason: 'no_world', message: 'no loaded scene has a voxel world' });

export class RuntimeVoxels {
  /** Worlds by name, in load order. */
  private readonly worlds = new Map<string, HeldWorld>();
  /** Object → the world it names. */
  private readonly worldOf = new Map<string, string>();
  private pending: VoxelChange[] = [];
  private stepChanges: readonly VoxelChange[] = Object.freeze([]);
  private answers: VoxelWaitAnswer[] = [];
  private stepAnswers: readonly VoxelWaitAnswer[] = Object.freeze([]);
  private editSeq = 0;
  private waitSeq = 0;
  readonly api: BehaviorVoxels;

  constructor(
    private readonly ports: VoxelWorldPorts | null,
    private readonly physics: PhysicsPort3D | undefined,
    private readonly view: VoxelWorldsView,
  ) {
    const first = (): BehaviorVoxelWorld | null => this.worlds.values().next().value?.host.api ?? null;
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
      get: (x: number, y: number, z: number) => first()?.get(x, y, z) ?? null,
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
    });
  }

  /** Objects arrived (a scene loaded): those with a `voxelWorld` bring their world, or join it. */
  add(entities: readonly EntityV3[]): void {
    for (const e of entities) {
      const c = (e.components as { voxelWorld?: VoxelWorldComponent }).voxelWorld;
      if (c === undefined || this.worldOf.has(e.id)) continue;
      this.worldOf.set(e.id, c.world);
      const held = this.worlds.get(c.world);
      if (held !== undefined) {
        held.objects.push(e.id);
        if (JSON.stringify(resolveVoxelWorld(c)) !== JSON.stringify(held.host.settings)) this.view.warn(`voxel world "${c.world}" is already loaded with other settings; "${e.id}" joins it as it is`);
        continue;
      }
      const host = new VoxelWorldHost(resolveVoxelWorld(c), this.ports, this.physics, {
        changed: (ch) => this.pending.push(ch),
        answered: (wait, resident) => this.answers.push(Object.freeze({ wait, resident })),
        nextWait: () => ++this.waitSeq,
        warn: (m) => this.view.warn(m),
      }, () => ++this.editSeq);
      this.worlds.set(c.world, { host, objects: [e.id] });
    }
  }

  /** Objects left (a scene unloaded): a world no object names any more is disposed. */
  remove(ids: ReadonlySet<string>): void {
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
  }

  private streamAll(): void {
    if (this.worlds.size === 0) return;
    const v = this.view;
    const characters: (readonly [number, number, number])[] = [];
    for (const id of v.characters()) {
      const p = v.positionOf(id);
      if (p !== undefined) characters.push([p[0]!, p[1]!, p[2]!]);
    }
    const camera = v.camera();
    for (const held of this.worlds.values()) {
      const at = camera ?? v.positionOf(held.objects[0]!) ?? [0, 0, 0];
      held.host.step({ stream: [at[0]!, at[1]!, at[2]!], collide: characters });
    }
  }

  /** A new run: every world's changes are dropped. */
  reset(): void {
    for (const held of this.worlds.values()) held.host.reset();
    this.pending = [];
    this.stepChanges = Object.freeze([]);
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
