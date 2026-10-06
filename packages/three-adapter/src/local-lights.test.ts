/**
 * Local lights per vertex, browser-free: which mode an object draws with
 * (its own, else its material's, else the default for its kind), the mode
 * variant of a material (reads the material's current values, its own
 * program key, one per material and mode, disposed with the material), the
 * draw-time swap (and what it leaves alone), how a build's lights split, the
 * lights node key following importances, the realized light's importance and
 * modes kept apart by the batcher. The pixels are in scene-lights.e2e.ts.
 */
import * as THREE from 'three/webgpu';
import { describe, expect, it } from 'vitest';
import { INSTANCES_LOCAL_LIGHTS_DEFAULT } from '@thirdlight/runtime';

import { batchKey, batchKeyParts, BATCH_KEY } from './batching';
import { EffectLights } from './effect-lights';
import { INSTANCE_SET_KEY } from './instancing';
import { applyEntityRenderFlags } from './entity-render-flags';
import { createSceneLights } from './lights-shadows';
import { drawMode, installLocalLightModes, LIGHT_IMPORTANCE_KEY, localLightsCacheKey, localLightVariant, LOCAL_LIGHTS_KEY, markVertexLightsSummed, setLightImportance, splitLocalLights, vertexLightsFromUrl } from './local-lights';
import { StaticShadowRevision } from './shadow-casters';

const lit = () => new THREE.MeshStandardNodeMaterial();

describe('local-light modes', () => {
  it('an object draws with its own mode, else its material\'s, else its kind\'s default', () => {
    const m = lit();
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(), m);
    expect(drawMode(mesh, m)).toBe('pixel');
    mesh.userData[INSTANCE_SET_KEY] = true;
    expect(drawMode(mesh, m)).toBe(INSTANCES_LOCAL_LIGHTS_DEFAULT);
    m.userData[LOCAL_LIGHTS_KEY] = 'none';
    expect(drawMode(mesh, m)).toBe('none');
    mesh.userData[LOCAL_LIGHTS_KEY] = 'vertex';
    expect(drawMode(mesh, m)).toBe('vertex');
  });

  it('an entity\'s localLights reaches every mesh under it and is cleared when unset', () => {
    const root = new THREE.Group();
    const a = new THREE.Mesh(new THREE.BoxGeometry(), lit());
    const b = new THREE.Mesh(new THREE.BoxGeometry(), lit());
    root.add(a);
    a.add(b);
    expect(applyEntityRenderFlags(root, { model: { localLights: 'vertex' } })).toBe(true);
    expect([a.userData[LOCAL_LIGHTS_KEY], b.userData[LOCAL_LIGHTS_KEY]]).toEqual(['vertex', 'vertex']);
    expect(applyEntityRenderFlags(root, { model: { localLights: 'vertex' } })).toBe(false);
    expect(applyEntityRenderFlags(root, { model: {} })).toBe(true);
    expect(LOCAL_LIGHTS_KEY in a.userData).toBe(false);
  });

  it('a variant reads the material\'s current values, keys its own program, is made once per mode and goes with the material', () => {
    const m = lit();
    m.color.set('#ff0000');
    const v = localLightVariant(m, 'vertex');
    expect(localLightVariant(m, 'vertex')).toBe(v);
    expect(localLightVariant(m, 'none')).not.toBe(v);
    expect((v as THREE.MeshStandardNodeMaterial).color.getHexString()).toBe('ff0000');
    m.color.set('#00ff00');
    m.roughness = 0.25;
    m.needsUpdate = true;
    expect((v as THREE.MeshStandardNodeMaterial).color.getHexString()).toBe('00ff00');
    expect(v.version).toBe(m.version);
    expect(v.customProgramCacheKey()).not.toBe(m.customProgramCacheKey());
    expect(v.customProgramCacheKey()).toContain('tlLocalLights=vertex');
    // Equal materials share programs: their variants' keys are equal.
    const twin = lit();
    twin.color.set('#00ff00');
    twin.roughness = 0.25;
    expect(localLightVariant(twin, 'vertex').customProgramCacheKey()).toBe(v.customProgramCacheKey());
    // A different value that keys three's programs (a texture slot) keys the variant's too.
    twin.map = new THREE.Texture();
    expect(localLightVariant(twin, 'none').customProgramCacheKey()).not.toBe(localLightVariant(m, 'none').customProgramCacheKey());
    let disposed = 0;
    v.addEventListener('dispose', () => (disposed += 1));
    m.dispose();
    expect(disposed).toBe(1);
    expect(localLightVariant(m, 'vertex')).not.toBe(v);
  });

  it('the draw-time swap uses the variant for lit draws only, never in an override pass, and leaves `side` to the material', () => {
    const drawn: THREE.Material[] = [];
    const renderer = {
      renderObject(_o: THREE.Object3D, _s: THREE.Scene, _c: THREE.Camera, _g: THREE.BufferGeometry, material: THREE.Material) {
        drawn.push(material);
        // three's transparent double-sided pass sets the side on what it draws, then back.
        material.side = THREE.DoubleSide;
      },
    };
    installLocalLightModes(renderer as never, true);
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera();
    const m = lit();
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(), m);
    const draw = (material: THREE.Material): THREE.Material => {
      renderer.renderObject(mesh, scene, camera, mesh.geometry, material);
      return drawn[drawn.length - 1]!;
    };
    expect(draw(m)).toBe(m);
    mesh.userData[LOCAL_LIGHTS_KEY] = 'vertex';
    const v = draw(m);
    expect(Object.getPrototypeOf(v)).toBe(m);
    expect(Object.prototype.hasOwnProperty.call(v, 'side')).toBe(false);
    // Unlit materials and override passes (shadow maps) are drawn as they are.
    const basic = new THREE.MeshBasicNodeMaterial();
    expect(draw(basic)).toBe(basic);
    scene.overrideMaterial = new THREE.MeshBasicNodeMaterial();
    expect(draw(m)).toBe(m);
    // A plain lit material (a model file's own, converted by three) gets a variant too.
    scene.overrideMaterial = null;
    const plain = new THREE.MeshStandardMaterial();
    expect(Object.getPrototypeOf(draw(plain))).toBe(plain);
  });

  it('a build splits its local lights by its mode and each light\'s importance; the sun, ambient light and other lights stay per pixel', () => {
    const renderer = { renderObject: () => undefined };
    installLocalLightModes(renderer as never, true);
    const sun = new THREE.DirectionalLight();
    const ambient = new THREE.AmbientLight();
    const auto = new THREE.PointLight();
    const hero = new THREE.SpotLight();
    setLightImportance(hero, 'pixel');
    const fill = new THREE.PointLight();
    setLightImportance(fill, 'vertex');
    const cookie = new THREE.SpotLight();
    cookie.map = new THREE.Texture();
    setLightImportance(cookie, 'vertex');
    const pool = new EffectLights(4);
    const nodes = [sun, ambient, auto, hero, fill, cookie, pool].map((light) => ({ light, build: () => undefined }));
    const names = new Map<THREE.Light, string>([[sun, 'sun'], [ambient, 'ambient'], [auto, 'auto'], [hero, 'hero'], [fill, 'fill'], [cookie, 'cookie'], [pool, 'pool']]);
    const split = (material: THREE.Material, summedInVertexStage: boolean) => {
      const builder = { renderer, material };
      // The vertex stage sums the per-vertex lights first (the fragment stage keeps them only then).
      if (summedInVertexStage) markVertexLightsSummed(builder);
      const s = splitLocalLights(builder, nodes);
      return { pixel: s.pixel.map((n) => names.get(n.light)), vertex: s.vertex.map((n) => names.get(n.light)) };
    };
    const m = lit();
    expect(split(m, true)).toEqual({ pixel: ['sun', 'ambient', 'auto', 'hero', 'cookie', 'pool'], vertex: ['fill'] });
    expect(split(localLightVariant(m, 'vertex'), true)).toEqual({ pixel: ['sun', 'ambient', 'hero', 'cookie'], vertex: ['auto', 'fill', 'pool'] });
    expect(split(localLightVariant(m, 'none'), true)).toEqual({ pixel: ['sun', 'ambient'], vertex: [] });
    // A build whose vertex stage summed nothing (a material with its own vertex node) keeps them per pixel.
    expect(split(localLightVariant(m, 'vertex'), false)).toEqual({ pixel: ['sun', 'ambient', 'auto', 'hero', 'fill', 'cookie', 'pool'], vertex: [] });
    // A renderer without per-vertex lights (`?vertexLights=off`) splits nothing.
    expect(splitLocalLights({ renderer: {}, material: localLightVariant(m, 'none') }, nodes).pixel).toHaveLength(nodes.length);
    expect(vertexLightsFromUrl('?vertexLights=off')).toBe(false);
    expect(vertexLightsFromUrl('?renderer=webgl2')).toBe(true);
  });

  it('importances key the lit programs (a change rebuilds them); auto lights add nothing to the key', () => {
    const a = new THREE.PointLight();
    const b = new THREE.SpotLight();
    expect(localLightsCacheKey([a, b])).toBe(0);
    setLightImportance(a, 'vertex');
    const vertex = localLightsCacheKey([a, b]);
    setLightImportance(a, 'pixel');
    expect(localLightsCacheKey([a, b])).not.toBe(vertex);
    setLightImportance(a, 'auto');
    expect(LIGHT_IMPORTANCE_KEY in a.userData).toBe(false);
    expect(localLightsCacheKey([a, b])).toBe(0);
  });

  it('a realized point or spot light carries its importance', () => {
    const scene = new THREE.Scene();
    const placed: THREE.Object3D[] = [];
    const lights = createSceneLights({
      scene,
      v3: true,
      startView: [0, 2, 6],
      resources: {} as never,
      loadCookie: null,
      bakedLight: () => false,
      place: (_id, light) => placed.push(light),
      shadingChanged: () => undefined,
      tagBits: new Map(),
      staticShadows: new StaticShadowRevision(),
    });
    lights.realize({ id: 'p', components: { light: { type: 'point', color: '#ffffff', intensity: 1, importance: 'vertex' } } } as never);
    lights.realize({ id: 's', components: { light: { type: 'spot', color: '#ffffff', intensity: 1 } } } as never);
    const [p, s] = placed as THREE.Light[];
    expect(p!.userData[LIGHT_IMPORTANCE_KEY]).toBe('vertex');
    expect(LIGHT_IMPORTANCE_KEY in s!.userData).toBe(false);
  });

  it('the batcher keeps objects of different modes in different draws and carries the mode', () => {
    const geometry = new THREE.BoxGeometry();
    const material = lit();
    const mk = (mode?: string): THREE.Mesh => {
      const mesh = new THREE.Mesh(geometry, material);
      mesh.userData[BATCH_KEY] = true;
      if (mode !== undefined) mesh.userData[LOCAL_LIGHTS_KEY] = mode;
      return mesh;
    };
    const key = (mesh: THREE.Mesh) => batchKey(batchKeyParts(mesh)!, null, 8);
    expect(key(mk())).toBe(key(mk()));
    expect(key(mk('vertex'))).not.toBe(key(mk()));
    expect(key(mk('vertex'))).not.toBe(key(mk('none')));
    expect(batchKeyParts(mk('none'))!.localLights).toBe('none');
  });
});
