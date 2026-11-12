/**
 * A voxel world's far field draws (`@thirdlight/voxel` far-field.ts): the
 * far tree's nodes past the near rings, as ray-marched distance bricks (the
 * far field; voxel-far-bricks.ts makes those groups' draws) or as meshes
 * (here; the fallback), batched
 * into a few draws, coloured from the world's material table, drawn under
 * the near field and hidden where it draws. A node arrives as one or the
 * other (the far field's mode); a group holds nodes of one kind.
 *
 * - **Batches.** Nodes are drawn in groups of {@link FAR_GROUP_NODES}² node
 *   columns of one level (every height in one), each group one merged
 *   geometry and one draw: a far field of thousands of nodes is a few
 *   hundred draws at most. A batch's far changes rebuild only the groups
 *   they touch, all in the batch's task, so a level change (a parent and its
 *   children) swaps between the same two frames.
 * - **Colour.** A vertex carries its cell's material and wetness; its colour
 *   is the material's table colour times its wall set's mean (the array's
 *   coarsest level), read in the vertex stage from the surface's own table
 *   and arrays, so a record's change reaches the far field with no mesh
 *   rebuilt. Lit like the near surfaces (the scene's lights), no shadows.
 * - **Depth.** Far nodes reach kilometres past the camera's far plane: the
 *   vertex stage writes a depth of its own, the camera's perspective depth
 *   of the distance pushed back by {@link FAR_DEPTH_PUSH} up to half the far
 *   plane, and past it the distance's logarithm up to {@link FAR_DEPTH_MAX_M}
 *   in what remains of the depth range. So far nodes sort among themselves at
 *   any distance, nothing is cut off at the far plane, and where a far node
 *   and the near field cover the same pixel the near field is in front.
 *   They are never frustum culled by three (its frustum ends at the far
 *   plane); the GPU clips what lies off screen.
 * - **Near field.** The batches' near cover (where the near field draws, by
 *   storage chunk, its edge ring apart) is a small 3D texture; a far
 *   fragment inside a covered chunk is discarded. Where the near field has
 *   not drawn a chunk yet the far node shows, and along the near field's
 *   edge both draw, the far one's depth behind all of the near field (the
 *   coarser far surface may lie above the near one), so no gap opens
 *   between them and the near field wins wherever it has geometry.
 * - **Fine nodes.** A fine node (levels 0–1) arrives as its cell block; its
 *   bricks are built on the GPU (voxel-fine-bricks.ts) and drawn as any
 *   brick node. A far change holding fine nodes waits until all of them are
 *   built and is then applied whole, the changes after it waiting their
 *   turn, so a swap stays a swap.
 */
import * as THREE from 'three';
import { MeshStandardNodeMaterial } from 'three/webgpu';
import * as TSLTyped from 'three/tsl';
import { DISTANCE_BRICK_CELLS, FAR_POSITION_ORIGIN_CELLS, FAR_SEEN_STRIDE, FAR_VERTEX_BYTES, farBrickCount, farBricksInside, mipNodeKey, POSITION_STEPS_PER_CELL, VOXEL_SIZE_M, type ChunkGrid, type FarDrawKind, type FarDrawWire, type FarBricks, type FarNodeDraw, type FarSeenWire, type FloatingOrigin, type MipNode, type NearCoverWire } from '@thirdlight/voxel';
import { cameraRelative } from './camera-relative';
import { disposeObjectTree } from './dispose';
import type { N } from './effects-tsl';
import { FarBrickTextures } from './voxel-far-brick-field';
import { FarBrickAtlas, FarBrickMaterial, farNodeGeometry, type FarBrickOutput } from './voxel-far-bricks';
import { FarNodeCopies } from './voxel-far-cull';
import { FarBrickPalette, type FarPaletteRenderer } from './voxel-far-palette';
import { FarCover, farClipPosition } from './voxel-far-common';
import { FarFeedback, farFeedbackMismatch, FarRegionOwners, type FarFeedbackRenderer, type FarFeedbackResult } from './voxel-far-feedback';
import { FarFineShade, type FarFineTexture } from './voxel-far-fine-shade';
import { FarVisibility } from './voxel-far-visibility';
import { FineBrickBuilder, fineDeviceOf, type FineBrickCheck, type FineBrickResult } from './voxel-fine-bricks';
import type { VoxelGridRenderer, VoxelSurface } from './voxel-surface';

const TSL: N = TSLTyped;
const { Discard, Fn, If, attribute, floor, mod, positionWorld, varying, vec4 } = TSL;

/** The far geometry's attribute holding a vertex's material id + wetness · 4096 (far-mesh.ts's look word). */
export const VOXEL_FAR_LOOK_ATTRIBUTE = 'voxelFarLook';

/** Node columns a side one far draw holds (one level, every height). */
export const FAR_GROUP_NODES = 8;

interface FarGroup {
  readonly key: string;
  readonly kind: FarDrawKind;
  readonly level: number;
  /** The group's corner (world cells): its geometry's positions count from it. */
  readonly cell: readonly [number, number, number];
  readonly nodes: Map<string, FarNodeDraw>;
  mesh: THREE.Mesh | null;
  /** A brick group's nodes as the GPU culler sees them (null: a mesh group). */
  copies: FarNodeCopies | null;
  dirty: boolean;
  triangles: number;
  bytes: number;
  /** Bricks drawn (brick groups). */
  brickCount: number;
  /** Nodes its draw holds. */
  drawnNodes: number;
}

export interface VoxelFarViewOptions {
  readonly grid: ChunkGrid;
  readonly origin: FloatingOrigin;
  /** The surface whose material table and arrays colour the far field. */
  readonly surface: VoxelSurface;
  /** What the bricks are uploaded with (the bricks mode needs it). */
  readonly renderer?: VoxelGridRenderer;
  /**
   * Whether the bricks draw as a visibility pass and one shade where the renderer is WebGPU (voxel-far-visibility.ts;
   * default on). Off, or on WebGL 2, each brick fragment shades its own hit in the frame.
   */
  readonly visibility?: boolean;
  /**
   * Where the visibility feedback's rounds go (voxel-far-feedback.ts: what the far nodes were seen at, for the far
   * field's selection); absent, or without the visibility pass, none are made.
   */
  readonly onSeen?: (seen: FarSeenWire) => void;
  /** What fine bricks' hits read of the texture sets (default `full`; voxel-far-fine-shade.ts). */
  readonly fineTexture?: FarFineTexture;
  /**
   * Fine nodes arrived where they cannot be built (no WebGPU device: WebGL 2): told once, so where the world runs
   * turns fine bricks off and its near field draws levels 1–2 again rather than nothing past the detail ring.
   */
  readonly onFineUnavailable?: () => void;
}

/** One world's far field draws. */
export class VoxelFarView {
  readonly root = new THREE.Group();
  private readonly groups = new Map<string, FarGroup>();
  private readonly groupOf = new Map<string, string>();
  private material: THREE.Material | null = null;
  private readonly cover: FarCover;
  /** The bricks on the GPU and their one material (made with the first brick node). */
  private atlas: FarBrickAtlas | null = null;
  private brickMaterial: FarBrickMaterial | null = null;
  /** Each brick node's atlas regions, by node key. */
  private readonly regions = new Map<string, THREE.Vector3[]>();
  /** Each brick node's page (its brick table, the march's), by node key. */
  private readonly pages = new Map<string, THREE.Vector3>();
  private hidden = false;
  /** The atlas's texture nodes every brick program reads (made with the atlas). */
  private textures: FarBrickTextures | null = null;
  /** The bricks' visibility pass and shade (null: they shade in the frame). */
  private vis: FarVisibility | null = null;
  /** How fine bricks' hits are shaded (made with the atlas). */
  private fineShade: FarFineShade | null = null;
  private fineTexturedOn = true;
  /** The far field's last fine fade (metres; null: none sent yet). */
  private fineFade: readonly [number, number] | null = null;
  /** The visibility pass's feedback (null: off) and who holds each brick region, by version. */
  private feedback: FarFeedback | null = null;
  private readonly owners = new FarRegionOwners();
  /** The last far event applied ({@link FarDrawWire.seq}). */
  private farSeq = 0;
  /** The feedback as last read back: rounds sent, regions left out as stale, bricks and nodes seen, the last check. */
  readonly seenStats = { sent: 0, stale: 0, bricks: 0, nodes: 0, check: null as ReturnType<typeof farFeedbackMismatch> | null };
  /** The far colours by look word the bricks' baked samples take (made with the atlas). */
  private palette: FarBrickPalette | null = null;
  private paletteBusy = false;
  /** Bricks baked again after a palette change, and the ms the last change's took. */
  recoloured = 0;
  recolourMs = 0;
  triangles = 0;
  /** Bricks drawn (the bricks mode). */
  bricks = 0;
  /** GPU bytes of the draws' buffers (the atlas's are counted in {@link bytes}). */
  private drawBytes = 0;
  /** Far nodes drawn (with anything to draw). */
  nodes = 0;

  /** Far nodes the view's culled draws leave out because the near field hides them whole (as last packed). */
  get coveredNodes(): number {
    let n = 0;
    for (const g of this.groups.values()) n += g.copies?.covered ?? 0;
    return n;
  }
  /** Groups rebuilt (draws replaced) since made. */
  rebuilds = 0;
  /** Times the brick atlas gave space back. */
  trims = 0;
  /** ms the last batch's group rebuilds took. */
  lastBuildMs = 0;
  /** The fine nodes' GPU build (made with the first fine node; null before, or on WebGL 2). */
  private fine: FineBrickBuilder | null = null;
  private fineTried = false;
  /** Far changes waiting for their fine nodes' builds, oldest first. */
  private readonly held: Array<{ readonly far: FarDrawWire; readonly results: Map<number, FineBrickResult>; pending: number }> = [];
  /** Fine builds still to check against the CPU build ({@link checkFine}). */
  private fineChecks = 0;
  /** Fine nodes drawn now, by level (0, 1), and their keys. */
  readonly fineDrawn = [0, 0];
  private readonly fineKeys = new Set<string>();
  /** Far changes held for their fine builds since made. */
  heldChanges = 0;
  constructor(private readonly opts: VoxelFarViewOptions) {
    this.root.name = 'voxel-far';
    this.root.matrixAutoUpdate = false;
    this.cover = new FarCover(opts.grid, opts.origin);
  }

  /** GPU bytes the far field holds: its draws' buffers, the brick atlas and the visibility target. */
  get bytes(): number {
    return this.drawBytes + (this.atlas?.gpuBytes ?? 0) + this.visibilityBytes;
  }

  /** GPU bytes of the visibility target alone (its size follows the frame's). */
  get visibilityBytes(): number {
    return this.vis?.gpuBytes ?? 0;
  }

  /** How the bricks shade: in the visibility pass's one shade (WebGPU), or each fragment in the frame (WebGL 2, or the pass off). */
  get brickPass(): 'visibility' | 'direct' {
    return this.vis !== null ? 'visibility' : 'direct';
  }

  /** The visibility pass's own scene, which holds the brick draws while it is on (null: off). */
  get visibilityScene(): THREE.Scene | null {
    return this.vis?.scene ?? null;
  }

  /** GPU bytes of the brick atlas alone. */
  get atlasBytes(): number {
    return this.atlas?.gpuBytes ?? 0;
  }

  /** The near cover now: its corner and size (chunks), and the chunks it hides the far field in. */
  get coverState(): FarCover['state'] {
    return this.cover.state;
  }

  /** The number of far draws (groups with anything to draw). */
  get draws(): number {
    let n = 0;
    for (const g of this.groups.values()) if (g.mesh !== null) n++;
    return n;
  }

  private remakeBrickDraws(): void {
    this.setVisibilityPass();
    this.brickMaterial?.dispose();
    this.brickMaterial = null;
    for (const g of this.groups.values()) if (g.kind === 'bricks') g.dirty = true;
    for (const g of [...this.groups.values()]) if (g.dirty) this.rebuild(g);
  }

  /** Shows or hides every far draw (a page's switch; nothing is rebuilt). */
  /** Fine bricks textured or in the palette's colours (a comparison; no new program). */
  setFineTextured(on: boolean): void {
    this.fineTexturedOn = on;
    this.fineShade?.setTextured(on);
  }

  setVisible(on: boolean): void {
    this.hidden = !on;
    this.root.visible = on;
    // The visibility pass's draws sit in their own scene: hidden with the shade, so the culler lists none of them.
    if (this.vis !== null) this.vis.root.visible = on;
  }

  get visible(): boolean {
    return !this.hidden;
  }

  /**
   * The far node drawn at a world point (cells) and whether the point lies inside the solid its bricks draw (null:
   * no brick node drawn there). A camera inside one sees it from inside: box faces, no ground.
   */
  solidAt(x: number, y: number, z: number): { level: number; inside: boolean } | null {
    const e = this.opts.grid.edge;
    const levels = new Set<number>();
    for (const g of this.groups.values()) if (g.kind === 'bricks') levels.add(g.level);
    for (const level of [...levels].sort((a, b) => a - b)) {
      const span = e << level;
      const n = { level, nx: Math.floor(x / span), ny: Math.floor(y / span), nz: Math.floor(z / span) };
      const key = mipNodeKey(n);
      const gk = this.groupOf.get(key);
      const b = gk === undefined ? undefined : this.groups.get(gk)?.nodes.get(key)?.bricks;
      if (b === undefined) continue;
      const cell = 2 ** level;
      return { level, inside: farBricksInside(b, [(x - n.nx * span) / cell, (y - n.ny * span) / cell, (z - n.nz * span) / cell]) };
    }
    return null;
  }

  /** A batch's near cover and its far changes, applied in this task (a far change with fine nodes once they are built). */
  apply(far: FarDrawWire | undefined, cover: NearCoverWire | undefined): void {
    if (cover !== undefined) this.cover.set(cover);
    if (far === undefined) return;
    if (far.fineFade !== undefined) {
      this.fineFade = far.fineFade;
      this.fineShade?.setFade(far.fineFade[0], far.fineFade[1]);
    }
    if (this.held.length === 0 && !far.added.some((a) => a.fine !== undefined)) this.applyFar(far, null);
    else this.hold(far);
  }

  /** A far change with fine nodes: their builds start, and it is applied once the last is in (after those before it). */
  private hold(far: FarDrawWire): void {
    const entry = { far, results: new Map<number, FineBrickResult>(), pending: 0 };
    const builder = this.fineBuilder();
    far.added.forEach((a, i) => {
      if (a.fine === undefined) return;
      if (builder === null) {
        entry.results.set(i, { bricks: null, regions: [], page: null });
        return;
      }
      entry.pending++;
      const check = this.fineChecks > 0;
      if (check) this.fineChecks--;
      builder.enqueue(a, a.fine, (r) => {
        entry.results.set(i, r);
        entry.pending--;
        this.releaseHeld();
      }, check);
    });
    this.held.push(entry);
    this.heldChanges++;
    this.releaseHeld();
  }

  private releaseHeld(): void {
    while (this.held.length > 0 && this.held[0]!.pending === 0) {
      const e = this.held.shift()!;
      this.applyFar(e.far, e.results);
    }
  }

  /** The fine build on the renderer's WebGPU device (null on WebGL 2: fine nodes draw nothing there, said once). */
  private fineBuilder(): FineBrickBuilder | null {
    if (this.fine !== null || this.fineTried) return this.fine;
    this.fineTried = true;
    const device = fineDeviceOf(this.uploader());
    if (device === null) {
      console.warn('far bricks: fine nodes need WebGPU; on WebGL 2 the near field draws past the detail ring instead');
      this.opts.onFineUnavailable?.();
      return null;
    }
    const atlas = this.brickAtlas();
    this.fine = new FineBrickBuilder(device, this.uploader(), atlas, this.opts.grid);
    return this.fine;
  }

  /** The next `n` fine builds are checked against the CPU build of the same blocks ({@link fineState}'s `checks`). */
  checkFine(n: number): void {
    this.fineChecks += n;
  }

  /** The fine build's counts (null: none made). */
  get fineState(): (FineBrickBuilder['stats'] & { readonly pending: number; readonly held: number; readonly heldChanges: number; readonly drawn: readonly number[]; readonly gpuBytes: number; readonly checks: readonly FineBrickCheck[]; readonly texture: FarFineTexture | null; readonly fadeM: readonly [number, number] | null }) | null {
    const f = this.fine;
    return f === null ? null : { ...f.stats, latencyMs: [...f.stats.latencyMs], pending: f.pending, held: this.held.length, heldChanges: this.heldChanges, drawn: [...this.fineDrawn], gpuBytes: f.gpuBytes, checks: [...f.checks], texture: this.fineShade === null ? null : this.fineShade.textured ? this.fineShade.texture : 'off', fadeM: this.fineFade };
  }

  private applyFar(far: FarDrawWire, fine: ReadonlyMap<number, FineBrickResult> | null): void {
    const t0 = performance.now();
    // Regions given from here on belong to the new version: a round reduced before it never speaks for them.
    this.owners.version++;
    if (far.seq !== undefined) this.farSeq = far.seq;
    this.atlas?.frame();
    for (const n of far.removed) {
      const key = mipNodeKey(n);
      this.dropRegions(key);
      const gk = this.groupOf.get(key);
      if (gk === undefined) continue;
      this.groupOf.delete(key);
      const g = this.groups.get(gk)!;
      if (this.fineKeys.delete(key)) this.fineDrawn[n.level]!--;
      g.nodes.delete(key);
      g.dirty = true;
    }
    far.added.forEach((a0, i) => {
      const key = mipNodeKey(a0);
      this.dropRegions(key);
      const old = this.groupOf.get(key);
      if (old !== undefined) {
        if (this.fineKeys.delete(key)) this.fineDrawn[a0.level]!--;
        this.groups.get(old)!.nodes.delete(key);
        this.groups.get(old)!.dirty = true;
        this.groupOf.delete(key);
      }
      let a: FarNodeDraw = a0;
      if (a0.fine !== undefined) {
        // Built on the GPU: its regions and page are in the atlas already (the block itself is not kept).
        const r = fine?.get(i);
        if (r === undefined || r.bricks === null) return;
        this.regions.set(key, r.regions);
        this.owners.give({ level: a0.level, nx: a0.nx, ny: a0.ny, nz: a0.nz }, r.regions);
        if (r.page !== null) this.pages.set(key, r.page);
        a = { level: a0.level, nx: a0.nx, ny: a0.ny, nz: a0.nz, bricks: r.bricks };
        this.fineKeys.add(key);
        this.fineDrawn[a0.level]!++;
      } else if (a0.bricks !== undefined) this.upload(key, a0, a0.bricks);
      const g = this.group(a.bricks !== undefined ? 'bricks' : 'mesh', a.level, a.nx, a.nz);
      g.nodes.set(key, a);
      g.dirty = true;
      this.groupOf.set(key, g.key);
    });
    for (const g of [...this.groups.values()]) if (g.dirty) this.rebuild(g);
    if (this.atlas !== null && this.atlas.trim(this.uploader())) this.trims++;
    this.lastBuildMs = performance.now() - t0;
  }

  private dropRegions(key: string): void {
    const r = this.regions.get(key);
    if (r === undefined) return;
    this.owners.take(r);
    this.atlas!.remove(r);
    this.regions.delete(key);
    const page = this.pages.get(key);
    if (page !== undefined) this.atlas!.removePage(page);
    this.pages.delete(key);
  }

  /** A brick node's bricks and brick table into the atlas. */
  private upload(key: string, node: MipNode, b: FarBricks): void {
    const atlas = this.brickAtlas();
    const regions = atlas.add(this.uploader(), b, this.palette?.palette ?? null);
    this.regions.set(key, regions);
    this.owners.give({ level: node.level, nx: node.nx, ny: node.ny, nz: node.nz }, regions);
    const page = atlas.addPage(this.uploader(), b, regions);
    if (page !== null) this.pages.set(key, page);
  }

  private brickAtlas(): FarBrickAtlas {
    if (this.atlas === null) {
      this.atlas = new FarBrickAtlas(this.opts.grid.edge / DISTANCE_BRICK_CELLS);
      this.textures = new FarBrickTextures(this.atlas);
      this.fineShade = new FarFineShade(this.opts.surface, this.textures, this.opts.fineTexture ?? 'full');
      this.fineShade.setTextured(this.fineTexturedOn);
      if (this.fineFade !== null) this.fineShade.setFade(this.fineFade[0], this.fineFade[1]);
      this.palette ??= new FarBrickPalette(this.opts.surface);
    }
    return this.atlas;
  }

  /**
   * The visibility pass on or off as the renderer wants it (decided when brick draws
   * are made: three's WebGPU renderer falls back to WebGL 2 only at its first draw).
   */
  private setVisibilityPass(): void {
    const webgpu = (this.opts.renderer as { backend?: { isWebGPUBackend?: boolean } } | undefined)?.backend?.isWebGPUBackend === true;
    const want = webgpu && this.opts.visibility !== false;
    if (want === (this.vis !== null)) return;
    if (want) {
      this.brickAtlas();
      this.vis = new FarVisibility(this.textures!, this.cover, this.root, this.opts.origin, this.fineShade!);
      this.vis.root.visible = !this.hidden;
      this.root.add(this.vis.shade);
      if (this.opts.onSeen !== undefined) {
        const feedback = (this.feedback = new FarFeedback((r) => this.seenRound(r)));
        const atlas = this.atlas!;
        this.vis.onPass = (r, target) => feedback.frame(r as unknown as FarFeedbackRenderer, target, { dims: atlas.distance.regionDims, version: this.owners.version, farSeq: this.farSeq });
      }
    } else {
      this.vis!.shade.removeFromParent();
      this.vis!.dispose();
      this.vis = null;
      this.feedback?.dispose(this.uploader() as unknown as FarFeedbackRenderer);
      this.feedback = null;
    }
  }

  /** A round read back: the nodes its regions' holders were seen at, to the far field (regions given since left out). */
  private seenRound(r: FarFeedbackResult): void {
    if (this.feedback === null) return;
    const { wire, stale, bricks } = this.owners.round(r.data, r.atlas.dims, r.atlas.version, this.feedback.step, r.round, r.atlas.farSeq);
    this.seenStats.stale += stale;
    this.seenStats.bricks = bricks;
    this.seenStats.nodes = wire.nodes.length / FAR_SEEN_STRIDE;
    if (r.cpu !== undefined) this.seenStats.check = farFeedbackMismatch(r.data, r.cpu);
    this.seenStats.sent++;
    this.opts.onSeen?.(wire);
  }

  /** The feedback's rounds and readbacks (null: none made), with the view's counts. */
  get feedbackStats(): (FarFeedback['stats'] & VoxelFarView['seenStats'] & { readonly bytes: number }) | null {
    return this.feedback === null ? null : { ...this.feedback.stats, ...this.seenStats, bytes: this.feedback.gpuBytes };
  }

  /** The next round also reads the visibility target back and reduces it on the CPU (a check of the GPU's reduction). */
  checkFeedback(): void {
    if (this.feedback !== null) this.feedback.checkNext = true;
  }

  private brickOutput(): FarBrickOutput {
    return this.vis !== null ? 'visibility' : 'lit';
  }

  /** Before a brick draw: when the surface's looks changed, the palette is drawn again after this frame. */
  private checkPalette(): void {
    const p = this.palette;
    if (p === null || !p.stale || this.paletteBusy || this.atlas === null) return;
    this.paletteBusy = true;
    setTimeout(() => void this.refreshPalette(p), 0);
  }

  /** The palette again, and every resident brick node holding a word whose colour changed baked again. */
  private async refreshPalette(p: FarBrickPalette): Promise<void> {
    try {
      const changed = await p.update(this.uploader() as unknown as FarPaletteRenderer);
      const atlas = this.atlas;
      if (atlas === null || p !== this.palette || p.palette === null) return;
      const t0 = performance.now();
      let n = 0;
      for (const g of this.groups.values()) {
        if (g.kind !== 'bricks') continue;
        for (const [key, d] of g.nodes) {
          const b = d.bricks;
          const r = this.regions.get(key);
          if (b === undefined || r === undefined) continue;
          let hit = false;
          for (let i = 0; i < b.looks.length && !hit; i++) hit = changed[b.looks[i]!] === 1;
          if (!hit) continue;
          atlas.recolour(this.uploader(), b, r, p.palette);
          n += r.length;
        }
      }
      this.recoloured += n;
      this.recolourMs = performance.now() - t0;
    } catch (e) {
      console.warn('far bricks: the palette could not be drawn', e);
    } finally {
      this.paletteBusy = false;
    }
  }

  private uploader(): VoxelGridRenderer {
    if (this.opts.renderer === undefined) throw new Error('far bricks: the view has no renderer to upload them with');
    return this.opts.renderer;
  }

  private group(kind: FarDrawKind, level: number, nx: number, nz: number): FarGroup {
    const gx = Math.floor(nx / FAR_GROUP_NODES);
    const gz = Math.floor(nz / FAR_GROUP_NODES);
    const key = `${kind}:${level}:${gx},${gz}`;
    let g = this.groups.get(key);
    if (g === undefined) {
      const span = FAR_GROUP_NODES * this.opts.grid.edge * 2 ** level;
      g = { key, kind, level, cell: [gx * span, 0, gz * span], nodes: new Map(), mesh: null, copies: null, dirty: false, triangles: 0, bytes: 0, brickCount: 0, drawnNodes: 0 };
      this.groups.set(key, g);
    }
    return g;
  }

  private rebuild(g: FarGroup): void {
    g.dirty = false;
    this.rebuilds++;
    if (g.mesh !== null) {
      g.copies?.dispose();
      g.copies = null;
      g.mesh.removeFromParent();
      g.mesh.geometry.dispose();
      // A group's mesh is rebuilt on every change of its nodes: its render objects hold on the one far material.
      disposeObjectTree(g.mesh);
      g.mesh = null;
      this.triangles -= g.triangles;
      this.bricks -= g.brickCount;
      this.drawBytes -= g.bytes;
      this.nodes -= g.drawnNodes;
    }
    if (g.nodes.size === 0) {
      this.groups.delete(g.key);
      this.vis?.update();
      return;
    }
    let mesh: THREE.Mesh;
    if (g.kind === 'bricks') {
      const nodes = [...g.nodes.values()];
      const draws = farNodeGeometry(this.opts.grid.edge, g, nodes, (n) => this.pages.get(mipNodeKey(n)));
      if (this.brickMaterial === null) {
        this.brickAtlas();
        this.setVisibilityPass();
        this.brickMaterial = new FarBrickMaterial(this.textures!, this.cover, this.fineShade!, this.opts.grid.edge / DISTANCE_BRICK_CELLS, this.brickOutput());
      }
      g.triangles = 0;
      g.brickCount = nodes.reduce((n, d) => n + (d.bricks !== undefined ? farBrickCount(d.bricks) : 0), 0);
      g.bytes = geometryBytes(draws.geometry);
      mesh = new THREE.Mesh(draws.geometry, this.brickMaterial.material);
      // Culled node by node on the GPU where the frame has the pyramid path, drawn after it (voxel-far-cull.ts).
      const copies = draws.count > 0 ? new FarNodeCopies(mesh, draws.buffer, draws.boxes, draws.count, this.cover) : null;
      g.copies = copies;
      mesh.onBeforeRender = (_r, scene) => {
        this.checkPalette();
        copies?.beforeDraw(scene, scene.overrideMaterial === null);
      };
    } else {
      const geo = groupGeometry(this.opts.grid, g, [...g.nodes.values()]);
      g.triangles = (geo.index?.count ?? 0) / 3;
      g.brickCount = 0;
      g.bytes = geometryBytes(geo);
      mesh = new THREE.Mesh(geo, this.farMaterial());
    }
    g.drawnNodes = g.nodes.size;
    this.triangles += g.triangles;
    this.bricks += g.brickCount;
    this.drawBytes += g.bytes;
    this.nodes += g.drawnNodes;
    mesh.name = `voxel-far ${g.key}`;
    mesh.matrixAutoUpdate = false;
    // Three's frustum ends at the camera's far plane; far draws reach past it (their depth is their own).
    mesh.frustumCulled = false;
    mesh.castShadow = mesh.receiveShadow = false;
    mesh.userData['voxelFar'] = g.key;
    const parent = g.kind !== 'bricks' || this.vis === null ? this.root : this.vis.root;
    parent.add(mesh);
    this.vis?.sync();
    this.place(mesh, g.cell);
    g.mesh = mesh;
    this.vis?.update();
  }

  private place(o3: THREE.Object3D, cell: readonly number[]): void {
    const o = this.opts.origin.origin;
    o3.position.set((cell[0]! - o.x) * VOXEL_SIZE_M, (cell[1]! - o.y) * VOXEL_SIZE_M, (cell[2]! - o.z) * VOXEL_SIZE_M);
    o3.updateMatrix();
    o3.updateMatrixWorld(true);
  }

  /** After a floating-origin re-base: every draw's position again, and the cover's corner. */
  rebase(): void {
    this.vis?.sync();
    for (const g of this.groups.values()) if (g.mesh !== null) this.place(g.mesh, g.cell);
    this.cover.place();
  }

  /** The far draws' material (one for the view): lit, coloured in the vertex stage, its own depth, hidden under the near cover. */
  private farMaterial(): THREE.Material {
    if (this.material !== null) return this.material;
    const m = cameraRelative(new MeshStandardNodeMaterial());
    m.name = 'voxel far field';
    m.metalness = 0;
    m.roughness = 1;
    const surface = this.opts.surface;
    const look = attribute(VOXEL_FAR_LOOK_ATTRIBUTE, 'float');
    const colour = varying(surface.farColour(mod(look, 4096), floor(look.div(4096))));
    const cover = this.cover;
    m.colorNode = Fn(() => {
      If(cover.covered(positionWorld), () => {
        Discard();
      });
      return vec4(colour, 1);
    })();
    // The edge ring's push behind the near field is taken a vertex at a time: the mesh writes no depth of its own.
    m.vertexNode = farClipPosition(cover);
    this.material = m;
    return m;
  }

  dispose(): void {
    this.fine?.dispose();
    this.fine = null;
    this.held.length = 0;
    for (const g of this.groups.values()) {
      g.copies?.dispose();
      g.mesh?.geometry.dispose();
      disposeObjectTree(g.mesh);
    }
    this.groups.clear();
    this.groupOf.clear();
    this.regions.clear();
    this.pages.clear();
    this.root.clear();
    this.material?.dispose();
    this.brickMaterial?.dispose();
    this.atlas?.dispose();
    this.palette?.dispose();
    this.vis?.dispose();
    this.vis = null;
    if (this.feedback !== null && this.opts.renderer !== undefined) this.feedback.dispose(this.opts.renderer as unknown as FarFeedbackRenderer);
    this.feedback = null;
    this.cover.dispose();
    this.triangles = this.bricks = this.drawBytes = this.nodes = 0;
  }
}

/** A group's nodes as one geometry: positions in metres from the group's corner, normals, look words; indices offset. */
export function groupGeometry(grid: ChunkGrid, g: { readonly level: number; readonly cell: readonly [number, number, number] }, nodes: readonly FarNodeDraw[]): THREE.BufferGeometry {
  let n = 0;
  let k = 0;
  for (const d of nodes) {
    n += d.mesh?.vertexCount ?? 0;
    k += d.mesh?.indices.length ?? 0;
  }
  const pos = new Float32Array(n * 3);
  const nor = new Int8Array(n * 4);
  const look = new Float32Array(n);
  const index = n < 65536 ? new Uint16Array(k) : new Uint32Array(k);
  const scale = 2 ** g.level;
  const stepM = (scale * VOXEL_SIZE_M) / POSITION_STEPS_PER_CELL;
  let v0 = 0;
  let i0 = 0;
  for (const d of nodes) {
    const m = d.mesh;
    if (m === undefined) continue;
    const view = new DataView(m.vertices.buffer, m.vertices.byteOffset, m.vertices.byteLength);
    // The node's far origin, in metres from the group's corner.
    const ox = ((d.nx * grid.edge - FAR_POSITION_ORIGIN_CELLS) * scale - g.cell[0]) * VOXEL_SIZE_M;
    const oy = ((d.ny * grid.edge - FAR_POSITION_ORIGIN_CELLS) * scale - g.cell[1]) * VOXEL_SIZE_M;
    const oz = ((d.nz * grid.edge - FAR_POSITION_ORIGIN_CELLS) * scale - g.cell[2]) * VOXEL_SIZE_M;
    for (let i = 0; i < m.vertexCount; i++) {
      const o = i * FAR_VERTEX_BYTES;
      const at = (v0 + i) * 3;
      pos[at] = ox + view.getUint16(o, true) * stepM;
      pos[at + 1] = oy + view.getUint16(o + 2, true) * stepM;
      pos[at + 2] = oz + view.getUint16(o + 4, true) * stepM;
      look[v0 + i] = view.getUint16(o + 6, true);
      const no = (v0 + i) * 4;
      nor[no] = view.getInt8(o + 8);
      nor[no + 1] = view.getInt8(o + 9);
      nor[no + 2] = view.getInt8(o + 10);
    }
    const src = m.indices;
    for (let j = 0; j < src.length; j++) index[i0 + j] = src[j]! + v0;
    v0 += m.vertexCount;
    i0 += src.length;
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('normal', new THREE.BufferAttribute(nor, 4, true));
  geo.setAttribute(VOXEL_FAR_LOOK_ATTRIBUTE, new THREE.BufferAttribute(look, 1));
  geo.setIndex(new THREE.BufferAttribute(index, 1));
  geo.computeBoundingSphere();
  return geo;
}

function geometryBytes(geo: THREE.BufferGeometry): number {
  let n = geo.index?.array.byteLength ?? 0;
  // Views of one interleaved buffer count it once.
  const seen = new Set<ArrayBufferLike>();
  for (const a of Object.values(geo.attributes)) {
    const arr = (a as THREE.BufferAttribute).array;
    if (seen.has(arr.buffer)) continue;
    seen.add(arr.buffer);
    n += arr.byteLength;
  }
  return n;
}
