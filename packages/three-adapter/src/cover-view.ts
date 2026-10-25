/**
 * Ground cover drawn — the cover rules (`scatter.ts`, `cover: true`) of the
 * terrains and block layers, placed while the game runs and never stored.
 *
 * Every copy is placed and thinned on the GPU (`cover-gpu.ts`); this view
 * hands the sources over to it and feeds it what only the stored scatter's
 * surface code can work out, made on a worker (`cover-worker.ts`): a
 * terrain rule's masks per tile (spline bands, block cuts, regions, cavity)
 * and a block layer rule's point sets per chunk. An edit of the ground (a
 * block chunk or a terrain tile changed, a spline's scatter band moved)
 * makes the masks or point sets over it again; the old ones are drawn until
 * the new ones arrive, so an edit never blinks the cover away.
 *
 * The block and terrain views hand the sources over (`ScatterSink`), as they
 * do to the stored scatter's view. A terrain's cover keeps off the block
 * layers its blocks layers meet (as its stored scatter does): those block
 * layers are handed to the worker too, rules or not, and an edit of one
 * makes the terrain's masks round the edit again.
 *
 * Meshes carry cover rules too: a model object's faces that look up
 * (`cover-models.ts`, read once the object settles) and generated
 * architecture's floors (its view hands them over when it expands). Their
 * triangles go to the worker, which bakes their point sets per square
 * ({@link MESH_COVER_CHUNK_METRES}) as it does a block layer's chunks.
 */
import type * as THREE from 'three';

import { CHUNK_SIZE, MESH_COVER_CHUNK_METRES, TERRAIN_BLOCKS_BLEND_DEFAULT, coverScatterRules, meshCoverChunks, scatterReach, splineScatterRect, terrainSplineInputs, type BlockChunk, type BlockLayerComponent, type BlockLayerData, type BlockType, type CoverPointSet, type ScatterRect, type ScatterRule, type TerrainComponent, type TerrainTile } from '@thirdlight/runtime';

import type { MeshWorkerPort } from './block-mesh-pool';
import { CoverGpu, type CoverGpuDiagnostics } from './cover-gpu';
import { CoverModels, type CoverModelLike } from './cover-models';
import { coverGrowsOnTerrain, coverReadsMask } from './cover-placement';
import { CoverGenerator, type CoverReply, type CoverRequest, type CoverSpline } from './cover-worker';
import type { LodTuning } from './lod-switch';
import type { WarmDraw } from './program-warmer';
import type { TerrainCoverSurface } from './terrain-view';
import type { CullView } from './view-cull';
import type { ModelInstance } from './visual';

/** Cells round a changed block column whose footprint a terrain's cover reads (a larger block's reach and the corner it shares). */
const BLOCK_CHANGE_CELLS = 9;

export interface CoverViewDeps {
  /** A model instance to draw a rule's copies with (null while it loads; `onReady` then). */
  template(assetId: string, piece: string | undefined, onReady: () => void): ModelInstance | null;
  /** Dress a built set with the asset's materials; returns what takes them off. */
  dress?(root: THREE.Object3D, assetId: string): (() => void) | null;
  /** A draw enters or leaves the scene. */
  place(root: THREE.Object3D, shown: boolean): void;
  /** A terrain tile's decoded data by digest (the page's tile store), when decoded. */
  tile(digest: string): TerrainTile | undefined;
  /** Makes the worker (null, or absent: masks and point sets are made on the page). */
  worker?: () => MeshWorkerPort | null;
  tuning?: LodTuning;
  /** Something changed (a frame should be drawn). */
  changed?(): void;
  /** A terrain as its view draws it (null: not drawn yet). */
  surface(id: string): TerrainCoverSurface | null;
  /** An object's world matrix (false: not placed; absent: models carry no cover). */
  worldMatrix?(id: string, out: THREE.Matrix4): boolean;
  /** Build a ring's draws' programs ahead of their first draw (absent: built when first drawn). */
  warm?(d: WarmDraw): void;
}

export interface CoverViewDiagnostics {
  /** Terrains, block layers and meshes with cover rules, and the terrain tiles handed to the worker. */
  sources: number;
  tilesSent: number;
  /** What the GPU draws. */
  gpu?: CoverGpuDiagnostics;
}

/** A terrain with cover rules (its masks are asked for here). */
interface TerrainSource {
  readonly id: string;
  terrain: TerrainComponent;
  origin: [number, number, number];
  /** What a mask reads past its own box (m). */
  margin: number;
}

/** A mesh's cover as last handed over: its object, place, rules and faces. */
interface HeldMesh {
  readonly entity: string;
  readonly origin: [number, number, number];
  readonly rules: ScatterRule[];
  readonly triangles: Float32Array;
}

/** The suffixes of an object's mesh sources: its model's faces and its architecture's floors (one object may have both). */
const MODEL_MESH = '|model';
const ARCHITECTURE_MESH = '|architecture';

/** A block layer as last handed over, and whether the worker holds it (its own rules, or a terrain's blocks layer meets it). */
interface HeldLayer {
  component: BlockLayerComponent;
  origin: [number, number, number];
  chunks: Map<string, BlockChunk>;
  rules: ScatterRule[];
  sent: boolean;
}

export class CoverView {
  private readonly terrains = new Map<string, TerrainSource>();
  private readonly blockLayers = new Map<string, HeldLayer>();
  private port: MeshWorkerPort | null | undefined = undefined;
  private local: CoverGenerator | null = null;
  private readonly sentTiles = new Set<string>();
  private serial = 0;
  private disposed = false;
  private types: readonly BlockType[] = [];
  /** The splines with a scatter band, by id: what each was (JSON) and the box its band keeps clear (null: none). */
  private splines = new Map<string, { key: string; rect: ScatterRect | null }>();
  private splineList: readonly CoverSpline[] = [];
  private readonly gpu: CoverGpu;
  /** Answers asked of the worker, by job: where each goes. */
  private readonly jobs = new Map<number, (r: CoverReply) => void>();
  /** The meshes with cover, by source id (object id and suffix). */
  private readonly meshSources = new Map<string, HeldMesh>();
  private readonly models: CoverModels | null;
  /** The objects the simulation hides (a mesh's cover handed over later starts hidden with its object). */
  private hiddenObjects: ReadonlySet<string> = new Set();

  constructor(private readonly deps: CoverViewDeps) {
    this.gpu = new CoverGpu({
      template: deps.template,
      ...(deps.dress !== undefined ? { dress: deps.dress } : {}),
      place: deps.place,
      surface: deps.surface,
      ...(deps.tuning !== undefined ? { tuning: deps.tuning } : {}),
      ...(deps.changed !== undefined ? { changed: deps.changed } : {}),
      ...(deps.warm !== undefined ? { warm: deps.warm } : {}),
      maskWanted: (id, rule, tx, tz) => this.maskWanted(id, rule, tx, tz),
      mask: (id, rule, tx, tz, reply) => this.askMask(id, rule, tx, tz, reply),
      points: (id, rule, cx, cz, reply) => this.ask({ t: 'coverPoints', job: 0, id, rule: rule.id, cx, cz }, (r) => reply(r.t === 'coverPointed' ? r.points : null)),
    });
    const worldMatrix = deps.worldMatrix;
    this.models = worldMatrix === undefined ? null : new CoverModels({ template: deps.template, worldMatrix, setMesh: (id, rules, origin, tris) => this.setMesh(`${id}${MODEL_MESH}`, id, rules, origin, tris), ...(deps.changed !== undefined ? { changed: deps.changed } : {}) });
  }

  // ---- meshes ------------------------------------------------------------------------------

  /** Object `id`'s model and its cover rules (null: it has none, or was let go). */
  setModel(id: string, model: CoverModelLike | null): void {
    this.models?.set(id, model);
  }

  /** Object `id`'s architecture floors (object frame, 9 floats a triangle) at `origin` and its cover rules (null: none). */
  setArchitecture(id: string, rules: readonly ScatterRule[] | undefined, origin: readonly number[], floors: Float32Array | null): void {
    this.setMesh(`${id}${ARCHITECTURE_MESH}`, id, rules ?? [], origin, floors);
  }

  /** A mesh source's faces, rules and place; the same values change nothing, new ones make every set again. */
  private setMesh(id: string, entity: string, all: readonly ScatterRule[], origin: readonly number[], triangles: Float32Array | null): void {
    const rules = coverScatterRules(all);
    if (rules.length === 0 || triangles === null || triangles.length === 0) {
      if (this.meshSources.delete(id)) {
        this.send({ t: 'coverDrop', id });
        this.gpu.remove(id);
      }
      return;
    }
    const o: [number, number, number] = [origin[0] ?? 0, origin[1] ?? 0, origin[2] ?? 0];
    const was = this.meshSources.get(id);
    if (was !== undefined && was.origin.every((v, i) => v === o[i]) && JSON.stringify(was.rules) === JSON.stringify(rules) && sameFloats(was.triangles, triangles)) return;
    const held: HeldMesh = { entity, origin: o, rules, triangles };
    this.meshSources.set(id, held);
    this.sendMesh(id, held);
    this.gpu.setPoints(id, rules, o, [MESH_COVER_CHUNK_METRES, MESH_COVER_CHUNK_METRES], meshCoverChunks(triangles));
    this.gpu.invalidatePoints(id, null);
    if (this.hiddenObjects.has(entity)) this.gpu.setHidden(id, true);
  }

  private sendMesh(id: string, held: HeldMesh): void {
    this.send({ t: 'coverSource', id, source: { kind: 'mesh', origin: held.origin, rules: held.rules, triangles: held.triangles } });
  }

  /** The objects the simulation hides: their meshes' cover with them. */
  setMeshesHidden(hidden: ReadonlySet<string>): void {
    this.hiddenObjects = hidden;
    for (const [id, m] of this.meshSources) this.gpu.setHidden(id, hidden.has(m.entity));
  }

  // ---- the sources (ScatterSink) -----------------------------------------------------

  setTypes(types: readonly BlockType[]): void {
    this.types = types;
    this.send({ t: 'coverTypes', types });
    for (const id of this.blockLayers.keys()) this.gpu.invalidatePoints(id, null);
  }

  /**
   * The splines whose scatter bands terrain cover keeps clear of (all of
   * them, each time any changes): the masks under the bands of those that
   * changed — where they were and where they are now — are made again.
   */
  setSplines(splines: readonly CoverSpline[]): void {
    const next = new Map<string, { key: string; rect: ScatterRect | null }>();
    for (const s of splines) {
      const input = terrainSplineInputs([{ id: s.id, components: { spline: s.component, transform: { position: s.origin } } }])[0];
      next.set(s.id, { key: JSON.stringify(s), rect: input === undefined ? null : splineScatterRect(input) });
    }
    const changed: ScatterRect[] = [];
    for (const [id, was] of this.splines) if (next.get(id)?.key !== was.key && was.rect !== null) changed.push(was.rect);
    for (const [id, now] of next) if (this.splines.get(id)?.key !== now.key && now.rect !== null) changed.push(now.rect);
    const same = next.size === this.splines.size && [...next].every(([id, n]) => this.splines.get(id)?.key === n.key);
    this.splines = next;
    this.splineList = splines;
    if (same) return;
    this.send({ t: 'coverSplines', splines });
    for (const t of this.terrains.values()) for (const r of changed) this.remakeRect(t, r);
  }

  setBlockLayer(id: string, component: BlockLayerComponent, origin: readonly number[], chunks: Iterable<BlockChunk>): void {
    const rules = coverScatterRules(component.scatter);
    const o: [number, number, number] = [origin[0] ?? 0, origin[1] ?? 0, origin[2] ?? 0];
    const was = this.blockLayers.get(id);
    const held: HeldLayer = { component, origin: o, chunks: new Map([...chunks].map((c) => [`${c.cx},${c.cz}`, c])), rules, sent: false };
    this.blockLayers.set(id, held);
    // The worker holds it for its own rules, or for a terrain keeping its cover off it.
    if (rules.length > 0 || this.metBy(id).length > 0 || was?.sent === true) this.sendBlockLayer(id);
    this.setPoints(id, held);
    this.gpu.invalidatePoints(id, null);
    for (const t of this.metBy(id)) this.gpu.invalidateMasks(t.id, null);
  }

  /** Block layer `id`'s rules, place and chunks as the GPU draws them. */
  private setPoints(id: string, held: HeldLayer): void {
    const cs = held.component.cellSize;
    this.gpu.setPoints(id, held.rules, held.origin, [CHUNK_SIZE * cs[0], CHUNK_SIZE * cs[2]], new Set(held.chunks.keys()));
  }

  /** The terrains (with cover rules) whose blocks layers meet block layer `id`. */
  private metBy(id: string): TerrainSource[] {
    const out: TerrainSource[] = [];
    for (const t of this.terrains.values()) if ((t.terrain.layers ?? []).some((l) => l.kind === 'blocks' && l.enabled !== false && (l.blockLayers === undefined || l.blockLayers.includes(id)))) out.push(t);
    return out;
  }

  /** Hand a block layer (as last given) to the worker. */
  private sendBlockLayer(id: string): void {
    const held = this.blockLayers.get(id);
    if (held === undefined) return;
    held.sent = true;
    const data: BlockLayerData = { entityId: id, chunks: [...held.chunks.values()] };
    this.send({ t: 'coverSource', id, source: { kind: 'blocks', component: held.component, origin: held.origin, rules: held.rules, data } });
  }

  replaceBlockChunks(id: string, chunks: readonly { cx: number; cz: number; chunk: BlockChunk | null }[]): void {
    const held = this.blockLayers.get(id);
    if (held === undefined) return;
    for (const c of chunks) {
      if (c.chunk === null) held.chunks.delete(`${c.cx},${c.cz}`);
      else held.chunks.set(`${c.cx},${c.cz}`, c.chunk);
    }
    if (held.sent) this.send({ t: 'coverChunks', id, chunks });
    this.setPoints(id, held);
    const [cw, , cd] = held.component.cellSize;
    const o = held.origin;
    // The layer's sets over the chunks and the reach round them (spacing and cavity read across a chunk's edge).
    const m = scatterReach(held.rules) + Math.max(cw, cd);
    const W = CHUNK_SIZE * cw;
    const D = CHUNK_SIZE * cd;
    for (const c of chunks) this.gpu.invalidatePoints(id, [o[0] + c.cx * W - m, o[2] + c.cz * D - m, o[0] + (c.cx + 1) * W + m, o[2] + (c.cz + 1) * D + m]);
    // Terrains keeping their cover off the layer: their masks round the chunks (a footprint reaches a few cells past one).
    for (const t of this.metBy(id)) {
      const blend = Math.max(...(t.terrain.layers ?? []).map((l) => (l.kind === 'blocks' ? (l.blend ?? TERRAIN_BLOCKS_BLEND_DEFAULT) : 0)));
      for (const c of chunks) this.remakeRect(t, [o[0] + (c.cx * CHUNK_SIZE - BLOCK_CHANGE_CELLS) * cw - blend, o[2] + (c.cz * CHUNK_SIZE - BLOCK_CHANGE_CELLS) * cd - blend, o[0] + ((c.cx + 1) * CHUNK_SIZE + BLOCK_CHANGE_CELLS) * cw + blend, o[2] + ((c.cz + 1) * CHUNK_SIZE + BLOCK_CHANGE_CELLS) * cd + blend]);
    }
  }

  setTerrain(id: string, component: TerrainComponent, origin: readonly number[]): void {
    // Every rule that can grow on a terrain is drawn on the GPU; the worker holds the terrain for its masks.
    const rules = coverScatterRules(component.scatter).filter(coverGrowsOnTerrain);
    this.gpu.setRules(id, rules);
    const o: [number, number, number] = [origin[0] ?? 0, origin[1] ?? 0, origin[2] ?? 0];
    const before = this.terrains.get(id);
    if (rules.length === 0) {
      if (before !== undefined) this.dropTerrain(id);
      return;
    }
    const t: TerrainSource = { id, terrain: component, origin: o, margin: scatterReach(rules) + 2 * component.spacing };
    this.terrains.set(id, t);
    this.send({ t: 'coverSource', id, source: { kind: 'terrain', component, origin: o, rules } });
    // The block layers its blocks layers meet, handed to the worker (once).
    for (const [lid, held] of this.blockLayers) if (!held.sent && this.metBy(lid).includes(t)) this.sendBlockLayer(lid);
    const blocksOf = (c: TerrainComponent): string => JSON.stringify((c.layers ?? []).filter((l) => l.kind === 'blocks'));
    const moved = before !== undefined && !before.origin.every((v, i) => v === o[i]);
    if (before === undefined || moved || blocksOf(before.terrain) !== blocksOf(component) || JSON.stringify(coverScatterRules(before.terrain.scatter)) !== JSON.stringify(coverScatterRules(component.scatter))) {
      this.gpu.invalidateMasks(id, null);
      return;
    }
    // A tile whose data changed: the masks over it are made again.
    const size = (component.tileSamples - 1) * component.spacing;
    const old = new Map(before.terrain.tiles.map((x) => [`${x.x},${x.z}`, x.data]));
    for (const x of component.tiles) if (old.get(`${x.x},${x.z}`) !== x.data) this.remakeRect(t, [o[0] + x.x * size, o[2] + x.z * size, o[0] + (x.x + 1) * size, o[2] + (x.z + 1) * size]);
  }

  setOrigin(id: string, origin: readonly number[]): void {
    const t = this.terrains.get(id);
    if (t !== undefined) this.setTerrain(id, t.terrain, origin);
    const held = this.blockLayers.get(id);
    if (held === undefined || held.origin.every((v, i) => v === (origin[i] ?? 0))) return;
    held.origin = [origin[0] ?? 0, origin[1] ?? 0, origin[2] ?? 0];
    if (held.sent) this.sendBlockLayer(id);
    // Everything moves with the object: made again where it stands now (the rules read world positions).
    this.setPoints(id, held);
    for (const m of this.metBy(id)) this.gpu.invalidateMasks(m.id, null);
  }

  setHidden(id: string, hidden: boolean): void {
    this.gpu.setHidden(id, hidden);
  }

  remove(id: string): void {
    const held = this.blockLayers.get(id);
    if (held !== undefined) {
      const met = this.metBy(id);
      this.blockLayers.delete(id);
      if (held.sent) this.send({ t: 'coverDrop', id });
      for (const t of met) this.gpu.invalidateMasks(t.id, null);
    }
    if (this.meshSources.delete(id)) this.send({ t: 'coverDrop', id });
    this.dropTerrain(id);
    this.gpu.remove(id);
  }

  private dropTerrain(id: string): void {
    if (!this.terrains.delete(id)) return;
    this.send({ t: 'coverDrop', id });
  }

  ids(): string[] {
    return this.gpu.ids();
  }

  // ---- the frame ------------------------------------------------------------------------

  /** List the GPU's patches and blocks round the view's eye (call once a frame). */
  update(view: CullView): void {
    if (this.disposed) return;
    this.models?.update();
    this.gpu.update(view);
  }

  diagnostics(): CoverViewDiagnostics {
    return { sources: this.gpu.ids().length, tilesSent: this.sentTiles.size, ...(this.gpu.ids().length > 0 ? { gpu: this.gpu.diagnostics() } : {}) };
  }

  meshes(): THREE.Mesh[] {
    return this.gpu.meshes();
  }

  dispose(): void {
    if (this.disposed) return;
    for (const id of this.ids()) this.remove(id);
    this.gpu.dispose();
    this.disposed = true;
    this.port?.terminate();
    this.port = null;
  }

  // ---- internals ------------------------------------------------------------------------

  /** The masks whose ground a changed world box reaches are made again. */
  private remakeRect(t: TerrainSource, rect: ScatterRect): void {
    const m = t.margin;
    this.gpu.invalidateMasks(t.id, [rect[0] - m, rect[1] - m, rect[2] + m, rect[3] + m]);
  }

  /** A terrain's tiles under a box (and its margin) handed to the worker; false: one is not decoded yet. */
  private sendTiles(t: TerrainSource, rect: ScatterRect): boolean {
    const c = t.terrain;
    const size = (c.tileSamples - 1) * c.spacing;
    const m = t.margin;
    for (const x of c.tiles) {
      if (x.data === undefined) continue;
      const box: ScatterRect = [t.origin[0] + x.x * size, t.origin[2] + x.z * size, t.origin[0] + (x.x + 1) * size, t.origin[2] + (x.z + 1) * size];
      if (!overlaps(box, [rect[0] - m, rect[1] - m, rect[2] + m, rect[3] + m])) continue;
      if (this.sentTiles.has(x.data)) continue;
      const tile = this.deps.tile(x.data);
      if (tile === undefined) return false;
      this.sentTiles.add(x.data);
      // A copy each (the page keeps its own arrays for drawing and collision).
      this.send({ t: 'coverTile', digest: x.data, tile: { samples: tile.samples, heights: tile.heights.slice(), weights: tile.weights?.slice() ?? null, holes: tile.holes?.slice() ?? null, paint: tile.paint?.slice() ?? null } });
    }
    return true;
  }

  /** Whether a terrain rule needs a mask over a tile: it reads one, the terrain's blocks layers cut the ground, or a spline's band lies on the tile. */
  private maskWanted(id: string, rule: ScatterRule, tx: number, tz: number): boolean {
    if (coverReadsMask(rule)) return true;
    const t = this.terrains.get(id);
    if (t === undefined) return false;
    const c = t.terrain;
    if ((c.layers ?? []).some((l) => l.kind === 'blocks' && l.enabled !== false && (l.strength ?? 1) > 0)) return true;
    const size = (c.tileSamples - 1) * c.spacing;
    const box: ScatterRect = [t.origin[0] + tx * size, t.origin[2] + tz * size, t.origin[0] + (tx + 1) * size, t.origin[2] + (tz + 1) * size];
    return [...this.splines.values()].some((sp) => sp.rect !== null && overlaps(sp.rect, box));
  }

  /** Ask the worker for a terrain rule's mask over a tile (false: a tile under it is not decoded yet). */
  private askMask(id: string, rule: ScatterRule, tx: number, tz: number, reply: (mask: Uint8Array | null) => void): boolean {
    const t = this.terrains.get(id);
    if (t === undefined) return false;
    const size = (t.terrain.tileSamples - 1) * t.terrain.spacing;
    if (!this.sendTiles(t, [t.origin[0] + tx * size, t.origin[2] + tz * size, t.origin[0] + (tx + 1) * size, t.origin[2] + (tz + 1) * size])) return false;
    this.ask({ t: 'coverMask', job: 0, id, rule: rule.id, tx, tz }, (r) => reply(r.t === 'coverMasked' ? r.mask : null));
    return true;
  }

  /** Ask the worker (or the page's own generator) for a mask or a point set; `reply` gets the answer. */
  private ask(m: Extract<CoverRequest, { t: 'coverMask' | 'coverPoints' }>, reply: (r: CoverReply) => void): void {
    const job = ++this.serial;
    this.jobs.set(job, reply);
    this.send({ ...m, job });
  }

  private received(r: CoverReply): void {
    const reply = this.jobs.get(r.job);
    this.jobs.delete(r.job);
    if (r.message !== undefined) console.warn(`ground cover: ${r.message}`);
    reply?.(r);
  }

  /** A message to the worker, else the page's own generator. */
  private send(m: CoverRequest): void {
    if (this.port === undefined) {
      this.port = this.deps.worker?.() ?? null;
      if (this.port !== null) {
        this.port.listen((raw) => {
          const r = raw as Partial<CoverReply> | null;
          if (r?.t === 'coverMasked' || r?.t === 'coverPointed') this.received(r as CoverReply);
        });
        this.port.onError((message) => {
          console.warn(`ground cover worker: ${message}; made on the page instead`);
          this.port?.terminate();
          this.port = null;
          this.restart();
        });
      }
    }
    if (this.port !== null) {
      this.port.post(m, m.t === 'coverTile' ? [m.tile.heights.buffer as ArrayBuffer, ...[m.tile.weights, m.tile.holes, m.tile.paint].flatMap((a) => (a !== null ? [a.buffer as ArrayBuffer] : []))] : undefined);
      return;
    }
    this.local ??= new CoverGenerator();
    const local = this.local;
    if (m.t === 'coverMask') {
      const mask = local.mask(m.id, m.rule, m.tx, m.tz);
      queueMicrotask(() => this.received({ t: 'coverMasked', job: m.job, mask }));
    } else if (m.t === 'coverPoints') {
      const points: CoverPointSet | null = local.points(m.id, m.rule, m.cx, m.cz);
      queueMicrotask(() => this.received({ t: 'coverPointed', job: m.job, points }));
    } else local.apply(m);
  }

  /** The worker failed: everything it held handed to the page's own generator, and every mask and point set asked again. */
  private restart(): void {
    this.sentTiles.clear();
    this.jobs.clear();
    if (this.types.length > 0) this.send({ t: 'coverTypes', types: this.types });
    if (this.splineList.length > 0) this.send({ t: 'coverSplines', splines: this.splineList });
    for (const [id, held] of this.blockLayers) if (held.sent) this.sendBlockLayer(id);
    for (const [id, held] of this.meshSources) {
      this.sendMesh(id, held);
      this.gpu.invalidatePoints(id, null);
    }
    for (const t of this.terrains.values()) {
      this.send({ t: 'coverSource', id: t.id, source: { kind: 'terrain', component: t.terrain, origin: t.origin, rules: coverScatterRules(t.terrain.scatter).filter(coverGrowsOnTerrain) } });
      this.gpu.invalidateMasks(t.id, null);
    }
    for (const id of this.blockLayers.keys()) this.gpu.invalidatePoints(id, null);
  }
}

const sameFloats = (a: Float32Array, b: Float32Array): boolean => a.length === b.length && a.every((v, i) => v === b[i]);

const overlaps = (a: ScatterRect, b: ScatterRect): boolean => a[0] < b[2] && b[0] < a[2] && a[1] < b[3] && b[1] < a[3];
