/**
 * Play diagnostics' audio block and the message-queue warning, against a
 * real backend in a real browser, read over HTTP and MCP.
 *
 * A blank project with two imported WAV sounds and one script: it starts a
 * music track on its first step, plays a short sound every half second that
 * may start at most 50 ms late, and at step 30 sends more messages in one
 * step than the queue takes.
 *
 * - Before the player's first click in the game: the audio block says sound
 *   is locked (waiting for a gesture, no AudioContext yet), the music waits
 *   for the unlock, and the short sounds are counted as dropped for it (with
 *   a note naming the sound). The runtime block carries the message-queue
 *   warning with the refused count.
 * - After the click: unlocked with a running context, the music plays and
 *   short sounds are started.
 *
 * What it sounds like is owner listen pending: the test reads the Web Audio
 * graph's state, not heard sound.
 */
import { createHash, randomBytes } from 'node:crypto';
import { join, resolve } from 'node:path';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { expect, test, type Page } from '@playwright/test';

import { startBackend, type E2EBackend } from './backend';
import { projectWindow } from './ui';

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
  const res = await be!.command({ op, projectId: be!.projectId, expectedRevision: revision, requestId: `req-${randomBytes(16).toString('hex')}`, origin: { kind: 'mcp', clientId: 'e2e-audio-diagnostics' }, args });
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

/** Publish a behavior with asset properties and attach it to `entityId`. */
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
  await projectWindow(page);
  await page.locator('.tl-assets__file').first().setInputFiles(join(REPO, 'fixtures', 'm3', 'media', 'wav', file));
  const publish = page.getByRole('button', { name: 'publish' });
  await expect(publish).toBeEnabled({ timeout: 15_000 });
  await publish.click();
  const assets = async () => (await query('queryAssets', { limit: 50, offset: 0 }))['assets'] as { assetId: string; displayName: string }[];
  await expect.poll(async () => (await assets()).length, { timeout: 15_000 }).toBe(before + 1);
  return (await assets()).find((a) => a.displayName === name)!.assetId;
}

const SOUNDS = [
  'export default {',
  '  instantiate() { return { music: false }; },',
  '  step(state: any, ctx: any) {',
  "    if (ctx.phase !== 'intent') return;",
  '    const s = ctx.stepIndex;',
  '    if (!state.music) { state.music = true; ctx.audio.music(ctx.properties.theme, 0); }',
  '    if (s % 60 === 0) ctx.audio.play(ctx.properties.blip, { volume: 0.5, maxLateMs: 50 });',
  "    if (s === 30) for (let i = 0; i < 300; i += 1) ctx.messages.send('burst', i);",
  '  },',
  '};',
].join('\n');

interface AudioBlock {
  unlock: { state: string; reason?: string; context: string; muted: boolean };
  playing: { music: { assetId: string | null; playing: boolean; waitingFor?: string }; voices: number; byBus: Record<string, number> };
  started: Record<string, number>;
  skipped: Record<string, number>;
  late: { started: number; dropped: number; recent: { assetId: string; outcome: string; waitedFor?: string }[] };
  notes: string[];
}
interface Diagnostics {
  audio?: AudioBlock | null;
  runtime?: { messageQueue?: { refused: number; perStepLimit: number; warning: string } };
}

test('Play diagnostics: the audio block before and after the unlock, and the message-queue warning, over HTTP and MCP', async ({ page }) => {
  test.setTimeout(300_000);
  be = await startBackend('audio-diagnostics-e2e');
  await page.goto(be.editorUrl);
  await expect(page.locator('.tl-statusbar')).toContainText('connected');
  const theme = await importWav(page, 'cue-max.wav', 'cue-max');
  const blip = await importWav(page, 'cue-goal.wav', 'cue-goal');
  const holder = String((await cmd('createEntity', { parentId: null, kind: 'group', name: 'Sounds', transform: { position: [0, -3, 0] } }))['createdId']);
  await script('sounds', SOUNDS, holder, { theme, blip });

  const started = page.waitForResponse((r) => r.request().method() === 'POST' && r.url().endsWith('/play'));
  await page.getByTitle('Start an isolated play preview').click();
  const psid = String(((await (await started).json()) as { playSessionId: string }).playSessionId);
  const frame = page.locator('iframe.tl-app__preview-frame');
  const http = async (): Promise<Diagnostics | null> => {
    const r = await api(`play/${psid}/diagnostics`, {});
    return r.status === 200 ? ((r.json['diagnostics'] as Diagnostics | undefined) ?? null) : null;
  };
  const mcp = new Client({ name: 'thirdlight-e2e', version: '0.0.0' });
  await mcp.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [join(REPO, 'dist', 'mcp-adapter', 'mcp.mjs')],
      env: { ...process.env, THIRDLIGHT_AUTHORING_ORIGIN: be.origin, THIRDLIGHT_PROJECT_ID: be.projectId, THIRDLIGHT_MCP_TOKEN: be.token } as Record<string, string>,
      stderr: 'ignore',
    }),
  );
  const viaMcp = async (): Promise<Diagnostics> => {
    const res = (await mcp.callTool({ name: 'tl_diagnostics', arguments: { playSessionId: psid } })) as { isError?: boolean; content: { text: string }[] };
    expect(res.isError ?? false, res.content[0]?.text).toBe(false);
    return (JSON.parse(res.content[0]!.text) as { diagnostics: Diagnostics }).diagnostics;
  };
  try {
    // Before any gesture in the game: locked, the music waits, the short sounds are dropped for the unlock.
    await expect.poll(async () => (await http())?.audio?.skipped['locked'] ?? 0, { timeout: 60_000, message: 'a short sound dropped while locked' }).toBeGreaterThan(0);
    const before = (await http())!;
    const a0 = before.audio!;
    expect(a0.unlock).toMatchObject({ state: 'locked', reason: 'waiting_for_gesture', context: 'none', muted: false });
    expect(a0.playing.music).toEqual({ assetId: theme, playing: false, waitingFor: 'unlock' });
    expect(a0.playing.voices).toBe(0);
    expect(a0.started).toEqual({ sfx: 0, ui: 0, voice: 0, music: 0 });
    expect(a0.late.recent.at(-1)).toMatchObject({ assetId: blip, outcome: 'dropped', waitedFor: 'unlock' });
    expect(a0.notes.join('\n')).toContain(blip);
    // The burst: 300 sent in one step, the queue took its limit and refused the rest.
    const queue = before.runtime!.messageQueue!;
    expect(queue.refused).toBe(300 - queue.perStepLimit);
    expect(queue.warning).toContain(`more than ${queue.perStepLimit} sent in one step`);
    const m0 = await viaMcp();
    expect(m0.audio!.unlock.state).toBe('locked');
    expect(m0.runtime!.messageQueue!.refused).toBe(queue.refused);

    // The player's first click in the game unlocks sound.
    const box = (await frame.boundingBox())!;
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    await expect.poll(async () => (await http())?.audio?.unlock.state ?? null, { timeout: 30_000, message: 'unlocked' }).toBe('unlocked');
    await expect.poll(async () => (await http())?.audio?.playing.music.playing ?? false, { timeout: 30_000, message: 'the music plays' }).toBe(true);
    await expect.poll(async () => (await http())?.audio?.started['sfx'] ?? 0, { timeout: 30_000, message: 'short sounds start' }).toBeGreaterThan(0);
    const after = (await http())!.audio!;
    expect(after.unlock).toMatchObject({ state: 'unlocked', context: 'running', muted: false });
    expect(after.unlock.reason).toBeUndefined();
    expect(after.playing.music).toEqual({ assetId: theme, playing: true });
    expect(after.started['music']).toBe(1);
    const m1 = await viaMcp();
    expect(m1.audio!.unlock).toMatchObject({ state: 'unlocked', context: 'running' });
    expect(m1.audio!.playing.music.playing).toBe(true);
  } finally {
    await mcp.close();
  }
  await page.getByTitle('Stop the play preview').click();
  await expect(frame).toHaveCount(0, { timeout: 30_000 });
});
