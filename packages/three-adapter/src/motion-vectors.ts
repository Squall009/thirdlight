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
 * The motion itself is this module's ({@link objectMotion}), not three's
 * `velocity` node: three's multiplies the model, view and projection
 * matrices together for every pixel, now and for the last frame (the village
 * class's scene pass took 1.3 ms longer at 1080p on the Iris Xe). Here the
 * camera's matrices are render-group uniforms set once a frame (unjittered:
 * the temporal upscale's sub-pixel jitter is not motion), each object keeps
 * its last world matrix, and both clip positions are worked out per vertex
 * from the vertex stage's final places.
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
const { modelWorldMatrix, positionLocal, positionPrevious, renderGroup, subBuild, uniform, varying, vec4 } = TSL;

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

/** The camera's view-projection this frame and the last (unjittered; set once a frame by {@link setMotionCamera}). */
const viewProjection: N = uniform(new THREE.Matrix4()).setGroup(renderGroup);
const lastViewProjection: N = uniform(new THREE.Matrix4()).setGroup(renderGroup);
let cameraSeen = false;

/** Before a frame drawn with motion vectors: the camera's unjittered projection and view (the last frame's kept). */
export function setMotionCamera(projection: THREE.Matrix4, viewInverse: THREE.Matrix4): void {
  const now = viewProjection.value as THREE.Matrix4;
  (lastViewProjection.value as THREE.Matrix4).copy(cameraSeen ? now : now.multiplyMatrices(projection, viewInverse));
  now.multiplyMatrices(projection, viewInverse);
  cameraSeen = true;
}

/** Each drawn object's world matrix as it was drawn on the last frame. */
const lastWorld = new WeakMap<THREE.Object3D, THREE.Matrix4>();

/**
 * A draw's motion on screen (NDC, this frame's place minus the last's): the
 * vertex now and as it was (its object's last matrix, its own last place),
 * each through its frame's view-projection, per vertex.
 */
class ObjectMotionNode extends (THREE.TempNode as unknown as new (type: string) => { [k: string]: unknown; updateType: string }) {
  static get type(): string {
    return 'ObjectMotionNode';
  }

  /** The drawn object's last world matrix (the object's own uniform). */
  readonly lastModel: N = uniform(new THREE.Matrix4());

  constructor() {
    super('vec2');
    this.updateType = TSL.NodeUpdateType.OBJECT;
  }

  update({ object }: { object: THREE.Object3D }): void {
    let last = lastWorld.get(object);
    if (last === undefined) {
      last = object.matrixWorld.clone();
      lastWorld.set(object, last);
    }
    (this.lastModel.value as THREE.Matrix4).copy(last);
    last.copy(object.matrixWorld);
  }

  setup(): N {
    const now = varying(viewProjection.mul(modelWorldMatrix.mul(vec4(positionLocal, 1))));
    const was = varying(lastViewProjection.mul(this.lastModel.mul(vec4(positionPrevious, 1))));
    return now.xy.div(now.w).sub(was.xy.div(was.w));
  }
}

/** The motion of the draw being built. */
export const objectMotion: N = TSL.nodeObject(new ObjectMotionNode());

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
    return vec4(objectMotion, 0, 1);
  }
}

/** The scene pass's MRT entry for motion vectors. */
export function motionVectorOutput(): N {
  return TSL.nodeObject(new MotionVectorNode());
}

let installed = false;

/** The draws whose last refresh was full: they get one more (see {@link motionRefresh}). */
const refreshedFull = new WeakSet<object>();

/**
 * A draw's refresh under a target holding motion vectors. three refreshes
 * every draw fully on every frame there (`NodeMaterialObserver.needsVelocity`):
 * all its object-group uniforms, bindings and attributes, which cost the
 * village's main thread ~1.7 ms a frame for draws that never move. What a full
 * refresh does for motion is roll the last frame's data over (the object's last
 * matrix here, three's previous instance and batch matrices after the draw), and
 * that data is only out of date for the one frame after it last changed. So a
 * draw gets three's refresh as if no motion were drawn (full when its object,
 * instances, geometry or material changed), plus one more full refresh on the
 * frame after a full one: then the last frame's data equals this frame's again
 * and stays so until the next change.
 */
export function motionRefresh(drawn: object, ownRefresh: number, full: number): number {
  if (ownRefresh === full) {
    refreshedFull.add(drawn);
    return full;
  }
  if (refreshedFull.delete(drawn)) return full;
  return ownRefresh;
}

/** While set, three's observer is asked for a draw's refresh as if no motion were drawn. */
let askingOwnRefresh = false;

function installMotionRefresh(): void {
  type Observer = { needsRefresh(renderObject: object, frame: { renderer: unknown }): number; needsVelocity(renderer: unknown): boolean };
  const proto = (THREE as unknown as { NodeMaterialObserver: { prototype: Observer } }).NodeMaterialObserver.prototype;
  const baseRefresh = proto.needsRefresh;
  const baseVelocity = proto.needsVelocity;
  const full = (THREE as unknown as { RenderObjectRefreshType: { FULL: number } }).RenderObjectRefreshType.FULL;
  proto.needsVelocity = function needsVelocityOnChange(this: Observer, renderer: unknown): boolean {
    return askingOwnRefresh ? false : baseVelocity.call(this, renderer);
  };
  proto.needsRefresh = function needsRefreshWithMotion(this: Observer, renderObject: object, frame: { renderer: unknown }): number {
    if (!baseVelocity.call(this, frame.renderer)) return baseRefresh.call(this, renderObject, frame);
    askingOwnRefresh = true;
    let own: number;
    try {
      own = baseRefresh.call(this, renderObject, frame);
    } finally {
      askingOwnRefresh = false;
    }
    return motionRefresh(renderObject, own, full);
  };
}

/**
 * Teach every node material's vertex stage its previous place under its own
 * `positionNode` (idempotent). Only builds whose target holds motion vectors
 * change; every other build is three's own.
 */
export function installMotionVectors(): void {
  if (installed) return;
  installed = true;
  installMotionRefresh();
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
