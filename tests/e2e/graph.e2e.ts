/**
 * Phase 16.1: the graph editor framework in a real browser against the real
 * backend, on the framework's neutral test graph kind. Every gesture must
 * land in the backend as one graphEdit (checked through the command route
 * the MCP adapter uses), and an MCP edit must show up in the open editor.
 */
import { createHash } from 'node:crypto';

import { expect, test, type Locator, type Page } from '@playwright/test';

import { startBackend, type E2EBackend } from './backend';
import { decodePng } from './png';

let be: E2EBackend;
test.afterEach(async () => {
  await be.stop();
});

interface GNode { id: string; type: string; position: [number, number]; collapsed?: true; data?: Record<string, unknown> }
interface GEdge { id: string; from: { node: string; port: string }; to: { node: string; port: string }; reroutes?: [number, number][] }
interface Graph { nodes: GNode[]; edges: GEdge[]; groups?: { id: string; title: string; rect: number[] }[]; comments?: { id: string; text: string }[] }

async function graphOf(graphId: string): Promise<Graph> {
  const r = await be.command({ op: 'queryGameConfig', projectId: be.projectId, args: {} });
  const g = ((r.graphs ?? []) as { graphId: string; graph: Graph }[]).find((x) => x.graphId === graphId);
  return g?.graph ?? { nodes: [], edges: [] };
}
async function revision(): Promise<number> {
  return Number((await be.command({ op: 'queryProject', projectId: be.projectId, args: {} })).revision);
}
async function mcp(op: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const res = await be.command({
    op,
    projectId: be.projectId,
    expectedRevision: await revision(),
    requestId: `req-${createHash('sha256').update(`${op}${Math.random()}`).digest('hex').slice(0, 32)}`,
    origin: { kind: 'mcp', clientId: 'e2e-graph' },
    args,
  });
  expect(res.ok, JSON.stringify(res)).toBe(true);
  return res;
}

const node = (page: Page, id: string): Locator => page.locator(`[data-node-id="${id}"]`);
const port = (page: Page, id: string, side: 'in' | 'out', name: string): Locator => page.locator(`[data-node="${id}"][data-side="${side}"][data-port="${name}"]`);
async function centre(l: Locator): Promise<{ x: number; y: number }> {
  const b = (await l.boundingBox())!;
  return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
}
async function header(l: Locator): Promise<{ x: number; y: number }> {
  const b = (await l.boundingBox())!;
  return { x: b.x + b.width / 2, y: b.y + 10 };
}
async function drag(page: Page, from: { x: number; y: number }, to: { x: number; y: number }, button: 'left' | 'middle' = 'left'): Promise<void> {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down({ button });
  await page.mouse.move((from.x + to.x) / 2, (from.y + to.y) / 2, { steps: 4 });
  await page.mouse.move(to.x, to.y, { steps: 4 });
  await page.mouse.up({ button });
}
/** The ids of nodes of `type` (sorted), polled from the backend until there are `count`. */
async function nodesOfType(graphId: string, type: string, count: number): Promise<string[]> {
  await expect.poll(async () => (await graphOf(graphId)).nodes.filter((n) => n.type === type).length, { timeout: 10_000 }).toBe(count);
  return (await graphOf(graphId)).nodes.filter((n) => n.type === type).map((n) => n.id);
}
/** The canvas pixel at a point given relative to a node's box (the node overlay is transparent: this is what the canvas drew). */
async function pixelOn(page: Page, id: string, dx: (w: number) => number, dy: number): Promise<[number, number, number]> {
  const canvas = page.locator('.tl-graph__canvas');
  const cb = (await canvas.boundingBox())!;
  const nb = (await node(page, id).boundingBox())!;
  const img = decodePng(await canvas.screenshot());
  const [r, g, b] = img.pixel(Math.round(nb.x - cb.x + dx(nb.width)), Math.round(nb.y - cb.y + dy));
  return [r, g, b];
}
const near = (a: [number, number, number], b: [number, number, number], tol = 24): boolean => a.every((v, i) => Math.abs(v - b[i]!) <= tol);

async function addFromCatalogue(page: Page, at: { x: number; y: number }, query: string, pick: string): Promise<void> {
  await page.mouse.click(at.x, at.y, { button: 'right' });
  const popup = page.getByRole('dialog', { name: 'Add node' });
  await expect(popup).toBeVisible();
  await popup.getByLabel('Search nodes').fill(query);
  await popup.getByRole('option', { name: pick, exact: true }).click();
  await expect(popup).toHaveCount(0);
}

async function openEditor(page: Page): Promise<{ stage: Locator; box: { x: number; y: number; width: number; height: number } }> {
  be = await startBackend();
  await page.goto(be.editorUrl);
  await expect(page.locator('.tl-statusbar')).toContainText('connected');
  await page.getByRole('tab', { name: 'Graphs' }).click();
  await page.getByLabel('Graph kind').selectOption('test');
  await page.getByLabel('New graph name').fill('Maths');
  await page.getByRole('button', { name: 'Create graph' }).click();
  await expect(page.getByRole('tab', { name: 'Graph: Maths' })).toHaveAttribute('aria-selected', 'true');
  const stage = page.locator('.tl-graph__stage');
  await expect(stage).toBeVisible();
  return { stage, box: (await stage.boundingBox())! };
}

test('graph editing: catalogue, wires (typed, conversions, refusals), box select, multi-drag with one undo, keyboard, Inspector, MCP', async ({ page }) => {
  test.setTimeout(180_000);
  const { box } = await openEditor(page);
  const at = (fx: number, fy: number) => ({ x: box.x + box.width * fx, y: box.y + box.height * fy });

  // Search-to-add: right click → the catalogue (categories, filter) → a node.
  await page.mouse.click(at(0.2, 0.3).x, at(0.2, 0.3).y, { button: 'right' });
  const popup = page.getByRole('dialog', { name: 'Add node' });
  await expect(popup.getByRole('group', { name: 'Inputs' })).toBeVisible();
  await expect(popup.getByRole('group', { name: 'Math' })).toBeVisible();
  await popup.getByLabel('Search nodes').fill('const');
  await expect(popup.getByRole('option')).toHaveCount(1);
  await popup.getByLabel('Search nodes').press('Enter');
  const [c1] = await nodesOfType('maths', 'constant', 1);
  await expect(node(page, c1!)).toBeVisible();
  // Space opens it too (at the pointer).
  await page.mouse.move(at(0.75, 0.3).x, at(0.75, 0.3).y);
  await page.keyboard.press('Space');
  await expect(popup).toBeVisible();
  await popup.getByLabel('Search nodes').fill('output');
  await popup.getByRole('option', { name: 'Output', exact: true }).click();
  const [out] = await nodesOfType('maths', 'output', 1);
  // A new graph without a connected output shows its problems (on the node and in the toolbar).
  await expect(node(page, out!)).toHaveAttribute('data-problems', /error/);
  // Observed in pixels: the canvas drew the node header (#2b3a52) and the red error badge.
  await expect.poll(async () => near(await pixelOn(page, c1!, (w) => w / 2, 6), [0x2b, 0x3a, 0x52])).toBe(true);
  await expect.poll(async () => near(await pixelOn(page, out!, (w) => w - 16.5, 13), [0xff, 0x5d, 0x5d], 40)).toBe(true);
  await expect(page.getByLabel('Graph problems')).toContainText(/[1-9] error/);

  // Drag from the constant's output to empty space: the catalogue lists only nodes that take a number.
  await drag(page, await centre(port(page, c1!, 'out', 'value')), at(0.45, 0.3));
  await expect(popup).toBeVisible();
  await expect(popup.getByRole('option', { name: 'Vector', exact: true })).toBeVisible();
  await expect(popup.getByRole('option', { name: 'Add', exact: true })).toBeVisible();
  await expect(popup.getByRole('option', { name: 'Toggle', exact: true })).toHaveCount(0);
  await expect(popup.getByRole('option', { name: 'Constant', exact: true })).toHaveCount(0);
  await popup.getByRole('option', { name: 'Vector', exact: true }).click();
  const [vec] = await nodesOfType('maths', 'vector', 1);
  await expect.poll(async () => (await graphOf('maths')).edges.map((e) => `${e.from.node}.${e.from.port}>${e.to.node}.${e.to.port}`)).toEqual([`${c1}.value>${vec}.x`]);

  // Port to port: vector → output.
  await drag(page, await centre(port(page, vec!, 'out', 'vector')), await centre(port(page, out!, 'in', 'value')));
  await expect.poll(async () => (await graphOf('maths')).edges.length).toBe(2);
  await expect(node(page, out!)).not.toHaveAttribute('data-problems', /error/);
  await expect(page.getByLabel('Graph problems')).toHaveText('0 errors, 0 warnings');

  // An implicit conversion (number → vector) replaces the output's single input and is named.
  await drag(page, await centre(port(page, c1!, 'out', 'value')), await centre(port(page, out!, 'in', 'value')));
  await expect(page.locator('.tl-graph__status')).toContainText('number → vector');
  await expect.poll(async () => (await graphOf('maths')).edges.filter((e) => e.to.node === out).map((e) => e.from.node)).toEqual([c1]);
  // …one project undo (Ctrl+Z) restores the replaced wire.
  await page.keyboard.press('Control+z');
  await expect.poll(async () => (await graphOf('maths')).edges.filter((e) => e.to.node === out).map((e) => e.from.node)).toEqual([vec]);

  // An incompatible wire (vector → number) is refused with the reason; nothing is sent.
  const add = await (async () => {
    await addFromCatalogue(page, at(0.45, 0.7), 'add', 'Add');
    return (await nodesOfType('maths', 'add', 1))[0]!;
  })();
  const edgesBefore = (await graphOf('maths')).edges.length;
  await drag(page, await centre(port(page, vec!, 'out', 'vector')), await centre(port(page, add, 'in', 'a')));
  await expect(page.locator('.tl-graph__status')).toContainText('cannot connect: a vector output cannot feed a number input');
  expect((await graphOf('maths')).edges.length).toBe(edgesBefore);

  // Box select two nodes, then drag one: both move, one undo puts both back.
  const before = await graphOf('maths');
  const pc = await centre(node(page, c1!));
  const pa = await centre(node(page, add));
  await page.mouse.click(at(0.98, 0.02).x, at(0.98, 0.1).y); // clear the selection (empty space)
  await drag(page, { x: Math.min(pc.x, pa.x) - 120, y: Math.min(pc.y, pa.y) - 70 }, { x: Math.max(pc.x, pa.x) + 120, y: Math.max(pc.y, pa.y) + 70 });
  await expect(node(page, c1!)).toHaveAttribute('aria-selected', 'true');
  await expect(node(page, add)).toHaveAttribute('aria-selected', 'true');
  await expect(node(page, out!)).toHaveAttribute('aria-selected', 'false');
  const zoom = parseFloat((await page.getByLabel('Zoom').textContent()) ?? '100') / 100;
  const h = await header(node(page, c1!));
  await drag(page, h, { x: h.x + 100 * zoom, y: h.y + 60 * zoom });
  await expect.poll(async () => {
    const g = await graphOf('maths');
    const moved = (id: string) => {
      const a = before.nodes.find((n) => n.id === id)!.position;
      const b = g.nodes.find((n) => n.id === id)!.position;
      return [b[0] - a[0], b[1] - a[1]];
    };
    return [moved(c1!), moved(add), moved(out!)];
  }).toEqual([[100, 60], [100, 60], [0, 0]]);
  await page.keyboard.press('Control+z');
  await expect.poll(async () => (await graphOf('maths')).nodes.map((n) => n.position)).toEqual(before.nodes.map((n) => n.position));

  // Keyboard: focus a node, arrow → one grid step (one edit per key press).
  await node(page, out!).focus();
  await expect(node(page, out!)).toHaveAttribute('aria-selected', 'true');
  const o0 = (await graphOf('maths')).nodes.find((n) => n.id === out)!.position;
  await page.keyboard.press('ArrowRight');
  await expect.poll(async () => (await graphOf('maths')).nodes.find((n) => n.id === out)!.position).toEqual([o0[0] + 20, o0[1]]);
  // Keyboard wiring: Enter on a port, Enter on another.
  await port(page, c1!, 'out', 'value').focus();
  await page.keyboard.press('Enter');
  await port(page, add, 'in', 'a').focus();
  await page.keyboard.press('Enter');
  await expect.poll(async () => (await graphOf('maths')).edges.some((e) => e.from.node === c1 && e.to.node === add && e.to.port === 'a')).toBe(true);

  // The Inspector edits the selected node's fields (one setNodeData).
  await node(page, c1!).click({ position: { x: 90, y: 40 } });
  const value = page.locator('.tl-dock--right').getByLabel('Value');
  await expect(value).toHaveValue('0');
  await value.fill('5');
  await value.press('Enter');
  await expect.poll(async () => (await graphOf('maths')).nodes.find((n) => n.id === c1)!.data).toEqual({ value: 5 });

  // Double-click a node's title: collapsed (and back from the Inspector checkbox).
  await page.mouse.dblclick((await header(node(page, add))).x, (await header(node(page, add))).y);
  await expect.poll(async () => (await graphOf('maths')).nodes.find((n) => n.id === add)!.collapsed).toBe(true);

  // An MCP edit shows up in the open editor.
  await mcp('graphEdit', { owner: { kind: 'graph', id: 'maths' }, ops: [{ op: 'addNodes', nodes: [{ id: 'from-mcp', type: 'toggle', position: [0, -200] }] }] });
  await page.keyboard.press('Shift+F');
  await expect(node(page, 'from-mcp')).toBeVisible();
  await expect(node(page, 'from-mcp')).toHaveAttribute('aria-label', /Toggle node from-mcp/);
});

test('graph editing: copy/paste (also into another graph), duplicate, delete, align, groups, comments, reroutes, pan/zoom/fit/minimap, Problems jump', async ({ page }) => {
  test.setTimeout(180_000);
  const { box } = await openEditor(page);
  const at = (fx: number, fy: number) => ({ x: box.x + box.width * fx, y: box.y + box.height * fy });
  // A starting graph through MCP: two constants into an add, an output; the add's result unused.
  await mcp('graphEdit', {
    owner: { kind: 'graph', id: 'maths' },
    ops: [
      { op: 'addNodes', nodes: [{ id: 'a', type: 'constant', position: [0, 0], data: { value: 1 } }, { id: 'b', type: 'constant', position: [0, 120] }, { id: 'sum', type: 'add', position: [260, 40] }, { id: 'out', type: 'output', position: [560, 40] }] },
      { op: 'connect', edges: [{ id: 'ea', from: { node: 'a', port: 'value' }, to: { node: 'sum', port: 'a' } }] },
    ],
  });
  await expect(node(page, 'sum')).toBeVisible();
  await page.keyboard.press('Shift+F');

  // Problems tab: the kind's diagnostics; a click opens the graph at the node.
  await page.getByRole('tab', { name: 'Problems' }).click();
  const issue = page.getByRole('button', { name: /Maths › Add \(sum\): Add: input "b" is not connected/ });
  await expect(issue).toBeVisible();
  await page.getByRole('tab', { name: 'Scene', exact: true }).click();
  await issue.click();
  await expect(page.getByRole('tab', { name: 'Graph: Maths' })).toHaveAttribute('aria-selected', 'true');
  await expect(node(page, 'sum')).toHaveAttribute('aria-selected', 'true');
  await expect(node(page, 'sum')).toBeFocused();

  // Copy a (with its value), paste at the pointer: a new id, same data.
  await node(page, 'a').click({ position: { x: 90, y: 40 } });
  await page.keyboard.press('Control+c');
  await page.mouse.move(at(0.3, 0.8).x, at(0.3, 0.8).y);
  await page.keyboard.press('Control+v');
  await expect.poll(async () => (await graphOf('maths')).nodes.filter((n) => n.type === 'constant').length).toBe(3);
  const pasted = (await graphOf('maths')).nodes.find((n) => n.type === 'constant' && !['a', 'b'].includes(n.id))!;
  expect(pasted.data).toEqual({ value: 1 });
  // Duplicate a + sum (their wire comes along, remapped).
  await node(page, 'a').click({ position: { x: 90, y: 40 } });
  await node(page, 'sum').click({ position: { x: 90, y: 40 }, modifiers: ['Shift'] });
  await page.keyboard.press('Control+d');
  await expect.poll(async () => (await graphOf('maths')).edges.length).toBe(2);
  const g1 = await graphOf('maths');
  const dupEdge = g1.edges.find((e) => e.id !== 'ea')!;
  expect(['a', 'sum']).not.toContain(dupEdge.from.node);
  expect(g1.nodes.find((n) => n.id === dupEdge.to.node)!.type).toBe('add');
  // The duplicates are selected once the edit is applied here.
  for (const n of g1.nodes.filter((x) => !['a', 'b', 'sum', 'out', pasted.id].includes(x.id))) await expect(node(page, n.id)).toHaveAttribute('aria-selected', 'true');
  await expect(node(page, 'a')).toHaveAttribute('aria-selected', 'false');
  // Delete the duplicates (Delete key): their wire goes with them.
  await page.keyboard.press('Delete');
  await expect.poll(async () => (await graphOf('maths')).edges.map((e) => e.id)).toEqual(['ea']);
  // Cut the pasted constant.
  await node(page, pasted.id).click({ position: { x: 90, y: 40 } });
  await page.keyboard.press('Control+x');
  await expect.poll(async () => (await graphOf('maths')).nodes.some((n) => n.id === pasted.id)).toBe(false);

  // Align: a and b to the same left edge (they are), then top edges.
  await node(page, 'b').click({ position: { x: 90, y: 40 } });
  await node(page, 'sum').click({ position: { x: 90, y: 40 }, modifiers: ['Shift'] });
  await page.getByRole('button', { name: 'Align top edges' }).click();
  await expect.poll(async () => {
    const g = await graphOf('maths');
    return g.nodes.find((n) => n.id === 'sum')!.position[1] === g.nodes.find((n) => n.id === 'b')!.position[1];
  }).toBe(true);

  // Group the selection (Ctrl+G), rename it, drag it by its title: the nodes inside move along.
  await page.keyboard.press('Control+g');
  await expect.poll(async () => (await graphOf('maths')).groups?.length ?? 0).toBe(1);
  const group = page.locator('[data-group-id]');
  await page.mouse.dblclick((await centre(group)).x, (await centre(group)).y);
  await page.getByLabel('Edit group title').fill('Sums');
  await page.getByLabel('Edit group title').press('Enter');
  await expect.poll(async () => (await graphOf('maths')).groups?.[0]?.title).toBe('Sums');
  const gBefore = await graphOf('maths');
  const zoom = parseFloat((await page.getByLabel('Zoom').textContent()) ?? '100') / 100;
  const gc = await centre(group);
  await drag(page, gc, { x: gc.x + 80 * zoom, y: gc.y + 40 * zoom });
  await expect.poll(async () => {
    const g = await graphOf('maths');
    const d = (id: string) => g.nodes.find((n) => n.id === id)!.position[0] - gBefore.nodes.find((n) => n.id === id)!.position[0];
    // b and sum (grouped) move with the frame; out lies outside it and stays.
    return [d('b'), d('sum'), d('out'), g.groups![0]!.rect[0] - gBefore.groups![0]!.rect[0]];
  }).toEqual([80, 80, 0, 80]);

  // A comment: toolbar → type → stored.
  await page.mouse.move(at(0.6, 0.85).x, at(0.6, 0.85).y);
  await page.getByRole('button', { name: 'Comment', exact: true }).click();
  const text = page.getByLabel('Edit comment');
  await expect(text).toBeFocused();
  await text.fill('Adds two numbers');
  await page.locator('.tl-graph__toolbar').click({ position: { x: 5, y: 5 } });
  await expect.poll(async () => (await graphOf('maths')).comments?.map((c) => c.text)).toEqual(['Adds two numbers']);

  // A reroute point: double-click the wire a → sum.
  await page.keyboard.press('Shift+F');
  const pa = await centre(port(page, 'a', 'out', 'value'));
  const ps = await centre(port(page, 'sum', 'in', 'a'));
  const mid = await page.evaluate(({ pa, ps }) => {
    // The wire is a symmetric cubic: its midpoint is the midpoint of the two ports.
    return { x: (pa.x + ps.x) / 2, y: (pa.y + ps.y) / 2 };
  }, { pa, ps });
  await page.mouse.dblclick(mid.x, mid.y);
  await expect.poll(async () => (await graphOf('maths')).edges.find((e) => e.id === 'ea')!.reroutes?.length ?? 0).toBe(1);

  // Pan (middle drag) moves the view; zoom keeps the point under the cursor; Fit; the minimap moves the view.
  const layer = page.locator('.tl-graph__layer');
  const t0 = await layer.getAttribute('style');
  await drag(page, at(0.5, 0.5), at(0.6, 0.55), 'middle');
  await expect.poll(() => layer.getAttribute('style')).not.toBe(t0);
  const sumBox0 = (await node(page, 'sum').boundingBox())!;
  const cursor = { x: sumBox0.x + 20, y: sumBox0.y + 20 };
  await page.mouse.move(cursor.x, cursor.y);
  const z0 = await page.getByLabel('Zoom').textContent();
  await page.mouse.wheel(0, -240);
  await expect.poll(() => page.getByLabel('Zoom').textContent()).not.toBe(z0);
  const sumBox1 = (await node(page, 'sum').boundingBox())!;
  const scale = sumBox1.width / sumBox0.width;
  expect(scale).toBeGreaterThan(1.05);
  // The graph point under the cursor stays under it (within a pixel or two).
  expect(Math.abs(sumBox1.x + 20 * scale - cursor.x)).toBeLessThan(3);
  expect(Math.abs(sumBox1.y + 20 * scale - cursor.y)).toBeLessThan(3);
  const t1 = await layer.getAttribute('style');
  const mini = (await page.getByRole('img', { name: 'Minimap' }).boundingBox())!;
  await page.mouse.click(mini.x + 10, mini.y + 10);
  await expect.poll(() => layer.getAttribute('style')).not.toBe(t1);
  await page.getByRole('button', { name: 'Fit', exact: true }).click();

  // Paste into another graph of the same kind (another document of the kind).
  await node(page, 'a').click({ position: { x: 90, y: 40 } });
  await node(page, 'sum').click({ position: { x: 90, y: 40 }, modifiers: ['Shift'] });
  await page.keyboard.press('Control+c');
  await page.getByRole('tab', { name: 'Graphs' }).click();
  await page.getByLabel('New graph name').fill('Other');
  await page.getByRole('button', { name: 'Create graph' }).click();
  await expect(page.getByRole('tab', { name: 'Graph: Other' })).toHaveAttribute('aria-selected', 'true');
  await page.locator('.tl-graph').focus();
  await page.keyboard.press('Control+v');
  await expect.poll(async () => (await graphOf('other')).nodes.map((n) => n.type).sort()).toEqual(['add', 'constant']);
  const other = await graphOf('other');
  expect(other.edges).toHaveLength(1);
  expect(other.nodes.map((n) => n.id)).not.toContain('a');
  // The source graph is unchanged by the paste.
  expect((await graphOf('maths')).nodes.map((n) => n.id).sort()).toEqual(['a', 'b', 'out', 'sum']);
});

test('graph editing: a 2000-node graph renders, fits, zooms and pans in the editor; graphs survive a backend restart', async ({ page }) => {
  test.setTimeout(180_000);
  await openEditor(page);
  // 2000 nodes in a 50 × 40 grid, chained by 1999 wires, sent as five graph edits (the request cap is 64 KiB).
  const N = 2000;
  const per = 400;
  for (let k = 0; k < N / per; k++) {
    const nodes = Array.from({ length: per }, (_, j) => {
      const i = k * per + j;
      return { id: `n${i}`, type: 'label', position: [(i % 50) * 220, Math.floor(i / 50) * 120] };
    });
    const edges = nodes.map((n) => Number(n.id.slice(1))).filter((i) => i > 0).map((i) => ({ id: `e${i}`, from: { node: `n${i - 1}`, port: 'out' }, to: { node: `n${i}`, port: 'in' } }));
    await mcp('graphEdit', { owner: { kind: 'graph', id: 'maths' }, ops: [{ op: 'addNodes', nodes }, { op: 'connect', edges }] });
  }
  await expect.poll(async () => (await graphOf('maths')).nodes.length, { timeout: 20_000 }).toBe(N);
  await page.locator('.tl-graph').focus();
  await page.keyboard.press('Shift+F');
  await expect.poll(async () => parseFloat((await page.getByLabel('Zoom').textContent()) ?? '100')).toBeLessThan(20);
  // Zoomed out, the canvas draws every node; only a bounded number get DOM elements.
  expect(await page.locator('.tl-graph__node').count()).toBeLessThanOrEqual(400);
  // Observed in pixels: node bodies cover a good part of the canvas.
  const canvas = page.locator('.tl-graph__canvas');
  const img = decodePng(await canvas.screenshot());
  let lit = 0;
  for (let y = 0; y < img.height; y += 8) for (let x = 0; x < img.width; x += 8) if (img.pixel(x, y)[2] > 40) lit++;
  expect(lit).toBeGreaterThan(50);
  // Zoom in at the centre and pan: each step redraws (timing logged and bounded loosely — the
  // numbers that decided the rendering are from tools/bench-graph-render.mjs).
  const cb = (await canvas.boundingBox())!;
  const cx = cb.x + cb.width / 2;
  const cy = cb.y + cb.height / 2;
  await page.mouse.move(cx, cy);
  const t0 = Date.now();
  for (let i = 0; i < 20; i++) await page.mouse.wheel(0, -120);
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => r(null))));
  const zoomMs = (Date.now() - t0) / 20;
  const t1 = Date.now();
  await page.mouse.down({ button: 'middle' });
  for (let i = 1; i <= 20; i++) await page.mouse.move(cx - i * 15, cy - i * 5);
  await page.mouse.up({ button: 'middle' });
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => r(null))));
  const panMs = (Date.now() - t1) / 20;
  console.log(`[graph 2000 nodes] zoom step ${zoomMs.toFixed(1)} ms, pan step ${panMs.toFixed(1)} ms (CPU raster, includes the test driver's round trip)`);
  expect(zoomMs).toBeLessThan(500);
  expect(panMs).toBeLessThan(500);
  // Zoomed in, the nodes in view are focusable DOM elements again.
  await expect.poll(() => page.locator('.tl-graph__node').count()).toBeGreaterThan(0);

  // The graph is project data: it survives a backend restart and a reload.
  await be.restart();
  await page.reload();
  await expect(page.locator('.tl-statusbar')).toContainText('connected');
  await page.getByRole('tab', { name: 'Graphs' }).click();
  await expect(page.locator('[data-graph-id="maths"]')).toContainText('2000 nodes');
  await page.getByRole('button', { name: 'Open Maths' }).click();
  await expect(page.getByRole('tab', { name: 'Graph: Maths' })).toHaveAttribute('aria-selected', 'true');
  expect((await graphOf('maths')).edges).toHaveLength(N - 1);
});
