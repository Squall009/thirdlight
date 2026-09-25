/**
 * Phase 17.3: the neutral environment/post test scene (browser code, bundled
 * by `env-parity.e2e.ts` with esbuild). One case per page load:
 *
 *   index.html?backend=legacy|webgl2|webgpu&case=<name>
 *
 * Every case draws the same small scene (a ground, boxes near and far, a
 * rough and a mirror-like sphere, an emissive block) through the real
 * three-adapter code — `createRenderer` and `createEnvironmentRenderer` —
 * with one environment: a sky mode, fog, fog volumes, shadows, tone mapping
 * or a post effect. The WebGL reference images come from the legacy renderer
 * (`refs/*.png`); WebGPURenderer (WebGL 2 / WebGPU) must match them.
 * Textures (the sky images, the LUT) are generated here, PNG-encoded and
 * decoded with the host's own `decodeTexture` (no files, no fetch).
 *
 * When done, `window.__envCase` holds { ok, backend, reason, passes, fallback, error? }.
 */
import * as THREE from 'three';

import { createEnvironmentRenderer, createRenderer, decodeTexture, type EnvironmentLike, type FogVolumeLike, type RendererPreference } from '@thirdlight/three-adapter';

export const WIDTH = 320;
export const HEIGHT = 240;

const q = new URLSearchParams(location.search);
const backend = (q.get('backend') ?? 'legacy') as RendererPreference;
const which = q.get('case') ?? 'sky-color';

// ---- generated images --------------------------------------------------------------

async function pngTexture(w: number, h: number, fill: (x: number, y: number) => [number, number, number]): Promise<THREE.Texture> {
  const c = new OffscreenCanvas(w, h);
  const g = c.getContext('2d')!;
  const img = g.createImageData(w, h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const p = fill(x, y);
      img.data.set([p[0], p[1], p[2], 255], (y * w + x) * 4);
    }
  }
  g.putImageData(img, 0, 0);
  const blob = await c.convertToBlob({ type: 'image/png' });
  return decodeTexture(new Uint8Array(await blob.arrayBuffer()));
}

const TEXTURES: Record<string, () => Promise<THREE.Texture>> = {
  // An equirect: a blue sky gradient over a green ground, a red marker at the
  // image's horizontal centre (the view direction −Z) and a yellow one at a quarter.
  equirect: () =>
    pngTexture(256, 128, (x, y) => {
      if (Math.abs(y - 56) < 6 && Math.abs(x - 128) < 8) return [230, 40, 30];
      if (Math.abs(y - 40) < 6 && Math.abs(x - 64) < 8) return [240, 220, 40];
      return y < 64 ? [40 + y, 110 + y, 250] : [40, 170 - (y - 64), 40];
    }),
  // Six faces (+x −x +y −y +z −z), each its own colour with a darker lower half.
  ...Object.fromEntries(
    ([[220, 80, 60], [60, 200, 90], [90, 150, 255], [120, 90, 60], [240, 200, 80], [170, 90, 220]] as const).map((c, i) => [
      `face${i}`,
      () => pngTexture(32, 32, (_x, y) => (y < 16 ? [c[0], c[1], c[2]] : [c[0] * 0.5, c[1] * 0.5, c[2] * 0.5])),
    ]),
  ),
  // A LUT strip (8 tiles of 8 × 8, blue picks the tile) that warms and crushes: out = (r^0.8, g, b·0.7 + 0.1).
  lut: () =>
    pngTexture(64, 8, (x, y) => {
      const n = 8;
      const b = Math.floor(x / n) / (n - 1);
      const r = (x % n) / (n - 1);
      const g = y / (n - 1);
      return [Math.pow(r, 0.8) * 255, g * 255, (b * 0.7 + 0.1) * 255];
    }),
};

// ---- the scene -----------------------------------------------------------------------

const canvas = document.querySelector('canvas') as HTMLCanvasElement;
const scene = new THREE.Scene();
scene.background = new THREE.Color('#202428');
const camera = new THREE.PerspectiveCamera(55, WIDTH / HEIGHT, 0.1, 200);
camera.position.set(0, 1.6, 6);
camera.lookAt(0, 1.1, 0);
camera.updateMatrixWorld();
/** The direction the sun's light travels (the environment's key light). */
const SUN_DIR: [number, number, number] = [-0.45, -0.7, -0.55];
const sun = new THREE.DirectionalLight('#fff4e0', 2.2);
sun.position.set(-SUN_DIR[0] * 12, -SUN_DIR[1] * 12, -SUN_DIR[2] * 12);
sun.target.position.set(0, 0, 0);
const ambient = new THREE.AmbientLight('#8090a8', 0.5);
scene.add(sun, sun.target, ambient);

const std = (color: string, roughness = 0.6, metalness = 0, extra: THREE.MeshStandardMaterialParameters = {}): THREE.MeshStandardMaterial => new THREE.MeshStandardMaterial({ color, roughness, metalness, ...extra });
const put = <T extends THREE.Object3D>(o: T, x: number, y: number, z: number, ry = 0): T => {
  o.position.set(x, y, z);
  o.rotation.y = ry;
  o.castShadow = true;
  o.receiveShadow = true;
  scene.add(o);
  return o;
};
const ground = new THREE.Mesh(new THREE.PlaneGeometry(60, 60), std('#8a8f86', 0.9));
ground.rotation.x = -Math.PI / 2;
ground.receiveShadow = true;
scene.add(ground);
put(new THREE.Mesh(new THREE.BoxGeometry(1.2, 1.2, 1.2), std('#d8d4cc')), -1.7, 0.6, 0.4, 0.5);
put(new THREE.Mesh(new THREE.BoxGeometry(0.9, 1.8, 0.9), std('#c04a3a', 0.5)), 1.8, 0.9, -0.6, -0.3);
put(new THREE.Mesh(new THREE.SphereGeometry(0.6, 32, 16), std('#e8e8e8', 0.08, 1)), 0.1, 0.6, 1.2);
put(new THREE.Mesh(new THREE.SphereGeometry(0.5, 32, 16), std('#5a8fd0', 0.7)), -0.2, 0.5, -1.4);
// An emissive block (bloom has something above its threshold).
put(new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.5, 0.5), std('#ffffff', 0.5, 0, { emissive: '#ffd080', emissiveIntensity: 3 })), 0.9, 0.25, 2.2, 0.7);
// Far pillars (fog and depth of field see distance).
for (let i = 0; i < 5; i++) put(new THREE.Mesh(new THREE.BoxGeometry(1, 4, 1), std('#b0a890')), -8 + i * 4, 2, -14 - (i % 2) * 6);
scene.updateMatrixWorld(true);

// ---- the cases (an environment each) -------------------------------------------------

interface Case {
  env: EnvironmentLike;
  volumes?: FogVolumeLike[];
  shadows?: boolean;
  /**
   * The follow-camera shadow (the scene adapter's v4 rule): the scene and the
   * camera stand 200 m along X; the key light first shines around the origin
   * (its shadow box misses the scene), then moves there with its target
   * between frames, the way the adapter moves it with the camera.
   */
  follow?: boolean;
}
const colour: EnvironmentLike['sky'] = { mode: 'color', color: '#7ec8ff' };
const CASES: Record<string, Case> = {
  'sky-color': { env: { sky: colour } },
  'sky-procedural': { env: { sky: { mode: 'procedural', turbidity: 6, rayleigh: 1.5 } } },
  'sky-gradient': { env: { sky: { mode: 'gradient', topColor: '#2f6fd0', horizonColor: '#d8ecff', bottomColor: '#6a6a60', environmentIntensity: 1.2 } } },
  'sky-texture': { env: { sky: { mode: 'texture', texture: 'equirect', intensity: 1, environmentIntensity: 0.8 } } },
  'sky-cube': { env: { sky: { mode: 'texture', cube: ['face0', 'face1', 'face2', 'face3', 'face4', 'face5'] } } },
  'fog-linear': { env: { sky: colour, fog: { mode: 'linear', color: '#c8d4e0', near: 3, far: 26 } } },
  'fog-exp2': { env: { sky: { mode: 'gradient' }, fog: { mode: 'exp2', color: '#b8c4d0', density: 0.1 } } },
  'fog-volume': {
    env: { sky: colour },
    volumes: [
      { center: [-1.5, 1, 0.5], size: [3, 2, 2.5], density: 0.9, color: '#e0e8f0', falloff: 0.5 },
      // Phase 14.4: a height falloff — thick at the bottom, thin above.
      { center: [3, 2, -8], size: [8, 4, 6], density: 0.8, color: '#f0d8c0', falloff: 0.2, heightFalloff: 1.2 },
    ],
  },
  shadow: { env: { sky: colour }, shadows: true },
  'shadow-follow': { env: { sky: colour }, shadows: true, follow: true },
  'tone-aces': { env: { sky: colour, post: { toneMapping: 'aces', exposure: 1.3 } } },
  'tone-neutral': { env: { sky: colour, post: { toneMapping: 'neutral', exposure: 0.8 } } },
  'tone-none': { env: { sky: colour, post: { toneMapping: 'none' } } },
  grading: {
    env: {
      sky: colour,
      post: { grading: { brightness: 0.04, contrast: 0.2, saturation: -0.3, tint: '#ffe8d0', lift: 0.08, gamma: 1.2, gain: 0.95 }, vignette: { enabled: true, darkness: 0.8, offset: 1.3 } },
    },
  },
  lut: { env: { sky: colour, post: { grading: { lut: 'lut' } } } },
  bloom: { env: { sky: { mode: 'gradient' }, post: { bloom: { enabled: true, strength: 1.2, radius: 0.5, threshold: 0.7 } } } },
  ssao: { env: { sky: colour, post: { ssao: { enabled: true, radius: 0.6, intensity: 1 } } } },
  dof: { env: { sky: colour, post: { dof: { enabled: true, focus: 6, aperture: 0.004, maxBlur: 0.02 } } } },
  smaa: { env: { sky: colour, post: { antialias: 'smaa' } } },
  fxaa: { env: { sky: colour, post: { antialias: 'fxaa' } } },
  // Low quality leaves bloom, AO and depth of field out (and anti-aliasing): the plain picture.
  'quality-low': { env: { sky: colour, quality: 'low', post: { bloom: { enabled: true, threshold: 0 }, ssao: { enabled: true }, dof: { enabled: true, focus: 2 }, antialias: 'smaa' } } },
};

async function main(): Promise<void> {
  const c = CASES[which];
  if (c === undefined) throw new Error(`unknown case ${which}`);
  const handle = createRenderer({ canvas, preference: backend, source: 'url', antialias: false, clearColor: 0x000000, clearAlpha: 1 });
  const ok = await handle.whenReady();
  const info = handle.info();
  if (!ok) throw new Error(`renderer not ready: ${info.reason}`);
  const renderer = handle.current()!;
  renderer.setPixelRatio(1);
  renderer.setSize(WIDTH, HEIGHT, false);
  if (c.shadows === true) {
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFShadowMap;
    sun.castShadow = true;
    sun.shadow.mapSize.set(1024, 1024);
    const cam = sun.shadow.camera;
    cam.left = -6;
    cam.right = 6;
    cam.top = 6;
    cam.bottom = -6;
    cam.near = 0.5;
    cam.far = 30;
    cam.updateProjectionMatrix();
  }
  let pending = 0;
  const env = createEnvironmentRenderer(renderer, scene, {
    loadTexture: async (id) => {
      pending += 1;
      try {
        return TEXTURES[id] ? await TEXTURES[id]() : null;
      } finally {
        pending -= 1;
      }
    },
  });
  env.resize(WIDTH, HEIGHT);
  env.setKeyLightDirection(SUN_DIR);
  env.set(c.env);
  env.setFogVolumes(c.volumes ?? []);
  // Textures arrive through promises (and PMREM runs when they do): wait for them, then draw a few frames.
  const frame = (): Promise<void> => new Promise((r) => requestAnimationFrame(() => r()));
  for (let i = 0; i < 200 && pending > 0; i++) await frame();
  for (let i = 0; i < 3; i++) await new Promise((r) => setTimeout(r, 30));
  const FOLLOW_X = 200;
  if (c.follow === true) {
    for (const o of scene.children) if (o !== sun && o !== sun.target && o !== ambient) o.position.x += FOLLOW_X;
    camera.position.x += FOLLOW_X;
    scene.updateMatrixWorld(true);
    camera.updateMatrixWorld();
    // The light still shines around the origin: no shadow reaches the scene yet.
    for (let i = 0; i < 3; i++) {
      env.render(camera);
      await frame();
    }
    sun.position.x += FOLLOW_X;
    sun.target.position.x += FOLLOW_X;
    sun.target.updateMatrixWorld();
  }
  for (let i = 0; i < 6; i++) {
    env.render(camera);
    await frame();
  }
  // The post stack is built at the first frame and loads its LUT then: wait for it too.
  for (let i = 0; i < 200 && pending > 0; i++) await frame();
  for (let i = 0; i < 3; i++) await new Promise((r) => setTimeout(r, 30));
  for (let i = 0; i < 4; i++) {
    env.render(camera);
    await frame();
  }
  const d = env.diagnostics();
  (window as unknown as { __envCase: unknown }).__envCase = { ok: true, backend: info.backend, reason: info.reason, passes: d.passes, fallback: d.fallback };
}

main().catch((e: unknown) => {
  (window as unknown as { __envCase: unknown }).__envCase = { ok: false, error: e instanceof Error ? `${e.message}\n${e.stack ?? ''}` : String(e) };
});
