/**
 * The file check before Play imports again every asset file changed on disk,
 * and says so: the Play start result carries the check's report (each asset
 * re-imported with its file's old and new digest) and the Problems log gets a
 * line per asset. Against the real backend, the real MCP adapter and the
 * editor in Chromium, on a project generated through the API (a model and an
 * unlit wall whose material maps a texture, both imported from the game
 * folder).
 *
 * - The texture is rewritten outside the editor; Play started over HTTP names
 *   it in `check.reimported` and the Problems query has its line.
 * - The model is rewritten; Play started with MCP `tl_play_start` names it;
 *   `tl_diagnostics` lists the line.
 * - Both are rewritten; the editor's Play button starts, its result names
 *   both, and the Problems tab shows both lines.
 * - Nothing changed: the next start's check re-imported nothing.
 */
import { createHash } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { expect, test } from './pw';

import { PERF_ROOT, startPerfBackend, type PerfBackend } from '../../tools/perf/backend';
import { sphereGlb } from '../../tools/perf/assets';
import { makePng } from './png-make';
import { openWindow } from './ui';

const REPO = resolve(import.meta.dirname, '..', '..');
let be: PerfBackend;
let root: string;
test.beforeEach(async () => {
  root = join(PERF_ROOT, 'e2e', `play-reimports-${process.pid}-${Date.now()}`);
  be = await startPerfBackend(join(root, 'data'), join(root, 'exports'));
});
test.afterEach(async () => {
  await be.stop();
  rmSync(root, { recursive: true, force: true });
});

const ID = 'reimports';

type Reimport = { assetId: string; file: string; version: number; reason: string; oldDigest: string; newDigest: string };
type Started = { playSessionId: string; check?: { reimported: Reimport[]; failed: unknown[] } };

const sha = (b: Uint8Array): string => createHash('sha256').update(b).digest('hex');
const short = (d: string): string => d.slice(0, 12);

test('Play reports the files the check before it imported again, with old and new digests, over HTTP, MCP and in Problems', async ({ page }) => {
  test.setTimeout(240_000);
  const created = await be.post('/api/v1/admin/projects', { projectId: ID, name: 'Re-imports' });
  expect([200, 201]).toContain(created.status);
  const p = be.project(ID);
  const dir = join(root, 'data', 'projects', ID);
  const put = (rel: string, bytes: Uint8Array): string => {
    mkdirSync(join(dir, rel, '..'), { recursive: true });
    writeFileSync(join(dir, rel), bytes);
    return sha(bytes);
  };
  const TEX = 'assets/art/tex-wall.png';
  const MODEL = 'assets/art/model-rock.glb';
  const tex = [put(TEX, makePng(16, 16, () => [30, 220, 40, 255]))];
  const model = [put(MODEL, sphereGlb(1, 12, 16))];
  await p.command('importAssets', { folder: 'assets/art' });
  await p.command('setMaterial', { material: { materialId: 'mat-wall', name: 'Wall', shader: 'unlit', params: {}, textures: { map: 'tex-wall' } } });
  await p.command('setTransform', { entityId: 'cam-main', transform: { position: [0, 0, 10] } });
  await p.command('createEntity', { sceneId: 'scene-main', kind: 'model', name: 'Rock', transform: { position: [2, 0, 0] }, model: { asset: { assetId: 'model-rock' } } });
  await p.command('createEntity', { sceneId: 'scene-main', kind: 'box', name: 'Wall', transform: { position: [0, 0, -2] }, box: { size: [8, 8, 1], material: { color: '#ffffff' } }, components: { materials: { '*': 'mat-wall' } } });

  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(`${e.message} ${e.stack ?? ''}`.slice(0, 400)));
  await page.goto(`${be.origin}/?project=${ID}#token=${be.token}`);
  await expect(page.locator('.tl-statusbar')).toContainText('connected', { timeout: 60_000 });
  await openWindow(page, 'Problems');
  // The editor's own check at connect has run (nothing to re-import yet).
  await expect(page.getByRole('button', { name: 'check files' })).toBeEnabled({ timeout: 30_000 });
  const problems = async (): Promise<{ code: string; message: string }[]> => (JSON.parse((await be.get(`/api/v1/projects/${ID}/problems`)).body.toString('utf8')) as { problems: { code: string; message: string }[] }).problems;
  const lineOf = (file: string, assetId: string, version: number, from: string, to: string): string => `${file} changed on disk and was imported again (${assetId}, version ${version}): ${short(from)} → ${short(to)}`;
  const stopped = async (psid: string): Promise<void> => {
    const r = await be.post(`/api/v1/projects/${ID}/play/${psid}/stop`, {});
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    await expect(page.locator('iframe.tl-app__preview-frame')).toHaveCount(0, { timeout: 30_000 });
  };

  // HTTP: the texture changed on disk.
  tex.push(put(TEX, makePng(16, 16, () => [220, 40, 30, 255])));
  const viaHttp = await be.post(`/api/v1/projects/${ID}/play`, {});
  expect(viaHttp.status, JSON.stringify(viaHttp.json).slice(0, 400)).toBe(200);
  const http = viaHttp.json as unknown as Started;
  expect(http.check?.reimported).toEqual([{ assetId: 'tex-wall', file: TEX, version: 2, reason: 'file_changed', oldDigest: tex[0], newDigest: tex[1] }]);
  expect(http.check?.failed).toEqual([]);
  expect(await problems()).toContainEqual(expect.objectContaining({ code: 'asset_reimported', message: lineOf(TEX, 'tex-wall', 2, tex[0]!, tex[1]!) }));
  await stopped(http.playSessionId);

  // MCP: the model changed on disk.
  model.push(put(MODEL, sphereGlb(2, 12, 16)));
  const mcp = new Client({ name: 'thirdlight-e2e', version: '0.0.0' });
  await mcp.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [join(REPO, 'dist', 'mcp-adapter', 'mcp.mjs')],
      env: { ...process.env, THIRDLIGHT_AUTHORING_ORIGIN: be.origin, THIRDLIGHT_PROJECT_ID: ID, THIRDLIGHT_MCP_TOKEN: be.token } as Record<string, string>,
      stderr: 'ignore',
    }),
  );
  try {
    const call = async (name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> => {
      const res = (await mcp.callTool({ name, arguments: args })) as { isError?: boolean; content: Array<{ text: string }> };
      const body = JSON.parse(res.content[0]!.text) as Record<string, unknown>;
      expect(res.isError === true, JSON.stringify(body).slice(0, 400)).toBe(false);
      return body;
    };
    const viaMcp = (await call('tl_play_start', {})) as unknown as Started;
    expect(viaMcp.check?.reimported).toEqual([{ assetId: 'model-rock', file: MODEL, version: 2, reason: 'file_changed', oldDigest: model[0], newDigest: model[1] }]);
    const diag = (await call('tl_diagnostics', {})) as { problems: { code: string; message: string }[] };
    expect(diag.problems).toContainEqual(expect.objectContaining({ code: 'asset_reimported', message: lineOf(MODEL, 'model-rock', 2, model[0]!, model[1]!) }));
    await call('tl_play_stop', { playSessionId: viaMcp.playSessionId });
    await expect(page.locator('iframe.tl-app__preview-frame')).toHaveCount(0, { timeout: 30_000 });
  } finally {
    await mcp.close();
  }

  // The editor's Play button: both changed again; its result and the Problems tab name both.
  tex.push(put(TEX, makePng(16, 16, () => [40, 30, 220, 255])));
  model.push(put(MODEL, sphereGlb(3, 12, 16)));
  const startPlay = async (): Promise<Started> => {
    const started = page.waitForResponse((r) => r.request().method() === 'POST' && r.url().endsWith('/play'));
    await page.getByTitle('Start an isolated play preview').click();
    const response = await started;
    expect(response.status(), await response.text()).toBe(200);
    return (await response.json()) as Started;
  };
  const viaButton = await startPlay();
  expect([...(viaButton.check?.reimported ?? [])].sort((a, b) => (a.assetId < b.assetId ? -1 : 1))).toEqual([
    { assetId: 'model-rock', file: MODEL, version: 3, reason: 'file_changed', oldDigest: model[1], newDigest: model[2] },
    { assetId: 'tex-wall', file: TEX, version: 3, reason: 'file_changed', oldDigest: tex[1], newDigest: tex[2] },
  ]);
  const panel = page.locator('.tl-panel.tl-problems');
  await expect(panel).toContainText(lineOf(TEX, 'tex-wall', 3, tex[1]!, tex[2]!), { timeout: 15_000 });
  await expect(panel).toContainText(lineOf(MODEL, 'model-rock', 3, model[1]!, model[2]!));
  // The earlier starts' lines stay in the log.
  await expect(panel).toContainText(lineOf(TEX, 'tex-wall', 2, tex[0]!, tex[1]!));
  await panel.screenshot({ path: join('test-results', 'play-reimports', 'problems.png') });
  await page.getByTitle('Stop the play preview').click();
  await expect(page.locator('iframe.tl-app__preview-frame')).toHaveCount(0, { timeout: 30_000 });

  // Nothing changed since: the check before the next start imported nothing.
  const quiet = await be.post(`/api/v1/projects/${ID}/play`, {});
  expect(quiet.status).toBe(200);
  expect((quiet.json as unknown as Started).check?.reimported).toEqual([]);
  await stopped((quiet.json as unknown as Started).playSessionId);
  expect((await problems()).filter((x) => x.code === 'asset_reimported')).toHaveLength(4);
  expect(errors).toEqual([]);
});
