/**
 * Comparing the Scene view with Play: settled shots of a canvas, the game's
 * camera put where the Scene view's is (its pose, and a lens narrowed so
 * Play's picture is the middle of the Scene view's at the same scale), and
 * the middle of an image. Shared by the Scene view parity spec and the probe
 * lighting spec (lightmaps.e2e.ts).
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { expect, test, type Locator, type Page } from './pw';

import { decodePng, type Image } from './png';
import { expectRendererBackend, type RendererVariant } from './renderer-variants';
import { showView } from './ui';

type Command = (op: string, args: Record<string, unknown>) => Promise<Record<string, unknown>>;

/** A canvas's picture once two shots in a row are the same (shaders built, shadow map drawn, textures in); saved as `label`.png. */
export async function settledShot(target: Locator, label: string): Promise<Image> {
  let last = '';
  await expect
    .poll(
      async () => {
        const png = (await target.screenshot()).toString('base64');
        const same = png === last;
        last = png;
        return same;
      },
      { timeout: 90_000, intervals: [1000] },
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
