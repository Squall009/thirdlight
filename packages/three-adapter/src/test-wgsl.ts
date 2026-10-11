/**
 * Test-only: the WGSL three builds for a mesh, without a GPU (the WebGPU
 * backend's node builder runs in Node over a stand-in canvas). NOT part of
 * the public surface — imported only by .test.ts files.
 *
 * Tests digest it to prove that a scene which does not use a feature keeps
 * its programs: a new program is a pipeline compile in the player's first
 * frames.
 */
import * as THREE from 'three';
import * as TSL from 'three/tsl';
import { WebGPURenderer } from 'three/webgpu';

import type { GraphCompileEnv, MaterialGraphLike } from './material-graph';
import { createMaterialLibrary, type MaterialDefLike } from './material-library';

/** What of three's WGSL node builder this reads and sets (its typings stop at the abstract builder). */
interface Builder {
  scene: THREE.Scene;
  camera: THREE.Camera;
  material: THREE.Material;
  lightsNode: unknown;
  build(): void;
  readonly vertexShader: string;
  readonly fragmentShader: string;
}

/** A renderer that only builds node programs (no device: it reports no optional features, the same answer for every build compared). */
export function wgslRenderer(): WebGPURenderer {
  const canvas = { style: {}, width: 1, height: 1, addEventListener() {}, removeEventListener() {}, getContext: () => null };
  const renderer = new WebGPURenderer({ canvas: canvas as unknown as HTMLCanvasElement });
  (renderer as unknown as { hasFeature: () => boolean }).hasFeature = () => false;
  return renderer;
}

/** The vertex and fragment WGSL three builds for a mesh in a scene (its lights included). */
export function wgslOf(renderer: WebGPURenderer, scene: THREE.Scene, mesh: THREE.Mesh): string {
  const camera = new THREE.PerspectiveCamera();
  const lights: THREE.Light[] = [];
  scene.traverse((o) => {
    if ((o as THREE.Light).isLight === true) lights.push(o as THREE.Light);
  });
  const backend = (renderer as unknown as { backend: { createNodeBuilder(o: THREE.Object3D, r: WebGPURenderer): Builder } }).backend;
  const b = backend.createNodeBuilder(mesh, renderer);
  b.scene = scene;
  b.camera = camera;
  b.material = mesh.material as THREE.Material;
  const lightsNode = renderer.lighting.getNode(scene) as unknown as { setLights(l: THREE.Light[]): void };
  lightsNode.setLights(lights);
  b.lightsNode = lightsNode;
  b.build();
  return `${b.vertexShader}\n${b.fragmentShader}`;
}

/** A lit scene: a sun and an ambient light. */
export function litScene(): THREE.Scene {
  const scene = new THREE.Scene();
  scene.add(new THREE.DirectionalLight('#ffffff', 1.5), new THREE.AmbientLight('#ffffff', 0.4));
  return scene;
}

/** Let texture promises settle (a material rebuilds its nodes as each texture arrives). */
export async function settle(): Promise<void> {
  for (let i = 0; i < 3; i++) await new Promise((r) => setTimeout(r, 0));
}

/** A small trim sheet's rows (the trim material of the fixtures). */
export const TEST_TRIM = { size: [256, 256] as [number, number], texelDensity: 256, padding: 8, rows: [{ slot: 'a', top: 8, bottom: 120 }, { slot: 'b', top: 136, bottom: 248 }] };

/** One material of every shader type that is not a decal (textured where the type takes textures). */
export const SHADER_TYPE_MATERIALS: readonly MaterialDefLike[] = [
  { materialId: 'standard', name: 'standard', shader: 'standard', params: {}, textures: {} },
  { materialId: 'textured', name: 'textured', shader: 'standard', params: { color: '#c08040', roughness: 0.6 }, textures: { map: 'tex', normalMap: 'tex', ormMap: 'tex', emissiveMap: 'tex' } },
  { materialId: 'blended', name: 'blended', shader: 'standard', params: { alphaMode: 'blend', opacity: 0.6 }, textures: {} },
  { materialId: 'foliage', name: 'foliage', shader: 'foliage', params: {}, textures: { map: 'tex' } },
  { materialId: 'kit', name: 'kit', shader: 'kit', params: {}, textures: { map: 'tex', normalMap: 'tex' } },
  { materialId: 'water', name: 'water', shader: 'water', params: {}, textures: { normalMap: 'tex' } },
  { materialId: 'unlit', name: 'unlit', shader: 'unlit', params: {}, textures: { map: 'tex' } },
  { materialId: 'trim', name: 'trim', shader: 'trim', params: {}, textures: { map: 'tex', normalMap: 'tex', ormMap: 'tex' }, trim: TEST_TRIM },
];

/**
 * The WGSL digests of {@link SHADER_TYPE_MATERIALS}, recorded before decals
 * existed (three r186): a scene without decals keeps these programs. A
 * change of three.js changes the text: re-record them then (the failure
 * prints the new ones).
 */
export const SHADER_TYPE_WGSL: Readonly<Record<string, string>> = {
  standard: '2cc544a08f2da47b',
  textured: '39c822174bd5badf',
  blended: '4df9b83631a1f83c',
  foliage: '3062ba15d8ae7ab1',
  kit: '83a0897a5b6be10d',
  water: '588fd2ffeda77232',
  unlit: '6c19ec5d6d3f2a86',
  trim: 'f247953ef4436cd6',
};

const n = (id: string, type: string, data?: Record<string, unknown>) => ({ id, type, position: [0, 0] as [number, number], ...(data !== undefined ? { data } : {}) });
const e = (id: string, from: string, fp: string, to: string, tp: string) => ({ id, from: { node: from, port: fp }, to: { node: to, port: tp } });

/** Graphs that use none of the phase's features (specular, decals): every PBR slot, the surface flags, the other outputs. */
export const PLAIN_GRAPHS: Readonly<Record<string, MaterialGraphLike>> = {
  plain: { nodes: [n('out', 'pbr')], edges: [] },
  tinted: {
    nodes: [n('out', 'pbr', { castShadows: false }), n('p', 'parameter', { key: 'tint' }), n('s', 'sampleTexture', { texture: 'tex' })],
    edges: [e('a', 'p', 'value', 'out', 'baseColor'), e('b', 's', 'r', 'out', 'roughness'), e('c', 's', 'g', 'out', 'metalness')],
  },
  everySlot: {
    nodes: [n('out', 'pbr', { doubleSided: true, transparent: true }), n('s', 'sampleTexture', { texture: 'tex' }), n('nm', 'normalMap', { texture: 'tex' }), n('f', 'fresnel'), n('k', 'float', { value: 0.5 })],
    edges: [e('a', 's', 'rgb', 'out', 'baseColor'), e('b', 'nm', 'normal', 'out', 'normal'), e('c', 'f', 'out', 'out', 'emissive'), e('d', 's', 'r', 'out', 'ao'), e('f', 's', 'a', 'out', 'opacity'), e('g', 'k', 'value', 'out', 'alphaClip')],
  },
  unlit: { nodes: [n('out', 'unlit'), n('c', 'color', { color: '#ff8000' })], edges: [e('a', 'c', 'rgb', 'out', 'color')] },
  customLit: { nodes: [n('out', 'customLit'), n('d', 'diffuseLight')], edges: [e('a', 'd', 'total', 'out', 'color')] },
};

/** The WGSL digests of {@link PLAIN_GRAPHS}, recorded before the specular ports existed (three r186). */
export const PLAIN_GRAPH_WGSL: Readonly<Record<string, string>> = {
  plain: 'c4870c84c910e8e4',
  tinted: '2a9c50218bd57d29',
  everySlot: '8d625f13e5af0475',
  unlit: 'c2f4be09abc549e7',
  customLit: 'b565c0183be022b0',
};

/** What a test graph compiles with (no textures, no functions). */
export const GRAPH_ENV: GraphCompileEnv = {
  globals: { time: TSL.uniform(0), windDir: TSL.uniform(new THREE.Vector2(1, 0)), strength: TSL.uniform(1), gust: TSL.uniform(0), gustFreq: TSL.uniform(0), turb: TSL.uniform(0), wetness: TSL.uniform(0) },
  texture: () => null,
  fn: () => null,
};
const PARAMETERS: MaterialDefLike['parameters'] = [{ key: 'tint', type: 'color', default: '#ff0000' }];

/** A graph as a project material (with the tint parameter the fixtures read). */
export const graphDef = (materialId: string, graph: MaterialGraphLike): MaterialDefLike => ({ materialId, name: materialId, shader: 'standard', params: {}, textures: {}, graph, parameters: PARAMETERS });

/** A one-texel texture every fixture texture id loads as. */
export function testTexture(): THREE.Texture {
  const t = new THREE.DataTexture(new Uint8Array([200, 120, 60, 255]), 1, 1);
  t.needsUpdate = true;
  return t;
}

/** A lit scene with a sphere wearing each of `defs` (through a material library), once their textures arrived. */
export async function libraryScene(defs: readonly MaterialDefLike[], scene: THREE.Scene = litScene()): Promise<{ scene: THREE.Scene; meshes: Record<string, THREE.Mesh> }> {
  const tex = testTexture();
  const library = createMaterialLibrary({ loadTexture: async () => tex });
  library.setMaterials(defs);
  const meshes: Record<string, THREE.Mesh> = {};
  for (const d of defs) {
    const m = new THREE.Mesh(new THREE.SphereGeometry(1, 8, 6), new THREE.MeshStandardMaterial());
    scene.add(m);
    library.apply(m, { '*': d.materialId });
    meshes[d.materialId] = m;
  }
  await settle();
  return { scene, meshes };
}
