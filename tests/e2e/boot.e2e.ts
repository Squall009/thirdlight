/**
 * The boot check: the only browser test `tools/gate.sh check` runs. Each
 * test passes on "it starts and nothing errors" and nothing more: no pixel
 * bound and no time bound beyond generous start timeouts. What a feature
 * does is proven by unit tests; how it looks, by the phase's pictures.
 *
 * One backend for the file, its project holding a small made voxel world
 * (flat ground with a wall, written into the project's folder before the
 * editor opens it) under a `voxelWorld` object. The backend may open its
 * own headless editor (the MCP test). The export test stops the backend,
 * so it runs last; every other test needs only what beforeAll made, so any
 * one of them can run alone.
 *
 * "Nothing errors": no console error, no uncaught page error, no request
 * that failed or answered 4xx/5xx, on every page a test opens.
 */
import { join, resolve } from 'node:path';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { chunkGrid, createWorldStore } from '@thirdlight/voxel';
import { VOXEL_WORLDS_FOLDER, writeVoxelWorld } from '@thirdlight/workspace';

import { flatGround, placeWallBeamBanister } from '../../tools/voxel-bench/scenes';
import { TEST_WORLD_ID } from '../../tools/voxel-bench/test-world-id';
import { mustCommand } from '../support/commands';
import { serveDir } from '../support/serve-dir';
import { startBackend, type E2EBackend } from './backend';
// @ts-expect-error — a plain .mjs helper shared with the Playwright config
import { browserLibs } from './browser-env.mjs';
import { decodePng } from './png';
import { expect, test, type Page } from './pw';

const REPO = resolve(import.meta.dirname, '..', '..');
const WORLD = 'boot';
/** Generous: a cold backend, a first WebGPU pipeline build, a worker start on a loaded shared host. */
const START_MS = 60_000;

let be: E2EBackend;
let worldObject: string;

test.beforeAll(async () => {
  const libs = browserLibs() as string | undefined;
  be = await startBackend('boot-0001', undefined, { THIRDLIGHT_HEADLESS: 'on', ...(libs !== undefined ? { THIRDLIGHT_BROWSER_LIBS: libs } : {}) });
  // 48 m of flat ground round the origin with a wall, beam and banister on it: a few chunks, written in well
  // under a second, enough for the world to stream, derive and draw.
  const store = createWorldStore(chunkGrid(32));
  flatGround(store, -48, 48, -48, 48, 6, 0);
  placeWallBeamBanister(store);
  const hex = [...TEST_WORLD_ID].map((b) => b.toString(16).padStart(2, '0')).join('');
  writeVoxelWorld(join(be.projectDir, VOXEL_WORLDS_FOLDER, WORLD), { worldId: hex, edge: 32, layout: 'stacked', footprint: 512 }, store);
  const made = await mustCommand(be, 'createEntity', { sceneId: 'scene-main', parentId: null, kind: 'group', name: 'Boot world', transform: { position: [0, 0, 0] }, components: { voxelWorld: { world: WORLD } } }, { clientId: 'e2e-boot' });
  worldObject = String(made['createdId']);
});

test.afterAll(async () => {
  await be?.stop();
});

/** Everything that went wrong on a page from now on: console errors, page errors, failed or refused requests. */
function watch(page: Page): string[] {
  const out: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'error') out.push(`console: ${m.text()}`);
  });
  page.on('pageerror', (e) => out.push(`page error: ${e.message}`));
  page.on('requestfailed', (r) => out.push(`request failed: ${r.url()} (${r.failure()?.errorText ?? '?'})`));
  page.on('response', (r) => {
    if (r.status() >= 400) out.push(`response ${r.status()}: ${r.url()}`);
  });
  return out;
}

type VoxelMark = { worlds: Record<string, { chunks: number }>; problems: Record<string, string> } | null;
const sceneVoxels = async (page: Page): Promise<VoxelMark> => JSON.parse((await page.locator('canvas.tl-viewport').getAttribute('data-voxels')) ?? 'null') as VoxelMark;
const framesDrawn = async (page: Page): Promise<number> => Number((await page.locator('canvas.tl-viewport').getAttribute('data-frames')) ?? '0');

test('1. the editor loads: token, the project picker, the editor with its Scene view drawing', async ({ page }) => {
  const errors = watch(page);
  await page.goto(`${be.origin}/#token=${be.token}`);
  await page.locator('.tl-projects__open').filter({ hasText: be.projectId }).click();
  await expect(page.locator('.tl-statusbar')).toContainText('connected', { timeout: START_MS });
  await expect(page.locator('.tl-hierarchy__list li.tl-row').filter({ hasText: 'Boot world' })).toHaveCount(1);
  await expect(page.locator('.tl-inspector')).toBeVisible();
  await expect.poll(() => framesDrawn(page), { timeout: START_MS, message: 'the Scene view draws a frame' }).toBeGreaterThan(0);
  expect(errors).toEqual([]);
});

test('2. a voxel world draws in the Scene view', async ({ page }) => {
  const errors = watch(page);
  await page.goto(be.editorUrl);
  await expect(page.locator('.tl-statusbar')).toContainText('connected', { timeout: START_MS });
  // Frame the world's object (F) so the view streams round it.
  await page.locator(`.tl-hierarchy__list li[data-entity-id="${worldObject}"]`).click();
  await page.keyboard.press('f');
  await expect.poll(async () => (await sceneVoxels(page))?.worlds[WORLD]?.chunks ?? 0, { timeout: START_MS, message: 'voxel chunks drawn in the Scene view' }).toBeGreaterThan(0);
  expect((await sceneVoxels(page))?.problems).toEqual({});
  expect(errors).toEqual([]);
});

test('3. Play starts, draws the world, and stops', async ({ page }) => {
  const errors = watch(page);
  await page.goto(be.editorUrl);
  await expect(page.locator('.tl-statusbar')).toContainText('connected', { timeout: START_MS });
  await page.getByTitle('Start an isolated play preview').click();
  const frame = page.locator('iframe.tl-app__preview-frame');
  await expect(frame).toHaveCount(1, { timeout: START_MS });
  const game = page.frameLocator('iframe.tl-app__preview-frame').locator('canvas').first();
  const chunks = (): Promise<number> => game.evaluate((_c, w) => (window as unknown as { __tlVoxelPlay?: { stats(): { worlds: Record<string, { chunks: number }> } } }).__tlVoxelPlay?.stats().worlds[w]?.chunks ?? 0, WORLD);
  await expect.poll(chunks, { timeout: START_MS, message: 'Play draws the voxel world' }).toBeGreaterThan(0);
  await page.getByTitle('Stop the play preview').click();
  await expect(frame).toHaveCount(0, { timeout: START_MS });
  await expect(page.locator('.tl-statusbar')).toContainText('connected');
  expect(errors).toEqual([]);
});

test('4. an agent plays through MCP with no editor open (the headless editor)', async () => {
  test.setTimeout(3 * START_MS);
  const mcp = new Client({ name: 'thirdlight-boot', version: '0.0.0' });
  await mcp.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [join(REPO, 'dist', 'mcp-adapter', 'mcp.mjs')],
      env: { ...process.env, THIRDLIGHT_AUTHORING_ORIGIN: be.origin, THIRDLIGHT_PROJECT_ID: be.projectId, THIRDLIGHT_MCP_TOKEN: be.token } as Record<string, string>,
      stderr: 'ignore',
    }),
  );
  const call = async (name: string, args: Record<string, unknown> = {}): Promise<{ body: Record<string, unknown>; image?: { data: string; mimeType: string } }> => {
    const res = (await mcp.callTool({ name, arguments: args })) as { isError?: boolean; content: Array<{ type: string; text?: string; data?: string; mimeType?: string }> };
    const text = res.content.find((c) => c.type === 'text')?.text ?? '{}';
    expect(res.isError === true, `${name}: ${text.slice(0, 400)}`).toBe(false);
    const image = res.content.find((c) => c.type === 'image');
    return { body: JSON.parse(text) as Record<string, unknown>, ...(image !== undefined ? { image: { data: image.data!, mimeType: image.mimeType! } } : {}) };
  };
  try {
    // The pages of the tests before have closed: wait until the backend no longer counts them.
    await expect.poll(async () => ((await call('tl_sessions')).body.sessions as Array<{ connected: boolean }>).filter((s) => s.connected).length, { timeout: START_MS, message: 'no editor connected' }).toBe(0);
    const started = await call('tl_play_start', { demo: false });
    const playSessionId = String(started.body.playSessionId);
    // Until its first frame is presented the play answers `not_presented`: a start, not an error.
    const state = async (): Promise<unknown> => {
      const res = (await mcp.callTool({ name: 'tl_game_observe', arguments: { playSessionId } })) as { content: Array<{ type: string; text?: string }> };
      const body = JSON.parse(res.content.find((c) => c.type === 'text')?.text ?? '{}') as { state?: string; error?: { reason?: string; code?: string } };
      return body.state ?? body.error?.reason ?? body.error?.code;
    };
    await expect.poll(state, { timeout: START_MS, message: 'the headless play is running' }).toBe('running');
    const shot = await call('tl_screenshot', { playSessionId, maxWidth: 512 });
    expect(shot.image?.mimeType).toBe('image/png');
    const img = decodePng(Buffer.from(shot.image!.data, 'base64'));
    expect(img.width).toBeGreaterThan(0);
    await call('tl_play_stop', { playSessionId });
  } finally {
    await mcp.close();
  }
});

// Last: it stops the backend.
test('5. the export runs on its own, served statically with the backend stopped', async ({ page }) => {
  const res = await be.admin(`projects/${be.projectId}/export`);
  expect(res.status, JSON.stringify(res.json).slice(0, 400)).toBe(200);
  await be.halt();
  const site = await serveDir(join(be.exportRoot, String(res.json.outputDir)));
  const errors = watch(page);
  const outside: string[] = [];
  page.on('request', (r) => {
    if (!r.url().startsWith(site.url)) outside.push(r.url());
  });
  try {
    await page.goto(site.url);
    const game = page.locator('canvas#game');
    type Obs = { state?: string } | null;
    await expect.poll(() => game.evaluate(() => ((window as unknown as { __thirdlightObserve?: () => Obs }).__thirdlightObserve?.() ?? null)?.state ?? null), { timeout: START_MS }).toBe('running');
    const chunks = (): Promise<number> => game.evaluate((_c, w) => (window as unknown as { __tlVoxelPlay?: { stats(): { worlds: Record<string, { chunks: number }> } } }).__tlVoxelPlay?.stats().worlds[w]?.chunks ?? 0, WORLD);
    await expect.poll(chunks, { timeout: START_MS, message: 'the export draws the voxel world' }).toBeGreaterThan(0);
    expect(errors).toEqual([]);
    expect(outside, 'every request stays inside the export').toEqual([]);
  } finally {
    await site.close();
  }
});
