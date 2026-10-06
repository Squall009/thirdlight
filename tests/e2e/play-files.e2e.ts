/**
 * Play reads the project's files from disk, checked once per change, against
 * the real backend and Chromium: a red ball's model file is played, then
 * replaced on disk by a green one while the editor stays open; the next Play
 * takes the changed file in before it builds (a new digest, a new URL) and
 * the game shows the green ball, its bytes fetched from their own URL. (That
 * an old URL is never answered with new bytes is checked over HTTP in the
 * backend's play-files test.)
 */
import { createHash } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { expect, test } from './pw';

import { PERF_ROOT, startPerfBackend, type PerfBackend } from '../../tools/perf/backend';
import { sphereGlb } from '../../tools/perf/assets';
import { decodePng, type Image } from './png';

const ID = 'play-files';
const RED = sphereGlb(1, 16, 8, [230, 20, 20]);
const GREEN = sphereGlb(1, 16, 8, [20, 210, 20]);
const sha = (b: Uint8Array): string => createHash('sha256').update(b).digest('hex');

let be: PerfBackend;
let root: string;
test.beforeEach(async () => {
  root = join(PERF_ROOT, 'e2e', `play-files-${process.pid}-${Date.now()}`);
  be = await startPerfBackend(join(root, 'data'), join(root, 'exports'));
});
test.afterEach(async () => {
  await be.stop();
  rmSync(root, { recursive: true, force: true });
});

/** Pixels clearly red and clearly green in a screenshot of the game. */
function colours(img: Image): { red: number; green: number } {
  let red = 0;
  let green = 0;
  for (let y = 0; y < img.height; y += 1) {
    for (let x = 0; x < img.width; x += 1) {
      const [r, g, b] = img.pixel(x, y);
      if (r > 90 && r > g * 2 && r > b * 2) red += 1;
      if (g > 90 && g > r * 2 && g > b * 2) green += 1;
    }
  }
  return { red, green };
}

test('a model file changed on disk between two Plays: the second Play shows the new file, at a new URL', async ({ page }) => {
  test.setTimeout(240_000);
  const created = await be.post('/api/v1/admin/projects', { projectId: ID, name: 'Play files' });
  expect([200, 201]).toContain(created.status);
  const p = be.project(ID);
  const file = join(root, 'data', 'projects', ID, 'assets', 'look', 'ball.glb');
  mkdirSync(join(file, '..'), { recursive: true });
  writeFileSync(file, RED);
  // The model keeps its image inside (extract textures off): its file is what Play serves.
  await p.command('importAssets', { folder: 'assets/look', extractTextures: false });
  await p.command('setTransform', { entityId: 'cam-main', transform: { position: [0, 0.5, 3] } });
  await p.command('createEntity', { sceneId: 'scene-main', kind: 'model', name: 'Ball', transform: { position: [0, 0, 0], scale: [2, 2, 2] }, model: { asset: { assetId: 'ball' } } });

  const served = new Map<string, number[]>();
  page.on('response', (r) => {
    const m = /\/content\/sha256\/([0-9a-f]{64})$/.exec(r.url());
    if (m !== null) served.set(m[1]!, [...(served.get(m[1]!) ?? []), r.status()]);
  });
  await page.goto(`${be.origin}/?project=${ID}#token=${be.token}`);
  await expect(page.locator('.tl-statusbar')).toContainText('connected', { timeout: 60_000 });

  const play = async (): Promise<{ psid: string; look: () => Promise<{ red: number; green: number }> }> => {
    const started = page.waitForResponse((r) => r.request().method() === 'POST' && r.url().endsWith('/play'));
    await page.getByTitle('Start an isolated play preview').click();
    const response = await started;
    expect(response.status(), await response.text()).toBe(200);
    const psid = String(((await response.json()) as { playSessionId: string }).playSessionId);
    await expect.poll(async () => (await be.post(`/api/v1/projects/${ID}/play/${psid}/observe`, {})).json['state'], { timeout: 90_000 }).toBe('running');
    const look = async (): Promise<{ red: number; green: number }> => {
      const r = await be.post(`/api/v1/projects/${ID}/play/${psid}/screenshot`, { maxWidth: 320 });
      expect(r.status, JSON.stringify(r.json).slice(0, 200)).toBe(200);
      return colours(decodePng(Buffer.from(String(r.json['dataUrl']).replace(/^data:image\/png;base64,/, ''), 'base64')));
    };
    return { psid, look };
  };
  const stop = async (psid: string): Promise<void> => {
    await page.getByTitle('Stop the play preview').click();
    await expect.poll(async () => (await be.post(`/api/v1/projects/${ID}/play/${psid}/observe`, {})).status, { timeout: 30_000 }).toBe(404);
  };

  const first = await play();
  await expect.poll(async () => (await first.look()).red, { timeout: 30_000 }).toBeGreaterThan(300);
  expect((await first.look()).green).toBe(0);
  expect(served.get(sha(RED))).toContain(200);
  await stop(first.psid);

  // The file changes on disk; nobody runs "check files".
  writeFileSync(file, GREEN);
  const second = await play();
  await expect.poll(async () => (await second.look()).green, { timeout: 30_000 }).toBeGreaterThan(300);
  expect((await second.look()).red).toBe(0);
  // The new bytes came from their own URL; the red bytes' URL never served anything else.
  expect(served.get(sha(GREEN))).toContain(200);
  const asset = (await p.query('queryAssets', { assetId: 'ball', includeVersions: true })) as { assets?: { currentVersion: number; versions: { version: number; sourceDigest: string }[] }[] };
  expect(asset.assets?.[0]?.versions.find((v) => v.version === asset.assets![0]!.currentVersion)?.sourceDigest).toBe(sha(GREEN));
  await stop(second.psid);
});
