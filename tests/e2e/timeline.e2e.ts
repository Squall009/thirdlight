/**
 * Timelines against a real backend, on a neutral 3D scene built
 * by commands on a blank project (a floor, a player capsule, a lamp box,
 * three virtual cameras — two fixed and a rail on a camera path —, two
 * imported WAV sounds, `play` and `skip` key actions).
 *
 * - Play (the simulation worker) and the static export (backend stopped): a
 *   press of P makes the director script play a neutral six-shot timeline
 *   (`ctx.timeline.play`, binding its `hero` slot to the player): black fading
 *   in, letterbox bars, the wide camera, an eased cut to the close camera at
 *   2 s, the rail at 4 s; the player is moved along; music starts. A press of
 *   K (the timeline's skip action) mid-way applies each track's end state: the
 *   camera kept at the last shot (track end "keep"), the player at the move's
 *   last key, the last music key's track (owner: script), the gate signal of
 *   8 s fired — the script reacted by hiding the lamp —, the fade gone and the
 *   held letterbox bars drawn (pixels). Read through tl_game_observe /
 *   `window.__thirdlightObserve`.
 * - Editor: the Timelines tab opens a timeline's centre tab; clicking the
 *   ruler scrubs and the Scene view draws the bound box where the timeline
 *   puts it (and the camera track's frustum); dragging a key is one command
 *   (one revision) and Edit → Undo puts it back.
 *
 * What it sounds like is owner look pending.
 */
import { createHash, randomBytes } from 'node:crypto';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { extname, join, normalize, resolve } from 'node:path';

import { expect, test, type Locator, type Page } from '@playwright/test';

import { startBackend, type E2EBackend } from './backend';
import { decodePng, type Image } from './png';
import { editorTab, menu, projectWindow, openWindow, previewPane } from './ui';

const REPO = resolve(import.meta.dirname, '..', '..');
let be: E2EBackend | null = null;
test.afterEach(async () => {
  await be?.stop();
  be = null;
});

async function query(op: string, args: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  return be!.command({ op, projectId: be!.projectId, args });
}

async function cmd(op: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const revision = Number((await query('queryProject')).revision);
  const res = await be!.command({ op, projectId: be!.projectId, expectedRevision: revision, requestId: `req-${randomBytes(16).toString('hex')}`, origin: { kind: 'mcp', clientId: 'e2e-timeline' }, args });
  expect(res['ok'], JSON.stringify(res)).toBe(true);
  return res;
}

async function api(path: string, body: unknown): Promise<{ status: number; json: Record<string, unknown> }> {
  const r = await fetch(`${be!.origin}/api/v1/projects/${be!.projectId}/${path}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${be!.token}`, 'content-type': 'application/json', origin: be!.origin },
    body: JSON.stringify(body),
  });
  return { status: r.status, json: (await r.json()) as Record<string, unknown> };
}

async function create(name: string, position: number[], extra: Record<string, unknown> = {}, kind = 'group'): Promise<string> {
  return String((await cmd('createEntity', { parentId: null, kind, name, transform: { position }, ...extra }))['createdId']);
}

/** Publish a behavior with entityRef properties and attach it to `entityId`. */
async function script(behaviorId: string, source: string, entityId: string, values: Record<string, string>): Promise<void> {
  const bytes = Buffer.from(`${JSON.stringify({ graphVersion: 1, entryPath: 'src/index.ts', requiredModules: ['@thirdlight/runtime'], ownedTransforms: [], files: [{ path: 'src/index.ts', text: source }] }, null, 2)}\n`);
  const stage = await api('content/stages', {});
  const stageId = String(stage.json.stageId);
  const put = await fetch(`${be!.origin}/api/v1/projects/${be!.projectId}/content/stages/${stageId}/bytes`, {
    method: 'PUT',
    headers: { authorization: `Bearer ${be!.token}`, origin: be!.origin, 'content-type': 'application/octet-stream', 'x-thirdlight-offset': '0', 'x-thirdlight-total': String(bytes.length) },
    body: bytes,
  });
  expect(put.status).toBe(200);
  const declaration = { properties: Object.keys(values).map((key) => ({ key, label: key, type: 'entityRef', default: null })) };
  await cmd('publishBehavior', { behaviorId, displayName: behaviorId, mode: 'declaration-create', declaration });
  await cmd('acknowledgeBehaviorTrust', { sourceDigest: createHash('sha256').update(bytes).digest('hex') });
  const published = await api('content/behaviors/source', { stageId, behaviorId, displayName: behaviorId, declaration, expectedRevision: Number((await query('queryProject')).revision), requestId: `req-${randomBytes(16).toString('hex')}` });
  expect(published.status, JSON.stringify(published.json)).toBe(200);
  await cmd('setBehaviorProperties', { entityId, behaviorId, values });
}

/** Import a WAV through the editor's Assets tab; returns its asset id. */
async function importWav(page: Page, file: string, name: string): Promise<string> {
  const before = ((await query('queryAssets', { limit: 50, offset: 0 }))['assets'] as unknown[]).length;
  await projectWindow(page);
  await page.locator('.tl-assets__file').first().setInputFiles(join(REPO, 'fixtures', 'm3', 'media', 'wav', file));
  const publish = page.getByRole('button', { name: 'publish' });
  await expect(publish).toBeEnabled({ timeout: 15_000 });
  await publish.click();
  const assets = async () => (await query('queryAssets', { limit: 50, offset: 0 }))['assets'] as { assetId: string; displayName: string }[];
  await expect.poll(async () => (await assets()).length, { timeout: 15_000 }).toBe(before + 1);
  return (await assets()).find((a) => a.displayName === name)!.assetId;
}

/** P plays the timeline (its hero slot bound to the player by the call); the gate signal hides the lamp. */
const DIRECTOR = [
  'export default {',
  '  instantiate() { return { h: 0, last: -1 }; },',
  '  step(state: any, ctx: any) {',
  "    if (ctx.phase !== 'intent' || state.last === ctx.stepIndex) return;",
  '    state.last = ctx.stepIndex;',
  '    const act = ctx.action.actions ?? {};',
  "    if (act['play']?.p === 'pressed') state.h = ctx.timeline.play('shots', { hero: ctx.properties.hero });",
  "    if (ctx.signals.on('gate')) ctx.game.setVisible(ctx.properties.lamp, false);",
  '  },',
  '};',
].join('\n');

interface Ids {
  player: string;
  lamp: string;
  wide: string;
  close: string;
  rail: string;
  calm: string;
  tense: string;
}

async function buildScene(page: Page): Promise<Ids> {
  const calm = await importWav(page, 'cue-max.wav', 'cue-max');
  const tense = await importWav(page, 'cue-goal.wav', 'cue-goal');
  await create('Floor', [0, -0.5, 0], { box: { size: [40, 1, 40], material: { color: '#8a8f98' } }, components: { collider: { shape: { type: 'box', hx: 20, hy: 0.5, hz: 20 } } } }, 'box');
  const player = await create('Player', [0, 0.91, 0]);
  await cmd('setComponent', { entityId: player, component: 'controller', value: {} });
  await cmd('setSettings', { settings: { physics_dimension: 3 } });
  const lamp = await create('Lamp', [-3, 0.5, -3], { box: { size: [1, 1, 1], material: { color: '#f2b544' } } }, 'box');
  const wide = await create('Wide shot', [0, 5, 12]);
  await cmd('setComponent', { entityId: wide, component: 'virtualCamera', value: { rig: 'fixed', enabled: false, target: player } });
  const close = await create('Close shot', [2, 2, 4]);
  await cmd('setComponent', { entityId: close, component: 'virtualCamera', value: { rig: 'fixed', enabled: false, target: player, fovY: 35 } });
  const track = await create('Rail track', [-6, 3, 8]);
  await cmd('setComponent', { entityId: track, component: 'cameraPath', value: { points: [[0, 0, 0], [12, 2, 0]], smooth: false } });
  const rail = await create('Rail shot', [0, 0, 0]);
  await cmd('setComponent', { entityId: rail, component: 'virtualCamera', value: { rig: 'rail', enabled: false, path: track, target: player } });
  await cmd('setInput', {
    input: {
      actions: [
        { name: 'play', type: 'button', map: 'gameplay', bindings: [{ kind: 'key', code: 'KeyP' }] },
        { name: 'skip', type: 'button', map: 'gameplay', bindings: [{ kind: 'key', code: 'KeyK' }] },
      ],
    },
  });
  // The six shots: the hero slot has no default (the play call binds it); the cameras have theirs.
  await cmd('setTimeline', {
    timeline: {
      timelineId: 'shots',
      name: 'Six shots',
      duration: 12,
      skipAction: 'skip',
      slots: [{ name: 'hero' }, { name: 'wide', entity: wide }, { name: 'close', entity: close }, { name: 'rail', entity: rail }],
      markers: [{ name: 'gate', time: 8 }],
      tracks: [
        { trackId: 'cams', type: 'camera', end: 'keep', keys: [{ time: 0, camera: 'wide' }, { time: 2, camera: 'close', blend: 'eased', blendTime: 0.5 }, { time: 4, camera: 'rail', progress: [0, 1] }, { time: 7, camera: 'close', blend: 'cut' }, { time: 10, camera: 'wide', blend: 'linear', blendTime: 0.5 }] },
        { trackId: 'move', type: 'transform', target: 'hero', keys: [{ time: 0, position: [0, 0.91, 0] }, { time: 6, position: [3, 0.91, -2], easing: 'easeInOut' }] },
        { trackId: 'music', type: 'audio', keys: [{ time: 0, kind: 'music', asset: calm, fade: 0.5 }, { time: 9, kind: 'music', asset: tense, fade: 1 }] },
        { trackId: 'gate', type: 'signal', keys: [{ time: 8, name: 'gate' }] },
        { trackId: 'fade', type: 'fade', keys: [{ time: 0, value: 1 }, { time: 1.5, value: 0 }, { time: 11, value: 0 }, { time: 12, value: 1 }] },
        { trackId: 'bars', type: 'letterbox', hold: true, keys: [{ time: 0, value: 0.1 }] },
      ],
    },
  });
  const director = await create('Director', [0, -3, 0]);
  await script('director', DIRECTOR, director, { hero: player, lamp });
  return { player, lamp, wide, close, rail, calm, tense };
}

interface Observation {
  state?: string;
  player?: { x: number; y: number; z: number };
  camera?: { live: string | null; blend: { style: string } | null };
  hidden?: string[];
  audio?: { music: { owner: string; assetId: string | null } };
  timeline?: { screen: { fade: string; opacity: number; letterbox: number }; playing: { timeline: string; time: number; state: string }[] };
  sound?: { unlocked?: boolean };
}

/** Share of near-black pixels in a horizontal band (fractions of the height). */
function dark(img: Image, from: number, to: number): number {
  let n = 0;
  let d = 0;
  for (let y = Math.floor(img.height * from); y < Math.floor(img.height * to); y += 2) {
    for (let x = 0; x < img.width; x += 4) {
      const [r, g, b] = img.pixel(x, y);
      n += 1;
      if (r < 16 && g < 16 && b < 16) d += 1;
    }
  }
  return n === 0 ? 0 : d / n;
}

async function press(page: Page, key: string): Promise<void> {
  await page.keyboard.down(key);
  await page.waitForTimeout(150);
  await page.keyboard.up(key);
}

/** The key-driven checks, against any observation reader (the Play relay or the export's own) and the page drawing the game. */
async function drive(page: Page, read: () => Promise<Observation | null>, ids: Ids, fadeOpacity: () => Promise<number>, view: Locator | Page): Promise<void> {
  await press(page, 'p');
  // Black at the start, fading in (the host's fade element over the view).
  const opacities: number[] = [];
  await expect
    .poll(async () => {
      const o = await fadeOpacity();
      opacities.push(o);
      return o;
    }, { timeout: 30_000, intervals: [30], message: 'the timeline fades in from black' })
    .toBeGreaterThan(0.5);
  await expect.poll(async () => (await read())?.camera?.live ?? null, { timeout: 30_000, message: 'the wide shot' }).toBe(ids.wide);
  const first = (await read())!;
  expect(first.timeline!.playing[0]).toMatchObject({ timeline: 'shots', state: 'playing' });
  expect(first.timeline!.screen.letterbox).toBeCloseTo(0.1, 9);
  // The eased cut to the close shot at 2 s, then the rail at 4 s.
  const blends: string[] = [];
  await expect
    .poll(async () => {
      const o = await read();
      if (o?.camera?.blend) blends.push(o.camera.blend.style);
      return o?.camera?.live ?? null;
    }, { timeout: 30_000, intervals: [50], message: 'the close shot' })
    .toBe(ids.close);
  try {
    await expect.poll(async () => (await read())?.camera?.live ?? null, { timeout: 60_000, message: 'the rail shot' }).toBe(ids.rail);
  } catch (e) {
    throw new Error(`${String(e)}\nobservation: ${JSON.stringify(await read())}`);
  }
  const mid = (await read())!;
  expect(mid.timeline!.playing[0]!.time).toBeLessThan(7.5);
  expect(mid.hidden ?? []).not.toContain(ids.lamp);
  expect(mid.audio?.music).toMatchObject({ owner: 'script', assetId: ids.calm });
  // Skip mid-way (before the gate at 8 s and the music change at 9 s).
  await press(page, 'k');
  try {
    await expect.poll(async () => (await read())?.timeline?.playing.length ?? -1, { timeout: 30_000, message: 'skipped' }).toBe(0);
  } catch (e) {
    throw new Error(`${String(e)}\nobservation: ${JSON.stringify(await read())}`);
  }
  await expect.poll(async () => (await read())?.hidden ?? [], { timeout: 30_000, message: 'the gate signal fired on skip: the lamp is hidden' }).toContain(ids.lamp);
  const end = (await read())!;
  expect(end.camera!.live, 'the last shot is kept').toBe(ids.wide);
  expect(end.player!.x).toBeCloseTo(3, 1);
  expect(end.player!.z).toBeCloseTo(-2, 1);
  expect(end.audio?.music).toMatchObject({ owner: 'script', assetId: ids.tense });
  expect(end.timeline!.screen.opacity).toBe(0);
  expect(end.timeline!.screen.letterbox, 'the held bars').toBeCloseTo(0.1, 9);
  await expect.poll(async () => fadeOpacity(), { timeout: 10_000 }).toBe(0);
  // The held letterbox bars in pixels: the top tenth of the view is black, the middle is not.
  await page.waitForTimeout(300);
  const img = decodePng(await view.screenshot());
  expect(dark(img, 0.01, 0.08), 'the top bar').toBeGreaterThan(0.9);
  expect(dark(img, 0.4, 0.6), 'the view between the bars').toBeLessThan(0.5);
}

function serveDir(dir: string): Promise<{ url: string; close: () => Promise<void> }> {
  const types: Record<string, string> = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json', '.wasm': 'application/wasm' };
  const server: Server = createServer((req, res) => {
    const rel = normalize(decodeURIComponent((req.url ?? '/').split('?')[0]!)).replace(/^\/+/, '') || 'index.html';
    const file = join(dir, rel);
    if (!file.startsWith(dir) || !existsSync(file) || !statSync(file).isFile()) {
      res.statusCode = 404;
      res.end();
      return;
    }
    res.setHeader('content-type', types[extname(file)] ?? 'application/octet-stream');
    createReadStream(file).pipe(res);
  });
  return new Promise((ok) => server.listen(0, '127.0.0.1', () => ok({ url: `http://127.0.0.1:${(server.address() as { port: number }).port}/`, close: () => new Promise((d) => server.close(() => d())) })));
}

test('a six-shot timeline in Play and the export: cameras, move, music, fade and letterbox; skip mid-way ends in the end state', async ({ page }) => {
  test.setTimeout(420_000);
  be = await startBackend('timeline-e2e');
  await page.goto(be.editorUrl);
  await expect(page.locator('.tl-statusbar')).toContainText('connected');
  const ids = await buildScene(page);

  const started = page.waitForResponse((r) => r.request().method() === 'POST' && r.url().endsWith('/play'));
  await page.getByTitle('Start an isolated play preview').click();
  const psid = String(((await (await started).json()) as { playSessionId: string }).playSessionId);
  const frame = page.locator('iframe.tl-app__preview-frame');
  const observe = async (): Promise<Observation | null> => {
    const r = await api(`play/${psid}/observe`, {});
    return r.status === 200 ? (r.json as unknown as Observation) : null;
  };
  await expect.poll(async () => (await observe())?.state ?? null, { timeout: 60_000 }).toBe('running');
  const box = (await frame.boundingBox())!;
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  const fadeIn = (loc: ReturnType<Page['frameLocator']>) => async (): Promise<number> => {
    const v = await loc.locator('[data-tl-fade]').first().getAttribute('data-tl-fade', { timeout: 200 }).catch(() => null);
    return v === null ? 0 : Number(v);
  };
  await drive(page, observe, ids, fadeIn(page.frameLocator('iframe.tl-app__preview-frame')), frame);
  await page.getByTitle('Stop the play preview').click();
  await expect(frame).toHaveCount(0, { timeout: 30_000 });

  // The static export with the backend stopped: the same timeline (the export's own observation).
  const res = await be.admin(`projects/${be.projectId}/export`);
  expect(res.status, JSON.stringify(res.json)).toBe(200);
  await be.halt();
  const site = await serveDir(join(be.exportRoot, String(res.json.outputDir)));
  const game = await page.context().newPage();
  const errors: string[] = [];
  game.on('pageerror', (e) => errors.push(e.message));
  try {
    await game.goto(site.url);
    const read = (): Promise<Observation | null> => game.evaluate(() => ((window as unknown as { __thirdlightObserve?: () => unknown }).__thirdlightObserve?.() ?? null) as Observation | null);
    await expect.poll(async () => (await read())?.state ?? null, { timeout: 60_000 }).toBe('running');
    await game.mouse.click(400, 300);
    const fade = async (): Promise<number> => game.evaluate(() => Number(document.querySelector('[data-tl-fade]')?.getAttribute('data-tl-fade') ?? 0));
    await drive(game, read, ids, fade, game);
    expect(errors).toEqual([]);
  } finally {
    await game.close();
    await site.close();
  }
});

test('editor: the timeline tab scrubs the Scene view; a key drag is one command and undoes', async ({ page }) => {
  test.skip(test.info().project.name === 'webgpu', 'renderer-independent UI (the default project covers it)');
  test.setTimeout(240_000);
  be = await startBackend('timeline-editor-e2e');
  const crate = await create('Crate', [0, 0.5, 0], { box: { size: [1, 1, 1], material: { color: '#88aacc' } } }, 'box');
  const shotCam = await create('Shot', [0, 3, 8]);
  await cmd('setComponent', { entityId: shotCam, component: 'virtualCamera', value: { rig: 'fixed', target: crate } });
  await cmd('setTimeline', {
    timeline: {
      timelineId: 'slide',
      name: 'Slide',
      duration: 4,
      slots: [{ name: 'crate', entity: crate }, { name: 'shot', entity: shotCam }],
      tracks: [
        { trackId: 'cam', type: 'camera', keys: [{ time: 0, camera: 'shot' }] },
        { trackId: 'move', type: 'transform', target: 'crate', keys: [{ time: 0, position: [0, 0.5, 0] }, { time: 2, position: [4, 0.5, 0] }] },
      ],
    },
  });
  const storedKeyTime = async (): Promise<number> => {
    const g = await query('queryGameConfig');
    const tl = ((g['timelines'] ?? (g['game'] as Record<string, unknown> | undefined)?.['timelines']) as { timelineId: string; tracks: { trackId: string; keys: { time: number }[] }[] }[]).find((t) => t.timelineId === 'slide')!;
    return tl.tracks.find((t) => t.trackId === 'move')!.keys[1]!.time;
  };
  expect(await storedKeyTime()).toBe(2);

  await page.goto(be.editorUrl);
  await expect(page.locator('.tl-statusbar')).toContainText('connected');
  await openWindow(page, 'Timelines');
  await page.getByRole('button', { name: 'Open Slide' }).click();
  await expect(editorTab(page, 'Timeline', /Slide/)).toBeVisible();
  const ruler = page.getByLabel('Timeline ruler');
  await expect(ruler).toBeVisible();
  // The timeline previews on its scene in the editor window's preview pane (the Scene view's canvas, lent).
  const canvas = previewPane(page).locator('canvas[data-timeline-preview]');
  await expect(canvas).toHaveCount(1);
  const preview = async (): Promise<{ time: number; transforms: Record<string, number[]>; camera: { id: string } | null } | null> => {
    const raw = await canvas.getAttribute('data-timeline-preview');
    return raw === null || raw === '' ? null : JSON.parse(raw);
  };
  // Scrub to 1 s (80 px per second at the default zoom): the crate is half way (x 2), the shot camera live.
  const r = (await ruler.boundingBox())!;
  await page.mouse.click(r.x + 80, r.y + r.height / 2);
  await expect.poll(async () => (await preview())?.time ?? -1).toBeCloseTo(1, 1);
  await expect.poll(async () => (await preview())?.transforms[crate]?.[0] ?? -1).toBeCloseTo(2, 1);
  expect((await preview())!.camera?.id).toBe(shotCam);
  // Scrub further by dragging along the ruler: 1.5 s → x 3.
  await page.mouse.move(r.x + 80, r.y + r.height / 2);
  await page.mouse.down();
  await page.mouse.move(r.x + 110, r.y + r.height / 2, { steps: 4 });
  await page.mouse.move(r.x + 120, r.y + r.height / 2, { steps: 2 });
  await page.mouse.up();
  await expect.poll(async () => (await preview())?.transforms[crate]?.[0] ?? -1).toBeCloseTo(3, 1);

  // Drag the 2 s key to 3 s: one setTimeline (one revision), stored time 3.
  const key = page.locator('.tl-timeline__key[data-track-id="move"][data-key-index="1"]');
  const kb = (await key.boundingBox())!;
  const rev0 = Number((await query('queryProject')).revision);
  await page.mouse.move(kb.x + kb.width / 2, kb.y + kb.height / 2);
  await page.mouse.down();
  for (let i = 1; i <= 8; i += 1) await page.mouse.move(kb.x + kb.width / 2 + i * 10, kb.y + kb.height / 2);
  await page.mouse.up();
  await expect.poll(storedKeyTime).toBeCloseTo(3, 2);
  expect(Number((await query('queryProject')).revision), 'one command for the whole drag').toBe(rev0 + 1);
  await expect(page.locator('.tl-timeline__key[data-track-id="move"][data-key-index="1"]')).toHaveAttribute('data-time', '3');

  // Edit → Undo: the key is back at 2 s.
  await menu(page, 'Edit', 'Undo');
  await expect.poll(storedKeyTime).toBe(2);
  await expect(page.locator('.tl-timeline__key[data-track-id="move"][data-key-index="1"]')).toHaveAttribute('data-time', '2');
});
