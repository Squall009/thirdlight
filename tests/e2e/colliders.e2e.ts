/**
 * Colliders in a real browser against a real backend: shapes placed by a
 * center and a rotation, compounds, the model's `_COL` parts (resolved when
 * the game is built), the conversion command (HTTP) equal to the editor's
 * button.
 *
 * A neutral kit GLB "stall" (a 4 × 0.5 × 1 m render box) has a `_COL` node
 * of two box parts: a 1 m cube at the origin and a 1 m cube raised to
 * y 2..3 at x 3..4. One object carries the model with a collider
 * `{type: 'model'}`; the player dropped above each part in Play comes to rest
 * on that part's top (the compound stops it at each part, not at the
 * object's origin, and between them nothing). A thin beam's box collider
 * sits 2 m above its object and is turned 90° about Y, so it runs along Z:
 * the player dropped 1.5 m along Z from the object rests on it. The
 * conversion command over HTTP and the Inspector's "Compound of _COL parts"
 * button store the same compound. A plate on a child of an object its
 * script moves follows it and pushes the player ahead of it. The Scene view
 * draws no collider outlines until asked, the selection's always.
 */
import { randomBytes } from 'node:crypto';

import { expect, test, type Page } from '@playwright/test';

import { publishBytes, publishScript, startBackend, type E2EBackend } from './backend';
import { multiPieceGlb } from './multi-piece-glb';
import { decodePng } from './png';
import { menu } from './ui';

let be: E2EBackend | null = null;
test.afterEach(async () => {
  await be?.stop();
  be = null;
});

type Observation = { state: string; stepIndex?: number; player?: { x: number; y: number; z: number } };
type Ent = { id: string; name?: string; components: Record<string, Record<string, unknown> | undefined> };

async function cmd(op: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const revision = Number((await be!.command({ op: 'queryProject', projectId: be!.projectId, args: {} })).revision);
  const res = await be!.command({ op, projectId: be!.projectId, expectedRevision: revision, requestId: `req-${randomBytes(16).toString('hex')}`, origin: { kind: 'mcp', clientId: 'e2e-colliders' }, args });
  expect(res['ok'], JSON.stringify(res)).toBe(true);
  return res;
}
async function comp(id: string, name: string): Promise<Record<string, unknown> | undefined> {
  const r = await be!.command({ op: 'queryEntity', projectId: be!.projectId, args: { entityId: id } });
  return (r['entity'] as { components: Record<string, Record<string, unknown>> }).components[name];
}
async function entities(): Promise<Ent[]> {
  return (await be!.command({ op: 'queryEntities', projectId: be!.projectId, args: { limit: 200, offset: 0 } }))['entities'] as Ent[];
}
async function create(name: string, position: number[], components: Record<string, unknown>): Promise<string> {
  // A model is made by the create's kind.
  const { model, ...rest } = components;
  return String((await cmd('createEntity', { sceneId: 'scene-main', parentId: null, kind: model !== undefined ? 'model' : 'group', name, transform: { position }, ...(model !== undefined ? { model } : {}), components: rest }))['createdId']);
}
async function relay(path: string, body: unknown): Promise<{ status: number; json: Record<string, unknown> }> {
  const r = await fetch(`${be!.origin}/api/v1/projects/${be!.projectId}/play/${path}`, { method: 'POST', headers: { authorization: `Bearer ${be!.token}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return { status: r.status, json: (await r.json()) as Record<string, unknown> };
}

/** Start Play from the editor page, wait until the player is at rest (two reads with later steps agree), stop Play. */
async function restingPlayer(page: Page, what: string, ready: (p: { x: number; y: number; z: number }) => boolean = () => true): Promise<{ x: number; y: number; z: number }> {
  const started = page.waitForResponse((r) => r.request().method() === 'POST' && r.url().endsWith('/play'));
  await page.getByTitle('Start an isolated play preview').click();
  const psid = String(((await (await started).json()) as { playSessionId: string }).playSessionId);
  await expect.poll(async () => (await relay(`${psid}/observe`, {})).status, { timeout: 30_000 }).toBe(200);
  let last: Observation | null = null;
  const seen: string[] = [];
  const settled = expect
    .poll(
      async () => {
        const r = await relay(`${psid}/observe`, {});
        const o = r.status === 200 ? (r.json as unknown as Observation) : null;
        if (o?.player !== undefined) seen.push(`${o.stepIndex}:${o.player.x.toFixed(3)},${o.player.y.toFixed(3)}`);
        const same = o?.player !== undefined && last?.player !== undefined && ready(o.player) && o.player.x === last.player.x && o.player.y === last.player.y && o.player.z === last.player.z && (o.stepIndex ?? 0) > (last.stepIndex ?? 0);
        last = o;
        return same;
      },
      { timeout: 60_000, intervals: [250], message: `${what}: at rest` },
    )
    .toBe(true);
  await settled.catch((e: unknown) => {
    throw new Error(`${String(e)}; last seen ${JSON.stringify(last)}`);
  });
  await page.getByTitle('Stop the play preview').click();
  await expect(page.getByTitle('Start an isolated play preview')).toBeVisible({ timeout: 30_000 });
  if (process.env['TL_COLLIDER_TRACE'] !== undefined) console.log(what, seen.join(' '));
  return last!.player!;
}

test('3D: a model collider stops the player on each _COL part, a placed box where it is; the conversion command equals the editor button', async ({ page }) => {
  test.setTimeout(360_000);
  be = await startBackend('colliders-e2e');
  await cmd('setSettings', { settings: { physics_dimension: 3 } });
  // No other bodies: whatever the player lands on is one of ours.
  for (const e of await entities()) if (e.components['collider'] !== undefined || e.components['controller'] !== undefined) await cmd('deleteEntity', { entityId: e.id });
  await publishBytes(be, new Uint8Array(multiPieceGlb([{ name: 'stall', lods: [[4, 0.5, 1]], colParts: [{ size: [1, 1, 1], at: [0, 0, 0] }, { size: [1, 1, 1], at: [3, 2, 0] }] }])), 'model', 'model-stall', 'Stall');

  // The conversion command over HTTP: a compound of the two parts' hulls.
  const viaHttp = await create('Stall (command)', [0, 0, 20], { model: { asset: { assetId: 'model-stall' } } });
  await cmd('colliderFromModel', { entityId: viaHttp, kind: 'compound' });
  const httpShape = (await comp(viaHttp, 'collider'))!['shape'] as { type: string; shapes: { type: string; points: number[][] }[] };
  expect(httpShape.type).toBe('compound');
  expect(httpShape.shapes.map((s) => s.type)).toEqual(['convex', 'convex']);
  expect(httpShape.shapes[1]!.points).toContainEqual([4, 3, 0.5]);

  // The same from the Inspector's button.
  const viaButton = await create('Stall (button)', [0, 0, 30], { model: { asset: { assetId: 'model-stall' } }, collider: { shape: { type: 'box', hx: 1, hy: 1, hz: 1 } } });
  await page.goto(be.editorUrl);
  await expect(page.locator('.tl-statusbar')).toContainText('connected');
  await page.locator(`.tl-hierarchy__list li[data-entity-id="${viaButton}"]`).click();
  await page.getByRole('button', { name: 'Compound of _COL parts', exact: true }).click();
  await expect.poll(async () => ((await comp(viaButton, 'collider'))?.['shape'] as { type?: string } | undefined)?.type).toBe('compound');
  expect((await comp(viaButton, 'collider'))!['shape']).toEqual(httpShape);
  // Both go: their bodies would be in the way of the drops below.
  await cmd('deleteEntity', { entityId: viaHttp });
  await cmd('deleteEntity', { entityId: viaButton });

  // The stall resolved when the game is built; a beam whose box sits 2 m up, turned to run along Z.
  await create('Stall', [0, 0, 0], { model: { asset: { assetId: 'model-stall' } }, collider: { shape: { type: 'model' } } });
  const s = Math.SQRT1_2;
  await create('Beam', [10, 0, 0], { collider: { shape: { type: 'box', hx: 2, hy: 0.25, hz: 0.2, center: [0, 2, 0], rotation: [0, s, 0, s] } } });
  const player = await create('Player', [3.5, 6, 0], {});
  await cmd('setComponent', { entityId: player, component: 'controller', value: {} });
  await page.reload();
  await expect(page.locator('.tl-statusbar')).toContainText('connected');

  // On the raised part: its top at 3 m, the capsule's origin 0.9 m above (the skin's centimetre aside).
  const onB = await restingPlayer(page, 'raised part');
  expect(onB.x).toBeCloseTo(3.5, 3);
  expect(onB.y).toBeGreaterThan(3.9 - 1e-3);
  expect(onB.y).toBeLessThan(3.92);
  // On the low part (top at 1 m).
  await cmd('setTransform', { entityId: player, transform: { position: [0.5, 6, 0] } });
  const onA = await restingPlayer(page, 'low part');
  expect(onA.y).toBeGreaterThan(1.9 - 1e-3);
  expect(onA.y).toBeLessThan(1.92);
  // On the beam: 1.5 m along Z from its object, only there once the box is turned (its own depth is 0.2 m); top 2.25 m.
  await cmd('setTransform', { entityId: player, transform: { position: [10, 6, 1.5] } });
  const onBeam = await restingPlayer(page, 'beam');
  expect(onBeam.z).toBeCloseTo(1.5, 3);
  expect(onBeam.y).toBeGreaterThan(3.15 - 1e-3);
  expect(onBeam.y).toBeLessThan(3.17);
});

/**
 * A pusher: from step 60 the object owning it moves along +x at 1 m/s until
 * x = 2 (its own script, the transform phase). It has no collider itself;
 * its child "Plate" has.
 */
const PUSHER = [
  'export default {',
  '  instantiate() { return {}; },',
  '  step(_state: any, ctx: any) {',
  "    if (ctx.phase !== 'transform' || ctx.stepIndex < 60) return;",
  '    const x = Math.min(2, -3 + (ctx.stepIndex - 60) / 120);',
  "    ctx.emit({ kind: 'transform', entityId: ctx.entityId, position: { x, y: 0, z: 0 }, quaternion: [0, 0, 0, 1] });",
  '  },',
  '};',
  '',
].join('\n');

test('3D: a collider on a child follows its script-moved parent and pushes the player', async ({ page }) => {
  test.setTimeout(300_000);
  be = await startBackend('colliders-child-e2e');
  await cmd('setSettings', { settings: { physics_dimension: 3 } });
  for (const e of await entities()) if (e.components['collider'] !== undefined || e.components['controller'] !== undefined) await cmd('deleteEntity', { entityId: e.id });
  await create('Floor', [0, -0.5, 0], { collider: { shape: { type: 'box', hx: 10, hy: 0.5, hz: 10 } } });
  const pusher = await create('Pusher', [-3, 0, 0], {});
  await cmd('createEntity', { sceneId: 'scene-main', parentId: pusher, kind: 'group', name: 'Plate', transform: { position: [0, 0, 0] }, components: { collider: { shape: { type: 'box', hx: 0.1, hy: 1, hz: 1, center: [0, 1, 0] } } } });
  const player = await create('Player', [0, 0.92, 0], {});
  await cmd('setComponent', { entityId: player, component: 'controller', value: {} });
  await publishScript(be, 'pusher', PUSHER, pusher, ['@self']);
  await page.goto(be.editorUrl);
  await expect(page.locator('.tl-statusbar')).toContainText('connected');
  // The plate ends at x = 2 (its face at 2.1); the player, pushed 2 m and more, rests beyond its face. (The 3D
  // character controller keeps a pushed character about 0.1 m into a sideways-moving body, a mover's too.)
  const pushed = await restingPlayer(page, 'pushed', (p) => p.x > 1);
  expect(pushed.x).toBeGreaterThan(2.1);
  expect(pushed.x).toBeLessThan(2.1 + 0.3 + 0.1);
  expect(Math.abs(pushed.z)).toBeLessThan(0.05);
});

/** The Scene view's pixels in the collider outline colour (lime: much green, some red, little blue). */
async function outlinePixels(page: Page): Promise<number> {
  const img = decodePng(await page.locator('canvas.tl-viewport').screenshot());
  let n = 0;
  for (let y = 0; y < img.height; y += 1) {
    for (let x = 0; x < img.width; x += 1) {
      const [r, g, b] = img.pixel(x, y);
      if (g > 180 && r > 60 && r < 0.8 * g && b < 0.4 * g) n += 1;
    }
  }
  return n;
}

test('the Scene view draws no collider outlines on open, the selection\'s (a compound and its child\'s) when selected, all with the Gizmos menu', async ({ page }) => {
  test.setTimeout(180_000);
  be = await startBackend('colliders-outlines-e2e');
  await cmd('setSettings', { settings: { physics_dimension: 3 } });
  for (const e of await entities()) if (e.components['collider'] !== undefined) await cmd('deleteEntity', { entityId: e.id });
  const cart = await create('Cart', [0, 0, 0], { collider: { shape: { type: 'compound', shapes: [{ type: 'box', hx: 0.5, hy: 0.5, hz: 0.5, center: [-1.5, 0, 0] }, { type: 'box', hx: 0.5, hy: 0.5, hz: 0.5, center: [1.5, 0, 0] }] } } });
  const wheel = String((await cmd('createEntity', { sceneId: 'scene-main', parentId: cart, kind: 'group', name: 'Wheel', transform: { position: [0, -1, 0] }, components: { collider: { shape: { type: 'sphere', radius: 0.4 } } } }))['createdId']);
  const rock = await create('Rock', [0, 2.5, 0], { collider: { shape: { type: 'box', hx: 1, hy: 0.3, hz: 1 } } });
  await page.goto(be.editorUrl);
  await expect(page.locator('.tl-statusbar')).toContainText('connected');
  const view = page.locator('canvas[data-collider-outlines]');
  await expect.poll(async () => Number(await view.getAttribute('data-collider-outlines'))).toBe(3);

  // On open: none drawn.
  await expect(view).toHaveAttribute('data-gizmos', 'icons lights gameplay');
  await expect(view).toHaveAttribute('data-collider-outlines-shown', '');
  await page.locator(`.tl-hierarchy__list li[data-entity-id="${cart}"]`).click();
  await page.keyboard.press('f');
  await page.locator(`.tl-hierarchy__list li[data-entity-id="${rock}"]`).click();
  await page.keyboard.press('Escape');
  await page.mouse.click(5, 5);
  await expect.poll(async () => (await view.getAttribute('data-collider-outlines-shown')) ?? 'x').toBe('');
  expect(await outlinePixels(page)).toBe(0);

  // The cart selected: its compound's two boxes and its child's sphere.
  await page.locator(`.tl-hierarchy__list li[data-entity-id="${cart}"]`).click();
  await expect(view).toHaveAttribute('data-collider-outlines-shown', `${cart} ${wheel}`);
  await expect.poll(() => outlinePixels(page), { message: 'the selection\'s outlines are drawn' }).toBeGreaterThan(100);

  // The Gizmos menu: every outline, the selection's or not.
  await menu(page, 'Gizmos', 'Collider outlines: off');
  await expect(view).toHaveAttribute('data-gizmos', 'icons lights colliders gameplay');
  await expect(view).toHaveAttribute('data-collider-outlines-shown', `${cart} ${wheel} ${rock}`);
  await page.keyboard.press('Escape');
  await expect(page.locator('.tl-hierarchy__list li.is-selected')).toHaveCount(0);
  await expect.poll(() => outlinePixels(page), { message: 'every outline is drawn with nothing selected' }).toBeGreaterThan(100);
});
