/**
 * Phase 20.3: the Effect tab's preview pane against the real backend.
 *
 * - Per renderer (`auto` = WebGL 2 in `default`, the CPU executor; `webgpu`
 *   in `webgpu`, WebGPU compute): an effect tab shows particles in its
 *   preview (magenta pixels); pausing freezes the spawn counter; scrubbing
 *   re-simulates from the seed (t = 1 s → 40 spawned of a 40/s rate, 0.5 s
 *   → 20, back to 1 s → 40 and the same picture); restart goes back to 0; a
 *   preview-only parameter slider (the particle size) changes the picture
 *   and saves nothing; an edit of the graph (the rate) shows at once.
 *   Leak check: opening and closing the tab 10× leaves no preview open and
 *   every close returned the preview renderer's geometry and attribute
 *   counts to their baseline.
 * - The Scene view's edit-mode preview (Gizmos → Play selected effects)
 *   follows an edit of the effect live (magenta → green).
 */
import { createHash } from 'node:crypto';

import { expect, test, type Locator, type Page } from '@playwright/test';

import { startBackend, type E2EBackend } from './backend';
import { decodePng, type Image } from './png';
import { editorUrlFor, expectRendererBackend, onlyInItsProject, type RendererVariant } from './renderer-variants';
import { menu } from './ui';

let be: E2EBackend;
test.afterEach(async () => {
  await be?.stop();
});

async function cmd(op: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const q = await be.command({ op: 'queryProject', projectId: be.projectId, args: {} });
  const res = await be.command({
    op,
    projectId: be.projectId,
    expectedRevision: q['revision'],
    requestId: `req-${createHash('sha256').update(`${op}${Math.random()}`).digest('hex').slice(0, 32)}`,
    origin: { kind: 'mcp', clientId: 'e2e-effect-editor' },
    args,
  });
  expect(res['ok'], JSON.stringify(res)).toBe(true);
  return res;
}

type Block = { type: string; data?: Record<string, unknown>; wires?: Record<string, string> };

/** A system graph: the four contexts with their chains; `wires` feed a block's inputs from extra value nodes. */
function graph(chains: Record<string, Block[]>, values: { id: string; type: string; data?: Record<string, unknown> }[] = []): { nodes: unknown[]; edges: unknown[] } {
  const nodes: { id: string; type: string; position: [number, number]; data?: Record<string, unknown> }[] = ['spawn', 'initialize', 'update', 'output'].map((c, i) => ({ id: c, type: c, position: [0, i * 200] }));
  for (const [i, v] of values.entries()) nodes.push({ id: v.id, type: v.type, position: [-300, i * 120], ...(v.data !== undefined ? { data: v.data } : {}) });
  const edges: unknown[] = [];
  let n = 0;
  for (const [ctx, blocks] of Object.entries(chains)) {
    let prev = ctx;
    for (const b of blocks) {
      const id = `b${n++}`;
      nodes.push({ id, type: b.type, position: [250 * n, 0], ...(b.data !== undefined ? { data: b.data } : {}) });
      edges.push({ id: `e${edges.length}`, from: { node: prev, port: 'then' }, to: { node: id, port: 'in' } });
      for (const [port, from] of Object.entries(b.wires ?? {})) edges.push({ id: `e${edges.length}`, from: { node: from, port: 'value' }, to: { node: id, port } });
      prev = id;
    }
  }
  return { nodes, edges };
}

/** A looping stream of magenta additive billboards: 40 per second, 1.5 s lives, the size an exposed parameter (neutral fixture). */
function streamEffect(rate: number, color = '#ff00ff'): Record<string, unknown> {
  return {
    effectId: 'fx-stream',
    name: 'Stream',
    duration: 2,
    loop: true,
    seed: 5,
    bounds: { center: [0, 1, 0], size: [4, 4, 4] },
    parameters: [{ key: 'size', type: 'float', default: 0.18, min: 0.02, max: 0.9 }],
    systems: [
      {
        systemId: 'motes',
        name: 'Motes',
        maxParticles: 1000,
        space: 'local',
        graph: graph(
          {
            spawn: [{ type: 'spawn.rate', data: { rate } }],
            initialize: [
              { type: 'init.position.sphere', data: { radius: 1.2 } },
              { type: 'init.lifetime', data: { min: 1.5, max: 1.5 } },
              { type: 'init.color', data: { color } },
              { type: 'init.size', wires: { min: 'psize', max: 'psize' } },
            ],
            output: [{ type: 'output.billboard', data: { blend: 'additive' } }],
          },
          [{ id: 'psize', type: 'value.parameter', data: { key: 'size' } }],
        ),
      },
    ],
  };
}

function count(img: Image, test: (r: number, g: number, b: number) => boolean): number {
  let n = 0;
  for (let y = 0; y < img.height; y += 2) for (let x = 0; x < img.width; x += 2) {
    const [r, g, b] = img.pixel(x, y);
    if (test(r, g, b)) n += 1;
  }
  return n;
}
const magenta = (r: number, g: number, b: number): boolean => r > 150 && b > 150 && g < 0.55 * Math.min(r, b);
const green = (r: number, g: number, b: number): boolean => g > 150 && r < 0.55 * g && b < 0.55 * g;
const shot = async (t: Locator | Page): Promise<Image> => decodePng(await t.screenshot());

interface PreviewState { executor: string | null; time: number; steps: number; playing: boolean; systems: { id: string; spawned: number; living: number | null }[] }
async function state(canvas: Locator): Promise<PreviewState> {
  return JSON.parse((await canvas.getAttribute('data-tl-effect-preview')) ?? '{"systems":[]}') as PreviewState;
}
const spawned = async (canvas: Locator): Promise<number> => (await state(canvas)).systems[0]?.spawned ?? -1;
interface Ledger { open: number; opened: number; closed: number; leaks: number; last: { baseline: Record<string, number>; after: Record<string, number> } | null }
const ledger = async (page: Page): Promise<Ledger> => JSON.parse((await page.locator('html').getAttribute('data-tl-effect-previews')) ?? '{"open":0,"opened":0,"closed":0,"leaks":0,"last":null}') as Ledger;

const VARIANTS: readonly RendererVariant[] = ['auto', 'webgpu'];

for (const variant of VARIANTS) test(`the Effect tab previews an effect: particles, pause, deterministic scrub, restart, parameter slider, live edit, no leaks (${variant})`, async ({ page }) => {
  onlyInItsProject(variant);
  test.setTimeout(300_000);
  be = await startBackend('effect-editor-e2e');
  const executor = variant === 'webgpu' ? 'webgpu' : 'cpu';
  await cmd('setEffect', { effect: streamEffect(40) });
  await page.goto(editorUrlFor(be.editorUrl, variant));
  await expect(page.locator('.tl-statusbar')).toContainText('connected');
  await page.getByRole('tab', { name: 'Effects' }).click();
  const openTab = async (): Promise<void> => {
    await page.getByRole('button', { name: 'Open Stream' }).click();
    await expect(page.getByRole('tab', { name: 'Effect: Stream' })).toHaveAttribute('aria-selected', 'true');
  };
  await openTab();

  // The preview draws the effect with the executor Play would use.
  const canvas = page.getByLabel('effect preview canvas');
  await expectRendererBackend(canvas, variant);
  await expect.poll(async () => (await state(canvas)).executor, { timeout: 60_000 }).toBe(executor);
  await expect(page.getByLabel('preview status')).toContainText(executor === 'webgpu' ? 'WebGPU compute' : 'CPU executor');
  // The frame cost says how it was measured: the WebGPU executor's simulation in GPU time, the CPU executor's in CPU time.
  await expect(page.getByLabel('frame cost')).toContainText(executor === 'webgpu' ? /GPU time \(timestamp queries\): simulation|CPU frame time \(no GPU timestamp queries/ : /Simulation \(CPU executor\): [0-9.]+ ms CPU time|CPU frame time \(no GPU timestamp queries/, { timeout: 30_000 });
  let playingPixels = 0;
  await expect.poll(async () => (playingPixels = count(await shot(canvas), magenta)), { timeout: 60_000 }).toBeGreaterThan(40);
  await expect.poll(async () => spawned(canvas), { timeout: 30_000 }).toBeGreaterThan(0);

  // Pause: the counter stops.
  await page.getByRole('button', { name: 'pause preview' }).click();
  await expect(page.getByRole('button', { name: 'play preview' })).toBeVisible();
  await expect.poll(async () => (await state(canvas)).playing, { timeout: 10_000 }).toBe(false);
  const frozen = await spawned(canvas);
  await page.waitForTimeout(700);
  expect(await spawned(canvas)).toBe(frozen);

  // Scrub: a re-simulation from the seed — 60 steps of 40/60 = exactly 40 born, all alive (1.5 s lives).
  const scrub = page.getByLabel('preview time', { exact: true });
  const scrubTo = async (t: string, steps: number, born: number): Promise<void> => {
    await scrub.fill(t);
    await expect.poll(async () => (await state(canvas)).steps, { timeout: 30_000 }).toBe(steps);
    expect(await spawned(canvas)).toBe(born);
  };
  await scrubTo('1', 60, 40);
  await expect.poll(async () => (await state(canvas)).systems[0]?.living, { timeout: 30_000 }).toBe(40);
  const row = page.getByRole('table', { name: 'spawn counters' }).locator('tr[data-system-id="motes"]');
  await expect(row.locator('[data-counter="spawned"]')).toHaveText('40');
  await expect(row).toContainText('Motes');
  await page.waitForTimeout(400);
  const atOne = count(await shot(canvas), magenta);
  await scrubTo('0.5', 30, 20);
  await expect.poll(async () => (await state(canvas)).systems[0]?.living, { timeout: 30_000 }).toBe(20);
  await scrubTo('1', 60, 40);
  await page.waitForTimeout(400);
  const atOneAgain = count(await shot(canvas), magenta);
  console.log(`[effect-editor] ${variant}: magenta playing ${playingPixels}, t=1 ${atOne}, t=1 again ${atOneAgain}`);
  expect(atOne).toBeGreaterThan(20);
  // The same time gives the same particles: the same picture (a few pixels of tolerance for the rasteriser).
  expect(Math.abs(atOneAgain - atOne)).toBeLessThanOrEqual(Math.max(4, atOne * 0.02));

  // A preview-only parameter: bigger particles cover more of the picture; nothing is saved.
  await page.getByLabel('preview parameter size').fill('0.9');
  let bigger = 0;
  await expect.poll(async () => (bigger = count(await shot(canvas), magenta)), { timeout: 30_000 }).toBeGreaterThan(atOne * 2);
  expect(await spawned(canvas)).toBe(40);
  console.log(`[effect-editor] ${variant}: size 0.9 → magenta ${bigger}; ${await page.getByLabel('frame cost').textContent()}`);
  await page.screenshot({ path: test.info().outputPath('effect-tab.png') });
  const saved = (await be.command({ op: 'queryGameConfig', projectId: be.projectId, args: {} })) as { effects: { parameters: { default: number }[] }[] };
  expect(saved.effects[0]!.parameters[0]!.default).toBe(0.18);
  await page.getByRole('button', { name: 'reset preview parameters' }).click();
  await expect.poll(async () => count(await shot(canvas), magenta), { timeout: 30_000 }).toBeLessThan(bigger * 0.75);

  // Restart: back to time 0 (paused: nothing born yet); play again: it grows.
  await page.getByRole('button', { name: 'restart preview' }).click();
  await expect.poll(async () => (await state(canvas)).steps, { timeout: 30_000 }).toBe(0);
  expect(await spawned(canvas)).toBe(0);
  await expect(page.getByLabel('preview time readout')).toHaveText('0.00 / 4.00 s');
  await page.getByRole('button', { name: 'play preview' }).click();
  await expect.poll(async () => spawned(canvas), { timeout: 30_000 }).toBeGreaterThan(0);

  // Live: an edit of the graph (a new rate) shows in the preview at once — paused at 1 s, 60 steps of 120/60.
  await page.getByRole('button', { name: 'pause preview' }).click();
  await scrubTo('1', 60, 40);
  await cmd('setEffect', { effect: streamEffect(120) });
  await expect.poll(async () => spawned(canvas), { timeout: 30_000 }).toBe(120);
  expect((await state(canvas)).steps).toBe(60);

  // Leak check: close the tab, then open and close it 10 times — every preview is disposed and returned the renderer's
  // geometry and attribute counts to their baseline.
  await page.getByRole('button', { name: 'Close Effect: Stream' }).click();
  await expect(canvas).toHaveCount(0);
  const before = await ledger(page);
  expect(before.open).toBe(0);
  for (let k = 0; k < 10; k++) {
    await openTab();
    // Wait until the preview built its play (the baseline exists and the effect was simulated).
    await expect.poll(async () => (await state(canvas)).steps, { timeout: 60_000 }).toBeGreaterThan(0);
    await page.getByRole('button', { name: 'Close Effect: Stream' }).click();
    await expect(canvas).toHaveCount(0);
  }
  const after = await ledger(page);
  console.log(`[effect-editor] ${variant}: ledger ${JSON.stringify(after)}`);
  expect(after.open).toBe(0);
  expect(after.opened - before.opened).toBe(10);
  expect(after.closed - before.closed).toBe(10);
  expect(after.leaks).toBe(0);
  expect(after.last).not.toBeNull();
  for (const k of Object.keys(after.last!.baseline)) expect(after.last!.after[k], k).toBe(after.last!.baseline[k]);
  // The Scene view still draws (no context was lost to the previews).
  await expect(page.locator('canvas.tl-viewport')).toHaveAttribute('data-tl-renderer-state', 'ready');
});

test('the Scene view\'s edit-mode effect preview follows edits of the effect live', async ({ page }) => {
  test.skip(test.info().project.name === 'webgpu', 'renderer-independent editor wiring (the default project covers it)');
  test.setTimeout(180_000);
  be = await startBackend('effect-editor-scene-e2e');
  await cmd('setEffect', { effect: streamEffect(300) });
  await page.goto(be.editorUrl);
  await expect(page.locator('.tl-statusbar')).toContainText('connected');
  const created = await cmd('createEntity', { kind: 'group', name: 'Emitter', transform: { position: [0, 0, 0] } });
  const id = String(created['createdId']);
  await cmd('setComponent', { entityId: id, component: 'effect', value: { effectId: 'fx-stream', params: { size: 0.5 } } });
  const viewport = page.locator('canvas.tl-viewport');
  const row = page.locator(`.tl-hierarchy__list li.tl-row[data-entity-id="${id}"]`);
  await expect(row).toBeVisible({ timeout: 20_000 });
  await row.click();
  await expect(row).toHaveClass(/is-selected/);
  await viewport.hover();
  await page.keyboard.press('f');
  await page.waitForTimeout(800);
  await menu(page, 'Gizmos', 'Play selected effects: off');
  await expect.poll(async () => JSON.parse((await viewport.getAttribute('data-effects')) ?? '{}').particles ?? 0, { timeout: 30_000 }).toBeGreaterThan(50);
  let m = 0;
  await expect.poll(async () => (m = count(await shot(viewport), magenta)), { timeout: 30_000 }).toBeGreaterThan(100);
  const g0 = count(await shot(viewport), green);
  // Edit the effect (its colour): the playing preview picks the new definition up without toggling.
  await cmd('setEffect', { effect: streamEffect(300, '#00ff00') });
  let g = 0;
  await expect.poll(async () => (g = count(await shot(viewport), green)), { timeout: 30_000 }).toBeGreaterThan(g0 + 100);
  await expect.poll(async () => count(await shot(viewport), magenta), { timeout: 30_000 }).toBeLessThan(m * 0.2);
  console.log(`[effect-editor] scene view: magenta ${m} → green ${g}`);
});
