/**
 * The editor's Scene view measured the way an export is (frame-run.ts):
 * 1920×1080 at device pixel ratio 1, uncapped, on the host's GPU. The Scene
 * view draws on demand, so frames are asked for the way a user asks for
 * them: an orbit, one pointer move per animation frame around the view's
 * centre (the editor frames the whole level when it opens). The window
 * reports frame intervals, draws, triangles, the renderer process's
 * main-thread time per frame and the scene three walks.
 */
import type { Browser } from '@playwright/test';

import type { PerfBackend } from './backend';
import { FRAME_VIEWPORT, type FrameRenderer } from './frame-run';
import { installFrameProbe, probeSceneCounts, type SceneCounts } from './frame-probe';
import { installPerfInstrumentation, readSample } from './instrument';
import { summarize, type Summary } from './stats';

export interface SceneViewResult {
  url: string;
  backend: string | null;
  frames: { n: number; fps: number; p50: number; p95: number; p99: number; mean: number };
  draws: Summary;
  tris: Summary;
  mainThread: { taskMsPerFrame: number; busyShare: number };
  scene: SceneCounts;
  /** How long the view took to stop drawing after it opened (models, textures and the environment in). */
  settledMs: number;
  errors: string[];
}

export async function measureSceneView(browser: Browser, be: PerfBackend, projectId: string, renderer: FrameRenderer, opts: { warmupMs: number; recordMs: number; shot?: string }): Promise<SceneViewResult> {
  const context = await browser.newContext({ viewport: { ...FRAME_VIEWPORT }, deviceScaleFactor: 1 });
  await context.addInitScript(installPerfInstrumentation);
  await context.addInitScript(installFrameProbe, { timestamps: false });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`.slice(0, 500)));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(`console: ${m.text()}`.slice(0, 300));
  });
  const url = `${be.origin}/?project=${projectId}&renderer=${renderer}`;
  try {
    await page.goto(`${url}#token=${be.token}`);
    await page.locator('.tl-statusbar').filter({ hasText: 'connected' }).waitFor({ timeout: 180_000 });
    // Settled: the view stopped drawing (render on demand) for a few seconds.
    const t0 = Date.now();
    let last = '';
    let same = 0;
    while (Date.now() - t0 < 120_000 && same < 3) {
      const now = await page.evaluate(() => document.querySelector('canvas.tl-viewport')?.getAttribute('data-frames') ?? '');
      same = now === last && now !== '' ? same + 1 : 0;
      last = now;
      await new Promise((r) => setTimeout(r, 1000));
    }
    const settledMs = Date.now() - t0;
    const box = await page.evaluate(() => {
      const r = document.querySelector('canvas.tl-viewport')?.getBoundingClientRect();
      return r === undefined ? null : { x: r.x, y: r.y, width: r.width, height: r.height };
    });
    if (box === null) throw new Error('no Scene view canvas');
    const cx = box.x + box.width / 2;
    const cy = box.y + box.height / 2;
    await page.evaluate(() => {
      const w = window as unknown as { __tlPointer?: number };
      document.addEventListener('pointerdown', (e) => (w.__tlPointer = e.pointerId), { capture: true, once: true });
    });
    await page.mouse.move(cx, cy);
    await page.mouse.down();
    const orbit = (ms: number, record: boolean): Promise<unknown> =>
      page.evaluate(
        async ({ cx, cy, rx, ry, ms, record }) => {
          const w = window as unknown as { __tlPointer?: number; __tlPerf?: { frames: number[]; frameDraws: number[]; frameTris: number[]; recording: boolean } };
          const P = w.__tlPerf!;
          if (record) {
            P.frames = [];
            P.frameDraws = [];
            P.frameTris = [];
            P.recording = true;
          }
          const target = document.elementFromPoint(cx, cy) ?? document.body;
          const id = w.__tlPointer ?? 1;
          await new Promise<void>((done) => {
            const start = performance.now();
            let i = 0;
            const step = (): void => {
              // A slow circle (one turn per 240 frames): the view keeps most of the level in sight.
              const a = (i++ / 240) * Math.PI * 2;
              target.dispatchEvent(new PointerEvent('pointermove', { pointerId: id, pointerType: 'mouse', isPrimary: true, clientX: cx + Math.cos(a) * rx, clientY: cy + Math.sin(a) * ry, button: -1, buttons: 1, bubbles: true, cancelable: true, composed: true }));
              if (performance.now() - start < ms) requestAnimationFrame(step);
              else done();
            };
            requestAnimationFrame(step);
          });
        },
        { cx, cy, rx: box.width * 0.04, ry: box.height * 0.03, ms, record },
      );
    await orbit(opts.warmupMs, false);
    const cdp = await context.newCDPSession(page);
    await cdp.send('Performance.enable');
    const metrics = async (): Promise<Record<string, number>> => Object.fromEntries(((await cdp.send('Performance.getMetrics')) as { metrics: { name: string; value: number }[] }).metrics.map((m) => [m.name, m.value]));
    const a = await metrics();
    const w0 = performance.now();
    await orbit(opts.recordMs, true);
    const sample = await page.evaluate(readSample, true);
    const b = await metrics();
    const wall = performance.now() - w0;
    await cdp.detach().catch(() => undefined);
    await page.mouse.up();
    const scene = await page.evaluate(probeSceneCounts);
    if (opts.shot !== undefined) await page.screenshot({ path: opts.shot });
    const taskMs = ((b['TaskDuration'] ?? 0) - (a['TaskDuration'] ?? 0)) * 1000;
    const n = Math.max(1, sample.frames.length);
    const s = summarize(sample.frames);
    return {
      url,
      backend: sample.renderer?.backend ?? null,
      frames: { n: s.n, fps: s.mean > 0 ? Math.round((1000 / s.mean) * 10) / 10 : 0, p50: s.p50, p95: s.p95, p99: s.p99, mean: s.mean },
      draws: summarize(sample.frameDraws),
      tris: summarize(sample.frameTris),
      mainThread: { taskMsPerFrame: Math.round((taskMs / n) * 100) / 100, busyShare: Math.round((taskMs / Math.max(1, wall)) * 1000) / 1000 },
      scene,
      settledMs,
      errors,
    };
  } finally {
    await context.close();
  }
}

export function sceneViewLine(what: string, r: SceneViewResult): string {
  return `${what}: ${r.frames.fps} fps, frame p50/p95/p99 ${r.frames.p50}/${r.frames.p95}/${r.frames.p99} ms (${r.frames.n} frames), ${r.draws.p50} draws, ${Math.round(r.tris.p50 / 1000)}k tris, ${r.scene.objects} Object3Ds (${r.scene.groups} groups, ${r.scene.lods} LOD, ${r.scene.meshes} meshes of which ${r.scene.hiddenMeshes} hidden, ${r.scene.lights} lights), main thread ${r.mainThread.taskMsPerFrame} ms/frame (${Math.round(r.mainThread.busyShare * 100)}%), settled in ${r.settledMs} ms${r.errors.length > 0 ? `; ${r.errors.length} page errors: ${r.errors[0]}` : ''}`;
}
