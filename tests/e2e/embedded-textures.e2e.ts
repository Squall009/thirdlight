/**
 * Images inside model files count against the texture budget, against a real
 * backend in a real browser, per renderer variant (renderer-variants.ts).
 *
 * Two of the scale bench's model files (UV spheres) carry their base colour
 * inside the GLB: a 1024² WebP and a 512² Basis Universal KTX2 with mips. A
 * 2048² KTX2 checker texture asset (it streams by default) is on a box close
 * to the camera, so it wants its full-size level.
 *
 * - The Scene view and Play count the same: the models' embedded texture
 *   bytes in the view's `data-resources` equal Play's, which reads them over
 *   HTTP (observe and Play diagnostics) both under the models' resident bytes
 *   and in the texture budget's totals (`fixedBytes`, `residentBytes`,
 *   `embedded` with the models listed).
 * - Under a budget that holds the checker's full chain plus half the embedded
 *   bytes, the checker cannot get level 0 while the models are loaded (the
 *   budget's pressure reacts to them) and the resident bytes stay inside the
 *   budget; with the models removed, the same budget gives it level 0.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { expect, test, type Page } from '@playwright/test';

import { encodeKtx2 } from '../../packages/backend/src/texture-encode';
import { sphereGlbWith } from '../../tools/perf/assets';
import { publishBytes, startBackend, type E2EBackend } from './backend';
import { makePng } from './png-make';
import { editorUrlFor, expectRendererBackend, onlyInItsProject, RENDERER_VARIANTS } from './renderer-variants';
import { makeTwoColourWebp } from './webp-make';

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
  const res = await be!.command({ op, projectId: be!.projectId, expectedRevision: revision, requestId: `req-${randomBytes(16).toString('hex')}`, origin: { kind: 'mcp', clientId: 'e2e-embedded-textures' }, args });
  expect(res['ok'], JSON.stringify(res).slice(0, 400)).toBe(true);
  return res;
}
async function api(path: string, body: unknown): Promise<{ status: number; json: Record<string, unknown> }> {
  const r = await fetch(`${be!.origin}/api/v1/projects/${be!.projectId}/${path}`, { method: 'POST', headers: { authorization: `Bearer ${be!.token}`, origin: be!.origin, 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const text = await r.text();
  return { status: r.status, json: text === '' ? {} : (JSON.parse(text) as Record<string, unknown>) };
}

interface Embedded {
  count: number;
  bytes: number;
  resources: number;
  largest: { kind: string; key: string; count: number; bytes: number }[];
}
interface Textures {
  budgetBytes: number;
  residentBytes: number;
  streamedBytes: number;
  fixedBytes: number;
  over: boolean;
  textures: { id: string; resident: number; wanted: number; bytes: number }[];
  embedded?: Embedded;
}
interface Resources {
  resident: Record<string, { count: number; bytes: number; textures?: { count: number; bytes: number } }>;
  textures?: Textures;
}

const checkerOf = (t: Textures | undefined): Textures['textures'][number] | undefined => t?.textures.find((x) => x.id === 'checker');

async function startPlay(page: Page): Promise<{ psid: string; resources: () => Promise<Resources | null>; diagnostics: () => Promise<Resources | null> }> {
  const started = page.waitForResponse((r) => r.request().method() === 'POST' && r.url().endsWith('/play'));
  await page.getByTitle('Start an isolated play preview').click();
  const psid = String(((await (await started).json()) as { playSessionId: string }).playSessionId);
  await expect(page.locator('iframe.tl-app__preview-frame')).toBeVisible();
  await expect.poll(async () => (await api(`play/${psid}/observe`, {})).json['state'], { timeout: 60_000 }).toBe('running');
  const resources = async (): Promise<Resources | null> => {
    const r = await api(`play/${psid}/observe`, {});
    return r.status === 200 ? ((r.json['resources'] as Resources | undefined) ?? null) : null;
  };
  const diagnostics = async (): Promise<Resources | null> => {
    const r = await api(`play/${psid}/diagnostics`, {});
    return r.status === 200 ? (((r.json['diagnostics'] as { resources?: Resources } | undefined)?.resources ?? null)) : null;
  };
  return { psid, resources, diagnostics };
}

for (const variant of RENDERER_VARIANTS) test(`images inside model files count against the texture budget, in the Scene view and in Play (${variant})`, async ({ page }) => {
  onlyInItsProject(variant);
  test.setTimeout(420_000);
  be = await startBackend(`embedded-tex-${randomUUID().slice(0, 8)}`);
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));

  // The models: the bench's sphere with a WebP and with a KTX2 (the engine's encoder) inside.
  const webp = makeTwoColourWebp(1024, 1024, [220, 90, 40], [40, 160, 220], (x, y) => (((x >> 5) + (y >> 5)) % 2 === 0 ? 0 : 1));
  const encoded = await encodeKtx2(makePng(512, 512, (x, y) => (((x >> 4) + (y >> 4)) % 2 === 0 ? [240, 220, 40, 255] : [30, 120, 60, 255])), 'color');
  if (!encoded.ok) throw new Error(encoded.message);
  // Imported with their images kept inside (the "extract textures" setting off): what this spec counts.
  await publishBytes(be, sphereGlbWith(16, { bytes: webp, format: 'webp' }, 'webp-ball'), 'model', 'webp-ball', 'webp-ball', {}, { extractTextures: false });
  await publishBytes(be, sphereGlbWith(16, { bytes: encoded.ktx2, format: 'ktx2' }, 'ktx2-ball'), 'model', 'ktx2-ball', 'ktx2-ball', {}, { extractTextures: false });
  await publishBytes(be, new Uint8Array(makePng(2048, 2048, (x, y) => (((x >> 3) + (y >> 3)) % 2 === 0 ? [235, 235, 235, 255] : [15, 15, 15, 255]))), 'texture', 'checker', 'checker', { ktx2: 'color' });

  // The scene: the camera at z 6 looking along −Z, the checker on an unlit box in front, the two spheres beside it.
  await cmd('setMaterial', { material: { materialId: 'mat-checker', name: 'Checker', shader: 'unlit', params: { tiling: [0.125, 0.125] }, textures: { map: 'checker' } } });
  await cmd('setEnvironment', { sceneId: 'scene-main', environment: { sky: { mode: 'color', color: '#303030' } } });
  const ents = ((await query('queryEntities', { limit: 100, offset: 0 })) as { entities: { id: string; components: Record<string, unknown> }[] }).entities;
  const cam = ents.find((e) => e.components['camera'] !== undefined)!.id;
  await cmd('setTransform', { entityId: cam, transform: { position: [0, 0, 6], rotation: [0, 0, 0, 1] } });
  for (const e of ents) if (e.components['box'] !== undefined || e.components['model'] !== undefined) await cmd('setTransform', { entityId: e.id, transform: { position: [0, -50, 0] } });
  const box = String((await cmd('createEntity', { parentId: null, kind: 'box', name: 'Checker box', transform: { position: [0, 0, 3] }, box: { size: [2, 2, 0.05], material: { color: '#ffffff' } } }))['createdId']);
  await cmd('setComponent', { entityId: box, component: 'materials', value: { '*': 'mat-checker' } });
  const balls: string[] = [];
  for (const [assetId, x] of [['webp-ball', -2.2], ['ktx2-ball', 2.2]] as const) {
    balls.push(String((await cmd('createEntity', { parentId: null, kind: 'model', name: assetId, model: { asset: { assetId } }, transform: { position: [x, -0.5, 1] } }))['createdId']));
  }

  await page.goto(editorUrlFor(be.editorUrl, variant));
  await expect(page.locator('.tl-statusbar')).toContainText('connected');

  // ---- The Scene view holds both models and counts their images.
  const viewResident = async (): Promise<Resources['resident'] | null> => {
    const a = await page.locator('[data-resources]').first().getAttribute('data-resources');
    return a === null ? null : (JSON.parse(a) as Resources['resident']);
  };
  await expect.poll(async () => (await viewResident())?.['model']?.textures?.count ?? 0, { timeout: 60_000 }).toBe(2);
  const inView = (await viewResident())!['model']!;
  expect(inView.textures!.bytes).toBeGreaterThan(1024 * 1024 * 4);
  expect(inView.textures!.bytes).toBeLessThan(inView.bytes);

  // ---- Play at the default budget: the images are in the texture totals, the checker gets level 0.
  const play = await startPlay(page);
  await expectRendererBackend(page.frameLocator('iframe.tl-app__preview-frame').locator('canvas').first(), variant);
  await expect.poll(async () => checkerOf((await play.resources())?.textures)?.resident ?? -1, { timeout: 60_000 }).toBe(0);
  await expect.poll(async () => (await play.resources())?.textures?.embedded?.count ?? 0, { timeout: 30_000 }).toBe(2);
  const observed = (await play.resources())!;
  const embedded = observed.textures!.embedded!;
  // The same bytes the Scene view counts, under the models and in the budget's totals.
  expect(embedded.bytes).toBe(inView.textures!.bytes);
  expect(observed.resident['model']!.textures).toEqual({ count: 2, bytes: embedded.bytes });
  expect(embedded.resources).toBe(2);
  expect(embedded.largest.map((m) => m.key.split('@')[0]).sort()).toEqual(['ktx2-ball', 'webp-ball']);
  // The WebP decodes to RGBA with mips (4/3 of 4 MiB); the KTX2 keeps its transcoded mips, far smaller.
  const webpBytes = embedded.largest.find((m) => m.key.startsWith('webp-ball@'))!.bytes;
  expect(webpBytes).toBe(Math.round((1024 * 1024 * 4 * 4) / 3));
  expect(embedded.largest.find((m) => m.key.startsWith('ktx2-ball@'))!.bytes).toBeLessThan(webpBytes);
  const textures = observed.textures!;
  expect(textures.fixedBytes).toBeGreaterThanOrEqual(embedded.bytes);
  expect(textures.residentBytes).toBe(textures.streamedBytes + textures.fixedBytes);
  const fullChain = checkerOf(textures)!.bytes;
  // Play diagnostics (the MCP's `tl_diagnostics`) carry the same block.
  const diag = (await play.diagnostics())!;
  expect(diag.textures!.embedded!.bytes).toBe(embedded.bytes);
  const shotDir = join(homedir(), '.cache', 'thirdlight-e2e-shots');
  mkdirSync(shotDir, { recursive: true });
  writeFileSync(join(shotDir, `embedded-textures-${variant}.png`), await page.locator('iframe.tl-app__preview-frame').screenshot());
  await page.getByTitle('Stop the play preview').click();
  test.info().annotations.push({ type: 'embedded', description: JSON.stringify({ variant, embeddedBytes: embedded.bytes, viewBytes: inView.textures!.bytes, fullChain, fixed: textures.fixedBytes }) });

  // ---- A budget for the checker's full chain and half the images: with the models loaded it cannot have level 0.
  const budgetMb = Math.ceil((fullChain + embedded.bytes / 2) / (1024 * 1024));
  const budget = budgetMb * 1024 * 1024;
  expect(fullChain + embedded.bytes).toBeGreaterThan(budget);
  await cmd('setSettings', { settings: { texture_budget_mb: budgetMb } });
  const pressed = await startPlay(page);
  await expect.poll(async () => checkerOf((await pressed.resources())?.textures)?.wanted ?? -1, { timeout: 60_000 }).toBe(0);
  await expect.poll(async () => (await pressed.resources())?.textures?.embedded?.count ?? 0, { timeout: 30_000 }).toBe(2);
  // Give the streamer time to move as far as the budget lets it.
  await page.waitForTimeout(3_000);
  const underPressure: Textures[] = [];
  for (let i = 0; i < 5; i++) {
    underPressure.push((await pressed.resources())!.textures!);
    await page.waitForTimeout(300);
  }
  for (const t of underPressure) {
    expect(t.budgetBytes).toBe(budget);
    expect(t.embedded!.bytes).toBe(embedded.bytes);
    expect(checkerOf(t)!.resident).toBeGreaterThan(0);
    expect(t.residentBytes).toBeLessThanOrEqual(budget);
    expect(t.over).toBe(false);
  }
  await page.getByTitle('Stop the play preview').click();

  // ---- The same budget without the models: nothing presses, the checker gets level 0.
  for (const id of balls) await cmd('deleteEntity', { entityId: id });
  const free = await startPlay(page);
  await expect.poll(async () => checkerOf((await free.resources())?.textures)?.resident ?? -1, { timeout: 60_000 }).toBe(0);
  const unpressed = (await free.resources())!.textures!;
  expect(unpressed.embedded?.bytes ?? 0).toBe(0);
  expect(unpressed.residentBytes).toBeLessThanOrEqual(budget);
  await page.getByTitle('Stop the play preview').click();
  test.info().annotations.push({ type: 'budget', description: JSON.stringify({ variant, budgetBytes: budget, pressedLevel: checkerOf(underPressure[0])!.resident, pressedResident: underPressure[0]!.residentBytes, freeResident: unpressed.residentBytes }) });
  expect(errors).toEqual([]);
});
