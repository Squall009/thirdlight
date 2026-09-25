/**
 * Phase 19.0: a visual script built in the editor against a real backend
 * (the engine sample with a neutral box carrying the script).
 *
 * - Behaviors → "+ Visual script" creates a behavior whose source is a graph
 *   and opens it as a "Graph: <name>" centre tab (the generic graph editor
 *   with the `behavior` kind): On start and one variable are there.
 * - Build "On start → Add to counter": the node from the catalogue, the exec
 *   wire port to port, the counter's name and amount in the Inspector — each
 *   gesture one graphEdit on owner {kind: "behavior"} (checked in the backend).
 * - The compile check reports the empty counter name on its node until it is
 *   filled in; Publish asks for the trust acknowledgment of the digest, then
 *   publishes (source.kind "graph").
 * - Play runs it: the run's counter shows the amount (observed through the
 *   play observation route).
 */
import { createHash } from 'node:crypto';

import { expect, test, type Locator, type Page } from '@playwright/test';

import { startBackend, type E2EBackend } from './backend';

let be: E2EBackend;
test.beforeEach(async () => {
  be = await startBackend('visual-script-e2e', 'beacon-reach');
});
test.afterEach(async () => {
  await be.stop();
});

interface GNode { id: string; type: string; data?: Record<string, unknown> }
interface GEdge { from: { node: string; port: string }; to: { node: string; port: string } }
interface Record_ { behaviorId: string; graph?: { nodes: GNode[]; edges: GEdge[] }; source: { kind?: string; sourceDigest: string } | null }

async function api(path: string, body: unknown): Promise<{ status: number; json: Record<string, unknown> }> {
  const r = await fetch(`${be.origin}/api/v1/projects/${be.projectId}/${path}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${be.token}`, 'content-type': 'application/json', origin: be.origin },
    body: JSON.stringify(body),
  });
  return { status: r.status, json: (await r.json()) as Record<string, unknown> };
}
const query = (op: string, args: Record<string, unknown> = {}): Promise<Record<string, unknown>> => be.command({ op, projectId: be.projectId, args });
async function cmd(op: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const res = await be.command({
    op,
    projectId: be.projectId,
    expectedRevision: Number((await query('queryProject')).revision),
    requestId: `req-${createHash('sha256').update(`${op}${Math.random()}`).digest('hex').slice(0, 32)}`,
    origin: { kind: 'mcp', clientId: 'e2e-visual-script' },
    args,
  });
  expect(res.ok, JSON.stringify(res)).toBe(true);
  return res;
}
async function record(id: string): Promise<Record_ | undefined> {
  return ((await query('queryBehaviors', { includeDeclaration: true, behaviorId: id }))['behaviors'] as Record_[] | undefined)?.[0];
}

const node = (page: Page, id: string): Locator => page.locator(`[data-node-id="${id}"]`);
const port = (page: Page, id: string, side: 'in' | 'out', name: string): Locator => page.locator(`[data-node="${id}"][data-side="${side}"][data-port="${name}"]`);

test('visual script: build On start → Add to counter in the Graph tab, publish, Play shows the counter', async ({ page }) => {
  test.setTimeout(240_000);
  const made = await cmd('createEntity', { kind: 'box', name: 'Script box', transform: { position: [6, 1, 0] }, box: { size: [0.5, 0.5, 0.5], material: { color: '#808080' } } });
  const boxId = String(made.createdId);

  await page.goto(be.editorUrl);
  await expect(page.locator('.tl-statusbar')).toContainText('connected');
  await page.getByRole('tab', { name: 'Behaviors' }).click();
  await page.getByLabel('New visual script name').fill('Gift giver');
  await page.getByRole('button', { name: '+ Visual script' }).click();

  // The Graph tab: the generic graph editor with the behavior kind.
  await expect(page.getByRole('tab', { name: 'Graph: Gift giver' })).toHaveAttribute('aria-selected', 'true');
  const view = page.getByLabel('visual script', { exact: true });
  await expect(view).toHaveAttribute('data-behavior', 'gift-giver');
  await expect(node(page, 'start')).toBeVisible();
  expect((await record('gift-giver'))?.graph?.nodes.map((n) => n.type).sort()).toEqual(['event.start', 'var.number']);

  // Add "Add to counter" from the catalogue (right click on empty space).
  const stage = page.locator('.tl-graph__stage');
  const box = (await stage.boundingBox())!;
  await page.mouse.click(box.x + box.width * 0.7, box.y + box.height * 0.75, { button: 'right' });
  const popup = page.getByRole('dialog', { name: 'Add node' });
  await expect(popup.getByRole('group', { name: 'Game' })).toBeVisible();
  await popup.getByLabel('Search nodes').fill('counter');
  await popup.getByRole('option', { name: 'Add to counter', exact: true }).click();
  await expect.poll(async () => (await record('gift-giver'))?.graph?.nodes.filter((n) => n.type === 'api.game.add').length, { timeout: 10_000 }).toBe(1);
  const addId = (await record('gift-giver'))!.graph!.nodes.find((n) => n.type === 'api.game.add')!.id;
  await expect(node(page, addId)).toBeVisible();

  // The exec wire: On start's output → the node's exec input (keyboard: Enter on one port, Enter on the other).
  await port(page, 'start', 'out', 'then').focus();
  await page.keyboard.press('Enter');
  await port(page, addId, 'in', 'in').focus();
  await page.keyboard.press('Enter');
  await expect.poll(async () => (await record('gift-giver'))?.graph?.edges.map((e) => `${e.from.node}.${e.from.port}>${e.to.node}.${e.to.port}`)).toEqual([`start.then>${addId}.in`]);

  // The empty counter name is a compile problem on the node.
  const status = view.getByLabel('compile status');
  await expect(status).toHaveAttribute('data-status', 'errors', { timeout: 20_000 });
  await expect(view.getByLabel('script problems')).toContainText('Add to counter: fill in the counter');

  // Fill in the counter name and the amount in the Inspector (each one setNodeData).
  await node(page, addId).click({ position: { x: 90, y: 12 } });
  const inspector = page.locator('.tl-dock--right');
  const name = inspector.getByLabel('counter', { exact: true });
  await expect(name).toHaveValue('');
  await name.fill('gifts');
  await name.press('Enter');
  await expect.poll(async () => (await record('gift-giver'))?.graph?.nodes.find((n) => n.id === addId)?.data).toEqual({ name: 'gifts' });
  const amount = inspector.getByLabel('amount', { exact: true });
  await expect(amount).toHaveValue('1');
  await amount.fill('3');
  await amount.press('Enter');
  await expect.poll(async () => (await record('gift-giver'))?.graph?.nodes.find((n) => n.id === addId)?.data).toEqual({ name: 'gifts', amount: 3 });
  await expect(status).toHaveAttribute('data-status', 'ok', { timeout: 20_000 });
  await expect(view.getByLabel('script problems')).toContainText('No problems.');

  // Publish: the trust acknowledgment for the new digest, then the source route.
  await view.getByRole('button', { name: 'Publish', exact: true }).click();
  const trust = view.getByRole('group', { name: 'trust acknowledgment' });
  await expect(trust).toBeVisible();
  await trust.getByRole('button').click();
  await expect(view.getByLabel('publish result')).toContainText('Published', { timeout: 20_000 });
  await expect.poll(async () => (await record('gift-giver'))?.source?.kind ?? null).toBe('graph');
  await expect(view.getByText('published', { exact: true })).toBeVisible({ timeout: 20_000 });

  // Play runs it on the box: On start adds 3 to the run's "gifts" counter.
  await cmd('setBehaviorProperties', { entityId: boxId, behaviorId: 'gift-giver', values: {} });
  const started = page.waitForResponse((res) => res.request().method() === 'POST' && res.url().endsWith('/play'));
  await page.getByTitle('Start an isolated play preview').click();
  const psid = String(((await (await started).json()) as { playSessionId: string }).playSessionId);
  type Obs = { state?: string; counters?: Record<string, number> };
  const observe = async (): Promise<Obs> => (await api(`play/${psid}/observe`, {})).json as Obs;
  await expect.poll(async () => (await observe()).state, { timeout: 30_000 }).toBe('awaitingStart');
  expect((await api(`play/${psid}/control`, { command: 'start' })).status).toBe(200);
  await expect.poll(async () => (await observe()).counters?.['gifts'], { timeout: 30_000 }).toBe(3);
  await page.getByTitle('Stop the play preview').click();

  // A reload keeps the Graph tab (a behavior with a graph opens as a visual script).
  await page.reload();
  await expect(page.locator('.tl-statusbar')).toContainText('connected');
  await page.getByRole('tab', { name: 'Graph: Gift giver', exact: true }).click();
  await expect(node(page, addId)).toBeVisible();
});
