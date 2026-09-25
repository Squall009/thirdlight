/**
 * Phase 18.2: the Material tab against the real backend — the live preview
 * (sphere / plane / cube / a model of the project, in the project
 * environment, compiled on the editor's renderer), a new graph material from
 * a built-in template, "Convert to graph" for the wind, kit and water shaders,
 * and compile problems on their node and in the Problems tab (a click opens
 * the tab at the node). The pixel equality of converted materials is the
 * shader-parity spec's (`graph=1`).
 *
 * Runs per renderer: `auto` in `default` (WebGL 2 there), `webgpu` in `webgpu`.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect, test, type Locator, type Page } from '@playwright/test';

import { startBackend, type E2EBackend } from './backend';
import { KIT_PIECES, multiPieceGlb } from './multi-piece-glb';
import { decodePng, type Image } from './png';
import { makePng } from './png-make';
import { backendOf, editorUrlFor, onlyInItsProject, type RendererVariant } from './renderer-variants';

let be: E2EBackend;
let dir: string;
test.beforeEach(async () => {
  be = await startBackend();
  dir = mkdtempSync(join(tmpdir(), 'tl-e2e-matpreview-'));
});
test.afterEach(async () => {
  await be.stop();
  rmSync(dir, { recursive: true, force: true });
});

let seq = 0;
async function cmd(op: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const q = await be.command({ op: 'queryProject', projectId: be.projectId, args: {} });
  seq += 1;
  const r = await be.command({ op, projectId: be.projectId, expectedRevision: q['revision'], requestId: `req-${(0x18f2e000 + seq).toString(16).padStart(32, '0')}`, origin: { kind: 'mcp', clientId: 'e2e-material-preview' }, args });
  expect(r['ok'], JSON.stringify(r)).toBe(true);
  return r;
}
interface Mat { materialId: string; name: string; shader: string; graph?: { nodes: { id: string; type: string; data?: Record<string, unknown> }[] }; parameters?: { key: string }[] }
async function materials(): Promise<Mat[]> {
  return ((await be.command({ op: 'queryGameConfig', projectId: be.projectId, args: {} })).materials ?? []) as Mat[];
}
async function importFile(page: Page, file: string): Promise<void> {
  await page.getByRole('tab', { name: 'Assets' }).click();
  await page.locator('.tl-assets__file').first().setInputFiles(file);
  const publish = page.getByRole('button', { name: 'publish' });
  await expect(publish).toBeEnabled({ timeout: 15_000 });
  await publish.click();
  await expect(page.locator('.tl-assets__status')).toContainText('committed', { timeout: 10_000 });
}
const shot = async (l: Locator): Promise<Image> => decodePng(await l.screenshot());
/** The share of pixels (every 2nd) whose colour satisfies `test`. */
function share(img: Image, test: (r: number, g: number, b: number) => boolean): number {
  let n = 0;
  let all = 0;
  for (let y = 0; y < img.height; y += 2) for (let x = 0; x < img.width; x += 2) {
    const [r, g, b] = img.pixel(x, y);
    all += 1;
    if (test(r, g, b)) n += 1;
  }
  return n / all;
}
function changed(a: Image, b: Image): number {
  let n = 0;
  for (let y = 0; y < Math.min(a.height, b.height); y += 2) for (let x = 0; x < Math.min(a.width, b.width); x += 2) {
    const p = a.pixel(x, y);
    const q = b.pixel(x, y);
    if (Math.abs(p[0] - q[0]) + Math.abs(p[1] - q[1]) + Math.abs(p[2] - q[2]) > 40) n += 1;
  }
  return n;
}
const orange = (r: number, g: number, b: number): boolean => r > 90 && r > 1.4 * g && g > 1.4 * b;
const red = (r: number, g: number, b: number): boolean => r > 150 && g < 60 && b < 60;

const VARIANTS: readonly RendererVariant[] = ['auto', 'webgpu'];

for (const variant of VARIANTS) test(`the Material tab previews the graph on a sphere, a plane, a cube and a model in the project environment (${variant})`, async ({ page }) => {
  onlyInItsProject(variant);
  test.setTimeout(240_000);
  const glb = join(dir, 'kit.glb');
  writeFileSync(glb, multiPieceGlb(KIT_PIECES));
  // An orange unlit-looking PBR graph (emissive orange, black base) — its colour does not depend on the light.
  await cmd('setMaterial', {
    material: {
      materialId: 'mat-orange',
      name: 'Orange',
      shader: 'standard',
      params: {},
      textures: {},
      graph: {
        nodes: [
          { id: 'output', type: 'pbr', position: [400, 0] },
          { id: 'black', type: 'color', position: [0, 0], data: { color: '#000000' } },
          { id: 'glow', type: 'color', position: [0, 150], data: { color: '#ff8000' } },
        ],
        edges: [
          { id: 'w1', from: { node: 'black', port: 'rgb' }, to: { node: 'output', port: 'baseColor' } },
          { id: 'w2', from: { node: 'glow', port: 'rgb' }, to: { node: 'output', port: 'emissive' } },
        ],
      },
    },
  });
  await page.goto(editorUrlFor(be.editorUrl, variant));
  await expect(page.locator('.tl-statusbar')).toContainText('connected');
  await importFile(page, glb);
  await page.getByRole('tab', { name: 'Materials' }).click();
  await page.locator('.tl-materials li[data-material-id="mat-orange"]').dblclick();
  await expect(page.getByRole('tab', { name: 'Material: Orange' })).toHaveAttribute('aria-selected', 'true');
  const canvas = page.getByLabel('material preview canvas');
  await expect.poll(() => canvas.getAttribute('data-tl-renderer'), { timeout: 30_000 }).toBe(backendOf(variant));
  await expect(page.getByLabel('material preview').getByRole('status')).toContainText(backendOf(variant));

  // The sphere glows orange (no project environment yet: a neutral backdrop).
  await expect.poll(async () => share(await shot(canvas), orange), { timeout: 30_000 }).toBeGreaterThan(0.2);
  const sphere = await shot(canvas);
  const sphereShare = share(sphere, orange);
  // Plane and cube: other silhouettes of the same material.
  const shape = page.getByLabel('preview shape');
  await shape.selectOption('plane');
  await expect.poll(async () => changed(sphere, await shot(canvas)), { timeout: 20_000 }).toBeGreaterThan(300);
  await expect.poll(async () => share(await shot(canvas), orange)).toBeGreaterThan(0.1);
  await shape.selectOption('cube');
  await expect.poll(async () => Math.abs(share(await shot(canvas), orange) - sphereShare), { timeout: 20_000 }).toBeGreaterThan(0.01);
  const cube = await shot(canvas);
  // A model of the project wears it too.
  await shape.selectOption('model');
  await expect(page.getByLabel('preview model')).toHaveValue(/.+/);
  await expect.poll(async () => changed(cube, await shot(canvas)), { timeout: 30_000 }).toBeGreaterThan(300);
  await expect.poll(async () => share(await shot(canvas), orange)).toBeGreaterThan(0.02);

  // The project environment: a red colour sky shows behind the object.
  await shape.selectOption('sphere');
  expect(share(await shot(canvas), red)).toBeLessThan(0.05);
  await cmd('setEnvironment', { environment: { sky: { mode: 'color', color: '#ff0000', intensity: 1, environmentIntensity: 0 } } });
  await expect(page.getByLabel('material preview').getByRole('status')).toContainText('project environment');
  await expect.poll(async () => share(await shot(canvas), red), { timeout: 30_000 }).toBeGreaterThan(0.3);
  await expect.poll(async () => share(await shot(canvas), orange)).toBeGreaterThan(0.1);

  // A graph edit shows in the preview: the glow turns blue.
  await cmd('graphEdit', { owner: { kind: 'material', id: 'mat-orange' }, ops: [{ op: 'setNodeData', id: 'glow', data: { color: '#0040ff' } }] });
  await expect.poll(async () => share(await shot(canvas), (r, g, b) => b > 150 && b > 2 * r), { timeout: 30_000 }).toBeGreaterThan(0.1);
});

test('templates, Convert to graph for wind/kit/water, and compile problems on the node and in the Problems tab', async ({ page }) => {
  test.skip(test.info().project.name !== 'default', 'renderer-independent UI (the pixels are shader-parity\'s)');
  test.setTimeout(180_000);
  const checker = join(dir, 'checker.png');
  writeFileSync(checker, makePng(16, 16, (x, y) => (((x >> 2) + (y >> 2)) % 2 === 0 ? [240, 240, 240, 255] : [30, 30, 30, 255])));
  await page.goto(be.editorUrl);
  await expect(page.locator('.tl-statusbar')).toContainText('connected');
  await importFile(page, checker);
  await page.getByRole('tab', { name: 'Materials' }).click();

  // "+ new graph material" from the water template: its graph and public parameters.
  await page.getByLabel('graph material template').selectOption('water');
  await page.getByRole('button', { name: '+ new graph material' }).click();
  await expect(page.getByRole('tab', { name: 'Material: Graph material 1' })).toHaveAttribute('aria-selected', 'true');
  await expect.poll(async () => (await materials())[0]?.graph?.nodes.some((n) => n.type === 'fresnel') ?? false).toBe(true);
  expect(((await materials())[0]!.parameters ?? []).map((p) => p.key).sort()).toEqual(['color', 'fresnel', 'shallowColor']);
  await expect(page.getByLabel('exposed parameters').locator('[data-parameter]')).toHaveCount(3);

  // Convert to graph: enabled for every shader type; foliage becomes a wind graph, kit a world-UV graph, water a fresnel graph.
  await page.getByRole('tab', { name: 'Materials' }).click();
  for (const [shader, expectType] of [['foliage', 'vertexOffset'], ['kit', 'objectPosition'], ['water', 'fresnel']] as const) {
    const count = (await materials()).length;
    await page.getByRole('button', { name: '+ new material' }).click();
    await expect.poll(async () => (await materials()).length).toBe(count + 1);
    await page.getByRole('combobox', { name: 'shader' }).selectOption(shader);
    // The editor has the new shader (Convert reads its copy of the material).
    await expect(page.locator('.tl-materials li.is-selected .tl-tile__meta')).toHaveText(shader);
    if (shader === 'kit') {
      // The world-X shift moves the kit's textures: give it one.
      await page.getByRole('combobox', { name: 'texture map' }).selectOption({ label: 'checker' });
      await expect.poll(async () => JSON.stringify((await materials()).find((m) => m.shader === 'kit'))).toContain('"map"');
      await expect(page.getByRole('combobox', { name: 'texture map' })).not.toHaveValue('');
    }
    const convert = page.getByRole('button', { name: 'Convert to graph' });
    await expect(convert).toBeEnabled();
    await convert.click();
    await expect.poll(async () => (await materials()).find((m) => m.shader === shader && m.graph !== undefined)?.graph?.nodes.some((n) => n.type === expectType) ?? false).toBe(true);
    await page.getByRole('tab', { name: 'Materials' }).click();
  }

  // A compile problem: a Sample texture without a texture reads white — a warning on its node and in the Problems tab.
  await cmd('setMaterial', {
    material: {
      materialId: 'mat-empty-tex',
      name: 'Empty texture',
      shader: 'standard',
      params: {},
      textures: {},
      graph: {
        nodes: [
          { id: 'output', type: 'pbr', position: [400, 0] },
          { id: 'sampler', type: 'sampleTexture', position: [0, 0] },
        ],
        edges: [{ id: 'w1', from: { node: 'sampler', port: 'rgb' }, to: { node: 'output', port: 'baseColor' } }],
      },
    },
  });
  await page.getByRole('tab', { name: 'Problems' }).click();
  const problem = page.locator('.tl-problem__link[data-material="mat-empty-tex"]');
  await expect(problem).toContainText('no texture');
  await expect(page.locator('.tl-problem').filter({ has: problem })).toContainText('material warning');
  await problem.click();
  await expect(page.getByRole('tab', { name: 'Material: Empty texture' })).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('[data-node-id="sampler"]')).toHaveAttribute('data-problems', /warning/);
});
