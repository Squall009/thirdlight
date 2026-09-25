/**
 * Phase 20.2: the effect executors (harness `effects-gpu/harness.ts`, the
 * real three-adapter player and executors):
 *
 * - `webgpu` project: the WebGPU compute executor and the CPU reference agree
 *   particle by particle on neutral graphs covering every GPU block and value
 *   node (the same particles are alive, positions, colours and sizes within
 *   float precision) — the GPU buffers are read back;
 * - both projects: the player draws billboards (additive magenta, alpha
 *   green) on the executor of its backend (`cpu` on WebGL 2, `webgpu` on
 *   WebGPU), reports the executor, caps and an unknown effect.
 */
import { join, resolve } from 'node:path';

import { expect, test, type Page } from '@playwright/test';

import { serveHarness } from './parity';
import { decodePng, type Image } from './png';

const HERE = resolve(import.meta.dirname, 'effects-gpu');
const REPO = resolve(import.meta.dirname, '..', '..');
const W = 320;
const H = 240;

let harness: { base: string; close: () => Promise<void> } | null = null;
test.beforeAll(async () => {
  harness = await serveHarness(join(HERE, 'harness.ts'), REPO, W, H);
});
test.afterAll(async () => {
  await harness?.close();
});

const isWebGPU = (): boolean => test.info().project.name === 'webgpu';

async function run(page: Page, name: string, backend: string): Promise<{ result: Record<string, unknown>; errors: string[] }> {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  await page.setViewportSize({ width: W, height: H });
  await page.goto(`${harness!.base}?backend=${backend}&case=${name}`);
  await expect.poll(() => page.evaluate(() => (window as unknown as { __fx?: unknown }).__fx !== undefined), { timeout: 120_000 }).toBe(true);
  const result = await page.evaluate(() => (window as unknown as { __fx: Record<string, unknown> }).__fx);
  expect(result['ok'], String(result['error'])).toBe(true);
  return { result, errors };
}

interface ParityRow {
  name: string;
  cpu: number;
  gpu: number;
  matched: number;
  within: number;
  maxPosError: number;
  meanPosError: number;
  maxColorError: number;
  maxSizeError: number;
}

test('WebGPU compute and the CPU reference agree particle by particle', async ({ page }) => {
  test.skip(!isWebGPU(), 'WebGPU only (the webgpu project)');
  test.setTimeout(240_000);
  const { result, errors } = await run(page, 'parity', 'webgpu');
  expect(result['backend']).toBe('webgpu');
  expect(errors).toEqual([]);
  const rows = result['cases'] as ParityRow[];
  console.log(`[effects-gpu] parity ${JSON.stringify(rows)}`);
  expect(rows.length).toBe(4);
  for (const r of rows) {
    expect(r.cpu, r.name).toBeGreaterThan(20);
    // The same particles are alive (a kill or collision right at a threshold may differ by float rounding).
    expect(Math.abs(r.gpu - r.cpu), r.name).toBeLessThanOrEqual(Math.max(2, 0.02 * r.cpu));
    expect(r.matched, r.name).toBeGreaterThanOrEqual(0.98 * r.cpu);
    // Positions: within 1 cm for nearly all of them, the mean far below.
    expect(r.within, r.name).toBeGreaterThanOrEqual(0.97 * r.matched);
    expect(r.meanPosError, r.name).toBeLessThan(5e-3);
    expect(r.maxColorError, r.name).toBeLessThan(1e-3);
    expect(r.maxSizeError, r.name).toBeLessThan(1e-3);
  }
});

function count(img: Image, x0: number, x1: number, test: (r: number, g: number, b: number) => boolean): number {
  let n = 0;
  for (let y = 0; y < img.height; y++) for (let x = x0; x < x1; x++) {
    const [r, g, b] = img.pixel(x, y);
    if (test(r, g, b)) n += 1;
  }
  return n;
}
const magenta = (r: number, g: number, b: number): boolean => r > 120 && b > 120 && g < 0.5 * r;
const green = (r: number, g: number, b: number): boolean => g > 100 && g > 2 * r && g > 1.5 * b;

test('the player draws additive and alpha billboards on its backend\'s executor', async ({ page }) => {
  test.setTimeout(180_000);
  const backend = isWebGPU() ? 'webgpu' : 'webgl2';
  const { result, errors } = await run(page, 'render', backend);
  expect(errors).toEqual([]);
  expect(result['backend']).toBe(backend);
  const d = result['diagnostics'] as { executor: string; playing: number; particles: number; caps: { particlesPerSystem: number }; unknownEffects: string[]; instances: { executor: string }[] };
  console.log(`[effects-gpu] render ${backend} ${JSON.stringify(d)}`);
  expect(d.executor).toBe(isWebGPU() ? 'webgpu' : 'cpu');
  expect(d.instances.map((i) => i.executor)).toEqual(isWebGPU() ? ['webgpu', 'webgpu'] : ['cpu', 'cpu']);
  expect(d.caps.particlesPerSystem).toBe(isWebGPU() ? 262_144 : 4_096);
  expect(d.playing).toBe(2);
  expect(d.particles).toBe(500);
  expect(d.unknownEffects).toEqual(['missing']);
  const img = decodePng(await page.locator('canvas').screenshot());
  const m = count(img, 0, W / 2, magenta);
  const g = count(img, W / 2, W, green);
  console.log(`[effects-gpu] render ${backend} magenta ${m} green ${g}`);
  expect(m).toBeGreaterThan(800);
  expect(g).toBeGreaterThan(800);
  // Nothing of either on the other side.
  expect(count(img, W / 2, W, magenta)).toBeLessThan(20);
  expect(count(img, 0, W / 2, green)).toBeLessThan(20);
});
