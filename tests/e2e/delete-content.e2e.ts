/**
 * Deleting an asset, a prefab or a script, in the editor and over MCP, the
 * same command against the real backend. The editor's delete is refused (and
 * says why) while an object uses the record; an unused one is removed, and
 * an MCP undo brings it back in the editor. MCP's `tl_command` gets the same
 * refusal (`reference_in_use`) and the same deletion. Project Settings →
 * Script trust lists the acknowledged sources as the backend has them (read
 * at load) and revokes one, refused while a published script still uses it.
 * A `createEntities` batch over MCP is one revision and one undo, and the
 * editor shows its objects.
 */
import { join, resolve } from 'node:path';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { expect, test } from './pw';

import { publishScript, publishWav, startBackend, STARTER, type E2EBackend } from './backend';
import { projectWindow, chooseItem, closeEditor, closeProjectSettings, openProjectSettings, settingsWindow } from './ui';

const REPO = resolve(import.meta.dirname, '..', '..');

let be: E2EBackend;
let mcp: Client;
test.beforeEach(async () => {
  be = await startBackend('delete-e2e', 'starter');
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
async function rev(): Promise<number> {
  return Number((await be.command({ op: 'queryProject', projectId: be.projectId, args: {} })).revision);
}
async function command(op: string, args: Record<string, unknown>): Promise<{ isError: boolean; body: Record<string, unknown> }> {
  return call('tl_command', { op, expectedRevision: await rev(), args });
}

const SPINNER = ['export default {', '  instantiate() { return {}; },', '  step() {},', '};'].join('\n');

// One backend, MCP client and editor for every kind: the prefab and script parts use the ground, which the asset part leaves alone.
test('assets: the editor refuses a used one and deletes an unused one; MCP gets the same command and undoes it; prefabs: refused while a copy is placed, deleted after; scripts and script trust likewise; createEntities is one revision and one undo', async ({ page }) => {
  await publishWav(be, 'cue-goal.wav', 'sfx-ping', 'ping');
  await page.goto(be.editorUrl);
  await expect(page.locator('.tl-statusbar')).toContainText('connected');
  await projectWindow(page);

  // The pillar model is placed in the start scene: refused, and the editor says by what.
  await page.locator('.tl-assets__list li[data-asset-id="starter-pillar"]').click();
  await page.getByRole('button', { name: 'delete asset Pillar' }).click();
  await expect(page.getByTestId('asset-delete-error')).toContainText('asset "starter-pillar" is still used');
  await expect(page.locator('.tl-assets__list li[data-asset-id="starter-pillar"]')).toHaveCount(1);
  // A refusal is not a save failure: the status bar names the refusal and still says saved.
  await expect(page.locator('.tl-statusbar')).toContainText('error reference_in_use');
  await expect(page.locator('.tl-statusbar')).toContainText('save: saved');
  // MCP: the same refusal.
  const refused = await command('deleteAsset', { assetId: 'starter-pillar' });
  expect(refused.isError).toBe(true);
  expect(JSON.stringify(refused.body)).toContain('reference_in_use');

  // The unused sound goes; an MCP undo brings it back in the editor; MCP deletes it again.
  await page.locator('.tl-assets__list li[data-asset-id="sfx-ping"]').click();
  await page.getByRole('button', { name: 'delete asset ping' }).click();
  await expect(page.locator('.tl-assets__list li[data-asset-id="sfx-ping"]')).toHaveCount(0);
  await expect(page.getByTestId('asset-delete-error')).toHaveCount(0);
  expect((await command('undo', {})).isError).toBe(false);
  await expect(page.locator('.tl-assets__list li[data-asset-id="sfx-ping"]')).toHaveCount(1);
  const deleted = await command('deleteAsset', { assetId: 'sfx-ping' });
  expect(deleted.isError, JSON.stringify(deleted.body)).toBe(false);
  await expect(page.locator('.tl-assets__list li[data-asset-id="sfx-ping"]')).toHaveCount(0);

  // Once nothing uses the pillar model it can go too (the placed pillar deleted first).
  expect((await command('deleteEntity', { entityId: STARTER.pillarId })).isError).toBe(false);
  await page.locator('.tl-assets__list li[data-asset-id="starter-pillar"]').click();
  await page.getByRole('button', { name: 'delete asset Pillar' }).click();
  await expect(page.locator('.tl-assets__list li[data-asset-id="starter-pillar"]')).toHaveCount(0);

  // Prefabs, in the same project and editor: refused while a copy is placed, deleted after; createEntities is one revision and one undo.
  expect((await command('createPrefab', { prefabId: 'crate', displayName: 'Crate', sourceEntityId: STARTER.groundId })).isError).toBe(false);
  const placed = await command('instantiatePrefab', { sceneId: 'scene-main', prefabId: 'crate', transform: { position: [0, 3, 0] } });
  expect(placed.isError, JSON.stringify(placed.body)).toBe(false);
  // The prefab, chosen in the project window: its Inspector deletes it.
  await chooseItem(page, 'prefab', 'Crate');
  const tile = page.locator('.tl-assets__list li[data-item-id="crate"]');
  await expect(tile).toHaveCount(1);
  await page.getByRole('button', { name: 'delete prefab Crate' }).click();
  await expect(page.getByTestId('prefab-delete-error')).toContainText('prefab "crate" is still used');
  await expect(tile).toHaveCount(1);
  const byMcp = await command('deletePrefab', { prefabId: 'crate' });
  expect(byMcp.isError).toBe(true);
  expect(JSON.stringify(byMcp.body)).toContain('reference_in_use');

  // Delete the copy, then the prefab.
  const rootId = String(((placed.body.result ?? placed.body) as { change?: { rootId?: string } }).change?.rootId ?? '');
  expect(rootId).not.toBe('');
  expect((await command('deleteEntity', { entityId: rootId })).isError).toBe(false);
  await chooseItem(page, 'prefab', 'Crate');
  await page.getByRole('button', { name: 'delete prefab Crate' }).click();
  await expect(tile).toHaveCount(0);
  expect((await command('undo', {})).isError).toBe(false);
  await expect(tile).toHaveCount(1);

  // Scripts: a published script on the ground. The page is read again so the trust list comes from the backend at load.
  await publishScript(be, 'spinner', SPINNER, STARTER.groundId);
  const listed = await call('tl_content_query', { target: 'behaviors', behaviorId: 'spinner', includeDeclaration: true, includeTrust: true });
  const digest = String((listed.body.behaviors as { source?: { sourceDigest?: string } }[] | undefined)?.[0]?.source?.sourceDigest ?? '');
  expect(digest, JSON.stringify(listed.body).slice(0, 400)).toMatch(/^[0-9a-f]{64}$/);
  expect((listed.body.trust as { sourceDigest: string }[]).map((e) => e.sourceDigest)).toContain(digest);
  await page.reload();
  await expect(page.locator('.tl-statusbar')).toContainText('connected');
  await chooseItem(page, 'behavior', 'spinner');
  await page.getByRole('button', { name: 'delete behavior spinner' }).click();
  await expect(page.getByTestId('item-delete-error')).toContainText('behavior "spinner" is still used');
  expect(JSON.stringify((await command('deleteBehavior', { behaviorId: 'spinner' })).body)).toContain('reference_in_use');

  // The trust list: the script's source, used by it, so a revoke is refused and says why.
  await openProjectSettings(page, 'Script trust');
  const row = settingsWindow(page).locator(`li[data-digest="${digest}"]`);
  await expect(row).toContainText('used by script spinner');
  await row.getByRole('button', { name: `revoke trust ${digest.slice(0, 12)}` }).click();
  await expect(row.getByTestId('trust-revoke-error')).toContainText('is still used');
  await expect(page.locator('.tl-statusbar')).toContainText('save: saved');
  await closeProjectSettings(page);

  // Off the ground, the script goes; then its source can be revoked; an MCP undo brings the entry back.
  expect((await command('setBehaviorProperties', { entityId: STARTER.groundId, behaviorId: null })).isError).toBe(false);
  await chooseItem(page, 'behavior', 'spinner');
  await page.getByRole('button', { name: 'delete behavior spinner' }).click();
  await expect(page.locator('.tl-project__item[data-item-kind="behavior"][data-item-id="spinner"]')).toHaveCount(0);
  await openProjectSettings(page, 'Script trust');
  await expect(row).toContainText('not used by a published script');
  await row.getByRole('button', { name: `revoke trust ${digest.slice(0, 12)}` }).click();
  await expect(row).toHaveCount(0);
  expect((await command('undo', {})).isError).toBe(false);
  await expect(row).toHaveCount(1);
  await closeProjectSettings(page);

  // Bulk building over MCP: one revision, the editor shows every object, one undo removes them all.
  const before = await rev();
  const items = [{ kind: 'folder', name: 'Row', ref: 'row' }, ...Array.from({ length: 12 }, (_, i) => ({ kind: 'box', parentId: 'row', name: `post ${i}`, static: true, transform: { position: [i * 1.5 - 8, 0.5, -4] } }))];
  const made = await command('createEntities', { sceneId: 'scene-main', entities: items });
  expect(made.isError, JSON.stringify(made.body).slice(0, 400)).toBe(false);
  expect(await rev()).toBe(before + 1);
  await closeEditor(page);
  const rows = page.locator('.tl-hierarchy__list li.tl-row').filter({ hasText: /^post \d+/ });
  await expect(page.locator('.tl-hierarchy__list li.tl-row').filter({ hasText: 'Row' })).toHaveCount(1);
  expect((await command('undo', {})).isError).toBe(false);
  await expect(page.locator('.tl-hierarchy__list li.tl-row').filter({ hasText: 'Row' })).toHaveCount(0);
  await expect(rows).toHaveCount(0);
  expect(await rev()).toBe(before + 2);
});
