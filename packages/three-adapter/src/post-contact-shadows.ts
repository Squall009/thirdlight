/**
 * Screen-space contact shadows: the sun's shadow detail its map is too
 * coarse for (where a small thing meets the ground, a crease, a blade).
 *
 * After the scene pass, each pixel marches a short way toward the sun
 * through the frame's depth (`CONTACT_SHADOW_STEPS` steps over
 * `CONTACT_SHADOW_METRES`, jittered per pixel), at
 * `CONTACT_SHADOW_RESOLUTION_SCALE` of the render scale; a step
 * that falls behind the depth there, by less than
 * `CONTACT_SHADOW_THICKNESS_METRES` (thicker would be a surface in front,
 * not an occluder), puts the pixel in shadow. It fades out with distance
 * (`CONTACT_SHADOW_FADE_METRES`), where the map's own texels are as fine.
 *
 * How it reaches the sun's light: as a screen history (`screen-history.ts`)
 * in a `ContactShadowsLight` of the scene, which the key light's shadow node
 * (`withContactShadows`) multiplies in where a build's lights hold it: only
 * the sun's direct light darkens, never a lamp's or the sky's. They are
 * drawn with the look's post effects (any effect or anti-aliasing): a frame
 * through the stack for another reason (a render scale, occlusion culling's
 * two passes, no MSAA) looks as one drawn straight to the canvas. With the
 * light out of the scene (the level's setting off, no post effect) no pixel
 * samples it.
 *
 * Everything in the depth buffer casts, an object whose own shadow is off
 * included (the depth holds no caster flags): a contact shadow is short, and
 * the alternative, a caster mask target, costs every draw a write.
 */
import * as THREE from 'three/webgpu';
import * as TSLTyped from 'three/tsl';

import type { N } from './effects-tsl';
import { buildScreenHistory, scenePassViewZ, ScreenHistoryLight, screenHistoryAt, takesScreenHistory, type ScreenHistoryStage } from './screen-history';

const TSL: N = TSLTyped;
const { float, Fn, getViewPosition, interleavedGradientNoise, max, mix, perspectiveDepthToViewZ, screenCoordinate, smoothstep, uniform, uv, vec2, vec4 } = TSL;

/**
 * The march's resolution relative to the scene pass: at the render scale it
 * cost the Iris Xe ~0.8 ms a 1080p frame at full clock (its depth reads),
 * at half a quarter of that; a pixel takes its half-resolution texel's
 * value where the depths agree (the history's test), so an edge loses at
 * most a pixel of it.
 */
export const CONTACT_SHADOW_RESOLUTION_SCALE = 0.5;
/** How far toward the sun a pixel looks for an occluder (m). */
export const CONTACT_SHADOW_METRES = 0.3;
/** Steps of that march (fixed: no loop whose end depends on data). */
export const CONTACT_SHADOW_STEPS = 6;
/** How far behind the depth a step may be and still count as shadowed (m): deeper, the depth is a surface in front, not an occluder. */
export const CONTACT_SHADOW_THICKNESS_METRES = 0.2;
/** The view distance (m) over which contact shadows fade out: from the first, gone by the second. */
export const CONTACT_SHADOW_FADE_METRES: readonly [number, number] = [25, 40];
/** How far in front of a step the depth must be (a share of its distance, plus a centimetre) to shadow it: a slanted surface's own pixels never do. */
const CONTACT_SHADOW_BIAS = 0.004;
const CONTACT_SHADOW_BIAS_M = 0.01;

/** The contact shadows as a light of the scene (only the key light's shadow reads it). */
export class ContactShadowsLight extends ScreenHistoryLight {
  readonly isContactShadows = true;

  constructor() {
    super('contact shadows');
  }
}

/** Its light node draws nothing: the key light's shadow reads the history. */
class ContactShadowsNode extends (THREE.LightingNode as unknown as new () => { [k: string]: unknown }) {
  static get type(): string {
    return 'ContactShadowsNode';
  }

  constructor(readonly light: ContactShadowsLight) {
    super();
  }

  setup(): void {}
}

/** Teach a renderer the contact-shadows light. */
export function registerContactShadows(renderer: { library: { addLight(node: unknown, light: unknown): void } }): void {
  renderer.library.addLight(ContactShadowsNode, ContactShadowsLight);
}

/** The contact-shadows light among a build's lights (null: none). */
function contactShadowsOf(builder: N): ContactShadowsLight | null {
  const lights = (builder.lightsNode?.getLights?.() ?? []) as THREE.Light[];
  for (const l of lights) if ((l as Partial<ContactShadowsLight>).isContactShadows === true) return l as ContactShadowsLight;
  return null;
}

/** A shadow node times the contact shadows where a build's lights hold them. */
class ContactShadowedNode extends (THREE.Node as unknown as new (type?: string | null) => { [k: string]: unknown }) {
  static get type(): string {
    return 'ContactShadowedNode';
  }

  constructor(readonly inner: N) {
    super();
  }

  getNodeType(builder: N): string {
    return this.inner.getNodeType(builder);
  }

  setup(builder: N): N {
    const c = contactShadowsOf(builder);
    return c === null || !takesScreenHistory(builder) ? this.inner : this.inner.mul(screenHistoryAt(c));
  }

  dispose(): void {
    this.inner.dispose?.();
  }
}

/** The key light's shadow node `inner` with the contact shadows on top (`light.shadow.shadowNode`). */
export function withContactShadows(inner: N): N {
  return TSL.nodeObject(new ContactShadowedNode(TSL.nodeObject(inner)));
}

export interface ContactShadowsStage {
  /** The node that draws the contact shadows into the history each frame (built into the pipeline's output). */
  readonly passes: N;
  /** The scene pass's resolution scale (the march runs at it). */
  setScale(sceneScale: number): void;
  beforeFrame(camera: THREE.Camera): void;
  afterFrame(camera: THREE.Camera): void;
  dispose(): void;
}

/** The scene's key light: its first shadow-casting directional light that shows (null: none). */
function keyLightOf(scene: THREE.Object3D): THREE.DirectionalLight | null {
  for (const o of scene.children) {
    const l = o as THREE.DirectionalLight;
    if (l.isDirectionalLight === true && l.castShadow && l.visible) return l;
  }
  return null;
}

/** The contact shadows of a scene pass toward `scene`'s key light, fed to `light`. */
export function buildContactShadows(renderer: THREE.WebGPURenderer, scenePass: N, scene: THREE.Object3D, light: ContactShadowsLight): ContactShadowsStage {
  const depth: N = scenePass.getTextureNode('depth');
  const projection = uniform(new THREE.Matrix4());
  const inverse = uniform(new THREE.Matrix4());
  // Toward the sun in view space, as long as the march (0: no sun, nothing shadowed).
  const toSun = uniform(new THREE.Vector3());
  const near: N = scenePass._cameraNear;
  const far: N = scenePass._cameraFar;
  // The march in clip space: the ray's start and end projected once, each step a blend of the two (projection is
  // linear in homogeneous coordinates, so a step's view depth is the same blend of theirs), one depth read a step.
  const visible = Fn((_: unknown, builder: N) => {
    // A logarithmic depth buffer's depths are not the projection's: no contact shadows there.
    if (builder.renderer.logarithmicDepthBuffer === true) return float(1);
    const at = uv();
    const p = getViewPosition(at, depth.sample(at).x, inverse).toVar();
    const e = p.add(toSun);
    const c0 = projection.mul(vec4(p, 1)).toVar();
    const c1 = projection.mul(vec4(e, 1)).toVar();
    const jitter = interleavedGradientNoise(screenCoordinate.xy);
    const hit = float(0).toVar();
    for (let i = 0; i < CONTACT_SHADOW_STEPS; i += 1) {
      const t = float(i + 1).sub(jitter).div(CONTACT_SHADOW_STEPS);
      const c = mix(c0, c1, t);
      const ndc = c.xy.div(c.w);
      const quv = vec2(ndc.x.mul(0.5).add(0.5), ndc.y.mul(-0.5).add(0.5));
      const qz = mix(p.z, e.z, t);
      const sz = perspectiveDepthToViewZ(depth.sample(quv).x, near, far);
      // View z is negative ahead: the depth there in front of the step by more than the bias and less than the thickness.
      const ahead = sz.sub(qz);
      const inside = quv.x.greaterThanEqual(0).and(quv.x.lessThanEqual(1)).and(quv.y.greaterThanEqual(0)).and(quv.y.lessThanEqual(1));
      const shadowed = inside.and(ahead.greaterThan(qz.negate().mul(CONTACT_SHADOW_BIAS).add(CONTACT_SHADOW_BIAS_M))).and(ahead.lessThan(CONTACT_SHADOW_THICKNESS_METRES));
      hit.assign(max(hit, shadowed.select(float(1), float(0))));
    }
    const fade = float(1).sub(smoothstep(CONTACT_SHADOW_FADE_METRES[0], CONTACT_SHADOW_FADE_METRES[1], p.z.negate()));
    return float(1).sub(hit.mul(fade));
  })();
  const history: ScreenHistoryStage = buildScreenHistory(renderer, light, visible, scenePassViewZ(scenePass), CONTACT_SHADOW_RESOLUTION_SCALE);
  const dir = new THREE.Vector3();
  const target = new THREE.Vector3();
  return {
    passes: history.passes,
    setScale(sceneScale) {
      history.setShare(CONTACT_SHADOW_RESOLUTION_SCALE * sceneScale);
    },
    beforeFrame(cam) {
      projection.value.copy(cam.projectionMatrix);
      inverse.value.copy(cam.projectionMatrixInverse);
      const key = keyLightOf(scene);
      if (key === null) (toSun.value as THREE.Vector3).set(0, 0, 0);
      else {
        // Toward the light: from its target to it, turned into the camera's view.
        dir.setFromMatrixPosition(key.matrixWorld).sub(target.setFromMatrixPosition(key.target.matrixWorld)).normalize();
        (toSun.value as THREE.Vector3).copy(dir.transformDirection(cam.matrixWorldInverse).multiplyScalar(CONTACT_SHADOW_METRES));
      }
      history.beforeFrame(cam);
    },
    afterFrame(cam) {
      history.afterFrame(cam);
    },
    dispose() {
      history.dispose();
    },
  };
}
