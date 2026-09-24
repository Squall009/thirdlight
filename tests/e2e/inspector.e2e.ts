/**
 * Phase 15.1: the generic Inspector against a real backend, on a neutral new
 * project (a camera, a sun, an ambient light). Every component kind is added
 * from "+ Add component" with its descriptor value (or the picked asset,
 * controller or script), one of its fields is edited through the widget its
 * descriptor type gets, the stored value is read back from the backend, one
 * undo restores it, and "remove" takes the component off — each step one
 * command. Components that cannot be added say why; the game block (with
 * its sound cues as asset pickers) is built from its descriptor too.
 */
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { expect, test, type Page } from '@playwright/test';

import { startBackend, type E2EBackend } from './backend';
import { skinnedGlb } from './skinned-glb';
import { menu } from './ui';

const REPO = resolve(import.meta.dirname, '..', '..');

let be: E2EBackend;
test.beforeEach(async () => {
  be = await startBackend('inspector-e2e');
});
test.afterEach(async () => {
  await be.stop();
});

let seq = 0;
async function cmd(op: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const q = await be.command({ op: 'queryProject', projectId: be.projectId, args: {} });
  seq += 1;
  const r = await be.command({ op, projectId: be.projectId, expectedRevision: q['revision'], requestId: `req-${(0x15e2e000 + seq).toString(16).padStart(32, '0')}`, origin: { kind: 'mcp', clientId: 'e2e-inspector' }, args });
  expect(r['ok'], JSON.stringify(r)).toBe(true);
  return r;
}
async function components(id: string): Promise<Record<string, unknown>> {
  const r = await be.command({ op: 'queryEntity', projectId: be.projectId, args: { entityId: id } });
  return (r['entity'] as { components: Record<string, unknown> }).components;
}
const comp = (id: string, name: string) => async (): Promise<unknown> => (await components(id))[name];

const inspector = (page: Page) => page.locator('.tl-inspector');
async function field(page: Page, label: string, value: string): Promise<void> {
  const f = inspector(page).getByLabel(label, { exact: true });
  await f.fill(value);
  await f.press('Enter');
}
async function add(page: Page, option: string): Promise<void> {
  await inspector(page).getByLabel('add component', { exact: true }).selectOption({ label: option });
}
async function undo(page: Page): Promise<void> {
  await menu(page, 'Edit', 'Undo');
}
async function select(page: Page, id: string): Promise<void> {
  await page.locator(`.tl-hierarchy__list li[data-entity-id="${id}"]`).click();
}
async function importFile(page: Page, path: string, count: number, name: string): Promise<string> {
  await page.getByRole('tab', { name: 'Assets' }).click();
  await page.locator('.tl-assets__file').first().setInputFiles(path);
  const publish = page.getByRole('button', { name: 'publish' });
  await expect(publish).toBeEnabled({ timeout: 15_000 });
  await publish.click();
  const assets = async () => (await be.command({ op: 'queryAssets', projectId: be.projectId, args: { limit: 20, offset: 0 } }))['assets'] as { assetId: string; displayName: string }[];
  await expect.poll(async () => (await assets()).length, { timeout: 15_000 }).toBe(count);
  return (await assets()).find((a) => a.displayName === name)!.assetId;
}

/**
 * Menu components on one empty object: add (the descriptor value), edit one
 * field, check the backend, undo, remove. `edit` drives the widget; `after`
 * is what the backend then holds (a partial match).
 */
const MENU: { option: string; name: string; added: Record<string, unknown>; edit?: (p: Page) => Promise<void>; after?: Record<string, unknown> }[] = [
  { option: 'Box', name: 'box', added: { size: [1, 1, 1] }, edit: (p) => field(p, 'box size w', '2'), after: { size: [2, 1, 1] } },
  { option: 'Fog volume', name: 'fogVolume', added: { density: 0.25 }, edit: (p) => field(p, 'fogVolume density', '0.5'), after: { density: 0.5 } },
  { option: 'Collider: Box', name: 'collider', added: { shape: { type: 'box', hx: 0.5, hy: 0.5 } }, edit: (p) => field(p, 'collider shape hx', '0.75'), after: { shape: { type: 'box', hx: 0.75, hy: 0.5 } } },
  { option: 'Player controller', name: 'controller', added: {}, edit: (p) => field(p, 'controller capsule radius', '0.4'), after: { capsule: { radius: 0.4, height: 1.8 } } },
  { option: 'Light: Point light', name: 'light', added: { type: 'point', range: 8 }, edit: (p) => field(p, 'light range', '5'), after: { type: 'point', range: 5 } },
  { option: 'Zone: Hazard', name: 'gameZone', added: { role: 'hazard' }, edit: (p) => inspector(p).getByLabel('gameZone role', { exact: true }).selectOption('goal'), after: { role: 'goal' } },
  { option: 'Player spawn', name: 'playerSpawn', added: {} },
  { option: 'Mover', name: 'mover', added: { speed: 2 }, edit: (p) => field(p, 'mover waypoints 1 y', '3'), after: { waypoints: [[4, 3, 0]] } },
  { option: 'Trigger', name: 'trigger', added: { size: [2, 2] }, edit: (p) => inspector(p).getByLabel('trigger shape', { exact: true }).selectOption('circle'), after: { shape: 'circle', radius: 1 } },
  { option: 'Switch', name: 'switch', added: { mode: 'interact' }, edit: (p) => inspector(p).getByLabel('switch once', { exact: true }).click(), after: { once: true } },
  { option: 'Health', name: 'health', added: { max: 3 }, edit: (p) => field(p, 'health max', '5'), after: { max: 5 } },
  { option: 'Pickup', name: 'pickup', added: { kind: 'coin' }, edit: (p) => inspector(p).getByLabel('pickup kind', { exact: true }).selectOption('custom'), after: { kind: 'custom', counter: 'counter' } },
  { option: 'Enemy', name: 'enemy', added: { patrol: 'edges' }, edit: (p) => inspector(p).getByLabel('enemy patrol', { exact: true }).selectOption('points'), after: { patrol: 'points', range: [-2, 2] } },
  { option: 'Face movement', name: 'faceMovement', added: { turnSeconds: 0.12 }, edit: (p) => field(p, 'faceMovement turnSeconds', '0.3'), after: { turnSeconds: 0.3 } },
];

test('every component kind: added, edited (one undo) and removed through the Inspector', async ({ page }) => {
  test.setTimeout(300_000);
  await cmd('setMaterial', { material: { materialId: 'mat-plain', name: 'Plain', shader: 'standard', params: {}, textures: {} } });
  const behaviorId = 'behavior-drift';
  await cmd('publishBehavior', { behaviorId, displayName: 'Drift', mode: 'declaration-create', declaration: { properties: [{ key: 'speed', label: 'Speed', type: 'number', default: 3.5, min: -100, max: 100, step: 0.5 }] } });

  await page.goto(be.editorUrl);
  await expect(page.locator('.tl-statusbar')).toContainText('connected');

  // One empty object carries each menu component in turn.
  await menu(page, 'GameObject', 'Create empty');
  const row = page.locator('.tl-hierarchy__list li.tl-row.is-selected');
  const id = (await row.getAttribute('data-entity-id'))!;
  await expect(inspector(page).getByLabel('add component', { exact: true })).toBeVisible();
  for (const c of MENU) {
    await add(page, c.option);
    await expect.poll(comp(id, c.name), { message: `add ${c.name}` }).toMatchObject(c.added);
    const added = await comp(id, c.name)();
    const section = inspector(page).locator(`[data-component="${c.name}"]`);
    await expect(section).toBeVisible();
    if (c.edit !== undefined) {
      await c.edit(page);
      await expect.poll(comp(id, c.name), { message: `edit ${c.name}` }).toMatchObject(c.after!);
      await undo(page);
      await expect.poll(comp(id, c.name), { message: `undo ${c.name}` }).toEqual(added);
    }
    await section.getByRole('button', { name: `remove ${c.name}`, exact: true }).click();
    await expect.poll(comp(id, c.name), { message: `remove ${c.name}` }).toBeUndefined();
  }

  // Exclusions say why: with a box on, a model or a camera cannot be added.
  await add(page, 'Box');
  await expect.poll(comp(id, 'box')).toBeDefined();
  const options = inspector(page).getByLabel('add component', { exact: true }).locator('option');
  await expect(options.filter({ hasText: /^Model — an object shows one model, box or camera/ })).toHaveCount(1);
  await expect(options.filter({ hasText: /^Camera — an object shows one model, box or camera/ })).toHaveCount(1);
  await expect(options.filter({ hasText: /^Instance set — made by the/ })).toHaveCount(1);
  // A surface needs a box or a model: it is on offer now; its presets are a custom widget.
  await add(page, 'Surface');
  await expect.poll(comp(id, 'surface')).toBeDefined();
  await field(page, 'surface roughness', '0.2');
  await expect.poll(async () => ((await comp(id, 'surface')()) as { roughness?: number }).roughness).toBe(0.2);
  await inspector(page).getByLabel('surface preset', { exact: true }).selectOption('hazard');
  await expect.poll(async () => ((await comp(id, 'surface')()) as { roughness?: number }).roughness).not.toBe(0.2);
  await inspector(page).getByRole('button', { name: 'remove surface', exact: true }).click();
  await expect.poll(comp(id, 'surface')).toBeUndefined();
  // Materials: the mapping editor (it knows the model's own material names) is this section's custom widget.
  await inspector(page).getByRole('combobox', { name: 'material for all' }).selectOption({ label: 'Plain' });
  await expect.poll(comp(id, 'materials')).toEqual({ '*': 'mat-plain' });
  await inspector(page).getByRole('button', { name: 'remove materials', exact: true }).click();
  await expect.poll(comp(id, 'materials')).toBeUndefined();
  // The box itself is removable too (one command; undo brings it back).
  await inspector(page).getByRole('button', { name: 'remove box', exact: true }).click();
  await expect.poll(comp(id, 'box')).toBeUndefined();
  await undo(page);
  await expect.poll(comp(id, 'box')).toBeDefined();
  await inspector(page).getByRole('button', { name: 'remove box', exact: true }).click();
  await expect.poll(comp(id, 'box')).toBeUndefined();

  // The camera: lens fields (one undo). The start scenes hold exactly one active
  // camera, so adding a second one or removing the only one is refused — the
  // Inspector says why and nothing changes.
  await select(page, 'cam-main');
  await field(page, 'camera fovY', '45');
  await field(page, 'camera far', '250');
  await expect.poll(comp('cam-main', 'camera')).toEqual({ type: 'perspective', fovY: 45, near: 0.1, far: 250 });
  await undo(page);
  await expect.poll(comp('cam-main', 'camera')).toEqual({ type: 'perspective', fovY: 45, near: 0.1, far: 100 });
  await inspector(page).getByRole('button', { name: 'remove camera', exact: true }).click();
  await expect(inspector(page).getByRole('alert').filter({ hasText: 'exactly one active camera' })).toBeVisible();
  expect(await comp('cam-main', 'camera')()).toBeDefined();
  await select(page, id);
  await add(page, 'Camera');
  await expect(inspector(page).getByRole('alert').filter({ hasText: 'camera_count_invalid' })).toBeVisible();
  expect(await comp(id, 'camera')()).toBeUndefined();

  // Camera follow on the main camera: dead zone and the optional bounds.
  await select(page, 'cam-main');
  await add(page, 'Camera follow');
  await expect.poll(comp('cam-main', 'cameraFollow')).toEqual({ deadZone: { x: 0.5, y: 0.5 }, smoothing: 0.2 });
  await field(page, 'cameraFollow deadZone x', '1');
  await inspector(page).getByRole('button', { name: 'add cameraFollow bounds', exact: true }).click();
  await expect.poll(comp('cam-main', 'cameraFollow')).toEqual({ deadZone: { x: 1, y: 0.5 }, smoothing: 0.2, bounds: { minX: -50, maxX: 50, minY: -10, maxY: 20 } });
  await inspector(page).getByRole('button', { name: 'remove cameraFollow bounds', exact: true }).click();
  await expect.poll(comp('cam-main', 'cameraFollow')).toEqual({ deadZone: { x: 1, y: 0.5 }, smoothing: 0.2 });
  await inspector(page).getByRole('button', { name: 'remove cameraFollow', exact: true }).click();
  await expect.poll(comp('cam-main', 'cameraFollow')).toBeUndefined();

  // Picked components: a script, a model (then an animator on it), a sound.
  await select(page, id);
  await add(page, 'Script');
  await inspector(page).getByLabel('behavior behaviorId', { exact: true }).selectOption({ label: 'Drift' });
  await inspector(page).getByRole('button', { name: 'Add', exact: true }).click();
  await expect.poll(comp(id, 'behavior')).toMatchObject({ behaviorId });
  const speed = inspector(page).locator('[data-component="behavior"] input.tl-prop__input');
  await speed.fill('7');
  await speed.press('Enter');
  await expect.poll(async () => ((await comp(id, 'behavior')()) as { values: { speed?: number } }).values.speed).toBe(7);
  await inspector(page).getByRole('button', { name: 'remove behavior', exact: true }).click();
  await expect.poll(comp(id, 'behavior')).toBeUndefined();

  const dir = mkdtempSync(join(tmpdir(), 'tl-inspector-'));
  writeFileSync(join(dir, 'column.glb'), skinnedGlb());
  const model = await importFile(page, join(dir, 'column.glb'), 1, 'column');
  const sound = await importFile(page, join(REPO, 'fixtures', 'm3', 'media', 'wav', 'cue-goal.wav'), 2, 'cue-goal');
  await select(page, id);
  await add(page, 'Model');
  await inspector(page).getByLabel('model asset assetId', { exact: true }).selectOption(model);
  await inspector(page).getByRole('button', { name: 'Add', exact: true }).click();
  await expect.poll(comp(id, 'model')).toEqual({ asset: { assetId: model } });
  await expect(inspector(page).locator('.tl-inspector__kind')).toHaveText('model');
  // An animator for the model: a controller made in the Animator window, picked in the Inspector.
  await page.getByRole('tab', { name: 'Animator' }).click();
  await page.getByLabel('animator model').selectOption(model);
  await page.getByRole('button', { name: 'New controller' }).click();
  await expect.poll(async () => (((await be.command({ op: 'queryGameConfig', projectId: be.projectId }))['animators'] as unknown[]) ?? []).length).toBe(1);
  await select(page, id);
  await add(page, 'Animator');
  await inspector(page).getByLabel('animator controller', { exact: true }).selectOption({ index: 1 });
  await inspector(page).getByRole('button', { name: 'Add', exact: true }).click();
  await expect.poll(async () => typeof ((await comp(id, 'animator')()) as { controller?: string } | undefined)?.controller).toBe('string');
  await inspector(page).getByRole('button', { name: 'remove animator', exact: true }).click();
  await expect.poll(comp(id, 'animator')).toBeUndefined();
  await inspector(page).getByRole('button', { name: 'remove model', exact: true }).click();
  await expect.poll(comp(id, 'model')).toBeUndefined();
  await expect(inspector(page).locator('.tl-inspector__kind')).toHaveText('entity');

  await add(page, 'Audio source');
  await inspector(page).getByLabel('audioSource assetId', { exact: true }).selectOption(sound);
  await inspector(page).getByRole('button', { name: 'Add', exact: true }).click();
  await expect.poll(comp(id, 'audioSource')).toEqual({ assetId: sound, volume: 0.8, range: 12 });
  await field(page, 'audioSource volume', '0.5');
  await expect.poll(comp(id, 'audioSource')).toEqual({ assetId: sound, volume: 0.5, range: 12 });
  await inspector(page).getByRole('button', { name: 'remove audioSource', exact: true }).click();
  await expect.poll(comp(id, 'audioSource')).toBeUndefined();

  // The Component menu is the same list.
  await menu(page, 'Component', 'Health');
  await expect.poll(comp(id, 'health')).toEqual({ max: 3, invulnerableSeconds: 1 });
  await menu(page, 'Component', 'Remove', 'Health');
  await expect.poll(comp(id, 'health')).toBeUndefined();
});

test('the game block is built from its descriptor: create, texts, references and sound cues', async ({ page }) => {
  test.setTimeout(180_000);
  await cmd('createEntity', { kind: 'group', name: 'Player', components: { controller: {} } });
  await cmd('createEntity', { kind: 'group', name: 'Start', components: { playerSpawn: {} } });
  await cmd('createEntity', { kind: 'group', name: 'Goal', transform: { position: [6, 0, 0] }, components: { gameZone: { role: 'goal', size: [2, 2] } } });
  // The game camera follows the player (the game block names a camera with camera follow).
  await cmd('setComponent', { entityId: 'cam-main', component: 'cameraFollow', value: { deadZone: { x: 0.5, y: 0.5 }, smoothing: 0.2 } });
  await page.goto(be.editorUrl);
  await expect(page.locator('.tl-statusbar')).toContainText('connected');
  const sound = await importFile(page, join(REPO, 'fixtures', 'm3', 'media', 'wav', 'cue-goal.wav'), 1, 'cue-goal');
  const game = async () => (await be.command({ op: 'queryGameConfig', projectId: be.projectId }))['game'] as Record<string, unknown> | null;

  await page.getByRole('tab', { name: 'Gameplay' }).click();
  const block = page.getByLabel('game block');
  await block.getByRole('button', { name: 'Create game block' }).click();
  await expect.poll(game).toMatchObject({ configVersion: 2, title: 'Untitled game', cameraId: 'cam-main', cues: { start: null, jump: null, checkpoint: null, death: null, goal: null } });
  const title = block.getByLabel('game title', { exact: true });
  await title.fill('Neutral test');
  await title.press('Enter');
  await expect.poll(async () => (await game())?.['title']).toBe('Neutral test');
  await block.getByLabel('game cues goal', { exact: true }).selectOption(sound);
  await expect.poll(async () => (await game())?.['cues']).toEqual({ start: null, jump: null, checkpoint: null, death: null, goal: sound });
  await undo(page);
  await expect.poll(async () => ((await game())?.['cues'] as { goal: unknown }).goal).toBeNull();
  // Phase 15.3: the session timing is a descriptor field of the block too.
  await expect(block.getByLabel('game respawnDelay', { exact: true })).toHaveValue('0.25');
  const delay = block.getByLabel('game respawnDelay', { exact: true });
  await delay.fill('0.5');
  await delay.press('Enter');
  await expect.poll(async () => (await game())?.['respawnDelay']).toBe(0.5);
});

test('the gameplay settings are built from their descriptor: a number and the step-rate choice', async ({ page }) => {
  test.setTimeout(120_000);
  await page.goto(be.editorUrl);
  await expect(page.locator('.tl-statusbar')).toContainText('connected');
  const settings = (): Record<string, unknown> => (JSON.parse(readFileSync(join(be.projectDir, 'content.json'), 'utf8')) as { content: { settings: Record<string, unknown> } }).content.settings;
  await page.getByRole('tab', { name: 'Gameplay' }).click();
  await page.locator('.tl-gameplay__tabs').getByRole('button', { name: 'settings', exact: true }).click();
  const tab = page.getByLabel('gameplay settings');
  const run = tab.getByLabel('settings run_speed', { exact: true });
  await run.fill('5');
  await run.press('Enter');
  await expect.poll(() => settings()['run_speed']).toBe(5);
  // An int with allowed values (15.3) is a select of exactly those values.
  const hz = tab.getByLabel('settings fixed_step_hz', { exact: true });
  await expect(hz).toHaveValue('120');
  await expect(hz.locator('option')).toHaveText(['60 Hz', '120 Hz', '240 Hz']);
  await hz.selectOption('60');
  await expect.poll(() => settings()['fixed_step_hz']).toBe(60);
  await expect(tab.getByLabel('settings audio_voices', { exact: true })).toHaveValue('8');
  await undo(page);
  await expect.poll(() => settings()['fixed_step_hz']).toBeUndefined();
});
