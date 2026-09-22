/**
 * The M1 authoring loop in a real browser against the real backend:
 * open, create, undo/redo, gizmo drag, reload, restart, MCP-origin edits.
 */
import { expect, test, type Page } from '@playwright/test';
import * as THREE from 'three';

import { startBackend, type E2EBackend } from './backend';

let be: E2EBackend;

test.beforeEach(async () => {
  be = await startBackend();
});
test.afterEach(async () => {
  await be.stop();
});

const rows = (page: Page) => page.locator('.tl-hierarchy__list li:not(.tl-row--empty)');
/** A new project: the camera plus the starter sun and ambient lights. */
const BASE = 3;
const status = (page: Page) => page.locator('.tl-statusbar');

async function openEditor(page: Page): Promise<void> {
  await page.goto(be.editorUrl);
  await expect(status(page)).toContainText('connected');
}

/** The viewport's default camera, to find where a world point is on screen. */
async function screenPoint(page: Page, world: [number, number, number]): Promise<{ x: number; y: number }> {
  const box = (await page.locator('canvas.tl-viewport').boundingBox())!;
  const camera = new THREE.PerspectiveCamera(50, box.width / box.height, 0.1, 1000);
  camera.position.set(6, 5, 6);
  camera.lookAt(0, 0.5, 0);
  camera.updateMatrixWorld();
  const p = new THREE.Vector3(...world).project(camera);
  return { x: box.x + ((p.x + 1) / 2) * box.width, y: box.y + ((1 - p.y) / 2) * box.height };
}

test('the viewport gets the space at 1920×1080 and an existing scene shows on open', async ({ page }) => {
  await openEditor(page);
  const box = (await page.locator('canvas.tl-viewport').boundingBox())!;
  expect(box.width).toBeGreaterThan(1000);
  expect(box.height).toBeGreaterThan(700);
  // The default scene's camera is listed without any edit first.
  await expect(rows(page)).toHaveCount(BASE);
  await expect(rows(page).first()).toContainText('camera');
});

test('create, multi-level undo/redo, and the buttons follow the backend history', async ({ page }) => {
  await openEditor(page);
  const undo = page.getByTitle('Undo');
  const redo = page.getByTitle('Redo');
  await expect(undo).toBeDisabled();

  await page.getByText('+ box').click();
  await expect(rows(page)).toHaveCount(BASE + 1);
  await page.getByText('+ box').click();
  await expect(rows(page)).toHaveCount(BASE + 2);
  await expect(undo).toBeEnabled();
  await expect(redo).toBeDisabled();

  await undo.click();
  await expect(rows(page)).toHaveCount(BASE + 1);
  await expect(undo).toBeEnabled();
  await undo.click();
  await expect(rows(page)).toHaveCount(BASE);
  await expect(undo).toBeDisabled();
  await expect(redo).toBeEnabled();

  await redo.click();
  await expect(rows(page)).toHaveCount(BASE + 1);
});

test('a gizmo drag commits one setTransform that survives a reload', async ({ page }) => {
  await openEditor(page);
  await page.getByText('+ box').click();
  await expect(rows(page)).toHaveCount(BASE + 1);
  await rows(page).filter({ hasText: 'box' }).click();

  const commands: string[] = [];
  page.on('request', (r) => {
    if (r.method() === 'POST' && r.url().endsWith('/commands')) {
      const op = (r.postDataJSON() as { op?: string }).op;
      if (op !== undefined && !op.startsWith('query')) commands.push(op);
    }
  });

  // Grab the X arrow of the translate gizmo (the box sits at the origin).
  const start = await screenPoint(page, [0.35, 0, 0]);
  const end = await screenPoint(page, [2.35, 0, 0]);
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  for (let i = 1; i <= 10; i++) {
    await page.mouse.move(start.x + ((end.x - start.x) * i) / 10, start.y + ((end.y - start.y) * i) / 10);
  }
  expect(commands).toEqual([]); // nothing is sent during the drag
  await page.mouse.up();

  await expect.poll(() => commands).toEqual(['setTransform']);
  const x = page.locator('.tl-vec').first().locator('.tl-vec__num').first();
  await expect.poll(async () => Number(await x.textContent())).toBeGreaterThan(1);
  const committedX = Number(await x.textContent());

  // Reload: same tab re-attaches (no session conflict) and the edit persisted.
  await page.reload();
  await expect(status(page)).toContainText('connected');
  await rows(page).filter({ hasText: 'box' }).click();
  await expect.poll(async () => Number(await page.locator('.tl-vec').first().locator('.tl-vec__num').first().textContent())).toBe(committedX);
});

test('a graceful backend restart needs no operator action; the editor reconnects', async ({ page }) => {
  await openEditor(page);
  await page.getByText('+ box').click();
  await expect(rows(page)).toHaveCount(BASE + 1);

  await be.restart();
  await expect(status(page)).toContainText('connected', { timeout: 15_000 });
  await page.getByText('+ box').click();
  await expect(rows(page)).toHaveCount(BASE + 2);
});

test('a second tab takes over after the first is closed', async ({ browser }) => {
  const first = await browser.newPage();
  await first.goto(be.editorUrl);
  await expect(status(first)).toContainText('connected');
  await first.close();

  const second = await browser.newPage();
  await second.goto(be.editorUrl);
  await expect(status(second)).toContainText('connected');
  await second.getByText('+ box').click();
  await expect(rows(second)).toHaveCount(BASE + 1);
  await second.close();
});

test('an MCP-origin edit appears in the browser without a reload', async ({ page }) => {
  await openEditor(page);
  const q = await be.command({ op: 'queryProject', projectId: be.projectId, args: {} });
  const res = await be.command({
    op: 'createEntity',
    projectId: be.projectId,
    expectedRevision: q.revision,
    requestId: `req-${'a'.repeat(32)}`,
    origin: { kind: 'mcp', clientId: 'e2e' },
    args: { kind: 'box', parentId: null, name: 'from-mcp' },
  });
  expect(res.ok).toBe(true);
  await expect(rows(page).filter({ hasText: 'from-mcp' })).toHaveCount(1);
  await expect(page.getByTitle('Undo')).toBeEnabled();
});

test('without a stored token the editor asks for one', async ({ page }) => {
  await page.goto(`${be.origin}/?project=${be.projectId}`);
  await expect(page.getByLabel('Access token')).toBeVisible();
  await page.getByLabel('Access token').fill('wrong-token');
  await page.getByRole('button', { name: 'Open' }).click();
  await expect(page.getByText('rejected the access token')).toBeVisible();

  await page.getByLabel('Access token').fill(be.token);
  await page.getByRole('button', { name: 'Open' }).click();
  await expect(status(page)).toContainText('connected');
});
