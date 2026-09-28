/**
 * Runs the real backend deployment bundle (dist/backend/backend.mjs) on free
 * ports with a throwaway data root, for browser end-to-end tests.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const REPO = resolve(import.meta.dirname, '..', '..');

export interface E2EBackend {
  origin: string;
  projectId: string;
  token: string;
  adminToken: string;
  /** The editor URL for the project (token passed once in the fragment). */
  editorUrl: string;
  /** Where the admin export route writes standalone builds. */
  exportRoot: string;
  /** The project's directory on disk (for external-edit tests). */
  projectDir: string;
  /** Stop the backend process but keep its data (e.g. to serve an export). */
  halt(): Promise<void>;
  /** POST an admin route; returns status + JSON. */
  admin(path: string, body?: unknown): Promise<{ status: number; json: Record<string, unknown> }>;
  /** Graceful stop (SIGTERM) then start again on the same ports and data. */
  restart(): Promise<void>;
  stop(): Promise<void>;
  /** POST a command envelope's JSON body as the given origin kind (e.g. MCP). */
  command(body: Record<string, unknown>): Promise<Record<string, unknown>>;
}

function freePort(): Promise<number> {
  return new Promise((ok, fail) => {
    const s = createServer();
    s.once('error', fail);
    s.listen(0, '127.0.0.1', () => {
      const port = (s.address() as { port: number }).port;
      s.close(() => ok(port));
    });
  });
}

export async function startBackend(projectId = 'e2e-0001', template?: string, extraEnv: Record<string, string> = {}): Promise<E2EBackend> {
  const dataRoot = mkdtempSync(join(tmpdir(), 'tl-e2e-'));
  const exportRoot = mkdtempSync(join(tmpdir(), 'tl-e2e-export-'));
  const [authPort, previewPort] = [await freePort(), await freePort()];
  const origin = `http://127.0.0.1:${authPort}`;
  const previewOrigin = `http://127.0.0.1:${previewPort}`;
  // One owner token covers the project routes and the admin routes.
  const token = `e2e-owner-${Math.random().toString(16).slice(2)}${Math.random().toString(16).slice(2)}`;
  const adminToken = token;
  const env = {
    ...process.env,
    THIRDLIGHT_DATA_ROOT: dataRoot,
    THIRDLIGHT_AUTHORING_ORIGIN: origin,
    THIRDLIGHT_PREVIEW_ORIGIN: previewOrigin,
    THIRDLIGHT_AUTHORING_BIND: `127.0.0.1:${authPort}`,
    THIRDLIGHT_PREVIEW_BIND: `127.0.0.1:${previewPort}`,
    THIRDLIGHT_AUTHORING_ORIGINS: origin,
    THIRDLIGHT_EDITOR_DIR: join(REPO, 'dist', 'editor'),
    THIRDLIGHT_PREVIEW_DIR: join(REPO, 'dist', 'preview'),
    THIRDLIGHT_OWNER_TOKEN: token,
    THIRDLIGHT_EXPORT_ROOT: exportRoot,
    THIRDLIGHT_ENGINE_ROOT: REPO,
    // Phase 11: no headless editor unless a test asks for one.
    THIRDLIGHT_HEADLESS: 'off',
    ...extraEnv,
  };

  let proc: ChildProcess | null = null;
  const launch = async (): Promise<void> => {
    const child = spawn(process.execPath, [join(REPO, 'dist', 'backend', 'backend.mjs')], { env, stdio: ['ignore', 'ignore', 'pipe'] });
    proc = child;
    let log = '';
    await new Promise<void>((ok, fail) => {
      const timer = setTimeout(() => fail(new Error(`backend did not start: ${log}`)), 15_000);
      child.stderr!.on('data', (d: Buffer) => {
        log += d.toString();
        if (log.includes('listening')) {
          clearTimeout(timer);
          ok();
        }
      });
      child.once('exit', (code) => {
        clearTimeout(timer);
        fail(new Error(`backend exited (${code}): ${log}`));
      });
    });
  };
  const halt = async (): Promise<void> => {
    const p = proc;
    proc = null;
    if (!p || p.exitCode !== null) return;
    const exited = new Promise<void>((ok) => p.once('exit', () => ok()));
    p.kill('SIGTERM');
    const timer = setTimeout(() => p.kill('SIGKILL'), 5_000);
    await exited;
    clearTimeout(timer);
  };

  await launch();
  const created = await fetch(`${origin}/api/v1/admin/projects`, {
    method: 'POST',
    headers: { authorization: `Bearer ${adminToken}`, 'content-type': 'application/json' },
    body: JSON.stringify({ projectId, name: 'E2E Project', ...(template !== undefined ? { template } : {}) }),
  });
  if (!created.ok) throw new Error(`project create failed: ${created.status} ${await created.text()}`);

  return {
    origin,
    projectId,
    token,
    adminToken,
    editorUrl: `${origin}/?project=${projectId}#token=${token}`,
    exportRoot,
    projectDir: join(dataRoot, 'projects', projectId),
    halt,
    admin: async (path, body = {}) => {
      const r = await fetch(`${origin}/api/v1/admin/${path}`, {
        method: 'POST',
        headers: { authorization: `Bearer ${adminToken}`, 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      return { status: r.status, json: (await r.json()) as Record<string, unknown> };
    },
    restart: async () => {
      await halt();
      await launch();
    },
    stop: async () => {
      await halt();
      rmSync(dataRoot, { recursive: true, force: true });
      rmSync(exportRoot, { recursive: true, force: true });
    },
    command: async (body) => {
      const r = await fetch(`${origin}/api/v1/projects/${projectId}/commands`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', origin },
        body: JSON.stringify(body),
      });
      return (await r.json()) as Record<string, unknown>;
    },
  };
}

/**
 * Phase 24.2: the starter template's fixed ids (templates/starter; the
 * character is `model-0001`, its spawn `spawn-0001`, the camera `cam-main`).
 */
export const STARTER = { playerId: 'model-0001', spawnId: 'spawn-0001', cameraId: 'cam-main', groundId: 'box-0001', pillarId: 'model-0002' } as const;

/**
 * Phase 24.2: give a starter project the platformer game block (the run
 * session: awaiting start, deaths, respawn, the HUD) with what the block
 * requires: a following camera and a goal zone (placed out of reach). The
 * starter itself has no game rules; a test whose generic subject still needs
 * the session's run states calls this. Goes away with the block (phase
 * 24.6/24.7).
 */
export async function addGameSession(be: E2EBackend, extra: Record<string, unknown> = {}): Promise<void> {
  const run = async (op: string, args: Record<string, unknown>): Promise<void> => {
    const q = await be.command({ op: 'queryProject', projectId: be.projectId, args: {} });
    const r = await be.command({ op, projectId: be.projectId, expectedRevision: Number(q['revision']), requestId: `req-${randomUUID().replace(/-/g, '')}`, origin: { kind: 'mcp', clientId: 'e2e-session' }, args });
    if (r['ok'] !== true) throw new Error(`addGameSession ${op}: ${JSON.stringify(r).slice(0, 400)}`);
  };
  // The session's camera follows the player (no bounds: an open world).
  await run('setComponent', { entityId: STARTER.cameraId, component: 'cameraFollow', value: { deadZone: { x: 0.5, y: 0.5 }, smoothing: 0.2 } });
  // The block requires a goal zone somewhere in the project: one far out of reach.
  await run('createEntity', { kind: 'group', name: 'Session goal', transform: { position: [500, -100, 0] }, components: { gameZone: { role: 'goal', size: [1, 1] } } });
  await run('setGameConfig', {
    game: {
      configVersion: 2,
      title: 'Test game',
      objective: 'Play the scene',
      instructions: 'Arrow keys or A / D to move, Space to jump.',
      playerId: STARTER.playerId,
      cameraId: STARTER.cameraId,
      spawnId: STARTER.spawnId,
      cues: { start: null, jump: null, checkpoint: null, death: null, goal: null },
      ...extra,
    },
  });
}

/**
 * Phase 24.2: publish one of the WAV fixtures (`fixtures/m3/media/wav/<file>`)
 * as a project audio asset through the real content route (stage, upload,
 * inspect, publishAsset); returns the asset id. The starter has no audio.
 */
export async function publishWav(be: E2EBackend, file: string, assetId: string, displayName: string): Promise<string> {
  const bytes = readFileSync(join(REPO, 'fixtures', 'm3', 'media', 'wav', file));
  const headers = { authorization: `Bearer ${be.token}`, origin: be.origin };
  const base = `${be.origin}/api/v1/projects/${be.projectId}/content/stages`;
  const stage = (await (await fetch(base, { method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: '{}' })).json()) as { stageId: string };
  const put = await fetch(`${base}/${stage.stageId}/bytes`, { method: 'PUT', headers: { ...headers, 'content-type': 'application/octet-stream', 'x-thirdlight-offset': '0', 'x-thirdlight-total': String(bytes.length) }, body: bytes });
  if (!put.ok) throw new Error(`publishWav upload: ${put.status}`);
  const inspected = (await (await fetch(`${base}/${stage.stageId}/inspect`, { method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify({ kind: 'audio' }) })).json()) as { proposal?: Record<string, unknown> };
  const p = inspected.proposal;
  if (p === undefined) throw new Error(`publishWav inspect: ${JSON.stringify(inspected).slice(0, 300)}`);
  const q = await be.command({ op: 'queryProject', projectId: be.projectId, args: {} });
  const r = await be.command({
    op: 'publishAsset',
    projectId: be.projectId,
    expectedRevision: Number(q['revision']),
    requestId: `req-${randomUUID().replace(/-/g, '')}`,
    origin: { kind: 'mcp', clientId: 'e2e-wav' },
    args: { mode: 'create', assetId, kind: 'audio', displayName, sourceDigest: p['sourceDigest'], sourceByteLength: p['sourceByteLength'], importRecipe: p['importRecipe'], metrics: p['metrics'], importedAt: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z') },
  });
  if (r['ok'] !== true) throw new Error(`publishWav publish: ${JSON.stringify(r).slice(0, 400)}`);
  return assetId;
}
