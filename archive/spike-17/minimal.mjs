// SPIKE 17.0 (throwaway): a neutral micro scene (lit boxes, one shadowed
// directional light, an InstancedMesh, a SkinnedMesh-free fixture) rendered by
// WebGLRenderer / WebGPURenderer(WebGPU) / WebGPURenderer(forceWebGL), headless.
// Checks that the canvas pixels are observable (page screenshot and an
// in-page readback) and measures rAF intervals.
//   node archive/spike-17/minimal.mjs [shadows=1] [count=200]
import { mkdirSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

import { chromium } from '@playwright/test';
import { build } from 'esbuild';

import { browserLaunchEnv } from '../../tests/e2e/browser-env.mjs';

const REPO = resolve(import.meta.dirname, '..', '..');
const OUT = join(homedir(), '.cache', 'thirdlight-spike17', 'minimal');
mkdirSync(OUT, { recursive: true });
const shadows = process.argv[2] !== '0';
const count = Number(process.argv[3] ?? 200);
const aa = process.argv[4] !== '0';

const src = `
import * as THREE from 'three';
import { WebGPURenderer } from 'three/webgpu';
const q = new URLSearchParams(location.search);
const mode = q.get('mode');
const canvas = document.querySelector('canvas');
const renderer = mode === 'webgl' ? new THREE.WebGLRenderer({ canvas, antialias: ${aa} }) : new WebGPURenderer({ canvas, antialias: ${aa}, forceWebGL: mode === 'webgl2' });
renderer.setSize(1280, 720, false);
renderer.shadowMap.enabled = ${shadows};
renderer.shadowMap.type = THREE.PCFShadowMap;
const scene = new THREE.Scene();
scene.background = new THREE.Color('#6d8fb3');
const cam = new THREE.PerspectiveCamera(50, 1280 / 720, 0.1, 200);
cam.position.set(0, 8, 22); cam.lookAt(0, 0, 0);
const sun = new THREE.DirectionalLight('#ffffff', 2.5); sun.position.set(6, 12, 8); sun.castShadow = ${shadows};
sun.shadow.mapSize.set(2048, 2048); Object.assign(sun.shadow.camera, { left: -20, right: 20, top: 20, bottom: -20 });
scene.add(sun, new THREE.HemisphereLight('#ffffff', '#444444', 0.8));
const ground = new THREE.Mesh(new THREE.PlaneGeometry(60, 60), new THREE.MeshStandardMaterial({ color: '#8a8a7a' }));
ground.rotation.x = -Math.PI / 2; ground.receiveShadow = true; scene.add(ground);
const box = new THREE.BoxGeometry(0.8, 0.8, 0.8);
const mats = [0xd9534f, 0x5cb85c, 0x428bca, 0xf0ad4e].map((c) => new THREE.MeshStandardMaterial({ color: c, roughness: 0.6 }));
const meshes = [];
for (let i = 0; i < ${count}; i++) { const m = new THREE.Mesh(box, mats[i % 4]); m.position.set((i % 20) - 10, 0.4 + Math.floor(i / 20) * 0.9, -5 + (i % 7)); m.castShadow = true; m.receiveShadow = true; scene.add(m); meshes.push(m); }
const inst = new THREE.InstancedMesh(new THREE.SphereGeometry(0.3, 16, 8), mats[2], 400);
const mx = new THREE.Matrix4(); for (let i = 0; i < 400; i++) { mx.makeTranslation((i % 20) - 10, 0.3, 4 + Math.floor(i / 20) * 0.7); inst.setMatrixAt(i, mx); }
inst.castShadow = true; scene.add(inst);
let frames = 0; let cpu = 0;
const loop = () => { frames++; for (const m of meshes) m.rotation.y += 0.01; const t = performance.now(); renderer.render(scene, cam); cpu += performance.now() - t; requestAnimationFrame(loop); };
(async () => {
  const t0 = performance.now();
  if (renderer.init) await renderer.init();
  window.__init = { ms: performance.now() - t0, backend: renderer.isWebGPURenderer ? (renderer.backend.isWebGPUBackend ? 'WebGPU' : 'WebGL2') : 'WebGLRenderer' };
  requestAnimationFrame(loop);
  window.__ready = true;
})();
window.__frames = () => frames; window.__cpu = () => cpu;
// In-page readback: copy the canvas into a 2D canvas right after a render.
window.__readback = async () => {
  renderer.render(scene, cam);
  const c2 = document.createElement('canvas'); c2.width = 64; c2.height = 36;
  const g = c2.getContext('2d'); g.drawImage(canvas, 0, 0, 64, 36);
  const d = g.getImageData(0, 0, 64, 36).data; const seen = new Set();
  for (let i = 0; i < d.length; i += 4) seen.add((d[i] >> 4) << 8 | (d[i + 1] >> 4) << 4 | d[i + 2] >> 4);
  return { colors: seen.size, center: [...g.getImageData(32, 18, 1, 1).data] };
};
`;
const r = await build({ stdin: { contents: src, resolveDir: REPO, loader: 'js' }, bundle: true, format: 'iife', platform: 'browser', write: false, minify: true, logLevel: 'error' });
const js = r.outputFiles[0].text;
const html = '<!doctype html><body style="margin:0;background:#0e1015"><canvas width="1280" height="720" style="width:1280px;height:720px"></canvas><script src="m.js"></script></body>';
const server = createServer((q, s) => {
  if (q.url.startsWith('/m.js')) { s.setHeader('content-type', 'text/javascript'); s.end(js); } else { s.setHeader('content-type', 'text/html'); s.end(html); }
});
await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
const url = `http://127.0.0.1:${server.address().port}/`;
// Without the Vulkan pair the adapter exists but the device dies ("Instance dropped in popErrorScope").
const args = ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--enable-unsafe-webgpu', ...(process.env.TL_SPIKE_NO_VULKAN ? [] : ['--enable-features=Vulkan', '--use-vulkan=swiftshader'])];
const rounds = Number(process.env.TL_SPIKE_ROUNDS ?? 2);
for (let round = 1; round <= rounds; round++) {
  for (const mode of ['webgl', 'webgpu', 'webgl2']) {
    const b = await chromium.launch({ env: browserLaunchEnv(), args });
    const p = await b.newPage({ viewport: { width: 1280, height: 720 } });
    const logs = [];
    p.on('console', (m) => (m.type() === 'error' || m.type() === 'warning') && logs.length < 10 && logs.push(m.text().slice(0, 200)));
    p.on('pageerror', (e) => logs.push('pageerror ' + e.message.slice(0, 200)));
    await p.goto(`${url}?mode=${mode}`);
    await p.waitForFunction(() => window.__ready === true, null, { timeout: 60_000 });
    await p.waitForTimeout(3000);
    const f0 = await p.evaluate(() => window.__frames()); const c0 = await p.evaluate(() => window.__cpu());
    const t0 = Date.now();
    await p.waitForTimeout(6000);
    const f1 = await p.evaluate(() => window.__frames()); const c1 = await p.evaluate(() => window.__cpu());
    const fps = ((f1 - f0) * 1000) / (Date.now() - t0);
    const shot = await p.screenshot();
    writeFileSync(join(OUT, `${mode}-s${shadows ? 1 : 0}-r${round}.png`), shot);
    const rb = await p.evaluate(() => window.__readback());
    const init = await p.evaluate(() => window.__init);
    console.log(JSON.stringify({ round, mode, shadows, count, aa, init, fps: +fps.toFixed(2), frameMs: +(1000 / fps).toFixed(1), renderCallMs: +((c1 - c0) / Math.max(1, f1 - f0)).toFixed(1), readback: rb, logs }));
    await b.close();
  }
}
server.close();
