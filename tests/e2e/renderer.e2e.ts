/**
 * Phase 17.1: the renderer backend choice — the project setting
 * (`render_backend`, from the settings form) and the page URL flag
 * (`?renderer=`) pick the backend of the Scene view, Play and the standalone
 * export; each reports the backend and why (the canvas `data-tl-renderer*`
 * attributes, the status bar, the Play label, `tl_game_observe` and
 * `tl_diagnostics`), and each draws visible (non-black) pixels.
 *
 * Runs in both Playwright projects: `default` has no WebGPU (a forced or
 * automatic WebGPU choice runs on the WebGL 2 backend and says why); `webgpu`
 * launches Chromium with headless WebGPU (Dawn on SwiftShader).
 */
import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { extname, join, normalize, resolve } from 'node:path';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { expect as baseExpect, test, type Locator, type Page } from '@playwright/test';

import { startBackend, type E2EBackend } from './backend';
import { decodePng, type Image } from './png';
import { menu } from './ui';

// WebGPU initialisation and SwiftShader frames are slow on a loaded host: poll generously.
const expect = baseExpect.configure({ timeout: 30_000 });
const REPO = resolve(import.meta.dirname, '..', '..');

let be: E2EBackend | null = null;
test.afterEach(async () => {
  await be?.stop();
  be = null;
});
/** A fresh project (tests add a box), or a template (a game: tl_game_observe needs one). */
async function backend(template?: string): Promise<E2EBackend> {
  be = await startBackend('renderer-e2e', template);
  return be;
}

/** Does this Playwright project give the page a working WebGPU adapter? */
const hasWebGpu = (): boolean => test.info().project.name === 'webgpu';
/** The backend a preference ends up on in this project. */
const expected = (preference: 'auto' | 'webgpu' | 'webgl2' | 'legacy'): string => (preference === 'legacy' ? 'legacy' : preference === 'webgl2' ? 'webgl2' : hasWebGpu() ? 'webgpu' : 'webgl2');

/** Non-black pixels: brighter than `threshold` in any channel (the lit box, not the black clear colour). */
function brightPixels(img: Image, threshold = 40): number {
  let n = 0;
  for (let y = 0; y < img.height; y += 2) {
    for (let x = 0; x < img.width; x += 2) {
      const [r, g, b] = img.pixel(x, y);
      if (Math.max(r, g, b) > threshold) n += 1;
    }
  }
  return n;
}

/** The renderer attributes the factory writes on a canvas. */
async function rendererOf(canvas: Locator): Promise<{ backend: string | null; state: string | null; reason: string | null }> {
  return canvas.evaluate((c) => ({ backend: c.getAttribute('data-tl-renderer'), state: c.getAttribute('data-tl-renderer-state'), reason: c.getAttribute('data-tl-renderer-reason') }));
}

const MIME: Record<string, string> = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json', '.wasm': 'application/wasm' };

/** A plain static file server: the exported game gets nothing else. */
function serveDir(dir: string): Promise<{ url: string; close: () => Promise<void> }> {
  const server: Server = createServer((req, res) => {
    const rel = normalize(decodeURIComponent((req.url ?? '/').split('?')[0]!)).replace(/^\/+/, '') || 'index.html';
    const file = join(dir, rel);
    if (!file.startsWith(dir) || !existsSync(file) || !statSync(file).isFile()) {
      res.statusCode = 404;
      res.end();
      return;
    }
    res.setHeader('content-type', MIME[extname(file)] ?? 'application/octet-stream');
    createReadStream(file).pipe(res);
  });
  return new Promise((ok) => {
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as { port: number }).port;
      ok({ url: `http://127.0.0.1:${port}/`, close: () => new Promise((done) => server.close(() => done())) });
    });
  });
}

/** The editor URL with a `?renderer=` flag (before the token fragment). */
const withFlag = (url: string, preference: string): string => url.replace('#', `&renderer=${preference}#`);

async function openWithBox(page: Page, url: string): Promise<void> {
  await page.goto(url);
  await expect(page.locator('.tl-statusbar')).toContainText('connected');
  await menu(page, 'GameObject', 'Box');
  await expect(page.locator('.tl-hierarchy__list li.tl-row').filter({ hasText: 'box' })).toHaveCount(1);
}

/** The Scene view reports `backend` ready and draws the box. */
async function expectSceneView(page: Page, backend: string, reasonPart: string): Promise<void> {
  const canvas = page.locator('canvas.tl-viewport');
  await expect.poll(async () => (await rendererOf(canvas)).state).toBe('ready');
  const r = await rendererOf(canvas);
  expect(r.backend).toBe(backend);
  expect(r.reason).toContain(reasonPart);
  await expect(page.locator('.tl-statusbar__renderer')).toHaveAttribute('data-render-backend', backend);
  await expect.poll(async () => brightPixels(decodePng(await canvas.screenshot()))).toBeGreaterThan(20);
}

/** Play reports `backend` ready (canvas, Play label) and draws the box. */
async function expectPlay(page: Page, backend: string, reasonPart: string): Promise<void> {
  const frame = page.locator('iframe.tl-app__preview-frame');
  await expect(frame).toBeVisible();
  const canvas = page.frameLocator('iframe.tl-app__preview-frame').locator('canvas').first();
  await expect.poll(async () => (await rendererOf(canvas)).state).toBe('ready');
  const r = await rendererOf(canvas);
  expect(r.backend).toBe(backend);
  expect(r.reason).toContain(reasonPart);
  // The Play label line (from the play's observation).
  await expect(page.locator('.tl-app__preview-renderer')).toHaveAttribute('data-render-backend', backend);
  await expect(page.locator('.tl-app__preview-renderer')).toContainText(reasonPart);
  await expect.poll(async () => brightPixels(decodePng(await frame.screenshot()))).toBeGreaterThan(20);
}

/** The export served statically (backend stopped) reports `backend` for `query` and draws the box. */
async function expectExport(page: Page, siteUrl: string, query: string, backend: string, reasonPart: string): Promise<void> {
  const game = await page.context().newPage();
  const errors: string[] = [];
  game.on('pageerror', (e) => errors.push(e.message));
  try {
    await game.goto(`${siteUrl}${query}`);
    const canvas = game.locator('canvas').first();
    await expect.poll(async () => (await rendererOf(canvas)).state).toBe('ready');
    const r = await rendererOf(canvas);
    expect(r.backend).toBe(backend);
    expect(r.reason).toContain(reasonPart);
    await expect.poll(async () => brightPixels(decodePng(await game.screenshot()))).toBeGreaterThan(20);
    expect(errors).toEqual([]);
  } finally {
    await game.close();
  }
}

test('by default everything draws with the legacy WebGL renderer and says so', async ({ page }) => {
  test.setTimeout(180_000);
  const be = await backend();
  await openWithBox(page, be.editorUrl);
  await expectSceneView(page, 'legacy', 'default legacy');
  await page.getByTitle('Start an isolated play preview').click();
  await expectPlay(page, 'legacy', 'default legacy');
});

test('the project setting picks the backend of the Scene view, Play (tl_game_observe, tl_diagnostics) and the export', async ({ page }) => {
  test.setTimeout(300_000);
  // A game (Beacon Reach, the neutral template): tl_game_observe answers only for a game.
  const be = await backend('beacon-reach');
  await page.goto(be.editorUrl);
  await expect(page.locator('.tl-statusbar')).toContainText('connected');
  // The setting is a select in the descriptor-built settings form.
  await page.getByRole('tab', { name: 'Gameplay' }).click();
  await page.locator('.tl-gameplay__tabs').getByRole('button', { name: 'settings', exact: true }).click();
  const field = page.getByLabel('gameplay settings').getByLabel('settings render_backend', { exact: true });
  await expect(field).toHaveValue('0');
  await expect(field.locator('option')).toHaveText(['WebGL (legacy)', 'Auto (WebGPU, else WebGL 2)', 'WebGPU', 'WebGL 2 (WebGPU renderer)']);
  await field.selectOption('2');
  const want = expected('webgpu');
  // The Scene view switches at once (a fresh canvas)…
  await expectSceneView(page, want, 'project setting webgpu');
  // …and picks it up again when the editor opens the project.
  await page.reload();
  await expect(page.locator('.tl-statusbar')).toContainText('connected');
  await expectSceneView(page, want, 'project setting webgpu');
  if (!hasWebGpu()) await expect(page.locator('canvas.tl-viewport')).toHaveAttribute('data-tl-renderer-reason', /WebGPU unavailable/);

  // Play, started by an MCP agent: the observation and the diagnostics carry the choice.
  const mcp = new Client({ name: 'thirdlight-e2e', version: '0.0.0' });
  await mcp.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [join(REPO, 'dist', 'mcp-adapter', 'mcp.mjs')],
      env: { ...process.env, THIRDLIGHT_AUTHORING_ORIGIN: be.origin, THIRDLIGHT_PROJECT_ID: be.projectId, THIRDLIGHT_MCP_TOKEN: be.token } as Record<string, string>,
      stderr: 'ignore',
    }),
  );
  const call = async (name: string, args: Record<string, unknown> = {}): Promise<{ isError: boolean; body: Record<string, unknown> }> => {
    const res = (await mcp.callTool({ name, arguments: args })) as { isError?: boolean; content: Array<{ type: string; text: string }> };
    return { isError: res.isError === true, body: JSON.parse(res.content[0]!.text) as Record<string, unknown> };
  };
  try {
    const sessions = (await call('tl_sessions')).body.sessions as Array<{ sessionId: string; connected: boolean }>;
    const started = await call('tl_play_start', { demo: false, sessionId: sessions.find((s) => s.connected)!.sessionId });
    expect(started.isError, JSON.stringify(started.body)).toBe(false);
    const playSessionId = String(started.body.playSessionId);
    await expectPlay(page, want, 'project setting webgpu');
    const observed = (await call('tl_game_observe', { playSessionId })).body as { renderer?: { backend: string; state: string; reason: string; requested: string; source: string } };
    expect(observed.renderer).toMatchObject({ backend: want, state: 'ready', requested: 'webgpu', source: 'setting' });
    expect(observed.renderer?.reason).toContain('project setting webgpu');
    const diag = await call('tl_diagnostics', { playSessionId });
    expect(diag.isError, JSON.stringify(diag.body)).toBe(false);
    const block = JSON.stringify(diag.body);
    expect(block).toContain(`"backend":"${want}"`);
    expect(block).toContain('project setting webgpu');
    expect(block).toContain(`"renderBackend":"${want === 'webgpu' ? 'webgpu' : 'webgl2'}"`);
    expect((await call('tl_play_stop', { playSessionId })).isError).toBe(false);
  } finally {
    await mcp.close();
  }

  // The export keeps the project setting (and the URL flag still overrides it there).
  const res = await be.admin(`projects/${be.projectId}/export`);
  expect(res.status, JSON.stringify(res.json)).toBe(200);
  await be.halt();
  const site = await serveDir(join(be.exportRoot, String(res.json.outputDir)));
  try {
    await expectExport(page, site.url, '', want, 'project setting webgpu');
    await expectExport(page, site.url, '?renderer=legacy', 'legacy', 'URL flag ?renderer=legacy');
  } finally {
    await site.close();
  }
});

test('the ?renderer= URL flag forces a backend in the Scene view, Play and the export', async ({ page }) => {
  test.setTimeout(300_000);
  const be = await backend();
  await openWithBox(page, withFlag(be.editorUrl, 'webgl2'));
  await expectSceneView(page, 'webgl2', 'URL flag ?renderer=webgl2');
  // The editor passes its flag on to the play page.
  await page.getByTitle('Start an isolated play preview').click();
  await expectPlay(page, 'webgl2', 'URL flag ?renderer=webgl2');
  await page.getByTitle('Stop the play preview').click();

  const res = await be.admin(`projects/${be.projectId}/export`);
  expect(res.status, JSON.stringify(res.json)).toBe(200);
  await be.halt();
  const site = await serveDir(join(be.exportRoot, String(res.json.outputDir)));
  try {
    await expectExport(page, site.url, '?renderer=webgl2', 'webgl2', 'URL flag ?renderer=webgl2');
    await expectExport(page, site.url, '?renderer=webgpu', expected('webgpu'), 'URL flag ?renderer=webgpu');
    await expectExport(page, site.url, '?renderer=auto', expected('auto'), hasWebGpu() ? 'WebGPU on' : 'WebGL 2 backend');
  } finally {
    await site.close();
  }
});
