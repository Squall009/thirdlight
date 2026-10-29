/**
 * Local lights per object, browser-free: which mode an object draws with
 * (its own, else its material's, else per pixel), the mode variant of a
 * material (reads the material's current values, its own program key, one
 * per material, disposed with the material), the draw-time swap (and what it
 * leaves alone), which lights a build in mode none leaves out, the lights
 * node key following the effect pool's layer test, and modes kept apart by
 * the batcher. The pixels are in scene-lights.e2e.ts.
 */
import * as THREE from 'three/webgpu';
import { describe, expect, it } from 'vitest';

import { batchKey, batchKeyParts, BATCH_KEY } from './batching';
import { ClusterGpu } from './cluster-gpu';
import { ClusteredLights } from './cluster-lights';
import { ClusterTextures } from './cluster-pack';
import { INSTANCE_SET_KEY } from './instancing';
import { applyEntityRenderFlags } from './entity-render-flags';
import { drawMode, installLocalLightModes, localLightsCacheKey, localLightVariant, LOCAL_LIGHTS_KEY, splitLocalLights } from './local-lights';
import { variantSource } from './material-variant';

const lit = () => new THREE.MeshStandardNodeMaterial();

describe('local-light modes', () => {
  it('an object draws with its own mode, else its material\'s, else per pixel (an instance set too)', () => {
    const m = lit();
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(), m);
    expect(drawMode(mesh, m)).toBe('pixel');
    mesh.userData[INSTANCE_SET_KEY] = true;
    expect(drawMode(mesh, m)).toBe('pixel');
    m.userData[LOCAL_LIGHTS_KEY] = 'none';
    expect(drawMode(mesh, m)).toBe('none');
    mesh.userData[LOCAL_LIGHTS_KEY] = 'pixel';
    expect(drawMode(mesh, m)).toBe('pixel');
  });

  it('an entity\'s localLights reaches every mesh under it and is cleared when unset', () => {
    const root = new THREE.Group();
    const a = new THREE.Mesh(new THREE.BoxGeometry(), lit());
    const b = new THREE.Mesh(new THREE.BoxGeometry(), lit());
    root.add(a);
    a.add(b);
    expect(applyEntityRenderFlags(root, { model: { localLights: 'none' } })).toBe(true);
    expect([a.userData[LOCAL_LIGHTS_KEY], b.userData[LOCAL_LIGHTS_KEY]]).toEqual(['none', 'none']);
    expect(applyEntityRenderFlags(root, { model: { localLights: 'none' } })).toBe(false);
    // A stored value that is no mode (the load upgrades it) sets none.
    expect(applyEntityRenderFlags(root, { model: { localLights: 'vertex' } })).toBe(true);
    expect(LOCAL_LIGHTS_KEY in a.userData).toBe(false);
    expect(applyEntityRenderFlags(root, { model: { localLights: 'none' } })).toBe(true);
    expect(applyEntityRenderFlags(root, { model: {} })).toBe(true);
    expect(LOCAL_LIGHTS_KEY in a.userData).toBe(false);
  });

  it('a variant reads the material\'s current values, keys its own program, is made once and goes with the material', () => {
    const m = lit();
    m.color.set('#ff0000');
    const v = localLightVariant(m, 'none');
    expect(localLightVariant(m, 'none')).toBe(v);
    expect((v as THREE.MeshStandardNodeMaterial).color.getHexString()).toBe('ff0000');
    m.color.set('#00ff00');
    m.roughness = 0.25;
    m.needsUpdate = true;
    // The values reach the variant at its next render call (each draw asks for it).
    expect(localLightVariant(m, 'none', null, 7)).toBe(v);
    expect((v as THREE.MeshStandardNodeMaterial).color.getHexString()).toBe('00ff00');
    expect((v as THREE.MeshStandardNodeMaterial).roughness).toBe(0.25);
    expect(v.version).toBe(m.version);
    expect((v as unknown as { id: number }).id).toBe((m as unknown as { id: number }).id);
    // Within one render call they are copied once.
    m.roughness = 0.5;
    localLightVariant(m, 'none', null, 7);
    expect((v as THREE.MeshStandardNodeMaterial).roughness).toBe(0.25);
    localLightVariant(m, 'none', null, 8);
    expect((v as THREE.MeshStandardNodeMaterial).roughness).toBe(0.5);
    m.roughness = 0.25;
    localLightVariant(m, 'none');
    expect(v.customProgramCacheKey()).not.toBe(m.customProgramCacheKey());
    expect(v.customProgramCacheKey()).toContain('tlLocalLights=none');
    // Equal materials share programs: their variants' keys are equal.
    const twin = lit();
    twin.color.set('#00ff00');
    twin.roughness = 0.25;
    expect(localLightVariant(twin, 'none').customProgramCacheKey()).toBe(v.customProgramCacheKey());
    const other = lit();
    other.color.set('#00ff00');
    other.roughness = 0.25;
    // A different value that keys three's programs (a texture slot) is the variant's own value, which three keys its program by.
    other.map = new THREE.Texture();
    const ov = localLightVariant(other, 'none');
    expect(Object.prototype.hasOwnProperty.call(ov, 'map') && (ov as THREE.MeshStandardNodeMaterial).map).toBe(other.map);
    expect(Object.keys(ov).filter((k) => !k.startsWith('_') && !k.startsWith('tl') && k !== 'customProgramCacheKey')).toEqual(Object.keys(other).filter((k) => !k.startsWith('_')));
    let disposed = 0;
    v.addEventListener('dispose', () => (disposed += 1));
    m.dispose();
    expect(disposed).toBe(1);
    expect(localLightVariant(m, 'none')).not.toBe(v);
  });

  it('the draw-time swap uses the variant for lit draws only, never in an override pass, and leaves `side` to the material', () => {
    const drawn: THREE.Material[] = [];
    const sides: THREE.Side[] = [];
    const renderer = {
      renderObject(_o: THREE.Object3D, _s: THREE.Scene, _c: THREE.Camera, _g: THREE.BufferGeometry, material: THREE.Material) {
        drawn.push(material);
        sides.push(material.side);
        // three's transparent double-sided pass sets the side on what it draws, then back.
        material.side = THREE.DoubleSide;
      },
    };
    installLocalLightModes(renderer as never);
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera();
    const m = lit();
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(), m);
    const draw = (material: THREE.Material): THREE.Material => {
      renderer.renderObject(mesh, scene, camera, mesh.geometry, material);
      return drawn[drawn.length - 1]!;
    };
    expect(draw(m)).toBe(m);
    mesh.userData[LOCAL_LIGHTS_KEY] = 'none';
    const v = draw(m);
    expect(variantSource(v)).toBe(m);
    // The side three set while drawing is the material's again at the next render call.
    expect(v.side).toBe(THREE.DoubleSide);
    m.side = THREE.FrontSide;
    expect(draw(m)).toBe(v);
    expect(sides[sides.length - 1]).toBe(THREE.FrontSide);
    mesh.userData[LOCAL_LIGHTS_KEY] = 'pixel';
    expect(draw(m)).toBe(m);
    mesh.userData[LOCAL_LIGHTS_KEY] = 'none';
    // Unlit materials and override passes (shadow maps) are drawn as they are.
    const basic = new THREE.MeshBasicNodeMaterial();
    expect(draw(basic)).toBe(basic);
    scene.overrideMaterial = new THREE.MeshBasicNodeMaterial();
    expect(draw(m)).toBe(m);
    // A plain lit material (a model file's own, converted by three) gets a variant too.
    scene.overrideMaterial = null;
    const plain = new THREE.MeshStandardMaterial();
    expect(variantSource(draw(plain))).toBe(plain);
  });

  it('a build in mode none leaves out the local lights and the light clusters (effects\' lights included); the sun, ambient light and every per-pixel build keep all', () => {
    const sun = new THREE.DirectionalLight();
    const ambient = new THREE.AmbientLight();
    const point = new THREE.PointLight();
    const spot = new THREE.SpotLight();
    const clusters = new ClusteredLights(new ClusterGpu(new ClusterTextures()));
    const nodes = [sun, ambient, point, spot, clusters].map((light) => ({ light: light as THREE.Light, build: () => undefined }));
    const names = new Map<THREE.Light, string>([[sun, 'sun'], [ambient, 'ambient'], [point, 'point'], [spot, 'spot'], [clusters, 'clusters']]);
    const split = (material: THREE.Material) => splitLocalLights({ material }, nodes).map((n) => names.get(n.light));
    const m = lit();
    expect(split(m)).toEqual(['sun', 'ambient', 'point', 'spot', 'clusters']);
    expect(split(localLightVariant(m, 'none'))).toEqual(['sun', 'ambient']);
  });

  it('the light clusters\' layer test keys the lit programs (a change rebuilds them); scene lights add nothing to the key', () => {
    const clusters = new ClusteredLights(new ClusterGpu(new ClusterTextures()));
    const lights = [new THREE.PointLight(), new THREE.SpotLight(), clusters];
    expect(localLightsCacheKey(lights)).toBe(0);
    clusters.layered = true;
    expect(localLightsCacheKey(lights)).not.toBe(0);
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
    expect(key(mk('none'))).not.toBe(key(mk()));
    expect(key(mk('pixel'))).not.toBe(key(mk('none')));
    expect(batchKeyParts(mk('none'))!.localLights).toBe('none');
  });
});
