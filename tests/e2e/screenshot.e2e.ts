/**
 * Play screenshots (the relay behind `tl_screenshot`).
 *
 *  - The capture reads back the frame the renderer drew, on each backend
 *    (renderer-variants.ts): a GLB whose base colour is an embedded PNG is
 *    dragged into the scene, and the relay's PNG shows the texture's colour.
 *    On the webgpu project this is headless WebGPU (Dawn on SwiftShader
 *    without a GPU), so image textures upload there too.
 *  - A real scene's capture comes back whole: a noisy textured scene whose
 *    PNG is many times the bridge's general message bound answers over HTTP
 *    and over MCP `tl_screenshot`, on each backend.
 *  - A capture that fails always answers: the backend's reply carries the
 *    preview's reason instead of a `screenshot_timeout`, and the next
 *    capture works again; a capture too large even at the smallest width
 *    says so.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { expect, test, type Frame, type Page } from './pw';
import { BRIDGE_MESSAGE_MAX_BYTES, SCREENSHOT_DATA_URL_MAX } from '@thirdlight/protocol';

import { startBackend, type E2EBackend } from './backend';
import { multiPieceGlb } from './multi-piece-glb';
import { decodePng, type Image } from './png';
import { makePng } from './png-make';
import { backendOf, editorUrlFor, expectRendererBackend, onlyInItsProject, PRODUCT_RENDERER_VARIANTS, RENDERER_VARIANTS, type RendererVariant } from './renderer-variants';
import { projectWindow } from './ui';

let be: E2EBackend;
let dir: string;
test.beforeEach(async () => {
  be = await startBackend();
  dir = mkdtempSync(join(tmpdir(), 'tl-e2e-shot-'));
});
test.afterEach(async () => {
  await be.stop();
  rmSync(dir, { recursive: true, force: true });
});

/** Pixels that read as the texture's green (the untextured material is white/grey). */
function greenPixels(img: Image): number {
  let n = 0;
  for (let y = 0; y < img.height; y += 2) {
    for (let x = 0; x < img.width; x += 2) {
      const [r, g, b] = img.pixel(x, y);
      if (g > 50 && g > 1.8 * r && g > 1.8 * b) n += 1;
    }
  }
  return n;
}

async function screenshot(psid: string, maxWidth: number): Promise<{ status: number; json: Record<string, unknown> }> {
  const r = await fetch(`${be.origin}/api/v1/projects/${be.projectId}/play/${psid}/screenshot`, {
    method: 'POST',
    headers: { authorization: `Bearer ${be.token}`, 'content-type': 'application/json', origin: be.origin },
    body: JSON.stringify({ maxWidth }),
  });
  return { status: r.status, json: (await r.json()) as Record<string, unknown> };
}

const pngOf = (dataUrl: unknown): Image => decodePng(Buffer.from(String(dataUrl).replace(/^data:image\/png;base64,/, ''), 'base64'));

const checkerTexture = (): Buffer => makePng(32, 32, (x, y) => (((x >> 2) + (y >> 2)) % 2 === 0 ? [40, 220, 60, 255] : [20, 140, 40, 255]));

/** Seeded random colours: a texture (and so a frame) that PNG cannot compress. */
function noiseTexture(size: number): Buffer {
  let s = 0x2545f491;
  const next = (): number => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return (s >>> 0) & 255;
  };
  return makePng(size, size, () => [next(), next(), next(), 255]);
}

/** Import the textured GLB, drag it into the scene and start Play; the play id. */
async function playTexturedCrate(page: Page, variant: RendererVariant, texture = checkerTexture(), size: [number, number, number] = [2, 2, 2], extract = true): Promise<string> {
  const file = join(dir, 'crate.glb');
  writeFileSync(file, multiPieceGlb([{ name: 'crate', lods: [size] }], { texturePng: texture }));
  await page.goto(editorUrlFor(be.editorUrl, variant));
  await expect(page.locator('.tl-statusbar')).toContainText('connected');
  await expectRendererBackend(page.locator('canvas.tl-viewport'), variant);
  await projectWindow(page);
  await page.getByLabel('extract model textures').setChecked(extract);
  await page.locator('.tl-assets__file').first().setInputFiles(file);
  const publish = page.getByRole('button', { name: 'publish' });
  await expect(publish).toBeEnabled({ timeout: 15_000 });
  await publish.click();
  const tile = page.locator('.tl-assets__list li[data-asset-id]:not([data-piece])').first();
  await expect(tile).toBeVisible({ timeout: 10_000 });
  await tile.dragTo(page.locator('canvas.tl-viewport'));
  await expect(page.locator('.tl-hierarchy__list li.tl-row').filter({ hasText: 'crate' })).toHaveCount(1, { timeout: 10_000 });
  const started = page.waitForResponse((r) => r.request().method() === 'POST' && r.url().endsWith('/play'));
  await page.getByTitle('Start an isolated play preview').click();
  const psid = String(((await (await started).json()) as { playSessionId: string }).playSessionId);
  await expect(page.locator('iframe.tl-app__preview-frame')).toBeVisible();
  await expectRendererBackend(page.frameLocator('iframe.tl-app__preview-frame').locator('canvas').first(), variant);
  return psid;
}

function previewFrame(page: Page): Frame {
  const f = page.frames().find((x) => x !== page.mainFrame() && x.parentFrame() === page.mainFrame() && x.url().includes('play'));
  if (f === undefined) throw new Error(`no preview frame among ${page.frames().map((x) => x.url()).join(', ')}`);
  return f;
}

for (const variant of RENDERER_VARIANTS) {
  test(`a Play screenshot shows the frame the renderer drew, image textures included (${variant})`, async ({ page }) => {
    onlyInItsProject(variant);
    test.setTimeout(150_000);
    const psid = await playTexturedCrate(page, variant);
    // The page shows the textured crate…
    await expect.poll(async () => greenPixels(decodePng(await page.locator('iframe.tl-app__preview-frame').screenshot())), { timeout: 20_000 }).toBeGreaterThan(200);
    // …and so does the relay's capture, read back from the renderer (downscaled to maxWidth).
    const shot = await screenshot(psid, 512);
    expect(shot.status, JSON.stringify(shot.json).slice(0, 300)).toBe(200);
    const img = pngOf(shot.json['dataUrl']);
    expect(img.width).toBe(512);
    expect(shot.json['width']).toBe(512);
    expect(greenPixels(img)).toBeGreaterThan(40);
    // Opaque: the WebGPU canvas is not read as transparent.
    expect(img.pixel(2, 2)[3]).toBe(255);
    await expect(page.locator('.tl-notice')).toHaveCount(0);
  });
}

const REPO = resolve(import.meta.dirname, '..', '..');
/** A capture this big is well past the bridge's general message bound (which refused every real scene's PNG). */
const LARGE = 2 * BRIDGE_MESSAGE_MAX_BYTES;

/** Distinct colours on a 4-pixel grid. */
function distinctColours(img: Image): number {
  const colours = new Set<string>();
  for (let y = 0; y < img.height; y += 4) for (let x = 0; x < img.width; x += 4) colours.add(img.pixel(x, y).slice(0, 3).join(','));
  return colours.size;
}

/** An MCP client (stdio, the official SDK) against this test's backend. */
async function mcpClient(): Promise<Client> {
  const mcp = new Client({ name: 'thirdlight-e2e', version: '0.0.0' });
  await mcp.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [join(REPO, 'dist', 'mcp-adapter', 'mcp.mjs')],
      env: { ...process.env, THIRDLIGHT_AUTHORING_ORIGIN: be.origin, THIRDLIGHT_PROJECT_ID: be.projectId, THIRDLIGHT_MCP_TOKEN: be.token } as Record<string, string>,
      stderr: 'ignore',
    }),
  );
  return mcp;
}

// The size bound and the transport are the subject here; WebGL 2 readback is the test above's.
for (const variant of PRODUCT_RENDERER_VARIANTS) {
  test(`a large, noisy scene's screenshot comes back whole over HTTP and MCP (${variant})`, async ({ page }) => {
    onlyInItsProject(variant, PRODUCT_RENDERER_VARIANTS);
    test.setTimeout(180_000);
    // A crate with a noise texture fills much of the view: its PNG cannot be small.
    // The noise stays inside the file as it is (a KTX2 encode would merge its colours).
    const psid = await playTexturedCrate(page, variant, noiseTexture(512), [4, 4, 4], false);
    // The page shows the texture before the capture is taken.
    await expect.poll(async () => distinctColours(decodePng(await page.locator('iframe.tl-app__preview-frame').screenshot())), { timeout: 20_000 }).toBeGreaterThan(1_000);
    const t0 = Date.now();
    const shot = await screenshot(psid, 1024);
    expect(shot.status, JSON.stringify(shot.json).slice(0, 300)).toBe(200);
    expect(Date.now() - t0).toBeLessThan(10_000);
    const dataUrl = String(shot.json['dataUrl']);
    // Many times the bridge's general message bound, within the screenshot bound.
    expect(dataUrl.length).toBeGreaterThan(LARGE);
    expect(dataUrl.length).toBeLessThanOrEqual(SCREENSHOT_DATA_URL_MAX);
    const img = pngOf(dataUrl);
    expect(img.width).toBe(shot.json['width']);
    expect(img.height).toBe(shot.json['height']);
    expect(distinctColours(img)).toBeGreaterThan(1_000);

    const mcp = await mcpClient();
    try {
      const res = (await mcp.callTool({ name: 'tl_screenshot', arguments: { playSessionId: psid, maxWidth: 1024 } })) as { isError?: boolean; content: Array<{ type: string; text?: string; data?: string; mimeType?: string }> };
      const body = JSON.parse(res.content[0]!.text!) as Record<string, unknown>;
      expect(res.isError === true, JSON.stringify(body).slice(0, 300)).toBe(false);
      const image = res.content.find((c) => c.type === 'image');
      expect(image?.mimeType).toBe('image/png');
      expect(String(image?.data).length).toBeGreaterThan(LARGE);
      expect(pngOf(image?.data).width).toBe(body['width']);
    } finally {
      await mcp.close();
    }
    await expect(page.locator('.tl-notice')).toHaveCount(0);
  });
}

// One Play for both failures: the refused read is put back before the oversized one replaces it.
test('a capture that fails answers with the reason, and the next one works; one too large even at the smallest width answers with a named reason', async ({ page }) => {
  test.setTimeout(150_000);
  test.skip(test.info().project.name === 'webgpu', 'renderer-independent (the default project runs it)');
  const psid = await playTexturedCrate(page, 'auto');
  await expect.poll(async () => (await screenshot(psid, 256)).status, { timeout: 20_000 }).toBe(200);

  // The canvas refuses to be read (as a tainted or lost canvas would).
  const frame = previewFrame(page);
  await frame.evaluate(() => {
    const proto = HTMLCanvasElement.prototype as unknown as { toDataURL: unknown; __tlToDataURL?: unknown };
    proto.__tlToDataURL = proto.toDataURL;
    proto.toDataURL = () => {
      throw new DOMException('the e2e refused the read', 'SecurityError');
    };
  });
  const t0 = Date.now();
  const failed = await screenshot(psid, 256);
  expect(failed.status).toBe(503);
  const error = failed.json['error'] as { code: string; cause?: string; message: string };
  expect(error.code).toBe('relay_failed');
  expect(error.cause).toBe('screenshot_failed');
  expect(error.message).toBe('screenshot failed in the preview: PNG capture failed: SecurityError: the e2e refused the read');
  // An answer, not the relay's timeout.
  expect(Date.now() - t0).toBeLessThan(5_000);

  await frame.evaluate(() => {
    const proto = HTMLCanvasElement.prototype as unknown as { toDataURL: unknown; __tlToDataURL?: unknown };
    proto.toDataURL = proto.__tlToDataURL;
  });
  const again = await screenshot(psid, 256);
  expect(again.status, JSON.stringify(again.json).slice(0, 300)).toBe(200);
  expect(greenPixels(pngOf(again.json['dataUrl']))).toBeGreaterThan(10);

  // Every read gives a PNG over the screenshot bound.
  await frame.evaluate((max) => {
    const proto = HTMLCanvasElement.prototype as unknown as { toDataURL: unknown };
    proto.toDataURL = () => `data:image/png;base64,${'A'.repeat(max + 16)}`;
  }, SCREENSHOT_DATA_URL_MAX);
  const t1 = Date.now();
  const tooLarge = await screenshot(psid, 1024);
  expect(tooLarge.status).toBe(503);
  const largeError = tooLarge.json['error'] as { code: string; cause?: string; message: string };
  expect(largeError.cause).toBe('screenshot_failed');
  expect(largeError.message).toContain(`over the ${SCREENSHOT_DATA_URL_MAX}-character bound`);
  expect(Date.now() - t1).toBeLessThan(5_000);
});

for (const variant of PRODUCT_RENDERER_VARIANTS) {
  test(`a screenshot asked as soon as Play runs waits for the renderer's first frame (${variant})`, async ({ page }) => {
    onlyInItsProject(variant, PRODUCT_RENDERER_VARIANTS);
    test.skip(backendOf(variant) !== 'webgpu', 'the renderer starts asynchronously on WebGPU');
    test.setTimeout(150_000);
    // The Play page's WebGPU adapter arrives late (as on a loaded host): the game runs before anything is drawn.
    await page.addInitScript((delayMs) => {
      if (!location.pathname.includes('/play') || typeof GPU === 'undefined') return;
      const ask = GPU.prototype.requestAdapter;
      GPU.prototype.requestAdapter = function (this: GPU, ...args: Parameters<GPU['requestAdapter']>) {
        return new Promise((r) => setTimeout(r, delayMs)).then(() => ask.apply(this, args));
      };
    }, 2_500);
    await page.goto(editorUrlFor(be.editorUrl, variant));
    await expect(page.locator('.tl-statusbar')).toContainText('connected');
    const api = async (path: string, body: unknown): Promise<{ status: number; json: Record<string, unknown> }> => {
      const r = await fetch(`${be.origin}/api/v1/projects/${be.projectId}/${path}`, { method: 'POST', headers: { authorization: `Bearer ${be.token}`, 'content-type': 'application/json', origin: be.origin }, body: JSON.stringify(body) });
      return { status: r.status, json: (await r.json()) as Record<string, unknown> };
    };
    const started = await api('play', { options: {} });
    expect(started.status, JSON.stringify(started.json).slice(0, 300)).toBe(200);
    const psid = String(started.json['playSessionId']);
    await expect.poll(async () => (await api(`play/${psid}/observe`, {})).json['state'], { timeout: 60_000 }).toBe('running');
    // At once, no waiting and no asking again: the answer is the first frame.
    const shot = await screenshot(psid, 512);
    expect(shot.status, JSON.stringify(shot.json).slice(0, 300)).toBe(200);
    expect(pngOf(shot.json['dataUrl']).width).toBe(512);
    await expectRendererBackend(page.frameLocator('iframe.tl-app__preview-frame').locator('canvas').first(), variant);
  });
}
