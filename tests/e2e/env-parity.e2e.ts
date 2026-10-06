/**
 * Environment and post parity. The sky modes (colour, physical,
 * gradient, texture equirect and cube, each with its image-based lighting),
 * fog (linear, exp2), fog volumes (with the height falloff), shadows
 * (and the follow-camera shadow: the light moved with its target between
 * frames, 200 m from the origin),
 * tone mapping (ACES, Neutral, none; AgX everywhere else), grading +
 * lift/gamma/gain + vignette, a LUT, bloom, ambient occlusion, depth of
 * field, SMAA, FXAA and a low quality level render in a neutral scene
 * (`env-parity/harness.ts`) and are compared with the WebGL reference images
 * captured from the WebGLRenderer path before the port (`env-parity/refs/*.png`).
 * That path is archived (`archive/webgl-renderer-17/`); the
 * references are frozen as the contract.
 *
 * - `default` project: WebGPURenderer's WebGL 2 backend (TSL sky/fog
 *   volumes/post) matches them, with the archived stack's pass list.
 * - `webgpu` project: WebGPU matches them.
 *
 * Tolerances (logged in docs/plan-phase-17.md): the strict rule for
 * everything three ports one to one; a looser, block-averaged rule for the
 * effects whose node pass is a different algorithm (see `TOLERANCE`). For
 * every post case the render must also differ from the plain picture by
 * more than its own rule (the rule cannot pass a missing effect).
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { expect, test, type Page } from './pw';

import { diff, diffPng, serveHarness, show, STRICT, within, type Diff, type Tolerance } from './parity';
import { decodePng, type Image } from './png';

const HERE = resolve(import.meta.dirname, 'env-parity');
const REFS = join(HERE, 'refs');
const REPO = resolve(import.meta.dirname, '..', '..');
const WIDTH = 320;
const HEIGHT = 240;

export const CASES = [
  'sky-color',
  'sky-procedural',
  'sky-gradient',
  'sky-texture',
  'sky-cube',
  'fog-linear',
  'fog-exp2',
  'fog-volume',
  'shadow',
  'shadow-follow',
  'tone-aces',
  'tone-neutral',
  'tone-none',
  'grading',
  'lut',
  'bloom',
  'ssao',
  'dof',
  'smaa',
  'fxaa',
  'quality-low',
] as const;
type CaseName = (typeof CASES)[number];

/**
 * Cases that add an effect to a plain picture (the reference named here, same
 * scene and sky): the render must not pass for that plain picture under its
 * own rule.
 */
const PLAIN: Partial<Record<CaseName, CaseName>> = {
  'fog-linear': 'sky-color',
  'fog-exp2': 'sky-gradient',
  'fog-volume': 'sky-color',
  shadow: 'sky-color',
  'shadow-follow': 'sky-color',
  'tone-aces': 'sky-color',
  'tone-neutral': 'sky-color',
  'tone-none': 'sky-color',
  grading: 'sky-color',
  lut: 'sky-color',
  bloom: 'sky-gradient',
  ssao: 'sky-color',
  dof: 'sky-color',
  smaa: 'sky-color',
  fxaa: 'sky-color',
};

/**
 * Per-case tolerance (default: the strict rule). The looser rules:
 * - scene fog: three's node materials mix the fog in linear light before the
 *   frame's tone mapping (as the legacy post stack does); the legacy renderer
 *   drawing straight to the canvas mixes it after tone mapping and sRGB
 *   encoding, so the fog tint differs by one tone-mapping step (measured:
 *   mean 2.0–2.9, ≤ 2.5 % of pixels off by more than 32);
 * - GTAO (the legacy GTAOPass denoises with a Poisson pass, the GTAONode has
 *   no denoise and another noise pattern) and depth of field (the legacy
 *   Bokeh gather with a linear blur ramp vs the node DOF's near/far fields,
 *   smoothstep CoC and Vogel-disc blur): compared on 4 × 4 block means
 *   (noise and kernel shape average out; where the effect is and how strong
 *   stays). Measured: AO mean 1.1, 0.02 % blocks > 24; DOF mean 1.75,
 *   4.2 % blocks > 24 (edges of half-blurred objects).
 * Every loose rule still rejects the plain picture by a wide margin (`PLAIN`).
 */
const FOG: Tolerance = { mean: 4.5, badDelta: 32, bad: 0.04 };
const TOLERANCE: Partial<Record<CaseName, Tolerance>> = {
  'fog-linear': FOG,
  'fog-exp2': FOG,
  ssao: { mean: 3, badDelta: 24, bad: 0.03, block: 4 },
  dof: { mean: 3, badDelta: 24, bad: 0.08, block: 4 },
};
const tolerance = (name: CaseName): Tolerance => TOLERANCE[name] ?? STRICT;

/**
 * The post passes of each case — the pass list the archived WebGL stack
 * reported for it (WebGL 2 is checked against it case by case); no entry:
 * no post stack (a plain frame).
 */
const PASSES: Partial<Record<CaseName, string[]>> = {
  'fog-volume': ['render', 'fogVolumes', 'output'],
  grading: ['render', 'output', 'grading'],
  lut: ['render', 'output', 'grading'],
  bloom: ['render', 'bloom', 'output'],
  ssao: ['render', 'ssao', 'output'],
  dof: ['render', 'dof', 'output'],
  smaa: ['render', 'output', 'smaa'],
  fxaa: ['render', 'output', 'fxaa'],
};

let harness: { base: string; close: () => Promise<void> } | null = null;
test.beforeAll(async () => {
  harness = await serveHarness(join(HERE, 'harness.ts'), REPO, WIDTH, HEIGHT);
});
test.afterAll(async () => {
  await harness?.close();
});

interface Rendered {
  img: Image;
  png: Buffer;
  backend: string;
  passes: string[];
  fallback: string | null;
}
async function render(page: Page, backend: string, name: string): Promise<Rendered> {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.setViewportSize({ width: WIDTH, height: HEIGHT });
  await page.goto(`${harness!.base}?backend=${backend}&case=${name}`);
  await expect.poll(() => page.evaluate(() => (window as unknown as { __envCase?: unknown }).__envCase !== undefined), { timeout: 60_000 }).toBe(true);
  const result = await page.evaluate(() => (window as unknown as { __envCase: { ok: boolean; backend?: string; error?: string; passes?: string[]; fallback?: string | null } }).__envCase);
  expect(result.ok, result.error).toBe(true);
  expect(errors).toEqual([]);
  const png = await page.locator('canvas').screenshot();
  return { img: decodePng(png), png, backend: result.backend ?? '', passes: result.passes ?? [], fallback: result.fallback ?? null };
}

const reference = (name: string): Image => decodePng(readFileSync(join(REFS, `${name}.png`)));

function compare(name: CaseName, label: string, got: Rendered): Diff {
  const t = tolerance(name);
  const d = diff(got.img, reference(name), t);
  console.log(`[env-parity] ${label} ${name}: ${show(d, t)} passes=${got.passes.join(',')}${got.fallback !== null ? ` fallback=${got.fallback}` : ''}`);
  if (!within(d, t)) {
    const out = test.info().outputPath();
    mkdirSync(out, { recursive: true });
    writeFileSync(join(out, `${name}-${label}.png`), got.png);
    writeFileSync(join(out, `${name}-${label}-diff.png`), diffPng(got.img, reference(name), t.badDelta));
  }
  return d;
}

/** The render is not the plain picture under its own rule (the effect is there). */
function notPlain(name: CaseName, label: string, got: Rendered): void {
  const plain = PLAIN[name];
  if (plain === undefined) return;
  const t = tolerance(name);
  const d = diff(got.img, reference(plain), t);
  console.log(`[env-parity] ${label} ${name} vs plain ${plain}: ${show(d, t)}`);
  expect(within(d, t), `${label} ${name}: the effect must show (differ from the plain picture)`).toBe(false);
}

const project = (): string => test.info().project.name;

/**
 * Ambient occlusion darkens only the indirect light: under the sphere and at
 * the boxes' feet the ambient-only scene darkens a lot with SSAO and GTAO,
 * the sunlit scene only by the ambient light's share there; open ground does
 * not change. (The `ssao` parity case above still matches the archived
 * reference within its loose rule; this is what the rule cannot tell.)
 */
test('ambient occlusion darkens the indirect light, not the sun', async ({ page }) => {
  test.setTimeout(150_000);
  const backend = project() === 'webgpu' ? 'webgpu' : 'webgl2';
  // The history the lit programs sample must stay a live texture (a destroyed one reads as no occlusion).
  const gpuErrors: string[] = [];
  page.on('console', (m) => {
    if (/GPUValidationError|deleted object|Destroyed texture/i.test(m.text())) gpuErrors.push(m.text().slice(0, 200));
  });
  const shot = async (ao: string, light: string): Promise<Image> => {
    await page.setViewportSize({ width: WIDTH, height: HEIGHT });
    await page.goto(`${harness!.base}?backend=${backend}&case=ssao&ao=${ao}&light=${light}`);
    await expect.poll(() => page.evaluate(() => (window as unknown as { __envCase?: unknown }).__envCase !== undefined), { timeout: 60_000 }).toBe(true);
    const result = await page.evaluate(() => (window as unknown as { __envCase: { ok: boolean; error?: string; passes?: string[] } }).__envCase);
    expect(result.ok, result.error).toBe(true);
    if (ao !== 'off') expect(result.passes).toContain(ao);
    return decodePng(await page.locator('canvas').screenshot());
  };
  // Under the sphere, at the grey box's foot, open ground (screen points of the 320 × 240 harness view).
  const crease: [number, number][] = [
    [165, 180],
    [150, 180],
    [95, 176],
  ];
  const open: [number, number] = [40, 200];
  const lum = (img: Image, [x, y]: [number, number]): number => {
    let s = 0;
    for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) s += img.pixel(x + dx, y + dy).slice(0, 3).reduce((a, b) => a + b, 0) / 3;
    return s / 25;
  };
  for (const light of ['ambient', 'sun']) {
    const off = await shot('off', light);
    for (const ao of ['ssao', 'gtao']) {
      const on = await shot(ao, light);
      const ratios = crease.map((p) => lum(on, p) / lum(off, p));
      const darkest = Math.min(...ratios);
      console.log(`[env-parity] ${backend} ${ao} ${light}: crease ratios ${ratios.map((r) => r.toFixed(2)).join(' ')}, open ${lum(off, open).toFixed(1)} → ${lum(on, open).toFixed(1)}`);
      expect(Math.abs(lum(on, open) - lum(off, open))).toBeLessThan(2);
      // Only indirect light: the creases darken clearly. With the sun: hardly (the sun is most of their light).
      if (light === 'ambient') expect(darkest).toBeLessThan(0.85);
      else expect(darkest).toBeGreaterThan(0.93);
    }
  }
  expect(gpuErrors).toEqual([]);
});

/**
 * A turned texture sky turns its background and its image-based lighting
 * alike. The `sky-texture` equirect has a red marker at its middle column
 * (world +X unturned): the mirror sphere shows it on its right. A turn of
 * +90° about +Y takes +X to −Z, the view direction: the marker shows in the
 * background above the middle pillar and leaves the sphere; −90° takes it to
 * +Z, towards the camera: the sphere's middle reflects it, the background
 * does not. Background and reflection turning opposite ways would show the
 * marker in both places or in neither.
 */
test('a turned sky turns its background and its reflections alike', async ({ page }) => {
  test.setTimeout(150_000);
  const backend = project() === 'webgpu' ? 'webgpu' : 'webgl2';
  const shot = async (turn: number): Promise<Image> => {
    await page.setViewportSize({ width: WIDTH, height: HEIGHT });
    await page.goto(`${harness!.base}?backend=${backend}&case=sky-texture&skyRotation=${turn}`);
    await expect.poll(() => page.evaluate(() => (window as unknown as { __envCase?: unknown }).__envCase !== undefined), { timeout: 60_000 }).toBe(true);
    const result = await page.evaluate(() => (window as unknown as { __envCase: { ok: boolean; error?: string; backend?: string } }).__envCase);
    expect(result.ok, result.error).toBe(true);
    expect(result.backend).toBe(backend);
    const png = await page.locator('canvas').screenshot();
    const out = test.info().outputPath();
    mkdirSync(out, { recursive: true });
    writeFileSync(join(out, `sky-rotation-${turn}-${backend}.png`), png);
    return decodePng(png);
  };
  /** The most marker-red 3 × 3 mean in a box (red over the other channels). */
  const redness = (img: Image, x0: number, y0: number, x1: number, y1: number): number => {
    let best = -255;
    for (let y = y0 + 1; y < y1 - 1; y++) {
      for (let x = x0 + 1; x < x1 - 1; x++) {
        let r = 0;
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
          const p = img.pixel(x + dx, y + dy);
          r += p[0] - (p[1] + p[2]) / 2;
        }
        best = Math.max(best, r / 9);
      }
    }
    return best;
  };
  // The background above the middle pillar; the mirror sphere's right side and its middle (320 × 240 view).
  const background = (img: Image): number => redness(img, 140, 20, 180, 72);
  const sphereRight = (img: Image): number => redness(img, 172, 130, 194, 160);
  const sphereMiddle = (img: Image): number => redness(img, 150, 132, 180, 162);
  const plain = await shot(0);
  const left = await shot(90);
  const right = await shot(-90);
  const rows = [plain, left, right].map((img) => [background(img), sphereRight(img), sphereMiddle(img)].map((v) => v.toFixed(0)).join('/'));
  console.log(`[env-parity] ${backend} sky rotation 0 / 90 / -90 (background/sphere right/sphere middle redness): ${rows.join('  ')}`);
  expect(background(plain)).toBeLessThan(40);
  expect(sphereRight(plain)).toBeGreaterThan(80);
  expect(background(left)).toBeGreaterThan(80);
  expect(sphereRight(left)).toBeLessThan(40);
  expect(sphereMiddle(left)).toBeLessThan(40);
  expect(background(right)).toBeLessThan(40);
  expect(sphereMiddle(right)).toBeGreaterThan(80);
});

for (const name of CASES) {
  test(`${name}: WebGPURenderer matches the WebGL environment reference`, async ({ page }) => {
    test.setTimeout(150_000);
    const backend = project() === 'webgpu' ? 'webgpu' : 'webgl2';
    const got = await render(page, backend, name);
    expect(got.backend).toBe(backend);
    expect(got.fallback).toBeNull();
    // The same passes as the archived WebGL stack.
    expect(got.passes).toEqual(PASSES[name] ?? []);
    notPlain(name, backend, got);
    expect(within(compare(name, backend, got), tolerance(name)), `${backend} ${name}`).toBe(true);
  });
}
