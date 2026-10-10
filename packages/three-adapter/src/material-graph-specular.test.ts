/**
 * The PBR output's specular ports, and what a graph without them still
 * builds: the WGSL three makes for its material (no GPU: the WebGPU
 * backend's node builder runs in Node over a stand-in canvas).
 *
 * The digests below are the WGSL of graphs that connect no specular port,
 * as the compiler built them before the ports existed. Every scene that
 * does not use a feature must keep its programs (a new program is a
 * pipeline compile in the player's first frames). A change of three.js
 * changes the text: re-record them then (the failure prints the new ones).
 */
import * as THREE from 'three';
import { WebGPURenderer, type MeshPhysicalNodeMaterial } from 'three/webgpu';
import { describe, expect, it } from 'vitest';

import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import * as TSL from 'three/tsl';

import { buildGraphMaterial, compileMaterialGraph, digestOf, graphNeedsPhysical, type GraphCompileEnv, type MaterialGraphLike } from './material-graph';
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

/** The vertex and fragment WGSL three builds for a mesh in a scene (its lights included). */
function wgslOf(renderer: WebGPURenderer, scene: THREE.Scene, mesh: THREE.Mesh): string {
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


const n = (id: string, type: string, data?: Record<string, unknown>) => ({ id, type, position: [0, 0] as [number, number], ...(data !== undefined ? { data } : {}) });
const e = (id: string, from: string, fp: string, to: string, tp: string) => ({ id, from: { node: from, port: fp }, to: { node: to, port: tp } });

/** Graphs that connect no specular port: every other PBR slot, the surface flags, and the other outputs. */
const GRAPHS: Record<string, MaterialGraphLike> = {
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
const ENV: GraphCompileEnv = {
  globals: { time: TSL.uniform(0), windDir: TSL.uniform(new THREE.Vector2(1, 0)), strength: TSL.uniform(1), gust: TSL.uniform(0), gustFreq: TSL.uniform(0), turb: TSL.uniform(0), wetness: TSL.uniform(0) },
  texture: () => null,
  fn: () => null,
};
const PARAMETERS: MaterialDefLike['parameters'] = [{ key: 'tint', type: 'color', default: '#ff0000' }];

/** Recorded before the specular ports existed (three r186). */
const BEFORE: Record<string, string> = {
  plain: 'c4870c84c910e8e4',
  tinted: '2a9c50218bd57d29',
  everySlot: '8d625f13e5af0475',
  unlit: 'c2f4be09abc549e7',
  customLit: 'b565c0183be022b0',
};

const graphDef = (materialId: string, graph: MaterialGraphLike): MaterialDefLike => ({ materialId, name: materialId, shader: 'standard', params: {}, textures: {}, graph, parameters: PARAMETERS });

async function compiledScene(graphs: Record<string, MaterialGraphLike>): Promise<{ renderer: WebGPURenderer; scene: THREE.Scene; meshes: Record<string, THREE.Mesh> }> {
  const tex = new THREE.DataTexture(new Uint8Array([200, 120, 60, 255]), 1, 1);
  tex.needsUpdate = true;
  const library = createMaterialLibrary({ loadTexture: async () => tex });
  library.setMaterials(Object.entries(graphs).map(([id, g]) => graphDef(id, g)));
  const scene = new THREE.Scene();
  const sun = new THREE.DirectionalLight('#ffffff', 1.5);
  scene.add(sun, new THREE.AmbientLight('#ffffff', 0.4));
  const meshes: Record<string, THREE.Mesh> = {};
  for (const id of Object.keys(graphs)) {
    const m = new THREE.Mesh(new THREE.SphereGeometry(1, 8, 6), new THREE.MeshStandardMaterial());
    scene.add(m);
    library.apply(m, { '*': id });
    meshes[id] = m;
  }
  // The texture arrives through a promise; the graphs recompile with it.
  for (let i = 0; i < 3; i++) await new Promise((r) => setTimeout(r, 0));
  const canvas = { style: {}, width: 1, height: 1, addEventListener() {}, removeEventListener() {}, getContext: () => null };
  const renderer = new WebGPURenderer({ canvas: canvas as unknown as HTMLCanvasElement });
  // No device here: report no optional features (the same answer for every build compared).
  (renderer as unknown as { hasFeature: () => boolean }).hasFeature = () => false;
  return { renderer, scene, meshes };
}

describe('graph materials without specular keep their programs', () => {
  it('the WGSL of graphs that connect no specular port is what it was', async () => {
    const { renderer, scene, meshes } = await compiledScene(GRAPHS);
    const now: Record<string, string> = {};
    for (const [id, m] of Object.entries(meshes)) now[id] = digestOf(wgslOf(renderer, scene, m));
    expect(now).toEqual(BEFORE);
    for (const m of Object.values(meshes)) expect((m.material as THREE.Material).type).not.toBe('MeshPhysicalNodeMaterial');
  });
});

describe('the PBR output\'s specular ports', () => {
  /** The plain graph with a constant into one or both specular ports. */
  const specular = (ports: { intensity?: number; color?: string }): MaterialGraphLike => ({
    nodes: [
      n('out', 'pbr'),
      ...(ports.intensity !== undefined ? [n('i', 'float', { value: ports.intensity })] : []),
      ...(ports.color !== undefined ? [n('c', 'color', { color: ports.color })] : []),
    ],
    edges: [...(ports.intensity !== undefined ? [e('a', 'i', 'value', 'out', 'specularIntensity')] : []), ...(ports.color !== undefined ? [e('b', 'c', 'rgb', 'out', 'specularColor')] : [])],
  });

  it('connected, either one makes a physical material that reads it; the other stays three\'s default', () => {
    const c = compileMaterialGraph({ graph: specular({ intensity: 0.6 }) }, ENV);
    expect(c.problems).toEqual([]);
    expect(c.slots.specularIntensity).not.toBeNull();
    expect(c.slots.specularColor).toBeNull();
    expect(graphNeedsPhysical(c)).toBe(true);
    const m = buildGraphMaterial(c, 'spec') as MeshPhysicalNodeMaterial;
    expect(m.type).toBe('MeshPhysicalNodeMaterial');
    expect(m.specularIntensityNode).toBe(c.slots.specularIntensity);
    expect(m.specularColorNode).toBeNull();
    // Nothing else of the physical model is switched on (no clearcoat, sheen, transmission… terms in its shader).
    expect([m.useClearcoat, m.useSheen, m.useIridescence, m.useAnisotropy, m.useTransmission, m.useDispersion]).toEqual([false, false, false, false, false, false]);
    const tinted = compileMaterialGraph({ graph: specular({ color: '#ff8000' }) }, ENV);
    expect(graphNeedsPhysical(tinted)).toBe(true);
    expect((buildGraphMaterial(tinted, 'tint') as MeshPhysicalNodeMaterial).specularColorNode).toBe(tinted.slots.specularColor);
  });

  it('unconnected (or under another output) they change nothing: a standard material', () => {
    const c = compileMaterialGraph({ graph: GRAPHS['everySlot']! }, ENV);
    expect([c.slots.specularIntensity, c.slots.specularColor, graphNeedsPhysical(c)]).toEqual([null, null, false]);
    expect(buildGraphMaterial(c, 'plain').type).toBe('MeshStandardNodeMaterial');
  });

  it('a connected port builds its own program (the physical model), one per graph', async () => {
    const { renderer, scene, meshes } = await compiledScene({ plain: GRAPHS['plain']!, spec: specular({ intensity: 0.6 }), both: specular({ intensity: 0.6, color: '#ff8000' }) });
    expect(meshes['spec']!.material).not.toBe(meshes['plain']!.material);
    expect((meshes['spec']!.material as THREE.Material).type).toBe('MeshPhysicalNodeMaterial');
    const plain = wgslOf(renderer, scene, meshes['plain']!);
    const spec = wgslOf(renderer, scene, meshes['spec']!);
    expect(digestOf(plain)).toBe(BEFORE['plain']);
    expect(spec).not.toBe(plain);
    // F0 is no longer the standard model's constant 0.04: the intensity scales it (and F90).
    expect(plain).toContain('SpecularColor = vec3<f32>( 0.04, 0.04, 0.04 );');
    expect(spec).not.toContain('SpecularColor = vec3<f32>( 0.04, 0.04, 0.04 );');
    expect(spec).toMatch(/SpecularF90 = mix\(/);
    expect(wgslOf(renderer, scene, meshes['both']!)).not.toBe(spec);
  });

  it('three reads a GLB\'s KHR_materials_specular into the same two values a graph maps', async () => {
    // What a Blender export with "Specular IOR Level" 0.3 writes (Skyforge's models): factor 0.6, a tinted colour.
    const gltf = {
      asset: { version: '2.0' },
      extensionsUsed: ['KHR_materials_specular'],
      materials: [{ name: 'painted', pbrMetallicRoughness: { baseColorFactor: [0.5, 0.5, 0.5, 1], metallicFactor: 0, roughnessFactor: 0.4 }, extensions: { KHR_materials_specular: { specularFactor: 0.6, specularColorFactor: [1, 0.9, 0.8] } } }],
    };
    const parsed = await new GLTFLoader().parseAsync(JSON.stringify(gltf), '');
    const glb = (await parsed.parser.getDependency('material', 0)) as THREE.MeshPhysicalMaterial;
    expect(glb.type).toBe('MeshPhysicalMaterial');
    expect(glb.specularIntensity).toBeCloseTo(0.6);
    expect(glb.specularColor.toArray()).toEqual([1, 0.9, 0.8]);
    // A graph that maps them (parameters a game sets from the file's values) draws the same F0: F0 0.04 × 0.6 = 0.024.
    const graph: MaterialGraphLike = {
      nodes: [n('out', 'pbr'), n('i', 'parameter', { key: 'specular' }), n('c', 'parameter', { key: 'specularTint' })],
      edges: [e('a', 'i', 'value', 'out', 'specularIntensity'), e('b', 'c', 'value', 'out', 'specularColor')],
    };
    const parameters: MaterialDefLike['parameters'] = [
      { key: 'specular', type: 'float', default: glb.specularIntensity },
      { key: 'specularTint', type: 'color', default: `#${glb.specularColor.getHexString(THREE.LinearSRGBColorSpace)}` },
    ];
    const c = compileMaterialGraph({ graph, parameters }, ENV);
    expect(c.problems).toEqual([]);
    expect(buildGraphMaterial(c, 'mapped').type).toBe('MeshPhysicalNodeMaterial');
  });
});
