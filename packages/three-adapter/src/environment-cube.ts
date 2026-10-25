/**
 * The image-based lighting a lit surface reads, from a cube with a mip chain.
 *
 * three's PMREM keeps the prefiltered sky in one atlas texture, and a lit
 * fragment decodes it twice (the reflection at its roughness, the diffuse light
 * at roughness 1): a face, its texel and two mip levels each time. On a field of
 * grass at 1080p, many fragments deep, that decoding was a sixth of an integrated
 * GPU's frame. Here the same prefiltered light is copied, once per bake, into a
 * cube whose mip levels hold it at rising roughness (level k: roughness
 * k / `ENVIRONMENT_CUBE_ROUGH_LEVELS`, sampled from the PMREM itself), and a
 * fragment reads it with one trilinear lookup per term. The scene's
 * `environmentNode` points three's own environment lighting at it, so every lit
 * material (and the scene's environment rotation and intensity) works as before.
 */
import * as THREE from 'three';
import { CubeRenderTarget, MeshBasicNodeMaterial, TempNode, type NodeBuilder, type WebGPURenderer } from 'three/webgpu';
import * as TSLTyped from 'three/tsl';

import type { N } from './effects-tsl';

/** TSL untyped: three's typings lag the node API used here. */
const TSL: N = TSLTyped;
const { clamp, cameraPosition, cubeTexture, float, normalWorld, pmremTexture, positionWorld, uniform } = TSL;

/** The cube's side at level 0 (texels): the sharpest reflection, as three's PMREM bakes a sky. */
export const ENVIRONMENT_CUBE_SIZE = 256;

/**
 * The mip level roughness 1 maps to: 256 / 2⁴ = 16 texels a side, enough for
 * the softest reflection and the diffuse light. Levels past it are left undrawn: the lookup never reads them.
 */
export const ENVIRONMENT_CUBE_ROUGH_LEVELS = 4;

/** Reads the cube where three's environment lighting asks (its direction and roughness come from the lighting's context). */
class EnvironmentCubeNode extends TempNode {
  constructor(private readonly cube: THREE.CubeTexture) {
    super('vec3');
  }

  override setup(builder: NodeBuilder): N {
    const context = (builder as unknown as { context: { getUV?: (node: unknown, b: NodeBuilder) => N; getTextureLevel?: (node: unknown) => N } }).context;
    const direction = context.getUV?.(this, builder) ?? normalWorld;
    const roughness = context.getTextureLevel?.(this) ?? float(0);
    return cubeTexture(this.cube, direction, clamp(roughness, 0, 1).mul(ENVIRONMENT_CUBE_ROUGH_LEVELS)).rgb;
  }
}

/** One renderer's lighting cube: `bake` copies a PMREM texture into it; `node` is what a scene's `environmentNode` takes. */
export class EnvironmentCube {
  readonly node: N;
  private readonly target: CubeRenderTarget;
  private readonly camera: THREE.CubeCamera;
  private readonly scene = new THREE.Scene();
  private readonly material: MeshBasicNodeMaterial;
  private readonly mesh: THREE.Mesh;
  private readonly roughness: N = uniform(0);
  private readonly source: N;
  private allocated = false;

  constructor(private readonly renderer: WebGPURenderer) {
    this.target = new CubeRenderTarget(ENVIRONMENT_CUBE_SIZE, { type: THREE.HalfFloatType, generateMipmaps: false, depthBuffer: false });
    this.target.texture.minFilter = THREE.LinearMipmapLinearFilter;
    this.target.texture.magFilter = THREE.LinearFilter;
    this.camera = new THREE.CubeCamera(0.1, 10, this.target as never);
    // The PMREM's light along each direction from the cube's centre, at the level's roughness.
    this.source = pmremTexture(new THREE.Texture(), positionWorld.sub(cameraPosition).normalize(), this.roughness);
    this.material = new MeshBasicNodeMaterial({ side: THREE.BackSide, depthWrite: false, depthTest: false });
    this.material.colorNode = this.source;
    this.material.fog = false;
    this.mesh = new THREE.Mesh(new THREE.BoxGeometry(2, 2, 2), this.material);
    this.mesh.frustumCulled = false;
    this.scene.add(this.mesh);
    this.node = new EnvironmentCubeNode(this.target.texture as THREE.CubeTexture);
  }

  /** Copy a PMREM texture (three's `PMREMGenerator` output) into the cube, every level. */
  bake(pmrem: THREE.Texture): void {
    (this.source as { value: THREE.Texture }).value = pmrem;
    const tex = this.target.texture;
    // The copy is preparation, not the view's drawing: a view's draw count reads what it shows.
    const info = (this.renderer as unknown as { info?: { render?: { drawCalls: number; triangles: number; calls: number; frameCalls: number } } }).info?.render;
    const counted = info === undefined ? null : { ...info };
    const saved = { target: this.renderer.getRenderTarget(), face: this.renderer.getActiveCubeFace(), level: this.renderer.getActiveMipmapLevel(), autoClear: this.renderer.autoClear };
    this.renderer.autoClear = true;
    if (!this.allocated) {
      // Allocated with its whole mip chain (the cube camera turns generation off while it draws, which would
      // allocate one level); after that the levels are drawn here, never generated.
      tex.generateMipmaps = true;
      this.renderer.initRenderTarget(this.target);
      tex.generateMipmaps = false;
      this.allocated = true;
    }
    // Levels past roughness 1 are never read (the lookup's level stops there).
    for (let level = 0; level <= ENVIRONMENT_CUBE_ROUGH_LEVELS; level++) {
      this.roughness.value = level / ENVIRONMENT_CUBE_ROUGH_LEVELS;
      this.camera.activeMipmapLevel = level;
      this.camera.update(this.renderer as never, this.scene);
    }
    this.camera.activeMipmapLevel = 0;
    this.renderer.autoClear = saved.autoClear;
    this.renderer.setRenderTarget(saved.target, saved.face, saved.level);
    if (info !== undefined && counted !== null) Object.assign(info, counted);
  }

  dispose(): void {
    this.target.dispose();
    this.material.dispose();
    this.mesh.geometry.dispose();
  }
}

/** The PMREM calls the environment renderer uses (`three/webgpu`'s generator). */
export interface PmremLike {
  fromScene(scene: THREE.Scene, sigma?: number, near?: number, far?: number, options?: { renderTarget?: unknown }): { texture: THREE.Texture; dispose(): void };
  fromEquirectangular(texture: THREE.Texture): { texture: THREE.Texture; dispose(): void };
  fromCubemap(texture: THREE.CubeTexture): { texture: THREE.Texture; dispose(): void };
  dispose(): void;
}

/**
 * A scene's image-based lighting through the cube: `pmrem` bakes as the generator does and counts its bakes;
 * `sync` (once a frame, before drawing) copies the scene's PMREM into the cube when it or its bake changed and
 * points the scene's environment lighting at the cube (none without an environment).
 */
export class SceneLighting {
  readonly pmrem: PmremLike;
  private cube: EnvironmentCube | null = null;
  private bakes = 0;
  private copiedFrom: THREE.Texture | null = null;
  private copiedBake = -1;

  constructor(private readonly renderer: WebGPURenderer, private readonly scene: THREE.Scene, private readonly generator: PmremLike) {
    this.pmrem = {
      fromScene: (...a) => (this.bakes++, generator.fromScene(...a)),
      fromEquirectangular: (t) => (this.bakes++, generator.fromEquirectangular(t)),
      fromCubemap: (t) => (this.bakes++, generator.fromCubemap(t)),
      dispose: () => generator.dispose(),
    };
  }

  sync(): void {
    const s = this.scene as THREE.Scene & { environmentNode?: unknown };
    const env = this.scene.environment;
    if (env === null) {
      if (s.environmentNode !== undefined && s.environmentNode !== null) s.environmentNode = null;
      return;
    }
    if (env !== this.copiedFrom || this.bakes !== this.copiedBake) {
      this.cube ??= new EnvironmentCube(this.renderer);
      this.cube.bake(env);
      this.copiedFrom = env;
      this.copiedBake = this.bakes;
    }
    if (s.environmentNode !== this.cube!.node) s.environmentNode = this.cube!.node;
  }

  dispose(): void {
    this.generator.dispose();
    this.cube?.dispose();
  }
}

