/**
 * Projects that live in a game's own folder (outside the data root): created
 * and opened from the picker, edited, reloaded, carried over a backend
 * restart, backed up and restored into another folder, exported with
 * tools/project.mjs, unregistered (files kept), shown as unavailable when the
 * folder goes away, and found by the MCP adapter from its working folder
 * without THIRDLIGHT_PROJECT_ID.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { expect, test, type Page } from '@playwright/test';

import { startBackend, type E2EBackend } from './backend';
import { createBox } from './ui';

const REPO = resolve(import.meta.dirname, '..', '..');
const PROJECT_TOOL = join(REPO, 'tools', 'project.mjs');
const BACKUP_TOOL = join(REPO, 'tools', 'backup.mjs');

let be: E2EBackend;
let games: string;
test.beforeEach(async () => {
  be = await startBackend('home-0001');
  // The game folders are siblings of the data root, never inside it.
  games = mkdtempSync(join(tmpdir(), 'tl-e2e-games-'));
});
test.afterEach(async () => {
  await be.stop();
  rmSync(games, { recursive: true, force: true });
});

const status = (page: Page) => page.locator('.tl-statusbar');
const rows = (page: Page) => page.locator('.tl-hierarchy__list li');
const pickerRow = (page: Page, id: string) =>
  page.locator('.tl-projects__row').filter({ has: page.locator('.tl-projects__id', { hasText: new RegExp(`^${id}$`) }) });
const dataRoot = () => resolve(be.projectDir, '..', '..');

function tool(script: string, args: string[], cwd = REPO) {
  return spawnSync(process.execPath, [script, ...args], { encoding: 'utf8', cwd });
}

test('a project in a game folder: create, edit, reload, restart, backup/restore, export, unregister, unavailable', async ({ page }) => {
  page.on('dialog', (d) => void d.accept());
  const meadow = join(games, 'meadow');

  // Create in a (not yet existing) folder from the picker.
  await page.goto(`${be.origin}/#token=${be.token}`);
  await expect(page.getByRole('heading', { name: 'Projects' })).toBeVisible();
  await page.getByLabel('Project id').fill('meadow');
  await page.getByLabel('Name', { exact: true }).fill('Meadow');
  await page.getByLabel('Folder on the server (optional)', { exact: true }).fill(meadow);
  await page.getByRole('button', { name: 'Create and open' }).click();
  await expect(status(page)).toContainText('connected');
  expect(new URL(page.url()).searchParams.get('project')).toBe('meadow');
  const marker = JSON.parse(readFileSync(join(meadow, 'thirdlight.json'), 'utf8')) as Record<string, unknown>;
  expect(marker).toMatchObject({ thirdlightProject: 1, projectId: 'meadow', name: 'Meadow', projectDir: 'thirdlight' });
  expect((marker.engine as { lockfileDigest: string }).lockfileDigest).toMatch(/^[0-9a-f]{64}$/);
  expect(readFileSync(join(meadow, 'thirdlight', '.gitignore'), 'utf8')).toContain('.thirdlight/');
  expect(existsSync(join(dataRoot(), 'projects', 'meadow'))).toBe(false);

  // Edit; the scene lands in the game folder and survives a reload and a restart.
  const before = await rows(page).count();
  await createBox(page);
  await expect(rows(page)).toHaveCount(before + 1);
  await expect.poll(() => readFileSync(join(meadow, 'thirdlight', 'scenes', 'main.json'), 'utf8')).toContain('box-');
  await page.reload();
  await expect(status(page)).toContainText('connected');
  await expect(rows(page)).toHaveCount(before + 1);
  await be.restart();
  await page.reload();
  await expect(status(page)).toContainText('connected');
  await expect(rows(page)).toHaveCount(before + 1);

  // Export through tools/project.mjs, addressed by folder.
  const tokenFile = join(games, 'owner-token');
  writeFileSync(tokenFile, be.token);
  const cli = ['--origin', be.origin, '--token-file', tokenFile];
  const listed = tool(PROJECT_TOOL, ['list', ...cli]);
  expect(listed.status, listed.stderr).toBe(0);
  expect(listed.stdout).toMatch(new RegExp(`meadow\\s+ok\\s+${meadow}`));
  const out = join(games, 'meadow-export');
  const exported = tool(PROJECT_TOOL, ['export', meadow, '--out', out, ...cli]);
  expect(exported.status, exported.stderr).toBe(0);
  expect(existsSync(join(out, 'index.html'))).toBe(true);

  // Back up with the backend stopped; restore into another folder under a new id.
  await page.goto('about:blank');
  await be.halt();
  const backups = join(games, 'backups');
  const created = tool(BACKUP_TOOL, ['create', 'meadow', '--data-root', dataRoot(), '--out', backups]);
  expect(created.status, created.stderr).toBe(0);
  const backupDir = /backup: (\S+) /.exec(created.stdout)![1]!;
  const copyFolder = join(games, 'meadow-copy');
  const restored = tool(BACKUP_TOOL, ['restore', backupDir, '--folder', copyFolder, '--as', 'meadow-copy']);
  expect(restored.status, restored.stderr).toBe(0);
  expect(restored.stdout).toContain(`project.mjs register ${copyFolder}`);
  await be.restart();

  // Open the restored folder from the picker: it is the same game.
  await page.goto(`${be.origin}/#token=${be.token}`);
  await page.getByLabel('Folder on the server', { exact: true }).fill(copyFolder);
  await page.getByRole('button', { name: 'Open folder' }).click();
  await expect(status(page)).toContainText('connected');
  expect(new URL(page.url()).searchParams.get('project')).toBe('meadow-copy');
  await expect(rows(page)).toHaveCount(before + 1);

  // Unregister from the picker: gone from the list, files untouched.
  await page.getByTitle('All projects').click();
  await expect(pickerRow(page, 'meadow-copy')).toHaveCount(1);
  await expect(pickerRow(page, 'meadow-copy')).toContainText(copyFolder);
  await pickerRow(page, 'meadow-copy').getByRole('button', { name: 'remove' }).click();
  await expect(pickerRow(page, 'meadow-copy')).toHaveCount(0);
  expect(existsSync(join(copyFolder, 'thirdlight.json'))).toBe(true);
  expect(existsSync(join(copyFolder, 'thirdlight', 'scenes', 'main.json'))).toBe(true);
  // An in-tree project has no remove button.
  await expect(pickerRow(page, 'home-0001').getByRole('button', { name: 'remove' })).toHaveCount(0);

  // Opening it again works; a relative path is refused in the page.
  await page.getByLabel('Folder on the server', { exact: true }).fill('games/meadow-copy');
  await page.getByRole('button', { name: 'Open folder' }).click();
  await expect(page.getByText('type the absolute path')).toBeVisible();
  await page.getByLabel('Folder on the server', { exact: true }).fill(copyFolder);
  await page.getByRole('button', { name: 'Open folder' }).click();
  await expect(status(page)).toContainText('connected');
  await expect(rows(page)).toHaveCount(before + 1);

  // A folder that disappears shows as unavailable (restart: nothing holds it open).
  await page.goto('about:blank');
  await be.restart();
  renameSync(meadow, join(games, 'meadow-moved'));
  await page.goto(`${be.origin}/#token=${be.token}`);
  await expect(pickerRow(page, 'meadow')).toContainText('folder unavailable');
  await expect(pickerRow(page, 'meadow-copy')).not.toContainText('unavailable');
  // It comes back when the folder does.
  renameSync(join(games, 'meadow-moved'), meadow);
  await page.reload();
  await expect(pickerRow(page, 'meadow')).not.toContainText('unavailable');
  await expect(pickerRow(page, 'meadow')).toContainText(meadow);
});

test('the MCP adapter finds the project from its working folder (no THIRDLIGHT_PROJECT_ID)', async () => {
  const reach = join(games, 'reach');
  const made = await be.admin('projects', { projectId: 'reach', name: 'Reach', folder: reach, template: 'beacon-reach' });
  expect(made.status, JSON.stringify(made.json)).toBe(201);
  const deep = join(reach, 'src', 'levels');
  mkdirSync(deep, { recursive: true });
  const stray = join(games, 'stray');
  mkdirSync(stray);

  const env: Record<string, string> = { ...(process.env as Record<string, string>), THIRDLIGHT_AUTHORING_ORIGIN: be.origin, THIRDLIGHT_MCP_TOKEN: be.token };
  delete env.THIRDLIGHT_PROJECT_ID;
  const connect = async (cwd: string): Promise<Client> => {
    const c = new Client({ name: 'thirdlight-e2e', version: '0.0.0' });
    await c.connect(new StdioClientTransport({ command: process.execPath, args: [join(REPO, 'dist', 'mcp-adapter', 'mcp.mjs')], env, cwd, stderr: 'ignore' }));
    return c;
  };
  const call = async (c: Client, name: string, args: Record<string, unknown>) => {
    const res = (await c.callTool({ name, arguments: args })) as { isError?: boolean; content: Array<{ text: string }> };
    return { isError: res.isError === true, body: JSON.parse(res.content[0]!.text) as Record<string, unknown> };
  };

  // Inside the game (a subfolder): the project is found; read and edit work.
  const mcp = await connect(deep);
  try {
    const listed = await call(mcp, 'tl_inspect', { target: 'entities' });
    expect(listed.isError, JSON.stringify(listed.body)).toBe(false);
    expect((listed.body.entities as Array<{ name?: string }>).map((e) => e.name)).toContain('Player');
    const project = await call(mcp, 'tl_inspect', { target: 'project' });
    const edit = await call(mcp, 'tl_command', { op: 'createEntity', expectedRevision: project.body.revision, args: { kind: 'box', name: 'From MCP' } });
    expect(edit.isError, JSON.stringify(edit.body)).toBe(false);
    await expect.poll(() => readFileSync(join(reach, 'thirdlight', 'scenes', 'main.json'), 'utf8')).toContain('From MCP');
  } finally {
    await mcp.close();
  }

  // Outside any project folder: a clear error.
  const lost = await connect(stray);
  try {
    const r = await call(lost, 'tl_inspect', { target: 'project' });
    expect(r.isError).toBe(true);
    expect(JSON.stringify(r.body)).toContain('no thirdlight.json');
  } finally {
    await lost.close();
  }

  // A marker the backend does not know: says how to register it.
  expect((await be.admin('projects/reach/unregister')).status).toBe(200);
  const unknown = await connect(deep);
  try {
    const r = await call(unknown, 'tl_inspect', { target: 'project' });
    expect(r.isError).toBe(true);
    expect(JSON.stringify(r.body)).toContain('is not registered');
    expect(JSON.stringify(r.body)).toContain(`project.mjs register ${reach}`);
  } finally {
    await unknown.close();
  }

  // A marker pinned to another engine version is flagged, never refused.
  const markerFile = join(reach, 'thirdlight.json');
  const m = JSON.parse(readFileSync(markerFile, 'utf8')) as { engine: { version: string } };
  m.engine.version = '0.0.0-other';
  writeFileSync(markerFile, JSON.stringify(m));
  expect((await be.admin('projects/register', { folder: reach })).status).toBe(201);
  const res = await fetch(`${be.origin}/api/v1/projects`, { headers: { authorization: `Bearer ${be.token}` } });
  const row = ((await res.json()) as { projects: Array<{ projectId: string; loadable: boolean; enginePin?: { differences: string[] } }> }).projects.find((p) => p.projectId === 'reach')!;
  expect(row.loadable).toBe(true);
  expect(row.enginePin?.differences.join()).toContain('0.0.0-other');
  const check = tool(PROJECT_TOOL, ['check', reach]);
  expect(check.status).toBe(1);
  expect(check.stderr).toContain('MISMATCH');
});
