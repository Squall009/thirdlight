/**
 * Viewport placeholders: cameras, lights, spawns and empty entities are icon
 * billboards that render on screen and are pickable by a click. Every object
 * type shows its own icon on its hierarchy row (one priority order decides,
 * a tooltip names the type) and the Scene view billboard draws the same art.
 */
import { randomUUID } from 'node:crypto';

import * as THREE from 'three';
import { expect, test, type Page } from './pw';

import { startBackend, type E2EBackend } from './backend';
import { colorCount, decodePng } from './png';
import { menu } from './ui';
import { ICON_FILES } from '../../packages/editor/src/viewport/icons';

let be: E2EBackend;
test.beforeEach(async () => {
  be = await startBackend('icons-0001');
});
test.afterEach(async () => {
  await be.stop();
});

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

async function cmd(op: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const q = await be.command({ op: 'queryProject', projectId: be.projectId, args: {} });
  const r = await be.command({ op, projectId: be.projectId, expectedRevision: Number(q['revision']), requestId: `req-${randomUUID().replace(/-/g, '')}`, origin: { kind: 'mcp', clientId: 'e2e-icons' }, args });
  expect(r['ok'], JSON.stringify(r).slice(0, 400)).toBe(true);
  return r;
}

test('lights, spawns and empties show as icons that can be clicked to select; every object type shows its own icon', async ({ page }) => {
  await page.goto(be.editorUrl);
  await expect(page.locator('.tl-statusbar')).toContainText('connected');
  // Put a spawn and an empty at known spots (the menu creates at the focus point; move them by the inspector).
  await menu(page, 'GameObject', 'Spawn point');
  const rows = page.locator('.tl-hierarchy__list li.tl-row');
  await expect(rows.filter({ hasText: 'Spawn point' })).toHaveCount(1);
  await page.getByLabel('position x').fill('2');
  await page.getByLabel('position x').press('Enter');
  await page.getByLabel('position y').fill('0.5');
  await page.getByLabel('position y').press('Enter');
  await page.getByLabel('position z').fill('0');
  await page.getByLabel('position z').press('Enter');
  await page.keyboard.press('Escape'); // clear the selection
  await expect(page.locator('.tl-hierarchy__list li.tl-row.is-selected')).toHaveCount(0);

  // The icon is drawn there: the pixels around the point are not the background.
  const at = await screenPoint(page, [2, 0.5, 0]);
  await expect.poll(async () => colorCount(decodePng(await page.screenshot({ clip: { x: at.x - 16, y: at.y - 16, width: 32, height: 32 } }))), { timeout: 10_000 }).toBeGreaterThan(3);

  // Clicking the icon selects the spawn.
  await page.mouse.click(at.x, at.y);
  await expect(page.locator('.tl-hierarchy__list li.tl-row.is-selected')).toContainText('Spawn point');

  // Lights are icons too: the ambient light of the starter scene is pickable at its position.
  const q = await be.command({ op: 'queryEntities', projectId: be.projectId, args: { limit: 64, offset: 0 } });
  const ambient = (q.entities as Array<{ id: string; name: string; components: { transform: { position: number[] }; light?: { type: string } } }>).find((e) => e.components.light?.type === 'ambient');
  expect(ambient).toBeDefined();
  const pos = ambient!.components.transform.position as [number, number, number];
  const lp = await screenPoint(page, pos);
  await page.mouse.click(lp.x, lp.y);
  await expect(page.locator('.tl-hierarchy__list li.tl-row.is-selected')).toContainText(ambient!.name);

  // Every icon's artwork is served and decodes.
  const broken = await page.evaluate(async (files) => {
    const bad: string[] = [];
    for (const [kind, src] of Object.entries(files)) {
      const img = new Image();
      img.src = src;
      await img.decode().catch(() => undefined);
      if (img.naturalWidth === 0) bad.push(kind);
    }
    return bad;
  }, ICON_FILES as Record<string, string>);
  expect(broken).toEqual([]);

  // One object per type; each row shows its type's icon and names the type in its tooltip.
  await cmd('setMaterial', { material: { materialId: 'mark', name: 'Mark', shader: 'decal', params: {}, textures: {} } });
  const line = [{ at: [0, 0, 0] }, { at: [4, 0, 0] }, { at: [8, 0, 2] }];
  const objects: { name: string; components: Record<string, unknown>; kind?: string; icon: string; title: string; at?: number[] }[] = [
    { name: 'Ground', components: { terrain: { tileSamples: 33, spacing: 1, heightRange: [-8, 8], tiles: [{ x: 0, z: 0 }, { x: 1, z: 0 }] } }, icon: 'terrain', title: 'Terrain · 2 tiles' },
    { name: 'Blocks', components: { blockLayer: { cellSize: [1, 1, 1], bounds: { min: [0, 0, 0], max: [8, 4, 8] } } }, icon: 'blocks', title: 'Block layer' },
    { name: 'Walls', components: { architecture: { profiles: { wall: { points: [[0.1, 0], [0.1, 3], [-0.1, 3], [-0.1, 0]], slots: ['a', 'b', 'c'] } }, elements: [{ id: 'wall', kind: 'sweep', path: { points: [[0, 0, 0], [6, 0, 0]] }, profile: 'wall' }] } }, icon: 'building', title: 'Architecture' },
    { name: 'Path', components: { spline: { points: line } }, icon: 'spline', title: 'Spline · 3 points' },
    { name: 'Lane', components: { spline: { points: line, mesh: { tiling: 8 } } }, icon: 'road', title: 'Road · 3 points' },
    { name: 'Stream', components: { spline: { points: line, mesh: { kind: 'water' } } }, icon: 'river', title: 'River · 3 points' },
    { name: 'Sticker', components: { decal: { size: [1, 1, 0.5], material: 'mark' } }, icon: 'decal', title: 'Decal', at: [0, 2.5, -2] },
    { name: 'Probes', components: { probeVolume: { size: [4, 2, 4] } }, icon: 'probes', title: 'Probe volume' },
    { name: 'Lamp', components: { light: { type: 'spot', color: '#ffffff', intensity: 30, direction: [0, -1, 0], angle: 30 } }, icon: 'spot', title: 'Spot light' },
    { name: 'Sky dome', components: { light: { type: 'hemisphere', color: '#ffffff', intensity: 1, groundColor: '#444444' } }, icon: 'hemisphere', title: 'Hemisphere light' },
    // A box that moves shows what it does, not what it is made of; a plain box shows a box.
    { name: 'Lift', kind: 'box', components: { mover: { waypoints: [[0, 2, 0]], speed: 1, mode: 'pingpong' } }, icon: 'mover', title: 'Mover' },
    { name: 'Crate', kind: 'box', components: {}, icon: 'box', title: 'Box' },
    { name: 'Nothing', components: {}, icon: 'empty', title: 'Empty object' },
  ];
  for (const o of objects) {
    await cmd('createEntity', { sceneId: 'scene-main', parentId: null, kind: o.kind ?? 'group', name: o.name, transform: { position: o.at ?? [20, 0, 20] }, ...(o.kind === 'box' ? { box: { size: [1, 1, 1] } } : {}), components: o.components });
  }
  for (const o of objects) {
    const icon = page.locator('.tl-hierarchy__list li.tl-row').filter({ has: page.locator('.tl-row__name', { hasText: new RegExp(`^${o.name}$`) }) }).locator('img.tl-row__icon');
    await expect(icon, o.name).toHaveAttribute('data-icon', o.icon);
    await expect(icon, o.name).toHaveAttribute('title', o.title);
    await expect(icon, o.name).toHaveAttribute('src', ICON_FILES[o.icon as keyof typeof ICON_FILES]);
    expect(await icon.evaluate((i) => (i as HTMLImageElement).naturalWidth), o.name).toBeGreaterThan(0);
  }

  // The Scene view billboard draws the same art: the decal's pink sticker shows where the decal is.
  const pink = (png: Buffer): number => {
    const img = decodePng(png);
    let n = 0;
    for (let y = 0; y < img.height; y++) for (let x = 0; x < img.width; x++) {
      const [r, g, b] = img.pixel(x, y);
      if (r > 190 && g < 110 && b > 80 && b < 200) n++;
    }
    return n;
  };
  const sticker = await screenPoint(page, [0, 2.5, -2]);
  await expect.poll(async () => pink(await page.screenshot({ clip: { x: sticker.x - 24, y: sticker.y - 24, width: 48, height: 48 } })), { timeout: 10_000 }).toBeGreaterThan(20);
});
