/**
 * The voxel worlds the Scene view draws: every world a `voxelWorld` object
 * in the open scenes names, streamed around the point the view orbits and
 * drawn in the adapter's scene by the chunk views Play draws with
 * (`VoxelWorldDraws`). The worlds stream in a worker
 * (scene-voxels-worker.ts), which reads the region files by range from the
 * backend and derives in workers of its own, so this page only replaces
 * chunk draws, a batch at a time, and draws a frame after each.
 *
 * As in a game, a world's first object gives its settings (ring, sections)
 * and its cell 0 lies at the world origin; nothing collides in the editor.
 * An edit applied by the command route (the editor's, MCP's) arrives as the
 * feed's `voxelsChanged` and is handed to the worker, which reads the
 * chunks it names again; the view shows it without a reload.
 *
 * Detail pieces are the project's voxel kits, read when the first world
 * opens (through the command route; their GLBs from the backend); a
 * material no kit binds draws plain voxel faces. The worker derives with the
 * piece table of those kits, the draws use the same. A kit set or deleted,
 * or a settings change (the piece seed), by any client, reads them again:
 * the worker sets the new table, which derives again only the chunks whose
 * pieces it changes, and the draws take the new kits when that swap
 * arrives, so a chunk is never drawn with the other table's pieces. Meshes
 * stay loaded across kit changes (a mesh already read is not read again).
 *
 * The worlds' material tables are built from the project's material
 * records as the Scene view holds them (`setMaterials`, on every material
 * change by any client): a record's colour, tile or depth changed rewrites
 * the tables only, with no chunk derived or meshed again.
 *
 * Their texture arrays stream from their whole file into the GPU through
 * the view's texture streamer (`textureStreamer`, which the view's adapter
 * updates each frame), capped at the view's quality level's texel density
 * within the engine's default texture budget, as Play keeps them.
 *
 * Relief is the view's quality level's, as in Play: its lattice steps and
 * the world's relief distance scaled by it (the other distances stay the
 * scene's own); a level change re-plans each world's relief ring without
 * reopening it, and the draws displace round the point the view orbits.
 */
import { resolveVoxelWorld, type VoxelWorldComponent } from '@thirdlight/project-model/voxel-world';
import { VOXEL_SIZE_M, worldReliefRing, type ReliefRingSettings } from '@thirdlight/voxel';
import type { VoxelsChangedPayload } from '@thirdlight/protocol';
import { createTextureStreamer, decodeTexture, VoxelKitMeshes, VoxelWorldDraws, wholeKtx2Source, type SceneAdapter, type TextureStreamer, type VoxelGridRenderer, type VoxelKitSet, type VoxelLookRecord } from '@thirdlight/three-adapter';
import { textureBudgetBytesOf } from '@thirdlight/project-model/limits';
import { pageKitPieces, readVoxelKits, type KitRoute, type ProjectVoxelKits } from '../voxel-world/kit-pieces';
import type * as THREE from 'three';
import { textureSlotSetKey, type TextureSlotSet } from '@thirdlight/project-model/texture-slots';
import type { ProjectedEntity } from '../session/projection';
import type { SceneVoxelsIn, SceneVoxelsOut } from '../voxel-world/scene-voxels-wire';

/** Where the editor reads a project's voxel worlds: the backend's route of a world and the headers it needs. */
export interface SceneVoxelsSource {
  url(world: string): string;
  readonly headers: Readonly<Record<string, string>>;
  /** Where the project's voxel kits and their models are read (absent: no kits, no pieces). */
  readonly kits?: KitRoute;
}

export interface SceneVoxelsHost {
  readonly adapter: () => SceneAdapter;
  readonly requestRender: () => void;
  readonly source: SceneVoxelsSource | null;
  /** The bytes of the voxel surfaces' texture array of a slot list (the backend assembles it); absent: flat colours. */
  readonly arrayBytes?: (set: TextureSlotSet) => Promise<Uint8Array>;
}

type WorldState = Extract<SceneVoxelsOut, { t: 'state' }>;

/** What of a kit read the pieces depend on (the material records read with it reach the draws through `setMaterials`). */
const kitsKeyOf = (k: ProjectVoxelKits): string => JSON.stringify([k.kits, k.seed]);

/** The worker streaming the worlds and the voxel worker it starts, next to the editor page. */
const WORKER_SCRIPT = 'voxel-view-worker.js';
const DERIVE_SCRIPT = 'voxel-worker.js';

export class SceneVoxels {
  private worker: Worker | null = null;
  private draws: VoxelWorldDraws;
  /** The worlds opened, by name: the settings they were opened with. */
  private readonly open = new Map<string, string>();
  private readonly states = new Map<string, WorldState>();
  private readonly problems = new Map<string, string>();
  /** The focus last sent (cells' worth of metres apart before another is sent). */
  private focusSent: [number, number, number] | null = null;
  private stampMark = '';
  /** The project's kits once read (null until the first world opens), and their meshes. */
  private kits: Promise<ProjectVoxelKits> | null = null;
  private kitMeshes: VoxelKitMeshes | null = null;
  /** The kits drawn now (as read; null: none yet): a re-read finding the same changes nothing. */
  private kitsKey: string | null = null;
  /** The worlds the worker was told to open (kit changes go to these). */
  private readonly posted = new Set<string>();
  /**
   * New kits waiting for the worlds to swap in what they change (by world:
   * the swap group, −1 until the worker names it); drawn once none waits.
   */
  private pending: { set: VoxelKitSet | null; groups: Map<string, number> } | null = null;
  /** Each open world's object (its relief follows the view's quality level), and the level its relief was planned at. */
  private readonly components = new Map<string, VoxelWorldComponent>();
  private reliefLevel: string | null = null;
  /** The material records the tables are built from (kept for draws made again with a new renderer). */
  private materials: readonly VoxelLookRecord[] = [];

  /** The view's texture streamer: the voxel arrays are its only streamed textures (the view's asset textures load whole). */
  readonly textureStreamer: TextureStreamer;

  constructor(private readonly host: SceneVoxelsHost) {
    this.textureStreamer = createTextureStreamer({ budgetBytes: textureBudgetBytesOf(undefined), onChange: () => host.requestRender() });
    this.draws = this.makeDraws();
  }

  /** Reads the project's kits once and gives the draws their pieces; resolves to the kits the worker derives with. */
  private projectKits(): Promise<ProjectVoxelKits> {
    if (this.kits !== null) return this.kits;
    const route = this.host.source?.kits;
    const none: ProjectVoxelKits = { kits: [], seed: 0 };
    const read = (route === undefined ? Promise.resolve(none) : readVoxelKits(route)).catch((e: unknown) => {
      for (const name of this.open.keys()) this.problems.set(name, `voxel kits: ${e instanceof Error ? e.message : String(e)}`);
      return none;
    });
    this.kits = read;
    void read.then((kits) => {
      // The renderer was replaced, the view disposed or the kits read again meanwhile: those draws are gone, make nothing.
      if (this.kits !== read) return;
      this.kitsKey = kitsKeyOf(kits);
      this.draws.setKits(this.kitSet(kits));
    });
    return this.kits;
  }

  /** The kits the worker derives a world with now (read again until no newer read started meanwhile). */
  private async currentKits(): Promise<ProjectVoxelKits> {
    for (;;) {
      const p = this.projectKits();
      const kits = await p;
      if (p === this.kits) return kits;
    }
  }

  /** What the draws draw `kits` with: their meshes loading into the view's own (kept across kit changes). */
  private kitSet(kits: ProjectVoxelKits): VoxelKitSet | null {
    const route = this.host.source?.kits;
    this.kitMeshes ??= new VoxelKitMeshes();
    if (route === undefined) return this.kitMeshes.world(kits.kits, kits.seed);
    const p = pageKitPieces(route, kits, this.kitMeshes);
    void p.loaded.then((why) => {
      if (why === '') return;
      for (const name of this.open.keys()) this.problems.set(name, why);
      this.host.requestRender();
    });
    return p.set;
  }

  /**
   * The project's voxel kits or settings changed (setVoxelKit,
   * deleteVoxelKit, setSettings): read them again and, if they differ from
   * those drawn, hand every open world the new table; the draws take the
   * new kits once each world's swap of what they change has arrived.
   */
  kitsChanged(): void {
    const route = this.host.source?.kits;
    // Not read yet: the first world to open reads the kits as they are then.
    if (this.kits === null || route === undefined) return;
    const before = this.kits;
    const read = readVoxelKits(route).catch((e: unknown) => {
      for (const name of this.open.keys()) this.problems.set(name, `voxel kits: ${e instanceof Error ? e.message : String(e)}`);
      this.host.requestRender();
      return before;
    });
    this.kits = read;
    void read.then((kits) => {
      if (this.kits !== read) return;
      const key = kitsKeyOf(kits);
      if (key === this.kitsKey) return;
      this.kitsKey = key;
      const groups = new Map<string, number>();
      this.pending = { set: this.kitSet(kits), groups };
      for (const name of this.posted) {
        groups.set(name, -1);
        this.post({ t: 'kits', world: name, kits: kits.kits, pieceSeed: kits.seed });
      }
      this.drawPending();
    });
  }

  /** A world no longer waits for the pending kits (its swap arrived, it derives nothing again, or it closed): draws them once none waits. */
  private drawPending(world?: string): void {
    const p = this.pending;
    if (p === null) return;
    if (world !== undefined) p.groups.delete(world);
    if (p.groups.size > 0) return;
    this.pending = null;
    this.draws.setKits(p.set);
  }

  /** The project's material records changed (or arrived): the worlds' tables follow them. */
  setMaterials(materials: readonly VoxelLookRecord[]): void {
    this.materials = materials;
    this.draws.setMaterials(materials);
  }

  private makeDraws(): VoxelWorldDraws {
    const { adapter, requestRender } = this.host;
    return new VoxelWorldDraws({
      materials: this.materials,
      scene: () => adapter().threeScene?.() ?? null,
      // The grids upload through the renderer once it can draw.
      renderer: () => (adapter().rendererStarting() ? null : ((adapter().currentRenderer?.() ?? null) as VoxelGridRenderer | null)),
      report: (world, bytes, coarse, kits) => this.post({ t: 'drawn', world, bytes, coarse, kits }),
      applied: () => requestRender(),
      // The view's loader hands each array over to the caller: the draws dispose those they stop drawing.
      ...(this.host.arrayBytes !== undefined ? { textures: (_map: unknown, set: TextureSlotSet) => this.loadArray(set), release: (t: THREE.Texture) => t.dispose() } : {}),
      residency: { level: () => adapter().qualityLevelSettings?.() ?? null, limit: (t, level) => this.textureStreamer.limit(t, level) },
    });
  }

  /** A slot list's array, streamed from its whole file (decoded whole when it has nothing past its mip tail). */
  private async loadArray(set: TextureSlotSet): Promise<THREE.Texture> {
    const bytes = await this.host.arrayBytes!(set);
    const source = wholeKtx2Source(bytes);
    return source !== null ? this.textureStreamer.open(textureSlotSetKey(set), source) : decodeTexture(bytes);
  }

  /** A world's relief ring at the view's quality level now: its steps, the scene's relief distance scaled by the level (never past level 0). */
  private reliefOf(c: VoxelWorldComponent): ReliefRingSettings {
    const level = this.host.adapter().qualityLevelSettings?.() ?? null;
    const own = resolveVoxelWorld(c);
    const at = resolveVoxelWorld(c, level);
    return worldReliefRing({ levels: { ...own.levels, relief: Math.min(at.levels.relief, own.levels.level0) }, reliefSteps: at.reliefSteps });
  }

  private post(m: SceneVoxelsIn): void {
    this.worker?.postMessage(m);
  }

  private start(): Worker {
    if (this.worker !== null) return this.worker;
    const w = new Worker(new URL(WORKER_SCRIPT, document.baseURI).href, { type: 'module', name: 'thirdlight-voxel-view' });
    w.onmessage = (e: MessageEvent<SceneVoxelsOut>) => {
      const m = e.data;
      if (m.t === 'batch') {
        // The swap of what new kits change: those chunks come derived with the new table, drawn with the new kits.
        const g = this.pending?.groups.get(m.batch.world);
        if (g !== undefined && g > 0 && m.batch.swaps.some((s) => s.groups.includes(g))) this.drawPending(m.batch.world);
        this.draws.receive(m.batch);
      } else if (m.t === 'kits') {
        const p = this.pending;
        if (p === null || !p.groups.has(m.world)) return;
        if (m.group === 0) this.drawPending(m.world);
        else p.groups.set(m.world, m.group);
      } else if (m.t === 'state') {
        this.states.set(m.world, m);
        this.problems.delete(m.world);
        this.host.requestRender();
      } else {
        this.problems.set(m.world, m.message);
        this.host.requestRender();
      }
    };
    this.worker = w;
    return w;
  }

  /** The open scenes' objects: the worlds they name are opened, those no object names any more closed. */
  sync(entities: readonly ProjectedEntity[]): void {
    const source = this.host.source;
    if (source === null) return;
    const wanted = new Map<string, string>();
    const settings = new Map<string, ReturnType<typeof resolveVoxelWorld>>();
    for (const e of entities) {
      const c = e.components['voxelWorld'] as VoxelWorldComponent | undefined;
      if (c === undefined || typeof c.world !== 'string' || wanted.has(c.world)) continue;
      const s = resolveVoxelWorld(c);
      wanted.set(c.world, JSON.stringify(s));
      settings.set(c.world, s);
    }
    for (const name of [...this.open.keys()]) {
      if (wanted.get(name) === this.open.get(name)) continue;
      this.open.delete(name);
      this.states.delete(name);
      this.problems.delete(name);
      this.post({ t: 'close', world: name });
      this.posted.delete(name);
      this.components.delete(name);
      this.drawPending(name);
    }
    for (const [name, key] of wanted) {
      if (this.open.has(name)) continue;
      const s = settings.get(name)!;
      const c = entities.find((e) => (e.components['voxelWorld'] as VoxelWorldComponent | undefined)?.world === name)!.components['voxelWorld'] as VoxelWorldComponent;
      this.start();
      this.open.set(name, key);
      this.components.set(name, c);
      void this.currentKits().then((kits) => {
        // Closed (or opened again with other settings) while the kits were read.
        if (this.open.get(name) !== key) return;
        this.posted.add(name);
        const relief = this.reliefOf(c);
        this.reliefLevel = this.host.adapter().qualityLevelSettings?.()?.id ?? null;
        this.post({ t: 'open', world: name, url: source.url(name), headers: source.headers, workerUrl: new URL(DERIVE_SCRIPT, document.baseURI).href, ring: s.ring, levels: { ...s.levels, relief: relief.radius * VOXEL_SIZE_M }, collision: s.collision, sectionEdge: s.sectionEdge, reliefSteps: relief.n, kits: kits.kits, pieceSeed: kits.seed });
        if (this.focusSent !== null) this.post({ t: 'focus', x: this.focusSent[0], y: this.focusSent[1], z: this.focusSent[2] });
      });
    }
  }

  /** Where the view looks (the orbit's target, metres): the worlds stream around it. */
  focus(at: THREE.Vector3): void {
    if (this.open.size === 0) return;
    // The view's quality level changed: every world's relief ring follows it.
    const level = this.host.adapter().qualityLevelSettings?.()?.id ?? null;
    if (level !== this.reliefLevel) {
      this.reliefLevel = level;
      for (const name of this.posted) {
        const c = this.components.get(name);
        if (c !== undefined) this.post({ t: 'relief', world: name, ring: this.reliefOf(c) });
      }
    }
    const f = this.focusSent;
    // A move within a cell changes nothing the streamer plans with.
    if (f !== null && Math.abs(f[0] - at.x) < 0.5 && Math.abs(f[1] - at.y) < 0.5 && Math.abs(f[2] - at.z) < 0.5) return;
    this.focusSent = [at.x, at.y, at.z];
    this.post({ t: 'focus', x: at.x, y: at.y, z: at.z });
  }

  /** A voxel world change from the editor feed. */
  changed(c: VoxelsChangedPayload): void {
    if (!this.open.has(c.world)) return;
    this.post({ t: 'changed', world: c.world, change: c });
  }

  /** The adapter (and its renderer) was replaced: the draws start again in its scene, every world streamed again. */
  adapterReplaced(): void {
    this.draws.dispose();
    this.draws = this.makeDraws();
    // The kits are read again for the new draws, their meshes loaded again for the new renderer.
    this.kitMeshes?.dispose();
    this.kitMeshes = null;
    this.kits = null;
    this.kitsKey = null;
    this.pending = null;
    const names = [...this.open.keys()];
    for (const name of names) this.post({ t: 'close', world: name });
    this.open.clear();
    this.posted.clear();
    this.components.clear();
    this.states.clear();
    this.focusSent = null;
  }

  /** What is drawn (`data-voxels` on the view: tests read it); absent with no world. */
  stamp(root: HTMLElement): void {
    if (this.open.size === 0 && this.stampMark === '') return;
    const drawn = this.draws.stats();
    const mark = this.open.size === 0 ? '' : JSON.stringify({ worlds: drawn.worlds, replaced: drawn.replaced, batches: drawn.batches, states: Object.fromEntries(this.states), problems: Object.fromEntries(this.problems) });
    if (mark === this.stampMark) return;
    this.stampMark = mark;
    if (mark === '') root.removeAttribute('data-voxels');
    else root.setAttribute('data-voxels', mark);
  }

  dispose(): void {
    this.worker?.terminate();
    this.worker = null;
    this.draws.dispose();
    this.textureStreamer.dispose();
    this.kitMeshes?.dispose();
    this.kitMeshes = null;
    this.kits = null;
    this.pending = null;
    this.open.clear();
    this.posted.clear();
  }
}
