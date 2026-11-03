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
 * Every drawn chunk's GPU bytes go back to the simulation (`report`), where
 * they count as the chunk's mesh part of the world's stream budget.
 *
 * While a world is drawn, an animation-frame loop retires replaced grid
 * textures and records frame times, so an edit's way to the screen can be
 * measured: from the edit (the simulation's swap less its edit-to-swap ms)
 * over the hop to this page to the first frame drawn after the batch.
 */
import * as THREE from 'three';
import { chunkGrid, FloatingOrigin, MATERIAL_BITS, SHADER_BORDER_CELLS, shaderGridSide, VOXEL_SIZE_M, WETNESS_MAX, type ChunkDrawBatch, type ChunkEdge } from '@thirdlight/voxel';
import { VoxelChunkView, voxelStandInLook } from './voxel-chunk-view';
import { createVoxelSurface, type VoxelGridRenderer, type VoxelSurface } from './voxel-surface';

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
  /** Drawn chunks' GPU bytes for the simulation: `[cx, cy, cz, bytes]` repeated. */
  report(world: string, bytes: number[]): void;
}

interface WorldDraw {
  readonly view: VoxelChunkView;
  readonly surface: VoxelSurface;
}

/** Edits kept for measurements. */
const EDITS_KEPT = 64;
/** Frame times kept (wall-clock ms): a few seconds at a high refresh rate. */
const FRAMES_KEPT = 600;

const wallClock = (): number => performance.timeOrigin + performance.now();

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
  /** Batches applied and chunk draws replaced (shader-only included). */
  applied = 0;
  replaced = 0;

  constructor(private readonly opts: VoxelWorldDrawsOptions) {}

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
      if (this.worlds.size > 0 || this.waiting.length > 0) this.loop();
    };
    this.raf = requestAnimationFrame(tick);
  }

  private world(name: string, edge: number, scene: THREE.Scene, renderer: VoxelGridRenderer): WorldDraw {
    let w = this.worlds.get(name);
    if (w !== undefined) return w;
    const grid = chunkGrid(edge as ChunkEdge);
    const surface = createVoxelSurface({ cellMetres: VOXEL_SIZE_M, side: shaderGridSide(edge), border: SHADER_BORDER_CELLS, materialBits: MATERIAL_BITS, wetnessMax: WETNESS_MAX }, { look: voxelStandInLook, blendMetres: VOXEL_SIZE_M / 2 });
    const view = new VoxelChunkView({ grid, origin: new FloatingOrigin({ grid }), surface, renderer });
    view.root.name = `voxel-world ${name}`;
    scene.add(view.root);
    this.worlds.set(name, (w = { view, surface }));
    return w;
  }

  private close(name: string): void {
    const w = this.worlds.get(name);
    if (w === undefined) return;
    this.worlds.delete(name);
    w.view.root.removeFromParent();
    w.view.dispose();
    w.surface.dispose();
  }

  /** False: the renderer or the scene is not there yet (nothing was applied). */
  private apply(b: ChunkDrawBatch, receivedAt: number): boolean {
    if (b.closed === true) {
      this.close(b.world);
      return true;
    }
    const scene = this.opts.scene();
    const renderer = this.opts.renderer();
    if (scene === null || renderer === null) return false;
    const t0 = performance.now();
    const { view } = this.world(b.world, b.edge, scene, renderer);
    const bytes: number[] = [];
    for (const c of b.chunks) {
      if (c.kind === 'remove') {
        view.remove(c.cx, c.cy, c.cz);
        continue;
      }
      if (c.cells !== undefined) view.cells.set(c.cells);
      const solid = c.solid ?? 0;
      const n = c.kind === 'shader' ? view.setShader(c.cx, c.cy, c.cz, solid) : view.set(c.cx, c.cy, c.cz, { ground: c.ground!, base: c.base!, instances: c.instances!, solid });
      bytes.push(c.cx, c.cy, c.cz, n);
      this.replaced++;
    }
    this.applied++;
    if (bytes.length > 0) this.opts.report(b.world, bytes);
    const applyMs = performance.now() - t0;
    const hopMs = receivedAt - b.sentAt;
    for (const s of b.swaps) {
      this.unseen.push({ e: { world: b.world, groups: s.groups, sections: s.sections, chunks: s.chunks, swapMs: s.ms, hopMs, applyMs }, editAt: b.sentAt - s.ms });
    }
    return true;
  }

  /** What is drawn (diagnostics and tests). */
  stats(): { worlds: Record<string, { chunks: number; triangles: number; instances: number; meshBuilds: number; shaderSets: number }>; batches: number; applied: number; replaced: number; waiting: number } {
    const worlds: Record<string, { chunks: number; triangles: number; instances: number; meshBuilds: number; shaderSets: number }> = {};
    for (const [name, { view }] of this.worlds) worlds[name] = { chunks: view.count, triangles: view.triangles, instances: view.instances, meshBuilds: view.meshBuilds, shaderSets: view.shaderSets };
    return { worlds, batches: this.batches, applied: this.applied, replaced: this.replaced, waiting: this.waiting.length };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.raf !== null && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(this.raf);
    for (const name of [...this.worlds.keys()]) this.close(name);
    this.waiting.length = 0;
  }
}
