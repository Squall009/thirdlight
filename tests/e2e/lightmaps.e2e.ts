/**
 * Light baking. A static cube on a static ground, the sun set to
 * "baked" and casting no realtime shadow: before a bake Play shows no shadow;
 * after "Bake preview" (in this browser) or "Bake final" (Blender Cycles on
 * the bake host) in the Lighting window the cube's shadow is in the ground's
 * lightmap (the sun is then no longer realtime), and a lit spot keeps about
 * the brightness the realtime sun gave it.
 *
 * The preview bake runs once per renderer variant
 * (renderer-variants.ts): the browser baker and Play draw with WebGPURenderer
 * (auto and forced WebGL 2 in the default project, WebGPU in the webgpu
 * project), the lightmaps as node materials including the no-ambient copies
 * (the bake holds the ambient light).
 *
 * The same scene's probes ("Bake probes", WebGPU only): baked next to the
 * lightmaps, published as files and recorded in the scene's bake, read back
 * (the probe inside the cube is filled from its neighbours, an open one is
 * lit), loaded by Play; on WebGL 2 the window says the bake needs WebGPU.
 */
import { spawnSync } from 'node:child_process';

import { expect, test, type Page } from './pw';
import * as THREE from 'three';

import { startBackend, type E2EBackend } from './backend';
import { decodePng, type Image } from './png';
import { backendOf, editorUrlFor, expectRendererBackend, onlyInItsProject, RENDERER_VARIANTS, type RendererVariant } from './renderer-variants';
import { decodeProbeArtifact } from '@thirdlight/three-adapter';
import { diff, show, STRICT, within } from './parity';
import { menu, openWindow, showView } from './ui';
import { centre, gameCameraAtView, settledShot } from './view-match';

let be: E2EBackend;
let seq = 0;
test.afterEach(async () => {
  await be?.stop();
});

/** The final bake runs Blender here (THIRDLIGHT_BLENDER / blender on PATH), or on TL_BAKE_HOST with TL_BAKE_BLENDER. */
const bakeBlender = process.env['TL_BAKE_BLENDER'] ?? process.env['THIRDLIGHT_BLENDER'] ?? 'blender';
const bakeHost = process.env['TL_BAKE_HOST'] ?? 'local';
const haveBlender = bakeHost !== 'local' || spawnSync(bakeBlender, ['--version'], { encoding: 'utf8' }).status === 0;

async function cmd(op: string, args: Record<string, unknown>, sameIsFine = false): Promise<Record<string, unknown>> {
  const q = await be.command({ op: 'queryProject', projectId: be.projectId, args: {} });
  seq += 1;
  const res = await be.command({
    op,
    projectId: be.projectId,
    expectedRevision: q.revision,
    requestId: `req-${(0xb0a00 + seq).toString(16).padStart(32, '0')}`,
    origin: { kind: 'mcp', clientId: 'e2e-lightmaps' },
    args,
  });
  if (sameIsFine && (res as { error?: { code?: string } }).error?.code === 'no_change') return res;
  expect(res.ok, JSON.stringify(res)).toBe(true);
  return res;
}

/** The Play camera's pose in the lightmap scene. */
const PLAY_POSE = { position: [0, 3, 6], rotation: [-0.2588190451, 0, 0, 0.9659258263] };

/** Mean brightness of a small square around a world point, as the Play camera (at `pose`) sees it. */
function brightnessAt(img: Image, world: [number, number, number], pose: { position: number[]; rotation: number[] } = PLAY_POSE): number {
  const camera = new THREE.PerspectiveCamera(60, img.width / img.height, 0.1, 100);
  camera.position.set(pose.position[0]!, pose.position[1]!, pose.position[2]!);
  camera.quaternion.set(pose.rotation[0]!, pose.rotation[1]!, pose.rotation[2]!, pose.rotation[3]!);
  camera.updateMatrixWorld();
  const p = new THREE.Vector3(...world).project(camera);
  const cx = Math.round(((p.x + 1) / 2) * img.width);
  const cy = Math.round(((1 - p.y) / 2) * img.height);
  let sum = 0;
  let n = 0;
  for (let y = cy - 3; y <= cy + 3; y++) {
    for (let x = cx - 3; x <= cx + 3; x++) {
      const [r, g, b] = img.pixel(x, y);
      sum += (r + g + b) / 3;
      n += 1;
    }
  }
  return sum / n;
}

interface Scene {
  ground: string;
  cube: string;
  play: (shows: (img: Image) => boolean) => Promise<Image>;
}

const shadowSpot: [number, number, number] = [0.95, 0, -0.75];
const litSpot: [number, number, number] = [-0.95, 0, -0.75];

/** The cube's face toward the camera: the sun grazes it, so it is darker than the lit ground once the scene is drawn. */
const cubeFront: [number, number, number] = [0, 0.5, 0.5];

/**
 * Before a bake: the scene drawn (the ground lit, the cube's face darker than
 * it) and the same as the frame before (loaded and staying put). Whether the
 * shadow is absent is asserted on that frame, not waited for.
 */
function steadyLit(): (img: Image) => boolean {
  let last = -1;
  return (img) => {
    const lit = brightnessAt(img, litSpot);
    const steady = Math.abs(lit - last) < 1;
    last = lit;
    return lit > 60 && lit - brightnessAt(img, cubeFront) > 10 && steady;
  };
}

/** After a bake: the shadow and the lit ground's brightness the step asserts (the lightmaps load after the first frames). */
function bakedShadow(beforeLit: number, shadowShare: number, minRatio: number, maxRatio: number): (img: Image) => boolean {
  return (img) => {
    const lit = brightnessAt(img, litSpot);
    return brightnessAt(img, shadowSpot) < lit * shadowShare && lit / beforeLit > minRatio && lit / beforeLit < maxRatio;
  };
}

async function openScene(page: Page, variant: RendererVariant = 'auto'): Promise<Scene> {
  await page.goto(editorUrlFor(be.editorUrl, variant));
  await expect(page.locator('.tl-statusbar')).toContainText('connected');
  await expectRendererBackend(page.locator('canvas.tl-viewport'), variant);
  const ground = String((await cmd('createEntity', { sceneId: 'scene-main', kind: 'box', name: 'ground', box: { size: [12, 0.5, 8], material: { color: '#b0b0b0' } }, transform: { position: [0, -0.25, 0] } })).createdId);
  const cube = String((await cmd('createEntity', { sceneId: 'scene-main', kind: 'box', name: 'cube', box: { size: [1, 2, 1], material: { color: '#b0b0b0' } }, transform: { position: [0, 1, 0] } })).createdId);
  // The camera looks down on the ground at 30° (a side-view game camera sits higher than eye level).
  await cmd('setTransform', { entityId: 'cam-main', transform: { position: [0, 3, 6], rotation: [-0.2588190451, 0, 0, 0.9659258263] } });
  await cmd('updateEntity', { entityId: ground, static: true });
  await cmd('updateEntity', { entityId: cube, static: true });
  await cmd('setComponent', { entityId: 'light-0001', component: 'light', value: { type: 'directional', color: '#ffffff', intensity: 1.2, direction: [0.4, -1, -0.3], castShadow: false, mode: 'baked' } });
  await cmd('setComponent', { entityId: 'light-0002', component: 'light', value: { type: 'ambient', color: '#8090a8', intensity: 0.6, mode: 'baked' } });
  const frame = page.locator('iframe.tl-app__preview-frame');
  const play = async (shows: (img: Image) => boolean): Promise<Image> => {
    await page.getByTitle('Start an isolated play preview').click();
    await expect(frame).toBeVisible();
    await expectRendererBackend(page.frameLocator('iframe.tl-app__preview-frame').locator('canvas').first(), variant);
    const shot: { img?: Image } = {};
    await expect
      .poll(async () => {
        shot.img = decodePng(await frame.screenshot());
        return shows(shot.img);
      }, { timeout: 30_000, message: 'the Play frame the step waits for' })
      .toBe(true);
    await page.getByTitle('Stop the play preview').click();
    return shot.img!;
  };
  return { ground, cube, play };
}

interface ProbesRecord {
  grids: { min: number[]; max: number[]; resolution: [number, number, number]; asset: string }[];
  probes: number;
  moved: number;
  filled: number;
  gpuBytes: number;
}

async function bakeOf(): Promise<{ atlases: string[]; entries: { entityId: string }[]; bakedLights: string[]; source: string; bounces: number; probes?: ProbesRecord }> {
  const config = await be.command({ op: 'queryGameConfig', projectId: be.projectId });
  return Object.values((config['lighting'] ?? {}) as Record<string, { atlases: string[]; entries: { entityId: string }[]; bakedLights: string[]; source: string; bounces: number; probes?: ProbesRecord }>)[0]!;
}

async function api(path: string): Promise<{ status: number; json: Record<string, unknown> }> {
  const r = await fetch(`${be.origin}/api/v1/projects/${be.projectId}/${path}`, { method: 'POST', headers: { authorization: `Bearer ${be.token}`, origin: be.origin, 'content-type': 'application/json' }, body: '{}' });
  const text = await r.text();
  return { status: r.status, json: text === '' ? {} : (JSON.parse(text) as Record<string, unknown>) };
}

/**
 * Bake the scene's probes and read them back: the files decode to the grid
 * the record names, the probe inside the cube was filled from its neighbours,
 * an open probe sees light, and Play loads every tile. On WebGL 2 the button
 * is off and the window says why.
 */
async function bakeProbes(page: Page, variant: RendererVariant): Promise<void> {
  const status = page.locator('[aria-label="probe status"]');
  await expect(status).toContainText('No probes for this scene');
  const button = page.getByRole('button', { name: 'Bake probes' });
  if (backendOf(variant) !== 'webgpu') {
    await expect(button).toBeDisabled();
    await expect(page.locator('[aria-label="probe bake unavailable"]')).toContainText('needs WebGPU');
    return;
  }
  // Once without bounces, then with the default two: bounce light adds to an open probe's light.
  await page.getByRole('button', { name: /settings/ }).click();
  await expect(page.getByRole('spinbutton', { name: 'probe bounces' })).toHaveValue('2');
  const bakeWith = async (bounces: number, version: number) => {
    await page.getByRole('spinbutton', { name: 'probe bounces' }).fill(String(bounces));
    const before = (await bakeOf())?.probes?.createdAt ?? null;
    const started = Date.now();
    await button.click();
    await expect.poll(async () => (await bakeOf())?.probes?.createdAt ?? null, { timeout: 120_000, message: 'the probe bake recorded' }).not.toBe(before);
    await expect(status).toContainText('Probes from');
    const message = (await page.getByRole('status').textContent()) ?? '';
    expect(message).toContain('Baked');
    console.log(`[lightmaps] ${variant} probes, ${bounces} bounces: ${((Date.now() - started) / 1000).toFixed(1)} s — ${message}`);
    const bake = await bakeOf();
    // The lightmaps stay as they were.
    expect(bake.atlases).toHaveLength(1);
    const probes = bake.probes!;
    expect(probes.grids).toHaveLength(1);
    const grid = probes.grids[0]!;
    // A re-bake publishes a new version of the same file.
    const r = await fetch(`${be.origin}/api/v1/projects/${be.projectId}/content/assets/${grid.asset}/versions/${version}/bytes`, { headers: { authorization: `Bearer ${be.token}`, origin: be.origin } });
    expect(r.status).toBe(200);
    const decoded = decodeProbeArtifact(new Uint8Array(await r.arrayBuffer()), grid);
    if (!decoded.ok) throw new Error(decoded.message);
    return { probes, grid, decoded };
  };
  const direct = await bakeWith(0, 1);
  const { probes, grid, decoded } = await bakeWith(2, 2);
  // The static bounds (x ±6, z ±4, y −0.5…2 and a metre above): one tile, 2 m apart, 1 m layers near the ground.
  expect(grid.resolution).toEqual([7, 5, 5]);
  expect(probes.probes).toBe(175);
  expect(probes.filled + probes.moved).toBeGreaterThan(0);
  const [nx, ny] = grid.resolution;
  const at = (ix: number, iy: number, iz: number): number => ix + iy * nx + iz * nx * ny;
  const dc = (d: typeof decoded, ix: number, iy: number, iz: number): number => THREE.DataUtils.fromHalfFloat(d.atlas[(((1 + iz) * ny + iy) * nx + ix) * 4]!);
  // (0, 0.5, 0) is inside the cube: filled from its neighbours (0); (−4, 0.5, −2) is in the open (1) and lit.
  expect(decoded.validity[at(3, 1, 2)]).toBe(0);
  expect(decoded.validity[at(1, 1, 1)]).toBe(1);
  console.log(`[lightmaps] open probe's SH DC (red): direct ${dc(direct.decoded, 1, 1, 1).toFixed(3)}, with 2 bounces ${dc(decoded, 1, 1, 1).toFixed(3)}; under the cube's shadow side ${dc(decoded, 4, 1, 2).toFixed(3)}`);
  expect(dc(direct.decoded, 1, 1, 1)).toBeGreaterThan(0.1);
  expect(dc(decoded, 1, 1, 1)).toBeGreaterThan(dc(direct.decoded, 1, 1, 1) * 1.02);

  // Play loads the tiles.
  const playing = page.waitForResponse((res) => res.request().method() === 'POST' && res.url().endsWith('/play'));
  await page.getByTitle('Start an isolated play preview').click();
  const psid = String(((await (await playing).json()) as { playSessionId: string }).playSessionId);
  const loaded = async (): Promise<{ tiles: number; loaded: number; probes: number; gpuBytes: number } | null> => {
    const d = await api(`play/${psid}/diagnostics`);
    return ((d.json['diagnostics'] as { renderer?: { probes?: { tiles: number; loaded: number; probes: number; gpuBytes: number } } } | undefined)?.renderer?.probes ?? null);
  };
  // `error` names why a tile failed to load.
  await expect.poll(async () => JSON.stringify(await loaded()), { timeout: 30_000, message: 'the tiles Play loaded' }).toContain('"loaded":1');
  const inPlay = (await loaded())!;
  expect(inPlay.probes).toBe(probes.probes);
  expect(inPlay.gpuBytes).toBe(probes.gpuBytes);
  await page.getByTitle('Stop the play preview').click();
}

for (const variant of RENDERER_VARIANTS) test(`Bake preview puts the static cube's shadow into the ground's lightmap; Play shows it (${variant})`, async ({ page }) => {
  onlyInItsProject(variant);
  test.setTimeout(240_000);
  be = await startBackend();
  const { ground, cube, play } = await openScene(page, variant);

  // Play before the bake: baked lights are realtime until a bake holds them — no shadow.
  const before = await play(steadyLit());
  const beforeShadow = brightnessAt(before, shadowSpot);
  const beforeLit = brightnessAt(before, litSpot);
  expect(Math.abs(beforeShadow - beforeLit)).toBeLessThan(15);

  // Bake in the Lighting window.
  await openWindow(page, 'Lighting');
  await expect(page.locator('[aria-label="bake status"]')).toContainText('No bake for this scene');
  await page.getByRole('button', { name: 'Bake preview (browser)' }).click();
  await expect(page.locator('[aria-label="bake status"]')).toContainText('Preview (browser) bake', { timeout: 120_000 });
  await expect(page.getByRole('status')).toContainText('Baked 2 objects');
  const bake = await bakeOf();
  expect(bake.source).toBe('browser');
  expect(bake.entries.map((e) => e.entityId).sort()).toEqual([cube, ground].sort());
  expect(bake.bakedLights.sort()).toEqual(['light-0001', 'light-0002']);
  expect(bake.atlases).toHaveLength(1);

  // Play after the bake: the shadow is in the lightmap; the lit ground stays about as bright.
  const after = await play(bakedShadow(beforeLit, 0.75, 0.6, 1.5));
  const afterShadow = brightnessAt(after, shadowSpot);
  const afterLit = brightnessAt(after, litSpot);
  console.log(`[lightmaps] ${variant} preview: before lit ${beforeLit.toFixed(1)} shadow ${beforeShadow.toFixed(1)}; after lit ${afterLit.toFixed(1)} shadow ${afterShadow.toFixed(1)}`);
  expect(afterShadow).toBeLessThan(afterLit * 0.75);
  expect(afterLit / beforeLit).toBeGreaterThan(0.6);
  expect(afterLit / beforeLit).toBeLessThan(1.5);

  await bakeProbes(page, variant);

  // Moving a static object makes the bake stale (it is still used).
  await cmd('setTransform', { entityId: cube, transform: { position: [1, 1, 0] } });
  await expect(page.locator('[aria-label="bake status"]')).toContainText('stale');

  // Clear removes the bake (one undo step); the probes are cleared on their own.
  await page.getByRole('button', { name: 'Clear bake' }).click();
  await expect(page.locator('[aria-label="bake status"]')).toContainText('No bake for this scene');
  if (backendOf(variant) === 'webgpu') {
    await expect(page.locator('[aria-label="probe status"]')).toContainText('stale');
    await page.getByRole('button', { name: 'Clear probes' }).click();
  }
  await expect(page.locator('[aria-label="probe status"]')).toContainText('No probes for this scene');
  expect(await bakeOf()).toBeUndefined();
});

test('Bake final runs Blender Cycles on the bake host; its lightmap shows the shadow in Play', async ({ page }) => {
  test.skip(!haveBlender, 'no Blender for the final bake on this machine');
  test.skip(test.info().project.name === 'webgpu', 'the renderer variants are covered by the preview bake');
  test.setTimeout(900_000);
  be = await startBackend('e2e-0001', undefined, { THIRDLIGHT_BAKE_HOST: bakeHost, THIRDLIGHT_BAKE_BLENDER: bakeBlender, THIRDLIGHT_BAKE_TIMEOUT_MINUTES: '12' });
  const { ground, cube, play } = await openScene(page);
  const before = await play(steadyLit());
  const beforeLit = brightnessAt(before, litSpot);

  await openWindow(page, 'Lighting');
  await expect(page.getByRole('button', { name: 'Bake final (Blender)' })).toBeEnabled();
  await page.getByRole('button', { name: /settings/ }).click();
  // A small, quick bake (the real samples are the owner's choice).
  await page.getByRole('spinbutton', { name: 'bake finalSamples' }).fill(bakeHost === 'local' ? '32' : '256');
  await page.getByRole('spinbutton', { name: 'bake texelsPerMeter' }).fill('8');
  const started = Date.now();
  await page.getByRole('button', { name: 'Bake final (Blender)' }).click();
  await expect(page.locator('[aria-label="bake status"]')).toContainText('Final (Blender) bake', { timeout: 840_000 });
  console.log(`[lightmaps] final bake on ${bakeHost}: ${((Date.now() - started) / 1000).toFixed(1)} s (${await page.getByRole('status').textContent()})`);
  const bake = await bakeOf();
  expect(bake.source).toBe('blender');
  expect(bake.bounces).toBe(3);
  expect(bake.entries.map((e) => e.entityId).sort()).toEqual([cube, ground].sort());

  const after = await play(bakedShadow(beforeLit, 0.8, 0.7, 1.7));
  const afterShadow = brightnessAt(after, shadowSpot);
  const afterLit = brightnessAt(after, litSpot);
  console.log(`[lightmaps] final: before lit ${beforeLit.toFixed(1)}; after lit ${afterLit.toFixed(1)} shadow ${afterShadow.toFixed(1)}`);
  expect(afterShadow).toBeLessThan(afterLit * 0.8);
  // Bounce light adds a little on top of what the realtime sun + ambient gave.
  expect(afterLit / beforeLit).toBeGreaterThan(0.7);
  expect(afterLit / beforeLit).toBeLessThan(1.7);
});

/**
 * Probe lighting, baked once (WebGPU) and drawn on both renderers (the
 * editor reloaded with `?renderer=webgl2` for the second): a closed room
 * beside a sunlit yard, an open canopy, and a moving (non-static) cube.
 *
 * - Inside the closed room the probes see no light: its walls stay dark,
 *   also next to the wall whose outside the sun lights (no light leaks
 *   through it), where the flat ambient light lit them before the bake.
 * - The cube in the open and under the canopy: its front face (never in
 *   sunlight) is about as bright in both places with the flat ambient light,
 *   and darker under the canopy with the probes (indirect light changes as it
 *   moves).
 * - The Scene view and Play draw the probe-lit scene alike.
 * - The probe debug view (Gizmos → Light probes) draws a sphere per probe.
 */
test('probe grids light every object in place of the flat ambient light: no leak through a closed wall, a moving object, the Scene view as Play (both renderers)', async ({ page }) => {
  onlyInItsProject('auto', ['auto']);
  test.skip(backendOf('auto') !== 'webgpu', 'baking probes needs WebGPU');
  test.setTimeout(300_000);
  be = await startBackend();
  const box = async (name: string, size: number[], position: number[], staticOn = true): Promise<string> => {
    const id = String((await cmd('createEntity', { sceneId: 'scene-main', kind: 'box', name, box: { size, material: { color: '#b0b0b0' } }, transform: { position } })).createdId);
    if (staticOn) await cmd('updateEntity', { entityId: id, static: true });
    return id;
  };
  await box('ground', [20, 0.5, 16], [0, -0.25, -2]);
  // The room: inside x 3…7, z −5…−1, 2.6 m high; walls and roof 0.4 m thick.
  await box('room west', [0.4, 2.6, 4.8], [2.8, 1.3, -3]);
  await box('room east', [0.4, 2.6, 4.8], [7.2, 1.3, -3]);
  await box('room north', [4, 2.6, 0.4], [5, 1.3, -5.2]);
  await box('room south', [4, 2.6, 0.4], [5, 1.3, -0.8]);
  await box('room roof', [4.8, 0.4, 4.8], [5, 2.8, -3]);
  // The canopy: a roof 1.2 m up over x −8…0, z −7…1, open on every side.
  await box('canopy', [8, 0.2, 8], [-4, 1.3, -3]);
  const mover = await box('mover', [0.8, 0.8, 0.8], [-4, 0.4, 3], false);
  // The sun comes from the north (behind the room's north wall, never onto the cube's front face).
  await cmd('setComponent', { entityId: 'light-0001', component: 'light', value: { type: 'directional', color: '#ffffff', intensity: 2, direction: [0.3, -1, 0.6], castShadow: true, mode: 'mixed' } });
  await cmd('setComponent', { entityId: 'light-0002', component: 'light', value: { type: 'ambient', color: '#8090a8', intensity: 0.8, mode: 'mixed' } });
  await cmd('setEnvironment', { sceneId: 'scene-main', environment: { sky: { mode: 'color', color: '#a0b8e0' } } });

  const insidePose = { position: [5, 1.4, -1.4], rotation: [0, 0, 0, 1] };
  const yardPose = { position: [-4, 0.7, 7], rotation: [0, 0, 0, 1] };
  // On the north wall's inside (its outside is sunlit): low and high, next to the west wall, in the middle; the floor by it.
  const insideSpots: [number, number, number][] = [
    [5, 0.2, -5],
    [5, 1.3, -5],
    [3.3, 1.3, -5],
    [6.7, 0.3, -5],
    [5, 0.02, -4.7],
  ];
  const moverFront = (z: number): [number, number, number] => [-4, 0.4, z + 0.4];
  const frame = page.locator('iframe.tl-app__preview-frame');

  /** One Play from `pose`, settled; brightness at the spots. */
  const playAt = async (variant: RendererVariant, pose: { position: number[]; rotation: number[] }, label: string): Promise<Image> => {
    await cmd('setTransform', { entityId: 'cam-main', transform: { position: pose.position, rotation: pose.rotation, scale: [1, 1, 1] } }, true);
    await page.getByTitle('Start an isolated play preview').click();
    const canvas = page.frameLocator('iframe.tl-app__preview-frame').locator('canvas').first();
    await expectRendererBackend(canvas, variant);
    await expect(frame).toBeVisible();
    const img = await settledShot(frame, label);
    await page.getByTitle('Stop the play preview').click();
    await expect(page.getByTitle('Start an isolated play preview')).toBeVisible({ timeout: 30_000 });
    return img;
  };
  const interior = (img: Image): number[] => insideSpots.map((w) => brightnessAt(img, w, insidePose));
  const moverRatio = async (variant: RendererVariant, label: string): Promise<{ open: number; covered: number }> => {
    await cmd('setTransform', { entityId: mover, transform: { position: [-4, 0.4, 3] } }, true);
    const open = brightnessAt(await playAt(variant, yardPose, `${label}-open`), moverFront(3), yardPose);
    await cmd('setTransform', { entityId: mover, transform: { position: [-4, 0.4, -3] } }, true);
    const covered = brightnessAt(await playAt(variant, yardPose, `${label}-covered`), moverFront(-3), yardPose);
    return { open, covered };
  };

  await page.goto(editorUrlFor(be.editorUrl, 'auto'));
  await expect(page.locator('.tl-statusbar')).toContainText('connected');
  await expectRendererBackend(page.locator('canvas.tl-viewport'), 'auto');

  // Before the bake: the flat ambient light.
  const flat = interior(await playAt('auto', insidePose, 'flat-inside'));
  const flatMover = await moverRatio('auto', 'flat-mover');
  console.log(`[probe lighting] flat ambient: inside ${flat.map((v) => v.toFixed(1)).join(' ')}; mover open ${flatMover.open.toFixed(1)} covered ${flatMover.covered.toFixed(1)}`);

  await openWindow(page, 'Lighting');
  await page.getByRole('button', { name: 'Bake probes' }).click();
  await expect(page.locator('[aria-label="probe status"]')).toContainText('Probes from', { timeout: 120_000 });
  console.log(`[probe lighting] ${await page.getByRole('status').textContent()}`);
  const probes = (await bakeOf()).probes!;

  // The debug view: a sphere per probe while on.
  const view = page.locator('canvas.tl-viewport');
  await showView(page, 'Scene');
  await menu(page, 'Gizmos', 'Light probes: off');
  await expect(view).toHaveAttribute('data-gizmos', /probes/);
  await expect(view).toHaveAttribute('data-probe-spheres', `${probes.probes} ${probes.moved + probes.filled}`, { timeout: 30_000 });
  await settledShot(view, 'probe-debug');
  await menu(page, 'Gizmos', 'Light probes: on');
  await expect(view).toHaveAttribute('data-probe-spheres', '0 0');

  for (const variant of ['auto', 'webgl2'] as const) {
    if (variant === 'webgl2') {
      await page.goto(editorUrlFor(be.editorUrl, 'webgl2'));
      await expect(page.locator('.tl-statusbar')).toContainText('connected');
      await expectRendererBackend(view, 'webgl2');
    }
    const lit = interior(await playAt(variant, insidePose, `${variant}-inside`));
    const moved = await moverRatio(variant, `${variant}-mover`);
    console.log(`[probe lighting] ${backendOf(variant)}: inside ${lit.map((v) => v.toFixed(1)).join(' ')}; mover open ${moved.open.toFixed(1)} covered ${moved.covered.toFixed(1)}`);
    // No leak: every spot inside is dark, the ones by the sunlit wall included, where the flat light lit them.
    for (let i = 0; i < lit.length; i++) {
      expect(flat[i]!, `flat ambient light at spot ${i}`).toBeGreaterThan(25);
      expect(lit[i]!, `probe light at spot ${i}`).toBeLessThan(Math.max(8, flat[i]! * 0.15));
    }
    // The moving cube: alike in both places with flat light, darker under the canopy with the probes.
    expect(Math.abs(flatMover.covered / flatMover.open - 1)).toBeLessThan(0.1);
    expect(moved.covered).toBeLessThan(moved.open * 0.75);

    // The Scene view draws what Play draws (the default view of the yard, the room and the canopy).
    await menu(page, 'Gizmos', 'Icons: on');
    await menu(page, 'Gizmos', 'Light ranges: on');
    await menu(page, 'Gizmos', 'Gameplay paths and areas: on');
    await menu(page, 'Gizmos', 'Grid: on');
    await expect(view).toHaveAttribute('data-gizmos', '');
    await gameCameraAtView(page, (op, args) => cmd(op, args, true), variant, async (id) => (await be.command({ op: 'queryEntity', projectId: be.projectId, args: { entityId: id } }))['entity'] as never);
    const scene = await settledShot(view, `${variant}-scene-view`);
    await page.getByTitle('Start an isolated play preview').click();
    const game = page.frameLocator('iframe.tl-app__preview-frame').locator('canvas').first();
    await expectRendererBackend(game, variant);
    const play = await settledShot(game, `${variant}-play`);
    await page.getByTitle('Stop the play preview').click();
    await showView(page, 'Scene');
    const w = Math.min(scene.width, play.width);
    const h = Math.min(scene.height, play.height);
    const d = diff(centre(scene, w, h), centre(play, w, h), STRICT);
    console.log(`[probe lighting] ${backendOf(variant)} Scene view vs Play: ${show(d)}`);
    expect(within(d), show(d)).toBe(true);
  }
});
