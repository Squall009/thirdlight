/**
 * Scene transitions, spawns, virtual cameras and event sounds through the
 * editor and observed in Play, on the starter
 * template (a 2D-plane scene without any game session), against a real
 * backend:
 *
 * - e: "+ Add component" → Trigger on a door where the character starts,
 *   then its Scene transition ("+ add": the second scene and the spawn
 *   there, picked in the Inspector). In Play the character enters the door
 *   at once: the second scene loads and the character stands at the spawn.
 * - f: the spawn's yaw, an interact switch's action and a velocity
 *   face-movement set in the Inspector (stored through the backend).
 * - g: "+ Add component" → Virtual camera: Track (dead zone), its target
 *   picked in the Inspector. In Play it follows the character to the far
 *   scene at its placed depth and height (no fixed camera distance).
 * - i: the Media tab's event sounds: a row made from a signal name and a
 *   sound, its bus set in the row's form. In Play (sound unlocked by a
 *   click) the host plays it each time a project script sends the signal —
 *   counted by the host's sound observation (heard sound: owner look pending).
 */
import { createHash, randomBytes } from 'node:crypto';

import { expect, test, type Page } from '@playwright/test';

import { publishWav, STARTER, startBackend, type E2EBackend } from './backend';

let be: E2EBackend;
test.beforeEach(async () => {
  be = await startBackend('scene-transition-e2e', 'starter');
});
test.afterEach(async () => {
  await be.stop();
});

async function api(path: string, body: unknown): Promise<{ status: number; json: Record<string, unknown> }> {
  const r = await fetch(`${be.origin}/api/v1/projects/${be.projectId}/${path}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${be.token}`, 'content-type': 'application/json', origin: be.origin },
    body: JSON.stringify(body),
  });
  return { status: r.status, json: (await r.json()) as Record<string, unknown> };
}
async function query(op: string, args: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  return be.command({ op, projectId: be.projectId, args });
}
async function cmd(op: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const res = await be.command({ op, projectId: be.projectId, expectedRevision: Number((await query('queryProject')).revision), requestId: `req-${randomBytes(16).toString('hex')}`, origin: { kind: 'mcp', clientId: 'e2e-transition' }, args });
  expect(res.ok, JSON.stringify(res)).toBe(true);
  return res;
}
async function create(name: string, position: number[], extra: Record<string, unknown> = {}, kind = 'group'): Promise<string> {
  return String((await cmd('createEntity', { parentId: null, kind, name, transform: { position }, ...extra }))['createdId']);
}
async function comp(id: string, name: string): Promise<Record<string, unknown> | undefined> {
  const r = await query('queryEntity', { entityId: id });
  return (r['entity'] as { components: Record<string, Record<string, unknown>> }).components[name];
}
async function script(behaviorId: string, source: string, entityId: string): Promise<void> {
  const bytes = Buffer.from(`${JSON.stringify({ graphVersion: 1, entryPath: 'src/index.ts', requiredModules: ['@thirdlight/runtime'], ownedTransforms: [], files: [{ path: 'src/index.ts', text: source }] }, null, 2)}\n`);
  const stage = await api('content/stages', {});
  const stageId = String(stage.json.stageId);
  const put = await fetch(`${be.origin}/api/v1/projects/${be.projectId}/content/stages/${stageId}/bytes`, {
    method: 'PUT',
    headers: { authorization: `Bearer ${be.token}`, origin: be.origin, 'content-type': 'application/octet-stream', 'x-thirdlight-offset': '0', 'x-thirdlight-total': String(bytes.length) },
    body: bytes,
  });
  expect(put.status).toBe(200);
  const declaration = { properties: [] };
  await cmd('publishBehavior', { behaviorId, displayName: behaviorId, mode: 'declaration-create', declaration });
  await cmd('acknowledgeBehaviorTrust', { sourceDigest: createHash('sha256').update(bytes).digest('hex') });
  const published = await api('content/behaviors/source', { stageId, behaviorId, displayName: behaviorId, declaration, expectedRevision: Number((await query('queryProject')).revision), requestId: `req-${randomBytes(16).toString('hex')}` });
  expect(published.status, JSON.stringify(published.json)).toBe(200);
  await cmd('setBehaviorProperties', { entityId, behaviorId, values: {} });
}

/** The project's own metronome: the signal "tick" once a second. */
const METRONOME = [
  'export default {',
  '  prepare() { return {}; },',
  '  instantiate() { return {}; },',
  '  step(_state: unknown, ctx: any) {',
  "    if (ctx.phase === 'intent' && ctx.stepIndex > 0 && ctx.stepIndex % 120 === 0) ctx.signals.emit('tick');",
  '  },',
  '  dispose() {},',
  '};',
  '',
].join('\n');

async function select(page: Page, id: string): Promise<void> {
  await page.getByRole('tab', { name: 'Scene', exact: true }).click().catch(() => undefined);
  await page.locator(`.tl-hierarchy__list li[data-entity-id="${id}"]`).click();
  await expect(page.locator('.tl-hierarchy__list li.is-selected')).toHaveAttribute('data-entity-id', id);
}
async function field(page: Page, label: string, value: string): Promise<void> {
  const f = page.locator('.tl-inspector').getByLabel(label, { exact: true });
  await f.fill(value);
  await f.press('Enter');
}

test('a trigger\'s scene transition, a track camera and event sounds from the editor; in Play the scene loads, the character arrives, the camera follows and the sound plays', async ({ page }) => {
  test.setTimeout(300_000);
  // The second scene: a floor far to the right and a spawn on it.
  await cmd('createScene', { name: 'Far side', sceneId: 'scene-far' });
  await create('Far floor', [40, -0.2, 0], { sceneId: 'scene-far', box: { size: [12, 0.4, 1], material: { color: '#6a8a5a' } }, components: { collider: { shape: { type: 'box', hx: 6, hy: 0.2 } } } }, 'box');
  const arrival = await create('Arrival', [40, 0.91, 0], { sceneId: 'scene-far', components: { playerSpawn: {} } });
  // A door where the character starts, a lever, a marker, a camera rig, the metronome; a sound.
  const door = await create('Door', [3, 1, 0]);
  const lever = await create('Lever', [6, 0.5, 0]);
  const marker = await create('Marker', [0, 2, 0]);
  const tracker = await create('Tracker', [4, 3, 9]);
  const metronome = await create('Metronome', [0, -5, 0]);
  await script('metronome', METRONOME, metronome);
  const sound = await publishWav(be, 'cue-goal.wav', 'sfx-tick', 'tick');

  await page.goto(be.editorUrl);
  await expect(page.locator('.tl-statusbar')).toContainText('connected');
  const inspector = page.locator('.tl-inspector');
  const add = inspector.getByLabel('add component', { exact: true });

  // e: a trigger on the door, then its scene transition picked in the Inspector.
  await select(page, door);
  await add.selectOption({ label: 'Trigger' });
  await expect.poll(async () => comp(door, 'trigger')).toEqual({ size: [2, 2], signal: 'trigger' });
  await inspector.getByLabel('add trigger sceneTransition', { exact: true }).click();
  await expect.poll(async () => (await comp(door, 'trigger'))?.['sceneTransition']).toEqual({ scene: 'scene-far' });
  await inspector.getByLabel('trigger sceneTransition spawn', { exact: true }).selectOption(arrival);
  await expect.poll(async () => (await comp(door, 'trigger'))?.['sceneTransition']).toEqual({ scene: 'scene-far', spawn: arrival });

  // f: the spawn's yaw (its scene opened in the Hierarchy), the lever's action, the marker facing its velocity.
  await page.getByLabel('open scene', { exact: true }).selectOption({ label: 'Far side' });
  await select(page, arrival);
  await field(page, 'playerSpawn yaw', '90');
  await expect.poll(async () => comp(arrival, 'playerSpawn')).toEqual({ yaw: 90 });
  await select(page, lever);
  await add.selectOption({ label: 'Switch' });
  await expect.poll(async () => comp(lever, 'switch')).toEqual({ mode: 'interact', signal: 'open', size: [1, 1] });
  await field(page, 'switch action', 'use');
  await expect.poll(async () => (await comp(lever, 'switch'))?.['action']).toBe('use');
  await select(page, marker);
  await add.selectOption({ label: 'Face movement: Face velocity' });
  await expect.poll(async () => comp(marker, 'faceMovement')).toEqual({ mode: 'velocity', turnSeconds: 0.12 });

  // g: a track camera following the character.
  await select(page, tracker);
  await add.selectOption({ label: 'Virtual camera: Track (dead zone)' });
  await expect.poll(async () => comp(tracker, 'virtualCamera')).toEqual({ rig: 'track', deadZone: [2, 1, 2], damping: 0.2 });
  await inspector.getByLabel('virtualCamera target', { exact: true }).selectOption(STARTER.playerId);
  await expect.poll(async () => (await comp(tracker, 'virtualCamera'))?.['target']).toBe(STARTER.playerId);

  // i: an event sound for the metronome's signal, on the ui bus.
  await page.getByRole('tab', { name: 'Media' }).click();
  const events = page.getByLabel('event sounds');
  await events.getByLabel('new event sound source').selectOption('signal');
  await events.getByLabel('new event sound name').fill('tick');
  await events.getByLabel('new event sound asset').selectOption(sound);
  await events.getByRole('button', { name: 'add event sound' }).click();
  const cues = async (): Promise<unknown> => (await query('queryGameConfig'))['eventCues'];
  await expect.poll(cues).toEqual([{ on: 'signal', name: 'tick', assetId: sound }]);
  await events.getByLabel('eventCue bus', { exact: true }).selectOption('ui');
  await expect.poll(cues).toEqual([{ on: 'signal', name: 'tick', assetId: sound, bus: 'ui' }]);

  // Play.
  const started = page.waitForResponse((r) => r.request().method() === 'POST' && r.url().endsWith('/play'));
  await page.getByTitle('Start an isolated play preview').click();
  const psid = String(((await (await started).json()) as { playSessionId: string }).playSessionId);
  type Obs = { state?: string; player?: { x: number; y: number }; scenes?: { loaded: string[] }; camera?: { live: string | null; position: number[] }; sound?: { unlocked?: boolean; played?: { sfx: number; ui: number } } };
  const observe = async (): Promise<Obs> => (await api(`play/${psid}/observe`, {})).json as Obs;
  await expect.poll(async () => (await observe()).state, { timeout: 30_000 }).toBe('running');
  // e: the far scene loaded and the character stands at the spawn.
  await expect.poll(async () => (await observe()).scenes?.loaded ?? [], { timeout: 20_000 }).toContain('scene-far');
  await expect.poll(async () => (await observe()).player?.x ?? 0, { timeout: 20_000 }).toBeGreaterThan(39);
  const at = (await observe()).player!;
  expect(at.x).toBeLessThan(41);
  // g: the track camera is live and followed it at its placed depth and height (dead zone 2 m wide: within 1 m of the arrival + its 1 m offset).
  await expect.poll(async () => (await observe()).camera?.position[0] ?? 0, { timeout: 20_000 }).toBeGreaterThan(38.5);
  const cam = (await observe()).camera!;
  expect(cam.live).toBe(tracker);
  expect(cam.position[0]).toBeLessThan(42);
  expect(cam.position[1]).toBeCloseTo(3, 1);
  expect(cam.position[2]).toBeCloseTo(9, 3);
  // i: a click unlocks sound; the metronome's signal plays the event sound on the ui bus.
  const frame = page.locator('iframe.tl-app__preview-frame');
  const box = (await frame.boundingBox())!;
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await expect.poll(async () => (await observe()).sound?.unlocked ?? false, { timeout: 30_000 }).toBe(true);
  const played = async (): Promise<number> => (await observe()).sound?.played?.ui ?? 0;
  const first = await played();
  await expect.poll(played, { timeout: 20_000, message: 'the event sound plays' }).toBeGreaterThan(first);
  const second = await played();
  await expect.poll(played, { timeout: 20_000, message: 'and again on the next tick' }).toBeGreaterThan(second);
  await expect(page.locator('.tl-notice')).toHaveCount(0);
});
