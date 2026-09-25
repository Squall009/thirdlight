/**
 * Phase 17.2: the neutral shader test scene (browser code, bundled by
 * `shader-parity.e2e.ts` with esbuild). One case per page load:
 *
 *   index.html?backend=webgl2|webgpu|auto&case=<name>[&control=1]
 *
 * Every case draws one shader type of the project material library (or one
 * per-mesh look) through the real three-adapter code — `createRenderer`,
 * `createMaterialLibrary`, `applyLightmap`, `setSelectionHighlight`,
 * `setEmissiveLook` — with fixed time, wind, camera and lights, so the WebGL
 * reference images (drawn by the archived WebGLRenderer path before the
 * switch-over, phase 17.2) and the node-material renders (WebGPURenderer on
 * WebGL 2 / WebGPU) can be compared pixel by pixel. Textures are generated
 * here (no files, no fetch). `control=1` draws the cases without their shader
 * nodes (foliage, kit and water as plain standard materials, lightmap copies
 * keeping the ambient light) — what WebGPURenderer drew while the archived
 * onBeforeCompile hooks were silently ignored (phase 17.0).
 *
 * When done, `window.__shaderCase` holds { ok, backend, reason, error? };
 * with `debug=1` on WebGPURenderer, `window.__shader` holds the generated
 * shader code of the first mesh (three's `renderer.debug.getShaderAsync`).
 */
import * as THREE from 'three';

import {
  addBoxLightmapUv,
  applyLightmap,
  createMaterialLibrary,
  createRenderer,
  setEmissiveLook,
  setSelectionHighlight,
  type MaterialDefLike,
  type RendererPreference,
} from '@thirdlight/three-adapter';

export const SIZE = 256;

const q = new URLSearchParams(location.search);
const backend = (q.get('backend') ?? 'auto') as RendererPreference;
const which = q.get('case') ?? 'standard';
const control = q.get('control') === '1';

// ---- generated textures (sRGB colour data / linear normal data) ----------------------

function dataTexture(w: number, h: number, fill: (u: number, v: number) => [number, number, number, number]): THREE.DataTexture {
  const data = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const c = fill((x + 0.5) / w, (y + 0.5) / h);
      data.set(c.map((v) => Math.max(0, Math.min(255, Math.round(v)))), (y * w + x) * 4);
    }
  }
  const t = new THREE.DataTexture(data, w, h, THREE.RGBAFormat, THREE.UnsignedByteType);
  // Linear filtering without mipmaps: mipmap generation differs between backends.
  t.magFilter = THREE.LinearFilter;
  t.minFilter = THREE.LinearFilter;
  t.generateMipmaps = false;
  t.needsUpdate = true;
  return t;
}
const encodeNormal = (x: number, y: number, z: number): [number, number, number, number] => {
  const l = Math.hypot(x, y, z) || 1;
  return [((x / l) * 0.5 + 0.5) * 255, ((y / l) * 0.5 + 0.5) * 255, ((z / l) * 0.5 + 0.5) * 255, 255];
};
const TEXTURES: Record<string, () => THREE.Texture> = {
  checker: () => dataTexture(64, 64, (u, v) => ((Math.floor(u * 8) + Math.floor(v * 8)) % 2 === 0 ? [235, 225, 205, 255] : [60, 90, 170, 255])),
  // A ramp across U with stripes: a UV shift along X shows as a colour change.
  ramp: () => dataTexture(64, 64, (u) => (Math.floor(u * 16) % 4 === 0 ? [30, 30, 30, 255] : [40 + u * 210, 150, 250 - u * 210, 255])),
  bumps: () => dataTexture(64, 64, (u, v) => encodeNormal(Math.sin(u * Math.PI * 8) * 0.6, Math.cos(v * Math.PI * 8) * 0.6, 1)),
  macro: () => dataTexture(64, 64, (u, v) => encodeNormal(Math.sin(u * Math.PI * 2) * 0.8, Math.sin(v * Math.PI * 2) * 0.5, 1)),
  // A lightmap atlas in the box UV1 layout (3 × 2 cells: +x −x +y / −y +z −z): warm light,
  // a dark round "shadow" on the top (+y) cell, a green +x cell and a blue +z cell.
  atlas: () =>
    dataTexture(96, 64, (u, v) => {
      const col = Math.min(2, Math.floor(u * 3));
      const row = Math.min(1, Math.floor(v * 2));
      const shadow = col === 2 && row === 0 && Math.hypot(u - 0.8, v - 0.2) < 0.09 ? 0.2 : 1;
      const tint = col === 0 && row === 0 ? [0.7, 1, 0.7] : col === 1 && row === 1 ? [0.7, 0.8, 1.1] : [1, 1, 1];
      return [210 * shadow * tint[0]!, 185 * shadow * tint[1]!, 150 * shadow * tint[2]!, 255];
    }),
};

// ---- the scene -------------------------------------------------------------------

const canvas = document.querySelector('canvas') as HTMLCanvasElement;
const scene = new THREE.Scene();
scene.background = new THREE.Color('#3a4048');
const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 50);
camera.position.set(0, 2.4, 5.2);
camera.lookAt(0, 0.4, 0);
const sun = new THREE.DirectionalLight('#ffffff', 2.2);
sun.position.set(3, 5, 4);
const ambient = new THREE.AmbientLight('#8090a8', 0.7);
scene.add(sun, ambient);

const library = createMaterialLibrary({ loadTexture: async (id) => (TEXTURES[id] ? TEXTURES[id]() : null) });
library.setWind({ direction: [1, 0.3], strength: 3, gust: 1, gustFrequency: 0.3, turbulence: 0.5 });
library.tick(1.7);

const src = (): THREE.MeshStandardMaterial => new THREE.MeshStandardMaterial({ name: 'src', color: '#ffffff' });
/** The control strips the shader types that need their own nodes (what an ignored hook drew). */
const NODE_SHADERS: readonly MaterialDefLike['shader'][] = ['foliage', 'kit', 'water'];
const def = (materialId: string, shader: MaterialDefLike['shader'], params: MaterialDefLike['params'], textures: MaterialDefLike['textures'] = {}): MaterialDefLike => ({
  materialId,
  name: materialId,
  shader: control && NODE_SHADERS.includes(shader) ? 'standard' : shader,
  params,
  textures,
});
const box = (s = 1): THREE.BoxGeometry => {
  const g = new THREE.BoxGeometry(s, s, s);
  addBoxLightmapUv(g);
  return g;
};
const put = <T extends THREE.Object3D>(o: T, x: number, y: number, z: number, ry = 0): T => {
  o.position.set(x, y, z);
  o.rotation.y = ry;
  scene.add(o);
  return o;
};

/** A grass-blade strip, root at y = 0, COLOR_0 as wind data (R bend root→tip, G phase, B flutter, A thinness). */
function blade(phase: number): THREE.BufferGeometry {
  const g = new THREE.PlaneGeometry(0.22, 1.6, 1, 8);
  g.translate(0, 0.8, 0);
  const pos = g.getAttribute('position');
  const colour = new Float32Array(pos.count * 4);
  for (let i = 0; i < pos.count; i++) colour.set([pos.getY(i) / 1.6, phase, pos.getY(i) / 1.6, 0.6], i * 4);
  g.setAttribute('color', new THREE.BufferAttribute(colour, 4));
  return g;
}

const settle = async (): Promise<void> => {
  for (let i = 0; i < 3; i++) await new Promise((r) => setTimeout(r, 30));
};

const cases: Record<string, () => void | Promise<void>> = {
  standard() {
    library.setMaterials([
      def('std-tex', 'standard', { color: '#e0a060', roughness: 0.45, metalness: 0.1, tiling: [2, 2] }, { map: 'checker', normalMap: 'bumps' }),
      def('std-plain', 'standard', { color: '#5aa0d8', roughness: 0.3, metalness: 0.2, emissive: '#200808', emissiveIntensity: 1 }),
    ]);
    const a = put(new THREE.Mesh(box(1.3), src()), -0.9, 0.5, 0, 0.6);
    const b = put(new THREE.Mesh(new THREE.SphereGeometry(0.7, 32, 16), src()), 1.0, 0.6, 0);
    library.apply(a, { '*': 'std-tex' });
    library.apply(b, { '*': 'std-plain' });
  },
  foliage() {
    library.setMaterials([def('grass', 'foliage', { color: '#4c9a3c', windBend: 3, windFlutter: 2, subsurface: 0.5, roughness: 0.8 })]);
    for (let i = 0; i < 5; i++) library.apply(put(new THREE.Mesh(blade(i * 0.17), src()), -1.6 + i * 0.8, -0.4, 0.4, 0.3 * i), { '*': 'grass' });
    // The same material on instances (the instancing path of the vertex displacement).
    const inst = new THREE.InstancedMesh(blade(0.5), src(), 4);
    const m = new THREE.Matrix4();
    for (let i = 0; i < 4; i++) inst.setMatrixAt(i, m.compose(new THREE.Vector3(-1.2 + i * 0.8, -0.4, -0.8), new THREE.Quaternion().setFromEuler(new THREE.Euler(0, 0.5 * i, 0)), new THREE.Vector3(1, 0.8 + 0.1 * i, 1)));
    library.apply(put(inst, 0, 0, 0), { '*': 'grass' });
  },
  kit() {
    library.setMaterials([def('kit', 'kit', { uvPeriod: 2, macroNormalScale: 1.5, roughness: 0.6 }, { map: 'ramp', normalMap: 'bumps', macroNormalMap: 'macro' })]);
    // Separate pieces along X: the texture continues across them (world-X UV).
    for (let i = 0; i < 4; i++) library.apply(put(new THREE.Mesh(box(0.8), src()), -1.35 + i * 0.9, 0.9, 0.3), { '*': 'kit' });
    // 1100 instances: more than a uniform buffer holds on either backend (three's attribute path);
    // the first 4 are the visible row, the rest sit far below the view.
    const inst = new THREE.InstancedMesh(box(0.8), src(), 1100);
    const m = new THREE.Matrix4();
    for (let i = 0; i < 1100; i++) inst.setMatrixAt(i, i < 4 ? m.makeTranslation(-1.35 + i * 0.9, 0, -0.2) : m.makeTranslation(i * 0.01, -100, 0));
    inst.frustumCulled = false;
    library.apply(put(inst, 0, 0, 0), { '*': 'kit' });
  },
  unlit() {
    library.setMaterials([
      def('flat', 'unlit', { color: '#f0d070' }, { map: 'checker' }),
      def('glass', 'unlit', { color: '#60e0c0', alphaMode: 'blend', opacity: 0.55, doubleSided: true }),
    ]);
    library.apply(put(new THREE.Mesh(box(1.3), src()), -0.8, 0.5, 0, 0.7), { '*': 'flat' });
    library.apply(put(new THREE.Mesh(new THREE.SphereGeometry(0.75, 32, 16), src()), 0.9, 0.6, 0.3), { '*': 'glass' });
  },
  water() {
    library.setMaterials([
      def('water', 'water', { flow: [0.05, 0.02], waveScale: 2, fresnel: 3, shallowColor: '#4fb3c9', color: '#1d5f8a', opacity: 0.8 }, { normalMap: 'bumps' }),
      def('rock', 'standard', { color: '#a08870', roughness: 0.9 }),
    ]);
    library.tick(2.3);
    const plane = new THREE.Mesh(new THREE.PlaneGeometry(5, 4), src());
    plane.rotation.x = -Math.PI / 2;
    library.apply(put(plane, 0, 0, 0), { '*': 'water' });
    library.apply(put(new THREE.Mesh(box(0.9), src()), 0.4, 0, 0.3, 0.5), { '*': 'rock' });
  },
  async lightmap() {
    ambient.intensity = 1.4; // a strong ambient: the no-ambient copies must drop it
    library.setMaterials([def('lm-std', 'standard', { color: '#c8c8c8', roughness: 0.7 }), def('lm-kit', 'kit', { uvPeriod: 2, roughness: 0.7 }, { map: 'ramp' })]);
    const atlas = TEXTURES['atlas']!();
    const ground = put(new THREE.Mesh(box(1), new THREE.MeshLambertMaterial({ color: '#b0b0b0' })), 0, -0.3, 0);
    ground.scale.set(4.2, 0.3, 3);
    const cube = put(new THREE.Mesh(box(0.9), src()), -1.1, 0.45, 0.2, 0.4);
    library.apply(cube, { '*': 'lm-std' });
    const piece = put(new THREE.Mesh(box(0.9), src()), 1.1, 0.45, 0.2, -0.4);
    library.apply(piece, { '*': 'lm-kit' });
    await settle(); // the project material's texture first (the lightmapped copy clones it)
    // A plain (Lambert) ground whose bake holds the ambient light.
    applyLightmap(ground, atlas, [1, 1, 0, 0], 1.6, { ignoreAmbient: !control });
    // A project material cube whose bake keeps ambient realtime (range 2.2).
    applyLightmap(cube, atlas, [1, 1, 0, 0], 2.2, { ignoreAmbient: false });
    // A kit piece (world-X UV) with a lightmap and no ambient.
    applyLightmap(piece, atlas, [1, 1, 0, 0], 1.2, { ignoreAmbient: !control });
  },
  highlight() {
    // The Scene view's box: its own Lambert material, emissive-tinted while selected.
    const a = put(new THREE.Mesh(box(1.2), new THREE.MeshLambertMaterial({ color: '#8fa0b8' })), -0.9, 0.5, 0, 0.5);
    put(new THREE.Mesh(box(1.2), new THREE.MeshLambertMaterial({ color: '#8fa0b8' })), 0.9, 0.5, 0, 0.5);
    setSelectionHighlight(a.material, true);
  },
  checkpoint() {
    // Three boxes share one file material (like placements of one model), so
    // the library gives them one shared project material; the middle one is the active checkpoint.
    library.setMaterials([def('pad', 'standard', { color: '#9aa0a8', roughness: 0.5 })]);
    const file = src();
    const pads = [-1.4, 0, 1.4].map((x) => {
      const p = put(new THREE.Mesh(box(1), file), x, 0.5, 0, 0.4);
      library.apply(p, { '*': 'pad' });
      return p;
    });
    const shared = pads[0]!.material as THREE.MeshStandardMaterial;
    setEmissiveLook(pads[1]!, { emissive: '#ffb030', emissiveIntensity: 1.5 });
    // The shared material is untouched (9.4 rule): the other pads do not glow.
    if (shared.emissive.getHex() !== 0 || pads[2]!.material !== shared || pads[1]!.material === shared) throw new Error('the checkpoint glow touched the shared material');
  },
};

async function main(): Promise<void> {
  const handle = createRenderer({ canvas, preference: backend, source: 'url', antialias: false, clearColor: 0x000000, clearAlpha: 1 });
  const ok = await handle.whenReady();
  const info = handle.info();
  if (!ok) throw new Error(`renderer not ready: ${info.reason}`);
  const renderer = handle.current()!;
  renderer.setPixelRatio(1);
  renderer.setSize(SIZE, SIZE, false);
  const make = cases[which];
  if (make === undefined) throw new Error(`unknown case ${which}`);
  await make();
  // Textures arrive through promises: let them land, then draw twice (first-use compiles).
  await settle();
  renderer.render(scene, camera);
  await new Promise((r) => setTimeout(r, 60));
  renderer.render(scene, camera);
  await new Promise((r) => requestAnimationFrame(() => r(null)));
  renderer.render(scene, camera);
  if (q.get('debug') === '1' && typeof (renderer as { debug?: { getShaderAsync?: unknown } }).debug?.getShaderAsync === 'function') {
    let mesh: THREE.Object3D | null = null;
    scene.traverse((o) => {
      if (mesh === null && (o as THREE.Mesh).isMesh) mesh = o;
    });
    (window as unknown as { __shader: unknown }).__shader = await (renderer.debug as unknown as { getShaderAsync(s: unknown, c: unknown, o: unknown): Promise<unknown> }).getShaderAsync(scene, camera, mesh);
  }
  (window as unknown as { __shaderCase: unknown }).__shaderCase = { ok: true, backend: info.backend, reason: info.reason };
}

main().catch((e: unknown) => {
  (window as unknown as { __shaderCase: unknown }).__shaderCase = { ok: false, error: e instanceof Error ? e.message : String(e) };
});
