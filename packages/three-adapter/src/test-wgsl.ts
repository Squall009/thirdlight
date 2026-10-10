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
import { WebGPURenderer } from 'three/webgpu';

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
