/**
 * Phase 25.22: a widget's size and a radial bar's start angle read the view
 * model, against a real backend and a real browser, on the starter project.
 *
 * Editor: in a UI document made from the Assets panel, a panel's size width
 * takes a view-model path typed into the size field and a radial bar's start
 * angle is bound through its bind box; the stored document holds the
 * bindings, and the preview (the game host's own layer) sizes the panel from
 * the mock values.
 *
 * Play: a HUD document made by commands (a panel whose width is bound, a
 * radial gauge whose start angle is bound, a Grow button) and a script that
 * writes both values and flips them when the button is clicked. Checked: the
 * panel's rectangle in `ui.elements` (the relay observation) triples in
 * width after a real click on the button; the gauge's filled quarter moves
 * from the top-right to the bottom-left quadrant (pixels of the gauge).
 */
import { createHash, randomBytes } from 'node:crypto';

import { expect, test, type Locator } from '@playwright/test';

import { STARTER, type E2EBackend, startBackend } from './backend';
import { decodePng } from './png';

let be: E2EBackend;
test.beforeEach(async () => {
  be = await startBackend('ui-bindable-size-e2e', 'starter');
});
test.afterEach(async () => {
  await be.stop();
});

const query = (op: string, args: Record<string, unknown> = {}): Promise<Record<string, unknown>> => be.command({ op, projectId: be.projectId, args });
async function cmd(op: string, args: Record<string, unknown>): Promise<void> {
  const res = await be.command({ op, projectId: be.projectId, expectedRevision: Number((await query('queryProject')).revision), requestId: `req-${randomBytes(16).toString('hex')}`, origin: { kind: 'mcp', clientId: 'e2e-ui-size' }, args });
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
async function commit(l: Locator, v: string): Promise<void> {
  await l.click();
  await l.fill(v);
  await l.press('Enter');
}

interface W {
  id?: string;
  type: string;
  children?: W[];
  size?: unknown[];
  startAngle?: unknown;
}
async function storedWidget(docId: string, id: string): Promise<W | undefined> {
  const docs = (await query('queryGameConfig'))['uiDocuments'] as { uiDocumentId: string; root: W }[];
  const find = (w: W): W | undefined => (w.id === id ? w : (w.children ?? []).map(find).find((x) => x !== undefined));
  const d = docs.find((x) => x.uiDocumentId === docId);
  return d === undefined ? undefined : find(d.root);
}

const SCRIPT = [
  'export default {',
  '  instantiate() { return { shown: false, big: false }; },',
  '  step(s: any, ctx: any) {',
  "    if (ctx.phase !== 'intent') return;",
  '    const ui = ctx.ui;',
  "    if (!s.shown) s.shown = ui.show('gauges');",
  "    for (const e of ui.events()) if (e.kind === 'click' && e.name === 'grow') s.big = !s.big;",
  "    ui.set('hud.w', s.big ? 240 : 80);",
  "    ui.set('hud.a', s.big ? 180 : 0);",
  '  },',
  '};',
  '',
].join('\n');

async function publishScript(): Promise<void> {
  const behaviorId = 'behavior-ui-size-probe';
  const bytes = Buffer.from(`${JSON.stringify({ graphVersion: 1, entryPath: 'src/index.ts', requiredModules: ['@thirdlight/runtime'], ownedTransforms: [], files: [{ path: 'src/index.ts', text: SCRIPT }] }, null, 2)}\n`);
  const stage = await api('content/stages', {});
  const stageId = String(stage.json.stageId);
  const put = await fetch(`${be.origin}/api/v1/projects/${be.projectId}/content/stages/${stageId}/bytes`, {
    method: 'PUT',
    headers: { authorization: `Bearer ${be.token}`, origin: be.origin, 'content-type': 'application/octet-stream', 'x-thirdlight-offset': '0', 'x-thirdlight-total': String(bytes.length) },
    body: bytes,
  });
  expect(put.status).toBe(200);
  const declaration = { properties: [] };
  await cmd('publishBehavior', { behaviorId, displayName: 'UI size probe', mode: 'declaration-create', declaration });
  await cmd('acknowledgeBehaviorTrust', { sourceDigest: createHash('sha256').update(bytes).digest('hex') });
  const published = await api('content/behaviors/source', { stageId, behaviorId, displayName: 'UI size probe', declaration, expectedRevision: Number((await query('queryProject')).revision), requestId: `req-${randomBytes(16).toString('hex')}` });
  expect(published.status, JSON.stringify(published.json)).toBe(200);
  await cmd('setBehaviorProperties', { entityId: STARTER.playerId, behaviorId, values: {} });
}

/** The share of a gauge quadrant's sample pixels that are the red fill. */
async function redShare(l: Locator): Promise<{ topRight: number; bottomLeft: number }> {
  const png = decodePng(await l.screenshot());
  const share = (x0: number, y0: number): number => {
    let red = 0;
    let n = 0;
    for (let y = y0 + 0.06; y < y0 + 0.46; y += 0.04) {
      for (let x = x0 + 0.06; x < x0 + 0.46; x += 0.04) {
        // Only inside the gauge's circle.
        if (Math.hypot(x - 0.5, y - 0.5) > 0.44) continue;
        const p = png.pixel(Math.floor(x * png.width), Math.floor(y * png.height));
        if (p[0] > 180 && p[1] < 80 && p[2] < 80) red += 1;
        n += 1;
      }
    }
    return red / n;
  };
  return { topRight: share(0.5, 0), bottomLeft: share(0, 0.5) };
}

test('a bound size and start angle: set in the UI editor, and following the view model in Play', async ({ page }) => {
  test.setTimeout(240_000);
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(be.editorUrl);
  await expect(page.locator('.tl-statusbar')).toContainText('connected');

  // ---- editor: a panel's width and a radial bar's start angle bound ----
  await page.getByRole('tab', { name: 'Assets', exact: true }).click();
  await page.getByRole('button', { name: 'new UI document', exact: true }).click();
  const DOC_ID = 'ui-document-1';
  const editor = page.locator(`[data-ui-document="${DOC_ID}"]`);
  await expect(editor).toBeVisible();
  const host = editor.locator('.tl-uidoc__host');
  const addWidget = async (type: string): Promise<void> => {
    await page.getByLabel('new widget type').selectOption(type);
    await page.getByRole('button', { name: 'add widget', exact: true }).click();
  };
  await addWidget('panel');
  await expect.poll(async () => (await storedWidget(DOC_ID, 'panel'))?.type).toBe('panel');
  await commit(editor.getByLabel('widget size w'), '40');
  await commit(editor.getByLabel('widget size h'), '30');
  await expect.poll(async () => (await storedWidget(DOC_ID, 'panel'))?.size).toEqual([40, 30]);
  await commit(editor.getByLabel('widget size w'), 'hud.w');
  await expect.poll(async () => (await storedWidget(DOC_ID, 'panel'))?.size).toEqual([{ bind: 'hud.w' }, 30]);
  await expect(editor.getByLabel('widget size w')).toHaveValue('hud.w');
  // The preview sizes it from the mock values (its scale to the preview box is the same both times).
  await editor.getByRole('tab', { name: 'Mock values' }).click();
  const previewPanel = host.locator('[data-widget="panel"]');
  await editor.getByLabel('mock values').fill('{ "hud": { "w": 60 } }');
  await expect.poll(async () => (await previewPanel.boundingBox())?.width ?? 0).toBeGreaterThan(0);
  const narrow = (await previewPanel.boundingBox())!;
  await editor.getByLabel('mock values').fill('{ "hud": { "w": 180 } }');
  await expect.poll(async () => ((await previewPanel.boundingBox())?.width ?? 0) / narrow.width).toBeCloseTo(3, 1);
  expect((await previewPanel.boundingBox())!.height).toBeCloseTo(narrow.height, 0);
  await editor.getByRole('tab', { name: 'Widget' }).click();

  await page.locator('.tl-uidoc__node[data-path="r"]').click();
  await addWidget('bar');
  await expect.poll(async () => (await storedWidget(DOC_ID, 'bar'))?.type).toBe('bar');
  await editor.getByLabel('widget startAngle bound').click();
  await commit(editor.getByLabel('widget startAngle path'), 'hud.angle');
  await expect.poll(async () => (await storedWidget(DOC_ID, 'bar'))?.startAngle).toEqual({ bind: 'hud.angle' });

  // ---- Play: a HUD whose panel width and gauge start angle follow a script ----
  await publishScript();
  await cmd('setUiDocument', { document: {
    uiDocumentId: 'gauges', name: 'Gauges',
    root: { type: 'panel', stretch: 'both', children: [
      { id: 'box', type: 'panel', anchor: [0, 0], offset: [16, 16], size: [{ bind: 'hud.w' }, 24], css: { background: '#ff00ff' } },
      { id: 'ring', type: 'bar', shape: 'radial', anchor: [0.5, 0], pivot: [0.5, 0], offset: [0, 16], size: [120, 120], value: 0.25, startAngle: { bind: 'hud.a' }, fillColor: '#ff0000', css: { background: '#0000ff' } },
      { id: 'grow', type: 'button', anchor: [1, 0], pivot: [1, 0], offset: [-16, 16], size: [120, 40], text: 'Grow', css: { background: '#304050', color: '#ffffff' }, onClick: { do: 'event', name: 'grow' } },
    ] },
  } });
  const started = page.waitForResponse((r) => r.request().method() === 'POST' && r.url().endsWith('/play'));
  await page.getByTitle('Start an isolated play preview').click();
  const psid = String(((await (await started).json()) as { playSessionId: string }).playSessionId);
  type El = { doc: string; widget: string; rect: [number, number, number, number] };
  type Obs = { state: string; ui?: { elements?: El[] } };
  const observe = async (): Promise<Obs | null> => {
    const r = await api(`play/${psid}/observe`, {});
    return r.status === 200 ? (r.json as unknown as Obs) : null;
  };
  const rect = async (id: string): Promise<[number, number, number, number] | null> => (await observe())?.ui?.elements?.find((e) => e.doc === 'gauges' && e.widget === id)?.rect ?? null;
  await expect.poll(async () => (await observe())?.state ?? null, { timeout: 60_000 }).toBe('running');
  await expect.poll(async () => (await rect('box'))?.[2] ?? 0, { timeout: 15_000 }).toBeGreaterThan(0);
  const small = (await rect('box'))!;
  const frame = page.locator('iframe.tl-app__preview-frame').contentFrame();
  const ring = frame.locator('[data-tl-ui-doc="gauges"] [data-widget="ring"]');
  await expect.poll(async () => (await redShare(ring)).topRight, { timeout: 10_000 }).toBeGreaterThan(0.8);
  expect((await redShare(ring)).bottomLeft).toBeLessThan(0.05);
  await ring.screenshot({ path: 'test-results/ui-bindable-size-ring-0.png' });

  // A real click on Grow: the script flips the bound values.
  await frame.locator('[data-tl-ui-doc="gauges"] [data-widget="grow"]').click();
  await expect.poll(async () => ((await rect('box'))?.[2] ?? 0) / small[2], { timeout: 10_000 }).toBeCloseTo(3, 1);
  const big = (await rect('box'))!;
  expect(big[3]).toBeCloseTo(small[3], 3);
  expect(big[0]).toBeCloseTo(small[0], 3);
  await expect.poll(async () => (await redShare(ring)).bottomLeft, { timeout: 10_000 }).toBeGreaterThan(0.8);
  expect((await redShare(ring)).topRight).toBeLessThan(0.05);
  await ring.screenshot({ path: 'test-results/ui-bindable-size-ring-180.png' });
  expect(errors).toEqual([]);
});
