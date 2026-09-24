// SPIKE 17.0 (throwaway): does a raw WebGPU canvas clear show up headless here?
// Tries the headless shell and the full Chromium (`channel: 'chromium'`, new headless).
import { createServer } from 'node:http';

import { chromium } from '@playwright/test';

import { browserLaunchEnv } from '../../tests/e2e/browser-env.mjs';

const html = `<!doctype html><body style="margin:0;background:#00f"><canvas width="256" height="128"></canvas><script>
window.run = async () => {
  const out = {};
  const adapter = await navigator.gpu.requestAdapter();
  const device = await adapter.requestDevice();
  device.lost.then((i) => { window.lost = i.reason + ' ' + i.message; });
  device.onuncapturederror = (e) => { window.uncaptured = String(e.error.message); };
  const canvas = document.querySelector('canvas');
  const ctx = canvas.getContext('webgpu');
  const format = navigator.gpu.getPreferredCanvasFormat();
  out.format = format;
  ctx.configure({ device, format, alphaMode: 'opaque' });
  const draw = () => {
    const enc = device.createCommandEncoder();
    const p = enc.beginRenderPass({ colorAttachments: [{ view: ctx.getCurrentTexture().createView(), loadOp: 'clear', storeOp: 'store', clearValue: { r: 1, g: 0, b: 0, a: 1 } }] });
    p.end();
    device.queue.submit([enc.finish()]);
  };
  draw();
  out.step='submitted'; await Promise.race([device.queue.onSubmittedWorkDone(), new Promise((r) => setTimeout(r, 5000))]); out.step='done1';
  const c2 = document.createElement('canvas'); c2.width = 4; c2.height = 4;
  const g = c2.getContext('2d');
  draw();
  g.drawImage(canvas, 0, 0, 4, 4);
  out.readback = [...g.getImageData(1, 1, 1, 1).data];
  // GPU readback of a texture (no canvas involved).
  const tex = device.createTexture({ size: [4, 4], format: 'rgba8unorm', usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC });
  const buf = device.createBuffer({ size: 256 * 4, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
  const enc = device.createCommandEncoder();
  const p = enc.beginRenderPass({ colorAttachments: [{ view: tex.createView(), loadOp: 'clear', storeOp: 'store', clearValue: { r: 0, g: 1, b: 0, a: 1 } }] });
  p.end();
  enc.copyTextureToBuffer({ texture: tex }, { buffer: buf, bytesPerRow: 256 }, [4, 4]);
  device.queue.submit([enc.finish()]);
  const mapped = await Promise.race([buf.mapAsync(GPUMapMode.READ).then(() => true), new Promise((r) => setTimeout(() => r(false), 5000))]);
  out.textureReadback = mapped ? [...new Uint8Array(buf.getMappedRange()).slice(0, 4)] : 'mapAsync timed out';
  setInterval(draw, 16);
  out.lost = window.lost ?? null; out.uncaptured = window.uncaptured ?? null;
  return out;
};
</script></body>`;
const server = createServer((_q, s) => { s.setHeader('content-type', 'text/html'); s.end(html); });
await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
const url = `http://127.0.0.1:${server.address().port}/`;
const variants = [
  ['headless-shell', {}, []],
  ['chromium-new-headless', { channel: 'chromium' }, []],
  ['headless-shell+vulkan', {}, ['--enable-features=Vulkan', '--use-vulkan=swiftshader']],
  ['chromium-new-headless+vulkan', { channel: 'chromium' }, ['--enable-features=Vulkan', '--use-vulkan=swiftshader']],
];
for (const [name, extra, flags] of variants) {
  try {
    const b = await chromium.launch({ env: browserLaunchEnv(), ...extra, args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--enable-unsafe-webgpu', ...flags] });
    const p = await b.newPage({ viewport: { width: 256, height: 128 } });
    const errs = [];
    p.on('pageerror', (e) => errs.push(e.message));
    await p.goto(url);
    p.setDefaultTimeout(30000);
    const r = await Promise.race([p.evaluate(() => window.run()), new Promise((res) => setTimeout(() => res('run timed out'), 30000))]);
    await p.waitForTimeout(500);
    const shot = await p.screenshot({ clip: { x: 100, y: 50, width: 1, height: 1 } });
    // Raw PNG of one pixel: decode by re-rendering in page is simpler: compare to known red/blue via size heuristics is unreliable, so ask the page.
    const pix = await p.evaluate(async (b64) => {
      const img = new Image(); img.src = 'data:image/png;base64,' + b64; await img.decode();
      const c = document.createElement('canvas'); c.width = 1; c.height = 1; const g = c.getContext('2d'); g.drawImage(img, 0, 0); return [...g.getImageData(0, 0, 1, 1).data];
    }, shot.toString('base64'));
    console.log(name, b.version(), JSON.stringify({ ...r, screenshotPixel: pix, lostAfter: await p.evaluate(() => window.lost ?? null), errs }));
    await b.close();
  } catch (e) {
    console.log(name, 'failed', String(e).slice(0, 300));
  }
}
server.close();
