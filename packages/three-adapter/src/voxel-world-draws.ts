/**
 * A game page's voxel worlds as drawn: one chunk view a world, fed by the
 * batches the simulation sends (`@thirdlight/voxel` chunk-batch.ts). The
 * world runs with the simulation (a worker or the page itself); this side
 * only replaces chunk draws, each batch in the task it arrives in, so a
 * swap's chunks change between the same two frames.
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
import { chunkGrid, FloatingOrigin, MATERIAL_BITS, reliefFade, SHADER_BORDER_CELLS, SHADER_READ_DEPTH_CELLS, shaderGridSide, VOXEL_SIZE_M, WETNESS_MAX, type ChunkDrawBatch, type ChunkEdge, type ChunkReliefWire } from '@thirdlight/voxel';
import { isStreamedTexture } from './texture-streaming';
import { applyChunkDrawBatch, VoxelChunkView, voxelStandInLook } from './voxel-chunk-view';
import { DEFAULT_QUALITY_LEVELS, levelVoxels, qualityLevelOf, textureSlotSetKey, voxelArrayTopLevel, voxelWorldBlendMetres, VOXEL_TEXTURE_MAPS, type QualityLevelConfig, type TextureSlotSet, type VoxelSurfaceTextures, type VoxelTextureMap } from '@thirdlight/project-model';
import { voxelLooksKey, voxelRecordLooks, voxelRecordTextures, type VoxelLookRecord } from './voxel-material-looks';
import type { VoxelKitSet } from './voxel-kit-pieces';
import { voxelWorldDecalsOf } from './voxel-world-decals';
import { createVoxelSurface, type VoxelGridRenderer, type VoxelMaterialLook, type VoxelSurface, type VoxelSurfaceTextureArrays } from './voxel-surface';

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
  readonly far: { readonly nodes: number; readonly bricks: number; readonly triangles: number; readonly draws: number; readonly gpuBytes: number; readonly trims: number; readonly covered: number };
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

/** Edits kept for measurements. */
const EDITS_KEPT = 64;
/** Frame times kept (wall-clock ms): a few seconds at a high refresh rate. */
const FRAMES_KEPT = 600;

export class VoxelWorldDraws {
  private readonly worlds = new Map<string, WorldDraw>();
  /** Batches waiting for the renderer (the adapter starts asynchronously). */
  private readonly waiting: ChunkDrawBatch[] = [];
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

  /** A batch from the simulation: applied now when the renderer can take it, else at the first frame it can. */
  receive(b: ChunkDrawBatch): void {
    if (this.disposed) return;
    this.batches++;
    const at = wallClock();
    if (this.waiting.length > 0 || !this.apply(b, at)) this.waiting.push(b);
    this.loop();
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
      while (this.waiting.length > 0 && this.apply(this.waiting[0]!, now)) this.waiting.shift();
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
    const view = new VoxelChunkView({ grid, origin: new FloatingOrigin({ grid }), surface, renderer, kits: this.kitSet });
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
    this.worlds.delete(name);
    w.unlink();
    w.view.root.removeFromParent();
    w.view.dispose();
    w.surface.dispose();
  }

  /** False: the renderer or the scene is not there yet (nothing was applied). */
  private apply(b: ChunkDrawBatch, receivedAt: number): boolean {
    if (b.closed === true) {
      this.close(b.world);
      this.opts.applied?.();
      return true;
    }
    const scene = this.opts.scene();
    const renderer = this.opts.renderer();
    if (scene === null || renderer === null) return false;
    const t0 = performance.now();
    const w = this.world(b.world, b.edge, scene, renderer);
    if (b.relief !== undefined) this.giveRelief(w, b.relief);
    const done = applyChunkDrawBatch(w.view, b);
    this.replaced += done.chunkBytes.length / 4;
    this.applied++;
    const was = [w.coarse, w.kits];
    w.coarse = done.coarseBytes;
    w.kits = this.kitBytes();
    if (done.chunkBytes.length > 0 || was[0] !== w.coarse || was[1] !== w.kits) this.opts.report(b.world, done.chunkBytes, w.coarse, w.kits);
    this.opts.applied?.();
    const applyMs = performance.now() - t0;
    const hopMs = receivedAt - b.sentAt;
    for (const s of b.swaps) {
      this.unseen.push({ e: { world: b.world, groups: s.groups, sections: s.sections, chunks: s.chunks, swapMs: s.ms, hopMs, applyMs }, editAt: b.sentAt - s.ms });
    }
    return true;
  }

  /** What is drawn (diagnostics and tests). */
  stats(): { worlds: Record<string, VoxelWorldDrawStats>; batches: number; applied: number; replaced: number; waiting: number } {
    const worlds: Record<string, VoxelWorldDrawStats> = {};
    for (const [name, { view, surface, relief }] of this.worlds) worlds[name] = { chunks: view.count, levels: view.levelCounts(), seams: view.seamCount, triangles: view.triangles, seamTriangles: view.seamTriangles, instances: view.instances, kitInstances: view.piecesDrawn.kit, pieceDraws: view.pieceDraws, pieceDrawsInView: view.pieces.drawsInView, piecesInView: view.pieces.instancesInView, meshBuilds: view.meshBuilds, shaderSets: view.shaderSets, tableUploads: surface.tableUploads, tableMs: surface.tableMs, blendM: surface.blendMetres, textureLayers: this.arrays?.count ?? 0, textured: surface.textured, texelDensity: this.density !== null && Number.isFinite(this.density) ? this.density : null, textureTops: { ...this.tops }, relief: relief === null ? null : { n: relief.n, radiusM: relief.radius * VOXEL_SIZE_M, displace: this.displace, vertices: view.reliefVertices }, far: { nodes: view.far.nodes, bricks: view.far.bricks, triangles: view.far.triangles, draws: view.far.draws, gpuBytes: view.far.bytes, trims: view.far.trims, covered: view.far.coveredNodes } };
    return { worlds, batches: this.batches, applied: this.applied, replaced: this.replaced, waiting: this.waiting.length };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.raf !== null && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(this.raf);
    this.kitLoaded?.();
    this.kitLoaded = null;
    for (const name of [...this.worlds.keys()]) this.close(name);
    this.waiting.length = 0;
    if (this.arrays !== null) for (const t of Object.values(this.arrays.textures)) if (t !== undefined) this.opts.release?.(t);
    this.arrays = null;
  }
}
