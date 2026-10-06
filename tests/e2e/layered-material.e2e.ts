/**
 * Normal maps light the right way, and the layered material's per-layer
 * settings, against a real backend on both renderers.
 *
 * Normal-map green check. One normal map, flat colour (128, 204, 230): a
 * surface tilted toward the image's top (OpenGL / glTF convention, +Y up, as
 * the Texture Designer and glTF write them). It is drawn, lit by one sun
 * from the −Z side and then from the +Z side, on:
 * - painted terrain: the height-blended layers template on a block layer
 *   (its normal array holds the map in every layer);
 * - a plain graph material (one Normal map node) on block cells;
 * - the standard shader with the map as its normal map, on block cells;
 * - the plain graph material and the standard shader on boxes.
 * Block tops are world-mapped (the image's top toward −Z) and carry the
 * mesher's tangents; a box's top has the image's top toward +Z and no
 * tangents (the frame is derived from its UVs). So a block top must be
 * brighter under the sun from −Z, a box top under the sun from +Z.
 *
 * Per-layer settings: the Material editor's layer table (tiling in metres,
 * normal strength, height contrast and offset per layer) writes the
 * template's per-layer parameters (read back over HTTP); layer 1's normal
 * strength set to 0 there flattens the painted terrain (both suns light it
 * alike), the other surfaces keep their bump.
 *
 * TL_LAYERED_DIR=<dir> keeps the pictures.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { expect, test, type Locator, type Page } from './pw';

import { startBackend, type E2EBackend } from './backend';
import { materials, packTexture, publishTexture, useArrays } from './painted-layers';
import { decodePng, type Image } from './png';
import { makePng } from './png-make';
import { editorUrlFor, expectRendererBackend, onlyInItsProject, RENDERER_VARIANTS } from './renderer-variants';
import { closeEditor, createItem, editorPane, menu, openEditor, openWindow } from './ui';

let be: E2EBackend | null = null;
test.afterEach(async () => {
  await be?.stop();
  be = null;
});

async function query(op: string, args: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  return be!.command({ op, projectId: be!.projectId, args });
}

async function cmd(op: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const res = await be!.command({ op, projectId: be!.projectId, expectedRevision: Number((await query('queryProject')).revision), requestId: `req-${randomBytes(16).toString('hex')}`, origin: { kind: 'mcp', clientId: 'e2e-layered' }, args });
  expect(res['ok'], JSON.stringify(res).slice(0, 600)).toBe(true);
  return res;
}

/** The layer's min corner: six 1 m columns along X (two per material), two deep, their tops at y = 0.5 (above the Scene view's floor grid). */
const ORIGIN = [-3, -0.5, -2] as const;
/** The surfaces and the point of each top that is read (world). Block tops: the image's top toward −Z; box tops: toward +Z. */
const SURFACES = [
  { name: 'painted terrain', at: [-2, 0.5, -1], top: '-z' },
  { name: 'graph on blocks', at: [0, 0.5, -1], top: '-z' },
  { name: 'standard on blocks', at: [2, 0.5, -1], top: '-z' },
  { name: 'graph on a box', at: [-1.5, 0.75, 2], top: '+z' },
  { name: 'standard on a box', at: [1.5, 0.75, 2], top: '+z' },
] as const;
/** The sun travelling toward +Z (it shines from the −Z side) or toward −Z, 45° up. */
const FROM_MINUS_Z = [0, -1, 1];
const FROM_PLUS_Z = [0, -1, -1];

async function sceneProjector(view: Locator): Promise<(p: readonly [number, number, number]) => { x: number; y: number } | null> {
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

/** The mean brightness (0–255, the channels' mean) of a 7 × 7 patch around each surface's point. */
function readSurfaces(img: Image, project: (p: readonly [number, number, number]) => { x: number; y: number } | null): number[] {
  return SURFACES.map((s) => {
    const c = project(s.at);
    if (c === null) return NaN;
    let sum = 0;
    for (let dy = -3; dy <= 3; dy++) for (let dx = -3; dx <= 3; dx++) {
      const [r, g, b] = img.pixel(Math.round(c.x) + dx, Math.round(c.y) + dy);
      sum += (r + g + b) / 3;
    }
    return sum / 49;
  });
}

const keep = (name: string, png: Buffer): void => {
  const dir = process.env['TL_LAYERED_DIR'];
  if (dir === undefined || dir === '') return;
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${name}-${test.info().project.name}.png`), png);
};

/** The Scene view's reading once two pictures in a row agree (the view redraws after a change). */
async function settled(view: Locator, name: string): Promise<number[]> {
  const project = await sceneProjector(view);
  let last: number[] = [];
  let png: Buffer | null = null;
  await expect
    .poll(async () => {
      png = await view.screenshot();
      const now = readSurfaces(decodePng(png), project);
      const same = last.length === now.length && now.every((v, i) => Math.abs(v - last[i]!) < 1);
      last = now;
      return same && now.every((v) => Number.isFinite(v));
    }, { timeout: 30_000, intervals: [400], message: `Scene view settles (${name})` })
    .toBe(true);
  if (png !== null) keep(name, png);
  return last;
}

async function sun(direction: number[]): Promise<void> {
  await cmd('setComponent', { entityId: 'light-0001', component: 'light', value: { type: 'directional', color: '#ffffff', intensity: 3, direction, castShadow: false } });
}

/** Both suns' readings; for each surface, brightness from −Z minus brightness from +Z. */
async function sunSides(view: Locator, name: string): Promise<{ minus: number[]; plus: number[]; lean: number[] }> {
  await sun(FROM_MINUS_Z);
  await expect.poll(async () => JSON.stringify(await sunNow()), { timeout: 10_000 }).toBe(JSON.stringify(FROM_MINUS_Z));
  const minus = await settled(view, `${name}-sun-minus-z`);
  await sun(FROM_PLUS_Z);
  const plus = await settled(view, `${name}-sun-plus-z`);
  return { minus, plus, lean: minus.map((v, i) => v - plus[i]!) };
}

async function sunNow(): Promise<unknown> {
  const ents = ((await query('queryEntities', { limit: 200, offset: 0 })) as { entities: { id: string; components: Record<string, { direction?: number[] }> }[] }).entities;
  return ents.find((e) => e.id === 'light-0001')?.components['light']?.direction;
}

async function frame(page: Page, view: Locator): Promise<void> {
  const box = (await view.boundingBox())!;
  const inView = async (): Promise<boolean> => {
    const project = await sceneProjector(view);
    for (const p of [[-3, 0.5, -2], [3, 0.5, -2], [-2, 0.75, 3], [2, 0.75, 3]] as const) {
      const s = project(p);
      if (s === null || s.x < 8 || s.x > box.width - 8 || s.y < 8 || s.y > box.height - 8) return false;
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

/** A problem with the bump's side per surface, or null: block tops brighter from −Z, box tops from +Z. */
function bumpSides(lean: readonly number[], skip: readonly string[] = []): string | null {
  const bad = SURFACES.flatMap((s, i) => {
    if (skip.includes(s.name)) return [];
    const want = s.top === '-z' ? 1 : -1;
    return lean[i]! * want >= 12 ? [] : [`${s.name}: ${lean[i]!.toFixed(1)} (want ${want > 0 ? 'brighter' : 'darker'} from −Z)`];
  });
  return bad.length === 0 ? null : bad.join('; ');
}

for (const variant of RENDERER_VARIANTS) test(`normal maps light from the right side on painted terrain and plain materials; the layered material's per-layer settings (${variant})`, async ({ page }) => {
  onlyInItsProject(variant, RENDERER_VARIANTS);
  test.setTimeout(300_000);
  be = await startBackend(`layered-${randomUUID().slice(0, 8)}`);
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));

  // The normal map (tilted toward the image's top), a grey albedo with a mid height, and the ORM (rough, not metal).
  await publishTexture(be, new Uint8Array(makePng(16, 16, () => [128, 204, 230, 255])), 'tilt', 'Tilt');
  await publishTexture(be, new Uint8Array(makePng(16, 16, () => [180, 180, 180, 255])), 'grey', 'Grey');
  await publishTexture(be, new Uint8Array(makePng(16, 16, () => [255, 230, 0, 255])), 'orm-src', 'ORM');
  const four = <T,>(x: T): T[] => [x, x, x, x];
  await packTexture(be, four([{ assetId: 'grey', channel: 'r' }, { assetId: 'grey', channel: 'g' }, { assetId: 'grey', channel: 'b' }, { value: 128 }]), 'color', 'layers-albedo');
  await packTexture(be, four([{ assetId: 'tilt', channel: 'r' }, { assetId: 'tilt', channel: 'g' }, { assetId: 'tilt', channel: 'b' }, { value: 255 }]), 'normal', 'layers-normal');
  await packTexture(be, four([{ assetId: 'orm-src', channel: 'r' }, { assetId: 'orm-src', channel: 'g' }, { assetId: 'orm-src', channel: 'b' }, { value: 255 }]), 'data', 'layers-orm');

  // A plain graph material (one Normal map node) and the standard shader with the same map.
  await cmd('setMaterial', {
    material: {
      materialId: 'mat-plain',
      name: 'Plain bump',
      shader: 'standard',
      params: {},
      textures: {},
      graph: {
        nodes: [
          { id: 'out', type: 'pbr', position: [0, 0] },
          { id: 'n', type: 'normalMap', position: [-240, 0], data: { texture: 'tilt' } },
          { id: 'c', type: 'color', position: [-240, 120], data: { color: '#b4b4b4' } },
          { id: 'r', type: 'float', position: [-240, 240], data: { value: 0.9 } },
        ],
        edges: [
          { id: 'e1', from: { node: 'n', port: 'normal' }, to: { node: 'out', port: 'normal' } },
          { id: 'e2', from: { node: 'c', port: 'rgb' }, to: { node: 'out', port: 'baseColor' } },
          { id: 'e3', from: { node: 'r', port: 'value' }, to: { node: 'out', port: 'roughness' } },
        ],
      },
    },
  });
  await cmd('setMaterial', { material: { materialId: 'mat-std', name: 'Standard bump', shader: 'standard', params: { color: '#b4b4b4', roughness: 0.9 }, textures: { normalMap: 'tilt' } } });

  await page.goto(editorUrlFor(be.editorUrl, variant));
  await expect(page.locator('.tl-statusbar')).toContainText('connected');
  const view = page.locator('canvas.tl-viewport');
  await expectRendererBackend(view, variant);

  // The height-blended layers template (the editor's create menu), its arrays set.
  await createItem(page, ['Graph material', 'Height-blended layers (painted terrain)'], 'Terrain');
  await expect.poll(async () => (await materials(be!)).filter((m) => JSON.stringify(m.graph ?? {}).includes('heightBlend')).length, { timeout: 15_000 }).toBe(1);
  const terrain = (await materials(be)).find((m) => JSON.stringify(m.graph ?? {}).includes('heightBlend'))!.materialId;
  await useArrays(be, terrain, { albedoHeight: 'layers-albedo', normals: 'layers-normal', orm: 'layers-orm' });
  await closeEditor(page).catch(() => undefined);

  // The scene: no sky light, a faint ambient, the project's boxes out of the way.
  await cmd('setEnvironment', { sceneId: 'scene-main', environment: { sky: { mode: 'color', color: '#000000', intensity: 1, environmentIntensity: 0 } } });
  await cmd('setComponent', { entityId: 'light-0002', component: 'light', value: { type: 'ambient', color: '#ffffff', intensity: 0.05 } });
  const ents = ((await query('queryEntities', { limit: 200, offset: 0 })) as { entities: { id: string; components: Record<string, unknown> }[] }).entities;
  for (const e of ents) if (e.components['box'] !== undefined || e.components['model'] !== undefined) await cmd('setTransform', { entityId: e.id, transform: { position: [0, -60, 0] } });
  for (const [blockId, mat] of [['terrain', terrain], ['plain', 'mat-plain'], ['std', 'mat-std']] as const) await cmd('setBlockType', { block: { blockId, name: blockId, variants: [{ color: '#808080' }], shape: 'full', materials: { '*': mat } } });
  const layer = String((await cmd('createEntity', { sceneId: 'scene-main', parentId: null, kind: 'group', name: 'Tops', transform: { position: [...ORIGIN] } }))['createdId']);
  await cmd('setComponent', { entityId: layer, component: 'blockLayer', value: { cellSize: [1, 1, 1], bounds: { min: [0, 0, 0], max: [6, 1, 2] }, castShadow: false, receiveShadow: false } });
  await cmd('editBlocks', {
    entityId: layer,
    edits: [
      { kind: 'fill', box: [0, 0, 0, 2, 1, 2], cell: { block: 'terrain' } },
      { kind: 'fill', box: [2, 0, 0, 4, 1, 2], cell: { block: 'plain' } },
      { kind: 'fill', box: [4, 0, 0, 6, 1, 2], cell: { block: 'std' } },
    ],
  });
  for (const [x, mat] of [[-1.5, 'mat-plain'], [1.5, 'mat-std']] as const) {
    const id = String((await cmd('createEntity', { sceneId: 'scene-main', parentId: null, kind: 'box', name: `Box ${mat}`, box: { size: [1.6, 1, 1.6], material: { color: '#b4b4b4' } }, transform: { position: [x, 0.25, 2] } }))['createdId']);
    await cmd('setComponent', { entityId: id, component: 'materials', value: { '*': mat } });
  }

  await openWindow(page, 'Blocks');
  await expect(view).toHaveAttribute('data-view-proj', /\[/);
  await expect.poll(async () => JSON.parse((await view.getAttribute('data-block-layers')) ?? '{"chunks":0}').chunks as number, { timeout: 30_000 }).toBe(1);
  await frame(page, view);
  await menu(page, 'Gizmos', 'Icons: on');

  // ---- The green check: each top leans toward its image's top.
  const before = await sunSides(view, 'bump');
  console.log(`normal-map green ${variant}: ${SURFACES.map((s, i) => `${s.name} −Z ${before.minus[i]!.toFixed(1)} +Z ${before.plus[i]!.toFixed(1)}`).join('; ')}`);
  expect(bumpSides(before.lean)).toBeNull();

  // ---- Per-layer settings in the Material editor's layer table.
  await openEditor(page, 'Material', 'Terrain');
  const doc = editorPane(page, 'Material', 'Terrain');
  const table = doc.getByRole('table', { name: 'layer settings' });
  await expect(table).toBeVisible();
  const setCell = async (label: string, value: string): Promise<void> => {
    const f = table.getByLabel(label, { exact: true });
    await f.fill(value);
    await f.press('Enter');
  };
  await setCell('layer 2 tiling (m)', '2.5');
  await setCell('layer 3 height contrast', '2');
  await setCell('layer 4 height offset', '-0.25');
  await setCell('layer 1 normal strength', '0');
  const param = async (key: string): Promise<unknown> => (await materials(be!)).find((m) => m.materialId === terrain)!.parameters!.find((p) => p.key === key)?.default;
  await expect.poll(() => param('layerTiling'), { timeout: 15_000 }).toEqual([1, 2.5, 1, 1]);
  await expect.poll(() => param('layerContrast')).toEqual([1, 1, 2, 1]);
  await expect.poll(() => param('layerOffset')).toEqual([0, 0, 0, -0.25]);
  await expect.poll(() => param('layerNormalStrength')).toEqual([0, 1, 1, 1]);
  // A tiling of 0 is refused (the field shows the stored value again).
  await setCell('layer 2 tiling (m)', '0');
  await expect(table.getByLabel('layer 2 tiling (m)', { exact: true })).toHaveValue('2.5');
  await closeEditor(page);

  // Layer 1 (all of the unpainted terrain) without its bump: both suns light it alike; the rest keep theirs.
  const flat = await sunSides(view, 'layer1-flat');
  console.log(`layer 1 normal strength 0 ${variant}: terrain −Z ${flat.minus[0]!.toFixed(1)} +Z ${flat.plus[0]!.toFixed(1)}`);
  expect(Math.abs(flat.lean[0]!), `terrain lean ${flat.lean[0]} with layer 1's normal strength 0`).toBeLessThan(4);
  expect(bumpSides(flat.lean, ['painted terrain'])).toBeNull();

  expect(errors).toEqual([]);
});
