/**
 * The effect light pool as one light: a fixed array of point-light slots
 * shaded in a loop bounded by the number in use.
 *
 * Every three.js light in the scene is unrolled into every lit material's
 * shader and keys its program, so the pool used to sit in the scene as
 * `EFFECT_LIGHT_LIMIT` dark point lights: a fixed light count (no recompile
 * when an effect light turns on) at the price of shading all of them in
 * every lit pixel, dark or not (measured: +4.3 ms GPU on the village class).
 * Here the pool is a single `EffectLights` object with its own light node:
 * the shader is built once for the whole pool (its arrays sized to the
 * limit), and the loop runs only over the slots in use, so a dark slot
 * costs nothing and turning one on builds nothing. Built after three's
 * `PointLightDataNode` (examples/jsm/tsl/lighting/data).
 */
import * as THREE from 'three/webgpu';
import * as TSLTyped from 'three/tsl';

import { EFFECT_LIGHT_LIMIT } from '@thirdlight/effects';

import type { N } from './effects-tsl';

/** TSL untyped: three's typings lag the node API used here. */
const TSL: N = TSLTyped;
const { Loop, NodeUpdateType, getDistanceAttenuation, positionView, renderGroup, uniform, uniformArray, vec3 } = TSL;

/** One slot of the pool: a point light by value (world position, linear colour). */
export class EffectLightSlot {
  readonly position = new THREE.Vector3();
  readonly color = new THREE.Color(1, 1, 1);
  intensity = 0;
  /** Cut-off distance (three's `PointLight.distance`). */
  distance = 2;
  decay = 2;
}

/** The pool's lights in the scene: `count` slots in use, in order. */
export class EffectLights extends THREE.Light {
  readonly isEffectLights = true;
  readonly slots: readonly EffectLightSlot[];
  /** Slots in use (the first `count`); the rest are not shaded. */
  count = 0;
  constructor(size: number = EFFECT_LIGHT_LIMIT) {
    super(0xffffff, 1);
    this.name = 'effect lights';
    this.slots = Array.from({ length: size }, () => new EffectLightSlot());
    // Slots hold world positions: the object itself never moves.
    this.matrixAutoUpdate = false;
    this.matrixWorldAutoUpdate = false;
  }
}

const _view = new THREE.Vector3();

/** The light node of `EffectLights`: uniform arrays the size of the pool, a loop over the slots in use. */
class EffectLightsNode extends (THREE.Node as unknown as new () => { updateType: string; [k: string]: unknown }) {
  static get type(): string {
    return 'EffectLightsNode';
  }
  private readonly colors: THREE.Color[] = [];
  private readonly positions: THREE.Vector4[] = [];
  private readonly decays: THREE.Vector4[] = [];
  private readonly colorsNode: N;
  private readonly positionsNode: N;
  private readonly decaysNode: N;
  private readonly countNode: N;

  constructor(readonly light: EffectLights) {
    super();
    for (let i = 0; i < light.slots.length; i++) {
      this.colors.push(new THREE.Color());
      this.positions.push(new THREE.Vector4());
      this.decays.push(new THREE.Vector4());
    }
    this.colorsNode = uniformArray(this.colors, 'color').setGroup(renderGroup);
    this.positionsNode = uniformArray(this.positions, 'vec4').setGroup(renderGroup);
    this.decaysNode = uniformArray(this.decays, 'vec4').setGroup(renderGroup);
    this.countNode = uniform(0, 'int').setGroup(renderGroup);
    this.updateType = NodeUpdateType.RENDER;
  }

  update({ camera }: { camera: THREE.Camera }): void {
    const slots = this.light.slots;
    const count = Math.min(this.light.count, slots.length);
    this.countNode.value = count;
    for (let i = 0; i < count; i++) {
      const s = slots[i]!;
      this.colors[i]!.copy(s.color).multiplyScalar(s.intensity);
      _view.copy(s.position).applyMatrix4(camera.matrixWorldInverse);
      this.positions[i]!.set(_view.x, _view.y, _view.z, s.distance);
      this.decays[i]!.x = s.decay;
    }
  }

  setup(builder: N): void {
    const surface = builder.context.positionView ?? positionView;
    const { lightingModel, reflectedLight } = builder.context;
    const diffuse = vec3(0).toVar('effectLightsDiffuse');
    const specular = vec3(0).toVar('effectLightsSpecular');
    Loop(this.countNode, ({ i }: { i: N }) => {
      const p = this.positionsNode.element(i);
      const toLight = p.xyz.sub(surface).toVar();
      const attenuation = getDistanceAttenuation({ lightDistance: toLight.length(), cutoffDistance: p.w, decayExponent: this.decaysNode.element(i).x });
      lightingModel.direct(
        {
          lightDirection: toLight.normalize().toVar(),
          lightColor: this.colorsNode.element(i).mul(attenuation).toVar(),
          lightNode: { light: {}, shadowNode: null },
          reflectedLight: { directDiffuse: diffuse, directSpecular: specular },
        },
        builder,
      );
    });
    reflectedLight.directDiffuse.addAssign(diffuse);
    reflectedLight.directSpecular.addAssign(specular);
  }
}

/** Teach a renderer to shade `EffectLights` (three finds a light's node class by its constructor). */
export function registerEffectLights(renderer: { library: { addLight(node: unknown, light: unknown): void } }): void {
  renderer.library.addLight(EffectLightsNode, EffectLights);
}
