/**
 * An independent game project with a pinned engine: created from the
 * template into its own directory, checked against the engine, refused when
 * the pin does not match, exported through the pinned engine, and the export
 * runs standalone in the browser.
 */
import { spawnSync } from 'node:child_process';
import { createReadStream, existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { extname, join, normalize, resolve } from 'node:path';

import { expect, test } from '@playwright/test';

import { colorCount, decodePng } from './png';

const REPO = resolve(import.meta.dirname, '..', '..');
const TOOL = join(REPO, 'tools', 'game.mjs');
const MIME: Record<string, string> = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json', '.wasm': 'application/wasm' };

function serveDir(dir: string): Promise<{ url: string; close: () => Promise<void> }> {
  const server: Server = createServer((req, res) => {
    const rel = normalize(decodeURIComponent((req.url ?? '/').split('?')[0]!)).replace(/^\/+/, '') || 'index.html';
    const file = join(dir, rel);
    if (!file.startsWith(dir) || !existsSync(file) || !statSync(file).isFile()) {
      res.statusCode = 404;
      res.end();
      return;
    }
    res.setHeader('content-type', MIME[extname(file)] ?? 'application/octet-stream');
    createReadStream(file).pipe(res);
  });
  return new Promise((ok) => {
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as { port: number }).port;
      ok({ url: `http://127.0.0.1:${port}/`, close: () => new Promise((done) => server.close(() => done())) });
    });
  });
}

const run = (...args: string[]) => spawnSync(process.execPath, [TOOL, ...args], { encoding: 'utf8', timeout: 120_000 });

test('create from a template, check the pin, refuse a mismatch, export and run standalone', async ({ page }) => {
  const gameDir = mkdtempSync(join(tmpdir(), 'tl-game-'));
  try {
    const created = run('create', gameDir, '--id', 'my-reach', '--name', 'My Reach', '--template', 'beacon-reach');
    expect(created.status, created.stderr).toBe(0);
    const game = JSON.parse(readFileSync(join(gameDir, 'game.json'), 'utf8')) as { projectId: string; engine: { version: string; commit: string; lockfileDigest: string } };
    expect(game.projectId).toBe('my-reach');
    expect(game.engine.version).toBe('0.1.0');
    expect(game.engine.commit).toMatch(/^[0-9a-f]{40}$/);
    expect(game.engine.lockfileDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(existsSync(join(gameDir, 'projects', 'my-reach', 'scenes', 'main.json'))).toBe(true);
    expect(readFileSync(join(gameDir, '.gitignore'), 'utf8')).toContain('projects/*/.thirdlight/');
    expect(run('create', gameDir, '--id', 'other').status).toBe(1); // already a game

    expect(run('check', gameDir).status).toBe(0);

    // A different pinned lockfile: check and export refuse.
    const pinned = readFileSync(join(gameDir, 'game.json'), 'utf8');
    writeFileSync(join(gameDir, 'game.json'), pinned.replace(game.engine.lockfileDigest, 'f'.repeat(64)));
    const bad = run('check', gameDir);
    expect(bad.status).toBe(1);
    expect(bad.stderr).toContain('dependency lockfile');
    const refused = run('export', gameDir);
    expect(refused.status).toBe(1);
    expect(refused.stderr).toContain('does not match');
    // --repin records this engine deliberately.
    expect(run('check', gameDir, '--repin').status).toBe(0);
    expect(run('check', gameDir).status).toBe(0);

    // Export through the pinned engine; the output runs from a plain static server.
    const out = join(gameDir, 'build');
    const exported = run('export', gameDir, '--out', out);
    expect(exported.status, exported.stderr).toBe(0);
    expect(existsSync(join(out, 'index.html'))).toBe(true);
    const site = await serveDir(out);
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    try {
      await page.goto(site.url);
      await expect.poll(async () => colorCount(decodePng(await page.screenshot())), { timeout: 15_000 }).toBeGreaterThan(1);
      await expect(page.getByText('Press Enter or Space')).toBeVisible({ timeout: 15_000 });
      expect(errors).toEqual([]);
    } finally {
      await site.close();
    }
  } finally {
    rmSync(gameDir, { recursive: true, force: true });
  }
});
