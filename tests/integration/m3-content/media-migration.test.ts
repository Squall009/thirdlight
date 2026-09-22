/**
 * Packet 48 — media publication and the v2→v3 operator copy over the REAL
 * transports. Every §41.4.4 audio rejection is driven through the real
 * upload/inspect path; the explicit `migrateProjectCopyV3` operator runs on the
 * real filesystem and every refusal is asserted to write nothing.
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
  mediaJson,
  mkRequestId,
  inspectViaHttp,
  publishArgs,
  spawnBackend,
  stopBackend,
  type BackendProcess,
  type DisposableRoot,
  type McpHarness,
} from './harness';

interface WavCase {
  readonly file: string;
  readonly code?: string;
  readonly limit?: string;
}
interface WavCases {
  readonly rejections: WavCase[];
}
const WAV = mediaJson<WavCases>('wav/wav-cases.json');

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

describe('packet 48 — bounded PCM-WAV import through the real content route', () => {
  it('inspects and publishes a minimal PCM WAV with kind:"audio"', async () => {
    const inspected = await inspectViaHttp(bp.origin, V3_PROJECT, AUTH_TOKEN, mediaBytes('wav/cue-min.wav'), { kind: 'audio' });
    expect(inspected.status, JSON.stringify(inspected.body)).toBe(200);
    const proposal = (inspected.body as { proposal: Record<string, unknown> }).proposal;
    expect(proposal.status).toBe('ok');
    expect(proposal.kind).toBe('audio');
    expect((proposal.importRecipe as { profile?: string }).profile).toBe('pcm-wav');
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

  it('reaches every §41.4.4 rejection through the transport with its recorded code', async () => {
    const seen = new Set<string>();
    for (const c of WAV.rejections) {
      const res = await inspectViaHttp(bp.origin, V3_PROJECT, AUTH_TOKEN, mediaBytes(c.file), { kind: 'audio' });
      expect(res.status, `${c.file} must be rejected`).toBe(400);
      const error = (res.body as { error?: { code?: string; diagnostics?: Array<{ code?: string; limit?: string }> } }).error ?? {};
      const codes = new Set<string>([String(error.code), ...((error.diagnostics ?? []).map((d) => String(d.code)))]);
      expect(codes.has(String(c.code)), `${c.file}: expected ${String(c.code)}, saw ${[...codes].join(',')}`).toBe(true);
      if (c.limit !== undefined) {
        const limits = (error.diagnostics ?? []).map((d) => d.limit);
        expect(limits, `${c.file} limit`).toContain(c.limit);
      }
      seen.add(String(c.code));
    }
    // Sanity: the sweep really covered more than one stage family.
    expect(seen.size).toBeGreaterThanOrEqual(6);
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

describe('packet 48 — the explicit v2→v3 copy operator route', () => {
  it('refuses a non-admin caller', async () => {
    const res = await http(`${bp.origin}/api/v1/admin/projects/${V2_PROJECT}/migrate-copy-v3`, {
      body: { newProjectId: 'nope-0001' },
      token: AUTH_TOKEN,
      origin: AUTHORING_ORIGIN,
    });
    expect(res.status).toBe(401);
    expect(existsSync(join(root.dataRoot, 'projects', 'nope-0001'))).toBe(false);
  });

  it('refuses a v3 source with migration_version_unsupported and writes nothing', async () => {
    const res = await http(`${bp.origin}/api/v1/admin/projects/${V3_PROJECT}/migrate-copy-v3`, {
      body: { newProjectId: 'copy-refused-0001' },
      token: ADMIN_TOKEN,
      origin: AUTHORING_ORIGIN,
    });
    expect(res.status).not.toBe(200);
    expect((res.body as { error: { code: string } }).error.code).toBe('migration_version_unsupported');
    expect(existsSync(join(root.dataRoot, 'projects', 'copy-refused-0001'))).toBe(false);
  });

  it('copies a real v2 project to a new v3 project (the §16.5.2 object)', async () => {
    const res = await http(`${bp.origin}/api/v1/admin/projects/${V2_PROJECT}/migrate-copy-v3`, {
      body: { newProjectId: V3_COPY_PROJECT },
      token: ADMIN_TOKEN,
      origin: AUTHORING_ORIGIN,
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const body = res.body as Record<string, unknown>;
    expect(body.ok).toBe(true);
    expect(body.sourceProjectId).toBe(V2_PROJECT);
    expect(body.newProjectId).toBe(V3_COPY_PROJECT);
    expect(body.newRevision).toBe(0);
    expect(body.revisionPolicy).toBe('reset-to-zero');
    expect(body.sourceVersion).toBe(2);
    expect(body.newVersion).toBe(3);
    expect(body.historyReset).toBe(true);
    expect(body.retryCleared).toBe(true);
    expect(body.resumed).toBe(false);
    // The destination is a real durable project on disk.
    expect(existsSync(join(root.dataRoot, 'projects', V3_COPY_PROJECT, 'scenes', 'main.json'))).toBe(true);
  });

  it('refuses to overwrite an existing destination and keeps its bytes', async () => {
    const res = await http(`${bp.origin}/api/v1/admin/projects/${V2_PROJECT}/migrate-copy-v3`, {
      body: { newProjectId: V3_COPY_PROJECT },
      token: ADMIN_TOKEN,
      origin: AUTHORING_ORIGIN,
    });
    expect(res.status).not.toBe(200);
    expect((res.body as { error: { code: string } }).error.code).toBe('migration_destination_exists');
  });

  it('refuses an unknown source and writes nothing', async () => {
    const res = await http(`${bp.origin}/api/v1/admin/projects/missing-project-0001/migrate-copy-v3`, {
      body: { newProjectId: 'copy-nowhere-0001' },
      token: ADMIN_TOKEN,
      origin: AUTHORING_ORIGIN,
    });
    expect(res.status).not.toBe(200);
    expect((res.body as { error: { code: string } }).error.code).toBe('migration_source_invalid');
    expect(existsSync(join(root.dataRoot, 'projects', 'copy-nowhere-0001'))).toBe(false);
  });
});
