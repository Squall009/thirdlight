/**
 * The texture-unit budget of lit programs, counted on the programs three
 * builds (WGSL, no GPU): every lit program kind under the worst-case
 * settings — the sun's shadow with contact shadows, ambient occlusion,
 * screen-space reflections, the probes, the surface cache read, a
 * lightmap, projected decals, the environment map, and the light clusters
 * with their light tables and shadow atlas — binds at most what a WebGPU
 * fragment stage may on the low tier's GPUs.
 */
import * as THREE from 'three';
import * as TSL from 'three/tsl';
import { SkinnedMesh } from 'three';
import { describe, expect, it } from 'vitest';
import { WebGPURenderer } from 'three/webgpu';

import { createAttributeInstancedMesh } from './attribute-instancing';
import { ClusterGpu } from './cluster-gpu';
import { ClusteredLights, registerClusteredLights } from './cluster-lights';
import { ClusterTextures } from './cluster-pack';
import { lightmappedMaterial } from './lightmaps';
import { localLightVariant } from './local-lights';
import { createMaterialLibrary, GRAPH_SURFACE_KEY, type MaterialDefLike } from './material-library';
import { ScreenSpaceOcclusion, registerScreenSpaceOcclusion } from './post-ao';
import { ContactShadowsLight, registerContactShadows, withContactShadows } from './post-contact-shadows';
import { ReflectionsLight, registerReflections } from './post-reflections';
import { ProbeLighting, registerProbeLighting } from './probe-lighting';
import { decalVariant, installProjectedDecalSteps, ProjectedDecals } from './projected-decals';
import { SURFACE_READ } from './surface-cache-lookup';
import { SurfaceCacheTextures } from './surface-cache-read';
import { terrainSurface, terrainUniforms } from './terrain-material';
import { fragmentWgslOf, graphDef, PLAIN_GRAPHS, settle, SHADER_TYPE_MATERIALS, testTexture, wgslRenderer } from './test-wgsl';
import { LIGHT_PATH_TEXTURE_UNITS, LIT_TEXTURE_UNITS } from './texture-units';

function renderer(): WebGPURenderer {
  const r = wgslRenderer();
  r.shadowMap.enabled = true;
  registerProbeLighting(r as never);
  registerClusteredLights(r as never);
  registerScreenSpaceOcclusion(r as never);
  registerContactShadows(r as never);
  registerReflections(r as never);
  installProjectedDecalSteps();
  // Skinning sizes its bone matrices by the device's uniform buffer limit (WebGPU's guaranteed one here).
  (r as unknown as { backend: { device: unknown } }).backend.device = { limits: { maxUniformBufferBindingSize: 65536 } };
  // A shadow asks the device what it can do (no device: the plain answer, as `hasFeature`).
  (r as unknown as { hasCompatibility: () => boolean }).hasCompatibility = () => false;
  return r;
}

/** The scene with every light-side feature that adds a texture to a lit program. */
function worstScene(): THREE.Scene {
  const scene = new THREE.Scene();
  const sun = new THREE.DirectionalLight('#ffffff', 2);
  sun.castShadow = true;
  (sun.shadow as { shadowNode?: unknown }).shadowNode = withContactShadows(TSL.shadow(sun as never, sun.shadow as never));
  scene.add(sun, sun.target, new THREE.AmbientLight('#ffffff', 0.2));
  // With both drawn, the occlusion's history carries the contact shadows (as the environment keeps them).
  const ao = new ScreenSpaceOcclusion();
  scene.add(ao, new ContactShadowsLight(ao), new ReflectionsLight(), new ProbeLighting());
  // The local lights' loop, layered (its layer and room test reads no texture, but the worst case is the widest build).
  const clustered = new ClusteredLights(new ClusterGpu(new ClusterTextures()));
  clustered.layered = true;
  clustered.areas = true;
  clustered.uncached = true;
  clustered.shadows = true;
  scene.add(clustered);
  const env = new THREE.CubeTexture();
  scene.environment = env;
  return scene;
}

const node = (id: string, type: string, data?: Record<string, unknown>) => ({ id, type, position: [0, 0] as [number, number], ...(data !== undefined ? { data } : {}) });
const edge = (id: string, from: string, fp: string, to: string, tp: string) => ({ id, from: { node: from, port: fp }, to: { node: to, port: tp } });

/**
 * A layered surface's reads as its texture units see them: three texture
 * arrays (albedo, normals, ORM; the template reads each at four layers, one
 * binding each) and the paint or terrain weights. Read on a terrain's
 * surface, each array layer is the one its pixel's layer indices name.
 */
const LAYERED_LIKE = {
  nodes: [node('out', 'pbr'), node('a', 'sampleTexture', { texture: 'arr:albedo' }), node('n', 'normalMap', { texture: 'arr:normal' }), node('o', 'sampleTexture', { texture: 'arr:orm' }), node('w', 'vertexColor'), node('sp', 'split')],
  edges: [edge('e1', 'a', 'rgb', 'out', 'baseColor'), edge('e2', 'n', 'normal', 'out', 'normal'), edge('e3', 'o', 'g', 'out', 'roughness'), edge('e4', 'o', 'r', 'out', 'ao'), edge('e5', 'w', 'rgba', 'sp', 'in'), edge('e6', 'sp', 'x', 'out', 'metalness')],
};

/** Sampled textures (and depth, storage) the fragment stage binds. */
function units(wgsl: string): number {
  return (wgsl.match(/\bvar\s+\w+\s*:\s*texture_/g) ?? []).length;
}

function arrayTexture(): THREE.DataArrayTexture {
  const t = new THREE.DataArrayTexture(new Uint8Array(4 * 4 * 4 * 2), 4, 4, 2);
  t.needsUpdate = true;
  return t;
}

/** The units each lit kind's program binds per variant (the clusters' one included), under the worst-case settings. */
async function countUnits(): Promise<Record<string, Record<string, number>>> {
  const r = renderer();
  const scene = worstScene();
  // A texture of its own for every slot (one shared asset would bind once and count once).
  const loaded = new Map<string, THREE.Texture>();
  const library = createMaterialLibrary({ loadTexture: async (id) => (loaded.get(id) ?? loaded.set(id, id.startsWith('arr:') ? arrayTexture() : testTexture()).get(id))! });
  const own = (d: MaterialDefLike): MaterialDefLike => ({ ...d, textures: Object.fromEntries(Object.keys(d.textures).map((k) => [k, `${d.materialId}:${k}`])) });
  const everySlot = JSON.parse(JSON.stringify(PLAIN_GRAPHS['everySlot']!).replace('"texture":"tex"}},{"id":"nm"', '"texture":"graph:base"}},{"id":"nm"').replace('"texture":"tex"', '"texture":"graph:normal"'));
  const defs: MaterialDefLike[] = [
    ...SHADER_TYPE_MATERIALS.filter((d) => d.shader !== 'unlit').map(own),
    graphDef('graph', everySlot),
    graphDef('customLit', PLAIN_GRAPHS['customLit']!),
    graphDef('layered', LAYERED_LIKE),
  ];
  library.setMaterials(defs);
  const meshes: Record<string, THREE.Mesh> = {};
  for (const d of defs) {
    const m = new THREE.Mesh(new THREE.SphereGeometry(1, 8, 6), new THREE.MeshStandardMaterial());
    library.apply(m, { '*': d.materialId });
    meshes[d.materialId] = m;
  }
  // The terrain: the layered material on a terrain page's surface.
  const terrain = new THREE.Mesh(new THREE.BufferGeometry(), new THREE.MeshStandardMaterial());
  terrain.userData[GRAPH_SURFACE_KEY] = terrainSurface('terrain:test', arrayTexture(), arrayTexture(), terrainUniforms());
  library.apply(terrain, { '*': 'layered' });
  meshes['terrain'] = terrain;
  const tex = testTexture;
  const skinned = new SkinnedMesh(new THREE.BoxGeometry(), new THREE.MeshStandardMaterial({ map: tex(), normalMap: tex(), roughnessMap: tex(), emissiveMap: tex() }));
  skinned.bind(new THREE.Skeleton([new THREE.Bone()]));
  meshes['skinned'] = skinned;
  meshes['lambert'] = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshLambertMaterial({ map: tex(), normalMap: tex(), emissiveMap: tex() }));
  await settle();
  meshes['instanced'] = createAttributeInstancedMesh(new THREE.BoxGeometry(), meshes['textured']!.material as THREE.Material, 4, { surfaceSlots: true }).mesh;
  const lightmapped = lightmappedMaterial((meshes['textured']!.material as THREE.Material).clone(), tex(), 1, false);
  if (lightmapped !== null) meshes['lightmapped'] = new THREE.Mesh(new THREE.BoxGeometry(), lightmapped);
  const decals = new ProjectedDecals();
  const cache = new SurfaceCacheTextures(4, 7);
  const counts: Record<string, Record<string, number>> = {};
  for (const [kind, mesh] of Object.entries(meshes)) {
    mesh.receiveShadow = true;
    const own = mesh.material as THREE.Material;
    const variants: Record<string, THREE.Material> = {
      dynamic: own,
      cache: localLightVariant(own, 'pixel', { kind: SURFACE_READ.model, textures: cache }),
      decals: decalVariant(own, decals),
      'cache+decals': decalVariant(localLightVariant(own, 'pixel', { kind: SURFACE_READ.model, textures: cache }), decals),
    };
    counts[kind] = {};
    for (const [v, m] of Object.entries(variants)) {
      mesh.material = m;
      counts[kind]![v] = units(fragmentWgslOf(r, scene, mesh));
    }
    mesh.material = own;
  }
  return counts;
}

/** Time the program builds of one count take at most (a loaded host). */
const BUILD_MS = 60_000;

/** What a lit program may bind with the light path's units (clusters, light tables, shadow atlas) all in: the whole budget. */
const ROOM = LIT_TEXTURE_UNITS - (LIGHT_PATH_TEXTURE_UNITS - 3);

describe('lit programs fit the texture-unit budget', () => {
  it('every lit kind, moving or reading the surface cache, leaves the light path its units', async () => {
    const counts = await countUnits();
    const over = Object.entries(counts).flatMap(([kind, by]) => ['dynamic', 'cache'].filter((v) => by[v]! > ROOM).map((v) => `${kind} ${v}: ${by[v]}`));
    expect(over, JSON.stringify(counts)).toEqual([]);
    // It builds some eighty programs: past vitest's 5 s on a loaded host.
  }, BUILD_MS);

  // Projected decals add their data and three page arrays: with the rest of the worst case a decal-reached program
  // passes the budget (and WebGPU's 16 already, before the light path's units).
  it.fails('every lit kind reached by projected decals leaves the light path its units', async () => {
    const counts = await countUnits();
    const over = Object.entries(counts).flatMap(([kind, by]) => ['decals', 'cache+decals'].filter((v) => by[v]! > ROOM).map((v) => `${kind} ${v}: ${by[v]}`));
    expect(over).toEqual([]);
  }, BUILD_MS);
});
