/**
 * The one-command start: `node tools/start.mjs` on an empty data root
 * creates the owner token, starts the backend, and prints an editor URL that
 * opens the project picker in a real browser. Stopping it is clean, and the
 * next start reuses the same token.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { expect, test } from '@playwright/test';

const REPO = resolve(import.meta.dirname, '..', '..');

function freePort(): Promise<number> {
  return new Promise((ok, fail) => {
    const s = createServer();
    s.once('error', fail);
    s.listen(0, '127.0.0.1', () => {
      const port = (s.address() as { port: number }).port;
      s.close(() => ok(port));
    });
  });
}

function portFree(port: number): Promise<boolean> {
  return new Promise((ok) => {
    const s = createServer();
    s.once('error', () => ok(false));
    s.listen(port, '127.0.0.1', () => s.close(() => ok(true)));
  });
}

interface Started {
  proc: ChildProcess;
  editorUrl: string;
  output: () => string;
  exited: Promise<number | null>;
}

async function start(dataRoot: string, port: number, previewPort: number): Promise<Started> {
  const proc = spawn(process.execPath, [join(REPO, 'tools', 'start.mjs'), '--data-root', dataRoot, '--port', String(port), '--preview-port', String(previewPort)], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env },
  });
  let log = '';
  const exited = new Promise<number | null>((ok) => proc.once('exit', (code) => ok(code)));
  const editorUrl = await new Promise<string>((ok, fail) => {
    const timer = setTimeout(() => fail(new Error(`start.mjs did not announce the editor URL:\n${log}`)), 30_000);
    const onData = (d: Buffer): void => {
      log += d.toString();
      const m = /editor:\s+(\S+)/.exec(log);
      if (m) {
        clearTimeout(timer);
        ok(m[1]!);
      }
    };
    proc.stderr!.on('data', onData);
    proc.stdout!.on('data', onData);
    void exited.then((code) => {
      clearTimeout(timer);
      fail(new Error(`start.mjs exited (${code}):\n${log}`));
    });
  });
  return { proc, editorUrl, output: () => log, exited };
}

test('one command starts the backend; the printed URL opens the picker; stop is clean; the token persists', async ({ page }) => {
  const dataRoot = mkdtempSync(join(tmpdir(), 'tl-start-'));
  const [port, previewPort] = [await freePort(), await freePort()];
  try {
    const first = await start(dataRoot, port, previewPort);
    expect(first.output()).toContain('created the owner token');
    const tokenFile = join(dataRoot, 'owner-token');
    expect(existsSync(tokenFile)).toBe(true);
    expect(statSync(tokenFile).mode & 0o777).toBe(0o600);
    const token = readFileSync(tokenFile, 'utf8').trim();
    expect(first.editorUrl).toBe(`http://127.0.0.1:${port}/#token=${token}`);
    expect(existsSync(join(dataRoot, 'projects'))).toBe(true);

    // The printed URL opens the project picker (no projects yet).
    await page.goto(first.editorUrl);
    await expect(page.getByRole('heading', { name: 'Projects' })).toBeVisible();
    await expect(page.getByText('No projects yet')).toBeVisible();
    // The token is usable against the API from the browser's origin.
    const res = await fetch(`http://127.0.0.1:${port}/api/v1/projects`, { headers: { authorization: `Bearer ${token}` } });
    expect(res.status).toBe(200);
    // Create a project from the template through the picker and open it.
    await page.getByLabel('Project id').fill('first-game');
    await page.getByLabel('Template').selectOption('beacon-reach');
    await page.getByRole('button', { name: 'Create and open' }).click();
    await expect(page.locator('.tl-statusbar')).toContainText('connected');
    expect(existsSync(join(dataRoot, 'projects', 'first-game', 'project.json'))).toBe(true);

    // Ctrl+C-style stop is clean: the start script exits 0 and the backend is
    // gone with it (its ports are free again; the project is released).
    first.proc.kill('SIGINT');
    expect(await first.exited).toBe(0);
    await expect.poll(() => portFree(port), { timeout: 10_000 }).toBe(true);
    await expect.poll(() => portFree(previewPort), { timeout: 10_000 }).toBe(true);
    expect(JSON.parse(readFileSync(join(dataRoot, 'projects', 'first-game', '.thirdlight', 'ownership.json'), 'utf8')).state).toBe('released');

    // A second start reuses the token and does not re-create it.
    const second = await start(dataRoot, port, previewPort);
    expect(second.output()).not.toContain('created the owner token');
    expect(second.editorUrl).toBe(first.editorUrl);
    const list = await fetch(`http://127.0.0.1:${port}/api/v1/projects`, { headers: { authorization: `Bearer ${token}` } });
    expect(((await list.json()) as { projects: Array<{ projectId: string }> }).projects.map((p) => p.projectId)).toEqual(['first-game']);
    second.proc.kill('SIGTERM');
    expect(await second.exited).toBe(0);
    await expect.poll(() => portFree(port), { timeout: 10_000 }).toBe(true);
  } finally {
    rmSync(dataRoot, { recursive: true, force: true });
  }
});
