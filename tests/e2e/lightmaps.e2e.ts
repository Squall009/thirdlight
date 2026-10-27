/**
 * Baked lighting in the editor and Play: a bake of the earlier bakers keeps
 * drawing, and "Bake lighting" saves the live lighting's probes and cache.
 *
 * A static cube on a static ground, the sun and the ambient light "baked".
 * A bake made by the earlier bakers (a lightmap atlas for the ground and the
 * cube, a probe tile), recorded as such a bake was: Play draws its lightmap
 * (the baked sun leaves per-pixel drawing, the dim lightmap holds the
 * light) and loads its probe tile; the Lighting window says it is stale and
 * asks for a bake again; Clear removes it. Once per renderer variant
 * (renderer-variants.ts).
 *
 * The probes' saved light ("Bake lighting", WebGPU) drawn on both renderers.
 */

import { expect, test, type Page } from './pw';
import * as THREE from 'three';

import { startBackend, type E2EBackend } from './backend';
import { decodePng, type Image } from './png';
import { backendOf, editorUrlFor, expectRendererBackend, onlyInItsProject, RENDERER_VARIANTS, type RendererVariant } from './renderer-variants';
import { encodePng16, packProbeTexels, savedSurfaceFromFiles } from '@thirdlight/three-adapter';
import { diff, show, STRICT, within } from './parity';
import { menu, openWindow, showView } from './ui';
import { centre, gameCameraAtView, settledShot } from './view-match';

let be: E2EBackend;
let seq = 0;
test.afterEach(async () => {
  await be?.stop();
});

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

/** Two pages' live light, each settled: STRICT's share of bad pixels, a little more mean difference. */
const LIVE = { ...STRICT, mean: 2.5 };

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

interface BakeRecord {
  atlases: string[];
  source: string;
  surface?: { files: string[]; probes: number };
}

async function bakeOf(): Promise<BakeRecord | undefined> {
  const config = await be.command({ op: 'queryGameConfig', projectId: be.projectId });
  return Object.values((config['lighting'] ?? {}) as Record<string, BakeRecord>)[0];
}

async function api(path: string): Promise<{ status: number; json: Record<string, unknown> }> {
  const r = await fetch(`${be.origin}/api/v1/projects/${be.projectId}/${path}`, { method: 'POST', headers: { authorization: `Bearer ${be.token}`, origin: be.origin, 'content-type': 'application/json' }, body: '{}' });
  const text = await r.text();
  return { status: r.status, json: text === '' ? {} : (JSON.parse(text) as Record<string, unknown>) };
}

/** Upload a file as a texture asset and publish it (the MCP path). */
async function publishTexture(bytes: Uint8Array, assetId: string): Promise<void> {
  const headers = { authorization: `Bearer ${be.token}`, origin: be.origin };
  const base = `${be.origin}/api/v1/projects/${be.projectId}/content/stages`;
  const stage = (await (await fetch(base, { method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: '{}' })).json()) as { stageId: string };
  const put = await fetch(`${base}/${stage.stageId}/bytes`, { method: 'PUT', headers: { ...headers, 'content-type': 'application/octet-stream', 'x-thirdlight-offset': '0', 'x-thirdlight-total': String(bytes.length) }, body: bytes as BodyInit });
  expect(put.status).toBe(200);
  const inspected = (await (await fetch(`${base}/${stage.stageId}/inspect`, { method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify({ kind: 'texture' }) })).json()) as { proposal?: Record<string, unknown> };
  const p = inspected.proposal!;
  expect(p['status'], JSON.stringify(inspected).slice(0, 300)).toBe('ok');
  await cmd('publishAsset', { mode: 'create', assetId, kind: 'texture', displayName: assetId, sourceDigest: p['sourceDigest'], sourceByteLength: p['sourceByteLength'], importRecipe: p['importRecipe'], metrics: p['metrics'], importedAt: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z') });
}

/**
 * A bake as the earlier bakers recorded it: one lightmap atlas (uniformly dim:
 * a tenth of its range) for the ground and the cube, the two baked lights it
 * holds, and one probe tile over the scene.
 */
async function recordOldBake(ground: string, cube: string): Promise<void> {
  const side = 64;
  await publishTexture(await encodePng16(side, side, new Uint16Array(side * side * 4).map((_, i) => (i % 4 === 3 ? 0xffff : 0x2000))), 'asset-old-lightmap');
  const res: [number, number, number] = [2, 2, 2];
  const sh = new Float32Array(8 * 27).map((_, i) => (i % 27 < 3 ? 0.3 : 0));
  const packed = packProbeTexels(sh, new Float32Array(8).fill(1));
  await publishTexture(await encodePng16(packed.width, packed.height, packed.samples), 'asset-old-probes');
  const createdAt = new Date().toISOString();
  const hash = '00000000000000aa';
  await cmd('setLighting', {
    sceneId: 'scene-main',
    lighting: {
      bakeId: 'bake-old', createdAt, source: 'browser', range: 4, texelsPerMeter: 16, samples: 64, bounces: 0,
      atlases: ['asset-old-lightmap'],
      entries: [{ entityId: ground, atlas: 0, scaleOffset: [1, 1, 0, 0] }, { entityId: cube, atlas: 0, scaleOffset: [1, 1, 0, 0] }],
      bakedLights: ['light-0001', 'light-0002'], lightsHash: hash, staticsHash: hash,
      probes: { createdAt, spacing: 2, bounces: 0, grids: [{ min: [-6, -0.5, -4], max: [6, 2.5, 4], resolution: res, asset: 'asset-old-probes' }], probes: 8, moved: 0, filled: 0, gpuBytes: 2 * 2 * 6 * 4 * 8, lightsHash: hash, staticsHash: hash },
    },
  });
}

for (const variant of RENDERER_VARIANTS) test(`a bake of the earlier bakers keeps drawing (its lightmap, its probe tile) and reads as stale until baked again (${variant})`, async ({ page }) => {
  onlyInItsProject(variant);
  test.setTimeout(240_000);
  be = await startBackend();
  const { ground, cube, play } = await openScene(page, variant);

  // Play before the bake: the baked lights are per pixel until a bake holds them.
  const before = await play(steadyLit());
  const beforeLit = brightnessAt(before, litSpot);
  await openWindow(page, 'Lighting');
  await expect(page.locator('[aria-label="lighting status"]')).toContainText('No saved lighting for this scene');

  await recordOldBake(ground, cube);
  await expect(page.locator('[aria-label="lighting status"]')).toContainText('2 objects in 1 lightmap, 8 probes) was made by the earlier bakers: stale');

  // Play draws it: the dim lightmap in place of the baked sun, and its probe tile loaded.
  const playing = page.waitForResponse((res) => res.request().method() === 'POST' && res.url().endsWith('/play'));
  await page.getByTitle('Start an isolated play preview').click();
  const psid = String(((await (await playing).json()) as { playSessionId: string }).playSessionId);
  const frame = page.locator('iframe.tl-app__preview-frame');
  await expectRendererBackend(page.frameLocator('iframe.tl-app__preview-frame').locator('canvas').first(), variant);
  let lit = 0;
  await expect.poll(async () => (lit = brightnessAt(decodePng(await frame.screenshot()), litSpot)), { timeout: 30_000, message: 'the old bake\'s lightmap in Play' }).toBeLessThan(beforeLit * 0.6);
  console.log(`[lightmaps] ${variant} old bake: lit ${beforeLit.toFixed(1)} before, ${lit.toFixed(1)} with its lightmap`);
  await expect
    .poll(async () => JSON.stringify(((await api(`play/${psid}/diagnostics`)).json['diagnostics'] as { renderer?: { probes?: unknown } } | undefined)?.renderer?.probes ?? null), { timeout: 30_000, message: 'the old bake\'s probe tile loaded in Play' })
    .toContain('"loaded":1');
  await page.getByTitle('Stop the play preview').click();

  // Clear removes it (one undo step).
  await page.getByRole('button', { name: 'Clear bake' }).click();
  await expect(page.locator('[aria-label="lighting status"]')).toContainText('No saved lighting for this scene');
  expect(await bakeOf()).toBeUndefined();
});

/**
 * Saved probe light, baked once ("Bake lighting", WebGPU) and drawn on both
 * renderers (the editor reloaded with `?renderer=webgl2` for the second: the
 * Scene view and Play draw the saved light there, live on WebGPU): a yard of
 * blocks with a closed room of blocks on it, an open canopy of blocks, a room
 * of generated architecture, and a moving (non-static) cube.
 *
 * - Inside the closed room no light is seen: its walls stay dark, also the
 *   one whose outside the sun lights (no light leaks through it), where the
 *   flat ambient light lit them before the bake.
 * - The generated room's probes are a grid of its own, inside its walls, and
 *   dark; the yard's are bricks over the blocks, lit.
 * - The cube in the open and under the canopy: its front face (never in
 *   sunlight) is about as bright in both places with the flat ambient light,
 *   and darker under the canopy with the probes (indirect light changes as it
 *   moves).
 * - The Scene view and Play draw the probe-lit scene alike.
 * - The probe debug view (Gizmos → Light probes) draws the probes.
 * - Ambient occlusion (the look's AO, SSAO by default) darkens the
 *   probe-lit foot of the room's shaded east wall, and leaves the sunlit
 *   north wall's foot as it was: it occludes only indirect light.
 */
test('saved probes light every object in place of the flat ambient light: no leak through a closed wall, a moving object, the Scene view as Play (both renderers)', async ({ page }) => {
  onlyInItsProject('auto', ['auto']);
  test.skip(backendOf('auto') !== 'webgpu', 'baking lighting needs WebGPU');
  test.setTimeout(300_000);
  be = await startBackend();
  await cmd('setBlockType', { block: { blockId: 'stone', name: 'Stone', variants: [{ color: '#b0b0b0' }], shape: 'full' } });
  // The yard: a block layer of 1 m cells, its ground's top at y = 0 over x −10…10, z −10…6; the canopy one cell 1…2 m up
  // over x −8…0, z −7…1, open on every side; the room inside x 3…7, z −5…−1, 3 m high, its walls and roof a cell thick.
  const yard = String((await cmd('createEntity', { sceneId: 'scene-main', parentId: null, kind: 'group', name: 'yard', transform: { position: [-10, -1, -10] } }))['createdId']);
  await cmd('setComponent', { entityId: yard, component: 'blockLayer', value: { cellSize: [1, 1, 1], bounds: { min: [0, 0, 0], max: [20, 6, 16] } } });
  const fill = (box: number[]) => ({ kind: 'fill', box, cell: { block: 'stone' } });
  await cmd('editBlocks', { entityId: yard, edits: [fill([0, 0, 0, 20, 1, 16]), fill([2, 2, 3, 10, 3, 11]), fill([12, 1, 4, 13, 4, 10]), fill([17, 1, 4, 18, 4, 10]), fill([13, 1, 4, 17, 4, 5]), fill([13, 1, 9, 17, 4, 10]), fill([12, 4, 4, 18, 5, 10])] });
  await cmd('updateEntity', { entityId: yard, static: true });
  const mover = String((await cmd('createEntity', { sceneId: 'scene-main', kind: 'box', name: 'mover', box: { size: [0.8, 0.8, 0.8], material: { color: '#b0b0b0' } }, transform: { position: [-4, 0.4, 3] } })).createdId);
  // A room of generated architecture north of the yard's middle (the engine's starter room: walls 0.2 m thick, 3 m high,
  // floor, ceiling, no opening): its probes a grid of its own, inside its walls.
  const archRoom = String((await cmd('createEntity', { sceneId: 'scene-main', kind: 'group', name: 'arch room', transform: { position: [0, 0, 0] } }))['createdId']);
  await cmd('setComponent', { entityId: archRoom, component: 'architecture', value: { elements: [], outlines: [{ id: 'closed', preset: 'starter-room', path: { points: [[-2, 0, -9.6], [2, 0, -9.6], [2, 0, -6.4], [-2, 0, -6.4]], closed: true } }] } });
  // The sun comes from the north (behind the room's north wall, never onto the cube's front face).
  await cmd('setComponent', { entityId: 'light-0001', component: 'light', value: { type: 'directional', color: '#ffffff', intensity: 2, direction: [0.3, -1, 0.6], castShadow: true, mode: 'mixed' } });
  await cmd('setComponent', { entityId: 'light-0002', component: 'light', value: { type: 'ambient', color: '#8090a8', intensity: 0.8, mode: 'mixed' } });
  await cmd('setEnvironment', { sceneId: 'scene-main', environment: { sky: { mode: 'color', color: '#a0b8e0' } } });

  // Inside the block room, looking north at its north wall's inside (its outside is sunlit): low and high, by the west
  // wall, in the middle; the floor by it.
  const insidePose = { position: [5, 1.4, -1.2], rotation: [0, 0, 0, 1] };
  const yardPose = { position: [-4, 0.7, 7], rotation: [0, 0, 0, 1] };
  const insideSpots: [number, number, number][] = [
    [5, 0.3, -5],
    [5, 1.3, -5],
    [3.3, 1.3, -5],
    [6.7, 0.4, -5],
    [5, 0.02, -4.6],
  ];
  const moverFront = (z: number): [number, number, number] => [-4, 0.4, z + 0.4];
  // Outside the room's north-east corner, looking at its sunlit north wall and its shaded east wall.
  const cornerPose = { position: [12, 1.6, -10], rotation: new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().lookAt(new THREE.Vector3(12, 1.6, -10), new THREE.Vector3(7, 0.4, -5), new THREE.Vector3(0, 1, 0))).toArray() };
  // The east wall's foot (wall and ground, in the wall's shadow: probe light only) and the north wall's (sunlit).
  const shadedFoot: [number, number, number][] = [
    [8.02, 0.08, -3.5],
    [8.1, 0.01, -3.5],
  ];
  const sunlitFoot: [number, number, number][] = [
    [6, 0.08, -6.02],
    [6, 0.01, -6.1],
  ];
  const look = { sky: { mode: 'color', color: '#a0b8e0' } };
  const frame = page.locator('iframe.tl-app__preview-frame');

  /** One Play from `pose`, settled; brightness at the spots (`settled`: its diagnostics once settled). */
  const playAt = async (variant: RendererVariant, pose: { position: number[]; rotation: number[] }, label: string, settled?: (d: Record<string, unknown>) => void): Promise<Image> => {
    await cmd('setTransform', { entityId: 'cam-main', transform: { position: pose.position, rotation: pose.rotation, scale: [1, 1, 1] } }, true);
    const playing = page.waitForResponse((res) => res.request().method() === 'POST' && res.url().endsWith('/play'));
    await page.getByTitle('Start an isolated play preview').click();
    const psid = String(((await (await playing).json()) as { playSessionId: string }).playSessionId);
    const canvas = page.frameLocator('iframe.tl-app__preview-frame').locator('canvas').first();
    await expectRendererBackend(canvas, variant);
    await expect(frame).toBeVisible();
    const img = await settledShot(frame, label);
    if (settled !== undefined) settled(((await api(`play/${psid}/diagnostics`)).json['diagnostics'] as { renderer?: Record<string, unknown> } | undefined)?.renderer ?? {});
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

  // Before the bake, on WebGL 2 (no live light): the flat ambient light.
  await page.goto(editorUrlFor(be.editorUrl, 'webgl2'));
  await expect(page.locator('.tl-statusbar')).toContainText('connected');
  const flat = interior(await playAt('webgl2', insidePose, 'flat-inside'));
  const flatMover = await moverRatio('webgl2', 'flat-mover');
  console.log(`[probe lighting] flat ambient: inside ${flat.map((v) => v.toFixed(1)).join(' ')}; mover open ${flatMover.open.toFixed(1)} covered ${flatMover.covered.toFixed(1)}`);

  await page.goto(editorUrlFor(be.editorUrl, 'auto'));
  await expect(page.locator('.tl-statusbar')).toContainText('connected');
  await expectRendererBackend(page.locator('canvas.tl-viewport'), 'auto');
  await openWindow(page, 'Lighting');
  const started = Date.now();
  await page.getByRole('button', { name: 'Bake lighting' }).click();
  await expect(page.locator('[aria-label="lighting status"]')).toContainText('Saved lighting from', { timeout: 180_000 });
  console.log(`[probe lighting] ${((Date.now() - started) / 1000).toFixed(1)} s — ${await page.getByRole('status').textContent()}`);
  // The saved probes, read back from the bake's files: the generated room's grid (inside its walls) sees only its dark
  // inside, where the yard's bricks are lit.
  const bake = (await bakeOf())!;
  const files: Uint8Array[] = [];
  for (const id of bake.surface!.files) {
    const r = await fetch(`${be.origin}/api/v1/projects/${be.projectId}/content/assets/${id}/versions/1/bytes`, { headers: { authorization: `Bearer ${be.token}`, origin: be.origin } });
    files.push(new Uint8Array(await r.arrayBuffer()));
  }
  const saved = await savedSurfaceFromFiles(files);
  if (!saved.ok) throw new Error(saved.message);
  const dc = (t: (typeof saved.saved.probes)[number]): number => {
    const [nx, ny, nz] = t.resolution;
    let m = 0;
    for (let iz = 0; iz < nz; iz++) for (let xy = 0; xy < nx * ny; xy++) m = Math.max(m, THREE.DataUtils.fromHalfFloat(t.data[((1 + iz) * nx * ny + xy) * 4]!));
    return m;
  };
  const rooms = saved.saved.probes.filter((t) => !t.brick && t.min[0] > -2 && t.max[0] < 2 && t.min[2] > -9.6 && t.max[2] < -6.4);
  const bricks = saved.saved.probes.filter((t) => t.brick);
  expect(rooms.length).toBeGreaterThan(0);
  expect(bricks.length).toBeGreaterThan(0);
  const roomDc = Math.max(...rooms.map(dc));
  const yardDc = Math.max(...bricks.map(dc));
  console.log(`[probe lighting] saved: ${saved.saved.tiles.length} cache tiles at level ${saved.saved.level}, ${saved.saved.probes.length} probe tiles (${rooms.length} the room's); the room's probes' SH DC (red × weight) max ${roomDc.toFixed(4)}, the yard bricks' ${yardDc.toFixed(3)}`);
  expect(yardDc).toBeGreaterThan(0.1);
  // Its walls, floor and ceiling hold the sun out (the ceiling collides with nothing, yet stops light).
  expect(roomDc).toBeLessThan(yardDc * 0.05);

  // The debug view: the probes drawn while on.
  const view = page.locator('canvas.tl-viewport');
  await showView(page, 'Scene');
  await menu(page, 'Gizmos', 'Light probes: off');
  await expect(view).toHaveAttribute('data-gizmos', /probes/);
  await expect.poll(async () => Number(((await view.getAttribute('data-probe-spheres')) ?? '0 0').split(' ')[0]), { timeout: 30_000 }).toBeGreaterThan(0);
  await menu(page, 'Gizmos', 'Light probes: on');
  await expect(view).toHaveAttribute('data-probe-spheres', '0 0');

  for (const variant of ['auto', 'webgl2'] as const) {
    if (variant === 'webgl2') {
      await page.goto(editorUrlFor(be.editorUrl, 'webgl2'));
      await expect(page.locator('.tl-statusbar')).toContainText('connected');
      await expectRendererBackend(view, 'webgl2');
    }
    // Live (WebGPU): the light starts from the bake, its tiles and probes seeded, not from nothing.
    const seeded = (d: Record<string, unknown>): void => {
      const c = d['surfaceCache'] as { seeded?: { tiles: number; probes: number }; light?: { live: boolean }; probes?: { lit: number; lastSettleMs: number | null } } | undefined;
      console.log(`[probe lighting] ${backendOf(variant)} Play started from the bake: ${JSON.stringify(c?.seeded)} (of ${c?.probes?.lit} probes lit; probes settled in ${c?.probes?.lastSettleMs} ms)`);
      if (c?.light?.live !== true) return;
      expect(c.seeded?.tiles ?? 0, 'cache tiles seeded from the bake').toBeGreaterThan(0);
      expect(c.seeded?.probes ?? 0, 'probes seeded from the bake').toBeGreaterThan(0);
    };
    const lit = interior(await playAt(variant, insidePose, `${variant}-inside`, seeded));
    const moved = await moverRatio(variant, `${variant}-mover`);
    console.log(`[probe lighting] ${backendOf(variant)}: inside ${lit.map((v) => v.toFixed(1)).join(' ')}; mover open ${moved.open.toFixed(1)} covered ${moved.covered.toFixed(1)}`);
    // No leak: every spot inside is dark, the ones by the sunlit wall included, where the flat light lit them (what is
    // left is the probes' bounce off the room's own dark walls).
    for (let i = 0; i < lit.length; i++) {
      expect(flat[i]!, `flat ambient light at spot ${i}`).toBeGreaterThan(25);
      expect(lit[i]!, `probe light at spot ${i}`).toBeLessThan(Math.max(8, flat[i]! * 0.6));
    }
    expect(lit.reduce((a, b) => a + b, 0) / lit.length).toBeLessThan((flat.reduce((a, b) => a + b, 0) / flat.length) * 0.4);
    // The moving cube: alike in both places with flat light, darker under the canopy with the probes.
    expect(Math.abs(flatMover.covered / flatMover.open - 1)).toBeLessThan(0.1);
    expect(moved.covered).toBeLessThan(moved.open * 0.75);

    // Ambient occlusion: the probe-lit foot darkens, the sunlit foot does not. (The default lens, which the spots are
    // projected with: the Scene view comparison of an earlier variant gave the camera the view's.)
    const camLens = ((await be.command({ op: 'queryEntity', projectId: be.projectId, args: { entityId: 'cam-main' } }))['entity'] as { components: { virtualCamera?: Record<string, unknown> } }).components.virtualCamera;
    if (camLens !== undefined) await cmd('setComponent', { entityId: 'cam-main', component: 'virtualCamera', value: { ...camLens, fovY: 60, near: 0.1, far: 100 } }, true);
    const noAo = await playAt(variant, cornerPose, `${variant}-corner-no-ao`);
    await cmd('setEnvironment', { sceneId: 'scene-main', environment: { ...look, post: { ssao: { enabled: true } } } });
    const withAo = await playAt(variant, cornerPose, `${variant}-corner-ao`);
    await cmd('setEnvironment', { sceneId: 'scene-main', environment: look });
    const ratio = (spots: [number, number, number][]): number[] => spots.map((w) => brightnessAt(withAo, w, cornerPose) / Math.max(1, brightnessAt(noAo, w, cornerPose)));
    const shaded = ratio(shadedFoot);
    const sunlit = ratio(sunlitFoot);
    console.log(`[probe lighting] ${backendOf(variant)} AO: shaded foot ${shadedFoot.map((w) => brightnessAt(noAo, w, cornerPose).toFixed(1)).join(' ')} × ${shaded.map((r) => r.toFixed(2)).join(' ')}; sunlit foot ${sunlitFoot.map((w) => brightnessAt(noAo, w, cornerPose).toFixed(1)).join(' ')} × ${sunlit.map((r) => r.toFixed(2)).join(' ')}`);
    // Both feet are the same crease: AO over the whole picture would darken them alike. On indirect light only, the
    // sunlit foot loses only its indirect share (the sun is most of its light).
    const drop = (r: number): number => 1 - r;
    expect(drop(shaded[1]!)).toBeGreaterThan(0.08);
    expect(drop(sunlit[1]!)).toBeLessThan(drop(shaded[1]!) * 0.5);
    expect(drop(sunlit[0]!)).toBeLessThan(drop(shaded[0]!));

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
    // Both draw through the same adapter: the saved light (WebGL 2), or the live light settled (WebGPU: two pages' probes
    // settle a little apart, their rays turned at random each update).
    const t = backendOf(variant) === 'webgpu' ? LIVE : STRICT;
    const d = diff(centre(scene, w, h), centre(play, w, h), t);
    console.log(`[probe lighting] ${backendOf(variant)} Scene view vs Play: ${show(d, t)}`);
    expect(within(d, t), show(d, t)).toBe(true);
  }
});
