/**
 * The structure editor on the real page against a real backend, driven as a user drives it: GameObject → Structure
 * and a drag on a voxel world's ground make a house (one `createEntity`), the mode opens on it; the Shape tool's edge
 * handle widens it by 2 m, Extend draws a wing (an L), the arrow over the roof drags a second storey up, the
 * Inspector's wall material swaps (material ids only), Dig and Paint make hand edits on its own grid, a second widening
 * leaves the painted cell a misfit (the banner, the list, its marker), the knob turns it 30°; then every step is undone
 * back to no house and done again, the last picture equal to the one before the undo. Pixels are read from the Scene
 * view's own pictures (png.ts); the house's place in them is where the bare ground's picture changed.
 *
 * A water body in a hollow of the same yard: made from "+ Add component", followed when its bank is dug back (one
 * undo for the dig and the water), raised by its level handle, drained and flagged when a trench passes its reach.
 *
 * One backend for the file. Pictures go to the test's output folder and, with TL_LOOK_DIR set, the owner's set there.
 */
import { copyFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { chunkGrid, createWorldStore, PLANE_BIT } from '@thirdlight/voxel';
import { VOXEL_WORLDS_FOLDER, writeVoxelWorld } from '@thirdlight/workspace';
import { mustCommand } from '../support/commands';
import { flatGround } from '../../tools/voxel-bench/scenes';
import { TEST_WORLD_ID } from '../../tools/voxel-bench/stream-node';
import { publishBytes, startBackend, type E2EBackend } from './backend';
import { multiPieceGlb } from './multi-piece-glb';
import { consoleErrors } from './console-errors';
import { decodePng, type Image } from './png';
import { expect, test, type Page } from './pw';
import { editorUrlFor } from './renderer-variants';
import { editMode, editModeTab, inspector, menu } from './ui';
import { sceneViewVoxels } from './voxel-scene-structures';

let be: E2EBackend;
const WORLD = 'yard';
/** The yard: flat grass, its top at y = 0, 64 m a side round the origin. */
const HALF_CELLS = 64;
const MAT = { grass: 3, stone: 10, roof: 13, brick: 20, water: 30 } as const;

test.beforeAll(async () => {
  be = await startBackend('e2e-structure');
  const store = createWorldStore(chunkGrid(32));
  flatGround(store, -HALF_CELLS, HALF_CELLS, -HALF_CELLS, HALF_CELLS, 6, 0);
  const hex = [...TEST_WORLD_ID].map((b) => b.toString(16).padStart(2, '0')).join('');
  writeVoxelWorld(join(be.projectDir, VOXEL_WORLDS_FOLDER, WORLD), { worldId: hex, edge: 32, layout: 'stacked', footprint: 512 }, store);
  const mat = (materialId: string, name: string, color: string, id: number, use: 'construction' | 'terrain'): Promise<unknown> => cmd('setMaterial', { material: { materialId, name, shader: 'standard', params: { color }, textures: {}, voxel: { id, use } } });
  await mat('mat-grass', 'Grass', '#4d7a3a', MAT.grass, 'terrain');
  await mat('mat-stone', 'Stone', '#a8a39a', MAT.stone, 'construction');
  await mat('mat-roof', 'Roof tile', '#9a3b2a', MAT.roof, 'construction');
  await mat('mat-brick', 'Brick', '#c0603a', MAT.brick, 'construction');
});

test.afterAll(async () => {
  await be?.stop();
});

function cmd(op: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  return mustCommand(be, op, args, { clientId: 'e2e-structure' });
}
const query = (op: string, args: Record<string, unknown>): Promise<Record<string, unknown>> => be.command({ op, projectId: be.projectId, args });

interface ToolStamp {
  tool: string;
  navigate: boolean;
  entityId: string | null;
  drag: string | null;
  marker: number[] | null;
  handles: { id: string; x: number; y: number }[];
  hover: { grid: number; cell: number[]; normal: number[]; at: number[] | null } | null;
  last: { gesture: string; ok: boolean | null; ms?: number } | null;
}
const toolStamp = async (page: Page): Promise<ToolStamp | null> => JSON.parse((await page.locator('canvas.tl-viewport').getAttribute('data-structure-tool')) ?? 'null') as ToolStamp | null;

/** The Scene view still (nothing asked to draw), its picture decoded; saved under `name`. */
async function still(page: Page, name: string): Promise<Image> {
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
  const { writeFileSync } = await import('node:fs');
  writeFileSync(test.info().outputPath(`${name}.png`), png!);
  return decodePng(png!);
}

/** The full editor window's picture for the owner's set (TL_LOOK_DIR), and the test's own output. */
async function look(page: Page, name: string): Promise<void> {
  const out = test.info().outputPath(`look-${name}.png`);
  await page.screenshot({ path: out });
  const dir = process.env['TL_LOOK_DIR'];
  if (dir !== undefined && dir !== '') {
    mkdirSync(dir, { recursive: true });
    copyFileSync(out, join(dir, `${name}.png`));
  }
}

/** Pixels of stone grey (the house's walls and roof: neither the bright sky nor the green ground, nor the brick). */
function greyCount(img: Image): number {
  let n = 0;
  for (let y = 0; y < img.height; y++) for (let x = 0; x < img.width; x++) {
    const [r, g, b] = img.pixel(x, y);
    if (Math.abs(r - g) < 14 && Math.abs(g - b) < 18 && Math.max(r, g, b) < 215 && Math.max(r, g, b) > 70) n++;
  }
  return n;
}

/** Pixels of the brick walls' red-orange. */
function brickCount(img: Image): number {
  let n = 0;
  for (let y = 0; y < img.height; y++) for (let x = 0; x < img.width; x++) {
    const [r, g, b] = img.pixel(x, y);
    if (r > g + 40 && r > b + 50) n++;
  }
  return n;
}

/** Pixels that differ by more than `min` in some channel, and their box. */
function diff(a: Image, b: Image, min = 40): { n: number; x0: number; y0: number; x1: number; y1: number } {
  let n = 0;
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -1;
  let y1 = -1;
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
  return { n, x0, y0, x1, y1 };
}

/**
 * The screen point of a floor cell corner, from four points of the floor whose screen places are known (the corner
 * handles): the plane's projection solved as a homography, so the perspective is exact.
 */
function floorToScreen(grid: readonly (readonly [number, number])[], screen: readonly { x: number; y: number }[]): (x: number, z: number) => { x: number; y: number } {
  const a: number[][] = [];
  const b: number[] = [];
  for (let k = 0; k < 4; k++) {
    const [u, v] = grid[k]!;
    const { x, y } = screen[k]!;
    a.push([u, v, 1, 0, 0, 0, -u * x, -v * x]);
    b.push(x);
    a.push([0, 0, 0, u, v, 1, -u * y, -v * y]);
    b.push(y);
  }
  // Gaussian elimination with partial pivoting (8 × 8).
  for (let c = 0; c < 8; c++) {
    let p = c;
    for (let r = c + 1; r < 8; r++) if (Math.abs(a[r]![c]!) > Math.abs(a[p]![c]!)) p = r;
    [a[c], a[p]] = [a[p]!, a[c]!];
    [b[c], b[p]] = [b[p]!, b[c]!];
    for (let r = 0; r < 8; r++) {
      if (r === c) continue;
      const f = a[r]![c]! / a[c]![c]!;
      for (let k = c; k < 8; k++) a[r]![k] = a[r]![k]! - f * a[c]![k]!;
      b[r] = b[r]! - f * b[c]!;
    }
  }
  const h = b.map((v, i) => v / a[i]![i]!);
  return (u, v) => {
    const w = h[6]! * u + h[7]! * v + 1;
    return { x: (h[0]! * u + h[1]! * v + h[2]!) / w, y: (h[3]! * u + h[4]! * v + h[5]!) / w };
  };
}

const structureOf = async (id: string): Promise<Record<string, unknown> & { footprint: { id: string; points: number[][] }[]; storeys: number; materials: Record<string, number>; grid: number }> =>
  ((await query('queryEntity', { entityId: id })) as { entity: { components: { voxelStructure: never } } }).entity.components.voxelStructure;
const transformOf = async (id: string): Promise<{ position: number[]; rotation: number[] }> => ((await query('queryEntity', { entityId: id })) as { entity: { components: { transform: never } } }).entity.components.transform;

test('the structure editor: draw a house, widen, extend, add a storey, swap a material, dig and paint, a misfit shown, turn; undo all and redo all', async ({ page }) => {
  test.setTimeout(240_000);
  const t0 = Date.now();
  await page.setViewportSize({ width: 1280, height: 800 });
  const errors = consoleErrors(page);
  const worldId = String((await cmd('createEntity', { sceneId: 'scene-main', parentId: null, kind: 'group', name: 'Yard', transform: { position: [0, 0, 0] }, components: { voxelWorld: { world: WORLD } } }))['createdId']);
  // An object far away that draws nothing: selected before every picture (no gizmo, no outline in them).
  const marker = String((await cmd('createEntity', { sceneId: 'scene-main', parentId: null, kind: 'group', name: 'Marker', transform: { position: [400, 0, 0] } }))['createdId']);
  await page.goto(editorUrlFor(be.editorUrl, 'webgpu'));
  await expect(page.locator('.tl-statusbar')).toContainText('connected');
  const view = page.locator('canvas.tl-viewport');
  await page.locator(`.tl-hierarchy__list li[data-entity-id="${worldId}"]`).click();
  await page.keyboard.press('f');
  const box = (await view.boundingBox())!;
  const mid = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  await page.mouse.move(mid.x, mid.y);
  for (let k = 0; k < 2; k++) await page.mouse.wheel(0, 400);
  await expect.poll(async () => (await sceneViewVoxels(page))?.states[WORLD]?.settled === true, { timeout: 60_000, message: 'the yard streams in' }).toBe(true);
  await page.locator(`.tl-hierarchy__list li[data-entity-id="${marker}"]`).click();
  const bare = await still(page, 'bare');

  // ---- Create: GameObject → Structure, a drag on the ground --------------------------------------------------------
  await menu(page, 'GameObject', 'Structure');
  // The view looks across the yard's diagonal: a drag across the screen spans both of its axes.
  await page.mouse.move(mid.x - 120, mid.y + 10);
  await page.mouse.down();
  await page.mouse.move(mid.x, mid.y + 15, { steps: 5 });
  await page.mouse.move(mid.x + 110, mid.y + 25, { steps: 5 });
  await expect.poll(async () => (await toolStamp(page))?.drag, { timeout: 5_000 }).toBe('create');
  await look(page, '01-draw-footprint');
  await page.mouse.up();
  await expect(editMode(page)).toHaveAttribute('data-edit-mode', 'structure', { timeout: 15_000 });
  const id = (await editMode(page).getAttribute('data-entity-id'))!;
  const made = await structureOf(id);
  const grid = made.grid;
  const drawName = `${WORLD}#${grid}`;
  const drawn = async (): Promise<{ replaced: number; settled: boolean; chunks: number }> => {
    const v = await sceneViewVoxels(page);
    return { replaced: v?.replaced ?? 0, settled: v?.states[WORLD]?.grids?.[drawName]?.settled === true, chunks: v?.worlds[drawName]?.chunks ?? 0 };
  };
  await expect.poll(async () => { const d = await drawn(); return d.settled && d.chunks > 0; }, { timeout: 30_000, message: 'the new house draws' }).toBe(true);
  // Back a little from the mode's framing, as a user makes room for a second storey and a wing.
  await page.mouse.move(mid.x, mid.y);
  for (let k = 0; k < 2; k++) await page.mouse.wheel(0, 500);
  await expect.poll(async () => (await view.getAttribute('data-frame-wanted')) === '0', { timeout: 10_000 }).toBe(true);
  await look(page, '02-house-made');
  const p0 = made.footprint[0]!.points;
  const w0 = p0[1]![0]! - p0[0]![0]!;
  const d0 = p0[2]![1]! - p0[1]![1]!;
  console.log(`[structure] made grid ${grid}: ${w0} × ${d0} cells, ${Date.now() - t0} ms in`);
  expect(w0).toBeGreaterThanOrEqual(6);
  expect(d0).toBeGreaterThanOrEqual(6);
  expect(made).toMatchObject({ world: WORLD, storeys: 1, materials: { wall: MAT.stone, floor: MAT.stone, roof: MAT.stone, foundation: MAT.stone, stair: MAT.stone } });
  const houseShot = await still(page, 'house');
  expect(diff(bare, houseShot).n, 'the house is drawn over the bare ground').toBeGreaterThan(20_000);

  // Every state the undo walks back through: the component, the transform, the hand edits kept.
  const routeGrid = async (): Promise<{ overrides: number; lastRegenerate?: { misfits: { x: number; y: number; z: number }[]; fields: number } }> => {
    const r = await fetch(`${be.origin}/api/v1/projects/${be.projectId}/voxels/${WORLD}`, { headers: { authorization: `Bearer ${be.token}` } });
    return ((await r.json()) as { grids: Array<{ id: number; overrides: number }> }).grids.find((g) => g.id === grid)!;
  };
  const stateNow = async (): Promise<string> => JSON.stringify([await structureOf(id), await transformOf(id), (await routeGrid()).overrides]);
  const states: string[] = [await stateNow()];
  const step = async (): Promise<void> => {
    const now = await stateNow();
    expect(now, 'each step changes the structure').not.toBe(states.at(-1));
    states.push(now);
  };
  const hint = page.locator('.tl-hints__text');
  const tile = (name: string) => editMode(page).locator('button.tl-tool', { hasText: name });
  const arm = async (name: string): Promise<void> => {
    const t = tile(name);
    if ((await t.getAttribute('aria-pressed')) !== 'true') await t.click();
    await expect(t).toHaveAttribute('aria-pressed', 'true');
  };
  const handle = async (hid: string): Promise<{ x: number; y: number }> => {
    let h: { x: number; y: number } | undefined;
    await expect.poll(async () => (h = (await toolStamp(page))?.handles.find((x) => x.id === hid)) !== undefined, { timeout: 10_000, message: `handle ${hid} on screen` }).toBe(true);
    return h!;
  };
  /** Waits for a regenerate the release sent to be drawn: ms from the release to the new grid drawn and settled. */
  const redrawn = async (before: number, released: number, what: string): Promise<number> => {
    let at = 0;
    await expect.poll(async () => { const d = await drawn(); if (d.settled && d.replaced > before) { at = Date.now(); return true; } return false; }, { timeout: 30_000, intervals: [16], message: `${what} drawn` }).toBe(true);
    return at - released;
  };
  /** Drags from a point, in steps, until the status line's readout says `want` (the pointer moved by `delta` px a step). */
  const dragUntil = async (from: { x: number; y: number }, delta: { x: number; y: number }, want: RegExp, max = 60): Promise<void> => {
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    let p = { ...from };
    for (let k = 0; k < max; k++) {
      p = { x: p.x + delta.x, y: p.y + delta.y };
      await page.mouse.move(p.x, p.y);
      if (want.test((await hint.textContent()) ?? '')) return;
    }
    throw new Error(`the readout never said ${want}: "${await hint.textContent()}"`);
  };
  const timings: Record<string, number> = {};

  // ---- Widen by 2 m: the +x edge's handle, four cells -------------------------------------------------------------
  await arm('Shape');
  const c0 = await handle('corner:0:0');
  const c1 = await handle('corner:0:1');
  const along = { x: (c1.x - c0.x) / w0, y: (c1.y - c0.y) / w0 };
  const wideM = ((w0 + 4) / 2).toFixed(1);
  await dragUntil(await handle('edge:0:1'), { x: along.x / 4, y: along.y / 4 }, new RegExp(`^${wideM.replace('.', '\\.')} ×`));
  let mark = (await drawn()).replaced;
  let released = Date.now();
  await page.mouse.up();
  timings['widen (small house)'] = await redrawn(mark, released, 'the widened house');
  const wide = await structureOf(id);
  expect(wide.footprint[0]!.points).toEqual(p0.map((q, k) => (k === 1 || k === 2 ? [q[0]! + 4, q[1]] : q)));
  await step();
  await look(page, '03-widened');
  const widened = await still(page, 'widened');
  expect(diff(houseShot, widened).n, 'the house drawn wider').toBeGreaterThan(1_000);

  // ---- Extend: a wing drawn on the floor's level (an L) -----------------------------------------------------------
  // The grid's cells on screen, from three corner handles of the widened house (the floor's plane, as the drag reads it).
  const w1 = w0 + 4;
  const [gx0, gz0] = [p0[0]![0]!, p0[0]![1]!];
  const corners = [await handle('corner:0:0'), await handle('corner:0:1'), await handle('corner:0:2'), await handle('corner:0:3')];
  const onScreen = floorToScreen([[gx0, gz0], [gx0 + w1, gz0], [gx0 + w1, gz0 + d0], [gx0, gz0 + d0]], corners);
  await arm('Extend');
  // A wing 4 m wide at the house's +x end, overlapping its last cells and reaching 4 m past its +z side.
  const wingFrom = onScreen(gx0 + w1 - 8 + 0.3, gz0 + d0 - 2 + 0.3);
  const wingTo = onScreen(gx0 + w1 + 0.3, gz0 + d0 + 8 + 0.3);
  await page.mouse.move(wingFrom.x, wingFrom.y);
  await page.mouse.down();
  await page.mouse.move((wingFrom.x + wingTo.x) / 2, (wingFrom.y + wingTo.y) / 2, { steps: 4 });
  await page.mouse.move(wingTo.x, wingTo.y, { steps: 4 });
  await expect(hint).toContainText('Wing');
  mark = (await drawn()).replaced;
  released = Date.now();
  await page.mouse.up();
  timings['extend (L)'] = await redrawn(mark, released, 'the L');
  const ell = await structureOf(id);
  expect(ell.footprint.map((f) => f.id)).toEqual(['main', 'wing-2']);
  expect(ell.footprint[1]!.points, 'the wing where it was drawn (the floor plane mapped from the corner handles)').toEqual([[gx0 + w1 - 8, gz0 + d0 - 2], [gx0 + w1, gz0 + d0 - 2], [gx0 + w1, gz0 + d0 + 8], [gx0 + w1 - 8, gz0 + d0 + 8]]);
  console.log(`[structure] wing ${JSON.stringify(ell.footprint[1]!.points)}`);
  await step();
  await look(page, '04-wing');
  const wing = await still(page, 'wing');
  expect(diff(widened, wing).n, 'the wing drawn').toBeGreaterThan(1_000);

  // ---- Drag up: the arrow over the roof, one storey -------------------------------------------------------------
  await arm('Shape');
  await dragUntil(await handle('storey'), { x: 0, y: -4 }, /^Storeys 2$/);
  await look(page, '05-second-storey-ghost');
  mark = (await drawn()).replaced;
  released = Date.now();
  await page.mouse.up();
  timings['storey (L)'] = await redrawn(mark, released, 'the second storey');
  expect((await structureOf(id)).storeys).toBe(2);
  await step();
  await look(page, '05-second-storey');
  const taller = await still(page, 'taller');
  // The camera has not moved since the wing's picture: the house covers more of it.
  expect(greyCount(taller), `stone pixels ${greyCount(wing)} → ${greyCount(taller)}`).toBeGreaterThan(greyCount(wing) * 1.1);

  // ---- The wall material swapped in the column (the Inspector's fields): material ids only -------------------------
  mark = (await drawn()).replaced;
  await editMode(page).getByLabel('structure wall material').selectOption(String(MAT.brick));
  await redrawn(mark, Date.now(), 'the brick walls');
  expect((await structureOf(id)).materials).toMatchObject({ wall: MAT.brick, roof: MAT.stone });
  // The regenerate's own report: only the material plane changed.
  expect((await routeGrid()).lastRegenerate?.fields).toBe(PLANE_BIT.material);
  await step();
  await look(page, '06-material-swapped');
  const brick = await still(page, 'brick');
  expect(diff(taller, brick).n, 'the walls change colour').toBeGreaterThan(2_000);

  // ---- Hand edits: a hole dug in a long wall, a cell painted on the +x end wall ------------------------------------
  await editModeTab(page, 'Hand edits');
  await arm('Dig');
  // Each wall of the main polygon: its edge, its outward normal, where its middle stands on the floor (grid cells).
  const gx1 = gx0 + w1;
  const gz1 = gz0 + d0;
  const walls = [
    { edge: 1, n: [1, 0, 0], at: [gx1, gz0 + 3], ok: (c: number[]) => c[2]! < gz1 - 3 },
    { edge: 2, n: [0, 0, 1], at: [gx0 + 3, gz1], ok: (c: number[]) => c[0]! < gx1 - 9 },
    { edge: 0, n: [0, 0, -1], at: [(gx0 + gx1) / 2 - 3, gz0], ok: (c: number[]) => c[0]! < gx1 - 9 },
    { edge: 3, n: [-1, 0, 0], at: [gx0, (gz0 + gz1) / 2], ok: () => true },
  ];
  // The wing's own walls (no edge of the main polygon: a hole there stays whatever the main polygon does).
  const wingWalls = [
    { edge: -1, n: [0, 0, 1], at: [gx1 - 4, gz1 + 8], ok: () => true },
    { edge: -1, n: [-1, 0, 0], at: [gx1 - 8, gz1 + 5], ok: () => true },
  ];
  /** The first-storey wall cell under the pointer, stepping up from a wall's foot on screen (null: that wall is not seen). */
  const wallCell = async (w: (typeof walls)[number]): Promise<{ x: number; y: number; cell: number[] } | null> => {
    const foot = onScreen(w.at[0]!, w.at[1]!);
    for (let dy = 6; dy <= 90; dy += 6) {
      const at = { x: Math.round(foot.x), y: Math.round(foot.y - dy) };
      await page.mouse.move(at.x, at.y);
      const hit = await hoverAt(at);
      if (hit === null || hit.grid !== grid) continue;
      if (hit.normal.join() === w.n.join() && hit.cell[1]! >= 2 && hit.cell[1]! <= 4 && w.ok(hit.cell)) return { ...at, cell: hit.cell };
      // Above the first storey on this wall, or on the roof: nothing further up is.
      if (hit.cell[1]! > 4) return null;
    }
    return null;
  };
  /** The pick under a pointer position once the tool has picked there (the frame's stamp says where it picked). */
  const hoverAt = async (at: { x: number; y: number }): Promise<ToolStamp['hover']> => {
    let h: ToolStamp['hover'] = null;
    await expect.poll(async () => { h = (await toolStamp(page))?.hover ?? null; return h?.at?.[0] === Math.round(at.x) && h.at[1] === Math.round(at.y); }, { timeout: 5_000, message: 'the cell under the pointer picked' }).toBe(true);
    return h;
  };
  let paintWall: { wall: (typeof walls)[number]; at: { x: number; y: number; cell: number[] } } | null = null;
  for (const w of walls) {
    const at = await wallCell(w);
    if (at !== null) {
      paintWall = { wall: w, at };
      break;
    }
  }
  expect(paintWall, 'a wall of the main polygon seen from the view').not.toBeNull();
  let digWall: typeof paintWall = null;
  for (const w of [...wingWalls, ...walls.filter((x) => x.edge !== paintWall!.wall.edge)]) {
    const at = await wallCell(w);
    if (at !== null) {
      digWall = { wall: w, at };
      break;
    }
  }
  expect(digWall, 'another wall seen from the view').not.toBeNull();
  // A hole dug in one wall (the brush three cells across: ] until it is 1 m or more), a cell of another wall painted (Stone).
  const slider = editMode(page).getByRole('slider', { name: 'brush size slider' });
  const brushSize = async (): Promise<number> => Number(await slider.getAttribute('aria-valuenow'));
  for (let k = 0; k < 6 && (await brushSize()) < 1; k++) await page.keyboard.press(']');
  expect(await brushSize()).toBeGreaterThanOrEqual(1);
  const overrides0 = (await routeGrid()).overrides;
  await page.mouse.move(digWall!.at.x + 1, digWall!.at.y);
  await page.mouse.move(digWall!.at.x, digWall!.at.y);
  expect((await hoverAt(digWall!.at))?.cell).toEqual(digWall!.at.cell);
  await page.mouse.down();
  await page.mouse.up();
  await expect.poll(async () => (await routeGrid()).overrides, { timeout: 15_000, message: 'the dug cell kept as a hand edit' }).toBeGreaterThan(overrides0);
  await step();
  const digAt = digWall!.at;
  await arm('Paint');
  await editMode(page).getByLabel('structure hand edit material').selectOption(String(MAT.stone));
  for (let k = 0; k < 6 && (await brushSize()) > 0.5; k++) await page.keyboard.press('[');
  const paintAt = paintWall!.at;
  const overrides1 = (await routeGrid()).overrides;
  await page.mouse.move(paintAt.x + 1, paintAt.y);
  await page.mouse.move(paintAt.x, paintAt.y);
  expect((await hoverAt(paintAt))?.cell).toEqual(paintAt.cell);
  await page.mouse.down();
  await page.mouse.up();
  await expect.poll(async () => (await routeGrid()).overrides, { timeout: 15_000, message: 'the painted cell kept as a hand edit' }).toBeGreaterThan(overrides1);
  await step();
  const pw0 = paintWall!.wall;
  await expect(editMode(page).locator('.tl-sec__note')).toContainText(/\d+ hand edits kept/);
  await page.mouse.move(box.x + 30, box.y + 30);
  // The brush panel folded so nothing covers the house.
  await editMode(page).locator('[data-panel="brush"] .tl-dpanel__head').click();
  await look(page, '07-hole-and-paint');
  console.log(`[structure] dug cell ${digAt.cell.join(',')} (edge ${digWall!.wall.edge}), painted cell ${paintAt.cell.join(',')} (edge ${pw0.edge}), hand edits ${(await routeGrid()).overrides}`);

  // ---- Widen again: the painted end wall moves away, its cell no longer fits (the banner, the list, the marker) ----
  await editModeTab(page, 'Shape');
  await arm('Shape');
  // The painted wall's edge moved 2 cells out: its cell is inside the house now.
  const pw = paintWall!.wall;
  const from = await handle(`edge:0:${pw.edge}`);
  const m0 = onScreen(pw.at[0]!, pw.at[1]!);
  const m2 = onScreen(pw.at[0]! + pw.n[0]! * 2, pw.at[1]! + pw.n[2]! * 2);
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(from.x + (m2.x - m0.x) / 2, from.y + (m2.y - m0.y) / 2, { steps: 3 });
  await page.mouse.move(from.x + (m2.x - m0.x), from.y + (m2.y - m0.y), { steps: 3 });
  mark = (await drawn()).replaced;
  await page.mouse.up();
  await redrawn(mark, Date.now(), 'the house widened again');
  const moved = (await structureOf(id)).footprint[0]!.points;
  const axis = pw.n[0] !== 0 ? 0 : 1;
  expect(moved[pw.edge]![axis]! - (axis === 0 ? (pw.n[0] === 1 ? gx1 : gx0) : (pw.n[2] === 1 ? gz1 : gz0)), 'the wall moved 2 cells out').toBe(2 * (pw.n[0]! + pw.n[2]!));
  await step();
  const misfits = (await routeGrid()).lastRegenerate?.misfits ?? [];
  expect(misfits.map((m) => [m.x, m.y, m.z]), 'the painted cell no longer fits').toContainEqual(paintAt.cell);
  await expect(editMode(page).getByRole('status', { name: 'structure misfits banner' })).toContainText(`${misfits.length} edit${misfits.length === 1 ? '' : 's'} did not fit the new shape`);
  const list = editMode(page).getByRole('status', { name: 'structure misfits' });
  await list.getByRole('button', { name: 'list them' }).click();
  const entry = list.locator(`button[data-cell="${paintAt.cell.join(',')}"]`);
  await expect(entry).toContainText('a painted cell');
  await entry.click();
  await expect.poll(async () => (await toolStamp(page))?.marker, { message: 'the misfit marked in the view' }).toEqual(paintAt.cell);
  await look(page, '08-misfit-list');

  // ---- Turn: the knob on the ring, 30° ---------------------------------------------------------------------------
  // Home frames the whole structure again (the misfit's frame is close up).
  await page.mouse.move(box.x + 30, box.y + 30);
  await page.keyboard.press('Home');
  await expect.poll(async () => (await view.getAttribute('data-frame-wanted')) === '0', { timeout: 10_000 }).toBe(true);
  const knob = await handle('yaw');
  const top = await handle('storey');
  // Round the middle (the arrow stands over it): a step across the line from the middle to the knob.
  const across = { x: -(knob.y - top.y), y: knob.x - top.x };
  const len = Math.hypot(across.x, across.y);
  await dragUntil(knob, { x: (across.x / len) * 3, y: (across.y / len) * 3 }, /^Turn -?30°$/, 120);
  await page.mouse.up();
  await expect.poll(async () => Math.abs(Math.round((2 * Math.atan2((await transformOf(id)).rotation[1]!, (await transformOf(id)).rotation[3]!) * 180) / Math.PI)), { timeout: 10_000, message: 'turned 30°' }).toBe(30);
  await step();
  await page.mouse.move(box.x + 30, box.y + 30);
  await look(page, '09-turned');

  // ---- Leave; undo every step back to no house, redo every one: the pictures equal ---------------------------------
  await editMode(page).getByRole('button', { name: /^Done/ }).click();
  await expect(editMode(page)).toHaveCount(0);
  await page.locator(`.tl-hierarchy__list li[data-entity-id="${marker}"]`).click();
  const final = await still(page, 'final');
  const exists = async (): Promise<boolean> => {
    const r = await query('queryEntity', { entityId: id });
    return r['ok'] !== false && r['entity'] !== undefined;
  };
  for (let k = states.length - 1; k >= 1; k--) {
    await page.keyboard.press('Control+z');
    const want = states[k - 1]!;
    await expect.poll(async () => stateNow(), { timeout: 20_000, message: `undo to step ${k - 1}` }).toBe(want);
  }
  await page.keyboard.press('Control+z');
  await expect.poll(exists, { timeout: 20_000, message: 'undo takes the house away' }).toBe(false);
  // The camera moved with the mode's framing since the bare picture: the yard is bare when no stone or brick is left in it.
  await expect.poll(async () => { const img = await still(page, 'undone'); return greyCount(img) + brickCount(img); }, { timeout: 20_000, message: 'the bare yard again (the light icons aside)' }).toBeLessThan(1500);
  await page.keyboard.press('Control+Shift+z');
  await expect.poll(exists, { timeout: 20_000, message: 'redo makes the house again' }).toBe(true);
  for (let k = 1; k < states.length; k++) {
    await page.keyboard.press('Control+Shift+z');
    await expect.poll(async () => stateNow(), { timeout: 20_000, message: `redo to step ${k}` }).toBe(states[k]);
  }
  await expect.poll(async () => diff(final, await still(page, 'redone')).n, { timeout: 30_000, message: 'the house as it was before the undo' }).toBeLessThan(200);
  console.log(`[structure] release → drawn: ${JSON.stringify(timings)}; steps ${states.length - 1}; test ${((Date.now() - t0) / 1000).toFixed(1)} s`);
  expect(errors).toEqual([]);
});

/** Pixels of the door leaf's brown (the fixture's own colour: no stone, grass or sky is this red over blue). */
const brownCount = (img: Image): number => {
  let n = 0;
  for (let y = 0; y < img.height; y++) for (let x = 0; x < img.width; x++) {
    const [r, g, b] = img.pixel(x, y);
    if (r > g + 25 && g > b + 25 && r > 70) n++;
  }
  return n;
};
/** Pixels of the pane's blue. */
const blueCount = (img: Image): number => {
  let n = 0;
  for (let y = 0; y < img.height; y++) for (let x = 0; x < img.width; x++) {
    const [r, g, b] = img.pixel(x, y);
    if (b > r + 60 && b > g + 20) n++;
  }
  return n;
};

test('openings: a door and a window placed on a wall by the pointer, a leaf and a pane put in them from the models that fit, the door moved along its wall, the house widened, the window deleted; undo all and redo all', async ({ page }) => {
  test.setTimeout(180_000);
  const t0 = Date.now();
  await page.setViewportSize({ width: 1280, height: 800 });
  const errors = consoleErrors(page);
  // Fixture models: a leaf 1 × 2 m, a pane 1 × 1 m (each a cell deep at most), and a crate too big for any opening.
  await publishBytes(be, multiPieceGlb([{ name: 'leaf', lods: [[1, 2, 0.1]], colors: [[0.35, 0.12, 0.03]], vertexColor: [1, 1, 1, 1] }], { centred: true }), 'model', 'fix-leaf', 'Door leaf');
  await publishBytes(be, multiPieceGlb([{ name: 'pane', lods: [[1, 1, 0.05]], colors: [[0.05, 0.25, 0.9]], vertexColor: [1, 1, 1, 1] }], { centred: true }), 'model', 'fix-pane', 'Window pane');
  await publishBytes(be, multiPieceGlb([{ name: 'crate', lods: [[3, 3, 1]] }], { centred: true }), 'model', 'fix-crate', 'Big crate');
  // The yard's voxelWorld object (the first test's; made here when this test runs alone).
  const all = ((await query('queryEntities', { limit: 100, offset: 0 })) as { entities: { components: Record<string, unknown> }[] }).entities;
  if (!all.some((e) => (e.components['voxelWorld'] as { world?: string } | undefined)?.world === WORLD)) await cmd('createEntity', { sceneId: 'scene-main', parentId: null, kind: 'group', name: 'Yard', transform: { position: [0, 0, 0] }, components: { voxelWorld: { world: WORLD } } });
  const W = 12;
  const D = 10;
  const made = await cmd('createEntity', { sceneId: 'scene-main', parentId: null, kind: 'group', name: 'Shop', transform: { position: [-22, 0, 12] }, components: { voxelStructure: { world: WORLD, footprint: [{ id: 'main', points: [[0, 0], [W, 0], [W, D], [0, D]] }], storeys: 1, storeyHeight: 6, foundationDepth: 1, roof: { shape: 'flat', overhang: 0, axis: 'x' }, materials: { wall: MAT.stone, floor: MAT.stone, roof: MAT.stone, foundation: MAT.stone, stair: MAT.stone }, openings: [], stairs: [] } } });
  const id = String(made['createdId']);
  const marker = String((await cmd('createEntity', { sceneId: 'scene-main', parentId: null, kind: 'group', name: 'Marker 2', transform: { position: [400, 0, 0] } }))['createdId']);
  await page.goto(editorUrlFor(be.editorUrl, 'webgpu'));
  await expect(page.locator('.tl-statusbar')).toContainText('connected');
  const view = page.locator('canvas.tl-viewport');
  const box = (await view.boundingBox())!;
  await page.locator(`.tl-hierarchy__list li[data-entity-id="${id}"]`).click();
  await inspector(page).getByRole('button', { name: 'Edit structure', exact: true }).click();
  await expect(editMode(page)).toHaveAttribute('data-edit-mode', 'structure', { timeout: 15_000 });
  const v0 = await structureOf(id);
  const grid = v0.grid;
  const drawName = `${WORLD}#${grid}`;
  const drawn = async (): Promise<{ replaced: number; settled: boolean; chunks: number }> => {
    const v = await sceneViewVoxels(page);
    return { replaced: v?.replaced ?? 0, settled: v?.states[WORLD]?.grids?.[drawName]?.settled === true, chunks: v?.worlds[drawName]?.chunks ?? 0 };
  };
  await expect.poll(async () => { const d = await drawn(); return d.settled && d.chunks > 0; }, { timeout: 30_000, message: 'the shop draws' }).toBe(true);
  const p0 = v0.footprint[0]!.points;
  const [gx0, gz0] = [p0[0]![0]!, p0[0]![1]!];
  const hint = page.locator('.tl-hints__text');
  const tile = (name: string) => editMode(page).locator('button.tl-tool', { hasText: name });
  const arm = async (name: string): Promise<void> => {
    const t = tile(name);
    if ((await t.getAttribute('aria-pressed')) !== 'true') await t.click();
    await expect(t).toHaveAttribute('aria-pressed', 'true');
  };
  const handle = async (hid: string): Promise<{ x: number; y: number }> => {
    let h: { x: number; y: number } | undefined;
    await expect.poll(async () => (h = (await toolStamp(page))?.handles.find((x) => x.id === hid)) !== undefined, { timeout: 10_000, message: `handle ${hid} on screen` }).toBe(true);
    return h!;
  };
  const redrawn = async (before: number): Promise<void> => {
    await expect.poll(async () => { const d = await drawn(); return d.settled && d.replaced > before; }, { timeout: 30_000, intervals: [16], message: 'the regenerated shop drawn' }).toBe(true);
  };
  // The floor's plane on screen from the four corner handles (the Shape tool), as the first test maps it.
  await arm('Shape');
  const corners = [await handle('corner:0:0'), await handle('corner:0:1'), await handle('corner:0:2'), await handle('corner:0:3')];
  const onScreen = floorToScreen([[gx0, gz0], [gx0 + W, gz0], [gx0 + W, gz0 + D], [gx0, gz0 + D]], corners);
  // Each wall: its edge, its outward normal (grid), its length, the grid point of its cell j's outer face at the floor.
  const walls = [0, 1, 2, 3].map((edge) => {
    const a = p0[edge]!;
    const b = p0[(edge + 1) % 4]!;
    const len = Math.abs(b[0]! - a[0]! + b[1]! - a[1]!);
    const sx = Math.sign(b[0]! - a[0]!);
    const sz = Math.sign(b[1]! - a[1]!);
    const n = [sz, 0, -sx];
    const at = (j: number): [number, number] => [a[0]! + sx * (j + 0.5), a[1]! + sz * (j + 0.5)];
    return { edge, n, len, at };
  });
  await editModeTab(page, 'Openings');
  await arm('Place');
  /** Hover up a wall's column j from its foot until the tool's ghost stands on that wall (null: the wall is not seen). */
  const ghostOn = async (w: (typeof walls)[number], j: number): Promise<{ x: number; y: number; ghost: { opening: { edge: number; at: number; width: number }; problem: string | null } } | null> => {
    const foot = onScreen(...w.at(j));
    for (let dy = 4; dy <= 80; dy += 4) {
      const at = { x: Math.round(foot.x), y: Math.round(foot.y - dy) };
      await page.mouse.move(at.x, at.y);
      let s: (ToolStamp & { opening?: { ghost: { opening: { edge: number; at: number; width: number }; problem: string | null } | null } }) | null = null;
      await expect.poll(async () => { s = (await toolStamp(page)) as typeof s; return s?.hover?.at?.[0] === at.x && s.hover.at[1] === at.y; }, { timeout: 5_000 }).toBe(true);
      const hover = s!.hover;
      if (hover === null || hover.grid !== grid) continue;
      if (hover.normal.join() !== w.n.join()) return null;
      const g = s!.opening?.ghost ?? null;
      if (g !== null && g.opening.edge === w.edge) return { ...at, ghost: g };
      if (hover.cell[1]! > 3) return null;
    }
    return null;
  };
  // The first wall the view sees: a door a third of the way along it.
  let wall: (typeof walls)[number] | null = null;
  let doorAt: Awaited<ReturnType<typeof ghostOn>> = null;
  for (const w of walls) {
    doorAt = await ghostOn(w, Math.floor(w.len / 4));
    if (doorAt !== null) {
      wall = w;
      break;
    }
  }
  expect(wall, 'a wall of the shop seen from the view').not.toBeNull();
  expect(doorAt!.ghost.problem).toBeNull();
  await expect(hint).toContainText('Click: Door 1 × 2 m');
  await look(page, '01-openings-tool-ghost');
  const before = await still(page, 'openings-bare');
  await page.mouse.move(doorAt!.x, doorAt!.y);
  await expect.poll(async () => ((await toolStamp(page)) as { opening?: { ghost: unknown } } | null)?.opening?.ghost ?? null, { timeout: 5_000 }).not.toBeNull();
  let mark = (await drawn()).replaced;
  await page.mouse.down();
  await page.mouse.up();
  await redrawn(mark);
  const withDoor = await structureOf(id);
  const door = (withDoor['openings'] as { id: string; edge: number; at: number; width: number; height: number; sill: number; prop?: string }[])[0]!;
  expect(door).toMatchObject({ id: 'door-1', polygon: 'main', edge: wall!.edge, at: doorAt!.ghost.opening.at, width: 2, height: 4, sill: 0 });
  // The window: its size picked, the same wall two thirds along.
  await editMode(page).getByLabel('opening size', { exact: true }).selectOption({ label: 'Window 1 × 1 m (sill 1 m)' });
  const winAt = await ghostOn(wall!, Math.floor((wall!.len * 3) / 4));
  expect(winAt, 'the wall two thirds along').not.toBeNull();
  expect(winAt!.ghost.problem).toBeNull();
  mark = (await drawn()).replaced;
  await page.mouse.down();
  await page.mouse.up();
  await redrawn(mark);
  const openings = async (): Promise<{ id: string; edge: number; at: number; width: number; height: number; sill: number; prop?: string }[]> => (await structureOf(id))['openings'] as never;
  expect((await openings()).map((o) => o.id)).toEqual(['door-1', 'window-1']);
  expect((await openings())[1]).toMatchObject({ edge: wall!.edge, width: 2, height: 2, sill: 2 });
  await page.mouse.move(box.x + 30, box.y + 30);
  const holes = await still(page, 'openings-holes');
  expect(diff(before, holes).n, 'the two holes in the wall').toBeGreaterThan(300);
  await look(page, '02-door-and-window-placed');
  // The list says both, the door with no prop yet.
  const list = editMode(page).getByLabel('structure openings', { exact: true });
  await expect(list).toContainText('Door 1 × 2 m');
  await expect(list).toContainText('Window 1 × 1 m, sill 1 m');

  // ---- Props: the door's leaf, the window's pane (glass) -------------------------------------------------------
  const children = async (): Promise<{ id: string; components: Record<string, unknown> }[]> => (((await query('queryEntities', { limit: 100, offset: 0 })) as { entities: { id: string; parentId: string | null; components: Record<string, unknown> }[] }).entities ?? []).filter((e) => e.parentId === id);
  await list.locator('li[data-opening="door-1"] button').first().click();
  const picker = editMode(page).getByLabel('opening prop', { exact: true });
  await expect(picker).toBeEnabled({ timeout: 10_000 });
  // The models that fit a 1 × 2 m door: the leaf (the pane fits it too); never the crate.
  await expect(picker.locator('option')).toContainText(['none (an open hole)', 'Door leaf', 'Window pane']);
  expect(await picker.locator('option', { hasText: 'Big crate' }).count()).toBe(0);
  await look(page, '03-prop-picker');
  await picker.selectOption({ label: 'Door leaf' });
  await expect.poll(async () => (await openings())[0]!.prop ?? null, { timeout: 15_000, message: 'the door names its leaf' }).not.toBeNull();
  const leafId = (await openings())[0]!.prop!;
  const leafT0 = (((await query('queryEntity', { entityId: leafId })) as { entity: { components: { transform: { position: number[] }; voxelPortal: unknown } } }).entity.components);
  expect(leafT0.voxelPortal).toEqual({ open: false, stops: { light: true, sight: true, walk: true } });
  await list.locator('li[data-opening="window-1"] button').first().click();
  // A window starts as glass; its picker has the pane, not the 1 × 2 m leaf.
  await expect(editMode(page).getByLabel('opening prop glass')).toBeChecked();
  await expect(picker.locator('option')).toContainText(['none (an open hole)', 'Window pane']);
  expect(await picker.locator('option', { hasText: 'Door leaf' }).count()).toBe(0);
  await picker.selectOption({ label: 'Window pane' });
  await expect.poll(async () => (await openings())[1]!.prop ?? null, { timeout: 15_000, message: 'the window names its pane' }).not.toBeNull();
  const paneId = (await openings())[1]!.prop!;
  expect(((await query('queryEntity', { entityId: paneId })) as { entity: { components: { voxelPortal: unknown } } }).entity.components.voxelPortal).toEqual({ open: false, stops: { light: false, sight: true, walk: true } });
  await expect(list).toContainText('Door leaf (door-1), shut');
  await expect(list).toContainText('Window pane (window-1), shut, glass');
  await page.mouse.move(box.x + 30, box.y + 30);
  await expect.poll(async () => { const img = await still(page, 'openings-props'); return brownCount(img) > 150 && blueCount(img) > 60; }, { timeout: 20_000, message: 'the leaf and the pane drawn in their openings' }).toBe(true);
  await look(page, '04-door-prop-and-pane');
  const props = await still(page, 'openings-props');

  // ---- The door moved along its wall by its handle: 1 m; its leaf follows -------------------------------------
  await list.locator('li[data-opening="door-1"] button').first().click();
  const dh = await handle('opening:door-1');
  const s0 = onScreen(...wall!.at(5));
  const s1 = onScreen(...wall!.at(6));
  mark = (await drawn()).replaced;
  await page.mouse.move(dh.x, dh.y);
  await page.mouse.down();
  let p = { ...dh };
  for (let k = 0; k < 80 && !/\+1\.0 m along the wall/.test((await hint.textContent()) ?? ''); k++) {
    p = { x: p.x + (s1.x - s0.x) / 6, y: p.y + (s1.y - s0.y) / 6 };
    await page.mouse.move(p.x, p.y);
  }
  await expect(hint).toContainText('+1.0 m along the wall');
  await page.mouse.up();
  await redrawn(mark);
  expect((await openings())[0]!.at).toBe(door.at + 2);
  const leafT1 = (((await query('queryEntity', { entityId: leafId })) as { entity: { components: { transform: { position: number[] } } } }).entity.components.transform.position);
  expect(Math.hypot(leafT1[0]! - leafT0.transform.position[0]!, leafT1[2]! - leafT0.transform.position[2]!), 'the leaf moved with its door').toBeCloseTo(1, 6);
  await page.mouse.move(box.x + 30, box.y + 30);
  await look(page, '05-opening-moved');
  const movedShot = await still(page, 'openings-moved');
  expect(diff(props, movedShot).n, 'the door and its leaf drawn a metre on').toBeGreaterThan(150);

  // ---- The shop widened 1 m at the end of the door's wall: the openings and their props stay -------------------
  const openingsBefore = JSON.stringify(await openings());
  await editModeTab(page, 'Shape');
  await arm('Shape');
  const e = (wall!.edge + 1) % 4;
  const eh = await handle(`edge:0:${e}`);
  const n2 = walls[e]!.n;
  const f0 = onScreen(...walls[e]!.at(2));
  const f1 = onScreen(walls[e]!.at(2)[0] + n2[0]! * 2, walls[e]!.at(2)[1] + n2[2]! * 2);
  const want = e % 2 === 1 ? /^7\.0 × 5\.0 m/ : /^6\.0 × 6\.0 m/;
  await page.mouse.move(eh.x, eh.y);
  await page.mouse.down();
  p = { ...eh };
  for (let k = 0; k < 60 && !want.test((await hint.textContent()) ?? ''); k++) {
    p = { x: p.x + (f1.x - f0.x) / 8, y: p.y + (f1.y - f0.y) / 8 };
    await page.mouse.move(p.x, p.y);
  }
  await expect(hint).toHaveText(want);
  mark = (await drawn()).replaced;
  await page.mouse.up();
  await redrawn(mark);
  expect(JSON.stringify(await openings()), 'the openings stay on their wall').toBe(openingsBefore);
  expect((((await query('queryEntity', { entityId: leafId })) as { entity: { components: { transform: { position: number[] } } } }).entity.components.transform.position)).toEqual(leafT1);

  // ---- The window deleted (selected, Delete): its pane goes with it, one step ----------------------------------
  await editModeTab(page, 'Openings');
  await arm('Place');
  await editMode(page).getByLabel('structure openings', { exact: true }).locator('li[data-opening="window-1"] button').first().click();
  await page.mouse.move(box.x + 30, box.y + 30);
  mark = (await drawn()).replaced;
  await page.keyboard.press('Delete');
  await redrawn(mark);
  expect((await openings()).map((o) => o.id)).toEqual(['door-1']);
  await expect.poll(async () => (await children()).map((c) => c.id), { timeout: 10_000, message: 'the pane went with its window' }).toEqual([leafId]);
  await page.mouse.move(box.x + 30, box.y + 30);
  await expect.poll(async () => blueCount(await still(page, 'openings-no-window')), { timeout: 20_000, message: 'no pane drawn' }).toBeLessThan(20);

  // ---- Leave; undo every step back to no opening, then redo every one: the pictures equal -----------------------
  await editMode(page).getByRole('button', { name: /^Done/ }).click();
  await expect(editMode(page)).toHaveCount(0);
  await page.locator(`.tl-hierarchy__list li[data-entity-id="${marker}"]`).click();
  const final = await still(page, 'openings-final');
  const snapshot = async (): Promise<string> => JSON.stringify([(await structureOf(id))['openings'], (await structureOf(id)).footprint, (await children()).map((c) => c.id)]);
  const want0 = JSON.stringify([[], v0.footprint, []]);
  const finalState = await snapshot();
  // Each press once the editor shows the project's revision (an undo sent against an older one is refused as a
  // conflict) and the Scene view has drawn the shop's grid as it stands (pressed faster, its draw can stay a step
  // behind, the audit lists it).
  const caughtUp = async (): Promise<void> => {
    const rev = Number(((await query('queryProject', {})) as { revision: number }).revision);
    await expect(page.locator('.tl-statusbar')).toContainText(`revision ${rev}`, { timeout: 20_000 });
    await expect.poll(async () => (await drawn()).settled, { timeout: 20_000 }).toBe(true);
  };
  // Placed door, window, leaf, pane, moved door, widened, deleted window: seven steps.
  for (let k = 0; k < 7; k++) {
    const was = await snapshot();
    await caughtUp();
    await page.keyboard.press('Control+z');
    await expect.poll(snapshot, { timeout: 20_000, message: `undo ${k + 1}` }).not.toBe(was);
  }
  expect(await snapshot()).toBe(want0);
  for (let k = 0; k < 7; k++) {
    const was = await snapshot();
    await caughtUp();
    await page.keyboard.press('Control+Shift+z');
    await expect.poll(snapshot, { timeout: 20_000, message: `redo ${k + 1}` }).not.toBe(was);
  }
  expect(await snapshot()).toBe(finalState);
  await expect.poll(async () => diff(final, await still(page, 'openings-redone')).n, { timeout: 30_000, message: 'the shop as it was before the undo' }).toBeLessThan(200);
  console.log(`[structure] openings test ${((Date.now() - t0) / 1000).toFixed(1)} s`);
  expect(errors).toEqual([]);
});

/** Pixels of the plain water's blue (neither the sky's pale blue nor the grass). */
function waterCount(img: Image): number {
  let n = 0;
  for (let y = 0; y < img.height; y++) for (let x = 0; x < img.width; x++) {
    const [r, g, b] = img.pixel(x, y);
    if (b > r + 45 && b > g + 20 && b < 235) n++;
  }
  return n;
}

/** Pixels of the leak marker's red. */
function redCount(img: Image): number {
  let n = 0;
  for (let y = 0; y < img.height; y++) for (let x = 0; x < img.width; x++) {
    const [r, g, b] = img.pixel(x, y);
    if (r > 170 && r > g + 60 && r > b + 60) n++;
  }
  return n;
}

test('water bodies: a hollow becomes a lake from Add component, a bank dug back takes the water in the same stroke and one undo takes both back, the level handle raises it, a trench past the reach drains it with a warning and a marker, closing the trench fills it again', async ({ page }) => {
  test.setTimeout(180_000);
  const t0 = Date.now();
  await page.setViewportSize({ width: 1280, height: 720 });
  const errors = consoleErrors(page);
  await cmd('setMaterial', { material: { materialId: 'mat-water', name: 'Water', shader: 'standard', params: { color: '#2a5fc0' }, textures: {}, voxel: { id: MAT.water, use: 'liquid' } } });
  // The owner's pictures (TL_LOOK_DIR) are taken at the low tier.
  if ((process.env['TL_LOOK_DIR'] ?? '') !== '') await cmd('setEnvironment', { environment: { quality: 'low' } });
  const all = ((await query('queryEntities', { limit: 100, offset: 0 })) as { entities: { components: Record<string, unknown> }[] }).entities;
  if (!all.some((e) => (e.components['voxelWorld'] as { world?: string } | undefined)?.world === WORLD)) await cmd('createEntity', { sceneId: 'scene-main', parentId: null, kind: 'group', name: 'Yard', transform: { position: [0, 0, 0] }, components: { voxelWorld: { world: WORLD } } });
  // The hollow: 8 × 8 m, 2 m deep, dug in the yard's far corner (cells x −56…−41, z 40…55, rows −4…−1).
  const voxels = (command: Record<string, unknown>): Promise<Record<string, unknown>> => be.command({ op: 'editVoxels', projectId: be.projectId, args: { world: WORLD, command } }) as Promise<Record<string, unknown>>;
  const dig = (min: number[], max: number[]): Promise<Record<string, unknown>> => voxels({ v: 2, grid: 0, kind: 'fill', min, max, mode: 'dig' });
  const fill = (min: number[], max: number[]): Promise<Record<string, unknown>> => voxels({ v: 2, grid: 0, kind: 'fill', min, max, mode: 'add', voxel: { material: MAT.grass, role: 1, wetness: 0 } });
  expect((await dig([-56, -4, 40], [-41, -1, 55]))['ok']).toBe(true);
  const lake = String((await cmd('createEntity', { sceneId: 'scene-main', parentId: null, kind: 'group', name: 'Lake', transform: { position: [-24, -1, 24] } }))['createdId']);
  const marker = String((await cmd('createEntity', { sceneId: 'scene-main', parentId: null, kind: 'group', name: 'Marker 3', transform: { position: [400, 0, 0] } }))['createdId']);
  await page.goto(editorUrlFor(be.editorUrl, 'webgpu'));
  await expect(page.locator('.tl-statusbar')).toContainText('connected');
  const view = page.locator('canvas.tl-viewport');
  const box = (await view.boundingBox())!;
  const select = async (id: string): Promise<void> => page.locator(`.tl-hierarchy__list li[data-entity-id="${id}"]`).click();
  await select(lake);
  await page.keyboard.press('f');
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  for (let k = 0; k < 2; k++) await page.mouse.wheel(0, 300);
  const settled = async (): Promise<number> => {
    let rev = -1;
    await expect.poll(async () => { const v = (await sceneViewVoxels(page))?.states[WORLD]; rev = v?.revision ?? -1; return v?.settled === true; }, { timeout: 60_000, intervals: [16], message: 'the yard drawn as it stands' }).toBe(true);
    return rev;
  };
  await settled();
  const pictureOf = async (name: string): Promise<Image> => {
    await select(marker);
    const img = await still(page, name);
    await look(page, name);
    return img;
  };
  const hollow = await pictureOf('20-hollow');
  const inspect = inspector(page);
  const state = inspect.getByLabel('water state');
  const cells = async (): Promise<number> => Number((await state.getAttribute('data-cells')) ?? '-1');

  // ---- Made: Add component → Water body fills the hollow to the object's height -------------------------------------
  await select(lake);
  await inspect.getByLabel('add component', { exact: true }).selectOption({ label: 'Water body' });
  await expect.poll(async () => ((await query('queryEntity', { entityId: lake })) as { entity: { components: Record<string, unknown> } }).entity.components['waterBody']).toEqual({ world: WORLD, level: -1, material: MAT.water, reach: 256 });
  // Rows −4 and −3 under the level at −1 m: 16 × 16 × 2 cells.
  await select(lake);
  await expect.poll(cells, { timeout: 20_000, message: 'the Inspector says what the body holds' }).toBe(512);
  const madeRev = await settled();
  const filled = await pictureOf('21-lake-made');
  const blue0 = waterCount(hollow);
  const blue1 = waterCount(filled);
  console.log(`[water] blue pixels: hollow ${blue0}, lake ${blue1}`);
  expect(blue1 - blue0, 'the lake is drawn in the hollow').toBeGreaterThan(5_000);

  // ---- The bank dug back: the shore follows in the same stroke; one undo takes both back -----------------------------
  // The far field's rebuild after the body was made is built first (asked for, it builds what waits), so the dig's
  // time below is the dig's and its water's alone.
  await fetch(`${be.origin}/api/v1/projects/${be.projectId}/voxels/${WORLD}/far`, { headers: { authorization: `Bearer ${be.token}` } });
  const replacedBefore = (await sceneViewVoxels(page))?.replaced ?? 0;
  const sent = Date.now();
  const dug = await dig([-40, -4, 44], [-39, -1, 51]);
  const answered = Date.now() - sent;
  await expect.poll(async () => (await sceneViewVoxels(page))?.replaced ?? 0, { timeout: 20_000, intervals: [16], message: 'the dig and its water swapped in' }).toBeGreaterThan(replacedBefore);
  const swapped = Date.now() - sent;
  const water = dug['water'] as { bodies: Array<{ via: string; written: number }>; parts: number } | undefined;
  expect(water?.bodies[0]?.via, JSON.stringify(dug)).toBe('local');
  expect(water?.bodies[0]?.written).toBe(2 * 8 * 2);
  expect(water?.parts).toBe(32);
  await expect.poll(async () => (await sceneViewVoxels(page))?.states[WORLD]?.revision ?? 0, { timeout: 20_000, intervals: [16] }).toBeGreaterThan(madeRev);
  await settled();
  console.log(`[water] a bank dug back: answered ${answered} ms (the backend's apply ${(dug['ms'] as { apply: number }).apply.toFixed(1)} ms, save ${(dug['ms'] as { save: number }).save.toFixed(1)} ms, its water ${(water as unknown as { ms: number }).ms.toFixed(1)} ms), the Scene view's swap ${swapped} ms, settled (far field too) ${Date.now() - sent} ms after the send`);
  await select(lake);
  await expect.poll(cells, { timeout: 20_000 }).toBe(512 + 32);
  const shore = await pictureOf('22-bank-dug-shore-followed');
  expect(waterCount(shore), 'the water follows the dug bank').toBeGreaterThan(blue1);
  await view.hover();
  await page.keyboard.press('Control+z');
  await select(lake);
  await expect.poll(cells, { timeout: 20_000, message: 'one undo takes the dig and its water back' }).toBe(512);
  await settled();
  // The water's pixels as before the dig (the walls' shading follows the light as it settles, so pixels are not compared whole).
  const undone = waterCount(await pictureOf('23-bank-undone'));
  expect(Math.abs(undone - blue1) / blue1, 'the lake as it was before the dig').toBeLessThan(0.02);
  expect(undone).toBeLessThan(waterCount(shore));
  await view.hover();
  await page.keyboard.press('Control+Shift+z');
  await select(lake);
  await expect.poll(cells, { timeout: 20_000 }).toBe(544);
  await settled();

  // ---- The level handle over the object raises the water half a metre ------------------------------------------------
  await select(lake);
  type Grip = { component: string; kind: string; handle: string; x: number; y: number };
  const grips = async (): Promise<Grip[]> => JSON.parse((await view.getAttribute('data-size-handles')) ?? '[]') as Grip[];
  let grip: Grip | undefined;
  await expect.poll(async () => (grip = (await grips()).find((g) => g.component === 'waterBody' && g.kind === 'height')) !== undefined, { timeout: 10_000, message: 'the level handle' }).toBe(true);
  await page.mouse.move(grip!.x, grip!.y);
  await page.mouse.down();
  // A short drag (the ring is about 2 m across 100 pixels here): half a metre up, the snap's step, stays under the bank's top.
  for (let i = 1; i <= 4; i++) await page.mouse.move(grip!.x, grip!.y - i * 3);
  await page.mouse.up();
  await expect.poll(async () => (((await query('queryEntity', { entityId: lake })) as { entity: { components: { waterBody: { level: number } } } }).entity.components.waterBody.level), { timeout: 20_000, message: 'the level dragged up' }).toBeGreaterThan(-1);
  const raised = ((await query('queryEntity', { entityId: lake })) as { entity: { components: { waterBody: { level: number } } } }).entity.components.waterBody.level;
  expect(raised, 'the level stays under the ground round the hollow').toBeLessThan(0);
  await select(lake);
  await expect.poll(cells, { timeout: 20_000 }).toBeGreaterThan(544);
  await settled();
  await pictureOf('24-level-raised');
  // Lowered again in the Inspector's field.
  await select(lake);
  const level = inspect.getByLabel('water level', { exact: true });
  await level.fill('-1');
  await level.press('Enter');
  await select(lake);
  await expect.poll(cells, { timeout: 20_000 }).toBe(544);
  await settled();
  await pictureOf('25-level-lowered');
  console.log(`[water] the level dragged to ${raised} m and set back to -1 m`);

  // ---- A trench past an 8 m reach: drained, a warning in the Inspector, a marker where it leaks; closed: filled ------
  await select(lake);
  const reach = inspect.getByLabel('water reach', { exact: true });
  await reach.fill('8');
  await reach.press('Enter');
  await expect.poll(async () => (((await query('queryEntity', { entityId: lake })) as { entity: { components: { waterBody: { reach: number } } } }).entity.components.waterBody.reach)).toBe(8);
  const trench = await dig([-38, -4, 48], [-28, -3, 48]);
  expect(((trench['water'] as { bodies: Array<{ status: string }> }).bodies[0]!.status)).toBe('breached');
  await expect(inspect.getByLabel('water breach')).toBeVisible({ timeout: 20_000 });
  await expect(inspect.getByLabel('water breach')).toContainText('past its reach');
  const leaks = async (): Promise<number[][]> => JSON.parse((await view.getAttribute('data-water-leaks')) ?? '[]') as number[][];
  await expect.poll(async () => (await leaks()).length, { timeout: 20_000, message: 'the leak marked in the view' }).toBeGreaterThan(0);
  const at = (await leaks())[0]!;
  // 8 m from the seed along the trench (x −24 → −16 m), at the trench's rows.
  expect(at[0]!).toBeGreaterThan(-17);
  expect(at[0]!).toBeLessThan(-14);
  await settled();
  await inspect.getByLabel('water breach').scrollIntoViewIfNeeded();
  await look(page, '26-breach-warning-and-marker');
  const drained = await pictureOf('27-breach-drained');
  expect(waterCount(drained), 'nothing is held while it leaks').toBeLessThan(blue0 + 2_000);
  expect(redCount(drained), 'the marker drawn').toBeGreaterThan(20);
  expect((await fill([-38, -4, 48], [-38, -3, 48]))['ok']).toBe(true);
  await select(lake);
  await expect(inspect.getByLabel('water breach')).toHaveCount(0, { timeout: 20_000 });
  await select(lake);
  await expect.poll(cells, { timeout: 20_000 }).toBe(544);
  await expect.poll(async () => (await leaks()).length, { timeout: 20_000 }).toBe(0);
  await settled();
  expect(waterCount(await pictureOf('28-breach-closed')), 'the lake back').toBeGreaterThan(blue1 - 2_000);
  console.log(`[water] water body test ${((Date.now() - t0) / 1000).toFixed(1)} s`);
  expect(errors).toEqual([]);
});
