/**
 * Drawing block layers — one merged mesh per block look and
 * material per chunk of 16 × 16 columns (a few draw calls per chunk), the
 * faces hidden by neighbours left out (the project-model mesher), each chunk
 * with its own bounds so three.js culls whole chunks outside the view. The
 * Play/export adapter and the editor's Scene view draw layers through this
 * one class, so they look the same.
 *
 * Looks: a variant with a colour is a stand-in shaped like the block's
 * collision shape (a Lambert material per colour, like a box); a model (or a
 * prefab's model) variant draws the model's LOD0 geometry, turned and placed
 * per cell, with its own materials (a material mapping applied by the host).
 * Model geometry arrives asynchronously: chunks re-mesh when it is ready.
 *
 * Meshing off the frame: with mesh workers (`meshWorkers`), loading a layer,
 * a block-type change, a model arriving, a lightmap layout change and edits
 * beyond the page's budget are meshed in the workers; a chunk keeps drawing
 * its old meshes until its new ones arrive, results are swapped in under a
 * time slice per frame, and a result for a chunk changed since is dropped. An
 * edit's chunks (an editor stroke, a script's grid write) mesh on the page
 * while their measured cost fits {@link SYNC_MESH_BUDGET_MS} in the frame, so
 * a small edit shows in the same frame. Without workers everything meshes on
 * the page, as `update` is called.
 *
 * Levels of detail: when a model look has coarser levels (`<piece>_LOD1..n`),
 * the chunk is meshed once per level and its model meshes go into one
 * `THREE.LOD` at the chunk's centre (each level shows every model at that
 * level, or its last), switching at the farthest of those models' own
 * distances plus the chunk's radius; stand-ins stay at full detail.
 *
 * Materials: a block type's material mapping (`materials`: a source material
 * name or "*" → a project material) applies to model looks and
 * to stand-ins too ("*": a stand-in has one material) — a painted terrain
 * material on plain sloped blocks.
 *
 * Tops: a layer's crease angle and top subdivision (`smoothAngle`,
 * `topSubdivision`) go to the mesher, so every level of detail is smoothed
 * and cut the same way; a change of either re-meshes the layer (it is a
 * component change).
 *
 * Paint: the chunks of a painted layer (or one with wall paint) carry its
 * paint as vertex colours — COLOR_0 the four layer weights, COLOR_1.r the
 * wetness (`chunkMeshPaint`, made with the meshing) — unless their material
 * draws vertex colours as a tint.
 *
 * Kits: a layer is meshed as its kits show it (`block-kit.ts`; the authored
 * `kits`, or the game's when a script changed them). A kit or block-type
 * change is a restyle: every chunk of the layers it touches re-meshes in the
 * workers, each drawing its old meshes until its new ones arrive, and the
 * cached static shadow is held (`restyling`) so it is drawn again once when
 * the last chunk is in, not once a frame. A restyle is timed (its frames over
 * a 60 Hz frame counted) for diagnostics and a `tl:blocks:restyle` mark.
 *
 * Baked lighting: the chunks of a layer a bake covers get lightmap UVs (one
 * square layout per chunk, `chunkLightmapLayout`), and the host puts each
 * chunk's lightmap on when the chunk's layout is the one the bake was made
 * for (a chunk changed since is drawn without it).
 */
import * as THREE from 'three';
import {
  BlockGrid,
  CHUNK_SIZE,
  blockKitView,
  kitKey,
  LIGHT_LAYERS_ALL,
  lightLayerMaskOf,
  type BlockChunk,
  type BlockGridReader,
  type BlockLayerComponent,
  type BlockLayerKit,
  type BlockLayerData,
  type BlockMeshSource,
  type BlockType,
  type ChunkMeshPart,
  type GridRenderChange,
} from '@thirdlight/runtime';

import { keepMetreUv, syncCellUv } from './block-cell-uv';
import { CUTAWAY_COPY_KEY, CutawayDrawing, splitByCutaway, type CutawayDiagnostics } from './block-cutaway-view';
import { chunkModelKey, meshChunkForDrawing, StandInShapes, variantModelOf, type ChunkLooks, type ChunkMeshResult, type ChunkModelRef } from './block-chunk-mesh';
import { MeshWorkerPool, meshWorkerCount, type MeshWorkerFactory } from './block-mesh-pool';
import type { MeshWorkerReply } from './block-mesh-worker';
import { LIGHT_LAYERS_KEY } from './light-layers';
import { currentLodLevel, LOD_CULL_LEVEL_KEY } from './lod-switch';

/**
 * An edit's chunks mesh on the page while their estimated cost (the layer's
 * measured time per chunk) fits in this many milliseconds a frame; beyond it
 * they go to the mesh workers. Chosen so a frame with an edit stays under a
 * 60 Hz frame on a laptop (the class frame is ~7 ms). Measured: a flat 16 × 16
 * chunk a few rows deep meshes in ~6 ms, a sloped one with smoothed,
 * subdivided tops in 20–80 ms; so a sparse chunk's edit shows in the same
 * frame, and an edit of terrain chunks shows when the worker answers (the
 * old meshes drawn until then; collision and grid queries are the
 * simulation's and update in the step either way).
 */
export const SYNC_MESH_BUDGET_MS = 8;
/** Finished worker results are turned into meshes for at most this long a frame (at least one a frame). */
export const MESH_APPLY_BUDGET_MS = 4;
/**
 * Chunks wait for the workers and none has answered for this long: the
 * workers are taken as hung and every chunk meshes on the page from then on.
 * Far above a busy queue's wait (a load of 64 sloped chunks on two workers:
 * ~2.5 s).
 */
export const MESH_WORKER_STALL_MS = 10_000;
/** A frame interval over this during a restyle counts as a long frame (a 60 Hz frame). */
export const RESTYLE_LONG_FRAME_MS = 1000 / 60;
/**
 * A restyle still meshing after this long lets the cached static shadow go
 * anyway (edits arriving all the while, a model that keeps loading): the
 * shadow is never held for more than a moment. Far above a whole layer's
 * restyle (~0.4 s for 49 chunks on two workers).
 */
export const RESTYLE_HOLD_MAX_MS = 5000;

/** A model look: its LOD0 geometry in the block frame and its materials (by the source's material index). */
export interface BlockModelLook {
  readonly source: BlockMeshSource;
  readonly materials: readonly THREE.Material[];
  /**
   * The model's coarser levels (`<piece>_LOD1..n`), each with the camera
   * distance it takes over at (the model's own switch distance); absent or
   * empty: one level. Their sources index the same `materials`.
   */
  readonly levels?: readonly { readonly source: BlockMeshSource; readonly distance: number }[];
}

export interface BlockLayerViewDeps {
  /**
   * The geometry of a model (asset, optional piece) — null while it loads
   * (`onReady` is called once when it is ready; the view re-meshes then) or
   * when it cannot be drawn.
   */
  modelLook?(assetId: string, piece: string | undefined, onReady: () => void): BlockModelLook | null;
  /** A prefab's model (its root entity's model), for a prefab variant. */
  prefabModel?(prefabId: string): { assetId: string; piece?: string } | null;
  /** Apply a block type's material mapping to a chunk mesh of a model look or (assetId null) a stand-in (the host's material library). */
  applyMaterials?(mesh: THREE.Mesh, type: BlockType, assetId: string | null): void;
  /** Whether a layer's chunks get lightmap UVs (a bake has lightmaps for them). */
  lightmapped?(entityId: string): boolean;
  /** A chunk was (re)built with lightmap UVs: its group and its layout digest (the host puts the lightmap on). */
  chunkBuilt?(entityId: string, cx: number, cz: number, group: THREE.Group, layout: string): void;
  /** A chunk with lightmap UVs goes away (rebuilt or removed). */
  chunkDropped?(entityId: string, cx: number, cz: number): void;
  /**
   * A chunk was built (`shown`) or is going: a host that draws a flat scene
   * lists its drawables (the chunk's children, world matrices current) itself
   * and leaves {@link BlockLayerView.root} out of its scene.
   */
  place?(chunk: THREE.Group, shown: boolean): void;
  /** Makes a mesh worker (absent, or null from it: chunks mesh on the page). */
  meshWorkers?: MeshWorkerFactory;
  /** Worker results wait to be swapped in: a host that draws on demand draws again (the next `update` takes them). */
  meshed?(): void;
  /** Logical cores (sizes the worker pool; default `navigator.hardwareConcurrency`). */
  cores?: number;
  /** The clock a stalled worker is measured on (ms; default `performance.now`; tests). */
  now?: () => number;
  /** Compile an object's pipelines in the background (a cut-away's fade copy, before its first fade). */
  precompile?(object: THREE.Object3D): void;
  /** A restyle began (true) or its last chunk is in (false): the host holds its cached static shadow meanwhile. */
  restyling?(on: boolean): void;
}

/** A restyle's timing: how long its chunks took to arrive and the frames drawn meanwhile. */
export interface BlockRestyleTiming {
  /** From the change to the last chunk in (ms). */
  ms: number;
  /** Chunks re-meshed. */
  chunks: number;
  /** Frames drawn meanwhile, those longer than {@link RESTYLE_LONG_FRAME_MS}, and the longest (ms). */
  frames: number;
  longFrames: number;
  longestFrameMs: number;
  /** Which frame was the longest (1: the first after the change), and the longest the view's own update took meanwhile (ms). */
  longestFrameAt: number;
  longestUpdateMs: number;
}

/** A chunk's lightmap target: its meshes with UV1 and the layout they follow. */
export interface BlockChunkLightmapTarget {
  cx: number;
  cz: number;
  layout: string;
  /** Surface area in square metres. */
  area: number;
  /** Slots per side of the chunk's square layout (one slot per cell face direction). */
  side: number;
  /** The meshes at full detail (what a bake renders). */
  meshes: THREE.Mesh[];
  /** The meshes of coarser levels of detail (they read the same lightmap). */
  coarse: THREE.Mesh[];
}

interface LayerState {
  readonly group: THREE.Group;
  component: BlockLayerComponent;
  grid: BlockGrid;
  /** The kits a script set (null: the component's). */
  gameKits: readonly BlockLayerKit[] | null;
  /** The grid as its kits show it (`grid` itself without one): what it is meshed from. */
  view: BlockGridReader;
  /** This version of the layer's cells (a worker's result for an older one is dropped). */
  serial: number;
  readonly chunks: Map<string, THREE.Group>;
  readonly dirty: Set<string>;
  /** Dirty chunks whose change was an edit (they may mesh on the page within the budget). */
  readonly edited: Set<string>;
  /** Each chunk's generation: bumped whenever it is meshed or sent to be meshed. */
  readonly gens: Map<string, number>;
  /** Chunks a worker is meshing, by the generation asked for. */
  readonly pending: Map<string, number>;
  /** The measured cost of meshing one of its chunks (ms, a running average; -1: not measured yet). */
  meshMs: number;
  /** How many of its palette's cells have had their models asked for (a worker gets a model before its chunks). */
  looksAsked: number;
  /** Chunks built with lightmap UVs: their layout digest, area and slots per side. */
  readonly lightmapLayouts: Map<string, { layout: string; area: number; side: number }>;
  /** Its object is hidden (inactive): its chunks are built but not placed in the scene. */
  hidden: boolean;
}

export interface BlockLayerViewDiagnostics {
  layers: number;
  chunks: number;
  /** Meshes and triangles at full detail. */
  meshes: number;
  triangles: number;
  /** Chunks with levels of detail, and how many show each level now (index = level). */
  lods?: { chunks: number; shown: number[] };
  /** Meshing: where chunks were meshed, what waits, and the page's time spent on it. */
  meshing: {
    /** Mesh workers running (0: everything meshes on the page). */
    workers: number;
    /** Chunks sent to the workers and not back yet (the queue). */
    queued: number;
    /** Chunks meshed on the page, and in the workers (applied), since the view was made. */
    meshedHere: number;
    meshedInWorkers: number;
    /** Chunks meshed on the page or swapped in from the workers in the last update. */
    lastUpdate: { here: number; applied: number; ms: number };
    /** The longest the page spent meshing and building chunks in one update (ms). */
    longestUpdateMs: number;
    /** The slowest layer's measured time to mesh one chunk (ms; -1 before any). */
    chunkMs: number;
  };
  /** The layers' cut-away zones (absent: no layer has any). */
  cutaway?: CutawayDiagnostics;
  /** Restyles (kit or block-type changes): how many, whether one is under way, and the last one's timing. */
  restyles?: { count: number; active: boolean; last: BlockRestyleTiming | null };
}

/**
 * A model's meshes merged into one block look (positions in the model root's
 * frame): its most detailed level, and each coarser level of its LOD groups
 * (a group with fewer levels keeps its last one; meshes outside any group are
 * in every level) with the farthest switch distance of the groups at that
 * level.
 */
export function blockLookFromObject(root: THREE.Object3D): BlockModelLook | null {
  root.updateMatrixWorld(true);
  const inv = new THREE.Matrix4().copy(root.matrixWorld).invert();
  const lods: THREE.LOD[] = [];
  const meshesAt = (level: number): THREE.Mesh[] => {
    const meshes: THREE.Mesh[] = [];
    const visit = (o: THREE.Object3D): void => {
      if ((o as THREE.LOD).isLOD === true) {
        const lod = o as THREE.LOD;
        const shown = drawnLevels(lod);
        if (level === 0 && shown.length > 1) lods.push(lod);
        const pick = shown[Math.min(level, shown.length - 1)]?.object;
        if (pick !== undefined) visit(pick);
        return;
      }
      if ((o as THREE.Mesh).isMesh === true && (o as THREE.SkinnedMesh).isSkinnedMesh !== true) meshes.push(o as THREE.Mesh);
      for (const c of o.children) visit(c);
    };
    visit(root);
    return meshes;
  };
  const first = meshesAt(0);
  if (first.length === 0) return null;
  const count = Math.max(1, ...lods.map((l) => drawnLevels(l).length));
  const materials: THREE.Material[] = [];
  const matIndex = new Map<THREE.Material, number>();
  const sources: BlockMeshSource[] = [mergeMeshes(first, inv, materials, matIndex)];
  const levels: { source: BlockMeshSource; distance: number }[] = [];
  for (let level = 1; level < count; level++) {
    const distance = Math.max(...lods.filter((l) => drawnLevels(l).length > level).map((l) => l.levels[level]!.distance));
    const source = mergeMeshes(meshesAt(level), inv, materials, matIndex);
    sources.push(source);
    levels.push({ source, distance });
  }
  return { source: sources[0]!, materials, ...(levels.length > 0 ? { levels } : {}) };
}

/** A LOD's levels that draw something: a chunk holds many models, so a model's cull size never empties one. */
function drawnLevels(lod: THREE.LOD): THREE.LOD['levels'] {
  const last = lod.levels[lod.levels.length - 1];
  return last !== undefined && last.object.userData[LOD_CULL_LEVEL_KEY] === true ? lod.levels.slice(0, -1) : lod.levels;
}

/** Merge meshes into one indexed source in `inv`'s frame, grouped by material (indices into `materials`, shared across calls). */
function mergeMeshes(meshes: readonly THREE.Mesh[], inv: THREE.Matrix4, materials: THREE.Material[], matIndex: Map<THREE.Material, number>): BlockMeshSource {
  const positions: number[] = [];
  const normals: number[] = [];
  const uvs: number[] = [];
  const byMaterial = new Map<number, number[]>();
  const m = new THREE.Matrix4();
  const nm = new THREE.Matrix3();
  const v = new THREE.Vector3();
  for (const mesh of meshes) {
    const g = mesh.geometry as THREE.BufferGeometry;
    const pos = g.getAttribute('position');
    if (pos === undefined) continue;
    const nor = g.getAttribute('normal');
    const uv = g.getAttribute('uv');
    m.multiplyMatrices(inv, mesh.matrixWorld);
    nm.getNormalMatrix(m);
    const base = positions.length / 3;
    for (let i = 0; i < pos.count; i++) {
      v.fromBufferAttribute(pos, i).applyMatrix4(m);
      positions.push(v.x, v.y, v.z);
      if (nor !== undefined) {
        v.fromBufferAttribute(nor, i).applyMatrix3(nm).normalize();
        normals.push(v.x, v.y, v.z);
      } else normals.push(0, 1, 0);
      // A piece without texture coordinates gets world ones from the mesher (NaN marks them).
      if (uv !== undefined) uvs.push(uv.getX(i), uv.getY(i));
      else uvs.push(NaN, NaN);
    }
    const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    const index = g.getIndex();
    const indexAt = (i: number): number => (index !== null ? index.getX(i) : i);
    const count = index !== null ? index.count : pos.count;
    const groups = g.groups.length > 0 ? g.groups : [{ start: 0, count, materialIndex: 0 }];
    for (const grp of groups) {
      const mat = mats[grp.materialIndex ?? 0] ?? mats[0]!;
      let mi = matIndex.get(mat);
      if (mi === undefined) {
        mi = materials.length;
        matIndex.set(mat, mi);
        materials.push(mat);
      }
      let list = byMaterial.get(mi);
      if (list === undefined) byMaterial.set(mi, (list = []));
      for (let i = grp.start; i < Math.min(grp.start + grp.count, count); i++) list.push(base + indexAt(i));
    }
  }
  const indices: number[] = [];
  const groups: BlockMeshSource['groups'] = [];
  for (const [material, list] of [...byMaterial.entries()].sort(([a], [b]) => a - b)) {
    groups.push({ start: indices.length, count: list.length, material });
    indices.push(...list);
  }
  return { positions: new Float32Array(positions), normals: new Float32Array(normals), uvs: new Float32Array(uvs), indices: new Uint32Array(indices), groups };
}

/** Marks a chunk mesh of a coarser level of detail (its level): bakes, picks and counts use the detailed ones. */
const COARSE_LEVEL = 'tlBlockLodLevel';

/** A chunk's meshes at full detail (the always-drawn ones and its detailed level; not a cut-away's fading copies). */
function detailedMeshes(group: THREE.Object3D): THREE.Mesh[] {
  const out: THREE.Mesh[] = [];
  group.traverse((o) => {
    const m = o as THREE.Mesh;
    if (m.isMesh === true && m.userData[COARSE_LEVEL] === undefined && m.userData[CUTAWAY_COPY_KEY] !== true) out.push(m);
  });
  return out;
}

export class BlockLayerView {
  readonly root = new THREE.Group();
  private readonly deps: BlockLayerViewDeps;
  private types = new Map<string, BlockType>();
  private readonly layers = new Map<string, LayerState>();
  private readonly standIns = new StandInShapes();
  private readonly colorMaterials = new Map<string, THREE.MeshLambertMaterial>();
  /** Layers whose chunks get lightmap UVs whatever the host says (a bake in progress). */
  private readonly forcedUv = new Set<string>();
  /** The model looks found so far (their geometry is in the workers too). */
  private readonly modelLooks = new Map<string, BlockModelLook>();
  /** The layer being meshed on the page (a model it asks for re-meshes it when the model is ready). */
  private meshingLayer: string | null = null;
  private readonly pageLooks: ChunkLooks = {
    variantModel: (type, variant) => variantModelOf(type, variant, (id) => this.deps.prefabModel?.(id) ?? null),
    model: (ref) => this.modelLook(ref, this.meshingLayer),
  };
  private pool: MeshWorkerPool | null = null;
  /** No workers here (none given, or they failed): everything meshes on the page. */
  private poolUnavailable: boolean;
  /** Worker results waiting to be swapped in. */
  private readonly results: MeshWorkerReply[] = [];
  /** When the workers last showed life (an answer, or the first request after none was waiting). */
  private workersHeardAt = 0;
  /** `flush`: every changed chunk meshes on the page this update, the workers told to drop theirs. */
  private meshAllHere = false;
  private serials = 0;
  /** The layers' cut-away zones: which chunk meshes they hold and how far each is faded. */
  private readonly cut: CutawayDrawing;
  private readonly stats = { meshedHere: 0, meshedInWorkers: 0, lastUpdate: { here: 0, applied: 0, ms: 0 }, longestUpdateMs: 0 };
  /** The restyle under way (null: none): when it began, its chunks, the last update's time and its frames. */
  private restyle: { startedAt: number; chunks: number; lastFrameAt: number; frames: number; longFrames: number; longestFrameMs: number; longestFrameAt: number; longestUpdateMs: number } | null = null;
  private restyles = { count: 0, last: null as BlockRestyleTiming | null };
  private disposed = false;

  constructor(deps: BlockLayerViewDeps = {}) {
    this.deps = deps;
    this.root.name = 'block-layers';
    this.poolUnavailable = deps.meshWorkers === undefined;
    this.cut = new CutawayDrawing(deps.precompile !== undefined ? { precompile: (o) => deps.precompile!(o) } : {});
  }

  /** The block types (every chunk re-meshes when they change). */
  setTypes(types: readonly BlockType[]): void {
    const next = new Map(types.map((t) => [t.blockId, t]));
    if (JSON.stringify([...next.entries()]) === JSON.stringify([...this.types.entries()])) return;
    this.types = next;
    this.sendTypes();
    for (const layer of this.layers.values()) {
      layer.looksAsked = 0;
      layer.view = blockKitView(layer.grid, this.kitsOf(layer), this.types);
    }
    for (const layer of this.layers.values()) this.restyleLayer(layer);
  }

  /**
   * The kits a game's scripts set for a layer (null: back to the
   * component's): the layer re-meshes in the background if what it shows
   * changes.
   */
  setGameKits(entityId: string, kits: readonly BlockLayerKit[] | null): void {
    const layer = this.layers.get(entityId);
    if (layer === undefined) return;
    const before = kitKey(this.kitsOf(layer));
    layer.gameKits = kits;
    const now = this.kitsOf(layer);
    if (kitKey(now) === before) return;
    layer.view = blockKitView(layer.grid, now, this.types);
    if (layer.component.metadataOnly !== true) this.pool?.broadcast({ t: 'kits', entityId, kits: [...(now ?? [])] });
    this.restyleLayer(layer);
  }

  /** The kits a layer shows: the game's, else its component's. */
  private kitsOf(layer: Pick<LayerState, 'gameKits' | 'component'>): readonly BlockLayerKit[] | undefined {
    return layer.gameKits ?? layer.component.kits;
  }

  /** Every chunk of a layer re-meshes in the background (not as an edit): a restyle begins, or takes these chunks in. */
  private restyleLayer(layer: LayerState): void {
    const keys = new Set([...layer.grid.chunkKeys(), ...layer.chunks.keys()]);
    if (keys.size === 0) return;
    for (const ck of keys) layer.dirty.add(ck);
    // Only what is already drawn is restyled (a layer's first meshing is its load, not a restyle).
    if (layer.chunks.size === 0) return;
    if (this.restyle === null) {
      const now = performance.now();
      this.restyle = { startedAt: now, chunks: 0, lastFrameAt: now, frames: 0, longFrames: 0, longestFrameMs: 0, longestFrameAt: 0, longestUpdateMs: 0 };
      this.deps.restyling?.(true);
    }
    this.restyle.chunks += keys.size;
  }

  /** The restyle is done once nothing waits to be meshed or swapped in: timed, marked, and the shadow let go. */
  private followRestyle(updateStartedAt: number): void {
    const r = this.restyle;
    if (r === null) return;
    const now = performance.now();
    const frame = now - r.lastFrameAt;
    r.lastFrameAt = now;
    r.frames += 1;
    if (frame > RESTYLE_LONG_FRAME_MS) r.longFrames += 1;
    if (frame > r.longestFrameMs) {
      r.longestFrameMs = frame;
      r.longestFrameAt = r.frames;
    }
    r.longestUpdateMs = Math.max(r.longestUpdateMs, now - updateStartedAt);
    if (now - r.startedAt < RESTYLE_HOLD_MAX_MS) {
      if (this.results.length > 0) return;
      for (const layer of this.layers.values()) if (layer.dirty.size > 0 || layer.pending.size > 0) return;
    }
    this.endRestyle(now);
  }

  private endRestyle(now: number): void {
    const r = this.restyle;
    if (r === null) return;
    this.restyle = null;
    const round = (v: number): number => Math.round(v * 10) / 10;
    const timing: BlockRestyleTiming = { ms: round(now - r.startedAt), chunks: r.chunks, frames: r.frames, longFrames: r.longFrames, longestFrameMs: round(r.longestFrameMs), longestFrameAt: r.longestFrameAt, longestUpdateMs: round(r.longestUpdateMs) };
    this.restyles = { count: this.restyles.count + 1, last: timing };
    globalThis.performance?.mark?.('tl:blocks:restyle', { detail: timing });
    this.deps.restyling?.(false);
  }

  /** Show (or replace) a layer: its component, origin and stored cells. */
  setLayer(entityId: string, component: BlockLayerComponent, origin: readonly number[], data: BlockLayerData | null): void {
    let layer = this.layers.get(entityId);
    if (layer === undefined) {
      const group = new THREE.Group();
      group.name = `block-layer:${entityId}`;
      this.root.add(group);
      const grid = BlockGrid.from(component, data);
      layer = { group, component, grid, gameKits: null, view: blockKitView(grid, component.kits, this.types), serial: ++this.serials, chunks: new Map(), dirty: new Set(), edited: new Set(), gens: new Map(), pending: new Map(), meshMs: -1, looksAsked: 0, lightmapLayouts: new Map(), hidden: false };
      this.layers.set(entityId, layer);
    } else {
      // Another kit on drawn chunks is a restyle (the shadow held until they are in).
      if (kitKey(this.kitsOf(layer)) !== kitKey(layer.gameKits ?? component.kits)) this.restyleLayer(layer);
      layer.component = component;
      layer.grid = BlockGrid.from(component, data);
      layer.view = blockKitView(layer.grid, this.kitsOf(layer), this.types);
      layer.serial = ++this.serials;
      layer.looksAsked = 0;
      // Whatever a worker was meshing was for the cells replaced here: it is asked again.
      for (const ck of layer.pending.keys()) layer.dirty.add(ck);
      layer.pending.clear();
    }
    layer.group.position.set(origin[0] ?? 0, origin[1] ?? 0, origin[2] ?? 0);
    layer.group.updateMatrixWorld(true);
    // Its cut-away zones (the chunks are split by them when they are meshed again, below).
    this.cut.setLayer(entityId, component, layer.grid.regions, origin);
    for (const ck of layer.grid.chunkKeys()) layer.dirty.add(ck);
    for (const ck of layer.chunks.keys()) layer.dirty.add(ck);
    // The workers mesh with the kits it shows (the game's, when a script set them).
    if (component.metadataOnly !== true && this.startPool()) this.pool!.broadcast({ t: 'layer', entityId, serial: layer.serial, component: layer.gameKits === null ? component : { ...component, kits: [...layer.gameKits] }, data });
  }

  /** Move a layer (its entity moved in the editor). */
  setOrigin(entityId: string, origin: readonly number[]): void {
    const layer = this.layers.get(entityId);
    if (layer === undefined) return;
    const g = layer.group.position;
    if (g.x === (origin[0] ?? 0) && g.y === (origin[1] ?? 0) && g.z === (origin[2] ?? 0)) return;
    // A placed chunk's world matrices are taken as they are when it is placed: it is placed again where it is now.
    for (const chunk of layer.chunks.values()) this.deps.place?.(chunk, false);
    g.set(origin[0] ?? 0, origin[1] ?? 0, origin[2] ?? 0);
    layer.group.updateMatrixWorld(true);
    this.cut.setOrigin(entityId, origin);
    if (!layer.hidden) for (const chunk of layer.chunks.values()) this.deps.place?.(chunk, true);
  }

  /** Hide or show a layer (its object is inactive or hidden): its chunks leave the scene or come back. */
  setHidden(entityId: string, hidden: boolean): void {
    const layer = this.layers.get(entityId);
    if (layer === undefined || layer.hidden === hidden) return;
    layer.hidden = hidden;
    layer.group.visible = !hidden;
    for (const chunk of layer.chunks.values()) this.deps.place?.(chunk, !hidden);
  }

  hasLayer(entityId: string): boolean {
    return this.layers.has(entityId);
  }

  layerIds(): string[] {
    return [...this.layers.keys()];
  }

  /** Replace some chunks of a layer (stored form; null empties one) and re-mesh them and their neighbours (an edit). */
  replaceChunks(entityId: string, chunks: readonly { cx: number; cz: number; chunk: BlockChunk | null }[]): void {
    const layer = this.layers.get(entityId);
    if (layer === undefined) return;
    const painted = layer.grid.hasPaint();
    for (const c of chunks) layer.grid.replaceChunk(c.cx, c.cz, c.chunk);
    if (this.pool !== null && layer.component.metadataOnly !== true) this.pool.broadcast({ t: 'chunks', entityId, chunks: chunks.map((c) => ({ cx: c.cx, cz: c.cz, chunk: c.chunk })) });
    for (const k of layer.grid.takeDirty().mesh) {
      layer.dirty.add(k);
      layer.edited.add(k);
      // A worker's answer for the cells before this edit is not wanted (it would show before the edit's own).
      this.cancelPending(entityId, layer, k);
    }
    // The first paint (or the last one gone) changes every chunk's colours.
    if (layer.grid.hasPaint() !== painted) for (const k of layer.chunks.keys()) layer.dirty.add(k);
  }

  /** The simulation's chunk changes (the runtime's `takeGridChanges`). */
  applyRuntimeChanges(changes: readonly GridRenderChange[]): void {
    const byLayer = new Map<string, { cx: number; cz: number; chunk: BlockChunk | null }[]>();
    // A layer's kits first: its chunks are meshed with them.
    for (const c of changes) if ('kits' in c) this.setGameKits(c.entityId, c.kits);
    for (const c of changes) {
      if ('kits' in c) continue;
      let list = byLayer.get(c.entityId);
      if (list === undefined) byLayer.set(c.entityId, (list = []));
      list.push(c);
    }
    for (const [id, list] of byLayer) this.replaceChunks(id, list);
  }

  removeLayer(entityId: string): void {
    const layer = this.layers.get(entityId);
    if (layer === undefined) return;
    for (const [ck, g] of layer.chunks) this.dropChunk(entityId, layer, ck, g);
    this.cut.removeLayer(entityId);
    layer.group.removeFromParent();
    this.layers.delete(entityId);
    this.pool?.broadcast({ t: 'drop', entityId });
  }

  /**
   * Re-mesh the chunks that changed: swap in what the workers finished (within
   * a time slice), mesh an edit's chunks here while they fit the budget, and
   * send the rest to the workers. Returns whether any chunk was rebuilt.
   */
  update(): boolean {
    if (this.disposed) return false;
    const t0 = performance.now();
    this.checkStall();
    let applied = 0;
    while (this.results.length > 0 && (applied === 0 || performance.now() - t0 < MESH_APPLY_BUDGET_MS)) {
      if (this.applyResult(this.results.shift()!)) applied += 1;
    }
    let here = 0;
    let syncMs = 0;
    for (const [entityId, layer] of this.layers) {
      if (layer.dirty.size === 0) continue;
      const keys = [...layer.dirty];
      layer.dirty.clear();
      for (const ck of keys) {
        const edited = layer.edited.has(ck);
        const estimate = Math.max(0, layer.meshMs);
        if (this.pool === null || this.meshAllHere || layer.component.metadataOnly === true || (edited && syncMs + estimate <= SYNC_MESH_BUDGET_MS)) {
          const t = performance.now();
          this.meshHere(entityId, layer, ck);
          syncMs += performance.now() - t;
          here += 1;
        } else this.request(entityId, layer, ck);
      }
      layer.edited.clear();
    }
    // More results than one frame's slice: the host draws again for the rest.
    if (this.results.length > 0) this.deps.meshed?.();
    this.followRestyle(t0);
    const ms = performance.now() - t0;
    this.stats.lastUpdate = { here, applied, ms };
    this.stats.meshedHere += here;
    this.stats.meshedInWorkers += applied;
    if (here + applied > 0) this.stats.longestUpdateMs = Math.max(this.stats.longestUpdateMs, ms);
    return here + applied > 0;
  }

  /**
   * Mesh every changed chunk now, on the page, including those a worker is
   * still meshing (a bake reads the chunks right after).
   */
  flush(): void {
    for (const layer of this.layers.values()) for (const ck of layer.pending.keys()) layer.dirty.add(ck);
    this.meshAllHere = true;
    try {
      this.update();
    } finally {
      this.meshAllHere = false;
    }
  }

  diagnostics(): BlockLayerViewDiagnostics {
    let chunks = 0;
    let meshes = 0;
    let triangles = 0;
    let lodChunks = 0;
    let queued = 0;
    let chunkMs = -1;
    const shown: number[] = [];
    for (const layer of this.layers.values()) {
      chunks += layer.chunks.size;
      queued += layer.pending.size;
      chunkMs = Math.max(chunkMs, layer.meshMs);
      for (const g of layer.chunks.values()) {
        for (const mesh of detailedMeshes(g)) {
          meshes += 1;
          const index = (mesh.geometry as THREE.BufferGeometry).getIndex();
          triangles += index !== null ? index.count / 3 : 0;
        }
        for (const c of g.children) {
          const lod = c as THREE.LOD;
          if (lod.isLOD !== true) continue;
          lodChunks += 1;
          const level = currentLodLevel(lod);
          while (shown.length <= level) shown.push(0);
          shown[level] = shown[level]! + 1;
        }
      }
    }
    const round = (v: number): number => Math.round(v * 100) / 100;
    const meshing = { workers: this.pool?.size ?? 0, queued, meshedHere: this.stats.meshedHere, meshedInWorkers: this.stats.meshedInWorkers, lastUpdate: { ...this.stats.lastUpdate, ms: round(this.stats.lastUpdate.ms) }, longestUpdateMs: round(this.stats.longestUpdateMs), chunkMs: chunkMs < 0 ? -1 : round(chunkMs) };
    const cutaway = this.cut.diagnostics();
    const restyles = this.restyles.count > 0 || this.restyle !== null ? { restyles: { count: this.restyles.count, active: this.restyle !== null, last: this.restyles.last } } : {};
    return { layers: this.layers.size, chunks, meshes, triangles, ...(lodChunks > 0 ? { lods: { chunks: lodChunks, shown } } : {}), meshing, ...(cutaway !== null ? { cutaway } : {}), ...restyles };
  }

  /** Whether any layer has cut-away zones (the host finds the subject only then). */
  hasCutaways(): boolean {
    return this.cut.any();
  }

  /**
   * Force a layer's cut-away zone hidden or shown, or give it back to the
   * subject (null) — the host's own forcing (an editor's preview), over the
   * game's. False: no such zone.
   */
  setCutaway(entityId: string, zone: string, cut: boolean | null): boolean {
    return this.cut.force(entityId, zone, cut);
  }

  /** The zones the game's scripts force (the runtime's whole list). */
  setGameCutaways(forced: readonly (readonly [string, string, boolean])[]): void {
    this.cut.setGameForced(forced);
  }

  /** Follow the subject (a world point; null: none) for `dt` seconds; whether a zone is still fading (draw again). */
  updateCutaways(dt: number, subject: THREE.Vector3 | null): boolean {
    return this.cut.update(dt, subject);
  }

  /**
   * Build lightmap UVs for a layer's chunks (for a bake) — also where the
   * host does not want them otherwise — until turned off again. The chunks
   * re-mesh at the next `update` (`flush` to have them at once).
   */
  setLightmapUv(entityId: string, on: boolean): void {
    if (on === this.forcedUv.has(entityId)) return;
    if (on) this.forcedUv.add(entityId);
    else this.forcedUv.delete(entityId);
    const layer = this.layers.get(entityId);
    if (layer !== undefined) for (const ck of layer.chunks.keys()) layer.dirty.add(ck);
  }

  /** Re-mesh every chunk at the next `update` (the bakes changed: each chunk takes its lightmap again). */
  remeshAll(): void {
    for (const layer of this.layers.values()) for (const ck of layer.chunks.keys()) layer.dirty.add(ck);
  }

  /** A layer's chunks with lightmap UVs (their meshes, layout digest and area), in chunk order. */
  lightmapTargets(entityId: string): BlockChunkLightmapTarget[] {
    const layer = this.layers.get(entityId);
    if (layer === undefined) return [];
    const out: BlockChunkLightmapTarget[] = [];
    for (const [ck, g] of [...layer.chunks].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
      const lm = layer.lightmapLayouts.get(ck);
      if (lm === undefined) continue;
      const [cx, cz] = ck.split(',').map(Number) as [number, number];
      const meshes = detailedMeshes(g).filter((m) => m.geometry.getAttribute('uv1') !== undefined);
      const coarse: THREE.Mesh[] = [];
      g.traverse((o) => ((o as THREE.Mesh).isMesh === true && o.userData[COARSE_LEVEL] !== undefined && o.userData[CUTAWAY_COPY_KEY] !== true ? coarse.push(o as THREE.Mesh) : undefined));
      out.push({ cx, cz, layout: lm.layout, area: lm.area, side: lm.side, meshes, coarse });
    }
    return out;
  }

  /** One layer's chunk meshes (what a pointer ray hits of it). */
  layerMeshes(entityId: string): THREE.Mesh[] {
    const layer = this.layers.get(entityId);
    const out: THREE.Mesh[] = [];
    if (layer !== undefined) for (const g of layer.chunks.values()) out.push(...detailedMeshes(g));
    return out;
  }

  /** The chunk meshes (static geometry) — e.g. occluders for a light bake. */
  meshes(): THREE.Mesh[] {
    const out: THREE.Mesh[] = [];
    for (const layer of this.layers.values()) for (const g of layer.chunks.values()) out.push(...detailedMeshes(g));
    return out;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.pool?.dispose();
    this.pool = null;
    this.results.length = 0;
    for (const id of [...this.layers.keys()]) this.removeLayer(id);
    if (this.restyle !== null) {
      this.restyle = null;
      this.deps.restyling?.(false);
    }
    this.cut.dispose();
    for (const m of this.colorMaterials.values()) m.dispose();
    this.colorMaterials.clear();
    this.root.removeFromParent();
  }

  // ---- internals ---------------------------------------------------------------------

  /** Start the workers on first use; whether there are any. */
  private startPool(): boolean {
    if (this.pool !== null) return true;
    if (this.poolUnavailable || this.disposed) return false;
    const create = this.deps.meshWorkers!;
    const cores = this.deps.cores ?? (globalThis as { navigator?: { hardwareConcurrency?: number } }).navigator?.hardwareConcurrency;
    this.pool = MeshWorkerPool.start(
      create,
      meshWorkerCount(cores),
      (reply) => {
        this.workersHeardAt = this.now();
        this.results.push(reply);
        if (this.results.length === 1) this.deps.meshed?.();
      },
      () => {
        this.workersFailed();
        this.deps.meshed?.();
      },
    );
    if (this.pool === null) {
      this.poolUnavailable = true;
      return false;
    }
    this.sendTypes();
    for (const [key, look] of this.modelLooks) this.pool.broadcast({ t: 'model', key, geometry: { source: look.source, ...(look.levels !== undefined ? { levels: look.levels } : {}) } });
    return true;
  }

  /** The workers could not start or failed: what they had is meshed here from now on. */
  private workersFailed(): void {
    this.pool = null;
    this.poolUnavailable = true;
    this.results.length = 0;
    for (const layer of this.layers.values()) {
      for (const ck of layer.pending.keys()) layer.dirty.add(ck);
      layer.pending.clear();
    }
  }

  private sendTypes(): void {
    if (this.pool === null) return;
    const types = [...this.types.values()];
    const variantModels: [string, (ChunkModelRef | null)[]][] = types.map((t) => [t.blockId, t.variants.map((_, i) => this.pageLooks.variantModel(t, i))]);
    this.pool.broadcast({ t: 'types', types, variantModels });
  }

  /** A model's look, asking the host for it (a layer waiting for it re-meshes when it is ready); null while it loads. */
  private modelLook(ref: ChunkModelRef, entityId: string | null): BlockModelLook | null {
    const key = chunkModelKey(ref);
    const known = this.modelLooks.get(key);
    const look =
      this.deps.modelLook?.(ref.assetId, ref.piece, () => {
        if (this.disposed || entityId === null) return;
        const l = this.layers.get(entityId);
        if (l === undefined) return;
        for (const k of l.grid.chunkKeys()) l.dirty.add(k);
      }) ?? null;
    if (look !== null && look !== known) {
      this.modelLooks.set(key, look);
      this.pool?.broadcast({ t: 'model', key, geometry: { source: look.source, ...(look.levels !== undefined ? { levels: look.levels } : {}) } });
    }
    return look;
  }

  private nextGen(layer: LayerState, ck: string): number {
    const gen = (layer.gens.get(ck) ?? 0) + 1;
    layer.gens.set(ck, gen);
    return gen;
  }

  private uvFor(entityId: string): boolean {
    return this.forcedUv.has(entityId) || this.deps.lightmapped?.(entityId) === true;
  }

  /**
   * Ask for the models of the layer's cells not asked for yet, so a worker has
   * every loaded one before it meshes (and a chunk is not meshed twice).
   */
  private askLooks(entityId: string, layer: LayerState): void {
    // The view's palette: the looks its kits swap in are asked for too.
    const cells = layer.view.paletteCells();
    for (; layer.looksAsked < cells.length; layer.looksAsked++) {
      const cell = cells[layer.looksAsked]!;
      const type = cell.block === undefined ? undefined : this.types.get(cell.block);
      if (type === undefined) continue;
      const variants = cell.variant !== undefined ? [cell.variant] : type.variants.map((_, i) => i);
      for (const v of variants) {
        const model = this.pageLooks.variantModel(type, v);
        if (model !== null) this.modelLook(model, entityId);
      }
    }
  }

  private now(): number {
    return this.deps.now?.() ?? performance.now();
  }

  private waitingChunks(): number {
    let n = 0;
    for (const layer of this.layers.values()) n += layer.pending.size;
    return n;
  }

  /** Chunks wait and no worker has answered for `MESH_WORKER_STALL_MS`: the workers are hung, the page meshes. */
  private checkStall(): void {
    const pool = this.pool;
    if (pool === null || this.now() - this.workersHeardAt < MESH_WORKER_STALL_MS || this.waitingChunks() === 0) return;
    console.warn(`[thirdlight] the block mesh workers have not answered for ${MESH_WORKER_STALL_MS / 1000} s: chunks mesh on the page from now on`);
    pool.dispose();
    this.workersFailed();
  }

  /** Whatever a worker is meshing for this chunk is no longer wanted. */
  private cancelPending(entityId: string, layer: LayerState, ck: string): void {
    if (!layer.pending.delete(ck)) return;
    const gen = this.nextGen(layer, ck);
    const [cx, cz] = ck.split(',').map(Number) as [number, number];
    this.pool?.send({ t: 'cancel', entityId, cx, cz, gen });
  }

  /** Ask a worker for a chunk; its old meshes stay until the result comes. */
  private request(entityId: string, layer: LayerState, ck: string): void {
    this.askLooks(entityId, layer);
    if (this.waitingChunks() === 0) this.workersHeardAt = this.now();
    const gen = this.nextGen(layer, ck);
    layer.pending.set(ck, gen);
    const [cx, cz] = ck.split(',').map(Number) as [number, number];
    this.pool!.send({ t: 'mesh', entityId, serial: layer.serial, cx, cz, gen, uv: this.uvFor(entityId) });
  }

  /** Mesh a chunk here and now. */
  private meshHere(entityId: string, layer: LayerState, ck: string): void {
    const gen = this.nextGen(layer, ck);
    const [cx, cz] = ck.split(',').map(Number) as [number, number];
    if (layer.pending.delete(ck)) this.pool?.send({ t: 'cancel', entityId, cx, cz, gen });
    if (layer.component.metadataOnly === true) {
      const old = layer.chunks.get(ck);
      if (old !== undefined) this.dropChunk(entityId, layer, ck, old);
      return;
    }
    const t0 = performance.now();
    this.meshingLayer = entityId;
    let result: ChunkMeshResult;
    try {
      result = meshChunkForDrawing(layer.view, layer.component, this.types, this.pageLooks, this.standIns, { cx, cz, uv: this.uvFor(entityId) });
    } finally {
      this.meshingLayer = null;
    }
    this.measured(layer, performance.now() - t0);
    this.buildChunk(entityId, layer, ck, cx, cz, result);
  }

  private measured(layer: LayerState, ms: number): void {
    layer.meshMs = layer.meshMs < 0 ? ms : layer.meshMs * 0.75 + ms * 0.25;
  }

  /** Swap in a worker's chunk if it is still the one wanted. */
  private applyResult(r: MeshWorkerReply): boolean {
    const layer = this.layers.get(r.entityId);
    if (layer === undefined || layer.serial !== r.serial) return false;
    const ck = `${r.cx},${r.cz}`;
    if (layer.pending.get(ck) !== r.gen) return false;
    layer.pending.delete(ck);
    this.measured(layer, r.ms);
    // Models the worker did not have: found now (sent to it), the chunk is asked again; still loading, it re-meshes when ready.
    let again = false;
    for (const ref of r.result.missing) if (this.modelLook(ref, r.entityId) !== null) again = true;
    if (again) layer.dirty.add(ck);
    this.buildChunk(r.entityId, layer, ck, r.cx, r.cz, r.result);
    return true;
  }

  private colorMaterial(color: string): THREE.MeshLambertMaterial {
    let m = this.colorMaterials.get(color);
    if (m === undefined) {
      m = new THREE.MeshLambertMaterial({ color: new THREE.Color(color) });
      m.name = `block:${color}`;
      this.colorMaterials.set(color, m);
    }
    return m;
  }

  /** Replace a chunk's meshes with a meshing result (nothing to draw: the chunk goes). */
  private buildChunk(entityId: string, layer: LayerState, ck: string, cx: number, cz: number, result: ChunkMeshResult): void {
    const old = layer.chunks.get(ck);
    if (old !== undefined) this.dropChunk(entityId, layer, ck, old);
    const { parts, coarse, lightmap } = result;
    if (parts.length === 0) return;
    const looks = new Map<string, { materials: readonly THREE.Material[]; type: BlockType; assetId: string | null; color: string | null }>();
    for (const use of result.looks) {
      const type = this.types.get(use.blockId);
      if (type === undefined) continue;
      const model = use.model === null ? undefined : this.modelLooks.get(chunkModelKey(use.model));
      if (use.model !== null && model === undefined) continue;
      looks.set(use.key, { materials: model?.materials ?? [], type, assetId: use.model?.assetId ?? null, color: use.color });
    }
    const group = new THREE.Group();
    group.name = `block-chunk:${entityId}:${ck}`;
    const zones = this.cut.zonesOf(entityId);
    const cutMeshes: { mesh: THREE.Mesh; zones: readonly number[] }[] = [];
    /** A part's meshes: one, or (a layer with cut-away zones) the triangles in no zone and one per set of zones they lie in. */
    const build = (p: ChunkMeshPart, level: number): THREE.Mesh[] => {
      const look = looks.get(p.key.slice(0, p.key.lastIndexOf('#')));
      if (look === undefined) return [];
      const split = splitByCutaway(p.positions, p.indices, zones, layer.grid.cellSize);
      if (split === null) {
        const m = buildMesh(p, look, level, p.indices);
        return m === null ? [] : [m];
      }
      // The pieces share the part's vertex buffers (a stand-in's UVs in cells are made per index, so those are its own).
      const out: THREE.Mesh[] = [];
      const shared = new Map<string, THREE.BufferAttribute>();
      const base = split.base.length > 0 ? buildMesh(p, look, level, split.base, shared) : null;
      if (base !== null) out.push(base);
      for (const c of split.cut) {
        const m = buildMesh(p, look, level, c.indices, shared);
        if (m === null) continue;
        out.push(m);
        cutMeshes.push({ mesh: m, zones: c.zones });
      }
      return out;
    };
    const buildMesh = (p: ChunkMeshPart, look: { materials: readonly THREE.Material[]; type: BlockType; assetId: string | null; color: string | null }, level: number, indices: Uint32Array, shared?: Map<string, THREE.BufferAttribute>): THREE.Mesh | null => {
      const attr = (name: string, array: Float32Array | Uint8Array, size: number, normalized = false, own = false): THREE.BufferAttribute => {
        if (shared === undefined || own) return new THREE.BufferAttribute(own ? array.slice() : array, size, normalized);
        let a = shared.get(name);
        if (a === undefined) shared.set(name, (a = new THREE.BufferAttribute(array, size, normalized)));
        return a;
      };
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute('position', attr('position', p.positions, 3));
      geometry.setAttribute('normal', attr('normal', p.normals, 3));
      const cellUv = look.assetId === null && look.type.materials !== undefined && Object.keys(look.type.materials).length > 0;
      geometry.setAttribute('uv', attr('uv', p.uvs, 2, false, cellUv));
      if (p.tangents !== undefined) geometry.setAttribute('tangent', attr('tangent', p.tangents, 4));
      if (p.uv1 !== undefined) geometry.setAttribute('uv1', attr('uv1', p.uv1, 2));
      geometry.setIndex(new THREE.BufferAttribute(indices, 1));
      geometry.computeBoundingSphere();
      geometry.computeBoundingBox();
      const material = look.color !== null ? this.colorMaterial(look.color) : (look.materials[p.material] ?? look.materials[0] ?? this.colorMaterial('#b0b0b0'));
      const m = new THREE.Mesh(geometry, material);
      m.name = `block:${p.key}`;
      m.castShadow = layer.component.castShadow !== false;
      m.receiveShadow = layer.component.receiveShadow !== false;
      // The layer's light layers (light-layers.ts; absent: every layer).
      const lightLayers = lightLayerMaskOf(layer.component.lightLayers);
      if (lightLayers !== LIGHT_LAYERS_ALL) m.userData[LIGHT_LAYERS_KEY] = lightLayers;
      m.matrixAutoUpdate = false;
      m.updateMatrix();
      if (level > 0) m.userData[COARSE_LEVEL] = level;
      if (look.assetId !== null) this.deps.applyMaterials?.(m, look.type, look.assetId);
      else if (look.type.materials !== undefined && Object.keys(look.type.materials).length > 0) {
        this.deps.applyMaterials?.(m, look.type, null);
        // A stand-in's material may read its UVs in cells (made before they were metres).
        keepMetreUv(m, layer.grid.cellSize);
        syncCellUv(m);
      }
      // A painted layer's paint (made with the meshing); a material that tints by vertex colours would be tinted by it: its chunks keep none.
      if (p.weights !== undefined && p.wetness !== undefined && (m.material as THREE.Material & { vertexColors?: boolean }).vertexColors !== true) {
        geometry.setAttribute('color', attr('color', p.weights, 4, true));
        geometry.setAttribute('color_1', attr('color_1', p.wetness, 4, true));
      }
      return m;
    };
    const detailed = new THREE.Group();
    for (const p of parts) {
      for (const m of build(p, 0)) {
        if (coarse.length > 0 && p.key.startsWith('m:')) detailed.add(m);
        else group.add(m);
      }
    }
    if (coarse.length > 0 && detailed.children.length > 0) {
      // One THREE.LOD at the centre of the chunk's model geometry; each level's meshes offset back by it.
      const box = new THREE.Box3();
      for (const c of detailed.children) box.union((c as THREE.Mesh).geometry.boundingBox!);
      const centre = box.getCenter(new THREE.Vector3());
      const radius = box.getBoundingSphere(new THREE.Sphere()).radius;
      const lod = new THREE.LOD();
      lod.name = `block-chunk-lod:${entityId}:${ck}`;
      lod.position.copy(centre);
      const level = (g: THREE.Group): THREE.Group => {
        g.position.copy(centre).negate();
        g.matrixAutoUpdate = false;
        g.updateMatrix();
        return g;
      };
      lod.addLevel(level(detailed), 0);
      coarse.forEach((c, i) => {
        const g = new THREE.Group();
        for (const p of c.parts) for (const m of build(p, i + 1)) g.add(m);
        lod.addLevel(level(g), c.distance + radius);
      });
      lod.matrixAutoUpdate = false;
      lod.updateMatrix();
      group.add(lod);
    } else for (const c of [...detailed.children]) group.add(c);
    group.matrixAutoUpdate = false;
    group.updateMatrix();
    layer.group.add(group);
    group.updateMatrixWorld(true);
    layer.chunks.set(ck, group);
    if (!layer.hidden) this.deps.place?.(group, true);
    if (lightmap !== null) {
      layer.lightmapLayouts.set(ck, lightmap);
      this.deps.chunkBuilt?.(entityId, cx, cz, group, lightmap.layout);
    }
    // Last: they take their zones' fade, and a fade variant of the material they wear now (lightmap included).
    this.cut.register(entityId, ck, cutMeshes);
  }

  private dropChunk(entityId: string, layer: LayerState, ck: string, group: THREE.Group): void {
    this.cut.drop(entityId, ck);
    if (layer.lightmapLayouts.delete(ck)) {
      const [cx, cz] = ck.split(',').map(Number) as [number, number];
      this.deps.chunkDropped?.(entityId, cx, cz);
    }
    this.deps.place?.(group, false);
    group.traverse((o) => ((o as THREE.Mesh).isMesh === true ? (o as THREE.Mesh).geometry.dispose() : undefined));
    group.removeFromParent();
    layer.chunks.delete(ck);
  }
}

/** The chunk key of a cell column (for callers mapping cells to chunks). */
export const blockChunkKey = (x: number, z: number): string => `${Math.floor(x / CHUNK_SIZE)},${Math.floor(z / CHUNK_SIZE)}`;
