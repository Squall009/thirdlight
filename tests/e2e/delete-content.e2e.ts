/**
 * Deleting an asset or a prefab, in the editor and over MCP, the
 * same command against the real backend. The editor's delete is refused (and
 * says why) while an object uses the record; an unused one is removed, and
 * an MCP undo brings it back in the editor. MCP's `tl_command` gets the same
 * refusal (`reference_in_use`) and the same deletion. A
 * `createEntities` batch over MCP is one revision and one undo, and the
 * editor shows its objects.
 */
import { join, resolve } from 'node:path';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { expect, test } from '@playwright/test';

import { publishWav, startBackend, STARTER, type E2EBackend } from './backend';

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

test('assets: the editor refuses a used one and deletes an unused one; MCP gets the same command and undoes it', async ({ page }) => {
  await publishWav(be, 'cue-goal.wav', 'sfx-ping', 'ping');
  await page.goto(be.editorUrl);
  await expect(page.locator('.tl-statusbar')).toContainText('connected');
  await page.getByRole('tab', { name: 'Assets' }).click();

  // The pillar model is placed in the start scene: refused, and the editor says by what.
  await page.locator('.tl-assets__list li[data-asset-id="starter-pillar"]').click();
  await page.getByRole('button', { name: 'delete asset Pillar' }).click();
  await expect(page.getByTestId('asset-delete-error')).toContainText('asset "starter-pillar" is still used');
  await expect(page.locator('.tl-assets__list li[data-asset-id="starter-pillar"]')).toHaveCount(1);
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
});

test('prefabs: refused while a copy is placed, deleted after; createEntities is one revision and one undo', async ({ page }) => {
  expect((await command('createPrefab', { prefabId: 'crate', displayName: 'Crate', sourceEntityId: STARTER.groundId })).isError).toBe(false);
  const placed = await command('instantiatePrefab', { prefabId: 'crate', transform: { position: [0, 3, 0] } });
  expect(placed.isError, JSON.stringify(placed.body)).toBe(false);
  await page.goto(be.editorUrl);
  await expect(page.locator('.tl-statusbar')).toContainText('connected');
  await page.getByRole('tab', { name: 'Prefabs' }).click();

  const tile = page.locator('.tl-prefabs__list li').filter({ hasText: 'Crate' });
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
  await page.getByRole('button', { name: 'delete prefab Crate' }).click();
  await expect(tile).toHaveCount(0);
  expect((await command('undo', {})).isError).toBe(false);
  await expect(tile).toHaveCount(1);

  // Bulk building over MCP: one revision, the editor shows every object, one undo removes them all.
  const before = await rev();
  const items = [{ kind: 'folder', name: 'Row', ref: 'row' }, ...Array.from({ length: 12 }, (_, i) => ({ kind: 'box', parentId: 'row', name: `post ${i}`, static: true, transform: { position: [i * 1.5 - 8, 0.5, -4] } }))];
  const made = await command('createEntities', { entities: items });
  expect(made.isError, JSON.stringify(made.body).slice(0, 400)).toBe(false);
  expect(await rev()).toBe(before + 1);
  await page.getByRole('tab', { name: 'Scene' }).click();
  const rows = page.locator('.tl-hierarchy__list li.tl-row').filter({ hasText: /^post \d+/ });
  await expect(page.locator('.tl-hierarchy__list li.tl-row').filter({ hasText: 'Row' })).toHaveCount(1);
  expect((await command('undo', {})).isError).toBe(false);
  await expect(page.locator('.tl-hierarchy__list li.tl-row').filter({ hasText: 'Row' })).toHaveCount(0);
  await expect(rows).toHaveCount(0);
  expect(await rev()).toBe(before + 2);
});
