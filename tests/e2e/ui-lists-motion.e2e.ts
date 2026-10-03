/**
 * Game UI against a real backend and a real browser, on the starter
 * project: bound lists that keep their items, bound offset / opacity /
 * rotation, the cover and expand scale modes, and the view scripts and
 * bindings read.
 *
 * Play: a script rewrites a list's rows every step (a value changes); the
 * row the keyboard focused keeps its element and the focus, and the next
 * arrow moves on from it (a rebuilt list dropped the focus to the
 * document's first widget). `ctx.ui.focus` with an index focuses a keyed
 * item; reordering the array moves that item's element and the focus with
 * it. A widget's offset, opacity and rotation follow the view model
 * (computed style and its rectangle). A `cover` document's box covers the
 * view and an `expand` document's bottom-right anchor is the view's corner
 * at two window sizes; `ctx.ui.view()` and `$flow.view` report the view.
 *
 * Editor: the widget inspector binds an offset axis, the opacity and the
 * rotation, and sets a list's item key; the stored document holds them.
 */
import { randomUUID } from 'node:crypto';

import { expect, test, type Frame, type Locator } from '@playwright/test';

import { STARTER, type E2EBackend, publishScript, startBackend } from './backend';
import { createItem } from './ui';

let be: E2EBackend;
test.beforeEach(async () => {
  be = await startBackend('ui-lists-motion-e2e', 'starter');
});
test.afterEach(async () => {
  await be.stop();
});

const query = (op: string, args: Record<string, unknown> = {}): Promise<Record<string, unknown>> => be.command({ op, projectId: be.projectId, args });
async function cmd(op: string, args: Record<string, unknown>): Promise<void> {
  const res = await be.command({ op, projectId: be.projectId, expectedRevision: Number((await query('queryProject')).revision), requestId: `req-${randomUUID().replace(/-/g, '')}`, origin: { kind: 'mcp', clientId: 'e2e-ui-lists' }, args });
  expect(res['ok'], JSON.stringify(res).slice(0, 600)).toBe(true);
}
async function api(path: string, body: unknown): Promise<{ status: number; json: Record<string, unknown> }> {
  const r = await fetch(`${be.origin}/api/v1/projects/${be.projectId}/${path}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${be.token}`, 'content-type': 'application/json', origin: be.origin },
    body: JSON.stringify(body),
  });
  return { status: r.status, json: (await r.json()) as Record<string, unknown> };
}

const SCRIPT = [
  'export default {',
  "  instantiate() { return { n: 0, shown: false, order: ['a', 'b', 'c'], reorderAt: -1 }; },",
  '  step(s: any, ctx: any) {',
  "    if (ctx.phase !== 'intent') return;",
  '    const ui = ctx.ui;',
  '    s.n += 1;',
  "    if (s.n === 2) { ui.show('fx'); ui.show('cover'); ui.show('expand'); }",
  // The menu (modal, focused) comes once the test has given the game the keyboard.
  "    if (!s.shown && s.n > 240) s.shown = ui.show('menu');",
  // Every row's value changes every step: the view model replaces the list.
  "    ui.set('menu.rows', [0, 1, 2, 3].map((i) => ({ label: 'Row' + i, value: s.n })));",
  "    ui.set('menu.slots', s.order.map((id: string) => ({ id })));",
  "    ui.set('fx', { x: 30, y: -20, a: 0.25, r: 45 });",
  "    ui.set('view', ui.view());",
  '    for (const e of ui.events()) {',
  "      if (e.kind === 'click' && e.name === 'jump') { ui.focus('menu', 'slot', 2); s.reorderAt = s.n + 30; }",
  '    }',
  "    if (s.n === s.reorderAt) s.order = ['c', 'a', 'b'];",
  '  },',
  '};',
  '',
].join('\n');

const DOCS = [
  {
    uiDocumentId: 'menu', name: 'Menu', modal: true, layer: 10,
    root: { type: 'stack', anchor: [0, 0], pivot: [0, 0], offset: [8, 8], gap: 4, children: [
      { id: 'tab', type: 'button', text: 'Tab', size: [120, 28], css: { background: '#304050', color: '#ffffff' } },
      { id: 'rows', type: 'list', items: { bind: 'menu.rows' }, gap: 2, template: { id: 'row', type: 'button', size: [200, 28], text: '{$item.label} {$item.value}', css: { background: '#203040', color: '#ffffff', focus: { background: '#a04040' } } } },
      { id: 'slots', type: 'list', items: { bind: 'menu.slots' }, itemKey: 'id', direction: 'row', gap: 4, template: { id: 'slot', type: 'button', size: [60, 28], text: '{$item.id}', css: { background: '#204030', color: '#ffffff' } } },
      { id: 'jump', type: 'button', text: 'Jump', size: [120, 28], css: { background: '#405060', color: '#ffffff' }, onClick: { do: 'event', name: 'jump' } },
    ] },
  },
  {
    uiDocumentId: 'fx', name: 'Fx', layer: 5,
    root: { type: 'panel', stretch: 'both', children: [
      { id: 'petal', type: 'panel', anchor: [0.5, 0.5], pivot: [0.5, 0.5], offset: [{ bind: 'fx.x' }, { bind: 'fx.y' }], size: [40, 40], opacity: { bind: 'fx.a' }, rotation: { bind: 'fx.r' }, css: { background: '#ff00ff' } },
      { id: 'size', type: 'text', anchor: [1, 0], pivot: [1, 0], text: '{$flow.view.width}x{$flow.view.height}', css: { color: '#ffffff' } },
    ] },
  },
  { uiDocumentId: 'cover', name: 'Cover', layer: -10, scale: { reference: [400, 200], mode: 'cover' }, root: { type: 'panel', stretch: 'both', children: [{ id: 'bg', type: 'panel', stretch: 'both', css: { background: '#10203040' } }] } },
  { uiDocumentId: 'expand', name: 'Expand', layer: -5, scale: { reference: [400, 200], mode: 'expand' }, root: { type: 'panel', stretch: 'both', children: [{ id: 'corner', type: 'panel', anchor: [1, 1], pivot: [1, 1], size: [20, 20], css: { background: '#00ff00' } }] } },
];

type Rect = { left: number; top: number; width: number; height: number };
const rectOf = (l: Locator): Promise<Rect> => l.evaluate((e) => {
  const r = e.getBoundingClientRect();
  return { left: r.left, top: r.top, width: r.width, height: r.height };
});
const viewOf = (f: Frame): Promise<{ w: number; h: number; dpr: number }> => f.evaluate(() => ({ w: window.innerWidth, h: window.innerHeight, dpr: window.devicePixelRatio }));

test('Play: a list keeps its items and focus through value changes; focus by index follows a keyed item; bound offset, opacity, rotation; cover, expand and the view at two sizes', async ({ page }) => {
  test.setTimeout(240_000);
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.setViewportSize({ width: 1400, height: 900 });
  for (const document of DOCS) await cmd('setUiDocument', { document });
  await publishScript(be, 'behavior-ui-lists', SCRIPT, STARTER.playerId);
  await page.goto(be.editorUrl);
  await expect(page.locator('.tl-statusbar')).toContainText('connected');

  const started = page.waitForResponse((r) => r.request().method() === 'POST' && r.url().endsWith('/play'));
  await page.getByTitle('Start an isolated play preview').click();
  const psid = String(((await (await started).json()) as { playSessionId: string }).playSessionId);
  type Ui = { focus: { doc: string; widget: string; index?: number } | null; values?: { view?: { width: number; height: number; aspect: number; pixelRatio: number } } };
  const observe = async (): Promise<{ state?: string; ui?: Ui }> => (await api(`play/${psid}/observe`, {})).json as never;
  await expect.poll(async () => (await observe()).state ?? null, { timeout: 60_000 }).toBe('running');
  // The game gets the keyboard before the modal menu comes (a press on the view focuses its surface).
  await page.locator('iframe.tl-app__preview-frame').click();
  const frame = page.locator('iframe.tl-app__preview-frame').contentFrame();
  const playFrame = page.frames().find((f) => f !== page.mainFrame() && f.url().includes('/play'))!;
  const menu = frame.locator('[data-tl-ui-doc="menu"]');
  await expect(menu).toHaveCount(1, { timeout: 30_000 });
  const focus = async (): Promise<Ui['focus']> => (await observe()).ui?.focus ?? null;
  await expect.poll(focus).toEqual({ doc: 'menu', widget: 'tab' });

  // ---- a list rewritten every step keeps its items and the focus ----
  await page.keyboard.press('ArrowDown');
  await expect.poll(focus).toEqual({ doc: 'menu', widget: 'row', index: 0 });
  await page.keyboard.press('ArrowDown');
  await expect.poll(focus).toEqual({ doc: 'menu', widget: 'row', index: 1 });
  const row1 = menu.locator('[data-widget="row"][data-index="1"]');
  await row1.evaluate((e) => {
    (e as HTMLElement).dataset['e2eMark'] = 'kept';
  });
  const valueOf = async (): Promise<number> => Number(((await row1.textContent()) ?? '').split(' ')[1]);
  const v0 = await valueOf();
  await expect.poll(valueOf, { timeout: 10_000 }).toBeGreaterThan(v0 + 30);
  // The same element (marked), still focused, after dozens of value changes.
  await expect(menu.locator('[data-e2e-mark="kept"]')).toHaveCount(1);
  await expect(menu.locator('[data-e2e-mark="kept"]')).toHaveClass(/is-focused/);
  expect(await focus()).toEqual({ doc: 'menu', widget: 'row', index: 1 });
  // The next arrow moves on from the kept row (not from the document's first widget).
  await page.keyboard.press('ArrowDown');
  await expect.poll(focus).toEqual({ doc: 'menu', widget: 'row', index: 2 });
  await expect(menu.locator('[data-e2e-mark="kept"]')).not.toHaveClass(/is-focused/);

  // ---- ctx.ui.focus with an index; a keyed item keeps its element and the focus through a reorder ----
  const slotC = menu.locator('[data-widget="slot"]').filter({ hasText: 'c' });
  await slotC.evaluate((e) => {
    (e as HTMLElement).dataset['e2eSlot'] = 'c';
  });
  expect(await slotC.getAttribute('data-index')).toBe('2');
  await menu.locator('[data-widget="jump"]').click();
  await expect.poll(focus, { timeout: 10_000 }).toEqual({ doc: 'menu', widget: 'slot', index: 2 });
  await expect.poll(async () => menu.locator('[data-widget="slot"]').evaluateAll((els) => els.map((e) => e.textContent)), { timeout: 10_000 }).toEqual(['c', 'a', 'b']);
  await expect(menu.locator('[data-e2e-slot="c"]')).toHaveAttribute('data-index', '0');
  await expect(menu.locator('[data-e2e-slot="c"]')).toHaveClass(/is-focused/);
  expect(await focus()).toEqual({ doc: 'menu', widget: 'slot', index: 0 });

  // ---- bound offset, opacity and rotation ----
  const fx = frame.locator('[data-tl-ui-doc="fx"]');
  const petal = fx.locator('[data-widget="petal"]');
  await expect.poll(async () => petal.evaluate((e) => getComputedStyle(e).filter)).toBe('opacity(0.25)');
  expect(await petal.evaluate((e) => getComputedStyle(e).rotate)).toBe('45deg');
  const view1 = await viewOf(playFrame);
  const p = await rectOf(petal);
  // Rotated about its pivot (its centre): the centre stays at the anchor plus the bound offset.
  expect(p.left + p.width / 2).toBeCloseTo(view1.w / 2 + 30, 0);
  expect(p.top + p.height / 2).toBeCloseTo(view1.h / 2 - 20, 0);
  // A 40 px square turned 45°: its box is 40·√2 wide.
  expect(p.width).toBeCloseTo(40 * Math.SQRT2, 0);
  await page.screenshot({ path: 'test-results/ui-lists-motion.png' });

  // ---- cover, expand and the view, at two window sizes ----
  const checkScale = async (): Promise<{ w: number; h: number }> => {
    const v = await viewOf(playFrame);
    await expect.poll(async () => (await observe()).ui?.values?.view ?? null, { timeout: 10_000 }).toEqual({ width: v.w, height: v.h, aspect: v.w / v.h, pixelRatio: v.dpr });
    await expect(fx.locator('[data-widget="size"]')).toHaveText(`${v.w}x${v.h}`);
    const cover = await rectOf(frame.locator('[data-tl-ui-doc="cover"] .tl-ui__root'));
    const s = Math.max(v.w / 400, v.h / 200);
    expect(cover.width).toBeCloseTo(400 * s, 0);
    expect(cover.height).toBeCloseTo(200 * s, 0);
    expect(cover.left + cover.width / 2).toBeCloseTo(v.w / 2, 0);
    expect(cover.top + cover.height / 2).toBeCloseTo(v.h / 2, 0);
    const corner = await rectOf(frame.locator('[data-tl-ui-doc="expand"] [data-widget="corner"]'));
    expect(corner.left + corner.width).toBeCloseTo(v.w, 0);
    expect(corner.top + corner.height).toBeCloseTo(v.h, 0);
    // Expand fits the reference: the corner is 20 reference px at the fitted scale.
    expect(corner.width).toBeCloseTo(20 * Math.min(v.w / 400, v.h / 200), 0);
    return { w: v.w, h: v.h };
  };
  const a = await checkScale();
  await page.setViewportSize({ width: 1000, height: 1000 });
  await expect.poll(async () => (await viewOf(playFrame)).w / (await viewOf(playFrame)).h, { timeout: 10_000 }).not.toBeCloseTo(a.w / a.h, 2);
  const b = await checkScale();
  expect(b.w).not.toBe(a.w);
  expect(errors).toEqual([]);
});

test('editor: an offset axis, the opacity and the rotation bound in the widget inspector; a list item key', async ({ page }) => {
  test.setTimeout(180_000);
  await page.goto(be.editorUrl);
  await expect(page.locator('.tl-statusbar')).toContainText('connected');
  await createItem(page, 'UI document', 'UI document 1');
  const DOC_ID = 'ui-document-1';
  const editor = page.locator(`[data-ui-document="${DOC_ID}"]`);
  await expect(editor).toBeVisible();
  type W = { id?: string; type: string; children?: W[]; offset?: unknown; opacity?: unknown; rotation?: unknown; itemKey?: unknown };
  const stored = async (id: string): Promise<W | undefined> => {
    const docs = (await query('queryGameConfig'))['uiDocuments'] as { uiDocumentId: string; root: W }[];
    const find = (w: W): W | undefined => (w.id === id ? w : (w.children ?? []).map(find).find((x) => x !== undefined));
    const d = docs.find((x) => x.uiDocumentId === DOC_ID);
    return d === undefined ? undefined : find(d.root);
  };
  const commit = async (l: Locator, v: string): Promise<void> => {
    await l.click();
    await l.fill(v);
    await l.press('Enter');
  };
  const addWidget = async (type: string): Promise<void> => {
    await page.getByLabel('new widget type').selectOption(type);
    await page.getByRole('button', { name: 'add widget', exact: true }).click();
  };
  await addWidget('panel');
  await expect.poll(async () => (await stored('panel'))?.type).toBe('panel');
  await commit(editor.getByLabel('widget offset x'), 'hud.drift');
  await commit(editor.getByLabel('widget offset y'), '12');
  await expect.poll(async () => (await stored('panel'))?.offset).toEqual([{ bind: 'hud.drift' }, 12]);
  await editor.getByLabel('widget opacity bound').click();
  await commit(editor.getByLabel('widget opacity path'), 'hud.alpha');
  await expect.poll(async () => (await stored('panel'))?.opacity).toEqual({ bind: 'hud.alpha' });
  await commit(editor.getByLabel('widget rotation', { exact: true }), '30');
  await expect.poll(async () => (await stored('panel'))?.rotation).toBe(30);

  await page.locator('.tl-uidoc__node[data-path="r"]').click();
  await addWidget('list');
  await expect.poll(async () => (await stored('list'))?.type).toBe('list');
  await commit(editor.getByLabel('widget itemKey', { exact: true }), 'id');
  await expect.poll(async () => (await stored('list'))?.itemKey).toBe('id');
});
