// SPIKE 17.0 (throwaway): which Chromium flag set gives navigator.gpu an adapter headless here?
// Run: node archive/spike-17/probe-adapter.mjs [setName]
import { createServer } from 'node:http';

import { chromium } from '@playwright/test';

import { browserLaunchEnv } from '../../tests/e2e/browser-env.mjs';

const GL = ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'];
export const FLAG_SETS = {
  base: [...GL],
  unsafe: [...GL, '--enable-unsafe-webgpu'],
  swsAdapter: [...GL, '--enable-unsafe-webgpu', '--use-webgpu-adapter=swiftshader'],
  vulkan: [...GL, '--enable-unsafe-webgpu', '--enable-features=Vulkan', '--use-vulkan=swiftshader'],
  vulkanAdapter: [...GL, '--enable-unsafe-webgpu', '--enable-features=Vulkan', '--use-vulkan=swiftshader', '--use-webgpu-adapter=swiftshader'],
  vulkanAngle: ['--use-angle=vulkan', '--enable-unsafe-swiftshader', '--enable-unsafe-webgpu', '--enable-features=Vulkan', '--use-vulkan=swiftshader', '--use-webgpu-adapter=swiftshader'],
};

const server = createServer((_q, r) => r.end('<!doctype html><title>probe</title>'));
await new Promise((res) => server.listen(0, '127.0.0.1', res));
const url = `http://127.0.0.1:${server.address().port}/`;
const only = process.argv[2];
for (const [name, args] of Object.entries(FLAG_SETS)) {
  if (only && name !== only) continue;
  const b = await chromium.launch({ env: browserLaunchEnv(), args });
  const p = await b.newPage();
  await p.goto(url); // localhost is a secure context (navigator.gpu needs one)
  const r = await p.evaluate(async () => {
    if (!('gpu' in navigator)) return `no navigator.gpu (secure=${isSecureContext})`;
    try {
      const a = await navigator.gpu.requestAdapter();
      const fb = await navigator.gpu.requestAdapter({ forceFallbackAdapter: true });
      if (!a && !fb) return 'adapter null (also forceFallbackAdapter)';
      const use = a ?? fb;
      const info = use.info ?? {};
      const d = await use.requestDevice();
      return JSON.stringify({ default: !!a, fallback: !!fb, vendor: info.vendor, arch: info.architecture, desc: info.description, isFallback: info.isFallbackAdapter, device: !!d, features: [...use.features] });
    } catch (e) {
      return `err ${e}`;
    }
  });
  console.log(name, b.version(), r);
  await b.close();
}
server.close();
