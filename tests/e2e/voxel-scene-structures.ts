/**
 * The editor Scene view's pictures and voxel state, and its structure checks, for voxel-world.e2e.ts's Scene view
 * test: a structure object made through the command route draws its house in its own grid where the object stands
 * (pixels); moved by `setTransform` the house's pixels move with no region file rewritten and nothing derived again;
 * a storey added through `setComponent` draws it taller; an undo draws it as before; a click on its voxels selects
 * its object and the selection outline wears its box.
 */
import { readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { decodePng, type Image } from './png';
import { expect, test, type Page } from './pw';
import { gridHousePlacement, gridHouseStructure } from './voxel-grid-house';

/**
 * The Scene view's picture once it is still (no frame asked for, none drawn while it was taken), saved under `name`.
 * What streams in on its own is waited for by the caller first.
 */
export async function sceneViewStill(page: Page, name: string): Promise<Image> {
  const view = page.locator('canvas.tl-viewport');
  const quiet = async (): Promise<string | null> => ((await view.getAttribute('data-frame-wanted')) === '0' ? await view.getAttribute('data-frames') : null);
  let png: Buffer | null = null;
  await expect.poll(async () => {
    const before = await quiet();
    if (before === null) return false;
    const shot = await view.screenshot();
    if ((await quiet()) !== before) return false;
    png = shot;
    return true;
  }, { timeout: 30_000, intervals: [50] }).toBe(true);
  writeFileSync(test.info().outputPath(`${name}.png`), png!);
  return decodePng(png!);
}

/** The Scene view's `data-voxels`: what each world (and each structure grid, by draw name) draws and holds. */
export interface SceneViewVoxels { worlds: Record<string, { chunks: number; triangles: number; meshBuilds: number; kitInstances: number; tableUploads: number; tableMs: number }>; replaced: number; states: Record<string, { revision: number; settled: boolean; resident: number; grids?: Record<string, { resident: number; settled: boolean }> }>; problems: Record<string, string> }

export const sceneViewVoxels = async (page: Page): Promise<SceneViewVoxels | null> => JSON.parse((await page.locator('canvas.tl-viewport').getAttribute('data-voxels')) ?? 'null') as SceneViewVoxels | null;

/** The box (pixels) of where two pictures differ by more than `min` in some channel (null: nowhere). */
function changedBox(a: Image, b: Image, min = 60): { x0: number; y0: number; x1: number; y1: number; n: number } | null {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -1;
  let y1 = -1;
  let n = 0;
  for (let y = 0; y < a.height; y++) for (let x = 0; x < a.width; x++) {
    const p = a.pixel(x, y);
    const q = b.pixel(x, y);
    if (Math.max(Math.abs(p[0] - q[0]), Math.abs(p[1] - q[1]), Math.abs(p[2] - q[2])) <= min) continue;
    n++;
    x0 = Math.min(x0, x);
    y0 = Math.min(y0, y);
    x1 = Math.max(x1, x);
    y1 = Math.max(y1, y);
  }
  return n === 0 ? null : { x0, y0, x1, y1, n };
}

/** Each region file of a world's folder (its grids' too) with its modification time. */
function regionStamps(worldDir: string): Record<string, number> {
  const out: Record<string, number> = {};
  const walk = (dir: string, rel: string): void => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.isDirectory()) {
        if (e.name.startsWith('grid-')) walk(join(dir, e.name), `${rel}${e.name}/`);
      } else if (e.name.endsWith('.tlvr')) out[`${rel}${e.name}`] = statSync(join(dir, e.name)).mtimeMs;
    }
  };
  walk(worldDir, '');
  return out;
}

export interface SceneStructureDeps {
  readonly page: Page;
  /** A project command through the command route (as MCP sends it); its answer. */
  readonly command: (op: string, args: Record<string, unknown>) => Promise<Record<string, unknown>>;
  /** A query (no revision expected). */
  readonly query: (op: string, args: Record<string, unknown>) => Promise<Record<string, unknown>>;
  /** The world's name and folder; where the house's footprint's middle stands (metres, y its slab's underside). */
  readonly world: string;
  readonly worldDir: string;
  readonly centre: readonly [number, number, number];
  readonly material: number;
  /** An object of the scene that draws nothing (selected before the click). */
  readonly otherId: string;
}

/**
 * The structure checks on a Scene view already orbiting the world (see the file's note); the object is deleted after
 * (its grid emptied). Pictures `scene-view-structure-*.png`.
 */
export async function sceneViewStructureChecks(d: SceneStructureDeps): Promise<void> {
  const { page, world } = d;
  const view = page.locator('canvas.tl-viewport');
  // The placement does not depend on the grid id (the backend gives it).
  const house = gridHousePlacement(1, d.centre, 30);
  // Every picture with the same selection: an object that draws nothing (no outline, no gizmo in view).
  const other = page.locator(`.tl-hierarchy__list li[data-entity-id="${d.otherId}"]`);
  await other.click();
  // The view drawn back (the wheel, as a user zooms out) so a house two storeys tall fits it whole.
  const box = (await view.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  for (let k = 0; k < 3; k++) await page.mouse.wheel(0, 400);
  await expect.poll(async () => { const v = await sceneViewVoxels(page); return v?.states[world]?.settled === true; }, { timeout: 30_000 }).toBe(true);
  const bare = await sceneViewStill(page, 'scene-view-structure-bare');
  const made = await d.command('createEntity', { sceneId: 'scene-main', parentId: null, kind: 'group', name: 'Scene house', transform: { position: [...house.place.position], rotation: house.rotation }, components: { voxelStructure: gridHouseStructure(world, d.material) } });
  const id = String(made['createdId']);
  const grid = (made['voxels'] as Array<{ structures: Array<{ grid: number }> }>)[0]!.structures[0]!.grid;
  const name = `${world}#${grid}`;
  const drawnGrid = async (): Promise<{ chunks: number; meshBuilds: number; settled: boolean; replaced: number }> => {
    const v = await sceneViewVoxels(page);
    return { chunks: v?.worlds[name]?.chunks ?? 0, meshBuilds: v?.worlds[name]?.meshBuilds ?? 0, settled: v?.states[world]?.grids?.[name]?.settled === true, replaced: v?.replaced ?? 0 };
  };
  await expect.poll(async () => { const g = await drawnGrid(); return g.settled && g.chunks > 0; }, { timeout: 30_000, message: 'the structure grid streams and draws in the Scene view' }).toBe(true);
  const drawn = await sceneViewStill(page, 'scene-view-structure');
  const at = changedBox(bare, drawn);
  expect(at?.n ?? 0, 'the house drawn').toBeGreaterThan(2000);

  // Moved 3 m along −x by a transform edit: the house's pixels move, no region file is rewritten, nothing is meshed again.
  const stamps = regionStamps(d.worldDir);
  const before = await drawnGrid();
  await d.command('setTransform', { entityId: id, transform: { position: [house.place.position[0] - 3, house.place.position[1], house.place.position[2]], rotation: house.rotation } });
  await expect.poll(async () => (changedBox(drawn, await sceneViewStill(page, 'scene-view-structure-moved'))?.n ?? 0), { timeout: 15_000, message: 'the house moves with its object' }).toBeGreaterThan(1000);
  const moved = await sceneViewStill(page, 'scene-view-structure-moved');
  const movedAt = changedBox(bare, moved)!;
  expect((movedAt.x0 + movedAt.x1) / 2, 'the house moved across the view').not.toBeCloseTo((at!.x0 + at!.x1) / 2, -1);
  expect(regionStamps(d.worldDir)).toEqual(stamps);
  expect(await drawnGrid()).toMatchObject({ meshBuilds: before.meshBuilds, replaced: before.replaced });

  // A second storey: the grid's changed chunks are read again and the house draws taller.
  const value = ((await d.query('queryEntity', { entityId: id })) as { entity: { components: { voxelStructure: Record<string, unknown> } } }).entity.components.voxelStructure;
  await d.command('setComponent', { entityId: id, component: 'voxelStructure', value: { ...value, storeys: 2 } });
  await expect.poll(async () => { const g = await drawnGrid(); return g.settled && g.replaced > before.replaced; }, { timeout: 30_000, message: 'the regenerated grid is read again and drawn' }).toBe(true);
  const taller = changedBox(bare, await sceneViewStill(page, 'scene-view-structure-taller'))!;
  expect(taller.y0, `the house's top row ${movedAt.y0} → ${taller.y0}`).toBeLessThan(movedAt.y0 - 10);

  // Undo (the editor's one undo line): the house as before the storey.
  await other.click();
  const mark = (await drawnGrid()).replaced;
  await page.keyboard.press('Control+z');
  await expect.poll(async () => { const g = await drawnGrid(); return g.settled && g.replaced > mark; }, { timeout: 30_000, message: 'the undone regenerate is read again and drawn' }).toBe(true);
  await expect.poll(async () => changedBox(moved, await sceneViewStill(page, 'scene-view-structure-undone'))?.n ?? 0, { timeout: 15_000, message: 'the house as before the storey' }).toBeLessThan(80);

  // A click on its walls (another object selected before, one that draws nothing) selects its object, whose outline wears its box.
  await expect(view).toHaveAttribute('data-selection-outline', '');
  await view.click({ position: { x: Math.round((movedAt.x0 + movedAt.x1) / 2), y: Math.round(movedAt.y0 + (movedAt.y1 - movedAt.y0) * 0.6) } });
  await expect(page.locator(`.tl-hierarchy__list li[data-entity-id="${id}"]`)).toHaveAttribute('aria-selected', 'true', { timeout: 10_000 });
  await expect(view).toHaveAttribute('data-selection-outline', id);
  console.log(`[voxel-scene-view] structure grid ${name}: drawn ${at!.n} px at x ${at!.x0}–${at!.x1}, moved to ${movedAt.x0}–${movedAt.x1}, top row ${movedAt.y0} → ${taller.y0} with a storey`);

  await d.command('deleteEntity', { entityId: id });
  await expect.poll(async () => (await sceneViewVoxels(page))?.worlds[name] === undefined, { timeout: 15_000, message: 'the deleted structure is no longer drawn' }).toBe(true);
}
