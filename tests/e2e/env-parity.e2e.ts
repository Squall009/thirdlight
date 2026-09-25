/**
 * Phase 17.3: environment and post parity. The sky modes (colour, physical,
 * gradient, texture equirect and cube, each with its image-based lighting),
 * fog (linear, exp2), fog volumes (with the 14.4 height falloff), shadows
 * (and the follow-camera shadow: the light moved with its target between
 * frames, 200 m from the origin),
 * tone mapping (ACES, Neutral, none; AgX everywhere else), grading +
 * lift/gamma/gain + vignette, a LUT, bloom, ambient occlusion, depth of
 * field, SMAA, FXAA and a low quality level render in a neutral scene
 * (`env-parity/harness.ts`) and are compared with the WebGL reference images
 * captured from the WebGLRenderer path before the port (`env-parity/refs/*.png`).
 * Phase 17.4: that path is archived (`archive/webgl-renderer-17/`); the
 * references are frozen as the contract.
 *
 * - `default` project: WebGPURenderer's WebGL 2 backend (TSL sky/fog
 *   volumes/post) matches them, with the archived stack's pass list.
 * - `webgpu` project: WebGPU matches them.
 *
 * Tolerances (logged in docs/plan-phase-17.md §6, 17.3): the 17.2 rule for
 * everything three ports one to one; a looser, block-averaged rule for the
 * effects whose node pass is a different algorithm (see `TOLERANCE`). For
 * every post case the render must also differ from the plain picture by
 * more than its own rule (the rule cannot pass a missing effect).
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { expect, test, type Page } from '@playwright/test';

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
 * Per-case tolerance (default: the 17.2 rule). The looser rules (§6, 17.3):
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
 * reported for it (17.3 checked WebGL 2 against it case by case); no entry:
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
