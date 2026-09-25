/**
 * Phase 21.3: rendering costs, observed in the real page against a real backend.
 *
 *  - Automatic instancing: a field of 121 boxes (one colour and size, one
 *    project material on a few) is drawn in a handful of draw calls in the
 *    Scene view, in Play and in the static export — and looks the same as with
 *    instancing off (`?batching=off`, one draw per object): the export's frames
 *    are compared pixel by pixel. Picking and selection still work on a
 *    batched box (a click on the canvas selects it).
 *  - Render on demand: the idle Scene view draws no frames; a change (a
 *    command from outside) draws again, and the sync touches only the changed
 *    object (`data-sync`: processed 1 of 121+).
 *  - MSAA is the quality level's choice: the low level draws without it in
 *    the Scene view and in Play.
 */
import { existsSync, createReadStream, mkdirSync, statSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { extname, join, normalize } from 'node:path';

import { expect, test, type Page } from '@playwright/test';

import { startBackend, type E2EBackend } from './backend';
import { diff, diffPng, show, STRICT, within } from './parity';
import { decodePng } from './png';

let be: E2EBackend;
test.beforeEach(async () => {
  be = await startBackend('rendering-e2e');
});
test.afterEach(async () => {
  await be.stop();
});

let seq = 0;
async function command(op: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const q = await be.command({ op: 'queryProject', projectId: be.projectId, args: {} });
  seq += 1;
  const res = await be.command({
    op,
    projectId: be.projectId,
    expectedRevision: q['revision'],
    requestId: `req-${String(seq).padStart(32, '0')}`,
    origin: { kind: 'mcp', clientId: 'e2e-rendering' },
    args,
  });
  expect(res['ok'], JSON.stringify(res)).toBe(true);
  return res;
}

async function relay(path: string, body: unknown = {}): Promise<{ status: number; json: Record<string, unknown> }> {
  const r = await fetch(`${be.origin}/api/v1/projects/${be.projectId}/play/${path}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${be.token}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: r.status, json: (await r.json()) as Record<string, unknown> };
}

const BOXES = 121;

/** An 11 × 11 field of equal boxes around the origin (the middle one is "centre"); every tenth wears a project material. */
async function boxField(): Promise<void> {
  await command('setMaterial', { material: { materialId: 'mat-field', name: 'Field', shader: 'standard', params: { color: '#5a8f5a', roughness: 0.8, metalness: 0 }, textures: {} } });
  const entities = [];
  for (let i = 0; i < BOXES; i += 1) {
    const x = (i % 11) * 2 - 10;
    const z = Math.floor(i / 11) * 2 - 10;
    entities.push({
      id: `field-${i}`,
      name: x === 0 && z === 0 ? 'centre' : `field ${i}`,
      components: {
        transform: { position: [x, 0.5, z], rotation: [0, 0, 0, 1], scale: [1, 1, 1] },
        box: { size: [1, 1, 1], material: { color: '#b07040' } },
        ...(i % 10 === 3 ? { materials: { '*': 'mat-field' } } : {}),
      },
    });
  }
  await command('pasteEntities', { entities });
}

const attr = async (page: Page, name: string): Promise<string> => (await page.locator('canvas.tl-viewport').getAttribute(name)) ?? '';

test('repeated boxes are drawn instanced in the Scene view and Play; picking works; the idle Scene view draws nothing', async ({ page }) => {
  test.setTimeout(240_000);
  await boxField();
  await page.goto(be.editorUrl);
  await expect(page.locator('.tl-statusbar')).toContainText('connected');
  const view = page.locator('canvas.tl-viewport');

  // Instanced: two groups (the plain boxes, the project-material boxes); far fewer draws than boxes.
  await expect.poll(async () => Number((await attr(page, 'data-batches')).split(' ')[1] ?? 0), { timeout: 30_000 }).toBeGreaterThanOrEqual(BOXES - 2);
  const editorDraws = Number(await attr(page, 'data-draw-calls'));
  console.log(`[rendering] Scene view: ${editorDraws} draw calls for ${BOXES} boxes (batches ${await attr(page, 'data-batches')})`);
  expect(editorDraws).toBeGreaterThan(0);
  expect(editorDraws).toBeLessThan(BOXES / 3);

  // Render on demand: once settled, no frames while nothing changes.
  let frames = -1;
  await expect
    .poll(
      async () => {
        const now = Number(await attr(page, 'data-frames'));
        const still = now === frames;
        frames = now;
        return still;
      },
      { timeout: 30_000, intervals: [1500] },
    )
    .toBe(true);
  await page.waitForTimeout(2000);
  expect(Number(await attr(page, 'data-frames'))).toBe(frames);

  // A change from outside (another client): the view draws again and syncs only that object.
  const listed = (await be.command({ op: 'queryEntities', projectId: be.projectId, args: { limit: 200, offset: 0 } }))['entities'] as { id: string; name: string }[];
  const moved = listed.find((e) => e.name === 'field 0')!.id;
  await command('setTransform', { entityId: moved, transform: { position: [-10, 3, -10], rotation: [0, 0, 0, 1], scale: [1, 1, 1] } });
  await expect.poll(async () => Number(await attr(page, 'data-frames')), { timeout: 30_000 }).toBeGreaterThan(frames);
  const sync = JSON.parse(await attr(page, 'data-sync')) as { entities: number; processed: number; full: boolean };
  console.log(`[rendering] sync after one setTransform: ${JSON.stringify(sync)}`);
  expect(sync.full).toBe(false);
  expect(sync.processed).toBe(1);
  expect(sync.entities).toBeGreaterThan(BOXES);

  // Picking a batched box: a click on the view's middle (the field is framed around the centre box).
  const box = (await view.boundingBox())!;
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await expect(page.locator('.tl-hierarchy__list li.tl-row[aria-selected="true"]').first()).toContainText('centre', { timeout: 15_000 });
  // The selected box wears the highlighted twin of its material: it leaves its group, the rest stay instanced.
  await expect.poll(async () => (await attr(page, 'data-batches')).split(' ').map(Number)[2] ?? 0, { timeout: 15_000 }).toBeGreaterThanOrEqual(1);

  // Play: the adapter's diagnostics report the groups and this frame's draw calls.
  const started = page.waitForResponse((r) => r.request().method() === 'POST' && r.url().endsWith('/play'));
  await page.getByTitle('Start an isolated play preview').click();
  const psid = String(((await (await started).json()) as { playSessionId: string }).playSessionId);
  // (A scene without a game block runs without the game relay: the diagnostics relay answers.)
  type Diag = { batching?: { groups: number; batched: number; single: number }; frame?: { drawCalls: number } };
  const diag = async (): Promise<Diag | undefined> => ((await relay(`${psid}/diagnostics`)).json['diagnostics'] as { renderer?: Diag } | undefined)?.renderer;
  await expect.poll(async () => (await diag())?.batching?.batched ?? 0, { timeout: 60_000 }).toBeGreaterThanOrEqual(BOXES - 2);
  const d = (await diag())!;
  console.log(`[rendering] Play: ${JSON.stringify(d.batching)}, ${d.frame?.drawCalls} draw calls`);
  expect(d.frame!.drawCalls).toBeLessThan(BOXES / 3);
  await page.getByTitle('Stop the play preview').click();
});

const MIME: Record<string, string> = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json', '.wasm': 'application/wasm', '.css': 'text/css', '.png': 'image/png' };

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

test('the export draws the box field instanced and looks the same as without instancing', async ({ page }) => {
  test.setTimeout(240_000);
  await boxField();
  // The sun casts shadows: the instanced boxes cast and receive them like single ones.
  await command('setComponent', { entityId: 'light-0001', component: 'light', value: { type: 'directional', color: '#ffffff', intensity: 1.2, direction: [0.5, -1, 0.6], castShadow: true } });
  const res = await be.admin(`projects/${be.projectId}/export`);
  expect(res.status, JSON.stringify(res.json)).toBe(200);
  await page.close();
  await be.halt();
  const site = await serveDir(join(be.exportRoot, String(res.json.outputDir)));
  const out = test.info().outputPath();
  mkdirSync(out, { recursive: true });
  try {
    const frameOf = async (query: string, label: string): Promise<{ png: Buffer; draws: number }> => {
      const game = await page.context().newPage();
      await game.setViewportSize({ width: 800, height: 450 });
      await game.goto(`${site.url}${query}`);
      const canvas = game.locator('canvas').first();
      await expect.poll(async () => Number((await canvas.getAttribute('data-tl-draws')) ?? 0), { timeout: 60_000 }).toBeGreaterThan(0);
      // Two equal frames in a row: shaders compiled, the shadow map drawn.
      let last = '';
      await expect
        .poll(
          async () => {
            const png = (await canvas.screenshot()).toString('base64');
            const same = png === last;
            last = png;
            return same;
          },
          { timeout: 60_000, intervals: [1000] },
        )
        .toBe(true);
      const draws = Number(await canvas.getAttribute('data-tl-draws'));
      writeFileSync(join(out, `${label}.png`), Buffer.from(last, 'base64'));
      await game.close();
      return { png: Buffer.from(last, 'base64'), draws };
    };
    const batched = await frameOf('', 'batched');
    const single = await frameOf('?batching=off', 'single');
    console.log(`[rendering] export draw calls: ${batched.draws} instanced, ${single.draws} one per object`);
    expect(single.draws).toBeGreaterThan(BOXES);
    expect(batched.draws * 5).toBeLessThan(single.draws);
    const a = decodePng(batched.png);
    const b = decodePng(single.png);
    const d = diff(a, b, STRICT);
    if (!within(d, STRICT)) writeFileSync(join(out, 'diff.png'), diffPng(a, b));
    console.log(`[rendering] export instanced vs single: ${show(d, STRICT)}`);
    expect(within(d, STRICT), show(d, STRICT)).toBe(true);
  } finally {
    await site.close();
  }
});

test('MSAA follows the quality level: the low level draws without it in the Scene view and in Play', async ({ page }) => {
  test.setTimeout(180_000);
  await command('createEntity', { kind: 'box', name: 'cube', transform: { position: [0, 0.5, 0] }, box: { size: [1, 1, 1], material: { color: '#c05030' } } });
  await page.goto(be.editorUrl);
  await expect(page.locator('.tl-statusbar')).toContainText('connected');
  // The default (no level set: high) keeps the renderer's MSAA.
  await expect.poll(async () => Number(await attr(page, 'data-msaa')), { timeout: 30_000 }).toBeGreaterThan(0);
  await command('setEnvironment', { environment: { quality: 'low' } });
  await expect.poll(async () => attr(page, 'data-msaa'), { timeout: 30_000 }).toBe('0');
  await page.getByTitle('Start an isolated play preview').click();
  const canvas = page.frameLocator('iframe.tl-app__preview-frame').locator('canvas').first();
  await expect.poll(async () => canvas.getAttribute('data-tl-msaa'), { timeout: 60_000 }).toBe('0');
  await page.getByTitle('Stop the play preview').click();
  await command('setEnvironment', { environment: { quality: 'high' } });
  await expect.poll(async () => Number(await attr(page, 'data-msaa')), { timeout: 30_000 }).toBeGreaterThan(0);
});
