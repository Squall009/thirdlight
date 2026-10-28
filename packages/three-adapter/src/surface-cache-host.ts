/**
 * The surface cache on the page: which static surfaces' light is resident
 * round the drawn eye, within the quality level's budget (`surface-cache.ts`
 * decides; this host feeds it the loaded scene).
 *
 * - Block layers offer their built chunk columns (what the world stream
 *   holds on a game page), terrains their loaded tiles, generated
 *   architecture its objects, and static model objects their pieces once
 *   their distance-field file (bricks and surfels) is read.
 * - A tile is offered only once its charts are made; charts are made a few
 *   at a time, nearest first, within `SURFACE_PREPARE_MS` a frame, so a
 *   scene coming in never stalls a frame.
 *
 * - It keeps the cache's light up to date (`surface-relight.ts`): resident
 *   tiles and terrain ring patches are the units of work, and every change
 *   it sees while listing (a tile's new version, a terrain tile's new data,
 *   a surface come or gone) marks what that geometry's light reaches
 *   (`surface-changes.ts`); the page hands in its lights every frame.
 *
 * Measurements read it from `scene.userData[SURFACE_CACHE_KEY]`.
 */
import { DEFAULT_PROBE_SPACING, LIGHT_LAYERS_ALL, decodeDistanceBricks, type ArchitectureComponent, type BlockCell, type BlockGridReader, type DistanceBricks, type TerrainField, type TerrainTile } from '@thirdlight/runtime';

import { SurfaceCache, type SurfaceCacheDiagnostics, type SurfaceTile } from './surface-cache';
import { SurfaceChanges, SurfaceColourChanges, type CacheLight } from './surface-changes';
import { SurfaceRelight, type RelightDiagnostics, type RelightSlice, type RelightUnit } from './surface-relight';
import type { RingPatch } from './surface-cache-terrain';
import type { AtlasBlock } from './surface-cache-atlas';
import { chartUnits, type ChartRect, type PatchTexels, type TileTexels } from './surface-texels';
import { architecturePiecesOf } from './surface-cache-arch';
import type { SurfaceBlockGrid } from './surface-cache-blocks';
import { SurfaceScene, architectureTile, blockChunkTile, modelPieceTiles, type ArchTile, type BlockTile, type ModelTile } from './surface-cache-scene';
import type { TerrainRingSource } from './surface-cache-terrain';
import { invertAffine, type Affine } from './tracer-words';
import type { TraceBlockLayer, TraceSceneSource, TraceTerrain } from './tracer-scene';
import { traceBlockLayerOf } from './tracer-sources';
import { TerrainTraceRings } from './tracer-terrain-rings';
import { SurfaceRooms, type LightingRooms } from './surface-rooms';
import { LiveProbes, PROBE_BUDGET_SHARE, type LiveProbeDiagnostics } from './surface-probes';
import { SurfaceSeeding } from './surface-seed';
import { ProbeMarks, brickSide, type ProbeSolid, type Steps } from './probe-bricks';
import { architectureMarks, blockTileMarks, probeSolid, terrainMarksSteps, type ProbeSolidModel } from './probe-geometry';
import type { TraceArchitecture } from './tracer-objects';

/** `scene.userData[SURFACE_CACHE_KEY]`: the page's surface cache (a measurement reads its diagnostics). */
export const SURFACE_CACHE_KEY = 'tlSurfaceCache';
/** Main-thread time a frame may spend making tiles' charts (ms), and as much again on the terrains' trace rings. */
export const SURFACE_PREPARE_MS = 1;
/** How often (ms) the host lists the loaded scene's surfaces again when nothing says it changed. */
const LIST_MS = 250;
/** The probes are placed again at most this often (ms) while what they stand on changes. */
export const PROBE_PLACE_MS = 1000;
/** Main-thread time (ms) a frame gives a placement of the probes being made (a large scene's takes tens of ms: spread over frames). */
export const PROBE_PLACE_SHARE_MS = 1;
/** The terrain probes' window moves in steps of a brick of this level. */
const PROBE_TERRAIN_SNAP_LEVEL = 1;

/** A block layer as the host reads it from the block view. */
export interface SurfaceHostLayer {
  readonly id: string;
  readonly origin: readonly number[];
  readonly grid: SurfaceBlockGrid;
  /** Changes with what stops light (its block types). */
  readonly version: number;
  /** Its built chunk columns ("cx,cz") and each one's version (bumped when it is meshed again). */
  readonly chunks: readonly (readonly [string, number])[];
  readonly opaque: (cell: BlockCell) => boolean;
  /** Its entity's light layers (absent: every layer). */
  readonly layers?: number;
}

/** A static model object: its entity, model row and world matrix (column-major 4 × 4, as three's). */
export interface SurfaceHostModel {
  readonly id: string;
  readonly assetId: string;
  readonly version: number;
  readonly piece: string | null;
  readonly world: ArrayLike<number>;
  /** Its entity's light layers (absent: every layer). */
  readonly layers?: number;
}

export interface SurfaceCacheHostDeps {
  readonly layers: () => readonly SurfaceHostLayer[];
  readonly terrains: () => readonly { readonly id: string; readonly field: TerrainField; readonly layers?: number }[];
  /** Generated architecture objects (a new component object is a new version). */
  readonly architecture: () => readonly { readonly id: string; readonly component: ArchitectureComponent; readonly origin: readonly number[]; readonly layers?: number }[];
  readonly models: () => readonly SurfaceHostModel[];
  /** A model row's distance-field file (null: it has none). */
  readonly bricks: (assetId: string, version: number) => Promise<Uint8Array> | null;
  /** The rooms of generated architecture and their open portals (absent or null: none). */
  readonly rooms?: () => LightingRooms | null;
  /** Whether a static model object is still in the scene (absent: its slot is kept): a slot whose object left is used again. */
  readonly modelAlive?: (id: string) => boolean;
}

/**
 * Slots of static model objects. Their copies share geometry (batched,
 * merged, instanced), so a drawn copy carries its object's slot (an
 * instance column, a merged cell's vertex attribute, the object's own) and
 * the materials' lookup holds each slot's placement and pieces. A slot is
 * its object's while it is in the scene, then used again.
 */
export class SurfaceModelSlots {
  private readonly byId = new Map<string, number>();
  private readonly free: number[] = [];
  private next = 1;
  /** Bumped whenever a slot is given or let go (the lookup is packed again). */
  version = 0;

  /** The object's slot, given now if it has none. */
  slotOf(id: string): number {
    let s = this.byId.get(id);
    if (s === undefined) {
      s = this.free.pop() ?? this.next++;
      this.byId.set(id, s);
      this.version += 1;
    }
    return s;
  }

  /** The object's slot if it has one. */
  peek(id: string): number | undefined {
    return this.byId.get(id);
  }

  /** Lets go the slots of objects no longer alive. */
  prune(alive: (id: string) => boolean): void {
    for (const [id, s] of this.byId) {
      if (alive(id)) continue;
      this.byId.delete(id);
      this.free.push(s);
      this.version += 1;
    }
  }
}

export interface SurfaceCacheHostDiagnostics extends SurfaceCacheDiagnostics {
  /** Surfaces of the loaded scene whose charts are not made yet, and models whose files are being read. */
  readonly preparing: number;
  readonly reading: number;
  /** The last frame's time making charts (ms). */
  readonly prepareMs: number;
  /** What waits for light, the GPU time used and whether the scene is settled. */
  readonly relight: RelightDiagnostics;
  /** The live probes: how many, how many stale, and the last update's GPU time. */
  readonly probes: LiveProbeDiagnostics;
  /** Tiles and probes that started from a bake's saved light. */
  readonly seeded: { readonly tiles: number; readonly probes: number };
}

/** A terrain ring patch as a unit of work. */
export interface RingPatchUnit extends RelightUnit {
  readonly terrain: string;
  readonly patch: RingPatch;
}

/** A matrix (column-major 4 × 4) as the world → local affine map. */
function worldToLocalOfMatrix(m: ArrayLike<number>): Affine {
  return invertAffine([m[0]!, m[4]!, m[8]!, m[12]!, m[1]!, m[5]!, m[9]!, m[13]!, m[2]!, m[6]!, m[10]!, m[14]!]);
}

/** A terrain's loaded tiles' world box: what its rings cover. */
function ringSourceOf(id: string, field: TerrainField): TerrainRingSource | null {
  let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
  for (const key of field.loadedTiles().keys()) {
    const [x, z] = key.split(',').map(Number) as [number, number];
    x0 = Math.min(x0, x);
    z0 = Math.min(z0, z);
    x1 = Math.max(x1, x + 1);
    z1 = Math.max(z1, z + 1);
  }
  if (x0 === Infinity) return null;
  const side = field.n * field.spacing;
  const o = field.origin;
  const [y0, y1] = field.heightSpan();
  return { key: id, min: [o[0] + x0 * side, y0, o[2] + z0 * side], max: [o[0] + x1 * side, y1, o[2] + z1 * side] };
}

interface Pending {
  /** Where it is (for nearest first) and its version. */
  readonly min: readonly number[];
  readonly max: readonly number[];
  readonly version: number;
  /** Makes its tile and its charts. */
  readonly make: () => SurfaceTile;
}

/** A number for a placement (its matrix to the millimetre): a moved static object is a new version of its tiles. */
function placementHash(m: ArrayLike<number>, version: number): number {
  let h = 5381 + version;
  for (let i = 0; i < 16; i += 1) h = (Math.imul(h, 33) + Math.round((m[i] ?? 0) * 1000)) | 0;
  return h >>> 0;
}

function sameData(x: ArrayLike<number> | null, y: ArrayLike<number> | null): boolean {
  if (x === y) return true;
  if (x === null || y === null || x.length !== y.length) return false;
  for (let i = 0; i < x.length; i += 1) if (x[i] !== y[i]) return false;
  return true;
}

/** Whether two tiles' data stop light alike: their heights and holes (paint changes colour, not where light falls). */
function sameShape(a: TerrainTile, b: TerrainTile): boolean {
  return sameData(a.heights, b.heights) && sameData(a.holes, b.holes);
}

/** Whether two tiles' ground has the same colour: their layer weights and paint. */
function sameColour(a: TerrainTile, b: TerrainTile): boolean {
  return sameData(a.weights, b.weights) && sameData(a.paint, b.paint);
}

export class SurfaceCacheHost {
  readonly cache: SurfaceCache;
  private listedAt = -Infinity;
  /** Made tiles by key (kept while their source is loaded and unchanged). */
  private readonly ready = new Map<string, SurfaceTile>();
  private readonly pending = new Map<string, Pending>();
  private terrains: TerrainRingSource[] = [];
  private readonly memos = new Map<string, { version: number; memo: Map<number, boolean> }>();
  /** Model files by asset and version: read (decoded), being read, or none. */
  private readonly files = new Map<string, DistanceBricks | 'reading' | null>();
  private readonly componentVersions = new WeakMap<object, number>();
  private componentVersion = 0;
  private changed = true;
  private prepareMs = 0;
  private offered: SurfaceTile[] = [];
  readonly relight: SurfaceRelight;
  readonly changes: SurfaceChanges;
  /** The live probes over the static scene and its rooms (lit only where a pass runs them). */
  readonly probes: LiveProbes;
  /** The bakes' saved light the live light starts from (`surface-seed.ts`). */
  readonly seeding: SurfaceSeeding;
  /** The drawn eye at the last update. */
  readonly eye: number[] = [0, 0, 0];
  /** The first listing is done: what comes or goes after it is a change. */
  private listed = false;
  /** Each terrain's tile data as last listed (an edit hands in new data). */
  private readonly terrainTiles = new Map<string, Map<string, TerrainTile>>();
  /** Each terrain's field as last listed. */
  private readonly fields = new Map<string, TerrainField>();
  /** Each terrain's ring patch units by key. */
  private readonly patchUnits = new Map<string, Map<string, RingPatchUnit>>();
  private slices: RelightSlice[] = [];
  /** A block or architecture tile's chart units, and each one's tile and first texel there. */
  private readonly tileUnits = new Map<string, string[]>();
  private readonly chartUnits = new Map<string, RelightUnit & { readonly tile: string; readonly rect: ChartRect }>();
  private live = false;
  /** The light layers of each listed tile's (and terrain's) entity. */
  private readonly layersOf = new Map<string, number | undefined>();
  /** Bumped by every geometry change the listing sees. */
  private geometryVersion = 0;
  /** Where surfaces' colours changed: the probes there bounce them again once a frame wrote them. */
  readonly colours: SurfaceColourChanges;
  private traced: { source: TraceSceneSource; version: number } | null = null;
  private resolved: { scene: SurfaceScene; version: number } | null = null;
  /** Bumped whenever the cache's residency changed (tiles placed, let go, rings stepped): the resolve tables are packed again. */
  residencyVersion = 0;
  /** The static model objects' slots their drawn copies read the cache by. */
  readonly modelSlots = new SurfaceModelSlots();
  private roomsNow: SurfaceRooms | null = null;
  /** Traced layers and terrains, kept while their data is unchanged. */
  private readonly layerTraces = new Map<string, { key: string; grid: SurfaceBlockGrid; trace: TraceBlockLayer; layers: number | undefined; withLayers: TraceBlockLayer }>();
  /** Each terrain's trace rings round the eye. */
  private readonly terrainRings = new Map<string, TerrainTraceRings>();
  /** A ring with its terrain's light layers (kept while both stay, so the packer sees the same item). */
  private readonly ringLayers = new WeakMap<TraceTerrain, { layers: number | undefined; trace: TraceTerrain }>();
  /** The architecture and models the last trace source packed, and the ready tiles they came from. */
  private tracedObjects: { tiles: readonly SurfaceTile[]; layers: readonly (number | undefined)[]; arch: TraceSceneSource['arch']; bricks: TraceSceneSource['bricks'] } | null = null;
  /** Bumped per terrain when its tiles' data changed, came or went. */
  private readonly terrainVersions = new Map<string, number>();
  private roomsVersion = -1;
  /** Bumped whenever a ready tile came, went or changed (the probes are placed again). */
  private readyVersion = 0;
  /** The terrain probes' window centre (x, z), and the last placement's key and time. */
  private probeCentre: [number, number] | null = null;
  private probesPlacedKey = '';
  private probesPlacedAt = -Infinity;
  /** Since when (ms) a placement waits for the throttle or for changed tiles to be made again (null: none waits). */
  private probesWaiting: number | null = null;
  /** The placement being made, a share of each frame (`PROBE_PLACE_SHARE_MS`), and its key. */
  private probeJob: { key: string; steps: Steps<boolean> } | null = null;
  private placeFrameMs = 0;

  /** `relightMs`: the GPU time a frame may spend lighting stale texels (0: none, the saved light is drawn). */
  constructor(private readonly deps: SurfaceCacheHostDeps, budgetBytes: number, private relightMs = 0) {
    this.cache = new SurfaceCache(budgetBytes);
    // Live only once a pass runs the work (`setLive`).
    this.relight = new SurfaceRelight(relightMs, false);
    this.changes = new SurfaceChanges(this.relight);
    this.probes = new LiveProbes(DEFAULT_PROBE_SPACING, relightMs * PROBE_BUDGET_SHARE);
    // What the cache's light marks, the probes' light may change with.
    this.relight.onStale((min, max) => this.probes.markBox(min, max));
    // A surface's colour is written where it is made and the lookup holds it.
    this.colours = new SurfaceColourChanges(this.probes, () => this.listed && this.pending.size === 0);
    this.seeding = new SurfaceSeeding({ cache: this.cache, relight: this.relight, changes: this.changes, probes: this.probes, tile: (key) => this.ready.get(key), unitsOf: (key) => this.tileUnits.get(key) ?? [key] });
  }

  /** The GPU time a frame may spend on live light (0: none, the saved light is drawn). */
  get relightBudgetMs(): number {
    return this.relightMs;
  }

  /** The quality level's GPU time a frame for live light (0: none). */
  setRelightBudget(ms: number): void {
    this.relightMs = ms;
    this.probes.setBudget(ms * PROBE_BUDGET_SHARE);
    this.relight.setBudget(ms, this.live);
  }

  /** A pass runs the planned work (`slicesThisFrame`) and reports its GPU time (`relight.report`). */
  setLive(on: boolean): void {
    if (on && !this.live) this.seeding.wentLive();
    this.live = on;
    this.relight.setBudget(this.relightMs, on);
  }

  /** The lights now (once a frame). */
  setLights(lights: readonly CacheLight[]): void {
    this.changes.setLights(lights);
  }

  /** The rooms light keeps to (null: none). */
  rooms(): SurfaceRooms | null {
    return this.roomsNow;
  }

  /** The rooms again when they or a door changed: lights whose rooms changed are marked. */
  private syncRooms(now: number): void {
    const r = this.deps.rooms?.() ?? null;
    const version = r === null ? -1 : r.version;
    if (version === this.roomsVersion && (r === null) === (this.roomsNow === null)) return;
    this.roomsVersion = version;
    this.roomsNow = r === null ? null : new SurfaceRooms(r);
    this.changes.setRooms(this.roomsNow);
    // The probes name rooms by index: placed again over the new rooms at once.
    this.placeProbes(true, now);
  }

  /** Where a unit's texels are: a resident tile's packing, or a ring patch and its terrain (null: gone). */
  texelsOf(key: string): TileTexels | PatchTexels | null {
    const chart = this.chartUnits.get(key);
    if (chart !== undefined) {
      const r = this.cache.residentOf(chart.tile);
      const tile = this.ready.get(chart.tile) as BlockTile | ArchTile | undefined;
      return r === null || tile === undefined ? null : { tile, level: r.level, packing: r.packing, charts: r.charts, blocks: r.blocks, rect: chart.rect };
    }
    const r = this.cache.residentOf(key);
    if (r !== null) {
      const tile = this.ready.get(key) as BlockTile | ArchTile | ModelTile | undefined;
      return tile === undefined ? null : { tile, level: r.level, packing: r.packing, charts: r.charts, blocks: r.blocks };
    }
    const hash = key.indexOf('#');
    if (hash < 0) return null;
    const terrain = key.slice(0, hash);
    const u = this.patchUnits.get(terrain)?.get(key);
    const field = this.fields.get(terrain);
    const rings = this.cache.ringsOf(terrain);
    if (u === undefined || field === undefined || rings === null) return null;
    return { patch: u.patch, texel: rings.texelMetres(u.patch.ring), field, terrain: this.cache.ringTerrains().indexOf(terrain) };
  }

  /** The texels to light this frame (what `update` planned). */
  slicesThisFrame(): readonly RelightSlice[] {
    return this.slices;
  }

  /** Geometry in a box changed (after the first listing; the scene coming in is not a change). */
  private geometry(min: readonly number[], max: readonly number[]): void {
    this.geometryVersion += 1;
    if (!this.listed) return;
    this.changes.geometryChanged(min, max);
    this.colours.changed(min, max);
  }

  /**
   * What the tracer packs for the light this host keeps: the listed block
   * layers, terrains, architecture and static models, and a version that
   * changes whenever any of them did (a pass packs again only then).
   */
  /** The version `traceSource` would answer with (cheap: nothing is made). */
  get traceVersion(): number {
    return this.geometryVersion + this.ready.size * 0x100000;
  }

  /** A layer's traced grid with its light layers, made again only when its cells changed (a scene's tiles arriving one by one would make it again each time). */
  private layerTrace(l: SurfaceHostLayer): TraceBlockLayer {
    const key = `${l.version}:${l.chunks.map(([, gen]) => gen).join(',')}`;
    const had = this.layerTraces.get(l.id);
    if (had !== undefined && had.key === key && had.grid === l.grid && had.layers === l.layers) return had.withLayers;
    const trace = had !== undefined && had.key === key && had.grid === l.grid ? had.trace : traceBlockLayerOf(l.grid as BlockGridReader, l.origin, l.opaque);
    this.layerTraces.set(l.id, { key, grid: l.grid, trace, layers: l.layers, withLayers: l.layers !== undefined ? { ...trace, layers: l.layers } : trace });
    return this.layerTraces.get(l.id)!.withLayers;
  }

  /** The terrains' trace rings follow the eye and their tiles; a ring made again is a new trace (not a geometry change: the ground is the same). */
  private followRings(eye: ArrayLike<number>): void {
    for (const id of [...this.terrainRings.keys()]) if (!this.fields.has(id)) {
      this.terrainRings.delete(id);
      this.geometryVersion += 1;
    }
    for (const [id, field] of this.fields) {
      let r = this.terrainRings.get(id);
      if (r === undefined) this.terrainRings.set(id, (r = new TerrainTraceRings()));
      if (r.update(field, this.terrainVersions.get(id) ?? 0, eye, SURFACE_PREPARE_MS)) this.geometryVersion += 1;
    }
  }

  /** A terrain's rings as traced, with its light layers. */
  private terrainTraces(id: string): TraceTerrain[] {
    const layers = this.layersOf.get(id);
    return (this.terrainRings.get(id)?.traces() ?? []).map((t) => {
      if (layers === undefined) return t;
      const had = this.ringLayers.get(t);
      if (had !== undefined && had.layers === layers) return had.trace;
      const trace = { ...t, layers };
      this.ringLayers.set(t, { layers, trace });
      return trace;
    });
  }

  traceSource(): { source: TraceSceneSource; version: number } {
    const version = this.traceVersion;
    if (this.traced !== null && this.traced.version === version) return this.traced;
    const blocks: TraceBlockLayer[] = [];
    for (const l of this.deps.layers()) if ('forEach' in l.grid) blocks.push(this.layerTrace(l));
    const terrain: TraceTerrain[] = [];
    for (const id of this.fields.keys()) terrain.push(...this.terrainTraces(id));
    const { arch, bricks } = this.objectsTraced();
    this.traced = { source: { blocks, terrain, arch, bricks }, version };
    return this.traced;
  }

  /** The architecture and models to trace, made again only when the ready tiles holding them (or their light layers) changed. */
  private objectsTraced(): { arch: TraceSceneSource['arch']; bricks: TraceSceneSource['bricks'] } {
    const all = LIGHT_LAYERS_ALL;
    const tiles = [...this.ready.values()].filter((t) => { const k = (t as { kind?: string }).kind; return k === 'arch' || k === 'model'; });
    const layers = tiles.map((t) => this.layersOf.get(t.key));
    const was = this.tracedObjects;
    if (was !== null && was.tiles.length === tiles.length && was.tiles.every((t, i) => t === tiles[i] && was.layers[i] === layers[i])) return was;
    const arch = tiles.filter((t): t is ArchTile => (t as { kind?: string }).kind === 'arch');
    const boxes = arch.flatMap((t) => t.pieces.boxes);
    const tris = new Float32Array(arch.reduce((n, t) => n + t.pieces.triangles.length, 0));
    // Each item's layers: its object's, boxes first, then triangles (the tracer's item order).
    const archLayers = [...arch.flatMap((t) => t.pieces.boxes.map(() => this.layersOf.get(t.key) ?? all)), ...arch.flatMap((t) => Array.from({ length: t.pieces.triangles.length / 9 }, () => this.layersOf.get(t.key) ?? all))];
    let at = 0;
    for (const t of arch) {
      tris.set(t.pieces.triangles, at);
      at += t.pieces.triangles.length;
    }
    const bricks = tiles.filter((t): t is ModelTile => (t as { kind?: string }).kind === 'model').map((t) => ({ worldToLocal: t.worldToLocal, set: t.set, layers: this.layersOf.get(t.key) ?? all }));
    this.tracedObjects = { tiles, layers, arch: { boxes, triangles: tris, layers: archLayers }, bricks };
    return this.tracedObjects;
  }

  /**
   * The scene the GPU resolve's tables are packed from (`packResolveTable`),
   * in the order `traceSource` packs the tracer's, with the tiles made here
   * (their charts are not made again), and the trace version it is of.
   */
  resolveScene(): { scene: SurfaceScene; version: number } {
    const traced = this.traceSource();
    if (this.resolved !== null && this.resolved.version === traced.version) return this.resolved;
    const blocks = this.deps.layers().filter((l) => 'forEach' in l.grid).map((l, i) => ({ key: l.id, grid: l.grid, origin: l.origin, opaque: l.opaque, version: l.version, chunks: l.chunks.map(([k]) => k), trace: traced.source.blocks![i]! }));
    // One entry per traced ring, in the tracer's order (a hit names its ring; all of a terrain's rings light its cache rings).
    const terrain = [...this.fields.keys()].flatMap((id) => this.terrainTraces(id).map((trace) => ({ key: id, trace })));
    const tiles = [...this.ready.values()];
    const architecture = tiles.filter((t): t is ArchTile => (t as { kind?: string }).kind === 'arch').map((t) => ({ key: t.key, origin: [0, 0, 0], version: t.version, pieces: t.pieces }));
    const modelTiles = tiles.filter((t): t is ModelTile => (t as { kind?: string }).kind === 'model');
    this.resolved = { scene: new SurfaceScene({ blocks, terrain, architecture, modelTiles, made: this.ready }), version: traced.version };
    return this.resolved;
  }

  setBudget(bytes: number): void {
    if (bytes === this.cache.budgetBytes) return;
    this.cache.setBudget(bytes);
    this.changed = true;
  }

  /** The tiles offered to the cache (made, with something to light) once every surface of the loaded scene has its charts and every model file is read (null until then). */
  preparedTiles(): readonly SurfaceTile[] | null {
    if (this.pending.size > 0) return null;
    for (const f of this.files.values()) if (f === 'reading') return null;
    return this.offered;
  }

  /** The resident tiles as a bake saves them: key, charts' digest, level and blocks. */
  savedTiles(): { key: string; digest: string; level: number; blocks: readonly AtlasBlock[] }[] {
    const out: { key: string; digest: string; level: number; blocks: readonly AtlasBlock[] }[] = [];
    this.cache.forEachResident((key, level, blocks) => {
      const tile = this.ready.get(key);
      if (tile !== undefined) out.push({ key, digest: this.cache.digestOf(tile), level, blocks });
    });
    return out;
  }

  /** Something loaded or changed (a scene, a chunk built, an edit): the surfaces are listed again on the next frame. */
  touch(): void {
    this.listedAt = -Infinity;
  }

  /** Once a frame, with the drawn eye (`now`: the frame's time, ms). */
  update(eye: ArrayLike<number>, now = performance.now()): void {
    if (now - this.listedAt >= LIST_MS) {
      this.listedAt = now;
      this.list(now);
    }
    this.syncRooms(now);
    this.followRings(eye);
    this.prepare(eye, now);
    this.stepProbeJob(now);
    // A tile with nothing to light (a chunk of hidden faces only) is made once and never offered.
    if (this.changed) this.offered = [...this.ready.values()].filter((t) => t.charts().length > 0);
    const at = [eye[0]!, eye[1]!, eye[2]!];
    this.eye[0] = at[0]!;
    this.eye[1] = at[1]!;
    this.eye[2] = at[2]!;
    this.cache.update(at, this.offered, this.terrains, this.changed);
    this.changed = false;
    this.syncUnits();
    this.seeding.frame(this.live);
    this.slices = this.relight.plan(at, now);
  }

  /**
   * A resident tile's units: a block or architecture tile's charts one by one
   * (a lamp marks the walls round it, not every face of the chunk column), a
   * model's surfels as one.
   */
  private addTileUnits(key: string): void {
    const r = this.cache.residentOf(key);
    const tile = this.ready.get(key) as BlockTile | ArchTile | ModelTile | undefined;
    if (r === null || tile === undefined) return;
    const layers = this.layersOf.get(key);
    if (tile.kind === 'model') {
      const u = this.cache.residentUnit(key)!;
      this.relight.add({ key, ...u, ...(layers !== undefined ? { layers } : {}) });
      return;
    }
    const keys: string[] = [];
    r.charts.forEach((chart, c) => {
      for (const shape of chartUnits(tile, c, chart, r.packing.places[c]!, r.level)) {
        const { rect } = shape;
        const u = { key: `${key}|${c}:${rect.x},${rect.y}`, tile: key, rect, texels: rect.w * rect.h, min: shape.min, max: shape.max, plane: shape.plane, ...(layers !== undefined ? { layers } : {}) };
        keys.push(u.key);
        this.chartUnits.set(u.key, u);
        this.relight.add(u);
      }
    });
    this.tileUnits.set(key, keys);
  }

  /** The cache's resident tiles and ring patches as units of work: what came in or moved is stale. */
  private syncUnits(): void {
    const ch = this.cache.takeChanges();
    if (ch.freed.length > 0 || ch.allocated.length > 0 || ch.rings.length > 0) this.residencyVersion += 1;
    for (const key of ch.freed) {
      for (const u of this.tileUnits.get(key) ?? []) {
        this.relight.remove(u);
        this.chartUnits.delete(u);
      }
      this.tileUnits.delete(key);
      this.relight.remove(key);
    }
    for (const key of ch.allocated) {
      this.addTileUnits(key);
      const r = this.cache.residentOf(key);
      // Its blocks hold another tile's light until cleared, or given the saved light.
      if (r !== null && this.live) this.seeding.handOut(key, r.blocks);
    }
    const stepped = new Map<string, Set<number>>();
    for (const r of ch.rings) for (const k of r.rings) {
      let set = stepped.get(r.terrain);
      if (set === undefined) stepped.set(r.terrain, (set = new Set()));
      set.add(k);
    }
    const terrains = new Set(this.cache.ringTerrains());
    for (const [terrain, units] of [...this.patchUnits]) if (!terrains.has(terrain)) {
      for (const key of units.keys()) this.relight.remove(key);
      this.patchUnits.delete(terrain);
    }
    for (const terrain of terrains) {
      const rings = this.cache.ringsOf(terrain)!;
      let units = this.patchUnits.get(terrain);
      const fresh = units === undefined;
      if (units === undefined) this.patchUnits.set(terrain, (units = new Map()));
      const steps = stepped.get(terrain);
      if (!fresh && steps === undefined && [...units.values()].every((u) => u.patch.ring < rings.rings)) continue;
      const src = rings.source;
      const seen = new Set<string>();
      for (let k = 0; k < rings.rings; k += 1) {
        const t = rings.texelMetres(k);
        for (const p of rings.patches(k)) {
          const key = `${terrain}#${k}/${p.px},${p.pz}`;
          seen.add(key);
          const had = units.get(key);
          // A patch whose window grew or moved is lit again whole; one the step left as it was keeps its light.
          if (had !== undefined && had.patch.ix === p.ix && had.patch.iz === p.iz && had.patch.w === p.w && had.patch.h === p.h) continue;
          const layers = this.layersOf.get(terrain);
          const u: RingPatchUnit = { key, terrain, patch: p, texels: p.w * p.h, min: [p.ix * t, src.min[1]!, p.iz * t], max: [(p.ix + p.w) * t, src.max[1]!, (p.iz + p.h) * t], ...(layers !== undefined ? { layers } : {}) };
          units.set(key, u);
          this.relight.add(u);
        }
      }
      for (const key of [...units.keys()]) if (!seen.has(key)) {
        units.delete(key);
        this.relight.remove(key);
      }
    }
  }

  /** Whether `key` at `version` is made or waiting; else it waits (a changed one is let go first). */
  private want(seen: Set<string>, key: string, version: number, min: readonly number[], max: readonly number[], make: () => SurfaceTile): void {
    seen.add(key);
    const had = this.ready.get(key);
    if (had !== undefined && had.version === version) return;
    if (had !== undefined) {
      this.ready.delete(key);
      this.readyVersion += 1;
      this.changed = true;
      this.geometry(had.min, had.max);
    }
    const p = this.pending.get(key);
    if (p === undefined || p.version !== version) {
      this.pending.set(key, { min, max, version, make });
      this.geometry(min, max);
    }
  }

  /** The loaded scene's surfaces: what is ready stays, what changed or is new waits to be made, what left goes. */
  private list(now: number): void {
    const seen = new Set<string>();
    if (this.deps.modelAlive !== undefined) this.modelSlots.prune(this.deps.modelAlive);
    for (const layer of this.deps.layers()) {
      let m = this.memos.get(layer.id);
      if (m === undefined || m.version !== layer.version) this.memos.set(layer.id, (m = { version: layer.version, memo: new Map() }));
      const memo = m.memo;
      for (const [ck, gen] of layer.chunks) {
        const key = `${layer.id}/${ck}`;
        const version = layer.version * 65536 + gen;
        if (this.ready.get(key)?.version === version || this.pending.get(key)?.version === version) {
          this.layersOf.set(key, layer.layers);
          seen.add(key);
          continue;
        }
        this.layersOf.set(key, layer.layers);
        const tile = blockChunkTile({ key: layer.id, grid: layer.grid, origin: layer.origin, opaque: layer.opaque, version }, 0, ck, memo);
        this.want(seen, key, version, tile.min, tile.max, () => (tile.charts(), tile));
      }
    }
    this.terrains = [];
    const terrainIds = new Set<string>();
    for (const { id, field, layers } of this.deps.terrains()) {
      terrainIds.add(id);
      this.layersOf.set(id, layers);
      this.fields.set(id, field);
      const r = ringSourceOf(id, field);
      if (r !== null) this.terrains.push(r);
      this.terrainEdits(id, field);
    }
    for (const id of [...this.terrainTiles.keys()]) if (!terrainIds.has(id)) {
      this.terrainTiles.delete(id);
      this.fields.delete(id);
    }
    for (const a of this.deps.architecture()) {
      this.layersOf.set(a.id, a.layers);
      let version = this.componentVersions.get(a.component);
      if (version === undefined) this.componentVersions.set(a.component, (version = ++this.componentVersion));
      this.want(seen, a.id, version, a.origin, a.origin, () => architectureTile(a.id, version, architecturePiecesOf(a.component, a.origin)));
    }
    for (const m of this.deps.models()) {
      const file = this.file(m.assetId, m.version);
      if (file === null) continue;
      const version = placementHash(m.world, m.version);
      // The pieces with surfels (a piece without has no tile, and is never ready: it must not make the others new each listing).
      const lit = file.sets.filter((st) => st.surfels !== null && (st.surfels.levels[0] ?? 0) > 0).map((st) => st.piece);
      const pieces = m.piece !== null ? lit.filter((p) => p === m.piece) : lit;
      const fresh = pieces.every((piece) => {
        const key = `${m.id}/${piece}`;
        this.layersOf.set(key, m.layers);
        seen.add(key);
        return this.ready.get(key)?.version === version;
      });
      if (fresh) continue;
      for (const tile of modelPieceTiles({ key: m.id, worldToLocal: worldToLocalOfMatrix(m.world), bricks: file, piece: m.piece, version })) {
        if (tile.chart === null) continue;
        // A static object moved: where it was and where it is.
        const had = this.ready.get(tile.key);
        if (had !== undefined) this.geometry(had.min, had.max);
        this.geometry(tile.min, tile.max);
        this.ready.set(tile.key, tile);
        this.readyVersion += 1;
        this.changed = true;
      }
    }
    for (const [key, t] of [...this.ready]) if (!seen.has(key)) {
      this.ready.delete(key);
      this.readyVersion += 1;
      this.changed = true;
      this.geometry(t.min, t.max);
    }
    for (const key of [...this.pending.keys()]) if (!seen.has(key)) this.pending.delete(key);
    this.listed = true;
    this.placeProbes(false, now);
  }

  /**
   * The probes: a grid per room, and bricks where the static scene's
   * surfaces are (`probe-geometry.ts`: block layers' faces, architecture,
   * models, terrain near the eye). Placed again when a surface came, went
   * or changed, the terrain's window moved or the rooms changed, at most
   * every `PROBE_PLACE_MS` (a scene streaming in, a block dug live).
   */
  private placeProbes(force = false, now = performance.now()): void {
    const snap = brickSide(DEFAULT_PROBE_SPACING, PROBE_TERRAIN_SNAP_LEVEL);
    const c = this.probeCentre;
    if (c === null || Math.abs(this.eye[0]! - c[0]) > snap || Math.abs(this.eye[2]! - c[1]) > snap) this.probeCentre = [Math.round(this.eye[0]! / snap) * snap, Math.round(this.eye[2]! / snap) * snap];
    const centre = this.probeCentre!;
    const terrains = [...this.fields.keys()].map((id) => `${id}@${this.terrainVersions.get(id) ?? 0}`).join(',');
    const key = `${this.readyVersion}|${terrains}|${terrains.length > 0 ? centre.join(',') : ''}`;
    const placement = { key, geometry: () => this.probeGeometry(centre, snap) };
    if (force) {
      // The probes name rooms by index: placed over the new rooms at once (a placement being made is for the old ones).
      this.probeJob?.steps.return(false);
      this.probeJob = null;
      if (this.probes.place(placement, this.roomsNow)) this.probesPlacedAt = now;
      this.probesPlacedKey = key;
      this.probesWaiting = null;
      return;
    }
    if (key === this.probesPlacedKey || this.probeJob !== null) return;
    this.probesWaiting ??= now;
    // A changed tile leaves the ready set until it is made again (a frame or so): placed without it, its probes would
    // be dropped and placed again fresh a moment later. A scene that keeps streaming is placed at least every throttle.
    const making = this.pending.size > 0 && now - this.probesWaiting < PROBE_PLACE_MS;
    if (making || now - this.probesPlacedAt < PROBE_PLACE_MS) return;
    this.probeJob = { key, steps: this.probes.placeSteps(placement, this.roomsNow) };
    this.placeFrameMs = 0;
  }

  /** The placement being made, for this frame's share of main-thread time. */
  private stepProbeJob(now: number): void {
    const job = this.probeJob;
    if (job === null) return;
    const t0 = performance.now();
    for (;;) {
      const r = job.steps.next();
      this.placeFrameMs = Math.max(this.placeFrameMs, performance.now() - t0);
      if (r.done === true) {
        if (r.value) this.probesPlacedAt = now;
        this.probesPlacedKey = job.key;
        this.probeJob = null;
        // Settled once nothing newer waits (the next listing starts it).
        this.probesWaiting = null;
        return;
      }
      if (performance.now() - t0 >= PROBE_PLACE_SHARE_MS) return;
    }
  }

  /** What the probes are placed from: the ready tiles' surfaces, the terrains' near the eye, and what is solid (a tile a step). */
  private *probeGeometry(centre: readonly number[], snap: number): Steps<{ marks: ProbeMarks; solid: ProbeSolid }> {
    const marks = new ProbeMarks(DEFAULT_PROBE_SPACING);
    const arch: TraceArchitecture[] = [];
    const models: ProbeSolidModel[] = [];
    // The surfaces as they are now (tiles keep their charts; a later change places the probes again).
    const ready = [...this.ready.values()];
    const fields = [...this.fields.values()];
    const layers = this.deps.layers().map((l) => ({ grid: l.grid, origin: l.origin, opaque: l.opaque }));
    for (const t of ready) {
      yield;
      const kind = (t as { kind?: string }).kind;
      if (kind === 'blocks') blockTileMarks(t as BlockTile, marks);
      else if (kind === 'arch') {
        architectureMarks((t as ArchTile).pieces, marks);
        arch.push((t as ArchTile).pieces);
      } else if (kind === 'model') {
        marks.mark(t.min, t.max, 0);
        const m = t as ModelTile;
        models.push({ worldToLocal: m.worldToLocal, set: m.set, min: m.min, max: m.max });
      }
    }
    for (const field of fields) yield* terrainMarksSteps(field, centre, snap, marks);
    yield;
    return { marks, solid: probeSolid({ layers, terrains: fields, arch, models }, brickSide(DEFAULT_PROBE_SPACING, 0)) };
  }

  /** A terrain's tiles whose data changed (an edit, live or scripted), came or went since the last listing: their boxes changed. */
  private terrainEdits(id: string, field: TerrainField): void {
    const now = field.loadedTiles();
    const was = this.terrainTiles.get(id);
    this.terrainTiles.set(id, new Map(now));
    if (was === undefined) return;
    const [y0, y1] = field.heightSpan();
    const box = (key: string): void => {
      this.terrainVersions.set(id, (this.terrainVersions.get(id) ?? 0) + 1);
      const [x, z] = key.split(',').map(Number) as [number, number];
      const b = field.tileBounds(x, z);
      this.geometry([b[0], y0, b[1]], [b[2], y1, b[3]]);
    };
    for (const [key, t] of now) {
      const old = was.get(key);
      if (old === t) continue;
      // A field made again hands in new flat tiles, and paint changes colour only: same shape, no change of light, but
      // painted ground bounces its new colour.
      if (old !== undefined && sameShape(old, t)) {
        if (sameColour(old, t)) continue;
        const [x, z] = key.split(',').map(Number) as [number, number];
        const b = field.tileBounds(x, z);
        this.colours.changed([b[0], y0, b[1]], [b[2], y1, b[3]]);
        continue;
      }
      box(key);
    }
    for (const key of was.keys()) if (!now.has(key)) box(key);
  }

  /** A model's decoded file (null: none, or still being read). */
  private file(assetId: string, version: number): DistanceBricks | null {
    const key = `${assetId}@${version}`;
    const f = this.files.get(key);
    if (f !== undefined) return f === 'reading' ? null : f;
    const read = this.deps.bricks(assetId, version);
    if (read === null) {
      this.files.set(key, null);
      return null;
    }
    this.files.set(key, 'reading');
    read.then(
      (bytes) => {
        this.files.set(key, decodeDistanceBricks(bytes));
        this.touch();
      },
      () => this.files.set(key, null),
    );
    return null;
  }

  /** Makes waiting tiles' charts, nearest first, within the frame's share. */
  private prepare(eye: ArrayLike<number>, t0: number): void {
    this.prepareMs = 0;
    if (this.pending.size === 0) return;
    const d = (p: Pending): number => Math.hypot(Math.max(p.min[0]! - eye[0]!, 0, eye[0]! - p.max[0]!), Math.max(p.min[2]! - eye[2]!, 0, eye[2]! - p.max[2]!));
    const order = [...this.pending].sort((a, b) => d(a[1]) - d(b[1]));
    for (const [key, p] of order) {
      if (performance.now() - t0 >= SURFACE_PREPARE_MS) break;
      this.pending.delete(key);
      this.ready.set(key, p.make());
      this.readyVersion += 1;
      this.changed = true;
    }
    this.prepareMs = performance.now() - t0;
  }

  diagnostics(): SurfaceCacheHostDiagnostics {
    let reading = 0;
    for (const f of this.files.values()) if (f === 'reading') reading += 1;
    return { ...this.cache.diagnostics(), preparing: this.pending.size, reading, prepareMs: this.prepareMs, relight: this.relight.diagnostics(), probes: this.probesDiagnostics(), seeded: { tiles: this.seeding.seededTiles, probes: this.seeding.seededProbes } };
  }

  /** The probes' diagnostics; not settled while a placement waits (its new probes are yet to be lit). */
  private probesDiagnostics(): LiveProbeDiagnostics {
    const d = this.probes.diagnostics();
    const out = { ...d, placeFrameMs: this.placeFrameMs };
    return this.probesWaiting === null && this.probeJob === null ? out : { ...out, settled: false };
  }
}
