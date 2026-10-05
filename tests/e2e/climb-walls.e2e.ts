/**
 * Climb volumes, the controller's climb and wall fields and
 * gravity bodies in the editor, and climbing in Play, on the starter template
 * (a 2D-plane scene) against a real backend.
 *
 * Editor: GameObject → Gameplay → Climb volume, placed right of the
 * character, its height set in the Inspector and its width dragged with its
 * Scene-view size handle (one undo puts it back); the character's controller
 * gets a climb speed and wall slide / wall jump switched on in its "Climbing
 * and walls" group; "+ Add component" → Gravity on a box. Each stored value
 * is read back through the command API.
 * Play: the character walks into the volume and pushes up (the move action's
 * up, sent as exclusive test input): it rises at the climb speed with no
 * gravity, and a jump press lets go (it falls back to the ground).
 */
import { expect, test, type Page } from '@playwright/test';

import { STARTER, startBackend, type E2EBackend, controls } from './backend';
import { menu } from './ui';

let be: E2EBackend;
test.beforeEach(async () => {
  be = await startBackend('climb-walls-e2e', 'starter');
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

async function field(page: Page, label: string, value: string): Promise<void> {
  const f = page.locator('.tl-inspector').getByLabel(label, { exact: true });
  await f.fill(value);
  await f.press('Enter');
  await expect(f).toHaveValue(value);
}

async function stored(name: string, component: string): Promise<unknown> {
  const r = (await be.command({ op: 'queryEntities', projectId: be.projectId, args: { limit: 100, offset: 0 } })) as { entities?: { id: string; name?: string; components: Record<string, unknown> }[] };
  return r.entities?.find((e) => e.name === name || e.id === name)?.components[component];
}

type Grip = { component: string; kind: string; handle: string; x: number; y: number };
const view = (page: Page) => page.locator('canvas[data-size-handles]');
async function grip(page: Page, component: string, kind: string, handle: string): Promise<Grip> {
  const find = async (): Promise<Grip | undefined> => (JSON.parse((await view(page).getAttribute('data-size-handles')) ?? '[]') as Grip[]).find((g) => g.component === component && g.kind === kind && g.handle === handle);
  await expect.poll(async () => (await find()) !== undefined, { message: `${component} ${kind} ${handle}` }).toBe(true);
  let last = '';
  await expect
    .poll(
      async () => {
        const g = await find();
        const now = g === undefined ? '' : `${Math.round(g.x)},${Math.round(g.y)}`;
        const same = now !== '' && now === last;
        last = now;
        return same;
      },
      { intervals: [200] },
    )
    .toBe(true);
  return (await find())!;
}

test('a climb volume, climb and wall fields and gravity set up in the editor; the character climbs in Play', async ({ page }) => {
  test.setTimeout(240_000);
  await page.goto(be.editorUrl);
  await expect(page.locator('.tl-statusbar')).toContainText('connected');
  const inspector = page.locator('.tl-inspector');

  // The climb volume: 1 m wide, 6 m tall, standing on the ground at x 5 (y 0–6).
  await menu(page, 'GameObject', 'Gameplay', 'Climb volume');
  await expect(page.locator('.tl-inspector__name')).toHaveValue('Climb volume');
  await field(page, 'position x', '5');
  await field(page, 'position y', '3');
  await field(page, 'position z', '0');
  await field(page, 'climbVolume size h', '6');
  await expect.poll(() => stored('Climb volume', 'climbVolume')).toEqual({ size: [1, 6] });
  // Its Scene-view size handle: drag the side grip wider, one undo back.
  await page.keyboard.press('f');
  const side = await grip(page, 'climbVolume', 'box2', 'side');
  await page.mouse.move(side.x, side.y);
  await page.mouse.down();
  for (let i = 1; i <= 8; i++) await page.mouse.move(side.x + (40 * i) / 8, side.y);
  await page.mouse.up();
  await expect.poll(async () => ((await stored('Climb volume', 'climbVolume')) as { size: number[] }).size[0]).toBeGreaterThan(1.05);
  await view(page).hover();
  await page.keyboard.press('Control+z');
  await expect.poll(() => stored('Climb volume', 'climbVolume')).toEqual({ size: [1, 6] });

  // The character's climb speed and wall abilities (off by default).
  await page.locator(`.tl-hierarchy__list li[data-entity-id="${STARTER.playerId}"]`).click();
  await field(page, 'controller climbSpeed', '3');
  const slide = inspector.getByLabel('controller wallSlide', { exact: true });
  await expect(slide).not.toBeChecked();
  await slide.click();
  await expect(slide).toBeChecked();
  const wallJump = inspector.getByLabel('controller wallJump', { exact: true });
  await wallJump.click();
  await expect(wallJump).toBeChecked();
  await field(page, 'controller wallJumpAway', '5');
  await expect.poll(async () => stored(STARTER.playerId, 'controller')).toMatchObject({ climbSpeed: 3, wallSlide: true, wallJump: true, wallJumpAway: 5 });

  // Gravity on a box up in the air.
  await menu(page, 'GameObject', 'Box');
  // The create is answered by the backend: edit the box only once the Inspector shows it (not the player still selected).
  await expect(page.locator('.tl-inspector__name')).toHaveValue(/^box-/);
  await field(page, 'position x', '-3');
  await field(page, 'position y', '4');
  const boxName = await page.locator('.tl-inspector__name').inputValue();
  await inspector.getByLabel('add component', { exact: true }).selectOption({ label: 'Gravity' });
  await expect.poll(() => stored(boxName, 'gravity')).toEqual({});
  await field(page, 'gravity scale', '2');
  await expect.poll(() => stored(boxName, 'gravity')).toEqual({ scale: 2 });

  // Play: walk into the volume, climb, let go.
  const started = page.waitForResponse((r) => r.request().method() === 'POST' && r.url().endsWith('/play'));
  await page.getByTitle('Start an isolated play preview').click();
  const psid = String(((await (await started).json()) as { playSessionId: string }).playSessionId);
  type Obs = { state: string; player?: { x: number; y: number } };
  const observe = async (): Promise<Obs> => (await relay(`${psid}/observe`, {})).json as unknown as Obs;
  await expect.poll(async () => (await relay(`${psid}/observe`, {})).status, { timeout: 30_000 }).toBe(200);
  await expect.poll(async () => (await observe()).state).toBe('running');
  // `hold`: the game waits at the exercise's last step, so the next one continues at the very next step.
  const drive = async (frames: ReturnType<typeof controls>[], hold = false): Promise<void> => {
    const r = await relay(`${psid}/input`, { mode: 'exclusive-test', frames: frames.map((f, i) => ({ stepOffset: i, ...f })), ...(hold ? { hold: true } : {}) });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
  };
  const ground = (await observe()).player!.y;
  // Walked in 4-step exercises held in between: one continuous walk, however long each answer takes to come back.
  for (let i = 0; i < 40 && (await observe()).player!.x < 4.8; i++) await drive(Array.from({ length: 4 }, () => controls(1)), true);
  await drive(Array.from({ length: 20 }, () => controls(0)));
  await expect.poll(async () => (await observe()).player!.x, { timeout: 5_000 }).toBeGreaterThan(4.55);
  expect((await observe()).player!.x).toBeLessThan(5.45);
  // Up for 0.5 s at 3 m/s: 1.5 m, then held there (no gravity while holding on).
  await drive([...Array.from({ length: 60 }, () => controls(0, 'none', 1)), ...Array.from({ length: 60 }, () => controls(0, 'none', 0))]);
  await expect.poll(async () => (await observe()).player!.y, { timeout: 10_000 }).toBeGreaterThan(ground + 1.3);
  await page.waitForTimeout(600);
  const holding = (await observe()).player!.y;
  expect(holding).toBeGreaterThan(ground + 1.3);
  expect(holding).toBeLessThan(ground + 1.7);
  // Jump lets go: it falls back to the ground.
  await drive([controls(0, 'pressed'), ...Array.from({ length: 10 }, () => controls(0, 'held')), controls(0, 'released'), ...Array.from({ length: 120 }, () => controls(0))]);
  await expect.poll(async () => (await observe()).player!.y, { timeout: 10_000 }).toBeLessThan(ground + 0.05);
});
