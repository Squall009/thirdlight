/**
 * A game page's voxel worlds as drawn: one chunk view a world, fed by the
 * batches the simulation sends (`@thirdlight/voxel` chunk-batch.ts). The
 * world runs with the simulation (a worker or the page itself); this side
 * only replaces chunk draws, a batch's all between the same two frames: in
 * the task it arrives in when making its draws fits what is left of the
 * frame's budget, else made over the next frames and shown whole in one
 * (voxel-batch-stage.ts), the batches after it waiting their turn.
 *
 * The views hang under the scene adapter's scene and draw in its world
 * coordinates, so a world's chunks lie where the scene's objects do; their
 * origin stays at the world origin and is never re-based. Precision far out
 * comes from the view's materials instead: they place vertices relative to
 * the camera with a model-view made in 64 bits (camera-relative.ts), which
 * a 32-bit re-base of the views alone could not give, since the GPU would
 * still subtract the camera's large position from theirs.
 *
 * With mip levels a batch also carries the coarser levels' node draws and
 * the seams between levels; a change of the levels drawn arrives whole in
 * one batch, so the old level is drawn until the new one is complete.
 *
 * Each world's material table is built from the project's material records
 * (`voxel-material-looks.ts`; ids without one draw their stand-in), given
 * and replaced with {@link VoxelWorldDraws.setMaterials}: a record changed
 * rewrites every world's table and nothing else (looks are shader data, so
 * no chunk is derived, meshed or uploaded again).
 *
 * The records' surface texture sets draw from three texture arrays (one a
 * map), made of every voxel material's sets (`voxelRecordTextures`), which
 * the host loads (`textures`: Play the build's assembled arrays, the editor
 * the backend's). Until they arrive, and for ids without a set, a surface
 * draws its flat colour; the arrays and the layers go in together, every
 * world's table rewritten once, no chunk derived or meshed again.
 *
 * Residency: the page's quality level names a texel density
 * (`levelVoxels(...).texelDensity`, the level read each frame through
 * `residency`);
 * each array is capped at the largest level within it
 * (`voxelArrayTopLevel`), and the page's texture streamer keeps what fits
 * its budget under the cap, by what the chunks drawn need. A level change
 * at run time moves the caps (lowered: the levels above go at once;
 * raised: they stream in, the old chain drawn until then).
 *
 * Kit pieces draw from one kit set for every world on the page (the
 * project's kits: every world derives with the engine's world rules, so
 * one piece table numbers them all), given and replaced with
 * {@link VoxelWorldDraws.setKits}.
 *
 * Decals: a world's draws are in the decal layers its `voxelWorld` object
 * sets, and its chunks' surfaces reach the scene's clipped decals, both
 * through the link the scene adapter keeps on its scene
 * (voxel-world-decals.ts); projected decals need nothing more, they mark
 * every lit draw of the scene their boxes reach.
 *
 * Every drawn chunk's GPU bytes go back to the simulation (`report`), where
 * they count as the chunk's mesh part of the world's stream budget; the
 * nodes' and seams' bytes go with them as one sum, counted in its mip share,
 * and the kit meshes' and textures' bytes, which every world on the page
 * draws from, counted whole in each world's budget (each must leave room for
 * them). They are reported again when kit meshes arrive (the pieces that
 * waited for them are built then) and when the kits change.
 *
 * Relief: the simulation's relief ring meshes sections finer near its
 * focus (relief-ring.ts); its chunks arrive with crease weights and the
 * surface moves them in the vertex stage (and in the shadow pass) by their
 * materials' heights and depths. Each batch that carries the ring's state
 * (`relief`: its steps, where it displaces now, its centre) sets the
 * world's fade, so the displacement ends before any section drawn plain.
 *
 * While a world is drawn, an animation-frame loop retires replaced grid
 * textures and records frame times, so an edit's way to the screen can be
 * measured: from the edit (the simulation's swap less its edit-to-swap ms)
 * over the hop to this page to the first frame drawn after the batch.
 */
import * as THREE from 'three';
import { frameSliceMs, residentBytes, threadProfiler, wallClock } from '@thirdlight/shared';
import { chunkGrid, FloatingOrigin, MATERIAL_BITS, reliefFade, SHADER_BORDER_CELLS, SHADER_READ_DEPTH_CELLS, shaderGridSide, SKY_NONE, SkyColumns, SUN_TILE_TEXELS, VOXEL_SIZE_M, WETNESS_MAX, type ChunkDrawBatch, type ChunkEdge, type ChunkReliefWire, type FarSeenWire } from '@thirdlight/voxel';
import { isStreamedTexture } from './texture-streaming';
import { VoxelChunkView, voxelStandInLook } from './voxel-chunk-view';
import { VoxelBatchStage, voxelBatchFrameMs } from './voxel-batch-stage';
import { DEFAULT_QUALITY_LEVELS, levelLighting, levelVoxels, qualityLevelOf, textureSlotSetKey, voxelArrayTopLevel, voxelWorldBlendMetres, VOXEL_TEXTURE_MAPS, type QualityLevelConfig, type TextureSlotSet, type VoxelSurfaceTextures, type VoxelTextureMap } from '@thirdlight/project-model';
import { voxelLooksKey, voxelRecordLooks, voxelRecordTextures, type VoxelLookRecord } from './voxel-material-looks';
import type { VoxelKitSet } from './voxel-kit-pieces';
import { voxelWorldDecalsOf } from './voxel-world-decals';
import { createVoxelSurface, type VoxelGridRenderer, type VoxelMaterialLook, type VoxelSurface, type VoxelSurfaceTextureArrays } from './voxel-surface';
import { voxelLightStoreFromUrl, voxelPathsFromUrl, voxelShadowsFromUrl, voxelStoreReadsTexels, voxelStoreUsesCache, voxelStoreUsesVolume, voxelSunFromUrl, type VoxelLightStore } from './voxel-surface-path';
import { handoverCacheReach, handoverRing, voxelHandoverFromUrl, type HandoverRing } from './voxel-light-handover';
import { setVoxelHandover } from './voxel-light-handover-nodes';
import { VoxelLightFeed } from './voxel-world-light';
import { SunFieldHost, type SunFieldRenderer } from './voxel-sun-field';
import { sceneShadowsOf, type SceneShadowLink } from './shadow-casters';
import { farFeedbackFromUrl } from './voxel-far-feedback';
import type { VoxelFarView } from './voxel-far-mesh';
import { farVisibilityFromUrl } from './voxel-far-visibility';
import { fineTextureFromUrl } from './voxel-far-fine-shade';
import { pageSearch } from './renderer-factory';
import { gpuPassHides } from './gpu-pass-hides';
import { fineDeviceOf } from './voxel-fine-bricks';
import { VoxelWalkGpu } from './voxel-walk-gpu';
import { VOLUME_PASS, VoxelLightVolume, type VolumeDevice } from './voxel-light-volume';
import type { RegionTextureRenderer } from './region-texture';
import { SURFACE_LIGHT_PASS, SURFACE_READ_URL_PARAM } from './adapter-surface-light';

/** One edit's way to the screen, as this page saw it (ms). */
export interface VoxelEditToScreen {
  readonly world: string;
  readonly groups: readonly number[];
  readonly sections: number;
  readonly chunks: number;
  /** Edit → swap where the world runs. */
  readonly swapMs: number;
  /** The batch's way from there to this page. */
  readonly hopMs: number;
  /** Replacing the batch's draws here. */
  readonly applyMs: number;
  /** Edit → the first frame drawn after the batch. */
  readonly visibleMs: number;
  /** Frames begun from the edit to that frame (1: the next frame showed it). */
  readonly frames: number;
}

export interface VoxelWorldDrawsOptions {
  /** The scene the views hang under (null until the adapter has one). */
  scene(): THREE.Scene | null;
  /** The renderer the shader grids upload through (null until it can draw). */
  renderer(): VoxelGridRenderer | null;
  /** Drawn chunks' GPU bytes for the simulation (`[cx, cy, cz, bytes]` repeated), every drawn node's and seam's summed, and the kit meshes' and textures'. */
  report(world: string, bytes: number[], coarse: number, kits: number): void;
  /** A round of a world's far field visibility feedback for where the world runs (absent: none is made). */
  farSeen?(world: string, seen: FarSeenWire): void;
  /** A world's fine far nodes cannot be built on this page (WebGL 2): where it runs, fine bricks go off. */
  fineUnavailable?(world: string): void;
  /** A batch was applied (a view drawing on demand draws a frame). */
  applied?(): void;
  /** The kit pieces every world draws (absent: none until {@link VoxelWorldDraws.setKits}). */
  readonly kits?: VoxelKitSet | null;
  /** The material records the worlds' tables are built from (absent: every id its stand-in until {@link VoxelWorldDraws.setMaterials}). */
  readonly materials?: readonly VoxelLookRecord[];
  /**
   * A map's texture array, assembled from its slot list (absent, or null back: that map's neutral value). Arrays
   * replaced by later records are handed to `release` (absent: the host keeps them, e.g. its loader's cache).
   */
  textures?(map: VoxelTextureMap, set: TextureSlotSet): Promise<THREE.Texture | null>;
  release?(texture: THREE.Texture): void;
  /** How the arrays are kept resident (absent: as loaded): the level's texel density and the streamer's cap. */
  readonly residency?: VoxelTextureResidency;
  /**
   * The worlds' surfaces and kit pieces cast and receive shadows (default false: the editor's Scene view): as static
   * casters of the scene's cached maps where its adapter keeps them, each draw's change reported where it stands;
   * and the key light's shadow square is centred on the worlds' ground under the camera. `?voxelShadows=off` turns
   * it off on a page (a comparison).
   */
  readonly shadows?: boolean;
  /**
   * The worlds' near surfaces may be lit by the page's lighting store (default false: the editor's Scene view): with
   * `?voxelLight=cache` on WebGPU the scene's surface cache lights them (voxel-world-light.ts); the default store
   * (`off`) draws them as before.
   */
  readonly lighting?: boolean;
}

/** The page's say over the voxel texture arrays' resident levels. */
export interface VoxelTextureResidency {
  /** The quality level drawn (null: none known, the arrays uncapped): read every frame, a change applies at once. */
  level(): QualityLevelConfig | null;
  /** Cap a streamed texture at a level (`TextureStreamer.limit`); a texture that does not stream ignores it. */
  limit(texture: THREE.Texture, level: number): void;
}

/**
 * Caps each voxel texture array at the largest level `texelsPerMetre` keeps (Infinity: uncapped) through `limit`;
 * the caps by map. Every host drawing voxel arrays caps them this way.
 */
export function capVoxelArrays(arrays: VoxelSurfaceTextureArrays, texelsPerMetre: number, limit: (texture: THREE.Texture, level: number) => void): Partial<Record<VoxelTextureMap, number>> {
  const tops: Partial<Record<VoxelTextureMap, number>> = {};
  for (const map of VOXEL_TEXTURE_MAPS) {
    const t = arrays[map];
    if (t === undefined) continue;
    // The authored size: a streamed texture's file, else what was uploaded.
    const edge = isStreamedTexture(t) && t.stream !== null ? t.stream.layout.width : ((t.image as { width?: number } | null)?.width ?? 0);
    tops[map] = Number.isFinite(texelsPerMetre) ? voxelArrayTopLevel(edge, texelsPerMetre) : 0;
    limit(t, tops[map]);
  }
  return tops;
}

/** The quality level of `levels` (absent: the engine's) named `id` (else the highest) and the voxel texel density it keeps. */
export function voxelTexelDensityAt(id: string | null, levels: readonly QualityLevelConfig[] = DEFAULT_QUALITY_LEVELS): { readonly level: string; readonly texelDensity: number } {
  const l = qualityLevelOf(levels, id);
  return { level: l.id, texelDensity: levelVoxels(l).texelDensity };
}

/** One world as drawn: objects (chunks and nodes of every level), per level, seams, triangles (seams included). */
export interface VoxelWorldDrawStats {
  readonly chunks: number;
  readonly levels: readonly number[];
  readonly seams: number;
  readonly triangles: number;
  readonly seamTriangles: number;
  readonly instances: number;
  /** Of them kit pieces, and the piece draws (one a piece kind across the chunks, a draw call each a pass). */
  readonly kitInstances: number;
  readonly pieceDraws: number;
  /** Of them, as the view last drew: the draws it drew some of and the instances it drew. */
  readonly pieceDrawsInView: number;
  readonly piecesInView: number;
  readonly meshBuilds: number;
  readonly shaderSets: number;
  /** Surface draws by their program's path (`materials-projection`, voxel-surface-path.ts). */
  readonly paths: Record<string, number>;
  /** Material table uploads (a record changed) and the ms the last one took. */
  readonly tableUploads: number;
  readonly tableMs: number;
  /** Metres its materials blend over where none sets its own (its `voxelWorld` object's, else the default). */
  readonly blendM: number;
  /** Layers of the texture arrays drawn (0: none yet), and whether the program draws texture sets. */
  readonly textureLayers: number;
  readonly textured: boolean;
  /** The texel density the arrays are capped at (null: no residency) and each array's cap (largest level kept). */
  readonly texelDensity: number | null;
  readonly textureTops: Readonly<Partial<Record<VoxelTextureMap, number>>>;
  /** The relief ring as last told (null: not yet): steps, where it displaces (metres), whether it moves; the vertices drawn displaceable. */
  readonly relief: { readonly n: number; readonly radiusM: number; readonly displace: boolean; readonly vertices: number } | null;
  /** The far field as drawn: nodes, bricks and triangles (bricks draw none), draws, GPU bytes and the times the brick atlas gave space back. */
  readonly far: { readonly nodes: number; readonly bricks: number; readonly triangles: number; readonly draws: number; readonly gpuBytes: number; readonly trims: number; readonly covered: number; readonly cover: { readonly hidden: number; readonly edge: number }; readonly pass: 'visibility' | 'half' | 'direct'; readonly visibilityBytes: number; readonly feedback: VoxelFarView['feedbackStats']; readonly fine: VoxelFarView['fineState']; readonly fineBaked: { readonly drawn: readonly number[]; readonly read: number } };
}

interface WorldDraw {
  readonly view: VoxelChunkView;
  /** Its chunks' edge (cells), and whether its draws are WebGPU's (the cache lights only those). */
  readonly edge: number;
  readonly webgpu: boolean;
  readonly surface: VoxelSurface;
  /** The nodes' and seams' GPU bytes last reported, and the kits'. */
  coarse: number;
  kits: number;
  /** The relief ring as the last batch told it (null: not yet). */
  relief: ChunkReliefWire | null;
  /** Stops following the world's decal layers. */
  unlink: () => void;
}

/** A batch received and not shown yet: its stage once its draws are being made. */
interface Waiting {
  readonly b: ChunkDrawBatch;
  readonly at: number;
  stage: VoxelBatchStage | null;
  /** ms spent making it so far. */
  ms: number;
}

/** Frame intervals the staging budget is taken from (the median of the newest). */
const BUDGET_FRAMES = 8;
/** The batches made into draws and the shader grids uploaded, as spans of the page's thread. */
const VOXEL_DRAWS_SPAN = threadProfiler.span('voxel draws made', 'voxelApply');
const VOXEL_GRIDS_SPAN = threadProfiler.span('voxel grids uploaded', 'voxelApply');
/** The sun heights composed and uploaded (voxel-sun-field.ts), a span of the page's thread. */
const VOXEL_SUN_SPAN = threadProfiler.span('voxel sun heights', 'lighting');

/** Edits kept for measurements. */
const EDITS_KEPT = 64;
/** Frame times kept (wall-clock ms): a few seconds at a high refresh rate. */
const FRAMES_KEPT = 600;

export class VoxelWorldDraws {
  private readonly worlds = new Map<string, WorldDraw>();
  /** Batches waiting for the renderer (the adapter starts asynchronously) or for their draws to be made, oldest first. */
  private readonly waiting: Waiting[] = [];
  /** ms spent making and showing batches since the last animation frame. */
  private spent = 0;
  /** Batches made over more than one frame, the most frames one took, and the longest ms showing one took (its commit) and making a step of one. */
  readonly staging = { spread: 0, framesMax: 0, commitMsMax: 0, prepareMsMax: 0 };
  private readonly frameTimes: number[] = [];
  /** Edits drawn, waiting for the frame that shows them. */
  private unseen: { e: Omit<VoxelEditToScreen, 'visibleMs' | 'frames'>; editAt: number }[] = [];
  private raf: number | null = null;
  private disposed = false;
  readonly edits: VoxelEditToScreen[] = [];
  batches = 0;
  /** Batches applied and level-0 chunk draws replaced (shader-only included). */
  applied = 0;
  replaced = 0;
  private kitSet: VoxelKitSet | null = null;
  private kitLoaded: (() => void) | null = null;
  private looks: (material: number) => VoxelMaterialLook = voxelStandInLook;
  private looksKey = '';
  /** The texture arrays drawn, the layers with them, and the key of the sets they were made of. */
  private arrays: { readonly key: string; readonly textures: VoxelSurfaceTextureArrays; readonly layers: VoxelSurfaceTextures['layers']; readonly count: number } | null = null;
  /** The key of the sets asked for last (a load that finds another key asked meanwhile is dropped). */
  private arraysWanted = '';
  /** Texture array loads finished, failed, and the ms the last took (diagnostics). */
  textureLoads = 0;
  textureFailures = 0;
  textureLoadMs = 0;
  /** The density the arrays were last capped at and their caps by map. */
  private density: number | null = null;
  private tops: Partial<Record<VoxelTextureMap, number>> = {};
  /** Whether relief vertices move (false: the relief meshes draw flat; a view's switch). */
  private displace = true;
  private readonly focus = new THREE.Vector3();

  /** The near and far draws' entries in the page's GPU measurement (taken out on dispose). */
  private readonly unregister: (() => void)[] = [];
  /** Each world's occupancy walk blocks on the GPU (WebGPU only; voxel-walk-gpu.ts). */
  private readonly walks = new Map<string, VoxelWalkGpu>();
  /** Each world's sky heights by chunk column, as the batches bring them (every renderer: plain arrays). */
  private readonly skies = new Map<string, SkyColumns>();
  /** The page's lighting store, and the surface cache's feed when it is the cache (made with the first world on WebGPU). */
  lightStore: VoxelLightStore;
  private light: VoxelLightFeed | null = null;
  /** The scene shadow link whose ground this page tells (taken back on dispose). */
  private groundLink: SceneShadowLink | null = null;
  private readonly ground = (x: number, z: number): number | null => this.groundAt(x, z);
  /** The sun heights the key light's march reads past its map (WebGPU game pages with voxel shadows; null: none). */
  private sun: SunFieldHost | null = null;
  /** The voxel light volume when it is the store (made with the first world walked on WebGPU), and that world. */
  private volume: VoxelLightVolume | null = null;
  private volumeWorld: string | null = null;
  /** The hand-over distance in place of the tier's (`?voxelLightHandover=`, or a check's; null: the tier's). */
  private handoverM: number | null = null;

  constructor(private readonly opts: VoxelWorldDrawsOptions) {
    this.lightStore = opts.lighting === true ? voxelLightStoreFromUrl(pageSearch()) : 'off';
    this.handoverM = voxelHandoverFromUrl(pageSearch());
    // The fade's uniforms are set every frame (the tier's distance is read from the page, not at hand while it is made).
    this.unregister.push(
      gpuPassHides.register({ category: 'near', name: 'voxel near surfaces and kit pieces', present: () => [...this.worlds.values()].some((w) => w.view.count > 0), hide: (h) => this.showNear(!h) }),
      gpuPassHides.register({ category: 'far', name: 'voxel far field', present: () => [...this.worlds.values()].some((w) => w.view.far.nodes > 0), hide: (h) => this.showFar(!h) }),
      // The walk's blocks are a share of the chunks drawn (a page a mixed block), held on the page and the GPU.
      residentBytes.register('voxelStream', () => {
        let n = 0;
        for (const g of this.walks.values()) n += g.table.bytes + g.gpuBytes;
        for (const k of this.skies.values()) n += k.bytes;
        return n;
      }),
    );
    this.setKits(opts.kits ?? null);
    if (opts.materials !== undefined) this.setMaterials(opts.materials);
  }

  /**
   * The worlds' material tables from these records from now on: each open world's table is rewritten and uploaded
   * (nothing else changes); records whose looks read the same change nothing. False: nothing changed.
   */
  setMaterials(materials: readonly VoxelLookRecord[]): boolean {
    const key = voxelLooksKey(materials);
    if (key === this.looksKey) return false;
    this.looksKey = key;
    this.looks = voxelRecordLooks(materials);
    for (const w of this.worlds.values()) w.surface.setLooks(this.looks);
    this.loadTextures(materials);
    this.opts.applied?.();
    return true;
  }

  /** The arrays of the records' surface sets, loaded and drawn when they arrive (the same sets: nothing loaded). */
  private loadTextures(materials: readonly VoxelLookRecord[]): void {
    const made = this.opts.textures === undefined ? null : voxelRecordTextures(materials);
    const key = made === null ? '' : JSON.stringify([VOXEL_TEXTURE_MAPS.map((m) => (made.sets[m] === undefined ? '' : textureSlotSetKey(made.sets[m]))), [...made.layers]]);
    if (key === this.arraysWanted) return;
    this.arraysWanted = key;
    if (made === null) {
      this.drawArrays(null);
      return;
    }
    const t0 = performance.now();
    void Promise.all(VOXEL_TEXTURE_MAPS.map(async (map) => [map, made.sets[map] === undefined ? null : await this.opts.textures!(map, made.sets[map])] as const))
      .then((loaded) => {
        const textures: VoxelSurfaceTextureArrays = Object.fromEntries(loaded.filter(([, t]) => t !== null));
        if (this.disposed || this.arraysWanted !== key) {
          for (const [, t] of loaded) if (t !== null) this.opts.release?.(t);
          return;
        }
        this.textureLoads++;
        this.textureLoadMs = performance.now() - t0;
        this.drawArrays({ key, textures, layers: made.layers, count: made.sets.albedo.layers.length });
      })
      .catch(() => {
        // A failed array leaves the surfaces on their flat colours (the host reports the failure where it loads).
        if (this.arraysWanted === key) this.textureFailures++;
      });
  }

  /** Every world draws these arrays (null: none) from now on; the arrays they replace are released. */
  private drawArrays(next: typeof this.arrays): void {
    const old = this.arrays;
    this.arrays = next;
    for (const w of this.worlds.values()) this.giveArrays(w.surface);
    if (old !== null) for (const t of Object.values(old.textures)) if (t !== undefined && !Object.values(next?.textures ?? {}).includes(t)) this.opts.release?.(t);
    this.density = null;
    this.capArrays();
    this.opts.applied?.();
  }

  /** Each array capped at the level the quality level's texel density keeps (nothing when unchanged). */
  private capArrays(): void {
    const r = this.opts.residency;
    if (r === undefined || this.arrays === null) return;
    const level = r.level();
    const density = level === null ? Infinity : levelVoxels(level).texelDensity;
    if (density === this.density) return;
    this.density = density;
    this.tops = capVoxelArrays(this.arrays.textures, density, r.limit);
  }

  private giveArrays(surface: VoxelSurface): void {
    const a = this.arrays;
    surface.setTextures(a === null ? null : a.textures, (m) => a?.layers.get(m) ?? null);
  }

  /** Relief vertices move (true, the default) or draw flat in every world (a view's switch; the meshes are the same). */
  setRelief(s: { readonly displace: boolean }): void {
    this.displace = s.displace;
    for (const w of this.worlds.values()) w.surface.setRelief({ displace: s.displace });
    this.opts.applied?.();
  }

  /** Shows or hides every world's near field draws (chunks, seams, kit pieces; nothing is rebuilt). */
  showNear(on: boolean): void {
    for (const w of this.worlds.values()) w.view.showNear(on);
    this.opts.applied?.();
  }

  /** The far node drawn at a world point (metres) of a world and whether the point is inside its solid (null: none drawn there; a coverage check). */
  farSolidAt(world: string, x: number, y: number, z: number): { level: number; inside: boolean } | null {
    return this.worlds.get(world)?.view.far.solidAt(x / VOXEL_SIZE_M, y / VOXEL_SIZE_M, z / VOXEL_SIZE_M) ?? null;
  }

  /** Every world's next visibility feedback round also reduces its target on the CPU (`feedback.check` in the stats: the GPU's reduction checked). */
  checkFarFeedback(): void {
    for (const w of this.worlds.values()) w.view.far.checkFeedback();
  }

  /** Every world's near field and far field draws now (a measuring run draws them again, gpu-headroom.ts). */
  roots(): { readonly near: THREE.Object3D[]; readonly far: THREE.Object3D[] } {
    const worlds = [...this.worlds.values()];
    return { near: worlds.flatMap((w) => w.view.nearObjects()), far: worlds.map((w) => w.view.far.root) };
  }

  /** Shows or hides every world's far field draws (a picture of the near field alone; nothing is rebuilt). */
  showFar(on: boolean): void {
    for (const w of this.worlds.values()) w.view.far.setVisible(on);
    this.opts.applied?.();
  }

  /** A world's surface displaces by the ring as told: its steps, and the fade over the metres before where it displaces now. */
  private giveRelief(w: WorldDraw, r: ChunkReliefWire): void {
    w.relief = r;
    const f = reliefFade(r.radius);
    w.surface.setRelief({ n: Math.max(1, r.n), focus: this.focus.set(r.focus[0] * VOXEL_SIZE_M, r.focus[1] * VOXEL_SIZE_M, r.focus[2] * VOXEL_SIZE_M), fadeStartM: f.start * VOXEL_SIZE_M, fadeEndM: f.end * VOXEL_SIZE_M });
  }

  /** Every world draws its kit pieces from `set` from now on (each view as {@link VoxelChunkView.setKits}); meshes arriving later draw a frame. */
  setKits(set: VoxelKitSet | null): void {
    this.kitLoaded?.();
    this.kitSet = set;
    // The views build their waiting pieces first (they subscribed before this): then a view drawing on demand draws them.
    this.kitLoaded = set === null ? null : set.meshes.onLoaded(() => this.opts.applied?.());
    for (const w of this.worlds.values()) w.view.setKits(set);
    this.opts.applied?.();
  }

  /** The kit meshes' and textures' GPU bytes (every world draws from them). */
  private kitBytes(): number {
    return this.kitSet?.meshes.gpuBytes() ?? 0;
  }

  /** A view built the pieces that waited for kit meshes (or took new kits): its draws' bytes and the kits' go back again. */
  private rebuilt(name: string): void {
    const w = this.worlds.get(name);
    if (w === undefined) return;
    w.coarse = w.view.coarseBytes();
    w.kits = this.kitBytes();
    this.opts.report(name, w.view.chunkBytes(), w.coarse, w.kits);
  }

  /**
   * A batch from the simulation: shown now when the renderer can take it and its draws fit the frame's budget, else
   * made over the next frames and shown whole in one; later batches wait for it.
   */
  receive(b: ChunkDrawBatch): void {
    if (this.disposed) return;
    this.batches++;
    this.waiting.push({ b, at: wallClock(), stage: null, ms: 0 });
    this.pump();
    this.loop();
  }

  /**
   * Makes and shows waiting batches in order within what is left of this frame's budget (at least one draw a frame,
   * so a batch always moves on). Without animation frames (a test, a worker) every batch is shown whole at once.
   */
  private pump(): void {
    if (this.waiting.length === 0) return;
    threadProfiler.begin(VOXEL_DRAWS_SPAN);
    this.pumpWithin();
    threadProfiler.end(VOXEL_DRAWS_SPAN);
  }

  private pumpWithin(): void {
    const frames = typeof requestAnimationFrame === 'function';
    const budget = voxelBatchFrameMs(this.frameInterval());
    while (this.waiting.length > 0) {
      // Past the budget nothing more is made until the next frame (which begins with none spent, so it makes at least one draw).
      if (frames && this.spent >= budget) return;
      const w = this.waiting[0]!;
      const t0 = performance.now();
      const shown = this.step(w, frames ? () => this.spent + (performance.now() - t0) < budget : () => true);
      const ms = performance.now() - t0;
      this.spent += ms;
      w.ms += ms;
      if (!shown) return;
      this.waiting.shift();
    }
  }

  /** The median of the page's newest frame intervals (null: too few frames yet). */
  private frameInterval(): number | null {
    const t = this.frameTimes;
    if (t.length <= BUDGET_FRAMES) return null;
    const d = Array.from({ length: BUDGET_FRAMES }, (_, i) => t[t.length - 1 - i]! - t[t.length - 2 - i]!).sort((a, b) => a - b);
    return d[BUDGET_FRAMES >> 1]!;
  }

  private loop(): void {
    if (this.raf !== null || this.disposed || typeof requestAnimationFrame !== 'function') return;
    const tick = (): void => {
      this.raf = null;
      if (this.disposed) return;
      const now = wallClock();
      this.frameTimes.push(now);
      if (this.frameTimes.length > FRAMES_KEPT) this.frameTimes.splice(0, this.frameTimes.length - FRAMES_KEPT);
      for (const u of this.unseen) {
        const frames = this.frameTimes.filter((t) => t > u.editAt).length;
        this.edits.push(Object.freeze({ ...u.e, visibleMs: now - u.editAt, frames }));
      }
      this.unseen = [];
      if (this.edits.length > EDITS_KEPT) this.edits.splice(0, this.edits.length - EDITS_KEPT);
      this.spent = 0;
      this.pump();
      threadProfiler.begin(VOXEL_GRIDS_SPAN);
      for (const w of this.worlds.values()) w.surface.grids.frame();
      threadProfiler.end(VOXEL_GRIDS_SPAN);
      this.sunFrame();
      setVoxelHandover(this.handover());
      this.volumeFrame();
      this.capArrays();
      if (this.worlds.size > 0 || this.waiting.length > 0) this.loop();
    };
    this.raf = requestAnimationFrame(tick);
  }

  /** The sun heights' share of the frame: the tier's samples, tiles composed within the lighting preparation slice, uploads. */
  private sunFrame(): void {
    const sun = this.sun;
    if (sun === null) return;
    const level = this.opts.residency?.level() ?? null;
    sun.setTier(level === null ? 0 : levelLighting(level).voxelSunSteps);
    threadProfiler.begin(VOXEL_SUN_SPAN);
    const t0 = performance.now();
    const budget = frameSliceMs('surfacePrepare');
    sun.field.frame(() => performance.now() - t0 < budget, this.opts.renderer() as unknown as SunFieldRenderer | null);
    threadProfiler.end(VOXEL_SUN_SPAN);
  }

  /**
   * Where the page hands its voxel worlds' light over from the surface cache to the light volume (both stores on:
   * `hybrid`), from the tier's distance or the one set in its place; null: one store lights everything.
   */
  handover(): HandoverRing | null {
    if (this.lightStore !== 'hybrid') return null;
    const level = this.opts.residency?.level() ?? null;
    const d = this.handoverM ?? levelLighting(level ?? {}).voxelLightHandoverM;
    return handoverRing(d);
  }

  /** The hand-over distance from now on in place of the tier's (null: the tier's again; a check's or a bench's). */
  setHandover(m: number | null): void {
    this.handoverM = m !== null && Number.isFinite(m) && m > 0 ? m : null;
    setVoxelHandover(this.handover());
    this.opts.applied?.();
  }

  /**
   * These stores' GPU passes held (not dispatched, not present to the page's GPU measurement) until called again
   * without them: the hybrid's `lighting` read one store at a time (empty: none held).
   */
  holdStorePasses(stores: readonly string[]): void {
    gpuPassHides.hold([...(stores.includes('cache') ? [SURFACE_LIGHT_PASS] : []), ...(stores.includes('volume') ? [VOLUME_PASS] : [])]);
  }

  /** The share of the tier's GPU `lighting` row each store's update takes: the row is split between the stores on. */
  private rowShare(): number {
    const on = (voxelStoreUsesCache(this.lightStore) ? 1 : 0) + (voxelStoreUsesVolume(this.lightStore) ? 1 : 0);
    return 1 / Math.max(1, on);
  }

  /** With a store that uses the volume: the volume made once a world walks on the GPU, and its frame's share. */
  private volumeFrame(): void {
    if (!voxelStoreUsesVolume(this.lightStore) || this.opts.lighting !== true) return;
    if (this.volume === null) {
      const world = [...this.walks.keys()][0];
      const renderer = this.opts.renderer();
      const scene = this.opts.scene();
      const device = renderer === null ? null : fineDeviceOf(renderer);
      if (world === undefined || renderer === null || scene === null || device === null || this.walks.get(world)!.buffers() === null) return;
      this.volumeWorld = world;
      this.volume = new VoxelLightVolume({ scene, renderer: renderer as unknown as RegionTextureRenderer, device: device as VolumeDevice, walk: () => this.walks.get(world) ?? null, level: () => this.opts.residency?.level() ?? null, look: (m) => this.looks(m), ground: (x, z) => this.groundAt(x, z), read: new URLSearchParams(pageSearch()).get(SURFACE_READ_URL_PARAM) !== '0', handover: () => this.handover(), rowShare: () => this.rowShare() });
      // The grids of chunks drawn before it came are not at hand: their bricks bounce the default grey until drawn again.
    }
    this.volume.frame();
  }

  /** The voxel light volume (null: the store is not the volume, or not made yet). */
  lightVolume(): VoxelLightVolume | null {
    return this.volume;
  }

  /** The sun march off (true) or back to the tier's (a page hook's comparison). */
  setSunOff(off: boolean): void {
    this.sun?.setOff(off);
    this.opts.applied?.();
  }

  /** The sun field's CPU reference at a world point (null: no field; a check of what the compute pass writes). */
  sunProbe(p: readonly number[]): ReturnType<SunFieldHost['field']['probe']> | null {
    return this.sun?.field.probe(p) ?? null;
  }

  /** The sun field as drawn (null: none on this page). */
  sunStats(): { readonly steps: number; readonly waiting: readonly number[]; readonly marching: number; readonly farNodes: number; readonly nearOrigin: readonly number[]; readonly farOrigin: readonly number[]; readonly bytes: number; readonly topMax: number; readonly stats: Record<string, number> } | null {
    const s = this.sun;
    return s === null ? null : { steps: s.steps, waiting: [...s.field.waiting], marching: s.field.marching, farNodes: s.field.far.count, nearOrigin: s.field.near.origin, farOrigin: s.field.far.window.origin, bytes: s.field.bytes, topMax: Math.max(s.field.near.topMax, s.field.far.window.topMax), stats: { ...s.field.stats } };
  }

  private world(name: string, edge: number, scene: THREE.Scene, renderer: VoxelGridRenderer): WorldDraw {
    let w = this.worlds.get(name);
    if (w !== undefined) return w;
    const grid = chunkGrid(edge as ChunkEdge);
    const surface = createVoxelSurface({ cellMetres: VOXEL_SIZE_M, side: shaderGridSide(edge), border: SHADER_BORDER_CELLS, materialBits: MATERIAL_BITS, wetnessMax: WETNESS_MAX, readDepthCells: SHADER_READ_DEPTH_CELLS }, { look: this.looks, blendMetres: voxelWorldDecalsOf(scene)?.blendOf(name) ?? voxelWorldBlendMetres(null), relief: true });
    // Nothing is displaced until the ring is told (a relief mesh arrives only with or after it).
    surface.setRelief({ displace: this.displace, fadeStartM: 0, fadeEndM: 0 });
    if (this.arrays !== null) this.giveArrays(surface);
    // Per-draw programs on WebGPU only: WebGL 2 keeps the one program it drew with.
    const webgpu = (renderer as unknown as { backend?: { isWebGPUBackend?: boolean } }).backend?.isWebGPUBackend === true;
    const shadows = this.opts.shadows === true && voxelShadowsFromUrl(pageSearch());
    const link = shadows ? sceneShadowsOf(scene) : null;
    if (link !== null && link.ground === null) {
      link.ground = this.ground;
      this.groundLink = link;
    }
    const view = new VoxelChunkView({ grid, origin: new FloatingOrigin({ grid }), surface, renderer, kits: this.kitSet, fastPaths: webgpu && voxelPathsFromUrl(pageSearch()), shadows, staticShadows: link?.revision ?? null, farVisibility: farVisibilityFromUrl(pageSearch()), ...(this.opts.farSeen !== undefined && farFeedbackFromUrl(pageSearch()) ? { onFarSeen: (seen: FarSeenWire) => this.opts.farSeen!(name, seen) } : {}), ...(this.opts.fineUnavailable !== undefined ? { onFineUnavailable: () => this.opts.fineUnavailable!(name) } : {}), ...((t) => (t !== null ? { fineTexture: t } : {}))(fineTextureFromUrl(pageSearch())) });
    view.rebuilt = () => this.rebuilt(name);
    // `?voxelSun=off` makes none (a comparison draws as before the field).
    if (webgpu && link !== null && edge === SUN_TILE_TEXELS && voxelSunFromUrl(pageSearch())) {
      this.sun ??= new SunFieldHost(scene, link, edge, VOXEL_SIZE_M, () => this.skies.values(), {
        // Its march sits inside every sun-lit program: the measurement's hide skips it there.
        hide: (h) => gpuPassHides.register({ category: 'shadows', name: 'voxel sun march', present: () => (this.sun?.steps ?? 0) > 0, hide: h }),
        bytes: (read) => residentBytes.register('voxelStream', read),
      });
      const sun = this.sun;
      view.far.nodesChanged = (added, removed) => {
        for (const k of removed) sun.field.farRemoved(`${name}|${k}`);
        for (const a of added) sun.field.farAdded(`${name}|${a.key}`, a.node, a.bricks);
      };
    }
    view.root.name = `voxel-world ${name}`;
    scene.add(view.root);
    const decals = voxelWorldDecalsOf(scene);
    view.setDecalLayers(decals?.layersOf(name));
    this.lightWorld(name, view, edge, webgpu, scene);
    // The world's object changed its layers or blend: both are draw data (no remesh; the blend a uniform).
    const unlink = decals?.onChange((world) => {
      if (world !== name) return;
      view.setDecalLayers(decals.layersOf(name));
      surface.setBlendMetres(decals.blendOf(name));
      this.opts.applied?.();
    }) ?? ((): void => undefined);
    this.worlds.set(name, (w = { view, edge, webgpu, surface, coarse: 0, kits: 0, relief: null, unlink }));
    return w;
  }

  /** A world's sky heights (null: none arrived yet). */
  sky(world: string): SkyColumns | null {
    return this.skies.get(world) ?? null;
  }

  /**
   * The ground under world point (x, z) in metres: the top of the highest solid cell there that a world drawn here
   * knows (null: none knows the column, or nothing is solid in it).
   */
  groundAt(x: number, z: number): number | null {
    let top: number | null = null;
    for (const k of this.skies.values()) {
      const h = k.heightAt(Math.floor(x / VOXEL_SIZE_M), Math.floor(z / VOXEL_SIZE_M));
      if (h !== null && h > SKY_NONE && (top === null || h * VOXEL_SIZE_M > top)) top = h * VOXEL_SIZE_M;
    }
    return top;
  }

  /** Who hears of a world's level-0 surfaces: its decals, and with the cache store on WebGPU the surface cache beside them. */
  private lightWorld(name: string, view: VoxelChunkView, edge: number, webgpu: boolean, scene: THREE.Scene): void {
    const decals = voxelWorldDecalsOf(scene)?.surfaces ?? null;
    if (!webgpu || !voxelStoreUsesCache(this.lightStore)) {
      view.setDecalSurfaces(decals);
      return;
    }
    this.light ??= new VoxelLightFeed({ buffers: (world) => this.walks.get(world)?.buffers() ?? null, source: (world) => this.walks.get(world)?.table.source() ?? null, table: (world) => this.walks.get(world)?.table ?? null, worlds: () => this.walks.keys() }, () => this.opts.residency?.level() ?? null, {
      reach: () => ((r) => (r === null ? null : handoverCacheReach(r)))(this.handover()),
      rowShare: () => this.rowShare(),
      read: voxelStoreReadsTexels(this.lightStore),
    });
    view.setDecalSurfaces(this.light.surfaces(name, edge, decals));
    this.light.link(scene);
  }

  /**
   * The lighting store from now on (the page's query sets the first): drawn worlds' surfaces go to the surface
   * cache or leave it (a bench or a check compares the stores on one page without loading it again).
   */
  setLightStore(store: VoxelLightStore): void {
    if (this.opts.lighting !== true || store === this.lightStore) return;
    const was = voxelStoreUsesCache(this.lightStore);
    const wasRead = voxelStoreReadsTexels(this.lightStore);
    this.lightStore = store;
    setVoxelHandover(this.handover());
    if (!voxelStoreUsesVolume(store)) this.dropVolume();
    const scene = this.opts.scene();
    if (scene === null || (was === voxelStoreUsesCache(store) && wasRead === voxelStoreReadsTexels(store))) return;
    if (was) {
      this.light?.unlink();
      this.light = null;
    }
    for (const [name, w] of this.worlds) this.lightWorld(name, w.view, w.edge, w.webgpu, scene);
  }

  private dropVolume(): void {
    this.volume?.dispose();
    this.volume = null;
    this.volumeWorld = null;
  }

  /** The surface cache's feed of the worlds' surfaces (null: the store is not the cache, or not WebGPU). */
  lightFeed(): VoxelLightFeed | null {
    return this.light;
  }

  /** A world's occupancy walk on the GPU (null: none yet, or not WebGPU). */
  walk(world: string): VoxelWalkGpu | null {
    return this.walks.get(world) ?? null;
  }

  /** A batch's walk blocks into its world's GPU walk (WebGL 2: none, the blocks are dropped). */
  private applyWalk(world: string, wires: ChunkDrawBatch['walk']): void {
    if (wires === undefined || wires.length === 0) return;
    let g = this.walks.get(world);
    if (g === undefined) {
      const r = this.opts.renderer();
      const device = r === null ? null : fineDeviceOf(r);
      if (device === null) return;
      g = new VoxelWalkGpu(device as ConstructorParameters<typeof VoxelWalkGpu>[0]);
      this.walks.set(world, g);
    }
    const v = world === this.volumeWorld ? this.volume : null;
    const was = v?.beforeWalk(g.table, wires) ?? null;
    g.apply(wires);
    if (was !== null) v!.afterWalk(g.table, was);
  }

  private close(name: string): void {
    if (name === this.volumeWorld) this.dropVolume();
    this.walks.get(name)?.dispose();
    this.walks.delete(name);
    this.skies.delete(name);
    this.light?.dropWorld(name);
    this.sun?.field.far.removePrefixed(`${name}|`);
    const w = this.worlds.get(name);
    if (w === undefined) return;
    for (const q of this.waiting) if (q.stage?.view === w.view) q.stage.discard();
    this.worlds.delete(name);
    w.unlink();
    w.view.root.removeFromParent();
    w.view.dispose();
    w.surface.dispose();
  }

  /**
   * Makes more of a waiting batch's draws while `more()` says so and shows the batch once they are all made; true
   * when it was shown. False also while the renderer or the scene is not there yet (nothing was made).
   */
  private step(q: Waiting, more: () => boolean): boolean {
    const b = q.b;
    if (b.closed === true) {
      this.close(b.world);
      this.opts.applied?.();
      return true;
    }
    if (q.stage === null) {
      const scene = this.opts.scene();
      const renderer = this.opts.renderer();
      if (scene === null || renderer === null) return false;
      q.stage = new VoxelBatchStage(this.world(b.world, b.edge, scene, renderer).view, b);
    }
    const t0 = performance.now();
    const ready = q.stage.prepare(more);
    this.staging.prepareMsMax = Math.max(this.staging.prepareMsMax, performance.now() - t0);
    if (!ready) return false;
    const w = this.worlds.get(b.world)!;
    if (b.relief !== undefined) this.giveRelief(w, b.relief);
    if (b.world === this.volumeWorld && this.volume !== null) for (const c of b.chunks) if ((c.level ?? 0) === 0) this.volume.chunkGrid(c.cx, c.cy, c.cz, c.kind === 'remove' ? null : (c.cells ?? null), c.kind === 'remove' ? -1 : (c.solid ?? (c.cells !== undefined ? -1 : 0)));
    this.applyWalk(b.world, b.walk);
    if (b.sky !== undefined) {
      let k = this.skies.get(b.world);
      if (k === undefined) this.skies.set(b.world, (k = new SkyColumns(b.edge)));
      k.apply(b.sky);
      this.sun?.field.skyChanged(b.sky);
    }
    const t1 = performance.now();
    const done = q.stage.commit();
    this.staging.commitMsMax = Math.max(this.staging.commitMsMax, performance.now() - t1);
    if (q.stage.steps > 1) this.staging.spread++;
    this.staging.framesMax = Math.max(this.staging.framesMax, q.stage.steps);
    this.replaced += done.chunkBytes.length / 4;
    this.applied++;
    const was = [w.coarse, w.kits];
    w.coarse = done.coarseBytes;
    w.kits = this.kitBytes();
    if (done.chunkBytes.length > 0 || was[0] !== w.coarse || was[1] !== w.kits) this.opts.report(b.world, done.chunkBytes, w.coarse, w.kits);
    this.opts.applied?.();
    const applyMs = q.ms + performance.now() - t0;
    const hopMs = q.at - b.sentAt;
    for (const s of b.swaps) {
      this.unseen.push({ e: { world: b.world, groups: s.groups, sections: s.sections, chunks: s.chunks, swapMs: s.ms, hopMs, applyMs }, editAt: b.sentAt - s.ms });
    }
    return true;
  }

  /** What is drawn (diagnostics and tests). */
  stats(): { worlds: Record<string, VoxelWorldDrawStats>; batches: number; applied: number; replaced: number; waiting: number; staging: VoxelWorldDraws['staging'] } {
    const worlds: Record<string, VoxelWorldDrawStats> = {};
    for (const [name, { view, surface, relief }] of this.worlds) worlds[name] = { chunks: view.count, levels: view.levelCounts(), seams: view.seamCount, triangles: view.triangles, seamTriangles: view.seamTriangles, instances: view.instances, kitInstances: view.piecesDrawn.kit, pieceDraws: view.pieceDraws, pieceDrawsInView: view.pieces.drawsInView, piecesInView: view.pieces.instancesInView, meshBuilds: view.meshBuilds, shaderSets: view.shaderSets, paths: view.pathCounts(), tableUploads: surface.tableUploads, tableMs: surface.tableMs, blendM: surface.blendMetres, textureLayers: this.arrays?.count ?? 0, textured: surface.textured, texelDensity: this.density !== null && Number.isFinite(this.density) ? this.density : null, textureTops: { ...this.tops }, relief: relief === null ? null : { n: relief.n, radiusM: relief.radius * VOXEL_SIZE_M, displace: this.displace, vertices: view.reliefVertices }, far: { nodes: view.far.nodes, bricks: view.far.bricks, triangles: view.far.triangles, draws: view.far.draws, gpuBytes: view.far.bytes, trims: view.far.trims, covered: view.far.coveredNodes, cover: { hidden: view.far.coverState.covered, edge: view.far.coverState.edge }, pass: view.far.brickPass, visibilityBytes: view.far.visibilityBytes, feedback: view.far.feedbackStats, fine: view.far.fineState, fineBaked: { drawn: [...view.far.fineDrawn], read: view.far.fineBakedIn } } };
    return { worlds, batches: this.batches, applied: this.applied, replaced: this.replaced, waiting: this.waiting.length, staging: { ...this.staging } };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const off of this.unregister.splice(0)) off();
    if (this.groundLink?.ground === this.ground) this.groundLink.ground = null;
    this.groundLink = null;
    this.sun?.dispose();
    this.sun = null;
    this.dropVolume();
    this.light?.unlink();
    this.light = null;
    if (this.raf !== null && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(this.raf);
    this.kitLoaded?.();
    this.kitLoaded = null;
    for (const name of [...this.worlds.keys()]) this.close(name);
    // Walks and sky heights of worlds whose draws never came (a batch's blocks arrive before its first draw).
    for (const g of this.walks.values()) g.dispose();
    this.walks.clear();
    this.skies.clear();
    for (const q of this.waiting) q.stage?.discard();
    this.waiting.length = 0;
    if (this.arrays !== null) for (const t of Object.values(this.arrays.textures)) if (t !== undefined) this.opts.release?.(t);
    this.arrays = null;
  }
}
