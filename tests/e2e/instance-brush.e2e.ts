/**
 * The instance brush against a real backend.
 *
 * A 3D project with a block layer (a raised flat top at y = 2) and a wide
 * model with a collider (a scaled pillar, its cap the surface) beside it;
 * one instance set of small pillars, its one copy far away.
 *
 * In the editor: the set's Inspector shows the brush (Paint, Erase and the
 * settings); a stroke dragged across the block-layer top paints copies onto
 * it (one paintInstances, read back over HTTP: on the top, inside the
 * stroke, scaled within the range), one undo takes them all away, one redo
 * brings the same buffer back; the same stroke sent again over MCP gives the
 * same buffer (the copies come from the seed); a reload shows them; Erase
 * takes away the copies under its stroke, one undo restores them. The copies
 * show in the Scene view's and in Play's pixels and keep the set's chunks. A
 * stroke on the model's cap puts copies on the cap.
 *
 * Over MCP without a surface the backend drops the stroke onto the block
 * layer itself; erase and undo work the same; a stroke past what one
 * command may carry is refused with its reason.
 */
import { randomBytes } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { expect, test, type Locator, type Page } from '@playwright/test';
import * as THREE from 'three';

import { publishBytes, startBackend, type E2EBackend } from './backend';
import { decodePng, type Image } from './png';
import { inspector } from './ui';

const REPO = resolve(import.meta.dirname, '..', '..');
let be: E2EBackend | null = null;
test.afterEach(async () => {
  await be?.stop();
  be = null;
});

async function query(op: string, args: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  return be!.command({ op, projectId: be!.projectId, args });
}
async function cmd(op: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const res = await be!.command({ op, projectId: be!.projectId, expectedRevision: Number((await query('queryProject')).revision), requestId: `req-${randomBytes(16).toString('hex')}`, origin: { kind: 'mcp', clientId: 'e2e-instance-brush' }, args });
  expect(res['ok'], JSON.stringify(res).slice(0, 600)).toBe(true);
  return res;
}
async function relay(path: string, body: unknown): Promise<{ status: number; json: Record<string, unknown> }> {
  const r = await fetch(`${be!.origin}/api/v1/projects/${be!.projectId}/play/${path}`, { method: 'POST', headers: { authorization: `Bearer ${be!.token}`, 'content-type': 'application/json', origin: be!.origin }, body: JSON.stringify(body) });
  return { status: r.status, json: (await r.json()) as Record<string, unknown> };
}
async function mcpClient(): Promise<Client> {
  const mcp = new Client({ name: 'thirdlight-e2e', version: '0.0.0' });
  await mcp.connect(new StdioClientTransport({ command: process.execPath, args: [join(REPO, 'dist', 'mcp-adapter', 'mcp.mjs')], env: { ...process.env, THIRDLIGHT_AUTHORING_ORIGIN: be!.origin, THIRDLIGHT_PROJECT_ID: be!.projectId, THIRDLIGHT_MCP_TOKEN: be!.token } as Record<string, string>, stderr: 'ignore' }));
  return mcp;
}
async function mcpCommand(mcp: Client, op: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const revision = Number((await query('queryProject')).revision);
  const r = (await mcp.callTool({ name: 'tl_command', arguments: { op, expectedRevision: revision, args } })) as { content: { text: string }[]; isError?: boolean };
  return JSON.parse(r.content[0]!.text) as Record<string, unknown>;
}

/** The block layer's top: y = 2 over x −24…−12, z −20…−12. */
const TOP_Y = 2;
const LAYER_AT = [-24, 0, -20] as const;
/** The model platform (a pillar scaled 6 × 1.5 × 6, its cap's top at y = 3) stands at x = −4, z = −16. */
const CAP_Y = 3;
const PLATFORM_AT = [-4, 0, -16] as const;
const BRUSH = { radius: '1.5', density: '2', spacing: '0.3', 'scale min': '0.3', 'scale max': '0.4', rotation: '360', align: '0', seed: '7' };

async function buildScene(): Promise<{ set: string; layer: string; platform: string; camera: string }> {
  await cmd('setSettings', { settings: { physics_dimension: 3 } });
  await publishBytes(be!, new Uint8Array(readFileSync(join(REPO, 'templates', 'starter', 'assets', 'model', 'pillar.glb'))), 'model', 'pillar', 'Pillar', {}, { extractTextures: false });
  await cmd('setBlockType', { block: { blockId: 'turf', name: 'Turf', variants: [{ color: '#3f8f3a' }], shape: 'full' } });
  const layer = String((await cmd('createEntity', { parentId: null, kind: 'group', name: 'Terrain', transform: { position: [...LAYER_AT] } }))['createdId']);
  await cmd('setComponent', { entityId: layer, component: 'blockLayer', value: { cellSize: [1, 0.5, 1], bounds: { min: [0, 0, 0], max: [12, 8, 8] }, castShadow: false, receiveShadow: false } });
  await cmd('editBlocks', { entityId: layer, edits: [{ kind: 'fill', box: [0, 0, 0, 12, 4, 8], cell: { block: 'turf' } }] });
  const platform = String((await cmd('createEntity', { parentId: null, kind: 'model', name: 'Platform', transform: { position: [...PLATFORM_AT], scale: [6, 1.5, 6] }, model: { asset: { assetId: 'pillar' } }, components: { collider: { shape: { type: 'box', hx: 0.45, hy: 1, hz: 0.45 } } } }))['createdId']);
  // The set: one copy far off, chunks of 4 m (painted copies keep the set's chunking).
  const res = await fetch(`${be!.origin}/api/v1/projects/${be!.projectId}/content/buffers`, { method: 'POST', headers: { authorization: `Bearer ${be!.token}`, 'content-type': 'application/json', origin: be!.origin }, body: JSON.stringify({ transforms: [40, 0, 40, 0, 0, 0, 1, 0.3, 0.3, 0.3] }) });
  const published = (await res.json()) as { digest: string };
  const set = String((await cmd('createEntity', { parentId: null, kind: 'group', name: 'Sprinkles', components: { instances: { asset: { assetId: 'pillar' }, buffer: published.digest, count: 1, chunkSize: 4 } } }))['createdId']);
  // The game camera looks down at the terrain from the south-east.
  const entities = (await query('queryEntities', { limit: 100, offset: 0 }))['entities'] as { id: string; components: Record<string, unknown> }[];
  const camera = entities.find((e) => e.components['virtualCamera'] !== undefined)!.id;
  const aim = new THREE.PerspectiveCamera();
  aim.position.set(-10, 12, -4);
  aim.lookAt(-18, TOP_Y, -16);
  const q = aim.quaternion;
  await cmd('setTransform', { entityId: camera, transform: { position: aim.position.toArray(), rotation: [q.x, q.y, q.z, q.w] } });
  return { set, layer, platform, camera };
}

type Copy = { x: number; y: number; z: number; s: number };
async function setState(set: string): Promise<{ buffer: string; count: number; chunkSize?: number; copies: Copy[] }> {
  const inst = ((await query('queryEntity', { entityId: set }))['entity'] as { components: { instances: { buffer: string; count: number; chunkSize?: number } } }).components.instances;
  const bytes = await fetch(`${be!.origin}/api/v1/projects/${be!.projectId}/content/buffers/${inst.buffer}`, { headers: { authorization: `Bearer ${be!.token}` } });
  const f = new Float32Array(await bytes.arrayBuffer());
  const copies = Array.from({ length: inst.count }, (_, i) => ({ x: f[i * 10]!, y: f[i * 10 + 1]!, z: f[i * 10 + 2]!, s: f[i * 10 + 7]! }));
  return { ...inst, copies };
}

const view = (page: Page): Locator => page.locator('canvas.tl-viewport');
/** TL_INSTANCE_BRUSH_DIR=<dir> keeps the pictures the test compares. */
const keep = (name: string, png: Buffer): void => {
  const dir = process.env['TL_INSTANCE_BRUSH_DIR'];
  if (dir === undefined || dir === '') return;
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${name}.png`), png);
};
type Projector = (p: readonly [number, number, number]) => { x: number; y: number } | null;
/** World → canvas pixel from the Scene view's published view-projection (the brush publishes it while on). */
async function sceneProjector(page: Page): Promise<Projector> {
  const m = JSON.parse((await view(page).getAttribute('data-view-proj'))!) as number[];
  const box = (await view(page).boundingBox())!;
  return ([x, y, z]) => {
    const w = m[3]! * x + m[7]! * y + m[11]! * z + m[15]!;
    if (w <= 0) return null;
    return { x: (((m[0]! * x + m[4]! * y + m[8]! * z + m[12]!) / w + 1) / 2) * box.width, y: ((1 - (m[1]! * x + m[5]! * y + m[9]! * z + m[13]!) / w) / 2) * box.height };
  };
}
async function select(page: Page, id: string): Promise<void> {
  await page.locator(`.tl-hierarchy__list li[data-entity-id="${id}"]`).click();
  await expect(page.locator('.tl-hierarchy__list li.is-selected')).toHaveAttribute('data-entity-id', id);
}
/** Frame `id` (F). */
async function frame(page: Page, id: string): Promise<void> {
  await select(page, id);
  const box = (await view(page).boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.keyboard.press('f');
  await page.waitForTimeout(300);
}
/** With the brush on (the view's projection published): zoom out until the points are well inside the view. */
async function fit(page: Page, points: readonly (readonly [number, number, number])[]): Promise<void> {
  const box = (await view(page).boundingBox())!;
  const inside = async (): Promise<boolean> => {
    const project = await sceneProjector(page);
    return points.every((p) => {
      const s = project(p);
      return s !== null && s.x > box.width * 0.15 && s.x < box.width * 0.85 && s.y > box.height * 0.15 && s.y < box.height * 0.85;
    });
  };
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  for (let i = 0; i < 40 && !(await inside()); i++) {
    await page.mouse.wheel(0, 300);
    await page.waitForTimeout(80);
  }
  expect(await inside(), 'the stroke is in view').toBe(true);
  await page.mouse.move(0, 0);
}
async function setBrush(page: Page, values: Record<string, string>): Promise<void> {
  for (const [k, v] of Object.entries(values)) {
    const field = inspector(page).getByLabel(`instance brush ${k}`, { exact: true });
    await field.fill(v);
    await field.blur();
  }
}
/** Drag across world points in the Scene view (a stroke). */
async function stroke(page: Page, from: readonly [number, number, number], to: readonly [number, number, number]): Promise<void> {
  const project = await sceneProjector(page);
  const box = (await view(page).boundingBox())!;
  const a = project(from)!;
  const b = project(to)!;
  for (const p of [a, b]) expect(p.x > 4 && p.x < box.width - 4 && p.y > 4 && p.y < box.height - 4, `stroke point in view ${JSON.stringify(p)}`).toBe(true);
  await page.mouse.move(box.x + a.x, box.y + a.y);
  await page.mouse.down();
  for (let i = 1; i <= 24; i++) await page.mouse.move(box.x + a.x + ((b.x - a.x) * i) / 24, box.y + a.y + ((b.y - a.y) * i) / 24);
  await page.mouse.up();
  // The ring leaves with the pointer (pictures without it).
  await page.mouse.move(box.x + box.width + 40, box.y + box.height / 2);
}
async function strokeTiming(page: Page): Promise<{ ok: boolean; dabs: number; candidates: number; surfaceMs: number; commandMs: number }> {
  let t: { ok: boolean } | null = null;
  await expect.poll(async () => (t = JSON.parse((await view(page).getAttribute('data-instance-stroke')) ?? 'null') as { ok: boolean } | null) !== null).toBe(true);
  return t as unknown as { ok: boolean; dabs: number; candidates: number; surfaceMs: number; commandMs: number };
}
async function undo(page: Page, redo = false): Promise<void> {
  await view(page).hover();
  await page.keyboard.press(redo ? 'Control+y' : 'Control+z');
  await page.mouse.move(0, 0);
}

/** How many of the copies changed the picture where they stand (a 5 × 5 patch over their middle). */
function copiesSeen(before: Image, after: Image, project: Projector, copies: Copy[]): number {
  let seen = 0;
  for (const c of copies) {
    const p = project([c.x, c.y + 0.25 * c.s * 2, c.z]);
    if (p === null) continue;
    let diff = 0;
    for (let y = Math.round(p.y) - 2; y <= Math.round(p.y) + 2; y++)
      for (let x = Math.round(p.x) - 2; x <= Math.round(p.x) + 2; x++) {
        if (x < 0 || y < 0 || x >= before.width || y >= before.height) continue;
        const [r0, g0, b0] = before.pixel(x, y);
        const [r1, g1, b1] = after.pixel(x, y);
        diff = Math.max(diff, Math.abs(r1 - r0) + Math.abs(g1 - g0) + Math.abs(b1 - b0));
      }
    if (diff > 40) seen += 1;
  }
  return seen;
}

async function playPicture(page: Page): Promise<{ img: Image; png: Buffer }> {
  const started = page.waitForResponse((r) => r.request().method() === 'POST' && r.url().endsWith('/play'));
  await page.getByTitle('Start an isolated play preview').click();
  const psid = String(((await (await started).json()) as { playSessionId: string }).playSessionId);
  let png: Buffer | null = null;
  await expect.poll(async () => {
    const shot = await relay(`${psid}/screenshot`, { maxWidth: 960 });
    if (shot.status !== 200) return false;
    png = Buffer.from(String(shot.json.dataUrl ?? '').split(',')[1] ?? '', 'base64');
    return true;
  }, { timeout: 60_000, intervals: [500] }).toBe(true);
  // A screenshot is the frame as drawn, models still loading absent: the picture is taken once Play has none loading.
  await expect.poll(async () => {
    const r = (await relay(`${psid}/observe`, {})).json['resources'] as { loading?: number; resident?: Record<string, { count: number }> } | undefined;
    return r !== undefined && r.loading === 0 && (r.resident?.['model']?.count ?? 0) > 0;
  }, { timeout: 60_000 }).toBe(true);
  const shot = await relay(`${psid}/screenshot`, { maxWidth: 960 });
  if (shot.status === 200) png = Buffer.from(String(shot.json.dataUrl ?? '').split(',')[1] ?? '', 'base64');
  await page.getByTitle('Stop the play preview').click();
  return { img: decodePng(png!), png: png! };
}
function gameProjector(img: Image): Projector {
  const camera = new THREE.PerspectiveCamera(60, img.width / img.height, 0.1, 500);
  camera.position.set(-10, 12, -4);
  camera.lookAt(-18, TOP_Y, -16);
  camera.updateMatrixWorld();
  return (p) => {
    const v = new THREE.Vector3(...p).project(camera);
    return v.z > 1 ? null : { x: ((v.x + 1) / 2) * img.width, y: ((1 - v.y) / 2) * img.height };
  };
}

test('the instance brush paints and erases on a block-layer top and a model: one command and one undo per stroke, redo, reload, the same copies from the same stroke over MCP, pixels in the Scene view and Play', async ({ page }) => {
  test.setTimeout(420_000);
  be = await startBackend(`instance-brush-${randomBytes(4).toString('hex')}`);
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const { set, layer, platform } = await buildScene();
  const original = await setState(set);
  const cameraFov = Number((((await query('queryEntities', { limit: 100, offset: 0 }))['entities'] as { components: Record<string, { fovY?: number }> }[]).find((e) => e.components['virtualCamera'] !== undefined)!.components['virtualCamera']!.fovY) ?? 60);
  expect(cameraFov).toBe(60);

  await page.goto(be.editorUrl);
  await expect(page.locator('.tl-statusbar')).toContainText('connected');
  await expect.poll(async () => JSON.parse((await view(page).getAttribute('data-block-layers')) ?? '{"chunks":0}').chunks as number, { timeout: 30_000 }).toBe(1);
  const playBefore = await playPicture(page);

  // The set's Inspector: the brush beside the copies; Paint arms it (the Scene view publishes its projection).
  await frame(page, layer);
  await select(page, set);
  await expect(inspector(page).getByRole('group', { name: 'instance brush' })).toBeVisible();
  await setBrush(page, BRUSH);
  await inspector(page).getByRole('button', { name: 'Paint', exact: true }).click();
  await expect(view(page)).toHaveAttribute('data-brush', set);
  await expect(view(page)).toHaveAttribute('data-brush-mode', 'paint');
  await expect(view(page)).toHaveAttribute('data-view-proj', /\[/);
  await fit(page, [[-23, TOP_Y, -18], [-13, TOP_Y, -14]]);
  await page.waitForTimeout(300);
  const sceneBeforePng = await view(page).screenshot();
  keep('scene-before', sceneBeforePng);
  const sceneBefore = decodePng(sceneBeforePng);

  // One stroke along the block-layer top: one paintInstances (its request kept for MCP).
  let sent: Record<string, unknown> | null = null;
  page.on('request', (r) => {
    if (r.method() !== 'POST' || !r.url().includes('/commands')) return;
    const body = JSON.parse(r.postData() ?? '{}') as { op?: string; args?: Record<string, unknown> };
    if (body.op === 'paintInstances') sent = body.args ?? null;
  });
  const A = [-21, TOP_Y, -16] as const;
  const B = [-15, TOP_Y, -16] as const;
  await stroke(page, A, B);
  const t1 = await strokeTiming(page);
  expect(t1.ok, JSON.stringify(t1)).toBe(true);
  const painted = await setState(set);
  expect(painted.count).toBeGreaterThan(10);
  expect(painted.chunkSize).toBe(4);
  const fresh = painted.copies.slice(1);
  expect(painted.copies[0]).toEqual(original.copies[0]);
  for (const c of fresh) {
    expect(c.y).toBeCloseTo(TOP_Y, 2);
    expect(Math.abs(c.z + 16)).toBeLessThanOrEqual(1.5 + 1e-3);
    expect(c.x).toBeGreaterThanOrEqual(-21 - 1.5 - 1e-3);
    expect(c.x).toBeLessThanOrEqual(-15 + 1.5 + 1e-3);
    expect(c.s).toBeGreaterThanOrEqual(0.3 - 1e-4);
    expect(c.s).toBeLessThanOrEqual(0.4 + 1e-4);
  }
  for (let i = 0; i < fresh.length; i++) for (let j = i + 1; j < fresh.length; j++) expect(Math.hypot(fresh[i]!.x - fresh[j]!.x, fresh[i]!.z - fresh[j]!.z)).toBeGreaterThanOrEqual(0.3 - 1e-3);
  expect(sent, 'the stroke went out as one paintInstances').not.toBeNull();
  const surface = (sent as unknown as { surface: unknown[] }).surface;
  expect(surface.length).toBe(t1.candidates);
  // The Scene view shows the copies where they stand; the Inspector counts the set's chunks (4 m).
  await page.waitForTimeout(500);
  const project = await sceneProjector(page);
  const sceneAfterPng = await view(page).screenshot();
  keep('scene-after', sceneAfterPng);
  const sceneAfter = decodePng(sceneAfterPng);
  expect(copiesSeen(sceneBefore, sceneAfter, project, fresh)).toBeGreaterThanOrEqual(Math.ceil(fresh.length * 0.6));
  await expect.poll(async () => Number(await inspector(page).locator('[data-chunks]').getAttribute('data-chunks'))).toBeGreaterThanOrEqual(3);

  // One undo takes the whole stroke away; one redo brings the same buffer back.
  await undo(page);
  await expect.poll(async () => (await setState(set)).buffer).toBe(original.buffer);
  await undo(page, true);
  await expect.poll(async () => (await setState(set)).buffer).toBe(painted.buffer);

  // The same stroke over MCP (after an undo) gives the same copies: the places come from the seed.
  await undo(page);
  await expect.poll(async () => (await setState(set)).buffer).toBe(original.buffer);
  const mcp = await mcpClient();
  try {
    const r = await mcpCommand(mcp, 'paintInstances', sent as unknown as Record<string, unknown>);
    expect(r['ok'], JSON.stringify(r).slice(0, 400)).toBe(true);
    expect((await setState(set)).buffer).toBe(painted.buffer);
    // Painting it again adds nothing.
    const again = await mcpCommand(mcp, 'paintInstances', sent as unknown as Record<string, unknown>);
    expect(JSON.stringify(again)).toContain('no_change');
  } finally {
    await mcp.close();
  }

  // A reload: the copies are there.
  await page.reload();
  await expect(page.locator('.tl-statusbar')).toContainText('connected');
  await expect.poll(async () => (await setState(set)).count).toBe(painted.count);
  await select(page, set);
  await expect.poll(async () => JSON.parse((await view(page).getAttribute('data-instance-copies')) ?? '[]').length, { timeout: 30_000 }).toBe(Math.min(64, painted.count));

  // Play shows them where they stand.
  const playAfter = await playPicture(page);
  keep('play-before', playBefore.png);
  keep('play-after', playAfter.png);
  expect(copiesSeen(playBefore.img, playAfter.img, gameProjector(playAfter.img), fresh)).toBeGreaterThanOrEqual(Math.ceil(fresh.length * 0.5));

  // Erase across the stroke's first half: those copies go, the rest stay; one undo restores them.
  await frame(page, layer);
  await select(page, set);
  await inspector(page).getByRole('button', { name: 'Erase', exact: true }).click();
  await expect(view(page)).toHaveAttribute('data-brush-mode', 'erase');
  await expect(view(page)).toHaveAttribute('data-view-proj', /\[/);
  await fit(page, [[-23, TOP_Y, -18], [-13, TOP_Y, -14]]);
  await stroke(page, [-21, TOP_Y, -16], [-19, TOP_Y, -16]);
  await expect.poll(async () => (await setState(set)).count).toBeLessThan(painted.count);
  const erased = await setState(set);
  for (const c of erased.copies.slice(1)) {
    const near = Math.hypot(c.x + 21, c.z + 16) <= 1.5 || Math.hypot(c.x + 19, c.z + 16) <= 1.5;
    expect(near, `copy at ${c.x},${c.z} under the erase stroke`).toBe(false);
  }
  expect(erased.copies.slice(1).some((c) => c.x > -17)).toBe(true);
  await undo(page);
  await expect.poll(async () => (await setState(set)).buffer).toBe(painted.buffer);

  // On a model: a stroke over the platform's cap puts copies on the cap.
  await frame(page, platform);
  await select(page, set);
  await inspector(page).getByRole('button', { name: 'Paint', exact: true }).click();
  await setBrush(page, { radius: '0.6', density: '3', spacing: '0.2' });
  await expect(view(page)).toHaveAttribute('data-view-proj', /\[/);
  await fit(page, [[PLATFORM_AT[0] - 3, CAP_Y, PLATFORM_AT[2] - 3], [PLATFORM_AT[0] + 3, CAP_Y, PLATFORM_AT[2] + 3]]);
  const capTop = await (async () => {
    const before = (await setState(set)).count;
    await stroke(page, [PLATFORM_AT[0] - 0.8, CAP_Y, PLATFORM_AT[2]], [PLATFORM_AT[0] + 0.8, CAP_Y, PLATFORM_AT[2]]);
    await expect.poll(async () => (await setState(set)).count).toBeGreaterThan(before);
    const now = (await setState(set)).copies.slice(before);
    return now;
  })();
  const ys = capTop.map((c) => c.y);
  for (const y of ys) expect(y).toBeCloseTo(CAP_Y, 2);
  for (const c of capTop) expect(Math.max(Math.abs(c.x - PLATFORM_AT[0]), Math.abs(c.z - PLATFORM_AT[2]))).toBeLessThanOrEqual(0.45 * 6 + 1e-3);
  await undo(page);
  await expect.poll(async () => (await setState(set)).buffer).toBe(painted.buffer);
  expect(errors).toEqual([]);
  console.log(`instance brush: stroke ${JSON.stringify(t1)}, ${fresh.length} copies; cap at y ${ys[0]}`);
});

test('paintInstances over MCP: no surface drops onto the block layer, erase, one undo each, a stroke too large refused with its reason', async () => {
  test.setTimeout(180_000);
  be = await startBackend(`instance-brush-mcp-${randomBytes(4).toString('hex')}`);
  const { set } = await buildScene();
  const original = await setState(set);
  const mcp = await mcpClient();
  try {
    const brush = { radius: 2, density: 1.5, spacing: 0.4, scale: [0.5, 0.7], yaw: 180, align: 1, seed: 3 };
    const r = await mcpCommand(mcp, 'paintInstances', { entityId: set, mode: 'paint', dabs: [[-20, 2, -16], [-17, 2, -15]], brush });
    expect(r['ok'], JSON.stringify(r).slice(0, 400)).toBe(true);
    const painted = await setState(set);
    expect(painted.count).toBeGreaterThan(5);
    for (const c of painted.copies.slice(1)) expect(c.y).toBeCloseTo(TOP_Y, 3);
    // Outside the block layer (and no surface given) nothing lands.
    const off = await mcpCommand(mcp, 'paintInstances', { entityId: set, mode: 'paint', dabs: [[20, 0, 20]], brush });
    expect(JSON.stringify(off)).toContain('no_change');
    // Erase, then one undo restores; one more undo takes the paint away.
    const e = await mcpCommand(mcp, 'paintInstances', { entityId: set, mode: 'erase', dabs: [[-20, 2, -16]], brush: { ...brush, radius: 1 } });
    expect(e['ok'], JSON.stringify(e).slice(0, 400)).toBe(true);
    expect((await setState(set)).count).toBeLessThan(painted.count);
    expect((await mcpCommand(mcp, 'undo', {}))['ok']).toBe(true);
    expect((await setState(set)).buffer).toBe(painted.buffer);
    expect((await mcpCommand(mcp, 'undo', {}))['ok']).toBe(true);
    expect((await setState(set)).buffer).toBe(original.buffer);
    // More places than one stroke may carry: refused, saying so.
    const big = await mcpCommand(mcp, 'paintInstances', { entityId: set, mode: 'paint', dabs: [[-18, 2, -16]], brush: { ...brush, radius: 40, density: 50 } });
    expect(big['ok']).not.toBe(true);
    expect(JSON.stringify(big)).toMatch(/more than 1536 places/);
    expect((await setState(set)).buffer).toBe(original.buffer);
    // A stroke refused after it was planned (a stale revision) leaves no buffer behind: nothing collects an unused one.
    const blobs = (): number => readdirSync(join(be!.projectDir, 'sources', 'sha256')).length;
    const before = blobs();
    expect(before).toBeGreaterThan(0);
    const revision = Number((await query('queryProject')).revision);
    const stale = await be!.command({ op: 'paintInstances', projectId: be!.projectId, expectedRevision: revision - 1, requestId: `req-${randomBytes(16).toString('hex')}`, origin: { kind: 'mcp', clientId: 'e2e-instance-brush' }, args: { entityId: set, mode: 'paint', dabs: [[-14, 2, -14]], brush } });
    expect(JSON.stringify(stale)).toContain('revision_conflict');
    expect(blobs()).toBe(before);
  } finally {
    await mcp.close();
  }
});
