/**
 * A schemaVersion 6 project (a scene `camera` entity; the fixture
 * `fixtures/phase28/legacy-v6-title-player`, written by that engine through
 * its own backend: a title scene holding the camera and the player, a second
 * scene with a spawn and the ground) opened in the editor in a real browser:
 * it upgrades to 7 on open, Problems says so, the last recorded command
 * replays from its record, and a recorded run plays back to the same digests
 * (`tl_playtest`, two runs in the simulation worker and two on one thread,
 * against this editor's Play).
 *
 * The files themselves (each scene file, the export), and the refusal of a
 * format older than 6, are checked over HTTP in
 * packages/backend/src/format-upgrade.test.ts.
 */
import { cpSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { expect, test } from './pw';

import { startBackend, type E2EBackend } from './backend';
import { openWindow } from './ui';

const REPO = resolve(import.meta.dirname, '..', '..');
const FIXTURE = join(REPO, 'fixtures', 'phase28', 'legacy-v6-title-player');
const ID = 'legacy-v6-title-player';

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

test('a version-6 project opens in the editor, upgrades and replays the same', async ({ page }) => {
  test.setTimeout(180_000);
  await page.goto(`${be.origin}/?project=${ID}#token=${be.token}`);
  await expect(page.locator('.tl-statusbar')).toContainText('connected');
  expect(JSON.parse(readFileSync(join(dirname(be.projectDir), ID, 'project.json'), 'utf8'))['schemaVersion']).toBe(7);

  // Problems names the upgrade: the scene camera became a shot, the camera and the player keep loaded.
  await openWindow(page, 'Problems');
  await expect(page.locator('.tl-dock--bottom')).toContainText('became a fixed virtual camera');
  await expect(page.locator('.tl-dock--bottom')).toContainText('keep loaded when their scene unloads');

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
