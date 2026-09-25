/**
 * Phase 18.3: material graphs render on both backends (harness:
 * `material-graph-render/harness.ts`, through the real three-adapter
 * library and renderer factory).
 *
 * - every catalogue node kind compiles into a working shader (a sphere per
 *   kind, the node feeding the emissive and a vertex offset): no shader
 *   error, every sphere drawn;
 * - pixel checks of a representative subset: an unlit constant colour
 *   (exact), a nearest-sampled texture, a public parameter overridden on one
 *   object of a shared material (both colours, one material object), a
 *   fresnel emissive rim, a world-space vertex offset.
 *
 * `default` runs WebGL 2, `webgpu` runs WebGPU.
 */
import { resolve, join } from 'node:path';

import { expect, test, type Page } from '@playwright/test';

import { serveHarness } from './parity';
import { decodePng, type Image } from './png';

const HERE = resolve(import.meta.dirname, 'material-graph-render');
const REPO = resolve(import.meta.dirname, '..', '..');
const SIZE = 256;

let harness: { base: string; close: () => Promise<void> } | null = null;
test.beforeAll(async () => {
  harness = await serveHarness(join(HERE, 'harness.ts'), REPO, SIZE, SIZE);
});
test.afterAll(async () => {
  await harness?.close();
});

const backendOf = (): string => (test.info().project.name === 'webgpu' ? 'webgpu' : 'webgl2');

interface CaseResult {
  ok: boolean;
  backend?: string;
  error?: string;
  probes: Record<string, [number, number]>;
  kinds?: string[];
  problems?: Record<string, { severity: string; message: string }[] | null>;
  sharedMaterial?: boolean;
}

async function render(page: Page, name: string): Promise<{ img: Image; result: CaseResult; errors: string[] }> {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  await page.setViewportSize({ width: SIZE, height: SIZE });
  const backend = backendOf();
  await page.goto(`${harness!.base}?backend=${backend}&case=${name}`);
  await expect.poll(() => page.evaluate(() => (window as unknown as { __graphCase?: unknown }).__graphCase !== undefined), { timeout: 60_000 }).toBe(true);
  const result = await page.evaluate(() => (window as unknown as { __graphCase: CaseResult }).__graphCase);
  expect(result.ok, result.error).toBe(true);
  expect(result.backend).toBe(backend);
  const png = await page.locator('canvas').screenshot();
  return { img: decodePng(png), result, errors };
}

const px = (img: Image, p: [number, number]): [number, number, number] => {
  const c = img.pixel(p[0], p[1]);
  return [c[0], c[1], c[2]];
};
const near = (a: readonly number[], b: readonly number[], tol: number): boolean => a.every((x, i) => Math.abs(x - b[i]!) <= tol);
const BACKGROUND = [0x20, 0x24, 0x28];

test('every node kind compiles and draws', async ({ page }) => {
  test.setTimeout(180_000);
  const { img, result, errors } = await render(page, 'kinds');
  expect(errors).toEqual([]);
  const kinds = result.kinds ?? [];
  expect(kinds.length).toBeGreaterThan(50);
  const missing: string[] = [];
  for (const k of kinds) {
    const probs = (result.problems?.[k] ?? []).filter((p) => p.severity === 'error');
    expect(probs, k).toEqual([]);
    // The sphere is drawn (lit or glowing: not the background colour).
    if (near(px(img, result.probes[k]!), BACKGROUND, 3)) missing.push(k);
  }
  expect(missing).toEqual([]);
});

test('known values: constant, texture, per-object parameter, fresnel, vertex offset', async ({ page }) => {
  test.setTimeout(120_000);
  const { img, result, errors } = await render(page, 'values');
  expect(errors).toEqual([]);
  const p = (k: string): [number, number, number] => px(img, result.probes[k]!);
  const log = Object.fromEntries(Object.keys(result.probes).map((k) => [k, p(k)]));
  console.log(`[material-graph-render] ${backendOf()} ${JSON.stringify(log)}`);
  // Unlit constant colour (sRGB in, sRGB out).
  expect(near(p('color'), [255, 128, 0], 2), JSON.stringify(p('color'))).toBe(true);
  // Nearest-sampled 2 × 2 checker: two different texels, each one of the texture's colours.
  const texels = [[230, 40, 40], [40, 60, 230]];
  expect(texels.some((t) => near(p('texTL'), t, 3)), JSON.stringify(p('texTL'))).toBe(true);
  expect(texels.some((t) => near(p('texTR'), t, 3)), JSON.stringify(p('texTR'))).toBe(true);
  expect(near(p('texTL'), p('texTR'), 3)).toBe(false);
  // One shared material; the object's override wins only on that object.
  expect(result.sharedMaterial).toBe(true);
  expect(near(p('tintDefault'), [0, 255, 0], 2), JSON.stringify(p('tintDefault'))).toBe(true);
  expect(near(p('tintOverride'), [0, 0, 255], 2), JSON.stringify(p('tintOverride'))).toBe(true);
  // Fresnel emissive: dark face-on, bright at the silhouette.
  const lum = (c: readonly number[]): number => (c[0]! + c[1]! + c[2]!) / 3;
  expect(lum(p('rimCentre'))).toBeLessThan(40);
  expect(lum(p('rimEdge'))).toBeGreaterThan(lum(p('rimCentre')) + 60);
  // The lifted quad draws 1.2 m above its place, and not where its lower half was.
  expect(near(p('liftedAt'), [255, 255, 255], 3), JSON.stringify(p('liftedAt'))).toBe(true);
  expect(near(p('liftedFrom'), BACKGROUND, 3), JSON.stringify(p('liftedFrom'))).toBe(true);
});
