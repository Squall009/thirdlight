/**
 * Baking a terrain tile's macro texture: what the tile's material draws, seen
 * from straight above, at a few metres a texel — its albedo, and its world
 * normal (the heights' and the normal maps' together) — so the view can draw
 * far nodes from one read of each instead of the layer stack
 * (`terrainMacroMaterial`).
 *
 * A bake draws the tile's finest nodes (no morph) with two unlit materials
 * made from the page's own material — its colour, and its shading normal
 * turned into world space — into a small target with an orthographic camera
 * over the tile, and copies the target into the tile's layer of the page's
 * macro arrays (the GPU only: nothing is read back). A material is compiled
 * ahead (`compileAsync`) before its first bake, so a bake never compiles on
 * the frame it runs.
 *
 * Browser-only (three's WebGPURenderer, WebGPU or WebGL 2).
 */
import * as THREE from 'three';
import * as TSLTyped from 'three/tsl';
import { MeshBasicNodeMaterial, type NodeMaterial, type WebGPURenderer } from 'three/webgpu';

import type { N } from './effects-tsl';
import { nodeGeometry } from './terrain-grid';
import { terrainMacroFlip } from './terrain-material';
import { TERRAIN_NODE_FLOATS, type TerrainLodLayout } from './terrain-quadtree';
import { disposeSharingGeometry } from './dispose';

/** TSL untyped: three's typings lag the node API used here. */
const TSL: N = TSLTyped;
const { cameraWorldMatrix, normalWorld, normalize, vec4 } = TSL;

/** The most texels along a tile's macro texture side (a smaller tile: one per cell). */
export const TERRAIN_MACRO_TEXELS = 128;

/** Texels along a macro texture's side for a tile size. */
export const terrainMacroSize = (tileSamples: number): number => Math.min(TERRAIN_MACRO_TEXELS, tileSamples - 1);

/** A page's macro arrays: albedo (linear RGB) and world normal (× 0.5 + 0.5), one layer per tile. */
export interface TerrainMacroArrays {
  readonly albedo: THREE.DataArrayTexture;
  readonly normal: THREE.DataArrayTexture;
}

export function terrainMacroArrays(size: number, capacity: number): TerrainMacroArrays {
  const make = (): THREE.DataArrayTexture => {
    const t = new THREE.DataArrayTexture(new Uint8Array(size * size * 4 * capacity), size, size, capacity);
    t.format = THREE.RGBAFormat;
    t.type = THREE.UnsignedByteType;
    t.colorSpace = THREE.NoColorSpace;
    t.magFilter = THREE.LinearFilter;
    t.minFilter = THREE.LinearFilter;
    t.generateMipmaps = false;
    t.wrapS = THREE.ClampToEdgeWrapping;
    t.wrapT = THREE.ClampToEdgeWrapping;
    t.flipY = false;
    t.needsUpdate = true;
    return t;
  };
  return { albedo: make(), normal: make() };
}

/** One tile to bake: where it is, the page's material and surface data, and the layer it goes to. */
export interface TerrainMacroJob {
  /** The tile's min corner in the terrain's frame (metres) and its side (metres). */
  readonly x: number;
  readonly z: number;
  readonly size: number;
  /** The tile's texture layer on its page. */
  readonly layer: number;
  readonly layout: TerrainLodLayout;
  /** The terrain object's world matrix (the page's mesh's). */
  readonly matrixWorld: THREE.Matrix4;
  /** The heights the tile spans (metres, the terrain's frame): the camera's depth. */
  readonly low: number;
  readonly high: number;
  /** The material the page draws with, and its mesh's user data (objects' overrides). */
  readonly material: THREE.Material;
  readonly userData: Record<string, unknown>;
  readonly arrays: TerrainMacroArrays;
}

/**
 * What a bake of a material draws from: the material and its nodes (a graph
 * material is compiled again in place when its textures arrive: its nodes
 * change, the object does not).
 */
export function terrainMacroSource(material: THREE.Material): readonly unknown[] {
  const m = material as unknown as { colorNode?: unknown; normalNode?: unknown; positionNode?: unknown; maskNode?: unknown; color?: THREE.Color };
  return [material, m.colorNode, m.normalNode, m.positionNode, m.maskNode, m.color?.getHex()];
}

/** Whether two sources are the same (element by element). */
export const sameMacroSource = (a: readonly unknown[] | null, b: readonly unknown[]): boolean => a !== null && a.length === b.length && a.every((x, i) => x === b[i]);

interface BakeMaterials {
  readonly albedo: THREE.Material;
  readonly normal: THREE.Material;
  /** The source they were made from. */
  readonly from: readonly unknown[];
  /** Compiled for the renderer (false: compiling in the background). */
  ready: boolean;
}

export class TerrainMacroBaker {
  private readonly renderer: WebGPURenderer;
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 10);
  private readonly mesh: THREE.Mesh;
  private readonly targets = new Map<number, THREE.RenderTarget>();
  private readonly materials = new WeakMap<THREE.Material, BakeMaterials>();
  /** The finest nodes of a tile, by layout (cells and grid) and layer. */
  private geometry: { key: string; geometry: THREE.InstancedBufferGeometry; own: THREE.InterleavedBufferAttribute[]; buffer: THREE.InstancedInterleavedBuffer } | null = null;
  private readonly grids: Map<number, THREE.BufferGeometry>;
  /** Tiles baked since the baker was made. */
  bakes = 0;

  constructor(renderer: WebGPURenderer, grids: Map<number, THREE.BufferGeometry>) {
    this.renderer = renderer;
    this.grids = grids;
    terrainMacroFlip.value = (renderer.backend as { isWebGLBackend?: boolean }).isWebGLBackend === true ? 1 : 0;
    this.mesh = new THREE.Mesh(new THREE.BufferGeometry(), new MeshBasicNodeMaterial());
    this.mesh.frustumCulled = false;
    this.mesh.matrixAutoUpdate = false;
    this.scene.add(this.mesh);
    // Looking straight down, the image's top toward −z: a target's first row is the tile's row at its min z (WebGPU).
    this.camera.up.set(0, 0, -1);
  }

  /**
   * Bake one tile (true: done). False while its material's bake programs
   * compile (they compile in the background; ask again a later frame).
   */
  bake(job: TerrainMacroJob): boolean {
    // The tile in place first: a material's programs compile against it.
    this.place(job);
    const mats = this.materialsFor(job.material);
    if (!mats.ready) return false;
    const size = job.arrays.albedo.image.width;
    const rt = this.target(size);
    const r = this.renderer;
    const saved = r.getRenderTarget();
    const at = new THREE.Vector3(0, 0, job.layer);
    for (const [mat, dst] of [[mats.albedo, job.arrays.albedo], [mats.normal, job.arrays.normal]] as const) {
      this.mesh.material = mat;
      r.setRenderTarget(rt);
      r.render(this.scene, this.camera);
      r.copyTextureToTexture(rt.texture, dst, null, at);
    }
    r.setRenderTarget(saved);
    this.bakes += 1;
    return true;
  }

  dispose(): void {
    for (const t of this.targets.values()) t.dispose();
    this.targets.clear();
    if (this.geometry !== null) disposeSharingGeometry(this.geometry.geometry, this.geometry.own);
    this.geometry = null;
  }

  /** The bake's two materials made from a page's material (and compiled ahead). */
  private materialsFor(src: THREE.Material): BakeMaterials {
    const from = terrainMacroSource(src);
    let m = this.materials.get(src);
    if (m !== undefined && sameMacroSource(m.from, from)) return m;
    if (m !== undefined) {
      m.albedo.dispose();
      m.normal.dispose();
    }
    const s = src as unknown as NodeMaterial & { color?: THREE.Color };
    const albedo = new MeshBasicNodeMaterial();
    albedo.colorNode = s.colorNode ?? vec4(s.color?.r ?? 1, s.color?.g ?? 1, s.color?.b ?? 1, 1);
    const normal = new MeshBasicNodeMaterial();
    // The shading normal (the material's, in the camera's view space) in world space.
    const world = s.normalNode != null ? normalize(cameraWorldMatrix.mul(vec4(s.normalNode, 0)).xyz) : normalWorld;
    normal.colorNode = vec4(world.mul(0.5).add(0.5), 1);
    for (const b of [albedo, normal]) {
      b.positionNode = s.positionNode;
      b.maskNode = (s as unknown as { maskNode?: N }).maskNode ?? null;
      b.side = THREE.FrontSide;
      b.toneMapped = false;
    }
    m = { albedo, normal, from, ready: false };
    this.materials.set(src, m);
    const made = m;
    // Compiled with a tile in place, so the programs are the bake's own.
    this.mesh.material = albedo;
    void this.renderer
      .compileAsync(this.scene, this.camera)
      .then(() => {
        this.mesh.material = normal;
        return this.renderer.compileAsync(this.scene, this.camera);
      })
      .then(() => {
        made.ready = true;
      })
      .catch(() => {
        made.ready = true;
      });
    return m;
  }

  /** The finest nodes of the job's tile in the mesh, the camera over the tile. */
  private place(job: TerrainMacroJob): void {
    const { cells, grid } = job.layout;
    const per = cells / grid;
    const key = `${cells}:${grid}`;
    if (this.geometry?.key !== key) {
      if (this.geometry !== null) disposeSharingGeometry(this.geometry.geometry, this.geometry.own);
      const made = nodeGeometry(this.gridOf(grid), per * per);
      this.geometry = { key, ...made };
      made.geometry.instanceCount = per * per;
    }
    const g = this.geometry;
    const d = g.buffer.array as Float32Array;
    const node = grid * job.layout.spacing;
    for (let j = 0; j < per; j++) {
      for (let i = 0; i < per; i++) {
        const o = (j * per + i) * TERRAIN_NODE_FLOATS;
        // Corner (terrain frame), size in samples, texture layer; corner in the tile's samples; no morph.
        d[o] = job.x + i * node;
        d[o + 1] = job.z + j * node;
        d[o + 2] = grid;
        d[o + 3] = job.layer;
        d[o + 4] = i * grid;
        d[o + 5] = j * grid;
        d[o + 6] = 1e9;
        d[o + 7] = 0;
      }
    }
    g.buffer.needsUpdate = true;
    this.mesh.geometry = g.geometry;
    // Its own matrix too: the bake scene's update composes the world matrix from it.
    this.mesh.matrix.copy(job.matrixWorld);
    this.mesh.matrixWorld.copy(job.matrixWorld);
    this.mesh.userData = job.userData;
    // Over the tile's middle, looking down, the tile's square in view.
    const half = job.size / 2;
    const c = new THREE.Vector3(job.x + half, job.high + 1, job.z + half).applyMatrix4(job.matrixWorld);
    this.camera.left = -half;
    this.camera.right = half;
    this.camera.top = half;
    this.camera.bottom = -half;
    this.camera.near = 0.5;
    this.camera.far = job.high - job.low + 2;
    this.camera.position.copy(c);
    this.camera.lookAt(c.x, c.y - 1, c.z);
    this.camera.updateProjectionMatrix();
    this.camera.updateMatrixWorld(true);
  }

  private gridOf(grid: number): THREE.BufferGeometry {
    const g = this.grids.get(grid);
    if (g === undefined) throw new Error(`terrain macro: no grid of ${grid} quads`);
    return g;
  }

  private target(size: number): THREE.RenderTarget {
    let t = this.targets.get(size);
    if (t === undefined) {
      t = new THREE.RenderTarget(size, size, { depthBuffer: false, type: THREE.UnsignedByteType, format: THREE.RGBAFormat, minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter, generateMipmaps: false });
      this.targets.set(size, t);
    }
    return t;
  }
}
