/**
 * A project's voxel world in the real page against the real backend, on
 * WebGPU and on WebGL 2: the voxel world page streams the world's region
 * files by range, derives and draws them (ground, walls, and the beam,
 * rail and post pieces the assembly rules resolve), sends a brush dab as a
 * command, and shows the change once the backend has written it (pixels
 * read with png.ts); a reload, and a restarted backend, show the same
 * world from the region files.
 *
 * The world is the slice's test world (tools/voxel-bench/slice-world.ts),
 * a small hilly square with the wall-beam-banister scene, written into the
 * project's folder before the page opens it.
 */
import { decodePng, changedPixels } from './png';
import { expect, test, type Page } from './pw';
import { startBackend, type E2EBackend } from './backend';
import { consoleErrors } from './console-errors';
import { writeSliceWorld } from '../../tools/voxel-bench/slice-world';

type Cell = [number, number, number];
let be: E2EBackend;
let scene: Cell;

test.beforeAll(async () => {
  be = await startBackend('e2e-voxel');
  // 128 m square: enough ground around the scene for the ring, quick to write.
  scene = [...writeSliceWorld(be.projectDir, 'slice', 256).scene] as Cell;
});
test.afterAll(async () => {
  await be?.stop();
});

const hook = <T>(page: Page, fn: string, ...args: unknown[]): Promise<T> =>
  page.evaluate(([f, a]) => (window as unknown as { __tlVoxelWorld: Record<string, (...x: unknown[]) => unknown> }).__tlVoxelWorld[f as string]!(...(a as unknown[])) as T, [fn, args] as const);

async function open(page: Page, renderer: 'webgpu' | 'webgl2'): Promise<void> {
  await page.goto(`${be.origin}/voxel-world.html?project=${be.projectId}&world=slice&at=${scene.join(',')}&renderer=${renderer}&hud=0#token=${be.token}`);
  await page.waitForFunction(() => {
    const h = (window as unknown as { __tlVoxelWorld?: { ready?: boolean; failed?: string } }).__tlVoxelWorld;
    return h !== undefined && (h.ready === true || h.failed !== undefined);
  }, undefined, { timeout: 120_000 });
  expect(await page.evaluate(() => (window as unknown as { __tlVoxelWorld: { failed?: string } }).__tlVoxelWorld.failed ?? null)).toBeNull();
  expect(await page.evaluate(() => (window as unknown as { __tlVoxelWorld: { backend: string } }).__tlVoxelWorld.backend)).toBe(renderer);
  await hook(page, 'look', scene[0], scene[1] + 3, scene[2] + 2, -0.75, 0.42, 16);
  await hook(page, 'settle');
}

async function shot(page: Page): Promise<ReturnType<typeof decodePng>> {
  await page.evaluate(() => new Promise((ok) => requestAnimationFrame(() => requestAnimationFrame(ok))));
  return decodePng(await page.screenshot());
}

for (const renderer of ['webgpu', 'webgl2'] as const) {
  test(`streams, draws and edits the voxel world through commands; the edit is in the files after a reload (${renderer})`, async ({ page }) => {
    test.setTimeout(180_000);
    await page.setViewportSize({ width: 960, height: 540 });
    const errors = consoleErrors(page);
    await open(page, renderer);
    const state = await hook<{ drawn: number; triangles: number; pieces: number; counters: { damaged: number } }>(page, 'state');
    expect(state.drawn).toBeGreaterThan(20);
    expect(state.triangles).toBeGreaterThan(1000);
    // The beam and the banister's rail and posts are drawn as pieces, not as wall.
    expect(state.pieces).toBeGreaterThan(5);
    expect(state.counters.damaged).toBe(0);

    // Each renderer digs its own row of the wall (the other test's dig may already be in the files).
    const cell: Cell = [scene[0], scene[1] + (renderer === 'webgpu' ? 4 : 1), scene[2]];
    expect((await hook<{ material: number }>(page, 'voxelAt', ...cell)).material).not.toBe(0);
    const before = await shot(page);
    const timing = await hook<{ ok: boolean; code?: string; chunks: number; visibleMs: number }>(page, 'dab', cell, 'dig');
    expect(timing.ok, timing.code).toBe(true);
    // At a chunk corner in x and z: the dab changed more than one chunk.
    expect(timing.chunks).toBeGreaterThan(1);
    expect((await hook<{ material: number }>(page, 'voxelAt', ...cell)).material).toBe(0);
    const after = await shot(page);
    // A hole through the wall shows ground or sky where stone was.
    expect(changedPixels(before, after)).toBeGreaterThan(200);

    if (renderer === 'webgl2') await be.restart();
    await page.reload();
    await open(page, renderer);
    expect((await hook<{ material: number }>(page, 'voxelAt', ...cell)).material).toBe(0);
    const again = await shot(page);
    // The same picture as before the reload, from the region files (the view and the world are the same).
    expect(changedPixels(after, again)).toBeLessThan(200);
    expect(errors).toEqual([]);
  });
}
