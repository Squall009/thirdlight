/**
 * Phase 18.3: the material-graph render harness (browser code, bundled by
 * `material-graph-render.e2e.ts` with esbuild). One case per page load:
 *
 *   index.html?backend=webgl2|webgpu&case=kinds|values
 *
 * Graph materials go through the real three-adapter code
 * (`createRenderer`, `createMaterialLibrary` with graph definitions), with a
 * fixed camera, lights, wind and time, in a neutral scene:
 *
 * - `kinds`: one sphere per catalogue node kind, each wearing a graph whose
 *   node feeds the emissive and (scaled down) a vertex offset — every kind
 *   must compile into a working shader on the backend;
 * - `values`: known pictures — an unlit constant colour, an unlit nearest-
 *   sampled texture, one shared material with a public parameter overridden
 *   on one object, a fresnel emissive rim and a vertex offset.
 *
 * `window.__graphCase` = { ok, backend, probes: {name: [x, y]}, sharedMaterial?, problems? }.
 */
import * as THREE from 'three';

import { COMPILER_NODES, createMaterialLibrary, createRenderer, type MaterialDefLike, type MaterialGraphLike, type RendererPreference } from '@thirdlight/three-adapter';

export const SIZE = 256;

const q = new URLSearchParams(location.search);
const backend = (q.get('backend') ?? 'auto') as RendererPreference;
const which = q.get('case') ?? 'kinds';

function dataTexture(w: number, h: number, fill: (x: number, y: number) => [number, number, number, number]): THREE.DataTexture {
  const data = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) data.set(fill(x, y), (y * w + x) * 4);
  const t = new THREE.DataTexture(data, w, h, THREE.RGBAFormat, THREE.UnsignedByteType);
  t.magFilter = THREE.LinearFilter;
  t.minFilter = THREE.LinearFilter;
  t.generateMipmaps = false;
  t.needsUpdate = true;
  return t;
}
const TEXTURES: Record<string, () => THREE.Texture> = {
  // 2 × 2 checker: red / blue quadrants.
  checker: () => dataTexture(2, 2, (x, y) => ((x + y) % 2 === 0 ? [230, 40, 40, 255] : [40, 60, 230, 255])),
  flatNormal: () => dataTexture(2, 2, () => [128, 128, 255, 255]),
};

const canvas = document.querySelector('canvas') as HTMLCanvasElement;
const scene = new THREE.Scene();
scene.background = new THREE.Color('#202428');
const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 100);
camera.position.set(0, 0, 10);
camera.lookAt(0, 0, 0);
const sun = new THREE.DirectionalLight('#ffffff', 1.5);
sun.position.set(2, 4, 6);
scene.add(sun, new THREE.AmbientLight('#ffffff', 0.4));

const library = createMaterialLibrary({ loadTexture: async (id) => (TEXTURES[id] ? TEXTURES[id]() : null) });
library.setWind({ direction: [1, 0], strength: 1, gust: 0.5, gustFrequency: 0.3, turbulence: 0.5 });
library.tick(1.3);

const graphDef = (materialId: string, graph: MaterialGraphLike, parameters: MaterialDefLike['parameters'] = []): MaterialDefLike => ({ materialId, name: materialId, shader: 'standard', params: {}, textures: {}, graph, parameters });
const src = (): THREE.MeshStandardMaterial => new THREE.MeshStandardMaterial({ color: '#808080' });
const probes: Record<string, [number, number]> = {};
const probe = (name: string, p: THREE.Vector3): void => {
  const v = p.clone().project(camera);
  probes[name] = [Math.round((v.x * 0.5 + 0.5) * SIZE), Math.round((-v.y * 0.5 + 0.5) * SIZE)];
};
let extra: Record<string, unknown> = {};

/** Node kinds fed into the emissive (value outputs) — outputs, interfaces and calls are covered elsewhere. */
const SKIP = new Set(['pbr', 'unlit', 'vertexOffset', 'functionInput', 'functionOutput', 'call', 'parameter']);
const SAMPLING = new Set(['sampleTexture', 'normalMap', 'triplanar']);

const cases: Record<string, () => void> = {
  kinds() {
    const kinds = Object.keys(COMPILER_NODES).filter((t) => !SKIP.has(t));
    const defs: MaterialDefLike[] = [];
    const cols = 8;
    kinds.forEach((type, i) => {
      const out = COMPILER_NODES[type]!.outputs[0]!;
      defs.push(
        graphDef(`k-${type}`, {
          nodes: [
            { id: 'out', type: 'pbr', position: [0, 0] },
            { id: 'vo', type: 'vertexOffset', position: [0, 0] },
            { id: 'x', type, position: [0, 0], ...(SAMPLING.has(type) ? { data: { texture: 'checker' } } : {}) },
            { id: 'k', type: 'float', position: [0, 0], data: { value: 0.01 } },
            { id: 'm', type: 'multiply', position: [0, 0] },
            { id: 'e', type: 'multiply', position: [0, 0] },
            { id: 'ke', type: 'float', position: [0, 0], data: { value: 0.3 } },
          ],
          edges: [
            { id: 'a', from: { node: 'x', port: out.id }, to: { node: 'm', port: 'a' } },
            { id: 'b', from: { node: 'k', port: 'value' }, to: { node: 'm', port: 'b' } },
            { id: 'c', from: { node: 'm', port: 'out' }, to: { node: 'vo', port: 'offset' } },
            { id: 'd', from: { node: 'x', port: out.id }, to: { node: 'e', port: 'a' } },
            { id: 'f', from: { node: 'ke', port: 'value' }, to: { node: 'e', port: 'b' } },
            { id: 'g', from: { node: 'e', port: 'out' }, to: { node: 'out', port: 'emissive' } },
          ],
        }),
      );
    });
    library.setMaterials(defs);
    kinds.forEach((type, i) => {
      const x = ((i % cols) - (cols - 1) / 2) * 1.0;
      const y = ((cols - 1) / 2 - Math.floor(i / cols)) * 1.0;
      const s = new THREE.Mesh(new THREE.SphereGeometry(0.38, 16, 12), src());
      s.position.set(x, y, 0);
      scene.add(s);
      library.apply(s, { '*': `k-${type}` });
      probe(type, s.position);
    });
    extra = { kinds, problems: Object.fromEntries(kinds.map((t) => [t, library.graphProblems(`k-${t}`)])) };
  },
  values() {
    const unlitColor: MaterialGraphLike = {
      nodes: [
        { id: 'out', type: 'unlit', position: [0, 0] },
        { id: 'c', type: 'color', position: [0, 0], data: { color: '#ff8000' } },
      ],
      edges: [{ id: 'a', from: { node: 'c', port: 'rgb' }, to: { node: 'out', port: 'color' } }],
    };
    const unlitTex: MaterialGraphLike = {
      nodes: [
        { id: 'out', type: 'unlit', position: [0, 0] },
        { id: 's', type: 'sampleTexture', position: [0, 0], data: { texture: 'checker', filter: 'nearest' } },
      ],
      edges: [{ id: 'a', from: { node: 's', port: 'rgb' }, to: { node: 'out', port: 'color' } }],
    };
    const tinted: MaterialGraphLike = {
      nodes: [
        { id: 'out', type: 'unlit', position: [0, 0] },
        { id: 'p', type: 'parameter', position: [0, 0], data: { key: 'tint' } },
      ],
      edges: [{ id: 'a', from: { node: 'p', port: 'value' }, to: { node: 'out', port: 'color' } }],
    };
    const rim: MaterialGraphLike = {
      nodes: [
        { id: 'out', type: 'pbr', position: [0, 0] },
        { id: 'black', type: 'color', position: [0, 0], data: { color: '#000000' } },
        { id: 'f', type: 'fresnel', position: [0, 0] },
        { id: 'w', type: 'color', position: [0, 0], data: { color: '#ffffff' } },
        { id: 'm', type: 'multiply', position: [0, 0] },
      ],
      edges: [
        { id: 'a', from: { node: 'black', port: 'rgb' }, to: { node: 'out', port: 'baseColor' } },
        { id: 'b', from: { node: 'f', port: 'out' }, to: { node: 'm', port: 'a' } },
        { id: 'c', from: { node: 'w', port: 'rgb' }, to: { node: 'm', port: 'b' } },
        { id: 'd', from: { node: 'm', port: 'out' }, to: { node: 'out', port: 'emissive' } },
      ],
    };
    const lifted: MaterialGraphLike = {
      nodes: [
        { id: 'out', type: 'unlit', position: [0, 0] },
        { id: 'c', type: 'color', position: [0, 0], data: { color: '#ffffff' } },
        { id: 'vo', type: 'vertexOffset', position: [0, 0], data: { space: 'world' } },
        { id: 'v', type: 'vec3', position: [0, 0], data: { value: [0, 1.2, 0] } },
      ],
      edges: [
        { id: 'a', from: { node: 'c', port: 'rgb' }, to: { node: 'out', port: 'color' } },
        { id: 'b', from: { node: 'v', port: 'value' }, to: { node: 'vo', port: 'offset' } },
      ],
    };
    library.setMaterials([
      graphDef('unlit-color', unlitColor),
      graphDef('unlit-tex', unlitTex),
      graphDef('tinted', tinted, [{ key: 'tint', type: 'color', default: '#00ff00' }]),
      graphDef('rim', rim),
      graphDef('lifted', lifted),
    ]);
    const quad = (x: number, y: number, id: string, overrides?: Record<string, Record<string, unknown>>): THREE.Mesh => {
      const m = new THREE.Mesh(new THREE.PlaneGeometry(1.6, 1.6), src());
      m.position.set(x, y, 0);
      scene.add(m);
      library.apply(m, { '*': id }, (overrides ?? null) as never);
      return m;
    };
    quad(-2.6, 2.2, 'unlit-color');
    probe('color', new THREE.Vector3(-2.6, 2.2, 0));
    quad(0, 2.2, 'unlit-tex');
    // The 2 × 2 checker: the quad's top-left quadrant is texel (0, 0) (UV v = 1 at the top reads row 1 with flipY off).
    probe('texTL', new THREE.Vector3(-0.4, 2.6, 0));
    probe('texTR', new THREE.Vector3(0.4, 2.6, 0));
    const a = quad(-2.6, -0.2, 'tinted');
    const b = quad(0, -0.2, 'tinted', { tinted: { tint: '#0000ff' } });
    probe('tintDefault', new THREE.Vector3(-2.6, -0.2, 0));
    probe('tintOverride', new THREE.Vector3(0, -0.2, 0));
    extra = { sharedMaterial: a.material === b.material };
    const sphere = new THREE.Mesh(new THREE.SphereGeometry(1, 48, 32), src());
    sphere.position.set(2.7, 0.9, 0);
    scene.add(sphere);
    library.apply(sphere, { '*': 'rim' });
    probe('rimCentre', sphere.position);
    probe('rimEdge', new THREE.Vector3(2.7 - 0.97, 0.9, 0));
    // A quad whose vertices are lifted 1.2 m up in world space: it draws where it was not placed.
    quad(0, -3.4, 'lifted');
    probe('liftedAt', new THREE.Vector3(0, -3.4 + 1.2, 0));
    probe('liftedFrom', new THREE.Vector3(0, -3.4 - 0.6, 0));
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
  make();
  // Textures arrive through promises (the graphs recompile when they land), then draw a few frames.
  for (let i = 0; i < 3; i++) await new Promise((r) => setTimeout(r, 30));
  renderer.render(scene, camera);
  await new Promise((r) => setTimeout(r, 60));
  renderer.render(scene, camera);
  await new Promise((r) => requestAnimationFrame(() => r(null)));
  renderer.render(scene, camera);
  (window as unknown as { __graphCase: unknown }).__graphCase = { ok: true, backend: info.backend, probes, ...extra };
}

main().catch((e: unknown) => {
  (window as unknown as { __graphCase: unknown }).__graphCase = { ok: false, error: e instanceof Error ? e.message : String(e) };
});
