/**
 * Phase 17.2: shader parity. Each shader type of the project material
 * library (standard, foliage wind, kit world-X UV + macro normal, unlit,
 * water), lightmaps (UV1, range scaling, no-ambient) and the per-mesh looks
 * (selection highlight, checkpoint glow) render in a neutral test scene
 * (`shader-parity/harness.ts`) and are compared with the WebGL reference
 * images captured from the legacy renderer before the port
 * (`shader-parity/refs/*.png`, re-captured with `shader-parity/capture.mjs`).
 *
 * - `default` project: the legacy renderer still matches its references,
 *   and the node materials on WebGPURenderer's WebGL 2 backend match them.
 * - `webgpu` project: the node materials on WebGPU match them.
 * - A control: the legacy (onBeforeCompile) materials drawn by
 *   WebGPURenderer do NOT match (the comparison sees what the port fixes).
 *
 * The tolerance rule is logged in docs/plan-phase-17.md §6 (17.2).
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { join, resolve } from 'node:path';

import { expect, test, type Page } from '@playwright/test';
import { build } from 'esbuild';

import { decodePng, type Image } from './png';
import { makePng } from './png-make';

const HERE = resolve(import.meta.dirname, 'shader-parity');
const REFS = join(HERE, 'refs');
const REPO = resolve(import.meta.dirname, '..', '..');
const CAPTURE = process.env['TL_CAPTURE_SHADER_REFS'] === '1';
const SIZE = 256;

export const CASES = ['standard', 'foliage', 'kit', 'unlit', 'water', 'lightmap', 'highlight', 'checkpoint'] as const;
/** Cases whose legacy hook WebGPURenderer ignores: without the port they must fail the comparison. */
const CONTROL_CASES = ['foliage', 'kit', 'water', 'lightmap'] as const;

/**
 * The tolerance (logged in §6): both backends here are SwiftShader (the
 * legacy renderer and WebGPURenderer's WebGL 2 backend through ANGLE, WebGPU
 * through Dawn on SwiftShader's Vulkan), so the pictures are deterministic;
 * what differs is float evaluation order in three's node BRDF vs. its GLSL
 * chunks, where sRGB is decoded/encoded (a blended, textured unlit surface
 * lands up to ~12 levels off in places), and rasterisation of sub-pixel
 * edges (thin blades). Measured on the first run: mean ≤ 0.76, ≤ 0.02 % of
 * pixels off by more than 32. A render matches when the mean absolute
 * channel difference is ≤ MEAN_LIMIT and at most BAD_LIMIT of the pixels
 * differ by more than BAD_DELTA in some channel: about twice the measured
 * noise, far below what a lost shader hook costs (the control: mean 2.3–14,
 * 6–24 % bad pixels).
 */
const MEAN_LIMIT = 1.5;
const BAD_DELTA = 32;
const BAD_LIMIT = 0.005;

interface Diff {
  mean: number;
  bad: number;
  worst: number;
}
function diff(a: Image, b: Image): Diff {
  expect(a.width).toBe(b.width);
  expect(a.height).toBe(b.height);
  let sum = 0;
  let bad = 0;
  let worst = 0;
  for (let y = 0; y < a.height; y++) {
    for (let x = 0; x < a.width; x++) {
      const p = a.pixel(x, y);
      const r = b.pixel(x, y);
      const d = Math.max(Math.abs(p[0] - r[0]), Math.abs(p[1] - r[1]), Math.abs(p[2] - r[2]));
      sum += Math.abs(p[0] - r[0]) + Math.abs(p[1] - r[1]) + Math.abs(p[2] - r[2]);
      if (d > BAD_DELTA) bad += 1;
      worst = Math.max(worst, d);
    }
  }
  const n = a.width * a.height;
  return { mean: sum / (n * 3), bad: bad / n, worst };
}
const within = (d: Diff): boolean => d.mean <= MEAN_LIMIT && d.bad <= BAD_LIMIT;
const show = (d: Diff): string => `mean ${d.mean.toFixed(2)} (≤ ${MEAN_LIMIT}), >${BAD_DELTA}: ${(d.bad * 100).toFixed(2)}% (≤ ${BAD_LIMIT * 100}%), worst ${d.worst}`;

/** A visual diff for a failure report: grey reference, red where they differ. */
function diffPng(a: Image, b: Image): Buffer {
  return makePng(a.width, a.height, (x, y) => {
    const p = a.pixel(x, y);
    const r = b.pixel(x, y);
    const d = Math.max(Math.abs(p[0] - r[0]), Math.abs(p[1] - r[1]), Math.abs(p[2] - r[2]));
    const g = (r[0] + r[1] + r[2]) / 6;
    return d > BAD_DELTA ? [255, 0, 0, 255] : d > 8 ? [255, 160, 0, 255] : [g, g, g, 255];
  });
}

let server: Server | null = null;
let base = '';
test.beforeAll(async () => {
  const bundle = await build({ entryPoints: [join(HERE, 'harness.ts')], absWorkingDir: REPO, bundle: true, format: 'esm', platform: 'browser', write: false, logLevel: 'error' });
  const js = bundle.outputFiles[0]!.text;
  const html = `<!doctype html><body style="margin:0;background:#000"><canvas width="${SIZE}" height="${SIZE}" style="width:${SIZE}px;height:${SIZE}px;display:block"></canvas><script type="module" src="harness.js"></script></body>`;
  server = createServer((req, res) => {
    if ((req.url ?? '').startsWith('/harness.js')) {
      res.setHeader('content-type', 'text/javascript');
      res.end(js);
    } else {
      res.setHeader('content-type', 'text/html');
      res.end(html);
    }
  });
  await new Promise<void>((ok) => server!.listen(0, '127.0.0.1', ok));
  // localhost: a secure context, so navigator.gpu exists where the browser has WebGPU.
  base = `http://localhost:${(server.address() as { port: number }).port}/`;
});
test.afterAll(async () => {
  await new Promise<void>((ok) => (server === null ? ok() : server.close(() => ok())));
});

async function render(page: Page, backend: string, name: string, control = false): Promise<{ img: Image; png: Buffer; backend: string }> {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.setViewportSize({ width: SIZE, height: SIZE });
  await page.goto(`${base}?backend=${backend}&case=${name}${control ? '&control=1' : ''}`);
  await expect.poll(() => page.evaluate(() => (window as unknown as { __shaderCase?: unknown }).__shaderCase !== undefined), { timeout: 45_000 }).toBe(true);
  const result = await page.evaluate(() => (window as unknown as { __shaderCase: { ok: boolean; backend?: string; reason?: string; error?: string } }).__shaderCase);
  expect(result.ok, result.error).toBe(true);
  expect(errors).toEqual([]);
  const png = await page.locator('canvas').screenshot();
  return { img: decodePng(png), png, backend: result.backend ?? '' };
}

function reference(name: string): Image {
  return decodePng(readFileSync(join(REFS, `${name}.png`)));
}

/** Compare and, on a miss, leave the render and a diff next to the test output. */
function compare(name: string, label: string, got: { img: Image; png: Buffer }): Diff {
  const d = diff(got.img, reference(name));
  console.log(`[shader-parity] ${label} ${name}: ${show(d)}`);
  if (!within(d) && label !== 'control') {
    const out = test.info().outputPath();
    mkdirSync(out, { recursive: true });
    writeFileSync(join(out, `${name}-${label}.png`), got.png);
    writeFileSync(join(out, `${name}-${label}-diff.png`), diffPng(got.img, reference(name)));
  }
  return d;
}

const project = (): string => test.info().project.name;

if (CAPTURE) {
  test('capture the WebGL reference images (legacy renderer)', async ({ page }) => {
    test.skip(project() !== 'default', 'references come from the default project');
    test.setTimeout(300_000);
    mkdirSync(REFS, { recursive: true });
    for (const name of CASES) {
      const got = await render(page, 'legacy', name);
      writeFileSync(join(REFS, `${name}.png`), got.png);
      console.log(`[shader-parity] captured ${name}.png (${got.png.length} bytes)`);
    }
  });
} else {
  for (const name of CASES) {
    test(`${name}: node materials match the WebGL reference`, async ({ page }) => {
      test.setTimeout(120_000);
      if (project() === 'webgpu') {
        const got = await render(page, 'webgpu', name);
        expect(got.backend).toBe('webgpu');
        expect(within(compare(name, 'webgpu', got)), `webgpu ${name}`).toBe(true);
        return;
      }
      // The legacy path is unchanged until the switch-over: it still draws its references.
      const legacy = await render(page, 'legacy', name);
      expect(within(compare(name, 'legacy', legacy)), `legacy ${name}`).toBe(true);
      const got = await render(page, 'webgl2', name);
      expect(got.backend).toBe('webgl2');
      expect(within(compare(name, 'webgl2', got)), `webgl2 ${name}`).toBe(true);
    });
  }

  test('control: the legacy shader hooks on WebGPURenderer miss the references', async ({ page }) => {
    test.skip(project() !== 'default', 'one backend is enough for the control');
    test.setTimeout(180_000);
    for (const name of CONTROL_CASES) {
      const got = await render(page, 'webgl2', name, true);
      expect(within(compare(name, 'control', got)), `control ${name} should differ`).toBe(false);
    }
  });
}
