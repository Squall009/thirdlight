/**
 * Phase 15.2: Scene-view handles for every descriptor handle kind, in a real
 * browser against a real backend. The engine sample (Beacon Reach) is only
 * the stage: every object a test edits is a neutral one added by command
 * away from the level. For each handle kind a grip of the selected object is
 * dragged; the stored value changes (snapped), in one command, and one undo
 * restores it. Also: polygon corners (drag, add on an edge, Alt+click
 * delete, a concave shape refused), colliders from the model's outline, a
 * spawn's facing, the camera's real frustum, an animator's starting
 * parameter values, and single copies of an instance set (select, delete,
 * move with the gizmo, brush) — each one undo step.
 */
import { expect, test, type Page } from '@playwright/test';

import { startBackend, type E2EBackend } from './backend';

let be: E2EBackend;
test.beforeEach(async () => {
  be = await startBackend('handles-e2e', 'beacon-reach');
});
test.afterEach(async () => {
  await be.stop();
});

let seq = 0;
async function mutate(op: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const q = await be.command({ op: 'queryProject', projectId: be.projectId, args: {} });
  seq += 1;
  const r = await be.command({ op, projectId: be.projectId, expectedRevision: q['revision'], requestId: `req-${(0x15e200 + seq).toString(16).padStart(32, '0')}`, origin: { kind: 'mcp', clientId: 'e2e-handles' }, args });
  expect(r['ok'], JSON.stringify(r)).toBe(true);
  return r;
}
async function create(name: string, position: number[], components: Record<string, unknown>, kind = 'group', extra: Record<string, unknown> = {}): Promise<string> {
  return String((await mutate('createEntity', { parentId: null, kind, name, transform: { position }, components, ...extra }))['createdId']);
}
async function comp(id: string, name: string): Promise<Record<string, unknown> | undefined> {
  const r = await be.command({ op: 'queryEntity', projectId: be.projectId, args: { entityId: id } });
  return (r['entity'] as { components: Record<string, Record<string, unknown>> }).components[name];
}

type Grip = { component: string; kind: string; handle: string; role: string; x: number; y: number };
const view = (page: Page) => page.locator('canvas[data-size-handles]');
async function grips(page: Page): Promise<Grip[]> {
  return JSON.parse((await view(page).getAttribute('data-size-handles')) ?? '[]') as Grip[];
}
async function grip(page: Page, component: string, kind: string, handle: string): Promise<Grip> {
  await expect.poll(async () => (await grips(page)).some((g) => g.component === component && g.kind === kind && g.handle === handle), { message: `${component} ${kind} ${handle}` }).toBe(true);
  await page.waitForTimeout(150);
  return (await grips(page)).find((g) => g.component === component && g.kind === kind && g.handle === handle)!;
}
async function drag(page: Page, from: { x: number; y: number }, dx: number, dy: number): Promise<void> {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  for (let i = 1; i <= 8; i++) await page.mouse.move(from.x + (dx * i) / 8, from.y + (dy * i) / 8);
  await page.mouse.up();
}
async function undo(page: Page): Promise<void> {
  await view(page).hover();
  await page.keyboard.press('Control+z');
}
/**
 * Select an object in the Hierarchy; `focus` also frames it (F keeps the
 * view's distance, so the first focus of a page zooms in once, to about 6 m).
 */
const zoomed = new WeakSet<Page>();
async function select(page: Page, id: string, focus = true): Promise<void> {
  await page.locator(`.tl-hierarchy__list li[data-entity-id="${id}"]`).click();
  await expect(page.locator('.tl-hierarchy__list li.is-selected')).toHaveAttribute('data-entity-id', id);
  if (!focus) return;
  await page.keyboard.press('f');
  if (zoomed.has(page)) return;
  zoomed.add(page);
  const box = (await view(page).boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  for (let i = 0; i < 8; i++) {
    await page.mouse.wheel(0, -250);
    await page.waitForTimeout(30);
  }
}
const snapped = (v: number, step = 0.05): boolean => Math.abs(v / step - Math.round(v / step)) < 1e-6;

async function open(page: Page): Promise<void> {
  await page.goto(be.editorUrl);
  await expect(page.locator('.tl-statusbar')).toContainText('connected');
}

test('sizes, ranges and radii: box3, box2, capsule, radius, segment1d, a chase band, world bounds — drag, stored snapped, one undo', async ({ page }) => {
  test.setTimeout(240_000);
  const crate = await create('Crate', [0, 30, 0], {}, 'box', { box: { size: [1, 1, 1], material: { color: '#777777' } } });
  const sensor = await create('Sensor', [10, 30, 0], { trigger: { size: [1, 1], signal: 'hello' } });
  const ring = await create('Ring', [20, 30, 0], { trigger: { shape: 'circle', radius: 1, signal: 'ring' } });
  const walker = await create('Walker', [30, 30, 0], { enemy: { patrol: 'points', range: [-2, 2], speed: 1.5, size: [0.8, 0.8], contactDamage: 1, stompable: true, health: 1, chase: 3, chaseHeight: 1 } });
  await mutate('setComponent', { entityId: 'br-cam-main', component: 'cameraFollow', value: { bounds: { minX: 37, maxX: 43, minY: 27, maxY: 33 } } });
  const marker = await create('Bounds marker', [40, 30, 0], {});
  await open(page);
  // The enemy's chase distance is drawn.
  await expect(view(page)).toHaveAttribute('data-chase-bands', '1');

  // box3: the crate's side grip → a wider box (5 cm steps); depth has its own grip.
  await select(page, crate);
  await grip(page, 'box', 'box3', 'depth');
  await drag(page, await grip(page, 'box', 'box3', 'side'), 60, 0);
  await expect.poll(async () => ((await comp(crate, 'box'))!['size'] as number[])[0]).toBeGreaterThan(1.1);
  const size = (await comp(crate, 'box'))!['size'] as number[];
  expect(snapped(size[0]!)).toBe(true);
  expect(size.slice(1)).toEqual([1, 1]);
  await undo(page);
  await expect.poll(async () => (await comp(crate, 'box'))!['size']).toEqual([1, 1, 1]);

  // box2: the trigger's top grip → taller, centred.
  await select(page, sensor);
  await drag(page, await grip(page, 'trigger', 'box2', 'top'), 0, -60);
  await expect.poll(async () => ((await comp(sensor, 'trigger'))!['size'] as number[])[1]).toBeGreaterThan(1.1);
  expect(snapped(((await comp(sensor, 'trigger'))!['size'] as number[])[1]!)).toBe(true);
  await undo(page);
  await expect.poll(async () => (await comp(sensor, 'trigger'))!['size']).toEqual([1, 1]);

  // radius: the circle trigger's grip → a larger radius.
  await select(page, ring);
  await drag(page, await grip(page, 'trigger', 'radius', 'side'), 60, 0);
  await expect.poll(async () => (await comp(ring, 'trigger'))!['radius'] as number).toBeGreaterThan(1.05);
  expect(snapped((await comp(ring, 'trigger'))!['radius'] as number)).toBe(true);
  await undo(page);
  await expect.poll(async () => (await comp(ring, 'trigger'))!['radius']).toBe(1);

  // segment1d: the patrol range's right end; radius along X: the chase distance; box2 standing on its feet.
  await select(page, walker);
  await drag(page, await grip(page, 'enemy', 'segment1d', 'right'), 60, 0);
  await expect.poll(async () => ((await comp(walker, 'enemy'))!['range'] as number[])[1]).toBeGreaterThan(2.05);
  expect(((await comp(walker, 'enemy'))!['range'] as number[])[0]).toBe(-2);
  await undo(page);
  await expect.poll(async () => (await comp(walker, 'enemy'))!['range']).toEqual([-2, 2]);
  await drag(page, await grip(page, 'enemy', 'radius', 'side'), -60, 0);
  await expect.poll(async () => (await comp(walker, 'enemy'))!['chase'] as number).toBeLessThan(2.95);
  expect(snapped((await comp(walker, 'enemy'))!['chase'] as number)).toBe(true);
  await undo(page);
  await expect.poll(async () => (await comp(walker, 'enemy'))!['chase']).toBe(3);
  await drag(page, await grip(page, 'enemy', 'box2', 'top'), 0, -40);
  await expect.poll(async () => ((await comp(walker, 'enemy'))!['size'] as number[])[1]).toBeGreaterThan(0.85);
  await undo(page);
  await expect.poll(async () => (await comp(walker, 'enemy'))!['size']).toEqual([0.8, 0.8]);

  // capsule: the player's side grip → a thinner capsule.
  await select(page, 'model-0001');
  const capTop = await grip(page, 'controller', 'capsule', 'top');
  const capSide = await grip(page, 'controller', 'capsule', 'side');
  // Pixels per metre on screen: the top grip is 0.9 m above the side grip.
  const perMetre = (capSide.y - capTop.y) / 0.9;
  await drag(page, capSide, -0.1 * perMetre, 0);
  await expect.poll(async () => ((await comp('model-0001', 'controller'))!['capsule'] as { radius?: number } | undefined)?.radius ?? 0.3).toBeLessThan(0.3);
  await undo(page);
  await expect.poll(async () => JSON.stringify(await comp('model-0001', 'controller'))).toBe('{}');

  // box2 world bounds: the camera follow's right edge (viewed from the marker in the middle of them).
  await select(page, marker);
  await select(page, 'br-cam-main', false);
  for (const h of ['left', 'right', 'bottom', 'top']) await grip(page, 'cameraFollow', 'box2', h);
  await drag(page, await grip(page, 'cameraFollow', 'box2', 'right'), 80, 0);
  await expect.poll(async () => ((await comp('br-cam-main', 'cameraFollow'))!['bounds'] as { maxX: number }).maxX).toBeGreaterThan(43.1);
  const b = (await comp('br-cam-main', 'cameraFollow'))!['bounds'] as { minX: number; maxX: number };
  expect(b.minX).toBe(37);
  expect(snapped(b.maxX, 0.25)).toBe(true);
  await undo(page);
  await expect.poll(async () => (await comp('br-cam-main', 'cameraFollow'))!['bounds']).toEqual({ minX: 37, maxX: 43, minY: 27, maxY: 33 });
});

test('lights: a direction, a spot cone (tip and angle) and a point light range — drag, stored, one undo', async ({ page }) => {
  test.setTimeout(180_000);
  const spot = await create('Spot', [0, 30, 0], { light: { type: 'spot', color: '#ffffff', intensity: 80, range: 4, decay: 2, angle: 30, penumbra: 0.3, direction: [0, -1, 0] } });
  const lamp = await create('Lamp', [12, 30, 0], { light: { type: 'point', color: '#ffd9a0', intensity: 30, range: 2, decay: 2 } });
  await open(page);

  // direction (world): the key light's tip grip.
  const key = (await comp('light-0001', 'light'))!['direction'];
  await select(page, 'light-0001');
  await drag(page, await grip(page, 'light', 'direction', 'tip'), 80, 40);
  await expect.poll(async () => JSON.stringify((await comp('light-0001', 'light'))!['direction'])).not.toBe(JSON.stringify(key));
  for (const c of (await comp('light-0001', 'light'))!['direction'] as number[]) expect(snapped(c)).toBe(true);
  await undo(page);
  await expect.poll(async () => (await comp('light-0001', 'light'))!['direction']).toEqual(key);

  // cone: the spot's tip (direction and range) and its angle grip.
  await select(page, spot);
  await drag(page, await grip(page, 'light', 'cone', 'tip'), 70, 0);
  await expect.poll(async () => JSON.stringify((await comp(spot, 'light'))!['direction'])).not.toBe('[0,-1,0]');
  await undo(page);
  await expect.poll(async () => (await comp(spot, 'light'))!['direction']).toEqual([0, -1, 0]);
  const angle = await grip(page, 'light', 'cone', 'angle');
  const tip = await grip(page, 'light', 'cone', 'tip');
  // Away from the axis: a wider cone (5° steps).
  await drag(page, angle, (angle.x - tip.x) * 1.5, (angle.y - tip.y) * 1.5);
  await expect.poll(async () => (await comp(spot, 'light'))!['angle'] as number).toBeGreaterThan(30);
  expect(((await comp(spot, 'light'))!['angle'] as number) % 5).toBe(0);
  await undo(page);
  await expect.poll(async () => (await comp(spot, 'light'))!['angle']).toBe(30);

  // radius: the point light's range.
  await select(page, lamp);
  await drag(page, await grip(page, 'light', 'radius', 'side'), 60, 0);
  await expect.poll(async () => (await comp(lamp, 'light'))!['range'] as number).toBeGreaterThan(2.05);
  expect(snapped((await comp(lamp, 'light'))!['range'] as number)).toBe(true);
  await undo(page);
  await expect.poll(async () => (await comp(lamp, 'light'))!['range']).toBe(2);
});

test('paths and polygons: drag a point, add one on an edge, Alt+click deletes; a concave polygon is refused; colliders from the model outline', async ({ page }) => {
  test.setTimeout(240_000);
  const lift = await create('Lift', [0, 30, 0], { mover: { waypoints: [[4, 0, 0]], speed: 2, mode: 'pingpong', wait: 0.5 } }, 'box', { box: { size: [1, 0.3, 1], material: { color: '#777777' } } });
  const ramp = await create('Ramp', [20, 30, 0], { collider: { shape: { type: 'polygon', vertices: [[-1, 0], [1, 0], [0, 1.5]] } } });
  await open(page);
  const points = async (): Promise<number[][]> => (await comp(lift, 'mover'))!['waypoints'] as number[][];
  const corners = async (): Promise<number[][]> => ((await comp(ramp, 'collider'))!['shape'] as { vertices: number[][] }).vertices;

  // path: drag the waypoint (grid snapped), add a point on the first segment, Alt+click deletes it; three undos.
  await select(page, lift);
  await drag(page, await grip(page, 'mover', 'path', 'p0'), 0, -60);
  await expect.poll(async () => (await points())[0]![1]!).toBeGreaterThan(0.2);
  expect(snapped((await points())[0]![1]!, 0.25)).toBe(true);
  const afterDrag = await points();
  await drag(page, await grip(page, 'mover', 'path', 'i0'), 0, 40);
  await expect.poll(async () => (await points()).length).toBe(2);
  await page.keyboard.down('Alt');
  const p0 = await grip(page, 'mover', 'path', 'p0');
  await page.mouse.click(p0.x, p0.y);
  await page.keyboard.up('Alt');
  await expect.poll(async () => (await points()).length).toBe(1);
  await undo(page);
  await expect.poll(async () => (await points()).length).toBe(2);
  await undo(page);
  await expect.poll(points).toEqual(afterDrag);
  await undo(page);
  await expect.poll(points).toEqual([[4, 0, 0]]);

  // polygon: drag a corner up, add a corner on an edge, Alt+click it away.
  await select(page, ramp);
  await expect(page.locator('.tl-inspector')).toContainText('Alt+click a corner to delete it');
  await drag(page, await grip(page, 'collider', 'polygon', 'p2'), 0, -40);
  await expect.poll(async () => (await corners())[2]![1]!).toBeGreaterThan(1.55);
  const tall = await corners();
  await drag(page, await grip(page, 'collider', 'polygon', 'i2'), 30, -10);
  await expect.poll(async () => (await corners()).length).toBe(4);
  await page.keyboard.down('Alt');
  const added = await grip(page, 'collider', 'polygon', 'p2');
  await page.mouse.click(added.x, added.y);
  await page.keyboard.up('Alt');
  await expect.poll(corners).toEqual(tall);
  // Dragging the top corner below the base turns the shape inside out: refused, nothing stored.
  const top = await grip(page, 'collider', 'polygon', 'p2');
  const base = await grip(page, 'collider', 'polygon', 'p0');
  await drag(page, top, 0, base.y - top.y + 80);
  await expect(page.locator('.tl-notice')).toContainText('Not stored');
  expect(await corners()).toEqual(tall);
  await undo(page);
  await undo(page);
  await undo(page);
  await expect.poll(corners).toEqual([[-1, 0], [1, 0], [0, 1.5]]);

  // "Add collider → polygon / box from model outline" on a model (the pillar), each one command and one undo.
  await select(page, 'model-0003');
  const add = page.locator('.tl-inspector').getByLabel('add component', { exact: true });
  await expect.poll(async () => (await add.locator('option', { hasText: 'Collider: Polygon from model outline' }).count())).toBe(1);
  await expect.poll(async () => {
    if ((await comp('model-0003', 'collider')) === undefined) await add.selectOption({ label: 'Collider: Polygon from model outline' });
    return ((await comp('model-0003', 'collider'))?.['shape'] as { type?: string } | undefined)?.type;
  }, { timeout: 30_000 }).toBe('polygon');
  const outline = ((await comp('model-0003', 'collider'))!['shape'] as { vertices: number[][] }).vertices;
  expect(outline.length).toBeGreaterThanOrEqual(3);
  expect(outline.length).toBeLessThanOrEqual(8);
  await undo(page);
  await expect.poll(async () => comp('model-0003', 'collider')).toBeUndefined();
  await add.selectOption({ label: 'Collider: Box from model' });
  await expect.poll(async () => ((await comp('model-0003', 'collider'))?.['shape'] as { type?: string } | undefined)?.type).toMatch(/box|polygon/);
  await undo(page);
  await expect.poll(async () => comp('model-0003', 'collider')).toBeUndefined();
});

test('a spawn\'s facing, the camera\'s real frustum, an animator\'s starting parameter values', async ({ page }) => {
  test.setTimeout(180_000);
  await open(page);
  const inspector = page.locator('.tl-inspector');

  // playerSpawn.facing: a select (none/left/right); none removes it.
  await select(page, 'spawn-0002', false);
  await inspector.getByLabel('playerSpawn facing', { exact: true }).selectOption('left');
  await expect.poll(async () => comp('spawn-0002', 'playerSpawn')).toEqual({ facing: 'left' });
  await undo(page);
  await expect.poll(async () => comp('spawn-0002', 'playerSpawn')).toEqual({});
  await expect(inspector.getByLabel('playerSpawn facing', { exact: true })).toHaveValue('none');

  // The camera's frustum follows its fields and the game's aspect.
  const stored = (await comp('br-cam-main', 'camera'))! as { fovY: number; near: number; far: number };
  await select(page, 'br-cam-main', false);
  const frustumNow = async (): Promise<Record<string, number>> => JSON.parse((await view(page).getAttribute('data-camera-frustum')) || '{}') as Record<string, number>;
  await expect.poll(async () => (await frustumNow())['fovY']).toBe(stored.fovY);
  const frustum = await frustumNow();
  expect([frustum['near'], frustum['far']]).toEqual([stored.near, stored.far]);
  expect(frustum['aspect']).toBeGreaterThan(0.5);
  const fov = inspector.getByLabel('camera fovY', { exact: true });
  await fov.fill(String(stored.fovY + 10));
  await fov.press('Enter');
  await expect.poll(async () => (await frustumNow())['fovY']).toBe(stored.fovY + 10);
  await undo(page);
  await expect.poll(async () => (await frustumNow())['fovY']).toBe(stored.fovY);
  // Another selection hides it.
  await select(page, 'spawn-0002', false);
  await expect(view(page)).toHaveAttribute('data-camera-frustum', '');

  // animator.parameters: the player's controller parameters, each with its starting value.
  await select(page, 'model-0001', false);
  const animator = (await comp('model-0001', 'animator')) as { controller: string } | undefined;
  expect(animator, 'the sample player moves to an animator when opened').toBeDefined();
  const speed = inspector.getByLabel('animator parameters speed', { exact: true });
  await expect(speed).toHaveValue('0');
  await speed.fill('2.5');
  await speed.press('Enter');
  await expect.poll(async () => (await comp('model-0001', 'animator'))!['parameters']).toEqual({ speed: 2.5 });
  await undo(page);
  await expect.poll(async () => JSON.stringify((await comp('model-0001', 'animator'))!['parameters'] ?? {})).toBe('{}');
  await expect(inspector.getByLabel('animator parameters speed', { exact: true })).toHaveValue('0');
  const grounded = inspector.getByLabel('animator parameters grounded', { exact: true });
  await grounded.click();
  await expect.poll(async () => JSON.stringify((await comp('model-0001', 'animator'))!['parameters'])).toMatch(/"grounded":(true|false)/);
});

test('instance copies: select one copy, delete it, move it with the gizmo, brush new ones — each one undo step', async ({ page }) => {
  test.setTimeout(240_000);
  // Three pillars 3 m apart behind the level, published through the buffer route MCP uses.
  const transforms = [-3, 0, 3].flatMap((x) => [x, 0, 0, 0, 0, 0, 1, 0.3, 0.3, 0.3]);
  const res = await fetch(`${be.origin}/api/v1/projects/${be.projectId}/content/buffers`, { method: 'POST', headers: { authorization: `Bearer ${be.token}`, 'content-type': 'application/json', origin: be.origin }, body: JSON.stringify({ transforms }) });
  const published = (await res.json()) as { digest: string; count: number };
  const assets = (await be.command({ op: 'queryAssets', projectId: be.projectId, args: { limit: 50, offset: 0 } }))['assets'] as { assetId: string; displayName: string }[];
  const pillar = assets.find((a) => a.displayName === 'Beacon pillar')!.assetId;
  const set = await create('Grove', [0, 0, -10], { instances: { asset: { assetId: pillar }, buffer: published.digest, count: 3 } });
  const copies = async (): Promise<number[][]> => {
    const inst = (await comp(set, 'instances'))! as { buffer: string; count: number };
    const bytes = await fetch(`${be.origin}/api/v1/projects/${be.projectId}/content/buffers/${inst.buffer}`, { headers: { authorization: `Bearer ${be.token}` } });
    const f = new Float32Array(await bytes.arrayBuffer());
    return Array.from({ length: inst.count }, (_, i) => Array.from(f.slice(i * 10, i * 10 + 3)).map((v) => Math.round(v * 1000) / 1000));
  };
  await open(page);
  await select(page, set);
  type Copy = { index: number; x: number; y: number };
  const onScreen = async (): Promise<Copy[]> => JSON.parse((await view(page).getAttribute('data-instance-copies')) ?? '[]') as Copy[];
  await expect.poll(async () => (await onScreen()).length, { timeout: 30_000 }).toBe(3);
  await page.waitForTimeout(300);

  // Click the third copy: it is selected (the Inspector says so).
  const third = (await onScreen())[2]!;
  await page.mouse.click(third.x, third.y);
  await expect(view(page)).toHaveAttribute('data-instance-copy', '2');
  await expect(page.locator('.tl-inspector')).toContainText('Copy 3 selected');
  // Del deletes that copy only; one undo brings it back.
  await view(page).hover();
  await page.keyboard.press('Delete');
  await expect.poll(copies).toEqual([[-3, 0, 0], [0, 0, 0]]);
  await expect(page.locator(`.tl-hierarchy__list li[data-entity-id="${set}"]`)).toHaveCount(1);
  await undo(page);
  await expect.poll(copies).toEqual([[-3, 0, 0], [0, 0, 0], [3, 0, 0]]);

  // Select the first copy and drag the gizmo's X arrow: only that copy moves.
  await expect.poll(async () => (await onScreen()).length).toBe(3);
  await page.waitForTimeout(300);
  const first = (await onScreen())[0]!;
  await page.mouse.click(first.x, first.y);
  await expect(view(page)).toHaveAttribute('data-instance-copy', '0');
  await page.waitForTimeout(200);
  const g = JSON.parse((await view(page).getAttribute('data-gizmo-grab'))!) as { x: number; y: number; ax: number; ay: number };
  await page.mouse.move(g.ax, g.ay);
  await page.waitForTimeout(100);
  await drag(page, { x: g.ax, y: g.ay }, (g.ax - g.x) * 3, (g.ay - g.y) * 3);
  await expect.poll(async () => (await copies())[0]![0]!).toBeGreaterThan(-2.9);
  const moved = await copies();
  expect(moved.slice(1)).toEqual([[0, 0, 0], [3, 0, 0]]);
  await undo(page);
  await expect.poll(copies).toEqual([[-3, 0, 0], [0, 0, 0], [3, 0, 0]]);

  // The brush: a click in the Scene view adds one copy there; one undo removes it.
  await page.locator('.tl-inspector').getByRole('button', { name: 'Whole set' }).click();
  await page.locator('.tl-inspector').getByRole('button', { name: 'Brush: add copies' }).click();
  await expect(view(page)).toHaveAttribute('data-brush', set);
  const box = (await view(page).boundingBox())!;
  await page.mouse.click(box.x + box.width * 0.5, box.y + box.height * 0.8);
  await expect.poll(async () => (await copies()).length).toBe(4);
  await undo(page);
  await expect.poll(async () => (await copies()).length).toBe(3);
});
