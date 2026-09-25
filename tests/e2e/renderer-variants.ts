/**
 * Phase 17.2: renderer variants for the renderer-sensitive specs (materials,
 * textures, lightmaps). Each such test is declared once per variant; a variant
 * runs in one Playwright project:
 *
 *  - `default` (WebGL 2 on SwiftShader, no WebGPU): `legacy` (today's
 *    WebGLRenderer, the default) and `webgl2` (WebGPURenderer's WebGL 2
 *    backend with node materials, forced by `?renderer=webgl2`);
 *  - `webgpu` (headless WebGPU): `webgpu` (forced by `?renderer=webgpu`).
 *
 * The flag goes on the editor URL (the editor passes it on to Play) and on
 * the export URL; every render canvas reports its backend in
 * `data-tl-renderer`, which the tests check so a variant cannot silently
 * fall back.
 */
import { expect, test, type Locator } from '@playwright/test';

export type RendererVariant = 'legacy' | 'webgl2' | 'webgpu';
export const RENDERER_VARIANTS: readonly RendererVariant[] = ['legacy', 'webgl2', 'webgpu'];

/** Skip the running test unless `variant` belongs to the current project. */
export function onlyInItsProject(variant: RendererVariant): void {
  const webgpuProject = test.info().project.name === 'webgpu';
  test.skip(webgpuProject ? variant !== 'webgpu' : variant === 'webgpu', `the ${variant} variant runs in the ${variant === 'webgpu' ? 'webgpu' : 'default'} project`);
}

/** The editor URL with the variant's `?renderer=` flag (before the token fragment). */
export function editorUrlFor(url: string, variant: RendererVariant): string {
  return variant === 'legacy' ? url : url.replace('#', `&renderer=${variant}#`);
}

/** The query string that forces the variant in a standalone export. */
export function exportQueryFor(variant: RendererVariant): string {
  return variant === 'legacy' ? '' : `?renderer=${variant}`;
}

/** The canvas draws with the variant's backend (ready, no fallback). */
export async function expectRendererBackend(canvas: Locator, variant: RendererVariant): Promise<void> {
  await expect.poll(() => canvas.evaluate((c) => `${c.getAttribute('data-tl-renderer')}/${c.getAttribute('data-tl-renderer-state')}`), { timeout: 30_000 }).toBe(`${variant}/ready`);
}
