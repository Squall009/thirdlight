/**
 * Phase 9.6, the real final bake: Sprout's meadow kit (pieces with their own
 * UV1) baked by Blender Cycles on the bake host. Runs only when the owner's
 * machines are there: TL_BAKE_HOST (e.g. user@workstation), TL_BAKE_BLENDER,
 * and the Sprout kit at TL_SPROUT_KIT (default ~/projects/sprout/…). Play
 * frames before/after are written to TL_BAKE_SHOTS (optional) for a look.
 */
import { existsSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { expect, test } from '@playwright/test';

import { startBackend, type E2EBackend } from './backend';

const host = process.env['TL_BAKE_HOST'];
const blender = process.env['TL_BAKE_BLENDER'] ?? 'blender';
const kit = process.env['TL_SPROUT_KIT'] ?? join(homedir(), 'projects', 'sprout', 'assets', 'env', 'kit', 'meadow', 'env_kit_meadow.glb');
const shots = process.env['TL_BAKE_SHOTS'];

let be: E2EBackend;
let seq = 0;
test.afterEach(async () => {
  await be?.stop();
});

async function cmd(op: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const q = await be.command({ op: 'queryProject', projectId: be.projectId, args: {} });
  seq += 1;
  const res = await be.command({ op, projectId: be.projectId, expectedRevision: q.revision, requestId: `req-${(0x5b0a00 + seq).toString(16).padStart(32, '0')}`, origin: { kind: 'mcp', clientId: 'e2e-sprout-bake' }, args });
  expect(res.ok, JSON.stringify(res)).toBe(true);
  return res;
}

test('the Sprout meadow kit bakes on the bake host (Blender Cycles) and Play uses the lightmaps', async ({ page }) => {
  test.skip(host === undefined || !existsSync(kit), 'needs TL_BAKE_HOST and the Sprout kit');
  test.setTimeout(1_800_000);
  be = await startBackend('e2e-0001', undefined, { THIRDLIGHT_BAKE_HOST: host!, THIRDLIGHT_BAKE_BLENDER: blender, THIRDLIGHT_BAKE_TIMEOUT_MINUTES: '25' });
  await page.goto(be.editorUrl);
  await expect(page.locator('.tl-statusbar')).toContainText('connected');

  // Import the kit (one asset, a piece per `<piece>_LOD<n>` group).
  await page.locator('.tl-assets__file').first().setInputFiles(kit);
  const publish = page.getByRole('button', { name: 'publish' });
  await expect(publish).toBeEnabled({ timeout: 60_000 });
  await publish.click();
  const assets = (await be.command({ op: 'queryAssets', projectId: be.projectId, args: { limit: 10, offset: 0 } }))['assets'] as { assetId: string }[];
  const assetId = assets[0]!.assetId;

  // A strip of ground with a floating ledge above it (pivots: left end, bottom, play plane).
  const row: [string, number, number][] = [
    ['ground_top_end_l', -6, 0],
    ['ground_top_2a', -5, 0],
    ['ground_top_2b', -3, 0],
    ['ground_top_2c', -1, 0],
    ['ground_top_2a', 1, 0],
    ['ground_top_2b', 3, 0],
    ['ground_top_2c', 5, 0],
    ['ground_top_end_r', 7, 0],
    ['ledge_2', -1, 3],
  ];
  const ids: string[] = [];
  for (const [piece, x, y] of row) {
    const id = String((await cmd('createEntity', { kind: 'model', name: piece, model: { asset: { assetId }, piece }, transform: { position: [x, y, 0] } })).createdId);
    await cmd('updateEntity', { entityId: id, static: true });
    ids.push(id);
  }
  await cmd('setTransform', { entityId: 'cam-main', transform: { position: [0.5, 2.5, 9], rotation: [-0.0871557427, 0, 0, 0.9961946981] } });
  await cmd('setComponent', { entityId: 'light-0001', component: 'light', value: { type: 'directional', color: '#fff4e0', intensity: 2, direction: [0.3, -1, -0.4], castShadow: false, mode: 'baked' } });
  await cmd('setComponent', { entityId: 'light-0002', component: 'light', value: { type: 'ambient', color: '#9fb4d6', intensity: 0.5, mode: 'baked' } });

  const frame = page.locator('iframe.tl-app__preview-frame');
  const play = async (name: string): Promise<void> => {
    await page.getByTitle('Start an isolated play preview').click();
    await expect(frame).toBeVisible();
    await page.waitForTimeout(6000);
    const png = await frame.screenshot();
    if (shots !== undefined) writeFileSync(join(shots, `sprout-bake-${name}.png`), png);
    await page.getByTitle('Stop the play preview').click();
  };
  await play('before');

  await page.getByRole('tab', { name: 'Lighting' }).click();
  await expect(page.getByRole('button', { name: 'Bake final (Blender)' })).toBeEnabled();
  const started = Date.now();
  await page.getByRole('button', { name: 'Bake final (Blender)' }).click();
  await expect(page.locator('[aria-label="bake status"]')).toContainText('Final (Blender) bake', { timeout: 1_700_000 });
  const seconds = (Date.now() - started) / 1000;
  const message = await page.getByRole('status').textContent();
  console.log(`[sprout-bake] ${ids.length} kit pieces on ${host}: ${seconds.toFixed(1)} s round trip — ${message}`);
  const config = await be.command({ op: 'queryGameConfig', projectId: be.projectId });
  const bake = Object.values(config['lighting'] as Record<string, { entries: { entityId: string }[]; atlases: string[]; source: string }>)[0]!;
  expect(bake.source).toBe('blender');
  expect(bake.entries.map((e) => e.entityId).sort()).toEqual([...ids].sort());
  expect(message).not.toContain('no lightmap UV');
  await play('after');
});
