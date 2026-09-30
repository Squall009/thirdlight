/**
 * The MCP server (stdio, the official SDK client) against a live editor: the
 * charter's tool categories — inspect the selection, edit, diagnostics,
 * pick a browser session, start/stop play, bounded input, observations and
 * screenshots.
 * A visual script built entirely over MCP (publishBehavior with a
 * graph, graphEdit), published through the editor's HTTP source route and
 * played with the MCP play tools; the editor shows the same graph (one
 * mutation path).
 * The project organized over MCP (createFolder, moveResources, renameFolder,
 * each one undo): the files move on disk, ids stay, the index and the
 * editor's project window follow.
 */
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { expect, test } from '@playwright/test';

import { type E2EBackend, startBackend, controls } from './backend';
import { decodePng } from './png';

const REPO = resolve(import.meta.dirname, '..', '..');

let be: E2EBackend;
let mcp: Client;
test.beforeEach(async () => {
  be = await startBackend('mcp-e2e', 'starter');
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
  await page.locator('.tl-hierarchy__list li.tl-row').filter({ hasText: 'Player' }).click();

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
  await expect.poll(async () => (await call('tl_game_observe', { playSessionId })).body.state, { timeout: 15_000 }).toBe('running');

  expect((await call('tl_game_control', { playSessionId, command: 'mute' })).isError).toBe(false);
  const frames = Array.from({ length: 90 }, (_, i) => ({ stepOffset: i, ...controls(1) }));
  const input = await call('tl_input_exercise', { playSessionId, frames });
  expect(input.isError, JSON.stringify(input.body)).toBe(false);
  const observed = (await call('tl_game_observe', { playSessionId })).body as { state: string; player: { x: number } };
  expect(observed.state).toBe('running');
  expect(observed.player.x).toBeGreaterThan(4);

  const shot = await call('tl_screenshot', { playSessionId, maxWidth: 512 });
  expect(shot.isError, JSON.stringify(shot.body).slice(0, 300)).toBe(false);
  expect(String(shot.body.dataUrl)).toMatch(/^data:image\/png;base64,/);
  // A drawn frame (the scene, not one flat colour), at most maxWidth wide.
  const img = decodePng(Buffer.from(String(shot.body.dataUrl).slice('data:image/png;base64,'.length), 'base64'));
  expect(img.width).toBeLessThanOrEqual(512);
  const colours = new Set<string>();
  for (let y = 0; y < img.height; y += 8) for (let x = 0; x < img.width; x += 8) colours.add(img.pixel(x, y).slice(0, 3).join(','));
  expect(colours.size).toBeGreaterThan(20);
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

test('an MCP agent builds a visual script with graphEdit, publishes it through the source route and plays it; the editor shows the same graph', async ({ page }) => {
  test.setTimeout(180_000);
  await page.goto(be.editorUrl);
  await expect(page.locator('.tl-statusbar')).toContainText('connected');
  const rev = async (): Promise<number> => (await call('tl_inspect', { target: 'project' })).body.revision as number;
  const ok = async (op: string, args: Record<string, unknown>): Promise<Record<string, unknown>> => {
    const res = await call('tl_command', { op, expectedRevision: await rev(), args });
    expect(res.isError, JSON.stringify(res.body)).toBe(false);
    return res.body;
  };

  // Create the script (On start only), then add "Add to counter" and its exec wire in one graphEdit.
  await ok('publishBehavior', { behaviorId: 'mcp-gifts', displayName: 'MCP gifts', mode: 'declaration-create', declaration: { properties: [] }, graph: { nodes: [{ id: 'start', type: 'event.start', position: [0, 0] }], edges: [] } });
  await ok('graphEdit', {
    owner: { kind: 'behavior', id: 'mcp-gifts' },
    ops: [
      { op: 'addNodes', nodes: [{ id: 'give', type: 'api.game.add', position: [260, 0], data: { name: 'gifts', amount: 4 } }] },
      { op: 'connect', edges: [{ id: 'w1', from: { node: 'start', port: 'then' }, to: { node: 'give', port: 'in' } }] },
    ],
  });
  // A wire the kind forbids (an exec output into a number input) is refused by the same validator the editor's edits go through.
  const bad = await call('tl_command', { op: 'graphEdit', expectedRevision: await rev(), args: { owner: { kind: 'behavior', id: 'mcp-gifts' }, ops: [{ op: 'connect', edges: [{ id: 'w2', from: { node: 'give', port: 'then' }, to: { node: 'give', port: 'amount' } }] }] } });
  expect(bad.isError).toBe(true);

  // The editor shows the MCP-built graph (the behavior list, then its Graph tab) and its compile check passes.
  await page.getByRole('tab', { name: 'Behaviors' }).click();
  await page.locator('.tl-behaviors__list .tl-tile', { hasText: 'MCP gifts' }).dblclick();
  await expect(page.getByRole('tab', { name: 'Graph: MCP gifts' })).toHaveAttribute('aria-selected', 'true');
  const view = page.getByLabel('visual script', { exact: true });
  await expect(page.locator('[data-node-id="give"]')).toBeVisible();
  await expect(view.getByLabel('compile status')).toHaveAttribute('data-status', 'ok', { timeout: 20_000 });

  // Publish through the HTTP source route: compile check → trust acknowledgment (over MCP) → publish.
  const route = async (body: Record<string, unknown>): Promise<Record<string, unknown>> => {
    const r = await fetch(`${be.origin}/api/v1/projects/${be.projectId}/content/behaviors/source`, {
      method: 'POST',
      headers: { authorization: `Bearer ${be.token}`, 'content-type': 'application/json', origin: be.origin },
      body: JSON.stringify(body),
    });
    const json = (await r.json()) as Record<string, unknown>;
    expect(r.status, JSON.stringify(json)).toBe(200);
    return json;
  };
  const digest = String((await route({ check: true, graph: true, behaviorId: 'mcp-gifts' }))['sourceDigest']);
  await ok('acknowledgeBehaviorTrust', { sourceDigest: digest });
  await route({ graph: true, behaviorId: 'mcp-gifts', displayName: 'MCP gifts', expectedRevision: await rev(), requestId: `req-${randomBytes(16).toString('hex')}` });
  const listed = (await call('tl_content_query', { target: 'behaviors', behaviorId: 'mcp-gifts', includeDeclaration: true })).body as { behaviors: { source?: { kind?: string; sourceDigest?: string } }[] };
  expect(listed.behaviors[0]?.source).toMatchObject({ kind: 'graph', sourceDigest: digest });
  await expect(view.getByText('published', { exact: true })).toBeVisible({ timeout: 20_000 });

  // Attach it to a new box and play with the MCP tools: On start adds 4 to "gifts".
  const box = String((await ok('createEntity', { kind: 'box', name: 'Gift box', transform: { position: [6, 1, 0] } }))['createdId']);
  await ok('setBehaviorProperties', { entityId: box, behaviorId: 'mcp-gifts', values: {} });
  const sessionId = ((await call('tl_sessions')).body.sessions as Array<{ sessionId: string; connected: boolean }>).find((s) => s.connected)!.sessionId;
  const started = await call('tl_play_start', { demo: false, sessionId });
  expect(started.isError, JSON.stringify(started.body)).toBe(false);
  const playSessionId = String(started.body.playSessionId);
  await expect.poll(async () => (await call('tl_game_observe', { playSessionId })).body.state, { timeout: 30_000 }).toBe('running');
  await expect.poll(async () => ((await call('tl_game_observe', { playSessionId })).body.counters as Record<string, number> | undefined)?.['gifts'], { timeout: 30_000 }).toBe(4);
  expect((await call('tl_play_stop', { playSessionId })).isError).toBe(false);
});

test('an MCP agent organizes the project: a folder made, a resource moved into it, the folder renamed, undone; the editor lists it', async ({ page }) => {
  await page.goto(be.editorUrl);
  await expect(page.locator('.tl-statusbar')).toContainText('connected');
  const rev = async (): Promise<number> => (await call('tl_inspect', { target: 'project' })).body.revision as number;
  const run = async (op: string, args: Record<string, unknown>): Promise<Record<string, unknown>> => {
    const r = await call('tl_command', { op, expectedRevision: await rev(), args });
    expect(r.isError, JSON.stringify(r.body)).toBe(false);
    return r.body;
  };
  const pathOf = async (kind: string, id: string): Promise<string | undefined> => ((await call('tl_content_query', { target: 'index', kind, id })).body.entries as { path: string }[])[0]?.path;
  const onDisk = (rel: string): boolean => existsSync(join(be.projectDir, ...rel.split('/')));

  await run('setMaterial', { material: { materialId: 'mcp-stone', name: 'Stone', shader: 'standard', params: { roughness: 0.5 }, textures: {} } });
  await run('createFolder', { folder: 'art/stone' });
  const moved = await run('moveResources', { items: [{ kind: 'material', id: 'mcp-stone' }], to: 'art/stone' });
  expect((moved.change as { type: string; moves: { from: string; to: string }[] }).moves).toEqual([{ kind: 'material', id: 'mcp-stone', from: 'assets/materials/mcp-stone.material.json', to: 'art/stone/mcp-stone.material.json' }]);
  expect(await pathOf('material', 'mcp-stone')).toBe('art/stone/mcp-stone.material.json');
  await run('renameFolder', { folder: 'art', name: 'looks' });
  expect(await pathOf('material', 'mcp-stone')).toBe('looks/stone/mcp-stone.material.json');
  expect(onDisk('looks/stone/mcp-stone.material.json')).toBe(true);
  expect(onDisk('art')).toBe(false);
  // The folder tree over MCP, and in the editor's project window.
  const top = (await call('tl_content_query', { target: 'index', folder: '', folders: true, limit: 1 })).body.folders as { path: string }[];
  expect(top.map((f) => f.path)).toContain('looks');
  const inLooks = (await call('tl_content_query', { target: 'index', folder: 'looks', recursive: true })).body.entries as { id: string }[];
  expect(inLooks.map((e) => e.id)).toEqual(['mcp-stone']);
  // A taken target is refused and changes nothing.
  const before = await rev();
  const refused = await call('tl_command', { op: 'createFolder', expectedRevision: before, args: { folder: 'looks' } });
  expect(refused.isError).toBe(true);
  expect(await rev()).toBe(before);
  await page.getByRole('tab', { name: 'Assets' }).click();
  await page.getByRole('button', { name: 'folder (game folder)', exact: true }).click();
  await expect(page.locator('.tl-assets__list li[data-folder="looks"]')).toBeVisible();

  // Undo: the rename, then the move (each one command).
  await run('undo', {});
  expect(await pathOf('material', 'mcp-stone')).toBe('art/stone/mcp-stone.material.json');
  await run('undo', {});
  expect(await pathOf('material', 'mcp-stone')).toBe('assets/materials/mcp-stone.material.json');
  expect(onDisk('assets/materials/mcp-stone.material.json')).toBe(true);
  await expect(page.locator('.tl-assets__list li[data-folder="art"]')).toBeVisible();
});
