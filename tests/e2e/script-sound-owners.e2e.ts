/**
 * Script sounds have an owner, against a real backend in a real browser.
 *
 * Twenty scenes each hold an object whose script starts a looping ambience
 * when it loads; a walker in the start scene loads them one after another,
 * unloading the one before. Each loop belongs to its object, so it stops
 * with its scene: after the walk one loop plays (the last scene's), and no
 * sound was dropped for the voice cap. Then a burst of loops past the
 * project's voices drops sounds: the Problems log gets one line for it, and
 * a second burst adds none. `ctx.audio.stopAll()` silences every script
 * sound. On the starter, a level object's loop it owns fades out over its
 * `fadeOut` when the level unloads, while a loop owned by nothing plays on
 * until the run restart stops it. Checked through the host's audio
 * observation (the Web Audio graph's state), not heard sound: how it sounds
 * is owner listen pending.
 */
import { createHash, randomBytes } from 'node:crypto';
import { rmSync } from 'node:fs';
import { join } from 'node:path';

import { expect, test, type Page } from '@playwright/test';

import { PERF_ROOT, startPerfBackend, type PerfBackend } from '../../tools/perf/backend';
import { pcmWav } from '../../tools/perf/scale-media';
import { publishScript, publishWav, startBackend, type E2EBackend } from './backend';
import { openWindow } from './ui';

let be: PerfBackend;
let root: string;

const LEVELS = 20;

/** A level's ambience: one loop, started when its object first steps (it belongs to the object). */
const AMBIENCE = [
  'export default {',
  '  instantiate() { return { started: false }; },',
  '  step(state: any, ctx: any) {',
  "    if (ctx.phase !== 'intent' || state.started) return;",
  '    state.started = true;',
  "    ctx.audio.play('amb', { loop: true, volume: 0.4 });",
  '  },',
  '};',
].join('\n');

/** The walker: `walk` loads the levels in turn (the one before unloaded); `burst` plays loops past the voices; `quiet` stops every sound. */
const WALKER = [
  'export default {',
  '  instantiate() { return { next: 0, wait: 0 }; },',
  '  step(state: any, ctx: any) {',
  "    if (ctx.phase !== 'intent') return;",
  "    for (const _ of ctx.debug.command('walk', { description: 'Walk the levels', args: [] })) { state.next = 1; state.wait = 0; }",
  `    if (state.next > 0 && state.next <= ${LEVELS} && --state.wait <= 0) {`,
  "      ctx.scenes.load('level-' + state.next);",
  "      if (state.next > 1) ctx.scenes.unload('level-' + (state.next - 1));",
  '      state.next += 1;',
  '      state.wait = 30;',
  '    }',
  "    for (const _ of ctx.debug.command('burst', { description: 'Loops past the voices', args: [] })) for (let i = 0; i < 12; i += 1) ctx.audio.play('hum', { loop: true, volume: 0.1 });",
  "    for (const _ of ctx.debug.command('quiet', { description: 'Stop every sound', args: [] })) ctx.audio.stopAll();",
  '  },',
  '};',
].join('\n');

type Voice = { handle: number; assetId: string; state: string; loop: boolean };
type Obs = { state?: string; scenes?: { loaded?: string[] }; sound?: { unlocked?: boolean }; audio?: { voices?: Voice[] } };

test('loops started by twenty scenes stop with their scenes; a voice-cap drop is one Problems line per Play; stopAll silences every script sound', async ({ page }) => {
  test.setTimeout(300_000);
  root = join(PERF_ROOT, 'e2e', `script-sound-owners-${process.pid}-${Date.now()}`);
  be = await startPerfBackend(join(root, 'data'), join(root, 'exports'));
  try {
    await walkTwentyScenes(page);
  } finally {
    await be.stop();
    rmSync(root, { recursive: true, force: true });
  }
});

async function walkTwentyScenes(page: Page): Promise<void> {
  const pid = 'sound-owners';
  const created = await be.post('/api/v1/admin/projects', { projectId: pid, name: pid });
  expect([200, 201]).toContain(created.status);
  const p = be.project(pid);

  const publish = async (assetId: string, bytes: Uint8Array): Promise<void> => {
    const stageId = await be.stage(pid, bytes);
    const inspected = await be.post(`/api/v1/projects/${pid}/content/stages/${stageId}/inspect`, { kind: 'audio' });
    const proposal = inspected.json['proposal'] as Record<string, unknown>;
    expect(proposal, JSON.stringify(inspected.json).slice(0, 300)).toBeDefined();
    await p.command('publishAsset', { mode: 'create', assetId, kind: 'audio', displayName: assetId, sourceDigest: proposal['sourceDigest'], sourceByteLength: proposal['sourceByteLength'], importRecipe: proposal['importRecipe'], metrics: proposal['metrics'], importedAt: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z') });
    await be.discardStage(pid, stageId);
  };
  await publish('amb', pcmWav(1, 2_000));
  await publish('hum', pcmWav(2, 2_000));
  // The scripts play them by id: they ship by a label.
  await p.command('setLabels', { items: ['amb', 'hum'].map((id) => ({ kind: 'asset', id })), add: ['played'] });

  const script = async (behaviorId: string, text: string): Promise<void> => {
    const bytes = Buffer.from(`${JSON.stringify({ graphVersion: 1, entryPath: 'src/index.ts', requiredModules: ['@thirdlight/runtime'], ownedTransforms: [], files: [{ path: 'src/index.ts', text }] }, null, 2)}\n`);
    const stageId = await be.stage(pid, bytes);
    const declaration = { properties: [] };
    await p.command('publishBehavior', { behaviorId, displayName: behaviorId, mode: 'declaration-create', declaration });
    await p.command('acknowledgeBehaviorTrust', { sourceDigest: createHash('sha256').update(bytes).digest('hex') });
    const published = await be.post(`/api/v1/projects/${pid}/content/behaviors/source`, { stageId, behaviorId, displayName: behaviorId, declaration, expectedRevision: await p.revision(), requestId: `req-${randomBytes(16).toString('hex')}` });
    expect(published.status, JSON.stringify(published.json).slice(0, 300)).toBe(200);
  };
  await script('ambience', AMBIENCE);
  await script('walker', WALKER);
  for (let i = 1; i <= LEVELS; i += 1) {
    await p.command('createScene', { sceneId: `level-${i}`, name: `Level ${i}` });
    const holder = String((await p.command('createEntity', { sceneId: `level-${i}`, kind: 'group', name: 'Ambience', transform: { position: [i * 2, 0, 0] } }))['createdId']);
    await p.command('setBehaviorProperties', { entityId: holder, behaviorId: 'ambience', values: {} });
  }
  await p.command('setStartScenes', { sceneIds: ['scene-main'] });
  const walker = String((await p.command('createEntity', { sceneId: 'scene-main', kind: 'group', name: 'Walker', transform: { position: [0, -10, 0] } }))['createdId']);
  await p.command('setBehaviorProperties', { entityId: walker, behaviorId: 'walker', values: {} });

  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const relay = (path: string, body: unknown = {}) => be.post(`/api/v1/projects/${pid}/play/${path}`, body);
  await page.goto(`${be.origin}/?project=${pid}#token=${be.token}`);
  await expect(page.locator('.tl-statusbar')).toContainText('connected', { timeout: 60_000 });
  const started = page.waitForResponse((r) => r.request().method() === 'POST' && r.url().endsWith('/play'));
  await page.getByTitle('Start an isolated play preview').click();
  const psid = String(((await (await started).json()) as { playSessionId: string }).playSessionId);
  const observe = async (): Promise<Obs> => {
    const r = await relay(`${psid}/observe`);
    return r.status === 200 ? (r.json as Obs) : {};
  };
  const scriptVoices = async (assetId?: string): Promise<Voice[]> => ((await observe()).audio?.voices ?? []).filter((v) => v.handle > 0 && (assetId === undefined || v.assetId === assetId));
  const command = async (name: string): Promise<void> => {
    const r = await relay(`${psid}/control`, { command: 'debugCommand', name, args: {} });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
  };
  type Diag = { audio?: { skipped?: Record<string, number>; started?: Record<string, number> } };
  const audioReport = async (): Promise<Diag['audio']> => ((await relay(`${psid}/diagnostics`)).json as { diagnostics?: Diag }).diagnostics?.audio;
  const problems = async (): Promise<{ code: string; message: string }[]> => (JSON.parse((await be.get(`/api/v1/projects/${pid}/problems`)).body.toString('utf8')) as { problems: { code: string; message: string }[] }).problems;
  await expect.poll(async () => (await observe()).state, { timeout: 60_000 }).toBe('running');

  // A click in the game turns sound on.
  const frame = page.locator('iframe.tl-app__preview-frame');
  const box = (await frame.boundingBox())!;
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await expect.poll(async () => (await observe()).sound?.unlocked ?? false, { timeout: 30_000 }).toBe(true);

  // The walk: each level starts its loop; the scene before goes, and its loop with it.
  await command('walk');
  await expect.poll(async () => (await observe()).scenes?.loaded ?? [], { timeout: 60_000, message: 'the walk reaches the last level' }).toEqual(expect.arrayContaining([`level-${LEVELS}`]));
  await expect.poll(async () => ((await observe()).scenes?.loaded ?? []).filter((s) => s.startsWith('level-')), { timeout: 30_000 }).toEqual([`level-${LEVELS}`]);
  try {
    await expect.poll(async () => (await scriptVoices('amb')).filter((v) => v.state === 'playing').length, { timeout: 30_000, message: 'one loop plays: the last level\'s' }).toBe(1);
  } catch (e) {
    throw new Error(`${String(e)}\naudio: ${JSON.stringify((await observe()).audio ?? null)}`);
  }
  expect((await scriptVoices('amb')).every((v) => v.loop)).toBe(true);
  const walked = await audioReport();
  expect(walked?.started?.['sfx'] ?? 0, 'every level\'s loop started').toBeGreaterThanOrEqual(LEVELS);
  expect(walked?.skipped?.['voice_cap'], 'no sound was dropped for the voice cap').toBeUndefined();
  expect((await problems()).filter((x) => x.code === 'voice_cap')).toEqual([]);

  // Loops past the project's voices (8): the drops are one Problems line, a second burst adds none.
  await command('burst');
  await expect.poll(async () => (await audioReport())?.skipped?.['voice_cap'] ?? 0, { timeout: 30_000 }).toBeGreaterThan(0);
  await expect.poll(async () => (await problems()).filter((x) => x.code === 'voice_cap').length, { timeout: 30_000 }).toBe(1);
  const first = (await audioReport())?.skipped?.['voice_cap'] ?? 0;
  await command('burst');
  await expect.poll(async () => (await audioReport())?.skipped?.['voice_cap'] ?? 0, { timeout: 30_000 }).toBeGreaterThan(first);
  const line = (await problems()).filter((x) => x.code === 'voice_cap');
  expect(line).toHaveLength(1);
  expect(line[0]!.message).toMatch(/dropped: 8 voices busy\. More sounds play at once than the project's Sound voices setting/);
  await openWindow(page, 'Problems');
  await expect(page.locator('.tl-panel.tl-problems .tl-problem').filter({ hasText: 'Sound voices setting' })).toHaveCount(1, { timeout: 15_000 });

  // stopAll: every script sound stops, whoever started it.
  await command('quiet');
  await expect.poll(async () => (await scriptVoices()).length, { timeout: 30_000, message: 'every script sound stopped' }).toBe(0);
  expect(errors).toEqual([]);
  await page.getByTitle('Stop the play preview').click().catch(() => undefined);
}

/** A level object's sounds: a loop it owns (fading out over 2 s) and a loop owned by nothing. */
const SPEAKER = [
  'export default {',
  '  instantiate() { return { started: false }; },',
  '  step(state: any, ctx: any) {',
  "    if (ctx.phase !== 'intent' || state.started) return;",
  '    state.started = true;',
  "    ctx.audio.play('amb', { loop: true, volume: 0.3, fadeOut: 2 });",
  "    ctx.audio.play('free', { loop: true, volume: 0.3, owner: 'none' });",
  '  },',
  '};',
].join('\n');

/** The start scene's director: debug commands load and unload the level and restart the run. */
const DIRECTOR = [
  'export default {',
  '  step(_state: any, ctx: any) {',
  "    if (ctx.phase !== 'intent') return;",
  "    for (const _ of ctx.debug.command('load', { description: 'Load the level', args: [] })) ctx.scenes.load('level');",
  "    for (const _ of ctx.debug.command('unload', { description: 'Unload the level', args: [] })) ctx.scenes.unload('level');",
  "    for (const _ of ctx.debug.command('restart', { description: 'The deprecated run restart', args: [] })) ctx.lifecycle.restart();",
  '  },',
  '};',
].join('\n');

test('an owned loop fades out over its fadeOut when its scene unloads, one owned by nothing plays on until the run restart stops it', async ({ page }) => {
  test.setTimeout(240_000);
  const sb: E2EBackend = await startBackend('sound-owner-kinds-e2e', 'starter');
  try {
    const cmd = async (op: string, args: Record<string, unknown>): Promise<Record<string, unknown>> => {
      const q = await sb.command({ op: 'queryProject', projectId: sb.projectId, args: {} });
      const res = await sb.command({ op, projectId: sb.projectId, expectedRevision: Number(q['revision']), requestId: `req-${randomBytes(16).toString('hex')}`, origin: { kind: 'mcp', clientId: 'e2e-sound-owners' }, args });
      expect(res['ok'], JSON.stringify(res).slice(0, 600)).toBe(true);
      return res;
    };
    await publishWav(sb, 'cue-max.wav', 'amb', 'Ambience');
    await publishWav(sb, 'cue-max.wav', 'free', 'Free loop');
    await cmd('setLabels', { items: [{ kind: 'asset', id: 'amb' }, { kind: 'asset', id: 'free' }], add: ['played'] });
    await cmd('createScene', { sceneId: 'level', name: 'Level' });
    const speaker = String((await cmd('createEntity', { sceneId: 'level', kind: 'group', name: 'Speaker', transform: { position: [0, -10, 0] } }))['createdId']);
    const director = String((await cmd('createEntity', { sceneId: 'scene-main', kind: 'group', name: 'Director', transform: { position: [0, -10, 0] } }))['createdId']);
    await publishScript(sb, 'speaker', SPEAKER, speaker);
    await publishScript(sb, 'director', DIRECTOR, director);

    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(sb.editorUrl);
    await expect(page.locator('.tl-statusbar')).toContainText('connected');
    const started = page.waitForResponse((r) => r.request().method() === 'POST' && r.url().endsWith('/play'));
    await page.getByTitle('Start an isolated play preview').click();
    const psid = String(((await (await started).json()) as { playSessionId: string }).playSessionId);
    const relay = async (path: string, body: unknown = {}): Promise<{ status: number; json: unknown }> => {
      const r = await fetch(`${sb.origin}/api/v1/projects/${sb.projectId}/play/${psid}/${path}`, { method: 'POST', headers: { authorization: `Bearer ${sb.token}`, 'content-type': 'application/json', origin: sb.origin }, body: JSON.stringify(body) });
      return { status: r.status, json: await r.json() };
    };
    const observe = async (): Promise<Obs> => {
      const r = await relay('observe');
      return r.status === 200 ? (r.json as Obs) : {};
    };
    const states = async (assetId: string): Promise<string[]> => ((await observe()).audio?.voices ?? []).filter((v) => v.handle > 0 && v.assetId === assetId).map((v) => v.state);
    const debug = async (name: string): Promise<void> => {
      const r = await relay('control', { command: 'debugCommand', name, args: {} });
      expect(r.status, JSON.stringify(r.json)).toBe(200);
    };
    await expect.poll(async () => (await observe()).state, { timeout: 60_000 }).toBe('running');
    const box = (await page.locator('iframe.tl-app__preview-frame').boundingBox())!;
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    await expect.poll(async () => (await observe()).sound?.unlocked ?? false, { timeout: 30_000 }).toBe(true);

    await debug('load');
    await expect.poll(async () => [...(await states('amb')), ...(await states('free'))], { timeout: 30_000 }).toEqual(['playing', 'playing']);
    // The level goes: its object's loop fades out (a voice still stopping, then none); the free loop plays on.
    await debug('unload');
    await expect.poll(async () => await states('amb'), { timeout: 30_000, message: 'the owned loop is fading out' }).toEqual(['stopping']);
    await expect.poll(async () => await states('amb'), { timeout: 30_000, message: 'the owned loop is gone after its fade' }).toEqual([]);
    expect(await states('free')).toEqual(['playing']);
    // The deprecated run restart stops every script sound, whoever owns it.
    await debug('restart');
    await expect.poll(async () => await states('free'), { timeout: 30_000, message: 'the run restart stops the free loop' }).toEqual([]);
    expect(errors).toEqual([]);
    await page.getByTitle('Stop the play preview').click().catch(() => undefined);
  } finally {
    await sb.stop();
  }
});
