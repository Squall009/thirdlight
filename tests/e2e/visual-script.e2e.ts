/**
 * Phase 19.0/19.1: visual scripts built in the editor against a real backend
 * (the engine sample with neutral additions).
 *
 * - Behaviors → "+ Visual script" creates a behavior whose source is a graph
 *   and opens it as a "Graph: <name>" centre tab (the generic graph editor
 *   with the `behavior` kind): On start is there (19.1: no variable needed).
 * - Build "On start → Add to counter": the node from the catalogue, the exec
 *   wire port to port, the counter's name and amount in the Inspector — each
 *   gesture one graphEdit on owner {kind: "behavior"} (checked in the backend).
 * - The compile check reports the empty counter name on its node until it is
 *   filled in; Publish asks for the trust acknowledgment of the digest, then
 *   publishes (source.kind "graph").
 * - Play runs it: the run's counter shows the amount (observed through the
 *   play observation route).
 * - 19.1: "on trigger enter → after a timer, hide the door, add a coin, play
 *   a sound" built from the catalogue search (an entity variable naming the
 *   trigger, On trigger, Start timer, On timer, Set visible, Add to counter,
 *   Play sound with the sound picked from the project's audio), published and
 *   played: the coin is counted and the magenta door disappears (pixels). The
 *   sound request itself is not observable headless (unverified).
 */
import { createHash } from 'node:crypto';

import { expect, test, type Locator, type Page } from '@playwright/test';

import { startBackend, type E2EBackend } from './backend';
import { decodePng } from './png';

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
  expect((await record('gift-giver'))?.graph?.nodes.map((n) => n.type).sort()).toEqual(['event.start']);

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

/** Clearly magenta pixels (the door colour; nothing else in the sample is). */
async function magenta(target: Page | Locator): Promise<number> {
  const img = decodePng(await target.screenshot());
  let n = 0;
  for (let y = 0; y < img.height; y += 2) {
    for (let x = 0; x < img.width; x += 2) {
      const [r, g, b] = img.pixel(x, y);
      if (r > 110 && b > 100 && g < 50) n += 1;
    }
  }
  return n;
}

test('visual script from the catalogue search: on trigger enter → timer → hide the door, add a coin, play a sound', async ({ page }) => {
  test.setTimeout(300_000);
  // The sensor on the player's start (3, 0.91: the player stands in it when the run begins) and a magenta door beside it.
  const trigger = String((await cmd('createEntity', { parentId: null, kind: 'group', name: 'Door sensor', transform: { position: [3, 0.91, 0] }, components: { trigger: { size: [1, 1], signal: 'sensor' } } }))['createdId']);
  const door = String((await cmd('createEntity', { kind: 'box', name: 'Door', transform: { position: [5, 1.3, 0] }, box: { size: [0.5, 2.6, 1], material: { color: '#ff00ff' } } }))['createdId']);
  const audio = ((await query('queryAssets', { limit: 100, offset: 0 }))['assets'] as { assetId: string; kind: string }[]).find((a) => a.kind === 'audio')!.assetId;

  await page.goto(be.editorUrl);
  await expect(page.locator('.tl-statusbar')).toContainText('connected');
  await page.getByRole('tab', { name: 'Behaviors' }).click();
  await page.getByLabel('New visual script name').fill('Timed door');
  await page.getByRole('button', { name: '+ Visual script' }).click();
  await expect(page.getByRole('tab', { name: 'Graph: Timed door' })).toHaveAttribute('aria-selected', 'true');
  const view = page.getByLabel('visual script', { exact: true });
  await expect(view).toHaveAttribute('data-behavior', 'timed-door');
  const stage = page.locator('.tl-graph__stage');
  const inspector = page.locator('.tl-dock--right');
  const nodes = async (): Promise<GNode[]> => (await record('timed-door'))?.graph?.nodes ?? [];

  /** Right click at a spot of the graph, search the catalogue, pick the node; returns its id (it is selected, so the Inspector shows it). */
  const add = async (search: string, label: string, type: string, fx: number, fy: number): Promise<string> => {
    const before = new Set((await nodes()).map((n) => n.id));
    const box = (await stage.boundingBox())!;
    await page.mouse.click(box.x + box.width * fx, box.y + box.height * fy, { button: 'right' });
    const popup = page.getByRole('dialog', { name: 'Add node' });
    await popup.getByLabel('Search nodes').fill(search);
    await popup.getByRole('option', { name: label, exact: true }).click();
    await expect.poll(async () => (await nodes()).filter((n) => n.type === type && !before.has(n.id)).length, { timeout: 10_000 }).toBe(1);
    const id = (await nodes()).find((n) => n.type === type && !before.has(n.id))!.id;
    await expect(node(page, id)).toBeVisible();
    return id;
  };
  const text = async (id: string, label: string, value: string, data: Record<string, unknown>): Promise<void> => {
    const f = inspector.getByLabel(label, { exact: true });
    await expect(f).toBeVisible();
    await f.fill(value);
    await f.press('Enter');
    await expect.poll(async () => (await nodes()).find((n) => n.id === id)?.data, { timeout: 10_000 }).toEqual(data);
  };
  const wireUp = async (from: string, fromPort: string, to: string, toPort: string): Promise<void> => {
    await port(page, from, 'out', fromPort).focus();
    await page.keyboard.press('Enter');
    await port(page, to, 'in', toPort).focus();
    await page.keyboard.press('Enter');
    await expect.poll(async () => (await record('timed-door'))?.graph?.edges.some((e) => e.from.node === from && e.from.port === fromPort && e.to.node === to && e.to.port === toPort), { timeout: 10_000 }).toBe(true);
  };

  // An entity variable "sensor": a public property (the trigger it names is one this script owns).
  const sensor = await add('entity variable', 'Entity variable', 'var.entity', 0.12, 0.12);
  await text(sensor, 'Name', 'sensor', { name: 'sensor' });
  // On trigger (enter) → Start timer "open" (1 s).
  const enter = await add('trigger', 'On trigger', 'event.trigger', 0.12, 0.35);
  const timer = await add('start timer', 'Start timer', 'api.timers.after', 0.45, 0.35);
  await text(timer, 'timer', 'open', { name: 'open' });
  await expect(inspector.getByLabel('seconds', { exact: true })).toHaveValue('1');
  // On timer "open" → Set visible (this object, false) → Add to counter "coins" → Play sound.
  const fired = await add('on timer', 'On timer', 'event.timer', 0.12, 0.62);
  await text(fired, 'Timer', 'open', { timer: 'open' });
  const hide = await add('visible', 'Set visible', 'api.game.setVisible', 0.35, 0.62);
  const visible = inspector.getByLabel('visible', { exact: true });
  await expect(visible).toBeChecked();
  await visible.click();
  await expect.poll(async () => (await nodes()).find((n) => n.id === hide)?.data, { timeout: 10_000 }).toEqual({ visible: false });
  const coin = await add('counter', 'Add to counter', 'api.game.add', 0.58, 0.62);
  await text(coin, 'counter', 'coins', { name: 'coins' });
  const sound = await add('sound', 'Play sound', 'api.audio.play', 0.8, 0.62);
  await inspector.getByLabel('sound', { exact: true }).selectOption(audio);
  await expect.poll(async () => (await nodes()).find((n) => n.id === sound)?.data, { timeout: 10_000 }).toEqual({ assetId: audio });

  // The exec wires, port to port (keyboard).
  await wireUp(enter, 'then', timer, 'in');
  await wireUp(fired, 'then', hide, 'in');
  await wireUp(hide, 'then', coin, 'in');
  await wireUp(coin, 'then', sound, 'in');
  const status = view.getByLabel('compile status');
  await expect(status).toHaveAttribute('data-status', 'ok', { timeout: 30_000 });

  // Publish with the trust acknowledgment; the published declaration is the variable.
  await view.getByRole('button', { name: 'Publish', exact: true }).click();
  const trust = view.getByRole('group', { name: 'trust acknowledgment' });
  await expect(trust).toBeVisible();
  await trust.getByRole('button').click();
  await expect(view.getByLabel('publish result')).toContainText('Published', { timeout: 30_000 });
  await expect.poll(async () => (await record('timed-door'))?.source?.kind ?? null).toBe('graph');
  const published = (await query('queryBehaviors', { includeDeclaration: true, behaviorId: 'timed-door' }))['behaviors'] as { declaration: unknown }[];
  expect(published[0]!.declaration).toEqual({ properties: [{ key: 'sensor', label: 'Sensor', type: 'entityRef', default: null }] });
  await cmd('setBehaviorProperties', { entityId: door, behaviorId: 'timed-door', values: { sensor: trigger } });

  // Play: the player starts in the sensor; a second later the door disappears and the coin is counted.
  const started = page.waitForResponse((res) => res.request().method() === 'POST' && res.url().endsWith('/play'));
  await page.getByTitle('Start an isolated play preview').click();
  const psid = String(((await (await started).json()) as { playSessionId: string }).playSessionId);
  type Obs = { state?: string; counters?: Record<string, number> };
  const observe = async (): Promise<Obs> => (await api(`play/${psid}/observe`, {})).json as Obs;
  await expect.poll(async () => (await observe()).state, { timeout: 30_000 }).toBe('awaitingStart');
  const frame = page.locator('iframe.tl-app__preview-frame');
  await expect.poll(async () => magenta(frame), { timeout: 20_000 }).toBeGreaterThan(40);
  const shut = await magenta(frame);
  expect((await api(`play/${psid}/control`, { command: 'start' })).status).toBe(200);
  await expect.poll(async () => (await observe()).counters?.['coins'] ?? 0, { timeout: 30_000 }).toBe(1);
  await expect.poll(async () => magenta(frame), { timeout: 15_000 }).toBeLessThan(shut / 10);
  expect((await observe()).state).toBe('playing');
  await page.getByTitle('Stop the play preview').click();
});
