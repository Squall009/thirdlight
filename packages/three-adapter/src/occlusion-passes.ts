/**
 * The frame in two passes on WebGPU (occlusion culling's depth pyramid path):
 * the environment renderer's scene pass draws its one render as
 *
 * 1. the first pass: the opaque draws that fill the depth (every occluder
 *    role but `none`) and the `_OCC` stand-ins, which record into the
 *    pyramid only (occlusion-pyramid.ts), never into the scene's depth;
 * 2. the depth pyramid, reduced from the first pass's depth by compute;
 * 3. the second pass into the same targets without clearing: the opaque
 *    draws that do not count as occluders (cut-out, double-sided and
 *    opted-out surfaces, a model whose stand-ins speak for it) and every
 *    transparent draw.
 *
 * Each draw is drawn once, in one of the passes, with what it reads in the
 * one-pass frame: the depth it tests against is the opaque depth in front of
 * it either way (opaque draws are order-independent under the depth test),
 * and transparent draws come after every opaque one in both. So the picture
 * is the one-pass picture; the pixel checks hold it to that.
 *
 * Which pass draws what is three's render-object function, set for the two
 * renders only (a nested render, a shadow map's, sets its own and puts this
 * one back; another camera's draws pass through). The scene pass's clear,
 * its targets and outputs are three's `PassNode` render's: the second
 * render only turns the clear off and leaves the targets as they are.
 */
import type * as THREE from 'three';
import type { WebGPURenderer } from 'three/webgpu';

import type { N } from './effects-tsl';
import type { OccludeeRegistry } from './occludees';
import { DepthPyramid } from './occlusion-pyramid';

/** What the environment renderer's scene pass asks of a frame drawn in two passes. */
export interface ScenePasses {
  /**
   * Draw the scene pass's render (`render`: the renderer's own, the pass's
   * target, outputs and clear already set) as two passes with the pyramid
   * between them. `target` is the pass's render target (its depth is the pyramid's source).
   */
  draw(render: (scene: THREE.Object3D, camera: THREE.Camera) => void, scene: THREE.Object3D, camera: THREE.Camera, target: THREE.RenderTarget): void;
  /** The pyramid drawn over the frame instead of the picture (`?occlusion=pyramid`); null: the picture. `key` changes when the node must be built again. */
  view(): { readonly key: string; node(camera: { near: N; far: N }): N } | null;
}

type RenderObjectFunction = (object: THREE.Object3D, scene: THREE.Scene, camera: THREE.Camera, geometry: THREE.BufferGeometry, material: THREE.Material, group: unknown, lightsNode: unknown, clippingContext: unknown, passId: unknown) => void;

interface PassRenderer {
  autoClear: boolean;
  getRenderObjectFunction(): RenderObjectFunction | null;
  setRenderObjectFunction(fn: RenderObjectFunction | null): void;
  renderObject: RenderObjectFunction;
}

/** Whether three draws `material` among the transparent draws (its `RenderList.push` rule: transparent, transmission, a backdrop). */
function drawnAsTransparent(material: THREE.Material): boolean {
  const m = material as THREE.Material & { transmission?: number; transmissionNode?: { isNode?: boolean } | null; backdropNode?: { isNode?: boolean } | null };
  return m.transparent || (m.transmission ?? 0) > 0 || m.transmissionNode?.isNode === true || m.backdropNode?.isNode === true;
}

export class TwoPassFrame implements ScenePasses {
  readonly pyramid: DepthPyramid;
  /** The pass drawing now (0: neither): the stand-ins draw in the first only. */
  drawing: 0 | 1 | 2 = 0;
  /** The pyramid level shown over the frame (null: the picture). */
  shown: number | null = null;
  /** Frames drawn in two passes. */
  frames = 0;
  private camera: THREE.Camera | null = null;
  private readonly r: PassRenderer;
  /** The first pass's draws, hidden while the second render looks for its draws (and shown before it draws anything). */
  private readonly lifted: THREE.Object3D[] = [];

  constructor(
    renderer: WebGPURenderer,
    private readonly registry: OccludeeRegistry,
  ) {
    this.pyramid = new DepthPyramid(renderer);
    this.r = renderer as unknown as PassRenderer;
  }

  /** Whether `object` draws in the second pass: an occludee that is no occluder (its role is `none`). */
  secondPass(object: THREE.Object3D): boolean {
    return this.registry.get(object)?.role === 'none';
  }

  private readonly first: RenderObjectFunction = (object, scene, camera, geometry, material, group, lightsNode, clippingContext, passId) => {
    if (camera === this.camera && (drawnAsTransparent(material) || this.secondPass(object))) return;
    this.r.renderObject(object, scene, camera, geometry, material, group, lightsNode, clippingContext, passId);
  };

  private readonly second: RenderObjectFunction = (object, scene, camera, geometry, material, group, lightsNode, clippingContext, passId) => {
    if (this.lifted.length > 0) this.showLifted();
    // The opaque list again: only what the first pass left (three's background mesh, drawn first, is not drawn twice).
    if (camera === this.camera && !drawnAsTransparent(material) && !this.secondPass(object)) return;
    this.r.renderObject(object, scene, camera, geometry, material, group, lightsNode, clippingContext, passId);
  };

  draw(render: (scene: THREE.Object3D, camera: THREE.Camera) => void, scene: THREE.Object3D, camera: THREE.Camera, target: THREE.RenderTarget): void {
    const r = this.r;
    const s = scene as THREE.Scene;
    const saved = { autoClear: r.autoClear, fn: r.getRenderObjectFunction(), background: s.background };
    this.camera = camera;
    try {
      this.drawing = 1;
      r.setRenderObjectFunction(this.first);
      render(scene, camera);
      this.drawing = 0;
      if (target.depthTexture !== null) this.pyramid.build({ depth: target.depthTexture, width: target.width, height: target.height, samples: target.samples });
      this.drawing = 2;
      // No clear: three clears without autoClear only for a colour background, so it is lifted for this render.
      // (The flags `autoClearColor` / `Depth` stay: a shadow map drawn inside this render sets autoClear for its
      // own target and must clear it. For the same reason nothing here uses the renderer's opaque / transparent
      // switches: a nested shadow render keeps them and would leave transparent casters out.)
      r.autoClear = false;
      if ((s.background as THREE.Color | null)?.isColor === true) s.background = null;
      r.setRenderObjectFunction(this.second);
      // The second render finds its few draws among every object of the scene: the first pass's are hidden while
      // three walks the scene, and shown again at its first draw (before anything it draws can render a shadow
      // map, which must see every caster).
      for (const o of this.registry.values()) {
        if (o.role !== 'none' && o.object.visible) {
          o.object.visible = false;
          this.lifted.push(o.object);
        }
      }
      render(scene, camera);
      this.frames += 1;
    } finally {
      this.showLifted();
      this.drawing = 0;
      this.camera = null;
      r.autoClear = saved.autoClear;
      s.background = saved.background;
      r.setRenderObjectFunction(saved.fn);
    }
  }

  private showLifted(): void {
    for (const o of this.lifted) o.visible = true;
    this.lifted.length = 0;
  }

  view(): { readonly key: string; node(camera: { near: N; far: N }): N } | null {
    const level = this.shown;
    if (level === null) return null;
    const pyramid = this.pyramid;
    const logarithmic = (this.r as unknown as { logarithmicDepthBuffer?: boolean }).logarithmicDepthBuffer === true;
    // The node reads the buffer it was built with: a new buffer (a larger size) or a first one rebuilds it.
    return { key: `pyramid:${level}:${pyramid.generation}:${pyramid.layout() === null ? 0 : 1}`, node: (camera) => pyramid.viewNode(level, camera, logarithmic) };
  }

  dispose(): void {
    this.pyramid.dispose();
  }
}
