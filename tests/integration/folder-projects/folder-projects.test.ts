/**
 * A project in a game folder, as an agent and the project tool reach it, over
 * HTTP against a real backend in Node (no browser):
 *
 * - an MCP client started inside the game (a subfolder) finds the project from
 *   its folder, reads it and edits it, and the edit lands in the game folder;
 * - outside any project folder, and in a folder whose marker the backend does
 *   not know, the answer says what to do;
 * - `tools/project.mjs` lists the folder project and exports it addressed by
 *   its folder;
 * - a marker pinned to another engine version is flagged in the project list,
 *   never refused, and `project.mjs check` names the mismatch.
 */
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { testTempBase } from '@thirdlight/backend/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { api, startBackend, type TestBackend } from '../../../packages/backend/src/test-helpers';
import { BackendClient } from '../../../packages/mcp-adapter/src/backend-client';
import { folderContextProvider } from '../../../packages/mcp-adapter/src/index';
import { createMcpServer } from '../../../packages/mcp-adapter/src/server';

const REPO = resolve(import.meta.dirname, '..', '..', '..');
const PROJECT_TOOL = join(REPO, 'tools', 'project.mjs');
const run = promisify(execFile);

/** project.mjs as a child process; awaited, so the in-process backend keeps answering. */
async function projectTool(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    const r = await run(process.execPath, [PROJECT_TOOL, ...args], { cwd: REPO, encoding: 'utf8' });
    return { code: 0, stdout: r.stdout, stderr: r.stderr };
  } catch (e) {
    const err = e as { code?: number; stdout?: string; stderr?: string };
    return { code: typeof err.code === 'number' ? err.code : -1, stdout: err.stdout ?? '', stderr: err.stderr ?? '' };
  }
}

describe('a project in a game folder, through MCP and the project tool', () => {
  let tb: TestBackend;
  let exportRoot: string;
  let games: string;
  const closers: Array<() => Promise<void>> = [];
  beforeAll(async () => {
    exportRoot = mkdtempSync(join(testTempBase(), 'tl-folder-projects-export-'));
    tb = await startBackend({ exportRoot, engineRoot: REPO });
    // The game folders are siblings of the data root, never inside it.
    games = join(tb.root, 'games');
    mkdirSync(games);
  }, 60_000);
  afterAll(async () => {
    for (const c of closers) await c();
    await tb.teardown();
    rmSync(exportRoot, { recursive: true, force: true });
  }, 60_000);

  /** An MCP client whose harness runs in `cwd` with no project id (the owner token). */
  const connect = async (cwd: string) => {
    const auth = new BackendClient({ authoringOrigin: tb.authUrl, token: tb.adminToken });
    const server = createMcpServer(folderContextProvider(auth, { origin: tb.authUrl, cwd, clientId: 'folder-projects' }));
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await server.connect(st);
    const client = new Client({ name: 'folder-projects', version: '0.0.0' });
    await client.connect(ct);
    closers.push(() => ct.close(), () => server.close());
    return async (name: string, args: Record<string, unknown>) => {
      const res = (await client.callTool({ name, arguments: args })) as { isError?: boolean; content: Array<{ text: string }> };
      return { isError: res.isError === true, text: res.content[0]!.text };
    };
  };

  it('finds the project from a subfolder, edits it into the game folder; lists and exports it by folder; flags another engine pin', async () => {
    const mine = join(games, 'mine');
    const made = await api(`${tb.authUrl}/api/v1/admin/projects`, { body: { projectId: 'mine', name: 'Mine', folder: mine, template: 'starter' }, token: tb.adminToken, origin: null });
    expect(made.status, JSON.stringify(made.json)).toBe(201);
    const deep = join(mine, 'src', 'levels');
    mkdirSync(deep, { recursive: true });
    const stray = join(games, 'stray');
    mkdirSync(stray);

    const inside = await connect(deep);
    const listed = await inside('tl_inspect', { target: 'entities' });
    expect(listed.isError, listed.text).toBe(false);
    expect((JSON.parse(listed.text) as { entities: Array<{ name?: string }> }).entities.map((e) => e.name)).toContain('Player');
    const revision = (JSON.parse((await inside('tl_inspect', { target: 'project' })).text) as { revision: number }).revision;
    const edit = await inside('tl_command', { op: 'createEntity', expectedRevision: revision, args: { sceneId: 'scene-main', kind: 'box', name: 'From MCP' } });
    expect(edit.isError, edit.text).toBe(false);
    await expect.poll(() => readFileSync(join(mine, 'thirdlight', 'scenes', 'scene-main.json'), 'utf8')).toContain('From MCP');

    const lost = await connect(stray);
    const nowhere = await lost('tl_inspect', { target: 'project' });
    expect(nowhere.isError).toBe(true);
    expect(nowhere.text).toContain('no thirdlight.json');

    // project.mjs addresses the running backend; the export is addressed by the folder.
    const tokenFile = join(games, 'owner-token');
    writeFileSync(tokenFile, tb.adminToken);
    const cli = ['--origin', tb.authUrl, '--token-file', tokenFile];
    const list = await projectTool(['list', ...cli]);
    expect(list.code, list.stderr).toBe(0);
    expect(list.stdout).toMatch(new RegExp(`mine\\s+ok\\s+${mine}`));
    const out = join(games, 'mine-export');
    const exported = await projectTool(['export', mine, '--out', out, ...cli]);
    expect(exported.code, exported.stderr).toBe(0);
    expect(existsSync(join(out, 'index.html'))).toBe(true);

    // A marker the backend does not know: the answer says how to register it.
    expect((await api(`${tb.authUrl}/api/v1/admin/projects/mine/unregister`, { body: {}, token: tb.adminToken, origin: null })).status).toBe(200);
    const unknown = await connect(deep);
    const unregistered = await unknown('tl_inspect', { target: 'project' });
    expect(unregistered.isError).toBe(true);
    expect(unregistered.text).toContain('is not registered');
    expect(unregistered.text).toContain(`project.mjs register ${mine}`);

    // A marker pinned to another engine version is flagged, never refused.
    const markerFile = join(mine, 'thirdlight.json');
    const marker = JSON.parse(readFileSync(markerFile, 'utf8')) as { engine: { version: string } };
    marker.engine.version = '0.0.0-other';
    writeFileSync(markerFile, JSON.stringify(marker));
    expect((await api(`${tb.authUrl}/api/v1/admin/projects/register`, { body: { folder: mine }, token: tb.adminToken, origin: null })).status).toBe(201);
    const res = await fetch(`${tb.authUrl}/api/v1/projects`, { headers: { authorization: `Bearer ${tb.adminToken}` } });
    const row = ((await res.json()) as { projects: Array<{ projectId: string; loadable: boolean; enginePin?: { differences: string[] } }> }).projects.find((p) => p.projectId === 'mine')!;
    expect(row.loadable).toBe(true);
    expect(row.enginePin?.differences.join()).toContain('0.0.0-other');
    const check = await projectTool(['check', mine]);
    expect(check.code).toBe(1);
    expect(check.stderr).toContain('MISMATCH');
  }, 120_000);
});
