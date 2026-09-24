/**
 * Phase 11: MCP plays without the owner's browser. With no editor connected,
 * `tl_play_start` makes the backend open its own headless editor; screenshots,
 * input and observations work through it; the owner's browser takes over.
 */
import { join, resolve } from 'node:path';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { expect, test } from '@playwright/test';

import { startBackend, type E2EBackend } from './backend';
// @ts-expect-error — a plain .mjs helper shared with the Playwright config
import { browserLibs } from './browser-env.mjs';

const REPO = resolve(import.meta.dirname, '..', '..');

let be: E2EBackend;
let mcp: Client;
test.beforeEach(async () => {
  const libs = browserLibs() as string | undefined;
  be = await startBackend('mcp-headless', 'beacon-reach', { THIRDLIGHT_HEADLESS: 'on', ...(libs !== undefined ? { THIRDLIGHT_BROWSER_LIBS: libs } : {}) });
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

test('with no editor open, MCP plays, observes, moves and screenshots the game through a headless editor', async ({ page }) => {
  test.setTimeout(120_000);
  // Nothing is connected.
  const before = (await call('tl_sessions')).body.sessions as Array<{ connected: boolean }>;
  expect(before.filter((s) => s.connected)).toHaveLength(0);

  const started = await call('tl_play_start', { demo: false });
  expect(started.isError, JSON.stringify(started.body)).toBe(false);
  const playSessionId = String(started.body.playSessionId);
  await expect.poll(async () => (await call('tl_game_observe', { playSessionId })).body.state, { timeout: 30_000 }).toBe('awaitingStart');
  const during = (await call('tl_sessions')).body.sessions as Array<{ connected: boolean }>;
  expect(during.filter((s) => s.connected)).toHaveLength(1);

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
  expect((await call('tl_play_stop', { playSessionId })).isError).toBe(false);

  // The owner's browser takes the project over from the headless editor.
  await page.goto(be.editorUrl);
  await expect(page.locator('.tl-statusbar')).toContainText('connected', { timeout: 20_000 });
  const after = (await call('tl_sessions')).body.sessions as Array<{ connected: boolean }>;
  expect(after.filter((s) => s.connected)).toHaveLength(1);
  // And MCP play now uses the owner's browser (the preview shows up there).
  const again = await call('tl_play_start', { demo: false });
  expect(again.isError, JSON.stringify(again.body)).toBe(false);
  await expect(page.locator('iframe.tl-app__preview-frame')).toHaveCount(1, { timeout: 15_000 });
  expect((await call('tl_play_stop', { playSessionId: String(again.body.playSessionId) })).isError).toBe(false);
});
