/**
 * A generated wall wearing the layered surface, painted with every layer and
 * wetness (layered-material.e2e.ts, the trim sheet test's backend).
 *
 * The material is the editor's layered template, set up in the Material
 * editor's layer table: layer 1 follows trim sheet A (the test sheet: the
 * wall's lower_wall row is magenta), layer 2 trim sheet B (a second sheet on
 * the same rows, all cyan) — both read at the wall's own UVs — and layers 3
 * and 4 are moss (green) and rust (orange), world-projected; the table then
 * says the twelve texture reads a pixel costs. The wall (one swept face,
 * 10 m long, 2.4 m tall, facing +z) is painted with one stroke per channel,
 * each at its own place along it: R (layer 2), G (layer 3), B (layer 4) and
 * A (wetness over the base); one place stays unpainted. The Scene view, with
 * the trim sheet test's sun and ambient, shows each place in its layer's
 * colour and the wet place as the clean one, darker.
 */
import { expect, type Locator, type Page } from './pw';

import type { E2EBackend } from './backend';
import { materials, publishTexture } from './painted-layers';
import { decodePng, type Image } from './png';
import { makePng } from './png-make';
import { sceneViewProjector } from './projected-decals-scene';
import { frameOn } from './rooms-drawing';
import { TEST_TRIM_COLOURS, TEST_TRIM_SHEET } from './trim-strips';
import { closeEditor, createItem, editorPane } from './ui';

type Cmd = (op: string, args: Record<string, unknown>) => Promise<Record<string, unknown>>;
type V3 = readonly [number, number, number];
type Rgb = readonly number[];

/** The wall object's place; the wall runs 10 m along +x from it, its face toward +z. */
const WALL_AT = [520, 0, 60] as const;
const WALL_LENGTH = 10;
const WALL_HEIGHT = 2.4;
/** Trim sheet B's colour (every row) and the tiling layers' colours; height in alpha (all at the top: a painted place shows only its layer). */
const TRIM_B: readonly [number, number, number] = [30, 190, 200];
const MOSS: readonly [number, number, number] = [50, 150, 30];
const RUST: readonly [number, number, number] = [200, 90, 25];
/** Metres along the wall of each place: the channel painted there (null: none). */
const PLACES = [
  { name: 'clean', along: 1, channel: null },
  { name: 'wet', along: 3, channel: 3 },
  { name: 'trimB', along: 5, channel: 0 },
  { name: 'moss', along: 7, channel: 1 },
  { name: 'rust', along: 9, channel: 2 },
] as const;
type Place = (typeof PLACES)[number]['name'];
const placeAt = (along: number): V3 => [WALL_AT[0] + along, WALL_HEIGHT / 2, WALL_AT[2]];

/** A colour's channels strongest first: each `strong` channel clearly over each `weak` one. */
const over = (c: Rgb, strong: readonly number[], weak: readonly number[]): boolean => strong.every((s) => weak.every((w) => c[s]! > c[w]! * 1.4));
const lum = (c: Rgb): number => c[0]! + c[1]! + c[2]!;

export interface LayeredWallReading {
  colours: Record<Place, [number, number, number]>;
  bad: string[];
  ok: boolean;
}

/** Whether each place shows its layer: magenta trim A, cyan trim B, green moss, orange rust, and the wet place magenta and darker than the clean one. */
export function judgeLayeredWall(read: (p: V3) => [number, number, number]): LayeredWallReading {
  const colours = Object.fromEntries(PLACES.map((p) => [p.name, read(placeAt(p.along))])) as Record<Place, [number, number, number]>;
  const magenta = (c: Rgb): boolean => TEST_TRIM_COLOURS['lower_wall']![0]! > 128 && over(c, [0, 2], [1]);
  const checks: [string, boolean][] = [
    ['clean', magenta(colours.clean)],
    ['wet', magenta(colours.wet) && lum(colours.wet) < lum(colours.clean) * 0.8],
    ['trimB', over(colours.trimB, [1, 2], [0])],
    ['moss', over(colours.moss, [1], [0, 2])],
    ['rust', over(colours.rust, [0], [1, 2]) && colours.rust[1]! > colours.rust[2]! * 1.4],
  ];
  const bad = checks.filter(([, ok]) => !ok).map(([k]) => k);
  return { colours, bad, ok: bad.length === 0 };
}

export const fmtLayeredWall = (r: LayeredWallReading): string => Object.entries(r.colours).map(([k, c]) => `${k} ${c.map((v) => v.toFixed(0)).join(',')}`).join('; ') + (r.bad.length > 0 ? ` | bad: ${r.bad.join(', ')}` : '');

/**
 * The second sheet, the tiling textures, the layered material (set up in the
 * Material editor's layer table) and the painted wall. Returns the wall's id.
 */
export async function makeLayeredWall(page: Page, be: E2EBackend, cmd: Cmd, trimId: string): Promise<{ wallId: string; materialId: string }> {
  const [w, h] = TEST_TRIM_SHEET.size;
  await publishTexture(be, new Uint8Array(makePng(w, h, () => [...TRIM_B, 255])), 'trim-b', 'Trim B sheet');
  await publishTexture(be, new Uint8Array(makePng(16, 16, () => [...MOSS, 255])), 'moss', 'Moss');
  await publishTexture(be, new Uint8Array(makePng(16, 16, () => [...RUST, 255])), 'rust', 'Rust');
  // Sheet B on sheet A's rows as they stand (one row table for every trim layer).
  const rows = ((await materials(be)) as unknown as { materialId: string; trim?: unknown }[]).find((x) => x.materialId === trimId)?.trim ?? TEST_TRIM_SHEET;
  await cmd('setMaterial', { material: { materialId: 'mat-trim-b', name: 'Trim B', shader: 'trim', params: {}, textures: { map: 'trim-b' }, trim: rows } });

  // The layered template from the Create menu, opened in the Material editor; its layers set up in the layer table.
  await createItem(page, ['Graph material', 'Height-blended layers (painted terrain)'], 'Walls');
  type Mat = { materialId: string; name: string; layerSheets?: string[]; parameters?: { key: string; default: unknown }[] };
  const walls = async (): Promise<Mat | undefined> => ((await materials(be)) as unknown as Mat[]).find((m) => m.name === 'Walls');
  await expect.poll(async () => (await walls())?.materialId, { timeout: 15_000 }).toBeDefined();
  const materialId = (await walls())!.materialId;
  const param = async (key: string): Promise<unknown> => (await walls())?.parameters?.find((p) => p.key === key)?.default;
  const doc = editorPane(page, 'Material', 'Walls');
  const table = doc.getByRole('table', { name: 'layer settings' });
  await expect(table).toBeVisible();
  await table.getByLabel('layer 1 trim sheet', { exact: true }).selectOption({ label: 'Trim' });
  await expect.poll(async () => (await walls())?.layerSheets, { timeout: 15_000 }).toEqual([trimId]);
  await table.getByLabel('layer 2 trim sheet', { exact: true }).selectOption({ label: 'Trim B' });
  // Following a sheet: its textures in the layer's slots, the mesh's own UVs.
  await expect.poll(async () => (await walls())?.layerSheets, { timeout: 15_000 }).toEqual([trimId, 'mat-trim-b']);
  await expect.poll(() => param('albedoHeight')).toEqual(['trim-sheet', 'trim-b', '', '']);
  await expect.poll(() => param('layerProjection')).toEqual([3, 3, 0, 0]);
  await expect(table.getByLabel('layer 1 UV source', { exact: true })).toHaveValue('3');
  for (const layer of [3, 4]) await table.getByLabel(`layer ${layer} UV source`, { exact: true }).selectOption({ label: 'world' });
  await expect.poll(() => param('layerProjection')).toEqual([3, 3, 1, 1]);
  // The tiling layers' colours (the palette's drop, as its command) and a metre's tiling.
  const m = (await materials(be)).find((x) => x.materialId === materialId)!;
  const parameters = (m.parameters ?? []).map((p) => (p.key === 'albedoHeight' ? { ...p, default: ['trim-sheet', 'trim-b', 'moss', 'rust'] } : p));
  await cmd('setMaterial', { material: { ...m, parameters } });
  await expect.poll(() => param('albedoHeight')).toEqual(['trim-sheet', 'trim-b', 'moss', 'rust']);
  await expect(doc.getByLabel('texture reads')).toContainText('Texture reads a pixel: 12.');
  await closeEditor(page);

  // The wall, then one stroke per channel at its place (full strength, a hard edge).
  const profiles = { face: { points: [[0, 0], [0, WALL_HEIGHT]], slots: ['lower_wall'] } };
  const wallId = String((await cmd('createEntity', { sceneId: 'scene-main', parentId: null, kind: 'group', name: 'Layered wall', transform: { position: [...WALL_AT] } }))['createdId']);
  await cmd('setComponent', { entityId: wallId, component: 'architecture', value: { profiles, elements: [{ id: 'wall', kind: 'sweep', path: { points: [[0, 0, 0], [WALL_LENGTH, 0, 0]] }, profile: 'face' }] } });
  await cmd('setComponent', { entityId: wallId, component: 'materials', value: { '*': materialId } });
  for (const p of PLACES) {
    if (p.channel === null) continue;
    // Wetness pools (only its full strength wets a high surface through), so its stroke reaches the vertices round its place.
    await cmd('paintVertices', { entityId: wallId, path: 'element:wall', side: 'right', dabs: [placeAt(p.along)], brush: { radius: p.channel === 3 ? 1.4 : 0.7, strength: 1, channel: p.channel, falloff: 'constant' } });
  }
  return { wallId, materialId };
}

/** The Scene view on the wall (focused, then framed), until its picture shows every layer. */
export async function expectLayeredWall(page: Page, view: Locator, wallId: string, keep: (name: string, png: Buffer) => void, label: string): Promise<LayeredWallReading> {
  await page.locator(`.tl-hierarchy__list li[data-entity-id="${wallId}"]`).click();
  const box = (await view.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  const before = await view.getAttribute('data-view-camera');
  await page.keyboard.press('f');
  // Moved, then still (the focus glides there).
  let last = before;
  await expect.poll(async () => {
    const now = await view.getAttribute('data-view-camera');
    const still = now !== before && now === last;
    last = now;
    return still;
  }, { timeout: 10_000, intervals: [200], message: 'the Scene view focused on the layered wall' }).toBe(true);
  // Deselected: the selection tint is not the wall's colour.
  await page.keyboard.press('Escape');
  await frameOn(page, [placeAt(0), placeAt(WALL_LENGTH), [WALL_AT[0], WALL_HEIGHT, WALL_AT[2]], [WALL_AT[0] + WALL_LENGTH, WALL_HEIGHT, WALL_AT[2]]]);
  let reading: LayeredWallReading | null = null;
  let png: Buffer | null = null;
  await expect
    .poll(async () => {
      const project = await sceneViewProjector(view);
      png = await view.screenshot();
      const img: Image = decodePng(png);
      reading = judgeLayeredWall((p) => {
        const s = project(p);
        if (s === null) return [0, 0, 0];
        const sum = [0, 0, 0];
        for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
          const [r, g, b] = img.pixel(Math.round(s.x) + dx, Math.round(s.y) + dy);
          sum[0] += r;
          sum[1] += g;
          sum[2] += b;
        }
        return sum.map((v) => v / 25) as [number, number, number];
      });
      return reading.ok;
    }, { timeout: 45_000, intervals: [500], message: `the layered wall (${label})` })
    .toBe(true)
    .catch((e: unknown) => {
      if (reading !== null) console.log(`layered wall ${label} (failed): ${fmtLayeredWall(reading)}`);
      if (png !== null) keep('layered-wall-failed', png);
      throw e;
    });
  if (png !== null) keep('layered-wall', png);
  return reading!;
}
