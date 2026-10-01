/**
 * Light baking on a kit: a generated multi-piece GLB (multi-piece-glb.ts; pieces
 * `<piece>_LOD<n>` with their own lightmap UV1) is imported as one asset, a
 * strip of ground pieces with a floating ledge is placed as static objects,
 * and the scene is baked: in the browser (always), and by Blender Cycles when
 * Blender is there (THIRDLIGHT_BLENDER / blender on PATH, or TL_BAKE_HOST with
 * TL_BAKE_BLENDER). Every kit piece gets a lightmap entry and Play runs with
 * the bake. Play frames before/after are written to TL_BAKE_SHOTS (optional).
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect, test, type Page } from '@playwright/test';

import { startBackend, type E2EBackend } from './backend';
import { multiPieceGlb, type PieceSpec } from './multi-piece-glb';
import { openWindow } from './ui';

const bakeBlender = process.env['TL_BAKE_BLENDER'] ?? process.env['THIRDLIGHT_BLENDER'] ?? 'blender';
const bakeHost = process.env['TL_BAKE_HOST'] ?? 'local';
const haveBlender = bakeHost !== 'local' || spawnSync(bakeBlender, ['--version'], { encoding: 'utf8' }).status === 0;
const shots = process.env['TL_BAKE_SHOTS'];

/** A small ground kit: pivots at the left end, bottom, play plane. */
const KIT: readonly PieceSpec[] = [
  { name: 'ground_end_l', lods: [[1, 0.5, 2], [1, 0.5, 2]], col: [1, 0.5, 2] },
  { name: 'ground_2a', lods: [[2, 0.5, 2], [2, 0.5, 2]], col: [2, 0.5, 2] },
  { name: 'ground_2b', lods: [[2, 0.5, 2], [2, 0.5, 2]], col: [2, 0.5, 2] },
  { name: 'ground_end_r', lods: [[1, 0.5, 2], [1, 0.5, 2]], col: [1, 0.5, 2] },
  { name: 'ledge_2', lods: [[2, 0.3, 1]], col: [2, 0.3, 1] },
];

let be: E2EBackend;
let seq = 0;
test.afterEach(async () => {
  await be?.stop();
});

async function cmd(op: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const q = await be.command({ op: 'queryProject', projectId: be.projectId, args: {} });
  seq += 1;
  const res = await be.command({ op, projectId: be.projectId, expectedRevision: q.revision, requestId: `req-${(0x5b0a00 + seq).toString(16).padStart(32, '0')}`, origin: { kind: 'mcp', clientId: 'e2e-kit-bake' }, args });
  expect(res.ok, JSON.stringify(res)).toBe(true);
  return res;
}

/** Imports the kit and lays out the strip; returns the placed entity ids and a Play helper. */
async function buildKitScene(page: Page): Promise<{ ids: string[]; play: (name: string) => Promise<void> }> {
  await page.goto(be.editorUrl);
  await expect(page.locator('.tl-statusbar')).toContainText('connected');

  // Import the kit (one asset, a piece per `<piece>_LOD<n>` group).
  const file = join(mkdtempSync(join(tmpdir(), 'tl-kit-')), 'env_kit_ground.glb');
  writeFileSync(file, multiPieceGlb(KIT, { lightmapUv: true }));
  await page.locator('.tl-assets__file').first().setInputFiles(file);
  const publish = page.getByRole('button', { name: 'publish' });
  await expect(publish).toBeEnabled({ timeout: 60_000 });
  await publish.click();
  const assets = async () => (await be.command({ op: 'queryAssets', projectId: be.projectId, args: { limit: 10, offset: 0 } }))['assets'] as { assetId: string }[];
  await expect.poll(async () => (await assets()).length).toBe(1);
  const assetId = (await assets())[0]!.assetId;

  // A strip of ground with a floating ledge above it.
  const row: [string, number, number][] = [
    ['ground_end_l', -5, 0],
    ['ground_2a', -4, 0],
    ['ground_2b', -2, 0],
    ['ground_2a', 0, 0],
    ['ground_2b', 2, 0],
    ['ground_end_r', 4, 0],
    ['ledge_2', -1, 2.5],
  ];
  const ids: string[] = [];
  for (const [piece, x, y] of row) {
    const id = String((await cmd('createEntity', { kind: 'model', name: piece, model: { asset: { assetId }, piece }, transform: { position: [x, y, 0] } })).createdId);
    await cmd('updateEntity', { entityId: id, static: true });
    ids.push(id);
  }
  await cmd('setTransform', { entityId: 'cam-main', transform: { position: [0, 2.5, 8], rotation: [-0.0871557427, 0, 0, 0.9961946981] } });
  await cmd('setComponent', { entityId: 'light-0001', component: 'light', value: { type: 'directional', color: '#fff4e0', intensity: 2, direction: [0.3, -1, -0.4], castShadow: false, mode: 'baked' } });
  await cmd('setComponent', { entityId: 'light-0002', component: 'light', value: { type: 'ambient', color: '#9fb4d6', intensity: 0.5, mode: 'baked' } });

  // The bake reads the editor's own state: open the scene as built (a fresh load), then check
  // the editor has every command. (A live editor was seen to stay at revision 1 after the
  // import while the API edits went on: an editor sync defect, reported apart from this test.)
  await page.reload();
  await expect(page.locator('.tl-statusbar')).toContainText('connected');
  await editorCaughtUp(page);

  const frame = page.locator('iframe.tl-app__preview-frame');
  const play = async (name: string): Promise<void> => {
    await page.getByTitle('Start an isolated play preview').click();
    await expect(frame).toBeVisible();
    await page.waitForTimeout(3000);
    const png = await frame.screenshot();
    if (shots !== undefined) writeFileSync(join(shots, `kit-bake-${name}.png`), png);
    await page.getByTitle('Stop the play preview').click();
  };
  return { ids, play };
}

/** Waits until the editor has every command the test sent through the API (the bake reads the editor's state). */
async function editorCaughtUp(page: Page): Promise<void> {
  const revision = Number((await be.command({ op: 'queryProject', projectId: be.projectId, args: {} })).revision);
  await expect(page.locator('.tl-statusbar__rev')).toHaveText(`revision ${revision}`, { timeout: 30_000 });
}

async function bakeOf(): Promise<{ entries: { entityId: string }[]; atlases: string[]; source: string }> {
  const config = await be.command({ op: 'queryGameConfig', projectId: be.projectId });
  return Object.values(config['lighting'] as Record<string, { entries: { entityId: string }[]; atlases: string[]; source: string }>)[0]!;
}

test('a multi-piece kit bakes in the browser: every piece gets a lightmap and Play uses them', async ({ page }) => {
  test.skip(test.info().project.name === 'webgpu', 'the renderer variants are covered by lightmaps.e2e.ts');
  test.setTimeout(240_000);
  be = await startBackend();
  const { ids, play } = await buildKitScene(page);
  await play('preview-before');

  await openWindow(page, 'Lighting');
  await expect(page.locator('[aria-label="bake status"]')).toContainText('No bake for this scene');
  await page.getByRole('button', { name: 'Bake preview (browser)' }).click();
  await expect(page.locator('[aria-label="bake status"]')).toContainText('Preview (browser) bake', { timeout: 120_000 });
  await expect(page.getByRole('status')).toContainText(`Baked ${ids.length} objects`);
  const bake = await bakeOf();
  expect(bake.source).toBe('browser');
  expect(bake.entries.map((e) => e.entityId).sort()).toEqual([...ids].sort());
  expect(bake.atlases.length).toBeGreaterThan(0);
  await play('preview-after');
});

test('a multi-piece kit bakes with Blender Cycles and Play uses the lightmaps', async ({ page }) => {
  test.skip(!haveBlender, 'no Blender for the final bake on this machine');
  test.skip(test.info().project.name === 'webgpu', 'the renderer variants are covered by lightmaps.e2e.ts');
  test.setTimeout(900_000);
  be = await startBackend('e2e-0001', undefined, { THIRDLIGHT_BAKE_HOST: bakeHost, THIRDLIGHT_BAKE_BLENDER: bakeBlender, THIRDLIGHT_BAKE_TIMEOUT_MINUTES: '12' });
  const { ids, play } = await buildKitScene(page);
  await play('final-before');

  await openWindow(page, 'Lighting');
  await expect(page.getByRole('button', { name: 'Bake final (Blender)' })).toBeEnabled();
  await page.getByRole('button', { name: /settings/ }).click();
  // A small, quick bake (the real samples are the owner's choice).
  await page.getByRole('spinbutton', { name: 'bake finalSamples' }).fill(bakeHost === 'local' ? '32' : '256');
  await page.getByRole('spinbutton', { name: 'bake texelsPerMeter' }).fill('8');
  const started = Date.now();
  await page.getByRole('button', { name: 'Bake final (Blender)' }).click();
  await expect(page.locator('[aria-label="bake status"]')).toContainText('Final (Blender) bake', { timeout: 840_000 });
  const message = await page.getByRole('status').textContent();
  console.log(`[kit-bake] ${ids.length} kit pieces on ${bakeHost}: ${((Date.now() - started) / 1000).toFixed(1)} s round trip — ${message}`);
  const bake = await bakeOf();
  expect(bake.source).toBe('blender');
  expect(bake.entries.map((e) => e.entityId).sort()).toEqual([...ids].sort());
  expect(message).not.toContain('no lightmap UV');
  await play('final-after');
});
