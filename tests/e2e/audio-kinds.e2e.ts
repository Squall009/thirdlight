/**
 * One audio kind, against a real backend and Chromium: a 70 s mono Ogg Opus
 * (whole packets of real Opus from the scale bench's pool) and a 1.5 s stereo
 * 44.1 kHz WAV are imported through the Assets tab as the same Audio kind.
 * The asset inspector shows their facts and load settings (the Opus streams
 * by default, the WAV decodes on load; Ogg carries the Safari note), and a
 * change of load type and preload there is stored through the backend.
 *
 * In Play the Opus is a dialogue line's voice and an audio source, the WAV an
 * event cue: the host's audio observation shows each playing (the voice on
 * the voice bus, the cue a script sound on the sfx bus, the source a
 * positional loop), so the Opus read on first use and the WAV decoded at
 * start both reach the Web Audio graph. What they sound like is owner listen
 * pending.
 */
import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect, test, type Page } from '@playwright/test';

import { opusVoice } from '../../tools/perf/scale-media';
import { startBackend, type E2EBackend } from './backend';
import { projectWindow } from './ui';

let be: E2EBackend | null = null;
let dir = '';
test.beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'tl-audio-kinds-e2e-'));
});
test.afterEach(async () => {
  await be?.stop();
  be = null;
  rmSync(dir, { recursive: true, force: true });
});

async function query(op: string, args: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  return be!.command({ op, projectId: be!.projectId, args });
}
async function cmd(op: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const revision = Number((await query('queryProject')).revision);
  const res = await be!.command({ op, projectId: be!.projectId, expectedRevision: revision, requestId: `req-${randomBytes(16).toString('hex')}`, origin: { kind: 'mcp', clientId: 'e2e-audio-kinds' }, args });
  expect(res['ok'], JSON.stringify(res).slice(0, 600)).toBe(true);
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

type AudioSummary = { format: string; channels: number; sampleRate: number; durationMs: number; loadType: string; loadTypeSet: boolean; preload: boolean; playbackGaps?: string[] };
async function asset(assetId: string): Promise<{ assetId: string; kind: string; displayName: string; audio?: AudioSummary }> {
  return ((await query('queryAssets', { assetId }))['assets'] as { assetId: string; kind: string; displayName: string; audio?: AudioSummary }[])[0]!;
}

/** Import one file through the editor's Assets tab; returns its asset id. */
async function importFile(page: Page, file: string, name: string): Promise<string> {
  const assets = async () => (await query('queryAssets', { limit: 50, offset: 0 }))['assets'] as { assetId: string; displayName: string }[];
  const before = (await assets()).length;
  await projectWindow(page);
  await page.locator('.tl-assets__file').first().setInputFiles(file);
  const publish = page.getByRole('button', { name: 'publish' });
  await expect(publish).toBeEnabled({ timeout: 15_000 });
  await publish.click();
  await expect.poll(async () => (await assets()).length, { timeout: 15_000 }).toBe(before + 1);
  return (await assets()).find((a) => a.displayName === name)!.assetId;
}

/** A 16-bit PCM WAV: a quiet two-tone chord, `channels` interleaved. */
function wav(channels: number, rate: number, seconds: number): Buffer {
  const frames = Math.round(rate * seconds);
  const b = Buffer.alloc(44 + frames * channels * 2);
  b.write('RIFF', 0);
  b.writeUInt32LE(b.length - 8, 4);
  b.write('WAVEfmt ', 8);
  b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20);
  b.writeUInt16LE(channels, 22);
  b.writeUInt32LE(rate, 24);
  b.writeUInt32LE(rate * channels * 2, 28);
  b.writeUInt16LE(channels * 2, 32);
  b.writeUInt16LE(16, 34);
  b.write('data', 36);
  b.writeUInt32LE(frames * channels * 2, 40);
  for (let i = 0; i < frames; i++) for (let c = 0; c < channels; c++) b.writeInt16LE(Math.round(Math.sin((2 * Math.PI * (440 + 220 * c) * i) / rate) * 3000), 44 + (i * channels + c) * 2);
  return b;
}

const SCRIPT = [
  'export default {',
  '  instantiate() { return { last: -1 }; },',
  '  step(state: any, ctx: any) {',
  '    if (state.last === ctx.stepIndex) return;',
  '    state.last = ctx.stepIndex;',
  '    const act = ctx.action.actions ?? {};',
  "    if (act.talk?.p === 'pressed' && !ctx.dialogue.isRunning()) ctx.dialogue.start('talk');",
  "    if (act.chime?.p === 'pressed') ctx.signals.emit('chime');",
  '  },',
  '};',
].join('\n');

async function publishScript(entityId: string): Promise<void> {
  const behaviorId = 'caller';
  const bytes = Buffer.from(`${JSON.stringify({ graphVersion: 1, entryPath: 'src/index.ts', requiredModules: ['@thirdlight/runtime'], ownedTransforms: [], files: [{ path: 'src/index.ts', text: SCRIPT }] }, null, 2)}\n`);
  const stage = await api('content/stages', {});
  const stageId = String(stage.json.stageId);
  const put = await fetch(`${be!.origin}/api/v1/projects/${be!.projectId}/content/stages/${stageId}/bytes`, {
    method: 'PUT',
    headers: { authorization: `Bearer ${be!.token}`, origin: be!.origin, 'content-type': 'application/octet-stream', 'x-thirdlight-offset': '0', 'x-thirdlight-total': String(bytes.length) },
    body: bytes,
  });
  expect(put.status).toBe(200);
  const declaration = { properties: [] };
  await cmd('publishBehavior', { behaviorId, displayName: 'Caller', mode: 'declaration-create', declaration });
  await cmd('acknowledgeBehaviorTrust', { sourceDigest: createHash('sha256').update(bytes).digest('hex') });
  const published = await api('content/behaviors/source', { stageId, behaviorId, displayName: 'Caller', declaration, expectedRevision: Number((await query('queryProject')).revision), requestId: `req-${randomBytes(16).toString('hex')}` });
  expect(published.status, JSON.stringify(published.json)).toBe(200);
  await cmd('setBehaviorProperties', { entityId, behaviorId, values: {} });
}

async function press(page: Page, key: string): Promise<void> {
  await page.keyboard.down(key);
  await page.waitForTimeout(150);
  await page.keyboard.up(key);
}

type Voice = { handle: number; key?: string; assetId: string; bus?: string; state: string };

test('a long Opus and a stereo 44.1 kHz WAV are one Audio kind: inspector load settings, and in Play a dialogue voice, an event cue and an audio source', async ({ page }) => {
  test.setTimeout(300_000);
  be = await startBackend('audio-kinds-e2e');
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(be.editorUrl);
  await expect(page.locator('.tl-statusbar')).toContainText('connected');

  const opusFile = join(dir, 'ambience.opus');
  writeFileSync(opusFile, opusVoice(11, 70_000, 'ambience'));
  const wavFile = join(dir, 'chime.wav');
  writeFileSync(wavFile, wav(2, 44_100, 1.5));
  const opus = await importFile(page, opusFile, 'ambience');
  const chime = await importFile(page, wavFile, 'chime');

  // One kind; the facts and the defaults by length.
  expect(await asset(opus)).toMatchObject({ kind: 'audio', audio: { format: 'ogg-opus', channels: 1, sampleRate: 48000, loadType: 'stream', loadTypeSet: false, preload: true } });
  expect((await asset(opus)).audio!.durationMs).toBeGreaterThan(69_000);
  expect(await asset(chime)).toMatchObject({ kind: 'audio', audio: { format: 'wav', channels: 2, sampleRate: 44100, durationMs: 1500, loadType: 'decode-on-load', preload: true } });
  expect((await asset(chime)).audio!.playbackGaps).toBeUndefined();
  const tile = (name: string) => page.locator('.tl-assets__list li.tl-tile').filter({ has: page.locator('.tl-tile__name', { hasText: new RegExp(`^${name}$`) }) });
  await expect(tile('ambience').locator('.tl-tile__meta')).toContainText('audio');
  await expect(tile('chime').locator('.tl-tile__meta')).toContainText('audio');

  // The asset inspector: facts, the default named, the Safari note on Ogg.
  await tile('chime').click();
  await expect(page.getByTestId('audio-facts')).toContainText('WAV · stereo · 44.1 kHz · 16-bit · 1.50 s');
  await expect(page.getByLabel('audio load type')).toHaveValue('default');
  await expect(page.getByLabel('audio load type').locator('option[value="default"]')).toHaveText('default for its length (decode on load)');
  await expect(page.getByTestId('audio-playback-gaps')).toHaveCount(0);
  await tile('ambience').click();
  await expect(page.getByTestId('audio-facts')).toContainText('Ogg Opus · mono · 48 kHz');
  await expect(page.getByLabel('audio load type').locator('option[value="default"]')).toHaveText('default for its length (stream)');
  await expect(page.getByTestId('audio-playback-gaps')).toContainText('Safari older than 18.4');
  // A change there is one command each, stored on the record and in the sidecar.
  await page.getByLabel('audio load type').selectOption('decode-while-playing');
  await expect.poll(async () => (await asset(opus)).audio?.loadType).toBe('decode-while-playing');
  expect((await asset(opus)).audio!.loadTypeSet).toBe(true);
  // The box follows the stored value (it changes when the command is applied).
  await page.getByLabel('audio preload').click();
  await expect.poll(async () => (await asset(opus)).audio?.preload).toBe(false);
  await expect(page.getByLabel('audio load type')).toHaveValue('decode-while-playing');
  await expect(page.getByLabel('audio preload')).not.toBeChecked();

  // The scene: a 3D floor and player, the Opus as an audio source and a dialogue voice, the WAV as an event cue.
  await cmd('setSettings', { settings: { physics_dimension: 3 } });
  await cmd('createEntity', { sceneId: 'scene-main', parentId: null, kind: 'box', name: 'Floor', transform: { position: [0, -0.5, 0] }, box: { size: [40, 1, 40], material: { color: '#8a8f98' } }, components: { collider: { shape: { type: 'box', hx: 20, hy: 0.5, hz: 20 } } } });
  const player = String((await cmd('createEntity', { sceneId: 'scene-main', parentId: null, kind: 'group', name: 'Player', transform: { position: [0, 0.91, 0] } }))['createdId']);
  await cmd('setComponent', { entityId: player, component: 'controller', value: {} });
  const brook = String((await cmd('createEntity', { sceneId: 'scene-main', parentId: null, kind: 'group', name: 'Brook', transform: { position: [-6, 1, 0] } }))['createdId']);
  await cmd('setComponent', { entityId: brook, component: 'audioSource', value: { assetId: opus, volume: 0.4, range: 20 } });
  await cmd('setSpeaker', { speaker: { speakerId: 'host', name: 'Host' } });
  const node = (id: string, type: string, y: number, data?: Record<string, unknown>) => ({ id, type, position: [0, y], ...(data !== undefined ? { data } : {}) });
  await cmd('setDialogue', {
    dialogue: {
      dialogueId: 'talk',
      name: 'Voiced',
      graph: { nodes: [node('start', 'start', 0), node('line', 'line', 100, { speaker: 'host', text: 'Listen to the brook.', voice: opus })], edges: [{ id: 'w1', from: { node: 'start', port: 'next' }, to: { node: 'line', port: 'in' } }] },
    },
  });
  await cmd('setEventCues', { cues: [{ on: 'signal', name: 'chime', assetId: chime, volume: 0.8 }] });
  await cmd('setInput', { input: { actions: [{ name: 'talk', type: 'button', map: 'gameplay', bindings: [{ kind: 'key', code: 'KeyT' }] }, { name: 'chime', type: 'button', map: 'gameplay', bindings: [{ kind: 'key', code: 'KeyC' }] }] } });
  const caller = String((await cmd('createEntity', { sceneId: 'scene-main', parentId: null, kind: 'group', name: 'Caller', transform: { position: [0, -3, 0] } }))['createdId']);
  await publishScript(caller);

  // Play.
  const started = page.waitForResponse((r) => r.request().method() === 'POST' && r.url().endsWith('/play'));
  await page.getByTitle('Start an isolated play preview').click();
  const psid = String(((await (await started).json()) as { playSessionId: string }).playSessionId);
  const frame = page.locator('iframe.tl-app__preview-frame');
  const observe = async (): Promise<Record<string, unknown> | null> => {
    const r = await api(`play/${psid}/observe`, {});
    return r.status === 200 ? r.json : null;
  };
  const voices = async (): Promise<Voice[]> => ((await observe())?.['audio'] as { voices?: Voice[] } | undefined)?.voices ?? [];
  await expect.poll(async () => (await observe())?.['state'] ?? null, { timeout: 60_000 }).toBe('running');
  // A click in the game focuses it and unlocks sound.
  const box = (await frame.boundingBox())!;
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await expect.poll(async () => ((await observe())?.['sound'] as { unlocked?: boolean } | undefined)?.unlocked ?? false, { timeout: 30_000 }).toBe(true);

  const playing = async (what: string, pick: (v: Voice) => boolean): Promise<Voice> => {
    try {
      await expect.poll(async () => (await voices()).find(pick)?.state ?? null, { timeout: 30_000, message: what }).toBe('playing');
    } catch (e) {
      throw new Error(`${String(e)}\nobservation: ${JSON.stringify((await observe())?.['audio'] ?? null)}`);
    }
    return (await voices()).find(pick)!;
  };
  // The audio source: the Opus read on first use, decoded, looping at its place.
  await playing('the audio source plays the Opus', (v) => v.key === brook && v.assetId === opus);
  // The event cue: the WAV decoded at start, played by the signal on the sfx bus.
  await press(page, 'c');
  const cue = await playing('the event cue plays the WAV', (v) => v.assetId === chime && v.handle > 0);
  expect(cue.bus).toBe('sfx');
  // The dialogue voice: the same Opus on the voice bus.
  await press(page, 't');
  const voice = await playing('the dialogue voice plays the Opus', (v) => v.assetId === opus && v.bus === 'voice');
  expect(voice.handle).toBeGreaterThan(0);

  await page.getByTitle('Stop the play preview').click();
  await expect(frame).toHaveCount(0, { timeout: 30_000 });
  expect(errors).toEqual([]);
});
