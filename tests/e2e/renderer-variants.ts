/**
 * Renderer variants for the renderer-sensitive specs (materials,
 * textures, lightmaps, environment, lights, sky-texture, level-look). Each
 * such test is declared once per variant; a variant runs in one Playwright
 * project:
 *
 *  - `default` (WebGL 2 on SwiftShader, no WebGPU adapter): `auto` (the
 *    default — no flag; it takes the WebGL 2 backend here)
 *    and `webgl2` (forced by `?renderer=webgl2`);
 *  - `webgpu` (headless WebGPU): `webgpu` (forced by `?renderer=webgpu`).
 *
 * The flag goes on the editor URL (the editor passes it on to Play) and on
 * the export URL; every render canvas reports its backend in
 * `data-tl-renderer`, which the tests check so a variant cannot silently
 * fall back.
 */
import { expect, test, type Locator } from '@playwright/test';

import { gpuAvailable } from './browser-env.mjs';

/** The host's GPU is in use (then `default` has a real WebGPU adapter and `auto` takes it). */
const GPU = gpuAvailable();

export type RendererVariant = 'auto' | 'webgl2' | 'webgpu';
/**
 * Every backend: for tests whose subject is a backend-specific path — shader and material builds,
 * texture formats, uploads and transcodes, GPU readback, light, shadow and lightmap shading,
 * program and pipeline caches.
 */
export const RENDERER_VARIANTS: readonly RendererVariant[] = ['auto', 'webgl2', 'webgpu'];
/**
 * The product's own renderer once (WebGPU on a GPU, WebGL 2 without one; the `webgpu` project
 * repeats it where it runs the spec): for tests that draw through the renderer but whose subject
 * is not a backend path — scene logic, streaming decisions, budgets, timing, editor UI. The
 * forced WebGL 2 pass would repeat them step for step; the parity sweeps (env-parity,
 * shader-parity) compare the two backends' shading pixel for pixel.
 */
export const PRODUCT_RENDERER_VARIANTS: readonly RendererVariant[] = ['auto', 'webgpu'];

/** Skip the running test unless `variant` belongs to the current project (`variants`: the test's own list). */
export function onlyInItsProject(variant: RendererVariant, variants: readonly RendererVariant[] = RENDERER_VARIANTS): void {
  const webgpuProject = test.info().project.name === 'webgpu';
  test.skip(webgpuProject ? variant !== 'webgpu' : variant === 'webgpu', `the ${variant} variant runs in the ${variant === 'webgpu' ? 'webgpu' : 'default'} project`);
  const all = process.env['TL_E2E_ALL_VARIANTS'] === '1';
  if (GPU) {
    // The owner's choice: one pass by default — on a GPU `default` runs the product's own
    // renderer (`auto` → WebGPU); the forced WebGL 2 variant and the webgpu project repeat it
    // only for renderer/shader changes (TL_E2E_ALL_VARIANTS=1, the gate's --both-renderers).
    test.skip(!webgpuProject && variant === 'webgl2' && !all, 'one renderer pass on a GPU (TL_E2E_ALL_VARIANTS=1 adds the WebGL 2 variant)');
  } else {
    // Gate speed: on a host without a WebGPU adapter `auto` takes the same WebGL 2
    // path as the `webgl2` variant, so it would repeat it step for step (~6 min per full run).
    // `renderer.e2e.ts` still covers the `auto` default itself; TL_E2E_ALL_VARIANTS=1 runs it here too.
    // A test without a webgl2 variant keeps `auto`: it is that test's WebGL 2 run here.
    test.skip(!webgpuProject && variant === 'auto' && variants.includes('webgl2') && !all, 'auto = webgl2 on this host (TL_E2E_ALL_VARIANTS=1 runs it)');
  }
}

/** The editor URL with the variant's `?renderer=` flag (before the token fragment); `auto` is the default (no flag). */
export function editorUrlFor(url: string, variant: RendererVariant): string {
  return variant === 'auto' ? url : url.replace('#', `&renderer=${variant}#`);
}

/** The query string that forces the variant in a standalone export (`auto`: none, the default). */
export function exportQueryFor(variant: RendererVariant): string {
  return variant === 'auto' ? '' : `?renderer=${variant}`;
}

/** The backend a variant draws with in the running project (`auto` takes WebGPU on a GPU, WebGL 2 in `default` on SwiftShader). */
export function backendOf(variant: RendererVariant): 'webgl2' | 'webgpu' {
  if (variant === 'auto') return test.info().project.name === 'webgpu' || GPU ? 'webgpu' : 'webgl2';
  return variant;
}

/** The canvas draws with the variant's backend (ready, no fallback). */
export async function expectRendererBackend(canvas: Locator, variant: RendererVariant): Promise<void> {
  await expect.poll(() => canvas.evaluate((c) => `${c.getAttribute('data-tl-renderer')}/${c.getAttribute('data-tl-renderer-state')}`), { timeout: 30_000 }).toBe(`${backendOf(variant)}/ready`);
}
