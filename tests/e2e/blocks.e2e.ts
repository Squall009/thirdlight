/**
 * Gameplay blocks built in the editor and played. On the
 * starter template's ground the GameObject → Gameplay menu places a
 * collectible, a pressure plate and a door, a one-way shelf, a lift and a
 * trigger; the Inspector sets them up (positions, the lift's path and
 * signal). In Play (the game plays as a scene: no game session), driven by
 * exclusive test input, the character collects the collectible (its named
 * counter), opens the door by stepping on the plate, jumps up through the
 * shelf, walks onto the lift and rides it up. The 2D-plane switches work
 * without a game session.
 */
import { expect, test, type Page } from '@playwright/test';

import { startBackend, type E2EBackend, controls } from './backend';
import { menu } from './ui';

let be: E2EBackend;
test.beforeEach(async () => {
  be = await startBackend('blocks-e2e', 'starter');
});
test.afterEach(async () => {
  await be.stop();
});

async function relay(path: string, body: unknown): Promise<{ status: number; json: Record<string, unknown> }> {
  const r = await fetch(`${be.origin}/api/v1/projects/${be.projectId}/play/${path}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${be.token}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: r.status, json: (await r.json()) as Record<string, unknown> };
}

type Observation = { state: string; player?: { x: number; y: number }; counters?: Record<string, number> };

/** Type a value into an Inspector field and commit it. */
async function field(page: Page, label: string, value: string): Promise<void> {
  const f = page.locator('.tl-inspector').getByLabel(label, { exact: true });
  await f.fill(value);
  await f.press('Enter');
  await expect(f).toHaveValue(value);
}

async function place(page: Page, x: number, y: number): Promise<void> {
  await field(page, 'position x', String(x));
  await field(page, 'position y', String(y));
  await field(page, 'position z', '0');
}

async function create(page: Page, item: string, x: number, y: number): Promise<void> {
  await menu(page, 'GameObject', 'Gameplay', item);
  await expect(page.locator('.tl-inspector__name')).toHaveValue(item.startsWith('Door') ? 'Door' : item);
  await place(page, x, y);
}

async function removeEntity(page: Page, id: string): Promise<void> {
  await page.locator(`.tl-hierarchy__list li[data-entity-id="${id}"]`).click();
  await menu(page, 'Edit', 'Delete');
  await expect(page.locator(`.tl-hierarchy__list li[data-entity-id="${id}"]`)).toHaveCount(0);
}

test('a level built from gameplay blocks plays: a collectible, plate and door, one-way shelf, lift', async ({ page }) => {
  test.setTimeout(240_000);
  await page.goto(be.editorUrl);
  await expect(page.locator('.tl-statusbar')).toContainText('connected');

  // Clear the starter's step and platform (the character starts at x 3 on a ground from x −4 to 20).
  await removeEntity(page, 'box-0002');
  await removeEntity(page, 'box-0003');

  await create(page, 'Collectible', 4.5, 0.5);
  await create(page, 'Switch', 7, 0.1);
  await page.getByLabel('switch mode').selectOption('stand');
  await expect(page.getByLabel('switch mode')).toHaveValue('stand');
  await create(page, 'Door (opens on "open")', 9, 1.5);
  await create(page, 'One-way platform', 12, 0.8);
  await expect(page.getByLabel('collider oneWay', { exact: true })).toBeChecked();
  await create(page, 'Moving platform', 14.5, 0.7);
  await field(page, 'mover waypoints 1 x', '0');
  await field(page, 'mover waypoints 1 y', '2');
  await page.getByLabel('mover mode').selectOption('once');
  await expect(page.getByLabel('mover mode')).toHaveValue('once');
  await field(page, 'mover startOn', 'ride');
  await create(page, 'Trigger', 14.5, 1.9);
  await field(page, 'trigger signal', 'ride');
  await field(page, 'trigger size w', '1.6');
  await field(page, 'trigger size h', '1.6');
  await field(page, 'trigger exitSignal', 'left');

  // The stored components (what Play and the export read).
  const stored = (await be.command({ op: 'queryEntities', projectId: be.projectId, args: { limit: 100, offset: 0 } })) as { entities?: { name?: string; components: Record<string, unknown> }[] };
  const byName = (n: string) => stored.entities?.find((e) => e.name === n)?.components;
  expect(byName('Moving platform')?.['mover']).toEqual({ waypoints: [[0, 2, 0]], speed: 2, mode: 'once', wait: 0.5, startOn: 'ride' });
  expect(byName('Trigger')?.['trigger']).toEqual({ size: [1.6, 1.6], signal: 'ride', exitSignal: 'left' });
  const counter = String((byName('Collectible')?.['collectible'] as { counter?: string } | undefined)?.counter);
  expect(counter).toMatch(/^[A-Za-z_]/);

  // Play (a scene: it runs at once).
  const started = page.waitForResponse((r) => r.request().method() === 'POST' && r.url().endsWith('/play'));
  await page.getByTitle('Start an isolated play preview').click();
  const psid = String(((await (await started).json()) as { playSessionId: string }).playSessionId);
  const observe = async (): Promise<Observation> => (await relay(`${psid}/observe`, {})).json as unknown as Observation;
  await expect.poll(async () => (await relay(`${psid}/observe`, {})).status, { timeout: 30_000 }).toBe(200);
  await expect.poll(async () => (await observe()).state).toBe('running');
  await page.waitForTimeout(400);

  const drive = async (frames: { moveX: number; jump: 'none' | 'pressed' | 'held' }[]): Promise<void> => {
    const r = await relay(`${psid}/input`, { mode: 'exclusive-test', frames: frames.map((f, i) => ({ stepOffset: i, ...controls(f.moveX, f.jump) })) });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
  };
  const run = (n: number, moveX = 1) => Array.from({ length: n }, () => ({ moveX, jump: 'none' as const }));
  /** Walk right in chunks until x ≥ target. */
  const walkTo = async (target: number, chunk = 12): Promise<Observation> => {
    for (let i = 0; i < 120; i++) {
      if ((await observe()).player!.x >= target) break;
      await drive(run(chunk));
    }
    return observe();
  };

  // The collectible: its counter goes up by its amount (1).
  await walkTo(5.2);
  await expect.poll(async () => (await observe()).counters?.[counter]).toBe(1);

  // Plate → door: the door (x 9) blocks until the plate opens it.
  const past = await walkTo(9.8);
  expect(past.player!.x).toBeGreaterThan(9.4);

  // One-way shelf: walk under it, jump up through it, stand on top (top 0.9 m).
  await walkTo(11.8, 4);
  const below = (await observe()).player!.y;
  expect(below).toBeLessThan(1.2);
  await drive([{ moveX: 0, jump: 'pressed' }, ...Array.from({ length: 50 }, () => ({ moveX: 0, jump: 'held' as const })), ...run(60, 0)]);
  const onShelf = (await observe()).player!.y;
  expect(onShelf).toBeGreaterThan(below + 0.7);

  // Walk onto the lift (the trigger on it sends "ride"); it carries the character up 2 m.
  await walkTo(14.4, 3);
  await expect.poll(async () => (await observe()).player!.y, { timeout: 15_000 }).toBeGreaterThan(onShelf + 1.7);
  const top = await observe();
  expect(top.player!.x).toBeGreaterThan(13.5);
  expect(top.player!.x).toBeLessThan(15.5);
});
