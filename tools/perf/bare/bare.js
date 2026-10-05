// The plain three.js page: the content of a dumped frame (tools/perf/scene-dump.ts, served under ./scene/)
// drawn the way a hand-written three.js game would, with nothing from Thirdlight. Same geometry, placements,
// textures (the dumped texels in their GPU format), background, environment lighting (the scene's PMREM), sun
// shadow, fog, camera, animated skinned meshes and post stack (./scene/post.json: the scene's own settings);
// plain MeshStandardMaterial; repeated (geometry, material) pairs drawn as one InstancedMesh. It is the
// yardstick the export is measured against (tools/perf/village-run.ts).
//
// Query: renderer=webgl2 (default WebGPU), post=0 (no post stack), instance=0 (no automatic instancing),
// extra=N (N empty Groups in the graph), pixelRatio=F (draw at F × the CSS size: 0.5 shows the CPU floor), fair=0 (the first plain page, kept to compare with: 512² noise
// textures, no environment lighting, a colour background, no grading, skinned meshes in their rest pose).
// The per-draw ablation adds one thing at a time:
//   lights=N   point lights of intensity 0 up to N in all (an effect light pool kept dark)
//   copies=1   every draw its own copy of its material (per-object materials)
//   nodemat=1  the engine's node materials (tools/perf/bare-engine-materials.ts, served as ./engine/materials.js)
import * as THREE from 'three/webgpu';
import { pass, mrt, output, normalView, vec4, vec3, mix, float, renderOutput, Fn, dot, pow, max, clamp, uv, uniform } from 'three/tsl';
import { ao } from 'three/addons/tsl/display/GTAONode.js';
import { bloom } from 'three/addons/tsl/display/BloomNode.js';
import { smaa } from 'three/addons/tsl/display/SMAANode.js';
import { fxaa } from 'three/addons/tsl/display/FXAANode.js';

const q = new URLSearchParams(location.search);
const usePost = q.get('post') !== '0';
const autoInstance = q.get('instance') !== '0';
const extraObjects = Number(q.get('extra') ?? 0);
const darkLights = Number(q.get('lights') ?? 0);
const materialCopies = q.get('copies') === '1';
const engineMaterials = q.get('nodemat') === '1';
const fair = q.get('fair') !== '0';

const renderer = new THREE.WebGPURenderer({ antialias: false, forceWebGL: q.get('renderer') === 'webgl2' });
renderer.setPixelRatio(Number(q.get('pixelRatio') ?? 1));
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

const TYPED = { Float32Array, Uint32Array, Uint16Array, Uint8Array, Uint8ClampedArray, Int16Array, Int8Array, Int32Array };
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

// The dumped textures as the GPU had them: compressed mip levels, data texels, or a PNG of the image.
const typed = (d) => new TYPED[d.type](bin, d.at, d.count);
const textures = await Promise.all((meta.textures ?? []).map(async (d) => {
  let t = null;
  if (d.kind === 'compressed') {
    const mips = d.mips.map((m) => ({ data: typed(m), width: m.width, height: m.height }));
    t = new THREE.CompressedTexture(mips, d.width, d.height, d.format, d.type);
  } else if (d.kind === 'data') {
    t = new THREE.DataTexture(typed(d.data), d.width, d.height, d.format, d.type);
    if (d.mips.length > 0) t.mipmaps = d.mips.map((m) => ({ data: typed(m), width: m.width, height: m.height }));
  } else if (d.kind === 'image') {
    const blob = await (await fetch(`./scene/${d.file}`)).blob();
    t = new THREE.Texture(await createImageBitmap(blob, { premultiplyAlpha: 'none', colorSpaceConversion: 'none' }));
  }
  if (t === null) return null;
  Object.assign(t, d.sampler, { colorSpace: d.colorSpace, flipY: d.flipY, premultiplyAlpha: d.premultiplyAlpha, mapping: d.mapping, channel: d.channel, rotation: d.uv.rotation });
  t.offset.fromArray(d.uv.offset);
  t.repeat.fromArray(d.uv.repeat);
  t.center.fromArray(d.uv.center);
  t.name = d.name;
  t.needsUpdate = true;
  return t;
}));
const MAP_SLOTS = ['map', 'normalMap', 'roughnessMap', 'metalnessMap', 'emissiveMap', 'aoMap', 'lightMap', 'alphaMap', 'bumpMap', 'displacementMap', 'specularMap'];
const mapsOf = (m, i) => {
  if (!fair || m.textures === undefined) return { map: m.map ? makeTex(i) : null, ...(/Basic/.test(m.type) ? {} : { normalMap: m.normalMap ? makeTex(i + 1000) : null }) };
  const out = {};
  for (const k of MAP_SLOTS) {
    if (/Basic/.test(m.type) && !['map', 'alphaMap', 'aoMap', 'lightMap', 'specularMap'].includes(k)) continue;
    if (m.textures[k] !== undefined) out[k] = textures[m.textures[k]] ?? null;
  }
  // A node material's slots sample textures of their own: a hand-written page has one texture per slot instead.
  const NODE_SLOT_MAP = { colorNode: 'map', normalNode: 'normalMap', roughnessNode: 'roughnessMap', metalnessNode: 'metalnessMap', aoNode: 'aoMap', emissiveNode: 'emissiveMap', opacityNode: 'alphaMap' };
  for (const [node, slot] of Object.entries(NODE_SLOT_MAP)) {
    if (/Basic/.test(m.type) && !['map', 'alphaMap', 'aoMap'].includes(slot)) continue;
    const id = m.nodeMaps?.[node]?.[0];
    if (out[slot] === undefined && id !== undefined) out[slot] = textures[id] ?? null;
  }
  return out;
};
const plainMaterial = (m, i) => {
  const common = { color: m.color, transparent: m.transparent, opacity: m.opacity, alphaTest: m.alphaTest, side: m.side, vertexColors: m.vertexColors, depthWrite: m.depthWrite, blending: m.blending, ...mapsOf(m, i) };
  if (fair) Object.assign(common, { fog: m.fog ?? true, toneMapped: m.toneMapped ?? true, aoMapIntensity: m.aoMapIntensity ?? 1, lightMapIntensity: m.lightMapIntensity ?? 1 });
  if (/Basic/.test(m.type)) return new THREE.MeshBasicMaterial(common);
  const lit = { ...common, emissive: m.emissive, emissiveIntensity: m.emissiveIntensity, flatShading: m.flatShading };
  if (fair && /Lambert/.test(m.type)) return new THREE.MeshLambertMaterial(lit);
  const std = new THREE.MeshStandardMaterial({ ...lit, roughness: m.roughness, metalness: m.metalness });
  if (fair) {
    if (m.normalScale) std.normalScale.fromArray(m.normalScale);
    std.normalMapType = m.normalMapType ?? THREE.TangentSpaceNormalMap;
    std.envMapIntensity = m.envMapIntensity ?? 1;
  }
  return std;
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
if (fair && meta.background?.color !== undefined) scene.background = new THREE.Color(meta.background.color);
if (fair && meta.background?.texture !== undefined) scene.background = textures[meta.background.texture] ?? scene.background;
if (fair) {
  scene.backgroundIntensity = meta.backgroundIntensity ?? 1;
  scene.backgroundBlurriness = meta.backgroundBlurriness ?? 0;
}
// The environment lighting: the scene's own PMREM, uploaded as it was read back. three flips a PMREM it rendered
// itself on sampling (its targets are Y-down) and not one handed in, so once uploaded it is marked as a target's.
if (fair && meta.environment?.kind === 'pmrem') {
  const e = meta.environment;
  const env = new THREE.DataTexture(new TYPED[e.type](bin, e.at, e.bytes / TYPED[e.type].BYTES_PER_ELEMENT), e.width, e.height, THREE.RGBAFormat, e.type === 'Uint16Array' ? THREE.HalfFloatType : THREE.FloatType);
  env.mapping = THREE.CubeUVReflectionMapping;
  env.minFilter = env.magFilter = THREE.LinearFilter;
  env.generateMipmaps = false;
  env.colorSpace = THREE.LinearSRGBColorSpace;
  env.needsUpdate = true;
  renderer.initTexture(env);
  env.isRenderTargetTexture = true;
  scene.environment = env;
  scene.environmentIntensity = e.intensity ?? 1;
} else if (fair && meta.environment?.kind === 'texture') {
  scene.environment = textures[meta.environment.texture] ?? null;
  scene.environmentIntensity = meta.environment.intensity ?? 1;
}

const m4 = new THREE.Matrix4();
const m4b = new THREE.Matrix4();
// Skeletons with the motion sampled from the export, played back by a mixer each (as a game plays a clip).
const mixers = [];
const skeletons = fair ? (meta.skeletons ?? []).map((d) => {
  const bones = d.parents.map((_, i) => Object.assign(new THREE.Bone(), { name: `sk${d.id}b${i}` }));
  d.parents.forEach((p, i) => (p >= 0 ? bones[p] : scene).add(bones[i]));
  const skeleton = new THREE.Skeleton(bones, d.inverses.map((e) => new THREE.Matrix4().fromArray(e)));
  const poses = new Float32Array(bin, d.poses.at, d.poses.count);
  const n = bones.length;
  const times = meta.skinTimes.slice(0, d.frames);
  const p = new THREE.Vector3(), r = new THREE.Quaternion(), sc = new THREE.Vector3();
  const tracks = [];
  for (let b = 0; b < n; b++) {
    const pos = [], rot = [], scl = [];
    for (let f = 0; f < d.frames; f++) {
      m4.fromArray(poses, (f * n + b) * 16).decompose(p, r, sc);
      pos.push(p.x, p.y, p.z); rot.push(r.x, r.y, r.z, r.w); scl.push(sc.x, sc.y, sc.z);
    }
    if (d.frames > 0) {
      bones[b].position.fromArray(pos); bones[b].quaternion.fromArray(rot); bones[b].scale.fromArray(scl);
      tracks.push(new THREE.VectorKeyframeTrack(`${bones[b].name}.position`, times, pos), new THREE.QuaternionKeyframeTrack(`${bones[b].name}.quaternion`, times, rot), new THREE.VectorKeyframeTrack(`${bones[b].name}.scale`, times, scl));
    }
  }
  if (tracks.length > 0) {
    const mixer = new THREE.AnimationMixer(scene);
    mixer.clipAction(new THREE.AnimationClip(`sk${d.id}`, -1, tracks)).play();
    mixers.push(mixer);
  }
  return skeleton;
}) : [];
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
  const skin = it.skinned && it.skin !== undefined ? skeletons[it.skin.skeleton] : undefined;
  const mesh = skin !== undefined ? new THREE.SkinnedMesh(geo, materialFor(it.m)) : new THREE.Mesh(geo, materialFor(it.m));
  m4.fromArray(it.mw);
  m4.decompose(mesh.position, mesh.quaternion, mesh.scale);
  if (skin !== undefined) {
    mesh.bindMode = it.skin.bindMode;
    mesh.bind(skin, new THREE.Matrix4().fromArray(it.skin.bindMatrix));
  }
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

// The scene's post settings (the export's environment), or the first plain page's fixed stack.
const settings = fair ? await fetch('./scene/post.json').then((r) => (r.ok ? r.json() : null)).catch(() => null) : null;
let post = null;
if (usePost) {
  // The engine's stack: scene pass (no MSAA) with view normals, GTAO at half resolution, bloom, output, grading, SMAA.
  const ssao = settings === null ? { radius: null, intensity: 1 } : settings.ssao?.enabled ? { radius: settings.ssao.radius ?? 0.5, intensity: settings.ssao.intensity ?? 1 } : null;
  const bl = settings === null ? { strength: 0.25, radius: 0.4, threshold: 1.05 } : settings.bloom?.enabled ? { strength: (settings.bloom.strength ?? 0.6) * 3, radius: settings.bloom.radius ?? 0.4, threshold: settings.bloom.threshold ?? 0.85 } : null;
  const sp = pass(scene, camera, { samples: 0 });
  if (ssao !== null) sp.setMRT(mrt({ output, normal: normalView }));
  let color = sp.getTextureNode('output');
  if (ssao !== null) {
    const aoNode = ao(sp.getTextureNode('depth'), sp.getTextureNode('normal'), camera);
    aoNode.resolutionScale = 0.5;
    if (ssao.radius !== null) aoNode.radius.value = ssao.radius;
    color = vec4(color.rgb.mul(mix(float(1), aoNode.getTextureNode().r, float(ssao.intensity))), color.a);
  }
  if (bl !== null) {
    const b = bloom(color, bl.strength, bl.radius, bl.threshold);
    color = vec4(color.rgb.add(b.rgb), color.a);
  }
  color = renderOutput(color);
  const g = settings?.grading;
  if (g !== undefined || settings?.vignette?.enabled) {
    // Brightness, contrast, saturation, lift/gain/gamma, tint and a vignette on the display picture.
    const input = color;
    const vignette = settings?.vignette?.enabled ? (settings.vignette.darkness ?? 0.5) : 0;
    color = Fn(() => {
      const texel = input.toVar();
      const c = texel.rgb.add(uniform(g?.brightness ?? 0)).toVar();
      c.assign(c.sub(0.5).mul(uniform(g?.contrast ?? 0).add(1)).add(0.5));
      const l = dot(c, vec3(0.2126, 0.7152, 0.0722));
      c.assign(mix(vec3(l), c, uniform(g?.saturation ?? 0).add(1)));
      c.assign(c.add(uniform(g?.lift ?? 0).mul(vec3(1).sub(c))).mul(uniform(g?.gain ?? 1)));
      c.assign(pow(max(c, vec3(0)), vec3(float(1).div(uniform(g?.gamma ?? 1)))));
      c.mulAssign(uniform(new THREE.Color(g?.tint ?? '#ffffff')));
      if (vignette > 0) {
        const d = uv().sub(0.5).mul(uniform(settings.vignette.offset ?? 1));
        c.mulAssign(mix(float(1), float(1).sub(dot(d, d).mul(2)), uniform(vignette)));
      }
      return vec4(clamp(c, 0, 1), texel.a);
    })();
  }
  const aa = settings === null ? 'smaa' : (settings.antialias ?? 'none');
  if (aa === 'smaa') color = smaa(color);
  if (aa === 'fxaa') color = fxaa(color);
  post = new THREE.RenderPipeline(renderer, color);
  post.outputColorTransform = false;
}

let objects = 0;
scene.traverse(() => objects++);
globalThis.__bare = { fair, meshes, instanced, objects, post: usePost, autoInstance, litPoints, darkLights, materialCopies, engineMaterials, textures: textures.filter((t) => t !== null).length, environment: scene.environment !== null, skeletons: skeletons.length, mixers: mixers.length };
console.log('[bare]', JSON.stringify(globalThis.__bare));
let last = performance.now();
renderer.setAnimationLoop(() => {
  const now = performance.now();
  const dt = (now - last) / 1000;
  last = now;
  for (const m of mixers) m.update(dt);
  if (post) post.render();
  else renderer.render(scene, camera);
});
