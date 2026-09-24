/**
 * Phase 9.11: saves in an exported game served statically. Beacon Reach gets
 * a short level (a new scene: a coin, a checkpoint with its safe spawn, a
 * goal) and a one-level flow. In the export, from the keyboard: a new game,
 * the coin collected, the checkpoint reached (the autosave is written);
 * the page reloads, the title offers Continue, and the game continues at the
 * checkpoint with the coin still collected and counted. The Game flow
 * window's "Clear Play save" empties Play's saves.
 */
import { createHash } from 'node:crypto';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, join, normalize } from 'node:path';

import { expect, test } from '@playwright/test';

import { startBackend, type E2EBackend } from './backend';

let be: E2EBackend;
test.beforeEach(async () => {
  be = await startBackend('saves-e2e', 'beacon-reach');
});
test.afterEach(async () => {
  await be.stop();
});

async function revision(): Promise<number> {
  return Number((await be.command({ op: 'queryProject', projectId: be.projectId, args: {} })).revision);
}

async function cmd(op: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const res = await be.command({
    op,
    projectId: be.projectId,
    expectedRevision: await revision(),
    requestId: `req-${createHash('sha256').update(`${op}${Math.random()}`).digest('hex').slice(0, 32)}`,
    origin: { kind: 'mcp', clientId: 'e2e-saves' },
    args,
  });
  expect(res.ok, JSON.stringify(res)).toBe(true);
  return res;
}

test('an exported game saves at a checkpoint and continues there after a reload, the coin still collected', async ({ page }) => {
  test.setTimeout(240_000);
  const x = 200;
  await cmd('createScene', { sceneId: 'scene-s', name: 'Save level' });
  await cmd('createEntity', { sceneId: 'scene-s', kind: 'box', name: 'Save floor', transform: { position: [x, -0.2, 0] }, box: { size: [20, 0.4, 2], material: { color: '#5d7a4a' } }, components: { collider: { shape: { type: 'box', hx: 10, hy: 0.2 } } } });
  const spawn = String((await cmd('createEntity', { sceneId: 'scene-s', kind: 'group', name: 'Save start', transform: { position: [x - 6, 0.91, 0] }, components: { playerSpawn: {} } })).createdId);
  const safe = String((await cmd('createEntity', { sceneId: 'scene-s', kind: 'group', name: 'Save safe spawn', transform: { position: [x + 1, 0.91, 0] }, components: { playerSpawn: {} } })).createdId);
  await cmd('createEntity', { sceneId: 'scene-s', kind: 'box', name: 'Save coin', transform: { position: [x - 3, 0.8, 0] }, box: { size: [0.4, 0.4, 0.1], material: { color: '#f2c230' } }, components: { pickup: { kind: 'coin', value: 1 } } });
  const checkpoint = String(
    (await cmd('createEntity', { sceneId: 'scene-s', kind: 'group', name: 'Save checkpoint', transform: { position: [x, 1, 0] }, components: { gameZone: { role: 'checkpoint', size: [1, 2], safeSpawnId: safe, activation: { emissive: '#1bc8ff', emissiveIntensity: 1, cueAssetId: null } } } })).createdId,
  );
  await cmd('createEntity', { sceneId: 'scene-s', kind: 'group', name: 'Save goal', transform: { position: [x + 8, 1, 0] }, components: { gameZone: { role: 'goal', size: [1, 2] } } });
  await cmd('setFlow', { flow: { levels: [{ id: 'save-1', name: 'Save level', scenes: ['scene-main', 'scene-s'], spawnId: spawn }], lives: { start: 3, max: 5 } } });

  // "Clear Play save" in the Game flow window (Play keeps its own saves).
  await page.goto(be.editorUrl);
  await expect(page.locator('.tl-statusbar')).toContainText('connected');
  await page.getByRole('tab', { name: 'Game flow', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Clear Play save' })).toBeDisabled();
  await page.getByTitle('Start an isolated play preview').click();
  await expect(page.getByRole('button', { name: 'Clear Play save' })).toBeEnabled({ timeout: 30_000 });
  const frameFlow = page.frameLocator('iframe.tl-app__preview-frame').locator('.tl-flow');
  await expect(frameFlow).toHaveAttribute('data-screen', 'title', { timeout: 30_000 });
  await page.getByRole('button', { name: 'Clear Play save' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'The Play save was cleared' })).toBeVisible({ timeout: 10_000 });

  // The export, served statically with the backend stopped.
  const res = await be.admin(`projects/${be.projectId}/export`);
  expect(res.status, JSON.stringify(res.json)).toBe(200);
  await be.halt();
  const dir = join(be.exportRoot, String(res.json.outputDir));
  const server = createServer((req, reply) => {
    const rel = normalize(decodeURIComponent((req.url ?? '/').split('?')[0]!)).replace(/^\/+/, '') || 'index.html';
    const file = join(dir, rel);
    if (!file.startsWith(dir) || !existsSync(file) || !statSync(file).isFile()) {
      reply.statusCode = 404;
      reply.end();
      return;
    }
    const types: Record<string, string> = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json', '.wasm': 'application/wasm' };
    reply.setHeader('content-type', types[extname(file)] ?? 'application/octet-stream');
    createReadStream(file).pipe(reply);
  });
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', () => ok()));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/`;
  try {
    await page.goto(url);
    const flow = page.locator('.tl-flow');
    const hud = page.locator('.tl-game-host-hud');
    await expect(flow).toHaveAttribute('data-screen', 'title', { timeout: 20_000 });
    await expect(flow).not.toContainText('Continue');
    await page.mouse.click(20, 1000);
    await page.keyboard.press('Enter'); // New game
    await expect(flow).toHaveAttribute('data-screen', 'playing');
    await page.waitForTimeout(800);
    // Right: the coin, then the checkpoint (the autosave).
    await page.keyboard.down('d');
    try {
      await expect(flow).toHaveAttribute('data-checkpoint', checkpoint, { timeout: 15_000 });
    } finally {
      await page.keyboard.up('d');
    }
    await expect(flow).toHaveAttribute('data-saved', 'auto');
    await expect(hud).toContainText('Coins 1');

    // Reload: Continue resumes at the checkpoint, the coin still collected.
    await page.reload();
    await expect(flow).toHaveAttribute('data-screen', 'title', { timeout: 20_000 });
    await expect(flow).toContainText('Continue — Save level');
    await page.mouse.click(20, 1000);
    await page.keyboard.press('Enter'); // Continue
    await expect(flow).toHaveAttribute('data-screen', 'playing');
    await expect(flow).toHaveAttribute('data-checkpoint', checkpoint, { timeout: 10_000 });
    await expect(hud).toContainText('Coins 1');
    await expect(flow).toHaveAttribute('data-lives', '3');
    // Walk back over where the coin was: it stays collected (still 1).
    await page.keyboard.down('a');
    await page.waitForTimeout(1500);
    await page.keyboard.up('a');
    await expect(hud).toContainText('Coins 1');
    await expect(page.getByText(/export error/i)).toHaveCount(0);
  } finally {
    await new Promise<void>((ok) => server.close(() => ok()));
  }
});
