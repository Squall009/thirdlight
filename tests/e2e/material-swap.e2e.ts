/**
 * Runtime material swaps against a real backend, in Play, judged by pixels
 * (under each renderer variant; the forced WebGL 2 one with
 * TL_E2E_ALL_VARIANTS=1).
 *
 * The starter template (a fixed camera looking down −Z) with two panels in
 * front of it, each wearing an unlit red project material.
 *
 * 1. A script swaps the left panel to a material whose colour comes from a
 *    blue texture (`ctx.entity(id).set('materials', {'*': …})`) on a debug
 *    command. The texture's bytes are held back at the network: the panel
 *    stays red — never the material's white base without its texture —
 *    until they arrive, then turns blue. `null` puts the red one back.
 * 2. A timeline that plays at the start swaps the right panel to a green
 *    textured material at 1 s (a `materialSwap` key; the material ships
 *    because the key names it).
 * 3. Editor: the Timeline window adds a material swap track and key; the key
 *    inspector picks the slot's material (one setTimeline each).
 */
import { createHash, randomBytes } from 'node:crypto';

import { expect, test, type Locator, type Page } from '@playwright/test';

import { publishBytes, startBackend, type E2EBackend } from './backend';
import { decodePng } from './png';
import { makePng } from './png-make';
import { editorUrlFor, expectRendererBackend, onlyInItsProject, RENDERER_VARIANTS } from './renderer-variants';
import { openEditor } from './ui';

let be: E2EBackend | null = null;
test.afterEach(async () => {
  await be?.stop();
  be = null;
});

async function query(op: string, args: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  return be!.command({ op, projectId: be!.projectId, args });
}
async function cmd(op: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const res = await be!.command({ op, projectId: be!.projectId, expectedRevision: Number((await query('queryProject')).revision), requestId: `req-${randomBytes(16).toString('hex')}`, origin: { kind: 'mcp', clientId: 'e2e-material-swap' }, args });
  expect(res.ok, JSON.stringify(res).slice(0, 600)).toBe(true);
  return res;
}
async function api(path: string, body: unknown = {}): Promise<{ status: number; json: Record<string, unknown> }> {
  const r = await fetch(`${be!.origin}/api/v1/projects/${be!.projectId}/${path}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${be!.token}`, 'content-type': 'application/json', origin: be!.origin },
    body: JSON.stringify(body),
  });
  return { status: r.status, json: (await r.json()) as Record<string, unknown> };
}

async function script(behaviorId: string, text: string, entityId: string): Promise<void> {
  const declaration = { properties: [] };
  await cmd('publishBehavior', { behaviorId, displayName: behaviorId, mode: 'declaration-create', declaration });
  const bytes = Buffer.from(`${JSON.stringify({ graphVersion: 1, entryPath: 'src/index.ts', requiredModules: [], ownedTransforms: [], files: [{ path: 'src/index.ts', text }] }, null, 2)}\n`);
  const stage = await api('content/stages', {});
  const stageId = String(stage.json.stageId);
  const put = await fetch(`${be!.origin}/api/v1/projects/${be!.projectId}/content/stages/${stageId}/bytes`, {
    method: 'PUT',
    headers: { authorization: `Bearer ${be!.token}`, origin: be!.origin, 'content-type': 'application/octet-stream', 'x-thirdlight-offset': '0', 'x-thirdlight-total': String(bytes.length) },
    body: bytes,
  });
  expect(put.status).toBe(200);
  await cmd('acknowledgeBehaviorTrust', { sourceDigest: createHash('sha256').update(bytes).digest('hex') });
  const published = await api('content/behaviors/source', { stageId, behaviorId, displayName: behaviorId, declaration, expectedRevision: Number((await query('queryProject')).revision), requestId: `req-${randomBytes(16).toString('hex')}` });
  expect(published.status, JSON.stringify(published.json)).toBe(200);
  await cmd('setBehaviorProperties', { entityId, behaviorId, values: {} });
}

/** Swaps the left panel on debug commands: "swap" to the blue material, "back" to its own. */
const director = (panel: string): string => [
  'export default {',
  '  step(_s: unknown, ctx: any) {',
  "    if (ctx.phase !== 'intent') return;",
  `    const panel = ctx.entity(${JSON.stringify(panel)});`,
  "    for (const _ of ctx.debug.command('swap')) if (panel.set('materials', { '*': 'mat-blue' }).ok) ctx.game.add('swapped', 1);",
  "    for (const _ of ctx.debug.command('back')) if (panel.set('materials', { '*': null }).ok) ctx.game.add('back', 1);",
  "    if (ctx.stepIndex === 30 && panel.get('materials')['*'] === 'mat-red') ctx.game.add('read_red', 1);",
  '  },',
  '};',
  '',
].join('\n');

type Colour = 'red' | 'blue' | 'green' | 'white' | 'other';
const classify = (r: number, g: number, b: number): Colour => {
  if (r > 150 && g < 80 && b < 80) return 'red';
  if (b > 150 && r < 80 && g < 80) return 'blue';
  if (g > 150 && r < 80 && b < 80) return 'green';
  if (r > 200 && g > 200 && b > 200) return 'white';
  return 'other';
};

/** The colour most of a canvas region shows (fractions of the canvas), with the share of each. */
async function regionColour(canvas: Locator, x0: number, x1: number, y0: number, y1: number): Promise<Record<Colour, number>> {
  const img = decodePng(await canvas.screenshot());
  const out: Record<Colour, number> = { red: 0, blue: 0, green: 0, white: 0, other: 0 };
  let n = 0;
  for (let y = Math.floor(y0 * img.height); y < y1 * img.height; y += 2) {
    for (let x = Math.floor(x0 * img.width); x < x1 * img.width; x += 2) {
      const [r, g, b] = img.pixel(x, y);
      out[classify(r, g, b)] += 1;
      n += 1;
    }
  }
  for (const k of Object.keys(out) as Colour[]) out[k] = out[k] / Math.max(1, n);
  return out;
}

/** Build the scene; returns the two panels' ids and the blue texture's bytes digest. */
async function buildScene(): Promise<{ left: string; right: string; blueDigest: string }> {
  const blue = makePng(64, 64, () => [20, 40, 230, 255]);
  await publishBytes(be!, blue, 'texture', 'tex-blue');
  await publishBytes(be!, makePng(64, 64, () => [30, 220, 40, 255]), 'texture', 'tex-green');
  await cmd('setMaterial', { material: { materialId: 'mat-red', name: 'Red', shader: 'unlit', params: { color: '#ff0000' }, textures: {} } });
  await cmd('setMaterial', { material: { materialId: 'mat-blue', name: 'Blue', shader: 'unlit', params: { color: '#ffffff' }, textures: { map: 'tex-blue' } } });
  await cmd('setMaterial', { material: { materialId: 'mat-green', name: 'Green', shader: 'unlit', params: { color: '#ffffff' }, textures: { map: 'tex-green' } } });
  // The blue material is named only by the script: a label ships it.
  await cmd('setLabels', { items: [{ kind: 'material', id: 'mat-blue' }], add: ['swaps'] });
  const panel = async (name: string, x: number): Promise<string> => {
    const id = String((await cmd('createEntity', { sceneId: 'scene-main', kind: 'box', name, transform: { position: [x, 2.6, 6] }, box: { size: [1.6, 1.6, 0.1], material: { color: '#808080' } } })).createdId);
    await cmd('setComponent', { entityId: id, component: 'materials', value: { '*': 'mat-red' } });
    return id;
  };
  const left = await panel('Left panel', 3);
  const right = await panel('Right panel', 5);
  const host = String((await cmd('createEntity', { sceneId: 'scene-main', kind: 'group', name: 'Director', transform: { position: [0, -20, 0] } })).createdId);
  await script('director', director(left), host);
  await cmd('setTimeline', {
    timeline: {
      timelineId: 'dusk',
      name: 'Dusk',
      duration: 2,
      playOnStart: true,
      slots: [{ name: 'panel', entity: right }],
      tracks: [{ trackId: 'swap', type: 'materialSwap', target: 'panel', keys: [{ time: 1, materials: { '*': 'mat-green' } }] }],
    },
  });
  return { left, right, blueDigest: createHash('sha256').update(blue).digest('hex') };
}

for (const variant of RENDERER_VARIANTS) {
  test(`a swapped material shows only once it has loaded; a timeline key swaps too [${variant}]`, async ({ page }) => {
    onlyInItsProject(variant);
    test.setTimeout(300_000);
    be = await startBackend('material-swap', 'starter');
    const s = await buildScene();
    // The blue texture's bytes are held back until released (every request that names the asset or its digest).
    let release: () => void = () => undefined;
    const released = new Promise<void>((r) => (release = r));
    const held: string[] = [];
    await page.context().route((url) => url.href.includes(s.blueDigest) || url.href.includes('tex-blue'), async (route) => {
      held.push(route.request().url());
      await released;
      await route.continue();
    });

    await page.goto(editorUrlFor(be.editorUrl, variant));
    await expect(page.locator('.tl-statusbar')).toContainText('connected');
    const started = page.waitForResponse((r) => r.request().method() === 'POST' && r.url().endsWith('/play'));
    await page.getByTitle('Start an isolated play preview').click();
    const psid = String(((await (await started).json()) as { playSessionId: string }).playSessionId);
    type Obs = { state?: string; counters?: Record<string, number> };
    const observe = async (): Promise<Obs> => (await api(`play/${psid}/observe`)).json as Obs;
    await expect.poll(async () => (await observe()).state, { timeout: 60_000 }).toBe('running');
    const canvas = page.frameLocator('iframe.tl-app__preview-frame').locator('canvas').first();
    await expectRendererBackend(canvas, variant);
    // Where the panels are on the canvas: the left one's centre is left of the middle, the right one's right of it.
    const left = (): Promise<Record<Colour, number>> => regionColour(canvas, 0.37, 0.47, 0.48, 0.64);
    const right = (): Promise<Record<Colour, number>> => regionColour(canvas, 0.53, 0.63, 0.48, 0.64);
    await expect.poll(async () => (await left()).red, { timeout: 30_000, message: 'the left panel is red' }).toBeGreaterThan(0.3);
    expect((await observe()).counters?.['read_red']).toBe(1);

    // The timeline's key at 1 s: the right panel turns green (its texture is not held).
    await expect.poll(async () => (await right()).green, { timeout: 30_000, message: 'the timeline swapped the right panel' }).toBeGreaterThan(0.3);

    // The swap, its texture held back: the panel stays red, never white or blue.
    const r = await api(`play/${psid}/control`, { command: 'debugCommand', name: 'swap' });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    await expect.poll(async () => (await observe()).counters?.['swapped'] ?? 0, { timeout: 30_000 }).toBe(1);
    await expect.poll(() => held.length, { timeout: 30_000, message: 'the texture was asked for after the swap' }).toBeGreaterThan(0);
    for (let i = 0; i < 6; i += 1) {
      const c = await left();
      expect(c.red, JSON.stringify(c)).toBeGreaterThan(0.3);
      expect(c.white + c.blue, JSON.stringify(c)).toBeLessThan(0.05);
      await page.waitForTimeout(250);
    }
    await page.screenshot({ path: `test-results/material-swap-held-${variant}.png` });
    // Released: it turns blue.
    release();
    await expect.poll(async () => (await left()).blue, { timeout: 30_000, message: 'blue once the texture arrived' }).toBeGreaterThan(0.3);
    await page.screenshot({ path: `test-results/material-swap-${variant}.png` });
    // null: its own material again.
    await api(`play/${psid}/control`, { command: 'debugCommand', name: 'back' });
    await expect.poll(async () => (await left()).red, { timeout: 30_000, message: 'red again' }).toBeGreaterThan(0.3);
    expect((await observe()).state).toBe('running');
  });
}

test('editor: a material swap track and key in the Timeline window', async ({ page }: { page: Page }) => {
  test.skip(test.info().project.name === 'webgpu', 'renderer-independent UI (the default project covers it)');
  test.setTimeout(180_000);
  be = await startBackend('material-swap-editor', 'starter');
  await cmd('setMaterial', { material: { materialId: 'mat-red', name: 'Red', shader: 'unlit', params: { color: '#ff0000' }, textures: {} } });
  const box = String((await cmd('createEntity', { sceneId: 'scene-main', kind: 'box', name: 'Panel', transform: { position: [3, 2, 6] }, box: { size: [1, 1, 0.1], material: { color: '#808080' } } })).createdId);
  await cmd('setTimeline', { timeline: { timelineId: 'night', name: 'Night', duration: 3, slots: [{ name: 'panel', entity: box }], tracks: [] } });
  const stored = async (): Promise<{ type: string; target?: string; keys: { time: number; materials?: Record<string, string | null> }[] }[]> => {
    const g = await query('queryGameConfig');
    const tl = ((g['timelines'] ?? (g['game'] as Record<string, unknown> | undefined)?.['timelines']) as { timelineId: string; tracks: { type: string; target?: string; keys: { time: number; materials?: Record<string, string | null> }[] }[] }[]).find((t) => t.timelineId === 'night')!;
    return tl.tracks;
  };
  await page.goto(be.editorUrl);
  await expect(page.locator('.tl-statusbar')).toContainText('connected');
  await openEditor(page, 'Timeline', 'Night');
  await page.getByLabel('New track type').selectOption('materialSwap');
  await page.getByRole('button', { name: 'Add track' }).click();
  await expect.poll(async () => (await stored()).map((t) => `${t.type}:${t.target ?? ''}`)).toEqual(['materialSwap:panel']);
  await page.locator('.tl-timeline__lane').first().dispatchEvent('pointerdown');
  await page.getByRole('button', { name: 'Add key at playhead' }).click();
  await expect.poll(async () => (await stored())[0]!.keys.map((k) => k.materials)).toEqual([{ '*': null }]);
  await page.getByLabel('Swap material *').selectOption('mat-red');
  await expect.poll(async () => (await stored())[0]!.keys.map((k) => k.materials)).toEqual([{ '*': 'mat-red' }]);
});
