/**
 * Phase 20.2: effects at runtime.
 *
 * - A burst effect named by a pickup's "collected" hook (`pickup.effect`):
 *   walking the player over the coin plays it where the coin was — magenta
 *   particles appear in Play (the preview iframe) and in the static export
 *   (backend stopped), none before the coin is collected. Per renderer:
 *   `auto` in `default` (WebGL 2: the CPU executor), `webgpu` in `webgpu`
 *   (the WebGPU compute executor); the canvas reports the executor.
 * - The Scene view plays the selected object's effect in edit mode (Gizmos →
 *   "Play selected effects"), and stops when the toggle is off.
 */
import { createHash } from 'node:crypto';
import { createReadStream, existsSync, readFileSync, statSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { extname, join, normalize } from 'node:path';

import { expect, test, type FrameLocator, type Locator, type Page } from '@playwright/test';

import { startBackend, type E2EBackend } from './backend';
import { decodePng, type Image } from './png';
import { editorUrlFor, expectRendererBackend, exportQueryFor, onlyInItsProject, type RendererVariant } from './renderer-variants';
import { menu } from './ui';

let be: E2EBackend;
test.afterEach(async () => {
  await be?.stop();
});

async function cmd(op: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const q = await be.command({ op: 'queryProject', projectId: be.projectId, args: {} });
  const res = await be.command({
    op,
    projectId: be.projectId,
    expectedRevision: q['revision'],
    requestId: `req-${createHash('sha256').update(`${op}${Math.random()}`).digest('hex').slice(0, 32)}`,
    origin: { kind: 'mcp', clientId: 'e2e-effects-runtime' },
    args,
  });
  expect(res['ok'], JSON.stringify(res)).toBe(true);
  return res;
}

function serveDir(root: string): Promise<{ url: string; close: () => Promise<void> }> {
  const MIME: Record<string, string> = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json', '.wasm': 'application/wasm' };
  const server: Server = createServer((req, res) => {
    const rel = normalize(decodeURIComponent((req.url ?? '/').split('?')[0]!)).replace(/^\/+/, '') || 'index.html';
    const file = join(root, rel);
    if (!file.startsWith(root) || !existsSync(file) || !statSync(file).isFile()) {
      res.statusCode = 404;
      res.end();
      return;
    }
    res.setHeader('content-type', MIME[extname(file)] ?? 'application/octet-stream');
    createReadStream(file).pipe(res);
  });
  return new Promise((ok) => server.listen(0, '127.0.0.1', () => ok({ url: `http://127.0.0.1:${(server.address() as { port: number }).port}/`, close: () => new Promise((d) => server.close(() => d())) })));
}

/** A system graph: the four contexts, each with its chain of blocks. */
function graph(chains: Record<string, { type: string; data?: Record<string, unknown> }[]>): { nodes: unknown[]; edges: unknown[] } {
  const nodes: { id: string; type: string; position: [number, number]; data?: Record<string, unknown> }[] = ['spawn', 'initialize', 'update', 'output'].map((c, i) => ({ id: c, type: c, position: [0, i * 200] }));
  const edges: unknown[] = [];
  let n = 0;
  for (const [ctx, blocks] of Object.entries(chains)) {
    let prev = ctx;
    for (const b of blocks) {
      const id = `b${n++}`;
      nodes.push({ id, type: b.type, position: [250 * n, 0], ...(b.data !== undefined ? { data: b.data } : {}) });
      edges.push({ id: `e${edges.length}`, from: { node: prev, port: 'then' }, to: { node: id, port: 'in' } });
      prev = id;
    }
  }
  return { nodes, edges };
}

/** A one-shot burst of bright magenta additive billboards that hang in the air for 60 s (neutral fixture). */
function burstEffect(effectId: string, loop: boolean): Record<string, unknown> {
  return {
    effectId,
    name: 'Magenta burst',
    duration: 1,
    loop,
    seed: 3,
    bounds: { center: [0, 0, 0], size: [6, 6, 6] },
    systems: [
      {
        systemId: 'sparks',
        name: 'Sparks',
        maxParticles: 800,
        space: 'world',
        graph: graph({
          spawn: loop ? [{ type: 'spawn.rate', data: { rate: 300 } }] : [{ type: 'spawn.burst', data: { count: 500 } }],
          initialize: [
            { type: 'init.position.sphere', data: { radius: loop ? 1.5 : 0.9 } },
            { type: 'init.lifetime', data: { min: loop ? 1.5 : 60, max: loop ? 1.5 : 60 } },
            { type: 'init.color', data: { color: '#ff00ff' } },
            { type: 'init.size', data: { min: loop ? 0.6 : 0.22, max: loop ? 0.8 : 0.3 } },
          ],
          output: [{ type: 'output.billboard', data: { blend: 'additive' } }],
        }),
      },
    ],
  };
}

function count(img: Image, test: (r: number, g: number, b: number) => boolean): number {
  let n = 0;
  for (let y = 0; y < img.height; y += 2) for (let x = 0; x < img.width; x += 2) {
    const [r, g, b] = img.pixel(x, y);
    if (test(r, g, b)) n += 1;
  }
  return n;
}
const magenta = (r: number, g: number, b: number): boolean => r > 150 && b > 150 && g < 0.55 * Math.min(r, b);
const shot = async (t: Locator | Page): Promise<Image> => decodePng(await t.screenshot());

const VARIANTS: readonly RendererVariant[] = ['auto', 'webgpu'];

for (const variant of VARIANTS) test(`a burst effect on a pickup's collected hook shows particles in Play and the export (${variant})`, async ({ page }) => {
  onlyInItsProject(variant);
  test.setTimeout(420_000);
  be = await startBackend('effects-runtime-e2e', 'beacon-reach');
  const executor = variant === 'webgpu' ? 'webgpu' : 'cpu';
  // The template's first stretch (its camera keeps within the level): a coin just right of the start that plays the
  // burst when collected, and a wall before the first hazard so the player stays near the burst however slow the frames are.
  await cmd('setEffect', { effect: burstEffect('fx-burst', false) });
  await cmd('createEntity', { sceneId: 'scene-main', kind: 'box', name: 'Fx coin', transform: { position: [4.5, 0.8, 0] }, box: { size: [0.4, 0.4, 0.1], material: { color: '#f2c230' } }, components: { pickup: { kind: 'coin', value: 1, effect: 'fx-burst' } } });
  await cmd('createEntity', { sceneId: 'scene-main', kind: 'box', name: 'Fx wall', transform: { position: [8.5, 1.5, 0] }, box: { size: [0.4, 3, 1], material: { color: '#404850' } }, components: { collider: { shape: { type: 'box', hx: 0.2, hy: 1.5 } } } });
  await cmd('setFlow', { flow: { levels: [{ id: 'fx-1', name: 'Effect level', scenes: ['scene-main'], spawnId: 'spawn-0002' }] } });

  /** Start a new game from the title (keyboard), walk right until the coin counts, and return the frame after it. */
  const playThrough = async (keys: Page, surface: Page | FrameLocator, target: Locator | Page, canvas: Locator, click: () => Promise<void>, hud: Locator): Promise<{ before: number; after: number }> => {
    const flow = surface.locator('.tl-flow');
    await expect(flow).toHaveAttribute('data-screen', 'title', { timeout: 60_000 });
    await click();
    await keys.keyboard.press('Enter'); // New game
    await expect(flow).toHaveAttribute('data-screen', 'playing', { timeout: 30_000 });
    await expect(canvas).toHaveAttribute('data-tl-effects', executor, { timeout: 30_000 });
    await expect(canvas).toHaveAttribute('data-tl-effects-playing', '0');
    await keys.waitForTimeout(800);
    const before = count(await shot(target), magenta);
    await keys.keyboard.down('d');
    try {
      await expect(hud).toContainText('Coins 1', { timeout: 60_000 });
    } finally {
      await keys.keyboard.up('d');
    }
    // The hook played the burst where the coin was.
    await expect(canvas).toHaveAttribute('data-tl-effects-playing', '1', { timeout: 30_000 });
    await expect(canvas).toHaveAttribute('data-tl-effects-particles', '500', { timeout: 30_000 });
    let after = 0;
    await expect.poll(async () => (after = count(await shot(target), magenta)), { timeout: 60_000 }).toBeGreaterThan(before + 400);
    return { before, after };
  };

  // Play: the preview iframe (the editor passes the renderer flag on).
  await page.goto(editorUrlFor(be.editorUrl, variant));
  await expect(page.locator('.tl-statusbar')).toContainText('connected');
  await page.getByTitle('Start an isolated play preview').click();
  const iframe = page.locator('iframe.tl-app__preview-frame');
  await expect(iframe).toBeVisible();
  const frame = page.frameLocator('iframe.tl-app__preview-frame');
  const playCanvas = frame.locator('canvas').first();
  await expectRendererBackend(playCanvas, variant);
  const play = await playThrough(page, frame, iframe, playCanvas, async () => {
    const box = await iframe.boundingBox();
    await page.mouse.click(box!.x + 20, box!.y + box!.height - 20);
  }, frame.locator('.tl-game-host-hud'));
  console.log(`[effects-runtime] ${variant} play: magenta before ${play.before}, after ${play.after}`);
  await expect(page.locator('.tl-notice')).toHaveCount(0);
  await page.getByTitle('Stop the play preview').click();

  // Export: the manifest carries the effect; served statically with the backend stopped.
  const res = await be.admin(`projects/${be.projectId}/export`);
  expect(res.status, JSON.stringify(res.json)).toBe(200);
  const out = join(be.exportRoot, String(res.json.outputDir));
  const manifest = JSON.parse(readFileSync(join(out, 'manifest.json'), 'utf8')) as { effects?: { effectId: string }[] };
  expect(manifest.effects?.map((e) => e.effectId)).toEqual(['fx-burst']);
  await page.goto('about:blank');
  await be.halt();
  const site = await serveDir(out);
  const exported = await page.context().newPage();
  const errors: string[] = [];
  exported.on('pageerror', (e) => errors.push(e.message));
  try {
    await exported.goto(`${site.url}${exportQueryFor(variant)}`);
    const canvas = exported.locator('canvas').first();
    await expectRendererBackend(canvas, variant);
    const ex = await playThrough(exported, exported, exported, canvas, () => exported.mouse.click(20, 1000), exported.locator('.tl-game-host-hud'));
    console.log(`[effects-runtime] ${variant} export: magenta before ${ex.before}, after ${ex.after}`);
    expect(errors).toEqual([]);
  } finally {
    await exported.close();
    await site.close();
  }
});

test('the Scene view plays the selected object\'s effect in edit mode (Gizmos toggle)', async ({ page }) => {
  test.skip(test.info().project.name === 'webgpu', 'the edit-mode toggle is renderer-independent UI (the default project covers it)');
  test.setTimeout(180_000);
  // A v4 project (the template): the effect component is a v4 component.
  be = await startBackend('effects-edit-e2e', 'beacon-reach');
  await cmd('setEffect', { effect: burstEffect('fx-loop', true) });
  await page.goto(be.editorUrl);
  await expect(page.locator('.tl-statusbar')).toContainText('connected');
  const created = await cmd('createEntity', { kind: 'group', name: 'Fountain', transform: { position: [0, 1, 0] } });
  const id = String(created['createdId']);
  await cmd('setComponent', { entityId: id, component: 'effect', value: { effectId: 'fx-loop' } });
  const viewport = page.locator('canvas.tl-viewport');
  const row = page.locator(`.tl-hierarchy__list li.tl-row[data-entity-id="${id}"]`);
  await expect(row).toBeVisible({ timeout: 20_000 });
  await row.click();
  await expect(row).toHaveClass(/is-selected/);
  // Frame it (F: the Scene view orbits around the selection), then come closer (the template's level is framed from far).
  await viewport.hover();
  await page.keyboard.press('f');
  for (let k = 0; k < 8; k++) await page.mouse.wheel(0, -400);
  await page.waitForTimeout(800);
  const off = count(await shot(viewport), magenta);
  // Toggle on: the effect plays around the selected object.
  await menu(page, 'Gizmos', 'Play selected effects: off');
  await expect.poll(async () => JSON.parse((await viewport.getAttribute('data-effects')) ?? '{}').particles ?? 0, { timeout: 30_000 }).toBeGreaterThan(50);
  expect(JSON.parse((await viewport.getAttribute('data-effects')) ?? '{}').executor).toBe('cpu');
  let on = 0;
  await expect.poll(async () => (on = count(await shot(viewport), magenta)), { timeout: 30_000 }).toBeGreaterThan(off + 200);
  console.log(`[effects-runtime] scene view: magenta off ${off}, on ${on}`);
  // Toggle off: nothing plays.
  await menu(page, 'Gizmos', 'Play selected effects: on');
  await expect.poll(async () => JSON.parse((await viewport.getAttribute('data-effects')) ?? '{}').preview, { timeout: 10_000 }).toBe(false);
  await expect.poll(async () => count(await shot(viewport), magenta), { timeout: 20_000 }).toBeLessThan(off + 20);
});
