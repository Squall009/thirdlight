/**
 * Material graphs render on both backends (harness:
 * `material-graph-render/harness.ts`, through the real three-adapter
 * library and renderer factory).
 *
 * - every catalogue node kind compiles into a working shader (a sphere per
 *   kind, the node feeding the emissive and a vertex offset): no shader
 *   error, every sphere drawn;
 * - pixel checks of a representative subset: an unlit constant colour
 *   (exact), a nearest-sampled texture, a public parameter overridden on one
 *   object of a shared material (both colours, one material object), a
 *   fresnel emissive rim, a world-space vertex offset, and the PBR output's
 *   specular intensity: the sun's highlight on a black sphere at F0 0.024 is
 *   dimmer than at the default 0.04 and matches a GLB material carrying
 *   KHR_materials_specular 0.6.
 *
 * - Custom-lit outputs and the lighting inputs: N·L of the
 *   main light quantized into two bands (two tones on a sphere), the main
 *   light's shadow input (a caster's shadow on a wall), a point light in the
 *   accumulated diffuse light (a warm glow on one box), the main light's
 *   colour (the shadow-casting sun, not a brighter fill) and fog.
 *
 * `default` runs WebGL 2, `webgpu` runs WebGPU.
 */
import { resolve, join } from 'node:path';

import { expect, test, type Page } from './pw';

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

/** The brightest pixel (mean of the channels) within `r` of a point: a highlight's peak, wherever the raster puts it. */
const peak = (img: Image, p: [number, number], r: number): number => {
  let best = 0;
  for (let y = p[1] - r; y <= p[1] + r; y++) for (let x = p[0] - r; x <= p[0] + r; x++) {
    const c = img.pixel(x, y);
    best = Math.max(best, (c[0] + c[1] + c[2]) / 3);
  }
  return best;
};

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

test('specular: intensity 0.6 dims the highlight, as a GLB with KHR_materials_specular 0.6 draws it', async ({ page }) => {
  test.setTimeout(60_000);
  const { img, result, errors } = await render(page, 'specular');
  expect(errors).toEqual([]);
  // Only a connected port makes the physical material; intensity 0.6 dims the highlight (F0 0.024 vs 0.04), and a
  // GLB's own KHR_materials_specular 0.6 draws the same highlight as the graph mapping it.
  expect((result as unknown as { specMaterials: Record<string, string> }).specMaterials).toEqual({ specDefault: 'MeshStandardNodeMaterial', spec06: 'MeshPhysicalNodeMaterial', specGlb: 'MeshPhysicalMaterial' });
  const hl = { default: peak(img, result.probes['specDefault']!, 4), graph06: peak(img, result.probes['spec06']!, 4), glb06: peak(img, result.probes['specGlb']!, 4) };
  console.log(`[material-graph-render] ${backendOf()} specular peaks ${JSON.stringify(hl)}`);
  expect(hl.graph06, JSON.stringify(hl)).toBeGreaterThan(40);
  expect(hl.default, JSON.stringify(hl)).toBeGreaterThan(hl.graph06 + 15);
  expect(Math.abs(hl.glb06 - hl.graph06), JSON.stringify(hl)).toBeLessThanOrEqual(1);
});

test('custom-lit: N·L bands, the shadow input, a point light in the diffuse light, the main light, fog', async ({ page }) => {
  test.setTimeout(120_000);
  const { img, result, errors } = await render(page, 'lit');
  expect(errors).toEqual([]);
  const p = (k: string): [number, number, number] => px(img, result.probes[k]!);
  const log = Object.fromEntries(Object.keys(result.probes).map((k) => [k, p(k)]));
  console.log(`[material-graph-render] ${backendOf()} lit ${JSON.stringify(log)}`);
  const DARK = [0x30, 0x30, 0x30];
  const LIGHT = [0xd0, 0xd0, 0xd0];
  // Two bands on the sphere: the side towards the sun is light, the far side dark, and nothing else on it.
  expect(near(p('bandLit'), LIGHT, 3), JSON.stringify(p('bandLit'))).toBe(true);
  expect(near(p('bandDark'), DARK, 3), JSON.stringify(p('bandDark'))).toBe(true);
  const disc = (result as unknown as { disc: [number, number][] }).disc;
  const tones = disc.map((q) => px(img, q));
  const other = tones.filter((c) => !near(c, LIGHT, 3) && !near(c, DARK, 3));
  // Antialiasing is off; only pixels exactly on the band edge may differ.
  expect(other.length, JSON.stringify(other.slice(0, 5))).toBeLessThanOrEqual(Math.ceil(disc.length * 0.04));
  const lightN = tones.filter((c) => near(c, LIGHT, 3)).length;
  const darkN = tones.filter((c) => near(c, DARK, 3)).length;
  console.log(`[material-graph-render] ${backendOf()} bands: light ${lightN}, dark ${darkN}, other ${other.length} of ${disc.length}`);
  expect(lightN).toBeGreaterThan(disc.length * 0.2);
  expect(darkN).toBeGreaterThan(disc.length * 0.2);
  // The caster's shadow on the custom-lit wall reads 0 (dark); beside it 1 (light).
  expect(near(p('floorShadow'), DARK, 4), JSON.stringify(p('floorShadow'))).toBe(true);
  expect(near(p('floorLit'), LIGHT, 4), JSON.stringify(p('floorLit'))).toBe(true);
  // The warm point light brightens the box it sits in front of (the accumulated diffuse light), mostly in red.
  const glow = p('boxGlow');
  const plain = p('boxPlain');
  expect(glow[0], JSON.stringify([glow, plain])).toBeGreaterThan(plain[0] + 30);
  expect(glow[1], JSON.stringify([glow, plain])).toBeGreaterThan(plain[1] + 20);
  expect(glow[0] - plain[0], JSON.stringify([glow, plain])).toBeGreaterThan(glow[2] - plain[2]);
  // Without it the box is sun + ambient on the diffuse scale: (1.5 × 0.8 + 0.4) ÷ π = 0.51 linear → sRGB 189.
  expect(near(plain, [189, 189, 189], 4), JSON.stringify(plain)).toBe(true);
  // The main light is the shadow-casting sun, not the brighter pink fill: grey, sun colour × 1.5 ÷ π (linear 0.477 → sRGB 182).
  expect((result as unknown as { mainLight: number }).mainLight).toBe(0);
  expect(near(p('mainColour'), [182, 182, 182], 4), JSON.stringify(p('mainColour'))).toBe(true);
  // Ambient 0.4 / pi = 0.127 linear -> sRGB 100; the lightmap (linear 0.5 x intensity pi) / pi = 0.5 -> sRGB 188.
  expect(near(p('ambient'), [100, 100, 100], 4), JSON.stringify(p('ambient'))).toBe(true);
  expect(near(p('lightmap'), [188, 188, 188], 4), JSON.stringify(p('lightmap'))).toBe(true);
  // Fog still applies: the near copy is pure green, the far one mostly the fog's purple.
  expect(near(p('fogNear'), [0, 255, 0], 3), JSON.stringify(p('fogNear'))).toBe(true);
  const far = p('fogFar');
  expect(far[1], JSON.stringify(far)).toBeLessThan(120);
  expect(far[2], JSON.stringify(far)).toBeGreaterThan(120);
});

test('custom-lit without any light draws its graph with "no light" (diffuse 0, shadow 1)', async ({ page }) => {
  test.setTimeout(60_000);
  const { img, result, errors } = await render(page, 'dark');
  expect(errors).toEqual([]);
  const c = px(img, result.probes['dark']!);
  expect(near(c, [255, 128, 0], 2), JSON.stringify(c)).toBe(true);
});
