/**
 * Phase 17.2: shader parity. Each shader type of the project material
 * library (standard, foliage wind, kit world-X UV + macro normal, unlit,
 * water), lightmaps (UV1, range scaling, no-ambient) and the per-mesh looks
 * (selection highlight, checkpoint glow) render in a neutral test scene
 * (`shader-parity/harness.ts`) and are compared with the WebGL reference
 * images captured from the WebGLRenderer path before the port
 * (`shader-parity/refs/*.png`). Phase 17.4: that path is archived
 * (`archive/webgl-renderer-17/`, with its capture script): the references
 * are frozen as the contract.
 *
 * - `default` project: the node materials on WebGPURenderer's WebGL 2
 *   backend match them (forced `webgl2`, and `auto`, which takes WebGL 2
 *   here: no WebGPU adapter in this project).
 * - `webgpu` project: the node materials on WebGPU match them.
 * - A control: the cases without their shader nodes (what WebGPURenderer drew
 *   while the archived hooks were ignored) do NOT match.
 *
 * The tolerance rule is logged in docs/plan-phase-17.md §6 (17.2).
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { expect, test, type Page } from '@playwright/test';

import { diff, diffPng, serveHarness, show, within, type Diff } from './parity';
import { decodePng, type Image } from './png';

const HERE = resolve(import.meta.dirname, 'shader-parity');
const REFS = join(HERE, 'refs');
const REPO = resolve(import.meta.dirname, '..', '..');
const SIZE = 256;

export const CASES = ['standard', 'foliage', 'kit', 'unlit', 'water', 'lightmap', 'highlight', 'checkpoint'] as const;
/** Cases whose shading needs its own nodes: without them they must fail the comparison. */
const CONTROL_CASES = ['foliage', 'kit', 'water', 'lightmap'] as const;

let harness: { base: string; close: () => Promise<void> } | null = null;
let base = '';
test.beforeAll(async () => {
  harness = await serveHarness(join(HERE, 'harness.ts'), REPO, SIZE, SIZE);
  base = harness.base;
});
test.afterAll(async () => {
  await harness?.close();
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

for (const name of CASES) {
  test(`${name}: node materials match the WebGL reference`, async ({ page }) => {
    test.setTimeout(120_000);
    if (project() === 'webgpu') {
      const got = await render(page, 'webgpu', name);
      expect(got.backend).toBe('webgpu');
      expect(within(compare(name, 'webgpu', got)), `webgpu ${name}`).toBe(true);
      // The default backend: auto takes WebGPU where an adapter and a device work.
      const auto = await render(page, 'auto', name);
      expect(auto.backend).toBe('webgpu');
      expect(within(compare(name, 'auto', auto)), `auto ${name}`).toBe(true);
      return;
    }
    const got = await render(page, 'webgl2', name);
    expect(got.backend).toBe('webgl2');
    expect(within(compare(name, 'webgl2', got)), `webgl2 ${name}`).toBe(true);
    // The default backend: auto takes WebGL 2 here (no WebGPU adapter in this project).
    const auto = await render(page, 'auto', name);
    expect(auto.backend).toBe('webgl2');
    expect(within(compare(name, 'auto', auto)), `auto ${name}`).toBe(true);
  });
}

test('control: the cases without their shader nodes miss the references', async ({ page }) => {
  test.skip(project() !== 'default', 'one backend is enough for the control');
  test.setTimeout(180_000);
  for (const name of CONTROL_CASES) {
    const got = await render(page, 'webgl2', name, true);
    expect(within(compare(name, 'control', got)), `control ${name} should differ`).toBe(false);
  }
});
