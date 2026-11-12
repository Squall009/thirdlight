/**
 * The far bricks drawn as a visibility pass and one shade (WebGPU): the
 * march writes, per pixel, only what its hit is shaded from, into a target
 * of its own; one full-screen draw in the frame shades every far pixel
 * once from it, with the scene's lights, environment and fog, and writes
 * the hit's depth and motion. Where the march shaded each fragment itself,
 * every node box a ray met behind the first hit (the ground behind a ridge
 * is hit at once, inside its solid) paid the normal's six reads, the colour
 * and the lighting before the depth test threw it away.
 *
 * - **The pass.** The brick groups live in this pass's own scene. Right
 *   before the shade draws (its `onBeforeRender`, inside the frame's render,
 *   so the culled lists and the depth pyramid of the frame's first pass are
 *   ready), they are drawn into the target with the frame's camera: a node
 *   box a node, culled and depth-rejected as before, the nearest hit kept by
 *   the target's depth.
 * - **The texel** ({@link packFarVisibility}): the hit's brick (its atlas
 *   region, a byte an axis in bricks), the hit in that brick's cells (12 bits
 *   an axis), its view depth, and the face the ray entered the brick by (the
 *   normal where the field has no gradient); 0 where nothing was hit. One
 *   RGBA float texel, the integers exact in its 24-bit mantissas.
 * - **The shade** reads its own pixel's texel (no filtering: one texel is
 *   one pixel), places the hit on the pixel's ray at its depth, reads the
 *   normal and the colour from the atlas there, and is lit as a far draw:
 *   the standard material, the scene's lights and environment, the scene's
 *   fog at the hit's own depth. Its depth is the far draws' (behind the near
 *   field in its edge ring, voxel-far-common.ts) and its motion the hit's
 *   own, so the temporal upscale reprojects the far field by where the
 *   surface was, not where the box's back face was.
 */
import * as THREE from 'three';
import { MeshStandardNodeMaterial, NodeMaterial } from 'three/webgpu';
import * as TSLTyped from 'three/tsl';
import { DISTANCE_BRICK_CELLS, DISTANCE_BRICK_SIDE, FAR_BRICK_LIP_CELLS, VOXEL_SIZE_M, type FloatingOrigin } from '@thirdlight/voxel';

import { INSTANCE_CULLER_KEY } from './attribute-instancing';
import { cameraRelative, cameraRelativeModelView } from './camera-relative';
import type { N } from './effects-tsl';
import { OWN_MOTION_KEY, worldMotion } from './motion-vectors';
import { AFTER_PYRAMID_KEY, wantPyramidPath } from './occlusion-passes';
import { texelTexture } from './texel-texture-node';
import { faceOfCode, INSIDE_FACE_CODE, type FarBrickTextures } from './voxel-far-brick-field';
import { farFragmentDepth, type FarCover } from './voxel-far-common';

const TSL: N = TSLTyped;
const { Discard, Fn, If, cameraProjectionMatrixInverse, cameraViewMatrix, cameraWorldMatrix, clamp, context, float, floor, int, ivec2, mod, normalize, positionGeometry, positionView, property, round, screenCoordinate, uniform, vec3, vec4 } = TSL;

/** The page flag for comparisons: `?farPass=direct` shades each brick fragment in the frame (the march's own shading) instead of the visibility pass. */
export const FAR_PASS_URL_PARAM = 'farPass';

/** Whether a page's query string leaves the far bricks on the visibility pass (anything but `direct`). */
export function farVisibilityFromUrl(search: string): boolean {
  return new URLSearchParams(search).get(FAR_PASS_URL_PARAM) !== 'direct';
}

/** Where a hit's brick cells start in the texel (the box's lip on a node face and a cell of slack below 0). */
export const FAR_VIS_CELL_FROM = -(FAR_BRICK_LIP_CELLS + 1);
/** The span of brick cells the texel holds (from {@link FAR_VIS_CELL_FROM}). */
export const FAR_VIS_CELL_SPAN = DISTANCE_BRICK_CELLS + 2 * (FAR_BRICK_LIP_CELLS + 1);
/** Steps a hit's cell coordinate is held in (12 bits). */
export const FAR_VIS_CELL_STEPS = 4095;
/** A face code's place in the last float (above the third coordinate's 12 bits): a texel whose last float is below it holds no hit. */
export const FAR_VIS_FACE_SCALE = 4096;
const FACE_SCALE = FAR_VIS_FACE_SCALE;

/** A far hit as the visibility texel holds it. */
export interface FarVisibilityHit {
  /** The hit's brick: its atlas region in bricks (texels ÷ the region side). */
  readonly brick: readonly [number, number, number];
  /** The hit in its brick's cells. */
  readonly at: readonly [number, number, number];
  /** Its view depth (metres, negative in front). */
  readonly viewZ: number;
  /** The face its ray entered the brick by: 1–6 (axis × 2 + 1, +1 on the positive side). */
  readonly face: number;
}

const cellStep = (c: number): number => Math.round(Math.min(1, Math.max(0, (c - FAR_VIS_CELL_FROM) / FAR_VIS_CELL_SPAN)) * FAR_VIS_CELL_STEPS);
const stepCell = (q: number): number => (q / FAR_VIS_CELL_STEPS) * FAR_VIS_CELL_SPAN + FAR_VIS_CELL_FROM;

/** A hit as its texel (the CPU form of the march's output; the shade reads it back with {@link unpackFarVisibility}). */
export function packFarVisibility(h: FarVisibilityHit): [number, number, number, number] {
  const [bx, by, bz] = h.brick;
  if (h.face < 1 || h.face > 6) throw new RangeError(`far visibility: face ${h.face}`);
  return [bx + 256 * by + 65536 * bz, cellStep(h.at[0]) * 4096 + cellStep(h.at[1]), h.viewZ, cellStep(h.at[2]) + FACE_SCALE * h.face];
}

/** A texel back to its hit (null: nothing hit there). */
export function unpackFarVisibility(t: readonly number[]): FarVisibilityHit | null {
  const w = t[3]!;
  if (w < FACE_SCALE) return null;
  const r = t[0]!;
  const xy = t[1]!;
  return { brick: [r % 256, Math.floor(r / 256) % 256, Math.floor(r / 65536)], at: [stepCell(Math.floor(xy / 4096)), stepCell(xy % 4096), stepCell(w % FACE_SCALE)], viewZ: t[2]!, face: Math.floor(w / FACE_SCALE) };
}

/** The march's output (TSL): `region` the brick's atlas region (texels), `p` the hit in its cells, `face` its code. */
export function farVisibilityOutput(region: N, p: N, viewZ: N, face: N): N {
  const b = round(region.div(DISTANCE_BRICK_SIDE));
  const q = round(clamp(p.sub(FAR_VIS_CELL_FROM).div(FAR_VIS_CELL_SPAN), 0, 1).mul(FAR_VIS_CELL_STEPS));
  return vec4(b.x.add(b.y.mul(256)).add(b.z.mul(65536)), q.x.mul(4096).add(q.y), viewZ, q.z.add(face.mul(FACE_SCALE)));
}

/** The shade's read of a texel (TSL): the brick's region (texels), the hit in its cells, the view depth and the face's normal. */
function readTexel(t: N): { region: N; p: N; viewZ: N; face: N; inside: N } {
  const r = t.x;
  const brick = vec3(mod(r, 256), mod(floor(r.div(256)), 256), floor(r.div(65536)));
  const cell = (q: N): N => q.div(FAR_VIS_CELL_STEPS).mul(FAR_VIS_CELL_SPAN).add(FAR_VIS_CELL_FROM);
  const p = vec3(cell(floor(t.y.div(4096))), cell(mod(t.y, 4096)), cell(mod(t.w, FACE_SCALE)));
  const code = floor(t.w.div(FACE_SCALE));
  return { region: brick.mul(DISTANCE_BRICK_SIDE), p, viewZ: t.z, face: faceOfCode(code), inside: code.equal(INSIDE_FACE_CODE) };
}

/** What the pass draws with (three's WebGPU renderer). */
export interface FarVisibilityRenderer {
  getRenderTarget(): THREE.RenderTarget | null;
  setRenderTarget(target: THREE.RenderTarget | null): void;
  getMRT(): unknown;
  setMRT(mrt: unknown): void;
  getDrawingBufferSize(target: THREE.Vector2): THREE.Vector2;
  getClearColor(target: THREE.Color): THREE.Color;
  getClearAlpha(): number;
  setClearColor(color: THREE.ColorRepresentation, alpha?: number): void;
  autoClear: boolean;
  autoClearColor: boolean;
  autoClearDepth: boolean;
  autoClearStencil: boolean;
  render(scene: THREE.Object3D, camera: THREE.Camera): void;
}

/** A material for the march into the visibility target: unlit, its output the texel. */
export function farVisibilityMaterial(): NodeMaterial {
  const m = new NodeMaterial();
  m.fog = false;
  m.lights = false;
  return m;
}

/** The far bricks' visibility pass and its shade. */
export class FarVisibility {
  /** The brick draws' own scene (the far view puts its brick groups in {@link root}). */
  readonly scene = new THREE.Scene();
  /** The brick groups' parent in {@link scene}: placed as the far view's root is. */
  readonly root = new THREE.Group();
  /** The full-screen shade in the frame. */
  readonly shade: THREE.Mesh;
  private readonly target = new THREE.RenderTarget(1, 1, { type: THREE.FloatType, format: THREE.RGBAFormat, depthBuffer: true, minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter, generateMipmaps: false });
  /** The far view's root rotation into the world (a brick's cells are its axes). */
  private readonly rootWorld = uniform(new THREE.Matrix4());
  /** A hit's world place this frame to its place on the last (a floating-origin re-base moves the far field's draws). */
  private readonly lastFromNow = uniform(new THREE.Matrix4());
  private readonly size = new THREE.Vector2();
  private readonly clear = new THREE.Color();
  private readonly lastRoot = new THREE.Matrix4();
  private readonly lastOrigin = new THREE.Vector3();
  private seen = false;
  /** Told after each pass, its target drawn (the visibility feedback reduces it then: voxel-far-feedback.ts). */
  onPass: ((renderer: FarVisibilityRenderer, target: THREE.RenderTarget) => void) | null = null;
  private readonly scratch = new THREE.Matrix4();
  private readonly scratch2 = new THREE.Matrix4();
  /** Passes drawn. */
  passes = 0;

  constructor(
    textures: FarBrickTextures,
    cover: FarCover,
    /** The far view's root: the groups are placed as if below it. */
    private readonly source: THREE.Object3D,
    private readonly origin: FloatingOrigin,
  ) {
    this.target.texture.colorSpace = THREE.NoColorSpace;
    this.scene.add(this.root);
    this.scene.matrixWorldAutoUpdate = false;
    this.root.matrixAutoUpdate = false;
    const m = cameraRelative(new MeshStandardNodeMaterial());
    m.name = 'voxel far shade';
    m.metalness = 0;
    m.roughness = 1;
    // A plane in front of the camera (the mesh is placed at the camera): each pixel's ray, along which its hit lies.
    m.positionNode = Fn(() => {
      const p = cameraProjectionMatrixInverse.mul(vec4(positionGeometry.xy, 0.5, 1));
      return p.xyz.div(p.w);
    })();
    m.vertexNode = vec4(positionGeometry.xy, 0, 1);
    const vis = texelTexture(this.target.texture);
    const colourOut = property('vec3', 'farShadeColour');
    const normalOut = property('vec3', 'farShadeNormal');
    const hitViewZ = property('float', 'farShadeViewZ');
    const hitWorld = property('vec3', 'farShadeWorld');
    const rootWorld = this.rootWorld;
    m.depthNode = Fn(() => {
      const t = vis.load(ivec2(int(screenCoordinate.x), int(screenCoordinate.y))).toVar();
      If(t.w.lessThan(FACE_SCALE - 0.5), () => {
        Discard();
      });
      const hit = readTexel(t);
      const region = hit.region.toVar();
      const p = hit.p.toVar();
      hitViewZ.assign(hit.viewZ);
      // The pixel's ray (its plane point, view space) to the hit's depth.
      const ray = positionView.toVar();
      const view = ray.mul(hitViewZ.div(ray.z));
      hitWorld.assign(cameraWorldMatrix.mul(vec4(view, 1)).xyz);
      const shaded = textures.shade(region, p, hit.face, hit.inside);
      normalOut.assign(normalize(cameraViewMatrix.mul(vec4(normalize(rootWorld.mul(vec4(shaded.normal, 0)).xyz), 0)).xyz));
      colourOut.assign(shaded.colour);
      return farFragmentDepth(cover.behindNear(hitWorld, hitViewZ));
    })();
    m.colorNode = vec4(colourOut, 1);
    m.normalNode = normalOut;
    // Fog at the hit's depth, not the plane's (three's fog reads the context's view depth where given).
    m.contextNode = context({ modelViewMatrix: cameraRelativeModelView, getViewZ: () => hitViewZ });
    m.userData[OWN_MOTION_KEY] = worldMotion(hitWorld, this.lastFromNow.mul(vec4(hitWorld, 1)).xyz);
    const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), m);
    quad.name = 'voxel-far shade';
    quad.frustumCulled = false;
    quad.matrixAutoUpdate = false;
    quad.matrixWorldAutoUpdate = false;
    quad.castShadow = quad.receiveShadow = false;
    quad.visible = false;
    // Drawn after the frame's depth pyramid (the march it starts reads it), in the frame's second pass.
    quad.userData[AFTER_PYRAMID_KEY] = true;
    quad.onBeforeRender = (renderer, scene, camera) => {
      quad.matrixWorld.copy(camera.matrixWorld);
      this.draw(renderer as unknown as FarVisibilityRenderer, scene, camera);
    };
    this.shade = quad;
  }

  /** Bytes the target holds (the texel and its depth a pixel). */
  get gpuBytes(): number {
    return this.target.width * this.target.height * (16 + 4);
  }

  /** The groups' world matrices again (the far view's root moved, or a group was placed). */
  sync(): void {
    if (this.root.matrixWorld.equals(this.source.matrixWorld)) return;
    this.root.matrixWorld.copy(this.source.matrixWorld);
    for (const c of this.root.children) c.updateMatrixWorld(true);
  }

  /** Shown while it has brick groups to draw. */
  update(): void {
    this.shade.visible = this.root.children.length > 0;
  }

  /** The march into the target, for `camera` in the frame drawing into the renderer's target now. */
  private draw(r: FarVisibilityRenderer, scene: THREE.Object3D, camera: THREE.Camera): void {
    const now = r.getRenderTarget();
    if (now !== null) this.size.set(now.width, now.height);
    else r.getDrawingBufferSize(this.size);
    const w = Math.max(1, this.size.x);
    const h = Math.max(1, this.size.y);
    if (this.target.width !== w || this.target.height !== h) this.target.setSize(w, h);
    this.sync();
    this.motion();
    // The culler and the pyramid path are the frame's scene's: the brick draws find them through their own scene.
    this.scene.userData[INSTANCE_CULLER_KEY] = scene.userData[INSTANCE_CULLER_KEY];
    if ((scene as THREE.Scene).overrideMaterial == null) wantPyramidPath(scene);
    const mrt = r.getMRT();
    r.getClearColor(this.clear);
    const alpha = r.getClearAlpha();
    const flags = [r.autoClear, r.autoClearColor, r.autoClearDepth, r.autoClearStencil] as const;
    r.setRenderTarget(this.target);
    r.setMRT(null);
    r.setClearColor(0x000000, 0);
    r.autoClear = r.autoClearColor = r.autoClearDepth = true;
    r.autoClearStencil = false;
    try {
      r.render(this.scene, camera);
      // The pass is submitted: what reads its target now runs after it on the GPU.
      this.onPass?.(r, this.target);
    } finally {
      [r.autoClear, r.autoClearColor, r.autoClearDepth, r.autoClearStencil] = flags;
      r.setRenderTarget(now);
      r.setMRT(mrt);
      r.setClearColor(this.clear, alpha);
    }
    this.passes++;
  }

  /** The root's rotation and the last frame's place of this frame's world points (rolled once a draw, as object motion is). */
  private motion(): void {
    const root = this.source.matrixWorld;
    (this.rootWorld.value as THREE.Matrix4).extractRotation(root);
    const o = this.origin.origin;
    if (!this.seen) {
      this.lastRoot.copy(root);
      this.lastOrigin.set(o.x, o.y, o.z);
      this.seen = true;
    }
    // A fixed point's world place is root · (cell − origin) · size: last = lastRoot · (inverse(root) · now + (origin − lastOrigin) · size).
    const shift = this.scratch.makeTranslation((o.x - this.lastOrigin.x) * VOXEL_SIZE_M, (o.y - this.lastOrigin.y) * VOXEL_SIZE_M, (o.z - this.lastOrigin.z) * VOXEL_SIZE_M);
    (this.lastFromNow.value as THREE.Matrix4).copy(this.lastRoot).multiply(shift).multiply(this.scratch2.copy(root).invert());
    this.lastRoot.copy(root);
    this.lastOrigin.set(o.x, o.y, o.z);
  }

  dispose(): void {
    this.target.dispose();
    this.shade.geometry.dispose();
    (this.shade.material as THREE.Material).dispose();
  }
}
