// SPIKE 17.0 (throwaway): which of today's WebGL-only techniques break under
// WebGPURenderer (WebGPU backend and forced WebGL2 backend), headless here.
//   node archive/spike-17/breaks.mjs
import { createServer } from 'node:http';
import { resolve } from 'node:path';

import { chromium } from '@playwright/test';
import { build } from 'esbuild';

import { browserLaunchEnv } from '../../tests/e2e/browser-env.mjs';

const REPO = resolve(import.meta.dirname, '..', '..');
const src = `
import * as THREE from 'three';
import * as W from 'three/webgpu';
import { Sky } from 'three/examples/jsm/objects/Sky.js';
import { SkyMesh } from 'three/examples/jsm/objects/SkyMesh.js';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
const errors = [];
const origErr = console.error, origWarn = console.warn;
console.error = (...a) => { errors.push('error: ' + a.map(String).join(' ').slice(0, 160)); origErr(...a); };
console.warn = (...a) => { errors.push('warn: ' + a.map(String).join(' ').slice(0, 160)); origWarn(...a); };
window.run = async (mode) => {
  const canvas = document.querySelector('canvas');
  const r = new W.WebGPURenderer({ canvas, antialias: false, forceWebGL: mode === 'webgl2' });
  r.setSize(320, 180, false);
  await r.init();
  const cam = new THREE.PerspectiveCamera(50, 16 / 9, 0.1, 5000); cam.position.set(0, 1, 5);
  const out = { backend: r.backend.isWebGPUBackend ? 'WebGPU' : 'WebGL2', capabilities: typeof r.capabilities, infoPrograms: typeof r.info.programs };
  const center = async () => { const px = await r.readRenderTargetPixelsAsync ? null : null; return px; };
  async function test(name, fn) {
    errors.length = 0;
    try { const v = await fn(); out[name] = { ok: true, ...(v !== undefined ? { v } : {}), logs: [...new Set(errors)].slice(0, 4) }; }
    catch (e) { out[name] = { ok: false, threw: String(e).slice(0, 200), logs: [...new Set(errors)].slice(0, 4) }; }
  }
  const lit = () => { const s = new THREE.Scene(); s.add(new THREE.DirectionalLight(0xffffff, 2), new THREE.AmbientLight(0xffffff, 0.3)); return s; };
  await test('ShaderMaterial', () => { const s = lit(); s.add(new THREE.Mesh(new THREE.BoxGeometry(), new THREE.ShaderMaterial({ vertexShader: 'void main(){gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0);}', fragmentShader: 'void main(){gl_FragColor=vec4(1.0,0.0,0.0,1.0);}' }))); r.render(s, cam); });
  await test('Sky.js (ShaderMaterial procedural sky)', () => { const s = new THREE.Scene(); const k = new Sky(); k.scale.setScalar(4500); s.add(k); r.render(s, cam); });
  await test('SkyMesh (TSL procedural sky)', () => { const s = new THREE.Scene(); const k = new SkyMesh(); k.scale.setScalar(4500); s.add(k); r.render(s, cam); });
  await test('onBeforeCompile on MeshStandardMaterial', () => { let called = false; const m = new THREE.MeshStandardMaterial({ color: 0x00ff00 }); m.onBeforeCompile = () => { called = true; }; const s = lit(); s.add(new THREE.Mesh(new THREE.BoxGeometry(), m)); r.render(s, cam); return { onBeforeCompileCalled: called }; });
  await test('WebGL PMREMGenerator (three) fromScene', () => { const g = new THREE.PMREMGenerator(r); const s = new THREE.Scene(); s.background = new THREE.Color(0x336699); const t = g.fromScene(s); return { texture: !!t.texture }; });
  await test('WebGPU PMREMGenerator fromScene + scene.environment', () => { const g = new W.PMREMGenerator(r); const e = new THREE.Scene(); e.add(new THREE.Mesh(new THREE.SphereGeometry(10), new THREE.MeshBasicMaterial({ color: 0x88aaff, side: THREE.BackSide }))); const t = g.fromScene(e); const s = lit(); s.environment = t.texture; s.add(new THREE.Mesh(new THREE.SphereGeometry(1), new THREE.MeshStandardMaterial({ metalness: 1, roughness: 0.2 }))); r.render(s, cam); });
  await test('equirect texture as scene.environment (auto PMREM node)', () => { const d = new Uint8Array(64 * 32 * 4).fill(180); const t = new THREE.DataTexture(d, 64, 32); t.mapping = THREE.EquirectangularReflectionMapping; t.needsUpdate = true; const s = lit(); s.environment = t; s.background = t; s.add(new THREE.Mesh(new THREE.SphereGeometry(1), new THREE.MeshStandardMaterial())); r.render(s, cam); });
  await test('EffectComposer + RenderPass', () => { const c = new EffectComposer(r); c.addPass(new RenderPass(lit(), cam)); c.render(); });
  await test('lightMap (uv1 channel) on MeshStandardMaterial', () => { const g = new THREE.BoxGeometry(); g.setAttribute('uv1', g.getAttribute('uv').clone()); const d = new Uint8Array(4 * 4 * 4).fill(200); const lm = new THREE.DataTexture(d, 4, 4); lm.channel = 1; lm.needsUpdate = true; const s = lit(); s.add(new THREE.Mesh(g, new THREE.MeshStandardMaterial({ lightMap: lm, lightMapIntensity: 1.5 }))); r.render(s, cam); });
  await test('SkinnedMesh', () => { const g = new THREE.CylinderGeometry(0.2, 0.2, 2, 8, 4); const n = g.attributes.position.count; const si = new Uint16Array(n * 4), sw = new Float32Array(n * 4); for (let i = 0; i < n; i++) { const y = g.attributes.position.getY(i); si[i * 4] = y > 0 ? 1 : 0; sw[i * 4] = 1; } g.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(si, 4)); g.setAttribute('skinWeight', new THREE.Float32BufferAttribute(sw, 4)); const b0 = new THREE.Bone(), b1 = new THREE.Bone(); b1.position.y = 1; b0.add(b1); const m = new THREE.SkinnedMesh(g, new THREE.MeshStandardMaterial()); m.add(b0); m.bind(new THREE.Skeleton([b0, b1])); b1.rotation.z = 0.5; const s = lit(); s.add(m); r.render(s, cam); });
  await test('shadows PCF directional', () => { r.shadowMap.enabled = true; r.shadowMap.type = THREE.PCFShadowMap; const s = lit(); const l = new THREE.DirectionalLight(0xffffff, 2); l.position.set(2, 4, 3); l.castShadow = true; s.add(l); const b = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshStandardMaterial()); b.castShadow = true; const p = new THREE.Mesh(new THREE.PlaneGeometry(10, 10), new THREE.MeshStandardMaterial()); p.rotation.x = -Math.PI / 2; p.position.y = -1; p.receiveShadow = true; s.add(b, p); r.render(s, cam); });
  await test('canvas.toDataURL right after render (screenshot relay path)', () => { const s = new THREE.Scene(); s.background = new THREE.Color(0xff0000); r.render(s, cam); const url = canvas.toDataURL('image/png'); const img = new Image(); return new Promise((ok) => { img.onload = () => { const c = document.createElement('canvas'); c.width = 1; c.height = 1; const g = c.getContext('2d'); g.drawImage(img, 0, 0, 1, 1); ok({ pixel: [...g.getImageData(0, 0, 1, 1).data] }); }; img.src = url; }); });
  await test('readRenderTargetPixels (sync, lightmap baker path)', () => { const rt = new THREE.RenderTarget(4, 4); const s = new THREE.Scene(); s.background = new THREE.Color(0x00ff00); r.setRenderTarget(rt); r.render(s, cam); r.setRenderTarget(null); const buf = new Uint8Array(64); if (typeof r.readRenderTargetPixels !== 'function') throw new Error('no readRenderTargetPixels (sync) on WebGPURenderer'); r.readRenderTargetPixels(rt, 0, 0, 4, 4, buf); return { px: [...buf.slice(0, 4)] }; });
  await test('readRenderTargetPixelsAsync', async () => { const rt = new THREE.RenderTarget(4, 4); const s = new THREE.Scene(); s.background = new THREE.Color(0x00ff00); r.setRenderTarget(rt); r.render(s, cam); r.setRenderTarget(null); const px = await r.readRenderTargetPixelsAsync(rt, 0, 0, 4, 4); return { px: [...px.slice(0, 4)] }; });
  await test('fog exp2 + MeshBasicMaterial', () => { const s = lit(); s.fog = new THREE.FogExp2(0xcccccc, 0.05); s.add(new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshBasicMaterial({ color: 0xff00ff }))); r.render(s, cam); });
  return out;
};
`;
const r = await build({ stdin: { contents: src, resolveDir: REPO, loader: 'js' }, bundle: true, format: 'iife', platform: 'browser', write: false, logLevel: 'error' });
const js = r.outputFiles[0].text;
const server = createServer((q, s) => {
  if (q.url.startsWith('/b.js')) { s.setHeader('content-type', 'text/javascript'); s.end(js); } else { s.setHeader('content-type', 'text/html'); s.end('<!doctype html><canvas width=320 height=180></canvas><script src="b.js"></script>'); }
});
await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
const url = `http://127.0.0.1:${server.address().port}/`;
const args = ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--enable-unsafe-webgpu', '--enable-features=Vulkan', '--use-vulkan=swiftshader'];
for (const mode of ['webgpu', 'webgl2']) {
  const b = await chromium.launch({ env: browserLaunchEnv(), args });
  const p = await b.newPage();
  await p.goto(url);
  const out = await p.evaluate((m) => window.run(m), mode);
  console.log(`\n### ${mode}`);
  for (const [k, v] of Object.entries(out)) console.log(`${k}: ${JSON.stringify(v)}`);
  await b.close();
}
server.close();
