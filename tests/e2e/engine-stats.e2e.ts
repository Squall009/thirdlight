/**
 * The engine's frame statistics against a real backend in a real browser,
 * on the starter project.
 *
 * - Without the `stats_overlay` setting there is no overlay, and F3 brings
 *   none; a script still reads `ctx.stats` (published to the view model) and
 *   a UI text binds `$flow.stats`: fps, frame and CPU times, draw calls,
 *   objects, the texture budget, the quality level. Play diagnostics carry
 *   the same frame times and the environment renderer's post passes and
 *   quality. GPU time is a number only where the browser has timestamp
 *   queries, else null (reported, never estimated).
 * - With `stats_overlay` 2 the overlay waits hidden; F3 shows it (fps, the
 *   times, "gpu"), F3 hides it again. With 1 the exported game (backend
 *   stopped) shows it from the start.
 */
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';

import { expect, test, type FrameLocator, type Page } from './pw';

import { STARTER, publishScript, serveDir, startBackend, type E2EBackend } from './backend';

let be: E2EBackend;
test.beforeEach(async () => {
  be = await startBackend(`engine-stats-${randomUUID().slice(0, 8)}`, 'starter');
});
test.afterEach(async () => {
  await be.stop();
});

const query = (op: string, args: Record<string, unknown> = {}): Promise<Record<string, unknown>> => be.command({ op, projectId: be.projectId, args });
async function cmd(op: string, args: Record<string, unknown>): Promise<void> {
  const res = await be.command({ op, projectId: be.projectId, expectedRevision: Number((await query('queryProject')).revision), requestId: `req-${randomUUID().replace(/-/g, '')}`, origin: { kind: 'mcp', clientId: 'e2e-engine-stats' }, args });
  expect(res['ok'], JSON.stringify(res).slice(0, 600)).toBe(true);
}
async function api(path: string, body: unknown): Promise<{ status: number; json: Record<string, unknown> }> {
  const r = await fetch(`${be.origin}/api/v1/projects/${be.projectId}/${path}`, { method: 'POST', headers: { authorization: `Bearer ${be.token}`, 'content-type': 'application/json', origin: be.origin }, body: JSON.stringify(body) });
  return { status: r.status, json: (await r.json()) as Record<string, unknown> };
}
async function settings(extra: Record<string, unknown>): Promise<void> {
  const current = (await query('queryGameConfig'))['settings'] as Record<string, unknown>;
  await cmd('setSettings', { settings: { ...current, ...extra } });
}

// A script publishes what it reads in ctx.stats to the view model; a document shows $flow.stats.
const SCRIPT = [
  'export default {',
  '  instantiate() { return { n: 0 }; },',
  '  step(s: any, ctx: any) {',
  "    if (ctx.phase !== 'intent') return;",
  '    s.n += 1;',
  "    if (s.n === 2) ctx.ui.show('hud');",
  "    ctx.ui.set('seen', ctx.stats);",
  '  },',
  '};',
  '',
].join('\n');
const HUD = { uiDocumentId: 'hud', name: 'Hud', layer: 5, root: { type: 'panel', stretch: 'both', children: [{ id: 'fps', type: 'text', anchor: [1, 1], pivot: [1, 1], text: 'fps {$flow.stats.fps} draws {$flow.stats.drawCalls} q {$flow.stats.quality}', css: { color: '#ffffff' } }] } };

type Time = { avg: number; worst: number };
type Stats = { fps: number; frameMs: Time; cpuMs: Time; gpuMs: Time | null; drawCalls: number; triangles: number; textureBytes: number; textureBudgetBytes: number; geometryBytes: number; entities: number; quality: string; windowMs: number };

async function startPlay(page: Page): Promise<{ psid: string; frame: FrameLocator }> {
  const started = page.waitForResponse((r) => r.request().method() === 'POST' && r.url().endsWith('/play'));
  await page.getByTitle('Start an isolated play preview').click();
  const psid = String(((await (await started).json()) as { playSessionId: string }).playSessionId);
  await expect.poll(async () => (await api(`play/${psid}/observe`, {})).json['state'] ?? null, { timeout: 60_000 }).toBe('running');
  return { psid, frame: page.frameLocator('iframe.tl-app__preview-frame') };
}

test('ctx.stats, $flow.stats and Play diagnostics read the frame statistics; no overlay and no key without the setting; with it, the overlay behind F3 in Play and from the start in the export', async ({ page }) => {
  test.setTimeout(300_000);
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await cmd('setUiDocument', { document: HUD });
  await cmd('setEnvironment', { sceneId: 'scene-main', environment: { sky: { mode: 'color', color: '#303030' }, post: { vignette: { enabled: true } } } });
  await publishScript(be, 'behavior-stats', SCRIPT, STARTER.playerId);
  await page.goto(be.editorUrl);
  await expect(page.locator('.tl-statusbar')).toContainText('connected');
  const { psid, frame } = await startPlay(page);

  // ctx.stats, as the script published it after the first window.
  const seen = async (): Promise<Stats | null> => (((await api(`play/${psid}/observe`, {})).json['ui'] as { values?: { seen?: Stats } } | undefined)?.values?.seen ?? null);
  await expect.poll(async () => (await seen())?.fps ?? 0, { timeout: 30_000 }).toBeGreaterThan(1);
  const s = (await seen())!;
  expect(s.windowMs).toBeGreaterThanOrEqual(500);
  expect(s.frameMs.avg).toBeGreaterThan(0);
  expect(s.frameMs.worst).toBeGreaterThanOrEqual(s.frameMs.avg);
  expect(s.cpuMs.avg).toBeGreaterThan(0);
  expect(s.cpuMs.worst).toBeGreaterThanOrEqual(s.cpuMs.avg);
  expect(s.drawCalls).toBeGreaterThan(0);
  expect(s.triangles).toBeGreaterThan(0);
  expect(s.entities).toBeGreaterThan(1);
  expect(s.textureBudgetBytes).toBe(512 * 1024 * 1024);
  expect(s.quality).toBe('high');
  if (s.gpuMs !== null) expect(s.gpuMs.avg).toBeGreaterThan(0);
  // $flow.stats in a UI document.
  const hud = frame.locator('[data-tl-ui-doc="hud"] [data-widget="fps"]');
  await expect(hud).toHaveText(/^fps \d+(\.\d+)? draws [1-9]\d* q high$/, { timeout: 10_000 });

  // Play diagnostics: the same frame times, the post passes and the quality level.
  const d = (await api(`play/${psid}/diagnostics`, {})).json['diagnostics'] as { frameTimes: Stats | null; renderer: { environment?: { post: boolean; passes: string[]; quality: string; samples: number } } };
  expect(d.frameTimes).not.toBeNull();
  expect(d.frameTimes!.fps).toBeGreaterThan(1);
  expect(d.frameTimes!.gpuMs === null ? 'not measured' : 'measured').toBe(s.gpuMs === null ? 'not measured' : 'measured');
  expect(d.renderer.environment).toMatchObject({ post: true, quality: 'high' });
  // The vignette is drawn in the grading pass.
  expect(d.renderer.environment!.passes).toEqual(expect.arrayContaining(['render', 'grading', 'output']));
  test.info().annotations.push({ type: 'stats', description: JSON.stringify({ fps: s.fps, frameMs: s.frameMs, cpuMs: s.cpuMs, gpuMs: s.gpuMs, passes: d.renderer.environment!.passes }) });

  // No overlay, and F3 brings none.
  await page.locator('iframe.tl-app__preview-frame').click();
  await page.keyboard.press('F3');
  await page.waitForTimeout(500);
  await expect(frame.locator('[data-tl-stats]')).toHaveCount(0);
  expect(errors).toEqual([]);
  await page.getByTitle('Stop the play preview').click();
  await expect(page.locator('iframe.tl-app__preview-frame')).toHaveCount(0, { timeout: 30_000 });

  // The same project with the setting: the stats overlay hidden until F3 in Play (setting 2), shown from the start in the export (setting 1).
  await settings({ stats_overlay: 2 });
  const { frame: frame2 } = await startPlay(page);
  const overlay = frame2.locator('[data-tl-stats]');
  await expect(overlay).toHaveCount(1, { timeout: 30_000 });
  await expect(overlay).toHaveAttribute('data-shown', 'false');
  await expect(overlay).toBeHidden();
  await page.locator('iframe.tl-app__preview-frame').click();
  await page.keyboard.press('F3');
  await expect(overlay).toHaveAttribute('data-shown', 'true');
  await expect(overlay).toBeVisible();
  await expect(overlay).toContainText(/^\d+ fps/, { timeout: 10_000 });
  await expect(overlay).toContainText(/frame +\d+\.\d \/ \d+\.\d ms/);
  await expect(overlay).toContainText(/gpu +(not measured|\d+\.\d \/ \d+\.\d ms)/);
  await expect(overlay).toContainText(/tex +\d+\.\d MiB \/ 512\.0 MiB/);
  await expect(overlay).toContainText('quality high');
  await page.keyboard.press('F3');
  await expect(overlay).toHaveAttribute('data-shown', 'false');
  await page.getByTitle('Stop the play preview').click();

  // The export with the overlay on from the start, served with the backend stopped.
  await settings({ stats_overlay: 1 });
  const res = await be.admin(`projects/${be.projectId}/export`);
  expect(res.status, JSON.stringify(res.json)).toBe(200);
  const out = join(be.exportRoot, String(res.json['outputDir']));
  await page.goto('about:blank');
  await be.halt();
  const site = await serveDir(out);
  const exported = await page.context().newPage();
  exported.on('pageerror', (e) => errors.push(e.message));
  try {
    await exported.goto(site.url);
    const shown = exported.locator('[data-tl-stats]');
    await expect(shown).toHaveAttribute('data-shown', 'true', { timeout: 60_000 });
    await expect(shown).toContainText(/^\d+ fps/, { timeout: 15_000 });
    await expect(shown).toContainText(/draws [1-9]/);
    await exported.screenshot({ path: 'test-results/engine-stats-export.png' });
  } finally {
    await exported.close();
    await site.close();
  }
  expect(errors).toEqual([]);
});
