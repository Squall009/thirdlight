/**
 * Block-layer chunk levels of detail against a real backend, on the product's
 * own renderer (renderer-variants.ts).
 *
 * A kit model's piece has two levels (`crate_LOD0` red, `crate_LOD1` blue,
 * the same size, so the colour tells the level). A block type shows it; a
 * layer holds a row of crates near the game camera and another over 60 m
 * away (past the model's switch distance plus the chunk's radius).
 * In Play each chunk is one level-of-detail group: the near chunk draws its
 * detailed level (red pixels), the far chunk its coarse one (blue pixels);
 * the Play diagnostics count one chunk at each level. The static export,
 * served with the backend stopped, shows the same colours.
 *
 * Placed models switch at the model's own distance, with only the drawn
 * level in the scene: a marker model (`marker_LOD0` green, `marker_LOD1`
 * magenta) stands 1 m inside its switch distance on one side and 1 m outside
 * on the other (green and magenta), and a third moves to and fro across it
 * between them (both colours in turn). Play's scene holds no LOD node and no
 * hidden level, and the moving marker's matrices are written while it moves.
 */
import { randomBytes } from 'node:crypto';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { extname, join, normalize } from 'node:path';

import { expect, test } from './pw';

import { publishBytes, startBackend, type E2EBackend } from './backend';
import { multiPieceGlb } from './multi-piece-glb';
import { decodePng, type Image } from './png';
import { editorUrlFor, expectRendererBackend, exportQueryFor, onlyInItsProject, PRODUCT_RENDERER_VARIANTS } from './renderer-variants';
import { lodSwitchDistance } from '@thirdlight/three-adapter';

let be: E2EBackend | null = null;
test.afterEach(async () => {
  await be?.stop();
  be = null;
});

async function query(op: string, args: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  return be!.command({ op, projectId: be!.projectId, args });
}

async function cmd(op: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const res = await be!.command({ op, projectId: be!.projectId, expectedRevision: Number((await query('queryProject')).revision), requestId: `req-${randomBytes(16).toString('hex')}`, origin: { kind: 'mcp', clientId: 'e2e-block-lod' }, args });
  expect(res['ok'], JSON.stringify(res).slice(0, 600)).toBe(true);
  return res;
}

async function api(path: string): Promise<{ status: number; json: Record<string, unknown> }> {
  const r = await fetch(`${be!.origin}/api/v1/projects/${be!.projectId}/${path}`, { method: 'POST', headers: { authorization: `Bearer ${be!.token}`, 'content-type': 'application/json', origin: be!.origin }, body: '{}' });
  return { status: r.status, json: (await r.json()) as Record<string, unknown> };
}

function count(img: Image, test: (r: number, g: number, b: number) => boolean): number {
  let n = 0;
  for (let y = 0; y < img.height; y += 2) for (let x = 0; x < img.width; x += 2) {
    const [r, g, b] = img.pixel(x, y);
    if (test(r, g, b)) n += 1;
  }
  return n;
}
const red = (r: number, g: number, b: number): boolean => r > 110 && g < 70 && b < 70 && r > 2 * g;
const blue = (r: number, g: number, b: number): boolean => b > 60 && b > 2 * r && b > 1.5 * g;
const green = (r: number, g: number, b: number): boolean => g > 50 && g > 2 * r && g > 2 * b;
const magenta = (r: number, g: number, b: number): boolean => r > 50 && b > 50 && r > 1.5 * g && b > 1.5 * g;
/** The columns of the picture from `from` to `to` (fractions of its width). */
function band(img: Image, from: number, to: number): Image {
  const x0 = Math.floor(img.width * from);
  return { width: Math.floor(img.width * to) - x0, height: img.height, pixel: (x: number, y: number) => img.pixel(x0 + x, y) };
}

function serveDir(dir: string): Promise<{ url: string; close: () => Promise<void> }> {
  const types: Record<string, string> = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json', '.wasm': 'application/wasm' };
  const server: Server = createServer((req, res) => {
    const rel = normalize(decodeURIComponent((req.url ?? '/').split('?')[0]!)).replace(/^\/+/, '') || 'index.html';
    const file = join(dir, rel);
    if (!file.startsWith(dir) || !existsSync(file) || !statSync(file).isFile()) {
      res.statusCode = 404;
      res.end();
      return;
    }
    res.setHeader('content-type', types[extname(file)] ?? 'application/octet-stream');
    createReadStream(file).pipe(res);
  });
  return new Promise((ok) => {
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as { port: number }).port;
      ok({ url: `http://127.0.0.1:${port}/`, close: () => new Promise((done) => server.close(() => done())) });
    });
  });
}

// Which level a chunk or model draws is chosen on the CPU before the renderer: the product's renderer once (the
// parity sweeps compare the backends' pixels).
for (const variant of PRODUCT_RENDERER_VARIANTS) test(`block-layer chunks switch to the model's coarser level with distance: Play and the export (${variant})`, async ({ page }) => {
  onlyInItsProject(variant, PRODUCT_RENDERER_VARIANTS);
  test.setTimeout(300_000);
  be = await startBackend('block-lod-e2e');
  await cmd('setEnvironment', { sceneId: 'scene-main', environment: { sky: { mode: 'color', color: '#303030' } } });
  await publishBytes(be, multiPieceGlb([{ name: 'crate', lods: [[1, 1, 1], [1, 1, 1]], colors: [[1, 0.02, 0.02], [0.02, 0.05, 1]] }]), 'model', 'kit', 'Kit');
  await cmd('setBlockType', { block: { blockId: 'crate', name: 'Crate', variants: [{ model: { assetId: 'kit', piece: 'crate' } }], shape: 'full' } });
  const layer = String((await cmd('createEntity', { sceneId: 'scene-main', parentId: null, kind: 'group', name: 'Crates', transform: { position: [0, 0, 0] } }))['createdId']);
  await cmd('setComponent', { entityId: layer, component: 'blockLayer', value: { cellSize: [1, 1, 1], bounds: { min: [0, 0, 0], max: [16, 2, 96] } } });
  // A row of crates in the chunk at z 0-16 (near the camera) and one in the chunk at z 48-64 (over 60 m away).
  await cmd('editBlocks', { entityId: layer, edits: [{ kind: 'fill', box: [0, 0, 4, 16, 1, 12], cell: { block: 'crate' } }, { kind: 'fill', box: [0, 0, 52, 16, 1, 60], cell: { block: 'crate' } }] });
  // South of the crates, 6 m up, looking along +z and 15° down.
  const cam = ((await query('queryEntities', { limit: 100, offset: 0 })) as { entities: { id: string; components: Record<string, unknown> }[] }).entities.find((e) => e.components['virtualCamera'] !== undefined)!.id;
  await cmd('setTransform', { entityId: cam, transform: { position: [8, 6, -8], rotation: [0, 0.9914449, 0.1305262, 0] } });
  // A 3D project: its movers run (the 3D physics steps them).
  await cmd('setSettings', { settings: { physics_dimension: 3 } });
  // Marker models 2 m up, their LOD at the model's origin: 1 m inside and 1 m outside the switch distance, and one
  // moving between 1.5 m outside and 1.5 m inside along its line of sight (each level shows for 2 s of its 4 s round
  // trip: long enough for several screenshots, short enough that the two crossings come quickly).
  await publishBytes(be, multiPieceGlb([{ name: 'marker', lods: [[1, 1, 1], [1, 1, 1]], colors: [[0.02, 1, 0.02], [1, 0.02, 1]] }]), 'model', 'markers', 'Markers');
  const switchAt = lodSwitchDistance(Math.hypot(1, 1, 1) / 2, 1);
  const eye = [8, 6, -8] as const;
  const at = (x: number, distance: number): [number, number, number] => [x, 2, eye[2] + Math.sqrt(distance ** 2 - (x - eye[0]) ** 2 - (2 - eye[1]) ** 2)];
  const marker = async (name: string, position: [number, number, number]): Promise<string> =>
    String((await cmd('createEntity', { sceneId: 'scene-main', kind: 'model', name, model: { asset: { assetId: 'markers' }, piece: 'marker' }, transform: { position } }))['createdId']);
  await marker('inside', at(2, switchAt - 1));
  await marker('outside', at(13, switchAt + 1));
  const from = at(eye[0] - 0.5, switchAt + 1.5);
  const to = at(eye[0] - 0.5, switchAt - 1.5);
  const mover = await marker('crossing', from);
  await cmd('setComponent', { entityId: mover, component: 'mover', value: { waypoints: [[to[0] - from[0], to[1] - from[1], to[2] - from[2]]], speed: 1.5, mode: 'pingpong' } });

  await page.goto(editorUrlFor(be.editorUrl, variant));
  await expect(page.locator('.tl-statusbar')).toContainText('connected');
  await expectRendererBackend(page.locator('canvas.tl-viewport'), variant);
  // The Scene view builds the level-of-detail groups too (once the kit's geometry is in).
  await expect.poll(async () => (JSON.parse((await page.locator('.tl-viewport').getAttribute('data-block-layers')) ?? '{}') as { lods?: { chunks: number } }).lods?.chunks ?? 0, { timeout: 30_000 }).toBe(2);

  // Play: one chunk at each level; red (detailed) near, blue (coarse) far.
  const started = page.waitForResponse((r) => r.request().method() === 'POST' && r.url().endsWith('/play'));
  await page.getByTitle('Start an isolated play preview').click();
  const psid = String(((await (await started).json()) as { playSessionId: string }).playSessionId);
  await expect
    .poll(async () => {
      const r = await api(`play/${psid}/diagnostics`);
      return JSON.stringify((r.json as { diagnostics?: { renderer?: { blocks?: { lods?: { shown: number[] } } } } }).diagnostics?.renderer?.blocks?.lods?.shown ?? null);
    }, { timeout: 60_000, message: 'Play diagnostics: one chunk at each level' })
    .toBe('[1,1]');
  await expect
    .poll(async () => {
      const shot = await api(`play/${psid}/screenshot`);
      if (shot.status !== 200) return 'no screenshot';
      const img = decodePng(Buffer.from(String(shot.json.dataUrl ?? '').split(',')[1] ?? '', 'base64'));
      return `red ${count(img, red) > 300} blue ${count(img, blue) > 40}`;
    }, { timeout: 60_000, message: 'the near crates red (detailed), the far ones blue (coarse) in Play' })
    .toBe('red true blue true');
  // The markers: one green and one magenta at the sides; the moving one in the middle shows both levels in turn.
  const markers = async (): Promise<{ sides: string; middle: string }> => {
    const shot = await api(`play/${psid}/screenshot`);
    if (shot.status !== 200) return { sides: 'no screenshot', middle: '' };
    const buf = Buffer.from(String(shot.json.dataUrl ?? '').split(',')[1] ?? '', 'base64');
    const img = decodePng(buf);
    // The camera looks along the moving marker's x: it stays mid-picture, the others to its sides.
    const side = (b: Image): string => `${count(b, green) > 20 ? 'green' : ''}${count(b, magenta) > 20 ? 'magenta' : ''}`;
    const middle = band(img, 0.45, 0.55);
    return { sides: [side(band(img, 0, 0.45)), side(band(img, 0.55, 1))].sort().join(' '), middle: count(middle, green) > 20 ? 'green' : count(middle, magenta) > 20 ? 'magenta' : 'none' };
  };
  await expect.poll(async () => (await markers()).sides, { timeout: 60_000, message: 'the marker inside its switch distance green, the one outside magenta' }).toBe('green magenta');
  for (const level of ['magenta', 'green', 'magenta']) {
    await expect.poll(async () => (await markers()).middle, { timeout: 30_000, intervals: [100], message: `the moving marker crosses its switch distance (${level})` }).toBe(level);
  }
  type Graph = { objects: number; drawables: number; lights: number; bones: number; lods: number; containers: number; lodSwitches: number; unattached: number; matrixWrites: { entities: number; drawables: number } };
  const graph = async (): Promise<Graph | undefined> => ((await api(`play/${psid}/diagnostics`)).json as { diagnostics?: { renderer?: { sceneGraph?: Graph } } }).diagnostics?.renderer?.sceneGraph;
  // Only drawn levels in the scene: no LOD node, no group, no hidden level; the other levels wait unattached.
  const g = (await graph())!;
  console.log(`[block-lod] Play scene graph: ${JSON.stringify(g)}`);
  expect(g.lods).toBe(0);
  expect(g.containers).toBe(0);
  expect(g.objects).toBe(g.drawables + g.lights + g.bones);
  expect(g.lodSwitches).toBeGreaterThanOrEqual(5);
  expect(g.unattached).toBeGreaterThanOrEqual(5);
  // The moving marker's matrices are written (the rest of the scene stands still).
  await expect.poll(async () => (await graph())?.matrixWrites.drawables ?? 0, { timeout: 15_000, message: 'the moving marker placed each frame it moves' }).toBeGreaterThan(0);

  // The export with the backend stopped: the same two levels.
  const res = await be.admin(`projects/${be.projectId}/export`);
  expect(res.status, JSON.stringify(res.json)).toBe(200);
  await be.halt();
  const site = await serveDir(join(be.exportRoot, String(res.json.outputDir)));
  const game = await page.context().newPage();
  const errors: string[] = [];
  game.on('pageerror', (e) => errors.push(e.message));
  try {
    await game.goto(`${site.url}${exportQueryFor(variant)}`);
    const canvas = game.locator('canvas').first();
    await expectRendererBackend(canvas, variant);
    await expect
      .poll(async () => {
        const img = decodePng(await canvas.screenshot());
        return `red ${count(img, red) > 300} blue ${count(img, blue) > 40}`;
      }, { timeout: 60_000, message: 'the near crates red, the far ones blue in the export' })
      .toBe('red true blue true');
    expect(errors).toEqual([]);
  } finally {
    await game.close();
    await site.close();
  }
});
