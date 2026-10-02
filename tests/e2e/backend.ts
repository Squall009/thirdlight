/**
 * Runs the real backend deployment bundle (dist/backend/backend.mjs) on free
 * ports with a throwaway data root, for browser end-to-end tests.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { extname, join, normalize, resolve } from 'node:path';

import { readRuntimeContentSync, type ExpandedRuntimeContent } from '@thirdlight/project-model';
import { launchOnFreePorts, type BackendPorts } from '../../tools/perf/ports';

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

export async function startBackend(projectId = 'e2e-0001', template?: string, extraEnv: Record<string, string> = {}): Promise<E2EBackend> {
  const dataRoot = mkdtempSync(join(tmpdir(), 'tl-e2e-'));
  const exportRoot = mkdtempSync(join(tmpdir(), 'tl-e2e-export-'));
  // One owner token covers the project routes and the admin routes.
  const token = `e2e-owner-${Math.random().toString(16).slice(2)}${Math.random().toString(16).slice(2)}`;
  const adminToken = token;
  const envFor = (ports: BackendPorts): NodeJS.ProcessEnv => {
    const origin = `http://127.0.0.1:${ports.authoring}`;
    return {
      ...process.env,
      THIRDLIGHT_DATA_ROOT: dataRoot,
      THIRDLIGHT_AUTHORING_ORIGIN: origin,
      THIRDLIGHT_PREVIEW_ORIGIN: `http://127.0.0.1:${ports.preview}`,
      THIRDLIGHT_AUTHORING_BIND: `127.0.0.1:${ports.authoring}`,
      THIRDLIGHT_PREVIEW_BIND: `127.0.0.1:${ports.preview}`,
      THIRDLIGHT_AUTHORING_ORIGINS: origin,
      THIRDLIGHT_EDITOR_DIR: join(REPO, 'dist', 'editor'),
      THIRDLIGHT_PREVIEW_DIR: join(REPO, 'dist', 'preview'),
      THIRDLIGHT_OWNER_TOKEN: token,
      THIRDLIGHT_EXPORT_ROOT: exportRoot,
      THIRDLIGHT_ENGINE_ROOT: REPO,
      // No headless editor unless a test asks for one.
      THIRDLIGHT_HEADLESS: 'off',
      ...extraEnv,
    };
  };

  let proc: ChildProcess | null = null;
  const launch = async (env: NodeJS.ProcessEnv): Promise<void> => {
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

  // The ports are fixed for the backend's life: a restart binds them again (the page's URL names them).
  const { ports } = await launchOnFreePorts((p) => launch(envFor(p)));
  const env = envFor(ports);
  const origin = `http://127.0.0.1:${ports.authoring}`;
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
      await launch(env);
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
 * The starter template's fixed ids (templates/starter; the
 * character is `model-0001`, its spawn `spawn-0001`, the camera `cam-main`).
 */
export const STARTER = { playerId: 'model-0001', spawnId: 'spawn-0001', cameraId: 'cam-main', groundId: 'box-0001', pillarId: 'model-0002' } as const;

/**
 * The generic "wait for the player to start": a game shell whose
 * title screen (a small corner panel with a Start button, so the scene stays
 * visible) holds the engine pause until Start (`[data-tl-ui-doc="start-title"]
 * [data-widget="start"]`). With `hud`, a HUD document shows that text (its
 * `{$flow.counters.<name>}` bindings read the named counters) as
 * `[data-tl-ui-doc="start-hud"] [data-widget="line"]`. For tests whose
 * subject is generic and that need a start screen or a HUD.
 */
export async function addTitleShell(be: E2EBackend, hud?: string): Promise<void> {
  const run = async (op: string, args: Record<string, unknown>): Promise<void> => {
    const q = await be.command({ op: 'queryProject', projectId: be.projectId, args: {} });
    const r = await be.command({ op, projectId: be.projectId, expectedRevision: Number(q['revision']), requestId: `req-${randomUUID().replace(/-/g, '')}`, origin: { kind: 'mcp', clientId: 'e2e-shell' }, args });
    if (r['ok'] !== true) throw new Error(`addTitleShell ${op}: ${JSON.stringify(r).slice(0, 400)}`);
  };
  const corner = { anchor: [0, 0], pivot: [0, 0], offset: [12, 12] };
  await run('setUiDocument', { document: { uiDocumentId: 'start-title', name: 'Start', root: { type: 'panel', ...corner, size: [180, 56], css: { background: '#203040', padding: 6 }, children: [
    { type: 'button', id: 'start', size: [160, 40], text: 'Start', css: { color: '#ffffff', background: '#406080', fontSize: 18 }, onClick: { do: 'engine', action: 'newGame' } },
  ] } } });
  if (hud !== undefined) {
    await run('setUiDocument', { document: { uiDocumentId: 'start-hud', name: 'Status', root: { type: 'panel', ...corner, size: [260, 40], css: { background: '#203040', padding: 6 }, children: [
      { type: 'text', id: 'line', text: hud, css: { color: '#ffffff', fontSize: 18 } },
    ] } } });
  }
  await run('setShell', { shell: { screens: { title: 'start-title' }, ...(hud !== undefined ? { hud: ['start-hud'] } : {}) } });
}

/**
 * Publish one of the WAV fixtures (`fixtures/m3/media/wav/<file>`)
 * as a project audio asset through the real content route (stage, upload,
 * inspect, publishAsset); returns the asset id. The starter has no audio.
 */
export async function publishWav(be: E2EBackend, file: string, assetId: string, displayName: string): Promise<string> {
  return publishBytes(be, readFileSync(join(REPO, 'fixtures', 'm3', 'media', 'wav', file)), 'audio', assetId, displayName);
}

/**
 * Publish bytes as a project asset of `kind` (model, texture, audio …) through the real content route; returns the asset id.
 * `inspect` adds import options to the inspection (`{ ktx2: 'color' }` encodes a texture to KTX2, recorded as converted).
 */
export async function publishBytes(be: E2EBackend, bytes: Uint8Array, kind: string, assetId: string, displayName = assetId, inspect: Record<string, unknown> = {}, publish: Record<string, unknown> = {}): Promise<string> {
  const headers = { authorization: `Bearer ${be.token}`, origin: be.origin };
  const base = `${be.origin}/api/v1/projects/${be.projectId}/content/stages`;
  const stage = (await (await fetch(base, { method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: '{}' })).json()) as { stageId: string };
  const put = await fetch(`${base}/${stage.stageId}/bytes`, { method: 'PUT', headers: { ...headers, 'content-type': 'application/octet-stream', 'x-thirdlight-offset': '0', 'x-thirdlight-total': String(bytes.length) }, body: bytes });
  if (!put.ok) throw new Error(`publish ${assetId} upload: ${put.status}`);
  const inspected = (await (await fetch(`${base}/${stage.stageId}/inspect`, { method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify({ ...inspect, kind }) })).json()) as { proposal?: Record<string, unknown>; convertedFrom?: Record<string, unknown> };
  const p = inspected.proposal;
  if (p === undefined) throw new Error(`publish ${assetId} inspect: ${JSON.stringify(inspected).slice(0, 300)}`);
  const q = await be.command({ op: 'queryProject', projectId: be.projectId, args: {} });
  const r = await be.command({
    op: 'publishAsset',
    projectId: be.projectId,
    expectedRevision: Number(q['revision']),
    requestId: `req-${randomUUID().replace(/-/g, '')}`,
    origin: { kind: 'mcp', clientId: 'e2e-publish' },
    args: { mode: 'create', assetId, kind, displayName, sourceDigest: p['sourceDigest'], sourceByteLength: p['sourceByteLength'], ...(inspected.convertedFrom !== undefined ? { convertedFrom: inspected.convertedFrom } : {}), importRecipe: p['importRecipe'], metrics: p['metrics'], importedAt: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'), ...publish },
  });
  if (r['ok'] !== true) throw new Error(`publish ${assetId}: ${JSON.stringify(r).slice(0, 400)}`);
  return assetId;
}

/**
 * An input-exercise frame's character controls as named actions
 * (input frame version 2 has no fixed moveX/moveY/jump channels): `move`
 * ({v}, or {v, x, y} with a forward axis) and `jump` ({v, p}), the actions
 * the character controller reads by default.
 */
export function controls(moveX: number, jump: 'none' | 'pressed' | 'held' | 'released' = 'none', moveY?: number): { actions: Record<string, { v: number; x?: number; y?: number; p: string }> } {
  return {
    actions: {
      move: moveY !== undefined ? { v: moveX, x: moveX, y: moveY, p: 'none' } : { v: moveX, p: 'none' },
      jump: { v: jump === 'pressed' || jump === 'held' ? 1 : 0, p: jump },
    },
  };
}

/**
 * An export's content read whole from its folder: the manifest, then every
 * file of its catalog, each checked against its row (the blocks under their
 * keys, every catalog entry as `assets`).
 */
export function exportedContent(outDir: string): ExpandedRuntimeContent {
  return readRuntimeContentSync(JSON.parse(readFileSync(join(outDir, 'manifest.json'), 'utf8')), (path) => {
    try {
      return new Uint8Array(readFileSync(join(outDir, path)));
    } catch {
      return null;
    }
  });
}

/**
 * Publish a TypeScript behavior (no properties) through the real content
 * route (stage, upload, declaration, trust, source) and attach it to
 * `entityId`.
 */
export async function publishScript(be: E2EBackend, behaviorId: string, source: string, entityId: string): Promise<void> {
  const headers = { authorization: `Bearer ${be.token}`, origin: be.origin };
  const base = `${be.origin}/api/v1/projects/${be.projectId}`;
  const run = async (op: string, args: Record<string, unknown>): Promise<void> => {
    const q = await be.command({ op: 'queryProject', projectId: be.projectId, args: {} });
    const r = await be.command({ op, projectId: be.projectId, expectedRevision: Number(q['revision']), requestId: `req-${randomUUID().replace(/-/g, '')}`, origin: { kind: 'mcp', clientId: 'e2e-script' }, args });
    if (r['ok'] !== true) throw new Error(`publishScript ${op}: ${JSON.stringify(r).slice(0, 400)}`);
  };
  const bytes = Buffer.from(`${JSON.stringify({ graphVersion: 1, entryPath: 'src/index.ts', requiredModules: ['@thirdlight/runtime'], ownedTransforms: [], files: [{ path: 'src/index.ts', text: source }] }, null, 2)}\n`);
  const stage = (await (await fetch(`${base}/content/stages`, { method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: '{}' })).json()) as { stageId: string };
  const put = await fetch(`${base}/content/stages/${stage.stageId}/bytes`, { method: 'PUT', headers: { ...headers, 'content-type': 'application/octet-stream', 'x-thirdlight-offset': '0', 'x-thirdlight-total': String(bytes.length) }, body: bytes });
  if (!put.ok) throw new Error(`publishScript ${behaviorId} upload: ${put.status}`);
  const declaration = { properties: [] };
  await run('publishBehavior', { behaviorId, displayName: behaviorId, mode: 'declaration-create', declaration });
  await run('acknowledgeBehaviorTrust', { sourceDigest: createHash('sha256').update(bytes).digest('hex') });
  const q = await be.command({ op: 'queryProject', projectId: be.projectId, args: {} });
  const published = await fetch(`${base}/content/behaviors/source`, {
    method: 'POST',
    headers: { ...headers, 'content-type': 'application/json' },
    body: JSON.stringify({ stageId: stage.stageId, behaviorId, displayName: behaviorId, declaration, expectedRevision: Number(q['revision']), requestId: `req-${randomUUID().replace(/-/g, '')}` }),
  });
  if (published.status !== 200) throw new Error(`publishScript ${behaviorId}: ${published.status} ${(await published.text()).slice(0, 400)}`);
  await run('setBehaviorProperties', { entityId, behaviorId, values: {} });
}

/** Serve an export's folder statically on a free port (the backend can be stopped meanwhile). */
export function serveDir(root: string): Promise<{ url: string; close: () => Promise<void> }> {
  const MIME: Record<string, string> = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json', '.wasm': 'application/wasm' };
  const server: Server = createServer((req, res) => {
    const rel = normalize(decodeURIComponent((req.url ?? '/').split('?')[0]!)).replace(/^\/+/, '') || 'index.html';
    const file = join(root, rel);
    if (!file.startsWith(root) || !existsSync(file) || !statSync(file).isFile()) {
      res.statusCode = 404;
      res.end();
      return;
    }
    res.setHeader('content-type', MIME[extname(file)] ?? 'application/octet-stream');
    createReadStream(file).pipe(res);
  });
  return new Promise((ok) => server.listen(0, '127.0.0.1', () => ok({ url: `http://127.0.0.1:${(server.address() as { port: number }).port}/`, close: () => new Promise((d) => server.close(() => d())) })));
}
