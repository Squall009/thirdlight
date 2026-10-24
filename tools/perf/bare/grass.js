// The grass density probe: a plain three.js page (nothing from Thirdlight) drawing the meadow class's ground
// (./meadow/heights.bin, the same heights the class imports) and rings of grass clumps (./meadow/clump.glb, the
// class's stand-in clump and its levels) placed wholly on the GPU, the way the GPU cover path is planned: the
// ground round the camera is cut into square patches, each ring's patches in view are listed in a small texture
// (their corner and a seed; frustum-culled on the CPU), and one instanced draw per ring computes each clump's
// place, turn, size and keep-or-thin from its instance index, the patch it falls in and the heights texture.
// Nothing per clump lives on the CPU. It estimates what density the GPU can afford (tools/perf/meadow-run.ts).
//
// Query: renderer=webgl2 (default WebGPU); rings=[{"density":8,"radius":30,"lod":0},…] (clumps per m², outer
// radius m, clump level), outermost last; cam=x,y,z,qx,qy,qz,qw; wind=0 (no sway).
import * as THREE from 'three/webgpu';
import { attribute, cos, float, hash, instanceIndex, int, ivec2, mix, positionLocal, select, sin, smoothstep, textureLoad, time, uniform, uint, vec2, vec3 } from 'three/tsl';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

const q = new URLSearchParams(location.search);
const rings = JSON.parse(q.get('rings') ?? '[]');
const wind = q.get('wind') !== '0';
const cam = (q.get('cam') ?? '0,2,0,0,0,0,1').split(',').map(Number);

const renderer = new THREE.WebGPURenderer({ antialias: false, forceWebGL: q.get('renderer') === 'webgl2' });
renderer.setPixelRatio(1);
renderer.setSize(innerWidth, innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFShadowMap;
renderer.toneMapping = THREE.NeutralToneMapping;
document.body.appendChild(renderer.domElement);
renderer.domElement.dataset.tlRenderer = q.get('renderer') === 'webgl2' ? 'webgl2' : 'webgpu';
await renderer.init();

const meta = await (await fetch('./meadow/meta.json')).json();
const heights = new Float32Array(await (await fetch('./meadow/heights.bin')).arrayBuffer());
const { samples, spacing, origin } = meta;

const scene = new THREE.Scene();
scene.background = new THREE.Color('#b8c8e0');
scene.fog = new THREE.FogExp2('#c9d3df', 0.0008);
scene.add(new THREE.HemisphereLight('#dfe8f5', '#4a5236', 0.8));

const camera = new THREE.PerspectiveCamera(60, innerWidth / innerHeight, 0.1, 2000);
camera.position.set(cam[0], cam[1], cam[2]);
camera.quaternion.set(cam[3], cam[4], cam[5], cam[6]);
camera.updateMatrixWorld();

// The ground: every second sample (4 m quads), lit and shadowed like the grass.
const step = 2;
const n = Math.floor((samples - 1) / step);
const ground = new THREE.PlaneGeometry((samples - 1) * spacing, (samples - 1) * spacing, n, n);
ground.rotateX(-Math.PI / 2);
const gp = ground.attributes.position;
for (let k = 0; k < gp.count; k += 1) {
  const x = gp.getX(k) + ((samples - 1) * spacing) / 2;
  const z = gp.getZ(k) + ((samples - 1) * spacing) / 2;
  const si = Math.min(samples - 1, Math.round(x / spacing));
  const sj = Math.min(samples - 1, Math.round(z / spacing));
  gp.setY(k, heights[sj * samples + si]);
}
ground.computeVertexNormals();
const groundMesh = new THREE.Mesh(ground, new THREE.MeshStandardMaterial({ color: '#6a7f45', roughness: 0.95 }));
groundMesh.position.set(origin[0] + ((samples - 1) * spacing) / 2, 0, origin[2] + ((samples - 1) * spacing) / 2);
groundMesh.receiveShadow = true;
groundMesh.castShadow = true;
scene.add(groundMesh);

const sun = new THREE.DirectionalLight('#ffe2bd', 2);
const sunDir = new THREE.Vector3(0.5, -0.55, -0.65).normalize();
const look = new THREE.Vector3(0, 0, -1).applyQuaternion(camera.quaternion);
const target = camera.position.clone().addScaledVector(look, 60);
sun.target.position.copy(target);
sun.position.copy(target).addScaledVector(sunDir, -300);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
Object.assign(sun.shadow.camera, { left: -120, right: 120, top: 120, bottom: -120, near: 1, far: 800 });
scene.add(sun, sun.target);

// The heights for the shader: one float a sample, read with integer loads and blended by hand (float textures need
// not be filterable).
const heightTex = new THREE.DataTexture(heights, samples, samples, THREE.RedFormat, THREE.FloatType);
heightTex.needsUpdate = true;
const groundAt = (wx, wz) => {
  const fx = wx.sub(origin[0]).div(spacing).clamp(0, samples - 1.001);
  const fz = wz.sub(origin[2]).div(spacing).clamp(0, samples - 1.001);
  const ix = int(fx.floor());
  const iz = int(fz.floor());
  const tx = fx.fract();
  const tz = fz.fract();
  const h = (dx, dz) => textureLoad(heightTex, ivec2(ix.add(dx), iz.add(dz))).x;
  return mix(mix(h(0, 0), h(1, 0), tx), mix(h(0, 1), h(1, 1), tx), tz);
};

const gltf = await new GLTFLoader().loadAsync('./meadow/clump.glb');
const levels = [0, 1, 2].map((l) => gltf.scene.getObjectByName(`clump_LOD${l}`)?.geometry);
const PATCH_ROW = 1024;
const camXZ = uniform(new THREE.Vector2(camera.position.x, camera.position.z));
const frustum = new THREE.Frustum();
const box = new THREE.Box3();
let lo = Infinity;
let hi = -Infinity;
for (const h of heights) {
  lo = Math.min(lo, h);
  hi = Math.max(hi, h);
}

const ringDraws = rings.map((ring, i) => {
  const inner = i === 0 ? 0 : rings[i - 1].radius;
  const next = rings[i + 1];
  // Patches a few clumps a side; larger far out, where clumps are sparse.
  const patch = ring.radius <= 40 ? 8 : ring.radius <= 160 ? 16 : 32;
  const side = Math.max(1, Math.round(patch * Math.sqrt(ring.density)));
  const perPatch = side * side;
  const maxPatches = Math.ceil(((2 * ring.radius) / patch + 2) ** 2);
  const rows = Math.ceil(maxPatches / PATCH_ROW);
  const patchData = new Float32Array(PATCH_ROW * rows * 4);
  const patchTex = new THREE.DataTexture(patchData, PATCH_ROW, rows, THREE.RGBAFormat, THREE.FloatType);
  patchTex.needsUpdate = true;
  // The share kept at the ring's outer edge: the next ring's density, or nothing past the last.
  const endShare = next === undefined ? 0 : Math.min(1, next.density / ring.density);
  const fadeFrom = inner + (ring.radius - inner) * (next === undefined ? 0.7 : 0.8);

  const idx = instanceIndex;
  const per = uint(perPatch);
  const p = idx.div(per);
  const local = idx.mod(per);
  const corner = textureLoad(patchTex, ivec2(int(p.mod(uint(PATCH_ROW))), int(p.div(uint(PATCH_ROW)))));
  const seed = uint(corner.z).mul(uint(perPatch)).add(local);
  const h1 = hash(seed.mul(uint(4)));
  const h2 = hash(seed.mul(uint(4)).add(uint(1)));
  const h3 = hash(seed.mul(uint(4)).add(uint(2)));
  const h4 = hash(seed.mul(uint(4)).add(uint(3)));
  const cell = patch / side;
  const wx = corner.x.add(float(local.mod(uint(side))).add(h1).mul(cell));
  const wz = corner.y.add(float(local.div(uint(side))).add(h2).mul(cell));
  const d = vec2(wx, wz).sub(camXZ).length();
  const share = mix(float(1), float(endShare), smoothstep(fadeFrom, ring.radius, d));
  const keep = d.greaterThanEqual(inner).and(d.lessThan(ring.radius)).and(h3.lessThan(share));
  const yaw = h4.mul(Math.PI * 2);
  const scale = mix(float(0.8), float(1.3), h1);
  const lp = positionLocal.mul(scale);
  const c = cos(yaw);
  const s = sin(yaw);
  let x = lp.x.mul(c).sub(lp.z.mul(s));
  const z = lp.x.mul(s).add(lp.z.mul(c));
  if (wind) {
    const bend = attribute('color', 'vec4').x;
    x = x.add(sin(time.mul(1.7).add(wx.mul(0.25)).add(h2.mul(6.28))).mul(0.12).mul(bend));
  }
  const placed = vec3(wx.add(x), groundAt(wx, wz).add(lp.y), wz.add(z));
  const material = new THREE.MeshStandardNodeMaterial({ color: '#4d7a2e', roughness: 0.8, side: THREE.DoubleSide });
  material.positionNode = select(keep, placed, vec3(0, -1e5, 0));
  const mesh = new THREE.Mesh(levels[Math.min(ring.lod, 2)], material);
  mesh.frustumCulled = false;
  mesh.receiveShadow = true;
  mesh.castShadow = false;
  mesh.count = 0;
  scene.add(mesh);
  return { ring, inner, patch, perPatch, maxPatches, patchData, patchTex, mesh, key: '' };
});

// Each ring's patches whose square meets the ring and the view (frustum-culled on the CPU, a few hundred at most).
function updatePatches() {
  camera.updateMatrixWorld();
  frustum.setFromProjectionMatrix(new THREE.Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse));
  const cx = camera.position.x;
  const cz = camera.position.z;
  camXZ.value.set(cx, cz);
  for (const r of ringDraws) {
    const P = r.patch;
    const R = r.ring.radius;
    let count = 0;
    const list = [];
    for (let pz = Math.floor((cz - R) / P); pz <= Math.floor((cz + R) / P); pz += 1) {
      for (let px = Math.floor((cx - R) / P); px <= Math.floor((cx + R) / P); px += 1) {
        const x0 = px * P;
        const z0 = pz * P;
        // Nearest and farthest points of the square from the camera: it meets the ring's annulus.
        const nx = Math.max(x0, Math.min(cx, x0 + P)) - cx;
        const nz = Math.max(z0, Math.min(cz, z0 + P)) - cz;
        const fx = Math.max(Math.abs(x0 - cx), Math.abs(x0 + P - cx));
        const fz = Math.max(Math.abs(z0 - cz), Math.abs(z0 + P - cz));
        if (Math.hypot(nx, nz) >= R || Math.hypot(fx, fz) < r.inner) continue;
        box.min.set(x0 - 1, lo - 1, z0 - 1);
        box.max.set(x0 + P + 1, hi + 2, z0 + P + 1);
        if (!frustum.intersectsBox(box) || count >= r.maxPatches) continue;
        r.patchData.set([x0, z0, ((px * 7919 + pz * 104729) >>> 0) % 65521, 0], count * 4);
        list.push(px, pz);
        count += 1;
      }
    }
    const key = list.join(',');
    if (key !== r.key) {
      r.key = key;
      r.patchTex.needsUpdate = true;
    }
    r.mesh.count = count * r.perPatch;
  }
}

addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
});
renderer.setAnimationLoop(() => {
  updatePatches();
  renderer.render(scene, camera);
});
window.__grassProbe = () => ringDraws.map((r) => ({ radius: r.ring.radius, density: r.ring.density, lod: r.ring.lod, patch: r.patch, perPatch: r.perPatch, patches: r.mesh.count / r.perPatch, instances: r.mesh.count }));
