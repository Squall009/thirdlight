/**
 * Phase 23.13: script audio and 3D audio against a real backend, on a
 * neutral 3D scene built by commands on a blank project (a floor, a player
 * capsule, two imported WAV sounds, an audio source to the camera's left).
 *
 * - Play (the simulation worker) and the static export (backend stopped): a
 *   script driven by keys starts a loop (O), raises its pitch (P), fades it
 *   (K) and stops it with a fade (L); its finished event reaches the script,
 *   which answers by starting another loop. N plays two positional loops to
 *   the camera's right, one near and one far. Everything is verified through
 *   the host's audio observation — the Web Audio graph's state (voice gain,
 *   playback rate, the panner's pan and distance gain), not heard sound: a
 *   source to the camera's right has pan > 0 and the farther one a lower
 *   distance gain; the audio source (panned: a 3D project's default) sits to
 *   the left (pan < 0).
 * - Editor: the audio source's panner fields in the Inspector (distance
 *   model), stored through the backend.
 *
 * What it sounds like is owner look pending.
 */
import { createHash, randomBytes } from 'node:crypto';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { extname, join, normalize, resolve } from 'node:path';

import { expect, test, type Page } from '@playwright/test';

import { startBackend, type E2EBackend } from './backend';

const REPO = resolve(import.meta.dirname, '..', '..');
let be: E2EBackend | null = null;
test.afterEach(async () => {
  await be?.stop();
  be = null;
});

async function query(op: string, args: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  return be!.command({ op, projectId: be!.projectId, args });
}

async function cmd(op: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const revision = Number((await query('queryProject')).revision);
  const res = await be!.command({ op, projectId: be!.projectId, expectedRevision: revision, requestId: `req-${randomBytes(16).toString('hex')}`, origin: { kind: 'mcp', clientId: 'e2e-script-audio' }, args });
  expect(res['ok'], JSON.stringify(res)).toBe(true);
  return res;
}

async function api(path: string, body: unknown): Promise<{ status: number; json: Record<string, unknown> }> {
  const r = await fetch(`${be!.origin}/api/v1/projects/${be!.projectId}/${path}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${be!.token}`, 'content-type': 'application/json', origin: be!.origin },
    body: JSON.stringify(body),
  });
  return { status: r.status, json: (await r.json()) as Record<string, unknown> };
}

async function create(name: string, position: number[], extra: Record<string, unknown> = {}, kind = 'group'): Promise<string> {
  return String((await cmd('createEntity', { parentId: null, kind, name, transform: { position }, ...extra }))['createdId']);
}

async function comp(id: string, name: string): Promise<Record<string, unknown> | undefined> {
  const r = await query('queryEntity', { entityId: id });
  return (r['entity'] as { components: Record<string, Record<string, unknown>> }).components[name];
}

/** Publish a behavior and attach it to `entityId`. */
async function script(behaviorId: string, source: string, entityId: string, assets: Record<string, string>): Promise<void> {
  const bytes = Buffer.from(`${JSON.stringify({ graphVersion: 1, entryPath: 'src/index.ts', requiredModules: ['@thirdlight/runtime'], ownedTransforms: [], files: [{ path: 'src/index.ts', text: source }] }, null, 2)}\n`);
  const stage = await api('content/stages', {});
  const stageId = String(stage.json.stageId);
  const put = await fetch(`${be!.origin}/api/v1/projects/${be!.projectId}/content/stages/${stageId}/bytes`, {
    method: 'PUT',
    headers: { authorization: `Bearer ${be!.token}`, origin: be!.origin, 'content-type': 'application/octet-stream', 'x-thirdlight-offset': '0', 'x-thirdlight-total': String(bytes.length) },
    body: bytes,
  });
  expect(put.status).toBe(200);
  // The sounds as asset properties: an export carries the assets its objects and scripts' properties name.
  const declaration = { properties: Object.keys(assets).map((key) => ({ key, label: key, type: 'assetRef', default: null })) };
  await cmd('publishBehavior', { behaviorId, displayName: behaviorId, mode: 'declaration-create', declaration });
  await cmd('acknowledgeBehaviorTrust', { sourceDigest: createHash('sha256').update(bytes).digest('hex') });
  const published = await api('content/behaviors/source', { stageId, behaviorId, displayName: behaviorId, declaration, expectedRevision: Number((await query('queryProject')).revision), requestId: `req-${randomBytes(16).toString('hex')}` });
  expect(published.status, JSON.stringify(published.json)).toBe(200);
  await cmd('setBehaviorProperties', { entityId, behaviorId, values: assets });
}

/** Import a WAV through the editor's Assets tab; returns its asset id. */
async function importWav(page: Page, file: string, name: string): Promise<string> {
  const before = ((await query('queryAssets', { limit: 50, offset: 0 }))['assets'] as unknown[]).length;
  await page.getByRole('tab', { name: 'Assets' }).click();
  await page.locator('.tl-assets__file').first().setInputFiles(join(REPO, 'fixtures', 'm3', 'media', 'wav', file));
  const publish = page.getByRole('button', { name: 'publish' });
  await expect(publish).toBeEnabled({ timeout: 15_000 });
  await publish.click();
  const assets = async () => (await query('queryAssets', { limit: 50, offset: 0 }))['assets'] as { assetId: string; displayName: string }[];
  await expect.poll(async () => (await assets()).length, { timeout: 15_000 }).toBe(before + 1);
  return (await assets()).find((a) => a.displayName === name)!.assetId;
}

/**
 * The script: keys drive one loop's handle — start (O), pitch 1.5 (P), fade to
 * 0.25 over 1 s (K), stop with a 0.3 s fade (L); its finished event (the step
 * after the fade ends) starts the answer loop. N: two positional loops to the
 * right of the camera, 3 m and 14 m out.
 */
const SOUND = [
  'export default {',
  '  instantiate() { return { last: -1, loop: 0, answered: false }; },',
  '  step(state: any, ctx: any) {',
  '    const s = ctx.stepIndex;',
  '    if (state.last === s) return;',
  '    state.last = s;',
  '    const a = ctx.audio;',
  '    const act = ctx.action.actions ?? {};',
  '    const loop = ctx.properties.loop;',
  '    const answer = ctx.properties.answer;',
  "    const pressed = (n: string): boolean => act[n]?.p === 'pressed';",
  '    for (const e of a.events()) {',
  '      if (e.handle === state.loop && !state.answered) { state.answered = true; a.play(answer, { loop: true, volume: 0.3 }); }',
  '    }',
  "    if (pressed('loopStart')) state.loop = a.play(loop, { loop: true, volume: 0.9 });",
  "    if (pressed('pitchUp')) a.setPitch(state.loop, 1.5);",
  "    if (pressed('fadeDown')) a.fade(state.loop, 0.25, 1);",
  "    if (pressed('stopLoop')) a.stop(state.loop, 0.3);",
  "    if (pressed('spatial')) { a.play(loop, { loop: true, volume: 0.5, position: [3, 1, 0] }); a.play(loop, { loop: true, volume: 0.5, position: [14, 1, 0] }); }",
  '  },',
  '};',
].join('\n');

type Voice = { handle: number; key?: string; assetId: string; state: string; loop: boolean; gain: number; rate: number; pan?: number; distanceGain?: number };
type Audio = { voices: Voice[]; voiceCount: number; listener: { position: number[] } | null; panningModel: string };

function serveDir(dir: string): Promise<{ url: string; close: () => Promise<void> }> {
  const types: Record<string, string> = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json', '.wasm': 'application/wasm' };
  const server: Server = createServer((req, res) => {
    const rel = normalize(decodeURIComponent((req.url ?? '/').split('?')[0]!)).replace(/^\/+/, '') || 'index.html';
    const file = join(dir, rel);
    if (!file.startsWith(dir) || !existsSync(file) || !statSync(file).isFile()) {
      res.statusCode = 404;
      res.end();
      return;
    }
    res.setHeader('content-type', types[extname(file)] ?? 'application/octet-stream');
    createReadStream(file).pipe(res);
  });
  return new Promise((ok) => server.listen(0, '127.0.0.1', () => ok({ url: `http://127.0.0.1:${(server.address() as { port: number }).port}/`, close: () => new Promise((d) => server.close(() => d())) })));
}

/** The neutral 3D scene: floor, player, the audio source to the camera's left, the script, the key actions. */
async function buildScene(page: Page): Promise<{ loop: string; answer: string; source: string }> {
  const loop = await importWav(page, 'cue-max.wav', 'cue-max');
  const answer = await importWav(page, 'cue-goal.wav', 'cue-goal');
  await create('Floor', [0, -0.5, 0], { box: { size: [40, 1, 40], material: { color: '#8a8f98' } }, components: { collider: { shape: { type: 'box', hx: 20, hy: 0.5, hz: 20 } } } }, 'box');
  const player = await create('Player', [0, 0.91, 0]);
  await cmd('setComponent', { entityId: player, component: 'controller', value: {} });
  await cmd('setSettings', { settings: { physics_dimension: 3 } });
  const source = await create('Brook', [-6, 1, 0]);
  await cmd('setComponent', { entityId: source, component: 'audioSource', value: { assetId: answer, volume: 0.4, range: 20 } });
  const keys: [string, string][] = [['loopStart', 'KeyO'], ['pitchUp', 'KeyP'], ['fadeDown', 'KeyK'], ['stopLoop', 'KeyL'], ['spatial', 'KeyN']];
  await cmd('setInput', { input: { actions: keys.map(([name, code]) => ({ name, type: 'button', map: 'gameplay', bindings: [{ kind: 'key', code }] })) } });
  const director = await create('Sounds', [0, -3, 0]);
  await script('sounds', SOUND, director, { loop, answer });
  return { loop, answer, source };
}

async function press(page: Page, key: string): Promise<void> {
  await page.keyboard.down(key);
  await page.waitForTimeout(150);
  await page.keyboard.up(key);
}

/** The key-driven checks, against any observation reader (the Play relay or the export's own). */
async function drive(page: Page, read: () => Promise<Audio | null>, ids: { loop: string; answer: string; source: string }): Promise<void> {
  const loopVoice = async (): Promise<Voice | undefined> => (await read())?.voices.find((v) => v.assetId === ids.loop && v.handle > 0 && v.pan === undefined);
  await press(page, 'o');
  try {
    await expect.poll(async () => (await loopVoice())?.state ?? null, { timeout: 30_000, message: 'the loop plays' }).toBe('playing');
  } catch (e) {
    throw new Error(`${String(e)}\nobservation: ${JSON.stringify(await read())}`);
  }
  const started = (await loopVoice())!;
  expect(started.loop).toBe(true);
  expect(started.rate).toBe(1);
  expect(started.gain).toBeCloseTo(0.9, 3);

  await press(page, 'p');
  await expect.poll(async () => (await loopVoice())?.rate ?? 0, { timeout: 30_000, message: 'pitch 1.5' }).toBeCloseTo(1.5, 4);

  await press(page, 'k');
  // The fade is a ramp on the voice's gain: seen part way, then at its target.
  const gains: number[] = [];
  await expect
    .poll(async () => {
      const g = (await loopVoice())?.gain ?? 1;
      gains.push(g);
      return g;
    }, { timeout: 30_000, intervals: [50], message: 'the fade reaches 0.25' })
    .toBeCloseTo(0.25, 2);
  expect(gains.some((g) => g < 0.85 && g > 0.3), `a gain between the ends during the fade: ${gains.join(',')}`).toBe(true);

  expect((await read())!.voices.some((v) => v.assetId === ids.answer && v.handle > 0)).toBe(false);
  await press(page, 'l');
  await expect.poll(async () => (await loopVoice()) === undefined, { timeout: 30_000, message: 'the loop stopped' }).toBe(true);
  // Its finished event reached the script: it started the answer loop.
  await expect.poll(async () => (await read())?.voices.find((v) => v.assetId === ids.answer && v.handle > 0)?.state ?? null, { timeout: 30_000, message: 'the script answered the finished event' }).toBe('playing');

  await press(page, 'n');
  await expect.poll(async () => (await read())?.voices.filter((v) => v.assetId === ids.loop && v.pan !== undefined).length ?? 0, { timeout: 30_000 }).toBe(2);
  const [near, far] = (await read())!.voices.filter((v) => v.assetId === ids.loop && v.pan !== undefined).sort((a, b) => a.handle - b.handle);
  expect(near!.pan!, 'the near source is to the camera\'s right').toBeGreaterThan(0);
  expect(far!.pan!, 'the far source is to the camera\'s right').toBeGreaterThan(0);
  expect(far!.distanceGain!, 'farther is quieter').toBeLessThan(near!.distanceGain!);
  // The audio source plays panned (3D default), to the camera's left.
  try {
    await expect.poll(async () => (await read())?.voices.find((v) => v.key === ids.source)?.pan ?? 0, { timeout: 60_000, message: 'the audio source pans left' }).toBeLessThan(0);
  } catch (e) {
    throw new Error(`${String(e)}\nobservation: ${JSON.stringify(await read())}`);
  }
  expect((await read())!.panningModel).toBe('equalpower');
  expect((await read())!.listener).not.toBeNull();

}

test('script audio in Play and the export: a loop with pitch, fade and stop, a finished event back in the script, panned sources', async ({ page }) => {
  test.setTimeout(360_000);
  be = await startBackend('script-audio-e2e');
  await page.goto(be.editorUrl);
  await expect(page.locator('.tl-statusbar')).toContainText('connected');
  const ids = await buildScene(page);

  const started = page.waitForResponse((r) => r.request().method() === 'POST' && r.url().endsWith('/play'));
  await page.getByTitle('Start an isolated play preview').click();
  const psid = String(((await (await started).json()) as { playSessionId: string }).playSessionId);
  const frame = page.locator('iframe.tl-app__preview-frame');
  const observe = async (): Promise<Record<string, unknown> | null> => {
    const r = await api(`play/${psid}/observe`, {});
    return r.status === 200 ? r.json : null;
  };
  await expect.poll(async () => (await observe())?.['state'] ?? null, { timeout: 60_000 }).toBe('running');
  // A click in the game focuses it and unlocks sound.
  const box = (await frame.boundingBox())!;
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await expect.poll(async () => ((await observe())?.['sound'] as { unlocked?: boolean } | undefined)?.unlocked ?? false, { timeout: 30_000 }).toBe(true);
  await drive(page, async () => ((await observe())?.['audio'] as Audio | undefined) ?? null, ids);
  await page.getByTitle('Stop the play preview').click();
  // Stop is a backend round trip plus the preview's teardown: seconds on a loaded CPU-rendered host.
  await expect(frame).toHaveCount(0, { timeout: 30_000 });

  // The static export with the backend stopped: the same script sounds (the export's own observation).
  const res = await be.admin(`projects/${be.projectId}/export`);
  expect(res.status, JSON.stringify(res.json)).toBe(200);
  await be.halt();
  const site = await serveDir(join(be.exportRoot, String(res.json.outputDir)));
  const game = await page.context().newPage();
  const errors: string[] = [];
  game.on('pageerror', (e) => errors.push(e.message));
  try {
    await game.goto(site.url);
    const read = (): Promise<Audio | null> => game.evaluate(() => ((window as unknown as { __thirdlightObserve?: () => { audio?: unknown } | null }).__thirdlightObserve?.()?.audio ?? null) as Audio | null);
    await expect.poll(async () => game.evaluate(() => (window as unknown as { __thirdlightObserve?: () => { state?: string } | null }).__thirdlightObserve?.()?.state ?? null), { timeout: 60_000 }).toBe('running');
    await game.mouse.click(400, 300);
    await expect.poll(async () => game.evaluate(() => ((window as unknown as { __thirdlightObserve?: () => { sound?: { unlocked?: boolean } } | null }).__thirdlightObserve?.()?.sound?.unlocked ?? false)), { timeout: 30_000 }).toBe(true);
    await drive(game, read, ids);
    expect(errors).toEqual([]);
  } finally {
    await game.close();
    await site.close();
  }
});

test('editor: the audio source\'s panner fields in the Inspector', async ({ page }) => {
  test.skip(test.info().project.name === 'webgpu', 'renderer-independent UI (the default project covers it)');
  test.setTimeout(180_000);
  be = await startBackend('script-audio-editor-e2e');
  await page.goto(be.editorUrl);
  await expect(page.locator('.tl-statusbar')).toContainText('connected');
  const asset = await importWav(page, 'cue-goal.wav', 'cue-goal');
  const source = await create('Brook', [0, 1, 0]);
  await cmd('setComponent', { entityId: source, component: 'audioSource', value: { assetId: asset, volume: 0.8, range: 12 } });
  await page.getByRole('tab', { name: 'Scene' }).click().catch(() => undefined);
  await page.locator(`.tl-hierarchy__list li[data-entity-id="${source}"]`).click();
  await expect(page.locator('.tl-hierarchy__list li.is-selected')).toHaveAttribute('data-entity-id', source);
  const inspector = page.locator('.tl-inspector');
  const model = inspector.getByLabel('audioSource distanceModel', { exact: true });
  await expect(model).toBeVisible();
  await model.selectOption('inverse');
  await expect.poll(async () => (await comp(source, 'audioSource'))?.['distanceModel']).toBe('inverse');
  const rolloff = inspector.getByLabel('audioSource rolloff', { exact: true });
  await rolloff.fill('2');
  await rolloff.press('Enter');
  await expect.poll(async () => (await comp(source, 'audioSource'))?.['rolloff']).toBe(2);
});
