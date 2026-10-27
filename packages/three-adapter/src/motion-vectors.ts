/**
 * Motion vectors: where each pixel's surface was on the last frame's screen,
 * written by the scene pass beside its colour (an MRT `velocity` target) for
 * the temporal upscale (`post-taau.ts`).
 *
 * three works out a draw's motion from its model matrix and the camera's
 * last frame, and follows skinned, morphed, instanced and batched meshes'
 * previous vertex places itself (`positionPrevious`, whenever the target
 * holds `velocity`). What it does not know is a material's own vertex stage
 * (`positionNode`): its previous place is the geometry's vertex, so a terrain
 * page, a billboard or a bent plant would report the whole displacement as
 * motion. The vertex stage is given its previous place here:
 *
 * - by default the displacement is taken as steady: last frame's vertex is
 *   this frame's moved by the same offset (a terrain page, an impostor, a
 *   mesh decal's push);
 * - a material whose displacement moves by itself (the wind) says so with
 *   {@link OWN_PREVIOUS_POSITION_KEY} and assigns `positionPrevious` in its
 *   own vertex stage (the offset at the last frame's clock).
 *
 * A blended draw (glass, particles, decals) writes no motion of its own: it
 * outputs the one value its blend leaves the target unchanged with, so the
 * surface behind it keeps its motion (Unreal's default for translucency). A
 * moving transparent thing therefore smears a little in the history; the
 * upscale's neighbourhood clamp keeps that short.
 */
import * as THREE from 'three/webgpu';
import * as TSLTyped from 'three/tsl';

import type { N } from './effects-tsl';

const TSL: N = TSLTyped;
const { positionLocal, positionPrevious, renderGroup, subBuild, uniform, vec4 } = TSL;

/**
 * `material.userData[OWN_PREVIOUS_POSITION_KEY] = true`: the material's
 * `positionNode` assigns `positionPrevious` itself (when the build needs
 * previous data), so the steady-offset default is not applied.
 */
export const OWN_PREVIOUS_POSITION_KEY = '__tlOwnPreviousPosition';

/** The name of the scene pass's motion target (three's velocity MRT name: its skinning and instancing look for it). */
export const MOTION_TARGET = 'velocity';

/** Seconds between the last two frames drawn with motion vectors (one write a frame): what a moving particle's last place is worked out with. */
export const motionFrameSeconds: N = uniform(1 / 60).setGroup(renderGroup);

/** Whether a build draws into a target holding motion vectors (three's own test: its MRT has `velocity`). */
export function needsPreviousPlace(builder: unknown): boolean {
  return (builder as { needsPreviousData?: () => boolean }).needsPreviousData?.() === true;
}

/** Whether a material's colour is blended over the target (three's WebGPU pipeline rule). */
export function blendsOver(m: Pick<THREE.Material, 'blending' | 'transparent'>): boolean {
  return m.blending !== THREE.NoBlending && (m.blending !== THREE.NormalBlending || m.transparent);
}

/**
 * The value a blended draw writes into the motion target so its blend leaves
 * the target as it was: 0 for every blend three makes (normal, additive,
 * subtractive and multiply weigh the source by its alpha or add it), 1 for a
 * custom blend that multiplies the target by the source colour (a stain).
 */
export function keepValueOf(m: Pick<THREE.Material, 'blending' | 'blendDst'>): 0 | 1 {
  return m.blending === THREE.CustomBlending && m.blendDst === THREE.SrcColorFactor ? 1 : 0;
}

/** The motion target's value for the material being built: its motion (NDC, this frame minus last; alpha 1), or the value its blend keeps the target with. */
class MotionVectorNode extends (THREE.Node as unknown as new (type?: string) => { [k: string]: unknown }) {
  static get type(): string {
    return 'MotionVectorNode';
  }

  constructor() {
    super('vec4');
  }

  setup(builder: N): N {
    const m = builder.material as THREE.Material | null;
    if (m !== null && blendsOver(m)) return vec4(keepValueOf(m));
    return vec4(TSL.velocity, 0, 1);
  }
}

/** The scene pass's MRT entry for motion vectors. */
export function motionVectorOutput(): N {
  return TSL.nodeObject(new MotionVectorNode());
}

let installed = false;

/**
 * Teach every node material's vertex stage its previous place under its own
 * `positionNode` (idempotent). Only builds whose target holds motion vectors
 * change; every other build is three's own.
 */
export function installMotionVectors(): void {
  if (installed) return;
  installed = true;
  const proto = THREE.NodeMaterial.prototype as unknown as { setupPosition(builder: unknown): unknown };
  const base = proto.setupPosition;
  proto.setupPosition = function setupPositionWithMotion(this: { positionNode: N; userData: Record<string, unknown> }, builder: unknown): unknown {
    const own = this.positionNode;
    if (own === null || own === undefined || !needsPreviousPlace(builder)) return base.call(this, builder);
    // Three's setup (skinning, morphs, instancing and their previous places) without the material's own stage, which
    // follows here with the vertex before it kept.
    this.positionNode = null;
    try {
      base.call(this, builder);
    } finally {
      this.positionNode = own;
    }
    const before = positionLocal.toVar();
    positionLocal.assign(subBuild(own, 'POSITION', 'vec3'));
    if (this.userData[OWN_PREVIOUS_POSITION_KEY] !== true) positionPrevious.assign(positionPrevious.add(positionLocal.sub(before)));
    return positionLocal;
  };
}
