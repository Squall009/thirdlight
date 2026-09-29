/**
 * Phase 25.10: generic component access against a real backend — the
 * editor's side and a script changing a light and an object's `active` in
 * Play, checked in pixels (under each renderer variant; the forced WebGL 2
 * one with TL_E2E_ALL_VARIANTS=1).
 *
 * The starter template with its sun turned red and aimed at the camera's
 * view, a dim fill and a white wall behind everything, and a director box
 * carrying a script with two object (`entityRef`) properties.
 *
 * - Inspector: each object property is a picker of the scene's objects; the
 *   sun and the wall are picked there (one `setBehaviorProperties` each) and
 *   stay picked after a reload. The mover's "Moving" switch (a descriptor
 *   field scripts write) is an ordinary Inspector field.
 * - Script editor: the behavior API typings complete `ctx.entity` and
 *   `ctx.shell`.
 * - Play: the script reads the sun through `ctx.entity(sun).get('light')`
 *   and on the debug command "stage" writes it blue (the picture turns from
 *   red to blue), then switches the wall off (`set('object', { active:
 *   false })`: it is not drawn — its blue-lit face leaves the picture), then
 *   tries to change the light's type and is refused with the field named.
 */
import { randomBytes, createHash } from 'node:crypto';

import { expect, test, type Page } from '@playwright/test';

import { startBackend, type E2EBackend } from './backend';
import { decodePng, type Image } from './png';
import { editorUrlFor, expectRendererBackend, onlyInItsProject, RENDERER_VARIANTS } from './renderer-variants';

let be: E2EBackend | null = null;
test.afterEach(async () => {
  await be?.stop();
  be = null;
});

async function query(op: string, args: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  return be!.command({ op, projectId: be!.projectId, args });
}
async function cmd(op: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const res = await be!.command({ op, projectId: be!.projectId, expectedRevision: Number((await query('queryProject')).revision), requestId: `req-${randomBytes(16).toString('hex')}`, origin: { kind: 'mcp', clientId: 'e2e-entity-access' }, args });
  expect(res.ok, JSON.stringify(res)).toBe(true);
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

function share(img: Image, test: (r: number, g: number, b: number) => boolean): number {
  let n = 0;
  let all = 0;
  for (let y = 0; y < img.height; y += 2) {
    for (let x = 0; x < img.width; x += 2) {
      const [r, g, b] = img.pixel(x, y);
      all += 1;
      if (test(r, g, b)) n += 1;
    }
  }
  return n / all;
}
const red = (r: number, g: number, b: number): boolean => r > 60 && r > 2 * g && r > 2 * b;
const blue = (r: number, g: number, b: number): boolean => b > 60 && b > 2 * r && b > 2 * g;

const DIRECTOR = [
  'export default {',
  '  instantiate() { return { stage: 0, done: 0 }; },',
  '  step(state: any, ctx: any) {',
  "    if (ctx.phase !== 'intent') return;",
  "    for (const _ of ctx.debug.command('stage')) state.stage += 1;",
  '    const sun = ctx.entity(ctx.properties.sun);',
  '    const wall = ctx.entity(ctx.properties.wall);',
  '    if (sun === null || wall === null || state.done === state.stage) return;',
  '    state.done = state.stage;',
  '    if (state.stage === 1) {',
  "      if (sun.get('light').color === '#ff0000') ctx.game.add('read_red', 1);",
  "      if (sun.set('light', { color: '#0000ff' }).ok) ctx.game.add('wrote_blue', 1);",
  '    }',
  "    if (state.stage === 2 && wall.set('object', { active: false }).ok) ctx.game.add('wall_off', 1);",
  '    if (state.stage === 3) {',
  "      const r = sun.set('light', { type: 'spot' });",
  "      if (!r.ok && r.field === 'light.type' && r.code === 'field_not_writable') ctx.game.add('refused', 1);",
  "      if (sun.get('light').color === '#0000ff' && wall.get('object').active === false) ctx.game.add('read_back', 1);",
  '    }',
  '  },',
  '};',
  '',
].join('\n');
const DECLARATION = { properties: [{ key: 'sun', label: 'Sun', type: 'entityRef', default: null }, { key: 'wall', label: 'Wall', type: 'entityRef', default: null }] };

async function publishDirector(): Promise<void> {
  await cmd('publishBehavior', { behaviorId: 'director', displayName: 'Director', mode: 'declaration-create', declaration: DECLARATION });
  const bytes = Buffer.from(`${JSON.stringify({ graphVersion: 1, entryPath: 'src/index.ts', requiredModules: [], ownedTransforms: [], files: [{ path: 'src/index.ts', text: DIRECTOR }] }, null, 2)}\n`);
  const stage = await api('content/stages', {});
  const stageId = String(stage.json.stageId);
  const put = await fetch(`${be!.origin}/api/v1/projects/${be!.projectId}/content/stages/${stageId}/bytes`, {
    method: 'PUT',
    headers: { authorization: `Bearer ${be!.token}`, origin: be!.origin, 'content-type': 'application/octet-stream', 'x-thirdlight-offset': '0', 'x-thirdlight-total': String(bytes.length) },
    body: bytes,
  });
  expect(put.status).toBe(200);
  await cmd('acknowledgeBehaviorTrust', { sourceDigest: createHash('sha256').update(bytes).digest('hex') });
  const published = await api('content/behaviors/source', { stageId, behaviorId: 'director', displayName: 'Director', declaration: DECLARATION, expectedRevision: Number((await query('queryProject')).revision), requestId: `req-${randomBytes(16).toString('hex')}` });
  expect(published.status, JSON.stringify(published.json)).toBe(200);
}

async function componentOf(entityId: string, component: string): Promise<unknown> {
  const list = (await query('queryEntities', { limit: 500, offset: 0 }))['entities'] as { id: string; components: Record<string, unknown> }[];
  return list.find((e) => e.id === entityId)?.components[component];
}

async function openEditor(page: Page, url: string): Promise<void> {
  await page.goto(url);
  await expect(page.locator('.tl-statusbar')).toContainText('connected');
}

for (const variant of RENDERER_VARIANTS) test(`ctx.entity: object properties picked in the Inspector, typings, a light and an object switched by a script in Play (${variant})`, async ({ page }) => {
  onlyInItsProject(variant);
  test.setTimeout(300_000);
  be = await startBackend('entity-access-e2e', 'starter');

  // A red sun shining at the camera's view, a dim fill, a white wall behind everything, a director box and a lift.
  await cmd('setComponent', { entityId: 'light-0001', component: 'light', value: { type: 'directional', color: '#ff0000', intensity: 3, direction: [0, -0.2, -1], castShadow: false } });
  await cmd('setComponent', { entityId: 'light-0002', component: 'light', value: { type: 'ambient', color: '#ffffff', intensity: 0.05 } });
  const wallId = String((await cmd('createEntity', { parentId: null, kind: 'box', name: 'Back wall', transform: { position: [4, 3, -4] }, box: { size: [60, 40, 1], material: { color: '#ffffff' } } }))['createdId']);
  const directorId = String((await cmd('createEntity', { parentId: null, kind: 'box', name: 'Director', transform: { position: [0, -20, 0] }, box: { size: [0.2, 0.2, 0.2], material: { color: '#808080' } } }))['createdId']);
  const liftId = String((await cmd('createEntity', { parentId: null, kind: 'box', name: 'Lift', transform: { position: [0, -30, 0] }, box: { size: [1, 0.2, 1], material: { color: '#808080' } } }))['createdId']);
  await cmd('setComponent', { entityId: liftId, component: 'mover', value: { waypoints: [[2, 0, 0]], speed: 2, mode: 'pingpong' } });
  await publishDirector();
  await cmd('setBehaviorProperties', { entityId: directorId, behaviorId: 'director', values: {} });

  const url = editorUrlFor(be.editorUrl, variant);
  await openEditor(page, url);

  // Inspector: the object properties are pickers of the scene's objects.
  const inspector = page.locator('.tl-inspector');
  await page.locator(`.tl-hierarchy__list li[data-entity-id="${directorId}"]`).click();
  const sunPick = inspector.locator('select[data-entity-ref="sun"]');
  await expect(sunPick).toHaveValue('');
  await expect(sunPick.locator(`option[value="${wallId}"]`)).toHaveCount(1);
  await sunPick.selectOption('light-0001');
  // The editor sends the whole declared values map (defaults included).
  await expect.poll(() => componentOf(directorId, 'behavior')).toEqual({ behaviorId: 'director', values: { sun: 'light-0001', wall: null } });
  await inspector.locator('select[data-entity-ref="wall"]').selectOption(wallId);
  await expect.poll(() => componentOf(directorId, 'behavior')).toEqual({ behaviorId: 'director', values: { sun: 'light-0001', wall: wallId } });
  // "none" clears one.
  await inspector.locator('select[data-entity-ref="wall"]').selectOption('');
  await expect.poll(() => componentOf(directorId, 'behavior')).toEqual({ behaviorId: 'director', values: { sun: 'light-0001', wall: null } });
  await inspector.locator('select[data-entity-ref="wall"]').selectOption(wallId);
  await expect.poll(() => componentOf(directorId, 'behavior')).toEqual({ behaviorId: 'director', values: { sun: 'light-0001', wall: wallId } });

  // The mover's "Moving" switch: an ordinary descriptor field (stored only when off).
  await page.locator(`.tl-hierarchy__list li[data-entity-id="${liftId}"]`).click();
  const moving = inspector.getByLabel('mover active', { exact: true });
  await expect(moving).toBeChecked();
  await moving.click();
  await expect.poll(() => componentOf(liftId, 'mover')).toMatchObject({ active: false });
  await expect(moving).not.toBeChecked();
  await moving.click();
  await expect.poll(async () => (await componentOf(liftId, 'mover') as Record<string, unknown>)['active']).toBeUndefined();

  // After a reload the pickers show the stored objects.
  await openEditor(page, url);
  await page.locator(`.tl-hierarchy__list li[data-entity-id="${directorId}"]`).click();
  await expect(inspector.locator('select[data-entity-ref="sun"]')).toHaveValue('light-0001');
  await expect(inspector.locator('select[data-entity-ref="wall"]')).toHaveValue(wallId);

  // Script editor: the typings complete the new context members.
  await page.getByRole('tab', { name: 'Behaviors' }).click();
  await page.locator('.tl-behaviors__list .tl-tile', { hasText: 'Director' }).dblclick();
  const view = page.getByRole('tabpanel', { name: 'Script: Director' });
  await expect(view.getByLabel('script editor')).toHaveAttribute('data-behavior', 'director');
  await view.locator('.cm-line', { hasText: "ctx.phase !== 'intent'" }).click();
  await page.keyboard.press('End');
  await page.keyboard.press('Enter');
  const completion = page.locator('.cm-tooltip-autocomplete');
  await page.keyboard.type('ctx.enti');
  await expect(completion).toContainText('entity');
  await page.keyboard.press('Escape');
  await page.keyboard.type(';ctx.she');
  await expect(completion).toContainText('shell');
  await page.keyboard.press('Escape');

  // Play: red, then (stage 1) blue through ctx.entity(sun).set('light'), then (stage 2) the wall switched off.
  page.on('pageerror', (e) => console.log(`[page pageerror] ${e.message}`));
  await openEditor(page, url);
  const started = page.waitForResponse((r) => r.request().method() === 'POST' && r.url().endsWith('/play'));
  await page.getByTitle('Start an isolated play preview').click();
  const psid = String(((await (await started).json()) as { playSessionId: string }).playSessionId);
  await expectRendererBackend(page.frameLocator('iframe.tl-app__preview-frame').locator('canvas').first(), variant);
  type Obs = { state?: string; counters?: Record<string, number>; hidden?: string[] };
  const observe = async (): Promise<Obs> => (await api(`play/${psid}/observe`)).json as Obs;
  await expect.poll(async () => (await observe()).state, { timeout: 60_000 }).toBe('running');
  const shot = async (): Promise<Image> => {
    const r = await api(`play/${psid}/screenshot`, { maxWidth: 512 });
    expect(r.status, JSON.stringify(r.json).slice(0, 200)).toBe(200);
    return decodePng(Buffer.from(String(r.json['dataUrl']).replace(/^data:image\/png;base64,/, ''), 'base64'));
  };
  const stage = async (): Promise<void> => {
    const r = await api(`play/${psid}/control`, { command: 'debugCommand', name: 'stage' });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
  };
  const log = async (what: string): Promise<Image> => {
    const img = await shot();
    console.log(`${what} (${variant}): red ${share(img, red).toFixed(3)} blue ${share(img, blue).toFixed(3)}`);
    return img;
  };
  await expect.poll(async () => share(await shot(), red), { timeout: 30_000 }).toBeGreaterThan(0.3);
  await log('start');

  await stage();
  await expect.poll(async () => (await observe()).counters?.['wrote_blue'], { timeout: 30_000 }).toBe(1);
  expect((await observe()).counters?.['read_red']).toBe(1);
  await expect.poll(async () => share(await shot(), blue), { timeout: 20_000 }).toBeGreaterThan(0.3);
  const lit = await log('sun written blue');
  expect(share(lit, red)).toBeLessThan(0.01);

  await stage();
  await expect.poll(async () => (await observe()).counters?.['wall_off'], { timeout: 30_000 }).toBe(1);
  // Switched off: not drawn (the renderer hides it) — most of the blue-lit wall leaves the picture.
  await expect.poll(async () => share(await shot(), blue), { timeout: 20_000 }).toBeLessThan(share(lit, blue) / 2);
  await log('wall switched off');
  expect((await observe()).hidden ?? []).toContain(wallId);

  await stage();
  await expect.poll(async () => (await observe()).counters?.['refused'], { timeout: 30_000 }).toBe(1);
  expect((await observe()).counters?.['read_back']).toBe(1);
  // The refusal is in the play's diagnostics, naming the field.
  const diag = (await api(`play/${psid}/diagnostics`)).json as { diagnostics?: { runtime?: { errors?: { code: string; message: string }[]; entityWrites?: Record<string, number> } } };
  const runtime = diag.diagnostics?.runtime;
  expect(runtime?.entityWrites).toMatchObject({ applied: 2, refused: 1 });
  expect(runtime?.errors?.some((e) => e.code === 'entity_write' && e.message.includes('light.type'))).toBe(true);
  await page.getByTitle('Stop the play preview').click().catch(() => undefined);
});
