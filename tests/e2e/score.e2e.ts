/**
 * Phase 14.3: score rules. Beacon Reach gets a short level (a new scene:
 * three coins on the way to a goal) and a one-level flow; the Game flow
 * window's Score section sets 10 points per coin and a time bonus. In the
 * export served statically, from the keyboard: a new game, the three coins
 * collected (the HUD shows "Score 30"), the goal reached (the level complete
 * screen shows the time bonus, the score and a new best). After a reload the
 * best score is still known (a new game's pause menu shows it).
 */
import { createHash } from 'node:crypto';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, join, normalize } from 'node:path';

import { expect, test } from '@playwright/test';

import { startBackend, type E2EBackend } from './backend';

let be: E2EBackend;
test.beforeEach(async () => {
  be = await startBackend('score-e2e', 'beacon-reach');
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
    origin: { kind: 'mcp', clientId: 'e2e-score' },
    args,
  });
  expect(res.ok, JSON.stringify(res)).toBe(true);
  return res;
}

const storedScore = async (): Promise<unknown> => ((await be.command({ op: 'queryGameConfig', projectId: be.projectId, args: {} }))['flow'] as { score?: unknown } | undefined)?.score;

test('score rules set in the Game flow window: the HUD and the level complete screen show the score, a reload keeps the best', async ({ page }) => {
  test.setTimeout(240_000);
  const x = 200;
  await cmd('createScene', { sceneId: 'scene-s', name: 'Score level' });
  await cmd('createEntity', { sceneId: 'scene-s', kind: 'box', name: 'Score floor', transform: { position: [x, -0.2, 0] }, box: { size: [20, 0.4, 2], material: { color: '#5d7a4a' } }, components: { collider: { shape: { type: 'box', hx: 10, hy: 0.2 } } } });
  const spawn = String((await cmd('createEntity', { sceneId: 'scene-s', kind: 'group', name: 'Score start', transform: { position: [x - 6, 0.91, 0] }, components: { playerSpawn: {} } })).createdId);
  for (const [i, cx] of [x - 4.5, x - 3, x - 1.5].entries()) {
    await cmd('createEntity', { sceneId: 'scene-s', kind: 'box', name: `Score coin ${i + 1}`, transform: { position: [cx, 0.8, 0] }, box: { size: [0.4, 0.4, 0.1], material: { color: '#f2c230' } }, components: { pickup: { kind: 'coin', value: 1 } } });
  }
  await cmd('createEntity', { sceneId: 'scene-s', kind: 'group', name: 'Score goal', transform: { position: [x + 8, 1, 0] }, components: { gameZone: { role: 'goal', size: [1, 2] } } });
  await cmd('setFlow', { flow: { levels: [{ id: 'score-1', name: 'Score level', scenes: ['scene-main', 'scene-s'], spawnId: spawn }] } });

  // The Game flow window's Score section.
  await page.goto(be.editorUrl);
  await expect(page.locator('.tl-statusbar')).toContainText('connected');
  await page.getByRole('tab', { name: 'Game flow', exact: true }).click();
  const keep = page.getByLabel('keep score', { exact: true });
  await expect(keep).not.toBeChecked();
  await keep.click();
  await expect.poll(storedScore).toEqual({});
  await page.getByLabel('scored counter', { exact: true }).fill('coins');
  await page.getByLabel('points for the new counter', { exact: true }).fill('10');
  await page.getByRole('button', { name: 'Add counter' }).click();
  await expect.poll(storedScore).toEqual({ points: { coins: 10 } });
  await expect(page.getByLabel('points per coins', { exact: true })).toHaveValue('10');
  await page.getByLabel('time bonus', { exact: true }).click();
  await expect.poll(storedScore).toEqual({ points: { coins: 10 }, timeBonus: { targetSeconds: 60, perSecond: 10 } });
  const perSecond = page.getByLabel('time bonus points per second', { exact: true });
  await perSecond.fill('5');
  await perSecond.press('Enter');
  await expect.poll(storedScore).toEqual({ points: { coins: 10 }, timeBonus: { targetSeconds: 60, perSecond: 5 } });

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
    await page.mouse.click(20, 1000);
    await page.keyboard.press('Enter'); // New game
    await expect(flow).toHaveAttribute('data-screen', 'playing');
    await expect(flow).toHaveAttribute('data-best', '');
    await expect(hud).toContainText('Score 0');
    await page.waitForTimeout(800);

    // Right over the three coins: the HUD counts 10 points each.
    await page.keyboard.down('d');
    try {
      await expect(flow).toHaveAttribute('data-score', '30', { timeout: 15_000 });
    } finally {
      await page.keyboard.up('d');
    }
    await expect(hud).toContainText('Coins 3');
    await expect(hud).toContainText('Score 30');

    // On to the goal: the level complete screen shows the time bonus, the score and a new best.
    await page.keyboard.down('d');
    try {
      await expect(flow).toHaveAttribute('data-screen', 'levelComplete', { timeout: 15_000 });
    } finally {
      await page.keyboard.up('d');
    }
    const lines = (await flow.locator('.tl-flow__line').allTextContents()).join('\n');
    const bonus = Number(/Time bonus (\d+)/.exec(lines)?.[1]);
    const score = Number(/^Score (\d+)$/m.exec(lines)?.[1]);
    expect(bonus, lines).toBeGreaterThan(0); // well under the 60 s target
    expect(bonus, lines).toBeLessThanOrEqual(300);
    expect(score, lines).toBe(30 + bonus);
    expect(lines).toContain('New best score!');
    await expect(flow).toHaveAttribute('data-best', String(score));

    // Reload: the best score is kept (a new game's pause menu shows it).
    await page.reload();
    await expect(flow).toHaveAttribute('data-screen', 'title', { timeout: 20_000 });
    await page.mouse.click(20, 1000);
    await page.keyboard.press('Enter'); // New game
    await expect(flow).toHaveAttribute('data-screen', 'playing');
    await expect(flow).toHaveAttribute('data-best', String(score));
    await expect(hud).toContainText('Score 0');
    await page.waitForTimeout(500);
    await page.keyboard.press('Escape');
    await expect(flow).toHaveAttribute('data-screen', 'paused');
    await expect(flow).toContainText(`Best score ${score}`);
    await expect(page.getByText(/export error/i)).toHaveCount(0);
  } finally {
    await new Promise<void>((ok) => server.close(() => ok()));
  }
});
