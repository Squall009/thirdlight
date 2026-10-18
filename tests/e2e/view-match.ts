/**
 * Comparing the Scene view with Play: settled shots of a canvas, the game's
 * camera put where the Scene view's is (its pose, and a lens narrowed so
 * Play's picture is the middle of the Scene view's at the same scale), and
 * the middle of an image. Shared by the Scene view parity spec and the probe
 * lighting spec (lightmaps.e2e.ts). Also occlusion culling's proof: a pose
 * drawn with culling on and off is the same picture.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { expect, test, type Locator, type Page } from './pw';

import { diff, diffPng, show, STRICT, within, type Diff } from './parity';
import { decodePng, type Image } from './png';
import { expectRendererBackend, type RendererVariant } from './renderer-variants';
import { showView } from './ui';

type Command = (op: string, args: Record<string, unknown>) => Promise<Record<string, unknown>>;

/** A canvas's picture once two shots in a row (`intervalMs` apart) are the same (shaders built, shadow map drawn, textures in); saved as `label`.png. */
export async function settledShot(target: Locator, label: string, intervalMs = 1000): Promise<Image> {
  let last = '';
  await expect
    .poll(
      async () => {
        const png = (await target.screenshot()).toString('base64');
        const same = png === last;
        last = png;
        return same;
      },
      { timeout: 90_000, intervals: [intervalMs] },
    )
    .toBe(true);
  const out = test.info().outputPath();
  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, `${label}.png`), Buffer.from(last, 'base64'));
  return decodePng(Buffer.from(last, 'base64'));
}

/** The middle `w` × `h` of an image. */
export function centre(img: Image, w: number, h: number): Image {
  const x0 = Math.floor((img.width - w) / 2);
  const y0 = Math.floor((img.height - h) / 2);
  return { width: w, height: h, pixel: (x: number, y: number) => img.pixel(x + x0, y + y0) } as Image;
}

export interface ViewCamera {
  position: number[];
  rotation: number[];
  fovY: number;
  near: number;
  far: number;
}

/** The Scene view camera's pose and lens (`data-view-camera`). */
export async function viewCamera(page: Page): Promise<ViewCamera> {
  const raw = await page.locator('canvas.tl-viewport').getAttribute('data-view-camera');
  expect(raw).not.toBeNull();
  return JSON.parse(raw!) as ViewCamera;
}

/**
 * Put the game camera (`cam-main`, a fixed rig) where the Scene view's is.
 * The Game view is shorter than the Scene view (its play bar): the game's
 * lens is narrowed so its picture is the middle of the Scene view's at the
 * same scale (tan(fov/2) in proportion to the height). Starts and stops one
 * Play to measure the Game view; ends in the Scene view. Returns the pose.
 */
export async function gameCameraAtView(page: Page, command: Command, variant: RendererVariant, queryEntity: (id: string) => Promise<{ components: { virtualCamera?: Record<string, unknown> } }>): Promise<ViewCamera> {
  await page.getByTitle('Start an isolated play preview').click();
  const gameCanvas = page.frameLocator('iframe.tl-app__preview-frame').locator('canvas').first();
  await expectRendererBackend(gameCanvas, variant);
  const gameHeight = await gameCanvas.evaluate((c) => (c as HTMLCanvasElement).clientHeight);
  await page.getByTitle('Stop the play preview').click();
  await expect(page.getByTitle('Start an isolated play preview')).toBeVisible({ timeout: 30_000 });
  await showView(page, 'Scene');
  const sceneHeight = await page.locator('canvas.tl-viewport').evaluate((c) => (c as HTMLCanvasElement).clientHeight);
  const cam = await viewCamera(page);
  const gameFov = (2 * Math.atan(Math.tan((cam.fovY * Math.PI) / 360) * (gameHeight / sceneHeight)) * 180) / Math.PI;
  await command('setTransform', { entityId: 'cam-main', transform: { position: cam.position, rotation: cam.rotation, scale: [1, 1, 1] } });
  // Its lens is its virtual camera's (a fixed rig: the view stays where the entity is).
  const camEntity = await queryEntity('cam-main');
  await command('setComponent', { entityId: 'cam-main', component: 'virtualCamera', value: { ...(camEntity.components.virtualCamera ?? { rig: 'fixed' }), fovY: gameFov, near: cam.near, far: cam.far } });
  return cam;
}

/** A settled picture of a game page and its canvas's `data-tl-occlusion` mark (path|occludees|tested|culled|stand-ins drawn). */
export interface OcclusionShot {
  readonly image: Image;
  readonly occlusion: string | null;
}

/**
 * Occlusion culling leaves out only what no pixel shows: one pose drawn with
 * the setting's culling and with it off is the same picture under the strict
 * rule. The marks say which path each drew with; `label` names the saved diff.
 */
export function expectOcclusionShotsMatch(culled: OcclusionShot, off: OcclusionShot, label: string): Diff {
  expect(culled.occlusion, 'the page reports its occlusion culling').not.toBeNull();
  expect(culled.occlusion!.split('|')[0], 'culled on a path').not.toBe('off');
  expect(off.occlusion?.split('|')[0], 'culling is off').toBe('off');
  const d = diff(culled.image, off.image, STRICT);
  if (!within(d, STRICT)) {
    const out = test.info().outputPath();
    mkdirSync(out, { recursive: true });
    writeFileSync(join(out, `${label}-diff.png`), diffPng(culled.image, off.image));
  }
  console.log(`[occlusion] ${label}: ${culled.occlusion} against ${off.occlusion}: ${show(d, STRICT)}`);
  expect(within(d, STRICT), `${label}: culling on and off draw the same picture (${show(d, STRICT)})`).toBe(true);
  return d;
}

/**
 * In a page, before its scripts (`addInitScript`): keep the scenes three
 * makes (its devtools channel announces each), so a test reaches the game
 * scene's occlusion switch (`scene.userData.tlOcclusion`) in an export.
 */
export function keepThreeScenes(): void {
  const w = window as unknown as { __tlScenes?: object[]; __THREE_DEVTOOLS__?: EventTarget };
  if (w.__tlScenes !== undefined) return;
  const scenes: object[] = [];
  w.__tlScenes = scenes;
  const hub = w.__THREE_DEVTOOLS__ ?? new EventTarget();
  w.__THREE_DEVTOOLS__ = hub;
  hub.addEventListener('observe', (ev) => {
    const d = (ev as CustomEvent).detail as { isScene?: boolean } | null;
    if (d?.isScene === true) scenes.push(d);
  });
}

/** Call `method` of the page's occlusion switch (a page made with `keepThreeScenes`); typed arrays come back as arrays. */
export async function onOcclusionSwitch<T>(page: Page, method: 'pin' | 'path' | 'showPyramid' | 'readPyramid' | 'diagnostics', arg?: unknown): Promise<T> {
  return (await page.evaluate(
    async ([m, a]) => {
      const scenes = (window as unknown as { __tlScenes?: { userData?: Record<string, unknown> }[] }).__tlScenes ?? [];
      const sw = scenes.map((s) => s.userData?.['tlOcclusion'] as Record<string, (x?: unknown) => unknown> | undefined).find((x) => x !== undefined);
      if (sw === undefined) throw new Error('no scene with an occlusion switch');
      const r = (await sw[m as string]!(a)) as { data?: Float32Array } | null | undefined;
      return r !== null && r !== undefined && r.data instanceof Float32Array ? { ...r, data: Array.from(r.data) } : r;
    },
    [method, arg] as const,
  )) as T;
}

/** Turn the page's room culling (its portals) on or off (`scene.userData.tlRooms`, a page made with `keepThreeScenes`), as `?portals=off` does at load. */
export async function pinPortals(page: Page, on: boolean): Promise<void> {
  await page.evaluate((v) => {
    const scenes = (window as unknown as { __tlScenes?: { userData?: Record<string, unknown> }[] }).__tlScenes ?? [];
    const sw = scenes.map((s) => s.userData?.['tlRooms'] as { pinPortals(on: boolean): void } | undefined).find((x) => x !== undefined);
    if (sw === undefined) throw new Error('no scene with a rooms switch');
    sw.pinPortals(v);
  }, on);
}
