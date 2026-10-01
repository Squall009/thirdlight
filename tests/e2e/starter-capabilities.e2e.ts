/**
 * Acceptance of the scripting and scene-lighting capabilities together: a new
 * project made from the Starter template in the project picker is built into
 * one scene through the editor, then played in a real browser against a real
 * backend.
 *
 * Built in the editor:
 * - the scene's own lights: the Key light and Ambient fill turned down in the
 *   Inspector; a spot light from GameObject → Light, placed and aimed in the
 *   Inspector, with a striped texture (imported in the Assets tab) as its
 *   cookie, shining on a white wall (GameObject → Box);
 * - a library "Shared" (Libraries tab) whose module keeps one count;
 * - two scripts declared in the Behaviors tab and written and published in
 *   their Script tabs, both importing the library: "Keeper" (an object
 *   property picked in the Inspector names the spot light) reads the light
 *   through `ctx.entity(…).get('light')` and writes its colour through
 *   `set('light', …)` on the signal "paint", then sends a message;
 *   "Watcher" has only an `onMessage` callback;
 * - a moving platform (GameObject → Gameplay) held until the signal "go"
 *   toggles it, with the character and its spawn on it.
 *
 * Played: the cookie's stripes show in the spot's patch; the in-game
 * console's `signal paint` turns the stripes green (the light written by the
 * script, in pixels), both scripts count on the library's one count (1 and
 * 2: bundled copies would give 1 and 1) and the callback fires once;
 * `signal go` lifts the platform with the character on it and a second
 * `signal go` holds it where it is.
 */
import { writeFileSync } from 'node:fs';

import { expect, test, type FrameLocator, type Locator, type Page } from '@playwright/test';

import { STARTER, startBackend, type E2EBackend } from './backend';
import { decodePng, type Image } from './png';
import { makePng } from './png-make';
import { menu, openWindow, projectWindow, closeEditor, editorPane, createItem } from './ui';

const PROJECT = 'starter-capabilities';

let be: E2EBackend;
test.beforeEach(async () => {
  // The backend starts with an unrelated empty project; the one under test is made in the picker.
  be = await startBackend('picker-seed');
});
test.afterEach(async () => {
  await be.stop();
});

async function api(path: string, body: unknown = {}): Promise<{ status: number; json: Record<string, unknown> }> {
  const r = await fetch(`${be.origin}/api/v1/projects/${PROJECT}/${path}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${be.token}`, 'content-type': 'application/json', origin: be.origin },
    body: JSON.stringify(body),
  });
  return { status: r.status, json: (await r.json()) as Record<string, unknown> };
}
async function query(op: string, args: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  return (await api('commands', { op, projectId: PROJECT, args })).json;
}
async function comp(id: string, name: string): Promise<Record<string, unknown> | undefined> {
  const r = await query('queryEntity', { entityId: id });
  return (r['entity'] as { components: Record<string, Record<string, unknown>> }).components[name];
}

const LIBRARY = [
  'let calls = 0;',
  '',
  '/** The next number of one count every importer shares. */',
  'export function next(): number {',
  '  calls += 1;',
  '  return calls;',
  '}',
  '',
].join('\n');

const KEEPER = [
  "import type { BehaviorContext } from '@thirdlight/runtime';",
  "import { next } from '@lib/shared';",
  '',
  'export default {',
  '  step(_state: unknown, ctx: BehaviorContext) {',
  "    if (ctx.phase !== 'intent' || ctx.signals?.on('paint') !== true) return;",
  "    const ref = ctx.properties['lamp'];",
  "    const lamp = ctx.entity?.(typeof ref === 'string' ? ref : null) ?? null;",
  '    if (lamp === null) return;',
  "    if (lamp.get('light')?.['color'] === '#ffffff') ctx.game?.add('read_white', 1);",
  "    if (lamp.set('light', { color: '#00ff00' }).ok) ctx.game?.add('wrote_green', 1);",
  "    ctx.game?.add('keeper', next());",
  "    ctx.messages?.send('painted', 1);",
  '  },',
  '};',
  '',
].join('\n');

const WATCHER = [
  "import type { BehaviorContext, BehaviorMessage } from '@thirdlight/runtime';",
  "import { next } from '@lib/shared';",
  '',
  'export default {',
  '  onMessage(_state: unknown, message: BehaviorMessage, ctx: BehaviorContext) {',
  "    if (message.name !== 'painted') return;",
  "    ctx.game?.add('callback', 1);",
  "    ctx.game?.add('watcher', next());",
  '  },',
  '};',
  '',
].join('\n');

const bright = (r: number, g: number, b: number): boolean => r + g + b > 240;
const green = (r: number, g: number, b: number): boolean => g > 60 && g > 1.8 * r && g > 1.8 * b;

/** Separate runs of pixels passing `test` along row y (runs shorter than `minRun` ignored). */
function runs(img: Image, y: number, test: (r: number, g: number, b: number) => boolean, minRun = 2): number {
  let n = 0;
  let len = 0;
  for (let x = 0; x <= img.width; x += 1) {
    const on = x < img.width && test(...(img.pixel(x, y).slice(0, 3) as [number, number, number]));
    if (on) len += 1;
    else {
      if (len >= minRun) n += 1;
      len = 0;
    }
  }
  return n;
}
/** The most runs any row in the upper part of the view shows (the spot's patch on the wall is there). */
function stripes(img: Image, test: (r: number, g: number, b: number) => boolean): number {
  let best = 0;
  for (let y = Math.floor(img.height * 0.02); y < Math.floor(img.height * 0.45); y += 1) best = Math.max(best, runs(img, y, test));
  return best;
}

function inspector(page: Page): Locator {
  return page.locator('.tl-inspector');
}
async function field(page: Page, label: string, value: string): Promise<void> {
  const f = inspector(page).getByLabel(label, { exact: true });
  await f.fill(value);
  await f.press('Enter');
  await expect(f).toHaveValue(value);
}
async function rename(page: Page, name: string): Promise<void> {
  const f = page.locator('.tl-inspector__name');
  await f.fill(name);
  await f.press('Enter');
  await expect(page.locator('.tl-hierarchy__list li.tl-row.is-selected')).toContainText(name);
}
async function select(page: Page, id: string): Promise<void> {
  await closeEditor(page).catch(() => undefined);
  await page.locator(`.tl-hierarchy__list li[data-entity-id="${id}"]`).click();
  await expect(page.locator('.tl-hierarchy__list li.is-selected')).toHaveAttribute('data-entity-id', id);
}
/** Run a menu action that creates an object and return the new object's id (the selection moves to it). */
async function created(page: Page, create: () => Promise<void>): Promise<string> {
  const row = page.locator('.tl-hierarchy__list li.tl-row.is-selected');
  const before = (await row.count()) > 0 ? await row.getAttribute('data-entity-id') : null;
  await create();
  await expect.poll(async () => ((await row.count()) === 1 ? await row.getAttribute('data-entity-id') : before)).not.toBe(before);
  return (await row.getAttribute('data-entity-id'))!;
}
async function place(page: Page, position: [number, number, number]): Promise<void> {
  for (const [i, axis] of (['x', 'y', 'z'] as const).entries()) await field(page, `position ${axis}`, String(position[i]));
}
/** Replace the open file's text in a code editor tab. */
async function replaceCode(page: Page, view: Locator, text: string): Promise<void> {
  await view.locator('.cm-content').click();
  await page.keyboard.press('ControlOrMeta+a');
  await page.keyboard.insertText(text);
}
async function attach(page: Page, entityId: string, displayName: string): Promise<void> {
  await select(page, entityId);
  await inspector(page).getByLabel('add component', { exact: true }).selectOption({ label: 'Script' });
  await inspector(page).getByLabel('behavior behaviorId', { exact: true }).selectOption({ label: displayName });
  await inspector(page).getByRole('button', { name: 'Add', exact: true }).click();
  await expect.poll(async () => (await comp(entityId, 'behavior'))?.['behaviorId']).toBe(displayName.toLowerCase());
}

/** Declare a script in the Behaviors tab (one Object property, or none), then write and publish it in its Script tab. */
async function script(page: Page, behaviorId: string, displayName: string, objectProperty: string | null, source: string): Promise<void> {
  await openWindow(page, 'Behaviors');
  const panel = page.locator('.tl-behaviors:not(.tl-behaviors--document)');
  await panel.getByRole('button', { name: '+ New behavior' }).click();
  const decl = panel.getByLabel('declaration editor');
  await decl.getByLabel('behavior id', { exact: true }).fill(behaviorId);
  await decl.getByLabel('display name', { exact: true }).fill(displayName);
  if (objectProperty !== null) {
    await decl.getByLabel('property 1 key', { exact: true }).fill(objectProperty);
    await decl.getByLabel('property 1 type', { exact: true }).selectOption('entityRef');
  } else {
    await decl.getByLabel('property 1 remove', { exact: true }).click();
  }
  await decl.getByRole('button', { name: 'Create behavior' }).click();
  const declared = async (): Promise<unknown> => (((await query('queryBehaviors', { includeDeclaration: true, behaviorId }))['behaviors'] as { declaration?: { properties: { key: string; type: string }[] } }[] | undefined)?.[0]?.declaration?.properties ?? null);
  await expect.poll(declared).toMatchObject(objectProperty !== null ? [{ key: objectProperty, type: 'entityRef' }] : []);
  const tile = panel.locator('.tl-behaviors__list .tl-tile', { hasText: displayName });
  await expect(tile).toHaveCount(1);
  await tile.dblclick();
  const view = editorPane(page, 'Script', displayName);
  await expect(view.getByLabel('script editor')).toHaveAttribute('data-behavior', behaviorId);
  await replaceCode(page, view, source);
  await expect(view.getByLabel('compile status')).toHaveAttribute('data-status', 'ok', { timeout: 30_000 });
  await view.getByRole('button', { name: 'Publish', exact: true }).click();
  const trust = view.getByRole('group', { name: 'trust acknowledgment' });
  await expect(trust).toBeVisible({ timeout: 20_000 });
  await trust.getByRole('button').click();
  await expect(view.getByLabel('publish result')).toContainText('Published', { timeout: 30_000 });
}

async function consoleCommand(page: Page, frame: FrameLocator, line: string): Promise<void> {
  const root = frame.locator('.tl-console');
  if ((await root.getAttribute('data-open')) !== 'true') {
    await frame.locator('canvas').first().click();
    await page.keyboard.press('Backquote');
    await expect(root).toHaveAttribute('data-open', 'true');
  }
  const input = frame.getByLabel('debug console command');
  await input.fill(line);
  await input.press('Enter');
  const [name, arg] = line.split(' ');
  await expect(root).toContainText(new RegExp(`ran ${name} name="${arg}" at step \\d+`));
}

test('a new Starter project: scene lights with a spot cookie, a script writing a light, a shared library, a callback and a mover toggled by signals', async ({ page }) => {
  test.setTimeout(420_000);
  page.on('pageerror', (e) => console.log(`[page pageerror] ${e.message}`));

  // The project picker: a new project from the Starter template.
  await page.goto(`${be.origin}/#token=${be.token}`);
  await expect(page.getByRole('heading', { name: 'Projects' })).toBeVisible();
  await page.getByLabel('Project id').fill(PROJECT);
  await page.getByLabel('Name').fill('Starter capabilities');
  await page.getByLabel('Template').selectOption('starter');
  await page.getByRole('button', { name: 'Create and open' }).click();
  await expect(page.locator('.tl-statusbar')).toContainText('connected');
  expect(new URL(page.url()).searchParams.get('project')).toBe(PROJECT);

  // The scene's own sun and fill turned down, so the spot's patch stands out.
  for (const id of ['light-0001', 'light-0002']) {
    await select(page, id);
    await field(page, 'light intensity', '0');
  }
  await expect.poll(async () => (await comp('light-0001', 'light'))?.['intensity']).toBe(0);
  await expect.poll(async () => (await comp('light-0002', 'light'))?.['intensity']).toBe(0);

  // A white wall behind everything.
  const wallId = await created(page, () => menu(page, 'GameObject', 'Box'));
  await rename(page, 'Back wall');
  await field(page, 'box size w', '60');
  await field(page, 'box size h', '40');
  await place(page, [4, 3, -3.5]);
  const colour = inspector(page).getByLabel('box material color', { exact: true });
  await colour.focus();
  await colour.evaluate((el: HTMLInputElement) => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(el, '#ffffff');
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await colour.blur();
  await expect.poll(async () => ((await comp(wallId, 'box'))?.['material'] as { color?: string } | undefined)?.color).toBe('#ffffff');

  // The cookie texture, imported in the Assets tab.
  const png = test.info().outputPath('stripes.png');
  writeFileSync(png, makePng(64, 64, (x) => (Math.floor(x / 8) % 2 === 0 ? [255, 255, 255, 255] : [0, 0, 0, 255])));
  await projectWindow(page);
  await page.locator('.tl-assets__file').first().setInputFiles(png);
  const publish = page.getByRole('button', { name: 'publish' });
  await expect(publish).toBeEnabled({ timeout: 30_000 });
  await publish.click();
  const textures = async (): Promise<{ assetId: string; kind: string }[]> => ((await query('queryAssets', { limit: 50, offset: 0 }))['assets'] as { assetId: string; kind: string }[]).filter((a) => a.kind === 'texture');
  await expect.poll(async () => (await textures()).length, { timeout: 20_000 }).toBe(1);
  const cookieId = (await textures())[0]!.assetId;

  // The spot light: above the character's area, pointing at the wall, a hard 22° cone, the cookie.
  await closeEditor(page);
  const spotId = await created(page, () => menu(page, 'GameObject', 'Light', 'Spot light'));
  await place(page, [4, 7.5, 4]);
  await field(page, 'light direction z', '-1');
  await field(page, 'light direction y', '0');
  await field(page, 'light angle', '22');
  await field(page, 'light penumbra', '0');
  await field(page, 'light intensity', '400');
  await inspector(page).getByLabel('light cookie', { exact: true }).selectOption(cookieId);
  await expect.poll(async () => comp(spotId, 'light')).toMatchObject({ type: 'spot', color: '#ffffff', intensity: 400, angle: 22, penumbra: 0, direction: [0, 0, -1], cookie: cookieId });

  // The shared library.
  await createItem(page, 'Script library', 'Shared');
  const lib = editorPane(page, 'Library', 'Shared');
  await expect(lib.getByLabel('library editor')).toHaveAttribute('data-library', 'shared');
  await replaceCode(page, lib, LIBRARY);
  await expect(lib.getByLabel('compile status')).toHaveAttribute('data-status', 'ok', { timeout: 30_000 });
  await lib.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(lib.getByLabel('save result')).toContainText('Saved', { timeout: 30_000 });

  // The two scripts importing it.
  await script(page, 'keeper', 'Keeper', 'lamp', KEEPER);
  await script(page, 'watcher', 'Watcher', null, WATCHER);

  // Keeper on a new empty object, its lamp picked in the Inspector; Watcher on the crate.
  await closeEditor(page);
  const directorId = await created(page, () => menu(page, 'GameObject', 'Create empty'));
  await rename(page, 'Director');
  await attach(page, directorId, 'Keeper');
  await inspector(page).locator('select[data-entity-ref="lamp"]').selectOption(spotId);
  await expect.poll(async () => comp(directorId, 'behavior')).toEqual({ behaviorId: 'keeper', values: { lamp: spotId } });
  await attach(page, 'box-0004', 'Watcher');

  // The platform: held, 2 m up and back at 1 m/s once "go" toggles it; the character and its spawn stand on it.
  const platformId = await created(page, () => menu(page, 'GameObject', 'Gameplay', 'Moving platform'));
  await expect(page.locator('.tl-inspector__name')).toHaveValue('Moving platform');
  await place(page, [0, 1, 0]);
  await field(page, 'mover waypoints 1 x', '0');
  await field(page, 'mover waypoints 1 y', '2');
  await field(page, 'mover speed', '1');
  const moving = inspector(page).getByLabel('mover active', { exact: true });
  await moving.click();
  await expect(moving).not.toBeChecked();
  await field(page, 'mover toggleOn', 'go');
  await expect.poll(async () => comp(platformId, 'mover')).toMatchObject({ waypoints: [[0, 2, 0]], speed: 1, mode: 'pingpong', active: false, toggleOn: 'go' });
  for (const id of [STARTER.playerId, STARTER.spawnId]) {
    await select(page, id);
    await field(page, 'position x', '0');
    await field(page, 'position y', '2.12');
  }

  // Play.
  const started = page.waitForResponse((r) => r.request().method() === 'POST' && r.url().endsWith('/play'));
  await page.getByTitle('Start an isolated play preview').click();
  const psid = String(((await (await started).json()) as { playSessionId: string }).playSessionId);
  type Obs = { state?: string; counters?: Record<string, number>; player?: { x: number; y: number } };
  const observe = async (): Promise<Obs> => {
    const r = await api(`play/${psid}/observe`);
    return r.status === 200 ? (r.json as Obs) : {};
  };
  const shot = async (): Promise<Image> => {
    const r = await api(`play/${psid}/screenshot`, { maxWidth: 512 });
    expect(r.status, JSON.stringify(r.json).slice(0, 200)).toBe(200);
    return decodePng(Buffer.from(String(r.json['dataUrl']).replace(/^data:image\/png;base64,/, ''), 'base64'));
  };
  const frame = page.frameLocator('iframe.tl-app__preview-frame');
  await expect.poll(async () => (await observe()).state, { timeout: 60_000 }).toBe('running');

  // The cookie: the spot's patch on the wall is striped (a plain spot would be one bright run), and white.
  // A loaded host can report the game running before its renderer drew a frame: that screenshot is refused
  // with its reason, and the poll asks again.
  const shotWhenDrawn = async (): Promise<Image | null> => {
    const r = await api(`play/${psid}/screenshot`, { maxWidth: 512 });
    if (r.status === 503 && JSON.stringify(r.json).includes('still initialising')) return null;
    expect(r.status, JSON.stringify(r.json).slice(0, 200)).toBe(200);
    return decodePng(Buffer.from(String(r.json['dataUrl']).replace(/^data:image\/png;base64,/, ''), 'base64'));
  };
  await expect.poll(async () => { const img = await shotWhenDrawn(); return img === null ? -1 : stripes(img, bright); }, { timeout: 30_000 }).toBeGreaterThanOrEqual(3);
  const before = await shot();
  console.log(`start: bright stripes ${stripes(before, bright)}, green stripes ${stripes(before, green)}`);
  expect(stripes(before, green)).toBe(0);
  const start = (await observe()).player!;
  expect(start.y).toBeGreaterThan(2);

  // "paint": Keeper reads the white light and writes it green; its message reaches Watcher's callback; one shared count.
  await consoleCommand(page, frame, 'signal paint');
  await expect.poll(async () => (await observe()).counters ?? {}, { timeout: 30_000 }).toMatchObject({ read_white: 1, wrote_green: 1, keeper: 1, callback: 1, watcher: 2 });
  await expect.poll(async () => stripes(await shot(), green), { timeout: 30_000 }).toBeGreaterThanOrEqual(3);
  console.log(`painted: green stripes ${stripes(await shot(), green)}`);
  // Still held: the platform did not move on another signal.
  expect(Math.abs((await observe()).player!.y - start.y)).toBeLessThan(0.02);

  // "go": the platform lifts the character; a second "go" holds it part-way.
  await consoleCommand(page, frame, 'signal go');
  await expect.poll(async () => (await observe()).player!.y, { timeout: 15_000 }).toBeGreaterThan(start.y + 0.5);
  await consoleCommand(page, frame, 'signal go');
  await page.waitForTimeout(300);
  const held = (await observe()).player!.y;
  expect(held).toBeLessThan(start.y + 2);
  await page.waitForTimeout(1000);
  expect(Math.abs((await observe()).player!.y - held)).toBeLessThan(0.02);

  const diag = (await api(`play/${psid}/diagnostics`)).json as { diagnostics?: { runtime?: { errors?: unknown[]; entityWrites?: Record<string, number> } } };
  expect(diag.diagnostics?.runtime?.errors ?? []).toEqual([]);
  expect(diag.diagnostics?.runtime?.entityWrites).toMatchObject({ applied: 1, refused: 0 });
  expect((await observe()).counters).toMatchObject({ callback: 1, keeper: 1, watcher: 2 });
  await page.screenshot({ path: test.info().outputPath('starter-capabilities.png') });
  await expect(page.locator('.tl-notice')).toHaveCount(0);
  await page.getByTitle('Stop the play preview').click().catch(() => undefined);
});
