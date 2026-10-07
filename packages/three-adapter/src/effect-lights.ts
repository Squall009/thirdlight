/**
 * The effect light pool as one light: a fixed array of point-light slots
 * shaded in a loop bounded by the number in use.
 *
 * Every three.js light in the scene is unrolled into every lit material's
 * shader and keys its program. A pool of `EFFECT_LIGHT_LIMIT` dark point
 * lights in the scene would keep the light count fixed (no recompile when an
 * effect light turns on) at the price of shading all of them in every lit
 * pixel, dark or not (measured: +4.3 ms GPU on the village class).
 * Here the pool is a single `EffectLights` object with its own light node:
 * the shader is built once for the whole pool (its arrays sized to the
 * limit), and the loop runs only over the slots in use, so a dark slot
 * costs nothing and turning one on builds nothing. Built after three's
 * `PointLightDataNode` (examples/jsm/tsl/lighting/data).
 *
 * Light layers and importance (as scene point lights have them) are per slot:
 * - a slot carries its layer mask; a pool whose game has an effect light with
 *   a narrower mask (`layered`) tests it against the drawn object's layers
 *   (a per-object uniform, as layered scene lights do) — a game whose effect
 *   lights light every layer builds no test;
 * - slots are kept in importance order — forced per pixel, auto, forced per
 *   vertex — so each build shades a contiguous range per pixel and another
 *   per vertex (local-lights.ts decides which, from the build's mode): a
 *   per-pixel build shades [0, autoEnd) per pixel and the rest per vertex, a
 *   per-vertex build [0, pixelEnd) per pixel and the rest per vertex. A pool
 *   whose game forces no slot to per vertex builds no vertex loop into
 *   per-pixel builds (`forcedVertex`), and likewise for per-pixel slots in
 *   per-vertex builds (`forcedPixel`).
 */
import * as THREE from 'three/webgpu';
import * as TSLTyped from 'three/tsl';

import { EFFECT_LIGHT_LIMIT } from '@thirdlight/effects';
import { LIGHT_LAYERS_ALL, type LightImportance } from '@thirdlight/runtime';

import type { N } from './effects-tsl';
import { objectLightLayers } from './light-layers';

/** TSL untyped: three's typings lag the node API used here. */
const TSL: N = TSLTyped;
const { Loop, NodeUpdateType, abs, float, getDistanceAttenuation, int, max, positionView, renderGroup, select, uniform, uniformArray, vec3 } = TSL;

/** One slot of the pool: a point light by value (world position, linear colour). */
export class EffectLightSlot {
  readonly position = new THREE.Vector3();
  readonly color = new THREE.Color(1, 1, 1);
  intensity = 0;
  /** Cut-off distance (three's `PointLight.distance`). */
  distance = 2;
  decay = 2;
  /** The light layers it lights (bit n: layer n + 1). */
  mask = LIGHT_LAYERS_ALL;
  importance: LightImportance = 'auto';
}

/** Where a build's per-pixel loop over the pool ends: the forced per-pixel slots, those and auto, or every slot. */
export type EffectLightsEnd = 'pixel' | 'auto' | 'all';
/** Where a build's per-vertex loop starts (it runs to the last slot in use). */
export type EffectLightsStart = 'pixel' | 'auto';

/** What a pool's shaders must be able to do (decided from the game's effects before the first frame; part of the lit programs' key). */
export interface EffectLightsAbilities {
  /** Some effect light lights fewer than every layer: the shaders test each slot's mask. */
  layered: boolean;
  /** Some effect light is forced per pixel / per vertex. */
  forcedPixel: boolean;
  forcedVertex: boolean;
}

/** The pool's lights in the scene: `count` slots in use, in order. */
export class EffectLights extends THREE.Light {
  readonly isEffectLights = true;
  readonly slots: readonly EffectLightSlot[];
  /** Slots in use (the first `count`); the rest are not shaded. */
  count = 0;
  /** The end of the forced per-pixel slots and of the auto ones (slots are in importance order). */
  pixelEnd = 0;
  autoEnd = 0;
  readonly abilities: EffectLightsAbilities = { layered: false, forcedPixel: false, forcedVertex: false };
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
  private readonly pixelEndNode: N;
  private readonly autoEndNode: N;
  private readonly objectLayersNode: N;

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
    this.pixelEndNode = uniform(0, 'int').setGroup(renderGroup);
    this.autoEndNode = uniform(0, 'int').setGroup(renderGroup);
    this.objectLayersNode = objectLayersUniform();
    this.updateType = NodeUpdateType.RENDER;
  }

  update({ camera }: { camera: THREE.Camera }): void {
    const slots = this.light.slots;
    const count = Math.min(this.light.count, slots.length);
    this.countNode.value = count;
    this.pixelEndNode.value = Math.min(this.light.pixelEnd, count);
    this.autoEndNode.value = Math.min(this.light.autoEnd, count);
    for (let i = 0; i < count; i++) {
      const s = slots[i]!;
      this.colors[i]!.copy(s.color).multiplyScalar(s.intensity);
      _view.copy(s.position).applyMatrix4(camera.matrixWorldInverse);
      this.positions[i]!.set(_view.x, _view.y, _view.z, s.distance);
      this.decays[i]!.set(s.decay, s.mask, 0, 0);
    }
  }

  setup(builder: N): void {
    const surface = builder.context.positionView ?? positionView;
    const { lightingModel, reflectedLight } = builder.context;
    const diffuse = vec3(0).toVar('effectLightsDiffuse');
    const specular = vec3(0).toVar('effectLightsSpecular');
    const to = pixelEnds.get(builder) ?? 'all';
    const end = to === 'pixel' ? this.pixelEndNode : to === 'auto' ? this.autoEndNode : this.countNode;
    const layered = this.light.abilities.layered;
    Loop({ start: int(0), end, type: 'int', condition: '<' }, ({ i }: { i: N }) => {
      const p = this.positionsNode.element(i);
      const d = this.decaysNode.element(i);
      const toLight = p.xyz.sub(surface).toVar();
      let attenuation = getDistanceAttenuation({ lightDistance: toLight.length(), cutoffDistance: p.w, decayExponent: d.x });
      if (layered) attenuation = attenuation.mul(layerTest(d.y, this.objectLayersNode));
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

/** The drawn object's light layers, written per object (light-layers.ts). */
function objectLayersUniform(): N {
  return uniform(LIGHT_LAYERS_ALL).onObjectUpdate(({ object }: { object: THREE.Object3D }) => objectLightLayers(object));
}

/** 1 where a slot's mask shares a layer with the object's, else 0 (masks are small integers held exactly in floats). */
function layerTest(slotMask: N, objectLayers: N): N {
  return select(int(slotMask).bitAnd(int(objectLayers)).notEqual(int(0)), float(1), float(0));
}

/** Per build: where its per-pixel loop over the pool ends (set by local-lights.ts before the pool's node builds; absent: every slot). */
const pixelEnds = new WeakMap<object, EffectLightsEnd>();

/** Tell the pool's light node where a build's per-pixel loop ends (the rest of the pool is shaded per vertex in that build). */
export function setEffectLightsPixelEnd(builder: object, end: EffectLightsEnd): void {
  pixelEnds.set(builder, end);
}

/** The pool's values for vertex stages: arrays of their own, filled from the slots every render. */
interface VertexPool {
  readonly colors: N;
  readonly positions: N;
  readonly decays: N;
  readonly count: N;
  readonly pixelEnd: N;
  readonly autoEnd: N;
  readonly objectLayers: N;
}
const vertexPools = new WeakMap<EffectLights, VertexPool>();

function vertexPoolOf(light: EffectLights): VertexPool {
  const seen = vertexPools.get(light);
  if (seen !== undefined) return seen;
  const colors = light.slots.map(() => new THREE.Color());
  const positions = light.slots.map(() => new THREE.Vector4());
  const decays = light.slots.map(() => new THREE.Vector4());
  const pool: VertexPool = {
    colors: uniformArray(colors, 'color').setGroup(renderGroup),
    positions: uniformArray(positions, 'vec4').setGroup(renderGroup),
    decays: uniformArray(decays, 'vec4').setGroup(renderGroup),
    // Written first each render (the arrays beside it are filled here, before the group uploads).
    count: uniform(0, 'int')
      .setGroup(renderGroup)
      .onRenderUpdate(({ camera }: { camera: THREE.Camera }) => {
        const count = Math.min(light.count, light.slots.length);
        for (let i = 0; i < count; i++) {
          const sl = light.slots[i]!;
          colors[i]!.copy(sl.color).multiplyScalar(sl.intensity);
          _view.copy(sl.position).applyMatrix4(camera.matrixWorldInverse);
          positions[i]!.set(_view.x, _view.y, _view.z, sl.distance);
          decays[i]!.set(sl.decay, sl.mask, 0, 0);
        }
        return count;
      }),
    pixelEnd: uniform(0, 'int').setGroup(renderGroup).onRenderUpdate(() => Math.min(light.pixelEnd, light.count, light.slots.length)),
    autoEnd: uniform(0, 'int').setGroup(renderGroup).onRenderUpdate(() => Math.min(light.autoEnd, light.count, light.slots.length)),
    objectLayers: objectLayersUniform(),
  };
  vertexPools.set(light, pool);
  return pool;
}

/**
 * The pool's diffuse irradiance at a vertex (view space), for an object
 * shading local lights per vertex (local-lights.ts; built in the vertex
 * stage's flow, so it may loop): a loop over the slots in use from `from`
 * (after the forced per-pixel slots, or after the auto ones too).
 */
export function effectLightsVertexIrradiance(light: EffectLights, normal: N, position: N, twoSided: boolean, from: EffectLightsStart): N {
  const v = vertexPoolOf(light);
  const total = vec3(0).toVar('effectLightsVertex');
  const layered = light.abilities.layered;
  Loop({ start: from === 'pixel' ? v.pixelEnd : v.autoEnd, end: v.count, type: 'int', condition: '<' }, ({ i }: { i: N }) => {
    const p = v.positions.element(i);
    const d = v.decays.element(i);
    const toLight = p.xyz.sub(position).toVar();
    const distance = toLight.length().toVar();
    let attenuation = getDistanceAttenuation({ lightDistance: distance, cutoffDistance: p.w, decayExponent: d.x });
    if (layered) attenuation = attenuation.mul(layerTest(d.y, v.objectLayers));
    const nl = normal.dot(toLight.div(max(distance, 1e-4)));
    total.addAssign(v.colors.element(i).mul(attenuation).mul(twoSided ? abs(nl) : max(nl, 0)));
  });
  return total;
}

/** Teach a renderer to shade `EffectLights` (three finds a light's node class by its constructor). */
export function registerEffectLights(renderer: { library: { addLight(node: unknown, light: unknown): void } }): void {
  renderer.library.addLight(EffectLightsNode, EffectLights);
}
