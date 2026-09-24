/**
 * Phase 9.10: game flow, menus and music. Beacon Reach gets two short levels
 * (two new scenes far to the right), a music track (an Ogg made by
 * fixtures/music/make-music.py) imported through the Asset browser, and a
 * flow set up in the Game window. Then, in Play and in the export served
 * statically, from the keyboard only: the title screen, level 1 → both lives
 * lost on a hazard → game over → retry → level complete → level 2 → pause →
 * settings → music volume up (the music bus gain node) → resume → level
 * complete → the end screen. TL_FLOW_SHOTS=<dir> saves the title and
 * settings screens for a look.
 */
import { createHash } from 'node:crypto';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, join, normalize, resolve } from 'node:path';

import { expect, test, type Locator, type Page } from '@playwright/test';

import { startBackend, type E2EBackend } from './backend';

let be: E2EBackend;
test.beforeEach(async () => {
  be = await startBackend('flow-e2e', 'beacon-reach');
});
test.afterEach(async () => {
  await be.stop();
});

const REPO = resolve(import.meta.dirname, '..', '..');

async function revision(): Promise<number> {
  return Number((await be.command({ op: 'queryProject', projectId: be.projectId, args: {} })).revision);
}

async function cmd(op: string, args: Record<string, unknown>): Promise<void> {
  const res = await be.command({
    op,
    projectId: be.projectId,
    expectedRevision: await revision(),
    requestId: `req-${createHash('sha256').update(`${op}${Math.random()}`).digest('hex').slice(0, 32)}`,
    origin: { kind: 'mcp', clientId: 'e2e-flow' },
    args,
  });
  expect(res.ok, JSON.stringify(res)).toBe(true);
}

/** A short level far to the right: floor, spawn, goal 4 m on, and (optionally) a hazard 4 m back. */
async function levelScene(sceneId: string, name: string, x: number, hazard: boolean): Promise<void> {
  await cmd('createScene', { sceneId, name });
  await cmd('createEntity', { sceneId, kind: 'box', name: `${name} floor`, transform: { position: [x, -0.2, 0] }, box: { size: [16, 0.4, 2], material: { color: '#5d7a4a' } }, components: { collider: { shape: { type: 'box', hx: 8, hy: 0.2 } } } });
  await cmd('createEntity', { sceneId, kind: 'group', name: `${name} spawn`, transform: { position: [x, 0.91, 0] }, components: { playerSpawn: {} } });
  await cmd('createEntity', { sceneId, kind: 'group', name: `${name} goal`, transform: { position: [x + 4, 1, 0] }, components: { gameZone: { role: 'goal', size: [1, 2] } } });
  if (hazard) await cmd('createEntity', { sceneId, kind: 'group', name: `${name} lava`, transform: { position: [x - 4, 0.3, 0] }, components: { gameZone: { role: 'hazard', size: [1, 0.6] } } });
}

/** Hold a key until the menu shows `screen` (the game keeps running meanwhile). */
async function holdUntil(page: Page, flow: Locator, key: string, screen: string, timeout = 20_000): Promise<void> {
  await page.keyboard.down(key);
  try {
    await expect(flow).toHaveAttribute('data-screen', screen, { timeout });
  } finally {
    await page.keyboard.up(key);
  }
}

/** The whole run from the title screen to the end screen (Play and the export alike). */
async function playThrough(page: Page, flow: Locator, musicGain: () => Promise<number>): Promise<void> {
  await expect(flow).toHaveAttribute('data-screen', 'title', { timeout: 20_000 });
  await expect(flow).toContainText('Two tiny levels');
  if (process.env['TL_FLOW_SHOTS'] !== undefined) await page.screenshot({ path: join(process.env['TL_FLOW_SHOTS'], `title-${Date.now()}.png`) });
  await page.keyboard.press('Enter'); // New game
  await expect(flow).toHaveAttribute('data-screen', 'playing');
  await expect(flow).toHaveAttribute('data-level', 'level-1');
  await expect(flow).toHaveAttribute('data-lives', '2');
  // The key press unlocked sound: the level's Ogg music decodes and loops.
  await expect(flow).toHaveAttribute('data-music-playing', 'true', { timeout: 15_000 });
  await page.waitForTimeout(600); // the level's scene settles in

  // Into the lava until both lives are gone.
  await holdUntil(page, flow, 'a', 'gameOver');
  await expect(flow).toHaveAttribute('data-lives', '0');
  await expect(flow).toContainText('Game over');
  await page.keyboard.press('Enter'); // Retry level
  await expect(flow).toHaveAttribute('data-screen', 'playing');
  await expect(flow).toHaveAttribute('data-lives', '2');
  await page.waitForTimeout(500);

  await holdUntil(page, flow, 'd', 'levelComplete');
  await expect(flow).toContainText('Level complete');
  await page.keyboard.press('Enter'); // Next level
  await expect(flow).toHaveAttribute('data-level', 'level-2');
  await expect(flow).toHaveAttribute('data-screen', 'playing');
  await page.waitForTimeout(800);

  // Pause → Settings → music volume up: the music bus gain follows.
  await page.keyboard.press('Escape');
  await expect(flow).toHaveAttribute('data-screen', 'paused');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  await expect(flow).toHaveAttribute('data-screen', 'settings');
  await expect(flow).toContainText('Music volume: 80%');
  await page.keyboard.press('ArrowRight');
  await expect(flow).toContainText('Music volume: 90%');
  if (process.env['TL_FLOW_SHOTS'] !== undefined) await page.screenshot({ path: join(process.env['TL_FLOW_SHOTS'], `settings-${Date.now()}.png`) });
  await expect(flow).toHaveAttribute('data-music-gain', '0.90');
  expect(await musicGain()).toBeCloseTo(0.9, 5);
  await page.keyboard.press('Escape'); // back to the pause menu
  await expect(flow).toHaveAttribute('data-screen', 'paused');
  await page.keyboard.press('Escape'); // resume
  await expect(flow).toHaveAttribute('data-screen', 'playing');

  await holdUntil(page, flow, 'd', 'levelComplete');
  await page.keyboard.press('Enter'); // Finish
  await expect(flow).toHaveAttribute('data-screen', 'finished');
  await expect(flow).toContainText('Thanks for playing');
}

test('two levels through the title screen, game over, pause and music volume — in Play and in the export', async ({ page }) => {
  test.setTimeout(300_000);
  await levelScene('scene-a', 'Level A', 200, true);
  await levelScene('scene-b', 'Level B', 300, false);

  await page.goto(be.editorUrl);
  await expect(page.locator('.tl-statusbar')).toContainText('connected');

  // The music track through the Asset browser (kind "music").
  await page.getByRole('tab', { name: 'Assets' }).click();
  await page.locator('.tl-assets__file').first().setInputFiles(join(REPO, 'fixtures', 'music', 'chord.ogg'));
  const publish = page.getByRole('button', { name: 'publish' });
  await expect(publish).toBeEnabled({ timeout: 15_000 });
  await publish.click();
  await expect(page.locator('.tl-assets__list li[data-asset-id]').filter({ hasText: 'chord' })).toContainText('music', { timeout: 10_000 });

  // Open the level scenes (their spawns become choosable).
  for (const name of ['Level A', 'Level B']) {
    await page.getByLabel('open scene', { exact: true }).selectOption({ label: name });
    await expect(page.locator('.tl-hierarchy__list li.tl-row').filter({ hasText: `${name} spawn` })).toHaveCount(1);
  }

  // The Game window: two levels, two lives, a subtitle, the music, credits.
  await page.getByRole('tab', { name: 'Game flow', exact: true }).click();
  await page.getByRole('button', { name: 'Set up levels and menus' }).click();
  const level1 = page.getByLabel('level Level 1', { exact: true });
  await expect(level1).toBeVisible();
  {
    const box = level1.getByLabel('level 1 loads Level A', { exact: true });
    await box.click();
    await expect(box).toBeChecked();
  }
  await level1.getByLabel('level 1 spawn', { exact: true }).selectOption({ label: 'Level A spawn (Level A)' });
  await level1.getByLabel('level 1 music', { exact: true }).selectOption({ label: 'chord' });
  await page.getByRole('button', { name: 'Add level' }).click();
  const level2 = page.getByLabel('level Level 2', { exact: true });
  {
    const box = level2.getByLabel('level 2 loads Level B', { exact: true });
    await box.click();
    await expect(box).toBeChecked();
  }
  await level2.getByLabel('level 2 spawn', { exact: true }).selectOption({ label: 'Level B spawn (Level B)' });
  await expect(level2.getByLabel('level 2 spawn', { exact: true })).toHaveValue(/.+/);
  {
    const box = level2.getByLabel('level 2 loads Level A', { exact: true });
    await box.click();
    await expect(box).not.toBeChecked();
  }
  const lives = page.getByLabel('lives at start', { exact: true });
  await lives.fill('2');
  await lives.press('Enter');
  const subtitle = page.getByLabel('title subtitle', { exact: true });
  await subtitle.fill('Two tiny levels');
  await subtitle.press('Enter');
  const credits = page.getByLabel('credits', { exact: true });
  await credits.fill('Thanks for playing');
  await credits.blur();
  await expect.poll(async () => JSON.stringify((await be.command({ op: 'queryGameConfig', projectId: be.projectId, args: {} }))['flow'])).toContain('Thanks for playing');
  const flow = (await be.command({ op: 'queryGameConfig', projectId: be.projectId, args: {} }))['flow'] as { levels: { scenes: string[]; spawnId: string; music?: string }[]; lives: unknown; title: unknown };
  expect(flow.levels.map((l) => l.scenes.sort())).toEqual([['scene-a', 'scene-main'], ['scene-b', 'scene-main']]);
  expect(flow.levels[0]!.music).toMatch(/.+/);
  expect(flow.lives).toEqual({ start: 2, max: 9 });

  // Play.
  const started = page.waitForResponse((r) => r.request().method() === 'POST' && r.url().endsWith('/play'));
  await page.getByTitle('Start an isolated play preview').click();
  const psid = String(((await (await started).json()) as { playSessionId: string }).playSessionId);
  const observe = async (): Promise<Record<string, unknown>> => {
    const r = await fetch(`${be.origin}/api/v1/projects/${be.projectId}/play/${psid}/observe`, { method: 'POST', headers: { authorization: `Bearer ${be.token}`, 'content-type': 'application/json' }, body: '{}' });
    return (await r.json()) as Record<string, unknown>;
  };
  await expect.poll(async () => (await observe())['ok'], { timeout: 30_000 }).toBe(true);
  const frame = page.frameLocator('iframe.tl-app__preview-frame');
  await page.locator('iframe.tl-app__preview-frame').click();
  await playThrough(page, frame.locator('.tl-flow'), async () => ((await observe())['flow'] as { music: { gain: number } }).music.gain);
  expect(((await observe())['flow'] as { screen: string }).screen).toBe('finished');

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
    await expect(page.locator('.tl-flow')).toHaveAttribute('data-screen', 'title', { timeout: 20_000 });
    await page.mouse.click(20, 1000); // the canvas (a corner away from the menu)
    const flowRoot = page.locator('.tl-flow');
    await playThrough(page, flowRoot, async () => Number(await flowRoot.getAttribute('data-music-gain')));
    await expect(page.getByText(/export error/i)).toHaveCount(0);
  } finally {
    await new Promise<void>((ok) => server.close(() => ok()));
  }
});
