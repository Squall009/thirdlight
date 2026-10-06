/**
 * Effect lights never recompile the scene. A game whose effect emits
 * light (a Lights block) gets the whole effect light pool, dark, before its
 * first frame, so the number of lights in the scene never changes while it
 * plays: a script plays the glowing effect once at the start and once more
 * per key press until 16 play, each lighting a panel behind it. Counted at
 * the graphics API in every frame (WebGL programs linked, WebGPU shader
 * modules and pipelines created; monotonic, so a rebuilt-and-released
 * program still counts): once the first light shows and the counts are
 * still, lights rising from 1 to 16 build nothing more. In Play (the preview
 * iframe) and in the static export (backend stopped). Per renderer: `auto`
 * in `default`, `webgl2` with TL_E2E_ALL_VARIANTS=1, `webgpu` in `webgpu`.
 *
 * The pool is shaded: the panel is brighter with 16 lights than with one
 * (how it should look is not judged here).
 */
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';

import { expect, test, type Frame, type Locator, type Page } from './pw';

import { decodePng, type Image } from './png';
import { exportedContent, publishScript, serveDir, startBackend, type E2EBackend } from './backend';
import { editorUrlFor, expectRendererBackend, exportQueryFor, onlyInItsProject, type RendererVariant } from './renderer-variants';

let be: E2EBackend | null = null;
test.afterEach(async () => {
  await be?.stop();
  be = null;
});

async function cmd(op: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const q = await be!.command({ op: 'queryProject', projectId: be!.projectId, args: {} });
  const res = await be!.command({ op, projectId: be!.projectId, expectedRevision: Number(q['revision']), requestId: `req-${randomBytes(16).toString('hex')}`, origin: { kind: 'mcp', clientId: 'e2e-effect-light-pool' }, args });
  expect(res['ok'], JSON.stringify(res)).toBe(true);
  return res;
}

/** Shader builds since the frame loaded, counted where the browser builds them (installed before any page script). */
function countBuilds(): void {
  const w = window as unknown as { __tlBuilds?: Record<string, number> };
  if (w.__tlBuilds !== undefined) return;
  const n: Record<string, number> = { glPrograms: 0, gpuModules: 0, gpuPipelines: 0 };
  w.__tlBuilds = n;
  const wrap = (proto: object | undefined, name: string, key: string): void => {
    if (proto === undefined) return;
    const f = (proto as Record<string, unknown>)[name];
    if (typeof f !== 'function') return;
    (proto as Record<string, unknown>)[name] = function (this: unknown, ...a: unknown[]): unknown {
      n[key] = (n[key] ?? 0) + 1;
      return (f as (...x: unknown[]) => unknown).apply(this, a);
    };
  };
  const g = globalThis as unknown as Record<string, { prototype: object } | undefined>;
  wrap(g['WebGL2RenderingContext']?.prototype, 'linkProgram', 'glPrograms');
  wrap(g['WebGLRenderingContext']?.prototype, 'linkProgram', 'glPrograms');
  wrap(g['GPUDevice']?.prototype, 'createShaderModule', 'gpuModules');
  for (const m of ['createRenderPipeline', 'createRenderPipelineAsync', 'createComputePipeline', 'createComputePipelineAsync']) wrap(g['GPUDevice']?.prototype, m, 'gpuPipelines');
}
const readBuilds = (f: Frame): Promise<Record<string, number>> => f.evaluate(() => ({ ...((window as unknown as { __tlBuilds?: Record<string, number> }).__tlBuilds ?? {}) }));
const total = (b: Record<string, number>): number => Object.values(b).reduce((a, x) => a + x, 0);

/** One system: a few warm sparks that live for the whole play, each a point light (the oldest one). */
const GLOW = {
  effectId: 'fx-glow',
  name: 'Glow',
  duration: 1,
  loop: true,
  seed: 5,
  bounds: { center: [0, 0, 0], size: [4, 4, 4] },
  systems: [
    {
      systemId: 'sparks',
      name: 'Sparks',
      maxParticles: 4,
      space: 'world',
      graph: (() => {
        const chains: Record<string, { type: string; data?: Record<string, unknown> }[]> = {
          spawn: [{ type: 'spawn.rate', data: { rate: 8 } }],
          initialize: [
            { type: 'init.lifetime', data: { min: 1000, max: 1000 } },
            { type: 'init.color', data: { color: '#ffb040' } },
            { type: 'init.size', data: { min: 0.12, max: 0.12 } },
          ],
          output: [{ type: 'output.billboard', data: { blend: 'additive' } }, { type: 'output.light', data: { maxLights: 1, intensity: 3, range: 3 } }],
        };
        const nodes: { id: string; type: string; position: [number, number]; data?: Record<string, unknown> }[] = ['spawn', 'initialize', 'update', 'output'].map((c, i) => ({ id: c, type: c, position: [0, i * 200] }));
        const edges: unknown[] = [];
        let k = 0;
        for (const [ctx, blocks] of Object.entries(chains)) {
          let prev = ctx;
          for (const b of blocks) {
            const id = `b${k++}`;
            nodes.push({ id, type: b.type, position: [250 * k, 0], ...(b.data !== undefined ? { data: b.data } : {}) });
            edges.push({ id: `e${edges.length}`, from: { node: prev, port: 'then' }, to: { node: id, port: 'in' } });
            prev = id;
          }
        }
        return { nodes, edges };
      })(),
    },
  ],
};

const PLAYS = 16;
/** Mean of the RGB channels over the whole image. */
const brightness = (img: Image): number => {
  let sum = 0;
  for (let y = 0; y < img.height; y += 2) for (let x = 0; x < img.width; x += 2) {
    const p = img.pixel(x, y);
    sum += (p[0] + p[1] + p[2]) / 3;
  }
  return sum / (Math.ceil(img.height / 2) * Math.ceil(img.width / 2));
};
/** One glow at the start, one more per press of the `more` action, in a row in front of the panel. */
const DRIVER = [
  'export default {',
  '  instantiate() { return { n: 0 }; },',
  '  step(state: { n: number }, ctx: any) {',
  "    if (ctx.phase !== 'intent') return;",
  `    if (state.n < ${PLAYS} && (state.n === 0 || ctx.input.pressed('more'))) {`,
  "      ctx.effects.play('fx-glow', { position: [-3.75 + 0.5 * state.n, 0.4, 0.4] });",
  '      state.n += 1;',
  '    }',
  '  },',
  '};',
].join('\n');

const VARIANTS: readonly RendererVariant[] = ['auto', 'webgl2', 'webgpu'];

for (const variant of VARIANTS) test(`effect lights rising from 1 to 16 build no shader after the first light, in Play and the export (${variant})`, async ({ page }) => {
  onlyInItsProject(variant);
  test.setTimeout(420_000);
  be = await startBackend('effect-light-pool-e2e');
  await cmd('setTransform', { entityId: 'cam-main', transform: { position: [0, 1, 7], rotation: [0, 0, 0, 1] } });
  await cmd('createEntity', { sceneId: 'scene-main', parentId: null, kind: 'box', name: 'Panel', transform: { position: [0, 0.5, -0.5] }, box: { size: [9, 3, 0.1], material: { color: '#c0c0c0' } } });
  await cmd('setEffect', { effect: GLOW });
  await cmd('setInput', { input: { actions: [{ name: 'more', type: 'button', map: 'gameplay', bindings: [{ kind: 'key', code: 'KeyE' }] }] } });
  const driver = String((await cmd('createEntity', { sceneId: 'scene-main', parentId: null, kind: 'group', name: 'Driver', transform: { position: [0, -20, 0] } }))['createdId']);
  await publishScript(be, 'glow-driver', DRIVER, driver);
  await page.context().addInitScript(countBuilds);

  /** The first glow lights the panel; once the builds are still, 15 presses bring 16 lights and build nothing. */
  const rise = async (where: string, keys: Page, canvas: Locator, frame: Frame, focus: () => Promise<void>): Promise<void> => {
    await expectRendererBackend(canvas, variant);
    await expect(canvas).toHaveAttribute('data-tl-effects-lights', '1', { timeout: 60_000 });
    // Settled: the start's builds (scene, sky, the glow's own particles) are done when the counts stop moving.
    let last = -1;
    let still = 0;
    const settleUntil = Date.now() + 90_000;
    while (still < 4 && Date.now() < settleUntil) {
      await keys.waitForTimeout(500);
      const t = total(await readBuilds(frame));
      still = t === last ? still + 1 : 0;
      last = t;
    }
    expect(still, 'the start builds settle').toBe(4);
    const before = await readBuilds(frame);
    const dim = brightness(decodePng(await canvas.screenshot()));
    expect(total(before), 'the counter sees the builds of the start').toBeGreaterThan(0);
    await focus();
    for (let k = 2; k <= PLAYS; k++) {
      await keys.keyboard.down('KeyE');
      await keys.waitForTimeout(60);
      await keys.keyboard.up('KeyE');
      await expect(canvas).toHaveAttribute('data-tl-effects-lights', String(k), { timeout: 20_000 });
    }
    await expect(canvas).toHaveAttribute('data-tl-effects-playing', String(PLAYS));
    await keys.waitForTimeout(2_000);
    const after = await readBuilds(frame);
    console.log(`[effect-light-pool] ${variant} ${where}: builds at 1 light ${JSON.stringify(before)}, at ${PLAYS} lights ${JSON.stringify(after)}`);
    expect(after, `${where}: no program or pipeline built while the lights rose`).toEqual(before);
    const lit = brightness(decodePng(await canvas.screenshot()));
    console.log(`[effect-light-pool] ${variant} ${where}: mean brightness at 1 light ${dim.toFixed(1)}, at ${PLAYS} lights ${lit.toFixed(1)}`);
    expect(lit, `${where}: the 16 lights light the panel`).toBeGreaterThan(dim + 5);
  };

  // Play: the preview iframe (the editor passes the renderer flag on).
  await page.goto(editorUrlFor(be.editorUrl, variant));
  await expect(page.locator('.tl-statusbar')).toContainText('connected');
  await page.getByTitle('Start an isolated play preview').click();
  const iframe = page.locator('iframe.tl-app__preview-frame');
  await expect(iframe).toBeVisible();
  const playFrame = (await (await iframe.elementHandle())!.contentFrame()) as Frame;
  await rise('play', page, page.frameLocator('iframe.tl-app__preview-frame').locator('canvas').first(), playFrame, async () => {
    const box = (await iframe.boundingBox())!;
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  });
  await page.getByTitle('Stop the play preview').click();

  // The export: served statically with the backend stopped.
  const res = await be.admin(`projects/${be.projectId}/export`);
  expect(res.status, JSON.stringify(res.json)).toBe(200);
  const out = join(be.exportRoot, String(res.json.outputDir));
  expect((exportedContent(out) as { effects?: { effectId: string }[] }).effects?.map((e) => e.effectId)).toEqual(['fx-glow']);
  await page.goto('about:blank');
  await be.halt();
  const site = await serveDir(out);
  const exported = await page.context().newPage();
  const errors: string[] = [];
  exported.on('pageerror', (e) => errors.push(e.message));
  try {
    await exported.goto(`${site.url}${exportQueryFor(variant)}`);
    const canvas = exported.locator('canvas').first();
    await rise('export', exported, canvas, exported.mainFrame(), async () => {
      const box = (await canvas.boundingBox())!;
      await exported.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    });
    expect(errors).toEqual([]);
  } finally {
    await exported.close();
    await site.close();
  }
});
