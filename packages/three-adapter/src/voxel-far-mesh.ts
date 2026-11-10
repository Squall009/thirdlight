/**
 * A voxel world's far field draws (`@thirdlight/voxel` far-field.ts): the
 * far tree's nodes past the near rings, as meshes (here) or as ray-marched
 * distance bricks (voxel-far-bricks.ts makes those groups' draws), batched
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
 *   storage chunk, its edge ring left out) is a small 3D texture; a far
 *   fragment inside a covered chunk is discarded. Where the near field has
 *   not drawn a chunk yet the far node shows, and along the near field's
 *   edge both draw (the near in front), so no gap opens between them.
 */
import * as THREE from 'three';
import { MeshStandardNodeMaterial } from 'three/webgpu';
import * as TSLTyped from 'three/tsl';
import { DISTANCE_BRICK_CELLS, FAR_POSITION_ORIGIN_CELLS, FAR_VERTEX_BYTES, farBrickCount, mipNodeKey, POSITION_STEPS_PER_CELL, VOXEL_SIZE_M, type ChunkGrid, type FarDrawKind, type FarDrawWire, type FarBricks, type FarNodeDraw, type FloatingOrigin, type NearCoverWire } from '@thirdlight/voxel';
import { cameraRelative } from './camera-relative';
import type { N } from './effects-tsl';
import { FarBrickAtlas, farBrickGeometry, FarBrickMaterial, farNodeGeometry, type FarBrickMarch, type FarBrickShading } from './voxel-far-bricks';
import { FarBrickPalette, type FarPaletteRenderer } from './voxel-far-palette';
import { FarCover, farClipPosition } from './voxel-far-common';
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
  /** Each brick node's page (its brick table, the node march's), by node key. */
  private readonly pages = new Map<string, THREE.Vector3>();
  /** How brick groups' pixels find the surface (a box a brick or a node). */
  private march: FarBrickMarch = 'brick';
  private hidden = false;
  /** The bricks' shading, kept for a material made later. */
  private shading: FarBrickShading = 'flat';
  /** The far colours by look word the baked shading's samples take (made with a baked atlas). */
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
  /** Groups rebuilt (draws replaced) since made. */
  rebuilds = 0;
  /** ms the last batch's group rebuilds took. */
  lastBuildMs = 0;
  constructor(private readonly opts: VoxelFarViewOptions) {
    this.root.name = 'voxel-far';
    this.root.matrixAutoUpdate = false;
    this.cover = new FarCover(opts.grid, opts.origin);
  }

  /** GPU bytes the far field holds: its draws' buffers and the brick atlas. */
  get bytes(): number {
    return this.drawBytes + (this.atlas?.gpuBytes ?? 0);
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

  /**
   * The bricks' shading ({@link FarBrickShading}). Between `flat` and `fine` a uniform changes; to or from `baked`
   * every brick node is uploaded again into an atlas of the other kind (no node is rebuilt).
   */
  setBrickShading(shading: FarBrickShading | boolean): void {
    const next: FarBrickShading = shading === true ? 'fine' : shading === false ? 'flat' : shading;
    const rebake = (next === 'baked') !== (this.shading === 'baked');
    this.shading = next;
    if (rebake && this.atlas !== null) this.reupload();
    this.brickMaterial?.setFineShading(next === 'fine');
  }

  /** How brick groups march ({@link FarBrickMarch}): a change makes the brick draws and their program again (to the node march: each node's brick table uploaded once). */
  setBrickMarch(march: FarBrickMarch): void {
    if (march === this.march) return;
    this.march = march;
    this.brickMaterial?.dispose();
    this.brickMaterial = null;
    // Pages are made only for the node march (a brick march never reads them); once made they stay with their node.
    for (const g of this.groups.values()) {
      if (g.kind !== 'bricks') continue;
      if (march === 'node') for (const [key, d] of g.nodes) if (d.bricks !== undefined) this.addPage(key, d.bricks);
      g.dirty = true;
    }
    for (const g of [...this.groups.values()]) if (g.dirty) this.rebuild(g);
  }

  get brickMarch(): FarBrickMarch {
    return this.march;
  }

  get brickShading(): FarBrickShading {
    return this.shading;
  }

  get fineBrickShading(): boolean {
    return this.shading !== 'flat';
  }

  /** Shows or hides every far draw (a page's switch; nothing is rebuilt). */
  setVisible(on: boolean): void {
    this.hidden = !on;
    this.root.visible = on;
  }

  get visible(): boolean {
    return !this.hidden;
  }

  /** A batch's far changes and near cover, all applied in this task. */
  apply(far: FarDrawWire | undefined, cover: NearCoverWire | undefined): void {
    if (cover !== undefined) this.cover.set(cover);
    if (far === undefined) return;
    const t0 = performance.now();
    this.atlas?.frame();
    for (const n of far.removed) {
      const key = mipNodeKey(n);
      this.dropRegions(key);
      const gk = this.groupOf.get(key);
      if (gk === undefined) continue;
      this.groupOf.delete(key);
      const g = this.groups.get(gk)!;
      g.nodes.delete(key);
      g.dirty = true;
    }
    for (const a of far.added) {
      const key = mipNodeKey(a);
      this.dropRegions(key);
      if (a.bricks !== undefined) this.upload(key, a.bricks);
      const old = this.groupOf.get(key);
      if (old !== undefined) {
        this.groups.get(old)!.nodes.delete(key);
        this.groups.get(old)!.dirty = true;
      }
      const g = this.group(a.bricks !== undefined ? 'bricks' : 'mesh', a.level, a.nx, a.nz);
      g.nodes.set(key, a);
      g.dirty = true;
      this.groupOf.set(key, g.key);
    }
    for (const g of [...this.groups.values()]) if (g.dirty) this.rebuild(g);
    this.lastBuildMs = performance.now() - t0;
  }

  private dropRegions(key: string): void {
    const r = this.regions.get(key);
    if (r === undefined) return;
    this.atlas!.remove(r);
    this.regions.delete(key);
    const page = this.pages.get(key);
    if (page !== undefined) this.atlas!.removePage(page);
    this.pages.delete(key);
  }

  /** A brick node's bricks and brick table into the atlas. */
  private upload(key: string, b: FarBricks): void {
    const atlas = this.brickAtlas();
    const regions = atlas.add(this.uploader(), b, this.palette?.palette ?? null);
    this.regions.set(key, regions);
    if (this.march === 'node') this.addPage(key, b);
  }

  /** A brick node's brick table (the node march's) into the atlas, once. */
  private addPage(key: string, b: FarBricks): void {
    const regions = this.regions.get(key);
    if (regions === undefined || this.pages.has(key)) return;
    const page = this.brickAtlas().addPage(this.uploader(), b, regions);
    if (page !== null) this.pages.set(key, page);
  }

  private brickAtlas(): FarBrickAtlas {
    if (this.atlas === null) {
      this.atlas = new FarBrickAtlas(this.shading === 'baked', this.opts.grid.edge / DISTANCE_BRICK_CELLS);
      if (this.atlas.baked) this.palette ??= new FarBrickPalette(this.opts.surface);
    }
    return this.atlas;
  }

  /** Every brick node into a new atlas of the shading's kind, and the draws made again over it. */
  private reupload(): void {
    const old = this.atlas;
    this.atlas = null;
    this.regions.clear();
    this.pages.clear();
    this.brickMaterial?.dispose();
    this.brickMaterial = null;
    for (const g of this.groups.values()) {
      if (g.kind !== 'bricks') continue;
      for (const [key, d] of g.nodes) if (d.bricks !== undefined) this.upload(key, d.bricks);
      g.dirty = true;
    }
    for (const g of [...this.groups.values()]) if (g.dirty) this.rebuild(g);
    old?.dispose();
  }

  /** Before a brick draw: when the surface's looks changed, the palette is drawn again after this frame. */
  private checkPalette(): void {
    const p = this.palette;
    if (p === null || !p.stale || this.paletteBusy || this.atlas?.baked !== true) return;
    this.paletteBusy = true;
    setTimeout(() => void this.refreshPalette(p), 0);
  }

  /** The palette again, and every resident brick node holding a word whose colour changed baked again. */
  private async refreshPalette(p: FarBrickPalette): Promise<void> {
    try {
      const changed = await p.update(this.uploader() as unknown as FarPaletteRenderer);
      const atlas = this.atlas;
      if (atlas === null || !atlas.baked || p !== this.palette || p.palette === null) return;
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
      g = { key, kind, level, cell: [gx * span, 0, gz * span], nodes: new Map(), mesh: null, dirty: false, triangles: 0, bytes: 0, brickCount: 0, drawnNodes: 0 };
      this.groups.set(key, g);
    }
    return g;
  }

  private rebuild(g: FarGroup): void {
    g.dirty = false;
    this.rebuilds++;
    if (g.mesh !== null) {
      this.root.remove(g.mesh);
      g.mesh.geometry.dispose();
      g.mesh = null;
      this.triangles -= g.triangles;
      this.bricks -= g.brickCount;
      this.drawBytes -= g.bytes;
      this.nodes -= g.drawnNodes;
    }
    if (g.nodes.size === 0) {
      this.groups.delete(g.key);
      return;
    }
    let mesh: THREE.Mesh;
    if (g.kind === 'bricks') {
      const atlas = this.brickAtlas();
      const nodes = [...g.nodes.values()];
      const geo = this.march === 'node' ? farNodeGeometry(this.opts.grid.edge, g, nodes, (n) => this.pages.get(mipNodeKey(n))) : farBrickGeometry(this.opts.grid.edge, g, nodes, (n) => this.regions.get(mipNodeKey(n)) ?? []);
      if (this.brickMaterial === null) {
        this.brickMaterial = new FarBrickMaterial(atlas, this.opts.surface, this.cover, this.march, this.opts.grid.edge / DISTANCE_BRICK_CELLS);
        this.brickMaterial.setFineShading(this.shading === 'fine');
      }
      g.triangles = 0;
      g.brickCount = nodes.reduce((n, d) => n + (d.bricks !== undefined ? farBrickCount(d.bricks) : 0), 0);
      g.bytes = geometryBytes(geo);
      mesh = new THREE.Mesh(geo, this.brickMaterial.material);
      mesh.onBeforeRender = () => this.checkPalette();
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
    this.place(mesh, g.cell);
    g.mesh = mesh;
    this.root.add(mesh);
  }

  private place(o3: THREE.Object3D, cell: readonly number[]): void {
    const o = this.opts.origin.origin;
    o3.position.set((cell[0]! - o.x) * VOXEL_SIZE_M, (cell[1]! - o.y) * VOXEL_SIZE_M, (cell[2]! - o.z) * VOXEL_SIZE_M);
    o3.updateMatrix();
    o3.updateMatrixWorld(true);
  }

  /** After a floating-origin re-base: every draw's position again, and the cover's corner. */
  rebase(): void {
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
    m.vertexNode = farClipPosition();
    this.material = m;
    return m;
  }

  dispose(): void {
    for (const g of this.groups.values()) g.mesh?.geometry.dispose();
    this.groups.clear();
    this.groupOf.clear();
    this.regions.clear();
    this.pages.clear();
    this.root.clear();
    this.material?.dispose();
    this.brickMaterial?.dispose();
    this.atlas?.dispose();
    this.palette?.dispose();
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
  for (const a of Object.values(geo.attributes)) n += (a as THREE.BufferAttribute).array.byteLength;
  return n;
}
