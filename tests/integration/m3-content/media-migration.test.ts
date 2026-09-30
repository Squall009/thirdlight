/**
 * Media publication over the REAL transports. Audio refusals (what no
 * browser plays, what is not audio) are driven through the real
 * upload/inspect path and a refused source is asserted to write nothing.
 */
import { existsSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  ADMIN_TOKEN,
  AUTH_TOKEN,
  AUTHORING_ORIGIN,
  V2_AUTH_TOKEN,
  V2_PROJECT,
  V3_COPY_PROJECT,
  V3_PROJECT,
  cleanupBundles,
  createMcp,
  http,
  makeRoot,
  mediaBytes,
  mkRequestId,
  inspectViaHttp,
  publishArgs,
  spawnBackend,
  stopBackend,
  type BackendProcess,
  type DisposableRoot,
  type McpHarness,
} from './harness';

let root: DisposableRoot;
let bp: BackendProcess;
let mcp: McpHarness;

async function currentRevision(): Promise<number> {
  const res = await mcp.call('tl_inspect', { target: 'project' });
  expect(res.body.ok).toBe(true);
  return Number(res.body.revision);
}

beforeAll(async () => {
  root = makeRoot('media');
  bp = await spawnBackend(root, [
    { token: AUTH_TOKEN, scope: `authoring:${V3_PROJECT}` },
    { token: V2_AUTH_TOKEN, scope: `authoring:${V2_PROJECT}` },
    { token: ADMIN_TOKEN, scope: 'admin' },
  ]);
  mcp = await createMcp(bp.origin);
}, 90_000);

afterAll(async () => {
  cleanupBundles();
  await mcp?.close();
  if (bp) await stopBackend(bp);
  if (root) rmSync(root.root, { recursive: true, force: true });
}, 60_000);

describe('audio import through the real content route', () => {
  it('inspects and publishes a minimal PCM WAV with kind:"audio"', async () => {
    const inspected = await inspectViaHttp(bp.origin, V3_PROJECT, AUTH_TOKEN, mediaBytes('wav/cue-min.wav'), { kind: 'audio' });
    expect(inspected.status, JSON.stringify(inspected.body)).toBe(200);
    const proposal = (inspected.body as { proposal: Record<string, unknown> }).proposal;
    expect(proposal.status).toBe('ok');
    expect(proposal.kind).toBe('audio');
    expect((proposal.importRecipe as { profile?: string }).profile).toBe('audio');
    const rev = await currentRevision();
    const published = await mcp.call('tl_command', {
      op: 'publishAsset',
      args: publishArgs('create', 'asset-cue-0001', proposal, { kind: 'audio', displayName: 'Start cue' }),
      expectedRevision: rev,
      requestId: mkRequestId(),
    });
    expect(published.isError, JSON.stringify(published.body)).toBe(false);
    expect(published.body.revision).toBe(rev + 1);
  });

  it('refuses through the transport what no browser plays and what is not audio; takes any channels, rate and bit depth', async () => {
    // What the fixed short-sound profile refused and every browser plays is audio now.
    for (const file of ['wav/rejections/stereo.wav', 'wav/rejections/rate-44100.wav', 'wav/rejections/bit-depth-8.wav', 'wav/rejections/float32.wav', 'wav/rejections/oversized-pcm.wav']) {
      const res = await inspectViaHttp(bp.origin, V3_PROJECT, AUTH_TOKEN, mediaBytes(file), { kind: 'audio' });
      expect(res.status, `${file} is audio`).toBe(200);
    }
    const refused: [string, string][] = [
      ['wav/rejections/adpcm.wav', 'audio_format_unsupported'],
      ['wav/rejections/mulaw.wav', 'audio_format_unsupported'],
      ['wav/rejections/alaw.wav', 'audio_format_unsupported'],
      ['wav/rejections/zero-frames.wav', 'audio_empty'],
      ['wav/rejections/bad-magic.wav', 'audio_container_invalid'],
      ['wav/rejections/data-url.txt', 'audio_container_invalid'],
    ];
    for (const [file, code] of refused) {
      const res = await inspectViaHttp(bp.origin, V3_PROJECT, AUTH_TOKEN, mediaBytes(file), { kind: 'audio' });
      expect(res.status, `${file} must be refused`).toBe(400);
      const error = (res.body as { error?: { code?: string; diagnostics?: Array<{ code?: string }> } }).error ?? {};
      const codes = new Set<string>([String(error.code), ...((error.diagnostics ?? []).map((d) => String(d.code)))]);
      expect(codes.has(code), `${file}: expected ${code}, saw ${[...codes].join(',')}`).toBe(true);
    }
  });

  it('never publishes a rejected WAV blob (no durable effect)', async () => {
    const dir = join(root.v3Dir, 'sources', 'sha256');
    const before = existsSync(dir) ? readdirSync(dir).length : 0;
    const res = await inspectViaHttp(bp.origin, V3_PROJECT, AUTH_TOKEN, mediaBytes('wav/rejections/non-wav.bin'), { kind: 'audio' });
    expect(res.status).toBe(400);
    const after = existsSync(dir) ? readdirSync(dir).length : 0;
    expect(after).toBe(before);
  });
});
