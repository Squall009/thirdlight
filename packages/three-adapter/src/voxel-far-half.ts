/**
 * The far bricks marched at half resolution: the brick draws go into a
 * scene of their own, drawn before the frame (`prepare`) into a target of
 * half the canvas's size per axis, a quarter of the pixels marched, which
 * holds per pixel what the lit draw needs and nothing lit: the colour, the
 * normal (view space) and the hit's view depth. A full-screen draw in the
 * frame (the composite) reads it back at full resolution and is lit there
 * by the scene's lights like any far draw, writing the hit's far depth, so
 * it sorts against the near field and the far meshes per pixel as the
 * bricks did.
 *
 * - **Upsampling.** A full-resolution pixel reads the four half-resolution
 *   texels round it with their bilinear weights, each weighed down by how
 *   far its depth is from the nearest texel's (a texel across a silhouette
 *   counts for nothing), and texels the march missed count for nothing: a
 *   pixel with less than half its weight on hits shows what is behind.
 * - **Packing.** One RGBA float texel a pixel: the colour's bytes as one
 *   24-bit integer, the normal octahedral at 12 bits a coordinate, the view
 *   depth, and 1 for a hit (cleared to 0).
 *
 * Why the composite is lit and not the march: lighting at half resolution
 * would need the scene's lights in the far bricks' own scene; drawn in the
 * frame, the composite takes them, with the view direction of its pixel
 * (its vertices lie on a plane in front of the camera).
 */
import * as THREE from 'three';
import { MeshStandardNodeMaterial } from 'three/webgpu';
import * as TSLTyped from 'three/tsl';

import { cameraRelative } from './camera-relative';
import type { N } from './effects-tsl';
import { farFragmentDepth } from './voxel-far-common';

const TSL: N = TSLTyped;
const { Discard, Fn, If, abs, cameraProjectionMatrixInverse, exp, float, floor, max, mod, normalize, positionGeometry, round, screenUV, select, sign, texture, uniform, vec2, vec3, vec4 } = TSL;

/** How fast a half-resolution texel's weight falls with its depth's distance from the nearest texel's (a share of that depth). */
const DEPTH_FALLOFF = 0.02;

/** What a brick draw writes into the half-resolution target (its `outputNode`): colour, view normal and view depth packed (see the module). */
export function farHalfOutput(colour: N, viewNormal: N, viewZ: N): N {
  const c = round(TSL.clamp(colour, 0, 1).mul(255));
  const packedColour = c.x.mul(65536).add(c.y.mul(256)).add(c.z);
  // Octahedral normal in [0, 1]², 12 bits a coordinate.
  const n = viewNormal.div(abs(viewNormal.x).add(abs(viewNormal.y)).add(abs(viewNormal.z)));
  const folded = select(n.z.lessThan(0), vec2(float(1).sub(abs(n.y)).mul(sign(n.x)), float(1).sub(abs(n.x)).mul(sign(n.y))), n.xy);
  const q = round(folded.mul(0.5).add(0.5).mul(4095));
  return vec4(packedColour, q.x.mul(4096).add(q.y), viewZ, 1);
}

function unpackColour(v: N): N {
  const r = floor(v.div(65536));
  const g = floor(mod(v, 65536).div(256));
  const b = mod(v, 256);
  return vec3(r, g, b).div(255);
}

function unpackNormal(v: N): N {
  const f = vec2(floor(v.div(4096)), mod(v, 4096)).div(4095).mul(2).sub(1);
  const z = float(1).sub(abs(f.x)).sub(abs(f.y));
  const xy = select(z.lessThan(0), vec2(float(1).sub(abs(f.y)).mul(sign(f.x)), float(1).sub(abs(f.x)).mul(sign(f.y))), f);
  return normalize(vec3(xy, z));
}

/** What the half-resolution pass draws with (three's WebGPU renderer, either backend). */
export interface FarHalfRenderer {
  getRenderTarget(): THREE.RenderTarget | null;
  setRenderTarget(target: THREE.RenderTarget | null): void;
  getDrawingBufferSize(target: THREE.Vector2): THREE.Vector2;
  getClearColor(target: THREE.Color): THREE.Color;
  getClearAlpha(): number;
  setClearColor(color: THREE.ColorRepresentation, alpha?: number): void;
  clear(color?: boolean, depth?: boolean, stencil?: boolean): void;
  render(scene: THREE.Object3D, camera: THREE.Camera): void;
}

/** The far bricks' half-resolution pass and its composite. */
export class FarHalfRes {
  /** The brick draws' own scene (the far view puts its brick groups here). */
  readonly scene = new THREE.Scene();
  /** The brick groups' parent in {@link scene}: placed as the far view's root is. */
  readonly root = new THREE.Group();
  /** The full-screen draw in the frame. */
  readonly composite: THREE.Mesh;
  private readonly target = new THREE.RenderTarget(1, 1, { type: THREE.FloatType, format: THREE.RGBAFormat, depthBuffer: true, minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter, generateMipmaps: false });
  private readonly sizeU = uniform(new THREE.Vector2(1, 1));
  private readonly size = new THREE.Vector2();
  private readonly clear = new THREE.Color();
  /** Passes drawn. */
  passes = 0;

  constructor() {
    this.target.texture.colorSpace = THREE.NoColorSpace;
    this.scene.add(this.root);
    this.root.matrixAutoUpdate = false;
    const m = cameraRelative(new MeshStandardNodeMaterial());
    m.name = 'voxel far bricks (half resolution)';
    m.metalness = 0;
    m.roughness = 1;
    m.depthTest = true;
    m.depthWrite = true;
    // A plane in front of the camera (the mesh is placed at the camera): the pixel's view direction for the lighting.
    m.positionNode = Fn(() => {
      const p = cameraProjectionMatrixInverse.mul(vec4(positionGeometry.xy, 0.5, 1));
      return p.xyz.div(p.w);
    })();
    m.vertexNode = vec4(positionGeometry.xy, 0, 1);
    const gbuffer = texture(this.target.texture);
    const size = this.sizeU;
    const colourOut = TSL.property('vec3', 'farHalfColour');
    const normalOut = TSL.property('vec3', 'farHalfNormal');
    m.depthNode = Fn(() => {
      // The four half-resolution texels round the pixel and their bilinear weights.
      const hp = screenUV.mul(size).sub(0.5);
      const i0 = floor(hp).toVar();
      const f = hp.sub(i0).toVar();
      const at = (dx: number, dy: number): N => gbuffer.sample(i0.add(vec2(dx, dy)).add(0.5).div(size)).level(float(0));
      const t = [at(0, 0), at(1, 0), at(0, 1), at(1, 1)].map((s) => s.toVar());
      const bw = [float(1).sub(f.x).mul(float(1).sub(f.y)), f.x.mul(float(1).sub(f.y)), float(1).sub(f.x).mul(f.y), f.x.mul(f.y)];
      // The reference depth: the hit texel with the largest bilinear weight.
      const refZ = float(0).toVar();
      const best = float(-1).toVar();
      for (let k = 0; k < 4; k++) {
        If(t[k]!.w.greaterThan(0.5).and(bw[k]!.greaterThan(best)), () => {
          best.assign(bw[k]!);
          refZ.assign(t[k]!.z);
        });
      }
      If(best.lessThan(0), () => {
        Discard();
      });
      const sum = float(0).toVar();
      const colour = vec3(0).toVar();
      const normal = vec3(0).toVar();
      for (let k = 0; k < 4; k++) {
        const w = bw[k]!.mul(t[k]!.w).mul(exp(abs(t[k]!.z.sub(refZ)).div(max(abs(refZ).mul(DEPTH_FALLOFF), float(1e-3))).negate())).toVar();
        sum.addAssign(w);
        colour.addAssign(unpackColour(t[k]!.x).mul(w));
        normal.addAssign(unpackNormal(t[k]!.y).mul(w));
      }
      // Under half its bilinear weight on hits: the pixel shows what lies behind (a silhouette at full resolution).
      const hits = bw[0]!.mul(t[0]!.w).add(bw[1]!.mul(t[1]!.w)).add(bw[2]!.mul(t[2]!.w)).add(bw[3]!.mul(t[3]!.w));
      If(hits.lessThan(0.5), () => {
        Discard();
      });
      colourOut.assign(colour.div(sum));
      normalOut.assign(normalize(normal));
      return farFragmentDepth(refZ);
    })();
    m.colorNode = vec4(colourOut, 1);
    m.normalNode = normalOut;
    const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), m);
    quad.name = 'voxel-far half-resolution composite';
    quad.frustumCulled = false;
    quad.matrixAutoUpdate = false;
    quad.matrixWorldAutoUpdate = false;
    quad.castShadow = quad.receiveShadow = false;
    // Placed at the drawing camera, so its model-view is the camera's identity and its plane lies in front.
    quad.onBeforeRender = (_r, _s, camera) => {
      quad.matrixWorld.copy(camera.matrixWorld);
    };
    this.composite = quad;
  }

  /** Before the frame: the brick draws marched into the half-resolution target with `camera` (nothing when none are drawn). */
  prepare(renderer: FarHalfRenderer, camera: THREE.Camera, parent: THREE.Object3D): void {
    this.composite.visible = this.root.children.length > 0;
    if (!this.composite.visible) return;
    renderer.getDrawingBufferSize(this.size);
    const w = Math.max(1, Math.ceil(this.size.x / 2));
    const h = Math.max(1, Math.ceil(this.size.y / 2));
    if (this.target.width !== w || this.target.height !== h) this.target.setSize(w, h);
    (this.sizeU.value as THREE.Vector2).set(w, h);
    this.root.matrixWorld.copy(parent.matrixWorld);
    for (const c of this.root.children) c.updateMatrixWorld(true);
    const saved = renderer.getRenderTarget();
    renderer.getClearColor(this.clear);
    const alpha = renderer.getClearAlpha();
    renderer.setRenderTarget(this.target);
    renderer.setClearColor(0x000000, 0);
    renderer.clear(true, true, false);
    renderer.render(this.scene, camera);
    renderer.setRenderTarget(saved);
    renderer.setClearColor(this.clear, alpha);
    this.passes++;
  }

  dispose(): void {
    this.target.dispose();
    this.composite.geometry.dispose();
    (this.composite.material as THREE.Material).dispose();
  }
}
