/**
 * Phase 21.1: the real backend bundle (dist/backend/backend.mjs) on free
 * ports over a given data root (under ~/.cache/thirdlight-perf/, never /tmp:
 * the large benchmark is big), with small HTTP helpers for the command API
 * and the content routes. The same process shape as tests/e2e/backend.ts.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { createServer } from 'node:net';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

export const REPO = resolve(import.meta.dirname, '..', '..');
/** Where benchmark projects, runs and reports live. */
export const PERF_ROOT = process.env['TL_PERF_ROOT'] ?? join(homedir(), '.cache', 'thirdlight-perf');

export interface PerfBackend {
  origin: string;
  previewOrigin: string;
  token: string;
  dataRoot: string;
  exportRoot: string;
  /** POST JSON to a path under the origin (project token, editor origin). */
  post(path: string, body: unknown): Promise<{ status: number; json: Record<string, unknown> }>;
  get(path: string): Promise<{ status: number; body: Buffer }>;
  /** Upload bytes into a new stage in frames of at most 1 MiB; returns the stage id. */
  stage(projectId: string, bytes: Uint8Array): Promise<string>;
  project(projectId: string): ProjectClient;
  stop(): Promise<void>;
}

export interface ProjectClient {
  projectId: string;
  query(op: string, args?: Record<string, unknown>): Promise<Record<string, unknown>>;
  /** One mutation at the current revision; throws when it is refused (a `no_change` counts as done). */
  command(op: string, args: Record<string, unknown>): Promise<Record<string, unknown>>;
  revision(): Promise<number>;
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

const FRAME = 1 << 20;

export async function startPerfBackend(dataRoot: string, exportRoot = join(dataRoot, '..', `${dataRoot.split('/').pop()}-exports`)): Promise<PerfBackend> {
  mkdirSync(dataRoot, { recursive: true });
  mkdirSync(exportRoot, { recursive: true });
  const [authPort, previewPort] = [await freePort(), await freePort()];
  const origin = `http://127.0.0.1:${authPort}`;
  const previewOrigin = `http://127.0.0.1:${previewPort}`;
  const token = `perf-${randomBytes(24).toString('hex')}`;
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
    THIRDLIGHT_HEADLESS: 'off',
  };
  const child: ChildProcess = spawn(process.execPath, [join(REPO, 'dist', 'backend', 'backend.mjs')], { env, stdio: ['ignore', 'ignore', 'pipe'] });
  let log = '';
  await new Promise<void>((ok, fail) => {
    const timer = setTimeout(() => fail(new Error(`backend did not start: ${log}`)), 30_000);
    child.stderr!.on('data', (d: Buffer) => {
      log += d.toString();
      if (log.length > 20_000) log = log.slice(-10_000);
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
  const headers = { authorization: `Bearer ${token}`, origin };
  const post = async (path: string, body: unknown): Promise<{ status: number; json: Record<string, unknown> }> => {
    const r = await fetch(`${origin}${path}`, { method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const text = await r.text();
    let json: Record<string, unknown>;
    try {
      json = JSON.parse(text) as Record<string, unknown>;
    } catch {
      json = { raw: text.slice(0, 500) };
    }
    return { status: r.status, json };
  };
  const stage = async (projectId: string, bytes: Uint8Array): Promise<string> => {
    const created = await post(`/api/v1/projects/${projectId}/content/stages`, {});
    const stageId = created.json['stageId'];
    if (typeof stageId !== 'string') throw new Error(`stage create failed: ${JSON.stringify(created.json)}`);
    for (let offset = 0; offset < bytes.length; offset += FRAME) {
      const frame = bytes.subarray(offset, Math.min(bytes.length, offset + FRAME));
      const put = await fetch(`${origin}/api/v1/projects/${projectId}/content/stages/${stageId}/bytes`, {
        method: 'PUT',
        headers: { ...headers, 'content-type': 'application/octet-stream', 'x-thirdlight-offset': String(offset), 'x-thirdlight-total': String(bytes.length) },
        body: frame as Uint8Array<ArrayBuffer>,
      });
      if (put.status !== 200) throw new Error(`stage upload failed at ${offset}: ${put.status} ${(await put.text()).slice(0, 300)}`);
    }
    return stageId;
  };
  let seq = 0;
  const project = (projectId: string): ProjectClient => {
    let rev: number | null = null;
    const query = async (op: string, args: Record<string, unknown> = {}): Promise<Record<string, unknown>> => (await post(`/api/v1/projects/${projectId}/commands`, { op, projectId, args })).json;
    const revision = async (): Promise<number> => {
      rev = Number((await query('queryProject'))['revision']);
      return rev;
    };
    const command = async (op: string, args: Record<string, unknown>): Promise<Record<string, unknown>> => {
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const expectedRevision = rev ?? (await revision());
        seq += 1;
        const requestId = `req-${createHash('sha256').update(`${token}:${seq}`).digest('hex').slice(0, 32)}`;
        const res = (await post(`/api/v1/projects/${projectId}/commands`, { op, projectId, expectedRevision, requestId, origin: { kind: 'mcp', clientId: 'perf-harness' }, args })).json;
        if (res['ok'] === true) {
          rev = Number(res['revision']);
          return res;
        }
        const code = (res['error'] as { code?: string } | undefined)?.code;
        if (code === 'no_change') return res;
        // Someone else moved the revision (the editor open on the project): read it and try once more.
        if (code === 'revision_conflict') {
          rev = null;
          continue;
        }
        throw new Error(`${op} refused: ${JSON.stringify(res).slice(0, 600)}`);
      }
      throw new Error(`${op}: revision kept moving`);
    };
    return { projectId, query, command, revision };
  };
  return {
    origin,
    previewOrigin,
    token,
    dataRoot,
    exportRoot,
    post,
    get: async (path) => {
      const r = await fetch(`${origin}${path}`, { headers });
      return { status: r.status, body: Buffer.from(await r.arrayBuffer()) };
    },
    stage,
    project,
    stop: async () => {
      if (child.exitCode !== null) return;
      const exited = new Promise<void>((ok) => child.once('exit', () => ok()));
      child.kill('SIGTERM');
      const timer = setTimeout(() => child.kill('SIGKILL'), 10_000);
      await exited;
      clearTimeout(timer);
    },
  };
}
