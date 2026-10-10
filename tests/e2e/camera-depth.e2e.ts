/**
 * View distance and depth — a virtual camera's own far plane, the project's
 * depth precision (`depth_buffer`), and mesh decals lying on surfaces in
 * every depth mode, against a real backend on both renderer backends.
 *
 * The scene, seen by a fixed virtual camera 0.3 m over a near floor, looking
 * down it toward a lower far floor (its own far plane 20 km, the scene
 * camera's 100 m would clip the vista):
 * - three mesh decals on the near floor, 2.2 m out at a grazing angle, each a
 *   flat box exactly in the floor's top face (no lift: only the decal's push
 *   keeps it on top): a red textured `blend` decal (its image on the decal
 *   pages in Play and the export, its own texture in the Scene view), a green
 *   `multiply` stain and a magenta `add` glow;
 * - one blue `blend` decal 80 m out on the far floor, seen at 2°;
 * - a green "vista" slab 5 km out.
 *
 * In Play, once per depth mode (standard, reversed Z — standard where the
 * backend lacks it — and logarithmic): the red and the blue decal cover
 * their whole area (no z-fighting: no floor showing through), the stain
 * darkens and greens the floor under it, the glow brightens it; with the
 * logarithmic buffer the vista draws too. The export (backend stopped) shows
 * the same. The Scene view (opened on the near floor alone, which it frames)
 * draws the red decal whole, in the red Play draws it.
 */
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';

import { expect, test, type Locator, type Page } from './pw';

import { publishBytes, startBackend, type E2EBackend } from './backend';
import { serveDir } from './frame-reading';
import { decodePng, type Image } from './png';
import { makePng } from './png-make';
import { editorUrlFor, expectRendererBackend, exportQueryFor, onlyInItsProject, RENDERER_VARIANTS } from './renderer-variants';

let be: E2EBackend | null = null;
test.afterEach(async () => {
  await be?.stop();
  be = null;
});

async function cmd(op: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const revision = Number((await be!.command({ op: 'queryProject', projectId: be!.projectId, args: {} })).revision);
  const res = await be!.command({ op, projectId: be!.projectId, expectedRevision: revision, requestId: `req-${randomBytes(16).toString('hex')}`, origin: { kind: 'mcp', clientId: 'e2e-camera-depth' }, args });
  expect(res['ok'], JSON.stringify(res)).toBe(true);
  return res;
}

async function create(name: string, position: number[], extra: Record<string, unknown> = {}, kind = 'group'): Promise<string> {
  return String((await cmd('createEntity', { sceneId: 'scene-main', parentId: null, kind, name, transform: { position }, ...extra }))['createdId']);
}

type Rgb = [number, number, number];
const isRed = ([r, g, b]: Rgb): boolean => r > 100 && r > g * 2.5 && r > b * 2.5;
const isBlue = ([r, g, b]: Rgb): boolean => b > 80 && b > r * 1.8 && b > g * 1.3;
const isGreen = ([r, g, b]: Rgb): boolean => g > 40 && g > r * 2 && g > b * 2;

/** The camera: 0.3 m over the near floor, looking at AIM; its vertical field of view. */
const EYE = [0, 0.3, 0] as const;
const AIM = [0, -0.75, -10] as const;
const FOV_Y = 50;
/** A decal box's height: its top face is the floor's (the box is centred half of it below). */
const FLAT = 0.002;
/** The near decals: centre x, size; all at z NEAR_Z on the near floor's top (y 0). */
const NEAR_Z = -2.2;
const NEAR_SIZE = 0.8;
const NEAR = { multiply: -1, red: 0, add: 1 } as const;
/** The far decal: centre and size on the far floor's top (y FAR_Y). */
const FAR_Y = -2.5;
const FAR = { x: 0, z: -80, w: 30, d: 40 } as const;

/** A world point on the picture (`w` × `h`) of the camera at EYE looking at AIM. */
function onScreen(p: readonly number[], w: number, h: number): { x: number; y: number } {
  const f = AIM.map((v, i) => v - EYE[i]!);
  const fl = Math.hypot(...f);
  const fw = f.map((v) => v / fl);
  // right = forward × up, up' = right × forward.
  const r = [-fw[2]!, 0, fw[0]!];
  const rl = Math.hypot(...r);
  const rw = r.map((v) => v / rl);
  const u = [rw[1]! * fw[2]! - rw[2]! * fw[1]!, rw[2]! * fw[0]! - rw[0]! * fw[2]!, rw[0]! * fw[1]! - rw[1]! * fw[0]!];
  const d = p.map((v, i) => v - EYE[i]!);
  const dot = (a: readonly number[], b: readonly number[]): number => a[0]! * b[0]! + a[1]! * b[1]! + a[2]! * b[2]!;
  const t = Math.tan((FOV_Y * Math.PI) / 360);
  const z = dot(d, fw);
  return { x: (0.5 + (dot(d, rw) / (z * t * (w / h))) * 0.5) * w, y: (0.5 - (dot(d, u) / (z * t)) * 0.5) * h };
}

/** The share of pixels passing `test` in the middle half (each way) of a flat rectangle on the floor. */
function coverage(img: Image, cx: number, y: number, cz: number, w: number, d: number, test: (c: Rgb) => boolean): number {
  const a = onScreen([cx - w / 4, y, cz + d / 4], img.width, img.height);
  const b = onScreen([cx + w / 4, y, cz - d / 4], img.width, img.height);
  let n = 0;
  let hit = 0;
  for (let py = Math.round(Math.min(a.y, b.y)); py <= Math.round(Math.max(a.y, b.y)); py++) {
    for (let px = Math.round(Math.min(a.x, b.x)); px <= Math.round(Math.max(a.x, b.x)); px++) {
      n += 1;
      if (test(img.pixel(px, py) as Rgb)) hit += 1;
    }
  }
  return n === 0 ? 0 : hit / n;
}

/** The mean colour around a floor point (a 7 × 7 pixel window). */
function meanAt(img: Image, p: readonly number[]): Rgb {
  const c = onScreen(p, img.width, img.height);
  const sum = [0, 0, 0];
  for (let dy = -3; dy <= 3; dy++) for (let dx = -3; dx <= 3; dx++) {
    const [r, g, b] = img.pixel(Math.round(c.x) + dx, Math.round(c.y) + dy);
    sum[0] += r;
    sum[1] += g;
    sum[2] += b;
  }
  return sum.map((v) => v / 49) as Rgb;
}

interface DecalReads {
  ok: boolean;
  red: number;
  blue: number;
  floor: Rgb;
  stain: Rgb;
  glow: Rgb;
  redColour: Rgb;
}

/** What the decals look like on a picture of the camera's view. */
function readDecals(img: Image): DecalReads {
  const red = coverage(img, NEAR.red, 0, NEAR_Z, NEAR_SIZE, NEAR_SIZE, isRed);
  const blue = coverage(img, FAR.x, FAR_Y, FAR.z, FAR.w, FAR.d, isBlue);
  // The floor between the near decals and the near floor's end.
  const floor = meanAt(img, [0, 0, NEAR_Z - NEAR_SIZE / 2 - 0.35]);
  const stain = meanAt(img, [NEAR.multiply, 0, NEAR_Z]);
  const glow = meanAt(img, [NEAR.add, 0, NEAR_Z]);
  const redColour = meanAt(img, [NEAR.red, 0, NEAR_Z]);
  const darker = stain[0] < floor[0] * 0.75 && stain[2] < floor[2] * 0.75 && stain[1] > stain[0] * 1.3;
  const brighter = glow[0] > floor[0] + 25 && glow[2] > floor[2] + 25 && Math.abs(glow[1] - floor[1]) < 25;
  return { ok: red >= 0.98 && blue >= 0.95 && darker && brighter, red, blue, floor, stain, glow, redColour };
}

const fmt = (r: DecalReads): string => `red ${(r.red * 100).toFixed(1)} %, blue ${(r.blue * 100).toFixed(1)} %, floor ${r.floor.map((v) => v.toFixed(0))}, stain ${r.stain.map((v) => v.toFixed(0))}, glow ${r.glow.map((v) => v.toFixed(0))}`;

/** Pixels of the vista's green (sampled every 2 px). */
function greenCount(img: Image): number {
  let n = 0;
  for (let y = 0; y < img.height; y += 2) for (let x = 0; x < img.width; x += 2) if (isGreen(img.pixel(x, y) as Rgb)) n += 1;
  return n;
}

async function judge(target: Locator | Page, where: string): Promise<DecalReads> {
  let reads: DecalReads | null = null;
  await expect.poll(async () => (reads = readDecals(decodePng(await target.screenshot()))).ok, { timeout: 45_000, intervals: [500], message: `the decals in ${where}` }).toBe(true).catch((e: unknown) => {
    console.log(`decals ${where} (failed): ${reads !== null ? fmt(reads) : '-'}`);
    throw e;
  });
  console.log(`decals ${where}: ${fmt(reads!)}`);
  return reads!;
}

for (const variant of RENDERER_VARIANTS) test(`a virtual camera's far plane and the depth buffer modes; mesh decals lie on their surfaces without z-fighting in every mode, blend, multiply and add (${variant})`, async ({ page }) => {
  onlyInItsProject(variant);
  test.setTimeout(240_000);
  be = await startBackend('camera-depth-e2e');
  // ---- The near scene: the floor and its three decals (the Scene view frames them on open).
  await create('Near floor', [0, -0.5, -1.75], { box: { size: [6, 1, 3.5], material: { color: '#a8a8a8' } } }, 'box');
  const red = await publishBytes(be, makePng(64, 64, () => [230, 30, 30, 255]), 'texture', 'decal-red');
  await cmd('setMaterial', { material: { materialId: 'mat-red', name: 'Red mark', shader: 'decal', params: {}, textures: { map: red } } });
  await cmd('setMaterial', { material: { materialId: 'mat-stain', name: 'Stain', shader: 'decal', params: { blend: 'multiply', color: '#40a040' }, textures: {} } });
  await cmd('setMaterial', { material: { materialId: 'mat-glow', name: 'Glow', shader: 'decal', params: { blend: 'add', color: '#a000a0' }, textures: {} } });
  await cmd('setMaterial', { material: { materialId: 'mat-blue', name: 'Blue mark', shader: 'decal', params: { color: '#2040e0' }, textures: {} } });
  const flat = async (x: number, y: number, z: number, w: number, d: number, material: string, name: string): Promise<void> => {
    const id = await create(name, [x, y - FLAT / 2, z], { box: { size: [w, FLAT, d] } }, 'box');
    await cmd('setComponent', { entityId: id, component: 'materials', value: { '*': material } });
  };
  await flat(NEAR.red, 0, NEAR_Z, NEAR_SIZE, NEAR_SIZE, 'mat-red', 'Red decal');
  await flat(NEAR.multiply, 0, NEAR_Z, NEAR_SIZE, NEAR_SIZE, 'mat-stain', 'Stain decal');
  await flat(NEAR.add, 0, NEAR_Z, NEAR_SIZE, NEAR_SIZE, 'mat-glow', 'Glow decal');

  await page.goto(editorUrlFor(be.editorUrl, variant));
  await expect(page.locator('.tl-statusbar')).toContainText('connected');
  const view = page.locator('canvas.tl-viewport');
  await expectRendererBackend(view, variant);

  // ---- The Scene view: the red decal draws whole (its own texture there: the editor has no decal pages).
  let sceneRed: Rgb | null = null;
  await expect.poll(async () => {
    const img = decodePng(await view.screenshot());
    let n = 0;
    let x0 = img.width;
    let x1 = 0;
    let y0 = img.height;
    let y1 = 0;
    for (let y = 0; y < img.height; y += 2) for (let x = 0; x < img.width; x += 2) {
      if (!isRed(img.pixel(x, y) as Rgb)) continue;
      n += 1;
      x0 = Math.min(x0, x);
      x1 = Math.max(x1, x);
      y0 = Math.min(y0, y);
      y1 = Math.max(y1, y);
    }
    if (n < 200) return `only ${n} red pixels`;
    // The middle half of the red area is red throughout.
    let hit = 0;
    let all = 0;
    const sum = [0, 0, 0];
    for (let y = Math.round(y0 + (y1 - y0) / 4); y <= y1 - (y1 - y0) / 4; y++) for (let x = Math.round(x0 + (x1 - x0) / 4); x <= x1 - (x1 - x0) / 4; x++) {
      const c = img.pixel(x, y) as Rgb;
      all += 1;
      if (isRed(c)) hit += 1;
      sum[0] += c[0];
      sum[1] += c[1];
      sum[2] += c[2];
    }
    sceneRed = sum.map((v) => v / all) as Rgb;
    return hit / all >= 0.97 ? 'ok' : `red ${((hit / all) * 100).toFixed(1)} % of its middle`;
  }, { timeout: 30_000, intervals: [500], message: 'the red decal in the Scene view' }).toBe('ok');

  // ---- The far scene: a lower floor with the blue decal 80 m out, the vista 5 km out, the camera.
  await create('Far floor', [0, FAR_Y - 0.5, -90], { box: { size: [80, 1, 100], material: { color: '#a8a8a8' } } }, 'box');
  await flat(FAR.x, FAR_Y, FAR.z, FAR.w, FAR.d, 'mat-blue', 'Blue decal');
  await create('Vista', [0, 300, -5000], { box: { size: [3000, 600, 40], material: { color: '#20b030' } } }, 'box');
  const aim = await create('Aim', [...AIM]);
  const shot = await create('Shot', [...EYE]);
  await cmd('setComponent', { entityId: shot, component: 'virtualCamera', value: { rig: 'fixed', target: aim, near: 0.1, far: 20000, fovY: FOV_Y } });

  // ---- Play in every depth mode (1 standard, 3 reversed Z, 2 logarithmic: the setting's values).
  for (const [setting, mode] of [[1, 'standard'], [3, 'reversed'], [2, 'logarithmic']] as const) {
    await cmd('setSettings', { settings: { depth_buffer: setting } });
    await page.getByTitle('Start an isolated play preview').click();
    const frame = page.locator('iframe.tl-app__preview-frame');
    const canvas = frame.contentFrame().locator('canvas[data-tl-depth]');
    await expectRendererBackend(frame.contentFrame().locator('canvas').first(), variant);
    // Reversed Z falls back to standard where the backend lacks it (WebGL 2 without EXT_clip_control).
    await expect.poll(async () => canvas.getAttribute('data-tl-depth'), { timeout: 60_000 }).toMatch(mode === 'reversed' ? /^(reversed|standard)$/ : new RegExp(`^${mode}$`));
    const drawn = await canvas.getAttribute('data-tl-depth');
    const reads = await judge(frame, `${variant} Play, depth ${mode} (drawn ${drawn})`);
    // Scene view = Play: the red decal in the same red (seen from another angle: the hue, not the shade).
    const hue = (c: readonly number[]): number => c[0]! / (c[0]! + c[1]! + c[2]! + 1);
    expect(Math.abs(hue(reads.redColour) - hue(sceneRed!)), `Scene view red ${sceneRed!.map((v) => v.toFixed(0))}, Play ${reads.redColour.map((v) => v.toFixed(0))}`).toBeLessThan(0.08);
    if (mode === 'logarithmic') {
      await expect.poll(async () => greenCount(decodePng(await frame.screenshot())), { timeout: 30_000, message: 'the vista 5 km out (beyond the scene camera\'s 100 m far plane)' }).toBeGreaterThan(200);
      await frame.screenshot({ path: test.info().outputPath('camera-depth-play.png') });
    }
    await page.getByTitle('Stop the play preview').click();
    await expect(frame).toHaveCount(0);
  }

  // ---- The export (logarithmic depth), served with the backend stopped.
  const res = await be.admin(`projects/${be.projectId}/export`);
  expect(res.status, JSON.stringify(res.json)).toBe(200);
  const out = join(be.exportRoot, String(res.json['outputDir']));
  await page.goto('about:blank');
  await be.halt();
  const site = await serveDir(out);
  const game = await page.context().newPage();
  try {
    await game.goto(`${site.url}${exportQueryFor(variant)}`);
    const exported = game.locator('canvas').first();
    await expectRendererBackend(exported, variant);
    // The red is the decal page's: the export's decal material carries no texture of its own (decal-pages.test.ts).
    await judge(exported, `${variant} export`);
  } finally {
    await site.close();
  }
});
