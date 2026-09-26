/**
 * Phase 17.2: renderer variants for the renderer-sensitive specs (materials,
 * textures, lightmaps, environment, lights, sky-texture, level-look). Each
 * such test is declared once per variant; a variant runs in one Playwright
 * project:
 *
 *  - `default` (WebGL 2 on SwiftShader, no WebGPU adapter): `auto` (the
 *    default since phase 17.4 — no flag; it takes the WebGL 2 backend here)
 *    and `webgl2` (forced by `?renderer=webgl2`);
 *  - `webgpu` (headless WebGPU): `webgpu` (forced by `?renderer=webgpu`).
 *
 * The flag goes on the editor URL (the editor passes it on to Play) and on
 * the export URL; every render canvas reports its backend in
 * `data-tl-renderer`, which the tests check so a variant cannot silently
 * fall back. (Phase 17.4: the `legacy` WebGLRenderer variant is archived.)
 */
import { expect, test, type Locator } from '@playwright/test';

export type RendererVariant = 'auto' | 'webgl2' | 'webgpu';
export const RENDERER_VARIANTS: readonly RendererVariant[] = ['auto', 'webgl2', 'webgpu'];

/** Skip the running test unless `variant` belongs to the current project. */
export function onlyInItsProject(variant: RendererVariant): void {
  const webgpuProject = test.info().project.name === 'webgpu';
  test.skip(webgpuProject ? variant !== 'webgpu' : variant === 'webgpu', `the ${variant} variant runs in the ${variant === 'webgpu' ? 'webgpu' : 'default'} project`);
  // Gate speed (2026-09-26): on a host without a WebGPU adapter `auto` takes the same WebGL 2
  // path as the `webgl2` variant, so it would repeat it step for step (~6 min per full run).
  // `renderer.e2e.ts` still covers the `auto` default itself; TL_E2E_ALL_VARIANTS=1 runs it here too.
  test.skip(!webgpuProject && variant === 'auto' && process.env['TL_E2E_ALL_VARIANTS'] !== '1', 'auto = webgl2 on this host (TL_E2E_ALL_VARIANTS=1 runs it)');
}

/** The editor URL with the variant's `?renderer=` flag (before the token fragment); `auto` is the default (no flag). */
export function editorUrlFor(url: string, variant: RendererVariant): string {
  return variant === 'auto' ? url : url.replace('#', `&renderer=${variant}#`);
}

/** The query string that forces the variant in a standalone export (`auto`: none, the default). */
export function exportQueryFor(variant: RendererVariant): string {
  return variant === 'auto' ? '' : `?renderer=${variant}`;
}

/** The backend a variant draws with in the running project (`auto` takes WebGL 2 in `default`, which has no WebGPU adapter). */
export function backendOf(variant: RendererVariant): 'webgl2' | 'webgpu' {
  if (variant === 'auto') return test.info().project.name === 'webgpu' ? 'webgpu' : 'webgl2';
  return variant;
}

/** The canvas draws with the variant's backend (ready, no fallback). */
export async function expectRendererBackend(canvas: Locator, variant: RendererVariant): Promise<void> {
  await expect.poll(() => canvas.evaluate((c) => `${c.getAttribute('data-tl-renderer')}/${c.getAttribute('data-tl-renderer-state')}`), { timeout: 30_000 }).toBe(`${backendOf(variant)}/ready`);
}
