/**
 * Phase 15.0: the editor reads the component and content descriptor registry
 * from the real backend. Its first `queryGameConfig` asks for the registry
 * (`args.descriptors: true`) and gets every v4 component with its fields,
 * handles and "+ Add component" data. The same registry is on the command
 * route for any client, and a plain game query does not carry it.
 */
import { expect, test } from '@playwright/test';

import { startBackend, type E2EBackend } from './backend';

let be: E2EBackend;
test.beforeEach(async () => {
  be = await startBackend('descriptors-e2e', 'starter');
});
test.afterEach(async () => {
  await be.stop();
});

type Registry = {
  version: number;
  components: { name: string; value: { type: string; fields?: { key: string; type: string }[] }; handles: { kind: string }[] }[];
  content: { key: string }[];
};

test('the editor gets the descriptor registry with its first game query', async ({ page }) => {
  test.setTimeout(90_000);
  const asked: boolean[] = [];
  page.on('request', (r) => {
    if (r.method() !== 'POST' || !r.url().endsWith('/commands')) return;
    const body = JSON.parse(r.postData() ?? '{}') as { op?: string; args?: { descriptors?: boolean } };
    if (body.op === 'queryGameConfig') asked.push(body.args?.descriptors === true);
  });
  const first = page.waitForResponse((r) => r.request().method() === 'POST' && r.url().endsWith('/commands') && (r.request().postData() ?? '').includes('"descriptors":true'));
  await page.goto(be.editorUrl);
  await expect(page.locator('.tl-statusbar')).toContainText('connected');
  const registry = ((await (await first).json()) as { descriptors: Registry }).descriptors;
  expect(registry.version).toBe(1);
  const names = registry.components.map((c) => c.name);
  for (const n of ['transform', 'controller', 'trigger', 'collectible', 'patrol', 'hitbox', 'light', 'animator', 'fogVolume']) expect(names).toContain(n);
  // Phase 24.7: the platformer's components are gone.
  for (const n of ['enemy', 'pickup', 'gameZone', 'cameraFollow']) expect(names).not.toContain(n);
  const controller = registry.components.find((c) => c.name === 'controller')!;
  // Phase 23.2 added the 3D-only step-up and ledge height handles (dimension 3).
  expect(controller.handles.map((h) => h.kind)).toEqual(['capsule', 'height', 'height']);
  expect(registry.content.map((b) => b.key)).toEqual(expect.arrayContaining(['shell', 'eventCues', 'environment', 'input', 'materials', 'animators']));
  expect(registry.content.map((b) => b.key)).not.toContain('game');
  expect(registry.content.map((b) => b.key)).not.toContain('flow');

  expect(asked[0]).toBe(true);

  // The command route answers any client the same way.
  const direct = await be.command({ op: 'queryGameConfig', projectId: be.projectId, args: { descriptors: true } });
  expect(direct['descriptors']).toEqual(registry);
  const plain = await be.command({ op: 'queryGameConfig', projectId: be.projectId });
  expect(plain['descriptors']).toBeUndefined();
});
