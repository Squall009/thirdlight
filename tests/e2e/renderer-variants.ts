/**
 * Renderer variants for the renderer-sensitive specs. Each such test is
 * declared once per variant; a variant runs in one Playwright project.
 *
 * On a GPU host the product's renderer is the one tested: `auto` (no flag),
 * which takes WebGPU there. WebGL 2 is a fallback whose whole coverage is
 * `webgl2-smoke.e2e.ts`, so no spec repeats itself on it.
 *
 * Without a GPU (SwiftShader, no WebGPU adapter in `default`):
 *  - `default`: `auto` (it takes the WebGL 2 backend here) and `webgl2`
 *    (forced by `?renderer=webgl2`);
 *  - `webgpu` (headless WebGPU on SwiftShader): `webgpu` (forced by
 *    `?renderer=webgpu`).
 *
 * The flag goes on the editor URL (the editor passes it on to Play) and on
 * the export URL; every render canvas reports its backend in
 * `data-tl-renderer`, which the tests check so a variant cannot silently
 * fall back.
 */
import { expect, test, type Locator } from './pw';

import { gpuAvailable } from './browser-env.mjs';

/** The host's GPU is in use (then `default` has a real WebGPU adapter and `auto` takes it). */
const GPU = gpuAvailable();

export type RendererVariant = 'auto' | 'webgl2' | 'webgpu';
/**
 * Every backend: for tests whose subject is a backend-specific path — shader and material builds,
 * texture formats, uploads and transcodes, GPU readback, light, shadow and lightmap shading,
 * program and pipeline caches. On a GPU host only the product's renderer.
 */
export const RENDERER_VARIANTS: readonly RendererVariant[] = GPU ? ['auto'] : ['auto', 'webgl2', 'webgpu'];
/**
 * The product's own renderer once (WebGPU on a GPU, WebGL 2 without one; the `webgpu` project
 * repeats it where it runs the spec): for tests that draw through the renderer but whose subject
 * is not a backend path — scene logic, streaming decisions, budgets, timing, editor UI.
 */
export const PRODUCT_RENDERER_VARIANTS: readonly RendererVariant[] = GPU ? ['auto'] : ['auto', 'webgpu'];

/** Skip the running test unless `variant` belongs to the current project (`variants`: the test's own list). */
export function onlyInItsProject(variant: RendererVariant, variants: readonly RendererVariant[] = RENDERER_VARIANTS): void {
  const webgpuProject = test.info().project.name === 'webgpu';
  test.skip(webgpuProject ? variant !== 'webgpu' : variant === 'webgpu', `the ${variant} variant runs in the ${variant === 'webgpu' ? 'webgpu' : 'default'} project`);
  if (GPU) {
    // One renderer on a GPU: the product's (`auto` → WebGPU). A test that names the forced WebGL 2 variant
    // itself is skipped; webgl2-smoke.e2e.ts is the fallback's coverage.
    test.skip(variant === 'webgl2', 'WebGL 2 is covered by webgl2-smoke.e2e.ts only');
  } else {
    // Gate speed: on a host without a WebGPU adapter `auto` takes the same WebGL 2
    // path as the `webgl2` variant, so it would repeat it step for step (~6 min per full run).
    // `renderer.e2e.ts` still covers the `auto` default itself.
    // A test without a webgl2 variant keeps `auto`: it is that test's WebGL 2 run here.
    test.skip(!webgpuProject && variant === 'auto' && variants.includes('webgl2'), 'auto = webgl2 on this host');
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
