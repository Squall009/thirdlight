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
import { wallClock } from '@thirdlight/shared';
import { chunkGrid, FloatingOrigin, MATERIAL_BITS, reliefFade, SHADER_BORDER_CELLS, SHADER_READ_DEPTH_CELLS, shaderGridSide, VOXEL_SIZE_M, WETNESS_MAX, type ChunkDrawBatch, type ChunkEdge, type ChunkReliefWire, type FarSeenWire } from '@thirdlight/voxel';
import { isStreamedTexture } from './texture-streaming';
import { VoxelChunkView, voxelStandInLook } from './voxel-chunk-view';
import { VoxelBatchStage, voxelBatchFrameMs } from './voxel-batch-stage';
import { DEFAULT_QUALITY_LEVELS, levelVoxels, qualityLevelOf, textureSlotSetKey, voxelArrayTopLevel, voxelWorldBlendMetres, VOXEL_TEXTURE_MAPS, type QualityLevelConfig, type TextureSlotSet, type VoxelSurfaceTextures, type VoxelTextureMap } from '@thirdlight/project-model';
import { voxelLooksKey, voxelRecordLooks, voxelRecordTextures, type VoxelLookRecord } from './voxel-material-looks';
import type { VoxelKitSet } from './voxel-kit-pieces';
import { voxelWorldDecalsOf } from './voxel-world-decals';
import { createVoxelSurface, type VoxelGridRenderer, type VoxelMaterialLook, type VoxelSurface, type VoxelSurfaceTextureArrays } from './voxel-surface';
import { voxelPathsFromUrl, voxelStaticCastersFromUrl } from './voxel-surface-path';
import { farFeedbackFromUrl } from './voxel-far-feedback';
import type { VoxelFarView } from './voxel-far-mesh';
import { farVisibilityFromUrl } from './voxel-far-visibility';
import { pageSearch } from './renderer-factory';

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
  readonly far: { readonly nodes: number; readonly bricks: number; readonly triangles: number; readonly draws: number; readonly gpuBytes: number; readonly trims: number; readonly covered: number; readonly pass: 'visibility' | 'half' | 'direct'; readonly visibilityBytes: number; readonly feedback: VoxelFarView['feedbackStats'] };
}

interface WorldDraw {
  readonly view: VoxelChunkView;
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

  constructor(private readonly opts: VoxelWorldDrawsOptions) {
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
      for (const w of this.worlds.values()) w.surface.grids.frame();
      this.capArrays();
      if (this.worlds.size > 0 || this.waiting.length > 0) this.loop();
    };
    this.raf = requestAnimationFrame(tick);
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
    const view = new VoxelChunkView({ grid, origin: new FloatingOrigin({ grid }), surface, renderer, kits: this.kitSet, fastPaths: webgpu && voxelPathsFromUrl(pageSearch()), staticCasters: voxelStaticCastersFromUrl(pageSearch()), farVisibility: farVisibilityFromUrl(pageSearch()), ...(this.opts.farSeen !== undefined && farFeedbackFromUrl(pageSearch()) ? { onFarSeen: (seen: FarSeenWire) => this.opts.farSeen!(name, seen) } : {}) });
    view.rebuilt = () => this.rebuilt(name);
    view.root.name = `voxel-world ${name}`;
    scene.add(view.root);
    const decals = voxelWorldDecalsOf(scene);
    view.setDecalLayers(decals?.layersOf(name));
    view.setDecalSurfaces(decals?.surfaces ?? null);
    // The world's object changed its layers or blend: both are draw data (no remesh; the blend a uniform).
    const unlink = decals?.onChange((world) => {
      if (world !== name) return;
      view.setDecalLayers(decals.layersOf(name));
      surface.setBlendMetres(decals.blendOf(name));
      this.opts.applied?.();
    }) ?? ((): void => undefined);
    this.worlds.set(name, (w = { view, surface, coarse: 0, kits: 0, relief: null, unlink }));
    return w;
  }

  private close(name: string): void {
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
    for (const [name, { view, surface, relief }] of this.worlds) worlds[name] = { chunks: view.count, levels: view.levelCounts(), seams: view.seamCount, triangles: view.triangles, seamTriangles: view.seamTriangles, instances: view.instances, kitInstances: view.piecesDrawn.kit, pieceDraws: view.pieceDraws, pieceDrawsInView: view.pieces.drawsInView, piecesInView: view.pieces.instancesInView, meshBuilds: view.meshBuilds, shaderSets: view.shaderSets, paths: view.pathCounts(), tableUploads: surface.tableUploads, tableMs: surface.tableMs, blendM: surface.blendMetres, textureLayers: this.arrays?.count ?? 0, textured: surface.textured, texelDensity: this.density !== null && Number.isFinite(this.density) ? this.density : null, textureTops: { ...this.tops }, relief: relief === null ? null : { n: relief.n, radiusM: relief.radius * VOXEL_SIZE_M, displace: this.displace, vertices: view.reliefVertices }, far: { nodes: view.far.nodes, bricks: view.far.bricks, triangles: view.far.triangles, draws: view.far.draws, gpuBytes: view.far.bytes, trims: view.far.trims, covered: view.far.coveredNodes, pass: view.far.brickPass, visibilityBytes: view.far.visibilityBytes, feedback: view.far.feedbackStats } };
    return { worlds, batches: this.batches, applied: this.applied, replaced: this.replaced, waiting: this.waiting.length, staging: { ...this.staging } };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.raf !== null && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(this.raf);
    this.kitLoaded?.();
    this.kitLoaded = null;
    for (const name of [...this.worlds.keys()]) this.close(name);
    for (const q of this.waiting) q.stage?.discard();
    this.waiting.length = 0;
    if (this.arrays !== null) for (const t of Object.values(this.arrays.textures)) if (t !== undefined) this.opts.release?.(t);
    this.arrays = null;
  }
}
