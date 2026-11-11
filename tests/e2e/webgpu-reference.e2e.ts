/**
 * WebGPU against frozen reference images: the environment and post stack and the shader families drawn in
 * neutral test scenes (`webgpu-reference/env/harness.ts`, `webgpu-reference/shader/harness.ts`) through the real
 * three-adapter code, compared pixel by pixel with the references in their `refs/` folders. WebGL 2 is a
 * fallback with its own smoke test (`webgl2-smoke.e2e.ts`); this file draws WebGPU only, so a change to a sky
 * mode, fog, shadows, tone mapping, a post effect or a shader family's nodes shows here as a picture that moved.
 *
 * The references are the WebGL pictures the archived WebGLRenderer path drew before the port to WebGPURenderer
 * (`archive/webgl-renderer-17/`); WebGPU has matched them since, so they are kept frozen as the contract rather
 * than redrawn from today's WebGPU frames (a reference taken from the code under test would pass whatever it
 * draws). Three were redrawn on purpose when the look changed, from WebGPURenderer's WebGL 2 backend: `bloom.png`
 * (bloom compares its threshold with the exposed colour and glows with only the part above it, a soft knee, where
 * the old pass glowed with the whole colour) and `tone-aces.png` / `tone-neutral.png` (exposure 1.3 / 0.8, no
 * post: exposure now applies to the colour sky, which the old renderer left unexposed). The env harness pins the
 * quality level they are drawn at (its `REFERENCE_LEVEL`: the highest without contact shadows and reflections,
 * which the old stack never drew).
 *
 * Every post case must also differ from its plain picture by more than its own rule (a rule loose enough to pass
 * a missing effect would show), and the shader control draws the families without their own nodes and must miss
 * (the references tell a missing node). The rules: `parity.ts` `STRICT` for what three ports one to one, a looser,
 * block-averaged rule for the effects whose node pass is another algorithm (`TOLERANCE`). Behaviour the
 * references cannot tell (ambient occlusion only on indirect light, a turned sky, bloom against exposure,
 * exposure without post, height fog) is checked on the same scene by sampled pixels.
 *
 * On a GPU host the default project draws WebGPU; without one, the `webgpu` project runs this file on Dawn's
 * SwiftShader adapter (playwright.config.mts `WEBGPU_SPECS`) and the default project (no WebGPU adapter) skips it.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { expect, test, type Page } from './pw';

import { gpuAvailable } from './browser-env.mjs';
import { diff, diffPng, serveHarness, show, STRICT, within, type Diff, type Tolerance } from './parity';
import { decodePng, type Image } from './png';

const HERE = resolve(import.meta.dirname, 'webgpu-reference');
const REPO = resolve(import.meta.dirname, '..', '..');
const BACKEND = 'webgpu';

test.skip(() => test.info().project.name === 'default' && !gpuAvailable(), 'no WebGPU adapter in the default project without a GPU: the webgpu project runs this file');

interface Harness {
  base: string;
  close: () => Promise<void>;
}
let env: Harness | null = null;
let shader: Harness | null = null;
test.beforeAll(async () => {
  env = await serveHarness(join(HERE, 'env', 'harness.ts'), REPO, ENV_W, ENV_H);
  shader = await serveHarness(join(HERE, 'shader', 'harness.ts'), REPO, SHADER_SIZE, SHADER_SIZE);
});
test.afterAll(async () => {
  await env?.close();
  await shader?.close();
});

/** Keeps a miss's picture and its difference beside the test output. */
function keepMiss(name: string, png: Buffer, got: Image, ref: Image, badDelta: number): void {
  const out = test.info().outputPath();
  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, `${name}.png`), png);
  writeFileSync(join(out, `${name}-diff.png`), diffPng(got, ref, badDelta));
}

// ---- environment and post ------------------------------------------------------------------------------------

const ENV_W = 320;
const ENV_H = 240;
const ENV_REFS = join(HERE, 'env', 'refs');

const ENV_CASES = [
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
type EnvCase = (typeof ENV_CASES)[number];

/** Cases that add an effect to a plain picture (same scene and sky): the render must not pass for that picture. */
const PLAIN: Partial<Record<EnvCase, EnvCase>> = {
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
 * The looser rules (default: STRICT):
 * - scene fog: node materials mix the fog in linear light before the frame's tone mapping; the reference's
 *   renderer mixed it after tone mapping and sRGB encoding, so the tint differs by one tone-mapping step
 *   (measured: mean 2.0–2.9, at most 2.5 % of pixels off by more than 32);
 * - ambient occlusion (the reference denoised with a Poisson pass, the node has no denoise and another noise)
 *   and depth of field (a linear blur ramp against near/far fields with a smoothstep circle of confusion):
 *   compared on 4 × 4 block means, where noise and kernel shape average out and where and how strong stays.
 * Each still rejects its plain picture by a wide margin (`PLAIN`).
 */
const FOG: Tolerance = { mean: 4.5, badDelta: 32, bad: 0.04 };
const TOLERANCE: Partial<Record<EnvCase, Tolerance>> = {
  'fog-linear': FOG,
  'fog-exp2': FOG,
  ssao: { mean: 3, badDelta: 24, bad: 0.03, block: 4 },
  dof: { mean: 3, badDelta: 24, bad: 0.08, block: 4 },
};
const tolerance = (name: EnvCase): Tolerance => TOLERANCE[name] ?? STRICT;

/** Each case's post passes (the reference stack's pass list); no entry: no post stack. */
const PASSES: Partial<Record<EnvCase, string[]>> = {
  'fog-volume': ['render', 'fogVolumes', 'output'],
  grading: ['render', 'output', 'grading'],
  lut: ['render', 'output', 'grading'],
  bloom: ['render', 'bloom', 'output'],
  ssao: ['render', 'ssao', 'output'],
  dof: ['render', 'dof', 'output'],
  smaa: ['render', 'output', 'smaa'],
  fxaa: ['render', 'output', 'fxaa'],
};

interface EnvShot {
  img: Image;
  png: Buffer;
  backend: string;
  passes: string[];
  fallback: string | null;
}
async function envShot(page: Page, name: string, query = ''): Promise<EnvShot> {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.setViewportSize({ width: ENV_W, height: ENV_H });
  await page.goto(`${env!.base}?backend=${BACKEND}&case=${name}${query}`);
  await expect.poll(() => page.evaluate(() => (window as unknown as { __envCase?: unknown }).__envCase !== undefined), { timeout: 60_000 }).toBe(true);
  const result = await page.evaluate(() => (window as unknown as { __envCase: { ok: boolean; backend?: string; error?: string; passes?: string[]; fallback?: string | null } }).__envCase);
  expect(result.ok, result.error).toBe(true);
  expect(errors).toEqual([]);
  expect(result.backend).toBe(BACKEND);
  const png = await page.locator('canvas').screenshot();
  return { img: decodePng(png), png, backend: result.backend ?? '', passes: result.passes ?? [], fallback: result.fallback ?? null };
}
const envRef = (name: string): Image => decodePng(readFileSync(join(ENV_REFS, `${name}.png`)));

for (const name of ENV_CASES) {
  test(`${name}: WebGPU matches the environment reference`, async ({ page }) => {
    test.setTimeout(150_000);
    const got = await envShot(page, name);
    expect(got.fallback).toBeNull();
    expect(got.passes).toEqual(PASSES[name] ?? []);
    const t = tolerance(name);
    const plain = PLAIN[name];
    if (plain !== undefined) {
      const p = diff(got.img, envRef(plain), t);
      console.log(`[webgpu-reference] ${name} vs plain ${plain}: ${show(p, t)}`);
      expect(within(p, t), `${name}: the effect must show (differ from the plain picture)`).toBe(false);
    }
    const d: Diff = diff(got.img, envRef(name), t);
    console.log(`[webgpu-reference] ${name}: ${show(d, t)} passes=${got.passes.join(',')}`);
    if (!within(d, t)) keepMiss(`env-${name}`, got.png, got.img, envRef(name), t.badDelta);
    expect(within(d, t), `${name}: ${show(d, t)}`).toBe(true);
  });
}

/** Mean of a 5 × 5 patch's grey level. */
const lum5 = (img: Image, [x, y]: readonly [number, number]): number => {
  let s = 0;
  for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) s += img.pixel(x + dx, y + dy).slice(0, 3).reduce((a, b) => a + b, 0) / 3;
  return s / 25;
};
/** Mean r, g, b of a 5 × 5 patch. */
const patch5 = (img: Image, [x, y]: readonly [number, number]): number[] => {
  const sum = [0, 0, 0];
  for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) img.pixel(x + dx, y + dy).slice(0, 3).forEach((v, i) => (sum[i]! += v));
  return sum.map((v) => v / 25);
};
const linear = (v: number): number => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
const srgb = (v: number): number => (v <= 0.0031308 ? v * 12.92 : 1.055 * v ** (1 / 2.4) - 0.055);

/**
 * Ambient occlusion darkens only the indirect light: under the sphere and at the boxes' feet the ambient-only
 * scene darkens a lot with SSAO and GTAO, the sunlit scene only by the ambient light's share; open ground does
 * not change. The `ssao` reference matches within its loose rule; this is what the rule cannot tell.
 */
test('ambient occlusion darkens the indirect light, not the sun', async ({ page }) => {
  test.setTimeout(150_000);
  // The history the lit programs sample must stay a live texture (a destroyed one reads as no occlusion).
  const gpuErrors: string[] = [];
  page.on('console', (m) => {
    if (/GPUValidationError|deleted object|Destroyed texture/i.test(m.text())) gpuErrors.push(m.text().slice(0, 200));
  });
  const shot = async (ao: string, light: string): Promise<Image> => {
    const got = await envShot(page, 'ssao', `&ao=${ao}&light=${light}`);
    if (ao !== 'off') expect(got.passes).toContain(ao);
    return got.img;
  };
  // Under the sphere, at the grey box's foot, open ground (screen points of the 320 × 240 view).
  const crease: [number, number][] = [
    [165, 180],
    [150, 180],
    [95, 176],
  ];
  const open: [number, number] = [40, 200];
  for (const light of ['ambient', 'sun']) {
    const off = await shot('off', light);
    for (const ao of ['ssao', 'gtao']) {
      const on = await shot(ao, light);
      const ratios = crease.map((p) => lum5(on, p) / lum5(off, p));
      const darkest = Math.min(...ratios);
      console.log(`[webgpu-reference] ${ao} ${light}: crease ratios ${ratios.map((r) => r.toFixed(2)).join(' ')}, open ${lum5(off, open).toFixed(1)} → ${lum5(on, open).toFixed(1)}`);
      expect(Math.abs(lum5(on, open) - lum5(off, open))).toBeLessThan(2);
      // Only indirect light: the creases darken clearly. With the sun: hardly (the sun is most of their light).
      if (light === 'ambient') expect(darkest).toBeLessThan(0.85);
      else expect(darkest).toBeGreaterThan(0.93);
    }
  }
  expect(gpuErrors).toEqual([]);
});

/**
 * A turned texture sky turns its background and its image-based lighting alike. The `sky-texture` equirect has a
 * red marker at its middle column (world +X unturned): the mirror sphere shows it on its right. +90° about +Y
 * takes it to −Z, the view direction (the background above the middle pillar, not the sphere); −90° to +Z,
 * towards the camera (the sphere's middle, not the background). Background and reflection turning opposite ways
 * would show the marker in both places or in neither.
 */
test('a turned sky turns its background and its reflections alike', async ({ page }) => {
  test.setTimeout(150_000);
  /** The most marker-red 3 × 3 mean in a box (red over the other channels). */
  const redness = (img: Image, x0: number, y0: number, x1: number, y1: number): number => {
    let best = -255;
    for (let y = y0 + 1; y < y1 - 1; y++) {
      for (let x = x0 + 1; x < x1 - 1; x++) {
        let r = 0;
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
          const p = img.pixel(x + dx, y + dy);
          r += p[0]! - (p[1]! + p[2]!) / 2;
        }
        best = Math.max(best, r / 9);
      }
    }
    return best;
  };
  const background = (img: Image): number => redness(img, 140, 20, 180, 72);
  const sphereRight = (img: Image): number => redness(img, 172, 130, 194, 160);
  const sphereMiddle = (img: Image): number => redness(img, 150, 132, 180, 162);
  const [plain, left, right] = [(await envShot(page, 'sky-texture', '&skyRotation=0')).img, (await envShot(page, 'sky-texture', '&skyRotation=90')).img, (await envShot(page, 'sky-texture', '&skyRotation=-90')).img];
  const rows = [plain, left, right].map((img) => [background(img), sphereRight(img), sphereMiddle(img)].map((v) => v.toFixed(0)).join('/'));
  console.log(`[webgpu-reference] sky rotation 0 / 90 / -90 (background/sphere right/sphere middle redness): ${rows.join('  ')}`);
  expect(background(plain)).toBeLessThan(40);
  expect(sphereRight(plain)).toBeGreaterThan(80);
  expect(background(left)).toBeGreaterThan(80);
  expect(sphereRight(left)).toBeLessThan(40);
  expect(sphereMiddle(left)).toBeLessThan(40);
  expect(background(right)).toBeLessThan(40);
  expect(sphereMiddle(right)).toBeGreaterThan(80);
});

/**
 * Bloom follows exposure: its threshold is compared with the exposed colour. A sky about 1.6 times the threshold
 * blooms at exposure 1 (the sky band above the pillars differs from the same passes at strength 0); at exposure
 * 0.3 the sky is under the soft knee and draws as at strength 0. Bloom compared before exposure would glow over
 * the sky at both exposures alike.
 */
test('bloom follows exposure: a bright sky over the threshold blooms, the same sky exposed lower does not', async ({ page }) => {
  test.setTimeout(150_000);
  const bright = { on: await envShot(page, 'bloom-sky', '&exposure=1'), off: await envShot(page, 'bloom-sky', '&exposure=1&bloom=none') };
  const dim = { on: await envShot(page, 'bloom-sky', '&exposure=0.3'), off: await envShot(page, 'bloom-sky', '&exposure=0.3&bloom=none') };
  expect(bright.on.passes).toContain('bloom');
  expect(dim.on.passes).toContain('bloom');
  /** Mean and largest |difference| (0–255, over r, g, b) in the sky band above the pillars. */
  const skyDiff = (a: Image, b: Image): { mean: number; worst: number } => {
    let sum = 0;
    let worst = 0;
    let n = 0;
    for (let y = 2; y < 56; y++) {
      for (let x = 2; x < ENV_W - 2; x++) {
        const p = a.pixel(x, y);
        const r = b.pixel(x, y);
        const d = (Math.abs(p[0]! - r[0]!) + Math.abs(p[1]! - r[1]!) + Math.abs(p[2]! - r[2]!)) / 3;
        sum += d;
        worst = Math.max(worst, d);
        n += 1;
      }
    }
    return { mean: sum / n, worst };
  };
  const glow = skyDiff(bright.on.img, bright.off.img);
  const calm = skyDiff(dim.on.img, dim.off.img);
  console.log(`[webgpu-reference] bloom-sky against strength 0: exposure 1 mean ${glow.mean.toFixed(2)} worst ${glow.worst.toFixed(0)}; exposure 0.3 mean ${calm.mean.toFixed(2)} worst ${calm.worst.toFixed(0)}`);
  expect(glow.mean, 'at exposure 1 the sky blooms').toBeGreaterThan(20);
  expect(calm.mean, 'at exposure 0.3 the sky is under the threshold: no glow').toBeLessThan(1);
  expect(calm.worst).toBeLessThan(8);
});

/**
 * Exposure applies to the whole picture, sky included, without a post stack too: at 0.5 the colour sky and the lit
 * ground both darken, the sky (not tone mapped) to half its linear value. With tone mapping none three skips its
 * exposure without a curve, so `none` is drawn as the linear curve: sky and ground at half their linear value.
 */
test('exposure without post effects (and with tone mapping none) darkens the sky and the ground alike', async ({ page }) => {
  test.setTimeout(150_000);
  const full = await envShot(page, 'sky-color');
  const half = await envShot(page, 'sky-color', '&exposure=0.5');
  expect(half.passes).toEqual([]);
  const sky: [number, number] = [ENV_W - 12, 8];
  const ground: [number, number] = [40, 200];
  const s = { full: patch5(full.img, sky), half: patch5(half.img, sky) };
  const g = { full: lum5(full.img, ground), half: lum5(half.img, ground) };
  console.log(`[webgpu-reference] exposure 1 → 0.5, no post: sky ${s.full.map((v) => v.toFixed(0)).join(',')} → ${s.half.map((v) => v.toFixed(0)).join(',')}, ground ${g.full.toFixed(1)} → ${g.half.toFixed(1)}`);
  s.full.forEach((v, i) => expect(Math.abs(s.half[i]! - 255 * srgb(linear(v / 255) * 0.5)), `sky channel ${i}: half its linear value`).toBeLessThan(3));
  expect(g.half, 'the ground darkens').toBeLessThan(g.full * 0.85);
  const flat = { full: await envShot(page, 'tone-none'), half: await envShot(page, 'tone-none', '&exposure=0.5') };
  expect(flat.half.passes).toEqual([]);
  for (const [name, at] of [['sky', sky], ['ground', ground]] as const) {
    const [a, b] = [patch5(flat.full.img, at), patch5(flat.half.img, at)];
    console.log(`[webgpu-reference] tone mapping none, exposure 1 → 0.5: ${name} ${a.map((v) => v.toFixed(0)).join(',')} → ${b.map((v) => v.toFixed(0)).join(',')}`);
    a.forEach((v, i) => expect(Math.abs(b[i]! - 255 * srgb(linear(v / 255) * 0.5)), `tone none, ${name} channel ${i}: half its linear value`).toBeLessThan(3));
  }
});

/**
 * Exponential height fog (no reference: the reference renderer had none), against the plain picture: the far
 * pillars take more of its red than the near boxes, their feet more than their tops (it thins with height), the
 * sky towards the horizon is its colour; from a start distance the near objects are as without fog while the far
 * pillars are fogged.
 */
test('height fog: thick far off and low down, a start distance, the horizon in its colour', async ({ page }) => {
  test.setTimeout(150_000);
  const plain = await envShot(page, 'sky-color');
  const fog = await envShot(page, 'height-fog');
  const started = await envShot(page, 'height-fog-start');
  /** Redness (r − b) of a 5 × 5 patch, minus the plain picture's there. */
  const red = (img: Image, [x, y]: readonly [number, number]): number => {
    let s = 0;
    for (let dy = -2; dy <= 2; dy++) {
      for (let dx = -2; dx <= 2; dx++) {
        const a = img.pixel(x + dx, y + dy);
        const b = plain.img.pixel(x + dx, y + dy);
        s += a[0]! - a[2]! - (b[0]! - b[2]!);
      }
    }
    return s / 25;
  };
  const near: [number, number] = [70, 175];
  const farFoot: [number, number] = [ENV_W / 2, 118];
  const farTop: [number, number] = [ENV_W / 2, 92];
  const horizon: [number, number] = [ENV_W - 12, 110];
  const sky: [number, number] = [ENV_W - 12, 8];
  const f = { near: red(fog.img, near), farFoot: red(fog.img, farFoot), farTop: red(fog.img, farTop), horizon: red(fog.img, horizon), sky: red(fog.img, sky), startNear: red(started.img, near), startFar: red(started.img, farFoot) };
  console.log(`[webgpu-reference] height fog (redness over plain): ${JSON.stringify(f)}`);
  expect(f.farFoot, "the far pillar's foot more fogged than the near box").toBeGreaterThan(f.near + 30);
  expect(f.farFoot, "the far pillar's foot more fogged than its top").toBeGreaterThan(f.farTop + 15);
  expect(f.horizon, "the sky towards the horizon in the fog's red").toBeGreaterThan(150);
  expect(f.horizon, 'the sky up high clearer than at the horizon').toBeGreaterThan(f.sky + 30);
  expect(Math.abs(f.startNear), 'nearer than the start: as without fog').toBeLessThan(3);
  expect(f.startFar, 'past the start: fogged').toBeGreaterThan(30);
});

// ---- shader families -----------------------------------------------------------------------------------------

const SHADER_SIZE = 256;
const SHADER_REFS = join(HERE, 'shader', 'refs');
const SHADER_CASES = ['standard', 'foliage', 'kit', 'unlit', 'water', 'lightmap', 'highlight', 'look'] as const;
/** The shader types whose materials convert to graphs ("Convert to graph", the built-in templates). */
const GRAPH_CASES = ['standard', 'foliage', 'kit', 'unlit', 'water'] as const;
/** Cases whose shading needs its own nodes: without them they must miss their reference. */
const CONTROL_CASES = ['foliage', 'kit', 'water', 'lightmap'] as const;

async function shaderShot(page: Page, name: string, query = ''): Promise<{ img: Image; png: Buffer }> {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.setViewportSize({ width: SHADER_SIZE, height: SHADER_SIZE });
  await page.goto(`${shader!.base}?backend=${BACKEND}&case=${name}${query}`);
  await expect.poll(() => page.evaluate(() => (window as unknown as { __shaderCase?: unknown }).__shaderCase !== undefined), { timeout: 45_000 }).toBe(true);
  const result = await page.evaluate(() => (window as unknown as { __shaderCase: { ok: boolean; backend?: string; error?: string } }).__shaderCase);
  expect(result.ok, result.error).toBe(true);
  expect(errors).toEqual([]);
  expect(result.backend).toBe(BACKEND);
  const png = await page.locator('canvas').screenshot();
  return { img: decodePng(png), png };
}
const shaderRef = (name: string): Image => decodePng(readFileSync(join(SHADER_REFS, `${name}.png`)));

function shaderCompare(name: string, label: string, got: { img: Image; png: Buffer }): Diff {
  const d = diff(got.img, shaderRef(name));
  console.log(`[webgpu-reference] ${label} ${name}: ${show(d)}`);
  if (!within(d) && label !== 'control') keepMiss(`shader-${label}-${name}`, got.png, got.img, shaderRef(name), STRICT.badDelta);
  return d;
}

for (const name of SHADER_CASES) {
  test(`${name}: the node material on WebGPU matches the shader reference`, async ({ page }) => {
    test.setTimeout(120_000);
    expect(within(shaderCompare(name, 'material', await shaderShot(page, name))), name).toBe(true);
  });
}

for (const name of GRAPH_CASES) {
  test(`${name}: the material converted to a graph matches the shader reference on WebGPU`, async ({ page }) => {
    test.setTimeout(120_000);
    expect(within(shaderCompare(name, 'graph', await shaderShot(page, name, '&graph=1'))), `graph ${name}`).toBe(true);
  });
}

test('control: the shader cases without their own nodes miss the references', async ({ page }) => {
  test.setTimeout(180_000);
  for (const name of CONTROL_CASES) {
    expect(within(shaderCompare(name, 'control', await shaderShot(page, name, '&control=1'))), `control ${name} should differ`).toBe(false);
  }
});
