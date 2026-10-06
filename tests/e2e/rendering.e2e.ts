/**
 * Rendering costs, observed in the real page against a real backend.
 *
 *  - Automatic instancing: a field of 121 boxes (one colour and size, one
 *    project material on a few) is drawn in a handful of draw calls in the
 *    Scene view, in Play and in the static export — and looks the same as with
 *    instancing off (`?batching=off`, one draw per object): the export's frames
 *    are compared pixel by pixel. Picking and selection still work on a
 *    batched box (a click on the canvas selects it).
 *  - Only what is drawn is in three.js: Play's scene holds the drawables and
 *    lights (no entity holders, empty markers or groups), and while nothing
 *    moves no matrix is written; a third of the field
 *    moved under a turned, scaled logic-only parent (keeping their places) is
 *    drawn exactly where it was, so world transforms compose without three.js.
 *  - Render on demand: the idle Scene view draws no frames; a change (a
 *    command from outside) draws again, and the sync touches only the changed
 *    object (`data-sync`: processed 1 of 121+).
 *  - MSAA is the quality level's choice: the low level draws without it in
 *    the Scene view and in Play.
 *  - Play is not paid for twice: a Scene view kept drawing by an animated
 *    material draws nothing while the Game view is in front, and draws again
 *    when it is shown (during Play and after Stop).
 *  - Render resolution and the post stack's cost: on a display with device
 *    pixel ratio 2, Play draws one drawing-buffer pixel per CSS pixel, a post
 *    stack with ambient occlusion and SMAA makes no multisampled target, and
 *    the ambient occlusion pass builds (no GPU validation error).
 */
import { existsSync, createReadStream, mkdirSync, statSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { extname, join, normalize } from 'node:path';

import { expect, test, type Page } from './pw';

import { startBackend, type E2EBackend } from './backend';
import { diff, diffPng, show, STRICT, within } from './parity';
import { showView } from './ui';
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
  await command('pasteEntities', { sceneId: 'scene-main', entities });
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

  // Render on demand: once settled, no frames while nothing changes (settled: still over half a second, then 2 s).
  let frames = -1;
  await expect
    .poll(
      async () => {
        const now = Number(await attr(page, 'data-frames'));
        const still = now === frames;
        frames = now;
        return still;
      },
      { timeout: 30_000, intervals: [500] },
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
  const batchedBefore = (await attr(page, 'data-batches')).split(' ').map(Number)[1] ?? 0;
  const box = (await view.boundingBox())!;
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await expect(page.locator('.tl-hierarchy__list li.tl-row[aria-selected="true"]').first()).toContainText('centre', { timeout: 15_000 });
  // The selection is an outline drawn over it (no material copy): the selected box stays in its batch.
  const centre = listed.find((e) => e.name === 'centre')!.id;
  await expect(view).toHaveAttribute('data-selection-outline', centre, { timeout: 15_000 });
  await expect.poll(async () => (await attr(page, 'data-batches')).split(' ').map(Number)[1] ?? 0, { timeout: 15_000 }).toBe(batchedBefore);

  // A logic-only parent with a box below it, and an empty marker: only the box is drawn in Play.
  const parent = String((await command('createEntity', { sceneId: 'scene-main', parentId: null, kind: 'group', name: 'holder', transform: { position: [0, 3, 0] } }))['createdId']);
  await command('createEntity', { sceneId: 'scene-main', parentId: parent, kind: 'box', name: 'held', transform: { position: [0, 1, 0] }, box: { size: [0.5, 0.5, 0.5], material: { color: '#3060c0' } } });
  await command('createEntity', { sceneId: 'scene-main', parentId: null, kind: 'group', name: 'marker', transform: { position: [5, 0, 5] } });
  // Play: the adapter's diagnostics report the groups and this frame's draw calls.
  const started = page.waitForResponse((r) => r.request().method() === 'POST' && r.url().endsWith('/play'));
  await page.getByTitle('Start an isolated play preview').click();
  const psid = String(((await (await started).json()) as { playSessionId: string }).playSessionId);
  // (A scene without a game block runs without the game relay: the diagnostics relay answers.)
  type Diag = {
    batching?: { groups: number; batched: number; single: number };
    frame?: { drawCalls: number };
    sceneGraph?: { objects: number; drawables: number; lights: number; bones: number; lods: number; containers: number; entities: number; listed: number; matrixWrites: { entities: number; drawables: number; posed: number }; matrixWritesTotal: number };
  };
  const diag = async (): Promise<Diag | undefined> => ((await relay(`${psid}/diagnostics`)).json['diagnostics'] as { renderer?: Diag } | undefined)?.renderer;
  await expect.poll(async () => (await diag())?.batching?.batched ?? 0, { timeout: 60_000 }).toBeGreaterThanOrEqual(BOXES - 2);
  const d = (await diag())!;
  console.log(`[rendering] Play: ${JSON.stringify(d.batching)}, ${d.frame?.drawCalls} draw calls`);
  expect(d.frame!.drawCalls).toBeLessThan(BOXES / 3);
  // The three.js scene holds drawables and lights only: the boxes, the batches, the lights. The empty marker
  // and the logic-only parent have no Object3D; the boxes' nodes stay outside the scene.
  const g = d.sceneGraph!;
  console.log(`[rendering] Play scene graph: ${JSON.stringify(g)}`);
  expect(g.containers).toBe(0);
  expect(g.lods).toBe(0);
  expect(g.objects).toBe(g.drawables + g.lights + g.bones);
  expect(g.entities).toBeGreaterThanOrEqual(BOXES + 1);
  expect(g.listed).toBeGreaterThanOrEqual(BOXES + 1);
  // Nothing moves in this scene: no entity or drawable gets a new matrix, frame after frame.
  await expect.poll(async () => JSON.stringify((await diag())?.sceneGraph?.matrixWrites), { timeout: 15_000 }).toBe(JSON.stringify({ entities: 0, drawables: 0, posed: 0 }));
  const written = (await diag())!.sceneGraph!.matrixWritesTotal;
  await page.waitForTimeout(1500);
  expect((await diag())!.sceneGraph!.matrixWritesTotal).toBe(written);
  await page.getByTitle('Stop the play preview').click();
});

/** Move every third box of the field under a turned, scaled, logic-only parent (each keeps its place in the world). */
async function boxesUnderRig(): Promise<void> {
  const rig = String((await command('createEntity', { sceneId: 'scene-main', parentId: null, kind: 'group', name: 'rig', transform: { position: [3, 1, -2], rotation: [0, Math.SQRT1_2, 0, Math.SQRT1_2], scale: [1.5, 1.5, 1.5] } }))['createdId']);
  // Pasted entities get new ids: found by name.
  const listed = (await be.command({ op: 'queryEntities', projectId: be.projectId, args: { limit: 400, offset: 0 } }))['entities'] as { id: string; name: string }[];
  const ids = listed.filter((e) => /^field \d+$/.test(e.name) && Number(e.name.slice(6)) % 3 === 0).map((e) => e.id);
  expect(ids.length).toBeGreaterThan(30);
  await command('moveEntities', { entityIds: ids, parentId: rig });
}

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
  // The same field with a third of it below a parent: a second export.
  await boxesUnderRig();
  const rigged = await be.admin(`projects/${be.projectId}/export`);
  expect(rigged.status, JSON.stringify(rigged.json)).toBe(200);
  expect(rigged.json.outputDir).not.toBe(res.json.outputDir);
  await page.close();
  await be.halt();
  const site = await serveDir(join(be.exportRoot, String(res.json.outputDir)));
  const siteRigged = await serveDir(join(be.exportRoot, String(rigged.json.outputDir)));
  const out = test.info().outputPath();
  mkdirSync(out, { recursive: true });
  try {
    const frameOf = async (path: string, label: string): Promise<{ png: Buffer; draws: number }> => {
      const game = await page.context().newPage();
      await game.setViewportSize({ width: 800, height: 450 });
      await game.goto(path);
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
    const batched = await frameOf(site.url, 'batched');
    const single = await frameOf(`${site.url}?batching=off`, 'single');
    console.log(`[rendering] export draw calls: ${batched.draws} instanced, ${single.draws} one per object`);
    expect(single.draws).toBeGreaterThan(BOXES);
    expect(batched.draws * 5).toBeLessThan(single.draws);
    const a = decodePng(batched.png);
    const b = decodePng(single.png);
    const d = diff(a, b, STRICT);
    if (!within(d, STRICT)) writeFileSync(join(out, 'diff.png'), diffPng(a, b));
    console.log(`[rendering] export instanced vs single: ${show(d, STRICT)}`);
    expect(within(d, STRICT), show(d, STRICT)).toBe(true);
    // Parents compose in the engine's world table: the parented boxes are drawn where the flat ones were.
    const parented = await frameOf(siteRigged.url, 'parented');
    const c = decodePng(parented.png);
    const dp = diff(a, c, STRICT);
    if (!within(dp, STRICT)) writeFileSync(join(out, 'diff-parented.png'), diffPng(a, c));
    console.log(`[rendering] export flat vs parented: ${show(dp, STRICT)}`);
    expect(within(dp, STRICT), show(dp, STRICT)).toBe(true);
  } finally {
    await site.close();
    await siteRigged.close();
  }
});

test('MSAA follows the quality level: the low level draws without it in the Scene view and in Play', async ({ page }) => {
  test.setTimeout(180_000);
  await command('createEntity', { sceneId: 'scene-main', kind: 'box', name: 'cube', transform: { position: [0, 0.5, 0] }, box: { size: [1, 1, 1], material: { color: '#c05030' } } });
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

test('the Scene view draws nothing behind the Game view during Play, and again when shown', async ({ page }) => {
  test.setTimeout(180_000);
  // Water is animated: it keeps the Scene view drawing every frame.
  await command('setMaterial', { material: { materialId: 'mat-water', name: 'Water', shader: 'water', params: { color: '#3070a0' }, textures: {} } });
  await command('pasteEntities', { sceneId: 'scene-main',
    entities: [{ id: 'pond', name: 'pond', components: { transform: { position: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] }, box: { size: [4, 0.2, 4], material: { color: '#3070a0' } }, materials: { '*': 'mat-water' } } }],
  });
  await page.goto(be.editorUrl);
  await expect(page.locator('.tl-statusbar')).toContainText('connected');
  const frames = async (): Promise<number> => Number(await attr(page, 'data-frames'));
  /**
   * Frames the Scene view drew in `ms`. The animated water keeps a drawing view at the display rate (tens of frames a
   * second), so half a second with over 5 frames shows it drawing and a second with none shows it stopped.
   */
  const drawn = async (ms: number): Promise<number> => {
    const a = await frames();
    await page.waitForTimeout(ms);
    return (await frames()) - a;
  };
  await expect.poll(async () => drawn(500), { timeout: 60_000 }).toBeGreaterThan(5);

  await page.getByTitle('Start an isolated play preview').click();
  await expect(page.frameLocator('iframe.tl-app__preview-frame').locator('canvas').first()).toHaveAttribute('data-tl-renderer-state', 'ready', { timeout: 90_000 });
  await expect(page.locator('canvas.tl-viewport')).toHaveAttribute('data-suspended', 'true');
  expect(await drawn(1000)).toBe(0);

  // The Scene view shown during Play draws again, and stops when the Game view is back in front.
  await showView(page, 'Scene');
  await expect(page.locator('canvas.tl-viewport')).toHaveAttribute('data-suspended', 'false');
  await expect.poll(async () => drawn(500), { timeout: 30_000 }).toBeGreaterThan(5);
  await showView(page, 'Game');
  await expect(page.locator('canvas.tl-viewport')).toHaveAttribute('data-suspended', 'true');
  expect(await drawn(1000)).toBe(0);

  await page.getByTitle('Stop the play preview').click();
  await expect(page.locator('canvas.tl-viewport')).toHaveAttribute('data-suspended', 'false', { timeout: 30_000 });
  await expect.poll(async () => drawn(500), { timeout: 30_000 }).toBeGreaterThan(5);
});

/**
 * In every frame: the GPU targets made (WebGPU textures, WebGL 2 multisampled
 * storage) and their sample counts, read at the API the renderer calls.
 */
function watchTargets(): void {
  const w = window as unknown as { __tlTargets?: { samples: number; w: number; h: number }[] };
  w.__tlTargets = [];
  const seen = w.__tlTargets;
  const D = (globalThis as unknown as { GPUDevice?: { prototype: { createTexture: (d: GPUTextureDescriptor) => GPUTexture } } }).GPUDevice?.prototype;
  if (D !== undefined) {
    const create = D.createTexture;
    D.createTexture = function (this: unknown, d: GPUTextureDescriptor) {
      const size = d.size as { width?: number; height?: number } | number[];
      seen.push({ samples: d.sampleCount ?? 1, w: Array.isArray(size) ? (size[0] ?? 0) : (size.width ?? 0), h: Array.isArray(size) ? (size[1] ?? 1) : (size.height ?? 1) });
      return create.call(this, d);
    };
  }
  const G = (globalThis as unknown as { WebGL2RenderingContext?: { prototype: WebGL2RenderingContext } }).WebGL2RenderingContext?.prototype;
  if (G !== undefined) {
    const storage = G.renderbufferStorageMultisample;
    G.renderbufferStorageMultisample = function (this: WebGL2RenderingContext, target: number, samples: number, format: number, width: number, height: number) {
      seen.push({ samples, w: width, h: height });
      storage.call(this, target, samples, format, width, height);
    };
  }
}

test.describe('on a HiDPI display', () => {
  test.use({ deviceScaleFactor: 2 });

  test('Play renders at one pixel per CSS pixel; the AO + SMAA post stack is not multisampled and builds', async ({ page }) => {
    test.setTimeout(180_000);
    await command('createEntity', { sceneId: 'scene-main', kind: 'box', name: 'ground', transform: { position: [0, -0.5, 0] }, box: { size: [20, 1, 20], material: { color: '#808080' } } });
    await command('createEntity', { sceneId: 'scene-main', kind: 'box', name: 'cube', transform: { position: [0, 0.5, 0] }, box: { size: [1, 1, 1], material: { color: '#c05030' } } });
    await command('setEnvironment', { sceneId: 'scene-main', environment: { post: { antialias: 'smaa', ssao: { enabled: true, radius: 0.5, intensity: 1 } } } });
    await page.addInitScript(watchTargets);
    const gpuErrors: string[] = [];
    page.on('console', (m) => {
      if (/GPUValidationError|Invalid RenderPipeline|pipeline creation failed/i.test(m.text())) gpuErrors.push(m.text().slice(0, 300));
    });
    await page.goto(be.editorUrl);
    await expect(page.locator('.tl-statusbar')).toContainText('connected');
    await page.getByTitle('Start an isolated play preview').click();
    const frame = page.frameLocator('iframe.tl-app__preview-frame');
    const canvas = frame.locator('canvas').first();
    await expect.poll(async () => canvas.getAttribute('data-tl-renderer-state'), { timeout: 90_000 }).toBe('ready');
    // A few frames of the post stack (its passes are built on the first).
    await expect.poll(async () => canvas.evaluate(() => (window as unknown as { __tlTargets?: unknown[] }).__tlTargets?.length ?? 0), { timeout: 60_000 }).toBeGreaterThan(0);
    await page.waitForTimeout(2000);
    const size = await canvas.evaluate((c: HTMLCanvasElement) => ({ buffer: c.width, css: Math.round(c.getBoundingClientRect().width), dpr: window.devicePixelRatio }));
    expect(size.dpr).toBe(2);
    expect(size.buffer).toBe(size.css);
    const targets = await canvas.evaluate(() => (window as unknown as { __tlTargets: { samples: number; w: number; h: number }[] }).__tlTargets);
    expect(targets.filter((t) => t.samples > 1), 'multisampled targets').toEqual([]);
    expect(gpuErrors).toEqual([]);
    await page.getByTitle('Stop the play preview').click();
  });
});
