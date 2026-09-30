/**
 * Audio loading by load type, against a real backend in a real browser.
 *
 * A project with nothing audible in its start scene and four kinds of use:
 * a short WAV decoded on load and preloaded by the scene whose audio source
 * loops it; a voice-length Opus decoded while playing, read when first
 * played; a long Opus streamed through a media element; a dialogue whose
 * lines branch (a choice of two replies that meet again), voiced with Opus
 * files that are read only when needed.
 *
 * In Play: nothing audio is read when the game starts; loading the scene
 * reads and decodes its WAV (the loop plays), unloading it frees it; the
 * decoded-while-playing file starts once read and decoded (the observation
 * says how late) and its decoded buffer is freed when it ends while its
 * compressed bytes stay; the streamed file plays through its element and is
 * freed when stopped; a sound played with a bound of 0 before its file is
 * read is dropped and reported; and while the dialogue's first line plays,
 * the voices of both replies and the line after them are fetched before
 * either reply starts, so the reply's voice starts at once. What any of it
 * sounds like is owner listen pending.
 */
import { createHash, randomBytes } from 'node:crypto';
import { rmSync } from 'node:fs';
import { join } from 'node:path';

import { expect, test } from '@playwright/test';

import { PERF_ROOT, startPerfBackend, type PerfBackend } from '../../tools/perf/backend';
import { opusVoice, pcmWav } from '../../tools/perf/scale-media';

let be: PerfBackend;
let root: string;
test.beforeEach(async () => {
  root = join(PERF_ROOT, 'e2e', `audio-loading-${process.pid}-${Date.now()}`);
  be = await startPerfBackend(join(root, 'data'), join(root, 'exports'));
});
test.afterEach(async () => {
  await be.stop();
  rmSync(root, { recursive: true, force: true });
});

/** The driver: debug commands play a sound (with a bound), stop the ones it played, and run the dialogue. */
const DRIVER = [
  'export default {',
  '  instantiate() { return { handles: [] as number[] }; },',
  '  step(state: any, ctx: any) {',
  "    if (ctx.phase !== 'intent') return;",
  "    for (const call of ctx.debug.command('play', { description: 'Play a sound', args: [{ name: 'id', type: 'string' }, { name: 'late', type: 'number' }] })) {",
  '      const late = Number(call.late);',
  "      const h = ctx.audio.play(String(call.id), { bus: 'sfx', ...(late >= 0 ? { maxLateMs: late } : {}) });",
  '      if (h > 0) state.handles.push(h);',
  '    }',
  "    for (const _ of ctx.debug.command('stopAll', { description: 'Stop the sounds played', args: [] })) {",
  '      for (const h of state.handles) ctx.audio.stop(h, 0);',
  '      state.handles = [];',
  '    }',
  "    for (const _ of ctx.debug.command('talk', { description: 'Start the dialogue', args: [] })) ctx.dialogue.start('talk');",
  "    for (const call of ctx.debug.command('choose', { description: 'Pick an option', args: [{ name: 'index', type: 'number' }] })) ctx.dialogue.choose(Number(call.index));",
  "    for (const _ of ctx.debug.command('advance', { description: 'Next line', args: [] })) ctx.dialogue.advance();",
  '  },',
  '};',
].join('\n');

type Resident = Partial<Record<string, { count: number; bytes: number }>>;
interface Resources {
  resident: Resident;
  loads: Partial<Record<string, number>>;
  frees: Partial<Record<string, number>>;
  loading: number;
  waiting: number;
}
type Voice = { handle: number; key?: string; assetId: string; bus: string; state: string; lateMs?: number };
type Late = { started: number; dropped: number; recent: { handle: number; assetId: string; outcome: string; lateMs: number; maxLateMs: number; waitedFor?: string }[] };
type Obs = { state?: string; loops?: Record<string, number>; scenes?: { loaded?: string[] }; resources?: Resources; sound?: { unlocked?: boolean }; audio?: { voices?: Voice[]; late?: Late }; dialogue?: { dialogueId?: string; kind?: string; line?: { id?: string; reveal?: number; total?: number } | null } };

test('Play: each load type loads, plays and is freed as its settings say; a late sound is dropped past its bound; dialogue voices are read ahead on every branch', async ({ page }) => {
  test.setTimeout(300_000);
  const pid = 'audio-loading';
  const created = await be.post('/api/v1/admin/projects', { projectId: pid, name: pid });
  expect([200, 201]).toContain(created.status);
  const p = be.project(pid);

  // The files: their digests name them in the page's requests.
  const digests = new Map<string, string>();
  const publish = async (assetId: string, bytes: Uint8Array, options: Record<string, unknown> = {}): Promise<void> => {
    const stageId = await be.stage(pid, bytes);
    const inspected = await be.post(`/api/v1/projects/${pid}/content/stages/${stageId}/inspect`, { kind: 'audio' });
    const proposal = inspected.json['proposal'] as Record<string, unknown>;
    expect(proposal, JSON.stringify(inspected.json).slice(0, 300)).toBeDefined();
    await p.command('publishAsset', { mode: 'create', assetId, kind: 'audio', displayName: assetId, sourceDigest: proposal['sourceDigest'], sourceByteLength: proposal['sourceByteLength'], importRecipe: proposal['importRecipe'], metrics: proposal['metrics'], importedAt: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z') });
    await be.discardStage(pid, stageId);
    digests.set(assetId, String(proposal['sourceDigest']));
    if (Object.keys(options).length > 0) await p.command('setAssetOptions', { assetId, ...options });
  };
  await publish('hit', pcmWav(1, 600)); // decode on load (under 5 s), preloaded (the default)
  await publish('line', opusVoice(2, 1_500, 'line'), { loadType: 'decode-while-playing', preload: false });
  await publish('theme', opusVoice(3, 70_000, 'theme')); // stream (over 60 s)
  await publish('late', opusVoice(4, 1_200, 'late'), { loadType: 'decode-while-playing', preload: false });
  for (const v of ['v1', 'v2a', 'v2b', 'v3']) await publish(v, opusVoice(10 + v.length + v.charCodeAt(v.length - 1), 2_500, v), { loadType: 'decode-while-playing', preload: false });
  // The files the driver plays by id ship by a label.
  await p.command('setLabels', { items: ['line', 'theme', 'late'].map((id) => ({ kind: 'asset', id })), add: ['played'] });

  // The room scene loops the WAV; the start scene holds only the driver.
  await p.command('createScene', { sceneId: 'room', name: 'Room' });
  await p.command('setStartScenes', { sceneIds: ['scene-main'] });
  const brook = String((await p.command('createEntity', { sceneId: 'room', kind: 'group', name: 'Brook', transform: { position: [0, 0, 0] }, components: { audioSource: { assetId: 'hit', volume: 0.3, range: 20 } } }))['createdId']);
  // The dialogue: l1, then a choice of two replies (each voiced), which meet again at l3.
  const node = (id: string, type: string, y: number, data?: Record<string, unknown>) => ({ id, type, position: [0, y], ...(data !== undefined ? { data } : {}) });
  const wire = (id: string, from: string, port: string, to: string) => ({ id, from: { node: from, port }, to: { node: to, port: 'in' } });
  await p.command('setDialogue', {
    dialogue: {
      dialogueId: 'talk',
      name: 'Branches',
      graph: {
        nodes: [
          node('start', 'start', 0),
          node('l1', 'line', 100, { text: 'Which way?', voice: 'v1' }),
          node('pick', 'choice', 200),
          node('o1', 'option', 300, { text: 'Left' }),
          node('o2', 'option', 310, { text: 'Right' }),
          node('l2a', 'line', 400, { text: 'Left it is.', voice: 'v2a' }),
          node('l2b', 'line', 410, { text: 'Right it is.', voice: 'v2b' }),
          node('l3', 'line', 500, { text: 'Here we are.', voice: 'v3' }),
        ],
        edges: [wire('w1', 'start', 'next', 'l1'), wire('w2', 'l1', 'next', 'pick'), wire('w3', 'pick', 'options', 'o1'), wire('w4', 'pick', 'options', 'o2'), wire('w5', 'o1', 'next', 'l2a'), wire('w6', 'o2', 'next', 'l2b'), wire('w7', 'l2a', 'next', 'l3'), wire('w8', 'l2b', 'next', 'l3')],
      },
    },
  });
  const driver = String((await p.command('createEntity', { sceneId: 'scene-main', kind: 'group', name: 'Driver', transform: { position: [0, -10, 0] } }))['createdId']);
  const bytes = Buffer.from(`${JSON.stringify({ graphVersion: 1, entryPath: 'src/index.ts', requiredModules: ['@thirdlight/runtime'], ownedTransforms: [], files: [{ path: 'src/index.ts', text: DRIVER }] }, null, 2)}\n`);
  const stageId = await be.stage(pid, bytes);
  const declaration = { properties: [] };
  await p.command('publishBehavior', { behaviorId: 'driver', displayName: 'Driver', mode: 'declaration-create', declaration });
  await p.command('acknowledgeBehaviorTrust', { sourceDigest: createHash('sha256').update(bytes).digest('hex') });
  const published = await be.post(`/api/v1/projects/${pid}/content/behaviors/source`, { stageId, behaviorId: 'driver', displayName: 'Driver', declaration, expectedRevision: await p.revision(), requestId: `req-${randomBytes(16).toString('hex')}` });
  expect(published.status, JSON.stringify(published.json).slice(0, 300)).toBe(200);
  await p.revision();
  await p.command('setBehaviorProperties', { entityId: driver, behaviorId: 'driver', values: {} });

  // Every audio file the page fetches, by asset, with when.
  const fetched = new Map<string, number>();
  page.on('request', (r) => {
    for (const [id, digest] of digests) if (r.url().includes(digest) && !fetched.has(id)) fetched.set(id, Date.now());
  });
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
  const res = async (): Promise<Resources> => (await observe()).resources!;
  const count = async (kind: string): Promise<number> => (await res()).resident[kind]?.count ?? 0;
  const voices = async (): Promise<Voice[]> => (await observe()).audio?.voices ?? [];
  const command = async (name: string, args: Record<string, unknown> = {}): Promise<void> => {
    const r = await relay(`${psid}/control`, { command: 'debugCommand', name, args });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
  };
  const playing = async (what: string, pick: (v: Voice) => boolean): Promise<Voice> => {
    try {
      await expect.poll(async () => (await voices()).find(pick)?.state ?? null, { timeout: 30_000, message: what }).toBe('playing');
    } catch (e) {
      const o = await observe();
      throw new Error(`${String(e)}\nobservation: ${JSON.stringify(o.audio ?? null)}\ndialogue: ${JSON.stringify(o.dialogue ?? null)}`);
    }
    return (await voices()).find(pick)!;
  };
  await expect.poll(async () => (await observe()).state, { timeout: 60_000 }).toBe('running');

  // Nothing audio is read at the start (no scene or project block preloads any).
  await expect.poll(async () => { const r = await res(); return r.loading + r.waiting; }, { timeout: 30_000 }).toBe(0);
  expect([...fetched.keys()]).toEqual([]);
  expect(Object.keys((await res()).resident).filter((k) => k.startsWith('audio'))).toEqual([]);

  // A click in the game turns sound on.
  const frame = page.locator('iframe.tl-app__preview-frame');
  const box = (await frame.boundingBox())!;
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await expect.poll(async () => (await observe()).sound?.unlocked ?? false, { timeout: 30_000 }).toBe(true);

  // Decode on load, preloaded: the room's WAV is read with the room, decoded and looped; unloading the room frees it.
  expect((await relay(`${psid}/control`, { command: 'loadScene', sceneId: 'room' })).status).toBe(200);
  // (A 2D project hears audio sources by distance: the loop shows under `loops`.)
  await expect.poll(async () => (await observe()).loops?.[brook] !== undefined, { timeout: 30_000, message: 'the room loops its WAV' }).toBe(true);
  expect(fetched.has('hit')).toBe(true);
  expect(await count('audio')).toBe(1);

  // Decode while playing, read on first play: it starts once read and decoded (and says how late);
  // when it ends its decoded buffer is freed and its compressed bytes stay (the scenes loaded then keep them).
  const audioFrees = (await res()).frees['audio'] ?? 0;
  await command('play', { id: 'line', late: -1 });
  const line = await playing('the decoded-while-playing file plays', (v) => v.assetId === 'line');
  expect(fetched.has('line')).toBe(true);
  expect((await observe()).audio?.late?.recent.find((r) => r.handle === line.handle)).toMatchObject({ assetId: 'line', outcome: 'started', maxLateMs: 500 });
  expect(line.lateMs).toBeGreaterThan(0);
  await expect.poll(async () => (await voices()).some((v) => v.assetId === 'line'), { timeout: 15_000 }).toBe(false);
  await expect.poll(async () => (await res()).frees['audio'] ?? 0, { timeout: 15_000 }).toBe(audioFrees + 1);
  expect(await count('audio-bytes')).toBe(1);
  expect(await count('audio')).toBe(1);

  // Stream: a media element reads the long file as it plays (not decoded); stopping it frees the element.
  await command('play', { id: 'theme', late: 5000 });
  await playing('the streamed file plays', (v) => v.assetId === 'theme');
  expect(await count('audio-stream')).toBe(1);
  expect(await count('audio')).toBe(1);
  await command('stopAll');
  await expect.poll(async () => count('audio-stream'), { timeout: 15_000 }).toBe(0);
  expect(((await res()).frees['audio-stream'] ?? 0)).toBe(1);

  // A sound played with a bound of 0 before its file is read is dropped, and the observation says so.
  await command('play', { id: 'late', late: 0 });
  await expect.poll(async () => (await observe()).audio?.late?.recent.find((r) => r.assetId === 'late') ?? null, { timeout: 15_000 }).toMatchObject({ outcome: 'dropped', maxLateMs: 0, waitedFor: 'file' });
  expect((await voices()).some((v) => v.assetId === 'late')).toBe(false);

  // Unloading the room frees its WAV.
  expect((await relay(`${psid}/control`, { command: 'unloadScene', sceneId: 'room' })).status).toBe(200);
  await expect.poll(async () => (await observe()).loops?.[brook] !== undefined, { timeout: 15_000 }).toBe(false);
  await expect.poll(async () => count('audio'), { timeout: 15_000 }).toBe(0);

  // Dialogue: while the first line plays, both replies' voices and the line after them are fetched.
  await command('talk');
  await playing('the first line is voiced', (v) => v.assetId === 'v1' && v.bus === 'voice');
  await expect.poll(async () => ['v2a', 'v2b', 'v3'].filter((v) => fetched.has(v)), { timeout: 15_000 }).toEqual(['v2a', 'v2b', 'v3']);
  expect((await observe()).dialogue?.line?.id).toBe('l1');
  const readAhead = Math.max(fetched.get('v2a')!, fetched.get('v2b')!);
  // On to the choice once the line is shown whole (an advance before that shows it at once); the second reply is picked.
  await expect.poll(async () => { const l = (await observe()).dialogue?.line; return l !== undefined && l !== null && l.reveal === l.total; }, { timeout: 15_000 }).toBe(true);
  await command('advance');
  await expect.poll(async () => (await observe()).dialogue?.kind ?? null, { timeout: 15_000 }).toBe('choice');
  await command('choose', { index: 1 });
  const reply = await playing('the reply read ahead is voiced', (v) => v.assetId === 'v2b');
  const replyStarted = Date.now();
  expect(readAhead).toBeLessThan(replyStarted);
  // Read ahead (the next lines' voices decoded too): its voice started with its line, not late.
  expect(reply.lateMs).toBeUndefined();

  await page.getByTitle('Stop the play preview').click();
  expect(errors).toEqual([]);
});
