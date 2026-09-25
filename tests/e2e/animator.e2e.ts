/**
 * Phase 9.7 / 16.2: the Animator. A skinned test model (two joints, clips
 * `idle` and `bend`) gets a controller built in the "Animator: <controller>"
 * centre tab on the graph framework: an entry state playing `idle`, a second
 * state (added from the node catalogue) playing `bend`, a transition wire
 * dragged between them with a condition on a bool parameter (edited in the
 * right-dock Inspector). The live preview pane shows the pose change; Play
 * shows the straight column while the parameter is false and the bent one
 * once it is true.
 *
 * A second test drives the graph gestures on a stored controller: a moved
 * state keeps its position across a reload (layout persistence) and undo,
 * two transitions of one pair are one wire with a count, and a blend tree
 * opens as its own graph with a breadcrumb back.
 */
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect, test, type Locator, type Page } from '@playwright/test';

import { startBackend, type E2EBackend } from './backend';
import { decodePng, type Image } from './png';
import { skinnedGlb } from './skinned-glb';

let be: E2EBackend;
let seq = 0;
test.beforeEach(async () => {
  be = await startBackend();
});
test.afterEach(async () => {
  await be.stop();
});

interface Ctl {
  controllerId: string;
  entry: string;
  layout?: { entry?: [number, number] };
  states: { id: string; name: string; position?: [number, number]; motion: { kind: string; clip?: { clip: string } } }[];
  transitions: { from: string; to: string; conditions: unknown[]; exitTime?: number; duration: number }[];
  parameters: { name: string; default?: unknown }[];
}

async function cmd(op: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const q = await be.command({ op: 'queryProject', projectId: be.projectId, args: {} });
  seq += 1;
  const res = await be.command({ op, projectId: be.projectId, expectedRevision: q.revision, requestId: `req-${(0xa11a00 + seq).toString(16).padStart(32, '0')}`, origin: { kind: 'mcp', clientId: 'e2e-animator' }, args });
  expect(res.ok, JSON.stringify(res)).toBe(true);
  return res;
}
const controllers = async (): Promise<Ctl[]> => ((await be.command({ op: 'queryGameConfig', projectId: be.projectId }))['animators'] as Ctl[] | undefined) ?? [];

/** Orange pixels in the part of the frame left of the column's top (where the bent half goes). */
function bentPixels(img: Image): number {
  let n = 0;
  for (let y = Math.floor(img.height * 0.05); y < Math.floor(img.height * 0.5); y += 2) {
    for (let x = Math.floor(img.width * 0.25); x < Math.floor(img.width * 0.47); x += 2) {
      const [r, g, b] = img.pixel(x, y);
      if (r > 60 && r > 1.25 * g && g > 1.8 * b) n += 1;
    }
  }
  return n;
}

async function play(page: Page): Promise<Image> {
  const frame = page.locator('iframe.tl-app__preview-frame');
  await page.getByTitle('Start an isolated play preview').click();
  await expect(frame).toBeVisible();
  await page.waitForTimeout(2500);
  const img = decodePng(await frame.screenshot());
  await page.getByTitle('Stop the play preview').click();
  return img;
}

const node = (scope: Locator | Page, id: string): Locator => scope.locator(`[data-node-id="${id}"]`);
const port = (scope: Locator | Page, id: string, side: 'in' | 'out'): Locator => scope.locator(`[data-node="${id}"][data-side="${side}"][data-port="${side}"]`);
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

async function importColumn(page: Page): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), 'tl-skin-'));
  const file = join(dir, 'column.glb');
  writeFileSync(file, skinnedGlb());
  await page.locator('.tl-assets__file').first().setInputFiles(file);
  const publish = page.getByRole('button', { name: 'publish' });
  await expect(publish).toBeEnabled({ timeout: 15_000 });
  await publish.click();
  await expect.poll(async () => ((await be.command({ op: 'queryAssets', projectId: be.projectId, args: { limit: 10, offset: 0 } }))['assets'] as unknown[]).length).toBe(1);
  return ((await be.command({ op: 'queryAssets', projectId: be.projectId, args: { limit: 10, offset: 0 } }))['assets'] as { assetId: string }[])[0]!.assetId;
}

test('a controller built in the Animator tab poses a skinned model in Play by its parameter', async ({ page }) => {
  test.setTimeout(180_000);
  await page.goto(be.editorUrl);
  await expect(page.locator('.tl-statusbar')).toContainText('connected');

  // Import the skinned model and place it.
  const assetId = await importColumn(page);
  const column = String((await cmd('createEntity', { kind: 'model', name: 'column', model: { asset: { assetId } }, transform: { position: [0, 0, 0] } })).createdId);

  // The bottom-dock Animator lists controllers; a new one opens as a centre tab with its graph.
  await page.getByRole('tab', { name: 'Animator', exact: true }).click();
  await expect(page.getByLabel('animator model')).toHaveValue(assetId);
  await page.getByRole('button', { name: 'New controller' }).click();
  await expect(page.getByRole('tab', { name: 'Animator: New animator', exact: true })).toHaveAttribute('aria-selected', 'true');
  const doc = page.getByRole('tabpanel', { name: 'Animator: New animator' });
  const graph = doc.getByLabel('animator graph');
  await expect(graph.getByRole('group', { name: 'State idle node state-01' })).toBeVisible();
  await expect(graph.getByRole('group', { name: 'Entry node ENTRY' })).toBeVisible();
  await expect(graph.getByRole('group', { name: 'Any State node ANY' })).toBeVisible();
  await expect(page.getByRole('tab', { name: 'Animator', exact: true })).toBeVisible();
  const inspector = page.locator('.tl-dock--right');

  await doc.getByLabel('new parameter name').fill('bent');
  await doc.getByLabel('new parameter type').selectOption('bool');
  await doc.getByRole('button', { name: 'Add parameter' }).click();
  await expect(doc.getByLabel('parameter bent default')).toBeVisible();

  // A second state from the node catalogue (right click on the graph), right of the first.
  const stage = graph.locator('.tl-graph__stage');
  const sb = (await stage.boundingBox())!;
  const idleBox = (await node(graph, 'state-01').boundingBox())!;
  const at = { x: Math.min(sb.x + sb.width - 260, idleBox.x + idleBox.width + 220), y: idleBox.y + idleBox.height + 90 };
  await page.mouse.click(at.x, at.y, { button: 'right' });
  const popup = page.getByRole('dialog', { name: 'Add node' });
  await popup.getByLabel('Search nodes').fill('state');
  await expect(popup.getByRole('option', { name: 'Any State', exact: true })).toHaveCount(0); // fixed nodes are not in the catalogue
  await popup.getByRole('option', { name: 'State', exact: true }).click();
  await expect.poll(async () => (await controllers())[0]?.states.length).toBe(2);
  const bentId = (await controllers())[0]!.states[1]!.id;
  await expect(inspector.getByLabel('state inspector')).toBeVisible();
  await inspector.getByLabel('state clip').selectOption('bend');
  await expect.poll(async () => (await controllers())[0]!.states[1]!.motion.clip?.clip).toBe('bend');
  await inspector.getByLabel('state name').fill('Bent');
  await inspector.getByLabel('state name').press('Enter');
  await expect(graph.getByRole('group', { name: `State Bent node ${bentId}` })).toBeVisible();

  // A transition: drag from idle's output to Bent's input — one wire; its Inspector edits the transition.
  await drag(page, await centre(port(graph, 'state-01', 'out')), await centre(port(graph, bentId, 'in')));
  await expect.poll(async () => (await controllers())[0]!.transitions.length).toBe(1);
  const wire = graph.getByRole('button', { name: 'wire idle → Bent' });
  await wire.focus();
  await expect(inspector.getByLabel('transition inspector')).toBeVisible();
  await inspector.getByRole('button', { name: 'Add condition' }).click();
  await expect(inspector.getByLabel('condition 1 parameter')).toBeVisible();
  await inspector.getByLabel('condition 1 parameter').selectOption('bent');
  await expect(inspector.getByLabel('condition 1 test')).toHaveValue('true');
  await expect.poll(async () => JSON.stringify((await controllers())[0]!.transitions[0]!.conditions)).toBe('[{"parameter":"bent","op":"true"}]');
  // A controlled checkbox: click, then poll the stored value.
  await inspector.getByLabel('transition has exit time').click();
  await expect.poll(async () => (await controllers())[0]!.transitions[0]!.exitTime).toBeUndefined();
  await inspector.getByLabel('transition duration').fill('0');
  await inspector.getByLabel('transition duration').press('Enter');

  await expect.poll(async () => (await controllers())[0]!.transitions[0]!.duration).toBe(0);
  const stored = await controllers();
  expect(stored).toHaveLength(1);
  expect(stored[0]!.states.map((s) => s.name)).toEqual(['idle', 'Bent']);
  expect(stored[0]!.transitions).toEqual([{ from: 'state-01', to: bentId, conditions: [{ parameter: 'bent', op: 'true' }], duration: 0 }]);

  // The live preview pane inside the tab: the controller runs on its model; flipping `bent` moves to Bent and changes the pose.
  await expect(doc.getByLabel('animator preview pane', { exact: true })).toBeVisible();
  await doc.getByRole('button', { name: 'Preview', exact: true }).click();
  const preview = doc.getByLabel('animator preview', { exact: true });
  await expect(preview).toHaveAttribute('data-state', 'idle', { timeout: 20_000 });
  await page.waitForTimeout(500);
  const before = decodePng(await preview.screenshot());
  await doc.getByLabel('preview bent').check();
  await expect(preview).toHaveAttribute('data-state', 'Bent');
  await page.waitForTimeout(500);
  const after = decodePng(await preview.screenshot());
  let changed = 0;
  for (let y = 0; y < Math.min(before.height, after.height); y += 2) {
    for (let x = 0; x < Math.min(before.width, after.width); x += 2) {
      const a = before.pixel(x, y);
      const b = after.pixel(x, y);
      if (Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) + Math.abs(a[2] - b[2]) > 60) changed += 1;
    }
  }
  console.log(`[animator] preview pixels changed by the pose: ${changed}`);
  expect(changed).toBeGreaterThan(20);
  // The pane docks at the bottom of the tab (the preview keeps running there) and can be hidden.
  await doc.getByRole('button', { name: 'Bottom', exact: true }).click();
  await expect(doc.locator('.tl-animator-doc__preview--bottom')).toBeVisible();
  await doc.getByRole('button', { name: 'Stop preview' }).click();
  await expect(preview).toHaveCount(0);
  await doc.getByRole('button', { name: 'Right', exact: true }).click();
  // Nothing was saved by the preview.
  expect(JSON.stringify(await controllers())).not.toContain('"default":true');

  // Put the controller on the model (Scene tab → the Inspector shows the object again).
  await page.getByRole('tab', { name: 'Scene', exact: true }).click();
  await page.locator(`.tl-hierarchy__list li[data-entity-id="${column}"]`).click();
  // Phase 15.1: "+ Add component" → Animator, then pick its controller.
  await page.locator('.tl-inspector').getByLabel('add component', { exact: true }).selectOption({ label: 'Animator' });
  await page.locator('.tl-inspector').getByLabel('animator controller', { exact: true }).selectOption({ label: 'New animator' });
  await page.locator('.tl-inspector').getByRole('button', { name: 'Add', exact: true }).click();
  await expect.poll(async () => ((await be.command({ op: 'queryEntity', projectId: be.projectId, args: { entityId: column } }))['entity'] as { components: { animator?: unknown } }).components.animator).toEqual({ controller: stored[0]!.controllerId });

  // Play: bent = false → straight; bent = true → the upper half leans over.
  const straight = bentPixels(await play(page));
  await page.getByRole('tab', { name: 'Animator: New animator', exact: true }).click();
  await doc.getByLabel('parameter bent default').click();
  await expect.poll(async () => JSON.stringify(await controllers())).toContain('"default":true');
  const bent = bentPixels(await play(page));
  console.log(`[animator] orange pixels left of the column: straight ${straight}, bent ${bent}`);
  expect(bent).toBeGreaterThan(straight + 40);
});

test('animator graph: a moved state keeps its place after a reload and undo; a pair with two transitions is one wire; a blend tree opens as its own graph', async ({ page }) => {
  test.setTimeout(150_000);
  await page.goto(be.editorUrl);
  await expect(page.locator('.tl-statusbar')).toContainText('connected');
  const asset = await importColumn(page);
  const clip = (name: string) => ({ assetId: asset, clip: name, duration: 1 });
  // A neutral controller as MCP would store it: no positions (auto-layout), two transitions idle → lean.
  await cmd('setAnimator', {
    controller: {
      controllerId: 'poser',
      name: 'Poser',
      parameters: [{ name: 'amount', type: 'float', default: 0 }, { name: 'go', type: 'trigger' }],
      states: [
        { id: 'still', name: 'Still', motion: { kind: 'clip', clip: clip('idle') }, speed: 1, loop: true },
        { id: 'lean', name: 'Lean', motion: { kind: 'clip', clip: clip('bend') }, speed: 1, loop: true },
        { id: 'mix', name: 'Mix', motion: { kind: 'blend1d', parameter: 'amount', children: [{ threshold: 0, clip: clip('idle') }, { threshold: 1, clip: clip('bend') }] }, speed: 1, loop: true },
      ],
      transitions: [
        { from: 'still', to: 'lean', conditions: [{ parameter: 'go', op: 'trigger' }], duration: 0.1 },
        { from: 'still', to: 'lean', conditions: [{ parameter: 'amount', op: 'greater', value: 0.5 }], duration: 0.2 },
        { from: 'lean', to: 'mix', conditions: [], duration: 0.1, exitTime: 1 },
      ],
      entry: 'still',
      events: [],
    },
  });

  await page.getByRole('tab', { name: 'Animator', exact: true }).click();
  await page.getByLabel('animator controllers').getByRole('button', { name: 'Poser' }).dblclick();
  const doc = page.getByRole('tabpanel', { name: 'Animator: Poser' });
  const graph = doc.getByLabel('animator graph');
  await expect(node(graph, 'still')).toBeVisible();
  const inspector = page.locator('.tl-dock--right');

  // Two transitions of one pair: one wire with a count; its Inspector lists both (in priority order).
  const pairWire = graph.getByRole('button', { name: 'wire Still → Lean (×2)' });
  await expect(pairWire).toHaveCount(1);
  await pairWire.focus();
  await expect(inspector.getByLabel('transition inspector')).toContainText('Transitions (2): Still → Lean');
  await expect(inspector.getByRole('group', { name: 'transition 2' }).getByLabel('condition 1 parameter')).toHaveValue('amount');

  // Move a state by its title bar: one graphEdit; the position is stored in the controller.
  const lean0 = (await controllers())[0]!.states.find((s) => s.id === 'lean')!.position;
  expect(lean0).toBeUndefined(); // auto-layout until the first edit
  const zoom = parseFloat((await doc.getByLabel('Zoom').textContent()) ?? '100') / 100;
  const box = (await node(graph, 'lean').boundingBox())!;
  const still0 = (await node(graph, 'still').boundingBox())!;
  await drag(page, { x: box.x + box.width / 2, y: box.y + 8 }, { x: box.x + box.width / 2 + 120, y: box.y + 8 + 100 });
  await expect.poll(async () => (await controllers())[0]!.states.find((s) => s.id === 'lean')!.position).toBeDefined();
  const moved = (await controllers())[0]!.states.find((s) => s.id === 'lean')!.position!;
  const stillPos = (await controllers())[0]!.states.find((s) => s.id === 'still')!.position!;
  console.log(`[animator] lean moved to ${moved.join(',')} (zoom ${zoom})`);
  // The graph offset between the two states matches their screen offset (before the reload).
  const movedBox = (await node(graph, 'lean').boundingBox())!;
  expect(Math.abs((movedBox.x - still0.x) / zoom - (moved[0] - stillPos[0]))).toBeLessThan(3);

  // Reload: the tab comes back and the state is where it was put (graph offset from `still` kept).
  await page.reload();
  await expect(page.locator('.tl-statusbar')).toContainText('connected');
  const doc2 = page.getByRole('tabpanel', { name: 'Animator: Poser' });
  const graph2 = doc2.getByLabel('animator graph');
  await expect(node(graph2, 'lean')).toBeVisible({ timeout: 15_000 });
  const z2 = parseFloat((await doc2.getByLabel('Zoom').textContent()) ?? '100') / 100;
  const a = (await node(graph2, 'lean').boundingBox())!;
  const b = (await node(graph2, 'still').boundingBox())!;
  expect(Math.abs((a.x - b.x) / z2 - (moved[0] - stillPos[0]))).toBeLessThan(3);
  expect(Math.abs((a.y - b.y) / z2 - (moved[1] - stillPos[1]))).toBeLessThan(3);
  expect((await controllers())[0]!.states.find((s) => s.id === 'lean')!.position).toEqual(moved);

  // Undo (Ctrl+Z with the graph focused) restores the controller before the move; redo moves it again.
  await node(graph2, 'still').click();
  await page.keyboard.press('Control+z');
  await expect.poll(async () => (await controllers())[0]!.states.find((s) => s.id === 'lean')!.position).toBeUndefined();
  await page.keyboard.press('Control+y');
  await expect.poll(async () => (await controllers())[0]!.states.find((s) => s.id === 'lean')!.position).toEqual(moved);

  // The blend tree: double-click its body → its own graph (one clip node per child), breadcrumb back.
  const mix = (await node(graph2, 'mix').boundingBox())!;
  await page.mouse.dblclick(mix.x + mix.width / 2, mix.y + mix.height - 12);
  await expect(doc2.getByLabel('graph path')).toContainText('Blend tree: Mix');
  await expect(node(graph2, 'C0')).toBeVisible();
  await expect(node(graph2, 'C1')).toBeVisible();
  await expect(graph2.getByRole('group', { name: 'Blend node OUT' })).toBeVisible();
  await node(graph2, 'C1').click();
  await expect(inspector.getByLabel('blend threshold')).toHaveValue('1');
  await inspector.getByLabel('blend threshold').fill('2.5');
  await inspector.getByLabel('blend threshold').press('Enter');
  await expect.poll(async () => JSON.stringify((await controllers())[0]!.states.find((s) => s.id === 'mix')!.motion)).toContain('"threshold":2.5');
  await doc2.getByLabel('graph path').getByRole('button', { name: 'Base layer' }).click();
  await expect(doc2.getByLabel('graph path')).toHaveCount(0);
  await expect(node(graph2, 'still')).toBeVisible();
});
