/**
 * Freeing an instancing group leaves what shares its mesh drawn, in a real
 * browser against the real backend.
 *
 * Automatic batches and instance sets draw a wrapper geometry that shares the
 * source mesh's vertex buffers. Disposing a wrapper the plain way frees those
 * shared buffers on the GPU: on WebGPU every later submit is refused (the view
 * stops updating for good), on WebGL 2 the other boxes lose their vertices.
 * Here two groups of equal boxes and a single box share the unit box; one
 * group is dissolved and formed again, and every colour must stay on screen
 * with no WebGPU validation error.
 */
import { createHash } from 'node:crypto';

import { expect, test, type Page } from '@playwright/test';

import { startBackend, type E2EBackend } from './backend';
import { decodePng, type Image } from './png';
import { editorUrlFor, expectRendererBackend, onlyInItsProject, RENDERER_VARIANTS } from './renderer-variants';

let be: E2EBackend;
test.afterEach(async () => {
  await be?.stop();
});

async function query(op: string, args: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  return be.command({ op, projectId: be.projectId, args });
}

async function cmd(op: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const res = await be.command({
    op,
    projectId: be.projectId,
    expectedRevision: Number((await query('queryProject'))['revision']),
    requestId: `req-${createHash('sha256').update(`${op}${Math.random()}`).digest('hex').slice(0, 32)}`,
    origin: { kind: 'mcp', clientId: 'e2e-batch-dispose' },
    args,
  });
  expect(res['ok'], JSON.stringify(res)).toBe(true);
  return res;
}

type Hue = 'red' | 'green' | 'blue';
const COLORS: Record<Hue, string> = { red: '#d03030', green: '#30d030', blue: '#3030d0' };

/** Pixels whose channel `hue` clearly dominates the other two (shading keeps the hue). */
function hueCount(img: Image, hue: Hue): number {
  const k = hue === 'red' ? 0 : hue === 'green' ? 1 : 2;
  let n = 0;
  for (let y = 0; y < img.height; y += 2) {
    for (let x = 0; x < img.width; x += 2) {
      const p = img.pixel(x, y);
      const v = p[k]!;
      const others = [0, 1, 2].filter((i) => i !== k).map((i) => p[i]!);
      if (v > 60 && others.every((o) => v > o * 1.8)) n += 1;
    }
  }
  return n;
}

async function hues(page: Page): Promise<Record<Hue, number>> {
  const img = decodePng(await page.locator('canvas.tl-viewport').screenshot());
  return { red: hueCount(img, 'red'), green: hueCount(img, 'green'), blue: hueCount(img, 'blue') };
}

for (const variant of RENDERER_VARIANTS) {
  test(`dissolving an instancing group keeps the meshes it shared drawn (${variant})`, async ({ page }) => {
    onlyInItsProject(variant);
    test.setTimeout(180_000);
    be = await startBackend(`batch-dispose-${variant}`);
    // Two groups of four equal boxes (one material each) and one single box, all on the unit box mesh.
    const blue: string[] = [];
    for (let i = 0; i < 4; i++) {
      blue.push(String((await cmd('createEntity', { kind: 'box', name: `Blue ${i}`, transform: { position: [i * 1.4 - 2.1, 0.5, 1] }, box: { size: [1, 1, 1], material: { color: COLORS.blue } } }))['createdId']));
      await cmd('createEntity', { kind: 'box', name: `Red ${i}`, transform: { position: [i * 1.4 - 2.1, 0.5, -1] }, box: { size: [1, 1, 1], material: { color: COLORS.red } } });
    }
    await cmd('createEntity', { kind: 'box', name: 'Green', transform: { position: [0, 2, 0] }, box: { size: [1, 1, 1], material: { color: COLORS.green } } });

    const validation: string[] = [];
    page.on('console', (m) => {
      const t = m.text();
      if (/GPUValidationError|while destroyed/.test(t)) validation.push(t.slice(0, 200));
    });
    await page.goto(editorUrlFor(be.editorUrl, variant));
    const view = page.locator('canvas.tl-viewport');
    await expectRendererBackend(view, variant);
    const frames = async (): Promise<number> => Number((await view.getAttribute('data-frames')) ?? 0);
    const batches = async (): Promise<string> => (await view.getAttribute('data-batches')) ?? '';
    await expect.poll(batches, { timeout: 30_000 }).toMatch(/^[1-9]/);
    const grouped = await batches();
    const seen = async (): Promise<string> => {
      const h = await hues(page);
      return (Object.keys(h) as Hue[]).filter((k) => h[k] > 30).sort().join(',');
    };
    await expect.poll(seen, { timeout: 30_000, message: 'every colour drawn before the group changes' }).toBe('blue,green,red');

    // The view draws on demand: each change is followed by at least one frame drawn after it.
    for (let i = 0; i < 3; i++) {
      let f = await frames();
      await cmd('updateEntity', { entityId: blue[0]!, active: false });
      await expect.poll(batches).not.toBe(grouped);
      await expect.poll(frames).toBeGreaterThan(f);
      await expect.poll(seen, { message: 'the red group, the single box and the three blue boxes left stay drawn' }).toBe('blue,green,red');
      f = await frames();
      await cmd('updateEntity', { entityId: blue[0]!, active: true });
      await expect.poll(batches).toBe(grouped);
      await expect.poll(frames).toBeGreaterThan(f);
      await expect.poll(seen, { message: 'every colour drawn after the group forms again' }).toBe('blue,green,red');
    }
    expect(validation, 'no WebGPU validation errors').toEqual([]);
  });
}
