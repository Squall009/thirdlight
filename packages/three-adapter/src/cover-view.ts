/**
 * Ground cover drawn — the cover rules (`scatter.ts`, `cover: true`) of the
 * terrains and block layers near the camera, made while the game runs and
 * never stored.
 *
 * The ground around the camera is cut into squares of
 * {@link COVER_CELL_METRES}; a square within a rule's reach is made on a
 * worker (`cover-worker.ts`: the stored scatter's rule code and surfaces) and
 * drawn as one instance set per rule, its copies thinning to nothing toward
 * the rule's `coverDistance` by distance; squares the camera left
 * ({@link COVER_KEEP_FRACTION} past the reach) are dropped. Squares are asked
 * nearest first, a few at a time, and built within {@link COVER_BUILD_MS} a
 * frame. An edit of the ground (a block chunk or a terrain tile changed, a
 * spline's scatter band moved) makes the squares over it again; a square
 * made again keeps drawing its old copies until its new ones are built, so an
 * edit never blinks the cover away.
 *
 * The block and terrain views hand the sources over (`ScatterSink`), as they
 * do to the stored scatter's view. A terrain's cover keeps off the block
 * layers its blocks layers meet (as its stored scatter does): those block
 * layers are handed to the generator too, rules or not, and an edit of one
 * makes the terrain's squares round the edit again.
 */
import * as THREE from 'three';

import { CHUNK_SIZE, SCATTER_COVER_DISTANCE_DEFAULT, TERRAIN_BLOCKS_BLEND_DEFAULT, coverScatterRules, scatterReach, splineScatterRect, terrainSplineInputs, type BlockChunk, type BlockLayerComponent, type BlockLayerData, type BlockType, type ScatterRect, type ScatterRule, type TerrainComponent, type TerrainTile } from '@thirdlight/runtime';

import type { MeshWorkerPort } from './block-mesh-pool';
import { CoverGenerator, type CoverCopies, type CoverReply, type CoverRequest, type CoverSpline } from './cover-worker';
import { buildInstanceSet, type BuiltInstanceSet, type InstanceSetStats } from './instancing';
import { blobCopies, blobShadowTemplate } from './scatter-shadows';
import type { LodTuning } from './lod-switch';
import type { CullView } from './view-cull';
import type { ModelInstance } from './visual';

/** The side (m) of the squares ground cover is made and drawn in. */
export const COVER_CELL_METRES = 32;
/** A square is kept until the camera is this much of a square farther than the reach (no churn at the edge). */
export const COVER_KEEP_FRACTION = 0.5;
/** Squares being made at once (the nearest first). */
export const COVER_JOBS = 2;
/** Main-thread time (ms) a frame may spend building squares (at least one a frame). */
export const COVER_BUILD_MS = 2;
/** Where a rule's copies begin to thin out, as a share of its reach. */
export const COVER_FADE_START = 0.6;
/** Cells round a changed block column whose footprint a terrain's cover reads (a larger block's reach and the corner it shares). */
const BLOCK_CHANGE_CELLS = 9;

export interface CoverViewDeps {
  /** A model instance to draw a rule's copies with (null while it loads; `onReady` then). */
  template(assetId: string, piece: string | undefined, onReady: () => void): ModelInstance | null;
  /** Dress a built set with the asset's materials; returns what takes them off. */
  dress?(root: THREE.Object3D, assetId: string): (() => void) | null;
  /** A drawn square enters or leaves the scene. */
  place(root: THREE.Object3D, shown: boolean): void;
  /** A terrain tile's decoded data by digest (the page's tile store), when decoded. */
  tile(digest: string): TerrainTile | undefined;
  /** Makes the worker (null, or absent: squares are made on the page). */
  worker?: () => MeshWorkerPort | null;
  tuning?: LodTuning;
  /** Something was built (a frame should be drawn). */
  changed?(): void;
}

export interface CoverViewDiagnostics {
  sources: number;
  /** Squares drawn, being made, and waiting for tiles or models. */
  cells: number;
  making: number;
  sets: number;
  copies: number;
  /** Squares made but not drawn yet (a model loading, or the frame's time spent). */
  waiting: number;
  /** Copies the squares held now hold, drawn or not. */
  madeCopies: number;
  /** Candidate places the generator looked at so far, and the terrain tiles handed to it. */
  looked: number;
  tilesSent: number;
  /** Squares made so far, their mean worker time (ms), the last frame's build time and the longest. */
  made: number;
  makeMsMean: number;
  buildMs: number;
  buildMsMax: number;
  instances: InstanceSetStats;
}

interface Square {
  readonly key: string;
  readonly rect: ScatterRect;
  /** The job making it (-1: made, or not asked yet). */
  job: number;
  made: readonly CoverCopies[] | null;
  built: boolean;
  root: THREE.Group | null;
  sets: { built: BuiltInstanceSet; rule: string; undress: (() => void) | null }[];
  shown: boolean;
}

interface Source {
  readonly id: string;
  kind: 'terrain' | 'blocks';
  rules: readonly ScatterRule[];
  rulesKey: string;
  origin: [number, number, number];
  hidden: boolean;
  /** World XZ box the source covers (squares outside it are not made). */
  extent: ScatterRect;
  terrain: TerrainComponent | null;
  readonly squares: Map<string, Square>;
  /** The farthest a rule reaches (m), and what a square reads past its own box (m). */
  reach: number;
  margin: number;
  /** A block layer's chunk width (m). */
  chunkMetres: number;
}

export class CoverView {
  private readonly sources = new Map<string, Source>();
  private port: MeshWorkerPort | null | undefined = undefined;
  private local: CoverGenerator | null = null;
  private readonly jobs = new Map<number, { src: Source; sq: Square }>();
  private readonly sentTiles = new Set<string>();
  private serial = 0;
  /** Every block layer handed over, and whether the generator holds it (a rules source, or one a terrain's blocks layer meets). */
  private readonly blockLayers = new Map<string, { component: BlockLayerComponent; origin: [number, number, number]; chunks: Map<string, BlockChunk>; sent: boolean }>();
  private made = 0;
  /** Candidate places the generator looked at so far. */
  private looked = 0;
  private makeMs = 0;
  private buildMs = 0;
  private buildMsMax = 0;
  private disposed = false;
  private types: readonly BlockType[] = [];
  /** The splines with a scatter band, by id: what each was (JSON) and the box its band keeps clear (null: none). */
  private splines = new Map<string, { key: string; rect: ScatterRect | null }>();

  constructor(private readonly deps: CoverViewDeps) {}

  // ---- the sources (ScatterSink) -----------------------------------------------------

  setTypes(types: readonly BlockType[]): void {
    this.types = types;
    this.send({ t: 'coverTypes', types });
    for (const src of this.sources.values()) if (src.kind === 'blocks') this.remakeAll(src);
  }

  /**
   * The splines whose scatter bands terrain cover keeps clear of (all of
   * them, each time any changes): the squares under the bands of those that
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
    if (same) return;
    this.send({ t: 'coverSplines', splines });
    for (const src of this.sources.values()) if (src.kind === 'terrain') for (const r of changed) this.remakeRect(src, r);
  }

  setBlockLayer(id: string, component: BlockLayerComponent, origin: readonly number[], chunks: Iterable<BlockChunk>): void {
    const rules = coverScatterRules(component.scatter);
    const b = component.bounds;
    const cs = component.cellSize;
    const o = [origin[0] ?? 0, origin[1] ?? 0, origin[2] ?? 0] as [number, number, number];
    const list = [...chunks];
    const held = { component, origin: o, chunks: new Map(list.map((c) => [`${c.cx},${c.cz}`, c])), sent: false };
    const was = this.blockLayers.get(id);
    this.blockLayers.set(id, held);
    const src = this.source(id, 'blocks', rules, o, [o[0] + b.min[0] * cs[0], o[2] + b.min[2] * cs[2], o[0] + b.max[0] * cs[0], o[2] + b.max[2] * cs[2]], Math.max(cs[0], cs[2]));
    if (src !== null) src.chunkMetres = CHUNK_SIZE * cs[0];
    // The generator holds it for its own rules, or for a terrain keeping its cover off it.
    if (src !== null || this.metBy(id).length > 0 || was?.sent === true) this.sendBlockLayer(id);
    if (src !== null) this.remakeAll(src);
    for (const t of this.metBy(id)) this.remakeAll(t);
  }

  /** The terrain sources (with cover rules) whose blocks layers meet block layer `id`. */
  private metBy(id: string): Source[] {
    const out: Source[] = [];
    for (const src of this.sources.values()) {
      if (src.kind !== 'terrain' || src.rules.length === 0) continue;
      if ((src.terrain?.layers ?? []).some((l) => l.kind === 'blocks' && l.enabled !== false && (l.blockLayers === undefined || l.blockLayers.includes(id)))) out.push(src);
    }
    return out;
  }

  /** Hand a block layer (as last given) to the generator. */
  private sendBlockLayer(id: string): void {
    const held = this.blockLayers.get(id);
    if (held === undefined) return;
    held.sent = true;
    const src = this.sources.get(id);
    const data: BlockLayerData = { entityId: id, chunks: [...held.chunks.values()] };
    this.send({ t: 'coverSource', id, source: { kind: 'blocks', component: held.component, origin: held.origin, rules: src?.kind === 'blocks' ? src.rules : [], data } });
  }

  /** The block layers terrain `src`'s blocks layers meet, handed to the generator (once). */
  private sendMet(src: Source): void {
    for (const [id, held] of this.blockLayers) if (!held.sent && this.metBy(id).includes(src)) this.sendBlockLayer(id);
  }

  replaceBlockChunks(id: string, chunks: readonly { cx: number; cz: number; chunk: BlockChunk | null }[]): void {
    const held = this.blockLayers.get(id);
    if (held !== undefined) {
      for (const c of chunks) {
        if (c.chunk === null) held.chunks.delete(`${c.cx},${c.cz}`);
        else held.chunks.set(`${c.cx},${c.cz}`, c.chunk);
      }
      if (held.sent) this.send({ t: 'coverChunks', id, chunks });
    }
    const src = this.sources.get(id);
    if (src !== undefined) {
      // The squares over the chunks (and the reach around them) are made again.
      const w = src.chunkMetres;
      for (const c of chunks) this.remakeRect(src, [src.origin[0] + c.cx * w, src.origin[2] + c.cz * w, src.origin[0] + (c.cx + 1) * w, src.origin[2] + (c.cz + 1) * w]);
    }
    if (held === undefined) return;
    // Terrains keeping their cover off the layer: their squares round the chunks (a footprint reaches a few cells past one).
    const [cw, , cd] = held.component.cellSize;
    const o = held.origin;
    for (const t of this.metBy(id)) {
      const blend = Math.max(...(t.terrain?.layers ?? []).map((l) => (l.kind === 'blocks' ? (l.blend ?? TERRAIN_BLOCKS_BLEND_DEFAULT) : 0)));
      for (const c of chunks) this.remakeRect(t, [o[0] + (c.cx * CHUNK_SIZE - BLOCK_CHANGE_CELLS) * cw - blend, o[2] + (c.cz * CHUNK_SIZE - BLOCK_CHANGE_CELLS) * cd - blend, o[0] + ((c.cx + 1) * CHUNK_SIZE + BLOCK_CHANGE_CELLS) * cw + blend, o[2] + ((c.cz + 1) * CHUNK_SIZE + BLOCK_CHANGE_CELLS) * cd + blend]);
    }
  }

  setTerrain(id: string, component: TerrainComponent, origin: readonly number[]): void {
    const rules = coverScatterRules(component.scatter);
    const size = (component.tileSamples - 1) * component.spacing;
    let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
    for (const t of component.tiles) {
      x0 = Math.min(x0, t.x);
      z0 = Math.min(z0, t.z);
      x1 = Math.max(x1, t.x + 1);
      z1 = Math.max(z1, t.z + 1);
    }
    const o = [origin[0] ?? 0, origin[1] ?? 0, origin[2] ?? 0] as [number, number, number];
    const before = this.sources.get(id)?.terrain ?? null;
    const src = this.source(id, 'terrain', rules, o, [o[0] + x0 * size, o[2] + z0 * size, o[0] + x1 * size, o[2] + z1 * size], component.spacing);
    if (src === null) return;
    src.terrain = component;
    this.send({ t: 'coverSource', id, source: { kind: 'terrain', component, origin: o, rules } });
    // Its blocks layers: the block layers they meet handed over; another set of them makes every square again.
    this.sendMet(src);
    const blocksOf = (c: TerrainComponent | null): string => JSON.stringify((c?.layers ?? []).filter((l) => l.kind === 'blocks'));
    if (before !== null && blocksOf(before) !== blocksOf(component)) {
      this.remakeAll(src);
      return;
    }
    // A tile whose data changed: the squares over it are made again.
    const old = new Map((before?.tiles ?? []).map((t) => [`${t.x},${t.z}`, t.data]));
    for (const t of component.tiles) {
      if (before !== null && old.get(`${t.x},${t.z}`) === t.data) continue;
      this.remakeRect(src, [o[0] + t.x * size, o[2] + t.z * size, o[0] + (t.x + 1) * size, o[2] + (t.z + 1) * size]);
    }
  }

  setOrigin(id: string, origin: readonly number[]): void {
    const held = this.blockLayers.get(id);
    if (held !== undefined && !held.origin.every((v, i) => v === (origin[i] ?? 0))) {
      held.origin = [origin[0] ?? 0, origin[1] ?? 0, origin[2] ?? 0];
      if (held.sent) this.sendBlockLayer(id);
      for (const t of this.metBy(id)) this.remakeAll(t);
    }
    const src = this.sources.get(id);
    if (src === undefined) return;
    if (src.origin.every((v, i) => v === (origin[i] ?? 0))) return;
    // Everything moves with the object: made again where it stands now (the rules read world positions).
    src.origin = [origin[0] ?? 0, origin[1] ?? 0, origin[2] ?? 0];
    this.remakeAll(src);
  }

  setHidden(id: string, hidden: boolean): void {
    const src = this.sources.get(id);
    if (src === undefined || src.hidden === hidden) return;
    src.hidden = hidden;
    for (const sq of src.squares.values()) this.show(sq, !hidden && sq.sets.length > 0);
  }

  remove(id: string): void {
    const held = this.blockLayers.get(id);
    if (held !== undefined) {
      const met = this.metBy(id);
      this.blockLayers.delete(id);
      if (held.sent && !this.sources.has(id)) this.send({ t: 'coverDrop', id });
      for (const t of met) this.remakeAll(t);
    }
    const src = this.sources.get(id);
    if (src === undefined) return;
    for (const sq of src.squares.values()) this.drop(sq);
    this.sources.delete(id);
    this.send({ t: 'coverDrop', id });
  }

  ids(): string[] {
    return [...this.sources.keys()];
  }

  // ---- the frame ------------------------------------------------------------------------

  /** Keep the squares around the view's eye: drop far ones, ask for near ones, build what arrived (call once a frame). */
  update(view: CullView): boolean {
    if (this.disposed || this.sources.size === 0) return false;
    const ex = view.eye[0]!;
    const ez = view.eye[2]!;
    const S = COVER_CELL_METRES;
    let built = false;
    const start = performance.now();
    for (const src of this.sources.values()) {
      if (src.rules.length === 0) continue;
      const keep = src.reach + S * COVER_KEEP_FRACTION;
      // Drop the squares the camera left (and any the source no longer covers).
      for (const sq of [...src.squares.values()]) {
        if (distToRect(ex, ez, sq.rect) <= keep && overlaps(sq.rect, src.extent)) continue;
        this.drop(sq);
        src.squares.delete(sq.key);
      }
      // The squares within reach (inside the source), nearest first.
      const want: { key: string; rect: ScatterRect; d: number }[] = [];
      const r = src.reach;
      for (let iz = Math.floor((ez - r) / S); iz <= Math.floor((ez + r) / S); iz++) {
        for (let ix = Math.floor((ex - r) / S); ix <= Math.floor((ex + r) / S); ix++) {
          const rect: ScatterRect = [ix * S, iz * S, (ix + 1) * S, (iz + 1) * S];
          const d = distToRect(ex, ez, rect);
          if (d > r || !overlaps(rect, src.extent)) continue;
          const key = `${ix},${iz}`;
          if (!src.squares.has(key)) src.squares.set(key, { key, rect, job: -1, made: null, built: false, root: null, sets: [], shown: false });
          const sq = src.squares.get(key)!;
          if (sq.made === null && sq.job < 0) want.push({ key, rect, d });
        }
      }
      want.sort((a, b) => a.d - b.d);
      for (const w of want) {
        if (this.jobs.size >= COVER_JOBS) break;
        this.ask(src, src.squares.get(w.key)!);
      }
      // Build what arrived (nearest first), within the frame's time.
      const ready = [...src.squares.values()].filter((sq) => sq.made !== null && !sq.built).sort((a, b) => distToRect(ex, ez, a.rect) - distToRect(ex, ez, b.rect));
      for (const sq of ready) {
        if (built && performance.now() - start > COVER_BUILD_MS) break;
        if (!this.build(src, sq)) continue;
        built = true;
      }
    }
    this.buildMs = performance.now() - start;
    if (built) {
      this.buildMsMax = Math.max(this.buildMsMax, this.buildMs);
      this.deps.changed?.();
    }
    if (this.jobs.size > 0) this.deps.changed?.();
    return built;
  }

  diagnostics(): CoverViewDiagnostics {
    let cells = 0;
    let waiting = 0;
    let madeCopies = 0;
    let sets = 0;
    let copies = 0;
    let inView = 0;
    let culled = 0;
    let thinned = 0;
    const byLevel: number[] = [];
    for (const src of this.sources.values()) {
      for (const sq of src.squares.values()) {
        if (sq.built) cells += 1;
        else if (sq.made !== null) waiting += 1;
        for (const m of sq.made ?? []) madeCopies += m.copies.length / 10;
        for (const s of sq.sets) {
          sets += 1;
          const st = s.built.stats();
          copies += st.copies;
          inView += st.inView;
          culled += st.culled;
          thinned += st.thinned;
          st.byLevel.forEach((v, l) => (byLevel[l] = (byLevel[l] ?? 0) + v));
        }
      }
    }
    const r2 = (v: number): number => Math.round(v * 100) / 100;
    return { sources: this.sources.size, cells, waiting, madeCopies, looked: this.looked, tilesSent: this.sentTiles.size, making: this.jobs.size, sets, copies, made: this.made, makeMsMean: this.made > 0 ? r2(this.makeMs / this.made) : 0, buildMs: r2(this.buildMs), buildMsMax: r2(this.buildMsMax), instances: { copies, inView, byLevel, culled, thinned } };
  }

  meshes(): THREE.Mesh[] {
    const out: THREE.Mesh[] = [];
    for (const src of this.sources.values()) for (const sq of src.squares.values()) for (const s of sq.sets) out.push(...s.built.meshes);
    return out;
  }

  dispose(): void {
    if (this.disposed) return;
    for (const id of [...this.sources.keys()]) this.remove(id);
    this.disposed = true;
    this.port?.terminate();
    this.port = null;
  }

  // ---- internals ------------------------------------------------------------------------

  private source(id: string, kind: Source['kind'], rules: readonly ScatterRule[], origin: [number, number, number], extent: ScatterRect, sample: number): Source | null {
    let src = this.sources.get(id);
    if (src === undefined && rules.length === 0) return null;
    const reach = Math.max(0, ...rules.map((r) => r.coverDistance ?? SCATTER_COVER_DISTANCE_DEFAULT));
    // A square reads the ground its rules reach past its box, and a sample for the normal.
    const margin = scatterReach(rules) + 2 * sample;
    const key = JSON.stringify(rules);
    if (src === undefined) {
      src = { id, kind, rules, rulesKey: key, origin, hidden: false, extent, terrain: null, squares: new Map(), reach, margin, chunkMetres: 0 };
      this.sources.set(id, src);
      if (kind === 'blocks' && this.types.length > 0) this.send({ t: 'coverTypes', types: this.types });
      return src;
    }
    const moved = !src.origin.every((v, i) => v === origin[i]);
    const changed = key !== src.rulesKey || moved;
    src.rules = rules;
    src.rulesKey = key;
    src.origin = origin;
    src.extent = extent;
    src.reach = reach;
    src.margin = margin;
    if (changed) this.remakeAll(src);
    return src;
  }

  /** Every square of a source is made again (its rules, origin or ground changed). */
  private remakeAll(src: Source): void {
    for (const sq of src.squares.values()) this.remake(sq);
    this.deps.changed?.();
  }

  /** The squares whose ground a changed world box reaches are made again. */
  private remakeRect(src: Source, rect: ScatterRect): void {
    const m = src.margin;
    const grown: ScatterRect = [rect[0] - m, rect[1] - m, rect[2] + m, rect[3] + m];
    for (const sq of src.squares.values()) if (overlaps(sq.rect, grown)) this.remake(sq);
    this.deps.changed?.();
  }

  /** A square is asked for again (an answer on the way is not wanted); its old copies stay drawn until the new ones are built. */
  private remake(sq: Square): void {
    if (sq.job >= 0) this.jobs.delete(sq.job);
    sq.job = -1;
    sq.made = null;
    sq.built = false;
  }

  private ask(src: Source, sq: Square): void {
    // A terrain's tiles under the square (and its margin) go to the generator first; one not decoded yet waits.
    if (src.kind === 'terrain' && src.terrain !== null) {
      const c = src.terrain;
      const size = (c.tileSamples - 1) * c.spacing;
      const m = src.margin;
      for (const t of c.tiles) {
        if (t.data === undefined) continue;
        const box: ScatterRect = [src.origin[0] + t.x * size, src.origin[2] + t.z * size, src.origin[0] + (t.x + 1) * size, src.origin[2] + (t.z + 1) * size];
        if (!overlaps(box, [sq.rect[0] - m, sq.rect[1] - m, sq.rect[2] + m, sq.rect[3] + m])) continue;
        if (this.sentTiles.has(t.data)) continue;
        const tile = this.deps.tile(t.data);
        if (tile === undefined) return;
        this.sentTiles.add(t.data);
        // A copy each (the page keeps its own arrays for drawing and collision).
        this.send({ t: 'coverTile', digest: t.data, tile: { samples: tile.samples, heights: tile.heights.slice(), weights: tile.weights?.slice() ?? null, holes: tile.holes?.slice() ?? null, paint: tile.paint?.slice() ?? null } });
      }
    }
    const job = ++this.serial;
    sq.job = job;
    this.jobs.set(job, { src, sq });
    this.send({ t: 'coverMake', job, id: src.id, rect: sq.rect });
  }

  private received(r: CoverReply): void {
    const j = this.jobs.get(r.job);
    if (j === undefined) return;
    this.jobs.delete(r.job);
    if (j.sq.job !== r.job || this.sources.get(j.src.id) !== j.src || j.src.squares.get(j.sq.key) !== j.sq) return;
    j.sq.job = -1;
    if (!r.ok) {
      console.warn(`ground cover: ${r.message}`);
      j.sq.made = [];
      return;
    }
    this.made += 1;
    this.makeMs += r.ms;
    if (r.looked !== undefined) this.looked = r.looked;
    j.sq.made = r.made;
    this.deps.changed?.();
  }

  /** Build a made square's sets (false: a model is still loading). */
  private build(src: Source, sq: Square): boolean {
    const made = sq.made!;
    const templates = made.map((m) => {
      const rule = src.rules.find((r) => r.id === m.rule);
      return rule === undefined ? null : { rule, template: this.deps.template(rule.asset.assetId, rule.asset.piece, () => this.deps.changed?.()) };
    });
    if (templates.some((t) => t !== null && t.template === null)) return false;
    // A square made again: its old copies give way to the new ones in the same frame.
    if (sq.sets.length > 0) {
      this.show(sq, false);
      this.dropSets(sq);
    }
    sq.root ??= new THREE.Group();
    sq.root.name = `cover:${src.id}:${sq.key}`;
    sq.root.position.set(...src.origin);
    made.forEach((m, k) => {
      const t = templates[k];
      if (t === null || t === undefined || t.template === null) return;
      const reach = t.rule.coverDistance ?? SCATTER_COVER_DISTANCE_DEFAULT;
      const built = buildInstanceSet(t.template, m.copies, m.copies.length / 10, `cover:${src.id}:${t.rule.id}`, {
        chunkSize: COVER_CELL_METRES,
        densityDistance: { start: reach * COVER_FADE_START, end: reach, min: t.rule.densityMin ?? 0 },
        lodPerCopy: t.rule.lodPerCopy ?? true,
        ...(this.deps.tuning !== undefined ? { tuning: this.deps.tuning } : {}),
      });
      for (const mesh of built.meshes) {
        mesh.castShadow = t.rule.castShadow === true;
        mesh.receiveShadow = true;
      }
      const undress = this.deps.dress?.(built.group, t.rule.asset.assetId) ?? null;
      sq.root!.add(built.group);
      sq.sets.push({ built, rule: t.rule.id, undress });
      if (t.rule.blobShadow !== undefined) {
        // A disc under each copy, thinning out with it.
        const blobs = buildInstanceSet(blobShadowTemplate(), blobCopies(m.copies, m.copies.length / 10, t.rule.blobShadow), m.copies.length / 10, `cover-blob:${src.id}:${t.rule.id}`, { chunkSize: COVER_CELL_METRES, densityDistance: { start: reach * COVER_FADE_START, end: reach, min: 0 }, ...(this.deps.tuning !== undefined ? { tuning: this.deps.tuning } : {}) });
        for (const mesh of blobs.meshes) {
          mesh.castShadow = false;
          mesh.receiveShadow = false;
        }
        sq.root!.add(blobs.group);
        sq.sets.push({ built: blobs, rule: t.rule.id, undress: null });
      }
    });
    sq.root.updateMatrixWorld(true);
    sq.built = true;
    this.show(sq, !src.hidden && sq.sets.length > 0);
    return true;
  }

  private show(sq: Square, on: boolean): void {
    if (sq.shown === on || sq.root === null) return;
    sq.shown = on;
    this.deps.place(sq.root, on);
  }

  private dropSets(sq: Square): void {
    for (const s of sq.sets) {
      s.built.dispose();
      s.undress?.();
    }
    sq.sets = [];
  }

  private drop(sq: Square): void {
    this.show(sq, false);
    this.dropSets(sq);
    sq.built = false;
    sq.made = null;
    if (sq.job >= 0) this.jobs.delete(sq.job);
    sq.job = -1;
  }

  /** A message to the generator: the worker's, else the page's own. */
  private send(m: CoverRequest): void {
    if (this.port === undefined) {
      this.port = this.deps.worker?.() ?? null;
      if (this.port !== null) {
        this.port.listen((raw) => {
          const r = raw as Partial<CoverReply> | null;
          if (r?.t === 'coverMade') this.received(r as CoverReply);
        });
        this.port.onError((message) => {
          console.warn(`ground cover worker: ${message}; made on the page instead`);
          this.port?.terminate();
          this.port = null;
          this.sentTiles.clear();
          for (const src of this.sources.values()) this.remakeAll(src);
        });
      }
    }
    if (this.port !== null) {
      this.port.post(m, m.t === 'coverTile' ? [m.tile.heights.buffer as ArrayBuffer, ...[m.tile.weights, m.tile.holes, m.tile.paint].flatMap((a) => (a !== null ? [a.buffer as ArrayBuffer] : []))] : undefined);
      return;
    }
    this.local ??= new CoverGenerator();
    if (m.t !== 'coverMake') {
      this.local.apply(m);
      return;
    }
    // On the page: made now (the next update builds it).
    const t0 = performance.now();
    const made = this.local.make(m.id, m.rect);
    const looked = this.local.looked;
    queueMicrotask(() => this.received({ t: 'coverMade', job: m.job, ok: true, made, ms: performance.now() - t0, looked }));
  }
}

function distToRect(x: number, z: number, r: ScatterRect): number {
  const dx = Math.max(r[0] - x, 0, x - r[2]);
  const dz = Math.max(r[1] - z, 0, z - r[3]);
  return Math.hypot(dx, dz);
}

const overlaps = (a: ScatterRect, b: ScatterRect): boolean => a[0] < b[2] && b[0] < a[2] && a[1] < b[3] && b[1] < a[3];
