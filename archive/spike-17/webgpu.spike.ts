/**
 * SPIKE 17.0 (throwaway, not for main): Beacon Reach (template, exported
 * through a real backend) and a Sprout export (read-only, TL_SPIKE_SPROUT or
 * the newest ~/thirdlight/exports/sprout@*) rendered by
 *   webgl   — today's engine (THREE.WebGLRenderer + EffectComposer), rebuilt from source
 *   webgpu  — WebGPURenderer on WebGPU (Dawn SwiftShader adapter), post as a TSL RenderPipeline
 *   webgl2  — WebGPURenderer with forceWebGL (its WebGL2 backend), same TSL pipeline
 * (+ `-nopost` variants). Frame times are rAF intervals in the exported page
 * while the game runs, measured back to back; results go to
 * ~/.cache/thirdlight-spike17/results.json, screenshots next to it.
 */
import { cpSync, createReadStream, existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { homedir } from 'node:os';
import { extname, join, normalize } from 'node:path';

import { expect, test, type Page } from '@playwright/test';

import { startBackend } from '../../tests/e2e/backend';
import { colorCount, decodePng } from '../../tests/e2e/png';
// @ts-expect-error — plain .mjs spike helper
import { buildVariant } from './build-variant.mjs';

const OUT = join(homedir(), '.cache', 'thirdlight-spike17');
const MEASURE_MS = Number(process.env['TL_SPIKE_MS'] ?? 8000);
const ROUNDS = Number(process.env['TL_SPIKE_ROUNDS'] ?? 2);

function serve(dir: string): Promise<{ url: string; server: Server }> {
  const server = createServer((req, reply) => {
    const rel = normalize(decodeURIComponent((req.url ?? '/').split('?')[0]!)).replace(/^\/+/, '') || 'index.html';
    const file = join(dir, rel);
    if (!file.startsWith(dir) || !existsSync(file) || !statSync(file).isFile()) {
      reply.statusCode = 404;
      reply.end();
      return;
    }
    const types: Record<string, string> = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json', '.wasm': 'application/wasm' };
    reply.setHeader('content-type', types[extname(file)] ?? 'application/octet-stream');
    createReadStream(file).pipe(reply);
  });
  return new Promise((ok) => server.listen(0, '127.0.0.1', () => ok({ url: `http://127.0.0.1:${(server.address() as { port: number }).port}/`, server })));
}

type Mode = { name: string; variant: 'base' | 'spike'; query: string };
const MODES: Mode[] = [
  { name: 'webgl', variant: 'base', query: '' },
  { name: 'webgpu', variant: 'spike', query: '?spike=webgpu' },
  { name: 'webgl2', variant: 'spike', query: '?spike=webgl2' },
  { name: 'webgpu-nopost', variant: 'spike', query: '?spike=webgpu&post=off' },
  { name: 'webgl2-nopost', variant: 'spike', query: '?spike=webgl2&post=off' },
  { name: 'webgl-noaa', variant: 'spike', query: '?aa=0' },
  { name: 'webgpu-noaa', variant: 'spike', query: '?spike=webgpu&aa=0' },
  { name: 'webgl2-noaa', variant: 'spike', query: '?spike=webgl2&aa=0' },
];

function stats(t: number[]): Record<string, number> {
  const s = [...t].sort((a, b) => a - b);
  const mean = t.reduce((a, b) => a + b, 0) / Math.max(1, t.length);
  const q = (p: number): number => s[Math.min(s.length - 1, Math.floor(p * s.length))] ?? NaN;
  return { frames: t.length, meanMs: +mean.toFixed(1), medianMs: +q(0.5).toFixed(1), p95Ms: +q(0.95).toFixed(1), fps: +(1000 / mean).toFixed(2) };
}

/** rAF intervals for at least `ms` and at least `minFrames` frames (capped at 90 s). */
async function rafIntervals(page: Page, ms: number, minFrames = 1): Promise<number[]> {
  return page.evaluate(
    ([dur, min]) =>
      new Promise<number[]>((res) => {
        const t: number[] = [];
        let last = performance.now();
        const start = last;
        const f = (now: number): void => {
          t.push(now - last);
          last = now;
          if ((now - start < dur || t.length < min + 1) && now - start < 90_000) requestAnimationFrame(f);
          else res(t.slice(1));
        };
        requestAnimationFrame(f);
      }),
    [ms, minFrames] as const,
  );
}

async function runOne(game: 'beacon' | 'sprout', mode: Mode, url: string, round: number): Promise<Record<string, unknown>> {
  const { chromium } = await import('@playwright/test');
  const cfg = test.info().project.use.launchOptions!;
  const browser = await chromium.launch(cfg);
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  const logs: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'error' || m.type() === 'warning') {
      const line = `${m.type()}: ${m.text().slice(0, 240)}`;
      if (!logs.includes(line) && logs.length < 40) logs.push(line);
    }
  });
  page.on('pageerror', (e) => logs.length < 40 && logs.push(`pageerror: ${e.message.slice(0, 240)}`));
  const t0 = Date.now();
  const result: Record<string, unknown> = { game, mode: mode.name, round };
  try {
    await page.goto(url + mode.query);
    if (game === 'sprout') {
      await expect(page.locator('.tl-flow')).toHaveAttribute('data-screen', 'title', { timeout: 120_000 });
      await page.waitForTimeout(1500);
      await page.mouse.click(20, 700);
      await page.keyboard.press('Enter');
      await expect(page.locator('.tl-flow')).toHaveAttribute('data-screen', 'playing', { timeout: 60_000 });
    } else {
      const hud = async (): Promise<string> => (await page.locator('#hud-root').textContent()) ?? '';
      await expect.poll(hud, { timeout: 120_000 }).toContain('to start');
      // (#hud's state line is written once at load, so it is no start signal; the scene renders every frame either way.)
      await page.mouse.click(640, 600);
      await page.keyboard.press('Enter');
      await page.waitForTimeout(1500);
    }
    result['startMs'] = Date.now() - t0;
    result['warmup'] = stats(await rafIntervals(page, 3000, 8)); // first frames compile pipelines/programs
    result['frame'] = stats(await rafIntervals(page, MEASURE_MS, 12));
    result['spike'] = await page.evaluate(async () => {
      const s = (globalThis as unknown as { __tlSpike?: { init: Promise<unknown>; renderer: { info: { render: unknown; memory: unknown } } } }).__tlSpike;
      if (s === undefined) return null;
      return { init: await s.init, render: s.renderer.info.render, memory: s.renderer.info.memory };
    });
    const png = await page.screenshot();
    writeFileSync(join(OUT, `${game}-${mode.name}-r${round}.png`), png);
    result['colors'] = colorCount(decodePng(png), 0.9);
  } catch (e) {
    result['failure'] = String(e).slice(0, 400);
    try {
      writeFileSync(join(OUT, `${game}-${mode.name}-r${round}-fail.png`), await page.screenshot());
    } catch {
      /* ignore */
    }
  }
  result['logs'] = logs;
  await browser.close();
  return result;
}

test('spike 17.0: WebGPURenderer (WebGPU / forced WebGL2) vs WebGLRenderer', async () => {
  mkdirSync(OUT, { recursive: true });
  const exports: Array<{ game: 'beacon' | 'sprout'; dir: string }> = [];
  const games = (process.env['TL_SPIKE_GAMES'] ?? 'beacon,sprout').split(',');

  if (games.includes('beacon')) {
    const be = await startBackend('spike-beacon', 'beacon-reach');
    const res = await be.admin(`projects/${be.projectId}/export`);
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    const src = join(be.exportRoot, String(res.json['outputDir']));
    rmSync(join(OUT, 'v', 'beacon-orig'), { recursive: true, force: true });
    cpSync(src, join(OUT, 'v', 'beacon-orig'), { recursive: true });
    await buildVariant(src, join(OUT, 'v', 'beacon-base'), false);
    await buildVariant(src, join(OUT, 'v', 'beacon-spike'), true);
    await be.stop();
    exports.push({ game: 'beacon', dir: join(OUT, 'v', 'beacon') });
  }
  if (games.includes('sprout')) {
    const root = join(homedir(), 'thirdlight', 'exports');
    const newest = process.env['TL_SPIKE_SPROUT'] ?? (existsSync(root) ? readdirSync(root).filter((d) => d.startsWith('sprout@')).map((d) => join(root, d)).sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0] : undefined);
    if (newest !== undefined) {
      await buildVariant(newest, join(OUT, 'v', 'sprout-base'), false);
      await buildVariant(newest, join(OUT, 'v', 'sprout-spike'), true);
      exports.push({ game: 'sprout', dir: join(OUT, 'v', 'sprout') });
    }
  }

  const modes = process.env['TL_SPIKE_MODES'] !== undefined ? MODES.filter((m) => process.env['TL_SPIKE_MODES']!.split(',').includes(m.name)) : MODES;
  const results: Record<string, unknown>[] = [];
  for (const ex of exports) {
    const base = await serve(`${ex.dir}-base`);
    const spike = await serve(`${ex.dir}-spike`);
    for (let round = 1; round <= ROUNDS; round++) {
      for (const mode of modes) {
        const r = await runOne(ex.game, mode, mode.variant === 'base' ? base.url : spike.url, round);
        results.push(r);
        process.stderr.write(`${JSON.stringify({ ...r, logs: (r['logs'] as string[]).length })}\n`);
        writeFileSync(join(OUT, 'results.json'), JSON.stringify(results, null, 2));
      }
    }
    base.server.close();
    spike.server.close();
  }
});
