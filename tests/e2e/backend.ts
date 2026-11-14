/**
 * Runs the real backend deployment bundle (dist/backend/backend.mjs) on free
 * ports with a throwaway data root, for browser end-to-end tests (the process
 * itself: tests/support/backend-process.ts), and the content-route helpers the
 * specs share.
 */
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { readRuntimeContentSync, type ExpandedRuntimeContent } from '@thirdlight/project-model';
import { launchBackend, REPO } from '../support/backend-process';
import { mustCommand, newRequestId, projectRevision } from '../support/commands';

/** Serve an export's folder statically on a free port (the backend can be stopped meanwhile). */
export { serveDir } from '../support/serve-dir';

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
  const proc = await launchBackend({
    dataRoot,
    exportRoot,
    token,
    // Every command the e2e suites send is held to the op table's declared records.
    env: { THIRDLIGHT_CHECK_OP_RECORDS: '1', ...extraEnv },
    startTimeoutMs: 15_000,
    killAfterMs: 5_000,
  });
  const { origin, halt } = proc;
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
    restart: proc.restart,
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
    await mustCommand(be, op, args, { clientId: 'e2e-shell' });
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
 * Take the sky out of a new project's scene. A new project has the physical
 * sky; a test that measures a feature by its pixels against the dark
 * background (a light's tint, a decal, particles, outlines, a cookie's
 * stripes) starts from a scene without one, so what it reads is the feature.
 * One command: the next revision, undoable like any edit.
 */
export async function withoutSky(be: E2EBackend, sceneId = 'scene-main', projectId = be.projectId): Promise<void> {
  await mustCommand(be, 'setEnvironment', { sceneId, environment: {} }, { clientId: 'e2e-sky', projectId });
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
  await mustCommand(
    be,
    'publishAsset',
    { mode: 'create', assetId, kind, displayName, sourceDigest: p['sourceDigest'], sourceByteLength: p['sourceByteLength'], ...(inspected.convertedFrom !== undefined ? { convertedFrom: inspected.convertedFrom } : {}), importRecipe: p['importRecipe'], metrics: p['metrics'], importedAt: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'), ...publish },
    { clientId: 'e2e-publish' },
  );
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
 * `entityId` (`ownedTransforms`: what it moves, e.g. '@self').
 */
export async function publishScript(be: E2EBackend, behaviorId: string, source: string, entityId: string, ownedTransforms: readonly string[] = []): Promise<void> {
  const headers = { authorization: `Bearer ${be.token}`, origin: be.origin };
  const base = `${be.origin}/api/v1/projects/${be.projectId}`;
  const run = async (op: string, args: Record<string, unknown>): Promise<void> => {
    await mustCommand(be, op, args, { clientId: 'e2e-script' });
  };
  const bytes = Buffer.from(`${JSON.stringify({ graphVersion: 1, entryPath: 'src/index.ts', requiredModules: ['@thirdlight/runtime'], ownedTransforms, files: [{ path: 'src/index.ts', text: source }] }, null, 2)}\n`);
  const stage = (await (await fetch(`${base}/content/stages`, { method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: '{}' })).json()) as { stageId: string };
  const put = await fetch(`${base}/content/stages/${stage.stageId}/bytes`, { method: 'PUT', headers: { ...headers, 'content-type': 'application/octet-stream', 'x-thirdlight-offset': '0', 'x-thirdlight-total': String(bytes.length) }, body: bytes });
  if (!put.ok) throw new Error(`publishScript ${behaviorId} upload: ${put.status}`);
  const declaration = { properties: [] };
  await run('publishBehavior', { behaviorId, displayName: behaviorId, mode: 'declaration-create', declaration });
  await run('acknowledgeBehaviorTrust', { sourceDigest: createHash('sha256').update(bytes).digest('hex') });
  const published = await fetch(`${base}/content/behaviors/source`, {
    method: 'POST',
    headers: { ...headers, 'content-type': 'application/json' },
    body: JSON.stringify({ stageId: stage.stageId, behaviorId, displayName: behaviorId, declaration, expectedRevision: await projectRevision(be), requestId: newRequestId() }),
  });
  if (published.status !== 200) throw new Error(`publishScript ${behaviorId}: ${published.status} ${(await published.text()).slice(0, 400)}`);
  await run('setBehaviorProperties', { entityId, behaviorId, values: {} });
}
