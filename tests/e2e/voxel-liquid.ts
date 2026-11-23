/**
 * Liquid in the voxel world's e2e tests (voxel-world.e2e.ts drives them): water added to a dug pit on the voxel world
 * page feeds the liquid part alone and is drawn blue; a dig of its bank derives whole and bares the water's side; each
 * undone. In Play, a pool set in the dug pit keeps meshes and colliders standing and is drawn. Pixels read with png.ts.
 */
import { VOXEL_ROLE } from '@thirdlight/voxel';
import { changedPixels, decodePng } from './png';
import { expect, type Page } from './pw';
import { MAT } from '../../tools/voxel-bench/world-kit';

type Shot = Awaited<ReturnType<typeof decodePng>>;
type Hook = <T>(page: Page, fn: string, ...args: unknown[]) => Promise<T>;
interface EditAnswer {
  ok: boolean;
  code?: string;
  rederived: string[];
}
type Water = { liquid: { triangles: number; sets: number; program: boolean }; surface: { meshBuilds: number } };

/** A pixel of the stand-in water's blue (lit), not the grass, stone or ground round it. */
const isWater = (r: number, g: number, b: number): boolean => b > r + 40 && b > g + 10;

/**
 * On the voxel world page (`at`: the slice's kit scene origin, its pad's top at y): a 4 × 3 × 4-cell pit dug beside
 * the wall, liquid added into its lower two rows (only liquid derives, no mesh built, blue pixels), its +x bank dug at
 * the water's level (derived whole, more liquid faces: the water's side toward the new air), then all three undone
 * (the pit as it was before the water, then filled). The camera is left where the caller puts it next.
 */
export async function waterOnPage(o: { readonly page: Page; readonly hook: Hook; readonly shot: (page: Page) => Promise<Shot>; readonly at: readonly [number, number, number] }): Promise<void> {
  const { page, hook, shot } = o;
  const [ox, oy, oz] = o.at;
  const pit = { min: [ox + 6, oy - 3, oz - 8], max: [ox + 9, oy - 1, oz - 5] };
  await hook(page, 'look', ox + 8, oy - 2, oz - 6.5, 0.6, 0.75, 9);
  expect((await hook<EditAnswer>(page, 'edit', { v: 2, grid: 0, kind: 'fill', ...pit, mode: 'dig' })).ok).toBe(true);
  await hook(page, 'settle');
  const dryPit = await shot(page);
  const w0 = await hook<Water>(page, 'state');
  expect(w0.liquid.triangles).toBe(0);
  const water = await hook<EditAnswer>(page, 'edit', { v: 2, grid: 0, kind: 'fill', min: pit.min, max: [ox + 9, oy - 2, oz - 5], mode: 'add', voxel: { material: MAT.water, role: VOXEL_ROLE.liquid, wetness: 0 } });
  expect(water.ok, water.code).toBe(true);
  expect(water.rederived.length).toBeGreaterThan(0);
  expect(water.rederived.every((c) => c.endsWith(':liquid')), water.rederived.join(' ')).toBe(true);
  const w1 = await hook<Water>(page, 'state');
  expect(w1.surface.meshBuilds - w0.surface.meshBuilds, 'meshes built for the water').toBe(0);
  expect(w1.liquid.program).toBe(true);
  // Its top alone (the pit's walls are ground): a quad, or one a derive section it spans.
  expect(w1.liquid.triangles).toBeGreaterThanOrEqual(2);
  await hook(page, 'settle');
  const wet = await shot(page);
  const blue = changedPixels(dryPit, wet, isWater);
  expect(blue, 'blue water pixels in the pit').toBeGreaterThan(400);
  const bank = await hook<EditAnswer>(page, 'edit', { v: 2, grid: 0, kind: 'fill', min: [ox + 10, oy - 3, oz - 8], max: [ox + 10, oy - 1, oz - 5], mode: 'dig' });
  expect(bank.ok, bank.code).toBe(true);
  expect(bank.rederived.some((c) => /^-?\d+,-?\d+,-?\d+$/.test(c)), `the bank's dig derives whole: ${bank.rederived.join(' ')}`).toBe(true);
  const w2 = await hook<Water>(page, 'state');
  expect(w2.surface.meshBuilds).toBeGreaterThan(w1.surface.meshBuilds);
  expect(w2.liquid.triangles, "the water's side face toward the dug bank").toBeGreaterThan(w1.liquid.triangles);
  expect((await hook<EditAnswer>(page, 'undo')).ok).toBe(true);
  expect((await hook<Water>(page, 'state')).liquid.triangles).toBe(w1.liquid.triangles);
  const unwet = await hook<EditAnswer>(page, 'undo');
  expect(unwet.ok).toBe(true);
  expect(unwet.rederived.every((c) => c.endsWith(':liquid')), unwet.rederived.join(' ')).toBe(true);
  expect((await hook<Water>(page, 'state')).liquid.triangles).toBe(0);
  await hook(page, 'settle');
  expect(changedPixels(dryPit, await shot(page)), 'the pit as it was before the water').toBeLessThan(100);
  expect((await hook<EditAnswer>(page, 'undo')).ok).toBe(true);
  console.log(`[voxel-water] page: ${blue} blue pixels; liquid triangles ${w1.liquid.triangles} → ${w2.liquid.triangles} with the bank dug`);
}

/**
 * In Play, after the script's dig (its pit drawn in `after`): the script's second 'dig' sets a ball of water in the
 * pit's bottom. Its change keeps meshes and colliders standing (the game's `shaderOnly`, counted `standing`) and the
 * pool is drawn blue. Returns the blue pixels.
 */
export async function poolInPlay(o: { readonly page: Page; readonly after: Shot; readonly observe: () => Promise<{ counters?: Record<string, number> }>; readonly api: (path: string, body?: unknown) => Promise<{ status: number }>; readonly psid: string }): Promise<number> {
  const counter = async (name: string): Promise<number> => (await o.observe()).counters?.[name] ?? 0;
  const standing0 = await counter('standing');
  expect((await o.api(`play/${o.psid}/control`, { command: 'debugCommand', name: 'dig' })).status).toBe(200);
  await expect.poll(() => counter('pooled'), { timeout: 10_000 }).toBe(1);
  await expect.poll(async () => (await counter('standing')) - standing0, { timeout: 10_000, message: "the pool's change keeps meshes and colliders" }).toBeGreaterThanOrEqual(1);
  let px = 0;
  const frame = o.page.locator('iframe.tl-app__preview-frame');
  await expect.poll(async () => (px = changedPixels(o.after, decodePng(await frame.screenshot()), isWater)), { timeout: 10_000, message: 'the pool drawn blue in the pit' }).toBeGreaterThan(100);
  return px;
}
