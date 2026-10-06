/**
 * A schemaVersion 5 project (one project-wide look; the fixture
 * `fixtures/phase27/legacy-v5-environment`, written by that engine through
 * its own backend: two scenes, a gradient sky, linear fog, post, wind) opened
 * in the editor in a real browser: it upgrades on open, Problems says so, the
 * Environment window shows each scene with the old look, the last recorded
 * command replays from its record, and a recorded run plays back to the same
 * digests (`tl_playtest`, two runs in the simulation worker and two on one
 * thread, against this editor's Play).
 *
 * The files themselves (each scene file, the content, the export) are checked
 * over HTTP in packages/backend/src/format-upgrade.test.ts.
 */
import { cpSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { expect, test } from './pw';

import { startBackend, type E2EBackend } from './backend';
import { openWindow, toolWindow, toolWindowScene } from './ui';

const REPO = resolve(import.meta.dirname, '..', '..');
const FIXTURE = join(REPO, 'fixtures', 'phase27', 'legacy-v5-environment');
const ID = 'legacy-v5-environment';

let be: E2EBackend;
test.beforeEach(async () => {
  be = await startBackend('upgrade-host-0001');
  // The old project is put beside the one the helper made, as a folder copied in by hand would be.
  cpSync(FIXTURE, join(dirname(be.projectDir), ID), { recursive: true });
});
test.afterEach(async () => {
  await be.stop();
});

const post = async (path: string, body: unknown): Promise<{ status: number; json: Record<string, unknown> }> => {
  const r = await fetch(`${be.origin}/api/v1/projects/${ID}/${path}`, { method: 'POST', headers: { authorization: `Bearer ${be.token}`, 'content-type': 'application/json', origin: be.origin }, body: JSON.stringify(body) });
  return { status: r.status, json: (await r.json()) as Record<string, unknown> };
};

test('a version-5 project opens in the editor, upgrades, shows each scene with its look and replays the same', async ({ page }) => {
  test.setTimeout(180_000);
  await page.goto(`${be.origin}/?project=${ID}#token=${be.token}`);
  await expect(page.locator('.tl-statusbar')).toContainText('connected');
  expect(JSON.parse(readFileSync(join(dirname(be.projectDir), ID, 'project.json'), 'utf8'))['schemaVersion']).toBe(7);

  // Problems names the upgrade.
  await openWindow(page, 'Problems');
  await expect(page.locator('.tl-dock--bottom')).toContainText('copied into 2 scenes');

  // Each scene has the old look: the Environment window names the scene it edits.
  await openWindow(page, 'Environment');
  const env = toolWindow(page, 'Environment');
  await expect(toolWindowScene(page, 'Environment')).toHaveAttribute('data-scene-id', 'scene-main');
  await expect(env.getByRole('combobox', { name: 'fog mode' })).toHaveValue('linear');
  await toolWindowScene(page, 'Environment').getByRole('combobox').selectOption('scene-two');
  await expect(toolWindowScene(page, 'Environment')).toHaveAttribute('data-scene-id', 'scene-two');
  await expect(env.getByRole('combobox', { name: 'fog mode' })).toHaveValue('linear');

  // The last recorded command, sent again, replays its recorded result.
  const replay = JSON.parse(readFileSync(join(FIXTURE, 'replay.json'), 'utf8')) as Record<string, unknown>;
  const again = await post('commands', replay);
  expect(again.status, JSON.stringify(again.json)).toBe(200);
  expect(again.json).toMatchObject({ ok: true, duplicated: true, requestId: replay['requestId'] });

  // A recorded run plays back the same: the same input twice per threading mode, the same digests.
  const mcp = new Client({ name: 'thirdlight-e2e', version: '0.0.0' });
  await mcp.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [join(REPO, 'dist', 'mcp-adapter', 'mcp.mjs')],
      env: { ...process.env, THIRDLIGHT_AUTHORING_ORIGIN: be.origin, THIRDLIGHT_PROJECT_ID: ID, THIRDLIGHT_MCP_TOKEN: be.token } as Record<string, string>,
      stderr: 'ignore',
    }),
  );
  try {
    const res = (await mcp.callTool({ name: 'tl_playtest', arguments: { frames: [{ stepOffset: 90 }], threads: 'both', runs: 2, observe: { atSteps: [30, 90] } } })) as { isError?: boolean; content: Array<{ text: string }> };
    const body = JSON.parse(res.content[0]!.text) as { deterministic?: boolean; mismatches?: unknown; runs?: { simulation: string; observations: { runStep: number; digest: string }[] }[] };
    expect(res.isError === true, JSON.stringify(body).slice(0, 2000)).toBe(false);
    expect(body.deterministic, JSON.stringify(body.mismatches)).toBe(true);
    expect(body.runs!.map((r) => r.simulation)).toEqual(['worker', 'worker', 'single', 'single']);
    // Each run's observations (the asked steps and the end) are the first run's, step for step.
    const seen = body.runs!.map((r) => r.observations.map((o) => `${o.runStep}:${o.digest}`));
    expect(seen[0]!.length).toBeGreaterThanOrEqual(2);
    for (const run of seen) expect(run).toEqual(seen[0]);
  } finally {
    await mcp.close();
  }
});
