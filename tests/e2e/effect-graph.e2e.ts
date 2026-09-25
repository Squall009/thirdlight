/**
 * Phase 20.0/20.1: visual effects in the browser against the real backend.
 * The Effects tab creates an effect, which opens as an "Effect: <name>"
 * centre tab; "+ System" adds a system whose graph holds the four contexts;
 * blocks come from the search catalogue and are chained: Spawn → Burst,
 * Initialize → Lifetime, Update → Size over life, Output → Billboard (each
 * gesture one graphEdit on owner kind `effect`, checked in the backend); the
 * Inspector edits a block's number field and its curve (the curve widget);
 * a box gets the Effect component from "+ Add component" and overrides the
 * effect's public parameter; a reload keeps it all; undo takes it back step
 * by step. (The preview pane is covered by effect-editor.e2e.ts.)
 */
import { expect, test, type Locator, type Page } from '@playwright/test';

import { startBackend, type E2EBackend } from './backend';
import { menu } from './ui';

let be: E2EBackend;
test.beforeEach(async () => {
  be = await startBackend();
});
test.afterEach(async () => {
  await be.stop();
});

interface GNode { id: string; type: string; position: [number, number]; data?: Record<string, unknown> }
interface GEdge { id: string; from: { node: string; port: string }; to: { node: string; port: string } }
interface Fx { effectId: string; name: string; parameters?: { key: string }[]; systems: { systemId: string; name: string; graph: { nodes: GNode[]; edges: GEdge[] } }[] }

async function effects(): Promise<Fx[]> {
  const r = await be.command({ op: 'queryGameConfig', projectId: be.projectId, args: {} });
  return (r.effects ?? []) as Fx[];
}
async function graph(): Promise<{ nodes: GNode[]; edges: GEdge[] }> {
  await expect.poll(async () => (await effects())[0]?.systems.length ?? 0, { timeout: 10_000 }).toBeGreaterThan(0);
  return (await effects())[0]!.systems[0]!.graph;
}
async function nodesOfType(type: string, count: number): Promise<string[]> {
  await expect.poll(async () => (await graph()).nodes.filter((n) => n.type === type).length, { timeout: 10_000 }).toBe(count);
  return (await graph()).nodes.filter((n) => n.type === type).map((n) => n.id);
}
const wires = async (): Promise<string[]> => (await graph()).edges.map((e) => `${e.from.node}.${e.from.port}>${e.to.node}.${e.to.port}`).sort();
async function components(id: string): Promise<Record<string, unknown>> {
  const r = await be.command({ op: 'queryEntity', projectId: be.projectId, args: { entityId: id } });
  return (r['entity'] as { components: Record<string, unknown> }).components;
}

const node = (page: Page, id: string): Locator => page.locator(`[data-node-id="${id}"]`);
const port = (page: Page, id: string, side: 'in' | 'out', name: string): Locator => page.locator(`[data-node="${id}"][data-side="${side}"][data-port="${name}"]`);
async function centre(l: Locator): Promise<{ x: number; y: number }> {
  const b = (await l.boundingBox())!;
  return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
}
async function drag(page: Page, from: { x: number; y: number }, to: { x: number; y: number }): Promise<void> {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move((from.x + to.x) / 2, (from.y + to.y) / 2, { steps: 4 });
  await page.mouse.move(to.x, to.y, { steps: 4 });
  await page.mouse.up();
}
async function addFromCatalogue(page: Page, at: { x: number; y: number }, query: string, pick: string): Promise<void> {
  await page.mouse.click(at.x, at.y, { button: 'right' });
  const popup = page.getByRole('dialog', { name: 'Add node' });
  await expect(popup).toBeVisible();
  await popup.getByLabel('Search nodes').fill(query);
  await popup.getByRole('option', { name: pick, exact: true }).click();
  await expect(popup).toHaveCount(0);
}

test('an effect: create, add a system, spawn burst → lifetime → billboard chains, curve widget, Effect component, reload keeps it, undo', async ({ page }) => {
  test.setTimeout(180_000);
  await page.goto(be.editorUrl);
  await expect(page.locator('.tl-statusbar')).toContainText('connected');

  // Effects tab → a new effect opens as a centre tab.
  await page.getByRole('tab', { name: 'Effects' }).click();
  await page.getByLabel('New effect name').fill('Sparks');
  await page.getByRole('button', { name: 'Create effect' }).click();
  const tab = page.getByRole('tab', { name: 'Effect: Sparks' });
  await expect(tab).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('.tl-effects li[data-effect-id="sparks"]')).toContainText('0 systems');
  await expect(page.getByRole('note')).toContainText('The preview plays the effect as Play would');

  // "+ System": the system graph starts with the four contexts.
  await page.getByRole('button', { name: 'add system' }).click();
  await expect.poll(async () => (await graph()).nodes.map((n) => n.id).sort()).toEqual(['initialize', 'output', 'spawn', 'update']);
  const stage = page.locator('.tl-graph__stage');
  await expect(stage).toBeVisible();
  for (const c of ['spawn', 'initialize', 'update', 'output']) await expect(node(page, c)).toBeVisible();
  await expect(port(page, 'spawn', 'out', 'then')).toHaveAttribute('aria-label', /then \(spawn chain\)/);

  // Blocks from the search catalogue (effect categories).
  const box = (await stage.boundingBox())!;
  const at = (fx: number, fy: number) => ({ x: box.x + box.width * fx, y: box.y + box.height * fy });
  await page.mouse.click(at(0.6, 0.1).x, at(0.6, 0.1).y, { button: 'right' });
  const popup = page.getByRole('dialog', { name: 'Add node' });
  for (const cat of ['Spawn', 'Position', 'Initialize', 'Forces', 'Collision', 'Over life', 'Kill', 'Output', 'Values', 'Maths']) await expect(popup.getByRole('group', { name: cat })).toBeVisible();
  await page.keyboard.press('Escape');
  await addFromCatalogue(page, at(0.55, 0.1), 'burst', 'Burst');
  const [burst] = await nodesOfType('spawn.burst', 1);
  await addFromCatalogue(page, at(0.55, 0.35), 'lifetime', 'Lifetime');
  const [life] = await nodesOfType('init.lifetime', 1);
  await addFromCatalogue(page, at(0.55, 0.55), 'size over', 'Size over life');
  const [sizeCurve] = await nodesOfType('update.size.curve', 1);
  await addFromCatalogue(page, at(0.55, 0.8), 'billboard', 'Billboard');
  const [bb] = await nodesOfType('output.billboard', 1);

  // Chain each context to its block.
  await drag(page, await centre(port(page, 'spawn', 'out', 'then')), await centre(port(page, burst!, 'in', 'in')));
  await expect.poll(wires).toEqual([`spawn.then>${burst}.in`]);
  await drag(page, await centre(port(page, 'initialize', 'out', 'then')), await centre(port(page, life!, 'in', 'in')));
  await drag(page, await centre(port(page, 'update', 'out', 'then')), await centre(port(page, sizeCurve!, 'in', 'in')));
  await drag(page, await centre(port(page, 'output', 'out', 'then')), await centre(port(page, bb!, 'in', 'in')));
  await expect.poll(wires).toEqual([`initialize.then>${life}.in`, `output.then>${bb}.in`, `spawn.then>${burst}.in`, `update.then>${sizeCurve}.in`].sort());
  // A spawn chain cannot feed an output block: refused in the editor, nothing sent.
  // A text selection left in the page (here: all of it) must not turn the press into a native drag that cancels the wire gesture.
  await page.evaluate(() => {
    const r = document.createRange();
    r.selectNodeContents(document.body);
    document.getSelection()!.removeAllRanges();
    document.getSelection()!.addRange(r);
  });
  await drag(page, await centre(port(page, burst!, 'out', 'then')), await centre(port(page, bb!, 'in', 'in')));
  await expect(page.locator('.tl-graph__status')).toContainText('cannot connect');
  expect(await wires()).toHaveLength(4);
  // Dropped on a block's body (not a port): refused with the reason too; each gesture replaces the last message.
  await drag(page, await centre(port(page, 'spawn', 'out', 'then')), await centre(node(page, sizeCurve!)));
  await expect(page.locator('.tl-graph__status')).toContainText('cannot connect: Size over life');
  const bbBox = (await node(page, bb!).boundingBox())!;
  await drag(page, await centre(port(page, burst!, 'out', 'then')), { x: bbBox.x + bbBox.width / 2, y: bbBox.y + bbBox.height - 6 });
  await expect(page.locator('.tl-graph__status')).toContainText('cannot connect: Billboard');
  expect(await wires()).toHaveLength(4);

  // The Inspector edits a number field of the burst and the size curve (curve widget).
  const inspector = page.locator('.tl-dock--right');
  await node(page, burst!).click({ position: { x: 90, y: 8 } });
  await inspector.getByLabel('Count', { exact: true }).fill('50');
  await inspector.getByLabel('Count', { exact: true }).press('Enter');
  await expect.poll(async () => (await graph()).nodes.find((n) => n.id === burst)!.data?.['count']).toBe(50);
  await node(page, sizeCurve!).click({ position: { x: 90, y: 8 } });
  await expect(inspector.getByRole('img', { name: 'Curve plot' })).toBeVisible();
  await inspector.getByLabel('Curve key 2 value', { exact: true }).fill('0.5');
  await inspector.getByLabel('Curve key 2 value', { exact: true }).press('Enter');
  await expect.poll(async () => (await graph()).nodes.find((n) => n.id === sizeCurve)!.data?.['curve']).toEqual([0, 1, 1, 0.5]);
  await inspector.getByRole('button', { name: 'add Curve key' }).click();
  await expect.poll(async () => (await graph()).nodes.find((n) => n.id === sizeCurve)!.data?.['curve']).toEqual([0, 1, 0.5, 0.75, 1, 0.5]);

  // An exposed parameter (public): objects may override it.
  await page.getByRole('button', { name: '+ parameter' }).click();
  await expect.poll(async () => (await effects())[0]!.parameters?.map((x) => x.key)).toEqual(['param1']);

  // A box plays the effect: "+ Add component" → Effect (it picks the project's effect).
  await page.getByRole('tab', { name: 'Scene', exact: true }).click();
  await menu(page, 'GameObject', 'Box');
  const row = page.locator('.tl-hierarchy__list li.tl-row.is-selected');
  await expect(row).toContainText('box');
  const id = (await row.getAttribute('data-entity-id'))!;
  const objInspector = page.locator('.tl-inspector');
  await objInspector.getByLabel('add component', { exact: true }).selectOption({ label: 'Effect' });
  await objInspector.getByLabel('effect effectId', { exact: true }).selectOption({ label: 'Sparks' });
  await objInspector.getByRole('button', { name: 'Add', exact: true }).click();
  await expect.poll(async () => (await components(id))['effect']).toEqual({ effectId: 'sparks' });
  await expect(objInspector.getByLabel('effect component')).toBeVisible();
  // The effect's public parameter is a row of the component; a value set here is this object's override.
  const override = objInspector.getByLabel('effect params param1', { exact: true });
  await expect(override).toHaveValue('0');
  await override.fill('5');
  await override.press('Enter');
  await expect.poll(async () => (await components(id))['effect']).toEqual({ effectId: 'sparks', params: { param1: 5 } });

  // A reload keeps the effect, its graph, the component and the tab.
  const before = JSON.stringify(await graph());
  await page.reload();
  await expect(page.locator('.tl-statusbar')).toContainText('connected', { timeout: 30_000 });
  expect(JSON.stringify(await graph())).toBe(before);
  expect((await components(id))['effect']).toEqual({ effectId: 'sparks', params: { param1: 5 } });
  await page.getByRole('tab', { name: 'Effect: Sparks' }).click();
  await expect(node(page, bb!)).toBeVisible();
  await expect(page.locator('[data-edge-id]')).toHaveCount(4);

  // Undo takes back the override, the component, the box, the parameter, then the last graph edit (the added curve key) — one step each.
  const undo = async (): Promise<void> => {
    await page.locator('.tl-graph').focus();
    await page.keyboard.press('Control+z');
  };
  await undo();
  await expect.poll(async () => (await components(id))['effect']).toEqual({ effectId: 'sparks' });
  await undo();
  await expect.poll(async () => (await components(id))['effect']).toBeUndefined();
  await undo();
  await expect(page.locator(`.tl-hierarchy__list li[data-entity-id="${id}"]`)).toHaveCount(0);
  await undo();
  await expect.poll(async () => (await effects())[0]!.parameters).toBeUndefined();
  await undo();
  await expect.poll(async () => (await graph()).nodes.find((n) => n.id === sizeCurve)!.data?.['curve']).toEqual([0, 1, 1, 0.5]);
  expect((await graph()).nodes.find((n) => n.id === burst)!.data?.['count']).toBe(50);
});
