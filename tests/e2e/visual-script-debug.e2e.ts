/**
 * Phase 19.2: the visual-script editor and debugging in Play, against a real
 * backend (the engine sample with neutral additions).
 *
 * - Open a script graph: its compile problem is on its node and in the
 *   Problems tab (a click opens the Graph tab at the node).
 * - The variable list: + Variable, rename, type and visibility (each one
 *   graphEdit on the backend), drag a variable onto the graph for a Get node.
 * - Function tabs: + Function creates one (owner `<behaviorId>#<functionId>`),
 *   a node added in its tab lands in the function, a double-click renames it.
 * - Switch: its cases are a list; one exec output per case.
 * - Debugging in Play (the published script runs as a Play debug build):
 *   the nodes that run light up; a breakpoint (F9) pauses Play after the
 *   step in which its node ran — the debugger and the play observation
 *   (`debug.paused`, `debug.hit.nodeId`) say so and the step index stands
 *   still; wire values show on hover; the watch list shows a variable; Step
 *   once runs exactly one step; Resume lets the game run on.
 */
import { createHash } from 'node:crypto';

import { expect, test, type Locator, type Page } from '@playwright/test';

import { startBackend, type E2EBackend } from './backend';

let be: E2EBackend;
test.beforeEach(async () => {
  be = await startBackend('visual-script-debug-e2e', 'beacon-reach');
});
test.afterEach(async () => {
  await be.stop();
});

interface GNode { id: string; type: string; position: [number, number]; data?: Record<string, unknown> }
interface GEdge { id: string; from: { node: string; port: string }; to: { node: string; port: string } }
interface Graph { nodes: GNode[]; edges: GEdge[] }
interface Record_ { behaviorId: string; graph?: Graph; functions?: { functionId: string; graph: Graph }[]; source: { kind?: string; sourceDigest: string } | null }

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
    origin: { kind: 'mcp', clientId: 'e2e-visual-script-debug' },
    args,
  });
  expect(res.ok, JSON.stringify(res)).toBe(true);
  return res;
}
async function record(id: string): Promise<Record_ | undefined> {
  return ((await query('queryBehaviors', { includeDeclaration: true, behaviorId: id }))['behaviors'] as Record_[] | undefined)?.[0];
}

const node = (page: Page, id: string): Locator => page.locator(`[data-node-id="${id}"]`);

/** On step → (step mod 30 = 0) → Branch → Add to counter "hits" → Set "count" (a private number) from the step. */
const GRAPH: Graph = {
  nodes: [
    { id: 'ev', type: 'event.step', position: [0, 0] },
    { id: 'mod', type: 'math.modulo', position: [0, 160], data: { b: 30 } },
    { id: 'cmp', type: 'math.compare', position: [240, 160] },
    { id: 'br', type: 'flow.branch', position: [480, 0] },
    { id: 'add', type: 'api.game.add', position: [720, 0] },
    { id: 'keep', type: 'var.set', position: [960, 0], data: { variable: 'count' } },
    { id: 'count', type: 'var.number', position: [0, -160], data: { name: 'count', visibility: 'private' } },
  ],
  edges: [
    { id: 'w1', from: { node: 'ev', port: 'then' }, to: { node: 'br', port: 'in' } },
    { id: 'w2', from: { node: 'ev', port: 'step' }, to: { node: 'mod', port: 'a' } },
    { id: 'w3', from: { node: 'mod', port: 'result' }, to: { node: 'cmp', port: 'a' } },
    { id: 'w4', from: { node: 'cmp', port: 'result' }, to: { node: 'br', port: 'condition' } },
    { id: 'w5', from: { node: 'br', port: 'true' }, to: { node: 'add', port: 'in' } },
    { id: 'w6', from: { node: 'add', port: 'then' }, to: { node: 'keep', port: 'in' } },
    { id: 'w7', from: { node: 'ev', port: 'step' }, to: { node: 'keep', port: 'value' } },
  ],
};

test('visual script editor and debugging: problems, variables, functions, switch cases, active nodes, breakpoint pause, wire values, watch, step, resume', async ({ page }) => {
  test.setTimeout(300_000);
  const boxId = String((await cmd('createEntity', { kind: 'box', name: 'Debug box', transform: { position: [6, 1, 0] }, box: { size: [0.5, 0.5, 0.5], material: { color: '#808080' } } }))['createdId']);
  // The counter name is left empty: a compile problem on "add".
  await cmd('publishBehavior', { behaviorId: 'stepper', displayName: 'Stepper', mode: 'declaration-create', declaration: { properties: [] }, graph: GRAPH });

  await page.goto(be.editorUrl);
  await expect(page.locator('.tl-statusbar')).toContainText('connected');
  await page.getByRole('tab', { name: 'Behaviors' }).click();
  await page.locator('.tl-behaviors__list .tl-tile', { hasText: 'Stepper' }).dblclick();
  await expect(page.getByRole('tab', { name: 'Graph: Stepper' })).toHaveAttribute('aria-selected', 'true');
  const view = page.getByLabel('visual script', { exact: true });
  await expect(node(page, 'add')).toBeVisible();
  // Exec wires are drawn as flow (the kind says so); the compile problem is on its node.
  await expect(view.getByLabel('compile status')).toHaveAttribute('data-status', 'errors', { timeout: 20_000 });
  await expect(node(page, 'add')).toHaveAttribute('data-problems', /error/);

  // The Problems tab lists it; a click (from the Scene tab) opens the Graph tab at the node.
  await page.getByRole('tab', { name: 'Problems' }).click();
  const issue = page.getByRole('button', { name: /Stepper › Add to counter \(add\): fill in the counter/ });
  await expect(issue).toBeVisible();
  await page.getByRole('tab', { name: 'Scene', exact: true }).click();
  await issue.click();
  await expect(page.getByRole('tab', { name: 'Graph: Stepper' })).toHaveAttribute('aria-selected', 'true');
  await expect(node(page, 'add')).toHaveAttribute('aria-selected', 'true');
  // Fix it in the Inspector.
  const inspector = page.locator('.tl-dock--right');
  const counter = inspector.getByLabel('counter', { exact: true });
  await counter.fill('hits');
  await counter.press('Enter');
  await expect.poll(async () => (await record('stepper'))?.graph?.nodes.find((n) => n.id === 'add')?.data).toEqual({ name: 'hits' });
  await expect(view.getByLabel('compile status')).toHaveAttribute('data-status', 'ok', { timeout: 20_000 });

  // ---- the variable list ----
  const vars = view.getByLabel('Variables', { exact: true });
  await expect(vars.locator('[data-variable="count"]')).toBeVisible();
  await view.getByRole('button', { name: '+ Variable' }).click();
  await expect.poll(async () => (await record('stepper'))?.graph?.nodes.filter((n) => n.type.startsWith('var.') && n.data?.['name'] === 'variable').length).toBe(1);
  const nameBox = vars.getByLabel('Variable name variable', { exact: true });
  await nameBox.fill('speed');
  await nameBox.press('Enter');
  await expect.poll(async () => (await record('stepper'))?.graph?.nodes.find((n) => n.type.startsWith('var.') && n.data?.['name'] === 'speed')?.type).toBe('var.number');
  await vars.getByLabel('Type of speed').selectOption('boolean');
  await expect.poll(async () => (await record('stepper'))?.graph?.nodes.find((n) => n.data?.['name'] === 'speed')?.type).toBe('var.boolean');
  await vars.getByLabel('Visibility of speed').selectOption('private');
  await expect.poll(async () => (await record('stepper'))?.graph?.nodes.find((n) => n.data?.['name'] === 'speed')?.data).toEqual({ name: 'speed', visibility: 'private' });
  // Drag "count" onto the graph: a Get count node.
  const stage = page.locator('.tl-graph__stage');
  const sb = (await stage.boundingBox())!;
  await vars.getByLabel('Drag count').dragTo(stage, { targetPosition: { x: sb.width * 0.5, y: sb.height * 0.85 } });
  const dropMenu = page.getByRole('menu', { name: 'Variable node' });
  await expect(dropMenu).toBeVisible();
  await dropMenu.getByRole('menuitem', { name: 'Get count' }).click();
  await expect.poll(async () => (await record('stepper'))?.graph?.nodes.filter((n) => n.type === 'var.get' && n.data?.['variable'] === 'count').length).toBe(1);
  // Delete the extra variable and the Get again (the script compiles as before).
  await vars.getByRole('button', { name: 'Delete variable speed' }).click();
  const getId = (await record('stepper'))!.graph!.nodes.find((n) => n.type === 'var.get')!.id;
  await cmd('graphEdit', { owner: { kind: 'behavior', id: 'stepper' }, ops: [{ op: 'removeNodes', ids: [getId] }] });
  await expect.poll(async () => (await record('stepper'))?.graph?.nodes.length).toBe(GRAPH.nodes.length);

  // ---- function tabs ----
  await view.getByRole('button', { name: '+ Function' }).click();
  const fnName = view.getByLabel('New function name');
  await fnName.fill('Twice');
  await fnName.press('Enter');
  await expect.poll(async () => (await record('stepper'))?.functions?.map((f) => f.functionId)).toEqual(['twice']);
  await expect(view).toHaveAttribute('data-target', 'twice');
  await expect(page.locator('[data-graph-owner="behavior:stepper#twice"]')).toBeVisible();
  await expect(node(page, 'start')).toBeVisible();
  // A node from the catalogue lands in the function.
  const fb = (await stage.boundingBox())!;
  await page.mouse.click(fb.x + fb.width * 0.3, fb.y + fb.height * 0.6, { button: 'right' });
  const popup = page.getByRole('dialog', { name: 'Add node' });
  await popup.getByLabel('Search nodes').fill('input');
  await popup.getByRole('option', { name: 'Input', exact: true }).click();
  await expect.poll(async () => (await record('stepper'))?.functions?.[0]?.graph.nodes.map((n) => n.type).sort()).toEqual(['fn.entry', 'fn.input']);
  // Rename by double-click (the Function start's name; the id stays).
  await view.locator('[data-function="twice"] button[role="tab"]').dblclick();
  const rename = view.getByLabel('Function name', { exact: true });
  await rename.fill('Double it');
  await rename.press('Enter');
  await expect.poll(async () => (await record('stepper'))?.functions?.[0]?.graph.nodes.find((n) => n.type === 'fn.entry')?.data?.['name']).toBe('Double it');
  await expect(view.locator('[data-function="twice"]')).toContainText('Double it');
  // Back to the event graph.
  await view.getByRole('tab', { name: 'Event graph' }).click();
  await expect(page.locator('[data-graph-owner="behavior:stepper"]')).toBeVisible();

  // ---- a Switch with a data-dependent number of cases ----
  await cmd('graphEdit', { owner: { kind: 'behavior', id: 'stepper' }, ops: [{ op: 'addNodes', nodes: [{ id: 'sw', type: 'flow.switch', position: [480, 400], data: { cases: 'red, green, blue, gold' } }] }] });
  await expect.poll(async () => (await record('stepper'))?.graph?.nodes.some((n) => n.id === 'sw')).toBe(true);
  // Fit everything (nothing selected) so the new node is in view.
  await page.keyboard.press('Escape');
  await stage.click({ position: { x: 20, y: sb.height - 20 } });
  await page.locator('.tl-graph__toolbar').getByRole('button', { name: 'Fit', exact: true }).click();
  await expect(page.locator('[data-node="sw"][data-side="out"]')).toHaveCount(5);
  await expect(page.locator('[data-node="sw"][data-side="out"][data-port="case4"]')).toHaveAttribute('aria-label', /output gold/);
  await cmd('graphEdit', { owner: { kind: 'behavior', id: 'stepper' }, ops: [{ op: 'removeNodes', ids: ['sw'] }] });
  await expect(view.getByLabel('compile status')).toHaveAttribute('data-status', 'ok', { timeout: 20_000 });

  // ---- publish, Play ----
  await view.getByRole('button', { name: 'Publish', exact: true }).click();
  await view.getByRole('group', { name: 'trust acknowledgment' }).getByRole('button').click();
  await expect(view.getByLabel('publish result')).toContainText('Published', { timeout: 30_000 });
  await expect.poll(async () => (await record('stepper'))?.source?.kind ?? null).toBe('graph');
  await cmd('setBehaviorProperties', { entityId: boxId, behaviorId: 'stepper', values: {} });
  const started = page.waitForResponse((res) => res.request().method() === 'POST' && res.url().endsWith('/play'));
  await page.getByTitle('Start an isolated play preview').click();
  const psid = String(((await (await started).json()) as { playSessionId: string }).playSessionId);
  type Obs = { state?: string; stepIndex?: number; counters?: Record<string, number>; debug?: { paused: boolean; hit: { nodeId: string; entityId: string } | null } };
  const observe = async (): Promise<Obs> => (await api(`play/${psid}/observe`, {})).json as Obs;
  await expect.poll(async () => (await observe()).state, { timeout: 60_000 }).toBe('awaitingStart');
  expect((await api(`play/${psid}/control`, { command: 'start' })).status).toBe(200);
  await expect.poll(async () => (await observe()).counters?.['hits'] ?? 0, { timeout: 30_000 }).toBeGreaterThan(0);

  // Back in the Graph tab: the debugger watches the box; the nodes that run light up.
  await page.getByRole('tab', { name: 'Graph: Stepper' }).click();
  const debuggerPanel = view.getByLabel('debugger');
  await expect(debuggerPanel).toHaveAttribute('data-state', 'running', { timeout: 30_000 });
  await expect(debuggerPanel.getByLabel('Debug object')).toHaveValue(boxId);
  // Everything in view (nothing selected, then Fit).
  const sb2 = (await stage.boundingBox())!;
  await stage.click({ position: { x: 20, y: sb2.height - 20 } });
  await page.locator('.tl-graph__toolbar').getByRole('button', { name: 'Fit', exact: true }).click();
  await expect(node(page, 'ev')).toHaveAttribute('data-active', 'true', { timeout: 15_000 });
  await expect(node(page, 'br')).toHaveAttribute('data-active', 'true');
  // Watch "count".
  await vars.getByLabel('Watch count').click();
  await expect(view.getByLabel('watch list').locator('[data-watch-value="count"]')).toHaveText(/^\d+$/, { timeout: 15_000 });

  // A breakpoint on Add (select it, F9): Play pauses after the step in which it ran.
  await node(page, 'add').click({ position: { x: 90, y: 12 } });
  await page.keyboard.press('F9');
  await expect(node(page, 'add')).toHaveAttribute('data-breakpoint', 'true');
  const status = view.getByLabel('debug status');
  await expect(status).toHaveAttribute('data-paused', 'true', { timeout: 30_000 });
  await expect(status).toHaveAttribute('data-node', 'add');
  await expect(status).toContainText('Add to counter');
  await expect(node(page, 'add')).toHaveAttribute('data-current', 'true');
  const paused = await observe();
  expect(paused.debug?.paused).toBe(true);
  expect(paused.debug?.hit).toEqual({ behaviorId: 'stepper', entityId: boxId, nodeId: 'add' });
  const heldAt = paused.stepIndex!;
  await page.waitForTimeout(500);
  expect((await observe()).stepIndex).toBe(heldAt);
  // The held step ran Add: its step (the script's step index, one below the steps completed) was a multiple of 30 — the watch list and the wire values say so.
  await expect(view.getByLabel('watch list').locator('[data-watch-value="count"]')).toHaveText(String(heldAt - 1), { timeout: 10_000 });
  const wire = page.locator('[data-edge-id="w3"]');
  await expect(wire).toHaveAttribute('data-value', 'value: 0');
  const wb = (await wire.boundingBox())!;
  await page.mouse.move(wb.x + wb.width / 2, wb.y + wb.height / 2);
  await expect(page.getByRole('tooltip', { name: 'Wire value' })).toHaveText('value: 0');
  await expect(page.locator('[data-edge-id="w4"]')).toHaveAttribute('data-value', 'value: true');

  // Step once: exactly one step, still paused (Add did not run in it).
  await debuggerPanel.getByRole('button', { name: 'Step once' }).click();
  await expect.poll(async () => (await observe()).stepIndex, { timeout: 10_000 }).toBe(heldAt + 1);
  await page.waitForTimeout(400);
  const after = await observe();
  expect(after.stepIndex).toBe(heldAt + 1);
  expect(after.debug?.paused).toBe(true);
  await expect(status).toContainText(`Paused at step ${heldAt + 1}`);
  await expect(page.locator('[data-edge-id="w4"]')).toHaveAttribute('data-value', 'value: false');

  // Remove the breakpoint (F9 again) and resume: the game runs on.
  await node(page, 'add').click({ position: { x: 90, y: 12 } });
  await page.keyboard.press('F9');
  await expect(node(page, 'add')).not.toHaveAttribute('data-breakpoint', 'true');
  await debuggerPanel.getByRole('button', { name: 'Resume' }).click();
  await expect(status).toHaveAttribute('data-paused', 'false', { timeout: 10_000 });
  await expect.poll(async () => (await observe()).stepIndex ?? 0, { timeout: 15_000 }).toBeGreaterThan(heldAt + 30);
  expect((await observe()).debug?.paused).toBe(false);
  await page.getByTitle('Stop the play preview').click();
});
