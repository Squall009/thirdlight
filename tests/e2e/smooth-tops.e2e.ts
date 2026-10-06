/**
 * Smoothed block-layer tops against a real backend, on the product's own
 * renderer (renderer-variants.ts PRODUCT_RENDERER_VARIANTS: the normals are
 * built on the CPU).
 *
 * A block layer (two chunks along x, the chunk edge at world x = 0) carries
 * rolling sloped ground — a cosine along x, its crest on the chunk edge —
 * that drops down a steep slope (63°) at its +x end. A sun from +x lights the
 * slopes unevenly, so a facet shows as a jump in brightness along a row.
 *
 * By default (no crease angle) the tops are flat-shaded as before: the Scene
 * view and Play show a jump at the chunk edge (the crest). With a crease angle
 * of 45° set in the Inspector (read back over HTTP) the Scene view shows no
 * jump at any cell edge of the rolling ground, the chunk edge included, and
 * still a hard one at the top of the steep slope; subdivided tops (2 × 2, set
 * in the Inspector) draw more triangles and look the same on this ground. Play
 * and the static export (backend stopped) agree.
 *
 * TL_SMOOTH_TOPS_DIR=<dir> keeps the pictures (the default ones are the
 * before/after comparison for "existing scenes look the same").
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { createReadStream, existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { extname, join, normalize } from 'node:path';

import { expect, test, type Locator, type Page } from './pw';
import * as THREE from 'three';

import { startBackend, type E2EBackend } from './backend';
import { decodePng, type Image } from './png';
import { editorUrlFor, expectRendererBackend, exportQueryFor, onlyInItsProject, PRODUCT_RENDERER_VARIANTS, type RendererVariant } from './renderer-variants';
import { inspector, menu, openWindow, projectWindow } from './ui';

let be: E2EBackend | null = null;
test.afterEach(async () => {
  await be?.stop();
  be = null;
});

async function query(op: string, args: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  return be!.command({ op, projectId: be!.projectId, args });
}

async function cmd(op: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const res = await be!.command({ op, projectId: be!.projectId, expectedRevision: Number((await query('queryProject')).revision), requestId: `req-${randomBytes(16).toString('hex')}`, origin: { kind: 'mcp', clientId: 'e2e-smooth-tops' }, args });
  expect(res['ok'], JSON.stringify(res).slice(0, 600)).toBe(true);
  return res;
}

async function relay(path: string, body: unknown): Promise<{ status: number; json: Record<string, unknown> }> {
  const r = await fetch(`${be!.origin}/api/v1/projects/${be!.projectId}/play/${path}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${be!.token}`, 'content-type': 'application/json', origin: be!.origin },
    body: JSON.stringify(body),
  });
  return { status: r.status, json: (await r.json()) as Record<string, unknown> };
}

/** The layer's min corner: layer column 16 (the chunk edge) at world x = 0. */
const ORIGIN = [-16, 0, -4] as const;
/** The rolling ground's crest stands on the chunk edge. */
const CHUNK_EDGE = 16;
/** Where the rolling ground meets the steep slope (a crease sharper than the angle). */
const CREASE = 24;
const q64 = (v: number): number => Math.round(v * 64) / 64;
/** The ground's height (cells = metres) at layer column coordinate x. */
function height(x: number): number {
  if (x <= CREASE) return q64(5 + 0.5 * Math.cos((2 * Math.PI * (x - CHUNK_EDGE)) / 8));
  if (x <= CREASE + 2) return 5.5 - 2 * (x - CREASE);
  return 1.5;
}

/** Under each column full cells up to the row of its lowest corner, then one sloped top cell (columns 4–27, rows of 8 along z). */
function groundEdits(): unknown[] {
  const edits: unknown[] = [];
  for (let x = 4; x < 28; x++) {
    const h0 = height(x);
    const h1 = height(x + 1);
    const top = h0 === h1 && Number.isInteger(h0) ? h0 - 1 : Math.floor(Math.min(h0, h1));
    if (top > 0) edits.push({ kind: 'fill', box: [x, 0, 0, x + 1, top, 8], cell: { block: 'ground' } });
    const c = [h0 - top, h1 - top, h1 - top, h0 - top];
    edits.push({ kind: 'fill', box: [x, top, 0, x + 1, top + 1, 8], cell: { block: 'ground', ...(c.every((v) => v === 1) ? {} : { corners: c }) } });
  }
  return edits;
}

/** The game camera: from +x +z, above, looking at the middle of the ground. */
const CAMERA_AT = new THREE.Vector3(10, 13, 15);
const LOOK_AT = new THREE.Vector3(2, 3.5, 0);

async function buildScene(): Promise<{ layer: string; fovY: number }> {
  await cmd('setSettings', { settings: { physics_dimension: 3 } });
  await cmd('setBlockType', { block: { blockId: 'ground', name: 'Ground', variants: [{ color: '#b8b8b8' }], shape: 'full' } });
  const entities = ((await query('queryEntities', { limit: 100, offset: 0 })) as { entities: { id: string; components: Record<string, unknown> }[] }).entities;
  const cam = entities.find((e) => e.components['virtualCamera'] !== undefined)!;
  // A camera's lookAt turns its −z (where it looks) toward the target.
  const aim = new THREE.PerspectiveCamera();
  aim.position.copy(CAMERA_AT);
  aim.lookAt(LOOK_AT);
  const r = aim.quaternion;
  await cmd('setTransform', { entityId: cam.id, transform: { position: CAMERA_AT.toArray(), rotation: [r.x, r.y, r.z, r.w] } });
  const sun = entities.find((e) => (e.components['light'] as { type?: string } | undefined)?.type === 'directional');
  const ambient = entities.find((e) => (e.components['light'] as { type?: string } | undefined)?.type === 'ambient');
  // The sun from +x, low: slopes facing +x are bright, those facing −x dark.
  if (sun !== undefined) await cmd('setComponent', { entityId: sun.id, component: 'light', value: { type: 'directional', color: '#ffffff', intensity: 1.6, direction: [-0.8, -0.6, 0], castShadow: false } });
  if (ambient !== undefined) await cmd('setComponent', { entityId: ambient.id, component: 'light', value: { type: 'ambient', color: '#ffffff', intensity: 0.25 } });
  const layer = String((await cmd('createEntity', { sceneId: 'scene-main', parentId: null, kind: 'group', name: 'Ground', transform: { position: [...ORIGIN] } }))['createdId']);
  await cmd('setComponent', { entityId: layer, component: 'blockLayer', value: { cellSize: [1, 1, 1], bounds: { min: [0, 0, 0], max: [32, 8, 8] }, castShadow: false, receiveShadow: false } });
  const res = await cmd('editBlocks', { entityId: layer, edits: groundEdits() });
  expect((res.change as { chunks: number[][] }).chunks).toEqual([[0, 0], [1, 0]]);
  const fovY = Number(((await query('queryEntities', { limit: 100, offset: 0 })) as { entities: { id: string; components: Record<string, { fovY?: number }> }[] }).entities.find((e) => e.id === cam.id)!.components['virtualCamera']!.fovY ?? 60);
  return { layer, fovY };
}

/** World → pixel of a picture. */
type Projector = (p: [number, number, number]) => { x: number; y: number } | null;

/** The game camera's projector for a picture of the game canvas (its aspect is the picture's). */
function gameProjector(img: Image, fovY: number): Projector {
  const camera = new THREE.PerspectiveCamera(fovY, img.width / img.height, 0.1, 500);
  camera.position.copy(CAMERA_AT);
  camera.lookAt(LOOK_AT);
  camera.updateMatrixWorld();
  return (p) => {
    const v = new THREE.Vector3(...p).project(camera);
    return v.z > 1 ? null : { x: ((v.x + 1) / 2) * img.width, y: ((1 - v.y) / 2) * img.height };
  };
}

/** The Scene view's projector from its published view-projection matrix, for a picture of its canvas. */
async function sceneProjector(view: Locator): Promise<Projector> {
  const m = JSON.parse((await view.getAttribute('data-view-proj'))!) as number[];
  const box = (await view.boundingBox())!;
  return ([x, y, z]) => {
    const w = m[3]! * x + m[7]! * y + m[11]! * z + m[15]!;
    if (w <= 0) return null;
    const nx = (m[0]! * x + m[4]! * y + m[8]! * z + m[12]!) / w;
    const ny = (m[1]! * x + m[5]! * y + m[9]! * z + m[13]!) / w;
    return { x: ((nx + 1) / 2) * box.width, y: ((1 - ny) / 2) * box.height };
  };
}

/** Mean brightness of a 3 × 3 square around the ground's surface point at layer column coordinate x (the middle row). */
function brightness(img: Image, project: Projector, x: number): number {
  const s = project([ORIGIN[0] + x, ORIGIN[1] + height(x), ORIGIN[2] + 4]);
  if (s === null) return NaN;
  const cx = Math.round(s.x);
  const cy = Math.round(s.y);
  let sum = 0;
  for (let y = cy - 1; y <= cy + 1; y++)
    for (let xx = cx - 1; xx <= cx + 1; xx++) {
      const [r, g, b] = img.pixel(xx, y);
      sum += (r + g + b) / 3;
    }
  return sum / 9;
}

/** The brightness jumps across cell edges: at the chunk edge, the largest over the rolling ground's other edges, at the crease. */
interface Jumps {
  chunkEdge: number;
  rolling: number;
  crease: number;
}

const D = 0.15;
/**
 * The jump across a cell edge at x: the brightness step there less what the
 * shading's slope on either side (from points D and 3D away, inside the
 * cells) would give over the same distance — 0 for smooth shading, the whole
 * step for a facet.
 */
function jumpAt(img: Image, project: Projector, x: number): number {
  const b = (dx: number): number => brightness(img, project, x + dx);
  const [l3, l1, r1, r3] = [b(-3 * D), b(-D), b(D), b(3 * D)];
  const slope = (l1 - l3 + (r3 - r1)) / 2;
  return Math.abs(r1 - l1 - slope);
}

function jumps(img: Image, project: Projector): Jumps {
  let rolling = 0;
  for (let x = 9; x <= 23; x++) rolling = Math.max(rolling, jumpAt(img, project, x));
  return { chunkEdge: jumpAt(img, project, CHUNK_EDGE), rolling, crease: jumpAt(img, project, CREASE) };
}

/** Faceted: a cell edge (the crest on the chunk edge) shows as a jump. */
function faceted(j: Jumps): string | null {
  return j.chunkEdge >= 8 ? null : `no facet at the chunk edge: ${JSON.stringify(j)}`;
}

/** Smooth: no jump at any edge of the rolling ground (the chunk edge included); the crease stays hard. */
function smooth(j: Jumps): string | null {
  if (!(j.chunkEdge <= 4)) return `a seam at the chunk edge: ${JSON.stringify(j)}`;
  if (!(j.rolling <= 6)) return `a facet on the rolling ground: ${JSON.stringify(j)}`;
  if (!(j.crease >= 12)) return `no crease at the steep slope: ${JSON.stringify(j)}`;
  return null;
}

const keep = (name: string, png: Buffer): void => {
  const dir = process.env['TL_SMOOTH_TOPS_DIR'];
  if (dir === undefined || dir === '') return;
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${name}-${test.info().project.name}.png`), png);
};

function serveDir(dir: string): Promise<{ url: string; close: () => Promise<void> }> {
  const types: Record<string, string> = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json', '.wasm': 'application/wasm', '.png': 'image/png' };
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

/** Play: a picture of the game canvas over HTTP (relay screenshot) until `check` passes; returns the last jumps. */
async function playPicture(page: Page, fovY: number, check: (j: Jumps) => string | null, name: string): Promise<Jumps> {
  const started = page.waitForResponse((r) => r.request().method() === 'POST' && r.url().endsWith('/play'));
  await page.getByTitle('Start an isolated play preview').click();
  const psid = String(((await (await started).json()) as { playSessionId: string }).playSessionId);
  let last: Jumps | null = null;
  let png: Buffer | null = null;
  let problem: string | null = 'no picture';
  await expect
    .poll(async () => {
      const shot = await relay(`${psid}/screenshot`, { maxWidth: 960 });
      if (shot.status !== 200) return `screenshot ${shot.status}`;
      png = Buffer.from(String(shot.json.dataUrl ?? '').split(',')[1] ?? '', 'base64');
      const img = decodePng(png);
      last = jumps(img, gameProjector(img, fovY));
      return (problem = check(last));
    }, { timeout: 60_000, intervals: [500], message: `Play picture (${name})` })
    .toBeNull()
    .catch((e: Error) => {
      throw new Error(`${e.message}\n${problem}`);
    });
  if (png !== null) keep(`play-${name}`, png);
  await page.getByTitle('Stop the play preview').click();
  return last!;
}

/** The Scene view's picture until `check` passes; returns the last jumps. */
async function scenePicture(view: Locator, check: (j: Jumps) => string | null, name: string): Promise<Jumps> {
  const project = await sceneProjector(view);
  let last: Jumps | null = null;
  let png: Buffer | null = null;
  let problem: string | null = 'no picture';
  await expect
    .poll(async () => {
      png = await view.screenshot();
      last = jumps(decodePng(png), project);
      return (problem = check(last));
    }, { timeout: 30_000, intervals: [300], message: `Scene view picture (${name})` })
    .toBeNull()
    .catch((e: Error) => {
      throw new Error(`${e.message}\n${problem}`);
    });
  if (png !== null) keep(`scene-${name}`, png);
  return last!;
}

for (const variant of PRODUCT_RENDERER_VARIANTS) test(`smoothed block-layer tops: no seam at a chunk edge and a hard crease, set in the Inspector, in the Scene view, Play and the export (${variant})`, async ({ page }) => {
  onlyInItsProject(variant, PRODUCT_RENDERER_VARIANTS);
  test.setTimeout(420_000);
  be = await startBackend(`smooth-tops-${randomUUID().slice(0, 8)}`);
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const { layer, fovY } = await buildScene();

  await page.goto(editorUrlFor(be.editorUrl, variant));
  await expect(page.locator('.tl-statusbar')).toContainText('connected');
  const view = page.locator('canvas.tl-viewport');
  await expectRendererBackend(view, variant);
  await expect.poll(async () => JSON.parse((await view.getAttribute('data-block-layers')) ?? '{"chunks":0}').chunks as number, { timeout: 30_000 }).toBe(2);

  // Frame the ground: the block tools publish the view's projection; zoom out until the ground's row is in view.
  await openWindow(page, 'Blocks');
  const host = view;
  await expect(host).toHaveAttribute('data-view-proj', /\[/);
  const box = (await view.boundingBox())!;
  const inView = async (): Promise<boolean> => {
    const project = await sceneProjector(host);
    for (const x of [4, 28]) for (const z of [0, 8]) {
      const s = project([ORIGIN[0] + x, ORIGIN[1] + height(x), ORIGIN[2] + z]);
      if (s === null || s.x < 4 || s.x > box.width - 4 || s.y < 4 || s.y > box.height - 4) return false;
    }
    return true;
  };
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  for (let i = 0; i < 40 && !(await inView()); i++) {
    await page.mouse.wheel(0, 300);
    await page.waitForTimeout(80);
  }
  expect(await inView()).toBe(true);
  await projectWindow(page);
  await menu(page, 'Gizmos', 'Icons: on');

  // By default the tops are flat-shaded, as before: a facet at the chunk edge.
  const sceneDefault = await scenePicture(host, faceted, 'default');
  const playDefault = await playPicture(page, fovY, faceted, 'default');

  // A crease angle in the Inspector; read back over HTTP.
  await openWindow(page, 'Blocks');
  const angle = inspector(page).getByLabel('blockLayer smoothAngle', { exact: true });
  await angle.fill('45');
  await angle.press('Enter');
  await expect.poll(async () => ((await query('queryEntities', { limit: 100, offset: 0 })) as { entities: { id: string; components: Record<string, { smoothAngle?: number }> }[] }).entities.find((e) => e.id === layer)?.components['blockLayer']?.smoothAngle).toBe(45);
  await projectWindow(page);
  const scene = await scenePicture(host, smooth, 'smooth');

  // Subdivided tops: more triangles, the same look on this ground.
  const triangles = async (): Promise<number> => JSON.parse((await view.getAttribute('data-block-layers')) ?? '{"triangles":0}').triangles as number;
  const before = await triangles();
  await openWindow(page, 'Blocks');
  await inspector(page).getByLabel('blockLayer topSubdivision', { exact: true }).selectOption({ label: '2 × 2' });
  await expect.poll(async () => ((await query('queryEntities', { limit: 100, offset: 0 })) as { entities: { id: string; components: Record<string, { topSubdivision?: number }> }[] }).entities.find((e) => e.id === layer)?.components['blockLayer']?.topSubdivision).toBe(2);
  await projectWindow(page);
  await expect.poll(triangles, { timeout: 30_000 }).toBeGreaterThan(before * 1.5);
  await scenePicture(host, smooth, 'subdivided');

  const played = await playPicture(page, fovY, smooth, 'smooth');
  expect(errors).toEqual([]);

  // The static export with the backend stopped.
  const res = await be.admin(`projects/${be.projectId}/export`);
  expect(res.status, JSON.stringify(res.json)).toBe(200);
  await be.halt();
  const site = await serveDir(join(be.exportRoot, String(res.json.outputDir)));
  const game = await page.context().newPage();
  const gameErrors: string[] = [];
  game.on('pageerror', (e) => gameErrors.push(e.message));
  try {
    await game.goto(`${site.url}${exportQueryFor(variant)}`);
    const canvas = game.locator('canvas').first();
    await expectRendererBackend(canvas, variant as RendererVariant);
    let problem: string | null = 'no picture';
    let png: Buffer | null = null;
    await expect
      .poll(async () => {
        png = await canvas.screenshot();
        const img = decodePng(png);
        return (problem = smooth(jumps(img, gameProjector(img, fovY))));
      }, { timeout: 60_000, intervals: [500], message: 'export picture' })
      .toBeNull()
      .catch((e: Error) => {
        throw new Error(`${e.message}\n${problem}`);
      });
    if (png !== null) keep('export-smooth', png);
    expect(gameErrors).toEqual([]);
  } finally {
    await game.close();
    await site.close();
  }
  console.log(`smooth tops ${variant}: default scene ${JSON.stringify(sceneDefault)} play ${JSON.stringify(playDefault)}; smooth scene ${JSON.stringify(scene)} play ${JSON.stringify(played)}`);
});
