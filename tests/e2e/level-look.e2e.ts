/**
 * Phase 14.4: per-level environment ("level look"). Beacon Reach gets two
 * short levels (a scene each, a floor and a goal); in the Game flow window
 * "Level look…" on level 2 opens the Environment window for its look: an own
 * sky (a solid magenta) and own post-processing (no tone mapping, lift up to
 * 0.5). The Scene view shows the look while "level look" is on (and the
 * project environment when it is off; also for the active scene's level). In
 * the export, served statically: level 1 plays with the project sky; after
 * level 1 completes, level 2 shows the magenta sky lifted to pink
 * (#ff80ff: lift 0.5 raises the green channel from 0 to one half).
 */
import { createHash } from 'node:crypto';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, join, normalize } from 'node:path';

import { expect, test, type Locator, type Page } from '@playwright/test';

import { startBackend, type E2EBackend } from './backend';
import { decodePng, type Image } from './png';

let be: E2EBackend;
test.beforeEach(async () => {
  be = await startBackend('level-look-e2e', 'beacon-reach');
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
    origin: { kind: 'mcp', clientId: 'e2e-level-look' },
    args,
  });
  expect(res.ok, JSON.stringify(res)).toBe(true);
  return res;
}

/** Average colour of a rectangle given as fractions of the image. */
function avg(img: Image, x0: number, y0: number, x1: number, y1: number): [number, number, number] {
  let r = 0;
  let g = 0;
  let b = 0;
  let n = 0;
  for (let y = Math.floor(img.height * y0); y < Math.floor(img.height * y1); y += 3) {
    for (let x = Math.floor(img.width * x0); x < Math.floor(img.width * x1); x += 3) {
      const p = img.pixel(x, y);
      r += p[0];
      g += p[1];
      b += p[2];
      n += 1;
    }
  }
  return [Math.round(r / n), Math.round(g / n), Math.round(b / n)];
}
const shot = async (t: Locator | Page): Promise<Image> => decodePng(await t.screenshot());
/** The top band of a view (the sky above the level). */
const top = async (t: Locator | Page): Promise<[number, number, number]> => avg(await shot(t), 0.3, 0.12, 0.7, 0.2);
const magenta = (c: [number, number, number]): boolean => c[0] > 200 && c[2] > 200 && c[1] < 60;
const pink = (c: [number, number, number]): boolean => c[0] > 220 && c[2] > 220 && c[1] > 105 && c[1] < 150;

const storedFlow = async (): Promise<{ levels: { id: string; environment?: unknown }[] }> =>
  (await be.command({ op: 'queryGameConfig', projectId: be.projectId, args: {} }))['flow'] as { levels: { id: string; environment?: unknown }[] };

test('a level look set in the Game flow window shows in the Scene view and in the export once level 1 completes', async ({ page }) => {
  test.setTimeout(300_000);
  // Two short levels far from the main scene's own geometry: start, floor, goal.
  const spawns: string[] = [];
  for (const [i, x] of [200, 300].entries()) {
    const sceneId = `scene-look-${i + 1}`;
    await cmd('createScene', { sceneId, name: `Look ${i + 1}` });
    await cmd('createEntity', { sceneId, kind: 'box', name: `Look floor ${i + 1}`, transform: { position: [x, -0.2, 0] }, box: { size: [20, 0.4, 2], material: { color: '#5d7a4a' } }, components: { collider: { shape: { type: 'box', hx: 10, hy: 0.2 } } } });
    spawns.push(String((await cmd('createEntity', { sceneId, kind: 'group', name: `Look start ${i + 1}`, transform: { position: [x - 6, 0.91, 0] }, components: { playerSpawn: {} } })).createdId));
    await cmd('createEntity', { sceneId, kind: 'group', name: `Look goal ${i + 1}`, transform: { position: [x - 2, 1, 0] }, components: { gameZone: { role: 'goal', size: [1, 2] } } });
  }
  await cmd('setFlow', {
    flow: {
      levels: [
        { id: 'look-1', name: 'Plain', scenes: ['scene-main', 'scene-look-1'], spawnId: spawns[0] },
        { id: 'look-2', name: 'Pink', scenes: ['scene-main', 'scene-look-2'], spawnId: spawns[1] },
      ],
    },
  });

  // The Game flow window: "Level look…" on level 2 opens the Environment window for its look.
  await page.goto(be.editorUrl);
  await expect(page.locator('.tl-statusbar')).toContainText('connected');
  const viewport = page.locator('canvas.tl-viewport');
  const light = page.getByRole('button', { name: /^light: / });
  if ((await light.textContent())?.includes('editor')) await light.click();
  await expect(light).toHaveText('light: game');
  const projectTop = await top(viewport);
  expect(magenta(projectTop), String(projectTop)).toBe(false);
  await expect(page.getByRole('button', { name: /^level look/ })).toHaveCount(0); // no level has a look yet

  await page.getByRole('tab', { name: 'Game flow', exact: true }).click();
  await page.getByRole('button', { name: 'level 2 look' }).click();
  await expect(page.getByLabel('level look')).toContainText('Level look: Pink');
  await page.getByRole('checkbox', { name: 'level own sky' }).check();
  await expect.poll(async () => (await storedFlow()).levels[1]!.environment).toEqual({ sky: { mode: 'procedural' } });
  await page.getByRole('combobox', { name: 'sky mode' }).selectOption('color');
  await expect.poll(async () => (await storedFlow()).levels[1]!.environment).toEqual({ sky: { mode: 'color' } });
  const colour = page.getByLabel('sky colour', { exact: true });
  await colour.fill('#ff00ff');
  await colour.blur();
  await expect.poll(async () => (await storedFlow()).levels[1]!.environment).toEqual({ sky: { color: '#ff00ff', mode: 'color' } });
  expect((await storedFlow()).levels[0]!.environment).toBeUndefined();

  // The Scene view shows the level's look (level look on), the project's when it is off.
  const toggle = page.getByRole('button', { name: /^level look/ });
  await expect(toggle).toHaveText('level look: on');
  await expect.poll(async () => magenta(await top(viewport)), { timeout: 10_000 }).toBe(true);
  await toggle.click();
  await expect(toggle).toHaveText('level look: off');
  await expect.poll(async () => magenta(await top(viewport)), { timeout: 10_000 }).toBe(false);
  await toggle.click();
  await expect.poll(async () => magenta(await top(viewport)), { timeout: 10_000 }).toBe(true);

  // Own post-processing: no tone mapping, lift all the way up (0.5).
  await page.getByRole('checkbox', { name: 'level own post' }).check();
  await expect.poll(async () => (await storedFlow()).levels[1]!.environment).toMatchObject({ post: {} });
  await page.getByRole('combobox', { name: 'tone mapping' }).selectOption('none');
  await expect.poll(async () => (await storedFlow()).levels[1]!.environment).toMatchObject({ post: { toneMapping: 'none' } });
  await page.getByRole('slider', { name: 'grading lift' }).focus();
  await page.keyboard.press('End');
  await expect.poll(async () => (await storedFlow()).levels[1]!.environment).toEqual({ sky: { color: '#ff00ff', mode: 'color' }, post: { grading: { lift: 0.5 }, toneMapping: 'none' } });
  await expect.poll(async () => pink(await top(viewport)), { timeout: 10_000 }).toBe(true);

  // Back to another window: the Scene view follows the active scene's level (Main is in level 1: the project look).
  await page.getByRole('tab', { name: 'Game flow', exact: true }).click();
  await expect(page.getByRole('button', { name: 'level 2 look' })).toContainText('(own)');
  await expect.poll(async () => magenta(await top(viewport)) || pink(await top(viewport)), { timeout: 10_000 }).toBe(false);
  // Opening level 2's own scene makes it active: its level's look shows.
  await page.getByLabel('open scene').selectOption({ label: 'Look 2' });
  const look2 = page.locator('.tl-scene-header').filter({ has: page.locator('.tl-scene-header__name', { hasText: /^Look 2$/ }) });
  await expect(look2).toHaveCount(1);
  if (!(await look2.getAttribute('class'))?.includes('is-active')) await look2.locator('.tl-scene-header__name').click();
  await expect(look2).toHaveClass(/is-active/);
  await expect(page.getByRole('button', { name: /^level look/ })).toHaveText('level look: on');
  await expect.poll(async () => pink(await top(viewport)), { timeout: 10_000 }).toBe(true);

  // The export, served statically with the backend stopped.
  const res = await be.admin(`projects/${be.projectId}/export`);
  expect(res.status, JSON.stringify(res.json)).toBe(200);
  await page.goto('about:blank');
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
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  try {
    await page.goto(url);
    const flow = page.locator('.tl-flow');
    await expect(flow).toHaveAttribute('data-screen', 'title', { timeout: 20_000 });
    await page.mouse.click(20, 1000);
    await page.keyboard.press('Enter'); // New game
    await expect(flow).toHaveAttribute('data-screen', 'playing');
    await page.waitForTimeout(1000);
    // Level 1: the project environment.
    const first = await top(page);
    expect(magenta(first) || pink(first), String(first)).toBe(false);

    // Walk right into level 1's goal.
    await page.keyboard.down('d');
    try {
      await expect(flow).toHaveAttribute('data-screen', 'levelComplete', { timeout: 15_000 });
    } finally {
      await page.keyboard.up('d');
    }
    await page.keyboard.press('Enter'); // Next level
    await expect(flow).toHaveAttribute('data-screen', 'playing');
    // Level 2: its own sky with its own grading.
    let second: [number, number, number] = [0, 0, 0];
    await expect.poll(async () => pink((second = await top(page))), { timeout: 15_000, message: 'level 2 sky' }).toBe(true);
    expect(errors).toEqual([]);
    await expect(page.getByText(/export error/i)).toHaveCount(0);
  } finally {
    await new Promise<void>((ok) => server.close(() => ok()));
  }
});
