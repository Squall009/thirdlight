/**
 * World-aligned texture coordinates on block looks, against a real backend,
 * on both renderers (the mesher writes the coordinates; the renderer samples
 * them).
 *
 * A row of four 1 m kit blocks (a box model whose faces each take a small
 * patch of the texture, as a kit laid out for baking does) is drawn with an
 * unlit material whose texture is a ramp in red, one repeat per 4 m. With the
 * model's own coordinates every cell shows the same patch of the ramp (the
 * same narrow red band, starting over at each cell edge). With the block
 * type's texture mapping set to world in the Blocks panel (read back over
 * HTTP), the tops show the ramp once across the four cells: red rises along
 * the row and does not jump back at any cell edge.
 *
 * Normal maps on the world-mapped kit, tops and walls: the type's material
 * is then the standard shader with a flat normal map tilted toward the
 * image's top right (glTF convention). Each face read — a top, a wall facing
 * +Z, a wall facing +X — is lit by one sun from its image's top-right side
 * and then from the mirror side at the same angle to the face. Right
 * (tangent) and up (bitangent) both lean the right way only if the face is
 * clearly brighter under the first sun; one of them turned around cancels the
 * other (no lean), both turned around reverse it. In world terms (the box
 * mapping's signs): a top's image right is +X and its top −Z; a +Z wall's
 * right is +X, a +X wall's right −Z, and every wall's top is up.
 *
 * TL_WORLD_UV_DIR=<dir> keeps the pictures.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { expect, test, type Locator, type Page } from './pw';

import { publishBytes, startBackend, type E2EBackend } from './backend';
import { multiPieceGlb } from './multi-piece-glb';
import { decodePng, type Image } from './png';
import { makePng } from './png-make';
import { editorUrlFor, expectRendererBackend, onlyInItsProject, RENDERER_VARIANTS } from './renderer-variants';
import { menu, openWindow } from './ui';

let be: E2EBackend | null = null;
test.afterEach(async () => {
  await be?.stop();
  be = null;
});

async function query(op: string, args: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  return be!.command({ op, projectId: be!.projectId, args });
}

async function cmd(op: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const res = await be!.command({ op, projectId: be!.projectId, expectedRevision: Number((await query('queryProject')).revision), requestId: `req-${randomBytes(16).toString('hex')}`, origin: { kind: 'mcp', clientId: 'e2e-world-uv' }, args });
  expect(res['ok'], JSON.stringify(res).slice(0, 600)).toBe(true);
  return res;
}

/** The layer's min corner: the row of cells x 0..4, z 0..2 centred on the world origin. */
const ORIGIN = [-2, 0, -1] as const;
/** Metres the ramp texture spans (the material's tiling is its inverse). */
const RAMP_METRES = 4;

/** The Scene view's projector from its published view-projection matrix, for a picture of its canvas. */
async function sceneProjector(view: Locator): Promise<(p: [number, number, number]) => { x: number; y: number } | null> {
  const m = JSON.parse((await view.getAttribute('data-view-proj'))!) as number[];
  const box = (await view.boundingBox())!;
  return ([x, y, z]) => {
    const w = m[3]! * x + m[7]! * y + m[11]! * z + m[15]!;
    if (w <= 0) return null;
    const nx = (m[0]! * x + m[4]! * y + m[8]! * z + m[12]!) / w;
    const ny = (m[1]! * x + m[5]! * y + m[9]! * z + m[13]!) / w;
    return { x: ((nx + 1) / 2) * box.width, y: ((1 - ny) / 2) * box.height };
  };
}

/** Red along the row's tops (the middle of the two rows), every 5 cm from x 0.1 to 3.9 m in the layer. */
function redAlongRow(img: Image, project: (p: [number, number, number]) => { x: number; y: number } | null): number[] {
  const out: number[] = [];
  for (let i = 0; i <= 76; i++) {
    const x = 0.1 + i * 0.05;
    const s = project([ORIGIN[0] + x, ORIGIN[1] + 1, ORIGIN[2] + 1]);
    if (s === null) return [];
    const [r] = img.pixel(Math.round(s.x), Math.round(s.y));
    out.push(r);
  }
  return out;
}

/** The sample at x (m) along the row. */
const at = (red: readonly number[], x: number): number => red[Math.round((x - 0.1) / 0.05)]!;
/** At x (m), the red step across ±10 cm. */
const stepAt = (red: readonly number[], x: number): number => at(red, x + 0.1) - at(red, x - 0.1);

/** The model's own coordinates: every cell shows the same narrow band of the ramp. */
function samePatchPerCell(red: readonly number[]): string | null {
  if (red.length === 0) return 'the row is not in view';
  const range = Math.max(...red) - Math.min(...red);
  if (range > 70) return `red spans ${range} along the row: the ramp runs on (${red.join(',')})`;
  // The same spot of each cell shows the same red.
  const mid = [0.5, 1.5, 2.5, 3.5].map((x) => at(red, x));
  if (Math.max(...mid) - Math.min(...mid) > 14) return `cells differ at their middles: ${mid.join(',')}`;
  return null;
}

/** World coordinates: the ramp runs once across the row, rising everywhere and never jumping back at a cell edge. */
function oneRampAcross(red: readonly number[]): string | null {
  if (red.length === 0) return 'the row is not in view';
  const range = red[red.length - 1]! - red[0]!;
  if (range < 120) return `red rises only ${range} along the row (${red.join(',')})`;
  for (let i = 1; i < red.length; i++) if (red[i]! < red[i - 1]! - 8) return `red drops at x ${(0.1 + i * 0.05).toFixed(2)} m (${red.join(',')})`;
  for (const edge of [1, 2, 3]) {
    const s = stepAt(red, edge);
    if (s < 0 || s > 40) return `a seam at the cell edge x ${edge} m: step ${s} (${red.join(',')})`;
  }
  return null;
}

const keep = (name: string, png: Buffer): void => {
  const dir = process.env['TL_WORLD_UV_DIR'];
  if (dir === undefined || dir === '') return;
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${name}-${test.info().project.name}.png`), png);
};

/** The Scene view's picture until `check` passes on the red along the row. */
async function scenePicture(view: Locator, check: (red: number[]) => string | null, name: string): Promise<number[]> {
  const project = await sceneProjector(view);
  let red: number[] = [];
  let png: Buffer | null = null;
  let problem: string | null = 'no picture';
  await expect
    .poll(async () => {
      png = await view.screenshot();
      red = redAlongRow(decodePng(png), project);
      return (problem = check(red));
    }, { timeout: 30_000, intervals: [300], message: `Scene view picture (${name})` })
    .toBeNull()
    .catch((e: Error) => {
      throw new Error(`${e.message}\n${problem}`);
    });
  if (png !== null) keep(name, png);
  return red;
}

/**
 * The faces whose bump is read: a point in a cell's middle (world), the
 * face's normal, and the in-face direction of its image's top right.
 */
const BUMP_FACES = [
  { name: 'top', at: [-0.5, 1, -0.5], normal: [0, 1, 0], upRight: [1, 0, -1] },
  { name: 'wall +Z', at: [0.5, 0.5, 1], normal: [0, 0, 1], upRight: [1, 1, 0] },
  { name: 'wall +X', at: [2, 0.5, 0.5], normal: [1, 0, 0], upRight: [0, 1, -1] },
] as const;

/** The mean brightness of a 5 × 5 patch around a world point. */
function brightness(img: Image, project: (p: [number, number, number]) => { x: number; y: number } | null, at: readonly number[]): number {
  const c = project([at[0]!, at[1]!, at[2]!]);
  if (c === null) return NaN;
  let sum = 0;
  for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
    const [r, g, b] = img.pixel(Math.round(c.x) + dx, Math.round(c.y) + dy);
    sum += (r + g + b) / 3;
  }
  return sum / 25;
}

/** The Scene view's brightness at `at` once two pictures in a row agree (the view redraws after a change). */
async function settledBrightness(view: Locator, at: readonly number[], name: string): Promise<number> {
  const project = await sceneProjector(view);
  let last = NaN;
  let png: Buffer | null = null;
  await expect
    .poll(async () => {
      png = await view.screenshot();
      const now = brightness(decodePng(png), project, at);
      const same = Math.abs(now - last) < 1;
      last = now;
      return same;
    }, { timeout: 30_000, intervals: [400], message: `Scene view settles (${name})` })
    .toBe(true);
  if (png !== null) keep(name, png);
  return last;
}

async function frameRow(page: Page, view: Locator): Promise<void> {
  const box = (await view.boundingBox())!;
  const inView = async (): Promise<boolean> => {
    const project = await sceneProjector(view);
    for (const x of [0, 4]) for (const z of [0, 2]) {
      const s = project([ORIGIN[0] + x, ORIGIN[1] + 1, ORIGIN[2] + z]);
      if (s === null || s.x < 4 || s.x > box.width - 4 || s.y < 4 || s.y > box.height - 4) return false;
    }
    return true;
  };
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  for (let i = 0; i < 40 && !(await inView()); i++) {
    await page.mouse.wheel(0, 300);
    await page.waitForTimeout(80);
  }
  expect(await inView()).toBe(true);
}

for (const variant of RENDERER_VARIANTS) test(`block looks with world texture coordinates: a 4 m texture runs across four cells without a seam, set in the Blocks panel (${variant})`, async ({ page }) => {
  onlyInItsProject(variant, RENDERER_VARIANTS);
  test.setTimeout(300_000);
  be = await startBackend(`world-uv-${randomUUID().slice(0, 8)}`);
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));

  // The ramp: red = column (0..255), one repeat per 4 m; the kit: a 1 m box centred on its cell, faces laid out 3 × 2 in its UVs.
  await publishBytes(be, new Uint8Array(makePng(256, 16, (x) => [x, 0, 96, 255])), 'texture', 'ramp', 'ramp');
  await publishBytes(be, new Uint8Array(multiPieceGlb([{ name: 'tile', lods: [[1, 1, 1]] }], { lightmapUv: true, centred: true })), 'model', 'kit', 'kit');
  await cmd('setMaterial', { material: { materialId: 'mat-ramp', name: 'Ramp', shader: 'unlit', params: { tiling: [1 / RAMP_METRES, 1 / RAMP_METRES] }, textures: { map: 'ramp' } } });
  await cmd('setBlockType', { block: { blockId: 'tile', name: 'Tile', variants: [{ model: { assetId: 'kit', piece: 'tile' } }], shape: 'full', materials: { '*': 'mat-ramp' } } });
  await cmd('setEnvironment', { sceneId: 'scene-main', environment: { sky: { mode: 'color', color: '#303030' } } });
  const ents = ((await query('queryEntities', { limit: 100, offset: 0 })) as { entities: { id: string; components: Record<string, unknown> }[] }).entities;
  for (const e of ents) if (e.components['box'] !== undefined || e.components['model'] !== undefined) await cmd('setTransform', { entityId: e.id, transform: { position: [0, -50, 0] } });
  const layer = String((await cmd('createEntity', { sceneId: 'scene-main', parentId: null, kind: 'group', name: 'Row', transform: { position: [...ORIGIN] } }))['createdId']);
  await cmd('setComponent', { entityId: layer, component: 'blockLayer', value: { cellSize: [1, 1, 1], bounds: { min: [0, 0, 0], max: [4, 1, 2] }, castShadow: false, receiveShadow: false } });
  await cmd('editBlocks', { entityId: layer, edits: [{ kind: 'fill', box: [0, 0, 0, 4, 1, 2], cell: { block: 'tile' } }] });

  await page.goto(editorUrlFor(be.editorUrl, variant));
  await expect(page.locator('.tl-statusbar')).toContainText('connected');
  const view = page.locator('canvas.tl-viewport');
  await expectRendererBackend(view, variant);
  await expect.poll(async () => JSON.parse((await view.getAttribute('data-block-layers')) ?? '{"chunks":0}').chunks as number, { timeout: 30_000 }).toBe(1);
  await openWindow(page, 'Blocks');
  await expect(view).toHaveAttribute('data-view-proj', /\[/);
  await frameRow(page, view);
  // The objects' icons (the layer's, the lights') would cover the tops.
  await menu(page, 'Gizmos', 'Icons: on');

  // The model's own coordinates (the default): the same patch of the ramp in every cell.
  const own = await scenePicture(view, samePatchPerCell, 'model-uv');

  // World coordinates, chosen in the Blocks panel's block type form; read back over HTTP.
  const panel = page.getByLabel('blocks panel');
  await panel.getByRole('button', { name: 'block tile', exact: true }).click();
  await panel.getByLabel('block type form').getByLabel('blockType uv', { exact: true }).selectOption('world');
  await expect.poll(async () => ((await query('queryGameConfig')) as { blockTypes?: { blockId: string; uv?: string }[] }).blockTypes?.find((t) => t.blockId === 'tile')?.uv).toBe('world');
  const world = await scenePicture(view, oneRampAcross, 'world-uv');

  // ---- Normal maps on the world-mapped kit: the standard shader with a map tilted toward the image's top right.
  await publishBytes(be, new Uint8Array(makePng(16, 16, () => [204, 204, 200, 255])), 'texture', 'tilt', 'tilt');
  await cmd('setMaterial', { material: { materialId: 'mat-bump', name: 'Bump', shader: 'standard', params: { color: '#b4b4b4', roughness: 0.9 }, textures: { normalMap: 'tilt' } } });
  await cmd('setBlockType', { block: { blockId: 'tile', name: 'Tile', uv: 'world', variants: [{ model: { assetId: 'kit', piece: 'tile' } }], shape: 'full', materials: { '*': 'mat-bump' } } });
  // One sun, a faint ambient, no sky light.
  await cmd('setEnvironment', { sceneId: 'scene-main', environment: { sky: { mode: 'color', color: '#000000', intensity: 1, environmentIntensity: 0 } } });
  await cmd('setComponent', { entityId: 'light-0002', component: 'light', value: { type: 'ambient', color: '#ffffff', intensity: 0.05 } });
  const lean: string[] = [];
  const wrong: string[] = [];
  for (const f of BUMP_FACES) {
    // The sun travels toward the face from the top-right side, then from the mirror side.
    const lit: number[] = [];
    for (const side of [1, -1]) {
      const direction = f.normal.map((n, i) => -(n + side * f.upRight[i]!));
      await cmd('setComponent', { entityId: 'light-0001', component: 'light', value: { type: 'directional', color: '#ffffff', intensity: 3, direction, castShadow: false } });
      lit.push(await settledBrightness(view, f.at, `bump-${f.name.replace(/\W+/g, '')}-${side > 0 ? 'top-right' : 'mirror'}`));
    }
    lean.push(`${f.name} ${lit[0]!.toFixed(1)} vs ${lit[1]!.toFixed(1)}`);
    if (!(lit[0]! - lit[1]! >= 20)) wrong.push(`${f.name}: ${lit[0]!.toFixed(1)} from its image's top right, ${lit[1]!.toFixed(1)} from the mirror side`);
  }
  console.log(`world-mapped kit bump ${variant}: ${lean.join('; ')}`);
  expect(wrong, 'faces whose normal map does not lean toward its top-right sun').toEqual([]);

  expect(errors).toEqual([]);
  console.log(`world uv ${variant}: model ${own.join(',')}; world ${world.join(',')}`);
});
