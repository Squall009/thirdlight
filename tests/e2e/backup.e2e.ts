/**
 * Backup and restore against a real project: a Beacon Reach project is
 * backed up with the backend stopped, restored under a new id, and the copy
 * opens and plays in the browser.
 */
import { spawnSync } from 'node:child_process';
import { join, resolve } from 'node:path';

import { expect, test } from '@playwright/test';

import { startBackend, type E2EBackend } from './backend';

const REPO = resolve(import.meta.dirname, '..', '..');
const TOOL = join(REPO, 'tools', 'backup.mjs');

let be: E2EBackend;
test.beforeEach(async () => {
  be = await startBackend('reach-src', 'beacon-reach');
});
test.afterEach(async () => {
  await be.stop();
});

test('a backup of a live project is refused; after a stop it restores as a new project that opens and plays', async ({ page }) => {
  const dataRoot = resolve(be.projectDir, '..', '..');
  const out = join(dataRoot, 'backups');
  // Open the project so the backend owns it; the tool must refuse.
  await page.goto(be.editorUrl);
  await expect(page.locator('.tl-statusbar')).toContainText('connected');
  const live = spawnSync(process.execPath, [TOOL, 'create', 'reach-src', '--data-root', dataRoot, '--out', out], { encoding: 'utf8' });
  expect(live.status).toBe(1);
  expect(live.stderr).toContain('in use');

  // Stop the backend (releases the project), back up, restore as a copy.
  await page.close();
  await be.halt();
  const created = spawnSync(process.execPath, [TOOL, 'create', 'reach-src', '--data-root', dataRoot, '--out', out], { encoding: 'utf8' });
  expect(created.status, created.stderr).toBe(0);
  const dir = /backup: (\S+) /.exec(created.stdout)![1]!;
  expect(spawnSync(process.execPath, [TOOL, 'verify', dir], { encoding: 'utf8' }).status).toBe(0);
  const restored = spawnSync(process.execPath, [TOOL, 'restore', dir, '--data-root', dataRoot, '--as', 'reach-copy'], { encoding: 'utf8' });
  expect(restored.status, restored.stderr).toBe(0);

  // The copy is a real project: listed, opens, has the game, plays.
  await be.restart();
  const list = await fetch(`${be.origin}/api/v1/projects`, { headers: { authorization: `Bearer ${be.token}` } });
  const projects = ((await list.json()) as { projects: Array<{ projectId: string; name: string; loadable: boolean }> }).projects;
  expect(projects.map((p) => [p.projectId, p.loadable])).toEqual([
    ['reach-copy', true],
    ['reach-src', true],
  ]);
  const copy = await page.context().newPage();
  await copy.goto(`${be.origin}/?project=reach-copy#token=${be.token}`);
  await expect(copy.locator('.tl-statusbar')).toContainText('connected');
  await expect(copy.locator('.tl-hierarchy__list li').filter({ hasText: 'Player' })).toHaveCount(1);
  // Play: the backend builds the copy's play content and the game reaches its start menu.
  const started = copy.waitForResponse((r) => r.request().method() === 'POST' && r.url().endsWith('/play'));
  await copy.getByTitle('Start an isolated play preview').click();
  const psid = String(((await (await started).json()) as { playSessionId: string }).playSessionId);
  await expect
    .poll(
      async () => {
        const r = await fetch(`${be.origin}/api/v1/projects/reach-copy/play/${psid}/observe`, {
          method: 'POST',
          headers: { authorization: `Bearer ${be.token}`, 'content-type': 'application/json' },
          body: '{}',
        });
        return ((await r.json()) as { state?: string }).state ?? null;
      },
      { timeout: 15_000 },
    )
    .toBe('awaitingStart');
});
