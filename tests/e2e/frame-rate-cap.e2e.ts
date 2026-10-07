/**
 * The frame-rate cap a game controls, in Play on a browser with no vsync and
 * no frame-rate limit (it would draw as fast as it can):
 * - the project setting `frame_rate_cap` 30 draws ~30 frames a second;
 * - a script's `ctx.display.setFrameRateCap(60)` takes it to ~60, `null` to
 *   none (uncapped: far above 60 on the GPU), and the script reads the cap
 *   back (`ctx.display.frameRateCap`);
 * - a player's settings field bound to `frameRateCap` applies from the start
 *   (its default until the player changes it), changes the cap live when
 *   written (here by the script, as a settings screen would), and the choice
 *   is kept with the player's settings: the next Play starts at it;
 * - game time never moves with it: ~120 steps a second at every cap.
 */
import { randomBytes } from 'node:crypto';

import { expect, test } from './pw';

import { publishScript, startBackend, type E2EBackend } from './backend';
import { browserLaunchEnv, GPU_ARGS, gpuAvailable, SOFTWARE_GL_ARGS } from './browser-env.mjs';

// Uncapped: the browser's own vsync and frame-rate limit lifted, so only the game's cap holds frames back.
test.use({ launchOptions: { env: browserLaunchEnv() as Record<string, string>, args: [...(gpuAvailable() ? GPU_ARGS : SOFTWARE_GL_ARGS), '--disable-gpu-vsync', '--disable-frame-rate-limit'] } });

let be: E2EBackend | null = null;
test.afterEach(async () => {
  await be?.stop();
  be = null;
});

async function api(path: string, body: unknown): Promise<Record<string, unknown>> {
  const r = await fetch(`${be!.origin}/api/v1/projects/${be!.projectId}/play/${path}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${be!.token}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return (await r.json()) as Record<string, unknown>;
}

async function cmd(op: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const revision = Number((await be!.command({ op: 'queryProject', projectId: be!.projectId, args: {} })).revision);
  const res = await be!.command({ op, projectId: be!.projectId, expectedRevision: revision, requestId: `req-${randomBytes(16).toString('hex')}`, origin: { kind: 'mcp', clientId: 'e2e-fps-cap' }, args });
  expect(res['ok'], JSON.stringify(res)).toBe(true);
  return res;
}

/** `cap {fps}` sets the cap from the script (0: none), `setting {value}` writes the player's settings field; the counter `cap` mirrors what the script reads. */
const DRIVER = [
  'export default {',
  '  instantiate() { return {}; },',
  '  step(_state: any, ctx: any) {',
  "    if (ctx.phase !== 'intent') return;",
  "    for (const c of ctx.debug.command('cap', { description: 'Set the frame-rate cap', args: [{ name: 'fps', type: 'number' }] })) ctx.display.setFrameRateCap(Number(c.fps) === 0 ? null : Number(c.fps));",
  "    for (const c of ctx.debug.command('setting', { description: 'Set the player setting', args: [{ name: 'value', type: 'string' }] })) ctx.saves.setSetting('fps', String(c.value));",
  '    const read = ctx.display.frameRateCap ?? 0;',
  "    ctx.game.add('cap', read - ctx.game.counter('cap'));",
  '  },',
  '};',
].join('\n');

/**
 * Each rate is measured over 5 s (150 frames at 30, 600 steps): a frame or step either way, or the
 * diagnostics round trips' jitter at the window's ends, stays well inside the bounds below (at 60 fps the
 * upper bound is 4 % over: 3 s windows left a frame and a round trip of jitter barely inside it). The kept
 * and player settings are checked over 3 s: their reading only has to tell 30 from 60.
 */
const WINDOW_S = 5;
const SHORT_WINDOW_S = 3;
/** After the cap reads back, the frames already queued at the old rate are drawn before a window starts. */
const SWITCH_MS = 500;

type Diagnostics = { runtime: { stepIndex: number; droppedSteps: number; frameCount: number }; simulation: { pipeline: { frames: number; ticksSkipped: number; framesWithoutWorkerFrame: number; workerRoundTripMs: unknown; inputToDrawMs: unknown } | null }; framePacing: { frameRateCap: number | null; drawnFrames: number; skippedFrames: number; displayMs: number } | null };

test('the frame-rate cap: project setting, script and player setting change the drawn rate live, never game time; the player\'s choice is kept', async ({ page }) => {
  test.setTimeout(240_000);
  be = await startBackend('fps-cap-e2e', 'starter');
  await cmd('setSettings', { settings: { frame_rate_cap: 30 } });
  const driver = String((await cmd('createEntity', { sceneId: 'scene-main', kind: 'group', name: 'Cap driver' }))['createdId']);
  await publishScript(be, 'capdriver', DRIVER, driver);

  const diagnostics = async (psid: string): Promise<Diagnostics> => (await api(`${psid}/diagnostics`, {}))['diagnostics'] as Diagnostics;
  const observeCap = async (psid: string): Promise<number> => ((await api(`${psid}/observe`, {})) as { counters?: Record<string, number> }).counters?.['cap'] ?? -1;
  const run = async (psid: string, name: string, args: Record<string, unknown>): Promise<void> => {
    const r = await api(`${psid}/control`, { command: 'debugCommand', name, args });
    expect(r['ok'], JSON.stringify(r)).toBe(true);
  };
  /** Drawn frames and steps per second over `seconds`. */
  const measure = async (psid: string, seconds: number, label: string): Promise<{ fps: number; steps: number }> => {
    const d0 = await diagnostics(psid);
    const t0 = Date.now();
    await page.waitForTimeout(seconds * 1000);
    const d1 = await diagnostics(psid);
    const s = (Date.now() - t0) / 1000;
    const fps = (d1.framePacing!.drawnFrames - d0.framePacing!.drawnFrames) / s;
    const steps = (d1.runtime.stepIndex - d0.runtime.stepIndex) / s;
    process.stderr.write(`frame-rate-cap e2e: ${label}: ${fps.toFixed(1)} drawn fps, ${steps.toFixed(1)} steps/s, cap ${JSON.stringify(d1.framePacing!.frameRateCap)}, display ${d1.framePacing!.displayMs} ms, skipped ${d1.framePacing!.skippedFrames - d0.framePacing!.skippedFrames}, dropped steps ${d1.runtime.droppedSteps - d0.runtime.droppedSteps}, worker frames ${d1.runtime.frameCount - d0.runtime.frameCount}, pipeline ${JSON.stringify(d1.simulation.pipeline)}\n`);
    return { fps, steps };
  };
  const startPlay = async (): Promise<string> => {
    const started = page.waitForResponse((r) => r.request().method() === 'POST' && r.url().endsWith('/play'));
    await page.getByTitle('Start an isolated play preview').click();
    const psid = String(((await (await started).json()) as { playSessionId: string }).playSessionId);
    await expect.poll(async () => (await diagnostics(psid).catch(() => null))?.framePacing?.drawnFrames ?? 0, { timeout: 60_000 }).toBeGreaterThan(30);
    return psid;
  };
  const stopPlay = async (): Promise<void> => {
    await page.getByTitle('Stop the play preview').click();
    await expect(page.locator('iframe.tl-app__preview-frame')).toHaveCount(0, { timeout: 30_000 });
  };
  const steady = (steps: number): void => {
    expect(steps).toBeGreaterThan(120 * 0.93);
    expect(steps).toBeLessThan(120 * 1.07);
  };

  await page.goto(be.editorUrl);
  await expect(page.locator('.tl-statusbar')).toContainText('connected');
  let psid = await startPlay();

  // The project setting: 30.
  await expect.poll(() => observeCap(psid), { timeout: 15_000 }).toBe(30);
  await page.waitForTimeout(SWITCH_MS);
  const at30 = await measure(psid, WINDOW_S, 'project setting 30');
  expect(at30.fps).toBeGreaterThan(27);
  expect(at30.fps).toBeLessThan(31.5);
  steady(at30.steps);

  // A script sets 60, then none.
  await run(psid, 'cap', { fps: 60 });
  await expect.poll(() => observeCap(psid), { timeout: 15_000 }).toBe(60);
  await page.waitForTimeout(SWITCH_MS);
  const at60 = await measure(psid, WINDOW_S, 'script 60');
  expect(at60.fps).toBeGreaterThan(55);
  expect(at60.fps).toBeLessThan(62.5);
  steady(at60.steps);
  await run(psid, 'cap', { fps: 0 });
  await expect.poll(() => observeCap(psid), { timeout: 15_000 }).toBe(0);
  await page.waitForTimeout(SWITCH_MS);
  const free = await measure(psid, WINDOW_S, 'none');
  // Uncapped: the display's (here the browser's unlimited) rate; on the GPU far above any cap.
  expect(free.fps).toBeGreaterThan(gpuAvailable() ? 90 : at60.fps * 0.8);
  steady(free.steps);
  const pacing = (await diagnostics(psid)).framePacing!;
  expect(pacing.frameRateCap).toBeNull();

  await stopPlay();

  // A player's settings field bound to the cap: its value applies from the start (here its default, 120).
  await cmd('setSaveSchema', { schema: { version: 1, slots: 1, legacyWorld: false, settings: [{ key: 'fps', type: 'enum', values: ['30', '60', '120', 'none'], default: '120', engine: 'frameRateCap' }] } });
  psid = await startPlay();
  await expect.poll(() => observeCap(psid), { timeout: 15_000 }).toBe(120);
  // Written as a settings screen would: 30, live.
  await run(psid, 'setting', { value: '30' });
  await expect.poll(() => observeCap(psid), { timeout: 15_000 }).toBe(30);
  await page.waitForTimeout(SWITCH_MS);
  const player30 = await measure(psid, SHORT_WINDOW_S, 'player setting 30');
  expect(player30.fps).toBeGreaterThan(27);
  expect(player30.fps).toBeLessThan(31.5);
  steady(player30.steps);

  // Kept with the player's settings: the next Play starts at the player's 60, not the field's default.
  await run(psid, 'setting', { value: '60' });
  await expect.poll(() => observeCap(psid), { timeout: 15_000 }).toBe(60);
  await stopPlay();
  psid = await startPlay();
  await expect.poll(() => observeCap(psid), { timeout: 15_000 }).toBe(60);
  expect((await diagnostics(psid)).framePacing!.frameRateCap).toBe(60);
  await page.waitForTimeout(SWITCH_MS);
  const kept = await measure(psid, SHORT_WINDOW_S, 'kept player setting 60');
  expect(kept.fps).toBeGreaterThan(55);
  expect(kept.fps).toBeLessThan(62.5);
  steady(kept.steps);
});
