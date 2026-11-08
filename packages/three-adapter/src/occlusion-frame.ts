/**
 * A page's frame drawn with occlusion culling, without the adapter (the voxel
 * world page, which draws its scene with the renderer itself): the same culler
 * Play runs (occlusion.ts), on a path the page pins, through a scene pass
 * whose render the depth pyramid path draws in two passes. `off` draws
 * through the same scene pass in one, so the two compare at the pass's cost.
 *
 * The page's draws are culled as Play's are: instanced copies the GPU may
 * cull (a voxel world's kit pieces) against the pyramid on WebGPU; WebGL 2
 * has no pyramid path, and draws every copy its CPU culling keeps.
 */
import * as THREE from 'three';
import type { WebGPURenderer } from 'three/webgpu';
import type { OcclusionPath } from '@thirdlight/runtime';

import { buildPostPipeline, type PostPipeline } from './environment-nodes';
import { OcclusionCuller, type OcclusionDiagnostics } from './occlusion';

export interface OcclusionFrame {
  /** Culls and draws one frame of `scene` from `camera`. */
  render(): void;
  /** The path frames cull on now. */
  path(): OcclusionPath;
  diagnostics(): OcclusionDiagnostics;
  /** The canvas size in CSS pixels. */
  setSize(width: number, height: number, pixelRatio: number): void;
  dispose(): void;
}

export interface OcclusionFrameOptions {
  readonly renderer: WebGPURenderer;
  readonly backend: 'webgpu' | 'webgl2';
  readonly scene: THREE.Scene;
  readonly camera: THREE.Camera;
  /** The path to cull on (`hiz` falls back to `off` where the renderer has none). */
  readonly path: OcclusionPath;
}

export function createOcclusionFrame(o: OcclusionFrameOptions): OcclusionFrame {
  const { renderer, scene, camera } = o;
  const culler = new OcclusionCuller({
    scene,
    setting: () => 'on',
    renderer: () => o.backend,
    pinned: o.path,
    view: { is: (c: THREE.Camera) => c === camera, camera },
    gpu: () => (o.backend === 'webgpu' ? renderer : null),
  });
  let pipeline: PostPipeline | null = null;
  let twoPass: boolean | null = null;
  const size = { width: 1, height: 1, pixelRatio: 1 };
  const build = (): PostPipeline => {
    const passes = culler.scenePasses();
    if (pipeline !== null && twoPass === (passes !== null)) return pipeline;
    pipeline?.dispose();
    twoPass = passes !== null;
    pipeline = buildPostPipeline(renderer, scene, camera, { ao: null, fogVolumes: false, dof: null, bloom: null, grading: null, aa: 'none', displayBackground: null, samples: 0, upscale: null, scenePasses: passes });
    pipeline.setSize(size.width, size.height, size.pixelRatio);
    return pipeline;
  };
  return {
    render() {
      culler.update();
      const p = build();
      p.update(camera, []);
      p.render();
    },
    path: () => culler.path(),
    diagnostics: () => culler.diagnostics(),
    setSize(width, height, pixelRatio) {
      Object.assign(size, { width, height, pixelRatio });
      pipeline?.setSize(width, height, pixelRatio);
    },
    dispose() {
      pipeline?.dispose();
      pipeline = null;
      culler.dispose();
    },
  };
}
