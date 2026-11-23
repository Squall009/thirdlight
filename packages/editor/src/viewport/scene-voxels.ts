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
 *
 * A world's structure grids are drawn where their `voxelStructure` objects
 * stand (their position and yaw), with the world's surface and piece batches
 * as in Play: the worker streams each grid in its own frame. An object moved
 * or turned (a gizmo drag included, read each frame) moves its grid's draws
 * at once, with nothing read or derived again. A click on a grid's voxels
 * selects its object (`pick`: the worker walks every world and its grids,
 * each in its own frame); the selection's box is the structure's.
 */
import { resolveVoxelWorld, type VoxelWorldComponent } from '@thirdlight/project-model/voxel-world';
import { BUILDING_GENERATOR, GridFrame, gridDrawName, gridPlacementProblem, parseStructureDefinition, VOXEL_SIZE_M, worldReliefRing, type GridPlacement, type ReliefRingSettings } from '@thirdlight/voxel';
import type { VoxelsChangedPayload } from '@thirdlight/protocol';
import { createTextureStreamer, decodeTexture, VoxelKitMeshes, VoxelWorldDraws, wholeKtx2Source, type SceneAdapter, type TextureStreamer, type VoxelGridRenderer, type VoxelKitSet, type VoxelLookRecord } from '@thirdlight/three-adapter';
import { textureBudgetBytesOf } from '@thirdlight/project-model/limits';
import { pageKitPieces, readVoxelKits, type KitRoute, type ProjectVoxelKits } from '../voxel-world/kit-pieces';
import * as THREE from 'three';
import { textureSlotSetKey, type TextureSlotSet } from '@thirdlight/project-model/texture-slots';
import type { ProjectedEntity } from '../session/projection';
import type { ScenePickHit, SceneVoxelsIn, SceneVoxelsOut } from '../voxel-world/scene-voxels-wire';
import { WaterLeakMarkers, type WaterLeakMark } from './water-leaks';

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
  /** An object's local transform as drawn now (a gizmo drag's included; null: not drawn). */
  readonly localOf?: (id: string) => { readonly position: readonly number[]; readonly rotation: readonly number[] } | null;
  /** The bytes of the voxel surfaces' texture array of a slot list (the backend assembles it); absent: flat colours. */
  readonly arrayBytes?: (set: TextureSlotSet) => Promise<Uint8Array>;
  /** The view's overlay group (what is drawn over the scene: where water bodies leak); absent: not drawn. */
  readonly overlay?: THREE.Object3D;
}

type WorldState = Extract<SceneVoxelsOut, { t: 'state' }>;

/** A structure object as the view draws its grid: its world, grid id, its cells' box (the definition's), its place. */
interface StructureDraw {
  readonly world: string;
  readonly grid: number;
  /** The component as synced (its box is made again only when it changes). */
  readonly def: Readonly<Record<string, unknown>>;
  readonly box: { readonly min: readonly number[]; readonly max: readonly number[] } | null;
  /** Where its object is stored, and where its draws were last put (undefined: not yet). */
  readonly place: GridPlacement;
  drawn?: GridPlacement;
}

/** The place an object's transform gives its structure grid: its position and its turn about the vertical (null: not a place). */
function placeOf(grid: number, t: { readonly position: readonly number[]; readonly rotation: readonly number[] }): GridPlacement | null {
  const q = t.rotation;
  const place: GridPlacement = { gridId: grid, position: [t.position[0]!, t.position[1]!, t.position[2]!], yawRad: 2 * Math.atan2(q[1]!, q[3]!) };
  return gridPlacementProblem(place) === null ? place : null;
}

/** A structure's cells' box (inclusive, its own grid's cells) from its definition (null: one its generator refuses). */
function structureCells(c: Record<string, unknown>): { min: number[]; max: number[] } | null {
  const { world: _w, grid: _g, ...def } = c;
  void _w;
  void _g;
  try {
    const b = BUILDING_GENERATOR.box(parseStructureDefinition(def));
    return { min: [b.minX, b.minY, b.minZ], max: [b.maxX, b.maxY, b.maxZ] };
  } catch {
    return null;
  }
}

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
  /** The open scenes' structure objects (by object id), and each world's grid places as last told to the worker. */
  private readonly structures = new Map<string, StructureDraw>();
  private readonly gridsSent = new Map<string, string>();
  /** Who hears of the feed's voxel changes. */
  private readonly listeners = new Set<(c: VoxelsChangedPayload) => void>();
  /** Picks waiting for the worker's answer, by id. */
  private readonly picks = new Map<number, (hit: ScenePickHit | null) => void>();
  private pickSeq = 0;
  /** Structure draws moved to their objects (a move, a turn, a drag's frame) and the ms it took in all (diagnostics). */
  private readonly moved = { count: 0, ms: 0, lastMs: 0 };

  /** The view's texture streamer: the voxel arrays are its only streamed textures (the view's asset textures load whole). */
  readonly textureStreamer: TextureStreamer;

  /** Where the water bodies leak, marked over the scene (the backend's reports). */
  private readonly leaks: WaterLeakMarkers | null;

  constructor(private readonly host: SceneVoxelsHost) {
    this.textureStreamer = createTextureStreamer({ budgetBytes: textureBudgetBytesOf(undefined), onChange: () => host.requestRender() });
    this.draws = this.makeDraws();
    this.leaks = host.overlay === undefined ? null : new WaterLeakMarkers(host.overlay);
  }

  /** The places water bodies leak, marked in the view (an empty list clears them). */
  waterLeaks(marks: readonly WaterLeakMark[]): void {
    this.leaks?.set(marks);
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
      } else if (m.t === 'picked') {
        this.picks.get(m.id)?.(m.hit);
        this.picks.delete(m.id);
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

  /** The open scenes' objects: the worlds they name are opened, those no object names any more closed; their structures' grids drawn where they stand. */
  sync(entities: readonly ProjectedEntity[]): void {
    const source = this.host.source;
    if (source === null) return;
    this.syncStructures(entities);
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
      this.gridsSent.delete(name);
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
        this.gridsSent.delete(name);
        this.postGrids();
      });
    }
  }

  /** The structure objects of the open scenes as synced: their worlds' grids go to the worker where the objects stand. */
  private syncStructures(entities: readonly ProjectedEntity[]): void {
    const seen = new Set<string>();
    for (const e of entities) {
      const c = e.components['voxelStructure'] as Record<string, unknown> | undefined;
      if (c === undefined || typeof c['world'] !== 'string' || typeof c['grid'] !== 'number' || e.kind === 'folder') continue;
      const place = placeOf(c['grid'], e);
      if (place === null) continue;
      seen.add(e.id);
      const had = this.structures.get(e.id);
      const box = had !== undefined && had.world === c['world'] && had.grid === c['grid'] && JSON.stringify(had.def) === JSON.stringify(c) ? had.box : structureCells(c);
      this.structures.set(e.id, { world: c['world'], grid: c['grid'], def: c, box, place, ...(had?.drawn !== undefined ? { drawn: had.drawn } : {}) });
    }
    for (const id of [...this.structures.keys()]) if (!seen.has(id)) this.structures.delete(id);
    this.postGrids();
  }

  /** Each open world's grids where their objects are stored, to the worker when they changed (what it streams, in which frame). */
  private postGrids(): void {
    const by = new Map<string, GridPlacement[]>();
    for (const name of this.posted) by.set(name, []);
    for (const s of this.structures.values()) by.get(s.world)?.push(s.place);
    for (const [world, places] of by) {
      const key = JSON.stringify(places);
      if (this.gridsSent.get(world) === key) continue;
      this.gridsSent.set(world, key);
      this.post({ t: 'grids', world, places });
    }
  }

  /** Each structure's draws where its object is drawn now (a drag's override, else its stored place): moved at once when that changed. */
  private followStructures(): void {
    const local = this.host.localOf;
    for (const [id, s] of this.structures) {
      const t = local?.(id) ?? null;
      const now = t === null ? s.place : placeOf(s.grid, t);
      if (now === null) continue;
      const drawn = s.drawn;
      if (drawn !== undefined && drawn.yawRad === now.yawRad && drawn.position.every((v, a) => v === now.position[a])) continue;
      s.drawn = now;
      const t0 = performance.now();
      this.draws.placeGrid(gridDrawName(s.world, s.grid), now);
      this.moved.lastMs = performance.now() - t0;
      this.moved.count++;
      this.moved.ms += this.moved.lastMs;
    }
  }

  /** A structure object's cells' box in the world (metres; its turned box's bounds), as drawn now; null: not a structure. */
  structureBox(id: string): THREE.Box3 | null {
    const s = this.structures.get(id);
    if (s === undefined || s.box === null) return null;
    const p = s.drawn ?? s.place;
    const f = new GridFrame(p);
    const out = new THREE.Box3();
    for (let k = 0; k < 8; k++) {
      const c = [0, 1, 2].map((a) => ((k >> a) & 1 ? s.box!.max[a]! + 1 : s.box!.min[a]!) * VOXEL_SIZE_M);
      const w = f.toWorld(c[0]!, c[1]!, c[2]!);
      out.expandByPoint(new THREE.Vector3(w[0], w[1], w[2]));
    }
    return out;
  }

  /**
   * The structure object whose grid a ray (world metres) meets first, nearer than `within` metres, as the worker's
   * walk through every world and its grids answers (null: none, or the world's own cells first); null at once when no
   * structure is drawn (no pick to wait for).
   */
  pick(origin: THREE.Vector3, dir: THREE.Vector3, within: number): Promise<string | null> | null {
    if (this.worker === null || this.structures.size === 0) return null;
    return this.pickHit(origin, dir, within)!.then((hit) => {
      if (hit === null || hit.grid === 0) return null;
      for (const [entity, s] of this.structures) if (s.world === hit.world && s.grid === hit.grid) return entity;
      return null;
    });
  }

  /**
   * What a ray (world metres) meets first within `within` metres in every open world and its grids, each grid in its
   * own frame: the world, the grid, the cell and the face it entered by (null: nothing; null at once with no world open).
   */
  pickHit(origin: THREE.Vector3, dir: THREE.Vector3, within: number): Promise<ScenePickHit | null> | null {
    if (this.worker === null) return null;
    const id = ++this.pickSeq;
    const answer = new Promise<ScenePickHit | null>((ok) => this.picks.set(id, ok));
    this.post({ t: 'pick', id, origin: [origin.x, origin.y, origin.z], dir: [dir.x, dir.y, dir.z], maxM: within });
    return answer;
  }

  /** A world's route as the backend answers it now (its manifest, its grids' files, places, last regenerate reports and hand-edit counts); null: no source or not read. */
  async worldInfo(world: string): Promise<Record<string, unknown> | null> {
    const source = this.host.source;
    if (source === null) return null;
    try {
      const r = await fetch(source.url(world), { headers: source.headers });
      return r.ok ? ((await r.json()) as Record<string, unknown>) : null;
    } catch {
      return null;
    }
  }

  /** Where a structure object's grid is drawn now (a drag's or a preview's place, else its stored one; `stored`: where its object is stored; null: not a structure drawn). */
  structurePlace(id: string, stored = false): GridPlacement | null {
    const s = this.structures.get(id);
    return s === undefined ? null : stored ? s.place : (s.drawn ?? s.place);
  }

  /** Where the view looks (the orbit's target, metres): the worlds stream around it. */
  focus(at: THREE.Vector3): void {
    if (this.open.size === 0) return;
    this.followStructures();
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

  /** A voxel world change from the editor feed (its listeners hear of it too). */
  changed(c: VoxelsChangedPayload): void {
    for (const l of this.listeners) l(c);
    if (!this.open.has(c.world)) return;
    this.post({ t: 'changed', world: c.world, change: c });
  }

  /** Hear of every voxel world change the feed brings (the structure mode's counts and misfits); returns the unsubscribe. */
  listen(listener: (c: VoxelsChangedPayload) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
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
    // The new draws are placed again; the worlds opened again are told their grids again.
    for (const st of this.structures.values()) delete st.drawn;
    this.gridsSent.clear();
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
    const mark = this.open.size === 0 ? '' : JSON.stringify({ worlds: drawn.worlds, replaced: drawn.replaced, batches: drawn.batches, states: Object.fromEntries(this.states), problems: Object.fromEntries(this.problems), moved: this.moved });
    if (mark === this.stampMark) return;
    this.stampMark = mark;
    if (mark === '') root.removeAttribute('data-voxels');
    else root.setAttribute('data-voxels', mark);
  }

  dispose(): void {
    this.leaks?.dispose();
    for (const answer of this.picks.values()) answer(null);
    this.picks.clear();
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
