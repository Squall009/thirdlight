/**
 * Mover signals and the gravity easing, set up in the editor and
 * played, on the starter template (a 2D-plane scene) against a real backend.
 *
 * Editor: GameObject → Gameplay → Moving platform, 1 m above the ground left
 * of the character's start; the Inspector turns it into a held lift:
 * waypoint 2 m up, once, gravity easing, Moving off, toggle on "lift", stop
 * on "halt", reverse on "back" (a stop signal equal to the toggle signal is
 * refused). A narrow trigger over its right half sends "lift"; the character
 * and its spawn are moved onto the lift's left half. The stored mover is read
 * back through the command API.
 * Play: the lift holds (the character stands at its start height), then the
 * character walks right into the trigger; its signal moves the held lift,
 * which carries the character up 2 m.
 */
import { expect, test, type Page } from './pw';

import { STARTER, startBackend, type E2EBackend, controls } from './backend';
import { menu } from './ui';

let be: E2EBackend;
test.beforeEach(async () => {
  be = await startBackend('mover-signals-e2e', 'starter');
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

type Observation = { state: string; player?: { x: number; y: number } };

async function field(page: Page, label: string, value: string): Promise<void> {
  const f = page.locator('.tl-inspector').getByLabel(label, { exact: true });
  await f.fill(value);
  await f.press('Enter');
  await expect(f).toHaveValue(value);
}

async function create(page: Page, item: string, x: number, y: number): Promise<void> {
  await menu(page, 'GameObject', 'Gameplay', item);
  await expect(page.locator('.tl-inspector__name')).toHaveValue(item);
  await field(page, 'position x', String(x));
  await field(page, 'position y', String(y));
  await field(page, 'position z', '0');
}

test('a held lift with toggle/stop/reverse signals and gravity easing, set in the Inspector, is moved by a trigger in Play', async ({ page }) => {
  test.setTimeout(240_000);
  await page.goto(be.editorUrl);
  await expect(page.locator('.tl-statusbar')).toContainText('connected');
  const inspector = page.locator('.tl-inspector');

  // The lift: 2 m wide (x −1 to 1), 0.4 m tall, its top at y 1.2.
  await create(page, 'Moving platform', 0, 1);
  await field(page, 'mover waypoints 1 x', '0');
  await field(page, 'mover waypoints 1 y', '2');
  await inspector.getByLabel('mover mode').selectOption('once');
  await inspector.getByLabel('mover easing').selectOption('gravity');
  await expect(inspector.getByLabel('mover easing')).toHaveValue('gravity');
  const moving = inspector.getByLabel('mover active', { exact: true });
  await moving.click();
  await expect(moving).not.toBeChecked();
  await field(page, 'mover toggleOn', 'lift');
  await field(page, 'mover stopOn', 'halt');
  await field(page, 'mover reverseOn', 'back');
  // One signal cannot both toggle and stop it: refused, the stored value stays.
  const stop = inspector.getByLabel('mover stopOn', { exact: true });
  await stop.fill('lift');
  await stop.press('Enter');
  // A narrow trigger over the lift's right half.
  await create(page, 'Trigger', 0.2, 2.2);
  await field(page, 'trigger signal', 'lift');
  await field(page, 'trigger size w', '0.4');
  // The character (and its spawn) on the lift's left half.
  for (const id of [STARTER.playerId, STARTER.spawnId]) {
    await page.locator(`.tl-hierarchy__list li[data-entity-id="${id}"]`).click();
    await field(page, 'position x', '-0.6');
    await field(page, 'position y', '2.12');
  }

  const stored = (await be.command({ op: 'queryEntities', projectId: be.projectId, args: { limit: 100, offset: 0 } })) as { entities?: { name?: string; components: Record<string, unknown> }[] };
  const lift = stored.entities?.find((e) => e.name === 'Moving platform')?.components['mover'];
  expect(lift).toEqual({ waypoints: [[0, 2, 0]], speed: 2, mode: 'once', wait: 0.5, easing: 'gravity', active: false, stopOn: 'halt', toggleOn: 'lift', reverseOn: 'back' });

  const started = page.waitForResponse((r) => r.request().method() === 'POST' && r.url().endsWith('/play'));
  await page.getByTitle('Start an isolated play preview').click();
  const psid = String(((await (await started).json()) as { playSessionId: string }).playSessionId);
  const observe = async (): Promise<Observation> => (await relay(`${psid}/observe`, {})).json as unknown as Observation;
  await expect.poll(async () => (await relay(`${psid}/observe`, {})).status, { timeout: 30_000 }).toBe(200);
  await expect.poll(async () => (await observe()).state).toBe('running');
  const start = (await observe()).player!.y;
  expect(start).toBeGreaterThan(2);
  // Held: nothing moves it before the signal.
  await page.waitForTimeout(700);
  expect(Math.abs((await observe()).player!.y - start)).toBeLessThan(0.02);
  const drive = async (moveX: number, n: number): Promise<void> => {
    const r = await relay(`${psid}/input`, { mode: 'exclusive-test', frames: Array.from({ length: n }, (_, i) => ({ stepOffset: i, ...controls(moveX) })) });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
  };
  // A few steps right into the trigger, then stand.
  await drive(1, 20);
  await drive(0, 30);
  const on = await observe();
  expect(on.player!.x).toBeGreaterThan(-0.6);
  expect(on.player!.x).toBeLessThan(0.8);
  // The trigger's signal moved the held lift: it carries the character 2 m up (gravity easing: 2 m in 1 s at 2 m/s).
  await expect.poll(async () => (await observe()).player!.y, { timeout: 15_000 }).toBeGreaterThan(start + 1.9);
  const top = await observe();
  expect(top.player!.y).toBeLessThan(start + 2.1);
  expect(top.player!.x).toBeGreaterThan(-0.9);
  expect(top.player!.x).toBeLessThan(0.9);
});
