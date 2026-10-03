/**
 * The UI document editor against a real backend and a real
 * browser.
 *
 * Neutral content made through the editor itself: a UI theme (UI list →
 * theme tab: a "tint" style with a red background), a UI document created
 * from the Assets panel, the theme picked in the Document inspector, then in
 * the hierarchy a stack (the tinted style, a fixed size) holding a text, a
 * bar bound to a view-model path shown through the mock values, and a
 * button raising an event.
 *
 * Checked: every widget lands in the stored document (queryGameConfig, what
 * MCP reads); the preview is the game host's own layer (bound bar at the
 * mock value); dragging moves a widget and a grip resizes it, each gesture
 * exactly one command (revision +1); an anchor preset pins it bottom right
 * without moving it on screen; duplicate / move into / delete in the
 * hierarchy; changing the theme's colour recolours the preview (pixels);
 * undo and redo bring the colour back and forth; the game shell's pause
 * screen shows the document in Play with the same text, button
 * and theme colour.
 */
import { createHash } from 'node:crypto';

import { expect, test, type Locator, type Page } from '@playwright/test';

import { type E2EBackend, startBackend } from './backend';
import { decodePng } from './png';
import { menu, createItem, openProjectSettings } from './ui';

let be: E2EBackend;
test.beforeEach(async () => {
  be = await startBackend('ui-editor-e2e', 'starter');
});
test.afterEach(async () => {
  await be.stop();
});

const query = (op: string, args: Record<string, unknown> = {}): Promise<Record<string, unknown>> => be.command({ op, projectId: be.projectId, args });
const revision = async (): Promise<number> => Number((await query('queryProject')).revision);
async function cmd(op: string, args: Record<string, unknown>): Promise<void> {
  const res = await be.command({
    op,
    projectId: be.projectId,
    expectedRevision: await revision(),
    requestId: `req-${createHash('sha256').update(`${op}${Math.random()}`).digest('hex').slice(0, 32)}`,
    origin: { kind: 'mcp', clientId: 'e2e-ui-editor' },
    args,
  });
  expect(res['ok'], JSON.stringify(res).slice(0, 600)).toBe(true);
}

interface W {
  id?: string;
  type: string;
  children?: W[];
  offset?: number[];
  size?: (number | null)[];
  anchor?: number[];
  pivot?: number[];
  style?: string | string[];
  value?: unknown;
  text?: string;
  onClick?: unknown;
}
const DOC_ID = 'ui-document-1';
async function storedDoc(): Promise<{ theme?: string; root: W } | undefined> {
  const docs = (await query('queryGameConfig'))['uiDocuments'] as { uiDocumentId: string; theme?: string; root: W }[];
  return docs.find((d) => d.uiDocumentId === DOC_ID);
}
const find = (w: W, id: string): W | undefined => (w.id === id ? w : (w.children ?? []).map((c) => find(c, id)).find((x) => x !== undefined));
async function widget(id: string): Promise<W | undefined> {
  const d = await storedDoc();
  return d === undefined ? undefined : find(d.root, id);
}

/** Commit a text field (Enter blurs it). */
async function commit(l: Locator, v: string): Promise<void> {
  await l.click();
  await l.fill(v);
  await l.press('Enter');
}

/** The mean colour of the inner part of a preview widget (away from its edges and the text in its top left). */
async function innerColour(page: Page, el: Locator): Promise<[number, number, number]> {
  // A page clip of the widget's box (the preview rebuilds its elements after an edit, so an element screenshot can lose it).
  const png = decodePng(await page.screenshot({ clip: await box(el) }));
  let r = 0;
  let g = 0;
  let b = 0;
  let n = 0;
  for (let y = Math.floor(png.height * 0.6); y < Math.floor(png.height * 0.85); y += 2) {
    for (let x = Math.floor(png.width * 0.6); x < Math.floor(png.width * 0.85); x += 2) {
      const p = png.pixel(x, y);
      r += p[0];
      g += p[1];
      b += p[2];
      n += 1;
    }
  }
  return [r / n, g / n, b / n];
}

/** A locator's box once it is laid out (the preview rebuilds its elements after an edit). */
async function box(l: Locator): Promise<{ x: number; y: number; width: number; height: number }> {
  let b: { x: number; y: number; width: number; height: number } | null = null;
  await expect.poll(async () => {
    b = await l.boundingBox().catch(() => null);
    return b !== null;
  }).toBe(true);
  return b!;
}

async function selectRow(page: Page, path: string): Promise<void> {
  await page.locator(`.tl-uidoc__node[data-path="${path}"]`).click();
  await expect(page.locator(`.tl-uidoc__node[data-path="${path}"]`)).toHaveAttribute('aria-selected', 'true');
}
async function addWidget(page: Page, type: string): Promise<void> {
  await page.getByLabel('new widget type').selectOption(type);
  await page.getByRole('button', { name: 'add widget', exact: true }).click();
}

test('UI document editor: build a HUD, drag, anchor, theme colour, undo/redo, then Play shows it', async ({ page }) => {
  test.setTimeout(240_000);
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(be.editorUrl);
  await expect(page.locator('.tl-statusbar')).toContainText('connected');

  // A theme from the project window's Create menu: its editor opens; a "tint" style with a red background.
  await createItem(page, 'UI theme', 'Neutral');
  const themeEditor = page.locator('[data-ui-theme="neutral"]');
  await expect(themeEditor).toBeVisible();
  await themeEditor.getByLabel('theme new style name').fill('tint');
  await themeEditor.getByRole('button', { name: '+ Style', exact: true }).click();
  await expect(themeEditor.getByLabel('theme style', { exact: true })).toHaveValue('tint');
  const bgRed = themeEditor.getByLabel('theme tint background', { exact: true });
  await bgRed.fill('#ff0000');
  await bgRed.blur();
  await expect.poll(async () => ((await query('queryGameConfig'))['uiThemes'] as { styles: Record<string, { background?: string }> }[])[0]?.styles['tint']?.background).toBe('#ff0000');

  // A UI document from the project window's Create menu: its editor opens.
  await createItem(page, 'UI document', 'UI document 1');
  const editor = page.locator(`[data-ui-document="${DOC_ID}"]`);
  await expect(editor).toBeVisible();
  await expect.poll(async () => (await storedDoc())?.root.type).toBe('panel');
  const host = editor.locator('.tl-uidoc__host');
  // The preview is the game host's layer, drawing this document.
  await expect(host.locator(`[data-tl-ui-doc="${DOC_ID}"]`)).toHaveCount(1);

  // Document → theme.
  await editor.getByRole('tab', { name: 'Document' }).click();
  await editor.getByLabel('document theme', { exact: true }).selectOption('neutral');
  await expect.poll(async () => (await storedDoc())?.theme).toBe('neutral');
  await editor.getByRole('tab', { name: 'Widget' }).click();

  // A stack (tinted, 300×120 at 80,80) with a text.
  await addWidget(page, 'stack');
  await expect.poll(async () => (await widget('stack'))?.type).toBe('stack');
  await expect(page.locator('.tl-uidoc__node[data-path="r.0"]')).toHaveAttribute('aria-selected', 'true');
  await editor.getByLabel('widget style tint').click();
  await expect.poll(async () => (await widget('stack'))?.style).toBe('tint');
  await commit(editor.getByLabel('widget size w'), '300');
  await expect.poll(async () => (await widget('stack'))?.size).toEqual([300, null]);
  await commit(editor.getByLabel('widget size h'), '120');
  await commit(editor.getByLabel('widget offset x'), '80');
  await commit(editor.getByLabel('widget offset y'), '80');
  await expect.poll(async () => ({ size: (await widget('stack'))?.size, offset: (await widget('stack'))?.offset })).toEqual({ size: [300, 120], offset: [80, 80] });
  await addWidget(page, 'text');
  await expect.poll(async () => (await storedDoc())?.root.children?.[0]?.children?.[0]?.type).toBe('text');
  await commit(editor.getByLabel('widget text', { exact: true }), 'Hello UI');
  await expect.poll(async () => (await widget('text'))?.text).toBe('Hello UI');
  await expect(host.locator('[data-widget="text"]')).toHaveText('Hello UI');

  // A bar bound to hud.hp, shown at the mock value.
  await selectRow(page, 'r');
  await addWidget(page, 'bar');
  await expect.poll(async () => (await widget('bar'))?.type).toBe('bar');
  await commit(editor.getByLabel('widget offset x'), '80');
  await commit(editor.getByLabel('widget offset y'), '260');
  await expect.poll(async () => (await widget('bar'))?.offset).toEqual([80, 260]);
  await editor.getByLabel('widget value bound').click();
  await commit(editor.getByLabel('widget value path'), 'hud.hp');
  await expect.poll(async () => (await widget('bar'))?.value).toEqual({ bind: 'hud.hp' });
  await editor.getByRole('tab', { name: 'Mock values' }).click();
  await editor.getByLabel('mock values').fill('{ "hud": { "hp": 0.25 } }');
  await expect(host.locator('[data-widget="bar"]')).toHaveAttribute('data-value', '0.25');
  await editor.getByRole('button', { name: 'Fill from bindings', exact: true }).click();
  await expect(editor.getByLabel('mock values')).toHaveValue(/"hp": 0.25/);
  await editor.getByRole('tab', { name: 'Widget' }).click();

  // A button raising an event.
  await selectRow(page, 'r');
  await addWidget(page, 'button');
  await expect.poll(async () => (await widget('button'))?.type).toBe('button');
  await editor.getByRole('button', { name: 'add widget on click', exact: true }).click();
  await expect.poll(async () => (await widget('button'))?.onClick).toEqual({ do: 'event', name: 'click' });
  await commit(editor.getByLabel('widget offset x'), '500');
  await commit(editor.getByLabel('widget offset y'), '80');
  await expect.poll(async () => (await widget('button'))?.offset).toEqual([500, 80]);
  await commit(editor.getByLabel('widget size w'), '240');
  await commit(editor.getByLabel('widget size h'), '80');
  await expect.poll(async () => (await widget('button'))?.size).toEqual([240, 80]);

  // Move by drag: one command for the gesture.
  const btn = host.locator('[data-widget="button"]');
  await expect(btn).toBeVisible();
  const before = (await box(btn));
  const rev0 = await revision();
  // Grab it away from the resize grips (corners and edge middles).
  const cx = before.x + before.width * 0.3;
  const cy = before.y + before.height * 0.5;
  await page.mouse.move(cx, cy);
  await page.mouse.down();
  for (let i = 1; i <= 8; i++) await page.mouse.move(cx + i * 12, cy + i * 6);
  await page.mouse.up();
  await expect.poll(async () => (await widget('button'))?.offset?.[0] ?? 0).toBeGreaterThan(600);
  expect(await revision()).toBe(rev0 + 1);
  const moved = (await widget('button'))!.offset!;
  expect(moved[1]).toBeGreaterThan(100);
  await expect.poll(async () => ((await box(btn)).x - before.x)).toBeGreaterThan(60);

  // Resize by the south-east grip: one command, a size now.
  const rev1 = await revision();
  const grip = editor.locator('[data-grip="se"]');
  const g = (await box(grip));
  await page.mouse.move(g.x + g.width / 2, g.y + g.height / 2);
  await page.mouse.down();
  for (let i = 1; i <= 6; i++) await page.mouse.move(g.x + g.width / 2 + i * 8, g.y + g.height / 2 + i * 4);
  await page.mouse.up();
  await expect.poll(async () => (await widget('button'))?.size?.[0] ?? 0).toBeGreaterThan(260);
  expect((await widget('button'))!.size![1]).toBeGreaterThan(90);
  expect(await revision()).toBe(rev1 + 1);
  expect((await widget('button'))!.offset).toEqual(moved); // top-left stays (pivot 0,0)

  // Anchor preset: bottom right, kept where it is on screen.
  const placed = (await box(btn));
  await editor.getByRole('button', { name: 'anchor bottom right', exact: true }).click();
  await expect.poll(async () => (await widget('button'))?.anchor).toEqual([1, 1]);
  expect((await widget('button'))!.pivot).toEqual([1, 1]);
  await expect(editor.getByRole('button', { name: 'anchor bottom right', exact: true })).toHaveAttribute('aria-pressed', 'true');
  const pinned = (await box(btn));
  expect(Math.abs(pinned.x - placed.x)).toBeLessThan(2);
  expect(Math.abs(pinned.y - placed.y)).toBeLessThan(2);
  // Switching the preview to 4:3 keeps it at the bottom-right corner (the anchor).
  await editor.getByLabel('preview resolution').selectOption('4:3');
  await expect(editor.locator('.tl-uidoc__screen')).toHaveAttribute('data-preview-size', '1024x768');
  await editor.getByLabel('show safe area').click();
  await expect(editor.getByLabel('safe area', { exact: true })).toBeVisible();
  await editor.getByLabel('preview resolution').selectOption('16:9');

  // Hierarchy: duplicate the text, move the copy to the root, delete it.
  await selectRow(page, 'r.0.0');
  await editor.getByRole('button', { name: 'duplicate widget', exact: true }).click();
  await expect.poll(async () => (await widget('text2'))?.text).toBe('Hello UI');
  await expect(page.locator('.tl-uidoc__node[data-path="r.0.1"]')).toHaveAttribute('aria-selected', 'true');
  await editor.getByLabel('move into container').selectOption('r');
  await editor.getByRole('button', { name: 'move widget into', exact: true }).click();
  await expect.poll(async () => (await storedDoc())?.root.children?.map((c) => c.id)).toEqual(['stack', 'bar', 'button', 'text2']);
  await expect(page.locator('.tl-uidoc__node[data-path="r.3"]')).toHaveAttribute('aria-selected', 'true');
  await editor.getByRole('button', { name: 'delete widget', exact: true }).click();
  await expect.poll(async () => (await widget('text2'))).toBeUndefined();

  // The theme colour: red in the preview, then blue from the Theme tab beside it.
  await selectRow(page, 'r');
  const stack = host.locator('[data-widget="stack"]');
  await expect.poll(async () => (await innerColour(page, stack))[0]).toBeGreaterThan(200);
  expect((await innerColour(page, stack))[2]).toBeLessThan(60);
  await editor.getByRole('tab', { name: 'Theme' }).click();
  await editor.getByLabel('theme style', { exact: true }).selectOption('tint');
  const bg = editor.getByLabel('theme tint background', { exact: true });
  await bg.fill('#0000ff');
  await bg.blur();
  await expect.poll(async () => (await innerColour(page, stack))[2], { timeout: 10_000 }).toBeGreaterThan(200);
  expect((await innerColour(page, stack))[0]).toBeLessThan(60);
  await page.screenshot({ path: 'test-results/ui-editor.png' });

  // Undo brings red back, redo blue again.
  await menu(page, 'Edit', 'Undo');
  await expect.poll(async () => (await innerColour(page, stack))[0], { timeout: 10_000 }).toBeGreaterThan(200);
  await menu(page, 'Edit', 'Redo');
  await expect.poll(async () => (await innerColour(page, stack))[2], { timeout: 10_000 }).toBeGreaterThan(200);

  // The game shell: its pause screen becomes this document (the Game shell tab's screen picker).
  await openProjectSettings(page, 'Game shell');
  const shellPanel = page.getByLabel('game shell', { exact: true });
  const shell = async (): Promise<{ screens?: Record<string, string> } | null> => ((await query('queryGameConfig'))['shell'] as { screens?: Record<string, string> } | undefined) ?? null;
  await shellPanel.getByRole('button', { name: 'add game shell' }).click();
  await expect.poll(shell).toEqual({});
  await shellPanel.getByLabel('add shell screens', { exact: true }).click();
  await shellPanel.getByLabel('shell screens pause', { exact: true }).selectOption(DOC_ID);
  await expect.poll(async () => (await shell())?.screens?.['pause']).toBe(DOC_ID);

  // Play: Escape shows the document (same text, button, theme colour) instead of the built-in pause panel.
  const started = page.waitForResponse((r) => r.request().method() === 'POST' && r.url().endsWith('/play'));
  await page.getByTitle('Start an isolated play preview').click();
  const psid = String(((await (await started).json()) as { playSessionId: string }).playSessionId);
  const observe = async (): Promise<{ state?: string; shell?: { screen: string } }> => {
    const r = await fetch(`${be.origin}/api/v1/projects/${be.projectId}/play/${psid}/observe`, { method: 'POST', headers: { authorization: `Bearer ${be.token}`, 'content-type': 'application/json' }, body: '{}' });
    return (await r.json()) as never;
  };
  const frame = page.frameLocator('iframe.tl-app__preview-frame');
  await expect.poll(async () => (await observe()).shell?.screen, { timeout: 30_000 }).toBe('playing');
  await page.locator('iframe.tl-app__preview-frame').click();
  await page.keyboard.press('Escape');
  await expect.poll(async () => (await observe()).shell?.screen).toBe('pause');
  expect((await observe()).state).toBe('paused');
  const shown = frame.locator(`[data-tl-ui-doc="${DOC_ID}"][data-tl-ui-source="screen"]`);
  await expect(shown).toHaveCount(1);
  await expect(shown.locator('[data-widget="text"]')).toHaveText('Hello UI');
  await expect(shown.locator('[data-widget="button"]')).toHaveText('Button');
  await expect.poll(async () => shown.locator('[data-widget="stack"]').evaluate((el) => getComputedStyle(el).backgroundColor)).toBe('rgb(0, 0, 255)');
  const size = await shown.locator('[data-widget="stack"]').evaluate((el) => [(el as HTMLElement).offsetWidth, (el as HTMLElement).offsetHeight]);
  expect(size).toEqual([300, 120]);
  await page.screenshot({ path: 'test-results/ui-editor-play.png' });
  expect(errors).toEqual([]);
});

test("a button's engine action reloads the scene it names or the active one; the deprecated run restarts are marked", async ({ page }) => {
  test.setTimeout(120_000);
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await cmd('createScene', { sceneId: 'level-two', name: 'Level two' });
  await page.goto(be.editorUrl);
  await expect(page.locator('.tl-statusbar')).toContainText('connected');
  await createItem(page, 'UI document', 'UI document 1');
  const editor = page.locator(`[data-ui-document="${DOC_ID}"]`);
  await expect.poll(async () => (await storedDoc())?.root.type).toBe('panel');
  await addWidget(page, 'button');
  await expect.poll(async () => (await widget('button'))?.type).toBe('button');
  const onClick = async (): Promise<unknown> => (await widget('button'))?.onClick;
  await editor.getByLabel('widget on click new action').selectOption('engine');
  await editor.getByRole('button', { name: 'add widget on click', exact: true }).click();
  await expect.poll(onClick).toEqual({ do: 'engine', action: 'resume' });
  // The deprecated run restarts are still listed (a document using one keeps it), marked with what replaces them.
  const action = editor.getByLabel('widget on click 1 engine action');
  await expect(action.locator('option[value="restartLevel"]')).toHaveText('restartLevel (deprecated)');
  await expect(action.locator('option[value="newGame"]')).toHaveAttribute('title', /^Deprecated: use a new game the game builds in a script/);
  await expect(action.locator('option[value="reloadScene"]')).toHaveText('reloadScene');
  // reloadScene: the active scene unless a scene is named.
  await action.selectOption('reloadScene');
  await expect.poll(onClick).toEqual({ do: 'engine', action: 'reloadScene' });
  const scene = editor.getByLabel('widget on click 1 scene');
  await expect(scene).toHaveValue('');
  await expect(scene.locator('option[value="level-two"]')).toHaveText('Level two');
  await scene.selectOption('level-two');
  await expect.poll(onClick).toEqual({ do: 'engine', action: 'reloadScene', scene: 'level-two' });
  await scene.selectOption('');
  await expect.poll(onClick).toEqual({ do: 'engine', action: 'reloadScene' });
  // quitToTitle is deprecated too; loadScene always names its scene (the first one until another is picked).
  await expect(action.locator('option[value="quitToTitle"]')).toHaveText('quitToTitle (deprecated)');
  await action.selectOption('loadScene');
  await expect.poll(async () => ((await onClick()) as { action?: string; scene?: string } | undefined)?.scene ?? '').not.toBe('');
  await expect(scene.locator('option[value=""]')).toHaveCount(0);
  await scene.selectOption('level-two');
  await expect.poll(onClick).toEqual({ do: 'engine', action: 'loadScene', scene: 'level-two' });
  expect(errors).toEqual([]);
});
