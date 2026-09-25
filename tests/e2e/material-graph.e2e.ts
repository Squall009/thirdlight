/**
 * Phase 18.0/18.1: graph materials in the browser against the real backend.
 * A new graph material opens as a "Material: <name>" centre tab on the graph
 * framework with the material catalogue; nodes are added through the
 * search catalogue, a texture × tint is wired into the PBR output's base
 * colour (the multiply takes the vec3 width of its wires), each gesture is
 * one graphEdit on owner kind `material` (checked in the backend), the
 * graph survives a reload and one Ctrl+Z undoes the last wire. "Convert to
 * graph" turns a standard material into an equivalent graph. The graph's
 * rendering waits for the graph compiler (18.3): the tab says so.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect, test, type Locator, type Page } from '@playwright/test';

import { startBackend, type E2EBackend } from './backend';
import { makePng } from './png-make';
import { menu } from './ui';

let be: E2EBackend;
let dir: string;
test.beforeEach(async () => {
  be = await startBackend();
  dir = mkdtempSync(join(tmpdir(), 'tl-e2e-matgraph-'));
});
test.afterEach(async () => {
  await be.stop();
  rmSync(dir, { recursive: true, force: true });
});

interface GNode { id: string; type: string; position: [number, number]; data?: Record<string, unknown> }
interface GEdge { id: string; from: { node: string; port: string }; to: { node: string; port: string } }
interface Mat { materialId: string; name: string; shader: string; graph?: { nodes: GNode[]; edges: GEdge[] }; parameters?: unknown[] }

async function materials(): Promise<Mat[]> {
  const r = await be.command({ op: 'queryGameConfig', projectId: be.projectId, args: {} });
  return (r.materials ?? []) as Mat[];
}
async function graphMaterial(): Promise<Mat> {
  await expect.poll(async () => (await materials()).filter((m) => m.graph !== undefined).length, { timeout: 10_000 }).toBeGreaterThan(0);
  return (await materials()).find((m) => m.graph !== undefined)!;
}
async function nodesOfType(type: string, count: number): Promise<string[]> {
  await expect.poll(async () => (await graphMaterial()).graph!.nodes.filter((n) => n.type === type).length, { timeout: 10_000 }).toBe(count);
  return (await graphMaterial()).graph!.nodes.filter((n) => n.type === type).map((n) => n.id);
}
const wires = async (): Promise<string[]> => (await graphMaterial()).graph!.edges.map((e) => `${e.from.node}.${e.from.port}>${e.to.node}.${e.to.port}`).sort();

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
async function importTexture(page: Page, file: string): Promise<void> {
  await page.getByRole('tab', { name: 'Assets' }).click();
  await page.locator('.tl-assets__file').first().setInputFiles(file);
  const publish = page.getByRole('button', { name: 'publish' });
  await expect(publish).toBeEnabled({ timeout: 15_000 });
  await publish.click();
  await expect(page.locator('.tl-assets__status')).toContainText('committed', { timeout: 10_000 });
}

test('a graph material: new tab, nodes from the catalogue, texture × tint into PBR base colour, reload keeps it, undo', async ({ page }) => {
  test.setTimeout(180_000);
  const checker = join(dir, 'checker.png');
  writeFileSync(checker, makePng(32, 32, (x, y) => (((x >> 3) + (y >> 3)) % 2 === 0 ? [30, 60, 230, 255] : [240, 240, 240, 255])));
  await page.goto(be.editorUrl);
  await expect(page.locator('.tl-statusbar')).toContainText('connected');
  await importTexture(page, checker);

  // Materials → "+ new graph material": the material opens as a centre tab with a PBR output.
  await page.getByRole('tab', { name: 'Materials' }).click();
  await page.getByRole('button', { name: '+ new graph material' }).click();
  const tab = page.getByRole('tab', { name: 'Material: Graph material 1' });
  await expect(tab).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('.tl-materials li[data-material-id]')).toContainText('graph');
  const stage = page.locator('.tl-graph__stage');
  await expect(stage).toBeVisible();
  // 17.4 has not landed: the tab says where the preview comes from.
  await expect(page.getByRole('note')).toContainText('Preview arrives with the WebGPU renderer');
  const [out] = await nodesOfType('pbr', 1);
  await expect(node(page, out!)).toBeVisible();
  await expect(port(page, out!, 'in', 'baseColor')).toHaveAttribute('aria-label', /base colour \(vec3\)/);

  // Nodes from the search catalogue (material categories).
  const box = (await stage.boundingBox())!;
  const at = (fx: number, fy: number) => ({ x: box.x + box.width * fx, y: box.y + box.height * fy });
  await page.mouse.click(at(0.1, 0.15).x, at(0.1, 0.15).y, { button: 'right' });
  const popup = page.getByRole('dialog', { name: 'Add node' });
  for (const cat of ['Inputs', 'Maths', 'Textures', 'Utility', 'Output']) await expect(popup.getByRole('group', { name: cat })).toBeVisible();
  await page.keyboard.press('Escape');
  await addFromCatalogue(page, at(0.08, 0.15), 'sample', 'Sample texture');
  const [tex] = await nodesOfType('sampleTexture', 1);
  await addFromCatalogue(page, at(0.08, 0.6), 'colour', 'Colour');
  const [tint] = await nodesOfType('color', 1);
  await addFromCatalogue(page, at(0.3, 0.3), 'multiply', 'Multiply');
  const [mul] = await nodesOfType('multiply', 1);
  // An unconnected auto multiply is a float.
  await expect(port(page, mul!, 'out', 'out')).toHaveAttribute('aria-label', /out \(float\)/);

  // The Inspector edits the nodes: the texture asset and the tint colour.
  await node(page, tex!).click({ position: { x: 90, y: 8 } });
  const inspector = page.locator('.tl-dock--right');
  await inspector.getByLabel('Texture', { exact: true }).selectOption({ label: 'checker' });
  await expect.poll(async () => (await graphMaterial()).graph!.nodes.find((n) => n.id === tex)!.data?.['texture']).toMatch(/^[a-z0-9]/);
  await node(page, tint!).click({ position: { x: 90, y: 8 } });
  await inspector.getByLabel('Colour', { exact: true }).fill('#ff8800');
  await expect.poll(async () => (await graphMaterial()).graph!.nodes.find((n) => n.id === tint)!.data?.['color']).toBe('#ff8800');

  // Wire texture.rgb × tint.rgb → PBR base colour: the multiply takes the vec3 width.
  await drag(page, await centre(port(page, tex!, 'out', 'rgb')), await centre(port(page, mul!, 'in', 'a')));
  await expect.poll(wires).toEqual([`${tex}.rgb>${mul}.a`]);
  await drag(page, await centre(port(page, tint!, 'out', 'rgb')), await centre(port(page, mul!, 'in', 'b')));
  await expect.poll(wires).toEqual([`${tex}.rgb>${mul}.a`, `${tint}.rgb>${mul}.b`].sort());
  await expect(port(page, mul!, 'out', 'out')).toHaveAttribute('aria-label', /out \(vec3\)/);
  await drag(page, await centre(port(page, mul!, 'out', 'out')), await centre(port(page, out!, 'in', 'baseColor')));
  await expect.poll(wires).toEqual([`${mul}.out>${out}.baseColor`, `${tex}.rgb>${mul}.a`, `${tint}.rgb>${mul}.b`].sort());
  // A value cannot feed the texture input: refused in the editor, nothing sent.
  await drag(page, await centre(port(page, tint!, 'out', 'alpha')), await centre(port(page, tex!, 'in', 'tex')));
  await expect(page.locator('.tl-graph__status')).toContainText('cannot connect');
  expect(await wires()).toHaveLength(3);

  // A reload keeps the graph and the tab.
  const before = JSON.stringify((await graphMaterial()).graph);
  await page.reload();
  await expect(page.locator('.tl-statusbar')).toContainText('connected', { timeout: 30_000 });
  await expect(page.getByRole('tab', { name: 'Material: Graph material 1' })).toHaveAttribute('aria-selected', 'true');
  await expect(node(page, mul!)).toBeVisible();
  await expect(port(page, mul!, 'out', 'out')).toHaveAttribute('aria-label', /out \(vec3\)/);
  expect(JSON.stringify((await graphMaterial()).graph)).toBe(before);

  // One project undo takes back the last wire (and only it).
  await page.locator('.tl-graph').focus();
  await page.keyboard.press('Control+z');
  await expect.poll(wires).toEqual([`${tex}.rgb>${mul}.a`, `${tint}.rgb>${mul}.b`].sort());
  await expect(page.locator('[data-edge-id]')).toHaveCount(2);
});

test('Convert to graph turns a standard material into an equivalent graph and opens it', async ({ page }) => {
  test.setTimeout(120_000);
  await page.goto(be.editorUrl);
  await expect(page.locator('.tl-statusbar')).toContainText('connected');
  await page.getByRole('tab', { name: 'Materials' }).click();
  await page.getByRole('button', { name: '+ new material' }).click();
  await expect(page.locator('.tl-materials li[data-material-id]')).toHaveCount(1);
  await page.getByRole('spinbutton', { name: 'roughness', exact: true }).fill('0.3');
  await page.getByRole('spinbutton', { name: 'roughness', exact: true }).blur();
  await expect.poll(async () => (await materials())[0]?.shader === 'standard' && JSON.stringify(await materials()).includes('"roughness":0.3')).toBe(true);
  await page.getByRole('button', { name: 'Convert to graph' }).click();
  await expect(page.getByRole('tab', { name: 'Material: Material 1' })).toHaveAttribute('aria-selected', 'true');
  const m = await graphMaterial();
  expect(m.shader).toBe('standard');
  const rough = m.graph!.nodes.find((n) => n.id === 'roughness')!;
  expect(rough.data?.['value']).toBe(0.3);
  expect(m.graph!.edges.some((e) => e.from.node === 'roughness' && e.to.node === 'output' && e.to.port === 'roughness')).toBe(true);
  await expect(node(page, 'output')).toBeVisible();
  // The Materials tab shows it as a graph material now.
  await expect(page.locator('.tl-materials li[data-material-id]')).toContainText('graph');
  await expect(page.getByRole('button', { name: 'Open graph' })).toBeVisible();
});

let seq = 0;
async function cmd(op: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const q = await be.command({ op: 'queryProject', projectId: be.projectId, args: {} });
  seq += 1;
  const r = await be.command({ op, projectId: be.projectId, expectedRevision: q['revision'], requestId: `req-${(0x18e2e000 + seq).toString(16).padStart(32, '0')}`, origin: { kind: 'mcp', clientId: 'e2e-material-graph' }, args });
  expect(r['ok'], JSON.stringify(r)).toBe(true);
  return r;
}
async function components(id: string): Promise<Record<string, unknown>> {
  const r = await be.command({ op: 'queryEntity', projectId: be.projectId, args: { entityId: id } });
  return (r['entity'] as { components: Record<string, unknown> }).components;
}

test('a material function call takes its ports from the function; an object overrides a public parameter in the Inspector', async ({ page }) => {
  test.setTimeout(120_000);
  // A material function (a standalone graph) and a graph material with a public and a private parameter, made through MCP.
  await cmd('setGraph', {
    graph: {
      graphId: 'scale-color',
      kind: 'material-function',
      name: 'Scale colour',
      graph: {
        nodes: [
          { id: 'inColor', type: 'functionInput', position: [0, 0], data: { name: 'color', type: 'vec3' } },
          { id: 'inAmount', type: 'functionInput', position: [0, 120], data: { name: 'amount' } },
          { id: 'mul', type: 'multiply', position: [220, 0] },
          { id: 'result', type: 'functionOutput', position: [440, 0], data: { name: 'result', type: 'vec3' } },
        ],
        edges: [
          { id: 'e1', from: { node: 'inColor', port: 'value' }, to: { node: 'mul', port: 'a' } },
          { id: 'e2', from: { node: 'inAmount', port: 'value' }, to: { node: 'mul', port: 'b' } },
          { id: 'e3', from: { node: 'mul', port: 'out' }, to: { node: 'result', port: 'value' } },
        ],
      },
    },
  });
  await cmd('setMaterial', {
    material: {
      materialId: 'mat-glow',
      name: 'Glow',
      shader: 'standard',
      params: {},
      textures: {},
      parameters: [
        { key: 'tint', type: 'color', default: '#ffffff', label: 'Tint' },
        { key: 'secret', type: 'float', default: 1, visibility: 'private' },
      ],
      graph: { nodes: [{ id: 'output', type: 'pbr', position: [500, 0] }], edges: [] },
    },
  });
  await page.goto(be.editorUrl);
  await expect(page.locator('.tl-statusbar')).toContainText('connected');

  // Open the material from its tile (double-click) and add a Function call: it runs the project's function.
  await page.getByRole('tab', { name: 'Materials' }).click();
  await page.locator('.tl-materials li[data-material-id="mat-glow"]').dblclick();
  await expect(page.getByRole('tab', { name: 'Material: Glow' })).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByLabel('exposed parameters').locator('[data-parameter]')).toHaveCount(2);
  const stage = page.locator('.tl-graph__stage');
  const box = (await stage.boundingBox())!;
  await addFromCatalogue(page, { x: box.x + box.width * 0.15, y: box.y + box.height * 0.3 }, 'function', 'Function call');
  const [call] = await nodesOfType('call', 1);
  expect((await graphMaterial()).graph!.nodes.find((n) => n.id === call)!.data).toEqual({ function: 'scale-color' });
  await expect(port(page, call!, 'in', 'inColor')).toHaveAttribute('aria-label', /input color \(vec3\)/);
  await expect(port(page, call!, 'in', 'inAmount')).toHaveAttribute('aria-label', /input amount \(float\)/);
  await drag(page, await centre(port(page, call!, 'out', 'result')), await centre(port(page, 'output', 'in', 'baseColor')));
  await expect.poll(wires).toEqual([`${call}.result>output.baseColor`]);
  // A Parameter node reads a declared parameter (its type is the declaration's: a colour is a vec3).
  await addFromCatalogue(page, { x: box.x + box.width * 0.05, y: box.y + box.height * 0.7 }, 'parameter', 'Parameter');
  const [param] = await nodesOfType('parameter', 1);
  await expect(port(page, param!, 'out', 'value')).toHaveAttribute('aria-label', /value \(vec3\)/);

  // A box using the material: the Inspector's Materials section offers the public parameter only.
  await page.getByRole('tab', { name: 'Scene', exact: true }).click();
  await menu(page, 'GameObject', 'Box');
  const row = page.locator('.tl-hierarchy__list li.tl-row.is-selected');
  await expect(row).toContainText('box');
  const id = (await row.getAttribute('data-entity-id'))!;
  const inspector = page.locator('.tl-inspector');
  await inspector.getByRole('combobox', { name: 'material for all' }).selectOption({ label: 'Glow' });
  await expect.poll(async () => (await components(id))['materials']).toEqual({ '*': 'mat-glow' });
  const overrides = inspector.getByLabel('material parameter overrides');
  await expect(overrides.locator('[data-param="tint"]')).toHaveCount(1);
  await expect(overrides.locator('[data-param="secret"]')).toHaveCount(0);
  await overrides.getByLabel('Glow tint', { exact: true }).fill('#00ff00');
  await expect.poll(async () => (await components(id))['materialParams']).toEqual({ 'mat-glow': { tint: '#00ff00' } });
  await expect(overrides.locator('[data-param="tint"]')).toHaveClass(/is-set/);
  await overrides.getByRole('button', { name: 'reset Glow tint' }).click();
  await expect.poll(async () => (await components(id))['materialParams']).toBeUndefined();
});
