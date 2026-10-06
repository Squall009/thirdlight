/**
 * Environment blends are cheap. A script gives
 * `ctx.environment.blend(a, b, t)` a new `t` every step (120 Hz) in Play,
 * against a real backend, on the GPU host:
 *
 * - "noon" ↔ "dusk": a procedural sky whose numbers and sun (it follows the
 *   directional light, which the presets turn) change, with fog, exposure and
 *   light colour/intensity. Once loaded (one full cycle of t), a 6 s window
 *   (two cycles) drops no steps (the runtime's `droppedSteps`), and the image-based
 *   lighting is re-baked, but at most every 30th frame.
 * - "noon" ↔ "dim": the same sky, only fog, exposure and lights change: no
 *   re-bake at all (the sky inputs stay under the threshold), no dropped steps.
 *
 * The page's frame gaps (requestAnimationFrame in the Play frame) are logged
 * with the result. The pixels of a blend (sky, fog, lit panel) are checked by
 * `environment-presets.e2e.ts`.
 *
 * Runs on the product's own renderer (renderer-variants.ts PRODUCT_RENDERER_VARIANTS):
 * its subject is not a backend path; the parity sweeps compare the backends' shading.
 */
import { createHash, randomBytes } from 'node:crypto';

import { expect, test, type Frame } from './pw';

import { startBackend, type E2EBackend } from './backend';
import { editorUrlFor, expectRendererBackend, onlyInItsProject, PRODUCT_RENDERER_VARIANTS, type RendererVariant } from './renderer-variants';

let be: E2EBackend | null = null;
test.afterEach(async () => {
  await be?.stop();
  be = null;
});

async function query(op: string, args: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  return be!.command({ op, projectId: be!.projectId, args });
}
async function cmd(op: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const revision = Number((await query('queryProject')).revision);
  const res = await be!.command({ op, projectId: be!.projectId, expectedRevision: revision, requestId: `req-${randomBytes(16).toString('hex')}`, origin: { kind: 'mcp', clientId: 'e2e-environment-blend-cost' }, args });
  expect(res['ok'], JSON.stringify(res)).toBe(true);
  return res;
}
async function api(path: string, body: unknown): Promise<{ status: number; json: Record<string, unknown> }> {
  const r = await fetch(`${be!.origin}/api/v1/projects/${be!.projectId}/${path}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${be!.token}`, 'content-type': 'application/json', origin: be!.origin },
    body: JSON.stringify(body),
  });
  return { status: r.status, json: (await r.json()) as Record<string, unknown> };
}

/** Publish a behavior (no properties) and attach it to `entityId`. */
async function script(behaviorId: string, source: string, entityId: string): Promise<void> {
  const bytes = Buffer.from(`${JSON.stringify({ graphVersion: 1, entryPath: 'src/index.ts', requiredModules: ['@thirdlight/runtime'], ownedTransforms: [], files: [{ path: 'src/index.ts', text: source }] }, null, 2)}\n`);
  const stage = await api('content/stages', {});
  const stageId = String(stage.json.stageId);
  const put = await fetch(`${be!.origin}/api/v1/projects/${be!.projectId}/content/stages/${stageId}/bytes`, {
    method: 'PUT',
    headers: { authorization: `Bearer ${be!.token}`, origin: be!.origin, 'content-type': 'application/octet-stream', 'x-thirdlight-offset': '0', 'x-thirdlight-total': String(bytes.length) },
    body: bytes,
  });
  expect(put.status).toBe(200);
  const declaration = { properties: [] };
  await cmd('publishBehavior', { behaviorId, displayName: behaviorId, mode: 'declaration-create', declaration });
  await cmd('acknowledgeBehaviorTrust', { sourceDigest: createHash('sha256').update(bytes).digest('hex') });
  const published = await api('content/behaviors/source', { stageId, behaviorId, displayName: behaviorId, declaration, expectedRevision: Number((await query('queryProject')).revision), requestId: `req-${randomBytes(16).toString('hex')}` });
  expect(published.status, JSON.stringify(published.json)).toBe(200);
  await cmd('setBehaviorProperties', { entityId, behaviorId, values: {} });
}

/** A new t every step: a 3 s cosine cycle between "noon" and the second preset (Digit1 switches it between "dusk" and "dim"). */
const DRIVER = [
  'export default {',
  "  instantiate() { return { other: 'dusk' }; },",
  '  step(state: { other: string }, ctx: any) {',
  "    if (ctx.phase !== 'intent' || ctx.environment === undefined) return;",
  "    if (ctx.input.pressed('switchPair')) state.other = state.other === 'dusk' ? 'dim' : 'dusk';",
  '    const t = 0.5 - 0.5 * Math.cos((ctx.stepIndex * Math.PI * 2) / 360);',
  "    ctx.environment.blend('noon', state.other, t);",
  '  },',
  '};',
].join('\n');

const NOON_SKY = { mode: 'procedural', turbidity: 3, rayleigh: 1, mieCoefficient: 0.004, mieDirectionalG: 0.8 };
const PRESETS = [
  {
    presetId: 'noon',
    name: 'Noon',
    sky: NOON_SKY,
    fog: { mode: 'linear', color: '#d8e4f0', near: 20, far: 120 },
    post: { exposure: 1 },
    lights: [
      { entity: 'light-0001', color: '#ffffff', intensity: 2.5, direction: [0.2, -1, -0.3] },
      { entity: 'light-0002', color: '#8090a8', intensity: 0.5 },
    ],
  },
  {
    presetId: 'dusk',
    name: 'Dusk',
    sky: { mode: 'procedural', turbidity: 9, rayleigh: 3, mieCoefficient: 0.01, mieDirectionalG: 0.9 },
    fog: { mode: 'linear', color: '#a05030', near: 8, far: 60 },
    post: { exposure: 0.6 },
    lights: [
      { entity: 'light-0001', color: '#ff9050', intensity: 0.8, direction: [0.95, -0.12, -0.3] },
      { entity: 'light-0002', color: '#403040', intensity: 0.2 },
    ],
  },
  {
    presetId: 'dim',
    name: 'Dim',
    sky: NOON_SKY,
    fog: { mode: 'linear', color: '#303840', near: 5, far: 40 },
    post: { exposure: 0.4 },
    lights: [
      { entity: 'light-0001', color: '#6070c0', intensity: 0.3, direction: [0.2, -1, -0.3] },
      { entity: 'light-0002', color: '#202830', intensity: 0.05 },
    ],
  },
];

interface Sample {
  dropped: number;
  steps: number;
  bakes: number;
}

const VARIANTS: readonly RendererVariant[] = PRODUCT_RENDERER_VARIANTS;

for (const variant of VARIANTS) test(`environment blend: a new t every step at 120 Hz drops no steps; the lighting re-bakes only when the sky changes (${variant})`, async ({ page }) => {
  onlyInItsProject(variant, VARIANTS);
  test.setTimeout(240_000);
  be = await startBackend('environment-blend-cost-e2e');

  await cmd('setTransform', { entityId: 'cam-main', transform: { position: [0, 1, 6], rotation: [0, 0, 0, 1] } });
  await cmd('createEntity', { sceneId: 'scene-main', parentId: null, kind: 'box', name: 'Panel', transform: { position: [-2.5, 0.3, 0] }, box: { size: [4, 2, 0.1], material: { color: '#c0c0c0' } } });
  await cmd('createEntity', { sceneId: 'scene-main', parentId: null, kind: 'box', name: 'Far wall', transform: { position: [30, 0, -80] }, box: { size: [60, 40, 1], material: { color: '#c0c0c0' } } });
  const driver = String((await cmd('createEntity', { sceneId: 'scene-main', parentId: null, kind: 'group', name: 'Driver', transform: { position: [0, -20, 0] } }))['createdId']);
  await cmd('setInput', { input: { actions: [{ name: 'switchPair', type: 'button', map: 'gameplay', bindings: [{ kind: 'key', code: 'Digit1' }] }] } });
  await script('env-driver', DRIVER, driver);
  await cmd('setComponent', { entityId: 'light-0001', component: 'light', value: { type: 'directional', color: '#ffffff', intensity: 2.5, direction: [0.2, -1, -0.3], castShadow: true } });
  await cmd('setEnvironment', { environment: { presets: PRESETS } });
  await cmd('setEnvironment', { sceneId: 'scene-main', environment: { sky: NOON_SKY, fog: PRESETS[0]!.fog, post: { exposure: 1 } } });

  page.on('pageerror', (e) => console.log(`[page pageerror] ${e.message} ${e.stack?.slice(0, 600)}`));
  page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') console.log(`[page console] ${m.type()} ${m.text().slice(0, 300)}`); });
  await page.goto(editorUrlFor(be.editorUrl, variant));
  await expect(page.locator('.tl-statusbar')).toContainText('connected');

  const started = page.waitForResponse((r) => r.request().method() === 'POST' && r.url().endsWith('/play'));
  await page.getByTitle('Start an isolated play preview').click();
  const psid = String(((await (await started).json()) as { playSessionId: string }).playSessionId);
  const iframe = page.locator('iframe.tl-app__preview-frame');
  await expect(iframe).toBeVisible();
  await expectRendererBackend(page.frameLocator('iframe.tl-app__preview-frame').locator('canvas').first(), variant);
  const frame = (await (await iframe.elementHandle())!.contentFrame()) as Frame;

  const sample = async (): Promise<Sample> => {
    const r = await api(`play/${psid}/diagnostics`, {});
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    const d = r.json['diagnostics'] as { runtime: { droppedSteps: number; stepIndex: number; fixedStepHz: number }; renderer: { environment?: { iblRebakes: number } } };
    expect(d.runtime.fixedStepHz).toBe(120);
    return { dropped: d.runtime.droppedSteps, steps: d.runtime.stepIndex, bakes: d.renderer.environment?.iblRebakes ?? -1 };
  };
  const duskShare = async (): Promise<number | null> => {
    const r = await api(`play/${psid}/observe`, {});
    const e = r.status === 200 ? ((r.json as { environment?: { weights: Record<string, number> } | null }).environment ?? null) : null;
    return e === null ? null : Object.entries(e.weights).reduce((acc, [k, w]) => acc + (k === 'noon' || k === '' ? 0 : w), 0);
  };
  /** The page's frame gaps (ms) since the recorder started (requestAnimationFrame in the Play frame). */
  const startGaps = (): Promise<void> =>
    frame.evaluate(() => {
      const w = window as unknown as { __gaps: number[]; __gapsOn?: boolean };
      w.__gaps = [];
      if (w.__gapsOn === true) return;
      w.__gapsOn = true;
      let last = performance.now();
      const tick = (t: number): void => {
        w.__gaps.push(t - last);
        last = t;
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });
  const gaps = async (): Promise<{ frames: number; max: number; p99: number; over66: number }> => {
    const g = (await frame.evaluate(() => (window as unknown as { __gaps: number[] }).__gaps.slice())).sort((a, b) => a - b);
    return { frames: g.length, max: Math.round(g.at(-1) ?? 0), p99: Math.round(g[Math.floor(g.length * 0.99)] ?? 0), over66: g.filter((x) => x > 1000 / 15).length };
  };

  // Loaded: the blend runs (the dusk share moves), then one full cycle of t (3 s) so every shader has been built.
  const box = (await iframe.boundingBox())!;
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await expect.poll(duskShare, { timeout: 60_000, message: 'the blend runs' }).toBeGreaterThan(0.05);
  await page.waitForTimeout(3_500);

  // noon ↔ dusk: the sky changes, so the lighting re-bakes, but at most every 30th frame; no step is dropped.
  await startGaps();
  const a0 = await sample();
  const shares = new Set<number>();
  // Two cycles, sampled every 400 ms (not a divisor of the 3 s cycle, so the samples fall at many different points of it).
  const until = Date.now() + 6_000;
  while (Date.now() < until) {
    const s = await duskShare();
    if (s !== null) shares.add(Math.round(s * 100));
    await page.waitForTimeout(400);
  }
  const a1 = await sample();
  const ga = await gaps();
  console.log(`[environment-blend-cost] ${variant} noon-dusk: ${a1.steps - a0.steps} steps, ${a1.dropped - a0.dropped} dropped, ${a1.bakes - a0.bakes} re-bakes; ${ga.frames} frames, gap max ${ga.max} ms p99 ${ga.p99} ms, ${ga.over66} over 66 ms; dusk shares seen ${[...shares].sort((x, y) => x - y).join(' ')}`);
  expect(shares.size, 'a new t every step: the blend moved through the window').toBeGreaterThan(5);
  expect(a1.steps - a0.steps, 'the simulation ran at 120 Hz').toBeGreaterThan(600);
  expect(a1.dropped - a0.dropped, 'no dropped steps while t changes every step').toBe(0);
  expect(a1.bakes - a0.bakes, 'the changing sky is re-baked').toBeGreaterThan(0);
  expect(a1.bakes - a0.bakes, 'at most every 30th frame').toBeLessThanOrEqual(Math.ceil(ga.frames / 30) + 1);

  // noon ↔ dim: the same sky, only fog, exposure and lights change: no re-bake at all.
  await page.keyboard.down('Digit1');
  await page.waitForTimeout(200);
  await page.keyboard.up('Digit1');
  await expect.poll(async () => {
    const r = await api(`play/${psid}/observe`, {});
    return Object.keys(((r.json as { environment?: { weights: Record<string, number> } | null }).environment?.weights) ?? {}).some((k) => k.startsWith('dim'));
  }, { timeout: 20_000, message: 'the pair switched to noon ↔ dim' }).toBe(true);
  await page.waitForTimeout(1_500); // a bake of the sky left mid-way through the dusk blend may still land
  await startGaps();
  const b0 = await sample();
  await page.waitForTimeout(3_000);
  const b1 = await sample();
  const gb = await gaps();
  console.log(`[environment-blend-cost] ${variant} noon-dim: ${b1.steps - b0.steps} steps, ${b1.dropped - b0.dropped} dropped, ${b1.bakes - b0.bakes} re-bakes; ${gb.frames} frames, gap max ${gb.max} ms p99 ${gb.p99} ms, ${gb.over66} over 66 ms`);
  expect(b1.steps - b0.steps).toBeGreaterThan(300);
  expect(b1.dropped - b0.dropped, 'no dropped steps').toBe(0);
  expect(b1.bakes - b0.bakes, 'the sky did not change: no re-bake').toBe(0);
  await expect(page.locator('.tl-notice')).toHaveCount(0);
});
