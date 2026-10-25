/**
 * Gameplay blocks built in the editor and played. On the
 * starter template's ground the GameObject → Gameplay menu places a
 * collectible, a pressure plate and a door, a one-way shelf, a lift and a
 * trigger; the Inspector sets them up (the plate's mode, the lift's path and
 * signal, the trigger's size and signals; their positions, plain transform
 * fields covered elsewhere, are sent as commands). In Play (the game plays
 * as a scene: no game session), driven by exclusive test input, the
 * character collects the collectible (its named counter), opens the door by
 * stepping on the plate, jumps up through the shelf, walks onto the lift and
 * rides it up, on the starter scene's plane. The switches work without a
 * game session.
 */
import { randomBytes } from 'node:crypto';

import { INPUT_RELAY_MAX_FRAMES } from '@thirdlight/protocol';

import { expect, test, type Page } from './pw';

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

async function cmd(op: string, args: Record<string, unknown>): Promise<void> {
  const revision = Number((await be.command({ op: 'queryProject', projectId: be.projectId, args: {} })).revision);
  const res = await be.command({ op, projectId: be.projectId, expectedRevision: revision, requestId: `req-${randomBytes(16).toString('hex')}`, origin: { kind: 'mcp', clientId: 'e2e-gameplay-blocks' }, args });
  expect(res['ok'], JSON.stringify(res).slice(0, 600)).toBe(true);
}

async function create(page: Page, item: string): Promise<void> {
  await menu(page, 'GameObject', 'Gameplay', item);
  await expect(page.locator('.tl-inspector__name')).toHaveValue(item.startsWith('Door') ? 'Door' : item);
}

test('a level built from gameplay blocks plays: a collectible, plate and door, one-way shelf, lift', async ({ page }) => {
  test.setTimeout(240_000);
  // Clear the starter's step and platform (the character starts at x 3 on a ground from x −4 to 20).
  await cmd('deleteEntity', { entityId: 'box-0002', entityIds: ['box-0003'] });
  await page.goto(be.editorUrl);
  await expect(page.locator('.tl-statusbar')).toContainText('connected');

  await create(page, 'Collectible');
  await create(page, 'Switch');
  await page.getByLabel('switch mode').selectOption('stand');
  await expect(page.getByLabel('switch mode')).toHaveValue('stand');
  await create(page, 'Door (opens on "open")');
  await create(page, 'One-way platform');
  await expect(page.getByLabel('collider oneWay', { exact: true })).toBeChecked();
  await create(page, 'Moving platform');
  await field(page, 'mover waypoints 1 x', '0');
  await field(page, 'mover waypoints 1 y', '2');
  await page.getByLabel('mover mode').selectOption('once');
  await expect(page.getByLabel('mover mode')).toHaveValue('once');
  await field(page, 'mover startOn', 'ride');
  await create(page, 'Trigger');
  await field(page, 'trigger signal', 'ride');
  await field(page, 'trigger size w', '1.6');
  await field(page, 'trigger size h', '1.6');
  await field(page, 'trigger exitSignal', 'left');

  // The stored components (what Play and the export read).
  const stored = (await be.command({ op: 'queryEntities', projectId: be.projectId, args: { limit: 100, offset: 0 } })) as { entities?: { id: string; name?: string; components: Record<string, unknown> }[] };
  const byName = (n: string) => stored.entities?.find((e) => e.name === n)?.components;
  // The level's layout along the walk.
  const layout: [string, number, number][] = [['Collectible', 4.5, 0.5], ['Switch', 7, 0.1], ['Door', 9, 1.5], ['One-way platform', 12, 0.8], ['Moving platform', 14.5, 0.7], ['Trigger', 14.5, 1.9]];
  for (const [name, x, y] of layout) await cmd('setTransform', { entityId: stored.entities!.find((e) => e.name === name)!.id, transform: { position: [x, y, 0] } });
  expect(byName('Moving platform')?.['mover']).toEqual({ waypoints: [[0, 2, 0]], speed: 2, mode: 'once', wait: 0.5, startOn: 'ride' });
  expect(byName('Trigger')?.['trigger']).toEqual({ size: [1.6, 1.6, 2], signal: 'ride', exitSignal: 'left' });
  const counter = String((byName('Collectible')?.['collectible'] as { counter?: string } | undefined)?.counter);
  expect(counter).toMatch(/^[A-Za-z_]/);

  // Play (a scene: it runs at once).
  const started = page.waitForResponse((r) => r.request().method() === 'POST' && r.url().endsWith('/play'));
  await page.getByTitle('Start an isolated play preview').click();
  const psid = String(((await (await started).json()) as { playSessionId: string }).playSessionId);
  const observe = async (): Promise<Observation> => (await relay(`${psid}/observe`, {})).json as unknown as Observation;
  await expect.poll(async () => (await relay(`${psid}/observe`, {})).status, { timeout: 30_000 }).toBe(200);
  await expect.poll(async () => (await observe()).state).toBe('running');
  // The character settles on the ground (two reads in a row at the same height) before it is driven.
  let lastY = NaN;
  await expect
    .poll(async () => {
      const y = (await observe()).player?.y ?? NaN;
      const settled = Math.abs(y - lastY) < 1e-3;
      lastY = y;
      return settled;
    }, { timeout: 10_000, intervals: [100] })
    .toBe(true);

  const drive = async (frames: { moveX: number; jump: 'none' | 'pressed' | 'held' }[]): Promise<void> => {
    const r = await relay(`${psid}/input`, { mode: 'exclusive-test', frames: frames.map((f, i) => ({ stepOffset: i, ...controls(f.moveX, f.jump) })) });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
  };
  const run = (n: number, moveX = 1) => Array.from({ length: n }, () => ({ moveX, jump: 'none' as const }));
  /** The farthest the character has gone in one step so far (m), from the chunks walked. */
  let pace = 0;
  /**
   * Walk right in chunks until x ≥ target. Each relay round trip costs far more than the steps it drives, so a chunk
   * covers about half the distance left at the fastest pace seen yet (never past the target), down to `chunk` steps
   * near it: the last chunks, and so the overshoot, are as fine as a walk in `chunk`-step pieces.
   */
  const walkTo = async (target: number, chunk = 12): Promise<Observation> => {
    let x = (await observe()).player!.x;
    for (let i = 0; i < 120 && x < target; i++) {
      const steps = pace > 0 ? Math.min(INPUT_RELAY_MAX_FRAMES, Math.max(chunk, Math.floor((0.5 * (target - x)) / pace))) : chunk;
      await drive(run(steps));
      const now = (await observe()).player!.x;
      pace = Math.max(pace, (now - x) / steps);
      x = now;
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
