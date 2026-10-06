/**
 * Light layers on the renderer: the layers drawables carry, the shadow caster
 * filter, layered lights realized only for narrowed masks (plain lights
 * otherwise, so a project without layers is drawn as before), a script's mask
 * applied in place or by realizing the light again, and draws of different
 * layers kept apart by the batcher.
 */
import * as THREE from 'three/webgpu';
import { describe, expect, it } from 'vitest';

import { batchKey, batchKeyParts, BATCH_KEY } from './batching';
import { applyObjectLightLayers, castsShadowFor, isLayeredLight, LayeredDirectionalLight, LayeredPointLight, LayeredSpotLight, lightLayersOfComponents, lightsObject, LIGHT_LAYERS_KEY, objectLightLayers, registerLayeredLights } from './light-layers';
import { createSceneLights } from './lights-shadows';
import { StaticShadowRevision } from './shadow-casters';

const ALL = 255;

function sceneLights(scene: THREE.Scene) {
  const placed = new Map<string, THREE.Object3D>();
  const lights = createSceneLights({
    scene,
    v3: true,
    startView: [0, 2, 6],
    resources: {} as never,
    loadCookie: null,
    bakedLight: () => false,
    place: (id, light) => {
      const node = placed.get(id) ?? new THREE.Group();
      placed.set(id, node);
      node.add(light);
    },
    shadingChanged: () => undefined,
    tagBits: new Map(),
    staticShadows: new StaticShadowRevision(),
  });
  const lightOn = (id: string): THREE.Light | undefined => (placed.get(id)?.children.find((c) => (c as THREE.Light).isLight === true) as THREE.Light | undefined) ?? (scene.children.find((c) => c.userData['id'] === id) as THREE.Light | undefined);
  return { lights, lightOn };
}

describe('light layers', () => {
  it('drawables carry their layers only when they are not every layer', () => {
    const root = new THREE.Group();
    const a = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshStandardMaterial());
    root.add(a);
    expect(objectLightLayers(a)).toBe(ALL);
    expect(applyObjectLightLayers(root, 2)).toBe(true);
    expect(a.userData[LIGHT_LAYERS_KEY]).toBe(2);
    expect(applyObjectLightLayers(root, 2)).toBe(false);
    expect(applyObjectLightLayers(root, ALL)).toBe(true);
    expect(a.userData[LIGHT_LAYERS_KEY]).toBeUndefined();
    expect(lightLayersOfComponents({ box: { lightLayers: 4 } })).toBe(4);
    expect(lightLayersOfComponents({ instances: {} })).toBe(ALL);
    expect(lightLayersOfComponents({ blockLayer: { lightLayers: 128 } })).toBe(128);
  });

  it('a layered light lights and shadows only the objects in its masks; a plain light every object', () => {
    const obj = new THREE.Mesh();
    obj.userData[LIGHT_LAYERS_KEY] = 2;
    const plain = new THREE.PointLight();
    expect(lightsObject(plain, obj)).toBe(true);
    expect(castsShadowFor(plain, obj)).toBe(true);
    const layered = new LayeredPointLight();
    layered.lightMask = 1;
    layered.shadowCasterMask = 3;
    expect(lightsObject(layered, obj)).toBe(false);
    expect(castsShadowFor(layered, obj)).toBe(true);
    layered.shadowCasterMask = 1;
    expect(castsShadowFor(layered, obj)).toBe(false);
    // An object without layers is in every layer.
    expect(lightsObject(layered, new THREE.Mesh())).toBe(true);
  });

  it("a layered light's own shadow pass draws only the casters in its shadow caster mask", () => {
    const nodes = new Map<unknown, new (light: THREE.Light) => { setupShadowNode(): { getShadowRenderObjectFunction(r: unknown, s: unknown): (o: THREE.Object3D, ...rest: unknown[]) => void } }>();
    registerLayeredLights({ library: { addLight: (node, light) => void nodes.set(light, node as never) } });
    for (const light of [new LayeredPointLight(), new LayeredSpotLight(), new LayeredDirectionalLight()]) {
      light.shadowCasterMask = 1;
      const drawn: string[] = [];
      const renderer = { shadowMap: { type: THREE.PCFShadowMap }, getMRT: () => null, renderObject: (o: THREE.Object3D) => void drawn.push(o.name) };
      const draw = new (nodes.get(light.constructor)!)(light).setupShadowNode().getShadowRenderObjectFunction(renderer, light.shadow);
      const caster = (name: string, layers: number | null): THREE.Mesh => {
        const m = new THREE.Mesh();
        m.name = name;
        m.castShadow = true;
        if (layers !== null) m.userData[LIGHT_LAYERS_KEY] = layers;
        return m;
      };
      for (const o of [caster('every layer', null), caster('layer 1', 1), caster('layer 2', 2)]) draw(o, new THREE.Scene(), new THREE.PerspectiveCamera(), o.geometry, o.material, null, null, null, null);
      expect(drawn, light.type).toEqual(['every layer', 'layer 1']);
    }
  });

  it('the batcher never groups meshes of different layers', () => {
    const geometry = new THREE.BoxGeometry();
    const material = new THREE.MeshStandardMaterial();
    const mesh = (layers: number | null): THREE.Mesh => {
      const m = new THREE.Mesh(geometry, material);
      m.userData[BATCH_KEY] = true;
      if (layers !== null) m.userData[LIGHT_LAYERS_KEY] = layers;
      return m;
    };
    const key = (m: THREE.Mesh): string => batchKey(batchKeyParts(m)!, null, 32);
    expect(key(mesh(null))).toBe(key(mesh(null)));
    expect(key(mesh(2))).toBe(key(mesh(2)));
    expect(key(mesh(2))).not.toBe(key(mesh(null)));
    expect(key(mesh(2))).not.toBe(key(mesh(4)));
  });

  it('only narrowed masks make a layered light; a script mask applies in place or realizes the light again', () => {
    const scene = new THREE.Scene();
    const { lights, lightOn } = sceneLights(scene);
    const point = (id: string, extra: Record<string, unknown> = {}) => ({ id, components: { light: { type: 'point', color: '#ffffff', intensity: 10, range: 5, ...extra } } });
    lights.realize(point('plain'));
    lights.realize(point('masked', { lightMask: 1, shadowCasterMask: 3 }));
    expect(isLayeredLight(lightOn('plain'))).toBe(false);
    const masked = lightOn('masked') as LayeredPointLight;
    expect(isLayeredLight(masked)).toBe(true);
    expect([masked.lightMask, masked.shadowCasterMask]).toEqual([1, 3]);
    // A layered light's mask changes in place (nothing is built again).
    expect(lights.applyOverrides(new Map([['masked', { lightMask: 6 }]]), false, () => 5)).toBe(false);
    expect(lightOn('masked')).toBe(masked);
    expect(masked.lightMask).toBe(6);
    // A plain light given a mask is realized again as a layered one, and back.
    expect(lights.applyOverrides(new Map([['plain', { lightMask: 2 }]]), false, () => 5)).toBe(true);
    const now = lightOn('plain');
    expect(isLayeredLight(now)).toBe(true);
    expect((now as LayeredPointLight).lightMask).toBe(2);
    expect(lights.applyOverrides(new Map(), false, () => 5)).toBe(true);
    expect(isLayeredLight(lightOn('plain'))).toBe(false);
    expect((lightOn('masked') as LayeredPointLight).lightMask).toBe(1);
    // Every light is still one light on its entity.
    expect(lights.has('plain') && lights.has('masked')).toBe(true);
    lights.dispose();
  });
});
