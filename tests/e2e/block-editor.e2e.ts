/**
 * The block editor in the real editor against a real backend.
 *
 * A 64 × 16 × 64 layer (the interactive-editing target size) starts with its
 * lower half filled (32,768 cells), built from a kit. A double-click on its
 * Hierarchy row opens the block editor (the kit's block types first in the
 * palette, then the other types the layer holds). One path per tool family
 * through the editor and the Scene view: a single-cell stroke (one command,
 * one undo step, its latency measured), a rectangle with its readout, a
 * flood fill, the eyedropper (I) and replace, a selection saved as a stamp
 * and placed, an edge piece's rectangle (a room's outline on the cell
 * edges), the slice (PageUp). It opens in Navigate: a click selects a block
 * (its cell, its type in the block type editor) and Esc lets it go; a tool
 * is armed by its letter, dropped by a click on its tile or Esc, and Space
 * arms it again; with no tool a drag orbits. The block type editor edits a type in plain
 * controls: custom collision boxes, a model look from the model browser and
 * its weight, a connection piece, a theme. Regions: a rectangle of metadata
 * and its overlay, a region cut away and themed that follows its rename and
 * goes with its deletion. Paint: Make it paintable gives the stand-ins a
 * Layered surface. Lock: the tools refuse. Esc drops the tool, then leaves; the Inspector's Edit
 * blocks opens it again; GameObject → Block layer opens a new layer's editor,
 * and one undo takes the layer away and closes it.
 *
 * Outside the editor: with cell-top snapping on, a prop dragged over the
 * layer lands on the cells and its block footprint writes its metadata
 * beneath it in the same undo step as the move; the Inspector edits the
 * layer's cell size with x and z as one value (cells are square from above).
 *
 * Every result is read back from the backend (`queryBlocks`, `queryEntity`,
 * `queryGameConfig`). Browser-free checks (stroke edits, the brush's dabs,
 * the block type editor's edits, region follow-ups, the paint palette) are in
 * vitest (`block-brush.test.ts`, `block-mode.test.ts`).
 */
import { randomBytes } from 'node:crypto';

import { expect, test, type Page } from './pw';

import { publishBytes, startBackend, type E2EBackend } from './backend';
import { multiPieceGlb } from './multi-piece-glb';
import { decodePng } from './png';
import { editMode, editModeTab, inspector, leaveEditMode, menu, menuItem } from './ui';

/** Done's Esc badge (it says whether Esc would leave now). */
const escBadge = (page: Page) => editMode(page).locator('.tl-done kbd');

let be: E2EBackend | null = null;
test.afterEach(async () => {
  await be?.stop();
  be = null;
});

async function query(op: string, args: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  return be!.command({ op, projectId: be!.projectId, args });
}

async function cmd(op: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const res = await be!.command({ op, projectId: be!.projectId, expectedRevision: Number((await query('queryProject')).revision), requestId: `req-${randomBytes(16).toString('hex')}`, origin: { kind: 'mcp', clientId: 'e2e-block-editor' }, args });
  expect(res['ok'], JSON.stringify(res).slice(0, 600)).toBe(true);
  return res;
}

/** The layer: its min corner at (-8, -7.5, -8), so the top of the filled half (row 7) is at y = 0.5 (clear of the editor's ground grid). */
const ORIGIN = [-8, -7.5, -8] as const;
type V3 = [number, number, number];

/** A cell's top-face centre in world space. */
const top = (x: number, y: number, z: number): V3 => [ORIGIN[0] + x + 0.5, ORIGIN[1] + y + 1, ORIGIN[2] + z + 0.5];
/** A point at the middle of row `y` over the cell (x, z) (a rectangle stroke's plane). */
const mid = (x: number, y: number, z: number): V3 => [ORIGIN[0] + x + 0.5, ORIGIN[1] + y + 0.5, ORIGIN[2] + z + 0.5];

const view = (page: Page) => page.locator('canvas.tl-viewport');

/** World → client pixels through the Scene view's published view-projection matrix. */
async function screen(page: Page, p: V3): Promise<{ x: number; y: number }> {
  const m = JSON.parse((await view(page).getAttribute('data-view-proj'))!) as number[];
  const box = (await view(page).boundingBox())!;
  const [x, y, z] = p;
  const w = m[3]! * x + m[7]! * y + m[11]! * z + m[15]!;
  const nx = (m[0]! * x + m[4]! * y + m[8]! * z + m[12]!) / w;
  const ny = (m[1]! * x + m[5]! * y + m[9]! * z + m[13]!) / w;
  return { x: box.x + ((nx + 1) / 2) * box.width, y: box.y + ((1 - ny) / 2) * box.height };
}

/** Hover a world point and wait until the Scene view aims at the expected cell. */
async function aim(page: Page, p: V3, cell: V3): Promise<{ x: number; y: number }> {
  const s = await screen(page, p);
  await page.mouse.move(s.x - 3, s.y - 2);
  await page.mouse.move(s.x, s.y);
  await expect(view(page)).toHaveAttribute('data-block-hover', cell.join(','));
  return s;
}

/** Press on one point, drag through the others, release. */
async function stroke(page: Page, points: { x: number; y: number }[]): Promise<void> {
  await page.mouse.move(points[0]!.x, points[0]!.y);
  await page.mouse.down();
  for (const p of points.slice(1)) await page.mouse.move(p.x, p.y, { steps: 6 });
  await page.mouse.up();
}

async function cells(layer: string, box: number[]): Promise<Map<string, { block?: string; rot?: number; meta: Record<string, unknown> }>> {
  const r = (await query('queryBlocks', { entityId: layer, box })) as { box: { cells: number[][]; palette: { block?: string; rot?: number }[]; meta: Record<string, unknown>[] } };
  const out = new Map<string, { block?: string; rot?: number; meta: Record<string, unknown> }>();
  for (const c of r.box.cells) out.set(`${c[0]},${c[1]},${c[2]}`, { ...r.box.palette[c[3]!]!, meta: r.box.meta[c[3]!]! });
  return out;
}
const blockAt = async (layer: string, x: number, y: number, z: number): Promise<string | null> => (await cells(layer, [x, y, z, x + 1, y + 1, z + 1])).get(`${x},${y},${z}`)?.block ?? null;
const cellCount = async (layer: string): Promise<number> => ((await query('queryBlocks')) as { layers: { entityId: string; cells: number }[] }).layers.find((l) => l.entityId === layer)?.cells ?? 0;

type EntityView = { active?: boolean; locked?: boolean; components: { transform: { position: number[] }; blockLayer?: { cellSize: number[]; cutaway?: unknown; kits?: unknown; walk?: unknown } } };
async function entity(id: string): Promise<EntityView> {
  return ((await query('queryEntity', { entityId: id })) as { entity: EntityView }).entity;
}
type TypeView = { blockId: string; shape: string; boxes?: number[][]; variants: { model?: { assetId: string }; weight?: number; color?: string }[]; connect?: unknown; kits?: unknown; materials?: Record<string, string> };
const typeOf = async (id: string): Promise<TypeView | undefined> => ((await query('queryGameConfig')) as { blockTypes?: TypeView[] }).blockTypes?.find((t) => t.blockId === id);

const red = (r: number, g: number, b: number): boolean => r > 170 && g < 90 && b < 90;
function countPixels(png: Buffer, test: (r: number, g: number, b: number) => boolean): number {
  const img = decodePng(png);
  let n = 0;
  for (let y = 0; y < img.height; y += 2) for (let x = 0; x < img.width; x += 2) {
    const [r, g, b] = img.pixel(x, y);
    if (test(r, g, b)) n += 1;
  }
  return n;
}

const tile = (page: Page, id: string) => editMode(page).getByRole('radio', { name: `block ${id}`, exact: true });
const tool = (page: Page, name: string) => editMode(page).getByRole('toolbar', { name: 'block tool' }).getByRole('button', { name, exact: true });
const typeEditor = (page: Page) => editMode(page).getByLabel('block type editor', { exact: true });

test('the block editor builds, fills, picks, replaces, stamps and draws walls; edits block types, regions, metadata and paint; props snap to cell tops', async ({ page }) => {
  test.setTimeout(240_000);
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  be = await startBackend('block-editor-e2e');
  await cmd('setCellFields', { fields: [{ key: 'hazard', type: 'bool', color: '#ff0000' }] });
  for (const [blockId, color] of [['stone', '#6b7280'], ['grass', '#3fa34d'], ['sand', '#d8c27a']] as const) await cmd('setBlockType', { block: { blockId, name: blockId[0]!.toUpperCase() + blockId.slice(1), variants: [{ color }], shape: 'full' } });
  await cmd('setBlockType', { block: { blockId: 'wall', name: 'Wall', variants: [{ color: '#20c8f0' }], shape: 'full', placement: 'edge' } });
  await cmd('setKit', { kit: { kitId: 'yard', name: 'Yard', blockTypes: ['stone', 'grass', 'wall'] } });
  await publishBytes(be, new Uint8Array(multiPieceGlb([{ name: 'crate', lods: [[1, 1, 1]] }], { centred: true })), 'model', 'crate', 'Crate');
  const layer = String((await cmd('createEntity', { sceneId: 'scene-main', parentId: null, kind: 'group', name: 'Ground', transform: { position: [...ORIGIN] }, components: { blockLayer: { cellSize: [1, 1, 1], bounds: { min: [0, 0, 0], max: [64, 16, 64] }, kitId: 'yard' } } }))['createdId']);
  // A sand cell the kit does not hold: the palette lists it after the kit's types.
  await cmd('editBlocks', { entityId: layer, edits: [{ kind: 'fill', box: [0, 0, 0, 64, 8, 64], cell: { block: 'stone' } }, { kind: 'cells', at: [63, 7, 63], cell: { block: 'sand' } }] });
  expect(await cellCount(layer)).toBe(32_768);

  await page.goto(be.editorUrl);
  await expect(page.locator('.tl-statusbar')).toContainText('connected');
  await expect.poll(async () => JSON.parse((await view(page).getAttribute('data-block-layers')) ?? '{"chunks":0}').chunks as number, { timeout: 30_000 }).toBe(16);

  await test.step('a Hierarchy double-click opens the block editor in Navigate; the palette is the kit\'s types, then the layer\'s others', async () => {
    await page.locator(`.tl-hierarchy__list li[data-entity-id="${layer}"]`).dblclick();
    await expect(editMode(page)).toHaveAttribute('data-edit-mode', 'blocks');
    await expect(editMode(page).getByRole('radiogroup', { name: 'block palette' }).getByRole('radio')).toHaveText([/Stone/, /Grass/, /Wall/, /Sand.*not in the kit/]);
    await expect(view(page)).toHaveAttribute('data-block-tool', 'navigate');
    await expect(tool(page, 'Navigate')).toHaveAttribute('aria-pressed', 'true');
    await expect(tool(page, 'Single')).toHaveClass(/is-last/);
    await expect(editMode(page).getByLabel('edit mode hints')).toContainText('Last tool: Single');
    await expect(escBadge(page)).toHaveAttribute('data-esc-leaves', 'true');
    await expect(view(page)).toHaveAttribute('data-view-proj', /\[/);
  });

  await test.step('Navigate: a click selects a block (its cell; its type in the block type editor); Esc lets it go and stays', async () => {
    const at = await aim(page, top(6, 7, 9), [6, 7, 9]);
    await page.mouse.click(at.x, at.y);
    await expect(view(page)).toHaveAttribute('data-block-selection', '6,7,9,7,8,10');
    await expect(typeEditor(page)).toHaveAttribute('data-block-type', 'stone');
    await expect(escBadge(page), 'Esc deselects first').toHaveAttribute('data-esc-leaves', 'false');
    await expect(editMode(page).getByLabel('edit mode hints')).toContainText('Deselect');
    expect(await cellCount(layer), 'a click with no tool builds nothing').toBe(32_768);
    await page.keyboard.press('Escape');
    await expect(view(page)).toHaveAttribute('data-block-selection', '');
    await expect(editMode(page)).toBeVisible();
    // A letter arms its tool.
    await page.keyboard.press('q');
    await expect(view(page)).toHaveAttribute('data-block-tool', 'single');
    await expect(tool(page, 'Single')).toHaveAttribute('aria-pressed', 'true');
  });

  await test.step('single: a drag over three tops is one command and one undo step', async () => {
    await page.keyboard.press('2');
    await expect(tile(page, 'grass')).toHaveAttribute('aria-checked', 'true');
    await expect(typeEditor(page)).toHaveAttribute('data-block-type', 'grass');
    const a = await aim(page, top(8, 7, 8), [8, 8, 8]);
    const b = await screen(page, top(10, 7, 8));
    const revBefore = Number((await query('queryProject')).revision);
    await stroke(page, [a, b]);
    await expect.poll(() => blockAt(layer, 10, 8, 8)).toBe('grass');
    expect(await blockAt(layer, 9, 8, 8)).toBe('grass');
    expect(Number((await query('queryProject')).revision)).toBe(revBefore + 1);
    await expect(view(page)).toHaveAttribute('data-block-stroke', /"tool":"single"/);
    const timing = JSON.parse((await view(page).getAttribute('data-block-stroke'))!) as { cells: number; previewMs: number; commitMs: number };
    expect(timing.cells).toBe(3);
    test.info().annotations.push({ type: 'block stroke latency (64×64×16)', description: `preview ${timing.previewMs} ms (worst pointer move), commit ${timing.commitMs} ms (release → stored)` });
    expect(timing.previewMs).toBeLessThan(200);
    expect(timing.commitMs).toBeLessThan(5_000);
    await page.keyboard.press('Control+z');
    await expect.poll(() => cellCount(layer)).toBe(32_768);
    await page.keyboard.press('Control+y');
    await expect.poll(() => cellCount(layer)).toBe(32_771);
  });

  await test.step('rect (R) shows its size while dragged; flood (G) fills the connected top row', async () => {
    await page.keyboard.press('r');
    await expect(tool(page, 'Rect')).toHaveAttribute('aria-pressed', 'true');
    const a = await aim(page, top(4, 7, 4), [4, 8, 4]);
    await page.mouse.down();
    await page.mouse.move(...((p) => [p.x, p.y] as const)(await screen(page, mid(6, 8, 6))), { steps: 6 });
    await expect(page.getByRole('status', { name: 'shape readout' })).toContainText('3 × 3 m');
    await page.mouse.up();
    void a;
    await expect.poll(() => cellCount(layer)).toBe(32_771 + 9);
    expect(await blockAt(layer, 6, 9, 6)).toBeNull();
    await page.keyboard.press('4');
    await page.keyboard.press('g');
    await aim(page, top(2, 7, 10), [2, 7, 10]);
    await page.mouse.down();
    await page.mouse.up();
    await expect.poll(() => blockAt(layer, 40, 7, 40)).toBe('sand');
    expect(await blockAt(layer, 40, 6, 40)).toBe('stone');
  });

  await test.step('pick (I) takes a cell\'s block; replace (H) turns every block of a type into the brush\'s', async () => {
    await page.keyboard.press('i');
    await aim(page, top(8, 8, 8), [8, 8, 8]);
    await page.mouse.down();
    await page.mouse.up();
    await expect(tile(page, 'grass')).toHaveAttribute('aria-checked', 'true');
    await page.keyboard.press('1');
    await page.keyboard.press('h');
    await aim(page, top(2, 7, 10), [2, 7, 10]);
    await page.mouse.down();
    await page.mouse.up();
    await expect.poll(() => blockAt(layer, 63, 7, 63)).toBe('stone');
  });

  await test.step('select (S), save the selection as a stamp, place it', async () => {
    await page.keyboard.press('s');
    await stroke(page, [await aim(page, top(8, 8, 8), [8, 8, 8]), await screen(page, mid(10, 8, 8))]);
    await expect(view(page)).toHaveAttribute('data-block-selection', '8,8,8,11,9,9');
    await expect(editMode(page).getByLabel('selection box')).toContainText('3 cells');
    await editMode(page).getByLabel('stamp name').fill('Row piece');
    await editMode(page).getByRole('button', { name: 'Save as stamp', exact: true }).click();
    await expect(tool(page, 'Stamp')).toHaveAttribute('aria-pressed', 'true');
    expect(errors).toEqual([]);
    await aim(page, top(8, 7, 11), [8, 8, 11]);
    await page.mouse.down();
    await page.mouse.up();
    await expect.poll(() => blockAt(layer, 10, 8, 11)).toBe('grass');
    expect(await blockAt(layer, 8, 8, 11)).toBe('grass');
    await page.keyboard.press('Escape');
    await expect(view(page)).toHaveAttribute('data-block-selection', '');
    await expect(editMode(page)).toBeVisible();
  });

  await test.step('an edge piece\'s rect draws a room\'s outline on the cell edges in one command', async () => {
    type EdgeBox = { edges: number[][] };
    const edgesIn = async (box: number[]): Promise<EdgeBox> => ((await query('queryBlocks', { entityId: layer, box })) as { box: EdgeBox }).box;
    const floorAt = (x: number, z: number): V3 => [ORIGIN[0] + x, ORIGIN[1] + 8, ORIGIN[2] + z];
    await page.keyboard.press('3');
    await page.keyboard.press('r');
    const near = await screen(page, floorAt(1.1, 8.5));
    await page.mouse.move(near.x - 3, near.y);
    await page.mouse.move(near.x, near.y);
    await expect(view(page)).toHaveAttribute('data-block-edge', '1,8,8,0');
    const roomRev = Number((await query('queryProject')).revision);
    await stroke(page, [await screen(page, floorAt(1, 8)), await screen(page, floorAt(4, 10))]);
    await expect.poll(async () => (await edgesIn([1, 8, 8, 4, 9, 10])).edges.length).toBe(10);
    expect(Number((await query('queryProject')).revision)).toBe(roomRev + 1);
  });

  await test.step('PageUp moves the slice: the chip and the view follow', async () => {
    const slice = Number(await view(page).getAttribute('data-block-slice'));
    await page.keyboard.press('PageUp');
    await expect(view(page)).toHaveAttribute('data-block-slice', String(slice + 1));
    await expect(editMode(page).getByRole('group', { name: 'slice' })).toContainText(`level ${slice + 1}`);
    await page.keyboard.press('PageDown');
    await expect(view(page)).toHaveAttribute('data-block-slice', String(slice));
  });

  await test.step('the block type editor: custom boxes, a model look and its weight, a connection piece, a theme', async () => {
    await page.keyboard.press('2');
    const ed = typeEditor(page);
    await expect(ed).toHaveAttribute('data-block-type', 'grass');
    await ed.getByRole('radiogroup', { name: 'block collision' }).getByRole('radio', { name: 'Boxes', exact: true }).click();
    await expect.poll(async () => (await typeOf('grass'))?.boxes).toEqual([[0, 0, 0, 1, 1, 1]]);
    const toY = ed.getByLabel('box 1 to y', { exact: true });
    await toY.fill('0.5');
    await toY.press('Enter');
    await expect.poll(async () => (await typeOf('grass'))?.boxes).toEqual([[0, 0, 0, 1, 0.5, 1]]);
    await ed.getByRole('button', { name: 'add a model look', exact: true }).click();
    await page.getByRole('dialog', { name: 'block look picker' }).getByRole('option', { name: 'Crate', exact: true }).click();
    await expect.poll(async () => (await typeOf('grass'))?.variants.map((v) => v.model?.assetId ?? v.color)).toEqual(['#3fa34d', 'crate']);
    const weight = ed.getByLabel('look 2 weight', { exact: true });
    await weight.fill('3');
    await weight.press('Enter');
    await expect.poll(async () => (await typeOf('grass'))?.variants[1]?.weight).toBe(3);
    await ed.getByRole('switch', { name: 'block connects' }).click();
    await expect(ed.getByRole('switch', { name: 'block connects' })).toBeChecked();
    await ed.getByLabel('piece straight look', { exact: true }).selectOption('1');
    await expect.poll(async () => (await typeOf('grass'))?.connect).toEqual({ pieces: { straight: { variant: 1 } } });
    await ed.getByLabel('new theme', { exact: true }).fill('burnt');
    await ed.getByRole('button', { name: '+ Theme', exact: true }).click();
    await expect.poll(async () => (await typeOf('grass'))?.kits).toEqual({ burnt: { block: 'grass' } });
    await ed.getByLabel('theme burnt block', { exact: true }).selectOption('sand');
    await expect.poll(async () => (await typeOf('grass'))?.kits).toEqual({ burnt: { block: 'sand' } });
  });

  await test.step('Regions: a metadata rectangle and its overlay; a region cut away and themed follows its rename', async () => {
    await page.keyboard.press('Shift+4');
    await expect(editMode(page).getByRole('tab', { name: 'Regions', exact: true })).toHaveAttribute('aria-selected', 'true');
    const col = editMode(page).getByLabel('edit mode settings');
    await page.keyboard.press('m');
    await col.getByLabel('metadata field').selectOption('hazard');
    await col.getByRole('radiogroup', { name: 'metadata shape' }).getByRole('radio', { name: 'Rectangle' }).click();
    await stroke(page, [await aim(page, top(0, 7, 0), [0, 7, 0]), await screen(page, mid(3, 7, 5))]);
    await expect.poll(async () => [...(await cells(layer, [0, 7, 0, 4, 8, 6])).values()].filter((c) => c.meta['hazard'] === true).length).toBe(24);
    const redOff = countPixels(await view(page).screenshot(), red);
    await col.getByRole('button', { name: 'overlay hazard' }).click();
    await expect.poll(async () => Number((await view(page).getAttribute('data-block-overlay')) ?? 0)).toBe(24);
    await expect.poll(async () => countPixels(await view(page).screenshot(), red), { timeout: 20_000, message: 'the overlay in the Scene view' }).toBeGreaterThan(redOff + 150);
    await col.getByRole('button', { name: 'overlay hazard' }).click();
    await expect(view(page)).toHaveAttribute('data-block-overlay', '0');
    await cmd('editBlocks', { entityId: layer, edits: [{ kind: 'region', regionId: 'upper', op: 'set', boxes: [[0, 8, 0, 64, 16, 64]] }] });
    await col.getByLabel('cut away upper', { exact: true }).click();
    await expect.poll(async () => (await entity(layer)).components.blockLayer?.cutaway).toEqual({ regions: [{ region: 'upper' }] });
    await col.getByLabel('theme upper', { exact: true }).selectOption('burnt');
    await col.getByLabel('layer theme', { exact: true }).selectOption('burnt');
    // The themes in any order (each select is its own command).
    const themes = async (): Promise<string[]> => ((await entity(layer)).components.blockLayer?.kits as { kit: string; region?: string }[] | undefined ?? []).map((k) => `${k.kit}@${k.region ?? ''}`).sort();
    await expect.poll(themes).toEqual(['burnt@', 'burnt@upper']);
    await col.getByRole('button', { name: 'rename upper', exact: true }).click();
    const rename = col.getByLabel('rename region upper', { exact: true });
    await rename.fill('top');
    await rename.press('Enter');
    await expect.poll(async () => [(await entity(layer)).components.blockLayer?.cutaway, await themes()]).toEqual([{ regions: [{ region: 'top' }] }, ['burnt@', 'burnt@top']]);
    await col.getByRole('button', { name: 'delete region top', exact: true }).click();
    await expect.poll(async () => [(await entity(layer)).components.blockLayer?.cutaway, await themes()]).toEqual([undefined, ['burnt@']]);
    await col.getByLabel('layer theme', { exact: true }).selectOption('');
    await expect.poll(async () => (await entity(layer)).components.blockLayer?.kits).toBeUndefined();
    // The layer's size: grown on every side by the step, typed back, and a shrink past a block refused and said.
    type Bounds = { min: number[]; max: number[] };
    const bounds = async (): Promise<Bounds> => (await entity(layer)).components.blockLayer?.bounds as Bounds;
    const b0 = await bounds();
    await col.getByLabel('bounds step', { exact: true }).fill('2');
    await col.getByRole('button', { name: 'Grow every side', exact: true }).click();
    await expect.poll(bounds).toEqual({ min: [b0.min[0]! - 2, b0.min[1], b0.min[2]! - 2], max: [b0.max[0]! + 2, b0.max[1], b0.max[2]! + 2] });
    await col.getByRole('button', { name: 'Shrink every side', exact: true }).click();
    await expect.poll(bounds).toEqual(b0);
    const from = col.getByLabel('bounds from x', { exact: true });
    // The boxes show the stored bounds again before typing (a box re-made by the shrink's echo would drop the typing).
    await expect(from).toHaveValue(String(b0.min[0]));
    await from.fill(String(b0.min[0]! + 4));
    await from.press('Enter');
    await expect(col.getByRole('alert')).toContainText("can't shrink past a block");
    await expect(from).toHaveValue(String(b0.min[0]));
    expect(await bounds()).toEqual(b0);
  });

  await test.step('Paint: the stand-ins read no paint; Make it paintable gives the picked type a Layered surface, one undo step', async () => {
    await page.keyboard.press('Shift+3');
    const banner = editMode(page).getByRole('alert', { name: 'material does not read paint' });
    await expect(banner).toBeVisible();
    await banner.getByRole('button', { name: 'make it paintable' }).click();
    await expect.poll(async () => (await typeOf('grass'))?.materials?.['*'] ?? null, { timeout: 15_000 }).not.toBeNull();
    await expect(banner).toHaveCount(0);
    // The material and the type that wears it are one step: one undo takes both back, one redo brings both.
    const made = (await typeOf('grass'))!.materials!['*']!;
    const hasMaterial = async (): Promise<boolean> => (((await query('queryIndex', { kind: 'material', ids: [made], refs: false }))['entries'] as unknown[] | undefined) ?? []).length > 0;
    await page.keyboard.press('Control+z');
    await expect.poll(async () => [(await typeOf('grass'))?.materials?.['*'] ?? null, await hasMaterial()], { timeout: 15_000 }).toEqual([null, false]);
    await page.keyboard.press('Control+Shift+z');
    await expect.poll(async () => [(await typeOf('grass'))?.materials?.['*'] ?? null, await hasMaterial()], { timeout: 15_000 }).toEqual([made, true]);
    await expect(banner).toHaveCount(0);
    await expect(editMode(page).getByRole('radiogroup', { name: 'paint layers' }).getByRole('radio')).toHaveText([/Base/, /Layer 2/, /Layer 3/, /Layer 4/, /Wet/]);
  });

  await test.step('locked, no tool can be armed (Navigate) and nothing changes; unlocked, the tool is back', async () => {
    await page.keyboard.press('Shift+1');
    const before = await cellCount(layer);
    const lock = editMode(page).getByRole('switch', { name: 'lock layer' });
    await editMode(page).getByRole('button', { name: 'Layer', exact: true }).click();
    await lock.click();
    await expect.poll(async () => (await entity(layer)).locked).toBe(true);
    await expect(view(page)).toHaveAttribute('data-block-tool', 'navigate');
    await expect(editMode(page).getByLabel('edit mode hints')).toContainText('Ground is locked');
    await page.keyboard.press('q');
    await expect(view(page)).toHaveAttribute('data-block-tool', 'navigate');
    expect(await cellCount(layer)).toBe(before);
    await lock.click();
    await expect.poll(async () => (await entity(layer)).locked ?? false).toBe(false);
    // The tool armed before (Rect, from the edge piece step) is back.
    await expect(view(page)).toHaveAttribute('data-block-tool', 'rect');
  });

  await test.step('a click on the armed tile drops it, Space arms it again; Esc drops it, a drag then orbits and builds nothing, a second Esc leaves', async () => {
    await tool(page, 'Rect').click();
    await expect(view(page)).toHaveAttribute('data-block-tool', 'navigate');
    await page.keyboard.press('Space');
    await expect(view(page)).toHaveAttribute('data-block-tool', 'rect');
    await expect(escBadge(page), 'Esc drops the tool first').toHaveAttribute('data-esc-leaves', 'false');
    await page.keyboard.press('Escape');
    await expect(view(page)).toHaveAttribute('data-block-tool', 'navigate');
    await expect(escBadge(page)).toHaveAttribute('data-esc-leaves', 'true');
    const before = await cellCount(layer);
    const pose = await view(page).getAttribute('data-view-camera');
    const vb = (await view(page).boundingBox())!;
    const a = { x: vb.x + vb.width / 2, y: vb.y + vb.height / 2 };
    await stroke(page, [a, { x: a.x + 160, y: a.y + 20 }]);
    await expect.poll(() => view(page).getAttribute('data-view-camera'), { message: 'a drag with no tool orbits' }).not.toBe(pose);
    expect(await cellCount(layer)).toBe(before);
  });

  await test.step('Esc leaves; Edit blocks opens it again; GameObject → Block layer opens a new layer, one undo takes it away', async () => {
    await page.keyboard.press('Escape');
    await expect(editMode(page)).toHaveCount(0);
    await expect(view(page)).toHaveAttribute('data-block-tool', '');
    await page.locator(`.tl-hierarchy__list li[data-entity-id="${layer}"]`).click();
    await inspector(page).getByRole('button', { name: 'Edit blocks', exact: true }).click();
    await expect(editMode(page)).toHaveAttribute('data-entity-id', layer);
    await leaveEditMode(page);
    await menu(page, 'GameObject', 'Block layer');
    await expect(editMode(page)).toHaveAttribute('data-edit-mode', 'blocks');
    const made = await editMode(page).getAttribute('data-entity-id');
    expect(made).not.toBe(layer);
    await page.keyboard.press('Control+z');
    await expect(editMode(page)).toHaveCount(0);
    await expect.poll(async () => ((await query('queryBlocks')) as { layers: { entityId: string }[] }).layers.map((l) => l.entityId)).toEqual([layer]);
  });

  await test.step('cell-top snapping: a prop dragged over the layer lands on the cells, its footprint written with the move', async () => {
    await (await menuItem(page, 'Edit', 'Snapping settings…')).click();
    const dialog = page.getByRole('dialog', { name: 'Snapping settings' });
    await dialog.getByLabel('snap to cell tops').check();
    await dialog.getByRole('button', { name: 'Save', exact: true }).click();
    await cmd('setCellFields', { fields: [{ key: 'hazard', type: 'bool', color: '#ff0000' }, { key: 'lot', type: 'int', default: 0, min: 0, max: 99 }] });
    const hut = String((await cmd('createEntity', { sceneId: 'scene-main', parentId: null, kind: 'box', name: 'Hut', transform: { position: [-4.5, 3, -5.5] }, box: { size: [1, 1, 1], material: { color: '#dd8844' } } }))['createdId']);
    await cmd('setComponent', { entityId: hut, component: 'blockFootprint', value: { layer, set: { lot: 7 } } });
    await dragGizmoX(page, hut);
    await expect.poll(async () => (await entity(hut)).components.transform.position[1]).toBe(0.5);
    const p = (await entity(hut)).components.transform.position;
    expect(p[2]).toBe(-5.5);
    const cx = p[0]! - ORIGIN[0] - 0.5;
    const lotAt = async (x: number, y: number, z: number): Promise<unknown> => (await cells(layer, [x, y, z, x + 1, y + 1, z + 1])).get(`${x},${y},${z}`)?.meta['lot'];
    await expect.poll(() => lotAt(cx, 7, 2)).toBe(7);
    // One undo takes the move and the footprint back.
    await page.keyboard.press('Control+z');
    await expect.poll(async () => (await entity(hut)).components.transform.position).toEqual([-4.5, 3, -5.5]);
    expect(await lotAt(cx, 7, 2)).toBe(0);
  });

  await test.step('the Inspector edits the cell size with x and z as one value', async () => {
    await page.locator(`.tl-hierarchy__list li[data-entity-id="${layer}"]`).click();
    const cellField = (axis: string) => inspector(page).getByLabel(`blockLayer cellSize ${axis}`, { exact: true });
    await cellField('x').fill('2');
    await cellField('x').press('Enter');
    await expect.poll(async () => (await entity(layer)).components.blockLayer?.cellSize).toEqual([2, 1, 2]);
    await expect(cellField('z')).toHaveValue('2');
  });
});

/** Select an object in the Hierarchy and drag its gizmo's X arrow (one setTransform on release). */
async function dragGizmoX(page: Page, id: string): Promise<void> {
  const previous = (await view(page).getAttribute('data-gizmo-grab')) ?? 'null';
  await page.locator(`.tl-hierarchy__list li[data-entity-id="${id}"]`).click();
  await expect(page.locator(`.tl-hierarchy__list li[data-entity-id="${id}"]`)).toHaveClass(/is-selected|selected/);
  // The grip of this object (not the one selected before), settled over two reads.
  let last = '';
  await expect
    .poll(async () => {
      const now = (await view(page).getAttribute('data-gizmo-grab')) ?? 'null';
      const settled = now !== 'null' && now !== previous && now === last;
      last = now;
      return settled;
    }, { timeout: 15_000, intervals: [150] })
    .toBe(true);
  const g = JSON.parse(last) as { x: number; y: number; ax: number; ay: number };
  await page.mouse.move(g.ax, g.ay);
  await page.waitForTimeout(100);
  await page.mouse.down();
  await page.mouse.move(g.ax + (g.ax - g.x) * 2.5, g.ay + (g.ay - g.y) * 2.5, { steps: 10 });
  await page.mouse.up();
}
