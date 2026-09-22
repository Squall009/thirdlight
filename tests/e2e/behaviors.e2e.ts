/**
 * Scripts (behaviors) run in the game: a published behavior attached to the
 * player drives it in the editor's Play preview, and ships with the export.
 */
import { createHash } from 'node:crypto';
import { createReadStream, existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, join, normalize, resolve } from 'node:path';

import { expect, test } from '@playwright/test';

import { startBackend, type E2EBackend } from './backend';

const REPO = resolve(import.meta.dirname, '..', '..');

let be: E2EBackend;
test.beforeEach(async () => {
  be = await startBackend('behaviors-e2e', 'beacon-reach');
});
test.afterEach(async () => {
  await be.stop();
});

async function api(path: string, body: unknown): Promise<{ status: number; json: Record<string, unknown> }> {
  const r = await fetch(`${be.origin}/api/v1/projects/${be.projectId}/${path}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${be.token}`, 'content-type': 'application/json', origin: be.origin },
    body: JSON.stringify(body),
  });
  return { status: r.status, json: (await r.json()) as Record<string, unknown> };
}

let revision = 0;
async function command(op: string, args: Record<string, unknown>): Promise<void> {
  const res = await be.command({
    op,
    projectId: be.projectId,
    expectedRevision: revision,
    requestId: `req-${createHash('sha256').update(`${op}${Math.random()}`).digest('hex').slice(0, 32)}`,
    origin: { kind: 'mcp', clientId: 'e2e' },
    args,
  });
  expect(res.ok, JSON.stringify(res)).toBe(true);
  revision = Number(res.revision);
}

/** Stage the fixture behavior source, declare it, trust it, compile + publish it. */
async function publishSampleBehavior(behaviorId: string): Promise<void> {
  const bytes = readFileSync(join(REPO, 'fixtures', 'm2', 'behaviors', 'valid', 'sample.json'));
  const stage = await api('content/stages', {});
  const stageId = String(stage.json.stageId);
  const put = await fetch(`${be.origin}/api/v1/projects/${be.projectId}/content/stages/${stageId}/bytes`, {
    method: 'PUT',
    headers: { authorization: `Bearer ${be.token}`, origin: be.origin, 'content-type': 'application/octet-stream', 'x-thirdlight-offset': '0', 'x-thirdlight-total': String(bytes.length) },
    body: bytes,
  });
  expect(put.status).toBe(200);
  const declaration = { properties: [{ key: 'speed', label: 'Speed', type: 'number', default: 3.5, min: -1000, max: 1000, step: 0.25 }] };
  await command('publishBehavior', { behaviorId, displayName: 'Drift', mode: 'declaration-create', declaration });
  await command('acknowledgeBehaviorTrust', { sourceDigest: createHash('sha256').update(bytes).digest('hex') });
  const published = await api('content/behaviors/source', {
    stageId,
    behaviorId,
    displayName: 'Drift',
    declaration,
    expectedRevision: revision,
    requestId: `req-${'c'.repeat(32)}`,
  });
  expect(published.status, JSON.stringify(published.json)).toBe(200);
  revision = Number(published.json.revision);
}

test('a script attached to the player runs in Play; the export ships it', async ({ page }) => {
  revision = Number((await be.command({ op: 'queryProject', projectId: be.projectId, args: {} })).revision);
  const game = await be.command({ op: 'queryGameConfig', projectId: be.projectId, args: {} });
  const playerId = String((game.game as { playerId: string }).playerId);
  await publishSampleBehavior('behavior-drift');
  await command('setBehaviorProperties', { entityId: playerId, behaviorId: 'behavior-drift', values: { speed: 8 } });

  // Play in the editor; start the run with no input: the script moves the player.
  await page.goto(be.editorUrl);
  await expect(page.locator('.tl-statusbar')).toContainText('connected');
  const started = page.waitForResponse((r) => r.request().method() === 'POST' && r.url().endsWith('/play'));
  await page.getByTitle('Start an isolated play preview').click();
  const psid = String(((await (await started).json()) as { playSessionId: string }).playSessionId);
  const observe = async (): Promise<{ state?: string; player?: { x: number } }> => (await api(`play/${psid}/observe`, {})).json as never;
  await expect.poll(async () => (await observe()).state, { timeout: 15_000 }).toBe('awaitingStart');
  await expect(page.locator('.tl-notice')).toHaveCount(0);
  // No input is ever sent: the player leaves its spawn (x = 3) under the script's control.
  expect((await api(`play/${psid}/control`, { command: 'start' })).status).toBe(200);
  await expect.poll(async () => (await observe()).player!.x, { timeout: 5_000 }).toBeGreaterThan(4.5);

  // The export carries the compiled behavior module.
  const exported = await be.admin(`projects/${be.projectId}/export`);
  expect(exported.status, JSON.stringify(exported.json)).toBe(200);
  const dir = join(be.exportRoot, String(exported.json.outputDir));
  expect(existsSync(join(dir, 'behaviors'))).toBe(true);
  expect(readdirSync(join(dir, 'behaviors')).length).toBe(1);

  // …and the exported game loads it from a plain static server, backend stopped.
  await be.halt();
  const server = createServer((req, reply) => {
    const rel = normalize(decodeURIComponent((req.url ?? '/').split('?')[0]!)).replace(/^\/+/, '') || 'index.html';
    const file = join(dir, rel);
    if (!file.startsWith(dir) || !existsSync(file) || !statSync(file).isFile()) {
      reply.statusCode = 404;
      reply.end();
      return;
    }
    const types: Record<string, string> = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json' };
    reply.setHeader('content-type', types[extname(file)] ?? 'application/octet-stream');
    createReadStream(file).pipe(reply);
  });
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', () => ok()));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/`;
  const loaded: string[] = [];
  const errors: string[] = [];
  const exportPage = await page.context().newPage();
  exportPage.on('response', (r) => loaded.push(`${r.status()} ${new URL(r.url()).pathname}`));
  exportPage.on('pageerror', (e) => errors.push(e.message));
  try {
    await exportPage.goto(url);
    await expect(exportPage.locator('#hud-root')).toContainText('to start', { timeout: 15_000 });
    expect(loaded.some((l) => /^200 \/behaviors\/[0-9a-f]{64}\.js$/.test(l))).toBe(true);
    expect(errors).toEqual([]);
    await expect(exportPage.getByText(/error/i)).toHaveCount(0);
  } finally {
    await new Promise<void>((ok) => server.close(() => ok()));
  }
});
