/**
 * Phase 25.14: the track camera's look-ahead, bounds and dead zone and a
 * camera region, set up in the editor and seen in Play, on the starter
 * template (a 2D-plane scene) against a real backend.
 *
 * Editor: GameObject → Cameras → Camera track, placed 12 m in front of the
 * character, its target picked and its look-ahead and bounds typed in the
 * Inspector; its Scene-view handles — the dead zone box around the
 * character and the bounds' corner — dragged, each put back by one undo.
 * GameObject → Cameras → Camera region, placed right of the character, its
 * distance (24 m) and width set in the Inspector and its size handle
 * dragged (one undo back). Each stored value is read back through the
 * command API.
 * Play: the character stands left of the region, walks into it and back
 * out (test input). The play observation reports the region the camera is
 * in and the camera 12 m back outside it, about 24 m back inside; in the
 * Play picture a green board beside the region shrinks to about a quarter
 * of its pixels inside the region and comes back outside.
 */
import { randomBytes } from 'node:crypto';

import { expect, test, type Locator, type Page } from '@playwright/test';

import { STARTER, controls, startBackend, type E2EBackend } from './backend';
import { decodePng } from './png';
import { menu } from './ui';

let be: E2EBackend;
test.beforeEach(async () => {
  be = await startBackend('camera-regions-e2e', 'starter');
});
test.afterEach(async () => {
  await be.stop();
});

async function query(op: string, args: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  return be.command({ op, projectId: be.projectId, args });
}
async function cmd(op: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const res = await be.command({ op, projectId: be.projectId, expectedRevision: Number((await query('queryProject')).revision), requestId: `req-${randomBytes(16).toString('hex')}`, origin: { kind: 'mcp', clientId: 'e2e-regions' }, args });
  expect(res.ok, JSON.stringify(res)).toBe(true);
  return res;
}
async function relay(path: string, body: unknown): Promise<{ status: number; json: Record<string, unknown> }> {
  const r = await fetch(`${be.origin}/api/v1/projects/${be.projectId}/play/${path}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${be.token}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: r.status, json: (await r.json()) as Record<string, unknown> };
}
async function stored(name: string, component: string): Promise<Record<string, unknown> | undefined> {
  const r = (await be.command({ op: 'queryEntities', projectId: be.projectId, args: { limit: 100, offset: 0 } })) as { entities?: { id: string; name?: string; components: Record<string, Record<string, unknown>> }[] };
  return r.entities?.find((e) => e.name === name || e.id === name)?.components[component];
}
async function idOf(name: string): Promise<string> {
  const r = (await be.command({ op: 'queryEntities', projectId: be.projectId, args: { limit: 100, offset: 0 } })) as { entities?: { id: string; name?: string }[] };
  return r.entities!.find((e) => e.name === name)!.id;
}
async function field(page: Page, label: string, value: string): Promise<void> {
  const f = page.locator('.tl-inspector').getByLabel(label, { exact: true });
  await f.fill(value);
  await f.press('Enter');
  await expect(f).toHaveValue(value);
}

type Grip = { component: string; kind: string; handle: string; x: number; y: number };
const view = (page: Page): Locator => page.locator('canvas[data-size-handles]');
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
  const g = (await find())!;
  const box = (await view(page).boundingBox())!;
  expect(g.x > box.x && g.x < box.x + box.width && g.y > box.y && g.y < box.y + box.height, `${kind} ${handle} grip in view`).toBe(true);
  return g;
}
async function drag(page: Page, g: Grip, dx: number, dy: number): Promise<void> {
  await page.mouse.move(g.x, g.y);
  await page.mouse.down();
  for (let i = 1; i <= 8; i++) await page.mouse.move(g.x + (dx * i) / 8, g.y + (dy * i) / 8);
  await page.mouse.up();
}
async function undo(page: Page): Promise<void> {
  await view(page).hover();
  await page.keyboard.press('Control+z');
}

/** Bright green pixels (the board), sampled every 2 px. */
async function greens(frame: Locator): Promise<number> {
  const img = decodePng(await frame.screenshot());
  let n = 0;
  for (let y = 0; y < img.height; y += 2) {
    for (let x = 0; x < img.width; x += 2) {
      const [r, g, b] = img.pixel(x, y);
      if (g > 120 && r < 90 && b < 90) n += 1;
    }
  }
  return n;
}

test('a track camera\'s look-ahead, bounds and dead zone and a camera region set up in the editor; in Play the camera moves back inside the region and returns', async ({ page }) => {
  test.setTimeout(300_000);
  // A green board just behind the plane, between the character's start (x 3) and the region (x 5.25).
  await cmd('createEntity', { parentId: null, kind: 'box', name: 'Board', transform: { position: [4.1, 2.7, -1] }, box: { size: [1.2, 1.2, 0.2], material: { color: '#00ff00' } } });

  await page.goto(be.editorUrl);
  await expect(page.locator('.tl-statusbar')).toContainText('connected');
  const inspector = page.locator('.tl-inspector');

  // The track camera: 12 m in front of the character (x 3), 2.09 m above it.
  await menu(page, 'GameObject', 'Cameras', 'Camera track');
  await expect(page.locator('.tl-inspector__name')).toHaveValue('Camera track');
  await field(page, 'position x', '3');
  await field(page, 'position y', '3');
  await field(page, 'position z', '12');
  await inspector.getByLabel('virtualCamera target', { exact: true }).selectOption(STARTER.playerId);
  await field(page, 'virtualCamera lookAhead y', '0.2');
  for (const [k, v] of [['boundsMin x', '-2'], ['boundsMin y', '-1'], ['boundsMin z', '-5'], ['boundsMax x', '10'], ['boundsMax y', '6'], ['boundsMax z', '5']] as const) await field(page, `virtualCamera ${k}`, v);
  const track = { rig: 'track', deadZone: [2, 1, 2], damping: 0.2, target: STARTER.playerId, boundsMin: [-2, -1, -5], boundsMax: [10, 6, 5], lookAhead: [0, 0.2, 0] };
  await expect.poll(() => stored('Camera track', 'virtualCamera')).toEqual(track);

  // Its Scene handles, seen around the character: frame the character, then select the camera again.
  const camera = await idOf('Camera track');
  await page.locator(`.tl-hierarchy__list li[data-entity-id="${STARTER.playerId}"]`).click();
  await view(page).hover();
  await page.keyboard.press('f');
  await page.locator(`.tl-hierarchy__list li[data-entity-id="${camera}"]`).click();
  // The dead zone's side grip (1 m right of the character) dragged wider.
  await drag(page, await grip(page, 'virtualCamera', 'box3', 'side'), 40, 0);
  await expect.poll(async () => ((await stored('Camera track', 'virtualCamera'))?.['deadZone'] as number[])[0]).toBeGreaterThan(2.1);
  await undo(page);
  await expect.poll(() => stored('Camera track', 'virtualCamera')).toEqual(track);
  // The bounds' lower corner (x −2, y −1) dragged right.
  await drag(page, await grip(page, 'virtualCamera', 'bounds', 'min'), 40, 0);
  await expect.poll(async () => ((await stored('Camera track', 'virtualCamera'))?.['boundsMin'] as number[])[0]).toBeGreaterThan(-1.9);
  expect(((await stored('Camera track', 'virtualCamera'))?.['boundsMin'] as number[])[2]).toBe(-5);
  await undo(page);
  await expect.poll(() => stored('Camera track', 'virtualCamera')).toEqual(track);

  // The camera region: x 4.5–6 (right of the character, left of the starter's step at x 6), 24 m away.
  await menu(page, 'GameObject', 'Cameras', 'Camera region');
  await expect(page.locator('.tl-inspector__name')).toHaveValue('Camera region');
  await field(page, 'position x', '5.25');
  await field(page, 'position y', '2');
  await field(page, 'position z', '0');
  await field(page, 'cameraRegion size w', '1.5');
  await field(page, 'cameraRegion distance', '24');
  await expect.poll(() => stored('Camera region', 'cameraRegion')).toEqual({ size: [1.5, 6], distance: 24 });
  const region = await idOf('Camera region');
  await drag(page, await grip(page, 'cameraRegion', 'box2', 'side'), 40, 0);
  await expect.poll(async () => ((await stored('Camera region', 'cameraRegion'))?.['size'] as number[])[0]).toBeGreaterThan(1.6);
  await undo(page);
  await expect.poll(() => stored('Camera region', 'cameraRegion')).toEqual({ size: [1.5, 6], distance: 24 });

  // Play.
  const started = page.waitForResponse((r) => r.request().method() === 'POST' && r.url().endsWith('/play'));
  await page.getByTitle('Start an isolated play preview').click();
  const psid = String(((await (await started).json()) as { playSessionId: string }).playSessionId);
  type Obs = { state: string; player?: { x: number; y: number }; camera?: { live: string | null; region?: string | null; position: number[]; blend: unknown } };
  const observe = async (): Promise<Obs> => (await relay(`${psid}/observe`, {})).json as unknown as Obs;
  await expect.poll(async () => (await relay(`${psid}/observe`, {})).status, { timeout: 30_000 }).toBe(200);
  await expect.poll(async () => (await observe()).state).toBe('running');
  const drive = async (frames: ReturnType<typeof controls>[]): Promise<void> => {
    const r = await relay(`${psid}/input`, { mode: 'exclusive-test', frames: frames.map((f, i) => ({ stepOffset: i, ...f })) });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
  };
  const frame = page.locator('iframe.tl-app__preview-frame');

  // Outside the region: the track camera is live, 12 m back (its placed framing).
  await expect.poll(async () => (await observe()).camera?.live, { timeout: 20_000 }).toBe(camera);
  await expect.poll(async () => (await observe()).camera?.position[2] ?? 0).toBeCloseTo(12, 1);
  expect((await observe()).camera?.region).toBeNull();
  const outside = await greens(frame);
  expect(outside, 'the green board is in view').toBeGreaterThan(300);

  // Into the region: the camera goes back to 24 m along its offset (z ≈ 23.6) once the blend is over.
  for (let i = 0; i < 40 && (await observe()).player!.x < 4.9; i++) await drive(Array.from({ length: 4 }, () => controls(1)));
  await drive(Array.from({ length: 20 }, () => controls(0)));
  await expect.poll(async () => (await observe()).camera?.region, { timeout: 5_000 }).toBe(region);
  const at = (await observe()).player!.x;
  expect(at).toBeGreaterThan(4.5);
  expect(at).toBeLessThan(6);
  await expect.poll(async () => (await observe()).camera?.position[2] ?? 0, { timeout: 5_000 }).toBeGreaterThan(23.4);
  expect((await observe()).camera!.position[2]).toBeLessThan(23.8);
  // In pixels: the board is twice as far, about a quarter of its area.
  let inside = 0;
  await expect.poll(async () => (inside = await greens(frame)), { timeout: 10_000, message: 'the board shrinks' }).toBeLessThan(outside * 0.45);
  expect(inside).toBeGreaterThan(outside * 0.12);

  // Back out to the start: 12 m again, and the board as big as before.
  for (let i = 0; i < 40 && (await observe()).player!.x > 3.4; i++) await drive(Array.from({ length: 4 }, () => controls(-1)));
  await drive(Array.from({ length: 20 }, () => controls(0)));
  await expect.poll(async () => (await observe()).camera?.region, { timeout: 5_000 }).toBeNull();
  await expect.poll(async () => (await observe()).camera?.position[2] ?? 0, { timeout: 5_000 }).toBeCloseTo(12, 1);
  let back = 0;
  await expect.poll(async () => (back = await greens(frame)), { timeout: 10_000, message: 'the board is as big as before' }).toBeGreaterThan(outside * 0.7);
  console.log(`[camera-regions] green board pixels: outside ${outside}, inside ${inside}, back ${back}`);
  await expect(page.locator('.tl-notice')).toHaveCount(0);
});
