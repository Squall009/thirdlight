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
 * Trim sheets (the same page, one backend): a trim sheet material made from
 * the Create menu, its row table read from a Texture Designer layout.json
 * and edited in the Inspector's table (an overlapping row refused, a row's
 * own density saved), its albedo set and its padding checked on the
 * backend. Then Play looks along a floor of strips, one patch per row of a
 * test sheet (`trim-strips.ts`: solid rows of unequal height, each padding
 * its own colour) from 4 to 30 m away: every patch shows only its row's
 * colour at every distance — the grazing angle that asks for the deepest
 * mips. The same strips with the standard material and the same sheet
 * (no footprint cap) show their neighbours' colours far away, so the
 * picture can see a bleed. A strip patch with vertex grime takes the grime
 * colour, one with vertex wetness is darker, with no texture of their own.
 *
 * Generated architecture on the same sheet (one object, only parameters
 * stored): a profile swept along a path (a moulding: a wall face, a bevel,
 * a band, a bevel) and a row of columns (a profile swept round a small
 * square, made once and stamped every 3 m), generated at load on the
 * generator workers. In Play each wears its rows' colours (magenta face,
 * blue band, green column); the static export, served with the backend
 * stopped, generates them again and shows the same colours. The chunk and
 * ready marks give the generation times.
 *
 * Architecture styles and presets: two wall styles (graphs) and presets
 * deriving from each other, the trim sheet named by the preset, outlines
 * styled by them. In the editor, a preset from the Create menu shows its
 * sliders; dragging one in the object's Inspector regenerates only the
 * room its preset styles (ready marks timed from each input), the release
 * stores the value, and the Inspector's restyle swaps the outline's preset
 * without touching it. In Play and the export: a painted mask drives the
 * walls' height (every other wall 3 m tall, the rest 1 m), and a script's
 * `ctx.grid.setArchitecturePreset` swaps the last two walls' preset for one
 * with another style (another row of the sheet).
 *
 * Rooms and paths (`rooms-drawing.ts`): drawn with a block layer's Rooms
 * tool on a floor of cells — two rooms sharing a wall, an arch in the
 * front one and a door in the shared wall, a fence path — the door edited
 * in the room inspector, a wall dragged (only the rooms object made again,
 * timed from each input), grime painted on a wall with the Paint texture
 * tool. In Play and the export: the front wall's rows, the grime, the shared
 * wall's front face through the arch, the back room through the door and a
 * fence post each show their colour.
 *
 * Rooms light and cull by room (`rooms-lighting.ts`, furniture too): a lamp without a
 * shadow in one room lights its floor and not the floor of the room across
 * the wall (Play and the export); a room behind a closed door is not seen
 * and its box is not drawn (Play's diagnostics, the export's canvas).
 *
 * A building (`buildings.ts`): a two-storey L drawn with the Rooms tool's
 * Building mode, a hip roof, its interior a scene of its own set in the
 * building inspector. In Play and the export: the facade, the inner wall
 * through both windows and the roof each show their row; the interior's
 * scene is read ahead while its door is near the camera (Play's
 * observation); a script goes through the door on a key (`ctx.grid.doorLink`
 * → `ctx.scenes.load`) and the interior's camera shows the inner wall
 * beside the windows and the sky through them, at the same place on the
 * wall. Play's scene timings give the interior's time from the door to
 * drawn.
 *
 * Floor plans and furnishing (`floor-plans.ts`): a building split into
 * rooms by a room program and furnished by a furnishing set picked in the
 * building inspector, a prop pinned through a new seed and unpinned. In
 * Play and the export, from above (a key loads a scene with a camera over
 * it): the props stand where the generator put them, facing their rooms,
 * the floor in front of each door between rooms is clear, the partitions
 * stand between the rooms.
 *
 * TL_LAYERED_DIR=<dir> keeps the pictures.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { expect, test, type Locator, type Page } from './pw';

import { publishBytes, publishScript, startBackend, type E2EBackend } from './backend';
import { materials, packTexture, publishTexture, useArrays } from './painted-layers';
import { decodePng, type Image } from './png';
import { makePng } from './png-make';
import { stripPatchCentre, TEST_TRIM_CELL, TEST_TRIM_COLOURS, TEST_TRIM_SHEET, testTrimLayoutJson, testTrimSheetPng, trimStripsGlb } from './trim-strips';
import { editorUrlFor, expectRendererBackend, exportQueryFor, onlyInItsProject, RENDERER_VARIANTS, type RendererVariant } from './renderer-variants';
import { serveDir } from './frame-reading';
import { chooseItem, closeEditor, createItem, editorPane, inspector, menu, openEditor, openWindow } from './ui';
import { drawRooms, ROOM_READS } from './rooms-drawing';
import { expectCulled, judgeLitRooms, makeLitRooms } from './rooms-lighting';
import { drawBuilding, ENTER_KEY, judgeInside, judgeOutside, onInterior } from './buildings';
import { judgePlans, makeFloorPlans, onPlans, planReads, PLANS_KEY, type PlanReads } from './floor-plans';

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

for (const variant of RENDERER_VARIANTS) test(`normal maps light from the right side on painted terrain and plain materials; the layered material's per-layer settings; a trim sheet's rows without bleeding (${variant})`, async ({ page }) => {
  onlyInItsProject(variant, RENDERER_VARIANTS);
  test.setTimeout(420_000);
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

  await trimSheetChecks(page, variant);
  expect(errors).toEqual([]);
});

/** The trim patches in Play: the material's six (four rows, then floor with vertex grime, floor with vertex wetness), the standard material's four. */
const TRIM_PATCHES = [{ slot: 'floor' }, { slot: 'baseboard' }, { slot: 'crown' }, { slot: 'lower_wall' }, { slot: 'floor', colour: [0, 1, 0] as const }, { slot: 'floor', colour: [0, 0, 1] as const }];
/** Where the strips lie (world): the trim model's and the standard model's corners, the eye, its pitch and lens. */
const TRIM_AT = [196, 0, 0] as const;
const STANDARD_AT = [200.3, 0, 0] as const;
const EYE = [200, 1.2, 1.5] as const;
const PITCH = (-12 * Math.PI) / 180;
const FOV_Y = 50;
/** Distances along the strips the patches are read at (metres from their near edge): near, middle, far. */
const TRIM_DEPTHS = [4, 10, 30] as const;

/** A world point on the Play picture (`w` × `h`) of the fixed camera at EYE, pitched down by PITCH. */
function onPlay(p: readonly number[], w: number, h: number): { x: number; y: number } {
  const d = [p[0]! - EYE[0], p[1]! - EYE[1], p[2]! - EYE[2]];
  const fwd = [0, Math.sin(PITCH), -Math.cos(PITCH)];
  const up = [0, Math.cos(PITCH), Math.sin(PITCH)];
  const z = d[0]! * fwd[0]! + d[1]! * fwd[1]! + d[2]! * fwd[2]!;
  const t = Math.tan((FOV_Y * Math.PI) / 360);
  return { x: ((d[0]! / (z * t * (w / h)) + 1) / 2) * w, y: ((1 - (d[0]! * up[0]! + d[1]! * up[1]! + d[2]! * up[2]!) / (z * t)) / 2) * h };
}

/** The mean colour of the 3 × 3 pixels at a point. */
function colourAt(img: Image, at: { x: number; y: number }): [number, number, number] {
  const sum = [0, 0, 0];
  for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
    const [r, g, b] = img.pixel(Math.round(at.x) + dx, Math.round(at.y) + dy);
    sum[0] += r;
    sum[1] += g;
    sum[2] += b;
  }
  return sum.map((v) => v / 9) as [number, number, number];
}

/** Whether a reading has its row's hue: each of the row's strong channels clearly over each of its weak ones (lit, tone mapped). */
function rowHue(slot: string, c: readonly number[]): boolean {
  const ref = TEST_TRIM_COLOURS[slot]!;
  return ref.every((v, k) => v < 128 || ref.every((w, j) => w >= 128 || c[k]! > c[j]! * 1.5));
}

/** Whether two readings are the same colour: their channel shares within 0.04 and their brightness within −30 % / +40 %. */
function sameColour(a: readonly number[], b: readonly number[]): boolean {
  const sa = a[0]! + a[1]! + a[2]!;
  const sb = b[0]! + b[1]! + b[2]!;
  return sa > 0 && sb > 0 && sa / sb > 0.7 && sa / sb < 1.4 && a.every((v, k) => Math.abs(v / sa - b[k]! / sb) < 0.04);
}

/** Generated architecture beside the strips (world points; the object at the origin): a swept moulding left of them, columns right of them. */
const ARCHITECTURE = {
  profiles: {
    // Up the wall face, a bevel out, a band, a bevel back (faces look right of travel: toward the camera).
    moulding: { points: [[0, 0], [0, 1], [0.15, 1.15], [0.15, 1.45], [0, 1.6]], slots: ['lower_wall', 'baseboard', 'crown', 'baseboard'] },
    // A column's face, drawn down so it looks out of the square it is swept round.
    shaft: { points: [[0, 2.2], [0, 0]], slots: ['baseboard'] },
  },
  elements: [
    { id: 'moulding', kind: 'sweep', path: { points: [[193.5, 0, -6], [193.5, 0, -16]] }, profile: 'moulding' },
    { id: 'columns', kind: 'repeat', path: { points: [[204.5, 0, -8], [204.5, 0, -14]] }, spacing: 3, piece: { elements: [{ id: 'shaft', kind: 'sweep', path: { points: [[-0.2, 0, -0.2], [0.2, 0, -0.2], [0.2, 0, 0.2], [-0.2, 0, 0.2]], closed: true }, profile: 'shaft' }] } },
  ],
};
/** Where the architecture is read: the moulding's wall face and band, the middle column's front face. */
const ARCH_READS = [
  { slot: 'lower_wall', at: [193.5, 0.6, -11] },
  { slot: 'crown', at: [193.65, 1.3, -11] },
  { slot: 'baseboard', at: [204.5, 1.1, -10.79] },
] as const;

/** The architecture's colours in a picture of the fixed camera, and whether each has its row's hue. */
function readArchitecture(img: Image): { colours: [number, number, number][]; ok: boolean } {
  const colours = ARCH_READS.map((r) => colourAt(img, onPlay(r.at, img.width, img.height)));
  return { colours, ok: colours.every((c, i) => rowHue(ARCH_READS[i]!.slot, c)) };
}

/** The page's generated-architecture marks: chunks made (where, ms) and objects ready (ms from their parameters to drawn). */
async function architectureMarks(target: Locator | Page): Promise<{ chunks: { ms: number; where: string }[]; ready: { ms: number; first: boolean }[] }> {
  const read = (): { chunks: { ms: number; where: string }[]; ready: { ms: number; first: boolean }[] } => {
    const marks = performance.getEntriesByType('mark') as PerformanceMark[];
    return {
      chunks: marks.filter((m) => m.name === 'tl:arch:chunk').map((m) => ({ ...(m.detail as { ms: number; where: string }), at: Math.round(m.startTime) })),
      ready: marks.filter((m) => m.name === 'tl:arch:ready').map((m) => ({ ...(m.detail as { ms: number; first: boolean }), at: Math.round(m.startTime) })),
    };
  };
  // A locator evaluates in its frame (Play's iframe), a page in its own.
  return (target as Page).evaluate(read);
}

/** A style of one wall swept along its outline, its height a parameter, every face on `slot`. */
function wallStyle(slot: string): Record<string, unknown> {
  return {
    nodes: [
      { id: 'outline', type: 'outline', position: [0, 0] },
      { id: 'height', type: 'parameter', position: [0, 150], data: { name: 'height', default: 1, min: 0.5, max: 3 } },
      { id: 'wall', type: 'wall', position: [260, 0], data: { thickness: 0.2, inside: slot, outside: slot, top: slot, lower: slot } },
      { id: 'sweep', type: 'sweep', position: [520, 0] },
      { id: 'output', type: 'output', position: [780, 0] },
    ],
    edges: [
      { id: 'e1', from: { node: 'height', port: 'value' }, to: { node: 'wall', port: 'height' } },
      { id: 'e2', from: { node: 'outline', port: 'path' }, to: { node: 'sweep', port: 'path' } },
      { id: 'e3', from: { node: 'wall', port: 'profile' }, to: { node: 'sweep', port: 'profile' } },
      { id: 'e4', from: { node: 'sweep', port: 'element' }, to: { node: 'output', port: 'elements' } },
    ],
  };
}
const presetGraph = (style: string, base: string, sheet: string, extra: Record<string, unknown>[] = []): Record<string, unknown> => ({ nodes: [{ id: 'preset', type: 'preset', position: [0, 0], data: { style, base, sheet } }, ...extra], edges: [] });
/** Six 1.4 m walls in a row 45 m in front of the camera; the painted mask "tall" over the second, fourth and sixth. */
const STYLED_WALLS = [0, 1, 2, 3, 4, 5].map((i) => ({ x0: 194.6 + i * 1.8, x1: 196 + i * 1.8 }));
const STYLED_Z = -45;
/** Swaps the walls' second preset for the third on the first step (the game's own restyle, at run time). */
const RESTYLE_SCRIPT = [
  'export default {',
  '  instantiate() { return { swapped: false }; },',
  '  step(state, ctx) {',
  "    if (ctx.phase !== 'intent' || state.swapped) return;",
  "    state.swapped = ctx.grid.setArchitecturePreset('e2e-c', 'e2e-b');",
  "    ctx.log('info', `restyled ${state.swapped} ${ctx.grid.architecturePreset('e2e-c')}`);",
  '  },',
  '};',
].join('\n');

/**
 * Styles and presets made in the project, and styled outlines: the walls (presets deriving from presets, the trim
 * sheet named by the preset, a painted mask driving the height, a script swapping a preset at run time) and a room
 * whose preset's slider is dragged in the Inspector while the Scene view regenerates it.
 */
async function styledArchitecture(page: Page, trimId: string): Promise<void> {
  await cmd('setGraph', { graph: { graphId: 'e2e-wall-a', kind: 'architecture-style', name: 'Wall A', graph: wallStyle('lower_wall') } });
  await cmd('setGraph', { graph: { graphId: 'e2e-wall-b', kind: 'architecture-style', name: 'Wall B', graph: wallStyle('crown') } });
  // a: style A on the trim sheet, its height driven by the painted mask "tall"; c derives from a; b derives from a with style B.
  await cmd('setGraph', { graph: { graphId: 'e2e-a', kind: 'architecture-preset', name: 'A', graph: presetGraph('e2e-wall-a', '', trimId, [{ id: 'm', type: 'mask', position: [0, 150], data: { parameter: 'height', to: 3, source: 'painted', mask: 'tall', low: 0, high: 1 } }]) } });
  await cmd('setGraph', { graph: { graphId: 'e2e-c', kind: 'architecture-preset', name: 'C', graph: presetGraph('', 'e2e-a', '') } });
  await cmd('setGraph', { graph: { graphId: 'e2e-b', kind: 'architecture-preset', name: 'B', graph: presetGraph('e2e-wall-b', 'e2e-a', '') } });
  const walls = String((await cmd('createEntity', { sceneId: 'scene-main', parentId: null, kind: 'group', name: 'Styled walls', transform: { position: [0, 0, 0] } }))['createdId']);
  await cmd('setComponent', {
    entityId: walls,
    component: 'architecture',
    value: {
      elements: [],
      outlines: STYLED_WALLS.map((w, i) => ({ id: `w${i}`, preset: i < 4 ? 'e2e-a' : 'e2e-c', path: { points: [[w.x0, 0, STYLED_Z], [w.x1, 0, STYLED_Z]] } })),
      masks: { tall: { points: [1, 3, 5].map((i) => [(STYLED_WALLS[i]!.x0 + STYLED_WALLS[i]!.x1) / 2, STYLED_Z, 0.9, 1]) } },
    },
  });
  await publishScript(be!, 'restyle', RESTYLE_SCRIPT, walls);

  // ---- The editor: a preset from the Create menu (it derives from the starter room), its sliders in the Inspector.
  await createItem(page, ['Graph', 'Architecture preset'], 'Slider room');
  const graphsOf = async (): Promise<{ graphId: string; name: string; graph: { nodes: { type: string; data?: Record<string, unknown> }[] } }[]> => ((await query('queryGameConfig'))['graphs'] ?? []) as never;
  await expect.poll(async () => (await graphsOf()).some((g) => g.name === 'Slider room'), { timeout: 15_000 }).toBe(true);
  const sliderPreset = (await graphsOf()).find((g) => g.name === 'Slider room')!.graphId;
  await expect(inspector(page).getByLabel('ceiling_height slider')).toBeVisible();
  await closeEditor(page);
  const room = String((await cmd('createEntity', { sceneId: 'scene-main', parentId: null, kind: 'group', name: 'Slider room', transform: { position: [0, 0, 0] } }))['createdId']);
  await cmd('setComponent', { entityId: room, component: 'architecture', value: { elements: [], outlines: [{ id: 'room', preset: sliderPreset, path: { points: [[150, 0, -80], [158, 0, -80], [158, 0, -74], [150, 0, -74]], closed: true } }] } });
  await page.locator(`.tl-hierarchy__list li[data-entity-id="${room}"]`).click();
  const slider = inspector(page).getByLabel('ceiling_height slider');
  await expect(slider).toBeVisible();
  // Both objects drawn whole once before the drag (the room's and the walls' ready marks).
  await expect.poll(async () => new Set((await architectureMarks(page)).ready.map((r) => (r as { object?: string }).object)).size, { timeout: 30_000 }).toBeGreaterThanOrEqual(2);
  await slider.scrollIntoViewIfNeeded();
  const box = (await slider.boundingBox())!;
  const t0 = await page.evaluate(() => {
    const w = window as unknown as { __tlSliderInputs: number[] };
    w.__tlSliderInputs = [];
    document.addEventListener('input', (e) => (e.target as HTMLElement).getAttribute('aria-label') === 'ceiling_height slider' && w.__tlSliderInputs.push(performance.now()), true);
    return performance.now();
  });
  await page.mouse.move(box.x + box.width * 0.1, box.y + box.height / 2);
  await page.mouse.down();
  for (let i = 1; i <= 16; i++) {
    await page.mouse.move(box.x + box.width * (0.1 + 0.05 * i), box.y + box.height / 2);
    await page.waitForTimeout(60);
  }
  await page.mouse.up();
  // Stored on release: one value node over the starter room's.
  await expect.poll(async () => Number((await graphsOf()).find((g) => g.graphId === sliderPreset)?.graph.nodes.find((n) => n.type === 'value' && n.data?.['parameter'] === 'ceiling_height')?.data?.['value'] ?? 0), { timeout: 15_000 }).toBeGreaterThan(8);
  const marks = await page.evaluate((since) => {
    const inputs = (window as unknown as { __tlSliderInputs: number[] }).__tlSliderInputs;
    return (performance.getEntriesByType('mark') as PerformanceMark[])
      .filter((m) => m.name === 'tl:arch:ready' && m.startTime > since)
      .map((m) => {
        const d = m.detail as { object: string; ms: number; chunks: number };
        const input = inputs.filter((t) => t <= m.startTime).pop() ?? since;
        return { object: d.object, ms: d.ms, chunks: d.chunks, fromInput: m.startTime - input };
      });
  }, t0);
  const roomMarks = marks.filter((m) => m.object === room);
  // The page's share of each step (expanding the outlines, keying the chunks) and the workers' (each chunk made).
  const work = await page.evaluate((since) => {
    const all = (performance.getEntriesByType('mark') as PerformanceMark[]).filter((m) => m.startTime > since);
    return { page: all.filter((m) => m.name === 'tl:arch:preview').map((m) => (m.detail as { ms: number }).ms), chunks: all.filter((m) => m.name === 'tl:arch:chunk').map((m) => (m.detail as { ms: number }).ms) };
  }, t0);
  const median = (xs: number[]): number => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] ?? NaN;
  console.log(`architecture ${variantOf(page)} slider drag: ${roomMarks.length} regenerations of the room, chunks ${median(roomMarks.map((m) => m.chunks))}; made ${median(roomMarks.map((m) => m.ms)).toFixed(1)} ms median / ${Math.max(...roomMarks.map((m) => m.ms)).toFixed(1)} worst; input → drawn ${median(roomMarks.map((m) => m.fromInput)).toFixed(1)} / ${Math.max(...roomMarks.map((m) => m.fromInput)).toFixed(1)} ms; other objects made again: ${marks.filter((m) => m.object !== room).length}; page per step ${median(work.page).toFixed(2)} / ${Math.max(...work.page).toFixed(2)} ms; a chunk on a worker ${median(work.chunks).toFixed(2)} / ${Math.max(...work.chunks).toFixed(2)} ms`);
  expect(roomMarks.length).toBeGreaterThanOrEqual(4);
  // Only the room the preset styles was made again.
  expect(marks.filter((m) => m.object !== room)).toEqual([]);
  // The Inspector's restyle: every outline of the slider's preset takes the starter hall (the outline stays).
  const outlinesPanel = inspector(page).getByLabel('architecture outlines');
  await outlinesPanel.getByLabel('restyle to').selectOption('starter-hall');
  await outlinesPanel.getByRole('button', { name: 'Restyle', exact: true }).click();
  const outlineNow = async (): Promise<{ preset: string; path: unknown }> => ((await query('queryEntity', { entityId: room }))['entity'] as { components: { architecture: { outlines: { preset: string; path: unknown }[] } } }).components.architecture.outlines[0]!;
  await expect.poll(async () => (await outlineNow()).preset, { timeout: 15_000 }).toBe('starter-hall');
  expect((await outlineNow()).path).toEqual({ points: [[150, 0, -80], [158, 0, -80], [158, 0, -74], [150, 0, -74]], closed: true });
}
const variants = new WeakMap<Page, string>();
const variantOf = (page: Page): string => variants.get(page) ?? '';

/** The styled walls in a picture of the fixed camera: low (0.7 m) and high (2 m) on each wall's middle. */
function readStyled(img: Image): { low: [number, number, number][]; high: [number, number, number][]; ok: boolean } {
  const at = (w: { x0: number; x1: number }, y: number): [number, number, number] => colourAt(img, onPlay([(w.x0 + w.x1) / 2, y, STYLED_Z + 0.1], img.width, img.height));
  const low = STYLED_WALLS.map((w) => at(w, 0.7));
  const high = STYLED_WALLS.map((w) => at(w, 2));
  // Low: the first four magenta (preset a, its sheet's lower_wall row), the last two blue (c swapped for b: crown).
  const lowOk = low.every((c, i) => rowHue(i < 4 ? 'lower_wall' : 'crown', c));
  // High: the masked walls (1, 3, 5) reach 3 m, the others stop at 1 m (the black sky shows above them).
  const highOk = high.every((c, i) => (i % 2 === 1 ? rowHue(i < 4 ? 'lower_wall' : 'crown', c) : c[0] + c[1] + c[2] < 60));
  return { low, high, ok: lowOk && highOk };
}
const fmtColours = (cs: readonly (readonly number[])[]): string => cs.map((c) => c.map((v) => v.toFixed(0)).join(',')).join(' ');

/** The floor plan seen from above passes its reads (Play or the export); the failing reads are printed. */
async function expectPlans(reads: PlanReads, shot: () => Promise<{ img: Image; png: Buffer }>, what: string): Promise<void> {
  let got = judgePlans(reads, () => [0, 0, 0], rowHue);
  let png: Buffer | null = null;
  await expect
    .poll(async () => {
      const s = await shot();
      png = s.png;
      return (got = judgePlans(reads, (p) => colourAt(s.img, onPlans(p, s.img.width, s.img.height)), rowHue)).ok;
    }, { timeout: 30_000, intervals: [500], message: `the ${what} picture of the floor plan` })
    .toBe(true)
    .catch((e: unknown) => {
      console.log(`floor plans ${what} (failed): ${got.bad.join('; ')}`);
      if (png !== null) keep('floor-plan-failed', png);
      throw e;
    });
  if (png !== null) keep(`floor-plan-${what.replace(/\W+/g, '-')}`, png);
  console.log(`floor plans ${what}: ${reads.props.length} props, ${reads.clearances.length} door clearance points, ${reads.partitions.length} partitions read`);
}

/** The rooms drawn with the Rooms tool in a picture of the fixed camera: each read's colour and whether all show what they should. */
function readRooms(img: Image): { colours: Record<string, [number, number, number]>; ok: boolean } {
  const colours = Object.fromEntries(Object.entries(ROOM_READS).map(([k, r]) => [k, colourAt(img, onPlay(r.at, img.width, img.height))])) as Record<keyof typeof ROOM_READS, [number, number, number]>;
  const lum = (c: readonly number[]): number => c[0]! + c[1]! + c[2]!;
  const ok =
    rowHue(ROOM_READS.front.slot, colours.front) &&
    // Painted grime: no longer the wall's magenta, darker.
    !rowHue(ROOM_READS.grime.slot, colours.grime) &&
    lum(colours.grime) < lum(colours.front) &&
    rowHue(ROOM_READS.shared.slot, colours.shared) &&
    rowHue(ROOM_READS.door.slot, colours.door) &&
    rowHue(ROOM_READS.post.slot, colours.post);
  return { colours, ok };
}
const fmtRooms = (c: Record<string, readonly number[]>): string => Object.entries(c).map(([k, v]) => `${k} ${v.map((x) => x.toFixed(0)).join(',')}`).join('; ');

async function trimSheetChecks(page: Page, variant: RendererVariant): Promise<void> {
  variants.set(page, variant);
  type TrimMat = { materialId: string; shader: string; textures: Record<string, string>; trim?: { size: number[]; padding: number; rows: { slot: string; top: number; bottom: number; texelDensity?: number }[] }; decal?: { sheet: string; cell: string } };
  const trimMaterial = async (): Promise<TrimMat | undefined> => ((await materials(be!)) as unknown as TrimMat[]).find((m) => m.shader === 'trim');
  await publishTexture(be!, new Uint8Array(testTrimSheetPng()), 'trim-sheet', 'Trim sheet');

  // ---- The editor: a trim sheet material from the Create menu, its rows from layout.json, edited in the table.
  await createItem(page, 'Trim sheet material', 'Trim');
  await expect.poll(async () => (await trimMaterial())?.trim?.rows.length, { timeout: 15_000 }).toBe(9);
  const table = inspector(page).getByRole('table', { name: 'trim rows' });
  await expect(table).toBeVisible();
  await inspector(page).getByLabel('trim layout file').setInputFiles({ name: 'layout.json', mimeType: 'application/json', buffer: Buffer.from(testTrimLayoutJson()) });
  // The rows, and the decal layer's cell kept as a named rectangle (listed under the table).
  await expect.poll(async () => (await trimMaterial())?.trim).toEqual({ ...TEST_TRIM_SHEET, cells: [TEST_TRIM_CELL] });
  await expect(inspector(page).getByLabel('trim check')).toContainText('4 rows and 1 decal cell (left out, neither rows nor cells: notes)');
  await expect(inspector(page).getByLabel('trim decal cells')).toContainText('sign: 32 × 32 px at 8, 192 (0.25 × 0.25 m)');
  const cell = (label: string) => table.getByLabel(label, { exact: true });
  // Row 2 reaching into row 3 is refused (the field shows the stored value again); row 4's own density is saved.
  await cell('row 2 bottom').fill('101');
  await cell('row 2 bottom').press('Enter');
  await expect(inspector(page).getByLabel('trim table error')).toContainText('overlaps');
  await expect(cell('row 2 bottom')).toHaveValue('92');
  await cell('row 4 texel density').fill('64');
  await cell('row 4 texel density').press('Enter');
  await expect.poll(async () => (await trimMaterial())?.trim?.rows[3]?.texelDensity).toBe(64);
  await expect(table.getByLabel('row 1 safe mip level')).toHaveText(/^[1-9]$/);
  // The albedo, then its padding checked against the table on the backend.
  await inspector(page).getByRole('combobox', { name: 'texture map' }).selectOption({ label: 'Trim sheet' });
  await expect.poll(async () => (await trimMaterial())?.textures['map']).toBe('trim-sheet');
  await inspector(page).getByRole('button', { name: 'Check padding' }).click();
  await expect(inspector(page).getByLabel('trim check')).toContainText('Padding OK', { timeout: 15_000 });
  const trimId = (await trimMaterial())!.materialId;
  // A decal material draws the sheet's cell: its source picked in the Inspector, one setMaterial.
  await cmd('setMaterial', { material: { materialId: 'mat-stain', name: 'Stain', shader: 'decal', params: { blend: 'multiply' }, textures: {} } });
  await chooseItem(page, 'material', 'Stain');
  await inspector(page).getByLabel('decal sheet', { exact: true }).selectOption({ label: 'Trim' });
  await expect.poll(async () => ((await materials(be!)) as unknown as TrimMat[]).find((m) => m.materialId === 'mat-stain')?.decal).toEqual({ sheet: trimId, cell: TEST_TRIM_CELL.name });
  await expect(inspector(page).getByLabel('decal cell', { exact: true })).toHaveValue(TEST_TRIM_CELL.name);
  // A projected decal of that cell, out of sight: its page reaches the GPU in Play and the export (nothing draws it yet).
  await cmd('createEntity', { sceneId: 'scene-main', kind: 'group', name: 'Stain', transform: { position: [0, -40, 0] }, components: { decal: { size: [0.25, 0.25, 0.25], material: 'mat-stain' } } });

  // ---- Play: the strips at a grazing angle, the trim material's and the standard material's.
  await cmd('setMaterial', { material: { materialId: 'mat-trim-std', name: 'Trim sheet, standard', shader: 'standard', params: { roughness: 1 }, textures: { map: 'trim-sheet' } } });
  await publishBytes(be!, new Uint8Array(trimStripsGlb(TEST_TRIM_SHEET, TRIM_PATCHES, 32)), 'model', 'trim-strips', 'Trim strips');
  for (const [at, mat, name] of [[TRIM_AT, trimId, 'Trim strips'], [STANDARD_AT, 'mat-trim-std', 'Standard strips']] as const) {
    const id = String((await cmd('createEntity', { sceneId: 'scene-main', kind: 'model', name, model: { asset: { assetId: 'trim-strips' } }, transform: { position: [...at] } }))['createdId']);
    await cmd('setComponent', { entityId: id, component: 'materials', value: { '*': mat } });
  }
  await cmd('setEnvironment', { sceneId: 'scene-main', environment: { sky: { mode: 'color', color: '#000000', intensity: 1, environmentIntensity: 0 }, fog: { mode: 'none', color: '#000000' } } });
  await cmd('setComponent', { entityId: 'light-0001', component: 'light', value: { type: 'directional', color: '#ffffff', intensity: 1.5, direction: [0.3, -1, -0.4], castShadow: false } });
  await cmd('setComponent', { entityId: 'light-0002', component: 'light', value: { type: 'ambient', color: '#ffffff', intensity: 0.6 } });
  await cmd('setTransform', { entityId: 'cam-main', transform: { position: [...EYE], rotation: [Math.sin(PITCH / 2), 0, 0, Math.cos(PITCH / 2)] } });
  const lens = ((await query('queryEntity', { entityId: 'cam-main' }))['entity'] as { components: { virtualCamera?: Record<string, unknown> } }).components.virtualCamera;
  await cmd('setComponent', { entityId: 'cam-main', component: 'virtualCamera', value: { ...(lens ?? {}), rig: 'fixed', fovY: FOV_Y, near: 0.1, far: 200 } });

  // Generated architecture wearing the trim material: parameters only, made at load.
  const archId = String((await cmd('createEntity', { sceneId: 'scene-main', parentId: null, kind: 'group', name: 'Architecture', transform: { position: [0, 0, 0] } }))['createdId']);
  await cmd('setComponent', { entityId: archId, component: 'architecture', value: ARCHITECTURE });
  await cmd('setComponent', { entityId: archId, component: 'materials', value: { '*': trimId } });
  await styledArchitecture(page, trimId);
  const rooms = await drawRooms(page, cmd, query, trimId);
  console.log(`rooms ${variant} editor: draw → visible ${rooms.timings.drawToVisible.toFixed(1)} ms; wall drag ${rooms.timings.drag.regenerations} regenerations, input → drawn ${rooms.timings.drag.median.toFixed(1)} / ${rooms.timings.drag.worst.toFixed(1)} ms, a chunk ${rooms.timings.drag.madeMedian.toFixed(2)} ms median, other objects made again ${rooms.timings.drag.others}`);
  expect(rooms.timings.drag.others).toBe(0);
  await makeLitRooms(cmd, trimId, async (bytes, id) => void (await publishBytes(be!, bytes, 'model', id)));
  const building = await drawBuilding(page, cmd, query, trimId, (name, source, entityId) => publishScript(be!, name, source, entityId));
  const plans = await makeFloorPlans(page, cmd, query, async (bytes, id) => void (await publishBytes(be!, bytes, 'model', id)), (name, source, entityId) => publishScript(be!, name, source, entityId));
  console.log(`floor plans ${variant} editor: ${plans.editor.props} props, ${plans.editor.moved} moved by the new seed, the pinned one kept ${plans.editor.pinnedKept}`);
  expect(plans.editor.pinnedKept).toBe(true);
  const planRead = await planReads(query, plans.roomsId);

  const started = page.waitForResponse((r) => r.request().method() === 'POST' && r.url().endsWith('/play'));
  await page.getByTitle('Start an isolated play preview').click();
  const psid = String(((await (await started).json()) as { playSessionId: string }).playSessionId);
  const canvas = page.frameLocator('iframe.tl-app__preview-frame').locator('canvas').first();
  await expectRendererBackend(canvas, variant);
  let reading = '';
  const judge = (img: Image): { trimClean: boolean; standardBleeds: boolean; grime: boolean; wet: boolean } => {
    const read = (corner: readonly number[], i: number, depth: number): [number, number, number] => colourAt(img, onPlay([corner[0]! + stripPatchCentre(i), 0, corner[2]! - depth], img.width, img.height));
    const trim = TRIM_DEPTHS.map((d) => [0, 1, 2, 3].map((i) => read(TRIM_AT, i, d)));
    const standard = TRIM_DEPTHS.map((d) => [0, 1, 2, 3].map((i) => read(STANDARD_AT, i, d)));
    const plain = read(TRIM_AT, 0, TRIM_DEPTHS[0]);
    const grimed = read(TRIM_AT, 4, TRIM_DEPTHS[0]);
    const wet = read(TRIM_AT, 5, TRIM_DEPTHS[0]);
    const lum = (c: readonly number[]): number => c[0]! + c[1]! + c[2]!;
    const fmt = (c: readonly number[]): string => c.map((v) => v.toFixed(0)).join(',');
    reading = `trim ${trim.map((row, k) => `${TRIM_DEPTHS[k]} m: ${row.map(fmt).join(' ')}`).join('; ')} | standard ${standard.map((row, k) => `${TRIM_DEPTHS[k]} m: ${row.map(fmt).join(' ')}`).join('; ')} | plain ${fmt(plain)} grime ${fmt(grimed)} wet ${fmt(wet)}`;
    const near = trim[0]!;
    return {
      // Each patch its row's hue near, and the same colour at every distance.
      trimClean: near.every((c, i) => rowHue(TRIM_PATCHES[i]!.slot, c)) && trim.every((row) => row.every((c, i) => sameColour(c, near[i]!))),
      // Near, the standard material shows the same rows; far, at least two of red, green and blue take their neighbours' colours.
      standardBleeds: standard[0]!.every((c, i) => sameColour(c, near[i]!)) && standard[2]!.slice(0, 3).filter((c, i) => !sameColour(c, near[i]!)).length >= 2,
      // Grime: the dark brown grime colour, no longer the row's red; wetness: the red row, darker.
      grime: !rowHue('floor', grimed) && lum(grimed) < lum(plain),
      wet: rowHue('floor', wet) && lum(wet) < lum(plain) * 0.8,
    };
  };
  let last: Buffer | null = null;
  await expect
    .poll(async () => {
      const png = await canvas.screenshot();
      last = png;
      const j = judge(decodePng(png));
      if (j.trimClean && j.standardBleeds && j.grime && j.wet) keep('trim-strips', png);
      return j;
    }, { timeout: 45_000, intervals: [1000], message: 'the Play picture of the strips' })
    .toEqual({ trimClean: true, standardBleeds: true, grime: true, wet: true })
    .catch((e: unknown) => {
      console.log(`trim strips ${variant} (failed): ${reading}`);
      if (last !== null) keep('trim-strips-failed', last);
      throw e;
    });
  console.log(`trim strips ${variant}: ${reading}`);
  // The architecture: generated on the workers, each part its row's colour.
  let arch: { colours: [number, number, number][]; ok: boolean } = { colours: [], ok: false };
  await expect.poll(async () => (arch = readArchitecture(decodePng(await canvas.screenshot()))).ok, { timeout: 30_000, intervals: [500], message: 'the Play picture of the architecture' }).toBe(true);
  const playMarks = await architectureMarks(canvas);
  console.log(`architecture ${variant} Play: ${arch.colours.map((c) => c.map((v) => v.toFixed(0)).join(',')).join(' ')}; chunks ${JSON.stringify(playMarks.chunks)}; ready ${JSON.stringify(playMarks.ready)}`);
  expect(playMarks.chunks.length).toBeGreaterThan(0);
  expect(playMarks.chunks.every((c) => c.where === 'worker' || c.where === 'page')).toBe(true);
  // The styled walls: the mask varies the height across them, the script's swap restyled the last two.
  let styled = readStyled(decodePng(await canvas.screenshot()));
  await expect.poll(async () => (styled = readStyled(decodePng(await canvas.screenshot()))).ok, { timeout: 30_000, intervals: [500], message: 'the Play picture of the styled walls' }).toBe(true).catch((e: unknown) => {
    console.log(`styled walls ${variant} Play (failed): low ${fmtColours(styled.low)} high ${fmtColours(styled.high)}`);
    throw e;
  });
  console.log(`styled walls ${variant} Play: low ${fmtColours(styled.low)} high ${fmtColours(styled.high)}`);
  // The rooms: the shared wall made once with the door through it, the arch, the grime painted on the layer, the fence.
  let roomsPlay = readRooms(decodePng(await canvas.screenshot()));
  let roomsPng: Buffer | null = null;
  await expect.poll(async () => (roomsPlay = readRooms(decodePng((roomsPng = await canvas.screenshot())))).ok, { timeout: 30_000, intervals: [500], message: 'the Play picture of the rooms' }).toBe(true).catch((e: unknown) => {
    console.log(`rooms ${variant} Play (failed): ${fmtRooms(roomsPlay.colours)}`);
    if (roomsPng !== null) keep('rooms-failed', roomsPng);
    throw e;
  });
  if (roomsPng !== null) keep('rooms', roomsPng);
  console.log(`rooms ${variant} Play: ${fmtRooms(roomsPlay.colours)}`);
  // The lamp lights its room and not the next one through the wall; the room behind the closed door is not drawn.
  let lit = judgeLitRooms(() => [0, 0, 0]);
  let litPng: Buffer | null = null;
  await expect.poll(async () => {
    const img = decodePng((litPng = await canvas.screenshot()));
    return (lit = judgeLitRooms((p) => colourAt(img, onPlay(p, img.width, img.height)))).ok;
  }, { timeout: 30_000, intervals: [500], message: 'the Play picture of the lit rooms' }).toBe(true).catch((e: unknown) => {
    console.log(`lit rooms ${variant} Play (failed): ${JSON.stringify(lit.lum)}`);
    if (litPng !== null) keep('lit-rooms-failed', litPng);
    throw e;
  });
  if (litPng !== null) keep('lit-rooms', litPng);
  const diagnostics = async (): Promise<Record<string, unknown>> => {
    const r = await fetch(`${be!.origin}/api/v1/projects/${be!.projectId}/play/${psid}/diagnostics`, { method: 'POST', headers: { authorization: `Bearer ${be!.token}`, 'content-type': 'application/json', origin: be!.origin }, body: '{}' });
    return ((await r.json()) as { diagnostics?: { renderer?: Record<string, unknown> } }).diagnostics?.renderer ?? {};
  };
  const renderer = await diagnostics();
  // The decal's page: one array (the sheet copied onto a page: the test sheet is a PNG), held and uploaded, inside the budget.
  const decalPages = renderer['decals'] as { decals: number; pages: number; layers: number; bytes: number; onGpu: number } | undefined;
  const budget = renderer['textures'] as { budgetBytes: number; fixedBytes: number } | undefined;
  console.log(`decal pages ${variant} Play: ${JSON.stringify(decalPages ?? null)}; textures ${budget?.fixedBytes ?? '-'} fixed of a ${budget?.budgetBytes ?? '-'} byte budget`);
  expect(decalPages).toMatchObject({ decals: 1, pages: 1, layers: 1, onGpu: 1 });
  expect(decalPages!.bytes).toBeGreaterThan(0);
  console.log(`lit rooms ${variant} Play: ${JSON.stringify(lit.lum)}; rooms ${JSON.stringify(renderer['rooms'])}; local shadows ${JSON.stringify((renderer['lights'] as Record<string, unknown> | undefined)?.['localShadows'] ?? null)}`);
  expectCulled(renderer['rooms'] as never);
  // The building: the facade, the windows (the inner wall behind them) and the roof; its interior read ahead while its door is near.
  let outside = judgeOutside(() => [0, 0, 0], rowHue);
  await expect.poll(async () => {
    const img = decodePng(await canvas.screenshot());
    return (outside = judgeOutside((p) => colourAt(img, onPlay(p, img.width, img.height)), rowHue)).ok;
  }, { timeout: 30_000, intervals: [500], message: 'the Play picture of the building' }).toBe(true).catch((e: unknown) => {
    console.log(`building ${variant} Play (failed): ${fmtRooms(outside.colours)}`);
    throw e;
  });
  // Read ahead while its door is near: the interior's chunks made on the workers before the door is used (not drawn).
  await expect.poll(async () => canvas.evaluate(() => (performance.getEntriesByType('mark') as PerformanceMark[]).some((m) => m.name === 'tl:arch:chunk' && String((m.detail as { object: string }).object).startsWith('\u0000interior-'))), { timeout: 30_000, message: 'the interior made while its door is near' }).toBe(true);
  // Through the door: the script loads the interior's scene from the door's link; its camera shows the front wall from inside.
  const frameBox = (await page.locator('iframe.tl-app__preview-frame').boundingBox())!;
  await page.mouse.click(frameBox.x + frameBox.width / 2, frameBox.y + frameBox.height / 2);
  await page.keyboard.down(ENTER_KEY);
  await page.waitForTimeout(200);
  await page.keyboard.up(ENTER_KEY);
  let inside = judgeInside(() => [0, 0, 0], rowHue);
  let insidePng: Buffer | null = null;
  await expect.poll(async () => {
    const img = decodePng((insidePng = await canvas.screenshot()));
    return (inside = judgeInside((p) => colourAt(img, onInterior(p, img.width, img.height)), rowHue)).ok;
  }, { timeout: 30_000, intervals: [500], message: 'the Play picture of the interior' }).toBe(true).catch((e: unknown) => {
    console.log(`building interior ${variant} Play (failed): ${fmtRooms(inside.colours)}`);
    if (insidePng !== null) keep('building-inside-failed', insidePng);
    throw e;
  });
  if (insidePng !== null) keep('building-inside', insidePng);
  const loads = async (): Promise<{ sceneId: string; requestedMs: number; preparedMs: number | null; attachedMs: number | null; preloaded: boolean }[]> => {
    const r = await fetch(`${be!.origin}/api/v1/projects/${be!.projectId}/play/${psid}/diagnostics`, { method: 'POST', headers: { authorization: `Bearer ${be!.token}`, 'content-type': 'application/json', origin: be!.origin }, body: '{}' });
    return ((await r.json()) as { diagnostics?: { startTimings?: { sceneLoads?: never[] } } }).diagnostics?.startTimings?.sceneLoads ?? [];
  };
  await expect.poll(async () => (await loads()).find((l) => l.sceneId === building.interiorScene)?.attachedMs ?? null, { timeout: 15_000 }).not.toBeNull();
  const door = (await loads()).find((l) => l.sceneId === building.interiorScene)!;
  const interiorMarks = await canvas.evaluate(() => (performance.getEntriesByType('mark') as PerformanceMark[]).filter((m) => (m.name === 'tl:arch:ready' || m.name === 'tl:arch:chunk') && String((m.detail as { object: string }).object).includes('interior-')).map((m) => ({ name: m.name, at: Math.round(m.startTime), ...(m.detail as Record<string, unknown>) })));
  const buildingDraws = ((renderer['architecture'] as { draws?: number } | undefined)?.draws ?? null);
  console.log(`building ${variant} Play: outside ${fmtRooms(outside.colours)}; inside ${fmtRooms(inside.colours)}; through the door (read ahead ${door.preloaded}): requested → prepared ${door.preparedMs !== null ? (door.preparedMs - door.requestedMs).toFixed(1) : '-'} ms, → drawn ${((door.attachedMs ?? 0) - door.requestedMs).toFixed(1)} ms; interior marks ${JSON.stringify(interiorMarks)}; architecture draws ${buildingDraws}`);
  expect(door.preloaded).toBe(true);
  // The floor plan from above (a key loads the plans scene): props, door clearances and partitions where the generator put them.
  await page.keyboard.down(PLANS_KEY);
  await page.waitForTimeout(200);
  await page.keyboard.up(PLANS_KEY);
  await expectPlans(planRead, async () => {
    const png = await canvas.screenshot();
    return { img: decodePng(png), png };
  }, `${variant} Play`);
  const planRenderer = await diagnostics();
  console.log(`floor plans ${variant} Play: architecture ${JSON.stringify(planRenderer['architecture'] ?? null)}; lights ${JSON.stringify((planRenderer['lights'] as Record<string, unknown> | undefined)?.['local'] ?? null)} (furnishing lights ${planRead.lights})`);
  // The furnishing's lights are lights of the start scene (made into its snapshot like the build's scene files).
  expect((planRenderer['lights'] as { local?: number } | undefined)?.local ?? 0).toBeGreaterThanOrEqual(planRead.lights);
  await page.getByTitle('Stop the play preview').click();

  // ---- The static export, served with the backend stopped: the parameters ship, the game generates the same picture.
  const res = await be!.admin(`projects/${be!.projectId}/export`);
  expect(res.status, JSON.stringify(res.json)).toBe(200);
  const out = join(be!.exportRoot, String(res.json['outputDir']));
  await page.goto('about:blank');
  await be!.halt();
  const site = await serveDir(out);
  const game = await page.context().newPage();
  const errors: string[] = [];
  game.on('pageerror', (e) => errors.push(e.message));
  try {
    await game.goto(`${site.url}${exportQueryFor(variant)}`);
    const exported = game.locator('canvas').first();
    await expectRendererBackend(exported, variant);
    let shown: { colours: [number, number, number][]; ok: boolean } = { colours: [], ok: false };
    await expect.poll(async () => (shown = readArchitecture(decodePng(await exported.screenshot()))).ok && shown.colours.every((c, i) => sameColour(c, arch.colours[i]!)), { timeout: 45_000, intervals: [500], message: 'the export picture of the architecture' }).toBe(true);
    // The decal page on the GPU: "<arrays>|<layers>|<bytes>|<uploaded>".
    expect(String(await exported.getAttribute('data-tl-decal-pages'))).toBe(`1|1|${decalPages!.bytes}|1`);
    let styledExport = readStyled(decodePng(await exported.screenshot()));
    await expect.poll(async () => (styledExport = readStyled(decodePng(await exported.screenshot()))).ok, { timeout: 30_000, intervals: [500], message: 'the export picture of the styled walls' }).toBe(true).catch((e: unknown) => {
      console.log(`styled walls ${variant} export (failed): low ${fmtColours(styledExport.low)} high ${fmtColours(styledExport.high)}`);
      throw e;
    });
    console.log(`styled walls ${variant} export: low ${fmtColours(styledExport.low)} high ${fmtColours(styledExport.high)}`);
    let roomsExport = readRooms(decodePng(await exported.screenshot()));
    await expect.poll(async () => (roomsExport = readRooms(decodePng(await exported.screenshot()))).ok, { timeout: 30_000, intervals: [500], message: 'the export picture of the rooms' }).toBe(true).catch((e: unknown) => {
      console.log(`rooms ${variant} export (failed): ${fmtRooms(roomsExport.colours)}`);
      throw e;
    });
    console.log(`rooms ${variant} export: ${fmtRooms(roomsExport.colours)}`);
    let litExport = judgeLitRooms(() => [0, 0, 0]);
    await expect.poll(async () => {
      const img = decodePng(await exported.screenshot());
      return (litExport = judgeLitRooms((p) => colourAt(img, onPlay(p, img.width, img.height)))).ok;
    }, { timeout: 30_000, intervals: [500], message: 'the export picture of the lit rooms' }).toBe(true).catch((e: unknown) => {
      console.log(`lit rooms ${variant} export (failed): ${JSON.stringify(litExport.lum)}`);
      throw e;
    });
    // The room behind the closed door is not seen and its box not drawn: "<rooms seen>/<rooms> <draws hidden>".
    const mark = String(await exported.getAttribute('data-tl-rooms'));
    console.log(`lit rooms ${variant} export: ${JSON.stringify(litExport.lum)}; data-tl-rooms ${mark}`);
    const [seenOf, hiddenDraws] = mark.split(' ');
    const [seenRooms, allRooms] = (seenOf ?? '').split('/').map(Number);
    expect(seenRooms!).toBeLessThan(allRooms!);
    expect(Number(hiddenDraws)).toBeGreaterThan(0);
    // The building outside, then through its door (the key) to the interior's camera.
    let outsideExport = judgeOutside(() => [0, 0, 0], rowHue);
    await expect.poll(async () => {
      const img = decodePng(await exported.screenshot());
      return (outsideExport = judgeOutside((p) => colourAt(img, onPlay(p, img.width, img.height)), rowHue)).ok;
    }, { timeout: 30_000, intervals: [500], message: 'the export picture of the building' }).toBe(true).catch((e: unknown) => {
      console.log(`building ${variant} export (failed): ${fmtRooms(outsideExport.colours)}`);
      throw e;
    });
    const gameBox = (await exported.boundingBox())!;
    await game.mouse.click(gameBox.x + gameBox.width / 2, gameBox.y + gameBox.height / 2);
    await game.keyboard.down(ENTER_KEY);
    await game.waitForTimeout(200);
    await game.keyboard.up(ENTER_KEY);
    let insideExport = judgeInside(() => [0, 0, 0], rowHue);
    await expect.poll(async () => {
      const img = decodePng(await exported.screenshot());
      return (insideExport = judgeInside((p) => colourAt(img, onInterior(p, img.width, img.height)), rowHue)).ok;
    }, { timeout: 30_000, intervals: [500], message: 'the export picture of the interior' }).toBe(true).catch((e: unknown) => {
      console.log(`building interior ${variant} export (failed): ${fmtRooms(insideExport.colours)}`);
      throw e;
    });
    console.log(`building ${variant} export: outside ${fmtRooms(outsideExport.colours)}; inside ${fmtRooms(insideExport.colours)}`);
    await game.keyboard.down(PLANS_KEY);
    await game.waitForTimeout(200);
    await game.keyboard.up(PLANS_KEY);
    await expectPlans(planRead, async () => {
      const png = await exported.screenshot();
      return { img: decodePng(png), png };
    }, `${variant} export`);
    const marks = await architectureMarks(game);
    console.log(`architecture ${variant} export: ${shown.colours.map((c) => c.map((v) => v.toFixed(0)).join(',')).join(' ')}; chunks ${JSON.stringify(marks.chunks)}; ready ${JSON.stringify(marks.ready)}`);
    // Generated, not shipped: on the workers, or on the page while they were starting.
    expect(marks.chunks.length).toBeGreaterThan(0);
    expect(marks.chunks.every((c) => c.where === 'worker' || c.where === 'page')).toBe(true);
    expect(errors).toEqual([]);
  } finally {
    await game.close();
    await site.close();
  }
}
