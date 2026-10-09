/**
 * The material-graph render harness (browser code, bundled by
 * `material-graph-render.e2e.ts` with esbuild). One case per page load:
 *
 *   index.html?backend=webgl2|webgpu&case=kinds|values|lit
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
 *   on one object, a fresnel emissive rim and a vertex offset;
 * - `lit`: Custom-lit outputs reading the lighting inputs —
 *   two N·L bands, the shadow input, the diffuse light with a point light,
 *   the main light's colour, fog.
 *
 * `window.__graphCase` = { ok, backend, probes: {name: [x, y]}, sharedMaterial?, problems? }.
 */
import * as THREE from 'three';

import { COMPILER_NODES, createMaterialLibrary, LIGHTING_TYPES, lightmappedMaterial, mainLightIndex, createRenderer, type MaterialDefLike, type MaterialGraphLike, type RendererPreference } from '@thirdlight/three-adapter';

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
let renderer: THREE.WebGLRenderer | null = null;

/** Node kinds fed into the emissive (value outputs) — outputs, interfaces and calls are covered elsewhere. */
const SKIP = new Set(['pbr', 'unlit', 'customLit', 'vertexOffset', 'functionInput', 'functionOutput', 'call', 'parameter']);
const SAMPLING = new Set(['sampleTexture', 'normalMap', 'triplanar']);
/** Kinds that exist only for pixels: in a vertex offset they read a stand-in (the scene depth reads "far", metres
 * away), which would push the sphere out of view, so only their emissive use is drawn. */
const PIXEL_ONLY = new Set(['sceneDepth']);

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
            // Lighting inputs read light under a Custom-lit output.
            { id: 'out', type: LIGHTING_TYPES.has(type) ? 'customLit' : 'pbr', position: [0, 0] },
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
            ...(PIXEL_ONLY.has(type) ? [] : [{ id: 'c', from: { node: 'm', port: 'out' }, to: { node: 'vo', port: 'offset' } }]),
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
  /**
   * Custom-lit outputs reading the lighting inputs (neutral
   * greys, one sun casting shadows, a brighter red fill that casts none).
   */
  lit() {
    renderer!.shadowMap.enabled = true;
    sun.castShadow = true;
    sun.shadow.mapSize.set(1024, 1024);
    // Brighter than the sun (colour luminance × intensity 1.9 vs 1.5) but casting no shadow: the main light stays
    // the sun. It lights from behind-left, so no probed face sees it.
    const fill = new THREE.DirectionalLight('#ff8080', 5);
    fill.position.set(-6, 0, -4);
    scene.add(fill);
    scene.fog = new THREE.Fog('#8040c0', 12, 60);
    const e = (id: string, from: string, fp: string, to: string, tp: string) => ({ id, from: { node: from, port: fp }, to: { node: to, port: tp } });
    const n = (id: string, type: string, data?: Record<string, unknown>) => ({ id, type, position: [0, 0] as [number, number], ...(data !== undefined ? { data } : {}) });
    // Two bands: step(0.5, N·L) picks dark or light (the sun is in front, so the edge at N·L = 0.5 crosses the visible half).
    const bands: MaterialGraphLike = {
      nodes: [n('out', 'customLit'), n('main', 'mainLight'), n('st', 'step', { type: 'float' }), n('dark', 'color', { color: '#303030' }), n('lite', 'color', { color: '#d0d0d0' }), n('mix', 'lerp'), n('zero', 'float', { value: 0.5 })],
      edges: [e('z', 'zero', 'value', 'st', 'edge'), e('a', 'main', 'ndotl', 'st', 'x'), e('b', 'dark', 'rgb', 'mix', 'a'), e('c', 'lite', 'rgb', 'mix', 'b'), e('d', 'st', 'out', 'mix', 't'), e('f', 'mix', 'out', 'out', 'color')],
    };
    // The shadow input picks dark (shadowed) or light.
    const shadowed: MaterialGraphLike = {
      nodes: [n('out', 'customLit'), n('sh', 'lightShadow'), n('dark', 'color', { color: '#303030' }), n('lite', 'color', { color: '#d0d0d0' }), n('mix', 'lerp')],
      edges: [e('a', 'sh', 'shadow', 'mix', 't'), e('b', 'dark', 'rgb', 'mix', 'a'), e('c', 'lite', 'rgb', 'mix', 'b'), e('f', 'mix', 'out', 'out', 'color')],
    };
    // A white surface lit by everything (the accumulated diffuse light).
    const diffuse: MaterialGraphLike = { nodes: [n('out', 'customLit'), n('d', 'diffuseLight')], edges: [e('a', 'd', 'total', 'out', 'color')] };
    // The main light's colour as it is.
    const mainColour: MaterialGraphLike = { nodes: [n('out', 'customLit'), n('m', 'mainLight')], edges: [e('a', 'm', 'color', 'out', 'color')] };
    // A constant colour (the fog must still apply).
    const flat: MaterialGraphLike = { nodes: [n('out', 'customLit'), n('c', 'color', { color: '#00ff00' })], edges: [e('a', 'c', 'rgb', 'out', 'color')] };
    // The ambient term and the lightmap term as they are.
    const ambientOut: MaterialGraphLike = { nodes: [n('out', 'customLit'), n('a', 'ambientLight')], edges: [e('a', 'a', 'ambient', 'out', 'color')] };
    const lightmapOut: MaterialGraphLike = { nodes: [n('out', 'customLit'), n('a', 'ambientLight')], edges: [e('a', 'a', 'lightmap', 'out', 'color')] };
    library.setMaterials([graphDef('bands', bands), graphDef('shadowed', shadowed), graphDef('diffuse', diffuse), graphDef('main-colour', mainColour), graphDef('flat', flat), graphDef('ambient-out', ambientOut), graphDef('lightmap-out', lightmapOut)]);
    const mesh = (g: THREE.BufferGeometry, id: string | null, at: THREE.Vector3, o: { cast?: boolean; receive?: boolean } = {}): THREE.Mesh => {
      const m = new THREE.Mesh(g, src());
      m.position.copy(at);
      m.castShadow = o.cast ?? false;
      m.receiveShadow = o.receive ?? false;
      scene.add(m);
      if (id !== null) library.apply(m, { '*': id });
      return m;
    };
    // The banded sphere: towards the sun vs away from it.
    const sc = new THREE.Vector3(-2.2, 1.9, 0);
    const r = 1.3;
    mesh(new THREE.SphereGeometry(r, 64, 48), 'bands', sc);
    const toSun = sun.position.clone().normalize();
    probe('bandLit', sc.clone().addScaledVector(toSun, r * 0.98));
    probe('bandDark', sc.clone().addScaledVector(new THREE.Vector3(-0.75, -0.55, 0.37).normalize(), r * 0.98));
    // Sphere pixels (a grid inside its outline) for the "only two tones" check.
    const disc: [number, number][] = [];
    for (let dy = -0.8; dy <= 0.8; dy += 0.1) for (let dx = -0.8; dx <= 0.8; dx += 0.1) {
      if (dx * dx + dy * dy > 0.64) continue;
      const z = Math.sqrt(1 - dx * dx - dy * dy);
      const v = sc.clone().add(new THREE.Vector3(dx, dy, z).multiplyScalar(r)).project(camera);
      disc.push([Math.round((v.x * 0.5 + 0.5) * SIZE), Math.round((-v.y * 0.5 + 0.5) * SIZE)]);
    }
    // The shadow floor (a wall facing the camera, 1 m behind), with a box between it and the sun.
    mesh(new THREE.PlaneGeometry(5, 3.4), 'shadowed', new THREE.Vector3(-1.5, -2.3, -1), { receive: true });
    const caster = new THREE.Vector3(-1.2, -1.3, 0.5);
    mesh(new THREE.BoxGeometry(0.7, 0.7, 0.7), null, caster, { cast: true });
    // The sun's ray through the caster reaches the wall at z = -1.
    const hit = caster.clone().addScaledVector(toSun, -(caster.z + 1) / toSun.z);
    probe('floorShadow', hit);
    probe('floorLit', new THREE.Vector3(hit.x - 1.6, hit.y, -1));
    // Two white diffuse boxes; a warm point light (limited range) sits in front of one only.
    mesh(new THREE.BoxGeometry(0.9, 0.9, 0.9), 'diffuse', new THREE.Vector3(1.0, 2.3, 0));
    mesh(new THREE.BoxGeometry(0.9, 0.9, 0.9), 'diffuse', new THREE.Vector3(3.0, 2.3, 0));
    const glow = new THREE.PointLight('#ffa040', 1.2, 1.6, 2);
    glow.position.set(1.0, 2.3, 1.1);
    scene.add(glow);
    probe('boxGlow', new THREE.Vector3(1.0, 2.3, 0.45));
    probe('boxPlain', new THREE.Vector3(3.0, 2.3, 0.45));
    // The main light's colour on a quad facing the camera.
    const q = new THREE.PlaneGeometry(0.8, 0.8);
    mesh(q, 'main-colour', new THREE.Vector3(1.9, 0.6, 0));
    probe('mainColour', new THREE.Vector3(1.9, 0.6, 0));
    // Fog: the same constant colour near (no fog before 12 m) and far (about 55 m away).
    mesh(new THREE.PlaneGeometry(0.9, 0.9), 'flat', new THREE.Vector3(2.4, -1.4, 0));
    probe('fogNear', new THREE.Vector3(2.4, -1.4, 0));
    const far = mesh(new THREE.PlaneGeometry(5, 5), 'flat', new THREE.Vector3(16.5, -15, -40));
    probe('fogFar', far.position);
    // Ambient 0.4 on the diffuse scale.
    mesh(new THREE.PlaneGeometry(0.6, 0.6), 'ambient-out', new THREE.Vector3(0, 0.3, 0));
    probe('ambient', new THREE.Vector3(0, 0.3, 0));
    // A baked lightmap (UV1, linear 0.5 at intensity pi) on a lightmapped copy of the custom-lit material.
    const lmGeo = new THREE.PlaneGeometry(0.6, 0.6);
    lmGeo.setAttribute('uv1', lmGeo.getAttribute('uv').clone());
    const lmQuad = mesh(lmGeo, 'lightmap-out', new THREE.Vector3(3.4, 0.6, 0));
    const lm = dataTexture(1, 1, () => [128, 128, 128, 255]);
    lm.channel = 1;
    lm.colorSpace = THREE.NoColorSpace;
    const lmCopy = lightmappedMaterial(lmQuad.material as THREE.Material, lm, Math.PI, false);
    if (lmCopy === null) throw new Error('a custom-lit material takes no lightmap');
    lmQuad.material = lmCopy;
    probe('lightmap', new THREE.Vector3(3.4, 0.6, 0));
    extra = { disc, mainLight: mainLightIndex([sun, fill]) };
  },
  /** A custom-lit surface in a scene without lights still draws its graph (every term at "no light"). */
  dark() {
    scene.clear();
    const graph: MaterialGraphLike = {
      nodes: [
        { id: 'out', type: 'customLit', position: [0, 0] },
        { id: 'c', type: 'color', position: [0, 0], data: { color: '#ff8000' } },
        { id: 'd', type: 'diffuseLight', position: [0, 0] },
        { id: 's', type: 'lightShadow', position: [0, 0] },
        { id: 'add', type: 'add', position: [0, 0] },
        { id: 'mul', type: 'multiply', position: [0, 0] },
      ],
      edges: [
        { id: 'a', from: { node: 'c', port: 'rgb' }, to: { node: 'add', port: 'a' } },
        { id: 'b', from: { node: 'd', port: 'total' }, to: { node: 'add', port: 'b' } },
        { id: 'f', from: { node: 'add', port: 'out' }, to: { node: 'mul', port: 'a' } },
        { id: 'g', from: { node: 's', port: 'shadow' }, to: { node: 'mul', port: 'b' } },
        { id: 'h', from: { node: 'mul', port: 'out' }, to: { node: 'out', port: 'color' } },
      ],
    };
    library.setMaterials([graphDef('dark', graph)]);
    const m = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), src());
    scene.add(m);
    library.apply(m, { '*': 'dark' });
    probe('dark', new THREE.Vector3(0, 0, 0));
  },
};

async function main(): Promise<void> {
  const handle = createRenderer({ canvas, preference: backend, source: 'url', antialias: false, clearColor: 0x000000, clearAlpha: 1 });
  const ok = await handle.whenReady();
  const info = handle.info();
  if (!ok) throw new Error(`renderer not ready: ${info.reason}`);
  renderer = handle.current() as unknown as THREE.WebGLRenderer;
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
