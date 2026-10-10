/**
 * The generic Inspector against a real backend, on a neutral new
 * project (a camera, a sun, an ambient light). Every component kind is added
 * from "+ Add component" with its descriptor value (or the picked asset,
 * controller or script), one of its fields is edited through the widget its
 * descriptor type gets, the stored value is read back from the backend, one
 * undo restores it, and "remove" takes the component off — each step one
 * command. Components that cannot be added say why. A content table built from its descriptor (the event sounds) sends a second
 * edit on top of a first whose result is still on its way.
 */
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { expect as baseExpect, test, type Page } from './pw';

// Each edit is a backend round trip plus an Inspector redraw; on a loaded host 5 s is not always enough.
const expect = baseExpect.configure({ timeout: 15_000 });

import { startBackend, type E2EBackend } from './backend';
import { skinnedGlb } from './skinned-glb';
import { menu, projectWindow, openWindow, closeEditor, openProjectSettings, expectEditorOpen, chooseItem, createItem } from './ui';

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
/** The editor has seen the backend's latest revision (a busy page applies a change late; an edit sent before that is a revision conflict). */
async function synced(page: Page): Promise<void> {
  const rev = Number((await be.command({ op: 'queryProject', projectId: be.projectId, args: {} })).revision);
  await expect(page.locator('.tl-statusbar')).toContainText(new RegExp(`revision ${rev}(?!\\d)`));
}
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
  await projectWindow(page);
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
  { option: 'Player spawn', name: 'playerSpawn', added: {} },
  { option: 'Mover', name: 'mover', added: { speed: 2 }, edit: (p) => field(p, 'mover waypoints 1 y', '3'), after: { waypoints: [[4, 3, 0]] } },
  { option: 'Trigger', name: 'trigger', added: { size: [2, 2] }, edit: (p) => inspector(p).getByLabel('trigger shape', { exact: true }).selectOption('circle'), after: { shape: 'circle', radius: 1 } },
  { option: 'Switch', name: 'switch', added: { mode: 'interact' }, edit: (p) => inspector(p).getByLabel('switch once', { exact: true }).click(), after: { once: true } },
  { option: 'Health', name: 'health', added: { max: 3 }, edit: (p) => field(p, 'health max', '5'), after: { max: 5 } },
  { option: 'Collectible', name: 'collectible', added: { counter: 'items' }, edit: (p) => field(p, 'collectible amount', '5'), after: { amount: 5 } },
  { option: 'Patrol: Edge to edge', name: 'patrol', added: { mode: 'edges' }, edit: (p) => field(p, 'patrol speed', '2.5'), after: { speed: 2.5 } },
  { option: 'Hitbox: Box', name: 'hitbox', added: { size: [1, 1] }, edit: (p) => field(p, 'hitbox damage', '2'), after: { damage: 2 } },
  { option: 'Face movement: Two sides', name: 'faceMovement', added: { turnSeconds: 0.12 }, edit: (p) => field(p, 'faceMovement turnSeconds', '0.3'), after: { turnSeconds: 0.3 } },
];

test('every component kind: added, edited (one undo) and removed through the Inspector', async ({ page }) => {
  test.setTimeout(300_000);
  await cmd('setMaterial', { material: { materialId: 'mat-plain', name: 'Plain', shader: 'standard', params: {}, textures: {} } });
  await cmd('setMaterial', { material: { materialId: 'mat-stain', name: 'Stain', shader: 'decal', params: { blend: 'multiply' }, textures: {} } });
  const behaviorId = 'behavior-drift';
  await cmd('publishBehavior', { behaviorId, displayName: 'Drift', mode: 'declaration-create', declaration: { properties: [{ key: 'speed', label: 'Speed', type: 'number', default: 3.5, min: -100, max: 100, step: 0.5 }] } });

  await page.goto(be.editorUrl);
  await expect(page.locator('.tl-statusbar')).toContainText('connected');

  // One empty object carries each menu component in turn.
  await menu(page, 'GameObject', 'Create empty');
  const row = page.locator('.tl-hierarchy__list li.tl-row.is-selected');
  const id = (await row.getAttribute('data-entity-id'))!;
  await expect(inspector(page).getByLabel('add component', { exact: true })).toBeVisible();
  // A project without tags says where they are made today.
  await expect(inspector(page).getByText('No project tags yet (File → Project Settings… → Tags).')).toBeVisible();
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

  // Exclusions say why: with a box on, a model cannot be added.
  await add(page, 'Box');
  await expect.poll(comp(id, 'box')).toBeDefined();
  const options = inspector(page).getByLabel('add component', { exact: true }).locator('option');
  await expect(options.filter({ hasText: /^Model — an object shows one model or box/ })).toHaveCount(1);
  await expect(options.filter({ hasText: /^Instance set — made by the/ })).toHaveCount(1);
  // A surface needs a box or a model: it is on offer now; its presets are a custom widget.
  await add(page, 'Surface');
  await expect.poll(comp(id, 'surface')).toBeDefined();
  await field(page, 'surface roughness', '0.2');
  await expect.poll(async () => ((await comp(id, 'surface')()) as { roughness?: number }).roughness).toBe(0.2);
  await synced(page);
  await inspector(page).getByLabel('surface preset', { exact: true }).selectOption('signal-red');
  await expect.poll(async () => ((await comp(id, 'surface')()) as { roughness?: number }).roughness).not.toBe(0.2);
  await inspector(page).getByRole('button', { name: 'remove surface', exact: true }).click();
  await expect.poll(comp(id, 'surface')).toBeUndefined();
  await synced(page);
  // Materials: the mapping editor (it knows the model's own material names) is this section's custom widget.
  await inspector(page).getByRole('combobox', { name: 'material for all' }).selectOption({ label: 'Plain' });
  await expect.poll(comp(id, 'materials')).toEqual({ '*': 'mat-plain' });
  await synced(page);
  await inspector(page).getByRole('button', { name: 'remove materials', exact: true }).click();
  await expect.poll(comp(id, 'materials')).toBeUndefined();
  await synced(page);
  // Decal layers: a box left out of layer 2 stores its mask; back in every layer, the field is gone again.
  const decalLayers = async (): Promise<unknown> => ((await comp(id, 'box')()) as { decalLayers?: number }).decalLayers;
  await inspector(page).getByLabel('box decalLayers Layer 2', { exact: true }).click();
  await expect.poll(decalLayers).toBe(253);
  await synced(page);
  await inspector(page).getByLabel('box decalLayers Layer 2', { exact: true }).click();
  await expect.poll(decalLayers).toBeUndefined();
  // A decal (picked material), its sort order and layers edited, one undo, removed.
  await add(page, 'Decal');
  await inspector(page).getByLabel('decal material', { exact: true }).selectOption({ label: 'Stain' });
  await inspector(page).getByRole('button', { name: 'Add', exact: true }).click();
  await expect.poll(comp(id, 'decal')).toEqual({ size: [1, 1, 1], material: 'mat-stain' });
  await field(page, 'decal sortOrder', '4');
  await expect.poll(comp(id, 'decal')).toEqual({ size: [1, 1, 1], material: 'mat-stain', sortOrder: 4 });
  await synced(page);
  await inspector(page).getByLabel('decal layers Layer 3', { exact: true }).click();
  await expect.poll(comp(id, 'decal')).toEqual({ size: [1, 1, 1], material: 'mat-stain', sortOrder: 4, layers: 251 });
  await undo(page);
  await expect.poll(comp(id, 'decal')).toEqual({ size: [1, 1, 1], material: 'mat-stain', sortOrder: 4 });
  await inspector(page).getByRole('button', { name: 'remove decal', exact: true }).click();
  await expect.poll(comp(id, 'decal')).toBeUndefined();
  // The box itself is removable too (one command; undo brings it back).
  await inspector(page).getByRole('button', { name: 'remove box', exact: true }).click();
  await expect.poll(comp(id, 'box')).toBeUndefined();
  await undo(page);
  await expect.poll(comp(id, 'box')).toBeDefined();
  await inspector(page).getByRole('button', { name: 'remove box', exact: true }).click();
  await expect.poll(comp(id, 'box')).toBeUndefined();

  // The camera is a shot (the engine owns the view): its lens fields (one undo); any object takes a camera too.
  await select(page, 'cam-main');
  await field(page, 'virtualCamera fovY', '45');
  await field(page, 'virtualCamera far', '250');
  await expect.poll(comp('cam-main', 'virtualCamera')).toEqual({ rig: 'fixed', priority: -1000, fovY: 45, far: 250 });
  await undo(page);
  await expect.poll(comp('cam-main', 'virtualCamera')).toEqual({ rig: 'fixed', priority: -1000, fovY: 45 });
  await select(page, id);
  await add(page, 'Virtual camera: Fixed / look-at');
  await expect.poll(comp(id, 'virtualCamera')).toEqual({ rig: 'fixed' });
  await inspector(page).getByRole('button', { name: 'remove virtualCamera', exact: true }).click();
  await expect.poll(comp(id, 'virtualCamera')).toBeUndefined();

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
  // The model is skinned: its absent decal layers are none (a world projector would slide over the skin).
  for (const n of [1, 8]) await expect(inspector(page).getByLabel(`model decalLayers Layer ${n}`, { exact: true })).not.toBeChecked();
  // An animator for the model: a controller made from the project window's Create menu, picked in the Inspector.
  await chooseItem(page, 'model', model);
  await createItem(page, 'Animator controller', 'New animator');
  await expect.poll(async () => (((await be.command({ op: 'queryGameConfig', projectId: be.projectId }))['animators'] as unknown[]) ?? []).length).toBe(1);
  // The new controller opens in the editor window (the Inspector then shows the graph); back to the Scene.
  await expectEditorOpen(page, 'Animator', 'New animator');
  await closeEditor(page);
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
  await expect.poll(comp(id, 'health')).toEqual({ max: 3 });
  await menu(page, 'Component', 'Remove', 'Health');
  await expect.poll(comp(id, 'health')).toBeUndefined();
});

test('a content table built from its descriptor sends a second edit on top of a first still on its way (event sounds)', async ({ page }) => {
  test.setTimeout(180_000);
  // The first edit's result is held back (its HTTP ack below, its WS event here, in order) so the second
  // edit is made before the editor has seen the first — what a busy page does. The event
  // sounds table stands for any descriptor-built content block.
  let holdName = false;
  await page.routeWebSocket(/\/api\/v1\/ws/, (ws) => {
    const server = ws.connectToServer();
    let chain = Promise.resolve();
    server.onMessage((m) => {
      const held = holdName && typeof m === 'string' && m.includes('neutral-test');
      chain = chain.then(() => (held ? new Promise((r) => setTimeout(r, 1500)) : undefined)).then(() => ws.send(m));
    });
    ws.onMessage((m) => server.send(m));
  });
  await page.goto(be.editorUrl);
  await expect(page.locator('.tl-statusbar')).toContainText('connected');
  const first = await importFile(page, join(REPO, 'fixtures', 'm3', 'media', 'wav', 'cue-goal.wav'), 1, 'cue-goal');
  const second = await importFile(page, join(REPO, 'fixtures', 'm3', 'media', 'wav', 'cue-start.wav'), 2, 'cue-start');
  const cues = (): { on: string; name: string; assetId: string }[] => (JSON.parse(readFileSync(join(be.projectDir, 'content.json'), 'utf8')) as { content: { eventCues?: { on: string; name: string; assetId: string }[] } }).content.eventCues ?? [];

  await openWindow(page, 'Media');
  const table = page.getByLabel('event sounds');
  await table.getByLabel('new event sound name', { exact: true }).fill('opened');
  await table.getByLabel('new event sound asset', { exact: true }).selectOption(first);
  await table.getByRole('button', { name: 'add event sound' }).click();
  await expect.poll(cues).toEqual([{ on: 'signal', name: 'opened', assetId: first }]);
  const row = table.getByLabel('event sound 1', { exact: true });
  // The second edit must be sent after the first and on top of it, not refused as a conflict.
  holdName = true;
  // Only the first edit is held: the second is built on top of it, so its body names 'neutral-test'
  // too. The route stays in place (every other command passes straight through): unrouting while
  // the second command is inside the handler leaves that request without an answer, and the
  // editor, which sends its own commands one at a time, then waits on it for good.
  let held = false;
  let heldDelivered!: () => void;
  const delivered = new Promise<void>((r) => { heldDelivered = r; });
  await page.route('**/commands', async (route) => {
    const body = route.request().postData() ?? '';
    if (!held && body.includes('"setEventCues"') && body.includes('neutral-test')) {
      held = true;
      // The backend applies the command here; only its ack reaches the page late.
      const res = await route.fetch();
      await new Promise((r) => setTimeout(r, 1500));
      await route.fulfill({ response: res });
      heldDelivered();
    } else await route.continue();
  });
  const name = row.getByLabel('eventCue name', { exact: true });
  await name.fill('neutral-test');
  await name.press('Enter');
  await row.getByLabel('eventCue assetId', { exact: true }).selectOption(second);
  await expect.poll(() => cues()[0]?.name).toBe('neutral-test');
  await delivered;
  holdName = false;
  await expect.poll(cues).toEqual([{ on: 'signal', name: 'neutral-test', assetId: second }]);
  await undo(page);
  await expect.poll(() => cues()[0]?.assetId).toBe(first);
  // The row's lateness bound (how late its sound may still start) is a field of the same form.
  const late = row.getByLabel('eventCue maxLateMs', { exact: true });
  await late.fill('250');
  await late.press('Enter');
  await expect.poll(() => (cues()[0] as { maxLateMs?: number } | undefined)?.maxLateMs).toBe(250);
});

test('the gameplay settings are built from their descriptor: a number and the step-rate choice', async ({ page }) => {
  test.setTimeout(120_000);
  await page.goto(be.editorUrl);
  await expect(page.locator('.tl-statusbar')).toContainText('connected');
  const settings = (): Record<string, unknown> => (JSON.parse(readFileSync(join(be.projectDir, 'content.json'), 'utf8')) as { content: { settings: Record<string, unknown> } }).content.settings;
  await openProjectSettings(page, 'Gameplay');
  await page.locator('.tl-gameplay__tabs').getByRole('button', { name: 'settings', exact: true }).click();
  const tab = page.getByLabel('gameplay settings');
  const run = tab.getByLabel('settings run_speed', { exact: true });
  await run.fill('5');
  await run.press('Enter');
  await expect.poll(() => settings()['run_speed']).toBe(5);
  // An int with allowed values is a select of exactly those values.
  const hz = tab.getByLabel('settings fixed_step_hz', { exact: true });
  await expect(hz).toHaveValue('120');
  await expect(hz.locator('option')).toHaveText(['60 Hz', '120 Hz', '240 Hz']);
  await hz.selectOption('60');
  await expect.poll(() => settings()['fixed_step_hz']).toBe(60);
  await expect(tab.getByLabel('settings audio_voices', { exact: true })).toHaveValue('8');
  await undo(page);
  await expect.poll(() => settings()['fixed_step_hz']).toBeUndefined();
});
