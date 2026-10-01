/**
 * `replay` answers once the restart is applied, with the new run's id, or
 * says the restart is still pending — never a relay timeout for a restart
 * that happens. Against the real backend, the real MCP adapter and the
 * editor in Chromium, in both threading modes (a worker and the page's main
 * thread):
 *
 * - The scale bench at its small size (generated content, no scripts: its
 *   steps sample no input): with scenes loaded, a replay over HTTP and one
 *   over MCP `tl_game_control` each answer `restart.state: applied` with the
 *   next run id, the observation is in that run with the loaded scenes gone.
 *   The simulation held by the debugger takes no step, so the restart waits
 *   past the relay's timeout: the call answers `pending` with the run id the
 *   restart will have (HTTP 200, inside the relay timeout); released, the
 *   game is in that run; the old run id is now stale.
 * - The Starter (scripts, a character): a replay over HTTP and MCP answers
 *   applied with the next run id.
 */
import { rmSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { expect, test, type Page } from '@playwright/test';
import { validateGameControlResult } from '@thirdlight/protocol';

import { PERF_ROOT, startPerfBackend, type PerfBackend } from '../../tools/perf/backend';
import { generateScaleProject, SCALE_SMALL } from '../../tools/perf/scale-generate';

const REPO = resolve(import.meta.dirname, '..', '..');
/** The backend's relay timeout (config `relayTimeoutSeconds`). */
const RELAY_TIMEOUT_MS = 10_000;

let be: PerfBackend;
let root: string;
test.afterEach(async () => {
  await be?.stop();
  rmSync(root, { recursive: true, force: true });
});

type Control = { ok?: boolean; runId?: string; snapshotId?: string; state?: string; restart?: { state: string; atStep?: number }; error?: { code?: string; runId?: string } };
type Obs = { state?: string; runId?: string; stepIndex?: number; run?: { runStep: number }; scenes?: { loaded: string[] }; simulation?: { mode: string } };

interface Harness {
  control(body: Record<string, unknown>): Promise<{ status: number; json: Control; ms: number }>;
  observe(): Promise<Obs>;
  mcp(args: Record<string, unknown>): Promise<{ isError: boolean; body: Control }>;
  close(): Promise<void>;
}

/** Open the editor on `projectId`, set where the simulation runs, start Play; the relay over HTTP and MCP. */
async function play(page: Page, projectId: string, threads: 'worker' | 'single'): Promise<Harness> {
  await be.project(projectId).command('setSettings', { settings: { sim_thread: threads === 'worker' ? 1 : 2 } });
  await page.goto(`${be.origin}/?project=${projectId}#token=${be.token}`);
  await expect(page.locator('.tl-statusbar')).toContainText('connected', { timeout: 60_000 });
  const mcp = new Client({ name: 'thirdlight-e2e', version: '0.0.0' });
  await mcp.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [join(REPO, 'dist', 'mcp-adapter', 'mcp.mjs')],
      env: { ...process.env, THIRDLIGHT_AUTHORING_ORIGIN: be.origin, THIRDLIGHT_PROJECT_ID: projectId, THIRDLIGHT_MCP_TOKEN: be.token } as Record<string, string>,
      stderr: 'ignore',
    }),
  );
  const started = await be.post(`/api/v1/projects/${projectId}/play`, {});
  expect(started.status, JSON.stringify(started.json).slice(0, 400)).toBe(200);
  const psid = String(started.json['playSessionId']);
  const h: Harness = {
    control: async (body) => {
      const t = Date.now();
      const r = await be.post(`/api/v1/projects/${projectId}/play/${psid}/control`, body);
      return { status: r.status, json: r.json as Control, ms: Date.now() - t };
    },
    observe: async () => (await be.post(`/api/v1/projects/${projectId}/play/${psid}/observe`, {})).json as Obs,
    mcp: async (args) => {
      const res = (await mcp.callTool({ name: 'tl_game_control', arguments: { playSessionId: psid, ...args } })) as { isError?: boolean; content: Array<{ text: string }> };
      return { isError: res.isError === true, body: JSON.parse(res.content[0]!.text) as Control };
    },
    close: () => mcp.close(),
  };
  await expect.poll(async () => (await h.observe()).state, { timeout: 60_000 }).toBe('running');
  expect((await h.observe()).simulation?.mode).toBe(threads);
  return h;
}

/** An applied replay's answer: the next run, restarted at a step, a valid control result. */
function expectApplied(r: Control, snap: string, run: number): void {
  expect(r.runId, JSON.stringify(r)).toBe(`${snap}#${run}`);
  expect(r.restart?.state, JSON.stringify(r)).toBe('applied');
  expect(r.restart?.atStep).toBeGreaterThan(0);
  expect(validateGameControlResult(r).ok, JSON.stringify(validateGameControlResult(r))).toBe(true);
}

for (const threads of ['worker', 'single'] as const) {
  test(`a replay answers once applied with the new run id, or pending while the game takes no step, over HTTP and MCP (scale bench, ${threads})`, async ({ page }) => {
    test.setTimeout(240_000);
    root = join(PERF_ROOT, 'e2e', `replay-${threads}-${process.pid}-${Date.now()}`);
    const generated = generateScaleProject(join(root, 'data'), 'scale', SCALE_SMALL);
    be = await startPerfBackend(join(root, 'data'), join(root, 'exports'));
    const h = await play(page, 'scale', threads);
    try {
      const first = await h.observe();
      const snap = String(first.runId).split('#')[0]!;
      expect(first.runId).toBe(`${snap}#0`);
      // Scenes loaded on demand, which the restart unloads.
      const later = generated.sceneIds.slice(1, 4);
      for (const id of later) expect((await h.control({ command: 'loadScene', sceneId: id })).status).toBe(200);
      await expect.poll(async () => (await h.observe()).scenes?.loaded ?? [], { timeout: 60_000 }).toEqual(expect.arrayContaining(later));

      // HTTP: applied, the next run.
      const viaHttp = await h.control({ command: 'replay' });
      expect(viaHttp.status, JSON.stringify(viaHttp.json)).toBe(200);
      expectApplied(viaHttp.json, snap, 1);
      const after = await h.observe();
      expect(after.runId).toBe(`${snap}#1`);
      for (const id of later) expect(after.scenes?.loaded).not.toContain(id);
      expect(after.run!.runStep).toBeLessThan(after.stepIndex!);

      // MCP: applied, the run after it.
      const viaMcp = await h.mcp({ command: 'replay' });
      expect(viaMcp.isError, JSON.stringify(viaMcp.body)).toBe(false);
      expectApplied(viaMcp.body, snap, 2);
      expect((await h.observe()).runId).toBe(`${snap}#2`);

      // Held by the debugger the game takes no step: the restart waits past the relay timeout, and the call says so.
      expect((await h.control({ command: 'debugPause' })).status).toBe(200);
      const held = await h.control({ command: 'replay', expectedRunId: `${snap}#2` });
      expect(held.status, JSON.stringify(held.json)).toBe(200);
      expect(held.json.restart).toEqual({ state: 'pending' });
      expect(held.json.runId).toBe(`${snap}#3`);
      expect(held.ms).toBeLessThan(RELAY_TIMEOUT_MS);
      expect(validateGameControlResult(held.json).ok).toBe(true);
      expect((await h.observe()).runId).toBe(`${snap}#2`);
      // MCP alike (the same restart is still waiting: the same run).
      const heldMcp = await h.mcp({ command: 'replay' });
      expect(heldMcp.isError, JSON.stringify(heldMcp.body)).toBe(false);
      expect(heldMcp.body.restart).toEqual({ state: 'pending' });
      expect(heldMcp.body.runId).toBe(`${snap}#3`);
      // Released, the game is in the run the answers named; a guard on the old run is stale now.
      expect((await h.control({ command: 'debugResume' })).status).toBe(200);
      await expect.poll(async () => (await h.observe()).runId, { timeout: 30_000 }).toBe(`${snap}#3`);
      const stale = await h.control({ command: 'replay', expectedRunId: `${snap}#2` });
      expect(stale.status).toBe(409);
      expect(stale.json.error).toMatchObject({ code: 'game_run_stale', runId: `${snap}#3` });
    } finally {
      await h.close();
    }
  });

  test(`a replay of a game with scripts answers once applied with the new run id over HTTP and MCP (Starter, ${threads})`, async ({ page }) => {
    test.setTimeout(180_000);
    root = join(PERF_ROOT, 'e2e', `replay-starter-${threads}-${process.pid}-${Date.now()}`);
    be = await startPerfBackend(join(root, 'data'), join(root, 'exports'));
    const made = await be.post('/api/v1/admin/projects', { projectId: 'starter', name: 'Replay', template: 'starter' });
    expect([200, 201]).toContain(made.status);
    const h = await play(page, 'starter', threads);
    try {
      const snap = String((await h.observe()).runId).split('#')[0]!;
      const viaHttp = await h.control({ command: 'replay' });
      expect(viaHttp.status, JSON.stringify(viaHttp.json)).toBe(200);
      expectApplied(viaHttp.json, snap, 1);
      const viaMcp = await h.mcp({ command: 'replay', expectedRunId: `${snap}#1` });
      expect(viaMcp.isError, JSON.stringify(viaMcp.body)).toBe(false);
      expectApplied(viaMcp.body, snap, 2);
      expect((await h.observe()).runId).toBe(`${snap}#2`);
    } finally {
      await h.close();
    }
  });
}
