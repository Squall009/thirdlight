/**
 * Light layers on the renderer: which lights light a drawable and whose
 * shadows it casts (project-model light-layers.ts has the data and its
 * defaults).
 *
 * A drawable carries the layers its object is in (`LIGHT_LAYERS_KEY` in its
 * `userData`; absent: every layer). A light whose masks are both every layer
 * stays a plain three.js light: it lights and shadows everything, and costs
 * exactly what it did before layers existed. A light with a narrower mask is
 * realized as a layered light (`LayeredPointLight`, …), a subclass three finds
 * its own light node for (`registerLayeredLights`):
 *
 * - its colour is multiplied by a per-object uniform, 1 when the object's
 *   layers share a bit with the light's mask and 0 otherwise. The test runs on
 *   the CPU for each drawn object, so one shader program serves every mask
 *   combination: layers add no program variants, and a mask that changes
 *   while the game runs (a script, the Inspector) builds nothing;
 * - its shadow pass draws only the casters whose layers share a bit with its
 *   shadow caster mask (a filter on three's per-object shadow render
 *   function; the key light's cached maps filter the same way,
 *   `cached-shadow.ts`).
 *
 * A light that turns from plain to layered (or back) is realized again: the
 * set of lights changes, so lit programs are rebuilt once, as when a light is
 * added. Batching, static merging and instancing keep drawables of different
 * layers apart (the layers are part of their keys), so a merged draw has one
 * mask.
 *
 * Rooms are a light layer of their own, kept apart from the eight named ones
 * (a project's names keep their meaning) and as many as there are rooms: a
 * drawable in a room carries the room's key (`ROOM_KEY`, a number; 0: the
 * outside), and so does a light in a room. A room-bound light lights only
 * drawables of its room, so a lamp without a shadow stops at its room's
 * walls; a light bound to no room (the sun, the ambient light, a level
 * without rooms) lights every room. A drawable spanning rooms (a chunk of
 * generated walls or of a block layer) carries its room per vertex instead
 * (`ROOM_ATTRIBUTE`, the room each face looks into), tested per pixel against
 * the light's room; on the CPU it counts as in every room its vertices name
 * (`ROOM_VERTEX_KEYS`). The test is exact for any number of rooms: no
 * colouring onto the eight bits, no room shares a key.
 */
import * as THREE from 'three/webgpu';
import * as TSLTyped from 'three/tsl';
import { LIGHT_LAYERS_ALL, lightLayerMaskOf } from '@thirdlight/runtime';

import type { N } from './effects-tsl';

/** TSL untyped: three's typings lag the node API used here. */
const TSL: N = TSLTyped;
const { uniform, attribute, select, If } = TSL;

/** `object.userData[LIGHT_LAYERS_KEY]`: the light layers a drawable is in (absent: every layer). */
export const LIGHT_LAYERS_KEY = '__tlLightLayers';

/**
 * `object.userData[ROOM_KEY]`: the room a drawable or a light is in (0: the
 * outside; absent: no room test — a drawable every light lights, a light
 * that lights every drawable).
 */
export const ROOM_KEY = '__tlRoom';
/** `object.userData[ROOM_VERTEX_KEYS]`: the rooms a drawable's vertices look into (its `ROOM_ATTRIBUTE`), a `ReadonlySet<number>`. */
export const ROOM_VERTEX_KEYS = '__tlRoomKeys';
/** The vertex attribute holding the room each vertex looks into (0: the outside). */
export const ROOM_ATTRIBUTE = 'tlRoom';

/** The room key a light or drawable carries (undefined: none). */
export function roomKeyOf(o: THREE.Object3D): number | undefined {
  return o.userData[ROOM_KEY] as number | undefined;
}

/** Whether a light's room lets it light `o`: no room on either, the same room, or (per vertex) one of `o`'s rooms. */
export function roomLetsLight(light: THREE.Object3D, o: THREE.Object3D): boolean {
  const l = light.userData[ROOM_KEY] as number | undefined;
  if (l === undefined) return true;
  const keys = o.userData[ROOM_VERTEX_KEYS] as ReadonlySet<number> | undefined;
  if (keys !== undefined) return keys.has(l);
  const k = o.userData[ROOM_KEY] as number | undefined;
  return k === undefined || k === l;
}

/** The light layers a drawable is in. */
export function objectLightLayers(o: THREE.Object3D): number {
  const v = o.userData[LIGHT_LAYERS_KEY] as number | undefined;
  return v === undefined ? LIGHT_LAYERS_ALL : v;
}

/**
 * Put `mask` on every mesh under `root` (every layer: the key is removed).
 * Returns whether any mesh's layers changed (its shadow and grouping must follow).
 */
export function applyObjectLightLayers(root: THREE.Object3D, mask: number): boolean {
  let changed = false;
  root.traverse((o) => {
    if ((o as THREE.Mesh).isMesh !== true) return;
    if (objectLightLayers(o) === mask) return;
    changed = true;
    if (mask === LIGHT_LAYERS_ALL) delete o.userData[LIGHT_LAYERS_KEY];
    else o.userData[LIGHT_LAYERS_KEY] = mask;
  });
  return changed;
}

/** The light layers an entity's drawables are in: its box, model, instance set or block layer `lightLayers`. */
export function lightLayersOfComponents(components: unknown): number {
  const c = components as { box?: { lightLayers?: unknown }; model?: { lightLayers?: unknown }; instances?: { lightLayers?: unknown }; blockLayer?: { lightLayers?: unknown } } | undefined;
  return lightLayerMaskOf((c?.box ?? c?.model ?? c?.instances ?? c?.blockLayer)?.lightLayers);
}

/** A light's two masks. */
export interface LightMasks {
  readonly lightMask: number;
  readonly shadowCasterMask: number;
}

/** The masks of a light component (absent fields: every layer). */
export function lightMasksOf(l: { lightMask?: unknown; shadowCasterMask?: unknown }): LightMasks {
  return { lightMask: lightLayerMaskOf(l.lightMask), shadowCasterMask: lightLayerMaskOf(l.shadowCasterMask) };
}

/** Whether masks need a layered light (a plain three.js light lights and shadows every layer). */
export function needsLayeredLight(m: LightMasks): boolean {
  return m.lightMask !== LIGHT_LAYERS_ALL || m.shadowCasterMask !== LIGHT_LAYERS_ALL;
}

/** What a layered light carries: its masks, changed in place (no rebuild). */
interface Layered {
  readonly isLayeredLight: true;
  lightMask: number;
  shadowCasterMask: number;
}

/** Whether `light` is a layered light. */
export function isLayeredLight(light: unknown): light is THREE.Light & Layered {
  return (light as Partial<Layered> | null)?.isLayeredLight === true;
}

/** Whether `o` casts `light`'s shadow (a plain light: every caster). */
export function castsShadowFor(light: THREE.Object3D, o: THREE.Object3D): boolean {
  return !isLayeredLight(light) || (objectLightLayers(o) & light.shadowCasterMask) !== 0;
}

/** Whether `light` lights `o` (a plain light: every object): its layers and its room. */
export function lightsObject(light: THREE.Object3D, o: THREE.Object3D): boolean {
  return !isLayeredLight(light) || ((objectLightLayers(o) & light.lightMask) !== 0 && roomLetsLight(light, o));
}

export class LayeredDirectionalLight extends THREE.DirectionalLight implements Layered {
  readonly isLayeredLight = true as const;
  lightMask = LIGHT_LAYERS_ALL;
  shadowCasterMask = LIGHT_LAYERS_ALL;
}
export class LayeredPointLight extends THREE.PointLight implements Layered {
  readonly isLayeredLight = true as const;
  lightMask = LIGHT_LAYERS_ALL;
  shadowCasterMask = LIGHT_LAYERS_ALL;
}
export class LayeredSpotLight extends THREE.SpotLight implements Layered {
  readonly isLayeredLight = true as const;
  lightMask = LIGHT_LAYERS_ALL;
  shadowCasterMask = LIGHT_LAYERS_ALL;
}
export class LayeredAmbientLight extends THREE.AmbientLight implements Layered {
  readonly isLayeredLight = true as const;
  lightMask = LIGHT_LAYERS_ALL;
  shadowCasterMask = LIGHT_LAYERS_ALL;
}
export class LayeredHemisphereLight extends THREE.HemisphereLight implements Layered {
  readonly isLayeredLight = true as const;
  lightMask = LIGHT_LAYERS_ALL;
  shadowCasterMask = LIGHT_LAYERS_ALL;
}

/** Set a layered light's masks (a plain light has none to set). */
export function setLightMasks(light: THREE.Light, m: LightMasks): void {
  if (!isLayeredLight(light)) return;
  light.lightMask = m.lightMask;
  light.shadowCasterMask = m.shadowCasterMask;
}

/** 1 for an object `light` lights, else 0: written per drawn object. */
function lightFactor(light: THREE.Light): N {
  return uniform(1).onObjectUpdate(({ object }: { object: THREE.Object3D }) => (lightsObject(light, object) ? 1 : 0));
}

type RenderObjectFn = (object: THREE.Object3D, ...rest: unknown[]) => void;
type ShadowNodeClass = new (light: THREE.Light, shadow?: THREE.LightShadow) => { getShadowRenderObjectFunction(renderer: unknown, shadow?: unknown): RenderObjectFn };

/** A shadow node class whose pass skips the casters outside its light's shadow caster mask. */
function casterFiltered(Base: ShadowNodeClass): ShadowNodeClass {
  return class extends Base {
    private base: RenderObjectFn | null = null;
    private filtered: RenderObjectFn | null = null;
    constructor(
      private readonly owner: THREE.Light,
      shadow?: THREE.LightShadow,
    ) {
      super(owner, shadow);
    }
    override getShadowRenderObjectFunction(renderer: unknown, shadow?: unknown): RenderObjectFn {
      const base = super.getShadowRenderObjectFunction(renderer, shadow);
      if (base !== this.base) {
        this.base = base;
        const owner = this.owner;
        this.filtered = (object, ...rest) => {
          if (castsShadowFor(owner, object)) base(object, ...rest);
        };
      }
      return this.filtered!;
    }
  };
}

const LayeredShadowNode = casterFiltered(THREE.ShadowNode as unknown as ShadowNodeClass);
const LayeredPointShadowNode = casterFiltered(THREE.PointShadowNode as unknown as ShadowNodeClass);

/** Per light: 1 where the vertex's room is the light's (or the light is bound to none), else 0. */
const roomFactors = new WeakMap<THREE.Light, N>();
function roomVertexFactor(light: THREE.Light): N {
  let f = roomFactors.get(light);
  if (f === undefined) {
    const lightRoom = uniform(-1).onRenderUpdate(() => (light.userData[ROOM_KEY] as number | undefined) ?? -1);
    const v = attribute(ROOM_ATTRIBUTE, 'float');
    f = select(lightRoom.lessThan(-0.5).or(v.sub(lightRoom).abs().lessThan(0.5)), 1, 0);
    roomFactors.set(light, f);
  }
  return f;
}

type AnalyticNodeClass = new (light: THREE.Light) => { colorNode: N; light: THREE.Light; setup(builder: unknown): void; setupShadowNode(): unknown; setupDirect(builder: unknown): { lightColor: N } | undefined };

/** A light node whose colour carries the per-object layer test and whose shadow filters its casters. */
function layeredAnalytic(Base: AnalyticNodeClass, Shadow: ShadowNodeClass): AnalyticNodeClass {
  return class extends Base {
    private readonly factor: N;
    constructor(light: THREE.Light) {
      super(light);
      // The colour uniform (written from the light each frame) times the object's test.
      this.factor = lightFactor(light);
      this.colorNode = this.colorNode.mul(this.factor);
    }
    /**
     * A drawable the light does not light (another room's, another layer's)
     * skips the light altogether: the test is one value for the whole draw, so
     * the branch costs nothing per pixel, and a room's lamps are evaluated
     * only where they can light.
     */
    override setup(builder: unknown): void {
      If(this.factor.greaterThan(0.5), () => {
        super.setup(builder);
      });
    }
    override setupShadowNode(): unknown {
      return new Shadow(this.light);
    }
    override setupDirect(builder: unknown): { lightColor: N } | undefined {
      const d = super.setupDirect(builder);
      // A drawable spanning rooms: the light reaches only the faces that look into its room.
      if (d !== undefined && (builder as { hasGeometryAttribute(name: string): boolean }).hasGeometryAttribute(ROOM_ATTRIBUTE)) d.lightColor = d.lightColor.mul(roomVertexFactor(this.light));
      return d;
    }
  };
}

const LayeredDirectionalLightNode = layeredAnalytic(THREE.DirectionalLightNode as unknown as AnalyticNodeClass, LayeredShadowNode);
const LayeredSpotLightNode = layeredAnalytic(THREE.SpotLightNode as unknown as AnalyticNodeClass, LayeredShadowNode);
const LayeredPointLightNode = layeredAnalytic(THREE.PointLightNode as unknown as AnalyticNodeClass, LayeredPointShadowNode);

const AmbientBase = THREE.AmbientLightNode as unknown as new (light: THREE.Light) => { colorNode: N };
class LayeredAmbientLightNode extends AmbientBase {
  constructor(light: THREE.Light) {
    super(light);
    this.colorNode = this.colorNode.mul(lightFactor(light));
  }
}

const HemisphereBase = THREE.HemisphereLightNode as unknown as new (light: THREE.Light) => { colorNode: N; groundColorNode: N; update(frame: unknown): void };
class LayeredHemisphereLightNode extends HemisphereBase {
  /** The ground colour uniform three's update writes (the shaded ground colour carries the test). */
  private readonly groundUniform: N;
  private readonly groundTested: N;
  constructor(light: THREE.Light) {
    super(light);
    const factor = lightFactor(light);
    this.colorNode = this.colorNode.mul(factor);
    this.groundUniform = this.groundColorNode;
    this.groundTested = this.groundColorNode.mul(factor);
    this.groundColorNode = this.groundTested;
  }
  override update(frame: unknown): void {
    this.groundColorNode = this.groundUniform;
    try {
      super.update(frame);
    } finally {
      this.groundColorNode = this.groundTested;
    }
  }
}

/** Teach a renderer to shade layered lights (three finds a light's node class by its constructor). */
export function registerLayeredLights(renderer: { library: { addLight(node: unknown, light: unknown): void } }): void {
  renderer.library.addLight(LayeredDirectionalLightNode, LayeredDirectionalLight);
  renderer.library.addLight(LayeredPointLightNode, LayeredPointLight);
  renderer.library.addLight(LayeredSpotLightNode, LayeredSpotLight);
  renderer.library.addLight(LayeredAmbientLightNode, LayeredAmbientLight);
  renderer.library.addLight(LayeredHemisphereLightNode, LayeredHemisphereLight);
}
