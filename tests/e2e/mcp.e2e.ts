/**
 * The MCP server (stdio, the official SDK client) against a live editor: the
 * charter §7 tool categories — inspect the selection, edit, diagnostics,
 * pick a browser session, start/stop play, bounded input, observations and
 * screenshots.
 */
import { join, resolve } from 'node:path';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { expect, test } from '@playwright/test';

import { startBackend, type E2EBackend } from './backend';

const REPO = resolve(import.meta.dirname, '..', '..');

let be: E2EBackend;
let mcp: Client;
test.beforeEach(async () => {
  be = await startBackend('mcp-e2e', 'beacon-reach');
  mcp = new Client({ name: 'thirdlight-e2e', version: '0.0.0' });
  await mcp.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [join(REPO, 'dist', 'mcp-adapter', 'mcp.mjs')],
      env: { ...process.env, THIRDLIGHT_AUTHORING_ORIGIN: be.origin, THIRDLIGHT_PROJECT_ID: be.projectId, THIRDLIGHT_MCP_TOKEN: be.token } as Record<string, string>,
      stderr: 'ignore',
    }),
  );
});
test.afterEach(async () => {
  await mcp.close();
  await be.stop();
});

async function call(name: string, args: Record<string, unknown> = {}): Promise<{ isError: boolean; body: Record<string, unknown> }> {
  const res = (await mcp.callTool({ name, arguments: args })) as { isError?: boolean; content: Array<{ type: string; text: string }> };
  return { isError: res.isError === true, body: JSON.parse(res.content[0]!.text) as Record<string, unknown> };
}

test('an MCP agent inspects the selection, plays, observes, moves and captures the game', async ({ page }) => {
  await page.goto(be.editorUrl);
  await expect(page.locator('.tl-statusbar')).toContainText('connected');
  await page.locator('.tl-hierarchy__list li').filter({ hasText: 'Player' }).click();

  // What is selected in the browser?
  await expect.poll(async () => ((await call('tl_inspect', { target: 'selection' })).body.entities as Array<{ name?: string }> | undefined)?.map((e) => e.name)).toEqual(['Player']);

  // Project diagnostics: a failed edit is reported.
  const bad = await call('tl_command', { op: 'updateEntity', expectedRevision: 0, args: { entityId: 'no-such-entity', name: 'x' } });
  expect(bad.isError).toBe(true);
  const diag = await call('tl_diagnostics');
  expect(diag.isError).toBe(false);
  expect(JSON.stringify(diag.body.problems)).toContain('updateEntity');

  // Pick the browser session explicitly and play.
  const sessions = (await call('tl_sessions')).body.sessions as Array<{ sessionId: string; connected: boolean }>;
  const sessionId = sessions.find((s) => s.connected)!.sessionId;
  const started = await call('tl_play_start', { demo: false, sessionId });
  expect(started.isError, JSON.stringify(started.body)).toBe(false);
  const playSessionId = String(started.body.playSessionId);
  await expect.poll(async () => (await call('tl_game_observe', { playSessionId })).body.state, { timeout: 15_000 }).toBe('awaitingStart');

  expect((await call('tl_game_control', { playSessionId, command: 'start' })).isError).toBe(false);
  const frames = Array.from({ length: 90 }, (_, i) => ({ stepOffset: i, moveX: 1, jump: 'none' }));
  const input = await call('tl_input_exercise', { playSessionId, frames });
  expect(input.isError, JSON.stringify(input.body)).toBe(false);
  const observed = (await call('tl_game_observe', { playSessionId })).body as { state: string; player: { x: number } };
  expect(observed.state).toBe('playing');
  expect(observed.player.x).toBeGreaterThan(4);

  const shot = await call('tl_screenshot', { playSessionId, maxWidth: 512 });
  expect(shot.isError, JSON.stringify(shot.body).slice(0, 300)).toBe(false);
  expect(String(shot.body.dataUrl)).toMatch(/^data:image\/png;base64,/);
  expect((await call('tl_diagnostics', { playSessionId })).isError).toBe(false);

  expect((await call('tl_play_stop', { playSessionId })).isError).toBe(false);
  await expect(page.locator('iframe.tl-app__preview-frame')).toHaveCount(0);
});

test('play tools say clearly when no browser is connected', async () => {
  const started = await call('tl_play_start', { demo: false });
  expect(started.isError).toBe(true);
  expect(JSON.stringify(started.body)).toContain('session_unavailable');
});

test('an MCP agent files entities into folders and sets folder flags; the editor shows it and reports a multi-selection', async ({ page }) => {
  await page.goto(be.editorUrl);
  await expect(page.locator('.tl-statusbar')).toContainText('connected');
  const rev = async (): Promise<number> => (await call('tl_inspect', { target: 'project' })).body.revision as number;

  const made = await call('tl_command', { op: 'createEntity', expectedRevision: await rev(), args: { kind: 'folder', name: 'Characters' } });
  expect(made.isError, JSON.stringify(made.body)).toBe(false);
  const folderId = String(made.body.createdId);
  const list = (await call('tl_inspect', { target: 'entities', limit: 200 })).body.entities as Array<{ id: string; name?: string; components: Record<string, unknown> }>;
  const player = list.find((e) => e.components['controller'] !== undefined)!;
  const before = (player.components['transform'] as { position: number[] }).position;

  const moved = await call('tl_command', { op: 'moveEntities', expectedRevision: await rev(), args: { entityIds: [player.id], parentId: folderId } });
  expect(moved.isError, JSON.stringify(moved.body)).toBe(false);
  const flagged = await call('tl_command', { op: 'updateEntity', expectedRevision: await rev(), args: { entityId: folderId, static: true } });
  expect(flagged.isError, JSON.stringify(flagged.body)).toBe(false);

  const inspected = (await call('tl_inspect', { target: 'entity', entityId: player.id })).body as { parentChain: string[]; entity: { components: Record<string, unknown> } };
  expect(inspected.parentChain).toEqual([folderId]);
  expect((inspected.entity.components['transform'] as { position: number[] }).position).toEqual(before);

  // The browser shows the player under the folder, with the folder's static flag passed down.
  const playerRow = page.locator(`.tl-hierarchy__list li[data-entity-id="${player.id}"]`);
  const folderRow = page.locator(`.tl-hierarchy__list li[data-entity-id="${folderId}"]`);
  await expect(playerRow.locator('.tl-row__flag--static')).toHaveCount(1);
  // A multi-selection in the browser is what tl_inspect reports.
  await folderRow.click();
  await playerRow.click({ modifiers: ['Control'] });
  await expect
    .poll(async () => ((await call('tl_inspect', { target: 'selection' })).body.entities as Array<{ id: string }> | undefined)?.map((e) => e.id).sort())
    .toEqual([folderId, player.id].sort());

  // Undo through MCP puts the flag back, then the move.
  await call('tl_command', { op: 'undo', expectedRevision: await rev(), args: {} });
  await expect(playerRow.locator('.tl-row__flag--static')).toHaveCount(0);
  await call('tl_command', { op: 'undo', expectedRevision: await rev(), args: {} });
  await expect.poll(async () => ((await call('tl_inspect', { target: 'entity', entityId: player.id })).body as { parentChain: string[] }).parentChain).toEqual([]);
});
