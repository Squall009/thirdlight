/**
 * Material parameters set per object by a script, against
 * a real backend, on a neutral fixture built by commands on a blank project.
 *
 * - Editor: a data parameter is declared in the material document (type
 *   "data", its grid size) — the UI path of the new parameter kind.
 * - The material: unlit, colour = mix(tint, cell.rgb, cell.a), the cell read
 *   by Sample data at the UV from a 4 × 4 data parameter. Two flat boxes wear
 *   it; the Scene view shows both in the default tint (green).
 * - Play: a script changes the tint of box A only (two blues, alternating
 *   every 12 steps) and writes a 4 × 4 checker (red / transparent) into box
 *   B's grid. Pixels: A is blue without green, B keeps its green tint with
 *   red cells exactly where the checker puts them (cell [0, 0] at the bottom
 *   left, UV (0, 0)). The renderer counters: one compiled graph material for
 *   both objects, and the program count and draw calls do not move while the
 *   values keep changing (no recompile per value).
 * - The static export (backend stopped) draws the same.
 *
 * Runs per renderer: WebGL 2 in `default`, WebGPU in `webgpu`.
 */
import { createHash, randomBytes } from 'node:crypto';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { extname, join, normalize } from 'node:path';

import { expect, test, type Locator, type Page } from './pw';

import { startBackend, type E2EBackend } from './backend';
import { decodePng, type Image } from './png';
import { editorUrlFor, expectRendererBackend, exportQueryFor, onlyInItsProject, PRODUCT_RENDERER_VARIANTS, type RendererVariant } from './renderer-variants';
import { closeEditor, openEditor } from './ui';

let be: E2EBackend | null = null;
test.afterEach(async () => {
  await be?.stop();
  be = null;
});

async function query(op: string, args: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  return be!.command({ op, projectId: be!.projectId, args });
}
async function cmd(op: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const revision = Number((await query('queryProject')).revision);
  const res = await be!.command({ op, projectId: be!.projectId, expectedRevision: revision, requestId: `req-${randomBytes(16).toString('hex')}`, origin: { kind: 'mcp', clientId: 'e2e-material-runtime' }, args });
  expect(res['ok'], JSON.stringify(res)).toBe(true);
  return res;
}
async function api(path: string, body: unknown): Promise<{ status: number; json: Record<string, unknown> }> {
  const r = await fetch(`${be!.origin}/api/v1/projects/${be!.projectId}/${path}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${be!.token}`, 'content-type': 'application/json', origin: be!.origin },
    body: JSON.stringify(body),
  });
  return { status: r.status, json: (await r.json()) as Record<string, unknown> };
}

/** Publish a behavior with entityRef properties and attach it to `entityId` with `values`. */
async function script(behaviorId: string, source: string, entityId: string, props: string[], values: Record<string, unknown>): Promise<void> {
  const bytes = Buffer.from(`${JSON.stringify({ graphVersion: 1, entryPath: 'src/index.ts', requiredModules: ['@thirdlight/runtime'], ownedTransforms: [], files: [{ path: 'src/index.ts', text: source }] }, null, 2)}\n`);
  const stage = await api('content/stages', {});
  const stageId = String(stage.json.stageId);
  const put = await fetch(`${be!.origin}/api/v1/projects/${be!.projectId}/content/stages/${stageId}/bytes`, {
    method: 'PUT',
    headers: { authorization: `Bearer ${be!.token}`, origin: be!.origin, 'content-type': 'application/octet-stream', 'x-thirdlight-offset': '0', 'x-thirdlight-total': String(bytes.length) },
    body: bytes,
  });
  expect(put.status).toBe(200);
  const declaration = { properties: props.map((key) => ({ key, label: key, type: 'entityRef', default: null })) };
  await cmd('publishBehavior', { behaviorId, displayName: behaviorId, mode: 'declaration-create', declaration });
  await cmd('acknowledgeBehaviorTrust', { sourceDigest: createHash('sha256').update(bytes).digest('hex') });
  const published = await api('content/behaviors/source', { stageId, behaviorId, displayName: behaviorId, declaration, expectedRevision: Number((await query('queryProject')).revision), requestId: `req-${randomBytes(16).toString('hex')}` });
  expect(published.status, JSON.stringify(published.json)).toBe(200);
  await cmd('setBehaviorProperties', { entityId, behaviorId, values });
}

/**
 * Every 60 steps: box A's tint (two blues in turn — each change must reuse the
 * shared program) and a 4 × 4 checker into box B's grid (red where x + y is
 * even, transparent elsewhere).
 */
const PAINTER = [
  'export default {',
  '  instantiate() { return {}; },',
  '  step(state: unknown, ctx: any) {',
  "    if (ctx.phase !== 'intent' || ctx.materials === undefined || ctx.stepIndex % 12 !== 0) return;",
  '    const p = ctx.properties;',
  "    ctx.materials.set(p.tinted, 'tint', (ctx.stepIndex / 12) % 2 === 0 ? '#0000ff' : '#0000e0');",
  '    const bytes: number[] = [];',
  '    for (let y = 0; y < 4; y++) for (let x = 0; x < 4; x++) bytes.push(...((x + y) % 2 === 0 ? [255, 0, 0, 255] : [0, 0, 0, 0]));',
  "    ctx.materials.setData(p.patterned, 'cells', 0, 0, 4, 4, bytes);",
  '  },',
  '};',
].join('\n');

/** The overlay graph: colour = mix(tint, cell.rgb, cell.a), the cell read at the UV. */
const OVERLAY_GRAPH = {
  nodes: [
    { id: 'out', type: 'unlit', position: [600, 0], data: { castShadows: false } },
    { id: 'tint', type: 'parameter', position: [0, 0], data: { key: 'tint' } },
    { id: 'cells', type: 'parameter', position: [0, 150], data: { key: 'cells' } },
    { id: 'read', type: 'sampleData', position: [200, 150] },
    { id: 'mix', type: 'lerp', position: [400, 0] },
  ],
  edges: [
    { id: 'e1', from: { node: 'cells', port: 'value' }, to: { node: 'read', port: 'data' } },
    { id: 'e2', from: { node: 'tint', port: 'value' }, to: { node: 'mix', port: 'a' } },
    { id: 'e3', from: { node: 'read', port: 'rgb' }, to: { node: 'mix', port: 'b' } },
    { id: 'e4', from: { node: 'read', port: 'a' }, to: { node: 'mix', port: 't' } },
    { id: 'e5', from: { node: 'mix', port: 'out' }, to: { node: 'out', port: 'color' } },
  ],
};

// Hue dominance (tone mapping lifts the other channels of a pure colour).
const blue = (r: number, g: number, b: number): boolean => b > 100 && b > r + 50 && b > g + 50;
const green = (r: number, g: number, b: number): boolean => g > 100 && g > r + 50 && g > b + 50;
const red = (r: number, g: number, b: number): boolean => r > 100 && r > g + 50 && r > b + 50;
type Pred = (r: number, g: number, b: number) => boolean;

function count(img: Image, test: Pred, x0 = 0, x1 = img.width): number {
  let n = 0;
  for (let y = 0; y < img.height; y += 2) for (let x = x0; x < x1; x += 2) {
    const [r, g, b] = img.pixel(x, y);
    if (test(r, g, b)) n += 1;
  }
  return n;
}

/** The box of pixels passing `test` in columns [x0, x1). */
function bounds(img: Image, test: Pred, x0: number, x1: number): { x0: number; y0: number; x1: number; y1: number } | null {
  let b: { x0: number; y0: number; x1: number; y1: number } | null = null;
  for (let y = 0; y < img.height; y += 1) for (let x = x0; x < x1; x += 1) {
    const [r, g, bb] = img.pixel(x, y);
    if (!test(r, g, bb)) continue;
    b = b === null ? { x0: x, y0: y, x1: x, y1: y } : { x0: Math.min(b.x0, x), y0: Math.min(b.y0, y), x1: Math.max(b.x1, x), y1: Math.max(b.y1, y) };
  }
  return b;
}

/**
 * What the fixture must show: box A (left half) blue with no green or red;
 * box B (right half) a 4 × 4 checker — red where x + y is even (x from the
 * left, y from the bottom), its green tint elsewhere. Returns a problem or null.
 */
function checkPicture(img: Image): string | null {
  const mid = Math.floor(img.width / 2);
  const blueA = count(img, blue, 0, mid);
  if (blueA < 300) return `box A is not blue (${blueA} blue pixels)`;
  if (count(img, green, 0, mid) > 20 || count(img, red, 0, mid) > 20) return 'box A shows green or red';
  if (count(img, blue, mid, img.width) > 20) return 'box B turned blue';
  const b = bounds(img, (r, g, bb) => red(r, g, bb) || green(r, g, bb), mid, img.width);
  if (b === null || b.x1 - b.x0 < 40 || b.y1 - b.y0 < 40) return `box B not found (${JSON.stringify(b)})`;
  const w = (b.x1 - b.x0 + 1) / 4;
  const h = (b.y1 - b.y0 + 1) / 4;
  const cells: string[] = [];
  for (let cy = 0; cy < 4; cy++) for (let cx = 0; cx < 4; cx++) {
    const [r, g, bb] = img.pixel(Math.floor(b.x0 + (cx + 0.5) * w), Math.floor(b.y1 - (cy + 0.5) * h));
    const want = (cx + cy) % 2 === 0 ? red : green;
    if (!want(r, g, bb)) cells.push(`[${cx},${cy}]=${r},${g},${bb}`);
  }
  return cells.length === 0 ? null : `box B's cells do not match the checker: ${cells.join(' ')}`;
}

const shot = async (t: Locator | Page): Promise<Image> => decodePng(await t.screenshot());

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

type RendererDiag = { gpu?: { programs: number }; frame?: { drawCalls: number }; materials?: { graphMaterials: number; objects: number; dataTextures: number } };

const VARIANTS: readonly RendererVariant[] = PRODUCT_RENDERER_VARIANTS;

for (const variant of VARIANTS) test(`a script sets one object's colour and writes a data grid on another sharing the material: Play and the export (${variant})`, async ({ page }) => {
  onlyInItsProject(variant, VARIANTS);
  test.setTimeout(300_000);
  be = await startBackend('material-runtime-e2e');

  // The material starts with its tint only; the data parameter is declared in the editor below.
  await cmd('setMaterial', { material: { materialId: 'overlay', name: 'Overlay', shader: 'unlit', params: {}, textures: {}, parameters: [{ key: 'tint', type: 'color', default: '#00ff00' }], graph: { nodes: [OVERLAY_GRAPH.nodes[0]!], edges: [] } } });
  await page.goto(editorUrlFor(be.editorUrl, variant));
  await expect(page.locator('.tl-statusbar')).toContainText('connected');
  const viewport = page.locator('canvas.tl-viewport');
  await expectRendererBackend(viewport, variant);

  // Editor: + parameter → key "cells", type data, size 4 × 4 (the material document's parameter list).
  await openEditor(page, 'Material', 'Overlay');
  const params = page.getByLabel('exposed parameters');
  await params.getByRole('button', { name: 'add parameter' }).click();
  const materialOf = async (): Promise<{ parameters?: Record<string, unknown>[] }> => ((await query('queryGameConfig')).materials as { materialId: string; parameters?: Record<string, unknown>[] }[]).find((m) => m.materialId === 'overlay')!;
  await expect.poll(async () => (await materialOf()).parameters?.length).toBe(2);
  const key = params.getByLabel('parameter 2 key');
  await key.fill('cells');
  await key.press('Enter');
  await expect.poll(async () => (await materialOf()).parameters?.[1]?.['key']).toBe('cells');
  await params.getByLabel('parameter cells type').selectOption('data');
  await expect.poll(async () => (await materialOf()).parameters?.[1]).toEqual({ key: 'cells', type: 'data', default: [0, 0, 0, 0], size: [8, 8] });
  const size = params.getByLabel('parameter cells size');
  await size.fill('4, 4');
  await size.press('Enter');
  await expect.poll(async () => (await materialOf()).parameters?.[1]).toEqual({ key: 'cells', type: 'data', default: [0, 0, 0, 0], size: [4, 4] });
  // The graph (the same ops MCP uses): Sample data reads it.
  const declared = (await materialOf()).parameters!;
  await cmd('setMaterial', { material: { materialId: 'overlay', name: 'Overlay', shader: 'unlit', params: {}, textures: {}, parameters: declared, graph: OVERLAY_GRAPH } });

  // The fixture: a plain dark sky, the camera looking along −Z at two flat boxes wearing the material, the script.
  await cmd('setEnvironment', { sceneId: 'scene-main', environment: { sky: { mode: 'color', color: '#303030' } } });
  const ents = ((await query('queryEntities', { limit: 100, offset: 0 })) as { entities: { id: string; components: Record<string, unknown> }[] }).entities;
  const cam = ents.find((e) => e.components['virtualCamera'] !== undefined)!.id;
  await cmd('setTransform', { entityId: cam, transform: { position: [0, 0, 6], rotation: [0, 0, 0, 1] } });
  // Anything else the blank project shows (its floor) moves out of the view.
  for (const e of ents) if (e.components['box'] !== undefined) await cmd('setTransform', { entityId: e.id, transform: { position: [0, -50, 0] } });
  const make = async (name: string, x: number): Promise<string> => {
    const id = String((await cmd('createEntity', { sceneId: 'scene-main', parentId: null, kind: 'box', name, transform: { position: [x, 0, 0] }, box: { size: [2, 2, 0.05], material: { color: '#ffffff' } } }))['createdId']);
    await cmd('setComponent', { entityId: id, component: 'materials', value: { '*': 'overlay' } });
    return id;
  };
  const tinted = await make('Tinted', -1.3);
  const patterned = await make('Patterned', 1.3);
  const painter = String((await cmd('createEntity', { sceneId: 'scene-main', parentId: null, kind: 'group', name: 'Painter', transform: { position: [0, -20, 0] } }))['createdId']);
  await script('painter', PAINTER, painter, ['tinted', 'patterned'], { tinted, patterned });

  // Scene view: both boxes in the material's own tint (no script runs in the editor).
  await closeEditor(page);
  await page.keyboard.press('Escape');
  await expect.poll(async () => count(await shot(viewport), green), { timeout: 30_000 }).toBeGreaterThan(600);
  expect(count(await shot(viewport), blue)).toBeLessThan(50);

  // Play: A turns blue, B shows the checker over its green tint.
  const started = page.waitForResponse((r) => r.request().method() === 'POST' && r.url().endsWith('/play'));
  await page.getByTitle('Start an isolated play preview').click();
  const psid = String(((await (await started).json()) as { playSessionId: string }).playSessionId);
  const frame = page.locator('iframe.tl-app__preview-frame');
  await expect(frame).toBeVisible();
  await expectRendererBackend(page.frameLocator('iframe.tl-app__preview-frame').locator('canvas').first(), variant);
  let problem: string | null = 'not checked';
  await expect.poll(async () => (problem = checkPicture(await shot(frame))), { timeout: 60_000, message: 'Play picture' }).toBeNull();
  expect(problem).toBeNull();
  // The counters: one compiled graph material serves both objects; values keep changing (every 12 steps) without a new program or draw.
  const diag = async (): Promise<RendererDiag | undefined> => {
    const d = await api(`play/${psid}/diagnostics`, {});
    return d.status === 200 ? ((d.json['diagnostics'] as { renderer?: RendererDiag } | undefined)?.renderer ?? undefined) : undefined;
  };
  await expect.poll(async () => (await diag())?.materials?.dataTextures ?? 0, { timeout: 20_000 }).toBe(1);
  const before = (await diag())!;
  expect(before.materials).toEqual({ graphMaterials: 1, objects: 2, dataTextures: 1 });
  expect(before.gpu!.programs).toBeGreaterThan(0);
  // Six value changes at 120 steps per second: a recompile per value would show by now.
  await page.waitForTimeout(600);
  const after = (await diag())!;
  console.log(`[material-runtime] ${variant} play: programs ${before.gpu!.programs} → ${after.gpu!.programs}, draw calls ${before.frame?.drawCalls} → ${after.frame?.drawCalls}`);
  expect(after.materials).toEqual({ graphMaterials: 1, objects: 2, dataTextures: 1 });
  expect(after.gpu!.programs).toBe(before.gpu!.programs);
  expect(after.frame?.drawCalls).toBe(before.frame?.drawCalls);
  expect(checkPicture(await shot(frame))).toBeNull();
  await expect(page.locator('.tl-notice')).toHaveCount(0);
  await page.getByTitle('Stop the play preview').click();

  // The static export, served with the backend stopped: the same picture.
  const res = await be.admin(`projects/${be.projectId}/export`);
  expect(res.status, JSON.stringify(res.json)).toBe(200);
  const out = join(be.exportRoot, String(res.json.outputDir));
  await page.goto('about:blank');
  await be.halt();
  const site = await serveDir(out);
  const exported = await page.context().newPage();
  const errors: string[] = [];
  exported.on('pageerror', (e) => errors.push(e.message));
  try {
    await exported.goto(`${site.url}${exportQueryFor(variant)}`);
    await expectRendererBackend(exported.locator('canvas').first(), variant);
    await expect.poll(async () => (problem = checkPicture(await shot(exported))), { timeout: 60_000, message: 'export picture' }).toBeNull();
    expect(errors).toEqual([]);
  } finally {
    await site.close();
  }
});
