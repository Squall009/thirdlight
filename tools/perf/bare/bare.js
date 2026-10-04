// The plain three.js page: the content of a dumped frame (tools/perf/scene-dump.ts, served under ./scene/)
// drawn the way a hand-written three.js game would, with nothing from Thirdlight. Same geometry, placements,
// sun shadow, fog, camera and post stack; plain MeshStandardMaterial; repeated (geometry, material) pairs drawn
// as one InstancedMesh. It is the yardstick the export is measured against (tools/perf/village-run.ts).
//
// Query: renderer=webgl2 (default WebGPU), post=0 (no post stack), instance=0 (no automatic instancing),
// extra=N (N empty Groups in the graph). The per-draw ablation adds one thing at a time:
//   lights=N   point lights of intensity 0 up to N in all (an effect light pool kept dark)
//   copies=1   every draw its own copy of its material (per-object materials)
//   nodemat=1  the engine's node materials (tools/perf/bare-engine-materials.ts, served as ./engine/materials.js)
// Skinned meshes are drawn in their rest pose (the dump has no clips).
import * as THREE from 'three/webgpu';
import { pass, mrt, output, normalView, vec4, mix, float, renderOutput } from 'three/tsl';
import { ao } from 'three/addons/tsl/display/GTAONode.js';
import { bloom } from 'three/addons/tsl/display/BloomNode.js';
import { smaa } from 'three/addons/tsl/display/SMAANode.js';

const q = new URLSearchParams(location.search);
const usePost = q.get('post') !== '0';
const autoInstance = q.get('instance') !== '0';
const extraObjects = Number(q.get('extra') ?? 0);
const darkLights = Number(q.get('lights') ?? 0);
const materialCopies = q.get('copies') === '1';
const engineMaterials = q.get('nodemat') === '1';

const renderer = new THREE.WebGPURenderer({ antialias: false, forceWebGL: q.get('renderer') === 'webgl2' });
renderer.setPixelRatio(1);
renderer.setSize(innerWidth, innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFShadowMap;
document.body.appendChild(renderer.domElement);
renderer.domElement.dataset.tlRenderer = q.get('renderer') === 'webgl2' ? 'webgl2' : 'webgpu';
await renderer.init();

const meta = await (await fetch('./scene/scene.json')).json();
const bin = await (await fetch('./scene/scene.bin')).arrayBuffer();
renderer.toneMapping = meta.toneMapping || THREE.NeutralToneMapping;
renderer.toneMappingExposure = meta.exposure ?? 1;

const TYPED = { Float32Array, Uint32Array, Uint16Array, Uint8Array, Int16Array, Int8Array, Int32Array };
const NORM_MAX = { Uint8Array: 255, Int8Array: 127, Uint16Array: 65535, Int16Array: 32767 };
const geos = meta.geos.map((g) => {
  const geo = new THREE.BufferGeometry();
  for (const [name, a] of Object.entries(g.attrs)) {
    const C = TYPED[a.type];
    let arr = new C(bin, a.at, a.count);
    let norm = C === Float32Array ? false : a.normalized;
    // WebGPU has no 3-component 8/16-bit vertex formats: such attributes go to float32.
    if (C !== Float32Array && name !== 'skinIndex' && (arr.BYTES_PER_ELEMENT * a.itemSize) % 4 !== 0) {
      const max = NORM_MAX[a.type] ?? 1;
      arr = Float32Array.from(arr, (v) => (norm ? v / max : v));
      norm = false;
    }
    geo.setAttribute(name, new THREE.BufferAttribute(arr, a.itemSize, norm));
  }
  if (g.index) {
    const C = TYPED[g.index.type];
    geo.setIndex(new THREE.BufferAttribute(new C(bin, g.index.at, g.index.count), 1));
  }
  geo.computeBoundingSphere();
  geo.computeBoundingBox();
  return geo;
});

// One 512² mipmapped noise texture per textured material: the binding structure, not the original texels.
const makeTex = (seed) => {
  const s = 512;
  const d = new Uint8Array(s * s * 4);
  for (let i = 0; i < s * s; i++) {
    const v = 160 + (((i * 2654435761 + seed * 97) >>> 24) % 80);
    d[i * 4] = v; d[i * 4 + 1] = v; d[i * 4 + 2] = v; d[i * 4 + 3] = 255;
  }
  const t = new THREE.DataTexture(d, s, s);
  t.generateMipmaps = true;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.magFilter = THREE.LinearFilter;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = THREE.SRGBColorSpace;
  t.needsUpdate = true;
  return t;
};
const plainMaterial = (m, i) => {
  const common = { color: m.color, map: m.map ? makeTex(i) : null, transparent: m.transparent, opacity: m.opacity, alphaTest: m.alphaTest, side: m.side, vertexColors: m.vertexColors, depthWrite: m.depthWrite, blending: m.blending };
  if (/Basic/.test(m.type)) return new THREE.MeshBasicMaterial(common);
  return new THREE.MeshStandardMaterial({ ...common, roughness: m.roughness, metalness: m.metalness, emissive: m.emissive, emissiveIntensity: m.emissiveIntensity, normalMap: m.normalMap ? makeTex(i + 1000) : null, flatShading: m.flatShading });
};
let makeMaterial = plainMaterial;
if (engineMaterials) {
  const { engineMaterial } = await import('./engine/materials.js');
  makeMaterial = (m, i) => engineMaterial(plainMaterial(m, i), m);
}
const mats = meta.mats.map((m, i) => makeMaterial(m, i));
// Per-object materials: each draw gets its own copy (same values, its own uniforms).
const materialFor = (i) => (materialCopies ? mats[i].clone() : mats[i]);

const scene = new THREE.Scene();
// A bundled page may rename the class (`_FogExp2`): the density says which fog it is.
if (meta.fog && meta.fog.density !== null) scene.fog = new THREE.FogExp2(meta.fog.color, meta.fog.density);
else if (meta.fog) scene.fog = new THREE.Fog(meta.fog.color, meta.fog.near, meta.fog.far);
scene.background = new THREE.Color(0xb8c8e0);

const m4 = new THREE.Matrix4();
const m4b = new THREE.Matrix4();
let meshes = 0;
let instanced = 0;
const groups = new Map();
const place = (obj, it) => {
  obj.castShadow = it.cast;
  obj.receiveShadow = it.recv;
  scene.add(obj);
};
for (const it of meta.items) {
  const geo = geos[it.g];
  if (it.inst) {
    const arr = new Float32Array(bin, it.inst.at, it.inst.count * 16);
    const im = new THREE.InstancedMesh(geo, materialFor(it.m), it.inst.count);
    m4b.fromArray(it.mw);
    for (let i = 0; i < it.inst.count; i++) {
      m4.fromArray(arr, i * 16);
      m4.premultiply(m4b);
      im.setMatrixAt(i, m4);
    }
    im.computeBoundingSphere();
    place(im, it);
    instanced++;
    continue;
  }
  const key = `${it.g}|${it.m}|${it.cast}|${it.recv}`;
  if (autoInstance && !it.skinned && !mats[it.m].transparent) {
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(it);
    continue;
  }
  const mesh = new THREE.Mesh(geo, materialFor(it.m));
  m4.fromArray(it.mw);
  m4.decompose(mesh.position, mesh.quaternion, mesh.scale);
  place(mesh, it);
  meshes++;
}
for (const list of groups.values()) {
  const it0 = list[0];
  if (list.length === 1) {
    const mesh = new THREE.Mesh(geos[it0.g], materialFor(it0.m));
    m4.fromArray(it0.mw);
    m4.decompose(mesh.position, mesh.quaternion, mesh.scale);
    place(mesh, it0);
    meshes++;
    continue;
  }
  const im = new THREE.InstancedMesh(geos[it0.g], materialFor(it0.m), list.length);
  list.forEach((it, i) => im.setMatrixAt(i, m4.fromArray(it.mw)));
  im.computeBoundingSphere();
  place(im, it0);
  instanced++;
}
if (extraObjects > 0) {
  let parent = new THREE.Group();
  scene.add(parent);
  for (let i = 0; i < extraObjects; i++) {
    const g = new THREE.Group();
    g.position.set(i % 7, 0, 0);
    (i % 8 === 0 ? scene : parent).add(g);
    if (i % 8 === 0) parent = g;
  }
}

const sunDef = meta.lights.find((l) => l.type === 'DirectionalLight');
if (sunDef) {
  const sun = new THREE.DirectionalLight(sunDef.color, sunDef.intensity);
  sun.position.fromArray(sunDef.pos);
  sun.target.position.fromArray(sunDef.target ?? [0, 0, 0]);
  sun.castShadow = sunDef.castShadow;
  if (sunDef.shadow) {
    sun.shadow.mapSize.set(sunDef.shadow.mapSize[0], sunDef.shadow.mapSize[1]);
    if (sunDef.shadow.cam) {
      const [l, r, t, b, n, f] = sunDef.shadow.cam;
      Object.assign(sun.shadow.camera, { left: l, right: r, top: t, bottom: b, near: n, far: f });
      sun.shadow.camera.updateProjectionMatrix();
    }
    sun.shadow.bias = sunDef.shadow.bias;
    sun.shadow.normalBias = sunDef.shadow.normalBias;
  }
  scene.add(sun, sun.target);
}
let litPoints = 0;
for (const l of meta.lights) {
  if (l.type === 'AmbientLight') scene.add(new THREE.AmbientLight(l.color, l.intensity));
  if (l.type === 'HemisphereLight') scene.add(new THREE.HemisphereLight(l.color, 0x404040, l.intensity));
  // Point lights that shine are content (an effect's light); dark ones are what the ablation adds.
  if (l.type === 'PointLight' && l.visible && l.intensity > 0) {
    const p = new THREE.PointLight(l.color, l.intensity, l.distance, l.decay);
    p.position.fromArray(l.pos);
    scene.add(p);
    litPoints++;
  }
}
const centre = new THREE.Vector3().fromArray(meta.camera.mw, 12);
// lights=N: dark point lights up to N point lights in all (a pool of N, some of them lit).
for (let i = litPoints; i < darkLights; i++) {
  const p = new THREE.PointLight(0xffa040, 0, 6, 2);
  p.position.set(centre.x + (i % 4) * 3 - 4.5, 1, centre.z - 20 - Math.floor(i / 4) * 3);
  scene.add(p);
}

const camera = new THREE.PerspectiveCamera(meta.camera.fov, innerWidth / innerHeight, meta.camera.near, meta.camera.far);
m4.fromArray(meta.camera.mw);
m4.decompose(camera.position, camera.quaternion, camera.scale);

let post = null;
if (usePost) {
  // The engine's stack: scene pass (no MSAA) with view normals, GTAO at half resolution, bloom, output, SMAA.
  const sp = pass(scene, camera, { samples: 0 });
  sp.setMRT(mrt({ output, normal: normalView }));
  let color = sp.getTextureNode('output');
  const aoNode = ao(sp.getTextureNode('depth'), sp.getTextureNode('normal'), camera);
  aoNode.resolutionScale = 0.5;
  color = vec4(color.rgb.mul(mix(float(1), aoNode.getTextureNode().r, float(1))), color.a);
  const bl = bloom(color, 0.25, 0.4, 1.05);
  color = vec4(color.rgb.add(bl.rgb), color.a);
  color = smaa(renderOutput(color));
  post = new THREE.RenderPipeline(renderer, color);
  post.outputColorTransform = false;
}

let objects = 0;
scene.traverse(() => objects++);
globalThis.__bare = { meshes, instanced, objects, post: usePost, autoInstance, litPoints, darkLights, materialCopies, engineMaterials };
console.log('[bare]', JSON.stringify(globalThis.__bare));
renderer.setAnimationLoop(() => {
  if (post) post.render();
  else renderer.render(scene, camera);
});
