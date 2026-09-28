/**
 * Phase 24.5: the GameObject menu's create entries come from the component
 * descriptors (`create`), not from a hard-coded list. On the neutral starter
 * template: the menu shows the generic entries (a spawn point; platforms,
 * a door, a one-way platform, a trigger, a scene transition, a switch, an
 * object with health, a collectible, a patrolling object and a hitbox; a
 * camera track; a fog volume in Light) and no genre entries (no zones,
 * coins or enemies). Each entry creates an object carrying its component,
 * read back from the backend; the scene transition needs a second scene
 * and then names it. The hierarchy rows take the descriptors' icons. A 3D
 * project shows the entries that fit 3D (no one-way platform or switch; a
 * platform's collider, a hitbox and a trigger have a depth).
 */
import { randomUUID } from 'node:crypto';

import { expect, test, type Page } from '@playwright/test';

import { startBackend, type E2EBackend } from './backend';
import { closeMenu, menu, menuItem } from './ui';

let be: E2EBackend;
test.beforeEach(async () => {
  be = await startBackend('create-menu-e2e', 'starter');
});
test.afterEach(async () => {
  await be.stop();
});

async function cmd(op: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const q = await be.command({ op: 'queryProject', projectId: be.projectId, args: {} });
  const r = await be.command({ op, projectId: be.projectId, expectedRevision: Number(q['revision']), requestId: `req-${randomUUID().replace(/-/g, '')}`, origin: { kind: 'mcp', clientId: 'e2e-create-menu' }, args });
  expect(r['ok'], JSON.stringify(r)).toBe(true);
  return r;
}

type Ent = { id: string; name?: string; components: Record<string, Record<string, unknown> | undefined> };
async function entities(): Promise<Ent[]> {
  return (await be.command({ op: 'queryEntities', projectId: be.projectId, args: { limit: 200, offset: 0 } }))['entities'] as Ent[];
}

/** The labels of the open menu level (`.tl-menu` inside `scope`). */
async function labels(page: Page, scope = '.tl-menubar__menu.is-open > .tl-menu'): Promise<string[]> {
  return page.locator(`${scope} > [role=menuitem]`).evaluateAll((els) => els.map((e) => e.getAttribute('aria-label') ?? ''));
}

/** The labels of a GameObject submenu. */
async function submenu(page: Page, name: string): Promise<string[]> {
  const it = await menuItem(page, 'GameObject', name);
  await it.hover();
  await expect(it.locator('.tl-menu')).toBeVisible();
  const out = await it.locator('.tl-menu > [role=menuitem]').evaluateAll((els) => els.map((e) => e.getAttribute('aria-label') ?? ''));
  await closeMenu(page);
  return out;
}

const GAMEPLAY_2D = ['One-way platform', 'Moving platform', 'Door (opens on "open")', 'Trigger', 'Scene transition', 'Switch', 'Object with health', 'Collectible', 'Patrolling object', 'Hitbox'];
const GENRE = /coin|enemy|zone|hazard|checkpoint|goal|exit|pickup|gem|heart|life|lives|stomp|score/i;

test('the create menu lists the descriptors\' generic entries; each creates its component; no genre entries', async ({ page }) => {
  test.setTimeout(240_000);
  await page.goto(be.editorUrl);
  await expect(page.locator('.tl-statusbar')).toContainText('connected');

  // The menu: the descriptor entries and no genre entries anywhere.
  await menuItem(page, 'GameObject', 'Spawn point');
  const top = await labels(page);
  await closeMenu(page);
  expect(top).toEqual(expect.arrayContaining(['Spawn point', 'Gameplay', 'Cameras', 'Light']));
  const gameplay = await submenu(page, 'Gameplay');
  expect(gameplay).toEqual(GAMEPLAY_2D);
  expect(await submenu(page, 'Cameras')).toEqual(['Camera track']);
  expect(await submenu(page, 'Light')).toContain('Fog volume');
  for (const l of [...top, ...gameplay]) expect(l, l).not.toMatch(GENRE);

  // A scene transition needs another scene to go to.
  {
    const it = await menuItem(page, 'GameObject', 'Gameplay');
    await it.hover();
    const transition = it.getByRole('menuitem', { name: 'Scene transition', exact: true });
    await expect(transition).toBeDisabled();
    await expect(transition).toHaveAttribute('title', /second scene/);
    await closeMenu(page);
  }
  await cmd('createScene', { name: 'Far side', sceneId: 'scene-far' });
  await expect(page.getByLabel('open scene', { exact: true }).locator('option', { hasText: 'Far side' })).toHaveCount(1);

  // Each entry creates one object carrying its component (named after the entry).
  const expected: [string[], string, string, string][] = [
    [['Spawn point'], 'Spawn point', 'playerSpawn', 'spawn'],
    [['Gameplay', 'One-way platform'], 'One-way platform', 'collider', 'box'],
    [['Gameplay', 'Moving platform'], 'Moving platform', 'mover', 'box'],
    [['Gameplay', 'Door (opens on "open")'], 'Door', 'mover', 'box'],
    [['Gameplay', 'Trigger'], 'Trigger', 'trigger', 'sensor'],
    [['Gameplay', 'Scene transition'], 'Scene transition', 'trigger', 'sensor'],
    [['Gameplay', 'Switch'], 'Switch', 'switch', 'box'],
    [['Gameplay', 'Object with health'], 'Object with health', 'health', 'box'],
    [['Gameplay', 'Collectible'], 'Collectible', 'collectible', 'box'],
    [['Gameplay', 'Patrolling object'], 'Patrolling object', 'patrol', 'box'],
    [['Gameplay', 'Hitbox'], 'Hitbox', 'hitbox', 'hitbox'],
    [['Cameras', 'Camera track'], 'Camera track', 'virtualCamera', 'camera'],
    [['Light', 'Fog volume'], 'Fog volume', 'fogVolume', 'fog'],
  ];
  for (const [path, name, component] of expected) {
    const before = (await entities()).filter((e) => e.name === name).length;
    await menu(page, 'GameObject', path[0]!, path[1]);
    await expect(page.locator('.tl-inspector__name')).toHaveValue(name);
    await expect.poll(async () => (await entities()).filter((e) => e.name === name && e.components[component] !== undefined).length, { message: name }).toBe(before + 1);
  }
  const all = await entities();
  const one = (name: string): Ent => all.find((e) => e.name === name)!;
  expect(one('One-way platform').components['collider']).toEqual({ shape: { type: 'box', hx: 1.5, hy: 0.1 }, oneWay: true });
  expect(one('Moving platform').components['collider']).toEqual({ shape: { type: 'box', hx: 1, hy: 0.2 } });
  expect(one('Door').components['mover']).toMatchObject({ startOn: 'open' });
  expect(one('Scene transition').components['trigger']).toMatchObject({ signal: 'transition', sceneTransition: { scene: 'scene-far' } });
  expect(one('Collectible').components['collectible']).toEqual({ counter: 'items' });
  expect(one('Patrolling object').components['patrol']).toMatchObject({ mode: 'edges' });
  expect(one('Camera track').components['virtualCamera']).toMatchObject({ rig: 'track' });
  // No genre components were made.
  for (const e of all) for (const c of ['gameZone', 'pickup', 'enemy']) expect(e.components[c], `${e.name} ${c}`).toBeUndefined();

  // The hierarchy rows show the descriptors' icons (artwork files, or the SVG glyph of the newer kinds).
  const icon = (name: string) => page.locator(`.tl-hierarchy__list li[data-entity-id="${one(name).id}"] img.tl-row__icon`);
  await expect(icon('Spawn point')).toHaveAttribute('src', /spawn\.png$/);
  await expect(icon('Scene transition')).toHaveAttribute('src', /sensor\.png$/);
  await expect(icon('Hitbox')).toHaveAttribute('src', /^data:image\/svg\+xml/);
  await expect(icon('Camera track')).toHaveAttribute('src', /camera\.png$/);
});

test('a 3D project\'s create menu shows the entries that fit 3D', async ({ page }) => {
  test.setTimeout(120_000);
  await be.stop();
  be = await startBackend('create-menu-3d-e2e');
  await cmd('setSettings', { settings: { physics_dimension: 3 } });
  await page.goto(be.editorUrl);
  await expect(page.locator('.tl-statusbar')).toContainText('connected');
  // No one-way platform or switch (2D-plane components); the platform collider and the hitbox have a depth.
  await expect.poll(async () => submenu(page, 'Gameplay')).toEqual(['Moving platform', 'Door (opens on "open")', 'Trigger', 'Scene transition', 'Object with health', 'Collectible', 'Patrolling object', 'Hitbox']);
  await menu(page, 'GameObject', 'Gameplay', 'Moving platform');
  await expect.poll(async () => (await entities()).filter((e) => e.name === 'Moving platform').map((e) => e.components['collider'])).toContainEqual({ shape: { type: 'box', hx: 1, hy: 0.2, hz: 1 } });
  await menu(page, 'GameObject', 'Gameplay', 'Hitbox');
  await expect.poll(async () => (await entities()).filter((e) => e.name === 'Hitbox').map((e) => e.components['hitbox'])).toContainEqual({ size: [1, 1, 1] });
  await menu(page, 'GameObject', 'Gameplay', 'Trigger');
  await expect.poll(async () => (await entities()).filter((e) => e.name === 'Trigger').map((e) => e.components['trigger'])).toContainEqual({ size: [2, 2, 2], signal: 'trigger' });
});
